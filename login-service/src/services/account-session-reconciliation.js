/** Reconcile account plan metadata from the persisted ChatGPT session. */
export async function reconcileSessionPlanTypes({
  accounts = [],
  resolvePlanType,
  updateMany,
} = {}) {
  if (typeof resolvePlanType !== 'function') throw new TypeError('resolvePlanType is required');
  if (typeof updateMany !== 'function') throw new TypeError('updateMany is required');
  const updates = [];
  for (const account of accounts || []) {
    const planType = resolvePlanType(account?.session_json);
    if (!planType || account.agent_plan_type === planType) continue;
    updates.push({ id: account.id, planType });
  }
  if (!updates.length) return updates;
  const planTypes = new Map(updates.map(item => [String(item.id), item.planType]));
  await updateMany(updates.map(item => item.id), account => ({
    agent_plan_type: planTypes.get(String(account.id)),
  }));
  return updates;
}
