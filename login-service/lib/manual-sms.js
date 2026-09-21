import { randomUUID } from 'node:crypto';

const DEFAULT_API_BASE_URL = 'https://cdk.sms688.cc/api/v1/manual-sms';
const DEFAULT_POLL_INTERVAL_MS = 3000;

export class ManualSmsError extends Error {
  constructor(message, code = '', response = '') {
    super(message);
    this.name = 'ManualSmsError';
    this.code = code;
    this.response = response;
  }
}

function responseError(payload, action) {
  const code = String(payload?.code || payload?.error || '').trim();
  const message = String(payload?.message || payload?.error_message || payload?.detail || '').trim();
  const messages = {
    400: 'Manual SMS API 请求参数错误',
    401: 'Manual SMS API Key 无效或已轮换',
    404: 'Manual SMS 租约不存在或不属于当前账户',
    409: 'Manual SMS 当前租约状态不允许操作或暂无可用号码',
    423: 'Manual SMS 当前暂时关闭提交入口',
  };
  const httpStatus = Number(payload?.status || payload?.http_status || 0) || 0;
  const normalized = code || message || `HTTP_${httpStatus}`;
  return new ManualSmsError(messages[httpStatus] || `Manual SMS ${action} 请求失败: ${normalized}`, code || `HTTP_${httpStatus}`, JSON.stringify(payload || {}));
}

function ensureJson(text, action) {
  const normalized = String(text || '').trim();
  if (!normalized) throw new ManualSmsError(`Manual SMS ${action} 返回空响应`, 'EMPTY_RESPONSE');
  try {
    return JSON.parse(normalized);
  } catch {
    throw new ManualSmsError(`Manual SMS ${action} 返回无效 JSON: ${normalized.slice(0, 240)}`, 'INVALID_JSON', normalized);
  }
}

