import { envelopeErr, envelopeOk } from '../../http/request-metadata.js';

/** Narrow v2 helpers. Operational account/job/admin APIs are registered by the main route modules under /api/v2. */
export function registerV2Routes(app, {
  requireAdmin,
  accounts,
  runtimePaths,
  ensureDatabase = null,
}) {
  app.get('/api/v2/health', (_req, res) => {
    res.json({ ok: true, service: 'email-server', api: 'v2', sot: 'browser' });
  });

  app.get('/api/v2/sot', requireAdmin, async (req, res) => {
    try {
      // Repository initialization is asynchronous; do not expose a transient
      // zero-account state while the process is still starting.
      if (typeof ensureDatabase === 'function') await ensureDatabase();
      else if (typeof accounts?.ensureReady === 'function') await accounts.ensureReady();
      res.json(envelopeOk({
        sot: 'browser',
        sqlitePath: null,
        accountCount: typeof accounts?.listAll === 'function' ? accounts.listAll().length : null,
        jobsSupported: false,
      }, req.requestId));
    } catch (error) {
      const failure = envelopeErr(error, req.requestId, 503);
      res.status(failure.status).json(failure.body);
    }
  });

}
