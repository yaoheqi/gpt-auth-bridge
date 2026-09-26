import { maskPhone as defaultMaskPhone } from '../../domain/accounts/account-domain.js';
import { nowIso as defaultNowIso } from './auth-records.js';

/** Request-owned operations. Configuration and repositories are supplied by the composition root. */
export function createSmsAuthService({
  PHONE_OTP_POLL_INTERVAL_MS,
  PHONE_OTP_WAIT_TIMEOUT_MS,
  accountRepository,
  fetch = globalThis.fetch,
  maskPhone = defaultMaskPhone,
  nowIso = defaultNowIso,
  sleep,
} = {}) {
  function extractPhoneCode(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ');
    const patterns = [
      /OpenAI[^\d]{0,80}(\d{6})/i,
      /验证代码[^\d]{0,20}(\d{6})/,
      /验证码[^\d]{0,20}(\d{6})/,
      /\b(\d{6})\b/,
    ];
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match?.[1]) return match[1];
    }
    return '';
  }

  async function fetchSmsPayload(smsUrl) {
    const url = String(smsUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('该邮箱没有有效短信链接');
    const response = await fetch(url, { cache: 'no-store' });
    const text = await response.text();
    const code = extractPhoneCode(text);
    return {
      ok: response.ok,
      status: response.status,
      code,
      preview: text.slice(0, 1200),
    };
  }

  async function waitForPhoneCode(account, logger, timeoutMs = PHONE_OTP_WAIT_TIMEOUT_MS) {
    const smsUrl = String(account?.auth_phone_sms_url || '').trim();
    if (!smsUrl) throw new Error('该邮箱没有保存授权手机号短信链接');
    const phoneNumber = String(account?.auth_phone_number || '').trim();
    const started = Date.now();
    let lastPreview = '';
    while (Date.now() - started < timeoutMs) {
      try {
        const payload = await fetchSmsPayload(smsUrl);
        lastPreview = String(payload.preview || '').slice(0, 300);
        if (payload.code) {
          logger?.(`读取到手机号验证码: ${payload.code}${phoneNumber ? ` (${maskPhone(phoneNumber)})` : ''}`);
          if (account.id) {
            await accountRepository.updateById(account.id, {
              last_sms_code: payload.code,
              last_sms_at: nowIso(),
            });
          }
          return payload.code;
        }
        logger?.(`手机号短信暂未识别到验证码: HTTP ${payload.status}`, 'warn');
      } catch (error) {
        lastPreview = error instanceof Error ? error.message : String(error);
        logger?.(`读取手机号短信失败: ${lastPreview}`, 'warn');
      }
      await sleep(PHONE_OTP_POLL_INTERVAL_MS);
    }
    throw new Error(`手机短信验证码获取超时，导出失败${phoneNumber ? ` (${maskPhone(phoneNumber)})` : ''}，最后返回: ${lastPreview}`);
  }

  return { extractPhoneCode, fetchSmsPayload, waitForPhoneCode };
}
