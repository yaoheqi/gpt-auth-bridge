import { ProxyAgent, Socks5ProxyAgent, fetch as undiciFetch } from 'undici';
import { createProxyRoute } from './proxy-route.js';

export class ProxyConfigError extends Error {
  constructor(message, code = '') {
    super(message);
    this.name = 'ProxyConfigError';
    this.code = code;
  }
}

// No implicit local proxy is used. Deployments can opt in with OPENAI_PROXY_URL.
// These are live bindings because server.js loads its local .env after ESM
// imports have been evaluated.
const DEFAULT_FIXED_LOCAL_PROXY_URL = '';
const DEFAULT_BUILT_IN_PROXY_POOL = '';

function envHas(env, key) {
  return Object.prototype.hasOwnProperty.call(env || {}, key);
}

function resolveFixedLocalProxy(env = process.env) {
  return envHas(env, 'OPENAI_PROXY_URL')
    ? String(env.OPENAI_PROXY_URL || '').trim()
    : DEFAULT_FIXED_LOCAL_PROXY_URL;
}

export function resolveBuiltInProxyPool(env = process.env) {
  const configured = env?.OPENAI_BUILT_IN_PROXY_POOL;
  const pool = configured === undefined ? DEFAULT_BUILT_IN_PROXY_POOL : String(configured || '').trim();
  return containsPlaceholder(pool) ? '' : pool;
}

export let FIXED_LOCAL_PROXY_URL = resolveFixedLocalProxy(process.env);
export let BUILT_IN_PROXY_POOL = resolveBuiltInProxyPool(process.env);

/** Refresh values after the caller has loaded a dotenv file. */
export function configureProxyEnvironment(env = process.env) {
  FIXED_LOCAL_PROXY_URL = resolveFixedLocalProxy(env);
  BUILT_IN_PROXY_POOL = resolveBuiltInProxyPool(env);
  return { fixedProxyUrl: FIXED_LOCAL_PROXY_URL, builtInProxyPool: BUILT_IN_PROXY_POOL };
}

function containsPlaceholder(value) {
  return /(?:PROXY_USER_PLACEHOLDER|PROXY_PASSWORD_PLACEHOLDER)/i.test(String(value || ''));
}

function resolveDefaultPool(env) {
  const explicitPool = env?.APP_PROXY_POOL ?? env?.PROXY_POOL;
  if (explicitPool !== undefined) return String(explicitPool || '').trim();
  // The built-in pool is opt-in per request, never a default network route.
  return '';
}

export function resolveConfiguredProxyPool(env = process.env) {
  return resolveDefaultPool(env);
}

