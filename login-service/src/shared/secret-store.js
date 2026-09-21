import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = 'v1';
const ALGORITHM = 'aes-256-gcm';

function deriveKey(masterKey = '') {
  return createHash('sha256').update(String(masterKey || 'local-development-secret'), 'utf8').digest();
}

export class SecretStore {
  constructor(masterKey = '') {
    this.key = deriveKey(masterKey);
  }

  encrypt(plain) {
    const text = plain == null ? '' : String(plain);
    if (!text) return '';
    if (text.startsWith(`${PREFIX}:`)) return text;
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [PREFIX, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(':');
  }

  decrypt(payload) {
    const text = payload == null ? '' : String(payload);
    if (!text || !text.startsWith(`${PREFIX}:`)) return text;
    const [, ivRaw, tagRaw, encryptedRaw] = text.split(':');
    if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error('Invalid encrypted payload');
    const iv = Buffer.from(ivRaw, 'base64url');
    const tag = Buffer.from(tagRaw, 'base64url');
    const encrypted = Buffer.from(encryptedRaw, 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || !encrypted.length) throw new Error('Invalid encrypted payload');
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8');
  }

  reencrypt(payload, nextStore) {
    const plain = this.decrypt(payload);
    return plain ? nextStore.encrypt(plain) : '';
  }
}

export function hashToken(token) {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
