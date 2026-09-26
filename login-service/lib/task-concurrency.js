import { AsyncLocalStorage } from 'node:async_hooks';
import { configuredTaskConcurrency } from './batch-concurrency.js';
import { createSemaphore } from './async-semaphore.js';
import { executions, requestSignal } from '../src/services/request-scope.js';
import { performance } from 'node:perf_hooks';
import { recordStageTiming } from './stage-timing.js';
import { ACCOUNT_TASK_TIMEOUT_MS, TASK_QUEUE_TIMEOUT_MS, WORKER_CLEANUP_TIMEOUT_MS,
  taskQueueCapacity, executionError, combineSignals, untilAborted, withinDeadline } from './execution-limits.js';

export function createTaskLimiter(limit = configuredTaskConcurrency(), {
  maxPending = taskQueueCapacity(limit), queueTimeoutMs = TASK_QUEUE_TIMEOUT_MS,
  taskTimeoutMs = ACCOUNT_TASK_TIMEOUT_MS, cleanupTimeoutMs = WORKER_CLEANUP_TIMEOUT_MS,
} = {}) {
  const semaphore = createSemaphore(limit, { maxPending, queueTimeoutMs });
  const scope = new AsyncLocalStorage();
  return {
    stats: semaphore.stats,
    queueDuration: () => scope.getStore()?.queueMs || 0,
    async run(work, { signal: callerSignal, enqueuedAt = performance.now() } = {}) {
      const signal = combineSignals(requestSignal(), callerSignal);
      signal?.throwIfAborted();
      // A nested phase of the same account must not acquire a second task slot.
      if (scope.getStore()?.active) {
        const parent = executions.getStore();
        return executions.run({ ...parent, signal }, () => untilAborted(Promise.resolve().then(() => work(signal)), signal));
      }
      return semaphore.run(async () => {
        const lease = { active: true, queueMs: Math.max(0, performance.now() - enqueuedAt) };
        recordStageTiming('queue', lease.queueMs);
        const controller = new AbortController();
        const combined = combineSignals(signal, controller.signal);
        const execution = { signal: combined, cleanups: new Set(), closed: false };
        const timer = setTimeout(() => controller.abort(executionError('ACCOUNT_TASK_TIMEOUT', '单账号执行超时，已取消后续操作', 504)), taskTimeoutMs);
        let failure;
        try {
          return await scope.run(lease, () => executions.run(execution,
            () => untilAborted(Promise.resolve().then(() => work(combined)), combined)));
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          clearTimeout(timer);
          execution.closed = true;
          const registered = [...execution.cleanups];
          controller.abort();
          // Keep the account slot until registered transports have had a bounded
          // chance to terminate. A timed-out worker remains quarantined by its pool.
          const cleanups = registered.map(cleanup => Promise.resolve().then(cleanup));
          execution.cleanups.clear();
          try { await withinDeadline(Promise.allSettled(cleanups), cleanupTimeoutMs); }
          catch (error) { if (!failure) throw error; }
          finally { lease.active = false; }
        }
      }, { signal });
    },
  };
}

const tasks = createTaskLimiter();
export const runAccountTask = (work, options) => tasks.run(work, options);
export const accountTaskStats = () => tasks.stats();
export const accountQueueDuration = () => tasks.queueDuration();
