import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, access } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { port: server.address().port, release: () => new Promise(resolve => server.close(resolve)) };
}

test('Windows BAT launchers handle lifecycle, configuration, occupied ports and stale process records', {
  skip: process.platform !== 'win32', timeout: 120_000,
}, async t => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), '本地启动 & stop (test)-'));
  const statePath = path.join(fixture, 'runtime', 'local-server.json');
  const env = { ...process.env };
  for (const name of ['PORT', 'HOST', 'SKIP_DOTENV']) delete env[name];
  const launch = (action, extra = {}) => execute('cmd.exe', ['/d', '/c', `${action}.bat -NoBrowser -NoPause`], {
    cwd: fixture, env: { ...env, ...extra }, windowsHide: true, timeout: 60_000,
  });
  t.after(async () => {
    await launch('stop').catch(() => {});
    await rm(fixture, { recursive: true, force: true });
  });
  for (const relative of ['start.bat', 'stop.bat', 'scripts/local-server.ps1', 'src/config.js', 'login-service/src/config/startup-config.js']) {
    const target = path.join(fixture, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, relative), target);
  }
  await writeFile(path.join(fixture, 'package.json'), '{"type":"module","dependencies":{}}');
  // Exercise real process ownership and descendant cleanup without contacting upstream services.
  await writeFile(path.join(fixture, 'worker.js'), 'setInterval(() => {}, 1000);');
  await writeFile(path.join(fixture, 'server.js'), `
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { loadApplicationEnv } from './src/config.js';
loadApplicationEnv();
const worker = spawn(process.execPath, ['worker.js'], { windowsHide: true, stdio: 'ignore' });
fs.writeFileSync('runtime/worker.pid', String(worker.pid));
http.createServer((_req, res) => {
  res.writeHead(process.env.FIXTURE_NOT_READY ? 503 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: !process.env.FIXTURE_NOT_READY }));
}).listen(Number(process.env.PORT), process.env.HOST);
`);
  const reservation = await reservePort();
  const port = reservation.port;
  await reservation.release();
  await writeFile(path.join(fixture, '.env'), `\uFEFFexport PORT=${port} # configured port\nHOST="0.0.0.0"\n`);

  await launch('stop');
  await launch('start');
  const state = JSON.parse((await readFile(statePath, 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(state.url, `http://127.0.0.1:${port}`);
  assert.equal((await fetch(`${state.url}/api/ready`)).status, 200);
  const workerPid = Number(await readFile(path.join(fixture, 'runtime', 'worker.pid'), 'utf8'));
  await launch('start', { PORT: '1' });
  assert.equal(JSON.parse((await readFile(statePath, 'utf8')).replace(/^\uFEFF/, '')).processId, state.processId);
  await rm(statePath); // A missing state file must not orphan an otherwise identifiable instance.
  await launch('stop');
  for (const pid of [state.processId, workerPid]) {
    for (let attempt = 0; attempt < 20; attempt++) {
      try { process.kill(pid, 0); } catch { break; }
      await wait(100);
    }
    assert.throws(() => process.kill(pid, 0), `process ${pid} must be stopped`);
  }
  await assert.rejects(access(statePath));
  await launch('stop');

  // A stale record pointing at the test runner must never authorize termination.
  await writeFile(statePath, JSON.stringify({ processId: process.pid, createdAt: 'stale', projectRoot: fixture }));
  await launch('stop');
  assert.doesNotThrow(() => process.kill(process.pid, 0));

  const occupied = await reservePort();
  try {
    await assert.rejects(launch('start', { PORT: String(occupied.port) }), error => error.code === 1 && /端口/.test(error.stdout));
    await assert.rejects(access(statePath));
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  } finally { await occupied.release(); }

  // Failed readiness must remove both the server and its worker, preserving only diagnostics.
  await assert.rejects(launch('start', { FIXTURE_NOT_READY: '1' }), error => error.code === 1);
  await assert.rejects(access(statePath));
  const failedWorker = Number(await readFile(path.join(fixture, 'runtime', 'worker.pid'), 'utf8'));
  assert.throws(() => process.kill(failedWorker, 0));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/ready`));
});
