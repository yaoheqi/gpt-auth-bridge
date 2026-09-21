function decodePayload(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

export function parseOpenAiAuthErrorUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.hostname !== 'auth.openai.com' || url.pathname !== '/error') return null;
    const payload = decodePayload(url.searchParams.get('payload'));
    return {
      kind: String(payload?.kind || ''),
      code: String(payload?.errorCode || payload?.error_code || 'auth_error'),
      requestId: String(payload?.requestId || payload?.request_id || ''),
    };
  } catch {
    return null;
  }
}

export function isOpenAiRateLimitError(input) {
  return /rate[_ -]?limit[_ -]?exceeded|too many requests|http 429/i.test(String(input?.code || input?.message || input || ''));
}

export function authRetryDelayMs(error, attempt, env = process.env) {
  const configured = Number.parseInt(String(env.OPENAI_AUTH_RATE_LIMIT_COOLDOWN_MS || ''), 10);
  const rateLimitBase = Number.isInteger(configured) && configured >= 10_000 ? configured : 120_000;
  if (isOpenAiRateLimitError(error)) return Math.min(300_000, rateLimitBase * Math.max(1, attempt));
  return Math.min(8_000, 1_000 * (2 ** Math.max(0, attempt - 1)));
}
