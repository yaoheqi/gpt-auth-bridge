import { normalizeOperationId, operationMetadata } from '../../../docs/operation-contract.js';

export function installOperationMetadata(req, res, next) {
  try {
    res.locals.operationId = normalizeOperationId(req.body?.operationId ?? req.get('x-operation-id'), res.locals.requestId);
    res.setHeader('X-Operation-Id', res.locals.operationId);
    next();
  } catch {
    res.status(400).json({ ok: false, code: 'INVALID_OPERATION_ID', error: '操作标识格式无效' });
  }
}

export function decorateOperationResponses(req, res, next) {
  const json = res.json.bind(res);
  res.json = payload => {
    if (!req.path.startsWith('/api/') || !payload || typeof payload !== 'object' || Array.isArray(payload)) return json(payload);
    const failure = payload.ok === false || res.statusCode >= 400;
    const code = payload.code || payload.error?.code || (failure ? 'REQUEST_FAILED' : undefined);
    const message = payload.message || (typeof payload.error === 'string' ? payload.error : payload.error?.message);
    // Body parsing/admission can fail before the caller's operation ID is known.
    // A request ID is diagnostic metadata, never a substitute operation ID.
    return json({ ...payload, ...(code ? { code } : {}), ...(message ? { message } : {}), ...operationMetadata(res.locals.operationId, res.locals.requestId) });
  };
  next();
}
