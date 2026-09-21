"""Browser UI and real proxy requests against local Sub2API/CPA fixtures."""
import json
import os
import re
from pathlib import Path
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from playwright.sync_api import expect


def exercise_push(page, login_plans):
    calls = []
    fail_sub2 = [True]
    fail_cpa = [True]

    def inspect_dialog(selector, name):
        original = page.viewport_size
        for width, height in [(1280, 900), (390, 844), (320, 640)]:
            page.set_viewport_size({'width': width, 'height': height})
            dialog = page.locator(selector)
            box = dialog.bounding_box()
            assert box and box['x'] >= 0 and box['x'] + box['width'] <= width
            assert dialog.evaluate('(el) => el.scrollWidth <= el.clientWidth')
            assert box['y'] >= 0 and box['y'] + box['height'] <= height
            if name == 'sub2-dialog':
                group_button = page.locator('#load-login-sub2-groups').bounding_box()
                assert group_button['x'] >= box['x'] and group_button['x'] + group_button['width'] <= box['x'] + box['width']
            if os.environ.get('PUSH_UI_SCREENSHOTS'):
                destination = Path(os.environ['PUSH_UI_SCREENSHOTS'])
                destination.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(destination / f'{name}-{width}.png'))
            if name == 'sub2-dialog':
                page.locator('.push-account-options summary').click()
                expect(page.locator('#save-login-sub2-config')).to_be_in_viewport()
                page.locator('#login-sub2-models').scroll_into_view_if_needed()
                expect(page.locator('#login-sub2-models')).to_be_in_viewport()
                assert dialog.evaluate('(el) => el.scrollWidth <= el.clientWidth')
                page.locator('.push-account-options summary').click()
        page.set_viewport_size(original)

    class Remote(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, body, status=200):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            calls.append(('GET', self.path, None))
            if self.path == '/api/v1/admin/groups/all':
                assert self.headers['x-api-key'] == 'fixture-sub2-key'
                self.reply({'code': 0, 'data': [{'id': 7, 'name': 'Fixture OpenAI', 'platform': 'openai'}, {'id': 8, 'name': 'Not OpenAI', 'platform': 'anthropic'}]})
            elif self.path == '/v0/management/auth-files':
                assert self.headers['Authorization'] == 'Bearer fixture-cpa-key'
                self.reply({'files': []})
            else:
                self.reply({'error': 'unexpected route'}, 404)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            calls.append(('POST', self.path, body))
            if self.path == '/api/v1/admin/accounts/batch':
                assert self.headers['x-api-key'] == 'fixture-sub2-key'
                results = []
                for index, account in enumerate(body['accounts']):
                    assert account['group_ids'] == [7]
                    assert account['concurrency'] == 50
                    failed = len(body['accounts']) > 1 and index == 1 and fail_sub2[0]
                    if failed:
                        fail_sub2[0] = False
                    results.append({'success': not failed, 'name': account['name']})
                success = sum(row['success'] for row in results)
                self.reply({'code': 0, 'data': {'success': success, 'failed': len(results) - success, 'results': results}})
            elif urlparse(self.path).path == '/v0/management/auth-files':
                assert self.headers['Authorization'] == 'Bearer fixture-cpa-key'
                assert body['type'] == 'codex'
                assert body['refresh_token'].startswith('fixture-')
                if body['account_id'] == 'business' and fail_cpa[0]:
                    fail_cpa[0] = False
                    self.reply({'error': 'fixture rejection'}, 403)
                else:
                    self.reply({'status': 'ok'})
            else:
                self.reply({'error': 'unexpected route'}, 404)

    remote = ThreadingHTTPServer(('127.0.0.1', 0), Remote)
    threading.Thread(target=remote.serve_forever, daemon=True).start()
    remote_url = f'http://127.0.0.1:{remote.server_port}'
    setting_requests = []
    api_bodies = []

    def record(request):
        if '/api/v2/' in request.url and request.post_data:
            api_bodies.append(request.post_data)
        if '/api/v2/admin/sub2api/settings' in request.url and request.method == 'PUT':
            setting_requests.append(request.url)

    page.on('request', record)
    try:
        # A free workspace must be filtered even when its parent login is Plus.
        login_plans['free-workspace'] = ' FrEe '
        expect(page.locator('#push-login-personal, #push-login-business')).to_have_count(0)
        page.locator('#open-sub2-push-config').click()
        expect(page.locator('#sub2-push-dialog')).to_be_visible()
        page.locator('#save-login-sub2-config').click()
        expect(page.locator('#login-sub2-status')).to_contain_text('账号参数已加密保存')
        assert not calls, 'Saving local export settings must not call the remote service'
        page.locator('#login-sub2-base-url').fill(remote_url + '/admin')
        page.locator('#login-sub2-admin-key').fill('fixture-sub2-key')
        page.locator('#load-login-sub2-groups').click()
        expect(page.locator('#login-sub2-groups input[type=checkbox]')).to_have_count(1)
        page.locator('[data-sub2-group-id="7"]').check()
        page.locator('#save-login-sub2-config').click()
        expect(page.locator('#login-sub2-status')).to_contain_text('已加密保存')
        inspect_dialog('#sub2-push-dialog', 'sub2-dialog')
        page.get_by_role('button', name='关闭 Sub2API 配置', exact=True).click()
        page.locator('input[name="push-target"][value="sub2api"]').check()
        # Selecting a target automatically pushes only non-free RTs after login.
        page.locator('#start-protocol-login').click()
        expect(page.locator('#push-status')).to_contain_text('成功 1，失败 1')
        assert {account['credentials']['refresh_token'] for account in calls[-1][2]['accounts']} == {'fixture-personal-rt', 'fixture-business-rt'}
        expect(page.locator('#retry-push')).to_be_enabled()
        page.locator('#retry-push').click()
        expect(page.locator('#push-status')).to_contain_text('成功 1，失败 0')
        assert len(calls[-1][2]['accounts']) == 1
        assert calls[-1][2]['accounts'][0]['credentials']['refresh_token'] == 'fixture-business-rt'
        expect(page.locator('#export-login-personal')).to_be_enabled()

        page.locator('#open-cpa-push-config').click()
        page.locator('#cpa-base-url').fill(remote_url + '/management.html#/auth-files')
        page.locator('#cpa-management-key').fill('fixture-cpa-key')
        page.locator('#check-cpa-config').click()
        expect(page.locator('#cpa-config-status')).to_contain_text('连接成功')
        page.locator('#save-cpa-config').click()
        expect(page.locator('#cpa-config-status')).to_contain_text('已加密保存')
        inspect_dialog('#cpa-push-dialog', 'cpa-dialog')
        page.get_by_role('button', name='关闭 CPA 配置', exact=True).click()
        page.locator('input[name="push-target"][value="cpa"]').check()
        page.locator('#start-protocol-login').click()
        expect(page.locator('#push-status')).to_contain_text('成功 1，失败 1')
        uploads = [call for call in calls if call[0] == 'POST' and call[1].startswith('/v0/')]
        assert {call[2]['account_id'] for call in uploads} == {'personal', 'business'}
        assert len({parse_qs(urlparse(call[1]).query)['name'][0] for call in uploads}) == 2
        page.locator('#retry-push').click()
        expect(page.locator('#push-status')).to_contain_text('成功 1，失败 0')
        assert calls[-1][2]['account_id'] == 'business'

        # A free personal account must not suppress its paid Business workspace.
        # All-free batches make no push request and remain downloadable.
        for target in ['sub2api', 'cpa']:
            login_plans.update(personal=' FREE ', business='business')
            page.locator(f'input[name="push-target"][value="{target}"]').check()
            before = len(calls)
            page.locator('#start-protocol-login').click()
            expect(page.locator('#start-protocol-login')).to_be_enabled()
            expect(page.locator('#push-status')).to_contain_text('成功 1，失败 0')
            pushed = calls[before:]
            assert len(pushed) == 1, pushed
            accounts = pushed[0][2]['accounts'] if target == 'sub2api' else [pushed[0][2]]
            assert [(account.get('credentials') or account)['refresh_token'] for account in accounts] == ['fixture-business-rt']
            login_plans['business'] = 'free'
            before = len(calls)
            page.locator('#start-protocol-login').click()
            expect(page.locator('#push-status')).to_contain_text('没有可推送的非 free 账号')
            expect(page.locator('#start-protocol-login')).to_be_enabled()
            expect(page.locator('#retry-push')).to_be_hidden()
            expect(page.locator('#push-result-details')).to_be_hidden()
            assert len(calls) == before
            for kind, count in [('personal', 1), ('business', 2)]:
                with page.expect_download() as download:
                    page.locator(f'#export-login-{kind}').click()
                data = json.loads(Path(download.value.path()).read_text(encoding='utf-8'))
                assert len(data['accounts']) == count
                assert all(account['credentials']['plan_type'].strip().lower() == 'free' for account in data['accounts'])

        # Neither an explicit opt-out nor Session-only login auto-pushes.
        login_plans.update(personal='plus', business='business')
        before = len(calls)
        page.locator('input[name="push-target"][value="none"]').check()
        page.locator('#start-protocol-login').click()
        expect(page.locator('#start-protocol-login')).to_be_enabled()
        assert len(calls) == before
        page.locator('input[name="push-target"][value="cpa"]').check()
        page.locator('input[name="login-workspace-mode"][value="session"]').check()
        page.locator('#start-protocol-login').click()
        expect(page.locator('#start-protocol-login')).to_be_enabled()
        assert len(calls) == before
        page.locator('input[name="login-workspace-mode"][value="all"]').check()

        page.wait_for_function("async () => (await browserWorkspace.read())?.state?.cpaSettings?.managementKey === 'fixture-cpa-key'")
        encrypted = page.evaluate("""async () => {
          const db = await new Promise(r => { const q = indexedDB.open('session-converter-browser'); q.onsuccess = () => r(q.result); });
          const tx = db.transaction('workspace'); const store = tx.objectStore('workspace');
          const snapshot = store.get('current'), key = store.get('encryption-key');
          return await new Promise(r => tx.oncomplete = () => r({ encryption: snapshot.result.encryption,
            extractable: key.result.extractable, raw: JSON.stringify(snapshot.result) }));
        }""")
        assert encrypted['encryption'] == 'AES-GCM-v1' and encrypted['extractable'] is False
        assert 'fixture-' not in encrypted['raw']
        assert not setting_requests
        assert all('fixture-sub2-key' not in body and 'fixture-cpa-key' not in body for body in api_bodies)
        page.reload()
        page.locator('#open-cpa-push-config').click()
        expect(page.locator('#cpa-management-key')).to_have_value('fixture-cpa-key')
        expect(page.locator('#cpa-base-url')).to_have_value(remote_url)
        page.keyboard.press('Escape')
        expect(page.locator('#cpa-push-dialog')).not_to_be_visible()
        page.locator('#open-sub2-push-config').click()
        expect(page.locator('#login-sub2-admin-key')).to_have_value('fixture-sub2-key')
        expect(page.locator('[data-sub2-group-id="7"]')).to_be_checked()
        page.keyboard.press('Escape')

        # Session conversion uses the same CPA payload as the local export.
        page.locator('.top-nav [data-format="sub2api"]').click()
        page.route('**/api/session-health', lambda route: route.fulfill(status=200, content_type='application/json', body=json.dumps({'results': [{'status': 200}]})))
        session = {'email': 'fixture@example.com', 'accessToken': 'fixture-session-access', 'refresh_token': 'fixture-session-rt', 'account': {'id': 'session'}}
        page.locator('#session-input').fill(json.dumps(session))
        expect(page.locator('#push-converted')).to_be_enabled()
        page.locator('#push-converted').click()
        expect(page.locator('#push-status')).to_contain_text('成功 1，失败 0')
        expect(page.locator('#push-converted')).to_be_enabled()
        assert calls[-1][2]['refresh_token'] == 'fixture-session-rt'
        assert calls[-1][2]['type'] == 'codex'

        # Session-to-Sub2API must preserve real RTs and also allow AT-only input.
        page.locator('input[name="push-target"][value="sub2api"]').check()
        for has_refresh in [True, False]:
            conversion = {**session, 'id_token': 'fixture.id.signature'}
            if not has_refresh:
                del conversion['refresh_token']
            page.locator('#session-input').fill(json.dumps(conversion))
            page.locator('#push-converted').click()
            expect(page.locator('#push-converted')).to_be_enabled()
            expect(page.locator('#push-status')).to_contain_text('成功 1，失败 0')
            credentials = calls[-1][2]['accounts'][0]['credentials']
            assert credentials['access_token'] == 'fixture-session-access'
            assert credentials.get('refresh_token') == ('fixture-session-rt' if has_refresh else None)
            assert credentials['id_token'] == 'fixture.id.signature'
            if has_refresh:
                exercise_saved_conversion(page)

        page.locator('input[name="push-target"][value="none"]').check()
        page.locator('.top-nav [data-format="protocol-login"]').click()
        page.wait_for_timeout(350)
        exercise_clear_login(page)

        # Clearing while a push is pending cancels it and never revives keys/results.
        fresh = page.context.browser.new_context()
        try:
            clean = fresh.new_page()
            pending = []
            clean.route('**/api/push/cpa', lambda route: pending.append(route))
            clean.route('**/api/session-health', lambda route: route.fulfill(status=200, content_type='application/json', body=json.dumps({'results': [{'status': 200}]})))
            clean.goto(page.url)
            clean.locator('#open-cpa-push-config').click()
            clean.locator('#cpa-base-url').fill(remote_url)
            clean.locator('#cpa-management-key').fill('fixture-cpa-key')
            clean.locator('#save-cpa-config').click()
            expect(clean.locator('#cpa-config-status')).to_contain_text('已加密保存')
            clean.keyboard.press('Escape')
            clean.locator('input[name="push-target"][value="cpa"]').check()
            clean.locator('#session-input').fill(json.dumps(session))
            clean.locator('#push-converted').click()
            expect(clean.locator('#push-status')).to_contain_text('正在推送')
            clean.locator('#clear-login-data').click()
            expect(clean.locator('#browser-storage-status')).to_contain_text('登录数据已清空，配置已保留')
            for route in pending:
                route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'imported': 1, 'results': [{'name': 'stale', 'status': 'success'}]}))
            expect(clean.locator('input[name="push-target"][value="cpa"]')).to_be_enabled()
            expect(clean.locator('#push-feedback')).to_be_hidden()
            expect(clean.locator('#session-input')).to_have_value('')
            saved = clean.evaluate('async () => JSON.stringify(await browserWorkspace.read())')
            assert 'fixture-cpa-key' in saved and 'fixture-session-rt' not in saved and 'stale' not in saved
            clean.once("dialog", lambda dialog: dialog.accept())
            clean.locator('#clear-browser-data').click()
            expect(clean.locator('#browser-storage-status')).to_contain_text('所有数据已清空')
            assert 'fixture-cpa-key' not in clean.evaluate('async () => JSON.stringify((await browserWorkspace.read()) || {})')
        finally:
            fresh.close()
    finally:
        login_plans.pop('free-workspace', None)
        login_plans.update(personal='plus', business='business')
        page.remove_listener('request', record)
        remote.shutdown()
        remote.server_close()
    print('Browser push: non-free auto-push, free downloads, opt-out, Sub2API/CPA dialogs, encrypted settings, workspace isolation, partial retry: PASS')


