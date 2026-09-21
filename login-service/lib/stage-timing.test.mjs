import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createStageMetrics, measureStage, recordStageTiming, withAccountTimings } from './stage-timing.js';
import { createTaskLimiter } from './task-concurrency.js';

test('stage metrics bound samples, compute recent percentiles and reject arbitrary labels', () => {
  const metrics = createStageMetrics({ sampleLimit: 3 });
  for (const ms of [1, 2, 3, 100]) metrics.record('password', ms);
  metrics.record('password', 200, 'error');
  metrics.record('password', 300, 'cancelled');
  metrics.record('password', NaN);
  metrics.record('user@example.com', 500);
  assert.deepEqual(metrics.snapshot(), { password: {
    count: 6, failures: 1, cancelled: 1, meanMs: 101, maxMs: 300, sampleCount: 3, p50Ms: 200, p95Ms: 300,
  } });
});

test('parallel account timings remain isolated and observer errors do not fail work', async () => {
  const [one, two] = await Promise.all([
    withAccountTimings(async () => {
      recordStageTiming('password', 30);
      await delay(5);
      recordStageTiming('totp', 20);
      return { ok: true };
    }, { queueMs: 12, onTiming() { throw new Error('observer'); } }),
    withAccountTimings(async () => {
      await delay(1);
      recordStageTiming('password', 90, 'error');
      await assert.rejects(measureStage('http_request', () => { throw new DOMException('cancelled', 'AbortError'); }));
      return { ok: false };
    }),
  ]);
  assert.equal(one.timings.password.durationMs, 30);
  assert.equal(one.timings.totp.durationMs, 20);
  assert.equal(one.timings.queue.durationMs, 12);
  assert.equal(one.timings.total.failures, 0);
  assert.equal(two.timings.password.durationMs, 90);
  assert.equal(two.timings.password.failures, 1);
  assert.equal(two.timings.http_request.cancelled, 1);
  assert.equal(two.timings.total.failures, 1);
  assert.equal(two.timings.totp, undefined);
});

test('queue duration includes waiting for a slot, and nested phases do not acquire again', async () => {
  const tasks = createTaskLimiter(1);
  let finish;
  const first = tasks.run(() => new Promise(resolve => { finish = resolve; }));
  await delay(0);
  const second = tasks.run(async () => {
    const duration = tasks.queueDuration();
    assert.ok(duration >= 10);
    await tasks.run(() => assert.equal(tasks.queueDuration(), duration));
  });
  await delay(20);
  finish();
  await Promise.all([first, second]);
});
