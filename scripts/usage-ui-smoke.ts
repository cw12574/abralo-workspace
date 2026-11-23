import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

// The Usage page: one headline per account, plain meters, a forecast only when
// it matters, paused work called out, and who is using the allowance.
process.env.WORKSPACE_HOST = '0.0.0.0';
delete process.env.WORKSPACE_MAINTENANCE_JOB;
const dir = mkdtempSync(join(tmpdir(), 'abralo-usage-ui-'));
const store = new Store(dir);
const owner = store.createOwner('Tester');
store.set('workspace.onboarded', true);
store.set('notifications.' + owner.id, { enabled: false, sound: false, privatePreview: true });
const employee = (name: string, harness: string) =>
  store.createEmployee(owner.id, { name, harness, model: '', cwd: '', role: 'Product', instructions: '' });
const chief = employee('Chief of Staff', 'codex');
const engineer = employee('PollyTalks Engineer', 'claude');
const growth = employee('Growth agent', 'codex');
const now = Date.now();
const inHours = (hours: number) => Math.round((now + hours * 3600000) / 1000);
const codexReset = inHours(3);
const providers = [
  {
    harness: 'codex',
    installed: true,
    authenticated: true,
    version: 'test',
    detail: 'chatgpt · plus',
    limits: {
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          limitName: null,
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: codexReset },
          secondary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: inHours(70) },
        },
        codex_sol: {
          limitId: 'codex_sol',
          limitName: 'GPT-6 Sol',
          primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: inHours(70) },
        },
      },
    },
  },
  {
    harness: 'claude',
    installed: true,
    authenticated: true,
    version: 'native Claude Code',
    detail: 'claude.ai · max',
    limits: {
      rateLimitsByLimitId: {
        plan: {
          primary: { usedPercent: 93, windowDurationMins: 300, resetsAt: inHours(1.5), label: 'This session' },
          secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: inHours(40), label: 'This week' },
        },
        'model.fable': {
          primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: inHours(40), label: 'Fable this week' },
        },
      },
    },
  },
  { harness: 'opencode', installed: false, authenticated: false, version: '', detail: '' },
];
// Three rising samples make an honest "could run out before it resets" forecast.
store.set('quota.codex.codex.primary', [
  { at: now - 9 * 60000, used: 30, reset: codexReset },
  { at: now - 5 * 60000, used: 36, reset: codexReset },
  { at: now - 30000, used: 42, reset: codexReset },
]);
const run = (e: any, tokens: number, hoursAgo: number, state = 'completed') => {
  const id = uid();
  const at = new Date(now - hoursAgo * 3600000).toISOString();
  store.run(
    'INSERT INTO runs(id,conversation_id,thread_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,usage,context_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    id,
    e.dmId,
    null,
    owner.id,
    e.id,
    uid(),
    uid(),
    state,
    at,
    at,
    JSON.stringify({ usage: { input_tokens: tokens * 0.8, output_tokens: tokens * 0.2 } }),
    'usage-fixture-' + id,
  );
  return id;
};
run(engineer, 90000, 1);
run(chief, 30000, 2);
run(growth, 120000, 50); // Earlier this week, not today.
const paused = run(engineer, 1000, 0.2, 'provider_limited');
store.set('run.limit.' + paused, {
  provider: 'Claude Code',
  window: 'session',
  retryAt: new Date(now + 1.5 * 3600000).toISOString(),
  message: 'Session limit reached',
});
store.set('run.autoResume.' + paused, true);

const { app, supervisor } = await createApp(store);
supervisor.infos = async () => structuredClone(providers) as any;
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
mkdirSync('evidence', { recursive: true });
try {
  await page.goto(origin + '/#setup=' + store.bootstrapToken);
  await page.getByRole('button', { name: 'Usage', exact: true }).click();
  // A page, not a dialog, remembered across reloads.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Usage', level: 1 })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Usage', level: 1 })).toBeVisible();

  const codex = page.getByRole('article', { name: 'Codex usage' });
  const claude = page.getByRole('article', { name: 'Claude Code usage' });
  await expect(codex.locator('.usage-provider-name')).toContainText('ChatGPT Plus');
  await expect(claude.locator('.usage-provider-name')).toContainText('Claude Max');
  // The headline is the tightest limit.
  await expect(codex.locator('.usage-headline')).toContainText('58%');
  await expect(codex.locator('.usage-headline')).toContainText('left this session');
  await expect(claude.locator('.usage-headline')).toContainText('7%');
  await expect(codex.getByRole('meter', { name: 'This session: 58% left' })).toBeVisible();
  await expect(codex.getByRole('meter', { name: 'This week: 69% left' })).toBeVisible();
  await expect(page.getByText('168 hour window')).toHaveCount(0);
  // Forecast only where it matters.
  await expect(codex.locator('.usage-window-forecast')).toHaveCount(1);
  await expect(codex.locator('.usage-window-forecast')).toContainText('before it resets');
  await expect(claude.locator('.usage-window-forecast')).toHaveCount(0);
  // Model limits wait behind one click.
  await expect(codex.getByText('GPT-6 Sol · this week')).toBeHidden();
  await codex.getByText('Model limits').click();
  await expect(codex.getByText('GPT-6 Sol · this week')).toBeVisible();
  // OpenCode is not installed, so it does not take up room.
  await expect(page.getByRole('article', { name: 'OpenCode usage' })).toHaveCount(0);

  // Needs attention: nearly used up, and who is paused until when.
  const attention = page.getByRole('list', { name: 'Usage that needs attention' });
  await expect(attention).toContainText('Claude Code is nearly used up');
  await expect(attention).toContainText('7% left this session');
  await expect(attention).toContainText('PollyTalks Engineer continues automatically.');
  await expect(attention.locator('.surface-row').filter({ hasText: 'Paused until' })).toHaveCount(1);

  // Who's using it: portraits and shares, with a Today / 7 days switch.
  const people = page.getByRole('list', { name: 'Usage by employee' });
  await expect(people.locator('.usage-person')).toHaveCount(3);
  await expect(people.locator('.usage-person').first()).toContainText('Growth agent');
  await expect(people.locator('svg.avatar')).toHaveCount(3);
  await page.getByRole('radio', { name: 'Today' }).click();
  await expect(people.locator('.usage-person')).toHaveCount(2);
  await expect(people.locator('.usage-person').first()).toContainText('PollyTalks Engineer');
  await expect(people.getByText('Growth agent')).toHaveCount(0);
  await page.getByRole('radio', { name: '7 days' }).click();

  for (const theme of ['light', 'dark'])
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 390, height: 844 },
    ]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.setViewportSize(viewport);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const [edge, top] of [
        ['top', 0],
        ['bottom', 1e6],
      ] as const) {
        await page.locator('.surface-page').evaluate((element, value) => {
          element.scrollTop = value;
        }, top);
        await page.screenshot({ path: `evidence/usage-page-${edge}-${viewport.width}-${theme}.png` });
      }
    }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    'Usage page: tightest-limit headline, plain meters, forecast only when it matters, model limits on request, paused work and low allowance in Needs attention, employee shares by period, desktop/mobile light/dark.',
  );
} finally {
  await browser.close();
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
