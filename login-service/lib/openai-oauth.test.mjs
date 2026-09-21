import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_REFRESH_SCOPE,
  buildAuthorizationCodeTokenBody,
  buildOpenAIAuthorizationUrl,
  buildRefreshTokenBody,
  generateOpenAIPkce,
  oauthStateMatches,
  parseOpenAICallback,
} from './openai-oauth.js';

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
  assert.equal(url.searchParams.get('login_hint'), 'user@example.com');
});

test('callback validates state and reports OAuth errors', () => {
  assert.equal(parseOpenAICallback('http://localhost:1455/auth/callback?code=abc&state=state', 'state').code, 'abc');
  assert.equal(oauthStateMatches('state', 'state'), true);
  assert.equal(oauthStateMatches('state', 'other'), false);
  assert.throws(
    () => parseOpenAICallback('http://localhost:1455/auth/callback?error=access_denied&error_description=nope', 'state'),
    /access_denied.*nope/,
  );
});

test('token forms match latest sub2api Codex OAuth flow', () => {
  const exchange = buildAuthorizationCodeTokenBody('code', 'verifier');
  assert.equal(exchange.get('client_id'), OPENAI_CODEX_CLIENT_ID);
  assert.equal(exchange.get('code_verifier'), 'verifier');
  const refresh = buildRefreshTokenBody('rt-token');
  assert.equal(refresh.get('scope'), OPENAI_CODEX_REFRESH_SCOPE);
});
