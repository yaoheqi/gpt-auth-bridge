import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSessionHealth, logoutAllSessions, withSessionTransport, probeBusinessOffer } from '../src/session-network.js';

const account = { accessToken: 'fixture-access-token' };
const usage = () => Response.json({ rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } } });

test('business offer uses the selected transport and detected country without Plus trial requests', async () => {
  for (const country of ['US', 'DE', 'JP']) {
    const urls = [];
    let disposed = false;
    const fetchImpl = async (url, init) => {
      urls.push(url);
      if (url.includes('/cdn-cgi/trace')) {
        assert.deepEqual(init.headers, { Accept: 'text/plain' });
        return new Response(`ip=192.0.2.1\nloc=${country}\n`);
      }
      assert.equal(init.headers.Authorization, `Bearer ${account.accessToken}`);
      if (url.includes('/wham/usage')) return usage();
      assert.ok(url.endsWith(`/configs/${country}`));
      return Response.json({ country_code: country, currency_config: {
        symbol_code: 'USD', business: { month: { amount: 0 } },
      } });
    };
    fetchImpl.dispose = async () => { disposed = true; };
    const result = await withSessionTransport(options => checkSessionHealth({ ...account, accountId: 'selected' }, { ...options, includeBusinessOffer: true }), {
      resolveProxy: () => ({ proxyUrl: 'http://selected-proxy:8080' }),
      createFetch: proxy => { assert.equal(proxy, 'http://selected-proxy:8080'); return fetchImpl; },
    });
    assert.equal(result.businessOffer.eligible, true);
    assert.equal(result.businessOffer.country, country);
    assert.equal(result.status, 200);
    assert.equal(urls.length, 3);
    assert.ok(urls.every(url => !url.includes('/accounts/check') && !url.includes('/promotions/')));
    assert.equal(disposed, true);
  }
});

test('business offer derives a missing account header from the access token', async () => {
  const accountId = 'account-from-token';
  const accessToken = `header.${Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url')}.signature`;
  const result = await probeBusinessOffer({ accessToken }, { fetchImpl: async (url, init) => {
    if (url.includes('/cdn-cgi/trace')) {
      assert.deepEqual(init.headers, { Accept: 'text/plain' });
      return new Response('loc=US\n');
    }
    assert.equal(init.headers.Authorization, `Bearer ${accessToken}`);
    assert.equal(init.headers['chatgpt-account-id'], accountId);
    return Response.json({ currency_config: { business: { month: { amount: 25 } } } });
  } });
  assert.equal(result.eligible, false);
});

test('unavailable geo lookup never falls back to a fixed country or changes account health', async () => {
  const urls = [];
  const result = await checkSessionHealth(account, { includeBusinessOffer: true, fetchImpl: async url => {
    urls.push(url);
    return url.includes('/wham/usage') ? usage() : new Response('invalid trace');
  } });
  assert.equal(result.status, 200);
  assert.equal(result.businessOffer.eligible, null);
  assert.equal(result.businessOffer.country, '');
  assert.ok(result.businessOffer.error);
  assert.equal(urls.length, 2);
});

test('business offer eligibility follows the monthly pricing amount without treating missing values as zero', async () => {
  for (const fixture of [
    { amount: 0, expected: true, normalizedAmount: 0 },
    { amount: 25, expected: false, normalizedAmount: 25 },
    { amount: '0', expected: true, normalizedAmount: 0 },
    { amount: null, expected: null, normalizedAmount: null },
    { amount: 'invalid', expected: null, normalizedAmount: null },
    { missing: true, expected: null, normalizedAmount: null },
  ]) {
    const result = await probeBusinessOffer({ ...account, accountId: 'selected' }, { fetchImpl: async url => {
      if (url.includes('/cdn-cgi/trace')) return new Response('loc=US\n');
      return Response.json({ currency_config: fixture.missing ? {} : { business: { month: { amount: fixture.amount } } } });
    } });
    assert.equal(result.eligible, fixture.expected);
    assert.equal(result.monthlyAmount, fixture.normalizedAmount);
    assert.equal(Boolean(result.error), fixture.expected === null);
  }
});

test('business offer is skipped for unhealthy accounts', async () => {
  let calls = 0;
  const result = await checkSessionHealth(account, { includeBusinessOffer: true, fetchImpl: async () => { calls++; return new Response('', { status: 401 }); } });
  assert.equal(result.businessOffer, null);
  assert.equal(calls, 1);
});

test('token-only health with usage uses a single upstream request', async () => {
  let calls = 0;
  const result = await checkSessionHealth(account, { includeUsage: true, fetchImpl: async () => { calls++; return usage(); } });
  assert.equal(calls, 1);
  assert.equal(result.status, 200);
  assert.equal(result.usage.fiveHour.usedPercent, 25);
});

