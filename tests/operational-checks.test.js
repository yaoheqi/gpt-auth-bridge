import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { checkSensitivePaths } from '../scripts/check-sensitive-paths.mjs';
import { createRuntimeDependencyCheck } from '../login-service/src/services/runtime-dependencies.js';
import { createOperationalMetrics } from '../login-service/src/services/operational-metrics.js';
import { createApp } from '../login-service/src/app/create-app.js';
import { startServer } from '../login-service/src/start-server.js';
import { CurlCffiWorkerPool } from '../login-service/lib/curl-cffi-fetch.js';

const execute = promisify(execFile);

test('secret checks ignore local ignored configuration but reject tracked secrets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sensitive-scan-'));
  const git = args => execute('git', args, { cwd: root, windowsHide: true });
  try {
    await git(['init', '--quiet']);
    await writeFile(path.join(root, '.gitignore'), '.env\n');
    await writeFile(path.join(root, '.env'), 'OPENAI_PROXY_URL=');
    assert.deepEqual(await checkSensitivePaths(root), []);
    await git(['add', '-f', '.env']);
    assert.ok((await checkSensitivePaths(root)).some(item => item.path === '.env'));
    await writeFile(path.join(root, 'app.js'), 'const password = "not-a-real-but-detected-credential";');
    const findings = await checkSensitivePaths(root);
    assert.ok(findings.some(item => item.path === 'app.js' && item.reason === 'inline secret-like value'));
    assert.doesNotMatch(JSON.stringify(findings), /detected-credential/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dependency checks share in-flight work, cache failures and recover after expiry', async () => {
  let calls = 0;
  let timestamp = 0;
  let fail = true;
  const check = createRuntimeDependencyCheck({ now: () => timestamp, cacheMs: 10, run: async () => {
    calls++;
    if (fail) throw new Error('fixture-internal-detail');
    return { stdout: JSON.stringify({ chromium: true, curl_cffi: 'fixture', playwright: 'fixture' }) };
  } });
  const results = await Promise.allSettled([check(), check()]);
  assert.equal(calls, 1);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.doesNotMatch(results[0].reason.message, /fixture-internal-detail/);
  await assert.rejects(check());
  assert.equal(calls, 1);
  timestamp = 11;
  fail = false;
  assert.equal((await check()).chromium, true);
  assert.equal(calls, 2);
});

test('operational metrics count each request once and retain no user fields', () => {
  const metrics = createOperationalMetrics();
  const res = new EventEmitter();
  res.statusCode = 500;
  metrics.middleware({ path: '/api/private@example.com', body: { password: 'fixture-secret' } }, res, () => {});
  assert.equal(metrics.snapshot().active, 1);
  res.emit('finish');
  res.emit('close');
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.active, 0);
  assert.equal(snapshot.completed, 1);
  assert.equal(snapshot.errors, 1);
  assert.equal(snapshot.errorRate, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|password|fixture-secret/);
});

test('shutdown closes stalled streams within its deadline', async () => {
  const app = createApp();
  app.get('/stall', (_req, res) => { res.writeHead(200); res.write('waiting'); });
  const runtime = await startServer({ app, port: 0, installSignalHandlers: false, shutdownTimeoutMs: 30 });
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.server.address().port}/stall`);
    const body = response.text().catch(() => 'closed');
    await runtime.close();
    assert.equal(await body, 'closed');
    assert.equal(runtime.server.listening, false);
  } finally { await runtime.close(); }
});

test('shutdown rejects queued HTTP workers and kills leased children', async () => {
  let killed = 0;
  const pool = new CurlCffiWorkerPool(1, { workerFactory: () => ({ leased: false, kill() { killed++; }, async reset() {} }) });
  await pool.acquire();
  const queued = pool.acquire();
  pool.close();
  await assert.rejects(queued, /disposed/);
  await assert.rejects(pool.acquire(), /disposed/);
  assert.equal(pool.stats().queued, 0);
  assert.equal(killed, 1);
});
