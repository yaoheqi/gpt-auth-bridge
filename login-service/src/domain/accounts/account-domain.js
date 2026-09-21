import { splitPasswordTotpLine } from '../../../../docs/login-account-format.js';
import { randomUUID } from 'node:crypto';
import { OPENAI_STAGES, inferOpenAiStage, normalizeOpenAiStage, stageStatusLabel } from '../../../lib/account-stages.js';
import { hasTotpSecret, normalizeTotpSecret, validateTotpSecret } from '../../../lib/totp.js';
import { normalizeBusinessJoinRequests } from '../../../lib/business-workspace.js';
import { decodeJwtPayload, getNestedRecord } from '../../../lib/jwt-utils.js';

export function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
export function stripExportNamePrefix(value) { return String(value || '').trim().replace(/^\([^)]*\)/, '').trim(); }
export function maskPhone(value) { const text = String(value || '').trim(); return !text || text.length <= 7 ? text : `${text.slice(0, 4)}***${text.slice(-4)}`; }
export function accountHasChatGptSession(account) { return Boolean(String(account?.session_access_token || '').trim()); }
export const ACCOUNT_LOGIN_METHODS = Object.freeze({
  PASSWORD_TOTP: 'password_totp',
  STORED_SESSION: 'stored_session',
  RT: 'rt',
  UNSUPPORTED: 'unsupported',
});
export function resolveAccountLoginMethod(account, { preferStoredSession = false } = {}) {
  if (preferStoredSession && accountHasChatGptSession(account)) return ACCOUNT_LOGIN_METHODS.STORED_SESSION;
  if (String(account?.openai_password || account?.password || '').trim() && hasTotpSecret(account)) return ACCOUNT_LOGIN_METHODS.PASSWORD_TOTP;
  if (accountHasChatGptSession(account)) return ACCOUNT_LOGIN_METHODS.STORED_SESSION;
  if (String(account?.openai_rt || '').trim()) return ACCOUNT_LOGIN_METHODS.RT;
  return ACCOUNT_LOGIN_METHODS.UNSUPPORTED;
}
export function protocolLoginCredentialIssue(account) {
  const hasPassword = Boolean(String(account?.openai_password || account?.password || '').trim());
  const missing = [];
  if (!String(account?.email || '').trim().includes('@')) missing.push('有效邮箱');
  if (!hasPassword) missing.push('密码');
  if (!hasTotpSecret(account)) missing.push('TOTP');
  if (missing.length) return `协议登录仅支持邮箱、密码和 TOTP，缺少${missing.join('和')}`;
  try {
    validateTotpSecret(account.two_factor_secret || account.twoFactorSecret);
  } catch (error) {
    return error.message;
  }
  return '';
}
export function logoutAllCredentialIssue(account) {
  if (!accountHasChatGptSession(account)) return '缺少已保存的 ChatGPT Session';
  return protocolLoginCredentialIssue(account);
}

/** Normalize raw plan strings into free / plus / other known labels. */
export function normalizePlanType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const compact = raw.replace(/^chatgpt[\s_-]*/, '').replace(/[\s_-]*plan$/, '').replace(/_/g, '');
  if (compact === 'free' || compact === 'freeplan') return 'free';
  if (compact === 'plus' || compact === 'chatgptplus') return 'plus';
  if (compact === 'pro' || compact === 'chatgptpro') return 'pro';
  if (compact === 'team' || compact === 'business' || compact === 'enterprise') return compact;
  return raw;
}

function planTypeFromJwt(token) {
  const claims = decodeJwtPayload(token);
  if (!claims || typeof claims !== 'object') return '';
  const auth = getNestedRecord(claims, 'https://api.openai.com/auth');
  return normalizePlanType(auth.chatgpt_plan_type || claims.chatgpt_plan_type || '');
}

export function resolveSessionPlanType(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const sess = JSON.parse(text);
    const candidates = [
      sess?.account?.type,
      sess?.user?.type,
      sess?.type,
      sess?.account?.planType,
      sess?.account?.plan_type,
      sess?.user?.planType,
      sess?.user?.plan_type,
      sess?.planType,
      sess?.plan_type,
    ];
    for (const value of candidates) {
      const plan = normalizePlanType(value);
      if (plan) return plan;
    }
    return planTypeFromJwt(sess?.accessToken || sess?.access_token || '');
  } catch {
    return '';
  }
}

