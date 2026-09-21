export const AUTH_BASE_URL = 'https://auth.openai.com';
export const AUTH_AUTHORIZE_CONTINUE_URL = `${AUTH_BASE_URL}/api/accounts/authorize/continue`;
export const AUTH_PASSWORD_VERIFY_URL = `${AUTH_BASE_URL}/api/accounts/password/verify`;
export const AUTH_WORKSPACE_SELECT_URL = `${AUTH_BASE_URL}/api/accounts/workspace/select`;
export const AUTH_PHONE_SEND_URL = `${AUTH_BASE_URL}/api/accounts/add-phone/send`;
export const AUTH_PHONE_OTP_SEND_URL = `${AUTH_BASE_URL}/api/accounts/phone-otp/send`;
export const AUTH_PHONE_OTP_VALIDATE_URL = `${AUTH_BASE_URL}/api/accounts/phone-otp/validate`;
export const AUTH_MFA_VERIFY_URL = `${AUTH_BASE_URL}/api/accounts/mfa/verify`;

export const CHATGPT_BASE_URL = 'https://chatgpt.com';
export const CHATGPT_AUTH_CSRF_URL = `${CHATGPT_BASE_URL}/api/auth/csrf`;
export const CHATGPT_AUTH_SIGNIN_OPENAI_URL = `${CHATGPT_BASE_URL}/api/auth/signin/openai`;
export const CHATGPT_AUTH_CALLBACK_OPENAI_URL = `${CHATGPT_BASE_URL}/api/auth/callback/openai`;
export const CHATGPT_AUTH_SESSION_URL = `${CHATGPT_BASE_URL}/api/auth/session`;
export const CHATGPT_LOGOUT_ALL_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/logout_all`;
export const CHATGPT_MFA_INFO_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/mfa_info`;
export const CHATGPT_MFA_ENROLL_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/mfa/enroll`;
export const CHATGPT_MFA_DISABLE_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/mfa/user/disable_in_house`;
export const CHATGPT_MFA_ACTIVATE_ENROLLMENT_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/mfa/user/activate_enrollment`;
export const CHATGPT_ACCOUNTS_CHECK_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/check/v4-2023-04-27`;
export const CHATGPT_PLUS_TRIAL_CAMPAIGN = 'plus-1-month-free';
export const CHATGPT_PLUS_TRIAL_ELIGIBILITY_URL = `${CHATGPT_BASE_URL}/backend-api/promotions/eligibility/${CHATGPT_PLUS_TRIAL_CAMPAIGN}?type=promo`;
export const CHATGPT_CHECKOUT_PRICING_CONFIG_URL = (countryCode = 'JP') => (
  `${CHATGPT_BASE_URL}/backend-api/checkout_pricing_config/configs/${encodeURIComponent(String(countryCode || 'JP').toUpperCase())}`
);

export function normalizeAuthContinueUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.startsWith('http') ? text : new URL(text, AUTH_BASE_URL).toString();
}
