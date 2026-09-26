import {
  AUTH_BASE_URL as defaultAUTH_BASE_URL,
  AUTH_PHONE_OTP_SEND_URL as defaultAUTH_PHONE_OTP_SEND_URL,
  AUTH_PHONE_OTP_VALIDATE_URL as defaultAUTH_PHONE_OTP_VALIDATE_URL,
  AUTH_PHONE_SEND_URL as defaultAUTH_PHONE_SEND_URL,
  normalizeAuthContinueUrl as defaultNormalizeAuthContinueUrl,
} from '../../../../lib/openai-auth-urls.js';
import { OPENAI_STAGES as defaultOPENAI_STAGES } from '../../../../lib/account-stages.js';
import {
  OpenAIPhoneSubmissionError as defaultOpenAIPhoneSubmissionError,
  PHONE_ERROR_CATEGORIES as defaultPHONE_ERROR_CATEGORIES,
  createOpenAIPhoneSubmissionError as defaultCreateOpenAIPhoneSubmissionError,
  nextPhoneRetryDecision as defaultNextPhoneRetryDecision,
} from '../../../../lib/openai-phone-errors.js';
import {
  SMSBOWER_COUNTRY_LABELS as defaultSMSBOWER_COUNTRY_LABELS,
  SMSBOWER_FAILS_BEFORE_SWITCH as defaultSMSBOWER_FAILS_BEFORE_SWITCH,
  SMSBOWER_OPENAI_SERVICE as defaultSMSBOWER_OPENAI_SERVICE,
  SMSBOWER_PRICE_STEP as defaultSMSBOWER_PRICE_STEP,
  SmsBowerError as defaultSmsBowerError,
  createSmsCountryPricePlanner as defaultCreateSmsCountryPricePlanner,
  rankServiceCountriesByPrice as defaultRankServiceCountriesByPrice,
  resolveSmsAcquireCountries as defaultResolveSmsAcquireCountries,
} from '../../../../lib/smsbower.js';
import {
  cancelSmsActivationSnapshot as defaultCancelSmsActivationSnapshot,
  isReusableSmsActivationStatus as defaultIsReusableSmsActivationStatus,
} from '../../../../lib/sms-activation-state.js';
import { maskPhone as defaultMaskPhone } from '../../../domain/accounts/account-domain.js';
import { nowIso as defaultNowIso } from '../auth-records.js';

