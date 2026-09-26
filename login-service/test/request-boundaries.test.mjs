import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp, installErrorHandlers } from '../src/app/create-app.js';
import { browserRequestMiddleware } from '../src/services/browser-request-context.js';
import { createSqliteRuntime } from '../src/bootstrap/sqlite-runtime.js';
import { browserRequest, requestScoped } from '../src/services/request-scope.js';
import { validateOperationEvent } from '../../docs/operation-contract.js';

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const scenario of [
  { name: 'admission rejection', options: { requestCapacity: 0 }, body: '{"operationId":"fixture-operation"}', status: 429, code: 'REQUEST_CAPACITY_FULL' },
  { name: 'malformed JSON', options: {}, body: '{', status: 400, code: 'INVALID_JSON' },
  { name: 'oversized JSON', options: { jsonLimit: '32b' }, body: JSON.stringify({ operationId: 'fixture-operation', padding: 'x'.repeat(100) }), status: 413, code: 'PAYLOAD_TOO_LARGE' },
]) {
  test(`${scenario.name} remains compatible with the browser operation validator`, async t => {
    const app = createApp(scenario.options);
    app.post('/api/operation', (_req, res) => res.json({ ok: true }));
    installErrorHandlers(app);
    const base = await listen(t, app);
    const response = await fetch(`${base}/api/operation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operation-id': 'fixture-operation', 'x-request-id': 'fixture-http-request' },
      body: scenario.body,
    });
    const payload = await response.json();
    assert.equal(response.status, scenario.status);
    assert.equal(payload.code, scenario.code);
    assert.equal(payload.requestId, 'fixture-http-request');
    assert.doesNotThrow(() => validateOperationEvent('json', payload, { operationId: 'fixture-operation' }));
  });
}

test('API path casing cannot route browser credentials into the process fallback repository', async t => {
  const fallback = createSqliteRuntime();
  await fallback.accounts.initialize();
  t.after(() => { fallback.db.close(); fallback.secrets.key.fill(0); });
  const accounts = requestScoped('accounts', fallback.accounts);
  const app = createApp();
  app.use(browserRequestMiddleware({
    strictRoutes: true,
    settings: () => ({ defaults: {}, normalizers: {} }),
    createPushService: () => ({ configure() {}, clear() {} }),
  }));
  app.post('/api/v2/accounts/import', (req, res) => {
    accounts.importOne({ id: req.body.id, email: `${req.body.id}@example.test`, password: 'fixture-password' });
    res.json({ ok: true });
  });
  installErrorHandlers(app);
  const base = await listen(t, app);
  const paths = [
    '/API/V2/accounts/import',
    '/api/V2/accounts/import',
    '/api/v2/Accounts/import',
    '/api/v2/accounts/Import',
    '/API/login-icloud/api/v2/accounts/import',
    '/api/login-icloud/API/V2/accounts/import',
    '/api/login-icloud/api/v2/Accounts/import',
    '/api/v2/accounts/import',
    '/api/login-icloud/api/v2/accounts/import',
  ];
  for (const [index, route] of paths.entries()) {
    const id = `case-${index}`;
    const response = await fetch(`${base}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, browserState: { accounts: [] } }),
    });
    assert.equal(fallback.accounts.listAll().length, 0, `${route} bypassed request isolation`);
    if (index < paths.length - 2) {
      assert.equal(response.status, 404, `${route} must not enter a case-insensitive business route`);
    } else {
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.deepEqual(payload.browserState.accounts.map(account => account.id), [id]);
    }
  }
});

test('completed request queues do not retain browser settings secrets after cache cleanup', async t => {
  const app = createApp();
  let context;
  app.use(browserRequestMiddleware({
    strictRoutes: true,
    settings: () => ({ defaults: {}, normalizers: {} }),
    createPushService: () => ({ configure() {}, clear() {} }),
  }));
  const accounts = requestScoped('accounts', null);
  app.post('/api/v2/accounts/import', async (_req, res) => {
    context = browserRequest();
    await accounts.updateById('fixture', { status: 'complete' });
    res.json({ ok: true });
  });
  installErrorHandlers(app);
  const base = await listen(t, app);
  const response = await fetch(`${base}/api/v2/accounts/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ browserState: {
      accounts: [{ id: 'fixture', email: 'fixture@example.test', password: 'fixture-browser-password' }],
      settings: { sub2apiSettings: { baseUrl: 'https://sub2.example.test', adminApiKey: 'fixture-browser-key' } },
    } }),
  });
  assert.equal(response.status, 200);
  await response.json();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.closed, true);
  assert.equal(context.settings.cache.size, 0);
  const retainedCompletions = await Promise.all([context.settings.writeQueue, context.accounts.writeQueue]);
  assert.doesNotMatch(JSON.stringify(retainedCompletions), /fixture-browser-(?:key|password)/);
});
