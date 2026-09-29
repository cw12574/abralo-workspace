// One-time Windows upgrade from a release without the maintenance controller.
// Normal subsequent updates use workspace_maintenance instead.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'win32') throw new Error('This bootstrap is Windows-only.');
const [mode, input] = process.argv.slice(2);
const config = JSON.parse(readFileSync(input, 'utf8'));
const root = config.candidateRoot || config.candidate.root;
const { atomicJson, atomicText, alive, health, versionInfo, workspaceIdentity } = await import(pathToFileURL(join(root, 'dist/service/apps/service/src/maintenance-files.js')));
const Database = createRequire(join(root, 'package.json'))('better-sqlite3');
function identity(pid) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid original PID');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){[pscustomobject]@{pid=$p.ProcessId;executable=$p.ExecutablePath;command=$p.CommandLine;created=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}`], { windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error('Original process identity could not be verified.');
  return JSON.parse(result.stdout);
}
const legacyFingerprint = previous => createHash('sha256').update(['dist/service/apps/service/src/main.js', 'dist/service/apps/service/src/store.js', 'package.json', 'runtime/node.exe'].map(p => createHash('sha256').update(readFileSync(join(previous, p))).digest('hex')).join(':')).digest('hex');
const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const idle = db => db.prepare("SELECT COUNT(*) n FROM runs WHERE state NOT IN ('completed','cancelled','failed','interrupted','provider_limited')").get().n === 0 && db.prepare("SELECT COUNT(*) n FROM outbox WHERE status IN ('pending','new','claimed')").get().n === 0;

