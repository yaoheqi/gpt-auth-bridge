// Shared by the browser and Node. Operation metadata contains no credentials.
export const OPERATION_SCHEMA_VERSION = '1.0.0';
export const PUSH_RESULT_STATUSES = Object.freeze(['success', 'failed', 'unknown']);
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,96}$/;

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_OPERATION_RESPONSE' });
}

export function normalizeOperationId(value, fallback = '') {
  const id = String(value ?? fallback).trim();
  if (!id) return fallback;
  if (!IDENTIFIER.test(id)) throw invalid('操作标识格式无效');
  return id;
}

export function normalizeItemIds(value, count) {
  if (value == null) return Array.from({ length: count }, (_, index) => String(index));
  if (!Array.isArray(value) || value.length !== count) throw invalid('操作条目数量不匹配');
  const ids = value.map(id => normalizeOperationId(id));
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw invalid('操作条目标识无效或重复');
  return ids;
}

export function validateOperationEvent(event, data, { operationId } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('操作响应必须是对象');
  if (data.schemaVersion != null && data.schemaVersion !== OPERATION_SCHEMA_VERSION) throw invalid('操作响应版本不兼容');
  if (data.operationId != null) {
    normalizeOperationId(data.operationId);
    if (operationId && data.operationId !== operationId) throw invalid('收到其他操作的响应');
  }
  if (event === 'browser_state' && (!Array.isArray(data.accounts) || (data.settings != null && (typeof data.settings !== 'object' || Array.isArray(data.settings))))) {
    throw invalid('账号状态响应格式无效');
  }
  if (data.results != null && !Array.isArray(data.results)) throw invalid('操作结果格式无效');
  return data;
}

export function validatePushResults(payload, { operationId, itemIds } = {}) {
  validateOperationEvent('push', payload, { operationId });
  if (!Array.isArray(payload.results)) throw invalid('推送响应缺少逐项结果');
  if (itemIds && payload.results.length !== itemIds.length) throw invalid('推送响应不完整');
  const seen = new Set();
  for (const row of payload.results) {
    if (!row || !Number.isInteger(row.index) || row.index < 0 || seen.has(row.index)
      || !PUSH_RESULT_STATUSES.includes(row.status)) throw invalid('推送条目响应格式无效');
    seen.add(row.index);
    if (itemIds && (row.index >= itemIds.length || (row.itemId != null && row.itemId !== itemIds[row.index]))) throw invalid('推送条目不属于此操作');
    if (row.retryable != null && typeof row.retryable !== 'boolean') throw invalid('推送重试状态无效');
    if (row.retryable === true && row.status !== 'failed') throw invalid('未确认的条目不能自动重试');
  }
  return payload;
}

export function operationMetadata(operationId, requestId) {
  return { schemaVersion: OPERATION_SCHEMA_VERSION, ...(operationId ? { operationId } : {}), ...(requestId ? { requestId } : {}) };
}
