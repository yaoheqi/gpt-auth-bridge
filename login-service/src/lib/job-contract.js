const JOB_TYPES = new Set(['protocol-login', 'session-health']);

// Kept as a compatibility export for archived browser-register modules; the
// retired job type is rejected by normalizeJobManifest and never dispatched.
export function normalizeBrowserRegisterOptions(options = {}) {
  return sanitizeJobOptions(options);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  }
  return value;
}

const SENSITIVE_OPTION_KEYS = new Set([
  'password', 'proxyPassword', 'token',
  'proxy', 'proxyFile', 'proxyMode', 'proxyPool', 'gatewayTemplate', 'directMaxConcurrency',
]);

export function sanitizeJobOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return {};
  const cleaned = {};
  for (const [key, value] of Object.entries(options)) {
    if (SENSITIVE_OPTION_KEYS.has(key)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

export function normalizeJobManifest(value = {}) {
  const type = String(value.type || '').trim();
  if (!JOB_TYPES.has(type)) throw new Error(`Unsupported job type: ${type || '(empty)'}`);
  const jobId = String(value.jobId || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/.test(jobId)) throw new Error('jobId must be 3-80 safe characters');
  const ids = Array.isArray(value.ids) ? [...new Set(value.ids.map((x) => String(x || '').trim()).filter(Boolean))] : [];
  const scope = String(value.scope || '').toLowerCase() === 'all' ? 'all' : 'selected';
  if (scope === 'selected' && !ids.length) throw new Error('selected jobs require at least one account id');
  let options = sanitizeJobOptions(value.options && typeof value.options === 'object' ? value.options : {});
  return Object.freeze({
    schemaVersion: '1.0.0',
    jobId,
    type,
    scope,
    ids,
    options: stable(options),
    createdAt: String(value.createdAt || new Date().toISOString()),
  });
}

export function equivalentJobManifests(a, b) {
  const operation = (x) => stable({
    schemaVersion: x.schemaVersion,
    jobId: x.jobId,
    type: x.type,
    scope: x.scope,
    ids: x.ids,
    options: x.options,
  });
  return JSON.stringify(operation(a)) === JSON.stringify(operation(b));
}

export function createJobId(type, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${type}-${stamp}`;
}

export const SUPPORTED_JOB_TYPES = Object.freeze([...JOB_TYPES]);
