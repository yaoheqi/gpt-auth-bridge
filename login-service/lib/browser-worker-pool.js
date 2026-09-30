import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSemaphore } from './async-semaphore.js';
import { configuredBrowserConcurrency } from './batch-concurrency.js';
import { measureStage, recordStageTiming } from './stage-timing.js';
import { registerRequestCleanup, requestSignal } from '../src/services/request-scope.js';
import { decodeBrowserFailure, validationError, validationFailureFields } from './validation-error.js';
import { createBrowserDiagnostics } from './browser-diagnostics.js';
import { TASK_QUEUE_TIMEOUT_MS, WORKER_CLEANUP_TIMEOUT_MS, taskQueueCapacity,
  combineSignals, withinDeadline } from './execution-limits.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const browserReuseEnabled = (env = process.env) => /^(1|true|yes)$/i.test(String(env.BROWSER_REUSE_ENABLED || 'false'));
function boundedSetting(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min ? Math.min(max, Math.floor(number)) : fallback;
}
export function browserReuseLimits(env = process.env) {
  return {
    idleMs: boundedSetting(env.BROWSER_REUSE_IDLE_MS, 60000, 1000, 300000),
    maxTasks: boundedSetting(env.BROWSER_REUSE_MAX_TASKS, 20, 1, 100),
  };
}
export function getPythonCandidates({ env = process.env, platform = process.platform } = {}) {
  return [...new Set([env.PYTHON_PATH, env.PYTHON,
    ...(platform === 'win32' ? ['python', 'py'] : ['python3', 'python']),
  ].map(value => String(value || '').trim()).filter(Boolean))];
}

class BrowserWorker {
  constructor(root) { this.root = root; this.tasks = 0; }

  start() {
    this.starting ||= this.startProcess();
    return this.starting;
  }

  async startProcess() {
    if (this.child) return;
    for (const bin of getPythonCandidates()) {
      const child = spawn(bin, [path.join(this.root, 'scripts/browser_worker.py')], {
        cwd: this.root, windowsHide: true, detached: process.platform !== 'win32',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      try {
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw validationError('BROWSER_UNAVAILABLE', { stage: 'browser_start' }, error);
      }
      this.child = child;
      this.stderr = '';
      this.exited = new Promise(resolve => child.once('close', resolve));
      child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-4000); });
      this.reader = createInterface({ input: child.stdout });
      this.reader.on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { this.pending?.reject(validationError('BROWSER_PROTOCOL_ERROR')); return; }
        if (message.event === 'diagnostic') { this.onDiagnostic?.(message.diagnostic); return; }
        const pending = this.pending;
        if (!pending || message.id !== pending.id) return;
        if (message.event === 'timing') { pending.timing(message); return; }
        if (message.ok) pending.resolve(message.result);
        else pending.reject(decodeBrowserFailure(message.error));
      });
      const fail = error => this.pending?.reject(error);
      const processFailure = error => fail(validationError('BROWSER_WORKER_EXITED', {}, error));
      child.on('error', processFailure);
      child.stdin.on('error', processFailure);
      child.once('close', (exitCode, signal) => {
        this.onDiagnostic?.({ event: 'worker_exit', exitCode, signal, reason: this.retireReason });
        this.dead = true;
        fail(validationError('BROWSER_WORKER_EXITED'));
        this.stderr = '';
        this.reader.close();
      });
      return;
    }
    throw validationError('BROWSER_UNAVAILABLE', { stage: 'browser_start' });
  }

  async run(payload, { signal, timeoutMs = 90000 } = {}) {
    await this.start();
    signal?.throwIfAborted();
    if (this.dead) throw validationError('BROWSER_WORKER_EXITED', { stage: 'browser_start' });
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const finish = (callback, value) => {
        if (!this.pending) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending = null;
        callback(value);
      };
      const abort = () => finish(reject, signal.reason);
      const timer = setTimeout(() => finish(reject, validationError('VALIDATION_TIMEOUT', { stage: 'browser_verify' })), timeoutMs);
      this.pending = { id, resolve: value => finish(resolve, value), reject: error => finish(reject, error),
        // Capture the caller's async scope; stdout events run in the process's original scope.
        timing: AsyncResource.bind(message => recordStageTiming(message.stage, Number(message.durationMs), message.outcome)) };
      signal?.addEventListener('abort', abort, { once: true });
      try { this.child.stdin.write(JSON.stringify({ ...payload, id }) + '\n'); }
      catch (error) { this.pending.reject(validationError('BROWSER_WORKER_EXITED', {}, error)); }
    });
  }

  stop() {
    if (this.stopping) return this.stopping;
    this.dead = true;
    this.stopping = (async () => {
      this.pending?.reject(new DOMException('Browser worker closed', 'AbortError'));
      // Shutdown can arrive while spawn is still waiting for its first event.
      try { await this.starting; } catch {}
      const child = this.child;
      if (!child?.pid) return;
      let killer;
      if (process.platform === 'win32') {
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise(resolve => {
            const taskkill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            taskkill.once('close', resolve); taskkill.once('error', resolve);
          });
        }
      } else {
        const kill = signal => { try { process.kill(-child.pid, signal); } catch {} };
        kill('SIGTERM');
        killer = setTimeout(() => kill('SIGKILL'), 1000);
      }
      await this.exited;
      if (killer) {
        // The group may still contain orphaned Chromium/bridge children.
        clearTimeout(killer);
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
      this.reader?.close();
      this.child = null;
      this.stderr = '';
    })();
    return this.stopping;
  }
}

