import { parseProxyPool } from '../../../lib/proxy-config.js';
import { proxyHealthRegistry as defaultProxyHealthRegistry } from '../../../lib/proxy-health.js';

/** Resolve egress once per account. The default follows OPENAI_PROXY_URL;
 * explicit local/custom selections retain their own routing policy. */
export function createAuthNetworkPolicy({
  proxyHealthRegistry = defaultProxyHealthRegistry,
  random = Math.random,
} = {}) {
  function protocolRequestNetwork(body = {}) {
    const proxyMode = String(body.proxyMode || '').trim().toLowerCase();
    // Keep the persisted "direct" value compatible with the default UI option.
    if (proxyMode === 'direct') return { proxyPool: '', directWhenProxyPoolEmpty: false };
    if (proxyMode === 'local') {
      const rawPort = body.localProxyPort ?? body.local_proxy_port ?? 7890;
      const port = Number(String(rawPort).trim());
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('本地代理端口必须是 1-65535 的整数');
      }
      return { proxyPool: `http://127.0.0.1:${port}`, directWhenProxyPoolEmpty: true };
    }
    const hasProxyPool = Object.hasOwn(body || {}, 'proxyPool') || Object.hasOwn(body || {}, 'proxy_pool');
    if (proxyMode === 'pool' || hasProxyPool) {
      const proxyPool = String(body?.proxyPool ?? body?.proxy_pool ?? '').trim();
      if (!proxyPool) return { proxyPool: '', directWhenProxyPoolEmpty: true };
      parseProxyPool(proxyPool);
      return { proxyPool, directWhenProxyPoolEmpty: true };
    }
    if (body.browserState) return { proxyPool: '', directWhenProxyPoolEmpty: false };
    return { proxyPool: undefined, directWhenProxyPoolEmpty: false };
  }

  function accountRequestNetwork(_account, network = {}) {
    if (network.proxyPool === undefined) return network;
    const candidates = parseProxyPool(network.proxyPool);
    if (!candidates.length) return { ...network, proxyPool: '' };
    const index = Math.floor(random() * candidates.length);
    const selected = proxyHealthRegistry.choose(candidates, { seed: index });
    return { ...network, proxyPool: selected || candidates[index] };
  }

  return { protocolRequestNetwork, accountRequestNetwork };
}
