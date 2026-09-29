import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid, now } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

delete process.env.WORKSPACE_MAINTENANCE_JOB;
const dir = mkdtempSync(join(tmpdir(), 'workspace-plan-history-'));
const old = new Store(dir);
const user = old.createOwner('Tester');
old.set('workspace.onboarded', true);
const agent = old.createEmployee(user.id, {
  name: 'Chief',
  harness: 'codex',
  model: '',
  cwd: '',
  role: '',
  instructions: '',
});
const message = old.addMessage(agent.dmId, agent.id, agent.name, 'agent', 'Launch approach');
const plan = {
  title: 'Launch approach',
  version: 2,
  state: 'review',
  revisions: [
    {
      title: 'Initial approach',
      body: 'Interview five prospective customers.',
      responsibilities: [],
    },
    {
      title: 'Revised approach',
      body: 'Interview five existing customers, then summarise what we learn.',
      responsibilities: [{ name: 'Chief', responsibility: 'Gather the findings.' }],
    },
  ],
};
old.run(
  'INSERT INTO plans VALUES(?,?,?,?,?,?)',
  uid(),
  message.id,
  agent.dmId,
  agent.id,
  JSON.stringify(plan),
  now(),
);
old.set('migration.plan-history', false);
old.close();
const store = new Store(dir);
const { app } = await createApp(store);
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/providers*', (route) => route.fulfill({ json: [] }));
mkdirSync('evidence', { recursive: true });
try {
  await page.goto(origin + '/#setup=' + store.bootstrapToken);
  await page.locator('.sidebar .employee-row').getByText('Chief', { exact: true }).click();
  const history = page.locator('.message').filter({ hasText: 'Archived plan · Version 2' });
  await expect(history).toContainText('Interview five existing customers');
  await expect(history).toContainText('Interview five prospective customers');
  await expect(page.getByRole('button', { name: /Read plan:|Plan first/i })).toHaveCount(0);
  for (const viewport of [
    { width: 1280, height: 640 },
    { width: 390, height: 640 },
  ]) {
    await page.setViewportSize(viewport);
    for (const theme of ['dark', 'light']) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      await expect(page.locator('.nav-row.selected').first()).toHaveCSS(
        'background-color',
        theme === 'dark' ? 'rgb(42, 48, 75)' : 'rgb(232, 236, 250)',
      );
      await history.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `evidence/plan-history-${viewport.width}-${theme}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
    }
  }
  // Existing history does not block typing or sending an ordinary request.
  const composer = page.locator('textarea').first();
  await composer.fill('Continue with the requested changes');
  await expect(composer).toHaveValue('Continue with the requested changes');
  expect(errors).toEqual([]);
  writeFileSync(
    'evidence/plan-history-ui.json',
    JSON.stringify(
      {
        status: 'passed',
        checks: [
          'legacy revisions readable as ordinary messages',
          'no plan controls',
          'laptop and mobile in both themes',
          'composer remains available',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await app.close();
}
