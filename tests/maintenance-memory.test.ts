import { it, expect, vi } from 'vitest';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { versionInfo, versionInfoAsync } from '../apps/service/src/maintenance-files.js';
import { createMaintenance } from '../apps/service/src/maintenance.js';
import { Store } from '../apps/service/src/store.js';
import { Supervisor } from '../apps/service/src/supervisor.js';
import { prepareStartupCompaction } from '../apps/service/src/maintenance-startup.js';
import { atomicJson, workspaceIdentity } from '../apps/service/src/maintenance-files.js';
import { randomUUID } from 'node:crypto';

function release() {
  const install = mkdtempSync(join(tmpdir(), 'bounded-update-'));
  const root = join(install, 'versions', 'old');
  for (const directory of [
    'scripts',
    'runtime',
    'dist/web',
    'dist/service/apps/service/src',
    'node_modules',
  ])
    mkdirSync(join(root, directory), { recursive: true });
  for (const file of [
    'scripts/launcher.mjs',
    'scripts/maintenance-helper.mjs',
    'dist/service/apps/service/src/main.js',
    'dist/service/apps/service/src/maintenance-files.js',
    'dist/web/index.html',
    'runtime/' + (process.platform === 'win32' ? 'node.exe' : 'node'),
  ])
    writeFileSync(join(root, file), 'fixture');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'agent-workspace' }));
  writeFileSync(
    join(root, 'release.json'),
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      maintenanceProtocol: 1,
      dataCompatibility: 'fixture',
    }),
  );
  writeFileSync(join(install, 'current.txt'), root);
  return { install, root };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await delay(100);
  }
  throw new Error('Timed out');
}

it('keeps the exact legacy fingerprint across chunk boundaries while the event loop stays responsive', async () => {
  const { root, install } = release();
  writeFileSync(join(root, 'runtime/large.dll'), Buffer.alloc(17 * 1024 ** 2 + 31, 7));
  const legacy = createHash('sha256');
  const walk = (path: string) => {
    if (statSync(path).isDirectory())
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    else {
      legacy.update(relative(root, path).replaceAll('\\', '/'));
      legacy.update(readFileSync(path));
    }
  };
  for (const part of ['dist', 'scripts', 'package.json', 'release.json', 'runtime'])
    walk(join(root, part));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const result = await versionInfoAsync(root, install);
    expect(result.fingerprint).toBe(legacy.digest('hex'));
    expect(ticks).toBeGreaterThan(1);
    writeFileSync(join(root, 'runtime/large.dll'), 'tampered');
    expect(versionInfo(root, install).fingerprint).not.toBe(result.fingerprint);
  } finally {
    clearInterval(timer);
  }
});

it('persists before verification and resumes across restart without a free-memory gate', async () => {
  const { root, install } = release();
  const store = new Store(join(install, 'data'));
  const supervisor = new Supervisor(store);
  const memory = vi.spyOn(os, 'freemem').mockReturnValue(1);
  const config = {
    root,
    installRoot: install,
    storageRetryMs: 50,
    shutdown: async () => {
      throw new Error('No installation authorized');
    },
  };
  let controller = createMaintenance(store, supervisor, config);
  try {
    const queued = controller.prepare().job!;
    expect(queued.phase).toBe('queued');
    expect(readFileSync(join(store.dir, 'maintenance', queued.id, 'job.json'), 'utf8')).toContain(
      'previousRoot',
    );
    expect(supervisor.maintenance).toBe(false);
    expect(supervisor.maintenanceReadonly).toBe(false);
    expect(controller.prepare().job?.id).toBe(queued.id);
    controller.close();
    controller = createMaintenance(store, supervisor, config);
    expect(controller.status().job?.id).toBe(queued.id);

    await until(() => controller.status().job?.phase === 'prepared');
    expect(supervisor.maintenance).toBe(false);
    expect(readFileSync(join(install, 'current.txt'), 'utf8')).toBe(root);
    expect(memory).not.toHaveBeenCalled();
  } finally {
    controller.close();
    memory.mockRestore();
    await supervisor.dispose();
    store.close();
  }
});

