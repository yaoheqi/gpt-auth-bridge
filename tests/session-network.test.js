import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSessionHealth, logoutAllSessions, withSessionTransport } from '../src/session-network.js';

const account = { accessToken: 'fixture-access-token' };
const usage = () => Response.json({ rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } } });

test('token-only health with usage uses a single upstream request', async () => {
  let calls = 0;
  const result = await checkSessionHealth(account, { includeUsage: true, fetchImpl: async () => { calls++; return usage(); } });
  assert.equal(calls, 1);
  assert.equal(result.status, 200);
  assert.equal(result.usage.fiveHour.usedPercent, 25);
});

test('OAuth probes preserve a deactivated error code without exposing the upstream payload', async () => {
  const result = await checkSessionHealth(account, { fetchImpl: async () => Response.json({ error: { code: 'account_deactivated', message: 'private detail' } }, { status: 401 }) });
  assert.equal(result.code, 'account_deactivated');
  assert.doesNotMatch(JSON.stringify(result), /private detail/);
});

test('logout probes first and never logs out an invalid session', async () => {
  const urls = [];
  const fetchImpl = async url => { urls.push(url); return new Response('', { status: 401 }); };
  assert.equal((await logoutAllSessions(account, { fetchImpl })).ok, false);
  assert.equal(urls.length, 1);
  const result = await logoutAllSessions(account, { fetchImpl: async url => {
    urls.push(url);
    return url.endsWith('/logout_all') ? new Response('', { status: 200 }) : usage();
  } });
  assert.equal(result.ok, true);
  assert.ok(urls.at(-1).endsWith('/logout_all'));
});

test('converter logout shares acknowledgment validation and does not follow redirects', async () => {
  for (const [status, body, ok] of [[200, 'null', true], [204, null, true], [200, '<html>private-fixture</html>', false], [200, 'false', false], [302, '', false], [429, 'private-fixture', false]]) {
    const result = await logoutAllSessions(account, { fetchImpl: async (url, init) => {
      if (!url.endsWith('/logout_all')) return usage();
      assert.equal(init.redirect, 'manual');
      return new Response(body, { status });
    } });
    assert.equal(result.ok, ok);
    assert.equal(result.logoutStatus, status);
    assert.doesNotMatch(JSON.stringify(result), /private-fixture/);
  }
});

test('session operations retain one selected proxy and dispose on success or failure', async () => {
  for (const fail of [false, true]) {
    const selected = [];
    let disposed = 0;
    const pending = withSessionTransport(async ({ fetchImpl }) => {
      await checkSessionHealth(account, { includeUsage: true, fetchImpl });
      if (fail) throw new Error('fixture-failure');
    }, {
      pool: 'fixture-pool',
      resolveProxy: options => { assert.equal(options.pool, 'fixture-pool'); return { proxyUrl: 'http://127.0.0.1:7777' }; },
      createFetch: (proxy, options) => {
        selected.push({ proxy, direct: options.direct });
        return Object.assign(async () => usage(), { dispose: async () => { disposed++; } });
      },
    });
    if (fail) await assert.rejects(pending, /fixture-failure/); else await pending;
    assert.deepEqual(selected, [{ proxy: 'http://127.0.0.1:7777', direct: false }]);
    assert.equal(disposed, 1);
  }
});

test('cancelled operations do not create network transports', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(withSessionTransport(() => assert.fail(), { signal: controller.signal, createFetch: () => assert.fail() }), { name: 'AbortError' });
});
