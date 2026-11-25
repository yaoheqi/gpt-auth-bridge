import { normalizeProxyUrl } from '../../lib/proxy-config.js';
import { createCurlCffiFetch } from '../../lib/curl-cffi-fetch.js';
import { checkoutResponseDiagnostics, checkoutNetworkDiagnostics } from './team-checkout-diagnostics.js';

const CHECKOUT_ENDPOINT = 'https://chatgpt.com/backend-api/payments/checkout';
const REGION_CURRENCIES = new Map(Object.entries({
  EG: 'EGP', US: 'USD', SE: 'SEK', PH: 'PHP', TH: 'THB', GB: 'GBP', CA: 'CAD',
  ZA: 'ZAR', AU: 'AUD', JP: 'JPY', SG: 'SGD', KR: 'KRW', BR: 'BRL', IN: 'INR',
  DE: 'EUR', FR: 'EUR', NL: 'EUR', ES: 'EUR', IT: 'EUR',
}));
const CHECKOUT_HOSTS = new Set(['checkout.stripe.com', 'pay.openai.com', 'chatgpt.com']);

function checkoutError(message, status = 400, code = 'INVALID_TEAM_CHECKOUT', diagnostics) {
  return Object.assign(new Error(message), { status, code, ...(diagnostics ? { diagnostics } : {}) });
}

function textField(value, label, maxLength, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > maxLength || (required && !value.trim())) {
    throw checkoutError(`${label}${required ? '不能为空，且' : ''}必须是最多 ${maxLength} 个字符的文本`);
  }
  return value.trim();
}

function normalizeAccessToken(value) {
  let tokenInput = textField(value, 'Session JSON 或 Access Token', 262144, true)
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '').trim();
  const fenced = tokenInput.match(/^\u0060{3}(?:json|text)?[ \t]*\r?\n([\s\S]*?)\r?\n\u0060{3}$/i);
  if (fenced) tokenInput = fenced[1].trim();
  tokenInput = tokenInput.replace(/^\u0060([^\u0060]*)\u0060$/, '$1').replace(/^'([^']*)'$/, '$1').trim();
  if (tokenInput.startsWith('{') || tokenInput.startsWith('"')) {
    let session;
    try { session = JSON.parse(tokenInput); } catch { throw checkoutError('Session JSON 或带引号的 Token 格式无效，请粘贴完整内容'); }
    tokenInput = typeof session === 'string' ? session
      : textField(session.accessToken ?? session.access_token ?? session.session?.accessToken ?? session.session?.access_token ?? session.credentials?.accessToken ?? session.credentials?.access_token, 'Session 中的 Access Token', 262144, true);
  }
  let accessToken = tokenInput.replace(/[\u200b-\u200d\u2060\ufeff]/g, '').trim().replace(/^Bearer(?:\s+|$)/i, '').trim();
  if (!accessToken || accessToken === 'PASTE_ACCESS_TOKEN_HERE') throw checkoutError('Access Token 为空，请粘贴真实 Token 或完整 Session JSON');
  if (/\s/.test(accessToken)) {
    const compact = accessToken.replace(/\s/g, '');
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(compact)) {
      throw checkoutError('Access Token 含空白或混入其他内容，请只粘贴一个 Token 或完整 Session JSON');
    }
    accessToken = compact;
  }
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(accessToken)) throw checkoutError('Access Token 含无效字符，请只粘贴 Token 或完整 Session JSON');
  if (accessToken.length > 32768) throw checkoutError('Access Token 长度超出限制');
  return accessToken;
}

