import { resolveSessionProxy } from '../login-service/lib/proxy-config.js';
import { createCurlCffiFetch } from '../login-service/lib/curl-cffi-fetch.js';
import { extractErrorCode } from '../login-service/src/lib/auth-behavior-contract.js';
import { readLogoutAllResponse } from '../login-service/src/services/logout-all-response.js';
import { CHATGPT_ACCOUNTS_CHECK_URL, CHATGPT_PLUS_TRIAL_CAMPAIGN, CHATGPT_PLUS_TRIAL_ELIGIBILITY_URL, CHATGPT_CHECKOUT_PRICING_CONFIG_URL } from '../login-service/lib/openai-auth-urls.js';
import { decodeJwtPayload } from '../login-service/lib/jwt-utils.js';

// A single account operation keeps the same proxy, cookie transport and cleanup.
export async function withSessionTransport(run, { signal, pool, createFetch = createCurlCffiFetch, resolveProxy = resolveSessionProxy } = {}) {
  signal?.throwIfAborted();
  const { proxyUrl } = resolveProxy({ pool, directWhenEmpty: pool === '' });
  const fetchImpl = createFetch(proxyUrl, { direct: !proxyUrl });
  const dispose = () => { void fetchImpl.dispose().catch(() => {}); };
  signal?.addEventListener('abort', dispose, { once: true });
  try {
    signal?.throwIfAborted();
    return await run({ fetchImpl, signal });
  } finally {
    signal?.removeEventListener('abort', dispose);
    await fetchImpl.dispose();
  }
}

export async function checkSessionHealth(account, { includeUsage = false, includeDevices = false, includeTrial = false, includeResetCredits = false, ...options } = {}) {
  const hasCookie = Boolean(account?.cookie || account?.cookies || account?.sessionCookie);
  const health = hasCookie ? await probeToken(account, options) : await probeUsage(account, options);
  const queryCredits = includeResetCredits && health.status === 200;
  const quota = hasCookie && (includeUsage || queryCredits) ? await probeUsage(account, options) : health;
  const usage = includeUsage ? quota : null;
  const resetCreditCount = queryCredits ? (await probeResetCreditCount(account, options) ?? quota.resetCreditCount ?? null) : null;
  const devices = includeDevices && health.status === 200 ? await probeDevices(account, options) : null;
  const trial = includeTrial && health.status === 200 ? await probePlusTrial(account, options) : null;
  return { ...health, trial, resetCreditCount, usage: usage?.usage || null, usageStatus: usage?.status ?? null, usageError: usage?.error || '',
    devices: devices?.devices ?? null, firstLoginAt: devices?.firstLoginAt ?? null, lastLoginAt: devices?.lastLoginAt ?? null,
    deviceCount: devices?.deviceCount ?? null, devicesStatus: devices?.status ?? null, devicesError: devices?.error || '' };
}

const PROBE_URL = "https://chatgpt.com/backend-api/me";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_PATH = '/backend-api/wham/rate-limit-reset-credits';
const SESSIONS_URL = "https://chatgpt.com/backend-api/accounts/sessions";
const LOGOUT_ALL_URL = "https://chatgpt.com/backend-api/accounts/logout_all";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36";

