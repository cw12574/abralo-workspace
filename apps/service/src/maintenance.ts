import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { ApiError, type Store } from './store.js';
import type { Supervisor } from './supervisor.js';
import {
  alive,
  atomicJson,
  freeDiskBytes,
  refreshInstalledLauncher,
  readJson,
  terminalMaintenance,
  versionInfoAsync,
  workspaceIdentity,
} from './maintenance-files.js';

export type MaintenanceConfig = {
  root: string;
  installRoot: string;
  shutdown: () => Promise<void>;
  shutdownTimeoutMs?: number;
  helperReadyTimeoutMs?: number;
  isReady?: () => boolean;
  startTimeoutMs?: number;
  storageRetryMs?: number;
};
export function createMaintenance(s: Store, sup: Supervisor, config?: MaintenanceConfig) {
  const base = join(s.dir, 'maintenance');
  const lock = join(base, 'active.json');
  let busy = false;
  let closed = false;
  let stopping = false;
  let ownJob: string | undefined;
  let recovering = false;
  let storageWait: { error: string; requiredBytes?: number; availableBytes?: number } | undefined;
  let retryAfter = 0;
  let pendingFailure: string | undefined;
  const reserveBytes = 256 * 1024 * 1024;
  const startupJob = process.env.WORKSPACE_MAINTENANCE_JOB;
  let startupWaiting = false;
  const jobFile = (id: string) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new ApiError(400, 'Invalid maintenance job');
    return join(base, id, 'job.json');
  };
  const load = (id: string) => readJson(jobFile(id));
  const save = (job: any) =>
    atomicJson(jobFile(job.id), { ...job, updatedAt: new Date().toISOString() });
  const queued = (job: any) => ['armed', 'draining'].includes(job.phase);
  if (
    startupJob &&
    existsSync(lock) &&
    readJson(lock).id === startupJob &&
    ['stopping', 'starting'].includes(load(startupJob).phase)
  ) {
    startupWaiting = true;
    sup.maintenance = true;
    sup.maintenanceReadonly = true;
  }
  // An approved queue belongs to the installation, not a particular process.
  // Queued updates yield to agents. Only an actual handoff gates dispatch.
  if (!startupWaiting && config && existsSync(lock)) {
    const job = load(readJson(lock).id);
    if (queued(job)) {
      ownJob = job.id;
      recovering = true;
    } else {
      sup.maintenance = true;
      sup.maintenanceReadonly = true;
    }
  }
  const status = () => {
    if (!existsSync(join(base, 'latest.json'))) return { supported: !!config, job: null };
    const job = load(readJson(join(base, 'latest.json')).id);
    const ready = join(base, job.id, 'ready.json');
    const stranded =
      existsSync(lock) &&
      !terminalMaintenance.has(job.phase) &&
      !queued(job) &&
      existsSync(ready) &&
      !alive(readJson(ready).pid);
    return {
      supported: !!config,
      job: {
        id: job.id,
        phase: stranded ? 'recovery-required' : job.phase,
        action: job.action,
        from: job.previous?.buildId,
        to: job.candidate?.buildId,
        message: queued(job)
          ? 'Update queued: waiting for an idle moment. Agents can keep working.'
          : job.message,
        stage: job.stage,
        waitingForMemory: job.phase === 'waiting-memory',
        requiredMemoryBytes: job.requiredMemoryBytes,
        availableMemoryBytes: job.availableMemoryBytes,
        compaction: job.compaction,
        error:
          pendingFailure ||
          storageWait?.error ||
          (stranded
            ? 'The handoff helper stopped. Inspect the saved job and backup before recovery.'
            : job.error),
        backup: job.backup,
        updatedAt: job.updatedAt,
        waitingForWork: queued(job) && !storageWait && !pendingFailure,
        waitingForSpace: !!storageWait,
        requiredBytes: storageWait?.requiredBytes,
        availableBytes: storageWait?.availableBytes,
        activeWork: queued(job) ? Math.max(sup.active.size, sup.inflight.size) : 0,
      },
    };
  };
  function prepare(candidateRoot?: string, sourceRoot?: string, pnpmCli?: string) {
    if (!config) throw new ApiError(409, 'Maintenance requires the stable installed launcher.');
    if (candidateRoot && sourceRoot)
      throw new ApiError(400, 'Choose a source build or an existing candidate.');
    if (existsSync(lock))
      throw new ApiError(409, 'A maintenance job is already active. Check its saved status.');
    const latest = status().job;
    if (latest && ['queued', 'waiting-memory', 'building', 'verifying'].includes(latest.phase))
      return status();
    const installRoot = realpathSync(config.installRoot);
    const selected = realpathSync(readFileSync(join(installRoot, 'current.txt'), 'utf8').trim());
    if (selected !== realpathSync(config.root))
      throw new ApiError(409, 'The installed selection differs from the running build.');
    if (sourceRoot) {
      sourceRoot = realpathSync(sourceRoot);
      const pkg = readJson(join(sourceRoot, 'package.json'));
      if (pkg.name !== 'agent-workspace')
        throw new ApiError(400, 'Choose the Abralo source directory.');
      pnpmCli = realpathSync(
        pnpmCli ||
          process.env.WORKSPACE_PNPM_CLI ||
          join(sourceRoot, 'node_modules/pnpm/bin/pnpm.cjs'),
      );
      const manager = readJson(join(dirname(dirname(pnpmCli)), 'package.json'));
      if (manager.name !== 'pnpm' || `pnpm@${manager.version}` !== pkg.packageManager)
        throw new ApiError(400, 'Use the source repository pinned pnpm entry point.');
    }
    const id = randomUUID();
    mkdirSync(join(base, id), { recursive: true, mode: 0o700 });
    // Persist the request BEFORE any recursive scan, build or fingerprint.
    save({
      id,
      phase: 'queued',
      message: 'Update preparation queued. Agents can keep working.',
      action:
        sourceRoot || (candidateRoot && realpathSync(candidateRoot) !== selected)
          ? 'update'
          : 'restart',
      previousRoot: selected,
      candidateRoot: candidateRoot ? realpathSync(candidateRoot) : selected,
      sourceRoot,
      pnpmCli,
      installRoot,
      data: realpathSync(s.dir),
      dataDirectoryId: workspaceIdentity(s.dir),
      oldPid: process.pid,
      port: Number(new URL(sup.origin).port),
      shutdownTimeoutMs: config.shutdownTimeoutMs || 60000,
      startTimeoutMs: config.startTimeoutMs || 60000,
      createdAt: new Date().toISOString(),
    });
    atomicJson(join(base, 'latest.json'), { id });
    return status();
  }
  async function prepareTick() {
    const latest = status().job;
    if (
      !config ||
      !latest ||
      !['queued', 'waiting-memory', 'building', 'verifying'].includes(latest.phase)
    )
      return;
    let job = load(latest.id);
    try {
      if (
        realpathSync(readFileSync(join(config.installRoot, 'current.txt'), 'utf8').trim()) !==
        job.previousRoot
      )
        throw new Error(
          'The selected installation changed during preparation. Prepare a fresh job.',
        );
      if (job.sourceRoot) {
        const folder = join(base, job.id);
        const result = join(folder, 'build-result.json');
        if (!existsSync(result)) {
          const stateFile = join(folder, 'build-status.json');
          const state = existsSync(stateFile) ? readJson(stateFile) : undefined;
          if (state?.phase === 'failed') throw new Error(state.message);
          if (state) save({ ...job, ...state });
          const claim = join(folder, 'build-worker.json');
          if (!existsSync(claim) || !alive(readJson(claim).pid)) {
            const runner = join(config.root, 'scripts/maintenance-build.mjs');
            const moduleUrl = new URL(
              import.meta.url.endsWith('.ts') ? './maintenance-files.ts' : './maintenance-files.js',
              import.meta.url,
            ).href;
            const fd = openSync(join(folder, 'preparation.log'), 'a', 0o600);
            try {
              const child = spawn(
                process.execPath,
                ['--max-old-space-size=128', runner, jobFile(job.id), moduleUrl],
                { detached: true, windowsHide: true, stdio: ['ignore', fd, fd] },
              );
              await new Promise<void>((resolve, reject) => {
                child.once('spawn', resolve);
                child.once('error', reject);
              });
              child.unref();
            } finally {
              closeSync(fd);
            }
            retryAfter = Date.now() + 1000;
          }
          return;
        }
        job = { ...job, candidateRoot: readJson(result).root };
      }
      save({
        ...job,
        phase: 'verifying',
        message: 'Verifying the prepared release in a background helper.',
      });
      const previous = await versionInfoAsync(job.previousRoot, job.installRoot);
      const candidate =
        job.candidateRoot === job.previousRoot
          ? previous
          : await versionInfoAsync(job.candidateRoot, job.installRoot);
      if (closed) return;
      if (candidate.dataCompatibility !== previous.dataCompatibility)
        throw new Error('This update needs a separate data migration procedure.');
      save({
        ...job,
        previous,
        candidate,
        phase: 'prepared',
        message: 'Update prepared and verified. Ready for installation approval.',
        requiredMemoryBytes: undefined,
        availableMemoryBytes: undefined,
      });
    } catch (error: any) {
      if (!closed) {
        if (error.code === 'ERR_WORKER_OUT_OF_MEMORY' || error.code === 'ENOMEM') {
          save({
            ...job,
            phase: 'queued',
            message: 'Update queued after memory pressure. Verification will retry automatically.',
          });
          retryAfter = Date.now() + 30000;
        } else
          save({
            ...job,
            phase: 'failed',
            error: error.message,
            message: 'Update preparation failed. The app is still running.',
          });
      }
    }
  }
  async function validate(job: any) {
    if (!config) throw new ApiError(409, 'Maintenance is unavailable in this process.');
    const selected = realpathSync(
      readFileSync(join(config.installRoot, 'current.txt'), 'utf8').trim(),
    );
    if (
      selected !== realpathSync(config.root) ||
      selected !== job.previous.root ||
      realpathSync(s.dir) !== job.data ||
      workspaceIdentity(s.dir) !== job.dataDirectoryId
    )
      throw new ApiError(
        409,
        'The installation or workspace changed. Prepare a fresh job before approving.',
      );
    // Prepared approvals survive restarts. Rebind the process only after checking
    // the exact selected build, workspace identity and both saved fingerprints.
    if (
      (await versionInfoAsync(job.candidate.root, job.installRoot)).fingerprint !==
        job.candidate.fingerprint ||
      (await versionInfoAsync(job.previous.root, job.installRoot)).fingerprint !==
        job.previous.fingerprint
    )
      throw new ApiError(409, 'A prepared build changed. Prepare it again before approving.');
  }
  async function startHelper(job: any) {
    await validate(job);
    const runner = join(base, job.id, 'helper.mjs');
    copyFileSync(join(config!.root, 'scripts/maintenance-helper.mjs'), runner);
    save({
      ...job,
      phase: 'armed',
      oldPid: process.pid,
      port: Number(new URL(sup.origin).port),
      helperId: randomUUID(),
      helperStartedAt: new Date().toISOString(),
      helperAttempts: (job.helperAttempts || 0) + 1,
    });
    const fd = openSync(join(base, job.id, 'helper.log'), 'a', 0o600);
    try {
      const child = spawn(process.execPath, [runner, jobFile(job.id)], {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
    } finally {
      closeSync(fd);
    }
  }
  async function execute(id: string) {
    if (!config) throw new ApiError(409, 'Maintenance is unavailable in this process.');
    const job = load(id);
    if (
      ['armed', 'draining', 'stopping', 'starting', 'succeeded', 'rolled-back'].includes(job.phase)
    )
      return {
        ...status(),
        message: 'This handoff was already requested. No duplicate was started.',
      };
    if (job.phase !== 'prepared')
      throw new ApiError(409, 'This maintenance job cannot run. Prepare a fresh job.');
    await validate(job);
    try {
      const fd = openSync(lock, 'wx', 0o600);
      closeSync(fd);
    } catch {
      throw new ApiError(409, 'A maintenance job is already active.');
    }
    ownJob = id;
    try {
      atomicJson(lock, { id });
      save({ ...job, phase: 'armed' });
      await startHelper(load(id));
      // Do not shut down on a successful spawn alone. The helper acknowledges separately.
      return {
        ...status(),
        message:
          'Update queued. Finish this turn; it starts automatically when active work finishes.',
      };
    } catch (error: any) {
      try {
        save({ ...job, phase: 'failed', error: error.message });
      } catch (reportError) {
        console.error('Could not persist maintenance startup failure:', reportError);
      } finally {
        if (existsSync(lock)) unlinkSync(lock);
        ownJob = undefined;
        sup.maintenance = false;
      }
      throw error;
    }
  }
  const tick = async () => {
    if (
      closed ||
      busy ||
      stopping ||
      Date.now() < retryAfter ||
      (config?.isReady && !config.isReady())
    )
      return;
    busy = true;
    try {
      if (startupWaiting && startupJob) {
        const job = load(startupJob);
        if (['succeeded', 'rolled-back'].includes(job.phase) && !existsSync(lock)) {
          if (config)
            refreshInstalledLauncher(
              config.root,
              config.installRoot,
              s.dir,
              Number(new URL(sup.origin).port),
            );
          sup.maintenance = false;
          sup.maintenanceReadonly = false;
          startupWaiting = false;
          void sup.dispatch();
          if (config && job.compactionHandledBy === 'startup' && job.phase === 'succeeded') {
            const fd = openSync(join(base, job.id, 'archive.log'), 'a', 0o600);
            try {
              const moduleUrl = new URL(
                import.meta.url.endsWith('.ts')
                  ? './maintenance-files.ts'
                  : './maintenance-files.js',
                import.meta.url,
              ).href;
              const child = spawn(
                process.execPath,
                [
                  '--max-old-space-size=64',
                  join(config.root, 'scripts/maintenance-compact.mjs'),
                  '--archive',
                  jobFile(job.id),
                  moduleUrl,
                ],
                { detached: true, windowsHide: true, stdio: ['ignore', fd, fd] },
              );
              child.on('error', (error) =>
                console.error('Recovery archiving deferred; originals retained:', error),
              );
              child.unref();
            } finally {
              closeSync(fd);
            }
          }
        }
        return;
      }
      if (!ownJob) {
        await prepareTick();
        return;
      }
      if (pendingFailure) throw new Error(pendingFailure);
      if (recovering) {
        await startHelper(load(ownJob));
        recovering = false;
        return;
      }
      const job = load(ownJob);
      const readyPath = join(base, ownJob, 'ready.json');
      if (terminalMaintenance.has(job.phase)) {
        sup.maintenance = false;
        sup.maintenanceReadonly = false;
        ownJob = undefined;
        void sup.dispatch();
        return;
      }
      const ready = existsSync(readyPath) && readJson(readyPath);
      if (!ready || ready.helperId !== job.helperId || !alive(ready.pid)) {
        if (
          Date.now() - Date.parse(job.helperStartedAt || job.updatedAt) >
          (config?.helperReadyTimeoutMs || 15000)
        ) {
          if ((job.helperAttempts || 0) >= 3)
            throw new Error(
              'The independent helper could not start after three attempts. The app was left running.',
            );
          await startHelper(job);
        }
        return;
      }
      if (job.phase === 'armed') save({ ...job, phase: 'draining', helperAttempts: 0 });
      if (sup.active.size || sup.inflight.size) return;
      const folder = join(base, ownJob);
      const partial = join(folder, 'workspace.db.partial');
      const cleanupPartial = () => {
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
          const path = partial + suffix;
          if (existsSync(path)) unlinkSync(path);
        }
      };
      // A pre-shutdown crash may leave an incomplete backup. It is never the
      // live database or a verified rollback backup, and can be recreated.
      cleanupPartial();
      // A crash can also occur after verification but before the job commits
      // the backup. Only committed backups belong to a completed handoff.
      if (!job.backup) {
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
          const path = join(folder, 'workspace.db') + suffix;
          if (existsSync(path)) unlinkSync(path);
        }
      }
      const requiredBytes =
        Number(s.db.pragma('page_count', { simple: true })) *
          Number(s.db.pragma('page_size', { simple: true })) +
        reserveBytes;
      const availableBytes = freeDiskBytes(folder);
      if (availableBytes < requiredBytes) {
        storageWait = {
          error: 'Update queued: more free disk space is needed for a verified backup.',
          requiredBytes,
          availableBytes,
        };
        retryAfter = Date.now() + (config?.storageRetryMs || 30000);
        return;
      }
      storageWait = undefined;
      // Claim the idle handoff synchronously, before the first backup await.
      sup.maintenance = true;
      sup.maintenanceReadonly = true;
      const backup = join(base, ownJob, 'workspace.db');
      try {
        await s.db.backup(partial, {
          progress: () => {
            if (freeDiskBytes(folder) < reserveBytes) {
              const error = Object.assign(new Error('Backup paused to preserve free disk space.'), {
                code: 'ENOSPC',
              });
              throw error;
            }
            return 128;
          },
        });
      } catch (error) {
        cleanupPartial();
        throw error;
      }
      const check = new Database(partial, { readonly: true });
      try {
        if (check.pragma('quick_check', { simple: true }) !== 'ok')
          throw new Error('Backup integrity check failed.');
      } finally {
        check.close();
      }
      renameSync(partial, backup);
      if (load(ownJob).phase === 'failed' || !alive(ready.pid)) {
        // The backup is complete, but no shutdown has begun. Recover the helper
        // on the next tick and take a fresh backup rather than abandon approval.
        sup.maintenanceReadonly = false;
        sup.maintenance = false;
        return;
      }
      const schema = s.db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
        )
        .all();
      // Freeze the job only after the backup succeeds. There is no in-place file replacement.
      save({
        ...load(ownJob),
        phase: 'stopping',
        compactOnHandoff: true,
        stoppingAt: new Date().toISOString(),
        backup,
        schema,
      });
      stopping = true;
      await config!.shutdown();
    } catch (error: any) {
      if (ownJob && !stopping) {
        sup.maintenanceReadonly = false;
        sup.maintenance = false;
        retryAfter = Date.now() + (config?.storageRetryMs || 30000);
        if (['ENOSPC', 'SQLITE_FULL', 'EDQUOT'].includes(error.code)) {
          // Keep the durable approval. Do not try to report a full disk by
          // writing to it, and never let a rejected timer crash the service.
          storageWait = { error: 'Update queued: backup is waiting for free disk space.' };
        } else {
          pendingFailure = error.message;
          try {
            save({ ...load(ownJob), phase: 'failed', error: pendingFailure });
            if (existsSync(lock)) unlinkSync(lock);
            sup.maintenance = false;
            ownJob = undefined;
            recovering = false;
            pendingFailure = undefined;
            void sup.dispatch();
          } catch (reportError) {
            // Preserve the lock and retry recording the failure. Failure to
            // persist an error must not bring down an otherwise healthy app.
            console.error('Could not persist maintenance failure; will retry:', reportError);
          }
        }
      } else {
        retryAfter = Date.now() + (config?.storageRetryMs || 30000);
        console.error('Maintenance check failed; will retry:', error);
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 250);
  timer.unref();
  return {
    prepare,
    execute,
    status,
    close: () => {
      closed = true;
      clearInterval(timer);
    },
  };
}
