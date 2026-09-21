import fs from 'fs/promises';
import path from 'path';
import { writeJsonAtomic } from '../repositories/json-repository.js';
import { normalizeJobManifest, equivalentJobManifests } from '../lib/job-contract.js';
import { normalizeProgressEvent } from '../lib/progress-contract.js';
import { redactDeep } from '../shared/redactor.js';

async function readJson(filePath) { try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } }
async function appendJsonLine(filePath, value) { await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8'); }

export class JobNotFoundError extends Error { constructor(jobId) { super(`Job not found: ${jobId}`); this.code = 'JOB_NOT_FOUND'; } }
export class JobConflictError extends Error { constructor(jobId) { super(`Job ${jobId} already exists with a different manifest operation`); this.code = 'JOB_CONFLICT'; } }
export class JobDeleteConflictError extends Error { constructor(jobId, status) { super(`Job ${jobId} cannot be deleted while status is ${status}`); this.code = 'JOB_NOT_TERMINAL'; this.status = status; } }

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const SAFE_JOB_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/;

export class JobService {
  constructor(paths) { this.paths = paths; this.progressChains = new Map(); }
  jobDirectory(jobId) {
    const id = String(jobId || '').trim();
    if (!SAFE_JOB_ID.test(id)) throw new JobNotFoundError(id);
    const root = path.resolve(this.paths.jobs);
    const directory = path.resolve(root, id);
    if (path.dirname(directory) !== root) throw new JobNotFoundError(id);
    return directory;
  }
  async create(input) {
    const requested = normalizeJobManifest(input);
    const directory = this.jobDirectory(requested.jobId);
    try { await fs.mkdir(directory, { recursive: false }); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await this.manifest(requested.jobId);
      if (!equivalentJobManifests(existing, requested)) throw new JobConflictError(requested.jobId);
      return { directory, manifest: existing, resumed: true };
    }
    await writeJsonAtomic(path.join(directory, 'manifest.json'), requested);
    await Promise.all(['progress.jsonl', 'job.log'].map(name => fs.appendFile(path.join(directory, name), '', 'utf8')));
    return { directory, manifest: requested, resumed: false };
  }
  async manifest(jobId) { const value = await readJson(path.join(this.jobDirectory(jobId), 'manifest.json')); if (!value) throw new JobNotFoundError(jobId); return value; }
  async readProgress(jobId) {
    await this.manifest(jobId);
    let text = '';
    try { text = await fs.readFile(path.join(this.jobDirectory(jobId), 'progress.jsonl'), 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const records = [];
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim(); if (!line) continue;
      try { const value = JSON.parse(line); if (value && typeof value === 'object') records.push(value); }
      catch { if (index < lines.length - 1 || text.endsWith('\n')) continue; }
    }
    return records;
  }
  async readLog(jobId, limit = 200) {
    await this.manifest(jobId);
    let text = '';
    try { text = await fs.readFile(path.join(this.jobDirectory(jobId), 'job.log'), 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const records = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
      try { const value = JSON.parse(line); return value && typeof value === 'object' ? [value] : []; } catch { return []; }
    });
    return { total: records.length, items: records.slice(-Math.max(1, Number(limit) || 200)) };
  }
  async completedKeys(jobId) { return new Set((await this.readProgress(jobId)).filter(x => x.status === 'completed' && x.key !== 'survival' && x.key !== 'worker').map(x => x.key)); }
  async progress(jobId, event) {
    const prior = this.progressChains.get(jobId) || Promise.resolve();
    const current = prior.then(() => this.#appendProgress(jobId, event));
    const settled = current.catch(() => {});
    this.progressChains.set(jobId, settled);
    try { return await current; } finally { if (this.progressChains.get(jobId) === settled) this.progressChains.delete(jobId); }
  }
  async #appendProgress(jobId, event) {
    const previous = await this.readProgress(jobId);
    const normalized = normalizeProgressEvent(event, { type: (await this.manifest(jobId)).type });
    const record = redactDeep({ ...normalized, sequence: previous.length + 1, jobId, at: new Date().toISOString() });
    await appendJsonLine(path.join(this.jobDirectory(jobId), 'progress.jsonl'), record); return record;
  }
  async log(jobId, message, level = 'info') { await appendJsonLine(path.join(this.jobDirectory(jobId), 'job.log'), redactDeep({ at: new Date().toISOString(), level, message: String(message) })); }
  async summarize(jobId, summary) { const value = { schemaVersion: '1.0.0', jobId, completedAt: new Date().toISOString(), ...summary }; await writeJsonAtomic(path.join(this.jobDirectory(jobId), 'summary.json'), value); return value; }
  async summary(jobId) { await this.manifest(jobId); return readJson(path.join(this.jobDirectory(jobId), 'summary.json')); }
  async isCancelled(jobId) { await this.manifest(jobId); try { await fs.access(path.join(this.jobDirectory(jobId), 'cancelled.json')); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
  async cancel(jobId) { await this.manifest(jobId); const value = { schemaVersion: '1.0.0', jobId, requestedAt: new Date().toISOString() }; try { await fs.writeFile(path.join(this.jobDirectory(jobId), 'cancelled.json'), JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' }); return value; } catch (error) { if (error?.code !== 'EEXIST') throw error; return readJson(path.join(this.jobDirectory(jobId), 'cancelled.json')); } }
  async cancelMany(jobIds) {
    const ids = [...new Set((Array.isArray(jobIds) ? jobIds : []).map(id => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) throw new Error('至少选择一个 Job');
    await Promise.all(ids.map(id => this.manifest(id)));
    const cancellations = await Promise.all(ids.map(async id => ({ jobId: id, cancellation: await this.cancel(id) })));
    return { schemaVersion: '1.0.0', requested: ids.length, cancellations };
  }
  async status(jobId) { const [summary, cancelled, progress] = await Promise.all([this.summary(jobId), this.isCancelled(jobId), this.readProgress(jobId)]); if (summary?.status) return summary.status; if (cancelled) return 'cancelling'; if (progress.some(x => x.status === 'started')) return 'running'; return 'pending'; }
  async detail(jobId) { const [manifest, progress, summary, status, cancel, log] = await Promise.all([this.manifest(jobId), this.readProgress(jobId), this.summary(jobId), this.status(jobId), readJson(path.join(this.jobDirectory(jobId), 'cancelled.json')), this.readLog(jobId)]); return { schemaVersion: '1.0.0', jobId, status, manifest, progress, logs: log.items, logCount: log.total, summary, cancellation: cancel }; }
  async list() { let entries = []; try { entries = await fs.readdir(this.paths.jobs, { withFileTypes: true }); } catch (error) { if (error?.code !== 'ENOENT') throw error; } const values = await Promise.all(entries.filter(x => x.isDirectory()).map(async x => { try { const d = await this.detail(x.name); return { schemaVersion: '1.0.0', jobId: d.jobId, type: d.manifest.type, createdAt: d.manifest.createdAt, status: d.status, summary: d.summary }; } catch { return null; } })); return values.filter(Boolean).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  async delete(jobId) {
    const directory = this.jobDirectory(jobId);
    await this.manifest(jobId);
    const status = await this.status(jobId);
    if (!TERMINAL_JOB_STATUSES.has(status) || this.progressChains.has(String(jobId))) {
      throw new JobDeleteConflictError(jobId, status);
    }
    const [rootReal, directoryReal, stat] = await Promise.all([
      fs.realpath(this.paths.jobs),
      fs.realpath(directory),
      fs.lstat(directory),
    ]);
    const relative = path.relative(rootReal, directoryReal);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || stat.isSymbolicLink()) {
      throw new JobNotFoundError(jobId);
    }
    await fs.rm(directory, { recursive: true, force: false });
    return { schemaVersion: '1.0.0', jobId: String(jobId), status, deleted: true };
  }
  async deleteMany(jobIds) {
    const ids = [...new Set((Array.isArray(jobIds) ? jobIds : []).map(id => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) throw new Error('至少选择一个 Job');
    const states = await Promise.all(ids.map(async id => ({ id, status: await this.status(id) })));
    const active = states.find(item => !TERMINAL_JOB_STATUSES.has(item.status) || this.progressChains.has(item.id));
    if (active) throw new JobDeleteConflictError(active.id, active.status);
    const deleted = await Promise.all(ids.map(id => this.delete(id)));
    return { schemaVersion: '1.0.0', requested: ids.length, deleted };
  }
}

