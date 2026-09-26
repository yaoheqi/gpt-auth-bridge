import { registerRequestCleanup, requestSignal } from '../src/services/request-scope.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { sanitizeLogMessage } from './log-sanitize.js';
import { createProxyRoute } from './proxy-route.js';
import { configuredTaskConcurrency } from './batch-concurrency.js';
import { measureStage } from './stage-timing.js';
import { TASK_QUEUE_TIMEOUT_MS, WORKER_CLEANUP_TIMEOUT_MS, taskQueueCapacity,
  executionError, combineSignals, untilAborted, withinDeadline } from './execution-limits.js';

// Python helpers remain alongside the internal business modules.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'curl_cffi_session.py');
const DISPOSED_ERROR = () => new Error('curl_cffi session disposed');

function pythonExecutable() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const suffix = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  for (const base of [path.dirname(ROOT), ROOT]) {
    const virtualenv = path.join(base, '.venv', ...suffix);
    if (fs.existsSync(virtualenv)) return virtualenv;
  }
  return process.env.PYTHON3 || (process.platform === 'win32' ? 'python' : 'python3');
}

export class CurlCffiWorker {
  constructor(index, { spawnProcess = spawn, cleanupTimeoutMs = WORKER_CLEANUP_TIMEOUT_MS } = {}) {
    this.index = index;
    this.spawnProcess = spawnProcess;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    this.child = null;
    this.reader = null;
    this.pending = new Map();
    this.leased = false;
  }

