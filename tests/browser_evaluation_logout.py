"""Account-wide logout and non-personal login controls, with synthetic credentials."""
import json
from pathlib import Path
from playwright.sync_api import expect


def check_evaluation_logout(browser, url):
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    page = context.new_page()
    errors, calls, pending = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    fixtures = [{'email': 'shared@example.com' if name.startswith('shared') else 'wrong@example.com' if name.startswith('wrong') else name + '@example.com',
                 'access_token': name + '-token', 'refresh_token': name + '-refresh', 'account_id': name,
                 'plan_type': 'free' if name == 'free' else 'plus'}
                for name in ['shared-pass', 'shared-wrong', 'wrong-one', 'wrong-two', 'failed', 'invalid', 'free', 'unhealthy']]
    linked = {'id': 'linked', 'email': 'linked@example.com', 'password': 'fixture-password', 'two_factor_secret': 'JBSWY3DPEHPK3PXP',
              'openai_access_token': 'linked-token', 'openai_rt': 'linked-refresh', 'openai_account_id': 'linked'}

    def evaluate(route):
        account = route.request.post_data_json['account']['accountId']
        event = {'type': 'error', 'error': 'fixture request failure'} if account == 'failed' else {
            'type': 'complete', 'status': 'passed' if account == 'shared-pass' else 'invalid_format' if account == 'invalid' else 'wrong_answer', 'output': 'fixture'}
        route.fulfill(content_type='text/event-stream', body='data: ' + json.dumps(event) + '\n\n')

    def logout_linked(route):
        body = route.request.post_data_json
        calls.append(body)
        assert body['ids'] == ['linked'] and body['confirmed'] is True
        snapshot = body['browserState']
        snapshot['accounts'][0].update(openai_access_token='', openai_rt='', session_access_token='', storage_state_json='')
        row = {'id': 'linked', 'email': 'linked@example.com', 'ok': True}
        events = [('browser_state', snapshot), ('account_done', row), ('summary', {'results': [row], 'success': 1, 'failed': 0})]
        route.fulfill(content_type='text/event-stream', body=''.join(f'event: {name}\ndata: {json.dumps(data)}\n\n' for name, data in events))

    def logout_manual(route):
        calls.append(route.request.post_data_json)
        pending.append(route)

    def finish(partial):
        route = pending.pop(0)
        rows = [{'index': account['index'], 'ok': not (partial and account['accountId'] == 'failed'), 'error': 'fixture logout failure'}
                for account in route.request.post_data_json['accounts']]
        route.fulfill(json={'results': rows})

    context.route('**/api/session-health', lambda route: route.fulfill(json={'results': [
        {'status': 401 if account['accountId'] == 'unhealthy' else 200} for account in route.request.post_data_json['accounts']]}))
    context.route('**/api/model-evaluation', evaluate)
    context.route('**/api/v2/accounts/protocol-logout-all', logout_linked)
    context.route('**/api/logout-all-sessions', logout_manual)
    try:
        page.goto(url)
        page.wait_for_load_state('networkidle')
        page.evaluate('''async ({linked, fixtures}) => browserWorkspace.save({state:{format:'model-evaluation',browserAccounts:[linked],
            loginPersonalIds:['linked'],loginBusinessIds:['linked'],loginSessionIds:['linked']},
            fields:[{id:'session-input',value:JSON.stringify({accounts:fixtures,proxies:[{name:'retained-proxy'}],version:1})}]})''', {'linked': linked, 'fixtures': fixtures})
        page.reload()
        button = page.locator('#evaluation-logout-failed')
        start = page.locator('[data-evaluation-start]')
        expect(start).to_be_enabled()
        expect(button).to_be_disabled()
        start.click()
        expect(page.locator('#evaluation-status')).to_contain_text('测试完成')
        expect(button).to_have_text('退出非答案正确账号会话（4）')
        page.once('dialog', lambda dialog: dialog.dismiss())
        button.click()
        assert not calls
        page.once('dialog', lambda dialog: dialog.accept())
        button.click()
        expect(button).to_be_disabled()
        expect(start).to_be_disabled()
        page.wait_for_function('() => document.querySelector("#evaluation-logout-status").textContent.includes("正在退出")')
        # Let the linked browser-state save complete before checking the manual request.
        for _ in range(100):
            if pending:
                break
            page.wait_for_timeout(50)
        assert len(pending) == 1, calls
        assert {row['accountId'] for row in calls[1]['accounts']} == {'wrong-one', 'failed', 'invalid'}
        finish(True)
        expect(page.locator('#evaluation-logout-status')).to_contain_text('成功 3，失败 1')
        expect(button).to_have_text('退出非答案正确账号会话（1）')
        saved = page.evaluate('() => browserWorkspace.read()')['state']
        assert saved['monitorStopped']['linked'] == 'sessions_logged_out'
        assert not saved['browserAccounts'][0]['openai_access_token']
        assert all(not saved[key] for key in ['loginPersonalIds', 'loginBusinessIds', 'loginSessionIds'])
        assert 'wrong-one-token' not in saved['conversionInput']['text']
        assert 'wrong-two-token' not in saved['conversionInput']['text']
        assert 'shared-wrong-token' in saved['conversionInput']['text']
        assert json.loads(saved['conversionInput']['text'])['proxies'] == [{'name': 'retained-proxy'}]
        output = Path(__file__).resolve().parents[1] / 'output' / 'evaluation-logout'
        output.mkdir(parents=True, exist_ok=True)
        for width in [1440, 390]:
            page.set_viewport_size({'width': width, 'height': 1000})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(output / f'logout-{width}.png'), full_page=True)
        page.once('dialog', lambda dialog: dialog.accept())
        button.click()
        for _ in range(100):
            if pending:
                break
            page.wait_for_timeout(50)
        assert [row['accountId'] for row in calls[-1]['accounts']] == ['failed']
        finish(False)
        expect(page.locator('#evaluation-logout-status')).to_contain_text('成功 1，失败 0')
        expect(button).to_be_disabled()
        expect(page.locator('#evaluation-push-passed')).to_contain_text('（1）')
        page.locator('input[name="evaluation-source"][value="api"]').check()
        expect(button).to_be_disabled()
        page.reload()
        saved = page.evaluate('() => browserWorkspace.read()')['state']
        assert 'failed-token' not in saved['conversionInput']['text']
        assert not errors, errors
    finally:
        context.close()
    print('Evaluation logout: protected passing siblings, deduplicated owners, request failures, partial retry, cache cleanup and responsive layout: PASS')


