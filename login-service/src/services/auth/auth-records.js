import { OPENAI_AGENT_AUTH_MODE, isAgentIdentityRecord } from '../../../lib/openai-agent-identity.js';
import { decodeJwtPayload, firstNonEmpty, getNestedRecord } from '../../../lib/jwt-utils.js';

export function nowIso() {
  return new Date().toISOString();
}

export function resolveOpenAiAccountPassword(account) {
  return String(account?.openai_password || account?.password || '').trim();
}

export function agentIdentityRecordFromAccount(account) {
  const record = {
    auth_mode: OPENAI_AGENT_AUTH_MODE,
    agent_runtime_id: String(account?.agent_runtime_id || ''),
    agent_private_key: String(account?.agent_private_key || ''),
    account_id: String(account?.agent_account_id || ''),
    chatgpt_user_id: String(account?.agent_user_id || ''),
    email: String(account?.email || ''),
    plan_type: String(account?.agent_plan_type || 'free'),
    chatgpt_account_is_fedramp: Boolean(account?.agent_is_fedramp),
  };
  return isAgentIdentityRecord(record) ? record : null;
}

export function normalizeOpenAIAuthRecord(email, payload) {
  if (!payload.access_token) throw new Error(`token响应缺少 access_token: ${JSON.stringify(payload)}`);
  if (!payload.refresh_token) throw new Error(`token响应缺少 refresh_token: ${JSON.stringify(payload)}`);
  if (!payload.id_token) throw new Error(`token响应缺少 id_token: ${JSON.stringify(payload)}`);

  const accessClaims = decodeJwtPayload(payload.access_token);
  const idClaims = decodeJwtPayload(payload.id_token);
  const authClaim = getNestedRecord(accessClaims, 'https://api.openai.com/auth');
  const idAuthClaim = getNestedRecord(idClaims, 'https://api.openai.com/auth');
  const accountId = firstNonEmpty(authClaim.chatgpt_account_id, idAuthClaim.chatgpt_account_id);
  const exp = Number(accessClaims.exp || 0) || Math.floor(Date.now() / 1000) + Number(payload.expires_in || 0);
  if (!accountId) throw new Error(`token中缺少 account_id: ${JSON.stringify(accessClaims)}`);
  if (!exp) throw new Error(`access_token中缺少 exp: ${JSON.stringify(accessClaims)}`);

  return {
    access_token: payload.access_token,
    account_id: accountId,
    disabled: false,
    email: firstNonEmpty(idClaims.email, accessClaims.email, email),
    expired: new Date(exp * 1000).toISOString(),
    id_token: payload.id_token,
    last_refresh: new Date().toISOString(),
    refresh_token: payload.refresh_token,
    type: 'codex',
    websockets: false,
  };
}

export function normalizeOpenAIRecordFromRefreshPayload(email, payload, fallbackRt) {
  const accessToken = String(payload.access_token || '');
  if (!accessToken) throw new Error('刷新 RT 后缺少 access_token');
  const accessClaims = decodeJwtPayload(accessToken);
  const accessAuth = getNestedRecord(accessClaims, 'https://api.openai.com/auth');
  const accountId = firstNonEmpty(accessAuth.chatgpt_account_id, accessAuth.account_id);
  const exp = Number(accessClaims.exp || 0) || Math.floor(Date.now() / 1000) + Number(payload.expires_in || 0);
  const refreshToken = String(payload.refresh_token || fallbackRt || '');
  if (!accountId) throw new Error(`access_token 中缺少 account_id: ${JSON.stringify(accessClaims)}`);
  return {
    access_token: accessToken,
    account_id: accountId,
    email,
    expired: exp ? new Date(exp * 1000).toISOString() : '',
    id_token: String(payload.id_token || ''),
    last_refresh: nowIso(),
    plan_type: firstNonEmpty(accessAuth.chatgpt_plan_type),
    refresh_token: refreshToken,
    type: 'codex',
  };
}
