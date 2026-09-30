import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { createOpenAISentinelTokenFetcher, generateSentinelAnswer } from './openai-sentinel.js';
import { executions } from '../src/services/request-scope.js';
import { validationError } from './validation-error.js';

test('long proof computation lets I/O run and stops when the request is cancelled', async () => {
  const controller = new AbortController();
  let finished = false;
  // No hexadecimal digest can satisfy '/'; cancellation must interrupt the loop.
  const work = generateSentinelAnswer('fixture', '/', {}, 'fixture', { signal: controller.signal });
  const outcome = work.finally(() => { finished = true; });
  const rejected = assert.rejects(outcome, { name: 'AbortError' });
  await yieldToIO();
  assert.equal(finished, false, 'proof computation blocked the event loop until completion');
  controller.abort();
  await rejected;
});

test('proof returns its normal format and starts no computation after cancellation', async () => {
  const answer = await generateSentinelAnswer('fixture', 'f', {}, 'fixture');
  assert.match(answer, /~S$/);
  assert.equal(JSON.parse(Buffer.from(answer.slice(0, -2), 'base64').toString())[4], 'fixture');
  const reason = new Error('request disconnected');
  await assert.rejects(generateSentinelAnswer('fixture', '/', {}, 'fixture', { signal: AbortSignal.abort(reason) }), reason);
});

const challenge = async () => ({ ok: true, json: async () => ({ turnstile: { dx: 'fixture' } }) });

test('browser fallback works without YesCaptcha credentials', async () => {
  const fetchToken = createOpenAISentinelTokenFetcher({
    getYesCaptchaSettings: () => ({ browserFallback: true }),
    solveBrowserSentinel: async () => 'fixture-token',
  });
  assert.equal(await fetchToken(challenge, 'device', 'flow'), 'fixture-token');
});

test('failure reports the enabled browser path once without recommending enabling it again', async () => {
  const fetchToken = createOpenAISentinelTokenFetcher({
    getYesCaptchaSettings: () => ({ browserFallback: true }),
    solveBrowserSentinel: async () => { throw validationError('BROWSER_CLOSED', { stage: 'browser_navigation', attempt: 2 }); },
  });
  await assert.rejects(fetchToken(challenge, 'device', 'flow'), error => {
    assert.equal(error.code, 'BROWSER_CLOSED');
    assert.equal(error.stage, 'browser_navigation');
    assert.equal(error.attempt, 2);
    assert.match(error.message, /回退已启用但执行失败/);
    assert.match(error.message, /YesCaptcha 未完整配置/);
    assert.doesNotMatch(error.message, /grok|或启用|浏览器回退失败: 浏览器/);
    return true;
  });
});

test('cancelling the browser fallback preserves cancellation instead of reporting captcha failure', async () => {
  const controller = new AbortController();
  const reason = new DOMException('Task cancelled', 'AbortError');
  const fetchToken = createOpenAISentinelTokenFetcher({
    getYesCaptchaSettings: () => ({ browserFallback: true }),
    solveBrowserSentinel: async () => { controller.abort(reason); throw reason; },
  });
  await executions.run({ signal: controller.signal }, () => assert.rejects(fetchToken(challenge, 'device', 'flow'), reason));
});
