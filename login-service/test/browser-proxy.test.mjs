import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { once } from 'node:events';
import { browserFailureSummary } from '../lib/openai-sentinel.js';

test('browser bridge exposes only loopback and shuts down when its owner closes stdin', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, [new URL('../scripts/browser-proxy.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')]);
  try {
    const lines = readline.createInterface({ input: child.stdout });
    const ready = once(lines, 'line');
    child.stdin.write(JSON.stringify({ url: 'socks5h://user:secret@127.0.0.1:1234' }) + '\n');
    const [line] = await ready;
    const endpoint = new URL(JSON.parse(line).server);
    assert.equal(endpoint.hostname, '127.0.0.1');
    assert.equal(endpoint.protocol, 'http:');
    assert.notEqual(endpoint.port, '0');
    assert.doesNotMatch(line, /secret|user/);
    const stopped = once(child, 'exit');
    child.stdin.end();
    assert.equal((await stopped)[0], 0);
  } finally {
    child.kill();
  }
});

test('Python traceback summaries retain root cause without proxy credentials', () => {
  const result = browserFailureSummary('Traceback (most recent call last):\n  File "/app/sentinel.py", line 1\nplaywright.Error: net::ERR_NO_SUPPORTED_PROXIES socks5h://user:secret@example.com:3000\nCall log:\n- navigating');
  assert.match(result, /ERR_NO_SUPPORTED_PROXIES/);
  assert.doesNotMatch(result, /secret|Traceback/);
});
