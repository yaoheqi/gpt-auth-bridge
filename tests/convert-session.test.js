#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import vm from 'node:vm';
import { splitPasswordTotpLine } from '../docs/login-account-format.js';
import { OPERATION_SCHEMA_VERSION, validatePushResults, validateOperationEvent } from '../docs/operation-contract.js';

function createFakeElement(selector, options = {}) {
  const classes = new Set();

  return {
    selector,
    attributes: {},
    dataset: options.dataset || {},
    disabled: false,
    files: [],
    innerHTML: "",
    listeners: {},
    style: {},
    textContent: "",
    value: "",
    classList: {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
      toggle(name, force) {
        if (force) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
      },
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    append() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    click() {
      this.listeners.click?.({ target: this });
    },
    remove() {},
    select() {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
  };
}

function loadPageScript(options = {}) {
  const htmlPath = path.join(__dirname, "..", "docs", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "docs", "app.js"), "utf8");

  assert.match(html, /src="\/app.js"/);

  const elements = new Map();
  const formatButtons = ["sub2api", "cpa", "cockpit", "codex", "sub2api-tools"].map((format) =>
    createFakeElement(`[data-format="${format}"]`, { dataset: { format } })
  );

  const document = {
    body: createFakeElement("body"),
    createElement(selector) {
      return createFakeElement(selector);
    },
    execCommand() {
      return true;
    },
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, createFakeElement(selector));
      }
      return elements.get(selector);
    },
    querySelectorAll(selector) {
      return selector === "[data-format]" ? formatButtons : [];
    },
  };

  const context = {
    splitPasswordTotpLine,
    OPERATION_SCHEMA_VERSION,
    validatePushResults,
    validateOperationEvent,
    AbortController,
    TextDecoder,
    TextEncoder,
    URL: {
      createObjectURL() {
        return "blob:test";
      },
      revokeObjectURL() {},
    },
    atob,
    btoa,
    clearTimeout,
    console,
    document,
    fetch: (url, init) => url === '/api/system/config'
      ? Promise.resolve({ ok: true, json: async () => ({ taskConcurrency: options.taskConcurrency || 5 }) })
      : options.fetch?.(url, init),
    navigator: {
      clipboard: {
        async writeText() {},
      },
    },
    setTimeout,
  };

  vm.runInNewContext(script.replace(/^import .+;\r?\n/gm, ''), context, { filename: "docs/app.js" });

  return { elements, formatButtons };
}

function dispatch(element, type) {
  assert.equal(typeof element.listeners[type], "function", `missing ${type} listener on ${element.selector}`);
  element.listeners[type]({ target: element });
}

function jwtWithPayload(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
}

function testSub2apiAccountUsesAccessTokenExpiry() {
  const { elements } = loadPageScript();
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  input.value = JSON.stringify({
    user: {
      email: "mark@example.com",
    },
    accessToken: jwtWithPayload({
      exp: 1780473960,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "chatgpt-account-1",
      },
    }),
  });
  dispatch(input, "input");

  const document = JSON.parse(output.value);
  const account = document.accounts[0];

  assert.equal(document.expires_at, undefined);
  assert.equal(document.auto_pause_on_expired, undefined);
  assert.equal(document.accounts.length, 1);
  assert.equal(account.expires_at, 1780473960);
  assert.equal(account.auto_pause_on_expired, true);
  assert.equal(account.concurrency, 50);
  assert.equal(account.load_factor, 1000);
  assert.equal(account.priority, 1);
  assert.deepEqual(account.credentials.model_mapping, {
    "gpt-5.5": "gpt-5.5",
    "gpt-5.6-sol": "gpt-5.6-sol",
    "gpt-5.6-terra": "gpt-5.6-terra",
    "gpt-6-astra": "gpt-6-astra",
  });
  assert.equal(account.extra.codex_fingerprint_mode, "session");
}

