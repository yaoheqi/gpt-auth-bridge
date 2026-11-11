import { healthCredentialKey } from './account-workspace.js';

export const evaluationAccountOwner = account => String(account?.email || '').trim().toLowerCase();

// Logout is account-wide. A passing sibling protects the entire login owner.
export function evaluationLogoutAccounts(jobs, accounts) {
  const passed = new Set(jobs.filter(job => job.question === 'candy' && job.status === 'passed').map(job => job.owner));
  const tested = new Set(jobs.filter(job => job.question === 'candy' && job.startedAt && !job.loggedOut
    && ['wrong_answer', 'invalid_format', 'manual_review', 'error'].includes(job.status)).map(job => job.credentialKey));
  const selected = new Map();
  for (const account of accounts) {
    const owner = evaluationAccountOwner(account);
    if (!owner || passed.has(owner) || !tested.has(healthCredentialKey(account))) continue;
    if (!selected.has(owner)) selected.set(owner, account);
  }
  return [...selected.values()];
}
