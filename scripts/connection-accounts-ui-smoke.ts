import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
import { startStandInMcp } from '../tests/helpers/stand-in-mcp.js';

// Several accounts on one service. An agent finds the connected account is the
// wrong one and asks for another: one card offers the existing account or a
// sign-in that asks which account. Signing in to the same account again is
// caught. Settings rename, change the default, reconnect and disconnect.
// A local stand-in OAuth service; Abralo's sign-in, callback and vault are real.
delete process.env.WORKSPACE_MAINTENANCE_JOB;
const service = await startStandInMcp('oauth', undefined, { identity: true });
const store = new Store(mkdtempSync(join(tmpdir(), 'abralo-accounts-ui-')));
const user = store.createOwner('Chris');
store.set('workspace.onboarded', true);
store.set('notifications.' + user.id, { enabled: false, sound: false, privatePreview: true });
const engineer = store.createEmployee(user.id, {
  name: 'Abralo Engineer 2',
  harness: 'claude',
  model: '',
  cwd: '',
  role: 'Product',
  instructions: '',
});
const { app, supervisor, broker } = await createApp(store, {
  staticRoot: resolve(process.env.CONNECTIONS_STATIC_ROOT || 'dist/web'),
});
supervisor.infos = async () => [];
broker.discovery = { allowLocal: true, registry: 'https://registry.invalid', timeoutMs: 1500 };
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const run = () => ({ id: uid(), user_id: user.id, employee_id: engineer.id, conversation_id: engineer.dmId, message_id: uid() });
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
      await page.screenshot({ path: `evidence/accounts-${name}-${viewport.width}-${theme}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}
async function signInWith(card: any, button: RegExp | string) {
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    card.getByRole('button', { name: button }).click(),
  ]);
  await popup.waitForEvent('close', { timeout: 10000 });
}
try {
  // 1. First account, as before: one Sign in click.
  service.signInAs('alice@example.com');
  await broker.requestAny(run(), service.url, 'read', 'check your email domain setup');
  await page.goto(origin + '/?conversation=' + engineer.dmId);
  const card = page.locator('.connection-row');
  await signInWith(card, 'Sign in to Acme Mail');
  await expect(card).toHaveCount(0);

  // 2. The agent finds the domain isn't in that account and asks for another.
  const asked: any = await broker.requestAny(run(), 'Acme Mail', 'read', 'check the abralo.com domain', {
    newAccount: true,
  });
  if (asked.status !== 'setup_required') throw new Error('Expected an account card: ' + JSON.stringify(asked));
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(
    'Abralo Engineer 2 needs a different Acme Mail account to check the abralo.com domain.',
  );
  await expect(card.getByRole('button', { name: 'Use Acme Mail (alice@example.com)' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Sign in to another Acme Mail account' })).toBeVisible();
  await expect(card).toContainText('will ask which account to use');
  await card.scrollIntoViewIfNeeded();
  await shots('choose-card');

  // 3. The provider signs the human straight back into the same account: caught, and explained.
  await signInWith(card, 'Sign in to another Acme Mail account');
  await expect(card).toContainText('That was your Acme Mail (alice@example.com) account, which is already connected.');
  expect(service.prompts.at(-1)).toBe('select_account');
  expect(broker.accounts(user.id, 'acme-mail')).toHaveLength(1);
  await card.scrollIntoViewIfNeeded();
  await shots('same-account');

  // 4. Trying again with the other account connects it, and the card settles.
  service.signInAs('bob@example.com');
  await signInWith(card, 'Sign in to another Acme Mail account');
  await expect(card).toHaveCount(0);
  await expect(page.getByText('Acme Mail (bob@example.com) connected.')).toBeVisible();
  const [alice, bob] = broker.accounts(user.id, 'acme-mail');

  // 5. Approvals say which account a change uses.
  broker.actions.request(run(), bob.id, 'send_email', { to: 'test@example.com' });
  await page.reload();
  await expect(page.locator('.connection-action')).toContainText('Account: Acme Mail (bob@example.com)');

  // 6. Settings: both accounts, default first; rename, make default, reconnect, disconnect.
  await page.getByRole('button', { name: 'Connections' }).click();
  const rows = page.locator(`[data-connection-id="${alice.id}"], [data-connection-id="${bob.id}"]`);
  await expect(rows).toHaveCount(2);
  const aliceRow = page.locator(`[data-connection-id="${alice.id}"]`);
  const bobRow = page.locator(`[data-connection-id="${bob.id}"]`);
  await expect(aliceRow).toContainText('Acme Mail (alice@example.com)');
  await expect(aliceRow).toContainText('Default');
  await expect(bobRow).toContainText('Acme Mail (bob@example.com)');
  await expect(bobRow).not.toContainText('Default');
  const choose = async (row: any, action: string) => {
    await row.locator('summary').click();
    await row.getByRole('button', { name: action }).click();
  };
  await choose(bobRow, 'Rename');
  await bobRow.getByLabel('Account name').fill('Abralo mail');
  await bobRow.scrollIntoViewIfNeeded();
  await shots('rename');
  await bobRow.getByRole('button', { name: 'Save name' }).click();
  await expect(bobRow).toContainText('Renamed to Abralo mail.');
  await expect(bobRow).toContainText('Abralo mail ·');
  await choose(bobRow, 'Make default');
  await expect(bobRow).toContainText('Agents now use Abralo mail');
  await expect(bobRow.locator('.surface-tag')).toHaveText('Default');
  await expect(aliceRow).not.toContainText('Default');
  expect(broker.defaultAccount(user.id, 'acme-mail').id).toBe(bob.id);
  expect(await broker.requestAny(run(), 'Acme Mail', 'read')).toMatchObject({ connectionId: bob.id });
  await bobRow.locator('summary').click();
  await signInWith(bobRow, 'Reconnect');
  await expect(bobRow).toContainText('Connected');
  expect(broker.status(bob.id, engineer.id, user.id).capabilities).toContain('read');
  await bobRow.scrollIntoViewIfNeeded();
  await shots('settings');
  await choose(aliceRow, 'Disconnect…');
  await aliceRow.getByRole('alertdialog').getByRole('button', { name: 'Disconnect' }).click();
  // The disconnected account moves out of Services; access is cancelled with the provider.
  await expect(aliceRow).toContainText('Disconnected');
  await expect(bobRow).toContainText('Connected');
  const alerts = await page.locator('[role="alert"], .error-banner').evaluateAll((els) => els.map((e) => e.outerHTML.slice(0, 300)));
  if (alerts.length) throw new Error('Unexpected alert: ' + alerts.join(' | '));
  await expect.poll(() => store.one('SELECT state FROM connections WHERE id=?', alice.id).state).toBe('disconnected');
  expect(service.revoked).toHaveLength(1);
  expect(errors).toEqual([]);
  console.log(
    'Several accounts: agent asks for another account; card offers the existing account or a sign-in with the account chooser; same-account sign-in caught with guidance; second account connects and names itself; approvals name the account; rename, default, reconnect (access kept) and disconnect with provider revocation; desktop/mobile light/dark.',
  );
} catch (error) {
  failure = true;
  console.error('Accounts UI failure:', errors, await page.locator('body').innerText());
  await page.screenshot({ path: 'evidence/accounts-failure.png' });
  throw error;
} finally {
  await browser.close();
  await app.close();
  await service.close();
  if (failure) process.exitCode = 1;
}
