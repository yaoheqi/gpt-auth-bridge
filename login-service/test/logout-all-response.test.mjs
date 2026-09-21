import assert from 'node:assert/strict';
import test from 'node:test';
import { readLogoutAllResponse } from '../src/services/logout-all-response.js';
import { needsSessionReauthentication } from '../src/services/cached-web-session.js';

test('logout accepts empty, null, boolean, text and JSON success acknowledgments', async () => {
  for (const [status, body, responseType] of [
    [200, '', 'empty'], [200, ' \n ', 'empty'], [204, null, 'empty'],
    [200, 'null', 'json-null'], [200, 'true', 'json-boolean'], [200, 'OK', 'text'],
    [200, 'success', 'text'], [200, '"ok"', 'json-string'],
    [200, '{}', 'json-object'], [200, '{"success":true}', 'json-object'], [200, '{"ok":true}', 'json-object'],
  ]) {
    assert.deepEqual(await readLogoutAllResponse(new Response(body, { status })), { status, responseType });
  }
});

test('logout rejects negative acknowledgments, redirects, challenges and unknown payloads without leaking bodies', async () => {
  for (const [status, body, headers] of [
    [200, 'false'], [200, '{"success":false}'], [200, '{"ok":false}'],
    [200, '{"success":true,"error":{"message":"private-fixture"}}'],
    [200, '<html>private-fixture</html>'], [200, 'OK', { 'content-type': 'text/html' }],
    [200, 'private-fixture'], [200, '"private-fixture"'], [200, '42'], [200, '[]'],
    [200, '{"private":"private-fixture"}'], [302, ''], [429, 'private-fixture'], [500, 'null'],
  ]) {
    await assert.rejects(readLogoutAllResponse(new Response(body, { status, headers })), error => {
      assert.equal(error.status, status);
      assert.equal(needsSessionReauthentication(error), false);
      assert.doesNotMatch(error.message, /private-fixture/);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      return true;
    });
  }
});

test('logout preserves explicit authentication rejection for one cached-session fallback', async () => {
  await assert.rejects(readLogoutAllResponse(Response.json({ error: { code: 'token_invalidated', message: 'private-fixture' } }, { status: 401 })), error => {
    assert.equal(error.code, 'token_invalidated');
    assert.equal(needsSessionReauthentication(error), true);
    assert.doesNotMatch(error.message, /private-fixture/);
    return true;
  });
});
