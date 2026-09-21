import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProtocolPipelineMode, runProtocolLoginPipelineAccount, runAllWorkspaceCodexAuth } from '../src/services/protocol-login-pipeline.js';

const account = { id: 'account-1', email: 'fixture@example.com', password: 'fixture-password', two_factor_secret: 'JBSWY3DPEHPK3PXP' };

test('both login modes return terminal reasons for explicit credential rejections only', async () => {
  for (const workspaceMode of ['session', 'all']) {
    for (const [error, reason] of [['invalid_username_or_password', 'password_invalid'], ['MFAVerify: invalid_code', 'totp_invalid'], ['account_deleted', 'account_unavailable'], ['MFA HTTP 403', undefined]]) {
      const fail = async () => { throw new Error(error); };
      const result = await runProtocolLoginPipelineAccount(account, { workspaceMode, runSessionLogin: fail, runAllWorkspaces: fail });
      assert.equal(result.terminalReason, reason);
    }
  }
});

test('Session and all-workspace modes reject incomplete credentials before starting either flow', async () => {
  for (const workspaceMode of ['session', 'all']) {
    for (const extra of [
      { session_access_token: 'session-token' },
    ]) {
      const input = { id: account.id, email: 'fixture@example.com', ...extra };
      let completed = 0;
      const result = await runProtocolLoginPipelineAccount(input, {
        workspaceMode,
        runSessionLogin: () => assert.fail('must reject before Web login'),
        runAllWorkspaces: () => assert.fail('must reject before Codex login'),
        hooks: { done: () => { completed++; } },
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /密码和TOTP/);
      assert.equal(completed, 1);
    }
  }
});

test('Session mode runs Web login only and reports the actual Session outcome', async () => {
  for (const ok of [true, false]) {
    const events = [];
    const result = await runProtocolLoginPipelineAccount(account, {
      workspaceMode: 'session',
      runSessionLogin: async (current, { onLog }) => {
        assert.equal(current, account);
        onLog({ msg: 'web-login' });
        return { ok, error: ok ? '' : 'login failed' };
      },
      runAllWorkspaces: () => assert.fail('Session mode must not request RT'),
      hooks: { start: data => events.push(data.phase), log: data => events.push(data.phase), done: data => events.push(data.ok) },
    });
    assert.equal(result.ok, ok);
    assert.equal(result.sessionOk, ok);
    assert.equal(result.personalOk, false);
    assert.deepEqual(events, ['protocol', 'protocol', ok]);
  }
});

test('all-workspace mode, including the retired personal alias, never runs Web login', async () => {
  for (const workspaceMode of ['all', 'personal', undefined]) {
    const events = [];
    assert.equal(normalizeProtocolPipelineMode(workspaceMode), 'all');
    const result = await runProtocolLoginPipelineAccount(account, {
      workspaceMode,
      runSessionLogin: () => assert.fail('RT mode must not request Web Session'),
      runAllWorkspaces: async (_current, { onPhase, onLog }) => {
        onPhase('business');
        onLog({ phase: 'business', msg: 'workspace auth' });
        return { ok: true, sessionOk: false, personalOk: true, businessSuccess: 2 };
      },
      hooks: { start: data => events.push(data.phase), phase: data => events.push(data.phase), log: data => events.push(data.phase) },
    });
    assert.deepEqual(events, ['codex', 'business', 'business']);
    assert.equal(result.sessionOk, false);
    assert.equal(result.businessSuccess, 2);
  }
});

function fixture({ workspaces = ['business-1', 'business-2'], failed = '' } = {}) {
  const calls = [];
  const flow = {
    discoveredWorkspaces: [{ id: 'personal', kind: 'personal' }, ...workspaces.map(id => ({ id, kind: 'business' }))],
    run: async () => { calls.push('login'); return { refresh_token: 'personal-rt' }; },
    exportCookieStorageState: async () => '{"cookies":[]}',
    loginCodexWithPhone: async options => {
      assert.equal(options.preserveAuthSession, true);
      assert.equal(flow.forbidPhoneChallenge, true);
      const id = flow.workspaceSelection.workspaceId;
      calls.push(id);
      if (id === failed) throw new Error('workspace unavailable');
      return { refresh_token: `rt-${id}`, account_id: id };
    },
    dispose: async () => calls.push('dispose'),
    log: () => {},
  };
  const options = {
    flow,
    persistPersonal: async () => calls.push('save-personal'),
    persistBusiness: async (record, id) => { assert.equal(record.account_id, id); calls.push(`save-${id}`); },
    persistCookies: async () => calls.push('save-cookies'),
  };
  return { flow, calls, options };
}

test('one Codex login processes personal then every unique workspace even if cookies change', async () => {
  const { calls, options } = fixture({ workspaces: ['business-1', 'business-1', 'business-2'] });
  const result = await runAllWorkspaceCodexAuth(options);
  assert.equal(result.ok, true);
  assert.equal(result.sessionOk, false);
  assert.equal(result.personalOk, true);
  assert.equal(result.businessTotal, 2);
  assert.equal(result.businessSuccess, 2);
  assert.deepEqual(calls, ['login', 'save-personal', 'save-cookies', 'business-1', 'save-business-1', 'business-2', 'save-business-2', 'save-cookies', 'dispose']);
});

test('zero Business workspaces still returns personal RT success', async () => {
  const { options } = fixture({ workspaces: [] });
  const result = await runAllWorkspaceCodexAuth(options);
  assert.equal(result.ok, true);
  assert.equal(result.personalOk, true);
  assert.equal(result.businessTotal, 0);
});

test('workspace failure does not stop the remaining workspaces or conceal partial results', async () => {
  const { options, calls } = fixture({ failed: 'business-1' });
  const result = await runAllWorkspaceCodexAuth(options);
  assert.equal(result.ok, false);
  assert.equal(result.personalOk, true);
  assert.equal(result.businessSuccess, 1);
  assert.match(result.error, /business-1/);
  assert.ok(calls.includes('save-business-2'));
  assert.equal(calls.at(-1), 'dispose');
});

test('personal auth failure and missing workspace catalog fail explicitly and release the flow', async () => {
  for (const failure of ['login', 'catalog', 'persistence']) {
    const { options, flow, calls } = fixture();
    if (failure === 'login') flow.run = async () => { throw new Error('login failed'); };
    if (failure === 'catalog') flow.discoveredWorkspaces = null;
    if (failure === 'persistence') options.persistCookies = async () => { throw new Error('disk full'); };
    const result = await runAllWorkspaceCodexAuth(options);
    assert.equal(result.ok, false);
    assert.equal(result.sessionOk, false);
    assert.equal(result.personalOk, failure !== 'login');
    assert.equal(result.businessSuccess, 0);
    assert.equal(calls.at(-1), 'dispose');
    assert.ok(result.error);
  }
});
