import assert from 'node:assert/strict';
import test from 'node:test';
import { Cookie, CookieJar } from 'tough-cookie';
import makeFetchCookie from 'fetch-cookie';
import * as authUrls from '../lib/openai-auth-urls.js';
import * as oauth from '../lib/openai-oauth.js';
import * as workspaces from '../lib/business-workspace.js';
import { openOAuthPage } from '../lib/oauth-navigation.js';
import { preflightProxyEgress } from '../lib/proxy-preflight.js';
import { readWorkspacePagePayload } from '../lib/workspace-page.js';
import { firstNonEmpty } from '../lib/jwt-utils.js';
import { protocolLoginCredentialIssue, resolveAccountLoginMethod } from '../src/domain/accounts/account-domain.js';
import { hasTotpSecret, generateTotpCode, validateTotpSecret } from '../lib/totp.js';
import { withCachedWebSession, sessionApiError } from '../src/services/cached-web-session.js';
import { readLogoutAllResponse } from '../src/services/logout-all-response.js';
import { randomUUID } from 'node:crypto';
import { validationError } from '../lib/validation-error.js';
import { createOpenAIJsonAuthFlow } from '../src/services/auth/openai-json-auth-flow.js';

// Import the same class factory the application composes. External boundaries
// can be replaced without booting a server or constructing real workers.
const bindings = {
  ...authUrls, ...oauth, ...workspaces, openOAuthPage, preflightProxyEgress, readWorkspacePagePayload, Cookie, firstNonEmpty,
  protocolLoginCredentialIssue, resolveAccountLoginMethod, hasTotpSecret, generateTotpCode, validateTotpSecret, sessionApiError, readLogoutAllResponse, randomUUID,
  looksLikeCloudflareBlock: () => false,
  isAgentIdentityRecord: () => false,
};
function authFlowClass(overrides = {}) {
  return createOpenAIJsonAuthFlow({ ...bindings, ...overrides });
}
const AuthFlow = authFlowClass();
const CONSENT = `${authUrls.AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`;
const CALLBACK = `${oauth.OPENAI_CODEX_REDIRECT_URI}?code=test-code&state=test-state`;
const PAYLOAD = { workspaces: [{ id: 'personal-id', kind: 'personal' }, { id: 'business-id', kind: 'business' }] };
const COOKIE_VALUE = `${Buffer.from(JSON.stringify(PAYLOAD)).toString('base64url')}.signature`;

