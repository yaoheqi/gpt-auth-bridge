const NETWORK_CODES = new Set(['ERR_SSL_WRONG_VERSION_NUMBER', 'EPROTO', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT']);
const UPSTREAM_CODES = new Set(['unsupported_country_region_territory', 'unsupported_country', 'unsupported_region', 'account_deactivated', 'account_disabled', 'invalid_api_key', 'invalid_token', 'token_expired', 'access_denied', 'unauthorized', 'forbidden', 'insufficient_permissions', 'permission_denied', 'workspace_not_found']);
const CATEGORIES = new Set(['network_error', 'tls_error', 'proxy_authentication', 'edge_challenge', 'html_denial', 'api_rejection']);

export function safeCheckoutDiagnostics(value) {
  if (!value || typeof value !== 'object') return undefined;
  const result = {};
  if (CATEGORIES.has(value.category)) result.category = value.category;
  if (NETWORK_CODES.has(value.networkCode)) result.networkCode = value.networkCode;
  if (UPSTREAM_CODES.has(value.upstreamCode)) result.upstreamCode = value.upstreamCode;
  if (Number.isInteger(value.upstreamStatus) && value.upstreamStatus >= 100 && value.upstreamStatus <= 599) result.upstreamStatus = value.upstreamStatus;
  if (['json', 'html', 'text', 'empty'].includes(value.responseFormat)) result.responseFormat = value.responseFormat;
  for (const field of ['edgeChallenge', 'cloudflare', 'proxyConfigured', 'proxyChainConfigured', 'authorizationPresent']) {
    if (typeof value[field] === 'boolean') result[field] = value[field];
  }
  return Object.keys(result).length ? result : undefined;
}

export function checkoutResponseDiagnostics(response, text, data, context = {}) {
  const html = /text\/html/i.test(response.headers?.get?.('content-type') || '') || /^\s*<!doctype html|^\s*<html/i.test(text);
  const edgeChallenge = response.headers?.get?.('cf-mitigated') === 'challenge'
    || /_cf_chl_opt|\/cdn-cgi\/challenge-platform|<title>\s*Just a moment/i.test(text);
  return safeCheckoutDiagnostics({
    ...context,
    category: edgeChallenge ? 'edge_challenge' : html ? 'html_denial' : 'api_rejection',
    upstreamStatus: response.status,
    responseFormat: data != null ? 'json' : html ? 'html' : text ? 'text' : 'empty',
    edgeChallenge,
    cloudflare: /cloudflare/i.test(response.headers?.get?.('server') || '') || Boolean(response.headers?.has?.('cf-ray')),
    upstreamCode: data?.error?.code ?? data?.detail?.code ?? data?.code,
  });
}

export function checkoutNetworkDiagnostics(error, context = {}) {
  let networkCode;
  let proxyAuthentication = false;
  let proxyStatus;
  let tlsFailure = false;
  let current = error;
  for (let depth = 0; current && depth < 6; depth += 1, current = current.cause) {
    if (!networkCode && NETWORK_CODES.has(current.code)) networkCode = current.code;
    const message = String(current.message || '');
    const connectStatus = Number(message.match(/CONNECT tunnel failed, response\s+(\d{3})/i)?.[1] || 0);
    const proxyAuthRequired = /Proxy Authentication Required|HTTP\s*407/i.test(message);
    const status = Number(current.status || current.statusCode || connectStatus || (proxyAuthRequired ? 407 : 0));
    if ([403, 407].includes(status) && (status === 407 || connectStatus === status || proxyAuthRequired)) {
      proxyAuthentication = true;
      proxyStatus ||= status;
    }
    if (/tls|ssl|certificate/i.test(current.code || '') || /tls|ssl|certificate/i.test(current.message || '')) tlsFailure = true;
  }
  return safeCheckoutDiagnostics({ ...context, category: proxyAuthentication ? 'proxy_authentication' : tlsFailure ? 'tls_error' : 'network_error', networkCode, upstreamStatus: proxyStatus });
}
