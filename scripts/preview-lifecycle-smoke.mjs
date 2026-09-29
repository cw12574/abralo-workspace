// Isolated launcher/restart/backup probe. No model calls and no real user installation.
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';

if (!process.argv[2]) throw new Error('Pass a package directory');
let root = resolve(process.argv[2]);
// Native harness packages are large; avoid filling a small Linux /tmp tmpfs.
const fixture = mkdtempSync(join(process.platform === 'linux' ? homedir() : tmpdir(), 'abralo-lifecycle-'));
const data = join(fixture, 'data');
mkdirSync(data, { recursive: true });
const buildId = basename(root);
const env = { ...process.env, HOME: fixture, XDG_DATA_HOME: join(fixture, '.local/share'), WORKSPACE_DATA_DIR: data };
delete env.WORKSPACE_PUBLIC_URL;
env.WORKSPACE_HOST = '127.0.0.1';
const checks = [];
if (process.platform !== 'win32' && !process.argv.includes('--skip-install')) {
  execFileSync(join(root, 'runtime/node'), [join(root, 'scripts/install-posix.mjs')], { cwd: root, env, stdio: 'pipe' });
  const base = process.platform === 'darwin' ? join(fixture, 'Library/Application Support/AgentWorkspaceProgram') : join(fixture, '.local/lib/agent-workspace');
  root = join(base, readdirSync(base)[0]);
  if (!existsSync(join(root, 'docs/preview/START-HERE.md'))) throw new Error('Installed guide missing');
  checks.push('POSIX installer in disposable HOME; docs retained (no desktop launch)');
}
const reservation = createServer();
await new Promise(r => reservation.listen(0, '127.0.0.1', r));
const port = reservation.address().port;
await new Promise(r => reservation.close(r));
env.WORKSPACE_PORT = String(port);
const url = `http://127.0.0.1:${port}`;
const delay = ms => new Promise(r => setTimeout(r, ms));
const dataDirectoryId = createHash('sha256').update(process.platform === 'win32' ? realpathSync(data).toLowerCase() : realpathSync(data)).digest('hex');
async function health() { try { const r = await fetch(url + '/api/health', { signal: AbortSignal.timeout(500) }); return r.ok ? await r.json() : null; } catch { return null; } }
async function healthy() { const h = await health(); return h?.product === 'agent-workspace' && h.ok && h.buildId === buildId && h.dataDirectoryId === dataDirectoryId; }
async function start() {
  const bundledNode = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const child = spawn(existsSync(bundledNode) ? bundledNode : process.execPath, [join(root, 'scripts/launcher.mjs'), '--background'], { cwd: root, env, windowsHide: true, stdio: 'pipe' });
  let errors = '';
  child.stdout.resume();
  child.stderr.on('data', d => errors += d.toString());
  const code = await new Promise((r, reject) => { child.on('error', reject); child.on('exit', r); });
  if (code !== 0 || !await healthy()) throw new Error('Fixture launch failed: ' + errors);
}
async function stop() {
  if (!existsSync(join(data, 'runtime.json'))) return;
  const runtime = JSON.parse(readFileSync(join(data, 'runtime.json'), 'utf8'));
  if (runtime.port !== port || !Number.isInteger(runtime.pid) || runtime.pid <= 0) throw new Error('Wrong fixture process');
  try { process.kill(runtime.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  for (let n = 0; n < 40 && await healthy(); n++) await delay(100);
  if (await healthy()) throw new Error('Fixture service did not stop');
}
const report = { platform: process.platform, arch: process.arch, checks, providerCalls: false, liveWorkspaceTouched: false };
try {
  await start();
  checks.push('isolated bundled launcher and loopback service');
  const bundledNode = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const conflict = spawn(existsSync(bundledNode) ? bundledNode : process.execPath, [join(root, 'scripts/launcher.mjs'), '--background'], { cwd: root, env: { ...env, WORKSPACE_DATA_DIR: join(fixture, 'different-data-directory') }, windowsHide: true, stdio: 'pipe' });
  conflict.stdout.resume();
  let conflictError = '';
  conflict.stderr.on('data', d => conflictError += d.toString());
  const conflictCode = await new Promise((r, reject) => { conflict.on('error', reject); conflict.on('exit', r); });
  if (conflictCode === 0 || !await healthy()) throw new Error('Launcher accepted a server using another data directory: ' + conflictError);
  checks.push('launcher refuses a healthy server tied to a different data directory');
  if ((await fetch(url + '/api/workspace')).status !== 401) throw new Error('Unauthenticated workspace exposed');
  const login = await fetch(url + '/api/local-session', { method: 'POST', headers: { 'x-workspace-request': '1' } });
  if (!login.ok) throw new Error('Local fixture login failed');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, 'x-workspace-request': '1' };
  if (!(await fetch(url + '/api/workspace', { headers })).ok) throw new Error('Authorized workspace failed');
  const backup = await fetch(url + '/api/backups', { method: 'POST', headers });
  if (!backup.ok) throw new Error('Backup failed');
  checks.push('authentication boundary and fresh workspace backup');
  await stop();
  await start();
  if (!(await fetch(url + '/api/workspace', { headers })).ok) throw new Error('Session did not survive restart');
  checks.push('service stop/restart preserves authorized session');
  report.status = 'passed';
} catch (e) { report.status = 'failed'; report.error = String(e); process.exitCode = 1; }
finally { await stop(); console.log(JSON.stringify(report, null, 2)); }