it('runs isolated build stages sequentially with one worker even when free RAM is low', async () => {
  const { runBuild } = await import(
    pathToFileURL(resolve('scripts/maintenance-build.mjs')).href
  );
  const folder = mkdtempSync(join(tmpdir(), 'update-pipeline-'));
  const sourceRoot = join(folder, 'original');
  mkdirSync(join(sourceRoot, 'node_modules'), { recursive: true });
  mkdirSync(join(folder, 'versions'));
  writeFileSync(join(sourceRoot, 'package.json'), '{"name":"agent-workspace"}');
  const stages: any[] = [],
    statuses: any[] = [];
  const memory = vi.spyOn(os, 'freemem').mockReturnValue(0);
  let running = false;
  const result = await runBuild(
    { sourceRoot, folder, installRoot: folder, pnpmCli: 'pinned.cjs' },
    {
      save: (state: any) => statuses.push(state),
      run: async (args: string[], options: any) => {
        expect(running).toBe(false);
        running = true;
        stages.push(args);
        expect(options.cwd).not.toBe(sourceRoot);
        expect(options.env.UV_THREADPOOL_SIZE).toBe('2');
        expect(options.env.NODE_OPTIONS).toBe('--max-old-space-size=768');
        if (args[0].endsWith('package.mjs')) {
          mkdirSync(args[1]);
          writeFileSync(join(args[1], 'fixture'), 'built');
        }
        await delay(1);
        running = false;
      },
      versionInfo: (root: string) => ({ root, fingerprint: 'verified' }),
    },
  );
  expect(stages).toHaveLength(5);
  expect(stages[1]).toContain('--maxWorkers=1');
  expect(stages[1]).toContain('--no-file-parallelism');
  expect(memory).not.toHaveBeenCalled();
  memory.mockRestore();
  expect(statuses.every((s) => s.phase === 'building')).toBe(true);
  expect(readFileSync(join(result.root, 'fixture'), 'utf8')).toBe('built');
});

it('compacts a copy preserving conversation, drafts, FTS, rowids and a recoverable original', async () => {
  const { compactDatabase, databaseEvidence } = await import(
    pathToFileURL(resolve('scripts/maintenance-compact.mjs')).href
  );
  const data = mkdtempSync(join(tmpdir(), 'verified-compact-'));
  const folder = join(data, 'maintenance');
  mkdirSync(folder);
  const path = join(data, 'workspace.db');
  const db = new Database(path);
  db.exec(
    'CREATE TABLE messages(seq INTEGER PRIMARY KEY, text TEXT); CREATE TABLE drafts(id TEXT PRIMARY KEY, data TEXT); CREATE VIRTUAL TABLE search USING fts5(text); CREATE TABLE scratch(payload BLOB);',
  );
  db.prepare('INSERT INTO messages VALUES(?,?)').run(42, 'Keep conversation history');
  db.prepare('INSERT INTO drafts(rowid,id,data) VALUES(?,?,?)').run(91, 'draft', 'Unsent words');
  db.prepare('INSERT INTO search(rowid,text) VALUES(?,?)').run(77, 'Searchable history');
  db.prepare('INSERT INTO scratch VALUES(zeroblob(?))').run(20 * 1024 ** 2);
  db.exec('DELETE FROM scratch');
  const before = databaseEvidence(db);
  db.close();
  const states: any[] = [];
  compactDatabase({
    Database,
    data,
    folder,
    save: (value: any) => states.push(value),
    freeDiskBytes: () => 10 * 1024 ** 3,
  });
  const last = states.at(-1).compaction;
  expect(last.state).toBe('switched');
  expect(last.recoveredBytes).toBeGreaterThan(16 * 1024 ** 2);
  const compact = new Database(path, { readonly: true });
  const backup = new Database(last.original, { readonly: true });
  try {
    expect(databaseEvidence(compact)).toEqual(before);
    expect(databaseEvidence(backup)).toEqual(before);
    expect(compact.prepare("SELECT rowid FROM search WHERE search MATCH 'history'").get()).toEqual({
      rowid: 77,
    });
  } finally {
    compact.close();
    backup.close();
  }
});

it('withholds replacement on failed verification or insufficient disk space', async () => {
  const { compactDatabase } = await import(
    pathToFileURL(resolve('scripts/maintenance-compact.mjs')).href
  );
  const data = mkdtempSync(join(tmpdir(), 'compact-withheld-'));
  const folder = join(data, 'maintenance');
  mkdirSync(folder);
  const path = join(data, 'workspace.db');
  const db = new Database(path);
  // A plain table with implicit rowid gaps can be renumbered by VACUUM. That
  // must fail closed, rather than silently change identities in unknown schemas.
  db.exec(
    "CREATE TABLE rows(value TEXT); INSERT INTO rows(rowid,value) VALUES(99,'keep'); CREATE TABLE scratch(payload BLOB);",
  );
  db.prepare('INSERT INTO scratch VALUES(zeroblob(?))').run(20 * 1024 ** 2);
  db.exec('DELETE FROM scratch');
  db.close();
  const states: any[] = [];
  const options = {
    Database,
    data,
    folder,
    save: (value: any) => states.push(value),
    freeDiskBytes: () => 0,
  };
  compactDatabase(options);
  expect(states.at(-1).compaction.state).toBe('skipped');
  // Inject a failed verification read through the DB constructor.
  let opens = 0;
  function BrokenDatabase(this: any, file: string, args: any) {
    const handle = new Database(file, args);
    opens++;
    if (opens === 2) {
      handle.close();
      throw new Error('Verification read failed');
    }
    return handle;
  }
  expect(() =>
    compactDatabase({ ...options, Database: BrokenDatabase, freeDiskBytes: () => 10 * 1024 ** 3 }),
  ).toThrow('Verification read failed');
  const original = new Database(path, { readonly: true });
  try {
    expect(original.prepare('SELECT rowid,value FROM rows').get()).toEqual({
      rowid: 99,
      value: 'keep',
    });
  } finally {
    original.close();
  }
});