  ensureChild() {
    if (this.child) return;
    if (this.quarantined) throw executionError('WORKER_CLEANUP_TIMEOUT', 'HTTP worker 尚未退出，暂不可复用');
    const child = this.spawnProcess(pythonExecutable(), [SCRIPT], {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.poisoned = false;
    this.exited = new Promise(resolve => child.once('close', resolve));
    this.reader = readline.createInterface({ input: child.stdout });
    this.reader.on('line', line => {
      let response;
      try { response = JSON.parse(line); } catch { return; }
      const waiter = this.pending.get(response.id);
      if (!waiter) return;
      this.pending.delete(response.id);
      if (response.error) waiter.reject(new Error(sanitizeLogMessage(response.error)));
      else waiter.resolve(response);
    });
    // Consume stderr so diagnostics cannot fill the pipe and stall the worker.
    child.stderr?.on('data', () => {});
    const fail = error => {
      if (this.child !== child) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const waiter of this.pending.values()) waiter.reject(failure);
      this.pending.clear();
    };
    const broken = error => { fail(error); void this.kill(error).catch(() => {}); };
    child.on('error', broken);
    child.stdin.on('error', broken);
    child.on('close', code => {
      fail(new Error(`curl_cffi session exited (${code ?? 'unknown'})`));
      if (this.child !== child) return;
      this.reader?.close();
      this.reader = null;
      this.child = null;
      this.quarantined = false;
      this.stopping = null;
    });
  }

  async request(payload, { budgetMs, signal } = {}) {
    await this.stopping;
    signal?.throwIfAborted();
    if (this.poisoned && this.child) throw DISPOSED_ERROR();
    this.ensureChild();
    const id = payload.id || `${process.pid}-${this.index}-${randomUUID()}`;
    const request = { ...payload, id };
    return new Promise((resolve, reject) => {
      const seconds = Number(payload.timeout);
      const budget = budgetMs ?? (payload.command ? 5000 : (Number.isFinite(seconds) && seconds > 0 ? seconds : 20) * 1000 + 2000);
      const timer = setTimeout(() => {
        const error = Object.assign(new Error('HTTP worker exceeded its deadline'), { code: 'UPSTREAM_TIMEOUT' });
        void this.cancel(id, error).catch(() => {});
      }, budget);
      const abort = () => { void this.kill(signal.reason).catch(() => {}); };
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, {
        resolve: value => { cleanup(); resolve(value); },
        reject: error => { cleanup(); reject(error); },
      });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.child.stdin.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        cleanup();
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  cancel(id, error = DISPOSED_ERROR()) {
    const waiter = this.pending.get(id);
    if (!waiter) return this.stopping || Promise.resolve();
    // curl_cffi is synchronous in Python. Cancelling only the JS waiter leaves
    // its network request alive; terminate the leased process instead.
    return this.kill(error);
  }

  async start() {
    await this.stopping;
    // Acknowledgement proves Python/curl_cffi are ready without upstream traffic.
    if (!this.child) await this.request({ command: 'reset' }, { budgetMs: 30_000 });
  }

  async reset() {
    try {
      await this.request({ command: 'reset' });
    } catch (error) {
      await this.kill();
      throw error;
    }
  }

  kill(error = DISPOSED_ERROR()) {
    if (this.stopping) return this.stopping;
    this.poisoned = true;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    const child = this.child;
    if (!child) return Promise.resolve();
    try { child.kill(); } catch {}
    const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, Math.min(1000, this.cleanupTimeoutMs / 2));
    this.stopping = withinDeadline(this.exited, this.cleanupTimeoutMs).catch(error => {
      // Never spawn a replacement while the old process may still be running.
      this.quarantined = true;
      throw error;
    }).finally(() => {
      clearTimeout(force);
      if (!this.child) this.stopping = null;
    });
    return this.stopping;
  }
}

export class CurlCffiWorkerPool {
  constructor(size = configuredTaskConcurrency(), {
    workerFactory = index => new CurlCffiWorker(index),
    maxPending = taskQueueCapacity(size), queueTimeoutMs = TASK_QUEUE_TIMEOUT_MS,
    cleanupTimeoutMs = WORKER_CLEANUP_TIMEOUT_MS,
  } = {}) {
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError('Invalid HTTP worker pool bounds');
    }
    this.size = size;
    this.minSize = size;
    this.workerFactory = workerFactory;
    this.maxPending = maxPending;
    this.queueTimeoutMs = queueTimeoutMs;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    this.workers = [];
    this.waiters = [];
    this.nextIndex = 0;
    this.closed = false;
  }

  createWorker() {
    const worker = this.workerFactory(this.nextIndex++);
    this.workers.push(worker);
    return worker;
  }

  start() {
    if (this.closed) return Promise.reject(DISPOSED_ERROR());
    if (this.startPromise) return this.startPromise;
    this.starting = true;
    this.startPromise = (async () => {
      while (this.workers.length < this.minSize) this.createWorker();
      const results = await Promise.allSettled(this.workers.map(worker => worker.start?.()));
      const failure = results.find(result => result.status === 'rejected');
      if (failure || this.closed) throw failure?.reason || DISPOSED_ERROR();
      this.maintenanceTimer = setInterval(() => {
        // Recover idle children that exited; leased children recover on reset.
        for (const worker of this.workers) {
          if (!worker.leased && !worker.releasing && !worker.maintenance) {
            worker.maintenance = Promise.resolve().then(() => {
              if (!this.closed) return worker.start?.();
            }).catch(() => worker.kill?.()).catch(() => {}).finally(() => { worker.maintenance = null; });
          }
        }
      }, 30_000);
      this.maintenanceTimer.unref?.();
    })().catch(async error => { await this.close(); throw error; }).finally(() => { this.starting = false; });
    return this.startPromise;
  }

  async lease(worker, signal) {
    worker.leased = true;
    try {
      await worker.maintenance;
      if (this.closed) throw DISPOSED_ERROR();
      await untilAborted(worker.start?.(), signal);
      if (this.closed || signal?.aborted) throw DISPOSED_ERROR();
      return worker;
    } catch (error) {
      if (signal?.aborted) await withinDeadline(worker.kill?.(), this.cleanupTimeoutMs).catch(() => {});
      await this.release(worker);
      throw error;
    }
  }

  acquire({ signal } = {}) {
    if (this.closed || signal?.aborted) return Promise.reject(DISPOSED_ERROR());
    if (this.starting) return this.startPromise.then(() => this.acquire({ signal }));
    const idle = this.workers.find(worker => !worker.leased && !worker.releasing);
    if (idle) return this.lease(idle, signal);
    if (this.workers.length < this.size) return this.lease(this.createWorker(), signal);
    if (this.waiters.length >= this.maxPending) return Promise.reject(executionError('TASK_QUEUE_FULL', 'HTTP worker 队列已满，请稍后重试', 429));
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const waiter = {
        resolve: worker => { cleanup(); resolve(worker); },
        reject: error => { cleanup(); reject(error); },
        signal,
      };
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.reject(DISPOSED_ERROR());
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiters.push(waiter);
      if (this.queueTimeoutMs > 0) timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.reject(executionError('TASK_QUEUE_TIMEOUT', 'HTTP worker 排队超时，请稍后重试'));
      }, this.queueTimeoutMs);
    });
  }

  async release(worker) {
    if (!worker || !worker.leased) return;
    if (worker.releasing) return worker.releasing;
    worker.releasing = (async () => {
      // Keep the lease while resetting: cookies must never cross accounts.
      if (!this.closed && !worker.poisoned) {
        try { await withinDeadline(worker.reset(), this.cleanupTimeoutMs); }
        catch { await withinDeadline(worker.kill?.(), this.cleanupTimeoutMs); }
      } else {
        await withinDeadline(worker.kill?.(), this.cleanupTimeoutMs);
      }
    })();
    try { await worker.releasing; }
    catch (error) {
      // Cleanup has a response deadline, but capacity remains reserved. If the
      // OS eventually confirms exit, that confirmation can safely restore it.
      if (worker.exited) void worker.exited.then(() => {
        if (worker.child || !worker.leased || this.closed) return;
        this.returnWorker(worker);
      }).catch(() => {});
      throw error;
    }
    this.returnWorker(worker);
  }

  returnWorker(worker) {
    worker.releasing = null;
    worker.leased = false;
    if (this.closed) return;
    const next = this.waiters.shift();
    if (next) this.lease(worker, next.signal).then(next.resolve, next.reject);
  }

  stats() {
    return {
      size: this.size,
      min: this.minSize,
      max: this.size,
      workers: this.workers.length,
      running: this.workers.filter(worker => worker.child?.pid).length,
      leased: this.workers.filter(worker => worker.leased).length,
      queued: this.waiters.length,
    };
  }

  close() {
    if (this.closed) return this.closing;
    this.closed = true;
    clearInterval(this.maintenanceTimer);
    for (const waiter of this.waiters.splice(0)) waiter.reject(DISPOSED_ERROR());
    const stopping = this.workers.splice(0).map(worker => withinDeadline(worker.kill?.(), this.cleanupTimeoutMs));
    this.closing = Promise.allSettled(stopping);
    return this.closing;
  }
}