def exercise_saved_conversion(source):
    source.wait_for_timeout(350)  # Wait for the completed push snapshot to persist.
    snapshot = source.evaluate('() => browserWorkspace.read()')
    assert snapshot['state']['converted'][0]['cpa']['refresh_token'] == 'fixture-session-rt'
    for item in snapshot['state']['converted']:
        item['sub2apiAccount']['credentials'].pop('refresh_token', None)
        item['sub2apiAccount']['credentials'].pop('id_token', None)
    context = source.context.browser.new_context()
    try:
        page = context.new_page()
        page.route('**/workspace-test-seed', lambda route: route.fulfill(status=200, content_type='text/html', body='<script src="/browser-store.js"></script>'))
        page.goto(source.url.rstrip('/') + '/workspace-test-seed')
        page.evaluate('(snapshot) => browserWorkspace.save(snapshot)', snapshot)
        page.goto(source.url)
        expect(page.locator('#output')).to_have_value(re.compile('fixture-session-rt'))
        credentials = json.loads(page.locator('#output').input_value())['accounts'][0]['credentials']
        assert credentials['refresh_token'] == 'fixture-session-rt'
        assert credentials['id_token'] == 'fixture.id.signature'
        sent = []
        def capture_push(route):
            sent.append(route.request.post_data_json['accounts'][0]['credentials'])
            route.fulfill(status=200, content_type='application/json', body='{"ok":true,"imported":1,"results":[{"index":0,"status":"success"}]}')
        page.route('**/api/push/sub2api', capture_push)
        page.locator('#push-converted').click()
        expect(page.locator('#push-status')).to_contain_text('成功 1，失败 0')
        assert sent[0]['refresh_token'] == 'fixture-session-rt'
        assert sent[0]['id_token'] == 'fixture.id.signature'
    finally:
        context.close()


