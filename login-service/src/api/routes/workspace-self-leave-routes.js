import { mapWithConcurrency } from '../../../lib/sse.js';
import { sanitizeLogMessage } from '../../../lib/log-sanitize.js';
import { normalizeAccountIds } from '../../services/account-selection.js';
import { requestSignal } from '../../services/request-scope.js';
import { monitorCoordinator, terminalLoginFailure } from '../../services/monitor-coordinator.js';
import { selfLeaveWorkspaces } from '../../services/workspace-self-leave.js';
import { wantsEventStream, runSseResponse } from '../batch/sse-runner.js';

export function registerWorkspaceSelfLeaveRoutes(app, { requireAdmin, ensureDatabase, findAccountById, getConcurrency, protocolRequestNetwork, createFlow, updateAccount }) {
  app.post('/api/v2/accounts/self-leave', requireAdmin, async (req, res) => {
    try {
      if (req.body?.confirmed !== true) throw new Error('请先确认退出输入账号的所有非 owner 团队工作区');
      await ensureDatabase();
      const accounts = normalizeAccountIds(req.body.ids).map(findAccountById).filter(Boolean);
      if (!accounts.length) throw new Error('请先输入需要自踢的账号');
      const concurrency = getConcurrency();
      const network = protocolRequestNetwork(req.body);
      const execute = async (send = () => {}) => {
        const results = await mapWithConcurrency(accounts, concurrency, async account => {
          const identity = { id: account.id, email: account.email };
          send('account_start', identity);
          let result;
          try {
            result = await monitorCoordinator.runExclusive(account.email, async () => {
              const onLog = data => send('account_log', { ...identity, msg: sanitizeLogMessage(data.msg || ''), level: data.level || 'info' });
              const flow = createFlow(account, network, onLog);
              try {
                await flow.importStoredCookieStorageState();
                return await selfLeaveWorkspaces(account, { flow, signal: requestSignal(), onLog,
                  persist: patch => updateAccount(account.id, patch) });
              } finally { await flow.dispose().catch(() => {}); }
            });
          } catch (error) { result = { ok: false, error: sanitizeLogMessage(error.message || '自踢失败'),
            ...(terminalLoginFailure(error) ? { terminalReason: terminalLoginFailure(error) } : {}) }; }
          if (result.terminalReason) monitorCoordinator.record(account, result.terminalReason);
          result = { ...result, ...identity };
          send('account_done', result);
          return result;
        });
        return { ok: true, concurrency, results, success: results.filter(row => row.ok).length,
          failed: results.filter(row => !row.ok).length, left: results.reduce((count, row) => count + (row.left || 0), 0),
          unconfirmed: results.reduce((count, row) => count + (row.unconfirmed || 0), 0) };
      };
      if (wantsEventStream(req)) {
        await runSseResponse(res, async sse => {
          sse.send('summary', await execute((event, data) => sse.send(event, data)));
          sse.send('done', { ok: true });
        });
      } else res.json(await execute());
    } catch (error) {
      if (!res.destroyed) res.status(400).json({ ok: false, error: sanitizeLogMessage(error.message) });
    }
  });
}
