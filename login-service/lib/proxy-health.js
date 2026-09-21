import { requestMap } from '../src/services/request-scope.js';
import { sanitizeLogMessage } from './log-sanitize.js';
// In-process proxy health tracking. State is intentionally ephemeral: proxy
// credentials and vendor sessions must not be persisted by the service.
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

function keyOf(proxyUrl) {
  return String(proxyUrl || '').trim();
}

function stateFor(map, proxyUrl) {
  const key = keyOf(proxyUrl);
  if (!map.has(key)) map.set(key, { failures: 0, successes: 0, consecutiveFailures: 0, cooldownUntil: 0, lastError: '', lastLatencyMs: 0 });
  return map.get(key);
}

export class ProxyHealthRegistry {
  constructor({ cooldownMs = DEFAULT_COOLDOWN_MS, now = () => Date.now() } = {}) {
    this.cooldownMs = Math.max(1000, Number(cooldownMs) || DEFAULT_COOLDOWN_MS);
    this.now = now;
    this.states = new Map();
  }

  isCooling(proxyUrl) {
    const state = this.states.get(keyOf(proxyUrl));
    return Boolean(state?.cooldownUntil && state.cooldownUntil > this.now());
  }

  choose(candidates = [], { seed = 0 } = {}) {
    const values = [...new Set(candidates.map(keyOf).filter(Boolean))];
    if (!values.length) return '';
    const available = values.filter(proxy => !this.isCooling(proxy));
    const pool = available.length ? available : values;
    const start = Math.abs(Number(seed) || 0) % pool.length;
    return pool[start];
  }

  score(proxyUrl) {
    const state = this.states.get(keyOf(proxyUrl));
    if (!state) return 0;
    const cooldownPenalty = this.isCooling(proxyUrl) ? 100000 : 0;
    return cooldownPenalty + (state.consecutiveFailures * 10) + (state.failures - state.successes) + (state.lastLatencyMs / 10000);
  }

  recordSuccess(proxyUrl, latencyMs = 0) {
    if (!keyOf(proxyUrl)) return;
    const state = stateFor(this.states, proxyUrl);
    state.successes += 1;
    state.consecutiveFailures = 0;
    state.cooldownUntil = 0;
    state.lastError = '';
    state.lastLatencyMs = Math.max(0, Number(latencyMs) || 0);
  }

  recordFailure(proxyUrl, error, { status = 0, cooldownMs } = {}) {
    if (!keyOf(proxyUrl)) return;
    const state = stateFor(this.states, proxyUrl);
    state.failures += 1;
    state.consecutiveFailures += 1;
    state.lastError = sanitizeLogMessage(String(error?.message || error || `HTTP ${status || 0}`)).split(keyOf(proxyUrl)).join('[proxy]').slice(0, 300);
    if (state.consecutiveFailures >= 2 || /ssl_connect|ssl_error_syscall|boringssl|connection reset|econnreset|econnrefused|timed?\s*out|http 5\d\d|cloudflare/i.test(state.lastError)) {
      state.cooldownUntil = this.now() + Math.max(1000, Number(cooldownMs) || this.cooldownMs);
    }
  }

  snapshot() {
    const now = this.now();
    return [...this.states.entries()].map(([proxyUrl, state]) => ({
      proxyUrl: (() => { try { const url = new URL(proxyUrl); url.username = ''; url.password = ''; return url.href; } catch { return '[invalid proxy]'; } })(),
      ...state,
      coolingDown: state.cooldownUntil > now,
    }));
  }
}

export const proxyHealthRegistry = new ProxyHealthRegistry({
  cooldownMs: Number(process.env.APP_PROXY_COOLDOWN_MS || 10 * 60 * 1000),
});

proxyHealthRegistry.states = requestMap('proxyHealth');
