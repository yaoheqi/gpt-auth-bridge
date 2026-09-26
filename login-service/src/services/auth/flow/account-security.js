import {
  CHATGPT_BASE_URL as defaultCHATGPT_BASE_URL,
  CHATGPT_LOGOUT_ALL_URL as defaultCHATGPT_LOGOUT_ALL_URL,
  CHATGPT_MFA_ACTIVATE_ENROLLMENT_URL as defaultCHATGPT_MFA_ACTIVATE_ENROLLMENT_URL,
  CHATGPT_MFA_DISABLE_URL as defaultCHATGPT_MFA_DISABLE_URL,
  CHATGPT_MFA_ENROLL_URL as defaultCHATGPT_MFA_ENROLL_URL,
  CHATGPT_MFA_INFO_URL as defaultCHATGPT_MFA_INFO_URL,
} from '../../../../lib/openai-auth-urls.js';
import {
  generateTotpCode as defaultGenerateTotpCode,
  hasTotpSecret as defaultHasTotpSecret,
  normalizeTotpSecret as defaultNormalizeTotpSecret,
  validateTotpSecret as defaultValidateTotpSecret,
} from '../../../../lib/totp.js';
import { looksLikeCloudflareBlock as defaultLooksLikeCloudflareBlock } from '../../../../lib/proxy-config.js';
import { randomUUID as defaultRandomUUID } from 'crypto';
import { readLogoutAllResponse as defaultReadLogoutAllResponse } from '../../logout-all-response.js';
import { sessionApiError as defaultSessionApiError } from '../../cached-web-session.js';

