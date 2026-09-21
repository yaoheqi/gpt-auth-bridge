import { AsyncLocalStorage } from 'node:async_hooks';
import { configuredTaskConcurrency } from './batch-concurrency.js';
import { createSemaphore } from './async-semaphore.js';
import { requestSignal } from '../src/services/request-scope.js';
import { performance } from 'node:perf_hooks';
import { recordStageTiming } from './stage-timing.js';

export function createTaskLimiter(limit = configuredTaskConcurrency()) {
  const semaphore = createSemaphore(limit);
  const scope = new AsyncLocalStorage();
  return {
    stats: semaphore.stats,
    queueDuration: () => scope.getStore()?.queueMs || 0,
    async run(work, { signal = requestSignal(), enqueuedAt = performance.now() } = {}) {
      signal?.throwIfAborted();
      // A nested phase of the same account must not acquire a second task slot.
      if (scope.getStore()?.active) return work();
      return semaphore.run(async () => {
        const lease = { active: true, queueMs: Math.max(0, performance.now() - enqueuedAt) };
        recordStageTiming('queue', lease.queueMs);
        try { return await scope.run(lease, work); }
        finally { lease.active = false; }
      }, { signal });
    },
  };
}

const tasks = createTaskLimiter();
export const runAccountTask = (work, options) => tasks.run(work, options);
export const accountTaskStats = () => tasks.stats();
export const accountQueueDuration = () => tasks.queueDuration();
