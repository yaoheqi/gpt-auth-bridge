import {
  OPENAI_AGENT_AUTH_MODE,
  isAgentIdentityRecord,
} from './openai-agent-identity.js';
import {
  decodeJwtPayload,
  firstNonEmpty,
  getNestedRecord,
  parseExpiredTime,
  resolveOrganizationId,
} from './jwt-utils.js';
import { sub2ApiAccountDefaults } from './sub2api-settings.js';

export const SUB2API_DEFAULT_EXPIRES_IN = 864000;
export const SUB2API_SCHEMA_VERSION = 1;

function resolveAccountDefaults(settings = {}) {
  const envDefaults = {
    accountConcurrency: process.env.SUB2API_CONCURRENCY,
    priority: process.env.SUB2API_PRIORITY,
    loadFactor: process.env.SUB2API_LOAD_FACTOR,
    rateMultiplier: process.env.SUB2API_RATE_MULTIPLIER,
    fingerprintMode: process.env.SUB2API_FINGERPRINT_MODE,
    models: process.env.SUB2API_MODELS,
  };
  const defaults = sub2ApiAccountDefaults({ ...envDefaults, ...settings });
  return { ...defaults, modelMapping: Object.fromEntries(defaults.models.map(model => [model, model])) };
}

export function buildSub2ApiAccount(record, settings = {}) {
  const defaults = resolveAccountDefaults(settings);
  if (isAgentIdentityRecord(record)) {
    const email = String(record.email || '');
    return {
      name: email || `openai-${Date.now()}`,
      platform: 'openai',
      type: 'oauth',
      credentials: {
        auth_mode: OPENAI_AGENT_AUTH_MODE,
        agent_runtime_id: String(record.agent_runtime_id),
        agent_private_key: String(record.agent_private_key),
        chatgpt_account_id: String(record.account_id),
        chatgpt_user_id: String(record.chatgpt_user_id),
        chatgpt_account_is_fedramp: Boolean(record.chatgpt_account_is_fedramp),
        email,
        plan_type: String(record.plan_type || 'free'),
        model_mapping: { ...defaults.modelMapping },
        task_id: String(record.task_id || `task-${String(record.agent_runtime_id).replace(/^agent-/, '')}`),
      },
      extra: { email, codex_fingerprint_mode: defaults.fingerprintMode },
      concurrency: defaults.concurrency,
      priority: defaults.priority,
      load_factor: defaults.loadFactor,
      rate_multiplier: defaults.rateMultiplier,
      auto_pause_on_expired: false,
    };
  }
  const accessClaims = decodeJwtPayload(record.access_token);
  const idClaims = decodeJwtPayload(record.id_token);
  const accessAuth = getNestedRecord(accessClaims, 'https://api.openai.com/auth');
  const idAuth = getNestedRecord(idClaims, 'https://api.openai.com/auth');
  const accessProfile = getNestedRecord(accessClaims, 'https://api.openai.com/profile');
  const expiresAt = parseExpiredTime(record.expired) || Number(accessClaims.exp || 0);
  const issuedAt = Number(accessClaims.iat || 0);
  const expiresIn = expiresAt && issuedAt ? Math.max(expiresAt - issuedAt, 0) : SUB2API_DEFAULT_EXPIRES_IN;
  const email = firstNonEmpty(record.email, accessProfile.email, idClaims.email, accessClaims.email);
  const accountId = firstNonEmpty(record.account_id, accessAuth.chatgpt_account_id, idAuth.chatgpt_account_id);
  const planType = firstNonEmpty(record.plan_type, accessAuth.chatgpt_plan_type, idAuth.chatgpt_plan_type, 'free');

  return {
    name: email || `openai-${Date.now()}`,
    platform: 'openai',
    type: 'oauth',
    credentials: {
      access_token: String(record.access_token || ''),
      refresh_token: String(record.refresh_token || ''),
      id_token: String(record.id_token || ''),
      chatgpt_account_id: accountId,
      account_id: accountId,
      chatgpt_user_id: firstNonEmpty(accessAuth.chatgpt_user_id, accessAuth.user_id, accessClaims.sub),
      email,
      expires_at: expiresAt,
      expires_in: expiresIn,
      organization_id: resolveOrganizationId(idClaims, accessClaims),
      plan_type: planType,
      model_mapping: { ...defaults.modelMapping },
    },
    extra: { email, source: String(record?.extra?.source || record?.source || 'codex-sms-auth'), codex_fingerprint_mode: defaults.fingerprintMode, ...(record?.extra?.workspace_id ? { workspace_id: String(record.extra.workspace_id) } : {}) },
    concurrency: defaults.concurrency,
    priority: defaults.priority,
    load_factor: defaults.loadFactor,
    rate_multiplier: defaults.rateMultiplier,
    auto_pause_on_expired: true,
  };
}

export function buildSub2ApiExport(records, exportedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), settings = {}) {
  return {
    type: 'sub2api-data',
    version: SUB2API_SCHEMA_VERSION,
    exported_at: exportedAt,
    proxies: [],
    accounts: records.map(record => buildSub2ApiAccount(record, settings)),
  };
}

export function buildSub2ApiJson(record, settings = {}) {
  return buildSub2ApiExport([record], new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), settings);
}

/** Soft validation used by tests / export path. */
export function assertSub2ApiAccountShape(account, { requireRefreshToken = true } = {}) {
  if (!account || typeof account !== 'object') throw new Error('account must be object');
  if (account.platform !== 'openai') throw new Error('platform must be openai');
  if (account.type !== 'oauth') throw new Error('type must be oauth');
  const creds = account.credentials;
  if (!creds || typeof creds !== 'object' || Array.isArray(creds)) throw new Error('credentials 必须是对象');
  if (creds.auth_mode) {
    if (!creds.agent_runtime_id || !creds.agent_private_key) {
      throw new Error('agent credentials require agent_runtime_id and agent_private_key');
    }
    return 'agent';
  }
  const hasToken = key => typeof creds[key] === 'string' && Boolean(creds[key].trim());
  if (!hasToken('access_token')) throw new Error('缺少有效的 credentials.access_token');
  if (requireRefreshToken && !hasToken('refresh_token')) throw new Error('缺少有效的 credentials.refresh_token');
  return hasToken('refresh_token') ? 'rt' : 'access-token';
}
