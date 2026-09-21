import { splitPasswordTotpLine } from './login-account-format.js';

(async () => {
  let taskConcurrency = null;
  function selectedTaskConcurrency() {
    return taskConcurrency ?? '服务端设置';
  }
  const pageFetch = (url, options = {}) => fetch(url, {
    ...options,
    ...(typeof window !== 'undefined' && window.browserWorkspace ? { signal: options.signal
      ? AbortSignal.any([options.signal, window.browserWorkspace.signal]) : window.browserWorkspace.signal } : {}),
  });
  const OUTPUT_LABELS = {
    sub2api: "sub2api",
    cpa: "CPA",
    cockpit: "Cockpit",
    "9router": "9router",
    codex: "Codex",
    axonhub: "AxonHub",
    codexmanager: "Codex-Manager",
    "sub2api-tools": "sub2api 工具",
    "protocol-login": "协议登录 / RT",
  };

  const createWorkspaceState = () => ({
    format: "sub2api",
    sessions: [],
    converted: [],
    skipped: [],
    outputText: "",
    health: [],
    healthRun: 0,
    toolResult: null,
    toolParsed: null,
    toolRecords: [],
    browserAccounts: [],
    browserSettings: {},
    cpaSettings: {},
    pushRetry: null,
    pushResults: [],
    loginLastAccounts: [],
    loginLastIds: [],
    loginSessionIds: [],
    loginPersonalIds: [],
    loginBusinessIds: [],
    logoutInProgress: false,
    logoutResults: [],
    logoutLog: [],
    logoutRun: 0,
    loginLastResponse: null,
    loginLastRtKind: "all",
    // The next protocol/RT run can target only accounts that failed in the
    // previous run. Keep IDs and public identity only; credentials remain in
    // the encrypted input field/browser account snapshot.
    loginRetry: null,
    loginProgress: new Map(),
    loginSensitiveValues: [],
    loginRenderFrame: 0,
    loginSub2Loaded: false,
    loginSub2KeyConfigured: false,
    loginSub2SelectedGroupIds: [],
    loginSub2AvailableGroups: [],
    loginProxyMode: "direct",
    loginProxyLocalPort: 7890,
    loginProxyPool: "",
    monitorLastCheckAt: 0,
    monitorRetries: {},
    monitorEnabled: false,
    monitorOwner: '',
    monitorStopped: {},
  });
  const state = createWorkspaceState();
  let pushBusy = false;
  let pushToastTimer;
  let monitorTimer;
  let monitorController;
  let monitorNextAt = Date.now() + 60_000;
  let monitorBusy = false;
  let monitorPaused = false;
  let monitorLastSummary = '';
  let selfLeaveBusy = false;
  let protocolLogoutBusy = false;

  let browserStorageReady = false;
  let browserStorageAvailable = false;
  let browserStorageCleared = false;
  let browserSaveTimer;
  let workspaceGeneration = 0;
  let clearingBrowserData = false;
  function workspaceTaskIsCurrent(signal) {
    const generation = workspaceGeneration;
    return () => generation === workspaceGeneration && !browserStorageCleared && !signal?.aborted;
  }
  function requireCurrentWorkspace(isCurrent) {
    if (!isCurrent()) throw Object.assign(new Error('本地数据已清空或由其他标签页更新'), { name: 'AbortError' });
  }
  function browserRequestBody(body = {}) {
    const ids = Array.isArray(body.ids) ? new Set(body.ids.map(String)) : null;
    return { ...body, browserState: {
      accounts: ids ? state.browserAccounts.filter(account => ids.has(String(account.id))) : state.browserAccounts,
      settings: Object.fromEntries(Object.entries(state.browserSettings).map(([key, value]) => {
        if (key !== 'sub2apiSettings') return [key, value];
        const { baseUrl, adminApiKey, groupIds, legacyGroupName, ...exportSettings } = value;
        return [key, exportSettings];
      })),
    } };
  }
  function acceptBrowserState(snapshot) {
    if (!snapshot || browserStorageCleared) return;
    const accounts = new Map(state.browserAccounts.map(account => [String(account.id), account]));
    for (const account of snapshot.accounts || []) accounts.set(String(account.id), account);
    state.browserAccounts = [...accounts.values()];
    for (const [key, value] of Object.entries(snapshot.settings || {})) {
      state.browserSettings[key] = { ...state.browserSettings[key], ...value };
    }
    persistBrowserWorkspace(snapshot.partial !== true);
  }
  function browserFields() {
    return [...document.querySelectorAll('input, textarea, select')]
      .filter(node => node.type !== 'file' && !node.readOnly && (node.id || node.name))
      .map(node => ({ id: node.id, name: node.name, type: node.type, value: node.value, checked: node.checked }));
  }
  function restoreBrowserFields(fields = []) {
    for (const field of fields) {
      const node = field.id ? document.getElementById(field.id)
        : [...document.querySelectorAll('input[type="radio"]')].find(node => node.name === field.name && node.value === field.value);
      if (!node || node.type === 'file' || field.id === 'login-concurrency') continue;
      node.value = field.value;
      if (typeof field.checked === 'boolean') node.checked = field.checked;
    }
  }
  function settingsOnlyWorkspace() {
    const retained = createWorkspaceState();
    for (const key of ['format', 'cpaSettings', 'loginProxyMode', 'loginProxyLocalPort', 'loginProxyPool', 'monitorEnabled',
      'loginSub2Loaded', 'loginSub2KeyConfigured', 'loginSub2SelectedGroupIds', 'loginSub2AvailableGroups']) {
      retained[key] = structuredClone(state[key]);
    }
    retained.browserSettings = Object.fromEntries(['protocolSettings', 'sub2apiSettings']
      .filter(key => state.browserSettings[key]).map(key => [key, structuredClone(state.browserSettings[key])]));
    retained.loginProgress = [];
    const ids = new Set(['login-proxy-local-port', 'login-proxy-pool', 'sub2api-models', 'sub2api-concurrency',
      'sub2api-load-factor', 'sub2api-priority', 'sub2api-fingerprint-mode', 'download-scope', 'health-filter',
      'usage-filter', 'sub2api-operation', 'split-scope']);
    const names = new Set(['push-target', 'login-proxy-mode', 'login-workspace-mode', 'session-monitor']);
    const fields = browserFields().filter(field => ids.has(field.id) || names.has(field.name)
      || (field.id && document.getElementById(field.id)?.closest('.push-config')));
    return { state: retained, fields, resetCredentials: '' };
  }
  function persistBrowserWorkspace(immediate = false, required = false) {
    if (!browserStorageReady || browserStorageCleared) {
      if (required) throw new Error('浏览器加密存储不可用，请使用 HTTPS 或 localhost，并允许站点存储');
      return;
    }
    clearTimeout(browserSaveTimer);
    const isCurrent = workspaceTaskIsCurrent();
    const save = () => {
      if (!isCurrent()) return;
      const fields = browserFields();
      return window.browserWorkspace.save({ state: { ...state, loginProgress: [...state.loginProgress], loginRenderFrame: 0 }, fields,
        resetCredentials: elements.loginResetCredentials.textContent }).then(() => {
          if (isCurrent()) {
            document.querySelector('#browser-storage-status').textContent = '数据仅保存在此浏览器';
            scheduleSessionMonitor();
          }
        }).catch((error) => {
          if (!isCurrent()) { if (required) throw error; return; }
          document.querySelector('#browser-storage-status').textContent = error.code === 'WORKSPACE_CONFLICT' ? error.message : '浏览器保存失败，请及时下载结果';
          if (required) throw error;
        });
    };
    if (immediate === true) return save();
    else browserSaveTimer = setTimeout(save, 250);
  }

  let loginModalReturnFocus = null;
  let loginModalPreviousOverflow = "";

  const elements = {
    accountBody: document.querySelector("#account-body"),
    clearInput: document.querySelector("#clear-input"),
    copyOutput: document.querySelector("#copy-output"),
    cpaNotice: document.querySelector("#cpa-notice"),
    downloadOutput: document.querySelector("#download-output"),
    downloadMatched: document.querySelector("#download-matched"),
    downloadUnmatched: document.querySelector("#download-unmatched"),
    converterActions: document.querySelector("#converter-actions"),
    formatList: document.querySelector("#format-list"),
    converterWorkspace: document.querySelector("#converter-workspace"),
    loginWorkbench: document.querySelector("#login-workbench"),
    loginAccounts: document.querySelector("#login-accounts"),
    importLoginFile: document.querySelector('#import-login-file'),
    loginFileInput: document.querySelector('#login-file-input'),
    resetLoginTotp: document.querySelector("#reset-login-totp"),
    protocolLogoutAll: document.querySelector('#protocol-logout-all'),
    selfLeaveWorkspaces: document.querySelector('#self-leave-workspaces'),
    loginResetOutput: document.querySelector("#login-reset-output"),
    loginResetCredentials: document.querySelector("#login-reset-credentials"),
    copyLoginResetOutput: document.querySelector("#copy-login-reset-output"),
    loginAccountCount: document.querySelector("#login-account-count"),
    taskConcurrencyValue: document.querySelector("#task-concurrency-value"),
    loginWorkspaceMode: document.querySelector("#login-workspace-mode"),
    loginProxyMode: document.querySelector("#login-proxy-mode"),
    loginProxyLocalWrap: document.querySelector("#login-proxy-local-wrap"),
    loginProxyLocalPort: document.querySelector("#login-proxy-local-port"),
    loginProxyCustomWrap: document.querySelector("#login-proxy-custom-wrap"),
    loginProxyPool: document.querySelector("#login-proxy-pool"),
    loginProxyStatus: document.querySelector("#login-proxy-status"),
    loginStepList: document.querySelector("#login-step-list"),
    loginProgressList: document.querySelector("#login-progress-list"),
    loginProgressSummary: document.querySelector("#login-progress-summary"),
    loginCompletedCount: document.querySelector("#login-completed-count"),
    loginOverallPercent: document.querySelector("#login-overall-percent"),
    loginOverallBar: document.querySelector("#login-overall-bar"),
    startProtocolLogin: document.querySelector("#start-protocol-login"),
    exportLoginSessions: document.querySelector("#export-login-sessions"),
    exportLoginPersonal: document.querySelector("#export-login-personal"),
    exportLoginBusiness: document.querySelector("#export-login-business"),
    pushControls: document.querySelector('#push-controls'),
    pushTarget: document.querySelector('#push-target'),
    pushConverted: document.querySelector('#push-converted'),
    retryPush: document.querySelector('#retry-push'),
    pushStatus: document.querySelector('#push-status'),
    pushToast: document.querySelector('#push-toast'),
    pushHint: document.querySelector('#push-hint'),
    pushFeedback: document.querySelector('#push-feedback'),
    loginPushSlot: document.querySelector('#login-push-slot'),
    converterPushSlot: document.querySelector('#converter-push-slot'),
    loginPushFeedbackSlot: document.querySelector('#login-push-feedback-slot'),
    converterPushFeedbackSlot: document.querySelector('#converter-push-feedback-slot'),
    formatToolbar: document.querySelector('#format-toolbar'),
    pushResults: document.querySelector('#push-results'),
    pushResultDetails: document.querySelector('#push-result-details'),
    sub2PushDialog: document.querySelector('#sub2-push-dialog'),
    cpaPushDialog: document.querySelector('#cpa-push-dialog'),
    cpaBaseUrl: document.querySelector('#cpa-base-url'),
    cpaManagementKey: document.querySelector('#cpa-management-key'),
    cpaConfigStatus: document.querySelector('#cpa-config-status'),
    loginStatus: document.querySelector("#login-status"),
    loginSub2BaseUrl: document.querySelector("#login-sub2-base-url"),
    loginSub2AdminKey: document.querySelector("#login-sub2-admin-key"),
    loginSub2Groups: document.querySelector("#login-sub2-groups"),
    loginSub2GroupCount: document.querySelector("#login-sub2-group-count"),
    loginSub2Concurrency: document.querySelector("#login-sub2-concurrency"),
    loginSub2Priority: document.querySelector("#login-sub2-priority"),
    loginSub2LoadFactor: document.querySelector("#login-sub2-load-factor"),
    loginSub2FingerprintMode: document.querySelector("#login-sub2-fingerprint-mode"),
    loginSub2Models: document.querySelector("#login-sub2-models"),
    loginSub2Status: document.querySelector("#login-sub2-status"),
    loadLoginSub2Groups: document.querySelector("#load-login-sub2-groups"),
    saveLoginSub2Config: document.querySelector("#save-login-sub2-config"),
    toggleLoginSub2Key: document.querySelector("#toggle-login-sub2-key"),
    loginModal: document.querySelector("#login-modal"),
    loginModalMessage: document.querySelector("#login-modal-message"),
    closeLoginModal: document.querySelector("#close-login-modal"),
    downloadScope: document.querySelector("#download-scope"),
    fileInput: document.querySelector("#file-input"),
    formatButtons: Array.from(document.querySelectorAll("[data-format]")),
    formatRail: document.querySelector("#format-rail"),
    input: document.querySelector("#session-input"),
    inputDropzone: document.querySelector("#input-dropzone"),
    inputSubtitle: document.querySelector("#input-subtitle"),
    inputStatus: document.querySelector("#input-status"),
    inputTitle: document.querySelector("#input-title"),
    issues: document.querySelector("#issues"),
    loadExample: document.querySelector("#load-example"),
    mailInput: document.querySelector("#mail-input"),
    mailInputLabel: document.querySelector("#mail-input-label"),
    mailFileInput: document.querySelector("#mail-file-input"),
    output: document.querySelector("#output"),
    outputStatus: document.querySelector("#output-status"),
    outputSubtitle: document.querySelector("#output-subtitle"),
    pickFiles: document.querySelector("#pick-files"),
    pickMailFile: document.querySelector("#pick-mail-file"),
    statCount: document.querySelector("#stat-count"),
    statErrors: document.querySelector("#stat-errors"),
    statFormat: document.querySelector("#stat-format"),
    sub2apiOperation: document.querySelector("#sub2api-operation"),
    toolOperationButtons: document.querySelector("#tool-operation-buttons"),
    operationButtons: Array.from(document.querySelectorAll("[data-operation]")),
    sub2apiOutputConfig: document.querySelector("#sub2api-output-config"),
    sub2apiModels: document.querySelector("#sub2api-models"),
    sub2apiConcurrency: document.querySelector("#sub2api-concurrency"),
    sub2apiLoadFactor: document.querySelector("#sub2api-load-factor"),
    sub2apiPriority: document.querySelector("#sub2api-priority"),
    sub2apiFingerprintMode: document.querySelector("#sub2api-fingerprint-mode"),
    sub2apiToolConfig: document.querySelector("#sub2api-tool-config"),
    splitScope: document.querySelector("#split-scope"),
    splitScopeLabel: document.querySelector("#split-scope-label"),
    splitDownloads: document.querySelector("#split-downloads"),
    sessionGuide: document.querySelector("#session-guide"),
    healthStatus: document.querySelector("#health-status"),
    healthBody: document.querySelector("#health-body"),
    healthFilter: document.querySelector("#health-filter"),
    healthFilterLabel: document.querySelector("#health-filter-label"),
    usageFilter: document.querySelector("#usage-filter"),
    usageFilterLabel: document.querySelector("#usage-filter-label"),
    healthTable: document.querySelector("#health-table"),
    logoutAllSessions: document.querySelector("#logout-all-sessions"),
    logoutProgress: document.querySelector("#logout-progress"),
  };

  const exampleSession = {
    user: {
      id: "user-example",
      email: "mark@example.com",
    },
    expires: "2026-08-06T14:29:36.155Z",
    account: {
      id: "00000000-0000-4000-9000-000000000000",
      planType: "plus",
    },
    accessToken: "paste-real-access-token-here",
    sessionToken: "paste-real-session-token-here",
    authProvider: "openai",
  };

  const AXONHUB_PLACEHOLDER_REFRESH_TOKEN = "__missing_refresh_token__";

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim() !== "") {
        return value.trim();
      }
    }
    return undefined;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function decodeBase64Url(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function encodeBase64UrlJson(value) {
    return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  }

  function parseJwtPayload(token) {
    if (typeof token !== "string" || token.trim() === "") {
      return undefined;
    }

    const segments = token.split(".");
    if (segments.length < 2) {
      return undefined;
    }

    try {
      return JSON.parse(decodeBase64Url(segments[1]));
    } catch {
      return undefined;
    }
  }

  function getOpenAIAuthSection(payload) {
    if (!isPlainObject(payload)) {
      return {};
    }

    const auth = payload["https://api.openai.com/auth"];
    return isPlainObject(auth) ? auth : {};
  }

  function getOpenAIProfileSection(payload) {
    if (!isPlainObject(payload)) {
      return {};
    }

    const profile = payload["https://api.openai.com/profile"];
    return isPlainObject(profile) ? profile : {};
  }

  function normalizeTimestamp(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      const milliseconds = value > 1e11 ? value : value * 1000;
      const date = new Date(milliseconds);
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }

    if (typeof value !== "string" || value.trim() === "") {
      return undefined;
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }

  function timestampFromUnixSeconds(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return undefined;
    }

    const date = new Date(numeric * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }

  function unixSecondsFromJwtExp(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return undefined;
    }

    return Math.trunc(numeric);
  }

  function epochSecondsFromValue(value) {
    if (value === undefined || value === null || value === "") {
      return 0;
    }

    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return Math.trunc(numeric > 1e11 ? numeric / 1000 : numeric);
    }

    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? Math.trunc(parsed / 1000) : 0;
  }

  function buildSyntheticCodexIdToken(email, accountId, planType, userId, expiresAt) {
    if (!accountId) {
      return undefined;
    }

    const now = Math.trunc(Date.now() / 1000);
    const authInfo = { chatgpt_account_id: accountId };
    const expires = epochSecondsFromValue(expiresAt) || now + 90 * 24 * 60 * 60;

    if (planType) {
      authInfo.chatgpt_plan_type = planType;
    }

    if (userId) {
      authInfo.chatgpt_user_id = userId;
      authInfo.user_id = userId;
    }

    const payload = {
      iat: now,
      exp: expires,
      "https://api.openai.com/auth": authInfo,
    };

    if (email) {
      payload.email = email;
    }

    return `${encodeBase64UrlJson({ alg: "none", typ: "JWT", cpa_synthetic: true })}.${encodeBase64UrlJson(payload)}.synthetic`;
  }

  function getExpiresIn(expiresAt, now = new Date()) {
    if (!expiresAt) {
      return undefined;
    }

    const expiresMs = new Date(expiresAt).getTime();
    if (Number.isNaN(expiresMs)) {
      return undefined;
    }

    return Math.max(0, Math.floor((expiresMs - now.getTime()) / 1000));
  }

  function getAxonHubLastRefresh(expiresAt, now = new Date()) {
    const expiresMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
    if (Number.isNaN(expiresMs)) {
      return normalizeTimestamp(now);
    }

    return new Date(expiresMs - 60 * 60 * 1000).toISOString();
  }

  function stripUnavailable(value) {
    if (Array.isArray(value)) {
      return value.map(stripUnavailable).filter((item) => item !== undefined);
    }

    if (isPlainObject(value)) {
      const entries = Object.entries(value)
        .map(([key, item]) => [key, stripUnavailable(item)])
        .filter(([, item]) => item !== undefined);
      return entries.length ? Object.fromEntries(entries) : undefined;
    }

    if (value === undefined || value === null || value === "") {
      return undefined;
    }

    return value;
  }

  function toEmailKey(email) {
    if (typeof email !== "string") {
      return undefined;
    }

    return email
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function sanitizeFileToken(value, fallback = "chatgpt-session") {
    const base = firstNonEmpty(value, fallback) || fallback;
    return base
      .replace(/\.[^.]+$/u, "")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 80) || fallback;
  }

  function getTimestampToken(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
    ].join("-") + "_" + [
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds()),
    ].join("-");
  }

  function formatDisplayDate(value) {
    if (!value) {
      return "";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }

    const pad = (item) => String(item).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function collectSessionLikeObjects(value, sourceName = "pasted-json") {
    const found = [];
    const visited = new WeakSet();

    function visit(item, path) {
      if (!isPlainObject(item) && !Array.isArray(item)) {
        return;
      }

      if (isPlainObject(item)) {
        if (visited.has(item)) {
          return;
        }
        visited.add(item);

        const token = firstNonEmpty(
          item.accessToken,
          item.access_token,
          item.tokens?.accessToken,
          item.tokens?.access_token,
          item.token?.accessToken,
          item.token?.access_token,
          item.credentials?.accessToken,
          item.credentials?.access_token,
        );
        const hasIdentity = isPlainObject(item.user) || firstNonEmpty(
          item.email,
          item.name,
          item.label,
          item.meta?.label,
          item.tokens?.accountId,
          item.tokens?.account_id,
          item.tokens?.chatgptAccountId,
          item.tokens?.chatgpt_account_id,
          item.providerSpecificData?.chatgptAccountId,
          item.providerSpecificData?.chatgpt_account_id,
          item.id,
        );
        if (token && hasIdentity) {
          found.push({ value: item, sourceName, path });
          return;
        }

        for (const [key, child] of Object.entries(item)) {
          if (key === "accessToken" || key === "access_token" || key === "sessionToken") {
            continue;
          }
          visit(child, `${path}.${key}`);
        }
        return;
      }

      item.forEach((child, index) => visit(child, `${path}[${index}]`));
    }

    visit(value, "$");
    return found;
  }

  function skipJsonWhitespace(text, index) {
    while (index < text.length && /[\s\uFEFF]/.test(text[index])) {
      index += 1;
    }
    return index;
  }

  function findJsonValueEnd(text, start) {
    const first = text[start];
    if (first !== "{" && first !== "[") {
      if (first === '"') {
        let escaped = false;
        for (let index = start + 1; index < text.length; index += 1) {
          const character = text[index];
          if (escaped) {
            escaped = false;
          } else if (character === "\\") {
            escaped = true;
          } else if (character === '"') {
            return index + 1;
          }
        }
        throw new Error("JSON 字符串未闭合");
      }

      let index = start;
      while (index < text.length && !/[\s\uFEFF]/.test(text[index])) {
        index += 1;
      }
      return index;
    }

    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{" || character === "[") {
        stack.push(character);
      } else if (character === "}" || character === "]") {
        stack.pop();
        if (stack.length === 0) {
          return index + 1;
        }
      }
    }
    throw new Error("JSON 对象未闭合");
  }

  function parseJsonValues(text) {
    if (typeof text !== "string" || text.trim() === "") {
      return [];
    }

    const values = [];
    let index = 0;
    let firstError = null;
    while ((index = skipJsonWhitespace(text, index)) < text.length) {
      if (text[index] !== "{" && text[index] !== "[") {
        const offset = text.slice(index).search(/[\[{]/);
        if (offset < 0) break;
        index += offset;
      }

      let end = null;
      try {
        const end = findJsonValueEnd(text, index);
        values.push(JSON.parse(text.slice(index, end)));
        index = end;
      } catch (error) {
        if (!firstError) firstError = error;
        // A balanced but invalid candidate may contain nested braces.
        // Skip the whole candidate so nested fragments are not imported.
        try {
          end = findJsonValueEnd(text, index);
        } catch {
          end = index + 1;
        }
        index = end;
      }
    }
    if (!values.length && firstError) throw new Error(`JSON 解析失败：${firstError.message}`);
    return values;
  }

  function parseInputDocuments(text) {
    return parseJsonValues(text).flatMap((parsed) => collectSessionLikeObjects(parsed));
  }

  function sub2apiAccountEmail(account, index) {
    const candidates = [
      account?.credentials?.email,
      account?.extra?.email,
      account?.email,
      account?.name,
      account?.extra?.email_key,
    ];
    const email = candidates.find((value) => typeof value === "string" && value.trim());
    if (!email) {
      throw new Error(`accounts 第 ${index} 项缺少邮箱字段`);
    }
    return email.trim().toLocaleLowerCase();
  }

  function parseSub2apiRecords(text) {
    const values = parseJsonValues(text);
    const records = [];
    const proxies = [];
    let firstDocument = null;

    values.forEach((value, valueIndex) => {
      if (!isPlainObject(value)) {
        throw new Error(`第 ${valueIndex + 1} 个顶层 JSON 必须是对象`);
      }
      if (value.type != null && value.type !== "sub2api-data") {
        throw new Error(`第 ${valueIndex + 1} 个 JSON 的 type 必须是 sub2api-data`);
      }
      if (!Array.isArray(value.accounts)) {
        throw new Error(`第 ${valueIndex + 1} 个 JSON 必须包含 accounts 数组`);
      }
      if (value.proxies != null && !Array.isArray(value.proxies)) {
        throw new Error(`第 ${valueIndex + 1} 个 JSON 的 proxies 必须是数组`);
      }
      if (!firstDocument) {
        firstDocument = value;
      } else if ((value.version ?? 1) !== (firstDocument.version ?? 1)) {
        throw new Error(`第 ${valueIndex + 1} 个 JSON 的 version 与首条记录不一致`);
      }
      proxies.push(...(value.proxies || []));
      value.accounts.forEach((account, accountIndex) => {
        if (!isPlainObject(account)) {
          throw new Error(`第 ${valueIndex + 1} 个 JSON 的 accounts 第 ${accountIndex + 1} 项必须是对象`);
        }
        records.push({
          account,
          type: value.type || "sub2api-data",
          version: value.version ?? 1,
          exportedAt: value.exported_at ?? null,
          proxies: value.proxies || [],
        });
      });
    });

    if (!firstDocument) {
      throw new Error("没有可处理的 sub2api JSON");
    }
    return { firstDocument, records, proxies };
  }

  function reorderSub2apiRecords(records) {
    const groups = new Map();
    records.forEach((record, index) => {
      const email = sub2apiAccountEmail(record.account, index + 1);
      if (!groups.has(email)) groups.set(email, []);
      groups.get(email).push(record);
    });
    if (!groups.size) return [];

    const maxRounds = Math.max(...Array.from(groups.values(), (items) => items.length));
    const ordered = [];
    let previousEmail = null;
    for (let round = 0; round < maxRounds; round += 1) {
      const roundEmails = Array.from(groups).filter(([, items]) => round < items.length).map(([email]) => email);
      const nextRoundEmails = Array.from(groups).filter(([, items]) => round + 1 < items.length).map(([email]) => email);
      if (roundEmails[0] === previousEmail && roundEmails.length > 1) {
        const replacement = roundEmails.findIndex((email) => email !== previousEmail);
        roundEmails.unshift(roundEmails.splice(replacement, 1)[0]);
      }
      if (nextRoundEmails.length === 1 && roundEmails.length > 1 && roundEmails.at(-1) === nextRoundEmails[0]) {
        for (let index = roundEmails.length - 2; index >= 0; index -= 1) {
          const firstAfterSwap = index === 0 ? roundEmails.at(-1) : roundEmails[0];
          if (roundEmails[index] !== nextRoundEmails[0] && firstAfterSwap !== previousEmail) {
            [roundEmails[index], roundEmails[roundEmails.length - 1]] = [roundEmails.at(-1), roundEmails[index]];
            break;
          }
        }
      }
      roundEmails.forEach((email) => {
        ordered.push(groups.get(email)[round]);
        previousEmail = email;
      });
    }
    for (let index = 1; index < ordered.length; index += 1) {
      if (sub2apiAccountEmail(ordered[index - 1].account, index) === sub2apiAccountEmail(ordered[index].account, index + 1)) {
        throw new Error("无法保证相邻账号邮箱不重复");
      }
    }
    return ordered;
  }

  function compactSub2apiLine(record) {
    return JSON.stringify({
      type: record.type,
      version: record.version,
      exported_at: record.exportedAt,
      proxies: record.proxies,
      accounts: [applySub2apiOutputConfig(record.account)],
    });
  }

  function applySub2apiOutputConfig(account) {
    const models = Array.from(new Set(String(elements.sub2apiModels.value || "")
      .split(/[\s,;]+/)
      .map((value) => value.trim())
      .filter(Boolean)));
    const effectiveModels = models.length ? models : ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra"];
    const concurrency = Math.max(1, Math.min(1000, Math.trunc(Number(elements.sub2apiConcurrency.value) || 50)));
    const loadFactor = Math.max(1, Math.min(10000, Math.trunc(Number(elements.sub2apiLoadFactor.value) || 1000)));
    const priority = Math.max(1, Math.trunc(Number(elements.sub2apiPriority.value) || 1));
    const fingerprintMode = ["off", "device", "session", "full"].includes(elements.sub2apiFingerprintMode.value)
      ? elements.sub2apiFingerprintMode.value
      : "session";
    return {
      ...account,
      concurrency,
      load_factor: loadFactor,
      priority,
      credentials: {
        ...(account?.credentials || {}),
        model_mapping: Object.fromEntries(effectiveModels.map((model) => [model, model])),
      },
      extra: {
        ...(account?.extra || {}),
        codex_fingerprint_mode: fingerprintMode,
      },
    };
  }

  function extractEmails(value) {
    if (typeof value !== "string") return [];
    const normalized = value
      .normalize("NFKC")
      .replace(/[\u0000\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/-{2,}/g, " ");
    return (normalized.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi) || [])
      .map((email) => email.toLocaleLowerCase());
  }

  function parseMailCsv(text) {
    return new Set(extractEmails(String(text || "")));
  }

  function sub2apiRecordEmails(record) {
    const account = record.account;
    const candidates = [
      account?.name,
      account?.email,
      account?.mail,
      account?.username,
      account?.user?.email,
      account?.credentials?.email,
      account?.credentials?.mail,
      account?.credentials?.username,
      account?.credentials?.user?.email,
      account?.extra?.email,
      account?.extra?.mail,
      account?.extra?.email_address,
    ];
    return new Set(candidates.flatMap(extractEmails));
  }

  function buildSub2apiToolResult(text, recordsOverride = null) {
    const parsed = parseSub2apiRecords(text);
    if (recordsOverride) parsed.records = recordsOverride;
    const operation = elements.sub2apiOperation.value || "json-to-txt";
    const records = operation === "json-to-txt" ? reorderSub2apiRecords(parsed.records) : parsed.records;
    if (operation === "split") {
      const emails = parseMailCsv(elements.mailInput.value);
      if (!emails.size) throw new Error("mail.csv 中没有有效邮箱");
      const matched = [];
      const unmatched = [];
      records.forEach((record) => {
        const line = compactSub2apiLine(record);
        const isMatch = Array.from(sub2apiRecordEmails(record)).some((email) => emails.has(email));
        (isMatch ? matched : unmatched).push(line);
      });
      return {
        accountCount: records.length,
        extension: "txt",
        matchedCount: matched.length,
        unmatchedCount: unmatched.length,
        matchedText: matched.join("\n") + (matched.length ? "\n" : ""),
        unmatchedText: unmatched.join("\n") + (unmatched.length ? "\n" : ""),
      };
    }

    if (operation === "txt-to-json") {
      const accounts = records.map((record) => applySub2apiOutputConfig(record.account));
      const version = parsed.firstDocument?.version ?? 1;
      const proxies = [...new Set(parsed.proxies || [])];
      return {
        accountCount: accounts.length,
        extension: "json",
        outputText: JSON.stringify({
          type: parsed.firstDocument?.type || "sub2api-data",
          version,
          exported_at: parsed.firstDocument?.exported_at || new Date().toISOString(),
          proxies,
          accounts,
        }, null, 2),
      };
    }
    const lines = records.map(compactSub2apiLine);
    return {
      accountCount: records.length,
      extension: "txt",
      outputText: lines.join("\n") + (lines.length ? "\n" : ""),
    };
  }

  function convertSession(record, options = {}) {
    if (!isPlainObject(record)) {
      throw new Error("session 不是 JSON 对象");
    }

    const accessToken = firstNonEmpty(
      record.accessToken,
      record.access_token,
      record.tokens?.accessToken,
      record.tokens?.access_token,
      record.token?.accessToken,
      record.token?.access_token,
      record.credentials?.accessToken,
      record.credentials?.access_token,
    );
    if (!accessToken) {
      throw new Error("缺少 accessToken");
    }
    const sessionToken = firstNonEmpty(
      record.sessionToken,
      record.session_token,
      record.tokens?.sessionToken,
      record.tokens?.session_token,
      record.token?.sessionToken,
      record.token?.session_token,
      record.credentials?.session_token,
    );
    const refreshToken = firstNonEmpty(
      record.refreshToken,
      record.refresh_token,
      record.tokens?.refreshToken,
      record.tokens?.refresh_token,
      record.token?.refreshToken,
      record.token?.refresh_token,
      record.credentials?.refresh_token,
    );
    const inputIdToken = firstNonEmpty(
      record.idToken,
      record.id_token,
      record.tokens?.idToken,
      record.tokens?.id_token,
      record.token?.idToken,
      record.token?.id_token,
      record.credentials?.id_token,
    );

    const payload = parseJwtPayload(accessToken);
    const idPayload = parseJwtPayload(inputIdToken);
    const auth = getOpenAIAuthSection(payload);
    const idAuth = getOpenAIAuthSection(idPayload);
    const profile = getOpenAIProfileSection(payload);
    const hasRefreshToken = Boolean(refreshToken);
    const accessTokenExpiresAt = hasRefreshToken ? undefined : unixSecondsFromJwtExp(payload?.exp);
    const expiresAt = hasRefreshToken ? undefined : firstNonEmpty(
      payload ? timestampFromUnixSeconds(payload.exp) : undefined,
      normalizeTimestamp(record.expires),
      normalizeTimestamp(record.expiresAt),
      normalizeTimestamp(record.expired),
      normalizeTimestamp(record.expires_at),
    );
    const email = firstNonEmpty(
      record.user?.email,
      record.email,
      record.meta?.label,
      record.label,
      record.credentials?.email,
      record.providerSpecificData?.email,
      profile.email,
      idPayload?.email,
      payload?.email,
    );
    const accountId = firstNonEmpty(
      record.account?.id,
      record.account_id,
      record.tokens?.accountId,
      record.tokens?.account_id,
      record.chatgptAccountId,
      record.chatgpt_account_id,
      record.meta?.chatgptAccountId,
      record.meta?.chatgpt_account_id,
      record.tokens?.chatgptAccountId,
      record.tokens?.chatgpt_account_id,
      record.providerSpecificData?.chatgptAccountId,
      record.providerSpecificData?.chatgpt_account_id,
      record.credentials?.chatgpt_account_id,
      auth.chatgpt_account_id,
      idAuth.chatgpt_account_id,
      record.provider === "codex" ? record.id : undefined,
    );
    const chatgptAccountId = firstNonEmpty(
      record.chatgptAccountId,
      record.chatgpt_account_id,
      record.meta?.chatgptAccountId,
      record.meta?.chatgpt_account_id,
      record.tokens?.chatgptAccountId,
      record.tokens?.chatgpt_account_id,
      record.providerSpecificData?.chatgptAccountId,
      record.providerSpecificData?.chatgpt_account_id,
      record.credentials?.chatgpt_account_id,
      auth.chatgpt_account_id,
      idAuth.chatgpt_account_id,
    );
    const workspaceId = firstNonEmpty(
      record.account?.workspaceId,
      record.account?.workspace_id,
      record.workspaceId,
      record.workspace_id,
      record.meta?.workspaceId,
      record.meta?.workspace_id,
      record.providerSpecificData?.workspaceId,
      record.providerSpecificData?.workspace_id,
      record.credentials?.workspace_id,
      payload?.workspace_id,
      idPayload?.workspace_id,
    );
    const userId = firstNonEmpty(
      record.user?.id,
      record.user_id,
      record.chatgptUserId,
      record.providerSpecificData?.chatgptUserId,
      record.providerSpecificData?.chatgpt_user_id,
      auth.chatgpt_user_id,
      auth.user_id,
      idAuth.chatgpt_user_id,
      idAuth.user_id,
    );
    const planType = firstNonEmpty(
      record.account?.planType,
      record.account?.plan_type,
      record.planType,
      record.plan_type,
      record.providerSpecificData?.chatgptPlanType,
      record.providerSpecificData?.chatgpt_plan_type,
      record.credentials?.plan_type,
      auth.chatgpt_plan_type,
      idAuth.chatgpt_plan_type,
    );
    const exportedAt = normalizeTimestamp(options.now || new Date());
    const expiresIn = getExpiresIn(expiresAt, options.now || new Date());
    const sourceName = firstNonEmpty(options.sourceName, "pasted-json");
    const sourceType = record.provider === "codex" && record.authType === "oauth" ? "9router" : "chatgpt_web_session";
    const name = firstNonEmpty(email, sourceName, "ChatGPT Account");
    const syntheticIdToken = !inputIdToken
      ? buildSyntheticCodexIdToken(email, accountId, planType, userId, expiresAt)
      : undefined;
    const idToken = firstNonEmpty(inputIdToken, syntheticIdToken);

    const cpa = Object.fromEntries(Object.entries({
      type: "codex",
      account_id: accountId,
      chatgpt_account_id: accountId,
      email,
      name,
      plan_type: planType,
      chatgpt_plan_type: planType,
      id_token: idToken,
      id_token_synthetic: Boolean(syntheticIdToken) || undefined,
      access_token: accessToken,
      refresh_token: refreshToken || "",
      session_token: sessionToken,
      last_refresh: exportedAt,
      expired: expiresAt,
      disabled: Boolean(record.disabled) || undefined,
    }).filter(([, value]) => value !== undefined && value !== null));

    const cockpit = {
      type: "codex",
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken || "",
      account_id: accountId,
      last_refresh: exportedAt,
      email,
      expired: expiresAt,
      account_note: firstNonEmpty(record.account_note, record.accountInfo, record.account_info, record.note, record.notes, record.remark),
    };

    const sub2apiAccount = stripUnavailable({
      name: firstNonEmpty(name, email, sourceName, "ChatGPT Account"),
      platform: "openai",
      type: "oauth",
      expires_at: accessTokenExpiresAt,
      auto_pause_on_expired: accessTokenExpiresAt ? true : undefined,
      concurrency: 50,
      priority: 1,
      credentials: {
        access_token: accessToken,
        refresh_token: refreshToken,
        id_token: inputIdToken,
        chatgpt_account_id: accountId,
        chatgpt_user_id: userId,
        email,
        expires_at: expiresAt,
        expires_in: expiresIn,
        plan_type: planType,
        model_mapping: {
          "gpt-5.5": "gpt-5.5",
          "gpt-5.6-sol": "gpt-5.6-sol",
          "gpt-5.6-terra": "gpt-5.6-terra",
          "gpt-6-astra": "gpt-6-astra",
        },
      },
      extra: {
        email,
        email_key: toEmailKey(email),
        name,
        auth_provider: firstNonEmpty(record.authProvider, record.auth_provider),
        source: sourceType,
        last_refresh: exportedAt,
        codex_fingerprint_mode: "session",
      },
    });
    const priority = Number.isFinite(Number(record.priority)) ? Number(record.priority) : 9;
    const isActive = typeof record.isActive === "boolean" ? record.isActive : !Boolean(record.disabled);
    const createdAt = normalizeTimestamp(record.createdAt) || exportedAt;
    const updatedAt = normalizeTimestamp(record.updatedAt) || exportedAt;
    const nineRouter = stripUnavailable({
      accessToken,
      refreshToken,
      expiresAt,
      testStatus: firstNonEmpty(record.testStatus, record.test_status, "active"),
      expiresIn,
      providerSpecificData: {
        chatgptAccountId: accountId,
        chatgptPlanType: planType,
      },
      id: accountId,
      provider: "codex",
      authType: "oauth",
      name,
      email,
      priority,
      isActive,
      createdAt,
      updatedAt,
    });
    const axonHubRefreshToken = refreshToken || AXONHUB_PLACEHOLDER_REFRESH_TOKEN;
    const codexAuthJson = {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken,
        access_token: accessToken,
        refresh_token: refreshToken || "",
        account_id: accountId,
      },
      last_refresh: exportedAt,
    };
    const axonHub = stripUnavailable({
      auth_mode: "chatgpt",
      last_refresh: getAxonHubLastRefresh(expiresAt, options.now || new Date()),
      tokens: {
        access_token: accessToken,
        refresh_token: axonHubRefreshToken,
        id_token: idToken,
      },
      axonhub_refresh_token_placeholder: refreshToken ? undefined : true,
      axonhub_note: refreshToken ? undefined : "refresh_token is a placeholder; access_token works only until it expires.",
    });
    const codexManagerTokenHints = Object.fromEntries(Object.entries({
      account_id: accountId,
      chatgpt_account_id: chatgptAccountId,
    }).filter(([, value]) => value !== undefined && value !== null && value !== ""));
    const codexManagerMeta = Object.fromEntries(Object.entries({
      label: firstNonEmpty(name, email, sourceName, "ChatGPT Account"),
      workspace_id: workspaceId,
      chatgpt_account_id: chatgptAccountId,
      note: "Imported from ChatGPT session",
    }).filter(([, value]) => value !== undefined && value !== null && value !== ""));
    const codexManager = {
      tokens: {
        access_token: accessToken,
        refresh_token: refreshToken || "",
        id_token: inputIdToken || "",
        ...codexManagerTokenHints,
      },
      meta: codexManagerMeta,
    };

    return {
      sourceName,
      sourcePath: options.sourcePath,
      email,
      name,
      expiresAt,
      accessTokenExpiresAt,
      cpa,
      cockpit,
      nineRouter,
      codexAuthJson,
      axonHub,
      codexManager,
      sub2apiAccount,
    };
  }

  function buildSub2apiDocument(converted, now = new Date()) {
    return {
      exported_at: normalizeTimestamp(now),
      proxies: [],
      accounts: converted.map((item) => applySub2apiOutputConfig(item.sub2apiAccount)),
    };
  }

  function buildOutputDocument(converted = state.converted) {
    const now = new Date();
    if (state.format === "sub2api") {
      return buildSub2apiDocument(converted, now);
    }

    if (state.format === "cpa") {
      return converted.length === 1 ? converted[0].cpa : converted.map((item) => item.cpa);
    }

    if (state.format === "cockpit") {
      return converted.length === 1 ? converted[0].cockpit : converted.map((item) => item.cockpit);
    }

    if (state.format === "9router") {
      return converted.length === 1 ? converted[0].nineRouter : converted.map((item) => item.nineRouter);
    }

    if (state.format === "codex") {
      return converted.length === 1 ? converted[0].codexAuthJson : converted.map((item) => item.codexAuthJson);
    }

    if (state.format === "axonhub") {
      return converted.length === 1 ? converted[0].axonHub : converted.map((item) => item.axonHub);
    }

    if (state.format === "codexmanager") {
      return converted.length === 1 ? converted[0].codexManager : converted.map((item) => item.codexManager);
    }

    return buildSub2apiDocument(converted, now);
  }

  function healthComplete() {
    return state.converted.length > 0 && state.health.length === state.converted.length;
  }

  function canLogoutAllSessions() {
    return state.format === "sub2api"
      && healthComplete()
      && state.health.some((item) => item?.status === 200)
      && !state.logoutInProgress;
  }

  function resetLogoutAllSessions() {
    state.logoutRun += 1;
    state.logoutInProgress = false;
    state.logoutResults = [];
    state.logoutLog = [];
    elements.logoutProgress.classList.add("hidden");
    elements.logoutProgress.textContent = "";
  }

  function renderLogoutProgress() {
    elements.logoutProgress.textContent = state.logoutLog.join("\n");
    elements.logoutProgress.classList.toggle("hidden", !state.logoutLog.length);
  }

  function syncLogoutAllSessionsButton() {
    const visible = state.format === "sub2api";
    elements.logoutAllSessions.classList.toggle("hidden", !visible);
    elements.logoutAllSessions.disabled = !canLogoutAllSessions();
    elements.logoutAllSessions.textContent = state.logoutInProgress ? "正在退出会话..." : "退出全部会话";
  }

  async function logoutAllHealthySessions() {
    if (monitorBusy) return;
    const isCurrent = workspaceTaskIsCurrent();
    if (!canLogoutAllSessions()) return;
    const accounts = state.converted
      .map((item, index) => ({ item, result: state.health[index], index }))
      .filter(({ result }) => result?.status === 200)
      .map(({ item, index }) => ({
        index,
        email: item.email || item.name || `account-${index + 1}`,
        accessToken: item.cpa?.access_token,
        accountId: item.sub2apiAccount?.credentials?.chatgpt_account_id,
      }));
    if (!accounts.length) return;
    if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(`将退出 ${accounts.length} 个测活成功账号的全部 ChatGPT 会话，是否继续？`)) return;
    const run = ++state.logoutRun;
    state.logoutInProgress = true;
    state.logoutResults = [];
    state.logoutLog = [`开始退出 ${accounts.length} 个测活成功账号（并发 ${selectedTaskConcurrency()}）...`, ...accounts.map((account) => `${account.email}：排队中`)];
    renderLogoutProgress();
    syncLogoutAllSessionsButton();
    setStatus(elements.healthStatus, `正在退出 ${accounts.length} 个账号的全部会话，并发 ${selectedTaskConcurrency()}...`);
    try {
      const response = await pageFetch("/api/logout-all-sessions", {
        method: "POST",
        credentials: "same-origin",
        headers: loginProxyHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ accounts, concurrency: selectedTaskConcurrency() }),
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      if (!isCurrent() || run !== state.logoutRun) return;
      state.logoutResults = Array.isArray(payload.results) ? payload.results : [];
      state.logoutLog = [
        `退出任务完成：成功 ${payload.succeeded || 0}，失败 ${payload.failed || 0}。`,
        ...state.logoutResults.map((item) => `${item.email || `account-${item.index + 1}`}：${item.ok ? `测活 HTTP ${item.probeStatus}，退出 HTTP ${item.logoutStatus}` : (item.error || "失败")}`),
      ];
      renderLogoutProgress();
      const succeeded = Number(payload.succeeded) || state.logoutResults.filter((item) => item.ok).length;
      const failed = Number(payload.failed) || state.logoutResults.filter((item) => !item.ok).length;
      setStatus(elements.healthStatus, `退出全部会话完成：成功 ${succeeded}，失败 ${failed}。${failed ? "可重新点击按钮重试失败账号。" : ""}`, failed ? "error" : "ok");
    } catch (error) {
      if (!isCurrent() || run !== state.logoutRun) return;
      state.logoutResults = [];
      state.logoutLog = [`退出任务失败：${error instanceof Error ? error.message : String(error)}`];
      renderLogoutProgress();
      setStatus(elements.healthStatus, `退出全部会话失败：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      if (isCurrent() && run === state.logoutRun) {
        state.logoutInProgress = false;
        syncLogoutAllSessionsButton();
        renderHealth();
      }
    }
  }

  function toolHealthComplete() {
    return state.toolRecords.length > 0 && state.health.length === state.toolRecords.length;
  }

  function recordUsage(record, result) {
    const usage = result?.usage || usageFromExtra(record?.account?.extra);
    if (!usage) return null;
    const planType = firstNonEmpty(
      usage.planType,
      record?.account?.credentials?.plan_type,
      record?.account?.plan_type,
      record?.account?.extra?.plan_type,
    );
    return planType && !usage.planType ? { ...usage, planType } : usage;
  }

  function planIsK12(planType) {
    const value = String(planType || "").trim().toLocaleLowerCase();
    return value === "k12" || value === "chatgpt_k12" || value.includes("k-12");
  }

  function planHasNoFiveHourWindow(planType) {
    const value = String(planType || "").trim();
    return Boolean(value) && !planIsK12(value);
  }

  function usageWindowKnown(window) {
    return window != null && Number.isFinite(Number(window.usedPercent));
  }

  function usageHasExpectedWindows(usage) {
    if (!usageWindowKnown(usage?.sevenDay)) return false;
    return planHasNoFiveHourWindow(usage.planType) || usageWindowKnown(usage.fiveHour);
  }

  function usageIsUnused(usage) {
    if (!usageHasExpectedWindows(usage)) return false;
    const sevenDayUnused = Number(usage.sevenDay.usedPercent) === 0;
    const fiveHourUnused = planHasNoFiveHourWindow(usage.planType) || Number(usage.fiveHour.usedPercent) === 0;
    return fiveHourUnused && sevenDayUnused;
  }

  function hasToolUsageSnapshots() {
    return state.toolRecords.some((record, index) => Boolean(recordUsage(record, state.health[index])));
  }

  function usageMatchesFilter(record, result) {
    if (!hasToolUsageSnapshots()) return true;
    const usage = recordUsage(record, result);
    switch (elements.usageFilter.value) {
      case "used":
        return Boolean(usage && (Number(usage.fiveHour?.usedPercent) > 0 || Number(usage.sevenDay?.usedPercent) > 0));
      case "unknown":
        return !usageHasExpectedWindows(usage);
      case "all":
        return true;
      case "unused":
      default:
        return usageIsUnused(usage);
    }
  }

  function selectedToolRecords() {
    if (elements.sub2apiOperation.value === "split") return state.toolRecords;
    if (!toolHealthComplete()) return state.toolRecords;
    return state.toolRecords.filter((record, index) => {
      const result = state.health[index];
      if (elements.downloadScope.value === "non200") return result?.status !== 200;
      return (elements.downloadScope.value === "all" || result?.status === 200) && usageMatchesFilter(record, result);
    });
  }

  function selectedConverted() {
    if (!healthComplete() || elements.downloadScope.value === "all") return state.converted;
    const include200 = elements.downloadScope.value !== "non200";
    return state.converted.filter((_, index) => include200 ? state.health[index]?.status === 200 : state.health[index]?.status !== 200);
  }

  function formatDuration(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const days = Math.floor(value / 86400);
    const hours = Math.floor((value % 86400) / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    if (days) return `${days}天${hours}小时`;
    if (hours) return `${hours}小时${minutes}分`;
    return `${minutes}分钟`;
  }

  function usageFromExtra(extra) {
    if (!extra || typeof extra !== "object") return null;
    const makeWindow = (prefix) => {
      const used = Number(extra[`${prefix}_used_percent`]);
      if (!Number.isFinite(used)) return null;
      const reset = Number(extra[`${prefix}_reset_after_seconds`]);
      return { usedPercent: used, resetAfterSeconds: Number.isFinite(reset) ? reset : null };
    };
    const fiveHour = makeWindow("codex_5h");
    const sevenDay = makeWindow("codex_7d");
    if (!fiveHour && !sevenDay) return null;
    return { fiveHour, sevenDay, fetchedAt: extra.codex_usage_updated_at ? Date.parse(extra.codex_usage_updated_at) : null };
  }

  function healthRow(item, result, logout) {
     const status = result?.status == null ? `失败：${result?.error || "未知错误"}` : `HTTP ${result.status}`;
     const logoutText = logout?.ok ? "；已退出全部会话" : (logout && logout.error ? `；退出失败：${logout.error}` : "");
     // Some plan payloads (notably team/plus) now include a 5-hour
     // window again. Prefer the returned data even when the plan
     // fallback classification says that window may be absent.
     const formatWindow = (window, unavailable = false) => unavailable && !window ? "不适用" : (window?.usedPercent == null ? "未知" : `${window.usedPercent}%${window.resetAfterSeconds != null ? `（${formatDuration(window.resetAfterSeconds)} 后）` : ""}`);
     const usage = result?.usage || item.usage;
     const updatedAt = usage?.fetchedAt ? new Date(usage.fetchedAt).toLocaleString() : "未知";
     return `<tr>
       <td><div class="cell-clip" title="${escapeHtml(item.name)}">${escapeHtml(item.name || "-")}</div></td>
       <td><div class="cell-clip" title="${escapeHtml(item.email)}">${escapeHtml(item.email || "-")}</div></td>
       <td><div class="cell-clip" title="${escapeHtml(status + logoutText)}">${escapeHtml(status + logoutText)}</div></td>
       <td>${escapeHtml(formatWindow(usage?.fiveHour, planHasNoFiveHourWindow(usage?.planType)))}</td>
       <td>${escapeHtml(formatWindow(usage?.sevenDay))}</td>
       <td>${escapeHtml(updatedAt)}</td>
       <td><div class="cell-clip" title="${escapeHtml(item.sourceName)}">${escapeHtml(item.sourceName || "pasted-json")}</div></td>
     </tr>`;
   }

  function renderHealth() {
    if (state.format === "sub2api-tools") {
      if (!toolHealthComplete()) {
         elements.healthBody.innerHTML = '<tr><td colspan="7" class="empty">等待测活。</td></tr>';
        return;
      }
      const show200 = elements.healthFilter.value !== "non200";
      const filtered = state.toolRecords
        .map((record, index) => ({ record, result: state.health[index] }))
        .filter(({ record, result }) => {
          if (!show200) return result?.status !== 200;
          return result?.status === 200 && usageMatchesFilter(record, result);
        });
      elements.healthBody.innerHTML = filtered.map(({ record, result }) => healthRow({
        name: record.account?.name,
        email: record.account?.credentials?.email || record.account?.extra?.email,
        sourceName: "sub2api",
       }, { ...result, usage: recordUsage(record, result) }, state.logoutResults.find((item) => item.index === result?.index))).join("") || `<tr><td colspan="7" class="empty">没有符合当前筛选的账号。</td></tr>`;
      return;
    }
    const complete = healthComplete();
    if (!complete) {
       elements.healthBody.innerHTML = '<tr><td colspan="7" class="empty">等待测活。</td></tr>';
      return;
    }
    const show200 = elements.healthFilter.value !== "non200";
    const filtered = state.converted
      .map((item, index) => ({ item, result: state.health[index] }))
      .filter(({ result }) => show200 ? result?.status === 200 : result?.status !== 200);
    elements.healthBody.innerHTML = filtered
      .map(({ item, result }) => healthRow(item, result, state.logoutResults.find((logout) => logout.index === result?.index)))
       .join("") || `<tr><td colspan="7" class="empty">没有${show200 ? " HTTP 200" : "非 200"}账号。</td></tr>`;
  }

  async function readJsonResponse(response) {
    if (typeof response.text !== "function") {
      try { return await response.json(); }
      catch { throw new Error(`服务返回空响应（HTTP ${response.status}）`); }
    }
    const text = await response.text();
    if (!text.trim()) throw new Error(`服务返回空响应（HTTP ${response.status}）`);
    try { return JSON.parse(text); }
    catch { throw new Error(`服务返回非 JSON 响应（HTTP ${response.status}）`); }
  }

  async function startHealthCheck() {
    const isCurrent = workspaceTaskIsCurrent();
    const run = ++state.healthRun;
    state.health = [];
    resetLogoutAllSessions();
    renderHealth();
    updateOutput();
    if (!state.converted.length) {
      setStatus(elements.healthStatus, "等待自动测活。");
      return;
    }
    const concurrency = selectedTaskConcurrency();
    setStatus(elements.healthStatus, `正在测活 ${state.converted.length} 个账号，并发 ${concurrency}...`);
    try {
      const response = await pageFetch("/api/session-health", {
        method: "POST",
        credentials: "same-origin",
        headers: loginProxyHeaders({ "Content-Type": "application/json" }),
         body: JSON.stringify({ includeUsage: true, concurrency, accounts: state.converted.map((item) => ({ accessToken: item.cpa.access_token, accountId: item.sub2apiAccount?.credentials?.chatgpt_account_id })) }),
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      if (!isCurrent() || run !== state.healthRun) return;
      state.health = Array.isArray(payload.results) ? payload.results : [];
      if (!healthComplete()) throw new Error("测活接口返回结果不完整");
      const ok = state.health.filter((item) => item.status === 200).length;
      const failed = state.health.filter((item) => item.status == null).length;
      const forbidden = state.health.filter((item) => item.status === 403).length;
      setStatus(elements.healthStatus, `测活完成：HTTP 200 ${ok}，非 200 ${state.health.length - ok}，403 拒绝 ${forbidden}，失败 ${failed}。`, forbidden || failed ? "error" : "ok");
      renderHealth();
      updateOutput();
    } catch (error) {
      if (!isCurrent() || run !== state.healthRun) return;
      state.health = [];
      renderHealth();
      updateOutput();
      setStatus(elements.healthStatus, `自动测活失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  async function startToolHealthCheck() {
    const isCurrent = workspaceTaskIsCurrent();
    const run = ++state.healthRun;
    state.health = [];
    resetLogoutAllSessions();
    renderHealth();
    updateOutput();
    if (!state.toolRecords.length) {
      setStatus(elements.healthStatus, "等待自动测活。");
      return;
    }
    const concurrency = selectedTaskConcurrency();
    setStatus(elements.healthStatus, `正在测活 ${state.toolRecords.length} 个账号，并发 ${concurrency}...`);
    try {
      const response = await pageFetch("/api/session-health", {
        method: "POST",
        credentials: "same-origin",
        headers: loginProxyHeaders({ "Content-Type": "application/json" }),
         body: JSON.stringify({ includeUsage: true, concurrency, accounts: state.toolRecords.map((record) => ({
           accessToken: record.account?.credentials?.access_token || record.account?.credentials?.accessToken || record.account?.access_token || record.account?.accessToken,
           accountId: record.account?.credentials?.chatgpt_account_id || record.account?.credentials?.account_id,
         })) }),
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      if (!isCurrent() || run !== state.healthRun) return;
      state.health = Array.isArray(payload.results) ? payload.results : [];
      if (!toolHealthComplete()) throw new Error("测活接口返回结果不完整");
      const ok = state.health.filter((item) => item.status === 200).length;
      const failed = state.health.filter((item) => item.status == null).length;
      const forbidden = state.health.filter((item) => item.status === 403).length;
      setStatus(elements.healthStatus, `测活完成：HTTP 200 ${ok}，非 200 ${state.health.length - ok}，403 拒绝 ${forbidden}，失败 ${failed}。`, forbidden || failed ? "error" : "ok");
      renderHealth();
      updateOutput();
    } catch (error) {
      if (!isCurrent() || run !== state.healthRun) return;
      state.health = [];
      renderHealth();
      updateOutput();
      setStatus(elements.healthStatus, `自动测活失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  function convertFromText(text) {
    if (state.format === "sub2api-tools") {
      state.healthRun += 1;
      state.health = [];
      resetLogoutAllSessions();
      state.converted = [];
      state.skipped = [];
      state.sessions = [];
      state.toolParsed = null;
      state.toolRecords = [];
      state.toolParsed = parseSub2apiRecords(text);
      state.toolRecords = state.toolParsed.records;
      state.toolResult = buildSub2apiToolResult(text, selectedToolRecords());
      updateOutput();
      startToolHealthCheck();
      return;
    }

    state.toolResult = null;
    state.toolParsed = null;
    state.toolRecords = [];
    const sources = parseInputDocuments(text);
    const converted = [];
    const skipped = [];
    const now = new Date();

    sources.forEach((item, index) => {
      try {
        converted.push(convertSession(item.value, {
          now,
          sourceName: item.sourceName,
          sourcePath: item.path || `$[${index}]`,
        }));
      } catch (error) {
        skipped.push({
          sourceName: item.sourceName,
          path: item.path,
          reason: error instanceof Error ? error.message : "无法转换",
        });
      }
    });

    if (!sources.length) {
      skipped.push({
        sourceName: "pasted-json",
        path: "$",
        reason: "未找到包含 accessToken 和 user/email 的 session 对象",
      });
    }

    state.converted = converted;
    state.skipped = skipped;
    state.sessions = sources;
    updateOutput();
    startHealthCheck();
  }

  function setStatus(element, text, tone = "") {
    persistBrowserWorkspace();
    element.textContent = text;
    if (element === elements.pushStatus) elements.pushFeedback.hidden = !text && !state.pushResults.length;
    element.classList.toggle("is-ok", tone === "ok");
    element.classList.toggle("is-error", tone === "error");
  }

  function updateOutput() {
    updatePushControls();
    persistBrowserWorkspace();
    const isTool = state.format === "sub2api-tools";
    const isLogin = state.format === "protocol-login";
    const hasConverted = state.converted.length > 0;
    let outputText = "";

    if (isTool && state.toolParsed) {
      state.toolResult = buildSub2apiToolResult(elements.input.value, selectedToolRecords());
    }
    if (isTool && state.toolResult) {
      outputText = elements.sub2apiOperation.value === "split"
        ? (elements.splitScope.value === "unmatched" ? state.toolResult.unmatchedText : state.toolResult.matchedText)
        : state.toolResult.outputText;
    } else if (!isLogin && hasConverted) {
      outputText = JSON.stringify(buildOutputDocument(selectedConverted()), null, 2);
    }

    state.outputText = outputText;
    elements.output.value = outputText;
    elements.copyOutput.disabled = !outputText;
    elements.downloadOutput.disabled = isLogin || !outputText || (!isTool && elements.downloadScope.value === "200" && !healthComplete());
    elements.statCount.textContent = String(isTool ? (state.toolResult?.accountCount || 0) : (isLogin ? state.loginLastAccounts.length : state.converted.length));
    elements.statErrors.textContent = String(state.skipped.length);
    elements.statFormat.textContent = OUTPUT_LABELS[state.format];
    elements.outputSubtitle.textContent = isTool ? "当前输出为 sub2api 批处理结果。" : (isLogin ? "协议登录完成后可导出 sub2api JSON。" : `当前输出为 ${OUTPUT_LABELS[state.format]} 导入 JSON。`);
    elements.downloadOutput.textContent = isTool && elements.sub2apiOperation.value === "split"
      ? "下载当前组"
      : (isTool && state.toolResult?.extension === "txt" ? "下载 TXT" : "下载 JSON");
    const isSplit = isTool && elements.sub2apiOperation.value === "split";
    elements.splitDownloads.classList.toggle("hidden", !isSplit);
    elements.downloadMatched.textContent = `下载匹配邮箱 (${state.toolResult?.matchedCount || 0})`;
    elements.downloadUnmatched.textContent = `下载未匹配邮箱 (${state.toolResult?.unmatchedCount || 0})`;
    elements.downloadMatched.disabled = !isSplit || !state.toolResult?.matchedText;
    elements.downloadUnmatched.disabled = !isSplit || !state.toolResult?.unmatchedText;
    elements.cpaNotice.style.display = ["cpa", "cockpit", "codex", "axonhub", "codexmanager"].includes(state.format) ? "block" : "none";
    if (elements.downloadScope.parentElement) elements.downloadScope.parentElement.style.display = "";

    renderAccounts();
    renderHealth();
    renderIssues();
    syncLogoutAllSessionsButton();

    if (isSplit && state.toolResult) {
      setStatus(elements.outputStatus, `拆分完成：匹配 ${state.toolResult.matchedCount}，未匹配 ${state.toolResult.unmatchedCount}。`, "ok");
    } else if (outputText) {
      setStatus(elements.outputStatus, `已生成 ${isTool ? state.toolResult.accountCount : state.converted.length} 个账号。`, "ok");
    } else {
      setStatus(elements.outputStatus, "暂无输出。", state.skipped.length ? "error" : "");
    }
  }

  function renderAccounts() {
    if (!state.converted.length) {
      elements.accountBody.innerHTML = '<tr><td colspan="4" class="empty">暂无可转换账号。</td></tr>';
      return;
    }

    elements.accountBody.innerHTML = state.converted.map((item) => `
      <tr>
        <td><div class="cell-clip" title="${escapeHtml(item.name)}">${escapeHtml(item.name || "-")}</div></td>
        <td><div class="cell-clip" title="${escapeHtml(item.email)}">${escapeHtml(item.email || "-")}</div></td>
        <td><div class="cell-clip" title="${escapeHtml(item.expiresAt)}">${escapeHtml(formatDisplayDate(item.expiresAt) || "-")}</div></td>
        <td><div class="cell-clip" title="${escapeHtml(item.sourceName)}">${escapeHtml(item.sourceName || "pasted-json")}</div></td>
      </tr>
    `).join("");
  }

  function renderIssues() {
    if (!state.skipped.length) {
      elements.issues.classList.remove("is-visible");
      elements.issues.textContent = "";
      return;
    }

    elements.issues.classList.add("is-visible");
    elements.issues.innerHTML = state.skipped
      .map((item) => `<div>${escapeHtml(item.sourceName || "input")} ${escapeHtml(item.path || "")}: ${escapeHtml(item.reason)}</div>`)
      .join("");
  }

  function scheduleConvert() {
    const text = elements.input.value;
    if (!text.trim()) {
      state.healthRun += 1;
      state.health = [];
      resetLogoutAllSessions();
      state.converted = [];
      state.skipped = [];
      state.sessions = [];
      state.toolResult = null;
      state.toolParsed = null;
      state.toolRecords = [];
      updateOutput();
      setStatus(elements.inputStatus, "等待输入。");
      return;
    }

    try {
      convertFromText(text);
      const parsedCount = state.format === "sub2api-tools" ? (state.toolResult?.accountCount || 0) : state.converted.length;
      if (parsedCount) {
        setStatus(elements.inputStatus, `解析完成：${parsedCount} 个账号，跳过 ${state.skipped.length} 项。`, "ok");
      } else {
        setStatus(elements.inputStatus, "没有可转换账号。", "error");
      }
    } catch (error) {
      state.healthRun += 1;
      state.health = [];
      resetLogoutAllSessions();
      state.converted = [];
      state.toolResult = null;
      state.toolParsed = null;
      state.toolRecords = [];
      state.skipped = [{
        sourceName: "pasted-json",
        path: "$",
        reason: error instanceof Error ? error.message : "JSON 解析失败",
      }];
      state.outputText = "";
      updateOutput();
      setStatus(elements.inputStatus, error instanceof Error ? error.message : "JSON 解析失败", "error");
    }
  }

  function downloadOutput() {
    if (!state.outputText) {
      return;
    }

    const isTool = state.format === "sub2api-tools";
    const first = state.converted[0];
    const base = sanitizeFileToken(first?.email || first?.name || state.format);
    const scope = isTool
      ? (elements.sub2apiOperation.value === "split" ? elements.splitScope.value : elements.sub2apiOperation.value)
      : (elements.downloadScope.value === "all" ? "all" : "200");
    const extension = isTool ? (state.toolResult?.extension || "txt") : "json";
    const fileName = `${base}.${scope}.${getTimestampToken()}.${extension}`;
    const blob = new Blob([state.outputText], { type: `${extension === "json" ? "application/json" : "text/plain"};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadSplitGroup(scope) {
    if (!state.toolResult || elements.sub2apiOperation.value !== "split") return;
    const outputText = scope === "unmatched" ? state.toolResult.unmatchedText : state.toolResult.matchedText;
    if (!outputText) return;
    const fileName = `sub2api.${scope}.${getTimestampToken()}.txt`;
    const url = URL.createObjectURL(new Blob([outputText], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function splitLoginAccount(line) {
    return splitPasswordTotpLine(line);
  }

  function parseLoginAccounts(text) {
    const rows = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!rows.length) throw new Error("请输入账号，每行一个");
    return rows.map((line, index) => {
      const parts = splitLoginAccount(line);
      if (parts.length !== 3 || !parts.every(Boolean) || !parts[0].includes("@")) {
        throw new Error(`第 ${index + 1} 行必须是 账号----密码----2fa、账号---密码---2fa 或 账号--密码--2fa`);
      }
      if (!/^[A-Z2-7]+=*$/i.test(parts[2].replace(/[\s-]+/g, ''))) {
        throw new Error(`第 ${index + 1} 行的 2FA 密钥不是有效的 Base32`);
      }
      return line;
    });
  }

  async function importLoginFiles(files) {
    if (!files?.length || elements.importLoginFile.disabled || elements.startProtocolLogin.disabled || elements.resetLoginTotp.disabled) return;
    const isCurrent = workspaceTaskIsCurrent();
    elements.importLoginFile.disabled = true;
    try {
      const lines = [];
      for (const file of Array.from(files)) {
        if (file.size > 5 * 1024 * 1024) throw new Error('单个账号文件不能超过 5 MB');
        const content = await file.text();
        requireCurrentWorkspace(isCurrent);
        lines.push(...parseLoginAccounts(content));
      }
      // A login may have started while the file was being read.
      if (monitorBusy || selfLeaveBusy || protocolLogoutBusy || elements.startProtocolLogin.disabled || elements.resetLoginTotp.disabled) {
        throw new Error('当前账号任务正在执行，请完成后重新导入');
      }
      elements.loginAccounts.value = [elements.loginAccounts.value.trim(), ...lines].filter(Boolean).join('\n');
      elements.loginAccountCount.textContent = `${countLoginAccountLines()} 个账号`;
      await persistBrowserWorkspace(true, true);
      requireCurrentWorkspace(isCurrent);
      setStatus(elements.loginStatus, `已导入 ${lines.length} 个账号到输入框，选择功能后执行。`, 'ok');
    } catch (error) {
      if (isCurrent()) setStatus(elements.loginStatus, error.message, 'error');
    } finally {
      if (isCurrent()) elements.importLoginFile.disabled = elements.startProtocolLogin.disabled || elements.resetLoginTotp.disabled;
    }
  }

  const LOGIN_STAGES = ["打开官网", "输入账号", "输入密码", "输入 2FA", "登录成功", "授权工作区", "转为 RT"];
  // DOM references stay outside the persisted browser state.
  const loginProgressNodes = new Map();
  const dirtyLoginRecords = new Set();
  const LOGIN_TIMING_LABELS = Object.freeze({
    queue: '排队', total: '账号执行', proxy_preflight: '出口检测', http_queue: 'HTTP 排队', http_request: 'HTTP 请求',
    sentinel: '辅助验证', browser_queue: '浏览器排队', browser_start: '浏览器启动', browser_context: '创建隔离环境',
    browser_navigation: '验证页加载', browser_verify: '浏览器验证', browser_cleanup: '环境清理',
    oauth_start: '登录准备', username: '提交账号', password: '密码验证', totp: '2FA 验证', workspace: '工作区授权',
    token_exchange: '获取 RT', session: '获取 Session',
  });

  function updateLoginTimings(record, timings) {
    if (!record) return;
    record.timings ||= {};
    for (const [stage, timing] of Object.entries(timings || {})) {
      if (!Object.hasOwn(LOGIN_TIMING_LABELS, stage) || !Number.isFinite(timing?.durationMs) || timing.durationMs < 0) continue;
      record.timings[stage] = { durationMs: timing.durationMs, calls: Number(timing.calls) || 1 };
    }
    scheduleLoginProgressRender(record);
  }

  function loginAccountEmail(line) {
    return splitLoginAccount(line)[0] || "";
  }

  function loginProgressRecord(data = {}) {
    const id = String(data.id || data.accountId || "").trim();
    const email = String(data.email || "").trim().toLowerCase();
    for (const record of state.loginProgress.values()) {
      if ((id && record.id === id) || (email && record.email.toLowerCase() === email)) return record;
    }
    return null;
  }

  function ensureLoginProgressRecord(data = {}, order = 0) {
    const existing = loginProgressRecord(data);
    if (existing) return existing;
    const id = String(data.id || data.accountId || '').trim();
    const email = String(data.email || '').trim();
    if (!id && !email) return null;
    const record = { id, email: email || id, stage: 0, status: 'waiting', logs: [], order };
    state.loginProgress.set(record.email.toLowerCase(), record);
    return record;
  }

  function sanitizeLoginLog(message) {
    let text = String(message || "");
    state.loginSensitiveValues.forEach((value) => {
      if (value) text = text.split(value).join("[已隐藏]");
    });
    return text
      .replace(/((?:password|密码)\s*[=:：]\s*)\S+/gi, "$1[已隐藏]")
      .replace(/((?:totp|2fa|验证码|secret)\s*[=:：]\s*)[A-Z0-9]{6,}/gi, "$1[已隐藏]");
  }

  function loginLogTime(value) {
    const date = value ? new Date(value) : new Date();
    return Number.isNaN(date.getTime()) ? new Date().toLocaleTimeString("zh-CN", { hour12: false }) : date.toLocaleTimeString("zh-CN", { hour12: false });
  }

  function inferLoginStage(message, fallback = 0) {
    const text = String(message || "");
    if (/交换.*(?:code|token)|转为?\s*RT|RT\s*(?:完成|成功|已获取|已就绪)/i.test(text)) return 6;
    if (/Business|workspace|工作区/i.test(text)) return 5;
    if (/登录完成|登录成功|Session\s*(?:已获取|已入库|有效)|accessToken/i.test(text)) return 4;
    if (/提交\s*(?:TOTP|2FA)|2FA\/MFA|MFA\s*(?:验证|挑战)|输入\s*2FA/i.test(text)) return 3;
    if (/提交账号密码|PasswordVerify|输入密码/i.test(text)) return 2;
    if (/提交登录邮箱|提交注册邮箱|输入账号|输入邮箱/i.test(text)) return 1;
    if (/打开官网|开始.*(?:登录|转换)|OAuth|authorize|ChatGPT Web/i.test(text)) return 0;
    return fallback;
  }

  function conciseLoginLog(message, level = 'info') {
    const text = sanitizeLoginLog(message).trim();
    // Warnings and failures keep their diagnostic details, even when the
    // corresponding successful request is normally hidden.
    if (/^(?:warn|warning|error)$/i.test(level) || /失败|异常|错误|未找到|无法|重试|重新.*验证/i.test(text)) return text;
    if (/(?:预生成|复用已有)注册资料|零元.*试用|协议隔离环境|独立Cookie\/设备|账号已有本地 TOTP 密钥|清理旧 Session|协议重登第\s*\d+\//i.test(text)) return '';
    if (/准备检测代理连通性|OAuth 落点|Cookie 诊断|工作区授权页|密码\+2FA 账号|账号已注册，跳过注册|Codex OAuth[：:]|授权.*(?:跳转|落点)/i.test(text)) return '';
    if (/等待.*队列调度/.test(text)) return '已加入队列，等待执行';
    if (/代理连通性检测开始/.test(text)) return '正在检测代理连通性';
    if (/代理连通性检测通过/.test(text)) return text.replace(/，开始正式流程.*$/, '');
    if (/密码后进入 2FA\/MFA|提交\s*TOTP\s*2FA/.test(text)) return '提交 2FA 验证码';
    if (/选择默认工作区/.test(text)) return '授权默认工作区';
    return text.replace(/\s*\(factor=[^)]+\)/gi, '');
  }

  function appendLoginProgress(record, message, options = {}) {
    if (!record) return;
    const clean = conciseLoginLog(message, options.level);
    let changed = false;
    if (clean) {
      const eventAt = Number.isFinite(Date.parse(options.time || "")) ? Date.parse(options.time) : Date.now();
      const key = clean.replace(/\s+/g, " ").trim();
      const previous = record.logs.at(-1);
      const duplicate = previous?.key === key && previous.level === (options.level || 'info');
      if (!duplicate) {
        record.logs.push({ time: loginLogTime(options.time), eventAt, key, level: options.level || "info", message: clean });
        changed = true;
      }
      if (record.logs.length > 50) record.logs.splice(0, record.logs.length - 50);
    }
    if (Number.isInteger(options.stage) && options.stage > record.stage) { record.stage = options.stage; changed = true; }
    if (options.status && options.status !== record.status) { record.status = options.status; changed = true; }
    if (changed) scheduleLoginProgressRender(record);
  }

  function scheduleLoginProgressRender(record) {
    if (record) dirtyLoginRecords.add(record.email.toLowerCase());
    persistBrowserWorkspace();
    if (state.loginRenderFrame) return;
    state.loginRenderFrame = requestAnimationFrame(() => {
      state.loginRenderFrame = 0;
      renderLoginProgress(false);
    });
  }

  function initializeLoginProgress(lines, { preserveExports = false } = {}) {
    state.loginProgress = new Map();
    state.loginSensitiveValues = [];
    state.loginLastAccounts = [];
    state.loginLastIds = [];
    if (!preserveExports) {
      state.loginSessionIds = [];
      state.loginPersonalIds = [];
      state.loginBusinessIds = [];
    }
    state.loginLastRtKind = "all";
    lines.forEach((line, order) => {
      const parts = splitLoginAccount(line);
      const email = parts[0];
      state.loginSensitiveValues.push(parts[1], parts[2]);
      state.loginProgress.set(email.toLowerCase(), {
        id: "",
        email,
        stage: 0,
        status: "waiting",
        logs: [],
        order,
      });
    });
    renderLoginProgress();
  }

  function getLoginWorkspaceMode() {
    return elements.loginWorkspaceMode.querySelector('input[name="login-workspace-mode"]:checked')?.value === "session" ? "session" : "all";
  }

  function updateLoginExportActions() {
    const retryCount = Number(state.loginRetry?.ids?.length || 0);
    elements.startProtocolLogin.textContent = retryCount
      ? `重试失败账号 (${retryCount})`
      : (getLoginWorkspaceMode() === "session" ? "开始协议登录" : "开始获取全部 RT");
    elements.exportLoginPersonal.disabled = state.loginPersonalIds.length === 0;
    elements.exportLoginBusiness.disabled = state.loginBusinessIds.length === 0 || getLoginWorkspaceMode() !== "all";
    updatePushControls();
  }

  function loginInputIdentity(lines) {
    return [...new Set(lines.map(line => loginAccountEmail(line).toLowerCase()).filter(Boolean))].sort();
  }

  function clearLoginRetry() {
    if (!state.loginRetry) return;
    state.loginRetry = null;
    updateLoginExportActions();
    persistBrowserWorkspace();
  }

  function pendingLoginRetry(lines, workspaceMode) {
    const retry = state.loginRetry;
    if (!retry || !Array.isArray(retry.ids) || !retry.ids.length) return null;
    if (retry.workspaceMode !== workspaceMode) {
      clearLoginRetry();
      return null;
    }
    const currentEmails = new Set(loginInputIdentity(lines));
    const sourceEmails = Array.isArray(retry.inputEmails) ? retry.inputEmails : [];
    // Editing the account list starts a new batch. Proxy controls can still be
    // changed between attempts without invalidating the failed-account set.
    if (sourceEmails.length && (sourceEmails.length !== currentEmails.size || sourceEmails.some(email => !currentEmails.has(email)))) {
      clearLoginRetry();
      return null;
    }
    const accounts = (retry.accounts || []).filter(item => item?.id && (!item.email || currentEmails.has(String(item.email).toLowerCase())));
    const ids = [...new Set(accounts.map(item => String(item.id)).filter(Boolean))];
    if (!ids.length) {
      clearLoginRetry();
      return null;
    }
    return { ...retry, accounts, ids };
  }

  function setLoginRetry(results, lines, workspaceMode) {
    const failed = (Array.isArray(results) ? results : [])
      .filter(item => isRetryableLoginFailure(item))
      .map(item => ({ id: String(item.id), email: String(item.email || '').trim() }))
      .filter((item, index, rows) => rows.findIndex(other => other.id === item.id) === index);
    state.loginRetry = failed.length
      ? { ids: failed.map(item => item.id), accounts: failed, workspaceMode, inputEmails: loginInputIdentity(lines) }
      : null;
    updateLoginExportActions();
  }

  function setLoginRetryFromProgress(lines, workspaceMode) {
    const failed = [...state.loginProgress.values()]
      .filter(record => record.id && record.status === 'error' && isRetryableLoginFailure({
        id: record.id,
        terminalReason: record.terminalReason,
        error: record.error || record.logs?.at(-1)?.message || '',
      }))
      .map(record => ({ id: String(record.id), email: String(record.email || '').trim() }))
      .filter((item, index, rows) => rows.findIndex(other => other.id === item.id) === index);
    state.loginRetry = failed.length
      ? { ids: failed.map(item => item.id), accounts: failed, workspaceMode, inputEmails: loginInputIdentity(lines) }
      : null;
    updateLoginExportActions();
  }

  function isRetryableLoginFailure(item = {}) {
    if (!item?.id || item.ok || item.terminalReason) return false;
    const text = String(item.error || item.detail || item.healthLabel || item.message || '').toLowerCase();
    return !/invalid[_ -]?(?:username|email|password)|incorrect|wrong password|password(?: is| was)? (?:invalid|incorrect|wrong|rejected)|密码.{0,16}(?:错误|不正确|无效|拒绝)|(?:invalid|incorrect|wrong)[_ -]?(?:otp|totp|mfa|2fa)|(?:otp|totp|mfa|2fa|验证码).{0,24}(?:错误|不正确|无效|拒绝)|account[_ -]?(?:deactivated|deleted|not[_ -]?found|banned|suspended|disabled|locked)|user[_ -]?(?:deleted|not[_ -]?found|banned|suspended|disabled)|account (?:has been |is )?(?:deleted|deactivated|banned|suspended|disabled|locked)|账号.{0,8}(?:停用|封禁|删除|不存在|冻结)|账户.{0,8}(?:删除|停用|不存在|封禁|冻结)/i.test(text);
  }

  function pipelineRtIds(results = []) {
    return [...new Set((Array.isArray(results) ? results : [])
      .filter(item => item?.ok || item?.personalOk || Number(item?.businessSuccess) > 0)
      .map(item => String(item.id || '').trim())
      .filter(Boolean))];
  }

  function updateLoginStageRail(records) {
    Array.from(elements.loginStepList.querySelectorAll("[data-login-stage]")).forEach((item) => {
      const index = Number(item.dataset.loginStage);
      const active = records.some((record) => record.status === "running" && record.stage === index);
      const done = records.length > 0 && records.every((record) => record.status === "success" || record.stage > index);
      const failed = records.some((record) => record.status === "error" && record.stage === index);
      item.classList.toggle("is-active", active);
      item.classList.toggle("is-done", done);
      item.classList.toggle("is-error", failed);
      const marker = item.querySelector(".login-step-marker");
      marker.textContent = done ? "✓" : (failed ? "!" : String(index + 1));
    });
  }

  function renderLoginProgress(full = true) {
    const records = Array.from(state.loginProgress.values());
    const counts = { waiting: 0, running: 0, success: 0, error: 0 };
    records.forEach((record) => { counts[record.status] = (counts[record.status] || 0) + 1; });
    const completed = counts.success + counts.error;
    const progressUnits = records.reduce((total, record) => total + (record.status === "success" || record.status === "error" ? LOGIN_STAGES.length : (record.status === "waiting" ? 0 : record.stage + 1)), 0);
    const overallPercent = records.length ? Math.round((progressUnits / (records.length * LOGIN_STAGES.length)) * 100) : 0;
    elements.loginAccountCount.textContent = `${records.length || countLoginAccountLines()} 个账号`;
    elements.loginProgressSummary.textContent = `等待 ${counts.waiting} · 进行中 ${counts.running} · 成功 ${counts.success} · 失败 ${counts.error}`;
    elements.loginCompletedCount.textContent = `已完成 ${completed}/${records.length}`;
    elements.loginOverallPercent.textContent = `${overallPercent}%`;
    elements.loginOverallBar.style.width = `${overallPercent}%`;
    updateLoginStageRail(records);
    if (!records.length) {
      loginProgressNodes.clear();
      dirtyLoginRecords.clear();
      elements.loginProgressList.innerHTML = '<div class="login-progress-empty">输入账号并开始后，这里将显示每个账号的实时进度。</div>';
      return;
    }
    if (!loginProgressNodes.size) elements.loginProgressList.innerHTML = '';
    if (full) {
      const keys = new Set(records.map(record => record.email.toLowerCase()));
      for (const [key, node] of loginProgressNodes) {
        if (!keys.has(key)) { node.article.remove(); loginProgressNodes.delete(key); }
      }
    }
    const displayRecords = full ? [...records].sort((left, right) => left.order - right.order) : records;
    for (const record of displayRecords) {
      const key = record.email.toLowerCase();
      let node = loginProgressNodes.get(key);
      if (node && !full && !dirtyLoginRecords.has(key)) continue;
      if (!node) {
        const article = document.createElement('article');
        article.innerHTML = '<div class="login-account-progress-head"><div class="login-account-email"></div><div class="login-account-stage"></div></div>'
          + '<div class="login-progress-track"><div class="login-progress-bar"></div></div><pre class="login-account-log"></pre>'
          + '<details class="login-account-timing"><summary>阶段耗时</summary><div></div></details>';
        node = { article, email: article.querySelector('.login-account-email'), stage: article.querySelector('.login-account-stage'),
          track: article.querySelector('.login-progress-track'), bar: article.querySelector('.login-progress-bar'),
          log: article.querySelector('.login-account-log'), timing: article.querySelector('.login-account-timing'),
          durations: article.querySelector('.login-account-timing div') };
        node.timing.title = '单个阶段可能包含其他子阶段；各项耗时不可直接相加。账号执行不含排队。';
        loginProgressNodes.set(key, node);
        elements.loginProgressList.append(article);
      }
      if (full) elements.loginProgressList.append(node.article);
      const stage = LOGIN_STAGES[Math.min(record.stage, LOGIN_STAGES.length - 1)];
      const label = record.status === "waiting" ? "等待开始" : (record.status === "success" ? "已完成" : (record.status === "error" ? `${stage}失败` : stage));
      const progress = record.status === "success" ? 100 : Math.max(5, Math.round(((record.stage + 1) / LOGIN_STAGES.length) * 100));
      const log = record.logs.length
        ? record.logs.map((item) => `[${item.time}] ${item.level === "error" ? "失败 · " : (/^warn/.test(item.level) ? "注意 · " : "")}${item.message}`).join("\n")
        : "等待执行...";
      node.article.className = `login-account-progress is-${record.status}`;
      node.email.textContent = record.email;
      node.email.title = record.email;
      node.stage.textContent = label;
      node.track.setAttribute('aria-label', `${record.email} ${progress}%`);
      node.bar.style.width = `${progress}%`;
      node.log.dataset.account = record.email;
      if (node.log.textContent !== log) {
        const top = node.log.scrollTop;
        const follow = node.log.scrollHeight - node.log.clientHeight - top < 8;
        node.log.textContent = log;
        node.log.scrollTop = follow ? node.log.scrollHeight : top;
      }
      const durations = Object.entries(LOGIN_TIMING_LABELS).filter(([stage]) => record.timings?.[stage]);
      node.timing.hidden = !durations.length;
      const timingText = durations.map(([stage, label]) => `${label} ${(record.timings[stage].durationMs / 1000).toFixed(2)}s`).join(' · ');
      if (node.durations.textContent !== timingText) node.durations.textContent = timingText;
    }
    dirtyLoginRecords.clear();
  }

  function countLoginAccountLines() {
    return String(elements.loginAccounts.value || "").split(/\r?\n/).filter((line) => line.trim()).length;
  }

  function updateLoginProxySessionState(authorized, message = "") {
    const node = elements.loginProxySessionState;
    if (!node) return;
    node.textContent = authorized ? "会话已授权" : (message || "需要重新授权");
    node.classList.toggle("is-error", !authorized);
    node.setAttribute("data-state", authorized ? "ok" : "error");
  }

  function loginProxyHeaders(extra = {}) {
    return { ...(extra || {}) };
  }

  async function loginIcloudStream(path, body, onEvent, signal) {
    const isCurrent = workspaceTaskIsCurrent(signal);
    const response = await pageFetch(path, {
      method: "POST",
      credentials: "same-origin",
      signal,
      headers: loginProxyHeaders({ Accept: "text/event-stream", "Content-Type": "application/json" }),
      body: JSON.stringify(browserRequestBody({ ...(body || {}), stream: true })),
    });
    requireCurrentWorkspace(isCurrent);
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.includes("text/event-stream")) {
      const payload = await response.json().catch(() => ({}));
      requireCurrentWorkspace(isCurrent);
      if (response.status === 401) updateLoginProxySessionState(false, "会话未授权");
      throw new Error(String(payload.error?.message || payload.error || `登录服务 HTTP ${response.status}`));
    }
    updateLoginProxySessionState(true);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let summary = null;
    const yieldToLoginRender = () => new Promise((resolve) => setTimeout(resolve, 0));
    const handleChunk = (chunk) => {
      requireCurrentWorkspace(isCurrent);
      if (!chunk.trim() || chunk.trimStart().startsWith(":")) return;
      let name = "message";
      const dataLines = [];
      chunk.split(/\r?\n/).forEach((line) => {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      });
      if (!dataLines.length) return;
      const data = JSON.parse(dataLines.join("\n"));
      if (name === "browser_state") { acceptBrowserState(data); return; }
      if (name === "summary") summary = data;
      if (name === "error") throw new Error(String(data.error || "协议登录失败"));
      onEvent?.(name, data);
    };
    while (true) {
      const { value, done } = await reader.read();
      requireCurrentWorkspace(isCurrent);
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() || "";
      for (const chunk of chunks) {
        handleChunk(chunk);
      }
      if (chunks.length) await yieldToLoginRender();
      if (done) break;
    }
    if (buffer.trim()) {
      handleChunk(buffer);
      await yieldToLoginRender();
    }
    requireCurrentWorkspace(isCurrent);
    if (!summary) throw new Error("登录服务未返回汇总结果");
    return summary;
  }

  async function loginIcloudRequest(path, body, signal) {
    return loginIcloudJson(path, { method: "POST", body, signal });
  }

  async function loginIcloudJson(path, { method = "GET", body, signal } = {}) {
    const isCurrent = workspaceTaskIsCurrent(signal);
    const response = await pageFetch(path, {
      method,
      signal,
      credentials: "same-origin",
      headers: loginProxyHeaders({ "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(browserRequestBody(body)),
    });
    const payload = await response.json().catch(() => ({}));
    requireCurrentWorkspace(isCurrent);
    acceptBrowserState(payload.browserState);
    if (!response.ok || payload.ok === false) {
      if (response.status === 401) updateLoginProxySessionState(false, "会话未授权");
      const error = payload.error?.message || payload.error || `登录服务 HTTP ${response.status}`;
      const message = String(error);
      if (/手机号|手机|验证码|otp|phone|mfa|2fa/i.test(message)) {
        showLoginModal(message);
      }
      throw new Error(message);
    }
    updateLoginProxySessionState(true);
    return payload;
  }

  function selectedPushTarget() {
    return elements.pushTarget.querySelector('input:checked')?.value || 'none';
  }

  function normalizePushAddress(value, target) {
    const raw = String(value || '').trim();
    if (!raw) throw new Error('请填写服务地址');
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search) throw new Error('请填写 HTTP(S) 服务地址，不要包含密码或查询参数');
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '').replace(target === 'cpa'
      ? /\/(?:management\.html|v0\/management(?:\/auth-files)?)$/i
      : /\/(?:admin|login|dashboard|api(?:\/v1)?(?:\/admin)?)$/i, '');
    return url.href.replace(/\/+$/, '');
  }

  function pushSettings(target) {
    const settings = target === 'sub2api' ? state.browserSettings.sub2apiSettings : state.cpaSettings;
    if (!['sub2api', 'cpa'].includes(target)) throw new Error('请先选择 Sub2API 或 CPA');
    if (!settings?.baseUrl?.trim() || !(target === 'sub2api' ? settings.adminApiKey?.trim() && settings.groupIds?.length : settings.managementKey?.trim())) {
      throw new Error(`请先打开 ${target === 'sub2api' ? 'Sub2API' : 'CPA'} 配置并保存地址和管理密钥${target === 'sub2api' ? '、推送分组' : ''}`);
    }
    return { ...structuredClone(settings), baseUrl: normalizePushAddress(settings.baseUrl, target) };
  }

  function updatePushControls() {
    const target = selectedPushTarget();
    const login = state.format === 'protocol-login';
    const slot = login ? elements.loginPushSlot : elements.converterPushSlot;
    const feedbackSlot = login ? elements.loginPushFeedbackSlot : elements.converterPushFeedbackSlot;
    if (elements.pushControls.parentElement !== slot) slot.append(elements.pushControls);
    if (elements.pushFeedback.parentElement !== feedbackSlot) feedbackSlot.append(elements.pushFeedback);
    elements.pushControls.classList.toggle('hidden', state.format === 'sub2api-tools');
    elements.pushConverted.classList.toggle('hidden', login || target === 'none' || state.format === 'sub2api-tools');
    elements.pushConverted.disabled = pushBusy || monitorBusy || target === 'none' || !selectedConverted().length;
    elements.retryPush.classList.toggle('hidden', !state.pushRetry?.accounts?.length);
    elements.retryPush.disabled = pushBusy || monitorBusy || !state.pushRetry?.accounts?.length || state.pushRetry.target !== target;
    for (const radio of elements.pushTarget.querySelectorAll('input')) radio.disabled = pushBusy || monitorBusy;
    elements.pushHint.textContent = login
      ? '选择目标并保存配置后，获取全部工作区 RT 时自动推送非 free 账号；手动下载包含所有类型。配置加密保存在当前浏览器。'
      : '配置加密保存在当前浏览器。推送范围沿用下载范围，格式由推送目标决定。';
  }

  function renderPushResults() {
    elements.pushResultDetails.hidden = !state.pushResults.length;
    elements.pushFeedback.hidden = !state.pushResults.length && !elements.pushStatus.textContent;
    elements.pushResults.innerHTML = state.pushResults.map(row => `<li>${escapeHtml(row.name)} · ${row.status === 'success' ? '成功' : row.status === 'failed' ? '失败' : '待核对'}${row.error ? `：${escapeHtml(row.error)}` : ''}</li>`).join('');
    updatePushControls();
  }

  async function remotePushRequest(path, body, signal) {
    const isCurrent = workspaceTaskIsCurrent(signal);
    const response = await pageFetch(`/api/push/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    requireCurrentWorkspace(isCurrent);
    const payload = await response.json();
    requireCurrentWorkspace(isCurrent);
    if (!response.ok) throw Object.assign(new Error(payload.detail || payload.error || `HTTP ${response.status}`), {
      validation: ['INVALID_PUSH_PAYLOAD', 'MONITOR_LEASE_LOST'].includes(payload.code),
    });
    return payload;
  }

  function hidePushToast() {
    clearTimeout(pushToastTimer);
    elements.pushToast.hidden = true;
    elements.pushToast.textContent = '';
  }

  function showPushSuccessToast(target, count) {
    hidePushToast();
    elements.pushToast.textContent = `${target === 'cpa' ? 'CPA' : 'Sub2API'} 推送成功，共 ${count} 个账号。`;
    elements.pushToast.hidden = false;
    pushToastTimer = setTimeout(hidePushToast, 4000);
  }

  async function runPush(buildAccounts, { retry = false, emptyMessage = '', upsert = false, signal } = {}) {
    if (pushBusy || (monitorBusy && !signal)) return;
    hidePushToast();
    const isCurrent = workspaceTaskIsCurrent(signal);
    const ownsWorkspace = workspaceTaskIsCurrent();
    const target = selectedPushTarget();
    let accounts;
    try {
      const settings = pushSettings(target);
      pushBusy = true;
      updatePushControls();
      accounts = await buildAccounts(target);
      requireCurrentWorkspace(isCurrent);
      if (!accounts.length) {
        if (!emptyMessage) throw new Error('当前范围没有可推送的账号');
        state.pushRetry = null;
        state.pushResults = [];
        renderPushResults();
        setStatus(elements.pushStatus, emptyMessage);
        persistBrowserWorkspace(true);
        return { ok: true, imported: 0 };
      }
      if (retry && (state.pushRetry?.baseUrl !== settings.baseUrl || JSON.stringify(state.pushRetry?.groupIds) !== JSON.stringify(settings.groupIds))) {
        throw new Error('目标地址或分组已变更，请重新选择要推送的结果');
      }
      state.pushRetry = null;
      setStatus(elements.pushStatus, `正在推送 ${accounts.length} 个账号到 ${target === 'cpa' ? 'CPA' : 'Sub2API'}…`);
      const result = await remotePushRequest(target, { settings, accounts, upsert, ...(signal ? { monitorOwner: state.monitorOwner } : {}) }, signal);
      requireCurrentWorkspace(isCurrent);
      state.pushResults = result.results || [];
      const failed = state.pushResults.filter(row => row.status === 'failed').map(row => accounts[row.index]).filter(Boolean);
      if (failed.length) state.pushRetry = { target, baseUrl: settings.baseUrl, groupIds: settings.groupIds, accounts: failed, upsert };
      renderPushResults();
      setStatus(elements.pushStatus, `推送完成：成功 ${result.imported || 0}，失败 ${result.failed || 0}，待核对 ${result.unknown || 0}。${failed.length ? '可重试失败项。' : ''}`, result.ok ? 'ok' : 'error');
      if (result.ok && result.imported > 0) showPushSuccessToast(target, result.imported);
      persistBrowserWorkspace(true);
      return result;
    } catch (error) {
      if (!isCurrent()) return;
      setStatus(elements.pushStatus, `${error.message}${accounts?.length && !error.validation ? '；若请求已发出，请在目标服务核对结果。' : ''}`, 'error');
      return { ok: false };
    } finally {
      if (ownsWorkspace()) { pushBusy = false; updatePushControls(); }
    }
  }

  async function autoPushLoginResults({ ids: selectedIds, upsert = false, signal } = {}) {
    return runPush(async target => {
      const ids = selectedIds || [...new Set([...state.loginPersonalIds, ...state.loginBusinessIds])];
      if (!ids.length) return [];
      const payload = await loginIcloudRequest('/api/v2/accounts/export-sub2api', { ids, rtKind: 'all', validateSession: false }, signal);
      // Classify each exported workspace by its own plan, not the parent login.
      const accounts = buildLoginSub2apiPayload(payload).accounts.filter(account => {
        const plan = String(account.credentials?.plan_type || '').trim().toLowerCase();
        return plan && plan !== 'free';
      });
      return target === 'sub2api' ? accounts : accounts.map(account => convertSession(account).cpa);
    }, { emptyMessage: '没有可推送的非 free 账号，已跳过自动推送。', upsert, signal });
  }

  const monitorStopLabels = { account_unavailable: '账号已删除、停用或不存在', password_invalid: '密码错误', totp_invalid: '2FA 凭据错误', self_leave_pending: '自踢结果待确认', sessions_logged_out: '已主动退出全部会话，手动登录后恢复' };

  async function monitorLeaseRequest(accounts, owner, action = 'claim', signal) {
    const response = await fetch('/api/v2/accounts/monitor-lease', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ ids: accounts.map(account => String(account.id)), monitorOwner: owner, action,
        browserState: { accounts: action === 'release' ? accounts.map(({ id, email }) => ({ id, email })) : accounts, settings: {} } }),
    });
    const payload = await response.json();
    signal?.throwIfAborted();
    if (!response.ok || payload.ok === false) throw new Error('测活租约请求失败');
    return payload;
  }

  function stopSessionMonitor(release = false) {
    clearTimeout(monitorTimer);
    monitorController?.abort();
    if (release && state.monitorOwner && state.browserAccounts.length) {
      void monitorLeaseRequest(state.browserAccounts, state.monitorOwner, 'release').catch(() => {});
    }
  }

  function markMonitorStopped(id, reason) {
    if (!monitorStopLabels[reason]) return;
    state.monitorStopped[id] = reason;
    delete state.monitorRetries[id];
  }

  function monitorEligibility() {
    if (!state.monitorEnabled) return { reason: '请在推送目标左侧开启定时测活' };
    if (!browserStorageReady || browserStorageCleared || monitorPaused) return { reason: '等待浏览器存储就绪' };
    if (!navigator.locks) return { reason: '此浏览器不支持多标签页任务协调，请使用新版浏览器及 HTTPS' };
    const target = selectedPushTarget();
    try { pushSettings(target); } catch { return { reason: '请选择并保存 Sub2API 或 CPA 推送配置' }; }
    const accounts = state.browserAccounts.filter(account => account.id && !state.monitorStopped[account.id] && account.email?.includes('@')
      && (account.openai_password || account.password) && (account.two_factor_secret || account.twoFactorSecret)
      && (account.session_access_token || account.openai_access_token || state.monitorRetries[account.id]));
    return accounts.length ? { accounts } : { reason: state.browserAccounts.some(account => state.monitorStopped[account.id])
      ? '没有可检查的账号，异常账号已跳过，请修正凭据后手动登录'
      : '请先完成协议登录，并保留邮箱、密码和 TOTP' };
  }

  function syncMonitorChoice() {
    state.monitorEnabled = state.monitorEnabled === true;
    for (const input of document.querySelectorAll('input[name="session-monitor"]')) {
      input.checked = input.value === (state.monitorEnabled ? 'on' : 'off');
    }
  }

  function requireMonitorPushConfig() {
    if (!state.monitorEnabled) return;
    try { pushSettings(selectedPushTarget()); }
    catch (error) {
      state.monitorEnabled = false;
      stopSessionMonitor(true);
      syncMonitorChoice();
      setStatus(elements.loginStatus, `测活未开启：${error.message}。配置完成后请手动开启测活。`, 'error');
      persistBrowserWorkspace();
    }
  }

  function renderSessionMonitor(message) {
    const node = document.querySelector('#session-monitor-status');
    if (node) node.textContent = message;
  }

  function scheduleSessionMonitor() {
    clearTimeout(monitorTimer);
    requireMonitorPushConfig();
    const skipped = state.browserAccounts.filter(account => state.monitorStopped[account.id]);
    const skippedPanel = document.querySelector('#monitor-skipped');
    if (skippedPanel) {
      skippedPanel.hidden = !skipped.length;
      document.querySelector('#monitor-skipped-list').innerHTML = skipped.map(account => `<li>${escapeHtml(account.email)} · ${escapeHtml(monitorStopLabels[state.monitorStopped[account.id]] || '需人工处理')}；修正后手动登录成功可恢复。</li>`).join('');
    }
    if (monitorBusy || monitorPaused || selfLeaveBusy || protocolLogoutBusy) return;
    const eligibility = monitorEligibility();
    if (eligibility.reason) {
      renderSessionMonitor(state.monitorEnabled ? `定时测活等待中：${eligibility.reason}。` : '定时测活已关闭。');
      return;
    }
    const due = Math.max(monitorNextAt, Number(state.monitorLastCheckAt || 0) + 60_000);
    renderSessionMonitor(`定时测活已开启 · ${eligibility.accounts.length} 个账号 · 每分钟一次${skipped.length ? ` · 已跳过 ${skipped.length}` : ''}${monitorLastSummary ? ` · ${monitorLastSummary}` : ''}`);
    monitorTimer = setTimeout(() => { void runSessionMonitor(); }, Math.max(0, due - Date.now()));
  }

  async function runSessionMonitor() {
    if (monitorBusy || selfLeaveBusy || monitorEligibility().reason) { scheduleSessionMonitor(); return; }
    // A manual login, logout, push or open configuration dialog takes priority.
    if (navigator.onLine === false || elements.startProtocolLogin.disabled || elements.resetLoginTotp.disabled
      || state.logoutInProgress || pushBusy || document.querySelector('dialog[open]')) {
      monitorLastSummary = navigator.onLine === false ? '离线，稍后重试' : '等待当前操作完成';
      monitorNextAt = Date.now() + 60_000;
      scheduleSessionMonitor();
      return;
    }
    try {
      await navigator.locks.request('session-converter-monitor', { ifAvailable: true }, async lock => {
        if (!lock || monitorEligibility().reason) return;
        // Re-read the timestamp after acquiring the lock; stale tabs also fail the encrypted store's CAS check.
        if (Date.now() - Number(state.monitorLastCheckAt || 0) < 60_000) return;
        monitorBusy = true;
        const controller = new AbortController();
        monitorController = controller;
        const isCurrent = workspaceTaskIsCurrent(controller.signal);
        const ownsWorkspace = workspaceTaskIsCurrent();
        const disabled = [...document.querySelectorAll('#login-workbench input:not([name="session-monitor"]), #login-workbench textarea, #login-workbench button, .push-config input, .push-config textarea, .push-config button, #logout-all-sessions, #push-controls input:not([name="session-monitor"]), #push-controls button')]
          .map(node => ({ node, disabled: node.disabled }));
        disabled.forEach(({ node }) => { node.disabled = true; });
        let heartbeat;
        try {
          let accounts = monitorEligibility().accounts;
          state.monitorOwner ||= crypto.randomUUID();
          const owner = state.monitorOwner;
          state.monitorLastCheckAt = Date.now();
          await persistBrowserWorkspace(true, true);
          requireCurrentWorkspace(isCurrent);
          const leases = await monitorLeaseRequest(accounts, owner, 'claim', controller.signal);
          requireCurrentWorkspace(isCurrent);
          for (const row of leases.results) if (row.terminalReason) markMonitorStopped(row.id, row.terminalReason);
          const owned = new Set(leases.results.filter(row => row.owned).map(row => String(row.id)));
          accounts = accounts.filter(account => owned.has(String(account.id)));
          const standby = leases.results.filter(row => !row.owned && !row.terminalReason).length;
          if (!accounts.length) {
            monitorLastSummary = standby ? `${standby} 个账号由其他浏览器负责，等待接管` : '异常账号已停止重试';
            await persistBrowserWorkspace(true, true);
            return;
          }
          let renewing = false;
          heartbeat = setInterval(async () => {
            if (renewing || !isCurrent()) return;
            renewing = true;
            try {
              const renewed = await monitorLeaseRequest(accounts, owner, 'claim', controller.signal);
              if (renewed.results.some(row => !row.owned && !row.terminalReason)) controller.abort();
            } catch { controller.abort(); }
            finally { renewing = false; }
          }, 30_000);
          const ids = accounts.map(account => String(account.id));
          const network = { ...selectedLoginProxyNetwork(), monitorOwner: owner };
          renderSessionMonitor(`定时测活中 · ${ids.length} 个账号`);
          const probeIds = accounts.filter(account => account.session_access_token || account.openai_access_token).map(account => String(account.id));
          const probe = probeIds.length ? await loginIcloudRequest('/api/v2/accounts/session-probe', { ids: probeIds, ...network }, controller.signal) : { results: [] };
          requireCurrentWorkspace(isCurrent);
          const health = new Map(probe.results.map(row => [String(row.id), row]));
          const invalid = accounts.filter(account => {
            const result = health.get(String(account.id));
            if (result?.health === 'deactivated') markMonitorStopped(account.id, 'account_unavailable');
            if (result?.terminalReason) markMonitorStopped(account.id, result.terminalReason);
            const retry = state.monitorRetries[account.id];
            return !state.monitorStopped[account.id] && (result?.health === 'session_invalid' || (retry && (!result || result.health === 'alive'))) && (!retry || retry.after <= Date.now());
          });
          let refreshed = 0;
          let pushed = true;
          if (invalid.length) {
            renderSessionMonitor(`定时测活 · ${invalid.length} 个账号失效，正在获取全部工作区 RT`);
            for (const account of invalid) {
              // All-workspace OAuth does not renew a Web Session. Discard only a
              // confirmed invalid Session so it cannot trigger relogin every minute.
              if (health.get(String(account.id))?.sessionInvalid) {
                const cached = state.browserAccounts.find(item => String(item.id) === String(account.id));
                if (cached) { cached.session_access_token = ''; cached.session_json = ''; }
                state.loginSessionIds = state.loginSessionIds.filter(id => String(id) !== String(account.id));
              }
              const attempts = (state.monitorRetries[account.id]?.attempts || 0) + 1;
              state.monitorRetries[account.id] = { attempts, after: Date.now() + Math.min(30, 5 * 2 ** Math.min(attempts - 1, 3)) * 60_000 };
            }
            await persistBrowserWorkspace(true, true);
            requireCurrentWorkspace(isCurrent);
            const onEvent = (name, data) => {
              const record = ensureLoginProgressRecord(data, accounts.findIndex(account => String(account.id) === String(data?.id)));
              if (data.terminalReason) markMonitorStopped(data.id, data.terminalReason);
              if (record && data.terminalReason) record.terminalReason = data.terminalReason;
              if (record && data.error) record.error = sanitizeLoginLog(data.error);
              if (name === 'account_start') appendLoginProgress(record, '定时测活发现失效，开始协议重登', { stage: 0, status: 'running' });
              if (name === 'account_done') appendLoginProgress(record, data.ok ? '定时重登完成'
                : data.terminalReason ? `${monitorStopLabels[data.terminalReason]}，已停止自动重试`
                : data.monitorBusy ? '账号由其他浏览器负责，本轮跳过' : '定时重登失败，稍后重试', { stage: data.ok ? 6 : 0, status: data.ok ? 'success' : 'error' });
            };
            const reloginIds = invalid.map(account => String(account.id));
            const pipeline = await loginIcloudStream('/api/v2/accounts/protocol-login-pipeline', { ids: reloginIds, workspaceMode: 'all', ...network }, onEvent, controller.signal);
            requireCurrentWorkspace(isCurrent);
            const pipelineResults = Array.isArray(pipeline.results) ? pipeline.results : [];
            state.loginLastResponse = pipeline;
            const accountById = new Map([...state.loginLastAccounts, ...(pipeline.accounts || [])].map(account => [String(account.id), account]));
            state.loginLastAccounts = [...accountById.values()];
            state.loginLastRtKind = 'all';
            for (const row of pipelineResults) {
              if (row.terminalReason) markMonitorStopped(row.id, row.terminalReason);
              if (row.monitorBusy) delete state.monitorRetries[row.id];
            }
            const successful = pipelineResults.filter(row => row.ok).map(row => String(row.id));
            const rtReady = pipelineRtIds(pipelineResults);
            refreshed = successful.length;
            for (const id of successful) delete state.monitorRetries[id];
            state.loginLastIds = [...new Set([...state.loginLastIds, ...successful])];
            state.loginPersonalIds = [...new Set([...state.loginPersonalIds, ...pipelineResults.filter(row => row.personalOk).map(row => String(row.id))])];
            state.loginBusinessIds = [...new Set([...state.loginBusinessIds, ...pipelineResults.filter(row => Number(row.businessSuccess) > 0).map(row => String(row.id))])];
            state.loginSessionIds = state.browserAccounts.filter(account => account.session_access_token).map(account => String(account.id));
            await persistBrowserWorkspace(true, true);
            requireCurrentWorkspace(isCurrent);
            if (rtReady.length) pushed = Boolean((await autoPushLoginResults({ ids: rtReady, upsert: true, signal: controller.signal }))?.ok);
          }
          requireCurrentWorkspace(isCurrent);
          const unknown = probe.results.filter(row => row.health === 'probe_failed').length;
          const deactivated = probe.results.filter(row => row.health === 'deactivated').length;
          const retryCount = invalid.filter(account => state.monitorRetries[account.id]).length;
          monitorLastSummary = `${new Date().toLocaleTimeString()} 已检查 ${probeIds.length}，重登成功 ${refreshed}${retryCount ? `，重登失败 ${retryCount}（5–30 分钟后重试）` : ''}${unknown ? `，网络/验证异常 ${unknown}` : ''}${deactivated ? `，账号停用 ${deactivated}` : ''}${standby ? `，其他浏览器负责 ${standby}` : ''}${pushed ? '' : '，推送未完成，请查看推送结果'}`;
          await persistBrowserWorkspace(true, true);
        } catch (error) {
          if (isCurrent()) monitorLastSummary = '本轮未完成，稍后重试；请检查网络或推送结果';
        } finally {
          clearInterval(heartbeat);
          monitorBusy = false;
          if (monitorController === controller) monitorController = null;
          if (ownsWorkspace()) {
            disabled.forEach(({ node, disabled: wasDisabled }) => { node.disabled = wasDisabled; });
            updateLoginExportActions();
            elements.exportLoginSessions.disabled = state.loginSessionIds.length === 0;
            updatePushControls();
          }
        }
      });
    } catch {
      monitorLastSummary = '无法协调浏览器任务，稍后重试';
    } finally {
      monitorNextAt = Math.max(Date.now() + 1000, Number(state.monitorLastCheckAt || Date.now()) + 60_000);
      scheduleSessionMonitor();
    }
  }

  function loginSub2ConfigPayload() {
    return {
      baseUrl: elements.loginSub2BaseUrl.value.trim(),
      adminApiKey: elements.loginSub2AdminKey.value.trim(),
      groupIds: [...state.loginSub2SelectedGroupIds],
      accountConcurrency: Number(elements.loginSub2Concurrency.value || 50),
      priority: Number(elements.loginSub2Priority.value || 1),
      loadFactor: Number(elements.loginSub2LoadFactor.value || 1),
      fingerprintMode: elements.loginSub2FingerprintMode.value || "full",
      models: elements.loginSub2Models.value.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean),
    };
  }

  function renderLoginSub2Groups(groups = state.loginSub2AvailableGroups) {
    state.loginSub2AvailableGroups = Array.isArray(groups) ? groups : [];
    const selected = new Set(state.loginSub2SelectedGroupIds.map(Number));
    const byId = new Map(state.loginSub2AvailableGroups.map(group => [Number(group.id), group]));
    for (const id of selected) if (!byId.has(id)) byId.set(id, { id, name: `分组 ${id}` });
    elements.loginSub2GroupCount.textContent = `已选 ${selected.size} 个`;
    elements.loginSub2Groups.innerHTML = [...byId.values()].map(group => {
      const id = Number(group.id);
      return `<label class="push-group-option"><input type="checkbox" data-sub2-group-id="${id}" ${selected.has(id) ? 'checked' : ''} /><span>${escapeHtml(group.name || `分组 ${id}`)}<small>ID ${id}${group.account_count !== undefined ? ` · ${Number(group.account_count)} 个账号` : ''}</small></span></label>`;
    }).join('') || '<p>填写地址和密钥后，读取可选分组。</p>';
  }

  function fillLoginSub2Config(settings = {}) {
    elements.loginSub2BaseUrl.value = settings.baseUrl || "";
    elements.loginSub2AdminKey.value = state.browserSettings.sub2apiSettings?.adminApiKey || "";
    state.loginSub2KeyConfigured = Boolean(elements.loginSub2AdminKey.value) || settings.keyConfigured === true;
    state.loginSub2SelectedGroupIds = (settings.groupIds || []).map(Number).filter(Number.isFinite);
    elements.loginSub2Concurrency.value = String(settings.accountConcurrency || 50);
    elements.loginSub2Priority.value = String(settings.priority || 1);
    elements.loginSub2LoadFactor.value = String(settings.loadFactor || 1);
    elements.loginSub2FingerprintMode.value = settings.fingerprintMode || "full";
    elements.loginSub2Models.value = (settings.models || ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra"]).join("\n");
    renderLoginSub2Groups();
  }

  async function loadLoginSub2Config() {
    fillLoginSub2Config(state.browserSettings.sub2apiSettings || {});
    state.loginSub2Loaded = true;
    setStatus(elements.loginSub2Status, state.loginSub2KeyConfigured ? '已读取此浏览器的加密配置。' : '请填写地址、Admin Key 并读取分组。');
  }

  async function loadLoginSub2Groups({ silent = false } = {}) {
    const isCurrent = workspaceTaskIsCurrent();
    const baseUrl = elements.loginSub2BaseUrl.value.trim();
    const adminApiKey = elements.loginSub2AdminKey.value.trim();
    if (!baseUrl || (!adminApiKey && !state.loginSub2KeyConfigured)) {
      if (!silent) throw new Error("请先填写 Sub2 地址和 Admin Key");
      return;
    }
    elements.loadLoginSub2Groups.disabled = true;
    try {
      const data = await remotePushRequest("sub2api/groups", { settings: { baseUrl, adminApiKey } });
      requireCurrentWorkspace(isCurrent);
      renderLoginSub2Groups(data.groups || []);
      setStatus(elements.loginSub2Status, `已读取 ${data.groups?.length || 0} 个分组。`, "ok");
    } finally {
      if (isCurrent()) elements.loadLoginSub2Groups.disabled = false;
    }
  }

  async function saveLoginSub2Config() {
    const isCurrent = workspaceTaskIsCurrent();
    elements.saveLoginSub2Config.disabled = true;
    try {
      const settings = loginSub2ConfigPayload();
      const hasConnection = Boolean(settings.baseUrl || settings.adminApiKey || settings.groupIds.length);
      if (hasConnection) {
        settings.baseUrl = normalizePushAddress(settings.baseUrl, 'sub2api');
        if (!settings.adminApiKey || !settings.groupIds.length) throw new Error('请填写 Admin Key 并选择至少一个推送分组');
      }
      for (const [name, value, max] of [['每账号并发', settings.accountConcurrency, 100], ['优先级', settings.priority, 100], ['负载因子', settings.loadFactor, 10000]]) {
        if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name}必须是 1–${max} 的整数`);
      }
      state.browserSettings.sub2apiSettings = settings;
      await persistBrowserWorkspace(true, true);
      requireCurrentWorkspace(isCurrent);
      fillLoginSub2Config(settings);
      state.loginSub2Loaded = true;
      setStatus(elements.loginSub2Status, hasConnection ? `配置已加密保存在此浏览器 · ${settings.groupIds.length} 个推送分组。` : '账号参数已加密保存；配置地址、密钥和分组后可启用推送。', 'ok');

    } finally {
      if (isCurrent()) elements.saveLoginSub2Config.disabled = false;
    }
  }

  function showLoginModal(message) {
    if (!elements.loginModal) return;
    const wasHidden = typeof elements.loginModal.classList?.contains === "function"
      ? elements.loginModal.classList.contains("hidden")
      : elements.loginModal.hidden === true;
    if (wasHidden) {
      const activeElement = document.activeElement;
      loginModalReturnFocus = activeElement && typeof activeElement.focus === "function" ? activeElement : null;
      loginModalPreviousOverflow = document.body.style.overflow;
    }
    elements.loginModalMessage.textContent = message || "登录服务返回了需要人工完成的验证步骤。";
    elements.loginModal.classList.remove("hidden");
    elements.loginModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    if (typeof elements.closeLoginModal?.focus === "function") elements.closeLoginModal.focus();
  }

  function hideLoginModal() {
    if (!elements.loginModal) return;
    elements.loginModal.classList.add("hidden");
    elements.loginModal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = loginModalPreviousOverflow;
    const target = loginModalReturnFocus;
    loginModalReturnFocus = null;
    loginModalPreviousOverflow = "";
    const attached = typeof document.contains !== "function" || document.contains(target);
    if (target && attached) target.focus();
  }

  function buildLoginSub2apiPayload(payload) {
    const source = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    const accounts = Array.isArray(source?.accounts) ? source.accounts : [];
    if (!accounts.length) throw new Error("登录服务未返回可导出的账号");
    return {
      type: source.type || "sub2api-data",
      version: source.version ?? 1,
      exported_at: source.exported_at || new Date().toISOString(),
      proxies: Array.isArray(source.proxies) ? source.proxies : [],
      accounts: accounts.map(applySub2apiOutputConfig),
    };
  }

  function readLoginProxyMode() {
    const mode = elements.loginProxyMode?.querySelector('input[name="login-proxy-mode"]:checked')?.value;
    return ["local", "pool", "builtin"].includes(mode) ? mode : "direct";
  }

  function syncLoginProxyControls() {
    if (!elements.loginProxyMode || !elements.loginProxyPool || !elements.loginProxyLocalPort) return;
    const mode = readLoginProxyMode();
    const local = mode === "local";
    const pool = mode === "pool";
    elements.loginProxyLocalWrap?.classList.toggle("hidden", !local);
    elements.loginProxyLocalPort.disabled = !local;
    elements.loginProxyCustomWrap?.classList.toggle("hidden", !pool);
    elements.loginProxyPool.disabled = !pool;
    if (elements.loginProxyStatus) {
      elements.loginProxyStatus.textContent = local
        ? `使用本地代理 127.0.0.1:${elements.loginProxyLocalPort.value || "7890"}，协议登录将按账号固定使用。`
        : pool
        ? (elements.loginProxyPool.value.trim() ? "已配置浏览器代理池，协议登录将按账号固定一个代理。" : "代理池为空，协议登录将直连。")
        : mode === "builtin"
          ? "使用服务器内置代理池，协议登录将按账号固定一个代理。"
          : "当前使用直连。";
    }
  }

  function selectedLoginProxyNetwork() {
    const mode = readLoginProxyMode();
    const localProxyPort = Math.max(1, Math.min(65535, Math.trunc(Number(elements.loginProxyLocalPort?.value) || 7890)));
    const proxyPool = mode === "pool" ? String(elements.loginProxyPool?.value || "").trim() : "";
    state.loginProxyMode = mode;
    state.loginProxyLocalPort = localProxyPort;
    state.loginProxyPool = String(elements.loginProxyPool?.value || "").trim();
    state.browserSettings.protocolSettings = {
      ...(state.browserSettings.protocolSettings || {}),
      proxyMode: mode,
      localProxyPort,
      proxyPool,
    };
    persistBrowserWorkspace();
    syncLoginProxyControls();
    return { proxyMode: mode, localProxyPort, proxyPool };
  }

  function restoreLoginProxySettings() {
    const settings = state.browserSettings?.protocolSettings || {};
    const savedMode = settings.proxyMode ?? state.loginProxyMode;
    const mode = ["local", "pool", "builtin"].includes(savedMode) ? savedMode : "direct";
    const localProxyPort = Math.max(1, Math.min(65535, Math.trunc(Number(settings.localProxyPort ?? state.loginProxyLocalPort) || 7890)));
    const pool = String(state.loginProxyPool || settings.proxyPool || "").trim();
    state.loginProxyMode = mode;
    state.loginProxyLocalPort = localProxyPort;
    state.loginProxyPool = pool;
    elements.loginProxyMode?.querySelectorAll('input[name="login-proxy-mode"]').forEach(input => {
      input.checked = input.value === mode;
    });
    if (elements.loginProxyLocalPort) elements.loginProxyLocalPort.value = String(localProxyPort);
    if (elements.loginProxyPool) elements.loginProxyPool.value = pool;
    syncLoginProxyControls();
  }

  function showLoginResetCredentials(credentials) {
    const lines = (credentials || []).map(item => String(item?.line || '').trim()).filter(Boolean);
    if (!elements.loginResetOutput || !elements.loginResetCredentials) return;
    elements.loginResetCredentials.textContent = lines.join("\n");
    elements.loginResetOutput.classList.toggle("hidden", lines.length === 0);
    state.loginSensitiveValues.push(...credentials.flatMap(item => [item?.password, item?.totp]).filter(Boolean));
  }

  function syncResetTotpInput(accountId) {
    // Use the unredacted browser snapshot, never credentials in SSE log payloads.
    const account = state.browserAccounts.find(row => String(row.id) === String(accountId));
    if (!account?.two_factor_secret) return;
    elements.loginAccounts.value = elements.loginAccounts.value.split(/\r?\n/).map(line => {
      const parts = splitLoginAccount(line);
      if (parts.length !== 3 || parts[0].toLowerCase() !== account.email.toLowerCase()) return line;
      return [account.email, account.openai_password || account.password, account.two_factor_secret].join('----');
    }).join('\n');
    state.loginSensitiveValues.push(account.two_factor_secret);
    return { password: account.openai_password || account.password, totp: account.two_factor_secret,
      line: [account.email, account.openai_password || account.password, account.two_factor_secret].join('----') };
  }

  async function resetLoginTotp() {
    if (monitorBusy || selfLeaveBusy || protocolLogoutBusy || elements.startProtocolLogin.disabled) return;
    const isCurrent = workspaceTaskIsCurrent();
    const completedCredentials = new Map();
    if (typeof window.confirm === "function" && !window.confirm("重设 2FA 会先禁用旧验证器，再生成新的 2FA 密钥。请确认你能立即保存新密钥。")) return;
    elements.resetLoginTotp.disabled = true;
    elements.protocolLogoutAll.disabled = true;
    elements.selfLeaveWorkspaces.disabled = true;
    elements.importLoginFile.disabled = true;
    elements.startProtocolLogin.disabled = true;
    elements.loginAccounts.disabled = true;
    stopSessionMonitor(true);
    try {
      const lines = parseLoginAccounts(elements.loginAccounts.value);
      initializeLoginProgress(lines, { preserveExports: true });
      const imported = await loginIcloudRequest("/api/v2/accounts/import", {
        text: lines.join("\n"),
        prepareRegistrationAssets: false,
      });
      if (!isCurrent()) return;
      const importedRows = Array.isArray(imported.rows) ? imported.rows : [];
      const ids = importedRows.map(row => row.id || row.account?.id).filter(Boolean).map(String);
      importedRows.forEach((row, index) => {
        const record = loginProgressRecord({ id: row.id || row.account?.id, email: row.email || row.account?.email || loginAccountEmail(lines[index]) });
        if (!record) return;
        record.id = String(row.id || row.account?.id || "");
        appendLoginProgress(record, "账号已导入，等待换绑队列调度", { stage: 0, status: "waiting" });
      });
      if (!ids.length) throw new Error("请先完成协议登录，再重设 2FA");
      const concurrency = selectedTaskConcurrency();
      setStatus(elements.loginStatus, `正在并发换绑 ${ids.length} 个账号的 2FA，并发 ${concurrency}...`);
      const result = await loginIcloudStream("/api/v2/accounts/reset-totp", { ids, concurrency, ...selectedLoginProxyNetwork() }, (name, data) => {
        const record = loginProgressRecord(data);
        if (name === "account_start") {
          appendLoginProgress(record, "开始换绑 2FA", { stage: 0, status: "running", time: data.time });
        } else if (name === "account_log") {
          appendLoginProgress(record, data.msg || data.error, {
            stage: /禁用旧|生成新的|激活|TOTP|2FA/i.test(data.msg || data.error) ? 3 : 2,
            status: "running", level: data.level, time: data.time,
          });
        } else if (name === "account_done") {
          if (data.ok) {
            const credential = syncResetTotpInput(data.id);
            if (credential) completedCredentials.set(String(data.id), credential);
            showLoginResetCredentials([...completedCredentials.values()]);
            persistBrowserWorkspace(true);
          }
          appendLoginProgress(record, data.ok ? "2FA 换绑成功" : (data.error || "2FA 换绑失败"), {
            stage: data.ok ? 4 : 3, status: data.ok ? "success" : "error", level: data.ok ? "info" : "error",
          });
        }
      });
      if (!isCurrent()) return;
      const credentials = (result.results || []).filter(item => item.ok).flatMap(item => {
        const credential = syncResetTotpInput(item.id);
        return credential ? [credential] : [];
      });
      showLoginResetCredentials(credentials);
      await persistBrowserWorkspace(true, true);
      const failed = Number(result.failed || 0);
      const firstError = (result.results || []).find(item => !item.ok)?.error || "";
      setStatus(elements.loginStatus, failed
        ? `2FA 换绑完成：成功 ${result.success || 0}，失败 ${failed}。${firstError ? `原因：${firstError}` : ""}`
        : `2FA 换绑成功：已更新 ${credentials.length} 个账号，并发 ${result.concurrency || concurrency}，请保存最新凭据。`, failed ? "error" : "ok");
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      setStatus(elements.loginStatus, message, "error");
    } finally {
      if (isCurrent()) {
        elements.resetLoginTotp.disabled = false;
        elements.protocolLogoutAll.disabled = false;
        elements.selfLeaveWorkspaces.disabled = false;
        elements.importLoginFile.disabled = false;
        elements.startProtocolLogin.disabled = false;
        elements.loginAccounts.disabled = false;
        scheduleSessionMonitor();
      }
    }
  }

  async function selfLeaveAccountWorkspaces() {
    if (monitorBusy || selfLeaveBusy || protocolLogoutBusy || elements.startProtocolLogin.disabled || elements.resetLoginTotp.disabled) return;
    const isCurrent = workspaceTaskIsCurrent();
    let disabled = [];
    try {
      const lines = parseLoginAccounts(elements.loginAccounts.value);
      if (!window.confirm(`确认对输入的 ${lines.length} 个账号执行自踢？\n\n将退出这些账号已加入的所有非 owner 团队工作区。退出后会失去对应工作区访问权限，需要重新邀请才能加入。个人空间保留。`)) return;
      selfLeaveBusy = true;
      stopSessionMonitor(true);
      renderSessionMonitor('定时测活暂停：正在执行自踢。');
      disabled = [...document.querySelectorAll('#login-workbench input, #login-workbench textarea, #login-workbench button, #push-controls input, #push-controls button')]
        .map(node => ({ node, disabled: node.disabled }));
      disabled.forEach(({ node }) => { node.disabled = true; });
      initializeLoginProgress(lines, { preserveExports: true });
      setStatus(elements.loginStatus, '正在导入自踢账号…');
      const imported = await loginIcloudRequest('/api/v2/accounts/import', { text: lines.join('\n'), prepareRegistrationAssets: false });
      requireCurrentWorkspace(isCurrent);
      const ids = [];
      for (const [index, row] of (imported.rows || []).entries()) {
        const id = row.id || row.account?.id;
        const record = loginProgressRecord({ id, email: row.email || row.account?.email || loginAccountEmail(lines[index]) });
        if (row.ok && id) { ids.push(String(id)); if (record) record.id = String(id); }
        appendLoginProgress(record, row.ok ? '等待自踢队列调度' : row.error || '账号导入失败', { stage: 0, status: row.ok ? 'waiting' : 'error' });
      }
      if (!ids.length) throw new Error('没有可自踢的账号，请检查邮箱、密码和 TOTP 格式');
      setStatus(elements.loginStatus, `正在自踢 ${ids.length} 个账号，并发 ${selectedTaskConcurrency()}…`);
      const result = await loginIcloudStream('/api/v2/accounts/self-leave', { ids, confirmed: true, ...selectedLoginProxyNetwork() }, (name, data) => {
        const record = loginProgressRecord(data);
        if (name === 'account_start') appendLoginProgress(record, '开始核实团队工作区', { stage: 0, status: 'running' });
        if (name === 'account_log') appendLoginProgress(record, data.msg, { stage: 5, status: 'running', level: data.level });
        if (name === 'account_done') {
          if (data.unconfirmed) markMonitorStopped(data.id, 'self_leave_pending');
          if (data.terminalReason) markMonitorStopped(data.id, data.terminalReason);
          appendLoginProgress(record, data.error || `已退出 ${data.left || 0} 个工作区，跳过 ${data.skipped || 0}，待确认 ${data.unconfirmed || 0}，失败 ${data.failed || 0}`,
            { stage: 5, status: data.ok ? 'success' : 'error' });
        }
      });
      requireCurrentWorkspace(isCurrent);
      const leftIds = new Set();
      for (const row of result.results || []) {
        if (row.unconfirmed) markMonitorStopped(row.id, 'self_leave_pending');
        if (row.terminalReason) markMonitorStopped(row.id, row.terminalReason);
        for (const workspace of row.workspaces || []) if (workspace.status === 'left') leftIds.add(workspace.workspaceId);
      }
      state.loginBusinessIds = state.loginBusinessIds.filter(id => state.browserAccounts.some(account => String(account.id) === id
        && (account.business_openai_rt || account.business_workspace_credentials?.some(row => row.refreshToken))));
      state.loginSessionIds = state.loginSessionIds.filter(id => state.browserAccounts.some(account => String(account.id) === id && account.session_access_token));
      if (state.pushRetry?.accounts) {
        state.pushRetry.accounts = state.pushRetry.accounts.filter(account => !leftIds.has(account.account_id || account.credentials?.chatgpt_account_id || account.credentials?.account_id));
        if (!state.pushRetry.accounts.length) state.pushRetry = null;
      }
      const failed = Number(result.failed || 0) + Number(imported.failed || 0);
      setStatus(elements.loginStatus, `自踢完成：已确认退出 ${result.left || 0} 个工作区，${result.unconfirmed || 0} 个待确认，失败账号 ${failed}。${result.unconfirmed ? '待确认账号已暂停测活，请在 ChatGPT 核对后手动登录。' : ''}`, failed || result.unconfirmed ? 'error' : 'ok');
      await persistBrowserWorkspace(true, true);
    } catch (error) {
      if (isCurrent()) {
        for (const record of state.loginProgress.values()) if (selfLeaveBusy && ['running', 'waiting'].includes(record.status)) {
          appendLoginProgress(record, '自踢结果未确认，请核对工作区后再操作', { status: 'error' });
          if (record.id) markMonitorStopped(record.id, 'self_leave_pending');
        }
        setStatus(elements.loginStatus, error.message || '自踢失败', 'error');
        persistBrowserWorkspace(true);
      }
    } finally {
      selfLeaveBusy = false;
      if (isCurrent()) {
        disabled.forEach(({ node, disabled: value }) => { node.disabled = value; });
        updateLoginExportActions();
        elements.exportLoginSessions.disabled = !state.loginSessionIds.length;
        updatePushControls();
        scheduleSessionMonitor();
      }
    }
  }

  async function protocolLogoutAllSessions() {
    if (monitorBusy || selfLeaveBusy || protocolLogoutBusy || elements.startProtocolLogin.disabled || elements.resetLoginTotp.disabled) return;
    const isCurrent = workspaceTaskIsCurrent();
    let disabled = [];
    try {
      const lines = parseLoginAccounts(elements.loginAccounts.value);
      if (!window.confirm(`确认对输入的 ${lines.length} 个账号退出全部 ChatGPT 会话？\n\n优先使用浏览器缓存的 Session，失效时才使用密码和 TOTP 登录。退出成功后会清理本地认证缓存，并暂停这些账号的自动重登。`)) return;
      protocolLogoutBusy = true;
      stopSessionMonitor(true);
      renderSessionMonitor('定时测活暂停：正在退出全部会话。');
      disabled = [...document.querySelectorAll('#login-workbench input, #login-workbench textarea, #login-workbench button, #push-controls input, #push-controls button')]
        .map(node => ({ node, disabled: node.disabled }));
      disabled.forEach(({ node }) => { node.disabled = true; });
      initializeLoginProgress(lines, { preserveExports: true });
      setStatus(elements.loginStatus, '正在导入退出会话账号…');
      const imported = await loginIcloudRequest('/api/v2/accounts/import', { text: lines.join('\n'), prepareRegistrationAssets: false });
      requireCurrentWorkspace(isCurrent);
      const ids = [];
      for (const [index, row] of (imported.rows || []).entries()) {
        const id = row.id || row.account?.id;
        const record = loginProgressRecord({ id, email: row.email || row.account?.email || loginAccountEmail(lines[index]) });
        if (row.ok && id) { ids.push(String(id)); if (record) record.id = String(id); }
        appendLoginProgress(record, row.ok ? '等待退出会话队列调度' : row.error || '账号导入失败', { stage: 0, status: row.ok ? 'waiting' : 'error' });
      }
      if (!ids.length) throw new Error('没有可退出会话的账号，请检查邮箱、密码和 TOTP 格式');
      setStatus(elements.loginStatus, `正在退出 ${ids.length} 个账号的全部会话，并发 ${selectedTaskConcurrency()}…`);
      const result = await loginIcloudStream('/api/v2/accounts/protocol-logout-all', { ids, confirmed: true, ...selectedLoginProxyNetwork() }, (name, data) => {
        const record = loginProgressRecord(data);
        if (name === 'account_start') appendLoginProgress(record, '优先复用缓存会话，开始退出全部会话', { stage: 0, status: 'running' });
        if (name === 'account_log') appendLoginProgress(record, data.msg, { stage: 4, status: 'running', level: data.level });
        if (name === 'account_done') {
          if (data.ok) {
            markMonitorStopped(data.id, 'sessions_logged_out');
            for (const key of ['loginSessionIds', 'loginPersonalIds', 'loginBusinessIds']) state[key] = state[key].filter(id => String(id) !== String(data.id));
            // A queued push must never restore a token invalidated by logout.
            state.pushRetry = null;
            persistBrowserWorkspace(true);
          }
          if (data.terminalReason) markMonitorStopped(data.id, data.terminalReason);
          appendLoginProgress(record, data.error || (data.ok ? '全部会话已退出' : '退出全部会话失败'), { stage: 4, status: data.ok ? 'success' : 'error' });
        }
      });
      requireCurrentWorkspace(isCurrent);
      const failed = Number(result.failed || 0) + Number(imported.failed || 0);
      setStatus(elements.loginStatus, `退出全部会话完成：成功 ${result.success || 0}，失败 ${failed}。${failed ? '失败账号可重新点击按钮重试。' : ''}`, failed ? 'error' : 'ok');
      await persistBrowserWorkspace(true, true);
    } catch (error) {
      if (isCurrent()) {
        for (const record of state.loginProgress.values()) if (protocolLogoutBusy && ['running', 'waiting'].includes(record.status)) {
          appendLoginProgress(record, '退出结果未确认，请核对账号会话状态', { status: 'error' });
        }
        setStatus(elements.loginStatus, error.message || '退出全部会话失败', 'error');
        persistBrowserWorkspace(true);
      }
    } finally {
      protocolLogoutBusy = false;
      if (isCurrent()) {
        disabled.forEach(({ node, disabled: value }) => { node.disabled = value; });
        updateLoginExportActions();
        elements.exportLoginSessions.disabled = !state.loginSessionIds.length;
        updatePushControls();
        scheduleSessionMonitor();
      }
    }
  }

  async function startProtocolLogin() {
    if (monitorBusy || selfLeaveBusy || protocolLogoutBusy || elements.resetLoginTotp.disabled) return;
    const isCurrent = workspaceTaskIsCurrent();
    elements.startProtocolLogin.disabled = true;
    elements.resetLoginTotp.disabled = true;
    elements.protocolLogoutAll.disabled = true;
    elements.selfLeaveWorkspaces.disabled = true;
    elements.importLoginFile.disabled = true;
    elements.exportLoginSessions.disabled = true;
    elements.exportLoginPersonal.disabled = true;
    elements.exportLoginBusiness.disabled = true;
    let retryInputLines = [];
    let retryWorkspaceMode = "all";
    try {
      const inputLines = parseLoginAccounts(elements.loginAccounts.value);
      const concurrency = selectedTaskConcurrency();
      const workspaceMode = getLoginWorkspaceMode();
      retryInputLines = inputLines;
      retryWorkspaceMode = workspaceMode;
      const retry = pendingLoginRetry(inputLines, workspaceMode);
      const lines = retry
        ? retry.accounts.map(item => inputLines.find(line => loginAccountEmail(line).toLowerCase() === String(item.email || '').toLowerCase()) || item.email)
        : inputLines;
      const previousLoginAccounts = retry ? [...state.loginLastAccounts] : [];
      const previousLastIds = retry ? [...state.loginLastIds] : [];
      const previousSessionIds = retry ? [...state.loginSessionIds] : [];
      const previousPersonalIds = retry ? [...state.loginPersonalIds] : [];
      const previousBusinessIds = retry ? [...state.loginBusinessIds] : [];

      initializeLoginProgress(lines, { preserveExports: Boolean(retry) });
      let imported = { rows: [], failed: 0 };
      let importedRows = [];
      let ids = retry ? retry.ids.map(String) : [];
      if (retry) {
        setStatus(elements.loginStatus, `正在重试 ${ids.length} 个失败账号，并发 ${concurrency}...`);
        for (const item of retry.accounts) {
          const record = loginProgressRecord(item);
          if (record) record.id = String(item.id);
          appendLoginProgress(record, "失败账号已加入重试队列", { stage: 0, status: "waiting" });
        }
      } else {
        setStatus(elements.loginStatus, `正在导入 ${lines.length} 个账号，并发 ${concurrency}...`);
        imported = await loginIcloudRequest("/api/v2/accounts/import", {
          text: lines.join("\n"),
          prepareRegistrationAssets: false,
        });
        if (!isCurrent()) return;
        importedRows = Array.isArray(imported.rows) ? imported.rows : [];
        ids = importedRows.map((row) => row.id || row.account?.id).filter(Boolean);
      }
      state.loginLastIds = ids.map(String);
      if (!retry) importedRows.forEach((row, index) => {
        const record = loginProgressRecord({ id: row.id || row.account?.id, email: row.email || row.account?.email || loginAccountEmail(lines[index]) });
        if (!record) return;
        record.id = String(row.id || row.account?.id || "");
        appendLoginProgress(record, "账号已导入，等待并发队列调度", { stage: 0, status: "waiting" });
      });
      setStatus(elements.loginStatus, `正在${workspaceMode === "session" ? "协议登录" : "获取全部工作区 RT"} ${lines.length} 个账号，并发 ${concurrency}...`);
      const pipeline = await loginIcloudStream("/api/v2/accounts/protocol-login-pipeline", {
        ids,
        concurrency,
        workspaceMode,
        ...selectedLoginProxyNetwork(),
      }, (name, data) => {
        const record = loginProgressRecord(data);
        if (name === 'account_timing') { updateLoginTimings(record, { [data.stage]: data }); return; }
        if (name === 'account_done' && data.timings) updateLoginTimings(record, data.timings);
        if (name === "account_start") {
          appendLoginProgress(record, "准备检测代理连通性", { stage: 0, status: "running", time: data.time });
        } else if (name === "account_phase") {
          const stage = data.phase === "business" ? 5 : 0;
          const message = data.phase === "business" ? "逐个授权已加入的工作区" : "准备检测代理连通性";
          appendLoginProgress(record, message, { stage, status: "running", time: data.time });
        } else if (name === "account_log") {
          appendLoginProgress(record, data.msg || data.error, {
            stage: data.phase === "business" ? 5 : inferLoginStage(data.msg || data.error, record?.stage || 0),
            status: "running", level: data.level, time: data.time,
          });
        } else if (name === "account_done") {
          if (record && data.terminalReason) record.terminalReason = data.terminalReason;
          if (record && data.error) record.error = sanitizeLoginLog(data.error);
          if (data.ok) {
            const doneText = workspaceMode === "session"
              ? "协议登录完成，Session 已就绪"
              : `RT 已就绪：个人 1 个，工作区 ${data.businessSuccess || 0} 个`;
            appendLoginProgress(record, doneText, { stage: workspaceMode === "session" ? 4 : 6, status: "success" });
          } else {
            appendLoginProgress(record, data.error || "账号处理失败", { status: "error", level: "error" });
          }
        }
      });
      if (!isCurrent()) return;
      state.loginLastResponse = pipeline;
      const accountById = new Map([...previousLoginAccounts, ...(pipeline.accounts || [])].map(account => [String(account.id), account]));
      state.loginLastAccounts = [...accountById.values()];
      const results = pipeline.results || [];
      const successful = results.filter((item) => item.ok);
      for (const item of successful) { delete state.monitorRetries[item.id]; delete state.monitorStopped[item.id]; }
      state.loginSessionIds = [...new Set([...previousSessionIds, ...results.filter((item) => item.sessionOk).map((item) => String(item.id))])];
      state.loginPersonalIds = [...new Set([...previousPersonalIds, ...results.filter((item) => item.personalOk).map((item) => String(item.id))])];
      state.loginBusinessIds = [...new Set([...previousBusinessIds, ...results.filter((item) => Number(item.businessSuccess) > 0).map((item) => String(item.id))])];
      state.loginLastIds = [...new Set([...previousLastIds, ...successful.map((item) => String(item.id))])];
      state.loginLastRtKind = workspaceMode;
      setLoginRetry(results, inputLines, workspaceMode);
      elements.exportLoginSessions.disabled = state.loginSessionIds.length === 0;
      updateLoginExportActions();
      if (selectedPushTarget() !== 'none' && workspaceMode !== "session") {
        const exportIds = pipelineRtIds(results);
        await autoPushLoginResults({ selectedIds: exportIds });
        if (!isCurrent()) return;
      }
      const retryCount = Number(state.loginRetry?.ids?.length || 0);
      setStatus(elements.loginStatus, `全部流程完成：成功 ${pipeline.success || 0}，失败 ${pipeline.failed || 0}，账号级并发 ${pipeline.concurrency || concurrency}。${retryCount ? `可再次点击“重试失败账号 (${retryCount})”。` : ''}`, pipeline.failed ? "error" : "ok");
      hideLoginModal();
      return;
   } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      Array.from(state.loginProgress.values()).filter((record) => record.status === "waiting" || record.status === "running").forEach((record) => {
        appendLoginProgress(record, `服务连接中断：${message}`, { status: "error", level: "error" });
      });
      setLoginRetryFromProgress(retryInputLines, retryWorkspaceMode);
      if (/手机号|手机|验证码|otp|phone|mfa|2fa/i.test(message)) showLoginModal(message);
      setStatus(elements.loginStatus, message, "error");
    } finally {
      if (isCurrent()) {
        elements.startProtocolLogin.disabled = false;
        elements.resetLoginTotp.disabled = false;
        elements.protocolLogoutAll.disabled = false;
        elements.selfLeaveWorkspaces.disabled = false;
        elements.importLoginFile.disabled = false;
        persistBrowserWorkspace(true);
      }
    }
  }

  function downloadLoginFile(text, fileName, type = "application/json;charset=utf-8") {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportLoginSessions() {
    const isCurrent = workspaceTaskIsCurrent();
    elements.exportLoginSessions.disabled = true;
    try {
      if (!state.loginSessionIds.length) throw new Error("本次流程没有可导出的 Session");
      const response = await pageFetch("/api/v2/accounts/export-sessions", {
        method: "POST",
        credentials: "same-origin",
        headers: loginProxyHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(browserRequestBody({ ids: state.loginSessionIds, aliveOnly: false, download: true })),
      });
      const text = await response.text();
      if (!isCurrent()) return;
      if (!response.ok) {
        let detail = "";
        try { detail = JSON.parse(text || "{}").error || ""; } catch {}
        throw new Error(detail || `Session 导出失败：HTTP ${response.status}`);
      }
      downloadLoginFile(text, `chatgpt-sessions.${getTimestampToken()}.txt`, "text/plain;charset=utf-8");
      setStatus(elements.loginStatus, `已下载 Session TXT，共 ${state.loginSessionIds.length} 行。`, "ok");
    } catch (error) {
      if (!isCurrent()) return;
      setStatus(elements.loginStatus, error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (isCurrent()) elements.exportLoginSessions.disabled = state.loginSessionIds.length === 0;
    }
  }

  async function exportLoginSub2api(rtKind) {
    const isCurrent = workspaceTaskIsCurrent();
    const button = rtKind === "business" ? elements.exportLoginBusiness : elements.exportLoginPersonal;
    const ids = rtKind === "business" ? state.loginBusinessIds : state.loginPersonalIds;
    button.disabled = true;
    try {
      if (!ids.length) throw new Error(`本次流程没有可导出的${rtKind === "business" ? " Business" : "个人"} RT`);
      const payload = await loginIcloudRequest("/api/v2/accounts/export-sub2api", { ids, rtKind, validateSession: false });
      if (!isCurrent()) return;
      const exportPayload = buildLoginSub2apiPayload(payload);
      downloadLoginFile(JSON.stringify(exportPayload, null, 2), `sub2api-login-${rtKind}.${getTimestampToken()}.json`);
      setStatus(elements.loginStatus, `已下载${rtKind === "business" ? " Business" : "个人"} sub2api，共 ${exportPayload.accounts.length} 个账号。`, "ok");
    } catch (error) {
      if (!isCurrent()) return;
      setStatus(elements.loginStatus, error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (isCurrent()) button.disabled = ids.length === 0;
    }
  }

  async function copyOutput() {
    const isCurrent = workspaceTaskIsCurrent();
    if (!state.outputText) {
      return;
    }

    try {
      await navigator.clipboard.writeText(state.outputText);
      if (!isCurrent()) return;
      setStatus(elements.outputStatus, "已复制到剪贴板。", "ok");
    } catch {
      if (!isCurrent()) return;
      elements.output.select();
      document.execCommand("copy");
      setStatus(elements.outputStatus, "已复制到剪贴板。", "ok");
    }
  }

  async function readFiles(files) {
    const isCurrent = workspaceTaskIsCurrent();
    if (state.format === "sub2api-tools") {
      const sourceFiles = Array.from(files).filter((file) => /\.(json|txt)$/i.test(file.name));
      if (!sourceFiles.length) {
        setStatus(elements.inputStatus, "没有选择 JSON 或 TXT 文件。", "error");
        return;
      }
      const texts = await Promise.all(sourceFiles.map((file) => file.text()));
      if (!isCurrent()) return;
      elements.input.value = texts.join("\n");
      scheduleConvert();
      return;
    }

    const sourceFiles = Array.from(files).filter((file) => /\.(json|txt)$/i.test(file.name));
    if (!sourceFiles.length) {
      setStatus(elements.inputStatus, "没有选择 JSON 或 TXT 文件。", "error");
      return;
    }

    const documents = [];
    const skipped = [];

    for (const file of sourceFiles) {
      try {
        const text = await file.text();
        if (!isCurrent()) return;
        const parsedValues = parseJsonValues(text);
        const found = parsedValues.flatMap((parsed) => collectSessionLikeObjects(parsed, file.webkitRelativePath || file.name));
        if (!found.length) {
          skipped.push({
            sourceName: file.webkitRelativePath || file.name,
            path: "$",
            reason: "未找到包含 accessToken 和 user/email 的 session 对象",
          });
        }
        documents.push(...found);
      } catch (error) {
        if (!isCurrent()) return;
        skipped.push({
          sourceName: file.webkitRelativePath || file.name,
          path: "$",
          reason: error instanceof Error ? error.message : "无法读取文件",
        });
      }
    }

    const now = new Date();
    const converted = [];
    const convertSkipped = [...skipped];
    documents.forEach((item) => {
      try {
        converted.push(convertSession(item.value, {
          now,
          sourceName: item.sourceName,
          sourcePath: item.path,
        }));
      } catch (error) {
        convertSkipped.push({
          sourceName: item.sourceName,
          path: item.path,
          reason: error instanceof Error ? error.message : "无法转换",
        });
      }
    });

    state.sessions = documents;
    state.converted = converted;
    state.skipped = convertSkipped;
    elements.input.value = documents.length === 1
      ? JSON.stringify(documents[0].value, null, 2)
      : JSON.stringify(documents.map((item) => item.value), null, 2);
    updateOutput();
    startHealthCheck();
    setStatus(elements.inputStatus, `读取 ${sourceFiles.length} 个文件，生成 ${converted.length} 个账号，跳过 ${convertSkipped.length} 项。`, converted.length ? "ok" : "error");
  }

  function updateToolControls() {
    elements.formatButtons.forEach((item) => {
      const isConverterGroup = item.dataset.formatGroup === "converter"
        && state.format !== "sub2api-tools"
        && state.format !== "protocol-login";
      item.setAttribute("aria-pressed", String(item.dataset.format === state.format || isConverterGroup));
    });
    updatePushControls();
    const isTool = state.format === "sub2api-tools";
    const isLogin = state.format === "protocol-login";
    const isSub2apiOutput = state.format === "sub2api" || isTool;
    const isSplit = isTool && elements.sub2apiOperation.value === "split";
    elements.sub2apiToolConfig.classList.toggle("hidden", !isTool);
    elements.sub2apiToolConfig.setAttribute("aria-hidden", String(!isTool));
    elements.toolOperationButtons.classList.toggle("is-visible", isTool);
    elements.operationButtons.forEach((button) => {
      const active = button.dataset.operation === elements.sub2apiOperation.value;
      button.setAttribute("aria-pressed", String(active));
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      if (active) elements.sub2apiToolConfig.setAttribute("aria-labelledby", button.id);
    });
    elements.sub2apiOutputConfig.classList.toggle("hidden", !isSub2apiOutput);
    elements.mailInputLabel.classList.toggle("hidden", !isSplit);
    elements.splitScopeLabel.classList.toggle("hidden", !isSplit);
    elements.sessionGuide.classList.toggle("hidden", isTool || isLogin);
    elements.healthFilterLabel.classList.remove("hidden");
    elements.usageFilterLabel.classList.toggle("hidden", !isTool);
    elements.loginWorkbench.classList.toggle("hidden", !isLogin);
    elements.converterWorkspace.classList.toggle("hidden", isLogin);
    elements.converterWorkspace.setAttribute("aria-hidden", String(isLogin));
    elements.converterActions.classList.toggle("hidden", isLogin);
    elements.formatToolbar.classList.toggle("hidden", isLogin);
    elements.formatRail.classList.toggle("hidden", isLogin || isTool);
    const formatTabs = [...document.querySelectorAll("#format-list [role=\"tab\"]")];
    for (const tab of formatTabs) {
      const active = tab.dataset.format === state.format;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active) elements.converterWorkspace.setAttribute("aria-labelledby", tab.id);
    }
    elements.healthStatus.classList.remove("hidden");
    elements.healthTable.classList.remove("hidden");
    elements.inputTitle.textContent = isTool ? "sub2api 批处理" : (isLogin ? "协议登录输入" : "Session JSON");
    elements.inputSubtitle.textContent = isTool ? "粘贴 sub2api JSON/TXT，或选择一个或多个文件。" : (isLogin ? "在左侧输入账号并启动协议登录，右侧查看结果。" : "粘贴 ChatGPT Web session，或拖入一个或多个 JSON 文件。");
    elements.loadExample.textContent = isTool ? "填入 sub2api 示例" : "填入示例结构";
    elements.input.disabled = isLogin;
    elements.pickFiles.disabled = isLogin;
    elements.loadExample.disabled = isLogin;
    elements.clearInput.disabled = isLogin;
    syncLogoutAllSessionsButton();
  }

  const selectFormat = (format) => {
    state.format = format;
    updateToolControls();
    scheduleConvert();
    if (state.format === "protocol-login" && !state.loginSub2Loaded) {
      const isCurrent = workspaceTaskIsCurrent();
      loadLoginSub2Config().catch((error) => {
        if (!isCurrent()) return;
        setStatus(elements.loginSub2Status, `加载 Sub2 配置失败：${error instanceof Error ? error.message : String(error)}`, "error");
      });
    }
  };
  elements.formatButtons.forEach((button) => button.addEventListener("click", () => selectFormat(button.dataset.format)));
  const bindTabKeyboard = (selector, onSelect) => {
    const tabs = [...document.querySelectorAll(selector)];
    for (const tab of tabs) {
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const index = tabs.indexOf(tab);
        const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        const next = tabs[nextIndex];
        onSelect(next);
        next.focus();
      });
    }
  };
  bindTabKeyboard("#format-list [role=\"tab\"]", (tab) => selectFormat(tab.dataset.format));

  elements.input?.addEventListener("input", scheduleConvert);
  ["dragenter", "dragover"].forEach((type) => elements.inputDropzone?.addEventListener(type, (event) => {
    event.preventDefault();
    event.stopPropagation();
    elements.inputDropzone.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((type) => elements.inputDropzone?.addEventListener(type, (event) => {
    event.preventDefault();
    event.stopPropagation();
    elements.inputDropzone.classList.remove("is-dragging");
  }));
  elements.inputDropzone?.addEventListener("drop", (event) => {
    const files = event.dataTransfer?.files;
    if (files?.length) readFiles(files);
  });
  elements.loginAccounts?.addEventListener("input", () => {
    clearLoginRetry();
    if (!state.loginProgress.size) elements.loginAccountCount.textContent = `${countLoginAccountLines()} 个账号`;
  });
  elements.loginWorkspaceMode?.addEventListener("change", () => {
    if (state.loginRetry && state.loginRetry.workspaceMode !== getLoginWorkspaceMode()) clearLoginRetry();
    updateLoginExportActions();
  });
  elements.loginProxyMode?.addEventListener("change", () => selectedLoginProxyNetwork());
  elements.loginProxyLocalPort?.addEventListener("input", () => selectedLoginProxyNetwork());
  elements.loginProxyPool?.addEventListener("input", () => selectedLoginProxyNetwork());
  syncLoginProxyControls();
  elements.copyOutput?.addEventListener("click", copyOutput);
  elements.downloadOutput?.addEventListener("click", downloadOutput);
  elements.logoutAllSessions?.addEventListener("click", () => logoutAllHealthySessions());
  elements.downloadMatched?.addEventListener("click", () => downloadSplitGroup("matched"));
  elements.downloadUnmatched?.addEventListener("click", () => downloadSplitGroup("unmatched"));
  elements.startProtocolLogin?.addEventListener("click", () => startProtocolLogin());
  elements.resetLoginTotp?.addEventListener("click", () => resetLoginTotp());
  elements.protocolLogoutAll?.addEventListener('click', () => protocolLogoutAllSessions());
  elements.selfLeaveWorkspaces?.addEventListener('click', () => selfLeaveAccountWorkspaces());
  elements.copyLoginResetOutput?.addEventListener("click", async () => {
    const isCurrent = workspaceTaskIsCurrent();
    const text = elements.loginResetCredentials?.textContent || "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      if (!isCurrent()) return;
      setStatus(elements.loginStatus, "最新账号凭据已复制。", "ok");
    } catch {
      if (!isCurrent()) return;
      setStatus(elements.loginStatus, "复制失败，请手动选择并复制最新账号凭据。", "error");
    }
  });
  elements.exportLoginSessions?.addEventListener("click", exportLoginSessions);
  elements.exportLoginPersonal?.addEventListener("click", () => exportLoginSub2api("personal"));
  elements.exportLoginBusiness?.addEventListener("click", () => exportLoginSub2api("business"));
  elements.importLoginFile?.addEventListener('click', () => elements.loginFileInput.click());
  elements.loginFileInput?.addEventListener('change', event => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    void importLoginFiles(files);
  });
  elements.pushTarget?.addEventListener('change', () => {
    requireMonitorPushConfig();
    updatePushControls();
    persistBrowserWorkspace();
    scheduleSessionMonitor();
  });
  document.querySelector('#session-monitor-choice')?.addEventListener('change', () => {
    state.monitorEnabled = document.querySelector('input[name="session-monitor"]:checked')?.value === 'on';
    requireMonitorPushConfig();
    syncMonitorChoice();
    monitorLastSummary = '';
    if (!state.monitorEnabled) {
      stopSessionMonitor(true);
      renderSessionMonitor('定时测活已关闭。');
    } else monitorNextAt = Date.now() + 60_000;
    persistBrowserWorkspace();
    scheduleSessionMonitor();
  });
  elements.pushConverted?.addEventListener('click', () => runPush(async target => selectedConverted().map(item => target === 'cpa' ? item.cpa : applySub2apiOutputConfig(item.sub2apiAccount))));
  elements.retryPush?.addEventListener('click', () => runPush(async () => state.pushRetry?.accounts || [], { retry: true, upsert: state.pushRetry?.upsert === true }));
  document.querySelector('#open-sub2-push-config')?.addEventListener('click', () => {
    void loadLoginSub2Config();
    elements.sub2PushDialog.showModal();
  });
  document.querySelector('#open-cpa-push-config')?.addEventListener('click', () => {
    elements.cpaBaseUrl.value = state.cpaSettings.baseUrl || '';
    elements.cpaManagementKey.value = state.cpaSettings.managementKey || '';
    elements.cpaPushDialog.showModal();
  });
  for (const button of document.querySelectorAll('[data-close-dialog]')) button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog).close());
  const cpaFormSettings = () => ({ baseUrl: normalizePushAddress(elements.cpaBaseUrl.value, 'cpa'), managementKey: elements.cpaManagementKey.value.trim() });
  document.querySelector('#save-cpa-config')?.addEventListener('click', async () => {
    const isCurrent = workspaceTaskIsCurrent();
    try {
      const settings = cpaFormSettings();
      if (!settings.managementKey) throw new Error('请填写 CPA Management Key');
      state.cpaSettings = settings;
      await persistBrowserWorkspace(true, true);
      requireCurrentWorkspace(isCurrent);
      elements.cpaBaseUrl.value = settings.baseUrl;
      setStatus(elements.cpaConfigStatus, 'CPA 配置已加密保存在此浏览器。', 'ok');
    } catch (error) { if (isCurrent()) setStatus(elements.cpaConfigStatus, error.message, 'error'); }
  });
  document.querySelector('#check-cpa-config')?.addEventListener('click', async () => {
    const isCurrent = workspaceTaskIsCurrent();
    const button = document.querySelector('#check-cpa-config');
    button.disabled = true;
    try {
      const result = await remotePushRequest('cpa/check', { settings: cpaFormSettings() });
      requireCurrentWorkspace(isCurrent);
      setStatus(elements.cpaConfigStatus, `CPA 连接成功，当前 ${result.files} 个认证文件。`, 'ok');
    } catch (error) { if (isCurrent()) setStatus(elements.cpaConfigStatus, error.message, 'error'); }
    finally { if (isCurrent()) button.disabled = false; }
  });
  document.querySelector('#toggle-cpa-key')?.addEventListener('click', event => {
    const reveal = elements.cpaManagementKey.type === 'password';
    elements.cpaManagementKey.type = reveal ? 'text' : 'password';
    event.currentTarget.textContent = reveal ? '隐藏' : '显示';
  });
  for (const input of [elements.loginSub2BaseUrl, elements.loginSub2AdminKey]) input.addEventListener('input', () => {
    state.loginSub2SelectedGroupIds = [];
    state.loginSub2AvailableGroups = [];
    state.loginSub2KeyConfigured = Boolean(elements.loginSub2AdminKey.value);
    renderLoginSub2Groups();
  });
  for (const [dialog, key, toggle] of [
    [elements.sub2PushDialog, elements.loginSub2AdminKey, elements.toggleLoginSub2Key],
    [elements.cpaPushDialog, elements.cpaManagementKey, document.querySelector('#toggle-cpa-key')],
  ]) dialog.addEventListener('close', () => { key.type = 'password'; toggle.textContent = '显示'; });

  elements.loginWorkspaceMode?.addEventListener("change", updateLoginExportActions);
  const runSub2Action = (action) => {
    const isCurrent = workspaceTaskIsCurrent();
    action().catch((error) => {
      if (isCurrent()) setStatus(elements.loginSub2Status, error instanceof Error ? error.message : String(error), "error");
    });
  };
  elements.loadLoginSub2Groups?.addEventListener("click", () => runSub2Action(loadLoginSub2Groups));
  elements.saveLoginSub2Config?.addEventListener("click", () => runSub2Action(saveLoginSub2Config));
  elements.loginSub2Groups?.addEventListener('change', event => {
    const input = event.target;
    if (!input.matches('input[data-sub2-group-id]')) return;
    const id = Number(input.dataset.sub2GroupId);
    const selected = new Set(state.loginSub2SelectedGroupIds);
    if (input.checked) selected.add(id); else selected.delete(id);
    state.loginSub2SelectedGroupIds = [...selected];
    elements.loginSub2GroupCount.textContent = `已选 ${selected.size} 个`;
    persistBrowserWorkspace();
  });
  elements.toggleLoginSub2Key?.addEventListener("click", () => {
    const reveal = elements.loginSub2AdminKey.type === "password";
    elements.loginSub2AdminKey.type = reveal ? "text" : "password";
    elements.toggleLoginSub2Key.textContent = reveal ? "隐藏" : "显示";
  });
  elements.closeLoginModal?.addEventListener("click", hideLoginModal);
  elements.loginModal?.addEventListener("click", (event) => {
    if (event.target === elements.loginModal) hideLoginModal();
  });
  if (typeof document.addEventListener === "function") document.addEventListener("keydown", (event) => {
    if (!elements.loginModal || elements.loginModal.classList.contains("hidden")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      hideLoginModal();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...elements.loginModal.querySelectorAll("button:not(:disabled), [href], [tabindex]:not([tabindex=\"-1\"])")];
    if (!focusable.length) {
      event.preventDefault();
      elements.loginModal.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  elements.downloadScope?.addEventListener("change", updateOutput);
  elements.healthFilter?.addEventListener("change", renderHealth);
  elements.usageFilter?.addEventListener("change", () => {
    renderHealth();
    updateOutput();
  });
  const selectOperation = (operation) => {
    elements.sub2apiOperation.value = operation;
    updateToolControls();
    scheduleConvert();
  };
  elements.operationButtons.forEach((button) => button.addEventListener("click", () => selectOperation(button.dataset.operation)));
  bindTabKeyboard("#tool-operation-buttons [role=\"tab\"]", (tab) => selectOperation(tab.dataset.operation));
  elements.sub2apiModels?.addEventListener("input", updateOutput);
  elements.sub2apiConcurrency?.addEventListener("input", updateOutput);
  elements.sub2apiLoadFactor?.addEventListener("input", updateOutput);
  elements.sub2apiPriority?.addEventListener("input", updateOutput);
  elements.sub2apiFingerprintMode?.addEventListener("change", updateOutput);
  elements.splitScope?.addEventListener("change", updateOutput);
  elements.mailInput?.addEventListener("input", scheduleConvert);
  elements.pickMailFile?.addEventListener("click", () => elements.mailFileInput?.click());
  elements.mailFileInput?.addEventListener("change", async (event) => {
    const isCurrent = workspaceTaskIsCurrent();
    const [file] = Array.from(event.target.files || []);
    if (file) {
      const text = await file.text();
      if (!isCurrent()) return;
      elements.mailInput.value = text;
      scheduleConvert();
    }
    event.target.value = "";
  });
  elements.pickFiles.addEventListener("click", () => elements.fileInput.click());
  elements.fileInput.addEventListener("change", (event) => {
    readFiles(event.target.files);
    event.target.value = "";
  });

  elements.clearInput.addEventListener("click", () => {
    elements.input.value = "";
    scheduleConvert();
  });

  elements.loadExample.addEventListener("click", () => {
    elements.input.value = state.format === "sub2api-tools"
      ? JSON.stringify({
        type: "sub2api-data",
        version: 1,
        exported_at: new Date().toISOString(),
        proxies: [],
        accounts: [{
          name: "mark@example.com",
          platform: "openai",
          type: "oauth",
          credentials: { access_token: "access-token", email: "mark@example.com" },
        }],
      }, null, 2)
      : JSON.stringify(exampleSession, null, 2);
    scheduleConvert();
  });

  if (typeof window !== 'undefined' && window.browserWorkspace) {
    const storageStatus = document.querySelector('#browser-storage-status');
    const clearButton = document.querySelector('#clear-browser-data');
    const clearLoginButton = document.querySelector('#clear-login-data');
    const initialControls = [...document.querySelectorAll('input, textarea, select, button')].map(node => ({
      node, value: node.value, checked: node.checked, disabled: node.disabled, type: node.type,
    }));
    const blockWorkspaceTasks = (release = false) => {
      // A stale tab shares the browser owner ID: only an explicit clear may release it.
      stopSessionMonitor(release);
      monitorLastSummary = '';
      renderSessionMonitor('定时测活已停止：本地数据已清空或其他标签页已更新。');
      browserStorageCleared = true;
      workspaceGeneration += 1;
      hidePushToast();
      clearTimeout(browserSaveTimer);
      if (state.loginRenderFrame) cancelAnimationFrame(state.loginRenderFrame);
      state.loginRenderFrame = 0;
    };
    const disableWorkspaceControls = () => {
      document.querySelectorAll('input, textarea, select, button').forEach(node => { node.disabled = true; });
    };
    const resetWorkspaceView = (retained = null) => {
      pushBusy = false;
      const format = state.format;
      Object.assign(state, createWorkspaceState(), { format }, retained?.state, { loginProgress: new Map() });
      initialControls.forEach(({ node, value, checked, disabled, type }) => {
        if (node.tagName === 'INPUT') node.type = type;
        node.value = node.type === 'file' ? '' : value;
        node.scrollTop = 0;
        node.scrollLeft = 0;
        if (typeof checked === 'boolean') node.checked = checked;
        node.disabled = disabled;
      });
      if (retained) restoreBrowserFields(retained.fields);
      syncMonitorChoice();
      loginModalReturnFocus = null;
      hideLoginModal();
      elements.loginModalMessage.textContent = '';
      elements.loginResetCredentials.textContent = '';
      elements.loginResetOutput.classList.add('hidden');
      elements.toggleLoginSub2Key.textContent = '显示';
      document.querySelector('#toggle-cpa-key').textContent = '显示';
      renderLogoutProgress();
      renderLoginSub2Groups();
      renderLoginProgress();
      syncLoginProxyControls();
      updateLoginExportActions();
      updateToolControls();
      updateOutput();
      setStatus(elements.inputStatus, '等待输入。');
      setStatus(elements.healthStatus, '等待自动测活。');
      setStatus(elements.loginStatus, retained ? '登录数据已清空，代理和推送配置已保留。' : '所有数据已清空，可重新输入账号。');
      setStatus(elements.loginSub2Status, retained ? '已保留此浏览器的 Sub2API 配置。' : '尚未配置 Admin Key');
      setStatus(elements.cpaConfigStatus, retained ? '已保留此浏览器的 CPA 配置。' : '尚未配置 CPA。');
      setStatus(elements.pushStatus, '');
      for (const dialog of [elements.sub2PushDialog, elements.cpaPushDialog]) if (dialog.open) dialog.close();
      renderPushResults();
    };
    try {
      const saved = await window.browserWorkspace.read();
      if (saved?.state) {
        for (const key of Object.keys(state)) if (Object.hasOwn(saved.state, key)) state[key] = saved.state[key];
        // Older conversions omitted RT/ID tokens only from their Sub2API copy.
        // Restore those copies from the paired CPA record without inventing tokens.
        for (const item of state.converted) {
          const credentials = item.sub2apiAccount?.credentials;
          if (!credentials?.access_token || credentials.access_token !== item.cpa?.access_token) continue;
          for (const key of ['refresh_token', 'id_token']) {
            if (key === 'id_token' && item.cpa.id_token_synthetic) continue;
            const token = item.cpa[key];
            if (!credentials[key] && typeof token === 'string' && token.trim()) credentials[key] = token;
          }
        }
        state.loginProgress = new Map(saved.state.loginProgress || []);
        state.loginRenderFrame = 0;
        state.logoutInProgress = false;
        for (const record of state.loginProgress.values()) {
          if (['running', 'waiting'].includes(record.status)) {
            record.status = 'error';
            record.message = '页面已重新打开，请重新启动未完成的操作';
          }
        }
        restoreBrowserFields(saved.fields);
        syncMonitorChoice();
        elements.loginResetCredentials.textContent = saved.resetCredentials || '';
        elements.loginResetOutput.classList.toggle('hidden', !saved.resetCredentials);
        renderLoginSub2Groups();
        renderLoginProgress();
        restoreLoginProxySettings();
        renderAccounts();
        renderHealth();
        elements.exportLoginSessions.disabled = state.loginSessionIds.length === 0;
        updateLoginExportActions();
        renderPushResults();
      }
      browserStorageAvailable = true;
    } catch {
      document.querySelector('#browser-storage-status').textContent = '浏览器存储不可用，请及时下载结果';
    }
    window.browserWorkspace.subscribe((kind) => {
      blockWorkspaceTasks();
      if (kind === 'clear') resetWorkspaceView();
      if (kind === 'clear-login') resetWorkspaceView(settingsOnlyWorkspace());
      storageStatus.textContent = ['clear', 'clear-login'].includes(kind)
        ? (kind === 'clear-login' ? '另一个标签页已清空登录数据，请刷新后继续' : '另一个标签页已清空数据，请刷新后继续')
        : '另一个标签页已更新数据，请刷新后继续';
      disableWorkspaceControls();
    });
    window.addEventListener('pagehide', () => {
      monitorPaused = true;
      clearTimeout(monitorTimer);
      monitorController?.abort();
      persistBrowserWorkspace(true);
    });
    window.addEventListener('pageshow', () => { monitorPaused = false; scheduleSessionMonitor(); });
    window.addEventListener('online', scheduleSessionMonitor);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSessionMonitor(); });
    document.addEventListener('input', persistBrowserWorkspace);
    document.addEventListener('change', persistBrowserWorkspace);
    const clearWorkspace = async (loginOnly) => {
      if (clearingBrowserData) return;
      if (!loginOnly && !window.confirm('确认清空所有数据？\n\n将删除此浏览器中的账号、密码、TOTP、Session、RT 和结果，以及自定义代理、Sub2API 和 CPA 配置。定时测活也会停止。\n\n此操作无法撤销。如需保留配置，请取消并使用“清空登录数据”。')) return;
      clearingBrowserData = true;
      const retained = loginOnly ? settingsOnlyWorkspace() : null;
      blockWorkspaceTasks(true);
      const clearing = loginOnly ? window.browserWorkspace.clearLoginData(retained) : window.browserWorkspace.clear();
      resetWorkspaceView(retained);
      const clearedControls = [...document.querySelectorAll('input, textarea, select, button')].map(node => ({ node, disabled: node.disabled }));
      disableWorkspaceControls();
      storageStatus.textContent = loginOnly ? '正在清空登录数据…' : '正在清空所有数据…';
      try {
        await clearing;
        if (window.browserWorkspace.signal.aborted) return;
        clearedControls.forEach(({ node, disabled }) => { node.disabled = disabled; });
        browserStorageCleared = false;
        browserStorageReady = browserStorageAvailable = true;
        monitorNextAt = Date.now() + 60_000;
        scheduleSessionMonitor();
        storageStatus.textContent = loginOnly ? '登录数据已清空，配置已保留' : '所有数据已清空';
      } catch {
        storageStatus.textContent = '清空失败，请刷新后重试，或清空所有数据';
        clearButton.disabled = false;
      } finally {
        clearingBrowserData = false;
      }
    };
    clearButton.addEventListener('click', () => clearWorkspace(false));
    clearLoginButton.addEventListener('click', () => clearWorkspace(true));

  }
  updateToolControls();
  updateOutput();
  browserStorageReady = browserStorageAvailable;
  if (typeof window !== 'undefined' && window.browserWorkspace) {
    document.addEventListener('input', scheduleSessionMonitor);
    document.addEventListener('change', scheduleSessionMonitor);
    // Saving credentials/configuration may finish after its DOM event has fired.
    document.addEventListener('click', () => setTimeout(scheduleSessionMonitor, 500));
    scheduleSessionMonitor();
  }
  try {
    const response = await fetch('/api/system/config', { cache: 'no-store' });
    if (!response.ok) throw new Error('配置读取失败');
    const config = await response.json();
    if (!Number.isInteger(config.taskConcurrency) || config.taskConcurrency < 1) throw new Error('并发配置无效');
    taskConcurrency = config.taskConcurrency;
    elements.taskConcurrencyValue.textContent = String(taskConcurrency);
  } catch {
    elements.taskConcurrencyValue.textContent = '按服务端设置';
  }
})();
