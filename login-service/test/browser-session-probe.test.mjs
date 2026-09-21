import assert from 'node:assert/strict';
import test from 'node:test';
import { probeBrowserAccount } from '../src/services/browser-session-probe.js';
import { once } from 'node:events';
import { createApp } from '../src/app/create-app.js';
import { registerBrowserSessionProbeRoute, registerProtocolPipelineRoutes } from '../src/api/routes/protocol-pipeline-routes.js';
import { monitorCoordinator } from '../src/services/monitor-coordinator.js';

test('monitor probes Web Session and every OAuth workspace without mutating credentials', async () => {
  const account = { id: 'a', session_access_token: 'web', openai_access_token: 'personal', openai_account_id: 'personal',
    business_workspace_credentials: [{ workspaceId: 'team', accessToken: 'business' }] };
  const original = structuredClone(account);
  const seen = [];
  const result = await probeBrowserAccount(account, {
    probeSession: async current => { assert.equal(current.session_access_token, 'web'); return { health: 'alive' }; },
    probeToken: async token => { seen.push(token.accountId); return { status: token.accountId === 'team' ? 401 : 200 }; },
  });
  assert.deepEqual(result, { id: 'a', health: 'session_invalid', sessionInvalid: false });
  assert.deepEqual(seen, ['personal', 'team']);
  assert.deepEqual(account, original);
});

test('network failures, throttling and challenges do not cause monitor relogin; deactivation wins', async () => {
  for (const status of [0, 403, 429, 500]) {
    const result = await probeBrowserAccount({ id: 'a', openai_access_token: 'token' }, {
      probeToken: async () => ({ status }),
    });
    assert.equal(result.health, 'probe_failed');
  }
  assert.equal((await probeBrowserAccount({ id: 'a', session_access_token: 'web', openai_access_token: 'oauth' }, {
    probeSession: async () => ({ health: 'session_invalid' }),
    probeToken: async () => ({ status: 401, code: 'account_deactivated' }),
  })).health, 'deactivated');
});

test('missing tokens never trigger a login probe', async () => {
  assert.equal((await probeBrowserAccount({ id: 'a' }, {})).health, 'no_session');
});

test('monitor routes reject a second browser and terminal retries, while manual recovery clears the stop', async t => {
  const app = createApp();
  const account = { id: 'guarded', email: 'guarded@example.com', password: 'fixture-password', two_factor_secret: 'JBSWY3DPEHPK3PXP', session_access_token: 'fixture-token' };
  const owner = '55555555-5555-4555-8555-555555555555';
  const peer = '66666666-6666-4666-8666-666666666666';
  let logins = 0, probes = 0, fail = true;
  const deps = {
    requireAdmin: (_req, _res, next) => next(), ensureDatabase: async () => {},
    findAccountById: id => id === account.id ? account : null,
    getSessionReloginConcurrency: () => 10, protocolRequestNetwork: () => ({}),
    accountRequestNetwork: () => ({}), publicAccountView: current => ({ id: current.id }),
    probeSessionThroughConfiguredProxy: async () => { probes++; return { health: 'session_invalid' }; },
    runAllWorkspaceCodexAuthForAccount: async () => { logins++; if (fail) throw new Error('invalid_username_or_password'); return { ok: true, personalOk: true }; },
  };
  registerBrowserSessionProbeRoute(app, deps);
  registerProtocolPipelineRoutes(app, deps);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { monitorCoordinator.release([account], owner); monitorCoordinator.release([account], peer); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const post = async (path, monitorOwner) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/accounts/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [account.id], monitorOwner, workspaceMode: 'all' }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).results[0];
  };
  assert.equal((await post('monitor-lease', owner)).owned, true);
  assert.equal((await post('monitor-lease', peer)).owned, false);
  assert.equal((await post('session-probe', peer)).health, 'monitor_busy');
  assert.equal((await post('protocol-login-pipeline', peer)).monitorBusy, true);
  assert.equal(probes + logins, 0);
  assert.equal((await post('session-probe', owner)).health, 'session_invalid');
  assert.equal((await post('protocol-login-pipeline', owner)).terminalReason, 'password_invalid');
  for (const browser of [owner, peer]) {
    assert.equal((await post('monitor-lease', browser)).terminalReason, 'password_invalid');
    assert.equal((await post('protocol-login-pipeline', browser)).terminalReason, 'password_invalid');
    assert.equal((await post('session-probe', browser)).terminalReason, 'password_invalid');
  }
  assert.equal(logins, 1);
  assert.equal(probes, 1);
  fail = false;
  assert.equal((await post('protocol-login-pipeline')).ok, true);
  assert.equal((await post('monitor-lease', owner)).owned, true);
});

test('browser probe route selects request proxy, obeys server concurrency and never returns raw upstream data', async t => {
  const app = createApp();
  const options = [];
  registerBrowserSessionProbeRoute(app, {
    requireAdmin: (_req, _res, next) => next(), ensureDatabase: async () => {},
    findAccountById: id => id === 'a' ? { id, session_access_token: 'fixture-secret', storage_state_json: 'cookie', fingerprint_json: 'fingerprint' } : null,
    getSessionReloginConcurrency: () => 10,
    protocolRequestNetwork: body => ({ proxyPool: body.proxyMode === 'direct' ? '' : 'http://fixture:1234' }),
    accountRequestNetwork: (_account, network) => network,
    probeSessionThroughConfiguredProxy: async (token, cookies, fingerprint, network) => {
      assert.equal(token, 'fixture-secret'); assert.equal(cookies, 'cookie'); assert.equal(fingerprint, 'fingerprint');
      options.push(network);
      return { health: 'alive', body: 'private-upstream-payload' };
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  for (const proxyMode of ['direct', 'builtin']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/accounts/session-probe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['a'], proxyMode, concurrency: 50 }),
    });
    const result = await response.json();
    assert.equal(result.concurrency, 10);
    assert.equal(result.results[0].health, 'alive');
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret|private-upstream|cookie|fingerprint/);
  }
  assert.deepEqual(options, [{ exactProxyUrl: '', direct: true }, { exactProxyUrl: 'http://fixture:1234', direct: false }]);
});
