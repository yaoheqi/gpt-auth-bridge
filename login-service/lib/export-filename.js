/**
 * Normalize a user-configured export file prefix (e.g. v1 / v1_ → v1_).
 * Empty input stays empty.
 */
export function normalizeExportFilePrefix(value) {
  let text = String(value ?? '').trim();
  if (!text) return '';
  text = text.replace(/[^A-Za-z0-9._-]/g, '');
  if (!text) return '';
  if (!/[_\-]$/.test(text)) text = `${text}_`;
  return text;
}

/** Normalize the persisted "next export" sequence to vN_. */
export function normalizeSequentialExportPrefix(value, fallback = 1) {
  const match = String(value ?? '').trim().match(/^v(\d+)_?$/i);
  const number = match ? Number.parseInt(match[1], 10) : Number.parseInt(String(fallback), 10);
  return `v${Number.isSafeInteger(number) && number >= 1 ? number : 1}_`;
}

export function nextSequentialExportPrefix(value) {
  const current = normalizeSequentialExportPrefix(value);
  const number = Number.parseInt(current.slice(1), 10);
  return `v${number + 1}_`;
}

export function withExportFilePrefix(fileName, prefix = '') {
  const name = String(fileName || '').replace(/^[/\\]+/, '');
  const normalized = normalizeExportFilePrefix(prefix);
  if (!normalized) return name;
  if (name.startsWith(normalized)) return name;
  return `${normalized}${name}`;
}

/** Local YYYYMMDD-HHMMSS for download / export filenames. */
export function exportStampLocal(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

/** Build `{prefix}{stem}-{stamp}.{ext}` */
export function buildPrefixedExportFileName(stem, ext, { prefix = '', now = new Date() } = {}) {
  const safeStem = String(stem || 'export').replace(/[^A-Za-z0-9._-]/g, '_');
  const safeExt = String(ext || 'json').replace(/^\./, '');
  return withExportFilePrefix(`${safeStem}-${exportStampLocal(now)}.${safeExt}`, prefix);
}
