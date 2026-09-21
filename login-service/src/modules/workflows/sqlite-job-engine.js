import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { withTransaction } from '../../shared/db.js';
import { redactDeep } from '../../shared/redactor.js';
import { normalizeProgressEvent } from '../../lib/progress-contract.js';
import { normalizeJobManifest, equivalentJobManifests } from '../../lib/job-contract.js';

function nowIso() {
  return new Date().toISOString();
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export class SqliteJobEngine {
  constructor(db, {
    defaultLeaseMs = 60_000,
    runtimePaths = null,
    resolveAccountIds = null,
    progressBatchWindowMs = 12,
    progressBatchMax = 64,
  } = {}) {
    this.db = db;
    this.defaultLeaseMs = defaultLeaseMs;
    this.handlers = new Map();
    this.active = new Map();
    this.runtimePaths = runtimePaths;
    this.resolveAccountIds = resolveAccountIds;
    this.progressBatchWindowMs = Math.max(0, Number(progressBatchWindowMs) || 0);
    this.progressBatchMax = Math.max(1, Number(progressBatchMax) || 64);
    this.pendingWrites = [];
    this.pendingWriteTimer = null;
    this.flushingWrites = null;
  }

  registerHandler(type, handler) {
    this.handlers.set(type, handler);
  }

  create(input = {}) {
    const manifest = normalizeJobManifest(input);
    const { type, scope, ids = [], options = {}, jobId: id } = manifest;
    if (!this.handlers.has(type)) throw Object.assign(new Error(`Unsupported job type: ${type}`), { code: 'UNSUPPORTED_JOB_TYPE', statusCode: 400 });
    const stamp = nowIso();
    return withTransaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (existing) {
        const prior = this.manifest(id);
        if (!equivalentJobManifests(prior, manifest)) throw Object.assign(new Error(`Job ${id} already exists with a different manifest operation`), { code: 'JOB_CONFLICT', statusCode: 409 });
        return { resumed: true, manifest: prior, job: this.detail(id) };
      }
      this.db.prepare(`
        INSERT INTO jobs(id, type, scope, status, options_json, created_at, updated_at)
        VALUES (?, ?, ?, 'queued', ?, ?, ?)
      `).run(id, type, scope === 'all' ? 'all' : 'selected', JSON.stringify(options || {}), stamp, stamp);
      const keys = scope === 'all' ? this.#allAccountIds(manifest) : [...new Set((ids || []).map((x) => String(x).trim()).filter(Boolean))];
      if (scope !== 'all' && !keys.length) throw Object.assign(new Error('selected jobs require at least one account id'), { statusCode: 400 });
      const insertItem = this.db.prepare(`
        INSERT INTO job_items(id, job_id, account_id, item_key, status, step, attempt, idempotency_key, updated_at)
        VALUES (?, ?, ?, ?, 'queued', '', 0, ?, ?)
      `);
      for (const key of keys) {
        insertItem.run(randomUUID(), id, key, key, `${id}:${key}`, stamp);
      }
      this.appendEvent(id, 'created', { type, scope, count: keys.length });
      return { resumed: false, manifest, job: this.detail(id) };
    });
  }

  manifest(jobId) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(String(jobId));
    if (!row) throw Object.assign(new Error(`Job not found: ${jobId}`), { code: 'JOB_NOT_FOUND', statusCode: 404 });
    const rows = this.db.prepare('SELECT item_key FROM job_items WHERE job_id = ? ORDER BY rowid ASC').all(row.id);
    return Object.freeze({ schemaVersion: '1.0.0', jobId: row.id, type: row.type, scope: row.scope === 'all' ? 'all' : 'selected', ids: row.scope === 'all' ? [] : rows.map((item) => item.item_key), options: JSON.parse(row.options_json || '{}'), createdAt: row.created_at });
  }

  #allAccountIds(manifest) {
    const values = typeof this.resolveAccountIds === 'function'
      ? this.resolveAccountIds(manifest)
      : this.db.prepare('SELECT id FROM accounts ORDER BY created_at ASC, id ASC').all();
    if (values && typeof values.then === 'function') throw Object.assign(new Error('resolveAccountIds must return synchronously'), { code: 'INVALID_ACCOUNT_RESOLVER', statusCode: 500 });
    if (!Array.isArray(values)) throw Object.assign(new Error('resolveAccountIds must return an array'), { code: 'INVALID_ACCOUNT_RESOLVER', statusCode: 500 });
    return [...new Set(values.map((value) => String(value && typeof value === 'object' ? value.id : value || '').trim()).filter(Boolean))];
  }

  start(jobId, owner = `worker-${process.pid}`) {
    if (this.active.has(jobId)) return this.active.get(jobId);
    const heartbeat = this.startLeaseHeartbeat(jobId, owner);
    const work = this.#run(jobId, owner).finally(() => {
      heartbeat.stop();
      this.active.delete(jobId);
    });
    this.active.set(jobId, work);
    return work;
  }

  startLeaseHeartbeat(jobId, owner, { intervalMs = Math.max(10, Math.floor(this.defaultLeaseMs / 3)) } = {}) {
    const delay = Math.max(10, Number(intervalMs) || Math.floor(this.defaultLeaseMs / 3));
    // A timer callback runs outside the request promise chain. Absorb a
    // transient SQLite/connection error here; the conditional finalization in
    // #run will refuse to publish a result unless this owner still holds the
    // lease, preventing an unhandled rejection from taking down the process.
    const timer = setInterval(() => {
      Promise.resolve()
        .then(() => this.renewLease(jobId, owner))
        .catch(() => { /* checked again before commit */ });
    }, delay);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
  }

  async #run(jobId, owner) {
    const claimed = this.claim(jobId, owner);
    if (!claimed.ok) return this.detail(jobId);
    const job = claimed.job;
    const handler = this.handlers.get(job.type);
    const items = this.db.prepare(`SELECT * FROM job_items WHERE job_id = ? AND status NOT IN ('succeeded','cancelled')`).all(jobId);
    let success = 0;
    let failed = 0;
    let skipped = 0;
    for (const item of items) {
      if (this.isCancelled(jobId)) break;
      if (!this.renewLease(jobId, owner)) break;
      this.db.prepare(`UPDATE job_items SET status = 'running', attempt = attempt + 1, updated_at = ? WHERE id = ?`).run(nowIso(), item.id);
      this.appendEvent(jobId, 'item_started', { key: item.item_key, attempt: item.attempt + 1 });
      try {
        const result = await handler({ job, item, engine: this });
        if (result?.skipped) {
          skipped += 1;
          this.#finishItem(item.id, 'succeeded', { step: result.step || 'skipped', result });
        } else if (result?.ok === false) {
          failed += 1;
          this.#finishItem(item.id, 'failed', { step: result.step || '', errorCode: result.code || 'ITEM_FAILED', errorMessage: result.error || 'failed', result });
        } else {
          success += 1;
          this.#finishItem(item.id, 'succeeded', { step: result?.step || 'done', result });
        }
      } catch (error) {
        failed += 1;
        this.#finishItem(item.id, 'failed', {
          errorCode: error?.code || 'ITEM_ERROR',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const cancelled = this.isCancelled(jobId);
    const status = cancelled ? 'cancelled' : failed ? 'failed' : 'succeeded';
    const summary = { ok: !failed && !cancelled, status: status === 'succeeded' ? 'completed' : status, success, failed, skipped, total: items.length };
    const finalizedAt = nowIso();
    const finalized = this.db.prepare(`
      UPDATE jobs
      SET status = ?, summary_json = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?
    `).run(status, JSON.stringify(summary), finalizedAt, jobId, owner, finalizedAt);
    // The lease may have expired or another worker/cancellation may have
    // changed the job while the account handler was running. Never let this
    // worker overwrite that newer state.
    if (Number(finalized.changes || 0) !== 1) return this.detail(jobId);
    this.appendEvent(jobId, 'done', summary);
    return this.detail(jobId);
  }

  async readProgress(jobId) {
    this.manifest(jobId);
    return this.events(jobId);
  }

  async completedKeys(jobId) {
    return new Set((await this.readProgress(jobId)).filter((event) => event.status === 'completed' && event.key !== 'survival' && event.key !== 'worker').map((event) => event.key));
  }

  async progress(jobId, event = {}) {
    const manifest = this.manifest(jobId);
    const normalized = normalizeProgressEvent(event, { type: manifest.type });
    const eventType = ['started', 'completed', 'failed', 'skipped'].includes(normalized.status) ? normalized.status : 'progress';
    return this.#enqueueWrite({ kind: 'progress', jobId: String(jobId), eventType, normalized });
  }

  async log(jobId, message, level = 'info') {
    this.manifest(jobId);
    return this.#enqueueWrite({
      kind: 'event',
      jobId: String(jobId),
      eventType: 'log',
      payload: { status: 'log', level, message: String(message) },
    });
  }

  #enqueueWrite(write) {
    return new Promise((resolve, reject) => {
      this.pendingWrites.push({ ...write, resolve, reject });
      if (this.pendingWrites.length >= this.progressBatchMax) {
        this.#flushWrites();
        return;
      }
      if (this.pendingWriteTimer) return;
      this.pendingWriteTimer = setTimeout(() => {
        this.pendingWriteTimer = null;
        this.#flushWrites();
      }, this.progressBatchWindowMs);
      this.pendingWriteTimer.unref?.();
    });
  }

  #flushWrites() {
    if (this.flushingWrites || !this.pendingWrites.length) return this.flushingWrites;
    if (this.pendingWriteTimer) {
      clearTimeout(this.pendingWriteTimer);
      this.pendingWriteTimer = null;
    }
    const batch = this.pendingWrites.splice(0);
    this.flushingWrites = Promise.resolve().then(() => {
      const results = [];
      return withTransaction(this.db, () => {
        const sequenceByJob = new Map();
        const nextSequence = (jobId) => {
          if (!sequenceByJob.has(jobId)) {
            const last = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS seq FROM job_events WHERE job_id = ?').get(jobId);
            sequenceByJob.set(jobId, Number(last?.seq || 0));
          }
          const sequence = sequenceByJob.get(jobId) + 1;
          sequenceByJob.set(jobId, sequence);
          return sequence;
        };
        for (const write of batch) {
          if (write.kind === 'progress') {
            this.#syncItemProgress(write.jobId, write.normalized);
            if (['started', 'running', 'completed', 'failed', 'skipped'].includes(write.normalized.status)) {
              this.db.prepare(`
                UPDATE jobs SET status = CASE WHEN status IN ('succeeded', 'failed', 'cancelled') THEN status ELSE 'running' END,
                  updated_at = ? WHERE id = ?
              `).run(nowIso(), write.jobId);
            }
            results.push(this.#insertEvent(write.jobId, write.eventType, write.normalized, nextSequence));
          } else {
            results.push(this.#insertEvent(write.jobId, write.eventType, write.payload, nextSequence));
          }
        }
        return results;
      });
    }).then((results) => {
      batch.forEach((write, index) => write.resolve(results[index]));
      return results;
    }).catch((error) => {
      batch.forEach((write) => write.reject(error));
      throw error;
    }).finally(() => {
      this.flushingWrites = null;
      if (this.pendingWrites.length) this.#flushWrites();
    });
    this.flushingWrites.catch(() => {});
    return this.flushingWrites;
  }

  async summarize(jobId, summary = {}) {
    const row = this.db.prepare('SELECT id FROM jobs WHERE id = ?').get(String(jobId));
    if (!row) throw Object.assign(new Error(`Job not found: ${jobId}`), { code: 'JOB_NOT_FOUND', statusCode: 404 });
    const value = { schemaVersion: '1.0.0', jobId: String(jobId), completedAt: nowIso(), ...summary };
    const internalStatus = summary.status === 'completed' ? 'succeeded' : summary.status;
    if (internalStatus === 'cancelled') {
      this.db.prepare(`UPDATE job_items SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status IN ('queued', 'running', 'retry_wait')`).run(nowIso(), String(jobId));
    } else if (internalStatus === 'failed') {
      this.db.prepare(`UPDATE job_items SET status = 'failed', error_code = COALESCE(NULLIF(error_code, ''), 'JOB_FAILED'), error_message = COALESCE(NULLIF(error_message, ''), 'job failed'), updated_at = ? WHERE job_id = ? AND status IN ('queued', 'running', 'retry_wait')`).run(nowIso(), String(jobId));
    }
    this.db.prepare('UPDATE jobs SET status = ?, summary_json = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?').run(internalStatus, JSON.stringify(redactDeep(value)), nowIso(), String(jobId));
    this.appendEvent(jobId, 'done', value);
    return value;
  }

  async summary(jobId) {
    const row = this.db.prepare('SELECT summary_json FROM jobs WHERE id = ?').get(String(jobId));
    if (!row) throw Object.assign(new Error(`Job not found: ${jobId}`), { code: 'JOB_NOT_FOUND', statusCode: 404 });
    return row.summary_json ? JSON.parse(row.summary_json) : null;
  }

  async readLog(jobId, limit = 200) {
    this.manifest(jobId);
    const records = this.events(jobId).filter((event) => event.event === 'log').map((event) => ({ at: event.at, level: event.data?.level || 'info', message: event.data?.message || '' }));
    return { total: records.length, items: records.slice(-Math.max(1, Number(limit) || 200)) };
  }

  jobDirectory(jobId) {
    this.manifest(jobId);
    if (!this.runtimePaths?.jobs) throw new Error('SQLite job runtime path is not configured');
    return path.join(this.runtimePaths.jobs, String(jobId));
  }

  async status(jobId) {
    const row = this.db.prepare('SELECT status FROM jobs WHERE id = ?').get(String(jobId));
    if (!row) throw Object.assign(new Error(`Job not found: ${jobId}`), { code: 'JOB_NOT_FOUND', statusCode: 404 });
    return ({ queued: 'pending', running: 'running', succeeded: 'completed', failed: 'failed', cancelled: 'cancelled' }[row.status] || row.status);
  }

  async delete(jobId) {
    const row = this.db.prepare('SELECT status FROM jobs WHERE id = ?').get(String(jobId));
    if (!row) throw Object.assign(new Error(`Job not found: ${jobId}`), { code: 'JOB_NOT_FOUND', statusCode: 404 });
    const status = await this.status(jobId);
    if (!TERMINAL.has(row.status) || this.active.has(String(jobId))) throw Object.assign(new Error(`Job ${jobId} cannot be deleted while status is ${status}`), { code: 'JOB_NOT_TERMINAL', statusCode: 409 });
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(String(jobId));
    return { schemaVersion: '1.0.0', jobId: String(jobId), status, deleted: true };
  }

  async cancelMany(jobIds) {
    const ids = [...new Set((Array.isArray(jobIds) ? jobIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) throw Object.assign(new Error('至少选择一个 Job'), { statusCode: 400 });
    const cancellations = await Promise.all(ids.map(async (id) => ({ jobId: id, cancellation: await this.cancel(id) })));
    return { schemaVersion: '1.0.0', requested: ids.length, cancellations };
  }

  async deleteMany(jobIds) {
    const ids = [...new Set((Array.isArray(jobIds) ? jobIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) throw Object.assign(new Error('至少选择一个 Job'), { statusCode: 400 });
    const deleted = await Promise.all(ids.map((id) => this.delete(id)));
    return { schemaVersion: '1.0.0', requested: ids.length, deleted };
  }

  claim(jobId, owner) {
    const stamp = nowIso();
    const expires = new Date(Date.now() + this.defaultLeaseMs).toISOString();
    return withTransaction(this.db, () => {
      const job = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      if (!job) return { ok: false, reason: 'missing' };
      if (TERMINAL.has(job.status)) return { ok: false, reason: 'terminal', job };
      if (job.lease_owner && job.lease_expires_at > stamp && job.lease_owner !== owner) {
        return { ok: false, reason: 'leased', job };
      }
      this.db.prepare(`UPDATE jobs SET status = 'running', lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
        .run(owner, expires, stamp, jobId);
      return { ok: true, job: this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) };
    });
  }

  renewLease(jobId, owner) {
    const expires = new Date(Date.now() + this.defaultLeaseMs).toISOString();
    const result = this.db.prepare(`
      UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'
    `).run(expires, nowIso(), jobId, owner);
    return Number(result.changes || 0) > 0;
  }

  recoverExpiredLeases() {
    const stamp = nowIso();
    const staleBefore = new Date(Date.now() - this.defaultLeaseMs).toISOString();
    const rows = this.db.prepare(`
      SELECT id FROM jobs
      WHERE status = 'running'
        AND ((lease_expires_at IS NOT NULL AND lease_expires_at < ?)
          OR (lease_expires_at IS NULL AND updated_at < ?))
    `).all(stamp, staleBefore);
    for (const row of rows) {
      this.db.prepare(`UPDATE jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`).run(stamp, row.id);
      this.appendEvent(row.id, 'lease_expired', { at: stamp });
    }
    return rows.map((row) => row.id);
  }

  cancel(jobId) {
    const stamp = nowIso();
    this.db.prepare(`UPDATE jobs SET status = CASE WHEN status IN ('succeeded','failed','cancelled') THEN status ELSE 'cancelled' END, updated_at = ? WHERE id = ?`)
      .run(stamp, jobId);
    this.db.prepare(`UPDATE job_items SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status IN ('queued','retry_wait')`)
      .run(stamp, jobId);
    this.appendEvent(jobId, 'cancel_requested', {});
    return this.detail(jobId);
  }

  isCancelled(jobId) {
    const job = this.db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    return job?.status === 'cancelled';
  }

  appendEvent(jobId, eventType, payload = {}) {
    return withTransaction(this.db, () => {
      return this.#insertEvent(jobId, eventType, payload, (id) => {
        const last = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS seq FROM job_events WHERE job_id = ?').get(id);
        return Number(last?.seq || 0) + 1;
      });
    });
  }

  #insertEvent(jobId, eventType, payload, nextSequence) {
    const sequence = nextSequence(jobId);
    const safePayload = redactDeep(payload);
    this.db.prepare(`
      INSERT INTO job_events(job_id, sequence, at, event_type, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(jobId, sequence, nowIso(), eventType, JSON.stringify(safePayload));
    return { sequence, eventType, payload: safePayload };
  }

  events(jobId, after = 0) {
    return this.db.prepare(`
      SELECT e.sequence, e.at, e.event_type AS event, e.payload_json AS data, j.type AS job_type
      FROM job_events e JOIN jobs j ON j.id = e.job_id
      WHERE e.job_id = ? AND e.sequence > ? ORDER BY e.sequence ASC
    `).all(jobId, Number(after) || 0).map((row) => {
      const data = JSON.parse(row.data || '{}');
      const status = row.event === 'done'
        ? ({ failed: 'failed', cancelled: 'cancelled', cancelling: 'cancelled', succeeded: 'completed', completed: 'completed' }[data.status] || 'completed')
        : (row.event === 'progress' || ['started', 'completed', 'failed', 'skipped'].includes(row.event))
          ? (data.status || row.event)
          : ({ created: 'pending', item_started: 'started', cancel_requested: 'cancelling', lease_expired: 'log', log: 'log' })[row.event] || 'log';
      return {
      ...normalizeProgressEvent({
        ...data,
        at: row.at,
        type: row.job_type,
        status,
        phase: row.event,
        message: data.message || row.event,
      }),
      sequence: row.sequence,
      event: row.event,
      data,
    }; });
  }

  list() {
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all().map((row) => {
      const view = this.#jobView(row);
      return { schemaVersion: '1.0.0', jobId: view.jobId, type: view.type, createdAt: view.createdAt, status: ({ succeeded: 'completed' }[view.status] || view.status), summary: view.summary };
    });
  }

  detail(jobId) {
    const job = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) throw Object.assign(new Error(`Job not found: ${jobId}`), { code: 'JOB_NOT_FOUND', statusCode: 404 });
    const items = this.db.prepare('SELECT * FROM job_items WHERE job_id = ? ORDER BY updated_at ASC').all(jobId);
    const events = this.events(jobId);
    const logs = events.filter((event) => event.event === 'log').map((event) => ({ at: event.at, level: event.data?.level || 'info', message: event.data?.message || '' }));
    return {
      ...this.#jobView(job),
      manifest: this.manifest(jobId),
      items: items.map((item) => ({
        id: item.id,
        accountId: item.account_id,
        key: item.item_key,
        status: item.status,
        step: item.step,
        attempt: item.attempt,
        errorCode: item.error_code || '',
        errorMessage: item.error_message || '',
        result: item.result_json ? (() => { try { return JSON.parse(item.result_json); } catch { return null; } })() : null,
        updatedAt: item.updated_at,
      })),
      events,
      logs,
      logCount: logs.length,
    };
  }

  #finishItem(itemId, status, { step = '', errorCode = '', errorMessage = '', result = null } = {}) {
    this.db.prepare(`
      UPDATE job_items
      SET status = ?, step = ?, error_code = ?, error_message = ?, result_json = ?, updated_at = ?
      WHERE id = ?
    `).run(status, step, errorCode, errorMessage, result ? JSON.stringify(redactDeep(result)) : null, nowIso(), itemId);
  }

  #syncItemProgress(jobId, normalized) {
    const key = String(normalized.key || '').trim();
    if (!key || ['worker', 'survival'].includes(key)) return;
    const row = this.db.prepare('SELECT id, status, attempt FROM job_items WHERE job_id = ? AND item_key = ?').get(String(jobId), key);
    if (!row) return;
    const status = normalized.status === 'failed'
      ? 'failed'
      : normalized.status === 'started' || normalized.status === 'running'
        ? 'running'
        : ['completed', 'skipped'].includes(normalized.status)
          ? 'succeeded'
          : null;
    if (!status) return;
    const attempt = status === 'running' && row.status !== 'running' ? Number(row.attempt || 0) + 1 : Number(row.attempt || 0);
    const errorCode = normalized.status === 'failed' ? String(normalized.code || 'ITEM_FAILED') : '';
    const errorMessage = normalized.status === 'failed' ? String(normalized.message || 'failed') : '';
    this.db.prepare(`
      UPDATE job_items
      SET status = ?, step = ?, attempt = ?, error_code = ?, error_message = ?, result_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      String(normalized.phase || normalized.status || ''),
      attempt,
      errorCode,
      errorMessage,
      JSON.stringify(redactDeep(normalized)),
      nowIso(),
      row.id,
    );
  }

  #jobView(row) {
    return {
      schemaVersion: '2.0.0',
      jobId: row.id,
      type: row.type,
      scope: row.scope,
      status: row.status,
      options: JSON.parse(row.options_json || '{}'),
      summary: row.summary_json ? JSON.parse(row.summary_json) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      leaseOwner: row.lease_owner || null,
      leaseExpiresAt: row.lease_expires_at || null,
    };
  }
}
