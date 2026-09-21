import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createApp } from '../src/app/create-app.js';
import { selfLeaveWorkspaces, selfLeaveIdentity, clearedWorkspaceCredentials } from '../src/services/workspace-self-leave.js';
import { registerWorkspaceSelfLeaveRoutes } from '../src/api/routes/workspace-self-leave-routes.js';
import { createMonitorCoordinator } from '../src/services/monitor-coordinator.js';

const email = 'member@example.com';
const token = (workspaceId, userId = 'user-self', ownEmail = email) => 'e30.' + Buffer.from(JSON.stringify({ exp: 2100000000,
  'https://api.openai.com/profile': { email: ownEmail },
  'https://api.openai.com/auth': { chatgpt_account_id: workspaceId, chatgpt_user_id: userId } })).toString('base64url') + '.fixture';
const row = (id, role = 'standard-user', plan = 'team') => ({ account: { account_id: id, plan_type: plan, account_user_role: role } });
const catalog = entries => ({ accounts: Object.fromEntries(entries) });

function fixture({ saved = true, role = 'standard-user', handler, workspaces = ['team'] } = {}) {
  const requests = [], logins = [], patches = [], sleeps = [], logs = [];
  const account = { id: 'self-leave-fixture', email, password: 'fixture-password', two_factor_secret: 'JBSWY3DPEHPK3PXP',
    ...(saved ? { openai_access_token: token('personal') } : {}), openai_rt: 'personal-rt',
    business_workspace_id: 'team', business_openai_rt: 'team-rt', business_openai_account_id: 'team',
    business_workspace_credentials: workspaces.map(workspaceId => ({ workspaceId, refreshToken: 'team-rt', accessToken: saved ? token(workspaceId) : '' })) };
  let deleted = new Set();
  const flow = {
    ensureChatGptDeviceCookie: async () => {}, ensureProxyConnectivity: async () => {},
    chatgptBackendHeaders: (accessToken, path, extra) => ({ authorization: `Bearer ${accessToken}`, 'oai-device-id': 'fixture-device', 'x-openai-target-path': path, ...extra }),
    loginCodexWithPhone: async options => { const id = flow.workspaceSelection.workspaceId || 'personal'; logins.push({ id, ...options }); return { access_token: token(id) }; },
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const call = { url, path, ...init };
      requests.push(call);
      const custom = await handler?.(call, { requests, deleted });
      if (custom) return custom;
      if (path.includes('/check/')) return Response.json(catalog([['personal', row('personal', 'owner', 'free')], ...workspaces.filter(id => !deleted.has(id)).map(id => [id, row(id, role)])]));
      const id = path.split('/')[3];
      if (init.method === 'DELETE') { deleted.add(id); return new Response(null, { status: 204 }); }
      return Response.json({ items: deleted.has(id) ? [] : [{ id: 'membership-self', email, role }], total: deleted.has(id) ? 0 : 1 });
    },
  };
  const options = { flow, persist: async patch => patches.push(patch), wait: async ms => sleeps.push(ms), onLog: data => logs.push(data.msg) };
  return { account, options, requests, logins, patches, sleeps, logs };
}

test('self-leave uses its own workspace token/member identity, verifies absence and clears only departed credentials', async () => {
  const f = fixture();
  const result = await selfLeaveWorkspaces(f.account, f.options);
  assert.equal(result.ok, true); assert.equal(result.left, 1);
  const deletion = f.requests.find(request => request.method === 'DELETE');
  assert.equal(deletion.path, '/backend-api/accounts/team/users/membership-self');
  assert.equal(deletion.headers.authorization, `Bearer ${token('team')}`);
  assert.equal(deletion.headers['chatgpt-account-id'], 'team');
  assert.equal(deletion.headers.referer, 'https://chatgpt.com/admin/members');
  assert.equal(deletion.headers['sec-fetch-mode'], 'cors');
  assert.equal(deletion.redirect, 'manual');
  assert.equal(f.logins.length, 0);
  assert.deepEqual(f.patches[0].business_workspace_credentials, []);
  assert.equal(f.patches[0].business_openai_rt, '');
  assert.equal(f.patches[0].openai_rt, undefined);
  assert.doesNotMatch(JSON.stringify(result), /fixture-password|JBSWY|\.fixture/);
});

test('missing AT uses password/TOTP OAuth for personal discovery and targeted workspace without Web Session', async () => {
  const f = fixture({ saved: false });
  assert.equal((await selfLeaveWorkspaces(f.account, f.options)).left, 1);
  assert.deepEqual(f.logins, [{ id: 'personal', preserveAuthSession: false }, { id: 'team', preserveAuthSession: true }]);
});

