import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { registerSessionExportRoutes } from '../src/api/routes/session-export-routes.js';

async function listen(app) {
  const server = await new Promise(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function fixture(t, accounts, options = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.requestId = 'req-export-1'; next(); });
  registerSessionExportRoutes(app, { getAccounts: () => accounts, ...options });
  return listen(app).then(({ server, url }) => {
    t.after(() => server.close());
    return { url, headers: { 'content-type': 'application/json' } };
  });
}

test('export-sessions returns JSON sessions and explicit missing accounts without credentials', async t => {
  const token = 'session-token';
  const accounts = [
    {
      id: 'a1', email: 'alive@example.com', session_access_token: token,
      session_json: JSON.stringify({ accessToken: token, email: 'alive@example.com', password: 'must-not-export', two_factor_secret: 'TOTP' }),
      session_health: 'alive',
    },
  ];
  const { url, headers } = await fixture(t, accounts);
  const response = await fetch(`${url}/api/v2/accounts/export-sessions`, {
    method: 'POST', headers, body: JSON.stringify({ ids: ['a1', 'missing'], download: false }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.requestId, 'req-export-1');
  assert.equal(payload.exported, 1);
  assert.deepEqual(payload.missing, [{ id: 'missing', reason: 'account_not_found' }]);
  assert.equal(payload.sessions[0].session.password, undefined);
  assert.equal(payload.sessions[0].session.two_factor_secret, undefined);
  assert.equal(payload.sessions[0].session.accessToken, token);
});

test('aliveOnly probes each session without relogin or mutation and download returns TXT', async t => {
  const accounts = [
    { id: 'alive', email: 'alive@example.com', session_access_token: 'alive-token', session_json: '{"accessToken":"alive-token"}', session_health: 'unknown' },
    { id: 'dead', email: 'dead@example.com', session_access_token: 'dead-token', session_json: '{"accessToken":"dead-token"}', session_health: 'alive' },
  ];
  const probed = [];
  const { url, headers } = await fixture(t, accounts, {
    probeSession: async (account, token) => {
      probed.push([account.id, token]);
      return account.id === 'alive' ? { ok: true, health: 'alive' } : { ok: false, health: 'session_invalid' };
    },
  });
  const response = await fetch(`${url}/api/v2/accounts/export-sessions`, {
    method: 'POST', headers, body: JSON.stringify({ scope: 'all', aliveOnly: true, download: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-export-requested'), '2');
  assert.equal(response.headers.get('x-export-success'), '1');
  assert.match(response.headers.get('content-disposition'), /attachment; filename="chatgpt-sessions-/);
  assert.match(await response.text(), /alive-token/);
  assert.deepEqual(probed, [['alive', 'alive-token'], ['dead', 'dead-token']]);
  assert.equal(accounts[1].session_health, 'alive');
});

test('invalid selection and unavailable alive probe use structured errors', async t => {
  const { url, headers } = await fixture(t, []);
  const invalid = await fetch(`${url}/api/v2/accounts/export-sessions`, { method: 'POST', headers, body: '{}' });
  assert.equal(invalid.status, 400);
  assert.deepEqual((await invalid.json()).error.code, 'INVALID_SELECTION');

  const selected = await fixture(t, [{ id: 'a1', email: 'a@example.com', session_json: '{"accessToken":"a"}' }]);
  const unavailable = await fetch(`${selected.url}/api/v2/accounts/export-sessions`, {
    method: 'POST', headers: selected.headers, body: JSON.stringify({ ids: ['a1'], aliveOnly: true }),
  });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, 'SESSION_PROBE_UNAVAILABLE');
});