function testSub2apiOutputConfigurationOverridesImportedAccount() {
  const { elements, formatButtons } = loadPageScript();
  selectSub2apiTools(elements, formatButtons, "txt-to-json");
  elements.get("#sub2api-models").value = "custom-a, custom-b custom-a";
  elements.get("#sub2api-concurrency").value = "23";
  elements.get("#sub2api-load-factor").value = "2500";
  elements.get("#sub2api-priority").value = "7";
  elements.get("#sub2api-fingerprint-mode").value = "full";
  const account = sub2apiAccount("override@example.com", "override");
  account.concurrency = 2;
  account.credentials.model_mapping = { old: "old" };
  account.extra = { codex_fingerprint_mode: "off", keep: true };
  elements.get("#session-input").value = JSON.stringify(sub2apiDocument([account]));
  dispatch(elements.get("#session-input"), "input");

  const outputAccount = JSON.parse(elements.get("#output").value).accounts[0];
  assert.equal(outputAccount.concurrency, 23);
  assert.equal(outputAccount.load_factor, 2500);
  assert.equal(outputAccount.priority, 7);
  assert.deepEqual(outputAccount.credentials.model_mapping, { "custom-a": "custom-a", "custom-b": "custom-b" });
  assert.equal(outputAccount.extra.codex_fingerprint_mode, "full");
  assert.equal(outputAccount.extra.keep, true);
}

function testSub2apiLoadFactorUsesSchedulerFieldNotBillingMultiplier() {
  const { elements, formatButtons } = loadPageScript();
  selectSub2apiTools(elements, formatButtons, "txt-to-json");
  elements.get("#session-input").value = JSON.stringify(sub2apiDocument([{
    ...sub2apiAccount("sample@example.com", "sample"),
    concurrency: 3,
    priority: 1,
    rate_multiplier: 1,
  }]));
  dispatch(elements.get("#session-input"), "input");

  const output = JSON.parse(elements.get("#output").value);
  const account = output.accounts[0];
  assert.equal(account.load_factor, 1000);
  assert.equal(account.rate_multiplier, 1);
  assert.equal(account.concurrency, 50);
  assert.equal(account.priority, 1);
}

function testSub2apiAccountsUseTheirOwnAccessTokenExpiry() {
  const { elements } = loadPageScript();
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  input.value = JSON.stringify([
    {
      email: "late@example.com",
      accessToken: jwtWithPayload({
        exp: 1780473960,
        "https://api.openai.com/auth": {
          chatgpt_account_id: "chatgpt-account-late",
        },
      }),
    },
    {
      email: "early@example.com",
      accessToken: jwtWithPayload({
        exp: 1780000000,
        "https://api.openai.com/auth": {
          chatgpt_account_id: "chatgpt-account-early",
        },
      }),
    },
  ]);
  dispatch(input, "input");

  const document = JSON.parse(output.value);

  assert.equal(document.expires_at, undefined);
  assert.equal(document.auto_pause_on_expired, undefined);
  assert.equal(document.accounts.length, 2);
  assert.equal(document.accounts[0].expires_at, 1780473960);
  assert.equal(document.accounts[0].auto_pause_on_expired, true);
  assert.equal(document.accounts[1].expires_at, 1780000000);
  assert.equal(document.accounts[1].auto_pause_on_expired, true);
}

function testSub2apiAccountWithRefreshTokenOmitsAccessTokenExpiry() {
  const { elements } = loadPageScript();
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  input.value = JSON.stringify({
    user: {
      email: "refreshable@example.com",
    },
    accessToken: jwtWithPayload({
      exp: 1780473960,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "chatgpt-account-refreshable",
      },
    }),
    refreshToken: "real-refresh-token",
    idToken: "real.id.signature",
    expiresAt: "2026-06-01T00:00:00.000Z",
  });
  dispatch(input, "input");

  const document = JSON.parse(output.value);
  const account = document.accounts[0];

  assert.equal(account.expires_at, undefined);
  assert.equal(account.auto_pause_on_expired, undefined);
  assert.equal(account.credentials.expires_at, undefined);
  assert.equal(account.credentials.expires_in, undefined);
  assert.equal(account.credentials.refresh_token, 'real-refresh-token');
  assert.equal(account.credentials.id_token, 'real.id.signature');
}

