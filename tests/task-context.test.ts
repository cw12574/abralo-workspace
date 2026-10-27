import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, it, expect } from 'vitest';
import { Store } from '../apps/service/src/store.js';
import { taskFolder } from '../apps/service/src/task-context.js';

const roots: string[] = [];
const dataDirectories: string[] = [];
const stores: Store[] = [];
function git(root: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-task-repo-'));
  roots.push(root);
  expect(spawnSync('git', ['-C', root, 'init', '--quiet']).status).toBe(0);
  git(root, 'config', 'user.email', 'workspace-test@example.invalid');
  git(root, 'config', 'user.name', 'Workspace Test');
  writeFileSync(join(root, 'seed.txt'), 'fixture');
  git(root, 'add', 'seed.txt');
  git(root, 'commit', '-m', 'fixture');
  return root;
}
function store() {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-task-context-'));
  dataDirectories.push(directory);
  const db = new Store(directory);
  stores.push(db);
  return db;
}
afterEach(() => {
  for (const db of stores.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const directory of dataDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('uses the granted folder when a local git repository has no first commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-unborn-repo-'));
  roots.push(root);
  expect(spawnSync('git', ['-C', root, 'init', '--quiet']).status).toBe(0);
  const db = store();
  const folder = await taskFolder(db, { cwd: root }, 'unborn-repository-context');
  expect(folder.replace(/\\/g, '/')).toBe(git(root, 'rev-parse', '--show-toplevel').replace(/\\/g, '/'));
  expect(db.setting('worktree.unborn-repository-context')).toBeNull();
}, 15000);

it('reuses a matching branch left behind by an interrupted worktree setup', async () => {
  const root = repository();
  const db = store();
  const context = 'orphaned-worktree-setup';
  const branch = 'codex/workspace-' + context.slice(0, 16);
  git(root, 'branch', branch, 'HEAD');

  const folder = await taskFolder(db, { cwd: root }, context);
  expect(db.setting('worktree.' + context)).toMatchObject({
    path: folder,
    branch,
    source: git(root, 'rev-parse', '--show-toplevel'),
  });
  expect(git(folder, 'branch', '--show-current')).toBe(branch);
});

it('coalesces concurrent launches for the same task folder', async () => {
  const root = repository();
  const db = store();
  const context = 'same-task-concurrent-launch';

  const folders = await Promise.all([
    taskFolder(db, { cwd: root }, context),
    taskFolder(db, { cwd: root }, context),
    taskFolder(db, { cwd: root }, context),
  ]);
  expect(new Set(folders).size).toBe(1);
  const branches = git(root, 'worktree', 'list', '--porcelain')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('branch refs/heads/codex/workspace-'));
  expect(branches).toHaveLength(1);
});

it('recovers the registered folder if setup finished before its mapping was saved', async () => {
  const root = repository();
  const db = store();
  const context = 'mapping-save-recovery';
  const first = await taskFolder(db, { cwd: root }, context);
  db.run('DELETE FROM settings WHERE key=?', 'worktree.' + context);

  const recovered = await taskFolder(db, { cwd: root }, context);
  expect(recovered).toBe(first);
  expect(db.setting('worktree.' + context).path).toBe(first);
});

it('reuses the active worktree for the same task from another data directory', async () => {
  const root = repository();
  const first = store();
  const second = store();
  const context = 'same-context-separate-installs';

  const firstFolder = await taskFolder(first, { cwd: root }, context);
  const secondFolder = await taskFolder(second, { cwd: root }, context);
  expect(secondFolder).toBe(firstFolder);
  expect(git(secondFolder, 'branch', '--show-current')).toBe(
    'codex/workspace-' + context.slice(0, 16),
  );
}, 20000);
