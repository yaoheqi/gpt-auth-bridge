import { performance } from 'node:perf_hooks';
import { createSqliteRuntime } from '../login-service/src/bootstrap/sqlite-runtime.js';
import { normalizeDbAccount } from '../login-service/src/domain/accounts/account-domain.js';

// Synthetic credentials only, in-memory databases only, no .env or network.
for (const count of [100, 500, 1000]) {
  const started = performance.now();
  const runtime = createSqliteRuntime();
  try {
    await runtime.accounts.initialize();
    for (let i = 0; i < count; i++) runtime.accounts.state.accounts.push(normalizeDbAccount({
      id: `fixture-${i}`, email: `fixture-${i}@example.test`, password: 'fixture-password',
      two_factor_secret: 'JBSWY3DPEHPK3PXP', session_access_token: 'fixture-access', openai_rt: 'fixture-refresh',
    }));
    await runtime.accounts.save();
    const initializeMs = performance.now() - started;
    const samples = [];
    for (let i = 0; i < 5; i++) {
      runtime.accounts.state.accounts[0].status = `fixture-${i}`;
      const before = performance.now();
      await runtime.accounts.save({ ids: ['fixture-0'] });
      samples.push(performance.now() - before);
    }
    samples.sort((a, b) => a - b);
    console.log(JSON.stringify({ count, initializeMs: +initializeMs.toFixed(1), singleUpdateMedianMs: +samples[2].toFixed(1) }));
  } finally { runtime.db.close(); runtime.secrets.key.fill(0); }
}
