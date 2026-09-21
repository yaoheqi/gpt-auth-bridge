import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_HEALTH,
  classifySessionProbe,
  extractErrorCode,
  isAccountDeactivatedError,
  probeChatGptSessionAccessToken,
  shouldRequireExistingSession,
} from '../src/services/session-health-service.js';

test('classifySessionProbe marks 200 as alive', () => {
  assert.equal(classifySessionProbe({ status: 200, body: '{"id":"user"}' }), SESSION_HEALTH.ALIVE);
});

test('classifySessionProbe marks token_invalidated as session_invalid', () => {
  assert.equal(
    classifySessionProbe({
      status: 401,
      code: 'token_invalidated',
      body: '{"error":{"code":"token_invalidated"}}',
    }),
    SESSION_HEALTH.SESSION_INVALID,
  );
  assert.equal(
    classifySessionProbe({
      status: 401,
      body: 'Your authentication token has been invalidated',
    }),
    SESSION_HEALTH.SESSION_INVALID,
  );
});

test('classifySessionProbe marks account_deactivated', () => {
  assert.equal(
    classifySessionProbe({
      status: 403,
      code: 'account_deactivated',
      body: '{"error":{"code":"account_deactivated"}}',
    }),
    SESSION_HEALTH.DEACTIVATED,
  );
});

test('extractErrorCode reads nested error.code', () => {
  assert.equal(
    extractErrorCode({ error: { code: 'token_invalidated', message: 'x' } }),
    'token_invalidated',
  );
});

test('isAccountDeactivatedError matches common messages', () => {
  assert.equal(isAccountDeactivatedError('account_deactivated'), true);
  assert.equal(isAccountDeactivatedError('otp timeout'), false);
});

test('probeChatGptSessionAccessToken returns no_session without token', async () => {
  const result = await probeChatGptSessionAccessToken('');
  assert.equal(result.health, SESSION_HEALTH.NO_SESSION);
  assert.equal(result.ok, false);
});

test('probeChatGptSessionAccessToken uses fetchImpl', async () => {
  let requestInit;
  const result = await probeChatGptSessionAccessToken('tok', {
    headers: { Cookie: 'oai-did=device-1', 'x-openai-target-path': '/backend-api/me' },
    fetchImpl: async (_url, init) => {
      requestInit = init;
      return {
      status: 401,
      async text() {
        return JSON.stringify({
          error: {
            message: 'Your authentication token has been invalidated.',
            code: 'token_invalidated',
          },
        });
      },
      };
    },
  });
  assert.equal(result.health, SESSION_HEALTH.SESSION_INVALID);
  assert.equal(result.code, 'token_invalidated');
  assert.equal(requestInit.headers.Cookie, 'oai-did=device-1');
  assert.equal(requestInit.headers['x-openai-target-path'], '/backend-api/me');
});

test('shouldRequireExistingSession skips protocol-login but keeps session-health gate', () => {
  assert.equal(shouldRequireExistingSession(), true);
  assert.equal(shouldRequireExistingSession({ loginOnly: true }), false);
  assert.equal(shouldRequireExistingSession({ forceRelogin: true }), false);
});
