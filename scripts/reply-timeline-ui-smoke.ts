import { chromium, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

// Drives a fake agent turn through the real server and checks the reply shows its
// text and steps interleaved in the order they happened.
const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-reply-timeline-')));
const owner = store.createOwner('Chris');
store.set('workspace.onboarded', true);
store.set('workspace.name', 'Studio');
const agent = store.createEmployee(owner.id, {
  name: 'Ada',
  role: 'Engineering',
  harness: 'codex',
  model: '',
  cwd: '',
  instructions: '',
});
const { app, supervisor } = await createApp(store);
supervisor.adapters.codex = {
  info: async () => ({}) as any,
  dispose: async () => {},
  run: async (input) => {
    const step = (id: string, title: string, extra: any = {}) =>
      input.emit({ type: 'activity', id, data: { type: 'tool', title, state: 'complete', ...extra } });
    step('worktree', 'Isolated working copy');
    step('tools', 'Workspace tools');
    input.emit({ type: 'text', text: "I'll look at how replies are stored." });
    step('read', 'Read', { detail: '{"file":"supervisor.ts"}' });
    input.emit({ type: 'activity', id: 'read', data: { append: '\n\nResult:\nok', state: 'complete' } });
    step('think', 'Thinking', { type: 'reasoning' });
    step('grep', 'Grep');
    input.emit({ type: 'text', text: 'Found the cause.' });
    step('edit', 'Edit');
    input.emit({ type: 'text', text: 'Fixed it.' });
    input.emit({ type: 'complete' });
  },
};
const address = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors: string[] = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const bootstrap = await page.request.post(address + '/api/bootstrap', {
  data: { token: store.bootstrapToken },
  headers: { 'x-workspace-request': '1' },
});
if (!bootstrap.ok()) throw new Error(await bootstrap.text());
const sent = await page.request.post(`${address}/api/conversations/${agent.dmId}/messages`, {
  data: { text: 'Why are steps grouped?', key: uid(), recipients: [agent.id] },
  headers: { 'x-workspace-request': '1' },
});
if (!sent.ok()) throw new Error(await sent.text());
await supervisor.dispatch();
await Promise.all([...supervisor.inflight]);

await page.goto(address);
await page.getByRole('button', { name: 'Ada', exact: false }).first().click();
const reply = page.locator('.message').filter({ hasText: 'Fixed it.' });
await expect(reply).toBeVisible();
const order = await reply.locator('.message-content > .tool-group, .message-content > .prose').evaluateAll(
  (nodes) =>
    nodes.map((node) =>
      node.classList.contains('prose')
        ? (node.textContent || '').trim()
        : [...node.querySelectorAll('.tool-summary-latest, .tool-detail > summary > span')]
            .map((label) => label.textContent)
            .join(' | '),
    ),
);
const expected = [
  'Workspace tools',
  "I'll look at how replies are stored.",
  'Grep',
  'Found the cause.',
  'Edit',
  'Fixed it.',
];
if (JSON.stringify(order) !== JSON.stringify(expected))
  throw new Error('Unexpected reply order: ' + JSON.stringify(order));
await expect(reply.getByText('2 steps')).toBeVisible();
await expect(reply.getByText('3 steps')).toBeVisible();
await expect(reply.getByText('Tool result')).toHaveCount(0);
mkdirSync('evidence', { recursive: true });
await reply.screenshot({ path: 'evidence/reply-timeline-collapsed.png' });
await reply.getByRole('button', { name: 'Show 3 steps' }).click();
await expect(reply.getByText('Read', { exact: true })).toBeVisible();
await reply.screenshot({ path: 'evidence/reply-timeline-expanded.png' });
if (pageErrors.length) throw new Error(pageErrors.join('\n'));
console.log(JSON.stringify({ status: 'passed', order }));
await browser.close();
await app.close();
