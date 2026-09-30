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

export function validationFailureFields(input) {
  const source = input?.validationFailure || input;
  if (!source || !Object.hasOwn(VALIDATION_FAILURES, source.code)) return {};
  const failure = { code: source.code, retryable: false };
  if (stages.has(source.stage)) failure.stage = source.stage;
  if (Number.isInteger(source.attempt) && source.attempt >= 1 && source.attempt <= 2) failure.attempt = source.attempt;
  for (const key of ['causeCode', 'cleanupCode']) {
    if (Object.hasOwn(VALIDATION_FAILURES, source[key])) failure[key] = source[key];
  }
  return { validationFailure: failure };
}

export function validationFailureHint(input) {
  return VALIDATION_FAILURES[validationFailureFields(input).validationFailure?.code] || '';
}