test('a cached Web Session for the exact team avoids OAuth and is cleared only after verified self-exit', async () => {
  const f = fixture({ saved: false });
  f.account.session_access_token = token('team');
  const result = await selfLeaveWorkspaces(f.account, f.options);
  assert.equal(result.left, 1);
  assert.equal(f.logins.length, 0);
  assert.equal(f.requests.find(call => call.method === 'DELETE').headers.authorization, `Bearer ${token('team')}`);
  assert.equal(f.patches[0].session_access_token, '');
});

test('workspace structure recognizes nonstandard billing plans and excludes personal plans', async () => {
  for (const plan of ['self_serve_business_prolite', 'free', 'future-business-plan']) {
    const f = fixture({ handler: call => call.path.includes('/check/') ? Response.json(catalog([
      ['team', { account: { id: 'team', structure: 'workspace', plan_type: plan, account_user_role: 'standard-user' } }],
      ...['free', 'plus', 'pro', 'team'].map(type => ['personal-' + type,
        { account: { id: 'personal-' + type, structure: 'personal', plan_type: type, account_user_role: 'standard-user' } }]),
    ])) : null });
    const result = await selfLeaveWorkspaces(f.account, f.options);
    assert.equal(result.left, 1);
    assert.deepEqual(f.requests.filter(call => call.method === 'DELETE').map(call => call.path), ['/backend-api/accounts/team/users/membership-self']);
  }
  const unknown = fixture({ handler: call => call.path.includes('/check/')
    ? Response.json(catalog([['team', row('team', 'standard-user', 'unrecognized-plan')]])) : null });
  const result = await selfLeaveWorkspaces(unknown.account, unknown.options);
  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  assert.ok(!unknown.requests.some(call => call.method === 'DELETE'));
});

test('nullable member emails do not prevent self-leave or omit rows from verification', async () => {
  for (const ownEmail of [email, null]) {
    const f = fixture({ handler: (call, { deleted }) => {
      if (!call.path.endsWith('/users')) return null;
      const items = [{ id: 'unrelated-user', account_user_id: 'unrelated-membership', email: null, role: 'standard-user' },
        ...(!deleted.size ? [{ id: 'user-self', account_user_id: 'own-membership', email: ownEmail, role: 'standard-user' }] : [])];
      return Response.json({ items, total: items.length });
    } });
    assert.equal((await selfLeaveWorkspaces(f.account, f.options)).left, 1);
    assert.equal(f.requests.find(call => call.method === 'DELETE').path, '/backend-api/accounts/team/users/user-self');
  }
  const stillPresent = fixture({ handler: call => call.path.endsWith('/users')
    ? Response.json({ items: [{ id: 'user-self', email: null, role: 'standard-user' }], total: 1 }) : null });
  assert.equal((await selfLeaveWorkspaces(stillPresent.account, stillPresent.options)).unconfirmed, 1);
});

test('missing member IDs, mismatched and ambiguous identities never authorize deletion', async () => {
  for (const items of [
    [{ id: null, email }],
    [{ id: 'unknown', email: null }],
    [{ id: 'user-self', email: 'someone@example.com' }],
    [{ id: 'user-self', email: null }, { id: 'different-user', email }],
  ]) {
    const f = fixture({ handler: call => call.path.endsWith('/users') ? Response.json({ items, total: items.length }) : null });
    assert.equal((await selfLeaveWorkspaces(f.account, f.options)).failed, 1);
    assert.ok(!f.requests.some(call => call.method === 'DELETE'));
  }
});

test('owner and unknown roles are skipped, and missing or mismatched identity can never delete another member', async () => {
  for (const role of ['owner', 'unknown']) {
    const f = fixture({ role });
    const result = await selfLeaveWorkspaces(f.account, f.options);
    assert.equal(result.skipped, 1);
    assert.equal(f.requests.filter(row => row.method === 'DELETE').length, 0);
  }
  for (const accessToken of [token('other-team'), token('team', ''), token('team', 'user-other'), token('team', 'user-self', 'other@example.com')]) {
    const f = fixture();
    f.account.business_workspace_credentials[0].accessToken = accessToken;
    assert.equal((await selfLeaveWorkspaces(f.account, f.options)).failed, 1);
    assert.equal(f.requests.filter(row => row.method === 'DELETE').length, 0);
  }
  assert.throws(() => selfLeaveIdentity(token('personal'), 'team', email), /不匹配/);
});

