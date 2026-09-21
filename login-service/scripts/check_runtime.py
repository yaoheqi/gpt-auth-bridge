"""Local dependency self-check. No accounts, credentials or network requests."""
import json
import platform
import sys
from importlib.metadata import version
from pathlib import Path

import curl_cffi
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sentinel import _find_chrome

# Check the full browser used by Sentinel, including its Crashpad startup.
# Playwright's default headless shell can pass while this executable fails.
with sync_playwright() as playwright:
    chrome = _find_chrome(playwright)
    if not chrome:
        raise RuntimeError('Chromium executable is unavailable')
    browser = playwright.chromium.launch(
        executable_path=chrome,
        headless=True,
        args=['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    )
    page = browser.new_page()
    page.goto('data:text/html,<title>runtime-ready</title>')
    if page.title() != 'runtime-ready':
        raise RuntimeError('Chromium page creation failed')
    browser.close()

print(json.dumps({
    "python": platform.python_version(),
    "curl_cffi": version("curl_cffi"),
    "playwright": version("playwright"),
    "chromium": True,
}))
