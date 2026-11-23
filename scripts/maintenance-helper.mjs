// Short-lived, detached handoff worker. Never stops an arbitrary PID. Compaction only runs after the service exits.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { closeSync, existsSync, openSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const file = process.argv[2];
const initial = JSON.parse(readFileSync(file, 'utf8'));
const {
  alive,
  atomicJson,
  atomicText,
  health,
  readJson,
  versionInfo,
  workspaceIdentity,
  refreshInstalledLauncher,
  freeDiskBytes,
} = await import(
  pathToFileURL(join(initial.previous.root, 'dist/service/apps/service/src/maintenance-files.js'))
);
const folder = dirname(file);
const lock = join(initial.data, 'maintenance', 'active.json');
const owns = () =>
  existsSync(lock) &&
  readJson(lock).id === initial.id &&
  readJson(file).helperId === initial.helperId;
const save = (change) =>
  atomicJson(file, { ...readJson(file), ...change, updatedAt: new Date().toISOString() });
const unlock = () => {
  if (owns()) unlinkSync(lock);
};
let child;
let switched = false;
let stopped = false;
const matches = (h, version) =>
  h?.ok &&
  h.product === 'agent-workspace' &&
  h.buildId === version.buildId &&
  h.dataDirectoryId === initial.dataDirectoryId &&
  h.maintenanceJob === initial.id;
