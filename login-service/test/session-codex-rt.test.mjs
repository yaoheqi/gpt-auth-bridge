import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase, SCHEMA_VERSION } from '../src/shared/db.js';
import { SecretStore } from '../src/shared/secret-store.js';
import { SqliteAccountRepository } from '../src/modules/accounts/sqlite-account-repository.js';
import { OPENAI_CODEX_CLIENT_ID } from '../lib/openai-oauth.js';
import {
  countStorageStateCookies,
  hasReusableStoredSession,
  normalizeStorageStateJson,
  resolveSessionCodexLoginAction,
  sessionReuseFields,
} from '../lib/session-reuse.js';
import {
  buildSessionCodexRtBatch,
  runSessionCodexRtForAccount,
  runSessionCodexRtForAccounts,
} from '../src/services/session-codex-rt-service.js';

const SAMPLE_STORAGE = JSON.stringify({
  cookies: [
    { name: 'session', value: 'abc', domain: '.openai.com' },
    { name: 'oai', value: 'xyz', domain: '.openai.com' },
  ],
});

function jwt(payload) {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.x`;
}

function accountWithRt(overrides = {}) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return {
    id: 'acc-1',
    email: 'ready@icloud.com',
    session_access_token: 'at',
    storage_state_json: SAMPLE_STORAGE,
    openai_rt: 'rt-value',
    openai_access_token: jwt({
      exp,
      iat: exp - 60,
      client_id: OPENAI_CODEX_CLIENT_ID,
      sub: 'user-1',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1' },
    }),
    openai_id_token: 'id-token',
    openai_account_id: 'acct_1',
    openai_token_expires_at: exp,
    openai_password: 'SecretPass1!',
    ...overrides,
  };
}

test('sessionReuseFields preserves cookie session fields', () => {
  const account = {
    email: 'user@icloud.com',
    password: 'SecretPass1!',
    two_factor_secret: 'JBSWY3DPEHPK3PXP',
    session_access_token: 'at-token',
    session_json: '{"accessToken":"at-token"}',
    storage_state_json: SAMPLE_STORAGE,
  };
  const fields = sessionReuseFields(account);
  assert.equal(fields.storage_state_json, SAMPLE_STORAGE);
  assert.equal(fields.session_access_token, 'at-token');

  assert.equal(fields.session_json, '{"accessToken":"at-token"}');
  assert.equal(fields.session_access_token, 'at-token');
  assert.equal(countStorageStateCookies(fields.storage_state_json), 2);
  assert.equal(hasReusableStoredSession(account), true);
});

test('normalizeStorageStateJson stringifies objects', () => {
  assert.equal(normalizeStorageStateJson({ cookies: [] }), '{"cookies":[]}');
  assert.equal(normalizeStorageStateJson('  {"cookies":[]}  '), '{"cookies":[]}');
  assert.equal(normalizeStorageStateJson(''), '');
});

test('resolveSessionCodexLoginAction respects loginMode', () => {
  assert.equal(resolveSessionCodexLoginAction('auto', { hasReusableSession: true }), 'skipLogin');
  assert.equal(resolveSessionCodexLoginAction('auto', { hasReusableSession: false }), 'forceProtocol');
  assert.equal(resolveSessionCodexLoginAction('forceProtocol', { hasReusableSession: true }), 'forceProtocol');
  assert.equal(resolveSessionCodexLoginAction('skipLogin', { hasReusableSession: false }), 'skipLogin');
});

test('sqlite repository persists and reloads storage_state_json', async () => {
  // v7 adds durable Business workspace credential metadata while preserving
  // The storage-state persistence contract is exercised below.
  assert.equal(SCHEMA_VERSION, 7);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-storage-state-'));
  const dbPath = path.join(dir, 'app.sqlite');
  const db = openDatabase(dbPath);
  const secrets = new SecretStore('test-master-key-for-storage-state');
  const repo = new SqliteAccountRepository(db, secrets);
  await repo.initialize();

  const account = {
    id: 'acc-storage-1',
    email: 'persist@icloud.com',
    emailKey: 'persist@icloud.com',
    password: 'pw',
    session_access_token: 'session-at',
    session_json: '{"accessToken":"session-at"}',
    storage_state_path: 'runtime/sessions/acc-storage-1.json',
    storage_state_json: SAMPLE_STORAGE,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  repo.state.accounts.push(account);
  await repo.save();

  const reloaded = new SqliteAccountRepository(db, secrets);
  await reloaded.initialize();
  const found = reloaded.findById('acc-storage-1');
  assert.ok(found);
  assert.equal(found.session_access_token, 'session-at');
  assert.equal(found.storage_state_json, SAMPLE_STORAGE);
  assert.equal(found.storage_state_path, 'runtime/sessions/acc-storage-1.json');
  assert.equal(countStorageStateCookies(found.storage_state_json), 2);

  const cols = db.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name);
  assert.ok(cols.includes('storage_state_json_enc'));
});

test('session-codex-rt skips protocol login when cookies exist and exports RT', async () => {
  const account = accountWithRt();
  const store = new Map([[account.id, { ...account }]]);

  let protocolCalls = 0;
  const result = await runSessionCodexRtForAccount(account, {
    loginMode: 'auto',
    forbidPhoneChallenge: true,
    forceCodex: false,
    findAccountById: (id) => store.get(String(id)) || null,
    runProtocolLogin: async () => {
      protocolCalls += 1;
      return { ok: true };
    },
    runCodexAuth: async (acc) => {
      assert.equal(countStorageStateCookies(acc.storage_state_json), 2);
      return { ok: true, skipped: true, reason: '已有 OpenAI RT', email: acc.email };
    },
  });

  assert.equal(protocolCalls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.login.skipped, true);
  assert.equal(result.export.ok, true);
  assert.ok(result.export.record);
});

test('session-codex-rt batch builds sub2 json', async () => {
  const account = accountWithRt({ id: 'acc-2', email: 'batch@icloud.com', openai_account_id: 'acct_2' });
  const summary = await runSessionCodexRtForAccounts([account], {
    loginMode: 'skipLogin',
    findAccountById: () => account,
    runProtocolLogin: async () => ({ ok: true }),
    runCodexAuth: async () => ({ ok: true, email: account.email }),
    enqueueImmediate: async () => ({ enabled: true, queued: 1 }),
    push: true,
  });
  assert.equal(summary.success, 1);
  assert.equal(summary.json.accounts.length, 1);
  assert.equal(summary.pushQueued, 1);

  const batch = buildSessionCodexRtBatch({
    body: { ids: ['acc-2'], forbidPhoneChallenge: false },
    allAccounts: [account],
    findById: (id) => (id === 'acc-2' ? account : null),
  });
  assert.equal(batch.forbidPhoneChallenge, false);
  assert.equal(batch.loginMode, 'auto');
});

test('session-codex-rt falls back to stored RT export when refresh fails', async () => {
  const account = accountWithRt({ id: 'acc-3', email: 'fallback@icloud.com', openai_account_id: 'acct_3' });
  const result = await runSessionCodexRtForAccount(account, {
    loginMode: 'skipLogin',
    forceCodex: false,
    findAccountById: () => account,
    runProtocolLogin: async () => ({ ok: true }),
    runCodexAuth: async () => ({ ok: false, error: 'fetch failed', logs: [] }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.export.ok, true);
  assert.match(String(result.codex.reason || ''), /已保存 RT/);
});
