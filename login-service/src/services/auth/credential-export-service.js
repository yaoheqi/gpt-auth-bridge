import {
  OPENAI_CODEX_USER_AGENT as defaultOPENAI_CODEX_USER_AGENT,
  buildRefreshTokenBody as defaultBuildRefreshTokenBody,
} from '../../../lib/openai-oauth.js';
import {
  assertSub2ApiAccountShape as defaultAssertSub2ApiAccountShape,
  buildSub2ApiExport as defaultBuildSub2ApiExport,
} from '../../../lib/export-sub2api.js';
import {
  buildStoredRtExportRecord as defaultBuildStoredRtExportRecord,
  selectRtExportAccounts as defaultSelectRtExportAccounts,
} from '../rt-export-service.js';
import {
  isAgentIdentityRecord as defaultIsAgentIdentityRecord,
  registerOpenAIAgentIdentity as defaultRegisterOpenAIAgentIdentity,
} from '../../../lib/openai-agent-identity.js';
import { normalizeOpenAIRecordFromRefreshPayload as defaultNormalizeOpenAIRecordFromRefreshPayload } from './auth-records.js';

/** Request-owned operations. Configuration and repositories are supplied by the composition root. */
export function createCredentialExportService({
  AUTH_OAUTH_TOKEN_URLS,
  OPENAI_CODEX_USER_AGENT = defaultOPENAI_CODEX_USER_AGENT,
  assertSub2ApiAccountShape = defaultAssertSub2ApiAccountShape,
  buildExportFileName,
  buildRefreshTokenBody = defaultBuildRefreshTokenBody,
  buildStoredRtExportRecord = defaultBuildStoredRtExportRecord,
  buildSub2ApiExport = defaultBuildSub2ApiExport,
  fetch = globalThis.fetch,
  getSub2ApiSettings,
  isAgentIdentityRecord = defaultIsAgentIdentityRecord,
  normalizeOpenAIRecordFromRefreshPayload = defaultNormalizeOpenAIRecordFromRefreshPayload,
  normalizePhoneMode,
  registerOpenAIAgentIdentity = defaultRegisterOpenAIAgentIdentity,
  selectRtExportAccounts = defaultSelectRtExportAccounts,
} = {}) {
  async function createAgentIdentityRecord(record, fetchImpl = fetch) {
    if (isAgentIdentityRecord(record)) return record;
    return registerOpenAIAgentIdentity({
      accessToken: String(record?.access_token || ''),
      email: String(record?.email || ''),
      fetchImpl,
    });
  }

  async function buildSub2ApiJsonForAccounts(accounts, { healthResults = [], initialErrors = [], skipHealthCheck = false } = {}) {
    const records = [];
    const errors = [...initialErrors];
    const exportedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const alive = selectRtExportAccounts(accounts, healthResults, { skipHealthCheck });
    const aliveIds = new Set(alive.map(item => String(item.account.id || '')));

    for (const account of accounts) {
      if (!aliveIds.has(String(account.id || ''))) {
        const result = healthResults.find(item => String(item.id || '') === String(account.id || ''));
        errors.push({ email: account.email, error: result?.error || result?.healthLabel || result?.health || 'Session 验活未通过' });
        continue;
      }
      try { records.push(buildStoredRtExportRecord(account)); }
      catch (error) { errors.push({ email: account.email, error: error instanceof Error ? error.message : String(error) }); }
    }

    const json = buildSub2ApiExport(records, exportedAt, getSub2ApiSettings());
    for (const account of json.accounts) assertSub2ApiAccountShape(account);
    const fileName = await buildExportFileName('sub2api-rt', 'json');
    return { json, fileName, text: `${JSON.stringify(json, null, 2)}\n`, success: records.length, failed: errors.length, errors };
  }

  async function resolveSub2ApiExportRecord(record, { phoneMode = '', fetchImpl = fetch } = {}) {
    const mode = normalizePhoneMode(phoneMode);
    if (isAgentIdentityRecord(record)) {
      if (mode === 'sms') throw new Error('当前凭据模式为 refresh_token，不能导出 Agent Identity；请切换模式或重新接码获取 RT');
      return record;
    }
    // rt 模式：只导出带 refresh_token 的 OAuth sub2api
    if (mode === 'sms') {
      if (!String(record?.refresh_token || '').trim()) {
        throw new Error('当前凭据模式为 refresh_token，但账号缺少 refresh_token，请先执行 Codex 登录接码');
      }
      return record;
    }
    // agent 模式：只导出 Agent Identity，不走 RT
    return createAgentIdentityRecord(record, fetchImpl);
  }

  async function refreshOpenAIRecordFromRt(account, logger) {
    const rt = String(account?.openai_rt || '').trim();
    if (!rt) throw new Error('该邮箱尚未导入 OpenAI rttoken');
    let lastError = '';
    for (const tokenURL of AUTH_OAUTH_TOKEN_URLS) {
      const response = await fetch(tokenURL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': OPENAI_CODEX_USER_AGENT,
        },
        body: buildRefreshTokenBody(rt),
      });
      const text = await response.text();
      let payload;
      try { payload = JSON.parse(text); } catch { payload = {}; }
      if (response.ok && payload.access_token) {
        logger?.(`OpenAI RT 刷新成功: ${tokenURL}`);
        return normalizeOpenAIRecordFromRefreshPayload(account.email, payload, rt);
      }
      lastError = `endpoint=${tokenURL} HTTP ${response.status} ${text.slice(0, 300)}`;
      logger?.(`OpenAI RT 刷新失败: ${lastError}`, 'warn');
    }
    throw new Error(`OpenAI RT 刷新 access_token 失败: ${lastError}`);
  }

  return { createAgentIdentityRecord, buildSub2ApiJsonForAccounts, resolveSub2ApiExportRecord, refreshOpenAIRecordFromRt };
}
