import { createHash } from 'node:crypto';
import { Sub2ApiClient } from './sub2api-client.js';
import { assertSub2ApiAccountShape } from './export-sub2api.js';
import { configuredTaskConcurrency } from './batch-concurrency.js';
import { runAccountTask } from './task-concurrency.js';
import { monitorCoordinator } from '../src/services/monitor-coordinator.js';
import { pushCoordinator } from '../src/services/push-coordinator.js';
import { requestSignal } from '../src/services/request-scope.js';
import { normalizeItemIds, normalizeOperationId, operationMetadata } from '../../docs/operation-contract.js';

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
    return { index, name: String(account.name || `账号 ${index + 1}`), status, retryable: status === 'failed',
      code: status === 'success' ? 'REMOTE_CONFIRMED' : status === 'failed' ? 'REMOTE_REJECTED' : 'REMOTE_RESULT_UNKNOWN',
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

function pushFailure(error, { started = true } = {}) {
  const rejected = !started || (error.status >= 400 && error.status < 500 && error.status !== 408);
  return { status: rejected ? 'failed' : 'unknown', retryable: rejected && error.status !== 409,
    code: !started ? error.code || 'PUSH_NOT_STARTED' : rejected ? 'REMOTE_REJECTED' : 'REMOTE_RESULT_UNKNOWN',
    error: error.status === 409 ? '目标分组存在重复账号，请先合并后重试'
      : !started ? '请求尚未发送到目标服务，可以稍后重试'
        : rejected ? `远端管理接口 HTTP ${error.status}` : '远端未确认结果，请先核对，避免重复推送' };
}

function pushSummary(results, operationId, itemIds) {
  const imported = results.filter(row => row.status === 'success').length;
  return { ...operationMetadata(operationId), ok: imported === results.length, imported,
    failed: results.filter(row => row.status === 'failed').length,
    unknown: results.filter(row => row.status === 'unknown').length,
    results: results.map((row, index) => ({ ...row, index, itemId: itemIds[index] })) };
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
      signal: AbortSignal.any([this.signal, requestSignal(), AbortSignal.timeout(this.timeoutMs)].filter(Boolean)),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(`CPA 管理接口 HTTP ${response.status}`), { status: response.status });
    }
    return response.json();
  }
  async check() {
    return { ok: true, files: (await this.listFiles()).length };
  }
  async listFiles() {
    const data = await this.request('GET');
    if (!Array.isArray(data?.files)) throw new Error('CPA 地址未返回认证文件列表，请检查管理接口地址');
    const names = data.files.map(file => file?.name);
    if (names.some(name => typeof name !== 'string' || !name.trim()) || new Set(names).size !== names.length
      || (data.total != null && data.total !== names.length) || data.has_more === true || data.hasMore === true || data.next_cursor || data.nextCursor) {
      throw new Error('CPA 未返回完整认证文件列表');
    }
    return data.files;
  }
  async reconcile(account, files) {
    const name = cpaFileName(account);
    if (!files.some(file => file.name === name)) return { status: 'failed', retryable: true, code: 'REMOTE_NOT_FOUND', error: '已确认 CPA 中不存在该文件，可以重试' };
    // A matching filename alone cannot prove that a token refresh was applied.
    const stored = await this.request('GET', `/download?name=${encodeURIComponent(name)}`);
    const expectedId = account.account_id || account.chatgpt_account_id;
    const sameAccount = (!expectedId || String(stored?.account_id || stored?.chatgpt_account_id || '') === String(expectedId))
      && (!account.email || String(stored?.email || '').trim().toLowerCase() === String(account.email).trim().toLowerCase());
    if (stored?.type === 'codex' && sameAccount && ['access_token', 'refresh_token', 'id_token'].every(field => !account[field] || stored[field] === account[field])) {
      return { status: 'success', retryable: false, code: 'REMOTE_CONFIRMED' };
    }
    return { status: 'unknown', retryable: false, code: 'REMOTE_VERSION_UNCONFIRMED', error: 'CPA 文件已存在，但无法确认是此次推送的凭据' };
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
      normalizeOperationId(body.operationId);
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
      if (!res.destroyed) res.status(error.code === 'INVALID_OPERATION_RESPONSE' ? 400 : error.code?.endsWith('TIMEOUT') ? 503 : 400).json({ ok: false,
        error: error.validation ? error.message : error.status ? `远端管理接口 HTTP ${error.status}` : '推送请求失败，请检查地址、管理密钥和网络连接',
        code: error.validation || error.code === 'INVALID_OPERATION_RESPONSE' ? 'INVALID_PUSH_PAYLOAD' : error.code || 'PUSH_REQUEST_FAILED', detail: error.validation ? error.message : undefined });
    } finally { req.body = undefined; }
  });
  const sub2Client = (settings, signal) => new Sub2ApiClient(normalizePushUrl(settings.baseUrl, 'sub2api'), settings.adminApiKey, { fetchImpl, signal });
  route('sub2api/groups', async ({ settings = {} }, signal) => {
    const groups = await sub2Client(settings, signal).listGroups();
    return { ok: true, groups: groups.filter(group => !group.platform || group.platform === 'openai').map(group => ({ id: group.id, name: group.name, platform: group.platform, account_count: group.account_count || 0 })) };
  });
  route('sub2api/proxies', async ({ settings = {} }, signal) => {
    const proxies = await sub2Client(settings, signal).listProxies();
    return { ok: true, proxies: proxies.map(proxy => ({
      id: Number(proxy.id ?? proxy.proxy_id),
      name: String(proxy.name || proxy.label || proxy.host || `代理 ${proxy.id ?? proxy.proxy_id}`),
      host: String(proxy.host || proxy.hostname || ''),
      port: Number(proxy.port || 0),
    })).filter(proxy => Number.isSafeInteger(proxy.id) && proxy.id > 0) };
  });
  route('cpa/check', ({ settings = {} }, signal) => new CpaClient(settings.baseUrl, settings.managementKey, { fetchImpl, signal }).check());
  for (const target of ['sub2api', 'cpa']) for (const reconcile of [false, true]) route(reconcile ? `${target}/reconcile` : target, async ({ settings = {}, accounts, upsert = false, operationId, itemIds }, signal) => {
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
    itemIds = normalizeItemIds(itemIds, accounts.length);
    const baseUrl = normalizePushUrl(settings.baseUrl, target);
    let pushAccounts = accounts;
    if (target === 'sub2api') {
      if (!Array.isArray(settings.groupIds) || !settings.groupIds.length || settings.groupIds.some(id => !Number.isSafeInteger(id) || id <= 0)) invalid('请选择 Sub2API 推送分组');
      if (settings.useProxy === true || settings.proxyEnabled === true) {
        const proxyId = Number(settings.proxyId ?? settings.proxy_id);
        if (!Number.isSafeInteger(proxyId) || proxyId <= 0) invalid('请选择 Sub2API 代理');
        pushAccounts = accounts.map(account => ({ ...account, proxy_id: proxyId }));
      }
    }
    // Acquire the whole operation's keys in stable order before scanning the
    // destination. Its request-local lookup cache then cannot race another local
    // request that is creating/updating one of these same accounts.
    let entered = false;
    try {
      return await pushCoordinator.run(target, baseUrl, accounts, async () => {
        entered = true;
        const client = target === 'sub2api' ? sub2Client(settings, signal) : new CpaClient(baseUrl, settings.managementKey, { fetchImpl, signal });
        let results;
        if (reconcile) {
          let files;
          if (target === 'cpa') files = await runAccountTask(() => client.listFiles(), { signal });
          results = [];
          for (const [index, account] of accounts.entries()) {
            signal.throwIfAborted();
            try {
              const result = await runAccountTask(() => target === 'sub2api'
                ? client.reconcileAccount(pushAccounts[index], settings.groupIds) : client.reconcile(account, files), { signal });
              results.push({ index, name: account.name || cpaFileName(account), ...result });
            } catch {
              signal.throwIfAborted();
              results.push({ index, name: account.name || cpaFileName(account), status: 'unknown', retryable: false, code: 'REMOTE_RECONCILE_FAILED', error: '无法完整核对目标，请在目标服务确认后再操作' });
            }
          }
        } else if (target === 'sub2api' && upsert !== true) {
          let started = false;
          try {
            const data = await runAccountTask(() => { started = true; return client.importAccounts(pushAccounts, settings.groupIds); }, { signal });
            results = sub2PushResults(data, accounts);
          } catch (error) {
            signal.throwIfAborted();
            results = accounts.map((account, index) => ({ index, name: account.name, ...pushFailure(error, { started }) }));
          }
        } else {
          results = new Array(accounts.length);
          let cursor = 0;
          const concurrency = target === 'sub2api' ? 1 : configuredTaskConcurrency();
          await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, async () => {
            while (cursor < accounts.length) {
              signal.throwIfAborted();
              const index = cursor++;
              const account = accounts[index];
              let started = false;
              try {
                const value = await runAccountTask(() => {
                  started = true;
                  return target === 'sub2api' ? client.upsertAccount(pushAccounts[index], settings.groupIds) : client.upload(account);
                }, { signal });
                results[index] = target === 'sub2api' ? { ...sub2PushResults({ results: [value] }, [account])[0], index }
                  : { index, name: value, status: 'success', retryable: false, code: 'REMOTE_CONFIRMED' };
              } catch (error) {
                signal.throwIfAborted();
                results[index] = { index, name: account.name || cpaFileName(account), ...pushFailure(error, { started }) };
              }
            }
          }));
        }
        return pushSummary(results, operationId, itemIds);
      }, { signal });
    } catch (error) {
      signal.throwIfAborted();
      if (entered && !reconcile) throw error;
      const result = reconcile ? { status: 'unknown', retryable: false, code: 'REMOTE_RECONCILE_FAILED', error: '无法完整核对目标，请稍后再核对' }
        : pushFailure(error, { started: false });
      return pushSummary(accounts.map((account, index) => ({ index, name: account.name || cpaFileName(account), ...result })), operationId, itemIds);
    }
  });
}
