import {
  AUTH_BASE_URL as defaultAUTH_BASE_URL,
  CHATGPT_AUTH_CALLBACK_OPENAI_URL as defaultCHATGPT_AUTH_CALLBACK_OPENAI_URL,
  CHATGPT_AUTH_CSRF_URL as defaultCHATGPT_AUTH_CSRF_URL,
  CHATGPT_AUTH_SESSION_URL as defaultCHATGPT_AUTH_SESSION_URL,
  CHATGPT_AUTH_SIGNIN_OPENAI_URL as defaultCHATGPT_AUTH_SIGNIN_OPENAI_URL,
  CHATGPT_BASE_URL as defaultCHATGPT_BASE_URL,
  normalizeAuthContinueUrl as defaultNormalizeAuthContinueUrl,
} from '../../../../lib/openai-auth-urls.js';
import { Cookie as defaultCookie } from 'tough-cookie';
import { firstNonEmpty as defaultFirstNonEmpty } from '../../../../lib/jwt-utils.js';
import { isInitialAuthEgressBlock as defaultIsInitialAuthEgressBlock } from '../../../../lib/proxy-config.js';
import { parseOpenAiAuthErrorUrl as defaultParseOpenAiAuthErrorUrl } from '../../../lib/openai-auth-error.js';
import { randomUUID as defaultRandomUUID } from 'crypto';

