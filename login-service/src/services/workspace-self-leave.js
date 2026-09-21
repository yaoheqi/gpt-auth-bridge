import { setTimeout as delay } from 'node:timers/promises';
import { CHATGPT_BASE_URL, CHATGPT_ACCOUNTS_CHECK_URL } from '../../lib/openai-auth-urls.js';
import { decodeJwtPayload } from '../../lib/jwt-utils.js';
import { protocolLoginCredentialIssue } from '../domain/accounts/account-domain.js';
import { terminalLoginFailure } from './monitor-coordinator.js';
import { sanitizeLogMessage } from '../../lib/log-sanitize.js';

const authClaims = token => decodeJwtPayload(token)['https://api.openai.com/auth'] || {};
const emailKey = value => String(value || '').trim().toLowerCase();
const authenticationFailure = error => [401, 403].includes(error?.status);
const validToken = token => Boolean(token && Number(decodeJwtPayload(token).exp || 0) * 1000 > Date.now() + 30_000);
const ownEmail = token => {
  const claims = decodeJwtPayload(token);
  return emailKey(claims.email || claims['https://api.openai.com/profile']?.email);
};

export function selfLeaveIdentity(token, workspaceId, email, expectedUserId = '') {
  const auth = authClaims(token);
  const userId = String(auth.chatgpt_user_id || '').trim();
  if (String(auth.chatgpt_account_id || '') !== workspaceId) throw new Error('自踢令牌与目标工作区不匹配，已停止');
  if (!userId || (expectedUserId && userId !== expectedUserId)) throw new Error('无法核实当前账号的成员 ID，已停止自踢');
  if (ownEmail(token) && ownEmail(token) !== emailKey(email)) throw new Error('自踢令牌与输入邮箱不匹配，已停止');
  return userId;
}

function workspaceCatalog(payload) {
  if (!payload?.accounts || typeof payload.accounts !== 'object' || Array.isArray(payload.accounts) || !Object.keys(payload.accounts).length) throw new Error('工作区列表格式异常，无法确认成员身份');
  return Object.entries(payload.accounts).map(([key, row]) => {
    if (!row?.account || typeof row.account !== 'object') throw new Error('工作区列表不完整，已停止自踢');
    const account = row.account;
    const plan = String(account.plan_type || '').trim().toLowerCase();
    const structure = String(account.structure || '').trim().toLowerCase();
    const role = String(account.account_user_role || '').trim().toLowerCase();
    // Structure describes membership; billing plans can include values such as
    // self_serve_business_prolite and must not be used as a team allowlist.
    const kind = structure === 'personal' ? 'personal'
      : ['workspace', 'organization', 'team', 'business', 'enterprise'].includes(structure) ? 'team'
      : !structure && ['team', 'business', 'enterprise'].includes(plan) ? 'team'
      : !structure && ['free', 'plus', 'pro'].includes(plan) ? 'personal' : 'unknown';
    return { id: String(account.account_id || account.id || key), plan, structure, role, kind, deactivated: Boolean(account.is_deactivated) };
  });
}

// Never infer success from a partial page or from loss of access to the member list.
async function readMemberSnapshot(request, token, workspaceId) {
  const members = new Map();
  let total;
  for (let offset = 0; offset < 10_000; offset += 100) {
    const data = await request(`/backend-api/accounts/${encodeURIComponent(workspaceId)}/users?offset=${offset}&limit=100&query=`, token, workspaceId);
    const rows = data?.items ?? data?.users;
    const count = data?.total ?? data?.total_count;
    if (!Array.isArray(rows) || !Number.isSafeInteger(count) || count < 0 || (total !== undefined && total !== count)) throw new Error('成员快照不完整，无法确认退出结果');
    total = count;
    for (const row of rows) {
      const id = typeof row?.id === 'string' ? row.id.trim() : '';
      const email = row?.email ?? row?.email_address;
      if (!id || (email != null && typeof email !== 'string')) throw new Error('成员快照缺少 ID 或邮箱格式异常');
      // Some members have email:null. Keep their ID in pagination and presence
      // checks; only the target member needs a verified match to this account.
      members.set(id, { id, email: emailKey(email), role: String(row.role || '').trim().toLowerCase() });
    }
    if (offset + rows.length >= total) {
      if (members.size !== total) throw new Error('成员快照覆盖不完整，无法确认退出结果');
      return [...members.values()];
    }
    if (rows.length !== 100) throw new Error('成员分页不完整，无法确认退出结果');
  }
  throw new Error('成员数量超过复核上限，无法确认退出结果');
}

