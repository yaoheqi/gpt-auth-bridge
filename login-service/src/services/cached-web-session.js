import { decodeJwtPayload } from '../../lib/jwt-utils.js';
import { CHATGPT_AUTH_SESSION_URL } from '../../lib/openai-auth-urls.js';
import { terminalLoginFailure } from './monitor-coordinator.js';

const emailKey = value => String(value || '').trim().toLowerCase();
export function sessionApiError(label, status, payload) {
  const rawCode = payload?.error?.code || payload?.detail?.code || payload?.code || '';
  const code = /^[a-z0-9_]{1,80}$/i.test(String(rawCode)) ? String(rawCode) : '';
  return Object.assign(new Error(`${label} 失败: HTTP ${status}${code ? ` (${code})` : ''}`), { status, code });
}

export function assertSessionIdentity(account, accessToken, session = {}) {
  const claims = decodeJwtPayload(accessToken);
  const emails = [claims.email, claims['https://api.openai.com/profile']?.email, session?.user?.email];
  if (emails.some(email => email && emailKey(email) !== emailKey(account.email))) {
    throw new Error('已保存 Session 与输入邮箱不匹配，已停止操作');
  }
}

export function hasStoredAuthCookies(account, { webOnly = false } = {}) {
  let state;
  try { state = JSON.parse(account.storage_state_json || '{}'); } catch { return false; }
  return Array.isArray(state?.cookies) && state.cookies.some(cookie => {
    const domain = String(cookie?.domain || '').replace(/^\./, '').toLowerCase();
    const host = webOnly ? domain === 'chatgpt.com' : /(^|\.)(chatgpt\.com|openai\.com)$/.test(domain);
    return host && cookie.value && (!webOnly || /^(?:__Secure-)?(?:next-auth|authjs)\.session-token(?:\.\d+)?$/.test(cookie.name))
      && !(Number(cookie.expires) > 0 && Number(cookie.expires) * 1000 <= Date.now());
  });
}

// A generic 403, challenge, rate limit or transport failure is not evidence that
// credentials are invalid. Only explicit auth rejection permits one new login.
export function needsSessionReauthentication(error) {
  if (terminalLoginFailure(error)) return false;
  const code = String(error?.code || '').toLowerCase();
  return Number(error?.status) === 401 || [
    'token_invalidated', 'token_expired', 'invalid_token', 'session_expired', 'invalid_session', 'session_invalidated', 'unauthorized',
    'authentication_required', 'reauthentication_required', 'reauth_required',
    'requires_reauth', 'recent_authentication_required', 'fresh_auth_required',
  ].includes(code);
}

// All state belongs to this request's isolated flow and the browser snapshot.
// Use the requested operation itself to validate a cached token; no redundant
// health probe before logout/MFA. Persist fresh sessions before a later failure.
export async function withCachedWebSession(account, {
  flow, persistSession = async () => {},
}, operation) {
  let storedSession = {};
  try { storedSession = JSON.parse(account.session_json || '{}'); } catch {}
  let accessToken = String(account.session_access_token || storedSession?.accessToken || storedSession?.access_token || '').trim();
  if (accessToken) assertSessionIdentity(account, accessToken, storedSession);
  const expires = Number(decodeJwtPayload(accessToken).exp || 0);
  if (expires && expires * 1000 <= Date.now() + 30_000) accessToken = '';
  await flow.importStoredCookieStorageState();
  let session = accessToken ? { accessToken, session: { ...storedSession, accessToken } } : null;
  let reused = Boolean(session);
  if (!session && hasStoredAuthCookies(account, { webOnly: true })) {
    flow.log('尝试从浏览器缓存 Cookie 恢复 ChatGPT Session');
    let payload;
    try {
      payload = await flow.fetchChatGptJson(CHATGPT_AUTH_SESSION_URL, { label: '恢复 Session', allowCookieAuth: true });
    } catch (error) { if (!needsSessionReauthentication(error)) throw error; }
    const token = payload?.accessToken || payload?.access_token;
    if (token) {
      assertSessionIdentity(account, token, payload);
      session = { accessToken: token, session: payload };
      reused = true;
      await persistSession({ ...session, storageState: await flow.exportCookieStorageState() });
    }
  }
  const login = async forceFresh => {
    flow.reuseStoredSession = !forceFresh && hasStoredAuthCookies(account);
    const result = await flow.loginChatGptWebWithPasswordTotp();
    if (!result?.accessToken) throw new Error('协议登录未返回 ChatGPT accessToken');
    assertSessionIdentity(account, result.accessToken, result.session);
    await persistSession(result);
    return result;
  };
  if (!session) {
    session = await login(false);
    reused = flow.reuseStoredSession;
  } else flow.log('优先复用当前浏览器保存的 ChatGPT Session');
  try { return { result: await operation(session.accessToken, { reused }), session, reused }; }
  catch (error) {
    // Never restart a partially completed MFA mutation with the old TOTP.
    if (!reused || error.authMutationStarted || !needsSessionReauthentication(error)) throw error;
    flow.log('缓存 Session 失效或操作要求重新认证，使用密码和 TOTP 登录一次', 'warn');
    session = await login(true);
    return { result: await operation(session.accessToken, { reused: false }), session, reused: false };
  }
}
