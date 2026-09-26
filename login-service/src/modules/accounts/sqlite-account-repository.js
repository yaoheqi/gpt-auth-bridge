import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../shared/db.js';
import { normalizeDbAccount } from '../../domain/accounts/account-domain.js';

function nowIso() {
  return new Date().toISOString();
}

export function inferSourceType(record = {}) {
  if (record.two_factor_secret || record.twoFactorSecret) return 'password_totp';
  if (record.openai_rt || record.openaiRt) return 'rt';
  return 'unknown';
}

export class SqliteAccountRepository {
  constructor(db, secrets, { normalizeAccount = normalizeDbAccount, now = () => new Date().toISOString(), writeBatchWindowMs = 12, recordOutbox = true } = {}) {
    this.db = db;
    this.secrets = secrets;
    this.normalizeAccount = normalizeAccount;
    this.now = now;
    this.state = { version: 2, updatedAt: '', accounts: [] };
    this.writeQueue = Promise.resolve();
    this.pendingWrites = [];
    this.writeBatchTimer = null;
    this.writeBatchWindowMs = writeBatchWindowMs;
    this.ready = null;
    this.recordOutbox = recordOutbox;
  }

  initialize() {
    if (!this.ready) this.ready = Promise.resolve(this.refreshFromDatabase());
    return this.ready;
  }

  async ensureReady() {
    return this.initialize();
  }

  refreshFromDatabase() {
    const rows = this.db.prepare('SELECT * FROM accounts ORDER BY updated_at ASC').all();
    const related = this.#loadRelatedRows();
    const existingById = new Map(this.state.accounts.map((account) => [String(account.id), account]));
    const accounts = [];
    for (const row of rows) {
      const hydrated = this.#normalizeHydrated(row, related);
      const existing = existingById.get(String(row.id));
      if (existing) {
        Object.assign(existing, hydrated);
        accounts.push(existing);
      } else {
        accounts.push(hydrated);
      }
    }
    this.state.accounts.splice(0, this.state.accounts.length, ...accounts);
    Object.assign(this.state, { version: 2, updatedAt: this.now() });
    return this.state;
  }

  listAll() {
    return this.state.accounts;
  }

  updatedAt() {
    return this.state.updatedAt || '';
  }

  findById(id) {
    const key = String(id || '').trim();
    return this.state.accounts.find((account) => String(account.id) === key)
      || this.#hydrateAccountById(key);
  }

  findByEmailKey(emailKey) {
    return this.db.prepare('SELECT * FROM accounts WHERE email_key = ?').get(String(emailKey || '').toLowerCase()) || null;
  }

  importOne(imported) {
    const id = withTransaction(this.db, () => {
      const email = String(imported.email || '').trim();
      const emailKey = email.toLowerCase();
      if (!email || !email.includes('@')) throw new Error('缺少有效邮箱');
      const existing = this.findByEmailKey(emailKey);
      const stamp = this.now();
      const accountId = existing?.id || String(imported.id || randomUUID());
      const sourceType = imported.mode || inferSourceType(imported);
      if (existing) {
        this.db.prepare(`
          UPDATE accounts SET email = ?, status = ?, source_type = ?, version = version + 1, updated_at = ?
          WHERE id = ?
        `).run(email, imported.status || existing.status || '已更新邮箱', sourceType, stamp, accountId);
      } else {
        this.db.prepare(`
          INSERT INTO accounts(id, email, email_key, source_type, status, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        `).run(accountId, email, emailKey, sourceType, imported.status || '邮箱已导入', stamp, stamp);
      }
      this.#upsertMail(accountId, imported);
      this.#upsertProfile(accountId, imported);
      if (imported.openai_rt) this.#upsertOauth(accountId, { refresh_token: imported.openai_rt });
      if (imported.auth_phone_number || imported.auth_phone_sms_url) {
        this.#upsertSms(accountId, imported);
      }
      return accountId;
    });
    const hydrated = this.#hydrateAccountById(id);
    const existing = this.state.accounts.find(account => String(account.id) === String(id));
    if (existing) Object.assign(existing, hydrated);
    else this.state.accounts.push(hydrated);
    this.state.updatedAt = this.now();
    return this.findById(id);
  }

