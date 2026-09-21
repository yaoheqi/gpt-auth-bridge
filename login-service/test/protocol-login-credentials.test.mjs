import assert from 'node:assert/strict';
import test from 'node:test';
import { protocolLoginCredentialIssue, publicAccountView, resolveAccountLoginMethod } from '../src/domain/accounts/account-domain.js';
import { preflightAccountForAuth } from '../src/lib/auth-preflight.js';

const credentials = { email: 'fixture@example.com', password: 'fixture-password', two_factor_secret: 'JBSWY3DPEHPK3PXP' };

test('password/TOTP credentials take precedence over a stored session', () => {
  const account = {
    ...credentials, session_access_token: 'session-token',
  };
  assert.equal(resolveAccountLoginMethod(account), 'password_totp');
  assert.equal(protocolLoginCredentialIssue(account), '');
  assert.equal(preflightAccountForAuth(account).ok, true);
  assert.equal(publicAccountView(account).canProtocolLogin, true);
});

test('all protocol credential checks reject incomplete credentials even with stored session access', () => {
  for (const alternate of [
    { session_access_token: 'session-token', session_json: '{}' },
    { openai_rt: 'openai-refresh-token' },
  ]) {
    for (const missing of ['email', 'password', 'two_factor_secret']) {
      const account = { ...credentials, ...alternate, [missing]: '' };
      assert.match(protocolLoginCredentialIssue(account), /缺少/);
      assert.equal(preflightAccountForAuth(account).ok, false);
      assert.equal(publicAccountView(account).canProtocolLogin, false);
    }
  }
  const invalid = { ...credentials, two_factor_secret: 'invalid!secret' };
  assert.match(protocolLoginCredentialIssue(invalid), /Base32/);
  assert.equal(preflightAccountForAuth(invalid).ok, false);
});
