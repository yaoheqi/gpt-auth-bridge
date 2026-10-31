import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateModel, parseEvaluationResponse, gradeEvaluation, validateEvaluation } from '../src/model-evaluation.js';
import { readEvaluationEvents } from '../docs/evaluation-stream.js';

const account = { accessToken: 'fixture-token', accountId: 'workspace-one' };
const completed = output => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: output }] }] });

test('evaluation forwards chosen model and workspace to the fixed endpoint', async () => {
  for (const model of ['gpt-6-astra', 'custom-model']) {
    const result = await evaluateModel({ account, question: 'candy', model }, { fetchImpl: async (url, init) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(init.headers['ChatGPT-Account-Id'], 'workspace-one');
      assert.equal(init.headers.Authorization, 'Bearer fixture-token');
      const body = JSON.parse(init.body);
      assert.equal(body.model, model);
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.match(body.input[0].content[0].text, /五角星/);
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: completed('推理过程\n答案：21') })}\n\n`);
    } });
    assert.equal(result.status, 'passed');
    assert.equal(result.model, model);
    assert.ok(!JSON.stringify(result).includes('fixture-token'));
  }
  assert.equal(validateEvaluation({ account, question: 'pelican' }).model, 'gpt-6-astra');
});

test('grading requires the final answer and leaves valid HTML for human review', () => {
  assert.equal(gradeEvaluation('candy', '考虑 21 种情况\n答案：22').status, 'wrong_answer');
  assert.equal(gradeEvaluation('candy', '可能是21').status, 'invalid_format');
  assert.equal(gradeEvaluation('pelican', '<html><svg></svg></html>').status, 'manual_review');
  assert.equal(gradeEvaluation('pelican', '<svg>').status, 'invalid_format');
});

test('stream parser rejects truncated and failed streams without grading partial answers', () => {
  assert.throws(() => parseEvaluationResponse('data: {"type":"response.output_text.delta","delta":"答案：21"}\n\n'), /未完成/);
  for (const type of ['error', 'response.failed', 'response.incomplete']) {
    assert.throws(() => parseEvaluationResponse(`data: ${JSON.stringify({ type })}\n\n`), /不完整/);
  }
  assert.equal(parseEvaluationResponse(JSON.stringify(completed('答案：21'))), '答案：21');
});

test('invalid credentials, question and model are rejected before any request', () => {
  for (const body of [{ account, question: '__proto__' }, { account, question: 'candy', model: '' },
    { account: { accessToken: 'x\r\ny' }, question: 'candy' }, { question: 'candy' }]) {
    assert.throws(() => validateEvaluation(body), { statusCode: 400 });
  }
});

test('upstream failure does not reflect response contents or credentials', async () => {
  await assert.rejects(evaluateModel({ account, question: 'candy' }, {
    fetchImpl: async () => new Response('fixture-token secret', { status: 401 }),
  }), { message: '模型请求失败（HTTP 401）' });
});

test('free accounts are rejected before model requests while API mode stays independent', async () => {
  for (const plan of [{ planType: 'free' }, { planType: ' FREE ' }, { plan_type: 'free' }]) {
    await assert.rejects(evaluateModel({ account: { ...account, ...plan }, question: 'candy' }, {
      fetchImpl: () => assert.fail('free account must not send a model request'),
    }), { statusCode: 400, message: 'free 账号不参与模型测试' });
  }
  for (const planType of ['plus', 'pro', 'business', 'team', 'enterprise', '']) {
    assert.equal(validateEvaluation({ account: { ...account, planType }, question: 'candy' }).account.planType, planType);
  }
  assert.equal(validateEvaluation({ account: { ...account, planType: 'free' },
    api: { baseUrl: 'https://example.com', protocol: 'responses', key: 'fixture' }, question: 'candy' }).account, undefined);
});

test('API endpoints normalize base and full URLs without forwarding account credentials', async () => {
  for (const [baseUrl, protocol, expected] of [
    ['https://example.com', 'responses', 'https://example.com/v1/responses'],
    ['https://example.com/v1/', 'chat', 'https://example.com/v1/chat/completions'],
    ['http://localhost:8888/v1/responses', 'chat', 'http://localhost:8888/v1/chat/completions'],
    ['https://example.com/custom/v2/chat/completions', 'responses', 'https://example.com/custom/v2/responses'],
  ]) {
    await evaluateModel({ account, api: { baseUrl, protocol, key: 'api-fixture' }, question: 'candy' }, {
      fetchImpl: async (url, init) => {
        assert.equal(url, expected);
        assert.equal(init.headers.Authorization, 'Bearer api-fixture');
        assert.equal(init.headers['ChatGPT-Account-Id'], undefined);
        assert.equal(init.redirect, 'manual');
        const payload = JSON.parse(init.body);
        if (protocol === 'chat') assert.match(payload.messages[0].content, /馒头/);
        const result = protocol === 'chat' ? { choices: [{ finish_reason: 'stop', message: { content: '答案：21' } }] } : completed('答案：21');
        return Response.json(result);
      },
    });
  }
  for (const baseUrl of ['file:///secret', 'https://user:pass@example.com', 'https://example.com?key=secret', 'https://example.com/#hash']) {
    assert.throws(() => validateEvaluation({ api: { baseUrl, protocol: 'responses', key: 'test' }, question: 'candy' }), { statusCode: 400 });
  }
});

test('Responses emits partial text before completion and records first output/usage', async () => {
  let upstream, sawPartial;
  const partial = new Promise(resolve => { sawPartial = resolve; });
  const encoder = new TextEncoder();
  const send = event => upstream.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  const events = [];
  const running = evaluateModel({ account, question: 'pelican' }, {
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) { upstream = controller; } }), { headers: { 'content-type': 'text/event-stream' } }),
    onEvent: event => { events.push(event); if (event.type === 'delta') sawPartial(); },
  });
  send({ type: 'response.output_text.delta', delta: '<html><svg>鹈鹕' });
  await partial;
  assert.ok(events.find(event => event.type === 'delta').firstTokenMs >= 0);
  assert.ok(!events.some(event => event.type === 'complete'));
  send({ type: 'response.completed', response: { ...completed('<html><svg>鹈鹕</svg></html>'), usage: { output_tokens: 32 } } });
  upstream.close();
  const result = await running;
  assert.equal(result.status, 'manual_review');
  assert.equal(result.output, '<html><svg>鹈鹕</svg></html>');
  assert.equal(result.outputTokens, 32);
});

test('Chat streaming requires a stop finish and retains emitted partial content on failure', async () => {
  const body = { api: { baseUrl: 'http://localhost:8888/v1', key: 'fixture', protocol: 'chat' }, question: 'candy' };
  for (const finish of ['stop', 'length', null]) {
    const events = [];
    const stream = [{ choices: [{ index: 0, delta: { content: '答案：21' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { completion_tokens: 10 } }];
    const pending = evaluateModel(body, { fetchImpl: async () => new Response(stream.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'), onEvent: event => events.push(event) });
    if (finish === 'stop') assert.equal((await pending).outputTokens, 10);
    else await assert.rejects(pending, /模型/);
    assert.equal(events.find(event => event.type === 'delta').delta, '答案：21');
  }
});

test('SSE parser handles split UTF-8, CRLF, comments and multiline frames', async () => {
  const bytes = new TextEncoder().encode(': ping\r\ndata: {"type": "delta",\r\ndata: "delta": "鹈鹕"}\r\n\r\ndata: [DONE]\r\n\r\n');
  let cursor = 0;
  const events = [];
  await readEvaluationEvents(new ReadableStream({ pull(controller) {
    if (cursor === bytes.length) return controller.close();
    controller.enqueue(bytes.slice(cursor, ++cursor));
  } }), event => events.push(event));
  assert.deepEqual(events, [{ type: 'delta', delta: '鹈鹕' }, { type: 'done' }]);
});
