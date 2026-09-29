import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

function removeFixture(dir: string) {
  if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe fixture cleanup');
  rmSync(dir, { recursive: true, force: true });
}

describe('preview distribution and request boundaries', () => {
  it('rejects wrong-target and incomplete packages before installation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'preview-reject-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      const posix = join(dir, 'scripts/install-posix.mjs');
      writeFileSync(posix, readFileSync('scripts/install-posix.mjs'));
      const run = () => process.platform === 'win32'
        ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', resolve('scripts/install-windows.ps1'), '-ReleaseDirectory', dir], { stdio: 'pipe', windowsHide: true })
        : execFileSync(process.execPath, [posix], { stdio: 'pipe' });
      for (const manifest of [
        { platform: 'wrong-platform', arch: process.arch },
        { platform: process.platform, arch: 'wrong-architecture' },
        { platform: process.platform, arch: process.arch },
      ]) {
        writeFileSync(join(dir, 'release.json'), JSON.stringify(manifest));
        expect(run).toThrow();
      }
    } finally { removeFixture(dir); }
  }, 20000);

  it('does not expose sibling files through encoded or traversing static paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'preview-static-'));
    const publicDir = join(dir, 'public');
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>Public fixture</title>');
    writeFileSync(join(dir, 'private.txt'), 'PRIVATE-PREVIEW-SENTINEL');
    const store = new Store(join(dir, 'data'));
    const { app } = await createApp(store, { staticRoot: publicDir });
    try {
      for (const url of ['/../private.txt', '/x/../../private.txt', '/%2e%2e/private.txt', '/x/%2e%2e/%2e%2e/private.txt', '/%2e%2e%2fprivate.txt', '/..%5cprivate.txt']) {
        const response = await app.inject({ url });
        expect(response.body).not.toContain('PRIVATE-PREVIEW-SENTINEL');
      }
      expect((await app.inject({ url: '/api/workspace' })).statusCode).toBe(401);
      expect((await app.inject({ url: '/api/workspace', headers: { host: 'attacker.example' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/local-session', headers: { origin: 'https://attacker.example', 'x-workspace-request': '1' } })).statusCode).toBe(403);
    } finally { await app.close(); removeFixture(dir); }
  });
});
