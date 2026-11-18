import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { channel } from 'node:diagnostics_channel';
import {
  FIXED_LOCAL_PROXY_URL,
  createProxiedFetch,
  isInitialAuthEgressBlock,
  looksLikeCloudflareBlock,
  maskProxyUrl,
  normalizeProxyUrl,
  parseProxyPool,
  resolveSessionProxy,
} from './proxy-config.js';

test('environment proxy pools never become implicit egress', () => {
  const env = { OPENAI_BUILT_IN_PROXY_POOL: 'proxy.example:3000:fixture-user:fixture-password' };
  assert.equal(resolveSessionProxy({ env }).mode, 'direct');
  assert.equal(resolveSessionProxy({ env, pool: 'proxy.example:3000:fixture-user:fixture-password' }).mode, 'pool');
});

test('resolveSessionProxy selects from configured pool', () => {
  const resolved = resolveSessionProxy({ pool: 'http://remote.example:8080' });
  assert.deepEqual(resolved, {
    proxyUrl: 'http://remote.example:8080/',
    sessionId: '',
    mode: 'pool',
    label: 'http://remote.example:8080/',
  });
});

test('removed environment pools never supply an implicit proxy', () => {
  const env = {
    APP_PROXY_POOL: 'socks5://legacy.example:1080',
    PROXY_POOL: 'http://alias.example:8080',
    OPENAI_BUILT_IN_PROXY_POOL: 'socks5://builtin.example:1080',
  };
  assert.equal(resolveSessionProxy({ env }).mode, 'direct');
  assert.equal(resolveSessionProxy({ env, pool: '' }).mode, 'direct');
  assert.equal(resolveSessionProxy({ env, pool: 'socks5://custom.example:1080' }).proxyUrl, 'socks5://custom.example:1080');
  assert.equal(resolveSessionProxy({ env, pool: 'socks5://builtin.example:1080' }).proxyUrl, 'socks5://builtin.example:1080');
  assert.equal(resolveSessionProxy({ env: { ...env, OPENAI_PROXY_URL: 'http://fixed.example:8080' } }).mode, 'local');
});

test('request-scoped empty proxy pool can explicitly select direct egress', () => {
  assert.deepEqual(resolveSessionProxy({ pool: '', env: {}, directWhenEmpty: true }), {
    proxyUrl: '', sessionId: '', mode: 'direct', label: '直连',
  });
  assert.equal(resolveSessionProxy({ pool: '', env: {} }).proxyUrl, FIXED_LOCAL_PROXY_URL);
});

test('maskProxyUrl removes credentials', () => {
  assert.equal(maskProxyUrl('socks5://user:secret@remote.example:1080'), 'socks5://remote.example:1080');
  assert.equal(maskProxyUrl(''), FIXED_LOCAL_PROXY_URL);
});

test('createProxiedFetch uses supplied URL or local fallback', async () => {
  const empty = createProxiedFetch('');
  const remote = createProxiedFetch('http://user:pass@remote.example:1080');
  assert.equal(empty.proxyUrl, FIXED_LOCAL_PROXY_URL);
  assert.equal(remote.proxyUrl, 'http://user:pass@remote.example:1080/');
  await Promise.all([empty.dispose(), remote.dispose()]);
});

test('model request transport applies the selected header and body limits on direct and proxied requests', async () => {
  const local = createServer((_req, res) => res.end('ok'));
  local.on('connect', (_req, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'));
  });
  local.listen(0, '127.0.0.1');
  await once(local, 'listening');
  const url = `http://127.0.0.1:${local.address().port}`;
  const requests = [];
  const events = channel('undici:request:create');
  const capture = ({ request }) => {
    if (request.method === 'GET') requests.push([request.headersTimeout, request.bodyTimeout]);
  };
  events.subscribe(capture);
  try {
    for (const proxy of ['', url]) {
      const transport = createProxiedFetch(proxy, { upstreamTimeoutMs: 1_200_000 });
      try {
        const response = await transport(proxy ? 'http://model.invalid/test' : url);
        assert.equal(await response.text(), 'ok');
      } finally {
        await transport.dispose();
      }
    }
    assert.deepEqual(requests, [[1_200_000, 1_200_000], [1_200_000, 1_200_000]]);
  } finally {
    events.unsubscribe(capture);
    local.closeAllConnections();
    await new Promise(resolve => local.close(resolve));
  }
});

test('normalizes all supported proxy formats', () => {
  const expected = 'http://user:pass@proxy.example:1080/';
  assert.equal(normalizeProxyUrl('proxy.example:1080:user:pass'), expected);
  assert.equal(normalizeProxyUrl('user:pass@proxy.example:1080'), expected);
  assert.equal(normalizeProxyUrl('proxy.example:1080@user:pass'), expected);
  assert.equal(normalizeProxyUrl('socks5://user:pass@proxy.example:1080'), 'socks5://user:pass@proxy.example:1080');
  assert.equal(parseProxyPool('one.example:80;two.example:81').length, 2);
});

test('refreshes expired rotating proxy sessions on selection', () => {
  const result = resolveSessionProxy({
    pool: 'proxy.example:10000:user-zone-x-session-12345678-sessTime-5:pass',
    env: { APP_PROXY_STICKY_MINUTES: '30' },
  });
  assert.match(result.proxyUrl, /session-\d{8}/);
  assert.match(result.proxyUrl, /sessTime-30/);
  assert.doesNotMatch(result.proxyUrl, /session-12345678/);
});

test('keeps a preselected rotating proxy session unchanged across workflow phases', () => {
  const proxy = 'http://user-session-12345678-sessTime-30:pass@proxy.example:10000/';
  assert.equal(resolveSessionProxy({ pool: proxy, env: {}, refreshSession: false }).proxyUrl, proxy);
});

test('createProxiedFetch uses direct egress by default', async () => {
  const first = createProxiedFetch('', { isolated: true });
  const second = createProxiedFetch('', { isolated: true });
  assert.equal(first.proxyUrl, '');
  assert.equal(second.proxyUrl, '');
  assert.equal(first.dispatcher, null);
  assert.equal(second.dispatcher, null);
  assert.equal(first.isolated, true);
  await Promise.all([first.dispose(), second.dispose()]);
});

test('Cloudflare block detection remains available for fixed egress failures', () => {
  assert.equal(looksLikeCloudflareBlock({ status: 200 }), false);
  assert.equal(looksLikeCloudflareBlock({ status: 403, body: 'Sorry, you have been blocked' }), true);
  assert.equal(isInitialAuthEgressBlock({ status: 403, body: '{}' }), true);
  assert.equal(isInitialAuthEgressBlock({ status: 401, body: '{}' }), false);
});
