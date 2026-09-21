"""TXT import exercises the real import API and mocks only upstream login."""
import json
from playwright.sync_api import expect


def check_account_import(browser, url):
    context = browser.new_context()
    page = context.new_page()
    errors, calls = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    secret = 'JBSWY3DPEHPK3PXP'

    def login(route):
        snapshot = route.request.post_data_json['browserState']
        calls.extend(snapshot['accounts'])
        results = [{'id': row['id'], 'ok': True, 'personalOk': True, 'businessSuccess': 0} for row in snapshot['accounts']]
        events = [('browser_state', snapshot), ('summary', {'ok': True, 'results': results, 'success': len(results), 'failed': 0})]
        route.fulfill(content_type='text/event-stream', body=''.join(f'event: {name}\ndata: {json.dumps(data)}\n\n' for name, data in events))

    context.route('**/api/v2/accounts/protocol-login-pipeline', login)
    try:
        page.goto(url)
        expect(page.locator('#task-concurrency-value')).to_have_text('10')
        page.locator('.top-nav [data-format="protocol-login"]').click()
        buttons = page.locator('.login-account-actions > button').all_text_contents()
        assert buttons == ['导入文件', '退出全部会话', '自踢', '重设 2FA']
        existing = f'existing@example.com----pass----{secret}'
        imported = [f'left@example.com---pass--{secret}', f'right@example.com--pass---{secret}',
                    f'internal@example.com----pass--with----dashes----{secret}', f'triple@example.com---pass---{secret}']
        page.locator('#login-accounts').fill(existing)
        with page.expect_file_chooser() as chooser:
            page.locator('#import-login-file').click()
        chooser.value.set_files([
            {'name': 'accounts.txt', 'mimeType': 'text/plain', 'buffer': ('\ufeff' + '\r\n'.join(imported[:2]) + '\r\n').encode()},
            {'name': 'more.txt', 'mimeType': 'text/plain', 'buffer': '\n'.join(imported[2:]).encode()},
        ])
        expect(page.locator('#login-status')).to_contain_text('已导入 4 个账号')
        expected = '\n'.join([existing, *imported])
        expect(page.locator('#login-accounts')).to_have_value(expected)
        assert calls == []
        page.reload()
        expect(page.locator('#login-accounts')).to_have_value(expected)
        page.locator('#start-protocol-login').click()
        expect(page.locator('#login-status')).to_contain_text('全部流程完成：成功 5')
        assert {row['email'].split('@')[0]: row['password'] for row in calls} == {
            'existing': 'pass', 'left': '-pass', 'right': 'pass-', 'internal': 'pass--with----dashes', 'triple': 'pass'}
        # A bad row rejects the whole file without exposing its credentials.
        page.locator('#login-file-input').set_input_files({'name': 'bad.txt', 'mimeType': 'text/plain',
            'buffer': (imported[0] + '\nnot-an-account--private-fixture--bad!secret').encode()})
        expect(page.locator('#login-status')).to_contain_text('第 2 行')
        expect(page.locator('#login-status')).not_to_contain_text('private-fixture')
        expect(page.locator('#login-accounts')).to_have_value(expected)
        # Clearing during file IO must not resurrect local credentials.
        page.evaluate('''() => { File.prototype.text = function() { return new Promise(resolve => window.finishImport = resolve); }; }''')
        page.locator('#login-file-input').set_input_files({'name': 'slow.txt', 'mimeType': 'text/plain', 'buffer': b'fixture'})
        page.wait_for_function('() => typeof window.finishImport === "function"')
        page.locator('#clear-login-data').click()
        expect(page.locator('#browser-storage-status')).to_have_text('登录数据已清空，配置已保留')
        page.evaluate('(text) => window.finishImport(text)', imported[0])
        expect(page.locator('#login-accounts')).to_have_value('')
        expect(page.locator('#import-login-file')).to_be_enabled()
        assert not errors, errors
    finally:
        context.close()
    print('Account file import: mixed separators, real API credentials, append, encrypted persistence and clear cancellation: PASS')
