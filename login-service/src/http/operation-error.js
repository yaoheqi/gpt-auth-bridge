import { validationFailureFields } from '../../lib/validation-error.js';

const DEFAULT_STATUSES = {
  TASK_QUEUE_FULL: 429,
  REQUEST_CAPACITY_FULL: 429,
  TASK_QUEUE_TIMEOUT: 503,
  PUSH_QUEUE_TIMEOUT: 503,
  ACCOUNT_TASK_TIMEOUT: 504,
  WORKER_CLEANUP_TIMEOUT: 503,
  PROXY_ROUTE_TIMEOUT: 503,
};

function httpStatus(value, fallback) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallback;
}

/** An execution error describes this request, not the outcome of remote writes. */
export function operationErrorPayload(error, {
  fallbackCode = 'REQUEST_FAILED', fallbackStatus = 400, sanitize = value => value,
  errorShape = 'string', requestId,
} = {}) {
  const code = typeof error?.code === 'string' && error.code.trim() ? error.code : fallbackCode;
  const fallback = httpStatus(DEFAULT_STATUSES[code], httpStatus(fallbackStatus, 400));
  const status = httpStatus(error?.statusCode, httpStatus(error?.status, fallback));
  const rawMessage = typeof error?.message === 'string' ? error.message : String(error ?? 'Request failed');
  const message = sanitize(rawMessage);
  const retryAfterMs = Number(error?.retryAfterMs);
  return {
    ok: false, code, message, status,
    ...validationFailureFields(error),
    error: errorShape === 'object' ? { code, message } : message,
    ...(error?.retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? { retryAfterMs } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

export function sendOperationError(res, error, options) {
  if (res.destroyed || res.writableEnded) return res;
  const payload = operationErrorPayload(error, options);
  // Streaming callers send operationErrorPayload through their established SSE
  // channel. Never append a JSON document after those headers were committed.
  if (res.headersSent) { res.end?.(); return res; }
  return res.status(payload.status).json(payload);
}