test('409 and 429 retry at 5/10/15 seconds, while 401/403 reauthenticates only once', async () => {
  for (const status of [409, 401, 403, 429]) {
    const f = fixture({ handler: call => call.method === 'DELETE' ? Response.json({}, { status }) : null });
    assert.equal((await selfLeaveWorkspaces(f.account, f.options)).failed, 1);
    assert.deepEqual(f.sleeps, [409, 429].includes(status) ? [5000, 10000, 15000] : []);
    assert.equal(f.logins.length, [401, 403].includes(status) ? 1 : 0);
    assert.equal(f.requests.filter(row => row.method === 'DELETE').length, [409, 429].includes(status) ? 4 : 2);
  }
  const rejected = fixture({ saved: true, workspaces: ['team', 'other'], handler: call => call.method === 'DELETE' ? Response.json({}, { status: 401 }) : null });
  rejected.options.flow.loginCodexWithPhone = async () => { throw new Error('invalid_username_or_password'); };
  const result = await selfLeaveWorkspaces(rejected.account, rejected.options);
  assert.equal(result.terminalReason, 'password_invalid');
  assert.equal(result.skipped, 1);
  assert.ok(!rejected.requests.some(row => row.path.includes('/other/')));
});

test('429 recovery verifies membership before clearing credentials and stops retrying on success', async () => {
  for (const limitedAttempts of [1, 2, 3]) {
    let attempts = 0;
    const f = fixture({ handler: call => call.method === 'DELETE' && ++attempts <= limitedAttempts ? Response.json({}, { status: 429 }) : null });
    const result = await selfLeaveWorkspaces(f.account, f.options);
    assert.equal(result.left, 1);
    assert.equal(attempts, limitedAttempts + 1);
    assert.deepEqual(f.sleeps, [5000, 10000, 15000].slice(0, limitedAttempts));
    assert.equal(f.logins.length, 0);
    assert.equal(f.patches.length, 1);
    assert.equal(f.logs.filter(line => line.includes('HTTP 429')).length, limitedAttempts);
    assert.ok(f.requests.at(-1).path.endsWith('/users') && f.requests.at(-1).method === 'GET');
  }
  let attempts = 0;
  const stillPresent = fixture({ handler: call => {
    if (call.method === 'DELETE' && ++attempts === 1) return Response.json({}, { status: 429 });
    if (call.path.endsWith('/users')) return Response.json({ items: [{ id: 'membership-self', email }], total: 1 });
  } });
  assert.equal((await selfLeaveWorkspaces(stillPresent.account, stillPresent.options)).unconfirmed, 1);
  assert.equal(stillPresent.patches.length, 0);
});

test('429 retry limits are separate from conflicts and reset for each workspace', async () => {
  const attempts = new Map();
  const f = fixture({ workspaces: ['team', 'other'], handler: call => {
    if (call.method !== 'DELETE') return null;
    const id = call.path.split('/')[3];
    const count = (attempts.get(id) || 0) + 1;
    attempts.set(id, count);
    if (count === 1) return Response.json({}, { status: 409 });
    return id === 'team' || count < 5 ? Response.json({}, { status: 429 }) : null;
  } });
  const result = await selfLeaveWorkspaces(f.account, f.options);
  assert.equal(result.failed, 1);
  assert.equal(result.left, 1);
  assert.equal(result.unconfirmed, 0);
  assert.deepEqual([...attempts.values()], [5, 5]);
  assert.deepEqual(f.sleeps, [5000, 5000, 10000, 15000, 5000, 5000, 10000, 15000]);
  assert.deepEqual(f.patches[0].business_workspace_credentials.map(row => row.workspaceId), ['team']);
});

test('cancelling during a 429 delay prevents another delete or a subsequent workspace', async () => {
  const controller = new AbortController();
  const f = fixture({ workspaces: ['team', 'other'], handler: call => call.method === 'DELETE' ? Response.json({}, { status: 429 }) : null });
  f.options.signal = controller.signal;
  f.options.wait = async ms => { f.sleeps.push(ms); controller.abort(); controller.signal.throwIfAborted(); };
  await assert.rejects(selfLeaveWorkspaces(f.account, f.options), { name: 'AbortError' });
  assert.deepEqual(f.sleeps, [5000]);
  assert.equal(f.requests.filter(call => call.method === 'DELETE').length, 1);
  assert.ok(!f.requests.some(call => call.path.includes('/other/')));
  assert.equal(f.patches.length, 0);
});

