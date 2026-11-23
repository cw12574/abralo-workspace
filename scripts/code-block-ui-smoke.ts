import { chromium, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-code-block-')));
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
const longLine = 'x'.repeat(180);
store.addMessage(
  agent.dmId,
  agent.id,
  agent.name,
  'agent',
  `Example command:\n\n\`\`\`js\n  const value = "alpha";\nconsole.log(value);\n\`\`\`\n\n\`\`\`\n${longLine}\n\`\`\``,
);

const { app } = await createApp(store);
const address = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
const pageErrors: string[] = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const bootstrap = await page.request.post(address + '/api/bootstrap', {
  data: { token: store.bootstrapToken },
  headers: { 'x-workspace-request': '1' },
});
if (!bootstrap.ok()) throw new Error(await bootstrap.text());
await page.goto(address);
await page.getByRole('button', { name: 'Ada', exact: false }).first().click();
const message = page.locator('.message').filter({ hasText: 'Example command:' });
const blocks = message.locator('.code-block');
await expect(blocks).toHaveCount(2);
await expect(blocks.first().locator('.code-block-language')).toHaveText('js');
await expect(blocks.last().locator('.code-block-language')).toHaveText('Code');
const expected = '  const value = "alpha";\nconsole.log(value);\n';
if ((await blocks.first().locator('code').textContent()) !== expected)
  throw new Error('Rendered code changed its spaces or line breaks');

await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
const copy = blocks.first().getByRole('button', { name: 'Copy code' });
await copy.focus();
await copy.press('Enter');
await expect(blocks.first().getByRole('status')).toHaveText('Code copied to clipboard');
const clipboard = await page.evaluate(() => navigator.clipboard.readText());
if (clipboard.replace(/\r\n/g, '\n') !== expected)
  throw new Error(`Clipboard content differs from the code: ${JSON.stringify(clipboard)}`);

mkdirSync('evidence', { recursive: true });
await message.screenshot({ path: 'evidence/code-block-card-laptop.png' });
await page.getByRole('button', { name: 'Toggle theme' }).click();
await message.screenshot({ path: 'evidence/code-block-card-dark.png' });
await page.setViewportSize({ width: 390, height: 844 });
await message.screenshot({ path: 'evidence/code-block-card-mobile.png' });
const horizontal = await blocks.last().locator('pre').evaluate((element) => ({
  content: element.scrollWidth,
  viewport: element.clientWidth,
}));
if (horizontal.content <= horizontal.viewport)
  throw new Error('Long lines should scroll inside the code block');
if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
  throw new Error('Code block overflows the mobile page');
if (pageErrors.length) throw new Error(pageErrors.join('\n'));

console.log(JSON.stringify({ status: 'passed', checks: [
  'language and generic labels',
  'exact keyboard copy',
  'horizontal scrolling without page overflow',
  'laptop, dark, and mobile screenshots',
  'no page errors',
] }));
await browser.close();
await app.close();
