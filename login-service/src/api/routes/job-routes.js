import { createJobId, normalizeJobManifest, SUPPORTED_JOB_TYPES } from '../../lib/job-contract.js';
import { JobConflictError, JobDeleteConflictError, JobNotFoundError } from '../../services/job-service.js';
import { randomBytes } from 'node:crypto';

function errorResponse(res, error) { const status = error instanceof JobNotFoundError || error?.statusCode === 404 ? 404 : error instanceof JobConflictError || error instanceof JobDeleteConflictError || error?.statusCode === 409 ? 409 : error?.statusCode || 400; const code = error?.code || 'INVALID_REQUEST'; const message = error instanceof JobDeleteConflictError ? 'Only terminal jobs can be deleted' : status === 404 ? 'Job not found' : status === 409 ? 'Job conflicts with an existing operation' : error?.message || 'Invalid job request'; return res.status(status).json({ ok: false, error: { code, message } }); }
function apiJob(job) {
  if (!job || typeof job !== 'object') return job;
  return { ...job, status: job.status === 'succeeded' ? 'completed' : job.status };
}
export function registerJobRoutes(app, { requireAdmin, jobs, runner = null, getConcurrency = null }) {
  app.post('/api/v2/jobs', requireAdmin, async (req, res) => {
    try {
      const options = { ...(req.body?.options || {}) };
      if (typeof getConcurrency === 'function') {
        options.concurrency = getConcurrency(String(req.body?.type || ''), options.concurrency);
      }
      const generatedJobId = `${createJobId(String(req.body?.type || 'job'))}-${randomBytes(3).toString('hex')}`;
      const input = { ...req.body, jobId: req.body?.jobId || generatedJobId, options };
      const manifest = normalizeJobManifest(input);
      if (!['protocol-login', 'session-health'].includes(String(manifest.type || ''))) {
        const error = new Error('仅支持 protocol-login 和 session-health 任务');
        error.statusCode = 400;
        throw error;
      }
      const created = await jobs.create(manifest);
      const startResult = runner?.start
        ? runner.start(created.manifest)
        : jobs?.start
          ? jobs.start(created.manifest.jobId)
          : null;
      if (startResult) Promise.resolve(startResult).catch(() => {});
      res.status(created.resumed ? 200 : 202).json({ ok: true, resumed: created.resumed, job: apiJob(await jobs.detail(manifest.jobId)), supportedTypes: SUPPORTED_JOB_TYPES });
    } catch (error) { errorResponse(res, error); }
  });
  app.get('/api/v2/jobs', requireAdmin, async (_req, res) => { try { const items = await jobs.list(); res.json({ schemaVersion: '1.0.0', ok: true, jobs: items, total: items.length }); } catch (e) { errorResponse(res, e); } });
  app.get('/api/v2/jobs/:id', requireAdmin, async (req, res) => { try { res.json({ schemaVersion: '1.0.0', ok: true, job: apiJob(await jobs.detail(req.params.id)) }); } catch (e) { errorResponse(res, e); } });
  app.delete('/api/v2/jobs/:id', requireAdmin, async (req, res) => { try { res.json({ schemaVersion: '1.0.0', ok: true, deletion: await jobs.delete(req.params.id) }); } catch (e) { errorResponse(res, e); } });
  app.post('/api/v2/jobs/batch-delete', requireAdmin, async (req, res) => { try { res.json({ schemaVersion: '1.0.0', ok: true, deletion: await jobs.deleteMany(req.body?.ids) }); } catch (e) { errorResponse(res, e); } });
  app.get('/api/v2/jobs/:id/events', requireAdmin, async (req, res) => {
    try { await jobs.manifest(req.params.id); } catch (e) { errorResponse(res, e); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let sent = Math.max(0, Number.parseInt(String(req.headers['last-event-id'] || req.query.after || '0'), 10) || 0);
    const send = event => { res.write(`id: ${event.sequence}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`); sent = event.sequence; };
    const pump = async () => { const events = await jobs.readProgress(req.params.id); events.filter(x => x.sequence > sent).forEach(send); const status = await jobs.status(req.params.id); if (['completed','failed','cancelled'].includes(status)) { res.write(`event: done\ndata: ${JSON.stringify({ schemaVersion: '1.0.0', jobId: req.params.id, status })}\n\n`); res.end(); return true; } return false; };
    if (await pump()) return;
    const timer = setInterval(() => pump().catch(() => { clearInterval(timer); res.end(); }).then(done => { if (done) clearInterval(timer); }), 250);
    req.on('close', () => clearInterval(timer));
  });
  app.post('/api/v2/jobs/:id/cancel', requireAdmin, async (req, res) => { try { const cancellation = await jobs.cancel(req.params.id); res.status(202).json({ schemaVersion: '1.0.0', ok: true, cancellation, semantics: 'The current account operation is not interrupted; no subsequent account starts.' }); } catch (e) { errorResponse(res, e); } });
  app.post('/api/v2/jobs/batch-cancel', requireAdmin, async (req, res) => { try { const cancellation = await jobs.cancelMany(req.body?.ids); res.status(202).json({ schemaVersion: '1.0.0', ok: true, cancellation, semantics: 'The current account operation is not interrupted; no subsequent account starts.' }); } catch (e) { errorResponse(res, e); } });
}
