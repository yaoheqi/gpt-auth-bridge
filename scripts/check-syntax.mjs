import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Script } from 'node:vm';
import { projectFiles } from './project-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const files = await projectFiles(root);
let checked = 0;
const failures = [];
let index = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (index < files.length) {
    const file = files[index++];
    if (!/\.(?:m?js|html|py)$/.test(file)) continue;
    const absolute = path.join(root, file);
    try { await fs.access(absolute); } catch { continue; }
    try {
      if (/\.m?js$/.test(file)) await execute(process.execPath, ['--check', absolute], { windowsHide: true });
      else if (/\.py$/.test(file)) await execute(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8-sig"), filename=sys.argv[1])', absolute], { windowsHide: true });
      else {
        const html = await fs.readFile(absolute, 'utf8');
        for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
          if (!/\bsrc\s*=|application\/ld\+json/i.test(match[1])) new Script(match[2], { filename: file });
        }
      }
      checked++;
    } catch { failures.push(file); }
  }
}));
console.log(JSON.stringify({ ok: failures.length === 0, checked, failures }, null, 2));
if (failures.length) process.exitCode = 1;
