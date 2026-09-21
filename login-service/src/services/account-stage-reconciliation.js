function shouldAdvance(current, desired, rank) {
  if (!desired || current === desired) return false;
  return (rank[current] || 0) <= (rank[desired] || 0);
}

export async function reconcileAccountStage({ account, desiredStage, normalizeStage, rank, updateById, statusForStage }) {
  if (!account?.id || typeof updateById !== 'function') return null;
  const current = normalizeStage(account.openai_stage);
  if (!shouldAdvance(current, desiredStage, rank)) return null;
  await updateById(account.id, {
    openai_stage: desiredStage,
    status: statusForStage(desiredStage),
    last_error: '',
  });
  return { id: account.id, email: account.email, from: current, to: desiredStage };
}

export async function reconcileAccountStages({ accounts = [], desiredForAccount, normalizeStage, rank, updateMany, statusForStage }) {
  if (typeof desiredForAccount !== 'function' || typeof updateMany !== 'function') return [];
  const changes = [];
  const eligible = [];
  for (const account of accounts || []) {
    const desired = desiredForAccount(account);
    const current = normalizeStage(account.openai_stage);
    if (!shouldAdvance(current, desired, rank)) continue;
    eligible.push({ account, desired, current });
    changes.push({ id: account.id, email: account.email, from: current, to: desired });
  }
  if (eligible.length) {
    const desiredById = new Map(eligible.map(item => [String(item.account.id), item.desired]));
    await updateMany(eligible.map(item => item.account.id), account => ({
      openai_stage: desiredById.get(String(account.id)),
      status: statusForStage(desiredById.get(String(account.id))),
      last_error: '',
    }));
  }
  return changes;
}
