import test from 'node:test';
import assert from 'node:assert/strict';
import { ProxyHealthRegistry } from './proxy-health.js';

test('proxy health skips cooling proxies and recovers after success', () => {
  let now = 1000;
  const registry = new ProxyHealthRegistry({ cooldownMs: 5000, now: () => now });
  registry.recordFailure('http://one.example:80', new Error('SSL_ERROR_SYSCALL'));
  registry.recordFailure('http://one.example:80', new Error('SSL_ERROR_SYSCALL'));
  assert.equal(registry.isCooling('http://one.example:80'), true);
  assert.equal(registry.choose(['http://one.example:80', 'http://two.example:80'], { seed: 0 }), 'http://two.example:80');
  now += 5001;
  registry.recordSuccess('http://one.example:80', 25);
  assert.equal(registry.isCooling('http://one.example:80'), false);
  assert.equal(registry.snapshot()[0].consecutiveFailures, 0);
});

test('proxy health cools transient transport failures immediately', () => {
  const registry = new ProxyHealthRegistry({ cooldownMs: 5000 });
  registry.recordFailure('http://one.example:80', new Error('curl: (35) BoringSSL SSL_connect failed'));
  assert.equal(registry.isCooling('http://one.example:80'), true);
});
