import { CHATGPT_BASE_URL as defaultCHATGPT_BASE_URL } from '../../../lib/openai-auth-urls.js';
import {
  FIXED_LOCAL_PROXY_URL as defaultFIXED_LOCAL_PROXY_URL,
  maskProxyUrl as defaultMaskProxyUrl,
  parseProxyPool as defaultParseProxyPool,
  resolveSessionProxy as defaultResolveSessionProxy,
} from '../../../lib/proxy-config.js';
import {
  SESSION_HEALTH as defaultSESSION_HEALTH,
  probeChatGptSessionAccessToken as defaultProbeChatGptSessionAccessToken,
} from '../session-health-service.js';
import { createCurlCffiFetch as defaultCreateCurlCffiFetch } from '../../../lib/curl-cffi-fetch.js';
import { normalizeTotpSecret as defaultNormalizeTotpSecret } from '../../../lib/totp.js';
import { nowIso as defaultNowIso } from './auth-records.js';
import { protocolLoginCredentialIssue as defaultProtocolLoginCredentialIssue } from '../../domain/accounts/account-domain.js';
import { randomUUID as defaultRandomUUID } from 'crypto';

/** Request-owned operations. Configuration and repositories are supplied by the composition root. */
export function createSessionLoginService({
  CHATGPT_BASE_URL = defaultCHATGPT_BASE_URL,
  FIXED_LOCAL_PROXY_URL = defaultFIXED_LOCAL_PROXY_URL,
  OpenAIJsonAuthFlow,
  SESSION_HEALTH = defaultSESSION_HEALTH,
  STATIC_DEVICE_FINGERPRINT,
  buildBrowserHeaders,
  createCurlCffiFetch = defaultCreateCurlCffiFetch,
  findAccountById,
  getProtocolSettings,
  maskProxyUrl = defaultMaskProxyUrl,
  normalizeStoredFingerprint,
  normalizeTotpSecret = defaultNormalizeTotpSecret,
  nowIso = defaultNowIso,
  parseProxyPool = defaultParseProxyPool,
  persistChatGptWebSession,
  probeChatGptSessionAccessToken = defaultProbeChatGptSessionAccessToken,
  protocolLoginCredentialIssue = defaultProtocolLoginCredentialIssue,
  randomUUID = defaultRandomUUID,
  resolveSessionProxy = defaultResolveSessionProxy,
} = {}) {
  async function reloginChatGptWebSessionForHealth(account, {
    onLog,
    proxyPool,
    directWhenProxyPoolEmpty = false,
  } = {}) {
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

    const persistResult = async (sessionResult) => {
      if (account.id) {
        await persistChatGptWebSession(account.id, {
          accessToken: sessionResult.accessToken,
          session: sessionResult.session,
          storageState: sessionResult.storageState,
          status: 'Session已刷新',
        });
      }
      return {
        accessToken: sessionResult.accessToken,
        session: sessionResult.session,
        storageState: sessionResult.storageState,
        proxyUrl: sessionResult.proxyUrl,
        directEgress: Boolean(sessionResult.directEgress),
        logs,
      };
    };

    const issue = protocolLoginCredentialIssue(account);
    if (issue) throw new Error(issue);
    const loginAccount = { ...account };
    loginAccount.openai_password = String(account.openai_password || account.password || '').trim();
    loginAccount.two_factor_secret = normalizeTotpSecret(account.two_factor_secret);
    if (account.id) {
      const latest = findAccountById(account.id);
      if (latest) {
        loginAccount.openai_password = latest.openai_password || latest.password || loginAccount.openai_password;
        loginAccount.two_factor_secret = latest.two_factor_secret || loginAccount.two_factor_secret;
      }
    }
    const flow = new OpenAIJsonAuthFlow(loginAccount, sse, {
      phoneMode: 'sms',
      humanPacingEnabled: false,
      proxyPool,
      directWhenProxyPoolEmpty,
    });
    flow.log('验活重登：邮箱 + 密码 + TOTP 登录 ChatGPT Web');
    try {
      return await persistResult({
        ...(await flow.loginChatGptWebWithPasswordTotp()),
        proxyUrl: flow.proxyUrl,
        directEgress: flow.directEgress,
      });
    } finally {
      await flow.dispose();
    }
  }

  function storageStateCookies(storageStateJson) {
    let state;
    try { state = JSON.parse(String(storageStateJson || '')); } catch { return new Map(); }
    if (!Array.isArray(state?.cookies)) return new Map();
    const cookies = new Map();
    for (const cookie of state.cookies) {
      const name = String(cookie?.name || '').trim();
      if (!name || cookie?.value == null) continue;
      cookies.set(name, String(cookie.value));
    }
    return cookies;
  }

  function sessionProbeHeaders(storageStateJson, fingerprintJson = '') {
    const cookies = storageStateCookies(storageStateJson);
    const fingerprint = normalizeStoredFingerprint(fingerprintJson) || STATIC_DEVICE_FINGERPRINT;
    const cookieHeader = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    return {
      ...buildBrowserHeaders({
        accept: '*/*',
        origin: CHATGPT_BASE_URL,
        referer: `${CHATGPT_BASE_URL}/`,
        'oai-device-id': cookies.get('oai-did') || '',
        'oai-language': fingerprint.locale || 'en-US',
        'oai-session-id': randomUUID(),
        'x-openai-target-path': '/backend-api/me',
        'x-openai-target-route': '/backend-api/me',
      }, fingerprint),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    };
  }

  async function probeSessionThroughConfiguredProxy(accessToken, storageStateJson = '', fingerprintJson = '', {
    exactProxyUrl,
    direct = false,
  } = {}) {
    const settings = getProtocolSettings();
    const headers = sessionProbeHeaders(storageStateJson, fingerprintJson);
    const hasExactProxy = exactProxyUrl !== undefined || direct;
    const selectedProxy = hasExactProxy ? String(exactProxyUrl || '') : resolveSessionProxy({ pool: settings.proxyPool }).proxyUrl;
    const proxies = [selectedProxy];
    if (!hasExactProxy) {
      for (const candidate of parseProxyPool(settings.proxyPool)) {
        if (!proxies.includes(candidate)) proxies.push(candidate);
      }
      if (!proxies.includes(FIXED_LOCAL_PROXY_URL)) proxies.push(FIXED_LOCAL_PROXY_URL);
    }
    const failures = [];
    let lastFailure = null;

    for (const proxyUrl of proxies) {
      const fetchImpl = createCurlCffiFetch(proxyUrl, { direct: direct && !proxyUrl });
      try {
        const result = await probeChatGptSessionAccessToken(accessToken, { fetchImpl, headers });
        if (result.health !== SESSION_HEALTH.PROBE_FAILED) {
          return result;
        }
        lastFailure = result;
        failures.push(`${proxyUrl ? maskProxyUrl(proxyUrl) : '直连'}: ${result.error || `HTTP ${result.status || 0}`}`);
      } finally {
        await fetchImpl.dispose?.();
      }
    }

    return {
      ok: false,
      health: SESSION_HEALTH.PROBE_FAILED,
      status: lastFailure?.status || 0,
      code: lastFailure?.code || '',
      body: lastFailure?.body || '',
      error: `所有代理出口探测失败：${failures.join('；')}`,
    };
  }

  return { reloginChatGptWebSessionForHealth, storageStateCookies, sessionProbeHeaders, probeSessionThroughConfiguredProxy };
}
