import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid, now } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
import { checkAgentLifecycle } from './agent-lifecycle-ui-checks.js';

// This temporary test server is independent of the host app's restart handoff.
delete process.env.WORKSPACE_MAINTENANCE_JOB;
const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-settings-')));
const user = store.createOwner('Tester');
const collaboratorId = uid();
store.run('INSERT INTO humans VALUES(?,?,?,?,?)', collaboratorId, 'Taylor', 'member', null, now());
store.set('workspace.onboarded', true);
const employee = store.createEmployee(user.id, {
  name: 'Chief of Staff',
  harness: 'codex',
  model: '',
  cwd: '',
  role: 'Coordinates the team',
  instructions: '',
});
store.createEmployee(user.id, {
  name: 'Ada',
  harness: 'claude',
  model: '',
  cwd: '',
  role: 'Engineering',
  instructions: '',
});
const memorySource = store.addMessage(
  employee.dmId,
  employee.id,
  employee.name,
  'agent',
  'PolyTalks serves language learners. Keep plans grounded in its current scale and budget.',
);
for (const content of [
  'PolyTalks is the existing language learning app. It has few active users, so focus on low-cost experiments and direct learner interviews.',
  'The workspace goal is to grow PolyTalks while building and running successful startups. Keep recommendations practical and measurable.',
])
  store.run(
    'INSERT INTO memories(id,conversation_id,author_id,content,source_id,version,deleted,created_at) VALUES(?,?,?,?,?,?,?,?)',
    uid(),
    employee.dmId,
    employee.id,
    content,
    memorySource.id,
    1,
    0,
    now(),
  );
