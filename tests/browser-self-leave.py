"""Self-leave UI tests use synthetic accounts and never contact ChatGPT."""
from playwright.sync_api import expect


def check_self_leave(browser, url):
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    page = context.new_page()
    errors, writes, held = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: writes.append(request.url) if request.method == 'POST' else None)
    hold = [False]

    def leave(route):
        body = route.request.post_data_json
        assert body['confirmed'] is True
        assert body['proxyMode'] == 'local' and body['localProxyPort'] == 17890
        snapshot = body['browserState']
        assert 'fixture-key' not in str(snapshot)
        results = []
        for account in snapshot['accounts']:
            success = account['email'].startswith('left@')
            if success:
                account.update(business_workspace_credentials=[], business_openai_rt='', business_workspace_id='', business_openai_account_id='', storage_state_json='')
            results.append({'id': account['id'], 'email': account['email'], 'ok': success, 'left': int(success),
                            'unconfirmed': int(not success), 'failed': 0, 'skipped': 0,
                            'workspaces': [{'workspaceId': 'team', 'status': 'left' if success else 'unconfirmed'}]})
        events = [('account_start', {'id': account['id'], 'email': account['email']}) for account in snapshot['accounts']]
        events += [('account_done', result) for result in results]
        events += [('browser_state', snapshot), ('summary', {'ok': True, 'results': results, 'success': 1, 'failed': 1, 'left': 1, 'unconfirmed': 1, 'concurrency': 10})]
        import json
        payload = ''.join(f'event: {name}\ndata: {json.dumps(data)}\n\n' for name, data in events)
        if hold[0]:
            held.append((route, payload))
        else:
            route.fulfill(content_type='text/event-stream', body=payload)

    context.route('**/api/v2/accounts/self-leave', leave)
    try:
        page.goto(url)
        page.locator('.top-nav [data-format="protocol-login"]').click()
        kick = page.locator('#self-leave-workspaces').bounding_box()
        reset = page.locator('#reset-login-totp').bounding_box()
        assert kick['x'] == reset['x'] and kick['y'] + kick['height'] <= reset['y']
        accounts = [{'id': name, 'email': name + '@example.com', 'password': 'fixture-password', 'two_factor_secret': 'JBSWY3DPEHPK3PXP',
                     'openai_rt': 'personal-rt', 'business_workspace_id': 'team', 'business_openai_rt': 'team-rt',
                     'business_workspace_credentials': [{'workspaceId': 'team', 'refreshToken': 'team-rt', 'accessToken': 'fixture-at', 'status': 'rt_ready'}]}
                    for name in ['left', 'pending']]
        page.evaluate(r'''async accounts => {
            await browserWorkspace.save({state: {format:'protocol-login', browserAccounts:accounts,
                loginPersonalIds: ['left','pending'], loginBusinessIds: ['left','pending'],
                cpaSettings:{baseUrl:'https://cpa.fixture',managementKey:'fixture-key'},
                loginProxyMode:'local',loginProxyLocalPort:17890},
                fields:[{name:'push-target',value:'cpa',type:'radio',checked:true},
                {id:'login-accounts',value:accounts.map(a=>[a.email,a.password,a.two_factor_secret].join('----')).join('\n')}]});
        }''', accounts)
        page.reload()
        page.once('dialog', lambda dialog: dialog.dismiss())
        page.locator('#self-leave-workspaces').click()
        assert not writes
        page.once('dialog', lambda dialog: dialog.accept())
        page.locator('#self-leave-workspaces').click()
        expect(page.locator('#login-status')).to_contain_text('已确认退出 1 个工作区，1 个待确认')
        page.wait_for_function("async () => (await browserWorkspace.read()).state.loginBusinessIds.length === 1")
        saved = page.evaluate('() => browserWorkspace.read()')['state']
        assert saved['monitorStopped'] == {'pending': 'self_leave_pending'}
        assert saved['loginBusinessIds'] == ['pending'], {'ids': saved['loginBusinessIds'], 'accounts': [(row['id'], bool(row.get('business_openai_rt')), len(row.get('business_workspace_credentials', []))) for row in saved['browserAccounts']]}
        assert saved['browserAccounts'][0]['business_workspace_credentials'] == []
        assert saved['browserAccounts'][0]['openai_rt'] == 'personal-rt'
        assert not any('/api/push/' in path for path in writes)
        expect(page.locator('#start-protocol-login')).to_be_enabled()
        expect(page.locator('#reset-login-totp')).to_be_enabled()
        page.reload()
        expect(page.locator('#monitor-skipped-list')).to_contain_text('自踢结果待确认')
        # Data deletion must abort the task and reject any response arriving later.
        hold[0] = True
        page.once('dialog', lambda dialog: dialog.accept())
        page.locator('#self-leave-workspaces').click()
        page.wait_for_timeout(300)
        assert held
        expect(page.locator('#start-protocol-login')).to_be_disabled()
        expect(page.locator('#reset-login-totp')).to_be_disabled()
        page.locator('#clear-login-data').click()
        expect(page.locator('#browser-storage-status')).to_have_text('登录数据已清空，配置已保留')
        for route, payload in held:
            route.fulfill(content_type='text/event-stream', body=payload)
        page.wait_for_timeout(300)
        assert page.evaluate('async () => (await browserWorkspace.read()).state.browserAccounts') == []
        expect(page.locator('#self-leave-workspaces')).to_be_enabled()
        for width in [390, 320]:
            page.set_viewport_size({'width': width, 'height': 900})
            kick = page.locator('#self-leave-workspaces').bounding_box()
            reset = page.locator('#reset-login-totp').bounding_box()
            assert kick['y'] + kick['height'] <= reset['y']
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert not errors, errors
    finally:
        context.close()
    print('Browser self-leave: confirmation, own account input, proxy selection, partial results, persisted skip, local credential cleanup and cancellation: PASS')
