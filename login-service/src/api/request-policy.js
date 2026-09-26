const RETIRED_ROUTE = /^\/api\/v2\/(?:user(?:\/|$)|admin\/(?:login|logout|session|sms|smsbower|yescaptcha|app-settings)|accounts\/(?:register|logout-all|enroll-totp|check-plus-trial|reconcile-stages|[^/]+\/(?:sms|export-json|browser-register-result)))/;
const ACCOUNT_COMMANDS = new Set([
  'import', 'reset-totp', 'export-sessions', 'export-sub2api', 'push-sub2api', 'export-sub2api-zip',
  'business-join/convert-rt', 'codex-auth', 'session-codex-rt', 'monitor-lease', 'session-probe',
  'protocol-login-pipeline', 'protocol-logout-all', 'self-leave', 'protocol-login', 'session-health',
]);

// Decide which APIs need user data before allocating a request database.
export function browserRoutePolicy(path, method = 'GET') {
  const verb = method === 'HEAD' ? 'GET' : method;
  if (RETIRED_ROUTE.test(path)) return { status: 404, code: 'NOT_FOUND' };
  if (path === '/api/v2/jobs' && verb === 'GET') return { jobs: true };
  if (path.startsWith('/api/v2/jobs')) return { status: 410, code: 'JOBS_DISABLED' };
  if (verb === 'POST' && path.startsWith('/api/v2/accounts/') && ACCOUNT_COMMANDS.has(path.slice('/api/v2/accounts/'.length))) return { context: true };
  if (verb === 'POST' && path === '/api/v2/conversions/session-agent') return { context: true };
  if (['GET', 'PUT'].includes(verb) && /^\/api\/v2\/admin\/(?:protocol|sub2api)\/settings$/.test(path)) return { context: true };
  if (verb === 'POST' && path === '/api/v2/admin/sub2api/groups') return { context: true };
  if (verb === 'GET' && ['/api/v2/health', '/api/v2/sot', '/api/v2/system/proxy-health'].includes(path)) return { context: false };
  if (verb === 'POST' && path === '/api/v2/system/stream-probe') return { context: false };
  return { status: 404, code: 'NOT_FOUND' };
}
