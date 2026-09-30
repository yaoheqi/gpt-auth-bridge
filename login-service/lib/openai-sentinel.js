import { requestMap, requestSignal } from '../src/services/request-scope.js';
import { randomUUID } from 'crypto';
import { solveOpenAITurnstileToken } from './openai-turnstile.js';
import { createSemaphore } from './async-semaphore.js';
import { configuredBrowserConcurrency, MAX_OAUTH_BATCH_CONCURRENCY } from './batch-concurrency.js';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { browserWorkerPool } from './browser-worker-pool.js';
import { validationDeadline } from './validation-deadline.js';
import { validationError, validationFailureFields } from './validation-error.js';
import { untilAborted } from './execution-limits.js';
export { getPythonCandidates } from './browser-worker-pool.js';

const DEFAULT_CACHE_TTL_MS = Math.max(5_000, Number(process.env.SENTINEL_TOKEN_CACHE_TTL_MS || 45_000) || 45_000);
const sentinelTokenCache = requestMap('sentinelTokens');

function performanceNow() {
  return Number(process.hrtime.bigint() / BigInt(1_000_000));
}

function base64Json(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function randomPick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function sentinelHashHex(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 2246822507) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 3266489909) >>> 0;
  hash ^= hash >>> 16;
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function collectSentinelFingerprintData(sid, fingerprint, defaultUserAgent) {
  const fp = fingerprint || {};
  const ua = fp.userAgent || defaultUserAgent;
  return [
    (fp.screenWidth || 0) + (fp.screenHeight || 0),
    new Date().toString(),
    fp.jsHeapSizeLimit || 4294967296,
    Math.random(),
    ua,
    'https://sentinel.openai.com/sentinel/20260219f9f6/sdk.js',
    '20260219f9f6',
    (fp.languages && fp.languages[0]) || 'en-US',
    Array.isArray(fp.languages) ? fp.languages.join(',') : 'en-US,en',
    Math.random(),
    randomPick([
      `userAgent−${ua}`,
      `language−${(fp.languages && fp.languages[0]) || 'en-US'}`,
      `hardwareConcurrency−${fp.hardwareConcurrency || 8}`,
    ]),
    'location',
    randomPick(['window', 'self', 'document', 'navigator', 'location', 'screen', 'history']),
    performanceNow(),
    sid,
    'sv',
    fp.hardwareConcurrency || 8,
    Date.now(),
    0,
    1,
    1,
    0,
    0,
    0,
    1,
  ];
}

export async function generateSentinelAnswer(seed, difficulty, fingerprint, defaultUserAgent, { signal = requestSignal() } = {}) {
  signal?.throwIfAborted();
  const start = performanceNow();
  const sid = randomUUID();
  const data = collectSentinelFingerprintData(sid, fingerprint, defaultUserAgent);
  for (let attempt = 0; attempt < 500000; attempt += 1) {
    data[3] = attempt;
    data[9] = Math.round(performanceNow() - start);
    const encoded = base64Json(data);
    const digest = sentinelHashHex(seed + encoded);
    if (digest.substring(0, difficulty.length) <= difficulty) {
      return `${encoded}~S`;
    }
    if ((attempt + 1) % 256 === 0) {
      // A resolved Promise only yields to microtasks, starving HTTP/SSE and cancellation.
      await yieldToIO(undefined, { signal });
      signal?.throwIfAborted();
    }
  }
  return `wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D${base64Json('max attempts exceeded')}`;
}

export function normalizeBrowserUserAgent(userAgent, defaultUserAgent) {
  return String(userAgent || defaultUserAgent || '').trim();
}

export function getBrowserSentinelConcurrency(env = process.env) {
  return configuredBrowserConcurrency(env);
}

export function createBrowserSentinelLimiter(concurrency = getBrowserSentinelConcurrency()) {
  return createSemaphore(concurrency, { fallback: configuredBrowserConcurrency(), max: MAX_OAUTH_BATCH_CONCURRENCY });
}

export const browserSentinelStats = () => browserWorkerPool.stats();

