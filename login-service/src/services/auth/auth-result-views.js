import { SESSION_HEALTH, sessionHealthLabel } from '../session-health-service.js';
import { normalizeTotpSecret } from '../../../lib/totp.js';
import { resolveOpenAiAccountPassword } from './auth-records.js';

export function shouldAutoEnrollTotpAfterSession(account) {
  return true;
}

export function trimAuthLogs(logs, { failed = false } = {}) {
  const list = Array.isArray(logs) ? logs : [];
  const limit = failed ? 80 : 20;
  return list.slice(-limit);
}

export function publicCodexAuthResult(item) {
  if (!item || typeof item !== 'object') return item;
  const { json, logs, ...rest } = item;
  const failed = item.ok === false;
  return {
    ...rest,
    logCount: Array.isArray(logs) ? logs.length : 0,
    // 失败必须带回日志；成功只保留尾部摘要，减小响应体积
    logs: trimAuthLogs(logs, { failed }),
  };
}

export function publicLogoutAllResult(item) {
  if (!item || typeof item !== 'object') return item;
  const { logs, logout, sessionUser, ...rest } = item;
  const failed = item.ok === false;
  return {
    ...rest,
    sessionEmail: sessionUser?.email || '',
    logoutKeys: logout && typeof logout === 'object' ? Object.keys(logout) : [],
    logCount: Array.isArray(logs) ? logs.length : 0,
    logs: trimAuthLogs(logs, { failed }),
  };
}

export function publicEnrollTotpResult(item) {
  if (!item || typeof item !== 'object') return item;
  const { logs, mfaInfo, enroll, secret, ...rest } = item;
  const failed = item.ok === false;
  return {
    ...rest,
    // Admin API may include secret once for export/verify; keep boolean in SSE summaries.
    hasSecret: Boolean(secret),
    secret: secret || undefined,
    mfaEnabled: Boolean(mfaInfo?.mfa_enabled || mfaInfo?.mfa_enabled_v2),
    totpFactorCount: Array.isArray(mfaInfo?.factors?.totp) ? mfaInfo.factors.totp.length : 0,
    logCount: Array.isArray(logs) ? logs.length : 0,
    logs: trimAuthLogs(logs, { failed }),
  };
}

export function publicResetTotpCredential(account, secret) {
  const password = resolveOpenAiAccountPassword(account);
  return {
    email: String(account?.email || '').trim(),
    password,
    totp: normalizeTotpSecret(secret),
    line: [String(account?.email || '').trim(), password, normalizeTotpSecret(secret)].join('----'),
  };
}

export function publicPlusTrialResult(item) {
  if (!item || typeof item !== 'object') return item;
  const { logs, eligibility, pricingConfigSummary, ...rest } = item;
  const failed = item.ok === false;
  return {
    ...rest,
    pricing: pricingConfigSummary || null,
    logCount: Array.isArray(logs) ? logs.length : 0,
    logs: trimAuthLogs(logs, { failed }),
  };
}

export function publicSessionHealthResult(item) {
  if (!item || typeof item !== 'object') return item;
  const { logs, ...rest } = item;
  const failed = item.ok === false && item.health !== SESSION_HEALTH.DEACTIVATED;
  return {
    ...rest,
    healthLabel: sessionHealthLabel(item.health),
    logCount: Array.isArray(logs) ? logs.length : 0,
    logs: trimAuthLogs(logs, { failed }),
  };
}
