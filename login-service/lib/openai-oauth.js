import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const OPENAI_CODEX_SCOPE = 'openid profile email offline_access';
export const OPENAI_CODEX_REFRESH_SCOPE = 'openid profile email';
export const OPENAI_CODEX_USER_AGENT = 'codex-cli/0.91.0';
export const OPENAI_OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';

export function generateOpenAIPkce(randomBytesImpl = randomBytes) {
  const state = randomBytesImpl(32).toString('hex');
  const codeVerifier = randomBytesImpl(64).toString('hex');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { state, codeVerifier, codeChallenge };
}

export function buildOpenAIAuthorizationUrl({
  state,
  codeChallenge,
  redirectUri = OPENAI_CODEX_REDIRECT_URI,
  loginHint = '',
  prompt = '',
} = {}) {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: OPENAI_CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: OPENAI_CODEX_SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  });
  if (prompt) query.set('prompt', prompt);
  if (loginHint) query.set('login_hint', loginHint);
  return `${OPENAI_OAUTH_AUTHORIZE_URL}?${query.toString()}`;
}

export function oauthStateMatches(expected, actual) {
  const expectedBuffer = Buffer.from(String(expected || ''), 'utf8');
  const actualBuffer = Buffer.from(String(actual || ''), 'utf8');
  return expectedBuffer.length > 0
    && expectedBuffer.length === actualBuffer.length
    && timingSafeEqual(expectedBuffer, actualBuffer);
}

export function parseOpenAICallback(callbackUrl, expectedState) {
  const url = new URL(callbackUrl);
  const error = url.searchParams.get('error') || '';
  if (error) {
    const description = url.searchParams.get('error_description') || '';
    throw new Error(`OpenAI OAuth 回调失败: ${error}${description ? ` (${description})` : ''}`);
  }
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  if (!code) throw new Error(`callback 中缺少 code: ${callbackUrl}`);
  if (!state) throw new Error(`callback 中缺少 state: ${callbackUrl}`);
  if (!oauthStateMatches(expectedState, state)) throw new Error('callback state 不匹配');
  return { callbackURL: callbackUrl, code, state };
}

export function buildAuthorizationCodeTokenBody(code, codeVerifier, redirectUri = OPENAI_CODEX_REDIRECT_URI) {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: OPENAI_CODEX_CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
}

export function buildRefreshTokenBody(refreshToken) {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: OPENAI_CODEX_CLIENT_ID,
    refresh_token: refreshToken,
    scope: OPENAI_CODEX_REFRESH_SCOPE,
  });
}
