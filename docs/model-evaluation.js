import { readEvaluationEvents } from './evaluation-stream.js';
import { evaluationPreviewDocument } from './evaluation-preview.js';

const TITLES = { candy: '糖果题', pelican: '鹈鹕骑自行车' };
const STATUS = { queued: '排队中', connecting: '连接模型', waiting: '等待首字', generating: '生成中', passed: '答案正确（21）', wrong_answer: '答案错误', invalid_format: '格式不完整', manual_review: '待人工评审', error: '请求失败', cancelled: '已停止' };
const ACTIVE = ['queued', 'connecting', 'waiting', 'generating'];
const seconds = ms => ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`;

export function initializeModelEvaluation({ request, getEligibility, getHeaders, isWorkspaceCurrent, onImport, getConcurrency }) {
  const panel = document.querySelector('#model-evaluation');
  if (!panel) return { reset() {}, refresh() {} };
  const find = id => panel.querySelector(`#evaluation-${id}`);
  const start = panel.querySelector('[data-evaluation-start]'), stop = panel.querySelector('[data-evaluation-stop]');
  const results = panel.querySelector('[data-evaluation-results]');
  const status = find('status'), model = find('model'), fields = find('fields');
  const frame = find('preview-frame'), dialog = find('preview-dialog'), largeFrame = find('large-frame');
  let controller, timer, generation = 0, jobs = [], selected = -1;
  let lastPreview = '', lastPreviewAt = 0, previewTimer, previewJob = null;
  let paused = false, rawOutput = false, importing = false;
  const markdown = window.markdownit({ html: false, breaks: true, linkify: false });
  markdown.disable('image');
  const importDialog = find('import-dialog');
  const mode = () => panel.querySelector('input[name="evaluation-source"]:checked').value;
  const currentJob = () => jobs[selected];
  const resize = () => {
    panel.style.setProperty('--evaluation-top', `${document.querySelector('.topbar').getBoundingClientRect().height}px`);
    for (const element of [frame, largeFrame]) {
      const area = element.parentElement;
      element.style.transform = `translate(-50%, -50%) scale(${Math.min(area.clientWidth / 1024, area.clientHeight / 768)})`;
    }
  };
  const observer = new ResizeObserver(resize);
  observer.observe(frame.parentElement);
  observer.observe(largeFrame.parentElement);
  observer.observe(document.querySelector('.topbar'));

  function refresh() {
    const eligibility = getEligibility();
    find('account-count').textContent = eligibility.pending ? `正在测活 ${eligibility.total} 个账号…`
      : `${eligibility.accounts.length} 个可测试账号 / ${eligibility.total} 个导入账号${eligibility.skippedFree ? ` · 已跳过 ${eligibility.skippedFree} 个 free 账号` : ''}`;
    const apiMode = mode() === 'api';
    find('accounts-source').hidden = apiMode;
    find('api-source').hidden = !apiMode;
    start.disabled = Boolean(controller) || (!apiMode && !eligibility.accounts.length);
    fields.disabled = Boolean(controller);
    stop.disabled = !controller;
    const concurrency = getConcurrency();
    find('concurrency').textContent = Number.isInteger(concurrency) ? `服务端并发：${concurrency}` : '正在加载服务端并发配置';
    if (!Number.isInteger(concurrency) || concurrency < 1) start.disabled = true;
  }

  function chooseView(view) {
    for (const name of ['preview', 'output']) {
      find(`${name}-tab`).setAttribute('aria-selected', String(name === view));
      find(`${name}-tab`).tabIndex = name === view ? 0 : -1;
      find(`${name}-pane`).hidden = name !== view;
    }
    resize();
  }

  function renderPreview(force = false) {
    clearTimeout(previewTimer);
    const job = currentJob();
    const html = job?.question === 'pelican' && /<(?:svg|html|body)\b/i.test(job.output) ? job.output : '';
    find('preview-empty').hidden = Boolean(html);
    frame.hidden = !html;
    find('enlarge').disabled = !html;
    find('pause').disabled = !html;
    find('preview-hit').disabled = !html;
    if (!html) { frame.removeAttribute('srcdoc'); lastPreview = ''; previewJob = null; return; }
    if (html === lastPreview && job === previewJob) return;
    // Give CSS/SMIL animations time to play between document snapshots.
    const wait = 1500 - (Date.now() - lastPreviewAt);
    if (!force && job === previewJob && wait > 0) {
      previewTimer = setTimeout(() => renderPreview(true), wait);
      return;
    }
    lastPreviewAt = Date.now(); lastPreview = html; previewJob = job;
    const safe = evaluationPreviewDocument(html, { paused });
    frame.srcdoc = safe;
    if (dialog.open) largeFrame.srcdoc = safe;
    resize();
  }

  function renderMetrics() {
    const job = currentJob();
    find('elapsed').textContent = job?.startedAt ? seconds(ACTIVE.includes(job.status) ? Date.now() - job.startedAt : job.durationMs) : '—';
    find('first-token').textContent = seconds(job?.firstTokenMs);
    find('chars').textContent = `${job?.output.length || 0} 字符`;
    find('tokens').textContent = job?.outputTokens ?? '—';
    find('compact-metrics').textContent = job ? `${find('elapsed').textContent} · ${job.output.length} 字符` : '';
  }

  function renderSelected(force = false) {
    const job = currentJob();
    find('case-title').textContent = job ? TITLES[job.question] : '鹈鹕骑自行车';
    find('case-target').textContent = job ? `${job.label} · ${job.model}` : '生成内容将在这里逐步呈现';
    find('case-status').textContent = job ? STATUS[job.status] : '等待开始';
    find('case-status').dataset.state = job?.status || '';
    const phaseIndex = job ? (ACTIVE.includes(job.status) ? ACTIVE.indexOf(job.status) : ['cancelled', 'error'].includes(job.status) ? -1 : 4) : -1;
    panel.querySelectorAll('[data-phase]').forEach((node, index) => {
      node.dataset.done = String(phaseIndex >= index);
      if (phaseIndex === index) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
    });
    const output = find('output');
    const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 60;
    const text = job?.output || (job && ACTIVE.includes(job.status) ? '等待模型输出…' : '模型输出将在这里逐步显示。');
    output.classList.toggle('is-source', rawOutput || job?.question === 'pelican');
    if (rawOutput || job?.question === 'pelican') output.textContent = text;
    else output.innerHTML = markdown.render(text);
    for (const link of output.querySelectorAll('a')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    if (follow) output.scrollTop = output.scrollHeight;
    find('case-error').hidden = !job?.error;
    find('case-error').textContent = job?.error || '';
    find('output-note').textContent = ['cancelled', 'error'].includes(job?.status)
      ? '已保留收到的部分内容；当前预览可能不完整。'
      : job?.question === 'candy' ? '糖果题沿用参考项目的摸馒头题。预期答案：21；以最后一行答案判分。'
        : job && ACTIVE.includes(job.status) ? '正在生成，画面约每 1.5 秒更新一次。未闭合的图形会随后续内容逐步补全。'
          : '鹈鹕题保留 CSS / SVG 动画，完成后由你评审画面质量。';
    find('preview-tab').disabled = job?.question === 'candy';
    renderMetrics(); renderPreview(force);
  }

  function updateJob(job) {
    job.button.dataset.state = job.status;
    job.stateLabel.textContent = `${STATUS[job.status]}${job.output ? ` · ${job.output.length} 字符` : ''}`;
    job.option.textContent = `${TITLES[job.question]} · ${job.label} · ${STATUS[job.status]}`;
    if (job === currentJob()) renderSelected(!ACTIVE.includes(job.status));
    const done = jobs.filter(item => !ACTIVE.includes(item.status)).length;
    find('progress').max = jobs.length || 1; find('progress').value = done;
    find('progress-count').textContent = `${done} / ${jobs.length}`;
  }

  function selectJob(index) {
    selected = index;
    find('task-select').value = String(index);
    jobs.forEach((job, i) => job.button.setAttribute('aria-pressed', String(i === selected)));
    chooseView(currentJob()?.question === 'candy' ? 'output' : 'preview');
    renderSelected(true);
  }

  function reset() {
    generation++; controller?.abort(); controller = null;
    clearInterval(timer); clearTimeout(previewTimer);
    jobs = []; selected = -1; lastPreview = ''; previewJob = null;
    find('task-select').replaceChildren(); find('task-select').hidden = true;
    results.replaceChildren();
    const empty = document.createElement('p'); empty.className = 'evaluation-queue-empty'; empty.textContent = '开始后，点击任务查看生成过程。'; results.append(empty);
    find('queue-count').textContent = '0 项'; find('progress-count').textContent = '0 / 0'; find('progress').value = 0;
    status.textContent = '准备就绪，选择测试来源后开始。';
    find('api-key').value = '';
    if (dialog.open) dialog.close(); largeFrame.removeAttribute('srcdoc');
    paused = false; syncPause();
    find('import-text').value = ''; find('import-files').value = '';
    if (importDialog.open) importDialog.close();
    chooseView('preview'); renderSelected(true); refresh();
  }

  find('import').addEventListener('click', () => { find('import-status').textContent = ''; importDialog.showModal(); });
  find('task-select').addEventListener('change', event => selectJob(Number(event.target.value)));
  find('import-close').addEventListener('click', () => importDialog.close());
  find('import-form').addEventListener('submit', async event => {
    event.preventDefault(); if (importing) return;
    importing = true; find('import-submit').disabled = true;
    const isCurrent = isWorkspaceCurrent();
    try {
      const chunks = [find('import-text').value.trim()];
      for (const file of find('import-files').files) {
        if (file.size > 12 * 1024 * 1024) throw new Error('单个文件不能超过 12 MB。');
        chunks.push(await file.text());
      }
      if (!isCurrent()) return;
      const text = chunks.filter(Boolean).join('\n');
      if (!text) throw new Error('请粘贴账号内容或选择文件。');
      if (new TextEncoder().encode(text).length > 12 * 1024 * 1024) throw new Error('本次导入的总内容不能超过 12 MB。');
      const result = await onImport(text);
      if (!isCurrent()) return;
      status.textContent = `已导入 ${result.count} 个账号${result.skipped ? `，跳过 ${result.skipped} 项` : ''}，正在测活。`;
      importDialog.close();
      refresh();
    } catch (error) { if (isCurrent()) find('import-status').textContent = error.message; }
    finally { importing = false; find('import-submit').disabled = false; }
  });
  find('raw').addEventListener('click', () => {
    rawOutput = !rawOutput; find('raw').setAttribute('aria-pressed', String(rawOutput));
    find('raw').textContent = rawOutput ? 'Markdown 排版' : '查看原文'; chooseView('output'); renderSelected();
  });
  function syncPause() {
    for (const name of ['pause', 'large-pause']) { find(name).textContent = paused ? '继续动画' : '暂停动画'; find(name).setAttribute('aria-pressed', String(paused)); }
    for (const target of [frame, largeFrame]) target.contentWindow?.postMessage({ type: 'evaluation-animation', paused }, '*');
  }
  for (const name of ['pause', 'large-pause']) find(name).addEventListener('click', () => { paused = !paused; syncPause(); });
  for (const target of [frame, largeFrame]) target.addEventListener('load', syncPause);
  panel.querySelectorAll('input[name="evaluation-source"]').forEach(input => input.addEventListener('change', refresh));
  for (const name of ['preview', 'output']) {
    find(`${name}-tab`).addEventListener('click', () => chooseView(name));
    find(`${name}-tab`).addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = name === 'preview' ? 'output' : 'preview';
      if (find(`${next}-tab`).disabled) return;
      chooseView(next); find(`${next}-tab`).focus();
    });
  }
  const enlarge = () => { largeFrame.srcdoc = evaluationPreviewDocument(currentJob().output, { paused }); dialog.showModal(); resize(); };
  find('enlarge').addEventListener('click', enlarge);
  find('preview-hit').addEventListener('click', enlarge);
  find('close-preview').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => largeFrame.removeAttribute('srcdoc'));
  stop.addEventListener('click', () => { controller?.abort(); stop.disabled = true; status.textContent = '正在停止，保留已生成内容…'; });

  find('form').addEventListener('submit', async event => {
    event.preventDefault(); if (controller) return;
    const concurrency = getConcurrency();
    if (!Number.isInteger(concurrency) || concurrency < 1) { status.textContent = '服务端并发配置尚未加载，请刷新页面后重试。'; return; }
    const questions = find('include-pelican').checked ? ['candy', 'pelican'] : ['candy'];
    const chosenModel = model.value.trim();
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(chosenModel)) { status.textContent = '请选择或输入有效模型名称。'; return; }
    const apiMode = mode() === 'api';
    const api = apiMode ? { baseUrl: find('api-url').value.trim(), key: find('api-key').value.trim(), protocol: find('protocol').value } : null;
    if (apiMode) {
      try { const url = new URL(api.baseUrl); if (!['http:', 'https:'].includes(url.protocol) || !api.key || url.username || url.password || url.hash || url.search) throw new Error(); }
      catch { status.textContent = '请填写有效的 HTTP(S) API 地址和 API Key。'; return; }
    }
    const accounts = apiMode ? [null] : [...getEligibility().accounts];
    if (!accounts.length) { status.textContent = '没有可测试账号：仅测试测活通过的非 free 账号，请导入账号或重新测活。'; return; }
    const current = new AbortController(); controller = current;
    const run = ++generation, ownsWorkspace = isWorkspaceCurrent();
    const active = () => run === generation && ownsWorkspace() && !current.signal.aborted;
    results.replaceChildren(); clearTimeout(previewTimer);
    jobs = accounts.flatMap((account, index) => questions.map(question => {
      const label = apiMode ? new URL(api.baseUrl).host : account.email || `账号 ${index + 1}`;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'evaluation-task';
      const title = document.createElement('strong'); title.textContent = TITLES[question];
      const target = document.createElement('small'); target.textContent = label; target.title = label;
      const stateLabel = document.createElement('span'); stateLabel.className = 'evaluation-task-status'; stateLabel.textContent = '排队中';
      button.append(title, target, stateLabel); results.append(button);
      return { account, question, label, model: chosenModel, status: 'queued', output: '', firstTokenMs: null, button, stateLabel };
    }));
    find('task-select').replaceChildren(); find('task-select').hidden = false;
    jobs.forEach((job, index) => {
      job.button.addEventListener('click', () => selectJob(index));
      job.option = document.createElement('option'); job.option.value = String(index); find('task-select').append(job.option);
    });
    find('queue-count').textContent = `${jobs.length} 项`;
    selectJob(questions.includes('pelican') ? 1 : 0); jobs.forEach(updateJob); refresh();
    status.textContent = `正在测试 ${accounts.length} 个${apiMode ? 'API 接入' : '测活通过的账号'}，服务端配置并发 ${concurrency}。`;
    timer = setInterval(renderMetrics, 500);
    let cursor = 0;
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
        while (cursor < jobs.length && active()) {
          const job = jobs[cursor++]; job.status = 'connecting'; job.startedAt = Date.now(); updateJob(job);
          let complete = false;
          try {
            const response = await request('/api/model-evaluation', { method: 'POST', credentials: 'same-origin', signal: current.signal,
              headers: getHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
              body: JSON.stringify({ ...(apiMode ? { api } : { account: job.account }), model: chosenModel, question: job.question }) });
            if (!response.ok) {
              const error = await response.json().catch(() => ({}));
              throw new Error(typeof error.error === 'string' ? error.error : `HTTP ${response.status}`);
            }
            await readEvaluationEvents(response.body, data => {
              if (!active()) return;
              if (data.type === 'phase' && ACTIVE.includes(data.phase)) job.status = data.phase;
              if (data.type === 'delta') { job.status = 'generating'; job.output += data.delta || ''; job.firstTokenMs ??= data.firstTokenMs ?? Date.now() - job.startedAt; }
              if (data.type === 'complete') {
                if (!['passed', 'wrong_answer', 'invalid_format', 'manual_review'].includes(data.status)) throw new Error('测试结果状态无效');
                Object.assign(job, { status: data.status, output: data.output || job.output, firstTokenMs: data.firstTokenMs ?? job.firstTokenMs, durationMs: data.durationMs, outputTokens: data.outputTokens });
                complete = true;
              }
              if (data.type === 'error') throw new Error(data.error || '模型请求失败');
              updateJob(job);
            });
            if (!complete && active()) throw new Error('连接已结束，但模型未完成输出。已保留部分内容。');
          } catch (error) {
            if (run !== generation || !ownsWorkspace()) return;
            job.status = current.signal.aborted ? 'cancelled' : 'error'; job.error = current.signal.aborted ? '' : error.message;
            job.durationMs = Date.now() - job.startedAt; updateJob(job);
          } finally { job.account = null; }
        }
      }));
    } finally {
      if (run === generation) {
        clearInterval(timer);
        jobs.forEach(job => {
          if (ACTIVE.includes(job.status)) { job.status = 'cancelled'; job.durationMs = job.startedAt ? Date.now() - job.startedAt : 0; }
          job.account = null; updateJob(job);
        });
        const count = state => jobs.filter(job => job.status === state).length;
        status.textContent = `${current.signal.aborted ? '已停止' : '测试完成'}：答案正确 ${count('passed')}，待评审 ${count('manual_review')}，失败 ${count('error') + count('wrong_answer') + count('invalid_format')}${count('cancelled') ? `，已停止 ${count('cancelled')}` : ''}。`;
        controller = null; refresh(); renderSelected(true);
      }
    }
  });
  refresh();
  return { reset, refresh };
}
