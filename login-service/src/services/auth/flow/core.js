import { CookieJar as defaultCookieJar } from 'tough-cookie';
import { createCurlCffiFetch as defaultCreateCurlCffiFetch } from '../../../../lib/curl-cffi-fetch.js';
import { humanPause as defaultHumanPause } from '../../../../lib/human-timing.js';
import defaultMakeFetchCookie from 'fetch-cookie';
import { preflightProxyEgress as defaultPreflightProxyEgress } from '../../../../lib/proxy-preflight.js';
import { sanitizeLogMessage as defaultSanitizeLogMessage } from '../../../../lib/log-sanitize.js';
import { summarizeFingerprint as defaultSummarizeFingerprint } from '../../../../lib/device-fingerprint.js';

/** Request-owned operations. Configuration and repositories are supplied by the composition root. */
export function createCoreMethods({
  CookieJar = defaultCookieJar,
  buildBrowserHeaders,
  createCurlCffiFetch = defaultCreateCurlCffiFetch,
  fetchOpenAISentinelToken,
  getProtocolHumanTiming,
  humanPause = defaultHumanPause,
  makeFetchCookie = defaultMakeFetchCookie,
  preflightProxyEgress = defaultPreflightProxyEgress,
  sanitizeLogMessage = defaultSanitizeLogMessage,
  sleep,
  summarizeFingerprint = defaultSummarizeFingerprint,
} = {}) {
  return {
    browserHeaders(init = {}) {
      return buildBrowserHeaders(init, this.fingerprint);
    },

    log(msg, level = 'info') {
      this.sse.send('log', { time: new Date().toISOString(), level, msg: sanitizeLogMessage(msg) });
    },

    logProtocolHardening() {
      const smsWait = this.phoneMode === 'sms' ? ` · 单号等码=${Math.round(this.smsCodeTimeoutMs / 1000)}s` : '';
      this.log(`协议隔离环境 ${this.isolationId.slice(0, 8)}: 独立Cookie/设备/OAuth状态 · 指纹=${summarizeFingerprint(this.fingerprint)} · 出口=${this.proxyLabel}${smsWait}`);
    },

    async ensureProxyConnectivity() {
      this.proxyPreflight ||= (async () => {
        this.log(`代理连通性检测开始：出口=${this.proxyLabel} · 目标=auth.openai.com`);
        try {
          const result = await preflightProxyEgress(this.proxyUrl, {
            direct: this.directEgress,
            headers: this.browserHeaders({ accept: 'text/html,application/xhtml+xml,*/*' }),
          });
          this.log(`代理连通性检测通过：HTTP ${result.status}，耗时 ${result.latencyMs}ms，开始正式流程`);
          return result;
        } catch (error) {
          this.log(error.message || String(error), 'error');
          throw error;
        }
      })();
      return this.proxyPreflight;
    },

    async dispose() {
      const current = this.baseFetch;
      this.fetch = null;
      this.baseFetch = null;
      await current?.dispose?.();
    },

    async humanPause(kind = 'navigate') {
      const timing = getProtocolHumanTiming();
      const enabled = this.humanPacingEnabled ?? timing.humanPacingEnabled;
      if (!enabled) return 0;
      const ms = await humanPause(kind, {
        enabled,
        accountGapMsMin: timing.accountGapMsMin,
        accountGapMsMax: timing.accountGapMsMax,
        sleep,
      });
      if (ms >= 1500) this.log(`人类节奏停顿 ${ms}ms (${kind})`);
      return ms;
    },

    throwProxyEdgeBlocked(status, extra = '') {
      const detail = String(extra || '').trim();
      const error = new Error(
        `代理出口被 Cloudflare/OpenAI 拦截: HTTP ${status} · 出口=${this.proxyLabel}${detail ? ` · ${detail}` : ''}`
        + ' · auth/login 初始拦截属于当前出口，不代表账号失效',
      );
      error.code = 'PROXY_EDGE_BLOCKED';
      error.status = Number(status) || 0;
      throw error;
    },

    async readCookie(url, key) {
      const cookies = await this.jar.getCookies(url);
      return cookies.find(cookie => cookie.key === key)?.value || '';
    },

    async resetAuthSession() {
      // Keep sticky fingerprint + proxy for the whole account session; only refresh cookies.
      // The old transport must finish cleanup before a replacement can acquire
      // a worker. Surface cleanup failures to the caller without resetting state.
      await this.baseFetch?.dispose?.();
      this.baseFetch = createCurlCffiFetch(this.proxyUrl, { direct: this.directEgress });
      this.jar = new CookieJar();
      this.fetch = makeFetchCookie(this.baseFetch, this.jar);
      this.state = '';
      this.codeVerifier = '';
      this.deviceID = '';
      this.smsActivation = null;
      this.mfaFactorId = '';
      this.mfaContinueUrl = '';
      this.mfaPayload = null;
      this.discoveredWorkspaces = null;
    },

    async formatErrorResponse(response) {
      const body = await response.text();
      try {
        const payload = JSON.parse(body);
        const code = payload?.error?.code || payload?.error;
        if (code) return `${response.status} code=${code}`;
      } catch {}
      return `${response.status} body=${body}`;
    },

    async fetchSentinelToken(flow) {
      return fetchOpenAISentinelToken(this.fetch, this.deviceID, flow, {
        fingerprint: this.fingerprint,
        proxyUrl: this.proxyUrl,
      });
    },

    async run() {
      if (!this.requireStoredSession) this.assertPasswordTotpCredentials();
      await this.ensureProxyConnectivity();
      this.logProtocolHardening();

      if (this.requireStoredSession) {
        this.log(`Business RT：复用已保存 Session 授权工作区 ${this.workspaceSelection.workspaceId}`);
        return this.loginCodexWithPhone();
      }

      this.log(`密码+2FA 账号，直接 Codex 登录（邮箱/密码/TOTP）: ${this.account.email}`);
      return this.loginCodexWithPhone();
    },
  };
}
