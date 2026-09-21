import { buildSub2ApiExport } from '../../../lib/export-sub2api.js';
import { registerOpenAIAgentIdentity } from '../../../lib/openai-agent-identity.js';
import { decodeJwtPayload, firstNonEmpty, getNestedRecord } from '../../../lib/jwt-utils.js';

function parseObject(value, label = 'Session JSON') {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 不能为空`);
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${label} 不是有效 JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} 必须是 JSON 对象`);
  return parsed;
}

export function normalizeSessionConversionInput(body) {
  const source = parseObject(body?.session ?? body, 'Session JSON');
  const nested = source.session && typeof source.session === 'object' && !Array.isArray(source.session)
    ? source.session
    : source;
  let serialized = {};
  for (const key of ['session_json', 'sessionJson']) {
    if (source[key]) { serialized = parseObject(source[key], key); break; }
  }
  const session = Object.keys(serialized).length ? serialized : nested;
  const credentials = source.credentials && typeof source.credentials === 'object' ? source.credentials : {};
  const accessToken = firstNonEmpty(
    session.accessToken, session.access_token, session.token,
    source.accessToken, source.access_token, source.token,
    credentials.accessToken, credentials.access_token, credentials.token,
  );
  if (!accessToken) throw new Error('Session JSON 缺少 accessToken');
  const claims = decodeJwtPayload(accessToken);
  const profile = getNestedRecord(claims, 'https://api.openai.com/profile');
  const user = session.user && typeof session.user === 'object' ? session.user : {};
  return { accessToken, email: firstNonEmpty(session.email, user.email, source.email, profile.email) };
}

function applyConcurrency(exported, concurrencyRaw) {
  const concurrency = Number(concurrencyRaw);
  if (!(Number.isFinite(concurrency) && concurrency > 0)) return exported;
  const value = Math.max(1, Math.min(100, Math.trunc(concurrency)));
  for (const account of exported.accounts || []) account.concurrency = value;
  return exported;
}

export function registerConversionRoutes(app, {
  requireAdmin = (_req, _res, next) => next(),
  registerIdentity = registerOpenAIAgentIdentity,
  resolveAccountSessions = null,
  getConcurrency = null,
  getExportSettings = null,
} = {}) {
  app.post('/api/v2/conversions/session-agent', requireAdmin, async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(x => String(x || '').trim()).filter(Boolean) : [];
      if (ids.length) {
        if (typeof resolveAccountSessions !== 'function') {
          throw new Error('账号 Session 转换未配置 resolveAccountSessions');
        }
        const sessions = await resolveAccountSessions(ids);
        if (!sessions.length) throw new Error('所选账号均无可用 Session');
        const identities = [];
        for (const item of sessions) {
          const { accessToken, email } = normalizeSessionConversionInput({ session: item.session || item });
          identities.push(await registerIdentity({ accessToken, email: email || item.email }));
        }
        const exported = applyConcurrency(buildSub2ApiExport(identities, undefined, typeof getExportSettings === 'function' ? getExportSettings() : {}), typeof getConcurrency === 'function' ? getConcurrency() : req.body?.concurrency);
        res.setHeader('Cache-Control', 'no-store');
        return res.json(exported);
      }

      const { accessToken, email } = normalizeSessionConversionInput(req.body);
      const identity = await registerIdentity({ accessToken, email });
      const exported = applyConcurrency(buildSub2ApiExport([identity], undefined, typeof getExportSettings === 'function' ? getExportSettings() : {}), typeof getConcurrency === 'function' ? getConcurrency() : req.body?.concurrency);
      res.setHeader('Cache-Control', 'no-store');
      res.json(exported);
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: { code: 'INVALID_SESSION_CONVERSION', message: error instanceof Error ? error.message : String(error) },
        requestId: String(req.requestId || req.get?.('x-request-id') || '').trim() || undefined,
      });
    }
  });
}
