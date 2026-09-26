"""Browser integration test; uses synthetic accounts and mocks only OAuth."""
import base64
import json
from browser_push_smoke import exercise_push
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import runpy
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def token(account_id, plan='plus'):
    payload = {"client_id": "app_EMoamEEZ73f0CkXaXp7hrann", "exp": 2100000000,
               "https://api.openai.com/auth": {"chatgpt_account_id": account_id, "chatgpt_plan_type": plan}}
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return "e30." + encoded + ".fixture"


def main():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory(prefix="browser-storage-test-") as runtime:
        env = {**os.environ, "SKIP_DOTENV": "1", "NODE_ENV": "development", "CONTAINER": "false",
               "HOST": "127.0.0.1", "PORT": str(port), "RUNTIME_DIR": runtime,
               "APP_PROXY_POOL": "", "TASK_CONCURRENCY": "10",
               "OPENAI_PROXY_URL": "", "SUB2API_BASE_URL": "", "SUB2API_ADMIN_API_KEY": ""}
        child = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            for _ in range(300):
                if child.poll() is not None:
                    raise RuntimeError(child.stderr.read().decode())
                try:
                    with urlopen(url + "/api/ready", timeout=0.5) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("service startup timed out")
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                owner = browser.new_context(accept_downloads=True)
                page = owner.new_page()
                errors = []
                proxy_requests = []
                login_plans = {'personal': 'plus', 'business': 'business'}
                page.on("pageerror", lambda error: errors.append(str(error)))

                def oauth(route):
                    body = route.request.post_data_json
                    proxy_requests.append((body.get("proxyMode"), body.get("proxyPool")))
                    snapshot = body["browserState"]
                    account = snapshot["accounts"][0]
                    workspaces = [{"workspaceId": name, "accountId": name, "refreshToken": f"fixture-{name}-rt", "accessToken": token(name, plan)}
                                  for name, plan in login_plans.items() if name != 'personal']
                    account.update({"openai_rt": "fixture-personal-rt", "openai_access_token": token("personal", login_plans['personal']),
                                    "openai_account_id": "personal",
                                    "business_workspace_credentials": workspaces})
                    result = {"id": account["id"], "email": account["email"], "ok": True, "personalOk": True, "businessSuccess": len(workspaces)}
                    summary = {"ok": True, "success": 1, "failed": 0, "results": [result]}
                    events = [("account_start", {"id": account["id"]}),
                              ("account_phase", {"id": account["id"], "phase": "codex"}),
                              ("account_log", {"id": account["id"], "msg": "代理连通性检测开始：出口=http://proxy.example:3000/，目标=auth.openai.com"}),
                              ("account_log", {"id": account["id"], "msg": "代理连通性检测通过：HTTP 200，耗时 42ms，开始正式流程"}),
                              ("account_log", {"id": account["id"], "msg": "Codex OAuth：登录并获取 refresh_token"}),
                              ("account_log", {"id": account["id"], "msg": "Codex OAuth 落点: /log-in/password"}),
                              ("account_log", {"id": account["id"], "msg": "提交账号密码"}),
                              ("account_log", {"id": account["id"], "msg": "密码后进入 2FA/MFA，提交 TOTP", "time": "2026-09-18T12:50:00Z"}),
                              ("account_log", {"id": account["id"], "msg": "提交 TOTP 2FA 验证码 (factor=fixture)", "time": "2026-09-18T12:50:10Z"}),
                              ("account_log", {"id": account["id"], "msg": "工作区授权页: HTTP 200 path=/consent"}),
                              ("account_log", {"id": account["id"], "msg": "Business 需要重新验证账号", "level": "warn"}),
                              ("account_log", {"id": account["id"], "msg": "工作区授权页: HTTP 503，重试后恢复", "level": "error"}),
                              ("browser_state", snapshot), ("account_done", result), ("summary", summary)]
                    route.fulfill(status=200, content_type="text/event-stream",
                                  body="".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events))

                page.route("**/api/v2/accounts/protocol-login-pipeline", oauth)
                page.goto(url)
                page.wait_for_function("() => !!window.browserWorkspace")
                expect(page.locator("#sub2api-concurrency")).to_have_value("50")
                expect(page.locator("#login-sub2-concurrency")).to_have_value("50")
                page.locator('.top-nav [data-format="protocol-login"]').click()
                expect(page.get_by_role("radio", name="直连", exact=True)).to_be_checked()
                page.get_by_role("radio", name="自定义代理池", exact=True).check()
                page.locator("#login-proxy-pool").fill("custom.example:3000:fixture:password")
                page.get_by_role("radio", name="内置代理池", exact=True).check()
                page.locator("#login-accounts").fill("fixture@example.com----FixturePassword!----JBSWY3DPEHPK3PXP")
                page.locator("#start-protocol-login").click()
                expect(page.locator("#export-login-personal")).to_be_enabled()
                expect(page.locator("#export-login-business")).to_be_enabled()
                assert proxy_requests[-1] == ("builtin", "")
                expect(page.get_by_text("正在检测代理连通性", exact=False)).to_be_visible()
                expect(page.get_by_text("代理连通性检测通过", exact=False)).to_be_visible()
                log = page.locator(".login-account-log").inner_text()
                assert log.count("已加入队列") == 1, log
                assert log.count("提交 2FA 验证码") == 1, log
                assert "OAuth 落点" not in log and "factor=" not in log and "HTTP 200 path=" not in log, log
                assert "注意 · Business 需要重新验证账号" in log and "失败 · 工作区授权页: HTTP 503" in log, log
                page.wait_for_function("async () => (await browserWorkspace.read())?.state?.loginPersonalIds?.length === 1")
                page.reload()
                expect(page.locator("#login-accounts")).to_have_value("fixture@example.com----FixturePassword!----JBSWY3DPEHPK3PXP")
                expect(page.get_by_role("radio", name="内置代理池", exact=True)).to_be_checked()
                expect(page.locator("#login-proxy-pool")).to_have_value("custom.example:3000:fixture:password")
                page.get_by_role("radio", name="直连", exact=True).check()
                for kind in ["personal", "business"]:
                    with page.expect_download() as download:
                        page.locator(f"#export-login-{kind}").click()
                    payload = json.loads(Path(download.value.path()).read_text(encoding="utf-8"))
                    assert payload["accounts"][0]["credentials"]["refresh_token"] == f"fixture-{kind}-rt"
                    assert payload["accounts"][0]["concurrency"] == 50
                exercise_push(page, login_plans)
                page.get_by_role("radio", name="本地代理", exact=True).check()
                page.locator("#login-proxy-local-port").fill("8899")
                page.wait_for_timeout(350)
                page.reload()
                expect(page.get_by_role("radio", name="本地代理", exact=True)).to_be_checked()
                expect(page.locator("#login-proxy-local-port")).to_have_value("8899")
                stranger = browser.new_context()
                other = stranger.new_page()
                other.goto(url)
                other.wait_for_function("() => !!window.browserWorkspace")
                assert other.locator("#login-accounts").input_value() == ""
                assert other.locator("#export-login-personal").is_disabled()
                assert not (other.evaluate("async () => (await browserWorkspace.read())?.state?.browserAccounts") or [])
                peer = owner.new_page()
                peer.goto(url)
                expect(peer.locator("#login-accounts")).to_have_value("fixture@example.com----FixturePassword!----JBSWY3DPEHPK3PXP")
                page.locator("#login-proxy-local-port").fill("8900")
                expect(peer.locator("#browser-storage-status")).to_contain_text("另一个标签页")
                expect(peer.locator("#start-protocol-login")).to_be_disabled()
                page.evaluate("() => { window.clearMarker = 'owner'; }")
                peer.evaluate("() => { window.clearMarker = 'peer'; }")
                page.evaluate("""() => {
                    document.querySelector('#login-sub2-admin-key').value = 'fixture-admin-key';
                    document.querySelector('#login-sub2-admin-key').type = 'text';
                    document.querySelector('#login-reset-credentials').textContent = 'fixture-reset-credentials';
                }""")
                workbench_before = page.locator("#login-workbench").bounding_box()
                page.once("dialog", lambda dialog: dialog.accept())
                page.locator("#clear-browser-data").click()
                expect(page.locator("#browser-storage-status")).to_have_text("所有数据已清空")
                expect(page.locator("#login-accounts")).to_have_value("")
                expect(page.locator("#login-sub2-admin-key")).to_have_value("")
                expect(page.locator("#login-sub2-admin-key")).to_have_attribute("type", "password")
                expect(page.locator("#login-reset-credentials")).to_have_text("")
                expect(page.locator("#task-concurrency-value")).to_have_text("10")
                expect(peer.locator("#login-accounts")).to_have_value("")
                expect(page.locator("#login-workbench")).to_be_visible()
                expect(page.locator("#start-protocol-login")).to_be_enabled()
                expect(peer.locator("#export-login-personal")).to_be_disabled()
                expect(peer.locator("#start-protocol-login")).to_be_disabled()
                assert page.evaluate("window.clearMarker") == "owner"
                assert peer.evaluate("window.clearMarker") == "peer"
                workbench_after = page.locator("#login-workbench").bounding_box()
                assert abs(workbench_before["x"] - workbench_after["x"]) < 1
                assert abs(workbench_before["width"] - workbench_after["width"]) < 1
                assert not (page.evaluate("async () => (await browserWorkspace.read())?.state?.browserAccounts") or [])

                # Late stream data cannot restore cleared credentials or change a new run.
                # The synthetic transport intentionally ignores abort, exercising the UI guard.
                page.evaluate("""() => {
                    window.originalFetch = window.fetch;
                    window.fetch = (url, options) => {
                        if (!String(url).endsWith('/protocol-login-pipeline')) return originalFetch(url, options);
                        window.pendingSignal = options.signal;
                        return Promise.resolve(new Response(new ReadableStream({start(controller) {
                            window.pendingStream = controller;
                        }, cancel() { window.cancelledStreams = (window.cancelledStreams || 0) + 1; }}), {headers: {'Content-Type': 'text/event-stream'}}));
                    };
                }""")
                page.locator("#login-accounts").fill("late@example.com----FixturePassword!----JBSWY3DPEHPK3PXP")
                page.locator("#start-protocol-login").click()
                page.wait_for_function("() => !!window.pendingStream")
                page.evaluate("""() => pendingStream.enqueue(new TextEncoder().encode(
                    'event: account_log\\ndata: {"email":"late@example.com","msg":"Codex OAuth：登录并获取 refresh_token"}\\n\\n'
                    + 'event: account_log\\ndata: {"email":"late@example.com","msg":"提交账号密码"}\\n\\n'))""")
                expect(page.locator(".login-account-stage")).to_have_text("输入密码")
                page.once("dialog", lambda dialog: dialog.accept())
                page.locator("#clear-browser-data").click()
                expect(page.locator("#browser-storage-status")).to_have_text("所有数据已清空")
                assert page.evaluate("pendingSignal.aborted && !browserWorkspace.signal.aborted")
                page.wait_for_function("() => window.cancelledStreams === 1")
                page.evaluate("""() => {
                    window.lateStream = pendingStream;
                    window.pendingStream = null;
                }""")
                page.locator("#login-accounts").fill("new@example.com----FixturePassword!----JBSWY3DPEHPK3PXP")
                page.locator("#start-protocol-login").click()
                page.wait_for_function("() => !!window.pendingStream")
                page.evaluate("""() => {
                    try {
                        lateStream.enqueue(new TextEncoder().encode('event: browser_state\\ndata: {"accounts":[{"id":"late","email":"late@example.com","password":"stale-password"}]}\\n\\nevent: summary\\ndata: {"ok":true,"success":1}\\n\\n'));
                        lateStream.close();
                    } catch (error) { if (!(error instanceof TypeError)) throw error; }
                }""")
                page.wait_for_timeout(400)  # Includes the pending persistence debounce.
                expect(page.locator("#start-protocol-login")).to_be_disabled()
                expect(page.locator("#login-accounts")).to_have_value("new@example.com----FixturePassword!----JBSWY3DPEHPK3PXP")
                stored = page.evaluate("async () => JSON.stringify(await browserWorkspace.read())")
                assert "late@example.com" not in stored and "stale-password" not in stored
                page.once("dialog", lambda dialog: dialog.accept())
                page.locator("#clear-browser-data").click()
                expect(page.locator("#browser-storage-status")).to_have_text("所有数据已清空")
                page.evaluate("() => { try { pendingStream.close(); } catch (error) { if (!(error instanceof TypeError)) throw error; } window.fetch = originalFetch; }")
                page.wait_for_timeout(400)
                assert page.evaluate("async () => !(await browserWorkspace.read())")

                # The same page remains usable; saving and reloading only restores new input.
                page.locator("#login-accounts").fill("fresh@example.com----FixturePassword!----JBSWY3DPEHPK3PXP")
                page.locator("#start-protocol-login").click()
                expect(page.locator("#export-login-personal")).to_be_enabled()
                page.wait_for_function("async () => (await browserWorkspace.read())?.state?.loginPersonalIds?.length === 1")
                page.reload()
                expect(page.get_by_role("radio", name="直连", exact=True)).to_be_checked()
                assert proxy_requests[-1] == ("direct", "")
                expect(page.locator("#login-accounts")).to_have_value("fresh@example.com----FixturePassword!----JBSWY3DPEHPK3PXP")
                page.once("dialog", lambda dialog: dialog.accept())
                page.locator("#clear-browser-data").click()
                expect(page.locator("#browser-storage-status")).to_have_text("所有数据已清空")

                # File reads are not abortable, but their late results must also be discarded.
                page.locator('.top-nav [data-format="sub2api"]').click()
                page.evaluate("""() => {
                    window.originalFileText = File.prototype.text;
                    File.prototype.text = () => new Promise(resolve => { window.pendingFile = resolve; });
                    const transfer = new DataTransfer();
                    transfer.items.add(new File(['fixture'], 'fixture.json', {type: 'application/json'}));
                    const input = document.querySelector('#file-input');
                    input.files = transfer.files;
                    input.dispatchEvent(new Event('change', {bubbles: true}));
                }""")
                page.wait_for_function("() => !!window.pendingFile")
                page.once("dialog", lambda dialog: dialog.accept())
                page.locator("#clear-browser-data").click()
                expect(page.locator("#browser-storage-status")).to_have_text("所有数据已清空")
                page.evaluate("""() => {
                    pendingFile(JSON.stringify({user: {email: 'old-file@example.com'}, accessToken: 'stale-access-token'}));
                    File.prototype.text = originalFileText;
                }""")
                page.wait_for_timeout(400)
                expect(page.locator("#session-input")).to_have_value("")
                expect(page.locator("#output")).to_have_value("")
                assert page.evaluate("async () => !(await browserWorkspace.read())")
                assert not errors, errors
                runpy.run_path(str(ROOT / 'tests/browser-progress-incremental.py'))['check_incremental_progress'](browser, url)
                runpy.run_path(str(ROOT / 'tests/browser-session-monitor.py'))['check_session_monitor'](browser, url)
                runpy.run_path(str(ROOT / 'tests/browser-self-leave.py'))['check_self_leave'](browser, url)
                runpy.run_path(str(ROOT / 'tests/browser-cached-actions.py'))['check_cached_actions'](browser, url)
                runpy.run_path(str(ROOT / 'tests/browser-account-import.py'))['check_account_import'](browser, url)
                stranger.close()
                owner.close()
                for width in [1440, 1024, 390, 320]:
                    layout = browser.new_context(viewport={"width": width, "height": 900})
                    screen = layout.new_page()
                    screen.goto(url)
                    screen.locator('.top-nav [data-format="protocol-login"]').click()
                    screen.locator("#login-accounts").fill("layout@example.com----FixturePassword!----JBSWY3DPEHPK3PXP")
                    screen.evaluate("() => { window.noReload = true; scrollTo(0, 0); }")
                    before = screen.locator("#login-workbench").bounding_box()
                    nav_before = screen.locator(".top-nav").bounding_box()
                    screen.once("dialog", lambda dialog: dialog.accept())
                    screen.locator("#clear-browser-data").click()
                    expect(screen.locator("#browser-storage-status")).to_have_text("所有数据已清空")
                    after = screen.locator("#login-workbench").bounding_box()
                    nav_after = screen.locator(".top-nav").bounding_box()
                    for dimension in ["x", "y", "width"]:
                        assert abs(before[dimension] - after[dimension]) < 1, (width, before, after)
                        assert abs(nav_before[dimension] - nav_after[dimension]) < 1, (width, nav_before, nav_after)
                    assert screen.evaluate("window.noReload && document.documentElement.scrollWidth <= innerWidth")
                    expect(screen.locator('#format-toolbar')).to_be_hidden()
                    expect(screen.locator('#push-feedback')).to_be_hidden()
                    if width >= 1024:
                        title = screen.locator('.login-title-row').bounding_box()
                        push = screen.locator('#push-controls').bounding_box()
                        assert push['x'] >= title['x'] + title['width']
                        assert abs(push['y'] - title['y']) < 30
                    if os.environ.get('PUSH_UI_SCREENSHOTS'):
                        destination = Path(os.environ['PUSH_UI_SCREENSHOTS'])
                        destination.mkdir(parents=True, exist_ok=True)
                        screen.screenshot(path=str(destination / f'login-page-{width}.png'))
                    expect(screen.locator("#login-accounts")).to_have_value("")
                    expect(screen.locator("#start-protocol-login")).to_be_enabled()
                    layout.close()
                browser.close()
            with urlopen(url + "/api/v2/sot") as response:
                assert json.load(response)["data"]["accountCount"] == 0
            assert list(Path(runtime).iterdir()) == []
            print("Browser storage: concise logs, stable desktop/mobile clear, canceled responses, reuse, exports, isolation: PASS")
        finally:
            child.terminate()
            child.wait(timeout=10)


if __name__ == "__main__":
    main()