function response(url, { status = 200, headers = {}, body = '' } = {}) {
  const result = new Response(body, { status, headers });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

function flowWithTransport(transport = async url => response(url)) {
  const flow = Object.create(AuthFlow.prototype);
  Object.assign(flow, {
    account: { email: 'fixture@example.com', password: 'fixture-password', two_factor_secret: 'JBSWY3DPEHPK3PXP' },
    jar: new CookieJar(),
    workspaceSelection: { mode: 'personal' },
    humanPause: async () => {},
    ensureProxyConnectivity: async () => {},
    browserHeaders: headers => headers,
    logs: [],
  });
  flow.log = message => flow.logs.push(message);
  flow.fetch = makeFetchCookie(transport, flow.jar);
  return flow;
}

test('MFA does not submit a code after validation context failure', async () => {
  const flow = flowWithTransport(async (url, options) => {
    assert.notEqual(options.method, 'POST');
    return response(url);
  });
  flow.fetchSentinelToken = async () => { throw validationError('VALIDATION_CONTEXT_MISMATCH'); };
  await assert.rejects(flow.mfaValidate({ continueUrl: '/mfa-challenge/fixture',
    payload: { page: { payload: { factor_id: 'fixture' } } } }), { code: 'VALIDATION_CONTEXT_MISMATCH' });
});

test('Web and Codex login use password and TOTP', async () => {
  for (const phase of ['chatgpt', 'codex']) {
    const events = [];
    const callback = phase === 'codex' ? CALLBACK : 'https://chatgpt.com/api/auth/callback/openai?code=fixture';
    const flow = flowWithTransport(async (url, init) => {
      events.push(new URL(url).pathname);
      let payload;
      if (url === authUrls.AUTH_AUTHORIZE_CONTINUE_URL) {
        assert.equal(JSON.parse(init.body).username.value, flow.account.email);
        payload = { continue_url: '/log-in/password', page: { type: 'login_password' } };
      } else if (url === authUrls.AUTH_PASSWORD_VERIFY_URL) {
        assert.equal(JSON.parse(init.body).password, flow.account.password);
        payload = { page: { type: 'mfa_challenge', payload: { factor_id: 'fixture-factor' } } };
      } else if (url === `${authUrls.AUTH_BASE_URL}/mfa-challenge/fixture-factor`) {
        assert.equal(init.method, 'GET');
        return response(url);
      } else if (url === authUrls.AUTH_MFA_VERIFY_URL) {
        const body = JSON.parse(init.body);
        assert.equal(body.type, 'totp');
        assert.equal(body.id, 'fixture-factor');
        assert.match(body.code, /^\d{6}$/);
        payload = { continue_url: callback };
      } else assert.fail(`unexpected request: ${url}`);
      return response(url, { body: JSON.stringify(payload) });
    });
    flow.fetchSentinelToken = async () => 'fixture-sentinel';
    assert.equal(flow.isPasswordTotpAccount(), true);
    assert.equal(await flow.advanceAuthStep(`${authUrls.AUTH_BASE_URL}/log-in`, { phase }), callback);
    assert.deepEqual(events, ['/api/accounts/authorize/continue', '/api/accounts/password/verify', '/mfa-challenge/fixture-factor', '/api/accounts/mfa/verify']);
  }
});

test('password submission uses saved or imported credentials and rejects missing passwords before network access', async () => {
  for (const [credentials, expected] of [
    [{ openai_password: 'saved-password' }, 'saved-password'],
    [{ password: 'imported-password' }, 'imported-password'],
    [{ openai_password: 'saved-password', password: 'older-password' }, 'saved-password'],
  ]) {
    let requests = 0;
    const flow = flowWithTransport(async (url, init) => {
      requests++;
      assert.equal(url, authUrls.AUTH_PASSWORD_VERIFY_URL);
      assert.deepEqual(JSON.parse(init.body), { password: expected });
      return response(url, { body: JSON.stringify({ continue_url: '/mfa-challenge/fixture-factor' }) });
    });
    flow.account = { email: 'fixture@example.com', ...credentials };
    flow.fetchSentinelToken = async () => 'fixture-sentinel';
    assert.equal((await flow.passwordVerify()).continueUrl, `${authUrls.AUTH_BASE_URL}/mfa-challenge/fixture-factor`);
    assert.equal(requests, 1);
  }
  const flow = flowWithTransport(() => assert.fail('missing password must not reach the network'));
  flow.account = { email: 'fixture@example.com' };
  flow.fetchSentinelToken = () => assert.fail('missing password must not request a sentinel token');
  await assert.rejects(flow.passwordVerify(), /账号缺少 OpenAI 密码/);
});

for (const destination of [CONSENT, CALLBACK]) {
  test(`post-TOTP OAuth transition reaches ${new URL(destination).pathname} without repeating credentials`, async () => {
    const transition = `${authUrls.AUTH_BASE_URL}/api/oauth/oauth2/auth?state=fixture-state`;
    const requests = [];
    const flow = flowWithTransport(async (url, init) => {
      requests.push(url);
      if (url === transition) {
        assert.match(init.headers.cookie, /verified=fixture/);
        return response(url, { status: 302, headers: { location: destination } });
      }
      if (url === CONSENT) return response(url, { body: `<script type="application/json">${JSON.stringify(PAYLOAD)}</script>` });
      assert.equal(url, authUrls.AUTH_WORKSPACE_SELECT_URL);
      return response(url, { body: JSON.stringify({ continue_url: CALLBACK }) });
    });
    const verified = [];
    flow.passwordVerify = async () => {
      verified.push('password');
      return { pageType: 'mfa', continueUrl: `${authUrls.AUTH_BASE_URL}/mfa-challenge/factor` };
    };
    flow.mfaValidate = async () => {
      verified.push('totp');
      await flow.jar.setCookie('verified=fixture; Secure; Path=/', authUrls.AUTH_BASE_URL);
      return { continueUrl: transition };
    };
    flow.resetAuthSession = () => assert.fail('must preserve completed account verification');
    assert.equal(await flow.advanceAuthStep(`${authUrls.AUTH_BASE_URL}/log-in/password`), CALLBACK);
    assert.deepEqual(verified, ['password', 'totp']);
    assert.equal(requests.filter(url => url === transition).length, 1);
    assert.ok(!requests.includes(CALLBACK), 'must not contact the localhost callback');
  });
}

test('OAuth transitions cannot resume email verification or an unrelated host', async () => {
  const flow = flowWithTransport(() => assert.fail('unsupported step must not reach the network'));
  for (const url of [`${authUrls.AUTH_BASE_URL}/email-verification`, 'https://unrelated.example/api/oauth/oauth2/auth']) {
    await assert.rejects(flow.advanceAuthStep(url), { code: 'UNSUPPORTED_LOGIN_STEP' });
  }
});

test('invalid authorize and password responses fail without advancing login', async () => {
  for (const [entry, body, expected] of [
    ['authorizeContinue', '<!DOCTYPE html><html>upstream error</html>', /响应不是JSON/],
    ['passwordVerify', '{}', /缺少 continue_url/],
  ]) {
    const flow = flowWithTransport(async url => response(url, { body }));
    flow.fetchSentinelToken = async () => 'fixture';
    await assert.rejects(flow[entry](), expected);
  }
});

test('incomplete credentials cannot start any fresh login or proxy probe', async () => {
  for (const entry of ['run', 'loginChatGptWebWithPasswordTotp', 'loginCodexWithPhone']) {
    const flow = flowWithTransport(() => assert.fail('must not access network'));
    flow.account = { email: 'fixture@example.com' };
    flow.ensureProxyConnectivity = () => assert.fail('must validate credentials before probing');
    flow.resetAuthSession = () => assert.fail('must not clear cookies');
    await assert.rejects(flow[entry](), { code: 'LOGIN_CREDENTIALS_MISSING' });
  }
});

test('failed connectivity prevents every formal login entry from sending requests', async () => {
  for (const entry of ['run', 'startOAuthSession', 'startChatGptWebSignIn']) {
    const flow = flowWithTransport(() => assert.fail('no formal request before connectivity passes'));
    flow.resetAuthSession = () => assert.fail('must not reset account cookies before connectivity passes');
    flow.prepareLoginUrl = () => assert.fail('must not prepare account authorization before connectivity passes');
    flow.ensureProxyConnectivity = async () => { throw new Error('fixture preflight failed'); };
    await assert.rejects(flow[entry](), /fixture preflight failed/);
  }
});

test('one account checks its exact proxy once and retains its login cookie jar', async () => {
  let probes = 0;
  const proxy = 'http://user-session-12345678:password@proxy.example:3000/';
  const Flow = authFlowClass({ preflightProxyEgress: async (url, options) => {
    probes++;
    assert.equal(url, proxy);
    assert.equal(options.direct, false);
    assert.deepEqual(options.headers, { accept: 'text/html,application/xhtml+xml,*/*' });
    return { status: 200, latencyMs: 42 };
  } });
  const flow = flowWithTransport();
  Object.setPrototypeOf(flow, Flow.prototype);
  delete flow.ensureProxyConnectivity;
  flow.proxyUrl = proxy;
  flow.proxyLabel = 'http://proxy.example:3000/';
  flow.directEgress = false;
  await flow.jar.setCookie('existing=private; Secure; Path=/', authUrls.AUTH_BASE_URL);
  const jar = flow.jar;
  await Promise.all([flow.ensureProxyConnectivity(), flow.ensureProxyConnectivity()]);
  await flow.ensureProxyConnectivity();
  assert.equal(probes, 1);
  assert.equal(flow.jar, jar);
  assert.equal(await flow.readCookie(authUrls.AUTH_BASE_URL, 'existing'), 'private');
  assert.equal(flow.logs.length, 2);
  assert.match(flow.logs[0], /proxy\.example:3000/);
  assert.match(flow.logs[1], /检测通过.*42ms/);
  assert.doesNotMatch(flow.logs.join('\n'), /user-session|password|private/);
});

test('stored session preserves scoped cookies, host-only flags and domain cookies across export/import', async () => {
  const original = flowWithTransport();
  await original.jar.setCookie(`oai-client-auth-session=${COOKIE_VALUE}; Secure; Path=/api/accounts; Max-Age=300`, authUrls.AUTH_BASE_URL);
  await original.jar.setCookie('oai-did=test-device; Secure; Domain=openai.com; Path=/', authUrls.AUTH_BASE_URL);
  await original.jar.setCookie('__Host-next-auth.csrf-token=test-csrf; Secure; Path=/; SameSite=Strict', authUrls.CHATGPT_BASE_URL);
  // Reproduces the old root-path read/export silently dropping the workspace cookie.
  assert.equal(await original.readCookie(authUrls.AUTH_BASE_URL, 'oai-client-auth-session'), '');
  const stored = await original.exportCookieStorageState();
  const cookies = JSON.parse(stored).cookies;
  assert.equal(cookies.length, 3);
  const workspace = cookies.find(cookie => cookie.name === 'oai-client-auth-session');
  assert.equal(workspace.path, '/api/accounts');
  assert.ok(workspace.expires > Date.now() / 1000 && workspace.expires < Date.now() / 1000 + 301);
  assert.equal(workspace.hostOnly, true);

  const restored = flowWithTransport();
  restored.account.storage_state_json = stored;
  assert.equal(await restored.importStoredCookieStorageState(), 3);
  assert.equal(await restored.resolveWorkspaceID(), 'personal-id');
  assert.equal(await restored.readCookie('https://openai.com', 'oai-did'), 'test-device');
  assert.equal(await restored.readCookie('https://child.auth.openai.com/api/accounts', 'oai-client-auth-session'), '');
  const csrf = (await restored.jar.getCookies(authUrls.CHATGPT_BASE_URL))[0];
  assert.equal(csrf.key, '__Host-next-auth.csrf-token');
  assert.equal(csrf.sameSite, 'strict');
});

test('legacy storage imports domain cookies and counts only valid unexpired cookies', async () => {
  const flow = flowWithTransport();
  flow.account.storage_state_json = JSON.stringify({ cookies: [
    { name: 'oai-did', value: 'test-device', domain: 'openai.com', path: '/' },
    { name: '__Host-next-auth.csrf-token', value: 'test-csrf', domain: 'chatgpt.com', path: '/' },
    { name: 'expired', value: 'old', domain: 'auth.openai.com', expires: 1 },
    { name: 'invalid', value: 'bad', domain: 'com' },
  ] });
  assert.equal(await flow.importStoredCookieStorageState(), 2);
  assert.equal(await flow.readCookie(authUrls.AUTH_BASE_URL, 'oai-did'), 'test-device');
  assert.equal(await flow.readCookie(authUrls.CHATGPT_BASE_URL, '__Host-next-auth.csrf-token'), 'test-csrf');
  assert.match(flow.logs[0], /2 个/);
});

test('workspace selection reads numbered chunks in numeric order and never substitutes a Business workspace', async () => {
  const flow = flowWithTransport();
  const chunks = COOKIE_VALUE.match(/.{1,12}/g);
  assert.ok(chunks.length > 10);
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    await flow.jar.setCookie(`oai-client-auth-session.${index}=${chunks[index]}; Path=/api/accounts; Secure`, authUrls.AUTH_BASE_URL);
  }
  assert.equal(await flow.resolveWorkspaceID(), 'personal-id');
  flow.workspaceSelection = { mode: 'id', workspaceId: 'business-id' };
  assert.equal(await flow.resolveWorkspaceID(), 'business-id');
  flow.workspaceSelection = { mode: 'id', workspaceId: 'other-business' };
  await assert.rejects(flow.resolveWorkspaceID(), error => error.code === 'BUSINESS_NOT_MEMBER');
  const stored = await flow.exportCookieStorageState();
  assert.deepEqual(workspaces.extractBusinessWorkspaceIds({ storage_state_json: stored }), ['business-id']);
});

