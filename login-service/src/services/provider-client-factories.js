import { SmsBowerClient } from '../../lib/smsbower.js';
import { ManualSmsClient } from '../../lib/manual-sms.js';
import { createYesCaptchaSolver } from '../../lib/yescaptcha.js';

export function createSmsProviderClient(settings = {}, ClientClass = SmsBowerClient) {
  const provider = String(settings.provider || settings.smsProvider || 'smsbower').trim().toLowerCase();
  if (provider === 'manual_sms') {
    const apiKey = String(settings.manualApiKey || settings.manual_api_key || settings.apiKey || settings.api_key || '').trim();
    if (!apiKey) return null;
    const baseUrl = String(settings.manualApiBaseUrl || settings.manual_api_base_url || settings.apiBaseUrl || settings.api_base_url || '').trim();
    return new ManualSmsClient({ apiKey, baseUrl });
  }
  const apiKey = String(settings.smsbowerApiKey || settings.smsbower_api_key || settings.apiKey || settings.api_key || '').trim();
  if (!apiKey) return null;
  const baseUrl = String(settings.smsbowerApiBaseUrl || settings.smsbower_api_base_url || settings.apiBaseUrl || settings.api_base_url || '').trim();
  return new ClientClass({ apiKey, baseUrl: baseUrl || undefined });
}

export function createCaptchaProviderClient(settings = {}, solverFactory = createYesCaptchaSolver) {
  return solverFactory({
    apiKey: settings.apiKey,
    endpoint: settings.endpoint,
    timeoutMs: settings.timeoutMs,
    pollIntervalMs: settings.pollIntervalMs,
  });
}
