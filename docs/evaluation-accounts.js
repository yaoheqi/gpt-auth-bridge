import { healthCredentialKey, loginCredentialLines } from './account-workspace.js';
import { splitPasswordTotpLine } from './login-account-format.js';

export const evaluationAccountOwner = account => String(account?.email || '').trim().toLowerCase();

export function evaluationResultOwners(jobs, outcome) {
  const tested = jobs.filter(job => job.owner && job.question === 'candy' && job.startedAt);
  const passed = new Set(tested.filter(job => job.status === 'passed').map(job => job.owner));
  if (outcome === 'success') return [...passed];
  return [...new Set(tested.filter(job => ['wrong_answer', 'invalid_format', 'manual_review', 'error'].includes(job.status)
    && !passed.has(job.owner)).map(job => job.owner))];
}

export function evaluationAccountLines(owners, { input = '', accounts = [] } = {}) {
  const lines = new Map();
  // Keep the original login input format, including separators in passwords.
  for (const raw of String(input).split(/\r?\n/)) {
    const line = raw.trim();
    const [email, password, secret] = splitPasswordTotpLine(line);
    if (email && password && secret) lines.set(evaluationAccountOwner({ email }), line);
  }
  for (const line of loginCredentialLines(accounts)) {
    const [email] = splitPasswordTotpLine(line);
    const owner = evaluationAccountOwner({ email });
    if (!lines.has(owner)) lines.set(owner, line);
  }
  return owners.map(owner => lines.get(owner) || owner);
}

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
