import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

// This fixture must not inherit the installed app's completed restart job.
delete process.env.WORKSPACE_MAINTENANCE_JOB;
const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-typing-')));
const owner = store.createOwner('Tester');
store.set('workspace.onboarded', true);
const agent = store.createEmployee(owner.id, {
  name: 'Typing Check',
  harness: 'codex',
  model: '',
  role: 'Fixture',
  cwd: '',
  instructions: '',
});
for (let i = 0; i < 95; i++)
  store.addMessage(
    agent.dmId,
    owner.id,
    owner.name,
    'human',
    `History ${i}. ${'A conversation to read. '.repeat((i % 4) + 1)}`,
  );
const latest = store.addMessage(
  agent.dmId,
  agent.id,
  agent.name,
  'agent',
  'The latest message should stay steady while you type.',
);
const { app, supervisor } = await createApp(store);
supervisor.dispatch = async () => {};
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.addInitScript('window.__name = (fn) => fn');
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/providers*', (route) => route.fulfill({ json: [] }));
const composer = page.getByRole('textbox', { name: 'Message', exact: true });
const scroll = page.locator('.chat > .message-scroll').first();
const report: any = { samples: [] };
async function trackTyping(label: string, text: string, messageId = latest.id) {
  await page.evaluate((id) => {
    const samples: any[] = [];
    (window as any).typingTrace = { samples, running: true };
    const sample = () => {
      const scroll = document.querySelector('.chat > .message-scroll')!;
      const message = document.querySelector(`[data-message-id="${id}"]`)!;
      const input = document.querySelector('.composer textarea')!;
      samples.push({
        top: message.getBoundingClientRect().top,
        scroll: scroll.scrollTop,
        height: input.getBoundingClientRect().height,
        viewport: scroll.clientHeight,
      });
      if ((window as any).typingTrace.running) requestAnimationFrame(sample);
    };
    sample();
  }, messageId);
  await composer.pressSequentially(text, { delay: 55 });
  await page.waitForTimeout(350);
  const samples = await page.evaluate(() => {
    (window as any).typingTrace.running = false;
    return (window as any).typingTrace.samples;
  });
  const spread = (key: string) =>
    Math.max(...samples.map((x: any) => x[key])) - Math.min(...samples.map((x: any) => x[key]));
  const result = {
    label,
    messageMovement: spread('top'),
    composerMovement: spread('height'),
    samples,
  };
  report.samples.push(result);
  expect(result.composerMovement, label + ' stays on one composer line').toBeLessThanOrEqual(1);
  expect(result.messageMovement, label + ' must not move the message').toBeLessThanOrEqual(1);
}
try {
  await page.goto(origin + '/#setup=' + store.bootstrapToken);
  await page
    .locator('.sidebar')
    .getByRole('button', { name: /Typing Check/ })
    .first()
    .click();
  await expect(page.getByText(latest.text, { exact: true })).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 1280 ? 640 : 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      for (const [kind, draft] of [
        ['single line', 'Draft: '],
        ['multiline', 'Line one\nLine two\nLine three\nLine four\nLine five\nDraft: '],
        ['maximum height', 'A line\n'.repeat(15) + 'Draft: '],
      ]) {
        await composer.fill(draft);
        await expect
          .poll(() => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
          .toBeLessThan(2);
        await page.waitForTimeout(250);
        await trackTyping(`${width} ${theme}: ${kind} at latest`, 'steady typing');
      }
      await page.screenshot({ path: `evidence/typing-scroll-${width}-${theme}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 640 });
  await composer.fill('Read history\nLine two\nLine three\nLine four\nDraft: ');
  await page.waitForTimeout(400);
  await scroll.evaluate((el) => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 }));
    el.scrollTop = 1200;
    el.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(500);
  const anchor = await scroll.evaluate(
    (el) =>
      [...el.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (row) => row.getBoundingClientRect().bottom > el.getBoundingClientRect().top,
      )!.dataset.messageId!,
  );
  await trackTyping('reading history', 'steady typing', anchor);
  await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await composer.fill('');
  await expect
    .poll(() => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(2);
  report.status = 'passed';
  expect(errors).toEqual([]);
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  process.exitCode = 1;
} finally {
  mkdirSync('evidence', { recursive: true });
  writeFileSync('evidence/typing-scroll-ui.json', JSON.stringify(report, null, 2));
  await page.screenshot({ path: 'evidence/typing-scroll.png' });
  await browser.close();
  await app.close();
  console.log(
    JSON.stringify({
      ...report,
      samples: report.samples.map(({ samples, ...result }: any) => result),
    }),
  );
}
