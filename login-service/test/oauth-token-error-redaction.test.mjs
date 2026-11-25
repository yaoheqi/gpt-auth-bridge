import assert from 'node:assert/strict';
import test from 'node:test';

import { createOAuthNavigationMethods } from '../src/services/auth/flow/oauth-navigation.js';
import { createWebSessionMethods } from '../src/services/auth/flow/web-session.js';
import { OPENAI_CODEX_ORIGINATOR, OPENAI_CODEX_USER_AGENT } from '../lib/openai-oauth.js';

const endpointSecret = 'url-query-secret';
const tokenURL = `https://oauth-user:oauth-password@auth.openai.com/oauth/token?credential=${endpointSecret}`;

function flowForFailure(fetch) {
  const methods = createOAuthNavigationMethods({
    AUTH_OAUTH_TOKEN_URLS: [tokenURL],
  });
  return {
    ...methods,
    account: { email: 'user@example.com' },
    assertNonPersonalWorkspace() {},
    codeVerifier: 'fixture-code-verifier',
    fetch,
    log() {},
    requireNonPersonal: false,
  };
}

async function readFailure(fetch) {
  const flow = flowForFailure(fetch);
  try {
    await flow.exchangeCodeForToken('authorization-code-secret');
    assert.fail('token exchange should fail');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function assertEndpointSecretsRedacted(message) {
  assert.match(message, /endpoint=https:\/\/auth\.openai\.com\/oauth\/token/);
  assert.doesNotMatch(message, /oauth-user/);
  assert.doesNotMatch(message, /oauth-password/);
  assert.doesNotMatch(message, new RegExp(endpointSecret));
  assert.doesNotMatch(message, /authorization-code-secret/);
}

test('authorization-code exchange keeps only known JSON OAuth error metadata', async () => {
  const responseSecret = 'json-provider-response-secret';
  const message = await readFailure(async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({
      error: 'invalid_grant',
      error_description: responseSecret,
      echoed_code: 'authorization-code-secret',
    }),
  }));

  assert.match(message, /HTTP 400 error=invalid_grant/);
  assert.doesNotMatch(message, new RegExp(responseSecret));
  assertEndpointSecretsRedacted(message);
});

test('authorization-code exchange redacts non-JSON bodies and network errors', async () => {
  const bodySecret = 'plain-text-provider-secret';
  const bodyMessage = await readFailure(async () => ({
    ok: false,
    status: 502,
    text: async () => `upstream failure ${bodySecret}`,
  }));
  assert.match(bodyMessage, /HTTP 502 error=unknown_error/);
  assert.doesNotMatch(bodyMessage, new RegExp(bodySecret));
  assertEndpointSecretsRedacted(bodyMessage);

  const networkSecret = 'network-error-secret';
  const networkMessage = await readFailure(async () => {
    throw new Error(`request failed ${networkSecret} ${tokenURL}`);
  });
  assert.match(networkMessage, /network_error/);
  assert.doesNotMatch(networkMessage, new RegExp(networkSecret));
  assertEndpointSecretsRedacted(networkMessage);
});

test('authorization-code exchange redacts an invalid successful response', async () => {
  const parseSecret = 'successful-response-parse-secret';
  const message = await readFailure(async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new Error(`invalid body ${parseSecret}`); },
  }));
  assert.match(message, /HTTP 200 error=invalid_response/);
  assert.doesNotMatch(message, new RegExp(parseSecret));
  assertEndpointSecretsRedacted(message);
});

test('authorization-code exchange sends matching Codex originator and user agent headers', async () => {
  let headers;
  const methods = createOAuthNavigationMethods({
    AUTH_OAUTH_TOKEN_URLS: ['https://auth.openai.com/oauth/token'],
    normalizeOpenAIAuthRecord: () => ({ ok: true }),
  });
  const flow = {
    ...methods,
    account: { email: 'user@example.com' },
    assertNonPersonalWorkspace() {},
    codeVerifier: 'fixture-code-verifier',
    fetch: async (_url, options) => {
      headers = options.headers;
      return { ok: true, status: 200, json: async () => ({ access_token: 'fixture' }) };
    },
    log() {},
    requireNonPersonal: false,
  };
  assert.deepEqual(await flow.exchangeCodeForToken('fixture-code'), { ok: true });
  assert.equal(headers.originator, OPENAI_CODEX_ORIGINATOR);
  assert.equal(headers['user-agent'], OPENAI_CODEX_USER_AGENT);
});

function redirectFlow(fetch) {
  const methods = createOAuthNavigationMethods({ AUTH_OAUTH_TOKEN_URLS: [] });
  return {
    ...methods,
    assertSupportedAuthStep() {},
    browserHeaders: headers => headers,
    fetch,
    isEmailCodeChallenge: () => false,
    isPhoneChallengeUrl: () => false,
  };
}

test('OAuth navigation errors redact callback query, userinfo, and fragment', async () => {
  const navigationSecret = 'navigation-code-secret';
  const unsafeURL = `https://nav-user:nav-password@auth.openai.com/not-callback?code=${navigationSecret}#state-secret`;
  const noRedirect = redirectFlow(async () => ({
    headers: { get: () => null },
    status: 400,
    url: unsafeURL,
  }));
  await assert.rejects(
    noRedirect.followOAuthRedirects('https://auth.openai.com/start'),
    error => {
      assert.match(error.message, /url=https:\/\/auth\.openai\.com\/not-callback/);
      assert.doesNotMatch(error.message, /nav-user|nav-password|navigation-code-secret|state-secret/);
      return true;
    },
  );

  const redirectLoop = redirectFlow(async () => ({
    headers: { get: () => unsafeURL },
    status: 302,
    url: unsafeURL,
  }));
  await assert.rejects(
    redirectLoop.followOAuthRedirects('https://auth.openai.com/start'),
    error => {
      assert.match(error.message, /https:\/\/auth\.openai\.com\/not-callback/);
      assert.doesNotMatch(error.message, /nav-user|nav-password|navigation-code-secret|state-secret/);
      return true;
    },
  );
});

test('ChatGPT web redirect errors redact query, userinfo, and fragment', async () => {
  const navigationSecret = 'chatgpt-navigation-secret';
  const unsafeURL = `https://nav-user:nav-password@example.com/incomplete?code=${navigationSecret}#state-secret`;
  const methods = createWebSessionMethods();
  const flow = {
    ...methods,
    advanceAuthStep: () => assert.fail('unexpected auth step'),
    assertSupportedAuthStep() {},
    browserHeaders: headers => headers,
    extractOAuthCodeFromUrl: () => '',
    fetch: async () => ({ headers: { get: () => null }, status: 400, url: unsafeURL }),
    isAuthStartUrl: () => false,
    isChatGptUrl: () => false,
    isConsentUrl: () => false,
    isPhoneChallengeUrl: () => false,
  };
  await assert.rejects(
    flow.followChatGptWebSession('https://example.com/start'),
    error => {
      assert.match(error.message, /url=https:\/\/example\.com\/incomplete/);
      assert.doesNotMatch(error.message, /nav-user|nav-password|chatgpt-navigation-secret|state-secret/);
      return true;
    },
  );
});
