// Credential projections are derived from the encrypted browser account snapshot.
// They are never saved as a second copy in the conversion input.
const text = value => String(value ?? '').trim();
const object = value => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
};

export function projectLoginAccounts(accounts = []) {
  const sources = [];
  for (const account of accounts) {
    const session = object(account.session_json);
    const email = text(account.email || session.user?.email);
    const owner = text(account.id || email);
    const add = (value, kind) => {
      if (!text(value.access_token || value.accessToken)) return;
      sources.push({ value: { ...value, email }, sourceName: `协议登录 · ${kind}`, path: `login:${owner}:${kind}` });
    };
    if (text(account.openai_access_token)) {
      add({ access_token: account.openai_access_token, refresh_token: account.openai_rt || '',
        id_token: account.openai_id_token || '', account_id: account.openai_account_id || '',
        expires_at: account.openai_token_expires_at || undefined }, '个人');
    } else {
      add({ ...session, accessToken: account.session_access_token || session.accessToken || session.access_token }, 'Session');
    }
    const workspaces = new Map();
    if (text(account.business_openai_access_token)) {
      const id = text(account.business_workspace_id || account.business_openai_account_id);
      workspaces.set(id, { workspaceId: id, accessToken: account.business_openai_access_token,
        refreshToken: account.business_openai_rt, idToken: account.business_openai_id_token,
        accountId: account.business_openai_account_id || id, expiresAt: account.business_openai_token_expires_at });
    }
    for (const workspace of account.business_workspace_credentials || []) {
      // Array entries are authoritative, including cleared or left workspaces.
      workspaces.set(text(workspace.workspaceId || workspace.workspace_id), workspace);
    }
    for (const [id, workspace] of workspaces) {
      if (workspace.status === 'left') continue;
      add({ access_token: workspace.accessToken || workspace.access_token,
        refresh_token: workspace.refreshToken || workspace.refresh_token || '',
        id_token: workspace.idToken || workspace.id_token || '',
        account_id: workspace.accountId || workspace.account_id || id, workspace_id: id,
        expires_at: workspace.expiresAt || workspace.expires_at || undefined }, `工作区 ${id}`);
    }
  }
  return sources;
}

export function sharedAccountKey(account) {
  const credentials = account?.credentials || account || {};
  return JSON.stringify([text(credentials.email || account?.email).toLowerCase(),
    text(credentials.chatgpt_account_id || credentials.account_id || credentials.workspace_id)]);
}

export function healthCredentialKey(account) {
  return JSON.stringify([text(account.email).toLowerCase(), text(account.accessToken), text(account.accountId)]);
}

export function mergeSharedAccounts(imported, loggedIn, keyOf) {
  const updates = new Map(loggedIn.map(item => [keyOf(item), item]));
  const merged = imported.map(item => updates.get(keyOf(item)) || item);
  const existing = new Set(imported.map(keyOf));
  for (const [key, item] of updates) if (!existing.has(key)) merged.push(item);
  return merged;
}

export function loginCredentialLines(accounts = []) {
  const rows = new Map();
  for (const account of accounts) {
    const email = text(account.email || account.user?.email);
    const password = text(account.openai_password || account.password);
    const secret = text(account.two_factor_secret || account.totp_secret || account.totp).replace(/[\s-]+/g, '');
    if (!email.includes('@') || !password || !/^[A-Z2-7]+=*$/i.test(secret)) continue;
    if ([email, password].some(value => /[\r\n]/.test(value))) continue;
    rows.set(email.toLowerCase(), `${email}----${password}----${secret}`);
  }
  return [...rows.values()];
}
