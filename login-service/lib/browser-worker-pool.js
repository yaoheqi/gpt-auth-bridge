import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSemaphore } from './async-semaphore.js';
import { configuredTaskConcurrency } from './batch-concurrency.js';
import { measureStage, recordStageTiming } from './stage-timing.js';
import { requestSignal } from '../src/services/request-scope.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const browserReuseEnabled = (env = process.env) => /^(1|true|yes)$/i.test(String(env.BROWSER_REUSE_ENABLED || 'false'));
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
        throw error;
      }
      this.child = child;
      this.stderr = '';
      this.exited = new Promise(resolve => child.once('close', resolve));
      child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-4000); });
      this.reader = createInterface({ input: child.stdout });
      this.reader.on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { this.pending?.reject(new Error('Invalid browser worker response')); return; }
        const pending = this.pending;
        if (!pending || message.id !== pending.id) return;
        if (message.event === 'timing') { pending.timing(message); return; }
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error || 'Browser worker failed'));
      });
      const fail = error => this.pending?.reject(error);
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.once('close', () => {
        this.dead = true;
        fail(new Error(this.stderr || 'Browser worker exited'));
        this.stderr = '';
        this.reader.close();
      });
      return;
    }
    throw new Error('No Python executable is available');
  }

  async run(payload, { signal, timeoutMs = 90000 } = {}) {
    await this.start();
    signal?.throwIfAborted();
    if (this.dead) throw new Error('Browser worker exited before accepting the task');
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
      const timer = setTimeout(() => finish(reject, new Error('Browser worker exceeded its deadline')), timeoutMs);
      this.pending = { id, resolve: value => finish(resolve, value), reject: error => finish(reject, error),
        // Capture the caller's async scope; stdout events run in the process's original scope.
        timing: AsyncResource.bind(message => recordStageTiming(message.stage, Number(message.durationMs), message.outcome)) };
      signal?.addEventListener('abort', abort, { once: true });
      try { this.child.stdin.write(JSON.stringify({ ...payload, id }) + '\n'); }
      catch (error) { this.pending.reject(error); }
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
  constructor({ size = configuredTaskConcurrency(), reuse = browserReuseEnabled(), idleMs = 60_000, maxTasks = 20,
    workerFactory = root => new BrowserWorker(root) } = {}) {
    this.semaphore = createSemaphore(size);
    this.reuse = reuse;
    this.idleMs = idleMs;
    this.maxTasks = maxTasks;
    this.workerFactory = workerFactory;
    this.workers = new Set();
    this.controller = new AbortController();
    this.completed = 0;
    this.reused = 0;
  }

  async retire(worker) {
    clearTimeout(worker.idleTimer);
    try { await worker.stop(); } finally { this.workers.delete(worker); }
  }

  async run(payload, { root = ROOT, signal = requestSignal(), timeoutMs } = {}) {
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    const release = await measureStage('browser_queue', () => this.semaphore.acquire({ signal: combined }));
    let worker;
    let succeeded = false;
    try {
      combined.throwIfAborted();
      // A stopped slot is not replaced until all its processes have exited.
      await Promise.all([...this.workers].filter(item => item.dead).map(item => this.retire(item)));
      await Promise.all([...this.workers].filter(item => !item.busy && item.root !== root).map(item => this.retire(item)));
      combined.throwIfAborted();
      worker = [...this.workers].find(item => !item.busy && !item.dead && item.root === root);
      if (!worker) { worker = this.workerFactory(root); this.workers.add(worker); }
      worker.busy = true;
      clearTimeout(worker.idleTimer);
      if (worker.tasks) this.reused++;
      const result = await worker.run(payload, { signal: combined, timeoutMs });
      worker.tasks++;
      this.completed++;
      succeeded = true;
      return result;
    } finally {
      try {
        if (worker) {
          if (!succeeded || !this.reuse || this.controller.signal.aborted || worker.tasks >= this.maxTasks) await this.retire(worker);
          else {
            worker.busy = false;
            worker.idleTimer = setTimeout(() => { void this.retire(worker).catch(() => {}); }, this.idleMs);
            worker.idleTimer.unref?.();
          }
        }
      } finally { release(); }
    }
  }

  stats() {
    return { ...this.semaphore.stats(), reuseEnabled: this.reuse, workers: this.workers.size,
      completed: this.completed, reused: this.reused };
  }

  async close() {
    this.controller.abort();
    await Promise.allSettled([...this.workers].map(worker => this.retire(worker)));
  }
}

export const browserWorkerPool = new BrowserWorkerPool();
