import assert from 'node:assert/strict';
import test from 'node:test';

import { createCredentialExportService } from '../src/services/auth/credential-export-service.js';

test('refresh rejection reports only allowlisted metadata and never echoes provider secrets', async () => {
  const responseSecret = 'provider-echoed-refresh-secret';
  const requestSecret = 'stored-refresh-secret';
  const logs = [];
  const service = createCredentialExportService({
    AUTH_OAUTH_TOKEN_URLS: ['https://auth.openai.com/oauth/token'],
    fetch: async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        error: 'invalid_grant',
        error_description: `rejected ${responseSecret}`,
        refresh_token: requestSecret,
      }),
    }),
  });

  await assert.rejects(
    service.refreshOpenAIRecordFromRt(
      { email: 'user@example.com', openai_rt: requestSecret },
      (message) => logs.push(message),
    ),
    error => {
      assert.match(error.message, /HTTP 400/);
      assert.match(error.message, /invalid_grant/);
      assert.doesNotMatch(error.message, new RegExp(responseSecret));
      assert.doesNotMatch(error.message, new RegExp(requestSecret));
      return true;
    },
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0], /invalid_grant/);
  assert.doesNotMatch(logs[0], new RegExp(responseSecret));
  assert.doesNotMatch(logs[0], new RegExp(requestSecret));
});

test('refresh network errors are redacted and fall through to the next token endpoint', async () => {
  const endpointSecret = 'endpoint-query-secret';
  const networkSecret = 'network-error-secret';
  const urls = [
    `https://user:password@first.example/oauth/token?secret=${endpointSecret}`,
    'https://second.example/oauth/token',
  ];
  const calls = [];
  const logs = [];
  const service = createCredentialExportService({
    AUTH_OAUTH_TOKEN_URLS: urls,
    fetch: async (url, options) => {
      calls.push(url);
      assert.equal(options.headers.originator, 'codex_cli_rs');
      if (url === urls[0]) throw new Error(`${networkSecret} ${urls[0]}`);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'new-access-token' }),
      };
    },
    normalizeOpenAIRecordFromRefreshPayload: () => ({ ok: true }),
  });

  assert.deepEqual(
    await service.refreshOpenAIRecordFromRt(
      { email: 'user@example.com', openai_rt: 'stored-refresh-token' },
      (message) => logs.push(message),
    ),
    { ok: true },
  );
  assert.deepEqual(calls, urls);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /endpoint=https:\/\/first\.example\/oauth\/token network_error/);
  assert.match(logs[1], /https:\/\/second\.example\/oauth\/token/);
  assert.doesNotMatch(logs.join('\n'), /user|password|endpoint-query-secret|network-error-secret/);
});
