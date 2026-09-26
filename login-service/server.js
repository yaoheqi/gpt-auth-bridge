import { operationErrorPayload, sendOperationError } from './src/http/operation-error.js';
import { publicCodexAuthResult, publicSessionHealthResult } from './src/services/auth/auth-result-views.js';
import { nowIso } from './src/services/auth/auth-records.js';
import { createAuthenticationServices } from './src/services/auth/composition.js';
import { createAuthNetworkPolicy } from './src/services/auth/network-policy.js';
import { registerProtocolPipelineRoutes, registerBrowserSessionProbeRoute } from './src/api/routes/protocol-pipeline-routes.js';
import { registerWorkspaceSelfLeaveRoutes } from './src/api/routes/workspace-self-leave-routes.js';
import { registerProtocolLogoutAllRoutes } from './src/api/routes/protocol-logout-all-routes.js';
import { terminalLoginFailure } from './src/services/monitor-coordinator.js';
import { browserRequestMiddleware } from './src/services/browser-request-context.js';
import { requestScoped, requestSignal } from './src/services/request-scope.js';
import { setTimeout as requestDelay } from 'node:timers/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { configuredTaskConcurrency } from './lib/batch-concurrency.js';
import { OPENAI_OAUTH_TOKEN_URL } from './lib/openai-oauth.js';
import {
  SMSBOWER_COUNTRY_LABELS,
  SMSBOWER_COUNTRY_PRESETS,
  SMSBOWER_FAILS_BEFORE_SWITCH,
  SMSBOWER_OPENAI_SERVICE,
  SMSBOWER_PRICE_STEP,
} from './lib/smsbower.js';
import {
  FINGERPRINT_REGION_PROFILES,
  FINGERPRINT_REGIONS,
  buildBrowserHeadersFromFingerprint,
  generateFingerprint,
  mapCountryCodeToFingerprintRegion,
  normalizeFingerprintRegion,
  normalizeFingerprintRegionSetting,
} from './lib/device-fingerprint.js';
import {
  FIXED_LOCAL_PROXY_URL,
  configureProxyEnvironment,
  detectFixedProxyCountryCode,
  maskProxyUrl,
  parseProxyPool,
  resolveConfiguredProxyPool,
  resolveSessionProxy,
} from './lib/proxy-config.js';
import { httpWorkerStats, startHttpWorkers, closeHttpWorkers, createCurlCffiFetch } from './lib/curl-cffi-fetch.js';
import { preflightProxyEgress } from './lib/proxy-preflight.js';
import { browserWorkerPool } from './lib/browser-worker-pool.js';
import { createRuntimeDependencyCheck } from './src/services/runtime-dependencies.js';
import { proxyHealthRegistry } from './lib/proxy-health.js';
import { normalizeHumanTimingSettings, sampleHumanDelayMs } from './lib/human-timing.js';
import { isOpenAiRateLimitError } from './src/lib/openai-auth-error.js';
import { normalizeAuthMode, authModeToPhoneMode } from './src/lib/auth-mode.js';
import { normalizeFingerprintRecord, stringifyFingerprintRecord } from './src/lib/fingerprint-schema.js';
import { createDynamicSemaphore } from './lib/async-semaphore.js';
import { createSmsProviderClient, createCaptchaProviderClient } from './src/services/provider-client-factories.js';
import { OPENAI_STAGES, inferOpenAiStage } from './lib/account-stages.js';
import { SSEChannel, mapWithConcurrency } from './lib/sse.js';
import { probeChatGptSessionAccessToken, sessionHealthLabel } from './src/services/session-health-service.js';
import { buildSub2ApiExport, buildSub2ApiJson, assertSub2ApiAccountShape } from './lib/export-sub2api.js';
import { Sub2ApiClient } from './lib/sub2api-client.js';
import { normalizeSub2ApiSettings, publicSub2ApiSettings, readSub2ApiSettingsDefaults } from './lib/sub2api-settings.js';
import { normalizeSequentialExportPrefix, nextSequentialExportPrefix, buildPrefixedExportFileName } from './lib/export-filename.js';
import { createOpenAISentinelTokenFetcher } from './lib/openai-sentinel.js';
import { createRuntimePaths } from './src/config/runtime-paths.js';
import { validateStartupConfig } from './src/config/startup-config.js';
import { registerSystemRoutes } from './src/api/system-routes.js';
import { initializeRuntime } from './src/services/runtime-service.js';
import { createApp } from './src/app/create-app.js';
import { converterMiddleware } from '../src/converter.js';
import { startServer } from './src/start-server.js';
import {
  normalizeEmail,
  stripExportNamePrefix,
  accountHasChatGptSession,
  publicAccountView as projectPublicAccount,
  parseManagementImportLine,
} from './src/domain/accounts/account-domain.js';
import { createApiRetiredMiddleware } from './src/api/middleware/api-retired.js';
import { registerAdminSettingsRoutes } from './src/api/routes/admin-settings-routes.js';
import { wantsEventStream, runSseResponse } from './src/api/batch/sse-runner.js';
import { buildSessionHealthBatch } from './src/services/session-health-batch-service.js';
import { resolveProtocolLoginConcurrency } from './src/services/job-runner.js';
import { Sub2ApiPushService } from './src/services/sub2api-push-service.js';
import { buildStoredBusinessRtExportRecords, partitionRtExportCandidates } from './src/services/rt-export-service.js';
import { buildSessionCodexRtBatch, publicSessionCodexRtResult, runSessionCodexRtForAccounts } from './src/services/session-codex-rt-service.js';
import { hasStoredAuthCookies } from './src/services/cached-web-session.js';
import { normalizeBusinessWorkspaceIds, extractBusinessWorkspaceIds } from './lib/business-workspace.js';
import { registerConversionRoutes } from './src/api/routes/conversion-routes.js';
import { registerSessionExportRoutes } from './src/api/routes/session-export-routes.js';
import { registerRemotePushRoutes } from './lib/remote-push.js';
import { createSqliteRuntime, bindSqliteRuntimeToApp } from './src/bootstrap/sqlite-runtime.js';
import { createSettingsComposition } from './src/bootstrap/server-composition.js';
import { normalizeAccountIds, selectAccounts as selectAccountCollection } from './src/services/account-selection.js';

