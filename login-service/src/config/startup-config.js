const VALID_AUTH_MODES = new Set(['rt', 'agent']);
/** Each request owns an in-memory SQLite runtime; user data is never persisted to disk. */
export function validateStartupConfig(env = process.env) {
  const port = Number.parseInt(String(env.PORT || '4173'), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  const authMode = String(env.AUTH_MODE || 'rt').trim().toLowerCase();
  if (!VALID_AUTH_MODES.has(authMode)) throw new Error('AUTH_MODE must be rt or agent');
  const runtimeDir = String(env.RUNTIME_DIR || '').trim();
  if (runtimeDir.includes('\0')) throw new Error('RUNTIME_DIR must not contain NUL bytes');
  return Object.freeze({ port, authMode, runtimeDir, localOnly: true });
}
