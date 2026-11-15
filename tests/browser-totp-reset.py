"""Durable MFA reset boundaries; all HTTP requests use synthetic fixtures."""
import json
import runpy
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
fixture_page = runpy.run_path(str(ROOT / 'tests/browser-durability.py'))['fixture_page']
OLD, NEW = 'JBSWY3DPEHPK3PXP', 'KRSXG5DSNFXGOIDB'
ACCOUNT = {'id': 'fixture', 'email': 'fixture@example.com', 'password': 'fixture-password',
           'two_factor_secret': OLD, 'session_access_token': 'fixture-session'}


def check_reset(browser, failure):
    seed = {'state': {'format': 'protocol-login', 'browserAccounts': [ACCOUNT]},
            'fields': [{'id': 'login-accounts', 'value': f'fixture@example.com----fixture-password----{OLD}'}]}
    context, page, errors, _ = fixture_page(browser, seed)
    calls = []

    def reset(route):
        body = route.request.post_data_json
        action = body['action']
        calls.append(action)
        snapshot = body['browserState']
        account = snapshot['accounts'][0]
        saved = page.evaluate('async () => (await browserWorkspace.read()).state.browserAccounts[0]')
        ok, phase, message = True, 'confirmed', ''
        if action == 'prepare':
            assert saved['totp_reset_pending']['phase'] == 'preparing'
            account['totp_reset_pending'] = {'phase': 'prepared', 'secret': NEW, 'sessionId': 'fixture-enroll', 'factorId': 'new-factor'}
            phase = 'prepared'
        elif action == 'activate':
            assert saved['totp_reset_pending']['secret'] == NEW
            assert saved['totp_reset_pending']['phase'] == 'activating'
            if failure == 'lost-response':
                route.abort('failed')
                return
            account.update(two_factor_secret=NEW, status='已换绑2FA', totp_reset_pending=None)
            if failure == 'mfa500':
                ok, phase, message = False, 'activated', 'mfa_info HTTP 500'
                account['totp_reset_pending'] = {**saved['totp_reset_pending'], 'phase': 'activated'}
                account['status'] = '新 2FA 已激活，状态待确认'
        else:
            assert action == 'confirm'
            assert account['totp_reset_pending']['secret'] == NEW
            account.update(two_factor_secret=NEW, status='已换绑2FA', totp_reset_pending=None)
        result = {'id': 'fixture', 'email': ACCOUNT['email'], 'ok': ok, 'phase': phase, 'error': message}
        events = [('browser_state', snapshot)]
        if failure != 'snapshot-only' or action != 'activate':
            events += [('account_done', result), ('summary', {'ok': True, 'results': [result], 'success': int(ok), 'failed': int(not ok)})]
        route.fulfill(content_type='text/event-stream', body=''.join(f'event: {name}\ndata: {json.dumps(data)}\n\n' for name, data in events))

    page.route('**/api/v2/accounts/reset-totp', reset)
    page.route('**/api/system/config', lambda route: route.fulfill(json={'taskConcurrency': 2,
        **({} if failure == 'old-server' else {'totpResetProtocolVersion': 2})}))
    try:
        if failure in ['save-candidate', 'save-marker']:
            page.evaluate('''phase => {
                window.originalSave = browserWorkspace.save.bind(browserWorkspace);
                browserWorkspace.save = (snapshot, options) => snapshot.state?.browserAccounts?.some(a =>
                    a.totp_reset_pending?.secret && (phase === 'save-candidate' || a.totp_reset_pending.phase === 'activating'))
                    ? Promise.reject(new Error('fixture disk full')) : originalSave(snapshot, options);
            }''', failure)
        page.once('dialog', lambda dialog: dialog.accept())
        page.locator('#reset-login-totp').click()
        expect(page.locator('#reset-login-totp')).to_be_enabled()
        if failure == 'old-server':
            expect(page.locator('#login-status')).to_contain_text('请先重启服务并刷新页面')
            assert not calls
            return
        if failure in ['save-candidate', 'save-marker']:
            expect(page.locator('#login-status')).to_contain_text('停止后续激活')
            assert calls == ['prepare'], 'A failed durable save must prevent every activation'
            expect(page.locator('#login-reset-pending-credentials')).to_contain_text(NEW)
            with page.expect_download() as downloaded:
                page.locator('#download-login-reset-pending').click()
            backup = json.loads(Path(downloaded.value.path()).read_text(encoding='utf-8'))
            assert backup['accounts'][0]['secret'] == NEW
            page.evaluate('() => { browserWorkspace.save = originalSave; }')
            page.locator('#resume-login-totp').click()
            expect(page.locator('#login-status')).to_contain_text('成功 1')
            assert calls == ['prepare', 'activate']
        elif failure in ['mfa500', 'lost-response']:
            expect(page.locator('#login-reset-pending-credentials')).to_contain_text(NEW)
            page.reload()
            expect(page.locator('#login-reset-pending-credentials')).to_contain_text(NEW)
            if failure == 'mfa500':
                expect(page.locator('#login-accounts')).to_have_value(f'fixture@example.com----fixture-password----{NEW}')
                page.set_viewport_size({'width': 375, 'height': 850})
                panel = page.locator('#login-reset-pending')
                assert panel.evaluate('(node) => node.scrollWidth <= node.clientWidth')
                output = ROOT / 'output/totp-reset'
                output.mkdir(parents=True, exist_ok=True)
                panel.screenshot(path=str(output / 'pending-mobile.png'))
            page.locator('#resume-login-totp').click()
            expect(page.locator('#login-status')).to_contain_text('成功 1')
            assert calls == ['prepare', 'activate', 'confirm']
        elif failure == 'snapshot-only':
            expect(page.locator('#login-status')).to_contain_text('未返回汇总')
        page.reload()
        expect(page.locator('#login-reset-pending')).to_be_hidden()
        expect(page.locator('#login-accounts')).to_have_value(f'fixture@example.com----fixture-password----{NEW}')
        expect(page.locator('#login-reset-credentials')).to_contain_text(NEW)
        assert not errors, errors
    finally:
        context.close()
    print(f'TOTP reset {failure}: PASS')


if __name__ == '__main__':
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for failure in ['mfa500', 'lost-response', 'save-candidate', 'save-marker', 'snapshot-only', 'old-server']:
            check_reset(browser, failure)
        browser.close()
