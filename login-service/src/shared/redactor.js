const SENSITIVE_KEY_RE = /(password|secret|token|authorization|api[_-]?key|private[_-]?key|refresh|cookie|proxy)/i;

export function redactValue(value, { maxLength = 200 } = {}) {
  if (value == null) return value;
  if (typeof value === 'string') {
    const trimmed = value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
    if (/Bearer\s+\S+/i.test(trimmed)) return trimmed.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
    if (/rt_[A-Za-z0-9._-]+/.test(trimmed)) return trimmed.replace(/rt_[A-Za-z0-9._-]+/g, 'rt_[REDACTED]');
    return trimmed;
  }
  return value;
}

export function redactDeep(input, depth = 0) {
  if (depth > 8) return '[REDACTED_DEPTH]';
  if (Array.isArray(input)) return input.map((item) => redactDeep(item, depth + 1));
  if (!input || typeof input !== 'object') return redactValue(input);
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = value == null || value === '' ? value : '[REDACTED]';
      continue;
    }
    out[key] = redactDeep(value, depth + 1);
  }
  return out;
}

export function publicError(error, { code = 'INTERNAL_ERROR', status = 500 } = {}) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: {
      code: error?.code || code,
      message: redactValue(message, { maxLength: 300 }),
    },
    status: Number(error?.statusCode || status),
  };
}
