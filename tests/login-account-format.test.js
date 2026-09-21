import assert from 'node:assert/strict';
import test from 'node:test';
import { splitPasswordTotpLine } from '../docs/login-account-format.js';
import { parseAccount, parseManagementImportLine, parseUserImportLine } from '../login-service/src/domain/accounts/account-domain.js';

const secret = 'JBSWY3DPEHPK3PXP';
const email = 'fixture@example.com';

test('browser and API preserve mixed boundary dashes and separators within passwords', () => {
  const rows = [
    ['--', 'Password!', '--', 'Password!'],
    ['---', 'Password!', '---', 'Password!'],
    ['----', 'Password!', '----', 'Password!'],
    ['---', 'Password!', '--', '-Password!'],
    ['--', 'Password!', '---', 'Password!-'],
    ['-----', 'Password!', '----', '-Password!'],
    ['----', 'Password!', '-----', 'Password!-'],
    ['---', 'Password!', '----', 'Password!-'],
    ['----', 'Password!', '--', '--Password!'],
    ['-----', 'Password!', '-----', '-Password!-'],
    ['--', 'pass--word---with----dashes|and|pipes', '--', 'pass--word---with----dashes|and|pipes'],
    ['----', 'pass--word---with----dashes', '----', 'pass--word---with----dashes'],
  ];
  for (const [left, middle, right, password] of rows) {
    const line = `${email}${left}${middle}${right}${secret}`;
    assert.deepEqual(splitPasswordTotpLine(line), [email, password, secret]);
    for (const parse of [parseAccount, parseManagementImportLine, parseUserImportLine]) {
      const account = parse(line);
      assert.equal(account.password, password);
      assert.equal(account.two_factor_secret, secret);
      assert.equal(parse(account.raw).password, password);
    }
  }
});

test('account parsing retains email dashes, legacy pipes and normalized TOTP', () => {
  for (const address of ['fixture--name@example.com', 'fixture@xn--example.test', 'fixture@my--domain.example.com']) {
    assert.deepEqual(splitPasswordTotpLine(`${address}--p--${secret}`), [address, 'p', secret]);
  }
  const normalized = parseManagementImportLine(`\uFEFF ${email}----pass|word----jbsw y3dp-ehpk3pxp \r`);
  assert.equal(normalized.password, 'pass|word');
  assert.equal(normalized.two_factor_secret, secret);
  assert.equal(parseAccount(`${email}|pass----word|${secret}`).password, 'pass----word');
  assert.equal(parseUserImportLine(`${email}----refresh-token`).mode, 'rt');
});

test('invalid imports fail without including credentials in the error', () => {
  for (const line of ['', `${email}-private-fixture-${secret}`, `${email}--------${secret}`, `${email}--private-fixture--bad!secret`, `not-email--private-fixture--${secret}`]) {
    assert.throws(() => parseManagementImportLine(line), error => !error.message.includes('private-fixture') && !error.message.includes(secret));
  }
});