/** Limit SMSBower acquisition pressure without serializing unrelated accounts. */
const withSmsAcquireSemaphore = createDynamicSemaphore(
  () => getSmsBowerSettings().acquireConcurrency,
  { fallback: 2, max: 10 },
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The root entrypoint loads the application's .env before this module.
configureProxyEnvironment(process.env);
const runtimePaths = createRuntimePaths(process.env);

const app = createApp({ jsonLimit: '12mb' });
app.use(converterMiddleware);
registerRemotePushRoutes(app);
app.use(browserRequestMiddleware({
  strictRoutes: true,
  settings: () => settingsComposition.repository,
  createPushService: () => new Sub2ApiPushService(),
}));
const RETIRED_ROUTE = /^\/api\/v2\/(?:user(?:\/|$)|admin\/(?:login|logout|session|sms|smsbower|yescaptcha|app-settings)|accounts\/(?:register|logout-all|enroll-totp|check-plus-trial|reconcile-stages|[^/]+\/(?:sms|export-json|browser-register-result)))/;
app.use((req, res, next) => {
  if (RETIRED_ROUTE.test(req.path)) return res.status(404).json({ ok: false, error: '接口不存在' });
  return next();
});
app.get('/api/public-config', async (_req, res) => {
  try {
    await ensureAppSettings();
  } catch {}
  const authMode = getAuthMode();
  res.json({
    ok: true,
    authMode,
    authModeLabel: authMode === 'agent' ? 'Agent Identity' : 'refresh_token',
    ui: {
      eyebrow: process.env.USER_HERO_EYEBROW || 'Self Service',
      title: process.env.USER_HERO_TITLE || '账号自助取码',
      subtitle: process.env.USER_HERO_SUBTITLE || '请将购买到的账号信息粘贴到导入框，验证通过后即可自助使用相关功能。数据仅保存在当前浏览器。',
    },
  });
});

const startupConfig = validateStartupConfig(process.env);
const PORT = startupConfig.port;
const sqliteRuntime = createSqliteRuntime(runtimePaths);
let settingsRepository = null;

const accountRepository = requestScoped('accounts', sqliteRuntime.accounts);
sqliteRuntime.accounts = accountRepository;
const sub2ApiPushService = requestScoped('push', new Sub2ApiPushService());
const shutdownState = { value: false };
const getAllAccounts = () => accountRepository.listAll();
const dbReady = accountRepository.initialize().then(async () => {
  await syncSessionPlanTypes();
});
let runtimeReady = Promise.resolve();

const publicAccountView = account => projectPublicAccount(account, { sessionHealthLabel });

const requireAdmin = (_req, _res, next) => next();

app.use(createApiRetiredMiddleware());

const checkRuntimeDependencies = createRuntimeDependencyCheck();
registerSystemRoutes(app, {
  paths: runtimePaths,
  isShuttingDown: () => shutdownState.value,
  metrics: app.locals.metrics,
  workerStats: httpWorkerStats,
  readiness: {
    runtime: () => runtimeReady,
    repository: () => accountRepository.checkReady(),
    config: () => startupConfig,
    dependencies: checkRuntimeDependencies,
  },
});

async function ensureDatabase() {
  await accountRepository.ensureReady();
  await ensureAppSettings();
  await ensureSmsBowerSettings();
  await ensureProtocolSettings();
}

function findAccountByEmail(email) {
  const key = normalizeEmail(stripExportNamePrefix(email));
  return accountRepository.findByEmail(key);
}

function findAccountById(id) {
  return accountRepository.findById(id);
}

// ------------------------- OpenAI OAuth JSON 获取 -------------------------
const AUTH_OAUTH_TOKEN_URLS = [OPENAI_OAUTH_TOKEN_URL];
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const DEFAULT_DEVICE_PROFILE = {
  userAgent: DEFAULT_USER_AGENT,
  acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
  locale: 'zh-CN',
  languages: ['zh-CN', 'zh'],
  timezoneId: 'Asia/Shanghai',
  viewportWidth: 1365,
  viewportHeight: 768,
  screenWidth: 1366,
  screenHeight: 768,
  outerWidth: 1376,
  outerHeight: 860,
  deviceScaleFactor: 1,
  hardwareConcurrency: 8,
  deviceMemory: 8,
  jsHeapSizeLimit: 4294967296,
  platform: 'Win32',
  vendor: 'Google Inc.',
  maxTouchPoints: 0,
  hasTouch: false,
  isMobile: false,
  colorDepth: 24,
  pixelDepth: 24,
};
const DEFAULT_CLIENT_HINTS = {
  secChUa: '"Google Chrome";v="146", "Chromium";v="146", "Not.A/Brand";v="24"',
  secChUaFullVersionList: '"Google Chrome";v="146.0.0.0", "Chromium";v="146.0.0.0", "Not.A/Brand";v="24.0.0.0"',
  secChUaMobile: '?0',
  secChUaPlatform: '"Windows"',
  secChUaPlatformVersion: '"15.0.0"',
  secChViewportWidth: '"1365"',
};
/** Stable fingerprint used when randomFingerprint is disabled (legacy behavior). */
const STATIC_DEVICE_FINGERPRINT = {
  ...DEFAULT_DEVICE_PROFILE,
  chromeMajor: '146',
  chromeFull: '146.0.0.0',
  clientHints: { ...DEFAULT_CLIENT_HINTS },
  region: 'CN',
};
/** 单个手机号最长等码时间；超时取消并换号 */
const PHONE_OTP_WAIT_TIMEOUT_MS = Math.max(15000, Number(process.env.SMSBOWER_CODE_TIMEOUT_MS || 40000) || 40000);
const PHONE_OTP_POLL_INTERVAL_MS = Math.max(2000, Number(process.env.SMSBOWER_CODE_POLL_MS || 5000) || 5000);
const DEFAULT_OAUTH_BATCH_CONCURRENCY = configuredTaskConcurrency();

const DEFAULT_SMSBOWER_SETTINGS = {
  provider: String(process.env.SMS_PROVIDER || 'smsbower').trim().toLowerCase() === 'manual_sms' ? 'manual_sms' : 'smsbower',
  smsbowerApiKey: String(process.env.SMSBOWER_API_KEY || '').trim(),
  smsbowerApiBaseUrl: String(process.env.SMSBOWER_API_BASE_URL || 'https://smsbower.page/stubs/handler_api.php').trim(),
  manualApiKey: String(process.env.MANUAL_SMS_API_KEY || '').trim(),
  manualApiBaseUrl: String(process.env.MANUAL_SMS_API_BASE_URL || 'https://cdk.sms688.cc/api/v1/manual-sms').trim(),
  service: String(process.env.SMSBOWER_SERVICE || SMSBOWER_OPENAI_SERVICE).trim() || SMSBOWER_OPENAI_SERVICE,
  countries: String(process.env.SMSBOWER_COUNTRIES || process.env.SMSBOWER_COUNTRY || '')
    .split(/[,\s]+/)
    .map(item => item.trim())
    .filter(Boolean),
  maxPrice: String(process.env.SMSBOWER_MAX_PRICE || '0.05').trim() || '0.05',
  minPrice: String(process.env.SMSBOWER_MIN_PRICE || '').trim(),
  providerIds: String(process.env.SMSBOWER_PROVIDER_IDS || '').trim(),
  exceptProviderIds: String(process.env.SMSBOWER_EXCEPT_PROVIDER_IDS || '').trim(),
  phoneException: String(process.env.SMSBOWER_PHONE_EXCEPTION || '').trim(),
  numberAttempts: Math.max(1, Math.min(30, Number(process.env.SMSBOWER_NUMBER_ATTEMPTS || 3) || 3)),
  codeTimeoutMs: PHONE_OTP_WAIT_TIMEOUT_MS,
  acquireConcurrency: Math.max(1, Math.min(10, Number(process.env.SMSBOWER_ACQUIRE_CONCURRENCY || 2) || 2)),
  failsBeforeSwitch: Math.max(1, Math.min(10, Number(process.env.SMSBOWER_FAILS_BEFORE_SWITCH || SMSBOWER_FAILS_BEFORE_SWITCH) || SMSBOWER_FAILS_BEFORE_SWITCH)),
  priceStep: String(process.env.SMSBOWER_PRICE_STEP || SMSBOWER_PRICE_STEP).trim() || String(SMSBOWER_PRICE_STEP),
};

let smsbowerSettings = { ...DEFAULT_SMSBOWER_SETTINGS, countries: [...DEFAULT_SMSBOWER_SETTINGS.countries] };
let smsbowerSettingsReady = Promise.resolve();

function looksLikeManualSmsBaseUrl(value) {
  return /manual-sms|sms688\.cc/i.test(String(value || ''));
}

function normalizeSmsBowerSettings(value = {}) {
  const provider = String(value.provider ?? value.smsProvider ?? DEFAULT_SMSBOWER_SETTINGS.provider ?? 'smsbower').trim().toLowerCase() === 'manual_sms'
    ? 'manual_sms'
    : 'smsbower';
  const legacyApiKey = String(value.apiKey ?? value.api_key ?? '').trim();
  const legacyApiBaseUrl = String(value.apiBaseUrl ?? value.api_base_url ?? '').trim();
  const smsbowerApiKey = String(
    value.smsbowerApiKey
    ?? value.smsbower_api_key
    ?? (provider === 'smsbower' ? legacyApiKey : DEFAULT_SMSBOWER_SETTINGS.smsbowerApiKey)
    ?? '',
  ).trim();
  const manualApiKey = String(
    value.manualApiKey
    ?? value.manual_api_key
    ?? (provider === 'manual_sms' ? legacyApiKey : DEFAULT_SMSBOWER_SETTINGS.manualApiKey)
    ?? '',
  ).trim();
  const smsbowerApiBaseUrl = String(
    value.smsbowerApiBaseUrl
    ?? value.smsbower_api_base_url
    ?? (legacyApiBaseUrl && !looksLikeManualSmsBaseUrl(legacyApiBaseUrl) ? legacyApiBaseUrl : '')
    ?? DEFAULT_SMSBOWER_SETTINGS.smsbowerApiBaseUrl
    ?? '',
  ).trim() || 'https://smsbower.page/stubs/handler_api.php';
  const manualApiBaseUrl = String(
    value.manualApiBaseUrl
    ?? value.manual_api_base_url
    ?? (legacyApiBaseUrl && looksLikeManualSmsBaseUrl(legacyApiBaseUrl) ? legacyApiBaseUrl : '')
    ?? DEFAULT_SMSBOWER_SETTINGS.manualApiBaseUrl
    ?? '',
  ).trim() || 'https://cdk.sms688.cc/api/v1/manual-sms';
  // 空列表表示不限制国家，取号时按服务 + getPrices 最低价匹配
  const countries = Array.isArray(value.countries)
    ? value.countries.map(item => String(item || '').trim()).filter(Boolean)
    : String(value.countries || value.country || '')
      .split(/[,\s]+/)
      .map(item => item.trim())
      .filter(Boolean);
  const numberAttempts = Math.max(
    1,
    Math.min(
      30,
      Number(value.numberAttempts ?? value.number_attempts ?? DEFAULT_SMSBOWER_SETTINGS.numberAttempts) || DEFAULT_SMSBOWER_SETTINGS.numberAttempts,
    ),
  );
  const acquireConcurrency = Math.max(1, Math.min(10, Number(value.acquireConcurrency ?? value.acquire_concurrency ?? DEFAULT_SMSBOWER_SETTINGS.acquireConcurrency) || DEFAULT_SMSBOWER_SETTINGS.acquireConcurrency));
  const codeTimeoutMs = Math.max(
    15000,
    Math.min(300000, Number(value.codeTimeoutMs ?? value.code_timeout_ms ?? DEFAULT_SMSBOWER_SETTINGS.codeTimeoutMs) || DEFAULT_SMSBOWER_SETTINGS.codeTimeoutMs),
  );
  const failsBeforeSwitch = Math.max(
    1,
    Math.min(
      10,
      Number(value.failsBeforeSwitch ?? value.fails_before_switch ?? DEFAULT_SMSBOWER_SETTINGS.failsBeforeSwitch) || DEFAULT_SMSBOWER_SETTINGS.failsBeforeSwitch,
    ),
  );
  const activeApiKey = provider === 'manual_sms' ? manualApiKey : smsbowerApiKey;
  const activeApiBaseUrl = provider === 'manual_sms' ? manualApiBaseUrl : smsbowerApiBaseUrl;
  return {
    provider,
    apiKey: activeApiKey,
    apiBaseUrl: activeApiBaseUrl,
    smsbowerApiKey,
    smsbowerApiBaseUrl,
    manualApiKey,
    manualApiBaseUrl,
    service: String(value.service ?? DEFAULT_SMSBOWER_SETTINGS.service ?? SMSBOWER_OPENAI_SERVICE).trim() || SMSBOWER_OPENAI_SERVICE,
    countries,
    maxPrice: String(value.maxPrice ?? value.max_price ?? DEFAULT_SMSBOWER_SETTINGS.maxPrice ?? '0.05').trim() || '0.05',
    minPrice: String(value.minPrice ?? value.min_price ?? DEFAULT_SMSBOWER_SETTINGS.minPrice ?? '').trim(),
    providerIds: String(value.providerIds ?? value.provider_ids ?? DEFAULT_SMSBOWER_SETTINGS.providerIds ?? '').trim(),
    exceptProviderIds: String(value.exceptProviderIds ?? value.except_provider_ids ?? DEFAULT_SMSBOWER_SETTINGS.exceptProviderIds ?? '').trim(),
    phoneException: String(value.phoneException ?? value.phone_exception ?? DEFAULT_SMSBOWER_SETTINGS.phoneException ?? '').trim(),
    numberAttempts,
    codeTimeoutMs,
    acquireConcurrency,
    failsBeforeSwitch,
    priceStep: String(value.priceStep ?? value.price_step ?? DEFAULT_SMSBOWER_SETTINGS.priceStep ?? SMSBOWER_PRICE_STEP).trim() || String(SMSBOWER_PRICE_STEP),
  };
}

function publicSmsBowerSettings(settings = getSmsBowerSettings()) {
  settings = normalizeSmsBowerSettings(settings);
  const apiKey = String(settings.apiKey || '');
  const smsbowerApiKey = String(settings.smsbowerApiKey || '');
  const manualApiKey = String(settings.manualApiKey || '');
  const provider = String(settings.provider || 'smsbower').trim().toLowerCase() === 'manual_sms' ? 'manual_sms' : 'smsbower';
  const {
    apiKey: _apiKey,
    smsbowerApiKey: _smsbowerApiKey,
    manualApiKey: _manualApiKey,
    ...publicSettings
  } = settings;
  return {
    ...publicSettings,
    provider,
    providerLabel: provider === 'manual_sms' ? 'Manual SMS API' : 'SMSBower',
    apiKeyConfigured: Boolean(apiKey),
    apiKeyMasked: apiKey ? `${apiKey.slice(0, 4)}***${apiKey.slice(-4)}` : '',
    smsbowerApiKeyConfigured: Boolean(smsbowerApiKey),
    smsbowerApiKeyMasked: smsbowerApiKey ? `${smsbowerApiKey.slice(0, 4)}***${smsbowerApiKey.slice(-4)}` : '',
    manualApiKeyConfigured: Boolean(manualApiKey),
    manualApiKeyMasked: manualApiKey ? `${manualApiKey.slice(0, 4)}***${manualApiKey.slice(-4)}` : '',
    countryOptions: SMSBOWER_COUNTRY_PRESETS.map(id => ({
      id,
      label: SMSBOWER_COUNTRY_LABELS[id] || id,
    })),
    countryMode: settings.countries?.length ? 'manual' : 'auto_lowest_price',
    serviceName: settings.service === SMSBOWER_OPENAI_SERVICE ? 'OpenAI (ChatGPT)' : settings.service,
    providerOptions: [
      { value: 'smsbower', label: 'SMSBower', title: 'SMSBower' },
      { value: 'manual_sms', label: 'Manual SMS API', title: 'Manual SMS API' },
    ],
  };
}

async function loadSmsBowerSettings() {
  await settingsRepository.initialize();
  smsbowerSettings = settingsRepository.get('smsbowerSettings');
  return smsbowerSettings;
}

function getSmsBowerSettings() {
  const value = settingsRepository?.get('smsbowerSettings') || smsbowerSettings;
  return value;
}

async function ensureSmsBowerSettings() {
  await smsbowerSettingsReady;
  return getSmsBowerSettings();
}

const DEFAULT_YESCAPTCHA_SETTINGS = {
  apiKey: String(process.env.YESCAPTCHA_API_KEY || '').trim(),
  endpoint: String(process.env.YESCAPTCHA_API_BASE_URL || process.env.YESCAPTCHA_ENDPOINT || 'https://api.yescaptcha.com').trim()
    || 'https://api.yescaptcha.com',
  websiteUrl: String(process.env.OPENAI_TURNSTILE_WEBSITE_URL || 'https://auth.openai.com').trim()
    || 'https://auth.openai.com',
  // Accept the names used by older local deployments and by YesCaptcha docs.
  // Keeping this normalization at the boundary prevents a configured sitekey
  // from being silently dropped when the browser fallback is selected.
  websiteKey: String(
    process.env.OPENAI_TURNSTILE_SITEKEY
      || process.env.YESCAPTCHA_TURNSTILE_SITEKEY
      || process.env.TURNSTILE_SITEKEY
      || process.env.YESCAPTCHA_SITEKEY
      || '',
  ).trim(),
  premium: !['0', 'false', 'no'].includes(String(process.env.YESCAPTCHA_TURNSTILE_PREMIUM || 'true').trim().toLowerCase()),
  timeoutMs: Math.max(10000, Number(process.env.YESCAPTCHA_TIMEOUT_MS || 120000) || 120000),
  pollIntervalMs: Math.max(1000, Number(process.env.YESCAPTCHA_POLL_INTERVAL_MS || 3000) || 3000),
  browserFallback: !['0', 'false', 'no'].includes(String(process.env.TURNSTILE_BROWSER_FALLBACK || 'true').trim().toLowerCase()),
};

let yescaptchaSettings = { ...DEFAULT_YESCAPTCHA_SETTINGS };
let yescaptchaSettingsReady = Promise.resolve();

function normalizeYesCaptchaSettings(value = {}) {
  return {
    apiKey: String(value.apiKey ?? value.api_key ?? DEFAULT_YESCAPTCHA_SETTINGS.apiKey ?? '').trim(),
    endpoint: String(value.endpoint ?? value.apiBaseUrl ?? value.api_base_url ?? DEFAULT_YESCAPTCHA_SETTINGS.endpoint ?? '').trim()
      || 'https://api.yescaptcha.com',
    websiteUrl: String(value.websiteUrl ?? value.website_url ?? DEFAULT_YESCAPTCHA_SETTINGS.websiteUrl ?? '').trim()
      || 'https://auth.openai.com',
    websiteKey: String(
      value.websiteKey
        ?? value.website_key
        ?? value.sitekey
        ?? value.turnstileSitekey
        ?? value.turnstile_sitekey
        ?? value.yescaptchaSitekey
        ?? DEFAULT_YESCAPTCHA_SETTINGS.websiteKey
        ?? '',
    ).trim(),
    premium: value.premium === false || value.premium === '0' || value.premium === 0
      ? false
      : value.premium == null
        ? DEFAULT_YESCAPTCHA_SETTINGS.premium
        : Boolean(value.premium),
    timeoutMs: Math.max(10000, Number(value.timeoutMs ?? value.timeout_ms ?? DEFAULT_YESCAPTCHA_SETTINGS.timeoutMs) || 120000),
    pollIntervalMs: Math.max(1000, Number(value.pollIntervalMs ?? value.poll_interval_ms ?? DEFAULT_YESCAPTCHA_SETTINGS.pollIntervalMs) || 3000),
    browserFallback: value.browserFallback === false || value.browser_fallback === false || value.browserFallback === '0'
      ? false
      : value.browserFallback == null && value.browser_fallback == null
        ? DEFAULT_YESCAPTCHA_SETTINGS.browserFallback
        : Boolean(value.browserFallback ?? value.browser_fallback),
  };
}

function publicYesCaptchaSettings(settings = getYesCaptchaSettings()) {
  const apiKey = String(settings.apiKey || '');
  const { apiKey: _apiKey, ...publicSettings } = settings;
  return {
    ...publicSettings,
    apiKeyConfigured: Boolean(apiKey),
    apiKeyMasked: apiKey ? `${apiKey.slice(0, 4)}***${apiKey.slice(-4)}` : '',
    websiteKeyConfigured: Boolean(settings.websiteKey),
  };
}

async function loadYesCaptchaSettings() {
  await settingsRepository.initialize();
  yescaptchaSettings = settingsRepository.get('yescaptchaSettings');
  return yescaptchaSettings;
}

function getYesCaptchaSettings() {
  const value = settingsRepository?.get('yescaptchaSettings') || yescaptchaSettings;
  return value;
}

async function ensureYesCaptchaSettings() {
  await yescaptchaSettingsReady;
  return getYesCaptchaSettings();
}

const DEFAULT_PROTOCOL_SETTINGS = {
  enabled: !['0', 'false', 'no'].includes(String(process.env.PROTOCOL_HARDENING_ENABLED || 'true').trim().toLowerCase()),
  randomFingerprint: !['0', 'false', 'no'].includes(String(process.env.PROTOCOL_RANDOM_FINGERPRINT || 'true').trim().toLowerCase()),
  fingerprintRegion: normalizeFingerprintRegionSetting(process.env.PROTOCOL_FINGERPRINT_REGION || 'AUTO'),
  humanPacingEnabled: !['0', 'false', 'no'].includes(String(process.env.PROTOCOL_HUMAN_PACING || 'true').trim().toLowerCase()),
  accountGapMsMin: Math.max(0, Number(process.env.PROTOCOL_ACCOUNT_GAP_MS_MIN || 12000) || 12000),
  accountGapMsMax: Math.max(0, Number(process.env.PROTOCOL_ACCOUNT_GAP_MS_MAX || 35000) || 35000),
  strictEgressMatch: /^(1|true|yes)$/i.test(String(process.env.STRICT_ACCOUNT_EGRESS_MATCH || '').trim()),
  proxyPool: resolveConfiguredProxyPool(process.env),
};

let protocolSettings = { ...DEFAULT_PROTOCOL_SETTINGS };
let protocolSettingsReady = Promise.resolve();
let egressRegionCache = {
  fingerprintRegion: normalizeFingerprintRegion(process.env.PROTOCOL_FINGERPRINT_REGION_FALLBACK || 'US'),
  countryCode: '',
  ip: '',
  source: '',
  checkedAt: 0,
  error: '',
};

function normalizeProtocolSettings(value = {}) {
  const timing = normalizeHumanTimingSettings(value, DEFAULT_PROTOCOL_SETTINGS);
  const proxyPool = String(value.proxyPool ?? value.proxy_pool ?? DEFAULT_PROTOCOL_SETTINGS.proxyPool).trim();
  parseProxyPool(proxyPool);
  return {
    enabled: value.enabled === false || value.enabled === '0' || value.enabled === 0
      ? false
      : value.enabled == null
        ? DEFAULT_PROTOCOL_SETTINGS.enabled
        : Boolean(value.enabled),
    randomFingerprint: value.randomFingerprint === false || value.random_fingerprint === false || value.randomFingerprint === '0'
      ? false
      : value.randomFingerprint == null && value.random_fingerprint == null
        ? DEFAULT_PROTOCOL_SETTINGS.randomFingerprint
        : Boolean(value.randomFingerprint ?? value.random_fingerprint),
    fingerprintRegion: normalizeFingerprintRegionSetting(
      value.fingerprintRegion ?? value.fingerprint_region ?? DEFAULT_PROTOCOL_SETTINGS.fingerprintRegion,
    ),
    strictEgressMatch: value.strictEgressMatch === false || value.strict_egress_match === false || value.strictEgressMatch === '0' || value.strict_egress_match === '0'
      ? false
      : value.strictEgressMatch == null && value.strict_egress_match == null
        ? DEFAULT_PROTOCOL_SETTINGS.strictEgressMatch
        : Boolean(value.strictEgressMatch ?? value.strict_egress_match),
    proxyPool,
    ...timing,
  };
}

function publicProtocolSettings(settings = getProtocolSettings()) {
  const proxyPoolEnabled = Boolean(String(settings.proxyPool || '').trim());
  const proxyMode = proxyPoolEnabled ? 'pool' : (FIXED_LOCAL_PROXY_URL ? 'local' : 'direct');
  const { proxyPool: _proxyPool, ...publicSettings } = settings;
  return {
    ...publicSettings,
    proxyPoolConfigured: proxyPoolEnabled,
    proxyMode,
    proxyUrl: proxyMode === 'local' ? maskProxyUrl(FIXED_LOCAL_PROXY_URL) : '',
    proxyLocked: false,
    effectiveFingerprintRegion: resolveEffectiveFingerprintRegion(settings),
    egressRegion: {
      countryCode: egressRegionCache.countryCode,
      ip: egressRegionCache.ip,
      source: egressRegionCache.source,
      checkedAt: egressRegionCache.checkedAt ? new Date(egressRegionCache.checkedAt).toISOString() : '',
      error: egressRegionCache.error,
    },
    fingerprintRegions: FINGERPRINT_REGIONS.map((value) => ({
      value,
      label: FINGERPRINT_REGION_PROFILES[value]?.label || value,
    })).concat([{ value: 'AUTO', label: '自动匹配当前出口 IP' }]),
  };
}

function resolveEffectiveFingerprintRegion(settings = getProtocolSettings()) {
  const configured = String(settings?.fingerprintRegion || DEFAULT_PROTOCOL_SETTINGS.fingerprintRegion || 'AUTO').toUpperCase();
  if (configured !== 'AUTO') return normalizeFingerprintRegion(configured);
  return normalizeFingerprintRegion(egressRegionCache.fingerprintRegion || 'US');
}

async function refreshEgressFingerprintRegion({ force = false } = {}) {
  const ttlMs = Math.max(30_000, Number(process.env.EGRESS_REGION_CACHE_MS || 10 * 60 * 1000) || 10 * 60 * 1000);
  if (!force && egressRegionCache.checkedAt && Date.now() - egressRegionCache.checkedAt < ttlMs) return egressRegionCache;
  try {
    const detected = await detectFixedProxyCountryCode({
      proxyUrl: resolveSessionProxy({ pool: getProtocolSettings().proxyPool }).proxyUrl,
    });
    const fingerprintRegion = mapCountryCodeToFingerprintRegion(detected.countryCode);
    egressRegionCache = {
      fingerprintRegion,
      countryCode: detected.countryCode,
      ip: detected.ip,
      source: detected.source,
      checkedAt: Date.now(),
      error: '',
    };
  } catch (error) {
    egressRegionCache = {
      ...egressRegionCache,
      checkedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return egressRegionCache;
}

async function loadProtocolSettings() {
  await settingsRepository.initialize();
  protocolSettings = settingsRepository.get('protocolSettings');
  return protocolSettings;
}

function getProtocolSettings() {
  const value = settingsRepository?.get('protocolSettings') || protocolSettings;
  return { ...value, effectiveFingerprintRegion: resolveEffectiveFingerprintRegion(value) };
}

async function ensureProtocolSettings() {
  await protocolSettingsReady;
  return getProtocolSettings();
}

const DEFAULT_SUB2API_SETTINGS = readSub2ApiSettingsDefaults(process.env);
let sub2ApiSettings = { ...DEFAULT_SUB2API_SETTINGS };
let sub2ApiSettingsReady = Promise.resolve();

function getSub2ApiSettings() {
  const value = settingsRepository?.get('sub2apiSettings') || sub2apiSettings;
  return value;
}

async function loadSub2ApiSettings() {
  await settingsRepository.initialize();
  sub2ApiSettings = settingsRepository.get('sub2apiSettings');
  sub2ApiPushService.configure(sub2ApiSettings);
  return sub2ApiSettings;
}

function createSub2ApiClient({ baseUrl, adminApiKey } = {}) {
  return new Sub2ApiClient(baseUrl, adminApiKey);
}

function createSessionDeviceAndProxy({ proxyPool, directWhenProxyPoolEmpty = false } = {}) {
  const settings = getProtocolSettings();
  const hardeningOn = settings.enabled !== false;
  if (hardeningOn && String(settings.fingerprintRegion || '').toUpperCase() === 'AUTO') {
    void refreshEgressFingerprintRegion().catch(() => {});
  }
  const fingerprint = hardeningOn && settings.randomFingerprint
    ? generateFingerprint(resolveEffectiveFingerprintRegion(settings))
    : STATIC_DEVICE_FINGERPRINT;

  const hasRequestProxyPool = proxyPool !== undefined;
  const proxy = resolveSessionProxy({
    pool: hasRequestProxyPool ? String(proxyPool || '') : settings.proxyPool,
    env: hasRequestProxyPool ? {} : process.env,
    directWhenEmpty: hasRequestProxyPool && directWhenProxyPoolEmpty,
    refreshSession: !hasRequestProxyPool,
  });
  return { fingerprint, proxy, settings };
}

function currentEgressBinding() {
  return {
    egress_country: String(egressRegionCache.countryCode || '').toUpperCase(),
    egress_ip: String(egressRegionCache.ip || ''),
    egress_source: String(egressRegionCache.source || 'fixed-local'),
  };
}

function normalizeStoredFingerprint(value) {
  const parsed = normalizeFingerprintRecord(value, { fallbackRegion: resolveEffectiveFingerprintRegion() });
  return parsed.ok ? parsed.fingerprint : null;
}

function noteAccountEgressMismatch(account, egress = currentEgressBinding()) {
  const expected = String(account?.egress_country || '').toUpperCase();
  const actual = String(egress.egress_country || '').toUpperCase();
  if (!expected || !actual || expected === actual) return false;
  const strict = getProtocolSettings().strictEgressMatch === true;
  const message = `账号 ${account.email || account.id || ''} 绑定出口=${expected}，当前出口=${actual}，请检查代理/IP 与账号画像是否一致`;
  if (strict) throw new Error(message);
  // Egress details are reported through the requesting browser only.
  return true;
}

function createAccountSessionDeviceAndProxy(account = null, network = {}) {
  const session = createSessionDeviceAndProxy(network);
  if (!account || session.settings?.enabled === false) return session;
  const requestScopedNetwork = network.proxyPool !== undefined;
  const egress = requestScopedNetwork ? null : currentEgressBinding();
  if (egress) noteAccountEgressMismatch(account, egress);
  let fingerprint = normalizeStoredFingerprint(account.fingerprint_json);
  if (!fingerprint) {
    fingerprint = session.fingerprint;
    account.fingerprint_json = stringifyFingerprintRecord(fingerprint);
    account.fingerprint_created_at = account.fingerprint_created_at || nowIso();
  } else if (!Number(fingerprint.schemaVersion || 0)) {
    account.fingerprint_json = stringifyFingerprintRecord(fingerprint);
  }
  account.fingerprint_region = fingerprint.region || account.fingerprint_region || '';
  if (egress) {
    account.egress_country = account.egress_country || egress.egress_country;
    account.egress_ip = account.egress_ip || egress.egress_ip;
    account.egress_source = account.egress_source || egress.egress_source;
  }
  account.updatedAt = nowIso();
  return { ...session, fingerprint };
}

function createYesCaptchaClient(settings = getYesCaptchaSettings()) {
  return createCaptchaProviderClient(settings);
}

function normalizePhoneMode(value) {
  // 兼容旧参数；未传时走服务端全局 authMode
  if (value == null || value === '') return authModeToPhoneMode(getAuthMode());
  return authModeToPhoneMode(normalizeAuthMode(value, getAuthMode()));
}

const DEFAULT_APP_SETTINGS = {
  authMode: normalizeAuthMode(process.env.AUTH_MODE || process.env.PHONE_MODE || 'rt'),
  oauthBatchConcurrency: DEFAULT_OAUTH_BATCH_CONCURRENCY,
  exportFilePrefix: normalizeSequentialExportPrefix(process.env.EXPORT_FILE_PREFIX || 'v1_'),
};

let appSettings = { ...DEFAULT_APP_SETTINGS };
let appSettingsReady = Promise.resolve();
function getOauthBatchConcurrency() {
  return DEFAULT_OAUTH_BATCH_CONCURRENCY;
}

function getRegisterBatchConcurrency(requested) {
  return resolveProtocolLoginConcurrency({
    requested,
    globalConcurrency: getOauthBatchConcurrency(),
  });
}

function getJobConcurrency(type, requested) {
  return getRegisterBatchConcurrency(requested);
}

function getProtocolAccountStartGapMs() {
  const timing = getProtocolHumanTiming();
  if (!timing.humanPacingEnabled) return 0;
  return sampleHumanDelayMs('betweenAccounts', {
    accountGapMsMin: timing.accountGapMsMin,
    accountGapMsMax: timing.accountGapMsMax,
  });
}

function getProtocolHumanTiming() {
  const settings = getProtocolSettings();
  return normalizeHumanTimingSettings(settings, DEFAULT_PROTOCOL_SETTINGS);
}

/** When true, deactivated accounts are removed from DB. session_invalid stays for relogin. */
function isAutoDeleteInvalidSessionsEnabled() {
  return !/^(0|false|no)$/i.test(String(process.env.AUTO_DELETE_INVALID_SESSIONS || 'true').trim());
}

function getPhoneOtpWaitTimeoutMs() {
  const fromSettings = Number(getSmsBowerSettings()?.codeTimeoutMs);
  if (Number.isFinite(fromSettings) && fromSettings >= 15000) {
    return Math.max(15000, Math.min(300000, fromSettings));
  }
  return PHONE_OTP_WAIT_TIMEOUT_MS;
}

function getAppSettings() {
  const value = settingsRepository?.get('appSettings') || appSettings;
  return value;
}

function getExportFilePrefix() {
  return normalizeSequentialExportPrefix(getAppSettings()?.exportFilePrefix);
}

function getSessionReloginConcurrency(requested) {
  return getRegisterBatchConcurrency(requested);
}

function getSessionReloginMaxAttempts() {
  const fromEnv = Number.parseInt(String(process.env.SESSION_RELOGIN_MAX_ATTEMPTS || '').trim(), 10);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? Math.min(fromEnv, 5) : 3;
}

function isRetryableSessionReloginError(error) {
  if (terminalLoginFailure(error)) return false;
  if (['UNSUPPORTED_LOGIN_STEP', 'LOGIN_CREDENTIALS_MISSING'].includes(error?.code)) return false;
  const message = String(error?.message || error || '').toLowerCase();
  if (/invalid_username_or_password|account_deactivated/.test(message)) return false;
  return Boolean(error?.proxyEgress) || isOpenAiRateLimitError(error) || /invalid_state|csrf|state mismatch|fetch failed|network|timed?\s*out|econnreset|econnrefused|http 5\d\d|ssl_connect|ssl_error_syscall|boringssl|connection closed abruptly/.test(message);
}

function isRetryableProxyConnectionError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return Boolean(error?.proxyEgress) || /ssl_connect|ssl_error_syscall|boringssl|connection closed abruptly|cloudflare|http 403|http 503/.test(message);
}

async function buildExportFileName(stem, ext = 'json', now = new Date()) {
  return buildPrefixedExportFileName(stem, ext, { prefix: await reserveExportFilePrefix(), now });
}

function getAuthMode() {
  return normalizeAuthMode(getAppSettings()?.authMode, 'rt');
}

function publicAppSettings(settings = getAppSettings()) {
  const authMode = normalizeAuthMode(settings.authMode, 'rt');
  return {
    authMode,
    authModeLabel: authMode === 'agent' ? 'Agent Identity' : 'refresh_token',
    oauthBatchConcurrency: getOauthBatchConcurrency(),
    exportFilePrefix: normalizeSequentialExportPrefix(settings.exportFilePrefix),
    options: [
      {
        value: 'rt',
        label: 'refresh_token',
        title: 'Codex 登录接码',
        desc: '手机验证使用短信服务，导出带 refresh_token 的 sub2api',
      },
      {
        value: 'agent',
        label: 'Agent Identity',
        title: 'Agent Identity 转换',
        desc: '手机验证跳过接码，注册 Agent Identity，导出无 RT 的 Agent Identity sub2api',
      },
    ],
  };
}

async function loadAppSettings() {
  await settingsRepository.initialize();
  appSettings = settingsRepository.get('appSettings');
  return appSettings;
}

function normalizeAppSettings(value = {}) {
  return {
    authMode: normalizeAuthMode(value.authMode ?? value.auth_mode ?? value.phoneMode ?? DEFAULT_APP_SETTINGS.authMode),
    oauthBatchConcurrency: DEFAULT_OAUTH_BATCH_CONCURRENCY,
    exportFilePrefix: normalizeSequentialExportPrefix(
      value.exportFilePrefix ?? value.export_file_prefix ?? DEFAULT_APP_SETTINGS.exportFilePrefix,
    ),
  };
}

const EXPORT_PREFIX_OVERRIDE = Symbol('exportPrefixOverride');
let appSettingsMutationQueue = Promise.resolve();

function enqueueAppSettingsMutation(operation) {
  const task = appSettingsMutationQueue.then(operation, operation);
  appSettingsMutationQueue = task.then(() => undefined, () => undefined);
  return task;
}

async function saveAppSettingsUnlocked(nextSettings) {
  const exportFilePrefix = nextSettings?.[EXPORT_PREFIX_OVERRIDE] != null
    ? normalizeSequentialExportPrefix(nextSettings[EXPORT_PREFIX_OVERRIDE])
    : getExportFilePrefix();
  const normalized = {
    authMode: nextSettings?.authMode != null || nextSettings?.phoneMode != null
      ? normalizeAuthMode(nextSettings?.authMode ?? nextSettings?.phoneMode, getAuthMode())
      : getAuthMode(),
    oauthBatchConcurrency: getOauthBatchConcurrency(),
    exportFilePrefix,
  };
  return settingsRepository.set('appSettings', normalized);
}

async function reserveExportFilePrefix() {
  return enqueueAppSettingsMutation(async () => {
    await ensureAppSettings();
    const current = getExportFilePrefix();
    await saveAppSettingsUnlocked({ [EXPORT_PREFIX_OVERRIDE]: nextSequentialExportPrefix(current) });
    return current;
  });
}

async function ensureAppSettings() {
  await appSettingsReady;
  return getAppSettings();
}

const settingsComposition = createSettingsComposition({
  db: sqliteRuntime.db,
  secrets: sqliteRuntime.secrets,
  runtimePaths,
  defaultS: {
    appSettings: DEFAULT_APP_SETTINGS,
    smsbowerSettings: DEFAULT_SMSBOWER_SETTINGS,
    yescaptchaSettings: DEFAULT_YESCAPTCHA_SETTINGS,
    protocolSettings: DEFAULT_PROTOCOL_SETTINGS,
    sub2apiSettings: DEFAULT_SUB2API_SETTINGS,
  },
  normalizers: {
    appSettings: normalizeAppSettings,
    smsbowerSettings: normalizeSmsBowerSettings,
    yescaptchaSettings: normalizeYesCaptchaSettings,
    protocolSettings: normalizeProtocolSettings,
    sub2apiSettings: value => normalizeSub2ApiSettings(value, DEFAULT_SUB2API_SETTINGS),
  },
});
settingsRepository = requestScoped('settings', settingsComposition.repository);
const settingsRepositoryReady = settingsComposition.ready;
appSettingsReady = settingsRepositoryReady.then(loadAppSettings);
smsbowerSettingsReady = settingsRepositoryReady.then(loadSmsBowerSettings);
yescaptchaSettingsReady = settingsRepositoryReady.then(loadYesCaptchaSettings);
protocolSettingsReady = settingsRepositoryReady
  .then(loadProtocolSettings)
  .then(async (settings) => {
    if (String(settings?.fingerprintRegion || '').toUpperCase() === 'AUTO') {
      await refreshEgressFingerprintRegion({ force: true });
    }
    return getProtocolSettings();
  });
sub2ApiSettingsReady = settingsRepositoryReady.then(loadSub2ApiSettings);

bindSqliteRuntimeToApp(app, sqliteRuntime, runtimePaths, { requireAdmin });

function sanitizeFileSegment(value) {
  return String(value || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

const sleep = ms => requestDelay(ms, undefined, { signal: requestSignal() });

function createSmsBowerClient(settings = getSmsBowerSettings()) {
  return createSmsProviderClient(normalizeSmsBowerSettings(settings));
}

function getSmsProviderLabel(settings = getSmsBowerSettings()) {
  return String(normalizeSmsBowerSettings(settings)?.provider || 'smsbower').trim().toLowerCase() === 'manual_sms' ? 'Manual SMS API' : 'SMSBower';
}

function getSmsProviderKey(settings = getSmsBowerSettings()) {
  return String(normalizeSmsBowerSettings(settings)?.provider || 'smsbower').trim().toLowerCase() === 'manual_sms' ? 'manual_sms' : 'smsbower';
}

function buildBrowserHeaders(init = {}, fingerprint = null) {
  if (fingerprint) return buildBrowserHeadersFromFingerprint(fingerprint, init);
  return buildBrowserHeadersFromFingerprint(STATIC_DEVICE_FINGERPRINT, init);
}

const fetchOpenAISentinelToken = createOpenAISentinelTokenFetcher({
  ensureYesCaptchaSettings: () => ensureYesCaptchaSettings(),
  getYesCaptchaSettings: () => getYesCaptchaSettings(),
  defaultFingerprint: STATIC_DEVICE_FINGERPRINT,
  defaultUserAgent: DEFAULT_USER_AGENT,
  // The embedded login service root is this directory itself (/app in Docker).
  // The reference repository used '..' because email-server was nested one level.
  repoRoot: path.resolve(__dirname),
});

const { protocolRequestNetwork, accountRequestNetwork } = createAuthNetworkPolicy();

// SSEChannel / mapWithConcurrency -> lib/sse.js

const {
  persistOpenAIAuthResult,
  persistChatGptWebSession,
  clearAuthStateForFreshLogin,
  syncSessionPlanTypes,
  buildSub2ApiJsonForAccounts,
  resolveSub2ApiExportRecord,
  refreshOpenAIRecordFromRt,
  runResetTotpForAccounts,
  probeSessionThroughConfiguredProxy,
  runSessionHealthCheckForAccount,
  runSessionHealthCheckForAccounts,
  runAllWorkspaceCodexAuthForAccount,
  runBusinessCodexAuthForAccount,
  runCodexAuthForAccount,
  runCodexAuthForAccounts,
  OpenAIJsonAuthFlow,
} = createAuthenticationServices({
  AUTH_OAUTH_TOKEN_URLS,
  PHONE_OTP_POLL_INTERVAL_MS,
  PHONE_OTP_WAIT_TIMEOUT_MS,
  STATIC_DEVICE_FINGERPRINT,
  accountRepository,
  accountRequestNetwork,
  buildBrowserHeaders,
  buildExportFileName,
  createAccountSessionDeviceAndProxy,
  createCurlCffiFetch,
  createSmsBowerClient,
  fetch: (url, options = {}) => {
    const signals = [requestSignal(), options.signal].filter(Boolean);
    return fetch(url, { ...options, signal: signals.length ? AbortSignal.any(signals) : undefined });
  },
  fetchOpenAISentinelToken,
  findAccountById,
  getAllAccounts,
  getOauthBatchConcurrency,
  getPhoneOtpWaitTimeoutMs,
  getProtocolHumanTiming,
  getProtocolSettings,
  getRegisterBatchConcurrency,
  getSessionReloginConcurrency,
  getSessionReloginMaxAttempts,
  getSmsBowerSettings,
  getSmsProviderKey,
  getSmsProviderLabel,
  getSub2ApiSettings,
  isAutoDeleteInvalidSessionsEnabled,
  isRetryableProxyConnectionError,
  isRetryableSessionReloginError,
  normalizePhoneMode,
  normalizeStoredFingerprint,
  preflightProxyEgress,
  sleep,
  sub2ApiPushService,
  withSmsAcquireSemaphore,
});

// Reduced surface: only protocol, health, conversion and permitted settings routes are mounted.
registerAdminSettingsRoutes(app, {
  requireAdmin,
  ensureDatabase,
  publicProtocolSettings,
  settingsRepository,
  publicSub2ApiSettings,
  createSub2ApiClient,
  configureSub2ApiPush: settings => sub2ApiPushService.configure(settings),
});

// Account import endpoint consumed by the converter UI.
app.post('/api/v2/accounts/import', requireAdmin, async (req, res) => {
  try {
    await ensureDatabase();
    const lines = String(req.body?.text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const rows = lines.map((line, i) => {
      try {
        const imported = parseManagementImportLine(line);
        const account = accountRepository.importOne(imported);
        return { id: account.id, email: account.email, ok: true, account: publicAccountView(account) };
      } catch (error) { return { line: i + 1, email: line.split('----')[0], ok: false, error: error.message }; }
    });
    res.json({ ok: true, rows, imported: rows.filter(r => r.ok).length, failed: rows.filter(r => !r.ok).length });
  } catch (error) { sendOperationError(res, error); }
});

app.post('/api/v2/accounts/reset-totp', requireAdmin, async (req, res) => {
  try {
    await ensureDatabase();
    const ids = normalizeAccountIds(req.body?.ids);
    if (!ids.length) throw new Error('请先完成协议登录，再选择需要换绑 2FA 的账号');
    const accounts = selectAccountCollection({ allAccounts: getAllAccounts(), findById: findAccountById, ids });
    if (!accounts.length) throw new Error('未找到可换绑 2FA 的账号');
    const run = hooks => runResetTotpForAccounts(accounts, {
      concurrency: req.body?.concurrency,
      ...protocolRequestNetwork(req.body || {}),
      ...hooks,
    });
    if (wantsEventStream(req)) {
      await runSseResponse(res, async sse => {
        sse.send('log', { msg: `开始批量换绑 2FA，共 ${accounts.length} 个账号，并发=${getRegisterBatchConcurrency(req.body?.concurrency)}` });
        const summary = await run({
          onAccountStart: data => sse.send('account_start', data),
          onAccountLog: data => sse.send('account_log', data),
          onAccountDone: data => sse.send('account_done', data),
        });
        sse.send('summary', {
          ...summary,
          accounts: accounts.map(account => publicAccountView(findAccountById(account.id) || account)),
        });
        sse.send('done', { ok: true });
      });
      return;
    }
    const summary = await run();
    res.json({
      ...summary,
      accounts: accounts.map(account => publicAccountView(findAccountById(account.id) || account)),
    });
  } catch (error) {
    sendOperationError(res, error);
  }
});

registerConversionRoutes(app, {
  requireAdmin,
  resolveAccountSessions: async (ids = []) => {
    await ensureDatabase();
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(id => String(id || '').trim()).filter(Boolean))];
    return wanted.map(id => {
      const account = findAccountById(id);
      if (!account) return null;
      const accessToken = String(account.session_access_token || '').trim();
      if (!accessToken) return null;
      let session = { accessToken, email: account.email };
      const raw = String(account.session_json || '').trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') session = { ...parsed, accessToken: parsed.accessToken || parsed.access_token || accessToken, email: parsed.email || account.email };
        } catch { /* keep token-only session */ }
      }
      return { id: account.id, email: account.email, session };
    }).filter(Boolean);
  },
  getConcurrency: () => getSub2ApiSettings().accountConcurrency,
  getExportSettings: getSub2ApiSettings,
});
registerSessionExportRoutes(app, {
  requireAdmin,
  ensureDatabase,
  getAccounts: getAllAccounts,
  probeSession: async (_account, accessToken) => {
    const result = await probeChatGptSessionAccessToken(accessToken);
    return { ok: result.ok, health: result.health };
  },
});

async function sendSub2ApiJsonExport(res, accounts, { push = false, pushOnly = false, rtKind = 'personal', workspaceIds = [], validateSession = true } = {}) {
  let exported;
  if (rtKind === 'business' || rtKind === 'all') {
    const records = []; const errors = []; const exportedAccountIds = [];
    const wanted = new Set(normalizeBusinessWorkspaceIds(workspaceIds));
    for (const account of accounts) try { const items = buildStoredBusinessRtExportRecords(account).filter(item => !wanted.size || wanted.has(String(item.account_id || item.extra?.workspace_id || ''))); records.push(...items); exportedAccountIds.push(...items.map(() => account.id)); } catch (error) { errors.push({ email: account.email, error: error instanceof Error ? error.message : String(error) }); }
    const businessJson = buildSub2ApiExport(records, undefined, getSub2ApiSettings()); for (const item of businessJson.accounts) assertSub2ApiAccountShape(item);
    if (rtKind === 'all') {
      const { eligible, errors: missingRtErrors } = partitionRtExportCandidates(accounts);
      const health = validateSession && eligible.length ? await runSessionHealthCheckForAccounts(eligible, { reloginOnInvalid: false, forceRelogin: false, autoDeleteInvalid: false }) : { results: [] };
      const personal = await buildSub2ApiJsonForAccounts(eligible, { healthResults: health.results, initialErrors: missingRtErrors, skipHealthCheck: !validateSession });
      const json = { ...personal.json, accounts: [...personal.json.accounts, ...businessJson.accounts] };
      exported = { json, fileName: await buildExportFileName('sub2api-all-rt', 'json'), text: `${JSON.stringify(json, null, 2)}\n`, success: personal.success + records.length, failed: personal.failed + errors.length, errors: [...personal.errors, ...errors], exportedAccountIds };
    } else {
      exported = { json: businessJson, fileName: await buildExportFileName('sub2api-business-rt', 'json'), text: `${JSON.stringify(businessJson, null, 2)}\n`, success: records.length, failed: errors.length, errors, exportedAccountIds };
    }
  } else {
    const { eligible, errors: missingRtErrors } = partitionRtExportCandidates(accounts);
    const health = validateSession && eligible.length ? await runSessionHealthCheckForAccounts(eligible, { reloginOnInvalid: false, forceRelogin: false, autoDeleteInvalid: false }) : { results: [] };
    exported = await buildSub2ApiJsonForAccounts(eligible, { healthResults: health.results, initialErrors: missingRtErrors, skipHealthCheck: !validateSession });
  }
  const queued = push && exported.json.accounts.length
    ? await sub2ApiPushService.enqueueImmediate(exported.json.accounts, { waitForRemote: pushOnly })
    : { enabled: false, queued: 0, imported: 0 };
  if ((rtKind === 'business' || rtKind === 'all') && queued.imported > 0 && queued.imported === exported.json.accounts.length) {
    const exportedIds = new Set(exported.exportedAccountIds || []);
    const queuedAccounts = accounts.filter(account => exportedIds.has(String(account.id || '')));
    await accountRepository.updateMany(queuedAccounts.map(account => account.id), account => ({
      business_sub2api_pushed: true,
      business_sub2api_pushed_at: nowIso(),
      business_sub2api_push_source: 'queued',
      business_sub2api_account_id: account.business_openai_account_id || account.business_workspace_id,
    }));
  }
  if (pushOnly) {
    res.status(200).json({
      ok: true,
      rtKind,
      requested: accounts.length,
      success: exported.success,
      failed: exported.failed,
      errors: exported.errors,
      pushQueued: queued.queued || 0,
      pushImported: queued.imported || 0,
      pushEnabled: Boolean(queued.enabled),
      pushError: queued.error || null,
    });
    return;
  }
  res.set({
    'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${exported.fileName}"`, 'Cache-Control': 'no-store',
    'X-Export-Requested': String(accounts.length), 'X-Export-Success': String(exported.success), 'X-Export-Failed': String(exported.failed),
    'X-Sub2API-Queued': String(queued.queued || 0), 'X-Export-RT-Kind': rtKind,
    'X-Export-Errors': encodeURIComponent(exported.errors.map(item => `${item.email}: ${item.error}`).join('; ').slice(0, 1000)),
  });
  res.status(200).send(exported.text);
  void queued;
}

app.post('/api/v2/accounts/export-sub2api', requireAdmin, async (req, res) => {
  try {
    await ensureDatabase();
    const phoneMode = authModeToPhoneMode(getAuthMode());
    const ids = normalizeAccountIds(req.body?.ids);
    if (!ids.length) throw new Error('请先选择要导出的账号');

    const selected = ids.map(id => findAccountById(id)).filter(Boolean);
    if (!selected.length) throw new Error('未找到可导出的账号');
    const rtKind = ['personal', 'business', 'all'].includes(req.body?.rtKind) ? req.body.rtKind : 'personal';
    await sendSub2ApiJsonExport(res, selected, { push: req.body?.push === true, rtKind, workspaceIds: req.body?.workspaceIds, validateSession: req.body?.validateSession !== false });
  } catch (error) {
    sendOperationError(res, error);
  }
});

app.post('/api/v2/accounts/push-sub2api', requireAdmin, async (req, res) => {
  try {
    await ensureDatabase();
    const ids = normalizeAccountIds(req.body?.ids);
    if (!ids.length) throw new Error('请先选择要推送的账号');
    const selected = ids.map(id => findAccountById(id)).filter(Boolean);
    if (!selected.length) throw new Error('未找到可推送的账号');
    await sendSub2ApiJsonExport(res, selected, {
      push: true,
      pushOnly: true,
      rtKind: req.body?.rtKind === 'business' ? 'business' : 'personal',
      workspaceIds: req.body?.workspaceIds,
      validateSession: req.body?.validateSession !== false,
    });
  } catch (error) {
    sendOperationError(res, error);
  }
});

// 兼容旧路径：改为导出合并后的标准 sub2api JSON，不再返回 zip
app.post('/api/v2/accounts/export-sub2api-zip', requireAdmin, async (req, res) => {
  try {
    await ensureDatabase();
    const phoneMode = authModeToPhoneMode(getAuthMode());
    const ids = normalizeAccountIds(req.body?.ids);
    if (!ids.length) throw new Error('请先选择要导出的账号');

    const selected = ids.map(id => findAccountById(id)).filter(Boolean);
    if (!selected.length) throw new Error('未找到可导出的账号');
    await sendSub2ApiJsonExport(res, selected, { push: req.body?.push === true, rtKind: req.body?.rtKind === 'business' ? 'business' : 'personal', workspaceIds: req.body?.workspaceIds });
  } catch (error) {
    sendOperationError(res, error);
  }
});

app.post('/api/v2/accounts/business-join/convert-rt', requireAdmin, async (req, res) => {
  let streamSse = null;
  let streamPing = null;
  try {
    await ensureDatabase();
    const scope = String(req.body?.scope || '').toLowerCase() === 'all' ? 'all' : 'selected';
    const ids = normalizeAccountIds(req.body?.ids);
    const accounts = selectAccountCollection({ allAccounts: getAllAccounts(), findById: findAccountById, scope, ids });
    if (!accounts.length) throw new Error('请先选择账号');
    const override = normalizeBusinessWorkspaceIds(req.body?.workspaceIds ?? req.body?.workspaceId);
    const force = req.body?.force !== false;
    const requestNetwork = protocolRequestNetwork(req.body || {});
    const concurrency = getRegisterBatchConcurrency(
      req.body?.concurrency ?? req.body?.options?.concurrency,
    );
    const wantStream = Boolean(req.body?.stream) || String(req.headers.accept || '').includes('text/event-stream');
    if (wantStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      streamSse = new SSEChannel(res);
      streamPing = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      streamSse.send('log', { msg: `开始准备 Business 转 RT：账号 ${accounts.length} 个` });
    }
    const missingWorkspaceResults = [];
    const tasks = accounts.flatMap(account => {
      account = findAccountById(account.id) || account;
      const savedWorkspaceIds = Array.isArray(account.business_workspace_credentials)
        ? account.business_workspace_credentials.map(item => String(item?.workspaceId || '').trim()).filter(Boolean)
        : [];
      const accountWorkspaceIds = extractBusinessWorkspaceIds(account);
      const candidates = override.length
        ? override
        : (accountWorkspaceIds.length
          ? accountWorkspaceIds
          : (savedWorkspaceIds.length ? normalizeBusinessWorkspaceIds(savedWorkspaceIds) : (account.business_workspace_id ? [account.business_workspace_id] : [])));
      if (!candidates.length) {
        missingWorkspaceResults.push({
          ok: false,
          skipped: false,
          id: account.id,
          email: account.email,
          workspaceId: '',
          code: 'BUSINESS_WORKSPACE_NOT_FOUND',
          error: '登录成功，但 Session 中未发现可加入的 Business 工作区',
          logs: [],
        });
        return [];
      }
      return candidates.map(workspaceId => ({ account, workspaceId }));
    });
    // Limit concurrency by account. Workspaces belonging to one account are
    // processed serially so singleton business_* fields cannot overwrite each other.
    const accountTasks = accounts.map(account => ({
      account,
      tasks: tasks.filter(task => String(task.account?.id || '') === String(account.id || '')),
    })).filter(group => group.tasks.length);
    const run = async (hooks = {}) => {
      for (const result of missingWorkspaceResults) hooks.onDone?.(result);
      const groups = await mapWithConcurrency(accountTasks, concurrency, async ({ account, tasks: accountWorkspaceTasks }) => {
        const results = [];
        for (const { workspaceId } of accountWorkspaceTasks) {
          hooks.onStart?.({ email: account.email, id: account.id, workspaceId, stage: inferOpenAiStage(account) });
          const result = await runBusinessCodexAuthForAccount(account, {
            workspaceId,
            force,
            onLog: hooks.onLog,
            ...requestNetwork,
          });
          hooks.onDone?.(result);
          results.push(result);
        }
        return results;
      });
      return [...missingWorkspaceResults, ...groups.flat()];
    };
    const finish = (results) => {
      const payload = { ok: true, scope, requested: tasks.length, success: results.filter(x => x.ok && !x.skipped).length, skipped: results.filter(x => x.ok && x.skipped).length, failed: results.filter(x => !x.ok).length, concurrency, results, accounts: accounts.map(a => publicAccountView(findAccountById(a.id) || a)) };
      return payload;
    };
    if (wantStream) {
      try {
        streamSse.send('log', { msg: `开始 Business 转 RT：账号 ${accounts.length} 个，工作区任务 ${tasks.length} 个，并发=${concurrency}` });
        const results = await run({ onStart: data => streamSse.send('account_start', data), onLog: data => streamSse.send('account_log', data), onDone: data => streamSse.send('account_done', data) });
        streamSse.send('summary', finish(results));
        streamSse.send('done', { ok: true });
      } catch (error) {
        streamSse.send('error', operationErrorPayload(error));
      } finally { clearInterval(streamPing); res.end(); }
      return;
    }
    res.json(finish(await run()));
  } catch(error){
    if (streamSse) {
      streamSse.send('error', operationErrorPayload(error));
      clearInterval(streamPing);
      try { res.end(); } catch {}
      return;
    }
    sendOperationError(res, error);
  }
});

app.post('/api/v2/accounts/codex-auth', requireAdmin, async (req, res) => {
  try {
    await ensureDatabase();
    const phoneMode = authModeToPhoneMode(getAuthMode());
    const force = Boolean(req.body?.force);
    const reuseStoredSession = req.body?.reuseStoredSession !== false;
    const forbidPhoneChallenge = Boolean(req.body?.forbidPhoneChallenge);
    const concurrency = req.body?.concurrency ?? req.body?.options?.concurrency;
    const requestNetwork = protocolRequestNetwork(req.body || {});
    const wantStream = Boolean(req.body?.stream)
      || String(req.headers.accept || '').includes('text/event-stream');
    let accounts;
    if (scope === 'all') {
      accounts = [...getAllAccounts()];
      if (!accounts.length) throw new Error('账号库为空，无法全量接码');
    } else {
      const ids = normalizeAccountIds(req.body?.ids);
      if (!ids.length) throw new Error('请先选择要接码的账号');
      accounts = ids.map(id => findAccountById(id)).filter(Boolean);
      if (!accounts.length) throw new Error('未找到可接码的账号');
    }

    if (wantStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const sse = new SSEChannel(res);
      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch {}
      }, 15000);
      try {
        const effectiveConcurrency = getRegisterBatchConcurrency(concurrency);
        sse.send('log', { msg: `开始${scope === 'all' ? '全量' : '批量'}接码/转换，共 ${accounts.length} 个账号，并发=${effectiveConcurrency}` });
        const summary = await runCodexAuthForAccounts(accounts, {
          phoneMode,
          force,
          reuseStoredSession,
          forbidPhoneChallenge,
          exportJson: false,
          concurrency,
          ...requestNetwork,
          onAccountStart: data => sse.send('account_start', data),
          onAccountLog: data => sse.send('account_log', data),
          onAccountDone: data => sse.send('account_done', publicCodexAuthResult(data)),
        });
        const refreshed = accounts.map(account => publicAccountView(findAccountById(account.id) || account));
        sse.send('summary', {
          ...summary,
          results: (summary.results || []).map(publicCodexAuthResult),
          scope,
          accounts: refreshed,
        });
        sse.send('done', { ok: true });
      } catch (error) {
        sse.send('error', operationErrorPayload(error));
      } finally {
        clearInterval(ping);
        try { res.end(); } catch {}
      }
      return;
    }

    const summary = await runCodexAuthForAccounts(accounts, { phoneMode, force, reuseStoredSession, forbidPhoneChallenge, exportJson: false, concurrency, ...requestNetwork });
    const refreshed = accounts.map(account => publicAccountView(findAccountById(account.id) || account));
    res.json({
      ...summary,
      results: (summary.results || []).map(publicCodexAuthResult),
      scope,
      accounts: refreshed,
    });
  } catch (error) {
    sendOperationError(res, error);
  }
});

