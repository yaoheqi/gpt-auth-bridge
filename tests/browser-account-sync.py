"""Cross-feature account flow, with real browser storage and synthetic upstream results."""
import json
import os
import re
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def check_skip_free(browser, url):
    context = browser.new_context(accept_downloads=True)
    page = context.new_page()
    probes, errors, pending = [], [], []
    hold = False
    page.on('pageerror', lambda error: errors.append(str(error)))

    def health(route):
        accounts = route.request.post_data_json['accounts']
        probes.append([account['email'] for account in accounts])
        result = {'results': [{'index': index, 'status': 200,
                              'usage': {'planType': 'free' if 'free' in account['email'] else 'plus'}}
                             for index, account in enumerate(accounts)]}
        if hold:
            pending.append((route, result))
        else:
            route.fulfill(json=result)

    context.route('**/api/session-health', health)
    try:
        page.goto(url)
        page.wait_for_load_state('networkidle')
        fixtures = [
            {'email': 'known-free@example.com', 'access_token': 'known-free-token', 'plan_type': ' FrEe '},
            {'email': 'paid@example.com', 'access_token': 'paid-token', 'plan_type': 'plus'},
            {'email': 'discovered-free@example.com', 'access_token': 'discovered-free-token'},
        ]
        source = json.dumps(fixtures)
        page.locator('#session-input').fill(source)
        expect(page.locator('#health-status')).to_contain_text('HTTP 200 1')
        assert probes == [['paid@example.com', 'discovered-free@example.com']], probes
        expect(page.locator('#converter-free-count')).to_have_text('（2）')
        expect(page.locator('#stat-count')).to_have_text('1')
        expect(page.locator('#stat-errors')).to_have_text('2')
        expect(page.locator('#health-body')).not_to_contain_text('free@example.com')
        expect(page.locator('#account-body')).not_to_contain_text('free@example.com')
        page.locator('#download-scope').select_option('all')
        with page.expect_download() as download:
            page.locator('#download-output').click()
        output = json.loads(Path(download.value.path()).read_text(encoding='utf-8'))
        assert [account['name'] for account in output['accounts']] == ['paid@example.com']
        # A health-discovered free plan stays excluded after the saved workspace reloads.
        saved = page.evaluate('''async () => {
            for (let attempt = 0; attempt < 100; attempt++) {
                const snapshot = await browserWorkspace.read();
                if (snapshot?.state?.health?.some(result => result?.usage?.planType === 'free')) return snapshot;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error('Health snapshot was not saved');
        }''')
        assert saved and saved['state']['conversionInput']['text'] == source, {
            'saved': saved, 'errors': errors,
            'status': page.locator('#browser-storage-status').inner_text(),
            'url': page.url,
        }
        before = len(probes)
        page.reload()
        page.wait_for_load_state('networkidle')
        assert not errors, errors
        expect(page.locator('#converter-free-count')).to_have_text('（2）')
        page.locator('#shared-health-check').click()
        expect(page.locator('#health-status')).to_contain_text('HTTP 200 1')
        assert probes[before:] and all(batch == ['paid@example.com'] for batch in probes[before:]), probes
        # Removing the filter probes free accounts without fresh results after reload.
        before = len(probes)
        page.locator('#converter-skip-free').uncheck()
        expect(page.locator('#converter-skip-free')).to_be_enabled()
        expect(page.locator('#health-status')).to_contain_text('HTTP 200 3')
        assert probes[before:] == [['known-free@example.com', 'discovered-free@example.com']], probes[before:]
        expect(page.locator('#stat-count')).to_have_text('3')
        expect(page.locator('#health-body')).to_contain_text('known-free@example.com')
        assert len(json.loads(page.locator('#output').input_value())['accounts']) == 3
        expect(page.locator('#session-input')).to_have_value(source)
        # Switching while a health request is pending aborts it and ignores stale results.
        hold = True
        page.locator('#shared-health-check').click()
        expect(page.locator('#health-status')).to_contain_text('正在测活 3')
        page.wait_for_function("() => document.querySelector('#health-status').textContent.includes('正在测活')")
        hold = False
        page.locator('#converter-skip-free').check()
        expect(page.locator('#converter-skip-free')).to_be_enabled()
        expect(page.locator('#health-status')).to_contain_text('HTTP 200 1')
        assert probes[-1] == ['paid@example.com'], probes
        for route, result in pending:
            route.fulfill(json=result)
        expect(page.locator('#stat-count')).to_have_text('1')
        expect(page.locator('#health-body')).not_to_contain_text('free@example.com')
        assert [account['name'] for account in json.loads(page.locator('#output').input_value())['accounts']] == ['paid@example.com']
        # All-free input sends no request and remains recoverable by unchecking.
        before = len(probes)
        page.locator('#session-input').fill(json.dumps(fixtures[:1]))
        expect(page.locator('#health-status')).to_contain_text('已跳过 1 个 free')
        expect(page.locator('#stat-count')).to_have_text('0')
        expect(page.locator('#download-output')).to_be_disabled()
        assert len(probes) == before
        page.locator('#converter-skip-free').uncheck()
        expect(page.locator('#converter-skip-free')).to_be_enabled()
        expect(page.locator('#health-status')).to_contain_text('HTTP 200 1')
        expect(page.locator('#stat-count')).to_have_text('1')
        page.reload()
        expect(page.locator('#converter-skip-free')).not_to_be_checked()
        expect(page.locator('#stat-count')).to_have_text('1')
        assert not errors, errors
    finally:
        context.close()
    print('Skip free: requests, display, counts, downloads, saved health, toggling, stale responses and all-free input: PASS')