async function launch(version) {
  if (await health(initial.port))
    throw new Error('The service port is occupied; no other process was stopped.');
  const fd = openSync(join(folder, 'service.log'), 'a', 0o600);
  try {
    child = spawn(version.node, [join(version.root, 'dist/service/apps/service/src/main.js')], {
      cwd: version.root,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        WORKSPACE_DATA_DIR: initial.data,
        WORKSPACE_PORT: String(initial.port),
        WORKSPACE_HOST: '127.0.0.1',
        WORKSPACE_BUILD_ID: version.buildId,
        WORKSPACE_INSTALL_ROOT: initial.installRoot,
        WORKSPACE_MAINTENANCE_JOB: initial.id,
      },
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  const end = Date.now() + initial.startTimeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('Prepared service exited during startup.');
    const h = await health(initial.port);
    if (matches(h, version)) return;
    if (h && !h.occupied)
      throw new Error('A different build or workspace answered the health check.');
    await delay(200);
  }
  throw new Error('Prepared service did not become healthy before the timeout.');
}
async function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // Only our own paused candidate, never the original service or its agent tree.
  child.kill();
  const end = Date.now() + 10000;
  while (alive(child.pid) && Date.now() < end) await delay(100);
  if (alive(child.pid)) throw new Error('Candidate did not exit; automatic fallback was withheld.');
}
function compatibleDatabase() {
  const job = readJson(file);
  if (
    !job.backup ||
    !job.schema ||
    initial.previous.dataCompatibility !== initial.candidate.dataCompatibility
  )
    return false;
  const require = createRequire(join(initial.previous.root, 'package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(join(initial.data, 'workspace.db'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return (
      db.pragma('quick_check', { simple: true }) === 'ok' &&
      JSON.stringify(
        db
          .prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
          )
          .all(),
      ) === JSON.stringify(job.schema)
    );
  } finally {
    db.close();
  }
}
try {
  if (!owns() || !['armed', 'draining'].includes(initial.phase))
    throw new Error('Handoff is not armed.');
  if (
    versionInfo(initial.candidate.root, initial.installRoot).fingerprint !==
    initial.candidate.fingerprint
  )
    throw new Error('Prepared release changed before handoff.');
  if (!owns()) process.exit(0);
  atomicJson(join(folder, 'ready.json'), {
    pid: process.pid,
    id: initial.id,
    helperId: initial.helperId,
  });
  while (alive(initial.oldPid)) {
    if (!owns()) process.exit(0);
    const job = readJson(file);
    if (job.phase === 'failed') {
      unlock();
      process.exit(1);
    }
    // Work may take hours. Only shutdown, once explicitly started, has a deadline.
    if (
      job.phase === 'stopping' &&
      Date.now() - Date.parse(job.stoppingAt || job.updatedAt) >
        (initial.shutdownTimeoutMs || 60000)
    )
      throw new Error('Shutdown did not finish in time. The original service was not killed.');
    await delay(200);
  }
  if (!owns()) process.exit(0);
  // Before the verified handoff, restart the selected service automatically.
  // It reclaims the same approved job and fences this helper. No user relaunch
  // and no new approval are needed; never launch the candidate without backup.
  if (['armed', 'draining'].includes(readJson(file).phase)) {
    if (
      realpathSync(readFileSync(join(initial.installRoot, 'current.txt'), 'utf8').trim()) !==
        initial.previous.root ||
      workspaceIdentity(initial.data) !== initial.dataDirectoryId ||
      versionInfo(initial.previous.root, initial.installRoot).fingerprint !==
        initial.previous.fingerprint
    )
      throw new Error(
        'The selected build or workspace changed; automatic service recovery was withheld.',
      );
    const restarts = (readJson(file).serviceRestarts || 0) + 1;
    if (restarts > 3)
      throw new Error(
        'The service repeatedly stopped before handoff. Inspect the service log before retrying.',
      );
    save({ serviceRestarts: restarts });
    await launch(initial.previous);
    process.exit(0);
  }
  if (readJson(file).phase !== 'stopping')
    throw new Error(
      'Original service ended before completing its handoff. Use the stable launcher to recover.',
    );
  stopped = true;
  if (
    versionInfo(initial.candidate.root, initial.installRoot).fingerprint !==
    initial.candidate.fingerprint
  )
    throw new Error('Prepared release changed while waiting for active work.');
  if (readJson(file).compactOnHandoff) {
    const { compactDatabase } = await import(
      pathToFileURL(join(initial.previous.root, 'scripts/maintenance-compact.mjs'))
    );
    const require = createRequire(join(initial.previous.root, 'package.json'));
    compactDatabase({
      Database: require('better-sqlite3'),
      data: initial.data,
      folder,
      save,
      freeDiskBytes,
    });
  }
  save({ phase: 'starting' });
  await launch(initial.candidate);
  atomicText(join(initial.installRoot, 'current.txt'), initial.candidate.root + '\n');
  switched = true;
  refreshInstalledLauncher(initial.candidate.root, initial.installRoot, initial.data, initial.port);
  save({ phase: 'succeeded' });
  unlock();
  // Healthy service has resumed. Archive recovery copies with bounded buffers,
  // outside the maintenance window; failure leaves the original copies intact.
  if (readJson(file).compactOnHandoff) {
    try {
      const { archiveMaintenanceBackups } = await import(
        pathToFileURL(join(initial.previous.root, 'scripts/maintenance-compact.mjs'))
      );
      const { setPriority, constants } = await import('node:os');
      try {
        setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {}
      await archiveMaintenanceBackups(file, readJson, save);
    } catch (error) {
      console.error('Recovery archive deferred; uncompressed backup retained:', error);
    }
  }
} catch (error) {
  if (!owns()) process.exit(0);
  let message = String(error.message || error);
  let recovered = false;
  if (stopped) {
    try {
      await stopChild();
      if (!compatibleDatabase())
        throw new Error(
          'Data compatibility could not be verified. Keep the backup and inspect the saved job before recovery.',
        );
      if (
        versionInfo(initial.previous.root, initial.installRoot).fingerprint !==
        initial.previous.fingerprint
      )
        throw new Error('The previous build changed; automatic fallback was withheld.');
      if (switched)
        atomicText(join(initial.installRoot, 'current.txt'), initial.previous.root + '\n');
      if (switched)
        refreshInstalledLauncher(
          initial.previous.root,
          initial.installRoot,
          initial.data,
          initial.port,
        );
      save({ phase: 'starting', error: message });
      await launch(initial.previous);
      save({ phase: 'rolled-back', error: message });
      unlock();
      recovered = true;
    } catch (fallback) {
      message += ' Recovery: ' + String(fallback.message || fallback);
      try {
        await stopChild();
      } catch {}
    }
  }
  if (!recovered) {
    save({ phase: 'failed', error: message });
    // After shutdown, retain the lock on an unsafe recovery. The stable entry
    // refuses to launch blindly and tells the owner where the job/backup lives.
    if (!stopped) unlock();
  }
  console.error(message);
  process.exitCode = 1;
}
