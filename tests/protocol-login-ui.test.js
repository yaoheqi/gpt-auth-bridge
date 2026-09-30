import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import test from 'node:test';
import { createAuthNetworkPolicy } from '../login-service/src/services/auth/network-policy.js';

test('protocol requests expose direct, local and custom pool modes', async () => {
  const { protocolRequestNetwork: network } = createAuthNetworkPolicy();
  assert.equal(network({ browserState: {} }).proxyPool, '');
  assert.equal(network({ proxyMode: 'direct', proxyPool: 'custom.example:3000' }).proxyPool, '');
  assert.equal(network({ proxyMode: 'local', localProxyPort: 8899 }).proxyPool, 'http://127.0.0.1:8899');
  assert.throws(() => network({ proxyMode: 'local', localProxyPort: 70000 }), /端口必须是 1-65535/);
  assert.equal(network({ proxyMode: 'pool', proxyPool: 'custom.example:3000' }).proxyPool, 'custom.example:3000');
  assert.deepEqual(network({ proxyMode: 'builtin' }), { proxyPool: undefined, directWhenProxyPoolEmpty: false });
});

test('format toolbar only exposes the conversion format tabs', async () => {
  const source = (await Promise.all(['index.html', 'app.js'].map(file => fs.readFile(path.join(__dirname, '..', 'docs', file), 'utf8')))).join('\n');
  const start = source.indexOf('<div class="segmented" id="format-list"');
  const end = source.indexOf('</div>', start);
  const toolbar = source.slice(start, end);
  const formats = [...toolbar.matchAll(/data-format="([^"]+)"/g)].map(match => match[1]);

  assert.deepEqual(formats, ['sub2api', 'cpa', 'cockpit', 'codex']);
  assert.doesNotMatch(source, /formatScrollPrev|formatScrollNext|scrollFormatList/);
  assert.doesNotMatch(source, /id="account-center"|id="account-auth-form"|账号重登与批量测活/);
  assert.doesNotMatch(source, /login-proxy-access-key|LOGIN_PROXY_ACCESS_KEY/);
});

