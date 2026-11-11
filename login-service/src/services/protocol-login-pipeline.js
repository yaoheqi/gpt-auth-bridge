import { extractBusinessWorkspaceIds, readWorkspaceSessionPayload, resolveWorkspaceSelection } from '../../lib/business-workspace.js';
import { protocolLoginCredentialIssue } from '../domain/accounts/account-domain.js';
import { withAccountTimings, measureStage } from '../../lib/stage-timing.js';
import { accountQueueDuration } from '../../lib/task-concurrency.js';
import { terminalLoginFailure } from './monitor-coordinator.js';
import { validationFailureFields } from '../../lib/validation-error.js';
import { requestSignal } from './request-scope.js';

// Old clients may still submit personal; it now includes all workspaces.
export function normalizeProtocolPipelineMode(value) {
  return String(value || '').trim() === 'session' ? 'session' : 'all';
}

export async function runProtocolLoginPipelineAccount(account, options) {
  const identity = { id: account.id, email: account.email };
  const result = await withAccountTimings(async () => {
    const limit = options.requireNonPersonal && !protocolLoginCredentialIssue(account) ? 3 : 1;
    for (let attempts = 1; attempts <= limit; attempts++) {
      requestSignal()?.throwIfAborted();
      const current = await executeProtocolLogin(account, options);
      if (!options.requireNonPersonal) return current;
      current.attempts = attempts;
      const acquired = normalizeProtocolPipelineMode(options.workspaceMode) === 'session'
        ? current.nonPersonalOk : current.businessSuccess > 0;
      if (acquired || current.terminalReason || current.validationFailure) return current;
      current.ok = false;
      if (normalizeProtocolPipelineMode(options.workspaceMode) === 'session') current.sessionOk = false;
      current.error ||= '未获取到非个人工作区';
      if (attempts === limit) {
        current.error = `尝试 ${attempts} 次后仍未获取到非个人工作区：${current.error}`;
        return current;
      }
      options.hooks?.log?.({ ...identity, phase: 'protocol', level: 'warn', msg: `未获取到非个人工作区，重新获取（第 ${attempts + 1}/3 次）` });
    }
  }, {
    queueMs: accountQueueDuration(),
    onTiming: timing => options.hooks?.timing?.({ ...identity, ...timing }),
  });
  options.hooks?.done?.(result);
  return result;
}

async function executeProtocolLogin(account, {
  workspaceMode, requireNonPersonal = false, runSessionLogin, runAllWorkspaces, hooks = {},
}) {
  const mode = normalizeProtocolPipelineMode(workspaceMode);
  const identity = { id: account.id, email: account.email };
  const phase = mode === 'session' ? 'protocol' : 'codex';
  hooks.start?.({ ...identity, phase });
  const onLog = current => data => hooks.log?.({ ...data, ...identity, phase: current });
  let result;
  try {
    const issue = protocolLoginCredentialIssue(account);
    if (issue) throw new Error(issue);
    if (mode === 'session') {
      const session = await runSessionLogin(account, { requireNonPersonal, onLog: onLog('protocol') });
      result = {
        ok: Boolean(session.ok), phase: session.ok ? 'done' : 'protocol',
        sessionOk: Boolean(session.ok), personalOk: false, businessSuccess: 0, businessErrors: [],
        nonPersonalOk: Boolean(session.nonPersonalOk),
        ...(!session.ok ? { error: session.error || session.detail || '协议登录失败', ...validationFailureFields(session) } : {}),
      };
    } else {
      result = await runAllWorkspaces(account, {
        requireNonPersonal,
        onLog: data => onLog(data.phase || 'codex')(data),
        onPhase: current => hooks.phase?.({ ...identity, phase: current }),
      });
    }
  } catch (error) {
    requestSignal()?.throwIfAborted();
    result = { ok: false, phase, sessionOk: false, personalOk: false, businessSuccess: 0, businessErrors: [], error: error.message || String(error), ...validationFailureFields(error) };
  }
  result = { ...result, ...identity, ...(!result.ok && terminalLoginFailure(result.error) ? { terminalReason: terminalLoginFailure(result.error) } : {}) };
  return result;
}

// One flow owns the cookies, fingerprint and proxy for the entire account.
// Each workspace needs its own OAuth code/PKCE pair, but reuses the login.
export async function runAllWorkspaceCodexAuth({
  flow, persistPersonal, persistBusiness, persistCookies, onPhase = () => {},
}) {
  const result = { ok: false, phase: 'codex', sessionOk: false, personalOk: false, businessTotal: 0, businessSuccess: 0, businessErrors: [] };
  try {
    onPhase('codex');
    const first = await flow.run();
    if (!first?.refresh_token) throw new Error('Codex 授权未返回 refresh_token');
    const storage = await flow.exportCookieStorageState();
    // Redirect-only grants can still have their catalog in the auth cookies.
    const catalog = flow.discoveredWorkspaces || readWorkspaceSessionPayload(JSON.parse(storage).cookies).workspaces;
    const workspaceIds = extractBusinessWorkspaceIds({ session_json: { workspaces: catalog } });
    const firstId = first.account_id || flow.selectedWorkspaceId || resolveWorkspaceSelection({ workspaces: catalog }, flow.workspaceSelection);
    if (!catalog.some(workspace => String(workspace.id) === firstId)) throw new Error('授权结果不属于已发现的工作区');
    const firstIsBusiness = workspaceIds.includes(firstId);
    if (firstIsBusiness) {
      await persistBusiness(first, firstId);
      result.businessSuccess = 1;
    } else {
      if (flow.requireNonPersonal) throw new Error('未获取到非个人工作区');
      await persistPersonal(first);
      result.personalOk = true;
    }
    await persistCookies(storage);
    result.businessTotal = workspaceIds.length;
    result.phase = 'business';
    onPhase('business');
    flow.log(`发现 ${workspaceIds.length} 个 Business 工作区，复用本次 Codex 登录逐个授权`);
    for (const workspaceId of workspaceIds) {
      if (firstIsBusiness && workspaceId === firstId) continue;
      try {
        flow.workspaceSelection = { mode: 'id', workspaceId };
        flow.forbidPhoneChallenge = true;
        flow.log(`授权 Business 工作区 ${workspaceId}`);
        const record = await measureStage('workspace', () => flow.loginCodexWithPhone({ preserveAuthSession: true }));
        await persistBusiness(record, workspaceId);
        result.businessSuccess += 1;
      } catch (error) {
        requestSignal()?.throwIfAborted();
        if (validationFailureFields(error).validationFailure) throw error;
        const message = `工作区 ${workspaceId}: ${error.message || String(error)}`;
        result.businessErrors.push(message);
        flow.log(message, 'error');
      }
    }
    await persistCookies(await flow.exportCookieStorageState());
    result.ok = result.businessErrors.length === 0;
    result.phase = 'done';
    if (!result.ok) result.error = result.businessErrors.join('；');
  } catch (error) {
    requestSignal()?.throwIfAborted();
    result.error = error.message || String(error);
    Object.assign(result, validationFailureFields(error));
  } finally {
    await flow.dispose();
  }
  return result;
}
