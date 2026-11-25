import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_ORIGINATOR,
  OPENAI_CODEX_REFRESH_SCOPE,
  OPENAI_CODEX_USER_AGENT,
  buildAuthorizationCodeTokenBody,
  buildOpenAIAuthorizationUrl,
  buildRefreshTokenBody,
  generateOpenAIPkce,
  oauthStateMatches,
  parseOpenAICallback,
} from './openai-oauth.js';

test('Codex OAuth identity headers follow the current Rust client shape', () => {
  assert.equal(OPENAI_CODEX_ORIGINATOR, 'codex_cli_rs');
  assert.match(OPENAI_CODEX_USER_AGENT, /^codex_cli_rs\/0\.172\.0 \(.+; (?:x86_64|aarch64|unknown)\) .+$/);
  assert.doesNotMatch(OPENAI_CODEX_USER_AGENT, /codex-cli\/0\.91\.0/);
});

test('Codex PKCE uses sub2api-compatible hex verifier and state', () => {
  const { state, codeVerifier, codeChallenge } = generateOpenAIPkce(size => Buffer.alloc(size, 0xab));
  assert.equal(state.length, 64);
  assert.equal(codeVerifier.length, 128);
  assert.match(state, /^[a-f0-9]+$/);
  assert.match(codeVerifier, /^[a-f0-9]+$/);
  assert.match(codeChallenge, /^[A-Za-z0-9_-]+$/);
});

test('authorization URL contains Codex simplified flow parameters', () => {
  const url = new URL(buildOpenAIAuthorizationUrl({
    state: 'state',
    codeChallenge: 'challenge',
    loginHint: 'user@example.com',
    prompt: 'login',
  }));
  assert.equal(url.searchParams.get('client_id'), OPENAI_CODEX_CLIENT_ID);
  assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');
  assert.equal(url.searchParams.get('id_token_add_organizations'), 'true');
  assert.equal(url.searchParams.get('originator'), 'codex_cli_rs');
  assert.deepEqual(
    new Set(String(url.searchParams.get('scope') || '').split(/\s+/).filter(Boolean)),
    new Set(['openid', 'profile', 'email', 'offline_access', 'api.connectors.read', 'api.connectors.invoke']),
  );
  assert.equal(url.searchParams.get('login_hint'), 'user@example.com');
});

test('callback validates state and reports OAuth errors', () => {
  assert.equal(parseOpenAICallback('http://localhost:1455/auth/callback?code=abc&state=state', 'state').code, 'abc');
  assert.equal(oauthStateMatches('state', 'state'), true);
  assert.equal(oauthStateMatches('state', 'other'), false);
  const descriptionSecret = 'callback-description-secret';
  assert.throws(() => parseOpenAICallback(
    `http://localhost:1455/auth/callback?error=access_denied&error_description=${descriptionSecret}`,
    'state',
  ), error => {
    assert.match(error.message, /access_denied/);
    assert.doesNotMatch(error.message, new RegExp(descriptionSecret));
    return true;
  });
  const errorSecret = 'callback-error-secret';
  assert.throws(() => parseOpenAICallback(
    `http://localhost:1455/auth/callback?error=${errorSecret}`,
    'state',
  ), error => {
    assert.match(error.message, /unknown_error/);
    assert.doesNotMatch(error.message, new RegExp(errorSecret));
    return true;
  });
});

test('callback rejects unexpected endpoints without echoing callback secrets', () => {
  const secretCode = 'secret-authorization-code';
  for (const callback of [
    `https://attacker.example/auth/callback?code=${secretCode}&state=state`,
    `http://localhost:1455/not-the-callback?code=${secretCode}&state=state`,
    `not-a-url-${secretCode}`,
  ]) {
    assert.throws(
      () => parseOpenAICallback(callback, 'state'),
      error => {
        assert.doesNotMatch(error.message, new RegExp(secretCode));
        return true;
      },
    );
  }
});

test('callback missing fields never echoes its raw URL or authorization code', () => {
  const secretCode = 'secret-missing-state-code';
  assert.throws(
    () => parseOpenAICallback(`http://localhost:1455/auth/callback?code=${secretCode}`, 'state'),
    error => {
      assert.match(error.message, /state/);
      assert.doesNotMatch(error.message, new RegExp(secretCode));
      assert.doesNotMatch(error.message, /localhost:1455/);
      return true;
    },
  );
});

test('token forms match latest sub2api Codex OAuth flow', () => {
  const exchange = buildAuthorizationCodeTokenBody('code', 'verifier');
  assert.equal(exchange.get('client_id'), OPENAI_CODEX_CLIENT_ID);
  assert.equal(exchange.get('code_verifier'), 'verifier');
  const refresh = buildRefreshTokenBody('rt-token');
  assert.equal(refresh.get('scope'), OPENAI_CODEX_REFRESH_SCOPE);
});
