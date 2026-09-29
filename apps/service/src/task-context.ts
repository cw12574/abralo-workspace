import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Store } from './store.js';
import { ensureDirectory, execFileAsync } from '../../../packages/host/src/index.js';
export async function taskFolder(store: Store, employee: any, contextKey: string) {
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
  await execFileAsync('git', ['-C', root, 'worktree', 'add', '-b', branch, path, 'HEAD'], {
    windowsHide: true,
    timeout: 30000,
  });
  store.set('worktree.' + contextKey, { path, branch, source: root });
  return path;
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
