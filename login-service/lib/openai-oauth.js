import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { arch as osArch, platform as osPlatform, release as osRelease } from 'node:os';

export const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const OPENAI_CODEX_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
export const OPENAI_CODEX_REFRESH_SCOPE = 'openid profile email';
export const OPENAI_CODEX_ORIGINATOR = 'codex_cli_rs';
export const OPENAI_CODEX_COMPAT_VERSION = '0.172.0';

function codexOsType(platform) {
  return ({ win32: 'Windows', darwin: 'Mac OS', linux: 'Linux' })[platform] || platform || 'Unknown';
}

function codexArchitecture(architecture) {
  return ({ x64: 'x86_64', arm64: 'aarch64' })[architecture] || architecture || 'unknown';
}

export function buildOpenAICodexUserAgent({
  platform = osPlatform(),
  release = osRelease(),
  architecture = osArch(),
  terminal = 'unknown',
  version = OPENAI_CODEX_COMPAT_VERSION,
} = {}) {
  const candidate = `${OPENAI_CODEX_ORIGINATOR}/${version} (${codexOsType(platform)} ${release}; ${codexArchitecture(architecture)}) ${terminal}`;
  return candidate.replace(/[^\x20-\x7E]/g, '_');
}

const configuredOpenAIUserAgent = String(process.env.OPENAI_CODEX_USER_AGENT || '').trim();
export const OPENAI_CODEX_USER_AGENT = /^[\x20-\x7E]{1,200}$/.test(configuredOpenAIUserAgent)
  ? configuredOpenAIUserAgent
  : buildOpenAICodexUserAgent();
export const OPENAI_OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';

const KNOWN_OAUTH_ERROR_CODES = new Set([
  'access_denied',
  'account_selection_required',
  'consent_required',
  'interaction_required',
  'invalid_client',
  'invalid_grant',
  'invalid_request',
  'invalid_scope',
  'invalid_token',
  'login_required',
  'server_error',
  'temporarily_unavailable',
  'unauthorized_client',
  'unsupported_grant_type',
  'unsupported_response_type',
]);

export function safeOAuthErrorCode(value) {
  const candidate = value && typeof value === 'object' ? value.code : value;
  const code = String(candidate || '').trim().toLowerCase();
  return KNOWN_OAUTH_ERROR_CODES.has(code) ? code : 'unknown_error';
}

export function safeOAuthEndpoint(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return 'configured-token-endpoint';
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'configured-token-endpoint';
  }
}

export async function formatSafeOAuthErrorResponse(response) {
  const statusValue = Number(response?.status);
  const status = Number.isInteger(statusValue) && statusValue >= 100 && statusValue <= 599
    ? statusValue
    : 'unknown';
  let payload = {};
  try {
    const body = await response.text();
    payload = JSON.parse(body);
  } catch {}
  return `HTTP ${status} error=${safeOAuthErrorCode(payload?.error)}`;
}

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
    originator: OPENAI_CODEX_ORIGINATOR,
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

export function parseOpenAICallback(callbackUrl, expectedState, redirectUri = OPENAI_CODEX_REDIRECT_URI) {
  let url;
  let expectedRedirect;
  try {
    url = new URL(callbackUrl);
    expectedRedirect = new URL(redirectUri);
  } catch {
    throw new Error('OpenAI OAuth 回调地址无效');
  }
  const endpointMatches = url.origin === expectedRedirect.origin
    && url.pathname === expectedRedirect.pathname
    && !url.username
    && !url.password
    && !url.hash;
  if (!endpointMatches) throw new Error('OpenAI OAuth 回调地址不匹配');
  const error = url.searchParams.get('error') || '';
  if (error) {
    throw new Error(`OpenAI OAuth 回调失败: ${safeOAuthErrorCode(error)}`);
  }
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  if (!code) throw new Error('OpenAI OAuth 回调缺少 code');
  if (!state) throw new Error('OpenAI OAuth 回调缺少 state');
  if (!oauthStateMatches(expectedState, state)) throw new Error('callback state 不匹配');
  return { callbackURL: `${url.origin}${url.pathname}`, code, state };
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