export async function probePlusTrial(account, { fetchImpl, signal } = {}) {
  let country = '';
  const campaign = CHATGPT_PLUS_TRIAL_CAMPAIGN;
  const errors = [];
  const requestSignal = () => AbortSignal.any([AbortSignal.timeout(20_000), signal].filter(Boolean));
  try {
    if (!String(account?.accessToken || '').trim()) throw new Error('缺少 access token');
    // Use the account's existing transport; never select another proxy for geo lookup.
    // No account headers or cookies are sent to the geo provider.
    const trace = await fetchImpl('https://www.cloudflare.com/cdn-cgi/trace', {
      headers: { Accept: 'text/plain' }, signal: requestSignal(),
    });
    const text = await trace.text();
    country = String(text.match(/(?:^|\n)loc=([a-z]{2})(?:\r?\n|$)/i)?.[1] || '').toUpperCase();
    if (!trace.ok || !country || country === 'XX') throw new Error('无法识别代理出口国家');
    const claims = decodeJwtPayload(account.accessToken);
    const auth = claims?.['https://api.openai.com/auth'] || {};
    const accountId = account.accountId || account.chatgptAccountId || auth.chatgpt_account_id || claims?.chatgpt_account_id;
    const probeAccount = { ...account, accountId };
    const read = async url => {
      signal?.throwIfAborted();
      try {
        const route = new URL(url).pathname;
        const response = await fetchImpl(url, {
          headers: { ...buildProbeHeaders(probeAccount, route), Referer: `https://chatgpt.com/?openaicom_referred=true&promo_campaign=${campaign}` },
          signal: requestSignal(),
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`${route}: HTTP ${response.status}`); }
        const payload = await response.json();
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`${route}: 响应无效`);
        return payload;
      } catch (error) { errors.push(String(error?.message || error)); return null; }
    };
    const accountsCheck = await read(CHATGPT_ACCOUNTS_CHECK_URL);
    const eligibility = await read(CHATGPT_PLUS_TRIAL_ELIGIBILITY_URL);
    const pricing = await read(CHATGPT_CHECKOUT_PRICING_CONFIG_URL(country));
    const accounts = accountsCheck?.accounts || {};
    // Never borrow another workspace's plan or promotion eligibility.
    const row = accountId ? accounts[accountId] : (Object.keys(accounts).length === 1 ? Object.values(accounts)[0] : null);
    const plan = String(row?.account?.plan_type || row?.account?.planType || row?.entitlement?.subscription_plan || auth.chatgpt_plan_type || claims?.chatgpt_plan_type || '').toLowerCase().replace(/^chatgpt/, '').replace(/plan$/, '');
    const campaigns = row?.account?.eligible_promo_campaigns || row?.eligible_promo_campaigns;
    const promo = campaigns?.plus || campaigns?.chatgptplusplan || campaigns?.ChatGPTPlus;
    const promoId = typeof promo === 'string' ? promo : promo?.id || promo?.promo_campaign_id;
    let eligible = null;
    let reason = '';
    if (['plus', 'pro', 'team', 'business', 'enterprise'].includes(plan)) {
      eligible = false; reason = `already_${plan}`;
    } else if (typeof eligibility?.is_eligible === 'boolean') {
      eligible = eligibility.is_eligible;
      reason = eligible ? 'eligibility_api' : String(eligibility.ineligible_reason?.code || eligibility.ineligible_reason?.message || 'user_not_eligible');
    } else if (promoId === campaign) {
      eligible = true; reason = `accounts_check:${promoId}`;
    }
    return { eligible, country, campaign, reason, planType: plan,
      currency: String(pricing?.currency_config?.symbol_code || ''),
      error: eligible === null ? (errors.join('；') || '资格接口未返回明确结果') : '',
      warning: errors.join('；') };
  } catch (error) {
    return { eligible: null, country, campaign, error: String(error?.message || error).slice(0, 512) };
  }
}

function buildProbeHeaders(account, route) {
  const h = { Authorization: `Bearer ${String(account?.accessToken || '').trim()}`, Accept: 'application/json', 'Accept-Language': account?.language || 'zh-CN,zh;q=0.9,en;q=0.8', Origin: 'https://chatgpt.com', Referer: 'https://chatgpt.com/', 'User-Agent': account?.userAgent || USER_AGENT, 'oai-language': account?.language || 'zh-CN', 'oai-device-id': account?.deviceId || account?.oaiDeviceId || '', 'oai-session-id': account?.sessionId || account?.oaiSessionId || '', 'oai-client-build-number': account?.clientBuildNumber || '10379027', 'oai-client-version': account?.clientVersion || 'prod', 'sec-ch-ua': account?.secChUa || '"Chromium";v="128", "Not A(Brand";v="24"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', 'x-openai-target-path': route, 'x-openai-target-route': route };
  const id = account?.accountId || account?.chatgptAccountId; if (id) h['chatgpt-account-id'] = id;
  const c = account?.cookie || account?.cookies || account?.sessionCookie; if (c) h.Cookie = typeof c === 'string' ? c : Object.entries(c).map(([k,v]) => `${k}=${v}`).join('; ');
  return Object.fromEntries(Object.entries(h).filter(([,v]) => v !== ''));
}

