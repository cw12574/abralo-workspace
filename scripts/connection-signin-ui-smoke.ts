import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store, hash, uid } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

// One click from "Connect" to connected. The provider is a local stand-in; the
// Abralo callback page, its self-closing script, and live card updates are real.
delete process.env.WORKSPACE_MAINTENANCE_JOB;
const store = new Store(mkdtempSync(join(tmpdir(), 'abralo-signin-ui-')));
const user = store.createOwner('Morgan');
const employee = store.createEmployee(user.id, {
  name: 'Abralo Engineer',
  harness: 'codex',
  model: '',
  cwd: '',
  role: 'Builds your product',
  instructions: '',
});
store.set('workspace.onboarded', true);
const { app, supervisor, broker } = await createApp(store, {
  staticRoot: resolve(process.env.CONNECTIONS_STATIC_ROOT || 'dist/web'),
});
supervisor.infos = async () => [];
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const provider = 'https://provider.example';
const request = () => {
  // Start each scenario from a fresh, unconnected account.
  store.run('DELETE FROM grants');
  store.run("DELETE FROM connections WHERE state IN ('ready','failed')");
  const run = {
    id: uid(),
    employee_id: employee.id,
    user_id: user.id,
    conversation_id: employee.dmId,
    message_id: uid(),
  };
  broker.request(run, 'railway', 'read');
  return store.one(
    "SELECT id FROM connections WHERE state='awaiting_authorization' ORDER BY rowid DESC LIMIT 1",
  ).id as string;
};
// Prepare a real sign-in attempt, as the OAuth client would, but against the stand-in provider.
(broker as any).ensure = async (id: string) => {
  const vault = await broker.storage();
  const state = 'state-' + id;
  vault.set(id, {
    ...(vault.get(id) || {}),
    attempt: { stateHash: hash(state), expires: Date.now() + 600000 },
  });
  return {
    url: `${provider}/authorize?state=${state}&redirect=${encodeURIComponent(`${origin}/oauth/callback/${id}`)}`,
    message: 'Sign in with the provider and choose the account and access you want to grant.',
  };
};
(broker as any).connect = async (id: string, ownerId: string) => {
  store.run("UPDATE connections SET state='ready' WHERE id=?", id);
  const data = JSON.parse(store.one('SELECT data FROM connections WHERE id=?', id).data);
  store.emit('connection.ready', data.conversationId, { id }, ownerId);
};
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 640 } });
await context.addCookies([{ name: 'workspace', value: store.newSession(user.id), url: origin }]);
// The stand-in provider: the human picks the account and either allows or cancels.
await context.route(`${provider}/**`, (route) => {
  const url = new URL(route.request().url());
  const back = url.searchParams.get('redirect')!;
  const state = url.searchParams.get('state')!;
  return route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><title>Provider</title><h1>Allow Abralo?</h1>
      <a id="allow" href="${back}?state=${state}&code=fixture">Allow</a>
      <a id="cancel" href="${back}?state=${state}&error=access_denied">Cancel</a>`,
  });
});
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
mkdirSync('evidence', { recursive: true });
let failure = false;
try {
  // 1. Success: one click opens the provider; allowing it settles everything on its own.
  request();
  await page.goto(origin + '/?conversation=' + employee.dmId);
  const card = page.locator('.connection-row');
  await expect(card).toHaveCount(1);
  await page.screenshot({ path: 'evidence/connection-signin-initial-1280-light.png' });
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    card.getByRole('button', { name: /^Sign in to/ }).click(),
  ]);
  await popup.waitForURL(`${provider}/**`);
  await expect(card).toContainText('Finish signing in to Railway in the window that opened.');
  await expect(card.getByRole('link', { name: /sign-in/i })).toHaveCount(0);
  await expect(card.getByRole('button', { name: /Check/ })).toHaveCount(0);
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await page.screenshot({ path: 'evidence/connection-signin-waiting-1280-light.png' });
  await popup.locator('#allow').click();
  await popup.waitForEvent('close', { timeout: 5000 }); // The callback page closes itself.
  await expect(card).toHaveCount(0); // Connected: the request card settles without a click.

  // 2. Cancelled at the provider: the window closes and the card says so, ready to retry.
  request();
  await expect(card).toHaveCount(1);
  const [cancelled] = await Promise.all([
    context.waitForEvent('page'),
    card.getByRole('button', { name: /^Sign in to/ }).click(),
  ]);
  await cancelled.waitForURL(`${provider}/**`);
  await cancelled.locator('#cancel').click();
  await cancelled.waitForEvent('close', { timeout: 5000 });
  await expect(card).toContainText('Sign-in to Railway was cancelled. Connect again when you’re ready.');
  await expect(card.getByRole('button', { name: /^Sign in to/ })).toBeVisible();
  await page.screenshot({ path: 'evidence/connection-signin-cancelled-1280-light.png' });

  // 3. Closed without finishing: one clear retry.
  request();
  await expect(card).toHaveCount(1);
  const [abandoned] = await Promise.all([
    context.waitForEvent('page'),
    card.getByRole('button', { name: /^Sign in to/ }).click(),
  ]);
  await abandoned.waitForURL(`${provider}/**`);
  await abandoned.close();
  await expect(card).toContainText('The sign-in window closed before Railway was connected.', {
    timeout: 6000,
  });
  await expect(card.getByRole('button', { name: /^Try again/ })).toBeVisible();

  // 4. Popup blocked: exactly one link, which opens the provider directly.
  await page.evaluate(() => {
    window.open = () => null;
  });
  await card.getByRole('button', { name: /^Try again/ }).click();
  const link = card.getByRole('link', { name: 'Sign in to Railway' });
  await expect(link).toBeVisible();
  await expect(card.getByRole('button', { name: /^Sign in to|^Try again|Check/ })).toHaveCount(0);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    for (const viewport of [
      { width: 1280, height: 640 },
      { width: 390, height: 780 },
    ]) {
      await page.setViewportSize(viewport);
      await card.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `evidence/connection-signin-blocked-${viewport.width}-${theme}.png`,
      });
    }
  }
  const [direct] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await direct.waitForURL(`${provider}/**`);
  await direct.locator('#allow').click();
  await expect(card).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    'Connection sign-in: one click opens provider with no opener; success and cancel windows close themselves and the card settles live; closed window offers Try again; blocked popup shows one direct link; desktop/mobile light/dark.',
  );
} catch (error) {
  failure = true;
  console.error('Connection sign-in UI failure:', errors, await page.locator('body').innerText());
  await page.screenshot({ path: 'evidence/connection-signin-failure.png' });
  throw error;
} finally {
  await browser.close();
  await app.close();
  if (failure) process.exitCode = 1;
}
