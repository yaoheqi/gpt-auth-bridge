const EMAIL_RE = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
const OTP_RE = /(验证码|verification code|one[- ]time password|otp)([^\d]{0,24})(\d{4,8})/gi;
const PHONE_RE = /\+\d[\d* -]{7,}/g;

export function maskEmail(value) {
  const text = String(value || '');
  const at = text.indexOf('@');
  if (at <= 0) return text;
  const local = text.slice(0, at);
  return `${local.slice(0, Math.min(2, local.length))}***${text.slice(at)}`;
}

export function sanitizeLogMessage(value) {
  let text = String(value ?? '').replace(/[\u001b\u009b]\[[0-?]*[ -\/]*[@-~]/g, '');
  text = text.replace(EMAIL_RE, (_match, domain) => `***@${domain}`);
  text = text.replace(OTP_RE, (_match, label, separator) => `${label}${separator}******`);
  text = text.replace(PHONE_RE, phone => {
    const digits = phone.replace(/\D/g, '');
    return digits.length > 4 ? `+${digits.slice(0, 3)}***${digits.slice(-2)}` : '***';
  });
  text = text.replace(/(https?:\/\/[^\s，。；、（）<>"']+)/gi, raw => {
    try {
      const url = new URL(raw.replace(/[),;]+$/, ''));
      return `${url.origin}${url.pathname}`;
    } catch { return '[url]'; }
  });
  return text;
}