export function normalizeTeamCheckout(body = {}, { env = process.env } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw checkoutError('请求参数必须是 JSON 对象');
  const accessToken = normalizeAccessToken(body.accessToken);
  const proxyMode = body.proxyMode ?? (body.proxyUrl ? 'custom' : 'direct');
  if (!['builtin', 'custom', 'direct'].includes(proxyMode)) throw checkoutError('请选择内置代理、自定义代理或服务器直连');
  let proxyUrl = '';
  if (proxyMode !== 'direct') {
    if (proxyMode === 'builtin' && !env.TEAM_CHECKOUT_PROXY_URL?.trim()) throw checkoutError('内置代理未配置，请配置 TEAM_CHECKOUT_PROXY_URL 或选择自定义代理');
    const value = textField(proxyMode === 'builtin' ? env.TEAM_CHECKOUT_PROXY_URL : body.proxyUrl, '代理地址', 8192, true);
    try {
      proxyUrl = normalizeProxyUrl(value);
      const proxy = new URL(proxyUrl);
      if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(proxy.protocol) || /[\r\n]/.test(value) || proxy.pathname !== '/' && proxy.pathname !== '' || proxy.search || proxy.hash) throw new Error();
    } catch {
      throw checkoutError('代理地址无效，请填写 host:port:user:password 或 HTTP(S) / SOCKS5 代理 URL');
    }
  }
  const workspaceName = textField(body.workspaceName, '工作区名称', 100, true);
  let coupon = textField(body.coupon, '优惠码或链接', 4096);
  if (/^https?:\/\//i.test(coupon)) {
    let promoUrl;
    try { promoUrl = new URL(coupon); } catch { throw checkoutError('优惠链接格式无效'); }
    coupon = promoUrl.searchParams.get('promoCode') || promoUrl.searchParams.get('promo_code') || promoUrl.searchParams.get('coupon') || '';
    if (!coupon.trim()) throw checkoutError('优惠链接中未找到优惠码，请直接填写优惠码');
  }
  coupon = textField(coupon, '优惠码', 200);
  const existingWorkspaceId = textField(body.existingWorkspaceId, '工作区 ID', 100);
  const seatQuantity = body.seatQuantity ?? 2;
  if (!Number.isSafeInteger(seatQuantity) || seatQuantity < 2) throw checkoutError('席位数量必须是至少 2 的整数');
  const priceInterval = body.priceInterval ?? 'month';
  if (!['month', 'year'].includes(priceInterval)) throw checkoutError('付款周期必须是 month 或 year');
  const automatic = body.country === 'auto';
  const country = automatic ? '' : textField(body.country ?? 'EG', '账单国家', 2, true).toUpperCase();
  const currency = automatic ? '' : textField(body.currency ?? 'EGP', '账单货币', 3, true).toUpperCase();
  if (!automatic && (!/^[A-Z]{2}$/.test(country) || !/^[A-Z]{3}$/.test(currency))) throw checkoutError('国家需为两位字母，货币需为三位字母');
  const cancelUrl = new URL('https://chatgpt.com/');
  const campaignId = 'team-1-month-free';
  const freeCampaign = body.freeCampaign === true || coupon === campaignId;
  if (coupon === campaignId) coupon = '';
  if (freeCampaign) cancelUrl.hash = 'pricing';
  if (coupon) cancelUrl.searchParams.set('promoCode', coupon);
  return {
    accessToken, proxyUrl,
    payload: {
      plan_name: 'chatgptteamplan',
      team_plan_data: {
        workspace_name: workspaceName, price_interval: priceInterval, seat_quantity: seatQuantity,
        ...(existingWorkspaceId ? { existing_workspace_id: existingWorkspaceId } : {}),
      },
      ...(automatic ? {} : { billing_details: { country, currency } }),
      cancel_url: cancelUrl.href,
      ...(freeCampaign ? {
        entry_point: 'team_workspace_purchase_modal',
        promo_campaign: { promo_campaign_id: campaignId, is_coupon_from_query_param: true },
      } : {}),
      ...(coupon ? { promo_code: coupon } : {}),
      checkout_ui_mode: 'hosted',
    },
  };
}

export function validateTeamCheckoutUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw checkoutError('服务端未返回有效的支付长链接', 502, 'INVALID_CHECKOUT_URL'); }
  if (url.protocol !== 'https:' || !CHECKOUT_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
    throw checkoutError('服务端返回的支付链接地址无效', 502, 'INVALID_CHECKOUT_URL');
  }
  return url.href;
}

