/**
 * Node-authoritative auth / OTP / session-health behavior contract.
 * Python adapters must mirror these values and classification rules.
 * Account storage and proxy transport selection are intentionally out of scope.
 */

export const AUTH_BEHAVIOR_CONTRACT_VERSION = '1.0.0';

/** Session health probe */
export const SESSION_PROBE_TIMEOUT_MS = 20_000;
export const SESSION_PROBE_TIMEOUT_SECONDS = 20;
export const SESSION_PROBE_URL = 'https://chatgpt.com/backend-api/me';
export const SESSION_PROBE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** Redirect / continuation */
export const AUTH_REDIRECT_MAX_HOPS = 10;
export const AUTH_SESSION_POLL_ATTEMPTS = 3;
export const AUTH_SESSION_POLL_DELAY_MS = 1_000;

/** Concurrency caps shared by batch jobs */
export {
  DEFAULT_OAUTH_BATCH_CONCURRENCY_FALLBACK as DEFAULT_BATCH_CONCURRENCY,
  MAX_OAUTH_BATCH_CONCURRENCY as MAX_BATCH_CONCURRENCY,
  MAX_OAUTH_BATCH_CONCURRENCY as MAX_ALIVE_CHECK_CONCURRENCY,
} from '../../lib/batch-concurrency.js';
import {
  DEFAULT_OAUTH_BATCH_CONCURRENCY_FALLBACK as DEFAULT_BATCH_CONCURRENCY,
  MAX_OAUTH_BATCH_CONCURRENCY as MAX_BATCH_CONCURRENCY,
} from '../../lib/batch-concurrency.js';

export const SESSION_HEALTH = Object.freeze({
  ALIVE: 'alive',
  ALIVE_REFRESHED: 'alive_refreshed',
  SESSION_INVALID: 'session_invalid',
  DEACTIVATED: 'deactivated',
  NO_SESSION: 'no_session',
  PROBE_FAILED: 'probe_failed',
  RELOGIN_FAILED: 'relogin_failed',
});

export const SESSION_HEALTH_LABELS = Object.freeze({
  [SESSION_HEALTH.ALIVE]: 'Session有效',
  [SESSION_HEALTH.ALIVE_REFRESHED]: '已重登刷新',
  [SESSION_HEALTH.SESSION_INVALID]: 'Session失效',
  [SESSION_HEALTH.DEACTIVATED]: '账号已停用',
  [SESSION_HEALTH.NO_SESSION]: '无 Session',
  [SESSION_HEALTH.PROBE_FAILED]: '探测失败',
  [SESSION_HEALTH.RELOGIN_FAILED]: '重登失败',
});

/**
 * Classify a ChatGPT backend probe response.
 * @returns {'alive'|'session_invalid'|'deactivated'|'probe_failed'}
 */
export function classifySessionProbe({ status, code = '', body = '' } = {}) {
  const httpStatus = Number(status) || 0;
  const errCode = String(code || extractErrorCode(null, body) || '').trim().toLowerCase();
  const haystack = `${errCode} ${body}`.toLowerCase();

  if (httpStatus >= 200 && httpStatus < 300) return SESSION_HEALTH.ALIVE;
  if (/account_(?:deactivated|deleted|not_found)|user_(?:deleted|not_found)/.test(haystack)) {
    return SESSION_HEALTH.DEACTIVATED;
  }
  if (
    errCode === 'token_invalidated'
    || /token_invalidated|authentication token has been invalidated|invalid_api_key|unauthorized/.test(haystack)
    || httpStatus === 401
  ) {
    return SESSION_HEALTH.SESSION_INVALID;
  }
  // 403 alone is NOT session_invalid — only when deactivation markers are present.
  if (httpStatus === 403 && /deactivat|banned|disabled|deleted/.test(haystack)) {
    return SESSION_HEALTH.DEACTIVATED;
  }
  return SESSION_HEALTH.PROBE_FAILED;
}

export function extractErrorCode(payload, text = '') {
  if (payload && typeof payload === 'object') {
    const nested = payload.error || payload.detail || payload;
    const code = nested?.code || nested?.error_code || payload.code;
    if (code) return String(code).trim();
    const message = String(nested?.message || payload.message || '');
    if (/account[_\s-]?(?:deactivated|deleted)|user[_\s-]?deleted/i.test(message)) return 'account_deactivated';
    if (/token[_\s-]?invalidated/i.test(message)) return 'token_invalidated';
  }
  const raw = String(text || '');
  if (/account[_\s-]?(?:deactivated|deleted|not_found)|user[_\s-]?(?:deleted|not_found)/i.test(raw)) return 'account_deactivated';
  if (/token_invalidated/i.test(raw)) return 'token_invalidated';
  return '';
}

export function isAccountDeactivatedError(message = '') {
  return /account_(?:deactivated|deleted|not_found)|user_(?:deleted|not_found)|账号(已)?(停用|封禁|删除|不存在)|account (?:has been |is )?(?:deactivated|deleted)/i.test(String(message || ''));
}

/** Accept any 2xx as success (Node authoritative; not strict 200-only). */
export function isHttpSuccessStatus(status) {
  const code = Number(status) || 0;
  return code >= 200 && code < 300;
}

/** Snapshot exported for Python fixtures / contract tests. */
export function authBehaviorContractSnapshot() {
  return Object.freeze({
    version: AUTH_BEHAVIOR_CONTRACT_VERSION,
    sessionProbeTimeoutMs: SESSION_PROBE_TIMEOUT_MS,
    sessionProbeTimeoutSeconds: SESSION_PROBE_TIMEOUT_SECONDS,
    sessionProbeUrl: SESSION_PROBE_URL,
    authRedirectMaxHops: AUTH_REDIRECT_MAX_HOPS,
    authSessionPollAttempts: AUTH_SESSION_POLL_ATTEMPTS,
    authSessionPollDelayMs: AUTH_SESSION_POLL_DELAY_MS,
    defaultBatchConcurrency: DEFAULT_BATCH_CONCURRENCY,
    maxBatchConcurrency: MAX_BATCH_CONCURRENCY,
    sessionHealth: { ...SESSION_HEALTH },
  });
}