app.post('/api/v2/accounts/session-codex-rt', requireAdmin, async (req, res) => {
  try {
    await ensureDatabase();
    const {
      scope,
      accounts,
      loginMode,
      forbidPhoneChallenge,
      forceCodex,
      push,
    } = buildSessionCodexRtBatch({
      body: req.body || {},
      allAccounts: getAllAccounts(),
      findById: findAccountById,
    });
    const phoneMode = authModeToPhoneMode(getAuthMode());
    const wantStream = wantsEventStream(req);

    const runProtocolLogin = async (account, { onLog } = {}) => {
      const summary = await runSessionHealthCheckForAccounts([account], {
        reloginOnInvalid: true,
        forceRelogin: true,
        // A deactivated account is terminal. Keep the protocol-login path
        // consistent with session-health and remove it after PasswordVerify.
        autoDeleteInvalid: true,
        onAccountLog: onLog,
      });
      return summary.results?.[0] || { ok: false, error: '协议登录无结果', logs: [] };
    };

    const runCodexAuth = async (account, opts = {}) => {
      const force = opts?.force ?? forceCodex;
      const onLog = opts?.onLog;
      if (!force && String(account?.openai_rt || '').trim()) {
        const logs = [];
        try {
          const record = await refreshOpenAIRecordFromRt(account, (msg, level = 'info') => {
            const entry = { time: nowIso(), level, msg };
            logs.push(entry);
            if (typeof onLog === 'function') onLog({ email: account.email, ...entry });
          });
          await persistOpenAIAuthResult(account.id, record, phoneMode);
          const exportRecord = await resolveSub2ApiExportRecord(record, { phoneMode });
          return {
            ok: true,
            skipped: true,
            email: account.email,
            mode: phoneMode,
            reason: '已有 OpenAI RT',
            kind: 'rt',
            stage: OPENAI_STAGES.RT_READY,
            hasRefreshToken: true,
            json: buildSub2ApiJson(exportRecord, getSub2ApiSettings()),
            logs,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const entry = { time: nowIso(), level: 'warn', msg: `RT 刷新失败，将尝试导出已保存凭据: ${message}` };
          logs.push(entry);
          if (typeof onLog === 'function') onLog({ email: account.email, ...entry });
          return { ok: false, skipped: false, email: account.email, error: message, logs };
        }
      }
      return runCodexAuthForAccount(account, {
        phoneMode,
        reuseStoredSession: true,
        forbidPhoneChallenge: opts?.forbidPhoneChallenge ?? forbidPhoneChallenge,
        force,
        onLog,
      });
    };

    const run = async (hooks = {}) => runSessionCodexRtForAccounts(accounts, {
      loginMode,
      forbidPhoneChallenge,
      forceCodex,
      push,
      concurrency: getOauthBatchConcurrency(),
      mapWithConcurrency,
      findAccountById,
      runProtocolLogin,
      runCodexAuth,
      enqueueImmediate: (items) => sub2ApiPushService.enqueueImmediate(items),
      buildExportFileName: (stem, ext) => buildExportFileName(stem, ext),
      exportSettings: getSub2ApiSettings(),
      ...hooks,
    });

    if (wantStream) {
      await runSseResponse(res, async (sse) => {
        sse.send('log', {
          msg: `开始 session-codex-rt，共 ${accounts.length} 个账号 · loginMode=${loginMode} · forbidPhone=${forbidPhoneChallenge} · forceCodex=${forceCodex} · push=${push}`,
        });
        const summary = await run({
          onAccountStart: (data) => sse.send('account_start', data),
          onAccountLog: (data) => sse.send('account_log', data),
          onAccountDone: (data) => sse.send('account_done', publicSessionCodexRtResult(data)),
        });
        const refreshed = accounts.map((account) => publicAccountView(findAccountById(account.id) || account));
        sse.send('summary', {
          ...summary,
          results: (summary.results || []).map(publicSessionCodexRtResult),
          scope,
          loginMode,
          forbidPhoneChallenge,
          forceCodex,
          push,
          accounts: refreshed,
        });
        sse.send('done', { ok: true });
      });
      return;
    }

    const summary = await run();
    const refreshed = accounts.map((account) => publicAccountView(findAccountById(account.id) || account));
    res.json({
      ...summary,
      results: (summary.results || []).map(publicSessionCodexRtResult),
      scope,
      loginMode,
      forbidPhoneChallenge,
      forceCodex,
      push,
      accounts: refreshed,
    });
  } catch (error) {
    sendOperationError(res, error);
  }
});

/* Retired registration and optional account-maintenance endpoints. */
app.post('/api/v2/system/stream-probe', requireAdmin, async (_req, res) => {
  await runSseResponse(res, async (sse) => {
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      sse.send('probe', { sequence, msg: `stream-probe-${sequence}` });
      if (sequence < 4) await sleep(300);
    }
    sse.send('summary', { ok: true, events: 4 });
  }, { heartbeatMs: 1_000 });
});

