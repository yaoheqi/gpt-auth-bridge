import assert from 'node:assert/strict';
import test from 'node:test';
import { createMonitorCoordinator } from '../src/services/monitor-coordinator.js';
import { createTotpService } from '../src/services/auth/totp-service.js';
import { createAccountSecurityMethods } from '../src/services/auth/flow/account-security.js';
import { normalizeDbAccount, protocolLoginCredentialIssue } from '../src/domain/accounts/account-domain.js';
import { createSqliteRuntime } from '../src/bootstrap/sqlite-runtime.js';

const oldSecret = 'JBSWY3DPEHPK3PXP', newSecret = 'KRSXG5DSNFXGOIDB';
function fixture({ cached = true, failActivate = false, failInfo = false, factorId = 'new-factor' } = {}) {
  const account = { id: 'reset', email: 'reset@example.com', password: 'fixture-password', two_factor_secret: oldSecret,
    session_access_token: cached ? 'cached-session' : '', storage_state_json: '{"cookies":[]}' };
  const calls = [];
  let active = false;
  class Flow {
    constructor(current) { this.account = current; current.fingerprint_json = 'fixture-fingerprint'; }
    log() {}
    async ensureChatGptDeviceCookie() {}
    async importStoredCookieStorageState() { calls.push('cookies'); }
    async loginChatGptWebWithPasswordTotp() {
      calls.push('login');
      return { accessToken: 'fresh-session', session: { user: { email: account.email } }, storageState: '{"cookies":[]}' };
    }
    async getMfaInfo() {
      calls.push('info');
      if (active && failInfo) throw Object.assign(new Error('mfa_info HTTP 500'), { status: 500 });
      return { mfa_enabled: true, factors: { totp: [{ id: active ? 'new-factor' : 'old-factor' }] } };
    }
    async disableTotpMfa() { calls.push('disable'); }
    async enrollTotpMfa() { calls.push('enroll'); return { secret: newSecret, session_id: 'fixture-enrollment', factor: { id: factorId } }; }
    async activateTotpEnrollment() {
      calls.push('activate'); active = true;
      if (failActivate) throw Object.assign(new Error('activation response lost'), { status: 401 });
      return { success: true };
    }
    async exportCookieStorageState() { return '{"cookies":[{"name":"updated-cookie"}]}'; }
    async dispose() { calls.push('dispose'); }
  }
  const methods = createAccountSecurityMethods();
  for (const name of ['prepareTotpResetForSession', 'activatePreparedTotpForSession', 'confirmTotpResetForSession']) Flow.prototype[name] = methods[name];
  const service = createTotpService({
    OpenAIJsonAuthFlow: Flow, monitorCoordinator: createMonitorCoordinator(), findAccountById: () => account,
    accountRequestNetwork: () => ({}),
    accountRepository: { updateById: async (_id, patch) => Object.assign(account, typeof patch === 'function' ? patch(account) : patch) },
    persistChatGptWebSession: async (_id, data) => Object.assign(account, { session_access_token: data.accessToken,
      session_json: JSON.stringify(data.session), storage_state_json: data.storageState }),
  });
  const run = action => service.runResetTotpForAccount(structuredClone(account), { action });
  return { account, calls, run, repairInfo: () => { failInfo = false; } };
}

test('prepare never activates; only the next request commits the new secret and preserves Session/cookies', async () => {
  for (const cached of [true, false]) {
    const { account, calls, run } = fixture({ cached });
    assert.equal((await run('prepare')).ok, true);
    assert.equal(account.two_factor_secret, oldSecret);
    assert.equal(account.totp_reset_pending.secret, newSecret);
    assert.equal(account.totp_reset_pending.phase, 'prepared');
    assert.equal(calls.includes('activate'), false);
    assert.match(account.storage_state_json, /updated-cookie/);
    assert.equal((await run('prepare')).ok, true);
    assert.equal(calls.filter(x => x === 'enroll').length, 1);
    account.totp_reset_pending.phase = 'activating'; // browser saves this before sending
    assert.equal((await run('activate')).ok, true);
    assert.equal(account.two_factor_secret, newSecret);
    assert.equal(account.raw, [account.email, account.password, newSecret].join('----'));
    assert.equal(account.totp_reset_pending, null);
    assert.equal(calls.filter(x => x === 'login').length, cached ? 0 : 1);
  }
});

