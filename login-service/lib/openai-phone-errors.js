export const PHONE_ERROR_CATEGORIES = Object.freeze({
  NUMBER_REJECTED: 'number_rejected',
  RISK_REJECTED: 'risk_rejected',
  RATE_LIMITED: 'rate_limited',
  TRANSIENT_FAILURE: 'transient_failure',
  HARD_FAILURE: 'hard_failure',
});

function searchableErrorText({ code = '', message = '', rawBody = '' } = {}) {
  return `${code} ${message} ${rawBody}`.toLowerCase().replace(/[_-]+/g, ' ');
}

export function classifyOpenAIPhoneError({ httpStatus = 0, code = '', message = '', rawBody = '' } = {}) {
  const text = searchableErrorText({ code, message, rawBody });
  if (/fraud guard|suspicious similar numbers?|similar phone numbers?/.test(text)) {
    return PHONE_ERROR_CATEGORIES.RISK_REJECTED;
  }
  if (httpStatus === 429 || /too many requests|rate limit/.test(text)) {
    return PHONE_ERROR_CATEGORIES.RATE_LIMITED;
  }
  if (httpStatus >= 500 || httpStatus === 0) return PHONE_ERROR_CATEGORIES.TRANSIENT_FAILURE;
  if (/phone number (?:already )?in use|already in use|invalid phone number|unsupported (?:phone|carrier)|(?:phone|carrier) (?:is )?unsupported|(?:the )?carrier associated with (?:this|the) phone(?: number)? is not supported|(?:this|the) phone number is not supported|already linked|maximum.*(?:phone|number)|unable to (?:send|use)|use (?:a )?different (?:phone )?number/.test(text)) {
    return PHONE_ERROR_CATEGORIES.NUMBER_REJECTED;
  }
  return PHONE_ERROR_CATEGORIES.HARD_FAILURE;
}

export class OpenAIPhoneSubmissionError extends Error {
  constructor(message, {
    httpStatus = 0,
    code = '',
    rawBody = '',
    category,
  } = {}) {
    super(message || 'OpenAI phone submission failed');
    this.name = 'OpenAIPhoneSubmissionError';
    this.httpStatus = Number(httpStatus) || 0;
    this.code = String(code || '');
    this.rawBody = String(rawBody || '');
    this.category = category || classifyOpenAIPhoneError({
      httpStatus: this.httpStatus,
      code: this.code,
      message: this.message,
      rawBody: this.rawBody,
    });
  }
}

export function createOpenAIPhoneSubmissionError({ httpStatus = 0, code = '', message = '', rawBody = '' } = {}) {
  const detail = message || code || rawBody || (httpStatus ? `HTTP ${httpStatus}` : 'transport failure');
  return new OpenAIPhoneSubmissionError(`SendPhoneOtp请求失败: ${detail}`, {
    httpStatus,
    code,
    rawBody,
  });
}

export function nextPhoneRetryDecision(error, state, {
  maxDeliveryAttempts,
  maxRejectedSwaps,
  maxRiskRejections = 2,
} = {}) {
  const next = {
    deliveryAttempts: Number(state?.deliveryAttempts) || 0,
    rejectedSwaps: Number(state?.rejectedSwaps) || 0,
    riskRejections: Number(state?.riskRejections) || 0,
  };
  const category = error?.category || PHONE_ERROR_CATEGORIES.HARD_FAILURE;
  if (category === PHONE_ERROR_CATEGORIES.NUMBER_REJECTED) {
    next.rejectedSwaps += 1;
    return { action: next.rejectedSwaps >= maxRejectedSwaps ? 'stop' : 'swap', category, state: next };
  }
  if (category === PHONE_ERROR_CATEGORIES.RISK_REJECTED) {
    next.riskRejections += 1;
    return { action: next.riskRejections >= maxRiskRejections ? 'stop' : 'swap', category, state: next };
  }
  if (category === PHONE_ERROR_CATEGORIES.RATE_LIMITED) {
    return { action: 'stop', category, state: next };
  }
  next.deliveryAttempts += 1;
  return { action: next.deliveryAttempts >= maxDeliveryAttempts ? 'stop' : 'swap', category, state: next };
}