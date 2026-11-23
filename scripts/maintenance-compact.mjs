// Runs only in the handoff helper AFTER the service exits. No live DB replacement.
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { constants, setPriority } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { createGzip, createGunzip } from 'node:zlib';

const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
export function databaseEvidence(db) {
  db.pragma('cache_size = -4096');
  db.pragma('mmap_size = 0');
  const integrity = db.pragma('integrity_check');
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok')
    throw new Error('Database integrity check failed.');
  const schema = db
    .prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name')
    .all();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all();
  const contents = {};
  for (const { name } of tables) {
    // Include implicit rowids: outbox ordering and FTS depend on their identity.
    const columns = db.pragma(`table_xinfo(${quote(name)})`);
    const names = columns.map((c) => c.name.toLowerCase());
    const alias = ['rowid', '_rowid_', 'oid'].find((n) => !names.includes(n));
    let statement;
    try {
      if (!alias) throw new Error('All rowid aliases shadowed');
      statement = db.prepare(`SELECT ${alias}, * FROM ${quote(name)} ORDER BY ${alias}`);
    } catch {
      const pk = columns.filter((c) => c.pk).sort((a, b) => a.pk - b.pk);
      if (!pk.length) throw new Error('Cannot verify row identity for ' + name);
      statement = db.prepare(
        `SELECT * FROM ${quote(name)} ORDER BY ${pk.map((c) => quote(c.name)).join(',')}`,
      );
    }
    const hash = createHash('sha256');
    let rows = 0;
    for (const row of statement.raw().safeIntegers().iterate()) {
      // Explicit type/length framing preserves NULL, blobs and 64-bit integers.
      for (const value of row) {
        const bytes = Buffer.isBuffer(value)
          ? value
          : Buffer.from(value === null ? '' : String(value));
        hash.update(
          `${value === null ? 'null' : Buffer.isBuffer(value) ? 'blob' : typeof value}:${bytes.length}:`,
        );
        hash.update(bytes);
      }
      hash.update('\n');
      rows++;
    }
    contents[name] = { rows, hash: hash.digest('hex') };
  }
  return {
    schema,
    contents,
    foreignKeys: db.pragma('foreign_key_check'),
    userVersion: db.pragma('user_version', { simple: true }),
    applicationId: db.pragma('application_id', { simple: true }),
  };
}

export function compactDatabase({ Database, data, folder, save, freeDiskBytes }) {
  const live = join(data, 'workspace.db');
  const compact = join(folder, 'workspace.compacted.db');
  const original = join(folder, 'workspace.before-compaction.db');
  if (existsSync(original))
    throw new Error('A compaction recovery copy already exists; inspect it before retrying.');
  let input, output;
  try {
    input = new Database(live, { fileMustExist: true });
    input.pragma('busy_timeout = 1000');
    input.pragma('synchronous = FULL');
    input.pragma('cache_size = -4096');
    input.pragma('mmap_size = 0');
    const free = Number(input.pragma('freelist_count', { simple: true }));
    const pages = Number(input.pragma('page_count', { simple: true }));
    const pageSize = Number(input.pragma('page_size', { simple: true }));
    if (free * pageSize < 16 * 1024 ** 2) {
      save({ compaction: { state: 'skipped', reason: 'Less than 16 MiB reclaimable.' } });
      return;
    }
    // Only the compact output is additional storage; the original is renamed.
    const required = (pages - free) * pageSize * 2 + 256 * 1024 ** 2;
    if (freeDiskBytes(folder) < required) {
      save({
        compaction: {
          state: 'skipped',
          reason: 'Not enough space for a verified compact copy; retry on the next update.',
        },
      });
      return;
    }
    const checkpoint = input.pragma('wal_checkpoint(TRUNCATE)')[0];
    if (checkpoint.busy) throw new Error('Database is still in use; compaction withheld.');
    const before = databaseEvidence(input);
    if (existsSync(compact)) unlinkSync(compact); // Only this job's incomplete scratch copy.
    input.prepare('VACUUM INTO ?').run(compact);
    output = new Database(compact, { readonly: true, fileMustExist: true });
    if (JSON.stringify(databaseEvidence(output)) !== JSON.stringify(before))
      throw new Error('Compacted database differs from the original; replacement withheld.');
    output.close();
    output = undefined;
    input.close();
    input = undefined;
    const fd = openSync(compact, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const evidence = {
      original,
      compact,
      beforeBytes: statSync(live).size,
      afterBytes: statSync(compact).size,
    };
    // Persist recovery locations BEFORE either rename. A crash retains the
    // maintenance lock, so the launcher cannot silently create an empty DB.
    save({ compaction: { ...evidence, state: 'verified' } });
    renameSync(live, original);
    try {
      // All SQLite handles are closed and the WAL was checkpointed above.
      for (const suffix of ['-wal', '-shm'])
        if (existsSync(live + suffix)) unlinkSync(live + suffix);
      renameSync(compact, live);
    } catch (error) {
      renameSync(original, live);
      throw error;
    }
    save({
      compaction: {
        ...evidence,
        state: 'switched',
        recoveredBytes: evidence.beforeBytes - evidence.afterBytes,
      },
    });
  } finally {
    output?.close();
    input?.close();
  }
}

// Archive after the app is healthy again. Verify a streaming round trip before
// releasing the large recovery file; a partial archive never replaces a backup.
export async function archiveRecoveryCopy(source, commit) {
  const target = source + '.gz';
  const temporary = target + '.partial';
  const original = createHash('sha256');
  const input = createReadStream(source, { highWaterMark: 64 * 1024 });
  input.on('data', (chunk) => original.update(chunk));
  await pipeline(input, createGzip({ level: 1 }), createWriteStream(temporary, { mode: 0o600 }));
  const restored = createHash('sha256');
  await pipeline(
    createReadStream(temporary),
    createGunzip(),
    new Writable({
      write(chunk, _encoding, callback) {
        restored.update(chunk);
        callback();
      },
    }),
  );
  const fingerprint = original.digest('hex');
  if (restored.digest('hex') !== fingerprint)
    throw new Error('Recovery archive verification failed. Original retained.');
  const fd = openSync(temporary, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, target);
  commit({ path: target, sha256: fingerprint, encoding: 'gzip' });
  unlinkSync(source);
}

export async function archiveMaintenanceBackups(file, readJson, save) {
  const snapshot = readJson(file);
  if (snapshot.compaction?.state === 'switched' && !snapshot.compaction.archive) {
    await archiveRecoveryCopy(snapshot.compaction.original, (archive) =>
      save({
        compaction: {
          ...readJson(file).compaction,
          original: archive.path,
          archive,
        },
      }),
    );
  }
  if (snapshot.backup && !snapshot.backupArchive)
    await archiveRecoveryCopy(snapshot.backup, (archive) =>
      save({ backup: archive.path, backupArchive: archive }),
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href &&
  process.argv[2] === '--archive'
) {
  const file = process.argv[3];
  const { readJson, atomicJson } = await import(process.argv[4]);
  const job = readJson(file);
  if (job.phase !== 'succeeded' || job.compactionHandledBy !== 'startup')
    throw new Error('Recovery archiving is not ready.');
  const claim = join(dirname(file), 'archive.lock');
  let fd;
  try {
    fd = openSync(claim, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') process.exit(0);
    throw error;
  }
  closeSync(fd);
  try {
    try {
      setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {}
    await archiveMaintenanceBackups(file, readJson, (change) =>
      atomicJson(file, { ...readJson(file), ...change }),
    );
  } finally {
    unlinkSync(claim);
  }
}
