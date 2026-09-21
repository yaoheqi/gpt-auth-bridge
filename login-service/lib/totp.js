import { createHmac } from 'crypto';

export function normalizeTotpSecret(secret) {
  return String(secret || '').replace(/[\s-]+/g, '').toUpperCase();
}

export function validateTotpSecret(secret) {
  const normalized = normalizeTotpSecret(secret);
  if (!normalized) throw new Error('2FA 密钥不能为空');
  if (!/^[A-Z2-7]+=*$/.test(normalized)) {
    throw new Error('2FA 密钥不是有效的 Base32');
  }
  try {
    decodeBase32(normalized);
  } catch {
    throw new Error('2FA 密钥不是有效的 Base32');
  }
  return normalized;
}

function decodeBase32(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = String(secret || '').replace(/=+$/g, '').toUpperCase();
  let bits = '';
  for (const ch of cleaned) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (SHA1, 30s, 6 digits). */
export function generateTotpCode(secret, timestamp = Date.now() / 1000, period = 30, digits = 6) {
  const normalized = validateTotpSecret(secret);
  const key = decodeBase32(normalized);
  const counter = Math.floor(Number(timestamp) / period);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  const mod = 10 ** digits;
  return String(value % mod).padStart(digits, '0');
}

export function hasTotpSecret(account) {
  return Boolean(normalizeTotpSecret(account?.two_factor_secret || account?.twoFactorSecret || ''));
}
