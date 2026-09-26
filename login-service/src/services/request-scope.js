import { AsyncLocalStorage } from 'node:async_hooks';

export const requests = new AsyncLocalStorage();
export const executions = new AsyncLocalStorage();
export const browserRequest = () => requests.getStore();

// Existing business services use the same repository interface, but each HTTP
// request owns a fresh in-memory database. No browser ID or server-side session
// can be used to recover accounts from a previous request.
export function requestScoped(name, fallback) {
  return new Proxy({}, {
    get(_target, key) {
      const context = browserRequest();
      if (context?.closed) throw new Error('请求已结束');
      requestSignal()?.throwIfAborted();
      const target = context?.[name] || fallback;
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function requestMap(name) {
  return new Proxy({}, {
    get(_target, key) {
      const context = browserRequest();
      const map = context && !context.closed ? (context.maps[name] ||= new Map()) : new Map();
      const value = map[key];
      return typeof value === 'function' ? value.bind(map) : value;
    },
  });
}

export function registerRequestCleanup(cleanup) {
  const context = browserRequest();
  const execution = executions.getStore();
  if (context?.closed || execution?.closed) { Promise.resolve().then(cleanup).catch(() => {}); return () => {}; }
  context?.cleanups.add(cleanup);
  execution?.cleanups.add(cleanup);
  return () => { context?.cleanups.delete(cleanup); execution?.cleanups.delete(cleanup); };
}

// Account scopes already combine the request, caller and account deadline.
export function requestSignal() { return executions.getStore()?.signal || browserRequest()?.controller.signal; }