test('incomplete or cross-scope chunks fail with diagnostics that exclude cookie values', async () => {
  const flow = flowWithTransport();
  await flow.jar.setCookie('oai-client-auth-session.0=sensitive-part; Path=/api; Secure', authUrls.AUTH_BASE_URL);
  await flow.jar.setCookie('oai-client-auth-session.1=another-sensitive-part; Path=/consent; Secure', authUrls.AUTH_BASE_URL);
  await assert.rejects(flow.resolveWorkspaceID(), error => {
    assert.equal(error.code, 'WORKSPACE_SESSION_INVALID');
    assert.match(error.message, /domain=auth\.openai\.com path=\/api/);
    assert.doesNotMatch(error.message, /sensitive-part/);
    return true;
  });
  const cookies = [{ name: 'oai-client-auth-session.0', value: COOKIE_VALUE.slice(0, 5) }, { name: 'oai-client-auth-session.2', value: COOKIE_VALUE.slice(5) }];
  assert.deepEqual(workspaces.workspaceSessionCookieValues(cookies), []);
});

test('OAuth startup retains cookies from intermediate redirects and accepts the workspace page', async () => {
  const requests = [];
  const flow = flowWithTransport(async (url, init) => {
    requests.push(url);
    assert.equal(init.redirect, 'manual');
    if (new URL(url).pathname === '/oauth/authorize') {
      return response(url, { status: 302, headers: {
        location: '/workspace',
        'set-cookie': `oai-client-auth-session=${COOKIE_VALUE}; Path=/api/accounts; Secure`,
      } });
    }
    return response(url, { headers: { 'set-cookie': 'oai-did=test-device; Path=/; Secure' } });
  });
  const started = await flow.startOAuthSession({ prompt: '' });
  assert.equal(started.continueUrl, `${authUrls.AUTH_BASE_URL}/workspace`);
  assert.equal(requests.length, 2);
  assert.equal(await flow.resolveWorkspaceID(), 'personal-id');
});

