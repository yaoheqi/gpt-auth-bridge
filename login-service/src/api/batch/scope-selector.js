import { normalizeAccountIds } from '../../services/account-selection.js';

/**
 * Resolve the common account scope used by batch endpoints.
 * IDs are trimmed, empty values ignored, and duplicates processed once while
 * preserving request order.
 */
export function selectBatchScope({
  body = {},
  allAccounts = [],
  findById,
  emptyAllError = '账号库为空',
  emptySelectedError = '请先选择账号',
  notFoundError = '未找到可操作的账号',
  predicate = () => true,
} = {}) {
  const scope = String(body.scope || '').trim().toLowerCase() === 'all' ? 'all' : 'selected';
  if (scope === 'all') {
    const accounts = [...allAccounts].filter(predicate);
    if (!accounts.length) throw new Error(emptyAllError);
    return { scope, accounts, ids: accounts.map(account => String(account?.id || '').trim()).filter(Boolean) };
  }
  const ids = normalizeAccountIds(body.ids);
  if (!ids.length) throw new Error(emptySelectedError);
  const accounts = ids.map(id => findById(id)).filter(Boolean).filter(predicate);
  if (!accounts.length) throw new Error(notFoundError);
  return { scope, ids, accounts };
}
