import { performance } from 'node:perf_hooks';

// Aggregate only numbers. Never retain URLs, identifiers, bodies or errors.
export function createOperationalMetrics() {
  const counts = { requests: 0, active: 0, completed: 0, errors: 0, disconnected: 0, totalDurationMs: 0, maxDurationMs: 0 };
  return {
    middleware(req, res, next) {
      if (!req.path?.startsWith('/api/')) return next();
      counts.requests++;
      counts.active++;
      const started = performance.now();
      let settled = false;
      const finish = (disconnected) => {
        if (settled) return;
        settled = true;
        counts.active--;
        counts.completed++;
        counts.errors += Number(res.statusCode >= 400);
        counts.disconnected += Number(disconnected);
        const duration = performance.now() - started;
        counts.totalDurationMs += duration;
        counts.maxDurationMs = Math.max(counts.maxDurationMs, duration);
      };
      res.once('finish', () => finish(false));
      res.once('close', () => finish(!res.writableFinished));
      next();
    },
    snapshot() {
      return {
        requests: counts.requests, active: counts.active, completed: counts.completed,
        errors: counts.errors, disconnected: counts.disconnected,
        errorRate: counts.completed ? counts.errors / counts.completed : 0,
        meanDurationMs: counts.completed ? Math.round(counts.totalDurationMs / counts.completed) : 0,
        maxDurationMs: Math.round(counts.maxDurationMs),
      };
    },
  };
}
