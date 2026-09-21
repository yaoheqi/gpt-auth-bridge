import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserWorkerPool } from '../lib/browser-worker-pool.js';
import { withAccountTimings } from '../lib/stage-timing.js';

test('browser reuse preserves process but isolates cookies, storage, proxy and user agent', { timeout: 60000 }, async t => {
  const fixture = spawn(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), [
    fileURLToPath(new URL('../../tests/browser-worker-fixture.py', import.meta.url)),
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const stopped = once(fixture, 'exit');
  const reader = createInterface({ input: fixture.stdout });
  const ports = JSON.parse((await once(reader, 'line'))[0]);
  const pool = new BrowserWorkerPool({ size: 2, reuse: true, maxTasks: 4, idleMs: 1000 });
  try {
    const run = (proxy = '', agent = 'fixture-agent', signal) => withAccountTimings(async () => {
      const result = await pool.run({ userAgent: agent, deadlineSeconds: 10,
        authBaseUrl: proxy ? 'http://fixture.test' : `http://127.0.0.1:${ports.direct}`,
        proxyUrl: proxy ? `http://${proxy}:fixture@127.0.0.1:${ports[proxy]}` : '',
      }, { signal, timeoutMs: 15000 });
      const token = JSON.parse(result.sentinel_token);
      assert.equal(token.c, proxy || 'direct');
      assert.deepEqual(JSON.parse(token.p), { cookie: '', storage: null, agent });
      return { ok: true };
    });
    const cold = await run();
    const worker = [...pool.workers][0];
    const pid = worker.child.pid;
    const warm = await run('proxy-one', 'agent-one');
    const third = await run('proxy-two', 'agent-two');
    assert.equal(worker.child.pid, pid);
    assert.equal(cold.timings.browser_start.calls, 1);
    assert.equal(warm.timings.browser_start, undefined);
    assert.equal(third.timings.browser_start, undefined);
    assert.ok(warm.timings.browser_verify.calls === 1 && third.timings.browser_verify.calls === 1);
    assert.equal(pool.stats().reused, 2);
    await run(); // Maximum-use recycling must close the previous process.
    assert.equal(pool.workers.size, 0);
    assert.equal(worker.child, null);
    await Promise.all([run(), run('proxy-one')]);
    assert.equal(pool.workers.size, 2);
    assert.equal(pool.stats().active, 0);
    await delay(1200);
    for (let i = 0; pool.workers.size && i < 30; i++) await delay(100);
    assert.equal(pool.workers.size, 0, 'idle workers must be fully stopped');
    for (const failure of ['abort', 'crash', 'timeout']) {
      let navigated;
      const navigation = new Promise(resolve => { navigated = resolve; });
      const controller = new AbortController();
      const waiting = withAccountTimings(() => pool.run({ userAgent: 'fixture-hang',
        authBaseUrl: `http://127.0.0.1:${ports.direct}`, deadlineSeconds: 10,
      }, { signal: controller.signal, timeoutMs: failure === 'timeout' ? 3000 : 15000 }), {
        onTiming: data => { if (data.stage === 'browser_navigation') navigated(); },
      });
      const rejected = assert.rejects(waiting);
      await navigation;
      const interruptedWorker = [...pool.workers][0];
      if (failure === 'abort') controller.abort();
      if (failure === 'crash') interruptedWorker.child.kill();
      await rejected;
      assert.equal(pool.workers.size, 0);
      assert.equal(interruptedWorker.child, null);
      await run(); // A subsequent task succeeds in a fresh process.
      await pool.retire([...pool.workers][0]);
    }
    const coldPool = new BrowserWorkerPool({ size: 1, reuse: false });
    try {
      const firstCold = await coldPool.run({ authBaseUrl: `http://127.0.0.1:${ports.direct}` });
      assert.ok(firstCold.sentinel_token);
      assert.equal(coldPool.workers.size, 0);
    } finally { await coldPool.close(); }
    const startingPool = new BrowserWorkerPool({ size: 1, reuse: true });
    const starting = assert.rejects(startingPool.run({ authBaseUrl: `http://127.0.0.1:${ports.direct}` }), { name: 'AbortError' });
    while (!startingPool.workers.size) await Promise.resolve();
    const startingWorker = [...startingPool.workers][0];
    await startingPool.close();
    await starting;
    assert.equal(startingWorker.child, null, 'shutdown during spawn must not leave a child process');
    assert.equal(startingPool.stats().active, 0);
    t.diagnostic(JSON.stringify({ coldMs: cold.timings.total.durationMs, warmMs: warm.timings.total.durationMs,
      nextWarmMs: third.timings.total.durationMs, measuredAgainst: 'local SDK fixture' }));
  } finally {
    await pool.close();
    fixture.stdin.end();
    await stopped;
    reader.close();
  }
});

test('browser pool caps concurrency, cancels queued tasks, and retires failures before reuse', async () => {
  let count = 0, peak = 0, live = 0, closed = 0;
  const pool = new BrowserWorkerPool({ size: 2, reuse: true, workerFactory: root => ({
    root, tasks: 0,
    async run(payload, { signal }) {
      count++;
      peak = Math.max(peak, ++live);
      try { await delay(payload.delay || 10, null, { signal }); if (payload.fail) throw new Error('fixture'); return {}; }
      finally { live--; }
    },
    async stop() { if (!this.dead) { this.dead = true; closed++; } },
  }) });
  try {
    const active = [pool.run({ delay: 50 }), pool.run({ delay: 50 })];
    await delay(1);
    const controller = new AbortController();
    const queued = pool.run({}, { signal: controller.signal });
    const rejected = assert.rejects(queued, { name: 'AbortError' });
    controller.abort();
    await Promise.all([...active, rejected]);
    assert.equal(count, 2);
    assert.equal(peak, 2);
    await assert.rejects(pool.run({ fail: true }), /fixture/);
    assert.equal(closed, 1);
    await pool.run({});
    const activeController = new AbortController();
    const aborting = assert.rejects(pool.run({ delay: 1000 }, { signal: activeController.signal }), { name: 'AbortError' });
    await delay(1);
    activeController.abort();
    await aborting;
    assert.equal(closed, 2);
  } finally { await pool.close(); }
  await assert.rejects(pool.run({}), { name: 'AbortError' });
});
