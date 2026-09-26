import { CookieJar as defaultCookieJar } from 'tough-cookie';
import { createCurlCffiFetch as defaultCreateCurlCffiFetch } from '../../../lib/curl-cffi-fetch.js';
import defaultMakeFetchCookie from 'fetch-cookie';
import { measureStage as defaultMeasureStage } from '../../../lib/stage-timing.js';
import { randomUUID as defaultRandomUUID } from 'crypto';
import { createCoreMethods } from './flow/core.js';
import { createLoginChallengeMethods } from './flow/login-challenges.js';
import { createOAuthNavigationMethods } from './flow/oauth-navigation.js';
import { createWorkspaceMethods } from './flow/workspace.js';
import { createPhoneChallengeMethods } from './flow/phone-challenges.js';
import { createWebSessionMethods } from './flow/web-session.js';
import { createAccountSecurityMethods } from './flow/account-security.js';
import { createPlusTrialMethods } from './flow/plus-trial.js';

/** Build an isolated authentication flow class without starting workers or a server.
 * Pass request-aware repository, transport, provider and settings functions.
 * The flow owns its cookies, fingerprint and OAuth state until dispose().
 */
export function createOpenAIJsonAuthFlow(dependencies = {}) {
  const {
    CookieJar = defaultCookieJar,
    createAccountSessionDeviceAndProxy,
    createCurlCffiFetch = defaultCreateCurlCffiFetch,
    createSmsBowerClient,
    getPhoneOtpWaitTimeoutMs,
    getSmsProviderLabel,
    makeFetchCookie = defaultMakeFetchCookie,
    measureStage = defaultMeasureStage,
    normalizePhoneMode,
    randomUUID = defaultRandomUUID,
  } = dependencies;
  class OpenAIJsonAuthFlow {
    constructor(account, sse, {
      phoneMode = 'sms',
      agentIdentityEnabled,
      reuseStoredSession = false,
      forbidPhoneChallenge = false,
      workspaceSelection = { mode: 'personal' },
      requireStoredSession = false,
      humanPacingEnabled,
      proxyPool,
      directWhenProxyPoolEmpty = false,
    } = {}) {
      this.account = account;
      this.sse = sse;
      this.isolationId = randomUUID();
      const session = createAccountSessionDeviceAndProxy(account, { proxyPool, directWhenProxyPoolEmpty });
      this.fingerprint = session.fingerprint;
      this.proxyUrl = session.proxy.proxyUrl;
      this.directEgress = session.proxy.mode === 'direct';
      this.proxyLabel = session.proxy.label;
      this.baseFetch = createCurlCffiFetch(this.proxyUrl, { direct: this.directEgress });
      this.jar = new CookieJar();
      this.fetch = makeFetchCookie(this.baseFetch, this.jar);
      this.state = '';
      this.codeVerifier = '';
      this.deviceID = '';
      // phoneMode 优先；兼容旧参数 agentIdentityEnabled（true=agent，false=sms）
      if (agentIdentityEnabled === true) this.phoneMode = 'agent';
      else if (agentIdentityEnabled === false) this.phoneMode = 'sms';
      else this.phoneMode = normalizePhoneMode(phoneMode);
      this.agentIdentityEnabled = this.phoneMode === 'agent';
      this.reuseStoredSession = Boolean(reuseStoredSession);
      this.smsCodeTimeoutMs = getPhoneOtpWaitTimeoutMs();
      this.requireStoredSession = Boolean(requireStoredSession);
      this.forbidPhoneChallenge = Boolean(forbidPhoneChallenge);
      this.humanPacingExplicit = typeof humanPacingEnabled === 'boolean';
      // Keep human pacing configurable; login and RT conversion default to fast execution.
      this.humanPacingEnabled = typeof humanPacingEnabled === 'boolean'
        ? humanPacingEnabled
        : false;
      const workspaceMode = workspaceSelection?.mode === 'id' ? 'id' : 'personal';
      this.workspaceSelection = { mode: workspaceMode, workspaceId: workspaceMode === 'id' ? String(workspaceSelection?.workspaceId || '').trim() : '' };
      if (workspaceMode === 'id' && !this.workspaceSelection.workspaceId) throw new Error('Business workspace ID 不能为空');
      this.smsProvider = createSmsBowerClient();
      this.smsProviderLabel = getSmsProviderLabel();
      this.smsActivation = null;
      this.smsAcquirePlanner = null;
      for (const [method, stage] of Object.entries({
        startOAuthSession: 'oauth_start', startChatGptWebSignIn: 'oauth_start',
        authorizeContinue: 'username', passwordVerify: 'password', mfaValidate: 'totp',
        fetchSentinelToken: 'sentinel', exchangeCodeForToken: 'token_exchange', readChatGptAccessToken: 'session',
      })) {
        const operation = this[method].bind(this);
        this[method] = (...args) => measureStage(stage, () => operation(...args));
      }
    }
  }
  for (const methods of [
    createCoreMethods(dependencies),
    createLoginChallengeMethods(dependencies),
    createOAuthNavigationMethods(dependencies),
    createWorkspaceMethods(dependencies),
    createPhoneChallengeMethods(dependencies),
    createWebSessionMethods(dependencies),
    createAccountSecurityMethods(dependencies),
    createPlusTrialMethods(dependencies),
  ]) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(methods))) {
      Object.defineProperty(OpenAIJsonAuthFlow.prototype, name, { ...descriptor, enumerable: false });
    }
  }
  return OpenAIJsonAuthFlow;
}
