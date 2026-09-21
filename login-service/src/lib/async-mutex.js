/**
 * Simple promise mutex for serializing critical sections (e.g. SMSBower getNumber).
 */
export function createMutex() {
  let tail = Promise.resolve();
  return function withLock(fn) {
    const run = tail.then(() => fn());
    // Keep the chain alive even if the critical section rejects.
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}