test('HTTP 500 after accepted activation retains the new primary key and can be confirmed without re-enrollment', async () => {
  const { account, calls, run, repairInfo } = fixture({ failInfo: true });
  await run('prepare');
  account.totp_reset_pending.phase = 'activating';
  const result = await run('activate');
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'activated');
  assert.equal(account.two_factor_secret, newSecret);
  assert.equal(account.totp_reset_pending.secret, newSecret);
  assert.match(account.status, /待确认/);
  repairInfo();
  assert.equal((await run('confirm')).ok, true);
  assert.equal(account.totp_reset_pending, null);
  assert.equal(calls.filter(x => x === 'enroll').length, 1);
  assert.equal(calls.filter(x => x === 'activate').length, 1);
  assert.equal(calls.includes('login'), false);
});

test('lost activation response keeps candidate and does not retry with old TOTP; read-only confirmation matches factor', async () => {
  const { account, calls, run } = fixture({ failActivate: true });
  await run('prepare');
  account.totp_reset_pending.phase = 'activating';
  assert.equal((await run('activate')).ok, false);
  assert.equal(account.totp_reset_pending.secret, newSecret);
  assert.match(protocolLoginCredentialIssue(account), /2FA/);
  assert.equal((await run('confirm')).ok, true);
  assert.equal(account.two_factor_secret, newSecret);
  assert.equal(calls.filter(x => x === 'activate').length, 1);
  assert.equal(calls.includes('login'), false);
});

test('unrelated active factor cannot confirm a candidate; missing session never triggers a password login', async () => {
  const { account, calls, run } = fixture();
  await run('prepare');
  assert.equal((await run('confirm')).ok, false);
  assert.equal(account.two_factor_secret, oldSecret);
  assert.equal(account.totp_reset_pending.secret, newSecret);
  account.session_access_token = ''; account.session_json = '';
  assert.equal((await run('confirm')).ok, false);
  assert.equal(calls.includes('login'), false);
});

test('unknown activation without factor ID stays unresolved even if MFA is enabled', async () => {
  const { account, run } = fixture({ factorId: '', failActivate: true });
  await run('prepare'); account.totp_reset_pending.phase = 'activating';
  await run('activate');
  assert.equal((await run('confirm')).ok, false);
  assert.equal(account.totp_reset_pending.secret, newSecret);
});

test('legacy one-shot request cannot mutate MFA', async () => {
  const { calls, run } = fixture();
  assert.equal((await run(undefined)).ok, false);
  assert.equal(calls.includes('disable'), false);
});

test('pending keys survive normalization, encrypted repository hydration and stale account import', async () => {
  const { account, run } = fixture();
  await run('prepare');
  const runtime = createSqliteRuntime();
  try {
    await runtime.accounts.initialize();
    runtime.accounts.state.accounts.push(normalizeDbAccount(account));
    await runtime.accounts.save();
    runtime.accounts.refreshFromDatabase();
    assert.equal(runtime.accounts.findById('reset').totp_reset_pending.secret, newSecret);
    const row = runtime.db.prepare('SELECT totp_reset_pending_enc FROM openai_profiles').get();
    assert.ok(row.totp_reset_pending_enc);
    assert.equal(row.totp_reset_pending_enc.includes(newSecret), false);
    runtime.accounts.importOne({ email: account.email, password: 'stale', two_factor_secret: oldSecret, mode: 'password_totp' });
    assert.equal(runtime.accounts.findById('reset').totp_reset_pending.secret, newSecret);
    assert.equal(runtime.accounts.findById('reset').password, 'fixture-password');
  } finally { runtime.db.close(); }
});