function testSyntheticIdTokenHasCodexParseableJwtFormat() {
  const { elements, formatButtons } = loadPageScript();
  const cpaButton = formatButtons.find((button) => button.dataset.format === "cpa");
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  dispatch(cpaButton, "click");
  input.value = JSON.stringify({
    user: {
      id: "user-test",
      email: "mark@example.com",
    },
    expires: "2026-08-06T14:29:36.155Z",
    account: {
      id: "00000000-0000-4000-9000-000000000000",
      planType: "plus",
    },
    accessToken: "access-token",
    sessionToken: "session-token",
  });
  dispatch(input, "input");

  const cpa = JSON.parse(output.value);
  const parts = cpa.id_token.split(".");

  assert.equal(cpa.id_token_synthetic, true);
  assert.equal(parts.length, 3);
  assert.ok(
    parts.every((part) => part.length > 0),
    "synthetic id_token must use non-empty header, payload, and signature segments"
  );

  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  assert.equal(payload.email, "mark@example.com");
  assert.equal(payload["https://api.openai.com/auth"].chatgpt_account_id, "00000000-0000-4000-9000-000000000000");
}

function testAxonHubAuthJsonUsesPlaceholderRefreshTokenWhenMissing() {
  const { elements, formatButtons } = loadPageScript();
  const axonHubButton = formatButtons.find((button) => button.dataset.format === "axonhub");
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  dispatch(axonHubButton, "click");
  input.value = JSON.stringify({
    user: {
      id: "user-test",
      email: "mark@example.com",
    },
    expires: "2026-08-06T14:29:36.155Z",
    account: {
      id: "00000000-0000-4000-9000-000000000000",
      planType: "plus",
    },
    accessToken: "access-token",
    sessionToken: "session-token",
  });
  dispatch(input, "input");

  const authJson = JSON.parse(output.value);

  assert.equal(authJson.auth_mode, "chatgpt");
  assert.equal(authJson.tokens.access_token, "access-token");
  assert.equal(authJson.tokens.refresh_token, "__missing_refresh_token__");
  assert.equal(authJson.tokens.id_token.split(".").length, 3);
  assert.equal(authJson.last_refresh, "2026-08-06T13:29:36.155Z");
  assert.equal(authJson.axonhub_refresh_token_placeholder, true);
  assert.equal(authJson.axonhub_note, "refresh_token is a placeholder; access_token works only until it expires.");
}

function testAxonHubAuthJsonPreservesRealRefreshToken() {
  const { elements, formatButtons } = loadPageScript();
  const axonHubButton = formatButtons.find((button) => button.dataset.format === "axonhub");
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  dispatch(axonHubButton, "click");
  input.value = JSON.stringify({
    user: {
      email: "mark@example.com",
    },
    expires: "2026-08-06T14:29:36.155Z",
    account: {
      id: "00000000-0000-4000-9000-000000000000",
      planType: "plus",
    },
    accessToken: "access-token",
    refreshToken: "real-refresh-token",
    idToken: "real.header.signature",
  });
  dispatch(input, "input");

  const authJson = JSON.parse(output.value);

  assert.equal(authJson.tokens.refresh_token, "real-refresh-token");
  assert.equal(authJson.tokens.id_token, "real.header.signature");
  assert.equal(authJson.axonhub_refresh_token_placeholder, undefined);
  assert.equal(authJson.axonhub_note, undefined);
}

function testCodexAuthJsonMatchesNativeShapeWhenMissingRefreshToken() {
  const { elements, formatButtons } = loadPageScript();
  const codexButton = formatButtons.find((button) => button.dataset.format === "codex");
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  dispatch(codexButton, "click");
  input.value = JSON.stringify({
    user: {
      id: "user-test",
      email: "mark@example.com",
    },
    expires: "2026-08-06T14:29:36.155Z",
    account: {
      id: "00000000-0000-4000-9000-000000000000",
      planType: "plus",
    },
    accessToken: "access-token",
    sessionToken: "session-token",
  });
  dispatch(input, "input");

  const authJson = JSON.parse(output.value);

  assert.equal(authJson.auth_mode, "chatgpt");
  assert.equal(authJson.OPENAI_API_KEY, null);
  assert.equal(authJson.tokens.access_token, "access-token");
  assert.equal(authJson.tokens.refresh_token, "");
  assert.equal(authJson.tokens.id_token.split(".").length, 3);
  assert.equal(authJson.tokens.account_id, "00000000-0000-4000-9000-000000000000");
  assert.match(authJson.last_refresh, /^\d{4}-\d{2}-\d{2}T/);
}

