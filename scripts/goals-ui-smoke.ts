import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { Goals } from '../apps/service/src/goals.js';
import { Work } from '../apps/service/src/work.js';
import { createApp } from '../apps/service/src/app.js';

process.env.WORKSPACE_HOST = '0.0.0.0';
delete process.env.WORKSPACE_MAINTENANCE_JOB;
const dir = mkdtempSync(join(tmpdir(), 'abralo-goals-ui-'));
const store = new Store(dir);
const owner = store.createOwner('Tester');
store.set('workspace.onboarded', true);
store.set('notifications.' + owner.id, { enabled: false, sound: false, privatePreview: true });
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
const request = store.addMessage(
  employee.dmId,
  owner.id,
  'Tester',
  'human',
  'Measure our baseline',
);
const task = work.start(
  { id: uid(), user_id: owner.id, conversation_id: employee.dmId, message_id: request.id },
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
const { app, supervisor } = await createApp(store);
supervisor.adapters.codex = {
  info: async () => ({
    harness: 'codex',
    installed: true,
    authenticated: true,
    version: 'test',
    detail: '',
  }),
  run: async (input) => {
    const run = store.one('SELECT * FROM runs WHERE id=?', input.id);
    const cycle = store.one('SELECT * FROM goal_cycles WHERE message_id=?', run.message_id);
    const review = supervisor.goals!.review.forMessage(run.message_id);
    if (review)
      supervisor.goals!.review.report(run, {
        verdict: 'passed',
        summary: 'Fixture outcome independently checked',
        checks: review.criteria.map((criterion: any) => ({
          criterion: criterion.id,
          passed: true,
          evidence: 'Fixture deliverable inspected',
        })),
      });
    else
      supervisor.goals!.checkpoint(cycle.goal_id, run, {
        outcome: 'needs_input',
        summary: 'Two possible audiences identified',
        evidence: 'Five interview summaries reviewed',
        question: 'Should we prioritise small teams or individual buyers?',
      });
    input.emit({ type: 'complete', data: { cancelled: false } });
  },
  dispose: async () => {},
};
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
  const anchoredCard = page.locator(`[data-message-id="${request.id}"] .work-card`);
  await expect(anchoredCard).toContainText('Measure the baseline');
  await expect(page.locator('.conversation-actions .work-card')).toHaveCount(0);
  const later = store.addMessage(
    employee.dmId,
    owner.id,
    'Tester',
    'human',
    'A later conversation message',
  );
  await expect(page.getByText(later.text, { exact: true })).toBeVisible();
  work.change(task.id, owner.id, employee.dmId, { summary: 'Baseline verified again.' });
  await expect(anchoredCard).toContainText('Baseline verified again.');
  await page.reload();
  await expect(anchoredCard).toContainText('Baseline verified again.');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const viewport of [
      { width: 1280, height: 640 },
      { width: 390, height: 780 },
    ]) {
      await page.setViewportSize(viewport);
      await anchoredCard.scrollIntoViewIfNeeded();
      await expect(anchoredCard).toBeVisible();
      const cardBox = await anchoredCard.boundingBox();
      const laterBox = await page.locator(`[data-message-id="${later.id}"]`).boundingBox();
      expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(laterBox!.y);
      await expect(page.locator('.work-card')).toHaveCount(1);
      await page.screenshot({ path: `evidence/goal-chat-${viewport.width}-${theme}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });

  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Other open goals' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Goals that need you' })).toHaveCount(0);
  const firstRow = page.locator('.goal-card').filter({ hasText: goal.title });
  await expect(firstRow.locator('.goal-state')).toHaveText('Saved');
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  // The lead is a portrait and name that opens the conversation; there is no Lead column.
  await expect(firstRow.locator('.goal-lead svg')).toHaveCount(1);
  await expect(firstRow.getByText('Lead', { exact: true })).toHaveCount(0);
  await expect(firstRow.getByRole('img', { name: '0 of 1 steps done' })).toBeVisible();
  await firstRow.locator('.goal-evidence > summary').click();
  await expect(firstRow.getByText(goal.success, { exact: true })).toBeVisible();
  const step = goals.get(goal.id, owner.id).steps[0];
  goals.changeStep(goal.id, step.id, owner.id, { status: 'done', evidence: 'Report checked' });
  await expect(firstRow.getByText('Step checked: Report checked')).toBeVisible();
  await expect(firstRow.getByRole('img', { name: '1 of 1 steps done' })).toBeVisible();
  await page.getByRole('button', { name: 'Talk to Chief of Staff', exact: true }).click();
  await expect(page.locator('.conversation-goals')).toHaveCount(0);
  goals.runner.start(goal.id);
  goals.runner.setState(
    goal.id,
    'needs_input',
    'An audience decision is needed.',
    null,
    'Which audience should we prioritise?',
  );
  await expect(page.locator('.conversation-goals')).toContainText(
    'Which audience should we prioritise?',
  );
  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  // What needs you comes first, with the question as the card and one field to answer it.
  const needsList = page.getByRole('list', { name: 'Goals that need you' });
  await expect(needsList.locator('.goal-card')).toHaveCount(1);
  await expect(page.locator('#goals-needs-you')).toHaveText('Needs you 1');
  await expect(firstRow.locator('.goal-state')).toHaveCount(0);
  await expect(firstRow.locator('.goal-question')).toHaveText(
    'Which audience should we prioritise?',
  );
  await expect(firstRow.locator('.goal-progress-copy')).toHaveCount(0);
  for (const theme of ['light', 'dark'])
    for (const viewport of [
      { width: 1280, height: 640 },
      { width: 390, height: 780 },
    ]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.setViewportSize(viewport);
      await page.screenshot({ path: `evidence/goals-needs-you-${viewport.width}-${theme}.png` });
    }
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  const answer = firstRow.getByRole('textbox', { name: `Answer for ${goal.title}` });
  await answer.fill('Small teams first');
  await answer.press('Enter');
  await expect(
    firstRow.getByText('Which audience should we prioritise?', { exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      store
        .all('SELECT text FROM messages WHERE conversation_id=?', employee.dmId)
        .some((m: any) => String(m.text).includes('Small teams first')),
    )
    .toBe(true);
  // Long progress reads as one line until expanded, and a goal deletes in two clicks.
  const long = goals.create(owner.id, {
    title: 'Expand into schools',
    leadAgentId: growthAgent.id,
    nextStep:
      'Interview ten heads of languages about how they plan speaking practice, compare their answers with the current onboarding flow, and draft a pilot offer with pricing, timelines and the evidence we would need to show results within one term.',
  });
  // Saved (not started) so the fixture provider cannot replace the long next step;
  // stopping live work on delete is covered by tests/goals.test.ts.
  const longRow = page.locator('.goal-card').filter({ hasText: 'Expand into schools' });
  const copy = longRow.locator('.goal-progress-copy');
  await expect(copy).toBeVisible();
  await expect(longRow.getByRole('img')).toHaveCount(0);
  const lineHeight = await copy.evaluate((element) =>
    parseFloat(getComputedStyle(element).lineHeight),
  );
  expect((await copy.boundingBox())!.height).toBeLessThanOrEqual(lineHeight + 1);
  await longRow.getByRole('button', { name: 'Show more', exact: true }).click();
  expect((await copy.boundingBox())!.height).toBeGreaterThan(lineHeight * 1.5);
  await page.screenshot({ path: 'evidence/goals-expanded-1280-light.png' });
  await longRow.getByRole('button', { name: 'Show less', exact: true }).click();
  expect((await copy.boundingBox())!.height).toBeLessThanOrEqual(lineHeight + 1);
  await longRow.getByRole('button', { name: 'Delete Expand into schools', exact: true }).click();
  await expect(longRow.getByRole('alertdialog')).toContainText('Delete this goal?');
  await page.screenshot({ path: 'evidence/goals-delete-confirm-1280-light.png' });
  await longRow.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(longRow.getByRole('alertdialog')).toHaveCount(0);
  await longRow.getByRole('button', { name: 'Delete Expand into schools', exact: true }).click();
  await longRow.getByRole('button', { name: 'Delete goal', exact: true }).click();
  await expect(longRow).toHaveCount(0);
  expect(goals.list(owner.id).some((item) => item.id === long.id)).toBe(false);
  // Creating a goal is one field; the lead choice stays optional.
  await page.getByRole('button', { name: 'New goal', exact: true }).click();
  await expect(page.locator('.goal-create input')).toHaveCount(1);
  await expect(page.locator('.goal-create select')).toHaveCount(0);
  await page.getByLabel('What do you want to achieve?').fill('Launch the next product');
  await page.getByLabel('What do you want to achieve?').press('Enter');
  await expect(
    page.getByRole('button', { name: 'Launch the next product', exact: true }),
  ).toBeVisible();
  const created = goals.list(owner.id).find((item) => item.title === 'Launch the next product')!;
  expect(created.leadAgentId).toBe(growthAgent.id);
  await page.getByLabel('Manage Launch the next product').click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(
    page.locator('.goal-card').filter({ hasText: 'Launch the next product' }).locator('.goal-state'),
  ).toHaveText('Paused');
  await page.getByRole('button', { name: 'Check completion', exact: true }).click();
  const completedSection = page.locator('.completed-goals');
  await expect(completedSection.locator(':scope > summary')).toHaveText('Completed 1');
  await expect(completedSection).not.toHaveAttribute('open');
  await completedSection.locator(':scope > summary').click();
  const done = completedSection.locator('.goal-card').filter({ hasText: 'Launch the next product' });
  await expect(done).toBeVisible();
  await done.locator('.goal-evidence > summary').click();
  await expect(done.getByText('Independently checked', { exact: true })).toBeVisible();
  await expect(done.getByText('Fixture deliverable inspected')).toBeVisible();
  const firstSection = page.locator('.goal-section').first();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const viewport of [
      { width: 1280, height: 640 },
      { width: 390, height: 780 },
    ]) {
      await page.setViewportSize(viewport);
      await page.locator('.goals-view').evaluate((element) => {
        element.scrollTop = 0;
      });
      const openBox = await firstSection.boundingBox(),
        completedBox = await completedSection.boundingBox();
      expect(completedBox!.y - (openBox!.y + openBox!.height)).toBeGreaterThanOrEqual(24);
      await page.screenshot({
        path: 'evidence/projects-list-' + viewport.width + '-' + theme + '.png',
      });
      await page.getByRole('button', { name: 'New goal', exact: true }).click();
      const create = page.getByRole('button', { name: 'Create goal', exact: true });
      await expect(create).toBeInViewport();
      await page.getByLabel('What do you want to achieve?').fill('Improve activation');
      await page.getByRole('button', { name: 'Choose yourself', exact: false }).click();
      await expect(page.locator('.goal-create select')).toHaveCount(1);
      await page.screenshot({
        path: 'evidence/projects-create-populated-' + viewport.width + '-' + theme + '.png',
      });
      await page.route('**/api/goals', async (route) => {
        if (route.request().method() === 'POST')
          await route.fulfill({
            status: 409,
            json: { error: 'That employee already leads another goal.' },
          });
        else await route.continue();
      });
      await create.click();
      await expect(page.getByRole('alert')).toContainText('already leads another goal');
      await expect(create).toBeInViewport();
      await page.screenshot({
        path: 'evidence/projects-create-error-' + viewport.width + '-' + theme + '.png',
      });
      await page.unroute('**/api/goals');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    'Shared goal status, saved banners hidden, criteria visible, collapsed completion and responsive forms passed.',
  );
} finally {
  await browser.close();
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
