function normalizeLimit(value, fallback = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Math.floor(Number(value));
  const safeFallback = Math.max(1, Math.min(max, Math.floor(Number(fallback)) || 1));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(max, parsed) : safeFallback;
}

/** FIFO process-local semaphore whose limit may change between acquisitions. */
export function createDynamicSemaphore(getLimit, { fallback = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
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

  const acquire = ({ signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const entry = { resolve: release => { cleanup(); resolve(release); } };
    const abort = () => {
      const index = queue.indexOf(entry);
      if (index < 0) return;
      queue.splice(index, 1);
      cleanup();
      reject(signal.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    queue.push(entry);
    drain();
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
