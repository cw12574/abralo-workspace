import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  alive,
  atomicJson,
  freeDiskBytes,
  readJson,
  workspaceIdentity,
} from './maintenance-files.js';

// Upgrade bridge: older installed helpers cannot compact. Run before opening
// Store, only inside their approved, backed-up, fully stopped handoff. New
// helpers already did this work and are skipped here.
export async function prepareStartupCompaction(
  root: string,
  data: string,
  installRoot?: string,
  id?: string,
) {
  if (!installRoot || !id) return;
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid maintenance startup identity.');
  const folder = join(data, 'maintenance', id);
  const file = join(folder, 'job.json');
  const lock = join(data, 'maintenance/active.json');
  const job = readJson(file);
  if (job.compactOnHandoff || job.compaction || job.phase !== 'starting') return;
  if (
    !existsSync(lock) ||
    readJson(lock).id !== id ||
    !Number.isInteger(job.oldPid) ||
    job.oldPid < 1 ||
    alive(job.oldPid) ||
    realpathSync(job.candidate.root) !== realpathSync(root) ||
    realpathSync(job.installRoot) !== realpathSync(installRoot) ||
    realpathSync(job.data) !== realpathSync(data) ||
    workspaceIdentity(data) !== job.dataDirectoryId ||
    !job.backup ||
    !existsSync(job.backup) ||
    !job.schema
  )
    throw new Error('Cannot verify the stopped maintenance handoff for database compaction.');
  const { compactDatabase } = await import(
    pathToFileURL(join(root, 'scripts/maintenance-compact.mjs')).href
  );
  const Database = createRequire(join(root, 'package.json'))('better-sqlite3');
  const save = (change: any) =>
    atomicJson(file, {
      ...readJson(file),
      ...change,
      compactionHandledBy: 'startup',
      updatedAt: new Date().toISOString(),
    });
  compactDatabase({ Database, data, folder, save, freeDiskBytes });
}
