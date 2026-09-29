import { chromium } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../apps/service/src/adapters/codex.js';
import { ClaudeAdapter } from '../apps/service/src/adapters/claude.js';
import { OpenCodeAdapter } from '../apps/service/src/adapters/opencode.js';
const dir = mkdtempSync(join(tmpdir(), 'workspace-image-')),
  path = join(dir, 'label.png');
const browser = await chromium.launch({ channel: 'chrome', headless: true }),
  page = await browser.newPage({ viewport: { width: 500, height: 250 } });
await page.setContent(
  '<body style="display:grid;place-items:center;background:#f8f5ec;font:48px monospace"><p>ORBIT-731</p></body>',
);
await page.screenshot({ path });
await browser.close();
const reports = [];
for (const [name, adapter] of Object.entries({
  codex: new CodexAdapter(),
  claude: new ClaudeAdapter(),
  opencode: new OpenCodeAdapter(),
})) {
  let text = '',
    model = '';
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 90000);
  try {
    if (name === 'opencode') {
      const p = await (adapter as OpenCodeAdapter).api('/provider');
      const eligible = p.all
        .filter((x: any) => p.connected.includes(x.id))
        .flatMap((x: any) =>
          Object.values(x.models)
            .filter((m: any) => m.capabilities?.input?.image && m.cost?.input === 0)
            .map((m: any) => x.id + '/' + m.id),
        );
      if (!eligible.length) {
        reports.push({
          harness: name,
          status: 'unverified',
          reason: 'No connected free vision model available; no paid model was selected.',
        });
        continue;
      }
      model = eligible[0];
    }
    await adapter.run({
      id: crypto.randomUUID(),
      employee: {
        id: 'image',
        ownerId: 'test',
        dmId: 'test',
        name: 'Image test',
        kind: 'agent',
        harness: name as any,
        model,
        cwd: dir,
        role: '',
        instructions: 'Read the attached image visually. Do not use tools.',
        createdAt: new Date().toISOString(),
      },
      prompt: 'Reply with only the label printed in this image.',
      attachments: [{ path, mime: 'image/png', name: 'label.png' }],
      signal: controller.signal,
      decide: async () => ({ allow: false }),
      emit: (e) => {
        if (e.type === 'text') text += e.text;
      },
    });
    reports.push({
      harness: name,
      model,
      status: text.includes('ORBIT-731') ? 'passed' : 'failed',
      response: text.slice(-150),
    });
  } catch (e) {
    reports.push({ harness: name, status: 'failed', error: String(e) });
  } finally {
    clearTimeout(timer);
    await adapter.dispose();
  }
}
mkdirSync('evidence', { recursive: true });
writeFileSync('evidence/images.json', JSON.stringify(reports, null, 2));
console.log(reports);
if (reports.some((r) => r.status === 'failed')) process.exitCode = 1;
