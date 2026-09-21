import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);
export async function projectFiles(root) {
  try {
    const { stdout } = await execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return [...new Set(stdout.split('\0').filter(Boolean))];
  } catch {
    // Unpacked release artifacts have no Git metadata: scan their whole source.
    const ignored = new Set(['node_modules', '.git', '.venv', '__pycache__']);
    const files = [];
    async function visit(directory) {
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        if (ignored.has(item.name)) continue;
        const absolute = path.join(directory, item.name);
        if (item.isDirectory()) await visit(absolute);
        else files.push(path.relative(root, absolute));
      }
    }
    await visit(root);
    return files;
  }
}
