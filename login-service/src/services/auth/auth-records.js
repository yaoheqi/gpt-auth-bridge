import { OPENAI_CODEX_CLIENT_ID } from '../../../lib/openai-oauth.js';
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

function accountIdFromClaims(claims) {
  const auth = getNestedRecord(claims, 'https://api.openai.com/auth');
  return firstNonEmpty(auth.chatgpt_account_id, auth.account_id);
}

function accessTokenExpiry(payload, accessClaims) {
  const claimExpiry = Number(accessClaims.exp || 0);
  if (Number.isFinite(claimExpiry) && claimExpiry > 0) return Math.floor(claimExpiry);
  const expiresIn = Number(payload.expires_in || 0);
  return Number.isFinite(expiresIn) && expiresIn > 0
    ? Math.floor(Date.now() / 1000) + Math.floor(expiresIn)
    : 0;
}

export function validateOpenAIIdTokenAccount(idToken, expectedAccountId) {
  const token = String(idToken || '').trim();
  if (!token) return '';
  const idAccountId = accountIdFromClaims(decodeJwtPayload(token));
  // Some older ID tokens do not expose the account claim. They remain usable
  // for existing flows, but any present claim must match the access token.
  if (!idAccountId) return token;
  if (expectedAccountId && idAccountId !== expectedAccountId) {
    throw new Error('OpenAI token account_id 不一致');
  }
  return token;
}

export function normalizeOpenAIAuthRecord(email, payload) {
  if (!payload.access_token) throw new Error('token响应缺少 access_token');
  if (!payload.refresh_token) throw new Error('token响应缺少 refresh_token');
  if (!payload.id_token) throw new Error('token响应缺少 id_token');

  const accessClaims = decodeJwtPayload(payload.access_token);
  const idClaims = decodeJwtPayload(payload.id_token);
  const accessAccountId = accountIdFromClaims(accessClaims);
  const idAccountId = accountIdFromClaims(idClaims);
  const accountId = firstNonEmpty(accessAccountId, idAccountId);
  const exp = accessTokenExpiry(payload, accessClaims);
  if (!accountId) throw new Error('token中缺少 account_id');
  validateOpenAIIdTokenAccount(payload.id_token, accountId);
  if (!exp) throw new Error('access_token中缺少 exp');

  return {
    access_token: payload.access_token,
    account_id: accountId,
    disabled: false,
    email: firstNonEmpty(idClaims.email, accessClaims.email, email),
    expired: new Date(exp * 1000).toISOString(),
    id_token: payload.id_token,
    last_refresh: new Date().toISOString(),
    refresh_token: payload.refresh_token,
    client_id: OPENAI_CODEX_CLIENT_ID,
    type: 'codex',
    websockets: false,
  };
}

export function normalizeOpenAIRecordFromRefreshPayload(email, payload, fallbackRt, fallbackIdToken = '') {
  const accessToken = String(payload.access_token || '');
  if (!accessToken) throw new Error('刷新 RT 后缺少 access_token');
  const accessClaims = decodeJwtPayload(accessToken);
  const accessAuth = getNestedRecord(accessClaims, 'https://api.openai.com/auth');
  const accountId = firstNonEmpty(accessAuth.chatgpt_account_id, accessAuth.account_id);
  const exp = accessTokenExpiry(payload, accessClaims);
  const refreshToken = String(payload.refresh_token || fallbackRt || '');
  if (!accountId) throw new Error('access_token 中缺少 account_id');
  if (!exp) throw new Error('access_token 中缺少 exp');
  const idToken = validateOpenAIIdTokenAccount(
    payload.id_token || fallbackIdToken,
    accountId,
    payload.id_token ? '刷新响应 id_token' : '已保存 id_token',
  );
  return {
    access_token: accessToken,
    account_id: accountId,
    email,
    expired: exp ? new Date(exp * 1000).toISOString() : '',
    id_token: idToken,
    last_refresh: nowIso(),
    plan_type: firstNonEmpty(accessAuth.chatgpt_plan_type),
    refresh_token: refreshToken,
    client_id: OPENAI_CODEX_CLIENT_ID,
    type: 'codex',
  };
}
