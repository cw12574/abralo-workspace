import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Store } from './store.js';
import { ensureDirectory, execFileAsync } from '../../../packages/host/src/index.js';
const inFlight = new Map<string, Promise<string>>();

async function gitWorktrees(root: string) {
  const { stdout } = await execFileAsync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
    windowsHide: true,
  });
  return stdout
    .split(/\r?\n\r?\n/)
    .map((entry) => ({
      path: entry.match(/^worktree (.+)$/m)?.[1],
      branch: entry.match(/^branch refs\/heads\/(.+)$/m)?.[1],
    }))
    .filter((entry) => entry.path);
}

export function taskFolder(store: Store, employee: any, contextKey: string) {
  const lockKey = store.dir + '\0' + contextKey;
  const existing = inFlight.get(lockKey);
  if (existing) return existing;
  const pending = taskFolderOnce(store, employee, contextKey).finally(() => {
    if (inFlight.get(lockKey) === pending) inFlight.delete(lockKey);
  });
  inFlight.set(lockKey, pending);
  return pending;
}

async function taskFolderOnce(store: Store, employee: any, contextKey: string) {
  if (!employee.cwd)
    return ensureDirectory(join(store.dir, 'work', employee.id, contextKey.slice(0, 16)));
  if (!existsSync(employee.cwd))
    throw new Error('The working folder is unavailable. Choose another folder in the composer.');
  let root: string;
  try {
    root = (
      await execFileAsync('git', ['-C', employee.cwd, 'rev-parse', '--show-toplevel'], {
        windowsHide: true,
      })
    ).stdout.trim();
  } catch {
    return employee.cwd;
  }
  // A newly initialized local repository has no HEAD yet. There is no
  // committed tree to create a worktree from, so work in the folder the user
  // explicitly granted instead of failing with "invalid reference: HEAD".
  try {
    await execFileAsync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], {
      windowsHide: true,
    });
  } catch {
    return root;
  }
  const saved = store.setting('worktree.' + contextKey);
  if (saved && existsSync(saved.path)) return saved.path;
  const path = join(ensureDirectory(join(store.dir, 'worktrees')), contextKey.slice(0, 24));
  const branch = 'codex/workspace-' + contextKey.slice(0, 16);
  const remember = (worktreePath: string) => {
    const absolutePath = resolve(worktreePath);
    store.set('worktree.' + contextKey, { path: absolutePath, branch, source: root });
    return absolutePath;
  };
  const attached = (await gitWorktrees(root)).find(
    (entry) => entry.branch === branch && existsSync(entry.path!),
  );
  // The same task may already own this branch in a folder created by an
  // earlier launch or another app data directory. Reuse it instead of making
  // a second workspace or failing with Git's branch-exists error.
  if (attached) return remember(attached.path!);
  if (existsSync(path))
    throw new Error(
      `The saved agent work folder already exists but is not registered with Git: ${path}. Move it aside before retrying; no files were changed.`,
    );

  const branchExists = async () => {
    try {
      await execFileAsync(
        'git',
        ['-C', root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
        { windowsHide: true },
      );
      return true;
    } catch {
      return false;
    }
  };
  const addWorktree = (reuseBranch: boolean) =>
    execFileAsync(
      'git',
      reuseBranch
        ? ['-C', root, 'worktree', 'add', path, branch]
        : ['-C', root, 'worktree', 'add', '-b', branch, path, 'HEAD'],
      { windowsHide: true, timeout: 30000 },
    );
  try {
    await addWorktree(await branchExists());
  } catch (error) {
    // Recover if another launch created the worktree during our inventory.
    const existing = (await gitWorktrees(root)).find(
      (entry) => entry.branch === branch && existsSync(entry.path!),
    );
    if (existing) return remember(existing.path!);
    if (!(await branchExists())) throw error;
    // A previous attempt may have created the branch but stopped before
    // linking its folder. Reuse that branch and preserve any work on it.
    await addWorktree(true);
  }
  return remember(path);
}
export function checkpoint(
  store: Store,
  contextKey: string,
  conversationId: string,
  threadId: string | null,
  before: number,
) {
  // A source-linked extract, not a model-generated claim about the whole history.
  const messages = store.messages(conversationId, before, threadId).slice(-16);
  const data = {
    coveredSeq: messages.at(-1)?.seq || 0,
    updatedAt: new Date().toISOString(),
    sources: messages.map((m) => ({ id: m.id, author: m.authorName, text: m.text.slice(-1500) })),
  };
  store.set('checkpoint.' + contextKey, data);
  return data.sources.map((m) => `[message ${m.id}] ${m.author}: ${m.text}`).join('\n');
}
