/** Normalize user-provided account ids while preserving request order. */
export function normalizeAccountIds(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids
    .map(id => String(id || '').trim())
    .filter(Boolean))];
}

/** Select accounts by explicit ids or the complete account collection. */
export function selectAccounts({ allAccounts = [], findById, scope = 'selected', ids = [], predicate = () => true } = {}) {
  if (scope === 'all') return allAccounts.filter(predicate);
  const wanted = normalizeAccountIds(ids);
  const resolve = typeof findById === 'function' ? findById : id => allAccounts.find(account => String(account.id) === id);
  return wanted.map(resolve).filter(Boolean).filter(predicate);
}
