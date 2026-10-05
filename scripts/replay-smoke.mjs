import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const origin = (process.argv[2] || 'http://127.0.0.1:4389').replace(/\/$/, '');
const browser = await chromium.launch();
mkdirSync('.tmp/replay-checks', { recursive: true });
try {
  for (const width of [320, 390, 768, 1440]) {
    const page = await browser.newPage({
      viewport: { width, height: 960 },
      reducedMotion: 'reduce',
    });
    const errors = [],
      requests = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => {
      if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
    });
    page.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
    await page.goto(origin + '/replay.html', { waitUntil: 'networkidle' });
    assert.equal(await page.locator('.replay-stage:visible').count(), 1);
    assert.equal(await page.locator('#defect').isVisible(), true);
    assert.match(await page.locator('#defect blockquote').innerText(), /application\/jsonp/);
    assert.match(await page.locator('#defect pre').innerText(), /201 !== 415/);
    await page.screenshot({ path: `.tmp/replay-checks/${width}.png`, fullPage: true });
    const before = requests.length;
    for (const id of ['handoff', 'fix', 'result', 'defect']) {
      const link = page.locator(`[data-stage="${id}"]`);
      await link.focus();
      await page.keyboard.press('Enter');
      assert.equal(await link.getAttribute('aria-current'), 'step');
      assert.equal(await page.locator('.replay-stage:visible').count(), 1);
      assert.equal(await page.locator(`#${id}`).isVisible(), true);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${width}/${id} overflow`,
      );
    }
    assert.equal(requests.length, before, 'Replay controls must make no network requests');
    await page.goBack();
    assert.equal(await page.locator('#result').isVisible(), true);
    await page.goto(origin + '/replay.html#fix');
    assert.equal(await page.locator('#fix').isVisible(), true);
    await page.locator('#fix [data-step-link]').last().click();
    assert.equal(
      await page.locator('#result-title').evaluate((e) => document.activeElement === e),
      true,
    );
    assert.equal(await page.locator('input, textarea, video, iframe').count(), 0);
    assert.deepEqual(errors, []);
    assert.ok(
      requests.every((r) => r.method === 'GET' && new URL(r.url).origin === new URL(origin).origin),
    );
    await page.close();
    console.log(
      `${width}px: evidence, chapter navigation, history, deep links, focus and no account side effects passed`,
    );
  }
  const page = await browser.newPage({
    javaScriptEnabled: false,
    viewport: { width: 320, height: 960 },
  });
  await page.goto(origin + '/replay.html');
  assert.equal(await page.locator('.replay-stage:visible').count(), 4);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.close();
  const response = await fetch(origin + '/replay.js', { method: 'POST' });
  assert.equal(response.status, 405);
  console.log('No-JavaScript evidence and read-only HTTP boundary passed');
} finally {
  await browser.close();
}