def exercise_clear_login(source):
    snapshot = source.evaluate('() => browserWorkspace.read()')
    assert snapshot['state']['browserAccounts'] and snapshot['state']['sessions']
    context = source.context.browser.new_context()
    try:
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/api/session-health', lambda route: route.fulfill(status=200, content_type='application/json', body='{"results": []}'))
        # Seed storage without mounting an empty app whose pagehide save could
        # overwrite the fixture while navigating to the real UI.
        page.route('**/workspace-test-seed', lambda route: route.fulfill(status=200, content_type='text/html', body='<script src="/browser-store.js"></script>'))
        page.goto(source.url.rstrip('/') + '/workspace-test-seed')
        page.wait_for_function("() => !!window.browserWorkspace")
        page.evaluate('(snapshot) => browserWorkspace.save(snapshot)', snapshot)
        page.goto(source.url)
        page.get_by_role('radio', name='本地代理', exact=True).check()
        page.locator('#login-proxy-local-port').fill('8899')
        page.evaluate("""async () => {
            for (let i = 0; i < 100; i++) {
                if ((await browserWorkspace.read())?.state?.loginProxyLocalPort === 8899) return;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error('Proxy configuration was not saved');
        }""")
        network = page.evaluate("async () => { const s = (await browserWorkspace.read()).state; return [s.loginProxyMode, s.loginProxyLocalPort, s.browserSettings.protocolSettings.proxyMode, s.browserSettings.protocolSettings.localProxyPort]; }")
        assert network == ['local', 8899, 'local', 8899], network
        peer = context.new_page()
        peer.goto(source.url)
        expect(peer.locator('#login-accounts')).to_have_value('fixture@example.com----FixturePassword!----JBSWY3DPEHPK3PXP')
        expect(peer.locator('#login-proxy-local-port')).to_have_value('8899')
        expect(peer.get_by_role('radio', name='本地代理', exact=True)).to_be_checked()
        page.locator('#clear-login-data').click()
        expect(page.locator('#browser-storage-status')).to_have_text('登录数据已清空，配置已保留')
        expect(peer.locator('#browser-storage-status')).to_contain_text('清空登录数据')
        expect(peer.locator('#login-accounts')).to_have_value('')
        expect(peer.locator('#session-input')).to_have_value('')
        expect(peer.locator('#start-protocol-login')).to_be_disabled()
        expect(page.locator('#start-protocol-login')).to_be_enabled()
        for check_page in [page, peer]:
            expect(check_page.locator('#login-proxy-pool')).to_have_value('custom.example:3000:fixture:password')
            expect(check_page.locator('#login-proxy-local-port')).to_have_value('8899')
            expect(check_page.locator('#cpa-management-key')).to_have_value('fixture-cpa-key')
            expect(check_page.locator('#login-sub2-admin-key')).to_have_value('fixture-sub2-key')
        saved = page.evaluate('() => browserWorkspace.read()')
        raw = json.dumps(saved)
        for secret in ['FixturePassword!', 'JBSWY3DPEHPK3PXP', 'fixture@example.com', 'fixture-personal-rt', 'fixture-business-rt', 'fixture-session-rt', 'fixture-session-access']:
            assert secret not in raw, secret
        assert saved['state']['browserAccounts'] == [] and saved['state']['sessions'] == []
        assert saved['state']['loginProgress'] == [] and saved['state']['pushResults'] == []
        assert saved['state']['pushRetry'] is None
        assert saved['state']['browserSettings']['sub2apiSettings']['groupIds'] == [7]
        assert saved['state']['cpaSettings']['managementKey'] == 'fixture-cpa-key'
        page.reload()
        expect(page.locator('#login-accounts')).to_have_value('')
        expect(page.locator('#session-input')).to_have_value('')
        expect(page.locator('#export-login-personal')).to_be_disabled()
        expect(page.get_by_role('radio', name='本地代理', exact=True)).to_be_checked()
        page.locator('#open-sub2-push-config').click()
        expect(page.locator('[data-sub2-group-id="7"]')).to_be_checked()
        expect(page.locator('#login-sub2-admin-key')).to_have_value('fixture-sub2-key')
        page.keyboard.press('Escape')
        page.once("dialog", lambda dialog: dialog.accept())
        page.locator('#clear-browser-data').click()
        expect(page.locator('#browser-storage-status')).to_have_text('所有数据已清空')
        expect(page.locator('#login-proxy-pool')).to_have_value('')
        expect(page.locator('#login-sub2-admin-key')).to_have_value('')
        expect(page.locator('#cpa-management-key')).to_have_value('')
        assert page.evaluate('async () => (await browserWorkspace.read()) === undefined')
        assert not errors, errors
    finally:
        context.close()