for (const destination of ['/log-in/password', '/mfa-challenge/test-factor', '/add-phone', CALLBACK]) {
  test(`consent follows the actual next step (${new URL(destination, authUrls.AUTH_BASE_URL).pathname}) without requiring a workspace cookie`, async () => {
    const calls = [];
    const flow = flowWithTransport(async (url, init) => {
      calls.push(url);
      assert.notEqual(init.method, 'POST');
      assert.ok(!url.startsWith(oauth.OPENAI_CODEX_REDIRECT_URI));
      return url === CONSENT
        ? response(url, { status: 302, headers: { location: destination } })
        : response(url);
    });
    assert.equal(await flow.selectWorkspace(CONSENT), new URL(destination, authUrls.AUTH_BASE_URL).toString());
    assert.equal(calls.length, destination === CALLBACK ? 1 : 2);
  });
}

test('startup stops at the CLI callback without contacting localhost', async () => {
  let calls = 0;
  const flow = flowWithTransport(async url => {
    calls += 1;
    assert.equal(new URL(url).hostname, 'auth.openai.com');
    return response(url, { status: 302, headers: { location: CALLBACK } });
  });
  const result = await flow.startOAuthSession();
  assert.equal(result.done, true);
  assert.equal(result.callbackUrl, CALLBACK);
  assert.equal(calls, 1);
});

