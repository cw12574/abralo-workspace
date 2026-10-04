import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const base = (process.argv[2] || 'http://127.0.0.1:4387').replace(/\/$/, '');
const browser = await chromium.launch();
const pixels = (page) => page.locator('#city-canvas').evaluate((c) => c.toDataURL());
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
      hasTouch: width < 760,
    });
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => {
      if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
    });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.locator('#city-canvas[data-ready="true"]').waitFor();
    assert.match(await page.locator('h1').innerText(), /Put your agents/);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `overflow ${width}`,
    );
    const box = await page.locator('#city-canvas').boundingBox();
    assert.ok(box.y < height - 60, `town must begin in first viewport ${width}`);
    await page.waitForFunction(
      () => document.querySelector('#city-canvas').dataset.running === 'true',
    );
    const moving = await pixels(page);
    await page.waitForTimeout(300);
    assert.notEqual(await pixels(page), moving, 'traffic should actually move');
    await page.getByRole('button', { name: 'Pause city', exact: true }).click();
    const stopped = await pixels(page);
    await page.waitForTimeout(250);
    assert.equal(await pixels(page), stopped, 'paused picture should remain still');
    await page.locator('[data-bridge="central"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(
      await page.locator('[data-bridge="central"]').getAttribute('aria-pressed'),
      'true',
    );
    assert.notEqual(await pixels(page), stopped, 'closure must be drawn');
    for (const id of ['north', 'south']) await page.locator(`[data-bridge="${id}"]`).click();
    assert.match(await page.locator('#city-message').innerText(), /All three bridges are closed/);
    // Map targets use the same proportional projection as the renderer.
    const map = await page.locator('#city-canvas').boundingBox();
    const hit = { x: map.x + map.width / 2, y: map.y + (map.height * 130) / 640 };
    if (width < 760) await page.touchscreen.tap(hit.x, hit.y);
    else await page.mouse.click(hit.x, hit.y);
    assert.equal(await page.locator('[data-bridge="north"]').getAttribute('aria-pressed'), 'false');
    await page.locator('#demand-toggle').click();
    assert.equal(await page.locator('#demand-toggle').getAttribute('aria-pressed'), 'true');
    await page.locator('#city-reset').click();
    const reset = await pixels(page);
    assert.equal(await page.locator('#demand-toggle').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('[data-bridge][aria-pressed="true"]').count(), 0);
    assert.equal(await page.locator('#stat-rerouted').innerText(), '0');
    await page.locator('#city-reset').click();
    assert.equal(await pixels(page), reset, 'same seed must reset to the same picture');
    await page.getByRole('button', { name: 'Play city', exact: true }).click();
    await page.evaluate(() => scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
    await page.waitForFunction(
      () => document.querySelector('#city-canvas').dataset.running === 'false',
    );
    const offscreen = await pixels(page);
    await page.waitForTimeout(200);
    assert.equal(await pixels(page), offscreen, 'offscreen scene must stop drawing');
    await page.locator('#city-canvas').scrollIntoViewIfNeeded();
    await page.waitForFunction(
      () => document.querySelector('#city-canvas').dataset.running === 'true',
    );
    if (width < 760) {
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
    await page.goto(base + '/#build-story');
    assert.equal(await page.locator('#build-story').getAttribute('open'), '');
    await page.locator('#load-journal').click();
    await page.locator('#journal:not([hidden])').waitFor();
    assert.ok(
      (await page.locator('#journal article').count()) >= 4,
      'actual brief and agent handoffs',
    );
    assert.match(await page.locator('#journal').innerText(), /Reviewer/);
    await page.goto(base + '/#provider-details');
    assert.equal(await page.locator('#provider-details').getAttribute('open'), '');
    await page.goto(base + '/start.html', { waitUntil: 'networkidle' });
    assert.match(await page.locator('body').innerText(), /notes.txt/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    await page.close();
    console.log(
      `${width}px: responsive scene, movement, pause, keyboard/touch closure, demand, deterministic reset, offscreen suspension, notebook and setup passed`,
    );
  }
  const rp = await browser.newPage({ reducedMotion: 'reduce' });
  await rp.goto(base, { waitUntil: 'networkidle' });
  await rp.locator('#city-canvas[data-ready="true"]').waitFor();
  assert.equal(await rp.locator('#city-canvas').getAttribute('data-paused'), 'true');
  const still = await pixels(rp);
  await rp.waitForTimeout(200);
  assert.equal(await pixels(rp), still);
  await rp.getByRole('button', { name: 'Play city', exact: true }).click();
  await rp.waitForTimeout(250);
  assert.notEqual(await pixels(rp), still);
  await rp.close();
  const failed = await browser.newPage();
  await failed.route('**/assets/city/city-view.mjs', (route) => route.abort());
  await failed.goto(base);
  await failed.locator('.city-fallback').waitFor();
  assert.match(await failed.locator('#city-message').innerText(), /could not load/);
  await failed.close();
  const np = await browser.newPage({ javaScriptEnabled: false });
  await np.goto(base);
  await np.locator('noscript').getByRole('link', { name: 'view the map' }).waitFor();
  await np.close();
  const archive = await browser.newPage();
  await archive.goto(base + '/beacon.html', { waitUntil: 'networkidle' });
  await archive.waitForFunction(() => document.querySelector('video').currentTime > 0);
  await archive.close();
  console.log(
    'Reduced motion, explicit play, failed-module fallback, no-JavaScript content and Beacon archive passed',
  );
  const req = await browser.newContext();
  for (const [path, status] of [
    ['/health', 200],
    ['/assets/city/journal.json', 200],
    ['/assets/city/validation.txt', 200],
    ['/assets/city/room.webp', 200],
    ['/assets/city/poster.webp', 200],
    ['/social-card.png', 200],
    ['/server.mjs', 404],
    ['/assets/city/../../../server.mjs', 404],
    ['/%25', 404],
  ])
    assert.equal((await req.request.get(base + path)).status(), status, path);
  const module = await req.request.get(base + '/assets/city/city-engine.mjs');
  assert.match(module.headers()['content-type'], /javascript/);
  const head = await req.request.head(base + '/assets/demo/build.mp4');
  assert.equal(head.status(), 200);
  assert.equal((await head.body()).length, 0);
  const part = await req.request.get(base + '/assets/demo/build.mp4', {
    headers: { Range: 'bytes=0-99' },
  });
  assert.equal(part.status(), 206);
  assert.equal((await part.body()).length, 100);
  await req.close();
  console.log('Public assets, module MIME, file boundaries and archive byte ranges passed');
} finally {
  await browser.close();
}
