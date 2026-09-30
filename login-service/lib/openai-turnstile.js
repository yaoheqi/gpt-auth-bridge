import { createYesCaptchaSolver, YesCaptchaError } from './yescaptcha.js';

/**
 * Resolve OpenAI Sentinel Turnstile token (`t` field).
 * Primary path mirrors grok: YesCaptcha TurnstileTaskProxyless(M1).
 */
export async function solveOpenAITurnstileToken(settings = {}, logger = null, { signal, timeoutMs } = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const apiKey = String(settings.apiKey || '').trim();
  const websiteUrl = String(settings.websiteUrl || 'https://auth.openai.com').trim();
  const websiteKey = String(settings.websiteKey || '').trim();
  const premium = settings.premium !== false && settings.premium !== '0' && settings.premium !== 0;
  const endpoint = String(settings.endpoint || 'https://api.yescaptcha.com').trim();

  if (!apiKey) {
    throw new YesCaptchaError(
      'OpenAI 触发 Turnstile，但未配置 YESCAPTCHA_API_KEY。请在管理页或 .env 中填写（参考 grok 项目）',
      'NO_KEY',
    );
  }
  if (!websiteKey) {
    throw new YesCaptchaError(
      'OpenAI 触发 Turnstile，但未配置 OPENAI_TURNSTILE_SITEKEY。请在管理页填写 auth.openai.com 页面的 sitekey',
      'NO_WEBSITE_KEY',
    );
  }

  const solver = createYesCaptchaSolver({
    apiKey,
    endpoint,
    timeoutMs: timeoutMs ?? (Number(settings.timeoutMs || 120000) || 120000),
    pollIntervalMs: Number(settings.pollIntervalMs || 3000) || 3000,
  });

  log(`YesCaptcha 求解 Turnstile（${premium ? 'M1' : '标准'}）: ${websiteUrl}`);
  const token = await solver.solveTurnstile({
    websiteUrl,
    websiteKey,
    premium,
    signal,
    timeoutMs,
  });
  log(`YesCaptcha Turnstile 完成，token 长度 ${token.length}`);
  return token;
}

export { YesCaptchaError };
