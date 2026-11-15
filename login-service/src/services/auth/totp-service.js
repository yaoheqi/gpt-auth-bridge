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
    action, onAccountStart, onAccountLog, onAccountDone, ...network
  } = {}) {
    const startedAt = Date.now();
    let preparingNew = false;
    const emit = (msg, level = 'info') => onAccountLog?.({
      id: account?.id, email: account?.email, time: nowIso(), level, msg: String(msg || ''),
    });
    const outcome = (ok, phase, error = '') => {
      const output = { ok, id: account?.id, email: account?.email, phase, error, durationMs: durationMs(startedAt) };
      onAccountDone?.(output);
      return output;
    };
    try {
      if (!['prepare', 'activate', 'confirm'].includes(action)) throw new Error('请刷新页面，使用分步保存的新 2FA 换绑流程');
      return await monitorCoordinator.runExclusive(account.email, async () => {
        const latest = account.id ? (findAccountById(account.id) || account) : account;
        onAccountStart?.({ id: latest.id, email: latest.email, stage: 0 });
        let pending = latest.totp_reset_pending;
        if (action === 'prepare' && pending && pending.phase !== 'preparing') {
          return outcome(true, pending.phase);
        }
        preparingNew = action === 'prepare';
        if (preparingNew && resolveAccountLoginMethod(latest) !== 'password_totp') {
          throw new Error('2FA 换绑要求邮箱、密码和当前 TOTP；请先补全账号凭据');
        }
        if (!preparingNew && !pending?.secret) throw new Error('未收到新密钥，不能继续激活；请在账号安全设置中核对状态');
        if (action === 'activate' && pending.phase !== 'activating') throw new Error('请先在浏览器保存新密钥及激活状态');
        const flowAccount = {
          ...latest,
          // The initial prepare may authenticate before changing anything. All
          // later requests must use Session/cookies without an old-key login.
          totp_reset_pending: preparingNew ? null : pending,
          two_factor_secret: normalizeTotpSecret(latest.two_factor_secret),
          openai_password: String(latest.openai_password || latest.password || '').trim(),
        };
        const flow = new OpenAIJsonAuthFlow(flowAccount, {
          send(event, data) { if (event === 'log') emit(data?.msg || data?.error || '', data?.level || 'info'); },
        }, { phoneMode: 'sms', forbidPhoneChallenge: true, humanPacingEnabled: false, ...accountRequestNetwork(latest, network) });
        const savePrimarySecret = async phase => {
          const secret = validateTotpSecret(pending.secret);
          await accountRepository.updateById(latest.id, {
            two_factor_secret: secret,
            raw: [latest.email, flowAccount.openai_password, secret].join('----'),
            totp_reset_pending: phase === 'confirmed' ? null : { ...pending, phase },
            status: phase === 'confirmed' ? '已换绑2FA' : '新 2FA 已激活，状态待确认',
            last_error: '',
          });
        };
        try {
          const { session } = await withCachedWebSession(flowAccount, {
            flow, allowLogin: preparingNew,
            persistSession: login => persistChatGptWebSession(latest.id, { ...login, status: '2FA 换绑认证成功' }),
          }, async accessToken => {
            if (preparingNew) {
              const prepared = await flow.prepareTotpResetForSession(accessToken);
              pending = { ...prepared, secret: validateTotpSecret(prepared.secret), createdAt: nowIso() };
              await accountRepository.updateById(latest.id, {
                totp_reset_pending: pending, status: '新 2FA 已生成，待保存并激活', last_error: '',
                fingerprint_json: flowAccount.fingerprint_json || latest.fingerprint_json || '',
              });
            } else {
              if (action === 'activate') {
                await flow.activatePreparedTotpForSession(accessToken, pending);
                pending = { ...pending, phase: 'activated' };
                // Commit the acknowledged key before the optional status query.
                await savePrimarySecret('activated');
              }
              await flow.confirmTotpResetForSession(accessToken, pending);
              await savePrimarySecret('confirmed');
            }
          });
          await persistChatGptWebSession(latest.id, {
            ...session, storageState: await flow.exportCookieStorageState(),
            status: preparingNew ? '新 2FA 已生成，待保存并激活' : '已换绑2FA',
          });
          return outcome(true, preparingNew ? 'prepared' : 'confirmed');
        } finally {
          await flow.dispose().catch(() => {});
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latest = findAccountById(account?.id) || account;
      let pending = latest?.totp_reset_pending;
      if (preparingNew && !pending?.secret) pending = error.authMutationStarted
        ? { phase: 'preparing', secret: '', sessionId: '', factorId: '', createdAt: nowIso() } : null;
      const status = pending?.phase === 'activated' ? '新 2FA 已激活，状态待确认'
        : pending ? '2FA 换绑待确认，请保留新密钥' : '换绑2FA失败';
      if (account?.id) await accountRepository.updateById(account.id, {
        totp_reset_pending: pending || null, status, last_error: message,
      }).catch(() => {});
      emit(message, 'error');
      return outcome(false, pending?.phase || 'failed', message);
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
