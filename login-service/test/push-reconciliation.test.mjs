import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/app/create-app.js';
import { registerRemotePushRoutes, cpaFileName } from '../lib/remote-push.js';
import { createPushCoordinator, pushCoordinator } from '../src/services/push-coordinator.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const sub2Account = (email = 'fixture@example.com', workspace = 'personal') => ({
  name: email, platform: 'openai', type: 'oauth', credentials: {
    email, chatgpt_account_id: workspace, access_token: 'private-fixture-access',
    refresh_token: 'private-fixture-refresh', id_token: 'private-fixture-id',
  },
});
const cpaAccount = workspace => ({ type: 'codex', email: 'fixture@example.com', account_id: workspace,
  access_token: 'private-fixture-access', refresh_token: `private-fixture-refresh-${workspace}`, id_token: 'private-fixture-id',
});
const settings = target => target === 'sub2api'
  ? { baseUrl: 'https://sub2.test', adminApiKey: 'private-management-key', groupIds: [7] }
  : { baseUrl: 'https://cpa.test', managementKey: 'private-management-key' };
const remoteRow = (account, id = 1) => ({ ...structuredClone(account), id, group_ids: [7] });
const sub2Response = data => Response.json({ code: 0, data });

async function waitFor(predicate) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < end, 'local fixture did not reach the expected state');
    await delay(2);
  }
}

async function fixture(t, fetchImpl) {
  const app = createApp();
  registerRemotePushRoutes(app, { fetchImpl });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return async (path, body, signal) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/push/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const payload = await response.json();
    assert.equal(payload.schemaVersion, '1.0.0');
    assert.equal(payload.requestId, response.headers.get('x-request-id'));
    assert.equal(payload.operationId, body.operationId || response.headers.get('x-operation-id'));
    assert.doesNotMatch(JSON.stringify(payload), /private-fixture-|private-management-key/);
    return { status: response.status, body: payload };
  };
}

test('lost Sub2API batch response returns unknown for every stable operation item', async t => {
  let sends = 0;
  const push = await fixture(t, async (_url, options) => {
    assert.equal(options.method, 'POST');
    sends++;
    throw new TypeError('response lost after remote commit private-fixture-refresh');
  });
  const itemIds = ['account-a:personal', 'account-b:team'];
  const { body } = await push('sub2api', { settings: settings('sub2api'), operationId: 'lost-batch-1', itemIds,
    accounts: [sub2Account('a@example.com'), sub2Account('b@example.com', 'team')],
  });
  assert.equal(sends, 1);
  assert.equal(body.imported, 0);
  assert.equal(body.failed, 0);
  assert.equal(body.unknown, 2);
  assert.deepEqual(body.results.map(row => [row.index, row.itemId, row.status, row.retryable, row.code]),
    itemIds.map((id, index) => [index, id, 'unknown', false, 'REMOTE_RESULT_UNKNOWN']));
  assert.deepEqual(pushCoordinator.stats(), { activeKeys: 0, waiting: 0 });
});

test('Sub2API reconciliation confirms absence only after a complete read and never writes', async t => {
  const account = sub2Account();
  const matching = remoteRow(account);
  const old = remoteRow(account);
  old.credentials.refresh_token = 'different-version';
  const cases = [
    ['absent', { total: 0, items: [] }, 'failed', true, 'REMOTE_NOT_FOUND'],
    ['same credentials', { total: 1, items: [matching] }, 'success', false, 'REMOTE_CONFIRMED'],
    ['old credentials', { total: 1, items: [old] }, 'unknown', false, 'REMOTE_VERSION_UNCONFIRMED'],
    ['duplicate identity', { total: 2, items: [matching, remoteRow(account, 2)] }, 'unknown', false, 'REMOTE_AMBIGUOUS'],
    ['missing total', { items: [] }, 'unknown', false, 'REMOTE_RECONCILE_FAILED'],
    ['empty partial page', { total: 2, items: [] }, 'unknown', false, 'REMOTE_RECONCILE_FAILED'],
    ['short partial page', { total: 2, items: [remoteRow(sub2Account('other@example.com'))] }, 'unknown', false, 'REMOTE_RECONCILE_FAILED'],
  ];
  for (const [label, listing, status, retryable, code] of cases) await t.test(label, async child => {
    const methods = [];
    const push = await fixture(child, async (_url, options) => {
      methods.push(options.method);
      assert.equal(options.method, 'GET', 'reconciliation must not mutate the destination');
      return sub2Response(listing);
    });
    const { body } = await push('sub2api/reconcile', { settings: settings('sub2api'),
      operationId: `reconcile-${label.replaceAll(' ', '-')}`, itemIds: ['local-row:personal'], accounts: [account],
    });
    assert.deepEqual(body.results.map(row => [row.itemId, row.status, row.retryable, row.code]),
      [['local-row:personal', status, retryable, code]]);
    assert.ok(methods.length > 0);
  });
});

