import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const base = (process.argv[2] || 'http://127.0.0.1:4388').replace(/\/$/, '');
const browser = await chromium.launch();
try {
  for (const [width, height] of [
    [320, 844],
    [390, 844],
    [768, 1000],
    [1440, 1000],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: width === 390 ? 2 : 1,
      hasTouch: width < 700,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => {
      if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
    });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.locator('#workspace[data-ready="true"]').waitFor();
    assert.match(await page.locator('h1').innerText(), /People and agents/);
    assert.equal(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
      ),
      '#1c1e22',
    );
    assert.match(await page.locator('.demo-topline').innerText(), /sample messages/);
    assert.ok(
      (await page.locator('#workspace').boundingBox()).y < height - 60,
      'workspace starts above fold',
    );
    for (const index of [0, 1, 2]) {
      if (width < 700) await page.locator(`#step-${index}`).tap();
      else await page.locator(`#step-${index}`).click();
      assert.equal(await page.locator(`#step-${index}`).getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('[role=tabpanel]:visible').count(), 1);
      assert.ok(await page.locator(`#workflow-${index}`).isVisible());
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `overflow ${width} step ${index}`,
      );
    }
    assert.match(await page.locator('#workflow-1').innerText(), /@Reviewer/);
    assert.match(await page.locator('#workflow-2').innerText(), /Keep the regression test/);
    await page.locator('#step-2').focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('#step-1').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#step-1').evaluate((e) => document.activeElement === e), true);
    await page.keyboard.press('Home');
    assert.equal(await page.locator('#step-0').getAttribute('aria-selected'), 'true');
    assert.equal(
      await page.locator('#workspace').getAttribute('data-paused'),
      'true',
      'manual selection pauses tour',
    );
    await page.getByRole('button', { name: 'Play walkthrough', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('#workspace').dataset.playing === 'true',
    );
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await page.waitForFunction(
      () => document.querySelector('#workspace').dataset.playing === 'false',
    );
    await page.locator('#workspace').scrollIntoViewIfNeeded();
    await page.waitForFunction(
      () => document.querySelector('#workspace').dataset.playing === 'true',
    );
    await page.getByRole('button', { name: 'Pause walkthrough', exact: true }).click();
    if (width < 700) {
      await page.getByRole('button', { name: 'Open menu' }).click();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'), 'false');
    }
    assert.deepEqual(
      await page
        .locator('a[href^="#"]')
        .evaluateAll((links) =>
          links.filter((a) => !document.getElementById(a.hash.slice(1))).map((a) => a.hash),
        ),
      [],
    );
    await page.goto(base + '/#provider-details');
    assert.equal(await page.locator('#provider-details').getAttribute('open'), '');
    await page.goto(base + '/start.html', { waitUntil: 'networkidle' });
    assert.match(await page.locator('body').innerText(), /notes.txt/);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'setup overflow',
    );
    assert.deepEqual(errors, []);
    await page.close();
    console.log(
      `${width}px: app palette, responsive workflow, touch/click and keyboard tabs, pause/resume, offscreen suspension, navigation and setup passed`,
    );
  }
  const timed = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await timed.clock.install();
  await timed.goto(base, { waitUntil: 'networkidle' });
  await timed.waitForFunction(
    () => document.querySelector('#workspace').dataset.playing === 'true',
  );
  await timed.clock.runFor(8100);
  assert.equal(
    await timed.locator('#workspace').getAttribute('data-step'),
    '1',
    'autoplay advances to collaboration',
  );
  await timed.clock.runFor(8100);
  assert.equal(await timed.locator('#workspace').getAttribute('data-step'), '2');
  assert.equal(
    await timed.locator('#workspace').getAttribute('data-paused'),
    'true',
    'tour stops at review',
  );
  await timed.getByRole('button', { name: 'Replay walkthrough' }).click();
  assert.equal(await timed.locator('#workspace').getAttribute('data-step'), '0');
  await timed.getByRole('button', { name: 'Pause walkthrough' }).click();
  await timed.clock.runFor(20000);
  assert.equal(
    await timed.locator('#workspace').getAttribute('data-step'),
    '0',
    'pause remains stable',
  );
  await timed.close();
  const rp = await browser.newPage({ reducedMotion: 'reduce' });
  await rp.clock.install();
  await rp.goto(base, { waitUntil: 'networkidle' });
  assert.equal(await rp.locator('#workspace').getAttribute('data-paused'), 'true');
  await rp.clock.runFor(20000);
  assert.equal(await rp.locator('#workspace').getAttribute('data-step'), '0');
  await rp.getByRole('button', { name: 'Play walkthrough' }).click();
  await rp.clock.runFor(8100);
  assert.equal(await rp.locator('#workspace').getAttribute('data-step'), '1');
  await rp.close();
  const np = await browser.newPage({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  await np.goto(base, { waitUntil: 'networkidle' });
  assert.ok(await np.locator('#workflow-0').isVisible());
  assert.ok(await np.locator('.no-script').isVisible());
  assert.ok(await np.locator('#site-nav').isVisible());
  assert.ok(await np.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await np.close();
  const archives = await browser.newPage();
  await archives.goto(base + '/beacon.html', { waitUntil: 'networkidle' });
  await archives.waitForFunction(() => document.querySelector('video').currentTime > 0);
  await archives.goto(base + '/crossing.html', { waitUntil: 'networkidle' });
  await archives.locator('#city-canvas[data-ready="true"]').waitFor();
  await archives.locator('[data-bridge="central"]').click();
  assert.equal(
    await archives.locator('[data-bridge="central"]').getAttribute('aria-pressed'),
    'true',
  );
  await archives.close();
  console.log(
    'Timed progression, stop/replay, reduced motion, no-JavaScript content and both archives passed',
  );
  const req = await browser.newContext();
  for (const [path, status] of [
    ['/health', 200],
    ['/mark.svg', 200],
    ['/social-card.png', 200],
    ['/server.mjs', 404],
    ['/%25', 404],
  ])
    assert.equal((await req.request.get(base + path)).status(), status, path);
  const video = await req.request.get(base + '/assets/demo/build.mp4', {
    headers: { Range: 'bytes=0-99' },
  });
  assert.equal(video.status(), 206);
  assert.equal((await video.body()).length, 100);
  await req.close();
  console.log('Assets, public file boundaries and recorded-build range delivery passed');
} finally {
  await browser.close();
}