test('loss of member-list access requires complete own-membership absence; 2xx or 403 alone is unconfirmed', async () => {
  for (const absent of [true, false]) {
    const f = fixture({ handler: (call, { deleted }) => {
      if (call.path.endsWith('/users')) return Response.json({}, { status: 403 });
      if (call.path.includes('/check/') && deleted.size && !absent) return Response.json(catalog([['team', row('team')]]));
    } });
    const result = await selfLeaveWorkspaces(f.account, f.options);
    assert.equal(result.left, absent ? 1 : 0);
    assert.equal(result.unconfirmed, absent ? 0 : 1);
    assert.equal(f.patches.length, absent ? 1 : 0);
    assert.ok(f.requests.find(call => call.path === '/backend-api/accounts/team/users/user-self' && call.method === 'DELETE'));
  }
  // A readable positive membership snapshot wins over a contradictory account catalog.
  const stillPresent = fixture({ handler: call => call.path.endsWith('/users')
    ? Response.json({ items: [{ id: 'membership-self', email, role: 'standard-user' }], total: 1 }) : null });
  assert.equal((await selfLeaveWorkspaces(stillPresent.account, stillPresent.options)).unconfirmed, 1);
});

test('partial membership pages and malformed catalogs cannot authorize deletion', async () => {
  for (const payload of [{ items: [], total: 101 }, { items: [{ id: 'someone', email: 'someone@example.com' }], total: 2 }]) {
    const f = fixture({ handler: call => call.path.endsWith('/users') ? Response.json(payload) : null });
    assert.equal((await selfLeaveWorkspaces(f.account, f.options)).failed, 1);
    assert.ok(!f.requests.some(row => row.method === 'DELETE'));
  }
  const f = fixture({ handler: call => call.path.includes('/check/') ? Response.json({ accounts: { team: {} } }) : null });
  await assert.rejects(selfLeaveWorkspaces(f.account, f.options), /不完整/);
});

test('network uncertainty is not counted as failure safe to retry, partial success is saved, cancellation stops later workspaces', async () => {
  const f = fixture({ workspaces: ['team', 'other'], handler: call => {
    if (call.method === 'DELETE' && call.path.includes('/other/')) throw new Error('network disconnected');
  } });
  const result = await selfLeaveWorkspaces(f.account, f.options);
  assert.equal(result.left, 1); assert.equal(result.unconfirmed, 1);
  assert.deepEqual(f.patches[0].business_workspace_credentials.map(row => row.workspaceId), ['other']);
  const controller = new AbortController();
  const aborting = fixture({ handler: call => {
    if (call.method === 'DELETE') { controller.abort(); return Response.json({}, { status: 409 }); }
  } });
  aborting.options.signal = controller.signal;
  aborting.options.wait = async () => controller.signal.throwIfAborted();
  await assert.rejects(selfLeaveWorkspaces(aborting.account, aborting.options), { name: 'AbortError' });
  assert.equal(aborting.requests.filter(row => row.method === 'DELETE').length, 1);
});

test('cleanup never removes a different workspace or the personal RT', () => {
  const f = fixture({ workspaces: ['team', 'other'] });
  const patch = clearedWorkspaceCredentials(f.account, ['other']);
  assert.equal(patch.business_openai_rt, undefined);
  assert.equal(patch.openai_rt, undefined);
  assert.deepEqual(patch.business_workspace_credentials.map(row => row.workspaceId), ['team']);
});

test('manual self-leave preempts idle monitor ownership but cannot overlap active work', async () => {
  const coordinator = createMonitorCoordinator();
  const account = { id: 'a', email };
  const owner = '77777777-7777-4777-8777-777777777777';
  coordinator.claim([account], owner);
  await coordinator.runExclusive(email, async () => {
    assert.equal(coordinator.claim([account], owner)[0].owned, false);
    await assert.rejects(coordinator.runExclusive(email, () => assert.fail()), /正在执行/);
  });
  assert.equal(coordinator.claim([account], owner)[0].owned, true);
  await coordinator.run([email], owner, () => assert.rejects(coordinator.runExclusive(email, () => assert.fail()), /正在执行/));
});

test('self-leave route requires confirmation, preserves request proxy, obeys server concurrency and disposes flows', async t => {
  const app = createApp();
  const f = fixture();
  let disposed = 0, created = 0;
  registerWorkspaceSelfLeaveRoutes(app, {
    requireAdmin: (_req, _res, next) => next(), ensureDatabase: async () => {}, findAccountById: id => id === f.account.id ? f.account : null,
    getConcurrency: () => 10, protocolRequestNetwork: body => ({ proxyPool: body.proxyPool }), updateAccount: async () => {},
    createFlow: (_account, network) => { created++; assert.equal(network.proxyPool, 'fixture-proxy'); return { ...f.options.flow, importStoredCookieStorageState: async () => {}, dispose: async () => { disposed++; } }; },
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const send = body => fetch(`http://127.0.0.1:${server.address().port}/api/v2/accounts/self-leave`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [f.account.id], concurrency: 50, proxyPool: 'fixture-proxy', ...body }) });
  assert.equal((await send({})).status, 400); assert.equal(created, 0);
  const response = await send({ confirmed: true });
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.concurrency, 10); assert.equal(result.left, 1);
  assert.equal(disposed, 1);
});
