import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createProxiedFetch } from '../lib/proxy-config.js';
import { normalizeTeamCheckout, validateTeamCheckoutUrl, generateTeamCheckout } from '../src/services/team-checkout.js';

const input = { accessToken: 'fixture-token', workspaceName: '测试团队' };
const hostedUrl = 'https://checkout.stripe.com/c/pay/cs_test_fixture#details';

test('built-in checkout proxy resolves on server and never falls back when missing', () => {
  const env = { TEAM_CHECKOUT_PROXY_URL: 'builtin-user:fixture-password@proxy.example:8080' };
  const normalized = normalizeTeamCheckout({ ...input, proxyMode: 'builtin', proxyUrl: 'ignored.example:1234' }, { env });
  assert.equal(normalized.proxyUrl, 'http://builtin-user:fixture-password@proxy.example:8080/');
  assert.doesNotMatch(JSON.stringify(normalized.payload), /fixture-password|proxy.example/);
  assert.throws(() => normalizeTeamCheckout({ ...input, proxyMode: 'builtin' }, { env: {} }), /内置代理未配置/);
  assert.equal(normalizeTeamCheckout({ ...input, proxyMode: 'direct' }, { env }).proxyUrl, '');
  assert.equal(normalizeTeamCheckout({ ...input, proxyMode: 'custom', proxyUrl: 'custom.example:8080' }, { env }).proxyUrl, 'http://custom.example:8080/');
});
const fixtureJwt = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  + '.' + Buffer.from(JSON.stringify({ sub: 'fixture-user', exp: 4102444800 })).toString('base64url')
  + '.fixture-signature';

test('pasted JWT preserves its value after line wrapping, invisible characters and JSON or code wrappers', () => {
  const wrapped = fixtureJwt.match(/.{1,40}/g).join('\r\n');
  const invisible = fixtureJwt.slice(0, 24) + '\u200b\u2060\ufeff' + fixtureJwt.slice(24);
  const fence = String.fromCharCode(96).repeat(3);
  for (const accessToken of [fixtureJwt, wrapped, invisible, 'Bearer ' + wrapped,
    JSON.stringify(fixtureJwt), JSON.stringify({ accessToken: wrapped }),
    JSON.stringify({ session: { access_token: invisible } }),
    fence + '\n' + wrapped + '\n' + fence,
    fence + 'json\n' + JSON.stringify({ accessToken: fixtureJwt }, null, 2) + '\n' + fence,
    String.fromCharCode(96) + fixtureJwt + String.fromCharCode(96),
  ]) {
    const normalized = normalizeTeamCheckout({ ...input, accessToken });
    assert.equal(normalized.accessToken, fixtureJwt);
  }
});

test('pasted token validation rejects mixed content without echoing sensitive input', () => {
  for (const accessToken of ['Bearer ', 'private-value another-value', fixtureJwt + '\n' + fixtureJwt, 'Session JSON: ' + fixtureJwt]) {
    assert.throws(() => normalizeTeamCheckout({ ...input, accessToken }), error => {
      assert.equal(error.code, 'INVALID_TEAM_CHECKOUT');
      assert.doesNotMatch(error.message, /fixture-signature|private-value/);
      return true;
    });
  }
});

test('checkout payload matches the supplied script and encodes the cancellation coupon', () => {
  const { accessToken, payload } = normalizeTeamCheckout({ ...input, accessToken: 'Bearer fixture-token', coupon: 'PROMO & 特惠', existingWorkspaceId: 'workspace-fixture', seatQuantity: 3, priceInterval: 'year' });
  assert.equal(accessToken, input.accessToken);
  assert.deepEqual(payload, {
    plan_name: 'chatgptteamplan',
    team_plan_data: { workspace_name: '测试团队', price_interval: 'year', seat_quantity: 3, existing_workspace_id: 'workspace-fixture' },
    billing_details: { country: 'EG', currency: 'EGP' },
    cancel_url: 'https://chatgpt.com/?promoCode=PROMO+%26+%E7%89%B9%E6%83%A0',
    promo_code: 'PROMO & 特惠', checkout_ui_mode: 'hosted',
  });
});

test('checkout omits empty optional fields and supports actual billing settings', () => {
  const { payload } = normalizeTeamCheckout({ ...input, country: 'us', currency: 'usd' });
  assert.deepEqual(payload.billing_details, { country: 'US', currency: 'USD' });
  assert.deepEqual(payload.team_plan_data, { workspace_name: '测试团队', price_interval: 'month', seat_quantity: 2 });
  assert.equal(payload.cancel_url, 'https://chatgpt.com/');
  assert.equal(Object.hasOwn(payload, 'promo_code'), false);
});

