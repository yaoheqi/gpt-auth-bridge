import { sendOperationError } from '../../http/operation-error.js';
export function registerAdminSettingsRoutes(app, deps) {
  const {
    requireAdmin, ensureDatabase, publicProtocolSettings,
    settingsRepository, publicSub2ApiSettings, createSub2ApiClient, configureSub2ApiPush,
  } = deps;

  const load = async (key) => {
    await ensureDatabase();
    await settingsRepository.initialize();
    return settingsRepository.get(key);
  };
  const save = (key, value, options = {}) => settingsRepository.set(key, value, options);

  app.get('/api/v2/admin/protocol/settings', requireAdmin, async (_req, res) => { try { const settings = await load('protocolSettings'); res.json({ ok: true, settings: publicProtocolSettings(settings) }); } catch (error) { sendOperationError(res, error); } });
  app.put('/api/v2/admin/protocol/settings', requireAdmin, async (req, res) => {
    try {
      const current = await load('protocolSettings');
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : {};
      // Proxy credentials are write-only by default. Clearing them is an
      // explicit action so a form refresh or an omitted field cannot erase a
      // working pool accidentally.
      const clearProxyPool = body.clearProxyPool === true || body.clear_proxy_pool === true;
      delete body.clearProxyPool;
      delete body.clear_proxy_pool;
      const merged = clearProxyPool ? { ...current, ...body, proxyPool: '' } : { ...current, ...body };
      const next = await save('protocolSettings', merged, {
        clearSensitive: clearProxyPool ? ['proxyPool'] : [],
      });
      res.json({ ok: true, settings: publicProtocolSettings(next) });
    } catch (error) {
      sendOperationError(res, error);
    }
  });
  app.get('/api/v2/admin/sub2api/settings', requireAdmin, async (_req, res) => { try { const settings = await load('sub2apiSettings'); res.json({ ok: true, settings: publicSub2ApiSettings(settings) }); } catch (error) { sendOperationError(res, error); } });
  app.put('/api/v2/admin/sub2api/settings', requireAdmin, async (req, res) => { try { const current = await load('sub2apiSettings'); const body = req.body || {}; const next = await save('sub2apiSettings', { ...current, ...body, adminApiKey: String(body.adminApiKey || '').trim() || current.adminApiKey }); configureSub2ApiPush?.(next); res.json({ ok: true, settings: publicSub2ApiSettings(next) }); } catch (error) { sendOperationError(res, error); } });
  if (typeof app.post === 'function') app.post('/api/v2/admin/sub2api/groups', requireAdmin, async (req, res) => { try { const current = await load('sub2apiSettings'); const baseUrl = String(req.body?.baseUrl || current.baseUrl || '').trim(); const adminApiKey = String(req.body?.adminApiKey || '').trim() || current.adminApiKey; const groups = await createSub2ApiClient({ baseUrl, adminApiKey }).listGroups(); res.json({ ok: true, groups: groups.map(group => ({ id: Number(group.id), name: String(group.name || ''), platform: String(group.platform || ''), account_count: Number(group.account_count ?? group.accountCount ?? group.accounts_count ?? 0) })).filter(group => Number.isFinite(group.id)) }); } catch (error) { sendOperationError(res, error); } });
}
