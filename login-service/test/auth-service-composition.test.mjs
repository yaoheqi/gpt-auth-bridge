import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthenticationServices } from '../src/services/auth/composition.js';
import { createOpenAIJsonAuthFlow } from '../src/services/auth/openai-json-auth-flow.js';
import { browserRequest, requestScoped, requests } from '../src/services/request-scope.js';

test('the composed flow uses injected transport and live settings, retaining per-account cookies and egress', async () => {
  const transports = [];
  let timeoutMs = 20_000;
  const services = createAuthenticationServices({
    createAccountSessionDeviceAndProxy: (account, { proxyPool }) => ({
      fingerprint: { locale: account.locale },
      proxy: { proxyUrl: proxyPool, mode: proxyPool ? 'pool' : 'direct', label: 'fixture' },
    }),
    createCurlCffiFetch: (proxyUrl, options) => {
      const transport = Object.assign(() => assert.fail('no upstream request expected'), {
        proxyUrl, options, disposed: false,
        dispose() { this.disposed = true; },
      });
      transports.push(transport);
      return transport;
    },
    createSmsBowerClient: () => ({}),
    getSmsProviderLabel: () => 'fixture',
    getPhoneOtpWaitTimeoutMs: () => timeoutMs,
    normalizePhoneMode: value => value,
    buildBrowserHeaders: (headers, fingerprint) => ({ ...headers, 'accept-language': fingerprint.locale }),
  });
  const sink = { send() {} };
  const first = new services.OpenAIJsonAuthFlow({ email: 'a@example.com', locale: 'en-US' }, sink, { proxyPool: 'http://proxy-a.example:3000' });
  timeoutMs = 40_000;
  const second = new services.OpenAIJsonAuthFlow({ email: 'b@example.com', locale: 'ja-JP' }, sink, { proxyPool: '' });
  try {
    assert.equal(first.smsCodeTimeoutMs, 20_000);
    assert.equal(second.smsCodeTimeoutMs, 40_000);
    assert.equal(first.baseFetch.options.direct, false);
    assert.equal(second.baseFetch.options.direct, true);
    assert.equal(first.browserHeaders()['accept-language'], 'en-US');
    assert.equal(second.browserHeaders()['accept-language'], 'ja-JP');
    first.prepareLoginUrl();
    second.prepareLoginUrl();
    assert.notEqual(first.state, second.state);
    assert.notEqual(first.codeVerifier, second.codeVerifier);
    await first.jar.setCookie('fixture=A; Secure; Path=/', 'https://auth.openai.com/');
    await second.jar.setCookie('fixture=B; Secure; Path=/', 'https://auth.openai.com/');
    assert.equal(await first.readCookie('https://auth.openai.com/', 'fixture'), 'A');
    assert.equal(await second.readCookie('https://auth.openai.com/', 'fixture'), 'B');
    await first.resetAuthSession();
    assert.equal(transports[0].disposed, true);
    assert.equal(first.baseFetch.proxyUrl, 'http://proxy-a.example:3000');
    assert.equal(first.fingerprint.locale, 'en-US');
    assert.equal(await first.readCookie('https://auth.openai.com/', 'fixture'), '');
    assert.equal(await second.readCookie('https://auth.openai.com/', 'fixture'), 'B');
  } finally {
    await first.dispose();
    await second.dispose();
  }
  assert.ok(transports.every(transport => transport.disposed));
});

function flowWithDeferredCleanup(disposeFirst) {
  const transports = [];
  const Flow = createOpenAIJsonAuthFlow({
    createAccountSessionDeviceAndProxy: () => ({
      fingerprint: { locale: 'en-US' },
      proxy: { proxyUrl: 'http://fixture-proxy.example:3000', mode: 'pool', label: 'fixture' },
    }),
    createCurlCffiFetch: () => {
      const first = transports.length === 0;
      const transport = Object.assign(() => assert.fail('no upstream request expected'), {
        dispose: first ? disposeFirst : async () => {},
      });
      transports.push(transport);
      return transport;
    },
    createSmsBowerClient: () => ({}),
    getSmsProviderLabel: () => 'fixture',
    getPhoneOtpWaitTimeoutMs: () => 20_000,
    normalizePhoneMode: value => value,
  });
  return { flow: new Flow({ email: 'fixture@example.test' }, { send() {} }), transports };
}

test('auth session reset waits for transport cleanup before creating a replacement', async () => {
  let completeCleanup;
  let disposing = false;
  const cleanup = new Promise(resolve => { completeCleanup = resolve; });
  const { flow, transports } = flowWithDeferredCleanup(() => { disposing = true; return cleanup; });
  const originalJar = flow.jar;
  const reset = flow.resetAuthSession();
  assert.equal(disposing, true);
  assert.equal(transports.length, 1);
  assert.equal(flow.jar, originalJar);
  completeCleanup();
  await reset;
  assert.equal(transports.length, 2);
  assert.equal(flow.baseFetch, transports[1]);
  assert.notEqual(flow.jar, originalJar);
  assert.equal(flow.proxyUrl, 'http://fixture-proxy.example:3000');
  await flow.dispose();
});

test('auth session reset propagates cleanup rejection and preserves the previous state', async () => {
  const failure = Object.assign(new Error('fixture cleanup deadline'), { code: 'WORKER_CLEANUP_TIMEOUT' });
  const { flow, transports } = flowWithDeferredCleanup(() => Promise.reject(failure));
  const originalJar = flow.jar;
  flow.state = 'previous-oauth-state';
  await assert.rejects(flow.resetAuthSession(), error => error === failure);
  assert.equal(transports.length, 1);
  assert.equal(flow.baseFetch, transports[0]);
  assert.equal(flow.jar, originalJar);
  assert.equal(flow.state, 'previous-oauth-state');
  await assert.rejects(flow.dispose(), error => error === failure);
});

test('a shared service composition resolves the current request repository after asynchronous interleaving', async () => {
  const accountRepository = requestScoped('accounts', null);
  const services = createAuthenticationServices({ accountRepository });
  const contexts = ['A', 'B'].map(label => {
    const account = { id: 'same-id', email: `${label.toLowerCase()}@example.com` };
    return {
      closed: false,
      controller: new AbortController(),
      label,
      account,
      accounts: {
        async updateById(id, update) {
          await Promise.resolve();
          assert.equal(browserRequest().label, label);
          assert.equal(id, account.id);
          Object.assign(account, typeof update === 'function' ? update(account) : update);
        },
      },
    };
  });
  await Promise.all(contexts.map(context => requests.run(context, async () => {
    await services.persistChatGptWebSession('same-id', {
      accessToken: `fixture-${context.label}`,
      session: { user: { email: context.account.email } },
      storageState: { cookies: [{ name: 'fixture', value: context.label }] },
    });
    await services.persistSessionHealth('same-id', { health: 'alive', detail: context.label });
  })));
  for (const context of contexts) {
    assert.equal(context.account.session_access_token, `fixture-${context.label}`);
    assert.equal(context.account.session_health_detail, context.label);
    assert.equal(JSON.parse(context.account.storage_state_json).cookies[0].value, context.label);
  }
  assert.equal(browserRequest(), undefined);
});