test('consent HTTP failures retain status/path and do not trigger credential recovery', async () => {
  const flow = flowWithTransport(async url => response(url, { status: 403, body: 'blocked' }));
  flow.resetAuthSession = () => assert.fail('must not retry blocked egress as missing cookies');
  await assert.rejects(flow.advanceAuthStep(`${CONSENT}?state=sensitive-query`), error => {
    assert.equal(error.code, 'OAUTH_PAGE_HTTP_ERROR');
    assert.equal(error.status, 403);
    assert.match(error.message, /consent/);
    assert.doesNotMatch(error.message, /sensitive-query|未找到/);
    return true;
  });
});

test('redirect loops fail within the configured hop limit', async () => {
  let calls = 0;
  const flow = flowWithTransport(async url => {
    calls += 1;
    return response(url, { status: 302, headers: { location: CONSENT } });
  });
  await assert.rejects(flow.selectWorkspace(CONSENT), error => error.code === 'OAUTH_REDIRECT_LIMIT');
  assert.equal(calls, 11);
});

test('workspace POST uses the final consent referer and accepts a redirect callback', async () => {
  const canonical = `${authUrls.AUTH_BASE_URL}/consent`;
  const flow = flowWithTransport(async (url, init) => {
    if (url === CONSENT) return response(url, { status: 302, headers: { location: canonical } });
    if (url === canonical) return response(url, { headers: { 'set-cookie': `oai-client-auth-session=${COOKIE_VALUE}; Path=/; Secure` } });
    assert.equal(url, authUrls.AUTH_WORKSPACE_SELECT_URL);
    assert.equal(init.headers.referer, canonical);
    assert.equal(init.redirect, 'manual');
    assert.deepEqual(JSON.parse(init.body), { workspace_id: 'personal-id' });
    return response(url, { status: 302, headers: { location: CALLBACK } });
  });
  assert.equal(await flow.selectWorkspace(CONSENT), CALLBACK);
});

for (const mode of ['personal', 'id']) {
  test(`consent page catalog authorizes ${mode} without a workspace cookie or reauthentication`, async () => {
    const selected = [];
    const flow = flowWithTransport(async (url, init) => {
      if (url === CONSENT) return response(url, { body: `<script type="application/json">${JSON.stringify({ loaderData: { clientAuthSession: PAYLOAD } })}</script>` });
      assert.equal(url, authUrls.AUTH_WORKSPACE_SELECT_URL);
      selected.push(JSON.parse(init.body).workspace_id);
      return response(url, { body: JSON.stringify({ continue_url: CALLBACK }) });
    });
    flow.workspaceSelection = { mode, workspaceId: 'business-id' };
    flow.resetAuthSession = () => assert.fail('must retain completed login');
    flow.passwordVerify = () => assert.fail('must not repeat password');
    flow.mfaValidate = () => assert.fail('must not repeat TOTP');
    assert.equal(await flow.advanceAuthStep(CONSENT), CALLBACK);
    assert.deepEqual(selected, [mode === 'personal' ? 'personal-id' : 'business-id']);
    assert.deepEqual(flow.discoveredWorkspaces, PAYLOAD.workspaces);
  });
}

test('fresh password and TOTP login with no workspace data stops instead of repeating credentials', async () => {
  const flow = flowWithTransport(async url => response(url));
  const events = [];
  flow.resetAuthSession = () => assert.fail('must not reset a freshly verified account');
  flow.passwordVerify = async () => {
    events.push('password');
    return { pageType: 'mfa', continueUrl: `${authUrls.AUTH_BASE_URL}/mfa-challenge/factor` };
  };
  flow.mfaValidate = async () => { events.push('totp'); return { continueUrl: CONSENT }; };
  await assert.rejects(flow.advanceAuthStep(`${authUrls.AUTH_BASE_URL}/log-in/password`), { code: 'WORKSPACE_DISCOVERY_FAILED' });
  assert.deepEqual(events, ['password', 'totp']);
});

test('current consent catalog takes precedence over stale cookie membership', async () => {
  const flow = flowWithTransport();
  await flow.jar.setCookie(`oai-client-auth-session=${COOKIE_VALUE}; Path=/; Secure`, authUrls.AUTH_BASE_URL);
  flow.workspaceSelection = { mode: 'id', workspaceId: 'business-id' };
  const html = `<script type="application/json">${JSON.stringify({ workspaces: [PAYLOAD.workspaces[0]] })}</script>`;
  await assert.rejects(flow.resolveWorkspaceID(html), { code: 'BUSINESS_NOT_MEMBER' });
});

