import { performance } from 'node:perf_hooks';
import { combineSignals } from './execution-limits.js';
import { validationError } from './validation-error.js';

// Queueing and every fallback share this budget; cleanup has a separate bound.
export function validationDeadline({ timeoutMs = 120000, signal, stage = 'sentinel' } = {}) {
  signal?.throwIfAborted();
  const duration = Number(timeoutMs);
  if (!Number.isFinite(duration) || duration <= 0) throw validationError('VALIDATION_TIMEOUT', { stage });
  const expires = performance.now() + duration;
  const controller = new AbortController();
  const expire = () => controller.abort(validationError('VALIDATION_TIMEOUT', { stage }));
  const timer = setTimeout(expire, duration);
  const combined = combineSignals(signal, controller.signal);
  return {
    signal: combined,
    remaining() {
      if (performance.now() >= expires) expire();
      combined.throwIfAborted();
      return Math.max(1, expires - performance.now());
    },
    close() { clearTimeout(timer); },
  };
}
