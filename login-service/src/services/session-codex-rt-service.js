import { selectBatchScope } from '../api/batch/scope-selector.js';
import {
  countStorageStateCookies,
  hasReusableStoredSession,
  resolveSessionCodexLoginAction,
} from '../../lib/session-reuse.js';
import { buildStoredRtExportRecord } from './rt-export-service.js';
import { buildSub2ApiExport, assertSub2ApiAccountShape } from '../../lib/export-sub2api.js';

export function buildSessionCodexRtBatch({ body = {}, allAccounts, findById } = {}) {
  const { scope, accounts } = selectBatchScope({
    body,
    allAccounts,
    findById,
    emptyAllError: '账号库为空，无法执行 session-codex-rt',
    emptySelectedError: '请先选择要执行 session-codex-rt 的账号',
    notFoundError: '未找到可执行 session-codex-rt 的账号',
  });
  const loginModeRaw = String(body.loginMode || 'auto').trim();
  const loginMode = ['auto', 'forceProtocol', 'skipLogin'].includes(loginModeRaw)
    ? loginModeRaw
    : 'auto';
  return {
    scope,
    accounts,
    loginMode,
    forbidPhoneChallenge: body.forbidPhoneChallenge !== false,
    forceCodex: Boolean(body.forceCodex || body.force),
    push: body.push === true,
  };
}

export function publicSessionCodexRtResult(item) {
  if (!item || typeof item !== 'object') return item;
  const { login, codex, export: exportResult, ...rest } = item;
  return {
    ...rest,
    login: login
      ? {
          ...login,
          logCount: Array.isArray(login.logs) ? login.logs.length : 0,
          logs: Array.isArray(login.logs) ? login.logs.slice(-login.ok === false ? 80 : 20) : [],
        }
      : login,
    codex: codex
      ? {
          ...codex,
          json: undefined,
          logCount: Array.isArray(codex.logs) ? codex.logs.length : 0,
          logs: Array.isArray(codex.logs) ? codex.logs.slice(-(codex.ok === false ? 80 : 20)) : [],
        }
      : codex,
    export: exportResult
      ? {
          ...exportResult,
          record: undefined,
        }
      : exportResult,
  };
}

/**
 * Orchestrate login → Codex reuse → RT export for one account.
 * Dependencies are injected so server.js can wire real runners without circular imports.
 */
