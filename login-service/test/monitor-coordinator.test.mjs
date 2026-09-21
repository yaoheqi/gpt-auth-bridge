import assert from 'node:assert/strict';
import test from 'node:test';
import { createMonitorCoordinator, terminalLoginFailure } from '../src/services/monitor-coordinator.js';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const account = { id: 'a', email: 'fixture@example.com', password: 'fixture-password', two_factor_secret: 'JBSWY3DPEHPK3PXP' };

test('independent browsers coordinate by normalized email, with renewal, expiry and stale-owner fencing', async () => {
  let time = 0;
  const coordinator = createMonitorCoordinator({ now: () => time });
  const peer = { ...account, id: 'different-local-id', email: ' FIXTURE@EXAMPLE.COM ' };
  assert.equal(coordinator.claim([account], alice)[0].owned, true);
  assert.equal(coordinator.claim([peer], bob)[0].owned, false);
  assert.equal(coordinator.claim([{ ...account, email: 'other@example.com' }], bob)[0].owned, true);
  time = 120_000;
  assert.equal(coordinator.claim([account], alice)[0].owned, true);
  time = 200_000;
  assert.equal(coordinator.claim([peer], bob)[0].owned, false);
  time = 300_001;
  assert.equal(coordinator.claim([peer], bob)[0].owned, true);
  await assert.rejects(coordinator.run([account.email], alice, () => assert.fail('stale owner')), { code: 'MONITOR_LEASE_LOST' });
  assert.equal(await coordinator.run([peer.email], bob, () => 'owned'), 'owned');
  coordinator.release([peer], bob);
  assert.equal(coordinator.claim([account], alice)[0].owned, true);
});

test('active work stays exclusive beyond TTL and renewal cannot undo an explicit release', async () => {
  let time = 0;
  const coordinator = createMonitorCoordinator({ now: () => time });
  coordinator.claim([account], alice);
  let finish;
  const task = coordinator.run([account.email, account.email], alice, () => new Promise(resolve => { finish = resolve; }));
  time = 240_000;
  assert.equal(coordinator.claim([account], bob)[0].owned, false);
  assert.equal(coordinator.claim([account], alice)[0].owned, true);
  await assert.rejects(coordinator.run([account.email], alice, () => assert.fail('duplicate work')), { code: 'MONITOR_LEASE_LOST' });
  coordinator.release([account], alice);
  assert.equal(coordinator.claim([account], alice)[0].owned, false);
  assert.equal(coordinator.claim([account], bob)[0].owned, false);
  finish();
  await task;
  assert.equal(coordinator.claim([account], bob)[0].owned, true);
});

test('errors unpin work and credential failures are shared only for the same credentials until cleared or expired', async () => {
  let time = 0;
  const coordinator = createMonitorCoordinator({ now: () => time });
  coordinator.claim([account], alice);
  await assert.rejects(coordinator.run([account.email], alice, () => { throw new Error('network'); }), /network/);
  coordinator.record(account, 'password_invalid');
  assert.deepEqual(coordinator.claim([{ ...account, id: 'peer' }], bob), [{ id: 'peer', owned: false, terminalReason: 'password_invalid' }]);
  coordinator.release([account], alice);
  assert.equal(coordinator.claim([{ ...account, password: 'corrected' }], bob)[0].owned, true);
  coordinator.record(account, '');
  assert.equal(coordinator.stopReason(account), '');
  coordinator.record(account, 'totp_invalid');
  time = 86_400_001;
  assert.equal(coordinator.stopReason(account), '');
  assert.equal(coordinator.claim([account], alice)[0].owned, true);
});

test('only explicit account or credential rejection stops monitoring; transient MFA and authorization-code failures remain retryable', () => {
  for (const message of ['account_deleted', 'user_not_found', '账号已删除', '账号被封禁', 'account has been deactivated', 'account banned', 'account suspended']) assert.equal(terminalLoginFailure(message), 'account_unavailable', message);
  for (const message of ['invalid_username_or_password', 'Incorrect password', 'Incorrect email address or password', 'Wrong email or password', 'password is invalid', '密码不正确']) assert.equal(terminalLoginFailure(message), 'password_invalid', message);
  for (const message of ['MFAVerify请求失败: HTTP 400 invalid_code', 'MFAVerify: Invalid verification code', 'OTP is wrong', 'invalid_otp', '2FA 密钥不是有效的 Base32', '验证码错误']) assert.equal(terminalLoginFailure(message), 'totp_invalid', message);
  for (const message of ['MFA request timed out', 'MFAVerify请求失败: HTTP 403', 'PasswordVerify: HTTP 400 invalid_state', 'MFAVerify: invalid_state', 'password verify ECONNRESET', 'invalid authorization code', 'invalid_code', 'OAuth invalid_grant', 'network error']) assert.equal(terminalLoginFailure(message), '', message);
});
