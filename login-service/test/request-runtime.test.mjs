import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createSqliteRuntime } from '../src/bootstrap/sqlite-runtime.js';
import { normalizeDbAccount } from '../src/domain/accounts/account-domain.js';
import { browserRequestMiddleware } from '../src/services/browser-request-context.js';
import { createApp } from '../src/app/create-app.js';

async function seeded(t, count = 20) {
  const runtime = createSqliteRuntime({ sqliteDbFile: 'must-never-be-created.sqlite' });
  t.after(() => { clearTimeout(runtime.accounts.writeBatchTimer); runtime.db.close(); runtime.secrets.key.fill(0); });
  await runtime.accounts.initialize();
  for (let i = 0; i < count; i++) runtime.accounts.state.accounts.push(normalizeDbAccount({ id: `fixture-${i}`, email: `fixture-${i}@example.test`, password: 'fixture-password', openai_rt: `fixture-refresh-${i}` }));
  await runtime.accounts.save();
  return runtime;
}

test('online runtimes are memory-only and contain no background jobs, outbox or adapters', async t => {
  const runtime = await seeded(t);
  assert.equal(runtime.dbPath, ':memory:');
  assert.ok(runtime.db.prepare('PRAGMA database_list').all().every(row => !row.file));
  assert.equal(runtime.jobs, undefined);
  assert.equal(runtime.adapters, undefined);
  const tables = runtime.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  for (const table of ['jobs', 'job_items', 'job_events', 'outbox', 'artifacts', 'schema_migrations']) assert.equal(tables.includes(table), false);
  assert.equal(runtime.accounts.listAll().length, 20);
  runtime.accounts.deleteByIds(['fixture-0'], { confirm: true });
  assert.equal(runtime.accounts.findById('fixture-0'), null);
  assert.equal(runtime.db.prepare('SELECT count(*) AS n FROM oauth_credentials').get().n, 19);
});

test('batched changes rewrite only selected accounts and preserve unrelated encrypted records', async t => {
  const { accounts, db } = await seeded(t);
  const ciphertext = id => db.prepare('SELECT password_enc FROM mail_credentials WHERE account_id = ?').get(id).password_enc;
  const before = [ciphertext('fixture-0'), ciphertext('fixture-1'), ciphertext('fixture-19')];
  const mutations = [accounts.updateById('fixture-0', { status: 'updated' }), accounts.updateMany(['fixture-1'], { status: 'also updated' })];
  // Flush explicitly so the test does not depend on an unref'ed timer.
  await new Promise(resolve => setImmediate(resolve));
  await accounts.flushWrites();
  await Promise.all(mutations);
  assert.notEqual(ciphertext('fixture-0'), before[0]);
  assert.notEqual(ciphertext('fixture-1'), before[1]);
  assert.equal(ciphertext('fixture-19'), before[2]);
  accounts.refreshFromDatabase();
  assert.equal(accounts.findById('fixture-0').status, 'updated');
  assert.equal(accounts.findById('fixture-1').status, 'also updated');
  assert.equal(accounts.findById('fixture-19').openai_rt, 'fixture-refresh-19');
});

test('incremental imports preserve existing object identities and unrelated credentials', async t => {
  const { accounts } = await seeded(t, 2);
  const existing = accounts.findById('fixture-1');
  const imported = accounts.importOne({ id: 'new', email: 'new@example.test', password: 'new-password', openai_rt: 'new-refresh' });
  assert.equal(imported.openai_rt, 'new-refresh');
  assert.equal(accounts.findById('fixture-1'), existing);
  accounts.importOne({ email: 'new@example.test', password: 'replaced-password' });
  assert.equal(accounts.findById('new'), imported);
  assert.equal(imported.password, 'replaced-password');
  assert.equal(imported.openai_rt, 'new-refresh');
});

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('unknown, retired and system routes are decided without allocating a user runtime', async t => {
  const app = createApp();
  app.use(browserRequestMiddleware({ strictRoutes: true, createRuntime: () => assert.fail('must not allocate a database') }));
  app.get('/api/v2/health', (_req, res) => res.json({ ok: true }));
  const base = await listen(t, app);
  for (const route of ['unknown', 'accounts/register']) {
    const response = await fetch(`${base}/api/v2/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ browserState: { accounts: [] } }) });
    assert.equal(response.status, 404);
  }
  assert.equal((await fetch(`${base}/api/v2/health`)).status, 200);
  assert.deepEqual((await (await fetch(`${base}/api/v2/jobs`)).json()).jobs, []);
  assert.equal((await fetch(`${base}/api/v2/jobs`, { method: 'POST' })).status, 410);
});

test('HTTP admission rejects excess work before JSON parsing and releases capacity on disconnect', async t => {
  const app = createApp({ requestCapacity: 1 });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  app.post('/api/hold', (_req, res) => { res.writeHead(200); res.write('waiting'); started(); });
  const base = await listen(t, app);
  const active = await fetch(`${base}/api/hold`, { method: 'POST' });
  await entered;
  const rejected = await fetch(`${base}/api/hold`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'invalid JSON' });
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).code, 'REQUEST_CAPACITY_FULL');
  assert.equal(app.locals.admission.snapshot().active, 1);
  await active.body.cancel();
  for (let i = 0; i < 50 && app.locals.admission.snapshot().active; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(app.locals.admission.snapshot().active, 0);
});