test('a matching row on an early page does not make an incomplete Sub2API listing confirmed', async t => {
  const account = sub2Account();
  const pages = [];
  const push = await fixture(t, async (url, options) => {
    assert.equal(options.method, 'GET');
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    if (page === 2) throw new TypeError('fixture second page unavailable');
    const items = [remoteRow(account), ...Array.from({ length: 99 }, (_, i) => remoteRow(sub2Account(`other-${i}@example.com`), i + 2))];
    return sub2Response({ total: 101, items });
  });
  const { body } = await push('sub2api/reconcile', { settings: settings('sub2api'), accounts: [account], itemIds: ['one'] });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(body.results[0].status, 'unknown');
  assert.equal(body.results[0].retryable, false);
});

test('Sub2API reconciliation follows the declared page size and waits for a complete final page', async t => {
  const account = sub2Account();
  const pages = [];
  const push = await fixture(t, async (url, options) => {
    assert.equal(options.method, 'GET');
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    const items = page === 1 ? [remoteRow(sub2Account('a@example.com')), remoteRow(sub2Account('b@example.com'), 2)] : [remoteRow(account, 3)];
    return sub2Response({ total: 3, page_size: 2, items });
  });
  const { body } = await push('sub2api/reconcile', { settings: settings('sub2api'), accounts: [account], itemIds: ['one'] });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(body.results[0].status, 'success');
});

test('CPA reconciliation lists once before downloading and compares the stored token version', async t => {
  const accounts = ['absent', 'same', 'older'].map(cpaAccount);
  const calls = [];
  const push = await fixture(t, async (url, options) => {
    const parsed = new URL(url);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    calls.push(parsed.pathname);
    if (!parsed.pathname.endsWith('/download')) {
      assert.equal(calls.length, 1);
      return Response.json({ files: accounts.slice(1).map(account => ({ name: cpaFileName(account) })) });
    }
    const account = accounts.find(item => cpaFileName(item) === parsed.searchParams.get('name'));
    assert.ok(account);
    return Response.json(account.account_id === 'same' ? account : { ...account, id_token: 'previous-version' });
  });
  const { body } = await push('cpa/reconcile', { settings: settings('cpa'), operationId: 'reconcile-cpa-1',
    itemIds: ['absent', 'same', 'older'], accounts,
  });
  assert.deepEqual(body.results.map(row => [row.itemId, row.status, row.retryable]),
    [['absent', 'failed', true], ['same', 'success', false], ['older', 'unknown', false]]);
  assert.deepEqual(calls, ['/v0/management/auth-files', '/v0/management/auth-files/download', '/v0/management/auth-files/download']);
});

test('CPA malformed list and unavailable file stay unknown instead of becoming retryable absence', async t => {
  for (const failure of ['list', 'download']) await t.test(failure, async child => {
    const account = cpaAccount('team');
    let downloads = 0;
    const push = await fixture(child, async (url, options) => {
      assert.equal(options.method, 'GET');
      if (new URL(url).pathname.endsWith('/download')) {
        downloads++;
        throw new TypeError('fixture download failed');
      }
      return Response.json(failure === 'list' ? { incomplete: true } : { files: [{ name: cpaFileName(account) }] });
    });
    const { body } = await push('cpa/reconcile', { settings: settings('cpa'), accounts: [account], itemIds: ['workspace'] });
    assert.equal(body.results[0].status, 'unknown');
    assert.equal(body.results[0].retryable, false);
    assert.equal(downloads, failure === 'list' ? 0 : 1);
  });
});

test('CPA rejects incomplete or ambiguous file lists before downloading any credentials', async t => {
  const account = cpaAccount('team');
  const file = { name: cpaFileName(account) };
  const cases = [
    ['missing name', { files: [{}] }],
    ['duplicate names', { files: [file, file] }],
    ['truncated total', { files: [], total: 1 }],
    ['more pages', { files: [], has_more: true }],
    ['next cursor', { files: [], next_cursor: 'remaining' }],
  ];
  for (const [name, list] of cases) await t.test(name, async child => {
    const push = await fixture(child, async (url, options) => {
      assert.equal(options.method, 'GET');
      assert.equal(new URL(url).pathname, '/v0/management/auth-files');
      return Response.json(list);
    });
    const { body } = await push('cpa/reconcile', { settings: settings('cpa'), accounts: [account], itemIds: ['one'] });
    assert.equal(body.results[0].status, 'unknown');
    assert.equal(body.results[0].retryable, false);
  });
});

