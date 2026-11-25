import { readWorkspaceSessionPayload } from '../../lib/business-workspace.js';
import { normalizeCatalog, workspaceOwnershipKind } from '../../lib/workspace-page.js';
import { protocolLoginCredentialIssue } from '../domain/accounts/account-domain.js';
import { withAccountTimings, measureStage } from '../../lib/stage-timing.js';
import { accountQueueDuration } from '../../lib/task-concurrency.js';
import { terminalLoginFailure } from './monitor-coordinator.js';
import { validationError, validationFailureFields } from '../../lib/validation-error.js';
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
  let first;
  let storage;
  try {
    onPhase('codex');
    first = await flow.run();
    const firstToken = typeof first?.refresh_token === 'string' ? first.refresh_token.trim() : '';
    if (!firstToken) throw new Error('Codex 授权未返回 refresh_token');
    result.phase = 'workspace_catalog';
    onPhase('workspace_catalog');
    storage = await flow.exportCookieStorageState();
    // Redirect-only grants can still have their catalog in the auth cookies.
    const catalog = flow.discoveredWorkspaces || readWorkspaceSessionPayload(JSON.parse(storage).cookies).workspaces;
    if (catalog.length === 0) throw validationError('WORKSPACE_CATALOG_UNAVAILABLE', { reason: 'EMPTY_CATALOG' });
    const { workspaces } = normalizeCatalog(catalog);
    const returnedId = first.account_id;
    const selectedId = flow.selectedWorkspaceId;
    if (returnedId && selectedId && returnedId !== selectedId) throw validationError('WORKSPACE_OWNERSHIP_UNCONFIRMED');
    const onlyPersonal = workspaces.length === 1 && workspaces[0].kind === 'personal';
    const firstId = returnedId || selectedId || (onlyPersonal ? workspaces[0].id : '');
    const owner = workspaces.find(workspace => workspace.id === firstId);
    if (!owner || workspaces.some(workspace => !workspaceOwnershipKind(workspace.kind))) throw validationError('WORKSPACE_OWNERSHIP_UNCONFIRMED');
    const workspaceIds = workspaces.filter(workspace => workspaceOwnershipKind(workspace.kind) === 'business').map(workspace => workspace.id);
    if (owner.kind !== 'personal') {
      await persistBusiness(first, firstId);
      result.businessSuccess = 1;
    } else {
      if (flow.requireNonPersonal) throw new Error('未获取到非个人工作区');
      await persistPersonal(first);
      result.personalOk = true;
    }
    await persistCookies(storage);
    result.businessTotal = workspaceIds.length;
    const remainingIds = workspaceIds.filter(id => id !== firstId);
    if (!remainingIds.length) {
      return { ...result, ok: true, phase: 'done' };
    }
    const savedTokens = new Set([firstToken]);
    result.phase = 'business';
    onPhase('business');
    for (const workspaceId of remainingIds) {
      try {
        flow.workspaceSelection = { mode: 'id', workspaceId };
        flow.forbidPhoneChallenge = true;
        flow.log(`授权 Business 工作区 ${workspaceId}`);
        const record = await measureStage('workspace', () => flow.loginCodexWithPhone({ preserveAuthSession: true }));
        if (record?.account_id && record.account_id !== workspaceId) throw validationError('WORKSPACE_OWNERSHIP_UNCONFIRMED');
        const token = String(record?.refresh_token || '').trim();
        if (savedTokens.has(token)) throw validationError('WORKSPACE_CREDENTIAL_CONFLICT');
        await persistBusiness(record, workspaceId);
        savedTokens.add(token);
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
    const catalogMissing = result.phase === 'workspace_catalog'
      && ['WORKSPACE_SESSION_MISSING', 'WORKSPACE_SESSION_INVALID'].includes(error?.code);
    let failure = error;
    if (catalogMissing) failure = validationError('WORKSPACE_CATALOG_UNAVAILABLE', { reason: error.code });
    if (result.phase === 'workspace_catalog' && error?.code === 'WORKSPACE_PAGE_INVALID') failure = validationError('WORKSPACE_OWNERSHIP_UNCONFIRMED');
    const ownershipUnknown = result.phase === 'workspace_catalog'
      && ['WORKSPACE_CATALOG_UNAVAILABLE', 'WORKSPACE_OWNERSHIP_UNCONFIRMED'].includes(failure?.code);
    if (ownershipUnknown && !flow.requireNonPersonal) {
      try {
        await persistPersonal(first);
        await persistCookies(storage);
        return { ...result, ok: true, phase: 'done', personalOk: true, workspaceOwnership: 'personal' };
      } catch (persistError) {
        failure = persistError;
      }
    }
    result.error = failure.message || String(failure);
    Object.assign(result, validationFailureFields(failure));
  } finally {
    await flow.dispose();
  }
  return result;
}