export async function probeToken(account, { fetchImpl, signal } = {}) {
  const token = String(account?.accessToken || "").trim();
  if (!token) return { status: null, error: "缺少 access token", usage: null };
  const headers = buildProbeHeaders(account, '/backend-api/me');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchImpl(PROBE_URL, { headers, signal: AbortSignal.any([controller.signal, signal].filter(Boolean)) });
    const status = response.status;
    let detail = "";
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      detail = text.trim().slice(0, 256);
    }
    if (response.ok) await response.body?.cancel();
    return { status, error: status === 403 ? `HTTP 403：访问被拒绝${detail ? `（${detail}）` : "，请检查 Token 类型或服务器出口"}` : (status >= 400 ? `HTTP ${status}${detail ? `：${detail}` : ""}` : "") };
  } catch (error) { return { status: null, error: String(error?.message || error).slice(0, 512) }; }
  finally { clearTimeout(timer); }
}

function normalizeUsage(payload) {
  const rateLimit = payload?.rate_limit;
  if (!rateLimit || typeof rateLimit !== "object") return null;
  const window = (value) => value && typeof value === "object" ? {
    usedPercent: Number.isFinite(Number(value.used_percent)) ? Number(value.used_percent) : null,
    resetAfterSeconds: Number.isFinite(Number(value.reset_after_seconds)) ? Number(value.reset_after_seconds) : null,
    resetAt: Number.isFinite(Number(value.reset_at)) ? Number(value.reset_at) : null,
    windowSeconds: Number.isFinite(Number(value.limit_window_seconds)) ? Number(value.limit_window_seconds) : null,
  } : null;
  const windows = [rateLimit.primary_window, rateLimit.secondary_window].map(window).filter(Boolean);
  let fiveHour = windows.find(item => item.windowSeconds != null && item.windowSeconds <= 6 * 60 * 60) || null;
  let sevenDay = windows.find(item => item.windowSeconds != null && item.windowSeconds > 6 * 60 * 60) || null;
  if (!fiveHour && !sevenDay) {
    fiveHour = window(rateLimit.primary_window);
    sevenDay = window(rateLimit.secondary_window);
  }
  return {
    fiveHour,
    sevenDay,
    planType: typeof payload.plan_type === "string" ? payload.plan_type : "",
    fetchedAt: Date.now(),
  };
}

