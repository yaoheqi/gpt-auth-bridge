import { createProxiedFetch, resolveSessionProxy } from '../login-service/lib/proxy-config.js';
import { runAccountTask } from '../login-service/lib/task-concurrency.js';
import { readEvaluationEvents } from '../docs/evaluation-stream.js';

export const EVALUATION_QUESTIONS = {
  candy: '在一个黑色的袋子里放有三种口味的馒头，每种馒头有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。数量如下：\n形状 | 苹果味 | 桃子味 | 西瓜味\n圆形 | 7 | 9 | 8\n五角星形 | 7 | 6 | 4\n参赛者需要在活动前决定摸出的馒头数目，那么最少取出多少个才能保证手中同时拥有不同形状的苹果味和桃子味馒头？圆形苹果配五角星桃子，或者圆形桃子配五角星苹果，都满足要求。帮我做一下，不调用任何工具、不联网、不要读取本地文件。请解释理由，最后单独一行写“答案：数字”。',
  pelican: '创建一个HTML，内容是用SVG绘制一个鹈鹕骑自行车的2D动画，你不能进行任何测试，不能调用skills，不能网络检索，不能调用子智能体，直接生成。\n只输出一个可独立打开的完整HTML文件，不要解释或Markdown围栏。用内联SVG和CSS/SMIL实现循环动画，保留可辨认的鹈鹕、大嘴、双轮自行车和踩踏动作。代码尽量控制在120行、6000字符以内，使用defs/use复用图形，避免复杂背景、装饰和重复路径；无需JavaScript和外部资源。',
};

export function validateEvaluation(body = {}) {
  const { account, api, question, model = 'gpt-6-astra' } = body || {};
  if (!Object.hasOwn(EVALUATION_QUESTIONS, question) || typeof model !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(model)
    || (!api && (typeof account?.accessToken !== 'string' || !account.accessToken.trim() || account.accessToken.length > 32768 || /[\r\n]/.test(account.accessToken)
    || (account.accountId != null && (typeof account.accountId !== 'string' || account.accountId.length > 200 || /[\r\n]/.test(account.accountId)))))) {
    throw Object.assign(new Error('请提供有效账号、模型和测试题'), { statusCode: 400 });
  }
  if (api) {
    let endpoint;
    try {
      if (typeof api.baseUrl !== 'string' || api.baseUrl.length > 2048 || typeof api.key !== 'string' || !api.key.trim()
        || api.key.length > 32768 || /[\r\n]/.test(api.key) || !['responses', 'chat'].includes(api.protocol)) throw new Error();
      endpoint = new URL(api.baseUrl.trim());
      if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
      let path = endpoint.pathname.replace(/\/+$/, '').replace(/\/(?:responses|chat\/completions)$/, '');
      if (!path) path = '/v1';
      endpoint.pathname = `${path}/${api.protocol === 'chat' ? 'chat/completions' : 'responses'}`;
    } catch {
      throw Object.assign(new Error('请提供有效的 HTTP(S) API 地址、Key 和接口类型'), { statusCode: 400 });
    }
    return { question, model, endpoint: endpoint.href, key: api.key.trim(), protocol: api.protocol };
  }
  if (String(account.planType || account.plan_type || '').trim().toLowerCase() === 'free') {
    throw Object.assign(new Error('free 账号不参与模型测试'), { statusCode: 400 });
  }
  return { account, question, model, endpoint: 'https://chatgpt.com/backend-api/codex/responses', key: account.accessToken.trim(), protocol: 'responses' };
}

export function parseEvaluationResponse(text) {
  let completed;
  let deltas = '';
  if (text.trim().startsWith('{')) {
    completed = JSON.parse(text);
  } else {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      const event = JSON.parse(data);
      if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new Error('模型返回失败或不完整的结果');
      if (event.type === 'response.output_text.delta') deltas += event.delta || '';
      if (event.type === 'response.completed') completed = event.response;
    }
  }
  if (!completed || completed.error || completed.status && completed.status !== 'completed') throw new Error('模型响应未完成');
  const output = (completed.output || []).flatMap(item => item.type === 'message' ? item.content || [] : [])
    .filter(item => item.type === 'output_text').map(item => item.text || '').join('') || completed.output_text || deltas;
  if (!output.trim()) throw new Error('模型未返回文本');
  return output;
}