/** Resolve display/filter plan type: free | plus | pro | … | '' (unknown). */
export function resolveAccountPlanType(account = {}) {
  const fromAgent = normalizePlanType(account.agent_plan_type || account.agentPlanType || account.plan_type || account.planType);
  if (fromAgent) return fromAgent;
  const fromSession = resolveSessionPlanType(account.session_json || account.sessionJson);
  if (fromSession) return fromSession;
  for (const key of ['session_access_token', 'sessionAccessToken', 'openai_access_token', 'openaiAccessToken', 'openai_id_token', 'openaiIdToken']) {
    const plan = planTypeFromJwt(account[key]);
    if (plan) return plan;
  }
  return '';
}

export function planTypeLabel(planType) {
  const plan = normalizePlanType(planType);
  if (!plan) return '未知';
  if (plan === 'free') return 'Free';
  if (plan === 'plus') return 'Plus';
  if (plan === 'pro') return 'Pro';
  return plan;
}
const BUSINESS_JOIN_STATUSES = new Set(['none', 'requested', 'joined', 'rt_ready', 'failed']);
export function normalizeBusinessJoinStatus(value) { const status = String(value || '').trim().toLowerCase(); return BUSINESS_JOIN_STATUSES.has(status) ? status : 'none'; }
export function normalizeDbAccount(value = {}, { now = () => new Date().toISOString(), createId = randomUUID } = {}) {
  const email = stripExportNamePrefix(value.email);
  const createdAt = String(value.createdAt || value.created_at || now());
  const account = {
    id: String(value.id || '').trim() || createId(), email, emailKey: normalizeEmail(email), password: String(value.password || ''),
    openai_password: String(value.openai_password || value.openaiPassword || '').trim(), openai_name: String(value.openai_name || value.openaiName || '').trim(),
    openai_birthdate: String(value.openai_birthdate || value.openaiBirthdate || '').trim(), two_factor_secret: normalizeTotpSecret(value.two_factor_secret || value.twoFactorSecret || ''),
    raw: String(value.raw || '').trim(),
    openai_rt: String(value.openai_rt || value.openaiRt || value.rt_token || '').trim(), openai_access_token: String(value.openai_access_token || value.openaiAccessToken || '').trim(),
    openai_id_token: String(value.openai_id_token || value.openaiIdToken || '').trim(), openai_account_id: String(value.openai_account_id || value.openaiAccountId || '').trim(),
    openai_token_expires_at: Number(value.openai_token_expires_at || value.openaiTokenExpiresAt || 0) || 0,
    agent_runtime_id: String(value.agent_runtime_id || value.agentRuntimeId || '').trim(),
    agent_private_key: String(value.agent_private_key || value.agentPrivateKey || '').trim(), agent_account_id: String(value.agent_account_id || value.agentAccountId || value.account_id || '').trim(),
    agent_user_id: String(value.agent_user_id || value.agentUserId || value.chatgpt_user_id || '').trim(), agent_plan_type: String(value.agent_plan_type || value.agentPlanType || value.plan_type || '').trim(),
    agent_is_fedramp: Boolean(value.agent_is_fedramp || value.agentIsFedramp || value.chatgpt_account_is_fedramp), auth_phone_number: String(value.auth_phone_number || value.authPhoneNumber || '').trim(),
    auth_phone_sms_url: String(value.auth_phone_sms_url || value.authPhoneSmsUrl || '').trim(),
    sms_provider: String(value.sms_provider || value.smsProvider || '').trim(), sms_activation_id: String(value.sms_activation_id || value.smsActivationId || '').trim(),
    sms_activation_status: String(value.sms_activation_status || value.smsActivationStatus || '').trim(), openai_stage: normalizeOpenAiStage(value.openai_stage || value.openaiStage, ''),
    last_error: String(value.last_error || value.lastError || '').trim(), status: String(value.status || '').trim(), last_sms_code: String(value.last_sms_code || value.lastSmsCode || '').trim(),
    last_sms_at: String(value.last_sms_at || value.lastSmsAt || '').trim(), session_access_token: String(value.session_access_token || value.sessionAccessToken || value.access_token || '').trim(),
    session_json: String(value.session_json || value.sessionJson || '').trim(), storage_state_path: String(value.storage_state_path || value.storageStatePath || '').trim(), storage_state_json: String(value.storage_state_json || value.storageStateJson || '').trim(),
    session_health: String(value.session_health || value.sessionHealth || '').trim(), session_health_checked_at: String(value.session_health_checked_at || value.sessionHealthCheckedAt || '').trim(),
    session_health_detail: String(value.session_health_detail || value.sessionHealthDetail || '').trim(),
    fingerprint_json: String(value.fingerprint_json || value.fingerprintJson || '').trim(),
    fingerprint_region: String(value.fingerprint_region || value.fingerprintRegion || '').trim(),
    egress_country: String(value.egress_country || value.egressCountry || '').trim(),
    egress_ip: String(value.egress_ip || value.egressIp || '').trim(),
    egress_source: String(value.egress_source || value.egressSource || '').trim(),
    plus_trial_eligible: value.plus_trial_eligible === true || value.plus_trial_eligible === 1 || value.plusTrialEligible === true
      ? true
      : (value.plus_trial_eligible === false || value.plus_trial_eligible === 0 || value.plusTrialEligible === false ? false : null),
    plus_trial_campaign: String(value.plus_trial_campaign || value.plusTrialCampaign || '').trim(),
    plus_trial_country: String(value.plus_trial_country || value.plusTrialCountry || '').trim(),
    plus_trial_checked_at: String(value.plus_trial_checked_at || value.plusTrialCheckedAt || '').trim(),
    plus_trial_detail: String(value.plus_trial_detail || value.plusTrialDetail || '').trim(),
    sub2api_pushed: Boolean(value.sub2api_pushed || value.sub2apiPushed),
    sub2api_pushed_at: String(value.sub2api_pushed_at || value.sub2apiPushedAt || '').trim(),
    sub2api_push_source: String(value.sub2api_push_source || value.sub2apiPushSource || '').trim(),
    sub2api_account_id: value.sub2api_account_id ?? value.sub2apiAccountId ?? null,
    business_workspace_id: String(value.business_workspace_id || value.businessWorkspaceId || '').trim(),
    business_join_status: normalizeBusinessJoinStatus(value.business_join_status || value.businessJoinStatus),
    business_join_requested_at: String(value.business_join_requested_at || value.businessJoinRequestedAt || '').trim(),
    business_join_error: String(value.business_join_error || value.businessJoinError || '').trim(),
    business_openai_rt: String(value.business_openai_rt || value.businessOpenAiRt || value.businessOpenaiRt || '').trim(),
    business_openai_access_token: String(value.business_openai_access_token || value.businessOpenAiAccessToken || value.businessOpenaiAccessToken || '').trim(),
    business_openai_id_token: String(value.business_openai_id_token || value.businessOpenAiIdToken || value.businessOpenaiIdToken || '').trim(),
    business_openai_account_id: String(value.business_openai_account_id || value.businessOpenAiAccountId || value.businessOpenaiAccountId || '').trim(),
    business_openai_token_expires_at: Number(value.business_openai_token_expires_at || value.businessOpenAiTokenExpiresAt || value.businessOpenaiTokenExpiresAt || 0) || 0,
    business_sub2api_pushed: Boolean(value.business_sub2api_pushed || value.businessSub2apiPushed),
    business_sub2api_pushed_at: String(value.business_sub2api_pushed_at || value.businessSub2apiPushedAt || '').trim(),
    business_sub2api_push_source: String(value.business_sub2api_push_source || value.businessSub2apiPushSource || '').trim(),
    business_join_requests: normalizeBusinessJoinRequests(value.business_join_requests || value.businessJoinRequests),
    business_workspace_credentials: Array.isArray(value.business_workspace_credentials || value.businessWorkspaceCredentials)
      ? (value.business_workspace_credentials || value.businessWorkspaceCredentials).map(item => ({
        workspaceId: String(item?.workspaceId || item?.workspace_id || '').trim(),
        status: String(item?.status || 'rt_ready').trim(),
        refreshToken: String(item?.refreshToken || item?.refresh_token || '').trim(),
        accessToken: String(item?.accessToken || item?.access_token || '').trim(),
        idToken: String(item?.idToken || item?.id_token || '').trim(),
        accountId: String(item?.accountId || item?.account_id || '').trim(),
        expiresAt: Number(item?.expiresAt || item?.expires_at || 0) || 0,
        error: String(item?.error || '').trim().slice(0, 500),
      })).filter(item => item.workspaceId)
      : [],
    business_sub2api_account_id: value.business_sub2api_account_id ?? value.businessSub2apiAccountId ?? null,
    createdAt, updatedAt: String(value.updatedAt || value.updated_at || createdAt),
  };
  if (!account.openai_stage) account.openai_stage = inferOpenAiStage(account);
  return account;
}

