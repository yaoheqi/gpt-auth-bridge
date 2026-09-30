import { buildRefreshTokenBody, OPENAI_OAUTH_TOKEN_URL } from '../../lib/openai-oauth.js';
import { decodeJwtPayload } from '../../lib/jwt-utils.js';
import { assertSessionIdentity, sessionApiError } from './cached-web-session.js';

// Refresh through the same isolated transport/proxy as logout. Save rotated RTs
// before logout so a later network failure does not strand the next attempt.
export async function refreshSessionForLogout(account, { flow, persistAuth }) {
  const workspaceCredentials = Array.isArray(account.business_workspace_credentials) ? account.business_workspace_credentials : [];
  const candidates = [
    { token: account.openai_rt },
    { token: account.business_openai_rt },
    ...workspaceCredentials.map(row => ({ token: row.refreshToken })),
  ].filter((row, index, rows) => row.token && rows.findIndex(other => other.token === row.token) === index);
  for (const candidate of candidates) {
    flow.log('复用已保存的 RT 获取 accessToken，直接调用 logout_all');
    const response = await flow.fetch(OPENAI_OAUTH_TOKEN_URL, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: buildRefreshTokenBody(candidate.token).toString(),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const code = typeof payload?.error === 'string' ? payload.error : payload?.error?.code;
      if ([400, 401].includes(response.status) && ['invalid_grant', 'invalid_token', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated'].includes(code)) continue;
      throw sessionApiError('刷新退出会话令牌', response.status, { code });
    }
    if (!payload?.access_token) throw new Error('RT 刷新未返回 accessToken');
    assertSessionIdentity(account, payload.access_token);
    if (payload.id_token) assertSessionIdentity(account, payload.id_token);
    const refreshToken = payload.refresh_token || candidate.token;
    const expiresAt = Number(decodeJwtPayload(payload.access_token).exp || 0);
    const patch = {};
    for (const [rtKey, prefix] of [['openai_rt', 'openai'], ['business_openai_rt', 'business_openai']]) {
      if (account[rtKey] !== candidate.token) continue;
      Object.assign(patch, { [rtKey]: refreshToken, [`${prefix}_access_token`]: payload.access_token,
        [`${prefix}_token_expires_at`]: expiresAt,
        ...(payload.id_token ? { [`${prefix}_id_token`]: payload.id_token } : {}) });
    }
    if (workspaceCredentials.some(row => row.refreshToken === candidate.token)) {
      patch.business_workspace_credentials = workspaceCredentials.map(row => row.refreshToken === candidate.token
        ? { ...row, refreshToken, accessToken: payload.access_token, expiresAt,
          ...(payload.id_token ? { idToken: payload.id_token } : {}) } : row);
    }
    await persistAuth(patch);
    return { accessToken: payload.access_token };
  }
  return null;
}
