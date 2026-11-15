import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluationLogoutAccounts, evaluationAccountOwner, evaluationResultOwners, evaluationAccountLines } from '../docs/evaluation-accounts.js';
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

test('copy groups completed candy results by owner and retains results after logout', () => {
  const result = (owner, status, extra = {}) => ({ owner, status, question: 'candy', startedAt: 1, ...extra });
  const jobs = [result('mixed@example.com', 'wrong_answer'), result('mixed@example.com', 'passed'),
    result('mixed@example.com', 'passed'), result('wrong@example.com', 'wrong_answer'), result('wrong@example.com', 'error'),
    result('invalid@example.com', 'invalid_format'), result('error@example.com', 'error', { loggedOut: true }),
    result('wrong@example.com', 'passed', { question: 'pelican' }), result('cancelled@example.com', 'cancelled'),
    result('queued@example.com', 'queued', { startedAt: undefined }), result('', 'passed')];
  assert.deepEqual(evaluationResultOwners(jobs, 'success'), ['mixed@example.com']);
  assert.deepEqual(evaluationResultOwners(jobs, 'failed'), ['wrong@example.com', 'invalid@example.com', 'error@example.com']);
  assert.deepEqual(evaluationResultOwners([], 'success'), []);
});

test('copy preserves original login lines, uses saved credentials when needed and falls back to email', () => {
  const line = 'Input@Example.com---pass--word|fixture---JBSWY3DPEHPK3PXP';
  const accounts = [{ email: 'cached@example.com', password: 'cached-password', two_factor_secret: 'JBSWY3DPEHPK3PXP' },
    { email: 'input@example.com', password: 'old-password', two_factor_secret: 'OLDSECRET' }];
  const lines = evaluationAccountLines(['input@example.com', 'cached@example.com', 'token@example.com'], {
    input: `  ${line}\r\nunused@example.com----unused----JBSWY3DPEHPK3PXP\n`, accounts,
  });
  assert.deepEqual(lines, [line, 'cached@example.com----cached-password----JBSWY3DPEHPK3PXP', 'token@example.com']);
  assert.deepEqual(evaluationAccountLines(['token@example.com']), ['token@example.com']);
});
