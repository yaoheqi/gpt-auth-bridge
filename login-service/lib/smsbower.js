const DEFAULT_API_BASE_URL = 'https://smsbower.page/stubs/handler_api.php';

export class SmsBowerError extends Error {
  constructor(message, code = '', response = '') {
    super(message);
    this.name = 'SmsBowerError';
    this.code = code;
    this.response = response;
  }
}

function responseError(text, action) {
  const code = String(text || '').trim().split(':', 1)[0];
  const messages = {
    BAD_KEY: 'SMSBower API Key 无效',
    BAD_ACTION: 'SMSBower API action 无效',
    BAD_SERVICE: 'SMSBower 服务代码无效',
    BAD_STATUS: 'SMSBower 激活状态无效',
    BAD_COUNTRY: 'SMSBower 国家代码无效',
    NO_ACTIVATION: 'SMSBower 激活订单不存在',
    NO_NUMBERS: 'SMSBower 当前没有符合条件的号码',
    NO_BALANCE: 'SMSBower 余额不足',
    EARLY_CANCEL_DENIED: 'SMSBower 暂不允许取消该号码',
  };
  return new SmsBowerError(messages[code] || `SMSBower ${action} 请求失败: ${text}`, code, text);
}

function assertApiResponse(text, action) {
  const normalized = String(text || '').trim();
  if (!normalized) throw new SmsBowerError(`SMSBower ${action} 返回空响应`, 'EMPTY_RESPONSE');
  if (/^(BAD_|NO_|ERROR|EARLY_)/i.test(normalized)) throw responseError(normalized, action);
  return normalized;
}

export function normalizeInternationalPhone(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  if (!digits) throw new SmsBowerError('SMSBower 返回的手机号为空', 'INVALID_PHONE');
  return `+${digits}`;
}

export function parseNumberResponse(text) {
  const normalized = assertApiResponse(text, 'getNumber');
  if (normalized.startsWith('{')) {
    let payload;
    try {
      payload = JSON.parse(normalized);
    } catch {
      throw new SmsBowerError(`SMSBower getNumber 返回了无效 JSON: ${normalized.slice(0, 200)}`, 'INVALID_JSON', normalized);
    }
    const activationId = String(payload.activationId || payload.id || '').trim();
    const phoneNumber = normalizeInternationalPhone(payload.phoneNumber || payload.number);
    if (!activationId) throw new SmsBowerError('SMSBower getNumber 响应缺少 activationId', 'INVALID_ACTIVATION', normalized);
    return {
      activationId,
      phoneNumber,
      activationCost: Number(payload.activationCost || 0) || 0,
      countryCode: String(payload.countryCode || ''),
      canGetAnotherSms: Boolean(payload.canGetAnotherSms),
      activationOperator: String(payload.activationOperator || ''),
    };
  }

  const match = normalized.match(/^ACCESS_NUMBER:([^:]+):(.+)$/i);
  if (!match) throw new SmsBowerError(`无法识别 SMSBower 号码响应: ${normalized.slice(0, 200)}`, 'INVALID_NUMBER_RESPONSE', normalized);
  return { activationId: match[1], phoneNumber: normalizeInternationalPhone(match[2]) };
}

export function parseStatusResponse(text) {
  const normalized = assertApiResponse(text, 'getStatus');
  if (normalized.startsWith('STATUS_OK:')) {
    return { status: 'received', code: normalized.slice('STATUS_OK:'.length).trim(), raw: normalized };
  }
  if (normalized.startsWith('STATUS_WAIT_RETRY:')) {
    return { status: 'waiting_retry', code: '', lastCode: normalized.slice('STATUS_WAIT_RETRY:'.length).trim(), raw: normalized };
  }
  const states = {
    STATUS_WAIT_CODE: 'waiting',
    STATUS_WAIT_RESEND: 'waiting_resend',
    STATUS_CANCEL: 'cancelled',
  };
  if (states[normalized]) return { status: states[normalized], code: '', raw: normalized };
  throw new SmsBowerError(`无法识别 SMSBower 短信状态: ${normalized.slice(0, 200)}`, 'INVALID_STATUS_RESPONSE', normalized);
}

export function parseBalanceResponse(text) {
  const normalized = assertApiResponse(text, 'getBalance');
  const match = normalized.match(/^ACCESS_BALANCE:([\d.]+)$/i);
  if (!match) throw new SmsBowerError(`无法识别 SMSBower 余额响应: ${normalized}`, 'INVALID_BALANCE_RESPONSE', normalized);
  return Number(match[1]);
}

