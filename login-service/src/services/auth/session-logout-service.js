import { durationMs as defaultDurationMs, structuredLog as defaultStructuredLog } from '../../../lib/structured-log.js';
import { extractSessionAccessToken as defaultExtractSessionAccessToken } from '../../../lib/business-workspace.js';
import { inferOpenAiStage as defaultInferOpenAiStage } from '../../../lib/account-stages.js';
import { logoutAllCredentialIssue as defaultLogoutAllCredentialIssue } from '../../domain/accounts/account-domain.js';
import { mapWithConcurrency as defaultMapWithConcurrency } from '../../../lib/sse.js';
import { nowIso as defaultNowIso } from './auth-records.js';

/** Request-owned operations. Configuration and repositories are supplied by the composition root. */
export function createSessionLogoutService({
  OpenAIJsonAuthFlow,
  accountRepository,
  clearAuthStateForFreshLogin,
  durationMs = defaultDurationMs,
  extractSessionAccessToken = defaultExtractSessionAccessToken,
  getOauthBatchConcurrency,
  inferOpenAiStage = defaultInferOpenAiStage,
  logoutAllCredentialIssue = defaultLogoutAllCredentialIssue,
  mapWithConcurrency = defaultMapWithConcurrency,
  nowIso = defaultNowIso,
  reloginChatGptWebSessionForHealth,
  structuredLog = defaultStructuredLog,
} = {}) {
  async function runLogoutAllForAccount(account, { onLog } = {}) {
    const startedAt = Date.now();
    const emitLog = (entry) => {
      if (typeof onLog === 'function') onLog(entry);
    };
    const logs = [];
    const sse = {
      send(event, data) {
        if (event !== 'log') return;
        const entry = {
          time: data?.time || nowIso(),
          level: data?.level || 'info',
          msg: data?.msg || data?.error || '',
        };
        logs.push(entry);
        emitLog({ email: account.email, ...entry });
      },
    };

    structuredLog('logout_all_start', {
      email: account.email,
      stage: inferOpenAiStage(account),
    });

    try {
      const credentialIssue = logoutAllCredentialIssue(account);
      if (credentialIssue) throw new Error(credentialIssue);
      const storedAccessToken = extractSessionAccessToken(account);
      const logoutFlow = new OpenAIJsonAuthFlow(account, sse, {
        phoneMode: 'sms',
        reuseStoredSession: true,
      });
      let logout;
      try {
        logoutFlow.log('复用已保存的 ChatGPT Session，直接退出全部会话');
        await logoutFlow.importStoredCookieStorageState();
        logout = await logoutFlow.logoutAllChatGptSessions(storedAccessToken);
      } finally {
        await logoutFlow.dispose();
      }

      // logout_all 完成后必须丢弃所有旧认证状态，避免重登复用旧 RT/Agent。
      await clearAuthStateForFreshLogin(account.id, { status: '旧 Session 已退出，准备重登' });
      sse.send('log', { msg: '全部会话已退出，开始创建全新 Session 并重登' });

      let relogin;
      try {
        relogin = await reloginChatGptWebSessionForHealth(account, {
          loginOnly: true,
          onLog: entry => {
            logs.push(entry);
            emitLog(entry);
          },
        });
      } catch (error) {
        throw new Error(`全部会话已退出，但重新登录失败: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (account.id) {
        await accountRepository.updateById(account.id, { status: '已退出全部会话并重登', last_error: '' }).catch(() => {});
      }

      structuredLog('logout_all_done', {
        email: account.email,
        ok: true,
        durationMs: durationMs(startedAt),
      });
      return {
        ok: true,
        email: account.email,
        accessTokenPresent: Boolean(relogin.accessToken),
        sessionUser: relogin.session?.user || null,
        logout,
        reloggedIn: true,
        logs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (account.id) {
        await clearAuthStateForFreshLogin(account.id, { status: '退出全部会话失败，旧认证状态已清理' }).catch(() => {});
        await accountRepository.updateById(account.id, { status: '退出全部会话失败', last_error: message }).catch(() => {});
      }
      structuredLog('logout_all_failed', {
        email: account.email,
        ok: false,
        durationMs: durationMs(startedAt),
        error: message,
      });
      return {
        ok: false,
        email: account.email,
        error: message,
        logs,
      };
    }
  }

  async function runLogoutAllForAccounts(accounts, {
    onAccountStart,
    onAccountLog,
    onAccountDone,
  } = {}) {
    const results = await mapWithConcurrency(accounts, getOauthBatchConcurrency(), async account => {
      if (typeof onAccountStart === 'function') {
        onAccountStart({
          email: account.email,
          id: account.id,
          stage: inferOpenAiStage(account),
        });
      }
      const result = await runLogoutAllForAccount(account, { onLog: onAccountLog });
      if (typeof onAccountDone === 'function') onAccountDone(result);
      return result;
    });
    const success = results.filter(item => item.ok).length;
    const failed = results.filter(item => !item.ok).length;
    return { ok: true, success, failed, results };
  }

  return { runLogoutAllForAccount, runLogoutAllForAccounts };
}