test('checkout validates parameters before sending any upstream request', async () => {
  for (const invalid of [null, [], { ...input, accessToken: '' }, { ...input, accessToken: 'PASTE_ACCESS_TOKEN_HERE' }, { ...input, accessToken: 'token\nheader' }, { ...input, workspaceName: ' ' }, { ...input, seatQuantity: 1 }, { ...input, seatQuantity: 2.5 }, { ...input, seatQuantity: '2' }, { ...input, priceInterval: 'week' }, { ...input, country: 'USA' }, { ...input, currency: '12A' }]) {
    await assert.rejects(generateTeamCheckout(invalid, { fetchImpl: () => assert.fail('invalid input reached upstream') }), { status: 400, code: 'INVALID_TEAM_CHECKOUT' });
  }
});

test('checkout leases and disposes the shared HTTP transport for direct and custom proxy modes', async () => {
  for (const proxyMode of ['direct', 'custom']) {
    let calls = 0;
    let disposed = 0;
    const transport = async (_endpoint, options) => {
      calls += 1;
      assert.equal(options.redirect, 'manual');
      return Response.json({ url: hostedUrl });
    };
    transport.dispose = async () => { disposed += 1; };
    const result = await generateTeamCheckout({ ...input, proxyMode, proxyUrl: 'proxy.example:8080' }, {
      createProxyFetch: (proxyUrl, options) => {
        assert.equal(proxyUrl, proxyMode === 'direct' ? '' : 'http://proxy.example:8080/');
        assert.equal(options.direct, proxyMode === 'direct');
        return transport;
      },
    });
    assert.equal(result.url, hostedUrl);
    assert.equal(calls, 1);
    assert.equal(disposed, 1);
  }
});

test('checkout does not follow upstream redirects or retry with credentials', async () => {
  let calls = 0;
  await assert.rejects(generateTeamCheckout(input, { fetchImpl: async (_endpoint, options) => {
    calls += 1;
    assert.equal(options.redirect, 'manual');
    return new Response('', { status: 307, headers: { Location: 'https://untrusted.example/' } });
  } }), { code: 'CHECKOUT_REJECTED' });
  assert.equal(calls, 1);
});

test('checkout supports all three hosted link response fields without returning the token', async () => {
  for (const field of ['url', 'stripe_hosted_url', 'checkout_url']) {
    const result = await generateTeamCheckout(input, { fetchImpl: async (endpoint, options) => {
      assert.equal(endpoint, 'https://chatgpt.com/backend-api/payments/checkout');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer fixture-token');
      assert.equal(options.redirect, 'manual');
      assert.equal(JSON.parse(options.body).team_plan_data.seat_quantity, 2);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ [field]: hostedUrl, checkout_session_id: 'cs_test_fixture', secret: input.accessToken });
    } });
    assert.equal(result.url, hostedUrl);
    assert.equal(result.checkoutSessionId, 'cs_test_fixture');
    assert.doesNotMatch(JSON.stringify(result), /fixture-token|secret/);
  }
});

test('checkout rejects missing, insecure and untrusted response URLs', async () => {
  for (const value of [undefined, 'javascript:alert(1)', 'http://checkout.stripe.com/pay', 'https://example.com/pay', 'https://checkout.stripe.com.evil.example/pay', 'https://user:password@pay.openai.com/pay', 'https://pay.openai.com:444/pay']) {
    assert.throws(() => validateTeamCheckoutUrl(value), { code: 'INVALID_CHECKOUT_URL', status: 502 });
  }
  assert.equal(validateTeamCheckoutUrl('https://pay.openai.com/c/pay/test'), 'https://pay.openai.com/c/pay/test');
  await assert.rejects(generateTeamCheckout(input, { fetchImpl: async () => new Response('<html>error</html>') }), { code: 'INVALID_CHECKOUT_URL' });
});

test('checkout maps upstream errors without exposing raw responses or credentials', async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    await assert.rejects(generateTeamCheckout(input, { fetchImpl: async () => Response.json({ error: input.accessToken }, { status }) }), error => {
      assert.equal(error.code, 'CHECKOUT_REJECTED');
      assert.equal(error.status, status === 500 ? 502 : status);
      assert.match(error.message, new RegExp('HTTP ' + status));
      assert.doesNotMatch(error.message, /fixture-token/);
      return true;
    });
  }
  await assert.rejects(generateTeamCheckout(input, { fetchImpl: async () => { throw new Error(input.accessToken); } }), { code: 'CHECKOUT_NETWORK_ERROR' });
});

