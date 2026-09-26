import {
  CHATGPT_ACCOUNTS_CHECK_URL as defaultCHATGPT_ACCOUNTS_CHECK_URL,
  CHATGPT_BASE_URL as defaultCHATGPT_BASE_URL,
  CHATGPT_CHECKOUT_PRICING_CONFIG_URL as defaultCHATGPT_CHECKOUT_PRICING_CONFIG_URL,
  CHATGPT_PLUS_TRIAL_CAMPAIGN as defaultCHATGPT_PLUS_TRIAL_CAMPAIGN,
  CHATGPT_PLUS_TRIAL_ELIGIBILITY_URL as defaultCHATGPT_PLUS_TRIAL_ELIGIBILITY_URL,
} from '../../../../lib/openai-auth-urls.js';
import {
  decodeJwtPayload as defaultDecodeJwtPayload,
  firstNonEmpty as defaultFirstNonEmpty,
  getNestedRecord as defaultGetNestedRecord,
} from '../../../../lib/jwt-utils.js';
import { nowIso as defaultNowIso } from '../auth-records.js';

/** Request-owned operations. Configuration and repositories are supplied by the composition root. */
export function createPlusTrialMethods({
  CHATGPT_ACCOUNTS_CHECK_URL = defaultCHATGPT_ACCOUNTS_CHECK_URL,
  CHATGPT_BASE_URL = defaultCHATGPT_BASE_URL,
  CHATGPT_CHECKOUT_PRICING_CONFIG_URL = defaultCHATGPT_CHECKOUT_PRICING_CONFIG_URL,
  CHATGPT_PLUS_TRIAL_CAMPAIGN = defaultCHATGPT_PLUS_TRIAL_CAMPAIGN,
  CHATGPT_PLUS_TRIAL_ELIGIBILITY_URL = defaultCHATGPT_PLUS_TRIAL_ELIGIBILITY_URL,
  accountRepository,
  decodeJwtPayload = defaultDecodeJwtPayload,
  firstNonEmpty = defaultFirstNonEmpty,
  getNestedRecord = defaultGetNestedRecord,
  nowIso = defaultNowIso,
} = {}) {
  return {
    extractChatGptAccountIdFromAccessToken(accessToken) {
      const claims = decodeJwtPayload(accessToken);
      const auth = getNestedRecord(claims, 'https://api.openai.com/auth');
      return firstNonEmpty(
        auth.chatgpt_account_id,
        claims.chatgpt_account_id,
        this.account?.openai_account_id,
        this.account?.agent_account_id,
      );
    },

    extractPlanTypeFromAccessToken(accessToken) {
      const claims = decodeJwtPayload(accessToken);
      const auth = getNestedRecord(claims, 'https://api.openai.com/auth');
      return String(auth.chatgpt_plan_type || claims.chatgpt_plan_type || '').trim().toLowerCase();
    },

    async checkZeroDollarPlusTrial(accessToken, { countryCode = 'JP' } = {}) {
      const token = String(accessToken || '').trim();
      if (!token) throw new Error('零元试用校验缺少 accessToken');
      await this.ensureChatGptDeviceCookie();
      const country = String(countryCode || 'JP').trim().toUpperCase() || 'JP';
      const accountId = this.extractChatGptAccountIdFromAccessToken(token);
      const tokenPlan = this.extractPlanTypeFromAccessToken(token);
      const referer = `${CHATGPT_BASE_URL}/?openaicom_referred=true&promo_campaign=${CHATGPT_PLUS_TRIAL_CAMPAIGN}`;

      this.log(`校验零元 Plus 试用资格（campaign=${CHATGPT_PLUS_TRIAL_CAMPAIGN}, country=${country}）`);

      const extraHeaders = {
        referer,
        ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
      };

      let accountsCheck = null;
      let eligibility = null;
      let pricingConfig = null;
      let planType = tokenPlan;
      let campaignFromCheck = '';

      try {
        accountsCheck = await this.fetchChatGptJson(CHATGPT_ACCOUNTS_CHECK_URL, {
            accessToken: token,
            targetPath: '/backend-api/accounts/check/v4-2023-04-27',
            label: 'accounts/check',
            extraHeaders,
          });
        const accounts = accountsCheck?.accounts && typeof accountsCheck.accounts === 'object'
          ? accountsCheck.accounts
          : {};
        const order = [];
        if (accountId && accounts[accountId]) order.push(accountId);
        if (Array.isArray(accountsCheck?.account_ordering)) {
          for (const id of accountsCheck.account_ordering) {
            const key = String(id || '');
            if (key && !order.includes(key)) order.push(key);
          }
        }
        for (const key of Object.keys(accounts)) {
          if (!order.includes(key)) order.push(key);
        }
        for (const id of order) {
          const row = accounts[id];
          if (!row || typeof row !== 'object') continue;
          const nested = row.account && typeof row.account === 'object' ? row.account : {};
          const ent = row.entitlement && typeof row.entitlement === 'object' ? row.entitlement : {};
          planType = String(
            nested.plan_type || nested.planType || ent.subscription_plan || planType || '',
          ).trim().toLowerCase();
          const campaigns = nested.eligible_promo_campaigns
            || row.eligible_promo_campaigns
            || {};
          const plusCamp = campaigns.plus || campaigns.chatgptplusplan || campaigns.ChatGPTPlus || null;
          if (plusCamp && typeof plusCamp === 'object') {
            campaignFromCheck = String(plusCamp.id || plusCamp.promo_campaign_id || '').trim();
          } else if (typeof plusCamp === 'string') {
            campaignFromCheck = plusCamp.trim();
          }
          if (planType || campaignFromCheck) break;
        }
      } catch (error) {
        this.log(`accounts/check 失败: ${error instanceof Error ? error.message : error}`, 'warn');
      }

      try {
        eligibility = await this.fetchChatGptJson(CHATGPT_PLUS_TRIAL_ELIGIBILITY_URL, {
            accessToken: token,
            targetPath: `/backend-api/promotions/eligibility/${CHATGPT_PLUS_TRIAL_CAMPAIGN}`,
            label: 'promotions/eligibility',
            extraHeaders,
          });
      } catch (error) {
        this.log(`promotions/eligibility 失败: ${error instanceof Error ? error.message : error}`, 'warn');
      }

      try {
        pricingConfig = await this.fetchChatGptJson(CHATGPT_CHECKOUT_PRICING_CONFIG_URL(country), {
            accessToken: token,
            targetPath: `/backend-api/checkout_pricing_config/configs/${country}`,
            label: 'checkout_pricing_config',
            extraHeaders,
          });
      } catch (error) {
        this.log(`checkout_pricing_config/${country} 失败: ${error instanceof Error ? error.message : error}`, 'warn');
      }

      const paidPlans = new Set(['plus', 'chatgptplusplan', 'pro', 'chatgptproplan', 'team', 'business', 'enterprise']);
      const normalizedPlan = planType.replace(/^chatgpt/, '').replace(/plan$/, '') || planType;
      let eligible = false;
      let reason = '';

      if (paidPlans.has(planType) || paidPlans.has(normalizedPlan)) {
        eligible = false;
        reason = `already_${normalizedPlan || planType || 'paid'}`;
      } else if (eligibility && eligibility.is_eligible === true) {
        eligible = true;
        reason = 'eligibility_api';
      } else if (campaignFromCheck && /plus-1-month-free|plus.*free|free.*plus/i.test(campaignFromCheck)) {
        eligible = true;
        reason = `accounts_check:${campaignFromCheck}`;
      } else if (eligibility && eligibility.is_eligible === false) {
        eligible = false;
        reason = String(
          eligibility?.ineligible_reason?.code
          || eligibility?.ineligible_reason?.message
          || 'user_not_eligible',
        );
      } else if (!eligibility && !accountsCheck) {
        throw new Error('零元试用校验失败：eligibility 与 accounts/check 均不可用');
      } else {
        eligible = false;
        reason = campaignFromCheck ? `no_match:${campaignFromCheck}` : 'not_eligible';
      }

      const plusAmount = Number(pricingConfig?.currency_config?.plus?.month?.amount);
      const currency = String(pricingConfig?.currency_config?.symbol_code || '').trim();
      const detail = [
        eligible ? 'eligible' : 'ineligible',
        reason,
        planType ? `plan=${planType}` : '',
        Number.isFinite(plusAmount) ? `plus_month=${plusAmount}${currency ? currency : ''}` : '',
        campaignFromCheck ? `check_campaign=${campaignFromCheck}` : '',
      ].filter(Boolean).join(' | ').slice(0, 500);

      this.log(`零元试用校验结果: ${eligible ? '有资格' : '无资格'} (${detail})`);
      return {
        ok: true,
        eligible,
        campaign: CHATGPT_PLUS_TRIAL_CAMPAIGN,
        country,
        planType,
        reason,
        detail,
        accountId,
        plusMonthAmount: Number.isFinite(plusAmount) ? plusAmount : null,
        currency,
        eligibility,
        pricingConfigSummary: pricingConfig ? {
          country_code: pricingConfig.country_code || country,
          symbol_code: currency,
          plus_month: plusAmount,
        } : null,
      };
    },

    async ensurePlusTrialCheckedIfNeeded(accessToken, { countryCode = 'JP', throwOnError = false } = {}) {
      const token = String(accessToken || '').trim();
      if (!token) {
        const error = new Error('零元试用校验缺少 accessToken');
        if (throwOnError) throw error;
        this.log(error.message, 'warn');
        return { ok: false, error: error.message };
      }
      try {
        const result = await this.checkZeroDollarPlusTrial(token, { countryCode });
        if (this.account) {
          this.account.plus_trial_eligible = Boolean(result.eligible);
          this.account.plus_trial_campaign = result.campaign || CHATGPT_PLUS_TRIAL_CAMPAIGN;
          this.account.plus_trial_country = result.country || countryCode;
          this.account.plus_trial_checked_at = nowIso();
          this.account.plus_trial_detail = result.detail || '';
          if (result.planType) this.account.agent_plan_type = result.planType;
        }
        if (this.account?.id) {
          await accountRepository.updateById(this.account.id, latest => ({
            plus_trial_eligible: Boolean(result.eligible),
            plus_trial_campaign: result.campaign || CHATGPT_PLUS_TRIAL_CAMPAIGN,
            plus_trial_country: result.country || countryCode,
            plus_trial_checked_at: nowIso(),
            plus_trial_detail: result.detail || '',
            ...(result.planType ? { agent_plan_type: result.planType } : {}),
            ...(result.accountId && !latest.openai_account_id ? { openai_account_id: result.accountId } : {}),
            status: result.eligible ? '有零元试用资格' : '无零元试用资格',
          }));
        }
        return { ok: true, ...result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`零元试用校验失败: ${message}`, 'warn');
        if (this.account?.id) {
          await accountRepository.updateById(this.account.id, {
            plus_trial_checked_at: nowIso(),
            plus_trial_detail: `check_failed: ${message}`.slice(0, 500),
            last_error: `零元试用校验失败: ${message}`.slice(0, 500),
          }).catch(() => {});
        }
        if (throwOnError) throw error;
        return { ok: false, error: message };
      }
    },
  };
}
