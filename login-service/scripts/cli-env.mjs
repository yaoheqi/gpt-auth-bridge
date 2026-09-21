import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { loadApplicationEnv } from '../../src/config.js';

const DEFAULT_ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));

/** Use the same root configuration and legacy aliases as npm start. */
export function loadCliEnv({
  envFile = DEFAULT_ENV_FILE,
  env = process.env,
} = {}) {
  loadApplicationEnv({ envFile, env });
  return env.SKIP_DOTENV !== '1' && existsSync(envFile);
}