function testCodexAuthJsonPreservesRealRefreshTokenAndIdToken() {
  const { elements, formatButtons } = loadPageScript();
  const codexButton = formatButtons.find((button) => button.dataset.format === "codex");
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  dispatch(codexButton, "click");
  input.value = JSON.stringify({
    user: {
      email: "mark@example.com",
    },
    accessToken: "access-token",
    refreshToken: "real-refresh-token",
    idToken: "real.header.signature",
    tokens: {
      account_id: "chatgpt-account-1",
    },
  });
  dispatch(input, "input");

  const authJson = JSON.parse(output.value);

  assert.equal(authJson.auth_mode, "chatgpt");
  assert.equal(authJson.OPENAI_API_KEY, null);
  assert.equal(authJson.tokens.access_token, "access-token");
  assert.equal(authJson.tokens.refresh_token, "real-refresh-token");
  assert.equal(authJson.tokens.id_token, "real.header.signature");
  assert.equal(authJson.tokens.account_id, "chatgpt-account-1");
}

function testCodexManagerAuthJsonUsesEmptyRefreshTokenWhenMissing() {
  const { elements, formatButtons } = loadPageScript();
  const codexManagerButton = formatButtons.find((button) => button.dataset.format === "codexmanager");
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  dispatch(codexManagerButton, "click");
  input.value = JSON.stringify({
    user: {
      id: "user-test",
      email: "mark@example.com",
    },
    expires: "2026-08-06T14:29:36.155Z",
    account: {
      id: "00000000-0000-4000-9000-000000000000",
      planType: "plus",
    },
    accessToken: "access-token",
    sessionToken: "session-token",
  });
  dispatch(input, "input");

  const authJson = JSON.parse(output.value);

  assert.equal(authJson.tokens.access_token, "access-token");
  assert.equal(authJson.tokens.refresh_token, "");
  assert.equal(authJson.tokens.id_token, "");
  assert.equal(authJson.tokens.account_id, "00000000-0000-4000-9000-000000000000");
  assert.equal(authJson.meta.label, "mark@example.com");
  assert.equal(authJson.meta.note, "Imported from ChatGPT session");
}

function testCodexManagerAuthJsonPreservesRealRefreshAndMetadata() {
  const { elements, formatButtons } = loadPageScript();
  const codexManagerButton = formatButtons.find((button) => button.dataset.format === "codexmanager");
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  dispatch(codexManagerButton, "click");
  input.value = JSON.stringify({
    user: {
      email: "mark@example.com",
    },
    accessToken: "access-token",
    refreshToken: "real-refresh-token",
    idToken: "real.header.signature",
    workspaceId: "workspace-1",
    chatgptAccountId: "chatgpt-account-1",
  });
  dispatch(input, "input");

  const authJson = JSON.parse(output.value);

  assert.equal(authJson.tokens.refresh_token, "real-refresh-token");
  assert.equal(authJson.tokens.id_token, "real.header.signature");
  assert.equal(authJson.tokens.chatgpt_account_id, "chatgpt-account-1");
  assert.equal(authJson.meta.workspace_id, "workspace-1");
  assert.equal(authJson.meta.chatgpt_account_id, "chatgpt-account-1");
}

