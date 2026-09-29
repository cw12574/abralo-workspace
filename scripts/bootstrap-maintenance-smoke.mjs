import { spawn } from 'node:child_process';
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const [legacySource, candidateSource] = process.argv.slice(2);
const helper = resolve('scripts/bootstrap-maintenance.mjs');
const fixture = mkdtempSync(join(tmpdir(), 'abralo-bootstrap-'));
const installRoot = join(fixture, 'program'), data = join(fixture, 'data');
mkdirSync(join(installRoot, 'versions'), { recursive: true });
function copyVersion(source, name) {
  const target = join(installRoot, 'versions', name); mkdirSync(target);
  for (const entry of ['dist', 'scripts', 'runtime', 'package.json', 'release.json']) cpSync(join(source, entry), join(target, entry), { recursive: true });
  symlinkSync(join(source, 'node_modules'), join(target, 'node_modules'), 'junction');
  return target;
}
const previous = copyVersion(legacySource, 'legacy');
const candidate = copyVersion(candidateSource, 'new');
const broken = copyVersion(candidateSource, 'broken');
writeFileSync(join(broken, 'dist/service/apps/service/src/main.js'), 'process.exit(12);');
writeFileSync(join(installRoot, 'current.txt'), previous);
for (const name of ['Open Workspace.ps1', 'Background Workspace.ps1']) writeFileSync(join(installRoot, name), '# fixture shortcut');
const { Store } = await import(pathToFileURL(join(candidate, 'dist/service/apps/service/src/store.js')));
const { alive, health } = await import(pathToFileURL(join(candidate, 'dist/service/apps/service/src/maintenance-files.js')));
const Database = createRequire(join(candidate, 'package.json'))('better-sqlite3');
const store = new Store(data); const owner = store.createOwner('Fixture');
store.set('workspace.onboarded', true);
const agent = store.createEmployee(owner.id, { name: 'Fixture', harness: 'codex', model: '', role: '', cwd: '', instructions: '' });
const message = store.addMessage(agent.dmId, owner.id, owner.name, 'human', 'Preserve bootstrap conversation');
store.close();
const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port; await new Promise(r => socket.close(r));
async function until(fn, timeout = 120000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await delay(250); } throw new Error('Fixture timed out: ' + fixture); }
async function command(args) {
  const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', errors = '';
  child.stdout.on('data', d => output += d); child.stderr.on('data', d => errors += d);
  const code = await new Promise((r, reject) => { child.once('error', reject); child.once('exit', r); }); assert.equal(code, 0, errors); return JSON.parse(output);
}
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const service = spawn(join(previous, 'runtime/node.exe'), [join(previous, 'dist/service/apps/service/src/main.js')], { cwd: previous, windowsHide: true, stdio: 'ignore', env: { ...process.env, WORKSPACE_DATA_DIR: data, WORKSPACE_PORT: String(port), WORKSPACE_HOST: '127.0.0.1', WORKSPACE_BUILD_ID: 'legacy', WORKSPACE_INSTALL_ROOT: '', WORKSPACE_MAINTENANCE_JOB: '' } });
const checks = [];
try {
  await until(async () => (await health(port))?.buildId === 'legacy');
  const db = new Database(join(data, 'workspace.db'));
  const time = new Date().toISOString();
  db.prepare("INSERT INTO runs(id,conversation_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key) VALUES('fixture-busy',?,?,?,?,?,'running',?,?,'fixture')").run(agent.dmId, owner.id, agent.id, message.id, message.id, time, time);
  async function prepareAndArm(target) {
    const file = join(fixture, 'config.json');
    writeFileSync(file, JSON.stringify({ installRoot, data, candidateRoot: target, oldPid: read(join(data, 'runtime.json')).pid, port }));
    const job = await command([helper, '--prepare', file]);
    await command([helper, '--arm', job.jobFile]); return job;
  }
  const first = await prepareAndArm(candidate);
  await until(() => existsSync(join(data, 'maintenance', first.id, 'ready.json')));
  await delay(6000);
  assert(alive(service.pid)); assert.equal(read(first.jobFile).phase, 'draining');
  db.prepare("UPDATE runs SET state='completed' WHERE id='fixture-busy'").run(); db.close();
  await until(() => ['succeeded', 'failed', 'rolled-back'].includes(read(first.jobFile).phase));
  assert.equal(read(first.jobFile).phase, 'succeeded', JSON.stringify(read(first.jobFile)));
  assert(!alive(service.pid)); assert.equal((await health(port)).buildId, 'new');
  assert.equal(readFileSync(join(installRoot, 'current.txt'), 'utf8').trim(), candidate);
  const saved = new Database(read(first.jobFile).backup, { readonly: true });
  assert.equal(saved.pragma('quick_check', { simple: true }), 'ok');
  assert.equal(saved.prepare('SELECT text FROM messages WHERE id=?').get(message.id).text, message.text); saved.close();
  await until(() => !existsSync(join(data, 'maintenance/active.json'))); await delay(500);
  checks.push('waits for active run; detached helper survives legacy exit; backup and messages preserved; stable launcher installed; new build verified');
  const failing = await prepareAndArm(broken);
  await until(() => ['succeeded', 'failed', 'rolled-back'].includes(read(failing.jobFile).phase));
  assert.equal(read(failing.jobFile).phase, 'rolled-back', JSON.stringify(read(failing.jobFile)));
  assert.equal((await health(port)).buildId, 'new');
  assert.equal(readFileSync(join(installRoot, 'current.txt'), 'utf8').trim(), candidate);
  checks.push('failed startup returns to unchanged previous build without restoring database');
  console.log(JSON.stringify({ status: 'passed', fixture, checks, liveWorkspaceTouched: false }, null, 2));
} finally {
  if (existsSync(join(data, 'runtime.json'))) { const runtime = read(join(data, 'runtime.json')); if (runtime.port === port && alive(runtime.pid)) process.kill(runtime.pid); }
}