app.get('/api/v2/system/proxy-health', requireAdmin, (_req, res) => {
  res.json({ ok: true, proxies: proxyHealthRegistry.snapshot() });
});

registerBrowserSessionProbeRoute(app, { requireAdmin, ensureDatabase, findAccountById, getSessionReloginConcurrency, protocolRequestNetwork, accountRequestNetwork, probeSessionThroughConfiguredProxy });
registerProtocolPipelineRoutes(app, { requireAdmin, ensureDatabase, findAccountById, getSessionReloginConcurrency, protocolRequestNetwork, runSessionHealthCheckForAccount, runAllWorkspaceCodexAuthForAccount, publicAccountView });
registerProtocolLogoutAllRoutes(app, {
  requireAdmin, ensureDatabase, findAccountById, getConcurrency: getSessionReloginConcurrency, protocolRequestNetwork,
  clearAuthState: id => clearAuthStateForFreshLogin(id, { status: '全部会话已退出' }),
  persistSession: (id, login) => persistChatGptWebSession(id, login),
  createFlow: (account, network, onLog) => new OpenAIJsonAuthFlow(account, {
    send(event, data) { if (event === 'log') onLog(data); },
  }, { phoneMode: 'sms', forbidPhoneChallenge: true, humanPacingEnabled: false, ...accountRequestNetwork(account, network) }),
});
registerWorkspaceSelfLeaveRoutes(app, {
  requireAdmin, ensureDatabase, findAccountById, getConcurrency: getSessionReloginConcurrency, protocolRequestNetwork,
  updateAccount: (id, patch) => accountRepository.updateById(id, patch),
  createFlow: (account, network, onLog) => new OpenAIJsonAuthFlow(account, {
    send(event, data) { if (event === 'log') onLog(data); },
  }, { phoneMode: 'sms', reuseStoredSession: hasStoredAuthCookies(account), forbidPhoneChallenge: true, humanPacingEnabled: false, ...accountRequestNetwork(account, network) }),
});

