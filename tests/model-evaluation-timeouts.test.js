import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateModel } from '../src/model-evaluation.js';

const api = { baseUrl: 'https://fixture.invalid', protocol: 'responses', key: 'fixture' };
const input = reasoningEffort => ({ api, model: 'fixture', question: 'candy', reasoningEffort });
const complete = () => Response.json({ status: 'completed', output_text: '答案：21' });

for (const effort of ['max', 'xhigh', 'ultra']) {
  test(`${effort} can return its first text after five minutes`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let finish, upstream;
    const result = evaluateModel(input(effort), { fetchImpl: (_url, { signal }) => {
      upstream = signal;
      return new Promise(resolve => { finish = resolve; });
    } });
    t.mock.timers.tick(310_000);
    assert.equal(upstream.aborted, false);
    finish(complete());
    assert.equal((await result).status, 'passed');
    t.mock.timers.tick(1_200_000);
    assert.equal(upstream.aborted, false, 'completion must clear the timer');
  });
}

for (const [effort, ms] of [['medium', 150_000], ['max', 1_200_000]]) {
  test(`${effort} reports its upstream deadline while waiting for HTTP headers`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let upstream;
    const result = evaluateModel(input(effort), { fetchImpl: (_url, { signal }) => {
      upstream = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    t.mock.timers.tick(ms - 1);
    assert.equal(upstream.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(upstream.aborted, true);
    await assert.rejects(result, /模型.*超时.*响应头/);
  });
}

for (const phase of ['first text', 'partial text', 'cancel']) {
  test(`upstream stream interruption during ${phase} preserves the cause`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const caller = new AbortController();
    const ready = Promise.withResolvers();
    const text = phase === 'partial text' ? 'draft' : '';
    const result = evaluateModel(input('max'), {
      signal: caller.signal,
      fetchImpl: (_url, { signal }) => new Response(new ReadableStream({
        start(stream) {
          if (text) stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`));
          signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
        },
      })),
      onEvent(event) {
        if (text ? event.type === 'delta' : event.phase === 'waiting') ready.resolve();
      },
    });
    await ready.promise;
    if (phase === 'cancel') caller.abort(new Error('caller stopped'));
    t.mock.timers.tick(1_200_000);
    const message = phase === 'cancel' ? /caller stopped/ : text ? /模型.*超时.*正文.*完成/ : /模型.*超时.*首字/;
    await assert.rejects(result, message);
  });
}
