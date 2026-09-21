import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

async function startApp(runtime, overrides = {}) {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const env = {
    ...process.env, SKIP_DOTENV: '1', NODE_ENV: 'development', CONTAINER: 'false',
    HOST: '127.0.0.1', PORT: String(port), RUNTIME_DIR: runtime,
    OPENAI_PROXY_URL: '', APP_PROXY_POOL: '', SUB2API_BASE_URL: '', SUB2API_ADMIN_API_KEY: '',
    ...overrides,
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const stopped = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await stopped;
  };
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        const response = await fetch(`${url}/api/ready`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) return { url, stop, child };
      } catch {}
      await delay(100);
    }
    throw new Error(`Application did not become ready: ${output}`);
  } catch (error) {
    await stop();
    throw error;
  }
}

test('one entrypoint serves the UI, canonical/legacy APIs, SSE and browser-owned records', { timeout: 60000 }, async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'unified-app-'));
  let app;
  try {
    app = await startApp(runtime, { TASK_CONCURRENCY: '3', SENTINEL_BROWSER_CONCURRENCY: '1' });
    const page = await fetch(`${app.url}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /会话转换工作台/);
    assert.equal((await fetch(`${app.url}/login`)).status, 404);
    assert.equal((await fetch(`${app.url}/auth.html`)).status, 404);
    assert.equal((await fetch(`${app.url}/portal.css`)).status, 404);
    for (const asset of ['app.js', 'app.css', 'browser-store.js', 'login-account-format.js']) {
      assert.equal((await fetch(`${app.url}/${asset}`)).status, 200);
    }
    const metrics = await (await fetch(`${app.url}/api/system/metrics`)).json();
    assert.equal(metrics.ok, true);
    assert.ok(metrics.http.requests > 0);
    assert.equal(typeof metrics.workers.queued, 'number');
    assert.equal(metrics.workers.min, 3);
    assert.equal(metrics.workers.max, 3);
    assert.equal(metrics.workers.workers, 3);
    assert.equal(metrics.workers.running, 3);
    assert.equal(metrics.workers.leased, 0);
    assert.equal(metrics.tasks.limit, 3);
    assert.equal(metrics.browsers.limit, 3);
    assert.equal((await (await fetch(`${app.url}/api/system/config`)).json()).taskConcurrency, 3);
    const alias = await fetch(`${app.url}/yy4399`, { redirect: 'manual' });
    assert.equal(alias.headers.get('location'), '/');
    for (const prefix of ['', '/api/login-icloud']) {
      const response = await fetch(`${app.url}${prefix}/api/v2/admin/protocol/settings`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
    }
    const health = await fetch(`${app.url}/api/session-health`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"accounts":[]}',
    });
    assert.equal(health.status, 200);
    const healthResult = await health.json();
    assert.deepEqual(healthResult.results, []);
    assert.equal(healthResult.concurrency, 3);
    for (const route of ['session-health', 'logout-all-sessions']) {
      for (const [requested, expected] of [[1, 3], [23, 3], [99, 3], [0, 3]]) {
        const response = await fetch(`${app.url}/api/${route}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accounts: [], concurrency: requested }),
        });
        assert.equal((await response.json()).concurrency, expected);
      }
    }
    const malformed = await fetch(`${app.url}/api/session-health`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    });
    assert.equal(malformed.status, 400);
    const stream = await fetch(`${app.url}/api/v2/system/stream-probe`, { method: 'POST' });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader();
    let first = '';
    while (!first.includes('event: probe')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      first += new TextDecoder().decode(chunk.value);
    }
    assert.match(first, /stream-probe-1/);
    assert.doesNotMatch(first, /event: summary/);
    let remaining = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      remaining += new TextDecoder().decode(value);
    }
    assert.match(remaining, /event: summary/);
    const imported = await fetch(`${app.url}/api/v2/accounts/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'fixture@example.com----FixturePassword!----JBSWY3DPEHPK3PXP', browserState: { accounts: [], settings: { appSettings: { oauthBatchConcurrency: 30 } } } }),
    });
    assert.equal(imported.status, 200);
    const importedBody = await imported.json();
    assert.equal(importedBody.imported, 1);
    assert.equal(importedBody.browserState.accounts[0].email, 'fixture@example.com');
    assert.equal(importedBody.browserState.accounts[0].password, 'FixturePassword!');
    assert.equal(importedBody.browserState.settings.appSettings, undefined);
    const fixedPipeline = await (await fetch(`${app.url}/api/v2/accounts/protocol-login-pipeline`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: importedBody.rows.map(row => row.id), concurrency: 30, browserState: {
        accounts: importedBody.browserState.accounts.map(account => ({ ...account, password: '', two_factor_secret: '' })),
        settings: { appSettings: { oauthBatchConcurrency: 30 } },
      } }),
    })).json();
    assert.equal(fixedPipeline.concurrency, 3);
    assert.equal(fixedPipeline.failed, 1); // Missing credentials stop before upstream traffic.
    const resultTimings = fixedPipeline.results[0].timings;
    assert.ok(resultTimings.queue.durationMs >= 0);
    assert.ok(resultTimings.total.durationMs >= 0);
    assert.equal(resultTimings.total.failures, 1);
    const timedStream = await fetch(`${app.url}/api/v2/accounts/protocol-login-pipeline`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ ids: importedBody.rows.map(row => row.id), stream: true, browserState: {
        accounts: importedBody.browserState.accounts.map(account => ({ ...account, password: '', two_factor_secret: '' })),
      } }),
    });
    const timedEvents = (await timedStream.text()).trim().split(/\r?\n\r?\n/)
      .filter(event => event.startsWith('event:')).map(event => ({
        name: event.split('\n')[0].slice(7).trim(),
        data: JSON.parse(event.split('\n').find(line => line.startsWith('data:')).slice(5)),
      }));
    assert.ok(timedEvents.some(event => event.name === 'account_timing' && event.data.stage === 'total'));
    assert.equal(timedEvents.find(event => event.name === 'account_done').data.timings.total.failures, 1);
    const timedMetrics = await (await fetch(`${app.url}/api/system/metrics`)).json();
    assert.equal(timedMetrics.timingSampleLimit, 512);
    assert.equal(timedMetrics.stageTimings.total.count, 2);
    assert.equal(timedMetrics.stageTimings.total.failures, 2);
    assert.ok(timedMetrics.stageTimings.queue.count >= 2);
    assert.doesNotMatch(JSON.stringify(timedMetrics), /fixture@example\.com|FixturePassword|JBSWY3DPEHPK3PXP/);
    const retained = await (await fetch(`${app.url}/api/v2/sot`)).json();
    assert.equal(retained.data.accountCount, 0);
    const ids = importedBody.rows.map(row => row.id);
    const browserState = importedBody.browserState;
    Object.assign(browserState.accounts[0], {
      session_access_token: 'fixture-session',
      session_json: JSON.stringify({ accessToken: 'fixture-session', user: { email: 'fixture@example.com' } }),
    });
    const exported = await fetch(`${app.url}/api/v2/accounts/export-sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids, browserState, aliveOnly: false, download: true }),
    });
    assert.equal(exported.status, 200);
    assert.match(await exported.text(), /fixture-session/);
    const stranger = await fetch(`${app.url}/api/v2/accounts/export-sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids, aliveOnly: false, download: true }),
    });
    assert.doesNotMatch(await stranger.text(), /fixture-session/);
    assert.equal((await fetch(`${app.url}/api/v2/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 410);
    const settings = await fetch(`${app.url}/api/v2/admin/sub2api/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://fixture.invalid', adminApiKey: 'private-browser-key', groupIds: [1] }),
    });
    assert.equal(settings.status, 200);
    const otherSettings = await (await fetch(`${app.url}/api/v2/admin/sub2api/settings`)).json();
    assert.equal(otherSettings.settings.keyConfigured, false);
    await delay(100);
    await app.stop();
    assert.deepEqual(await readdir(runtime), []);
    app = await startApp(runtime);
    const state = await (await fetch(`${app.url}/api/v2/sot`)).json();
    assert.equal(state.data.accountCount, 0);
    assert.equal(state.data.sot, 'browser');
    assert.equal(state.data.sqlitePath, null);
  } finally {
    await app?.stop();
    await rm(runtime, { recursive: true, force: true });
  }
});
