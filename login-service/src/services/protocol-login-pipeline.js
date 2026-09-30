import { extractBusinessWorkspaceIds, readWorkspaceSessionPayload } from '../../lib/business-workspace.js';
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
  const result = await withAccountTimings(() => executeProtocolLogin(account, options), {
    queueMs: accountQueueDuration(),
    onTiming: timing => options.hooks?.timing?.({ ...identity, ...timing }),
  });
  options.hooks?.done?.(result);
  return result;
}

async function executeProtocolLogin(account, {
  workspaceMode, runSessionLogin, runAllWorkspaces, hooks = {},
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
      const session = await runSessionLogin(account, { onLog: onLog('protocol') });
      result = {
        ok: Boolean(session.ok), phase: session.ok ? 'done' : 'protocol',
        sessionOk: Boolean(session.ok), personalOk: false, businessSuccess: 0, businessErrors: [],
        ...(!session.ok ? { error: session.error || session.detail || '协议登录失败', ...validationFailureFields(session) } : {}),
      };
    } else {
      result = await runAllWorkspaces(account, {
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
    const personal = await flow.run();
    if (!personal?.refresh_token) throw new Error('Codex 授权未返回个人 refresh_token');
    await persistPersonal(personal);
    result.personalOk = true;
    const storage = await flow.exportCookieStorageState();
    await persistCookies(storage);
    // Capture the catalog before workspace selection consumes/changes cookies.
    // An absent catalog is a discovery error, not "zero Business workspaces".
    const catalog = flow.discoveredWorkspaces || readWorkspaceSessionPayload(JSON.parse(storage).cookies).workspaces;
    const workspaceIds = extractBusinessWorkspaceIds({ session_json: { workspaces: catalog } });
    result.businessTotal = workspaceIds.length;
    result.phase = 'business';
    onPhase('business');
    flow.log(`发现 ${workspaceIds.length} 个 Business 工作区，复用本次 Codex 登录逐个授权`);
    for (const workspaceId of workspaceIds) {
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
