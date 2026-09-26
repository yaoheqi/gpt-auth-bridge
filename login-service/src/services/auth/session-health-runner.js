import {
  SESSION_HEALTH as defaultSESSION_HEALTH,
  isAccountDeactivatedError as defaultIsAccountDeactivatedError,
  sessionHealthLabel as defaultSessionHealthLabel,
  shouldRequireExistingSession as defaultShouldRequireExistingSession,
} from '../session-health-service.js';
import {
  accountHasChatGptSession as defaultAccountHasChatGptSession,
  protocolLoginCredentialIssue as defaultProtocolLoginCredentialIssue,
} from '../../domain/accounts/account-domain.js';
import { authRetryDelayMs as defaultAuthRetryDelayMs, isOpenAiRateLimitError as defaultIsOpenAiRateLimitError } from '../../lib/openai-auth-error.js';
import { durationMs as defaultDurationMs, structuredLog as defaultStructuredLog } from '../../../lib/structured-log.js';
import { inferOpenAiStage as defaultInferOpenAiStage } from '../../../lib/account-stages.js';
import { mapWithConcurrency as defaultMapWithConcurrency } from '../../../lib/sse.js';
import { nowIso as defaultNowIso } from './auth-records.js';
import { parseProxyPool as defaultParseProxyPool } from '../../../lib/proxy-config.js';
import { proxyHealthRegistry as defaultProxyHealthRegistry } from '../../../lib/proxy-health.js';

