import { DatabaseSync } from 'node:sqlite';

// A request always starts empty and never loads a file or runs legacy migrations.
// Keep only tables used by the account/settings repositories in the online path.
const REQUEST_SCHEMA = `
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, email_key TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL DEFAULT 'unknown', status TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  openai_stage TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '',
  sub2api_pushed INTEGER NOT NULL DEFAULT 0, sub2api_pushed_at TEXT, sub2api_push_source TEXT, sub2api_account_id TEXT,
  business_sub2api_pushed INTEGER NOT NULL DEFAULT 0, business_sub2api_pushed_at TEXT,
  business_sub2api_push_source TEXT, business_sub2api_account_id TEXT
);
CREATE TABLE mail_credentials (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, password_enc TEXT, raw_enc TEXT);
CREATE TABLE openai_profiles (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, openai_password_enc TEXT, openai_name TEXT, openai_birthdate TEXT, two_factor_secret_enc TEXT);
CREATE TABLE sessions (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, access_token_enc TEXT, session_json_enc TEXT,
  storage_state_path TEXT, storage_state_json_enc TEXT, health TEXT NOT NULL DEFAULT '', health_checked_at TEXT, health_detail TEXT,
  plus_trial_eligible INTEGER, plus_trial_campaign TEXT, plus_trial_country TEXT, plus_trial_checked_at TEXT, plus_trial_detail TEXT
);
CREATE TABLE oauth_credentials (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, refresh_token_enc TEXT, access_token_enc TEXT, id_token_enc TEXT, openai_account_id TEXT, token_expires_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE agent_identities (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, runtime_id TEXT, private_key_enc TEXT, agent_account_id TEXT, agent_user_id TEXT, plan_type TEXT, is_fedramp INTEGER NOT NULL DEFAULT 0);
CREATE TABLE business_credentials (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, workspace_id TEXT, join_status TEXT NOT NULL DEFAULT 'none',
  join_requested_at TEXT, join_error TEXT, refresh_token_enc TEXT, access_token_enc TEXT, id_token_enc TEXT,
  openai_account_id TEXT, token_expires_at INTEGER NOT NULL DEFAULT 0, join_requests_json TEXT, workspace_credentials_json TEXT
);
CREATE TABLE sms_activations (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, provider TEXT, activation_id TEXT, status TEXT, phone_number TEXT, sms_url_enc TEXT, last_code TEXT, last_sms_at TEXT);
CREATE TABLE account_fingerprints (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, fingerprint_json TEXT NOT NULL DEFAULT '{}', egress_country TEXT, egress_ip TEXT, egress_source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_accounts_updated ON accounts(updated_at);
`;

export function openRequestDatabase() {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY;');
    db.exec(REQUEST_SCHEMA);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
