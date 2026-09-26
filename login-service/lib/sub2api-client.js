import { requestSignal } from '../src/services/request-scope.js';

export class Sub2ApiError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = 'Sub2ApiError';
    this.status = status;
    this.body = body;
  }
}

export function normalizeSub2ApiBaseUrl(value) {
  let raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) throw new Sub2ApiError('SUB2API_BASE_URL 不能为空');
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  const url = new URL(raw);
  let pathname = url.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/(?:admin|login|dashboard)$/i, '');
  if (/^\/api(?:\/v1)?$/i.test(pathname)) pathname = '';
  return `${url.origin}${pathname}`.replace(/\/+$/, '');
}

export class Sub2ApiClient {
  constructor(baseUrl, adminApiKey, { fetchImpl = fetch, timeoutMs = 120_000, signal } = {}) {
    this.baseUrl = normalizeSub2ApiBaseUrl(baseUrl);
    this.adminApiKey = String(adminApiKey || '').trim();
    if (!this.adminApiKey) throw new Sub2ApiError('SUB2API_ADMIN_API_KEY 不能为空');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.signal = signal;
  }

  async request(method, adminPath, body) {
    const path = String(adminPath || '').replace(/^\/+/, '').replace(/^api\/v1\/admin\//, '');
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/admin/${path}`, {
      method,
      redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-key': this.adminApiKey },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), this.signal, requestSignal()].filter(Boolean)),
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
    if (!response.ok) {
      throw new Sub2ApiError(`${method} ${adminPath} 失败 (HTTP ${response.status}): ${payload?.message || payload?.error || text}`, {
        status: response.status, body: payload,
      });
    }
    if (payload && Object.hasOwn(payload, 'code') && ![0, '0', null].includes(payload.code)) {
      throw new Sub2ApiError(`${method} ${adminPath} 业务错误: ${payload.message || payload.code}`, { body: payload });
    }
    return payload && Object.hasOwn(payload, 'data') ? payload.data : payload;
  }

  async resolveGroupId(groupName, platform = 'openai') {
    const name = String(groupName || '').trim();
    if (!name) throw new Sub2ApiError('SUB2API_GROUP_NAME 不能为空');
    if (/^\d+$/.test(name)) return Number(name);
    const groups = await this.listGroups();
    const group = groups.find(item => String(item?.name || '').trim() === name && (!item.platform || item.platform === platform))
      || groups.find(item => String(item?.name || '').trim().toLowerCase() === name.toLowerCase());
    if (!group?.id) throw new Sub2ApiError(`未找到 Sub2 分组「${name}」`);
    return Number(group.id);
  }

  async listGroups() {
    const data = await this.request('GET', 'groups/all');
    return Array.isArray(data) ? data : (data?.items || data?.groups || data?.list || []);
  }

  async resolveGroupIds(groupIdsOrName) {
    const values = Array.isArray(groupIdsOrName) ? groupIdsOrName : [groupIdsOrName];
    const resolved = [];
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (!text) continue;
      resolved.push(/^\d+$/.test(text) ? Number(text) : await this.resolveGroupId(text));
    }
    const unique = [...new Set(resolved)];
    if (!unique.length) throw new Sub2ApiError('Sub2 推送分组不能为空');
    return unique;
  }

  async importAccounts(accounts, groupIdsOrName) {
    if (!Array.isArray(accounts) || !accounts.length) throw new Sub2ApiError('accounts 不能为空');
    const groupIds = await this.resolveGroupIds(groupIdsOrName);
    const prepared = accounts.map(account => ({ ...account, group_ids: groupIds }));
    return this.request('POST', 'accounts/batch', { accounts: prepared });
  }

  async listProxies() {
    let data;
    try {
      data = await this.request('GET', 'proxies/all');
    } catch (error) {
      if (error?.status !== 404) throw error;
      data = await this.request('GET', 'proxies');
    }
    return Array.isArray(data) ? data : (data?.items || data?.proxies || data?.list || []);
  }

  async accountRows(groupIds) {
    // Search names may have been edited; scan selected groups once per request.
    if (!this.upsertRows) {
      const rows = new Map();
      for (const group of groupIds) {
        const groupRows = new Set();
        let expectedTotal;
        let pageSize;
        for (let page = 1; ; page++) {
          const query = new URLSearchParams({ platform: 'openai', type: 'oauth', group: String(group), page: String(page), page_size: '100' });
          const data = await this.request('GET', `accounts?${query}`);
          if (!Array.isArray(data?.items) || !Number.isInteger(data.total) || data.total < 0) throw new Sub2ApiError('Sub2API 未返回完整账号列表');
          const size = data.page_size ?? data.pageSize ?? 100;
          if (!Number.isInteger(size) || size < 1 || size > 1000 || (pageSize != null && pageSize !== size)
            || (expectedTotal != null && expectedTotal !== data.total)) throw new Sub2ApiError('Sub2API 账号列表在查询期间发生变化，请重新核对');
          expectedTotal = data.total;
          pageSize = size;
          if (data.items.length !== Math.min(pageSize, Math.max(0, expectedTotal - groupRows.size))) throw new Sub2ApiError('Sub2API 未返回完整账号列表');
          for (const row of data.items) {
            if (!Number.isSafeInteger(row.id) || row.id < 1 || groupRows.has(row.id)) throw new Sub2ApiError('远端账号列表包含无效或重复 ID');
            groupRows.add(row.id);
            rows.set(row.id, row);
          }
          if (groupRows.size === expectedTotal) break;
          if (!data.items.length || page >= 100) throw new Sub2ApiError('Sub2API 账号查询未完成，已停止自动更新');
        }
      }
      this.upsertRows = [...rows.values()];
    }
    return this.upsertRows;
  }

  async matchingAccounts(account, groupIds) {
    const email = String(account.credentials?.email || '').trim().toLowerCase();
    const accountId = String(account.credentials?.chatgpt_account_id || account.credentials?.account_id || '');
    if (!email || !accountId) throw new Sub2ApiError('核对和自动更新需要邮箱和工作区 ID', { status: 400 });
    return (await this.accountRows(groupIds)).filter(row => {
        const credentials = row.credentials || {};
        const rowGroups = row.group_ids || row.groups?.map(group => group.id) || [];
        return row.platform === 'openai' && row.type === 'oauth'
          && String(credentials.email || row.extra?.email || '').trim().toLowerCase() === email
          && String(credentials.chatgpt_account_id || credentials.account_id || '') === accountId
          && groupIds.some(id => rowGroups.includes(id));
    });
  }

  async reconcileAccount(account, groupIds) {
    const matches = await this.matchingAccounts(account, groupIds);
    if (!matches.length) return { status: 'failed', retryable: true, code: 'REMOTE_NOT_FOUND', error: '已确认所选分组中不存在该账号，可以重试' };
    if (matches.length > 1) return { status: 'unknown', retryable: false, code: 'REMOTE_AMBIGUOUS', error: '目标分组存在重复账号，请先在目标服务核对' };
    const row = matches[0];
    const tokenFields = ['access_token', 'refresh_token', 'id_token'];
    const matchesCredentials = tokenFields.every(field => !account.credentials[field] || row.credentials?.[field] === account.credentials[field]);
    const matchesProxy = !Object.hasOwn(account, 'proxy_id') || Number(row.proxy_id) === Number(account.proxy_id);
    if (matchesCredentials && matchesProxy) return { status: 'success', retryable: false, code: 'REMOTE_CONFIRMED' };
    return { status: 'unknown', retryable: false, code: 'REMOTE_VERSION_UNCONFIRMED', error: '目标账号已存在，但无法确认是此次推送的凭据，请在目标服务核对' };
  }

  async upsertAccount(account, groupIds) {
    const matches = await this.matchingAccounts(account, groupIds);
    if (matches.length > 1) throw new Sub2ApiError('目标分组存在重复账号，请先合并后重试', { status: 409 });
    if (matches.length === 1) {
      const row = matches[0];
      if (!Number.isSafeInteger(row.id) || row.id < 1) throw new Sub2ApiError('远端账号 ID 无效');
      // Preserve routing, grouping, scheduling and operator settings on existing accounts.
      const fields = ['access_token', 'refresh_token', 'id_token', 'chatgpt_account_id', 'account_id', 'chatgpt_user_id', 'email', 'expires_at', 'expires_in', 'organization_id', 'plan_type'];
      const refreshed = Object.fromEntries(fields.filter(key => Object.hasOwn(account.credentials, key)).map(key => [key, account.credentials[key]]));
      await this.request('PUT', `accounts/${row.id}`, { credentials: { ...row.credentials, ...refreshed },
        ...(Object.hasOwn(account, 'proxy_id') ? { proxy_id: account.proxy_id } : {}) });
      return { success: true };
    }
    const data = await this.importAccounts([account], groupIds);
    const result = data?.results?.[0] || { success: data?.success === 1 && !data?.failed ? true : undefined };
    if (result.success !== false) this.upsertRows.push({ ...account, id: result.id, group_ids: groupIds });
    return result;
  }
}
