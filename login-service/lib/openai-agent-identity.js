import { generateKeyPairSync } from 'crypto';

export const OPENAI_AGENT_REGISTER_URL = 'https://auth.openai.com/api/accounts/v1/agent/register';
export const OPENAI_AGENT_AUTH_MODE = 'agentIdentity';

function decodeBase64UrlJson(segment, label) {
  try {
    const value = JSON.parse(Buffer.from(String(segment || ''), 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new Error(`${label} 不是有效 JSON`);
  }
}

function nestedObject(value, key) {
  const nested = value?.[key];
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : {};
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

export function validateOpenAIAccessToken(accessToken, nowSeconds = Math.floor(Date.now() / 1000)) {
  const token = String(accessToken || '').trim();
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !part)) throw new Error('access_token 不是有效 JWT');

  const header = decodeBase64UrlJson(parts[0], 'access_token JWT header');
  const claims = decodeBase64UrlJson(parts[1], 'access_token JWT payload');
  if (!header.alg || String(header.alg).toLowerCase() === 'none') throw new Error('access_token JWT 签名算法无效');
  const auth = nestedObject(claims, 'https://api.openai.com/auth');
  const profile = nestedObject(claims, 'https://api.openai.com/profile');
  const expiresAt = Number(claims.exp || 0);
  if (!expiresAt) throw new Error('access_token JWT 缺少 exp');
  if (expiresAt <= nowSeconds) throw new Error('access_token JWT 已过期');

  const accountId = firstNonEmpty(auth.chatgpt_account_id, auth.account_id);
  const userId = firstNonEmpty(auth.chatgpt_user_id, auth.user_id, claims.sub);
  if (!accountId) throw new Error('access_token JWT 缺少 chatgpt_account_id');
  if (!userId) throw new Error('access_token JWT 缺少 chatgpt_user_id');

  return {
    token,
    header,
    claims,
    accountId,
    userId,
    email: firstNonEmpty(profile.email, claims.email),
    planType: firstNonEmpty(auth.chatgpt_plan_type, 'free'),
    isFedramp: Boolean(auth.chatgpt_account_is_fedramp || auth.is_fedramp),
    expiresAt,
  };
}

function sshString(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export function generateAgentKeyMaterial() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyDer = privateKey.export({ format: 'der', type: 'pkcs8' });
  const publicJwk = publicKey.export({ format: 'jwk' });
  const publicKeyRaw = Buffer.from(String(publicJwk.x || ''), 'base64url');
  if (publicKeyRaw.length !== 32) throw new Error('生成的 Ed25519 公钥长度无效');
  const sshBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(publicKeyRaw)]);
  return {
    privateKeyPkcs8Base64: Buffer.from(privateKeyDer).toString('base64'),
    publicKeySsh: `ssh-ed25519 ${sshBlob.toString('base64')}`,
  };
}

export async function registerOpenAIAgentIdentity({
  accessToken,
  email = '',
  fetchImpl = fetch,
  registerUrl = OPENAI_AGENT_REGISTER_URL,
  agentVersion = process.env.CODEX_AGENT_VERSION || '0.145.0',
  runningLocation = process.env.CODEX_AGENT_RUNNING_LOCATION || `cli-${process.platform === 'win32' ? 'windows' : process.platform}`,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持 fetch');
  const identity = validateOpenAIAccessToken(accessToken);
  const keyMaterial = generateAgentKeyMaterial();
  const requestBody = JSON.stringify({
    abom: {
      agent_version: agentVersion,
      agent_harness_id: 'codex-cli',
      running_location: runningLocation,
    },
    agent_public_key: keyMaterial.publicKeySsh,
    capabilities: ['responsesapi'],
    ttl: null,
  });
  let response;
  let responseText = '';
  let payload = {};
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetchImpl(registerUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${identity.token}`,
          'content-type': 'application/json',
          ...(identity.isFedramp ? { 'X-OpenAI-Fedramp': 'true' } : {}),
        },
        body: requestBody,
      });
    } catch (error) {
      if (attempt < 3) continue;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Agent Identity 注册请求失败: ${message}`);
    }
    responseText = await response.text();
    payload = {};
    try { payload = responseText ? JSON.parse(responseText) : {}; } catch {}
    if (response.ok) break;
    if (attempt >= 3 || (response.status !== 429 && response.status < 500)) {
      const detail = firstNonEmpty(payload?.error?.message, payload?.error, payload?.message, responseText.slice(0, 512));
      throw new Error(`Agent Identity 注册失败: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
    }
  }
  const runtimeId = firstNonEmpty(payload.agent_runtime_id, payload.agentRuntimeId);
  if (!runtimeId) throw new Error('Agent Identity 注册响应缺少 agent_runtime_id');

  return {
    auth_mode: OPENAI_AGENT_AUTH_MODE,
    agent_runtime_id: runtimeId,
    agent_private_key: keyMaterial.privateKeyPkcs8Base64,
    account_id: identity.accountId,
    chatgpt_user_id: identity.userId,
    email: firstNonEmpty(email, identity.email),
    plan_type: identity.planType,
    chatgpt_account_is_fedramp: identity.isFedramp,
  };
}

export function isAgentIdentityRecord(value) {
  return Boolean(
    value
    && String(value.auth_mode || '').toLowerCase() === OPENAI_AGENT_AUTH_MODE.toLowerCase()
    && value.agent_runtime_id
    && value.agent_private_key
    && value.account_id
    && value.chatgpt_user_id,
  );
}