function availableCreditCount(payload) {
  for (let value of [payload?.available_count, payload?.availableCount]) {
    if (typeof value === 'string' && /^\+?\d+$/.test(value.trim())) value = Number(value);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

async function probeResetCreditCount(account, { fetchImpl, signal }) {
  signal?.throwIfAborted();
  try {
    const response = await fetchImpl(`https://chatgpt.com${RESET_CREDITS_PATH}`, {
      method: 'GET', redirect: 'manual',
      headers: { ...buildProbeHeaders(account, RESET_CREDITS_PATH), 'OpenAI-Beta': 'codex-1', Originator: 'Codex Desktop' },
      signal: AbortSignal.any([AbortSignal.timeout(20_000), signal].filter(Boolean)),
    });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const payload = await response.json();
    const count = availableCreditCount(payload);
    if (count !== null) return count;
    const cards = Array.isArray(payload) ? payload : payload?.credits ?? payload?.rate_limit_reset_credits ?? payload?.items ?? payload?.data;
    if (!Array.isArray(cards)) return null;
    let available = 0;
    for (const card of cards) {
      if (card == null) continue;
      if (typeof card !== 'object' || Array.isArray(card)) return null;
      const type = (card.reset_type?.trim() || card.resetType?.trim() || '').toLowerCase();
      const status = (card.status?.trim() || '').toLowerCase();
      if ((!type || type === 'codex_rate_limits') && (!status || status === 'available')) available++;
    }
    return available;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

export async function probeUsage(account, { fetchImpl, signal } = {}) {
  const token = String(account?.accessToken || "").trim();
  if (!token) return { status: null, usage: null, error: "缺少 access token" };
  const headers = { ...buildProbeHeaders(account, '/backend-api/wham/usage'), 'OpenAI-Beta': 'codex-1', Originator: 'Codex Desktop' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchImpl(USAGE_URL, { headers, signal: AbortSignal.any([controller.signal, signal].filter(Boolean)) });
    const payload = await response.json().catch(() => null);
    return { status: response.status, code: extractErrorCode(payload), usage: response.ok ? normalizeUsage(payload) : null,
      resetCreditCount: response.ok ? availableCreditCount(payload?.rate_limit_reset_credits) : null, error: response.ok ? "" : `HTTP ${response.status}` };
  } catch (error) { return { status: null, usage: null, error: String(error?.message || error).slice(0, 512) }; }
  finally { clearTimeout(timer); }
}

// Count the signed-in devices returned by the session manager, not app_sessions.
export async function probeDevices(account, { fetchImpl, signal } = {}) {
  if (!String(account?.accessToken || '').trim()) return { status: null, deviceCount: null, error: '缺少 access token' };
  const headers = buildProbeHeaders(account, '/backend-api/accounts/sessions');
  const deviceId = account?.deviceId || account?.oaiDeviceId;
  if (deviceId) headers['oai-did'] = deviceId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchImpl(SESSIONS_URL, { headers, signal: AbortSignal.any([controller.signal, signal].filter(Boolean)) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) return { status: response.status, deviceCount: null, error: `HTTP ${response.status}` };
    if (!Array.isArray(payload?.devices)) return { status: response.status, deviceCount: null, error: '设备列表响应无效' };
    const text = value => typeof value === 'string' ? value : '';
    const timestamp = value => typeof value === 'number' && value > 0 && Number.isFinite(value) && !Number.isNaN(new Date(value * 1000).getTime()) ? value * 1000 : null;
    const devices = payload.devices.map(device => ({
      name: text(device?.display_name) || text(device?.device_model),
      description: text(device?.human_readable_description),
      platform: text(device?.platform), osVersion: text(device?.os_version),
      current: device?.is_current_device === true,
      apps: Array.isArray(device?.app_sessions) ? device.app_sessions.map(app => text(app?.client_name)).filter(Boolean) : [],
      createdAt: timestamp(device?.session_created_at_seconds),
      lastLoginAt: timestamp(device?.last_signed_in_timestamp_second),
      location: [device?.last_signed_in_city, device?.last_signed_in_region_code, device?.last_signed_in_country].map(text).filter(Boolean).join(', '),
    }));
    const firstTimes = devices.map(device => device.createdAt).filter(value => value != null);
    const lastTimes = devices.map(device => device.lastLoginAt).filter(value => value != null);
    return { status: response.status, deviceCount: devices.length, devices,
      firstLoginAt: firstTimes.length ? firstTimes.reduce((a, b) => Math.min(a, b)) : null,
      lastLoginAt: lastTimes.length ? lastTimes.reduce((a, b) => Math.max(a, b)) : null, error: '' };
  } catch (error) {
    return { status: null, deviceCount: null, error: String(error?.message || error).slice(0, 512) };
  } finally { clearTimeout(timer); }
}

export async function logoutAllSessions(account, options = {}) {
  const { fetchImpl, signal } = options;
  const probe = account?.cookie || account?.cookies || account?.sessionCookie
    ? await probeToken(account, options)
    : await probeUsage(account, options);
  if (probe.status !== 200) {
    return { probeStatus: probe.status, logoutStatus: null, ok: false, error: `退出前测活未通过：${probe.error || `HTTP ${probe.status ?? "未知"}`}` };
  }
  const headers = buildProbeHeaders(account, '/backend-api/accounts/logout_all');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let logoutStatus = null;
  try {
    const logoutResponse = await fetchImpl(LOGOUT_ALL_URL, {
      method: "POST",
      redirect: 'manual',
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.any([controller.signal, signal].filter(Boolean)),
    });
    logoutStatus = logoutResponse.status;
    const result = await readLogoutAllResponse(logoutResponse);
    return { probeStatus: probe.status, logoutStatus, responseType: result.responseType, ok: true, error: '' };
  } catch (error) {
    return { probeStatus: probe.status, logoutStatus, ok: false, error: String(error?.message || error).slice(0, 512) };
  } finally { clearTimeout(timer); }
}
