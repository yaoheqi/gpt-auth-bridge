"""Browser persistence and uncertain side effects; every network call is a fixture."""
import json
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'http://127.0.0.1:17883'
SESSION = {'email': 'fixture@example.com', 'accessToken': 'fixture-access',
           'refresh_token': 'fixture-refresh', 'account': {'id': 'fixture-account'}}


def fixture_page(browser, seed=None):
    context = browser.new_context()
    page = context.new_page()
    errors, health = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))

    def serve(route):
        path = urlparse(route.request.url).path
        if path == '/seed':
            route.fulfill(content_type='text/html', body='<script src="/browser-store.js"></script>')
        elif path == '/api/system/config':
            route.fulfill(json={'taskConcurrency': 2})
        elif path == '/api/session-health':
            health.append(route.request.post_data_json)
            route.fulfill(json={'ok': True, 'results': [{'index': index, 'status': 200} for index, _ in enumerate(health[-1]['accounts'])]})
        elif path == '/api/v2/accounts/import':
            body = route.request.post_data_json
            account = {'id': 'fixture', 'email': 'fixture@example.com', 'password': 'fixture-password', 'two_factor_secret': 'JBSWY3DPEHPK3PXP'}
            route.fulfill(json={'ok': True, 'rows': [{'id': 'fixture', 'email': account['email'], 'ok': True}],
                               'browserState': {'accounts': [account], 'settings': body['browserState']['settings']}})
        elif path == '/api/v2/admin/sub2api/settings':
            route.fulfill(json={'ok': True, 'settings': {}})
        elif path.startswith('/api/'):
            raise AssertionError('Unexpected API request: ' + path)
        else:
            file = ROOT / 'docs' / ('index.html' if path == '/' else path.lstrip('/'))
            content_type = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml'}[file.suffix]
            route.fulfill(content_type=content_type, body=file.read_text(encoding='utf-8'))

    page.route('**/*', serve)
    if seed is not None:
        page.goto(ORIGIN + '/seed')
        page.evaluate('(snapshot) => browserWorkspace.save(snapshot, {barrier:true})', seed)
    page.goto(ORIGIN)
    expect(page.locator('#task-concurrency-value')).to_have_text('2')
    return context, page, errors, health


