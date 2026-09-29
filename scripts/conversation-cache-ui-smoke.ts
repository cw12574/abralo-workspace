import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-cache-')));
const owner = store.createOwner('Tester');
store.set('workspace.onboarded', true);
const agents = ['Atlas', 'Birch', 'Empty'].map((name) =>
  store.createEmployee(owner.id, {
    name,
    harness: 'codex',
    model: '',
    cwd: '',
    role: 'Fixture',
    instructions: '',
  }),
);
for (const agent of agents.slice(0, 2))
  for (let i = 0; i < 95; i++)
    store.addMessage(
      agent.dmId,
      owner.id,
      owner.name,
      'human',
      `${agent.name} message ${i}. ${'A useful piece of conversation to return to. '.repeat(4)}`,
    );
const streaming = store.addMessage(
  agents[0].dmId,
  agents[0].id,
  'Atlas',
  'agent',
  'Latest Atlas response',
);
const root = store.addMessage(agents[1].dmId, owner.id, owner.name, 'human', 'A thread to revisit');
const activityRun = 'cache-large-run';
store.run('UPDATE messages SET run_id=? WHERE id=?', activityRun, streaming.id);
store.run(
  'INSERT INTO runs(id,conversation_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
  activityRun,
  agents[0].dmId,
  owner.id,
  agents[0].id,
  streaming.id,
  streaming.id,
  'completed',
  streaming.createdAt,
  streaming.createdAt,
  'cache-fixture',
);
for (const activity of [
  {
    id: 'oversized-step',
    type: 'tool',
    title: 'Large tool result',
    detail: 'x'.repeat(10 * 1024 * 1024),
  },
  {
    id: 'inspect-step',
    type: 'diff',
    title: 'Inspect changes',
    detail: '+Compact conversation summaries\n-Load all tool output',
  },
])
  store.run(
    'INSERT INTO activities VALUES(?,?,?)',
    activity.id,
    activityRun,
    JSON.stringify({
      ...activity,
      time: streaming.createdAt,
      updatedAt: streaming.createdAt,
      state: 'complete',
    }),
  );
const reply = store.addMessage(
  agents[1].dmId,
  owner.id,
  owner.name,
  'human',
  'A cached thread reply',
  root.id,
);
const { app, supervisor } = await createApp(store);
supervisor.dispatch = async () => {};
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/providers*', (route) => route.fulfill({ json: [] }));
const report: any = { checks: [] };
const choose = (name: string) =>
  page
    .locator('.sidebar')
    .getByRole('button', { name, exact: true })
    .click({ position: { x: 15, y: 15 } });
