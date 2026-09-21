import assert from 'node:assert/strict';
import {
  assertSub2ApiAccountShape,
  buildSub2ApiAccount,
  buildSub2ApiExport,
  SUB2API_SCHEMA_VERSION,
} from './export-sub2api.js';

{
  const rt = buildSub2ApiAccount({
    access_token: [
      'eyJhbGciOiJub25lIn0',
      Buffer.from(JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        sub: 'user-1',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acc-1',
          chatgpt_user_id: 'user-1',
          chatgpt_plan_type: 'plus',
        },
        'https://api.openai.com/profile': { email: 'a@example.com' },
      })).toString('base64url'),
      'sig',
    ].join('.'),
    id_token: [
      'eyJhbGciOiJub25lIn0',
      Buffer.from(JSON.stringify({
        email: 'a@example.com',
        'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' },
      })).toString('base64url'),
      'sig',
    ].join('.'),
    refresh_token: 'rt-1',
    email: 'a@example.com',
    account_id: 'acc-1',
    expired: new Date(Date.now() + 3600_000).toISOString(),
  });
  assert.equal(assertSub2ApiAccountShape(rt), 'rt');
  assert.equal(rt.credentials.refresh_token, 'rt-1');
  assert.ok(rt.credentials.access_token);
  assert.equal(rt.credentials.email, 'a@example.com');
  assert.equal(rt.concurrency, 50);
  assert.equal(rt.priority, 1);
  assert.equal(rt.load_factor, 1);
  assert.equal(rt.rate_multiplier, 1);
  assert.equal(rt.auto_pause_on_expired, true);
}

{
  const account = buildSub2ApiAccount({
    access_token: 'a.b.c', id_token: 'a.b.c', refresh_token: 'rt', email: 'configured@example.com',
  }, { accountConcurrency: 15, priority: 3, loadFactor: 1000 });
  assert.equal(account.concurrency, 15);
  assert.equal(account.priority, 3);
  assert.equal(account.load_factor, 1000);
  assert.equal(account.rate_multiplier, 1);
}

{
  const agent = buildSub2ApiAccount({
    auth_mode: 'agentIdentity',
    agent_runtime_id: 'agent-1',
    agent_private_key: 'pk',
    account_id: 'acc-2',
    chatgpt_user_id: 'user-2',
    email: 'b@example.com',
    plan_type: 'free',
  });
  assert.equal(assertSub2ApiAccountShape(agent), 'agent');
  assert.equal(agent.credentials.agent_runtime_id, 'agent-1');
  assert.equal(agent.concurrency, 50);
}

{
  const bundle = buildSub2ApiExport([]);
  assert.equal(bundle.type, 'sub2api-data');
  assert.equal(bundle.version, SUB2API_SCHEMA_VERSION);
  assert.deepEqual(bundle.accounts, []);
}

console.log('export-sub2api.test.mjs ok');
