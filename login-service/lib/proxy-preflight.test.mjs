import assert from 'node:assert/strict';
import test from 'node:test';
import { preflightProxyEgress } from './proxy-preflight.js';

function fixture(transport) {
  const calls = [];
  let disposed = 0;
  const createFetch = (proxy, options) => {
    calls.push({ proxy, options });
    const fetcher = async (url, init) => {
      calls.push({ url, init });
      const response = await transport(url, init);
      Object.defineProperty(response, 'url', { value: url });
      return response;
    };
    fetcher.dispose = async () => { disposed++; };
    return fetcher;
  };
  return { calls, createFetch, disposed: () => disposed };
}

test('preflight follows OAuth with isolated cookies through the exact selected sticky proxy', async () => {
  const proxy = 'http://user-session-12345678:password@proxy.example:3000/';
  const f = fixture((url, init) => {
    const parsed = new URL(url);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal);
    assert.ok(init.timeout > 0 && init.timeout <= 15);
    if (parsed.pathname === '/oauth/authorize') {
      assert.equal(parsed.searchParams.has('login_hint'), false);
      assert.equal(new Headers(init.headers).has('cookie'), false);
      return new Response(null, { status: 302, headers: {
        location: '/api/oauth/oauth2/auth', 'set-cookie': 'probe=isolated; Secure; Path=/',
      } });
    }
    assert.match(new Headers(init.headers).get('cookie'), /probe=isolated/);
    return parsed.pathname === '/api/oauth/oauth2/auth'
      ? new Response(null, { status: 302, headers: { location: '/log-in' } })
      : new Response('login');
  });
  const result = await preflightProxyEgress(proxy, { createFetch: f.createFetch });
  assert.deepEqual(f.calls[0], { proxy, options: { direct: false } });
  assert.equal(f.calls.length, 4);
  assert.equal(result.status, 200);
  assert.ok(result.latencyMs >= 0);
  assert.equal(f.disposed(), 1);
});

test('TLS errors and blocked OAuth pages fail explicitly and always release the probe', async () => {
  for (const failure of ['tls', '403', '407']) {
    const f = fixture(() => {
      if (failure === 'tls') throw new Error('curl: (35) BoringSSL SSL_connect: Connection closed abruptly');
      return new Response('blocked', { status: Number(failure) });
    });
    await assert.rejects(preflightProxyEgress('http://user:password@proxy.example:3000', { createFetch: f.createFetch }), error => {
      assert.equal(error.code, 'PROXY_PREFLIGHT_FAILED');
      assert.equal(error.proxyEgress, true);
      assert.match(error.message, /未开始账号登录/);
      assert.doesNotMatch(error.message, /user:password/);
      assert.equal(error.status, failure === 'tls' ? 0 : Number(failure));
      return true;
    });
    assert.equal(f.calls.length, 2);
    assert.equal(f.disposed(), 1);
  }
});

test('an unrelated successful page or redirect cannot count as OAuth connectivity', async () => {
  for (const location of ['/error?detail=private', 'https://unexpected.example/log-in']) {
    const f = fixture(url => new URL(url).pathname === '/oauth/authorize'
      ? new Response(null, { status: 302, headers: { location } })
      : new Response('not a login page'));
    await assert.rejects(preflightProxyEgress('', { createFetch: f.createFetch }), { code: 'PROXY_PREFLIGHT_FAILED' });
    assert.deepEqual(f.calls[0], { proxy: '', options: { direct: true } });
    assert.ok(f.calls.slice(1).every(call => new URL(call.url).hostname === 'auth.openai.com'));
    assert.equal(f.disposed(), 1);
  }
});

test('preflight bounds the whole redirect chain and supports request cancellation', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const reason = new Error('request disconnected');
    let timer;
    const f = fixture((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      timer = setTimeout(() => { if (cancel) controller.abort(reason); }, cancel ? 10 : 1500);
    }));
    try {
      await assert.rejects(preflightProxyEgress('', {
        createFetch: f.createFetch, timeoutMs: 1000, signal: controller.signal,
      }), error => {
        if (cancel) assert.equal(error, reason);
        else {
          assert.equal(error.code, 'PROXY_PREFLIGHT_FAILED');
          assert.match(error.message, /超过 1 秒/);
        }
        return true;
      });
      assert.equal(f.disposed(), 1);
    } finally { clearTimeout(timer); }
  }
});

test('an already canceled request starts no probe', async () => {
  const signal = AbortSignal.abort(new Error('request disconnected'));
  await assert.rejects(preflightProxyEgress('', {
    signal, createFetch: () => assert.fail('must not create a transport'),
  }), /request disconnected/);
});
