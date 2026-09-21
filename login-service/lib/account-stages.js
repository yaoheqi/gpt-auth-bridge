/** Explicit OpenAI auth lifecycle stages for protocol login and export. */
export const OPENAI_STAGES = Object.freeze({
  IMPORTED: 'imported',
  ASSETS_READY: 'assets_ready',
  PREFLIGHT: 'preflight',
  REGISTERING: 'registering',
  LOGIN: 'login',
  PASSWORD: 'password',
  REGISTERED: 'registered',
  SESSION_READY: 'session_ready',
  PHONE_PENDING: 'phone_pending',
  MFA_PENDING: 'mfa',
  RT_READY: 'rt_ready',
  AGENT_READY: 'agent_ready',
  FAILED: 'failed',
  DEACTIVATED: 'deactivated',
});

const STAGE_SET = new Set(Object.values(OPENAI_STAGES));

export function normalizeOpenAiStage(value, fallback = OPENAI_STAGES.IMPORTED) {
  const text = String(value || '').trim().toLowerCase();
  if (STAGE_SET.has(text)) return text;
  return fallback;
}

export function inferOpenAiStage(account = {}) {
  if (String(account.agent_runtime_id || '').trim()) return OPENAI_STAGES.AGENT_READY;
  if (String(account.openai_rt || '').trim()) return OPENAI_STAGES.RT_READY;
  const explicit = normalizeOpenAiStage(account.openai_stage, '');
  if (explicit) return explicit;
  if (/Codex|RT已|接码成功|已导入RT/i.test(String(account.status || ''))) return OPENAI_STAGES.RT_READY;
  if (/Agent Identity/i.test(String(account.status || ''))) return OPENAI_STAGES.AGENT_READY;
  if (String(account.openai_password || '').trim()) return OPENAI_STAGES.ASSETS_READY;
  return OPENAI_STAGES.IMPORTED;
}

export function stageStatusLabel(stage) {
  switch (normalizeOpenAiStage(stage)) {
    case OPENAI_STAGES.ASSETS_READY: return '注册资料已就绪';
    case OPENAI_STAGES.PREFLIGHT: return '前置检查中';
    case OPENAI_STAGES.REGISTERING: return '注册中';
    case OPENAI_STAGES.LOGIN: return '登录中';
    case OPENAI_STAGES.PASSWORD: return '密码验证中';
    case OPENAI_STAGES.REGISTERED: return 'OpenAI已注册';
    case OPENAI_STAGES.SESSION_READY: return 'Session已就绪';
    case OPENAI_STAGES.PHONE_PENDING: return '等待手机接码';
    case OPENAI_STAGES.MFA_PENDING: return '等待 MFA 验证';
    case OPENAI_STAGES.RT_READY: return 'RT已就绪';
    case OPENAI_STAGES.AGENT_READY: return 'Agent Identity已生成';
    case OPENAI_STAGES.DEACTIVATED: return '账号已停用';
    case OPENAI_STAGES.FAILED: return '流程失败';
    default: return '账号已导入';
  }
}
