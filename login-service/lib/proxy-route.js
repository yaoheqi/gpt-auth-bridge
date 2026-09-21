import { createTunnel, closeTunnel } from 'proxy-chain';

/** Connect to a pool proxy through the configured first hop, never directly. */
export async function createProxyRoute(proxyUrl, firstHop = process.env.PROXY_CHAIN_URL || '') {
  const unchanged = { url: proxyUrl, close: async () => {} };
  if (!proxyUrl || !firstHop) return unchanged;
  const target = new URL(proxyUrl);
  // Already-local bridges and an explicitly selected local proxy need no extra hop.
  if (['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) return unchanged;
  const entry = new URL(firstHop);
  if (!['http:', 'https:'].includes(entry.protocol)) throw new Error('PROXY_CHAIN_URL must use HTTP or HTTPS CONNECT');
  if (!['http:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(target.protocol)) {
    throw new Error('Chained pool proxies must use HTTP or SOCKS');
  }
  const destination = `${target.hostname}:${target.port || (target.protocol === 'http:' ? '80' : '1080')}`;
  const tunnel = await createTunnel(entry.href, destination, { hostname: '127.0.0.1', port: 0 });
  const endpoint = new URL(`http://${tunnel}`);
  target.hostname = endpoint.hostname;
  target.port = endpoint.port;
  let closing;
  return { url: target.href, close: () => closing ||= closeTunnel(tunnel, true) };
}
