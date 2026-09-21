import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { generateSentinelAnswer } from './openai-sentinel.js';

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
