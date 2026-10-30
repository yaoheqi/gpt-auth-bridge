import test from 'node:test';
import assert from 'node:assert/strict';
import { projectLoginAccounts, sharedAccountKey, healthCredentialKey, mergeSharedAccounts, loginCredentialLines } from '../docs/account-workspace.js';

test('login projections keep personal and workspace credentials separate without passwords or cookies', () => {
  const account = { id: 'one', email: 'one@example.com', password: 'private', storage_state_json: 'private-cookie',
    openai_access_token: 'personal', openai_rt: 'personal-rt', openai_account_id: 'personal-id',
    session_access_token: 'old-session', business_workspace_id: 'team-1', business_openai_access_token: 'legacy-team',
    business_workspace_credentials: [
      { workspaceId: 'team-1', accessToken: 'team-one', refreshToken: 'team-rt' },
      { workspaceId: 'team-2', accessToken: 'team-two' },
      { workspaceId: 'left', accessToken: 'revoked', status: 'left' },
    ] };
  const sources = projectLoginAccounts([account]);
  assert.deepEqual(sources.map(item => item.value.access_token), ['personal', 'team-one', 'team-two']);
  assert.deepEqual(sources.map(item => item.value.account_id), ['personal-id', 'team-1', 'team-2']);
  assert.doesNotMatch(JSON.stringify(sources), /private|legacy-team|old-session|revoked/);
  account.business_workspace_credentials[0].accessToken = '';
  assert.equal(projectLoginAccounts([account]).length, 2, 'cleared array credentials must not revive legacy credentials');
});

test('session-only login and cleared credentials project the current state', () => {
  const account = { email: 'one@example.com', session_json: JSON.stringify({ user: { email: 'one@example.com' }, accessToken: 'session', account: { id: 'personal' } }) };
  assert.equal(projectLoginAccounts([account])[0].value.accessToken, 'session');
  assert.deepEqual(projectLoginAccounts([{ ...account, session_json: '' }]), []);
  assert.deepEqual(projectLoginAccounts([{ session_json: 'malformed' }]), []);
});

test('fresh login updates the same identity, retains independent accounts and workspace identities', () => {
  const imported = [ { email: 'One@EXAMPLE.com', account_id: 'personal', access_token: 'old' },
    { email: 'two@example.com', account_id: 'two', access_token: 'unrelated' } ];
  const fresh = [ { email: 'one@example.com', account_id: 'personal', access_token: 'new' },
    { email: 'one@example.com', account_id: 'team', access_token: 'team' } ];
  const merged = mergeSharedAccounts(imported, fresh, sharedAccountKey);
  assert.deepEqual(merged.map(item => item.access_token), ['new', 'unrelated', 'team']);
  assert.notEqual(healthCredentialKey({ accessToken: 'old', accountId: 'personal' }), healthCredentialKey({ accessToken: 'new', accountId: 'personal' }));
  assert.notEqual(healthCredentialKey({ accessToken: 'same', accountId: 'personal' }), healthCredentialKey({ accessToken: 'same', accountId: 'team' }));
});

test('protocol input only receives complete login credentials and keeps password separators', () => {
  const rows = loginCredentialLines([{ email: 'token@example.com', access_token: 'token' },
    { email: 'login@example.com', password: 'pass--with----dashes', two_factor_secret: 'JBSWY3DPEHPK3PXP' },
    { email: 'bad@example.com', password: 'pass', two_factor_secret: 'bad!' }]);
  assert.deepEqual(rows, ['login@example.com----pass--with----dashes----JBSWY3DPEHPK3PXP']);
});
