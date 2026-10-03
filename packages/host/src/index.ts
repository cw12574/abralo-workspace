import { homedir, platform, arch } from 'node:os';
import { createRequire } from 'node:module';
import { join, delimiter, dirname } from 'node:path';
import { existsSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
export const execFileAsync = promisify(execFile);
export function dataDirectory() {
  const base =
    platform() === 'win32'
      ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      : platform() === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return process.env.WORKSPACE_DATA_DIR || join(base, 'AgentWorkspace');
}
export function ensureDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
export function executable(name: string): { command: string; args: string[] } | null {
  if (name === 'codex') {
    const bundled = join(process.cwd(), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(bundled)) return { command: process.execPath, args: [bundled] };
  }
  if (name === 'opencode') {
    const bundled = join(process.cwd(), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    if (existsSync(bundled)) return { command: bundled, args: [] };
  }
  if (name === 'claude') {
    // Resolve from the real SDK path for both pnpm's symlink layout and the
    // hoisted release layout. Prefer the pinned runtime over an unrelated CLI.
    try {
      const req = createRequire(
        realpathSync(
          join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'),
        ),
      );
      const pkg = req.resolve(
        `@anthropic-ai/claude-agent-sdk-${platform()}-${arch()}/package.json`,
      );
      const command = join(dirname(pkg), platform() === 'win32' ? 'claude.exe' : 'claude');
      if (existsSync(command)) return { command, args: [] };
    } catch {}
  }
  const paths = [
    ...(process.env.PATH || '').split(delimiter),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.npm-global'),
    join(homedir(), '.opencode', 'bin'),
  ];
  for (const dir of paths) {
    for (const ext of platform() === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const p = join(dir, name + ext);
      if (!existsSync(p) || !statSync(p).isFile()) continue;
      if (ext === '.cmd') {
        const entry =
          name === 'codex'
            ? join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
            : name === 'opencode'
              ? join(dir, 'node_modules', 'opencode-ai', 'bin', 'opencode')
              : '';
        if (entry && existsSync(entry)) return { command: process.execPath, args: [entry] };
        continue;
      }
      if (platform() === 'win32' && ext === '') continue;
      return { command: p, args: [] };
    }
  }
  if (name === 'opencode') {
    const local = join(process.cwd(), 'node_modules', 'opencode-ai', 'bin', 'opencode');
    if (existsSync(local)) return { command: process.execPath, args: [local] };
  }
  return null;
}
export function launch(name: string, args: string[], options: any = {}) {
  const bin = executable(name);
  if (!bin) throw new Error(`${name} is not installed on this host.`);
  return spawn(bin.command, [...bin.args, ...args], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}
export async function killTree(pid: number) {
  if (platform() === 'win32')
    await execFileAsync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
    }).catch(() => {});
  else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
  }
}
export function openBrowser(url: string) {
  if (!/^https?:\/\//.test(url)) throw new Error('Unsupported URL');
  if (platform() === 'win32')
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    }).unref();
  else
    spawn(platform() === 'darwin' ? 'open' : 'xdg-open', [url], {
      detached: true,
      stdio: 'ignore',
    }).unref();
}
