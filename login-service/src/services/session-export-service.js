const ALIVE_HEALTH = new Set(['alive', 'alive_refreshed']);

// Session payloads are intended for replay and may contain cookies/tokens. Keep
// credential fields out of the export if a caller accidentally persisted them
// alongside the session object.
const SENSITIVE_SESSION_KEY = /^(?:password|openai[_-]?password|two[_-]?factor[_-]?secret|totp|otp|client[_-]?secret)$/i;

function sanitizeSessionValue(value, depth = 0) {
  if (depth > 16) return null;
  if (Array.isArray(value)) return value.map(item => sanitizeSessionValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_SESSION_KEY.test(key)) continue;
    output[key] = sanitizeSessionValue(child, depth + 1);
  }
  return output;
}

export function compactSessionLine(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(sanitizeSessionValue(parsed));
  } catch {
    return '';
  }
}

export function maskEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.indexOf('@');
  if (at <= 0) return value ? '***' : '';
  return `${value.slice(0, Math.min(2, at))}***${value.slice(at)}`;
}

function uniqueStrings(values, { lower = false } = {}) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .map(value => lower ? value.toLowerCase() : value))];
}

export function resolveSessionPayload(account = {}) {
  const raw = String(account.session_json || account.sessionJson || '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const accessToken = String(
          parsed.accessToken || parsed.access_token || account.session_access_token || '',
        ).trim();
        return {
          payload: sanitizeSessionValue({ ...parsed, ...(accessToken && !parsed.accessToken ? { accessToken } : {}) }),
          accessToken,
          line: compactSessionLine(raw),
        };
      }
    } catch { /* Fall through to the token-only representation below. */ }
  }
  const accessToken = String(account.session_access_token || '').trim();
  if (!accessToken) return { payload: null, accessToken: '', line: '' };
  const payload = { accessToken, email: String(account.email || '').trim() };
  return { payload, accessToken, line: JSON.stringify(payload) };
}

export function selectSessionExportAccounts(accounts, { ids = [], emails = [], scope = '' } = {}) {
  const all = Array.isArray(accounts) ? accounts : [];
  const idList = uniqueStrings(ids);
  const emailList = uniqueStrings(emails, { lower: true });
  const selectAll = scope === 'all' && !idList.length && !emailList.length;
  const idSet = new Set(idList);
  const emailSet = new Set(emailList);
  const selected = selectAll
    ? all
    : all.filter(account => idSet.has(String(account.id || '').trim()) || emailSet.has(String(account.email || '').trim().toLowerCase()));
  const missingIds = idList.filter(id => !all.some(account => String(account.id || '').trim() === id));
  const missingEmails = emailList.filter(email => !all.some(account => String(account.email || '').trim().toLowerCase() === email));
  return { selected, missingIds, missingEmails, requestedIds: idList, requestedEmails: emailList };
}

/**
 * Build an export report. The probe callback is deliberately narrow: it only
 * checks the current access token and must not relogin or mutate/delete rows.
 */
export async function buildSessionExportReport({
  accounts = [],
  ids = [],
  emails = [],
  scope = '',
  aliveOnly = false,
  probeSession = null,
} = {}) {
  const selection = selectSessionExportAccounts(accounts, { ids, emails, scope });
  if (aliveOnly && typeof probeSession !== 'function') {
    const error = new Error('aliveOnly 导出未配置无副作用 Session 验活');
    error.code = 'SESSION_PROBE_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  const sessions = [];
  const missing = [
    ...selection.missingIds.map(id => ({ id, reason: 'account_not_found' })),
    ...selection.missingEmails.map(email => ({ emailMasked: maskEmail(email), reason: 'account_not_found' })),
  ];

  for (const account of selection.selected) {
    const resolved = resolveSessionPayload(account);
    const base = { id: String(account.id || ''), email: String(account.email || '').trim() };
    if (!resolved.line) {
      missing.push({ ...base, emailMasked: maskEmail(base.email), reason: 'missing_session' });
      continue;
    }
    let probe = null;
    if (aliveOnly) {
      try {
        probe = await probeSession(account, resolved.accessToken);
      } catch (error) {
        probe = { ok: false, health: 'probe_failed', error: error instanceof Error ? error.message : String(error) };
      }
      const alive = Boolean(probe?.ok) || ALIVE_HEALTH.has(String(probe?.health || '').trim());
      if (!alive) {
        missing.push({
          ...base,
          emailMasked: maskEmail(base.email),
          health: String(probe?.health || 'probe_failed'),
          reason: 'not_alive',
        });
        continue;
      }
    }
    sessions.push({
      ...base,
      session: resolved.payload,
      line: resolved.line,
      health: String(probe?.health || account.session_health || '').trim(),
    });
  }

  return {
    ok: true,
    aliveOnly: Boolean(aliveOnly),
    total: selection.selected.length,
    exported: sessions.length,
    missing,
    sessions,
    requestedIds: selection.requestedIds,
    requestedEmails: selection.requestedEmails,
  };
}

export function sessionExportText(report) {
  const lines = (report?.sessions || []).map(item => String(item.line || '').trim()).filter(Boolean);
  return `${lines.join('\n')}${lines.length ? '\n' : ''}`;
}
