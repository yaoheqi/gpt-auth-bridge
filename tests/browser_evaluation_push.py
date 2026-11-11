"""Push only correct model-test accounts, using synthetic credentials and mocked APIs."""
import json
from pathlib import Path

from playwright.sync_api import expect


def check_evaluation_push(browser, url):
    context = browser.new_context(viewport={'width': 1440, 'height': 900})
    page = context.new_page()
    errors, evaluations, pushes, pending = [], [], [], []
    all_wrong = False
    page.on('pageerror', lambda error: errors.append(str(error)))
    fixtures = [{'email': 'shared@example.com' if name.startswith('passed') else name + '@example.com',
                 'account_id': name, 'access_token': name + '-token', 'refresh_token': name + '-refresh',
                 'plan_type': 'free' if name == 'free' else 'plus'}
                for name in ['passed-personal', 'passed-team', 'wrong', 'failed', 'invalid', 'manual', 'free', 'unhealthy']]

    def health(route):
        accounts = route.request.post_data_json['accounts']
        assert all(account['accountId'] != 'free' for account in accounts)
        route.fulfill(json={'results': [{'status': 401 if account['accountId'] == 'unhealthy' else 200}
                                        for account in accounts]})

    def evaluate(route):
        body = route.request.post_data_json
        evaluations.append(body)
        name = body.get('account', {}).get('accountId', 'api')
        if body['question'] == 'pelican':
            # A correct visual result must never qualify a wrong candy answer.
            status = 'passed' if name == 'wrong' else 'manual_review'
        elif all_wrong:
            status = 'wrong_answer'
        else:
            status = {'wrong': 'wrong_answer', 'invalid': 'invalid_format', 'manual': 'manual_review'}.get(name, 'passed')
        event = {'type': 'error', 'error': 'fixture request failure'} if name == 'failed' else {
            'type': 'complete', 'status': status, 'output': '答案：21' if status == 'passed' else '答案：22', 'durationMs': 20}
        route.fulfill(content_type='text/event-stream', body='data: ' + json.dumps(event) + '\n\n')

    def push(route):
        pushes.append(route.request.post_data_json)
        pending.append(route)

    def finish_push(partial=False):
        route = pending.pop(0)
        body = route.request.post_data_json
        results = [{'index': index, 'itemId': body['itemIds'][index],
                    'status': 'failed' if partial and index == 1 else 'success',
                    'retryable': bool(partial and index == 1)} for index, _ in enumerate(body['accounts'])]
        failed = sum(result['status'] == 'failed' for result in results)
        route.fulfill(json={'ok': not failed, 'operationId': body['operationId'], 'schemaVersion': body['schemaVersion'],
                            'imported': len(results) - failed, 'failed': failed, 'results': results})

    context.route('**/api/session-health', health)
    context.route('**/api/model-evaluation', evaluate)
    context.route('**/api/push/sub2api', push)
    context.route('**/api/push/sub2api/groups', lambda route: route.fulfill(json={'groups': [{'id': 7, 'name': 'Passed accounts'}]}))
    context.route('**/api/push/sub2api/proxies', lambda route: route.fulfill(json={'proxies': []}))
    try:
        page.goto(url)
        page.wait_for_load_state('networkidle')
        page.locator('#session-input').fill(json.dumps(fixtures))
        expect(page.locator('#health-status')).to_contain_text('测活完成')
        page.locator('#model-evaluation-tab').click()
        button = page.locator('#evaluation-push-passed')
        start = page.locator('[data-evaluation-start]')
        expect(button).to_be_visible()
        expect(button).to_be_disabled()
        page.locator('#evaluation-include-pelican').check()
        start.click()
        expect(page.locator('#evaluation-status')).to_contain_text('测试完成')
        expect(button).to_be_enabled()
        expect(button).to_contain_text('（2）')
        assert len(evaluations) == 12
        assert all(body['account']['accountId'] not in ['free', 'unhealthy'] for body in evaluations)
        button.click()
        expect(page.locator('#sub2-push-dialog')).to_be_visible()
        assert not pushes
        page.locator('#login-sub2-base-url').fill('https://sub2.fixture')
        page.locator('#login-sub2-admin-key').fill('fixture-admin-key')
        page.locator('#load-login-sub2-groups').click()
        page.locator('[data-sub2-group-id="7"]').check()
        page.locator('.push-account-options summary').click()
        page.locator('#login-sub2-concurrency').fill('23')
        page.locator('#save-login-sub2-config').click()
        expect(page.locator('#login-sub2-status')).to_contain_text('已加密保存')
        page.keyboard.press('Escape')
        assert not pushes
        # The button stays on the right at desktop sizes and wraps within mobile screens.
        output = Path(__file__).resolve().parents[1] / 'output' / 'evaluation-push'
        output.mkdir(parents=True, exist_ok=True)
        for width in [1440, 390]:
            page.set_viewport_size({'width': width, 'height': 900})
            page.evaluate('window.scrollTo(0, 0)')
            box = button.bounding_box()
            assert box['x'] >= 0 and box['x'] + box['width'] <= width, box
            if width == 1440:
                assert box['x'] > page.locator('#model-evaluation-title').bounding_box()['x'] + 200
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            page.screenshot(path=str(output / f'passed-{width}.png'), full_page=True)
        page.set_viewport_size({'width': 1440, 'height': 900})
        button.click()
        expect(page.locator('#evaluation-push-feedback-slot #push-status')).to_contain_text('正在推送 2')
        expect(button).to_be_disabled()
        button.dispatch_event('click')
        assert len(pushes) == 1
        body = pushes[0]
        assert body['settings']['baseUrl'] == 'https://sub2.fixture'
        assert body['settings']['adminApiKey'] == 'fixture-admin-key'
        assert body['settings']['groupIds'] == [7]
        assert {account['credentials']['chatgpt_account_id'] for account in body['accounts']} == {'passed-personal', 'passed-team'}
        assert {account['credentials']['refresh_token'] for account in body['accounts']} == {'passed-personal-refresh', 'passed-team-refresh'}
        assert all(account['concurrency'] == 23 for account in body['accounts'])
        finish_push(partial=True)
        expect(page.locator('#evaluation-push-feedback-slot #push-status')).to_contain_text('成功 1，失败 1')
        expect(button).to_be_enabled()
        page.locator('#retry-push').click()
        expect(page.locator('#push-status')).to_contain_text('正在推送 1')
        assert len(pushes) == 2
        assert pushes[1]['operationId'] == pushes[0]['operationId']
        assert pushes[1]['accounts'][0]['credentials']['chatgpt_account_id'] == 'passed-team'
        finish_push()
        expect(page.locator('#push-status')).to_contain_text('成功 1，失败 0')
        # API-mode results are never converted into account pushes.
        page.locator('input[name="evaluation-source"][value="api"]').check()
        expect(button).to_be_disabled()
        page.locator('#evaluation-api-url').fill('https://api.fixture/v1')
        page.locator('#evaluation-api-key').fill('fixture-api-key')
        page.locator('#evaluation-include-pelican').uncheck()
        start.click()
        expect(page.locator('#evaluation-status')).to_contain_text('答案正确 1')
        expect(button).to_be_disabled()
        page.locator('input[name="evaluation-source"][value="accounts"]').check()
        expect(button).to_be_disabled()
        # A new run replaces old passing results, even when every answer is wrong.
        all_wrong = True
        start.click()
        expect(page.locator('#evaluation-status')).to_contain_text('测试完成')
        expect(button).to_contain_text('（0）')
        button.dispatch_event('click')
        assert len(pushes) == 2
        all_wrong = False
        start.click()
        expect(page.locator('#evaluation-status')).to_contain_text('测试完成')
        expect(button).to_contain_text('（2）')
        # Reimporting a renewed credential clears old results rather than pushing it untested.
        page.locator('.top-nav [data-format="sub2api"]').click()
        expect(page.locator('input[name="push-target"][value="none"]')).to_be_checked()
        fixtures[0]['access_token'] = 'renewed-token'
        page.locator('#session-input').fill(json.dumps(fixtures))
        page.locator('#model-evaluation-tab').click()
        expect(button).to_be_disabled()
        expect(button).to_contain_text('（0）')
        page.reload()
        page.wait_for_load_state('networkidle')
        page.locator('#model-evaluation-tab').click()
        expect(button).to_be_disabled()
        page.locator('#evaluation-sub2-config').click()
        expect(page.locator('#login-sub2-admin-key')).to_have_value('fixture-admin-key')
        page.keyboard.press('Escape')
        assert not errors, errors
        assert len(pushes) == 2
    finally:
        context.close()
    print('Evaluation push: correct candy answers only, distinct workspaces, saved settings, retry, busy guard, API exclusion, reset and responsive layout: PASS')
