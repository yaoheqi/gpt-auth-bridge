import { sessionApiError } from './cached-web-session.js';

// logout_all may acknowledge success without a JSON object. Never include its
// body in errors: an unexpected response can contain private session data.
export async function readLogoutAllResponse(response) {
  const text = (await response.text()).trim();
  let payload;
  let json = false;
  if (text) {
    try { payload = JSON.parse(text); json = true; } catch {}
  }
  const record = payload && typeof payload === 'object' && !Array.isArray(payload);
  if (!response.ok || payload === false || (record && (payload.error || payload.success === false || payload.ok === false))) {
    throw sessionApiError('logout_all', response.status, payload);
  }
  const mediaType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const html = Boolean(text) && (mediaType === 'text/html' || mediaType === 'application/xhtml+xml' || /^\s*</.test(text));
  const responseType = !text ? 'empty' : html ? 'html' : json
    ? payload === null ? 'json-null' : Array.isArray(payload) ? 'json-array' : `json-${typeof payload}` : 'text';
  const acknowledgment = !text || payload === null || payload === true
    || (record && (Object.keys(payload).length === 0 || payload.success === true || payload.ok === true))
    || (typeof payload === 'string' && /^(ok|success)$/i.test(payload.trim()))
    || (!json && /^(ok|success)$/i.test(text));
  if (html || !acknowledgment) {
    throw Object.assign(new Error(`logout_all 响应无法确认成功：HTTP ${response.status}，响应类型 ${responseType}，长度 ${text.length}；请核对会话状态后再操作`), {
      status: response.status, code: 'logout_response_unrecognized',
    });
  }
  return { status: response.status, responseType };
}
