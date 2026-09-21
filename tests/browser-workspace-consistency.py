"""Real IndexedDB transactions across tabs; no upstream services or real data."""
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

SOURCE = (Path(__file__).resolve().parents[1] / "docs/browser-store.js").read_text(encoding="utf-8")
ORIGIN = "http://127.0.0.1:17879"


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for broadcasts in [True, False]:
            context = browser.new_context()
            prefix = "" if broadcasts else "window.BroadcastChannel = undefined;"
            context.route(ORIGIN + "/**", lambda route: route.fulfill(
                status=200, content_type="text/html", body="<script>" + prefix + SOURCE + "</script>"))
            first, second = context.new_page(), context.new_page()
            first.goto(ORIGIN)
            first.evaluate("() => browserWorkspace.save({value:'fixture-original'})")
            second.goto(ORIGIN)
            second.evaluate("async () => { window.oldState = await browserWorkspace.read(); }")
            first.evaluate("() => browserWorkspace.save({value:'fixture-newer'})")
            code = second.evaluate("async () => { try { await browserWorkspace.save(oldState); return 'unexpected-success'; } catch (e) { return e.code; } }")
            assert code == "WORKSPACE_CONFLICT", code
            assert first.evaluate("async () => (await browserWorkspace.read()).value") == "fixture-newer"
            # Partial clear must retain only its supplied settings, rotate the key,
            # cancel queued writes, and reject stale tabs even without broadcasts.
            code = second.evaluate("async () => { try { await browserWorkspace.clearLoginData({config:'stale'}); return 'unexpected-success'; } catch (e) { return e.code; } }")
            assert code == "WORKSPACE_CONFLICT", code
            first.evaluate("""async () => {
                const db = await new Promise(resolve => { const q = indexedDB.open('session-converter-browser'); q.onsuccess = () => resolve(q.result); });
                const tx = db.transaction('workspace'); const q = tx.objectStore('workspace').get('encryption-key');
                await new Promise(resolve => tx.oncomplete = resolve); window.oldKey = q.result; db.close();
                window.previousSignal = browserWorkspace.signal;
                const queued = browserWorkspace.save({value:'fixture-queued-secret'}).then(() => false, error => error.code === 'WORKSPACE_CONFLICT');
                await browserWorkspace.clearLoginData({config:'fixture-retained-config'});
                if (!await queued) throw new Error('A pending save survived partial clear');
            }""")
            assert first.evaluate("() => previousSignal.aborted && !browserWorkspace.signal.aborted")
            assert first.evaluate("() => browserWorkspace.read()") == {'config': 'fixture-retained-config'}
            assert first.evaluate("""async () => {
                const db = await new Promise(resolve => { const q = indexedDB.open('session-converter-browser'); q.onsuccess = () => resolve(q.result); });
                const tx = db.transaction('workspace'); const q = tx.objectStore('workspace').get('current');
                await new Promise(resolve => tx.oncomplete = resolve); db.close();
                const value = q.result;
                if (JSON.stringify(value).includes('fixture-')) return false;
                try { await crypto.subtle.decrypt({name:'AES-GCM', iv:value.iv}, oldKey, value.data); return false; } catch { return true; }
            }""")
            if broadcasts:
                second.wait_for_function("() => browserWorkspace.signal.aborted")
            assert second.evaluate("async () => { try { await browserWorkspace.save(oldState); return false; } catch (e) { return e.code === 'WORKSPACE_CONFLICT'; } }")
            first.evaluate("async () => { window.previousSignal = browserWorkspace.signal; await Promise.all([browserWorkspace.clear(), browserWorkspace.clear()]); }")
            assert first.evaluate("() => previousSignal.aborted && !browserWorkspace.signal.aborted && previousSignal !== browserWorkspace.signal")
            code = second.evaluate("async () => { try { await browserWorkspace.save(oldState); return 'unexpected-success'; } catch (e) { return e.code; } }")
            assert code == "WORKSPACE_CONFLICT", code
            assert first.evaluate("async () => !(await browserWorkspace.read())")
            # The clearing tab can continue immediately with a new abort signal.
            first.evaluate("() => browserWorkspace.save({value:'fixture-after-clear'})")
            assert first.evaluate("async () => (await browserWorkspace.read()).value") == "fixture-after-clear"
            first.evaluate("() => browserWorkspace.clear()")
            # A fresh tab can start working after clear without reviving old data.
            fresh = context.new_page()
            fresh.goto(ORIGIN)
            fresh.evaluate("() => browserWorkspace.save({value:'fixture-fresh'})")
            assert fresh.evaluate("async () => (await browserWorkspace.read()).value") == "fixture-fresh"
            context.close()
        # CAS also protects simultaneous writes when broadcasts are unavailable.
        context = browser.new_context()
        context.route(ORIGIN + "/**", lambda route: route.fulfill(
            status=200, content_type="text/html", body="<script>window.BroadcastChannel=undefined;" + SOURCE + "</script>"))
        pages = [context.new_page(), context.new_page()]
        for page in pages:
            page.goto(ORIGIN)
            page.evaluate("() => browserWorkspace.read()")
        pages[0].evaluate("() => { window.result = browserWorkspace.save({value:'fixture-A'}).then(() => 'saved', e => e.code); }")
        pages[1].evaluate("() => { window.result = browserWorkspace.save({value:'fixture-B'}).then(() => 'saved', e => e.code); }")
        results = [page.evaluate("() => window.result") for page in pages]
        assert sorted(results) == ["WORKSPACE_CONFLICT", "saved"], results
        context.close()
        # Upgrade the previous plaintext storage format, including duplicate form fields.
        context = browser.new_context()
        context.route(ORIGIN + "/**", lambda route: route.fulfill(
            status=200, content_type="text/html", body="<script>" + SOURCE + "</script>"))
        page = context.new_page()
        page.goto(ORIGIN)
        page.evaluate("""async () => {
            const db = await new Promise(resolve => {
                const request = indexedDB.open('session-converter-browser', 1);
                request.onupgradeneeded = () => request.result.createObjectStore('workspace');
                request.onsuccess = () => resolve(request.result);
            });
            const tx = db.transaction('workspace', 'readwrite');
            tx.objectStore('workspace').put(7, 'revision');
            tx.objectStore('workspace').put({state: {secret: 'fixture-legacy-key'}, fields: [{value: 'fixture-legacy-key'}]}, 'current');
            await new Promise(resolve => tx.oncomplete = resolve);
            db.close();
        }""")
        assert page.evaluate("async () => (await browserWorkspace.read()).state.secret") == 'fixture-legacy-key'
        assert page.evaluate("""async () => {
            const db = await new Promise(resolve => { const q = indexedDB.open('session-converter-browser'); q.onsuccess = () => resolve(q.result); });
            const tx = db.transaction('workspace');
            const value = tx.objectStore('workspace').get('current');
            const key = tx.objectStore('workspace').get('encryption-key');
            await new Promise(resolve => tx.oncomplete = resolve);
            return value.result.encryption === 'AES-GCM-v1' && !key.result.extractable && !JSON.stringify(value.result).includes('fixture-legacy-key');
        }""")
        page.reload()
        assert page.evaluate("async () => (await browserWorkspace.read()).fields[0].value") == 'fixture-legacy-key'
        # Authentication failure must never silently return a fresh empty workspace.
        assert page.evaluate("""async () => {
            const db = await new Promise(resolve => { const q = indexedDB.open('session-converter-browser'); q.onsuccess = () => resolve(q.result); });
            const tx = db.transaction('workspace', 'readwrite');
            const store = tx.objectStore('workspace'); const q = store.get('current');
            q.onsuccess = () => { const value = q.result; new Uint8Array(value.data)[0] ^= 1; store.put(value, 'current'); };
            await new Promise(resolve => tx.oncomplete = resolve);
            try { await browserWorkspace.read(); return false; } catch { return true; }
        }""")
        page.evaluate("() => browserWorkspace.clear()")
        assert page.evaluate("""async () => {
            const db = await new Promise(resolve => { const q = indexedDB.open('session-converter-browser'); q.onsuccess = () => resolve(q.result); });
            const tx = db.transaction('workspace'); const q = tx.objectStore('workspace').getAllKeys();
            await new Promise(resolve => tx.oncomplete = resolve); return JSON.stringify(q.result) === '["revision"]';
        }""")
        context.close()
        browser.close()
    print("Browser consistency: stale writes, full/partial clear, key rotation, concurrent CAS, encrypted migration, tamper detection: PASS")


if __name__ == "__main__":
    main()
