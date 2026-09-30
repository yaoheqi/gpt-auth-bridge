import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createTaskLimiter } from '../lib/task-concurrency.js';
import { getBrowserSentinelConcurrency, createBrowserSentinelLimiter } from '../lib/openai-sentinel.js';
import { SSEChannel, mapWithConcurrency } from '../lib/sse.js';
import { registerProtocolPipelineRoutes } from '../src/api/routes/protocol-pipeline-routes.js';
import { resolveProtocolLoginConcurrency } from '../src/services/job-runner.js';

test('all concurrent batches share one fixed global queue despite rate-limit results', async () => {
  let active = 0, peak = 0, total = 0;
  const run = async () => {
    peak = Math.max(peak, ++active);
    const index = total++;
    await delay(2);
    active--;
    return { ok: false, error: index % 2 ? 'HTTP 429' : 'network timeout' };
  };
  const results = await Promise.all(Array.from({ length: 3 }, () => mapWithConcurrency(Array.from({ length: 10 }), 10, run)));
  assert.equal(peak, 10);
  assert.equal(total, 30);
  assert.equal(results.flat().length, 30);
});

test('task queue supports nested phases, removes cancelled waits and releases failures', async () => {
  const tasks = createTaskLimiter(1);
  let finish;
  const first = tasks.run(() => tasks.run(() => new Promise(resolve => { finish = resolve; })));
  await delay(0);
  const abort = new AbortController();
  let entered = false;
  const cancelled = tasks.run(() => { entered = true; }, { signal: abort.signal });
  const failed = tasks.run(() => { throw new Error('fixture failure'); });
  assert.equal(tasks.stats().pending, 2);
  abort.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(tasks.stats().pending, 1);
  const rejected = assert.rejects(failed, /fixture failure/);
  finish();
  await Promise.all([first, rejected]);
  assert.equal(entered, false);
  assert.deepEqual(tasks.stats(), { active: 0, pending: 0, limit: 1 });
});

test('browser helper follows global concurrency for both five and ten account slots', async () => {
  assert.equal(getBrowserSentinelConcurrency({}), 10);
  assert.equal(getBrowserSentinelConcurrency({ TASK_CONCURRENCY: '7', BROWSER_CONCURRENCY: '3' }), 7);
  assert.equal(getBrowserSentinelConcurrency({ TASK_CONCURRENCY: '1', BROWSER_CONCURRENCY: '3' }), 1);
  for (const concurrency of [5, 10]) {
    const configured = getBrowserSentinelConcurrency({ TASK_CONCURRENCY: concurrency, BROWSER_CONCURRENCY: 2 });
    const tasks = createTaskLimiter(concurrency);
    const browsers = createBrowserSentinelLimiter(configured);
    let active = 0, peak = 0;
    await Promise.all(Array.from({ length: 2 * concurrency + 1 }, () => tasks.run(() => browsers.run(async () => {
      peak = Math.max(peak, ++active);
      await delay(1);
      active--;
    }))));
    assert.equal(peak, concurrency);
    assert.deepEqual(browsers.stats(), { active: 0, pending: 0, limit: concurrency });
    assert.deepEqual(tasks.stats(), { active: 0, pending: 0, limit: concurrency });
  }
});

test('both protocol modes use fixed server concurrency and ignore browser overrides', async () => {
  const accounts = Array.from({ length: 12 }, (_, id) => ({
    id: String(id), email: `fixture-${id}@example.com`, password: 'FixturePassword!', two_factor_secret: 'JBSWY3DPEHPK3PXP',
  }));
  for (const workspaceMode of ['session', 'all']) {
    for (const configured of [2, 10]) {
      for (const requested of [undefined, 1, 20, 80]) {
        let handler;
        let active = 0, peak = 0;
        const run = async () => {
          peak = Math.max(peak, ++active);
          await delay(1);
          active--;
          return { ok: true };
        };
        registerProtocolPipelineRoutes({ post(_path, _middleware, route) { handler = route; } }, {
          requireAdmin() {}, ensureDatabase: async () => {}, findAccountById: id => accounts[Number(id)],
          getSessionReloginConcurrency: requested => resolveProtocolLoginConcurrency({ requested, globalConcurrency: configured }),
          protocolRequestNetwork: () => ({}), runSessionHealthCheckForAccount: run,
          runAllWorkspaceCodexAuthForAccount: run, publicAccountView: account => account,
        });
        let payload;
        await handler({ body: { ids: accounts.map(account => account.id), workspaceMode, concurrency: requested }, headers: {} }, {
          status() { return this; }, json(value) { payload = value; },
        });
        assert.equal(payload.success, accounts.length, JSON.stringify(payload));
        assert.equal(peak, configured);
        assert.equal(payload.concurrency, configured);
        assert.equal(payload.adaptive, undefined);
      }
    }
  }
});

