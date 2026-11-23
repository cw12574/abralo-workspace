import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
import { startStandInMcp } from '../tests/helpers/stand-in-mcp.js';

// Agents connect what they need. The human sees one Sign in button the first
// time, with the agent's reason; later employees use the account with no card.
// Two local stand-in MCP services; Abralo's sign-in, callback, vault and live
// card updates are real.
delete process.env.WORKSPACE_MAINTENANCE_JOB;
const oauth = await startStandInMcp('oauth');
const keyed = await startStandInMcp('api_key', 'sk_test_valid_key');
const store = new Store(mkdtempSync(join(tmpdir(), 'abralo-connect-any-ui-')));
const user = store.createOwner('Chris');
store.set('workspace.onboarded', true);
store.set('notifications.' + user.id, { enabled: false, sound: false, privatePreview: true });
const employee = (name: string) =>
  store.createEmployee(user.id, { name, harness: 'claude', model: '', cwd: '', role: 'Product', instructions: '' });
const engineer = employee('Abralo Engineer 2');
const marketer = employee('Growth');
const { app, supervisor, broker } = await createApp(store, {
  staticRoot: resolve(process.env.CONNECTIONS_STATIC_ROOT || 'dist/web'),
});
supervisor.infos = async () => [
  { harness: 'codex', installed: true, authenticated: true, version: 'test', detail: 'chatgpt · plus', models: [] },
  { harness: 'claude', installed: true, authenticated: true, version: 'test', detail: 'claude.ai · max', models: [] },
  { harness: 'opencode', installed: false, authenticated: false, version: '', detail: '' },
] as any;
broker.discovery = { allowLocal: true, registry: 'https://registry.invalid', timeoutMs: 1500 };
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const runFor = (e: any) => ({ id: uid(), user_id: user.id, employee_id: e.id, conversation_id: e.dmId, message_id: uid() });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 640 } });
await context.addCookies([{ name: 'workspace', value: store.newSession(user.id), url: origin }]);
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
mkdirSync('evidence', { recursive: true });
let failure = false;
async function shots(name: string) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    for (const viewport of [
      { width: 1280, height: 640 },
      { width: 390, height: 780 },
    ]) {
      await page.setViewportSize(viewport);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `evidence/connect-any-${name}-${viewport.width}-${theme}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}
try {
  // 1. An agent needs a service it has never used. It asks by address (or name).
  const asked: any = await broker.requestAny(runFor(engineer), oauth.url, 'read', 'check your email domain setup');
  if (asked.status !== 'setup_required') throw new Error('Expected a setup card: ' + JSON.stringify(asked));
  await page.goto(origin + '/?conversation=' + engineer.dmId);
  const card = page.locator('.connection-row');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Abralo Engineer 2 needs Acme Mail to check your email domain setup.');
  await expect(card.getByRole('button')).toHaveCount(1); // One thing to do.
  await card.scrollIntoViewIfNeeded();
  await shots('sign-in-card');
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    card.getByRole('button', { name: 'Sign in to Acme Mail' }).click(),
  ]);
  await popup.waitForEvent('close', { timeout: 10000 }); // Real callback closes the window.
  await expect(card).toHaveCount(0); // Connected: the card goes away on its own.
  const account = store.one("SELECT * FROM connections WHERE label='Acme Mail' AND state='ready'");
  expect(broker.status(account.id, engineer.id, user.id)).toMatchObject({ status: 'ready' });

  // 2. Another employee needs it later: no card at all, just a note.
  const second: any = await broker.requestAny(runFor(marketer), 'Acme Mail', 'write', 'send the launch email');
  if (!second.sharedAutomatically) throw new Error('Expected automatic sharing: ' + JSON.stringify(second));
  await page.goto(origin + '/?conversation=' + marketer.dmId);
  await expect(page.getByText('Growth is using your Acme Mail account.')).toBeVisible();
  await expect(page.locator('.connection-row')).toHaveCount(0);

  // 3. A key-only service: the card asks for the key instead of opening a window.
  await broker.requestAny(runFor(engineer), keyed.url, 'read', 'read delivery logs');
  await page.goto(origin + '/?conversation=' + engineer.dmId);
  const keyCard = page.locator('.connection-row');
  await expect(keyCard).toContainText('needs Acme Mail to read delivery logs.');
  await keyCard.getByLabel(/API key/).fill('sk_test_wrong_key');
  await keyCard.getByRole('button', { name: /^Connect/ }).click();
  await expect(keyCard).toContainText('did not accept that API key');
  await keyCard.scrollIntoViewIfNeeded();
  await shots('api-key');
  await keyCard.getByLabel(/API key/).fill('sk_test_valid_key');
  await keyCard.getByRole('button', { name: /^Connect/ }).click();
  await expect(keyCard).toHaveCount(0);
  expect(JSON.stringify(store.all('SELECT * FROM connections'))).not.toContain('sk_test_valid_key');

  // 4. Connections page: accounts and one setting. No search, nothing to configure.
  await page.getByRole('button', { name: 'Connections' }).click();
  await expect(page.getByLabel('Connect a service')).toHaveCount(0);
  // One row per account, saying who uses it; no separate "granted" rows.
  // AI accounts read as plain plans, with the default marked once and nothing to click.
  const ai = page.getByRole('list', { name: 'AI accounts' });
  await expect(ai.locator('.provider-account-row')).toHaveCount(2);
  await expect(ai).toContainText('ChatGPT Plus');
  await expect(ai).toContainText('Claude Max');
  await expect(ai.locator('.surface-tag')).toHaveCount(1);
  await expect(ai.getByRole('button', { name: /Sign in|Refresh|Check status/ })).toHaveCount(0);
  await expect(page.getByText('OpenCode')).toHaveCount(0);
  const services = page.getByRole('list', { name: 'Services' });
  await expect(services.locator('.connection-page-row').filter({ hasText: 'Connected' })).toHaveCount(2);
  await expect(services.getByText('Used by Abralo Engineer 2 and Growth')).toBeVisible();
  await expect(page.getByText('Granted', { exact: true })).toHaveCount(0);
  const ask = page.getByRole('switch', { name: 'Ask before another employee uses an account' });
  await expect(ask).not.toBeChecked();
  await shots('connections-page');
  // Adding a service is one field; an account that is already connected is recognised.
  await page.getByRole('button', { name: 'Add service', exact: true }).click();
  await page.getByLabel('Which service?').fill('Acme Mail');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.surface-add-note')).toContainText('already connected');
  await shots('connections-add');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  // Account actions live in the row menu, and Disconnect asks first.
  const row = services.locator('.connection-page-row').first();
  await row.getByLabel(/^Manage /).click();
  await row.getByRole('button', { name: 'Disconnect…', exact: true }).click();
  await expect(row.getByRole('alertdialog')).toContainText('Employees lose access');
  await shots('connections-disconnect');
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(row.getByRole('alertdialog')).toHaveCount(0);
  expect(store.all("SELECT * FROM connections WHERE state='ready'")).toHaveLength(2);
  expect(errors).toEqual([]);
  console.log(
    'Agent-driven connections: agent asks with a reason; one Sign in click via real callback; card settles; next employee shares automatically with a note; key-only service asks for a key with rejected-key recovery; no search on Connections page; desktop/mobile light/dark.',
  );
} catch (error) {
  failure = true;
  console.error('Connect-any UI failure:', errors, await page.locator('body').innerText());
  await page.screenshot({ path: 'evidence/connect-any-failure.png' });
  throw error;
} finally {
  await browser.close();
  await app.close();
  await oauth.close();
  await keyed.close();
  if (failure) process.exitCode = 1;
}