test('checkout propagates cancellation to upstream and does not retry', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = generateTeamCheckout(input, { signal: controller.signal, fetchImpl: async (_url, options) => {
    calls += 1;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  controller.abort();
  await assert.rejects(pending, { code: 'CHECKOUT_CANCELLED' });
  assert.equal(calls, 1);
});

test('checkout distinguishes 403 verification HTML from payment API JSON without leaking response data', async () => {
  const cases = [
    { response: new Response('<html><title>Just a moment</title>fixture-private-value</html>', { status: 403, headers: { 'Content-Type': 'text/html', 'cf-mitigated': 'challenge', server: 'cloudflare' } }), category: 'edge_challenge', format: 'html', message: /访问验证页面/ },
    { response: new Response('<html>Access denied fixture-private-value</html>', { status: 403, headers: { 'Content-Type': 'text/html' } }), category: 'html_denial', format: 'html', message: /HTML 访问拒绝页/ },
    { response: Response.json({ error: { code: 'unsupported_country_region_territory', message: 'fixture-private-value' } }, { status: 403 }), category: 'api_rejection', format: 'json', message: /地区不受支持/ },
    { response: Response.json({ error: { code: 'fixture-private-value', message: 'fixture-private-value' } }, { status: 403 }), category: 'api_rejection', format: 'json', message: /支付服务拒绝访问/ },
  ];
  for (const fixture of cases) {
    await assert.rejects(generateTeamCheckout(input, { fetchImpl: async () => fixture.response }), error => {
      assert.equal(error.code, 'CHECKOUT_REJECTED');
      assert.equal(error.diagnostics.category, fixture.category);
      assert.equal(error.diagnostics.responseFormat, fixture.format);
      assert.equal(error.diagnostics.authorizationPresent, true);
      assert.match(error.message, fixture.message);
      assert.doesNotMatch(error.message + JSON.stringify(error.diagnostics), /fixture-private-value|fixture-token/);
      return true;
    });
  }
});

test('checkout preserves a safe TLS error code and identifies proxy authentication failures', async () => {
  for (const fixture of [
    { error: new TypeError('fetch failed private-value', { cause: Object.assign(new Error('private-value'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }) }), category: 'tls_error', message: /ERR_SSL_WRONG_VERSION_NUMBER/ },
    { error: new Error('Proxy Authentication Required (407) private-value'), category: 'proxy_authentication', status: 407, message: /代理认证失败/ },
    { error: new Error('Failed to perform, curl: (7) CONNECT tunnel failed, response 403 private-value'), category: 'proxy_authentication', status: 403, message: /代理服务器拒绝认证.*HTTP 403/ },
  ]) {
    const transport = async () => { throw fixture.error; };
    transport.dispose = async () => {};
    await assert.rejects(generateTeamCheckout({ ...input, proxyMode: 'custom', proxyUrl: 'proxy.example:8080' }, { createProxyFetch: () => transport }), error => {
      assert.equal(error.code, 'CHECKOUT_NETWORK_ERROR');
      assert.equal(error.diagnostics.category, fixture.category);
      assert.equal(error.diagnostics.upstreamStatus, fixture.status);
      assert.equal(error.diagnostics.proxyConfigured, true);
      assert.match(error.message, fixture.message);
      assert.doesNotMatch(error.message + JSON.stringify(error.diagnostics), /private-value|fixture-token|proxy.example/);
      return true;
    });
  }
});

test('checkout accepts Session JSON and extracts a coupon from a full URL', () => {
  const normalized = normalizeTeamCheckout({ ...input, accessToken: JSON.stringify({ accessToken: 'Bearer fixture-token', user: { email: 'fixture@example.com' } }), coupon: 'https://chatgpt.com/?promoCode=FIXTURE%26PROMO' });
  assert.equal(normalized.accessToken, 'fixture-token');
  assert.equal(normalized.payload.promo_code, 'FIXTURE&PROMO');
  for (const accessToken of ['{"accessToken":', '{"user":{}}', '{"accessToken":12}']) {
    assert.throws(() => normalizeTeamCheckout({ ...input, accessToken }), { code: 'INVALID_TEAM_CHECKOUT' });
  }
  assert.throws(() => normalizeTeamCheckout({ ...input, coupon: 'https://chatgpt.com/' }), { code: 'INVALID_TEAM_CHECKOUT' });
});

test('checkout accepts custom proxy formats and keeps proxy credentials out of the checkout payload', () => {
  for (const [proxyUrl, expected] of [
    ['proxy.example:8080:fixture-user:p@ss:word', 'http://fixture-user:p%40ss%3Aword@proxy.example:8080/'],
    ['http://user:password@proxy.example:8080', 'http://user:password@proxy.example:8080/'],
    ['https://proxy.example:8443', 'https://proxy.example:8443/'],
    ['socks5://user:password@proxy.example:1080', 'socks5://user:password@proxy.example:1080'],
    ['socks5h://proxy.example:1080', 'socks5h://proxy.example:1080'],
  ]) {
    const normalized = normalizeTeamCheckout({ ...input, proxyMode: 'custom', proxyUrl });
    assert.equal(normalized.proxyUrl, expected);
    assert.doesNotMatch(JSON.stringify(normalized.payload), /proxy|password|p%40ss/);
  }
  assert.equal(normalizeTeamCheckout({ ...input, proxyMode: 'direct', proxyUrl: 'invalid-unused-proxy' }).proxyUrl, '');
  for (const proxyUrl of ['', 'proxy.example', 'ftp://proxy.example:21', 'socks4://proxy.example:1080', 'http://proxy.example:8080/path', 'http://proxy.example:8080?secret=fixture', 'http://proxy.example:8080\nhttp://second.example:8080']) {
    assert.throws(() => normalizeTeamCheckout({ ...input, proxyMode: 'custom', proxyUrl }), { code: 'INVALID_TEAM_CHECKOUT' });
  }
});

test('custom proxy failures dispose the transport and never fall back to direct requests', async () => {
  let disposed = 0;
  const transport = async () => { throw new Error('http://user:private-password@proxy.example:8080'); };
  transport.dispose = async () => { disposed += 1; };
  await assert.rejects(generateTeamCheckout({ ...input, proxyMode: 'custom', proxyUrl: 'proxy.example:8080' }, {
    createProxyFetch: () => transport,
    fetchImpl: () => assert.fail('proxy failure must not fall back to direct'),
  }), error => {
    assert.equal(error.code, 'CHECKOUT_NETWORK_ERROR');
    assert.doesNotMatch(error.message, /private-password|proxy.example/);
    assert.match(error.message, /代理连接失败/);
    return true;
  });
  assert.equal(disposed, 1);
});

test('checkout travels through an authenticated local HTTP proxy and releases its transport', { timeout: 10000 }, async context => {
  const sockets = new Set();
  const seen = { connections: [], requests: [] };
  const upstream = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    seen.requests.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ url: hostedUrl }));
  });
  const proxy = http.createServer();
  for (const server of [upstream, proxy]) server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([upstream, proxy].map(server => new Promise(resolve => server.close(resolve))));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const destination = '127.0.0.1:' + upstream.address().port;
  proxy.on('request', (request, response) => {
    const target = new URL(request.url);
    if (target.host !== destination) { response.writeHead(502).end(); return; }
    seen.connections.push({ target: target.host, authorization: request.headers['proxy-authorization'] });
    const headers = { ...request.headers };
    delete headers['proxy-authorization'];
    const forwarded = http.request(target, { method: request.method, headers }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    forwarded.on('error', () => response.destroy());
    request.pipe(forwarded);
  });
  proxy.on('connect', (request, client, head) => {
    seen.connections.push({ target: request.url, authorization: request.headers['proxy-authorization'] });
    if (request.url !== destination) return client.destroy();
    const remote = net.connect(upstream.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      client.pipe(remote);
      remote.pipe(client);
    });
    sockets.add(remote);
    remote.on('close', () => sockets.delete(remote));
    remote.on('error', () => client.destroy());
    client.on('error', () => remote.destroy());
    client.on('close', () => remote.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  let disposed = false;
  const result = await generateTeamCheckout({ ...input, proxyMode: 'custom', proxyUrl: '127.0.0.1:' + proxy.address().port + ':fixture-user:fixture-password' }, {
    fetchImpl: () => assert.fail('custom proxy must not use direct fetch'),
    createProxyFetch: proxyUrl => {
      const transport = createProxiedFetch(proxyUrl);
      const routed = (endpoint, options) => {
        assert.equal(endpoint, 'https://chatgpt.com/backend-api/payments/checkout');
        return transport('http://' + destination + '/checkout-fixture', options);
      };
      routed.dispose = async () => { await transport.dispose(); disposed = true; };
      return routed;
    },
  });
  assert.equal(result.url, hostedUrl);
  assert.equal(disposed, true);
  assert.equal(seen.connections.length, 1);
  assert.equal(seen.connections[0].target, destination);
  assert.equal(seen.connections[0].authorization, 'Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64'));
  assert.equal(seen.requests[0].authorization, 'Bearer fixture-token');
  assert.equal(seen.requests[0].body.plan_name, 'chatgptteamplan');
  assert.doesNotMatch(JSON.stringify(result), /fixture-user|fixture-password|fixture-token/);
});
