import { createHash } from 'node:crypto';
import { Sub2ApiClient } from './sub2api-client.js';
import { assertSub2ApiAccountShape } from './export-sub2api.js';
import { configuredTaskConcurrency } from './batch-concurrency.js';
import { runAccountTask } from './task-concurrency.js';
import { monitorCoordinator } from '../src/services/monitor-coordinator.js';

export function normalizePushUrl(value, target) {
  let text = String(value || '').trim();
  if (!text) throw new Error('请填写推送地址');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  const url = new URL(text);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search) throw new Error('推送地址必须是 HTTP(S) 服务地址，不能包含密码或查询参数');
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '').replace(target === 'cpa'
    ? /\/(?:management\.html|v0\/management(?:\/auth-files)?)$/i
    : /\/(?:admin|login|dashboard|api(?:\/v1)?(?:\/admin)?)$/i, '');
  return url.href.replace(/\/+$/, '');
}

export function sub2PushResults(data, accounts) {
  return accounts.map((account, index) => {
    const row = data?.results?.[index];
    const status = row?.success === true ? 'success' : row?.success === false ? 'failed'
      : data?.success === accounts.length && Number(data?.failed || 0) === 0 ? 'success' : 'unknown';
    return { index, name: String(account.name || `账号 ${index + 1}`), status,
      ...(status === 'failed' ? { error: 'Sub2API 拒绝导入此账号，请检查分组和账号参数' } : {}),
      ...(status === 'unknown' ? { error: '远端未确认结果，请先在目标服务核对，避免重复导入' } : {}) };
  });
}

export function cpaFileName(account) {
  const id = String(account.account_id || account.chatgpt_account_id || '');
  const email = String(account.email || account.name || 'account');
  const suffix = createHash('sha256').update(JSON.stringify([email, id])).digest('hex').slice(0, 16);
  return `codex-${email.replace(/[^a-zA-Z0-9@._-]/g, '_').slice(0, 80)}-${suffix}.json`;
}

export class CpaClient {
  constructor(baseUrl, managementKey, { fetchImpl = fetch, signal, timeoutMs = 60_000 } = {}) {
    this.baseUrl = normalizePushUrl(baseUrl, 'cpa');
    this.key = String(managementKey || '').trim();
    if (!this.key) throw new Error('请填写 CPA Management Key');
    this.fetchImpl = fetchImpl;
    this.signal = signal;
    this.timeoutMs = timeoutMs;
  }
  async request(method, suffix = '', body) {
    const response = await this.fetchImpl(`${this.baseUrl}/v0/management/auth-files${suffix}`, {
      method, redirect: 'error', headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMs)].filter(Boolean)),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(`CPA 管理接口 HTTP ${response.status}`), { status: response.status });
    }
    return response.json();
  }
  async check() {
    const data = await this.request('GET');
    if (!Array.isArray(data?.files)) throw new Error('CPA 地址未返回认证文件列表，请检查管理接口地址');
    return { ok: true, files: data.files.length };
  }
  async upload(account) {
    const name = cpaFileName(account);
    const data = await this.request('POST', `?name=${encodeURIComponent(name)}`, account);
    if (data?.status !== 'ok') throw new Error('CPA 未确认文件导入，请在目标服务核对');
    return name;
  }
}

