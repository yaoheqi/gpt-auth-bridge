import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { YesCaptchaSolver } from './yescaptcha.js';
import { createOpenAISentinelTokenFetcher, solveTurnstileViaBrowserSentinel } from './openai-sentinel.js';
import { validationError, decodeBrowserFailure, validationFailureFields } from './validation-error.js';
import { validationFailureHint } from '../../docs/validation-failure.js';
import { classifyAuthFailure, retryPolicyForFailure } from '../src/lib/auth-failure-classifier.js';
import { runProtocolLoginPipelineAccount } from '../src/services/protocol-login-pipeline.js';
import { operationErrorPayload } from '../src/http/operation-error.js';
import { SSEChannel } from './sse.js';
import { requests } from '../src/services/request-scope.js';
import { BrowserWorkerPool } from './browser-worker-pool.js';
import { createBrowserDiagnostics } from './browser-diagnostics.js';

const challenge = async () => ({ ok: true, json: async () => ({ turnstile: { dx: 'fixture' } }) });
const account = { id: 'fixture', email: 'fixture@example.com', password: 'fixture', two_factor_secret: 'JBSWY3DPEHPK3PXP' };

test('structured browser errors survive protocol results, JSON and SSE without leaking cause', async () => {
  const error = decodeBrowserFailure({ code: 'BROWSER_CLOSED', stage: 'browser_navigation', attempt: 2,
    message: 'private-cookie', proxy: 'private-proxy', cleanupCode: 'BROWSER_CLEANUP_FAILED' });
  error.message = 'Turnstile: browser closed';
  for (const workspaceMode of ['session', 'all']) {
    const fail = async () => { throw error; };
    const result = await runProtocolLoginPipelineAccount(account, { workspaceMode, runSessionLogin: fail, runAllWorkspaces: fail });
    assert.equal(result.validationFailure.code, 'BROWSER_CLOSED');
    assert.equal(result.validationFailure.cleanupCode, 'BROWSER_CLEANUP_FAILED');
    assert.equal(classifyAuthFailure(result), 'browser_unavailable');
    assert.equal(retryPolicyForFailure(classifyAuthFailure(result)).retry, false);
    assert.ok(validationFailureHint(result));
    const frames = [];
    const res = new EventEmitter();
    res.write = frame => { frames.push(frame); return true; };
    new SSEChannel(res).send('account_done', result);
    const publicResult = JSON.parse(frames.at(-1).split('\ndata: ')[1]);
    assert.deepEqual(publicResult.validationFailure, result.validationFailure);
    assert.doesNotMatch(frames.join(''), /private-cookie|private-proxy/);
  }
  assert.equal(operationErrorPayload(error).validationFailure.code, 'BROWSER_CLOSED');
  assert.deepEqual(validationFailureFields({ code: 'evil', cause: 'secret' }), {});
  assert.equal(decodeBrowserFailure('raw-secret').code, 'BROWSER_PROTOCOL_ERROR');
});

test('returned Session failures retain structured metadata', async () => {
  const failure = validationFailureFields(validationError('VALIDATION_CONTEXT_MISMATCH', { stage: 'browser_verify' }));
  const result = await runProtocolLoginPipelineAccount(account, { workspaceMode: 'session',
    runSessionLogin: async () => ({ ok: false, error: 'fixture', ...failure }) });
  assert.deepEqual(result.validationFailure, failure.validationFailure);
});

test('browser contract passes device and flow to worker and never rewrites its result', async () => {
  const raw = JSON.stringify({ id: 'device', flow: 'password_verify', c: 'challenge', p: 'proof', extra: 'preserved' });
  const pool = { async run(payload, options) {
    assert.equal(payload.deviceID, 'device');
    assert.equal(payload.flow, 'password_verify');
    assert.equal(payload.proxyUrl, 'http://fixture');
    assert.ok(options.remainingMs() <= 1000);
    return { sentinel_token: raw, oai_did: 'device' };
  } };
  assert.equal(await solveTurnstileViaBrowserSentinel('device', 'password_verify', { pool, timeoutMs: 1000, proxyUrl: 'http://fixture' }), raw);
  for (const token of [{ id: 'other', flow: 'password_verify', c: 'c' }, { id: 'device', flow: 'authorize_continue', c: 'c' }, { c: 'c' }, null]) {
    await assert.rejects(solveTurnstileViaBrowserSentinel('device', 'password_verify', {
      pool: { run: async () => ({ sentinel_token: JSON.stringify(token), oai_did: 'device' }) },
    }), { code: 'VALIDATION_CONTEXT_MISMATCH' });
  }
});

