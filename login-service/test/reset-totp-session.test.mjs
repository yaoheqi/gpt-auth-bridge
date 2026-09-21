import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { withCachedWebSession } from '../src/services/cached-web-session.js';
import { createMonitorCoordinator } from '../src/services/monitor-coordinator.js';
import { resolveAccountLoginMethod } from '../src/domain/accounts/account-domain.js';
import { normalizeTotpSecret, validateTotpSecret } from '../lib/totp.js';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const runnerSource = source.slice(source.indexOf('async function runResetTotpForAccount('), source.indexOf('async function runResetTotpForAccounts('));
const newSecret = 'KRSXG5DSNFXGOIDB';

test('reset persists the new secret, same Session and updated cookies for a subsequent logout without another login', async () => {
  for (const cached of [true, false]) {
    const account = { id: 'reset', email: 'reset@example.com', password: 'fixture-password', two_factor_secret: 'JBSWY3DPEHPK3PXP',
      session_access_token: cached ? 'cached-session' : '', storage_state_json: '{"cookies":[]}' };
    const calls = [], done = [];
    let disposed = 0;
    const bindings = {
      nowIso: () => new Date().toISOString(), durationMs: () => 1,
      monitorCoordinator: createMonitorCoordinator(), findAccountById: () => account,
      resolveAccountLoginMethod, normalizeTotpSecret, validateTotpSecret, withCachedWebSession,
      accountRequestNetwork: (_account, network) => network,
      accountRepository: { updateById: async (_id, patch) => Object.assign(account, typeof patch === 'function' ? patch(account) : patch) },
      persistChatGptWebSession: async (_id, data) => Object.assign(account, { session_access_token: data.accessToken,
        session_json: JSON.stringify(data.session), storage_state_json: data.storageState }),
      publicResetTotpCredential: (current, secret) => ({ email: current.email, totp: secret }),
      OpenAIJsonAuthFlow: class {
        constructor(current, _events, network) {
          assert.equal(network.proxyPool, 'http://127.0.0.1:17890');
          assert.equal(network.forbidPhoneChallenge, true);
          current.fingerprint_json = 'fixture-fingerprint';
        }
        log() {}
        async importStoredCookieStorageState() { calls.push('cookies'); }
        async loginChatGptWebWithPasswordTotp() { calls.push('login'); return { accessToken: 'fresh-session', session: { user: { email: account.email } }, storageState: '{"cookies":[]}' }; }
        async resetTotpForSession(token) {
          assert.equal(token, cached ? 'cached-session' : 'fresh-session');
          calls.push('reset');
          return { secret: newSecret, factorId: 'fixture-factor', mfaInfo: { mfa_enabled: true } };
        }
        async exportCookieStorageState() { return '{"cookies":[{"name":"updated-cookie"}]}'; }
        async dispose() { disposed++; }
      },
    };
    const run = new Function(...Object.keys(bindings), `return (${runnerSource.trim()});`)(...Object.values(bindings));
    const result = await run(account, { proxyPool: 'http://127.0.0.1:17890', directWhenProxyPoolEmpty: true, onAccountDone: item => done.push(item) });
    assert.equal(result.ok, true, result.error);
    assert.equal(account.two_factor_secret, newSecret);
    assert.equal(account.raw, [account.email, account.password, newSecret].join('----'));
    assert.equal(account.fingerprint_json, 'fixture-fingerprint');
    assert.match(account.storage_state_json, /updated-cookie/);
    assert.deepEqual(calls, cached ? ['cookies', 'reset'] : ['cookies', 'login', 'reset']);
    assert.equal(done.length, 1);
    assert.equal(disposed, 1);
    // A new request gets the browser snapshot, not the previous flow instance.
    await withCachedWebSession(structuredClone(account), { flow: {
      log() {}, importStoredCookieStorageState: async () => {},
      loginChatGptWebWithPasswordTotp: () => assert.fail('reset already supplied a usable Session'),
    } }, token => assert.equal(token, account.session_access_token));
  }
});
