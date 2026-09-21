"""Minute scheduling with a virtual clock; all external operations use fixtures."""
import base64
from datetime import datetime, timezone
import json
import time
from playwright.sync_api import expect


def token(name, plan='plus'):
    claims = {'exp': 2100000000, 'https://api.openai.com/auth': {'chatgpt_account_id': name, 'chatgpt_plan_type': plan}}
    return 'e30.' + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=') + '.fixture'


def check_session_monitor(browser, url):
    check_monitor_config_gate(browser, url)
    for target in ['sub2api', 'cpa']:
        context = browser.new_context()
        calls, errors = [], []
        failing = [False]
        terminal = [False]
        healthy = [False]
        holding, held = [False], []

        def route_api(route):
            path = route.request.url.split('/api/', 1)[1]
            body = route.request.post_data_json
            calls.append((path, body))
            snapshot = body.get('browserState')
            if path.endswith('/session-probe'):
                assert body['proxyMode'] == 'builtin'
                assert 'fixture-key' not in json.dumps(snapshot)
                results = [{'id': account['id'], 'sessionInvalid': bool(account.get('session_access_token')) and account['id'] == 'web',
                            'health': ('alive' if healthy[0] and account['id'] in ['invalid', 'free', 'web'] else
                                       {'invalid': 'session_invalid', 'free': 'session_invalid', 'web': 'session_invalid', 'network': 'probe_failed', 'disabled': 'deactivated'}.get(account['id'], 'alive'))}
                           for account in snapshot['accounts']]
                if holding[0]:
                    held.append((route, {'ok': True, 'results': results, 'browserState': snapshot}))
                    return
                route.fulfill(json={'ok': True, 'results': results, 'browserState': snapshot})
            elif path.endswith('/protocol-login-pipeline'):
                assert body['proxyMode'] == 'builtin'
                assert body['workspaceMode'] == 'all'
                results = []
                for account in snapshot['accounts']:
                    ok = not failing[0]
                    if ok:
                        if body['workspaceMode'] == 'session':
                            account['session_access_token'] = 'fresh-web'
                        else:
                            account['openai_access_token'] = token(account['id'])
                            account['openai_rt'] = 'fresh-rt'
                    results.append({'id': account['id'], 'ok': ok, 'sessionOk': body['workspaceMode'] == 'session' and ok,
                                    'personalOk': body['workspaceMode'] == 'all' and ok, 'businessSuccess': 0,
                                    **({'terminalReason': 'totp_invalid' if account['id'] == 'web' else 'password_invalid'}
                                       if terminal[0] and account['id'] in ['invalid', 'web'] else {})})
                events = [('browser_state', snapshot), ('summary', {'ok': True, 'results': results})]
                route.fulfill(content_type='text/event-stream', body=''.join(f'event: {name}\ndata: {json.dumps(data)}\n\n' for name, data in events))
            elif path.endswith('/export-sub2api'):
                accounts = []
                for account in snapshot['accounts']:
                    plan = 'free' if account['id'] == 'free' else 'plus'
                    accounts.append({'platform': 'openai', 'type': 'oauth', 'name': account['email'], 'credentials': {
                        'email': account['email'], 'chatgpt_account_id': account['id'], 'plan_type': plan,
                        'access_token': token(account['id'], plan), 'refresh_token': 'fresh-rt'}})
                route.fulfill(json={'ok': True, 'accounts': accounts})
            elif path == 'push/' + target:
                assert body['upsert'] is True
                assert len(body['accounts']) == 2  # Free stays downloadable, but isn't pushed.
                route.fulfill(json={'ok': True, 'imported': 2, 'failed': 0, 'results': [{'index': index, 'name': 'fixture', 'status': 'success'} for index in range(2)]})
            else:
                raise AssertionError(path)

        context.route('**/api/v2/accounts/session-probe', route_api)
        context.route('**/api/v2/accounts/protocol-login-pipeline', route_api)
        context.route('**/api/v2/accounts/export-sub2api', route_api)
        context.route('**/api/push/' + target, route_api)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        origin_time = datetime(2026, 9, 20, 12, tzinfo=timezone.utc)
        page.clock.install(time=origin_time)
        page.clock.pause_at(origin_time)
        try:
            page.goto(url)
            expect(page.locator('#task-concurrency-value')).to_have_text('10')
            page.clock.run_for(60_100)
            assert not calls
            accounts = [{'id': name, 'email': target + '-' + name + '@example.com', 'password': 'fixture-password', 'two_factor_secret': 'JBSWY3DPEHPK3PXP', 'openai_access_token': token(name)}
                        for name in ['alive', 'invalid', 'network', 'free', 'disabled', 'missing', 'web']]
            accounts[-1]['session_access_token'] = 'old-web'
            del accounts[-2]['password']
            page.evaluate('''async ({accounts, target}) => {
                await browserWorkspace.save({state: {browserAccounts: accounts,
                    browserSettings: {sub2apiSettings: {baseUrl: 'https://sub2.fixture', adminApiKey: 'fixture-key', groupIds:[7]}},
                    cpaSettings: {baseUrl: 'https://cpa.fixture', managementKey: 'fixture-key'}, loginProxyMode:'builtin'},
                    fields: [{name:'push-target', value:target, type:'radio', checked:true}]});
            }''', {'accounts': accounts, 'target': target})
            page.reload()
            expect(page.locator('input[name="session-monitor"][value="off"]')).to_be_checked()
            expect(page.locator('#session-monitor-status')).to_have_text('定时测活已关闭。')
            page.clock.run_for(60_100)
            assert not calls  # Eligible data alone must not enable monitoring.
            page.locator('input[name="session-monitor"][value="on"]').check()
            page.clock.run_for(500)
            expect(page.locator('#session-monitor-status')).to_contain_text('定时测活已开启 · 6 个账号')
            peer = context.new_page()
            peer.on('pageerror', lambda error: errors.append(str(error)))
            peer.goto(url)
            page.clock.run_for(59_000)
            assert not calls
            page.clock.run_for(1100)
            for _ in range(150):
                page.clock.run_for(50)
                if any('已检查' in item.locator('#session-monitor-status').inner_text() for item in [page, peer]):
                    break
                time.sleep(.02)
            if '已检查' in peer.locator('#session-monitor-status').inner_text():
                page, peer = peer, page
            expect(page.locator('#session-monitor-status')).to_contain_text('重登成功 3')
            expect(peer.locator('#start-protocol-login')).to_be_disabled()
            assert len([call for call in calls if call[0].endswith('/session-probe')]) == 1
            peer.close()
            probe = calls[0][1]
            assert set(probe['ids']) == {'alive', 'invalid', 'network', 'free', 'disabled', 'web'}
            pipelines = [body for path, body in calls if path.endswith('/protocol-login-pipeline')]
            assert [(row['workspaceMode'], set(row['ids'])) for row in pipelines] == [('all', {'invalid', 'free', 'web'})]
            saved = page.evaluate('() => browserWorkspace.read()')
            assert all(row['openai_rt'] == 'fresh-rt' for row in saved['state']['browserAccounts'] if row['id'] in ['invalid', 'free', 'web'])
            assert not saved['state']['monitorRetries']
            assert saved['state']['monitorStopped'] == {'disabled': 'account_unavailable'}
            assert not next(row for row in saved['state']['browserAccounts'] if row['id'] == 'web')['session_access_token']
            # A fresh RT must not keep causing logins because of the old Web Session.
            healthy[0] = True
            page.clock.run_for(60_000)
            for _ in range(100):
                page.clock.run_for(50)
                if '重登成功 0' in page.locator('#session-monitor-status').inner_text(): break
                time.sleep(.02)
            expect(page.locator('#session-monitor-status')).to_contain_text('重登成功 0')
            assert len([body for path, body in calls if path.endswith('/protocol-login-pipeline')]) == 1
            healthy[0] = False

            # A fully isolated browser has its own encryption keys, owner and local state.
            independent = browser.new_context()
            standby_calls = []
            independent.route('**/api/v2/accounts/session-probe', lambda route: (standby_calls.append(route.request.post_data_json), route_api(route)))
            independent.route('**/api/v2/accounts/protocol-login-pipeline', route_api)
            independent.route('**/api/v2/accounts/export-sub2api', route_api)
            independent.route('**/api/push/' + target, route_api)
            standby = independent.new_page()
            standby.clock.install(time=origin_time)
            standby.clock.pause_at(origin_time)
            standby.goto(url)
            # Do not copy monitorOwner: separate browsers generate separate owners.
            standby.evaluate('''async snapshot => {
                delete snapshot.state.monitorOwner;
                snapshot.state.monitorLastCheckAt = 0;
                await browserWorkspace.save(snapshot);
            }''', saved)
            standby.reload()
            standby.clock.run_for(60_100)
            for _ in range(150):
                standby.clock.run_for(50)
                if '其他浏览器负责' in standby.locator('#session-monitor-status').inner_text(): break
                time.sleep(.02)
            expect(standby.locator('#session-monitor-status')).to_contain_text('其他浏览器负责')
            assert not standby_calls
            page.locator('input[name="session-monitor"][value="off"]').check()
            page.clock.run_for(500)
            expect(page.locator('#session-monitor-status')).to_have_text('定时测活已关闭。')
            standby.clock.run_for(60_100)
            for _ in range(150):
                standby.clock.run_for(50)
                if '重登成功 3' in standby.locator('#session-monitor-status').inner_text(): break
                time.sleep(.02)
            expect(standby.locator('#session-monitor-status')).to_contain_text('重登成功 3')
            assert len(standby_calls) == 1
            standby.locator('input[name="session-monitor"][value="off"]').check()
            standby.clock.run_for(500)
            # Wait for release before closing this independent context.
            standby.wait_for_function('async () => (await browserWorkspace.read()).state.monitorEnabled === false')
            time.sleep(.1)
            independent.close()
            page.locator('input[name="session-monitor"][value="on"]').check()

            # Failed relogin uses a persisted backoff, including across page reloads.
            failing[0] = True
            page.clock.run_for(60_000)
            for _ in range(150):
                page.clock.run_for(50)
                if '重登失败' in page.locator('#session-monitor-status').inner_text(): break
                time.sleep(.02)
            expect(page.locator('#session-monitor-status')).to_contain_text('重登失败')
            before = len([call for call in calls if call[0].endswith('/protocol-login-pipeline')])
            page.reload()
            expect(page.locator('input[name="session-monitor"][value="on"]')).to_be_checked()
            page.clock.run_for(60_000)
            for _ in range(20):
                page.clock.run_for(100)
                time.sleep(.01)
            assert len([call for call in calls if call[0].endswith('/protocol-login-pipeline')]) == before

            # Terminal password/2FA rejection persists across reloads and is never retried.
            terminal[0] = True
            page.clock.run_for(5 * 60_000)
            for _ in range(150):
                page.clock.run_for(50)
                stopped = page.evaluate('async () => (await browserWorkspace.read()).state.monitorStopped')
                if stopped.get('invalid') == 'password_invalid' and stopped.get('web') == 'totp_invalid': break
                time.sleep(.02)
            assert stopped == {'disabled': 'account_unavailable', 'invalid': 'password_invalid', 'web': 'totp_invalid'}
            page.reload()
            page.clock.run_for(60_100)
            for _ in range(30):
                page.clock.run_for(50)
                time.sleep(.02)
            last_probe = [body for path, body in calls if path.endswith('/session-probe')][-1]
            assert not set(last_probe['ids']) & {'disabled', 'invalid', 'web'}
            expect(page.locator('#monitor-skipped')).to_be_visible()
            expect(page.locator('#monitor-skipped-list')).to_contain_text('密码错误')
            expect(page.locator('#monitor-skipped-list')).to_contain_text('2FA 凭据错误')

            # Clear confirmation cancellation preserves the saved configuration and accounts.
            page.once('dialog', lambda dialog: dialog.dismiss())
            page.locator('#clear-browser-data').click()
            assert page.evaluate('async () => (await browserWorkspace.read()).state.browserAccounts.length') == 7
            # Selecting no target stops scheduling immediately.
            page.locator('input[name="push-target"][value="none"]').check()
            expect(page.locator('input[name="session-monitor"][value="off"]')).to_be_checked()
            page.clock.run_for(1000)
            before = len(calls)
            page.clock.run_for(60_000)
            assert len(calls) == before
            # Clearing while a probe is in flight aborts the cycle and rejects late snapshots.
            holding[0] = True
            page.locator('input[name="push-target"][value="' + target + '"]').check()
            expect(page.locator('input[name="session-monitor"][value="off"]')).to_be_checked()
            page.locator('input[name="session-monitor"][value="on"]').check()
            page.clock.run_for(60_000)
            for _ in range(100):
                page.clock.run_for(50)
                if held: break
                time.sleep(.01)
            assert held
            page.locator('#clear-login-data').click()
            expect(page.locator('#browser-storage-status')).to_have_text('登录数据已清空，配置已保留')
            for route, body in held: route.fulfill(json=body)
            page.clock.run_for(1000)
            before = len(calls)
            page.clock.run_for(120_000)
            assert len(calls) == before
            retained = page.evaluate('() => browserWorkspace.read()')
            assert retained['state']['browserAccounts'] == []
            assert 'fixture-key' in json.dumps(retained)
            expect(page.locator('#start-protocol-login')).to_be_enabled()
            page.once('dialog', lambda dialog: dialog.accept())
            page.locator('#clear-browser-data').click()
            expect(page.locator('#browser-storage-status')).to_have_text('所有数据已清空')
            page.clock.run_for(120_000)
            assert len(calls) == before
            assert page.evaluate('async () => (await browserWorkspace.read()) === undefined')
            assert not errors, errors
        finally:
            context.close()
    print('Browser monitor: opt-in, minute scheduling, isolated browser leases and takeover, terminal credential skips, multi-tab exclusion, persisted backoff and clear cancellation: PASS')