export class SmsBowerClient {
  constructor({ apiKey, baseUrl = DEFAULT_API_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.baseUrl = String(baseUrl || DEFAULT_API_BASE_URL).trim();
    this.fetch = fetchImpl;
    if (!this.apiKey) throw new SmsBowerError('未配置 SMSBOWER_API_KEY', 'MISSING_API_KEY');
    if (typeof this.fetch !== 'function') throw new SmsBowerError('当前运行环境不支持 fetch', 'MISSING_FETCH');
  }

  async request(action, params = {}) {
    const url = new URL(this.baseUrl);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('action', action);
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    const response = await this.fetch(url, { method: 'GET', cache: 'no-store' });
    const text = await response.text();
    if (!response.ok) throw new SmsBowerError(`SMSBower ${action} HTTP ${response.status}: ${text.slice(0, 200)}`, `HTTP_${response.status}`, text);
    return assertApiResponse(text, action);
  }

  async getBalance() {
    return parseBalanceResponse(await this.request('getBalance'));
  }

  async getPrices({ service, country } = {}) {
    const text = await this.request('getPrices', { service, country });
    try {
      return JSON.parse(text);
    } catch {
      throw new SmsBowerError(`SMSBower getPrices 返回了无效 JSON: ${text.slice(0, 200)}`, 'INVALID_JSON', text);
    }
  }

  /**
   * 按官方文档使用 getNumber：
   * ACCESS_NUMBER:$activationId:$phoneNumber
   * 也兼容 getNumberV2 的 JSON 响应。
   */
  async acquireNumber({
    service = 'dr',
    country = '33',
    maxPrice,
    minPrice,
    providerIds,
    exceptProviderIds,
    phoneException,
    ref,
    userID,
    useV2 = false,
  } = {}) {
    const action = useV2 ? 'getNumberV2' : 'getNumber';
    const text = await this.request(action, {
      service,
      country,
      maxPrice,
      minPrice,
      providerIds,
      exceptProviderIds,
      phoneException,
      ref,
      userID,
    });
    const result = parseNumberResponse(text);
    return { ...result, country: String(country || ''), service: String(service || '') };
  }

  async setStatus(activationId, status) {
    return this.request('setStatus', { id: activationId, status });
  }

  async getStatus(activationId) {
    return parseStatusResponse(await this.request('getStatus', { id: activationId }));
  }

  async waitForCode(activationId, { timeoutMs = 180000, pollIntervalMs = 5000, onPoll, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const result = await this.getStatus(activationId);
      onPoll?.(result);
      if (result.status === 'received' && result.code) return result.code;
      if (result.status === 'cancelled') throw new SmsBowerError('SMSBower 激活订单已取消', 'ACTIVATION_CANCELLED', result.raw);
      await sleep(pollIntervalMs);
    }
    throw new SmsBowerError('等待 SMSBower 手机验证码超时', 'SMS_TIMEOUT');
  }
}

export const SMSBOWER_API_BASE_URL = DEFAULT_API_BASE_URL;

/** OpenAI / ChatGPT 官方服务码 */
export const SMSBOWER_OPENAI_SERVICE = 'dr';

/**
 * 默认不限制国家：留空时按 getPrices 对指定服务做最低价匹配。
 * 下列仅作为管理页可选预设，不会再作为强制默认取号列表。
 */
export const SMSBOWER_DEFAULT_COUNTRIES = [];

/** 管理页可选国家预设（非强制默认）；含英国和德国 */
export const SMSBOWER_COUNTRY_PRESETS = ['151', '33', '73', '16', '43'];

export const SMSBOWER_COUNTRY_LABELS = {
  151: '智利 Chile',
  33: '哥伦比亚 Colombia',
  73: '巴西 Brazil',
  16: '英国 United Kingdom',
  43: '德国 Germany',
};

export const SMS_ACQUIRE_COUNTRY_LIMIT = 20;

/** 同一国家连续失败次数达到后才换国家，或在无下一国时抬价 */
export const SMSBOWER_FAILS_BEFORE_SWITCH = 3;

/** 抬价步长（美元），不超过配置的 maxPrice 上限 */
export const SMSBOWER_PRICE_STEP = 0.01;

function parseOptionalPrice(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function formatMoney(value) {
  const n = roundMoney(value);
  return Number.isFinite(n) ? String(n) : '';
}

/**
 * 取号策略：同一国家累计失败 failsBeforeSwitch 次后换下一国；
 * 国家用尽后按 priceStep 提高 workingMaxPrice，直到 ceiling（配置 maxPrice）。
 * 起始价优先用 minPrice（若有且 ≤ ceiling），否则直接用 ceiling（仅换国家、不再抬价）。
 */
export function createSmsCountryPricePlanner({
  countries = [],
  minPrice = '',
  maxPrice = '0.05',
  priceStep = SMSBOWER_PRICE_STEP,
  failsBeforeSwitch = SMSBOWER_FAILS_BEFORE_SWITCH,
} = {}) {
  const countryList = (Array.isArray(countries) ? countries : [])
    .map(item => String(item || '').trim())
    .filter(Boolean);
  const ceiling = parseOptionalPrice(maxPrice) ?? 0.05;
  const floor = parseOptionalPrice(minPrice);
  const step = Math.max(0.01, parseOptionalPrice(priceStep) || SMSBOWER_PRICE_STEP);
  const switchAfter = Math.max(1, Number(failsBeforeSwitch) || SMSBOWER_FAILS_BEFORE_SWITCH);

  let workingMax = floor != null ? Math.min(Math.max(floor, 0), ceiling) : ceiling;
  let countryIndex = 0;
  let failsOnCurrent = 0;
  let exhausted = countryList.length === 0;

  function snapshot() {
    return {
      country: countryList[countryIndex] || '',
      countryIndex,
      countries: [...countryList],
      workingMaxPrice: formatMoney(workingMax),
      ceilingMaxPrice: formatMoney(ceiling),
      minPrice: floor != null ? formatMoney(floor) : '',
      failsOnCurrent,
      failsBeforeSwitch: switchAfter,
      exhausted,
    };
  }

  function recordFailure(reason = '') {
    if (exhausted || countryList.length === 0) {
      exhausted = true;
      return { ...snapshot(), switched: null, reason: String(reason || '') };
    }
    failsOnCurrent += 1;
    if (failsOnCurrent < switchAfter) {
      return { ...snapshot(), switched: null, reason: String(reason || '') };
    }
    failsOnCurrent = 0;
    if (countryIndex < countryList.length - 1) {
      countryIndex += 1;
      return { ...snapshot(), switched: 'country', reason: String(reason || '') };
    }
    const next = roundMoney(workingMax + step);
    if (next <= ceiling + 1e-9 && next > workingMax + 1e-9) {
      workingMax = Math.min(next, ceiling);
      countryIndex = 0;
      return { ...snapshot(), switched: 'price', reason: String(reason || '') };
    }
    exhausted = true;
    return { ...snapshot(), switched: null, reason: String(reason || '') };
  }

  return {
    snapshot,
    recordFailure,
    isExhausted: () => exhausted,
  };
}

function extractPriceInfo(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const cost = Number(node.cost ?? node.price ?? NaN);
  const count = Number(node.count ?? 0);
  if (!Number.isFinite(cost)) return null;
  return { cost, count };
}

/**
 * 从 getPrices 响应中筛出指定服务、有库存、符合价格区间的国家，并按最低价排序。
 * 兼容三种常见结构：
 * - country -> service -> {cost,count}
 * - country -> {cost,count}（已按 service 过滤）
 * - service -> country -> {cost,count}
 */
export function rankServiceCountriesByPrice(pricesPayload, service, { maxPrice, minPrice } = {}) {
  const serviceCode = String(service || '').trim();
  if (!serviceCode) return [];
  const max = parseOptionalPrice(maxPrice);
  const min = parseOptionalPrice(minPrice);
  const payload = pricesPayload && typeof pricesPayload === 'object' ? pricesPayload : {};
  const rows = [];
  const pushRow = (country, info) => {
    if (!info || info.count <= 0) return;
    if (max != null && info.cost > max) return;
    if (min != null && info.cost < min) return;
    rows.push({ country: String(country), cost: info.cost, count: info.count });
  };

  const serviceBucket = payload[serviceCode] || payload[serviceCode.toLowerCase()];
  if (serviceBucket && typeof serviceBucket === 'object' && !Array.isArray(serviceBucket) && extractPriceInfo(serviceBucket) == null) {
    for (const [country, node] of Object.entries(serviceBucket)) {
      pushRow(country, extractPriceInfo(node));
    }
  } else {
    for (const [country, services] of Object.entries(payload)) {
      if (!services || typeof services !== 'object' || Array.isArray(services)) continue;
      const nested = services[serviceCode] || services[serviceCode.toLowerCase()];
      const info = extractPriceInfo(nested) || extractPriceInfo(services);
      pushRow(country, info);
    }
  }

  rows.sort((a, b) => a.cost - b.cost || b.count - a.count || a.country.localeCompare(b.country));
  return rows;
}

/**
 * 有人工配置国家时保持配置顺序；否则使用价格排名结果（默认不限制国家）。
 */
export function resolveSmsAcquireCountries({ configuredCountries = [], priceRows = [], limit = SMS_ACQUIRE_COUNTRY_LIMIT } = {}) {
  const configured = (Array.isArray(configuredCountries) ? configuredCountries : [])
    .map(item => String(item || '').trim())
    .filter(Boolean);
  if (configured.length) return configured;
  const capped = Math.max(1, Number(limit) || SMS_ACQUIRE_COUNTRY_LIMIT);
  return (Array.isArray(priceRows) ? priceRows : [])
    .slice(0, capped)
    .map(item => String(item?.country || '').trim())
    .filter(Boolean);
}
