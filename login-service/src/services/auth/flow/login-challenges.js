import {
  AUTH_AUTHORIZE_CONTINUE_URL as defaultAUTH_AUTHORIZE_CONTINUE_URL,
  AUTH_BASE_URL as defaultAUTH_BASE_URL,
  AUTH_MFA_VERIFY_URL as defaultAUTH_MFA_VERIFY_URL,
  AUTH_PASSWORD_VERIFY_URL as defaultAUTH_PASSWORD_VERIFY_URL,
  normalizeAuthContinueUrl as defaultNormalizeAuthContinueUrl,
} from '../../../../lib/openai-auth-urls.js';
import {
  OPENAI_CODEX_REDIRECT_URI as defaultOPENAI_CODEX_REDIRECT_URI,
  buildOpenAIAuthorizationUrl as defaultBuildOpenAIAuthorizationUrl,
  generateOpenAIPkce as defaultGenerateOpenAIPkce,
} from '../../../../lib/openai-oauth.js';
import { firstNonEmpty as defaultFirstNonEmpty } from '../../../../lib/jwt-utils.js';
import { generateTotpCode as defaultGenerateTotpCode, hasTotpSecret as defaultHasTotpSecret } from '../../../../lib/totp.js';
import { openOAuthPage as defaultOpenOAuthPage } from '../../../../lib/oauth-navigation.js';
import {
  protocolLoginCredentialIssue as defaultProtocolLoginCredentialIssue,
  resolveAccountLoginMethod as defaultResolveAccountLoginMethod,
} from '../../../domain/accounts/account-domain.js';
import { resolveOpenAiAccountPassword as defaultResolveOpenAiAccountPassword } from '../auth-records.js';
import { validationError } from '../../../../lib/validation-error.js';
import { readAuthWorkspacePayload } from '../../../../lib/workspace-page.js';

