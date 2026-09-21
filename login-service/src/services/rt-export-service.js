import { decodeJwtPayload, firstNonEmpty, getNestedRecord } from '../../lib/jwt-utils.js';
import { OPENAI_CODEX_CLIENT_ID } from '../../lib/openai-oauth.js';

const EXPORTABLE_SESSION_HEALTH = new Set(['alive', 'alive_refreshed']);

export function buildStoredRtExportRecord(account) {
  const refreshToken = String(account?.openai_rt || '').trim();
  if (!refreshToken) throw new Error('缺少 current openai_rt');
  const accessToken = String(account?.openai_access_token || '').trim();
  if (!accessToken) throw new Error('缺少 paired Codex access token');
  const claims = decodeJwtPayload(accessToken);
  const clientId = String(claims.client_id || claims.azp || '').trim();
  if (clientId !== OPENAI_CODEX_CLIENT_ID) {
    throw new Error(`access token 不是 Codex OAuth 客户端签发: ${clientId || 'missing client_id'}`);
  }
  const auth = getNestedRecord(claims, 'https://api.openai.com/auth');
  const accountId = firstNonEmpty(account?.openai_account_id, auth.chatgpt_account_id, auth.account_id);
  if (!accountId) throw new Error('Codex access token 缺少 account id');
  const expiresAt = Number(claims.exp || account?.openai_token_expires_at || 0);
  if (!expiresAt) throw new Error('Codex access token 缺少 expiry');
  return {
    email: String(account?.email || '').trim(),
    access_token: accessToken,
    refresh_token: refreshToken,
    id_token: String(account?.openai_id_token || '').trim(),
    account_id: accountId,
    plan_type: firstNonEmpty(auth.chatgpt_plan_type, 'free'),
    expired: new Date(expiresAt * 1000).toISOString(),
  };
}


export function buildStoredBusinessRtExportRecord(account) {
  const workspaceId = String(account?.business_workspace_id || '').trim();
  const refreshToken = String(account?.business_openai_rt || '').trim();
  const accessToken = String(account?.business_openai_access_token || '').trim();
  if (!workspaceId) throw new Error('缺少 business_workspace_id');
  if (!refreshToken) throw new Error('缺少 business_openai_rt');
  if (!accessToken) throw new Error('缺少 paired Business Codex access token');
  const claims = decodeJwtPayload(accessToken);
  const clientId = String(claims.client_id || claims.azp || '').trim();
  if (clientId !== OPENAI_CODEX_CLIENT_ID) throw new Error('Business access token 不是 Codex OAuth 客户端签发');
  const auth = getNestedRecord(claims, 'https://api.openai.com/auth');
  const accountId = firstNonEmpty(auth.chatgpt_account_id, auth.account_id, account?.business_openai_account_id);
  if (accountId !== workspaceId) throw new Error(`Business Codex token/workspace 不匹配: ${accountId || 'missing'} != ${workspaceId}`);
  const expiresAt = Number(claims.exp || account?.business_openai_token_expires_at || 0);
  if (!expiresAt) throw new Error('Business Codex access token 缺少 expiry');
  return { email: String(account?.email || '').trim(), access_token: accessToken, refresh_token: refreshToken, id_token: String(account?.business_openai_id_token || '').trim(), account_id: accountId, plan_type: firstNonEmpty(auth.chatgpt_plan_type, 'business'), expired: new Date(expiresAt * 1000).toISOString(), extra: { source: 'codex-business-rt', workspace_id: workspaceId } };
}

export function buildStoredBusinessRtExportRecords(account) {
  const entries = Array.isArray(account?.business_workspace_credentials) ? account.business_workspace_credentials : [];
  if (!entries.length) return [buildStoredBusinessRtExportRecord(account)];
  const records = [];
  const errors = [];
  for (const entry of entries) {
    try {
      records.push(buildStoredBusinessRtExportRecord({
        ...account,
        business_workspace_id: entry.workspaceId,
        business_openai_rt: entry.refreshToken,
        business_openai_access_token: entry.accessToken,
        business_openai_id_token: entry.idToken,
        business_openai_account_id: entry.accountId || entry.workspaceId,
        business_openai_token_expires_at: entry.expiresAt,
      }));
    } catch (error) {
      errors.push(`${String(entry?.workspaceId || 'unknown')}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!records.length) throw new Error(errors.join('; ') || '没有可导出的 Business RT');
  return records;
}

export function selectAliveExportAccounts(accounts, healthResults) {
  const healthById = new Map((healthResults || []).map(result => [String(result.id || ''), result]));
  return (accounts || []).map(account => ({ account, health: healthById.get(String(account.id || '')) }))
    .filter(item => EXPORTABLE_SESSION_HEALTH.has(String(item.health?.health || '')));
}

export function selectRtExportAccounts(accounts, healthResults, { skipHealthCheck = false } = {}) {
  if (skipHealthCheck) return (accounts || []).map(account => ({ account }));
  return selectAliveExportAccounts(accounts, healthResults);
}


export function partitionRtExportCandidates(accounts = []) {
  const eligible = [];
  const errors = [];
  for (const account of accounts) {
    if (String(account?.openai_rt || '').trim()) eligible.push(account);
    else errors.push({ email: String(account?.email || ''), error: 'MISSING_REFRESH_TOKEN' });
  }
  return { eligible, errors };
}
