export const PROGRESS_SCHEMA_VERSION = '1.0.0';

const STATUS_LABELS = Object.freeze({
  pending: '等待中',
  started: '开始',
  running: '运行中',
  log: '过程',
  completed: '成功',
  failed: '失败',
  cancelling: '取消中',
  cancelled: '已取消',
});

const TYPE_LABELS = Object.freeze({
  'protocol-login': '协议登录',
  'session-health': 'Session 验活',
  'codex-auth': 'Codex 授权',
});

const PHASE_LABELS = Object.freeze({
  resolve: '解析账号',
  prepare: '准备凭据',
  login: '协议登录',
  probe: '探测 Session',
  export: '导出结果',
  done: '完成',
});

export function statusLabel(status) { return STATUS_LABELS[String(status || '').toLowerCase()] || String(status || '状态更新'); }
export function typeLabel(type) { return TYPE_LABELS[String(type || '')] || String(type || '任务'); }
function safeText(value, maxLength = 500) {
  const text = String(value ?? '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function normalizeProgressEvent(event = {}, defaults = {}) {
  const source = event && typeof event === 'object' ? event : {};
  const status = safeText(source.status || defaults.status || 'log', 32).toLowerCase();
  const message = safeText(source.message || source.msg || source.error || defaults.message || '');
  const type = safeText(source.type || defaults.type || '');
  const phase = safeText(source.phase || defaults.phase || (status === 'started' ? type : ''), 64);
  const level = safeText(source.level || defaults.level || (status === 'failed' ? 'error' : 'info'), 16).toLowerCase();
  const result = {
    schemaVersion: PROGRESS_SCHEMA_VERSION,
    status,
    level,
    type,
    phase,
    key: safeText(source.key || defaults.key || '', 120),
    email: safeText(source.email || defaults.email || '', 254),
    message,
    ...(source.code ? { code: safeText(source.code, 80) } : {}),
    ...(source.health ? { health: safeText(source.health, 80) } : {}),
    ...(source.at ? { at: source.at } : {}),
  };
  for (const key of [
    'survivalRound', 'current', 'total', 'alive', 'deactivated', 'alive_rate',
    'authIntent', 'switchedToLogin', 'otpVia', 'sessionOk', 'personalOk',
    'businessSuccess', 'businessErrors', 'accountId', 'result',
  ]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

export function summarizeProgress(events = []) {
  const list = Array.isArray(events) ? events : [];
  return {
    started: list.filter((item) => item?.status === 'started').length,
    completed: list.filter((item) => item?.status === 'completed').length,
    failed: list.filter((item) => item?.status === 'failed').length,
    logs: list.filter((item) => item?.status === 'log').length,
    last: list.length ? list[list.length - 1] : null,
  };
}

export const PROGRESS_LABELS = Object.freeze({ status: STATUS_LABELS, type: TYPE_LABELS, phase: PHASE_LABELS });
