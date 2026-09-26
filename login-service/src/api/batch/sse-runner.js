import { SSEChannel } from '../../../lib/sse.js';
import { operationErrorPayload } from '../../http/operation-error.js';
export function wantsEventStream(req) { return Boolean(req.body?.stream) || String(req.headers.accept || '').includes('text/event-stream'); }
export async function runSseResponse(res, run, { headers = {}, heartbeatMs = 15000, errorOptions } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive', 'Content-Encoding': 'identity', 'X-Accel-Buffering': 'no', ...headers,
  });
  const sse = new SSEChannel(res);
  const ping = setInterval(() => {
    sse.write(': ping\n\n');
    res.flush?.();
    res.socket?.uncork?.();
  }, heartbeatMs);
  try { await run(sse); }
  catch (error) { sse.send('error', operationErrorPayload(error, errorOptions)); }
  finally { clearInterval(ping); if (!res.destroyed) res.end(); }
}
