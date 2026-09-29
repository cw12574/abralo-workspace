import { spawn } from 'node:child_process';
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Store } from '../dist/service/apps/service/src/store.js';
import { alive, health, readJson } from '../dist/service/apps/service/src/maintenance-files.js';
const source = resolve('.');
const fixture = mkdtempSync(join(tmpdir(), 'workspace-maintenance-'));
const install = join(fixture, 'program');
const data = join(fixture, 'data');
mkdirSync(join(install, 'versions'), { recursive: true });
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const checks = [];
const errors = [];
function version(name, bad = false) {
  const root = join(install, 'versions', name);
  mkdirSync(root);
  cpSync(join(source, 'dist'), join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'scripts'));
  for (const file of ['launcher.mjs', 'maintenance-helper.mjs', 'installed-launcher.mjs'])
    copyFileSync(join(source, 'scripts', file), join(root, 'scripts', file));
  copyFileSync(join(source, 'package.json'), join(root, 'package.json'));
  symlinkSync(
    join(source, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  mkdirSync(join(root, 'runtime'));
  copyFileSync(
    process.execPath,
    join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  writeFileSync(
    join(root, 'release.json'),
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      maintenanceProtocol: 1,
      dataCompatibility: 'workspace-v1',
    }),
  );
  if (bad)
    writeFileSync(join(root, 'dist/service/apps/service/src/main.js'), 'process.exit(12);\n');
  return root;
}
const a = version('version-a');
const b = version('version-b');
const bad = version('version-broken', true);
const incompatible = version('version-schema-change');
writeFileSync(
  join(incompatible, 'dist/service/apps/service/src/main.js'),
  `import Database from 'better-sqlite3';
import { join } from 'node:path';
const db = new Database(join(process.env.WORKSPACE_DATA_DIR, 'workspace.db'));
db.exec('CREATE TABLE incompatible_fixture (id INTEGER)'); db.close(); process.exit(12);
`,
);
copyFileSync(join(source, 'scripts/installed-launcher.mjs'), join(install, 'launcher.mjs'));
writeFileSync(join(install, 'current.txt'), a + '\n');
const store = new Store(data);
const owner = store.createOwner('Fixture owner');
store.set('workspace.onboarded', true);
const agent = store.createEmployee(owner.id, {
  name: 'Fixture agent',
  harness: 'codex',
  role: 'fixture',
  model: '',
  cwd: '',
  instructions: '',
});
const original = store.addMessage(
  agent.dmId,
  owner.id,
  owner.name,
  'human',
  'Keep this conversation through an update.',
);
const cookie = 'workspace=' + store.newSession(owner.id);
const member = store.createOwner('Fixture member');
store.run("UPDATE humans SET role='member' WHERE id=?", member.id);
const memberCookie = 'workspace=' + store.newSession(member.id);
store.close();
const headers = { cookie, 'x-workspace-request': '1', 'content-type': 'application/json' };
const url = `http://127.0.0.1:${port}`;
async function api(path, body, expectStatus = 200) {
  const r = await fetch(url + '/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const result = await r.json();
  assert.equal(r.status, expectStatus, JSON.stringify(result));
  return result;
}
async function until(fn, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(150);
  }
  throw new Error('Timed out waiting for fixture condition');
}
async function launch() {
  const child = spawn(process.execPath, [join(install, 'launcher.mjs'), '--background'], {
    cwd: install,
    windowsHide: true,
    env: {
      ...process.env,
      WORKSPACE_DATA_DIR: data,
      WORKSPACE_PORT: String(port),
      WORKSPACE_HOST: '127.0.0.1',
      WORKSPACE_MAINTENANCE_JOB: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.on('data', (d) => errors.push(d.toString()));
  const code = await new Promise((r, reject) => {
    child.once('error', reject);
    child.once('exit', r);
  });
  assert.equal(code, 0, errors.join(''));
}
const jobFile = (id) => join(data, 'maintenance', id, 'job.json');
async function terminal(id, expected) {
  await until(() => ['succeeded', 'rolled-back', 'failed'].includes(readJson(jobFile(id)).phase));
  const job = readJson(jobFile(id));
  assert.equal(job.phase, expected, JSON.stringify(job));
  await until(async () => {
    const r = await fetch(url + '/api/maintenance', { headers }).catch(() => null);
    return r?.ok && !existsSync(join(data, 'maintenance/active.json'));
  });
  // Mutation gate is released by the new process on its next controller tick.
  await delay(350);
  const db = new Database(job.backup, { readonly: true });
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  db.close();
}
try {
  await launch();
  assert.equal((await health(port)).buildId, 'version-a');
  const initialPid = readJson(join(data, 'runtime.json')).pid;
  const unauthenticated = await fetch(url + '/api/maintenance/prepare', {
    method: 'POST',
    headers: { 'x-workspace-request': '1', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(unauthenticated.status, 401);
  const nonOwner = await fetch(url + '/api/maintenance/prepare', {
    method: 'POST', headers: { ...headers, cookie: memberCookie }, body: '{}',
  });
  assert.equal(nonOwner.status, 403);
  await api('maintenance/prepare', { candidateRoot: fixture }, 500);
  assert(alive(initialPid));
  checks.push('owner-only API; invalid candidate leaves original service running');
  const prepared = await api('maintenance/prepare', { candidateRoot: b });
  assert.equal(prepared.job.phase, 'prepared');
  assert(alive(initialPid));
  await api('maintenance/execute', { jobId: prepared.job.id });
  // Duplicate submission must never spawn a second helper.
  const duplicate = await fetch(url + '/api/maintenance/execute', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jobId: prepared.job.id }),
  }).catch(() => null);
  assert(!duplicate || [409, 503].includes(duplicate.status));
  await terminal(prepared.job.id, 'succeeded');
  assert(!alive(initialPid));
  assert.equal((await health(port)).buildId, 'version-b');
  assert.equal(readFileSync(join(install, 'current.txt'), 'utf8').trim(), b);
  assert.equal((await api(`messages/${original.id}`)).text, original.text);
  checks.push(
    'helper survives original service exit; switches build; session/message persist; verified backup; duplicate rejected',
  );
  const failing = await api('maintenance/prepare', { candidateRoot: bad });
  await api('maintenance/execute', { jobId: failing.job.id });
  await terminal(failing.job.id, 'rolled-back');
  assert.equal((await health(port)).buildId, 'version-b');
  assert.equal(readFileSync(join(install, 'current.txt'), 'utf8').trim(), b);
  checks.push(
    'failed candidate automatically returns to previous compatible build without restoring data',
  );
  const restart = await api('maintenance/prepare', {});
  const before = readJson(join(data, 'runtime.json')).pid;
  await api('maintenance/execute', { jobId: restart.job.id });
  await terminal(restart.job.id, 'succeeded');
  assert(!alive(before));
  assert.equal((await health(port)).buildId, 'version-b');
  await launch();
  checks.push(
    'same-version restart; stable launcher follows selected build and reuses healthy service',
  );
  const unsafe = await api('maintenance/prepare', { candidateRoot: incompatible });
  await api('maintenance/execute', { jobId: unsafe.job.id });
  await until(() => readJson(jobFile(unsafe.job.id)).phase === 'failed');
  const unsafeJob = readJson(jobFile(unsafe.job.id));
  assert.match(unsafeJob.error, /compatibility could not be verified/);
  assert(existsSync(join(data, 'maintenance/active.json')));
  assert.equal(await health(port), null);
  assert.equal(readFileSync(join(install, 'current.txt'), 'utf8').trim(), b);
  const backup = new Database(unsafeJob.backup, { readonly: true });
  assert.equal(backup.pragma('quick_check', { simple: true }), 'ok');
  backup.close();
  const db = new Database(join(data, 'workspace.db'), { readonly: true });
  assert(db.prepare("SELECT name FROM sqlite_master WHERE name='incompatible_fixture'").get());
  assert.equal(db.prepare('SELECT COUNT(*) n FROM runs').get().n, 0);
  db.close();
  checks.push(
    'schema-changing failed build blocks unsafe fallback; retains original selection, changed database, verified backup and recovery lock',
  );
  console.log(
    JSON.stringify(
      { status: 'passed', fixture, checks, liveWorkspaceTouched: false, providerCalls: false },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      { status: 'failed', fixture, checks, error: String(error.stack || error), logs: errors },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  // Only the fixture's recorded service; never the live port or installation.
  if (existsSync(join(data, 'runtime.json'))) {
    const runtime = readJson(join(data, 'runtime.json'));
    if (runtime.port === port && alive(runtime.pid)) {
      process.kill(runtime.pid);
      await until(() => !alive(runtime.pid), 10000);
    }
  }
}
