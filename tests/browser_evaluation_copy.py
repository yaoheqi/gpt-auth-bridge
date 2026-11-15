"""Copy model evaluation groups using synthetic credentials and the browser clipboard."""
import json
from pathlib import Path
from playwright.sync_api import expect


def check_evaluation_copy(browser, url):
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, permissions=['clipboard-read', 'clipboard-write'])
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    fixtures = [{'email': 'shared@example.com' if name.startswith('shared') else 'wrong@example.com' if name.startswith('wrong') else name + '@example.com',
                 'account_id': name, 'access_token': name + '-token', 'refresh_token': name + '-refresh',
                 'plan_type': 'free' if name == 'free' else 'plus'}
                for name in ['shared-pass', 'shared-wrong', 'wrong-one', 'wrong-two', 'invalid', 'tokenpass', 'free', 'unhealthy']]
    cached = [{'id': name, 'email': name + '@example.com', 'password': 'fixture-password', 'two_factor_secret': 'JBSWY3DPEHPK3PXP',
               'openai_access_token': name + '-token', 'openai_rt': name + '-refresh', 'openai_account_id': name}
              for name in ['cachedpass', 'cachedfail']]
    shared_line = 'SHARED@example.com---fixture--password|value---JBSWY3DPEHPK3PXP'
    wrong_line = 'wrong@example.com----fixture-password----JBSWY3DPEHPK3PXP'

    def evaluate(route):
        body = route.request.post_data_json
        name = body.get('account', {}).get('accountId', 'api')
        status = 'passed' if body['question'] == 'pelican' or name in ['shared-pass', 'tokenpass', 'cachedpass', 'api'] else 'invalid_format' if name == 'invalid' else 'wrong_answer'
        event = {'type': 'error', 'error': 'fixture request failure'} if name == 'cachedfail' else {
            'type': 'complete', 'status': status, 'output': '答案：21' if status == 'passed' else '答案：22'}
        route.fulfill(content_type='text/event-stream', body='data: ' + json.dumps(event) + '\n\n')

    context.route('**/api/session-health', lambda route: route.fulfill(json={'results': [
        {'status': 401 if account['accountId'] == 'unhealthy' else 200, 'usage': {'planType': 'plus'}}
        for account in route.request.post_data_json['accounts']]}))
    context.route('**/api/model-evaluation', evaluate)
    try:
        page.goto(url)
        page.wait_for_load_state('networkidle')
        page.evaluate('''async data => browserWorkspace.save({state:{format:'model-evaluation',browserAccounts:data.cached},fields:[
            {id:'session-input',value:JSON.stringify(data.fixtures)}, {id:'login-accounts',value:data.lines}]})''',
            {'cached': cached, 'fixtures': fixtures, 'lines': shared_line + '\n' + wrong_line})
        page.reload()
        success = page.locator('#evaluation-copy-success')
        failed = page.locator('#evaluation-copy-failed')
        feedback = page.locator('#evaluation-copy-status')
        expect(success).to_be_disabled()
        expect(failed).to_be_disabled()
        page.locator('#evaluation-include-pelican').check()
        page.locator('[data-evaluation-start]').click()
        expect(page.locator('#evaluation-status')).to_contain_text('测试完成')
        expect(success).to_have_text('复制成功账号（3）')
        expect(failed).to_have_text('复制失败账号（3）')
        summary = page.locator('#evaluation-status').inner_text()
        success.click()
        expect(feedback).to_contain_text('已复制 3 个成功账号')
        assert set(page.evaluate('() => navigator.clipboard.readText()').splitlines()) == {
            shared_line, 'cachedpass@example.com----fixture-password----JBSWY3DPEHPK3PXP', 'tokenpass@example.com'}
        expect(feedback).to_contain_text('其中 1 个无登录凭据，仅复制邮箱')
        failed.click()
        expect(feedback).to_contain_text('已复制 3 个失败账号')
        assert set(page.evaluate('() => navigator.clipboard.readText()').splitlines()) == {
            wrong_line, 'cachedfail@example.com----fixture-password----JBSWY3DPEHPK3PXP', 'invalid@example.com'}
        expect(page.locator('#evaluation-status')).to_have_text(summary)
        # A denied clipboard write shows an actionable error and allows retry.
        page.evaluate('''() => { window.fixtureWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
            navigator.clipboard.writeText = async () => { throw new Error('fixture permission denied'); }; }''')
        success.click()
        expect(feedback).to_contain_text('复制失败，请允许浏览器访问剪贴板后重试')
        page.evaluate('() => { navigator.clipboard.writeText = window.fixtureWriteText; }')
        success.click()
        expect(feedback).to_contain_text('已复制 3 个成功账号')
        output = Path(__file__).resolve().parents[1] / 'output' / 'evaluation-copy'
        output.mkdir(parents=True, exist_ok=True)
        for width in [1440, 390]:
            page.set_viewport_size({'width': width, 'height': 1000})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            for button in [success, failed]:
                box = button.bounding_box()
                assert box['x'] >= 0 and box['x'] + box['width'] <= width
            page.screenshot(path=str(output / f'copy-{width}.png'), full_page=True)
        # API tests never copy login accounts, and a new batch replaces prior results.
        page.locator('input[name="evaluation-source"][value="api"]').check()
        expect(success).to_be_disabled()
        expect(failed).to_be_disabled()
        expect(feedback).to_be_hidden()
        page.locator('#evaluation-api-url').fill('https://api.fixture/v1')
        page.locator('#evaluation-api-key').fill('fixture-api-key')
        page.locator('#evaluation-include-pelican').uncheck()
        page.locator('[data-evaluation-start]').click()
        expect(page.locator('#evaluation-status')).to_contain_text('答案正确 1')
        page.locator('input[name="evaluation-source"][value="accounts"]').check()
        expect(success).to_be_disabled()
        expect(failed).to_be_disabled()
        page.locator('[data-evaluation-start]').click()
        expect(page.locator('#evaluation-status')).to_contain_text('测试完成')
        expect(success).to_be_enabled()
        page.locator('.top-nav [data-format="sub2api"]').click()
        page.locator('#session-input').fill(json.dumps(fixtures[:1]))
        page.locator('#model-evaluation-tab').click()
        expect(success).to_be_disabled()
        expect(failed).to_be_disabled()
        assert not errors, errors
    finally:
        context.close()
    print('Evaluation copy: success/failure groups, owner deduplication, login lines, saved credentials, email fallback, clipboard errors, API exclusion and reset: PASS')