app.post('/api/v2/accounts/protocol-login', requireAdmin, async (req, res) => {
  try {
    await ensureDatabase();
    const { scope, accounts } = buildSessionHealthBatch({
      body: {
        ...(req.body || {}),
        onlyWithSession: false,
        forceRelogin: true,
      },
      allAccounts: getAllAccounts(),
      findById: findAccountById,
      hasSession: accountHasChatGptSession,
    });
    const concurrency = getSessionReloginConcurrency(
      req.body?.concurrency ?? req.body?.options?.concurrency,
    );
    const requestNetwork = protocolRequestNetwork(req.body || {});
    const wantStream = wantsEventStream(req);
    const run = async (hooks = {}) => runSessionHealthCheckForAccounts(accounts, {
      reloginOnInvalid: true,
      forceRelogin: true,
      loginOnly: true,
      autoDeleteInvalid: false,
      concurrency,
      ...requestNetwork,
      ...hooks,
    });

    if (wantStream) {
      await runSseResponse(res, async (sse) => {
        sse.send('log', { msg: `开始协议登录，共 ${accounts.length} 个账号，并发=${concurrency}` });
        const summary = await run({
          onAccountStart: data => sse.send('account_start', data),
          onAccountLog: data => sse.send('account_log', data),
          onAccountDone: data => sse.send('account_done', publicSessionHealthResult(data)),
        });
        const refreshed = accounts.map(account => publicAccountView(findAccountById(account.id) || account));
        sse.send('summary', {
          ...summary,
          results: (summary.results || []).map(publicSessionHealthResult),
          scope,
          concurrency,
          accounts: refreshed,
        });
        sse.send('done', { ok: true });
      });
      return;
    }

    const summary = await run();
    const refreshed = accounts.map(account => publicAccountView(findAccountById(account.id) || account));
    res.json({
      ...summary,
      results: (summary.results || []).map(publicSessionHealthResult),
      scope,
      concurrency,
      accounts: refreshed,
    });
  } catch (error) {
    sendOperationError(res, error);
  }
});

