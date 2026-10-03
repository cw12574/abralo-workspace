// Probe the exact bundled runtimes in a disposable profile. No login or inference.
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = resolve(process.argv[2] || '.');
if (process.argv.includes('--worker')) {
  for (const [name, className] of [
    ['codex', 'CodexAdapter'],
    ['claude', 'ClaudeAdapter'],
    ['opencode', 'OpenCodeAdapter'],
  ]) {
    const module = await import(
      pathToFileURL(join(root, `dist/service/apps/service/src/adapters/${name}.js`)).href
    );
    const adapter = new module[className]();
    try {
      const info = await adapter.info();
      if (!info.installed || info.authenticated === null)
        throw new Error(`${name} runtime probe failed: ${info.detail}`);
      console.log(
        JSON.stringify({
          harness: name,
          installed: info.installed,
          statusReturned: true,
          authenticated: info.authenticated,
        }),
      );
    } finally {
      await adapter.dispose();
    }
  }
} else {
  const fixture = mkdtempSync(join(tmpdir(), 'abralo-provider-probe-'));
  // Construct an allowlist: do not inherit API keys, account paths or host settings.
  const env = Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'LANG']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  const node = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  Object.assign(env, {
    HOME: fixture,
    USERPROFILE: fixture,
    APPDATA: join(fixture, 'AppData/Roaming'),
    LOCALAPPDATA: join(fixture, 'AppData/Local'),
    XDG_CONFIG_HOME: join(fixture, 'config'),
    XDG_DATA_HOME: join(fixture, 'data'),
    XDG_CACHE_HOME: join(fixture, 'cache'),
    CODEX_HOME: join(fixture, 'codex'),
    CLAUDE_CONFIG_DIR: join(fixture, 'claude'),
    PATH:
      process.platform === 'win32'
        ? join(process.env.SystemRoot || 'C:/Windows', 'System32')
        : '/usr/bin:/bin',
  });
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'])
    mkdirSync(env[key], { recursive: true });
  const child = spawn(
    existsSync(node) ? node : process.execPath,
    [fileURLToPath(import.meta.url), root, '--worker'],
    { cwd: root, env, windowsHide: true, detached: process.platform !== 'win32', stdio: 'inherit' },
  );
  const timer = setTimeout(() => {
    if (!child.pid) return;
    if (process.platform === 'win32')
      spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
  }, 90000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', resolve);
    });
    if (code !== 0) throw new Error('Native provider acceptance failed');
  } finally {
    clearTimeout(timer);
    const within = relative(resolve(tmpdir()), resolve(fixture));
    if (within && !within.startsWith('..') && !isAbsolute(within))
      rmSync(fixture, { recursive: true, force: true });
  }
}