def check_non_personal_control(browser, url):
    context = browser.new_context(viewport={'width': 1680, 'height': 1000})
    page = context.new_page()
    calls, errors = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))

    def pipeline(route):
        body = route.request.post_data_json
        calls.append(body)
        assert body['requireNonPersonal'] is True
        row = {'id': body['ids'][0], 'email': 'login@example.com', 'ok': True,
               'personalOk': False, 'businessSuccess': 1 if body['workspaceMode'] == 'all' else 0, 'sessionOk': body['workspaceMode'] == 'session'}
        events = [('account_done', row), ('summary', {'ok': True, 'results': [row], 'success': 1, 'failed': 0})]
        route.fulfill(content_type='text/event-stream', body=''.join(f'event: {name}\ndata: {json.dumps(data)}\n\n' for name, data in events))

    context.route('**/api/v2/accounts/protocol-login-pipeline', pipeline)
    try:
        page.goto(url)
        page.wait_for_load_state('networkidle')
        page.locator('[data-format="protocol-login"]').click()
        checkbox = page.locator('#login-require-non-personal')
        expect(checkbox).to_be_visible()
        label = page.locator('#login-non-personal-filter').bounding_box()
        monitor = page.locator('.monitor-controls').bounding_box()
        assert label['x'] < monitor['x'] and abs(label['y'] - monitor['y']) < 20
        checkbox.check()
        expect(page.locator('#login-mode-description')).to_contain_text('最多尝试三次')
        page.locator('#login-accounts').fill('login@example.com----fixture-password----JBSWY3DPEHPK3PXP')
        page.locator('#start-protocol-login').click()
        expect(page.locator('#login-status')).to_contain_text('完成')
        assert calls[0]['workspaceMode'] == 'all'
        expect(page.locator('#login-workbench')).to_contain_text('个人 0 个，工作区 1 个')
        page.reload()
        expect(checkbox).to_be_checked()
        page.locator('input[name="login-workspace-mode"][value="session"]').check()
        page.locator('#start-protocol-login').click()
        expect(page.locator('#login-status')).to_contain_text('完成')
        assert len(calls) == 2 and calls[1]['workspaceMode'] == 'session'
        assert not errors, errors
    finally:
        context.close()
    print('Non-personal control: placement, persistence, descriptions and both pipeline modes: PASS')
