/** Fixed startup concurrency for account tasks, HTTP workers and browser helpers. */

export const MAX_OAUTH_BATCH_CONCURRENCY = 30;
export const DEFAULT_OAUTH_BATCH_CONCURRENCY_FALLBACK = 10;

export function clampOauthBatchConcurrency(value, fallback = DEFAULT_OAUTH_BATCH_CONCURRENCY_FALLBACK) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    const fb = Number(fallback);
    const safeFallback = Number.isFinite(fb) && fb >= 1 ? fb : DEFAULT_OAUTH_BATCH_CONCURRENCY_FALLBACK;
    return Math.max(1, Math.min(MAX_OAUTH_BATCH_CONCURRENCY, Math.floor(safeFallback)));
  }
  return Math.max(1, Math.min(MAX_OAUTH_BATCH_CONCURRENCY, Math.floor(n)));
}

export function configuredTaskConcurrency(env = process.env) {
  return clampOauthBatchConcurrency(env.TASK_CONCURRENCY);
}
