import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { openBrowser } from '../../../packages/host/src/index.js';
import type { Store } from './store.js';

const require = createRequire(import.meta.url);
const run = promisify(execFile);
const appId = 'Abralo.Desktop';
let registration: Promise<void> | undefined;

export function nativeNotificationsAvailable(s: Store, userId: string): boolean {
  if (process.platform !== 'win32' || !process.env.WORKSPACE_INSTALL_ROOT) return false;
  try {
    const versions = realpathSync(join(process.env.WORKSPACE_INSTALL_ROOT, 'versions'));
    if (dirname(realpathSync(process.cwd())).toLowerCase() !== versions.toLowerCase()) return false;
  } catch { return false; }
  // A Windows session belongs to one person. Never put another member's private
  // messages on the current desktop when the workspace has multiple humans.
  const humans = s.all('SELECT id FROM humans LIMIT 2');
  if (humans.length !== 1 || humans[0].id !== userId) return false;
  try { helperPath(); return true; } catch { return false; }
}

function helperPath(): string {
  const arch = process.arch === 'ia32' ? 'x86' : 'x64';
  const path = join(dirname(require.resolve('node-notifier/package.json')),
    'vendor', 'snoreToast', `snoretoast-${arch}.exe`);
  if (!existsSync(path)) throw new Error('Windows notification helper is missing.');
  return path;
}

async function ensureRegistered(): Promise<void> {
  registration ??= (async () => {
    const helper = helperPath();
    // SnoreToast registers an app identity through a Start menu shortcut.
    // Its named pipe reports toast clicks back to the running service.
    await run(helper, ['-install', 'Abralo\\Abralo.lnk', helper, appId],
      { windowsHide: true, timeout: 10000 });
  })().catch((error) => {
    registration = undefined;
    throw error;
  });
  await registration;
}

export async function prepareNativeNotifications(s: Store): Promise<void> {
  const humans = s.all('SELECT id FROM humans LIMIT 2');
  if (humans.length === 1 && nativeNotificationsAvailable(s, humans[0].id))
    await ensureRegistered();
}

export async function sendNativeNotification(
  s: Store,
  notification: { title: string; body: string; sound: boolean },
  onFailure?: (error: Error) => void,
): Promise<void> {
  await ensureRegistered();
  const { WindowsToaster } = require('node-notifier');
  const toaster = new WindowsToaster({ withFallback: false });
  toaster.notify({
    title: notification.title || 'Abralo',
    message: notification.body || 'You have a new message.',
    appID: appId,
    sound: notification.sound,
  }, (error: Error | null, result: { activationType?: string } = {}) => {
    if (error) {
      console.error('Windows notification failed:', error);
      onFailure?.(error);
    }
    if (result.activationType === 'click') {
      try {
        const runtime = JSON.parse(readFileSync(join(s.dir, 'runtime.json'), 'utf8'));
        if (Number.isInteger(runtime.port) && runtime.port > 0 && runtime.port < 65536)
          openBrowser(`http://127.0.0.1:${runtime.port}/`);
      } catch (clickError) {
        console.error('Could not open Abralo from notification:', clickError);
      }
    }
  });
}
