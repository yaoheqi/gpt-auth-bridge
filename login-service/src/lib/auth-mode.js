export function normalizeAuthMode(value, fallback = 'rt') {
  const text = String(value || '').trim().toLowerCase();
  if (['agent', 'agentidentity', 'agent_identity', 'agent-identity'].includes(text)) return 'agent';
  if (['rt', 'sms', 'refresh_token', 'refresh-token', 'oauth', 'codex'].includes(text)) return 'rt';
  return fallback === 'agent' ? 'agent' : 'rt';
}

export function authModeToPhoneMode(authMode) {
  return normalizeAuthMode(authMode) === 'agent' ? 'agent' : 'sms';
}
