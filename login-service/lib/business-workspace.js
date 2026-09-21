export function normalizeBusinessWorkspaceIds(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[\r\n,，]+/);
  const seen = new Set(); const result = [];
  for (const item of values) { const id = String(item || '').trim(); if (!id || seen.has(id)) continue; seen.add(id); result.push(id); }
  return result;
}

export function extractBusinessWorkspaceIds(account = {}) {
  const candidates = [];
  const rawSession = account.session_json ?? account.sessionJson;
  if (rawSession && typeof rawSession === 'object') candidates.push(rawSession);
  if (typeof rawSession === 'string' && rawSession.trim()) {
    try { candidates.push(JSON.parse(rawSession)); } catch {}
  }
  const rawStorage = account.storage_state_json ?? account.storageStateJson;
  let storage = rawStorage;
  if (typeof rawStorage === 'string' && rawStorage.trim()) {
    try { storage = JSON.parse(rawStorage); } catch { storage = null; }
  }
  for (const value of workspaceSessionCookieValues(storage?.cookies)) {
    try { candidates.push(decodeWorkspaceSessionCookie(value)); } catch {}
  }
  const result = []; const seen = new Set();
  for (const payload of candidates) {
    for (const workspace of (Array.isArray(payload?.workspaces) ? payload.workspaces : [])) {
      const id = String(workspace?.id || workspace?.workspace_id || workspace?.workspaceId || '').trim();
      const kind = String(workspace?.kind || workspace?.type || workspace?.structure || '').trim().toLowerCase();
      if (!id || kind === 'personal' || seen.has(id)) continue;
      seen.add(id); result.push(id);
    }
  }
  return result;
}

export function resolveBusinessWorkspaceId({ requestWorkspaceIds, accountWorkspaceId, appWorkspaceIds, envWorkspaceIds } = {}) {
  const requested = normalizeBusinessWorkspaceIds(requestWorkspaceIds); if (requested.length) return requested[0];
  const stored = String(accountWorkspaceId || '').trim(); if (stored) return stored;
  const configured = normalizeBusinessWorkspaceIds(appWorkspaceIds); if (configured.length) return configured[0];
  const env = normalizeBusinessWorkspaceIds(envWorkspaceIds); if (env.length) return env[0];
  throw new Error('未配置 Business workspace ID');
}

export function extractSessionAccessToken(account = {}) {
  const direct = String(account.session_access_token || account.sessionAccessToken || '').trim(); if (direct) return direct;
  const raw = account.session_json ?? account.sessionJson; let session = raw;
  if (typeof raw === 'string') { const text = raw.trim(); if (!text) return ''; try { session = JSON.parse(text); } catch { return ''; } }
  return String(session?.accessToken || session?.access_token || session?.token || '').trim();
}

export function normalizeBusinessJoinStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return ['none', 'requested', 'joined', 'rt_ready', 'failed'].includes(status) ? status : 'none';
}

