import { OPENAI_STAGES as defaultOPENAI_STAGES, inferOpenAiStage as defaultInferOpenAiStage } from '../../../lib/account-stages.js';
import { validationFailureFields } from '../../../lib/validation-error.js';
import { agentIdentityRecordFromAccount as defaultAgentIdentityRecordFromAccount, nowIso as defaultNowIso } from './auth-records.js';
import { buildSub2ApiJson as defaultBuildSub2ApiJson } from '../../../lib/export-sub2api.js';
import { durationMs as defaultDurationMs, structuredLog as defaultStructuredLog } from '../../../lib/structured-log.js';
import { isAgentIdentityRecord as defaultIsAgentIdentityRecord } from '../../../lib/openai-agent-identity.js';
import { mapWithConcurrency as defaultMapWithConcurrency } from '../../../lib/sse.js';
import { protocolLoginCredentialIssue as defaultProtocolLoginCredentialIssue } from '../../domain/accounts/account-domain.js';

/** Request-owned operations. Configuration and repositories are supplied by the composition root. */
export function createCodexAuthService({
  OPENAI_STAGES = defaultOPENAI_STAGES,
  OpenAIJsonAuthFlow,
  accountRequestNetwork,
  agentIdentityRecordFromAccount = defaultAgentIdentityRecordFromAccount,
  buildExportFileName,
  buildSub2ApiJson = defaultBuildSub2ApiJson,
  durationMs = defaultDurationMs,
  getRegisterBatchConcurrency,
  getSub2ApiSettings,
  inferOpenAiStage = defaultInferOpenAiStage,
  isAgentIdentityRecord = defaultIsAgentIdentityRecord,
  mapWithConcurrency = defaultMapWithConcurrency,
  normalizePhoneMode,
  nowIso = defaultNowIso,
  persistOpenAIAuthResult,
  persistOpenAiStage,
  protocolLoginCredentialIssue = defaultProtocolLoginCredentialIssue,
  refreshOpenAIRecordFromRt,
  resolveSub2ApiExportRecord,
  structuredLog = defaultStructuredLog,
  sub2ApiPushService,
} = {}) {
  async function runCodexAuthForAccount(account, {
    phoneMode = 'sms',
    force = false,
    reuseStoredSession = true,
    forbidPhoneChallenge = false,
    onLog,
    proxyPool,
    directWhenProxyPoolEmpty = false,
  } = {}) {
    const mode = normalizePhoneMode(phoneMode);
    const startedAt = Date.now();
    const emitLog = (entry) => {
      if (typeof onLog === 'function') onLog(entry);
    };
    structuredLog('codex_auth_start', {
      email: account.email,
      mode,
      stage: inferOpenAiStage(account),
      force: Boolean(force),
      activationId: account.sms_activation_id || undefined,
    });

    const finish = (result) => {
      structuredLog(result?.ok ? 'codex_auth_done' : 'codex_auth_failed', {
        email: account.email,
        mode,
        ok: Boolean(result?.ok),
        skipped: Boolean(result?.skipped),
        stage: result?.stage || inferOpenAiStage(account),
        durationMs: durationMs(startedAt),
        error: result?.ok ? undefined : (result?.error || undefined),
        activationId: account.sms_activation_id || undefined,
      });
      return result;
    };

    const credentialIssue = protocolLoginCredentialIssue(account);
    if (credentialIssue) {
      return finish({
        ok: false,
        skipped: false,
        email: account.email,
        mode,
        stage: OPENAI_STAGES.FAILED,
        error: credentialIssue,
        missingLoginCredentials: true,
        logs: [],
      });
    }

    if (!force) {
      if (mode === 'agent' && agentIdentityRecordFromAccount(account)) {
        const identity = agentIdentityRecordFromAccount(account);
        return finish({
          ok: true,
          skipped: true,
          email: account.email,
          mode,
          reason: '已有 Agent Identity',
          kind: 'agent',
          stage: OPENAI_STAGES.AGENT_READY,
          json: buildSub2ApiJson(identity, getSub2ApiSettings()),
          logs: [],
        });
      }
      if (mode === 'sms' && account.openai_rt) {
        try {
          const logs = [];
          const record = await refreshOpenAIRecordFromRt(account, (msg, level = 'info') => {
            const entry = { time: nowIso(), level, msg };
            logs.push(entry);
            emitLog({ email: account.email, ...entry });
          });
          await persistOpenAIAuthResult(account.id, record, mode);
          const exportRecord = await resolveSub2ApiExportRecord(record, { phoneMode: mode });
          return finish({
            ok: true,
            skipped: true,
            email: account.email,
            mode,
            reason: '已有 OpenAI RT',
            kind: 'rt',
            stage: OPENAI_STAGES.RT_READY,
            hasRefreshToken: true,
            json: buildSub2ApiJson(exportRecord, getSub2ApiSettings()),
            logs,
          });
        } catch (error) {
          // 已有 RT 但刷新失败时，仍继续走登录接码流程
        }
      }
    }

    const logs = [];
    const sse = {
      send(event, data) {
        if (event !== 'log') return;
        const entry = {
          time: data?.time || nowIso(),
          level: data?.level || 'info',
          msg: data?.msg || data?.error || '',
        };
        logs.push(entry);
        emitLog({ email: account.email, ...entry });
      },
    };

    const flow = new OpenAIJsonAuthFlow(account, sse, {
        phoneMode: mode,
        reuseStoredSession,
        forbidPhoneChallenge,
        ...accountRequestNetwork(account, { proxyPool, directWhenProxyPoolEmpty }),
    });
    try {
      const record = await flow.run();
      await persistOpenAIAuthResult(account.id, record, mode);

      if (mode === 'agent' && isAgentIdentityRecord(record)) {
        const json = buildSub2ApiJson(record, getSub2ApiSettings());
        return finish({
          ok: true,
          skipped: false,
          email: account.email,
          mode,
          kind: 'agent',
          stage: OPENAI_STAGES.AGENT_READY,
          agentRuntimeId: record.agent_runtime_id,
          json,
          logs,
        });
      }

      const exportRecord = await resolveSub2ApiExportRecord(record, { phoneMode: mode });
      const json = buildSub2ApiJson(exportRecord, getSub2ApiSettings());
      return finish({
        ok: true,
        skipped: false,
        email: account.email,
        mode,
        kind: isAgentIdentityRecord(exportRecord) ? 'agent' : 'rt',
        stage: isAgentIdentityRecord(exportRecord) ? OPENAI_STAGES.AGENT_READY : OPENAI_STAGES.RT_READY,
        hasRefreshToken: Boolean(record.refresh_token),
        json,
        logs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await persistOpenAiStage(account.id, OPENAI_STAGES.FAILED, {
        status: '流程失败',
        lastError: message,
      }).catch(() => {});
      return finish({
        ok: false,
        skipped: false,
        email: account.email,
        mode,
        stage: OPENAI_STAGES.FAILED,
        error: message,
        ...validationFailureFields(error),
        logs,
      });
    } finally {
      await flow.dispose().catch(() => {});
    }
  }

  async function runCodexAuthForAccounts(accounts, {
    phoneMode = 'sms',
    force = false,
    reuseStoredSession = true,
    forbidPhoneChallenge = false,
    exportJson = false,
    exportZip,
    onAccountStart,
    onAccountLog,
    onAccountDone,
    concurrency: requestedConcurrency,
    proxyPool,
    directWhenProxyPoolEmpty = false,
  } = {}) {
    const mode = normalizePhoneMode(phoneMode);
    const shouldExport = exportZip == null ? exportJson !== false : Boolean(exportZip);
    const concurrency = getRegisterBatchConcurrency(requestedConcurrency);
    const results = await mapWithConcurrency(accounts, concurrency, async account => {
      if (typeof onAccountStart === 'function') {
        onAccountStart({
          email: account.email,
          id: account.id,
          stage: inferOpenAiStage(account),
        });
      }
      const result = await runCodexAuthForAccount(account, {
        phoneMode: mode,
        force,
        reuseStoredSession,
        forbidPhoneChallenge,
        onLog: onAccountLog,
        proxyPool,
        directWhenProxyPoolEmpty,
      });
      if (typeof onAccountDone === 'function') onAccountDone(result);
      return result;
    });

    const success = results.filter(item => item.ok && !item.skipped).length;
    const skipped = results.filter(item => item.ok && item.skipped).length;
    const failed = results.filter(item => !item.ok).length;
    const payload = { ok: true, phoneMode: mode, success, skipped, failed, concurrency, results };

    if (shouldExport) {
      const records = [];
      for (const item of results) {
        if (!item.ok || !item.json?.accounts?.[0]) continue;
        records.push(item.json.accounts[0]);
      }
      if (records.length) {
        const exportedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        const json = {
          type: 'sub2api-data',
          version: 1,
          exported_at: exportedAt,
          proxies: [],
          accounts: records,
        };
        const fileName = await buildExportFileName(`sub2api-${mode === 'agent' ? 'agent' : 'rt'}`, 'json');
        payload.json = json;
        payload.jsonFileName = fileName;
        payload.exported = records.length;
        payload.sub2api = await sub2ApiPushService.enqueue(records);
      }
    }

    return payload;
  }

  return { runCodexAuthForAccount, runCodexAuthForAccounts };
}
