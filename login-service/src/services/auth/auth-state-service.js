import { OPENAI_CODEX_CLIENT_ID as defaultOPENAI_CODEX_CLIENT_ID } from '../../../lib/openai-oauth.js';
import {
  OPENAI_STAGES as defaultOPENAI_STAGES,
  normalizeOpenAiStage as defaultNormalizeOpenAiStage,
  stageStatusLabel as defaultStageStatusLabel,
} from '../../../lib/account-stages.js';
import {
  decodeJwtPayload as defaultDecodeJwtPayload,
  firstNonEmpty as defaultFirstNonEmpty,
  getNestedRecord as defaultGetNestedRecord,
} from '../../../lib/jwt-utils.js';
import { isAgentIdentityRecord as defaultIsAgentIdentityRecord } from '../../../lib/openai-agent-identity.js';
import { normalizeStorageStateJson as defaultNormalizeStorageStateJson } from '../../../lib/session-reuse.js';
import { nowIso as defaultNowIso } from './auth-records.js';
import { reconcileSessionPlanTypes as defaultReconcileSessionPlanTypes } from '../account-session-reconciliation.js';
import { resolveSessionPlanType as defaultResolveSessionPlanType } from '../../domain/accounts/account-domain.js';
import { validateBusinessAuthRecord as defaultValidateBusinessAuthRecord } from '../../../lib/business-workspace.js';

