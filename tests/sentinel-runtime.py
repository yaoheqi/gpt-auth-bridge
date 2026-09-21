"""Exercise browser extraction against a local SDK fixture, without real accounts."""
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'login-service'))
import sentinel


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
            body = json.dumps({'p': 'fixture-proof', 'c': str(number)}).encode()
        else:
            body = b'''<!doctype html><script>
              window.SentinelSDK = {init() {}, async token() {
                const response = await fetch('/token');
                if (!response.ok) throw new Error('Unused registration token failed');
                return response.text();
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


if __name__ == '__main__':
    unittest.main()