  deleteByIds(ids, { confirm = false } = {}) {
    const wanted = [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!wanted.length) throw new Error('ids 不能为空');
    const matched = wanted.map((id) => this.findById(id)).filter(Boolean);
    const missing = wanted.filter((id) => !matched.some((row) => row.id === id));
    if (!confirm) {
      return { dryRun: true, preview: { requested: wanted.length, matched: matched.length, missing, accounts: matched.map((row) => this.#toPublic(row)) } };
    }
    const result = withTransaction(this.db, () => {
      const deleteStmt = this.db.prepare('DELETE FROM accounts WHERE id = ?');
      for (const row of matched) deleteStmt.run(row.id);
      if (this.recordOutbox) this.db.prepare(`
        INSERT INTO outbox(kind, payload_json, status, attempts, available_at, created_at)
        VALUES ('account_deleted', ?, 'pending', 0, ?, ?)
      `).run(JSON.stringify({ ids: matched.map((row) => row.id) }), nowIso(), nowIso());
      return { dryRun: false, deleted: matched.map((row) => this.#toPublic(row)), summary: { deleted: matched.length, missing } };
    });
    this.refreshFromDatabase();
    return result;
  }

  tryAcquireLease(accountId, owner, operation, ttlMs = 15 * 60 * 1000) {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const stamp = nowIso();
    return withTransaction(this.db, () => {
      const current = this.db.prepare('SELECT * FROM account_leases WHERE account_id = ?').get(accountId);
      if (current && current.expires_at > stamp && current.owner !== owner) {
        return { ok: false, lease: current };
      }
      this.db.prepare(`
        INSERT INTO account_leases(account_id, owner, operation, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET owner = excluded.owner, operation = excluded.operation, expires_at = excluded.expires_at
      `).run(accountId, owner, operation, expiresAt);
      return { ok: true, lease: { account_id: accountId, owner, operation, expires_at: expiresAt } };
    });
  }

  releaseLease(accountId, owner) {
    this.db.prepare('DELETE FROM account_leases WHERE account_id = ? AND owner = ?').run(accountId, owner);
  }

  findByEmail(emailKey) {
    const key = String(emailKey || '').trim().toLowerCase();
    return this.state.accounts.find((account) => String(account.emailKey || '').toLowerCase() === key) || null;
  }

  async updateById(id, patch = {}) {
    const key = String(id || '').trim();
    if (!key) return null;
    await this.ensureReady();
    return this.write(async (state) => {
      const account = state.accounts.find((item) => String(item.id) === key);
      if (!account) return null;
      const result = typeof patch === 'function' ? await patch(account, state) : patch;
      if (result && result !== account && typeof result === 'object') Object.assign(account, result);
      if (Object.hasOwn(account, 'email')) {
        account.email = String(account.email || '').trim();
        account.emailKey = account.email.toLowerCase();
      }
      account.updatedAt = this.now();
      account.version = Number(account.version || 1) + 1;
      return account;
    }, { ids: [key] });
  }

  async updateMany(ids, patcher) {
    const wanted = ids == null
      ? null
      : new Set((Array.isArray(ids) ? ids : [ids]).map((id) => String(id || '').trim()).filter(Boolean));
    return this.write(async (state) => {
      const selected = state.accounts.filter((account) => !wanted || wanted.has(String(account.id)));
      const updated = [];
      for (const [index, account] of selected.entries()) {
        const result = typeof patcher === 'function' ? await patcher(account, index, state) : patcher;
        if (result && result !== account && typeof result === 'object') Object.assign(account, result);
        account.updatedAt = this.now();
        account.version = Number(account.version || 1) + 1;
        updated.push(account);
      }
      return updated;
    }, { ids: wanted == null ? null : [...wanted] });
  }

  /** Execute an account import application transaction on the serialized state. */
  async importBatch(importer) {
    if (typeof importer !== 'function') throw new TypeError('importer must be a function');
    return this.write(state => importer({
      state,
      accounts: state.accounts,
      addAccount: account => state.accounts.push(account),
    }));
  }

  async save({ ids = null } = {}) {
    await this.ensureReady();
    const stamp = this.now();
    this.state.updatedAt = stamp;
    withTransaction(this.db, () => {
      const selected = ids == null ? null : new Set(ids.map(String));
      if (selected == null) {
        const currentIds = [...new Set(this.state.accounts.map((account) => String(account.id || '').trim()).filter(Boolean))];
        if (currentIds.length) {
          const placeholders = currentIds.map(() => '?').join(', ');
          this.db.prepare(`DELETE FROM accounts WHERE id NOT IN (${placeholders})`).run(...currentIds);
        } else this.db.prepare('DELETE FROM accounts').run();
      }
      for (const account of this.state.accounts) if (selected == null || selected.has(String(account.id))) this.#upsertAccount(account, stamp);
    });
    return this.state;
  }

  async write(mutator, { ids = null } = {}) {
    await this.ensureReady();
    return new Promise((resolve, reject) => {
      this.pendingWrites.push({ mutator, resolve, reject, ids });
      if (this.pendingWrites.length === 1) {
        this.writeBatchTimer = setTimeout(() => {
          this.writeBatchTimer = null;
          this.flushWrites();
        }, this.writeBatchWindowMs);
        this.writeBatchTimer.unref?.();
      }
      if (this.pendingWrites.length >= 20) {
        clearTimeout(this.writeBatchTimer);
        this.writeBatchTimer = null;
        this.flushWrites();
      }
    });
  }

  async flushWrites() {
    if (!this.pendingWrites.length) return this.writeQueue;
    const batch = this.pendingWrites.splice(0);
    const operation = this.writeQueue.then(async () => {
      const results = [];
      for (const item of batch) results.push(await item.mutator(this.state));
      const ids = batch.some(item => item.ids == null) ? null : [...new Set(batch.flatMap(item => item.ids))];
      await this.save({ ids });
      batch.forEach((item, index) => item.resolve(results[index]));
      return results;
    }).catch(error => {
      batch.forEach(item => item.reject(error));
      throw error;
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async checkReady() {
    await this.ensureReady();
    return { ok: Array.isArray(this.state.accounts), accountCount: this.state.accounts.length, sot: 'sqlite' };
  }

  #hydrateAccountById(id) {
    if (!id) return null;
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    return row ? this.#normalizeHydrated(row) : null;
  }

  #normalizeHydrated(row, related = {}) {
    const account = this.normalizeAccount(this.#hydrate(row, related));
    if (!account || typeof account !== 'object') return account;
    // Keep persistence metadata available to callers even when a custom
    // normalizer intentionally strips unknown fields.
    account.version = Number(row.version || account.version || 1) || 1;
    account.source_type = row.source_type || account.source_type || 'unknown';
    return account;
  }

  #loadRelatedRows() {
    const tables = [
      ['mail', 'mail_credentials'],
      ['profile', 'openai_profiles'],
      ['session', 'sessions'],
      ['oauth', 'oauth_credentials'],
      ['agent', 'agent_identities'],
      ['business', 'business_credentials'],
      ['sms', 'sms_activations'],
      ['fingerprint', 'account_fingerprints'],
    ];
    return Object.fromEntries(tables.map(([key, table]) => {
      const rows = this.db.prepare(`SELECT * FROM ${table}`).all();
      return [key, new Map(rows.map(row => [String(row.account_id), row]))];
    }));
  }

  #hydrate(row, related = {}) {
    const id = row.id;
    const rowFor = (name, table) => {
      if (Object.hasOwn(related, name)) return related[name].get(String(id)) || {};
      return this.db.prepare(`SELECT * FROM ${table} WHERE account_id = ?`).get(id) || {};
    };
    const mail = rowFor('mail', 'mail_credentials');
    const profile = rowFor('profile', 'openai_profiles');
    const session = rowFor('session', 'sessions');
    const oauth = rowFor('oauth', 'oauth_credentials');
    const agent = rowFor('agent', 'agent_identities');
    const business = rowFor('business', 'business_credentials');
    const sms = rowFor('sms', 'sms_activations');
    const fingerprint = rowFor('fingerprint', 'account_fingerprints');
    const dec = (value) => (value ? this.secrets.decrypt(value) : '');
    const jsonArray = (value) => {
      try { return JSON.parse(value || '[]'); } catch { return []; }
    };
    return {
      id,
      email: row.email,
      emailKey: row.email_key,
      status: row.status || '',
      source_type: row.source_type || 'unknown',
      version: Number(row.version || 1) || 1,
      openai_stage: row.openai_stage || '',
      last_error: row.last_error || '',
      sub2api_pushed: Boolean(Number(row.sub2api_pushed || 0)),
      sub2api_pushed_at: row.sub2api_pushed_at || '',
      sub2api_push_source: row.sub2api_push_source || '',
      sub2api_account_id: row.sub2api_account_id || null,
      business_sub2api_pushed: Boolean(Number(row.business_sub2api_pushed || 0)),
      business_sub2api_pushed_at: row.business_sub2api_pushed_at || '',
      business_sub2api_push_source: row.business_sub2api_push_source || '',
      business_sub2api_account_id: row.business_sub2api_account_id || null,
      password: dec(mail.password_enc),
      raw: dec(mail.raw_enc),
      openai_password: dec(profile.openai_password_enc),
      openai_name: profile.openai_name || '',
      openai_birthdate: profile.openai_birthdate || '',
      two_factor_secret: dec(profile.two_factor_secret_enc),
      session_access_token: dec(session.access_token_enc),
      session_json: dec(session.session_json_enc),
      storage_state_path: session.storage_state_path || '',
      storage_state_json: dec(session.storage_state_json_enc),
      session_health: session.health || '',
      session_health_checked_at: session.health_checked_at || '',
      session_health_detail: session.health_detail || '',
      plus_trial_eligible: session.plus_trial_eligible == null ? null : Boolean(Number(session.plus_trial_eligible)),
      plus_trial_campaign: session.plus_trial_campaign || '',
      plus_trial_country: session.plus_trial_country || '',
      plus_trial_checked_at: session.plus_trial_checked_at || '',
      plus_trial_detail: session.plus_trial_detail || '',
      openai_rt: dec(oauth.refresh_token_enc),
      openai_access_token: dec(oauth.access_token_enc),
      openai_id_token: dec(oauth.id_token_enc),
      openai_account_id: oauth.openai_account_id || '',
      openai_token_expires_at: Number(oauth.token_expires_at || 0) || 0,
      agent_runtime_id: agent.runtime_id || '',
      agent_private_key: dec(agent.private_key_enc),
      agent_account_id: agent.agent_account_id || '',
      agent_user_id: agent.agent_user_id || '',
      agent_plan_type: agent.plan_type || '',
      agent_is_fedramp: Boolean(agent.is_fedramp),
      business_workspace_id: business.workspace_id || '',
      business_join_status: business.join_status || 'none',
      business_join_requested_at: business.join_requested_at || '',
      business_join_error: business.join_error || '',
      business_openai_rt: dec(business.refresh_token_enc),
      business_openai_access_token: dec(business.access_token_enc),
      business_openai_id_token: dec(business.id_token_enc),
      business_openai_account_id: business.openai_account_id || '',
      business_openai_token_expires_at: Number(business.token_expires_at || 0) || 0,
      business_join_requests: jsonArray(business.join_requests_json),
      business_workspace_credentials: jsonArray(business.workspace_credentials_json),
      auth_phone_number: sms.phone_number || '',
      auth_phone_sms_url: dec(sms.sms_url_enc),
      sms_provider: sms.provider || '',
      sms_activation_id: sms.activation_id || '',
      sms_activation_status: sms.status || '',
      last_sms_code: sms.last_code || '',
      last_sms_at: sms.last_sms_at || '',
      fingerprint_json: fingerprint.fingerprint_json || '',
      fingerprint_region: (() => { try { return JSON.parse(fingerprint.fingerprint_json || '{}')?.region || ''; } catch { return ''; } })(),
      egress_country: fingerprint.egress_country || '',
      egress_ip: fingerprint.egress_ip || '',
      egress_source: fingerprint.egress_source || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #upsertAccount(account, stamp = nowIso()) {
    const enc = (value) => (value ? this.secrets.encrypt(String(value)) : '');
    const id = String(account.id || '').trim();
    if (!id) throw new Error('账号缺少 id');
    this.db.prepare(`
      INSERT INTO accounts(id, email, email_key, source_type, status, version, created_at, updated_at,
        openai_stage, last_error, sub2api_pushed, sub2api_pushed_at, sub2api_push_source, sub2api_account_id,
        business_sub2api_pushed, business_sub2api_pushed_at, business_sub2api_push_source, business_sub2api_account_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email, email_key = excluded.email_key, source_type = excluded.source_type,
        status = excluded.status, version = excluded.version, created_at = excluded.created_at,
        updated_at = excluded.updated_at, openai_stage = excluded.openai_stage, last_error = excluded.last_error,
        sub2api_pushed = excluded.sub2api_pushed, sub2api_pushed_at = excluded.sub2api_pushed_at,
        sub2api_push_source = excluded.sub2api_push_source, sub2api_account_id = excluded.sub2api_account_id,
        business_sub2api_pushed = excluded.business_sub2api_pushed,
        business_sub2api_pushed_at = excluded.business_sub2api_pushed_at,
        business_sub2api_push_source = excluded.business_sub2api_push_source,
        business_sub2api_account_id = excluded.business_sub2api_account_id
    `).run(
      id,
      String(account.email || '').trim(),
      String(account.emailKey || account.email || '').trim().toLowerCase(),
      account.source_type || account.sourceType || inferSourceType(account),
      account.status || '',
      Number(account.version || 1) || 1,
      account.createdAt || stamp,
      account.updatedAt || stamp,
      account.openai_stage || '',
      account.last_error || '',
      account.sub2api_pushed ? 1 : 0,
      account.sub2api_pushed_at || '',
      account.sub2api_push_source || '',
      account.sub2api_account_id || '',
      account.business_sub2api_pushed ? 1 : 0,
      account.business_sub2api_pushed_at || '',
      account.business_sub2api_push_source || '',
      account.business_sub2api_account_id || '',
    );
    this.db.prepare(`
      INSERT OR REPLACE INTO mail_credentials(account_id, password_enc, raw_enc)
      VALUES (?, ?, ?)
    `).run(id, enc(account.password), enc(account.raw));
    this.db.prepare(`
      INSERT OR REPLACE INTO openai_profiles(account_id, openai_password_enc, openai_name, openai_birthdate, two_factor_secret_enc)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, enc(account.openai_password), account.openai_name || '', account.openai_birthdate || '', enc(account.two_factor_secret));
    this.db.prepare(`
      INSERT OR REPLACE INTO sessions(account_id, access_token_enc, session_json_enc, storage_state_path, storage_state_json_enc, health, health_checked_at, health_detail, plus_trial_eligible, plus_trial_campaign, plus_trial_country, plus_trial_checked_at, plus_trial_detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, enc(account.session_access_token), enc(account.session_json), account.storage_state_path || '', enc(account.storage_state_json), account.session_health || '', account.session_health_checked_at || '', account.session_health_detail || '', account.plus_trial_eligible === true ? 1 : (account.plus_trial_eligible === false ? 0 : null), account.plus_trial_campaign || '', account.plus_trial_country || '', account.plus_trial_checked_at || '', account.plus_trial_detail || '');
    this.db.prepare(`
      INSERT OR REPLACE INTO oauth_credentials(account_id, refresh_token_enc, access_token_enc, id_token_enc, openai_account_id, token_expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, enc(account.openai_rt), enc(account.openai_access_token), enc(account.openai_id_token), account.openai_account_id || '', Number(account.openai_token_expires_at || 0) || 0);
    this.db.prepare(`
      INSERT OR REPLACE INTO agent_identities(account_id, runtime_id, private_key_enc, agent_account_id, agent_user_id, plan_type, is_fedramp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, account.agent_runtime_id || '', enc(account.agent_private_key), account.agent_account_id || '', account.agent_user_id || '', account.agent_plan_type || '', account.agent_is_fedramp ? 1 : 0);
    this.db.prepare(`
      INSERT OR REPLACE INTO business_credentials(account_id, workspace_id, join_status, join_requested_at, join_error, refresh_token_enc, access_token_enc, id_token_enc, openai_account_id, token_expires_at, join_requests_json, workspace_credentials_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, account.business_workspace_id || '', account.business_join_status || 'none', account.business_join_requested_at || '', account.business_join_error || '', enc(account.business_openai_rt), enc(account.business_openai_access_token), enc(account.business_openai_id_token), account.business_openai_account_id || '', Number(account.business_openai_token_expires_at || 0) || 0, JSON.stringify(account.business_join_requests || []), JSON.stringify(account.business_workspace_credentials || []));
    this.db.prepare(`
      INSERT OR REPLACE INTO sms_activations(account_id, provider, activation_id, status, phone_number, sms_url_enc, last_code, last_sms_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, account.sms_provider || '', account.sms_activation_id || '', account.sms_activation_status || '', account.auth_phone_number || '', enc(account.auth_phone_sms_url), account.last_sms_code || '', account.last_sms_at || '');
    if (account.fingerprint_json || account.egress_country || account.egress_ip) {
      this.db.prepare(`
        INSERT INTO account_fingerprints(account_id, fingerprint_json, egress_country, egress_ip, egress_source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET fingerprint_json = excluded.fingerprint_json, egress_country = excluded.egress_country, egress_ip = excluded.egress_ip, egress_source = excluded.egress_source, updated_at = excluded.updated_at
      `).run(id, account.fingerprint_json || '{}', account.egress_country || '', account.egress_ip || '', account.egress_source || '', account.fingerprint_created_at || stamp, stamp);
    } else {
      this.db.prepare('DELETE FROM account_fingerprints WHERE account_id = ?').run(id);
    }
  }

  #upsertMail(accountId, imported) {
    this.db.prepare(`
      INSERT INTO mail_credentials(account_id, password_enc, raw_enc)
      VALUES (?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        password_enc = COALESCE(excluded.password_enc, mail_credentials.password_enc),
        raw_enc = COALESCE(excluded.raw_enc, mail_credentials.raw_enc)
    `).run(
      accountId,
      imported.password != null ? this.secrets.encrypt(imported.password) : null,
      imported.raw ? this.secrets.encrypt(imported.raw) : null,
    );
  }

  #upsertProfile(accountId, imported) {
    this.db.prepare(`
      INSERT INTO openai_profiles(account_id, openai_password_enc, openai_name, openai_birthdate, two_factor_secret_enc)
      VALUES (?, ?, '', '', ?)
      ON CONFLICT(account_id) DO UPDATE SET
        openai_password_enc = COALESCE(excluded.openai_password_enc, openai_profiles.openai_password_enc),
        two_factor_secret_enc = COALESCE(excluded.two_factor_secret_enc, openai_profiles.two_factor_secret_enc)
    `).run(
      accountId,
      (imported.openai_password || (imported.mode === 'password_totp' ? imported.password : ''))
        ? this.secrets.encrypt(imported.openai_password || imported.password || '')
        : null,
      imported.two_factor_secret ? this.secrets.encrypt(imported.two_factor_secret) : null,
    );
  }

  #upsertOauth(accountId, values) {
    this.db.prepare(`
      INSERT INTO oauth_credentials(account_id, refresh_token_enc, access_token_enc, id_token_enc, openai_account_id, token_expires_at)
      VALUES (?, ?, '', '', '', 0)
      ON CONFLICT(account_id) DO UPDATE SET refresh_token_enc = excluded.refresh_token_enc
    `).run(accountId, values.refresh_token ? this.secrets.encrypt(values.refresh_token) : '');
  }

  #upsertSms(accountId, imported) {
    this.db.prepare(`
      INSERT INTO sms_activations(account_id, provider, activation_id, status, phone_number, sms_url_enc, last_code, last_sms_at)
      VALUES (?, '', '', '', ?, ?, '', '')
      ON CONFLICT(account_id) DO UPDATE SET
        phone_number = COALESCE(excluded.phone_number, sms_activations.phone_number),
        sms_url_enc = COALESCE(excluded.sms_url_enc, sms_activations.sms_url_enc)
    `).run(
      accountId,
      imported.auth_phone_number || '',
      imported.auth_phone_sms_url ? this.secrets.encrypt(imported.auth_phone_sms_url) : null,
    );
  }

  #toPublic(row) {
    const hasRt = row.has_rt == null ? Boolean(row.openai_rt) : Boolean(row.has_rt);
    const hasAgent = row.has_agent == null ? Boolean(row.agent_runtime_id) : Boolean(row.has_agent);
    const hasSession = row.has_session == null ? Boolean(row.session_access_token) : Boolean(row.has_session);
    return {
      id: row.id,
      email: row.email,
      sourceType: row.source_type,
      status: row.status || '',
      version: row.version,
      hasOpenAiRt: hasRt,
      hasAgentIdentity: hasAgent,
      hasChatGptSession: hasSession,
      sessionHealth: row.session_health || '',
      sessionHealthCheckedAt: row.session_health_checked_at || '',
      sessionHealthDetail: row.session_health_detail || '',
      businessWorkspaceId: row.business_workspace_id || '',
      businessJoinStatus: row.business_join_status || 'none',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
