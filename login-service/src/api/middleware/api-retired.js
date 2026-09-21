const ACTIVE_API_PATHS = new Set(['/api/health', '/api/ready', '/api/public-config', '/api/system/metrics', '/api/system/config']);

/** Reject pre-v2 API routes while leaving health and public configuration available. */
export function createApiRetiredMiddleware() {
  return (req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (ACTIVE_API_PATHS.has(req.path) || req.path === '/api/v2' || req.path.startsWith('/api/v2/')) return next();
    return res.status(410).json({
      ok: false,
      error: 'This API has been retired. Use /api/v2/* instead.',
      code: 'API_RETIRED',
    });
  };
}