export function decodeWorkspaceSessionCookie(cookie) {
  const value = decodeURIComponent(String(cookie || '').replace(/^"|"$/g, ''));
  const encoded = value.split('.')[0];
  if (!encoded) throw new Error('未找到 oai-client-auth-session cookie，无法提取 workspace');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

export function workspaceSessionCookieValues(cookies = []) {
  const groups = new Map();
  for (const cookie of (Array.isArray(cookies) ? cookies : [])) {
    const name = String(cookie?.key || cookie?.name || '');
    const match = name.match(/^oai-client-auth-session(?:\.(\d+))?$/);
    if (!match) continue;
    // Never assemble chunks belonging to different domains or paths.
    const scope = `${cookie.domain || ''}|${cookie.path || '/'}`;
    if (!groups.has(scope)) groups.set(scope, { value: '', chunks: new Map() });
    const group = groups.get(scope);
    if (match[1] === undefined) group.value = String(cookie.value || '');
    else group.chunks.set(Number(match[1]), String(cookie.value || ''));
  }
  const values = [];
  for (const { value, chunks } of groups.values()) {
    if (value) values.push(value);
    const indexes = [...chunks.keys()].sort((a, b) => a - b);
    if (indexes.length && indexes.every((index, position) => index === position)) {
      values.push(indexes.map(index => chunks.get(index)).join(''));
    }
  }
  return values;
}

export function readWorkspaceSessionPayload(cookies) {
  for (const value of workspaceSessionCookieValues(cookies)) {
    try {
      const payload = decodeWorkspaceSessionCookie(value);
      if (Array.isArray(payload?.workspaces)) return payload;
    } catch {}
  }
  // Cookie names/scopes help diagnose expiry, chunking and path issues without
  // exposing session values, email addresses or OAuth authorization codes.
  const related = cookies.filter(cookie => /^oai-client-auth-session(?:\.|$)/.test(cookie.key || cookie.name || ''));
  const scopes = related.map(cookie => `${cookie.key || cookie.name} [domain=${cookie.domain} path=${cookie.path || '/'}]`).join(', ');
  const error = new Error(related.length
    ? `oai-client-auth-session cookie 不完整或无有效 workspace 数据 (${scopes})`
    : '未找到 oai-client-auth-session cookie，无法提取 workspace');
  error.code = related.length ? 'WORKSPACE_SESSION_INVALID' : 'WORKSPACE_SESSION_MISSING';
  throw error;
}

export function resolveWorkspaceSelection(payload, selection = { mode: 'personal' }) {
  const workspaces = Array.isArray(payload?.workspaces) ? payload.workspaces : [];
  if (selection?.mode === 'id') {
    const wanted = String(selection.workspaceId || '').trim();
    if (workspaces.some(item => String(item?.id || '') === wanted)) return wanted;
    const error = new Error(`当前会话不是 Business workspace ${wanted} 的成员`); error.code = 'BUSINESS_NOT_MEMBER'; throw error;
  }
  const personal = workspaces.find(item => item?.kind === 'personal');
  if (!personal?.id) throw new Error('当前会话未发现 personal workspace');
  return String(personal.id);
}


export function normalizeBusinessJoinRequests(value) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(['requested', 'joined', 'failed']);
  const seen = new Set(); const result = [];
  for (const item of value) {
    const workspaceId = String(item?.workspaceId || item?.workspace_id || '').trim();
    if (!workspaceId || seen.has(workspaceId)) continue;
    seen.add(workspaceId);
    const status = String(item?.status || '').trim().toLowerCase();
    result.push({ workspaceId, status: allowed.has(status) ? status : 'failed', idempotent: Boolean(item?.idempotent), error: String(item?.error || '').trim().slice(0, 500) });
  }
  return result;
}

export function validateBusinessAuthRecord(record, workspaceId) {
  const wanted = String(workspaceId || '').trim();
  const accessToken = String(record?.access_token || '').trim();
  const refreshToken = String(record?.refresh_token || '').trim();
  if (!wanted) throw new Error('Business workspace ID 不能为空');
  if (!accessToken) throw new Error('Business OAuth 结果缺少 access_token');
  if (!refreshToken) throw new Error('Business OAuth 结果缺少 refresh_token');
  const parts = accessToken.split('.');
  if (parts.length < 2) throw new Error('Business access token 不是有效 JWT');
  let claims; try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw new Error('Business access token claims 无法解析'); }
  const clientId = String(claims.client_id || claims.azp || '').trim();
  const auth = claims['https://api.openai.com/auth'] || {};
  const accountId = String(auth.chatgpt_account_id || auth.account_id || record?.account_id || '').trim();
  if (!clientId) throw new Error('Business access token 缺少 Codex client_id');
  if (accountId !== wanted) throw new Error(`Business Codex account id 不匹配: ${accountId || 'missing'}`);
  const expiresAt = Number(claims.exp || (Date.parse(record?.expired || '') / 1000) || 0);
  if (!expiresAt) throw new Error('Business access token 缺少 expiry');
  return { accessToken, refreshToken, accountId, expiresAt, claims, clientId };
}

