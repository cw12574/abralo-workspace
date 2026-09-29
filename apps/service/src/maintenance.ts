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
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ApiError, type Store } from './store.js';
import type { Supervisor } from './supervisor.js';
import {
  alive,
  atomicJson,
  readJson,
  terminalMaintenance,
  versionInfo,
  workspaceIdentity,
} from './maintenance-files.js';

export type MaintenanceConfig = {
  root: string;
  installRoot: string;
  shutdown: () => Promise<void>;
  idleTimeoutMs?: number;
  startTimeoutMs?: number;
};
export function createMaintenance(s: Store, sup: Supervisor, config?: MaintenanceConfig) {
  const base = join(s.dir, 'maintenance');
  const lock = join(base, 'active.json');
  let busy = false;
  let stopping = false;
  let ownJob: string | undefined;
  const startupJob = process.env.WORKSPACE_MAINTENANCE_JOB;
  let startupWaiting = !!startupJob;
  if (startupJob) {
    sup.maintenance = true;
    sup.maintenanceReadonly = true;
  }
  const jobFile = (id: string) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new ApiError(400, 'Invalid maintenance job');
    return join(base, id, 'job.json');
  };
  const load = (id: string) => readJson(jobFile(id));
  const save = (job: any) =>
    atomicJson(jobFile(job.id), { ...job, updatedAt: new Date().toISOString() });
  const status = () => {
    if (!existsSync(join(base, 'latest.json'))) return { supported: !!config, job: null };
    const job = load(readJson(join(base, 'latest.json')).id);
    const ready = join(base, job.id, 'ready.json');
    const stranded =
      existsSync(lock) &&
      !terminalMaintenance.has(job.phase) &&
      existsSync(ready) &&
      !alive(readJson(ready).pid);
    return {
      supported: !!config,
      job: {
        id: job.id,
        phase: stranded ? 'recovery-required' : job.phase,
        action: job.action,
        from: job.previous.buildId,
        to: job.candidate.buildId,
        error: stranded
          ? 'The handoff helper stopped. Inspect the saved job and backup before recovery.'
          : job.error,
        backup: job.backup,
        updatedAt: job.updatedAt,
      },
    };
  };
  function prepare(candidateRoot?: string) {
    if (!config) throw new ApiError(409, 'Maintenance requires the stable installed launcher.');
    if (existsSync(lock))
      throw new ApiError(409, 'A maintenance job is already active. Check its saved status.');
    const installRoot = realpathSync(config.installRoot);
    const selected = realpathSync(readFileSync(join(installRoot, 'current.txt'), 'utf8').trim());
    if (selected !== realpathSync(config.root))
      throw new ApiError(409, 'The installed selection differs from the running build.');
    const previous = versionInfo(config.root, installRoot);
    const candidate = versionInfo(candidateRoot || config.root, installRoot);
    // First version deliberately supports only explicitly compatible data formats.
    if (candidate.dataCompatibility !== previous.dataCompatibility)
      throw new ApiError(409, 'This update needs a separate data migration procedure.');
    const id = randomUUID();
    mkdirSync(join(base, id), { recursive: true, mode: 0o700 });
    const job = {
      id,
      phase: 'prepared',
      action: previous.root === candidate.root ? 'restart' : 'update',
      previous,
      candidate,
      installRoot,
      data: realpathSync(s.dir),
      dataDirectoryId: workspaceIdentity(s.dir),
      oldPid: process.pid,
      port: Number(new URL(sup.origin).port),
      idleTimeoutMs: config.idleTimeoutMs || 600000,
      startTimeoutMs: config.startTimeoutMs || 60000,
      createdAt: new Date().toISOString(),
    };
    save(job);
    atomicJson(join(base, 'latest.json'), { id });
    return status();
  }
  async function execute(id: string) {
    if (!config) throw new ApiError(409, 'Maintenance is unavailable in this process.');
    const job = load(id);
    if (job.phase !== 'prepared' || job.oldPid !== process.pid)
      throw new ApiError(409, 'Prepare a fresh maintenance job for this service.');
    if (
      versionInfo(job.candidate.root, job.installRoot).fingerprint !== job.candidate.fingerprint ||
      versionInfo(job.previous.root, job.installRoot).fingerprint !== job.previous.fingerprint
    )
      throw new ApiError(409, 'A prepared build changed. Prepare it again before approving.');
    try {
      const fd = openSync(lock, 'wx', 0o600);
      closeSync(fd);
    } catch {
      throw new ApiError(409, 'A maintenance job is already active.');
    }
    ownJob = id;
    try {
      atomicJson(lock, { id });
      const runner = join(base, id, 'helper.mjs');
      copyFileSync(join(config.root, 'scripts/maintenance-helper.mjs'), runner);
      save({ ...job, phase: 'armed' });
      const fd = openSync(join(base, id, 'helper.log'), 'a', 0o600);
      try {
        const child = spawn(process.execPath, [runner, jobFile(id)], {
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
      // Do not shut down on a successful spawn alone. The helper acknowledges separately.
      return {
        ...status(),
        message: 'Handoff started. Finish this turn; restart waits for active work to finish.',
      };
    } catch (error: any) {
      save({ ...job, phase: 'failed', error: error.message });
      unlinkSync(lock);
      ownJob = undefined;
      throw error;
    }
  }
  const tick = async () => {
    if (busy || stopping) return;
    busy = true;
    try {
      if (startupWaiting && startupJob) {
        const job = load(startupJob);
        if (['succeeded', 'rolled-back'].includes(job.phase) && !existsSync(lock)) {
          sup.maintenance = false;
          sup.maintenanceReadonly = false;
          startupWaiting = false;
          void sup.dispatch();
        }
        return;
      }
      if (!ownJob) return;
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
      if (!ready || !alive(ready.pid)) {
        if (Date.now() - Date.parse(job.updatedAt) > 15000) {
          save({
            ...job,
            phase: 'failed',
            error: 'The independent helper did not stay ready. The app was left running.',
          });
          if (existsSync(lock)) unlinkSync(lock);
        }
        return;
      }
      sup.maintenance = true;
      if (job.phase === 'armed') save({ ...job, phase: 'draining' });
      if (sup.active.size || sup.inflight.size) return;
      sup.maintenanceReadonly = true;
      const backup = join(base, ownJob, 'workspace.db');
      await s.db.backup(backup);
      const check = new Database(backup, { readonly: true });
      try {
        if (check.pragma('quick_check', { simple: true }) !== 'ok')
          throw new Error('Backup integrity check failed.');
      } finally {
        check.close();
      }
      if (load(ownJob).phase === 'failed' || !alive(ready.pid))
        throw new Error('The helper ended before shutdown. The app was left running.');
      const schema = s.db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
        )
        .all();
      // Freeze the job only after the backup succeeds. There is no in-place file replacement.
      save({ ...load(ownJob), phase: 'stopping', backup, schema });
      stopping = true;
      await config!.shutdown();
    } catch (error: any) {
      if (ownJob && !stopping) {
        save({ ...load(ownJob), phase: 'failed', error: error.message });
        if (existsSync(lock)) unlinkSync(lock);
        sup.maintenance = false;
        sup.maintenanceReadonly = false;
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 250);
  timer.unref();
  return { prepare, execute, status, close: () => clearInterval(timer) };
}
