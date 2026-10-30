import assert from 'node:assert/strict';
import test from 'node:test';
import * as urls from '../lib/openai-auth-urls.js';
import * as oauth from '../lib/openai-oauth.js';
import { createOpenAIJsonAuthFlow } from '../src/services/auth/openai-json-auth-flow.js';
import { createWorkspaceAuthService } from '../src/services/auth/workspace-auth-service.js';
import { runProtocolLoginPipelineAccount } from '../src/services/protocol-login-pipeline.js';

const jwt = value => `header.${Buffer.from(JSON.stringify(value)).toString('base64url')}.signature`;
const consent = `${urls.AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`;

for (const hasStoredWebSession of [false, true]) {
  test(`all-workspace entry authenticates directly with Codex and reuses that login (stored Web Session: ${hasStoredWebSession})`, async () => {
    const account = { id: 'fixture', email: 'fixture@example.com', password: 'fixture-password', two_factor_secret: 'JBSWY3DPEHPK3PXP',
      ...(hasStoredWebSession ? { session_access_token: 'old-web-token', storage_state_json: JSON.stringify({ cookies: [
        { name: 'old-web-cookie', value: 'must-not-be-used', domain: 'auth.openai.com', path: '/' },
      ] }) } : {}) };
    const requests = [], states = [], challenges = [], saved = [], logs = [], transports = [];
    let oauthState, selected, preflights = 0;
    const transport = async (address, init = {}) => {
      const url = new URL(address);
      requests.push(url.pathname);
      assert.equal(url.origin, urls.AUTH_BASE_URL, 'RT flow must never contact ChatGPT Web');
      assert.doesNotMatch(String(init.headers?.cookie || ''), /must-not-be-used|old-web-cookie/);
      let status = 200, headers = {}, body = '';
      if (url.pathname === '/oauth/authorize') {
        assert.equal(url.searchParams.get('redirect_uri'), oauth.OPENAI_CODEX_REDIRECT_URI);
        assert.equal(url.searchParams.get('client_id'), oauth.OPENAI_CODEX_CLIENT_ID);
        oauthState = url.searchParams.get('state');
        states.push(oauthState);
        challenges.push(url.searchParams.get('code_challenge'));
        if (states.length === 1) {
          assert.equal(url.searchParams.get('prompt'), 'login');
          headers = { location: '/log-in', 'set-cookie': 'oai-did=fixture-device; Path=/; Secure' };
        } else {
          assert.ok(!url.searchParams.get('prompt'));
          assert.match(String(init.headers.cookie), /codex-login=verified/);
          headers = { location: consent };
        }
        status = 302;
      } else if (url.href === urls.AUTH_AUTHORIZE_CONTINUE_URL) {
        assert.equal(JSON.parse(init.body).username.value, account.email);
        body = JSON.stringify({ continue_url: '/log-in/password', page: { type: 'login_password' } });
      } else if (url.href === urls.AUTH_PASSWORD_VERIFY_URL) {
        assert.equal(JSON.parse(init.body).password, account.password);
        body = JSON.stringify({ page: { type: 'mfa_challenge', payload: { factor_id: 'fixture-factor' } } });
      } else if (url.href === urls.AUTH_MFA_VERIFY_URL) {
        assert.match(JSON.parse(init.body).code, /^\d{6}$/);
        headers = { 'set-cookie': 'codex-login=verified; Path=/; Secure' };
        body = JSON.stringify({ continue_url: consent });
      } else if (url.href === consent) {
        body = `<script type="application/json">${JSON.stringify({ loaderData: { clientAuthSession: { workspaces: [
          { id: 'personal', kind: 'personal' }, { id: 'team-one', kind: 'business' }, { id: 'team-two', kind: 'business' },
        ] } } })}</script>`;
      } else if (url.href === urls.AUTH_WORKSPACE_SELECT_URL) {
        selected = JSON.parse(init.body).workspace_id;
        body = JSON.stringify({ continue_url: `${oauth.OPENAI_CODEX_REDIRECT_URI}?code=${selected}&state=${oauthState}` });
      } else if (url.pathname === '/oauth/token') {
        assert.equal(new URLSearchParams(init.body).get('code'), selected);
        body = JSON.stringify({ access_token: jwt({ exp: 2_000_000_000, 'https://api.openai.com/auth': { chatgpt_account_id: selected } }),
          refresh_token: `rt-${selected}`, id_token: jwt({ email: account.email }) });
      } else assert.ok(['/log-in', '/mfa-challenge/fixture-factor'].includes(url.pathname), `Unexpected auth request: ${url.pathname}`);
      const response = new Response(body, { status, headers });
      Object.defineProperty(response, 'url', { value: address });
      return response;
    };
    const Flow = createOpenAIJsonAuthFlow({
      AUTH_OAUTH_TOKEN_URLS: [`${urls.AUTH_BASE_URL}/oauth/token`],
      createAccountSessionDeviceAndProxy: () => ({ fingerprint: {}, proxy: { mode: 'direct', proxyUrl: '', label: 'fixture' } }),
      createCurlCffiFetch: () => {
        const fetcher = Object.assign((...args) => transport(...args), { dispose: async () => { fetcher.disposed = true; } });
        transports.push(fetcher);
        return fetcher;
      },
      createSmsBowerClient: () => ({}), getSmsProviderLabel: () => 'fixture', normalizePhoneMode: value => value,
      getPhoneOtpWaitTimeoutMs: () => 1000, getProtocolHumanTiming: () => ({}),
      buildBrowserHeaders: headers => headers, summarizeFingerprint: () => 'fixture',
      fetchOpenAISentinelToken: async () => 'fixture-validation',
      preflightProxyEgress: async () => { preflights++; return { status: 200, latencyMs: 1 }; },
    });
    const service = createWorkspaceAuthService({ OpenAIJsonAuthFlow: Flow, accountRequestNetwork: () => ({}),
      accountRepository: { updateById: async (_id, patch) => assert.ok(JSON.parse(patch.storage_state_json).cookies.length) },
      persistOpenAIAuthResult: async (_id, record) => saved.push(record.account_id),
      persistBusinessCodexAuthResult: async (_id, record, workspaceId) => { assert.equal(record.account_id, workspaceId); saved.push(workspaceId); },
    });
    const result = await runProtocolLoginPipelineAccount(account, { workspaceMode: 'all',
      runSessionLogin: () => assert.fail('must not run the Web Session service'),
      runAllWorkspaces: service.runAllWorkspaceCodexAuthForAccount,
      hooks: { log: entry => logs.push(entry.msg) },
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.sessionOk, false);
    assert.equal(result.businessSuccess, 2);
    assert.deepEqual(saved, ['personal', 'team-one', 'team-two']);
    assert.equal(requests[0], '/oauth/authorize');
    assert.equal(requests.filter(path => path === new URL(urls.AUTH_PASSWORD_VERIFY_URL).pathname).length, 1);
    assert.equal(requests.filter(path => path === new URL(urls.AUTH_MFA_VERIFY_URL).pathname).length, 1);
    assert.equal(new Set(states).size, 3);
    assert.equal(new Set(challenges).size, 3);
    assert.equal(preflights, 1);
    assert.ok(transports.every(item => item.disposed));
    assert.doesNotMatch(logs.join('\n'), /接码完成|阶段2\/2|ChatGPT Web：/);
  });
}
