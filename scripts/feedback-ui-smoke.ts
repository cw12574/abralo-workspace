import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-feedback-ui-')));
const user = store.createOwner('Tester');
const e = store.createEmployee(user.id, {
  name: 'Chief of Staff',
  harness: 'codex',
  model: '',
  cwd: '',
  role: 'Coordinates work',
  instructions: '',
});
const { app } = await createApp(store);
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 640 },
  permissions: ['notifications'],
});
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.route('**/api/providers*', async (route) => {
  await new Promise((r) => setTimeout(r, 120));
  await route.fulfill({
    json: [
      {
        harness: 'codex',
        installed: true,
        authenticated: true,
        version: 'fixture',
        detail: 'ChatGPT · Connected',
        models: [{ id: 'fixture', name: 'Fixture model' }],
      },
      {
        harness: 'claude',
        installed: true,
        authenticated: false,
        version: 'fixture',
        detail: 'Sign in with Claude Code',
      },
      {
        harness: 'opencode',
        installed: true,
        authenticated: null,
        version: 'fixture',
        detail: 'Choose a provider',
      },
    ],
  });
});
const report: any = { checks: [], fixture: true };
try {
  await page.goto(origin + '/#setup=' + store.bootstrapToken);
  await expect(page.getByRole('heading', { name: 'What should I call you?' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Morgan');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect Chief of Staff.' })).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await page.getByRole('button', { name: 'OpenCode', exact: false }).click();
  await page.getByRole('button', { name: 'Check status', exact: true }).click();
  if (errors.length) throw Error('Provider check raised a browser error: ' + errors.join('; '));
  await page.getByRole('button', { name: 'Codex', exact: false }).click();
  await expect(page.getByText('What should your team work towards?')).toHaveCount(0);
  const next = await page.getByRole('button', { name: 'Continue', exact: true }).boundingBox();
  if (!next || next.y + next.height > 640) throw Error('Onboarding Continue below fold');
  await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Connected. You’re ready');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'What should your team work towards?' }),
  ).toBeVisible();
  mkdirSync('evidence', { recursive: true });
  await page.screenshot({ path: 'evidence/feedback-onboarding.png' });
  report.checks.push(
    '1280×640 connect step above fold, no model picker, visible connection-check result',
  );
  store.set('workspace.onboarded', true);
  // A shared human channel exercises sends without running a paid provider.
  const channel = 'feedback-channel';
  store.run(
    'INSERT INTO conversations VALUES(?,?,?,?,?)',
    channel,
    'product',
    'channel',
    null,
    new Date().toISOString(),
  );
  store.run('INSERT INTO members(conversation_id,user_id) VALUES(?,?)', channel, user.id);
  await page.goto(origin + '/?conversation=' + channel);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const before = (await composer.boundingBox())!.height;
  await composer.fill('Line one\nLine two\nLine three\nLine four\nLine five\nLine six');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(composer).toHaveValue('');
  if ((await composer.boundingBox())!.height > before + 2) throw Error('Composer did not shrink');
  report.checks.push('six-line composer returns to original height');
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  await page.getByRole('button', { name: 'notifications', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send a test', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  store.set('notifications.' + user.id, { enabled: true, sound: false, privatePreview: false });
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  await page.getByRole('button', { name: 'notifications', exact: true }).click();
  await page.getByRole('button', { name: 'Send a test', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Sent to your browser');
  const notices = await page.evaluate(
    async () =>
      (await (await navigator.serviceWorker.getRegistration('/'))!.getNotifications()).length,
  );
  report.retainedHeadlessNotifications = notices;
  report.checks.push(
    'test hidden before enabling; real Chrome service worker accepts notification and UI reports result (OS banner not asserted)',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page
    .getByRole('button', { name: /^Chief of Staff$/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Permission mode', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /Full access/ }).click();
  await expect(page.getByRole('button', { name: 'Permission mode', exact: true })).toContainText(
    'Full access',
  );
  if (store.employee(e.id)?.permissionMode !== 'bypass') throw Error('Mode not persisted');
  await page.getByRole('button', { name: 'Permission mode', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /Auto/ }).click();
  report.checks.push('permission mode changes persist and refresh in composer');
  const runId = 'feedback-run';
  const request = store.addMessage(
    e.dmId,
    user.id,
    user.name,
    'human',
    'Please check the project.',
  );
  const response = store.addMessage(
    e.dmId,
    e.id,
    e.name,
    'agent',
    'I’ve checked the conversation and prepared the project checks.',
    null,
    [],
    runId,
  );
  store.run(
    'INSERT INTO runs(id,conversation_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
    runId,
    e.dmId,
    user.id,
    e.id,
    request.id,
    response.id,
    'waiting_permission',
    new Date().toISOString(),
    new Date().toISOString(),
    'fixture',
  );
  store.run(
    'INSERT INTO activities VALUES(?,?,?)',
    'feedback-tool',
    runId,
    JSON.stringify({
      id: 'feedback-tool',
      type: 'tool',
      title: 'workspace_read',
      state: 'complete',
      detail: 'Read the recent conversation.',
    }),
  );
  store.run(
    'INSERT INTO decisions(id,run_id,user_id,state,data) VALUES(?,?,?,?,?)',
    'feedback-decision',
    runId,
    user.id,
    'pending',
    JSON.stringify({
      kind: 'permission',
      title: 'Run the project checks?',
      detail: { command: 'pnpm test' },
    }),
  );
  store.run(
    'INSERT INTO connections VALUES(?,?,?,?,?,?)',
    'feedback-railway',
    user.id,
    'railway',
    'railway',
    'requested',
    JSON.stringify({ conversationId: e.dmId, employeeId: e.id }),
  );
  await page.route('**/api/connections/feedback-railway/connect', (r) =>
    r.fulfill({
      json: { url: 'https://railway.com/', message: 'Sign in to select your account.' },
    }),
  );
  await page.evaluate(() => localStorage.setItem('theme', 'dark'));
  await page.goto(origin + '/?conversation=' + e.dmId);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: /^Show activity timeline/ }).click();
  await page.screenshot({ path: 'evidence/feedback-conversation.png' });
  await page.route('**/api/usage/accounts', (route) =>
    route.fulfill({
      json: {
        providers: [
          { harness: 'codex', authenticated: true, detail: 'ChatGPT · Connected' },
          { harness: 'claude', authenticated: false, detail: 'Claude subscription' },
          { harness: 'opencode', authenticated: false, detail: 'Choose a provider' },
        ],
        forecasts: {},
        trends: {},
      },
    }),
  );
  await page.getByRole('button', { name: 'Usage', exact: false }).first().click();
  await expect(page.getByRole('button', { name: /Sign in with Claude/ })).toBeVisible();
  await page.getByRole('button', { name: /Sign in with Claude/ }).click();
  await expect(page.getByRole('heading', { name: 'Workspace settings' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'accounts', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  report.checks.push(
    'provider status refresh avoids browser errors; Usage sign-in opens Accounts settings',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Usage', exact: false }).first().click();
  await page.screenshot({ path: 'evidence/feedback-usage.png' });
  report.checks.push(
    'dark tool/permission/connection cards and usage modal screenshots at laptop size',
  );
  if (errors.length) throw Error(errors.join('\n'));
  report.status = 'passed';
} catch (e) {
  report.status = 'failed';
  report.error = String(e);
  report.pageText = (
    await page
      .locator('body')
      .innerText()
      .catch(() => '')
  ).slice(0, 1000);
  process.exitCode = 1;
} finally {
  mkdirSync('evidence', { recursive: true });
  writeFileSync('evidence/feedback-ui.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await browser.close();
  await app.close();
}
