// Shared, allowlisted contract. Never expose upstream bodies or exception stacks.
export const VALIDATION_FAILURES = Object.freeze({
  BROWSER_CLOSED: '验证浏览器意外关闭，恢复次数已用尽，请检查运行环境',
  BROWSER_UNAVAILABLE: '验证浏览器无法启动，请检查浏览器安装及运行环境',
  BROWSER_WORKER_EXITED: '验证进程异常退出，请检查进程退出记录',
  BROWSER_PROTOCOL_ERROR: '验证进程返回格式错误，请检查服务版本是否一致',
  BROWSER_PROXY_FAILED: '浏览器代理连接失败，请检查本次任务的代理',
  BROWSER_NAVIGATION_FAILED: '验证页面加载失败，请检查网络及浏览器环境',
  BROWSER_CLEANUP_FAILED: '浏览器资源回收失败，相关执行槽位已隔离',
  VALIDATION_TIMEOUT: '辅助验证超时，已停止后续验证操作',
  VALIDATION_CANCELLED: '辅助验证已取消',
  VALIDATION_CONFIG_MISSING: '没有可用的验证通道，请检查浏览器或备用通道配置',
  VALIDATION_PROVIDER_FAILED: '备用验证通道失败，请检查配置或服务状态',
  VALIDATION_CHALLENGE_FAILED: '辅助验证未完成，请稍后重试或人工处理',
  VALIDATION_CONTEXT_MISMATCH: '验证结果与当前登录上下文不一致，已拒绝继续提交',
});
const stages = new Set(['sentinel', 'requirements', 'provider', 'browser_queue', 'browser_start',
  'browser_context', 'browser_navigation', 'browser_verify', 'browser_cleanup']);

const reasons = new Set(['HTTP_ERROR', 'EDGE_CHALLENGE', 'SDK_NOT_READY', 'NAVIGATION_TIMEOUT', 'NAVIGATION_INTERRUPTED',
  'ERR_ABORTED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_TIMED_OUT',
  'ERR_TIMED_OUT', 'ERR_EMPTY_RESPONSE', 'ERR_NETWORK_CHANGED', 'ERR_NAME_NOT_RESOLVED',
  'ERR_CONNECTION_REFUSED', 'ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_SOCKS_CONNECTION_FAILED', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_DATE_INVALID',
  'ERR_CERT_COMMON_NAME_INVALID', 'ERR_SSL_PROTOCOL_ERROR']);

export function validationFailureFields(input) {
  const source = input?.validationFailure || input;
  if (!source || !Object.hasOwn(VALIDATION_FAILURES, source.code)) return {};
  const failure = { code: source.code, retryable: false };
  if (stages.has(source.stage)) failure.stage = source.stage;
  if (reasons.has(source.reason)) failure.reason = source.reason;
  if (['HTTP_ERROR', 'EDGE_CHALLENGE'].includes(failure.reason) && Number.isInteger(source.httpStatus) && source.httpStatus >= 400 && source.httpStatus <= 599) {
    failure.httpStatus = source.httpStatus;
  }
  if (Number.isInteger(source.attempt) && source.attempt >= 1 && source.attempt <= 2) failure.attempt = source.attempt;
  for (const key of ['causeCode', 'cleanupCode']) {
    if (Object.hasOwn(VALIDATION_FAILURES, source[key])) failure[key] = source[key];
  }
  return { validationFailure: failure };
}

export function isValidationAccessBlocked(input) {
  const failure = validationFailureFields(input).validationFailure;
  return failure?.code === 'BROWSER_NAVIGATION_FAILED' && (failure.reason === 'EDGE_CHALLENGE'
    || (failure.reason === 'HTTP_ERROR' && [403, 429].includes(failure.httpStatus)));
}

export function validationFailureHint(input) {
  const failure = validationFailureFields(input).validationFailure;
  if (!failure) return '';
  if (isValidationAccessBlocked(failure)) {
    const detail = failure.reason === 'EDGE_CHALLENGE' ? `Cloudflare challenge${failure.httpStatus ? `，HTTP ${failure.httpStatus}` : ''}` : `HTTP ${failure.httpStatus}`;
    if (failure.httpStatus === 429) return `验证页面请求受到限流，已停止自动重试；请稍后再试（${detail}）`;
    return `上游限制了服务器浏览器访问，已停止自动重试；请在官方页面完成验证或联系服务方核查访问限制（${detail}）。此结果不能判断密码或 2FA 是否正确`;
  }
  const detail = failure.httpStatus ? `HTTP ${failure.httpStatus}`
    : failure.reason === 'SDK_NOT_READY' ? '验证 SDK 未就绪'
      : failure.reason === 'NAVIGATION_TIMEOUT' ? '页面加载超时'
        : failure.reason === 'NAVIGATION_INTERRUPTED' ? '页面跳转中断' : failure.reason;
  return VALIDATION_FAILURES[failure.code] + (detail ? `（${detail}）` : '');
}

export function validationFailureLabel(input) {
  const failure = validationFailureFields(input).validationFailure;
  if (!failure) return '';
  if (isValidationAccessBlocked(failure)) return failure.httpStatus === 429 ? '上游请求限流' : '上游访问受限';
  if (failure.code === 'VALIDATION_TIMEOUT') return '辅助验证超时';
  if (failure.code === 'VALIDATION_CANCELLED') return '辅助验证已取消';
  return '辅助验证失败';
}
