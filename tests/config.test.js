import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadApplicationEnv } from '../src/config.js';
import { loadCliEnv } from '../login-service/scripts/cli-env.mjs';
import { parseArgs } from '../login-service/scripts/session-health.mjs';
import { clampOauthBatchConcurrency, configuredTaskConcurrency } from '../login-service/lib/batch-concurrency.js';
import { resolveProtocolLoginConcurrency } from '../login-service/src/services/job-runner.js';

test('server and CLI share root dotenv precedence for active settings', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-config-'));
  const envFile = path.join(directory, '.env');
  try {
    await writeFile(envFile, [
      '\uFEFFPORT=45173',
      'OPENAI_PROXY_URL= # direct egress',
    ].join('\n'));
    const serverEnv = {};
    loadApplicationEnv({ env: serverEnv, envFile });
    const cliEnv = {};
    assert.equal(loadCliEnv({ env: cliEnv, envFile }), true);
    assert.deepEqual(cliEnv, serverEnv);
    assert.equal(serverEnv.OPENAI_PROXY_URL, '');
    const options = parseArgs([], cliEnv);
    assert.equal(options.baseUrl, 'http://127.0.0.1:45173');
    const skipped = loadApplicationEnv({ env: { SKIP_DOTENV: '1' }, envFile });
    assert.equal(skipped.PORT, '4173');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('all task concurrency defaults and limits share one policy', () => {
  assert.equal(configuredTaskConcurrency({}), 10);
  assert.equal(configuredTaskConcurrency({ TASK_CONCURRENCY: '24' }), 24);
  assert.equal(configuredTaskConcurrency({ OAUTH_CONCURRENCY: '3', SESSION_RELOGIN_THREADS: '5', SENTINEL_BROWSER_CONCURRENCY: '2' }), 10);
  for (const [value, expected] of [[undefined, 10], [0, 10], [-1, 10], ['invalid', 10], [Infinity, 10], [1, 1], [20.9, 20], [99, 30]]) {
    assert.equal(clampOauthBatchConcurrency(value), expected);
    assert.equal(resolveProtocolLoginConcurrency({ requested: value, globalConcurrency: 5 }), 5);
  }
  assert.equal(parseArgs([], {}).concurrency, 10);
  assert.equal(parseArgs([], { TASK_CONCURRENCY: '25' }).concurrency, 25);
  assert.throws(() => parseArgs(['--concurrency', '30'], {}), /未知参数/);
  assert.throws(() => parseArgs(['--concurrency', '31'], {}));
});
