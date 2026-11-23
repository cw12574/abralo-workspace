import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { nativeNotificationsAvailable } from '../apps/service/src/native-notifications.js';
import type { Store } from '../apps/service/src/store.js';

vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(), existsSync: vi.fn(() => true),
}));
const owner = { all: () => [{ id: 'owner' }] } as unknown as Store;
beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'win32', env: { ...process.env } });
  delete process.env.WORKSPACE_INSTALL_ROOT;
  delete process.env.WORKSPACE_HOST;
  delete process.env.WORKSPACE_PUBLIC_URL;
  vi.mocked(existsSync).mockReturnValue(true);
});
afterEach(() => vi.unstubAllGlobals());

it('supports local previews and source runs without an installation directory', () => {
  expect(nativeNotificationsAvailable(owner, 'owner')).toBe(true);
  process.env.WORKSPACE_INSTALL_ROOT = 'C:\\unrelated-installation';
  expect(nativeNotificationsAvailable(owner, 'owner')).toBe(true);
});
it('requires the local owner and a single human', () => {
  expect(nativeNotificationsAvailable(owner, 'someone-else')).toBe(false);
  expect(nativeNotificationsAvailable({ all: () => [{ id: 'owner' }, { id: 'other' }] } as unknown as Store, 'owner')).toBe(false);
});
it('excludes remote hosts and public instances', () => {
  process.env.WORKSPACE_HOST = '0.0.0.0';
  expect(nativeNotificationsAvailable(owner, 'owner')).toBe(false);
  process.env.WORKSPACE_HOST = '127.0.0.1';
  process.env.WORKSPACE_PUBLIC_URL = 'https://workspace.example';
  expect(nativeNotificationsAvailable(owner, 'owner')).toBe(false);
});
it('requires Windows and the bundled helper', () => {
  vi.mocked(existsSync).mockReturnValue(false);
  expect(nativeNotificationsAvailable(owner, 'owner')).toBe(false);
  vi.mocked(existsSync).mockReturnValue(true);
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  expect(nativeNotificationsAvailable(owner, 'owner')).toBe(false);
});