async function testAutomaticHealthFilterAndDownloadScope() {
  const requests = [];
  const { elements } = loadPageScript({
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            concurrency: 30,
            results: [
              { index: 0, status: 200, error: "" },
              { index: 1, status: 401, error: "" },
            ],
          };
        },
      };
    },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const input = elements.get("#session-input");
  const output = elements.get("#output");
  const scope = elements.get("#download-scope");
  elements.get("#health-filter").value = "200";
  scope.value = "200";
  input.value = JSON.stringify([
    { email: "alive@example.com", accessToken: "alive-token" },
    { email: "invalid@example.com", accessToken: "invalid-token" },
  ]);
  dispatch(input, "input");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/session-health");
  assert.equal(JSON.parse(requests[0].init.body).accounts.length, 2);
  assert.equal(JSON.parse(requests[0].init.body).concurrency, 5);
  assert.equal(elements.get("#task-concurrency-value").textContent, "5");
  assert.match(elements.get("#health-body").innerHTML, /alive@example\.com/);
  assert.doesNotMatch(elements.get("#health-body").innerHTML, /invalid@example\.com/);
  assert.deepEqual(JSON.parse(output.value).accounts.map((item) => item.name), ["alive@example.com"]);

  const filter = elements.get("#health-filter");
  filter.value = "non200";
  dispatch(filter, "change");
  assert.match(elements.get("#health-body").innerHTML, /invalid@example\.com/);
  assert.doesNotMatch(elements.get("#health-body").innerHTML, /alive@example\.com/);

  scope.value = "all";
  dispatch(scope, "change");
  assert.equal(JSON.parse(output.value).accounts.length, 2);

  scope.value = "non200";
  dispatch(scope, "change");
  assert.deepEqual(JSON.parse(output.value).accounts.map((item) => item.name), ["invalid@example.com"]);
}

async function testLogoutAllSessionsUsesHealthySub2apiAccounts() {
  const requests = [];
  const { elements } = loadPageScript({
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (url === "/api/session-health") {
        return {
          ok: true,
          status: 200,
          async json() { return { results: [{ index: 0, status: 200 }, { index: 1, status: 401 }] }; },
        };
      }
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify({ ok: true, concurrency: 10, succeeded: 1, failed: 0, results: [{ index: 0, email: "alive@example.com", probeStatus: 200, logoutStatus: 200, ok: true }] }); },
      };
    },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const input = elements.get("#session-input");
  input.value = JSON.stringify([
    { email: "alive@example.com", accessToken: "alive-token" },
    { email: "dead@example.com", accessToken: "dead-token" },
  ]);
  dispatch(input, "input");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const button = elements.get("#logout-all-sessions");
  assert.equal(button.disabled, false);
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const logoutRequest = requests.find((request) => request.url === "/api/logout-all-sessions");
  assert.ok(logoutRequest);
  const body = JSON.parse(logoutRequest.init.body);
  assert.equal(body.concurrency, 5);
  assert.equal(JSON.parse(requests.find(request => request.url === '/api/session-health').init.body).concurrency, 5);
  assert.deepEqual(body.accounts.map((account) => account.email), ["alive@example.com"]);
  assert.match(elements.get("#logout-progress").textContent, /alive@example\.com/);
}

function testConsecutiveJsonDocumentsAreAccepted() {
  const { elements } = loadPageScript();
  const input = elements.get("#session-input");
  const output = elements.get("#output");

  input.value = [
    JSON.stringify({ user: { email: "first@example.com" }, accessToken: "first-token" }),
    JSON.stringify({ user: { email: "second@example.com" }, accessToken: "second-token" }),
  ].join("\n");
  dispatch(input, "input");

  assert.deepEqual(
    JSON.parse(output.value).accounts.map((item) => item.name),
    ["first@example.com", "second@example.com"]
  );
  assert.match(elements.get("#input-status").textContent, /解析完成：2 个账号/);
}

function testNoisyExportHeaderIsIgnored() {
  const { elements, formatButtons } = loadPageScript();
  selectSub2apiTools(elements, formatButtons, "txt-to-json");
  const input = elements.get("#session-input");
  input.value = `\uFEFF卡密导出\n\n${JSON.stringify(sub2apiDocument([
    sub2apiAccount("noisy@example.com", "noisy"),
  ]))}\n`;
  dispatch(input, "input");

  const parsed = JSON.parse(elements.get("#output").value);
  assert.equal(parsed.accounts.length, 1);
  assert.equal(parsed.accounts[0].name, "noisy@example.com");
}

