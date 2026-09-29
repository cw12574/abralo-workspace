// One native provider turn, using only a disposable heartbeat worker.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

if (!process.argv[2]) throw new Error('Pass a package directory');
const root = resolve(process.argv[2]);
process.chdir(root);
const harness = process.argv.includes('--claude') ? 'claude' : 'codex';
const module = await import(pathToFileURL(join(root, `dist/service/apps/service/src/adapters/${harness}.js`)).href);
const adapter = new module[harness === 'codex' ? 'CodexAdapter' : 'ClaudeAdapter']();
const fixture = mkdtempSync(join(tmpdir(), 'abralo-cancel-'));
const worker = join(fixture, 'preview-worker.cjs');
const pidFile = join(fixture, 'worker.pid');
const heartbeat = join(fixture, 'heartbeat.txt');
const runtime = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
writeFileSync(worker, `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),100);setTimeout(()=>process.exit(0),45000);`);
const command = process.platform === 'win32' ? `& "${runtime}" "${worker}"` : `"${runtime}" "${worker}"`;
const report = { platform: process.platform, harness, approvals: 0, denials: 0, deniedCommands: [], workerStarted: false, abortRequested: false };
const signal = new AbortController();
let settled = false, runError, complete, threadId;
const delay = ms => new Promise(r => setTimeout(r, ms));
let run;
try {
  run = adapter.run({ id: crypto.randomUUID(), employee: { id: 'fixture', ownerId: 'fixture', dmId: 'fixture', name: 'Cancellation verification', kind: 'agent', harness, model: '', cwd: fixture, role: '', instructions: 'Only execute the exact supplied heartbeat fixture command once. Do not edit any files, inspect other folders, browse or launch other processes. When a Bash shell is used on Windows, wrap the supplied PowerShell command in powershell.exe -NoProfile -NonInteractive -Command.', permissionMode: 'ask', createdAt: new Date().toISOString() },
    prompt: `Execute this exact foreground command once and wait for it to finish. This is a cancellation test; the host will interrupt it. Do not alter the command or worker file.\n${command}`,
    attachments: [], signal: signal.signal,
    emit: e => {
      if (e.type === 'complete') complete = e.data;
      if (e.type === 'session') threadId = e.data.id;
    },
    decide: async req => {
      const raw = String(req.detail?.command || req.title || '').replaceAll('\\"', '"').replaceAll("'", '"');
      // A shell wrapper is allowed only around the exact generated fixture command.
      const stripped = raw.replace(/^(?:"[^"\r\n]*(?:powershell|pwsh)\.exe"|(?:powershell|pwsh)(?:\.exe)?)\s+(?:(?:-NoProfile|-NonInteractive|-NoLogo)\s+)*-Command\s+(["'])([\s\S]*)\1$/i, '$2');
      const normalize = value => value.replaceAll('\\', '/').replace(/\/{2,}/g, '/');
      const allow = normalize(raw) === normalize(command) || normalize(stripped) === normalize(command);
      allow ? report.approvals++ : report.denials++;
      if (!allow) report.deniedCommands.push(raw.slice(0, 1200));
      return { allow };
    },
  }).catch(e => { runError = String(e); }).finally(() => { settled = true; });
  const deadline = Date.now() + 90000;
  while (!existsSync(heartbeat) && !settled && Date.now() < deadline) await delay(100);
  if (!existsSync(heartbeat)) throw new Error('Native worker did not reach its heartbeat; cancellation is unverified. ' + (runError || ''));
  report.workerStarted = true;
  signal.abort();
  report.abortRequested = true;
  const stopDeadline = Date.now() + 15000;
  while (!settled && Date.now() < stopDeadline) await delay(100);
  if (process.argv.includes('--clean-background')) {
    report.backgroundCleanup = await adapter.request('thread/backgroundTerminals/clean', { threadId }, 10000);
  }
  await delay(500);
  const before = readFileSync(heartbeat, 'utf8');
  await delay(1500);
  const stopped = before === readFileSync(heartbeat, 'utf8');
  report.turnSettled = settled;
  report.heartbeatStopped = stopped;
  report.providerReportedCancelled = !!complete?.cancelled;
  if (runError) report.runError = runError;
  if (!settled || !stopped || !complete?.cancelled) throw new Error('Cancellation did not confirm a stopped worker and cancelled turn.');
  report.status = 'passed';
} catch (e) { report.status = 'failed'; report.error = String(e); process.exitCode = 1; }
finally {
  signal.abort();
  await adapter.dispose();
  // Remove only this fixture's surviving worker, never unrelated Node processes.
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        if (process.platform === 'win32') {
          const cmd = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`], { encoding: 'utf8', windowsHide: true });
          if (cmd.includes(worker)) execFileSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { stdio: 'pipe', windowsHide: true });
        } else if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(worker)) process.kill(pid, 'SIGTERM');
      } catch { /* Worker already exited. */ }
    }
  }
  await Promise.race([run, delay(3000)]);
  console.log(JSON.stringify(report, null, 2));
}
