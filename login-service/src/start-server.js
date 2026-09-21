import { installErrorHandlers } from './app/create-app.js';

function timeoutValue(value, fallback, { min = 0, max = 24 * 60 * 60 * 1000 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export async function startServer({
  app,
  port,
  host = '127.0.0.1',
  ready = Promise.resolve(),
  logger = console,
  installSignalHandlers = true,
  beforeClose = async () => {},
  requestTimeoutMs = 5 * 60 * 1000,
  headersTimeoutMs = 15 * 1000,
  keepAliveTimeoutMs = 10 * 1000,
  maxRequestsPerSocket = 1_000,
  shutdownTimeoutMs = 25_000,
} = {}) {
  await ready;
  installErrorHandlers(app);
  const server = await new Promise((resolve, reject) => {
    const candidate = app.listen(port, host, () => resolve(candidate));
    candidate.once('error', reject);
  });
  // Bound slow-client resources while leaving long-running SSE responses
  // available to the route-level stream handlers.
  server.requestTimeout = timeoutValue(requestTimeoutMs, 5 * 60 * 1000, { min: 1_000 });
  server.headersTimeout = timeoutValue(headersTimeoutMs, 15 * 1000, { min: 1_000 });
  server.keepAliveTimeout = timeoutValue(keepAliveTimeoutMs, 10 * 1000, { min: 1_000 });
  server.maxRequestsPerSocket = timeoutValue(maxRequestsPerSocket, 1_000, { min: 0, max: 100_000 });
  server.maxHeadersCount = 100;
  server.on('clientError', (error, socket) => {
    if (!socket.writable) return;
    const status = error?.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  let closing = null;
  let cleanupSignals = () => {};
  const close = () => {
    if (!closing) {
      // A stalled SSE client must not prevent Compose from stopping the process.
      const deadline = setTimeout(() => server.closeAllConnections?.(), timeoutValue(shutdownTimeoutMs, 25_000, { min: 1 }));
      deadline.unref?.();
      let beforeCloseError = null;
      closing = Promise.resolve()
      .then(() => beforeClose())
      .catch((error) => { beforeCloseError = error; })
      .then(() => {
        server.closeIdleConnections?.();
        return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      })
      .then(() => {
        if (beforeCloseError) throw beforeCloseError;
      })
      .finally(() => { clearTimeout(deadline); cleanupSignals(); });
    }
    return closing;
  };
  if (installSignalHandlers) {
    let signalHandled = false;
    const shutdown = signal => {
      if (signalHandled) return;
      signalHandled = true;
      process.exitCode = 0;
      close()
        .then(() => logger.info?.(`服务已停止 (${signal})`))
        .catch(error => { logger.error?.('服务关闭失败:', error); process.exitCode = 1; });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    cleanupSignals = () => {
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
    };
  }
  return { server, close };
}
