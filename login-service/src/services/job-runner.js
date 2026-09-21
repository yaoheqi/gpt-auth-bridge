import { sanitizeLogMessage } from '../../lib/log-sanitize.js';
import { clampOauthBatchConcurrency, configuredTaskConcurrency } from '../../lib/batch-concurrency.js';
import { runAccountTask } from '../../lib/task-concurrency.js';
import { classifyAuthFailure, retryPolicyForFailure } from '../lib/auth-failure-classifier.js';

export function resolveProtocolLoginConcurrency({
  globalConcurrency,
} = {}) {
  return clampOauthBatchConcurrency(globalConcurrency, configuredTaskConcurrency());
}

function jobConcurrency(manifest, getConcurrency) {
  return typeof getConcurrency === 'function'
    ? clampOauthBatchConcurrency(getConcurrency(manifest.type), configuredTaskConcurrency())
    : configuredTaskConcurrency();
}

function protocolEgressBlockDetail(result) {
  const detail = sanitizeLogMessage(result?.error || result?.detail || '').trim();
  return /PROXY_EDGE_BLOCKED|代理出口被 Cloudflare|Cloudflare\/OpenAI 拦截/i.test(detail) ? detail : '';
}

export function describeProtocolJobEgress(context = {}) {
  if (String(context?.proxyMode || '').toLowerCase() === 'pool' || String(context?.proxyPool || '').trim()) {
    return 'OpenAI 出口使用代理池；协议登录每个账号稳定使用一个代理，邮箱流量保持直连';
  }
  return 'OpenAI 出口使用直连；协议登录可在当前浏览器配置代理池';
}

