import { buildSessionExportReport, sessionExportText } from '../../services/session-export-service.js';
import { sendOperationError } from '../../http/operation-error.js';

function requestId(req) {
  return String(req?.requestId || req?.res?.locals?.requestId || req?.get?.('x-request-id') || '').trim() || undefined;
}

function routeError(res, req, error, fallbackCode = 'SESSION_EXPORT_FAILED', fallbackStatus = 400) {
  return sendOperationError(res, error, {
    fallbackCode, fallbackStatus, errorShape: 'object', requestId: requestId(req),
  });
}

export function registerSessionExportRoutes(app, {
  requireAdmin = (_req, _res, next) => next(),
  ensureDatabase = async () => {},
  getAccounts = () => [],
  probeSession = null,
} = {}) {
  app.post('/api/v2/accounts/export-sessions', requireAdmin, async (req, res) => {
    try {
      await ensureDatabase();
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const emails = Array.isArray(body.emails) ? body.emails : [];
      const scope = String(body.scope || '').trim().toLowerCase();
      if (!ids.length && !emails.length && scope !== 'all') {
        const error = new Error('export-sessions 需要 ids、emails，或 scope=all');
        error.code = 'INVALID_SELECTION';
        error.statusCode = 400;
        return routeError(res, req, error);
      }
      const report = await buildSessionExportReport({
        accounts: getAccounts(), ids, emails, scope,
        aliveOnly: body.aliveOnly === true,
        probeSession,
      });
      res.setHeader('Cache-Control', 'no-store');
      if (body.download === true) {
        const filename = `chatgpt-sessions-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        res.set({
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'X-Export-Requested': String(report.total),
          'X-Export-Success': String(report.exported),
          'X-Export-Missing': String(report.missing.length),
        });
        return res.send(sessionExportText(report));
      }
      return res.json({
        ok: true,
        requestId: requestId(req),
        aliveOnly: report.aliveOnly,
        total: report.total,
        exported: report.exported,
        missing: report.missing,
        sessions: report.sessions.map(({ line: _line, ...session }) => session),
      });
    } catch (error) {
      return routeError(res, req, error);
    }
  });
}

export { routeError as sendRouteError };