// These routes bypass the request-scoped SQLite repositories entirely.
export function registerRemotePushRoutes(app, { fetchImpl = fetch } = {}) {
  const route = (path, handler) => app.post(`/api/push/${path}`, async (req, res) => {
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    res.setHeader('Cache-Control', 'no-store');
    try {
      const body = req.body || {};
      const run = () => handler(body, controller.signal);
      res.json(await (body.monitorOwner && ['sub2api', 'cpa'].includes(path)
        ? monitorCoordinator.run((body.accounts || []).map(account => account?.credentials?.email || account?.email || ''), body.monitorOwner, run)
        : run()));
    }
    catch (error) {
      if (error.code === 'MONITOR_LEASE_LOST') {
        if (!res.destroyed) res.status(409).json({ ok: false, code: error.code, detail: error.message });
        return;
      }
      if (!res.destroyed) res.status(400).json({ ok: false,
        error: error.validation ? error.message : error.status ? `远端管理接口 HTTP ${error.status}` : '推送请求失败，请检查地址、管理密钥和网络连接',
        code: error.validation ? 'INVALID_PUSH_PAYLOAD' : undefined, detail: error.validation ? error.message : undefined });
    } finally { req.body = undefined; }
  });
  const sub2Client = (settings, signal) => new Sub2ApiClient(normalizePushUrl(settings.baseUrl, 'sub2api'), settings.adminApiKey, { fetchImpl, signal });
  route('sub2api/groups', async ({ settings = {} }, signal) => {
    const groups = await sub2Client(settings, signal).listGroups();
    return { ok: true, groups: groups.filter(group => !group.platform || group.platform === 'openai').map(group => ({ id: group.id, name: group.name, platform: group.platform, account_count: group.account_count || 0 })) };
  });
  route('cpa/check', ({ settings = {} }, signal) => new CpaClient(settings.baseUrl, settings.managementKey, { fetchImpl, signal }).check());
  for (const target of ['sub2api', 'cpa']) route(target, async ({ settings = {}, accounts, upsert = false }, signal) => {
    const invalid = message => { throw Object.assign(new Error(message), { validation: true }); };
    if (!Array.isArray(accounts) || !accounts.length || accounts.length > 2000) invalid('请提供 1–2000 个账号');
    for (const [index, account] of accounts.entries()) {
      if (!account || typeof account !== 'object' || Array.isArray(account)) invalid('账号格式无效');
      if (target === 'sub2api') {
        try { assertSub2ApiAccountShape(account, { requireRefreshToken: false }); }
        catch (error) { invalid(`第 ${index + 1} 个 Sub2API 账号：${error.message}`); }
      }
      else if (account.type !== 'codex' || !String(account.access_token || '').trim()) invalid('CPA 需要 type=codex 和 access_token');
    }
    let results;
    if (target === 'sub2api') {
      if (!Array.isArray(settings.groupIds) || !settings.groupIds.length || settings.groupIds.some(id => !Number.isSafeInteger(id) || id <= 0)) invalid('请选择 Sub2API 推送分组');
      const client = sub2Client(settings, signal);
      if (upsert === true) {
        results = [];
        for (const [index, account] of accounts.entries()) {
          signal.throwIfAborted();
          try {
            const row = await runAccountTask(() => client.upsertAccount(account, settings.groupIds), { signal });
            results.push({ ...sub2PushResults({ results: [row] }, [account])[0], index });
          } catch (error) {
            signal.throwIfAborted();
            results.push({ index, name: account.name, status: error.status ? 'failed' : 'unknown', error: error.status === 409 ? '目标分组存在重复账号，请先合并后重试' : 'Sub2API 自动更新未完成，请在目标服务核对' });
          }
        }
      } else {
        const data = await runAccountTask(() => client.importAccounts(accounts, settings.groupIds), { signal });
        results = sub2PushResults(data, accounts);
      }
    } else {
      const client = new CpaClient(settings.baseUrl, settings.managementKey, { fetchImpl, signal });
      results = new Array(accounts.length);
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(configuredTaskConcurrency(), accounts.length) }, async () => {
        while (cursor < accounts.length) {
          signal.throwIfAborted();
          const index = cursor++;
          try {
            const name = await runAccountTask(() => client.upload(accounts[index]), { signal });
            results[index] = { index, name, status: 'success' };
          } catch (error) {
            signal.throwIfAborted();
            results[index] = { index, name: cpaFileName(accounts[index]), status: error.status ? 'failed' : 'unknown',
              error: error.status ? `CPA 管理接口 HTTP ${error.status}` : '远端未确认结果，请在 CPA 中核对文件' };
          }
        }
      }));
    }
    const imported = results.filter(row => row.status === 'success').length;
    return { ok: imported === accounts.length, imported, failed: results.filter(row => row.status === 'failed').length, unknown: results.filter(row => row.status === 'unknown').length, results };
  });
}