export function accountSourceType(account = {}) {
  const method = resolveAccountLoginMethod(account);
  if (method === ACCOUNT_LOGIN_METHODS.PASSWORD_TOTP) return 'password_totp';
  if (account.openai_rt) return 'rt';
  return 'unknown';
}

export function accountLoginMethodLabel(method) {
  const value = String(method || '').trim().toLowerCase();
  if (value === ACCOUNT_LOGIN_METHODS.PASSWORD_TOTP) return '密码+TOTP';
  if (value === ACCOUNT_LOGIN_METHODS.STORED_SESSION) return '已保存Session';
  if (value === ACCOUNT_LOGIN_METHODS.RT) return 'RT登录';
  return '未知';
}

export function accountSourceTypeLabel(value) {
  const type = String(value || '').trim().toLowerCase();
  if (type === 'password_totp') return '密码+2FA';
  if (type === 'rt') return 'RT';
  return '未知';
}

function viewBase(account) {
  const stage = inferOpenAiStage(account);
  const planType = resolveAccountPlanType(account);
  const loginMethod = resolveAccountLoginMethod(account);
  return {
    id: account.id, email: account.email, status: account.status || stageStatusLabel(stage), openaiStage: stage, lastError: account.last_error || '',
    planType,
    planTypeLabel: planTypeLabel(planType),
    loginMethod,
    loginMethodLabel: accountLoginMethodLabel(loginMethod),
    sourceType: accountSourceType(account),
    sourceTypeLabel: accountSourceTypeLabel(accountSourceType(account)),
    hasPasswordTotp: hasTotpSecret(account), canProtocolLogin: !protocolLoginCredentialIssue(account), hasOpenAiRt: Boolean(account.openai_rt),
    hasBusinessOpenAiRt: Boolean(account.business_openai_rt),
    businessWorkspaceId: account.business_workspace_id || '',
    businessWorkspaceIds: [...new Set([
      ...(Array.isArray(account.business_workspace_credentials) ? account.business_workspace_credentials.map(item => String(item?.workspaceId || '').trim()) : []),
      String(account.business_workspace_id || '').trim(),
    ].filter(Boolean))],
    businessJoinStatus: normalizeBusinessJoinStatus(account.business_join_status),
    hasAgentIdentity: Boolean(account.agent_runtime_id), hasSmsUrl: Boolean(
      account.auth_phone_sms_url
      || (['smsbower', 'manual_sms'].includes(String(account.sms_provider || '').trim().toLowerCase()) && account.sms_activation_id),
    ),
    authPhoneNumber: maskPhone(account.auth_phone_number), lastSmsCode: account.last_sms_code || '', lastSmsAt: account.last_sms_at || '',
    plusTrialEligible: account.plus_trial_eligible === true ? true : (account.plus_trial_eligible === false ? false : null),
    plusTrialCampaign: account.plus_trial_campaign || '',
    plusTrialCountry: account.plus_trial_country || '',
    plusTrialCheckedAt: account.plus_trial_checked_at || '',
    plusTrialDetail: account.plus_trial_detail || '',
  };
}
export function publicAccountView(account, { sessionHealthLabel = value => String(value || '') } = {}) {
  return {
    ...viewBase(account),
    hasChatGptSession: accountHasChatGptSession(account),
    sessionHealth: account.session_health || '',
    sessionHealthLabel: sessionHealthLabel(account.session_health || ''),
    sessionHealthCheckedAt: account.session_health_checked_at || '',
    sessionHealthDetail: account.session_health_detail || '',
    sub2apiPushed: Boolean(account.sub2api_pushed),
    sub2apiPushedAt: account.sub2api_pushed_at || '',
    sub2apiPushSource: account.sub2api_push_source || '', businessSub2apiPushed: Boolean(account.business_sub2api_pushed),
    businessSub2apiPushedAt: account.business_sub2api_pushed_at || '', businessSub2apiPushSource: account.business_sub2api_push_source || '',
    businessJoinRequestedAt: account.business_join_requested_at || '', businessJoinError: account.business_join_error || '',
    businessJoinRequests: normalizeBusinessJoinRequests(account.business_join_requests),
    businessOpenAiAccountId: account.business_openai_account_id || '', businessOpenAiTokenExpiresAt: account.business_openai_token_expires_at || 0,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}
export function userAccountView(account, actionToken = '') { return { ...viewBase(account), actionToken }; }

export function parseAccountExtraParts(parts) {
  const result = {};
  for (const part of parts || []) { const text = String(part || '').trim(); const eq = text.indexOf('='); if (eq <= 0) continue; const key = text.slice(0, eq).trim(); const value = text.slice(eq + 1).trim(); if (key === 'rt_token' || key === 'openai_rt') result.openai_rt = value; if (key === 'auth_phone') result.auth_phone_number = value; if (key === 'auth_phone_sms_url' || key === 'sms_url') result.auth_phone_sms_url = value; }
  return result;
}
export function parseAccount(line) {
  const text = String(line || '').trim();
  if (!text) throw new Error('空行');
  const parts = splitPasswordTotpLine(text);
  if (parts.length !== 3) throw new Error('账户格式错误，仅支持 email----password----2fa、email---password---2fa、email--password--2fa 或 email|password|2fa');
  const [emailRaw, password, secretRaw] = parts;
  const email = stripExportNamePrefix(emailRaw);
  if (!email || !email.includes('@')) throw new Error('缺少有效邮箱');
  if (!password) throw new Error('GPT 密码不能为空');
  const secret = validateTotpSecret(secretRaw);
  return { email, password, openai_password: password, two_factor_secret: secret, raw: text, mode: 'password_totp' };
}
export function parseManagementImportLine(line) {
  return parseAccount(line);
}
export function parseUserImportLine(line) {
  const text = String(line || '').trim();
  if (!text) throw new Error('空行');
  if (splitPasswordTotpLine(text).length === 3) return parseManagementImportLine(text);
  const parts = text.split('----').map(part => part.trim());
  if (parts.length === 2 && parts[0]?.includes('@') && parts[1]) {
    const email = stripExportNamePrefix(parts[0]);
    if (!email || !email.includes('@')) throw new Error('缺少有效邮箱');
    return { email, password: '', openai_rt: parts[1], raw: [email, parts[1]].join('----'), mode: 'rt' };
  }
  const imported = parseManagementImportLine(text);
  const hasCredential = Boolean(
    String(imported.openai_rt || '').trim()
    || (String(imported.password || imported.openai_password || '').trim() && String(imported.two_factor_secret || '').trim()),
  );
  if (!hasCredential) throw new Error('购买校验必须提供完整账号凭证，不能只填写邮箱');
  return imported;
}

export function mergeImportedAccount(existing, imported, { now = () => new Date().toISOString(), normalize = normalizeDbAccount } = {}) {
  const timestamp = now();
  if (existing) {
    existing.email = imported.email || existing.email;
    existing.emailKey = normalizeEmail(existing.email);
    if ('password' in imported) existing.password = imported.password || '';
    for (const key of ['openai_password', 'two_factor_secret', 'raw', 'openai_rt', 'auth_phone_number', 'auth_phone_sms_url']) {
      if (imported[key]) existing[key] = key === 'two_factor_secret' ? normalizeTotpSecret(imported[key]) : imported[key];
    }
    existing.status = imported.openai_rt ? '已导入RT' : imported.mode === 'password_totp' ? '已导入密码+2FA' : '已更新账号';
    if (imported.mode === 'password_totp' && (!existing.openai_stage || existing.openai_stage === OPENAI_STAGES.IMPORTED)) {
      existing.openai_stage = OPENAI_STAGES.REGISTERED;
    }
    existing.updatedAt = timestamp;
    return existing;
  }
  return normalize({
    ...imported,
    openai_password: imported.openai_password || (imported.mode === 'password_totp' ? imported.password : '') || '',
    openai_stage: imported.mode === 'password_totp' ? OPENAI_STAGES.REGISTERED : undefined,
    status: imported.openai_rt ? '已导入RT' : imported.mode === 'password_totp' ? '已导入密码+2FA' : '账号已导入',
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}
export function buildOriginalImportLine(account) {
  const extras = [];
  if (account.auth_phone_number) extras.push(`auth_phone=${account.auth_phone_number}`);
  if (account.auth_phone_sms_url) extras.push(`auth_phone_sms_url=${account.auth_phone_sms_url}`);
  if (hasTotpSecret(account)) {
    const base = [account.email, String(account.openai_password || account.password || '').trim(), normalizeTotpSecret(account.two_factor_secret)].join('|');
    return extras.length ? [base, ...extras].join('----') : base;
  }
  const raw = String(account.raw || '').trim();
  if (raw && !/\brt_token\s*=/.test(raw)) return [raw, ...extras].join('----');
  return '';
}
