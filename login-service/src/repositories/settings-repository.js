export const SETTINGS_KEYS = Object.freeze({
  app: 'appSettings',
  smsbower: 'smsbowerSettings',
  yescaptcha: 'yescaptchaSettings',
  protocol: 'protocolSettings',
  sub2api: 'sub2apiSettings',
});

const SENSITIVE_FIELDS_BY_KEY = Object.freeze({
  [SETTINGS_KEYS.smsbower]: ['apiKey', 'smsbowerApiKey', 'manualApiKey'],
  [SETTINGS_KEYS.yescaptcha]: ['apiKey'],
  [SETTINGS_KEYS.protocol]: ['proxyPool'],
  [SETTINGS_KEYS.sub2api]: ['adminApiKey'],
});

function clone(value) {
  return structuredClone(value ?? {});
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value;
}

/** Settings are held only in the owning in-memory runtime; defaults come from .env. */
export class SettingsRepository {
  constructor(db, secretStore, {
    runtimePaths = {},
    defaults = {},
    normalizers = {},
    now = () => new Date().toISOString(),
  } = {}) {
    if (!db?.prepare) throw new TypeError('db is required');
    if (!secretStore) throw new TypeError('secretStore is required');
    this.db = db;
    this.secretStore = secretStore;
    this.defaults = defaults;
    this.normalizers = normalizers;
    this.now = now;
    this.cache = new Map();
    this.initialization = null;
    this.writeQueue = Promise.resolve();
    this.selectStatement = db.prepare('SELECT value_json FROM settings WHERE key = ?');
    this.upsertStatement = db.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `);
  }

  async initialize() {
    if (!this.initialization) this.initialization = this.#initialize();
    return this.initialization;
  }

  async #initialize() {
    const report = { imported: [], loaded: [], defaulted: [], encrypted: [] };
    for (const key of Object.values(SETTINGS_KEYS)) {
      const row = this.selectStatement.get(key);
      if (row) {
        const stored = requireObject(JSON.parse(row.value_json), `settings.${key}`);
        const decrypted = this.#decryptSensitive(key, stored);
        const normalized = this.#normalize(key, decrypted.value);
        this.cache.set(key, normalized);
        if (decrypted.upgraded) {
          this.#persist(key, normalized);
          report.encrypted.push(key);
        }
        report.loaded.push(key);
        continue;
      }

      const value = this.#normalize(key, this.defaults[key]);
      this.#persist(key, value);
      this.cache.set(key, value);
      report.defaulted.push(key);
    }
    return report;
  }

  get(key) {
    this.#assertKnownKey(key);
    if (!this.cache.has(key)) throw new Error('SettingsRepository.initialize() must complete before get()');
    return clone(this.cache.get(key));
  }

  async set(key, value, { clearSensitive = [] } = {}) {
    this.#assertKnownKey(key);
    await this.initialize();
    const explicitClears = new Set(Array.isArray(clearSensitive) ? clearSensitive : []);
    const operation = this.writeQueue.then(() => {
      // Secrets are write-only at the API boundary. Preserve an existing
      // value when callers submit a partial update or a blank secret field.
      const normalized = this.#normalize(key, this.#mergeWriteOnly(key, value, explicitClears));
      this.#persist(key, normalized);
      this.cache.set(key, normalized);
      return clone(normalized);
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  #normalize(key, value) {
    const merged = { ...clone(this.defaults[key]), ...clone(requireObject(value ?? {}, `settings.${key}`)) };
    const normalize = this.normalizers[key];
    return clone(normalize ? requireObject(normalize(merged), `normalized settings.${key}`) : merged);
  }

  #mergeWriteOnly(key, value, explicitClears = new Set()) {
    const patch = requireObject(value ?? {}, `settings.${key}`);
    const current = this.cache.get(key) || {};
    const merged = { ...clone(patch) };
    for (const field of SENSITIVE_FIELDS_BY_KEY[key] || []) {
      const clearField = `clear${field[0].toUpperCase()}${field.slice(1)}`;
      const clearSnake = `clear_${field.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`)}`;
      const clear = explicitClears.has(field) || merged[clearField] === true || merged[clearSnake] === true;
      delete merged[clearField];
      delete merged[clearSnake];
      if (clear) {
        merged[field] = '';
      } else if (!Object.hasOwn(merged, field) || String(merged[field] ?? '').trim() === '') {
        if (current[field]) merged[field] = current[field];
        else delete merged[field];
      }
    }
    return merged;
  }

  #persist(key, value) {
    this.upsertStatement.run(key, JSON.stringify(this.#encryptSensitive(key, clone(value))), this.now());
  }

  #encryptSensitive(key, value) {
    const copy = clone(value);
    for (const field of SENSITIVE_FIELDS_BY_KEY[key] || []) {
      if (copy[field]) copy[field] = this.secretStore.encrypt(String(copy[field]));
    }
    return copy;
  }

  #decryptSensitive(key, value) {
    const copy = clone(value);
    let upgraded = false;
    for (const field of SENSITIVE_FIELDS_BY_KEY[key] || []) {
      if (!copy[field]) continue;
      const text = String(copy[field]);
      if (!text.startsWith('v1:')) upgraded = true;
      copy[field] = this.secretStore.decrypt(text);
    }
    return { value: copy, upgraded };
  }

  #assertKnownKey(key) {
    if (!Object.values(SETTINGS_KEYS).includes(key)) throw new Error(`Unknown settings key: ${key}`);
  }
}