test('reset credits use the detail count, then available Codex cards, then the usage summary', async () => {
  const cards = [
    { reset_type: 'CODEX_RATE_LIMITS', status: 'available', id: 'private-card' },
    { resetType: 'codex_rate_limits' }, null,
    { status: 'redeemed' }, { reset_type: 'other', status: 'available' },
  ];
  for (const [detail, summary, expected] of [
    [{ available_count: 0, credits: cards }, 7, 0],
    [{ availableCount: ' 3 ', credits: 'malformed' }, undefined, 3],
    [{ credits: [] }, 7, 0], [cards, 7, 2],
    [{ available_count: -1, items: cards }, 7, 2],
    [{ data: cards }, 7, 2], [{ rate_limit_reset_credits: cards }, 7, 2],
    [{ available_count: false }, 7, 7], [{ credits: 'malformed' }, '0', 0],
    [{ available_count: '2.7' }, undefined, null], [{}, undefined, null],
  ]) {
    const paths = [];
    const result = await checkSessionHealth({ ...account, accountId: 'workspace' }, {
      includeUsage: true, includeResetCredits: true,
      fetchImpl: async (url, init) => {
        const path = new URL(url).pathname;
        paths.push(path);
        assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
        assert.equal(init.headers['chatgpt-account-id'], 'workspace');
        if (path.endsWith('/usage')) return Response.json({ rate_limit_reset_credits: { available_count: summary } });
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'manual');
        return Response.json(detail);
      },
    });
    assert.deepEqual(paths, ['/backend-api/wham/usage', '/backend-api/wham/rate-limit-reset-credits']);
    assert.equal(result.resetCreditCount, expected);
    assert.equal(result.status, 200);
    assert.doesNotMatch(JSON.stringify(result), /private-card|fixture-access-token/);
  }
});

test('a reset credit detail failure leaves account health and device results intact', async () => {
  for (const failedDetail of [() => new Response('', { status: 403 }), () => new Response('invalid'), () => { throw new Error('network'); }]) {
    const result = await checkSessionHealth({ ...account, cookie: 'fixture-only' }, {
      includeUsage: true, includeDevices: true, includeResetCredits: true, fetchImpl: async url => {
        if (url.endsWith('/me')) return Response.json({});
        if (url.endsWith('/sessions')) return Response.json({ devices: [] });
        if (url.endsWith('/usage')) return Response.json({ rate_limit: {}, rate_limit_reset_credits: { available_count: 4 } });
        return failedDetail();
      },
    });
    assert.equal(result.resetCreditCount, 4);
    assert.equal(result.usageStatus, 200);
    assert.equal(result.deviceCount, 0);
    assert.equal(result.status, 200);
  }
  const unhealthy = await checkSessionHealth(account, { includeResetCredits: true, fetchImpl: async url => {
    assert.ok(url.endsWith('/usage'));
    return new Response('', { status: 401 });
  } });
  assert.equal(unhealthy.status, 401);
  assert.equal(unhealthy.resetCreditCount, null);
});

test('OAuth probes preserve a deactivated error code without exposing the upstream payload', async () => {
  const result = await checkSessionHealth(account, { fetchImpl: async () => Response.json({ error: { code: 'account_deactivated', message: 'private detail' } }, { status: 401 }) });
  assert.equal(result.code, 'account_deactivated');
  assert.doesNotMatch(JSON.stringify(result), /private detail/);
});

test('logout probes first and never logs out an invalid session', async () => {
  const urls = [];
  const fetchImpl = async url => { urls.push(url); return new Response('', { status: 401 }); };
  assert.equal((await logoutAllSessions(account, { fetchImpl })).ok, false);
  assert.equal(urls.length, 1);
  const result = await logoutAllSessions(account, { fetchImpl: async url => {
    urls.push(url);
    return url.endsWith('/logout_all') ? new Response('', { status: 200 }) : usage();
  } });
  assert.equal(result.ok, true);
  assert.ok(urls.at(-1).endsWith('/logout_all'));
});

test('converter logout shares acknowledgment validation and does not follow redirects', async () => {
  for (const [status, body, ok] of [[200, 'null', true], [204, null, true], [200, '<html>private-fixture</html>', false], [200, 'false', false], [302, '', false], [429, 'private-fixture', false]]) {
    const result = await logoutAllSessions(account, { fetchImpl: async (url, init) => {
      if (!url.endsWith('/logout_all')) return usage();
      assert.equal(init.redirect, 'manual');
      return new Response(body, { status });
    } });
    assert.equal(result.ok, ok);
    assert.equal(result.logoutStatus, status);
    assert.doesNotMatch(JSON.stringify(result), /private-fixture/);
  }
});

test('session operations retain one selected proxy and dispose on success or failure', async () => {
  for (const fail of [false, true]) {
    const selected = [];
    let disposed = 0;
    const pending = withSessionTransport(async ({ fetchImpl }) => {
      await checkSessionHealth(account, { includeUsage: true, fetchImpl });
      if (fail) throw new Error('fixture-failure');
    }, {
      pool: 'fixture-pool',
      resolveProxy: options => { assert.equal(options.pool, 'fixture-pool'); return { proxyUrl: 'http://127.0.0.1:7777' }; },
      createFetch: (proxy, options) => {
        selected.push({ proxy, direct: options.direct });
        return Object.assign(async () => usage(), { dispose: async () => { disposed++; } });
      },
    });
    if (fail) await assert.rejects(pending, /fixture-failure/); else await pending;
    assert.deepEqual(selected, [{ proxy: 'http://127.0.0.1:7777', direct: false }]);
    assert.equal(disposed, 1);
  }
});

