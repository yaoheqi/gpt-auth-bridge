import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app/create-app.js';
import { createTaskLimiter } from '../lib/task-concurrency.js';
import { executionError } from '../lib/execution-limits.js';
import { sanitizeLogMessage } from '../lib/log-sanitize.js';
import { operationErrorPayload, sendOperationError } from '../src/http/operation-error.js';
import { runSseResponse } from '../src/api/batch/sse-runner.js';
import { registerProtocolPipelineRoutes, registerBrowserSessionProbeRoute } from '../src/api/routes/protocol-pipeline-routes.js';
import { registerProtocolLogoutAllRoutes } from '../src/api/routes/protocol-logout-all-routes.js';
import { registerWorkspaceSelfLeaveRoutes } from '../src/api/routes/workspace-self-leave-routes.js';
import { registerSessionExportRoutes } from '../src/api/routes/session-export-routes.js';
import { registerConversionRoutes } from '../src/api/routes/conversion-routes.js';
import { registerAdminSettingsRoutes } from '../src/api/routes/admin-settings-routes.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return (path, body = {}, method = 'POST') => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-request-id': 'fixture-request', 'x-operation-id': 'fixture-operation' },
    ...(method === 'GET' ? {} : { body: JSON.stringify({ operationId: 'fixture-operation', ...body }) }),
  });
}

function assertContract(payload, code, status) {
  assert.equal(payload.ok, false);
  assert.equal(payload.code, code);
  assert.equal(payload.status, status);
  assert.equal(typeof payload.message, 'string');
  assert.ok(payload.message);
  assert.equal(payload.schemaVersion, '1.0.0');
  assert.equal(payload.operationId, 'fixture-operation');
  assert.equal(payload.requestId, 'fixture-request');
  assert.notEqual(payload.retryable, true, 'request timeout cannot prove an external write failed');
  assert.notEqual(payload.status, 'failed');
}

test('real queue and account deadline failures retain the same contract at JSON and SSE boundaries', async t => {
  for (const kind of ['full', 'queue-timeout', 'account-timeout']) for (const stream of [false, true]) {
    await t.test(`${kind} ${stream ? 'SSE' : 'JSON'}`, async child => {
      const limiter = createTaskLimiter(1, { maxPending: kind === 'full' ? 0 : 1, queueTimeoutMs: 15, taskTimeoutMs: kind === 'account-timeout' ? 15 : 2000 });
      const hold = deferred(), occupied = deferred();
      let blocking;
      if (kind !== 'account-timeout') {
        blocking = limiter.run(async () => { occupied.resolve(); await hold.promise; });
        await occupied.promise;
      }
      child.after(async () => { hold.resolve(); await blocking; });
      const run = () => limiter.run(() => kind === 'account-timeout' ? new Promise(() => {}) : assert.fail('queued work must not execute'));
      const app = createApp();
      app.post('/api/fixture', async (_req, res) => {
        if (stream) return runSseResponse(res, run);
        try { await run(); }
        catch (error) { sendOperationError(res, error); }
      });
      const send = await listen(child, app);
      const response = await send('/api/fixture');
      const [code, status] = kind === 'full' ? ['TASK_QUEUE_FULL', 429]
        : kind === 'queue-timeout' ? ['TASK_QUEUE_TIMEOUT', 503] : ['ACCOUNT_TASK_TIMEOUT', 504];
      assert.equal(response.status, stream ? 200 : status);
      let payload;
      if (stream) {
        const text = await response.text();
        const errors = [...text.matchAll(/event: error\ndata: ([^\n]+)/g)];
        assert.equal(errors.length, 1);
        payload = JSON.parse(errors[0][1]);
      } else payload = await response.json();
      assertContract(payload, code, status);
      assert.equal(payload.retryAfterMs, 1000);
      assert.equal(payload.error, payload.message);
    });
  }
});

