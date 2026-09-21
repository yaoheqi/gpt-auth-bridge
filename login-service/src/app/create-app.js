import crypto from 'node:crypto';
import express from 'express';
import { createOperationalMetrics } from '../services/operational-metrics.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,96}$/;
const ERROR_HANDLERS_INSTALLED = Symbol('errorHandlersInstalled');
const DEPLOYMENT_MODE = /^(1|true|yes)$/i.test(String(process.env.CONTAINER || '').trim()) || String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';

function requestIdFor(req) {
  const incoming = String(req.get('x-request-id') || '').trim();
  return REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
}

/**
 * Keep cross-cutting HTTP behavior in one place so every route (including
 * newly registered v2 routes) gets the same baseline protection.
 */
export function installHttpDefaults(app) {
  app.disable('x-powered-by');
  // Compatibility for clients using the former gateway prefix; no HTTP proxy.
  app.use((req, _res, next) => {
    if (req.url.startsWith('/api/login-icloud/')) req.url = req.url.slice('/api/login-icloud'.length);
    next();
  });
  app.use((req, res, next) => {
    const requestId = requestIdFor(req);
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'");
    if (req.path?.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
}

function jsonError(error, req, res, next) {
  const isJsonParserError = error?.type === 'entity.too.large'
    || (error instanceof SyntaxError && error?.status === 400 && Object.prototype.hasOwnProperty.call(error, 'body'));
  if (!isJsonParserError) return next(error);
  if (res.headersSent) return next(error);
  const status = error?.type === 'entity.too.large' ? 413 : 400;
  const requestId = res.locals.requestId || requestIdFor(req);
  const message = status === 413 ? 'Request body is too large' : 'Invalid JSON request body';
  res.status(status).json({ ok: false, error: message, code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON', requestId });
}

function routeError(error, req, res, next) {
  if (res.headersSent) return next(error);
  const requestId = res.locals.requestId || requestIdFor(req);
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : (Number.isInteger(error?.status) ? error.status : 500);
  const safeStatus = status >= 400 && status <= 599 ? status : 500;
  const detail = DEPLOYMENT_MODE && safeStatus >= 500
    ? 'Internal server error'
    : String(error?.message || 'Request failed');
  res.status(safeStatus).json({ ok: false, error: detail, code: error?.code || (safeStatus >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'), requestId });
}

/** Mount after all application routes have been registered. */
export function installErrorHandlers(app) {
  if (app[ERROR_HANDLERS_INSTALLED]) return app;
  app.use((req, res, next) => {
    if (res.headersSent) return next();
    if (req.path?.startsWith('/api/')) {
      const requestId = res.locals.requestId || requestIdFor(req);
      return res.status(404).json({ ok: false, error: 'Route not found', code: 'NOT_FOUND', requestId });
    }
    return res.status(404).type('text').send('Not found');
  });
  app.use(jsonError);
  app.use(routeError);
  app[ERROR_HANDLERS_INSTALLED] = true;
  return app;
}

export function createApp({ jsonLimit = '10mb', configure } = {}) {
  const app = express();
  installHttpDefaults(app);
  app.locals.metrics = createOperationalMetrics();
  app.use(app.locals.metrics.middleware);
  app.use(express.json({ limit: jsonLimit, strict: true }));
  configure?.(app);
  return app;
}