def check_recovery_and_reconcile(browser):
    context, page, errors, health = fixture_page(browser)
    writes, checks, pending = [], [], []
    try:
        page.locator('#open-cpa-push-config').click()
        page.locator('#cpa-base-url').fill('https://fixture.invalid')
        page.locator('#cpa-management-key').fill('fixture-key')
        page.locator('#save-cpa-config').click()
        expect(page.locator('#cpa-config-status')).to_contain_text('已加密保存')
        page.get_by_role('button', name='关闭 CPA 配置', exact=True).click()
        page.locator('input[name="push-target"][value="cpa"]').check()
        page.locator('#session-input').fill(json.dumps(SESSION))
        expect(page.locator('#push-converted')).to_be_enabled()

        def push(route):
            body = route.request.post_data_json
            writes.append(body)
            pending.append(page.evaluate('async () => (await browserWorkspace.read()).state.pushOperations.at(-1).items[0].status'))
            if len(writes) == 1:
                route.abort('failed')
            else:
                route.fulfill(json={'operationId': body['operationId'], 'ok': True, 'imported': 1, 'failed': 0,
                                    'results': [{'index': 0, 'itemId': body['itemIds'][0], 'status': 'success', 'retryable': False}]})

        def reconcile(route):
            body = route.request.post_data_json
            checks.append(body)
            status = 'unknown' if len(checks) == 1 else 'failed'
            route.fulfill(json={'operationId': body['operationId'], 'ok': True,
                                'results': [{'index': 0, 'itemId': body['itemIds'][0], 'status': status, 'retryable': status == 'failed'}]})

        page.route('**/api/push/cpa', push)
        page.route('**/api/push/cpa/reconcile', reconcile)
        page.locator('#push-converted').click()
        expect(page.locator('#reconcile-push')).to_be_enabled()
        expect(page.locator('#retry-push')).to_be_hidden()
        original_viewport = page.viewport_size
        page.set_viewport_size({'width': 320, 'height': 640})
        page.locator('#push-result-details summary').click()
        for selector in ['#push-feedback', '.push-feedback-head', '#push-operation-history', '#reconcile-push']:
            node = page.locator(selector)
            box = node.bounding_box()
            assert box and box['x'] >= 0 and box['x'] + box['width'] <= 320, (selector, box)
            assert node.evaluate('(el) => el.scrollWidth <= el.clientWidth'), selector
        page.set_viewport_size(original_viewport)
        assert pending == ['pending'], 'The operation must be encrypted before any remote write'
        snapshot = page.evaluate('() => browserWorkspace.read()')
        assert snapshot['schemaVersion'] == 1
        assert 'converted' not in snapshot['state'] and 'sessions' not in snapshot['state'] and 'outputText' not in snapshot['state']
        assert snapshot['state']['pushOperations'][0]['items'][0]['status'] == 'unknown'
        assert 'pushRetry' not in snapshot['state'] and 'pushResults' not in snapshot['state']
        source_text = page.locator('#session-input').input_value()
        before = len(health)
        page.reload()
        expect(page.locator('#session-input')).to_have_value(source_text)
        expect(page.locator('#reconcile-push')).to_be_enabled()
        assert len(writes) == 1 and len(health) == before, 'Opening a saved page must not replay remote work'
        assert json.loads(page.locator('#output').input_value())['accounts'][0]['credentials']['refresh_token'] == 'fixture-refresh'
        page.locator('#push-converted').click()
        expect(page.locator('#push-status')).to_contain_text('请先核对远端结果')
        assert len(writes) == 1
        page.locator('#reconcile-push').click()
        expect(page.locator('#push-status')).to_contain_text('待核对 1')
        expect(page.locator('#retry-push')).to_be_hidden()
        page.locator('#reconcile-push').click()
        expect(page.locator('#retry-push')).to_be_enabled()
        assert len(writes) == 1, 'Reconcile must never write to the target'
        page.locator('#retry-push').click()
        expect(page.locator('#push-status')).to_contain_text('成功 1，失败 0')
        assert len(writes) == 2 and pending == ['pending', 'pending']
        assert writes[0]['operationId'] == writes[1]['operationId'] == checks[0]['operationId']
        assert writes[0]['itemIds'] == writes[1]['itemIds']
        page.reload()
        assert len(writes) == 2
        saved = page.evaluate('() => browserWorkspace.read()')
        assert len(saved['state']['pushOperations']) == 1
        assert saved['state']['pushOperations'][0]['items'][0]['status'] == 'success'
        assert 'account' not in saved['state']['pushOperations'][0]['items'][0]
        assert saved['state']['pushOperations'][0]['items'][0]['identity']['email'] == 'fixture@example.com'
        assert 'fixture-refresh' not in json.dumps(saved['state']['pushOperations'])
        assert not errors, errors
    finally:
        context.close()


def check_superseded_health_and_stream_cleanup(browser):
    context, page, errors, _ = fixture_page(browser)
    try:
        page.evaluate("""() => {
            const original = window.fetch;
            window.healthRequests = [];
            window.fetch = (url, options) => {
                if (url !== '/api/session-health') return original(url, options);
                return new Promise(resolve => healthRequests.push({signal:options.signal, resolve}));
            };
        }""")
        page.locator('#session-input').fill(json.dumps(SESSION))
        page.wait_for_function('() => healthRequests.length === 1')
        page.locator('#session-input').fill(json.dumps({**SESSION, 'accessToken': 'new-fixture-token'}))
        page.wait_for_function('() => healthRequests.length === 2')
        assert page.evaluate('healthRequests[0].signal.aborted && !healthRequests[1].signal.aborted')
        page.evaluate("""() => {
            healthRequests[1].resolve(new Response(JSON.stringify({results:[{status:200}]}), {headers:{'Content-Type':'application/json'}}));
            healthRequests[0].resolve(new Response(JSON.stringify({results:[{status:403}]}), {headers:{'Content-Type':'application/json'}}));
        }""")
        expect(page.locator('#health-status')).to_contain_text('HTTP 200 1')
        page.locator('.top-nav [data-format="protocol-login"]').click()
        page.evaluate("""() => {
            const original = window.fetch;
            window.fetch = (url, options) => {
                if (!String(url).endsWith('/protocol-login-pipeline')) return original(url, options);
                window.streamSignal = options.signal;
                return Promise.resolve(new Response(new ReadableStream({
                    start(controller) { window.streamController = controller; },
                    cancel() { window.streamCancelled = true; },
                }), {headers:{'Content-Type':'text/event-stream'}}));
            };
        }""")
        page.locator('#login-accounts').fill('fixture@example.com----fixture-password----JBSWY3DPEHPK3PXP')
        page.locator('#start-protocol-login').click()
        page.wait_for_function('() => !!window.streamController')
        assert page.evaluate('async () => (await browserWorkspace.read()).state.operationHistory.at(-1).status') == 'pending'
        page.once('dialog', lambda dialog: dialog.accept())
        page.locator('#clear-browser-data').click()
        expect(page.locator('#browser-storage-status')).to_have_text('所有数据已清空')
        page.wait_for_function('() => window.streamCancelled === true')
        assert page.evaluate('streamSignal.aborted')
        assert page.evaluate('async () => (await browserWorkspace.read()) === undefined')
        assert not errors, errors
    finally:
        context.close()