app.post('/api/v2/accounts/session-health', requireAdmin, async (req, res) => {
  try {
    await ensureDatabase();
    const { scope, accounts, onlyWithSession, reloginOnInvalid, forceRelogin } = buildSessionHealthBatch({
      body: req.body || {}, allAccounts: getAllAccounts(), findById: findAccountById, hasSession: accountHasChatGptSession,
    });
    const wantStream = wantsEventStream(req);

    const run = async (hooks = {}) => runSessionHealthCheckForAccounts(accounts, {
      reloginOnInvalid,
      forceRelogin,
      // Default on (env AUTO_DELETE_INVALID_SESSIONS); body can force off for dry probes.
      autoDeleteInvalid: req.body?.autoDeleteInvalid !== false,
      ...hooks,
    });

    if (wantStream) {
      await runSseResponse(res, async (sse) => {
        sse.send('log', {
          msg: `开始${scope === 'all' ? '全量' : '批量'} Session 验活，共 ${accounts.length} 个账号；session_invalid${reloginOnInvalid ? '会重登刷新' : '仅标记'}；deactivated${req.body?.autoDeleteInvalid !== false && isAutoDeleteInvalidSessionsEnabled() ? '会自动删除' : '仅标记'}；不接手机号`,
        });
        const summary = await run({
          onAccountStart: data => sse.send('account_start', data),
          onAccountLog: data => sse.send('account_log', data),
          onAccountDone: data => sse.send('account_done', publicSessionHealthResult(data)),
        });
        const refreshed = accounts.map(account => publicAccountView(findAccountById(account.id) || account));
        sse.send('summary', {
          ...summary,
          results: (summary.results || []).map(publicSessionHealthResult),
          scope,
          onlyWithSession,
          reloginOnInvalid,
          forceRelogin,
          accounts: refreshed,
        });
        sse.send('done', { ok: true });
      });
      return;
    }

    const summary = await run();
    const refreshed = accounts.map(account => publicAccountView(findAccountById(account.id) || account));
    res.json({
      ...summary,
      results: (summary.results || []).map(publicSessionHealthResult),
      scope,
      onlyWithSession,
      reloginOnInvalid,
      forceRelogin,
      accounts: refreshed,
    });
  } catch (error) {
    sendOperationError(res, error);
  }
});

// Legacy streaming and OpenAI JSON endpoints are retired by the API_RETIRED middleware above.

runtimeReady = Promise.all([
  initializeRuntime(runtimePaths),
  dbReady,
  appSettingsReady,
  smsbowerSettingsReady,
  yescaptchaSettingsReady,
  protocolSettingsReady,
  sub2ApiSettingsReady,
]);

export async function startApplication() {
  const lifecycle = await startServer({
    app,
    port: PORT,
    host: process.env.HOST || '127.0.0.1',
    ready: Promise.all([runtimeReady, startHttpWorkers()]),
    beforeClose: async () => {
      shutdownState.value = true;
      await closeHttpWorkers();
      await browserWorkerPool.close();
      await sub2ApiPushService.stop();
      await sqliteRuntime.accounts.flushWrites?.();
      try { sqliteRuntime.db.close(); } catch {}
    },
  }).catch(async error => {
    await closeHttpWorkers();
    try { sqliteRuntime.db.close(); } catch {}
    throw error;
  });
  sub2ApiPushService.start();
  console.log(`GPTAuthBridge: http://${process.env.HOST || '127.0.0.1'}:${PORT} · Browser storage · 凭据模式=${getAuthMode()}`);
  return lifecycle;
}
