import assert from 'node:assert/strict';
import {
  generateTotpCode,
  hasTotpSecret,
  normalizeTotpSecret,
  validateTotpSecret,
} from './totp.js';

{
  assert.equal(normalizeTotpSecret(' ab-cd '), 'ABCD');
  assert.equal(validateTotpSecret('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(generateTotpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59), '287082');
  assert.equal(hasTotpSecret({ two_factor_secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }), true);
  assert.equal(hasTotpSecret({}), false);
  try {
    validateTotpSecret('not-valid!!!');
    assert.fail('expected throw');
  } catch (error) {
    assert.match(String(error.message || error), /Base32/);
  }
}

console.log('totp.test.mjs ok');
