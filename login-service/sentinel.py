from __future__ import annotations

import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import uuid
import json
from pathlib import Path
from contextlib import ExitStack, contextmanager
from urllib.parse import quote

from playwright.sync_api import sync_playwright


DEFAULT_SENTINEL_TIMEOUT = 75
CHAT_WEB_CLIENT_ID = "app_X8zY6vW2pQ9tR3dE7nK1jL5gH"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
)
FIXED_LOCAL_PROXY_URL = (
    str(os.environ.get("OPENAI_PROXY_URL") or "").strip()
    if "OPENAI_PROXY_URL" in os.environ
    else ""
)
_CHROME_CACHE: str | None = None
_SENTINEL_SEMAPHORE = threading.BoundedSemaphore(1)


class SentinelBrowserTransport:
    def __init__(self, *, stop_event=None, deadline_seconds=DEFAULT_SENTINEL_TIMEOUT, proxy_url="", auth_base_url="https://auth.openai.com", user_agent=DEFAULT_USER_AGENT):
        self.stop_event = stop_event
        self.deadline_seconds = deadline_seconds
        self.proxy_url = str(proxy_url or os.environ.get("APP_PROXY") or FIXED_LOCAL_PROXY_URL).strip()
        self.auth_base_url = auth_base_url
        self.user_agent = user_agent
        self._playwright = None
        self.browser = None
        self.context = None
        self.page = None
        self._proxy_bridge = None

    def extract(self) -> dict:
        acquired = False
        while not acquired:
            if _stopped(self.stop_event):
                raise InterruptedError("任务已停止")
            acquired = _SENTINEL_SEMAPHORE.acquire(timeout=0.1)
        try:
            chrome = _find_chrome()
            if not chrome:
                raise RuntimeError("未找到 Google Chrome，协议注册无法获取 Sentinel")
            deadline = time.time() + max(1, int(self.deadline_seconds))

            def remaining_ms(cap: int = 15000) -> int:
                return max(1000, min(cap, int((deadline - time.time()) * 1000)))

            self._playwright = sync_playwright().start()
            self.browser = self._playwright.chromium.launch(
                executable_path=chrome,
                headless=False,
                args=["--start-minimized", "--disable-blink-features=AutomationControlled", "--no-sandbox"],
            )
            options = {"user_agent": self.user_agent, "locale": "en-US", "timezone_id": "America/New_York"}
            proxy, self._proxy_bridge = _playwright_proxy(self.proxy_url)
            if proxy:
                options["proxy"] = proxy
            self.context = self.browser.new_context(**options)
            self.page = self.context.new_page()
            self.page.set_default_timeout(remaining_ms())
            self.page.set_default_navigation_timeout(remaining_ms())
            device_id = str(uuid.uuid4())
            state = secrets.token_urlsafe(32)
            scope = "openid email profile offline_access model.request model.read organization.read organization.write"
            authorize_url = (
                f"{self.auth_base_url}/api/accounts/authorize?client_id={CHAT_WEB_CLIENT_ID}"
                f"&scope={quote(scope)}&response_type=code"
                f"&redirect_uri={quote('https://chatgpt.com/api/auth/callback/openai')}"
                f"&audience={quote('https://api.openai.com/v1')}"
                f"&device_id={device_id}&prompt=login&screen_hint=signup&state={state}"
            )
            self.page.goto(authorize_url, wait_until="domcontentloaded", timeout=remaining_ms(30000))
            while time.time() < deadline and not _stopped(self.stop_event):
                try:
                    if self.page.evaluate("typeof window.SentinelSDK !== 'undefined'"):
                        break
                except Exception:
                    pass
                time.sleep(0.5)
            if _stopped(self.stop_event):
                raise InterruptedError("任务已停止")
            if not self.page.evaluate("typeof window.SentinelSDK !== 'undefined'"):
                raise TimeoutError("等待 SentinelSDK 超时")
            try:
                self.page.evaluate("SentinelSDK.init()")
            except Exception:
                pass
            did = self.page.evaluate("document.cookie.match(/oai-did=([^;]+)/)?.[1] || ''") or device_id
            token_js = """({did, timeoutMs}) => Promise.race([
                SentinelSDK.token().then(raw => { const payload = JSON.parse(raw); payload.id = did; payload.flow = 'username_password_create'; return JSON.stringify(payload); }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Sentinel token timeout')), timeoutMs))
            ])"""
            so_js = """({did, timeoutMs}) => Promise.race([
                SentinelSDK.token().then(raw => { const payload = JSON.parse(raw); return JSON.stringify({so: raw, c: payload.c, id: did, flow: 'oauth_create_account'}); }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Sentinel token timeout')), timeoutMs))
            ])"""
            return {
                "sentinel_token": self.page.evaluate(token_js, {"did": did, "timeoutMs": remaining_ms(20000)}),
                "sentinel_so_token": self.page.evaluate(so_js, {"did": did, "timeoutMs": remaining_ms(20000)}),
                "cookies": self.context.cookies(),
                "cookie_str": "; ".join(f"{item['name']}={item['value']}" for item in self.context.cookies()),
                "oai_did": did,
                "_browser_transport": self,
            }
        except Exception:
            self.close()
            raise
        finally:
            _SENTINEL_SEMAPHORE.release()

    def fetch_json(self, url: str, *, payload: dict, cookies: list[dict], referer: str, headers: dict | None = None) -> dict:
        if not self.context or not self.page:
            raise RuntimeError("Sentinel 浏览器会话已关闭")
        if cookies:
            # Keep Cloudflare cookies created by this browser network stack.
            # Only synchronize application/OAuth state from the HTTP session.
            app_cookies = [
                item for item in cookies
                if not str(item.get("name") or "").lower().startswith(("cf_", "_cf", "__cf"))
                and str(item.get("name") or "").lower() != "__cflb"
            ]
            if app_cookies:
                self.context.add_cookies(app_cookies)
        if not self.page.url.startswith("https://auth.openai.com/") or self.page.url.rstrip("/") != referer.rstrip("/"):
            self.page.goto(referer, wait_until="domcontentloaded", timeout=60000)
        deadline = time.time() + 45
        while time.time() < deadline and not _stopped(self.stop_event):
            try:
                title = self.page.title().lower()
                ready = self.page.evaluate("typeof window.SentinelSDK !== 'undefined'")
                if "just a moment" not in title and ready:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        if _stopped(self.stop_event):
            raise InterruptedError("任务已停止")
        result = self.page.evaluate(
            """async ({url, body, headers}) => {
                const response = await fetch(url, {
                    method: 'POST', credentials: 'include',
                    headers: {accept: 'application/json', 'content-type': 'application/json', ...headers},
                    body: JSON.stringify(body),
                });
                return {status: response.status, text: await response.text(), url: response.url, headers: Object.fromEntries(response.headers.entries())};
            }""",
            {"url": url, "body": payload, "headers": headers or {}},
        )
        result["cookies"] = self.context.cookies()
        return result

    def start_signup(self, email: str, *, params: dict, cookies: list[dict]) -> dict:
        if not self.context or not self.page:
            raise RuntimeError("Sentinel 浏览器会话已关闭")
        app_cookies = [
            item for item in cookies
            if not str(item.get("name") or "").lower().startswith(("cf_", "_cf", "__cf"))
            and str(item.get("name") or "").lower() != "__cflb"
        ]
        if app_cookies:
            self.context.add_cookies(app_cookies)
        self.page.goto("https://chatgpt.com/auth/login", wait_until="domcontentloaded", timeout=60000)
        signin_url = self.page.evaluate(
            """async ({params}) => {
                const csrfResp = await fetch('/api/auth/csrf', {credentials: 'include'});
                const csrf = await csrfResp.json();
                const form = new URLSearchParams({
                    csrfToken: csrf.csrfToken,
                    callbackUrl: 'https://chatgpt.com/',
                    json: 'true',
                });
                const response = await fetch('/api/auth/signin/openai?' + new URLSearchParams(params), {
                    method: 'POST', credentials: 'include',
                    headers: {'content-type': 'application/x-www-form-urlencoded', 'x-auth-return-redirect': '1'},
                    body: form.toString(),
                });
                const text = await response.text();
                let data = {};
                try { data = JSON.parse(text); } catch (_) {}
                const url = data.url || response.headers.get('location') || '';
                if (!url) throw new Error('浏览器协议发起注册失败 [HTTP ' + response.status + ']: ' + text.slice(0, 300));
                return url;
            }""",
            {"params": params},
        )
        self.page.goto(signin_url, wait_until="domcontentloaded", timeout=60000)
        deadline = time.time() + 45
        while time.time() < deadline and not _stopped(self.stop_event):
            try:
                if "just a moment" not in self.page.title().lower() and self.page.evaluate("typeof window.SentinelSDK !== 'undefined'"):
                    break
            except Exception:
                pass
            time.sleep(0.5)
        if not self.page.evaluate("typeof window.SentinelSDK !== 'undefined'"):
            raise RuntimeError("浏览器协议注册页未通过校验，SentinelSDK 未加载")
        result = self.page.evaluate(
            """async ({email}) => {
                const raw = await SentinelSDK.token();
                const token = JSON.parse(raw);
                token.id = document.cookie.match(/oai-did=([^;]+)/)?.[1] || token.id;
                token.flow = 'username_password_create';
                const response = await fetch('/api/accounts/authorize/continue', {
                    method: 'POST', credentials: 'include',
                    headers: {
                        accept: 'application/json',
                        'content-type': 'application/json',
                        'openai-sentinel-token': JSON.stringify(token),
                    },
                    body: JSON.stringify({username: {kind: 'email', value: email}}),
                });
                return {status: response.status, text: await response.text(), url: response.url, headers: Object.fromEntries(response.headers.entries())};
            }""",
            {"email": email},
        )
        result["cookies"] = self.context.cookies()
        return result

    def close(self) -> None:
        for value in (self.context, self.browser, self._playwright):
            if value is None:
                continue
            try:
                value.close() if hasattr(value, "close") else value.stop()
            except Exception:
                pass
        self.page = self.context = self.browser = self._playwright = None
        bridge = getattr(self, "_proxy_bridge", None)
        self._proxy_bridge = None
        if bridge is not None:
            try:
                bridge.stop()
            except Exception:
                pass


