import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

// This temporary test workspace is independent of the installed app's restart handoff.
delete process.env.WORKSPACE_MAINTENANCE_JOB;
const store = new Store(mkdtempSync(join(tmpdir(), 'abralo-connections-ui-')));
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
const connectionId = uid();
store.run(
  'INSERT INTO connections VALUES(?,?,?,?,?,?)',
  connectionId,
  user.id,
  'railway',
  'Abralo production',
  'ready',
  JSON.stringify({ tools: [{ name: 'create_service', inputSchema: { type: 'object' } }] }),
);
const run = {
  id: uid(),
  employee_id: employee.id,
  user_id: user.id,
  conversation_id: employee.dmId,
  message_id: uid(),
};
// This check covers the opt-in mode where the owner is asked before sharing.
store.set('connections.askBeforeSharing.' + user.id, true);
broker.request(run, 'railway', 'write');
store.addMessage(
  employee.dmId,
  employee.id,
  employee.name,
  'agent',
  'Railway is already connected. Share access here and I can prepare the website service.',
);
let executions = 0;
broker.clients.set(connectionId, {
  close: async () => {},
  callTool: async () => {
    executions++;
    return { content: [{ type: 'text', text: 'Fixture service created' }] };
  },
} as any);
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 640 } });
await context.addCookies([{ name: 'workspace', value: store.newSession(user.id), url: origin }]);
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
mkdirSync('evidence', { recursive: true });
try {
  await page.goto(origin + '/?conversation=' + employee.dmId);
  const card = page.locator('.connection-row');
  await expect(card).toHaveCount(1);
  await expect(card.getByRole('button', { name: /^Connect/ })).toHaveCount(0);
  await card.getByRole('button', { name: /Share your Railway account/ }).click();
  await expect(card).toHaveCount(0);
  const action = broker.actions.request(run, connectionId, 'create_service', {
    project: 'Abralo',
    name: 'abralo-website',
  });
  const actionCard = page.locator('.connection-action');
  await expect(actionCard).toContainText('Ready for your approval');
  await actionCard.locator('summary').click();
  const approve = actionCard.getByRole('button', { name: 'Approve action', exact: true });
  await approve.scrollIntoViewIfNeeded();
  await expect(approve).toBeInViewport();
  await page.screenshot({ path: 'evidence/connections-approval-desktop.png', fullPage: true });
  await page.reload();
  await expect(actionCard).toHaveCount(1);
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await page.route(
    '**/api/connection-actions/*/decision',
    (route) =>
      route.fulfill({
        status: 409,
        json: { error: 'Access changed. Review your connected account.' },
      }),
    { times: 1 },
  );
  await approve.click();
  await expect(actionCard.getByRole('alert')).toContainText('Access changed');
  await expect(approve).toBeEnabled();
  await approve.scrollIntoViewIfNeeded();
  await expect(approve).toBeInViewport();
  await page.screenshot({ path: 'evidence/connections-error-dark.png', fullPage: true });
  expect(executions).toBe(0);
  await approve.click();
  await expect(actionCard).toContainText('Completed');
  await page.reload();
  await expect(actionCard).toContainText('Completed');
  expect(executions).toBe(1);
  expect(broker.actions.get(action.actionId, user.id).state).toBe('succeeded');
  const dismiss = actionCard.getByRole('button', { name: 'Dismiss Railway action' });
  await page.route('**/api/connection-actions/*/dismissal', route => route.fulfill({
    status: 503, json: { error: 'Could not save dismissal. Try again.' },
  }), { times: 1 });
  await dismiss.click();
  await expect(actionCard.getByRole('alert')).toContainText('Could not save dismissal');
  await expect(dismiss).toBeEnabled();
  await dismiss.click();
  await expect(actionCard).toHaveCount(0);
  await page.reload();
  await expect(actionCard).toHaveCount(0);
  // The dismissed card leaves a note in its own place in the timeline, not at the bottom.
  const note = page.getByRole('button', { name: 'Show dismissed Railway action' });
  await expect(note).toHaveCount(1);
  expect(
    await note.evaluate((el) => !!el.closest('.inline-actions') || !el.nextElementSibling),
  ).toBe(true);
  await note.click();
  await expect(actionCard).toContainText('Completed');
  await actionCard.getByRole('button', { name: 'Restore Railway action' }).click();
  await expect(dismiss).toBeVisible();
  expect(executions).toBe(1);
  store.run("UPDATE connection_actions SET state='failed' WHERE id=?", action.actionId);
  broker.actions.changed(broker.actions.get(action.actionId, user.id));
  await expect(actionCard).toContainText('Could not complete');
  await dismiss.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'evidence/connections-dismiss-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await page.screenshot({ path: 'evidence/connections-dismiss-light.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await dismiss.scrollIntoViewIfNeeded();
  await expect(dismiss).toBeInViewport();
  await page.screenshot({ path: 'evidence/connections-dismiss-mobile-light.png', fullPage: true });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await page.getByRole('button', { name: 'Abralo Engineer', exact: true }).click();
  await dismiss.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'evidence/connections-dismiss-mobile-dark.png', fullPage: true });
  await dismiss.click();
  await expect(actionCard).toHaveCount(0);
  await page.reload();
  await expect(actionCard).toHaveCount(0);
  expect(broker.actions.get(action.actionId, user.id).state).toBe('failed');
  expect(executions).toBe(1);
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const nativeMcp = page.getByRole('switch', { name: 'Let Claude Code use its own configured tools' });
  await expect(nativeMcp).not.toBeChecked();
  await nativeMcp.click();
  expect(store.setting('connections.nativeMcp.' + user.id)).toBe(true);
  await page.reload();
  await expect(nativeMcp).toBeChecked();
  await page.screenshot({ path: 'evidence/connections-native-mcp-light.png', fullPage: true });
  await page.route('**/api/connections/native-mcp', (route) => route.fulfill({ status: 409, json: { error: 'Setting could not be saved.' } }), { times: 1 });
  await nativeMcp.click();
  await expect(page.getByRole('alert')).toContainText('Setting could not be saved.');
  await expect(nativeMcp).toBeChecked();
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await page.screenshot({ path: 'evidence/connections-native-mcp-dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(nativeMcp).toBeVisible();
  await page.screenshot({ path: 'evidence/connections-native-mcp-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  writeFileSync(
    'evidence/connections-ui.json',
    JSON.stringify(
      {
        fixture: true,
        checks: [
          'one setup card',
          'no duplicate connect button',
          'grant updates conversation',
          'approval survives reload',
          '1280x640 light and dark themes',
          'inline error and reachable retry',
          'one provider dispatch',
          'result survives reload',
          'dismissal error is recoverable; completed/failed cards stay dismissed on reload; show/restore preserves action history and never re-executes',
          'dismiss control reachable in desktop/mobile and light/dark themes',
          '390px layout',
          'configured Claude MCP switch persists and failed saves retain the previous setting',
          'no browser errors',
        ],
        executions,
      },
      null,
      2,
    ),
  );
  console.log('Connection UI checks passed; provider execution was simulated.');
} catch (error) {
  console.log(await page.locator('.connection-row, .connection-action, [role="alert"]').allTextContents());
  await page.screenshot({ path: 'evidence/connections-ui-failure.png', fullPage: true });
  throw error;
} finally {
  await browser.close();
  await app.close();
}