export function normalizeProxyUrl(value) {
  let text = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (!text) return '';
  if (!text.includes('://')) {
    const parts = text.split(':');
    if (parts.length === 4 && !text.includes('@')) {
      const [host, port, username, password] = parts;
      text = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
    } else if (text.includes('@')) {
      const [left, right] = text.split('@', 2);
      if (/^[^:]+:\d+$/.test(left) && right.includes(':')) {
        const [username, password] = right.split(':', 2);
        text = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${left}`;
      } else text = `http://${text}`;
    }
    else text = `http://${text}`;
  }
  const parsed = new URL(text);
  const hasExplicitPort = /:\d+(?:\/)?$/.test(text);
  if (!['http:', 'https:', 'socks4:', 'socks5:', 'socks5h:'].includes(parsed.protocol) || !parsed.hostname || (!parsed.port && !hasExplicitPort)) {
    throw new ProxyConfigError('代理格式无效', 'INVALID_PROXY');
  }
  return parsed.href;
}

export function parseProxyPool(value) {
  return String(value || '').split(/[\r\n;,]+/).map(item => item.trim()).filter(Boolean).map(normalizeProxyUrl);
}

function refreshRotatingProxySession(proxyUrl, { stickyMinutes = 30 } = {}) {
  try {
    const url = new URL(proxyUrl);
    const username = decodeURIComponent(url.username || '');
    if (!/-session-[A-Za-z0-9]+/i.test(username)) return proxyUrl;
    const session = Math.floor(10000000 + Math.random() * 90000000).toString();
    let next = username.replace(/-session-[A-Za-z0-9]+/i, `-session-${session}`);
    next = next.replace(/-sessTime-\d+/i, `-sessTime-${Math.max(5, Number(stickyMinutes) || 30)}`);
    url.username = next;
    return url.href;
  } catch { return proxyUrl; }
}

export function resolveSessionProxy({ pool, env = process.env, directWhenEmpty = false, refreshSession = true } = {}) {
  const configuredPool = pool !== undefined && pool !== null
    ? pool
    : resolveDefaultPool(env);
  const candidates = parseProxyPool(configuredPool);
  const fixedProxyUrl = env === process.env ? FIXED_LOCAL_PROXY_URL : resolveFixedLocalProxy(env);
  const fallbackProxyUrl = directWhenEmpty ? '' : FIXED_LOCAL_PROXY_URL;
  const effectiveFallbackProxyUrl = env === process.env ? fallbackProxyUrl : (directWhenEmpty ? '' : fixedProxyUrl);
  const proxyUrl = candidates.length
    ? (refreshSession
      ? refreshRotatingProxySession(candidates[Math.floor(Math.random() * candidates.length)], {
        stickyMinutes: env.APP_PROXY_STICKY_MINUTES || 30,
      })
      : candidates[0])
    : effectiveFallbackProxyUrl;
  return {
    proxyUrl,
    sessionId: '',
    mode: candidates.length ? 'pool' : (proxyUrl ? 'local' : 'direct'),
    label: proxyUrl ? maskProxyUrl(proxyUrl) : '直连',
  };
}

export function maskProxyUrl(value = FIXED_LOCAL_PROXY_URL) {
  try { const url = new URL(value); url.username = ''; url.password = ''; return url.href; } catch { return FIXED_LOCAL_PROXY_URL; }
}

function createProxyDispatcher(proxyUrl) {
  const url = new URL(proxyUrl);
  if (url.protocol === 'socks5:' || url.protocol === 'socks5h:') {
    // Undici sends hostnames to the SOCKS server. Its dedicated agent also
    // decodes URL credentials correctly, without forwarding HTTP proxy auth.
    url.protocol = 'socks5:';
    return new Socks5ProxyAgent(url);
  }
  return new ProxyAgent(proxyUrl);
}

/**
 * Create a fetch function that routes through HTTP(S) or SOCKS proxy.
 * When proxyUrl is empty, returns global fetch.
 */
export function createProxiedFetch(proxyUrl = '', { isolated: _isolated = false } = {}) {
  // An empty URL means direct egress; callers that need a pool resolve it first.
  const url = normalizeProxyUrl(proxyUrl) || FIXED_LOCAL_PROXY_URL;

  if (!url) {
    const direct = (input, init = {}) => undiciFetch(input, init);
    direct.proxyAgent = null;
    direct.dispatcher = null;
    direct.proxyUrl = '';
    direct.dispose = async () => {};
    direct.isolated = true;
    return direct;
  }

  let dispatcher;
  let routePromise;
  let disposed = false;
  try {
    if (!process.env.PROXY_CHAIN_URL) dispatcher = createProxyDispatcher(url);
  } catch (error) {
    if (error instanceof ProxyConfigError) throw error;
    throw new ProxyConfigError(
      `创建代理 Agent 失败: ${error instanceof Error ? error.message : String(error)}`,
      'AGENT_ERROR',
    );
  }

  const proxied = async (input, init = {}) => {
    if (disposed) throw new Error('Proxy fetch disposed');
    if (!dispatcher) {
      routePromise ||= createProxyRoute(url);
      const route = await routePromise;
      if (disposed) { await route.close(); throw new Error('Proxy fetch disposed'); }
      dispatcher ||= createProxyDispatcher(route.url);
    }
    return undiciFetch(input, { ...init, dispatcher });
  };
  Object.defineProperty(proxied, 'proxyAgent', { get: () => dispatcher });
  Object.defineProperty(proxied, 'dispatcher', { get: () => dispatcher });
  proxied.proxyUrl = url;
  proxied.dispose = async () => {
    disposed = true;
    await routePromise?.then(route => route.close()).catch(() => {});
    await dispatcher?.close?.();
  };
  proxied.isolated = true;
  return proxied;
}

export async function detectFixedProxyCountryCode({ timeoutMs = 8000, fetchImpl = undiciFetch, proxyUrl = FIXED_LOCAL_PROXY_URL } = {}) {
  let dispatcher;
  let route;
  try {
    const init = {
      signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 8000)),
      headers: { accept: 'text/plain,*/*' },
    };
    if (proxyUrl) {
      route = await createProxyRoute(proxyUrl);
      dispatcher = createProxyDispatcher(route.url);
      init.dispatcher = dispatcher;
    }
    const response = await fetchImpl('https://www.cloudflare.com/cdn-cgi/trace', init);
    const text = await response.text();
    const loc = String(text.match(/(?:^|\n)loc=([A-Z]{2})(?:\n|$)/i)?.[1] || '').toUpperCase();
    const ip = String(text.match(/(?:^|\n)ip=([^\n]+)(?:\n|$)/i)?.[1] || '').trim();
    if (!response.ok || !loc) throw new ProxyConfigError(`出口地区探测失败: HTTP ${response.status}`, 'EGRESS_REGION_DETECT_FAILED');
    return { ok: true, countryCode: loc, ip, source: 'cloudflare-trace', proxyUrl };
  } finally {
    try { await dispatcher?.close?.(); } catch { /* ignore */ }
    await route?.close();
  }
}

/**
 * Detect Cloudflare / edge blocks commonly returned for burned proxy exits.
 */
export function looksLikeCloudflareBlock({ status, body = '', headers } = {}) {
  const code = Number(status) || 0;
  if (code !== 403 && code !== 503 && code !== 429) return false;
  const server = String(headers?.get?.('server') || headers?.server || '').toLowerCase();
  const cfRay = String(headers?.get?.('cf-ray') || headers?.['cf-ray'] || '').trim();
  const text = String(body || '');
  if (cfRay || server.includes('cloudflare')) return true;
  return /attention required|just a moment|cf-ray|cloudflare|sorry, you have been blocked/i.test(text);
}

/** A 403 on the initial auth/login handshake identifies the current egress, before account auth. */
export function isInitialAuthEgressBlock(input = {}) {
  return Number(input.status) === 403 || looksLikeCloudflareBlock(input);
}
