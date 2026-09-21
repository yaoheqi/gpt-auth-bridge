import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

export const TIMING_STAGES = Object.freeze([
  'total', 'queue', 'proxy_preflight', 'http_queue', 'http_request', 'sentinel',
  'browser_queue', 'browser_start', 'browser_context', 'browser_navigation', 'browser_verify', 'browser_cleanup',
  'oauth_start', 'username', 'password', 'totp', 'workspace', 'token_exchange', 'session',
]);
const stages = new Set(TIMING_STAGES);
const scope = new AsyncLocalStorage();
const outcomeOf = error => error?.name === 'AbortError' ? 'cancelled' : 'error';

// Stage names such as password/token_exchange are otherwise redacted by SSE.
// Reconstruct numeric counters only; never bypass redaction for arbitrary fields.
export function publicStageTimings(input) {
  const output = {};
  for (const stage of TIMING_STAGES) {
    const row = input?.[stage];
    if (!row || !Number.isFinite(row.durationMs) || row.durationMs < 0) continue;
    output[stage] = Object.fromEntries(['durationMs', 'calls', 'failures', 'cancelled']
      .filter(key => Number.isFinite(row[key]) && row[key] >= 0).map(key => [key, row[key]]));
  }
  return output;
}

export function createStageMetrics({ sampleLimit = 512 } = {}) {
  const limit = Math.max(1, Math.min(4096, Math.floor(Number(sampleLimit)) || 512));
  const values = new Map();
  return {
    record(stage, durationMs, outcome = 'ok') {
      if (!stages.has(stage) || !Number.isFinite(durationMs) || durationMs < 0) return;
      let row = values.get(stage);
      if (!row) {
        row = { count: 0, failures: 0, cancelled: 0, totalMs: 0, maxMs: 0, samples: [] };
        values.set(stage, row);
      }
      row.samples[row.count % limit] = durationMs;
      row.count++;
      row.failures += Number(outcome === 'error');
      row.cancelled += Number(outcome === 'cancelled');
      row.totalMs += durationMs;
      row.maxMs = Math.max(row.maxMs, durationMs);
    },
    snapshot() {
      return Object.fromEntries([...values].map(([stage, row]) => {
        const sorted = [...row.samples].sort((a, b) => a - b);
        const percentile = p => Math.round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]);
        return [stage, { count: row.count, failures: row.failures, cancelled: row.cancelled,
          meanMs: Math.round(row.totalMs / row.count), maxMs: Math.round(row.maxMs),
          sampleCount: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) }];
      }));
    },
  };
}

export const stageMetrics = createStageMetrics();

export function recordStageTiming(stage, durationMs, outcome = 'ok') {
  if (!stages.has(stage) || !Number.isFinite(durationMs) || durationMs < 0) return;
  stageMetrics.record(stage, durationMs, outcome);
  const context = scope.getStore();
  if (!context || context.closed) return;
  const row = context.timings[stage] ||= { durationMs: 0, calls: 0, failures: 0, cancelled: 0 };
  row.durationMs = Math.round((row.durationMs + durationMs) * 10) / 10;
  row.calls++;
  row.failures += Number(outcome === 'error');
  row.cancelled += Number(outcome === 'cancelled');
  // Timing observers must not change the outcome of account operations.
  try { context.onTiming?.({ stage, ...row }); } catch {}
}

export async function measureStage(stage, work) {
  const start = performance.now();
  let outcome = 'ok';
  try {
    const result = await work();
    if (result?.ok === false || (Number(result?.status) >= 400)) outcome = 'error';
    return result;
  } catch (error) {
    outcome = outcomeOf(error);
    throw error;
  } finally { recordStageTiming(stage, performance.now() - start, outcome); }
}

export async function withAccountTimings(work, { onTiming, queueMs = 0 } = {}) {
  const context = { timings: { queue: { durationMs: Math.round(queueMs), calls: 1, failures: 0, cancelled: 0 } }, onTiming };
  try {
    return await scope.run(context, async () => {
      const result = await measureStage('total', work);
      return { ...result, timings: structuredClone(context.timings) };
    });
  } finally { context.closed = true; }
}
