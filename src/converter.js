import { withSessionTransport, checkSessionHealth, logoutAllSessions } from './session-network.js';
import { configuredTaskConcurrency } from '../login-service/lib/batch-concurrency.js';

import { runAccountTask } from '../login-service/lib/task-concurrency.js';

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOCS_DIR = fileURLToPath(new URL("../docs/", import.meta.url));
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_ACCOUNTS = 2_000;
const STATIC_FILES = Object.freeze({
  "/": "index.html",
  "/index.html": "index.html",
  "/favicon.svg": "favicon.svg",
  "/browser-store.js": "browser-store.js",
  "/app.js": "app.js",
  "/login-account-format.js": "login-account-format.js",
  "/app.css": "app.css",
});
const CONTENT_TYPES = { ".js": "text/javascript; charset=utf-8", ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".css": "text/css; charset=utf-8" };

function applySecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'");
}

function sendJson(response, status, payload, headers = {}) {
  if (response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", ...headers });
  response.end(body);
}

async function readJson(request) {
  if (request.body !== undefined) return request.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("请求内容过大"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("JSON 无效"), { statusCode: 400 }); }
}

function requestPath(request) {
  try { return new URL(request.url, "http://localhost").pathname; }
  catch { return ""; }
}

function responseAbortSignal(response) {
  const controller = new AbortController();
  response.once('close', () => controller.abort());
  return controller.signal;
}

async function handleHealth(request, response) {
  const body = await readJson(request);
  if (!Array.isArray(body.accounts) || body.accounts.length > MAX_ACCOUNTS) { sendJson(response, 400, { ok: false, error: `accounts 必须是最多 ${MAX_ACCOUNTS} 项的数组` }); return; }
  const signal = responseAbortSignal(response);
  const results = new Array(body.accounts.length);
  const concurrency = configuredTaskConcurrency();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, body.accounts.length) }, async () => {
    while (cursor < body.accounts.length) {
      const index = cursor++;
      const account = body.accounts[index];
      signal.throwIfAborted();
      results[index] = { index, ...(await runAccountTask(() => withSessionTransport(options => checkSessionHealth(account, { ...options, includeUsage: body.includeUsage }), { signal }), { signal })) };
    }
  }));
  sendJson(response, 200, { ok: true, concurrency, results });
}

async function handleLogoutAllSessions(request, response) {
  const body = await readJson(request);
  if (!Array.isArray(body.accounts) || body.accounts.length > MAX_ACCOUNTS) {
    sendJson(response, 400, { ok: false, error: `accounts 必须是最多 ${MAX_ACCOUNTS} 项的数组` });
    return;
  }
  const accounts = body.accounts.map((account, index) => ({
    index: Number.isInteger(account?.index) ? account.index : index,
    email: String(account?.email || "").trim(),
    accessToken: String(account?.accessToken || "").trim(),
    accountId: account?.accountId,
    cookie: account?.cookie,
    cookies: account?.cookies,
    sessionCookie: account?.sessionCookie,
    language: account?.language,
    userAgent: account?.userAgent,
    deviceId: account?.deviceId,
    sessionId: account?.sessionId,
    clientBuildNumber: account?.clientBuildNumber,
    clientVersion: account?.clientVersion,
  }));
  const concurrency = configuredTaskConcurrency();
  const signal = responseAbortSignal(response);
  const results = new Array(accounts.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, async () => {
    while (cursor < accounts.length) {
      signal.throwIfAborted();
      const position = cursor++;
      const account = accounts[position];
      results[position] = { index: account.index, email: account.email, ...(await runAccountTask(() => withSessionTransport(options => logoutAllSessions(account, options), { signal }), { signal })) };
    }
  }));
  const succeeded = results.filter((result) => result.ok).length;
  sendJson(response, 200, { ok: succeeded === results.length, concurrency, succeeded, failed: results.length - succeeded, results });
}

function normalizeStaticPath(requestTarget) {
  const raw = String(requestTarget || "/").split(/[?#]/, 1)[0];
  if (!raw.startsWith("/") || raw.includes("\\") || /%(?:2f|5c)/i.test(raw)) return null;
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  if (decoded.includes("%") || decoded.includes("\\") || decoded.includes("\0") || decoded.includes(":")) return null;
  if (path.posix.normalize(decoded) !== decoded || (decoded !== "/" && decoded.endsWith("/"))) return null;
  return decoded.toLowerCase();
}

function serveStatic(request, response) {
  const route = normalizeStaticPath(request.url);
  if (!route) { response.writeHead(400, { "Cache-Control": "no-store" }).end("Bad request"); return; }
  const file = STATIC_FILES[route];
  if (!file) { response.writeHead(404, { "Cache-Control": "no-store" }).end("Not found"); return; }
  fs.readFile(path.join(DOCS_DIR, file), (error, data) => {
    if (error) { response.writeHead(error.code === "ENOENT" ? 404 : 500).end("Not found"); return; }
    const headers = { "Content-Type": CONTENT_TYPES[path.extname(file)] || "application/octet-stream", "Content-Length": String(data.length), "Cache-Control": "no-store" };
    response.writeHead(200, headers);
    response.end(request.method === "HEAD" ? undefined : data);
  });
}

// Mounted before the business routes to provide shared security headers and the
// browser-owned session utility endpoints.
export function converterMiddleware(request, response, next) {
  applySecurityHeaders(response);
  const pathname = requestPath(request);
  Promise.resolve().then(async () => {
    if (["/api/health", "/api/ready", "/api/v2/health"].includes(pathname)) return next();
    if (pathname.startsWith("/api/")) {
      if (pathname === "/api/session-health" && request.method === "POST") return handleHealth(request, response);
      if (pathname === "/api/logout-all-sessions" && request.method === "POST") return handleLogoutAllSessions(request, response);
      return next();
    }
    if (["/yy4399", "/cdk", "/admin", "/admin.html"].includes(pathname)) {
      response.writeHead(302, { Location: "/", "Cache-Control": "no-store" }).end();
      return;
    }
    if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405, { Allow: "GET, HEAD, POST" }).end("Method not allowed"); return; }
    return serveStatic(request, response);
  }).catch(next);
}
