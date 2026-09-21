import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadCliEnv } from './cli-env.mjs';
import { parseBoolean, parseInteger } from './cli-args.mjs';
import { chunkAccounts, summarizeRound } from './cli-batch.mjs';
import { configuredTaskConcurrency } from '../lib/batch-concurrency.js';

export { chunkAccounts, summarizeRound } from './cli-batch.mjs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:4173';
function defaultReportPath(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.resolve(fileURLToPath(new URL('../../', import.meta.url)), process.env.RUNTIME_DIR || 'runtime', 'exports', `session-health-${stamp}.json`);
}

export function parseArgs(argv, env = process.env, now = new Date()) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new Error(`未知参数：${item}`);
    const equals = item.indexOf('=');
    const key = item.slice(2, equals < 0 ? undefined : equals);
    const value = equals < 0 ? argv[++index] : item.slice(equals + 1);
    if (value == null || value.startsWith('--')) throw new Error(`--${key} 缺少值`);
    if (Object.hasOwn(values, key)) throw new Error(`--${key} 不能重复`);
    values[key] = value;
  }

  const allowed = new Set(['base-url', 'filter', 'batch-size', 'relogin', 'only-with-session', 'report', 'ids']);
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error(`未知参数：--${key}`);

  const filter = values.filter || 'all';
  if (!['rt', 'no-rt', 'all'].includes(filter)) throw new Error('--filter 必须是 rt、no-rt 或 all');
  const concurrency = configuredTaskConcurrency(env);
  const batchSize = values['batch-size'] == null
    ? concurrency
    : parseInteger('batch-size', values['batch-size']);
  const ids = String(values.ids || '').split(',').map(value => value.trim()).filter(Boolean);

  return {
    baseUrl: String(values['base-url'] || (env.PORT ? `http://127.0.0.1:${env.PORT}` : DEFAULT_BASE_URL)).replace(/\/+$/, ''),
    filter,
    batchSize,
    concurrency,
    relogin: parseBoolean('relogin', values.relogin, false),
    onlyWithSession: parseBoolean('only-with-session', values['only-with-session'], true),
    report: path.resolve(values.report || defaultReportPath(now)),
    ids: [...new Set(ids)],
  };
}

export function filterAccounts(accounts, options) {
  const requestedIds = new Set(options.ids || []);
  return (Array.isArray(accounts) ? accounts : []).filter(account => {
    if (options.filter === 'rt' && account.hasOpenAiRt !== true) return false;
    if (options.filter === 'no-rt' && account.hasOpenAiRt === true) return false;
    if (options.onlyWithSession && account.hasChatGptSession !== true) return false;
    if (requestedIds.size && !requestedIds.has(String(account.id))) return false;
    return Boolean(String(account.id || '').trim());
  });
}

async function jsonRequest(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  let body;
  try { body = await response.json(); } catch { throw new Error(`HTTP ${response.status} 返回了非 JSON 内容`); }
  if (!response.ok || body?.ok === false) throw new Error(body?.error?.message || body?.error || `HTTP ${response.status}`);
  return body;
}

function normalizeRoundResults(accounts, responseResults) {
  const pending = Array.isArray(responseResults) ? [...responseResults] : [];
  return accounts.map(account => {
    const index = pending.findIndex(item => String(item?.id || '') === String(account.id));
    const item = index >= 0 ? pending.splice(index, 1)[0] : null;
    return item || { id: account.id, email: account.email, ok: false, error: '接口未返回该账号的验活结果' };
  });
}

export async function runSessionHealth(options, dependencies = {}) {
  const request = dependencies.request || jsonRequest;
  const logger = dependencies.logger || console;
  const saveReport = dependencies.writeReport || (async (reportPath, report) => {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  });
  const startedAt = new Date().toISOString();
  const accountResponse = await request(`${options.baseUrl}/api/v2/accounts`, { method: 'GET' });
  const selected = filterAccounts(accountResponse.accounts, options);
  const batches = chunkAccounts(selected, options.batchSize);
  const rounds = [];
  const accountResults = [];

  for (let index = 0; index < batches.length; index += 1) {
    const accounts = batches[index];
    let results;
    let error = '';
    try {
      const response = await request(`${options.baseUrl}/api/v2/accounts/session-health`, {
        method: 'POST',
        body: JSON.stringify({
          scope: 'selected',
          ids: accounts.map(account => account.id),
          onlyWithSession: options.onlyWithSession,
          reloginOnInvalid: options.relogin,
          forceRelogin: false,
        }),
      });
      results = normalizeRoundResults(accounts, response.results);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      results = accounts.map(account => ({ id: account.id, email: account.email, ok: false, error }));
    }
    const summary = summarizeRound(results);
    const round = { round: index + 1, ids: accounts.map(account => account.id), ...summary, error, results };
    rounds.push(round);
    accountResults.push(...results.map(result => ({ ...result, round: index + 1 })));
    logger.log(`第${index + 1}轮：总：${summary.total}、成功：${summary.succeeded}、失败：${summary.failed}`);
  }

  const totals = summarizeRound(accountResults);
  logger.log(`总汇总：总：${totals.total}、成功：${totals.succeeded}、失败：${totals.failed}`);
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    config: { ...options },
    totals,
    rounds,
    results: accountResults,
  };
  await saveReport(options.report, report);
  logger.log(`报告：${options.report}`);
  return report;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectRun()) {
  try {
    loadCliEnv();
    const options = parseArgs(process.argv.slice(2));
    runSessionHealth(options)
      .then(report => { if (report.totals.failed > 0) process.exitCode = 1; })
      .catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
