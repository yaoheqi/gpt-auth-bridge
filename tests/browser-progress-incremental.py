"""Called by the browser smoke test against the real app, with a controlled SSE stream."""
from playwright.sync_api import expect


def check_incremental_progress(browser, url):
    context = browser.new_context()
    try:
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(url)
        page.locator('.top-nav [data-format="protocol-login"]').click()
        page.evaluate('''() => {
            const original = window.fetch;
            window.fetch = (url, options) => {
                if (!String(url).endsWith('/protocol-login-pipeline')) return original(url, options);
                return Promise.resolve(new Response(new ReadableStream({start(controller) {
                    window.fixtureStream = controller;
                    window.sendProgress = (name, data) => controller.enqueue(new TextEncoder().encode(
                        'event: ' + name + '\\ndata: ' + JSON.stringify(data) + '\\n\\n'));
                }}), {headers: {'Content-Type': 'text/event-stream'}}));
            };
        }''')
        page.locator('#login-accounts').fill('\n'.join(
            f'fixture-{index}@example.com----FixturePassword!----JBSWY3DPEHPK3PXP' for index in range(200)))
        page.locator('#start-protocol-login').click()
        page.wait_for_function('() => !!window.fixtureStream')
        expect(page.locator('.login-account-progress')).to_have_count(200)
        page.evaluate('''() => {
            for (let i = 0; i < 40; i++) sendProgress('account_log', {
                email: 'fixture-150@example.com', msg: 'fixture progress ' + i, phase: 'codex'
            });
            sendProgress('account_timing', {email: 'fixture-150@example.com', stage: 'password', durationMs: 1234, calls: 1});
        }''')
        target = page.locator('.login-account-progress').nth(150)
        expect(target.locator('.login-account-log')).to_contain_text('fixture progress 39')
        expect(target.locator('.login-account-timing')).to_be_visible()
        page.evaluate('''() => {
            window.fixtureRows = [...document.querySelectorAll('.login-account-progress')];
            const target = fixtureRows[150];
            target.querySelector('details').open = true;
            target.querySelector('pre').scrollTop = 0;
            window.changedRows = new Set();
            window.fixtureObserver = new MutationObserver(changes => changes.forEach(change => {
                const element = change.target.nodeType === 1 ? change.target : change.target.parentElement;
                const row = element.closest('.login-account-progress');
                if (row) changedRows.add(fixtureRows.indexOf(row));
            }));
            fixtureObserver.observe(document.querySelector('#login-progress-list'), {childList: true, subtree: true, attributes: true, characterData: true});
            sendProgress('account_log', {email: 'fixture-150@example.com', msg: 'fixture incremental update'});
            sendProgress('account_timing', {email: 'fixture-150@example.com', stage: 'totp', durationMs: 500, calls: 1});
        }''')
        expect(target.locator('.login-account-log')).to_contain_text('fixture incremental update')
        expect(target.locator('.login-account-timing div')).to_contain_text('密码验证 1.23s')
        expect(target.locator('.login-account-timing div')).to_contain_text('2FA 验证 0.50s')
        assert page.evaluate('''() => {
            fixtureObserver.disconnect();
            const rows = [...document.querySelectorAll('.login-account-progress')];
            return rows.every((row, index) => row === fixtureRows[index])
                && changedRows.size === 1 && changedRows.has(150)
                && rows[150].querySelector('details').open && rows[150].querySelector('pre').scrollTop === 0;
        }''')
        page.evaluate('''() => {
            sendProgress('account_done', {email: 'fixture-150@example.com', ok: true, businessSuccess: 0,
                timings: {total: {durationMs: 2500, calls: 1}}});
            sendProgress('summary', {ok: true, success: 1, failed: 0, results: [], accounts: []});
            fixtureStream.close();
        }''')
        expect(target.locator('.login-account-stage')).to_have_text('已完成')
        page.wait_for_function("async () => (await browserWorkspace.read())?.state?.loginProgress?.[150]?.[1]?.timings?.total?.durationMs === 2500")
        page.reload()
        expect(page.locator('.login-account-progress')).to_have_count(200)
        page.locator('.login-account-progress').nth(150).locator('summary').click()
        expect(page.locator('.login-account-progress').nth(150).locator('.login-account-timing div')).to_contain_text('账号执行 2.50s')
        page.once("dialog", lambda dialog: dialog.accept())
        page.locator('#clear-browser-data').click()
        expect(page.locator('.login-account-progress')).to_have_count(0)
        assert not errors, errors
        print('Incremental progress: 200 stable rows, only one changed, timings persisted, scroll/expansion preserved: PASS')
    finally:
        context.close()
