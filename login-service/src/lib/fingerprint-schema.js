import { parseFingerprintJson } from '../../lib/device-fingerprint.js';

export const FINGERPRINT_SCHEMA_VERSION = 1;

export function normalizeFingerprintRecord(value, { fallbackRegion = 'US' } = {}) {
  const fp = parseFingerprintJson(value);
  if (!fp || typeof fp !== 'object' || !fp.userAgent) {
    return { ok: false, fingerprint: null, reason: 'invalid_json_or_missing_user_agent' };
  }
  const next = {
    schemaVersion: Number(fp.schemaVersion || FINGERPRINT_SCHEMA_VERSION) || FINGERPRINT_SCHEMA_VERSION,
    ...fp,
    region: String(fp.region || fallbackRegion || 'US').toUpperCase(),
  };
  return { ok: true, fingerprint: next, reason: '' };
}

export function stringifyFingerprintRecord(fingerprint) {
  return JSON.stringify({ schemaVersion: FINGERPRINT_SCHEMA_VERSION, ...(fingerprint || {}) });
}
