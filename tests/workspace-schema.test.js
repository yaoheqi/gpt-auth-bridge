import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = { structuredClone, Map };
vm.runInNewContext(readFileSync(new URL('../docs/workspace-schema.js', import.meta.url), 'utf8'), context);
const { serialize, restore } = context.workspaceSchema;
const plain = value => JSON.parse(JSON.stringify(value));

test('logout and self-leave retry selections survive browser snapshot restore independently', () => {
  const accountActionRetries = {
    logoutAll: { inputEmails: ['a@example.com', 'b@example.com'], emails: ['b@example.com'] },
    selfLeave: { inputEmails: ['a@example.com', 'b@example.com'], emails: ['a@example.com'] },
  };
  const restored = restore(serialize({ state: { accountActionRetries } }));
  assert.deepEqual(plain(restored.state.accountActionRetries), accountActionRetries);
});

test('durable browser snapshot keeps sources and history, not generated token copies', () => {
  const snapshot = serialize({ state: {
    format: 'sub2api', sessions: [{ value: { accessToken: 'fixture' }, sourceName: 'input.json', path: '$' }],
    converted: [{ cpa: { access_token: 'fixture' }, sub2apiAccount: { credentials: { access_token: 'fixture' } } }],
    outputText: 'generated', loginSensitiveValues: ['secret'], healthRun: 7,
    browserAccounts: [{ id: 'a', password: 'old' }, { id: 'a', password: 'new' }],
    loginLastAccounts: [{ id: 'a', email: 'fixture@example.com', password: 'do-not-duplicate' }],
    loginProgress: new Map([['fixture@example.com', { status: 'success', logs: [{ message: 'completed' }] }]]),
    pushOperations: [{ operationId: 'op', items: [{ status: 'pending' }] }],
    pushRetry: { accounts: [{ accessToken: 'duplicate' }] }, pushResults: [{ status: 'pending' }],
  }, fields: [{ id: 'session-input', value: '{"accessToken":"fixture"}' }, { id: 'download-scope', value: 'all' }] });
  assert.equal(snapshot.schemaVersion, 1);
  for (const key of ['sessions', 'converted', 'outputText', 'loginSensitiveValues', 'healthRun', 'pushRetry', 'pushResults']) assert.equal(key in snapshot.state, false, key);
  assert.equal(snapshot.state.conversionInput.text, '{"accessToken":"fixture"}');
  assert.equal(snapshot.state.conversionInput.sources[0].sourceName, 'input.json');
  assert.equal(snapshot.fields.length, 1);
  assert.equal(snapshot.state.browserAccounts.length, 1);
  assert.equal(snapshot.state.browserAccounts[0].password, 'new');
  assert.deepEqual(plain(snapshot.state.loginLastAccounts), [{ id: 'a', email: 'fixture@example.com' }]);
  assert.equal(snapshot.state.loginProgress[0][1].logs[0].message, 'completed');
  assert.equal(snapshot.state.pushOperations[0].items[0].status, 'pending');
  const reopened = restore(snapshot);
  assert.equal(reopened.state.pushOperations[0].items[0].status, 'unknown');
  assert.equal(reopened.state.pushOperations[0].items[0].retryable, false);
  assert.equal(snapshot.state.pushOperations[0].items[0].status, 'pending', 'restore must not change the saved snapshot');
});

test('legacy output-only snapshot migrates real credentials and safe retry history', () => {
  const restored = restore({ state: {
    converted: [{ cpa: { email: 'fixture@example.com', access_token: 'fixture-at', refresh_token: 'fixture-rt', id_token: 'synthetic', id_token_synthetic: true } }],
    pushRetry: { target: 'cpa', baseUrl: 'https://fixture.invalid', accounts: [{ email: 'fixture@example.com', access_token: 'fixture-at' }] },
    pushResults: [{ index: 0, name: 'fixture@example.com', status: 'failed' }],
  }, fields: [] });
  const input = JSON.parse(restored.state.conversionInput.text);
  assert.equal(input.refresh_token, 'fixture-rt');
  assert.equal(input.id_token, undefined);
  const operation = restored.state.pushOperations[0];
  assert.equal(operation.items[0].status, 'unknown');
  assert.equal(operation.items[0].retryable, false);
  assert.equal(operation.items[0].account.access_token, 'fixture-at');
  assert.equal(restored.state.pushRetry, undefined);
});

test('future or invalid business schema cannot be overwritten by a fresh workspace', () => {
  assert.throws(() => restore({ schemaVersion: 2, state: {} }), { code: 'INVALID_WORKSPACE_SCHEMA' });
  assert.throws(() => restore({ schemaVersion: 1, state: { browserAccounts: 'invalid' } }), { code: 'INVALID_WORKSPACE_SCHEMA' });
  assert.equal(restore(undefined), undefined);
});

test('successful push history keeps fifty metadata records while preserving every unfinished payload', () => {
  const completed = Array.from({ length: 58 }, (_, index) => ({
    operationId: `completed-${index}`, startedAt: index, updatedAt: index,
    items: [{ itemId: '0', name: 'fixture@example.com', status: 'success', attempts: 1,
      account: { email: 'fixture@example.com', credentials: { access_token: `discard-${index}`, chatgpt_account_id: `account-${index}` } } }],
  }));
  const unsettled = ['pending', 'unknown', 'failed'].map((status, index) => ({
    operationId: status, startedAt: -1,
    items: [{ itemId: '0', status, retryable: status === 'failed', account: { access_token: `keep-${index}` } },
      { itemId: '1', name: 'done@example.com', status: 'success', account: { access_token: 'discard-mixed', email: 'done@example.com' } }],
  }));
  const original = { schemaVersion: 1, state: { pushOperations: [...unsettled, ...completed], activePushOperationId: 'completed-0' } };
  assert.equal(context.workspaceSchema.needsPushHistoryCompaction(original.state.pushOperations), true);
  const saved = serialize(original);
  assert.equal(saved.state.pushOperations.length, 53);
  assert.equal(saved.state.pushOperations.find(operation => operation.operationId === 'completed-0'), undefined);
  assert.equal(saved.state.pushOperations.find(operation => operation.operationId === 'completed-7'), undefined);
  assert.equal(saved.state.activePushOperationId, 'completed-57');
  assert.equal(JSON.stringify(saved).includes('discard-'), false);
  for (let index = 0; index < unsettled.length; index++) {
    const item = saved.state.pushOperations[index].items[0];
    assert.equal(item.account.access_token, `keep-${index}`);
    assert.equal(item.status, unsettled[index].items[0].status);
    assert.equal(item.retryable, unsettled[index].items[0].retryable);
  }
  const success = saved.state.pushOperations.at(-1).items[0];
  assert.equal(success.identity.email, 'fixture@example.com');
  assert.equal(success.identity.accountId, 'account-57');
  assert.equal(success.account, undefined);
  assert.equal(restore(original).state.pushOperations.length, 53, 'Existing schema 1 data is compacted during restoration');
  assert.equal(context.workspaceSchema.needsPushHistoryCompaction(saved.state.pushOperations), false);
  assert.equal(original.state.pushOperations[0].items[0].status, 'pending', 'Compaction is pure');
  assert.equal(original.state.pushOperations.at(-1).items[0].account.credentials.access_token, 'discard-57');
});
