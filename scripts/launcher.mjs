import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  openSync,
  closeSync,
  renameSync,
  statSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data =
  process.env.WORKSPACE_DATA_DIR ||
  join(
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
    'AgentWorkspace',
  );
mkdirSync(data, { recursive: true, mode: 0o700 });
const canonicalDataDirectory = realpathSync(data);
const dataDirectoryId = createHash('sha256')
  .update(process.platform === 'win32' ? canonicalDataDirectory.toLowerCase() : canonicalDataDirectory)
  .digest('hex');
const buildId = basename(root);
const port = Number(process.env.WORKSPACE_PORT || 4317),
  url = `http://127.0.0.1:${port}`;
async function health() {
  try {
    const r = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { occupied: true };
    return await r.json();
  } catch {
    return null;
  }
}
function matchesWorkspace(h) {
  return (
    h?.product === 'agent-workspace' &&
    h.ok === true &&
    h.buildId === buildId &&
    h.dataDirectoryId === dataDirectoryId
  );
}
let current = await health();
if (current && !matchesWorkspace(current)) {
  throw new Error(
    `A different Workspace build or data directory is already using port ${port}. It was left running. Stop it before opening this workspace; no new workspace was started.`,
  );
}
if (!current) {
  const log = join(data, 'service.log');
  if (existsSync(log) && statSync(log).size > 2 * 1024 * 1024) {
    rmSync(join(data, 'service.previous.log'), { force: true });
    renameSync(log, join(data, 'service.previous.log'));
  }
  const fd = openSync(log, 'a');
  const child = spawn(process.execPath, [join(root, 'dist/service/apps/service/src/main.js')], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, WORKSPACE_BUILD_ID: buildId },
  });
  child.unref();
  closeSync(fd);
  let ready = false;
  // Cold native installations on slower disks can exceed the old 20s window.
  const readyDeadline = Date.now() + 60000;
  while (Date.now() < readyDeadline) {
    current = await health();
    if (matchesWorkspace(current)) {
      ready = true;
      break;
    }
    if (current) {
      throw new Error(
        `Port ${port} answered with a different Workspace build or data directory. The launcher did not open it.`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('Workspace did not start. See ' + log);
}
if (!process.argv.includes('--background')) {
  const token = readFileSync(join(data, 'bootstrap.key'), 'utf8').trim();
  const target = url + '/#setup=' + encodeURIComponent(token);
  const command =
    process.platform === 'win32'
      ? 'rundll32.exe'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', target] : [target];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
