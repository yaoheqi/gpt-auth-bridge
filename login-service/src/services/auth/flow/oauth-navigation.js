import {
  AUTH_BASE_URL as defaultAUTH_BASE_URL,
  CHATGPT_AUTH_CALLBACK_OPENAI_URL as defaultCHATGPT_AUTH_CALLBACK_OPENAI_URL,
} from '../../../../lib/openai-auth-urls.js';
import {
  OPENAI_CODEX_REDIRECT_URI as defaultOPENAI_CODEX_REDIRECT_URI,
  OPENAI_CODEX_ORIGINATOR as defaultOPENAI_CODEX_ORIGINATOR,
  OPENAI_CODEX_USER_AGENT as defaultOPENAI_CODEX_USER_AGENT,
  buildAuthorizationCodeTokenBody as defaultBuildAuthorizationCodeTokenBody,
  formatSafeOAuthErrorResponse as defaultFormatSafeOAuthErrorResponse,
  parseOpenAICallback as defaultParseOpenAICallback,
  safeOAuthEndpoint as defaultSafeOAuthEndpoint,
} from '../../../../lib/openai-oauth.js';
import { isAgentIdentityRecord as defaultIsAgentIdentityRecord } from '../../../../lib/openai-agent-identity.js';
import { normalizeOpenAIAuthRecord as defaultNormalizeOpenAIAuthRecord } from '../auth-records.js';
import { openOAuthPage as defaultOpenOAuthPage } from '../../../../lib/oauth-navigation.js';
import { validationError, validationFailureFields } from '../../../../lib/validation-error.js';