export function clearedWorkspaceCredentials(account, workspaceIds) {
  const left = new Set(workspaceIds);
  const patch = { business_workspace_credentials: (account.business_workspace_credentials || []).filter(row => !left.has(String(row.workspaceId))),
    business_join_requests: (account.business_join_requests || []).filter(row => !left.has(String(row.workspaceId))),
    // Workspace membership in auth cookies is now stale; the next login must rediscover it.
    storage_state_json: '' };
  if (left.has(String(account.business_workspace_id)) || left.has(String(account.business_openai_account_id))) {
    Object.assign(patch, { business_workspace_id: '', business_join_status: 'none', business_join_error: '',
      business_openai_rt: '', business_openai_access_token: '', business_openai_id_token: '', business_openai_account_id: '', business_openai_token_expires_at: 0 });
  }
  if (left.has(String(authClaims(account.session_access_token).chatgpt_account_id))) Object.assign(patch, { session_access_token: '', session_json: '' });
  if (left.has(String(authClaims(account.openai_access_token).chatgpt_account_id))) Object.assign(patch, { openai_access_token: '', openai_rt: '', openai_id_token: '', openai_account_id: '' });
  return patch;
}

export async function selfLeaveWorkspaces(account, { flow, signal, onLog = () => {}, persist = async () => {}, wait = ms => delay(ms, undefined, { signal }) }) {
  const issue = protocolLoginCredentialIssue(account);
  if (issue) throw new Error(issue);
  const log = msg => onLog({ msg });
  let authenticated = false;
  const request = async (path, token, workspaceId = '', method = 'GET') => {
    signal?.throwIfAborted();
    await flow.ensureChatGptDeviceCookie();
    const response = await flow.fetch(new URL(path, CHATGPT_BASE_URL).href, { method, redirect: 'manual', signal,
      headers: flow.chatgptBackendHeaders(token, path.split('?')[0], {
        referer: `${CHATGPT_BASE_URL}/admin/members`, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
        priority: 'u=1, i', ...(workspaceId ? { 'chatgpt-account-id': workspaceId } : {}),
      }) });
    const text = await response.text();
    if (!response.ok) throw Object.assign(new Error(`工作区${method === 'DELETE' ? '自踢' : '查询'} HTTP ${response.status}`), { status: response.status });
    if (!text && method === 'DELETE') return {};
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error('工作区接口未返回 JSON，无法确认结果'); }
    if (!payload || payload.error || payload.success === false) throw new Error('工作区接口返回失败，无法确认结果');
    return payload;
  };
  let catalogToken = [account.openai_access_token, account.session_access_token].find(validToken) || '';
  if (catalogToken && ownEmail(catalogToken) && ownEmail(catalogToken) !== emailKey(account.email)) throw new Error('已保存令牌与输入邮箱不匹配');
  const login = async workspaceId => {
    signal?.throwIfAborted();
    await flow.ensureProxyConnectivity();
    log(workspaceId ? `授权工作区 ${workspaceId}，优先复用已保存 Cookie` : '获取工作区列表，优先复用已保存 Cookie');
    flow.workspaceSelection = workspaceId ? { mode: 'id', workspaceId } : { mode: 'personal' };
    const record = await flow.loginCodexWithPhone({ preserveAuthSession: authenticated });
    authenticated = true;
    if (!record?.access_token) throw new Error('协议登录未返回工作区访问令牌');
    return record.access_token;
  };
  let catalog;
  if (catalogToken) {
    try { catalog = workspaceCatalog(await request(CHATGPT_ACCOUNTS_CHECK_URL, catalogToken)); }
    catch (error) { if (!authenticationFailure(error)) throw error; }
  }
  if (!catalog) {
    catalogToken = await login();
    catalog = workspaceCatalog(await request(CHATGPT_ACCOUNTS_CHECK_URL, catalogToken));
  }
  const userId = String(authClaims(catalogToken).chatgpt_user_id || '');
  const workspaces = catalog.filter(row => row.kind !== 'personal');
  const unknown = workspaces.filter(row => row.kind === 'unknown').length;
  log(`发现 ${workspaces.length - unknown} 个团队工作区${unknown ? `，${unknown} 个类型待核实` : ''}，逐个核实并退出`);
  const results = [];
  const left = [];
  let terminalReason = '';
  for (const workspace of workspaces) {
    signal?.throwIfAborted();
    const workspaceId = workspace.id;
    if (workspace.kind === 'unknown') {
      results.push({ workspaceId, status: 'failed', reason: '工作区类型无法确认，已停止自踢' });
      log(`工作区 ${workspaceId} 类型无法确认，已停止自踢`);
      continue;
    }
    if (workspace.role === 'owner' || workspace.deactivated || !['standard-user', 'member', 'admin'].includes(workspace.role)) {
      results.push({ workspaceId, status: 'skipped', reason: workspace.role === 'owner' ? 'owner 工作区不自退' : '角色不明确或工作区已停用' });
      log(`跳过工作区 ${workspaceId}：${results.at(-1).reason}`);
      continue;
    }
    let deleteAccepted = false;
    let deleteUncertain = false;
    try {
      let token = (account.business_workspace_credentials || []).find(row => row.workspaceId === workspaceId)?.accessToken || '';
      if (!validToken(token)) token = [catalogToken, account.session_access_token, account.openai_access_token, account.business_openai_access_token]
        .find(value => validToken(value) && String(authClaims(value).chatgpt_account_id || '') === workspaceId) || '';
      if (!validToken(token)) token = await login(workspaceId);
      let memberId = selfLeaveIdentity(token, workspaceId, account.email, userId);
      const snapshot = async () => readMemberSnapshot(request, token, workspaceId);
      // A readable snapshot gives the exact endpoint member ID, which can differ from the JWT user ID.
      try {
        const own = (await snapshot()).filter(row => row.id === memberId || row.email === emailKey(account.email));
        if (own.length !== 1) throw new Error('成员快照不能唯一定位本账号，已停止自踢');
        if (own[0].email && own[0].email !== emailKey(account.email)) throw new Error('成员 ID 与输入邮箱不匹配，已停止自踢');
        if (own[0].role === 'owner') { results.push({ workspaceId, status: 'skipped', reason: 'owner 工作区不自退' }); continue; }
        memberId = own[0].id;
      } catch (error) { if (!authenticationFailure(error)) throw error; }
      let reauthenticated = false;
      const retries = { 409: 0, 429: 0 };
      while (true) {
        try {
          deleteUncertain = true;
          await request(`/backend-api/accounts/${encodeURIComponent(workspaceId)}/users/${encodeURIComponent(memberId)}`, token, workspaceId, 'DELETE');
          deleteAccepted = true;
          deleteUncertain = false;
          break;
        } catch (error) {
          // A transport failure after sending DELETE may already have changed membership.
          if (error.status) deleteUncertain = false;
          if ([409, 429].includes(error.status) && retries[error.status] < 3) {
            const attempt = ++retries[error.status];
            const reason = error.status === 429 ? '限流（HTTP 429）' : '冲突';
            log(`工作区 ${workspaceId} ${reason}，${attempt * 5} 秒后重试（${attempt}/3）`);
            await wait(attempt * 5000);
            continue;
          }
          if (authenticationFailure(error) && !reauthenticated) {
            reauthenticated = true;
            authenticated = false;
            token = await login(workspaceId);
            selfLeaveIdentity(token, workspaceId, account.email, userId);
            continue;
          }
          throw error;
        }
      }
      let verified = false;
      let snapshotReadable = false;
      try {
        const current = await snapshot();
        snapshotReadable = true;
        verified = !current.some(row => row.id === memberId || row.id === authClaims(token).chatgpt_user_id || row.email === emailKey(account.email));
      } catch { /* A successful self-exit may revoke access to the members endpoint. */ }
      if (!verified && !snapshotReadable) {
        // No owner token is available: a complete list of this user's memberships can also confirm absence.
        try { verified = !workspaceCatalog(await request(CHATGPT_ACCOUNTS_CHECK_URL, catalogToken)).some(row => row.id === workspaceId); }
        catch { /* A 401/403 is never treated as evidence of successful exit. */ }
      }
      signal?.throwIfAborted();
      if (verified) {
        left.push(workspaceId);
        await persist(clearedWorkspaceCredentials(account, left));
        results.push({ workspaceId, status: 'left' });
        log(`工作区 ${workspaceId} 已自退，复核通过`);
      } else {
        results.push({ workspaceId, status: 'unconfirmed', reason: '退出请求已接受，成员变化尚未确认；请在 ChatGPT 核对' });
        log(`工作区 ${workspaceId} 已提交退出，待确认`);
      }
    } catch (error) {
      signal?.throwIfAborted();
      const uncertain = deleteAccepted || deleteUncertain;
      const reason = sanitizeLogMessage(error.message);
      results.push({ workspaceId, status: uncertain ? 'unconfirmed' : 'failed', reason });
      log(`工作区 ${workspaceId} ${uncertain ? '待确认' : '失败'}：${reason}`);
      terminalReason = terminalLoginFailure(error);
      if (terminalReason) {
        for (const remaining of workspaces.slice(workspaces.indexOf(workspace) + 1)) results.push({ workspaceId: remaining.id, status: 'skipped', reason: '账号凭据错误，停止后续自踢' });
        break;
      }
    }
  }
  return { ok: results.every(row => ['left', 'skipped'].includes(row.status)), workspaces: results,
    ...(terminalReason ? { terminalReason } : {}),
    left: results.filter(row => row.status === 'left').length,
    skipped: results.filter(row => row.status === 'skipped').length,
    unconfirmed: results.filter(row => row.status === 'unconfirmed').length,
    failed: results.filter(row => row.status === 'failed').length };
}
