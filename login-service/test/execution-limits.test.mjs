import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createSemaphore } from '../lib/async-semaphore.js';
import { createTaskLimiter } from '../lib/task-concurrency.js';
import { CurlCffiWorker, CurlCffiWorkerPool, createCurlCffiFetch } from '../lib/curl-cffi-fetch.js';
import { BrowserWorkerPool } from '../lib/browser-worker-pool.js';
import { requests, requestSignal, registerRequestCleanup, requestScoped } from '../src/services/request-scope.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('bounded FIFO queue rejects overflow, expires waiting work, and admits the next caller', async () => {
  const slots = createSemaphore(1, { maxPending: 2, queueTimeoutMs: 1000 });
  const release = await slots.acquire();
  const expired = assert.rejects(slots.acquire({ timeoutMs: 15 }), { code: 'TASK_QUEUE_TIMEOUT', status: 503 });
  const next = slots.acquire();
  await assert.rejects(slots.acquire(), { code: 'TASK_QUEUE_FULL', status: 429 });
  await expired;
  assert.equal(slots.stats().pending, 1);
  release();
  const releaseNext = await next;
  assert.equal(slots.stats().active, 1);
  releaseNext();
  assert.deepEqual(slots.stats(), { active: 0, pending: 0, limit: 1 });
});

test('account deadline covers nested phases, propagates to legacy requestSignal and blocks late writes', async () => {
  const limiter = createTaskLimiter(1, { taskTimeoutMs: 20 });
  const repository = requestScoped('accounts', { write() { throw new Error('must not write'); } });
  let accountSignal, lateWrite = false;
  await assert.rejects(limiter.run(async () => {
    accountSignal = requestSignal();
    await limiter.run(async () => {
      assert.equal(requestSignal(), accountSignal);
      await delay(50);
      assert.throws(() => repository.write(), { code: 'ACCOUNT_TASK_TIMEOUT' });
      lateWrite = true;
    });
  }), { code: 'ACCOUNT_TASK_TIMEOUT', status: 504 });
  assert.equal(accountSignal.aborted, true);
  await delay(60);
  assert.equal(lateWrite, true);
  assert.deepEqual(limiter.stats(), { active: 0, pending: 0, limit: 1 });
  assert.equal(await limiter.run(() => 'next'), 'next');
});

test('request and caller cancellation share account signal and await cleanup before handing off a slot', async () => {
  for (const source of ['request', 'caller']) {
    const limiter = createTaskLimiter(1);
    const request = new AbortController(), caller = new AbortController();
    const entered = deferred(), cleanup = deferred();
    const first = requests.run({ controller: request, cleanups: new Set() }, () => limiter.run(async () => {
      registerRequestCleanup(() => cleanup.promise);
      entered.resolve();
      await new Promise(() => {});
    }, { signal: caller.signal }));
    const rejected = assert.rejects(first, { name: 'AbortError' });
    await entered.promise;
    let nextStarted = false;
    const next = limiter.run(() => { nextStarted = true; });
    (source === 'request' ? request : caller).abort();
    await delay(5);
    assert.equal(nextStarted, false);
    cleanup.resolve();
    await Promise.all([rejected, next]);
    assert.equal(nextStarted, true);
  }
});

test('a stuck account cleanup has a finite budget', async () => {
  const limiter = createTaskLimiter(1, { cleanupTimeoutMs: 15 });
  await assert.rejects(limiter.run(() => {
    registerRequestCleanup(() => new Promise(() => {}));
  }), { code: 'WORKER_CLEANUP_TIMEOUT' });
  assert.equal(limiter.stats().active, 0);
});

function controlledWorkers({ cleanupTimeoutMs = 500 } = {}) {
  const children = [];
  const factory = index => new CurlCffiWorker(index, { cleanupTimeoutMs, spawnProcess() {
    const child = new EventEmitter();
    child.pid = children.length + 1;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kills = 0;
    child.kill = () => { child.kills++; return true; };
    child.finish = () => {
      child.stdin.end(); child.stdout.end(); child.stderr.end(); child.emit('close', 0);
    };
    child.stdin.on('data', chunk => {
      const request = JSON.parse(chunk.toString());
      if (request.command === 'reset') queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, ok: true }) + '\n'));
      else child.received = request;
    });
    children.push(child);
    return child;
  } });
  return { children, factory };
}

test('HTTP queue has bounded capacity and expires without taking an account lease', async () => {
  const pool = new CurlCffiWorkerPool(1, { maxPending: 1, queueTimeoutMs: 15,
    workerFactory: () => ({ leased: false, reset: async () => {}, kill() {} }),
  });
  const first = await pool.acquire();
  const expired = assert.rejects(pool.acquire(), { code: 'TASK_QUEUE_TIMEOUT' });
  await assert.rejects(pool.acquire(), { code: 'TASK_QUEUE_FULL' });
  await expired;
  await pool.release(first);
  assert.equal(pool.stats().leased, 0);
  await pool.close();
});