test('mounted API catch handlers preserve scheduling errors, nested export shape and redaction', async t => {
  const app = createApp();
  const failure = executionError('TASK_QUEUE_FULL', 'private@example.com https://user:pass@proxy.test/path?key=secret 验证码123456', 429, 1250);
  const fail = async () => { throw failure; };
  const deps = { requireAdmin: (_req, _res, next) => next(), ensureDatabase: fail };
  registerProtocolPipelineRoutes(app, deps);
  registerBrowserSessionProbeRoute(app, deps);
  registerProtocolLogoutAllRoutes(app, deps);
  registerWorkspaceSelfLeaveRoutes(app, deps);
  registerSessionExportRoutes(app, deps);
  registerConversionRoutes(app, { ...deps, registerIdentity: fail });
  registerAdminSettingsRoutes(app, deps);
  const send = await listen(t, app);
  const routes = [
    ['/api/v2/accounts/protocol-login-pipeline'],
    ['/api/v2/accounts/session-probe'],
    ['/api/v2/accounts/monitor-lease'],
    ['/api/v2/accounts/protocol-logout-all', { confirmed: true }, 'POST', true],
    ['/api/v2/accounts/self-leave', { confirmed: true }, 'POST', true],
    ['/api/v2/accounts/export-sessions', {}, 'POST', false, true],
    ['/api/v2/conversions/session-agent', { session: { accessToken: 'fixture' } }, 'POST', false, true],
    ['/api/v2/admin/protocol/settings', {}, 'PUT'],
    ['/api/v2/admin/sub2api/settings', {}, 'PUT'],
    ['/api/v2/admin/sub2api/groups'],
    ['/api/v2/admin/protocol/settings', {}, 'GET'],
    ['/api/v2/admin/sub2api/settings', {}, 'GET'],
  ];
  for (const [path, body, method, sanitized, nested] of routes) {
    const response = await send(path, body, method);
    assert.equal(response.status, 429, path);
    const payload = await response.json();
    assertContract(payload, 'TASK_QUEUE_FULL', 429);
    assert.equal(payload.retryAfterMs, 1250);
    if (nested) assert.deepEqual(payload.error, { code: payload.code, message: payload.message });
    else assert.equal(payload.error, payload.message);
    if (sanitized) assert.doesNotMatch(JSON.stringify(payload), /private@|user:pass|key=secret|123456/);
  }
});

test('SSE redaction retains error metadata while removing sensitive message fragments', async t => {
  const app = createApp();
  app.post('/api/fixture', (_req, res) => runSseResponse(res, async () => {
    throw executionError('ACCOUNT_TASK_TIMEOUT', 'private@example.com https://user:pass@proxy.test/path?key=secret 验证码123456', 504, 2500);
  }, { errorOptions: { sanitize: sanitizeLogMessage } }));
  const send = await listen(t, app);
  const text = await (await send('/api/fixture')).text();
  const payload = JSON.parse(text.match(/event: error\ndata: ([^\n]+)/)[1]);
  assertContract(payload, 'ACCOUNT_TASK_TIMEOUT', 504);
  assert.equal(payload.retryAfterMs, 2500);
  assert.doesNotMatch(text, /private@|user:pass|key=secret|123456/);
});

test('unknown failures have stable codes and invalid statuses cannot become successful responses', () => {
  const unknown = operationErrorPayload(new Error('fixture unknown'));
  assert.deepEqual(unknown, { ok: false, code: 'REQUEST_FAILED', message: 'fixture unknown', status: 400, error: 'fixture unknown' });
  const invalid = operationErrorPayload({ code: 'ACCOUNT_TASK_TIMEOUT', status: 200, message: 'fixture timeout', retryAfterMs: -1 });
  assert.equal(invalid.status, 504);
  assert.equal(invalid.retryAfterMs, undefined);
  assert.equal(invalid.retryable, undefined);
  const legacy = operationErrorPayload({ code: 'SESSION_PROBE_UNAVAILABLE', statusCode: 503, message: 'fixture unavailable' }, { errorShape: 'object' });
  assert.equal(legacy.status, 503);
  assert.deepEqual(legacy.error, { code: legacy.code, message: legacy.message });
});
