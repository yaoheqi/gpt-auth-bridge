import { randomBytes } from 'node:crypto';
import { openDatabase } from '../shared/db.js';
import { SecretStore } from '../shared/secret-store.js';
import { SqliteAccountRepository } from '../modules/accounts/sqlite-account-repository.js';
import { SqliteJobEngine } from '../modules/workflows/sqlite-job-engine.js';
import { requestIdMiddleware } from '../http/request-metadata.js';
import { registerV2Routes } from '../modules/api/v2-routes.js';
import { createProtocolAuthAdapter, createBrowserWorkerAdapter } from '../modules/adapters/ports.js';

export function createSqliteRuntime(runtimePaths) {
  const dbPath = ':memory:';
  const db = openDatabase(dbPath);
  const secrets = new SecretStore(randomBytes(32).toString('hex'));
  const accounts = new SqliteAccountRepository(db, secrets);
  const jobs = new SqliteJobEngine(db, { runtimePaths });

  // The composition root replaces these guards with real handlers before listen().
  const unbound = (type) => async ({ item }) => ({
    ok: false,
    code: 'HANDLER_NOT_BOUND',
    step: 'dispatch',
    error: `${type} handler is not bound for ${item.item_key}`,
  });
  for (const type of ['session-health', 'protocol-login']) jobs.registerHandler(type, unbound(type));

  const recoveredJobIds = jobs.recoverExpiredLeases();

  return {
    db,
    dbPath,
    secrets,
    accounts,
    jobs,
    recoveredJobIds,
    adapters: {
      protocol: createProtocolAuthAdapter({
        runProtocolRegister: async () => ({ ok: false, error: 'protocol adapter not bound' }),
        runProtocolLogin: async () => ({ ok: false, error: 'protocol adapter not bound' }),
      }),
      browser: createBrowserWorkerAdapter({
        spawnWorker: async () => ({ ok: false, error: 'browser adapter not bound' }),
      }),
    },
  };
}

export function bindSqliteRuntimeToApp(app, runtime, runtimePaths, { requireAdmin } = {}) {
  app.use(requestIdMiddleware);
  const admin = requireAdmin || ((_req, _res, next) => next());
  registerV2Routes(app, {
    requireAdmin: admin,
    accounts: runtime.accounts,
    runtimePaths,
  });
  return runtime;
}
