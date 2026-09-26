import { randomUUID } from 'node:crypto';

export function requestIdMiddleware(req, res, next) {
  req.requestId = res.locals?.requestId || randomUUID();
  next();
}

export function envelopeOk(data, requestId) {
  return { ok: true, data, requestId };
}

export function envelopeErr(error, requestId, status = 400) {
  return {
    status,
    body: {
      ok: false,
      error: {
        code: error?.code || 'REQUEST_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
      requestId,
    },
  };
}
