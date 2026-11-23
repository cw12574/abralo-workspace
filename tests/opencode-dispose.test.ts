import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeAdapter } from '../apps/service/src/adapters/opencode.js';

// A stand-in for `opencode serve`: announces an address, then stays up and,
// in the stubborn case, ignores the polite stop signal.
function fakeServer(ignoreTerm: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-fake-'));
  const file = join(dir, 'serve.cjs');
  writeFileSync(
    file,
    `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
     console.log('opencode server listening on http://127.0.0.1:4096');
     setInterval(() => {}, 1000);`,
  );
  return { dir, binary: { command: process.execPath, args: [file] } };
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

it('stops a server that exits when asked', async () => {
  const fake = fakeServer(false);
  dirs.push(fake.dir);
  const adapter = new OpenCodeAdapter(fake.binary);
  await adapter.start();
  const pid = adapter.child.pid;
  await adapter.dispose(2000);
  expect(adapter.child.exitCode !== null || adapter.child.signalCode !== null).toBe(true);
  expect(alive(pid)).toBe(false);
});

it('forces a server that ignores the stop signal, so refreshes cannot pile up servers', async () => {
  const fake = fakeServer(true);
  dirs.push(fake.dir);
  const adapter = new OpenCodeAdapter(fake.binary);
  await adapter.start();
  const pid = adapter.child.pid;
  const started = Date.now();
  await adapter.dispose(300);
  expect(adapter.child.signalCode !== null || adapter.child.exitCode !== null).toBe(true);
  expect(alive(pid)).toBe(false);
  expect(Date.now() - started).toBeLessThan(3000);
});

it('does nothing when the server has already gone', async () => {
  const fake = fakeServer(false);
  dirs.push(fake.dir);
  const adapter = new OpenCodeAdapter(fake.binary);
  await adapter.start();
  await adapter.dispose(2000);
  await expect(adapter.dispose(2000)).resolves.toBeUndefined();
});
