import assert from 'node:assert/strict';
import {
  assertSub2ApiAccountShape,
  buildSub2ApiAccount,
  buildSub2ApiExport,
  SUB2API_SCHEMA_VERSION,
} from './export-sub2api.js';

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'sig',
  ].join('.');
}

{
  const expiresAt = 1_780_473_960;
  const rt = buildSub2ApiAccount({
    access_token: jwt({
      exp: expiresAt,
      iat: expiresAt - 3600,
      sub: 'user-1',
      client_id: 'jwt-client',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acc-1',
        chatgpt_user_id: 'user-1',
        chatgpt_plan_type: 'plus',
        poid: 'org-primary',
      },
      'https://api.openai.com/profile': { email: 'a@example.com' },
    }),
    id_token: jwt({
      email: 'a@example.com',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' },
    }),
    refresh_token: 'rt-1',
    client_id: 'stale-imported-client',
    oauth_provenance: {
      issuer: 'https://auth.openai.com',
      client_id: 'issuing-client',
    },
    email: 'a@example.com',
    account_id: 'acc-1',
    expired: new Date(expiresAt * 1000).toISOString(),
  });
  assert.equal(assertSub2ApiAccountShape(rt), 'rt');
  assert.equal(rt.credentials.refresh_token, 'rt-1');
  assert.equal(rt.credentials.client_id, 'issuing-client');
  assert.ok(rt.credentials.access_token);
  assert.equal(rt.credentials.email, 'a@example.com');
  assert.equal(rt.credentials.expires_at, '2026-06-03T08:06:00Z');
  assert.equal(rt.credentials.organization_id, 'org-primary');
  assert.equal(Object.hasOwn(rt.credentials, 'expires_in'), false);
  assert.equal(Object.hasOwn(rt.credentials, 'account_id'), false);
  assert.equal(Object.hasOwn(rt, 'expires_at'), false);
  assert.equal(Object.hasOwn(rt, 'auto_pause_on_expired'), false);
  assert.equal(rt.concurrency, 50);
  assert.equal(rt.priority, 1);
  assert.equal(rt.load_factor, 1000);
  assert.equal(rt.extra.codex_fingerprint_mode, 'session');
  assert.equal(rt.rate_multiplier, 1);
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
  const expiresAt = 1_780_000_000;
  const accessOnly = buildSub2ApiAccount({
    access_token: jwt({
      exp: expiresAt,
      sub: 'user-access-only',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acc-access-only',
        organizations: [
          { id: 'org-first', is_default: false },
          { id: 'org-default', is_default: true },
        ],
      },
    }),
    email: 'access-only@example.com',
    account_id: 'acc-access-only',
  });
  assert.equal(assertSub2ApiAccountShape(accessOnly, { requireRefreshToken: false }), 'access-token');
  assert.equal(accessOnly.credentials.expires_at, '2026-05-28T20:26:40Z');
  assert.equal(accessOnly.credentials.organization_id, 'org-default');
  assert.equal(accessOnly.expires_at, expiresAt);
  assert.equal(accessOnly.auto_pause_on_expired, true);
  for (const field of ['refresh_token', 'id_token', 'client_id', 'expires_in', 'account_id']) {
    assert.equal(Object.hasOwn(accessOnly.credentials, field), false, `${field} should be omitted`);
  }
}

{
  assert.throws(() => buildSub2ApiAccount({
    access_token: jwt({
      exp: 1_780_000_000,
      'https://api.openai.com/auth': { chatgpt_account_id: 'access-account' },
    }),
    id_token: jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'id-account' },
    }),
    refresh_token: 'secret-refresh-token',
    account_id: 'stored-account',
  }), error => {
    assert.match(error.message, /account_id.*不一致/);
    assert.doesNotMatch(error.message, /secret-refresh-token|access-account|id-account|stored-account/);
    return true;
  });
}

{
  assert.throws(() => buildSub2ApiAccount({
    access_token: jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'access-only-without-expiry' },
    }),
    account_id: 'access-only-without-expiry',
  }), /缺少.*过期时间/);
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
