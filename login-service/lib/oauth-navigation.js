const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Follow each hop through fetch-cookie so intermediate Set-Cookie headers reach
// the jar, but never send the CLI callback to a local HTTP listener.
export async function openOAuthPage(fetchImpl, startUrl, { headers, callbackUrl, maxRedirects = 10 } = {}) {
  let url = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (callbackUrl) {
      const current = new URL(url);
      const callback = new URL(callbackUrl);
      if (current.origin === callback.origin && current.pathname === callback.pathname) {
        return { url, response: null };
      }
    }
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', headers });
    const location = response.headers.get('location');
    if (REDIRECT_STATUSES.has(response.status) && location) {
      url = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) {
      const error = new Error(`OAuth 页面请求失败: HTTP ${response.status} path=${new URL(url).pathname}`);
      error.code = 'OAUTH_PAGE_HTTP_ERROR';
      error.status = response.status;
      throw error;
    }
    return { url: response.url || url, response };
  }
  const error = new Error(`OAuth 页面跳转次数过多，最后停在: ${new URL(url).pathname}`);
  error.code = 'OAUTH_REDIRECT_LIMIT';
  throw error;
}