const workerPool = new CurlCffiWorkerPool();

export function httpWorkerStats() { return workerPool.stats(); }
export function startHttpWorkers() { return workerPool.start(); }
export function closeHttpWorkers() { return workerPool.close(); }

export function createCurlCffiFetch(proxyUrl = '', { direct = false, pool = workerPool,
  routeFactory = createProxyRoute, cleanupTimeoutMs = WORKER_CLEANUP_TIMEOUT_MS,
} = {}) {
  let lease = null;
  let leasePromise = null;
  let disposed = false;
  let routePromise = null;
  let disposalPromise;
  const lifetimeSignal = requestSignal();
  const disposal = new AbortController();
  const selectedProxy = direct ? '' : (proxyUrl || process.env.APP_PROXY || process.env.APP_HTTP_PROXY || process.env.PROXY_URL || '');
  const pendingRequestIds = new Set();

  const acquireLease = (signal) => {
    if (lease) return Promise.resolve(lease);
    if (!leasePromise) {
      leasePromise = measureStage('http_queue', () => pool.acquire({ signal })).then(worker => {
        if (disposed) {
          return pool.release(worker).then(() => { throw DISPOSED_ERROR(); });
        }
        lease = worker;
        return worker;
      }).catch(error => {
        leasePromise = null;
        throw error;
      });
    }
    return leasePromise;
  };

  const fetcher = async (input, init = {}) => {
    if (disposed) throw DISPOSED_ERROR();
    const signal = combineSignals(lifetimeSignal, requestSignal(), init.signal, disposal.signal);
    signal.throwIfAborted();
    const cancelCall = () => { void fetcher.dispose(signal.reason).catch(() => {}); };
    signal.addEventListener('abort', cancelCall, { once: true });
    try {
      routePromise ||= Promise.resolve().then(() => routeFactory(selectedProxy)).then(route => {
        if (disposed) void withinDeadline(route.close(), cleanupTimeoutMs).catch(() => {});
        return route;
      });
      const route = await withinDeadline(untilAborted(routePromise, signal), 15_000,
        executionError('PROXY_ROUTE_TIMEOUT', '代理路由连接超时'));
      if (disposed) throw DISPOSED_ERROR();
      const worker = await acquireLease(signal);
      if (disposed) throw DISPOSED_ERROR();
      const url = String(input?.url || input || '');
      const method = String(init.method || 'GET').toUpperCase();
      const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
      const body = await encodeCurlCffiBody(init.body);
      if (disposed) throw DISPOSED_ERROR();
      signal.throwIfAborted();
      const requestId = `${process.pid}-${randomUUID()}`;
      pendingRequestIds.add(requestId);
      let response;
      try {
        response = await measureStage('http_request', () => worker.request({
          id: requestId,
          url,
          method,
          headers,
          body,
          allowRedirects: init.redirect !== 'manual',
          proxy: route.url,
          direct,
          // Bound edge/challenge waits so a blocked egress fails fast with a useful status.
          timeout: Math.max(1, Math.min(120, Number(init.timeout || process.env.CURL_CFFI_TIMEOUT_SECONDS || 20) || 20)),
        }, { signal }));
      } finally {
        pendingRequestIds.delete(requestId);
      }
      const responseHeaders = new Headers();
      for (const [key, value] of response.headers || []) responseHeaders.append(key, value);
      const result = new Response(Buffer.from(response.body || '', 'base64'), {
        status: Number(response.status || 500),
        headers: responseHeaders,
      });
      Object.defineProperty(result, 'url', { value: response.url || url });
      return result;
    } finally { signal.removeEventListener('abort', cancelCall); }
  };

  fetcher.proxyUrl = direct ? '' : (proxyUrl || process.env.APP_PROXY || process.env.APP_HTTP_PROXY || process.env.PROXY_URL || '');
  fetcher.direct = direct;
  fetcher.dispatcher = {};
  fetcher.isolated = true;
  let unregisterCleanup = () => {};
  const onLifetimeAbort = () => { void fetcher.dispose(lifetimeSignal.reason).catch(() => {}); };
  fetcher.dispose = (reason = DISPOSED_ERROR()) => {
    if (disposed) return disposalPromise || Promise.resolve();
    disposed = true;
    lifetimeSignal?.removeEventListener('abort', onLifetimeAbort);
    disposal.abort(reason);
    const current = lease;
    const pendingLease = leasePromise;
    lease = null;
    leasePromise = null;
    // A stuck proxy close must not postpone termination of the Python request.
    const cancel = current && Promise.all([...pendingRequestIds].map(id => current.cancel(id, reason)));
    const release = (async () => {
      if (current) {
        try { await cancel; }
        finally { await pool.release(current); }
      }
      else await pendingLease?.catch(() => {});
    })();
    const closeRoute = routePromise?.then(route => route.close());
    disposalPromise = withinDeadline(Promise.allSettled([release, closeRoute]), cleanupTimeoutMs)
      .finally(unregisterCleanup);
    return disposalPromise;
  };
  unregisterCleanup = registerRequestCleanup(fetcher.dispose);
  lifetimeSignal?.addEventListener('abort', onLifetimeAbort, { once: true });
  if (lifetimeSignal?.aborted) onLifetimeAbort();
  return fetcher;
}

export async function encodeCurlCffiBody(body) {
  if (body == null) return null;
  if (typeof body === 'string') return Buffer.from(body).toString('base64');
  if (body instanceof URLSearchParams) return Buffer.from(body.toString()).toString('base64');
  if (Buffer.isBuffer(body)) return body.toString('base64');
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('base64');
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('base64');
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer()).toString('base64');
  }
  throw new TypeError(`Unsupported curl_cffi request body: ${body?.constructor?.name || typeof body}`);
}
