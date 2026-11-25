import assert from 'node:assert/strict';
import test from 'node:test';

import { OPENAI_STAGES } from '../lib/account-stages.js';
import {
  normalizeOpenAIAuthRecord,
  normalizeOpenAIRecordFromRefreshPayload,
} from '../src/services/auth/auth-records.js';
import { createAuthStateService } from '../src/services/auth/auth-state-service.js';

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function accessToken(overrides = {}) {
  return jwt({
    exp: 2_000_000_000,
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'account-1',
      chatgpt_plan_type: 'plus',
    },
    ...overrides,
  });
}

test('token normalization errors never include token response secrets or decoded claims', () => {
  const secret = 'secret-refresh-token';
  assert.throws(
    () => normalizeOpenAIAuthRecord('user@example.com', { refresh_token: secret }),
    error => {
      assert.match(error.message, /access_token/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );

  const sensitiveClaim = 'sensitive-claim-value';
  assert.throws(
    () => normalizeOpenAIAuthRecord('user@example.com', {
      access_token: jwt({ exp: 2_000_000_000, private_claim: sensitiveClaim }),
      refresh_token: secret,
      id_token: jwt({ email: 'user@example.com' }),
    }),
    error => {
      assert.match(error.message, /account_id/);
      assert.doesNotMatch(error.message, new RegExp(sensitiveClaim));
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test('refresh normalization preserves fallback refresh and ID tokens when omitted by provider', () => {
  const oldIdToken = jwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
  });
  const record = normalizeOpenAIRecordFromRefreshPayload(
    'user@example.com',
    { access_token: accessToken(), expires_in: 3600 },
    'old-refresh-token',
    oldIdToken,
  );
  assert.equal(record.refresh_token, 'old-refresh-token');
  assert.equal(record.id_token, oldIdToken);
});

test('normalization rejects ID tokens from a different account generation', () => {
  const otherIdToken = jwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-2' },
  });
  assert.throws(
    () => normalizeOpenAIRecordFromRefreshPayload(
      'user@example.com',
      { access_token: accessToken(), expires_in: 3600 },
      'old-refresh-token',
      otherIdToken,
    ),
    /account_id 不一致/,
  );
});

test('normalization rejects access tokens without exp or a positive expires_in fallback', () => {
  const noExpiryAccessToken = jwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
  });
  const idToken = jwt({
    email: 'user@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
  });
  assert.throws(
    () => normalizeOpenAIAuthRecord('user@example.com', {
      access_token: noExpiryAccessToken,
      refresh_token: 'refresh-token',
      id_token: idToken,
    }),
    /缺少 exp/,
  );
  assert.throws(
    () => normalizeOpenAIRecordFromRefreshPayload(
      'user@example.com',
      { access_token: noExpiryAccessToken },
      'refresh-token',
      idToken,
    ),
    /缺少 exp/,
  );
});

test('persistOpenAIAuthResult preserves stored ID token when a refresh record omits it', async () => {
  const storedIdToken = jwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
  });
  const existing = {
    id: 'local-account',
    openai_id_token: storedIdToken,
  };
  const accountRepository = {
    async updateById(id, patch) {
      assert.equal(id, existing.id);
      const value = typeof patch === 'function' ? await patch(existing) : patch;
      Object.assign(existing, value);
      return existing;
    },
  };
  const service = createAuthStateService({
    accountRepository,
    getAllAccounts: () => [existing],
  });

  await service.persistOpenAIAuthResult(existing.id, {
    access_token: accessToken(),
    refresh_token: 'rotated-refresh-token',
    id_token: '',
    account_id: 'account-1',
  });

  assert.equal(existing.openai_id_token, storedIdToken);
  assert.equal(existing.openai_rt, 'rotated-refresh-token');
  assert.equal(existing.openai_stage, OPENAI_STAGES.RT_READY);
});

test('persistOpenAIAuthResult refuses a stored ID token from another account', async () => {
  const existing = {
    id: 'local-account',
    openai_id_token: jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-2' },
    }),
  };
  const accountRepository = {
    async updateById(_id, patch) {
      const value = typeof patch === 'function' ? await patch(existing) : patch;
      Object.assign(existing, value);
      return existing;
    },
  };
  const service = createAuthStateService({
    accountRepository,
    getAllAccounts: () => [existing],
  });

  await assert.rejects(
    service.persistOpenAIAuthResult(existing.id, {
      access_token: accessToken(),
      refresh_token: 'rotated-refresh-token',
      id_token: '',
      account_id: 'account-1',
    }),
    /account_id 不一致/,
  );
  assert.equal(existing.openai_rt, undefined);
});

test('persistOpenAIAuthResult rejects a record account that conflicts with its access token', async () => {
  const existing = { id: 'local-account' };
  const accountRepository = {
    async updateById(_id, patch) {
      const value = typeof patch === 'function' ? await patch(existing) : patch;
      Object.assign(existing, value);
      return existing;
    },
  };
  const service = createAuthStateService({
    accountRepository,
    getAllAccounts: () => [existing],
  });

  await assert.rejects(
    service.persistOpenAIAuthResult(existing.id, {
      access_token: accessToken(),
      refresh_token: 'refresh-token',
      account_id: 'different-account',
    }),
    /account_id 不一致/,
  );
  assert.equal(existing.openai_rt, undefined);
});

test('persistOpenAIAuthResult retains the expires_in fallback when the access token omits exp', async () => {
  const existing = { id: 'local-account' };
  const accountRepository = {
    async updateById(_id, patch) {
      const value = typeof patch === 'function' ? await patch(existing) : patch;
      Object.assign(existing, value);
      return existing;
    },
  };
  const service = createAuthStateService({
    accountRepository,
    getAllAccounts: () => [existing],
  });
  const expired = '2033-05-18T03:33:20.000Z';

  await service.persistOpenAIAuthResult(existing.id, {
    access_token: jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
    }),
    refresh_token: 'refresh-token',
    account_id: 'account-1',
    expired,
  });
  assert.equal(existing.openai_token_expires_at, Date.parse(expired) / 1000);
});
