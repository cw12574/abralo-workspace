import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-notifications-ui-')));
const user = store.createOwner('Tester');
store.set('workspace.onboarded', true);
const { app } = await createApp(store);
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
mkdirSync('evidence', { recursive: true });
try {
  await page.goto(origin + '/#setup=' + store.bootstrapToken);
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  await page.getByRole('button', { name: 'notifications', exact: true }).click();
  await expect(page.getByText('In-app alerts are on. Desktop alerts need browser permission on this device.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn off notifications' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow browser desktop alerts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send a test' })).toHaveCount(0);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.screenshot({ path: `evidence/notifications-health-${theme}.png` });
    await page.getByRole('button', { name: 'Allow browser desktop alerts' }).click();
    await expect(page.getByRole('status')).toContainText('blocked');
    await page.screenshot({ path: `evidence/notifications-error-${theme}.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `evidence/notifications-mobile-${theme}.png` });
    const dialog = page.getByRole('dialog');
    const box = (await dialog.boundingBox())!;
    if (box.x < 0 || box.x + box.width > 390) throw Error('Notifications dialog overflows mobile');
    await page.setViewportSize({ width: 1280, height: 640 });
  }
  await page.getByRole('button', { name: 'Turn off notifications' }).click();
  await expect(page.getByRole('button', { name: 'Turn on notifications' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow browser desktop alerts' })).toHaveCount(0);
  await page.screenshot({ path: 'evidence/notifications-off.png' });
  await page.getByRole('button', { name: 'Turn on notifications' }).click();
  const granted = await chromium.launchPersistentContext(
    mkdtempSync(join(tmpdir(), 'workspace-notification-browser-')),
    { channel: 'chrome', headless: true, permissions: ['notifications'] },
  );
  const grantedPage = await granted.newPage();
  grantedPage.on('console', (message) => { if (message.type() === 'warning' || message.type() === 'error') console.log('Browser:', message.text()); });
  grantedPage.on('pageerror', (error) => console.log('Browser page error:', error.message));
  await grantedPage.goto(origin + '/#setup=' + store.bootstrapToken);
  await expect.poll(() => store.one('SELECT COUNT(*) n FROM subscriptions WHERE user_id=?', user.id).n,
    { timeout: 15000 }).toBe(1);
  await granted.close();
  if (errors.length) throw Error(errors.join('\n'));
  console.log('Notification settings health, error, laptop, mobile, and themes passed.');
} finally {
  await browser.close();
  await app.close();
}