function collectBatch(count) {
  const accounts = Array.from({ length: count }, (_, id) => ({ id: String(id), password: `fixture-${id}`, session: 'x'.repeat(1000) }));
  const res = new EventEmitter();
  const frames = [];
  res.write = frame => { frames.push(frame); return true; };
  res.locals = { browserSnapshot: ids => ({ accounts: ids ? ids.map(id => accounts[Number(id)]) : accounts, settings: {} }) };
  const channel = new SSEChannel(res);
  for (const account of accounts) channel.send('account_done', { id: account.id, ok: true });
  channel.send('summary', { ok: true });
  return { frames, bytes: Buffer.byteLength(frames.join('')) };
}

test('disconnect stops the fixed queue before another account starts', async () => {
  const abort = new AbortController();
  let started = 0;
  const result = mapWithConcurrency([1, 2, 3], 1, async () => {
    started++;
    abort.abort();
    await delay(10);
    return { ok: true };
  }, { signal: abort.signal });
  await assert.rejects(result, { name: 'AbortError' });
  await delay(20);
  assert.equal(started, 1);
});

test('SSE sends one account per completion, a final snapshot, and grows linearly', () => {
  const small = collectBatch(100);
  const large = collectBatch(200);
  const changes = small.frames.filter(frame => frame.startsWith('event: browser_state')).map(frame => JSON.parse(frame.split('\ndata: ')[1]));
  assert.equal(changes.length, 101);
  assert.ok(changes.slice(0, -1).every(change => change.partial && change.accounts.length === 1));
  assert.equal(changes.at(-1).accounts.length, 100);
  assert.ok(large.bytes < small.bytes * 2.1);
  assert.ok(small.bytes < 300_000);
});

test('SSE retains numeric stage timings while redacting credentials and unknown timing fields', () => {
  const res = new EventEmitter();
  const frames = [];
  res.write = frame => { frames.push(frame); return true; };
  const channel = new SSEChannel(res);
  const result = { id: 'fixture', password: 'private-password', timings: {
    password: { durationMs: 120, calls: 1, token: 'private-token' },
    token_exchange: { durationMs: 300, calls: 2 },
    proxy_preflight: { durationMs: 90, calls: 1, proxy: 'private-proxy' },
    'fixture@example.com': { durationMs: 100 },
    session: { durationMs: 'private-session' },
  } };
  channel.send('account_done', result);
  channel.send('summary', { results: [result] });
  const data = frames.slice(1).map(frame => JSON.parse(frame.split('\ndata: ')[1]));
  for (const item of [data[0], data[1].results[0]]) {
    assert.deepEqual(item.timings, {
      password: { durationMs: 120, calls: 1 }, token_exchange: { durationMs: 300, calls: 2 },
      proxy_preflight: { durationMs: 90, calls: 1 },
    });
    assert.equal(item.password, '[REDACTED]');
  }
  assert.doesNotMatch(frames.join(''), /private-|fixture@example/);
});

test('slow SSE clients cannot grow the output buffer without a bound', async () => {
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) {} });
  const channel = new SSEChannel(output, { maxBufferedBytes: 5000, drainTimeoutMs: 1000 });
  for (let i = 0; i < 100; i++) channel.send('log', { message: 'x'.repeat(1000) });
  assert.equal(output.destroyed, true);
  assert.ok(output.writableLength <= 5000);
  await delay(0);
});

test('SSE disconnects a client that never drains even without more events', async () => {
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) {} });
  new SSEChannel(output, { drainTimeoutMs: 10 });
  await delay(30);
  assert.equal(output.destroyed, true);
});
