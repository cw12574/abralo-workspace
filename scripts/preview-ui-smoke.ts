import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, uid, now } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
import { attachArchivedPlanDocuments } from '../apps/service/src/plan-document-attachments.js';

// The fixture is independent of any maintenance job in the parent app process.
delete process.env.WORKSPACE_MAINTENANCE_JOB;

const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-preview-')));
const owner = store.createOwner('Tester');
store.set('workspace.onboarded', true);
const agent = store.createEmployee(owner.id, {
  name: 'Atlas',
  harness: 'codex',
  model: '',
  cwd: '',
  role: 'Fixture',
  instructions: '',
});
const room = uid();
store.run(
  'INSERT INTO conversations VALUES(?,?,?,?,?)',
  room,
  'Preview studio',
  'channel',
  null,
  now(),
);
store.run('INSERT INTO members(conversation_id,user_id) VALUES(?,?)', room, owner.id);
const attachment = (name: string, mime: string, content: string | Buffer) => {
  const id = uid(),
    path = join(store.dir, 'artifacts', id),
    bytes = Buffer.from(content);
  mkdirSync(join(store.dir, 'artifacts'), { recursive: true });
  writeFileSync(path, bytes);
  store.run(
    'INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?)',
    id,
    owner.id,
    room,
    name,
    mime,
    bytes.length,
    path,
    now(),
  );
  return { id, name, mime, size: bytes.length };
};
// Minimal two-page fixture with a correct cross-reference table.
const pdf = () => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...['A considered preview', 'The second page'].map((text) => {
      const stream = `BT /F1 22 Tf 40 440 Td (${text}) Tj ET`;
      return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    }),
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = text.length;
  text += `xref\n0 8\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return text;
};
const files = [
  attachment(
    'Conversation — desktop.png',
    'image/png',
    readFileSync('evidence/conversation-cache-light.png'),
  ),
  attachment(
    'Conversation — mobile.png',
    'image/png',
    readFileSync('evidence/conversation-cache-mobile-dark.png'),
  ),
  attachment(
    'A considered experience.md',
    'text/plain',
    '# A considered experience\n\nFast to open. Comfortable to read.\n\n## Thoughtful details\n\n- Keep your place in the conversation.\n- Inspect the work without leaving it.\n\n[Example](https://example.com)\n\n![External](https://example.com/should-not-load.png)\n\n<script>window.previewUnsafe=true</script>',
  ),
  attachment(
    'Verification.json',
    'application/json',
    JSON.stringify({ status: 'passed', checks: ['Images', 'Documents', 'Threads'], count: 12 }),
  ),
  attachment(
    'Research.csv',
    'text/plain',
    'Name,Notes,Score\nAda,"Clear, considered",10\nChris,"Line one\nLine two",9',
  ),
  attachment('Release notes.pdf', 'application/pdf', pdf()),
  attachment('Working document.docx', 'application/octet-stream', 'unsupported fixture'),
  attachment('Large log.txt', 'text/plain', 'A bounded preview.\n'.repeat(30000)),
];
for (let i = 0; i < 16; i++)
  store.addMessage(
    room,
    owner.id,
    owner.name,
    'human',
    `Reading anchor ${i}. ${'A meaningful conversation. '.repeat(8)}`,
  );
const source = store.addMessage(
  room,
  agent.id,
  agent.name,
  'agent',
  'A few things to inspect together.',
  null,
  files.map((file) => file.id),
);
store.run(
  'INSERT INTO plans VALUES(?,?,?,?,?,?)',
  uid(),
  source.id,
  room,
  agent.id,
  JSON.stringify({
    title: 'A thoughtful release',
    state: 'agreed',
    authorName: 'Atlas',
    version: 2,
    revisions: [
      {
        title: 'First proposal',
        body: 'Explore a clearer opening experience.',
        responsibilities: [{ name: 'Atlas', responsibility: 'Research the options.' }],
      },
      {
        title: 'A thoughtful release',
        body: 'Make images and documents feel at home in the conversation.',
        responsibilities: [
          { name: 'Atlas', responsibility: 'Build and verify the shared viewer.' },
        ],
      },
    ],
  }),
  now(),
);
store.set('migration.plan-preview-documents', false);
attachArchivedPlanDocuments(store);
files.push(store.one("SELECT id,name,mime,size FROM attachments WHERE mime='text/markdown'"));
for (let i = 0; i < 12; i++) {
  store.addMessage(
    room,
    owner.id,
    owner.name,
    'human',
    `Thread note ${i}. ${'Keep this reading position. '.repeat(8)}`,
    source.id,
  );
  if (i === 5)
    store.addMessage(room, owner.id, owner.name, 'human', 'A file inside the thread.', source.id, [
      files[3].id,
    ]);
}
const { app, supervisor } = await createApp(store);
supervisor.dispatch = async () => {};
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 640 } });
const page = await context.newPage();
const errors: string[] = [],
  requests: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => requests.push(request.url()));
await page.route('**/api/providers*', (route) => route.fulfill({ json: [] }));
const report: any = { checks: [] };
const panel = page.getByRole('region', { name: 'Preview', exact: true });
const scroll = page.locator('.conversation-columns > .chat > .message-scroll');
const open = async (index: number) => {
  if (await page.getByRole('button', { name: 'Close preview', exact: true }).count())
    await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await scroll.evaluate((element) =>
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })),
  );
  const target = page.locator(
    `.conversation-columns > .chat [data-preview-id="${files[index].id}"]`,
  );
  await target.scrollIntoViewIfNeeded();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const reading = await scroll.evaluate((element) => {
    element.dispatchEvent(new Event('scroll'));
    const top = element.getBoundingClientRect().top;
    const anchor = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(
      (node) => node.getBoundingClientRect().bottom > top,
    )!;
    return { id: anchor.dataset.messageId!, offset: anchor.getBoundingClientRect().top - top };
  });
  await target.click();
  await expect(panel).toBeVisible();
  return reading;
};
try {
  mkdirSync('evidence', { recursive: true });
  await page.goto(origin + '/#setup=' + store.bootstrapToken);
  await page.locator('.sidebar .nav-row').filter({ hasText: 'Preview studio' }).click();
  await expect(page.locator(`[data-preview-id="${files[0].id}"]`)).toBeVisible();
  expect(requests.some((url) => /pdf-preview|pdf\.worker/.test(url))).toBe(false);
  const reading = await open(0);
  await expect(panel.locator('.image-stage img')).toBeVisible();
  await expect(panel.locator('.image-stage img')).toHaveJSProperty('naturalWidth', 1280);
  await panel.getByRole('button', { name: '100%', exact: true }).click();
  await expect(panel.getByLabel('Zoom level')).toHaveText('100%');
  await panel.getByRole('button', { name: 'Fit', exact: true }).click();
  await panel.getByRole('button', { name: 'Next attachment', exact: true }).click();
  await expect(panel.getByRole('heading', { name: files[1].name })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(panel.getByRole('heading', { name: files[0].name })).toBeVisible();
  await panel.getByRole('button', { name: 'Expand preview' }).click();
  expect((await panel.boundingBox())!.width).toBeGreaterThan(900);
  await panel.getByRole('button', { name: 'Restore preview size' }).click();
  const separator = panel.getByRole('separator');
  await separator.focus();
  await separator.press('ArrowLeft');
  await expect(separator).toHaveAttribute('aria-valuenow', '400');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await page.screenshot({ animations: 'disabled', path: `evidence/preview-image-${theme}.png` });
  }
  const downloadPromise = page.waitForEvent('download');
  await panel.getByRole('link', { name: 'Download file', exact: true }).click();
  expect((await downloadPromise).suggestedFilename()).toBe(files[0].name);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(
    page.locator(`.conversation-columns > .chat [data-preview-id="${files[0].id}"]`),
  ).toBeFocused();
  await expect
    .poll(() =>
      page
        .locator(`.conversation-columns > .chat [data-message-id="${reading.id}"]`)
        .evaluate(
          (element) =>
            element.getBoundingClientRect().top -
            element.closest('.message-scroll')!.getBoundingClientRect().top,
        ),
    )
    .toBeCloseTo(reading.offset, 0);
  report.checks.push(
    'images open in the shared panel; zoom, gallery, expand, resize, download, reading position and focus return work',
  );

  await open(2);
  await expect(panel.locator('.preview-prose h1')).toHaveText('A considered experience');
  expect(requests.some((url) => url.includes('should-not-load'))).toBe(false);
  expect(await page.evaluate(() => (window as any).previewUnsafe)).toBeUndefined();
  await panel.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(panel.locator('pre')).toContainText('# A considered experience');
  await open(3);
  await expect(panel.locator('pre')).toContainText('"status": "passed"');
  await open(4);
  await expect(panel.locator('th')).toHaveCount(3);
  await expect(panel.locator('td').filter({ hasText: 'Clear, considered' })).toHaveCount(1);
  report.checks.push(
    'Markdown, formatted JSON and quoted CSV preview safely without loading external content',
  );

  await open(5);
  await expect(panel.locator('canvas')).toBeVisible({ timeout: 20000 });
  await expect(panel.locator('.pdf-page-count')).toHaveText('1 / 2');
  await panel.getByRole('button', { name: 'Next page', exact: true }).click();
  await panel.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(panel.locator('.pdf-text')).toContainText('The second page');
  report.checks.push('PDF code loads only when opened; individual pages and selectable text work');

  await open(6);
  await expect(panel.getByText('A preview isn’t available for this file type.')).toBeVisible();
  await open(7);
  await expect(
    panel.getByText('Showing a limited preview. Download for the complete file.'),
  ).toBeVisible();
  expect((await panel.locator('pre').textContent())!.length).toBeLessThanOrEqual(120000);
  report.checks.push('unsupported files remain downloadable and large text previews stay bounded');

  await panel.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.route(`**/api/attachments/${files[3].id}`, (route) =>
    route.fulfill({ status: 503, body: 'Unavailable' }),
  );
  await open(3);
  await expect(panel.getByRole('alert')).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: 'evidence/preview-error.png' });
  await page.unroute(`**/api/attachments/${files[3].id}`);
  await panel.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(panel.locator('pre')).toContainText('"status": "passed"');
  report.checks.push('failed previews keep their controls and recover through retry');

  await panel.getByRole('button', { name: 'Close preview', exact: true }).click();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/attachments/${files[3].id}`, async (route) => {
    await held;
    await route.fulfill({ status: 200, body: '{"late":true}' }).catch(() => {});
  });
  await open(3);
  await expect(panel.getByText('Opening file…', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Next attachment', exact: true }).click();
  await expect(panel.locator('th')).toHaveCount(3);
  release();
  await page.unroute(`**/api/attachments/${files[3].id}`);
  await expect(panel.getByRole('heading', { name: files[4].name })).toBeVisible();
  await expect(panel.locator('th')).toHaveCount(3);
  report.checks.push(
    'switching attachments cancels obsolete loads without overwriting the current preview',
  );

  await open(8);
  await expect(panel.locator('.preview-prose')).toContainText('Status when archived: Agreed');
  await expect(panel.locator('.preview-prose')).toContainText('Version 2 — latest');
  await expect(panel.locator('.preview-prose')).toContainText('Version 1');
  await expect(panel.locator('.preview-prose')).toContainText(
    'Build and verify the shared viewer.',
  );
  await expect(page.locator('dialog.plan-folio-dialog')).toHaveCount(0);
  await page.screenshot({ animations: 'disabled', path: 'evidence/preview-archived-plan.png' });
  await panel.getByRole('button', { name: 'Discuss in thread' }).click();
  await expect(page.getByRole('region', { name: 'Thread', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close thread', exact: true }).click();
  report.checks.push(
    'archived plans open in the shared document viewer with all versions, status, responsibilities and a discussion link',
  );

  await page
    .locator(`[data-message-id="${source.id}"]`)
    .getByRole('button', { name: 'Reply in thread' })
    .click();
  const thread = page.getByRole('region', { name: 'Thread', exact: true });
  await thread.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep my thread draft');
  const threadScroll = thread.locator('.message-scroll');
  await threadScroll.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -600 }));
    element.scrollTop = 600;
    element.dispatchEvent(new Event('scroll'));
  });
  const threadFile = thread.locator(`[data-preview-id="${files[3].id}"]`);
  await threadFile.scrollIntoViewIfNeeded();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const before = await threadScroll.evaluate((element) => element.scrollTop);
  await threadFile.click();
  await expect(thread).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Back to thread' })).toBeVisible();
  await panel.getByRole('button', { name: 'Back to thread' }).click();
  await expect(thread.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'Keep my thread draft',
  );
  await expect
    .poll(() => threadScroll.evaluate((element) => element.scrollTop))
    .toBeCloseTo(before, 0);
  await thread.getByRole('button', { name: 'Close thread', exact: true }).click();
  report.checks.push(
    'preview replaces the thread in the same slot, then returns with draft and position preserved',
  );

  await open(2);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await page.screenshot({
      animations: 'disabled',
      path: `evidence/preview-document-${theme}.png`,
    });
  }
  await page.setViewportSize({ width: 390, height: 640 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await expect(
      panel.getByRole('button', { name: 'Close preview', exact: true }),
    ).toBeInViewport();
    await expect(panel.getByRole('link', { name: 'Download file', exact: true })).toBeInViewport();
    await page.screenshot({ animations: 'disabled', path: `evidence/preview-mobile-${theme}.png` });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  report.checks.push('desktop, short laptop and mobile previews remain usable in both themes');
  if (errors.length) throw new Error(errors.join('\n'));
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  report.pageErrors = errors;
  process.exitCode = 1;
  await page.screenshot({ animations: 'disabled', path: 'evidence/preview-failure.png' });
} finally {
  writeFileSync('evidence/preview-ui.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await browser.close();
  await app.close();
}
