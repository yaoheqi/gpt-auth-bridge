/** ChatGPT Web Session health probe helpers. */

import {
  SESSION_HEALTH,
  SESSION_HEALTH_LABELS,
  SESSION_PROBE_TIMEOUT_MS,
  SESSION_PROBE_UA,
  SESSION_PROBE_URL,
  classifySessionProbe,
  extractErrorCode,
  isAccountDeactivatedError,
} from '../lib/auth-behavior-contract.js';

export {
  SESSION_HEALTH,
  SESSION_HEALTH_LABELS,
  classifySessionProbe,
  extractErrorCode,
  isAccountDeactivatedError,
};

export async function probeChatGptSessionAccessToken(accessToken, {
  fetchImpl = fetch,
  url = SESSION_PROBE_URL,
  userAgent = SESSION_PROBE_UA,
  timeoutMs = SESSION_PROBE_TIMEOUT_MS,
  headers: extraHeaders = {},
} = {}) {
  const token = String(accessToken || '').trim();
  if (!token) {
    return {
      ok: false,
      health: SESSION_HEALTH.NO_SESSION,
      status: 0,
      code: '',
      body: '',
      error: '缺少 accessToken',
    };
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': userAgent,
        Referer: 'https://chatgpt.com/',
        Origin: 'https://chatgpt.com',
        ...extraHeaders,
      },
      signal: controller?.signal,
    });
    const body = await response.text();
    let payload = null;
    try {
      payload = body ? JSON.parse(body) : null;
    } catch {
      payload = null;
    }
    const code = extractErrorCode(payload, body);
    const health = classifySessionProbe({ status: response.status, code, body });
    return {
      ok: health === SESSION_HEALTH.ALIVE,
      health,
      status: response.status,
      code,
      body: String(body || '').replace(/\s+/g, ' ').slice(0, 240),
      payload,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      health: SESSION_HEALTH.PROBE_FAILED,
      status: 0,
      code: '',
      body: '',
      error: message,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function sessionHealthLabel(health) {
  return SESSION_HEALTH_LABELS[health] || String(health || '');
}

export function shouldRequireExistingSession({ loginOnly = false, forceRelogin = false } = {}) {
  return !loginOnly && !forceRelogin;
}