if (mode === '--prepare') {
  const installRoot = realpathSync(config.installRoot), data = realpathSync(config.data);
  const previousRoot = realpathSync(readFileSync(join(installRoot, 'current.txt'), 'utf8').trim());
  const original = identity(config.oldPid);
  const previous = { root: previousRoot, node: join(previousRoot, 'runtime/node.exe'), buildId: basename(previousRoot), fingerprint: legacyFingerprint(previousRoot) };
  if (original.executable.toLowerCase() !== previous.node.toLowerCase() || !original.command.includes(previousRoot)) throw new Error('Original service does not match the installed selection.');
  const h = await health(config.port);
  if (!h?.ok || h.buildId !== previous.buildId || h.dataDirectoryId !== workspaceIdentity(data)) throw new Error('Original service identity mismatch.');
  const candidate = versionInfo(root, installRoot);
  const id = randomUUID(), folder = join(data, 'maintenance', id);
  if (existsSync(join(data, 'maintenance/active.json'))) throw new Error('Another handoff is active.');
  mkdirSync(folder, { recursive: true });
  copyFileSync(fileURLToPath(import.meta.url), join(folder, 'bootstrap.mjs'));
  const job = { id, phase: 'prepared', action: 'update', bootstrap: true, installRoot, data, previous, candidate, original, oldPid: config.oldPid, port: config.port, dataDirectoryId: workspaceIdentity(data), idleTimeoutMs: config.idleTimeoutMs || 600000, startTimeoutMs: 60000, openAfter: !!config.openAfter, createdAt: new Date().toISOString() };
  atomicJson(join(folder, 'job.json'), job);
  console.log(JSON.stringify({ jobFile: join(folder, 'job.json'), id, phase: 'prepared' }));
} else if (mode === '--arm') {
  if (config.phase !== 'prepared') throw new Error('Prepare a fresh job.');
  const folder = dirname(input), lock = join(config.data, 'maintenance/active.json');
  const fd = openSync(lock, 'wx'); closeSync(fd);
  atomicJson(lock, { id: config.id });
  atomicJson(join(config.data, 'maintenance/latest.json'), { id: config.id });
  atomicJson(input, { ...config, phase: 'armed', updatedAt: new Date().toISOString() });
  const log = openSync(join(folder, 'helper.log'), 'a');
  try {
    const child = spawn(process.execPath, [join(folder, 'bootstrap.mjs'), '--run', input], { detached: true, windowsHide: true, stdio: ['ignore', log, log] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    console.log(JSON.stringify({ id: config.id, helperPid: child.pid, phase: 'armed' }));
  } finally { closeSync(log); }
} else if (mode === '--run') {
  const job = config, folder = dirname(input), lock = join(job.data, 'maintenance/active.json');
  const save = changes => atomicJson(input, { ...JSON.parse(readFileSync(input, 'utf8')), ...changes, updatedAt: new Date().toISOString() });
  const unlock = () => { if (existsSync(lock) && JSON.parse(readFileSync(lock, 'utf8')).id === job.id) unlinkSync(lock); };
  let stopped = false, child, db, beforeSchema, switched = false;
  const originals = new Map();
  async function launch(version, upgraded) {
    if (await health(job.port)) throw new Error('Service port is occupied.');
    const fd = openSync(join(folder, 'service.log'), 'a');
    try {
      child = spawn(version.node, [join(version.root, 'dist/service/apps/service/src/main.js')], { cwd: version.root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: { ...process.env, WORKSPACE_DATA_DIR: job.data, WORKSPACE_PORT: String(job.port), WORKSPACE_HOST: '127.0.0.1', WORKSPACE_BUILD_ID: version.buildId, WORKSPACE_INSTALL_ROOT: upgraded ? job.installRoot : '', WORKSPACE_MAINTENANCE_JOB: upgraded ? job.id : '' } });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
    } finally { closeSync(fd); }
    const end = Date.now() + job.startTimeoutMs;
    while (Date.now() < end) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Replacement exited during startup.');
      const h = await health(job.port);
      if (h?.ok && h.product === 'agent-workspace' && h.buildId === version.buildId && h.dataDirectoryId === job.dataDirectoryId && (!upgraded || h.maintenanceJob === job.id)) return;
      await delay(250);
    }
    throw new Error('Replacement health check timed out.');
  }
  async function stopCandidate() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    for (let n = 0; n < 100 && alive(child.pid); n++) await delay(100);
    if (alive(child.pid)) throw new Error('Replacement did not exit.');
  }
  try {
    if (job.phase !== 'armed' || JSON.parse(readFileSync(lock, 'utf8')).id !== job.id) throw new Error('Job is not armed.');
    if (versionInfo(root, job.installRoot).fingerprint !== job.candidate.fingerprint) throw new Error('Candidate changed.');
    atomicJson(join(folder, 'ready.json'), { id: job.id, pid: process.pid });
    save({ phase: 'draining' });
    db = new Database(join(job.data, 'workspace.db'), { fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    const deadline = Date.now() + job.idleTimeoutMs;
    let quietSince = 0;
    while (true) {
      if (Date.now() > deadline) throw new Error('Active work did not finish. Original service left running.');
      if (!alive(job.oldPid)) throw new Error('Original service exited before handoff.');
      if (!idle(db)) quietSince = 0;
      else if (!quietSince) quietSince = Date.now();
      if (quietSince && Date.now() - quietSince >= 5000) {
        const backup = join(folder, 'workspace.db');
        await db.backup(backup);
        const check = new Database(backup, { readonly: true });
        try { if (check.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Backup failed integrity check.'); } finally { check.close(); }
        if (JSON.stringify(identity(job.oldPid)) !== JSON.stringify(job.original) || legacyFingerprint(job.previous.root) !== job.previous.fingerprint) throw new Error('Original process or build changed.');
        if (versionInfo(root, job.installRoot).fingerprint !== job.candidate.fingerprint) throw new Error('Candidate changed while waiting.');
        // Prevent an old dispatcher from starting new work between this final
        // idle check and stopping its verified process. Never kill a process tree.
        db.exec('BEGIN IMMEDIATE');
        if (!idle(db)) { db.exec('ROLLBACK'); quietSince = 0; continue; }
        beforeSchema = schema(db);
        save({ phase: 'stopping', backup, schema: beforeSchema });
        process.kill(job.oldPid); stopped = true;
        for (let n = 0; n < 100 && alive(job.oldPid); n++) await delay(100);
        db.exec('COMMIT');
        if (alive(job.oldPid)) throw new Error('Original service did not stop.');
        break;
      }
      await delay(500);
    }
    db.close(); db = undefined;
    save({ phase: 'starting' });
    await launch(job.candidate, true);
    // Existing shortcuts target these scripts. Preserve their original contents.
    for (const name of ['launcher.mjs', 'Open Workspace.ps1', 'Background Workspace.ps1']) {
      const path = join(job.installRoot, name);
      originals.set(path, existsSync(path) ? readFileSync(path, 'utf8') : null);
      if (existsSync(path)) copyFileSync(path, join(folder, name + '.previous'));
    }
    switched = true;
    atomicText(join(job.installRoot, 'launcher.mjs'), readFileSync(join(root, 'scripts/installed-launcher.mjs'), 'utf8'));
    const quote = text => "'" + text.replaceAll("'", "''") + "'";
    for (const [name, background] of [['Open Workspace.ps1', false], ['Background Workspace.ps1', true]])
      atomicText(join(job.installRoot, name), `Start-Process -FilePath ${quote(job.candidate.node)} -ArgumentList @(${quote('"' + join(job.installRoot, 'launcher.mjs') + '"')}${background ? ",'--background'" : ''}) -WindowStyle Hidden\r\n`);
    atomicText(join(job.installRoot, 'current.txt'), root + '\n');
    save({ phase: 'succeeded' }); unlock();
    console.log('Installed and verified ' + job.candidate.buildId);
    if (job.openAfter) {
      const opener = spawn(job.candidate.node, [join(job.installRoot, 'launcher.mjs')], { cwd: job.installRoot, detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, WORKSPACE_DATA_DIR: job.data, WORKSPACE_PORT: String(job.port), WORKSPACE_MAINTENANCE_JOB: '' } });
      opener.on('error', error => console.error('App is healthy; reopening its window failed:', error.message)); opener.unref();
    }
  } catch (error) {
    if (db?.inTransaction) db.exec('ROLLBACK');
    if (db?.open) db.close();
    let detail = String(error.stack || error), recovered = false;
    if (stopped) {
      try {
        await stopCandidate();
        const check = new Database(join(job.data, 'workspace.db'), { readonly: true, fileMustExist: true });
        let compatible;
        try { compatible = beforeSchema && check.pragma('quick_check', { simple: true }) === 'ok' && JSON.stringify(schema(check)) === JSON.stringify(beforeSchema); } finally { check.close(); }
        if (!compatible || legacyFingerprint(job.previous.root) !== job.previous.fingerprint) throw new Error('Compatibility is uncertain; retain the backup and recovery lock.');
        if (switched) {
          atomicText(join(job.installRoot, 'current.txt'), job.previous.root + '\n');
          for (const [path, content] of originals) { if (content !== null) atomicText(path, content); else if (existsSync(path)) unlinkSync(path); }
        }
        await launch(job.previous, false);
        save({ phase: 'rolled-back', error: detail }); unlock(); recovered = true;
      } catch (fallback) { detail += '\nRecovery: ' + String(fallback); await stopCandidate().catch(() => {}); }
    }
    if (!recovered) { save({ phase: 'failed', error: detail }); if (!stopped) unlock(); }
    console.error(detail); process.exitCode = 1;
  }
} else throw new Error('Use --prepare CONFIG, --arm JOB, or --run JOB.');
