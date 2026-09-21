import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createApp } from '../src/app/create-app.js';
import { registerProtocolLogoutAllRoutes } from '../src/api/routes/protocol-logout-all-routes.js';
import { monitorCoordinator } from '../src/services/monitor-coordinator.js';
import { readLogoutAllResponse } from '../src/services/logout-all-response.js';

function fixture({ fail = false } = {}) {
  const account = {
    id: fail ? 'logout-all-failure' : 'logout-all-success',
    email: fail ? 'logout-failure@example.com' : 'logout-success@example.com',
    password: 'fixture-password-should-never-leak',
    two_factor_secret: 'JBSWY3DPEHPK3PXP',
  };
  const calls = [];
  let disposed = 0;
  const flow = {
    log() {},
    async importStoredCookieStorageState() {},
    async loginChatGptWebWithPasswordTotp() {
      calls.push('login');
      if (fail) throw new Error('invalid_username_or_password fixture-password-should-never-leak');
      return { accessToken: 'fixture-session-private', session: { user: { email: account.email } } };
    },
    async logoutAllChatGptSessions(token) { assert.equal(token, 'fixture-session-private'); calls.push('logout'); return { status: 200, responseType: 'json-null' }; },
    async dispose() { disposed++; },
  };
  return { account, calls, flow, get disposed() { return disposed; } };
}

async function startRoute(t, f, { stream = false } = {}) {
  const app = createApp();
  registerProtocolLogoutAllRoutes(app, {
    requireAdmin: (_req, _res, next) => next(),
    ensureDatabase: async () => {},
    findAccountById: id => id === f.account.id ? f.account : null,
    getConcurrency: () => 10,
    protocolRequestNetwork: body => ({ proxyPool: body.proxyPool || '' }),
    persistSession: async () => f.calls.push('persist-session'),
    clearAuthState: async () => f.calls.push('clear-auth'),
    createFlow: (_account, network, onLog) => {
      assert.equal(network.proxyPool, 'fixture-proxy');
      onLog({ msg: '提交账号密码', level: 'info' });
      return f.flow;
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const body = { ids: [f.account.id], confirmed: true, proxyPool: 'fixture-proxy', ...(stream ? { stream: true } : {}) };
  return fetch(`http://127.0.0.1:${server.address().port}/api/v2/accounts/protocol-logout-all`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(stream ? { Accept: 'text/event-stream' } : {}) }, body: JSON.stringify(body),
  });
}

function events(text) {
  return [...text.matchAll(/event: ([^\n]+)\ndata: (.+?)\n\n/g)].map(match => ({ name: match[1], data: JSON.parse(match[2]) }));
}

test('protocol logout-all requires confirmation and uses password/TOTP flow', async t => {
  const f = fixture();
  const app = createApp();
  registerProtocolLogoutAllRoutes(app, {
    requireAdmin: (_req, _res, next) => next(), ensureDatabase: async () => {},
    findAccountById: id => id === f.account.id ? f.account : null, getConcurrency: () => 10,
    protocolRequestNetwork: () => ({}), createFlow: () => { throw new Error('must not create flow'); },
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/accounts/protocol-logout-all`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [f.account.id] }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /确认/);
  assert.deepEqual(f.calls, []);
});

test('protocol logout-all emits sanitized progress and summary', async t => {
  const f = fixture();
  const response = await startRoute(t, f, { stream: true });
  assert.equal(response.status, 200);
  const body = await response.text();
  const received = events(body);
  assert.deepEqual(received.map(event => event.name), ['account_start', 'account_log', 'account_done', 'summary', 'done']);
  const summary = received.find(event => event.name === 'summary').data;
  assert.equal(summary.success, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.concurrency, 10);
  assert.equal(f.disposed, 1);
  assert.deepEqual(f.calls, ['login', 'persist-session', 'logout', 'clear-auth']);
  assert.equal(monitorCoordinator.stopReason(f.account), 'sessions_logged_out');
  assert.doesNotMatch(body, /fixture-password|JBSWY3DPEHPK3PXP|fixture-session-private/);
});

test('terminal credential failure is reported and does not leak credentials', async t => {
  const f = fixture({ fail: true });
  const response = await startRoute(t, f);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].terminalReason, 'password_invalid');
  assert.match(result.results[0].error, /密码错误/);
  assert.doesNotMatch(JSON.stringify(result), /fixture-password|JBSWY3DPEHPK3PXP/);
  assert.equal(f.disposed, 1);
  assert.ok(!f.calls.includes('clear-auth'));
});

test('logout uses cached Session after TOTP reset, clears auth only on success and never relogs on 429', async t => {
  for (const rejected of [false, true]) {
    const f = fixture();
    f.account.session_access_token = 'fixture-session-private';
    if (rejected) f.flow.logoutAllChatGptSessions = async () => { throw Object.assign(new Error('logout_all HTTP 429'), { status: 429 }); };
    const result = await (await startRoute(t, f)).json();
    assert.equal(result.results[0].ok, !rejected);
    assert.ok(!f.calls.includes('login'));
    assert.equal(f.calls.includes('clear-auth'), !rejected);
    assert.equal(f.disposed, 1);
  }
});

test('protocol logout clears browser auth after scalar/empty success and retains it on unconfirmed responses', async t => {
  for (const [status, body, ok] of [[200, 'null', true], [204, null, true], [200, 'unexpected private-fixture', false]]) {
    const f = fixture();
    f.account.session_access_token = 'fixture-session-private';
    f.flow.logoutAllChatGptSessions = async () => readLogoutAllResponse(new Response(body, { status }));
    const result = await (await startRoute(t, f)).json();
    assert.equal(result.results[0].ok, ok);
    assert.equal(f.calls.includes('clear-auth'), ok);
    assert.equal(f.calls.includes('login'), false);
    if (ok) {
      assert.equal(result.results[0].logout.status, status);
      assert.equal(monitorCoordinator.stopReason(f.account), 'sessions_logged_out');
    }
    assert.doesNotMatch(JSON.stringify(result), /private-fixture/);
  }
});

test('protocol logout-all cannot overlap another operation for the same account', async t => {
  const f = fixture();
  const { monitorCoordinator } = await import('../src/services/monitor-coordinator.js');
  const app = createApp();
  registerProtocolLogoutAllRoutes(app, {
    requireAdmin: (_req, _res, next) => next(), ensureDatabase: async () => {}, findAccountById: id => id === f.account.id ? f.account : null,
    getConcurrency: () => 10, protocolRequestNetwork: () => ({}), createFlow: () => f.flow,
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/v2/accounts/protocol-logout-all`;
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [f.account.id], confirmed: true }) };
  await monitorCoordinator.runExclusive(f.account.email, async () => {
    const response = await fetch(url, init);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.success, 0);
    assert.equal(result.failed, 1);
    assert.match(result.results[0].error, /正在执行/);
  });
});
