import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeItemIds, validateOperationEvent, validatePushResults } from '../docs/operation-contract.js';

test('operation contracts reject stale or incomplete results before accepting browser state', () => {
  const result = { operationId: 'operation-1', schemaVersion: '1.0.0', results: [{ index: 0, itemId: 'item-a', status: 'unknown', retryable: false }] };
  assert.equal(validatePushResults(result, { operationId: 'operation-1', itemIds: ['item-a'] }), result);
  assert.throws(() => validatePushResults(result, { operationId: 'operation-2' }), { code: 'INVALID_OPERATION_RESPONSE' });
  assert.throws(() => validatePushResults(result, { itemIds: ['item-a', 'item-b'] }), /不完整/);
  assert.throws(() => validatePushResults({ results: [{ index: 0, status: 'unknown', retryable: true }] }), /不能自动重试/);
  assert.throws(() => validatePushResults({ results: [{ index: 0, status: 'success' }, { index: 0, status: 'success' }] }), /格式无效/);
  assert.throws(() => validateOperationEvent('browser_state', { accounts: {} }), /账号状态/);
  assert.throws(() => validateOperationEvent('summary', { schemaVersion: '99' }), /版本/);
  assert.throws(() => normalizeItemIds(['duplicate', 'duplicate'], 2), /重复/);
});
