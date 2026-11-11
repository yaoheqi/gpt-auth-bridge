"""Exercise browser extraction against a local SDK fixture, without real accounts."""
import json
import os
from pathlib import Path
import sys
import threading
import time
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
        if self.path == '/favicon.ico':
            self.send_response(204)
            self.end_headers()
            return
        if self.path == '/slow-script':
            self.server.asset_released.wait(5)
            body = b'/* unrelated asset */'
        elif self.path == '/token':
            self.server.token_calls += 1
            number = self.server.token_calls
            if self.server.fail_secondary and number > 1:
                self.send_error(500, 'Unused registration token failed')
                return
            body = json.dumps({'p': 'fixture-proof', 'c': str(number), 'mismatch': self.server.mismatch}).encode()
        else:
            self.server.document_calls += 1
            status = self.server.statuses.pop(0) if self.server.statuses else 200
            if status >= 400:
                self.send_error(status, 'private-upstream-body')
                return
            if self.server.no_sdk:
                body = b'<html>fixture without SDK</html>'
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            body = b'''<!doctype html><script nonce="fixture-sdk">
              const installSDK = () => {
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
              };
            '''
            if self.server.sdk_delay_ms:
                body += b'setTimeout(installSDK, ' + str(self.server.sdk_delay_ms).encode() + b');'
            else:
                body += b'installSDK();'
            body += b'</script>'
        if self.server.block_asset and self.path.startswith('/api/accounts/authorize'):
            body += b'<script src="/slow-script"></script>'
        self.send_response(200)
        if self.server.strict_csp:
            self.send_header('Content-Security-Policy', "script-src 'nonce-fixture-sdk'; connect-src 'self'")
        self.send_header('Content-Type', 'text/html' if self.path != '/token' else 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


class SentinelRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler)
        self.server.token_calls = 0
        self.server.fail_secondary = False
        self.server.mismatch = ''
        self.server.statuses = []
        self.server.document_calls = 0
        self.server.no_sdk = False
        self.server.block_asset = False
        self.server.strict_csp = False
        self.server.sdk_delay_ms = 0
        self.server.asset_released = threading.Event()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.asset_released.set()
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
                                               deadline_seconds=options.pop('deadline_seconds', 15), **options)
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


    def worker_request(self, runtime, **options):
        return browser_worker.run_request(runtime, {
            'authBaseUrl': f'http://127.0.0.1:{self.server.server_port}',
            'deadlineSeconds': 10, 'deviceID': 'fixture-device', 'flow': 'password_verify', **options,
        }, threading.Event(), lambda *_: None)

    def test_sdk_ready_document_does_not_wait_for_unrelated_scripts(self):
        self.server.block_asset = True
        goto = Page.goto
        navigation_started = []

        def timed_navigation(page, *args, **kwargs):
            navigation_started.append(time.monotonic())
            return goto(page, *args, **kwargs)

        # Measure navigation rather than the host-dependent browser cold start.
        with patch.object(Page, 'goto', timed_navigation):
            result = self.extract(device_id='fixture-device', auth_flow='password_verify', include_so_token=False)
        self.assertEqual(json.loads(result['sentinel_token'])['id'], 'fixture-device')
        self.assertEqual(len(navigation_started), 1)
        self.assertLess(time.monotonic() - navigation_started[0], 4)
        self.assertFalse(self.server.asset_released.is_set())

    def test_login_sdk_ready_under_strict_csp(self):
        self.server.strict_csp = True
        result = self.extract(device_id='fixture-device', auth_flow='password_verify', include_so_token=False)
        token = json.loads(result['sentinel_token'])
        self.assertEqual(token['id'], 'fixture-device')
        self.assertEqual(token['flow'], 'password_verify')
        self.assertEqual(self.server.token_calls, 1)

    def test_delayed_login_sdk_ready_under_strict_csp(self):
        self.server.strict_csp = True
        self.server.sdk_delay_ms = 350
        result = self.extract(device_id='fixture-device', auth_flow='password_verify', include_so_token=False)
        token = json.loads(result['sentinel_token'])
        self.assertEqual(token['id'], 'fixture-device')
        self.assertEqual(token['flow'], 'password_verify')
        self.assertEqual(self.server.token_calls, 1)

    def test_delayed_sdk_wait_survives_document_redirect_under_strict_csp(self):
        self.server.strict_csp = True
        self.server.sdk_delay_ms = 350
        goto = Page.goto

        def redirect_after_commit(page, *args, **kwargs):
            response = goto(page, *args, **kwargs)
            page.evaluate("setTimeout(() => location.replace('/sdk-redirected'), 50)")
            return response

        with patch.object(Page, 'goto', redirect_after_commit):
            result = self.extract(device_id='fixture-device', auth_flow='password_verify', include_so_token=False)
        self.assertEqual(json.loads(result['sentinel_token'])['id'], 'fixture-device')
        self.assertEqual(self.server.document_calls, 2)
        self.assertEqual(self.server.token_calls, 1)

    def test_delayed_sdk_wait_can_be_cancelled_under_strict_csp(self):
        self.server.strict_csp = True
        self.server.sdk_delay_ms = 5000
        stopped = threading.Event()
        timers = []
        committed = []
        goto = Page.goto

        def cancel_after_commit(page, *args, **kwargs):
            response = goto(page, *args, **kwargs)
            committed.append(time.monotonic())
            timer = threading.Timer(0.1, stopped.set)
            timers.append(timer)
            timer.start()
            return response

        try:
            with patch.object(Page, 'goto', cancel_after_commit), self.assertRaises(InterruptedError):
                self.extract(device_id='fixture-device', auth_flow='password_verify',
                             include_so_token=False, stop_event=stopped)
            self.assertEqual(self.server.token_calls, 0)
            self.assertEqual(len(committed), 1)
            self.assertLess(time.monotonic() - committed[0], 3)
        finally:
            for timer in timers:
                timer.cancel()
                timer.join()

    def test_aborted_navigation_can_use_already_ready_document(self):
        goto = Page.goto
        calls = []
        def interrupted(page, *args, **kwargs):
            calls.append(1)
            goto(page, *args, **kwargs)
            raise PlaywrightError('Page.goto: net::ERR_ABORTED at private-url')
        with patch.object(Page, 'goto', interrupted):
            result = self.extract(device_id='fixture-device', auth_flow='password_verify', include_so_token=False)
        self.assertEqual(len(calls), 1)
        self.assertEqual(json.loads(result['sentinel_token'])['id'], 'fixture-device')
        self.assertEqual(self.server.token_calls, 1)

    def test_transient_http_error_recovers_with_same_browser_and_fresh_context(self):
        self.server.statuses = [503, 200]
        runtime = browser_worker.BrowserRuntime()
        goto = Page.goto
        contexts = []
        def track(page, *args, **kwargs):
            contexts.append(page.context)
            return goto(page, *args, **kwargs)
        try:
            with patch.object(Page, 'goto', track):
                self.worker_request(runtime)
            self.assertEqual(len(contexts), 2)
            self.assertIsNot(contexts[0], contexts[1])
            self.assertIs(contexts[0].browser, contexts[1].browser)
            self.assertEqual(runtime.browser.contexts, [])
            self.assertEqual(self.server.token_calls, 1)
        finally:
            runtime.close()

    def test_http_error_fails_promptly_with_safe_status_after_one_recovery(self):
        self.server.statuses = [503, 503]
        runtime = browser_worker.BrowserRuntime()
        try:
            # These short deadlines exercise navigation, not browser startup.
            runtime.ensure(lambda *_: None)
            started = time.monotonic()
            with self.assertRaises(Exception) as caught:
                self.worker_request(runtime, deadlineSeconds=5)
            payload = browser_worker.error_payload(caught.exception)
            self.assertEqual(payload['code'], 'BROWSER_NAVIGATION_FAILED')
            self.assertEqual(payload['reason'], 'HTTP_ERROR')
            self.assertEqual(payload['httpStatus'], 503)
            self.assertEqual(payload['attempt'], 2)
            self.assertEqual(self.server.document_calls, 2)
            self.assertLess(time.monotonic() - started, 4)
            self.assertEqual(self.server.token_calls, 0)
            self.assertNotIn('private', json.dumps(payload))
        finally:
            runtime.close()

    def test_forbidden_and_rate_limited_documents_are_not_retried(self):
        runtime = browser_worker.BrowserRuntime()
        try:
            runtime.ensure(lambda *_: None)
            for status in (403, 429):
                with self.subTest(status=status):
                    self.server.statuses = [status]
                    before = self.server.document_calls
                    with self.assertRaises(Exception) as caught:
                        self.worker_request(runtime, deadlineSeconds=3)
                    payload = browser_worker.error_payload(caught.exception)
                    self.assertEqual(payload['code'], 'BROWSER_NAVIGATION_FAILED')
                    self.assertEqual(payload['httpStatus'], status)
                    self.assertEqual(payload['attempt'], 1)
                    self.assertEqual(self.server.document_calls - before, 1)
        finally:
            runtime.close()

    def test_missing_sdk_has_its_own_short_wait_and_no_navigation_retry(self):
        self.server.no_sdk = True
        runtime = browser_worker.BrowserRuntime()
        try:
            runtime.ensure(lambda *_: None)
            started = time.monotonic()
            with patch.object(sentinel, 'SDK_READY_TIMEOUT_MS', 200, create=True):
                with self.assertRaises(Exception) as caught:
                    self.worker_request(runtime, deadlineSeconds=4)
            payload = browser_worker.error_payload(caught.exception)
            self.assertEqual(payload['code'], 'VALIDATION_TIMEOUT')
            self.assertEqual(payload['stage'], 'browser_navigation')
            self.assertEqual(payload['reason'], 'SDK_NOT_READY')
            self.assertEqual(self.server.document_calls, 1)
            self.assertLess(time.monotonic() - started, 3)
        finally:
            runtime.close()


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

    def test_transient_navigation_error_reuses_browser_once(self):
        errors = [PlaywrightError('net::ERR_CONNECTION_RESET at private-url'),
                  PlaywrightError('Page.goto: Navigation to private-url is interrupted by another navigation')]
        for error in errors:
            def fail_first(**kwargs):
                kwargs['on_timing']('browser_navigation', 1, 'error')
                raise error
            with self.subTest(error=error), patch.object(browser_worker, 'extract_sentinel', side_effect=fail_first) as extract:
                with self.assertRaises(PlaywrightError) as caught:
                    self.run_request()
                self.assertEqual(extract.call_count, 2)
                self.assertEqual(caught.exception.attempt, 2)
                self.assertEqual(self.runtime.close.call_count, 0)
                self.assertNotIn('private', json.dumps(browser_worker.error_payload(caught.exception)))

    def test_verification_errors_and_cleanup_failures_are_not_retried(self):
        for stage, cleanup in [('browser_verify', False), ('browser_navigation', True)]:
            error = PlaywrightError('net::ERR_CONNECTION_RESET')
            if cleanup:
                error.cleanup_code = 'BROWSER_CLEANUP_FAILED'
            def fail(**kwargs):
                kwargs['on_timing'](stage, 1, 'error')
                raise error
            with self.subTest(stage=stage), patch.object(browser_worker, 'extract_sentinel', side_effect=fail) as extract:
                with self.assertRaises(PlaywrightError):
                    self.run_request()
                self.assertEqual(extract.call_count, 1)

    def test_navigation_recovery_shares_deadline_and_browser_closure_attempt_limit(self):
        error = PlaywrightError('net::ERR_CONNECTION_RESET')
        def fail(**kwargs):
            kwargs['on_timing']('browser_navigation', 1, 'error')
            raise error
        with patch.object(browser_worker.time, 'monotonic', side_effect=[0, 0, 1, 4, 4, 5]), \
                patch.object(browser_worker, 'extract_sentinel', side_effect=fail) as extract:
            with self.assertRaises(PlaywrightError):
                self.run_request(deadlineSeconds=10)
        self.assertEqual([call.kwargs['deadline_seconds'] for call in extract.call_args_list], [9, 5])
        with patch.object(browser_worker, 'extract_sentinel', side_effect=[self.closed, error]) as extract:
            with self.assertRaises(PlaywrightError):
                self.run_request()
        self.assertEqual(extract.call_count, 2)

    def test_navigation_cancellation_and_exhausted_budget_do_not_retry(self):
        error = PlaywrightError('net::ERR_CONNECTION_RESET')
        def fail(**kwargs):
            kwargs['on_timing']('browser_navigation', 1, 'error')
            raise error
        with patch.object(browser_worker.time, 'monotonic', side_effect=[0, 0, 1, 10]), \
                patch.object(browser_worker, 'extract_sentinel', side_effect=fail) as extract:
            with self.assertRaises(PlaywrightError):
                self.run_request(deadlineSeconds=10)
        self.assertEqual(extract.call_count, 1)
        def cancel(**kwargs):
            self.stopped.set()
            fail(**kwargs)
        with patch.object(browser_worker, 'extract_sentinel', side_effect=cancel) as extract:
            with self.assertRaises(InterruptedError):
                self.run_request()
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
