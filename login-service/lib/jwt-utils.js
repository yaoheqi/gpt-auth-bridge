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
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric > 1e11 ? numeric / 1000 : numeric);
  }
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0;
}

export function resolveOrganizationId(idClaims, accessClaims) {
  const idAuth = getNestedRecord(idClaims, 'https://api.openai.com/auth');
  const accessAuth = getNestedRecord(accessClaims, 'https://api.openai.com/auth');
  const poid = firstNonEmpty(idAuth.poid, accessAuth.poid);
  if (poid) return poid;
  const organizationLists = [idAuth.organizations, accessAuth.organizations].filter(Array.isArray);
  for (const organizations of organizationLists) {
    const selected = organizations.find(item => item && typeof item === 'object' && !Array.isArray(item)
      && (item.is_default === true || item.isDefault === true));
    const id = firstNonEmpty(selected?.id);
    if (id) return id;
  }
  for (const organizations of organizationLists) {
    const first = organizations[0];
    const id = first && typeof first === 'object' && !Array.isArray(first) ? firstNonEmpty(first.id) : '';
    if (id) return id;
  }
  return '';
}
