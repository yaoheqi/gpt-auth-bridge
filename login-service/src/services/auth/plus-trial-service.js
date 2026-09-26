import { CHATGPT_PLUS_TRIAL_CAMPAIGN as defaultCHATGPT_PLUS_TRIAL_CAMPAIGN } from '../../../lib/openai-auth-urls.js';
import { accountHasChatGptSession as defaultAccountHasChatGptSession } from '../../domain/accounts/account-domain.js';
import { durationMs as defaultDurationMs, structuredLog as defaultStructuredLog } from '../../../lib/structured-log.js';
import { inferOpenAiStage as defaultInferOpenAiStage } from '../../../lib/account-stages.js';
import { mapWithConcurrency as defaultMapWithConcurrency } from '../../../lib/sse.js';
import { nowIso as defaultNowIso } from './auth-records.js';

/** Request-owned operations. Configuration and repositories are supplied by the composition root. */
export function createPlusTrialService({
  CHATGPT_PLUS_TRIAL_CAMPAIGN = defaultCHATGPT_PLUS_TRIAL_CAMPAIGN,
  OpenAIJsonAuthFlow,
  accountHasChatGptSession = defaultAccountHasChatGptSession,
  accountRepository,
  durationMs = defaultDurationMs,
  findAccountById,
  getOauthBatchConcurrency,
  inferOpenAiStage = defaultInferOpenAiStage,
  mapWithConcurrency = defaultMapWithConcurrency,
  nowIso = defaultNowIso,
  structuredLog = defaultStructuredLog,
} = {}) {
  async function runPlusTrialCheckForAccount(account, {
    onLog,
    countryCode = 'JP',
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

    structuredLog('plus_trial_check_start', {
      email: account.email,
      hasSession: accountHasChatGptSession(account),
    });

    try {
      if (!accountHasChatGptSession(account)) {
        throw new Error('账号缺少 ChatGPT Session（session_access_token）');
      }
      const flowAccount = {
        ...account,
        session_access_token: String(account.session_access_token || '').trim(),
        storage_state_json: String(account.storage_state_json || '').trim(),
      };
      if (account.id) {
        const latest = findAccountById(account.id);
        if (latest) {
          flowAccount.session_access_token = latest.session_access_token || flowAccount.session_access_token;
          flowAccount.storage_state_json = latest.storage_state_json || flowAccount.storage_state_json;
          flowAccount.openai_account_id = latest.openai_account_id || flowAccount.openai_account_id;
        }
      }
      const flow = new OpenAIJsonAuthFlow(flowAccount, sse, { phoneMode: 'sms' });
      await flow.importStoredCookieStorageState().catch(() => 0);
      await flow.ensureChatGptDeviceCookie();
      const result = await flow.ensurePlusTrialCheckedIfNeeded(flowAccount.session_access_token, {
        countryCode,
        throwOnError: true,
      });
      structuredLog('plus_trial_check_done', {
        email: account.email,
        ok: true,
        eligible: Boolean(result.eligible),
        durationMs: durationMs(startedAt),
      });
      return {
        ok: true,
        email: account.email,
        id: account.id,
        eligible: Boolean(result.eligible),
        campaign: result.campaign || CHATGPT_PLUS_TRIAL_CAMPAIGN,
        country: result.country || countryCode,
        planType: result.planType || '',
        reason: result.reason || '',
        detail: result.detail || '',
        pricingConfigSummary: result.pricingConfigSummary || null,
        logs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (account.id) {
        await accountRepository.updateById(account.id, {
          plus_trial_checked_at: nowIso(),
          plus_trial_detail: `check_failed: ${message}`.slice(0, 500),
          last_error: `零元试用校验失败: ${message}`.slice(0, 500),
        }).catch(() => {});
      }
      structuredLog('plus_trial_check_failed', {
        email: account.email,
        ok: false,
        durationMs: durationMs(startedAt),
        error: message,
      });
      return {
        ok: false,
        email: account.email,
        id: account.id,
        eligible: null,
        error: message,
        logs,
      };
    }
  }

  async function runPlusTrialCheckForAccounts(accounts, {
    onAccountStart,
    onAccountLog,
    onAccountDone,
    countryCode = 'JP',
  } = {}) {
    const results = await mapWithConcurrency(accounts, getOauthBatchConcurrency(), async account => {
      if (typeof onAccountStart === 'function') {
        onAccountStart({
          email: account.email,
          id: account.id,
          stage: inferOpenAiStage(account),
        });
      }
      const result = await runPlusTrialCheckForAccount(account, {
        onLog: onAccountLog,
        countryCode,
      });
      if (typeof onAccountDone === 'function') onAccountDone(result);
      return result;
    });
    const success = results.filter(item => item.ok).length;
    const eligible = results.filter(item => item.ok && item.eligible === true).length;
    const ineligible = results.filter(item => item.ok && item.eligible === false).length;
    const failed = results.filter(item => !item.ok).length;
    return { ok: true, success, eligible, ineligible, failed, results };
  }

  return { runPlusTrialCheckForAccount, runPlusTrialCheckForAccounts };
}
