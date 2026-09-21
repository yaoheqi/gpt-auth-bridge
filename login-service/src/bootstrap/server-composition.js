import { SettingsRepository } from '../repositories/settings-repository.js';
import { JobRunner } from '../services/job-runner.js';

/**
 * Build the runtime settings source and its startup barrier in one place.
 * Only operator defaults live here. Browser changes belong to the current request.
 */
export function createSettingsComposition({
  db,
  secrets,
  runtimePaths,
  defaults = {},
  normalizers = {},
  logger = console,
} = {}) {
  const repository = new SettingsRepository(db, secrets, { runtimePaths, defaults, normalizers });
  const ready = repository.initialize().then((report) => {
    logger?.log?.('[sot] sqlite runtime settings ready', {
      imported: report.imported,
      loaded: report.loaded,
      defaulted: report.defaulted,
    });
    return report;
  });
  return { repository, ready };
}

/**
 * Compose the account job execution layer over the formal SQLite job store.
 * Operational dependencies are injected so the composition can be tested
 * without importing the monolithic server or making network requests.
 */
export function createJobRunnerComposition({
  jobs,
  runtimePaths,
  ensureDatabase,
  getAllAccounts,
  getAccountById,
  hasSession,
  buildSessionHealthBatch,
  getConcurrency,
  getAccountStartGapMs,
  getProtocolSettings,
  runSessionHealthCheckForAccounts,
  runProtocolLoginForAccount = null,
  fixedProxyUrl,
  preflightAccount,
  processId = process.pid,
} = {}) {
  const sequentialJobRunner = new JobRunner({
    jobs,
    getConcurrency,
    getAccountStartGapMs,
    shouldStopOnEgressBlock: () => true,
    getProtocolEgressContext: () => {
      const settings = typeof getProtocolSettings === 'function' ? getProtocolSettings() : {};
      const proxyMode = settings?.proxyPool ? 'pool' : (fixedProxyUrl ? 'local' : 'direct');
      return { proxyMode, proxyPool: settings?.proxyPool || '', proxyUrl: proxyMode === 'local' ? fixedProxyUrl : '' };
    },
    preflightAccount,
    resolveAccounts: async manifest => {
      await ensureDatabase();
      if (manifest.type === 'session-health') {
        return buildSessionHealthBatch({
          body: {
            scope: manifest.scope,
            ids: manifest.ids,
            onlyWithSession: Boolean(manifest.options.onlyWithSession),
          },
          allAccounts: getAllAccounts(),
          findById: getAccountById,
          hasSession,
        }).accounts;
      }
      if (manifest.scope === 'all') return [...getAllAccounts()];
      return manifest.ids.map(id => getAccountById(id)).filter(Boolean);
    },
    runAccount: async (type, account, options = {}, context = {}) => {
      if (type === 'protocol-login' && typeof runProtocolLoginForAccount === 'function') {
        return runProtocolLoginForAccount(account, options, context);
      }
      return (await runSessionHealthCheckForAccounts([account], {
        reloginOnInvalid: options.reloginOnInvalid !== false,
        forceRelogin: Boolean(options.forceRelogin),
        loginOnly: type === 'protocol-login' || Boolean(options.loginOnly),
        onAccountLog: context.onLog,
      })).results[0];
    },
  });

  const defaultRunner = {
    active: sequentialJobRunner.active,
    start(manifest) {
      const existing = jobs.active.get(manifest.jobId);
      if (existing) return existing;
      const claim = jobs.claim(manifest.jobId, `runner-${processId}`);
      if (!claim.ok) return Promise.resolve(jobs.detail(manifest.jobId));
      const heartbeat = jobs.startLeaseHeartbeat?.(manifest.jobId, `runner-${processId}`);
      let tracked;
      tracked = Promise.resolve(sequentialJobRunner.start(manifest)).finally(() => {
        heartbeat?.stop?.();
        if (jobs.active.get(manifest.jobId) === tracked) jobs.active.delete(manifest.jobId);
      });
      jobs.active.set(manifest.jobId, tracked);
      return tracked;
    },
    async stop() {
      await Promise.allSettled([...sequentialJobRunner.active.values()]);
    },
  };

  return { sequentialJobRunner, jobRunner: defaultRunner };
}
