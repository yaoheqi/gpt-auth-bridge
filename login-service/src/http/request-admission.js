import { configuredTaskConcurrency } from '../../lib/batch-concurrency.js';

// Reject excess HTTP work before reading a potentially large credential payload.
// This counts active requests only; it never retains identities or request data.
export function createRequestAdmission({ limit = Math.max(16, configuredTaskConcurrency() * 4) } = {}) {
  let active = 0;
  let rejected = 0;
  const middleware = (req, res, next) => {
    const inexpensive = ['/api/health', '/api/ready', '/api/public-config', '/api/system/config', '/api/system/metrics', '/api/v2/health', '/api/v2/sot', '/api/v2/system/proxy-health'];
    if (!req.path.startsWith('/api/') || req.method === 'OPTIONS'
      || (['GET', 'HEAD'].includes(req.method) && inexpensive.includes(req.path))) return next();
    if (active >= limit) {
      rejected += 1;
      res.setHeader('Retry-After', '2');
      return res.status(429).json({ ok: false, code: 'REQUEST_CAPACITY_FULL', message: '服务繁忙，请稍后重试', error: '服务繁忙，请稍后重试', retryable: true, retryAfterMs: 2000 });
    }
    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
      res.off('finish', release);
      res.off('close', release);
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
  return { middleware, snapshot: () => ({ active, limit, rejected }) };
}
