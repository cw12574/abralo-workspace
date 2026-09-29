import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, now } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-reveal-')));
const owner = store.createOwner('Chris');
store.set('workspace.onboarded', true);
const agent = store.createEmployee(owner.id, {
  name: 'Engineer',
  role: 'Product engineering',
  harness: 'codex',
  model: '',
  cwd: '',
  instructions: '',
});
store.addMessage(
  agent.dmId,
  owner.id,
  'Chris',
  'human',
  'Make the conversation feel calm and beautifully readable.',
);
const reply = store.addMessage(
  agent.dmId,
  agent.id,
  agent.name,
  'agent',
  'A calmer conversation.',
  null,
  [],
  'reveal-smoke',
);
const { app } = await createApp(store);
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
store.run(
  'INSERT INTO runs(id,conversation_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
  'reveal-smoke',
  agent.dmId,
  owner.id,
  agent.id,
  reply.id,
  reply.id,
  'completed',
  now(),
  now(),
  'reveal-smoke',
);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.emulateMedia({ reducedMotion: 'no-preference' });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/providers*', (route) => route.fulfill({ json: [] }));
const emit = async (type: string, payload: any) =>
  page.evaluate(
    ({ conversationId, type, payload }) => {
      window.dispatchEvent(
        new CustomEvent('workspace-event', { detail: { conversationId, type, payload } }),
      );
    },
    { conversationId: agent.dmId, type, payload },
  );
const run = (state: string) => {
  store.run('UPDATE runs SET state=? WHERE id=?', state, 'reveal-smoke');
  return emit('run.changed', { id: 'reveal-smoke', employee_id: agent.id, state });
};
const update = (text: string) => {
  store.run('UPDATE messages SET text=? WHERE id=?', text, reply.id);
  return emit('message.updated', { id: reply.id, text });
};
const prose = page.locator('.message .prose').last();
try {
  await page.goto(origin + '/#setup=' + store.bootstrapToken);
  await page.getByRole('button', { name: 'Engineer', exact: false }).first().click();
  await expect(prose).toHaveText(reply.text);
  await run('running');
  await expect(page.locator('.prose-streaming')).toHaveCount(1);
  // Observe actual rendered updates, including the transient fade wrappers.
  await page.evaluate(() => {
    (window as any).revealSamples = [];
    const observer = new MutationObserver(() => {
      const prose = document.querySelector('.prose-streaming');
      if (prose)
        (window as any).revealSamples.push({
          text: prose.textContent,
          spans: prose.querySelectorAll('.text-reveal').length,
        });
    });
    observer.observe(document.querySelector('.message-scroll')!, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  let text = reply.text;
  for (const chunk of [
    '\n\nSmall ',
    'groups ',
    'of words ',
    'arrive ',
    'gently. ',
    '**Existing text stays still.** ',
    'Readable, ',
    'without ',
    'waiting.',
  ]) {
    text += chunk;
    await update(text);
    await page.waitForTimeout(22);
  }
  await expect(prose).toContainText('Readable, without waiting.');
  await expect(prose.locator('.text-reveal')).toHaveCount(0);
  const samples = await page.evaluate(
    () => (window as any).revealSamples as { text: string; spans: number }[],
  );
  expect(
    samples.some((sample) => sample.spans > 0),
    JSON.stringify(samples),
  ).toBe(true);
  expect(Math.max(...samples.map((sample) => sample.spans))).toBeLessThan(12);
  await expect(prose.locator('strong')).toHaveText('Existing text stays still.');

  // Words without spaces must not stall, including CJK and a long URL.
  text += '\n\n静かな会話https://example.com/a/very/long/path';
  await update(text);
  await expect(prose).toContainText('静かな会話https://example.com/a/very/long/path', {
    timeout: 1000,
  });
  text +=
    '\n\n- Stable **formatting**\n- A [useful link](https://example.com)\n\n```ts\nconst calm = true;\n```';
  await update(text);
  await expect(prose.locator('pre code')).toHaveText('const calm = true;\n');
  await expect(prose.locator('a').filter({ hasText: 'useful link' })).toHaveAttribute(
    'href',
    'https://example.com',
  );
  await expect(prose.locator('code .text-reveal')).toHaveCount(0);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  text += '\n\nReduced motion appears immediately.';
  await update(text);
  await expect(prose).toContainText('Reduced motion appears immediately.');
  await expect(prose.locator('.text-reveal')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // Terminal states flush pending text and remove transient elements.
  for (const state of ['completed', 'cancelled', 'failed']) {
    await run('running');
    text += ` ${state} finalword`;
    await update(text);
    await run(state);
    await expect(prose).toContainText(`${state} finalword`);
    await expect(prose.locator('.text-reveal')).toHaveCount(0);
  }
  await run('running');
  text =
    '# A quieter rhythm\n\nSmall groups of words arrive gently. **Existing text stays still.**\n\n- Crisp typography\n- Comfortable spacing\n- Room to read\n\n```ts\nconst calm = true;\n```';
  await update(text);
  await expect(prose.locator('h1')).toHaveText('A quieter rhythm');
  await expect(prose.locator('.text-reveal')).toHaveCount(0);
  mkdirSync('evidence', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.screenshot({ path: `evidence/text-reveal-${theme}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'evidence/text-reveal-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.setViewportSize({ width: 1280, height: 640 });

  // ResizeObserver follows the rendered buffer, not just incoming network events.
  text +=
    '\n\n' +
    Array.from(
      { length: 25 },
      (_, index) => `Paragraph ${index + 1}: Keep the page calm while a response grows.`,
    ).join('\n\n');
  await update(text);
  const scroll = page.locator('.message-scroll').first();
  await expect
    .poll(() => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(2);
  await scroll.hover();
  await page.mouse.wheel(0, -450);
  await page.waitForTimeout(250);
  const held = await scroll.evaluate((el) => el.scrollTop);
  text += '\n\nThis new paragraph must not pull you away from what you are reading.';
  await update(text);
  await page.waitForTimeout(450);
  expect(Math.abs((await scroll.evaluate((el) => el.scrollTop)) - held)).toBeLessThan(2);
  await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(100);
  text += '\n\nFollowing resumes when you return to the bottom.';
  await update(text);
  await expect
    .poll(() => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(2);
  await run('completed');
  await expect(prose.locator('.text-reveal')).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      status: 'passed',
      checks: [
        'word groups and transient fades',
        'Markdown and code',
        'CJK/long tokens',
        'reduced motion',
        'completion/cancellation/failure',
        'text replacement',
        'light/dark/mobile',
        'follow rendered growth; pause and resume on user scroll',
      ],
      fixture: 'isolated database and synthetic stream; no provider calls',
    }),
  );
} finally {
  await browser.close();
  await app.close();
}
