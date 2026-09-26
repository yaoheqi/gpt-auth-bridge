import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createApp } from '../src/app/create-app.js';
import { registerRemotePushRoutes, normalizePushUrl, cpaFileName } from '../lib/remote-push.js';
import { assertSub2ApiAccountShape } from '../lib/export-sub2api.js';
import { monitorCoordinator } from '../src/services/monitor-coordinator.js';

const sub2Account = name => ({ name, platform: 'openai', type: 'oauth', credentials: { access_token: 'fixture-access', refresh_token: 'fixture-rt', email: name } });
const cpaAccount = id => ({ type: 'codex', email: 'fixture@example.com', account_id: id, access_token: 'fixture-access', refresh_token: `fixture-${id}` });

test('stale browser leases cannot deliver automated pushes to either destination', async t => {
  const push = await fixture(t, () => assert.fail('must reject before external network'));
  const holder = '33333333-3333-4333-8333-333333333333';
  const stale = '44444444-4444-4444-8444-444444444444';
  const account = { id: 'fenced', email: 'fenced@example.com' };
  monitorCoordinator.claim([account], holder);
  t.after(() => monitorCoordinator.release([account], holder));
  for (const target of ['sub2api', 'cpa']) {
    const result = await push(target, { monitorOwner: stale, accounts: [target === 'sub2api' ? sub2Account(account.email) : { ...cpaAccount('team'), email: account.email }] });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'MONITOR_LEASE_LOST');
  }
});

test('monitor updates the exact email/workspace within selected groups and preserves remote settings', async t => {
  const calls = [];
  const input = sub2Account('a@example.com');
  input.credentials.chatgpt_account_id = 'team';
  const push = await fixture(t, async (url, options) => {
    calls.push(options.method);
    if (options.method === 'GET') {
      assert.equal(new URL(url).searchParams.get('group'), '7');
      assert.equal(new URL(url).searchParams.has('search'), false);
      return Response.json({ code: 0, data: { total: 3, items: [
        { id: 1, platform: 'openai', type: 'oauth', group_ids: [7], credentials: { email: 'other@example.com', chatgpt_account_id: 'team' } },
        { id: 2, platform: 'openai', type: 'oauth', group_ids: [8], credentials: input.credentials },
        { id: 3, name: 'renamed-by-operator', platform: 'openai', type: 'oauth', group_ids: [7], credentials: { ...input.credentials, preserved: true } },
      ] } });
    }
    assert.equal(url, 'https://sub2.test/api/v1/admin/accounts/3');
    assert.equal(options.method, 'PUT');
    assert.deepEqual(JSON.parse(options.body), { credentials: { ...input.credentials, preserved: true } });
    return Response.json({ code: 0, data: { id: 3 } });
  });
  const result = await push('sub2api', { settings: { baseUrl: 'https://sub2.test', adminApiKey: 'key', groupIds: [7] }, accounts: [input], upsert: true });
  assert.equal(result.body.imported, 1);
  assert.deepEqual(calls, ['GET', 'PUT']);
});

test('monitor refuses ambiguous Sub2API updates and creates only after a complete empty search', async t => {
  let duplicate = true;
  const account = sub2Account('a@example.com');
  account.credentials.chatgpt_account_id = 'personal';
  const methods = [];
  const push = await fixture(t, async (_url, options) => {
    methods.push(options.method);
    if (options.method === 'GET') return Response.json({ code: 0, data: { total: duplicate ? 2 : 0, items: duplicate ? [1, 2].map(id => ({ ...account, id, group_ids: [7] })) : [] } });
    assert.equal(options.method, 'POST');
    return Response.json({ code: 0, data: { success: 1, results: [{ success: true }] } });
  });
  const body = { settings: { baseUrl: 'https://sub2.test', adminApiKey: 'key', groupIds: [7] }, accounts: [account], upsert: true };
  assert.equal((await push('sub2api', body)).body.failed, 1);
  assert.deepEqual(methods, ['GET']);
  duplicate = false;
  assert.equal((await push('sub2api', body)).body.imported, 1);
  assert.deepEqual(methods, ['GET', 'GET', 'POST']);
});
async function fixture(t, fetchImpl) {
  const app = createApp();
  registerRemotePushRoutes(app, { fetchImpl });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/push/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, body: await response.json() };
  };
}
test('Sub2API uses batch creation contract and reports partial results without echoing credentials', async t => {
  const push = await fixture(t, async (url, options) => {
    assert.equal(url, 'https://sub2.test/prefix/api/v1/admin/accounts/batch');
    assert.equal(options.headers['x-api-key'], 'fixture-secret');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.accounts.map(row => row.group_ids), [[7, 9], [7, 9]]);
    return Response.json({ code: 0, data: { success: 1, failed: 1, results: [{ success: true, id: 123 }, { success: false, error: 'secret fixture-access' }] } });
  });
  const result = await push('sub2api', { settings: { baseUrl: 'https://sub2.test/prefix/admin', adminApiKey: 'fixture-secret', groupIds: [7, 9] }, accounts: [sub2Account('a@example.com'), sub2Account('b@example.com')] });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.imported, 1);
  assert.equal(result.body.failed, 1);
  assert.deepEqual(result.body.results.map(row => row.status), ['success', 'failed']);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|fixture-access|fixture-rt|browserState/);
});
test('Sub2API unrecognized success response is unconfirmed, never counted as imported', async t => {
  const push = await fixture(t, async () => Response.json({ code: 0, data: {} }));
  const { body } = await push('sub2api', { settings: { baseUrl: 'https://sub2.test', adminApiKey: 'key', groupIds: [1] }, accounts: [sub2Account('fixture@example.com')] });
  assert.equal(body.imported, 0);
  assert.equal(body.unknown, 1);
});

