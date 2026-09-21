export function chunkAccounts(accounts, batchSize) {
  const rounds = [];
  for (let index = 0; index < accounts.length; index += batchSize) rounds.push(accounts.slice(index, index + batchSize));
  return rounds;
}

export function summarizeRound(results) {
  const items = Array.isArray(results) ? results : [];
  const succeeded = items.filter(item => item?.ok === true).length;
  return { total: items.length, succeeded, failed: items.length - succeeded };
}
