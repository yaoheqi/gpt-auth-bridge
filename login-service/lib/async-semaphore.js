import { executionError } from './execution-limits.js';

function normalizeLimit(value, fallback = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Math.floor(Number(value));
  const safeFallback = Math.max(1, Math.min(max, Math.floor(Number(fallback)) || 1));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(max, parsed) : safeFallback;
}

/** FIFO process-local semaphore whose limit may change between acquisitions. */
export function createDynamicSemaphore(getLimit, { fallback = 1, max = Number.MAX_SAFE_INTEGER,
  maxPending = Infinity, queueTimeoutMs = 0,
} = {}) {
  if (typeof getLimit !== 'function') throw new TypeError('getLimit must be a function');
  let active = 0;
  const queue = [];

  const currentLimit = () => normalizeLimit(getLimit(), fallback, max);

  const drain = () => {
    while (queue.length && active < currentLimit()) {
      const next = queue.shift();
      active += 1;
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        drain();
      });
    }
  };

  const acquire = ({ signal, timeoutMs = queueTimeoutMs } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    if (active >= currentLimit() && queue.length >= maxPending) {
      reject(executionError('TASK_QUEUE_FULL', '任务队列已满，请稍后重试', 429));
      return;
    }
    let timer;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const entry = { resolve: release => { cleanup(); resolve(release); } };
    const remove = error => {
      const index = queue.indexOf(entry);
      if (index < 0) return;
      queue.splice(index, 1);
      cleanup();
      reject(error);
    };
    const abort = () => remove(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    queue.push(entry);
    drain();
    if (queue.includes(entry) && timeoutMs > 0) {
      timer = setTimeout(() => remove(executionError('TASK_QUEUE_TIMEOUT', '任务排队超时，请稍后重试')), timeoutMs);
    }
  });

  const run = async (fn, options = {}) => {
    const release = await acquire(options);
    try {
      options.signal?.throwIfAborted();
      return await fn();
    } finally {
      release();
    }
  };

  return {
    acquire,
    run,
    stats: () => ({ active, pending: queue.length, limit: currentLimit() }),
  };
}

export function createSemaphore(limit, options = {}) {
  const normalized = normalizeLimit(limit, options.fallback, options.max);
  return createDynamicSemaphore(() => normalized, { ...options, fallback: normalized });
}
