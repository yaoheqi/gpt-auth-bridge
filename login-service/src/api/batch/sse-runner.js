import { SSEChannel } from '../../../lib/sse.js';
export function wantsEventStream(req) { return Boolean(req.body?.stream) || String(req.headers.accept || '').includes('text/event-stream'); }
export async function runSseResponse(res, run, { headers = {}, heartbeatMs = 15000 } = {}) {
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
  catch (error) { sse.send('error', { error: error instanceof Error ? error.message : String(error) }); }
  finally { clearInterval(ping); if (!res.destroyed) res.end(); }
}