async function testNoisyTxtFileCanBeSelectedInRegularMode() {
  const { elements } = loadPageScript({
    fetch: async (_url, init) => ({
      ok: true,
      status: 200,
      async json() {
        return { results: JSON.parse(init.body).accounts.map((_, index) => ({ index, status: 200, usage: null })) };
      },
    }),
  });
  const fileInput = elements.get("#file-input");
  fileInput.files = [{
    name: "卡密导出.txt",
    webkitRelativePath: "",
    async text() {
      return `\uFEFF卡密导出\n${JSON.stringify(sub2apiDocument([sub2apiAccount("file@example.com", "file")]))}`;
    },
  }];
  dispatch(fileInput, "change");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.match(elements.get("#input-status").textContent, /读取 1 个文件，生成 1 个账号/);
  assert.equal(JSON.parse(elements.get("#output").value).accounts.length, 1);
}

function selectSub2apiTools(elements, formatButtons, operation) {
  const button = formatButtons.find((item) => item.dataset.format === "sub2api-tools");
  elements.get("#sub2api-operation").value = operation;
  dispatch(button, "click");
}

function sub2apiDocument(accounts, proxies = []) {
  return {
    type: "sub2api-data",
    version: 1,
    exported_at: "2026-08-16T00:00:00.000Z",
    proxies,
    accounts,
  };
}

function sub2apiAccount(email, marker) {
  return {
    name: email,
    platform: "openai",
    type: "oauth",
    credentials: { access_token: `${marker}-token`, email },
    model_mapping: { marker },
  };
}

function testSub2apiJsonToTxtPreservesFieldsAndSeparatesDuplicateEmails() {
  const { elements, formatButtons } = loadPageScript();
  selectSub2apiTools(elements, formatButtons, "json-to-txt");
  const input = elements.get("#session-input");
  input.value = JSON.stringify(sub2apiDocument([
    sub2apiAccount("same@example.com", "first"),
    sub2apiAccount("same@example.com", "second"),
    sub2apiAccount("other@example.com", "other"),
  ]));
  dispatch(input, "input");

  const lines = elements.get("#output").value.trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((line) => line.accounts[0].name), [
    "same@example.com",
    "other@example.com",
    "same@example.com",
  ]);
  assert.equal(lines[0].accounts[0].model_mapping.marker, "first");
  assert.equal(lines[2].accounts[0].model_mapping.marker, "second");
  assert.ok(lines.every((line) => line.accounts.length === 1));
}

function testSub2apiTxtToJsonMergesAccountsAndProxies() {
  const { elements, formatButtons } = loadPageScript();
  selectSub2apiTools(elements, formatButtons, "txt-to-json");
  const input = elements.get("#session-input");
  input.value = [
    JSON.stringify(sub2apiDocument([sub2apiAccount("first@example.com", "first")], [{ name: "one" }])),
    JSON.stringify(sub2apiDocument([sub2apiAccount("second@example.com", "second")], [{ name: "two" }])),
  ].join("\n");
  dispatch(input, "input");

  const merged = JSON.parse(elements.get("#output").value);
  assert.deepEqual(merged.accounts.map((account) => account.name), ["first@example.com", "second@example.com"]);
  assert.deepEqual(merged.proxies.map((proxy) => proxy.name), ["one", "two"]);
}

function testSub2apiMailSplitCanSwitchOutputGroup() {
  const { elements, formatButtons } = loadPageScript();
  selectSub2apiTools(elements, formatButtons, "split");
  elements.get("#mail-input").value = "email\nfirst@example.com";
  const input = elements.get("#session-input");
  input.value = JSON.stringify(sub2apiDocument([
    sub2apiAccount("first@example.com", "first"),
    sub2apiAccount("second@example.com", "second"),
  ]));
  dispatch(input, "input");

  let lines = elements.get("#output").value.trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map((line) => line.accounts[0].name), ["first@example.com"]);

  const scope = elements.get("#split-scope");
  scope.value = "unmatched";
  dispatch(scope, "change");
  lines = elements.get("#output").value.trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map((line) => line.accounts[0].name), ["second@example.com"]);
  assert.equal(elements.get("#download-matched").textContent, "下载匹配邮箱 (1)");
  assert.equal(elements.get("#download-unmatched").textContent, "下载未匹配邮箱 (1)");
  assert.equal(elements.get("#download-matched").disabled, false);
  assert.equal(elements.get("#download-unmatched").disabled, false);
}

