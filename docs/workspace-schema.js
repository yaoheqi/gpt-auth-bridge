/* The durable browser model contains sources and history; output formats are derived. */
(() => {
  const SCHEMA_VERSION = 1;
  const COMPLETED_PUSH_HISTORY_LIMIT = 50;
  const DURABLE_KEYS = [
    'format', 'skipped', 'health', 'browserAccounts', 'browserSettings', 'cpaSettings',
    'pushRetry', 'pushResults', 'pushOperations', 'activePushOperationId', 'operationHistory',
    'loginLastAccounts', 'loginLastIds', 'loginSessionIds', 'loginPersonalIds', 'loginBusinessIds',
    'logoutResults', 'logoutLog', 'loginLastResponse', 'loginLastRtKind', 'loginRetry', 'accountActionRetries', 'loginProgress',
    'loginSub2Loaded', 'loginSub2KeyConfigured', 'loginSub2SelectedGroupIds', 'loginSub2AvailableGroups',
    'loginSub2AvailableProxies', 'loginSub2ProxyId', 'loginProxyMode', 'loginProxyLocalPort', 'loginProxyPool',
    'monitorLastCheckAt', 'monitorRetries', 'monitorEnabled', 'monitorOwner', 'monitorStopped', 'conversionAt',
  ];
  const ARRAY_KEYS = new Set(['skipped', 'health', 'browserAccounts', 'pushResults', 'pushOperations', 'operationHistory',
    'loginLastAccounts', 'loginLastIds', 'loginSessionIds', 'loginPersonalIds', 'loginBusinessIds',
    'logoutResults', 'logoutLog', 'loginProgress', 'loginSub2SelectedGroupIds', 'loginSub2AvailableGroups', 'loginSub2AvailableProxies']);
  const OBJECT_KEYS = new Set(['browserSettings', 'cpaSettings', 'monitorRetries', 'monitorStopped', 'accountActionRetries']);
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function invalid(message) {
    return Object.assign(new Error(message), { code: 'INVALID_WORKSPACE_SCHEMA' });
  }
  const isCompletedPush = operation => Array.isArray(operation?.items) && operation.items.length > 0
    && operation.items.every(item => item.status === 'success');
  function needsPushHistoryCompaction(operations = []) {
    return Array.isArray(operations) && (operations.filter(isCompletedPush).length > COMPLETED_PUSH_HISTORY_LIMIT
      || operations.some(operation => operation.items?.some(item => item.status === 'success' && Object.hasOwn(item, 'account'))));
  }
  function compactPushOperations(operations = []) {
    const completed = operations.map((operation, index) => ({ operation, index })).filter(({ operation }) => isCompletedPush(operation))
      .sort((left, right) => Number(right.operation.updatedAt || right.operation.startedAt || 0) - Number(left.operation.updatedAt || left.operation.startedAt || 0) || right.index - left.index);
    const removed = new Set(completed.slice(COMPLETED_PUSH_HISTORY_LIMIT).map(({ index }) => index));
    return operations.filter((_, index) => !removed.has(index)).map(operation => ({
      ...operation,
      items: operation.items.map((item, index) => {
        if (item.status !== 'success') return item;
        const account = item.account || {};
        const credentials = account.credentials || account.tokens || account;
        const previous = item.identity || {};
        const identity = Object.fromEntries(Object.entries({
          email: previous.email || credentials.email || account.email || account.user?.email,
          accountId: previous.accountId || credentials.chatgpt_account_id || credentials.account_id || account.account_id,
          workspaceId: previous.workspaceId || credentials.workspace_id || account.workspace_id,
        }).filter(([, value]) => value != null && value !== '').map(([key, value]) => [key, String(value)]));
        // Successful entries need identity and outcome only. Keep full payloads
        // for every unresolved/failed entry, including inside mixed operations.
        return { itemId: String(item.itemId ?? index), name: String(item.name || identity.email || ''),
          status: 'success', retryable: false, attempts: Number(item.attempts || 0), identity,
          ...(item.disabled ? { disabled: true } : {}) };
      }),
    }));
  }
  function serialize(snapshot) {
    if (!record(snapshot) || !record(snapshot.state)) throw invalid('浏览器数据格式无效，请先导出或清空数据');
    const source = snapshot.state;
    const state = {};
    for (const key of DURABLE_KEYS) {
      if (!Object.hasOwn(source, key)) continue;
      const value = key === 'loginProgress' && source[key] instanceof Map ? [...source[key]] : source[key];
      if (ARRAY_KEYS.has(key) && !Array.isArray(value)) throw invalid(`浏览器数据 ${key} 格式无效`);
      if (OBJECT_KEYS.has(key) && !record(value)) throw invalid(`浏览器数据 ${key} 格式无效`);
      state[key] = value;
    }
    // Login summaries are identity/history, never another copy of account credentials.
    if (state.loginLastAccounts) state.loginLastAccounts = state.loginLastAccounts.map(({ id, email }) => ({ id, email }));
    if (record(state.loginLastResponse)) {
      const { accounts, browserState, ...summary } = state.loginLastResponse;
      state.loginLastResponse = summary;
    }
    if (state.browserAccounts) state.browserAccounts = [...new Map(state.browserAccounts.map(account => {
      if (!record(account) || !account.id) throw invalid('浏览器账号缺少标识');
      return [String(account.id), account];
    })).values()];
    if (Array.isArray(state.pushOperations)) {
      state.pushOperations = compactPushOperations(state.pushOperations);
      if (state.activePushOperationId && !state.pushOperations.some(operation => operation.operationId === state.activePushOperationId)) {
        state.activePushOperationId = state.pushOperations.at(-1)?.operationId || '';
      }
      delete state.pushRetry;
      delete state.pushResults;
    }
    const fields = Array.isArray(snapshot.fields) ? snapshot.fields.filter(record) : [];
    const input = fields.find(field => field.id === 'session-input');
    let text = input ? String(input.value || '') : String(source.conversionInput?.text || '');
    // Legacy snapshots may have only parsed sources, or only old output copies.
    if (!text && !input && !source.conversionInput) {
      let values = (source.sessions || []).map(item => item.value);
      if (!values.length) values = (source.converted || []).map(item => {
        const value = { ...(item.cpa || item.sub2apiAccount || {}) };
        if (value.id_token_synthetic) delete value.id_token;
        return value;
      });
      if (values.length) text = JSON.stringify(values.length === 1 ? values[0] : values, null, 2);
    }
    state.conversionInput = {
      text,
      sources: Array.isArray(source.sessions) && source.sessions.length
        ? source.sessions.map(item => ({ sourceName: item.sourceName, path: item.path }))
        : (Array.isArray(source.conversionInput?.sources) ? source.conversionInput.sources : []),
    };
    return {
      schemaVersion: SCHEMA_VERSION,
      state,
      fields: fields.filter(field => field.id !== 'session-input' && field.id !== 'output'),
      resetCredentials: String(snapshot.resetCredentials || ''),
    };
  }
  function restore(snapshot) {
    if (snapshot === undefined) return undefined;
    const version = snapshot?.schemaVersion ?? 0;
    if (!Number.isInteger(version) || version < 0 || version > SCHEMA_VERSION) {
      throw invalid('此浏览器数据来自更新版本，请使用相应版本打开');
    }
    // Version 0 is the previous unversioned full application snapshot.
    const restored = serialize(structuredClone(snapshot));
    if (!Array.isArray(restored.state.pushOperations)) {
      const retry = restored.state.pushRetry;
      const rows = restored.state.pushResults || [];
      const accounts = retry?.accounts || [];
      restored.state.pushOperations = [];
      if (rows.length || accounts.length) {
        let failedIndex = 0;
        const operationId = 'legacy-push';
        const selected = snapshot.fields?.find(field => field.name === 'push-target' && field.checked)?.value;
        const target = retry?.target || selected || 'sub2api';
        const settings = target === 'cpa' ? restored.state.cpaSettings : restored.state.browserSettings?.sub2apiSettings;
        restored.state.pushOperations.push({
          operationId, target, baseUrl: retry?.baseUrl || settings?.baseUrl || '',
          groupIds: retry?.groupIds || settings?.groupIds, proxyId: retry?.proxyId || settings?.proxyId || '',
          upsert: retry?.upsert === true, startedAt: 0, updatedAt: 0,
          items: (rows.length ? rows : accounts.map((account, index) => ({ name: account.name || account.email || `账号 ${index + 1}`, status: 'failed' }))).map((row, index) => {
            const account = row.status === 'failed' ? accounts[failedIndex++] : undefined;
            return { ...row, itemId: String(index), account, status: account ? 'unknown' : row.status,
              retryable: false, ...(account ? { error: '旧版推送记录，请先核对远端结果' } : {}) };
          }),
        });
        restored.state.activePushOperationId = operationId;
      }
      delete restored.state.pushRetry;
      delete restored.state.pushResults;
    }
    for (const operation of restored.state.operationHistory || []) {
      if (['pending', 'inflight', 'running'].includes(operation.status)) operation.status = 'unknown';
    }
    for (const operation of restored.state.pushOperations || []) {
      for (const item of operation.items || []) {
        if (['pending', 'inflight', 'running'].includes(item.status)) {
          item.status = 'unknown';
          item.retryable = false;
          item.error = '页面中断，尚未确认远端结果，请先核对';
        }
      }
    }
    return restored;
  }
  globalThis.workspaceSchema = Object.freeze({ SCHEMA_VERSION, COMPLETED_PUSH_HISTORY_LIMIT, compactPushOperations, needsPushHistoryCompaction, serialize, restore });
})();
