import { chromium, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

// A settled action is a one-line receipt in the timeline; a pending one is a
// plainly worded card pinned above the composer.
const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-connection-action-')));
const owner = store.createOwner('Chris');
store.set('workspace.onboarded', true);
store.set('workspace.name', 'Studio');
const agent = store.createEmployee(owner.id, {
  name: 'Running Engineer', role: 'Engineering', harness: 'codex', model: '', cwd: '', instructions: '',
});
const connection = uid();
store.run('INSERT INTO connections VALUES(?,?,?,?,?,?)', connection, owner.id, 'railway', 'railway', 'ready', JSON.stringify({ tools: [] }));
store.addMessage(agent.dmId, owner.id, owner.name, 'human', 'Set up Railway for the app');
await new Promise((resolve) => setTimeout(resolve, 20));
const action = (tool: string, state: string) => {
  const at = new Date().toISOString();
  const id = uid();
  store.run(
    'INSERT INTO connection_actions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, owner.id, agent.id, agent.dmId, uid(), uid(), connection, uid(), tool,
    JSON.stringify({ name: 'running-app' }), state, null, at, at,
  );
  return id;
};
action('create-project', 'succeeded');
await new Promise((resolve) => setTimeout(resolve, 20));
store.addMessage(agent.dmId, agent.id, agent.name, 'agent', 'Project created. Next I will add the service.');
await new Promise((resolve) => setTimeout(resolve, 20));
action('create-service', 'awaiting_approval');
// Dismissed cards stay where they happened, even while awaiting approval, and fold
// into one quiet note instead of a row of repeated links at the bottom of the chat.
const dismissedIds = [action('create-worker', 'awaiting_approval'), action('create-cron', 'awaiting_approval')];
await new Promise((resolve) => setTimeout(resolve, 20));
store.addMessage(agent.dmId, agent.id, agent.name, 'agent', 'Later update after the dismissed cards.');

const { app, broker } = await createApp(store, { staticRoot: process.env.CONNECTIONS_STATIC_ROOT });
for (const id of dismissedIds) broker.actions.dismiss(id, owner.id, true);
const address = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const pageErrors: string[] = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const bootstrap = await page.request.post(address + '/api/bootstrap', {
  data: { token: store.bootstrapToken }, headers: { 'x-workspace-request': '1' },
});
if (!bootstrap.ok()) throw new Error(await bootstrap.text());
await page.goto(address);
await page.getByRole('button', { name: 'Running Engineer', exact: false }).first().click();
const receipt = page.locator('.connection-receipt');
await expect(receipt).toHaveCount(1);
await expect(receipt).toContainText('Create project');
await expect(receipt).toContainText('Done');
const card = page.locator('.connection-action');
await expect(card).toHaveCount(1);
await expect(card).toContainText('Create service');
await expect(card).toContainText('Needs your approval');
await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible();
await expect(page.getByText('create-project')).toHaveCount(0);
await expect(page.getByText('Action details')).toHaveCount(0);
const note = page.locator('.dismissed-action-note');
await expect(note).toHaveCount(1);
await expect(note).toHaveText('Show 2 dismissed Railway actions');
expect(await note.evaluate((el) => !!el.closest('.inline-actions'))).toBe(true);
await expect(page.getByText('Later update after the dismissed cards.')).toBeVisible();
await note.click();
await expect(card).toHaveCount(3);
await expect(page.locator('.inline-actions .connection-action')).toHaveCount(2);
await page.getByRole('button', { name: 'Hide 2 dismissed Railway actions' }).click();
await expect(card).toHaveCount(1);
mkdirSync('evidence', { recursive: true });
await page.screenshot({ path: 'evidence/connection-action-light.png' });
await page.getByRole('button', { name: 'Toggle theme' }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: 'evidence/connection-action-dark.png' });
if (pageErrors.length) throw new Error(pageErrors.join('\n'));
console.log(JSON.stringify({ status: 'passed' }));
await browser.close();
await app.close();
