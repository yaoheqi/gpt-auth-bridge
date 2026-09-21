import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ProxyAgent, fetch } from 'undici';
import { createProxyRoute } from '../lib/proxy-route.js';

async function fixture({ rejectFirst = false } = {}) {
  const sockets = new Set();
  const seen = { first: [], pool: [], target: [] };
  const track = socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    return socket;
  };
  const target = http.createServer((req, res) => {
    seen.target.push(req.headers);
    res.end('two-hop-ok');
  });
  const pool = http.createServer();
  const first = http.createServer();
  for (const server of [target, pool, first]) {
    server.on('connection', track);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  const forward = (client, head, port) => {
    const destination = track(net.connect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) destination.write(head);
      client.pipe(destination);
      destination.pipe(client);
    }));
    client.on('close', () => destination.destroy());
    destination.on('close', () => client.destroy());
  };
  pool.on('connect', (req, socket, head) => {
    seen.pool.push({ target: req.url, auth: req.headers['proxy-authorization'] });
    forward(socket, head, target.address().port);
  });
  first.on('connect', (req, socket, head) => {
    seen.first.push({ target: req.url, auth: req.headers['proxy-authorization'] });
    if (rejectFirst) { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
    forward(socket, head, pool.address().port);
  });
  return {
    seen,
    firstHop: `http://entry:entry-pass@127.0.0.1:${first.address().port}`,
    proxy: 'http://pool:pool-pass@pool.invalid:3000',
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all([target, pool, first].map(server => new Promise(resolve => server.close(resolve))));
    },
  };
}

test('pool proxy is reached only through first hop and each hop receives its own credentials', { timeout: 10000 }, async () => {
  const f = await fixture();
  let route, agent;
  try {
    route = await createProxyRoute(f.proxy, f.firstHop);
    assert.equal(new URL(route.url).hostname, '127.0.0.1');
    agent = new ProxyAgent({ uri: route.url, proxyTunnel: true });
    const response = await fetch('http://target.invalid/hello', { dispatcher: agent, signal: AbortSignal.timeout(3000) });
    assert.equal(await response.text(), 'two-hop-ok');
    assert.equal(f.seen.first[0].target, 'pool.invalid:3000');
    assert.equal(f.seen.first[0].auth, `Basic ${Buffer.from('entry:entry-pass').toString('base64')}`);
    assert.equal(f.seen.pool[0].target, 'target.invalid:80');
    assert.equal(f.seen.pool[0].auth, `Basic ${Buffer.from('pool:pool-pass').toString('base64')}`);
    assert.equal(f.seen.target[0]['proxy-authorization'], undefined);
  } finally {
    await route?.close();
    await agent?.close();
    await f.close();
  }
});

test('a rejected first hop never falls back to a direct pool connection', { timeout: 10000 }, async () => {
  const f = await fixture({ rejectFirst: true });
  let route, agent;
  try {
    route = await createProxyRoute(f.proxy, f.firstHop);
    agent = new ProxyAgent({ uri: route.url, proxyTunnel: true });
    await assert.rejects(fetch('http://target.invalid/', { dispatcher: agent, signal: AbortSignal.timeout(2000) }));
    assert.ok(f.seen.first.length > 0);
    assert.equal(f.seen.pool.length, 0);
    assert.equal(f.seen.target.length, 0);
  } finally {
    await route?.close();
    await agent?.close();
    await f.close();
  }
});

test('browser bridge uses the same first-hop chain and closes with its parent', { timeout: 10000 }, async () => {
  const f = await fixture();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/browser-proxy.mjs', import.meta.url))], {
    windowsHide: true, env: { ...process.env, PROXY_CHAIN_URL: f.firstHop }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stopped = once(child, 'exit');
  let agent;
  try {
    child.stderr.resume();
    const lines = readline.createInterface({ input: child.stdout });
    const ready = once(lines, 'line');
    child.stdin.write(JSON.stringify({ url: f.proxy }) + '\n');
    const [line] = await ready;
    assert.doesNotMatch(line, /pool-pass|entry-pass/);
    agent = new ProxyAgent({ uri: JSON.parse(line).server, proxyTunnel: true });
    const response = await fetch('http://target.invalid/', { dispatcher: agent, signal: AbortSignal.timeout(3000) });
    assert.equal(await response.text(), 'two-hop-ok');
    assert.equal(f.seen.first[0].target, 'pool.invalid:3000');
    assert.equal(f.seen.pool[0].target, 'target.invalid:80');
    child.stdin.end();
    assert.equal((await stopped)[0], 0);
  } finally {
    if (child.exitCode === null) child.kill();
    await stopped;
    await agent?.close();
    await f.close();
  }
});
