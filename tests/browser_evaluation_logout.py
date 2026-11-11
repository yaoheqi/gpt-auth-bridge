"""Account-wide logout and non-personal login controls, with synthetic credentials."""
import json
from pathlib import Path
from playwright.sync_api import expect


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
