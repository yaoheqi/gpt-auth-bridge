import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('browser login skips unused token work and starts only one Playwright driver', { timeout: 60000 }, async () => {
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const { stderr } = await promisify(execFile)(python, [fileURLToPath(new URL('./sentinel-runtime.py', import.meta.url))], {
    windowsHide: true, timeout: 55000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.match(stderr, /Ran 2 tests/);
  assert.doesNotMatch(stderr, /Task was destroyed|Future exception|TargetClosedError/);
});
