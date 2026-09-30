import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { createProxiedFetch, resolveSessionProxy } from '../lib/proxy-config.js';
import { createAuthNetworkPolicy } from '../src/services/auth/network-policy.js';

// A local SOCKS5 peer verifies the actual wire protocol, including RFC 1929
// authentication. No provider credentials or external network are needed.
async function socksFixture() {
  const sockets = new Set();
  const seen = { credentials: [], destinations: [], requests: [] };
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let stage = 'greeting';
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (stage === 'greeting') {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
          buffer = buffer.subarray(2 + buffer[1]);
          socket.write(Buffer.from([5, 2]));
          stage = 'auth';
        } else if (stage === 'auth') {
          if (buffer.length < 2) return;
          const userEnd = 2 + buffer[1];
          if (buffer.length <= userEnd) return;
          const end = userEnd + 1 + buffer[userEnd];
          if (buffer.length < end) return;
          seen.credentials.push([buffer.subarray(2, userEnd).toString(), buffer.subarray(userEnd + 1, end).toString()]);
          buffer = buffer.subarray(end);
          socket.write(Buffer.from([1, 0]));
          stage = 'connect';
        } else if (stage === 'connect') {
          if (buffer.length < 5) return;
          if (buffer[3] !== 3) { socket.destroy(); return; }
          const end = 5 + buffer[4] + 2;
          if (buffer.length < end) return;
          seen.destinations.push(buffer.subarray(5, end - 2).toString());
          buffer = buffer.subarray(end);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
          stage = 'http';
        } else {
          if (!buffer.includes('\r\n\r\n')) return;
          seen.requests.push(buffer.toString());
          buffer = Buffer.alloc(0);
          socket.end('HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nsocks-ok');
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { seen, port: server.address().port, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}

for (const mode of ['pool']) {
  for (const scheme of ['socks5', 'socks5h']) {
    test(`${mode} pool connects using authenticated ${scheme} and preserves session credentials`, { timeout: 10000 }, async () => {
      const fixture = await socksFixture();
      let fetch;
      try {
        const username = 'fixture-region-US-sid-example-t-10';
        const password = 'test:p@ss%word';
        const proxy = `${scheme}://${username}:${encodeURIComponent(password)}@127.0.0.1:${fixture.port}`;
        const policy = createAuthNetworkPolicy();
        const network = policy.protocolRequestNetwork({ proxyMode: mode, ...(mode === 'pool' ? { proxyPool: `\n${proxy}\n` } : {}) });
        const accountNetwork = policy.accountRequestNetwork({}, network);
        const selected = resolveSessionProxy({ pool: accountNetwork.proxyPool });
        assert.equal(selected.proxyUrl, proxy);
        fetch = createProxiedFetch(selected.proxyUrl);
        const response = await fetch('http://destination.invalid/check', { signal: AbortSignal.timeout(3000) });
        assert.equal(await response.text(), 'socks-ok');
        assert.deepEqual(fixture.seen.credentials, [[username, password]]);
        assert.deepEqual(fixture.seen.destinations, ['destination.invalid']);
        assert.doesNotMatch(fixture.seen.requests[0], /proxy-authorization/i);
      } finally {
        await fetch?.dispose();
        await fixture.close();
      }
    });
  }
}
