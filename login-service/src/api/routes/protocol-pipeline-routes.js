import { mapWithConcurrency } from '../../../lib/sse.js';
import { wantsEventStream, runSseResponse } from '../batch/sse-runner.js';
import { normalizeAccountIds } from '../../services/account-selection.js';
import { normalizeProtocolPipelineMode, runProtocolLoginPipelineAccount } from '../../services/protocol-login-pipeline.js';
import { probeBrowserAccount } from '../../services/browser-session-probe.js';
import { withSessionTransport, checkSessionHealth } from '../../../../src/session-network.js';
import { requestSignal } from '../../services/request-scope.js';
import { monitorCoordinator } from '../../services/monitor-coordinator.js';

export function registerBrowserSessionProbeRoute(app, { requireAdmin, ensureDatabase, findAccountById, getSessionReloginConcurrency, protocolRequestNetwork, accountRequestNetwork, probeSessionThroughConfiguredProxy }) {
  app.post('/api/v2/accounts/monitor-lease', requireAdmin, async (req, res) => {
    try {
      await ensureDatabase();
      const accounts = normalizeAccountIds(req.body?.ids).map(findAccountById).filter(Boolean);
      if (req.body.action === 'release') {
        monitorCoordinator.release(accounts, req.body.monitorOwner);
        return res.json({ ok: true });
      }
      res.json({ ok: true, results: monitorCoordinator.claim(accounts, req.body.monitorOwner), ttlMs: monitorCoordinator.ttlMs });
    } catch (error) {
      if (!res.destroyed) res.status(400).json({ ok: false, error: error.message });
    }
  });
  app.post('/api/v2/accounts/session-probe', requireAdmin, async (req, res) => {
    try {
      await ensureDatabase();
      const accounts = normalizeAccountIds(req.body?.ids).map(findAccountById).filter(Boolean);
      if (!accounts.length) throw new Error('请先选择要测活的账号');
      const concurrency = getSessionReloginConcurrency();
      const network = protocolRequestNetwork(req.body || {});
      const owner = req.body.monitorOwner;
      const results = await mapWithConcurrency(accounts, concurrency, async account => {
        const terminalReason = owner && monitorCoordinator.stopReason(account);
        if (terminalReason) return { id: account.id, health: 'monitor_stopped', terminalReason };
        const selected = accountRequestNetwork(account, network);
        const proxy = selected.proxyPool ?? '';
        const probe = () => probeBrowserAccount(account, {
          probeSession: current => probeSessionThroughConfiguredProxy(current.session_access_token, current.storage_state_json, current.fingerprint_json, { exactProxyUrl: proxy, direct: !proxy }),
          probeToken: token => withSessionTransport(options => checkSessionHealth(token, options), { pool: proxy, signal: requestSignal() }),
        });
        try {
          const result = owner ? await monitorCoordinator.run([account.email], owner, probe) : await probe();
          if (result.health === 'deactivated') monitorCoordinator.record(account, 'account_unavailable');
          return result;
        } catch (error) {
          if (error.code === 'MONITOR_LEASE_LOST') return { id: account.id, health: 'monitor_busy' };
          throw error;
        }
      });
      res.json({ ok: true, results, concurrency });
    } catch (error) {
      if (!res.destroyed) res.status(400).json({ ok: false, error: error.message });
    }
  });
}

export function registerProtocolPipelineRoutes(app, { requireAdmin, ensureDatabase, findAccountById, getSessionReloginConcurrency, protocolRequestNetwork, runSessionHealthCheckForAccount, runAllWorkspaceCodexAuthForAccount, publicAccountView }) {
  app.post('/api/v2/accounts/protocol-login-pipeline', requireAdmin, async (req, res) => {
    try {
      await ensureDatabase();
      const ids = normalizeAccountIds(req.body?.ids);
      const accounts = ids.map(findAccountById).filter(Boolean);
      if (!accounts.length) throw new Error('请先选择要处理的账号');
      const concurrency = getSessionReloginConcurrency(req.body?.concurrency);
      const workspaceMode = normalizeProtocolPipelineMode(req.body?.workspaceMode);
      const requestNetwork = protocolRequestNetwork(req.body || {});
      const owner = req.body.monitorOwner;
      const execute = async (hooks = {}) => mapWithConcurrency(accounts, concurrency, async account => {
        const terminalReason = owner && monitorCoordinator.stopReason(account);
        if (terminalReason) {
          const result = { id: account.id, email: account.email, ok: false, skipped: true, terminalReason };
          hooks.done?.(result);
          return result;
        }
        const work = () => runProtocolLoginPipelineAccount(account, {
          workspaceMode, hooks: { ...hooks, done: undefined },
          runSessionLogin: (current, options) => runSessionHealthCheckForAccount(current, {
            reloginOnInvalid: true, forceRelogin: true, loginOnly: true,
            ...options, ...requestNetwork,
          }),
          runAllWorkspaces: (current, options) => runAllWorkspaceCodexAuthForAccount(current, {
            ...options, ...requestNetwork,
          }),
        });
        let result;
        try {
          result = owner ? await monitorCoordinator.run([account.email], owner, work) : await work();
          if (result.terminalReason) monitorCoordinator.record(account, result.terminalReason);
          else if (result.ok) monitorCoordinator.record(account, '');
        } catch (error) {
          if (error.code !== 'MONITOR_LEASE_LOST') throw error;
          result = { id: account.id, email: account.email, ok: false, monitorBusy: true, skipped: true };
        }
        hooks.done?.(result);
        return result;
      });

      if (wantsEventStream(req)) {
        await runSseResponse(res, async sse => {
          sse.send('log', { msg: `开始账号级流水线，共 ${accounts.length} 个账号，固定并发=${concurrency}` });
          const results = await execute({
            start: data => sse.send('account_start', data),
            phase: data => sse.send('account_phase', data),
            log: data => sse.send('account_log', data),
            timing: data => sse.send('account_timing', data),
            done: data => sse.send('account_done', data),
          });
          sse.send('summary', {
            ok: true, concurrency, workspaceMode, results,
            success: results.filter(item => item.ok).length,
            failed: results.filter(item => !item.ok).length,
            accounts: accounts.map(account => publicAccountView(findAccountById(account.id) || account)),
          });
          sse.send('done', { ok: true });
        });
        return;
      }
      const results = await execute();
      res.json({ ok: true, concurrency, workspaceMode, results, success: results.filter(item => item.ok).length, failed: results.filter(item => !item.ok).length });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
