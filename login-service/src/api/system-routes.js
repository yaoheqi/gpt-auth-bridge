import { configuredTaskConcurrency, configuredBrowserConcurrency } from '../../lib/batch-concurrency.js';
import { accountTaskStats } from '../../lib/task-concurrency.js';
import { browserSentinelStats } from '../../lib/openai-sentinel.js';
import { stageMetrics } from '../../lib/stage-timing.js';

export function registerSystemRoutes(app, {
  paths,
  readiness = {},
  isShuttingDown = () => false,
  metrics,
  workerStats,
}) {
  // Mounted behind the application's administrator authentication middleware.
  app.get('/api/system/metrics', (_req, res) => res.json({
    ok: true, http: metrics?.snapshot(), requests: app.locals.admission?.snapshot(), workers: workerStats?.(), tasks: accountTaskStats(), browsers: browserSentinelStats(),
    stageTimings: stageMetrics.snapshot(), timingSampleLimit: 512, uptimeSeconds: Math.floor(process.uptime()),
  }));
  app.get('/api/system/config', (_req, res) => res.json({ ok: true, taskConcurrency: configuredTaskConcurrency(), browserConcurrency: configuredBrowserConcurrency() }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'email-server' }));
  app.get('/api/ready', async (_req, res) => {
    if (isShuttingDown()) {
      return res.status(503).json({ ok: false, service: 'email-server', error: 'service shutting down' });
    }
    const checks = {};
    try {
      for (const [name, check] of Object.entries(readiness)) {
        checks[name] = await (typeof check === 'function' ? check() : check);
      }
      res.json({ ok: true, service: 'email-server', checks: Object.keys(checks) });
    } catch (error) {
      res.status(503).json({ ok: false, service: 'email-server', error: error instanceof Error ? error.message : String(error) });
    }
  });
}
