import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-message-navigation-ui-')));
const u = store.createOwner('Tester');
store.set('workspace.onboarded', true);
const chief = store.createEmployee(u.id, {
  name: 'Chief of Staff',
  harness: 'codex',
  model: '',
  cwd: '',
  role: '',
  instructions: '',
});
const team = chief.dmId;
const root = store.addMessage(
  team,
  u.id,
  u.name,
  'human',
  'Please investigate the onboarding flow.',
);
const reply = store.addMessage(
  team,
  chief.id,
  chief.name,
  'agent',
  'I found the answer in this thread.',
  root.id,
);
// Ensure navigation finds a reply outside the latest page.
for (let n = 0; n < 90; n++)
  store.addMessage(team, u.id, u.name, 'human', `Follow-up ${n}`, root.id);
const { app } = await createApp(store);
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
await page.route('**/api/providers*', (r) => r.fulfill({ json: [] }));
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const report: any = { checks: [] };
try {
  await page.goto(origin + '/#setup=' + store.bootstrapToken);
  const openReply = async () => {
    await page.getByRole('button', { name: 'Search workspace', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search messages and decisions', exact: true }).fill(reply.text);
    await page.locator('.search-results button').filter({ hasText: reply.text }).click();
    await expect(page.locator('.thread .message-highlight')).toContainText(reply.text);
  };
  await openReply();
  await expect(page.locator('.notification-button, .notification-popover')).toHaveCount(0);
  const pane = page.locator('.thread'),
    handle = page.getByRole('separator', { name: 'Resize thread' });
  const before = (await pane.boundingBox())!.width;
  const edge = (await handle.boundingBox())!;
  await page.mouse.move(edge.x + 4, edge.y + 200);
  await page.mouse.down();
  await page.mouse.move(edge.x - 96, edge.y + 200, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await pane.boundingBox())!.width).toBe(before + 100);
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await pane.boundingBox())!.width).toBe(before + 90);
  await page.screenshot({ path: 'evidence/thread-resized.png' });
  await page.reload();
  await openReply();
  await expect.poll(async () => (await pane.boundingBox())!.width).toBe(before + 90);
  await handle.dblclick();
  await expect.poll(async () => (await pane.boundingBox())!.width).toBe(390);
  report.checks.push(
    'search opens exact older thread reply; selected conversation and panel width persist',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(handle).toBeHidden();
  await expect(page.locator('.thread .message-highlight')).toContainText(reply.text);
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw Error('Mobile overflow');
  report.checks.push('mobile full-width thread and no overflow');
  if (errors.length) throw Error(errors.join('\n'));
  report.status = 'passed';
} catch (e) {
  report.status = 'failed';
  report.error = String(e);
  process.exitCode = 1;
} finally {
  mkdirSync('evidence', { recursive: true });
  writeFileSync('evidence/message-navigation-ui.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await browser.close();
  await app.close();
}
