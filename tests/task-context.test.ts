import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { it, expect } from 'vitest';
import { Store } from '../apps/service/src/store.js';
import { taskFolder } from '../apps/service/src/task-context.js';

it('uses the granted folder when a local git repository has no first commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-unborn-repo-'));
  const initialized = spawnSync('git', ['-C', root, 'init', '--quiet']);
  expect(initialized.status, initialized.stderr.toString()).toBe(0);

  const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-task-context-')));
  try {
    const folder = await taskFolder(store, { cwd: root }, 'unborn-repository-context');
    expect(folder.replace(/\\/g, '/')).toBe(realpathSync(root).replace(/\\/g, '/'));
    expect(store.setting('worktree.unborn-repository-context')).toBeNull();
  } finally {
    store.close();
  }
});