export async function runSessionCodexRtForAccount(account, {
  loginMode = 'auto',
  forbidPhoneChallenge = true,
  forceCodex = false,
  findAccountById,
  runProtocolLogin,
  runCodexAuth,
  onLog,
} = {}) {
  const email = account?.email || '';
  const id = account?.id || '';
  const emit = (step, msg, level = 'info') => {
    if (typeof onLog === 'function') onLog({ email, step, level, msg, time: new Date().toISOString() });
  };

  let current = findAccountById?.(id) || account;
  const reusableBefore = hasReusableStoredSession(current);
  const cookieCountBefore = countStorageStateCookies(current?.storage_state_json);
  const loginAction = resolveSessionCodexLoginAction(loginMode, { hasReusableSession: reusableBefore });

  let login = {
    action: loginAction,
    skipped: loginAction === 'skipLogin',
    ok: true,
    cookieCountBefore,
    reusableSession: reusableBefore,
    logs: [],
  };

  if (loginAction === 'forceProtocol') {
    emit('login', `协议登录（loginMode=${loginMode}，cookies=${cookieCountBefore}）`);
    try {
      const result = await runProtocolLogin(current, {
        onLog: (entry) => {
          login.logs.push(entry);
          emit('login', entry?.msg || '', entry?.level || 'info');
        },
      });
      current = findAccountById?.(id) || current;
      const cookieCountAfter = countStorageStateCookies(current?.storage_state_json);
      login = {
        ...login,
        ok: result?.ok !== false,
        skipped: false,
        health: result?.health || result?.healthLabel || '',
        error: result?.ok === false ? (result?.error || result?.healthLabel || '协议登录失败') : '',
        cookieCountAfter,
        reusableSession: hasReusableStoredSession(current),
        logs: Array.isArray(result?.logs) ? [...login.logs, ...result.logs] : login.logs,
      };
      if (!login.ok) {
        return {
          ok: false,
          id,
          email,
          login,
          codex: null,
          export: { ok: false, skipped: true, reason: 'login_failed' },
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      login = { ...login, ok: false, skipped: false, error: message };
      return {
        ok: false,
        id,
        email,
        login,
        codex: null,
        export: { ok: false, skipped: true, reason: 'login_failed' },
      };
    }
  } else {
    emit('login', `跳过协议登录（可复用 cookies=${cookieCountBefore}）`);
  }

  current = findAccountById?.(id) || current;
  emit('codex', `Codex 复用 session（reuseStoredSession=true, forbidPhone=${forbidPhoneChallenge}, force=${forceCodex}）`);
  let codex;
  try {
    codex = await runCodexAuth(current, {
      reuseStoredSession: true,
      forbidPhoneChallenge,
      force: forceCodex,
      onLog: (entry) => emit('codex', entry?.msg || '', entry?.level || 'info'),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      id,
      email,
      login,
      codex: { ok: false, error: message, logs: [] },
      export: { ok: false, skipped: true, reason: 'codex_failed' },
    };
  }

  current = findAccountById?.(id) || current;
  const hasRt = Boolean(String(current?.openai_rt || '').trim());
  const hasPairedAccess = Boolean(String(current?.openai_access_token || '').trim());
  if (!codex?.ok) {
    if (!(forceCodex === false && hasRt && hasPairedAccess)) {
      return {
        ok: false,
        id,
        email,
        login,
        codex,
        export: { ok: false, skipped: true, reason: 'codex_failed', hasOpenAiRt: hasRt },
      };
    }
    emit('export', 'Codex 刷新失败，回退导出已保存 RT');
  }

  if (!hasRt) {
    return {
      ok: false,
      id,
      email,
      login,
      codex,
      export: { ok: false, skipped: true, reason: 'missing_rt' },
    };
  }

  try {
    const record = buildStoredRtExportRecord(current);
    return {
      ok: true,
      id,
      email,
      login,
      codex: codex?.ok
        ? codex
        : {
            ...codex,
            ok: true,
            skipped: true,
            reason: codex?.error ? `Codex 刷新失败，使用已保存 RT: ${codex.error}` : '使用已保存 RT',
          },
      export: {
        ok: true,
        skipped: false,
        hasOpenAiRt: true,
        email: record.email,
        record,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      id,
      email,
      login,
      codex,
      export: { ok: false, skipped: false, error: message, hasOpenAiRt: true },
    };
  }
}

export async function runSessionCodexRtForAccounts(accounts, {
  loginMode = 'auto',
  forbidPhoneChallenge = true,
  forceCodex = false,
  push = false,
  concurrency = 1,
  mapWithConcurrency,
  findAccountById,
  runProtocolLogin,
  runCodexAuth,
  enqueueImmediate,
  buildExportFileName,
  exportSettings,
  onAccountStart,
  onAccountLog,
  onAccountDone,
} = {}) {
  const mapper = typeof mapWithConcurrency === 'function'
    ? mapWithConcurrency
    : async (items, _n, fn) => {
      const out = [];
      for (const item of items) out.push(await fn(item));
      return out;
    };

  const results = await mapper(accounts, Math.max(1, Number(concurrency) || 1), async (account) => {
    if (typeof onAccountStart === 'function') {
      onAccountStart({ id: account.id, email: account.email });
    }
    const result = await runSessionCodexRtForAccount(account, {
      loginMode,
      forbidPhoneChallenge,
      forceCodex,
      findAccountById,
      runProtocolLogin,
      runCodexAuth,
      onLog: (entry) => {
        if (typeof onAccountLog === 'function') onAccountLog(entry);
      },
    });
    if (typeof onAccountDone === 'function') onAccountDone(result);
    return result;
  });

  const exportRecords = [];
  for (const item of results) {
    if (item?.export?.ok && item.export.record) exportRecords.push(item.export.record);
  }
  const exportedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const json = buildSub2ApiExport(exportRecords, exportedAt, exportSettings);
  for (const account of json.accounts) assertSub2ApiAccountShape(account);

  let pushResult = { enabled: false, queued: 0 };
  if (push && json.accounts.length && typeof enqueueImmediate === 'function') {
    pushResult = await enqueueImmediate(json.accounts);
  }

  return {
    ok: results.every((item) => item?.ok),
    total: results.length,
    success: results.filter((item) => item?.ok).length,
    failed: results.filter((item) => !item?.ok).length,
    loginSkipped: results.filter((item) => item?.login?.skipped).length,
    loginRan: results.filter((item) => item?.login && !item.login.skipped).length,
    results,
    json,
    fileName: typeof buildExportFileName === 'function'
      ? await buildExportFileName('session-codex-rt', 'json')
      : `session-codex-rt-${new Date().toISOString().slice(0, 10)}.json`,
    pushQueued: pushResult.queued || 0,
    pushEnabled: Boolean(pushResult.enabled),
  };
}
