import {
  accountHasChatGptSession as defaultAccountHasChatGptSession,
  resolveAccountLoginMethod as defaultResolveAccountLoginMethod,
} from '../../domain/accounts/account-domain.js';
import { durationMs as defaultDurationMs, structuredLog as defaultStructuredLog } from '../../../lib/structured-log.js';
import {
  hasTotpSecret as defaultHasTotpSecret,
  normalizeTotpSecret as defaultNormalizeTotpSecret,
  validateTotpSecret as defaultValidateTotpSecret,
} from '../../../lib/totp.js';
import { inferOpenAiStage as defaultInferOpenAiStage } from '../../../lib/account-stages.js';
import { mapWithConcurrency as defaultMapWithConcurrency } from '../../../lib/sse.js';
import { monitorCoordinator as defaultMonitorCoordinator } from '../monitor-coordinator.js';
import { nowIso as defaultNowIso } from './auth-records.js';
import { publicResetTotpCredential as defaultPublicResetTotpCredential } from './auth-result-views.js';
import { withCachedWebSession as defaultWithCachedWebSession } from '../cached-web-session.js';

/** Request-owned operations. Configuration and repositories are supplied by the composition root. */
export function createTotpService({
  OpenAIJsonAuthFlow,
  accountHasChatGptSession = defaultAccountHasChatGptSession,
  accountRepository,
  accountRequestNetwork,
  durationMs = defaultDurationMs,
  findAccountById,
  getOauthBatchConcurrency,
  getRegisterBatchConcurrency,
  hasTotpSecret = defaultHasTotpSecret,
  inferOpenAiStage = defaultInferOpenAiStage,
  mapWithConcurrency = defaultMapWithConcurrency,
  monitorCoordinator = defaultMonitorCoordinator,
  normalizeTotpSecret = defaultNormalizeTotpSecret,
  nowIso = defaultNowIso,
  persistChatGptWebSession,
  publicResetTotpCredential = defaultPublicResetTotpCredential,
  resolveAccountLoginMethod = defaultResolveAccountLoginMethod,
  structuredLog = defaultStructuredLog,
  validateTotpSecret = defaultValidateTotpSecret,
  withCachedWebSession = defaultWithCachedWebSession,
} = {}) {
  async function runEnrollTotpForAccount(account, {
    onLog,
    force = false,
    onlyWithoutLocalSecret = true,
  } = {}) {
    const startedAt = Date.now();
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
        if (typeof onLog === 'function') onLog({ email: account.email, ...entry });
      },
    };

    structuredLog('enroll_totp_start', {
      email: account.email,
      stage: inferOpenAiStage(account),
      hasLocalSecret: hasTotpSecret(account),
      hasSession: accountHasChatGptSession(account),
    });

    try {
      if (!accountHasChatGptSession(account)) {
        throw new Error('账号缺少 ChatGPT Session（session_access_token），请先登录/验活');
      }
      if (onlyWithoutLocalSecret && hasTotpSecret(account) && !force) {
        structuredLog('enroll_totp_done', {
          email: account.email,
          ok: true,
          skipped: true,
          reason: 'local_secret_present',
          durationMs: durationMs(startedAt),
        });
        return {
          ok: true,
          skipped: true,
          reason: 'local_secret_present',
          email: account.email,
          id: account.id,
          secret: normalizeTotpSecret(account.two_factor_secret),
          logs,
        };
      }

      const flowAccount = {
        ...account,
        session_access_token: String(account.session_access_token || '').trim(),
        session_json: String(account.session_json || '').trim(),
        storage_state_json: String(account.storage_state_json || '').trim(),
        two_factor_secret: normalizeTotpSecret(account.two_factor_secret),
        openai_password: String(account.openai_password || account.password || '').trim(),
      };
      if (account.id) {
        const latest = findAccountById(account.id);
        if (latest) {
          flowAccount.session_access_token = latest.session_access_token || flowAccount.session_access_token;
          flowAccount.session_json = latest.session_json || flowAccount.session_json;
          flowAccount.storage_state_json = latest.storage_state_json || flowAccount.storage_state_json;
          flowAccount.two_factor_secret = normalizeTotpSecret(latest.two_factor_secret || flowAccount.two_factor_secret);
          flowAccount.openai_password = latest.openai_password || latest.password || flowAccount.openai_password;
        }
      }

      const flow = new OpenAIJsonAuthFlow(flowAccount, sse, {
        phoneMode: 'sms',
      });
      try {
        flow.logProtocolHardening();
        await flow.importStoredCookieStorageState().catch(() => 0);
        await flow.ensureChatGptDeviceCookie();

      const accessToken = String(flowAccount.session_access_token || '').trim();
        const result = await flow.enrollAndActivateTotpForSession(accessToken, {
        skipIfEnabled: !force,
      });

        if (result.skipped) {
        const localSecret = normalizeTotpSecret(
          flowAccount.two_factor_secret || account.two_factor_secret || '',
        );
        if (localSecret) {
          structuredLog('enroll_totp_done', {
            email: account.email,
            ok: true,
            skipped: true,
            reason: 'already_enabled_with_local_secret',
            durationMs: durationMs(startedAt),
          });
          return {
            ok: true,
            skipped: true,
            reason: 'already_enabled_with_local_secret',
            email: account.email,
            id: account.id,
            secret: localSecret,
            factorId: result.factorId || '',
            mfaInfo: result.mfaInfo || null,
            logs,
          };
        }
        if (account.id) {
          await accountRepository.updateById(account.id, {
            status: '远端已有 MFA',
            last_error: '远端已开启 TOTP，本地无密钥可回填',
          }).catch(() => {});
        }
        structuredLog('enroll_totp_done', {
          email: account.email,
          ok: false,
          skipped: true,
          reason: result.reason || 'already_enabled',
          durationMs: durationMs(startedAt),
        });
        return {
          ok: false,
          skipped: true,
          reason: result.reason || 'already_enabled',
          email: account.email,
          id: account.id,
          secret: '',
          factorId: result.factorId || '',
          mfaInfo: result.mfaInfo || null,
          error: '远端已开启 TOTP MFA，无法回填密钥；若本地已有密钥可忽略',
          logs,
        };
      }

      const secret = validateTotpSecret(result.secret);
      if (account.id) {
        await accountRepository.updateById(account.id, latest => ({
          two_factor_secret: secret,
          status: '已设置2FA',
          last_error: '',
          ...(!String(latest.openai_password || '').trim() && String(latest.password || '').trim()
            ? { openai_password: String(latest.password || '').trim() } : {}),
        }));
      }

      structuredLog('enroll_totp_done', {
        email: account.email,
        ok: true,
        skipped: false,
        durationMs: durationMs(startedAt),
      });
        return {
        ok: true,
        skipped: false,
        reason: '',
        email: account.email,
        id: account.id,
        secret,
        factorId: result.factorId || '',
        mfaInfo: result.mfaInfo || null,
        enroll: result.enroll || null,
          logs,
        };
      } finally {
        await flow.dispose().catch(() => {});
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (account.id) {
        await accountRepository.updateById(account.id, {
          status: '设置2FA失败',
          last_error: message,
        }).catch(() => {});
      }
      structuredLog('enroll_totp_failed', {
        email: account.email,
        ok: false,
        durationMs: durationMs(startedAt),
        error: message,
      });
      return {
        ok: false,
        skipped: false,
        email: account.email,
        id: account.id,
        error: message,
        logs,
      };
    }
  }

  async function runEnrollTotpForAccounts(accounts, {
    onAccountStart,
    onAccountLog,
    onAccountDone,
    force = false,
    onlyWithoutLocalSecret = true,
  } = {}) {
    const results = await mapWithConcurrency(accounts, getOauthBatchConcurrency(), async account => {
      if (typeof onAccountStart === 'function') {
        onAccountStart({
          email: account.email,
          id: account.id,
          stage: inferOpenAiStage(account),
        });
      }
      const result = await runEnrollTotpForAccount(account, {
        onLog: onAccountLog,
        force,
        onlyWithoutLocalSecret,
      });
      if (typeof onAccountDone === 'function') onAccountDone(result);
      return result;
    });
    const success = results.filter(item => item.ok && !item.skipped).length;
    const skipped = results.filter(item => item.ok && item.skipped).length;
    const failed = results.filter(item => !item.ok).length;
    return { ok: true, success, skipped, failed, results };
  }

  async function runResetTotpForAccount(account, {
    onAccountStart,
    onAccountLog,
    onAccountDone,
    ...network
  } = {}) {
    const startedAt = Date.now();
    const emit = (msg, level = 'info') => {
      const entry = { time: nowIso(), level, msg: String(msg || '') };
      onAccountLog?.({ id: account?.id, email: account?.email, ...entry });
    };
    try {
      return await monitorCoordinator.runExclusive(account.email, async () => {
        let latest = account.id ? (findAccountById(account.id) || account) : account;
        onAccountStart?.({ id: latest.id, email: latest.email, stage: 0 });
        // Reuse the browser's session and recent-auth cookies. Only an explicit
        // authentication rejection before any mutation permits a fresh login.
        const loginMethod = resolveAccountLoginMethod(latest);
        if (loginMethod !== 'password_totp') {
          throw new Error('2FA 换绑要求账号具备邮箱、密码和旧 TOTP；请使用三段账号格式重新导入');
        }
        emit('创建账号独立隔离环境，优先复用浏览器 Session 和 Cookie');
        const flowAccount = {
          ...latest,
          session_access_token: String(latest.session_access_token || '').trim(),
          session_json: String(latest.session_json || '').trim(),
          storage_state_json: String(latest.storage_state_json || '').trim(),
          two_factor_secret: normalizeTotpSecret(latest.two_factor_secret),
          openai_password: String(latest.openai_password || latest.password || '').trim(),
        };
        const flow = new OpenAIJsonAuthFlow(flowAccount, {
          send(event, data) {
            if (event !== 'log') return;
            emit(data?.msg || data?.error || '', data?.level || 'info');
          },
        }, { phoneMode: 'sms', forbidPhoneChallenge: true, humanPacingEnabled: false, ...accountRequestNetwork(latest, network) });
        try {
          const { result, session } = await withCachedWebSession(flowAccount, {
            flow,
            persistSession: login => persistChatGptWebSession(latest.id, { ...login, status: '2FA 换绑认证成功' }),
          }, accessToken => flow.resetTotpForSession(accessToken));
          const secret = validateTotpSecret(result.secret);
          await accountRepository.updateById(latest.id, current => ({
            two_factor_secret: secret,
            raw: [latest.email, flowAccount.openai_password, secret].join('----'),
            fingerprint_json: flowAccount.fingerprint_json || latest.fingerprint_json || '',
            status: '已换绑2FA',
            last_error: '',
            ...(!String(current.openai_password || '').trim() && flowAccount.openai_password
              ? { openai_password: flowAccount.openai_password } : {}),
          }));
          await persistChatGptWebSession(latest.id, {
            ...session, storageState: await flow.exportCookieStorageState(), status: '已换绑2FA',
          });
          const refreshed = findAccountById(latest.id) || { ...latest, two_factor_secret: secret };
          const output = {
            ok: true,
            id: refreshed.id,
            email: refreshed.email,
            factorId: result.factorId || '',
            mfaEnabled: Boolean(result.mfaInfo?.mfa_enabled || result.mfaInfo?.mfa_enabled_v2),
            credentials: publicResetTotpCredential(refreshed, secret),
            durationMs: durationMs(startedAt),
          };
          onAccountDone?.(output);
          return output;
        } finally {
          await flow.dispose().catch(() => {});
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (account?.id) await accountRepository.updateById(account.id, { status: '换绑2FA失败', last_error: message }).catch(() => {});
      const output = { ok: false, id: account?.id, email: account?.email, error: message, durationMs: durationMs(startedAt) };
      onAccountLog?.({ id: account?.id, email: account?.email, time: nowIso(), level: 'error', msg: message });
      onAccountDone?.(output);
      return output;
    }
  }

  async function runResetTotpForAccounts(accounts, { concurrency, onAccountStart, onAccountLog, onAccountDone, ...network } = {}) {
    const limit = getRegisterBatchConcurrency(concurrency);
    const results = await mapWithConcurrency(accounts, limit, account => runResetTotpForAccount(account, {
      onAccountStart,
      onAccountLog,
      onAccountDone,
      ...network,
    }));
    return {
      ok: true,
      concurrency: limit,
      success: results.filter(item => item.ok).length,
      failed: results.filter(item => !item.ok).length,
      results,
    };
  }

  return { runEnrollTotpForAccount, runEnrollTotpForAccounts, runResetTotpForAccount, runResetTotpForAccounts };
}