def _stopped(stop_event) -> bool:
    return bool(stop_event and stop_event.is_set())


def _find_chrome(playwright=None) -> str | None:
    global _CHROME_CACHE
    if _CHROME_CACHE and Path(_CHROME_CACHE).exists():
        return _CHROME_CACHE
    env_candidates = (
        os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", ""),
        os.environ.get("CHROME_PATH", ""),
    )
    windows_candidates = (
        r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
        r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
        r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe",
    )
    for candidate in (*env_candidates, *windows_candidates):
        if not candidate:
            continue
        path = os.path.expandvars(candidate)
        if Path(path).exists():
            _CHROME_CACHE = path
            return path
    if os.name != "nt":
        for executable in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable"):
            path = shutil.which(executable)
            if path:
                _CHROME_CACHE = path
                return path
    else:
        try:
            result = subprocess.run(["where", "chrome"], capture_output=True, text=True, check=False)
            for line in result.stdout.splitlines():
                path = line.strip()
                if path.lower().endswith("chrome.exe") and Path(path).exists():
                    _CHROME_CACHE = path
                    return path
        except Exception:
            pass
    if playwright is not None:
        path = str(playwright.chromium.executable_path or "")
        if path and Path(path).exists():
            _CHROME_CACHE = path
            return path
        return None
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            path = str(playwright.chromium.executable_path or "")
            if path and Path(path).exists():
                _CHROME_CACHE = path
                return path
    except Exception:
        pass
    return None


