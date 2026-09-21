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

export class YesCaptchaError extends Error {
  constructor(message, code = '', detail = null) {
    super(message);
    this.name = 'YesCaptchaError';
    this.code = code;
    this.detail = detail;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class YesCaptchaSolver {
  constructor({
    apiKey = '',
    endpoint = 'https://api.yescaptcha.com',
    timeoutMs = 120000,
    pollIntervalMs = 3000,
  } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.endpoint = String(endpoint || 'https://api.yescaptcha.com').replace(/\/$/, '');
    this.timeoutMs = Math.max(10000, Number(timeoutMs) || 120000);
    this.pollIntervalMs = Math.max(1000, Number(pollIntervalMs) || 3000);
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  async createTask(task) {
    if (!this.apiKey) throw new YesCaptchaError('未配置 YESCAPTCHA_API_KEY', 'NO_KEY');
    const response = await fetch(`${this.endpoint}/createTask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientKey: this.apiKey,
        task,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || Number(data.errorId || 0) !== 0) {
      throw new YesCaptchaError(
        `YesCaptcha createTask 失败: ${data.errorCode || response.status} ${data.errorDescription || ''}`.trim(),
        String(data.errorCode || response.status || 'CREATE_FAILED'),
        data,
      );
    }
    const taskId = data.taskId;
    if (!taskId) throw new YesCaptchaError('YesCaptcha createTask 未返回 taskId', 'NO_TASK_ID', data);
    return String(taskId);
  }

  async getTaskResult(taskId) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const response = await fetch(`${this.endpoint}/getTaskResult`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientKey: this.apiKey,
          taskId,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || Number(data.errorId || 0) !== 0) {
        throw new YesCaptchaError(
          `YesCaptcha getTaskResult 失败: ${data.errorCode || response.status} ${data.errorDescription || ''}`.trim(),
          String(data.errorCode || response.status || 'RESULT_FAILED'),
          data,
        );
      }
      if (data.status === 'ready') return data;
      if (data.status === 'processing') {
        await sleep(this.pollIntervalMs);
        continue;
      }
      throw new YesCaptchaError(`YesCaptcha 未知状态: ${data.status}`, 'BAD_STATUS', data);
    }
    throw new YesCaptchaError(`YesCaptcha 任务超时（${this.timeoutMs}ms）: ${taskId}`, 'TIMEOUT');
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
  async solveTurnstile({ websiteUrl, websiteKey, premium = true } = {}) {
    const url = String(websiteUrl || '').trim();
    const key = String(websiteKey || '').trim();
    if (!url) throw new YesCaptchaError('Turnstile websiteURL 为空', 'NO_WEBSITE_URL');
    if (!key) throw new YesCaptchaError('Turnstile websiteKey 为空', 'NO_WEBSITE_KEY');

    const taskType = premium ? 'TurnstileTaskProxylessM1' : 'TurnstileTaskProxyless';
    const taskId = await this.createTask({
      type: taskType,
      websiteURL: url,
      websiteKey: key,
    });
    const result = await this.getTaskResult(taskId);
    const token = String(result?.solution?.token || '').trim();
    if (!token) throw new YesCaptchaError('YesCaptcha 未返回 Turnstile token', 'NO_TOKEN', result);
    return token;
  }
}

export function createYesCaptchaSolver(settings = {}) {
  return new YesCaptchaSolver(settings);
}