for (const repairCookie of [true, false]) {
  test(`missing stored workspace session triggers one password/TOTP recovery (cookie restored: ${repairCookie})`, async () => {
    const events = [];
    const transport = async (url, init) => {
      if (new URL(url).pathname === '/oauth/authorize') {
        assert.equal(new URL(url).searchParams.get('prompt'), 'login');
        return response(url, { status: 302, headers: { location: '/log-in/password', 'set-cookie': 'oai-did=test-device; Path=/; Secure' } });
      }
      if (url === authUrls.AUTH_WORKSPACE_SELECT_URL) {
        assert.deepEqual(JSON.parse(init.body), { workspace_id: 'business-id' });
        return response(url, { body: JSON.stringify({ continue_url: CALLBACK }) });
      }
      return response(url);
    };
    const flow = flowWithTransport(transport);
    flow.workspaceSelection = { mode: 'id', workspaceId: 'business-id' };
    flow.requireStoredSession = true;
    flow.forbidPhoneChallenge = true;
    flow.reuseStoredSession = true;
    await flow.jar.setCookie('stale=test-stale; Path=/; Secure', authUrls.AUTH_BASE_URL);
    flow.resetAuthSession = () => {
      events.push('reset');
      flow.jar = new CookieJar();
      flow.fetch = makeFetchCookie(transport, flow.jar);
    };
    flow.passwordVerify = async () => {
      events.push('password');
      return { continueUrl: `${authUrls.AUTH_BASE_URL}/mfa-challenge/test-factor`, pageType: 'mfa' };
    };
    flow.mfaValidate = async () => {
      events.push('totp');
      if (repairCookie) await flow.jar.setCookie(`oai-client-auth-session=${COOKIE_VALUE}; Path=/; Secure`, authUrls.AUTH_BASE_URL);
      return { continueUrl: CONSENT };
    };
    if (repairCookie) assert.equal(await flow.advanceAuthStep(CONSENT), CALLBACK);
    else await assert.rejects(flow.advanceAuthStep(CONSENT), error => error.code === 'WORKSPACE_DISCOVERY_FAILED');
    assert.deepEqual(events, ['reset', 'password', 'totp']);
    assert.equal(await flow.readCookie(authUrls.AUTH_BASE_URL, 'stale'), '');
    assert.equal(flow.forbidPhoneChallenge, true);
    assert.equal(flow.workspaceSelection.workspaceId, 'business-id');
  });
}

test('phone prohibition still applies after a consent redirect', async () => {
  const flow = flowWithTransport(async url => url === CONSENT
    ? response(url, { status: 302, headers: { location: '/add-phone' } })
    : response(url));
  flow.forbidPhoneChallenge = true;
  await assert.rejects(flow.advanceAuthStep(CONSENT), /禁止新接码/);
});

test('Business membership errors never trigger reauthentication or personal fallback', async () => {
  const flow = flowWithTransport();
  flow.workspaceSelection = { mode: 'id', workspaceId: 'not-a-member' };
  await flow.jar.setCookie(`oai-client-auth-session=${COOKIE_VALUE}; Path=/; Secure`, authUrls.AUTH_BASE_URL);
  flow.resetAuthSession = () => assert.fail('membership failure must not reset auth');
  await assert.rejects(flow.advanceAuthStep(CONSENT), error => error.code === 'BUSINESS_NOT_MEMBER');
});

for (const restored of [true, false]) {
  test(`ChatGPT workspace cookie recovery is bounded and uses Web OAuth (${restored})`, async () => {
    const flow = flowWithTransport(async (url) => response(url, { body: JSON.stringify({ continue_url: 'https://chatgpt.com/api/auth/callback/openai?code=fixture' }) }));
    let restarts = 0;
    flow.startOAuthSession = () => assert.fail('must not switch Web login to Codex');
    flow.startChatGptWebSignIn = async () => {
      restarts++;
      flow.jar = new CookieJar();
      if (restored) await flow.jar.setCookie(`oai-client-auth-session=${COOKIE_VALUE}; Path=/; Secure`, authUrls.AUTH_BASE_URL);
      return { continueUrl: CONSENT };
    };
    if (restored) assert.match(await flow.advanceAuthStep(CONSENT, { phase: 'chatgpt' }), /chatgpt.com/);
    else await assert.rejects(flow.advanceAuthStep(CONSENT, { phase: 'chatgpt' }), { code: 'WORKSPACE_SESSION_MISSING' });
    assert.equal(restarts, 1);
  });
}

test('workspace discovery includes host-only OpenAI cookies on non-root paths', async () => {
  const flow = flowWithTransport();
  await flow.jar.setCookie(`oai-client-auth-session=${COOKIE_VALUE}; Path=/workspace; Secure`, 'https://openai.com/workspace');
  assert.equal(await flow.resolveWorkspaceID(), 'personal-id');
});

test('workspace discovery enumerates child auth subdomains instead of guessing origins', async () => {
  const flow = flowWithTransport();
  await flow.jar.setCookie(
    `oai-client-auth-session=${COOKIE_VALUE}; Path=/workspace; Secure`,
    'https://child.auth.openai.com/workspace',
  );
  assert.equal(await flow.resolveWorkspaceID(), 'personal-id');
});

test('workspace cookie set by a child-host response survives fetch-cookie redirect handling', async () => {
  const flow = flowWithTransport(async (url, init) => {
    if (url === 'https://child.auth.openai.com/workspace') {
      return response(url, {
        headers: {
          'set-cookie': `oai-client-auth-session=${COOKIE_VALUE}; Path=/workspace; Secure`,
        },
      });
    }
    assert.equal(url, authUrls.AUTH_WORKSPACE_SELECT_URL);
    assert.equal(init.method, 'POST');
    return response(url, { body: JSON.stringify({ continue_url: CALLBACK }) });
  });
  assert.equal(await flow.selectWorkspace('https://child.auth.openai.com/workspace'), CALLBACK);
});