export class BrowserWorkerPool {
  constructor({ size = configuredBrowserConcurrency(), reuse = browserReuseEnabled(),
    idleMs = browserReuseLimits().idleMs, maxTasks = browserReuseLimits().maxTasks,
    maxPending = taskQueueCapacity(size), queueTimeoutMs = TASK_QUEUE_TIMEOUT_MS, cleanupTimeoutMs = WORKER_CLEANUP_TIMEOUT_MS,
    workerFactory = root => new BrowserWorker(root) } = {}) {
    this.semaphore = createSemaphore(size, { maxPending, queueTimeoutMs });
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    this.reuse = reuse;
    this.idleMs = idleMs;
    this.maxTasks = maxTasks;
    this.workerFactory = workerFactory;
    this.workers = new Set();
    this.controller = new AbortController();
    this.completed = 0;
    this.reused = 0;
    this.diagnostics = createBrowserDiagnostics();
  }

  async retire(worker, reason = 'stale') {
    clearTimeout(worker.idleTimer);
    worker.busy = true;
    if (!worker.retiring) {
      worker.retireReason = reason;
      this.diagnostics.record({ event: 'worker_retired', reason });
    }
    worker.retiring = true;
    // Keep a timed-out process visible and ineligible for replacement until its
    // actual termination completes. Merely giving up waiting is not an exit.
    worker.retirement ||= Promise.resolve().then(() => worker.stop()).then(() => this.workers.delete(worker));
    try { await withinDeadline(worker.retirement, this.cleanupTimeoutMs); }
    catch (error) {
      this.diagnostics.record({ event: 'cleanup_failed' });
      Object.assign(error, validationFailureFields(validationError('BROWSER_CLEANUP_FAILED', { stage: 'browser_cleanup' })));
      throw error;
    }
  }

  async run(payload, { root = ROOT, signal = requestSignal(), timeoutMs, remainingMs } = {}) {
    const combined = combineSignals(requestSignal(), signal, this.controller.signal);
    const release = await measureStage('browser_queue', () => this.semaphore.acquire({ signal: combined }));
    let worker;
    let succeeded = false;
    let failure;
    let unregisterCleanup = () => {};
    try {
      combined.throwIfAborted();
      // A stopped slot is not replaced until all its processes have exited.
      await Promise.all([...this.workers].filter(item => item.dead || item.retiring).map(item => this.retire(item)));
      await Promise.all([...this.workers].filter(item => !item.busy && item.root !== root).map(item => this.retire(item, 'incompatible_root')));
      combined.throwIfAborted();
      worker = [...this.workers].find(item => !item.busy && !item.dead && item.root === root);
      if (!worker) {
        worker = this.workerFactory(root);
        worker.onDiagnostic = event => this.diagnostics.record(event);
        this.workers.add(worker);
      }
      unregisterCleanup = registerRequestCleanup(() => this.retire(worker, 'request_cleanup'));
      worker.busy = true;
      clearTimeout(worker.idleTimer);
      if (worker.tasks) this.reused++;
      const remaining = remainingMs?.();
      const result = await worker.run(remaining == null ? payload : { ...payload, deadlineSeconds: remaining / 1000 },
        { signal: combined, timeoutMs: remaining == null ? timeoutMs : Math.min(timeoutMs ?? remaining, remaining) });
      worker.tasks++;
      this.completed++;
      succeeded = true;
      return result;
    } catch (error) { failure = error; throw error;
    } finally {
      try {
        if (worker) {
          if (!succeeded || !this.reuse || this.controller.signal.aborted || worker.tasks >= this.maxTasks) {
            const reason = this.controller.signal.aborted ? 'shutdown'
              : failure?.code === 'VALIDATION_TIMEOUT' ? 'timeout'
                : combined.aborted ? 'cancelled' : failure ? 'failed'
                  : !this.reuse ? 'completed' : 'max_tasks';
            try { await this.retire(worker, reason); }
            catch (cleanupError) {
              if (!failure) throw cleanupError;
              failure.cleanupCode = 'BROWSER_CLEANUP_FAILED';
              if (failure.validationFailure) failure.validationFailure.cleanupCode = 'BROWSER_CLEANUP_FAILED';
            }
          }
          else {
            worker.busy = false;
            worker.idleTimer = setTimeout(() => { void this.retire(worker, 'idle').catch(() => {}); }, this.idleMs);
            worker.idleTimer.unref?.();
          }
        }
      } finally { unregisterCleanup(); release(); }
    }
  }

  stats() {
    return { ...this.semaphore.stats(), reuseEnabled: this.reuse, workers: this.workers.size,
      completed: this.completed, reused: this.reused, idleMs: this.idleMs, maxTasks: this.maxTasks,
      diagnostics: this.diagnostics.snapshot() };
  }

  async close() {
    this.controller.abort();
    await Promise.allSettled([...this.workers].map(worker => this.retire(worker, 'shutdown')));
  }
}

export const browserWorkerPool = new BrowserWorkerPool();