export function gradeEvaluation(question, output) {
  if (question === 'candy') {
    const answer = output.trim().match(/(?:^|\n)\s*(?:\*\*)?答案\s*[:：]\s*(\d+)(?:\*\*)?\s*[。.]?\s*$/)?.[1];
    return { status: answer ? (answer === '21' ? 'passed' : 'wrong_answer') : 'invalid_format', answer: answer || '' };
  }
  const html = output.trim().replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/, '');
  return { status: /<html\b/i.test(html) && /<\/html>/i.test(html) && /<svg\b/i.test(html) ? 'manual_review' : 'invalid_format', html };
}

export async function evaluateModel(body, { signal, fetchImpl, onEvent = () => {} } = {}) {
  const { account, question, model, endpoint, key, protocol } = validateEvaluation(body);
  const started = Date.now();
  onEvent({ type: 'phase', phase: 'queued' });
  const run = async fetchImpl => {
    onEvent({ type: 'phase', phase: 'connecting' });
    const requestBody = protocol === 'chat'
      ? { model, stream: true, messages: [{ role: 'user', content: EVALUATION_QUESTIONS[question] }] }
      : { model, stream: true, store: false, instructions: "Follow the user's request. No tools are available.",
        input: [{ role: 'user', content: [{ type: 'input_text', text: EVALUATION_QUESTIONS[question] }] }], reasoning: { effort: 'medium' } };
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'manual',
      signal: AbortSignal.any([AbortSignal.timeout(150_000), signal].filter(Boolean)),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream',
        ...(account?.accountId ? { 'ChatGPT-Account-Id': account.accountId } : {}) },
      body: JSON.stringify(requestBody),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`模型请求失败（HTTP ${response.status}）`); }
    onEvent({ type: 'phase', phase: 'waiting' });
    let output = '', completed = false, firstTokenMs = null, usage = null;
    const append = delta => {
      if (typeof delta !== 'string' || !delta) return;
      output += delta;
      if (output.length > 256 * 1024) throw new Error('模型输出过大');
      firstTokenMs ??= Date.now() - started;
      onEvent({ type: 'delta', delta, firstTokenMs, durationMs: Date.now() - started });
    };
    if (response.headers.get('content-type')?.includes('application/json')) {
      const text = await response.text();
      if (text.length > 1024 * 1024) throw new Error('模型响应过大');
      const data = JSON.parse(text);
      if (protocol === 'chat') {
        if (data.error || data.choices?.[0]?.finish_reason !== 'stop') throw new Error('模型响应未完成');
        append(data.choices[0].message?.content);
      } else append(parseEvaluationResponse(text));
      completed = true;
      usage = data.usage;
    } else {
      await readEvaluationEvents(response.body, event => {
        if (event.error || ['error', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(event.type)) throw new Error('模型返回失败或不完整的结果');
        if (event.type === 'response.output_text.delta') append(event.delta);
        if (['response.completed', 'response.done'].includes(event.type)) {
          const canonical = parseEvaluationResponse(JSON.stringify(event.response));
          if (!output) append(canonical);
          output = canonical;
          completed = true;
          usage = event.response?.usage;
        }
        if (protocol === 'chat') {
          const choice = event.choices?.find(item => item.index === 0) || event.choices?.[0];
          append(choice?.delta?.content);
          if (choice?.finish_reason) {
            if (choice.finish_reason !== 'stop') throw new Error('模型返回失败或不完整的结果');
            completed = true;
          }
          if (event.usage) usage = event.usage;
        }
      });
    }
    if (!completed || !output.trim()) throw new Error('模型响应未完成');
    return { model, question, output, ...gradeEvaluation(question, output), firstTokenMs,
      outputChars: output.length, outputTokens: usage?.output_tokens ?? usage?.completion_tokens ?? null, durationMs: Date.now() - started };
  };
  if (fetchImpl) return run(fetchImpl);
  return runAccountTask(async () => {
    const transport = createProxiedFetch(resolveSessionProxy().proxyUrl);
    try { return await run(transport); }
    finally { await transport.dispose(); }
  }, { signal });
}
