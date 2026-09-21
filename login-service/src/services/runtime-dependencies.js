import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../../scripts/check_runtime.py', import.meta.url));

export function createRuntimeDependencyCheck({ env = process.env, run = execute, now = Date.now, cacheMs = 60_000 } = {}) {
  let pending;
  let expires = 0;
  return () => {
    if (!pending || now() >= expires) {
      expires = Infinity;
      pending = Promise.resolve().then(async () => {
        try {
          const { stdout } = await run(env.PYTHON || env.PYTHON3 || (process.platform === 'win32' ? 'python' : 'python3'), [script], {
            windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024,
            env: { ...env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
          });
          const result = JSON.parse(stdout);
          if (!result.chromium || !result.curl_cffi || !result.playwright) throw new Error('Incomplete runtime check');
          return result;
        } catch {
          throw new Error('Python/curl_cffi/Chromium 自检失败，请运行 npm run check:runtime 并按 README 安装依赖');
        } finally { expires = now() + cacheMs; }
      });
    }
    return pending;
  };
}
