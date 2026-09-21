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

class CurlCffiWorker {
  constructor(index) {
    this.index = index;
    this.child = null;
    this.reader = null;
    this.pending = new Map();
    this.leased = false;
  }

  ensureChild() {
    if (this.child) return;
    const child = spawn(pythonExecutable(), [SCRIPT], {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
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
      this.reader?.close();
      this.reader = null;
      this.child = null;
      try { child.kill(); } catch {}
    };
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('close', code => fail(new Error(`curl_cffi session exited (${code ?? 'unknown'})`)));
  }

  request(payload, { budgetMs } = {}) {
    this.ensureChild();
    const id = payload.id || `${process.pid}-${this.index}-${randomUUID()}`;
    const request = { ...payload, id };
    return new Promise((resolve, reject) => {
      const seconds = Number(payload.timeout);
      const budget = budgetMs ?? (payload.command ? 5000 : (Number.isFinite(seconds) && seconds > 0 ? seconds : 20) * 1000 + 2000);
      const timer = setTimeout(() => {
        const error = Object.assign(new Error('HTTP worker exceeded its deadline'), { code: 'UPSTREAM_TIMEOUT' });
        this.cancel(id, error);
        this.kill();
      }, budget);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try {
        this.child.stdin.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  cancel(id, error = DISPOSED_ERROR()) {
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    waiter.reject(error);
  }

  async start() {
    // Acknowledgement proves Python/curl_cffi are ready without upstream traffic.
    if (!this.child) await this.request({ command: 'reset' }, { budgetMs: 30_000 });
  }

  async reset() {
    try {
      await this.request({ command: 'reset' });
    } catch (error) {
      this.kill();
      throw error;
    }
  }

  kill() {
    for (const waiter of this.pending.values()) waiter.reject(DISPOSED_ERROR());
    this.pending.clear();
    this.reader?.close();
    this.reader = null;
    const child = this.child;
    this.child = null;
    try { child?.kill(); } catch {}
  }
}

export class CurlCffiWorkerPool {
  constructor(size = configuredTaskConcurrency(), {
    workerFactory = index => new CurlCffiWorker(index),
  } = {}) {
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError('Invalid HTTP worker pool bounds');
    }
    this.size = size;
    this.minSize = size;
    this.workerFactory = workerFactory;
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
            }).catch(() => worker.kill?.()).finally(() => { worker.maintenance = null; });
          }
        }
      }, 30_000);
      this.maintenanceTimer.unref?.();
    })().catch(error => { this.close(); throw error; }).finally(() => { this.starting = false; });
    return this.startPromise;
  }

  async lease(worker, signal) {
    worker.leased = true;
    try {
      await worker.maintenance;
      if (this.closed) throw DISPOSED_ERROR();
      await worker.start?.();
      if (this.closed || signal?.aborted) throw DISPOSED_ERROR();
      return worker;
    } catch (error) {
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
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: worker => { signal?.removeEventListener('abort', abort); resolve(worker); },
        reject: error => { signal?.removeEventListener('abort', abort); reject(error); },
        signal,
      };
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.reject(DISPOSED_ERROR());
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  async release(worker) {
    if (!worker || !worker.leased) return;
    if (worker.releasing) return worker.releasing;
    worker.releasing = (async () => {
      // Keep the lease while resetting: cookies must never cross accounts.
      if (!this.closed) {
        try { await worker.reset(); } catch { worker.kill?.(); }
      }
    })();
    await worker.releasing;
    worker.releasing = null;
    worker.leased = false;
    if (this.closed) { worker.kill?.(); return; }
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
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.maintenanceTimer);
    for (const waiter of this.waiters.splice(0)) waiter.reject(DISPOSED_ERROR());
    for (const worker of this.workers.splice(0)) worker.kill?.();
  }
}

const workerPool = new CurlCffiWorkerPool();

export function httpWorkerStats() { return workerPool.stats(); }
export function startHttpWorkers() { return workerPool.start(); }
export function closeHttpWorkers() { workerPool.close(); }

export function createCurlCffiFetch(proxyUrl = '', { direct = false, pool = workerPool } = {}) {
  let lease = null;
  let leasePromise = null;
  let disposed = false;
  let routePromise = null;
  const selectedProxy = direct ? '' : (proxyUrl || process.env.APP_PROXY || process.env.APP_HTTP_PROXY || process.env.PROXY_URL || '');
  const pendingRequestIds = new Set();

  const acquireLease = (signal) => {
    if (lease) return Promise.resolve(lease);
    if (!leasePromise) {
      const signals = [requestSignal(), signal].filter(Boolean);
      leasePromise = measureStage('http_queue', () => pool.acquire({ signal: signals.length ? AbortSignal.any(signals) : undefined })).then(worker => {
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
    if (init.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    routePromise ||= createProxyRoute(selectedProxy);
    const route = await routePromise;
    if (disposed) { await route.close(); throw DISPOSED_ERROR(); }
    const worker = await acquireLease(init.signal);
    if (disposed) throw DISPOSED_ERROR();
    const url = String(input?.url || input || '');
    const method = String(init.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    const body = await encodeCurlCffiBody(init.body);
    if (disposed) throw DISPOSED_ERROR();
    init.signal?.throwIfAborted();
    const requestId = `${process.pid}-${randomUUID()}`;
    pendingRequestIds.add(requestId);
    let response;
    try {
      response = await new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => init.signal?.removeEventListener?.('abort', onAbort);
        const settleReject = error => {
          if (settled) return;
          settled = true;
          cleanup();
          worker.cancel(requestId, error);
          reject(error);
        };
        const onAbort = () => settleReject(new DOMException('The operation was aborted', 'AbortError'));
        init.signal?.addEventListener?.('abort', onAbort, { once: true });
        measureStage('http_request', () => worker.request({
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
        })).then(value => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        }, settleReject);
      });
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
  };

  fetcher.proxyUrl = direct ? '' : (proxyUrl || process.env.APP_PROXY || process.env.APP_HTTP_PROXY || process.env.PROXY_URL || '');
  fetcher.direct = direct;
  fetcher.dispatcher = {};
  fetcher.isolated = true;
  let unregisterCleanup = () => {};
  fetcher.dispose = async () => {
    unregisterCleanup();
    if (disposed) return;
    disposed = true;
    // Closing the tunnel also releases pending network operations before worker reset.
    await routePromise?.then(route => route.close()).catch(() => {});
    if (lease) {
      for (const id of pendingRequestIds) lease.cancel(id);
      const current = lease;
      lease = null;
      leasePromise = null;
      await pool.release(current);
      return;
    }
    await leasePromise?.catch(() => {});
  };
  unregisterCleanup = registerRequestCleanup(fetcher.dispose);
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
