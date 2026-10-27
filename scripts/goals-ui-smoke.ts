import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { Goals } from '../apps/service/src/goals.js';
import { Work } from '../apps/service/src/work.js';
import { createApp } from '../apps/service/src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'abralo-goals-ui-'));
const store = new Store(dir);
const owner = store.createOwner('Tester');
store.set('workspace.onboarded', true);
const employee = store.createEmployee(owner.id, {
  name: 'Chief of Staff',
  harness: 'codex',
  model: '',
  cwd: '',
  role: 'Assistant',
  instructions: '',
});
const growthAgent = store.createEmployee(owner.id, {
  name: 'Growth agent',
  harness: 'codex',
  model: '',
  cwd: '',
  role: 'Growth',
  instructions: '',
});
const goals = new Goals(store);
const goal = goals.create(owner.id, {
  conversationId: employee.dmId,
  title: 'Grow PollyTalks to $10K MRR',
  success: 'Monthly recurring revenue reaches $10K',
  nextStep: 'Measure current revenue and customer mix',
});
goals.addStep(goal.id, owner.id, {
  title: 'Establish the starting point',
  doneWhen: 'Revenue and customer count recorded',
});
const work = new Work(store);
const task = work.start(
  { id: uid(), user_id: owner.id, conversation_id: employee.dmId, message_id: uid() },
  {
    title: 'Measure the baseline',
    doneWhen: ['Revenue and paying customers recorded'],
    proofPlan: ['Check the revenue report'],
  },
);
work.change(task.id, owner.id, employee.dmId, {
  status: 'complete',
  checks: [{ label: 'Revenue report', result: 'passed' }],
  summary: 'Starting point recorded.',
});
const { app } = await createApp(store);
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.route('**/api/providers*', (route) => route.fulfill({ json: [] }));
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
mkdirSync('evidence', { recursive: true });
try {
  await page.goto(origin + '/#setup=' + store.bootstrapToken);
  await page.getByRole('button', { name: 'Chief of Staff', exact: true }).click();
  await expect(page.getByText('Measure the baseline')).toBeVisible();
  await expect(page.getByText('Starting point recorded.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open goals for this conversation' }),
  ).toBeVisible();
  await page.screenshot({ path: 'evidence/work-card-desktop-light.png' });
  await expect(page.getByRole('button', { name: 'Goals', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await expect(page.getByRole('heading', { name: goal.title })).toBeVisible();
  await expect(
    page.getByRole('article').getByText('Measure current revenue and customer mix'),
  ).toBeVisible();
  await page.screenshot({ path: 'evidence/goals-desktop-light.png' });
  await page.getByLabel('Lead agent').selectOption(growthAgent.id);
  await expect(page.getByRole('button', { name: 'Continue in Growth agent' })).toBeVisible();
  await page.screenshot({ path: 'evidence/goals-lead-desktop-light.png' });
  await page.getByRole('button', { name: 'Continue in Growth agent' }).click();
  await expect(
    page.getByRole('button', { name: 'Open goals for this conversation' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Goals', exact: true }).click();

  await page.getByRole('button', { name: 'New goal' }).click();
  await page.getByLabel('What do you want to achieve?').fill('Launch the next product');
  await page.getByLabel('How will you know it worked?').fill('First paying customer');
  await page.getByLabel('Who will keep this moving?').selectOption(growthAgent.id);
  await page.getByRole('button', { name: 'Save goal' }).click();
  await expect(page.getByRole('heading', { name: 'Launch the next product' })).toBeVisible();
  await expect(page.getByLabel('Lead agent')).toHaveValue(growthAgent.id);
  await page.getByLabel('Add an update').fill('Spoke with five potential buyers');
  await page.getByRole('button', { name: 'Save update' }).click();
  await expect(page.getByText('Spoke with five potential buyers')).toBeVisible();

  const goalPatch = `**/api/goals/${goals.list(owner.id).find((item) => item.title === 'Launch the next product')!.id}`;
  await page.route(goalPatch, (route) =>
    route.fulfill({ status: 409, json: { error: 'This goal changed. Refresh it and try again.' } }),
  );
  await page.getByLabel('Lead agent').selectOption(employee.id);
  await expect(page.getByText('This goal changed. Refresh it and try again.')).toBeVisible();
  await expect(page.getByLabel('Lead agent')).toHaveValue(growthAgent.id);
  await page.screenshot({ path: 'evidence/goals-error-desktop-light.png' });
  await page.unroute(goalPatch);
  await page.getByRole('button', { name: 'Dismiss error' }).click();

  await page.setViewportSize({ width: 390, height: 780 });
  await page.screenshot({ path: 'evidence/goals-mobile-light.png' });
  await page.setViewportSize({ width: 1280, height: 640 });

  await page.evaluate(() => localStorage.setItem('theme', 'dark'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'evidence/goals-desktop-dark.png' });

  await page.setViewportSize({ width: 390, height: 780 });
  await page.screenshot({ path: 'evidence/goals-mobile-dark.png' });
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  if (!fits) throw new Error('Goals layout overflows the mobile viewport.');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Goal creation, lead handoff, update, desktop themes, and mobile layout passed.');
} finally {
  await browser.close();
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