def check_monitor_config_gate(browser, url):
    context = browser.new_context()
    page = context.new_page()
    try:
        page.goto(url)
        expect(page.locator('#task-concurrency-value')).to_have_text('10')
        cases = [
            ('none', {}, {}),
            ('sub2api', {'baseUrl': 'https://sub2.fixture', 'adminApiKey': 'fixture-key'}, {}),
            ('sub2api', {}, {'baseUrl': 'https://cpa.fixture', 'managementKey': 'fixture-key'}),
            ('cpa', {}, {'baseUrl': 'https://cpa.fixture'}),
            ('cpa', {}, {'baseUrl': 'https://cpa.fixture', 'managementKey': ' '}),
        ]
        for target, sub2api, cpa in cases:
            page.evaluate('''async ({target, sub2api, cpa}) => {
                await browserWorkspace.save({state:{format:'protocol-login', browserSettings:{sub2apiSettings:sub2api},cpaSettings:cpa},
                    fields:[{name:'push-target',value:target,type:'radio',checked:true}]});
            }''', {'target': target, 'sub2api': sub2api, 'cpa': cpa})
            page.reload()
            page.locator('input[name="session-monitor"][value="on"]').click()
            expect(page.locator('input[name="session-monitor"][value="off"]')).to_be_checked()
            expect(page.locator('#login-status')).to_contain_text('测活未开启')
            page.wait_for_function('async () => (await browserWorkspace.read()).state.monitorEnabled === false')
    finally:
        context.close()
