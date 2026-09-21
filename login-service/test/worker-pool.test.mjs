import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { CurlCffiWorkerPool } from '../lib/curl-cffi-fetch.js';

function fixture(options = {}) {
  const created = [];
  const pool = new CurlCffiWorkerPool(5, {
    workerFactory: index => {
      const worker = {
        index, leased: false, child: null, cookies: '', resets: 0,
        async start() { this.child ||= { pid: index + 1 }; },
        async reset() { this.cookies = ''; this.resets++; },
        kill() { this.child = null; },
      };
      created.push(worker);
      return worker;
    },
    ...options,
  });
  return { pool, created };
}

test('fixed pool warms every worker, queues fairly, cancels waits and isolates cookies', async t => {
  const { pool, created } = fixture();
  t.after(() => pool.close());
  assert.equal(pool.stats().workers, 0);
  await Promise.all([pool.start(), pool.start()]);
  assert.equal(created.length, 5);
  const leases = await Promise.all(Array.from({ length: 5 }, () => pool.acquire()));
  assert.equal(new Set(leases).size, 5);
  const abort = new AbortController();
  const cancelled = pool.acquire({ signal: abort.signal });
  const first = pool.acquire();
  const second = pool.acquire();
  assert.equal(pool.stats().queued, 3);
  assert.equal(pool.stats().running, 5);
  abort.abort();
  await assert.rejects(cancelled, /disposed/);
  leases[0].cookies = 'first-account';
  await pool.release(leases[0]);
  assert.equal(await first, leases[0]);
  assert.equal(leases[0].cookies, '');
  await pool.release(leases[1]);
  assert.equal(await second, leases[1]);
  await Promise.all(leases.map(worker => pool.release(worker)));
  assert.equal(pool.stats().queued, 0);
  assert.equal(pool.stats().leased, 0);
  assert.equal(pool.stats().running, 5);
  assert.equal(created.length, 5);
  pool.close();
  assert.ok(created.every(worker => !worker.child));
  await assert.rejects(pool.acquire(), /disposed/);
});

test('resetting leases cannot be reused and shutdown does not restart them', async t => {
  const { pool, created } = fixture();
  t.after(() => pool.close());
  await pool.start();
  const leases = await Promise.all(Array.from({ length: 5 }, () => pool.acquire()));
  const worker = leases[0];
  let resetDone;
  worker.reset = () => new Promise(resolve => { resetDone = resolve; });
  const releasing = pool.release(worker);
  let acquired = false;
  const pending = pool.acquire().then(() => { acquired = true; });
  await nextTurn();
  assert.equal(acquired, false);
  const rejected = assert.rejects(pending, /disposed/);
  pool.close();
  resetDone();
  await Promise.all([releasing, rejected]);
  assert.ok(created.every(item => !item.child));
  assert.equal(pool.stats().workers, 0);
});

test('failed warmup cleans up every child and rejects acquisitions', async () => {
  const children = [];
  const pool = new CurlCffiWorkerPool(5, { workerFactory: index => {
    const worker = {
      child: null,
      async start() {
        this.child = { pid: index + 1 };
        if (index === 3) throw new Error('fixture startup failure');
      },
      kill() { this.child = null; },
    };
    children.push(worker);
    return worker;
  } });
  const starting = pool.start();
  const acquisition = pool.acquire();
  const results = await Promise.allSettled([starting, acquisition]);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.ok(children.every(worker => !worker.child));
  assert.equal(pool.stats().workers, 0);
});

test('a failed session reset kills its state before the next account acquires it', async t => {
  const { pool } = fixture();
  t.after(() => pool.close());
  const worker = await pool.acquire();
  const original = worker.child;
  worker.reset = async () => { throw new Error('fixture reset failure'); };
  await pool.release(worker);
  assert.equal(worker.child, null);
  assert.equal(await pool.acquire(), worker);
  assert.notEqual(worker.child, original);
});

test('periodic maintenance preserves fixed capacity and replaces a dead worker', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { pool, created } = fixture();
  t.after(() => pool.close());
  await pool.start();
  t.mock.timers.tick(90_000);
  await nextTurn();
  assert.equal(pool.stats().running, 5);
  pool.workers[0].kill();
  assert.equal(pool.stats().running, 4);
  t.mock.timers.tick(30_000);
  await nextTurn();
  assert.equal(pool.stats().running, 5);
  assert.equal(created.length, 5);
});