const scroll = page.locator('.chat > .message-scroll').first();
const composer = page.getByRole('textbox', { name: 'Message', exact: true }).first();
let releaseHistory = () => {};
try {
  await page.goto(origin + '/#setup=' + store.bootstrapToken);
  await choose('Atlas');
  await expect(page.getByText('Latest Atlas response', { exact: true })).toBeVisible();
  const compactHistory = await page.request.get(
    `${origin}/api/conversations/${agents[0].dmId}/messages?agentView=1&activity=summary`,
  );
  expect((await compactHistory.body()).length).toBeLessThan(100000);
  let detailRequests = 0;
  let failDetail = true;
  await page.route('**/api/messages/*/activities/inspect-step', async (route) => {
    detailRequests++;
    if (failDetail)
      await route.fulfill({ status: 503, json: { error: 'Step temporarily unavailable' } });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Show 2 activity steps' }).click();
  expect(detailRequests).toBe(0);
  await page.locator('.tool-detail summary').filter({ hasText: 'Inspect changes' }).click();
  await expect(page.getByRole('button', { name: 'Retry step details' })).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await page.screenshot({ path: `evidence/conversation-detail-error-${theme}.png` });
  }
  failDetail = false;
  await page.getByRole('button', { name: 'Retry step details' }).click();
  await expect(page.locator('.tool-detail pre')).toContainText('+Compact conversation summaries');
  expect(detailRequests).toBe(2);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await page.screenshot({ path: `evidence/conversation-detail-${theme}.png` });
  }
  await page.setViewportSize({ width: 390, height: 740 });
  await page.locator('.tool-detail pre').scrollIntoViewIfNeeded();
  await expect(page.locator('.tool-detail pre')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: 'evidence/conversation-detail-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.getByRole('button', { name: 'Hide 2 activity steps' }).click();
  report.checks.push(
    '20 MiB of tool output stays out of history; details load only on opening and recover after failure',
  );
  await composer.fill('Keep my Atlas draft');
  await choose('Birch');
  await expect(page.getByText('A thread to revisit', { exact: true })).toBeVisible();
  await choose('Empty');
  await expect(page.locator('.history-load-state')).toHaveCount(0);
  await expect(composer).toBeVisible();
  await choose('Atlas');
  await expect(composer).toHaveValue('Keep my Atlas draft');
  await expect(page.getByText('Latest Atlas response', { exact: true })).toBeVisible();
  report.checks.push(
    'recent conversations and empty view revisit without restoring state; draft survives navigation',
  );

  // Read older content, then switch with all history responses held indefinitely.
  await scroll.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 }));
    element.scrollTop = 1200;
    element.dispatchEvent(new Event('scroll'));
  });
  // Virtual rows finish measuring after the jump; capture the actual reading
  // anchor rather than asserting an estimated absolute offset.
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeLessThan(2000);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const reading = await scroll.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const anchor = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(
      (node) => node.getBoundingClientRect().bottom > top,
    )!;
    return { id: anchor.dataset.messageId!, offset: anchor.getBoundingClientRect().top - top };
  });
  await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toBeInViewport();
  await page.evaluate(
    ({ conversationId, id }) =>
      window.dispatchEvent(
        new CustomEvent('workspace-event', {
          detail: {
            conversationId,
            type: 'message.updated',
            payload: { id, text: 'Latest Atlas response\n\n' + 'Streaming text. '.repeat(100) },
          },
        }),
      ),
    { conversationId: agents[0].dmId, id: streaming.id },
  );
  const anchor = page.locator(`[data-message-id="${reading.id}"]`);
  await expect
    .poll(() =>
      anchor.evaluate(
        (element) =>
          element.getBoundingClientRect().top -
          element.closest('.message-scroll')!.getBoundingClientRect().top,
      ),
    )
    .toBeCloseTo(reading.offset, 0);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await page.screenshot({ path: `evidence/conversation-scroll-reading-${theme}.png` });
  }
  report.checks.push(
    'streaming while reading history preserves the anchor and offers Jump to latest',
  );
  await choose('Birch');
  const gate = new Promise<void>((resolve) => (releaseHistory = resolve));
  let held = 0;
  await page.route('**/api/conversations/*/messages?*', async (route) => {
    const response = await route.fetch();
    held++;
    await gate;
    await route.fulfill({ response });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('workspace-reconnected')));
  const timing = await page.evaluate(async () => {
    const button = document.querySelector<HTMLButtonElement>(
      '.agent-nav-item > button[aria-label="Atlas"]',
    )!;
    const start = performance.now();
    button.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return {
      elapsed: performance.now() - start,
      rendered: document.querySelectorAll('[data-message-id]').length,
      restoring: document.body.innerText.includes('Restoring your conversation'),
    };
  });
  expect(timing.rendered).toBeGreaterThan(0);
  expect(timing.restoring).toBe(false);
  await expect
    .poll(() =>
      scroll.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
    )
    .toBeLessThanOrEqual(2);
  await expect(composer).toHaveValue('Keep my Atlas draft');
  report.cachedSwitch = timing;
  report.checks.push(
    'cached text opens at the bottom before blocked refresh resolves; draft restored',
  );
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await expect(page.locator('.sidebar .nav-row.selected')).toHaveCSS(
      'background-color',
      theme === 'dark' ? 'rgb(42, 48, 75)' : 'rgb(232, 236, 250)',
    );
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.mouse.move(700, 80);
    await page.screenshot({ path: `evidence/conversation-cache-${theme}.png` });
  }
  await choose('Birch');
  await page.evaluate(
    ({ conversationId, id }) =>
      window.dispatchEvent(
        new CustomEvent('workspace-event', {
          detail: {
            conversationId,
            type: 'message.updated',
            createdAt: '2026-09-28T16:00:00Z',
            payload: { id, text: 'Updated while Atlas was inactive' },
          },
        }),
      ),
    { conversationId: agents[0].dmId, id: streaming.id },
  );
  await choose('Atlas');
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByText('Updated while Atlas was inactive', { exact: true })).toBeVisible();
  releaseHistory();
  await page.unroute('**/api/conversations/*/messages?*');
  await expect(page.getByText('Updated while Atlas was inactive', { exact: true })).toBeVisible();
  report.checks.push('inactive text updates survive navigation and an older in-flight response');

  await page.getByRole('button', { name: 'Earlier messages', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Back to latest', exact: true })).toBeVisible();
  await choose('Birch');
  await choose('Atlas');
  await expect(page.getByRole('button', { name: 'Back to latest', exact: true })).toHaveCount(0);
  await expect(page.locator('.history-load-state')).toHaveCount(0);
  await expect(
    page.getByText('Updated while Atlas was inactive', { exact: true }),
  ).toBeInViewport();
  await choose('Birch');
  await page
    .locator('.message')
    .filter({ hasText: 'A thread to revisit' })
    .getByRole('button', { name: 'Reply in thread' })
    .click();
  await expect(
    page.locator('.thread').getByText('A cached thread reply', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close thread' }).click();
  await page
    .locator('.message')
    .filter({ hasText: 'A thread to revisit' })
    .getByRole('button', { name: 'Reply in thread' })
    .click();
  await expect(
    page.locator('.thread').getByText('A cached thread reply', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.thread .history-load-state')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close thread' }).click();
  report.checks.push('returning from an older page opens latest; cached thread remains distinct');

  await choose('Atlas');
  await page.getByRole('button', { name: 'Search workspace', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Search messages and decisions' })
    .fill('Atlas message 20.');
  await page.locator('.search-result').filter({ hasText: 'Atlas message 20.' }).click();
  await expect(page.locator('.message-highlight')).toContainText('Atlas message 20.');
  await expect(page.locator('.message-highlight')).toBeInViewport();
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Back to latest', exact: true })).toHaveCount(0);
  await expect
    .poll(() =>
      scroll.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
    )
    .toBeLessThanOrEqual(2);
  await scroll.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 }));
    element.scrollTop = 1200;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible();
  await choose('Atlas');
  await expect
    .poll(() =>
      scroll.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
    )
    .toBeLessThanOrEqual(2);
  report.checks.push(
    'search opens its specific message; Jump to latest and clicking the active conversation return to bottom',
  );

  await page.getByRole('button', { name: 'Search workspace', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Search messages and decisions' })
    .fill('A cached thread reply');
  await page.locator('.search-result').filter({ hasText: 'A cached thread reply' }).click();
  await expect(page.locator('.thread .message-highlight')).toContainText('A cached thread reply');
  await expect(page.locator('.thread .message-highlight')).toBeInViewport();
  await page.getByRole('button', { name: 'Close thread' }).click();
  report.checks.push('thread search opens the matching reply in its thread');

  await choose('Atlas');
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((resolve) => (releaseSend = resolve));
  await page.route('**/api/conversations/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await sendGate;
    await route.continue();
  });
  await composer.fill('Send survives navigation');
  await composer.press('Enter');
  await expect(page.getByText('Sending…', { exact: true })).toBeVisible();
  await choose('Birch');
  await choose('Atlas');
  await expect(page.getByText('Send survives navigation', { exact: true })).toBeVisible();
  await expect(page.getByText('Sending…', { exact: true })).toBeVisible();
  releaseSend();
  await expect(page.getByText('Sending…', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Send survives navigation', { exact: true })).toHaveCount(1);
  report.checks.push('pending send survives leaving and returning without duplication');

  await page.route('**/api/conversations/*/messages?*', (route) =>
    route.fulfill({ status: 503, json: { error: 'Offline test' } }),
  );
  // The send may still have a successful refresh in flight. Trigger the failure
  // after it settles instead of assuming that reconnect starts another request.
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('workspace-reconnected')));
    return page.getByRole('button', { name: 'History didn’t refresh · Retry' }).count();
  }).toBe(1);
  await expect(page.getByText('Send survives navigation', { exact: true })).toBeVisible();
  await page.unroute('**/api/conversations/*/messages?*');
  await page.getByRole('button', { name: 'History didn’t refresh · Retry' }).click();
  await expect(page.getByRole('button', { name: 'History didn’t refresh · Retry' })).toHaveCount(0);
  report.checks.push('background failure retains visible messages and retry recovers');
  await scroll.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 }));
    element.scrollTop = 1200;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const beforeArrival = await scroll.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const anchor = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(
      (node) => node.getBoundingClientRect().bottom > top,
    )!;
    return { id: anchor.dataset.messageId!, offset: anchor.getBoundingClientRect().top - top };
  });
  const arrived = store.addMessage(
    agents[0].dmId,
    agents[0].id,
    'Atlas',
    'agent',
    'New arrival while reading history',
  );
  const refreshed = page.waitForResponse(
    (response) =>
      response.url().includes(`/conversations/${agents[0].dmId}/messages?`) &&
      response.status() === 200,
  );
  await page.evaluate(
    (message) =>
      window.dispatchEvent(
        new CustomEvent('workspace-event', {
          detail: {
            conversationId: message.conversationId,
            type: 'message.created',
            payload: message,
          },
        }),
      ),
    arrived,
  );
  await refreshed;
  await expect
    .poll(() =>
      page
        .locator(`[data-message-id="${beforeArrival.id}"]`)
        .evaluate(
          (element) =>
            element.getBoundingClientRect().top -
            element.closest('.message-scroll')!.getBoundingClientRect().top,
        ),
    )
    .toBeCloseTo(beforeArrival.offset, 0);
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await expect(
    page.getByText('New arrival while reading history', { exact: true }),
  ).toBeInViewport();
  report.checks.push(
    'new messages preserve the reading anchor when the latest history window advances',
  );
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByText('Send survives navigation', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 640 });
  for (const name of ['Birch', 'Atlas']) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await choose(name);
    await expect(page.locator('.history-load-state')).toHaveCount(0);
  }
  await expect(page.getByText('Send survives navigation', { exact: true })).toBeInViewport({
    ratio: 1,
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await expect(page.locator('.sidebar .nav-row.selected')).toHaveCSS(
      'background-color',
      theme === 'dark' ? 'rgb(42, 48, 75)' : 'rgb(232, 236, 250)',
    );
    await page.screenshot({ path: `evidence/conversation-cache-mobile-${theme}.png` });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  report.checks.push(
    'mobile revisits show cached content with no horizontal overflow in both themes',
  );
  await page.goto(`${origin}/?conversation=${agents[1].dmId}&message=${reply.id}`);
  await expect(page.locator('.thread .message-highlight')).toContainText('A cached thread reply');
  await expect(page.locator('.thread .message-highlight')).toBeInViewport();
  report.checks.push('direct message links open the matching thread reply');
  if (errors.length) throw Error(errors.join('\n'));
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  process.exitCode = 1;
  await page.screenshot({ path: 'evidence/conversation-cache-failure.png' });
} finally {
  releaseHistory();
  mkdirSync('evidence', { recursive: true });
  writeFileSync('evidence/conversation-cache-ui.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await browser.close();
  await app.close();
}
