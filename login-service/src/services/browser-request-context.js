import { requests } from './request-scope.js';
import { createSqliteRuntime } from '../bootstrap/sqlite-runtime.js';
import { SettingsRepository } from '../repositories/settings-repository.js';
import { normalizeDbAccount } from '../domain/accounts/account-domain.js';
import { browserRoutePolicy } from '../api/request-policy.js';
import { operationMetadata } from '../../../docs/operation-contract.js';
import { sendOperationError } from '../http/operation-error.js';
import { withinDeadline } from '../../lib/execution-limits.js';

export function browserRequestMiddleware({ settings, createPushService, strictRoutes = false, createRuntime = createSqliteRuntime }) {
  return async (req, res, next) => {
    if (!req.path.startsWith('/api/v2/')) return next();
    if (strictRoutes) {
      const policy = browserRoutePolicy(req.path, req.method);
      if (policy.jobs) return res.json({ ok: true, jobs: [] });
      if (policy.status) return res.status(policy.status).json({ ok: false, code: policy.code, error: policy.status === 410 ? '浏览器存储模式不保留后台任务，请使用实时处理接口' : '接口不存在' });
      if (!policy.context) return next();
    }
    // Background jobs would retain user data after the request has completed.
    if (req.path === '/api/v2/jobs' && req.method === 'GET') return res.json({ ok: true, jobs: [] });
    if (req.path.startsWith('/api/v2/jobs')) return res.status(410).json({ ok: false, error: '浏览器存储模式不保留后台任务，请使用实时处理接口' });
    const input = req.body?.browserState || {};
    if (!Array.isArray(input.accounts ?? []) || (input.accounts?.length || 0) > 2000) {
      return res.status(400).json({ ok: false, error: 'browserState.accounts 必须是最多 2000 个账号的数组' });
    }
    const runtime = createRuntime();
    const context = { accounts: runtime.accounts, maps: {}, closed: false, cleanups: new Set(), controller: new AbortController(), clientSettings: {}, push: createPushService() };
    const defaults = settings();
    context.settings = new SettingsRepository(runtime.db, runtime.secrets, {
      defaults: defaults.defaults, normalizers: defaults.normalizers,
    });
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      context.closed = true;
      context.controller.abort();
      const cleanupTasks = [...context.cleanups].map(cleanup => Promise.resolve().then(cleanup));
      context.cleanups.clear();
      await withinDeadline(runtime.accounts.flushWrites()).catch(() => {});
      clearTimeout(runtime.accounts.writeBatchTimer);
      for (const account of runtime.accounts.listAll()) for (const key of Object.keys(account)) delete account[key];
      runtime.accounts.state.accounts.length = 0;
      context.settings.cache.clear();
      context.clientSettings = {};
      for (const map of Object.values(context.maps)) map.clear();
      context.push.clear();
      runtime.db.close();
      runtime.secrets.key.fill(0);
      delete res.locals.browserSnapshot;
      // Express retains req/res until the socket is released; drop request data.
      req.body = undefined;
      await withinDeadline(Promise.allSettled(cleanupTasks)).catch(() => {});
    };
    res.once('finish', () => { void dispose(); });
    res.once('close', () => { void dispose(); });
    try {
      await runtime.accounts.initialize();
      const seen = new Set();
      const seenEmails = new Set();
      for (const raw of input.accounts || []) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('无效账号记录');
        const account = normalizeDbAccount(raw);
        if (!account.email?.includes('@') || seen.has(account.id) || seenEmails.has(account.emailKey)) throw new Error('账号无效或重复');
        seen.add(account.id);
        seenEmails.add(account.emailKey);
        runtime.accounts.state.accounts.push(account);
      }
      await runtime.accounts.save();
      await context.settings.initialize();
      for (const key of ['protocolSettings', 'sub2apiSettings']) {
        if (input.settings?.[key]) {
          await context.settings.set(key, input.settings[key]);
          context.clientSettings[key] = structuredClone(input.settings[key]);
        }
      }
      const settingKey = req.path === '/api/v2/admin/sub2api/settings' ? 'sub2apiSettings'
        : req.path === '/api/v2/admin/protocol/settings' ? 'protocolSettings' : '';
      if (settingKey && req.method === 'PUT') {
        const { browserState: _ignored, ...patch } = req.body;
        context.clientSettings[settingKey] = { ...context.clientSettings[settingKey], ...patch };
      }
      context.push.configure(context.settings.get('sub2apiSettings'));
      res.locals.browserSnapshot = (ids) => ({
        ...operationMetadata(res.locals.operationId, res.locals.requestId),
        accounts: structuredClone(ids ? ids.map(id => runtime.accounts.findById(id)).filter(Boolean) : runtime.accounts.listAll()),
        settings: structuredClone(context.clientSettings),
      });
      const json = res.json.bind(res);
      res.json = (payload) => res.writableEnded || res.destroyed ? res
        : json({ ...payload, browserState: res.locals.browserSnapshot?.() });
      return requests.run(context, next);
    } catch (error) {
      await dispose();
      return sendOperationError(res, error, { fallbackCode: 'INVALID_BROWSER_STATE' });
    }
  };
}