async function testSub2apiMailSplitExtractsNoisyCsvEmailsAndIgnoresHealthScope() {
  const { elements, formatButtons } = loadPageScript({
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { results: [
          { index: 0, status: 200, error: "" },
          { index: 1, status: 200, error: "" },
          { index: 2, status: 401, error: "" },
        ] };
      },
    }),
  });
  selectSub2apiTools(elements, formatButtons, "split");
  elements.get("#mail-input").value = "\uFEFF账号,备注\n\"FIRST@EXAMPLE.COM\",已开通\n干扰 second@example.com----password";
  elements.get("#download-scope").value = "non200";
  const input = elements.get("#session-input");
  input.value = JSON.stringify(sub2apiDocument([
    sub2apiAccount("first@example.com", "first"),
    { ...sub2apiAccount("label", "second"), credentials: { access_token: "second-token", username: "second@example.com / active" } },
    sub2apiAccount("third@example.com", "third"),
  ]));
  dispatch(input, "input");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const lines = elements.get("#output").value.trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map((line) => line.accounts[0].credentials.access_token), ["first-token", "second-token"]);
  assert.equal(elements.get("#download-matched").textContent, "下载匹配邮箱 (2)");
  assert.equal(elements.get("#download-unmatched").textContent, "下载未匹配邮箱 (1)");
}

async function testSub2apiToolsFilterToHttp200AfterHealthCheck() {
  const { elements, formatButtons } = loadPageScript({
    fetch: async (url, init) => ({
      ok: true,
      status: 200,
      async json() {
        assert.equal(url, "/api/session-health");
        assert.equal(JSON.parse(init.body).accounts.length, 2);
        return {
          results: [
            { index: 0, status: 200, error: "" },
            { index: 1, status: 401, error: "" },
          ],
        };
      },
    }),
  });
  selectSub2apiTools(elements, formatButtons, "json-to-txt");
  elements.get("#download-scope").value = "200";
  const input = elements.get("#session-input");
  input.value = JSON.stringify(sub2apiDocument([
    sub2apiAccount("alive@example.com", "alive"),
    sub2apiAccount("dead@example.com", "dead"),
  ]));
  dispatch(input, "input");
  await new Promise((resolve) => setTimeout(resolve, 0));

  let lines = elements.get("#output").value.trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map((line) => line.accounts[0].name), ["alive@example.com"]);
  assert.match(elements.get("#health-status").textContent, /HTTP 200 1/);

  elements.get("#download-scope").value = "all";
  dispatch(elements.get("#download-scope"), "change");
  lines = elements.get("#output").value.trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map((line) => line.accounts[0].name), ["alive@example.com", "dead@example.com"]);

  elements.get("#download-scope").value = "non200";
  dispatch(elements.get("#download-scope"), "change");
  lines = elements.get("#output").value.trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map((line) => line.accounts[0].name), ["dead@example.com"]);
}

async function testSub2apiToolsRenderUsageWindows() {
  const { elements, formatButtons } = loadPageScript({
    fetch: async (url, init) => ({
      ok: true,
      status: 200,
      async json() {
        assert.equal(url, "/api/session-health");
        const request = JSON.parse(init.body);
        assert.equal(request.includeUsage, true);
        return { results: [{ index: 0, status: 200, usage: {
          fiveHour: { usedPercent: 0, resetAfterSeconds: 3600 },
          sevenDay: { usedPercent: 0, resetAfterSeconds: 86400 },
          fetchedAt: Date.now(),
        } }] };
      },
    }),
  });
  selectSub2apiTools(elements, formatButtons, "json-to-txt");
  elements.get("#session-input").value = JSON.stringify(sub2apiDocument([sub2apiAccount("usage@example.com", "usage")]));
  dispatch(elements.get("#session-input"), "input");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(elements.get("#health-body").innerHTML, /0%/);
}

