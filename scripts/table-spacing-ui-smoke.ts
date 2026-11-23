import { chromium, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

// Tables in replies need clear space above and below, like any other block.
const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-table-')));
const owner = store.createOwner('Chris');
store.set('workspace.onboarded', true);
store.set('workspace.name', 'Studio');
const agent = store.createEmployee(owner.id, { name: 'Ada', role: 'Engineering', harness: 'codex', model: '', cwd: '', instructions: '' });
store.addMessage(agent.dmId, agent.id, agent.name, 'agent',
  'Predicted race times from your recent runs:\n\n| Race | Time |\n|---|---|\n| 10K | 34:58 |\n| Half marathon | 1:16:40 |\n| Marathon | 2:40:18 |\n\nAll unit and browser checks pass. Shall I deploy it?');
const { app } = await createApp(store);
const address = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const bootstrap = await page.request.post(address + '/api/bootstrap', { data: { token: store.bootstrapToken }, headers: { 'x-workspace-request': '1' } });
if (!bootstrap.ok()) throw new Error(await bootstrap.text());
await page.goto(address);
await page.getByRole('button', { name: 'Ada', exact: false }).first().click();
const message = page.locator('.message').filter({ hasText: 'Shall I deploy it?' });
const gaps = await message.locator('.prose table').evaluate((table) => {
  const box = table.getBoundingClientRect();
  return {
    above: box.top - table.previousElementSibling!.getBoundingClientRect().bottom,
    below: table.nextElementSibling!.getBoundingClientRect().top - box.bottom,
  };
});
if (gaps.above < 14 || gaps.below < 18) throw new Error('Table spacing too tight: ' + JSON.stringify(gaps));
mkdirSync('evidence', { recursive: true });
await page.getByRole('button', { name: 'Toggle theme' }).click();
await page.waitForTimeout(600);
await message.screenshot({ path: 'evidence/table-spacing-dark.png' });
console.log(JSON.stringify({ status: 'passed', gaps }));
await browser.close();
await app.close();