export class JobRunner {
  constructor({
    jobs,
    resolveAccounts,
    runAccount,
    getConcurrency = null,
    shouldStopOnEgressBlock = null,
    getProtocolEgressContext = null,
    preflightAccount = null,
  }) {
    this.jobs = jobs;
    this.resolveAccounts = resolveAccounts;
    this.runAccount = runAccount;
    this.getConcurrency = getConcurrency;
    this.shouldStopOnEgressBlock = shouldStopOnEgressBlock;
    this.getProtocolEgressContext = getProtocolEgressContext;
    this.preflightAccount = preflightAccount;
    this.active = new Map();
  }
  start(manifest) { if (this.active.has(manifest.jobId)) return this.active.get(manifest.jobId); const work = this.run(manifest).finally(() => this.active.delete(manifest.jobId)); this.active.set(manifest.jobId, work); return work; }
  async run(manifest) {
    const { jobId } = manifest;
    if (manifest?.type === 'protocol-login') {
      const context = typeof this.getProtocolEgressContext === 'function'
        ? this.getProtocolEgressContext(manifest)
        : {};
      const notice = describeProtocolJobEgress(context);
      await this.jobs.log(jobId, notice, 'info');
    }
    const completed = await this.jobs.completedKeys(jobId);
    const accounts = await this.resolveAccounts(manifest);
    let success = 0, failed = 0, skipped = 0, cancelled = false, nextIndex = 0, egressBlock = '';
    const runNext = async () => {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= accounts.length) return false;
      const account = accounts[index];
      const key = String(account.id);
      if (completed.has(key)) { skipped += 1; return true; }
      if (typeof this.preflightAccount === 'function') {
        const preflight = await this.preflightAccount(manifest, account);
        if (preflight && preflight.ok === false) {
          skipped += 1;
          const email = String(account.email || key);
          await this.jobs.progress(jobId, {
            key,
            email,
            status: 'skipped',
            type: manifest.type,
            phase: 'preflight',
            stage: 'preflight',
            message: preflight.blocking?.map?.(item => item.message).join('；') || 'preflight failed',
            failureCategory: 'preflight_failed',
            preflight,
          });
          return true;
        }
      }
      if (egressBlock) {
        skipped += 1;
        const email = String(account.email || key);
        await this.jobs.progress(jobId, {
          key,
          email,
          status: 'skipped',
          type: manifest.type,
          phase: 'blocked',
          message: '当前代理出口已被 Cloudflare/OpenAI 拦截，已停止继续请求；请检查代理池或直连网络',
        });
        return true;
      }
      if (await this.jobs.isCancelled(jobId)) { cancelled = true; return false; }
      if (await this.jobs.isCancelled(jobId)) { cancelled = true; return false; }
      const email = String(account.email || key);
      await this.jobs.progress(jobId, { key, email, status: 'started', type: manifest.type, phase: 'resolve', message: sanitizeLogMessage(`开始处理 ${email}`) });
      let receivedLiveLog = false;
      let liveLogWrites = Promise.resolve();
      const onLog = (entry = {}) => {
        const message = sanitizeLogMessage(entry?.msg || entry?.message || '').trim();
        if (!message) return liveLogWrites;
        receivedLiveLog = true;
        const write = liveLogWrites.then(() => this.jobs.progress(jobId, {
          key,
          email,
          status: 'log',
          type: manifest.type,
          phase: entry?.phase || '',
          level: entry?.level || 'info',
          message,
        }));
        liveLogWrites = write.catch(() => {});
        return liveLogWrites;
      };
      try {
        const result = await this.runAccount(manifest.type, account, manifest.options, { onLog });
        await liveLogWrites;
        if (!receivedLiveLog) {
          for (const entry of (Array.isArray(result?.logs) ? result.logs : []).slice(-40)) {
            const message = sanitizeLogMessage(entry?.msg || entry?.message || '').trim();
            if (message) await this.jobs.progress(jobId, { key, email, status: 'log', type: manifest.type, phase: entry?.phase || '', level: entry?.level || 'info', message });
          }
        }
        const detail = sanitizeLogMessage(result?.error || result?.detail || result?.healthLabel || '').trim();
        if (result?.skipped) {
          skipped += 1;
          await this.jobs.progress(jobId, { key, email, status: 'skipped', type: manifest.type, phase: 'done', health: result?.health, message: detail || '账号不满足执行条件，已跳过' });
        } else if (result?.ok === false) {
          failed += 1;
          const failureCategory = classifyAuthFailure(detail || result?.error || result?.detail || '');
          await this.jobs.progress(jobId, {
            key, email, status: 'failed', type: manifest.type, phase: 'done', health: result?.health,
            sessionOk: result?.sessionOk === true,
            personalOk: result?.personalOk === true,
            businessSuccess: Number(result?.businessSuccess || 0),
            businessErrors: Array.isArray(result?.businessErrors) ? result.businessErrors : [],
            result,
            stage: 'failed',
            failureCategory,
            retryPolicy: retryPolicyForFailure(failureCategory),
            message: detail || '账号操作失败',
          });
          if (
            manifest.type === 'protocol-login'
            && this.shouldStopOnEgressBlock?.(manifest) === true
          ) egressBlock = protocolEgressBlockDetail(result);
        } else {
          success += 1;
          await this.jobs.progress(jobId, {
            key, email, status: 'completed', type: manifest.type, phase: 'done', health: result?.health,
            sessionOk: result?.sessionOk === true,
            personalOk: result?.personalOk === true,
            businessSuccess: Number(result?.businessSuccess || 0),
            businessErrors: Array.isArray(result?.businessErrors) ? result.businessErrors : [],
            result,
            message: detail || '账号操作完成',
          });
        }
      } catch (error) {
        await liveLogWrites;
        failed += 1;
        const message = sanitizeLogMessage(error instanceof Error ? error.message : String(error));
        const failureCategory = classifyAuthFailure(message);
        await this.jobs.progress(jobId, {
          key, email, status: 'failed', type: manifest.type, phase: 'done',
          sessionOk: error?.sessionOk === true,
          personalOk: error?.personalOk === true,
          businessSuccess: Number(error?.businessSuccess || 0),
          businessErrors: Array.isArray(error?.businessErrors) ? error.businessErrors : [],
          stage: 'failed',
          failureCategory,
          retryPolicy: retryPolicyForFailure(failureCategory),
          message: message || '账号操作失败',
        });
        if (
          manifest.type === 'protocol-login'
          && this.shouldStopOnEgressBlock?.(manifest) === true
        ) egressBlock = protocolEgressBlockDetail({ error: message });
      }
      return true;
    };
    const workers = Array.from({ length: Math.min(jobConcurrency(manifest, this.getConcurrency), accounts.length) }, async () => {
      while (await runAccountTask(runNext)) {}
    });
    await Promise.all(workers);
    cancelled ||= await this.jobs.isCancelled(jobId);
    return this.jobs.summarize(jobId, { ok: !failed && !cancelled, status: cancelled ? 'cancelled' : failed ? 'failed' : 'completed', total: accounts.length, success, failed, skipped, cancelled, cancellationSemantics: cancelled ? 'The in-flight account operation was allowed to finish; later accounts were not started.' : undefined });
  }
}