/** Request-owned operations. Configuration and repositories are supplied by the composition root. */
export function createWebSessionMethods({
  AUTH_BASE_URL = defaultAUTH_BASE_URL,
  CHATGPT_AUTH_CALLBACK_OPENAI_URL = defaultCHATGPT_AUTH_CALLBACK_OPENAI_URL,
  CHATGPT_AUTH_CSRF_URL = defaultCHATGPT_AUTH_CSRF_URL,
  CHATGPT_AUTH_SESSION_URL = defaultCHATGPT_AUTH_SESSION_URL,
  CHATGPT_AUTH_SIGNIN_OPENAI_URL = defaultCHATGPT_AUTH_SIGNIN_OPENAI_URL,
  CHATGPT_BASE_URL = defaultCHATGPT_BASE_URL,
  Cookie = defaultCookie,
  firstNonEmpty = defaultFirstNonEmpty,
  isInitialAuthEgressBlock = defaultIsInitialAuthEgressBlock,
  normalizeAuthContinueUrl = defaultNormalizeAuthContinueUrl,
  parseOpenAiAuthErrorUrl = defaultParseOpenAiAuthErrorUrl,
  randomUUID = defaultRandomUUID,
  sleep,
} = {}) {
  return {
    async ensureChatGptDeviceCookie(deviceId = '') {
      const id = String(deviceId || this.deviceID || randomUUID()).trim();
      this.deviceID = id;
      const existing = await this.readCookie(CHATGPT_BASE_URL, 'oai-did');
      if (existing) {
        this.deviceID = existing;
        return existing;
      }
      const cookie = new Cookie({
        key: 'oai-did',
        value: id,
        domain: 'chatgpt.com',
        path: '/',
        secure: true,
        httpOnly: false,
      });
      await this.jar.setCookie(cookie, CHATGPT_BASE_URL);
      return id;
    },

    async readChatGptCsrfToken() {
      const response = await this.fetch(CHATGPT_AUTH_CSRF_URL, {
        headers: this.browserHeaders({
          accept: 'application/json',
          referer: `${CHATGPT_BASE_URL}/auth/login`,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      const fromJson = String(payload?.csrfToken || '').trim();
      if (fromJson) return fromJson;
      const raw = await this.readCookie(CHATGPT_BASE_URL, '__Host-next-auth.csrf-token');
      if (raw.includes('|')) return raw.split('|')[0];
      return raw || 'true';
    },

    async startChatGptWebSignIn() {
      await this.ensureProxyConnectivity();
      await this.resetAuthSession();
      if (this.reuseStoredSession) await this.importStoredCookieStorageState();
      this.log('ChatGPT Web：打开登录页并获取 CSRF');
      await this.humanPause('navigate');
      const loginPage = await this.fetch(`${CHATGPT_BASE_URL}/auth/login`, {
        headers: this.browserHeaders({
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'none',
          'sec-fetch-user': '?1',
        }),
      });
      if (loginPage.status >= 400) {
        const loginBody = await loginPage.text().catch(() => '');
        if (isInitialAuthEgressBlock({ status: loginPage.status, body: loginBody, headers: loginPage.headers })) {
          this.throwProxyEdgeBlocked(loginPage.status, 'chatgpt.com/auth/login');
        }
      }
      await this.humanPause('think');
      const deviceId = await this.ensureChatGptDeviceCookie();
      const csrfToken = await this.readChatGptCsrfToken();
      const params = new URLSearchParams({
        ...(this.reuseStoredSession ? {} : { prompt: 'login' }),
        'ext-oai-did': deviceId,
        auth_session_logging_id: randomUUID().replace(/-/g, ''),
        'ext-passkey-client-capabilities': '0111',
        screen_hint: 'login_or_signup',
        login_hint: this.account.email,
      });
      await this.humanPause('type');
      const response = await this.fetch(`${CHATGPT_AUTH_SIGNIN_OPENAI_URL}?${params}`, {
        method: 'POST',
        redirect: 'manual',
        headers: this.browserHeaders({
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          origin: CHATGPT_BASE_URL,
          referer: `${CHATGPT_BASE_URL}/auth/login`,
        }),
        body: new URLSearchParams({
          callbackUrl: `${CHATGPT_BASE_URL}/`,
          csrfToken,
          json: 'true',
        }).toString(),
      });
      const rawSignInBody = await response.text().catch(() => '');
      let payload = {};
      try { payload = rawSignInBody ? JSON.parse(rawSignInBody) : {}; } catch { payload = {}; }
      const signInUrl = firstNonEmpty(payload?.url, response.headers.get('location'));
      if (!signInUrl) {
        if (isInitialAuthEgressBlock({ status: response.status, body: rawSignInBody, headers: response.headers })) {
          this.throwProxyEdgeBlocked(response.status, 'chatgpt.com/api/auth/signin/openai');
        }
        const detail = (rawSignInBody || JSON.stringify(payload || {})).slice(0, 240);
        throw new Error(`ChatGPT Web 登录发起失败: HTTP ${response.status} ${detail}`);
      }

      this.log('ChatGPT Web：进入 OpenAI OAuth');
      await this.humanPause('navigate');
      const oauthResp = await this.fetch(signInUrl, {
        redirect: 'follow',
        headers: this.browserHeaders({
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          origin: AUTH_BASE_URL,
          referer: `${CHATGPT_BASE_URL}/`,
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'cross-site',
          'sec-fetch-user': '?1',
        }),
      });
      this.deviceID = await this.readCookie('https://openai.com', 'oai-did')
        || await this.readCookie(AUTH_BASE_URL, 'oai-did')
        || await this.readCookie(CHATGPT_BASE_URL, 'oai-did')
        || this.deviceID;
      if (!this.deviceID) throw new Error('ChatGPT Web OAuth 未返回 oai-did cookie');
      return { continueUrl: oauthResp.url };
    },

    extractOAuthCodeFromUrl(url) {
      try {
        const parsed = new URL(String(url || ''));
        return parsed.searchParams.get('code') || '';
      } catch {
        return '';
      }
    },

    async completeChatGptCallback(code) {
      const callbackUrl = `${CHATGPT_AUTH_CALLBACK_OPENAI_URL}?code=${encodeURIComponent(code)}`;
      this.log('ChatGPT Web：提交 OAuth callback');
      await this.fetch(callbackUrl, {
        headers: this.browserHeaders({
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          referer: `${CHATGPT_BASE_URL}/`,
        }),
      });
    },

    async readChatGptAccessToken({ timeoutMs = 20000 } = {}) {
      const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 20000);
      let lastError = 'Session JSON 中无 accessToken';
      while (Date.now() < deadline) {
        try {
          await this.fetch(`${CHATGPT_BASE_URL}/`, {
            headers: this.browserHeaders({ accept: 'text/html,*/*', referer: `${CHATGPT_BASE_URL}/` }),
          }).catch(() => null);
          const response = await this.fetch(CHATGPT_AUTH_SESSION_URL, {
            headers: this.browserHeaders({
              accept: 'application/json',
              referer: `${CHATGPT_BASE_URL}/`,
            }),
          });
          const text = await response.text();
          let session = {};
          try { session = text ? JSON.parse(text) : {}; } catch {}
          const accessToken = firstNonEmpty(session.accessToken, session.access_token, session.token);
          if (response.ok && accessToken) {
            return { accessToken, session };
          }
          lastError = `HTTP ${response.status}${text ? ` ${text.slice(0, 180)}` : ''}`;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        await sleep(1000);
      }
      throw new Error(`无法获取 ChatGPT Web accessToken: ${lastError}`);
    },

    async followChatGptWebSession(startUrl, { allowPhoneStop = false } = {}) {
      let currentURL = normalizeAuthContinueUrl(startUrl) || String(startUrl || '');
      for (let hop = 0; hop < 12; hop += 1) {
        if (!currentURL) break;
        this.assertSupportedAuthStep({ continueUrl: currentURL });
        if (this.isPhoneChallengeUrl(currentURL)) {
          if (allowPhoneStop) {
            this.log('跟随 Session 时停在手机验证页，尝试直接读取 accessToken', 'warn');
            return this.readChatGptAccessToken({ timeoutMs: 12000 });
          }
          throw new Error(`退出全部会话遇到手机验证: ${this.pathOf(currentURL)}`);
        }

        const codeInUrl = this.extractOAuthCodeFromUrl(currentURL);
        if (codeInUrl) {
          if (String(currentURL).includes('/api/auth/callback/openai')) {
            await this.fetch(currentURL, {
              headers: this.browserHeaders({
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                referer: `${CHATGPT_BASE_URL}/`,
              }),
            });
          } else {
            await this.completeChatGptCallback(codeInUrl);
          }
          return this.readChatGptAccessToken();
        }

        if (this.isChatGptUrl(currentURL) && !String(currentURL).includes('/api/auth/callback')) {
          try {
            return await this.readChatGptAccessToken({ timeoutMs: 5000 });
          } catch {
            // keep following redirects / retries below
          }
        }

        const response = await this.fetch(currentURL, {
          method: 'GET',
          redirect: 'manual',
          headers: this.browserHeaders({
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          }),
        });
        const location = response.headers.get('location');
        if (location) {
          currentURL = new URL(location, currentURL).toString();
          continue;
        }
        if (this.isChatGptUrl(response.url)) {
          return this.readChatGptAccessToken();
        }
        if (this.isConsentUrl(response.url) || this.isAuthStartUrl(response.url)) {
          currentURL = response.url;
          const advanced = await this.advanceAuthStep(currentURL, { phase: 'chatgpt' });
          currentURL = typeof advanced === 'string' ? advanced : String(advanced?.continueUrl || '');
          continue;
        }
        const authFailure = parseOpenAiAuthErrorUrl(response.url);
        if (authFailure) {
          const error = new Error(`OpenAI 登录失败：${authFailure.code}${authFailure.requestId ? `（request_id=${authFailure.requestId}）` : ''}`);
          error.code = authFailure.code;
          throw error;
        }
        throw new Error(`ChatGPT Web 跳转未完成: status=${response.status} url=${response.url}`);
      }
      return this.readChatGptAccessToken();
    },

    async importStoredCookieStorageState() {
      let state;
      try { state = JSON.parse(String(this.account?.storage_state_json || '')); } catch { state = null; }
      const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
      let imported = 0;
      for (const item of cookies) {
        const domain = String(item?.domain || '').trim();
        const name = String(item?.name || '').trim();
        if (!domain || !name) continue;
        if (Number(item.expires) > 0 && Number(item.expires) * 1000 <= Date.now()) continue;
        const cookie = new Cookie({
          key: name,
          value: String(item?.value || ''),
          domain,
          hostOnly: typeof item.hostOnly === 'boolean' ? item.hostOnly : name.startsWith('__Host-'),
          path: String(item?.path || '/'),
          secure: item?.secure !== false,
          httpOnly: Boolean(item?.httpOnly),
          sameSite: String(item?.sameSite || 'lax').toLowerCase(),
          expires: Number(item?.expires) > 0 ? new Date(Number(item.expires) * 1000) : 'Infinity',
        });
        const origin = `${cookie.secure ? 'https' : 'http'}://${domain.replace(/^\./, '')}${cookie.path || '/'}`;
        const stored = await this.jar.setCookie(cookie, origin).catch(() => null);
        if (stored) imported += 1;
      }
      this.log(`复用已保存的 ChatGPT Web Session Cookie: ${imported} 个`);
      if (this.requireStoredSession && imported === 0) {
        const error = new Error('Business 转 RT 要求可复用的已保存 ChatGPT Web Session Cookie');
        error.code = 'STORED_SESSION_REQUIRED';
        throw error;
      }
      return imported;
    },

    assertStoredSessionContinuation(started) {
      if (!this.requireStoredSession || started?.done) return;
      this.assertSupportedAuthStep(started);
      const pathName = this.pathOf(started?.continueUrl || '');
      const credentialFallback = this.isPasswordTotpAccount()
        && (pathName === '/log-in' || pathName === '/log-in/password' || pathName.includes('/mfa'));
      const allowed = pathName === '/oauth/authorize'
        || pathName === '/oauth/consent'
        || pathName === '/sign-in-with-chatgpt/codex/consent'
        || pathName === '/consent'
        || pathName === '/workspace'
        || pathName.includes('workspace')
        || pathName.includes('consent')
        || credentialFallback;
      if (!allowed) {
        const error = new Error(`已保存 Session 无法直接继续 Business OAuth: ${pathName || 'unknown'}`);
        error.code = 'STORED_SESSION_REQUIRED';
        throw error;
      }
      if (credentialFallback) {
        this.log('已保存 Session 需要重新验证账号，继续提交密码和 TOTP 后完成 Business OAuth', 'warn');
      }
    },

    async exportCookieStorageState() {
      const seen = new Set();
      const cookies = [];
      // Export the store directly so cookies scoped to a newly introduced
      // OpenAI subdomain are retained for later Session reuse.
      const list = await this.jar.store.getAllCookies();
      for (const cookie of list || []) {
        const key = `${cookie.domain}|${cookie.path}|${cookie.key}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const expiresAt = cookie.expiryTime(cookie.creation);
        cookies.push({
          name: cookie.key,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path || '/',
          expires: Number.isFinite(expiresAt) ? expiresAt / 1000 : -1,
          hostOnly: Boolean(cookie.hostOnly),
          httpOnly: Boolean(cookie.httpOnly),
          secure: Boolean(cookie.secure),
          sameSite: cookie.sameSite || 'Lax',
        });
      }
      return JSON.stringify({ cookies, origins: [] }, null, 2);
    },

    async loginChatGptWebWithPasswordTotp() {
      if (!this.humanPacingExplicit) this.humanPacingEnabled = false;
      this.assertPasswordTotpCredentials();
      this.logProtocolHardening();
      this.log('协议登录 ChatGPT Web（邮箱 + 密码 + TOTP）');
      const started = await this.startChatGptWebSignIn();
      let continueURL = started.continueUrl;
      const advanced = await this.advanceAuthStep(continueURL, { phase: 'chatgpt' });
      continueURL = typeof advanced === 'string' ? advanced : String(advanced?.continueUrl || '');
      this.log(`登录完成，跟随到 ChatGPT Session: ${this.pathOf(continueURL) || continueURL}`);
      const { accessToken, session } = await this.followChatGptWebSession(continueURL);
      const storageState = await this.exportCookieStorageState();
      return { accessToken, session, storageState };
    },
  };
}
