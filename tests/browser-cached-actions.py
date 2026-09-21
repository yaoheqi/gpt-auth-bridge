"""Sequential reset/logout regression with synthetic accounts and mocked upstream actions."""
import json
from playwright.sync_api import expect


def check_cached_actions(browser, url):
    context = browser.new_context()
    page = context.new_page()
    errors, calls = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    old_secret, new_secret = 'JBSWY3DPEHPK3PXP', 'KRSXG5DSNFXGOIDB'
    accounts = [{'id': name, 'email': name + '@example.com', 'password': 'fixture-password',
                 'two_factor_secret': old_secret, 'session_access_token': 'cached-session-' + name,
                 'storage_state_json': '{"cookies":[]}', 'openai_rt': 'fixture-rt', 'business_openai_rt': 'fixture-team-rt'}
                for name in ['reset-ok', 'reset-failed']]

    def operation(route):
        body = route.request.post_data_json
        action = route.request.url.rsplit('/', 1)[1]
        calls.append(action)
        assert body['proxyMode'] == 'local' and body['localProxyPort'] == 17890
        snapshot = body['browserState']
        rows = snapshot['accounts']
        first = next(row for row in rows if row['id'] == 'reset-ok')
        second = next(row for row in rows if row['id'] == 'reset-failed')
        assert second['two_factor_secret'] == old_secret
        assert first['session_access_token'] == ('cached-session-reset-ok' if action == 'reset-totp' else 'post-reset-session')
        if action == 'reset-totp':
            first.update(two_factor_secret=new_secret, session_access_token='post-reset-session',
                         storage_state_json='{"cookies":[{"name":"fixture","value":"post-reset"}]}')
        else:
            assert body['confirmed'] is True
            assert first['two_factor_secret'] == new_secret
            assert 'post-reset' in first['storage_state_json']
            first.update(session_access_token='', session_json='', storage_state_json='', openai_rt='',
                         openai_access_token='', business_openai_rt='', business_workspace_credentials=[])
        results = [{'id': first['id'], 'email': first['email'], 'ok': True, 'credentials': {'line': '[REDACTED]'}},
                   {'id': second['id'], 'email': second['email'], 'ok': False, 'error': 'fixture HTTP 429'}]
        events = [('account_start', {'id': row['id'], 'email': row['email']}) for row in rows]
        events += [('browser_state', snapshot)]
        events += [('account_done', result) for result in results]
        events += [('summary', {'ok': False, 'results': results, 'success': 1, 'failed': 1, 'concurrency': 10})]
        route.fulfill(content_type='text/event-stream', body=''.join(f'event: {name}\ndata: {json.dumps(data)}\n\n' for name, data in events))

    context.route('**/api/v2/accounts/reset-totp', operation)
    context.route('**/api/v2/accounts/protocol-logout-all', operation)
    try:
        page.goto(url)
        page.wait_for_function('() => !!window.browserWorkspace')
        page.evaluate('''async accounts => {
            await browserWorkspace.save({state:{format:'protocol-login',browserAccounts:accounts,
                loginSessionIds:accounts.map(a=>a.id),loginPersonalIds:accounts.map(a=>a.id),loginBusinessIds:accounts.map(a=>a.id),
                loginProxyMode:'local',loginProxyLocalPort:17890,cpaSettings:{baseUrl:'https://cpa.fixture',managementKey:'fixture-key'}},
                fields:[{id:'login-accounts',value:accounts.map(a=>[a.email,a.password,a.two_factor_secret].join('----')).join('\\n')}]});
        }''', accounts)
        page.reload()
        page.once('dialog', lambda dialog: dialog.accept())
        page.locator('#reset-login-totp').click()
        expect(page.locator('#login-status')).to_contain_text('2FA 换绑完成：成功 1，失败 1')
        updated_input = f'reset-ok@example.com----fixture-password----{new_secret}\nreset-failed@example.com----fixture-password----{old_secret}'
        expect(page.locator('#login-accounts')).to_have_value(updated_input)
        expect(page.locator('#login-reset-credentials')).to_have_text(f'reset-ok@example.com----fixture-password----{new_secret}')
        expect(page.locator('#protocol-logout-all')).to_be_enabled()
        page.reload()
        expect(page.locator('#login-accounts')).to_have_value(updated_input)
        saved = page.evaluate('() => browserWorkspace.read()')['state']
        first = next(row for row in saved['browserAccounts'] if row['id'] == 'reset-ok')
        assert first['session_access_token'] == 'post-reset-session'
        assert first['two_factor_secret'] == new_secret
        page.once('dialog', lambda dialog: dialog.dismiss())
        page.locator('#protocol-logout-all').click()
        assert calls == ['reset-totp']
        page.once('dialog', lambda dialog: dialog.accept())
        page.locator('#protocol-logout-all').click()
        expect(page.locator('#login-status')).to_contain_text('退出全部会话完成：成功 1，失败 1')
        page.wait_for_function("async () => (await browserWorkspace.read()).state.monitorStopped['reset-ok'] === 'sessions_logged_out'")
        saved = page.evaluate('() => browserWorkspace.read()')['state']
        assert saved['loginSessionIds'] == ['reset-failed']
        assert saved['loginPersonalIds'] == ['reset-failed']
        assert saved['loginBusinessIds'] == ['reset-failed']
        first = next(row for row in saved['browserAccounts'] if row['id'] == 'reset-ok')
        assert not first['session_access_token'] and not first['storage_state_json']
        assert first['two_factor_secret'] == new_secret
        assert saved['cpaSettings']['managementKey'] == 'fixture-key'
        expect(page.locator('#reset-login-totp')).to_be_enabled()
        expect(page.locator('#self-leave-workspaces')).to_be_enabled()
        assert calls == ['reset-totp', 'protocol-logout-all']
        assert not errors, errors
    finally:
        context.close()
    print('Cached actions: reset updates input and encrypted snapshot; logout reuses it after reload, invalidates exports and stops monitor: PASS')
