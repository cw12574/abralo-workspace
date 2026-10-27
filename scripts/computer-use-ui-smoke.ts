import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid, now } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-computer-ui-')));
const user = store.createOwner('Tester');
store.set('workspace.onboarded', true);
const employee = store.createEmployee(user.id, { name: 'Ada', harness: 'codex', model: '', cwd: '', role: 'Engineering', instructions: '' });
const message = store.addMessage(employee.dmId, user.id, user.name, 'human', 'Open a desktop app for this task.');
const response = store.addMessage(employee.dmId, employee.id, employee.name, 'agent', 'I need permission to take control of the desktop.');
const runId = uid();
store.run('INSERT INTO runs(id,conversation_id,thread_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)', runId, employee.dmId, null, user.id, employee.id, message.id, response.id, 'waiting_permission', now(), now(), 'fixture');
const { app } = await createApp(store);
store.run('INSERT INTO decisions(id,run_id,user_id,state,data) VALUES(?,?,?,?,?)', uid(), runId, user.id, 'pending', JSON.stringify({ kind: 'desktop_control', title: 'Ada requests desktop control', detail: { reason: 'Open a desktop app for this task.' } }));
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
mkdirSync('evidence', { recursive: true });
try {
  await page.goto(`${origin}/?conversation=${employee.dmId}#setup=${store.bootstrapToken}`);
  const card = page.getByText('Ada requests desktop control');
  await expect(card).toBeVisible();
  const button = page.getByRole('button', { name: 'Allow for 5 minutes' });
  await expect(button).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `evidence/computer-use-${theme}-laptop.png`, fullPage: true });
    const box = await button.boundingBox();
    if (!box || box.y + box.height > 640) throw Error('Desktop permission action is below laptop viewport');
  }
  await page.setViewportSize({ width: 390, height: 760 });
  await page.screenshot({ path: 'evidence/computer-use-mobile.png', fullPage: true });
  const mobile = await button.boundingBox();
  if (!mobile || mobile.x < 0 || mobile.x + mobile.width > 390) throw Error('Desktop permission action overflows mobile viewport');
  await page.route('**/api/desktop-control', (route) => route.fulfill({ json: { active: true, employeeName: 'Ada', expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() } }));
  await page.route('**/api/desktop-control/revoke', (route) => route.fulfill({ json: { active: false } }));
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'Desktop control active' })).toBeVisible();
  await page.screenshot({ path: 'evidence/computer-use-active-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Stop control' }).click();
  await expect(page.getByText('Desktop control active')).toHaveCount(0);
  if (errors.length) throw Error(errors.join('\n'));
  console.log('Computer permission UI passed at laptop light/dark and mobile.');
} finally {
  await browser.close();
  await app.close();
}
