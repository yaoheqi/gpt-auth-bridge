import { mapWithConcurrency } from '../../../lib/sse.js';
import { sanitizeLogMessage } from '../../../lib/log-sanitize.js';
import { normalizeAccountIds } from '../../services/account-selection.js';
import { monitorCoordinator, terminalLoginFailure } from '../../services/monitor-coordinator.js';
import { wantsEventStream, runSseResponse } from '../batch/sse-runner.js';
import { withCachedWebSession } from '../../services/cached-web-session.js';
import { sendOperationError } from '../../http/operation-error.js';

export function registerProtocolLogoutAllRoutes(app, {
  requireAdmin, ensureDatabase, findAccountById, getConcurrency, protocolRequestNetwork, createFlow, clearAuthState, persistSession,
}) {
  const terminalErrorMessage = {
    account_unavailable: '账号已删除、停用或不存在，已停止重试',
    password_invalid: '密码错误，已停止重试',
    totp_invalid: '2FA 凭据错误，已停止重试',
  };
  app.post('/api/v2/accounts/protocol-logout-all', requireAdmin, async (req, res) => {
    try {
      if (req.body?.confirmed !== true) throw new Error('请先确认退出输入账号的全部 ChatGPT 会话');
      await ensureDatabase();
      const accounts = normalizeAccountIds(req.body.ids).map(findAccountById).filter(Boolean);
      if (!accounts.length) throw new Error('请先输入需要退出全部会话的账号');
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
                const { result: logout, reused } = await withCachedWebSession(account, {
                  flow, persistSession: login => persistSession(account.id, login),
                }, token => flow.logoutAllChatGptSessions(token));
                await clearAuthState(account.id);
                monitorCoordinator.record(account, 'sessions_logged_out');
                return { ok: true, reused, logout };
              } finally { await flow.dispose().catch(() => {}); }
            });
          } catch (error) {
            const terminalReason = terminalLoginFailure(error);
            result = { ok: false, error: terminalErrorMessage[terminalReason] || sanitizeLogMessage(error.message || '退出全部会话失败') };
            if (terminalReason) result.terminalReason = terminalReason;
          }
          if (result.terminalReason) monitorCoordinator.record(account, result.terminalReason);
          const publicResult = { ...result, ...identity };
          send('account_done', publicResult);
          return publicResult;
        });
        return { ok: results.every(row => row.ok), concurrency, results,
          success: results.filter(row => row.ok).length, failed: results.filter(row => !row.ok).length };
      };
      if (wantsEventStream(req)) {
        await runSseResponse(res, async sse => {
          sse.send('summary', await execute((event, data) => sse.send(event, data)));
          sse.send('done', { ok: true });
        }, { errorOptions: { sanitize: sanitizeLogMessage } });
      } else res.json(await execute());
    } catch (error) {
      sendOperationError(res, error, { sanitize: sanitizeLogMessage });
    }
  });
}
