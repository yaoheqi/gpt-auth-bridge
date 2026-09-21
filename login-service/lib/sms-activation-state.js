export const REUSABLE_SMS_ACTIVATION_STATUSES = Object.freeze(new Set([
  'number_acquired',
  'sms_sent',
  'waiting',
]));

export function isReusableSmsActivationStatus(status) {
  return REUSABLE_SMS_ACTIVATION_STATUSES.has(String(status || '').trim());
}

export function terminalSmsCancellationStatus(reason = 'cancelled', failed = false) {
  const normalized = String(reason || 'cancelled').replace(/^cancelled_?/, '') || 'cancelled';
  const prefix = failed ? 'cancel_failed' : 'cancelled';
  return normalized === 'cancelled' ? prefix : `${prefix}_${normalized}`;
}

export async function cancelSmsActivationSnapshot({ activation, cancelRemote, persist, reason = 'cancelled' } = {}) {
  if (!activation) return { status: '', error: null };
  let error = null;
  try {
    if (typeof cancelRemote !== 'function') throw new Error('SMS cancellation client unavailable');
    await cancelRemote(activation);
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }
  const status = terminalSmsCancellationStatus(reason, Boolean(error));
  await persist(status, activation);
  return { status, error };
}