def check_account_sync(browser, url):
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    page = context.new_page()
    errors, probes, evaluations = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    revision = 0

    def health(route):
        accounts = route.request.post_data_json['accounts']
        probes.append(accounts)
        route.fulfill(json={'results': [{'index': i, 'status': 401 if account.get('accessToken') == 'failed-token' else 200}
                                        for i, account in enumerate(accounts)]})

    def login(route):
        nonlocal revision
        revision += 1
        snapshot = route.request.post_data_json['browserState']
        for account in snapshot['accounts']:
            account.update(openai_access_token=f'personal-token-{revision}', openai_rt=f'refresh-{revision}',
                           openai_account_id='personal-id',
                           business_workspace_credentials=[{'workspaceId': 'business-id', 'accountId': 'business-id',
                                                            'accessToken': 'failed-token', 'refreshToken': 'business-refresh'}])
        results = [{'id': row['id'], 'email': row['email'], 'ok': True, 'personalOk': True, 'businessSuccess': 1}
                   for row in snapshot['accounts']]
        events = [('browser_state', snapshot), *[('account_done', result) for result in results], ('summary', {'ok': True, 'results': results, 'accounts': snapshot['accounts'],
                                                          'success': len(results), 'failed': 0})]
        route.fulfill(content_type='text/event-stream', body=''.join(f'event: {name}\ndata: {json.dumps(data)}\n\n' for name, data in events))

    def evaluate(route):
        evaluations.append(route.request.post_data_json)
        route.fulfill(content_type='text/event-stream', body='data: ' + json.dumps({
            'type': 'complete', 'status': 'passed', 'output': '答案：21', 'durationMs': 100}) + '\n\n')

    def logout(route):
        snapshot = route.request.post_data_json['browserState']
        for account in snapshot['accounts']:
            account.update(openai_access_token='', openai_rt='', openai_id_token='', openai_account_id='',
                           session_access_token='', session_json='', business_workspace_credentials=[])
        results = [{'id': account['id'], 'email': account['email'], 'ok': True} for account in snapshot['accounts']]
        events = [('browser_state', snapshot), ('summary', {'ok': True, 'results': results, 'success': len(results), 'failed': 0})]
        route.fulfill(content_type='text/event-stream', body=''.join(f'event: {name}\ndata: {json.dumps(data)}\n\n' for name, data in events))

    context.route('**/api/session-health', health)
    context.route('**/api/v2/accounts/protocol-login-pipeline', login)
    context.route('**/api/model-evaluation', evaluate)
    context.route('**/api/v2/accounts/protocol-logout-all', logout)
    try:
        page.goto(url)
        expect(page.locator('#task-concurrency-value')).to_have_text('10')
        page.locator('#session-input').fill(json.dumps([
            {'email': 'manual@example.com', 'access_token': 'manual-token', 'account_id': 'manual-id'},
            {'email': 'login@example.com', 'access_token': 'old-imported-token', 'account_id': 'personal-id'},
        ]))
        expect(page.locator('#health-status')).to_contain_text('测活完成')
        page.locator('.top-nav [data-format="protocol-login"]').click()
        expect(page.locator('#login-mode-description')).to_contain_text('直接使用 Codex OAuth')
        expect(page.locator('.login-step:visible .login-step-label')).to_have_text([
            '连接 Codex', '输入账号', '验证密码', '验证 2FA', '获取个人 RT', '授权工作区', '完成'])
        page.locator('input[name="login-workspace-mode"][value="session"]').check()
        expect(page.locator('#login-mode-description')).to_contain_text('登录 ChatGPT Web')
        expect(page.locator('.login-step:visible .login-step-label')).to_have_text([
            '连接 ChatGPT', '输入账号', '验证密码', '验证 2FA', '获取 Session'])
        page.locator('input[name="login-workspace-mode"][value="all"]').check()
        page.locator('#login-accounts').fill('login@example.com----fixture-password----JBSWY3DPEHPK3PXP')
        page.locator('#start-protocol-login').click()
        expect(page.locator('#login-status')).to_contain_text('全部流程完成：成功 1')
        page.locator('.top-nav [data-format="sub2api"]').click()
        expect(page.locator('#stat-count')).to_have_text('3')
        expect(page.locator('#health-status')).to_contain_text('HTTP 200 2')
        page.locator('#download-scope').select_option('all')
        output = json.loads(page.locator('#output').input_value())
        assert {a['credentials']['access_token'] for a in output['accounts']} == {'manual-token', 'personal-token-1', 'failed-token'}
        assert 'fixture-password' not in page.locator('#output').input_value()
        # Mode switches reuse the same current health results and keep model output.
        before = len(probes)
        page.locator('.top-nav [data-format="sub2api-tools"]').click()
        expect(page.locator('#input-status')).not_to_contain_text('必须')
        assert 'personal-token-1' in page.locator('#output').input_value()
        page.locator('.top-nav [data-format="model-evaluation"]').click()
        expect(page.locator('#evaluation-account-count')).to_contain_text('2 个可测试账号 / 3')
        page.locator('[data-evaluation-start]').click()
        expect(page.locator('[data-evaluation-start]')).to_be_enabled()
        assert {item['account']['accessToken'] for item in evaluations} == {'manual-token', 'personal-token-1'}
        page.locator('.top-nav [data-format="protocol-login"]').click()
        page.locator('.top-nav [data-format="model-evaluation"]').click()
        expect(page.locator('#evaluation-queue-count')).to_have_text('2 项')
        assert len(probes) == before
        # Reload derives login credentials from their canonical snapshot, then probes again.
        page.wait_for_function("async () => (await browserWorkspace.read()).state.format === 'model-evaluation'")
        page.reload()
        expect(page.locator('#evaluation-account-count')).to_contain_text('2 个可测试账号 / 3')
        page.locator('.top-nav [data-format="protocol-login"]').click()
        page.locator('#start-protocol-login').click()
        expect(page.locator('#login-status')).to_contain_text('全部流程完成：成功 1')
        page.locator('.top-nav [data-format="sub2api"]').click()
        expect(page.locator('#output')).to_have_value(re.compile('personal-token-2'))
        assert 'personal-token-1' not in page.locator('#output').input_value()
        expect(page.locator('#stat-count')).to_have_text('3')
        # Revocation must not revive the original imported token for the same identity.
        page.locator('.top-nav [data-format="protocol-login"]').click()
        page.once('dialog', lambda dialog: dialog.accept())
        page.locator('#protocol-logout-all').click()
        expect(page.locator('#login-status')).to_contain_text('退出全部会话完成：成功 1')
        page.locator('.top-nav [data-format="sub2api"]').click()
        expect(page.locator('#stat-count')).to_have_text('1')
        assert 'old-imported-token' not in page.locator('#output').input_value()
        page.wait_for_function("async () => (await browserWorkspace.read()).state.browserAccounts[0].openai_access_token === ''")
        page.reload()
        expect(page.locator('#stat-count')).to_have_text('1')
        # Clearing removes all shared projections, including after reload.
        page.locator('#clear-login-data').click()
        expect(page.locator('#browser-storage-status')).to_have_text('登录数据已清空，配置已保留')
        expect(page.locator('#stat-count')).to_have_text('0')
        page.reload()
        expect(page.locator('#stat-count')).to_have_text('0')
        # Batch imports keep metadata, feed model tests, and supply complete login triples.
        page.locator('.top-nav [data-format="sub2api-tools"]').click()
        page.locator('#session-input').fill(json.dumps({'type': 'sub2api-data', 'version': 1, 'proxies': [], 'accounts': [{
            'name': 'batch@example.com', 'platform': 'openai', 'type': 'oauth', 'extra': {'marker': 'preserved'},
            'credentials': {'email': 'batch@example.com', 'access_token': 'batch-token', 'account_id': 'batch-id',
                            'password': 'batch-password', 'two_factor_secret': 'JBSWY3DPEHPK3PXP'},
        }]}))
        expect(page.locator('#health-status')).to_contain_text('HTTP 200 1')
        assert 'preserved' in page.locator('#output').input_value()
        page.locator('.top-nav [data-format="model-evaluation"]').click()
        expect(page.locator('#evaluation-account-count')).to_contain_text('1 个可测试账号 / 1')
        page.locator('.top-nav [data-format="protocol-login"]').click()
        expect(page.locator('#login-accounts')).to_have_value('batch@example.com----batch-password----JBSWY3DPEHPK3PXP')
        page.locator('.top-nav [data-format="sub2api"]').click()
        expect(page.locator('#output')).to_have_value(re.compile('batch-token'))
        assert not errors, errors
    finally:
        context.close()
    print('Account sync: login + imports, workspaces, health gating, tabs, refresh, renewal, revocation, batch metadata and clear: PASS')


def main():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory(prefix='account-sync-test-') as runtime:
        env = {**os.environ, 'SKIP_DOTENV': '1', 'NODE_ENV': 'development', 'CONTAINER': 'false',
               'HOST': '127.0.0.1', 'PORT': str(port), 'RUNTIME_DIR': runtime, 'TASK_CONCURRENCY': '10', 'OPENAI_PROXY_URL': ''}
        child = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            for _ in range(300):
                if child.poll() is not None:
                    raise RuntimeError(child.stderr.read().decode())
                try:
                    with urlopen(url + '/api/ready', timeout=0.5):
                        break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError('startup timed out')
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                check_skip_free(browser, url)
                check_account_sync(browser, url)
                browser.close()
        finally:
            child.terminate()
            child.wait(timeout=10)


if __name__ == '__main__':
    main()