test('export preserves cookies stored on child auth subdomains', async () => {
  const flow = flowWithTransport();
  await flow.jar.setCookie(
    `oai-client-auth-session=${COOKIE_VALUE}; Path=/workspace; Secure`,
    'https://child.auth.openai.com/workspace',
  );
  const stored = JSON.parse(await flow.exportCookieStorageState());
  assert.deepEqual(stored.cookies.map(cookie => ({ name: cookie.name, domain: cookie.domain, path: cookie.path })), [
    { name: 'oai-client-auth-session', domain: 'child.auth.openai.com', path: '/workspace' },
  ]);
});

test('workspace diagnostics expose cookie scope only, never the cookie value', async () => {
  const flow = flowWithTransport();
  await flow.jar.setCookie(
    'oai-client-auth-session.0=super-secret-chunk; Path=/workspace; Secure',
    'https://child.auth.openai.com/workspace',
  );
  await assert.rejects(flow.resolveWorkspaceID(), error => error.code === 'WORKSPACE_SESSION_INVALID');
  assert.match(flow.logs.at(-1), /oai-client-auth-session\.0 \[domain=child\.auth\.openai\.com path=\/workspace\]/);
  assert.doesNotMatch(flow.logs.at(-1), /super-secret-chunk/);
});

test('subsequent Codex workspace grants keep login cookies and transport but create new PKCE states', async () => {
  const states = [];
  const verifiers = [];
  const selected = [];
  let passwords = 0;
  let totps = 0;
  const flow = flowWithTransport(async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/oauth/authorize') {
      states.push(parsed.searchParams.get('state'));
      verifiers.push(flow.codeVerifier);
      assert.equal(parsed.searchParams.get('prompt'), states.length === 1 ? 'login' : null);
      if (states.length > 1) assert.match(init.headers.cookie, /oai-did=test-device/);
      return response(url, { status: 302, headers: {
        location: states.length === 1 ? '/log-in/password' : '/workspace',
        'set-cookie': 'oai-did=test-device; Path=/; Secure',
      } });
    }
    if (url === authUrls.AUTH_WORKSPACE_SELECT_URL) {
      selected.push(JSON.parse(init.body).workspace_id);
      return response(url, { body: JSON.stringify({ continue_url: `${oauth.OPENAI_CODEX_REDIRECT_URI}?code=fixture-${states.length}&state=${flow.state}` }) });
    }
    return response(url);
  });
  const jar = flow.jar;
  const fetcher = flow.fetch;
  const device = { proxyUrl: 'fixture-proxy', fingerprint: { id: 'fixture-device' } };
  Object.assign(flow, device);
  let resets = 0;
  flow.resetAuthSession = () => { resets++; assert.equal(resets, 1); };
  flow.importStoredCookieStorageState = () => assert.fail('must not import Web Session');
  flow.passwordVerify = async () => {
    passwords++;
    return { pageType: 'mfa', continueUrl: `${authUrls.AUTH_BASE_URL}/mfa-challenge/factor` };
  };
  flow.mfaValidate = async () => {
    totps++;
    await flow.jar.setCookie(`oai-client-auth-session=${COOKIE_VALUE}; Path=/; Secure`, authUrls.AUTH_BASE_URL);
    return { continueUrl: `${authUrls.AUTH_BASE_URL}/workspace` };
  };
  flow.exchangeCodeForToken = async code => ({ refresh_token: `rt-${code}` });
  await flow.loginCodexWithPhone();
  assert.deepEqual(flow.discoveredWorkspaces, PAYLOAD.workspaces);
  flow.workspaceSelection = { mode: 'id', workspaceId: 'business-id' };
  await flow.loginCodexWithPhone({ preserveAuthSession: true });
  assert.deepEqual(selected, ['personal-id', 'business-id']);
  assert.equal(passwords, 1);
  assert.equal(totps, 1);
  assert.equal(resets, 1);
  assert.equal(new Set(states).size, 2);
  assert.equal(new Set(verifiers).size, 2);
  assert.equal(flow.jar, jar);
  assert.equal(flow.fetch, fetcher);
  assert.equal(flow.proxyUrl, device.proxyUrl);
  assert.equal(flow.fingerprint, device.fingerprint);
});