async function testTeamPlusProUsageFiltersDoNotRequireFiveHourWindow() {
  const { elements, formatButtons } = loadPageScript({
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { results: [
          { index: 0, status: 200, usage: { planType: "team", fiveHour: { usedPercent: 0, resetAfterSeconds: 1800 }, sevenDay: { usedPercent: 0 }, fetchedAt: Date.now() } },
          { index: 1, status: 200, usage: { planType: "plus", fiveHour: { usedPercent: 34, resetAfterSeconds: 2400 }, sevenDay: { usedPercent: 40 }, fetchedAt: Date.now() } },
          { index: 2, status: 200, usage: { planType: "pro", fiveHour: null, sevenDay: null, fetchedAt: Date.now() } },
          { index: 3, status: 200, usage: { planType: "k12", fiveHour: null, sevenDay: { usedPercent: 0 }, fetchedAt: Date.now() } },
          { index: 4, status: 200, usage: { planType: "k12", fiveHour: { usedPercent: 0 }, sevenDay: { usedPercent: 0 }, fetchedAt: Date.now() } },
        ] };
      },
    }),
  });
  selectSub2apiTools(elements, formatButtons, "json-to-txt");
  elements.get("#session-input").value = JSON.stringify(sub2apiDocument([
    sub2apiAccount("unused-team@example.com", "unused"),
    sub2apiAccount("used-plus@example.com", "used"),
    sub2apiAccount("unknown-pro@example.com", "unknown"),
    sub2apiAccount("incomplete-k12@example.com", "incomplete"),
    sub2apiAccount("unused-k12@example.com", "k12"),
  ]));
  dispatch(elements.get("#session-input"), "input");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(elements.get("#health-body").innerHTML, /unused-team@example\.com/);
  assert.match(elements.get("#health-body").innerHTML, /0%/);
  assert.doesNotMatch(elements.get("#health-body").innerHTML, /unused-team@example\.com[\s\S]*不适用/);
  assert.match(elements.get("#health-body").innerHTML, /unused-k12@example\.com/);
  assert.doesNotMatch(elements.get("#health-body").innerHTML, /incomplete-k12@example\.com/);
  assert.doesNotMatch(elements.get("#health-body").innerHTML, /不适用/);
  assert.doesNotMatch(elements.get("#health-body").innerHTML, /used-plus@example\.com/);

  elements.get("#usage-filter").value = "used";
  dispatch(elements.get("#usage-filter"), "change");
  assert.match(elements.get("#health-body").innerHTML, /used-plus@example\.com/);
  assert.doesNotMatch(elements.get("#health-body").innerHTML, /unused-team@example\.com/);

  elements.get("#usage-filter").value = "unknown";
  dispatch(elements.get("#usage-filter"), "change");
  assert.match(elements.get("#health-body").innerHTML, /unknown-pro@example\.com/);
  assert.match(elements.get("#health-body").innerHTML, /incomplete-k12@example\.com/);
}

async function main() {
  testSub2apiAccountUsesAccessTokenExpiry();
  testSub2apiOutputConfigurationOverridesImportedAccount();
  testSub2apiLoadFactorUsesSchedulerFieldNotBillingMultiplier();
  testSub2apiAccountsUseTheirOwnAccessTokenExpiry();
  testSub2apiAccountWithRefreshTokenOmitsAccessTokenExpiry();
  testSyntheticIdTokenHasCodexParseableJwtFormat();
  testCodexAuthJsonMatchesNativeShapeWhenMissingRefreshToken();
  testCodexAuthJsonPreservesRealRefreshTokenAndIdToken();
  testConsecutiveJsonDocumentsAreAccepted();
  testNoisyExportHeaderIsIgnored();
  await testNoisyTxtFileCanBeSelectedInRegularMode();
  testSub2apiJsonToTxtPreservesFieldsAndSeparatesDuplicateEmails();
  testSub2apiTxtToJsonMergesAccountsAndProxies();
  testSub2apiMailSplitCanSwitchOutputGroup();
  await testSub2apiMailSplitExtractsNoisyCsvEmailsAndIgnoresHealthScope();
  await testSub2apiToolsFilterToHttp200AfterHealthCheck();
  await testSub2apiToolsRenderUsageWindows();
  await testTeamPlusProUsageFiltersDoNotRequireFiveHourWindow();
  await testAutomaticHealthFilterAndDownloadScope();
  await testLogoutAllSessionsUsesHealthySub2apiAccounts();
  console.log("convert-session tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
