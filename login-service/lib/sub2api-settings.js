export const SUB2API_DEFAULT_MODELS = Object.freeze([
  'gpt-5.5',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-6-astra',
]);

export const SUB2API_FINGERPRINT_MODES = Object.freeze(['off', 'device', 'session', 'full']);

function clampNumber(value, fallback, minimum, maximum, { integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const bounded = Math.max(minimum, Math.min(maximum, parsed));
  return integer ? Math.round(bounded) : bounded;
}

function uniqueStrings(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  return [...new Set(source.map(item => String(item || '').trim()).filter(Boolean))];
}

export function normalizeSub2ApiGroupIds(value) {
  return uniqueStrings(value).filter(item => /^\d+$/.test(item)).map(Number);
}

export function readSub2ApiSettingsDefaults(env = process.env) {
  const legacyGroup = String(env.SUB2API_GROUP_ID || env.SUB2API_GROUP_NAME || '').trim();
  return normalizeSub2ApiSettings({
    baseUrl: env.SUB2API_BASE_URL,
    adminApiKey: env.SUB2API_ADMIN_API_KEY,
    groupIds: /^\d+$/.test(legacyGroup) ? [legacyGroup] : [],
    legacyGroupName: /^\d+$/.test(legacyGroup) ? '' : legacyGroup,
    accountConcurrency: env.SUB2API_CONCURRENCY,
    priority: env.SUB2API_PRIORITY,
    loadFactor: env.SUB2API_LOAD_FACTOR,
    fingerprintMode: env.SUB2API_FINGERPRINT_MODE,
    models: env.SUB2API_MODELS,
  });
}

export function normalizeSub2ApiSettings(value = {}, defaults = {}) {
  const merged = { ...defaults, ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}) };
  const requestedModels = uniqueStrings(merged.models);
  const legacyGroupName = String(merged.legacyGroupName || merged.legacy_group_name || merged.groupName || '').trim();
  const explicitGroupIds = normalizeSub2ApiGroupIds(merged.groupIds ?? merged.group_ids);
  const legacyGroupIds = normalizeSub2ApiGroupIds(legacyGroupName);
  const groupIds = explicitGroupIds.length ? explicitGroupIds : legacyGroupIds;
  return {
    baseUrl: String(merged.baseUrl || merged.base_url || '').trim().replace(/\/+$/, ''),
    adminApiKey: String(merged.adminApiKey || merged.admin_api_key || '').trim(),
    groupIds,
    legacyGroupName: groupIds.length ? '' : legacyGroupName,
    accountConcurrency: clampNumber(merged.accountConcurrency ?? merged.concurrency, 50, 1, 100, { integer: true }),
    priority: clampNumber(merged.priority, 1, 1, 100, { integer: true }),
    loadFactor: clampNumber(merged.loadFactor ?? merged.load_factor, 1, 1, 10000, { integer: true }),
    rateMultiplier: clampNumber(merged.rateMultiplier ?? merged.rate_multiplier, 1, 0, 100000),
    fingerprintMode: SUB2API_FINGERPRINT_MODES.includes(String(merged.fingerprintMode || merged.fingerprint_mode || '').trim())
      ? String(merged.fingerprintMode || merged.fingerprint_mode).trim()
      : 'full',
    models: requestedModels.length ? requestedModels : [...SUB2API_DEFAULT_MODELS],
  };
}

export function publicSub2ApiSettings(value = {}) {
  const settings = normalizeSub2ApiSettings(value);
  const key = settings.adminApiKey;
  return {
    ...settings,
    adminApiKey: undefined,
    keyConfigured: Boolean(key),
    keyMasked: key ? `${key.slice(0, 3)}***${key.length > 7 ? key.slice(-4) : ''}` : '',
  };
}

export function sub2ApiAccountDefaults(value = {}) {
  const settings = normalizeSub2ApiSettings(value);
  return {
    concurrency: settings.accountConcurrency,
    priority: settings.priority,
    loadFactor: settings.loadFactor,
    rateMultiplier: settings.rateMultiplier,
    fingerprintMode: settings.fingerprintMode,
    models: settings.models,
  };
}
