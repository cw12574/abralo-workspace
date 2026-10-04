// Start website/server.mjs separately, then pass its origin or the deployed origin.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const base = process.argv[2] || 'http://127.0.0.1:4387';
const browser = await chromium.launch();
try {
  for (const width of [320, 390, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 960 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(base, { waitUntil: 'networkidle' });
    assert.match(await page.locator('h1').innerText(), /You and your agents/);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `Overflow at ${width}`,
    );
    assert.deepEqual(
      await page
        .locator('a[href^="#"]')
        .evaluateAll((links) =>
          links.filter((a) => !document.getElementById(a.hash.slice(1))).map((a) => a.hash),
        ),
      [],
    );
    const tabs = page.getByRole('tab');
    await tabs.nth(0).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
    assert.match(await page.locator('#demo-description').innerText(), /£50/);
    await page.keyboard.press('End');
    assert.equal(await tabs.nth(2).getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: 'Enlarge application screenshot' }).click();
    assert.equal(await page.locator('#capture-dialog').evaluate((el) => el.open), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#capture-dialog').evaluate((el) => el.open), false);
    await page.getByRole('button', { name: /Back to the brief/ }).click();
    assert.equal(await tabs.nth(0).getAttribute('aria-selected'), 'true');
    if (width <= 800) {
      await page.getByRole('button', { name: 'Open menu' }).click();
      assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'), 'true');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'), 'false');
    }
    await page.getByRole('button', { name: /Watch the screen recording/ }).click();
    const video = page.locator('video');
    await video.evaluate(async (element) => {
      element.muted = true;
      await element.play();
    });
    await page.waitForFunction(() => document.querySelector('video').currentTime > 0);
    assert.ok(await video.evaluate((element) => element.duration > 30 && element.duration < 40));
    await video.evaluate((element) => {
      element.currentTime = 26;
    });
    await page.waitForFunction(
      () =>
        document.querySelector('video').currentTime >= 26 &&
        !document.querySelector('video').seeking,
    );
    assert.equal(await page.locator('track').evaluate((element) => element.readyState), 2);
    await page.keyboard.press('Escape');
    assert.equal(await video.evaluate((element) => element.paused), true);
    await page.locator('.transcript summary').click();
    assert.match(await page.locator('#findings-text').innerText(), /total >= 50/);
    await page.goto(base + '/#provider-details');
    assert.equal(await page.locator('#provider-details').getAttribute('open'), '');
    await page.goto(base + '/start.html', { waitUntil: 'networkidle' });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `Guide overflow at ${width}`,
    );
    assert.match(await page.locator('body').innerText(), /notes.txt/);
    assert.deepEqual(errors, []);
    console.log(
      `${width}px: walkthrough, keyboard, dialogs, video playback/seek/captions, navigation and guide passed`,
    );
    await page.close();
  }
  const request = await browser.newContext();
  for (const [path, status] of [
    ['/health', 200],
    ['/assets/demo/transcript.txt', 200],
    ['/assets/demo/responses.json', 200],
    // Railway rejects invalid percent escapes at its edge. Exercise our malformed
    // decoder locally; on a public origin use the valid encoding of a percent sign.
    [
      new URL(base).hostname === '127.0.0.1' || new URL(base).hostname === 'localhost'
        ? '/%'
        : '/%25',
      404,
    ],
    ['/server.mjs', 404],
    ['/package.json', 404],
    ['/assets/demo/../../../server.mjs', 404],
  ]) {
    const response = await request.request.get(base + path);
    assert.equal(response.status(), status, path);
  }
  const head = await request.request.head(base + '/assets/demo/review.mp4');
  assert.equal(head.status(), 200);
  assert.equal((await head.body()).length, 0);
  const partial = await request.request.get(base + '/assets/demo/review.mp4', {
    headers: { Range: 'bytes=0-99' },
  });
  assert.equal(partial.status(), 206);
  assert.equal((await partial.body()).length, 100);
  const invalid = await request.request.get(base + '/assets/demo/review.mp4', {
    headers: { Range: 'bytes=99999999-' },
  });
  assert.equal(invalid.status(), 416);
  const suffix = await request.request.get(base + '/assets/demo/review.mp4', {
    headers: { Range: 'bytes=-32' },
  });
  assert.equal(suffix.status(), 206);
  assert.equal((await suffix.body()).length, 32);
  await request.close();
  console.log('Health, public file boundary, HEAD and video ranges passed');
} finally {
  await browser.close();
}