/** Request-owned operations. Configuration and repositories are supplied by the composition root. */
export function createSessionHealthRunner({
  SESSION_HEALTH = defaultSESSION_HEALTH,
  accountHasChatGptSession = defaultAccountHasChatGptSession,
  accountRepository,
  accountRequestNetwork,
  authRetryDelayMs = defaultAuthRetryDelayMs,
  clearAuthStateForFreshLogin,
  durationMs = defaultDurationMs,
  findAccountById,
  getProtocolSettings,
  getSessionReloginConcurrency,
  getSessionReloginMaxAttempts,
  inferOpenAiStage = defaultInferOpenAiStage,
  isAccountDeactivatedError = defaultIsAccountDeactivatedError,
  isAutoDeleteInvalidSessionsEnabled,
  isOpenAiRateLimitError = defaultIsOpenAiRateLimitError,
  isRetryableProxyConnectionError,
  isRetryableSessionReloginError,
  mapWithConcurrency = defaultMapWithConcurrency,
  nowIso = defaultNowIso,
  parseProxyPool = defaultParseProxyPool,
  persistSessionHealth,
  probeSessionThroughConfiguredProxy,
  protocolLoginCredentialIssue = defaultProtocolLoginCredentialIssue,
  proxyHealthRegistry = defaultProxyHealthRegistry,
  reloginChatGptWebSessionForHealth,
  sessionHealthLabel = defaultSessionHealthLabel,
  shouldRequireExistingSession = defaultShouldRequireExistingSession,
  sleep,
  structuredLog = defaultStructuredLog,
} = {}) {
  async function runSessionHealthCheckForAccount(account, {
    reloginOnInvalid = true,
    forceRelogin = false,
    loginOnly = false,
    onLog,
    proxyPool,
    directWhenProxyPoolEmpty = false,
  } = {}) {
    const startedAt = Date.now();
    const logs = [];
    const emit = (msg, level = 'info') => {
      const entry = { time: nowIso(), level, msg: String(msg || '') };
      logs.push(entry);
      if (typeof onLog === 'function') onLog({ email: account.email, ...entry });
    };

    structuredLog('session_health_start', {
      email: account.email,
      hasSession: accountHasChatGptSession(account),
      reloginOnInvalid: Boolean(reloginOnInvalid),
      forceRelogin: Boolean(forceRelogin),
      loginOnly: Boolean(loginOnly),
    });

    const finish = async (result) => {
      const health = result.health || SESSION_HEALTH.PROBE_FAILED;
      const detail = result.detail || result.error || result.probeCode || '';
      let status = '';
      if (health === SESSION_HEALTH.ALIVE || health === SESSION_HEALTH.ALIVE_REFRESHED) {
        status = health === SESSION_HEALTH.ALIVE_REFRESHED ? 'Session已刷新' : 'Session有效';
      } else if (health === SESSION_HEALTH.DEACTIVATED) {
        status = '账号已停用';
      } else if (health === SESSION_HEALTH.SESSION_INVALID) {
        status = 'Session失效';
      } else if (health === SESSION_HEALTH.NO_SESSION) {
        status = account.status || '无 Session';
      } else if (health === SESSION_HEALTH.RELOGIN_FAILED) {
        status = '验活重登失败';
      } else if (health === SESSION_HEALTH.PROBE_FAILED) {
        status = 'Session验活失败';
      }

      if (account.id) {
        await persistSessionHealth(account.id, {
          health,
          detail,
          status,
          clearSession: health === SESSION_HEALTH.DEACTIVATED,
          lastError: health === SESSION_HEALTH.ALIVE || health === SESSION_HEALTH.ALIVE_REFRESHED
            ? ''
            : (result.error || detail || ''),
        }).catch(() => {});
      }

      structuredLog(result.ok ? 'session_health_done' : 'session_health_failed', {
        email: account.email,
        ok: Boolean(result.ok),
        health,
        durationMs: durationMs(startedAt),
        error: result.ok ? undefined : (result.error || detail || undefined),
      });

      return {
        ...result,
        health,
        healthLabel: sessionHealthLabel(health),
        email: account.email,
        id: account.id,
        logs,
      };
    };

    try {
      if ((loginOnly || forceRelogin) && protocolLoginCredentialIssue(account)) {
        const issue = protocolLoginCredentialIssue(account);
        emit(`跳过协议登录：${issue}，请补充后再运行`, 'warn');
        return finish({
          ok: false,
          skipped: true,
          health: SESSION_HEALTH.RELOGIN_FAILED,
          detail: `${issue}，无法执行协议登录`,
          error: `${issue}，无法执行协议登录`,
          missingLoginCredentials: true,
        });
      }
      if (shouldRequireExistingSession({ loginOnly, forceRelogin })) {
        if (!accountHasChatGptSession(account)) {
          emit('无 ChatGPT Session，标记 no_session');
          return finish({
            ok: false,
            health: SESSION_HEALTH.NO_SESSION,
            detail: '缺少 session_access_token',
            error: '缺少 session_access_token',
          });
        }

        emit('探测 ChatGPT backend-api/me');
        const probe = await probeSessionThroughConfiguredProxy(
          account.session_access_token,
          account.storage_state_json,
          account.fingerprint_json,
        );
        emit(`探测结果: health=${probe.health} status=${probe.status || 0} code=${probe.code || ''}`);

        if (probe.health === SESSION_HEALTH.ALIVE) {
          return finish({
            ok: true,
            health: SESSION_HEALTH.ALIVE,
            detail: `HTTP ${probe.status}`,
            probeStatus: probe.status,
            probeCode: probe.code,
          });
        }

        if (probe.health === SESSION_HEALTH.DEACTIVATED) {
          return finish({
            ok: false,
            health: SESSION_HEALTH.DEACTIVATED,
            detail: probe.code || probe.body || 'account_deactivated',
            error: probe.code || 'account_deactivated',
            probeStatus: probe.status,
            probeCode: probe.code,
          });
        }

        if (probe.health === SESSION_HEALTH.PROBE_FAILED) {
          return finish({
            ok: false,
            health: SESSION_HEALTH.PROBE_FAILED,
            detail: probe.error || probe.body || `HTTP ${probe.status}`,
            error: probe.error || probe.body || `HTTP ${probe.status}`,
            probeStatus: probe.status,
            probeCode: probe.code,
          });
        }

        if (!reloginOnInvalid) {
          emit('Session 失效，清理旧 Session、RT 和运行态身份');
          await clearAuthStateForFreshLogin(account.id, { status: 'Session 失效，旧认证状态已清理' }).catch(() => {});
          return finish({
            ok: false,
            health: SESSION_HEALTH.SESSION_INVALID,
            detail: probe.code || probe.body || `HTTP ${probe.status}`,
            error: probe.code || 'token_invalidated',
            probeStatus: probe.status,
            probeCode: probe.code,
          });
        }

        emit('Session 失效，开始邮箱/密码重登刷新 Session（不接手机号）');
      } else {
        emit('强制重登刷新 Session（不接手机号）');
      }

      const credentialIssue = protocolLoginCredentialIssue(account);
      if (credentialIssue) {
        return finish({
          ok: false, health: SESSION_HEALTH.RELOGIN_FAILED,
          detail: credentialIssue, error: credentialIssue, missingLoginCredentials: true,
        });
      }

      // 强制协议登录或 401 后重登前，清理当前记录中的 Session、personal/business RT
      // 以及 Agent 身份；原始邮箱、密码、TOTP 和邮箱 OAuth 凭据保持不变。
      emit('清理旧 Session、RT 和运行态身份后创建新隔离环境');
      await clearAuthStateForFreshLogin(account.id, { status: '准备重新登录，旧认证状态已清理' });

      try {
        const maxAttempts = Math.min(3, getSessionReloginMaxAttempts());
        const configuredPool = proxyPool !== undefined
          ? String(proxyPool || '').trim()
          : String(getProtocolSettings().proxyPool || '').trim();
        const proxyCandidates = parseProxyPool(configuredPool);
        const initialNetwork = proxyPool === undefined && !configuredPool
          ? { proxyPool: undefined, directWhenProxyPoolEmpty }
          : accountRequestNetwork(account, { proxyPool: configuredPool, directWhenProxyPoolEmpty });
        const initialProxy = initialNetwork.proxyPool || '';
        const initialProxyIndex = Math.max(0, proxyCandidates.indexOf(initialProxy));
        let switchProxyOnRetry = false;
        let proxySwitchCount = 0;
        let activeProxyUrl = initialProxy;
        let proxyAttemptStartedAt = 0;
        let relogin;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            emit(`协议重登第 ${attempt}/${maxAttempts} 次：创建全新隔离环境`);
            const network = proxySwitchCount > 0 && proxyCandidates.length > 1
              ? {
                  ...initialNetwork,
                  proxyPool: proxyCandidates[(initialProxyIndex + proxySwitchCount) % proxyCandidates.length],
                }
              : initialNetwork;
            activeProxyUrl = String(network.proxyPool || '');
            proxyAttemptStartedAt = Date.now();
            // A new flow owns a new CookieJar, device ID, fingerprint, OAuth/CSRF state,
            // HTTP dispatcher and (when configured) proxy session.
            relogin = await reloginChatGptWebSessionForHealth(account, {
              ...network,
              onLog: (entry) => {
                logs.push(entry);
                if (typeof onLog === 'function') onLog(entry);
              },
            });
            proxyHealthRegistry.recordSuccess(activeProxyUrl, Date.now() - proxyAttemptStartedAt);
            break;
          } catch (error) {
            proxyHealthRegistry.recordFailure(activeProxyUrl, error);
            if (attempt >= maxAttempts || !isRetryableSessionReloginError(error)) throw error;
            switchProxyOnRetry = isRetryableProxyConnectionError(error) && proxyCandidates.length > 1;
            if (switchProxyOnRetry) proxySwitchCount += 1;
            const delayMs = authRetryDelayMs(error, attempt) + Math.floor(Math.random() * 750);
            emit(`${switchProxyOnRetry ? '代理 SSL 连接中断，切换代理出口' : (isOpenAiRateLimitError(error) ? 'OpenAI 登录接口限流' : '隔离环境认证状态失效')}，等待 ${Math.ceil(delayMs / 1000)} 秒后完全重建并重试`, 'warn');
            await sleep(delayMs);
          }
        }
        const token = String(relogin.accessToken || '').trim();
        if (!token) {
          return finish({
            ok: false,
            health: SESSION_HEALTH.RELOGIN_FAILED,
            detail: '重登未返回 accessToken',
            error: '重登未返回 accessToken',
          });
        }
        // The login response is the source of truth for a successful refresh.
        // Do not immediately probe the freshly-created Session again: that
        // duplicate request adds latency and can turn a successful login into a
        // false failure when the new Session has not propagated yet.
        emit('重登成功，已保存新 Session');
        return finish({
          ok: true,
          health: SESSION_HEALTH.ALIVE_REFRESHED,
          detail: 'relogin ok',
          refreshed: true,
          hasSession: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isAccountDeactivatedError(message)) {
          return finish({
            ok: false,
            health: SESSION_HEALTH.DEACTIVATED,
            detail: message,
            error: message,
          });
        }
        return finish({
          ok: false,
          health: SESSION_HEALTH.RELOGIN_FAILED,
          detail: message,
          error: message,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isAccountDeactivatedError(message)) {
        return finish({
          ok: false,
          health: SESSION_HEALTH.DEACTIVATED,
          detail: message,
          error: message,
        });
      }
      return finish({
        ok: false,
        health: SESSION_HEALTH.PROBE_FAILED,
        detail: message,
        error: message,
      });
    }
  }

  async function runSessionHealthCheckForAccounts(accounts, {
    reloginOnInvalid = true,
    forceRelogin = false,
    loginOnly = false,
    onAccountStart,
    onAccountLog,
    onAccountDone,
    autoDeleteInvalid = true,
    concurrency: requestedConcurrency,
    proxyPool,
    directWhenProxyPoolEmpty = false,
  } = {}) {
    const reloginConcurrency = getSessionReloginConcurrency(requestedConcurrency);
    const startAccount = (account) => {
      if (typeof onAccountStart === 'function') {
        onAccountStart({
          email: account.email,
          id: account.id,
          stage: inferOpenAiStage(account),
          hasSession: accountHasChatGptSession(account),
          loginCredentialIssue: loginOnly ? protocolLoginCredentialIssue(account) : '',
        });
      }
    };

    let results;
    if (forceRelogin) {
      results = await mapWithConcurrency(accounts, reloginConcurrency, async account => {
        startAccount(account);
        const result = await runSessionHealthCheckForAccount(account, {
          reloginOnInvalid: true,
          forceRelogin: true,
          loginOnly,
          proxyPool,
          directWhenProxyPoolEmpty,
          onLog: onAccountLog,
        });
        if (typeof onAccountDone === 'function') onAccountDone(result);
        return result;
      });
    } else {
      // Phase 1 is a pure, high-concurrency probe. No worker holds a probe slot while
      // performing the much longer authentication flow.
      results = await mapWithConcurrency(accounts, reloginConcurrency, async account => {
        startAccount(account);
        const result = await runSessionHealthCheckForAccount(account, {
          reloginOnInvalid: false,
          forceRelogin: false,
          loginOnly,
          proxyPool,
          directWhenProxyPoolEmpty,
          onLog: onAccountLog,
        });
        if ((!reloginOnInvalid || result.health !== SESSION_HEALTH.SESSION_INVALID)
          && typeof onAccountDone === 'function') onAccountDone(result);
        return result;
      });

      if (reloginOnInvalid) {
        const candidates = results
          .map((result, index) => ({ result, account: accounts[index], index }))
          .filter(item => item.result.health === SESSION_HEALTH.SESSION_INVALID);
        const refreshed = await mapWithConcurrency(
          candidates,
          reloginConcurrency,
          async ({ result: probeResult, account, index }) => {
            const reloginResult = await runSessionHealthCheckForAccount(account, {
              reloginOnInvalid: true,
              forceRelogin: true,
              loginOnly,
              proxyPool,
              directWhenProxyPoolEmpty,
              onLog: onAccountLog,
            });
            results[index] = {
              ...reloginResult,
              logs: [...(probeResult.logs || []), ...(reloginResult.logs || [])],
              initialProbe: {
                health: probeResult.health,
                status: probeResult.probeStatus || 0,
                code: probeResult.probeCode || '',
              },
            };
            if (typeof onAccountDone === 'function') onAccountDone(results[index]);
          },
        );
        void refreshed;
      }
    }

    const tallies = {
      alive: results.filter(item => item.health === SESSION_HEALTH.ALIVE).length,
      aliveRefreshed: results.filter(item => item.health === SESSION_HEALTH.ALIVE_REFRESHED).length,
      sessionInvalid: results.filter(item => item.health === SESSION_HEALTH.SESSION_INVALID).length,
      deactivated: results.filter(item => item.health === SESSION_HEALTH.DEACTIVATED).length,
      noSession: results.filter(item => item.health === SESSION_HEALTH.NO_SESSION).length,
      probeFailed: results.filter(item => item.health === SESSION_HEALTH.PROBE_FAILED).length,
      reloginFailed: results.filter(item => item.health === SESSION_HEALTH.RELOGIN_FAILED).length,
      skippedCredentials: results.filter(item => item.skipped && item.missingLoginCredentials).length,
    };
    const success = tallies.alive + tallies.aliveRefreshed;
    const failed = results.length - success - tallies.skippedCredentials;
    const autoDelete = autoDeleteInvalid && isAutoDeleteInvalidSessionsEnabled();
    // Only account_deactivated is auto-deleted (local+cloud same rule). session_invalid is kept for relogin retry.
    // Callers must not retry deactivated rows; they are terminal and removed from the DB when autoDelete is on.
    const invalidIds = autoDelete
      ? results
        .filter(item => item.health === SESSION_HEALTH.DEACTIVATED)
        .map(item => String(item.id || ''))
        .filter(Boolean)
      : [];
    let autoDeleted = 0;
    const autoDeletedEmails = [];
    if (invalidIds.length) {
      const matched = invalidIds.map(findAccountById).filter(Boolean);
      autoDeletedEmails.push(...matched.map(account => String(account.email || '')));
      const deletion = accountRepository.deleteByIds(invalidIds, { confirm: true });
      autoDeleted = Number(deletion?.summary?.deleted || deletion?.deleted?.length || 0);
    }
    return { ok: true, success, failed, tallies, autoDeleted, autoDeletedEmails, results };
  }

  return { runSessionHealthCheckForAccount, runSessionHealthCheckForAccounts };
}
