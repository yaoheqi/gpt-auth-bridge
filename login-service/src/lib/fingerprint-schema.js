import { parseFingerprintJson } from '../../lib/device-fingerprint.js';

export const FINGERPRINT_SCHEMA_VERSION = 1;

export function protocolFlag(value, fallback) {
  const flag = String(value ?? '').trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(flag)) return false;
  if (['true', '1', 'yes', 'on'].includes(flag)) return true;
  return fallback;
}

export function usesFixedProtocolFingerprint(settings) {
  return settings.enabled === false || settings.randomFingerprint === false;
}

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

export function applyAccountFingerprint(session, account, normalizeStored, nowIso) {
  if (usesFixedProtocolFingerprint(session.settings)) return;
  const stored = normalizeStored(account.fingerprint_json);
  if (stored) {
    session.fingerprint = stored;
    session.fingerprintSource = '复用账号记录';
    if (!Number(stored.schemaVersion || 0)) account.fingerprint_json = stringifyFingerprintRecord(stored);
  } else {
    account.fingerprint_json = stringifyFingerprintRecord(session.fingerprint);
    account.fingerprint_created_at ||= nowIso();
  }
  account.fingerprint_region = session.fingerprint.region || account.fingerprint_region || '';
}
