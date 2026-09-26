import { createHmac, randomBytes } from 'node:crypto';

// Only salted digests and active waiters live here. Entries disappear when the
// last request releases them; results and credentials are never cached.
export function createPushCoordinator() {
  const salt = randomBytes(32);
  const locks = new Map();
  const digest = value => createHmac('sha256', salt).update(JSON.stringify(value)).digest('hex');
  function acquire(key, signal) {
    signal?.throwIfAborted();
    const entry = locks.get(key);
    if (!entry) {
      locks.set(key, { waiters: [] });
      return Promise.resolve(() => release(key));
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = entry.waiters.indexOf(waiter);
        if (index >= 0) entry.waiters.splice(index, 1);
        signal?.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      const waiter = { grant() { signal?.removeEventListener('abort', abort); resolve(() => release(key)); } };
      entry.waiters.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  function release(key) {
    const entry = locks.get(key);
    const next = entry?.waiters.shift();
    if (next) next.grant();
    else locks.delete(key);
  }
  return {
    async run(target, baseUrl, accounts, work, { signal, waitMs = 90_000 } = {}) {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(Object.assign(new Error('同账号推送正在处理，请稍后重试'), { code: 'PUSH_QUEUE_TIMEOUT', status: 503, retryAfterMs: 1000 })), waitMs);
      timer.unref?.();
      const waiting = AbortSignal.any([signal, timeout.signal].filter(Boolean));
      const keys = [...new Set(accounts.map(account => digest([
        target, baseUrl,
        String(account.credentials?.email || account.email || account.name || '').trim().toLowerCase(),
        String(account.credentials?.chatgpt_account_id || account.credentials?.account_id || account.account_id || account.chatgpt_account_id || ''),
      ])))].sort();
      const releases = [];
      try {
        for (const key of keys) releases.push(await acquire(key, waiting));
        waiting.throwIfAborted();
        clearTimeout(timer);
        signal?.throwIfAborted();
        return await work();
      } finally {
        clearTimeout(timer);
        for (const unlock of releases.reverse()) unlock();
      }
    },
    stats: () => ({ activeKeys: locks.size, waiting: [...locks.values()].reduce((sum, entry) => sum + entry.waiters.length, 0) }),
  };
}

export const pushCoordinator = createPushCoordinator();
