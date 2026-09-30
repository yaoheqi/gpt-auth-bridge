import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n  }', start) + '\n  }'.length;
  return source.slice(start, end);
}
function harness(key, batches) {
  const requests = [], imports = [];
  const state = { accountActionRetries: {}, loginProgress: new Map(), browserAccounts: [],
    loginBusinessIds: [], loginSessionIds: [], loginPersonalIds: [], pushOperations: [] };
  const input = ['a@example.com----password', 'b@example.com----password', 'c@example.com----password'];
  const elements = { loginAccounts: { value: input.join('\n') }, startProtocolLogin: {}, resetLoginTotp: {}, exportLoginSessions: {}, loginStatus: {} };
  const context = vm.createContext({ state, elements, monitorBusy: false, selfLeaveBusy: false, protocolLogoutBusy: false,
    window: { confirm: () => true }, document: { querySelectorAll: () => [] },
    workspaceTaskIsCurrent: () => () => true, requireCurrentWorkspace: () => {},
    parseLoginAccounts: value => value.split('\n'), loginAccountEmail: line => line.split('----')[0],
    updateLoginExportActions: () => {}, stopSessionMonitor: () => {}, renderSessionMonitor: () => {},
    selectedTaskConcurrency: () => 5, selectedLoginProxyNetwork: () => ({}),
    initializeLoginProgress: lines => { state.loginProgress.clear(); lines.forEach(line => {
      const email = line.split('----')[0]; state.loginProgress.set(email, { email, status: 'waiting' });
    }); },
    loginProgressRecord: row => state.loginProgress.get(row.email) || [...state.loginProgress.values()].find(record => record.id === row.id),
    appendLoginProgress: (record, _message, options) => { if (record) Object.assign(record, options); },
    setStatus: (_element, message) => { context.status = message; },
    persistBrowserWorkspace: async () => {}, markMonitorStopped: () => {}, syncPushOperationViews: () => {},
    updatePushControls: () => {}, scheduleSessionMonitor: () => {},
    loginIcloudRequest: async (_url, body) => {
      const emails = body.text.split('\n').map(line => line.split('----')[0]); imports.push(emails);
      return { rows: emails.map(email => ({ ok: true, id: email, email })) };
    },
    loginIcloudStream: async (_url, body, event) => {
      requests.push(body.ids);
      const batch = batches.shift();
      for (const row of batch.results) event('account_done', { ...row, id: row.email });
      if (batch.interrupted) throw new Error('stream interrupted');
      return { ...batch, failed: batch.results.filter(row => !row.ok).length, success: batch.results.filter(row => row.ok).length };
    },
  });
  for (const name of ['loginInputIdentity', 'accountActionLines', 'saveAccountActionRetry',
    key === 'selfLeave' ? 'selfLeaveAccountWorkspaces' : 'protocolLogoutAllSessions']) vm.runInContext(functionSource(name), context);
  return { state, context, imports, requests,
    run: () => context[key === 'selfLeave' ? 'selfLeaveAccountWorkspaces' : 'protocolLogoutAllSessions']() };
}

for (const key of ['selfLeave', 'logoutAll']) {
  test(`${key} retries only failed accounts and keeps operation retry sets separate`, async () => {
    const f = harness(key, [
      { results: [{ email: 'a@example.com', ok: true }, { email: 'b@example.com', ok: false }, { email: 'c@example.com', ok: true }] },
      { results: [{ email: 'b@example.com', ok: true }] },
    ]);
    await f.run();
    assert.match(f.context.status, /再次点击仅重试失败账号/);
    assert.deepEqual(Array.from(f.state.accountActionRetries[key].emails), ['b@example.com']);
    const otherKey = key === 'selfLeave' ? 'logoutAll' : 'selfLeave';
    f.state.accountActionRetries[otherKey] = { emails: ['a@example.com'] };
    await f.run();
    assert.deepEqual(Array.from(f.requests[1]), ['b@example.com']);
    assert.deepEqual(f.imports[1], ['b@example.com']);
    assert.equal(f.state.accountActionRetries[key], undefined);
    assert.deepEqual(f.state.accountActionRetries[otherKey].emails, ['a@example.com']);
  });
}

test('logout stream interruption retains successful outcomes and retries remaining accounts', async () => {
  const f = harness('logoutAll', [{ interrupted: true, results: [{ email: 'a@example.com', ok: true }] }]);
  await f.run();
  assert.deepEqual(Array.from(f.state.accountActionRetries.logoutAll.emails), ['b@example.com', 'c@example.com']);
});

test('self-leave import failure retains retry selection before any mutation is submitted', async () => {
  const f = harness('selfLeave', []);
  f.context.loginIcloudRequest = async () => { throw new Error('network unavailable'); };
  await f.run();
  assert.deepEqual(Array.from(f.state.accountActionRetries.selfLeave.emails), ['a@example.com', 'b@example.com', 'c@example.com']);
  assert.equal(f.requests.length, 0);
});

test('self-leave stream interruption retries confirmed failures only', async () => {
  const f = harness('selfLeave', [{ interrupted: true, results: [{ email: 'a@example.com', ok: false }] }]);
  await f.run();
  assert.deepEqual(Array.from(f.state.accountActionRetries.selfLeave.emails), ['a@example.com']);
});

test('self-leave excludes unconfirmed and terminal accounts from retry', async () => {
  const f = harness('selfLeave', [{ results: [
    { email: 'a@example.com', ok: false, unconfirmed: 1 },
    { email: 'b@example.com', ok: false },
    { email: 'c@example.com', ok: false, terminalReason: 'account_unavailable' },
  ] }]);
  await f.run();
  assert.deepEqual(Array.from(f.state.accountActionRetries.selfLeave.emails), ['b@example.com']);
});

test('changing account membership starts a new batch; reorder preserves retry selection', async () => {
  const f = harness('logoutAll', [{ results: [{ email: 'b@example.com', ok: false }, { email: 'a@example.com', ok: true }, { email: 'c@example.com', ok: true }] }]);
  await f.run();
  assert.deepEqual(Array.from(f.context.accountActionLines('logoutAll', ['c@example.com', 'b@example.com', 'a@example.com'])), ['b@example.com']);
  assert.deepEqual(Array.from(f.context.accountActionLines('logoutAll', ['new@example.com'])), ['new@example.com']);
  assert.equal(f.state.accountActionRetries.logoutAll, undefined);
});
