import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 7;

const MIGRATIONS = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_key TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_credentials (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  password_enc TEXT,
  raw_enc TEXT
);

CREATE TABLE IF NOT EXISTS openai_profiles (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  openai_password_enc TEXT,
  openai_name TEXT,
  openai_birthdate TEXT,
  two_factor_secret_enc TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  access_token_enc TEXT,
  session_json_enc TEXT,
  storage_state_path TEXT,
  health TEXT NOT NULL DEFAULT '',
  health_checked_at TEXT,
  health_detail TEXT
);

CREATE TABLE IF NOT EXISTS oauth_credentials (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  refresh_token_enc TEXT,
  access_token_enc TEXT,
  id_token_enc TEXT,
  openai_account_id TEXT,
  token_expires_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agent_identities (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  runtime_id TEXT,
  private_key_enc TEXT,
  agent_account_id TEXT,
  agent_user_id TEXT,
  plan_type TEXT,
  is_fedramp INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS business_credentials (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id TEXT,
  join_status TEXT NOT NULL DEFAULT 'none',
  join_requested_at TEXT,
  join_error TEXT,
  refresh_token_enc TEXT,
  access_token_enc TEXT,
  id_token_enc TEXT,
  openai_account_id TEXT,
  token_expires_at INTEGER NOT NULL DEFAULT 0,
  join_requests_json TEXT
);

CREATE TABLE IF NOT EXISTS sms_activations (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT,
  activation_id TEXT,
  status TEXT,
  phone_number TEXT,
  sms_url_enc TEXT,
  last_code TEXT,
  last_sms_at TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  summary_json TEXT
);

CREATE TABLE IF NOT EXISTS job_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  account_id TEXT,
  item_key TEXT NOT NULL,
  status TEXT NOT NULL,
  step TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  error_code TEXT,
  error_message TEXT,
  result_json TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, item_key)
);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(job_id, sequence)
);

CREATE TABLE IF NOT EXISTS account_leases (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  operation TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  account_id TEXT,
  job_id TEXT,
  path TEXT NOT NULL,
  checksum TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_job_items_job ON job_items(job_id);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, sequence);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, available_at);
CREATE INDEX IF NOT EXISTS idx_accounts_updated ON accounts(updated_at);
`,
  },
  {
    version: 2,
    sql: `
ALTER TABLE sessions ADD COLUMN storage_state_json_enc TEXT;
`,
  },
  {
    version: 3,
    sql: `
ALTER TABLE sessions ADD COLUMN plus_trial_eligible INTEGER;
ALTER TABLE sessions ADD COLUMN plus_trial_campaign TEXT;
ALTER TABLE sessions ADD COLUMN plus_trial_country TEXT;
ALTER TABLE sessions ADD COLUMN plus_trial_checked_at TEXT;
ALTER TABLE sessions ADD COLUMN plus_trial_detail TEXT;
`,
  },
  {
    version: 4,
    sql: `
ALTER TABLE accounts ADD COLUMN openai_stage TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN last_error TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN sub2api_pushed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN sub2api_pushed_at TEXT;
ALTER TABLE accounts ADD COLUMN sub2api_push_source TEXT;
ALTER TABLE accounts ADD COLUMN sub2api_account_id TEXT;
ALTER TABLE accounts ADD COLUMN business_sub2api_pushed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN business_sub2api_pushed_at TEXT;
ALTER TABLE accounts ADD COLUMN business_sub2api_push_source TEXT;
ALTER TABLE accounts ADD COLUMN business_sub2api_account_id TEXT;
`,
  },
  {
    version: 5,
    sql: `
CREATE TABLE IF NOT EXISTS account_fingerprints (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  fingerprint_json TEXT NOT NULL DEFAULT '{}',
  egress_country TEXT,
  egress_ip TEXT,
  egress_source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 7,
    sql: `
ALTER TABLE business_credentials ADD COLUMN workspace_credentials_json TEXT;
`,
  },
];

export function openDatabase(filePath, { readOnly = false } = {}) {
  const resolved = filePath === ":memory:" ? ":memory:" : path.resolve(filePath);
  if (!readOnly && resolved !== ":memory:") fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved, { readOnly: Boolean(readOnly) });
  db.exec('PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY;');
  // Concurrent job workers should wait briefly for the WAL writer instead of
  // failing immediately on transient SQLITE_BUSY contention.
  db.exec('PRAGMA busy_timeout = 5000;');
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    migrate(db);
  }
  return db;
}

export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row.version)),
  );
  const now = new Date().toISOString();
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    withTransaction(db, () => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(migration.version, now);
    });
  }
  return SCHEMA_VERSION;
}

const txDepthByDb = new WeakMap();

export function withTransaction(db, fn) {
  const depth = txDepthByDb.get(db) || 0;
  if (depth === 0) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT sp_${depth}`);
  txDepthByDb.set(db, depth + 1);
  try {
    const result = fn(db);
    txDepthByDb.set(db, depth);
    if (depth === 0) db.exec('COMMIT');
    else db.exec(`RELEASE sp_${depth}`);
    return result;
  } catch (error) {
    txDepthByDb.set(db, depth);
    try {
      if (depth === 0) db.exec('ROLLBACK');
      else db.exec(`ROLLBACK TO sp_${depth}`);
    } catch { /* ignore */ }
    throw error;
  }
}
