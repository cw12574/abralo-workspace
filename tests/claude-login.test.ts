import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const launched: any[] = [];
const killed: number[] = [];
vi.mock('../packages/host/src/index.js', async (original) => ({
  ...(await original<any>()),
  launch: (_name: string, _args: string[]) => {
    const child: any = new EventEmitter();
    child.pid = 1000 + launched.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { writable: true, write: () => true };
    launched.push(child);
    setTimeout(() => child.stdout.emit('data', Buffer.from('Open https://claude.ai/oauth/authorize?n=' + child.pid + '\n')), 20);
    return child;
  },
  killTree: async (pid: number) => {
    killed.push(pid);
  },
}));
const { Store } = await import('../apps/service/src/store.js');
const { createApp } = await import('../apps/service/src/app.js');

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('starts a fresh Claude sign-in on every click and stops the abandoned one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abralo-claude-login-'));
  roots.push(dir);
  const store = new Store(dir);
  const owner = store.createOwner('Owner');
  const { app } = await createApp(store);
  const headers = { host: '127.0.0.1', cookie: 'workspace=' + store.newSession(owner.id), 'x-workspace-request': '1' };
  try {
    const first = (await app.inject({ method: 'POST', url: '/api/providers/claude/login', headers, payload: {} })).json();
    expect(first.authUrl).toContain('n=1000');
    const second = (await app.inject({ method: 'POST', url: '/api/providers/claude/login', headers, payload: {} })).json();
    expect(second.authUrl).toContain('n=1001');
    expect(launched).toHaveLength(2);
    expect(killed).toEqual([1000]);
  } finally {
    await app.close();
  }
  expect(killed).toContain(1001);
});
