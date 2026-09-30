"""One task at a time; optionally retain Chrome, never a task's browser context."""
import json
from pathlib import Path
import queue
import signal
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
from sentinel import _find_chrome, extract_sentinel, _timed_stage, is_browser_closed_error, SentinelContextMismatch


def emit(value):
    print(json.dumps(value, ensure_ascii=False, separators=(',', ':')), flush=True)


class BrowserRuntime:
    def __init__(self):
        self.playwright = None
        self.browser = None
        self.closing = False
        self.on_event = lambda *_args, **_kwargs: None

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
            self.browser.on('disconnected', lambda *_: self.on_event('browser_disconnected', expected=self.closing))
            self.on_event('browser_started')
        return self.browser

    def close(self):
        browser, playwright = self.browser, self.playwright
        self.browser = self.playwright = None
        self.closing = True
        try:
            if browser:
                browser.close()
        finally:
            try:
                if playwright:
                    playwright.stop()
            finally:
                self.closing = False


class BrowserUnavailableError(RuntimeError):
    pass


def error_payload(error):
    stage = getattr(error, 'stage', 'browser_start')
    if isinstance(error, InterruptedError):
        code = 'VALIDATION_CANCELLED'
    elif isinstance(error, SentinelContextMismatch):
        code = 'VALIDATION_CONTEXT_MISMATCH'
    elif isinstance(error, (TimeoutError, PlaywrightTimeoutError)) or 'Sentinel token timeout' in str(error):
        code = 'VALIDATION_TIMEOUT'
    elif isinstance(error, BrowserUnavailableError) or is_browser_closed_error(error):
        code = 'BROWSER_CLOSED'
    elif any(marker in str(error) for marker in ('ERR_PROXY', 'ERR_TUNNEL', 'ERR_SOCKS')):
        code = 'BROWSER_PROXY_FAILED'
    elif stage == 'browser_start':
        code = 'BROWSER_UNAVAILABLE'
    elif stage == 'browser_navigation':
        code = 'BROWSER_NAVIGATION_FAILED'
    elif stage == 'browser_cleanup':
        code = 'BROWSER_CLEANUP_FAILED'
    else:
        code = 'VALIDATION_CHALLENGE_FAILED'
    result = {'code': code, 'stage': stage, 'attempt': getattr(error, 'attempt', 1), 'retryable': False}
    if getattr(error, 'cleanup_code', None):
        result['cleanupCode'] = 'BROWSER_CLEANUP_FAILED'
    return result


def run_request(runtime, request, stopped, on_timing, on_event=None):
    """Recover one lost browser, within the original task's time budget."""
    deadline = time.monotonic() + max(0, float(request.get('deadlineSeconds', 75)))
    failed_stage = 'browser_start'
    saw_failure = False

    def observe(event, **fields):
        if on_event:
            try:
                on_event(event, **fields)
            except Exception:
                pass

    runtime.on_event = observe

    def timing(stage, duration, outcome):
        nonlocal failed_stage, saw_failure
        if outcome == 'error' and (stage != 'browser_cleanup' or not saw_failure):
            failed_stage = stage
            saw_failure = True
        on_timing(stage, duration, outcome)

    for attempt in range(1, 3):
        if stopped.is_set():
            raise InterruptedError('Browser task cancelled')
        remaining = deadline - time.monotonic()
        if remaining < 1:
            raise TimeoutError('Browser task deadline exceeded')
        try:
            failed_stage = 'browser_start'
            saw_failure = False
            browser = runtime.ensure(timing)
            remaining = deadline - time.monotonic()
            if remaining < 1:
                raise TimeoutError('Browser task deadline exceeded')
            result = extract_sentinel(browser=browser, on_timing=timing, stop_event=stopped,
                deadline_seconds=remaining, include_so_token=False,
                proxy_url=request.get('proxyUrl', ''), user_agent=request.get('userAgent', ''),
                auth_base_url=request.get('authBaseUrl', 'https://auth.openai.com'),
                device_id=request.get('deviceID', ''), auth_flow=request.get('flow'), on_event=observe)
            if not result or stopped.is_set():
                raise InterruptedError('Browser task cancelled')
            if attempt > 1:
                observe('recovery_succeeded')
            return result
        except Exception as error:
            if attempt > 1:
                observe('recovery_failed')
            error.stage, error.attempt = failed_stage, attempt
            if stopped.is_set():
                raise InterruptedError('Browser task cancelled') from error
            if not is_browser_closed_error(error):
                raise
            # Do not include Chrome launch logs, URLs, cookies, or proxy credentials.
            connected = bool(runtime.browser and runtime.browser.is_connected())
            detail = (f'stage={failed_stage}; attempt={attempt}/2; '
                      f'browser_connected={str(connected).lower()}; cause={type(error).__name__}')
            try:
                runtime.close()
            except Exception:
                # A broken driver's cleanup must not hide the original failure.
                failure = BrowserUnavailableError(detail + '; browser cleanup failed')
                failure.stage, failure.attempt, failure.cleanup_code = failed_stage, attempt, 'BROWSER_CLEANUP_FAILED'
                raise failure from error
            if attempt == 2 or deadline - time.monotonic() < 1:
                failure = BrowserUnavailableError(detail + '; browser closed unexpectedly')
                failure.stage, failure.attempt = failed_stage, attempt
                if getattr(error, 'cleanup_code', None):
                    failure.cleanup_code = error.cleanup_code
                raise failure from error
            observe('recovery_started')


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
                result = run_request(runtime, request, stopped, timing,
                    lambda event, **fields: emit({'id': identity, 'event': 'diagnostic', 'diagnostic': {'event': event, **fields}}))
                # No cookies/storage state leave this helper; each task has already closed its context.
                emit({'id': identity, 'ok': True, 'result': {
                    'sentinel_token': result['sentinel_token'], 'oai_did': result['oai_did']}})
            except Exception as error:
                try:
                    runtime.close()
                except Exception:
                    error.cleanup_code = 'BROWSER_CLEANUP_FAILED'
                finally:
                    emit({'id': identity, 'ok': False, 'error': error_payload(error)})
            finally:
                request = result = None
    finally:
        runtime.close()


if __name__ == '__main__':
    main()