/** Request-owned operations. Configuration and repositories are supplied by the composition root. */
export function createOAuthNavigationMethods({
  AUTH_BASE_URL = defaultAUTH_BASE_URL,
  AUTH_OAUTH_TOKEN_URLS,
  CHATGPT_AUTH_CALLBACK_OPENAI_URL = defaultCHATGPT_AUTH_CALLBACK_OPENAI_URL,
  OPENAI_CODEX_REDIRECT_URI = defaultOPENAI_CODEX_REDIRECT_URI,
  OPENAI_CODEX_ORIGINATOR = defaultOPENAI_CODEX_ORIGINATOR,
  OPENAI_CODEX_USER_AGENT = defaultOPENAI_CODEX_USER_AGENT,
  buildAuthorizationCodeTokenBody = defaultBuildAuthorizationCodeTokenBody,
  formatSafeOAuthErrorResponse = defaultFormatSafeOAuthErrorResponse,
  isAgentIdentityRecord = defaultIsAgentIdentityRecord,
  normalizeOpenAIAuthRecord = defaultNormalizeOpenAIAuthRecord,
  openOAuthPage = defaultOpenOAuthPage,
  parseOpenAICallback = defaultParseOpenAICallback,
  safeOAuthEndpoint = defaultSafeOAuthEndpoint,
} = {}) {
  return {
    pathOf(url) {
      try {
        return new URL(String(url || ''), AUTH_BASE_URL).pathname.replace(/\/$/, '') || '/';
      } catch {
        return String(url || '');
      }
    },

    isAuthStartUrl(url) {
      const path = this.pathOf(url);
      return this.isEmailCodeChallenge({ continueUrl: url }) || [
        '/log-in',
        '/log-in/password',
        '/log-in/mfa',
        '/mfa-challenge',
        '/sign-in-with-chatgpt/codex/consent',
        '/add-phone',
        '/phone-otp/select-channel',
        '/phone-verification',
        '/mfa',
        '/two-factor',
        '/consent',
      ].includes(path)
        || path.startsWith('/add-phone')
        || path.startsWith('/phone-otp/')
        || path.startsWith('/phone-verification')
        || path.startsWith('/log-in/mfa')
        || path.startsWith('/mfa-challenge')
        || path.startsWith('/mfa')
        || path.startsWith('/two-factor')
        || path.includes('consent');
    },

    isConsentUrl(url) {
      const path = this.pathOf(url);
      return path === '/sign-in-with-chatgpt/codex/consent'
        || path === '/consent'
        || path === '/workspace'
        || path.endsWith('/consent')
        || path.includes('consent')
        || path.includes('/workspace');
    },

    isChatGptUrl(url) {
      try { return new URL(url).origin === 'https://chatgpt.com'; } catch { return false; }
    },

    isOAuthTransitionUrl(url) {
      try {
        const parsed = new URL(url);
        return parsed.origin === AUTH_BASE_URL
          && ['/oauth/authorize', '/api/oauth/oauth2/auth'].includes(parsed.pathname);
      } catch { return false; }
    },

    async resumeVerifiedOAuth(phase) {
      const context = this.authContinuation;
      if (!context || context.phase !== phase || context.recoveryAttempted || !this.isOAuthTransitionUrl(context.url)) {
        throw validationError('AUTH_CONTINUATION_FAILED');
      }
      context.recoveryAttempted = true;
      const authorize = new URL(context.url);
      // Password/MFA already ran. Preserve client, state, nonce, redirect URI
      // and PKCE; do not force a second credential prompt on the same session.
      authorize.searchParams.delete('prompt');
      const callbackUrl = phase === 'chatgpt' ? CHATGPT_AUTH_CALLBACK_OPENAI_URL : OPENAI_CODEX_REDIRECT_URI;
      this.log('账号验证后缺少授权信息，保留当前会话续接 OAuth（仅一次）', 'warn');
      let url;
      try {
        ({ url } = await openOAuthPage((address, init) => {
          if (new URL(address).origin !== AUTH_BASE_URL) throw validationError('AUTH_CONTINUATION_FAILED');
          return this.fetch(address, init);
        }, authorize.toString(), { callbackUrl,
          headers: this.browserHeaders({ accept: 'text/html,application/xhtml+xml,*/*' }) }));
      } catch (error) {
        if (error.name === 'AbortError' || validationFailureFields(error).validationFailure) throw error;
        throw validationError('AUTH_CONTINUATION_FAILED', {
          ...(error.status ? { reason: 'HTTP_ERROR', httpStatus: error.status } : {}),
        }, error);
      }
      const landed = new URL(url), callback = new URL(callbackUrl);
      if (!(landed.origin === callback.origin && landed.pathname === callback.pathname)
        && !(landed.origin === AUTH_BASE_URL && this.isConsentUrl(url))) {
        throw validationError('AUTH_CONTINUATION_FAILED');
      }
      return url;
    },

    async advanceAuthStep(continueURL, { phase = 'codex' } = {}) {
      let url = continueURL;
      let workspaceSessionRecoveryAttempted = false;
      let credentialAuthCompleted = false;
      const chatgptLike = phase === 'chatgpt';
      if (!this.requireStoredSession) this.assertPasswordTotpCredentials();
      for (let step = 0; step < 14; step += 1) {
        if (!url && credentialAuthCompleted) url = await this.resumeVerifiedOAuth(phase);
        if (credentialAuthCompleted && this.authContinuation?.recoveryAttempted
          && (['/log-in', '/log-in/password'].includes(this.pathOf(url))
            || this.isEmailCodeChallenge({ continueUrl: url }) || this.isMfaChallenge({ continueUrl: url }))) {
          throw validationError('AUTH_CONTINUATION_FAILED');
        }
        url = (await this.preferPasswordLoginStep({ continueUrl: url })).continueUrl;
        this.assertSupportedAuthStep({ continueUrl: url });
        await this.humanPause(step === 0 ? 'think' : 'navigate');
        const path = this.pathOf(url);
        if (url.startsWith(OPENAI_CODEX_REDIRECT_URI)) return url;
        if (chatgptLike && (this.isChatGptUrl(url) || String(url).includes('code='))) {
          return url;
        }

        if (this.isOAuthTransitionUrl(url)) {
          const { url: nextUrl } = await openOAuthPage(this.fetch, url, {
            callbackUrl: chatgptLike ? CHATGPT_AUTH_CALLBACK_OPENAI_URL : OPENAI_CODEX_REDIRECT_URI,
            headers: this.browserHeaders({ accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }),
          });
          if (nextUrl === url) throw new Error(`OAuth 授权中转未返回下一步: ${path}`);
          url = nextUrl;
          continue;
        }

        if (this.isPhoneChallengeUrl(url)) {
          if (phase === 'chatgpt') {
            throw new Error(`退出全部会话需要已完成手机验证；当前停在: ${path || url}`);
          }
          if (this.forbidPhoneChallenge) {
            throw new Error(`Codex OAuth 仍要求手机验证，已按要求禁止新接码: ${path || url}`);
          }
          this.log(this.phoneMode === 'agent' ? '遇到手机验证，使用 Agent Identity 转换' : '遇到手机验证，使用 Codex 登录接码');
          const phoneResult = await this.handlePhoneChallenge(url);
          if (isAgentIdentityRecord(phoneResult)) return phoneResult;
          url = phoneResult;
          continue;
        }

        if (path === '/log-in') {
          const screenHint = '';
          const referer = `${AUTH_BASE_URL}/log-in`;
          this.log('提交登录邮箱');
          await this.humanPause('type');
          let result = await this.authorizeContinue({ screenHint, referer });
          result = await this.preferPasswordLoginStep(result);
          const pageType = String(result.pageType || '').toLowerCase();
          const nextPath = this.pathOf(result.continueUrl);

          if (pageType.includes('login_password') || nextPath === '/log-in/password') {
            this.log('准备密码验证，先完成辅助验证');
            this.assertPasswordTotpCredentials();
            result = await this.passwordVerify();
            if (this.isMfaChallenge(result)) {
              this.mfaContinueUrl = result.continueUrl;
              this.mfaPayload = result.payload;
              this.mfaFactorId = this.extractMfaFactorId(result);
              this.log('密码后进入 2FA/MFA，准备辅助验证');
              result = await this.mfaValidate(result);
            }
            credentialAuthCompleted = true;
            url = result.continueUrl;
            continue;
          }

          url = result.continueUrl;
          continue;
        }

        if (path === '/log-in/password') {
          this.log('准备密码验证，先完成辅助验证');
          this.assertPasswordTotpCredentials();
          let result = await this.passwordVerify();
          if (this.isMfaChallenge(result)) {
            this.mfaContinueUrl = result.continueUrl;
            this.mfaPayload = result.payload;
            this.mfaFactorId = this.extractMfaFactorId(result);
            this.log('密码后进入 2FA/MFA，准备辅助验证');
            result = await this.mfaValidate(result);
          }
          credentialAuthCompleted = true;
          url = result.continueUrl;
          continue;
        }

        if (
          path === '/mfa'
          || path === '/log-in/mfa'
          || path.startsWith('/mfa-challenge')
          || path.startsWith('/mfa')
          || path.startsWith('/two-factor')
          || path.includes('mfa')
        ) {
          this.log('准备 2FA 验证，先完成辅助验证');
          if (!this.mfaFactorId) {
            this.mfaFactorId = path.split('/').filter(Boolean).pop() || '';
            this.mfaContinueUrl = url;
          }
          const result = await this.mfaValidate({
            continueUrl: url,
            payload: { page: { payload: { factor_id: this.mfaFactorId } } },
          });
          this.assertSupportedAuthStep(result);
          credentialAuthCompleted = true;
          url = result.continueUrl;
          continue;
        }

        if (this.isConsentUrl(url)) {
          this.log(this.workspaceSelection.mode === 'id' ? '选择指定 Business 工作区' : '选择默认工作区');
          try {
            url = await this.selectWorkspace(url, { phase });
          } catch (error) {
            const missingWorkspaceSession = ['WORKSPACE_SESSION_MISSING', 'WORKSPACE_SESSION_INVALID'].includes(error?.code);
            if (missingWorkspaceSession && credentialAuthCompleted) {
              if (this.authContinuation?.phase === phase && !this.authContinuation.recoveryAttempted) {
                url = await this.resumeVerifiedOAuth(phase);
                continue;
              }
              throw validationError('WORKSPACE_DISCOVERY_FAILED');
            }
            if (!missingWorkspaceSession || !['codex', 'chatgpt'].includes(phase) || !this.isPasswordTotpAccount() || workspaceSessionRecoveryAttempted) throw error;
            workspaceSessionRecoveryAttempted = true;
            if (phase === 'chatgpt') {
              this.log(`${error.message}；重新建立 ChatGPT Web 会话并执行密码/TOTP 验证（仅重试一次）`, 'warn');
              const restarted = await this.startChatGptWebSignIn();
              url = restarted.continueUrl;
              continue;
            }
            this.log(`${error.message}；重新建立 Codex OAuth 并执行密码/TOTP 验证（仅重试一次）`, 'warn');
            // A valid ChatGPT Web Session does not guarantee a usable auth-domain
            // workspace session. Do not re-import the same incomplete cookie jar.
            await this.resetAuthSession();
            const restarted = await this.startOAuthSession({ useLoginHint: true, prompt: 'login' });
            this.assertStoredSessionContinuation(restarted);
            url = restarted.done ? restarted.callbackUrl : restarted.continueUrl;
          }
          continue;
        }

        return url;
      }
      throw new Error(`认证步骤次数过多，最后停在: ${this.pathOf(url)}`);
    },

    async loginCodexWithPhone({ preserveAuthSession = false } = {}) {
      if (!preserveAuthSession && !this.requireStoredSession) this.assertPasswordTotpCredentials();
      if (!this.humanPacingExplicit) this.humanPacingEnabled = false;
      this.log(this.forbidPhoneChallenge
        ? 'Codex OAuth：工作区授权，禁止手机号验证'
        : this.phoneMode === 'sms'
        ? 'Codex OAuth：登录并获取 refresh_token'
        : '阶段2/2：Codex 登录 + Agent Identity 转换');
      if (!preserveAuthSession) {
        await this.resetAuthSession();
        if (this.reuseStoredSession) await this.importStoredCookieStorageState();
      }
      this.selectedWorkspaceId = '';
      const started = await this.startOAuthSession({
        useLoginHint: true,
        prompt: preserveAuthSession || this.reuseStoredSession ? '' : 'login',
      });
      this.assertStoredSessionContinuation(started);
      if (started.done) {
        const result = this.extractAuthResult(started.callbackUrl);
        return this.exchangeCodeForToken(result.code);
      }

      let continueURL = started.continueUrl;
      const advanced = await this.advanceAuthStep(continueURL, { phase: 'codex' });
      if (isAgentIdentityRecord(advanced)) return advanced;
      continueURL = advanced;
      if (this.forbidPhoneChallenge && this.isPhoneChallengeUrl(continueURL)) {
        throw new Error(`Codex OAuth 仍要求手机验证，已按要求禁止新接码: ${this.pathOf(continueURL) || continueURL}`);
      }

      this.log('等待 OAuth 回调');
      const result = await this.followOAuthRedirects(continueURL);
      if (isAgentIdentityRecord(result)) return result;
      return this.exchangeCodeForToken(result.code);
    },

    extractAuthResult(callbackURL) {
      return parseOpenAICallback(callbackURL, this.state);
    },

    async followOAuthRedirects(startURL) {
      let currentURL = startURL;
      for (let hop = 0; hop < 10; hop += 1) {
        if (this.isEmailCodeChallenge({ continueUrl: currentURL })) {
          currentURL = await this.advanceAuthStep(currentURL, { phase: 'codex' });
          continue;
        }
        this.assertSupportedAuthStep({ continueUrl: currentURL });
        if (this.isPhoneChallengeUrl(currentURL)) {
          if (this.forbidPhoneChallenge) throw new Error(`Codex OAuth 仍要求手机验证，已按要求禁止新接码: ${this.pathOf(currentURL) || currentURL}`);
          const phoneResult = await this.handlePhoneChallenge(currentURL);
          if (isAgentIdentityRecord(phoneResult)) return phoneResult;
          currentURL = phoneResult;
          continue;
        }
        if (currentURL.startsWith(OPENAI_CODEX_REDIRECT_URI)) return this.extractAuthResult(currentURL);
        const response = await this.fetch(currentURL, {
          method: 'GET',
          redirect: 'manual',
          headers: this.browserHeaders({
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          }),
        });
        const location = response.headers.get('location');
        if (location) {
          const nextURL = new URL(location, currentURL).toString();
          if (this.isPhoneChallengeUrl(nextURL)) {
            if (this.forbidPhoneChallenge) throw new Error(`Codex OAuth 仍要求手机验证，已按要求禁止新接码: ${this.pathOf(nextURL) || nextURL}`);
            const phoneResult = await this.handlePhoneChallenge(nextURL);
            if (isAgentIdentityRecord(phoneResult)) return phoneResult;
            currentURL = phoneResult;
            continue;
          }
          if (nextURL.startsWith(OPENAI_CODEX_REDIRECT_URI)) return this.extractAuthResult(nextURL);
          currentURL = nextURL;
          continue;
        }
        if (this.isPhoneChallengeUrl(response.url)) {
          if (this.forbidPhoneChallenge) throw new Error(`Codex OAuth 仍要求手机验证，已按要求禁止新接码: ${this.pathOf(response.url) || response.url}`);
          const phoneResult = await this.handlePhoneChallenge(response.url);
          if (isAgentIdentityRecord(phoneResult)) return phoneResult;
          currentURL = phoneResult;
          continue;
        }
        if (response.url.startsWith(OPENAI_CODEX_REDIRECT_URI)) return this.extractAuthResult(response.url);
        throw new Error(`OAuth跳转未到达callback: status=${response.status} url=${safeOAuthEndpoint(response.url)}`);
      }
      throw new Error(`OAuth跳转次数过多，最后停在: ${safeOAuthEndpoint(currentURL)}`);
    },

    async exchangeCodeForToken(code) {
      this.assertNonPersonalWorkspace();
      this.log('已验证 OAuth 回调，开始交换 code 获取 refresh_token');
      let lastError = '';
      for (const tokenURL of AUTH_OAUTH_TOKEN_URLS) {
        const body = buildAuthorizationCodeTokenBody(code, this.codeVerifier, OPENAI_CODEX_REDIRECT_URI);
        let response;
        try {
          response = await this.fetch(tokenURL, {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/x-www-form-urlencoded',
              originator: OPENAI_CODEX_ORIGINATOR,
              'user-agent': OPENAI_CODEX_USER_AGENT,
            },
            body,
          });
        } catch {
          lastError = `endpoint=${safeOAuthEndpoint(tokenURL)} network_error`;
          continue;
        }
        if (!response.ok) {
          lastError = `endpoint=${safeOAuthEndpoint(tokenURL)} ${await formatSafeOAuthErrorResponse(response)}`;
          continue;
        }
        let payload;
        try {
          payload = await response.json();
        } catch {
          lastError = `endpoint=${safeOAuthEndpoint(tokenURL)} HTTP ${response.status} error=invalid_response`;
          continue;
        }
        const record = normalizeOpenAIAuthRecord(this.account.email, payload);
        if (this.requireNonPersonal && record.account_id !== this.selectedWorkspaceId) throw new Error('返回的 RT 不属于所选非个人工作区');
        return record;
      }
      throw new Error(`Code换Token失败: ${lastError}`);
    },
  };
}
