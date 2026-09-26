import { nowIso as defaultNowIso } from './auth-records.js';
import { protocolLoginCredentialIssue as defaultProtocolLoginCredentialIssue } from '../../domain/accounts/account-domain.js';
import { runAllWorkspaceCodexAuth as defaultRunAllWorkspaceCodexAuth } from '../protocol-login-pipeline.js';

/** Request-owned operations. Configuration and repositories are supplied by the composition root. */
export function createWorkspaceAuthService({
  OpenAIJsonAuthFlow,
  accountRepository,
  accountRequestNetwork,
  nowIso = defaultNowIso,
  persistBusinessCodexAuthResult,
  persistOpenAIAuthResult,
  protocolLoginCredentialIssue = defaultProtocolLoginCredentialIssue,
  runAllWorkspaceCodexAuth = defaultRunAllWorkspaceCodexAuth,
} = {}) {
  async function runAllWorkspaceCodexAuthForAccount(account, { onLog, onPhase, ...network } = {}) {
    const issue = protocolLoginCredentialIssue(account);
    if (issue) throw new Error(issue);
    let phase = 'codex';
    const flow = new OpenAIJsonAuthFlow(account, {
      send(event, data) { if (event === 'log') onLog?.({ ...data, phase }); },
    }, {
      phoneMode: 'sms', reuseStoredSession: false,
      humanPacingEnabled: false, ...accountRequestNetwork(account, network),
    });
    return runAllWorkspaceCodexAuth({
      flow,
      onPhase: value => { phase = value; onPhase?.(value); },
      persistPersonal: record => persistOpenAIAuthResult(account.id, record, 'sms'),
      persistBusiness: (record, workspaceId) => persistBusinessCodexAuthResult(account.id, record, workspaceId),
      persistCookies: storage => accountRepository.updateById(account.id, { storage_state_json: storage }),
    });
  }

  async function runBusinessCodexAuthForAccount(account, {
    workspaceId,
    force = false,
    onLog,
    proxyPool,
    directWhenProxyPoolEmpty = false,
  } = {}) {
    const target = String(workspaceId || '').trim();
    const priorStatus = String(account?.business_join_status || 'none');
    const hasPriorValid = Boolean(String(account?.business_openai_rt || '').trim()
      && String(account?.business_openai_access_token || '').trim()
      && String(account?.business_openai_account_id || '') === target);
    if (!force && hasPriorValid) return { ok: true, skipped: true, id: account.id, email: account.email, workspaceId: target, reason: '已有相同 workspace 的 Business RT' };
    const fail = async (error, logs = []) => {
      const message = String(error instanceof Error ? error.message : error || 'Business 转 RT 失败').slice(0, 500);
      await accountRepository.updateById(account.id, latest => {
        const businessStatus = error?.code === 'BUSINESS_NOT_MEMBER' && priorStatus === 'requested' ? 'requested' : 'failed';
        const existing = Array.isArray(latest.business_workspace_credentials)
          ? latest.business_workspace_credentials.filter(item => String(item?.workspaceId || '') !== target) : [];
        if (target) existing.push({ workspaceId: target, status: businessStatus, refreshToken: '', accessToken: '', idToken: '', accountId: '', expiresAt: 0, error: message });
        return {
          business_workspace_id: target || latest.business_workspace_id,
          business_join_error: message,
          business_join_status: businessStatus,
          business_workspace_credentials: existing,
        };
      }).catch(() => {});
      return { ok: false, skipped: false, id: account.id, email: account.email, workspaceId: target, code: error?.code || '', error: message, preservedPriorCredentials: hasPriorValid, logs };
    };
    if (!target) return fail(new Error('Business workspace ID 不能为空'));
    let storageState;
    try { storageState = JSON.parse(String(account?.storage_state_json || '')); } catch { storageState = null; }
    const logs = [];
    const emit = (data = {}) => {
      const entry = { time: data?.time || nowIso(), level: data?.level || 'info', msg: String(data?.msg || data?.error || '') };
      logs.push(entry);
      if (typeof onLog === 'function') onLog({ email: account.email, id: account.id, workspaceId: target, ...entry });
    };
    emit({ msg: `Business 转 RT 开始：workspace=${target}` });
    const sse = { send(event, data) { if (event === 'log') emit(data); } };
    const flow = new OpenAIJsonAuthFlow(account, sse, {
        phoneMode: 'sms', reuseStoredSession: true, requireStoredSession: true,
        forbidPhoneChallenge: true, workspaceSelection: { mode: 'id', workspaceId: target },
        humanPacingEnabled: false,
        ...accountRequestNetwork(account, { proxyPool, directWhenProxyPoolEmpty }),
    });
    try {
      const record = await flow.run();
      const validated = await persistBusinessCodexAuthResult(account.id, record, target);
      return { ok: true, skipped: false, id: account.id, email: account.email, workspaceId: target, businessOpenAiAccountId: validated.accountId, businessOpenAiTokenExpiresAt: validated.expiresAt, logs };
    } catch (error) { emit({ level: 'error', msg: error instanceof Error ? error.message : String(error) }); return fail(error, logs); }
    finally { await flow.dispose().catch(() => {}); }
  }

  return { runAllWorkspaceCodexAuthForAccount, runBusinessCodexAuthForAccount };
}