test('cached cookies authorize a workspace without password/TOTP and fall back only when OAuth asks', async () => {
  for (const requiresLogin of [false, true]) {
    const flow = flowWithTransport();
    flow.reuseStoredSession = true;
    flow.account.storage_state_json = JSON.stringify({ cookies: [{ name: 'auth-session', value: 'fixture', domain: 'auth.openai.com', path: '/', secure: true, expires: -1 }] });
    flow.resetAuthSession = () => { flow.jar = new CookieJar(); };
    flow.startOAuthSession = async options => {
      assert.equal(options.prompt, '');
      assert.match(await flow.jar.getCookieString(authUrls.AUTH_BASE_URL), /auth-session=fixture/);
      return requiresLogin ? { continueUrl: authUrls.AUTH_BASE_URL + '/log-in/password' } : { done: true, callbackUrl: CALLBACK };
    };
    const verified = [];
    flow.passwordVerify = async () => { verified.push('password'); return { continueUrl: authUrls.AUTH_BASE_URL + '/mfa-challenge/test' }; };
    flow.mfaValidate = async () => { verified.push('totp'); return { continueUrl: CALLBACK }; };
    flow.extractAuthResult = () => ({ code: 'fixture-code' });
    flow.followOAuthRedirects = async () => ({ code: 'fixture-code' });
    flow.exchangeCodeForToken = async () => ({ refresh_token: 'fixture-rt' });
    assert.equal((await flow.loginCodexWithPhone()).refresh_token, 'fixture-rt');
    assert.deepEqual(verified, requiresLogin ? ['password', 'totp'] : []);
  }
});

test('MFA reset uses the cached token and cookies; a rejection after disable cannot restart using the old TOTP', async () => {
  for (const deniedAt of ['', 'disable', 'enroll']) {
    const calls = [];
    const flow = flowWithTransport(async (url, init) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (deniedAt && path.endsWith(deniedAt === 'disable' ? 'disable_in_house' : '/enroll')) {
        return response(url, { status: 401, body: JSON.stringify({ error: { code: 'token_invalidated', message: 'private upstream data' } }) });
      }
      const body = path.endsWith('mfa_info') ? { mfa_enabled: true, factors: { totp: [{ id: 'factor-fixture' }] } }
        : path.endsWith('/enroll') ? { secret: 'KRSXG5DSNFXGOIDB', session_id: 'enroll-fixture' } : { success: true };
      assert.equal(init.headers.authorization, 'Bearer cached-session');
      assert.match(init.headers.cookie, /auth-session=fixture/);
      return response(url, { body: JSON.stringify(body) });
    });
    flow.ensureChatGptDeviceCookie = async () => {};
    flow.chatgptBackendHeaders = value => ({ authorization: 'Bearer ' + value });
    Object.assign(flow.account, { session_access_token: 'cached-session', storage_state_json: JSON.stringify({ cookies: [
      { name: 'auth-session', value: 'fixture', domain: 'chatgpt.com', path: '/', secure: true, expires: -1 },
    ] }) });
    let logins = 0;
    flow.loginChatGptWebWithPasswordTotp = async () => {
      logins++;
      assert.equal(deniedAt, 'disable', 'must not repeat login after a mutation');
      throw new Error('fixture requires user action');
    };
    const result = withCachedWebSession(flow.account, { flow }, value => flow.resetTotpForSession(value));
    if (deniedAt) await assert.rejects(result, deniedAt === 'disable' ? /user action/ : /token_invalidated/);
    else assert.equal((await result).result.secret, 'KRSXG5DSNFXGOIDB');
    assert.equal(logins, deniedAt === 'disable' ? 1 : 0);
    assert.equal(calls.filter(path => path.endsWith('disable_in_house')).length, 1);
  }
});

test('logout uses typed auth failures and rejects upstream HTML or redirects without claiming success', async () => {
  for (const [status, body, code] of [[401, '{"error":{"code":"token_invalidated"}}', 'token_invalidated'],
    [200, '<html>please login</html>', 'logout_response_unrecognized'], [302, '', ''], [429, '{}', '']]) {
    const flow = flowWithTransport(async (url, init) => {
      assert.equal(init.redirect, 'manual');
      return response(url, { status, body });
    });
    flow.ensureChatGptDeviceCookie = async () => {};
    flow.browserHeaders = headers => headers;
    const result = flow.logoutAllChatGptSessions('fixture-session');
    await assert.rejects(result, error => {
      assert.equal(error.code, code);
      if (status !== 200) assert.equal(error.status, status);
      return true;
    });
  }
});

test('logout accepts scalar acknowledgments without relogging or submitting twice', async () => {
  for (const [status, body, responseType] of [[200, 'null', 'json-null'], [200, 'true', 'json-boolean'], [200, 'OK', 'text'], [204, null, 'empty']]) {
    let requests = 0;
    const flow = flowWithTransport(async (url, init) => {
      requests++;
      assert.equal(url, authUrls.CHATGPT_LOGOUT_ALL_URL);
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.authorization, 'Bearer cached-session');
      return response(url, { status, body });
    });
    flow.ensureChatGptDeviceCookie = async () => {};
    flow.account.session_access_token = 'cached-session';
    flow.loginChatGptWebWithPasswordTotp = () => assert.fail('must reuse cached Session');
    const result = await withCachedWebSession(flow.account, { flow }, token => flow.logoutAllChatGptSessions(token));
    assert.deepEqual(result.result, { status, responseType });
    assert.equal(result.reused, true);
    assert.equal(requests, 1);
    assert.match(flow.logs.at(-1), new RegExp(`HTTP ${status}，响应类型 ${responseType}`));
  }
});
