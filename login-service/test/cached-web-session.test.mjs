import assert from 'node:assert/strict';
import test from 'node:test';
import { withCachedWebSession, hasStoredAuthCookies } from '../src/services/cached-web-session.js';

const email = 'cached@example.com';
const token = (exp = 2100000000, owner = email) => 'e30.' + Buffer.from(JSON.stringify({ exp, email: owner })).toString('base64url') + '.fixture';
const cookieState = (expires = -1) => JSON.stringify({ cookies: [
  { name: '__Secure-next-auth.session-token.0', value: 'fixture-cookie', domain: '.chatgpt.com', path: '/', expires },
] });
function fixture(extra = {}) {
  const account = { email, session_access_token: token(), storage_state_json: cookieState(), ...extra };
  const calls = [], saved = [];
  const flow = {
    log() {},
    async importStoredCookieStorageState() { calls.push('import-cookies'); },
    async exportCookieStorageState() { return cookieState(); },
    async fetchChatGptJson(_url, options) { calls.push('cookie-session'); assert.equal(options.allowCookieAuth, true); return { accessToken: token() }; },
    async loginChatGptWebWithPasswordTotp() { calls.push('login'); return { accessToken: 'fresh-token', session: { user: { email } }, storageState: cookieState() }; },
  };
  return { account, flow, calls, saved, options: { flow, persistSession: async session => saved.push(session) } };
}

test('cached Session is validated by the action without a login or extra probe', async () => {
  const f = fixture();
  const result = await withCachedWebSession(f.account, f.options, async accessToken => {
    assert.equal(accessToken, f.account.session_access_token);
    f.calls.push('action'); return 'done';
  });
  assert.equal(result.reused, true);
  assert.equal(result.result, 'done');
  assert.deepEqual(f.calls, ['import-cookies', 'action']);
  assert.equal(result.session.session.accessToken, token());
});

test('expired or missing AT can be recovered once from a valid Web cookie', async () => {
  for (const accessToken of ['', token(1000)]) {
    const f = fixture({ session_access_token: accessToken });
    const result = await withCachedWebSession(f.account, f.options, async value => assert.equal(value, token()));
    assert.equal(result.reused, true);
    assert.deepEqual(f.calls, ['import-cookies', 'cookie-session']);
    assert.equal(f.saved.length, 1);
  }
  assert.equal(hasStoredAuthCookies({ storage_state_json: cookieState(1000) }, { webOnly: true }), false);
  assert.equal(hasStoredAuthCookies({ storage_state_json: 'broken' }), false);
  assert.equal(hasStoredAuthCookies({ storage_state_json: 'null' }), false);
  assert.equal(hasStoredAuthCookies({ storage_state_json: '{"cookies":[null]}' }), false);
});

test('absent cache uses one login, preserving that Session for later actions', async () => {
  const f = fixture({ session_access_token: '', storage_state_json: '' });
  const result = await withCachedWebSession(f.account, f.options, async value => assert.equal(value, 'fresh-token'));
  assert.equal(result.reused, false);
  assert.deepEqual(f.calls, ['import-cookies', 'login']);
  assert.equal(f.saved.length, 1);
});

test('explicit expired-session and recent-auth rejection permit exactly one fresh authentication', async () => {
  for (const failure of [{ status: 401 }, { status: 403, code: 'reauthentication_required' }]) {
    const f = fixture();
    let actions = 0;
    const result = await withCachedWebSession(f.account, f.options, async value => {
      if (++actions === 1) throw Object.assign(new Error('fixture rejection'), failure);
      assert.equal(value, 'fresh-token');
    });
    assert.equal(result.reused, false);
    assert.equal(f.flow.reuseStoredSession, false);
    assert.equal(actions, 2);
    assert.deepEqual(f.calls, ['import-cookies', 'login']);
    assert.equal(f.saved.length, 1);
  }
  const f = fixture();
  await assert.rejects(withCachedWebSession(f.account, f.options, async () => { throw Object.assign(new Error('still rejected'), { status: 401 }); }), /still rejected/);
  assert.equal(f.calls.filter(item => item === 'login').length, 1);
});

test('transient errors, terminal credentials and partially changed MFA never restart authentication', async () => {
  for (const error of [
    { status: 403 }, { status: 429 }, { status: 503 }, { code: 'ECONNRESET' },
    { status: 401, code: 'account_deleted' }, { status: 401, code: 'invalid_username_or_password' },
    { status: 401, authMutationStarted: true },
  ]) {
    const f = fixture();
    await assert.rejects(withCachedWebSession(f.account, f.options, async () => { throw Object.assign(new Error('fixture failure'), error); }));
    assert.deepEqual(f.calls, ['import-cookies']);
    assert.equal(f.saved.length, 0);
  }
});

test('mismatched token or cached profile never reaches the action or logs in', async () => {
  for (const extra of [{ session_access_token: token(2100000000, 'other@example.com') },
    { session_json: JSON.stringify({ user: { email: 'other@example.com' } }) }]) {
    const f = fixture(extra);
    await assert.rejects(withCachedWebSession(f.account, f.options, () => assert.fail()), /邮箱不匹配/);
    assert.deepEqual(f.calls, []);
  }
});
