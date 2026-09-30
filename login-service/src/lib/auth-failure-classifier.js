import { validationFailureFields } from '../../lib/validation-error.js';

export const AUTH_FAILURE_CATEGORIES = Object.freeze({
  BROWSER_UNAVAILABLE: 'browser_unavailable',
  VALIDATION_TIMEOUT: 'validation_timeout',
  VALIDATION_CONTEXT: 'validation_context',
  VALIDATION_CONFIG: 'validation_config',
  CANCELLED: 'cancelled',
  ACCOUNT_DEACTIVATED: 'account_deactivated',
  ACCOUNT_ALREADY_EXISTS: 'account_already_exists',
  CAPTCHA_BLOCKED: 'captcha_blocked',
  EGRESS_BLOCKED: 'egress_blocked',
  OTP_TIMEOUT: 'otp_timeout',
  OTP_INVALID: 'otp_invalid',
  PASSWORD_REJECTED: 'password_rejected',
  PHONE_REQUIRED: 'phone_required',
  MFA_REQUIRED: 'mfa_required',
  SESSION_EXTRACT_FAILED: 'session_extract_failed',
  CREDENTIAL_MISSING: 'credential_missing',
  PREFLIGHT_FAILED: 'preflight_failed',
  TRANSIENT_NETWORK: 'transient_network',
  UNKNOWN: 'unknown',
});

export function classifyAuthFailure(input = '') {
  const code = validationFailureFields(input).validationFailure?.code;
  if (code === 'BROWSER_PROXY_FAILED') return AUTH_FAILURE_CATEGORIES.EGRESS_BLOCKED;
  if (code?.startsWith('BROWSER_')) return AUTH_FAILURE_CATEGORIES.BROWSER_UNAVAILABLE;
  if (code === 'VALIDATION_TIMEOUT') return AUTH_FAILURE_CATEGORIES.VALIDATION_TIMEOUT;
  if (code === 'VALIDATION_CONTEXT_MISMATCH') return AUTH_FAILURE_CATEGORIES.VALIDATION_CONTEXT;
  if (code === 'VALIDATION_CONFIG_MISSING' || code === 'VALIDATION_PROVIDER_FAILED') return AUTH_FAILURE_CATEGORIES.VALIDATION_CONFIG;
  if (code === 'VALIDATION_CANCELLED' || input?.name === 'AbortError') return AUTH_FAILURE_CATEGORIES.CANCELLED;
  if (code === 'VALIDATION_CHALLENGE_FAILED') return AUTH_FAILURE_CATEGORIES.CAPTCHA_BLOCKED;
  const message = typeof input === 'string' ? input : String(input?.message || input?.error || input?.code || '');
  const text = message.toLowerCase();
  if (/account[_ -]?deactivated|deactivated|账号已停用|账号停用/.test(text)) return AUTH_FAILURE_CATEGORIES.ACCOUNT_DEACTIVATED;
  if (/user_already_exists|account already exists|already have an account|already exists|账号已创建|账号已存在|账户已存在|邮箱已注册|邮件地址已被使用/.test(text)) return AUTH_FAILURE_CATEGORIES.ACCOUNT_ALREADY_EXISTS;
  if (/turnstile|captcha|cf-|cloudflare|challenge/.test(text)) return AUTH_FAILURE_CATEGORIES.CAPTCHA_BLOCKED;
  if (/egress|proxy|出口|cf[_ -]?block|403|region|country mismatch|ip blocked/.test(text)) return AUTH_FAILURE_CATEGORIES.EGRESS_BLOCKED;
  if (/otp.*timeout|code.*timeout|验证码.*超时|等码超时|sms_timeout/.test(text)) return AUTH_FAILURE_CATEGORIES.OTP_TIMEOUT;
  if (/invalid.*otp|otp.*invalid|invalid.*code|验证码.*错误|code.*expired|expired.*code/.test(text)) return AUTH_FAILURE_CATEGORIES.OTP_INVALID;
  if (/password.*reject|invalid.*password|密码.*错误|密码.*拒绝|password.*invalid/.test(text)) return AUTH_FAILURE_CATEGORIES.PASSWORD_REJECTED;
  if (/phone.*required|需要手机|手机号|phone challenge|phone verification/.test(text)) return AUTH_FAILURE_CATEGORIES.PHONE_REQUIRED;
  if (/mfa|required.*2fa|two.?factor|totp|authenticator/.test(text)) return AUTH_FAILURE_CATEGORIES.MFA_REQUIRED;
  if (/session.*extract|access_token|session.*missing|未拿到 access_token/.test(text)) return AUTH_FAILURE_CATEGORIES.SESSION_EXTRACT_FAILED;
  if (/missing|缺少|credential|凭据/.test(text)) return AUTH_FAILURE_CATEGORIES.CREDENTIAL_MISSING;
  if (/preflight|前置/.test(text)) return AUTH_FAILURE_CATEGORIES.PREFLIGHT_FAILED;
  if (/timeout|timed out|econnreset|network|fetch failed|socket/.test(text)) return AUTH_FAILURE_CATEGORIES.TRANSIENT_NETWORK;
  return AUTH_FAILURE_CATEGORIES.UNKNOWN;
}

export function retryPolicyForFailure(category) {
  switch (category) {
    case AUTH_FAILURE_CATEGORIES.BROWSER_UNAVAILABLE:
    case AUTH_FAILURE_CATEGORIES.VALIDATION_TIMEOUT:
    case AUTH_FAILURE_CATEGORIES.VALIDATION_CONTEXT:
    case AUTH_FAILURE_CATEGORIES.VALIDATION_CONFIG:
    case AUTH_FAILURE_CATEGORIES.CANCELLED:
      return { action: 'pause', retry: false, reason: '验证流程已停止，禁止自动重放密码和 TOTP' };
    case AUTH_FAILURE_CATEGORIES.ACCOUNT_DEACTIVATED:
      return { action: 'delete', retry: false, reason: '账号已停用' };
    case AUTH_FAILURE_CATEGORIES.ACCOUNT_ALREADY_EXISTS:
      return { action: 'skip', retry: false, reason: '账号已创建/已存在，当前注册任务跳过' };
    case AUTH_FAILURE_CATEGORIES.CAPTCHA_BLOCKED:
      return { action: 'skip', retry: false, reason: '验证码挑战异常，当前注册任务标记失败并跳过' };
    case AUTH_FAILURE_CATEGORIES.EGRESS_BLOCKED:
      return { action: 'pause', retry: false, reason: '出口异常，等待更换出口/人工处理' };
    case AUTH_FAILURE_CATEGORIES.PASSWORD_REJECTED:
      return { action: 'rebuild_password', retry: true, reason: '密码被拒绝，可重建注册密码后重试' };
    case AUTH_FAILURE_CATEGORIES.OTP_TIMEOUT:
      return { action: 'skip', retry: false, reason: '验证码超时，当前注册任务标记失败并跳过' };
    case AUTH_FAILURE_CATEGORIES.OTP_INVALID:
    case AUTH_FAILURE_CATEGORIES.TRANSIENT_NETWORK:
      return { action: 'retry_stage', retry: true, reason: '可按阶段重试' };
    case AUTH_FAILURE_CATEGORIES.CREDENTIAL_MISSING:
    case AUTH_FAILURE_CATEGORIES.PREFLIGHT_FAILED:
      return { action: 'skip', retry: false, reason: '前置条件不满足' };
    default:
      return { action: 'retry_limited', retry: true, reason: '未知错误，限次重试' };
  }
}
