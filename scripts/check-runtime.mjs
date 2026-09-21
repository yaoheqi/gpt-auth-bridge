import { loadApplicationEnv } from '../src/config.js';
import { createRuntimeDependencyCheck } from '../login-service/src/services/runtime-dependencies.js';

loadApplicationEnv();
try { console.log(JSON.stringify({ ok: true, dependencies: await createRuntimeDependencyCheck()() }, null, 2)); }
catch (error) {
  console.error(error.message);
  console.error('Install: python -m pip install -r requirements.txt; python -m playwright install chromium');
  process.exitCode = 1;
}
