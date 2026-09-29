import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
const store = new Store(mkdtempSync(join(tmpdir(), 'abralo-send-check-')));
const owner = store.createOwner('Tester');
store.set('workspace.onboarded', true);
const agent = store.createEmployee(owner.id, {
  name: 'Send Check',
  role: 'Fixture',
  harness: 'codex',
  model: '',
  cwd: '',
  instructions: '',
});
const { app, supervisor } = await createApp(store);
supervisor.dispatch = async () => {};
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.route('**/api/providers*', (r) => r.fulfill({ json: [] }));
try {
  await page.goto(origin + '/#setup=' + store.bootstrapToken);
  await page.getByRole('button', { name: 'Send Check', exact: false }).first().click();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeVisible();
  await page.waitForTimeout(300);
  let release!: () => void;
  let hold = new Promise<void>((resolve) => (release = resolve));
  let mode = 'hold';
  let requests: any[] = [];
  await page.route('**/api/conversations/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    requests.push(route.request().postDataJSON());
    if (mode === 'fail')
      return route.fulfill({ status: 503, json: { error: 'Temporary send failure' } });
    if (mode === 'hold') await hold;
    if (mode === 'hold-ack') {
      const response = await route.fetch();
      await hold;
      return route.fulfill({ response });
    }
    return route.continue();
  });
  const text = 'Immediate message appearance diagnostic';
  await composer.fill(text);
  await composer.press('Enter');
  await expect.poll(() => requests.length).toBe(1);
  const message = page.locator('.message').filter({ hasText: text });
  await expect(message).toHaveCount(1);
  await expect(message).toBeInViewport();
  await expect(message.getByText('Sending…', { exact: true })).toBeVisible();
  await expect(composer).toHaveValue('');
  expect(store.one('SELECT COUNT(*) n FROM messages WHERE text=?', text).n).toBe(0);
  await composer.fill('Keep my next draft');
  await composer.press('Enter');
  expect(requests.length).toBe(1);
  release();
  await expect(message.getByText('Sending…', { exact: true })).toHaveCount(0);
  await expect(message).toHaveCount(1);
  await expect(composer).toHaveValue('Keep my next draft');

  // A server echo can arrive before its HTTP acknowledgement. Identical text
  // still represents two separate sends, reconciled by their operation keys.
  mode = 'hold-ack';
  hold = new Promise<void>((resolve) => (release = resolve));
  await composer.fill(text);
  await composer.press('Enter');
  await expect.poll(() => requests.length).toBe(2);
  await expect
    .poll(() => store.one('SELECT COUNT(*) n FROM messages WHERE text=?', text).n)
    .toBe(2);
  await expect(message).toHaveCount(2);
  await page.evaluate(() => window.dispatchEvent(new Event('workspace-reconnected')));
  await expect(message.getByText('Sending…', { exact: true })).toHaveCount(0);
  await expect(message).toHaveCount(2);
  release();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await composer.fill('A message that needs a retry');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();

  mode = 'fail';
  await composer.press('Enter');
  const failed = page.locator('.message').filter({ hasText: 'A message that needs a retry' });
  await expect(failed.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(failed).toHaveCount(1);
  await expect(composer).toHaveValue('');
  const failedKey = requests.at(-1).key;
  mkdirSync('evidence', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.screenshot({ path: `evidence/send-retry-${theme}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(failed.getByRole('button', { name: 'Retry', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'evidence/send-retry-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  mode = 'normal';
  await failed.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(failed.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await expect(failed).toHaveCount(1);
  expect(requests.at(-1).key).toBe(failedKey);
  expect(
    store.one('SELECT COUNT(*) n FROM messages WHERE text=?', 'A message that needs a retry').n,
  ).toBe(1);
  expect(store.one('SELECT COUNT(*) n FROM runs').n).toBe(0);
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      status: 'passed',
      checks: [
        'visible before server acceptance',
        'composer clears immediately',
        'next draft preserved',
        'duplicate Enter prevented',
        'echo before acknowledgement',
        'identical consecutive messages',
        'failure and same-key retry',
        'light/dark/mobile',
      ],
      fixture: 'isolated database; agent dispatch disabled',
    }),
  );
} finally {
  await browser.close();
  await app.close();
}