/** Request-owned operations. Configuration and repositories are supplied by the composition root. */
export function createAuthStateService({
  OPENAI_CODEX_CLIENT_ID = defaultOPENAI_CODEX_CLIENT_ID,
  OPENAI_STAGES = defaultOPENAI_STAGES,
  accountRepository,
  decodeJwtPayload = defaultDecodeJwtPayload,
  firstNonEmpty = defaultFirstNonEmpty,
  getAllAccounts,
  getNestedRecord = defaultGetNestedRecord,
  isAgentIdentityRecord = defaultIsAgentIdentityRecord,
  normalizeOpenAiStage = defaultNormalizeOpenAiStage,
  normalizeStorageStateJson = defaultNormalizeStorageStateJson,
  nowIso = defaultNowIso,
  reconcileSessionPlanTypes = defaultReconcileSessionPlanTypes,
  resolveSessionPlanType = defaultResolveSessionPlanType,
  stageStatusLabel = defaultStageStatusLabel,
  validateBusinessAuthRecord = defaultValidateBusinessAuthRecord,
} = {}) {
  async function persistOpenAIAuthResult(accountId, record, phoneMode = 'sms') {
    if (!accountId || !record) return;
    if (isAgentIdentityRecord(record)) {
      await persistAgentIdentity(accountId, record);
      return;
    }
    const refreshToken = String(record.refresh_token || '').trim();
    if (!refreshToken) return;
    const accessToken = String(record.access_token || '').trim();
    const accessClaims = decodeJwtPayload(accessToken);
    const accessAuth = getNestedRecord(accessClaims, 'https://api.openai.com/auth');
    await accountRepository.updateById(accountId, {
      openai_rt: refreshToken,
      openai_access_token: accessToken,
      openai_id_token: String(record.id_token || '').trim(),
      openai_account_id: firstNonEmpty(record.account_id, accessAuth.chatgpt_account_id, accessAuth.account_id),
      openai_token_expires_at: Number(accessClaims.exp || 0),
      openai_stage: OPENAI_STAGES.RT_READY,
      last_error: '',
      status: phoneMode === 'sms' ? 'Codex接码成功' : 'RT已刷新',
    });
  }

  async function persistAgentIdentity(accountId, identity) {
    if (!accountId || !isAgentIdentityRecord(identity)) return;
    await accountRepository.updateById(accountId, {
      agent_runtime_id: identity.agent_runtime_id,
      agent_private_key: identity.agent_private_key,
      agent_account_id: identity.account_id,
      agent_user_id: identity.chatgpt_user_id,
      agent_plan_type: identity.plan_type || 'free',
      agent_is_fedramp: Boolean(identity.chatgpt_account_is_fedramp),
      openai_stage: OPENAI_STAGES.AGENT_READY,
      last_error: '',
      status: 'Agent Identity已生成',
    });
  }

  async function persistOpenAiStage(accountId, stage, { status, lastError } = {}) {
    if (!accountId) return;
    const normalized = normalizeOpenAiStage(stage);
    await accountRepository.updateById(accountId, latest => ({
      openai_stage: normalized,
      status: status != null ? String(status) : stageStatusLabel(normalized),
      ...(lastError != null ? { last_error: String(lastError || '') } : {}),
    }));
  }

  async function persistChatGptWebSession(accountId, {
    accessToken = '',
    session = null,
    storageState = '',
    status = 'Session已获取',
  } = {}) {
    if (!accountId) return;
    const token = String(accessToken || '').trim();
    if (!token) throw new Error('persistChatGptWebSession 缺少 accessToken');
    const sessionJson = typeof session === 'string'
      ? session
      : JSON.stringify(session && typeof session === 'object' ? session : { accessToken: token }, null, 2);
    const storageStateJson = normalizeStorageStateJson(storageState);
    await accountRepository.updateById(accountId, latest => {
      const sessionPlanType = resolveSessionPlanType(sessionJson);
      return {
        session_access_token: token,
        session_json: sessionJson,
        storage_state_json: storageStateJson,
        ...(sessionPlanType ? { agent_plan_type: sessionPlanType } : {}),
        ...((![OPENAI_STAGES.REGISTERED, OPENAI_STAGES.SESSION_READY, OPENAI_STAGES.PHONE_PENDING, OPENAI_STAGES.MFA_PENDING, OPENAI_STAGES.RT_READY, OPENAI_STAGES.AGENT_READY].includes(normalizeOpenAiStage(latest.openai_stage)) || latest.openai_stage === OPENAI_STAGES.FAILED)
          ? { openai_stage: OPENAI_STAGES.REGISTERED } : {}),
        status: String(status || 'Session已获取'),
        last_error: '',
      };
    });
  }

  async function persistSessionHealth(accountId, {
    health,
    detail = '',
    status = '',
    clearSession = false,
    lastError = null,
  } = {}) {
    if (!accountId) return;
    await accountRepository.updateById(accountId, {
      session_health: String(health || '').trim(),
      session_health_checked_at: nowIso(),
      session_health_detail: String(detail || '').trim().slice(0, 500),
      ...(status ? { status: String(status) } : {}),
      ...(lastError != null ? { last_error: String(lastError || '') } : {}),
      ...(clearSession ? { session_access_token: '', session_json: '', storage_state_json: '' } : {}),
    });
  }

  async function persistBusinessCodexAuthResult(accountId, record, workspaceId) {
    const validated = validateBusinessAuthRecord(record, workspaceId);
    if (validated.clientId !== OPENAI_CODEX_CLIENT_ID) throw new Error('Business access token 不是 Codex OAuth 客户端签发');
    await accountRepository.updateById(accountId, latest => {
      const existing = Array.isArray(latest.business_workspace_credentials)
        ? latest.business_workspace_credentials.filter(item => String(item?.workspaceId || '') !== workspaceId) : [];
      existing.push({ workspaceId, status: 'rt_ready', refreshToken: validated.refreshToken, accessToken: validated.accessToken, idToken: String(record.id_token || '').trim(), accountId: validated.accountId, expiresAt: validated.expiresAt, error: '' });
      return {
        business_workspace_id: workspaceId, business_join_status: 'rt_ready', business_join_error: '',
        business_openai_rt: validated.refreshToken, business_openai_access_token: validated.accessToken,
        business_openai_id_token: String(record.id_token || '').trim(), business_openai_account_id: validated.accountId,
        business_openai_token_expires_at: validated.expiresAt, business_workspace_credentials: existing,
      };
    });
    return validated;
  }

  async function clearAuthStateForFreshLogin(accountId, { status = '旧认证状态已清理' } = {}) {
    if (!accountId) return;
    await accountRepository.updateById(accountId, {
      session_access_token: '', session_json: '', storage_state_json: '',
      session_health: '', session_health_checked_at: '', session_health_detail: '',
      openai_rt: '', openai_access_token: '', openai_id_token: '', openai_account_id: '', openai_token_expires_at: 0,
      sub2api_pushed: false, sub2api_pushed_at: '', sub2api_push_source: '', sub2api_account_id: null,
      business_workspace_id: '', business_openai_rt: '', business_openai_access_token: '', business_openai_id_token: '',
      business_openai_account_id: '', business_openai_token_expires_at: 0, business_workspace_credentials: [],
      business_join_status: 'none', business_join_requested_at: '', business_join_error: '', business_join_requests: [],
      business_sub2api_pushed: false, business_sub2api_pushed_at: '', business_sub2api_push_source: '', business_sub2api_account_id: null,
      agent_runtime_id: '', agent_private_key: '', agent_account_id: '', agent_user_id: '', agent_plan_type: '', agent_is_fedramp: false,
      openai_stage: '', last_error: '', status,
    });
  }

  async function syncSessionPlanTypes() {
    const updates = await reconcileSessionPlanTypes({
      accounts: getAllAccounts(),
      resolvePlanType: resolveSessionPlanType,
      updateMany: (ids, patcher) => accountRepository.updateMany(ids, patcher),
    });
    if (updates.length) {
      console.log(`[accounts] 已根据历史 Session 类型补齐 ${updates.length} 个账号类型`);
    }
    return updates;
  }

  return { persistOpenAIAuthResult, persistAgentIdentity, persistOpenAiStage, persistChatGptWebSession, persistSessionHealth, persistBusinessCodexAuthResult, clearAuthStateForFreshLogin, syncSessionPlanTypes };
}
