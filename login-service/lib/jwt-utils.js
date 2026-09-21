export function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return {};
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getNestedRecord(payload, key) {
  const value = payload?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return '';
}

export function parseExpiredTime(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const normalized = text.endsWith('Z') ? text : `${text}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0;
}

export function resolveOrganizationId(idClaims, accessClaims) {
  const idAuth = getNestedRecord(idClaims, 'https://api.openai.com/auth');
  const accessAuth = getNestedRecord(accessClaims, 'https://api.openai.com/auth');
  const organizations = [idAuth.organizations, accessAuth.organizations].find(Array.isArray);
  if (!Array.isArray(organizations) || !organizations.length) return '';
  const first = organizations[0];
  return first && typeof first === 'object' && !Array.isArray(first) ? firstNonEmpty(first.id) : '';
}