test('in-flight HTTP cancellation kills the old process and waits for actual exit before reusing its slot', async () => {
  const { children, factory } = controlledWorkers();
  const pool = new CurlCffiWorkerPool(1, { workerFactory: factory });
  const controller = new AbortController();
  const transport = createCurlCffiFetch('', { direct: true, pool });
  const request = transport('http://fixture.invalid/hang', { signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  while (!children[0]?.received) await delay(1);
  controller.abort();
  await rejected;
  assert.ok(children[0].kills > 0);
  let nextStarted = false;
  const next = pool.acquire().then(worker => { nextStarted = true; return worker; });
  await delay(5);
  assert.equal(nextStarted, false);
  assert.equal(children.length, 1);
  children[0].finish();
  const worker = await next;
  assert.equal(children.length, 2);
  await transport.dispose();
  await pool.release(worker);
  const closed = pool.close();
  children[1].finish();
  await closed;
});

test('account deadline reaches an in-flight worker even when fetch has no explicit signal', async () => {
  const { children, factory } = controlledWorkers();
  const pool = new CurlCffiWorkerPool(1, { workerFactory: factory });
  const limiter = createTaskLimiter(1, { taskTimeoutMs: 25, cleanupTimeoutMs: 500 });
  const task = limiter.run(async () => {
    const transport = createCurlCffiFetch('', { direct: true, pool });
    await transport('http://fixture.invalid/hang');
  });
  const rejected = assert.rejects(task, { code: 'ACCOUNT_TASK_TIMEOUT' });
  while (!children[0]?.kills) await delay(1);
  assert.equal(limiter.stats().active, 1, 'slot stays held while Python is terminating');
  children[0].finish();
  await rejected;
  assert.equal(pool.stats().leased, 0);
  await pool.close();
});

test('HTTP cleanup timeout quarantines capacity until a late OS exit restores it', async () => {
  const { children, factory } = controlledWorkers({ cleanupTimeoutMs: 20 });
  const pool = new CurlCffiWorkerPool(1, { workerFactory: factory, cleanupTimeoutMs: 30 });
  const controller = new AbortController();
  const transport = createCurlCffiFetch('', { direct: true, pool, cleanupTimeoutMs: 100 });
  const rejected = assert.rejects(transport('http://fixture.invalid', { signal: controller.signal }), { name: 'AbortError' });
  while (!children[0]?.received) await delay(1);
  controller.abort();
  await rejected;
  await transport.dispose();
  let acquired = false;
  const next = pool.acquire().then(worker => { acquired = true; return worker; });
  await delay(5);
  assert.equal(acquired, false);
  assert.equal(children.length, 1);
  assert.equal(pool.stats().leased, 1);
  children[0].finish();
  const worker = await next;
  assert.equal(children.length, 2);
  await pool.release(worker);
  const closing = pool.close();
  children[1].finish();
  await closing;
});

test('a stuck browser cleanup quarantines its worker instead of spawning beyond capacity', async () => {
  const stopped = deferred();
  let created = 0;
  const pool = new BrowserWorkerPool({ size: 1, cleanupTimeoutMs: 15, workerFactory: root => {
    created++;
    return { root, tasks: 0, run: async () => ({}), stop: () => stopped.promise };
  } });
  await assert.rejects(pool.run({}), { code: 'WORKER_CLEANUP_TIMEOUT' });
  await assert.rejects(pool.run({}), { code: 'WORKER_CLEANUP_TIMEOUT' });
  assert.equal(created, 1);
  assert.equal(pool.workers.size, 1);
  stopped.resolve();
  await pool.close();
  assert.equal(pool.workers.size, 0);
});

test('real Python HTTP worker is terminated on cancellation and the next local request succeeds', { timeout: 15_000 }, async () => {
  const received = deferred();
  const server = createServer((req, res) => {
    if (req.url === '/hang') { received.resolve(); return; }
    res.end('local fixture');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const pool = new CurlCffiWorkerPool(1);
  const first = createCurlCffiFetch('', { direct: true, pool });
  const second = createCurlCffiFetch('', { direct: true, pool });
  try {
    const controller = new AbortController();
    const rejected = assert.rejects(first(`${base}/hang`, { signal: controller.signal }), { name: 'AbortError' });
    await received.promise;
    const original = pool.workers[0].child;
    controller.abort();
    await rejected;
    await first.dispose();
    assert.ok(original.exitCode !== null || original.signalCode !== null);
    assert.equal(await (await second(`${base}/ok`)).text(), 'local fixture');
    assert.notEqual(pool.workers[0].child.pid, original.pid);
  } finally {
    await Promise.allSettled([first.dispose(), second.dispose()]);
    await pool.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('cancellation during proxy setup leaves no HTTP lease and closes a late tunnel', async () => {
  const route = deferred();
  const closed = deferred();
  const controller = new AbortController();
  let acquired = false;
  const transport = createCurlCffiFetch('', { cleanupTimeoutMs: 15,
    routeFactory: () => route.promise, pool: { acquire() { acquired = true; } },
  });
  const request = transport('http://fixture.invalid', { signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  await delay(1);
  controller.abort();
  await rejected;
  await assert.rejects(transport.dispose(), { code: 'WORKER_CLEANUP_TIMEOUT' });
  assert.equal(acquired, false);
  route.resolve({ url: '', close: () => { closed.resolve(); } });
  await closed.promise;
});
