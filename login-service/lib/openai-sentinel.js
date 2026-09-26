import { requestMap, requestSignal } from '../src/services/request-scope.js';
import { randomUUID } from 'crypto';
import { solveOpenAITurnstileToken } from './openai-turnstile.js';
import { createSemaphore } from './async-semaphore.js';
import { configuredTaskConcurrency, MAX_OAUTH_BATCH_CONCURRENCY } from './batch-concurrency.js';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { browserWorkerPool } from './browser-worker-pool.js';
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
  return configuredTaskConcurrency(env);
}

export function createBrowserSentinelLimiter(concurrency = getBrowserSentinelConcurrency()) {
  return createSemaphore(concurrency, { fallback: configuredTaskConcurrency(), max: MAX_OAUTH_BATCH_CONCURRENCY });
}

export const browserSentinelStats = () => browserWorkerPool.stats();

export async function solveTurnstileViaBrowserSentinel(deviceID, flow, {
  proxyUrl = '', userAgent = '', repoRoot, defaultUserAgent, authBaseUrl = 'https://auth.openai.com',
} = {}) {
  try {
    const parsed = await browserWorkerPool.run({
      proxyUrl: String(proxyUrl || '').trim(),
      userAgent: normalizeBrowserUserAgent(userAgent, defaultUserAgent),
      authBaseUrl: String(authBaseUrl || 'https://auth.openai.com').trim(),
      deadlineSeconds: 75,
    }, { root: repoRoot, signal: requestSignal() });
    const raw = String(parsed.sentinel_token || '').trim();
    if (!raw) throw new Error('浏览器 Sentinel 未返回 token');
    const token = JSON.parse(raw);
    return JSON.stringify({
      p: token.p || null, t: token.t || null, c: token.c || null,
      id: deviceID || token.id || parsed.oai_did || '',
      flow: flow || token.flow || 'authorize_continue',
    });
  } catch (error) {
    if (requestSignal()?.aborted) throw requestSignal().reason;
    throw new Error(`浏览器 Sentinel 回退失败: ${browserFailureSummary(error.message || String(error))}`);
  }
}

function cacheKey(deviceID, flow, proxyUrl) {
  return `${String(deviceID || '')}|${String(flow || '')}|${String(proxyUrl || '')}`;
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
} = {}) {
  return async function fetchOpenAISentinelToken(fetcher, deviceID, flow, {
    fingerprint = defaultFingerprint,
    proxyUrl = '',
  } = {}) {
    const key = cacheKey(deviceID, flow, proxyUrl);
    const cached = sentinelTokenCache.get(key);
    if (cached && cached.expiresAt > Date.now() && cached.token) {
      return cached.token;
    }

    if (typeof ensureYesCaptchaSettings === 'function') {
      await ensureYesCaptchaSettings();
    }
    const fp = fingerprint || defaultFingerprint;
    const requirementSeed = `${Math.random()}`;
    const reqToken = `gAAAAAC${await generateSentinelAnswer(requirementSeed, '0', fp, defaultUserAgent)}`;
    const response = await fetcher('https://sentinel.openai.com/backend-api/sentinel/req', {
      method: 'POST',
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
    });
    if (!response.ok) {
      throw new Error(`请求 sentinel requirements 失败: ${response.status} body=${await response.text()}`);
    }
    const requirements = await response.json();
    let turnstileToken = null;
    if (requirements.turnstile?.dx) {
      const settings = typeof getYesCaptchaSettings === 'function' ? getYesCaptchaSettings() : {};
      const errors = [];
      if (settings.apiKey && settings.websiteKey) {
        try {
          turnstileToken = await solveOpenAITurnstileToken(settings);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      } else {
        errors.push('YesCaptcha 未完整配置（需要 API Key + Turnstile sitekey）');
      }
      if (!turnstileToken && settings.browserFallback) {
        try {
          const browserToken = await solveTurnstileViaBrowserSentinel(deviceID, flow, {
            proxyUrl,
            userAgent: fp?.userAgent || defaultUserAgent,
            repoRoot,
            defaultUserAgent,
            authBaseUrl: settings.websiteUrl || 'https://auth.openai.com',
          });
          sentinelTokenCache.set(key, { token: browserToken, expiresAt: Date.now() + cacheTtlMs });
          return browserToken;
        } catch (error) {
          errors.unshift(`浏览器回退失败: ${browserFailureSummary(error instanceof Error ? error.message : String(error))}`);
        }
      }
      if (!turnstileToken) {
        throw new Error(
          `OpenAI 登录触发 Turnstile，自动求解失败：${errors.join(' | ')}。请参考 grok 项目配置 YESCAPTCHA_API_KEY / OPENAI_TURNSTILE_SITEKEY，或启用浏览器 Sentinel 回退`,
        );
      }
    }
    const proof = requirements.proofofwork?.required && requirements.proofofwork.seed && requirements.proofofwork.difficulty
      ? `gAAAAAB${await generateSentinelAnswer(requirements.proofofwork.seed, requirements.proofofwork.difficulty, fp, defaultUserAgent)}`
      : null;
    const token = JSON.stringify({
      p: proof,
      t: turnstileToken,
      c: requirements.token,
      id: deviceID,
      flow,
    });
    sentinelTokenCache.set(key, { token, expiresAt: Date.now() + cacheTtlMs });
    return token;
  };
}

export function clearSentinelTokenCache() {
  sentinelTokenCache.clear();
}
