import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const base = process.argv[2] || 'http://127.0.0.1:4387';
const browser = await chromium.launch();
try {
  for (const [width, height] of [
    [320, 844],
    [390, 844],
    [768, 1000],
    [1440, 1000],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => {
      if (r.status() >= 400) errors.push(r.status() + ' ' + r.url());
    });
    await page.goto(base, { waitUntil: 'networkidle' });
    assert.match(await page.locator('h1').innerText(), /Build software/);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow ' + width,
    );
    const box = await page.locator('#hero-video').boundingBox();
    assert.ok(box.y < height - 40, 'demo starts below first viewport ' + width);
    await page.waitForFunction(() => {
      const v = document.querySelector('#hero-video');
      return v.currentTime > 0.2 && !v.paused;
    });
    assert.ok(await page.locator('video').evaluate((v) => v.muted), 'autoplay must be muted');
    await page.getByRole('button', { name: 'Pause demo', exact: true }).click();
    const stopped = await page.locator('video').evaluate((v) => v.currentTime);
    await page.waitForTimeout(250);
    assert.ok(
      Math.abs((await page.locator('video').evaluate((v) => v.currentTime)) - stopped) < 0.15,
    );
    await page.locator('[data-chapter="2"]').click();
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return Math.abs(v.currentTime - 14) < 0.15 && !v.seeking;
    });
    assert.equal(await page.locator('video').evaluate((v) => v.paused), true);
    assert.equal(await page.locator('[data-chapter="2"]').getAttribute('aria-current'), 'true');
    await page.getByRole('button', { name: 'Play demo', exact: true }).click();
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await page.waitForFunction(() => document.querySelector('video').paused);
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForFunction(() => !document.querySelector('video').paused);
    await page.getByRole('button', { name: 'Pause demo', exact: true }).click();
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(150);
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(300);
    assert.equal(
      await page.locator('video').evaluate((v) => v.paused),
      true,
      'manual pause must persist',
    );
    await page.getByRole('button', { name: 'Replay ↺', exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('video').currentTime < 3 && !document.querySelector('video').paused,
    );
    await page.locator('video').evaluate((v) => {
      v.currentTime = v.duration - 0.2;
    });
    await page.waitForFunction(() => document.querySelector('video').ended);
    await page.getByRole('button', { name: 'Replay demo', exact: true }).waitFor();
    await page.locator('video').evaluate((v) => {
      v.textTracks[0].mode = 'showing';
    });
    await page.waitForFunction(() => document.querySelector('track').readyState === 2);
    if (width <= 760) {
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
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log(
      width +
        'px: above-fold autoplay, pause/resume, off-screen behavior, chapters, replay/end, captions and setup passed',
    );
    await page.close();
  }
  const reduced = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 1000 },
  });
  const rp = await reduced.newPage();
  await rp.goto(base, { waitUntil: 'networkidle' });
  await rp.waitForTimeout(400);
  assert.equal(await rp.locator('video').evaluate((v) => v.paused), true);
  await rp.getByRole('button', { name: 'Play demo', exact: true }).click();
  await rp.waitForFunction(() => document.querySelector('video').currentTime > 0);
  await reduced.close();
  console.log('Reduced-motion preference and explicit play passed');
  const constrained = await browser.newContext();
  await constrained.addInitScript(() => {
    Object.defineProperty(navigator, 'connection', { value: { saveData: true } });
  });
  const cp = await constrained.newPage();
  await cp.goto(base, { waitUntil: 'networkidle' });
  assert.equal(await cp.locator('video').evaluate((v) => v.paused), true);
  await cp.getByRole('button', { name: 'Play demo', exact: true }).click();
  await cp.waitForFunction(() => document.querySelector('video').currentTime > 0);
  await constrained.close();
  const blocked = await browser.newContext();
  await blocked.addInitScript(() => {
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      HTMLMediaElement.prototype.play = nativePlay;
      return Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'));
    };
  });
  const bp = await blocked.newPage();
  await bp.goto(base, { waitUntil: 'networkidle' });
  await bp.getByRole('button', { name: 'Play demo', exact: true }).click();
  await bp.waitForFunction(() => document.querySelector('video').currentTime > 0);
  await blocked.close();
  const noScript = await browser.newContext({ javaScriptEnabled: false });
  const np = await noScript.newPage();
  await np.goto(base, { waitUntil: 'networkidle' });
  assert.equal(await np.locator('video').getAttribute('controls'), '');
  await np.locator('noscript').getByRole('link', { name: 'read the transcript' }).waitFor();
  await noScript.close();
  console.log('Save-data, rejected-autoplay recovery and no-JavaScript fallback passed');
  const req = await browser.newContext();
  for (const [path, status] of [
    ['/health', 200],
    ['/assets/demo/build-transcript.txt', 200],
    ['/assets/demo/validation.txt', 200],
    ['/server.mjs', 404],
    ['/assets/demo/../../../server.mjs', 404],
    ['/%25', 404],
  ])
    assert.equal((await req.request.get(base + path)).status(), status, path);
  const head = await req.request.head(base + '/assets/demo/build.mp4');
  assert.equal(head.status(), 200);
  assert.equal((await head.body()).length, 0);
  const part = await req.request.get(base + '/assets/demo/build.mp4', {
    headers: { Range: 'bytes=0-99' },
  });
  assert.equal(part.status(), 206);
  assert.equal((await part.body()).length, 100);
  const tail = await req.request.get(base + '/assets/demo/full-build.mp4', {
    headers: { Range: 'bytes=-32' },
  });
  assert.equal(tail.status(), 206);
  assert.equal((await tail.body()).length, 32);
  const invalid = await req.request.get(base + '/assets/demo/build.mp4', {
    headers: { Range: 'bytes=9999999999-' },
  });
  assert.equal(invalid.status(), 416);
  await req.close();
  console.log('Public asset boundaries and video byte ranges passed');
} finally {
  await browser.close();
}
