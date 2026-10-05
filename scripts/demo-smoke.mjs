import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const origin = process.argv[2] || 'http://127.0.0.1:4392';
mkdirSync('.tmp/demo-check', { recursive: true });
const browser = await chromium.launch();
const errors = [];
const requests = [];
try {
  for (const width of [320, 390, 768, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      deviceScaleFactor: width === 390 ? 2 : 1,
      reducedMotion: 'reduce',
      acceptDownloads: true,
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
    await page.goto(origin + '/demo.html');
    await page.locator('#lab[data-ready=true]').waitFor();
    await page.locator('#lab').scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `overflow ${width}`,
    );
    assert.equal(await page.locator('#lab').getAttribute('data-seconds'), '0');
    const initial = await page.locator('#a-arrived').textContent();
    await page.locator('#isolate').click();
    for (let i = 0; i < 4; i++) await page.locator('#step').click();
    assert.ok(
      Number(await page.locator('#a-arrived').textContent()) >
        Number(await page.locator('#b-arrived').textContent()),
    );
    assert.ok(Number(await page.locator('#b-waiting').textContent()) > 0);
    const count = Number(await page.locator('#b-arrived').textContent());
    await page.locator('#restore').click();
    for (let i = 0; i < 4; i++) await page.locator('#step').click();
    assert.ok(Number(await page.locator('#b-arrived').textContent()) > count);
    await page.locator('#rush').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#rush').getAttribute('aria-pressed'), 'true');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export').click();
    const download = await downloadPromise;
    await download.saveAs(`.tmp/demo-check/report-${width}.json`);
    await page.locator('#reset').click();
    assert.equal(await page.locator('#lab').getAttribute('data-seconds'), '0');
    assert.equal(await page.locator('#a-arrived').textContent(), initial);
    await page.locator('[data-bridge=central]').click();
    assert.equal(await page.locator('[data-bridge=central]').getAttribute('aria-pressed'), 'true');
    for (let i = 0; i < 4; i++) await page.locator('#step').click();
    await page.screenshot({ path: `.tmp/demo-check/page-${width}.png`, fullPage: true });
    for (const img of await page.locator('img').all()) {
      if (await img.isVisible()) await img.scrollIntoViewIfNeeded();
      await img.evaluate((e) => e.decode());
      assert.equal(await img.evaluate((e) => e.naturalWidth > 0), true);
    }
    await context.close();
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(origin + '/demo.html');
  await page.locator('#lab[data-ready=true]').waitFor();
  await page.locator('.worlds').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  assert.ok(Number(await page.locator('#lab').getAttribute('data-seconds')) > 0, 'autoplay');
  await page.locator('#inside').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const stopped = await page.locator('#lab').getAttribute('data-seconds');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#lab').getAttribute('data-seconds'), stopped, 'offscreen pause');
  await page.close();
  const nojs = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 900 },
  });
  const np = await nojs.newPage();
  await np.goto(origin + '/demo.html');
  assert.equal(await np.locator('#baseline').isVisible(), false);
  assert.equal(await np.locator('.fallback').first().isVisible(), true);
  assert.equal(await np.locator('#close-market').isDisabled(), true);
  assert.equal(await np.locator('#inside h2').textContent(), 'Abralo is where the team works.');
  assert.equal(await np.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await nojs.close();
  const failed = await browser.newContext();
  const fp = await failed.newPage();
  await fp.route('**/assets/city/experiment.mjs', (r) => r.abort());
  await fp.goto(origin + '/demo.html');
  await fp.locator('#announcement').filter({ hasText: 'could not load' }).waitFor();
  assert.equal(await fp.locator('.fallback').first().isVisible(), true);
  assert.equal(await fp.locator('#close-market').isDisabled(), true);
  await failed.close();
  for (const asset of [
    '/assets/showcase/workspace.webp',
    '/assets/showcase/usage.webp',
    '/assets/showcase/connections.webp',
    '/assets/showcase/provenance.txt',
    '/assets/city/experiment.mjs',
  ]) {
    const response = await fetch(origin + asset);
    assert.equal(response.status, 200, asset);
  }
  assert.equal((await fetch(origin + '/assets/showcase/not-public.txt')).status, 404);
  const video = await fetch(origin + '/assets/showcase/tour.mp4', {
    headers: { Range: 'bytes=0-99' },
  });
  assert.equal(video.status, 206);
  assert.equal((await video.arrayBuffer()).byteLength, 100);
  assert.deepEqual(errors, []);
  assert.ok(
    requests.every((r) => r.method === 'GET' && r.url.startsWith(origin)),
    'read-only, same-origin page',
  );
  console.log(
    'Demo: four widths, DPR2, keyboard, closures, recovery, reset, export, motion, offscreen pause, no-JS, assets and read-only requests passed.',
  );
} finally {
  await browser.close();
}
