import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAccountFingerprint, normalizeFingerprintRecord, protocolFlag } from '../src/lib/fingerprint-schema.js';
import { createSessionLoginService } from '../src/services/auth/session-login-service.js';
import { createCoreMethods } from '../src/services/auth/flow/core.js';

const fixed = { userAgent: 'fixed-fixture' };
const saved = { userAgent: 'saved-fixture', region: 'US' };
const normalizeStored = value => normalizeFingerprintRecord(value).fingerprint;

test('protocol flags recognize explicit false in environment and JSON inputs', () => {
  for (const value of [false, 0, '0', ' False ', 'no', 'OFF']) assert.equal(protocolFlag(value, true), false);
  for (const value of [true, 1, '1', 'TRUE', 'yes', 'on']) assert.equal(protocolFlag(value, false), true);
  for (const fallback of [true, false]) {
    for (const value of [null, undefined, '', 'invalid']) assert.equal(protocolFlag(value, fallback), fallback);
  }
});

test('fixed mode ignores a saved profile in authorization and probes and preserves the account record', () => {
  for (const settings of [{ enabled: true, randomFingerprint: false }, { enabled: false, randomFingerprint: true }]) {
    const account = { fingerprint_json: JSON.stringify(saved), fingerprint_created_at: 'original' };
    const original = { ...account };
    const session = { settings, fingerprint: fixed, fingerprintSource: '固定模板' };
    const rejectRead = () => assert.fail('fixed mode must not read the stored profile');
    applyAccountFingerprint(session, account, rejectRead, () => assert.fail('unexpected write'));
    assert.equal(session.fingerprint, fixed);
    assert.deepEqual(account, original);
    const service = createSessionLoginService({
      STATIC_DEVICE_FINGERPRINT: fixed, normalizeStoredFingerprint: rejectRead,
      getProtocolSettings: () => settings, buildBrowserHeaders: (_headers, profile) => ({ 'user-agent': profile.userAgent }),
    });
    assert.equal(service.sessionProbeHeaders('', account.fingerprint_json)['user-agent'], fixed.userAgent);
  }
});

test('authorization logs identify the profile source without serializing device or proxy details', () => {
  const account = {};
  const session = { settings: { enabled: true, randomFingerprint: true }, fingerprint: saved, fingerprintSource: '本次生成' };
  const methods = createCoreMethods();
  for (const source of ['本次生成', '复用账号记录']) {
    applyAccountFingerprint(session, account, normalizeStored, () => 'fixture-timestamp');
    assert.equal(session.fingerprintSource, source);
    let message;
    methods.logProtocolHardening.call({ ...session, proxyLabel: 'private-proxy', log: msg => { message = msg; } });
    assert.equal(message, `协议授权指纹：${source}`);
  }
  assert.equal(account.fingerprint_created_at, 'fixture-timestamp');
});
