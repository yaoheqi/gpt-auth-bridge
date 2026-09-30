/**
 * YesCaptcha Turnstile solver — aligned with grok/xconsole_client/solver.py
 *
 * API:
 *   - International: https://api.yescaptcha.com
 *   - China: https://cn.yescaptcha.com
 *
 * Task types:
 *   - TurnstileTaskProxyless
 *   - TurnstileTaskProxylessM1 (premium)
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { validationDeadline } from './validation-deadline.js';
import { untilAborted } from './execution-limits.js';

export class YesCaptchaError extends Error {
  constructor(message, code = '', detail = null) {
    super(message);
    this.name = 'YesCaptchaError';
    this.code = code;
    this.detail = detail;
  }
}

export class YesCaptchaSolver {
  constructor({
    apiKey = '',
    endpoint = 'https://api.yescaptcha.com',
    timeoutMs = 120000,
    pollIntervalMs = 3000,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.endpoint = String(endpoint || 'https://api.yescaptcha.com').replace(/\/$/, '');
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 120000);
    this.pollIntervalMs = Math.max(1000, Number(pollIntervalMs) || 3000);
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  async request(path, body, signal) {
    signal?.throwIfAborted();
    try {
      const response = await untilAborted(this.fetch(`${this.endpoint}/${path}`, {
        method: 'POST', signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientKey: this.apiKey, ...body }),
      }), signal);
      const data = await untilAborted(response.json().catch(() => ({})), signal);
      return { response, data };
    } catch (error) { signal?.throwIfAborted(); throw error; }
  }

  async createTask(task, { signal } = {}) {
    if (!this.apiKey) throw new YesCaptchaError('未配置 YESCAPTCHA_API_KEY', 'NO_KEY');
    const { response, data } = await this.request('createTask', { task }, signal);
    if (!response.ok || Number(data.errorId || 0) !== 0) {
      throw new YesCaptchaError(
        'YesCaptcha createTask 失败',
        String(data.errorCode || response.status || 'CREATE_FAILED'),
        data,
      );
    }
    const taskId = data.taskId;
    if (!taskId) throw new YesCaptchaError('YesCaptcha createTask 未返回 taskId', 'NO_TASK_ID', data);
    return String(taskId);
  }

  async getTaskResult(taskId, { signal, timeoutMs = this.timeoutMs } = {}) {
    const budget = validationDeadline({ signal, timeoutMs, stage: 'provider' });
    try {
      while (true) {
        budget.remaining();
        const { response, data } = await this.request('getTaskResult', { taskId }, budget.signal);
        if (!response.ok || Number(data.errorId || 0) !== 0) {
          throw new YesCaptchaError(
            'YesCaptcha getTaskResult 失败',
            String(data.errorCode || response.status || 'RESULT_FAILED'),
            data,
          );
        }
        if (data.status === 'ready') return data;
        if (data.status === 'processing') {
          await sleep(Math.min(this.pollIntervalMs, budget.remaining()), undefined, { signal: budget.signal });
          continue;
        }
        throw new YesCaptchaError('YesCaptcha 返回未知状态', 'BAD_STATUS', data);
      }
    } catch (error) { budget.signal.throwIfAborted(); throw error; }
    finally { budget.close(); }
  }

  async getBalance() {
    if (!this.apiKey) throw new YesCaptchaError('未配置 YESCAPTCHA_API_KEY', 'NO_KEY');
    const response = await fetch(`${this.endpoint}/getBalance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientKey: this.apiKey }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || Number(data.errorId || 0) !== 0) {
      throw new YesCaptchaError(
        `YesCaptcha getBalance 失败: ${data.errorCode || response.status} ${data.errorDescription || ''}`.trim(),
        String(data.errorCode || response.status || 'BALANCE_FAILED'),
        data,
      );
    }
    return Number(data.balance || 0);
  }

  /**
   * @param {{ websiteUrl: string, websiteKey: string, premium?: boolean }} options
   * @returns {Promise<string>} Turnstile token
   */
  async solveTurnstile({ websiteUrl, websiteKey, premium = true, signal, timeoutMs = this.timeoutMs } = {}) {
    const url = String(websiteUrl || '').trim();
    const key = String(websiteKey || '').trim();
    if (!url) throw new YesCaptchaError('Turnstile websiteURL 为空', 'NO_WEBSITE_URL');
    if (!key) throw new YesCaptchaError('Turnstile websiteKey 为空', 'NO_WEBSITE_KEY');

    const taskType = premium ? 'TurnstileTaskProxylessM1' : 'TurnstileTaskProxyless';
    const budget = validationDeadline({ signal, timeoutMs, stage: 'provider' });
    try {
      const taskId = await this.createTask({
        type: taskType,
        websiteURL: url,
        websiteKey: key,
      }, { signal: budget.signal });
      const result = await this.getTaskResult(taskId, { signal: budget.signal, timeoutMs: budget.remaining() });
      const token = String(result?.solution?.token || '').trim();
      if (!token) throw new YesCaptchaError('YesCaptcha 未返回 Turnstile token', 'NO_TOKEN', result);
      return token;
    } catch (error) { budget.signal.throwIfAborted(); throw error; }
    finally { budget.close(); }
  }
}

export function createYesCaptchaSolver(settings = {}) {
  return new YesCaptchaSolver(settings);
}