test('cancelled operations do not create network transports', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(withSessionTransport(() => assert.fail(), { signal: controller.signal, createFetch: () => assert.fail() }), { name: 'AbortError' });
});


test('device checks count devices rather than apps and share account authentication', async () => {
  for (const devices of [[], [{ is_current_device: true, app_sessions: [{}, {}] }, { is_current_device: false }]]) {
    const urls = [];
    const result = await checkSessionHealth({ ...account, accountId: 'fixture-account', cookie: 'fixture=cookie', deviceId: 'fixture-device' }, {
      includeUsage: true, includeDevices: true,
      fetchImpl: async (url, init) => {
        urls.push(url);
        if (url.endsWith('/accounts/sessions')) {
          assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
          assert.equal(init.headers['chatgpt-account-id'], 'fixture-account');
          assert.equal(init.headers.Cookie, 'fixture=cookie');
          assert.equal(init.headers['oai-did'], 'fixture-device');
          return Response.json({ devices });
        }
        return url.endsWith('/me') ? Response.json({}) : usage();
      },
    });
    assert.equal(result.deviceCount, devices.length);
    assert.equal(result.devicesStatus, 200);
    assert.equal(result.status, 200);
    assert.equal(result.usage.fiveHour.usedPercent, 25);
    assert.equal(urls.length, 3);
    assert.doesNotMatch(JSON.stringify(result), /app_sessions|is_current_device/);
  }
});

test('device query failures stay unknown without changing successful health and usage', async () => {
  for (const response of [() => Response.json({ error: 'private-fixture' }, { status: 403 }), () => Response.json({}), () => new Response('invalid-json'), () => { throw new Error('network unavailable'); }]) {
    const result = await checkSessionHealth(account, { includeUsage: true, includeDevices: true,
      fetchImpl: async url => url.endsWith('/accounts/sessions') ? response() : usage(),
    });
    assert.equal(result.status, 200);
    assert.equal(result.usage.fiveHour.usedPercent, 25);
    assert.equal(result.deviceCount, null);
    assert.ok(result.devicesError);
    assert.doesNotMatch(JSON.stringify(result), /private-fixture/);
  }
});

test('failed health skips the optional device query', async () => {
  const urls = [];
  const result = await checkSessionHealth(account, { includeDevices: true, fetchImpl: async url => {
    urls.push(url);
    return Response.json({}, { status: 401 });
  } });
  assert.equal(urls.length, 1);
  assert.equal(result.status, 401);
  assert.equal(result.deviceCount, null);
});


test('device details expose display fields without login time fields', async () => {
  const result = await checkSessionHealth(account, { includeDevices: true, fetchImpl: async url =>
    url.endsWith('/accounts/sessions') ? Response.json({ devices: [
      { display_name: 'Computer', platform: 'windows', is_current_device: true,
        session_created_at_seconds: 1700000000.125, last_signed_in_timestamp_second: 1800000000,
        last_signed_in_city: 'Cypress', last_signed_in_region_code: 'TX', last_signed_in_country: 'US',
        app_sessions: [{ client_name: 'ChatGPT Web' }, { client_name: 'Codex' }], session_id: 'private-session-id' },
      { session_created_at_seconds: 1600000000, last_signed_in_timestamp_second: 1750000000 },
      { session_created_at_seconds: null, last_signed_in_timestamp_second: '' },
      { session_created_at_seconds: -1, last_signed_in_timestamp_second: 1e300 }, null,
    ] }) : usage(),
  });
  assert.equal(result.deviceCount, 5);
  assert.equal(Object.hasOwn(result, 'firstLoginAt'), false);
  assert.equal(Object.hasOwn(result, 'lastLoginAt'), false);
  assert.equal(result.devices[0].location, 'Cypress, TX, US');
  assert.deepEqual(result.devices[0].apps, ['ChatGPT Web', 'Codex']);
  assert.equal(result.devices[0].current, true);
  assert.equal(Object.hasOwn(result.devices[0], 'createdAt'), false);
  assert.equal(Object.hasOwn(result.devices[0], 'lastLoginAt'), false);
  assert.doesNotMatch(JSON.stringify(result), /private-session-id|session_id|createdAt|lastLoginAt/);
});

test('empty and unavailable device lists omit aggregate login time fields', async () => {
  for (const payload of [{ devices: [] }, {}, { devices: [{}] }]) {
    const result = await checkSessionHealth(account, { includeDevices: true, fetchImpl: async url =>
      url.endsWith('/accounts/sessions') ? Response.json(payload) : usage(),
    });
    assert.equal(Object.hasOwn(result, 'firstLoginAt'), false);
    assert.equal(Object.hasOwn(result, 'lastLoginAt'), false);
    assert.equal(result.deviceCount, payload.devices?.length ?? null);
  }
});