/** Request-owned operations. Configuration and repositories are supplied by the composition root. */
export function createPhoneChallengeMethods({
  AUTH_BASE_URL = defaultAUTH_BASE_URL,
  AUTH_PHONE_OTP_SEND_URL = defaultAUTH_PHONE_OTP_SEND_URL,
  AUTH_PHONE_OTP_VALIDATE_URL = defaultAUTH_PHONE_OTP_VALIDATE_URL,
  AUTH_PHONE_SEND_URL = defaultAUTH_PHONE_SEND_URL,
  OPENAI_STAGES = defaultOPENAI_STAGES,
  OpenAIPhoneSubmissionError = defaultOpenAIPhoneSubmissionError,
  PHONE_ERROR_CATEGORIES = defaultPHONE_ERROR_CATEGORIES,
  PHONE_OTP_POLL_INTERVAL_MS,
  PHONE_OTP_WAIT_TIMEOUT_MS,
  SMSBOWER_COUNTRY_LABELS = defaultSMSBOWER_COUNTRY_LABELS,
  SMSBOWER_FAILS_BEFORE_SWITCH = defaultSMSBOWER_FAILS_BEFORE_SWITCH,
  SMSBOWER_OPENAI_SERVICE = defaultSMSBOWER_OPENAI_SERVICE,
  SMSBOWER_PRICE_STEP = defaultSMSBOWER_PRICE_STEP,
  SmsBowerError = defaultSmsBowerError,
  accountRepository,
  cancelSmsActivationSnapshot = defaultCancelSmsActivationSnapshot,
  createOpenAIPhoneSubmissionError = defaultCreateOpenAIPhoneSubmissionError,
  createSmsCountryPricePlanner = defaultCreateSmsCountryPricePlanner,
  getSmsBowerSettings,
  getSmsProviderKey,
  isReusableSmsActivationStatus = defaultIsReusableSmsActivationStatus,
  maskPhone = defaultMaskPhone,
  nextPhoneRetryDecision = defaultNextPhoneRetryDecision,
  normalizeAuthContinueUrl = defaultNormalizeAuthContinueUrl,
  nowIso = defaultNowIso,
  persistOpenAiStage,
  rankServiceCountriesByPrice = defaultRankServiceCountriesByPrice,
  resolveSmsAcquireCountries = defaultResolveSmsAcquireCountries,
  sleep,
  waitForPhoneCode,
  withSmsAcquireSemaphore,
} = {}) {
  return {
    noteSmsAcquireFailure(reason = '') {
      if (!this.smsAcquirePlanner) return null;
      const decision = this.smsAcquirePlanner.recordFailure(reason);
      const label = SMSBOWER_COUNTRY_LABELS[decision.country] || decision.country || '未知';
      if (decision.switched === 'country') {
        this.log(`SMS 取号策略：同一国家已失败 ${decision.failsBeforeSwitch} 次，切换到 ${label}，maxPrice=${decision.workingMaxPrice}`, 'warn');
      } else if (decision.switched === 'price') {
        this.log(`SMS 取号策略：国家列表已用尽，提高 maxPrice → ${decision.workingMaxPrice}（上限 ${decision.ceilingMaxPrice}），回到 ${label}`, 'warn');
      } else if (decision.exhausted) {
        this.log(`SMS 取号策略：国家与价格均已尝试至上限 ${decision.ceilingMaxPrice}，停止换号`, 'warn');
      } else {
        this.log(`SMS 取号策略：国家 ${label} 失败 ${decision.failsOnCurrent}/${decision.failsBeforeSwitch}（maxPrice=${decision.workingMaxPrice}）`, 'warn');
      }
      return decision;
    },

    async ensureSmsAcquirePlanner(settings = getSmsBowerSettings()) {
      if (this.smsAcquirePlanner && !this.smsAcquirePlanner.isExhausted()) return this.smsAcquirePlanner;
      const service = settings.service || SMSBOWER_OPENAI_SERVICE;
      let countries = [...(settings.countries || [])];
      if (!countries.length) {
        this.log(`SMSBower 未限定国家，按服务 ${service} 拉取 getPrices 并按最低价匹配`);
        const prices = await this.smsProvider.getPrices({ service });
        const priceRows = rankServiceCountriesByPrice(prices, service, {
          maxPrice: settings.maxPrice,
          minPrice: settings.minPrice,
        });
        countries = resolveSmsAcquireCountries({ configuredCountries: [], priceRows });
        if (!countries.length) {
          throw new Error(`SMSBower 服务 ${service} 在价格/库存筛选后没有可取号国家（maxPrice=${settings.maxPrice || '无'}）`);
        }
        const preview = priceRows.slice(0, 5).map(row => `${row.country}=$${row.cost}`).join(', ');
        this.log(`SMSBower 最低价候选国家（前 ${Math.min(5, priceRows.length)}）：${preview}`);
      }
      this.smsAcquirePlanner = createSmsCountryPricePlanner({
        countries,
        minPrice: settings.minPrice,
        maxPrice: settings.maxPrice,
        priceStep: settings.priceStep || SMSBOWER_PRICE_STEP,
        failsBeforeSwitch: settings.failsBeforeSwitch || SMSBOWER_FAILS_BEFORE_SWITCH,
      });
      const snap = this.smsAcquirePlanner.snapshot();
      const label = SMSBOWER_COUNTRY_LABELS[snap.country] || snap.country || '未知';
      this.log(`SMS 取号策略：起始国家 ${label}，maxPrice=${snap.workingMaxPrice}→上限 ${snap.ceilingMaxPrice}，同国 ${snap.failsBeforeSwitch} 次失败后换国家/抬价`);
      return this.smsAcquirePlanner;
    },

    isPhoneChallengeUrl(url) {
      const text = String(url || '');
      return text.startsWith(`${AUTH_BASE_URL}/add-phone`)
        || text.startsWith(`${AUTH_BASE_URL}/phone-otp/select-channel`)
        || text.startsWith(`${AUTH_BASE_URL}/phone-verification`);
    },

    async handlePhoneChallenge(url) {
      if (this.phoneMode === 'agent') {
        return this.registerAgentIdentityFromWebSession();
      }
      if (String(url || '').startsWith(`${AUTH_BASE_URL}/add-phone`)) {
        return this.handleAddPhone();
      }
      if (String(url || '').startsWith(`${AUTH_BASE_URL}/phone-otp/select-channel`)) {
        return this.handlePhoneOtpSelectChannel();
      }
      if (String(url || '').startsWith(`${AUTH_BASE_URL}/phone-verification`)) {
        return this.handlePhoneVerification();
      }
      throw new Error(`未知手机验证页: ${url}`);
    },

    async sendPhoneOtp(phoneNumber) {
      let response;
      try {
        response = await this.fetch(AUTH_PHONE_SEND_URL, {
          method: 'POST',
          headers: this.browserHeaders({
            accept: 'application/json',
            'content-type': 'application/json',
            origin: AUTH_BASE_URL,
            referer: `${AUTH_BASE_URL}/add-phone`,
          }),
          body: JSON.stringify({ phone_number: phoneNumber }),
        });
      } catch (error) {
        throw createOpenAIPhoneSubmissionError({
          code: error?.code || error?.cause?.code || 'transport_error',
          message: error instanceof Error ? error.message : String(error),
        });
      }

      let rawBody = '';
      try {
        rawBody = await response.text();
      } catch (error) {
        throw createOpenAIPhoneSubmissionError({
          code: error?.code || error?.cause?.code || 'response_read_error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      let payload = {};
      try { payload = rawBody ? JSON.parse(rawBody) : {}; } catch {}
      const code = String(payload?.error?.code || payload?.error || payload?.code || '');
      const message = String(payload?.error?.message || payload?.message || code || rawBody.slice(0, 500));
      if (!response.ok) {
        throw createOpenAIPhoneSubmissionError({
          httpStatus: response.status,
          code,
          message,
          rawBody,
        });
      }
      let continueURL = '';
      try {
        const candidate = normalizeAuthContinueUrl(payload.continue_url);
        const parsed = new URL(candidate);
        if (['http:', 'https:'].includes(parsed.protocol)) continueURL = parsed.toString();
      } catch {}
      if (!continueURL) {
        throw new OpenAIPhoneSubmissionError('SendPhoneOtp 响应缺少有效 continue_url', {
          httpStatus: response.status,
          code: code || 'missing_continue_url',
          rawBody,
          category: PHONE_ERROR_CATEGORIES.NUMBER_REJECTED,
        });
      }
      return continueURL;
    },

    async openAddPhonePage() {
      await this.fetch(`${AUTH_BASE_URL}/add-phone`, {
        method: 'GET',
        headers: this.browserHeaders({
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          referer: `${AUTH_BASE_URL}/`,
        }),
      });
    },

    isPhoneNumberInUseError(error) {
      if (error?.code === 'phone_number_in_use') return true;
      const message = error instanceof Error ? error.message : String(error || '');
      return /phone_number_in_use/i.test(message);
    },

    async cancelSmsBowerActivationImmediate(reason = 'cancelled') {
      const activation = this.smsActivation ? Object.freeze({ ...this.smsActivation }) : null;
      this.smsActivation = null;
      if (!activation) return;
      const result = await cancelSmsActivationSnapshot({
        activation,
        reason,
        cancelRemote: this.smsProvider
          ? snapshot => this.smsProvider.setStatus(snapshot.activationId, 8)
          : undefined,
        persist: (status, snapshot) => this.persistSmsActivation(status, '', snapshot),
      });
      if (result.error) {
        this.log(`${this.smsProviderLabel} 取消订单失败 (${reason}): ${result.error.message}；已更新状态 ${result.status}`, 'warn');
        return;
      }
      this.log(`已取消 ${this.smsProviderLabel} 订单 ${activation.activationId}（${result.status}）`);
    },

    async sendExistingPhoneOtp() {
      const response = await this.fetch(AUTH_PHONE_OTP_SEND_URL, {
        method: 'POST',
        headers: this.browserHeaders({
          accept: 'application/json',
          'content-type': 'application/json',
          origin: AUTH_BASE_URL,
          referer: `${AUTH_BASE_URL}/phone-otp/select-channel`,
        }),
        body: JSON.stringify({ channel: 'sms' }),
      });
      if (!response.ok) throw new Error(`PhoneOtpSend请求失败: ${await this.formatErrorResponse(response)}`);
      const payload = await response.json();
      return normalizeAuthContinueUrl(payload.continue_url || `${AUTH_BASE_URL}/phone-verification`);
    },

    async validatePhoneOtp(code) {
      const response = await this.fetch(AUTH_PHONE_OTP_VALIDATE_URL, {
        method: 'POST',
        headers: this.browserHeaders({
          accept: 'application/json',
          'content-type': 'application/json',
          origin: AUTH_BASE_URL,
          referer: `${AUTH_BASE_URL}/phone-verification`,
        }),
        body: JSON.stringify({ code }),
      });
      if (!response.ok) throw new Error(`PhoneOtpValidate请求失败: ${await this.formatErrorResponse(response)}`);
      const payload = await response.json();
      return normalizeAuthContinueUrl(payload.continue_url);
    },

    async persistSmsActivation(status, code = '', activationSnapshot = this.smsActivation) {
      const activation = activationSnapshot;
      if (!activation) return;
      this.account.auth_phone_number = activation.phoneNumber;
      this.account.sms_provider = getSmsProviderKey();
      this.account.sms_activation_id = activation.activationId;
      this.account.sms_activation_status = status;
      if (!this.account.id) return;
      await accountRepository.updateById(this.account.id, {
        auth_phone_number: activation.phoneNumber,
        sms_provider: this.account.sms_provider,
        sms_activation_id: activation.activationId,
        sms_activation_status: status,
        ...(code ? { last_sms_code: code, last_sms_at: nowIso() } : {}),
      });
    },

    async setSmsBowerStatus(status, label) {
      if (!this.smsProvider || !this.smsActivation) return;
      const activation = Object.freeze({ ...this.smsActivation });
      try {
        await this.smsProvider.setStatus(activation.activationId, status);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`${this.smsProviderLabel} 更新订单状态失败 (${label}): ${message}`, 'warn');
      }
      await this.persistSmsActivation(label, '', activation);
    },

    async acquireSmsBowerNumber() {
      if (!this.smsProvider) throw new Error('未配置短信服务 API Key，无法自动获取手机号');
      const activation = await withSmsAcquireSemaphore.run(async () => {
        const settings = getSmsBowerSettings();
        if (String(settings?.provider || 'smsbower').trim().toLowerCase() === 'manual_sms') {
          this.log(`${this.smsProviderLabel} 开始创建号码租约`);
          return this.smsProvider.acquireNumber({
            timeoutMs: this.smsCodeTimeoutMs,
            pollIntervalMs: PHONE_OTP_POLL_INTERVAL_MS,
          });
        }
        const service = settings.service || SMSBOWER_OPENAI_SERVICE;
        await this.ensureSmsAcquirePlanner(settings);
        let lastError;
        while (!this.smsAcquirePlanner.isExhausted()) {
          const target = this.smsAcquirePlanner.snapshot();
          const country = target.country;
          if (!country) break;
          const label = SMSBOWER_COUNTRY_LABELS[country] || country;
          try {
            this.log(
              `SMSBower getNumber：服务 ${service}（OpenAI/ChatGPT），国家 ${label}，`
              + `maxPrice=${target.workingMaxPrice}（上限 ${target.ceilingMaxPrice}），`
              + `同国失败 ${target.failsOnCurrent}/${target.failsBeforeSwitch}`,
            );
            return await this.smsProvider.acquireNumber({
              service,
              country,
              maxPrice: target.workingMaxPrice,
              minPrice: settings.minPrice,
              providerIds: settings.providerIds,
              exceptProviderIds: settings.exceptProviderIds,
              phoneException: settings.phoneException,
            });
          } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            this.log(`SMSBower 国家 ${label} 取号失败: ${message}`, 'warn');
            if (error instanceof SmsBowerError && ['BAD_KEY', 'NO_BALANCE', 'BAD_SERVICE'].includes(error.code)) throw error;
            const decision = this.noteSmsAcquireFailure(error instanceof SmsBowerError ? error.code : message);
            if (decision?.exhausted) break;
          }
        }
        throw lastError instanceof Error
          ? lastError
          : new Error(`${this.smsProviderLabel} 在配置的国家/价格策略下均未获取到可用号码`);
      });

      this.smsActivation = activation;
      await this.persistSmsActivation('number_acquired');
      if (this.account?.id) await persistOpenAiStage(this.account.id, OPENAI_STAGES.PHONE_PENDING);
      const label = SMSBOWER_COUNTRY_LABELS[activation.country] || activation.country || '未知';
      this.log(`${this.smsProviderLabel} 已分配手机号: ${maskPhone(activation.phoneNumber)}${label !== '未知' ? `，国家 ${label}` : ''}，订单 ${activation.activationId}`);
      return activation;
    },

    async waitForSmsBowerCode({ timeoutMs = PHONE_OTP_WAIT_TIMEOUT_MS } = {}) {
      if (!this.smsProvider || !this.smsActivation) throw new Error('当前授权流程没有可用的接码租约');
      let lastNoticeAt = 0;
      const code = await this.smsProvider.waitForCode(this.smsActivation.activationId, {
        timeoutMs,
        pollIntervalMs: PHONE_OTP_POLL_INTERVAL_MS,
        onPoll: result => {
          if (result.status === 'received') return;
          if (Date.now() - lastNoticeAt < 15000) return;
          const elapsedSec = Math.round((Date.now() - (this.smsWaitStartedAtMs || Date.now())) / 1000);
          this.log(`${this.smsProviderLabel} 订单 ${this.smsActivation.activationId} 等待验证码中（已等 ${elapsedSec}s / ${Math.round(timeoutMs / 1000)}s）`);
          lastNoticeAt = Date.now();
        },
      });
      await this.persistSmsActivation('code_received', code);
      this.log(`读取到手机号验证码: ${code} (${maskPhone(this.smsActivation.phoneNumber)})`);
      return code;
    },

    async handleAddPhone({ initialDeliveryAttempts = 0 } = {}) {
      if (this.smsProvider) {
        const settings = getSmsBowerSettings();
        const maxDeliveryAttempts = settings.numberAttempts || 3;
        const maxRejectedSwaps = Math.max(maxDeliveryAttempts * 4, 20);
        const maxRiskRejections = 2;
        let retryState = { deliveryAttempts: initialDeliveryAttempts, rejectedSwaps: 0, riskRejections: 0 };
        let lastError;
        while (retryState.deliveryAttempts < maxDeliveryAttempts
          && retryState.rejectedSwaps < maxRejectedSwaps
          && retryState.riskRejections < maxRiskRejections) {
          let submitted = false;
          let timeoutMs = 0;
          try {
            if (retryState.deliveryAttempts || retryState.rejectedSwaps || retryState.riskRejections) {
              this.log('换号前重新打开 add-phone 页');
              await this.openAddPhonePage();
            }
            const activation = await this.acquireSmsBowerNumber();
            const progress = `投递 ${retryState.deliveryAttempts}/${maxDeliveryAttempts} · 拒号换号 ${retryState.rejectedSwaps}/${maxRejectedSwaps} · 风控拒绝 ${retryState.riskRejections}/${maxRiskRejections}`;
            this.log(`提交 ${this.smsProviderLabel} 手机号 (${progress}): ${maskPhone(activation.phoneNumber)}`);
            await this.sendPhoneOtp(activation.phoneNumber);
            submitted = true;
            await this.setSmsBowerStatus(1, 'sms_sent');
            timeoutMs = this.smsCodeTimeoutMs;
            this.smsWaitStartedAtMs = Date.now();
            this.log(`等待短信验证码，单号最长 ${Math.round(timeoutMs / 1000)}s，超时自动换号`);
            const code = await this.waitForSmsBowerCode({ timeoutMs });
            this.log('提交手机号短信验证码');
            const continueURL = await this.validatePhoneOtp(code);
            await this.setSmsBowerStatus(6, 'completed');
            return continueURL;
          } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            const timedOut = error instanceof SmsBowerError && error.code === 'SMS_TIMEOUT';
            const phone = this.smsActivation?.phoneNumber || '';
            const policyError = error instanceof OpenAIPhoneSubmissionError
              ? error
              : { category: submitted || timedOut ? PHONE_ERROR_CATEGORIES.HARD_FAILURE : PHONE_ERROR_CATEGORIES.TRANSIENT_FAILURE };
            const decision = nextPhoneRetryDecision(policyError, retryState, {
              maxDeliveryAttempts,
              maxRejectedSwaps,
              maxRiskRejections,
            });
            retryState = decision.state;
            const progress = `投递 ${retryState.deliveryAttempts}/${maxDeliveryAttempts} · 拒号换号 ${retryState.rejectedSwaps}/${maxRejectedSwaps} · 风控拒绝 ${retryState.riskRejections}/${maxRiskRejections}`;
            const reason = timedOut ? 'timeout' : decision.category;
            this.log(
              timedOut
                ? `手机号 ${maskPhone(phone)} 等码超时（${Math.round(timeoutMs / 1000)}s），取消并换号；${progress}`
                : `手机号 ${maskPhone(phone)} 失败 [${decision.category}]：${message}；${progress}`,
              'warn',
            );
            await this.cancelSmsBowerActivationImmediate(reason);
            // 国家库存失败只在 acquire 阶段计数；号码拒绝和等码超时只更换号码。
            if (decision.category === PHONE_ERROR_CATEGORIES.TRANSIENT_FAILURE && decision.action === 'swap') await sleep(1000);
            if (decision.action === 'stop') throw lastError;
            if (error instanceof SmsBowerError && ['BAD_KEY', 'NO_BALANCE', 'BAD_SERVICE'].includes(error.code)) throw error;
            if (this.smsAcquirePlanner?.isExhausted()) throw lastError;
          }
        }
        throw lastError instanceof Error ? lastError : new Error(`${this.smsProviderLabel} 获取手机号/验证码失败`);
      }
      const phoneNumber = String(this.account.auth_phone_number || '').trim();
      if (!phoneNumber) throw new Error('触发 add-phone，但该账号没有保存授权手机号');
      this.log(`提交已保存手机号: ${maskPhone(phoneNumber)}`);
      await this.sendPhoneOtp(phoneNumber);
      return this.handlePhoneVerification();
    },

    async handlePhoneVerification() {
      if (!this.smsActivation && this.smsProvider) {
        const activationId = String(this.account?.sms_activation_id || '').trim();
        const phoneNumber = String(this.account?.auth_phone_number || '').trim();
        const activationStatus = String(this.account?.sms_activation_status || '').trim();
        if (activationId && phoneNumber && isReusableSmsActivationStatus(activationStatus)) {
          this.smsActivation = { activationId, phoneNumber };
          this.log(`复用已保存 ${this.smsProviderLabel} 订单接码: ${maskPhone(phoneNumber)} / ${activationId}`);
          try {
            // 3 = 请求重发验证码（若订单仍有效）
            await this.smsProvider.setStatus(activationId, 3);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`${this.smsProviderLabel} 请求重发失败，继续轮询旧订单: ${message}`, 'warn');
          }
        }
      }
      if (this.smsActivation) {
        this.log(`遇到手机验证，使用 ${this.smsProviderLabel} 自动接码`);
        try {
          const timeoutMs = this.smsCodeTimeoutMs;
          this.smsWaitStartedAtMs = Date.now();
          this.log(`等待短信验证码，单号最长 ${Math.round(timeoutMs / 1000)}s`);
          const code = await this.waitForSmsBowerCode({ timeoutMs });
          this.log('提交手机号短信验证码');
          const continueURL = await this.validatePhoneOtp(code);
          await this.setSmsBowerStatus(6, 'completed');
          return continueURL;
        } catch (error) {
          const timedOut = error instanceof SmsBowerError && error.code === 'SMS_TIMEOUT';
          await this.cancelSmsBowerActivationImmediate(timedOut ? 'timeout' : 'verification_failed');
          if (timedOut && this.smsProvider) {
            const maxDeliveryAttempts = getSmsBowerSettings().numberAttempts || 3;
            if (maxDeliveryAttempts <= 1) throw error;
            this.log('当前号码等码超时，回到换号流程重新取号', 'warn');
            return this.handleAddPhone({ initialDeliveryAttempts: 1 });
          }
          throw error;
        }
      }
      this.log('遇到手机验证，使用已保存短信链接自动接码');
      const code = await waitForPhoneCode(this.account, (msg, level = 'info') => this.log(msg, level));
      this.log('提交手机号短信验证码');
      return this.validatePhoneOtp(code);
    },

    async handlePhoneOtpSelectChannel() {
      this.log('遇到手机验证码通道选择，自动选择短信接收');
      await this.sendExistingPhoneOtp();
      return this.handlePhoneVerification();
    },
  };
}