export async function solveTurnstileViaBrowserSentinel(deviceID, flow, {
  proxyUrl = '', userAgent = '', repoRoot, defaultUserAgent, authBaseUrl = 'https://auth.openai.com',
  signal = requestSignal(), timeoutMs = 75000, pool = browserWorkerPool,
} = {}) {
  if (!deviceID || !['authorize_continue', 'password_verify'].includes(flow)) {
    throw validationError('VALIDATION_CONTEXT_MISMATCH', { stage: 'browser_context' });
  }
  const budget = validationDeadline({ signal, timeoutMs, stage: 'browser_queue' });
  try {
    const parsed = await pool.run({
      proxyUrl: String(proxyUrl || '').trim(),
      userAgent: normalizeBrowserUserAgent(userAgent, defaultUserAgent),
      authBaseUrl: String(authBaseUrl || 'https://auth.openai.com').trim(),
      deviceID, flow,
      deadlineSeconds: budget.remaining() / 1000,
    }, { root: repoRoot, signal: budget.signal, remainingMs: () => budget.remaining() });
    budget.remaining();
    const raw = String(parsed.sentinel_token || '').trim();
    let token;
    try { token = JSON.parse(raw); } catch { throw validationError('BROWSER_PROTOCOL_ERROR', { stage: 'browser_verify' }); }
    if (!token || typeof token !== 'object' || !token.c || token.id !== deviceID || token.flow !== flow || parsed.oai_did !== deviceID) {
      throw validationError('VALIDATION_CONTEXT_MISMATCH', { stage: 'browser_verify' });
    }
    return raw; // Preserve the SDK result; never relabel another device or flow.
  } catch (error) {
    budget.signal.throwIfAborted();
    if (validationFailureFields(error).validationFailure) throw error;
    throw validationError('VALIDATION_CHALLENGE_FAILED', { stage: 'browser_verify' }, error);
  } finally { budget.close(); }
}

function cacheKey(deviceID, flow, proxyUrl, fingerprint) {
  return JSON.stringify([deviceID, flow, proxyUrl, fingerprint]);
}

export function browserFailureSummary(value) {
  const lines = String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const cause = lines.findLast(line => /^(?:[\w.]*Error|[\w.]*Exception):/.test(line)) || lines.at(-1) || 'unknown';
  return cause.replace(/(?:socks5h?|https?):\/\/[^\s/@]+(?::[^\s/@]*)?@/g, '[proxy]@').slice(0, 240);
}

/**
 * Create a Sentinel token fetcher with optional short-lived cache (same device/flow/proxy).
 */
