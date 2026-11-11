import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluationLogoutAccounts, evaluationAccountOwner } from '../docs/evaluation-accounts.js';
import { healthCredentialKey } from '../docs/account-workspace.js';

test('logout includes tested incorrect/error accounts once and protects passing siblings', () => {
  const accounts = ['shared-pass', 'shared-wrong', 'wrong-a', 'wrong-b', 'error', 'invalid', 'manual', 'queued', 'cancelled', 'untested', 'logged-out']
    .map(id => ({ email: id.startsWith('shared') ? ' Shared@Example.com ' : id.startsWith('wrong') ? 'wrong@example.com' : `${id}@example.com`, accessToken: id, accountId: id }));
  const statuses = ['passed', 'wrong_answer', 'wrong_answer', 'error', 'error', 'invalid_format', 'manual_review', 'cancelled', 'cancelled', 'queued', 'wrong_answer'];
  const jobs = accounts.map((account, index) => ({ owner: evaluationAccountOwner(account), credentialKey: healthCredentialKey(account), question: 'candy',
    status: statuses[index], startedAt: ['queued', 'untested'].includes(account.accountId) ? undefined : 1, loggedOut: account.accountId === 'logged-out' }));
  jobs.push({ ...jobs[2], question: 'pelican', status: 'passed' });
  assert.deepEqual(evaluationLogoutAccounts(jobs, accounts).map(account => account.accountId), ['wrong-a', 'error', 'invalid', 'manual']);
  assert.deepEqual(evaluationLogoutAccounts(jobs, accounts.map(account => ({ ...account, accessToken: 'new' }))), []);
});
