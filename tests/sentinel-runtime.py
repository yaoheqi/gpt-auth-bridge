"""Exercise browser extraction against a local SDK fixture, without real accounts."""
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'login-service'))
import sentinel
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'login-service' / 'scripts'))
import browser_worker
from playwright.sync_api import Error as PlaywrightError, Page


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path == '/token':
            self.server.token_calls += 1
            number = self.server.token_calls
            if self.server.fail_secondary and number > 1:
                self.send_error(500, 'Unused registration token failed')
                return
            body = json.dumps({'p': 'fixture-proof', 'c': str(number), 'mismatch': self.server.mismatch}).encode()
        else:
            body = b'''<!doctype html><script>
              window.SentinelSDK = {init() {}, async token(flow) {
                const response = await fetch('/token');
                if (!response.ok) throw new Error('Unused registration token failed');
                const payload = await response.json();
                if (flow) {
                  payload.id = document.cookie.match(/oai-did=([^;]+)/)?.[1];
                  payload.flow = flow;
                  if (payload.mismatch) payload[payload.mismatch] = 'wrong';
                }
                return JSON.stringify(payload);
              }};
            </script>'''
        self.send_response(200)
        self.send_header('Content-Type', 'text/html' if self.path != '/token' else 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class SentinelRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler)
        self.server.token_calls = 0
        self.server.fail_secondary = False
        self.server.mismatch = ''
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def extract(self, **options):
        # Test automatic discovery too: no process-local cache or pinned executable.
        sentinel._CHROME_CACHE = None
        with patch.dict(os.environ, {'APP_PROXY': '', 'OPENAI_PROXY_URL': '',
                                    'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH': '', 'CHROME_PATH': ''}), \
                patch.object(sentinel, 'FIXED_LOCAL_PROXY_URL', ''), \
                patch.object(sentinel, 'sync_playwright', wraps=sentinel.sync_playwright) as start:
            result = sentinel.extract_sentinel(auth_base_url=f'http://127.0.0.1:{self.server.server_port}',
                                               deadline_seconds=15, **options)
            self.assertEqual(start.call_count, 1, 'discovery must share the extraction driver')
            return result

    def test_login_returns_primary_token_without_requesting_failing_secondary(self):
        self.server.fail_secondary = True
        result = self.extract(include_so_token=False)
        self.assertEqual(self.server.token_calls, 1)
        self.assertEqual(json.loads(result['sentinel_token'])['c'], '1')
        self.assertNotIn('sentinel_so_token', result)

    def test_legacy_caller_can_still_explicitly_request_both_tokens(self):
        result = self.extract(include_so_token=True)
        self.assertEqual(self.server.token_calls, 2)
        self.assertEqual(json.loads(result['sentinel_token'])['c'], '1')
        self.assertEqual(json.loads(result['sentinel_so_token'])['c'], '2')

    def test_worker_restarts_chrome_when_browser_closes_during_navigation(self):
        runtime = browser_worker.BrowserRuntime()
        goto = Page.goto
        attempts = []
        stages = []
        events = []

        def interrupt_first_navigation(page, *args, **kwargs):
            attempts.append(page.context.browser)
            if len(attempts) == 1:
                page.context.browser.close()
            return goto(page, *args, **kwargs)

        try:
            with patch.object(Page, 'goto', interrupt_first_navigation):
                result = browser_worker.run_request(runtime, {
                    'authBaseUrl': f'http://127.0.0.1:{self.server.server_port}',
                    'deadlineSeconds': 20,
                }, threading.Event(), lambda *event: stages.append(event),
                    lambda event, **fields: events.append({'event': event, **fields}))
            self.assertEqual(len(attempts), 2)
            self.assertIsNot(attempts[0], attempts[1])
            self.assertEqual(self.server.token_calls, 1)
            self.assertEqual(json.loads(result['sentinel_token'])['c'], '1')
            self.assertTrue(any(stage == 'browser_navigation' and outcome == 'error'
                                for stage, _, outcome in stages))
            self.assertEqual(sum(item['event'] == 'browser_started' for item in events), 2)
            self.assertEqual(sum(item['event'] == 'recovery_started' for item in events), 1)
            self.assertEqual(sum(item['event'] == 'recovery_succeeded' for item in events), 1)
            self.assertEqual(sum(item['event'] == 'browser_disconnected' and not item['expected']
                                 for item in events), 1)
        finally:
            runtime.close()

    def test_login_context_reaches_sdk_without_registration_relabeling(self):
        for flow in ('authorize_continue', 'password_verify'):
            result = self.extract(device_id='login-device', auth_flow=flow, include_so_token=False)
            token = json.loads(result['sentinel_token'])
            self.assertEqual(token['id'], 'login-device')
            self.assertEqual(token['flow'], flow)
            self.assertEqual(result['oai_did'], 'login-device')

    def test_mismatched_sdk_context_is_rejected(self):
        for field in ('id', 'flow'):
            self.server.mismatch = field
            with self.assertRaises(sentinel.SentinelContextMismatch):
                self.extract(device_id='login-device', auth_flow='authorize_continue', include_so_token=False)


class WorkerRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.runtime = Mock()
        self.runtime.browser.is_connected.return_value = False
        self.stopped = threading.Event()
        self.closed = PlaywrightError('Page.goto: Target page, context or browser has been closed')

    def run_request(self, **options):
        return browser_worker.run_request(self.runtime, options, self.stopped, Mock())

    def test_repeated_browser_closure_stops_after_one_retry(self):
        with patch.object(browser_worker, 'extract_sentinel', side_effect=self.closed) as extract:
            with self.assertRaisesRegex(browser_worker.BrowserUnavailableError, 'attempt=2/2'):
                self.run_request()
        self.assertEqual(extract.call_count, 2)
        self.assertEqual(self.runtime.close.call_count, 2)

    def test_other_errors_are_not_retried(self):
        for error in [PlaywrightError('net::ERR_PROXY_CONNECTION_FAILED'), TimeoutError('SDK timeout')]:
            with self.subTest(error=error), patch.object(browser_worker, 'extract_sentinel', side_effect=error) as extract:
                with self.assertRaises(type(error)):
                    self.run_request()
                self.assertEqual(extract.call_count, 1)

    def test_cancellation_during_closure_is_not_retried(self):
        def cancel(**_kwargs):
            self.stopped.set()
            raise self.closed
        with patch.object(browser_worker, 'extract_sentinel', side_effect=cancel) as extract:
            with self.assertRaises(InterruptedError):
                self.run_request()
        self.assertEqual(extract.call_count, 1)

    def test_recovery_uses_remaining_deadline(self):
        with patch.object(browser_worker.time, 'monotonic', side_effect=[0, 0, 1, 4, 4, 5]), \
                patch.object(browser_worker, 'extract_sentinel', side_effect=[self.closed, {'sentinel_token': 'ok'}]) as extract:
            self.run_request(deadlineSeconds=10)
        self.assertEqual([call.kwargs['deadline_seconds'] for call in extract.call_args_list], [9, 5])

    def test_expired_deadline_does_not_restart_browser(self):
        with patch.object(browser_worker.time, 'monotonic', side_effect=[0, 0, 1, 10]), \
                patch.object(browser_worker, 'extract_sentinel', side_effect=self.closed) as extract:
            with self.assertRaises(browser_worker.BrowserUnavailableError):
                self.run_request(deadlineSeconds=10)
        self.assertEqual(extract.call_count, 1)

    def test_public_failure_never_contains_raw_exception_data(self):
        error = self.closed
        error.stage, error.attempt = 'browser_navigation', 2
        self.assertEqual(browser_worker.error_payload(error), {
            'code': 'BROWSER_CLOSED', 'stage': 'browser_navigation', 'attempt': 2, 'retryable': False})
        error = sentinel.SentinelContextMismatch('private-cookie-and-token')
        self.assertNotIn('private', json.dumps(browser_worker.error_payload(error)))


if __name__ == '__main__':
    unittest.main()
