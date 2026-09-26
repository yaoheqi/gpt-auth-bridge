import { randomBytes } from 'node:crypto';
import { openRequestDatabase } from '../shared/request-db.js';
import { SecretStore } from '../shared/secret-store.js';
import { SqliteAccountRepository } from '../modules/accounts/sqlite-account-repository.js';
import { requestIdMiddleware } from '../http/request-metadata.js';
import { registerV2Routes } from '../modules/api/v2-routes.js';

export function createSqliteRuntime() {
  const dbPath = ':memory:';
  const db = openRequestDatabase();
  const secrets = new SecretStore(randomBytes(32).toString('hex'));
  const accounts = new SqliteAccountRepository(db, secrets, { recordOutbox: false });

  return {
    db,
    dbPath,
    secrets,
    accounts,
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