def _playwright_proxy(proxy_url: str):
    """Build Playwright proxy config; authenticated upstreams go through a local bridge."""
    try:
        from local_proxy_bridge import playwright_proxy_via_bridge
    except Exception:
        playwright_proxy_via_bridge = None
    value = str(proxy_url or os.environ.get("APP_PROXY") or FIXED_LOCAL_PROXY_URL).strip()
    if not value:
        return None, None
    if playwright_proxy_via_bridge is not None:
        return playwright_proxy_via_bridge(value)
    if "://" not in value:
        value = "http://" + value
    match = re.match(r"(https?)://([^:]+):([^@]+)@([^:]+):(\d+)$", value)
    if match:
        scheme, username, password, host, port = match.groups()
        return {
            "server": f"{scheme}://{host}:{port}",
            "username": username,
            "password": password,
        }, None
    return {"server": value}, None


@contextmanager
def _timed_stage(stage, observer):
    started = time.monotonic()
    outcome = 'ok'
    try:
        yield
    except BaseException:
        outcome = 'error'
        raise
    finally:
        if observer:
            observer(stage, (time.monotonic() - started) * 1000, outcome)


def extract_sentinel(
    *,
    stop_event=None,
    deadline_seconds: int = DEFAULT_SENTINEL_TIMEOUT,
    proxy_url: str = "",
    auth_base_url: str = "https://auth.openai.com",
    user_agent: str = DEFAULT_USER_AGENT,
    keep_browser: bool = False,
    include_so_token: bool = True,
    browser=None,
    on_timing=None,
) -> dict | None:
    """Use a short-lived real Chrome context to obtain registration Sentinel tokens."""
    if keep_browser:
        return SentinelBrowserTransport(
            stop_event=stop_event,
            deadline_seconds=deadline_seconds,
            proxy_url=proxy_url,
            auth_base_url=auth_base_url,
            user_agent=user_agent,
        ).extract()
    acquired = False
    while not acquired:
        if _stopped(stop_event):
            return None
        acquired = _SENTINEL_SEMAPHORE.acquire(timeout=0.1)
    try:
        deadline = time.time() + max(1, int(deadline_seconds))

        def remaining_ms(cap: int = 15000) -> int:
            return max(1000, min(cap, int((deadline - time.time()) * 1000)))

        with ExitStack() as resources:
            if browser is None:
                with _timed_stage('browser_start', on_timing):
                    playwright = resources.enter_context(sync_playwright())
                    chrome = _find_chrome(playwright)
                    if not chrome:
                        raise RuntimeError("未找到 Google Chrome，协议登录无法获取 Sentinel")
                    browser = playwright.chromium.launch(
                        executable_path=chrome, headless=True,
                        args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
                    )
                    resources.callback(browser.close)
            context_options = {
                "user_agent": user_agent,
                "locale": "en-US",
                "timezone_id": "America/New_York",
            }
            proxy_bridge = None
            context = None
            try:
                with _timed_stage('browser_context', on_timing):
                    proxy, proxy_bridge = _playwright_proxy(proxy_url)
                    if proxy:
                        context_options["proxy"] = proxy
                    context = browser.new_context(**context_options)
                page = context.new_page()
                page.set_default_timeout(remaining_ms())
                page.set_default_navigation_timeout(remaining_ms())
                device_id = str(uuid.uuid4())
                state = secrets.token_urlsafe(32)
                scope = "openid email profile offline_access model.request model.read organization.read organization.write"
                authorize_url = (
                    f"{auth_base_url}/api/accounts/authorize?client_id={CHAT_WEB_CLIENT_ID}"
                    f"&scope={quote(scope)}&response_type=code"
                    f"&redirect_uri={quote('https://chatgpt.com/api/auth/callback/openai')}"
                    f"&audience={quote('https://api.openai.com/v1')}"
                    f"&device_id={device_id}&prompt=login&screen_hint=signup&state={state}"
                )
                with _timed_stage('browser_navigation', on_timing):
                    page.goto(authorize_url, wait_until="domcontentloaded", timeout=remaining_ms(90000))
                    while time.time() < deadline and not _stopped(stop_event):
                        try:
                            if page.evaluate("typeof window.SentinelSDK !== 'undefined'"):
                                break
                        except Exception:
                            pass
                        time.sleep(0.5)
                    if _stopped(stop_event):
                        return None
                    if not page.evaluate("typeof window.SentinelSDK !== 'undefined'"):
                        raise TimeoutError("等待 SentinelSDK 超时")
                try:
                    page.evaluate("SentinelSDK.init()")
                except Exception:
                    pass
                did = page.evaluate("document.cookie.match(/oai-did=([^;]+)/)?.[1] || ''") or device_id
                token_js = """
                    ({did, timeoutMs}) => Promise.race([
                        SentinelSDK.token().then(raw => {
                            const payload = JSON.parse(raw);
                            payload.id = did;
                            payload.flow = 'username_password_create';
                            return JSON.stringify(payload);
                        }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Sentinel token timeout')), timeoutMs))
                    ])
                """
                so_js = """
                    ({did, timeoutMs}) => Promise.race([
                        SentinelSDK.token().then(raw => {
                            const payload = JSON.parse(raw);
                            return JSON.stringify({so: raw, c: payload.c, id: did, flow: 'oauth_create_account'});
                        }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Sentinel token timeout')), timeoutMs))
                    ])
                """
                with _timed_stage('browser_verify', on_timing):
                    result = {
                        "sentinel_token": page.evaluate(token_js, {"did": did, "timeoutMs": remaining_ms(20000)}),
                        "oai_did": did,
                    }
                    # Protocol login consumes only the primary token. Do not wait for
                    # an unrelated registration token or fail an already-ready login.
                    if include_so_token:
                        result["sentinel_so_token"] = page.evaluate(so_js, {"did": did, "timeoutMs": remaining_ms(20000)})
                cookies = context.cookies()
                result["cookies"] = cookies
                result["cookie_str"] = "; ".join(f"{item['name']}={item['value']}" for item in cookies)
                return result
            finally:
                with _timed_stage('browser_cleanup', on_timing):
                    try:
                        if context is not None:
                            context.close()
                    finally:
                        if proxy_bridge is not None:
                            proxy_bridge.stop()
    finally:
        _SENTINEL_SEMAPHORE.release()


