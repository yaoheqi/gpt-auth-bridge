import { Sub2ApiClient } from '../../lib/sub2api-client.js';
import { assertSub2ApiAccountShape } from '../../lib/export-sub2api.js';
import { normalizeSub2ApiSettings, readSub2ApiSettingsDefaults } from '../../lib/sub2api-settings.js';
import { sub2PushResults } from '../../lib/remote-push.js';

export function readSub2ApiPushConfig(env = process.env) {
  const settings = readSub2ApiSettingsDefaults(env);
  return { ...settings, enabled: Boolean(settings.baseUrl && settings.adminApiKey && (settings.groupIds.length || settings.legacyGroupName)) };
}

// Pushes complete within the request. Retry data belongs to the browser.
export class Sub2ApiPushService {
  constructor({ env = process.env, fetchImpl = fetch } = {}) {
    this.fetchImpl = fetchImpl;
    this.config = readSub2ApiPushConfig(env);
    this.configure(this.config);
  }
  configure(settings = {}) {
    this.config = normalizeSub2ApiSettings(settings, this.config);
    this.config.enabled = Boolean(this.config.baseUrl && this.config.adminApiKey && (this.config.groupIds.length || this.config.legacyGroupName));
    this.client = this.config.enabled ? new Sub2ApiClient(this.config.baseUrl, this.config.adminApiKey, { fetchImpl: this.fetchImpl }) : null;
    return this.config;
  }
  groupTargets() { return this.config.groupIds?.length ? this.config.groupIds : this.config.legacyGroupName; }
  async enqueueImmediate(accounts = []) {
    if (!this.client || !accounts.length) return { enabled: Boolean(this.client), queued: 0, imported: 0 };
    for (const account of accounts) assertSub2ApiAccountShape(account);
    try {
      const data = await this.client.importAccounts(accounts, this.groupTargets());
      const results = sub2PushResults(data, accounts);
      const imported = results.filter(row => row.status === 'success').length;
      return { enabled: true, queued: accounts.length, imported, queueSize: 0, results,
        ...(imported < accounts.length ? { error: `远端确认导入 ${imported}/${accounts.length} 个账号` } : {}) };
    } catch (error) {
      return { enabled: true, queued: accounts.length, imported: 0, queueSize: 0, error: error.message };
    }
  }
  enqueue(accounts) { return this.enqueueImmediate(accounts); }
  start() {}
  async stop() { this.clear(); }
  clear() { this.client = null; this.config = {}; }
}
