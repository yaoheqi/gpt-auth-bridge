import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import express from 'express';
import { browserRequestMiddleware } from '../src/services/browser-request-context.js';
import { browserRequest, requestScoped, registerRequestCleanup } from '../src/services/request-scope.js';
import { Sub2ApiPushService } from '../src/services/sub2api-push-service.js';
import { runSseResponse } from '../src/api/batch/sse-runner.js';
import { CurlCffiWorkerPool } from '../lib/curl-cffi-fetch.js';

test('disconnected requests leave the shared HTTP worker queue immediately', async () => {
  const pool = new CurlCffiWorkerPool(1, { workerFactory: () => ({ leased: false, reset: async () => {} }) });
  const first = await pool.acquire();
  const abort = new AbortController();
  const queued = pool.acquire({ signal: abort.signal });
  assert.equal(pool.stats().queued, 1);
  abort.abort();
  await assert.rejects(queued, /disposed/);
  assert.equal(pool.stats().queued, 0);
  await pool.release(first);
  assert.equal(pool.stats().leased, 0);
});

test('concurrent browsers with identical account IDs stay isolated; completion and disconnect release data', async () => {
  const app = express();
  app.use(express.json());
  const contexts = [];
  let released = 0;
  app.use(browserRequestMiddleware({
    settings: () => ({ defaults: { sub2apiSettings: { adminApiKey: 'operator-private-key' } }, normalizers: {} }),
    createPushService: () => new Sub2ApiPushService({ env: {} }),
  }));
  const accounts = requestScoped('accounts', null);
  app.post('/api/v2/roundtrip', async (req, res) => {
    contexts.push(browserRequest());
    registerRequestCleanup(() => { released += 1; });
    await delay(req.body.delay);
    await accounts.updateById('same-id', { status: 'done' });
    res.json({ ok: true });
  });
  app.post('/api/v2/stream', async (_req, res) => {
    contexts.push(browserRequest());
    await runSseResponse(res, async sse => {
      sse.send('summary', { ok: true });
    });
  });
  let disconnectReleased;
  const disconnected = new Promise(resolve => { disconnectReleased = resolve; });
  app.post('/api/v2/disconnect', async (_req, res) => {
    const context = browserRequest();
    contexts.push(context);
    registerRequestCleanup(disconnectReleased);
    await runSseResponse(res, async () => {
      await new Promise(resolve => context.controller.signal.addEventListener('abort', resolve, { once: true }));
    });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (route, password, wait = 0) => fetch(`${url}/api/v2/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ delay: wait, browserState: { accounts: [{ id: 'same-id', email: 'fixture@example.com', password }] } }),
  });
  try {
    const responses = await Promise.all([send('roundtrip', 'fixture-A', 35), send('roundtrip', 'fixture-B', 5)]);
    const bodies = await Promise.all(responses.map(response => response.json()));
    assert.deepEqual(bodies.map(body => body.browserState.accounts[0].password), ['fixture-A', 'fixture-B']);
    assert.ok(bodies.every(body => body.browserState.accounts[0].status === 'done'));
    assert.doesNotMatch(JSON.stringify(bodies), /operator-private-key/);
    assert.equal(released, 2);
    const stream = await send('stream', 'fixture-SSE');
    const text = await stream.text();
    assert.equal((text.match(/event: browser_state/g) || []).length, 1);
    assert.match(text, /fixture-SSE/);
    assert.doesNotMatch(text, /fixture-A|fixture-B|operator-private-key/);
    const open = await send('disconnect', 'fixture-disconnected');
    await open.body.cancel();
    await disconnected;
    await delay(20);
    for (const context of contexts) {
      assert.equal(context.closed, true);
      assert.deepEqual(context.accounts.listAll(), []);
      assert.equal(context.settings.cache.size, 0);
      assert.equal(context.push.client, null);
      assert.throws(() => context.accounts.db.prepare('SELECT 1'), /not open|closed/i);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
