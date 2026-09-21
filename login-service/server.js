import { registerProtocolPipelineRoutes, registerBrowserSessionProbeRoute } from './src/api/routes/protocol-pipeline-routes.js';
import { registerWorkspaceSelfLeaveRoutes } from './src/api/routes/workspace-self-leave-routes.js';
import { registerProtocolLogoutAllRoutes } from './src/api/routes/protocol-logout-all-routes.js';
import { readLogoutAllResponse } from './src/services/logout-all-response.js';
import { monitorCoordinator, terminalLoginFailure } from './src/services/monitor-coordinator.js';
import { browserRequestMiddleware } from './src/services/browser-request-context.js';
import { requestScoped, requestSignal } from './src/services/request-scope.js';
import { setTimeout as requestDelay } from 'node:timers/promises';
import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, randomUUID } from 'crypto';
import makeFetchCookie from 'fetch-cookie';
import { Cookie, CookieJar } from 'tough-cookie';
import { configuredTaskConcurrency } from './lib/batch-concurrency.js';
import {
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_REDIRECT_URI,
  OPENAI_CODEX_USER_AGENT,
  OPENAI_OAUTH_TOKEN_URL,
  buildAuthorizationCodeTokenBody,
  buildOpenAIAuthorizationUrl,
  buildRefreshTokenBody,
  generateOpenAIPkce,
  parseOpenAICallback,
} from './lib/openai-oauth.js';
import {
  OPENAI_AGENT_AUTH_MODE,
  isAgentIdentityRecord,
  registerOpenAIAgentIdentity,
} from './lib/openai-agent-identity.js';
import {
  SmsBowerError,
  SMSBOWER_COUNTRY_LABELS,
  SMSBOWER_COUNTRY_PRESETS,
  SMSBOWER_FAILS_BEFORE_SWITCH,
  SMSBOWER_OPENAI_SERVICE,
  SMSBOWER_PRICE_STEP,
  createSmsCountryPricePlanner,
  rankServiceCountriesByPrice,
  resolveSmsAcquireCountries,
} from './lib/smsbower.js';
import {
  FINGERPRINT_REGION_PROFILES,
  FINGERPRINT_REGIONS,
  buildBrowserHeadersFromFingerprint,
  generateFingerprint,
  mapCountryCodeToFingerprintRegion,
  normalizeFingerprintRegion,
  normalizeFingerprintRegionSetting,
  summarizeFingerprint,
} from './lib/device-fingerprint.js';
import {
  FIXED_LOCAL_PROXY_URL,
  configureProxyEnvironment,
  detectFixedProxyCountryCode,
  isInitialAuthEgressBlock,
  looksLikeCloudflareBlock,
  maskProxyUrl,
  parseProxyPool,
  resolveBuiltInProxyPool,
  resolveConfiguredProxyPool,
  resolveSessionProxy,
} from './lib/proxy-config.js';
import { createCurlCffiFetch, httpWorkerStats, startHttpWorkers, closeHttpWorkers } from './lib/curl-cffi-fetch.js';
import { measureStage } from './lib/stage-timing.js';
import { browserWorkerPool } from './lib/browser-worker-pool.js';
import { preflightProxyEgress } from './lib/proxy-preflight.js';
import { createRuntimeDependencyCheck } from './src/services/runtime-dependencies.js';
import { proxyHealthRegistry } from './lib/proxy-health.js';
import {
  humanPause,
  normalizeHumanTimingSettings,
  sampleHumanDelayMs,
} from './lib/human-timing.js';
import { authRetryDelayMs, isOpenAiRateLimitError, parseOpenAiAuthErrorUrl } from './src/lib/openai-auth-error.js';
import { normalizeAuthMode, authModeToPhoneMode } from './src/lib/auth-mode.js';
import { preflightAccountsForAuth } from './src/lib/auth-preflight.js';
import { normalizeFingerprintRecord, stringifyFingerprintRecord } from './src/lib/fingerprint-schema.js';
import { createDynamicSemaphore, createSemaphore } from './lib/async-semaphore.js';
import { sanitizeLogMessage } from './lib/log-sanitize.js';
import { createSmsProviderClient } from './src/services/provider-client-factories.js';
import {
  OpenAIPhoneSubmissionError,
  PHONE_ERROR_CATEGORIES,
  createOpenAIPhoneSubmissionError,
  nextPhoneRetryDecision,
} from './lib/openai-phone-errors.js';
import {
  cancelSmsActivationSnapshot,
  isReusableSmsActivationStatus,
} from './lib/sms-activation-state.js';
import {
  OPENAI_STAGES,
  inferOpenAiStage,
  normalizeOpenAiStage,
  stageStatusLabel,
} from './lib/account-stages.js';
import { SSEChannel, mapWithConcurrency } from './lib/sse.js';
import {
  SESSION_HEALTH,
  isAccountDeactivatedError,
  probeChatGptSessionAccessToken,
  sessionHealthLabel,
  shouldRequireExistingSession,
} from './src/services/session-health-service.js';
import {
  AUTH_BASE_URL,
  AUTH_AUTHORIZE_CONTINUE_URL,
  AUTH_PASSWORD_VERIFY_URL,
  AUTH_WORKSPACE_SELECT_URL,
  AUTH_PHONE_SEND_URL,
  AUTH_PHONE_OTP_SEND_URL,
  AUTH_PHONE_OTP_VALIDATE_URL,
  AUTH_MFA_VERIFY_URL,
  CHATGPT_BASE_URL,
  CHATGPT_AUTH_CSRF_URL,
  CHATGPT_AUTH_SIGNIN_OPENAI_URL,
  CHATGPT_AUTH_CALLBACK_OPENAI_URL,
  CHATGPT_AUTH_SESSION_URL,
  CHATGPT_LOGOUT_ALL_URL,
  CHATGPT_MFA_INFO_URL,
  CHATGPT_MFA_ENROLL_URL,
  CHATGPT_MFA_DISABLE_URL,
  CHATGPT_MFA_ACTIVATE_ENROLLMENT_URL,
  CHATGPT_ACCOUNTS_CHECK_URL,
  CHATGPT_PLUS_TRIAL_CAMPAIGN,
  CHATGPT_PLUS_TRIAL_ELIGIBILITY_URL,
  CHATGPT_CHECKOUT_PRICING_CONFIG_URL,
  normalizeAuthContinueUrl,
} from './lib/openai-auth-urls.js';
import {
  decodeJwtPayload,
  firstNonEmpty,
  getNestedRecord,
} from './lib/jwt-utils.js';
import {
  buildSub2ApiExport,
  buildSub2ApiJson,
  assertSub2ApiAccountShape,
} from './lib/export-sub2api.js';
import { Sub2ApiClient } from './lib/sub2api-client.js';
import {
  normalizeSub2ApiSettings,
  publicSub2ApiSettings,
  readSub2ApiSettingsDefaults,
} from './lib/sub2api-settings.js';
import {
  normalizeSequentialExportPrefix,
  nextSequentialExportPrefix,
  withExportFilePrefix,
  exportStampLocal,
  buildPrefixedExportFileName,
} from './lib/export-filename.js';
import { createOpenAISentinelTokenFetcher } from './lib/openai-sentinel.js';
import { structuredLog, durationMs } from './lib/structured-log.js';
import {
  generateTotpCode,
  hasTotpSecret,
  normalizeTotpSecret,
  validateTotpSecret,
} from './lib/totp.js';
import { createRuntimePaths } from './src/config/runtime-paths.js';
import { validateStartupConfig } from './src/config/startup-config.js';
import { registerSystemRoutes } from './src/api/system-routes.js';
import { initializeRuntime } from './src/services/runtime-service.js';
import { createApp } from './src/app/create-app.js';
import { converterMiddleware } from '../src/converter.js';
import { startServer } from './src/start-server.js';
import {
  normalizeEmail, stripExportNamePrefix, maskPhone, accountHasChatGptSession,
  publicAccountView as projectPublicAccount, userAccountView, parseManagementImportLine,
  parseUserImportLine, mergeImportedAccount, buildOriginalImportLine, protocolLoginCredentialIssue, resolveSessionPlanType,
  logoutAllCredentialIssue, resolveAccountLoginMethod,
} from './src/domain/accounts/account-domain.js';
import { createApiRetiredMiddleware } from './src/api/middleware/api-retired.js';
import { registerAdminSettingsRoutes } from './src/api/routes/admin-settings-routes.js';
import { wantsEventStream, runSseResponse } from './src/api/batch/sse-runner.js';
import { selectBatchScope } from './src/api/batch/scope-selector.js';
import { buildSessionHealthBatch } from './src/services/session-health-batch-service.js';
import { resolveProtocolLoginConcurrency } from './src/services/job-runner.js';
import { Sub2ApiPushService } from './src/services/sub2api-push-service.js';
import { buildStoredRtExportRecord, buildStoredBusinessRtExportRecords, partitionRtExportCandidates, selectRtExportAccounts } from './src/services/rt-export-service.js';
import {
  buildSessionCodexRtBatch,
  publicSessionCodexRtResult,
  runSessionCodexRtForAccounts,
} from './src/services/session-codex-rt-service.js';
import { runAllWorkspaceCodexAuth } from './src/services/protocol-login-pipeline.js';
import { withCachedWebSession, hasStoredAuthCookies, sessionApiError } from './src/services/cached-web-session.js';
import { normalizeStorageStateJson } from './lib/session-reuse.js';
import { normalizeBusinessWorkspaceIds, extractBusinessWorkspaceIds, extractSessionAccessToken, readWorkspaceSessionPayload, resolveWorkspaceSelection, validateBusinessAuthRecord } from './lib/business-workspace.js';
import { openOAuthPage } from './lib/oauth-navigation.js';
import { readWorkspacePagePayload } from './lib/workspace-page.js';
import { registerConversionRoutes } from './src/api/routes/conversion-routes.js';
import { registerSessionExportRoutes } from './src/api/routes/session-export-routes.js';
import { registerRemotePushRoutes } from './lib/remote-push.js';
import { createSqliteRuntime, bindSqliteRuntimeToApp } from './src/bootstrap/sqlite-runtime.js';
import { createSettingsComposition } from './src/bootstrap/server-composition.js';
import { createCaptchaProviderClient } from './src/services/provider-client-factories.js';
import { normalizeAccountIds, selectAccounts as selectAccountCollection } from './src/services/account-selection.js';
import { reconcileSessionPlanTypes } from './src/services/account-session-reconciliation.js';
import { reconcileAccountStage, reconcileAccountStages } from './src/services/account-stage-reconciliation.js';


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

function nowIso() {
  return new Date().toISOString();
}

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

