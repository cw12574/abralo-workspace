import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
const source = process.cwd();
const evidenceTag = process.env.WORKSPACE_EVIDENCE_TAG || '';
if (evidenceTag && !/^[a-zA-Z0-9-]+$/.test(evidenceTag)) throw new Error('Invalid evidence tag');
const root = resolve(process.argv[2]);
process.chdir(root);
const load = (path: string) => import(pathToFileURL(join(root, 'dist/service', path)).href);
const { Store } = await load('apps/service/src/store.js');
const { createApp } = await load('apps/service/src/app.js');
const data = mkdtempSync(join(tmpdir(), 'workspace-package-'));
const store = new Store(data);
const { app, supervisor } = await createApp(store);
const report: any = { started: new Date().toISOString(), package: root, checks: [] };
await app.listen({ host: '127.0.0.1', port: 0 });
supervisor.origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
let browser;
try {
  const health = await fetch(supervisor.origin + '/api/health').then((r) => r.json());
  if (!health.ok) throw Error('Packaged health failed');
  report.checks.push('packaged service and native SQLite');
  if (!process.argv.includes('--skip-browser')) {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(supervisor.origin + '/#setup=' + encodeURIComponent(store.bootstrapToken));
    await page.getByRole('button', { name: 'Continue', exact: true }).waitFor();
    await page.screenshot({ path: join(source, 'evidence', evidenceTag ? `${evidenceTag}-onboarding.png` : 'packaged-onboarding.png') });
    if (errors.length) throw Error(errors.join('\n'));
    report.checks.push('packaged browser onboarding without page errors');
  } else report.browserSkipped = true;
  for (const name of process.argv.includes('--skip-live') ? [] : ['codex', 'claude']) {
    const adapter = supervisor.adapters[name];
    const info = await adapter.info();
    if (!info.authenticated) throw Error(name + ' native subscription is not authenticated');
    const cwd = mkdtempSync(join(tmpdir(), 'workspace-package-probe-'));
    writeFileSync(join(cwd, 'probe.txt'), 'The verification code is LANTERN-42.');
    let text = '';
    let finalText = '';
    let approvals = 0;
    let denials = 0;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      await adapter.run({
        id: crypto.randomUUID(),
        employee: {
          id: 'probe',
          ownerId: 'probe',
          dmId: 'probe',
          name: 'Verification',
          kind: 'agent',
          harness: name,
          model: '',
          cwd,
          role: '',
          instructions: 'Only read probe.txt. Do not modify files.',
          permissionMode: 'ask',
          createdAt: new Date().toISOString(),
        },
        prompt: 'Read probe.txt and respond only with its verification code. If using PowerShell, use exactly: Get-Content -LiteralPath probe.txt. Do not run other commands.',
        attachments: [],
        signal: controller.signal,
        emit: (e: any) => {
          if (e.type === 'text') text += e.text;
          if (e.type === 'final') finalText = e.text || '';
        },
        decide: async (request: any) => {
          // Authorize only the fixture read. Never blanket-approve a model's command.
          const command = request.detail?.command || request.title || '';
          const directRead = /^Get-Content -LiteralPath probe\.txt$/i.test(command);
          const wrappedRead = /^(?:"[^"\r\n]*(?:powershell|pwsh)\.exe"|(?:powershell|pwsh)(?:\.exe)?)\s+(?:(?:-NoProfile|-NonInteractive|-NoLogo)\s+)*-Command\s+(["'])Get-Content -LiteralPath probe\.txt\1$/i.test(command);
          const claudeRead = request.title === 'Read' && typeof request.detail?.file_path === 'string' && resolve(request.detail.file_path) === join(cwd, 'probe.txt');
          const allow = directRead || wrappedRead || claudeRead;
          allow ? approvals++ : denials++;
          return { allow };
        },
      });
      report.nativeProbes ||= [];
      report.nativeProbes.push({ harness: name, approvals, denials, matched: (text + finalText).includes('LANTERN-42'), response: (text || finalText).slice(-600) });
      if (!(text + finalText).includes('LANTERN-42')) throw Error(name + ' file probe failed');
      report.checks.push(name + ' packaged native subscription and real file read');
    } finally {
      clearTimeout(timeout);
    }
  }
  report.status = 'passed';
} catch (e) {
  report.status = 'failed';
  report.error = String(e);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app.close();
  mkdirSync(join(source, 'evidence'), { recursive: true });
  writeFileSync(
    join(
      source,
      'evidence',
      evidenceTag ? `${evidenceTag}.json` : process.argv.includes('--skip-live') ? 'installed.json' : 'packaged.json',
    ),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