export function createOpenAISentinelTokenFetcher({
  ensureYesCaptchaSettings,
  getYesCaptchaSettings,
  defaultFingerprint,
  defaultUserAgent,
  repoRoot,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  solveBrowserSentinel = solveTurnstileViaBrowserSentinel,
  solveProvider = solveOpenAITurnstileToken,
} = {}) {
  return async function fetchOpenAISentinelToken(fetcher, deviceID, flow, {
    fingerprint = defaultFingerprint,
    proxyUrl = '',
    signal = requestSignal(), timeoutMs = 120000,
  } = {}) {
    const budget = validationDeadline({ signal, timeoutMs });
    let stage = 'requirements';
    try {
      const fp = fingerprint || defaultFingerprint;
      const key = cacheKey(deviceID, flow, proxyUrl, fp);
      const cached = sentinelTokenCache.get(key);
      if (cached && cached.expiresAt > Date.now() && cached.token) {
        return cached.token;
      }

      if (typeof ensureYesCaptchaSettings === 'function') {
        await untilAborted(Promise.resolve().then(() => ensureYesCaptchaSettings()), budget.signal);
      }
      const requirementSeed = `${Math.random()}`;
      const reqToken = `gAAAAAC${await generateSentinelAnswer(requirementSeed, '0', fp, defaultUserAgent, { signal: budget.signal })}`;
      budget.remaining();
      const response = await untilAborted(fetcher('https://sentinel.openai.com/backend-api/sentinel/req', {
        method: 'POST',
        signal: budget.signal,
        headers: {
          'content-type': 'application/json',
          'user-agent': fp?.userAgent || defaultUserAgent,
          origin: 'https://sentinel.openai.com',
          referer: 'https://sentinel.openai.com/backend-api/sentinel/frame.html?sv=20260219f9f6',
        },
        body: JSON.stringify({
          p: reqToken,
          id: deviceID,
          flow,
        }),
      }), budget.signal);
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw validationError('VALIDATION_CHALLENGE_FAILED', { stage: 'requirements' });
      }
      const requirements = await untilAborted(response.json(), budget.signal);
      if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)) {
        throw validationError('VALIDATION_CHALLENGE_FAILED', { stage });
      }
      stage = 'sentinel';
      let turnstileToken = null;
      if (requirements.turnstile?.dx) {
        const settings = typeof getYesCaptchaSettings === 'function' ? getYesCaptchaSettings() : {};
        const errors = [];
        let failure;
        if (settings.apiKey && settings.websiteKey) {
          try {
            // Reserve half the remaining budget for the configured browser fallback.
            const providerBudget = validationDeadline({ signal: budget.signal, stage: 'provider',
              timeoutMs: Math.min(Number(settings.timeoutMs) || 120000, budget.remaining() / (settings.browserFallback ? 2 : 1)) });
            try {
              turnstileToken = await untilAborted(solveProvider(settings, null, {
                signal: providerBudget.signal, timeoutMs: providerBudget.remaining(),
              }), providerBudget.signal);
            } finally { providerBudget.close(); }
          } catch (error) {
            budget.signal.throwIfAborted();
            failure = validationFailureFields(error).validationFailure ? error : validationError('VALIDATION_PROVIDER_FAILED', { stage: 'provider' }, error);
            errors.push(failure.message);
          }
        } else {
          errors.push('YesCaptcha 未完整配置（需要 API Key + Turnstile sitekey）');
        }
        if (!turnstileToken && settings.browserFallback) {
          try {
            const browserToken = await solveBrowserSentinel(deviceID, flow, {
              proxyUrl,
              userAgent: fp?.userAgent || defaultUserAgent,
              repoRoot,
              defaultUserAgent,
              authBaseUrl: settings.websiteUrl || 'https://auth.openai.com',
              signal: budget.signal, timeoutMs: budget.remaining(),
            });
            budget.remaining();
            sentinelTokenCache.set(key, { token: browserToken, expiresAt: Date.now() + cacheTtlMs });
            return browserToken;
          } catch (error) {
            budget.signal.throwIfAborted();
            failure = validationFailureFields(error).validationFailure ? error : validationError('VALIDATION_CHALLENGE_FAILED', { stage: 'browser_verify' }, error);
            errors.unshift(failure.message);
          }
        }
        if (!turnstileToken) {
          const error = failure || validationError('VALIDATION_CONFIG_MISSING', { stage: 'sentinel' });
          error.message = `OpenAI 登录触发 Turnstile，自动求解失败：${errors.join(' | ')}。${settings.browserFallback
              ? '浏览器 Sentinel 回退已启用但执行失败，请检查浏览器运行环境及退出原因；也可配置 YESCAPTCHA_API_KEY / OPENAI_TURNSTILE_SITEKEY 作为备用通道'
              : '请启用浏览器 Sentinel 回退，或配置 YESCAPTCHA_API_KEY / OPENAI_TURNSTILE_SITEKEY'}`;
          throw error;
        }
      }
      const proof = requirements.proofofwork?.required && requirements.proofofwork.seed && requirements.proofofwork.difficulty
        ? `gAAAAAB${await generateSentinelAnswer(requirements.proofofwork.seed, requirements.proofofwork.difficulty, fp, defaultUserAgent, { signal: budget.signal })}`
        : null;
      const token = JSON.stringify({
        p: proof,
        t: turnstileToken,
        c: requirements.token,
        id: deviceID,
        flow,
      });
      budget.remaining();
      sentinelTokenCache.set(key, { token, expiresAt: Date.now() + cacheTtlMs });
      return token;
    } catch (error) {
      budget.signal.throwIfAborted();
      if (validationFailureFields(error).validationFailure) throw error;
      throw validationError('VALIDATION_CHALLENGE_FAILED', { stage }, error);
    }
    finally { budget.close(); }
  };
}

export function clearSentinelTokenCache() {
  sentinelTokenCache.clear();
}
