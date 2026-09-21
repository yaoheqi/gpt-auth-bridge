import fs from 'node:fs/promises';
import { projectFiles } from './project-files.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SENSITIVE_PATH = /(?:^|[\\/])(?:\.env(?:\..*)?|.*(?:token|secret|credential|session|auth).*\.(?:json|txt|csv)|runtime(?:[\\/].*)?)$/i;
const SECRET_VALUE = /(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|x-admin-key)\s*[:=]\s*["']([^"']{8,})["']/ig;
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.html', '.json', '.yaml', '.yml', '.env', '.toml', '.py']);
const PLACEHOLDERS = new Set(['paste-real-access-token-here', '__missing_refresh_token__']);

export async function checkSensitivePaths(root = REPOSITORY_ROOT) {
  const violations = [];
  for (const relative of await projectFiles(root)) {
    const absolute = path.join(root, relative);
    let entry;
    try { entry = await fs.lstat(absolute); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (entry.isSymbolicLink()) { violations.push({ path: relative, reason: 'symbolic link' }); continue; }
    if (!entry.isFile()) continue;
    const samplePath = /(?:^|[\\/])(?:test|tests|fixtures)(?:[\\/]|$)/i.test(relative)
      || /(?:^|[\\/])[^\\/]+\.(?:test|spec)\.[^.]+$/i.test(relative)
      || /(?:^|[\\/])\.env\.example$/i.test(relative);
    if (!samplePath && SENSITIVE_PATH.test(relative)) violations.push({ path: relative, reason: 'sensitive path' });
    if (samplePath) continue;
    const extension = path.extname(relative).toLowerCase();
    const isEnvFile = path.basename(relative) === '.env' || path.basename(relative).startsWith('.env.');
    if (!isEnvFile && !TEXT_EXTENSIONS.has(extension)) continue;
    const text = await fs.readFile(absolute, 'utf8');
    SECRET_VALUE.lastIndex = 0;
    let match;
    while ((match = SECRET_VALUE.exec(text))) {
      const value = String(match[1] || '').toLowerCase();
      if (PLACEHOLDERS.has(value)) continue;
      if (!value || /^(?:password|passwd|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|x-admin-key|secret|token|change[-_ ]?me|replace[-_ ]?with|your[-_ ]?secret|example[-_ ]?|fixture[-_ ]?|test[-_ ]?)/i.test(value)) continue;
      violations.push({ path: relative, reason: 'inline secret-like value' });
      break;
    }
  }
  return violations;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  checkSensitivePaths(process.argv[2] ? path.resolve(process.argv[2]) : REPOSITORY_ROOT).then((violations) => {
    if (violations.length) { console.error(JSON.stringify({ ok: false, violations }, null, 2)); process.exitCode = 1; }
    else console.log(JSON.stringify({ ok: true, violations: [] }));
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