function resolveOpenAiAccountPassword(account) {
  return String(account?.openai_password || account?.password || '').trim();
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
  websiteKey: String(process.env.OPENAI_TURNSTILE_SITEKEY || process.env.YESCAPTCHA_TURNSTILE_SITEKEY || '').trim(),
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
    websiteKey: String(value.websiteKey ?? value.website_key ?? value.sitekey ?? DEFAULT_YESCAPTCHA_SETTINGS.websiteKey ?? '').trim(),
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
  defaults: {
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

function agentIdentityRecordFromAccount(account) {
  const record = {
    auth_mode: OPENAI_AGENT_AUTH_MODE,
    agent_runtime_id: String(account?.agent_runtime_id || ''),
    agent_private_key: String(account?.agent_private_key || ''),
    account_id: String(account?.agent_account_id || ''),
    chatgpt_user_id: String(account?.agent_user_id || ''),
    email: String(account?.email || ''),
    plan_type: String(account?.agent_plan_type || 'free'),
    chatgpt_account_is_fedramp: Boolean(account?.agent_is_fedramp),
  };
  return isAgentIdentityRecord(record) ? record : null;
}

async function createAgentIdentityRecord(record, fetchImpl = fetch) {
  if (isAgentIdentityRecord(record)) return record;
  return registerOpenAIAgentIdentity({
    accessToken: String(record?.access_token || ''),
    email: String(record?.email || ''),
    fetchImpl,
  });
}

async function persistOpenAIAuthResult(accountId, record, phoneMode = 'sms') {
  if (!accountId || !record) return;
  if (isAgentIdentityRecord(record)) {
    await persistAgentIdentity(accountId, record);
    return;
  }
  const refreshToken = String(record.refresh_token || '').trim();
  if (!refreshToken) return;
  const accessToken = String(record.access_token || '').trim();
  const accessClaims = decodeJwtPayload(accessToken);
  const accessAuth = getNestedRecord(accessClaims, 'https://api.openai.com/auth');
  await accountRepository.updateById(accountId, {
    openai_rt: refreshToken,
    openai_access_token: accessToken,
    openai_id_token: String(record.id_token || '').trim(),
    openai_account_id: firstNonEmpty(record.account_id, accessAuth.chatgpt_account_id, accessAuth.account_id),
    openai_token_expires_at: Number(accessClaims.exp || 0),
    openai_stage: OPENAI_STAGES.RT_READY,
    last_error: '',
    status: phoneMode === 'sms' ? 'Codex接码成功' : 'RT已刷新',
  });
}

async function persistAgentIdentity(accountId, identity) {
  if (!accountId || !isAgentIdentityRecord(identity)) return;
  await accountRepository.updateById(accountId, {
    agent_runtime_id: identity.agent_runtime_id,
    agent_private_key: identity.agent_private_key,
    agent_account_id: identity.account_id,
    agent_user_id: identity.chatgpt_user_id,
    agent_plan_type: identity.plan_type || 'free',
    agent_is_fedramp: Boolean(identity.chatgpt_account_is_fedramp),
    openai_stage: OPENAI_STAGES.AGENT_READY,
    last_error: '',
    status: 'Agent Identity已生成',
  });
}

async function persistOpenAiStage(accountId, stage, { status, lastError } = {}) {
  if (!accountId) return;
  const normalized = normalizeOpenAiStage(stage);
  await accountRepository.updateById(accountId, latest => ({
    openai_stage: normalized,
    status: status != null ? String(status) : stageStatusLabel(normalized),
    ...(lastError != null ? { last_error: String(lastError || '') } : {}),
  }));
}

async function persistChatGptWebSession(accountId, {
  accessToken = '',
  session = null,
  storageState = '',
  status = 'Session已获取',
} = {}) {
  if (!accountId) return;
  const token = String(accessToken || '').trim();
  if (!token) throw new Error('persistChatGptWebSession 缺少 accessToken');
  const sessionJson = typeof session === 'string'
    ? session
    : JSON.stringify(session && typeof session === 'object' ? session : { accessToken: token }, null, 2);
  const storageStateJson = normalizeStorageStateJson(storageState);
  await accountRepository.updateById(accountId, latest => {
    const sessionPlanType = resolveSessionPlanType(sessionJson);
    return {
      session_access_token: token,
      session_json: sessionJson,
      storage_state_json: storageStateJson,
      ...(sessionPlanType ? { agent_plan_type: sessionPlanType } : {}),
      ...((![OPENAI_STAGES.REGISTERED, OPENAI_STAGES.SESSION_READY, OPENAI_STAGES.PHONE_PENDING, OPENAI_STAGES.MFA_PENDING, OPENAI_STAGES.RT_READY, OPENAI_STAGES.AGENT_READY].includes(normalizeOpenAiStage(latest.openai_stage)) || latest.openai_stage === OPENAI_STAGES.FAILED)
        ? { openai_stage: OPENAI_STAGES.REGISTERED } : {}),
      status: String(status || 'Session已获取'),
      last_error: '',
    };
  });
}

async function buildSub2ApiJsonForAccounts(accounts, { healthResults = [], initialErrors = [], skipHealthCheck = false } = {}) {
  const records = [];
  const errors = [...initialErrors];
  const exportedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const alive = selectRtExportAccounts(accounts, healthResults, { skipHealthCheck });
  const aliveIds = new Set(alive.map(item => String(item.account.id || '')));

  for (const account of accounts) {
    if (!aliveIds.has(String(account.id || ''))) {
      const result = healthResults.find(item => String(item.id || '') === String(account.id || ''));
      errors.push({ email: account.email, error: result?.error || result?.healthLabel || result?.health || 'Session 验活未通过' });
      continue;
    }
    try { records.push(buildStoredRtExportRecord(account)); }
    catch (error) { errors.push({ email: account.email, error: error instanceof Error ? error.message : String(error) }); }
  }

  const json = buildSub2ApiExport(records, exportedAt, getSub2ApiSettings());
  for (const account of json.accounts) assertSub2ApiAccountShape(account);
  const fileName = await buildExportFileName('sub2api-rt', 'json');
  return { json, fileName, text: `${JSON.stringify(json, null, 2)}\n`, success: records.length, failed: errors.length, errors };
}

async function resolveSub2ApiExportRecord(record, { phoneMode = '', fetchImpl = fetch } = {}) {
  const mode = normalizePhoneMode(phoneMode);
  if (isAgentIdentityRecord(record)) {
    if (mode === 'sms') throw new Error('当前凭据模式为 refresh_token，不能导出 Agent Identity；请切换模式或重新接码获取 RT');
    return record;
  }
  // rt 模式：只导出带 refresh_token 的 OAuth sub2api
  if (mode === 'sms') {
    if (!String(record?.refresh_token || '').trim()) {
      throw new Error('当前凭据模式为 refresh_token，但账号缺少 refresh_token，请先执行 Codex 登录接码');
    }
    return record;
  }
  // agent 模式：只导出 Agent Identity，不走 RT
  return createAgentIdentityRecord(record, fetchImpl);
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

function normalizeOpenAIAuthRecord(email, payload) {
  if (!payload.access_token) throw new Error(`token响应缺少 access_token: ${JSON.stringify(payload)}`);
  if (!payload.refresh_token) throw new Error(`token响应缺少 refresh_token: ${JSON.stringify(payload)}`);
  if (!payload.id_token) throw new Error(`token响应缺少 id_token: ${JSON.stringify(payload)}`);

  const accessClaims = decodeJwtPayload(payload.access_token);
  const idClaims = decodeJwtPayload(payload.id_token);
  const authClaim = getNestedRecord(accessClaims, 'https://api.openai.com/auth');
  const idAuthClaim = getNestedRecord(idClaims, 'https://api.openai.com/auth');
  const accountId = firstNonEmpty(authClaim.chatgpt_account_id, idAuthClaim.chatgpt_account_id);
  const exp = Number(accessClaims.exp || 0) || Math.floor(Date.now() / 1000) + Number(payload.expires_in || 0);
  if (!accountId) throw new Error(`token中缺少 account_id: ${JSON.stringify(accessClaims)}`);
  if (!exp) throw new Error(`access_token中缺少 exp: ${JSON.stringify(accessClaims)}`);

  return {
    access_token: payload.access_token,
    account_id: accountId,
    disabled: false,
    email: firstNonEmpty(idClaims.email, accessClaims.email, email),
    expired: new Date(exp * 1000).toISOString(),
    id_token: payload.id_token,
    last_refresh: new Date().toISOString(),
    refresh_token: payload.refresh_token,
    type: 'codex',
    websockets: false,
  };
}

class OpenAIJsonAuthFlow {
  constructor(account, sse, {
    phoneMode = 'sms',
    agentIdentityEnabled,
    reuseStoredSession = false,
    forbidPhoneChallenge = false,
    workspaceSelection = { mode: 'personal' },
    requireStoredSession = false,
    humanPacingEnabled,
    proxyPool,
    directWhenProxyPoolEmpty = false,
  } = {}) {
    this.account = account;
    this.sse = sse;
    this.isolationId = randomUUID();
    const session = createAccountSessionDeviceAndProxy(account, { proxyPool, directWhenProxyPoolEmpty });
    this.fingerprint = session.fingerprint;
    this.proxyUrl = session.proxy.proxyUrl;
    this.directEgress = session.proxy.mode === 'direct';
    this.proxyLabel = session.proxy.label;
    this.baseFetch = createCurlCffiFetch(this.proxyUrl, { direct: this.directEgress });
    this.jar = new CookieJar();
    this.fetch = makeFetchCookie(this.baseFetch, this.jar);
    this.state = '';
    this.codeVerifier = '';
    this.deviceID = '';
    // phoneMode 优先；兼容旧参数 agentIdentityEnabled（true=agent，false=sms）
    if (agentIdentityEnabled === true) this.phoneMode = 'agent';
    else if (agentIdentityEnabled === false) this.phoneMode = 'sms';
    else this.phoneMode = normalizePhoneMode(phoneMode);
    this.agentIdentityEnabled = this.phoneMode === 'agent';
    this.reuseStoredSession = Boolean(reuseStoredSession);
    this.smsCodeTimeoutMs = getPhoneOtpWaitTimeoutMs();
    this.requireStoredSession = Boolean(requireStoredSession);
    this.forbidPhoneChallenge = Boolean(forbidPhoneChallenge);
    this.humanPacingExplicit = typeof humanPacingEnabled === 'boolean';
    // Keep human pacing configurable; login and RT conversion default to fast execution.
    this.humanPacingEnabled = typeof humanPacingEnabled === 'boolean'
      ? humanPacingEnabled
      : false;
    const workspaceMode = workspaceSelection?.mode === 'id' ? 'id' : 'personal';
    this.workspaceSelection = { mode: workspaceMode, workspaceId: workspaceMode === 'id' ? String(workspaceSelection?.workspaceId || '').trim() : '' };
    if (workspaceMode === 'id' && !this.workspaceSelection.workspaceId) throw new Error('Business workspace ID 不能为空');
    this.smsProvider = createSmsBowerClient();
    this.smsProviderLabel = getSmsProviderLabel();
    this.smsActivation = null;
    this.smsAcquirePlanner = null;
    for (const [method, stage] of Object.entries({
      startOAuthSession: 'oauth_start', startChatGptWebSignIn: 'oauth_start',
      authorizeContinue: 'username', passwordVerify: 'password', mfaValidate: 'totp',
      fetchSentinelToken: 'sentinel', exchangeCodeForToken: 'token_exchange', readChatGptAccessToken: 'session',
    })) {
      const operation = this[method].bind(this);
      this[method] = (...args) => measureStage(stage, () => operation(...args));
    }
  }

  browserHeaders(init = {}) {
    return buildBrowserHeaders(init, this.fingerprint);
  }

  log(msg, level = 'info') {
    this.sse.send('log', { time: new Date().toISOString(), level, msg: sanitizeLogMessage(msg) });
  }

  noteSmsAcquireFailure(reason = '') {
    if (!this.smsAcquirePlanner) return null;
    const decision = this.smsAcquirePlanner.recordFailure(reason);
    const label = SMSBOWER_COUNTRY_LABELS[decision.country] || decision.country || '未知';
    if (decision.switched === 'country') {
      this.log(`SMS 取号策略：同一国家已失败 ${decision.failsBeforeSwitch} 次，切换到 ${label}，maxPrice=${decision.workingMaxPrice}`, 'warn');
    } else if (decision.switched === 'price') {
      this.log(`SMS 取号策略：国家列表已用尽，提高 maxPrice → ${decision.workingMaxPrice}（上限 ${decision.ceilingMaxPrice}），回到 ${label}`, 'warn');
    } else if (decision.exhausted) {
      this.log(`SMS 取号策略：国家与价格均已尝试至上限 ${decision.ceilingMaxPrice}，停止换号`, 'warn');
    } else {
      this.log(`SMS 取号策略：国家 ${label} 失败 ${decision.failsOnCurrent}/${decision.failsBeforeSwitch}（maxPrice=${decision.workingMaxPrice}）`, 'warn');
    }
    return decision;
  }

  async ensureSmsAcquirePlanner(settings = getSmsBowerSettings()) {
    if (this.smsAcquirePlanner && !this.smsAcquirePlanner.isExhausted()) return this.smsAcquirePlanner;
    const service = settings.service || SMSBOWER_OPENAI_SERVICE;
    let countries = [...(settings.countries || [])];
    if (!countries.length) {
      this.log(`SMSBower 未限定国家，按服务 ${service} 拉取 getPrices 并按最低价匹配`);
      const prices = await this.smsProvider.getPrices({ service });
      const priceRows = rankServiceCountriesByPrice(prices, service, {
        maxPrice: settings.maxPrice,
        minPrice: settings.minPrice,
      });
      countries = resolveSmsAcquireCountries({ configuredCountries: [], priceRows });
      if (!countries.length) {
        throw new Error(`SMSBower 服务 ${service} 在价格/库存筛选后没有可取号国家（maxPrice=${settings.maxPrice || '无'}）`);
      }
      const preview = priceRows.slice(0, 5).map(row => `${row.country}=$${row.cost}`).join(', ');
      this.log(`SMSBower 最低价候选国家（前 ${Math.min(5, priceRows.length)}）：${preview}`);
    }
    this.smsAcquirePlanner = createSmsCountryPricePlanner({
      countries,
      minPrice: settings.minPrice,
      maxPrice: settings.maxPrice,
      priceStep: settings.priceStep || SMSBOWER_PRICE_STEP,
      failsBeforeSwitch: settings.failsBeforeSwitch || SMSBOWER_FAILS_BEFORE_SWITCH,
    });
    const snap = this.smsAcquirePlanner.snapshot();
    const label = SMSBOWER_COUNTRY_LABELS[snap.country] || snap.country || '未知';
    this.log(`SMS 取号策略：起始国家 ${label}，maxPrice=${snap.workingMaxPrice}→上限 ${snap.ceilingMaxPrice}，同国 ${snap.failsBeforeSwitch} 次失败后换国家/抬价`);
    return this.smsAcquirePlanner;
  }

  logProtocolHardening() {
    const smsWait = this.phoneMode === 'sms' ? ` · 单号等码=${Math.round(this.smsCodeTimeoutMs / 1000)}s` : '';
    this.log(`协议隔离环境 ${this.isolationId.slice(0, 8)}: 独立Cookie/设备/OAuth状态 · 指纹=${summarizeFingerprint(this.fingerprint)} · 出口=${this.proxyLabel}${smsWait}`);
  }

  async ensureProxyConnectivity() {
    this.proxyPreflight ||= (async () => {
      this.log(`代理连通性检测开始：出口=${this.proxyLabel} · 目标=auth.openai.com`);
      try {
        const result = await preflightProxyEgress(this.proxyUrl, {
          direct: this.directEgress,
          headers: this.browserHeaders({ accept: 'text/html,application/xhtml+xml,*/*' }),
        });
        this.log(`代理连通性检测通过：HTTP ${result.status}，耗时 ${result.latencyMs}ms，开始正式流程`);
        return result;
      } catch (error) {
        this.log(error.message || String(error), 'error');
        throw error;
      }
    })();
    return this.proxyPreflight;
  }

  async dispose() {
    const current = this.baseFetch;
    this.fetch = null;
    this.baseFetch = null;
    await current?.dispose?.();
  }

  async humanPause(kind = 'navigate') {
    const timing = getProtocolHumanTiming();
    const enabled = this.humanPacingEnabled ?? timing.humanPacingEnabled;
    if (!enabled) return 0;
    const ms = await humanPause(kind, {
      enabled,
      accountGapMsMin: timing.accountGapMsMin,
      accountGapMsMax: timing.accountGapMsMax,
      sleep,
    });
    if (ms >= 1500) this.log(`人类节奏停顿 ${ms}ms (${kind})`);
    return ms;
  }

  throwProxyEdgeBlocked(status, extra = '') {
    const detail = String(extra || '').trim();
    const error = new Error(
      `代理出口被 Cloudflare/OpenAI 拦截: HTTP ${status} · 出口=${this.proxyLabel}${detail ? ` · ${detail}` : ''}`
      + ' · auth/login 初始拦截属于当前出口，不代表账号失效',
    );
    error.code = 'PROXY_EDGE_BLOCKED';
    error.status = Number(status) || 0;
    throw error;
  }

  async readCookie(url, key) {
    const cookies = await this.jar.getCookies(url);
    return cookies.find(cookie => cookie.key === key)?.value || '';
  }

  isPhoneChallengeUrl(url) {
    const text = String(url || '');
    return text.startsWith(`${AUTH_BASE_URL}/add-phone`)
      || text.startsWith(`${AUTH_BASE_URL}/phone-otp/select-channel`)
      || text.startsWith(`${AUTH_BASE_URL}/phone-verification`);
  }

  async handlePhoneChallenge(url) {
    if (this.phoneMode === 'agent') {
      return this.registerAgentIdentityFromWebSession();
    }
    if (String(url || '').startsWith(`${AUTH_BASE_URL}/add-phone`)) {
      return this.handleAddPhone();
    }
    if (String(url || '').startsWith(`${AUTH_BASE_URL}/phone-otp/select-channel`)) {
      return this.handlePhoneOtpSelectChannel();
    }
    if (String(url || '').startsWith(`${AUTH_BASE_URL}/phone-verification`)) {
      return this.handlePhoneVerification();
    }
    throw new Error(`未知手机验证页: ${url}`);
  }

  async registerAgentIdentityFromWebSession() {
    if (!this.agentIdentityEnabled) throw new Error('当前为 Codex 登录接码模式，无法跳过手机验证；如需跳过请选择 Agent Identity 转换');
    this.log('遇到手机验证，切换 Agent Identity 模式并跳过短信接码');
    let lastError = 'Web Session 中无 accessToken';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.fetch('https://chatgpt.com/', {
          headers: this.browserHeaders({ accept: 'text/html,*/*' }),
        });
        const response = await this.fetch('https://chatgpt.com/api/auth/session', {
          headers: this.browserHeaders({
            accept: 'application/json',
            referer: 'https://chatgpt.com/',
          }),
        });
        const text = await response.text();
        let session = {};
        try { session = text ? JSON.parse(text) : {}; } catch {}
        const accessToken = firstNonEmpty(session.accessToken, session.access_token, session.token);
        if (!response.ok || !accessToken) {
          lastError = `HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`;
        } else {
          const identity = await registerOpenAIAgentIdentity({
            accessToken,
            email: this.account.email,
            fetchImpl: this.fetch,
          });
          await persistAgentIdentity(this.account.id, identity);
          this.log(`Agent Identity 注册成功: ${identity.agent_runtime_id}`);
          return identity;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < 3) await sleep(1000);
    }
    throw new Error(`跳过短信接码失败: ${lastError}`);
  }

  prepareLoginUrl(prompt = 'login', { useLoginHint = true } = {}) {
    const pkce = generateOpenAIPkce();
    this.state = pkce.state;
    this.codeVerifier = pkce.codeVerifier;
    return buildOpenAIAuthorizationUrl({
      state: this.state,
      codeChallenge: pkce.codeChallenge,
      redirectUri: OPENAI_CODEX_REDIRECT_URI,
      prompt,
      loginHint: useLoginHint ? this.account.email : '',
    });
  }

  resetAuthSession() {
    // Keep sticky fingerprint + proxy for the whole account session; only refresh cookies.
    this.baseFetch?.dispose?.();
    this.baseFetch = createCurlCffiFetch(this.proxyUrl, { direct: this.directEgress });
    this.jar = new CookieJar();
    this.fetch = makeFetchCookie(this.baseFetch, this.jar);
    this.state = '';
    this.codeVerifier = '';
    this.deviceID = '';
    this.smsActivation = null;
    this.mfaFactorId = '';
    this.mfaContinueUrl = '';
    this.mfaPayload = null;
    this.discoveredWorkspaces = null;
  }

  isPasswordTotpAccount() {
    return resolveAccountLoginMethod(this.account) === 'password_totp';
  }

  assertPasswordTotpCredentials() {
    const issue = protocolLoginCredentialIssue(this.account);
    if (issue) throw Object.assign(new Error(issue), { code: 'LOGIN_CREDENTIALS_MISSING' });
  }

  assertSupportedAuthStep({ continueUrl = '' } = {}) {
    if (!String(continueUrl || '').trim()) return;
    const path = this.pathOf(continueUrl).toLowerCase();
    if (
      continueUrl.startsWith(OPENAI_CODEX_REDIRECT_URI)
      || this.isAuthStartUrl(continueUrl)
      || this.isConsentUrl(continueUrl)
      || this.isPhoneChallengeUrl(continueUrl)
      || this.isOAuthTransitionUrl(continueUrl)
      || this.isChatGptUrl(continueUrl)
    ) return;
    throw Object.assign(new Error(`协议登录遇到不支持的认证步骤: ${path || 'unknown'}`), {
      code: 'UNSUPPORTED_LOGIN_STEP',
    });
  }

  isMfaChallenge({ pageType = '', continueUrl = '' } = {}) {
    const page = String(pageType || '').toLowerCase();
    const url = String(continueUrl || '').toLowerCase();
    const path = this.pathOf(continueUrl).toLowerCase();
    return page.includes('mfa')
      || page.includes('totp')
      || url.includes('mfa')
      || url.includes('2fa')
      || path.includes('/mfa')
      || path.includes('/mfa-challenge')
      || path.includes('/two-factor');
  }

  extractMfaFactorId(result = {}) {
    const roots = [
      result?.payload?.page?.payload,
      result?.payload?.payload,
      result?.page?.payload,
      result?.payload,
      result,
    ].filter(Boolean);
    for (const payload of roots) {
      const factors = Array.isArray(payload.factors) ? payload.factors : [];
      const totpFactors = Array.isArray(payload?.factors?.totp) ? payload.factors.totp : [];
      const fromPayload = firstNonEmpty(
        payload.factor_id,
        payload.factorId,
        payload.native_default_factor_id,
        factors[0]?.id,
        totpFactors[0]?.id,
      );
      if (fromPayload) return String(fromPayload).trim();
    }
    const url = String(result?.continueUrl || result?.payload?.continue_url || '');
    const match = url.match(/\/mfa-challenge\/([a-zA-Z0-9_-]+)/i);
    return match?.[1] || this.mfaFactorId || '';
  }

  async startOAuthSession({ useLoginHint = true, prompt = 'login' } = {}) {
    await this.ensureProxyConnectivity();
    const oauthUrl = this.prepareLoginUrl(prompt, { useLoginHint });
    const { url: landedUrl } = await openOAuthPage(this.fetch, oauthUrl, {
      callbackUrl: OPENAI_CODEX_REDIRECT_URI,
      headers: this.browserHeaders({
        'accept-encoding': 'gzip, deflate, br',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
      }),
    });
    if (landedUrl.startsWith(OPENAI_CODEX_REDIRECT_URI)) {
      return { done: true, callbackUrl: landedUrl };
    }
    if (!this.isAuthStartUrl(landedUrl) && !this.isConsentUrl(landedUrl)) {
      throw new Error(`OauthUrl重定向到错误的路径: ${this.pathOf(landedUrl)}`);
    }
    this.deviceID = await this.readCookie('https://openai.com', 'oai-did')
      || await this.readCookie(AUTH_BASE_URL, 'oai-did');
    if (!this.deviceID) throw new Error('OauthUrl未返回 oai-did cookie');
    this.log(`Codex OAuth 落点: ${this.pathOf(landedUrl)}`);
    return { done: false, continueUrl: landedUrl };
  }

  async formatErrorResponse(response) {
    const body = await response.text();
    try {
      const payload = JSON.parse(body);
      const code = payload?.error?.code || payload?.error;
      if (code) return `${response.status} code=${code}`;
    } catch {}
    return `${response.status} body=${body}`;
  }

  async fetchSentinelToken(flow) {
    return fetchOpenAISentinelToken(this.fetch, this.deviceID, flow, {
      fingerprint: this.fingerprint,
      proxyUrl: this.proxyUrl,
    });
  }

  async authorizeContinue({ screenHint = '', referer = `${AUTH_BASE_URL}/log-in` } = {}) {
    const sentinelToken = await this.fetchSentinelToken('authorize_continue');
    const body = {
      username: {
        kind: 'email',
        value: this.account.email,
      },
    };
    if (screenHint) body.screen_hint = screenHint;
    const response = await this.fetch(AUTH_AUTHORIZE_CONTINUE_URL, {
      method: 'POST',
      headers: this.browserHeaders({
        'content-type': 'application/json',
        'openai-sentinel-token': sentinelToken,
        origin: AUTH_BASE_URL,
        referer,
      }),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`AuthorizeContinue请求失败: ${await this.formatErrorResponse(response)}`);
    const raw = await response.text();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      const preview = String(raw || '').trim().slice(0, 200);
      throw new Error(`AuthorizeContinue响应不是JSON: ${preview || (error instanceof Error ? error.message : String(error))}`);
    }
    return {
      continueUrl: normalizeAuthContinueUrl(payload.continue_url),
      pageType: String(payload?.page?.type || ''),
      payload,
    };
  }

  async passwordVerify() {
    const password = resolveOpenAiAccountPassword(this.account);
    if (!password) throw new Error('账号缺少 OpenAI 密码，无法完成密码登录');
    const sentinelToken = await this.fetchSentinelToken('password_verify');
    const response = await this.fetch(AUTH_PASSWORD_VERIFY_URL, {
      method: 'POST',
      headers: this.browserHeaders({
        accept: 'application/json',
        'content-type': 'application/json',
        'openai-sentinel-token': sentinelToken,
        origin: AUTH_BASE_URL,
        referer: `${AUTH_BASE_URL}/log-in/password`,
      }),
      body: JSON.stringify({ password }),
    });
    if (!response.ok) throw new Error(`PasswordVerify请求失败: ${await this.formatErrorResponse(response)}`);
    const payload = await response.json();
    const result = {
      continueUrl: normalizeAuthContinueUrl(payload.continue_url),
      pageType: String(payload?.page?.type || ''),
      payload,
    };
    this.assertSupportedAuthStep(result);
    // Some valid MFA responses carry the factor only in the JSON payload.
    const factorId = this.extractMfaFactorId(result);
    if (factorId) {
      if (!this.isMfaChallenge(result)) result.pageType = 'mfa_challenge';
      if (!result.continueUrl) result.continueUrl = `${AUTH_BASE_URL}/mfa-challenge/${factorId}`;
    }
    if (!result.continueUrl) throw new Error('PasswordVerify响应缺少 continue_url 或 MFA factor');
    return result;
  }

  async mfaValidate(passwordResult = null) {
    if (!hasTotpSecret(this.account)) {
      throw new Error('遇到 2FA/MFA 验证，但账号未配置 TOTP 密钥（email|password|2fa）');
    }
    const factorId = this.extractMfaFactorId(passwordResult || { continueUrl: this.mfaContinueUrl, payload: this.mfaPayload });
    if (!factorId) {
      throw new Error('MFA 挑战缺少 factor id，无法提交 TOTP');
    }
    this.mfaFactorId = factorId;
    const continueUrl = normalizeAuthContinueUrl(
      passwordResult?.continueUrl || this.mfaContinueUrl || `${AUTH_BASE_URL}/mfa-challenge/${factorId}`,
    );
    if (continueUrl) {
      await this.fetch(continueUrl, {
        method: 'GET',
        headers: this.browserHeaders({
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          referer: `${AUTH_BASE_URL}/log-in/password`,
        }),
      }).catch(() => null);
    }

    this.log(`提交 TOTP 2FA 验证码 (factor=${factorId.slice(0, 8)}…)`);
    const sentinelToken = await this.fetchSentinelToken('authorize_continue').catch(() => '');
    const code = generateTotpCode(this.account.two_factor_secret);
    const headers = this.browserHeaders({
      accept: 'application/json',
      'content-type': 'application/json',
      origin: AUTH_BASE_URL,
      referer: continueUrl || `${AUTH_BASE_URL}/mfa-challenge/${factorId}`,
    });
    if (sentinelToken) headers['openai-sentinel-token'] = sentinelToken;
    const response = await this.fetch(AUTH_MFA_VERIFY_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'totp', id: factorId, code }),
    });
    if (!response.ok) {
      throw new Error(`MFAVerify请求失败: ${await this.formatErrorResponse(response)}`);
    }
    const payload = await response.json().catch(() => ({}));
    return {
      continueUrl: normalizeAuthContinueUrl(payload.continue_url || `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`),
      pageType: String(payload?.page?.type || ''),
      payload,
    };
  }

  pathOf(url) {
    try {
      return new URL(String(url || ''), AUTH_BASE_URL).pathname.replace(/\/$/, '') || '/';
    } catch {
      return String(url || '');
    }
  }

  isAuthStartUrl(url) {
    const path = this.pathOf(url);
    return [
      '/log-in',
      '/log-in/password',
      '/log-in/mfa',
      '/mfa-challenge',
      '/sign-in-with-chatgpt/codex/consent',
      '/add-phone',
      '/phone-otp/select-channel',
      '/phone-verification',
      '/mfa',
      '/two-factor',
      '/consent',
    ].includes(path)
      || path.startsWith('/add-phone')
      || path.startsWith('/phone-otp/')
      || path.startsWith('/phone-verification')
      || path.startsWith('/log-in/mfa')
      || path.startsWith('/mfa-challenge')
      || path.startsWith('/mfa')
      || path.startsWith('/two-factor')
      || path.includes('consent');
  }

  isConsentUrl(url) {
    const path = this.pathOf(url);
    return path === '/sign-in-with-chatgpt/codex/consent'
      || path === '/consent'
      || path === '/workspace'
      || path.endsWith('/consent')
      || path.includes('consent')
      || path.includes('/workspace');
  }

  isChatGptUrl(url) {
    return String(url || '').includes('chatgpt.com');
  }

  isOAuthTransitionUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.origin === AUTH_BASE_URL
        && ['/oauth/authorize', '/api/oauth/oauth2/auth'].includes(parsed.pathname);
    } catch { return false; }
  }

  async advanceAuthStep(continueURL, { phase = 'codex' } = {}) {
    let url = continueURL;
    let workspaceSessionRecoveryAttempted = false;
    let credentialAuthCompleted = false;
    const chatgptLike = phase === 'chatgpt';
    if (!this.requireStoredSession) this.assertPasswordTotpCredentials();
    for (let step = 0; step < 14; step += 1) {
      this.assertSupportedAuthStep({ continueUrl: url });
      await this.humanPause(step === 0 ? 'think' : 'navigate');
      const path = this.pathOf(url);
      if (url.startsWith(OPENAI_CODEX_REDIRECT_URI)) return url;
      if (chatgptLike && (this.isChatGptUrl(url) || String(url).includes('code='))) {
        return url;
      }

      if (this.isOAuthTransitionUrl(url)) {
        const { url: nextUrl } = await openOAuthPage(this.fetch, url, {
          callbackUrl: chatgptLike ? CHATGPT_AUTH_CALLBACK_OPENAI_URL : OPENAI_CODEX_REDIRECT_URI,
          headers: this.browserHeaders({ accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }),
        });
        if (nextUrl === url) throw new Error(`OAuth 授权中转未返回下一步: ${path}`);
        url = nextUrl;
        continue;
      }

      if (this.isPhoneChallengeUrl(url)) {
        if (phase === 'chatgpt') {
          throw new Error(`退出全部会话需要已完成手机验证；当前停在: ${path || url}`);
        }
        if (this.forbidPhoneChallenge) {
          throw new Error(`Codex OAuth 仍要求手机验证，已按要求禁止新接码: ${path || url}`);
        }
        this.log(this.phoneMode === 'agent' ? '遇到手机验证，使用 Agent Identity 转换' : '遇到手机验证，使用 Codex 登录接码');
        const phoneResult = await this.handlePhoneChallenge(url);
        if (isAgentIdentityRecord(phoneResult)) return phoneResult;
        url = phoneResult;
        continue;
      }

      if (path === '/log-in') {
        const screenHint = '';
        const referer = `${AUTH_BASE_URL}/log-in`;
        this.log('提交登录邮箱');
        await this.humanPause('type');
        let result = await this.authorizeContinue({ screenHint, referer });
        const pageType = String(result.pageType || '').toLowerCase();
        const nextPath = this.pathOf(result.continueUrl);

        if (pageType.includes('login_password') || nextPath === '/log-in/password') {
          this.log('提交账号密码');
          this.assertPasswordTotpCredentials();
          result = await this.passwordVerify();
          if (this.isMfaChallenge(result)) {
            this.mfaContinueUrl = result.continueUrl;
            this.mfaPayload = result.payload;
            this.mfaFactorId = this.extractMfaFactorId(result);
            this.log('密码后进入 2FA/MFA，提交 TOTP');
            result = await this.mfaValidate(result);
          }
          credentialAuthCompleted = true;
          url = result.continueUrl;
          continue;
        }

        url = result.continueUrl;
        continue;
      }

      if (path === '/log-in/password') {
        this.log('提交账号密码');
        this.assertPasswordTotpCredentials();
        let result = await this.passwordVerify();
        if (this.isMfaChallenge(result)) {
          this.mfaContinueUrl = result.continueUrl;
          this.mfaPayload = result.payload;
          this.mfaFactorId = this.extractMfaFactorId(result);
          this.log('密码后进入 2FA/MFA，提交 TOTP');
          result = await this.mfaValidate(result);
        }
        credentialAuthCompleted = true;
        url = result.continueUrl;
        continue;
      }

      if (
        path === '/mfa'
        || path === '/log-in/mfa'
        || path.startsWith('/mfa-challenge')
        || path.startsWith('/mfa')
        || path.startsWith('/two-factor')
        || path.includes('mfa')
      ) {
        this.log('提交 TOTP 2FA 验证码');
        if (!this.mfaFactorId) {
          this.mfaFactorId = path.split('/').filter(Boolean).pop() || '';
          this.mfaContinueUrl = url;
        }
        const result = await this.mfaValidate({
          continueUrl: url,
          payload: { page: { payload: { factor_id: this.mfaFactorId } } },
        });
        this.assertSupportedAuthStep(result);
        credentialAuthCompleted = true;
        url = result.continueUrl;
        continue;
      }

      if (this.isConsentUrl(url)) {
        this.log(this.workspaceSelection.mode === 'id' ? '选择指定 Business 工作区' : '选择默认工作区');
        try {
          url = await this.selectWorkspace(url);
        } catch (error) {
          const missingWorkspaceSession = ['WORKSPACE_SESSION_MISSING', 'WORKSPACE_SESSION_INVALID'].includes(error?.code);
          if (missingWorkspaceSession && credentialAuthCompleted) {
            throw Object.assign(new Error('已完成账号验证，但授权页和 Cookie 均未返回可用工作区列表；已停止，不再重复提交密码/TOTP'), {
              code: 'WORKSPACE_DISCOVERY_FAILED',
            });
          }
          if (!missingWorkspaceSession || !['codex', 'chatgpt'].includes(phase) || !this.isPasswordTotpAccount() || workspaceSessionRecoveryAttempted) throw error;
          workspaceSessionRecoveryAttempted = true;
          if (phase === 'chatgpt') {
            this.log(`${error.message}；重新建立 ChatGPT Web 会话并执行密码/TOTP 验证（仅重试一次）`, 'warn');
            const restarted = await this.startChatGptWebSignIn();
            url = restarted.continueUrl;
            continue;
          }
          this.log(`${error.message}；重新建立 Codex OAuth 并执行密码/TOTP 验证（仅重试一次）`, 'warn');
          // A valid ChatGPT Web Session does not guarantee a usable auth-domain
          // workspace session. Do not re-import the same incomplete cookie jar.
          this.resetAuthSession();
          const restarted = await this.startOAuthSession({ useLoginHint: true, prompt: 'login' });
          this.assertStoredSessionContinuation(restarted);
          url = restarted.done ? restarted.callbackUrl : restarted.continueUrl;
        }
        continue;
      }

      return url;
    }
    throw new Error(`认证步骤次数过多，最后停在: ${this.pathOf(url)}`);
  }

  async loginCodexWithPhone({ preserveAuthSession = false } = {}) {
    if (!preserveAuthSession && !this.requireStoredSession) this.assertPasswordTotpCredentials();
    if (!this.humanPacingExplicit) this.humanPacingEnabled = false;
    this.log(this.forbidPhoneChallenge
      ? 'Codex OAuth：工作区授权，禁止手机号验证'
      : this.phoneMode === 'sms'
      ? 'Codex OAuth：登录并获取 refresh_token'
      : '阶段2/2：Codex 登录 + Agent Identity 转换');
    if (!preserveAuthSession) {
      this.resetAuthSession();
      if (this.reuseStoredSession) await this.importStoredCookieStorageState();
    }
    const started = await this.startOAuthSession({
      useLoginHint: true,
      prompt: preserveAuthSession || this.reuseStoredSession ? '' : 'login',
    });
    this.assertStoredSessionContinuation(started);
    if (started.done) {
      const result = this.extractAuthResult(started.callbackUrl);
      return this.exchangeCodeForToken(result.code);
    }

    let continueURL = started.continueUrl;
    const advanced = await this.advanceAuthStep(continueURL, { phase: 'codex' });
    if (isAgentIdentityRecord(advanced)) return advanced;
    continueURL = advanced;
    if (this.forbidPhoneChallenge && this.isPhoneChallengeUrl(continueURL)) {
      throw new Error(`Codex OAuth 仍要求手机验证，已按要求禁止新接码: ${this.pathOf(continueURL) || continueURL}`);
    }

    this.log(this.forbidPhoneChallenge
      ? '工作区授权完成，交换 code 获取 refresh_token'
      : this.phoneMode === 'sms'
        ? '接码完成，交换授权 code 获取 refresh_token'
        : '交换授权 code 获取 refresh_token');
    this.log(`继续 OAuth 跳转: ${continueURL}`);
    const result = await this.followOAuthRedirects(continueURL);
    if (isAgentIdentityRecord(result)) return result;
    return this.exchangeCodeForToken(result.code);
  }

  async resolveWorkspaceID(consentHtml = '') {
    const pagePayload = readWorkspacePagePayload(consentHtml);
    if (pagePayload) {
      this.discoveredWorkspaces = pagePayload.workspaces;
      this.log(`已从授权页读取 ${pagePayload.workspaces.length} 个工作区`);
      return resolveWorkspaceSelection(pagePayload, this.workspaceSelection);
    }
    // Do not maintain a fixed list of OpenAI hosts here. The auth service has
    // used auth.openai.com, child.auth.openai.com and other subdomains over
    // time, and the cookie may be scoped to a non-root consent/API path. A
    // serialized jar enumerates every domain/path (including host-only
    // cookies) without making a value-bearing request to a guessed origin.
    const state = await this.jar.serialize();
    const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
    try {
      const payload = readWorkspaceSessionPayload(cookies);
      this.discoveredWorkspaces = payload.workspaces;
      return resolveWorkspaceSelection(payload, this.workspaceSelection);
    } catch (error) {
      const details = cookies
        .map(cookie => `${cookie.name || cookie.key} [domain=${cookie.domain || '(host)'} path=${cookie.path || '/'}]`)
        .filter(Boolean)
        .slice(0, 40)
        .join(', ');
      this.log(`工作区 Cookie 诊断: count=${cookies.length}${details ? `; ${details}` : '; none'}`, 'warn');
      throw error;
    }
  }

  async selectWorkspace(consentURL) {
    const { url: landedUrl, response: consentResponse } = await openOAuthPage(this.fetch, consentURL, {
      callbackUrl: OPENAI_CODEX_REDIRECT_URI,
      headers: this.browserHeaders({
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        referer: consentURL,
      }),
    });
    // Consent can redirect to a callback, phone challenge or renewed login.
    // Let the state machine process the actual step before demanding a cookie.
    if (!this.isConsentUrl(landedUrl)) {
      if (!landedUrl.startsWith(OPENAI_CODEX_REDIRECT_URI) && !this.isAuthStartUrl(landedUrl)) {
        throw new Error(`工作区授权跳转到未知路径: ${this.pathOf(landedUrl)}`);
      }
      this.log(`工作区授权跳转到: ${this.pathOf(landedUrl)}`);
      return landedUrl;
    }
    this.log(`工作区授权页: HTTP ${consentResponse.status} path=${this.pathOf(landedUrl)}`);
    const workspaceID = await this.resolveWorkspaceID(await consentResponse.text());
    const response = await this.fetch(AUTH_WORKSPACE_SELECT_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: this.browserHeaders({
        accept: 'application/json',
        'content-type': 'application/json',
        origin: AUTH_BASE_URL,
        referer: landedUrl,
      }),
      body: JSON.stringify({ workspace_id: workspaceID }),
    });
    const location = response.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      return new URL(location, AUTH_WORKSPACE_SELECT_URL).toString();
    }
    if (!response.ok) throw new Error(`WorkspaceSelect请求失败: ${await this.formatErrorResponse(response)}`);
    const payload = await response.json();
    const continueUrl = normalizeAuthContinueUrl(payload.continue_url);
    if (!continueUrl) throw new Error('WorkspaceSelect 响应缺少 continue_url');
    return continueUrl;
  }

  async sendPhoneOtp(phoneNumber) {
    let response;
    try {
      response = await this.fetch(AUTH_PHONE_SEND_URL, {
        method: 'POST',
        headers: this.browserHeaders({
          accept: 'application/json',
          'content-type': 'application/json',
          origin: AUTH_BASE_URL,
          referer: `${AUTH_BASE_URL}/add-phone`,
        }),
        body: JSON.stringify({ phone_number: phoneNumber }),
      });
    } catch (error) {
      throw createOpenAIPhoneSubmissionError({
        code: error?.code || error?.cause?.code || 'transport_error',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    let rawBody = '';
    try {
      rawBody = await response.text();
    } catch (error) {
      throw createOpenAIPhoneSubmissionError({
        code: error?.code || error?.cause?.code || 'response_read_error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    let payload = {};
    try { payload = rawBody ? JSON.parse(rawBody) : {}; } catch {}
    const code = String(payload?.error?.code || payload?.error || payload?.code || '');
    const message = String(payload?.error?.message || payload?.message || code || rawBody.slice(0, 500));
    if (!response.ok) {
      throw createOpenAIPhoneSubmissionError({
        httpStatus: response.status,
        code,
        message,
        rawBody,
      });
    }
    let continueURL = '';
    try {
      const candidate = normalizeAuthContinueUrl(payload.continue_url);
      const parsed = new URL(candidate);
      if (['http:', 'https:'].includes(parsed.protocol)) continueURL = parsed.toString();
    } catch {}
    if (!continueURL) {
      throw new OpenAIPhoneSubmissionError('SendPhoneOtp 响应缺少有效 continue_url', {
        httpStatus: response.status,
        code: code || 'missing_continue_url',
        rawBody,
        category: PHONE_ERROR_CATEGORIES.NUMBER_REJECTED,
      });
    }
    return continueURL;
  }
  async openAddPhonePage() {
    await this.fetch(`${AUTH_BASE_URL}/add-phone`, {
      method: 'GET',
      headers: this.browserHeaders({
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        referer: `${AUTH_BASE_URL}/`,
      }),
    });
  }

  isPhoneNumberInUseError(error) {
    if (error?.code === 'phone_number_in_use') return true;
    const message = error instanceof Error ? error.message : String(error || '');
    return /phone_number_in_use/i.test(message);
  }

  /** Cancel a frozen activation snapshot and persist a terminal local status. */
  async cancelSmsBowerActivationImmediate(reason = 'cancelled') {
    const activation = this.smsActivation ? Object.freeze({ ...this.smsActivation }) : null;
    this.smsActivation = null;
    if (!activation) return;
    const result = await cancelSmsActivationSnapshot({
      activation,
      reason,
      cancelRemote: this.smsProvider
        ? snapshot => this.smsProvider.setStatus(snapshot.activationId, 8)
        : undefined,
      persist: (status, snapshot) => this.persistSmsActivation(status, '', snapshot),
    });
    if (result.error) {
      this.log(`${this.smsProviderLabel} 取消订单失败 (${reason}): ${result.error.message}；已更新状态 ${result.status}`, 'warn');
      return;
    }
    this.log(`已取消 ${this.smsProviderLabel} 订单 ${activation.activationId}（${result.status}）`);
  }
  async sendExistingPhoneOtp() {
    const response = await this.fetch(AUTH_PHONE_OTP_SEND_URL, {
      method: 'POST',
      headers: this.browserHeaders({
        accept: 'application/json',
        'content-type': 'application/json',
        origin: AUTH_BASE_URL,
        referer: `${AUTH_BASE_URL}/phone-otp/select-channel`,
      }),
      body: JSON.stringify({ channel: 'sms' }),
    });
    if (!response.ok) throw new Error(`PhoneOtpSend请求失败: ${await this.formatErrorResponse(response)}`);
    const payload = await response.json();
    return normalizeAuthContinueUrl(payload.continue_url || `${AUTH_BASE_URL}/phone-verification`);
  }

  async validatePhoneOtp(code) {
    const response = await this.fetch(AUTH_PHONE_OTP_VALIDATE_URL, {
      method: 'POST',
      headers: this.browserHeaders({
        accept: 'application/json',
        'content-type': 'application/json',
        origin: AUTH_BASE_URL,
        referer: `${AUTH_BASE_URL}/phone-verification`,
      }),
      body: JSON.stringify({ code }),
    });
    if (!response.ok) throw new Error(`PhoneOtpValidate请求失败: ${await this.formatErrorResponse(response)}`);
    const payload = await response.json();
    return normalizeAuthContinueUrl(payload.continue_url);
  }

  async persistSmsActivation(status, code = '', activationSnapshot = this.smsActivation) {
    const activation = activationSnapshot;
    if (!activation) return;
    this.account.auth_phone_number = activation.phoneNumber;
    this.account.sms_provider = getSmsProviderKey();
    this.account.sms_activation_id = activation.activationId;
    this.account.sms_activation_status = status;
    if (!this.account.id) return;
    await accountRepository.updateById(this.account.id, {
      auth_phone_number: activation.phoneNumber,
      sms_provider: this.account.sms_provider,
      sms_activation_id: activation.activationId,
      sms_activation_status: status,
      ...(code ? { last_sms_code: code, last_sms_at: nowIso() } : {}),
    });
  }

  async setSmsBowerStatus(status, label) {
    if (!this.smsProvider || !this.smsActivation) return;
    const activation = Object.freeze({ ...this.smsActivation });
    try {
      await this.smsProvider.setStatus(activation.activationId, status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`${this.smsProviderLabel} 更新订单状态失败 (${label}): ${message}`, 'warn');
    }
    await this.persistSmsActivation(label, '', activation);
  }
  async acquireSmsBowerNumber() {
    if (!this.smsProvider) throw new Error('未配置短信服务 API Key，无法自动获取手机号');
    const activation = await withSmsAcquireSemaphore.run(async () => {
      const settings = getSmsBowerSettings();
      if (String(settings?.provider || 'smsbower').trim().toLowerCase() === 'manual_sms') {
        this.log(`${this.smsProviderLabel} 开始创建号码租约`);
        return this.smsProvider.acquireNumber({
          timeoutMs: this.smsCodeTimeoutMs,
          pollIntervalMs: PHONE_OTP_POLL_INTERVAL_MS,
        });
      }
      const service = settings.service || SMSBOWER_OPENAI_SERVICE;
      await this.ensureSmsAcquirePlanner(settings);
      let lastError;
      while (!this.smsAcquirePlanner.isExhausted()) {
        const target = this.smsAcquirePlanner.snapshot();
        const country = target.country;
        if (!country) break;
        const label = SMSBOWER_COUNTRY_LABELS[country] || country;
        try {
          this.log(
            `SMSBower getNumber：服务 ${service}（OpenAI/ChatGPT），国家 ${label}，`
            + `maxPrice=${target.workingMaxPrice}（上限 ${target.ceilingMaxPrice}），`
            + `同国失败 ${target.failsOnCurrent}/${target.failsBeforeSwitch}`,
          );
          return await this.smsProvider.acquireNumber({
            service,
            country,
            maxPrice: target.workingMaxPrice,
            minPrice: settings.minPrice,
            providerIds: settings.providerIds,
            exceptProviderIds: settings.exceptProviderIds,
            phoneException: settings.phoneException,
          });
        } catch (error) {
          lastError = error;
          const message = error instanceof Error ? error.message : String(error);
          this.log(`SMSBower 国家 ${label} 取号失败: ${message}`, 'warn');
          if (error instanceof SmsBowerError && ['BAD_KEY', 'NO_BALANCE', 'BAD_SERVICE'].includes(error.code)) throw error;
          const decision = this.noteSmsAcquireFailure(error instanceof SmsBowerError ? error.code : message);
          if (decision?.exhausted) break;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(`${this.smsProviderLabel} 在配置的国家/价格策略下均未获取到可用号码`);
    });

    this.smsActivation = activation;
    await this.persistSmsActivation('number_acquired');
    if (this.account?.id) await persistOpenAiStage(this.account.id, OPENAI_STAGES.PHONE_PENDING);
    const label = SMSBOWER_COUNTRY_LABELS[activation.country] || activation.country || '未知';
    this.log(`${this.smsProviderLabel} 已分配手机号: ${maskPhone(activation.phoneNumber)}${label !== '未知' ? `，国家 ${label}` : ''}，订单 ${activation.activationId}`);
    return activation;
  }
  async waitForSmsBowerCode({ timeoutMs = PHONE_OTP_WAIT_TIMEOUT_MS } = {}) {
    if (!this.smsProvider || !this.smsActivation) throw new Error('当前授权流程没有可用的接码租约');
    let lastNoticeAt = 0;
    const code = await this.smsProvider.waitForCode(this.smsActivation.activationId, {
      timeoutMs,
      pollIntervalMs: PHONE_OTP_POLL_INTERVAL_MS,
      onPoll: result => {
        if (result.status === 'received') return;
        if (Date.now() - lastNoticeAt < 15000) return;
        const elapsedSec = Math.round((Date.now() - (this.smsWaitStartedAtMs || Date.now())) / 1000);
        this.log(`${this.smsProviderLabel} 订单 ${this.smsActivation.activationId} 等待验证码中（已等 ${elapsedSec}s / ${Math.round(timeoutMs / 1000)}s）`);
        lastNoticeAt = Date.now();
      },
    });
    await this.persistSmsActivation('code_received', code);
    this.log(`读取到手机号验证码: ${code} (${maskPhone(this.smsActivation.phoneNumber)})`);
    return code;
  }

  async handleAddPhone({ initialDeliveryAttempts = 0 } = {}) {
    if (this.smsProvider) {
      const settings = getSmsBowerSettings();
      const maxDeliveryAttempts = settings.numberAttempts || 3;
      const maxRejectedSwaps = Math.max(maxDeliveryAttempts * 4, 20);
      const maxRiskRejections = 2;
      let retryState = { deliveryAttempts: initialDeliveryAttempts, rejectedSwaps: 0, riskRejections: 0 };
      let lastError;
      while (retryState.deliveryAttempts < maxDeliveryAttempts
        && retryState.rejectedSwaps < maxRejectedSwaps
        && retryState.riskRejections < maxRiskRejections) {
        let submitted = false;
        let timeoutMs = 0;
        try {
          if (retryState.deliveryAttempts || retryState.rejectedSwaps || retryState.riskRejections) {
            this.log('换号前重新打开 add-phone 页');
            await this.openAddPhonePage();
          }
          const activation = await this.acquireSmsBowerNumber();
          const progress = `投递 ${retryState.deliveryAttempts}/${maxDeliveryAttempts} · 拒号换号 ${retryState.rejectedSwaps}/${maxRejectedSwaps} · 风控拒绝 ${retryState.riskRejections}/${maxRiskRejections}`;
          this.log(`提交 ${this.smsProviderLabel} 手机号 (${progress}): ${maskPhone(activation.phoneNumber)}`);
          await this.sendPhoneOtp(activation.phoneNumber);
          submitted = true;
          await this.setSmsBowerStatus(1, 'sms_sent');
          timeoutMs = this.smsCodeTimeoutMs;
          this.smsWaitStartedAtMs = Date.now();
          this.log(`等待短信验证码，单号最长 ${Math.round(timeoutMs / 1000)}s，超时自动换号`);
          const code = await this.waitForSmsBowerCode({ timeoutMs });
          this.log('提交手机号短信验证码');
          const continueURL = await this.validatePhoneOtp(code);
          await this.setSmsBowerStatus(6, 'completed');
          return continueURL;
        } catch (error) {
          lastError = error;
          const message = error instanceof Error ? error.message : String(error);
          const timedOut = error instanceof SmsBowerError && error.code === 'SMS_TIMEOUT';
          const phone = this.smsActivation?.phoneNumber || '';
          const policyError = error instanceof OpenAIPhoneSubmissionError
            ? error
            : { category: submitted || timedOut ? PHONE_ERROR_CATEGORIES.HARD_FAILURE : PHONE_ERROR_CATEGORIES.TRANSIENT_FAILURE };
          const decision = nextPhoneRetryDecision(policyError, retryState, {
            maxDeliveryAttempts,
            maxRejectedSwaps,
            maxRiskRejections,
          });
          retryState = decision.state;
          const progress = `投递 ${retryState.deliveryAttempts}/${maxDeliveryAttempts} · 拒号换号 ${retryState.rejectedSwaps}/${maxRejectedSwaps} · 风控拒绝 ${retryState.riskRejections}/${maxRiskRejections}`;
          const reason = timedOut ? 'timeout' : decision.category;
          this.log(
            timedOut
              ? `手机号 ${maskPhone(phone)} 等码超时（${Math.round(timeoutMs / 1000)}s），取消并换号；${progress}`
              : `手机号 ${maskPhone(phone)} 失败 [${decision.category}]：${message}；${progress}`,
            'warn',
          );
          await this.cancelSmsBowerActivationImmediate(reason);
          // 国家库存失败只在 acquire 阶段计数；号码拒绝和等码超时只更换号码。
          if (decision.category === PHONE_ERROR_CATEGORIES.TRANSIENT_FAILURE && decision.action === 'swap') await sleep(1000);
          if (decision.action === 'stop') throw lastError;
          if (error instanceof SmsBowerError && ['BAD_KEY', 'NO_BALANCE', 'BAD_SERVICE'].includes(error.code)) throw error;
          if (this.smsAcquirePlanner?.isExhausted()) throw lastError;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(`${this.smsProviderLabel} 获取手机号/验证码失败`);
    }
    const phoneNumber = String(this.account.auth_phone_number || '').trim();
    if (!phoneNumber) throw new Error('触发 add-phone，但该账号没有保存授权手机号');
    this.log(`提交已保存手机号: ${maskPhone(phoneNumber)}`);
    await this.sendPhoneOtp(phoneNumber);
    return this.handlePhoneVerification();
  }
  async handlePhoneVerification() {
    if (!this.smsActivation && this.smsProvider) {
      const activationId = String(this.account?.sms_activation_id || '').trim();
      const phoneNumber = String(this.account?.auth_phone_number || '').trim();
      const activationStatus = String(this.account?.sms_activation_status || '').trim();
      if (activationId && phoneNumber && isReusableSmsActivationStatus(activationStatus)) {
        this.smsActivation = { activationId, phoneNumber };
        this.log(`复用已保存 ${this.smsProviderLabel} 订单接码: ${maskPhone(phoneNumber)} / ${activationId}`);
        try {
          // 3 = 请求重发验证码（若订单仍有效）
          await this.smsProvider.setStatus(activationId, 3);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log(`${this.smsProviderLabel} 请求重发失败，继续轮询旧订单: ${message}`, 'warn');
        }
      }
    }
    if (this.smsActivation) {
      this.log(`遇到手机验证，使用 ${this.smsProviderLabel} 自动接码`);
      try {
        const timeoutMs = this.smsCodeTimeoutMs;
        this.smsWaitStartedAtMs = Date.now();
        this.log(`等待短信验证码，单号最长 ${Math.round(timeoutMs / 1000)}s`);
        const code = await this.waitForSmsBowerCode({ timeoutMs });
        this.log('提交手机号短信验证码');
        const continueURL = await this.validatePhoneOtp(code);
        await this.setSmsBowerStatus(6, 'completed');
        return continueURL;
      } catch (error) {
        const timedOut = error instanceof SmsBowerError && error.code === 'SMS_TIMEOUT';
        await this.cancelSmsBowerActivationImmediate(timedOut ? 'timeout' : 'verification_failed');
        if (timedOut && this.smsProvider) {
          const maxDeliveryAttempts = getSmsBowerSettings().numberAttempts || 3;
          if (maxDeliveryAttempts <= 1) throw error;
          this.log('当前号码等码超时，回到换号流程重新取号', 'warn');
          return this.handleAddPhone({ initialDeliveryAttempts: 1 });
        }
        throw error;
      }
    }
    this.log('遇到手机验证，使用已保存短信链接自动接码');
    const code = await waitForPhoneCode(this.account, (msg, level = 'info') => this.log(msg, level));
    this.log('提交手机号短信验证码');
    return this.validatePhoneOtp(code);
  }

  async handlePhoneOtpSelectChannel() {
    this.log('遇到手机验证码通道选择，自动选择短信接收');
    await this.sendExistingPhoneOtp();
    return this.handlePhoneVerification();
  }
  extractAuthResult(callbackURL) {
    return parseOpenAICallback(callbackURL, this.state);
  }

  async followOAuthRedirects(startURL) {
    let currentURL = startURL;
    for (let hop = 0; hop < 10; hop += 1) {
      this.assertSupportedAuthStep({ continueUrl: currentURL });
      if (this.isPhoneChallengeUrl(currentURL)) {
        if (this.forbidPhoneChallenge) throw new Error(`Codex OAuth 仍要求手机验证，已按要求禁止新接码: ${this.pathOf(currentURL) || currentURL}`);
        const phoneResult = await this.handlePhoneChallenge(currentURL);
        if (isAgentIdentityRecord(phoneResult)) return phoneResult;
        currentURL = phoneResult;
        continue;
      }
      if (currentURL.startsWith(OPENAI_CODEX_REDIRECT_URI)) return this.extractAuthResult(currentURL);
      const response = await this.fetch(currentURL, {
        method: 'GET',
        redirect: 'manual',
        headers: this.browserHeaders({
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        }),
      });
      const location = response.headers.get('location');
      if (location) {
        const nextURL = new URL(location, currentURL).toString();
        if (this.isPhoneChallengeUrl(nextURL)) {
          if (this.forbidPhoneChallenge) throw new Error(`Codex OAuth 仍要求手机验证，已按要求禁止新接码: ${this.pathOf(nextURL) || nextURL}`);
          const phoneResult = await this.handlePhoneChallenge(nextURL);
          if (isAgentIdentityRecord(phoneResult)) return phoneResult;
          currentURL = phoneResult;
          continue;
        }
        if (nextURL.startsWith(OPENAI_CODEX_REDIRECT_URI)) return this.extractAuthResult(nextURL);
        currentURL = nextURL;
        continue;
      }
      if (this.isPhoneChallengeUrl(response.url)) {
        if (this.forbidPhoneChallenge) throw new Error(`Codex OAuth 仍要求手机验证，已按要求禁止新接码: ${this.pathOf(response.url) || response.url}`);
        const phoneResult = await this.handlePhoneChallenge(response.url);
        if (isAgentIdentityRecord(phoneResult)) return phoneResult;
        currentURL = phoneResult;
        continue;
      }
      if (response.url.startsWith(OPENAI_CODEX_REDIRECT_URI)) return this.extractAuthResult(response.url);
      throw new Error(`OAuth跳转未到达callback: status=${response.status} url=${response.url}`);
    }
    throw new Error(`OAuth跳转次数过多，最后停在: ${currentURL}`);
  }

  async exchangeCodeForToken(code) {
    let lastError = '';
    for (const tokenURL of AUTH_OAUTH_TOKEN_URLS) {
      const body = buildAuthorizationCodeTokenBody(code, this.codeVerifier, OPENAI_CODEX_REDIRECT_URI);
      const response = await this.fetch(tokenURL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': OPENAI_CODEX_USER_AGENT,
        },
        body,
      });
      if (!response.ok) {
        lastError = `endpoint=${tokenURL} ${await this.formatErrorResponse(response)}`;
        continue;
      }
      const payload = await response.json();
      return normalizeOpenAIAuthRecord(this.account.email, payload);
    }
    throw new Error(`Code换Token失败: ${lastError}`);
  }

  async ensureChatGptDeviceCookie(deviceId = '') {
    const id = String(deviceId || this.deviceID || randomUUID()).trim();
    this.deviceID = id;
    const existing = await this.readCookie(CHATGPT_BASE_URL, 'oai-did');
    if (existing) {
      this.deviceID = existing;
      return existing;
    }
    const cookie = new Cookie({
      key: 'oai-did',
      value: id,
      domain: 'chatgpt.com',
      path: '/',
      secure: true,
      httpOnly: false,
    });
    await this.jar.setCookie(cookie, CHATGPT_BASE_URL);
    return id;
  }

  async readChatGptCsrfToken() {
    const response = await this.fetch(CHATGPT_AUTH_CSRF_URL, {
      headers: this.browserHeaders({
        accept: 'application/json',
        referer: `${CHATGPT_BASE_URL}/auth/login`,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    const fromJson = String(payload?.csrfToken || '').trim();
    if (fromJson) return fromJson;
    const raw = await this.readCookie(CHATGPT_BASE_URL, '__Host-next-auth.csrf-token');
    if (raw.includes('|')) return raw.split('|')[0];
    return raw || 'true';
  }

  async startChatGptWebSignIn() {
    await this.ensureProxyConnectivity();
    this.resetAuthSession();
    if (this.reuseStoredSession) await this.importStoredCookieStorageState();
    this.log('ChatGPT Web：打开登录页并获取 CSRF');
    await this.humanPause('navigate');
    const loginPage = await this.fetch(`${CHATGPT_BASE_URL}/auth/login`, {
      headers: this.browserHeaders({
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
      }),
    });
    if (loginPage.status >= 400) {
      const loginBody = await loginPage.text().catch(() => '');
      if (isInitialAuthEgressBlock({ status: loginPage.status, body: loginBody, headers: loginPage.headers })) {
        this.throwProxyEdgeBlocked(loginPage.status, 'chatgpt.com/auth/login');
      }
    }
    await this.humanPause('think');
    const deviceId = await this.ensureChatGptDeviceCookie();
    const csrfToken = await this.readChatGptCsrfToken();
    const params = new URLSearchParams({
      ...(this.reuseStoredSession ? {} : { prompt: 'login' }),
      'ext-oai-did': deviceId,
      auth_session_logging_id: randomUUID().replace(/-/g, ''),
      'ext-passkey-client-capabilities': '0111',
      screen_hint: 'login_or_signup',
      login_hint: this.account.email,
    });
    await this.humanPause('type');
    const response = await this.fetch(`${CHATGPT_AUTH_SIGNIN_OPENAI_URL}?${params}`, {
      method: 'POST',
      redirect: 'manual',
      headers: this.browserHeaders({
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        origin: CHATGPT_BASE_URL,
        referer: `${CHATGPT_BASE_URL}/auth/login`,
      }),
      body: new URLSearchParams({
        callbackUrl: `${CHATGPT_BASE_URL}/`,
        csrfToken,
        json: 'true',
      }).toString(),
    });
    const rawSignInBody = await response.text().catch(() => '');
    let payload = {};
    try { payload = rawSignInBody ? JSON.parse(rawSignInBody) : {}; } catch { payload = {}; }
    const signInUrl = firstNonEmpty(payload?.url, response.headers.get('location'));
    if (!signInUrl) {
      if (isInitialAuthEgressBlock({ status: response.status, body: rawSignInBody, headers: response.headers })) {
        this.throwProxyEdgeBlocked(response.status, 'chatgpt.com/api/auth/signin/openai');
      }
      const detail = (rawSignInBody || JSON.stringify(payload || {})).slice(0, 240);
      throw new Error(`ChatGPT Web 登录发起失败: HTTP ${response.status} ${detail}`);
    }

    this.log('ChatGPT Web：进入 OpenAI OAuth');
    await this.humanPause('navigate');
    const oauthResp = await this.fetch(signInUrl, {
      redirect: 'follow',
      headers: this.browserHeaders({
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        origin: AUTH_BASE_URL,
        referer: `${CHATGPT_BASE_URL}/`,
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-user': '?1',
      }),
    });
    this.deviceID = await this.readCookie('https://openai.com', 'oai-did')
      || await this.readCookie(AUTH_BASE_URL, 'oai-did')
      || await this.readCookie(CHATGPT_BASE_URL, 'oai-did')
      || this.deviceID;
    if (!this.deviceID) throw new Error('ChatGPT Web OAuth 未返回 oai-did cookie');
    return { continueUrl: oauthResp.url };
  }

  extractOAuthCodeFromUrl(url) {
    try {
      const parsed = new URL(String(url || ''));
      return parsed.searchParams.get('code') || '';
    } catch {
      return '';
    }
  }

  async completeChatGptCallback(code) {
    const callbackUrl = `${CHATGPT_AUTH_CALLBACK_OPENAI_URL}?code=${encodeURIComponent(code)}`;
    this.log('ChatGPT Web：提交 OAuth callback');
    await this.fetch(callbackUrl, {
      headers: this.browserHeaders({
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        referer: `${CHATGPT_BASE_URL}/`,
      }),
    });
  }

  async readChatGptAccessToken({ timeoutMs = 20000 } = {}) {
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 20000);
    let lastError = 'Session JSON 中无 accessToken';
    while (Date.now() < deadline) {
      try {
        await this.fetch(`${CHATGPT_BASE_URL}/`, {
          headers: this.browserHeaders({ accept: 'text/html,*/*', referer: `${CHATGPT_BASE_URL}/` }),
        }).catch(() => null);
        const response = await this.fetch(CHATGPT_AUTH_SESSION_URL, {
          headers: this.browserHeaders({
            accept: 'application/json',
            referer: `${CHATGPT_BASE_URL}/`,
          }),
        });
        const text = await response.text();
        let session = {};
        try { session = text ? JSON.parse(text) : {}; } catch {}
        const accessToken = firstNonEmpty(session.accessToken, session.access_token, session.token);
        if (response.ok && accessToken) {
          return { accessToken, session };
        }
        lastError = `HTTP ${response.status}${text ? ` ${text.slice(0, 180)}` : ''}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await sleep(1000);
    }
    throw new Error(`无法获取 ChatGPT Web accessToken: ${lastError}`);
  }

  async followChatGptWebSession(startUrl, { allowPhoneStop = false } = {}) {
    let currentURL = normalizeAuthContinueUrl(startUrl) || String(startUrl || '');
    for (let hop = 0; hop < 12; hop += 1) {
      if (!currentURL) break;
      this.assertSupportedAuthStep({ continueUrl: currentURL });
      if (this.isPhoneChallengeUrl(currentURL)) {
        if (allowPhoneStop) {
          this.log('跟随 Session 时停在手机验证页，尝试直接读取 accessToken', 'warn');
          return this.readChatGptAccessToken({ timeoutMs: 12000 });
        }
        throw new Error(`退出全部会话遇到手机验证: ${this.pathOf(currentURL)}`);
      }

      const codeInUrl = this.extractOAuthCodeFromUrl(currentURL);
      if (codeInUrl) {
        if (String(currentURL).includes('/api/auth/callback/openai')) {
          await this.fetch(currentURL, {
            headers: this.browserHeaders({
              accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              referer: `${CHATGPT_BASE_URL}/`,
            }),
          });
        } else {
          await this.completeChatGptCallback(codeInUrl);
        }
        return this.readChatGptAccessToken();
      }

      if (this.isChatGptUrl(currentURL) && !String(currentURL).includes('/api/auth/callback')) {
        try {
          return await this.readChatGptAccessToken({ timeoutMs: 5000 });
        } catch {
          // keep following redirects / retries below
        }
      }

      const response = await this.fetch(currentURL, {
        method: 'GET',
        redirect: 'manual',
        headers: this.browserHeaders({
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        }),
      });
      const location = response.headers.get('location');
      if (location) {
        currentURL = new URL(location, currentURL).toString();
        continue;
      }
      if (this.isChatGptUrl(response.url)) {
        return this.readChatGptAccessToken();
      }
      if (this.isConsentUrl(response.url) || this.isAuthStartUrl(response.url)) {
        currentURL = response.url;
        const advanced = await this.advanceAuthStep(currentURL, { phase: 'chatgpt' });
        currentURL = typeof advanced === 'string' ? advanced : String(advanced?.continueUrl || '');
        continue;
      }
      const authFailure = parseOpenAiAuthErrorUrl(response.url);
      if (authFailure) {
        const error = new Error(`OpenAI 登录失败：${authFailure.code}${authFailure.requestId ? `（request_id=${authFailure.requestId}）` : ''}`);
        error.code = authFailure.code;
        throw error;
      }
      throw new Error(`ChatGPT Web 跳转未完成: status=${response.status} url=${response.url}`);
    }
    return this.readChatGptAccessToken();
  }

  async logoutAllChatGptSessions(accessToken) {
    if (!accessToken) throw new Error('logout_all 缺少 accessToken');
    await this.ensureChatGptDeviceCookie();
    this.log('调用 ChatGPT logout_all，退出全部会话');
    const response = await this.fetch(CHATGPT_LOGOUT_ALL_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: this.browserHeaders({
        accept: '*/*',
        authorization: `Bearer ${accessToken}`,
        origin: CHATGPT_BASE_URL,
        referer: `${CHATGPT_BASE_URL}/`,
        'oai-device-id': this.deviceID || '',
        'oai-language': this.fingerprint?.locale || 'en-US',
        'oai-session-id': randomUUID(),
        'x-openai-target-path': '/backend-api/accounts/logout_all',
        'x-openai-target-route': '/backend-api/accounts/logout_all',
      }),
      body: '',
    });
    const result = await readLogoutAllResponse(response);
    this.log(`logout_all 成功：HTTP ${result.status}，响应类型 ${result.responseType}`);
    return result;
  }

  chatgptBackendHeaders(accessToken, targetPath, extra = {}) {
    return this.browserHeaders({
      accept: '*/*',
      authorization: `Bearer ${accessToken}`,
      origin: CHATGPT_BASE_URL,
      referer: `${CHATGPT_BASE_URL}/`,
      'oai-device-id': this.deviceID || '',
      'oai-language': this.fingerprint?.locale || 'zh-CN',
      'oai-session-id': randomUUID(),
      'x-openai-target-path': targetPath,
      'x-openai-target-route': targetPath,
      ...extra,
    });
  }

  async fetchChatGptJson(url, {
    method = 'GET',
    accessToken,
    targetPath,
    body,
    label = 'ChatGPT API',
    extraHeaders = {},
    allowCookieAuth = false,
  } = {}) {
    if (!accessToken && !allowCookieAuth) throw new Error(`${label} 缺少 accessToken`);
    await this.ensureChatGptDeviceCookie();
    const path = targetPath || new URL(url).pathname;
    const headers = accessToken ? this.chatgptBackendHeaders(accessToken, path, extraHeaders)
      : this.browserHeaders({ accept: 'application/json', referer: `${CHATGPT_BASE_URL}/`, ...extraHeaders });
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.fetch(url, {
      method,
      redirect: 'manual',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 300) }; }
    if (!response.ok || payload?.error || payload?.success === false) {
      if (looksLikeCloudflareBlock({ status: response.status, body: text, headers: response.headers })) {
        this.throwProxyEdgeBlocked(response.status, `${label} · ${path}`);
      }
      throw sessionApiError(label, response.status, payload);
    }
    if (!payload || typeof payload !== 'object' || Object.hasOwn(payload, 'raw')) throw new Error(`${label} 未返回有效 JSON`);
    return payload;
  }

  async getMfaInfo(accessToken) {
    return this.fetchChatGptJson(CHATGPT_MFA_INFO_URL, {
      accessToken,
      targetPath: '/backend-api/accounts/mfa_info',
      label: 'mfa_info',
    });
  }

  async enrollTotpMfa(accessToken) {
    return this.fetchChatGptJson(CHATGPT_MFA_ENROLL_URL, {
      method: 'POST',
      accessToken,
      targetPath: '/backend-api/accounts/mfa/enroll',
      body: { factor_type: 'totp' },
      label: 'mfa/enroll',
    });
  }

  async disableTotpMfa(accessToken, factorId) {
    const id = String(factorId || '').trim();
    if (!id) throw new Error('disable_in_house 缺少 factor_id');
    return this.fetchChatGptJson(CHATGPT_MFA_DISABLE_URL, {
      method: 'POST',
      accessToken,
      targetPath: '/backend-api/accounts/mfa/user/disable_in_house',
      body: { factor_id: id },
      label: 'disable_in_house',
    });
  }

  async activateTotpEnrollment(accessToken, { code, sessionId } = {}) {
    return this.fetchChatGptJson(CHATGPT_MFA_ACTIVATE_ENROLLMENT_URL, {
      method: 'POST',
      accessToken,
      targetPath: '/backend-api/accounts/mfa/user/activate_enrollment',
      body: {
        code: String(code || '').trim(),
        factor_type: 'totp',
        session_id: String(sessionId || '').trim(),
      },
      label: 'activate_enrollment',
    });
  }

  /**
   * Use a logged-in ChatGPT Web accessToken to enroll TOTP and return the secret.
   * Skips when remote MFA already has a totp factor (secret cannot be recovered).
   */
  async enrollAndActivateTotpForSession(accessToken, { skipIfEnabled = true } = {}) {
    const token = String(accessToken || '').trim();
    if (!token) throw new Error('设置 2FA 缺少 accessToken');
    await this.ensureChatGptDeviceCookie();

    this.log('查询 MFA 状态 (mfa_info)');
    const before = await this.getMfaInfo(token);
    const existingTotp = Array.isArray(before?.factors?.totp) ? before.factors.totp : [];
    if (skipIfEnabled && (before?.mfa_enabled || before?.mfa_enabled_v2 || existingTotp.length)) {
      this.log('远端已开启 TOTP MFA，跳过 enroll（无法回填密钥）', 'warn');
      return {
        skipped: true,
        reason: 'already_enabled',
        secret: '',
        factorId: String(existingTotp[0]?.id || before?.native_default_factor_id || ''),
        mfaInfo: before,
      };
    }

    this.log('开始 enroll TOTP MFA');
    const enrolled = await this.enrollTotpMfa(token);
    const secret = validateTotpSecret(enrolled?.secret || '');
    const sessionId = String(enrolled?.session_id || '').trim();
    const factorId = String(enrolled?.factor?.id || '').trim();
    if (!sessionId) throw new Error('mfa/enroll 未返回 session_id');

    const code = generateTotpCode(secret);
    this.log(`提交 TOTP 激活码 (factor=${factorId ? `${factorId.slice(0, 8)}…` : 'n/a'})`);
    const activated = await this.activateTotpEnrollment(token, { code, sessionId });
    if (activated && activated.success === false) {
      throw new Error(`activate_enrollment 返回失败: ${JSON.stringify(activated).slice(0, 200)}`);
    }

    this.log('再次确认 MFA 状态');
    const after = await this.getMfaInfo(token);
    if (!(after?.mfa_enabled || after?.mfa_enabled_v2)) {
      throw new Error('activate_enrollment 后 mfa_info 仍显示未启用');
    }
    this.log('TOTP MFA 设置成功');
    return {
      skipped: false,
      reason: '',
      secret,
      factorId: factorId || String(after?.native_default_factor_id || ''),
      mfaInfo: after,
      enroll: enrolled,
    };
  }

  /** Disable the current TOTP factor, create a replacement, and verify it. */
  async resetTotpForSession(accessToken) {
    let authMutationStarted = false;
    try {
      const token = String(accessToken || '').trim();
      if (!token) throw new Error('重设 2FA 缺少 accessToken');
      await this.ensureChatGptDeviceCookie();
      const before = await this.getMfaInfo(token);
      const factors = Array.isArray(before?.factors?.totp) ? before.factors.totp : [];
      const factorId = String(factors[0]?.id || before?.native_default_factor_id || '').trim();
      if (factorId) {
        this.log(`禁用旧 TOTP 因子 (factor=${factorId.slice(0, 8)}…)`);
        await this.disableTotpMfa(token, factorId);
        authMutationStarted = true;
      }

      this.log('生成新的 TOTP 密钥');
      authMutationStarted = true;
      const enrolled = await this.enrollTotpMfa(token);
      const secret = validateTotpSecret(enrolled?.secret || '');
      const sessionId = String(enrolled?.session_id || '').trim();
      const newFactorId = String(enrolled?.factor?.id || '').trim();
      if (!sessionId) throw new Error('mfa/enroll 未返回 session_id');
      const code = generateTotpCode(secret);
      await this.activateTotpEnrollment(token, { code, sessionId });
      const after = await this.getMfaInfo(token);
      if (!(after?.mfa_enabled || after?.mfa_enabled_v2)) {
        throw new Error('新 2FA 激活后 mfa_info 仍显示未启用');
      }
      this.log('TOTP 2FA 换绑成功');
      return { secret, factorId: newFactorId || String(after?.native_default_factor_id || ''), mfaInfo: after, enroll: enrolled };
    } catch (error) {
      error.authMutationStarted = authMutationStarted;
      throw error;
    }
  }

  async importStoredCookieStorageState() {
    let state;
    try { state = JSON.parse(String(this.account?.storage_state_json || '')); } catch { state = null; }
    const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
    let imported = 0;
    for (const item of cookies) {
      const domain = String(item?.domain || '').trim();
      const name = String(item?.name || '').trim();
      if (!domain || !name) continue;
      if (Number(item.expires) > 0 && Number(item.expires) * 1000 <= Date.now()) continue;
      const cookie = new Cookie({
        key: name,
        value: String(item?.value || ''),
        domain,
        hostOnly: typeof item.hostOnly === 'boolean' ? item.hostOnly : name.startsWith('__Host-'),
        path: String(item?.path || '/'),
        secure: item?.secure !== false,
        httpOnly: Boolean(item?.httpOnly),
        sameSite: String(item?.sameSite || 'lax').toLowerCase(),
        expires: Number(item?.expires) > 0 ? new Date(Number(item.expires) * 1000) : 'Infinity',
      });
      const origin = `${cookie.secure ? 'https' : 'http'}://${domain.replace(/^\./, '')}${cookie.path || '/'}`;
      const stored = await this.jar.setCookie(cookie, origin).catch(() => null);
      if (stored) imported += 1;
    }
    this.log(`复用已保存的 ChatGPT Web Session Cookie: ${imported} 个`);
    if (this.requireStoredSession && imported === 0) {
      const error = new Error('Business 转 RT 要求可复用的已保存 ChatGPT Web Session Cookie');
      error.code = 'STORED_SESSION_REQUIRED';
      throw error;
    }
    return imported;
  }

  assertStoredSessionContinuation(started) {
    if (!this.requireStoredSession || started?.done) return;
    this.assertSupportedAuthStep(started);
    const pathName = this.pathOf(started?.continueUrl || '');
    const credentialFallback = this.isPasswordTotpAccount()
      && (pathName === '/log-in' || pathName === '/log-in/password' || pathName.includes('/mfa'));
    const allowed = pathName === '/oauth/authorize'
      || pathName === '/oauth/consent'
      || pathName === '/sign-in-with-chatgpt/codex/consent'
      || pathName === '/consent'
      || pathName === '/workspace'
      || pathName.includes('workspace')
      || pathName.includes('consent')
      || credentialFallback;
    if (!allowed) {
      const error = new Error(`已保存 Session 无法直接继续 Business OAuth: ${pathName || 'unknown'}`);
      error.code = 'STORED_SESSION_REQUIRED';
      throw error;
    }
    if (credentialFallback) {
      this.log('已保存 Session 需要重新验证账号，继续提交密码和 TOTP 后完成 Business OAuth', 'warn');
    }
  }

  async exportCookieStorageState() {
    const seen = new Set();
    const cookies = [];
    // Export the store directly so cookies scoped to a newly introduced
    // OpenAI subdomain are retained for later Session reuse.
    const list = await this.jar.store.getAllCookies();
    for (const cookie of list || []) {
      const key = `${cookie.domain}|${cookie.path}|${cookie.key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const expiresAt = cookie.expiryTime(cookie.creation);
      cookies.push({
        name: cookie.key,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        expires: Number.isFinite(expiresAt) ? expiresAt / 1000 : -1,
        hostOnly: Boolean(cookie.hostOnly),
        httpOnly: Boolean(cookie.httpOnly),
        secure: Boolean(cookie.secure),
        sameSite: cookie.sameSite || 'Lax',
      });
    }
    return JSON.stringify({ cookies, origins: [] }, null, 2);
  }

  async loginChatGptWebWithPasswordTotp() {
    if (!this.humanPacingExplicit) this.humanPacingEnabled = false;
    this.assertPasswordTotpCredentials();
    this.logProtocolHardening();
    this.log('协议登录 ChatGPT Web（邮箱 + 密码 + TOTP）');
    const started = await this.startChatGptWebSignIn();
    let continueURL = started.continueUrl;
    const advanced = await this.advanceAuthStep(continueURL, { phase: 'chatgpt' });
    continueURL = typeof advanced === 'string' ? advanced : String(advanced?.continueUrl || '');
    this.log(`登录完成，跟随到 ChatGPT Session: ${this.pathOf(continueURL) || continueURL}`);
    const { accessToken, session } = await this.followChatGptWebSession(continueURL);
    const storageState = await this.exportCookieStorageState();
    return { accessToken, session, storageState };
  }

  /**
   * After a Web Session is obtained: enroll TOTP if local secret missing, persist secret + password.
   * Failures are logged but do not unwind an already-saved session unless throwOnError.
   */
  async ensureTotpEnrolledIfNeeded(accessToken, { throwOnError = false } = {}) {
    if (hasTotpSecret(this.account)) {
      this.log('账号已有本地 TOTP 密钥，后续默认走邮箱/密码/2FA 登录');
      return {
        ok: true,
        skipped: true,
        reason: 'local_secret_present',
        secret: normalizeTotpSecret(this.account.two_factor_secret),
      };
    }
    const token = String(accessToken || '').trim();
    if (!token) {
      const error = new Error('自动设置 2FA 缺少 accessToken');
      if (throwOnError) throw error;
      this.log(error.message, 'warn');
      return { ok: false, skipped: false, error: error.message };
    }
    try {
      this.log('登录后自动设置并保存 TOTP 2FA');
      const result = await this.enrollAndActivateTotpForSession(token, { skipIfEnabled: true });
      if (result.skipped) {
        this.log(`远端已开启 MFA，无法自动写入密钥（${result.reason || 'already_enabled'}）`, 'warn');
        return {
          ok: false,
          skipped: true,
          reason: result.reason || 'already_enabled',
          error: '远端已开启 TOTP MFA，无法回填密钥',
          factorId: result.factorId || '',
        };
      }
      const secret = validateTotpSecret(result.secret);
      this.account.two_factor_secret = secret;
      if (!String(this.account.openai_password || '').trim() && String(this.account.password || '').trim()) {
        this.account.openai_password = String(this.account.password || '').trim();
      }
      if (this.account?.id) {
        await accountRepository.updateById(this.account.id, latest => ({
          two_factor_secret: secret,
          ...(!String(latest.openai_password || '').trim()
            ? { openai_password: String(this.account.openai_password || latest.password || '').trim() } : {}),
          status: '已设置2FA',
          last_error: '',
        }));
      }
      this.log('TOTP 密钥已更新，结果将返回当前浏览器');
      return {
        ok: true,
        skipped: false,
        reason: '',
        secret,
        factorId: result.factorId || '',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`自动设置 2FA 失败: ${message}`, 'warn');
      if (this.account?.id) {
        await accountRepository.updateById(this.account.id, {
          last_error: `自动设置2FA失败: ${message}`.slice(0, 500),
        }).catch(() => {});
      }
      if (throwOnError) throw error;
      return { ok: false, skipped: false, error: message };
    }
  }

  extractChatGptAccountIdFromAccessToken(accessToken) {
    const claims = decodeJwtPayload(accessToken);
    const auth = getNestedRecord(claims, 'https://api.openai.com/auth');
    return firstNonEmpty(
      auth.chatgpt_account_id,
      claims.chatgpt_account_id,
      this.account?.openai_account_id,
      this.account?.agent_account_id,
    );
  }

  extractPlanTypeFromAccessToken(accessToken) {
    const claims = decodeJwtPayload(accessToken);
    const auth = getNestedRecord(claims, 'https://api.openai.com/auth');
    return String(auth.chatgpt_plan_type || claims.chatgpt_plan_type || '').trim().toLowerCase();
  }

  /**
   * After session: check zero-dollar Plus trial (plus-1-month-free) for JP pricing funnel.
   * Sources: promotions/eligibility, accounts/check eligible_promo_campaigns, checkout_pricing_config/JP.
   */
  async checkZeroDollarPlusTrial(accessToken, { countryCode = 'JP' } = {}) {
    const token = String(accessToken || '').trim();
    if (!token) throw new Error('零元试用校验缺少 accessToken');
    await this.ensureChatGptDeviceCookie();
    const country = String(countryCode || 'JP').trim().toUpperCase() || 'JP';
    const accountId = this.extractChatGptAccountIdFromAccessToken(token);
    const tokenPlan = this.extractPlanTypeFromAccessToken(token);
    const referer = `${CHATGPT_BASE_URL}/?openaicom_referred=true&promo_campaign=${CHATGPT_PLUS_TRIAL_CAMPAIGN}`;

    this.log(`校验零元 Plus 试用资格（campaign=${CHATGPT_PLUS_TRIAL_CAMPAIGN}, country=${country}）`);

    const extraHeaders = {
      referer,
      ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
    };

    let accountsCheck = null;
    let eligibility = null;
    let pricingConfig = null;
    let planType = tokenPlan;
    let campaignFromCheck = '';

    try {
      accountsCheck = await this.fetchChatGptJson(CHATGPT_ACCOUNTS_CHECK_URL, {
          accessToken: token,
          targetPath: '/backend-api/accounts/check/v4-2023-04-27',
          label: 'accounts/check',
          extraHeaders,
        });
      const accounts = accountsCheck?.accounts && typeof accountsCheck.accounts === 'object'
        ? accountsCheck.accounts
        : {};
      const order = [];
      if (accountId && accounts[accountId]) order.push(accountId);
      if (Array.isArray(accountsCheck?.account_ordering)) {
        for (const id of accountsCheck.account_ordering) {
          const key = String(id || '');
          if (key && !order.includes(key)) order.push(key);
        }
      }
      for (const key of Object.keys(accounts)) {
        if (!order.includes(key)) order.push(key);
      }
      for (const id of order) {
        const row = accounts[id];
        if (!row || typeof row !== 'object') continue;
        const nested = row.account && typeof row.account === 'object' ? row.account : {};
        const ent = row.entitlement && typeof row.entitlement === 'object' ? row.entitlement : {};
        planType = String(
          nested.plan_type || nested.planType || ent.subscription_plan || planType || '',
        ).trim().toLowerCase();
        const campaigns = nested.eligible_promo_campaigns
          || row.eligible_promo_campaigns
          || {};
        const plusCamp = campaigns.plus || campaigns.chatgptplusplan || campaigns.ChatGPTPlus || null;
        if (plusCamp && typeof plusCamp === 'object') {
          campaignFromCheck = String(plusCamp.id || plusCamp.promo_campaign_id || '').trim();
        } else if (typeof plusCamp === 'string') {
          campaignFromCheck = plusCamp.trim();
        }
        if (planType || campaignFromCheck) break;
      }
    } catch (error) {
      this.log(`accounts/check 失败: ${error instanceof Error ? error.message : error}`, 'warn');
    }

    try {
      eligibility = await this.fetchChatGptJson(CHATGPT_PLUS_TRIAL_ELIGIBILITY_URL, {
          accessToken: token,
          targetPath: `/backend-api/promotions/eligibility/${CHATGPT_PLUS_TRIAL_CAMPAIGN}`,
          label: 'promotions/eligibility',
          extraHeaders,
        });
    } catch (error) {
      this.log(`promotions/eligibility 失败: ${error instanceof Error ? error.message : error}`, 'warn');
    }

    try {
      pricingConfig = await this.fetchChatGptJson(CHATGPT_CHECKOUT_PRICING_CONFIG_URL(country), {
          accessToken: token,
          targetPath: `/backend-api/checkout_pricing_config/configs/${country}`,
          label: 'checkout_pricing_config',
          extraHeaders,
        });
    } catch (error) {
      this.log(`checkout_pricing_config/${country} 失败: ${error instanceof Error ? error.message : error}`, 'warn');
    }

    const paidPlans = new Set(['plus', 'chatgptplusplan', 'pro', 'chatgptproplan', 'team', 'business', 'enterprise']);
    const normalizedPlan = planType.replace(/^chatgpt/, '').replace(/plan$/, '') || planType;
    let eligible = false;
    let reason = '';

    if (paidPlans.has(planType) || paidPlans.has(normalizedPlan)) {
      eligible = false;
      reason = `already_${normalizedPlan || planType || 'paid'}`;
    } else if (eligibility && eligibility.is_eligible === true) {
      eligible = true;
      reason = 'eligibility_api';
    } else if (campaignFromCheck && /plus-1-month-free|plus.*free|free.*plus/i.test(campaignFromCheck)) {
      eligible = true;
      reason = `accounts_check:${campaignFromCheck}`;
    } else if (eligibility && eligibility.is_eligible === false) {
      eligible = false;
      reason = String(
        eligibility?.ineligible_reason?.code
        || eligibility?.ineligible_reason?.message
        || 'user_not_eligible',
      );
    } else if (!eligibility && !accountsCheck) {
      throw new Error('零元试用校验失败：eligibility 与 accounts/check 均不可用');
    } else {
      eligible = false;
      reason = campaignFromCheck ? `no_match:${campaignFromCheck}` : 'not_eligible';
    }

    const plusAmount = Number(pricingConfig?.currency_config?.plus?.month?.amount);
    const currency = String(pricingConfig?.currency_config?.symbol_code || '').trim();
    const detail = [
      eligible ? 'eligible' : 'ineligible',
      reason,
      planType ? `plan=${planType}` : '',
      Number.isFinite(plusAmount) ? `plus_month=${plusAmount}${currency ? currency : ''}` : '',
      campaignFromCheck ? `check_campaign=${campaignFromCheck}` : '',
    ].filter(Boolean).join(' | ').slice(0, 500);

    this.log(`零元试用校验结果: ${eligible ? '有资格' : '无资格'} (${detail})`);
    return {
      ok: true,
      eligible,
      campaign: CHATGPT_PLUS_TRIAL_CAMPAIGN,
      country,
      planType,
      reason,
      detail,
      accountId,
      plusMonthAmount: Number.isFinite(plusAmount) ? plusAmount : null,
      currency,
      eligibility,
      pricingConfigSummary: pricingConfig ? {
        country_code: pricingConfig.country_code || country,
        symbol_code: currency,
        plus_month: plusAmount,
      } : null,
    };
  }

  async ensurePlusTrialCheckedIfNeeded(accessToken, { countryCode = 'JP', throwOnError = false } = {}) {
    const token = String(accessToken || '').trim();
    if (!token) {
      const error = new Error('零元试用校验缺少 accessToken');
      if (throwOnError) throw error;
      this.log(error.message, 'warn');
      return { ok: false, error: error.message };
    }
    try {
      const result = await this.checkZeroDollarPlusTrial(token, { countryCode });
      if (this.account) {
        this.account.plus_trial_eligible = Boolean(result.eligible);
        this.account.plus_trial_campaign = result.campaign || CHATGPT_PLUS_TRIAL_CAMPAIGN;
        this.account.plus_trial_country = result.country || countryCode;
        this.account.plus_trial_checked_at = nowIso();
        this.account.plus_trial_detail = result.detail || '';
        if (result.planType) this.account.agent_plan_type = result.planType;
      }
      if (this.account?.id) {
        await accountRepository.updateById(this.account.id, latest => ({
          plus_trial_eligible: Boolean(result.eligible),
          plus_trial_campaign: result.campaign || CHATGPT_PLUS_TRIAL_CAMPAIGN,
          plus_trial_country: result.country || countryCode,
          plus_trial_checked_at: nowIso(),
          plus_trial_detail: result.detail || '',
          ...(result.planType ? { agent_plan_type: result.planType } : {}),
          ...(result.accountId && !latest.openai_account_id ? { openai_account_id: result.accountId } : {}),
          status: result.eligible ? '有零元试用资格' : '无零元试用资格',
        }));
      }
      return { ok: true, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`零元试用校验失败: ${message}`, 'warn');
      if (this.account?.id) {
        await accountRepository.updateById(this.account.id, {
          plus_trial_checked_at: nowIso(),
          plus_trial_detail: `check_failed: ${message}`.slice(0, 500),
          last_error: `零元试用校验失败: ${message}`.slice(0, 500),
        }).catch(() => {});
      }
      if (throwOnError) throw error;
      return { ok: false, error: message };
    }
  }

  async run() {
    if (!this.requireStoredSession) this.assertPasswordTotpCredentials();
    await this.ensureProxyConnectivity();
    this.logProtocolHardening();

    if (this.requireStoredSession) {
      this.log(`Business RT：复用已保存 Session 授权工作区 ${this.workspaceSelection.workspaceId}`);
      return this.loginCodexWithPhone();
    }

    this.log(`密码+2FA 账号，直接 Codex 登录（邮箱/密码/TOTP）: ${this.account.email}`);
    return this.loginCodexWithPhone();
  }
}

function extractPhoneCode(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ');
  const patterns = [
    /OpenAI[^\d]{0,80}(\d{6})/i,
    /验证代码[^\d]{0,20}(\d{6})/,
    /验证码[^\d]{0,20}(\d{6})/,
    /\b(\d{6})\b/,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

async function fetchSmsPayload(smsUrl) {
  const url = String(smsUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('该邮箱没有有效短信链接');
  const response = await fetch(url, { cache: 'no-store' });
  const text = await response.text();
  const code = extractPhoneCode(text);
  return {
    ok: response.ok,
    status: response.status,
    code,
    preview: text.slice(0, 1200),
  };
}

async function waitForPhoneCode(account, logger, timeoutMs = PHONE_OTP_WAIT_TIMEOUT_MS) {
  const smsUrl = String(account?.auth_phone_sms_url || '').trim();
  if (!smsUrl) throw new Error('该邮箱没有保存授权手机号短信链接');
  const phoneNumber = String(account?.auth_phone_number || '').trim();
  const started = Date.now();
  let lastPreview = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const payload = await fetchSmsPayload(smsUrl);
      lastPreview = String(payload.preview || '').slice(0, 300);
      if (payload.code) {
        logger?.(`读取到手机号验证码: ${payload.code}${phoneNumber ? ` (${maskPhone(phoneNumber)})` : ''}`);
        if (account.id) {
          await accountRepository.updateById(account.id, {
            last_sms_code: payload.code,
            last_sms_at: nowIso(),
          });
        }
        return payload.code;
      }
      logger?.(`手机号短信暂未识别到验证码: HTTP ${payload.status}`, 'warn');
    } catch (error) {
      lastPreview = error instanceof Error ? error.message : String(error);
      logger?.(`读取手机号短信失败: ${lastPreview}`, 'warn');
    }
    await sleep(PHONE_OTP_POLL_INTERVAL_MS);
  }
  throw new Error(`手机短信验证码获取超时，导出失败${phoneNumber ? ` (${maskPhone(phoneNumber)})` : ''}，最后返回: ${lastPreview}`);
}

async function refreshOpenAIRecordFromRt(account, logger) {
  const rt = String(account?.openai_rt || '').trim();
  if (!rt) throw new Error('该邮箱尚未导入 OpenAI rttoken');
  let lastError = '';
  for (const tokenURL of AUTH_OAUTH_TOKEN_URLS) {
    const response = await fetch(tokenURL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': OPENAI_CODEX_USER_AGENT,
      },
      body: buildRefreshTokenBody(rt),
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = {}; }
    if (response.ok && payload.access_token) {
      logger?.(`OpenAI RT 刷新成功: ${tokenURL}`);
      return normalizeOpenAIRecordFromRefreshPayload(account.email, payload, rt);
    }
    lastError = `endpoint=${tokenURL} HTTP ${response.status} ${text.slice(0, 300)}`;
    logger?.(`OpenAI RT 刷新失败: ${lastError}`, 'warn');
  }
  throw new Error(`OpenAI RT 刷新 access_token 失败: ${lastError}`);
}

function shouldAutoEnrollTotpAfterSession(account) {
  return true;
}

function trimAuthLogs(logs, { failed = false } = {}) {
  const list = Array.isArray(logs) ? logs : [];
  const limit = failed ? 80 : 20;
  return list.slice(-limit);
}

function publicCodexAuthResult(item) {
  if (!item || typeof item !== 'object') return item;
  const { json, logs, ...rest } = item;
  const failed = item.ok === false;
  return {
    ...rest,
    logCount: Array.isArray(logs) ? logs.length : 0,
    // 失败必须带回日志；成功只保留尾部摘要，减小响应体积
    logs: trimAuthLogs(logs, { failed }),
  };
}

function publicLogoutAllResult(item) {
  if (!item || typeof item !== 'object') return item;
  const { logs, logout, sessionUser, ...rest } = item;
  const failed = item.ok === false;
  return {
    ...rest,
    sessionEmail: sessionUser?.email || '',
    logoutKeys: logout && typeof logout === 'object' ? Object.keys(logout) : [],
    logCount: Array.isArray(logs) ? logs.length : 0,
    logs: trimAuthLogs(logs, { failed }),
  };
}

async function runLogoutAllForAccount(account, { onLog } = {}) {
  const startedAt = Date.now();
  const emitLog = (entry) => {
    if (typeof onLog === 'function') onLog(entry);
  };
  const logs = [];
  const sse = {
    send(event, data) {
      if (event !== 'log') return;
      const entry = {
        time: data?.time || nowIso(),
        level: data?.level || 'info',
        msg: data?.msg || data?.error || '',
      };
      logs.push(entry);
      emitLog({ email: account.email, ...entry });
    },
  };

  structuredLog('logout_all_start', {
    email: account.email,
    stage: inferOpenAiStage(account),
  });

  try {
    const credentialIssue = logoutAllCredentialIssue(account);
    if (credentialIssue) throw new Error(credentialIssue);
    const storedAccessToken = extractSessionAccessToken(account);
    const logoutFlow = new OpenAIJsonAuthFlow(account, sse, {
      phoneMode: 'sms',
      reuseStoredSession: true,
    });
    let logout;
    try {
      logoutFlow.log('复用已保存的 ChatGPT Session，直接退出全部会话');
      await logoutFlow.importStoredCookieStorageState();
      logout = await logoutFlow.logoutAllChatGptSessions(storedAccessToken);
    } finally {
      await logoutFlow.dispose();
    }

    // logout_all 完成后必须丢弃所有旧认证状态，避免重登复用旧 RT/Agent。
    await clearAuthStateForFreshLogin(account.id, { status: '旧 Session 已退出，准备重登' });
    sse.send('log', { msg: '全部会话已退出，开始创建全新 Session 并重登' });

    let relogin;
    try {
      relogin = await reloginChatGptWebSessionForHealth(account, {
        loginOnly: true,
        onLog: entry => {
          logs.push(entry);
          emitLog(entry);
        },
      });
    } catch (error) {
      throw new Error(`全部会话已退出，但重新登录失败: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (account.id) {
      await accountRepository.updateById(account.id, { status: '已退出全部会话并重登', last_error: '' }).catch(() => {});
    }

    structuredLog('logout_all_done', {
      email: account.email,
      ok: true,
      durationMs: durationMs(startedAt),
    });
    return {
      ok: true,
      email: account.email,
      accessTokenPresent: Boolean(relogin.accessToken),
      sessionUser: relogin.session?.user || null,
      logout,
      reloggedIn: true,
      logs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (account.id) {
      await clearAuthStateForFreshLogin(account.id, { status: '退出全部会话失败，旧认证状态已清理' }).catch(() => {});
      await accountRepository.updateById(account.id, { status: '退出全部会话失败', last_error: message }).catch(() => {});
    }
    structuredLog('logout_all_failed', {
      email: account.email,
      ok: false,
      durationMs: durationMs(startedAt),
      error: message,
    });
    return {
      ok: false,
      email: account.email,
      error: message,
      logs,
    };
  }
}

async function runLogoutAllForAccounts(accounts, {
  onAccountStart,
  onAccountLog,
  onAccountDone,
} = {}) {
  const results = await mapWithConcurrency(accounts, getOauthBatchConcurrency(), async account => {
    if (typeof onAccountStart === 'function') {
      onAccountStart({
        email: account.email,
        id: account.id,
        stage: inferOpenAiStage(account),
      });
    }
    const result = await runLogoutAllForAccount(account, { onLog: onAccountLog });
    if (typeof onAccountDone === 'function') onAccountDone(result);
    return result;
  });
  const success = results.filter(item => item.ok).length;
  const failed = results.filter(item => !item.ok).length;
  return { ok: true, success, failed, results };
}

function publicEnrollTotpResult(item) {
  if (!item || typeof item !== 'object') return item;
  const { logs, mfaInfo, enroll, secret, ...rest } = item;
  const failed = item.ok === false;
  return {
    ...rest,
    // Admin API may include secret once for export/verify; keep boolean in SSE summaries.
    hasSecret: Boolean(secret),
    secret: secret || undefined,
    mfaEnabled: Boolean(mfaInfo?.mfa_enabled || mfaInfo?.mfa_enabled_v2),
    totpFactorCount: Array.isArray(mfaInfo?.factors?.totp) ? mfaInfo.factors.totp.length : 0,
    logCount: Array.isArray(logs) ? logs.length : 0,
    logs: trimAuthLogs(logs, { failed }),
  };
}

async function runEnrollTotpForAccount(account, {
  onLog,
  force = false,
  onlyWithoutLocalSecret = true,
} = {}) {
  const startedAt = Date.now();
  const logs = [];
  const sse = {
    send(event, data) {
      if (event !== 'log') return;
      const entry = {
        time: data?.time || nowIso(),
        level: data?.level || 'info',
        msg: data?.msg || data?.error || '',
      };
      logs.push(entry);
      if (typeof onLog === 'function') onLog({ email: account.email, ...entry });
    },
  };

  structuredLog('enroll_totp_start', {
    email: account.email,
    stage: inferOpenAiStage(account),
    hasLocalSecret: hasTotpSecret(account),
    hasSession: accountHasChatGptSession(account),
  });

  try {
    if (!accountHasChatGptSession(account)) {
      throw new Error('账号缺少 ChatGPT Session（session_access_token），请先登录/验活');
    }
    if (onlyWithoutLocalSecret && hasTotpSecret(account) && !force) {
      structuredLog('enroll_totp_done', {
        email: account.email,
        ok: true,
        skipped: true,
        reason: 'local_secret_present',
        durationMs: durationMs(startedAt),
      });
      return {
        ok: true,
        skipped: true,
        reason: 'local_secret_present',
        email: account.email,
        id: account.id,
        secret: normalizeTotpSecret(account.two_factor_secret),
        logs,
      };
    }

    const flowAccount = {
      ...account,
      session_access_token: String(account.session_access_token || '').trim(),
      session_json: String(account.session_json || '').trim(),
      storage_state_json: String(account.storage_state_json || '').trim(),
      two_factor_secret: normalizeTotpSecret(account.two_factor_secret),
      openai_password: String(account.openai_password || account.password || '').trim(),
    };
    if (account.id) {
      const latest = findAccountById(account.id);
      if (latest) {
        flowAccount.session_access_token = latest.session_access_token || flowAccount.session_access_token;
        flowAccount.session_json = latest.session_json || flowAccount.session_json;
        flowAccount.storage_state_json = latest.storage_state_json || flowAccount.storage_state_json;
        flowAccount.two_factor_secret = normalizeTotpSecret(latest.two_factor_secret || flowAccount.two_factor_secret);
        flowAccount.openai_password = latest.openai_password || latest.password || flowAccount.openai_password;
      }
    }

    const flow = new OpenAIJsonAuthFlow(flowAccount, sse, {
      phoneMode: 'sms',
    });
    try {
      flow.logProtocolHardening();
      await flow.importStoredCookieStorageState().catch(() => 0);
      await flow.ensureChatGptDeviceCookie();

    const accessToken = String(flowAccount.session_access_token || '').trim();
      const result = await flow.enrollAndActivateTotpForSession(accessToken, {
      skipIfEnabled: !force,
    });

      if (result.skipped) {
      const localSecret = normalizeTotpSecret(
        flowAccount.two_factor_secret || account.two_factor_secret || '',
      );
      if (localSecret) {
        structuredLog('enroll_totp_done', {
          email: account.email,
          ok: true,
          skipped: true,
          reason: 'already_enabled_with_local_secret',
          durationMs: durationMs(startedAt),
        });
        return {
          ok: true,
          skipped: true,
          reason: 'already_enabled_with_local_secret',
          email: account.email,
          id: account.id,
          secret: localSecret,
          factorId: result.factorId || '',
          mfaInfo: result.mfaInfo || null,
          logs,
        };
      }
      if (account.id) {
        await accountRepository.updateById(account.id, {
          status: '远端已有 MFA',
          last_error: '远端已开启 TOTP，本地无密钥可回填',
        }).catch(() => {});
      }
      structuredLog('enroll_totp_done', {
        email: account.email,
        ok: false,
        skipped: true,
        reason: result.reason || 'already_enabled',
        durationMs: durationMs(startedAt),
      });
      return {
        ok: false,
        skipped: true,
        reason: result.reason || 'already_enabled',
        email: account.email,
        id: account.id,
        secret: '',
        factorId: result.factorId || '',
        mfaInfo: result.mfaInfo || null,
        error: '远端已开启 TOTP MFA，无法回填密钥；若本地已有密钥可忽略',
        logs,
      };
    }

    const secret = validateTotpSecret(result.secret);
    if (account.id) {
      await accountRepository.updateById(account.id, latest => ({
        two_factor_secret: secret,
        status: '已设置2FA',
        last_error: '',
        ...(!String(latest.openai_password || '').trim() && String(latest.password || '').trim()
          ? { openai_password: String(latest.password || '').trim() } : {}),
      }));
    }

    structuredLog('enroll_totp_done', {
      email: account.email,
      ok: true,
      skipped: false,
      durationMs: durationMs(startedAt),
    });
      return {
      ok: true,
      skipped: false,
      reason: '',
      email: account.email,
      id: account.id,
      secret,
      factorId: result.factorId || '',
      mfaInfo: result.mfaInfo || null,
      enroll: result.enroll || null,
        logs,
      };
    } finally {
      await flow.dispose().catch(() => {});
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (account.id) {
      await accountRepository.updateById(account.id, {
        status: '设置2FA失败',
        last_error: message,
      }).catch(() => {});
    }
    structuredLog('enroll_totp_failed', {
      email: account.email,
      ok: false,
      durationMs: durationMs(startedAt),
      error: message,
    });
    return {
      ok: false,
      skipped: false,
      email: account.email,
      id: account.id,
      error: message,
      logs,
    };
  }
}

async function runEnrollTotpForAccounts(accounts, {
  onAccountStart,
  onAccountLog,
  onAccountDone,
  force = false,
  onlyWithoutLocalSecret = true,
} = {}) {
  const results = await mapWithConcurrency(accounts, getOauthBatchConcurrency(), async account => {
    if (typeof onAccountStart === 'function') {
      onAccountStart({
        email: account.email,
        id: account.id,
        stage: inferOpenAiStage(account),
      });
    }
    const result = await runEnrollTotpForAccount(account, {
      onLog: onAccountLog,
      force,
      onlyWithoutLocalSecret,
    });
    if (typeof onAccountDone === 'function') onAccountDone(result);
    return result;
  });
  const success = results.filter(item => item.ok && !item.skipped).length;
  const skipped = results.filter(item => item.ok && item.skipped).length;
  const failed = results.filter(item => !item.ok).length;
  return { ok: true, success, skipped, failed, results };
}

function publicResetTotpCredential(account, secret) {
  const password = resolveOpenAiAccountPassword(account);
  return {
    email: String(account?.email || '').trim(),
    password,
    totp: normalizeTotpSecret(secret),
    line: [String(account?.email || '').trim(), password, normalizeTotpSecret(secret)].join('----'),
  };
}

async function runResetTotpForAccount(account, {
  onAccountStart,
  onAccountLog,
  onAccountDone,
  ...network
} = {}) {
  const startedAt = Date.now();
  const emit = (msg, level = 'info') => {
    const entry = { time: nowIso(), level, msg: String(msg || '') };
    onAccountLog?.({ id: account?.id, email: account?.email, ...entry });
  };
  try {
    return await monitorCoordinator.runExclusive(account.email, async () => {
      let latest = account.id ? (findAccountById(account.id) || account) : account;
      onAccountStart?.({ id: latest.id, email: latest.email, stage: 0 });
      // Reuse the browser's session and recent-auth cookies. Only an explicit
      // authentication rejection before any mutation permits a fresh login.
      const loginMethod = resolveAccountLoginMethod(latest);
      if (loginMethod !== 'password_totp') {
        throw new Error('2FA 换绑要求账号具备邮箱、密码和旧 TOTP；请使用三段账号格式重新导入');
      }
      emit('创建账号独立隔离环境，优先复用浏览器 Session 和 Cookie');
      const flowAccount = {
        ...latest,
        session_access_token: String(latest.session_access_token || '').trim(),
        session_json: String(latest.session_json || '').trim(),
        storage_state_json: String(latest.storage_state_json || '').trim(),
        two_factor_secret: normalizeTotpSecret(latest.two_factor_secret),
        openai_password: String(latest.openai_password || latest.password || '').trim(),
      };
      const flow = new OpenAIJsonAuthFlow(flowAccount, {
        send(event, data) {
          if (event !== 'log') return;
          emit(data?.msg || data?.error || '', data?.level || 'info');
        },
      }, { phoneMode: 'sms', forbidPhoneChallenge: true, humanPacingEnabled: false, ...accountRequestNetwork(latest, network) });
      try {
        const { result, session } = await withCachedWebSession(flowAccount, {
          flow,
          persistSession: login => persistChatGptWebSession(latest.id, { ...login, status: '2FA 换绑认证成功' }),
        }, accessToken => flow.resetTotpForSession(accessToken));
        const secret = validateTotpSecret(result.secret);
        await accountRepository.updateById(latest.id, current => ({
          two_factor_secret: secret,
          raw: [latest.email, flowAccount.openai_password, secret].join('----'),
          fingerprint_json: flowAccount.fingerprint_json || latest.fingerprint_json || '',
          status: '已换绑2FA',
          last_error: '',
          ...(!String(current.openai_password || '').trim() && flowAccount.openai_password
            ? { openai_password: flowAccount.openai_password } : {}),
        }));
        await persistChatGptWebSession(latest.id, {
          ...session, storageState: await flow.exportCookieStorageState(), status: '已换绑2FA',
        });
        const refreshed = findAccountById(latest.id) || { ...latest, two_factor_secret: secret };
        const output = {
          ok: true,
          id: refreshed.id,
          email: refreshed.email,
          factorId: result.factorId || '',
          mfaEnabled: Boolean(result.mfaInfo?.mfa_enabled || result.mfaInfo?.mfa_enabled_v2),
          credentials: publicResetTotpCredential(refreshed, secret),
          durationMs: durationMs(startedAt),
        };
        onAccountDone?.(output);
        return output;
      } finally {
        await flow.dispose().catch(() => {});
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (account?.id) await accountRepository.updateById(account.id, { status: '换绑2FA失败', last_error: message }).catch(() => {});
    const output = { ok: false, id: account?.id, email: account?.email, error: message, durationMs: durationMs(startedAt) };
    onAccountLog?.({ id: account?.id, email: account?.email, time: nowIso(), level: 'error', msg: message });
    onAccountDone?.(output);
    return output;
  }
}

async function runResetTotpForAccounts(accounts, { concurrency, onAccountStart, onAccountLog, onAccountDone, ...network } = {}) {
  const limit = getRegisterBatchConcurrency(concurrency);
  const results = await mapWithConcurrency(accounts, limit, account => runResetTotpForAccount(account, {
    onAccountStart,
    onAccountLog,
    onAccountDone,
    ...network,
  }));
  return {
    ok: true,
    concurrency: limit,
    success: results.filter(item => item.ok).length,
    failed: results.filter(item => !item.ok).length,
    results,
  };
}

function publicPlusTrialResult(item) {
  if (!item || typeof item !== 'object') return item;
  const { logs, eligibility, pricingConfigSummary, ...rest } = item;
  const failed = item.ok === false;
  return {
    ...rest,
    pricing: pricingConfigSummary || null,
    logCount: Array.isArray(logs) ? logs.length : 0,
    logs: trimAuthLogs(logs, { failed }),
  };
}

async function runPlusTrialCheckForAccount(account, {
  onLog,
  countryCode = 'JP',
} = {}) {
  const startedAt = Date.now();
  const logs = [];
  const sse = {
    send(event, data) {
      if (event !== 'log') return;
      const entry = {
        time: data?.time || nowIso(),
        level: data?.level || 'info',
        msg: data?.msg || data?.error || '',
      };
      logs.push(entry);
      if (typeof onLog === 'function') onLog({ email: account.email, ...entry });
    },
  };

  structuredLog('plus_trial_check_start', {
    email: account.email,
    hasSession: accountHasChatGptSession(account),
  });

  try {
    if (!accountHasChatGptSession(account)) {
      throw new Error('账号缺少 ChatGPT Session（session_access_token）');
    }
    const flowAccount = {
      ...account,
      session_access_token: String(account.session_access_token || '').trim(),
      storage_state_json: String(account.storage_state_json || '').trim(),
    };
    if (account.id) {
      const latest = findAccountById(account.id);
      if (latest) {
        flowAccount.session_access_token = latest.session_access_token || flowAccount.session_access_token;
        flowAccount.storage_state_json = latest.storage_state_json || flowAccount.storage_state_json;
        flowAccount.openai_account_id = latest.openai_account_id || flowAccount.openai_account_id;
      }
    }
    const flow = new OpenAIJsonAuthFlow(flowAccount, sse, { phoneMode: 'sms' });
    await flow.importStoredCookieStorageState().catch(() => 0);
    await flow.ensureChatGptDeviceCookie();
    const result = await flow.ensurePlusTrialCheckedIfNeeded(flowAccount.session_access_token, {
      countryCode,
      throwOnError: true,
    });
    structuredLog('plus_trial_check_done', {
      email: account.email,
      ok: true,
      eligible: Boolean(result.eligible),
      durationMs: durationMs(startedAt),
    });
    return {
      ok: true,
      email: account.email,
      id: account.id,
      eligible: Boolean(result.eligible),
      campaign: result.campaign || CHATGPT_PLUS_TRIAL_CAMPAIGN,
      country: result.country || countryCode,
      planType: result.planType || '',
      reason: result.reason || '',
      detail: result.detail || '',
      pricingConfigSummary: result.pricingConfigSummary || null,
      logs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (account.id) {
      await accountRepository.updateById(account.id, {
        plus_trial_checked_at: nowIso(),
        plus_trial_detail: `check_failed: ${message}`.slice(0, 500),
        last_error: `零元试用校验失败: ${message}`.slice(0, 500),
      }).catch(() => {});
    }
    structuredLog('plus_trial_check_failed', {
      email: account.email,
      ok: false,
      durationMs: durationMs(startedAt),
      error: message,
    });
    return {
      ok: false,
      email: account.email,
      id: account.id,
      eligible: null,
      error: message,
      logs,
    };
  }
}

async function runPlusTrialCheckForAccounts(accounts, {
  onAccountStart,
  onAccountLog,
  onAccountDone,
  countryCode = 'JP',
} = {}) {
  const results = await mapWithConcurrency(accounts, getOauthBatchConcurrency(), async account => {
    if (typeof onAccountStart === 'function') {
      onAccountStart({
        email: account.email,
        id: account.id,
        stage: inferOpenAiStage(account),
      });
    }
    const result = await runPlusTrialCheckForAccount(account, {
      onLog: onAccountLog,
      countryCode,
    });
    if (typeof onAccountDone === 'function') onAccountDone(result);
    return result;
  });
  const success = results.filter(item => item.ok).length;
  const eligible = results.filter(item => item.ok && item.eligible === true).length;
  const ineligible = results.filter(item => item.ok && item.eligible === false).length;
  const failed = results.filter(item => !item.ok).length;
  return { ok: true, success, eligible, ineligible, failed, results };
}

async function persistSessionHealth(accountId, {
  health,
  detail = '',
  status = '',
  clearSession = false,
  lastError = null,
} = {}) {
  if (!accountId) return;
  await accountRepository.updateById(accountId, {
    session_health: String(health || '').trim(),
    session_health_checked_at: nowIso(),
    session_health_detail: String(detail || '').trim().slice(0, 500),
    ...(status ? { status: String(status) } : {}),
    ...(lastError != null ? { last_error: String(lastError || '') } : {}),
    ...(clearSession ? { session_access_token: '', session_json: '', storage_state_json: '' } : {}),
  });
}

function publicSessionHealthResult(item) {
  if (!item || typeof item !== 'object') return item;
  const { logs, ...rest } = item;
  const failed = item.ok === false && item.health !== SESSION_HEALTH.DEACTIVATED;
  return {
    ...rest,
    healthLabel: sessionHealthLabel(item.health),
    logCount: Array.isArray(logs) ? logs.length : 0,
    logs: trimAuthLogs(logs, { failed }),
  };
}

async function reloginChatGptWebSessionForHealth(account, {
  onLog,
  proxyPool,
  directWhenProxyPoolEmpty = false,
} = {}) {
  const logs = [];
  const sse = {
    send(event, data) {
      if (event !== 'log') return;
      const entry = {
        time: data?.time || nowIso(),
        level: data?.level || 'info',
        msg: data?.msg || data?.error || '',
      };
      logs.push(entry);
      if (typeof onLog === 'function') onLog({ email: account.email, ...entry });
    },
  };

  const persistResult = async (sessionResult) => {
    if (account.id) {
      await persistChatGptWebSession(account.id, {
        accessToken: sessionResult.accessToken,
        session: sessionResult.session,
        storageState: sessionResult.storageState,
        status: 'Session已刷新',
      });
    }
    return {
      accessToken: sessionResult.accessToken,
      session: sessionResult.session,
      storageState: sessionResult.storageState,
      proxyUrl: sessionResult.proxyUrl,
      directEgress: Boolean(sessionResult.directEgress),
      logs,
    };
  };

  const issue = protocolLoginCredentialIssue(account);
  if (issue) throw new Error(issue);
  const loginAccount = { ...account };
  loginAccount.openai_password = String(account.openai_password || account.password || '').trim();
  loginAccount.two_factor_secret = normalizeTotpSecret(account.two_factor_secret);
  if (account.id) {
    const latest = findAccountById(account.id);
    if (latest) {
      loginAccount.openai_password = latest.openai_password || latest.password || loginAccount.openai_password;
      loginAccount.two_factor_secret = latest.two_factor_secret || loginAccount.two_factor_secret;
    }
  }
  const flow = new OpenAIJsonAuthFlow(loginAccount, sse, {
    phoneMode: 'sms',
    humanPacingEnabled: false,
    proxyPool,
    directWhenProxyPoolEmpty,
  });
  flow.log('验活重登：邮箱 + 密码 + TOTP 登录 ChatGPT Web');
  try {
    return await persistResult({
      ...(await flow.loginChatGptWebWithPasswordTotp()),
      proxyUrl: flow.proxyUrl,
      directEgress: flow.directEgress,
    });
  } finally {
    await flow.dispose();
  }
}

function protocolRequestNetwork(body = {}) {
  const proxyMode = String(body.proxyMode || '').trim().toLowerCase();
  if (proxyMode === 'direct') return { proxyPool: '', directWhenProxyPoolEmpty: true };
  if (proxyMode === 'local') {
    const rawPort = body.localProxyPort ?? body.local_proxy_port ?? 7890;
    const port = Number(String(rawPort).trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('本地代理端口必须是 1-65535 的整数');
    }
    return { proxyPool: `http://127.0.0.1:${port}`, directWhenProxyPoolEmpty: true };
  }
  if (proxyMode === 'builtin') {
    const proxyPool = resolveBuiltInProxyPool(process.env);
    if (!proxyPool) throw new Error('服务器未配置内置代理池，请选择直连或自定义代理池');
    parseProxyPool(proxyPool);
    return { proxyPool, directWhenProxyPoolEmpty: true };
  }
  const hasProxyPool = Object.hasOwn(body || {}, 'proxyPool') || Object.hasOwn(body || {}, 'proxy_pool');
  if (proxyMode === 'pool' || hasProxyPool) {
    const proxyPool = String(body?.proxyPool ?? body?.proxy_pool ?? '').trim();
    if (!proxyPool) return { proxyPool: '', directWhenProxyPoolEmpty: true };
    parseProxyPool(proxyPool);
    return { proxyPool, directWhenProxyPoolEmpty: true };
  }
  // Browser-owned protocol settings default to direct egress. Legacy server
  // callers without browser state may still use the server settings/env.
  if (body.browserState) return { proxyPool: '', directWhenProxyPoolEmpty: true };
  return { proxyPool: undefined, directWhenProxyPoolEmpty: false };
}

function accountRequestNetwork(account, network = {}) {
  if (network.proxyPool === undefined) return network;
  const candidates = parseProxyPool(network.proxyPool);
  if (!candidates.length) return { ...network, proxyPool: '' };
  const index = Math.floor(Math.random() * candidates.length);
  const selected = proxyHealthRegistry.choose(candidates, { seed: index });
  return { ...network, proxyPool: selected || candidates[index] };
}

function storageStateCookies(storageStateJson) {
  let state;
  try { state = JSON.parse(String(storageStateJson || '')); } catch { return new Map(); }
  if (!Array.isArray(state?.cookies)) return new Map();
  const cookies = new Map();
  for (const cookie of state.cookies) {
    const name = String(cookie?.name || '').trim();
    if (!name || cookie?.value == null) continue;
    cookies.set(name, String(cookie.value));
  }
  return cookies;
}

function sessionProbeHeaders(storageStateJson, fingerprintJson = '') {
  const cookies = storageStateCookies(storageStateJson);
  const fingerprint = normalizeStoredFingerprint(fingerprintJson) || STATIC_DEVICE_FINGERPRINT;
  const cookieHeader = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  return {
    ...buildBrowserHeaders({
      accept: '*/*',
      origin: CHATGPT_BASE_URL,
      referer: `${CHATGPT_BASE_URL}/`,
      'oai-device-id': cookies.get('oai-did') || '',
      'oai-language': fingerprint.locale || 'en-US',
      'oai-session-id': randomUUID(),
      'x-openai-target-path': '/backend-api/me',
      'x-openai-target-route': '/backend-api/me',
    }, fingerprint),
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };
}

async function probeSessionThroughConfiguredProxy(accessToken, storageStateJson = '', fingerprintJson = '', {
  exactProxyUrl,
  direct = false,
} = {}) {
  const settings = getProtocolSettings();
  const headers = sessionProbeHeaders(storageStateJson, fingerprintJson);
  const hasExactProxy = exactProxyUrl !== undefined || direct;
  const selectedProxy = hasExactProxy ? String(exactProxyUrl || '') : resolveSessionProxy({ pool: settings.proxyPool }).proxyUrl;
  const proxies = [selectedProxy];
  if (!hasExactProxy) {
    for (const candidate of parseProxyPool(settings.proxyPool)) {
      if (!proxies.includes(candidate)) proxies.push(candidate);
    }
    if (!proxies.includes(FIXED_LOCAL_PROXY_URL)) proxies.push(FIXED_LOCAL_PROXY_URL);
  }
  const failures = [];
  let lastFailure = null;

  for (const proxyUrl of proxies) {
    const fetchImpl = createCurlCffiFetch(proxyUrl, { direct: direct && !proxyUrl });
    try {
      const result = await probeChatGptSessionAccessToken(accessToken, { fetchImpl, headers });
      if (result.health !== SESSION_HEALTH.PROBE_FAILED) {
        return result;
      }
      lastFailure = result;
      failures.push(`${proxyUrl ? maskProxyUrl(proxyUrl) : '直连'}: ${result.error || `HTTP ${result.status || 0}`}`);
    } finally {
      await fetchImpl.dispose?.();
    }
  }

  return {
    ok: false,
    health: SESSION_HEALTH.PROBE_FAILED,
    status: lastFailure?.status || 0,
    code: lastFailure?.code || '',
    body: lastFailure?.body || '',
    error: `所有代理出口探测失败：${failures.join('；')}`,
  };
}

async function syncSessionPlanTypes() {
  const updates = await reconcileSessionPlanTypes({
    accounts: getAllAccounts(),
    resolvePlanType: resolveSessionPlanType,
    updateMany: (ids, patcher) => accountRepository.updateMany(ids, patcher),
  });
  if (updates.length) {
    console.log(`[accounts] 已根据历史 Session 类型补齐 ${updates.length} 个账号类型`);
  }
  return updates;
}

async function runSessionHealthCheckForAccount(account, {
  reloginOnInvalid = true,
  forceRelogin = false,
  loginOnly = false,
  onLog,
  proxyPool,
  directWhenProxyPoolEmpty = false,
} = {}) {
  const startedAt = Date.now();
  const logs = [];
  const emit = (msg, level = 'info') => {
    const entry = { time: nowIso(), level, msg: String(msg || '') };
    logs.push(entry);
    if (typeof onLog === 'function') onLog({ email: account.email, ...entry });
  };

  structuredLog('session_health_start', {
    email: account.email,
    hasSession: accountHasChatGptSession(account),
    reloginOnInvalid: Boolean(reloginOnInvalid),
    forceRelogin: Boolean(forceRelogin),
    loginOnly: Boolean(loginOnly),
  });

  const finish = async (result) => {
    const health = result.health || SESSION_HEALTH.PROBE_FAILED;
    const detail = result.detail || result.error || result.probeCode || '';
    let status = '';
    if (health === SESSION_HEALTH.ALIVE || health === SESSION_HEALTH.ALIVE_REFRESHED) {
      status = health === SESSION_HEALTH.ALIVE_REFRESHED ? 'Session已刷新' : 'Session有效';
    } else if (health === SESSION_HEALTH.DEACTIVATED) {
      status = '账号已停用';
    } else if (health === SESSION_HEALTH.SESSION_INVALID) {
      status = 'Session失效';
    } else if (health === SESSION_HEALTH.NO_SESSION) {
      status = account.status || '无 Session';
    } else if (health === SESSION_HEALTH.RELOGIN_FAILED) {
      status = '验活重登失败';
    } else if (health === SESSION_HEALTH.PROBE_FAILED) {
      status = 'Session验活失败';
    }

    if (account.id) {
      await persistSessionHealth(account.id, {
        health,
        detail,
        status,
        clearSession: health === SESSION_HEALTH.DEACTIVATED,
        lastError: health === SESSION_HEALTH.ALIVE || health === SESSION_HEALTH.ALIVE_REFRESHED
          ? ''
          : (result.error || detail || ''),
      }).catch(() => {});
    }

    structuredLog(result.ok ? 'session_health_done' : 'session_health_failed', {
      email: account.email,
      ok: Boolean(result.ok),
      health,
      durationMs: durationMs(startedAt),
      error: result.ok ? undefined : (result.error || detail || undefined),
    });

    return {
      ...result,
      health,
      healthLabel: sessionHealthLabel(health),
      email: account.email,
      id: account.id,
      logs,
    };
  };

  try {
    if ((loginOnly || forceRelogin) && protocolLoginCredentialIssue(account)) {
      const issue = protocolLoginCredentialIssue(account);
      emit(`跳过协议登录：${issue}，请补充后再运行`, 'warn');
      return finish({
        ok: false,
        skipped: true,
        health: SESSION_HEALTH.RELOGIN_FAILED,
        detail: `${issue}，无法执行协议登录`,
        error: `${issue}，无法执行协议登录`,
        missingLoginCredentials: true,
      });
    }
    if (shouldRequireExistingSession({ loginOnly, forceRelogin })) {
      if (!accountHasChatGptSession(account)) {
        emit('无 ChatGPT Session，标记 no_session');
        return finish({
          ok: false,
          health: SESSION_HEALTH.NO_SESSION,
          detail: '缺少 session_access_token',
          error: '缺少 session_access_token',
        });
      }

      emit('探测 ChatGPT backend-api/me');
      const probe = await probeSessionThroughConfiguredProxy(
        account.session_access_token,
        account.storage_state_json,
        account.fingerprint_json,
      );
      emit(`探测结果: health=${probe.health} status=${probe.status || 0} code=${probe.code || ''}`);

      if (probe.health === SESSION_HEALTH.ALIVE) {
        return finish({
          ok: true,
          health: SESSION_HEALTH.ALIVE,
          detail: `HTTP ${probe.status}`,
          probeStatus: probe.status,
          probeCode: probe.code,
        });
      }

      if (probe.health === SESSION_HEALTH.DEACTIVATED) {
        return finish({
          ok: false,
          health: SESSION_HEALTH.DEACTIVATED,
          detail: probe.code || probe.body || 'account_deactivated',
          error: probe.code || 'account_deactivated',
          probeStatus: probe.status,
          probeCode: probe.code,
        });
      }

      if (probe.health === SESSION_HEALTH.PROBE_FAILED) {
        return finish({
          ok: false,
          health: SESSION_HEALTH.PROBE_FAILED,
          detail: probe.error || probe.body || `HTTP ${probe.status}`,
          error: probe.error || probe.body || `HTTP ${probe.status}`,
          probeStatus: probe.status,
          probeCode: probe.code,
        });
      }

      if (!reloginOnInvalid) {
        emit('Session 失效，清理旧 Session、RT 和运行态身份');
        await clearAuthStateForFreshLogin(account.id, { status: 'Session 失效，旧认证状态已清理' }).catch(() => {});
        return finish({
          ok: false,
          health: SESSION_HEALTH.SESSION_INVALID,
          detail: probe.code || probe.body || `HTTP ${probe.status}`,
          error: probe.code || 'token_invalidated',
          probeStatus: probe.status,
          probeCode: probe.code,
        });
      }

      emit('Session 失效，开始邮箱/密码重登刷新 Session（不接手机号）');
    } else {
      emit('强制重登刷新 Session（不接手机号）');
    }

    const credentialIssue = protocolLoginCredentialIssue(account);
    if (credentialIssue) {
      return finish({
        ok: false, health: SESSION_HEALTH.RELOGIN_FAILED,
        detail: credentialIssue, error: credentialIssue, missingLoginCredentials: true,
      });
    }

    // 强制协议登录或 401 后重登前，清理当前记录中的 Session、personal/business RT
    // 以及 Agent 身份；原始邮箱、密码、TOTP 和邮箱 OAuth 凭据保持不变。
    emit('清理旧 Session、RT 和运行态身份后创建新隔离环境');
    await clearAuthStateForFreshLogin(account.id, { status: '准备重新登录，旧认证状态已清理' });

    try {
      const maxAttempts = Math.min(3, getSessionReloginMaxAttempts());
      const configuredPool = proxyPool !== undefined
        ? String(proxyPool || '').trim()
        : String(getProtocolSettings().proxyPool || '').trim();
      const proxyCandidates = parseProxyPool(configuredPool);
      const initialNetwork = proxyPool === undefined && !configuredPool
        ? { proxyPool: undefined, directWhenProxyPoolEmpty }
        : accountRequestNetwork(account, { proxyPool: configuredPool, directWhenProxyPoolEmpty });
      const initialProxy = initialNetwork.proxyPool || '';
      const initialProxyIndex = Math.max(0, proxyCandidates.indexOf(initialProxy));
      let switchProxyOnRetry = false;
      let proxySwitchCount = 0;
      let activeProxyUrl = initialProxy;
      let proxyAttemptStartedAt = 0;
      let relogin;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          emit(`协议重登第 ${attempt}/${maxAttempts} 次：创建全新隔离环境`);
          const network = proxySwitchCount > 0 && proxyCandidates.length > 1
            ? {
                ...initialNetwork,
                proxyPool: proxyCandidates[(initialProxyIndex + proxySwitchCount) % proxyCandidates.length],
              }
            : initialNetwork;
          activeProxyUrl = String(network.proxyPool || '');
          proxyAttemptStartedAt = Date.now();
          // A new flow owns a new CookieJar, device ID, fingerprint, OAuth/CSRF state,
          // HTTP dispatcher and (when configured) proxy session.
          relogin = await reloginChatGptWebSessionForHealth(account, {
            ...network,
            onLog: (entry) => {
              logs.push(entry);
              if (typeof onLog === 'function') onLog(entry);
            },
          });
          proxyHealthRegistry.recordSuccess(activeProxyUrl, Date.now() - proxyAttemptStartedAt);
          break;
        } catch (error) {
          proxyHealthRegistry.recordFailure(activeProxyUrl, error);
          if (attempt >= maxAttempts || !isRetryableSessionReloginError(error)) throw error;
          switchProxyOnRetry = isRetryableProxyConnectionError(error) && proxyCandidates.length > 1;
          if (switchProxyOnRetry) proxySwitchCount += 1;
          const delayMs = authRetryDelayMs(error, attempt) + Math.floor(Math.random() * 750);
          emit(`${switchProxyOnRetry ? '代理 SSL 连接中断，切换代理出口' : (isOpenAiRateLimitError(error) ? 'OpenAI 登录接口限流' : '隔离环境认证状态失效')}，等待 ${Math.ceil(delayMs / 1000)} 秒后完全重建并重试`, 'warn');
          await sleep(delayMs);
        }
      }
      const token = String(relogin.accessToken || '').trim();
      if (!token) {
        return finish({
          ok: false,
          health: SESSION_HEALTH.RELOGIN_FAILED,
          detail: '重登未返回 accessToken',
          error: '重登未返回 accessToken',
        });
      }
      // The login response is the source of truth for a successful refresh.
      // Do not immediately probe the freshly-created Session again: that
      // duplicate request adds latency and can turn a successful login into a
      // false failure when the new Session has not propagated yet.
      emit('重登成功，已保存新 Session');
      return finish({
        ok: true,
        health: SESSION_HEALTH.ALIVE_REFRESHED,
        detail: 'relogin ok',
        refreshed: true,
        hasSession: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isAccountDeactivatedError(message)) {
        return finish({
          ok: false,
          health: SESSION_HEALTH.DEACTIVATED,
          detail: message,
          error: message,
        });
      }
      return finish({
        ok: false,
        health: SESSION_HEALTH.RELOGIN_FAILED,
        detail: message,
        error: message,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAccountDeactivatedError(message)) {
      return finish({
        ok: false,
        health: SESSION_HEALTH.DEACTIVATED,
        detail: message,
        error: message,
      });
    }
    return finish({
      ok: false,
      health: SESSION_HEALTH.PROBE_FAILED,
      detail: message,
      error: message,
    });
  }
}

async function runSessionHealthCheckForAccounts(accounts, {
  reloginOnInvalid = true,
  forceRelogin = false,
  loginOnly = false,
  onAccountStart,
  onAccountLog,
  onAccountDone,
  autoDeleteInvalid = true,
  concurrency: requestedConcurrency,
  proxyPool,
  directWhenProxyPoolEmpty = false,
} = {}) {
  const reloginConcurrency = getSessionReloginConcurrency(requestedConcurrency);
  const startAccount = (account) => {
    if (typeof onAccountStart === 'function') {
      onAccountStart({
        email: account.email,
        id: account.id,
        stage: inferOpenAiStage(account),
        hasSession: accountHasChatGptSession(account),
        loginCredentialIssue: loginOnly ? protocolLoginCredentialIssue(account) : '',
      });
    }
  };

  let results;
  if (forceRelogin) {
    results = await mapWithConcurrency(accounts, reloginConcurrency, async account => {
      startAccount(account);
      const result = await runSessionHealthCheckForAccount(account, {
        reloginOnInvalid: true,
        forceRelogin: true,
        loginOnly,
        proxyPool,
        directWhenProxyPoolEmpty,
        onLog: onAccountLog,
      });
      if (typeof onAccountDone === 'function') onAccountDone(result);
      return result;
    });
  } else {
    // Phase 1 is a pure, high-concurrency probe. No worker holds a probe slot while
    // performing the much longer authentication flow.
    results = await mapWithConcurrency(accounts, reloginConcurrency, async account => {
      startAccount(account);
      const result = await runSessionHealthCheckForAccount(account, {
        reloginOnInvalid: false,
        forceRelogin: false,
        loginOnly,
        proxyPool,
        directWhenProxyPoolEmpty,
        onLog: onAccountLog,
      });
      if ((!reloginOnInvalid || result.health !== SESSION_HEALTH.SESSION_INVALID)
        && typeof onAccountDone === 'function') onAccountDone(result);
      return result;
    });

    if (reloginOnInvalid) {
      const candidates = results
        .map((result, index) => ({ result, account: accounts[index], index }))
        .filter(item => item.result.health === SESSION_HEALTH.SESSION_INVALID);
      const refreshed = await mapWithConcurrency(
        candidates,
        reloginConcurrency,
        async ({ result: probeResult, account, index }) => {
          const reloginResult = await runSessionHealthCheckForAccount(account, {
            reloginOnInvalid: true,
            forceRelogin: true,
            loginOnly,
            proxyPool,
            directWhenProxyPoolEmpty,
            onLog: onAccountLog,
          });
          results[index] = {
            ...reloginResult,
            logs: [...(probeResult.logs || []), ...(reloginResult.logs || [])],
            initialProbe: {
              health: probeResult.health,
              status: probeResult.probeStatus || 0,
              code: probeResult.probeCode || '',
            },
          };
          if (typeof onAccountDone === 'function') onAccountDone(results[index]);
        },
      );
      void refreshed;
    }
  }

  const tallies = {
    alive: results.filter(item => item.health === SESSION_HEALTH.ALIVE).length,
    aliveRefreshed: results.filter(item => item.health === SESSION_HEALTH.ALIVE_REFRESHED).length,
    sessionInvalid: results.filter(item => item.health === SESSION_HEALTH.SESSION_INVALID).length,
    deactivated: results.filter(item => item.health === SESSION_HEALTH.DEACTIVATED).length,
    noSession: results.filter(item => item.health === SESSION_HEALTH.NO_SESSION).length,
    probeFailed: results.filter(item => item.health === SESSION_HEALTH.PROBE_FAILED).length,
    reloginFailed: results.filter(item => item.health === SESSION_HEALTH.RELOGIN_FAILED).length,
    skippedCredentials: results.filter(item => item.skipped && item.missingLoginCredentials).length,
  };
  const success = tallies.alive + tallies.aliveRefreshed;
  const failed = results.length - success - tallies.skippedCredentials;
  const autoDelete = autoDeleteInvalid && isAutoDeleteInvalidSessionsEnabled();
  // Only account_deactivated is auto-deleted (local+cloud same rule). session_invalid is kept for relogin retry.
  // Callers must not retry deactivated rows; they are terminal and removed from the DB when autoDelete is on.
  const invalidIds = autoDelete
    ? results
      .filter(item => item.health === SESSION_HEALTH.DEACTIVATED)
      .map(item => String(item.id || ''))
      .filter(Boolean)
    : [];
  let autoDeleted = 0;
  const autoDeletedEmails = [];
  if (invalidIds.length) {
    const matched = invalidIds.map(findAccountById).filter(Boolean);
    autoDeletedEmails.push(...matched.map(account => String(account.email || '')));
    const deletion = accountRepository.deleteByIds(invalidIds, { confirm: true });
    autoDeleted = Number(deletion?.summary?.deleted || deletion?.deleted?.length || 0);
  }
  return { ok: true, success, failed, tallies, autoDeleted, autoDeletedEmails, results };
}

async function persistBusinessCodexAuthResult(accountId, record, workspaceId) {
  const validated = validateBusinessAuthRecord(record, workspaceId);
  if (validated.clientId !== OPENAI_CODEX_CLIENT_ID) throw new Error('Business access token 不是 Codex OAuth 客户端签发');
  await accountRepository.updateById(accountId, latest => {
    const existing = Array.isArray(latest.business_workspace_credentials)
      ? latest.business_workspace_credentials.filter(item => String(item?.workspaceId || '') !== workspaceId) : [];
    existing.push({ workspaceId, status: 'rt_ready', refreshToken: validated.refreshToken, accessToken: validated.accessToken, idToken: String(record.id_token || '').trim(), accountId: validated.accountId, expiresAt: validated.expiresAt, error: '' });
    return {
      business_workspace_id: workspaceId, business_join_status: 'rt_ready', business_join_error: '',
      business_openai_rt: validated.refreshToken, business_openai_access_token: validated.accessToken,
      business_openai_id_token: String(record.id_token || '').trim(), business_openai_account_id: validated.accountId,
      business_openai_token_expires_at: validated.expiresAt, business_workspace_credentials: existing,
    };
  });
  return validated;
}

async function runAllWorkspaceCodexAuthForAccount(account, { onLog, onPhase, ...network } = {}) {
  const issue = protocolLoginCredentialIssue(account);
  if (issue) throw new Error(issue);
  let phase = 'codex';
  const flow = new OpenAIJsonAuthFlow(account, {
    send(event, data) { if (event === 'log') onLog?.({ ...data, phase }); },
  }, {
    phoneMode: 'sms', reuseStoredSession: false,
    humanPacingEnabled: false, ...accountRequestNetwork(account, network),
  });
  return runAllWorkspaceCodexAuth({
    flow,
    onPhase: value => { phase = value; onPhase?.(value); },
    persistPersonal: record => persistOpenAIAuthResult(account.id, record, 'sms'),
    persistBusiness: (record, workspaceId) => persistBusinessCodexAuthResult(account.id, record, workspaceId),
    persistCookies: storage => accountRepository.updateById(account.id, { storage_state_json: storage }),
  });
}

async function runBusinessCodexAuthForAccount(account, {
  workspaceId,
  force = false,
  onLog,
  proxyPool,
  directWhenProxyPoolEmpty = false,
} = {}) {
  const target = String(workspaceId || '').trim();
  const priorStatus = String(account?.business_join_status || 'none');
  const hasPriorValid = Boolean(String(account?.business_openai_rt || '').trim()
    && String(account?.business_openai_access_token || '').trim()
    && String(account?.business_openai_account_id || '') === target);
  if (!force && hasPriorValid) return { ok: true, skipped: true, id: account.id, email: account.email, workspaceId: target, reason: '已有相同 workspace 的 Business RT' };
  const fail = async (error, logs = []) => {
    const message = String(error instanceof Error ? error.message : error || 'Business 转 RT 失败').slice(0, 500);
    await accountRepository.updateById(account.id, latest => {
      const businessStatus = error?.code === 'BUSINESS_NOT_MEMBER' && priorStatus === 'requested' ? 'requested' : 'failed';
      const existing = Array.isArray(latest.business_workspace_credentials)
        ? latest.business_workspace_credentials.filter(item => String(item?.workspaceId || '') !== target) : [];
      if (target) existing.push({ workspaceId: target, status: businessStatus, refreshToken: '', accessToken: '', idToken: '', accountId: '', expiresAt: 0, error: message });
      return {
        business_workspace_id: target || latest.business_workspace_id,
        business_join_error: message,
        business_join_status: businessStatus,
        business_workspace_credentials: existing,
      };
    }).catch(() => {});
    return { ok: false, skipped: false, id: account.id, email: account.email, workspaceId: target, code: error?.code || '', error: message, preservedPriorCredentials: hasPriorValid, logs };
  };
  if (!target) return fail(new Error('Business workspace ID 不能为空'));
  let storageState;
  try { storageState = JSON.parse(String(account?.storage_state_json || '')); } catch { storageState = null; }
  const logs = [];
  const emit = (data = {}) => {
    const entry = { time: data?.time || nowIso(), level: data?.level || 'info', msg: String(data?.msg || data?.error || '') };
    logs.push(entry);
    if (typeof onLog === 'function') onLog({ email: account.email, id: account.id, workspaceId: target, ...entry });
  };
  emit({ msg: `Business 转 RT 开始：workspace=${target}` });
  const sse = { send(event, data) { if (event === 'log') emit(data); } };
  const flow = new OpenAIJsonAuthFlow(account, sse, {
      phoneMode: 'sms', reuseStoredSession: true, requireStoredSession: true,
      forbidPhoneChallenge: true, workspaceSelection: { mode: 'id', workspaceId: target },
      humanPacingEnabled: false,
      ...accountRequestNetwork(account, { proxyPool, directWhenProxyPoolEmpty }),
  });
  try {
    const record = await flow.run();
    const validated = await persistBusinessCodexAuthResult(account.id, record, target);
    return { ok: true, skipped: false, id: account.id, email: account.email, workspaceId: target, businessOpenAiAccountId: validated.accountId, businessOpenAiTokenExpiresAt: validated.expiresAt, logs };
  } catch (error) { emit({ level: 'error', msg: error instanceof Error ? error.message : String(error) }); return fail(error, logs); }
  finally { await flow.dispose().catch(() => {}); }
}

async function runCodexAuthForAccount(account, {
  phoneMode = 'sms',
  force = false,
  reuseStoredSession = true,
  forbidPhoneChallenge = false,
  onLog,
  proxyPool,
  directWhenProxyPoolEmpty = false,
} = {}) {
  const mode = normalizePhoneMode(phoneMode);
  const startedAt = Date.now();
  const emitLog = (entry) => {
    if (typeof onLog === 'function') onLog(entry);
  };
  structuredLog('codex_auth_start', {
    email: account.email,
    mode,
    stage: inferOpenAiStage(account),
    force: Boolean(force),
    activationId: account.sms_activation_id || undefined,
  });

  const finish = (result) => {
    structuredLog(result?.ok ? 'codex_auth_done' : 'codex_auth_failed', {
      email: account.email,
      mode,
      ok: Boolean(result?.ok),
      skipped: Boolean(result?.skipped),
      stage: result?.stage || inferOpenAiStage(account),
      durationMs: durationMs(startedAt),
      error: result?.ok ? undefined : (result?.error || undefined),
      activationId: account.sms_activation_id || undefined,
    });
    return result;
  };

  const credentialIssue = protocolLoginCredentialIssue(account);
  if (credentialIssue) {
    return finish({
      ok: false,
      skipped: false,
      email: account.email,
      mode,
      stage: OPENAI_STAGES.FAILED,
      error: credentialIssue,
      missingLoginCredentials: true,
      logs: [],
    });
  }

  if (!force) {
    if (mode === 'agent' && agentIdentityRecordFromAccount(account)) {
      const identity = agentIdentityRecordFromAccount(account);
      return finish({
        ok: true,
        skipped: true,
        email: account.email,
        mode,
        reason: '已有 Agent Identity',
        kind: 'agent',
        stage: OPENAI_STAGES.AGENT_READY,
        json: buildSub2ApiJson(identity, getSub2ApiSettings()),
        logs: [],
      });
    }
    if (mode === 'sms' && account.openai_rt) {
      try {
        const logs = [];
        const record = await refreshOpenAIRecordFromRt(account, (msg, level = 'info') => {
          const entry = { time: nowIso(), level, msg };
          logs.push(entry);
          emitLog({ email: account.email, ...entry });
        });
        await persistOpenAIAuthResult(account.id, record, mode);
        const exportRecord = await resolveSub2ApiExportRecord(record, { phoneMode: mode });
        return finish({
          ok: true,
          skipped: true,
          email: account.email,
          mode,
          reason: '已有 OpenAI RT',
          kind: 'rt',
          stage: OPENAI_STAGES.RT_READY,
          hasRefreshToken: true,
          json: buildSub2ApiJson(exportRecord, getSub2ApiSettings()),
          logs,
        });
      } catch (error) {
        // 已有 RT 但刷新失败时，仍继续走登录接码流程
      }
    }
  }

  const logs = [];
  const sse = {
    send(event, data) {
      if (event !== 'log') return;
      const entry = {
        time: data?.time || nowIso(),
        level: data?.level || 'info',
        msg: data?.msg || data?.error || '',
      };
      logs.push(entry);
      emitLog({ email: account.email, ...entry });
    },
  };

  const flow = new OpenAIJsonAuthFlow(account, sse, {
      phoneMode: mode,
      reuseStoredSession,
      forbidPhoneChallenge,
      ...accountRequestNetwork(account, { proxyPool, directWhenProxyPoolEmpty }),
  });
  try {
    const record = await flow.run();
    await persistOpenAIAuthResult(account.id, record, mode);

    if (mode === 'agent' && isAgentIdentityRecord(record)) {
      const json = buildSub2ApiJson(record, getSub2ApiSettings());
      return finish({
        ok: true,
        skipped: false,
        email: account.email,
        mode,
        kind: 'agent',
        stage: OPENAI_STAGES.AGENT_READY,
        agentRuntimeId: record.agent_runtime_id,
        json,
        logs,
      });
    }

    const exportRecord = await resolveSub2ApiExportRecord(record, { phoneMode: mode });
    const json = buildSub2ApiJson(exportRecord, getSub2ApiSettings());
    return finish({
      ok: true,
      skipped: false,
      email: account.email,
      mode,
      kind: isAgentIdentityRecord(exportRecord) ? 'agent' : 'rt',
      stage: isAgentIdentityRecord(exportRecord) ? OPENAI_STAGES.AGENT_READY : OPENAI_STAGES.RT_READY,
      hasRefreshToken: Boolean(record.refresh_token),
      json,
      logs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistOpenAiStage(account.id, OPENAI_STAGES.FAILED, {
      status: '流程失败',
      lastError: message,
    }).catch(() => {});
    return finish({
      ok: false,
      skipped: false,
      email: account.email,
      mode,
      stage: OPENAI_STAGES.FAILED,
      error: message,
      logs,
    });
  } finally {
    await flow.dispose().catch(() => {});
  }
}


async function runCodexAuthForAccounts(accounts, {
  phoneMode = 'sms',
  force = false,
  reuseStoredSession = true,
  forbidPhoneChallenge = false,
  exportJson = false,
  exportZip,
  onAccountStart,
  onAccountLog,
  onAccountDone,
  concurrency: requestedConcurrency,
  proxyPool,
  directWhenProxyPoolEmpty = false,
} = {}) {
  const mode = normalizePhoneMode(phoneMode);
  const shouldExport = exportZip == null ? exportJson !== false : Boolean(exportZip);
  const concurrency = getRegisterBatchConcurrency(requestedConcurrency);
  const results = await mapWithConcurrency(accounts, concurrency, async account => {
    if (typeof onAccountStart === 'function') {
      onAccountStart({
        email: account.email,
        id: account.id,
        stage: inferOpenAiStage(account),
      });
    }
    const result = await runCodexAuthForAccount(account, {
      phoneMode: mode,
      force,
      reuseStoredSession,
      forbidPhoneChallenge,
      onLog: onAccountLog,
      proxyPool,
      directWhenProxyPoolEmpty,
    });
    if (typeof onAccountDone === 'function') onAccountDone(result);
    return result;
  });

  const success = results.filter(item => item.ok && !item.skipped).length;
  const skipped = results.filter(item => item.ok && item.skipped).length;
  const failed = results.filter(item => !item.ok).length;
  const payload = { ok: true, phoneMode: mode, success, skipped, failed, concurrency, results };

  if (shouldExport) {
    const records = [];
    for (const item of results) {
      if (!item.ok || !item.json?.accounts?.[0]) continue;
      records.push(item.json.accounts[0]);
    }
    if (records.length) {
      const exportedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const json = {
        type: 'sub2api-data',
        version: 1,
        exported_at: exportedAt,
        proxies: [],
        accounts: records,
      };
      const fileName = await buildExportFileName(`sub2api-${mode === 'agent' ? 'agent' : 'rt'}`, 'json');
      payload.json = json;
      payload.jsonFileName = fileName;
      payload.exported = records.length;
      payload.sub2api = await sub2ApiPushService.enqueue(records);
    }
  }

  return payload;
}

function normalizeOpenAIRecordFromRefreshPayload(email, payload, fallbackRt) {
  const accessToken = String(payload.access_token || '');
  if (!accessToken) throw new Error('刷新 RT 后缺少 access_token');
  const accessClaims = decodeJwtPayload(accessToken);
  const accessAuth = getNestedRecord(accessClaims, 'https://api.openai.com/auth');
  const accountId = firstNonEmpty(accessAuth.chatgpt_account_id, accessAuth.account_id);
  const exp = Number(accessClaims.exp || 0) || Math.floor(Date.now() / 1000) + Number(payload.expires_in || 0);
  const refreshToken = String(payload.refresh_token || fallbackRt || '');
  if (!accountId) throw new Error(`access_token 中缺少 account_id: ${JSON.stringify(accessClaims)}`);
  return {
    access_token: accessToken,
    account_id: accountId,
    email,
    expired: exp ? new Date(exp * 1000).toISOString() : '',
    id_token: String(payload.id_token || ''),
    last_refresh: nowIso(),
    plan_type: firstNonEmpty(accessAuth.chatgpt_plan_type),
    refresh_token: refreshToken,
    type: 'codex',
  };
}

// SSEChannel / mapWithConcurrency -> lib/sse.js

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
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
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
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
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
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
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
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
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
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
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
        streamSse.send('error', { error: error instanceof Error ? error.message : String(error) });
      } finally { clearInterval(streamPing); res.end(); }
      return;
    }
    res.json(finish(await run()));
  } catch(error){
    if (streamSse) {
      streamSse.send('error', { error: error instanceof Error ? error.message : String(error) });
      clearInterval(streamPing);
      try { res.end(); } catch {}
      return;
    }
    res.status(400).json({ok:false,error:error instanceof Error?error.message:String(error)});
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
        sse.send('error', { error: error instanceof Error ? error.message : String(error) });
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
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
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
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
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
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
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
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
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
async function clearAuthStateForFreshLogin(accountId, { status = '旧认证状态已清理' } = {}) {
  if (!accountId) return;
  await accountRepository.updateById(accountId, {
    session_access_token: '', session_json: '', storage_state_json: '',
    session_health: '', session_health_checked_at: '', session_health_detail: '',
    openai_rt: '', openai_access_token: '', openai_id_token: '', openai_account_id: '', openai_token_expires_at: 0,
    sub2api_pushed: false, sub2api_pushed_at: '', sub2api_push_source: '', sub2api_account_id: null,
    business_workspace_id: '', business_openai_rt: '', business_openai_access_token: '', business_openai_id_token: '',
    business_openai_account_id: '', business_openai_token_expires_at: 0, business_workspace_credentials: [],
    business_join_status: 'none', business_join_requested_at: '', business_join_error: '', business_join_requests: [],
    business_sub2api_pushed: false, business_sub2api_pushed_at: '', business_sub2api_push_source: '', business_sub2api_account_id: null,
    agent_runtime_id: '', agent_private_key: '', agent_account_id: '', agent_user_id: '', agent_plan_type: '', agent_is_fedramp: false,
    openai_stage: '', last_error: '', status,
  });
}


export async function startApplication() {
  const lifecycle = await startServer({
    app,
    port: PORT,
    host: process.env.HOST || '127.0.0.1',
    ready: Promise.all([runtimeReady, startHttpWorkers()]),
    beforeClose: async () => {
      shutdownState.value = true;
      closeHttpWorkers();
      await browserWorkerPool.close();
      await sub2ApiPushService.stop();
      await sqliteRuntime.accounts.flushWrites?.();
      try { sqliteRuntime.db.close(); } catch {}
    },
  }).catch(error => {
    closeHttpWorkers();
    try { sqliteRuntime.db.close(); } catch {}
    throw error;
  });
  sub2ApiPushService.start();
  console.log(`GPTAuthBridge: http://${process.env.HOST || '127.0.0.1'}:${PORT} · Browser storage · 凭据模式=${getAuthMode()}`);
  return lifecycle;
}