/** Request-owned operations. Configuration and repositories are supplied by the composition root. */
export function createAccountSecurityMethods({
  CHATGPT_BASE_URL = defaultCHATGPT_BASE_URL,
  CHATGPT_LOGOUT_ALL_URL = defaultCHATGPT_LOGOUT_ALL_URL,
  CHATGPT_MFA_ACTIVATE_ENROLLMENT_URL = defaultCHATGPT_MFA_ACTIVATE_ENROLLMENT_URL,
  CHATGPT_MFA_DISABLE_URL = defaultCHATGPT_MFA_DISABLE_URL,
  CHATGPT_MFA_ENROLL_URL = defaultCHATGPT_MFA_ENROLL_URL,
  CHATGPT_MFA_INFO_URL = defaultCHATGPT_MFA_INFO_URL,
  accountRepository,
  generateTotpCode = defaultGenerateTotpCode,
  hasTotpSecret = defaultHasTotpSecret,
  looksLikeCloudflareBlock = defaultLooksLikeCloudflareBlock,
  normalizeTotpSecret = defaultNormalizeTotpSecret,
  randomUUID = defaultRandomUUID,
  readLogoutAllResponse = defaultReadLogoutAllResponse,
  sessionApiError = defaultSessionApiError,
  validateTotpSecret = defaultValidateTotpSecret,
} = {}) {
  return {
    async logoutAllChatGptSessions(accessToken) {
      if (!accessToken) throw new Error('logout_all 缺少 accessToken');
      await this.ensureChatGptDeviceCookie();
      this.log('调用 ChatGPT logout_all，退出全部会话');
      const response = await this.fetch(CHATGPT_LOGOUT_ALL_URL, {
        method: 'POST',
        redirect: 'manual',
        headers: this.browserHeaders({
          accept: '*/*',
          authorization: `Bearer ${accessToken}`,
          origin: CHATGPT_BASE_URL,
          referer: `${CHATGPT_BASE_URL}/`,
          'oai-device-id': this.deviceID || '',
          'oai-language': this.fingerprint?.locale || 'en-US',
          'oai-session-id': randomUUID(),
          'x-openai-target-path': '/backend-api/accounts/logout_all',
          'x-openai-target-route': '/backend-api/accounts/logout_all',
        }),
        body: '',
      });
      const result = await readLogoutAllResponse(response);
      this.log(`logout_all 成功：HTTP ${result.status}，响应类型 ${result.responseType}`);
      return result;
    },

    chatgptBackendHeaders(accessToken, targetPath, extra = {}) {
      return this.browserHeaders({
        accept: '*/*',
        authorization: `Bearer ${accessToken}`,
        origin: CHATGPT_BASE_URL,
        referer: `${CHATGPT_BASE_URL}/`,
        'oai-device-id': this.deviceID || '',
        'oai-language': this.fingerprint?.locale || 'zh-CN',
        'oai-session-id': randomUUID(),
        'x-openai-target-path': targetPath,
        'x-openai-target-route': targetPath,
        ...extra,
      });
    },

    async fetchChatGptJson(url, {
      method = 'GET',
      accessToken,
      targetPath,
      body,
      label = 'ChatGPT API',
      extraHeaders = {},
      allowCookieAuth = false,
    } = {}) {
      if (!accessToken && !allowCookieAuth) throw new Error(`${label} 缺少 accessToken`);
      await this.ensureChatGptDeviceCookie();
      const path = targetPath || new URL(url).pathname;
      const headers = accessToken ? this.chatgptBackendHeaders(accessToken, path, extraHeaders)
        : this.browserHeaders({ accept: 'application/json', referer: `${CHATGPT_BASE_URL}/`, ...extraHeaders });
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await this.fetch(url, {
        method,
        redirect: 'manual',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 300) }; }
      if (!response.ok || payload?.error || payload?.success === false) {
        if (looksLikeCloudflareBlock({ status: response.status, body: text, headers: response.headers })) {
          this.throwProxyEdgeBlocked(response.status, `${label} · ${path}`);
        }
        throw sessionApiError(label, response.status, payload);
      }
      if (!payload || typeof payload !== 'object' || Object.hasOwn(payload, 'raw')) throw new Error(`${label} 未返回有效 JSON`);
      return payload;
    },

    async getMfaInfo(accessToken) {
      return this.fetchChatGptJson(CHATGPT_MFA_INFO_URL, {
        accessToken,
        targetPath: '/backend-api/accounts/mfa_info',
        label: 'mfa_info',
      });
    },

    async enrollTotpMfa(accessToken) {
      return this.fetchChatGptJson(CHATGPT_MFA_ENROLL_URL, {
        method: 'POST',
        accessToken,
        targetPath: '/backend-api/accounts/mfa/enroll',
        body: { factor_type: 'totp' },
        label: 'mfa/enroll',
      });
    },

    async disableTotpMfa(accessToken, factorId) {
      const id = String(factorId || '').trim();
      if (!id) throw new Error('disable_in_house 缺少 factor_id');
      return this.fetchChatGptJson(CHATGPT_MFA_DISABLE_URL, {
        method: 'POST',
        accessToken,
        targetPath: '/backend-api/accounts/mfa/user/disable_in_house',
        body: { factor_id: id },
        label: 'disable_in_house',
      });
    },

    async activateTotpEnrollment(accessToken, { code, sessionId } = {}) {
      return this.fetchChatGptJson(CHATGPT_MFA_ACTIVATE_ENROLLMENT_URL, {
        method: 'POST',
        accessToken,
        targetPath: '/backend-api/accounts/mfa/user/activate_enrollment',
        body: {
          code: String(code || '').trim(),
          factor_type: 'totp',
          session_id: String(sessionId || '').trim(),
        },
        label: 'activate_enrollment',
      });
    },

    async enrollAndActivateTotpForSession(accessToken, { skipIfEnabled = true } = {}) {
      const token = String(accessToken || '').trim();
      if (!token) throw new Error('设置 2FA 缺少 accessToken');
      await this.ensureChatGptDeviceCookie();

      this.log('查询 MFA 状态 (mfa_info)');
      const before = await this.getMfaInfo(token);
      const existingTotp = Array.isArray(before?.factors?.totp) ? before.factors.totp : [];
      if (skipIfEnabled && (before?.mfa_enabled || before?.mfa_enabled_v2 || existingTotp.length)) {
        this.log('远端已开启 TOTP MFA，跳过 enroll（无法回填密钥）', 'warn');
        return {
          skipped: true,
          reason: 'already_enabled',
          secret: '',
          factorId: String(existingTotp[0]?.id || before?.native_default_factor_id || ''),
          mfaInfo: before,
        };
      }

      this.log('开始 enroll TOTP MFA');
      const enrolled = await this.enrollTotpMfa(token);
      const secret = validateTotpSecret(enrolled?.secret || '');
      const sessionId = String(enrolled?.session_id || '').trim();
      const factorId = String(enrolled?.factor?.id || '').trim();
      if (!sessionId) throw new Error('mfa/enroll 未返回 session_id');

      const code = generateTotpCode(secret);
      this.log(`提交 TOTP 激活码 (factor=${factorId ? `${factorId.slice(0, 8)}…` : 'n/a'})`);
      const activated = await this.activateTotpEnrollment(token, { code, sessionId });
      if (activated && activated.success === false) {
        throw new Error(`activate_enrollment 返回失败: ${JSON.stringify(activated).slice(0, 200)}`);
      }

      this.log('再次确认 MFA 状态');
      const after = await this.getMfaInfo(token);
      if (!(after?.mfa_enabled || after?.mfa_enabled_v2)) {
        throw new Error('activate_enrollment 后 mfa_info 仍显示未启用');
      }
      this.log('TOTP MFA 设置成功');
      return {
        skipped: false,
        reason: '',
        secret,
        factorId: factorId || String(after?.native_default_factor_id || ''),
        mfaInfo: after,
        enroll: enrolled,
      };
    },

    async resetTotpForSession(accessToken) {
      let authMutationStarted = false;
      try {
        const token = String(accessToken || '').trim();
        if (!token) throw new Error('重设 2FA 缺少 accessToken');
        await this.ensureChatGptDeviceCookie();
        const before = await this.getMfaInfo(token);
        const factors = Array.isArray(before?.factors?.totp) ? before.factors.totp : [];
        const factorId = String(factors[0]?.id || before?.native_default_factor_id || '').trim();
        if (factorId) {
          this.log(`禁用旧 TOTP 因子 (factor=${factorId.slice(0, 8)}…)`);
          await this.disableTotpMfa(token, factorId);
          authMutationStarted = true;
        }

        this.log('生成新的 TOTP 密钥');
        authMutationStarted = true;
        const enrolled = await this.enrollTotpMfa(token);
        const secret = validateTotpSecret(enrolled?.secret || '');
        const sessionId = String(enrolled?.session_id || '').trim();
        const newFactorId = String(enrolled?.factor?.id || '').trim();
        if (!sessionId) throw new Error('mfa/enroll 未返回 session_id');
        const code = generateTotpCode(secret);
        await this.activateTotpEnrollment(token, { code, sessionId });
        const after = await this.getMfaInfo(token);
        if (!(after?.mfa_enabled || after?.mfa_enabled_v2)) {
          throw new Error('新 2FA 激活后 mfa_info 仍显示未启用');
        }
        this.log('TOTP 2FA 换绑成功');
        return { secret, factorId: newFactorId || String(after?.native_default_factor_id || ''), mfaInfo: after, enroll: enrolled };
      } catch (error) {
        error.authMutationStarted = authMutationStarted;
        throw error;
      }
    },

    async ensureTotpEnrolledIfNeeded(accessToken, { throwOnError = false } = {}) {
      if (hasTotpSecret(this.account)) {
        this.log('账号已有本地 TOTP 密钥，后续默认走邮箱/密码/2FA 登录');
        return {
          ok: true,
          skipped: true,
          reason: 'local_secret_present',
          secret: normalizeTotpSecret(this.account.two_factor_secret),
        };
      }
      const token = String(accessToken || '').trim();
      if (!token) {
        const error = new Error('自动设置 2FA 缺少 accessToken');
        if (throwOnError) throw error;
        this.log(error.message, 'warn');
        return { ok: false, skipped: false, error: error.message };
      }
      try {
        this.log('登录后自动设置并保存 TOTP 2FA');
        const result = await this.enrollAndActivateTotpForSession(token, { skipIfEnabled: true });
        if (result.skipped) {
          this.log(`远端已开启 MFA，无法自动写入密钥（${result.reason || 'already_enabled'}）`, 'warn');
          return {
            ok: false,
            skipped: true,
            reason: result.reason || 'already_enabled',
            error: '远端已开启 TOTP MFA，无法回填密钥',
            factorId: result.factorId || '',
          };
        }
        const secret = validateTotpSecret(result.secret);
        this.account.two_factor_secret = secret;
        if (!String(this.account.openai_password || '').trim() && String(this.account.password || '').trim()) {
          this.account.openai_password = String(this.account.password || '').trim();
        }
        if (this.account?.id) {
          await accountRepository.updateById(this.account.id, latest => ({
            two_factor_secret: secret,
            ...(!String(latest.openai_password || '').trim()
              ? { openai_password: String(this.account.openai_password || latest.password || '').trim() } : {}),
            status: '已设置2FA',
            last_error: '',
          }));
        }
        this.log('TOTP 密钥已更新，结果将返回当前浏览器');
        return {
          ok: true,
          skipped: false,
          reason: '',
          secret,
          factorId: result.factorId || '',
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`自动设置 2FA 失败: ${message}`, 'warn');
        if (this.account?.id) {
          await accountRepository.updateById(this.account.id, {
            last_error: `自动设置2FA失败: ${message}`.slice(0, 500),
          }).catch(() => {});
        }
        if (throwOnError) throw error;
        return { ok: false, skipped: false, error: message };
      }
    },
  };
}