for (const phase of ['create', 'poll', 'body']) {
  test(`provider cancellation interrupts an actual hanging ${phase} request`, { timeout: 5000 }, async () => {
    let arrived;
    const ready = new Promise(resolve => { arrived = resolve; });
    const server = createServer((req, res) => {
      req.resume();
      if (phase !== 'create' && req.url === '/createTask') {
        res.end(JSON.stringify({ taskId: 'fixture' })); return;
      }
      if (phase === 'body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); }
      arrived();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    try {
      const solver = new YesCaptchaSolver({ apiKey: 'fixture', endpoint: `http://127.0.0.1:${server.address().port}` });
      const work = assert.rejects(solver.solveTurnstile({ websiteUrl: 'https://fixture', websiteKey: 'fixture', signal: controller.signal }), reason);
      await ready;
      controller.abort(reason);
      await work;
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
}

test('provider cancellation during poll delay stops subsequent polls', async () => {
  const controller = new AbortController();
  let polls = 0;
  const solver = new YesCaptchaSolver({ apiKey: 'fixture', fetchImpl: async url => {
    if (url.endsWith('/createTask')) return { ok: true, json: async () => ({ taskId: 'fixture' }) };
    polls++;
    setTimeout(() => controller.abort(), 10);
    return { ok: true, json: async () => ({ status: 'processing' }) };
  } });
  await assert.rejects(solver.solveTurnstile({ websiteUrl: 'https://fixture', websiteKey: 'fixture', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(polls, 1);
});

test('total validation deadline interrupts requirements body and prevents fallback', async () => {
  let signal;
  const fetchToken = createOpenAISentinelTokenFetcher({ solveBrowserSentinel: () => assert.fail('must not start browser') });
  await assert.rejects(fetchToken(async (_url, options) => {
    signal = options.signal;
    return { ok: true, json: () => new Promise(() => {}) };
  }, 'device', 'authorize_continue', { timeoutMs: 30 }), { code: 'VALIDATION_TIMEOUT' });
  assert.equal(signal.aborted, true);
});

test('requirements transport and decoding failures are typed and redact upstream details', async () => {
  const fetchToken = createOpenAISentinelTokenFetcher();
  for (const fetcher of [async () => { throw new Error('private-proxy'); },
    async () => ({ ok: true, json: async () => { throw new Error('private-body'); } }),
    async () => ({ ok: true, json: async () => null })]) {
    await assert.rejects(fetchToken(fetcher, 'device', 'authorize_continue'), error => {
      assert.equal(error.code, 'VALIDATION_CHALLENGE_FAILED');
      assert.equal(error.stage, 'requirements');
      assert.equal(retryPolicyForFailure(classifyAuthFailure(error)).retry, false);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
  }
});

test('provider timeout reserves a remaining budget for browser fallback', async () => {
  let providerSignal;
  const fetchToken = createOpenAISentinelTokenFetcher({
    getYesCaptchaSettings: () => ({ apiKey: 'fixture', websiteKey: 'fixture', browserFallback: true }),
    solveProvider: async (_settings, _logger, options) => { providerSignal = options.signal; return new Promise(() => {}); },
    solveBrowserSentinel: async (_device, _flow, options) => {
      assert.equal(providerSignal.aborted, true);
      assert.ok(options.timeoutMs > 0 && options.timeoutMs < 200);
      assert.equal(options.signal.aborted, false);
      return 'fixture';
    },
  });
  assert.equal(await fetchToken(challenge, 'device', 'authorize_continue', { timeoutMs: 200 }), 'fixture');
});

test('parent cancellation prevents another provider or browser attempt', async () => {
  const controller = new AbortController();
  const fetchToken = createOpenAISentinelTokenFetcher({
    getYesCaptchaSettings: () => ({ apiKey: 'fixture', websiteKey: 'fixture', browserFallback: true }),
    solveProvider: async () => { controller.abort(); throw controller.signal.reason; },
    solveBrowserSentinel: () => assert.fail('must not start browser'),
  });
  await assert.rejects(fetchToken(challenge, 'device', 'authorize_continue', { signal: controller.signal }), { name: 'AbortError' });
});

test('fingerprint changes cannot reuse a different validation context', async () => {
  let calls = 0;
  const fetchToken = createOpenAISentinelTokenFetcher({ getYesCaptchaSettings: () => ({ browserFallback: true }),
    solveBrowserSentinel: async () => String(++calls) });
  await requests.run({ maps: {}, controller: new AbortController() }, async () => {
    assert.equal(await fetchToken(challenge, 'device', 'authorize_continue', { fingerprint: { userAgent: 'one' } }), '1');
    assert.equal(await fetchToken(challenge, 'device', 'authorize_continue', { fingerprint: { userAgent: 'one' } }), '1');
    assert.equal(await fetchToken(challenge, 'device', 'authorize_continue', { fingerprint: { userAgent: 'two' } }), '2');
  });
});

test('diagnostics retain fixed counters and exit reasons, never arbitrary metadata', () => {
  const metrics = createBrowserDiagnostics();
  metrics.record({ event: 'browser_disconnected', expected: false, cookie: 'private' });
  metrics.record({ event: 'browser_disconnected', expected: true });
  metrics.record({ event: 'worker_exit', exitCode: 1, signal: 'SIGTERM', reason: 'timeout', stderr: 'private' });
  metrics.record({ event: 'private' });
  metrics.record({ event: 'worker_retired', reason: 'completed', url: 'private' });
  assert.equal(metrics.snapshot().unexpectedDisconnects, 1);
  assert.equal(metrics.snapshot().counts.browser_disconnected, 2);
  assert.equal(metrics.snapshot().retirements.completed, 1);
  assert.deepEqual(metrics.snapshot().lastExit, { exitCode: 1, signal: 'SIGTERM', reason: 'timeout' });
  assert.doesNotMatch(JSON.stringify(metrics.snapshot()), /private/);
});

test('cleanup failure keeps the primary validation error and quarantines the worker', async () => {
  let finish, created = 0, stops = 0;
  const error = validationError('BROWSER_CLOSED', { stage: 'browser_navigation', attempt: 2 });
  const pool = new BrowserWorkerPool({ size: 1, cleanupTimeoutMs: 15, workerFactory: root => {
    created++;
    return { root, tasks: 0, run: async () => { throw error; },
      stop: () => { stops++; return new Promise(resolve => { finish = resolve; }); } };
  } });
  try {
    await assert.rejects(pool.run({}), current => {
      assert.equal(current, error);
      assert.equal(current.cleanupCode, 'BROWSER_CLEANUP_FAILED');
      return true;
    });
    await assert.rejects(pool.run({}), { code: 'WORKER_CLEANUP_TIMEOUT' });
    assert.equal(created, 1);
    assert.equal(stops, 1);
    assert.equal(pool.stats().diagnostics.retirements.failed, 1);
  } finally { finish(); await pool.close(); }
});

test('queue cancellation never starts a second worker and execution receives remaining budget', async () => {
  let unblock, started = 0;
  const pool = new BrowserWorkerPool({ size: 1, reuse: true, workerFactory: root => ({
    root, tasks: 0, async run(payload, options) {
      started++;
      if (payload.hang) return new Promise(resolve => { unblock = resolve; });
      assert.equal(payload.deadlineSeconds, 0.5);
      assert.equal(options.timeoutMs, 500);
      return {};
    }, async stop() {},
  }) });
  try {
    const first = pool.run({ hang: true });
    while (!unblock) await delay(1);
    const controller = new AbortController();
    const pending = assert.rejects(pool.run({}, { signal: controller.signal }), { name: 'AbortError' });
    controller.abort();
    await pending;
    assert.equal(started, 1);
    unblock({}); await first;
    await pool.run({ deadlineSeconds: 75 }, { remainingMs: () => 500 });
    assert.equal(started, 2);
  } finally { unblock?.({}); await pool.close(); }
});