def check_history_compaction(browser):
    operations = [{'operationId': f'completed-{index}', 'target': 'cpa', 'baseUrl': 'https://fixture.invalid',
                   'startedAt': index, 'updatedAt': index, 'items': [{'itemId': '0', 'name': 'fixture@example.com', 'status': 'success',
                   'account': {'email': 'fixture@example.com', 'access_token': f'old-token-{index}'}}]} for index in range(55)]
    for status in ['pending', 'unknown', 'failed']:
        operations.append({'operationId': status, 'target': 'cpa', 'baseUrl': 'https://fixture.invalid',
                           'startedAt': 0, 'items': [{'itemId': '0', 'name': f'{status}@example.com', 'status': status,
                           'retryable': status == 'failed', 'account': {'email': f'{status}@example.com', 'access_token': f'keep-{status}'}}]})
    # A partially completed operation must retain unresolved payloads and show
    # both available actions correctly on a narrow screen.
    operations[-2]['items'].append({'itemId': '1', 'name': 'retry@example.com', 'status': 'failed', 'retryable': True,
                                    'account': {'email': 'retry@example.com', 'access_token': 'keep-mixed'}})
    seed = {'schemaVersion': 1, 'state': {'pushOperations': operations, 'activePushOperationId': 'unknown',
             'cpaSettings': {'baseUrl': 'https://fixture.invalid', 'managementKey': 'fixture-key'}},
            'fields': [{'name': 'push-target', 'type': 'radio', 'value': 'cpa', 'checked': True}]}
    context, page, errors, health = fixture_page(browser, seed)
    try:
        saved = page.evaluate('() => browserWorkspace.read()')
        histories = saved['state']['pushOperations']
        assert len(histories) == 53 and len(health) == 0
        assert 'old-token-' not in json.dumps(histories)
        for status in ['pending', 'unknown', 'failed']:
            history = next(operation for operation in histories if operation['operationId'] == status)
            assert history['items'][0]['account']['access_token'] == f'keep-{status}'
        expect(page.locator('#reconcile-push')).to_be_enabled()
        expect(page.locator('#retry-push')).to_be_enabled()
        page.set_viewport_size({'width': 320, 'height': 640})
        page.locator('#push-result-details summary').click()
        for selector in ['#push-feedback', '.push-feedback-head', '#push-operation-history', '#reconcile-push', '#retry-push']:
            node = page.locator(selector)
            box = node.bounding_box()
            assert box and box['x'] >= 0 and box['x'] + box['width'] <= 320, (selector, box)
            assert node.evaluate('(el) => el.scrollWidth <= el.clientWidth'), selector
        page.locator('#push-operation-history').select_option('failed')
        expect(page.locator('#retry-push')).to_be_enabled()
        page.locator('#clear-login-data').click()
        expect(page.locator('#browser-storage-status')).to_have_text('登录数据已清空，配置已保留')
        cleared = page.evaluate('() => browserWorkspace.read()')
        assert cleared['state']['pushOperations'] == []
        assert cleared['state']['cpaSettings']['managementKey'] == 'fixture-key'
        assert not errors, errors
    finally:
        context.close()


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        check_recovery_and_reconcile(browser)
        check_superseded_health_and_stream_cleanup(browser)
        check_history_compaction(browser)
        browser.close()
    print('Browser durability: normalized refresh, write-before-send, unknown recovery, read-only reconcile, explicit retry, cancellation: PASS')


if __name__ == '__main__':
    main()
