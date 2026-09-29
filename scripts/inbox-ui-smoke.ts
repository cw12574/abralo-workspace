import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-inbox-ui-')));
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
const team = store.setting('workspace.team');
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
for (let n = 0; n < 12; n++) {
  const message = store.addMessage(
    chief.dmId,
    chief.id,
    chief.name,
    'agent',
    `Private update ${n}: a concise progress note with enough text to check notification wrapping and spacing.`,
  );
  store.run('UPDATE inbox SET seen=1 WHERE message_id=?', message.id);
}
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
  await page.getByRole('button', { name: /Notifications, 1 unread/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Thread reply');
  await expect(page.locator('.notification-item')).toHaveCount(13);
  const cardBoxes = await page.locator('.notification-item').evaluateAll((items) =>
    items.map((item) => {
      const box = item.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    }),
  );
  if (cardBoxes.some((box, i) => i > 0 && cardBoxes[i - 1].bottom > box.top + 1))
    throw Error('Notification cards overlap vertically');
  if (
    (await page
      .locator('.notification-item')
      .first()
      .locator('span > span')
      .evaluate((el) => getComputedStyle(el).webkitLineClamp)) !== '3'
  )
    throw Error('Notification preview is not clamped');
  await page.screenshot({ path: 'evidence/notification-inbox.png' });
  await page.locator('.notification-item').filter({ hasText: reply.text }).click();
  await expect(page.locator('.thread .message-highlight')).toContainText(reply.text);
  await expect(page).toHaveTitle('#team · Workspace');
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
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
  await expect(page).toHaveTitle('#team · Workspace');
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await page.locator('.notification-item').filter({ hasText: reply.text }).click();
  await expect.poll(async () => (await pane.boundingBox())!.width).toBe(before + 90);
  await handle.dblclick();
  await expect.poll(async () => (await pane.boundingBox())!.width).toBe(390);
  report.checks.push(
    'notification cards remain spaced and readable; inbox opens exact older thread reply; selected room and panel width persist',
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
  writeFileSync('evidence/inbox-ui.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await browser.close();
  await app.close();
}
