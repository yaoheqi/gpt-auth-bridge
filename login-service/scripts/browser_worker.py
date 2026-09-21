"""One task at a time; optionally retain Chrome, never a task's browser context."""
import json
from pathlib import Path
import queue
import signal
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import sync_playwright
from sentinel import _find_chrome, extract_sentinel, _timed_stage


def emit(value):
    print(json.dumps(value, ensure_ascii=False, separators=(',', ':')), flush=True)


class BrowserRuntime:
    def __init__(self):
        self.playwright = None
        self.browser = None

    def ensure(self, on_timing):
        if self.browser and self.browser.is_connected():
            return self.browser
        self.close()
        with _timed_stage('browser_start', on_timing):
            self.playwright = sync_playwright().start()
            chrome = _find_chrome(self.playwright)
            if not chrome:
                raise RuntimeError('Chromium executable is unavailable')
            self.browser = self.playwright.chromium.launch(executable_path=chrome, headless=True,
                args=['--disable-blink-features=AutomationControlled', '--no-sandbox'])
        return self.browser

    def close(self):
        try:
            if self.browser:
                self.browser.close()
        finally:
            self.browser = None
            if self.playwright:
                self.playwright.stop()
                self.playwright = None


def main():
    incoming = queue.Queue(maxsize=1)
    stopped = threading.Event()

    def read():
        try:
            for line in sys.stdin:
                incoming.put(json.loads(line))
                line = None
        finally:
            stopped.set()
            incoming.put(None)

    threading.Thread(target=read, daemon=True).start()
    runtime = BrowserRuntime()
    # Trigger cleanup when Node terminates a POSIX process group.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    request = result = None
    try:
        while not stopped.is_set():
            request = incoming.get()
            if request is None:
                break
            identity = request['id']
            timing = lambda stage, duration, outcome: emit({'id': identity, 'event': 'timing',
                'stage': stage, 'durationMs': duration, 'outcome': outcome})
            try:
                browser = runtime.ensure(timing)
                result = extract_sentinel(browser=browser, on_timing=timing, stop_event=stopped,
                    deadline_seconds=request.get('deadlineSeconds', 75), include_so_token=False,
                    proxy_url=request.get('proxyUrl', ''), user_agent=request.get('userAgent', ''),
                    auth_base_url=request.get('authBaseUrl', 'https://auth.openai.com'))
                if not result:
                    raise InterruptedError('Browser task cancelled')
                # No cookies/storage state leave this helper; each task has already closed its context.
                emit({'id': identity, 'ok': True, 'result': {
                    'sentinel_token': result['sentinel_token'], 'oai_did': result['oai_did']}})
            except Exception as error:
                try:
                    runtime.close()
                finally:
                    emit({'id': identity, 'ok': False, 'error': type(error).__name__ + ': ' + str(error)[:2000]})
            finally:
                request = result = None
    finally:
        runtime.close()


if __name__ == '__main__':
    main()
