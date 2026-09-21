import { redactDeep } from '../src/shared/redactor.js';

/**
 * Compact structured log lines for ops (email / stage / activationId / duration).
 * Avoids dumping secrets; callers must pass already-safe fields.
 */
export function structuredLog(event, fields = {}) {
  const eventName = String(event || '');
  const level = /failed|error|invalid/i.test(eventName) ? 'error' : /warn|retry/i.test(eventName) ? 'warn' : 'info';
  const payload = redactDeep({
    ts: new Date().toISOString(),
    schemaVersion: '1.0.0',
    level,
    event: eventName,
    eventLabel: structuredEventLabel(eventName),
    ...fields,
  });
  // User operation details are returned to the requesting browser only.
  return payload;
}

function structuredEventLabel(event) {
  const normalized = String(event || '').replace(/_/g, ' ');
  const labels = {
    'session health start': 'Session 验活开始',
    'session health done': 'Session 验活完成',
    'session health failed': 'Session 验活失败',
    'register only start': '协议注册开始',
    'register only done': '协议注册完成',
    'register only failed': '协议注册失败',
    'codex auth start': 'Codex 授权开始',
    'codex auth done': 'Codex 授权完成',
    'codex auth failed': 'Codex 授权失败',
    'logout all start': '退出全部会话开始',
    'logout all done': '退出全部会话完成',
    'logout all failed': '退出全部会话失败',
    'enroll totp start': '设置 2FA 开始',
    'enroll totp done': '设置 2FA 完成',
    'enroll totp failed': '设置 2FA 失败',
    'plus trial check start': '试用资格校验开始',
    'plus trial check done': '试用资格校验完成',
    'plus trial check failed': '试用资格校验失败',
  };
  return labels[normalized] || normalized;
}

export function durationMs(startedAtMs) {
  const start = Number(startedAtMs);
  if (!Number.isFinite(start) || start <= 0) return undefined;
  return Math.max(0, Date.now() - start);
}