test('Sub2API push accepts access-token-only accounts without weakening RT export validation', async t => {
  const accessOnly = sub2Account('at-only@example.com');
  delete accessOnly.credentials.refresh_token;
  const refreshable = sub2Account('rt@example.com');
  assert.throws(() => assertSub2ApiAccountShape(accessOnly), /refresh_token/);
  const push = await fixture(t, async (_url, options) => {
    const { accounts } = JSON.parse(options.body);
    assert.equal(accounts[0].credentials.access_token, 'fixture-access');
    assert.equal(accounts[0].credentials.refresh_token, undefined);
    assert.equal(accounts[1].credentials.refresh_token, 'fixture-rt');
    assert.deepEqual(accounts.map(row => row.group_ids), [[7], [7]]);
    return Response.json({ code: 0, data: { success: 2, failed: 0 } });
  });
  const result = await push('sub2api', { settings: { baseUrl: 'https://sub2.test', adminApiKey: 'fixture-key', groupIds: [7] }, accounts: [accessOnly, refreshable] });
  assert.equal(result.status, 200);
  assert.equal(result.body.imported, 2);
});

test('invalid Sub2API credentials identify the row and missing field before any remote request', async t => {
  const push = await fixture(t, async () => assert.fail('must not contact remote'));
  for (const access_token of [undefined, '', '  ', 123, {}]) {
    const invalid = { ...sub2Account('private@example.com'), credentials: { refresh_token: 'private-refresh', access_token } };
    const result = await push('sub2api', { settings: { baseUrl: 'https://sub2.test', adminApiKey: 'private-key', groupIds: [7] }, accounts: [sub2Account('valid'), invalid] });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'INVALID_PUSH_PAYLOAD');
    assert.match(result.body.error, /第 2 个 Sub2API 账号.*credentials.access_token/);
    assert.equal(result.body.error, result.body.detail);
    assert.doesNotMatch(JSON.stringify(result.body), /private-|private@|网络连接/);
  }
});
test('CPA uploads one Codex JSON per workspace with stable distinct filenames and per-file errors', async t => {
  const seen = [];
  const push = await fixture(t, async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/prefix/v0/management/auth-files');
    assert.equal(options.headers.Authorization, 'Bearer fixture-management-key');
    assert.equal(options.redirect, 'error');
    const account = JSON.parse(options.body);
    const name = parsed.searchParams.get('name');
    assert.equal(name, cpaFileName(account));
    assert.equal(account.type, 'codex');
    assert.equal(account.refresh_token, `fixture-${account.account_id}`);
    seen.push(name);
    return account.account_id === 'team' ? Response.json({ error: 'fixture-management-key' }, { status: 403 }) : Response.json({ status: 'ok' });
  });
  const { body } = await push('cpa', { settings: { baseUrl: 'https://cpa.test/prefix/management.html#/auth-files', managementKey: 'fixture-management-key' }, accounts: [cpaAccount('personal'), cpaAccount('team')] });
  assert.equal(new Set(seen).size, 2);
  assert.equal(body.imported, 1);
  assert.equal(body.failed, 1);
  assert.match(body.results[1].error, /403/);
  assert.doesNotMatch(JSON.stringify(body), /fixture-management-key|fixture-access/);
});
test('CPA connection check is read-only and separate requests cannot reuse earlier keys', async t => {
  let calls = 0;
  const push = await fixture(t, async (_url, options) => {
    calls++;
    assert.equal(options.method, 'GET');
    return Response.json({ files: [{ name: 'fixture.json' }] });
  });
  const first = await push('cpa/check', { settings: { baseUrl: 'https://cpa.test', managementKey: 'fixture-key' } });
  assert.equal(first.body.ok, true);
  assert.equal(first.body.files, 1);
  assert.equal(first.body.schemaVersion, '1.0.0');
  const second = await push('cpa/check', { settings: { baseUrl: 'https://cpa.test' } });
  assert.equal(second.status, 400);
  assert.equal(calls, 1);
});
test('push validates payloads and URLs before contacting the remote', async t => {
  const push = await fixture(t, async () => assert.fail('must not contact remote'));
  for (const [target, accounts] of [['cpa', [{ type: 'openai', access_token: 'x' }]], ['sub2api', [sub2Account('x')]], ['cpa', []]]) {
    assert.equal((await push(target, { settings: {}, accounts })).status, 400);
  }
  assert.throws(() => normalizePushUrl('https://user:pass@example.com', 'cpa'));
  assert.equal(normalizePushUrl('https://cpa.test/v0/management/auth-files', 'cpa'), 'https://cpa.test');
  assert.equal(normalizePushUrl('sub2.test/api/v1/admin', 'sub2api'), 'https://sub2.test');
  assert.doesNotMatch(cpaFileName({ email: '../../bad\\name@example.com', account_id: 'team' }), /[/\\]/);
});
