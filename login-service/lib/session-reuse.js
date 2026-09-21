import { accountHasChatGptSession } from '../src/domain/accounts/account-domain.js';

export function sessionReuseFields(account = {}) {
  return {
    session_access_token: account.session_access_token || '',
    session_json: account.session_json || '',
    storage_state_json: account.storage_state_json || '',
  };
}

export function normalizeStorageStateJson(storageState) {
  if (storageState == null || storageState === '') return '';
  if (typeof storageState === 'string') return storageState.trim();
  if (typeof storageState === 'object' && !Array.isArray(storageState)) {
    return JSON.stringify(storageState);
  }
  return String(storageState).trim();
}

export function parseStorageState(storageStateJson) {
  const text = String(storageStateJson || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function countStorageStateCookies(storageStateJson) {
  const state = parseStorageState(storageStateJson);
  return Array.isArray(state?.cookies) ? state.cookies.length : 0;
}

export function hasReusableStoredCookies(account) {
  return countStorageStateCookies(account?.storage_state_json) > 0;
}

export function hasReusableStoredSession(account) {
  return accountHasChatGptSession(account) && hasReusableStoredCookies(account);
}

/**
 * @param {'auto'|'forceProtocol'|'skipLogin'} loginMode
 * @param {{ hasReusableSession?: boolean }} [state]
 * @returns {'forceProtocol'|'skipLogin'}
 */
export function resolveSessionCodexLoginAction(loginMode = 'auto', { hasReusableSession = false } = {}) {
  const mode = String(loginMode || 'auto').trim();
  if (mode === 'forceProtocol') return 'forceProtocol';
  if (mode === 'skipLogin') return 'skipLogin';
  return hasReusableSession ? 'skipLogin' : 'forceProtocol';
}
