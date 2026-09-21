import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadApplicationEnv({ env = process.env, envFile = fileURLToPath(new URL('../.env', import.meta.url)) } = {}) {
  if (env.SKIP_DOTENV !== '1') {
    let content = '';
    try { content = fs.readFileSync(envFile, 'utf8'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    for (const line of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const match = line.trim().replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      else value = value.replace(/(?:^|\s+)#.*$/, '').trim();
      if (!Object.hasOwn(env, match[1])) env[match[1]] = value;
    }
  }
  env.HOST ||= '127.0.0.1';
  env.PORT ||= '4173';
  if (!env.PYTHON) {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const suffix = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
    for (const directory of [root, path.join(root, 'login-service')]) {
      const executable = path.join(directory, '.venv', ...suffix);
      if (fs.existsSync(executable)) { env.PYTHON = executable; break; }
    }
  }
  return env;
}
