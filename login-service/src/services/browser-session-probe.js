import { classifySessionProbe } from '../lib/auth-behavior-contract.js';

// Pure probes never clear tokens, delete accounts or initiate authentication.
export async function probeBrowserAccount(account, { probeSession, probeToken }) {
  const probes = [];
  if (account.session_access_token) probes.push(await probeSession(account));
  const tokens = [
    { accessToken: account.openai_access_token, accountId: account.openai_account_id },
    ...(account.business_workspace_credentials || []).map(item => ({ accessToken: item.accessToken, accountId: item.accountId || item.workspaceId })),
  ].filter(item => item.accessToken);
  for (const token of tokens) {
    const result = await probeToken(token);
    probes.push({ health: classifySessionProbe(result), status: result.status });
  }
  const health = ['deactivated', 'session_invalid', 'probe_failed', 'alive'].find(value => probes.some(probe => probe.health === value)) || 'no_session';
  return { id: account.id, health, sessionInvalid: probes[0]?.health === 'session_invalid' && Boolean(account.session_access_token) };
}
