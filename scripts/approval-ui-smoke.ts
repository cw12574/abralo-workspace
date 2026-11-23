import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid, now, ApiError } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

process.env.WORKSPACE_HOST = '0.0.0.0';
delete process.env.WORKSPACE_MAINTENANCE_JOB;
const dir = mkdtempSync(join(tmpdir(), 'abralo-approval-ui-'));
let store = new Store(dir);
const owner = store.createOwner('Chris');
store.set('notifications.' + owner.id, { enabled: false, sound: false });
store.set('workspace.onboarded', true);
const employee = store.createEmployee(owner.id, {
  name: 'Engineer',
  harness: 'codex',
  model: '',
  role: 'Product',
  cwd: '',
  instructions: '',
});
let runtime = await createApp(store);
const m = store.addMessage(employee.dmId, owner.id, owner.name, 'human', 'Prepare the update.');
const reply = store.addMessage(
  employee.dmId,
  employee.id,
  employee.name,
  'agent',
  'The checked update is ready when you are.',
);
const run = uid();
store.run(
  `INSERT INTO runs(id,conversation_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key)
  VALUES(?,?,?,?,?,?,?,?,?,?)`,
  run,
  employee.dmId,
  owner.id,
  employee.id,
  m.id,
  reply.id,
  'completed',
  now(),
  now(),
  uid(),
);
const card = runtime.supervisor.requestApproval(run, {
  kind: 'permission',
  actionType: 'maintenance',
  title: 'Install the reviewed Abralo update',
  detail: {
    jobId: uid(),
    explanation:
      'Waits for active work and saves a backup. This card stays available until you decide.',
  },
});
// Close the entire app and database before opening the card in a browser.
await runtime.app.close();
store = new Store(dir);
runtime = await createApp(store);
let valid = false,
  executions = 0;
runtime.supervisor.approvalActions.set('maintenance', async () => {
  if (!valid) throw new ApiError(409, 'This build changed. The approval remains pending.');
  executions++;
  return { started: true };
});
await runtime.app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${(runtime.app.server.address() as any).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.route('**/api/providers*', (route) => route.fulfill({ json: [] }));
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
mkdirSync('evidence', { recursive: true });
async function screenshots(state: string) {
  for (const theme of ['light', 'dark'])
    for (const viewport of [
      { width: 1280, height: 640 },
      { width: 390, height: 780 },
    ]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await page.setViewportSize(viewport);
      await page.getByRole('button', { name: 'Allow this action' }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('button', { name: 'Allow this action' })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `evidence/durable-approval-${state}-${viewport.width}-${theme}.png`,
      });
    }
}
try {
  await page.goto(origin + '/?conversation=' + employee.dmId + '#setup=' + store.bootstrapToken);
  await page.getByRole('button', { name: 'Engineer', exact: true }).click();
  await expect(page.getByText('Install the reviewed Abralo update', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Allow this action' })).toBeVisible();
  await screenshots('pending');
  await page.getByRole('button', { name: 'Allow this action' }).click();
  await expect(
    page.getByText('This build changed. The approval remains pending.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow this action' })).toBeEnabled();
  expect(store.one('SELECT state FROM decisions WHERE id=?', card.decisionId).state).toBe(
    'pending',
  );
  await screenshots('revalidation-error');
  valid = true;
  await page.getByRole('button', { name: 'Allow this action' }).click();
  await expect(page.getByText('Install the reviewed Abralo update', { exact: true })).toHaveCount(
    0,
  );
  expect(executions).toBe(1);
  expect(store.setting('notifications.delivery.' + owner.id)).toBeNull();
  expect(errors).toEqual([]);
  console.log(
    'Durable approval UI passed: survives full app/database restart and reload, valid actions execute once, changed actions stay pending, controls reachable on laptop/mobile in light/dark; native notifications disabled.',
  );
} finally {
  await browser.close();
  await runtime.app.close();
  rmSync(dir, { recursive: true, force: true });
}