/** Request-owned operations. Configuration and repositories are supplied by the composition root. */
export function createLoginChallengeMethods({
  AUTH_AUTHORIZE_CONTINUE_URL = defaultAUTH_AUTHORIZE_CONTINUE_URL,
  AUTH_BASE_URL = defaultAUTH_BASE_URL,
  AUTH_MFA_VERIFY_URL = defaultAUTH_MFA_VERIFY_URL,
  AUTH_PASSWORD_VERIFY_URL = defaultAUTH_PASSWORD_VERIFY_URL,
  OPENAI_CODEX_REDIRECT_URI = defaultOPENAI_CODEX_REDIRECT_URI,
  buildOpenAIAuthorizationUrl = defaultBuildOpenAIAuthorizationUrl,
  firstNonEmpty = defaultFirstNonEmpty,
  generateOpenAIPkce = defaultGenerateOpenAIPkce,
  generateTotpCode = defaultGenerateTotpCode,
  hasTotpSecret = defaultHasTotpSecret,
  normalizeAuthContinueUrl = defaultNormalizeAuthContinueUrl,
  openOAuthPage = defaultOpenOAuthPage,
  protocolLoginCredentialIssue = defaultProtocolLoginCredentialIssue,
  resolveAccountLoginMethod = defaultResolveAccountLoginMethod,
  resolveOpenAiAccountPassword = defaultResolveOpenAiAccountPassword,
} = {}) {
  return {
    authResponseResult(payload, redirectUrl = '') {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw validationError('AUTH_CONTINUATION_FAILED');
      this.authResponseWorkspaces = readAuthWorkspacePayload(payload);
      const pageType = String(payload?.page?.type || '');
      const next = redirectUrl || payload.continue_url
        || (pageType === 'external_url' ? payload.page?.payload?.url : '');
      return { continueUrl: normalizeAuthContinueUrl(next), pageType, payload };
    },

    prepareLoginUrl(prompt = 'login', { useLoginHint = true } = {}) {
      const pkce = generateOpenAIPkce();
      this.state = pkce.state;
      this.codeVerifier = pkce.codeVerifier;
      return buildOpenAIAuthorizationUrl({
        state: this.state,
        codeChallenge: pkce.codeChallenge,
        redirectUri: OPENAI_CODEX_REDIRECT_URI,
        prompt,
        loginHint: useLoginHint ? this.account.email : '',
      });
    },

    isPasswordTotpAccount() {
      return resolveAccountLoginMethod(this.account) === 'password_totp';
    },

    assertPasswordTotpCredentials() {
      const issue = protocolLoginCredentialIssue(this.account);
      if (issue) throw Object.assign(new Error(issue), { code: 'LOGIN_CREDENTIALS_MISSING' });
    },

    isEmailCodeChallenge({ continueUrl = '', pageType = '', payload } = {}) {
      let path = '';
      if (continueUrl) {
        try {
          const parsed = new URL(continueUrl, AUTH_BASE_URL);
          if (parsed.origin !== AUTH_BASE_URL) return false;
          path = parsed.pathname.replace(/\/$/, '').toLowerCase();
        } catch { return false; }
      }
      const page = String(pageType || payload?.page?.type || '').toLowerCase();
      return ['email_otp_verification', 'email_verification', 'email_otp', 'login_email_otp'].includes(page)
        || /^\/(?:log-in\/)?(?:email-verification|email-otp)$/.test(path);
    },

    async preferPasswordLoginStep(result = {}) {
      if (!this.isEmailCodeChallenge(result)) return result;
      this.assertPasswordTotpCredentials();
      if (this.emailPasswordSwitchAttempted || this.passwordSubmitted || this.totpSubmitted) {
        throw validationError('EMAIL_VERIFICATION_REQUIRED');
      }
      this.emailPasswordSwitchAttempted = true;
      this.log('遇到邮箱验证码，尝试切换为密码登录');
      // Visit the existing password route with the same transport and cookies.
      // Only continue if the upstream accepts that route; never submit an email code.
      const { url } = await openOAuthPage((address, init) => {
        if (new URL(address).origin !== AUTH_BASE_URL) throw new Error('密码登录切换跳转到非预期域名');
        return this.fetch(address, init);
      }, `${AUTH_BASE_URL}/log-in/password`, {
        headers: this.browserHeaders({ accept: 'text/html,application/xhtml+xml,*/*',
          referer: result.continueUrl || `${AUTH_BASE_URL}/log-in` }),
      });
      if (new URL(url).origin !== AUTH_BASE_URL || this.pathOf(url) !== '/log-in/password') {
        throw validationError('EMAIL_VERIFICATION_REQUIRED');
      }
      return { continueUrl: url, pageType: 'login_password' };
    },

    assertSupportedAuthStep({ continueUrl = '' } = {}) {
      if (!String(continueUrl || '').trim()) return;
      const path = this.pathOf(continueUrl).toLowerCase();
      if (
        continueUrl.startsWith(OPENAI_CODEX_REDIRECT_URI)
        || this.isAuthStartUrl(continueUrl)
        || this.isConsentUrl(continueUrl)
        || this.isPhoneChallengeUrl(continueUrl)
        || this.isOAuthTransitionUrl(continueUrl)
        || this.isChatGptUrl(continueUrl)
      ) return;
      throw Object.assign(new Error(`协议登录遇到不支持的认证步骤: ${path || 'unknown'}`), {
        code: 'UNSUPPORTED_LOGIN_STEP',
      });
    },

    isMfaChallenge({ pageType = '', continueUrl = '' } = {}) {
      const page = String(pageType || '').toLowerCase();
      const url = String(continueUrl || '').toLowerCase();
      const path = this.pathOf(continueUrl).toLowerCase();
      return page.includes('mfa')
        || page.includes('totp')
        || url.includes('mfa')
        || url.includes('2fa')
        || path.includes('/mfa')
        || path.includes('/mfa-challenge')
        || path.includes('/two-factor');
    },

    extractMfaFactorId(result = {}) {
      const roots = [
        result?.payload?.page?.payload,
        result?.payload?.payload,
        result?.page?.payload,
        result?.payload,
        result,
      ].filter(Boolean);
      for (const payload of roots) {
        const factors = Array.isArray(payload.factors) ? payload.factors : [];
        const totpFactors = Array.isArray(payload?.factors?.totp) ? payload.factors.totp : [];
        const fromPayload = firstNonEmpty(
          payload.factor_id,
          payload.factorId,
          payload.native_default_factor_id,
          factors[0]?.id,
          totpFactors[0]?.id,
        );
        if (fromPayload) return String(fromPayload).trim();
      }
      const url = String(result?.continueUrl || result?.payload?.continue_url || '');
      const match = url.match(/\/mfa-challenge\/([a-zA-Z0-9_-]+)/i);
      return match?.[1] || this.mfaFactorId || '';
    },

    async startOAuthSession({ useLoginHint = true, prompt = 'login' } = {}) {
      await this.ensureProxyConnectivity();
      const oauthUrl = this.prepareLoginUrl(prompt, { useLoginHint });
      this.authContinuation = { phase: 'codex', url: oauthUrl, recoveryAttempted: false };
      this.authResponseWorkspaces = null;
      const { url: landedUrl } = await openOAuthPage(this.fetch, oauthUrl, {
        callbackUrl: OPENAI_CODEX_REDIRECT_URI,
        headers: this.browserHeaders({
          'accept-encoding': 'gzip, deflate, br',
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'none',
        }),
      });
      if (landedUrl.startsWith(OPENAI_CODEX_REDIRECT_URI)) {
        return { done: true, callbackUrl: landedUrl };
      }
      if (!this.isAuthStartUrl(landedUrl) && !this.isConsentUrl(landedUrl)) {
        throw new Error(`OauthUrl重定向到错误的路径: ${this.pathOf(landedUrl)}`);
      }
      this.deviceID = await this.readCookie('https://openai.com', 'oai-did')
        || await this.readCookie(AUTH_BASE_URL, 'oai-did');
      if (!this.deviceID) throw new Error('OauthUrl未返回 oai-did cookie');
      this.log(`Codex OAuth 落点: ${this.pathOf(landedUrl)}`);
      return { done: false, continueUrl: landedUrl };
    },

    async authorizeContinue({ screenHint = '', referer = `${AUTH_BASE_URL}/log-in` } = {}) {
      const sentinelToken = await this.fetchSentinelToken('authorize_continue');
      const body = {
        username: {
          kind: 'email',
          value: this.account.email,
        },
      };
      if (screenHint) body.screen_hint = screenHint;
      const response = await this.fetch(AUTH_AUTHORIZE_CONTINUE_URL, {
        method: 'POST',
        headers: this.browserHeaders({
          'content-type': 'application/json',
          'openai-sentinel-token': sentinelToken,
          origin: AUTH_BASE_URL,
          referer,
        }),
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`AuthorizeContinue请求失败: ${await this.formatErrorResponse(response)}`);
      const raw = await response.text();
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (error) {
        const preview = String(raw || '').trim().slice(0, 200);
        throw new Error(`AuthorizeContinue响应不是JSON: ${preview || (error instanceof Error ? error.message : String(error))}`);
      }
      return this.authResponseResult(payload);
    },

    async passwordVerify() {
      const password = resolveOpenAiAccountPassword(this.account);
      if (!password) throw new Error('账号缺少 OpenAI 密码，无法完成密码登录');
      const sentinelToken = await this.fetchSentinelToken('password_verify');
      this.log('辅助验证完成，提交账号密码');
      this.passwordSubmitted = true;
      const response = await this.fetch(AUTH_PASSWORD_VERIFY_URL, {
        method: 'POST',
        headers: this.browserHeaders({
          accept: 'application/json',
          'content-type': 'application/json',
          'openai-sentinel-token': sentinelToken,
          origin: AUTH_BASE_URL,
          referer: `${AUTH_BASE_URL}/log-in/password`,
        }),
        body: JSON.stringify({ password }),
      });
      if (!response.ok) throw new Error(`PasswordVerify请求失败: ${await this.formatErrorResponse(response)}`);
      const payload = await response.json();
      const result = this.authResponseResult(payload);
      if (this.isEmailCodeChallenge(result)) throw validationError('EMAIL_VERIFICATION_REQUIRED');
      this.assertSupportedAuthStep(result);
      // Some valid MFA responses carry the factor only in the JSON payload.
      const factorId = this.extractMfaFactorId(result);
      if (factorId) {
        if (!this.isMfaChallenge(result)) result.pageType = 'mfa_challenge';
        if (!result.continueUrl) result.continueUrl = `${AUTH_BASE_URL}/mfa-challenge/${factorId}`;
      }
      if (!result.continueUrl) throw new Error('PasswordVerify响应缺少 continue_url 或 MFA factor');
      return result;
    },

    async mfaValidate(passwordResult = null) {
      if (!hasTotpSecret(this.account)) {
        throw new Error('遇到 2FA/MFA 验证，但账号未配置 TOTP 密钥（email|password|2fa）');
      }
      const factorId = this.extractMfaFactorId(passwordResult || { continueUrl: this.mfaContinueUrl, payload: this.mfaPayload });
      if (!factorId) {
        throw new Error('MFA 挑战缺少 factor id，无法提交 TOTP');
      }
      this.mfaFactorId = factorId;
      const continueUrl = normalizeAuthContinueUrl(
        passwordResult?.continueUrl || this.mfaContinueUrl || `${AUTH_BASE_URL}/mfa-challenge/${factorId}`,
      );
      if (continueUrl) {
        await this.fetch(continueUrl, {
          method: 'GET',
          headers: this.browserHeaders({
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            referer: `${AUTH_BASE_URL}/log-in/password`,
          }),
        }).catch(() => null);
      }

      const sentinelToken = await this.fetchSentinelToken('authorize_continue');
      const code = generateTotpCode(this.account.two_factor_secret);
      const headers = this.browserHeaders({
        accept: 'application/json',
        'content-type': 'application/json',
        origin: AUTH_BASE_URL,
        referer: continueUrl || `${AUTH_BASE_URL}/mfa-challenge/${factorId}`,
      });
      if (sentinelToken) headers['openai-sentinel-token'] = sentinelToken;
      this.log('辅助验证完成，提交 TOTP 2FA 验证码');
      this.totpSubmitted = true;
      const response = await this.fetch(AUTH_MFA_VERIFY_URL, {
        method: 'POST',
        redirect: 'manual',
        headers,
        body: JSON.stringify({ type: 'totp', id: factorId, code }),
      });
      const location = response.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        return this.authResponseResult({}, new URL(location, AUTH_MFA_VERIFY_URL).toString());
      }
      if (!response.ok) {
        throw new Error(`MFAVerify请求失败: ${await this.formatErrorResponse(response)}`);
      }
      const payload = await response.json().catch(() => { throw validationError('AUTH_CONTINUATION_FAILED'); });
      const result = this.authResponseResult(payload);
      if (this.isEmailCodeChallenge(result)) throw validationError('EMAIL_VERIFICATION_REQUIRED');
      return result;
    },
  };
}
