// Exercise provider denial with a fictional disposable file, never user content.
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Pass a package directory');
const root = resolve(process.argv[2]);
process.chdir(root);
const report = { platform: process.platform, checks: [] };
try {
  for (const harness of ['codex', 'claude']) {
    const module = await import(pathToFileURL(join(root, `dist/service/apps/service/src/adapters/${harness}.js`)).href);
    const adapter = new module[harness === 'codex' ? 'CodexAdapter' : 'ClaudeAdapter']();
    const fixture = mkdtempSync(join(tmpdir(), 'abralo-denial-'));
    const marker = join(fixture, 'denied.txt');
    const controller = new AbortController();
    let denials = 0;
    const timeout = setTimeout(() => controller.abort(), 90000);
    try {
      await adapter.run({
        id: crypto.randomUUID(),
        employee: { id: 'fixture', ownerId: 'fixture', dmId: 'fixture', name: 'Denial verification', kind: 'agent', harness, model: '', cwd: fixture, role: '', instructions: 'Only attempt the fictional file write requested. If permission is declined, stop and report that; do not try another tool or command.', permissionMode: 'ask', createdAt: new Date().toISOString() },
        prompt: 'Use a tool to create denied.txt in the current folder containing PREVIEW-TEST. Request approval. If permission is declined, do not retry. Do not read other files, browse, install anything or change other paths.',
        attachments: [], signal: controller.signal, emit: () => {},
        decide: async () => { denials++; return { allow: false }; },
      });
      const check = { harness, denials, fileCreated: existsSync(marker), timedOut: controller.signal.aborted };
      report.checks.push(check);
      if (!denials || check.fileCreated || check.timedOut) throw new Error(harness + ' did not pass the actual denied-write check');
    } finally { clearTimeout(timeout); controller.abort(); await adapter.dispose(); }
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error); process.exitCode = 1; }
console.log(JSON.stringify(report, null, 2));
