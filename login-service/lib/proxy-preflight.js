import { CookieJar } from 'tough-cookie';
import makeFetchCookie from 'fetch-cookie';
import { createCurlCffiFetch } from './curl-cffi-fetch.js';
import { AUTH_BASE_URL } from './openai-auth-urls.js';
import { buildOpenAIAuthorizationUrl, generateOpenAIPkce } from './openai-oauth.js';
import { openOAuthPage } from './oauth-navigation.js';
import { maskProxyUrl } from './proxy-config.js';
import { sanitizeLogMessage } from './log-sanitize.js';
import { requestSignal } from '../src/services/request-scope.js';
import { measureStage } from './stage-timing.js';

export function preflightProxyEgress(proxyUrl, options = {}) {
  return measureStage('proxy_preflight', () => probeProxyEgress(proxyUrl, options));
}

async function probeProxyEgress(proxyUrl, {
  direct = !proxyUrl,
  headers,
  timeoutMs = process.env.APP_PROXY_PREFLIGHT_TIMEOUT_MS || 15000,
  signal = requestSignal(),
  createFetch = createCurlCffiFetch,
} = {}) {
  const budget = Math.max(1000, Math.min(60000, Number(timeoutMs) || 15000));
  const deadline = AbortSignal.timeout(budget);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const started = Date.now();
  let fetcher;
  try {
    combined.throwIfAborted();
    // Use the account's exact route, but no account hints, cookies or credentials.
    fetcher = createFetch(proxyUrl, { direct });
    const fetch = makeFetchCookie((url, init) => {
      combined.throwIfAborted();
      if (new URL(url).origin !== AUTH_BASE_URL) throw new Error('OAuth 检测跳转到非预期域名');
      return fetcher(url, {
        ...init, signal: combined,
        timeout: Math.max(1, Math.ceil((budget - (Date.now() - started)) / 1000)),
      });
    }, new CookieJar());
    const startUrl = buildOpenAIAuthorizationUrl({ ...generateOpenAIPkce(), prompt: 'login' });
    const result = await openOAuthPage(fetch, startUrl, { headers });
    const landing = new URL(result.url);
    if (landing.origin !== AUTH_BASE_URL || !/^\/(?:log-in|login|sign-in)(?:\/|$)/.test(landing.pathname)) {
      throw new Error(`OAuth 检测未到达登录页: ${landing.pathname}`);
    }
    return { status: result.response.status, latencyMs: Date.now() - started };
  } catch (cause) {
    if (signal?.aborted) throw signal.reason;
    const label = proxyUrl ? maskProxyUrl(proxyUrl) : '直连';
    const detail = deadline.aborted ? `超过 ${budget / 1000} 秒未完成` : sanitizeLogMessage(cause.message || String(cause));
    const error = new Error(`代理连通性检测失败（${label}）：${detail}；未开始账号登录`, { cause });
    error.code = 'PROXY_PREFLIGHT_FAILED';
    error.proxyEgress = true;
    error.status = Number(cause.status) || 0;
    throw error;
  } finally {
    await fetcher?.dispose?.();
  }
}