function extractStringField(payload, keys = []) {
  for (const key of keys) {
    const value = payload?.[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function extractBalanceValue(payload, depth = 0) {
  if (payload == null) return '';
  if (typeof payload === 'number' || typeof payload === 'string') return String(payload);
  const candidates = [
    'balance',
    'remaining',
    'available',
    'quota',
    'credits',
    'amount',
    'money',
    'total',
  ];
  for (const key of candidates) {
    const value = payload?.[key];
    if (value == null || value === '') continue;
    if (typeof value === 'object' && depth < 2) {
      const nested = extractBalanceValue(value, depth + 1);
      if (nested) return nested;
      continue;
    }
    return String(value);
  }
  if (depth < 2) {
    for (const key of ['data', 'account', 'summary', 'cdk']) {
      const nested = extractBalanceValue(payload?.[key], depth + 1);
      if (nested) return nested;
    }
  }
  if (Array.isArray(payload)) return String(payload.length);
  return '';
}

function extractLeasePayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const candidates = [
    payload.lease,
    payload.data?.lease,
    payload.data,
    payload.result?.lease,
    payload.result,
    payload,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      if (
        candidate.job_id != null
        || candidate.jobId != null
        || candidate.id != null
        || candidate.status != null
        || candidate.phone != null
        || candidate.sms_code != null
        || candidate.code != null
      ) {
        return candidate;
      }
    }
  }
  return payload;
}

function normalizeStatus(payload) {
  const lease = extractLeasePayload(payload);
  const status = String(lease?.status || '').trim().toLowerCase();
  const code = String(lease?.sms_code || lease?.code || '').trim();
  const phone = String(lease?.phone || lease?.phone_number || '').trim();
  const statusMap = {
    queued: 'queued',
    running: 'running',
    waiting_phone: 'waiting_phone',
    waiting_code: 'waiting',
    code_received: 'received',
    complete: 'complete',
    cancelled: 'cancelled',
    error: 'error',
  };
  return {
    status: statusMap[status] || status || 'unknown',
    code,
    phone,
    raw: JSON.stringify(payload || {}),
    payload: lease,
    envelope: payload,
  };
}

export class ManualSmsClient {
  constructor({ apiKey, baseUrl = DEFAULT_API_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.baseUrl = String(baseUrl || DEFAULT_API_BASE_URL).trim() || DEFAULT_API_BASE_URL;
    this.fetch = fetchImpl;
    if (!this.apiKey) throw new ManualSmsError('未配置 Manual SMS API Key', 'MISSING_API_KEY');
    if (typeof this.fetch !== 'function') throw new ManualSmsError('当前运行环境不支持 fetch', 'MISSING_FETCH');
  }

  async request(path, { method = 'GET', headers = {}, body, idempotencyKey } = {}) {
    const url = new URL(`${this.baseUrl.replace(/\/+$/, '')}/${String(path || '').replace(/^\/+/, '')}`);
    const hasBody = body != null;
    const response = await this.fetch(url, {
      method,
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${this.apiKey}`,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        ...headers,
      },
      body: hasBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const text = await response.text();
    if (!response.ok && response.status !== 202) {
      const payload = text ? ensureJson(text, path) : {};
      throw responseError(payload, path);
    }
    return { response, text, payload: text ? ensureJson(text, path) : {} };
  }

  async getBalance() {
    const { payload } = await this.request('/me');
    const balance = extractBalanceValue(payload);
    return balance || payload;
  }

  async createLease({ idempotencyKey, ...body } = {}) {
    const { payload } = await this.request('/leases', {
      method: 'POST',
      idempotencyKey,
      body: Object.keys(body).length ? body : undefined,
    });
    return normalizeStatus(payload);
  }

  async getLease(jobId) {
    const { payload } = await this.request(`/leases/${encodeURIComponent(String(jobId || '').trim())}`);
    return normalizeStatus(payload);
  }

  async changeLease(jobId, idempotencyKey) {
    const { payload } = await this.request(`/leases/${encodeURIComponent(String(jobId || '').trim())}/change`, {
      method: 'POST',
      idempotencyKey,
    });
    return normalizeStatus(payload);
  }

  async releaseLease(jobId, idempotencyKey) {
    const { payload } = await this.request(`/leases/${encodeURIComponent(String(jobId || '').trim())}/release`, {
      method: 'POST',
      idempotencyKey,
    });
    return normalizeStatus(payload);
  }

  async acquireNumber({
    timeoutMs = 60000,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    ...body
  } = {}) {
    const lease = await this.createLease({ ...body, idempotencyKey: body.idempotencyKey || randomUUID() });
    const jobId = extractStringField(lease.payload, ['job_id', 'jobId', 'id']);
    if (!jobId) throw new ManualSmsError('Manual SMS 创建租约响应缺少 job_id', 'MISSING_JOB_ID', lease.raw);

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const current = await this.getLease(jobId);
      const phone = extractStringField(current.payload, ['phone', 'phone_number']);
      const status = String(current.status || '').toLowerCase();
      if (phone) {
        return {
          activationId: jobId,
          phoneNumber: phone,
          status,
          country: String(body.country || ''),
          service: String(body.service || ''),
          raw: current.raw,
        };
      }
      if (status === 'cancelled' || status === 'error') {
        throw new ManualSmsError(`Manual SMS 租约状态异常: ${status}`, status.toUpperCase(), current.raw);
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    throw new ManualSmsError('等待 Manual SMS 手机号超时', 'PHONE_TIMEOUT');
  }

  async setStatus(jobId, status) {
    const value = Number(status);
    if (value === 8) return this.releaseLease(jobId, randomUUID());
    if (value === 3) return this.changeLease(jobId, randomUUID());
    return this.getLease(jobId);
  }

  async getStatus(jobId) {
    const current = await this.getLease(jobId);
    const smsCode = extractStringField(current.payload, ['sms_code', 'code']);
    const phone = extractStringField(current.payload, ['phone', 'phone_number']);
    if (smsCode) {
      return { ...current, status: 'received', code: smsCode, phone };
    }
    return {
      ...current,
      code: '',
      phone,
    };
  }

  async waitForCode(jobId, { timeoutMs = 180000, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, onPoll, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const result = await this.getStatus(jobId);
      onPoll?.(result);
      if (result.status === 'received' && result.code) return result.code;
      if (result.status === 'cancelled') throw new ManualSmsError('Manual SMS 租约已取消', 'ACTIVATION_CANCELLED', result.raw);
      await sleep(pollIntervalMs);
    }
    throw new ManualSmsError('等待 Manual SMS 手机验证码超时', 'SMS_TIMEOUT');
  }
}

export function normalizeManualSmsApiResponse(payload) {
  return normalizeStatus(payload);
}
