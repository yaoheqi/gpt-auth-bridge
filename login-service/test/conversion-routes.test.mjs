import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

import { registerConversionRoutes } from '../src/api/routes/conversion-routes.js';

function jwt() {
  return [
    Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: 'user-1', exp: 4_000_000_000, 'https://api.openai.com/profile': { email: 'node@example.com' } })).toString('base64url'),
    'signature',
  ].join('.');
}

async function listen(app) {
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('session conversion accepts account ids via resolveAccountSessions', async t => {
  const calls = [];
  const app = express(); app.use(express.json());
  registerConversionRoutes(app, {
    requireAdmin: (req, res, next) => next(),
    registerIdentity: async input => { calls.push(input.email); return { auth_mode: 'agentIdentity', agent_runtime_id: `runtime-${calls.length}`, agent_private_key: 'private', account_id: 'account-1', chatgpt_user_id: 'user-1', email: input.email, plan_type: 'free' }; },
    resolveAccountSessions: async ids => ids.map(id => ({ id, email: `${id}@example.com`, session: { accessToken: jwt(), email: `${id}@example.com` } })),
  });
  const { server, url } = await listen(app); t.after(() => server.close());
  const response = await fetch(`${url}/api/v2/conversions/session-agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['a', 'b'], concurrency: 3 }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(calls, ['a@example.com', 'b@example.com']);
  assert.equal(payload.accounts.length, 2);
  assert.equal(payload.accounts[0].concurrency, 3);
});