def browser_fetch_json(
    url: str,
    *,
    method: str = "POST",
    payload: dict | None = None,
    cookies: list[dict] | None = None,
    referer: str = "https://auth.openai.com/",
    stop_event=None,
    deadline_seconds: int = 60,
    proxy_url: str = "",
    user_agent: str = DEFAULT_USER_AGENT,
    headers: dict | None = None,
) -> dict:
    """Replay a Cloudflare-protected JSON request through a real Chrome page."""
    acquired = False
    while not acquired:
        if _stopped(stop_event):
            raise InterruptedError("任务已停止")
        acquired = _SENTINEL_SEMAPHORE.acquire(timeout=0.1)
    try:
        chrome = _find_chrome()
        if not chrome:
            raise RuntimeError("未找到 Google Chrome，无法重试受保护的协议请求")
        timeout_ms = max(1000, int(deadline_seconds) * 1000)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=chrome,
                headless=True,
                args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
            )
            context_options = {
                "user_agent": user_agent,
                "locale": "en-US",
                "timezone_id": "America/New_York",
            }
            proxy, proxy_bridge = _playwright_proxy(proxy_url)
            if proxy:
                context_options["proxy"] = proxy
            context = browser.new_context(**context_options)
            try:
                valid_cookies = []
                for item in cookies or []:
                    if not isinstance(item, dict) or not item.get("name") or not item.get("domain"):
                        continue
                    name = str(item["name"])
                    if name.startswith("__Host-"):
                        continue
                    domain = str(item.get("domain") or "").strip()
                    if not domain or domain in {".", "/"}:
                        continue
                    same_site = str(item.get("sameSite") or "Lax")
                    if same_site not in {"Strict", "Lax", "None"}:
                        same_site = "Lax"
                    try:
                        expires = float(item.get("expires") or -1)
                    except Exception:
                        expires = -1.0
                    valid_cookies.append({
                        "name": name,
                        "value": str(item.get("value") or ""),
                        "domain": domain,
                        "path": str(item.get("path") or "/") or "/",
                        "expires": expires,
                        "httpOnly": bool(item.get("httpOnly", False)),
                        "secure": bool(item.get("secure", True)),
                        "sameSite": same_site,
                    })
                if valid_cookies:
                    context.add_cookies(valid_cookies)
                page = context.new_page()
                page.set_default_timeout(timeout_ms)
                page.set_default_navigation_timeout(timeout_ms)
                page.goto(referer, wait_until="domcontentloaded", timeout=timeout_ms)
                result = page.evaluate(
                    """async ({url, method, body, headers}) => {
                        const response = await fetch(url, {
                            method,
                            credentials: 'include',
                            headers: {accept: 'application/json', 'content-type': 'application/json', ...headers},
                            body: body === null ? undefined : JSON.stringify(body),
                        });
                        return {
                            status: response.status,
                            text: await response.text(),
                            url: response.url,
                            headers: Object.fromEntries(response.headers.entries()),
                        };
                    }""",
                    {"url": url, "method": method, "body": payload, "headers": headers or {}},
                )
                result["cookies"] = context.cookies()
                return result
            finally:
                try:
                    context.close()
                finally:
                    browser.close()
                    if 'proxy_bridge' in locals() and proxy_bridge is not None:
                        try:
                            proxy_bridge.stop()
                        except Exception:
                            pass
    finally:
        _SENTINEL_SEMAPHORE.release()
