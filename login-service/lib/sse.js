import { redactDeep } from '../src/shared/redactor.js';
import { requestSignal } from '../src/services/request-scope.js';
import { runAccountTask } from './task-concurrency.js';
import { performance } from 'node:perf_hooks';
import { publicStageTimings } from './stage-timing.js';
import { operationMetadata } from '../../docs/operation-contract.js';

export class SSEChannel {
  constructor(res, { maxBufferedBytes = 16 * 1024 * 1024, drainTimeoutMs = 30_000 } = {}) {
    this.res = res;
    this.alive = true;
    this.maxBufferedBytes = maxBufferedBytes;
    this.drainTimeoutMs = drainTimeoutMs;
    this.drainTimer = null;
    const cleanup = () => { this.alive = false; clearTimeout(this.drainTimer); };
    res.on('close', cleanup);
    res.on('finish', cleanup);
    res.on('drain', () => { clearTimeout(this.drainTimer); this.drainTimer = null; });
    res.socket?.setNoDelay?.(true);
    // Flush headers immediately so the client can start consuming the stream
    // while the operation is still doing its first blocking step.
    res.flushHeaders?.();
    // Force compression proxies and browser networking stacks to release the
    // first packet instead of waiting for several small events to accumulate.
    this.write(`: stream-open ${' '.repeat(2048)}\n\n`);
    res.flush?.();
    res.socket?.uncork?.();
  }

  write(frame) {
    if (!this.alive || this.res.destroyed || this.res.writableEnded) return false;
    // Node owns the output buffer. Bound it when callers produce events faster
    // than a slow client can read; closing also aborts the request's operations.
    if ((this.res.writableLength || 0) + Buffer.byteLength(frame) > this.maxBufferedBytes) {
      this.res.destroy();
      this.alive = false;
      return false;
    }
    const writable = this.res.write(frame);
    if (writable === false && !this.drainTimer) {
      this.drainTimer = setTimeout(() => { this.alive = false; this.res.destroy(); }, this.drainTimeoutMs);
      this.drainTimer.unref?.();
    }
    return writable;
  }

  send(event, data) {
    if (!this.alive) return;
    try {
      const safe = redactDeep(data && typeof data === 'object' ? data : { message: String(data ?? '') });
      if (event === 'account_done' && data?.timings) safe.timings = publicStageTimings(data.timings);
      if (event === 'summary' && Array.isArray(data?.results)) {
        safe.results.forEach((result, index) => {
          if (data.results[index]?.timings && result && typeof result === 'object') {
            result.timings = publicStageTimings(data.results[index].timings);
          }
        });
      }
      const payload = {
        at: safe.at || safe.time || new Date().toISOString(),
        level: safe.level || (event === 'error' ? 'error' : 'info'),
        ...safe,
        ...operationMetadata(this.res.locals?.operationId, this.res.locals?.requestId),
      };
      if (this.res.locals?.browserSnapshot) {
        const id = data?.id || data?.accountId;
        if (event === 'account_done' && id) {
          this.write(`event: browser_state\ndata: ${JSON.stringify({ ...this.res.locals.browserSnapshot([id]), partial: true })}\n\n`);
        } else if (event === 'summary' || event === 'error') {
          this.write(`event: browser_state\ndata: ${JSON.stringify(this.res.locals.browserSnapshot())}\n\n`);
        }
      }
      this.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      this.res.flush?.();
    } catch {}
  }
}

export async function mapWithConcurrency(items, concurrency, worker, { signal = requestSignal() } = {}) {
  const enqueuedAt = performance.now();
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let nextIndex = 0;
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1));
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (true) {
      signal?.throwIfAborted();
      const index = nextIndex;
      nextIndex += 1;
      if (index >= list.length) return;
      results[index] = await runAccountTask(() => worker(list[index], index), { signal, enqueuedAt });
    }
  });
  await Promise.all(runners);
  return results;
}