it('archives recovery data with a verified round trip and retains the original if committing fails', async () => {
  const { archiveRecoveryCopy } = await import(
    pathToFileURL(resolve('scripts/maintenance-compact.mjs')).href
  );
  const { gunzipSync } = await import('node:zlib');
  const { existsSync } = await import('node:fs');
  const folder = mkdtempSync(join(tmpdir(), 'recovery-archive-'));
  const source = join(folder, 'recovery.db');
  const contents = Buffer.alloc(1024 * 1024 + 99, 42);
  writeFileSync(source, contents);
  await expect(
    archiveRecoveryCopy(source, () => {
      throw new Error('Disk full while committing');
    }),
  ).rejects.toThrow('Disk full');
  expect(readFileSync(source).equals(contents)).toBe(true);
  let archive: any;
  await archiveRecoveryCopy(source, (result: any) => {
    archive = result;
  });
  expect(existsSync(source)).toBe(false);
  expect(gunzipSync(readFileSync(archive.path)).equals(contents)).toBe(true);
  expect(archive.sha256).toBe(createHash('sha256').update(contents).digest('hex'));
});

it('bridges an older approved helper before Store opens and refuses a live-service handoff', async () => {
  const { copyFileSync, existsSync } = await import('node:fs');
  const { root, install } = release();
  copyFileSync(
    resolve('scripts/maintenance-compact.mjs'),
    join(root, 'scripts/maintenance-compact.mjs'),
  );
  // Resolve the real SQLite dependency without touching the installed app.
  const { symlinkSync } = await import('node:fs');
  const modules = join(root, 'node_modules');
  // Empty fixture directory only, no recursive removal.
  const { rmdirSync } = await import('node:fs');
  rmdirSync(modules);
  symlinkSync(resolve('node_modules'), modules, process.platform === 'win32' ? 'junction' : 'dir');
  const data = join(install, 'data');
  mkdirSync(data);
  const db = new Database(join(data, 'workspace.db'));
  db.exec(
    "CREATE TABLE drafts(id INTEGER PRIMARY KEY, text TEXT); INSERT INTO drafts VALUES(5,'Keep draft'); CREATE TABLE scratch(payload BLOB);",
  );
  db.prepare('INSERT INTO scratch VALUES(zeroblob(?))').run(20 * 1024 ** 2);
  db.exec('DELETE FROM scratch');
  db.close();
  const id = randomUUID();
  const folder = join(data, 'maintenance', id);
  mkdirSync(folder, { recursive: true });
  const backup = join(folder, 'workspace.db');
  copyFileSync(join(data, 'workspace.db'), backup);
  const file = join(folder, 'job.json');
  const job = {
    id,
    phase: 'starting',
    candidate: { root },
    data,
    installRoot: install,
    dataDirectoryId: workspaceIdentity(data),
    backup,
    schema: [],
    oldPid: process.pid,
  };
  atomicJson(file, job);
  atomicJson(join(data, 'maintenance/active.json'), { id });
  await expect(prepareStartupCompaction(root, data, install, id)).rejects.toThrow(
    'stopped maintenance',
  );
  expect(existsSync(join(folder, 'workspace.before-compaction.db'))).toBe(false);
  atomicJson(file, { ...job, oldPid: 2147483647 });
  await prepareStartupCompaction(root, data, install, id);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  expect(saved.compaction.state).toBe('switched');
  expect(saved.compactionHandledBy).toBe('startup');
  // New helpers record their completed work; startup never compacts twice.
  await prepareStartupCompaction(root, data, install, id);
  const kept = new Database(join(data, 'workspace.db'), { readonly: true });
  try {
    expect(kept.prepare('SELECT * FROM drafts').get()).toEqual({ id: 5, text: 'Keep draft' });
  } finally {
    kept.close();
  }
});