test('protocol login UI uses the unified Session and RT pipeline', async () => {
  const source = (await Promise.all(['index.html', 'app.js'].map(file => fs.readFile(path.join(__dirname, '..', 'docs', file), 'utf8')))).join('\n');
  const start = source.indexOf('async function startProtocolLogin');
  const end = source.indexOf('async function exportLoginSub2api', start);
  const workflow = source.slice(start, end);

  assert.match(workflow, /\/api\/v2\/accounts\/protocol-login-pipeline/);
  assert.match(workflow, /账号已导入，等待并发队列调度/);
  assert.match(workflow, /账号级并发/);
  assert.match(workflow, /workspaceMode/);
  assert.doesNotMatch(workflow, /proxyPool:\s*""/);
  assert.match(workflow, /state\.loginSessionIds/);
  assert.match(workflow, /state\.loginPersonalIds/);
  assert.match(workflow, /state\.loginBusinessIds/);
  assert.doesNotMatch(workflow, /\/api\/v2\/accounts\/protocol-login"/);
  assert.doesNotMatch(workflow, /\/api\/v2\/accounts\/codex-auth/);
  assert.doesNotMatch(workflow, /business-join\/convert-rt/);
  assert.match(workflow, /prepareRegistrationAssets:\s*false/);
  assert.match(workflow, /\bconcurrency\b/);
  assert.match(source, /id="task-concurrency-value"/);
  assert.doesNotMatch(source, /<input[^>]*id="login-concurrency"/);
  assert.doesNotMatch(workflow, /Math\.min\(20/);
  assert.match(workflow, /pipeline\.concurrency \|\| concurrency/);
});

test('protocol login UI uses the shared account parser', async () => {
  const source = (await Promise.all(['index.html', 'app.js'].map(file => fs.readFile(path.join(__dirname, '..', 'docs', file), 'utf8')))).join('\n');

  assert.match(source, /function splitLoginAccount\(line\)/);
  assert.match(source, /账号----密码----2fa、账号---密码---2fa 或 账号--密码--2fa/);
  assert.match(source, /return splitPasswordTotpLine\(line\)/);
  assert.match(source, /const parts = splitLoginAccount\(line\)/);
});

test('protocol login UI exposes Session and all-workspace RT modes with Sub2 push', async () => {
  const source = (await Promise.all(['index.html', 'app.js'].map(file => fs.readFile(path.join(__dirname, '..', 'docs', file), 'utf8')))).join('\n');
  const start = source.indexOf('async function startProtocolLogin');
  const pushStart = source.indexOf('async function exportLoginSub2api', start);
  const end = source.indexOf('async function copyOutput', pushStart);
  const workflow = source.slice(start, end);

  assert.match(source, /<input type="radio" name="login-workspace-mode" value="session" \/>仅协议登录/);
  assert.doesNotMatch(source, /<option value="personal">/);
  assert.match(source, /<input type="radio" name="login-workspace-mode" value="all" checked \/>全部工作区 RT/);
  assert.match(source, /id="login-proxy-mode"/);
  assert.match(source, /name="login-proxy-mode" value="local"[^>]*\/>本地代理/);
  assert.doesNotMatch(source, /内置代理池|value="builtin"/);
  assert.match(source, /id="login-proxy-local-port"/);
  assert.match(source, /id="login-proxy-pool"/);
  assert.match(source, /配置只保存在当前浏览器/);
  assert.match(source, /id="export-login-sessions"[^>]*>下载 Session TXT<\/button>/);
  assert.match(source, /id="export-login-personal"[^>]*>下载个人 sub2api<\/button>/);
  assert.match(source, /id="export-login-business"[^>]*>下载 Business sub2api<\/button>/);
  assert.doesNotMatch(workflow, /proxyPool:\s*""/);
  assert.match(workflow, /workspaceMode/);
  assert.match(workflow, /workspaceMode !== "session"/);
  assert.match(workflow, /\/api\/v2\/accounts\/export-sessions/);
  assert.match(workflow, /chatgpt-sessions\.\$\{getTimestampToken\(\)\}\.txt/);
  assert.match(workflow, /全部流程完成：成功 \$\{pipeline\.success \|\| 0\}/);
});

test('protocol workflow applies one stable request proxy per account and explicit empty pool direct mode', async () => {
  const server = await fs.readFile(path.join(__dirname, '..', 'login-service', 'server.js'), 'utf8');
  const proxy = await fs.readFile(path.join(__dirname, '..', 'login-service', 'lib', 'proxy-config.js'), 'utf8');
  const curl = await fs.readFile(path.join(__dirname, '..', 'login-service', 'scripts', 'curl_cffi_session.py'), 'utf8');

  const { accountRequestNetwork } = createAuthNetworkPolicy({
    random: () => 0,
    proxyHealthRegistry: { choose: candidates => candidates[0] },
  });
  const selected = accountRequestNetwork({}, { proxyPool: 'http://proxy.example:3000', directWhenProxyPoolEmpty: true });
  assert.equal(selected.proxyPool, 'http://proxy.example:3000/');
  assert.equal(selected.directWhenProxyPoolEmpty, true);
  assert.deepEqual(accountRequestNetwork({}, { proxyPool: '' }), { proxyPool: '' });
  assert.match(server, /const requestScopedNetwork = network\.proxyPool !== undefined;/);
  assert.match(server, /if \(egress\) noteAccountEgressMismatch\(account, egress\);/);
  assert.match(server, /runSessionHealthCheckForAccounts\(accounts,[\s\S]*?\.\.\.requestNetwork/);
  assert.match(server, /runCodexAuthForAccounts\(accounts,[\s\S]*?\.\.\.requestNetwork/);
  assert.match(server, /runBusinessCodexAuthForAccount\(account,[\s\S]*?\.\.\.requestNetwork/);
  assert.match(proxy, /directWhenEmpty \? '' : FIXED_LOCAL_PROXY_URL/);
  assert.match(curl, /proxy = "" if direct else/);
});

test('protocol login UI exposes TOTP reset and renders the latest credentials', async () => {
  const source = (await Promise.all(['index.html', 'app.js'].map(file => fs.readFile(path.join(__dirname, '..', 'docs', file), 'utf8')))).join('\n');
  const server = await fs.readFile(path.join(__dirname, '..', 'login-service', 'server.js'), 'utf8');

  assert.match(source, /id="reset-login-totp"[^>]*>重设 2FA<\/button>/);
  assert.match(source, /id="login-reset-credentials"/);
  assert.match(source, /loginIcloudStream\("\/api\/v2\/accounts\/reset-totp"/);
  assert.match(source, /account_start/);
  assert.match(source, /account_log/);
  assert.match(source, /account_done/);
  assert.match(source, /\{ ids, concurrency, \.\.\.selectedLoginProxyNetwork\(\) \}/);
  assert.match(source, /最新账号凭据/);
  assert.match(source, /credentials\.flatMap/);
  assert.match(server, /app\.post\('\/api\/v2\/accounts\/reset-totp'/);
  // MFA Session reuse and persistence are exercised against the imported
  // production services in reset-totp-session and workspace-auth-flow tests.
});

test('protocol login UI exposes logout-all above self-leave and guards the destructive action', async () => {
  const source = (await Promise.all(['index.html', 'app.js'].map(file => fs.readFile(path.join(__dirname, '..', 'docs', file), 'utf8')))).join('\n');
  const logoutButton = source.indexOf('id="protocol-logout-all"');
  const selfLeaveButton = source.indexOf('id="self-leave-workspaces"');
  assert.ok(logoutButton >= 0 && selfLeaveButton > logoutButton);
  assert.match(source, /async function protocolLogoutAllSessions/);
  assert.match(source, /确认对输入的 \$\{lines\.length\} 个账号退出全部 ChatGPT 会话/);
  assert.match(source, /loginIcloudStream\(['"]\/api\/v2\/accounts\/protocol-logout-all['"]/);
  assert.match(source, /protocolLogoutBusy/);
  assert.match(source, /退出全部会话完成：成功/);
});

test('sub2api logout all sessions is guarded by a fresh probe and supports concurrency', async () => {
  const source = (await Promise.all(['index.html', 'app.js'].map(file => fs.readFile(path.join(__dirname, '..', 'docs', file), 'utf8')))).join('\n');
  const server = await fs.readFile(path.join(__dirname, '..', 'src', 'converter.js'), 'utf8');

  assert.match(source, /id="logout-all-sessions"[^>]*>退出全部会话<\/button>/);
  assert.match(source, /state\.health\.some\(\(item\) => item\?\.status === 200\)/);
  assert.match(source, /body: JSON\.stringify\(\{ accounts, concurrency: selectedTaskConcurrency\(\) \}\)/);
  assert.match(source, /正在退出/);
  assert.match(source, /logout-progress/);
  assert.match(server, /app|pathname === "\/api\/logout-all-sessions"/);
  assert.match(server, /withSessionTransport/);
  assert.match(server, /const concurrency = configuredTaskConcurrency\(\)/);
});