export async function generateTeamCheckout(input, { fetchImpl, createProxyFetch = createCurlCffiFetch, signal } = {}) {
  const { accessToken, proxyUrl, payload } = normalizeTeamCheckout(input);
  const deadline = AbortSignal.timeout(30_000);
  let response;
  let data;
  let proxyFetch;
  let responseText = '';
  const diagnosticContext = { proxyConfigured: Boolean(proxyUrl), proxyChainConfigured: Boolean(proxyUrl && process.env.PROXY_CHAIN_URL), authorizationPresent: Boolean(accessToken) };
  try {
    signal?.throwIfAborted();
    if (proxyUrl || !fetchImpl) proxyFetch = createProxyFetch(proxyUrl, { direct: !proxyUrl });
    const request = proxyFetch || fetchImpl;
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    if (!payload.billing_details) {
      const profile = await request('https://chatgpt.com/backend-api/me', {
        method: 'GET', headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'manual', signal: requestSignal,
      });
      if (profile.status === 401) throw checkoutError('Access Token 已失效，请重新登录获取', 401, 'CHECKOUT_REJECTED');
      const details = profile.ok ? await profile.json().catch(() => null) : null;
      const country = typeof details?.country === 'string' ? details.country.trim().toUpperCase() : '';
      const currency = REGION_CURRENCIES.get(country);
      if (!currency) throw checkoutError('无法识别账单地区或币种，请手动选择后重试');
      payload.billing_details = { country, currency };
    }
    response = await request(CHECKOUT_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), redirect: 'manual',
      signal: requestSignal,
    });
    responseText = await response.text();
    try { data = JSON.parse(responseText); } catch { data = null; }
  } catch (error) {
    if (signal?.aborted) throw checkoutError('请求已取消', 499, 'CHECKOUT_CANCELLED');
    if (deadline.aborted) throw checkoutError('生成链接超时，请稍后重试', 504, 'CHECKOUT_TIMEOUT');
    if (error.code === 'INVALID_TEAM_CHECKOUT' || error.code === 'CHECKOUT_REJECTED') throw error;
    const diagnostics = checkoutNetworkDiagnostics(error, diagnosticContext);
    let message = proxyUrl ? '代理连接失败，请检查代理地址、凭据及网络后重试' : '无法连接支付服务，请检查服务器网络后重试';
    if (diagnostics.category === 'tls_error') message = 'TLS 握手失败，请核对代理协议、端口及服务器代理链配置' + (diagnostics.networkCode ? '（' + diagnostics.networkCode + '）' : '');
    if (diagnostics.category === 'proxy_authentication') message = '代理认证失败（HTTP 407），请检查代理用户名和密码';
    throw checkoutError(message, 502, 'CHECKOUT_NETWORK_ERROR', diagnostics);
  } finally {
    await proxyFetch?.dispose?.().catch(() => {});
  }
  if (!response.ok) {
    const diagnostics = checkoutResponseDiagnostics(response, responseText, data, diagnosticContext);
    let message = ({
      400: '支付服务拒绝请求，请检查工作区、席位、账单地区和优惠码',
      401: 'Access Token 已失效，请重新登录获取',
      403: '支付服务拒绝访问，请检查账号权限和服务器网络',
      429: '请求过于频繁，请稍后重试',
    })[response.status] || '支付服务暂时无法生成链接，请稍后重试';
    if (response.status === 403 && diagnostics.category === 'edge_challenge') message = '支付服务返回访问验证页面，当前服务器请求未通过访问验证';
    else if (response.status === 403 && diagnostics.category === 'html_denial') message = '支付服务返回 HTML 访问拒绝页，未收到支付 API 的 JSON 响应';
    else if (response.status === 403 && ['unsupported_country_region_territory', 'unsupported_country', 'unsupported_region'].includes(diagnostics.upstreamCode)) message = '支付接口返回地区不受支持的错误';
    throw checkoutError(`${message}（HTTP ${response.status}）`, [400, 401, 403, 429].includes(response.status) ? response.status : 502, 'CHECKOUT_REJECTED', diagnostics);
  }
  const url = validateTeamCheckoutUrl(data?.url || data?.stripe_hosted_url || data?.checkout_url);
  return {
    url,
    ...(typeof data.checkout_session_id === 'string' ? { checkoutSessionId: data.checkout_session_id } : {}),
    workspaceName: payload.team_plan_data.workspace_name, seatQuantity: payload.team_plan_data.seat_quantity,
    priceInterval: payload.team_plan_data.price_interval,
    country: payload.billing_details.country, currency: payload.billing_details.currency,
  };
}
