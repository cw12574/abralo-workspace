import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid, now } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

// This temporary test server is independent of the host app's restart handoff.
delete process.env.WORKSPACE_MAINTENANCE_JOB;
const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-sidebar-')));
const user = store.createOwner('Tester');
store.run('INSERT INTO humans VALUES(?,?,?,?,?)', uid(), 'Taylor', 'member', null, now());
store.set('workspace.onboarded', true);
for (let i = 0; i < 20; i++)
  store.createEmployee(user.id, {
    name:
      ['Abralo Engineer', 'Chief of Staff', 'Product Designer', 'An agent with a very long name'][
        i
      ] || `Employee ${i}`,
    harness: 'codex',
    model: '',
    cwd: '',
    role: 'Team member',
    instructions: '',
  });
const { app } = await createApp(store);
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.route('**/api/providers*', (route) => route.fulfill({ json: [] }));
await page.route('**/api/workspace', async (route) => {
  const response = await route.fetch();
  const data = await response.json();
  data.employees = data.employees.map((employee: any, index: number) => ({
    ...employee,
    name:
      ['Abralo Engineer', 'Chief of Staff', 'Product Designer', 'An agent with a very long name'][
        index
      ] || employee.name,
    working: index === 0 || index === 2,
    attentionUnread: index === 0 || index === 3,
    nextScheduledAt: index === 0 ? '2026-09-29T09:00:00Z' : null,
  }));
  await route.fulfill({ response, json: data });
});
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const report: any = { checks: [] };
try {
  await page.goto(origin + '/#setup=' + store.bootstrapToken);
  const sidebar = page.locator('.sidebar');
  const separator = page.getByRole('separator', { name: 'Resize sidebar' });
  await expect(separator).toBeVisible();
  await expect(
    sidebar.getByRole('button', { name: 'Workspace settings', exact: true }),
  ).toHaveCount(1);
  await expect(sidebar.locator('.profile')).toHaveCount(0);
  await expect(sidebar.locator('nav').getByText('Tester')).toHaveCount(0);
  await expect(
    sidebar.locator('footer').getByRole('button', { name: 'Connections', exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.locator('footer').getByRole('button', { name: 'Usage', exact: true }),
  ).toBeVisible();
  if ((await sidebar.locator('footer').boundingBox())!.height > 60) throw Error('Footer too tall');
  if ((await sidebar.locator('.employee-row').first().boundingBox())!.height > 36)
    throw Error('Laptop rows too tall');
  const before = (await sidebar.boundingBox())!.width;
  const handle = (await separator.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, 250);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 80, 250, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(before + 80);
  await page.reload();
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(before + 80);
  await separator.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(before + 70);
  await separator.dblclick();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(248);
  report.checks.push('compact footer and laptop rows; drag, persisted width, keyboard and reset');
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const field = await page.getByLabel('Workspace name', { exact: true }).boundingBox();
  await page.mouse.move(field!.x + 60, field!.y + 15);
  await page.mouse.down();
  await page.mouse.move(5, 320, { steps: 12 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  await page.mouse.click(box.x + 5, box.y + 60);
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 320);
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  report.checks.push('selection drag and dialog padding stay open; backdrop and Escape close');
  mkdirSync('evidence', { recursive: true });
  const agentRow = sidebar.locator('.employee-row').first();
  const personRow = sidebar.locator('.employee-row').last();
  await expect(agentRow.locator('.agent-avatar.is-working')).toBeVisible();
  await expect(agentRow.locator('.unread-dot')).toHaveCount(1);
  await expect(personRow.locator('.member-kind')).toHaveText('Person');
  const agentRows = sidebar.locator('.agent-nav-item');
  await expect(agentRows.nth(1).locator('.is-working, .unread-dot')).toHaveCount(0);
  await expect(agentRows.nth(2).locator('.is-working')).toHaveCount(1);
  await expect(agentRows.nth(2).locator('.unread-dot')).toHaveCount(0);
  await expect(agentRows.nth(3).locator('.is-working')).toHaveCount(0);
  await expect(agentRows.nth(3).locator('.unread-dot')).toHaveCount(1);
  await expect(agentRow).toHaveAccessibleDescription(
    /Working · Unread activity · Next scheduled run/,
  );
  await expect(agentRows.nth(1).locator('.employee-row')).toHaveAccessibleDescription('Idle');
  await expect(agentRow.locator('.employee-name')).toHaveCSS('font-weight', '600');
  await expect(sidebar.locator('.presence-square, .agent-presence')).toHaveCount(0);
  const animation = () =>
    agentRow
      .locator('.agent-avatar')
      .evaluate((el) => getComputedStyle(el, '::after').animationName);
  expect(await animation()).toBe('agent-working-breathe');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await animation()).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  report.checks.push(
    'working, idle, unread and combined states; accessible status; reduced motion',
  );
  await separator.focus();
  await page.keyboard.press('Home');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await expect(sidebar.locator('.nav-row.selected')).toHaveCSS(
      'background-color',
      theme === 'dark' ? 'rgb(42, 48, 75)' : 'rgb(232, 236, 250)',
    );
    await personRow.scrollIntoViewIfNeeded();
    await expect(personRow.locator('.member-kind')).toBeVisible();
    await personRow.screenshot({ path: `evidence/sidebar-person-${theme}.png` });
    await agentRow.scrollIntoViewIfNeeded();
    await page.mouse.move(600, 400);
    const beforeHover = await agentRow.locator('.employee-name').boundingBox();
    const unreadBefore = await agentRow.locator('.unread-dot').boundingBox();
    await agentRow.hover({ position: { x: 15, y: 15 } });
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    expect(await agentRow.locator('.employee-name').boundingBox()).toEqual(beforeHover);
    expect(await agentRow.locator('.unread-dot').boundingBox()).toEqual(unreadBefore);
    await expect(agentRows.locator('.nav-actions')).toHaveCount(0);
    await expect(agentRows.first().getByRole('button')).toHaveCount(1);
    const rowBounds = (await agentRow.boundingBox())!;
    const nameBounds = (await agentRow.locator('.employee-name').boundingBox())!;
    expect(
      rowBounds.x + rowBounds.width - unreadBefore!.x - unreadBefore!.width,
    ).toBeLessThanOrEqual(16);
    expect(nameBounds.x + nameBounds.width).toBeLessThan(unreadBefore!.x);
    await page.mouse.move(600, 400);
    await agentRow.focus();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    expect(await agentRow.locator('.employee-name').boundingBox()).toEqual(beforeHover);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.keyboard.press('Tab');
    await expect(agentRows.nth(1).locator('.employee-row')).toBeFocused();
    await separator.focus();
    await page.screenshot({ path: `evidence/sidebar-identity-${theme}.png` });
  }
  await separator.dblclick();
  report.checks.push(
    'stable name and right-edge unread dot; one keyboard stop per agent, no action menu or hover/focus popup at minimum width in both themes',
  );
  await agentRow.click({ position: { x: 15, y: 15 } });
  await expect(agentRow).toHaveAttribute('aria-current', 'page');
  await separator.focus();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await expect(agentRow).toHaveCSS(
      'background-color',
      theme === 'dark' ? 'rgb(42, 48, 75)' : 'rgb(232, 236, 250)',
    );
    await agentRow.hover({ position: { x: 15, y: 15 } });
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.screenshot({ path: `evidence/sidebar-simple-${theme}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(separator).toBeHidden();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await agentRow.scrollIntoViewIfNeeded();
  await expect(agentRow.locator('.agent-avatar')).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await expect(agentRow).toHaveCSS(
      'background-color',
      theme === 'dark' ? 'rgb(42, 48, 75)' : 'rgb(232, 236, 250)',
    );
    await page.screenshot({ path: `evidence/sidebar-identity-mobile-${theme}.png` });
  }
  await personRow.scrollIntoViewIfNeeded();
  await expect(personRow.locator('.member-kind')).toBeVisible();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw Error('Mobile overflow');
  report.checks.push('mobile resizer hidden, no page overflow');
  if (errors.length) throw Error(errors.join('\n'));
  report.status = 'passed';
} catch (e) {
  await page.screenshot({ path: 'evidence/sidebar-failure.png' });
  report.status = 'failed';
  report.error = String(e);
  process.exitCode = 1;
} finally {
  mkdirSync('evidence', { recursive: true });
  writeFileSync('evidence/sidebar-ui.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await browser.close();
  await app.close();
}