const { app } = await createApp(store);
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.route('**/api/providers*', (route) => route.fulfill({ json: [] }));
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const report: any = { checks: [] };
try {
  await page.route('**/api/startup', (r) =>
    r.fulfill({ json: { supported: true, enabled: false } }),
  );
  await page.goto(origin + '/#setup=' + store.bootstrapToken);
  await expect.poll(() => page.title()).toContain(' · Workspace');
  mkdirSync('evidence', { recursive: true });
  await checkAgentLifecycle(page, store);
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const save = page.getByRole('button', { name: 'Save changes', exact: true });
  await page.getByLabel('Workspace name', { exact: true }).fill('A considered workspace');
  await expect(save).toBeEnabled();
  const box = (await save.boundingBox())!;
  if (box.y + box.height > 640) throw Error('Save below fold');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Save your changes before closing?');
  await save.click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  await expect(page.getByLabel('Workspace name', { exact: true })).toHaveValue(
    'A considered workspace',
  );
  await expect.poll(() => page.title()).toContain(' · A considered workspace');
  await page.getByLabel('Workspace name', { exact: true }).fill('Discard this');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  await expect(page.getByLabel('Workspace name', { exact: true })).toHaveValue(
    'A considered workspace',
  );
  mkdirSync('evidence', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.mouse.move(20, 20);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `evidence/settings-${theme}.png` });
    await page.locator('.settings-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.screenshot({ path: `evidence/settings-device-${theme}.png` });
    for (const tab of ['notifications', 'memory', 'accounts', 'schedules', 'general']) {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByRole('button', { name: tab, exact: true })
        .click();
      await expect(save).toBeVisible();
      if (tab === 'memory') {
        const editors = page.locator('.settings-scroll > .inline-card textarea');
        await expect(editors).toHaveCount(2);
        const editorBounds = (await editors.first().boundingBox())!;
        if (editorBounds.height < 116)
          throw Error(`Memory notes are too cramped to read: ${editorBounds.height}px`);
        await page.setViewportSize({ width: 800, height: 720 });
        await page.screenshot({ path: `evidence/settings-memory-device-${theme}.png` });
        await page.setViewportSize({ width: 1280, height: 640 });
      }
      await page.mouse.move(20, 20);
      await page.screenshot({ path: `evidence/settings-${tab}-${theme}.png` });
      if (await dialog.evaluate((el) => el.scrollWidth > el.clientWidth))
        throw Error('Settings horizontal overflow');
    }
    await page.locator('.settings-scroll').evaluate((el) => (el.scrollTop = 0));
  }
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.sidebar .nav-row').filter({ hasText: 'Chief of Staff' }).click();
  await page.getByRole('button', { name: 'Permission mode', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Permission mode' })).toBeVisible();
  await page.screenshot({ path: 'evidence/permissions-dark.png' });
  await page.getByRole('menuitemradio', { name: /Full access/ }).click();
  await expect.poll(() => store.employee(employee.id)?.permissionMode).toBe('bypass');
  await page.getByRole('button', { name: 'Permission mode', exact: true }).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect.poll(() => store.employee(employee.id)?.permissionMode).toBe('auto');
  await page.getByRole('button', { name: 'Permission mode', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Permission mode' })).toBeHidden();
  await page.getByRole('button', { name: 'Chief of Staff settings' }).click();
  await page.locator('input[name="role"]').fill('Coordinates the workspace');
  await page
    .locator('.employee-settings-scroll')
    .evaluate((el) => (el.scrollTop = el.scrollHeight));
  const employeeSave = page.getByRole('button', { name: 'Save changes', exact: true });
  const saveBounds = (await employeeSave.boundingBox())!;
  if (saveBounds.y + saveBounds.height > 640) throw Error('Employee save below fold');
  await page.screenshot({ path: 'evidence/employee-settings-dark.png' });
  await employeeSave.click();
  await expect.poll(() => store.employee(employee.id)?.role).toBe('Coordinates the workspace');
  await page.getByRole('button', { name: 'Search workspace', exact: true }).click();
  const searchPopover = page.getByRole('dialog', { name: 'Search workspace' });
  await expect(searchPopover).toBeVisible();
  if ((await searchPopover.boundingBox())!.y > 100)
    throw Error('Search is detached from the header');
  const searchInput = page.getByLabel('Search messages and decisions');
  await expect(searchInput).toBeFocused();
  await searchInput.fill('PolyTalks');
  await expect(searchPopover.locator('.search-result').first()).toBeVisible();
  await page.screenshot({ path: 'evidence/search-popover-dark.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileSearch = (await searchPopover.boundingBox())!;
  if (mobileSearch.x < 0 || mobileSearch.x + mobileSearch.width > 390)
    throw Error('Search popover extends beyond mobile viewport');
  await page.screenshot({ path: 'evidence/search-popover-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+F');
  await expect(searchPopover).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Add room', exact: true }).click();
  await page.getByLabel('Room name').fill('launch');
  await page.getByRole('checkbox', { name: /Chief of Staff/ }).check();
  await page.screenshot({ path: 'evidence/create-channel-dark.png' });
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveTitle('#launch · A considered workspace');
  const channelStart = page.locator('.conversation-start');
  await expect(channelStart.getByRole('heading', { name: 'launch', exact: true })).toBeVisible();
  await expect(channelStart.locator('.channel-start-icon')).toBeVisible();
  await expect(channelStart).toContainText('A shared space for your team');
  for (const viewport of [
    { width: 1280, height: 640 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const theme of ['dark', 'light']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await expect(channelStart).toBeVisible();
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw Error('Empty channel overflows viewport');
      const introBox = (await channelStart.boundingBox())!;
      const composerBox = (await page.locator('.composer').boundingBox())!;
      if (introBox.y + introBox.height > composerBox.y)
        throw Error('Empty channel introduction overlaps composer');
      await page.screenshot({ path: `evidence/channel-start-${viewport.width}-${theme}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  const createdChannel = store.one("SELECT id FROM conversations WHERE name='launch'");
  if (
    !createdChannel ||
    !store.one(
      'SELECT 1 FROM employee_conversations WHERE conversation_id=? AND employee_id=?',
      createdChannel.id,
      employee.id,
    )
  )
    throw Error('Agent membership missing');
  await page.getByRole('button', { name: 'launch settings' }).click();
  await page.locator('.channel-settings-dialog').waitFor();
  const channelSettings = page.locator('.channel-settings-dialog');
  await expect(channelSettings).toContainText('Chief of Staff');
  await page.screenshot({ path: 'evidence/channel-settings-dark.png' });
  await channelSettings.getByLabel('Room name').fill('launch-team');
  await channelSettings.locator('textarea').fill('Coordinate the first public launch.');
  await page.keyboard.press('Escape');
  await expect(channelSettings).toContainText('Unsaved room details');
  await channelSettings.getByRole('button', { name: 'Keep editing' }).click();
  await channelSettings.getByRole('button', { name: 'Save details' }).click();
  await expect(page).toHaveTitle('#launch-team · A considered workspace');
  await expect
    .poll(() => store.one('SELECT name FROM conversations WHERE id=?', createdChannel.id)?.name)
    .toBe('launch-team');
  await expect
    .poll(() => store.setting(`channel.${createdChannel.id}.purpose`))
    .toBe('Coordinate the first public launch.');
  await page.getByRole('button', { name: 'Add people' }).click();
  await page.getByRole('checkbox', { name: /Ada/ }).check();
  await page.getByRole('checkbox', { name: /Taylor/ }).check();
  await page.getByRole('button', { name: 'Add 2 people' }).click();
  await expect(channelSettings).toContainText('Ada');
  await expect(channelSettings).toContainText('Taylor');
  await page.getByRole('button', { name: 'Remove Chief of Staff from room' }).click();
  await expect
    .poll(() =>
      store.one(
        'SELECT 1 FROM employee_conversations WHERE conversation_id=? AND employee_id=?',
        createdChannel.id,
        employee.id,
      ),
    )
    .toBeUndefined();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(
    channelStart.getByRole('heading', { name: 'launch-team', exact: true }),
  ).toBeVisible();
  await expect(channelStart).toContainText('Coordinate the first public launch.');
  await page.screenshot({ path: 'evidence/channel-start-purpose.png' });
  await page.getByRole('button', { name: 'Add room', exact: true }).click();
  await page.getByLabel('Room name').fill('launch-team');
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('A channel with that name already exists.');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Add employee', exact: true }).click();
  await page.getByRole('button', { name: 'Human', exact: true }).click();
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  const invitation = page.getByLabel('Invitation link');
  await expect(invitation).toBeVisible();
  const linkBounds = (await invitation.boundingBox())!;
  const copyBounds = (await page.getByRole('button', { name: 'Copy invitation' }).boundingBox())!;
  if (copyBounds.y - (linkBounds.y + linkBounds.height) < 12)
    throw Error('Invitation controls touch');
  const captionBounds = (await page
    .getByText('Expires in 24 hours.', { exact: false })
    .boundingBox())!;
  if (captionBounds.y - (copyBounds.y + copyBounds.height) < 12)
    throw Error('Invitation help touches action');
  await page.screenshot({ path: 'evidence/invitation-spacing-dark.png' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await page.screenshot({ path: 'evidence/invitation-spacing-light.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Copy invitation' })).toBeVisible();
  if (await page.getByRole('dialog').evaluate((el) => el.scrollWidth > el.clientWidth))
    throw Error('Invitation overflow');
  await page.screenshot({ path: 'evidence/invitation-spacing-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  await expect(save).toBeVisible();
  if (await dialog.evaluate((el) => el.scrollWidth > el.clientWidth))
    throw Error('Mobile settings overflow');
  await page.screenshot({ path: 'evidence/settings-mobile.png' });
  if (errors.length) throw Error(errors.join('\n'));
  report.checks = [
    'agent creation immediate busy state, repeated-submit guard, preserved error inputs, safe conversation retry, reduced motion; checkbox-free deletion and repeat guard; both themes at laptop and mobile sizes',
    'visible laptop save; persisted rename; close/escape protect dirty edits; discard',
    'both themes and all settings sections; mobile footer and overflow',
    'permission menu selection, keyboard and Escape',
    'channel purpose and rename; protect unsaved edits; add/remove humans and agents',
    'empty channel identity, saved purpose and rename; visible composer in both themes on laptop and mobile',
  ];
  report.status = 'passed';
} catch (e) {
  report.status = 'failed';
  report.error = String(e);
  process.exitCode = 1;
} finally {
  mkdirSync('evidence', { recursive: true });
  writeFileSync('evidence/settings-ui.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await browser.close();
  await app.close();
}