test('CPA matching filename and tokens cannot confirm a different account or workspace', async t => {
  const account = cpaAccount('team');
  for (const wrong of [{ email: 'different@example.com' }, { account_id: 'different-workspace' }]) {
    const push = await fixture(t, async (url, options) => {
      assert.equal(options.method, 'GET');
      return Response.json(new URL(url).pathname.endsWith('/download')
        ? { ...account, ...wrong } : { files: [{ name: cpaFileName(account) }] });
    });
    const { body } = await push('cpa/reconcile', { settings: settings('cpa'), accounts: [account], itemIds: ['one'] });
    assert.equal(body.results[0].status, 'unknown');
    assert.equal(body.results[0].retryable, false);
  }
});

test('concurrent same-target upserts serialize scanning and creation, so only one remote account is created', async t => {
  const account = sub2Account('serialized@example.com');
  const firstScan = deferred(), allowCreate = deferred();
  const rows = [];
  const calls = [];
  const push = await fixture(t, async (url, options) => {
    calls.push(options.method);
    if (options.method === 'GET') {
      const snapshot = structuredClone(rows);
      if (calls.length === 1) { firstScan.resolve(); await allowCreate.promise; }
      return sub2Response({ total: snapshot.length, items: snapshot });
    }
    if (options.method === 'POST') {
      rows.push(remoteRow(account, 71));
      return sub2Response({ success: 1, results: [{ success: true, id: 71 }] });
    }
    assert.equal(options.method, 'PUT');
    assert.match(url, /\/accounts\/71$/);
    return sub2Response({ id: 71 });
  });
  const body = { settings: settings('sub2api'), accounts: [account], itemIds: ['serialized'], upsert: true };
  const first = push('sub2api', { ...body, operationId: 'serial-first' });
  await firstScan.promise;
  const second = push('sub2api', { ...body, operationId: 'serial-second' });
  await waitFor(() => pushCoordinator.stats().waiting === 1);
  assert.deepEqual(calls, ['GET']);
  allowCreate.resolve();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.body.imported === 1));
  assert.deepEqual(calls, ['GET', 'POST', 'GET', 'PUT']);
  assert.equal(rows.length, 1);
  assert.deepEqual(pushCoordinator.stats(), { activeKeys: 0, waiting: 0 });
});

test('cancelled lock waiters and timed-out multi-key acquisitions leave no retained lock entries', async () => {
  const coordinator = createPushCoordinator();
  const a = sub2Account('lock-a@example.com'), b = sub2Account('lock-b@example.com');
  const started = deferred(), release = deferred();
  const first = coordinator.run('sub2api', 'https://sub2.test', [a], async () => { started.resolve(); await release.promise; });
  await started.promise;
  const controller = new AbortController();
  const cancelled = assert.rejects(coordinator.run('sub2api', 'https://sub2.test', [b, a], () => assert.fail('cancelled work must not start'),
    { signal: controller.signal }), { name: 'AbortError' });
  await waitFor(() => coordinator.stats().waiting === 1);
  controller.abort();
  await cancelled;
  assert.equal(coordinator.stats().waiting, 0);
  assert.equal(coordinator.stats().activeKeys, 1, 'partially acquired keys must be released after cancellation');
  const timeout = assert.rejects(coordinator.run('sub2api', 'https://sub2.test', [b, a], () => assert.fail('timed-out work must not start'),
    { waitMs: 10 }), { code: 'PUSH_QUEUE_TIMEOUT' });
  await Promise.all([timeout, delay(20)]);
  assert.equal(coordinator.stats().activeKeys, 1);
  release.resolve();
  await first;
  assert.deepEqual(coordinator.stats(), { activeKeys: 0, waiting: 0 });
  assert.doesNotMatch(JSON.stringify(coordinator), /lock-[ab]@|private-fixture-|sub2\.test/);
});

test('disconnecting an HTTP request removes its push lock waiter before any remote write', async t => {
  const account = sub2Account('disconnect@example.com');
  const firstScan = deferred(), finish = deferred();
  let reads = 0, writes = 0;
  const push = await fixture(t, async (_url, options) => {
    if (options.method === 'GET') {
      reads++;
      firstScan.resolve();
      await finish.promise;
      return sub2Response({ total: 0, items: [] });
    }
    writes++;
    return sub2Response({ success: 1, results: [{ success: true, id: 91 }] });
  });
  const body = { settings: settings('sub2api'), accounts: [account], itemIds: ['one'], upsert: true };
  const first = push('sub2api', body);
  await firstScan.promise;
  const controller = new AbortController();
  const cancelled = assert.rejects(push('sub2api', body, controller.signal), { name: 'AbortError' });
  await waitFor(() => pushCoordinator.stats().waiting === 1);
  controller.abort();
  await cancelled;
  await waitFor(() => pushCoordinator.stats().waiting === 0);
  assert.equal(reads, 1);
  assert.equal(writes, 0);
  finish.resolve();
  assert.equal((await first).body.imported, 1);
  assert.equal(writes, 1);
  assert.deepEqual(pushCoordinator.stats(), { activeKeys: 0, waiting: 0 });
});
