export const TASK_QUEUE_TIMEOUT_MS = 90_000;
export const ACCOUNT_TASK_TIMEOUT_MS = 15 * 60_000;
export const WORKER_CLEANUP_TIMEOUT_MS = 5_000;
export const taskQueueCapacity = limit => Math.max(32, 4 * limit);

export function executionError(code, message, status = 503, retryAfterMs = 1000) {
  return Object.assign(new Error(message), { code, status, retryAfterMs });
}

export function combineSignals(...signals) {
  const unique = [...new Set(signals.filter(Boolean))];
  return unique.length > 1 ? AbortSignal.any(unique) : unique[0];
}

// Always observe the operation after cancellation: a late rejection must not
// become unhandled, and the caller's cleanup still owns its underlying resource.
export function untilAborted(operation, signal) {
  if (!signal) return Promise.resolve(operation);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const finish = callback => value => { signal.removeEventListener('abort', abort); callback(value); };
    Promise.resolve(operation).then(finish(resolve), finish(reject));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

export async function withinDeadline(operation, timeoutMs = WORKER_CLEANUP_TIMEOUT_MS, error = executionError('WORKER_CLEANUP_TIMEOUT', '执行资源回收超时')) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(error), timeoutMs);
  try { return await untilAborted(operation, controller.signal); }
  finally { clearTimeout(timer); }
}
