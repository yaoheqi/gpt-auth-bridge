// Fixed-cardinality operational data only. No task/account IDs, URLs or stderr.
const EVENTS = new Set(['browser_started', 'browser_disconnected', 'page_crashed', 'context_closed',
  'recovery_started', 'recovery_succeeded', 'recovery_failed', 'worker_exit', 'worker_retired', 'cleanup_failed']);
const REASONS = new Set(['completed', 'idle', 'max_tasks', 'failed', 'cancelled', 'timeout', 'shutdown', 'request_cleanup', 'incompatible_root', 'stale']);
const SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV']);

export function createBrowserDiagnostics() {
  const counts = Object.fromEntries([...EVENTS].map(event => [event, 0]));
  const retirements = Object.fromEntries([...REASONS].map(reason => [reason, 0]));
  let unexpectedDisconnects = 0, lastExit = null;
  return {
    record(input) {
      if (!EVENTS.has(input?.event)) return;
      counts[input.event]++;
      if (input.event === 'browser_disconnected' && input.expected !== true) unexpectedDisconnects++;
      if (input.event === 'worker_retired' && REASONS.has(input.reason)) retirements[input.reason]++;
      if (input.event === 'worker_exit') {
        lastExit = {
          exitCode: Number.isInteger(input.exitCode) ? input.exitCode : null,
          signal: SIGNALS.has(input.signal) ? input.signal : null,
          reason: REASONS.has(input.reason) ? input.reason : 'unexpected',
        };
      }
    },
    snapshot() { return { counts: { ...counts }, retirements: { ...retirements }, unexpectedDisconnects, lastExit: lastExit && { ...lastExit } }; },
  };
}
