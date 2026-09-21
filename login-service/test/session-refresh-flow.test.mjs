import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SESSION_HEALTH, shouldRequireExistingSession, sessionHealthLabel } from '../src/services/session-health-service.js';
import { protocolLoginCredentialIssue } from '../src/domain/accounts/account-domain.js';

// Run the production health runner with network/persistence boundaries injected.
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf('async function runSessionHealthCheckForAccount(');
const end = source.indexOf('async function runSessionHealthCheckForAccounts(', start);

function runner({ probe, relogin, overrides = {} }) {
  const bindings = {
    SESSION_HEALTH, shouldRequireExistingSession, sessionHealthLabel,
    nowIso: () => new Date().toISOString(), structuredLog: () => {}, durationMs: () => 0,
    accountHasChatGptSession: account => Boolean(account.session_access_token),
    persistSessionHealth: async () => {}, protocolLoginCredentialIssue: () => '',
    clearAuthStateForFreshLogin: async () => {}, getSessionReloginMaxAttempts: () => 1,
    getProtocolSettings: () => ({}), parseProxyPool: () => [],
    proxyHealthRegistry: { recordSuccess() {}, recordFailure() {} },
    reloginChatGptWebSessionForHealth: relogin,
    probeSessionThroughConfiguredProxy: probe,
    isAccountDeactivatedError: () => false,
    ...overrides,
  };
  return new Function(...Object.keys(bindings), `return (${source.slice(start, end).trim()});`)(...Object.values(bindings));
}

test('forced login accepts the fresh Session without any health probe', async () => {
  let logins = 0;
  const run = runner({
    relogin: async () => { logins++; return { accessToken: 'fresh-session' }; },
    probe: () => assert.fail('fresh Session must not be probed'),
  });
  const result = await run({ id: 'fixture' }, { forceRelogin: true, loginOnly: true });
  assert.equal(result.ok, true);
  assert.equal(result.health, SESSION_HEALTH.ALIVE_REFRESHED);
  assert.equal(logins, 1);
  assert.equal(result.probeStatus, undefined);
});

test('expired Session is probed once before login and never after successful refresh', async () => {
  const events = [];
  const run = runner({
    probe: async () => { events.push('probe'); return { health: SESSION_HEALTH.SESSION_INVALID, status: 401 }; },
    relogin: async () => { events.push('login'); return { accessToken: 'fresh-session' }; },
  });
  const result = await run({ id: 'fixture', session_access_token: 'expired' });
  assert.equal(result.ok, true);
  assert.deepEqual(events, ['probe', 'login']);
});

test('a login response without accessToken remains a failure', async () => {
  const run = runner({
    relogin: async () => ({}),
    probe: () => assert.fail('missing Session must not be probed'),
  });
  const result = await run({ id: 'fixture' }, { forceRelogin: true });
  assert.equal(result.ok, false);
  assert.equal(result.health, SESSION_HEALTH.RELOGIN_FAILED);
  assert.match(result.error, /accessToken/);
});

test('forced and automatic refresh reject incomplete credentials before clearing auth state', async () => {
  for (const options of [{ forceRelogin: true, loginOnly: true }, { forceRelogin: true }, {}]) {
    let probes = 0;
    const run = runner({
      relogin: () => assert.fail('must not start login'),
      probe: async () => { probes++; return { health: SESSION_HEALTH.SESSION_INVALID, status: 401 }; },
      overrides: {
        protocolLoginCredentialIssue,
        clearAuthStateForFreshLogin: () => assert.fail('must preserve saved credentials'),
      },
    });
    const result = await run({
      id: 'fixture', email: 'fixture@example.com',
      session_access_token: 'expired',
    }, options);
    assert.equal(result.ok, false);
    assert.equal(result.missingLoginCredentials, true);
    assert.equal(probes, options.forceRelogin ? 0 : 1);
  }
});
