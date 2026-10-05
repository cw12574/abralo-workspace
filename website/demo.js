async function start() {
  const [{ createExperiment }, { drawCity }] = await Promise.all([
    import('./assets/city/experiment.mjs'),
    import('./assets/city/city-view.mjs'),
  ]);

  const $ = (q) => document.querySelector(q);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const lab = createExperiment();
  const names = { north: 'Willow', central: 'Market', south: 'Foundry' };
  let paused = reduce.matches,
    visible = false,
    raf = 0,
    previous = 0,
    carry = 0,
    lastDraw = 0;
  let speed = 4,
    scene = lab.snapshot();
  const canvases = [$('#baseline'), $('#experiment')];
  const contexts = canvases.map((c) => c.getContext('2d'));
  const time = (seconds) =>
    `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  function draw() {
    scene = lab.snapshot();
    for (let i = 0; i < 2; i++) {
      const canvas = canvases[i],
        r = canvas.getBoundingClientRect(),
        dpr = Math.min(devicePixelRatio || 1, 2);
      const w = Math.round(r.width * dpr),
        h = Math.round(r.height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      contexts[i].setTransform(dpr, 0, 0, dpr, 0, 0);
      drawCity(contexts[i], i ? scene.experiment : scene.baseline, {
        width: r.width,
        height: r.height,
        pixelRatio: dpr,
      });
    }
    $('#clock').textContent = '+' + time(scene.seconds);
    for (const [prefix, key] of [
      ['a', 'baseline'],
      ['b', 'experiment'],
    ])
      for (const stat of ['arrived', 'waiting', 'active'])
        $(`#${prefix}-${stat}`).textContent = scene[key].stats[stat];
    const values = scene.samples,
      max = Math.max(1, ...values.flatMap((s) => [s.baseline.arrived, s.experiment.arrived]));
    for (const [id, key] of [
      ['line-a', 'baseline'],
      ['line-b', 'experiment'],
    ]) {
      $(`#${id}`).setAttribute(
        'd',
        values
          .map(
            (s, i) =>
              `${i ? 'L' : 'M'}${(10 + (i / Math.max(1, values.length - 1)) * 580).toFixed(1)},${(100 - (s[key].arrived / max) * 90).toFixed(1)}`,
          )
          .join(' '),
      );
    }
    $('#chart-start').textContent = time(values[0].seconds);
    $('#chart-end').textContent = time(values.at(-1).seconds);
    const difference = scene.experiment.stats.arrived - scene.baseline.stats.arrived;
    $('#difference').textContent =
      difference === 0
        ? 'Both cities have completed the same number of trips.'
        : `Your city has completed ${Math.abs(difference)} ${difference > 0 ? 'more' : 'fewer'} trips than the baseline.`;
    $('#lab').dataset.seconds = String(scene.seconds);
  }
  function describe(e) {
    if (e.type === 'demand')
      return e.value === 'busy'
        ? 'Rush hour begins in both cities.'
        : 'Calm demand returns to both cities.';
    if (e.type === 'bridges')
      return e.value ? 'All bridges reopen in your city.' : 'Every bridge closes in your city.';
    return `${names[e.value.id]} bridge ${e.value.open ? 'reopens' : 'closes'} in your city.`;
  }
  function sync() {
    $('#play').textContent = paused ? 'Play' : 'Pause';
    $('#play').setAttribute('aria-label', paused ? 'Play experiment' : 'Pause experiment');
    $('#rush').setAttribute('aria-pressed', String(scene.experiment.demand === 'busy'));
    for (const bridge of scene.experiment.bridges) {
      const b = $(`[data-bridge="${bridge.id}"]`);
      b.setAttribute('aria-pressed', String(!bridge.open));
      b.setAttribute(
        'aria-label',
        `${bridge.open ? 'Close' : 'Reopen'} ${names[bridge.id]} bridge`,
      );
      b.querySelector('b').textContent = bridge.open ? 'open' : 'closed';
    }
    $('#close-market').textContent = scene.experiment.bridges[1].open
      ? 'Close Market bridge'
      : 'Reopen Market bridge';
    const list = $('#events');
    list.replaceChildren();
    if (!scene.events.length) {
      const item = document.createElement('li');
      item.textContent = 'The same morning, 45 simulated seconds after sunrise.';
      list.append(item);
    }
    for (const e of scene.events.slice(-4)) {
      const item = document.createElement('li');
      item.textContent = `+${time(e.seconds)} · ${describe(e)}`;
      list.append(item);
    }
  }
  function animate(now) {
    raf = 0;
    if (paused || !visible || document.hidden) return;
    if (previous) carry += Math.min(0.1, (now - previous) / 1000) * speed;
    previous = now;
    const ticks = Math.floor((carry + 1e-9) / 0.05);
    if (ticks) {
      lab.advance(ticks);
      carry -= ticks * 0.05;
    }
    // Draw at most 30 times per second; fixed model ticks remain independent of rendering.
    if (now - lastDraw >= 1000 / 30) {
      draw();
      lastDraw = now;
    }
    raf = requestAnimationFrame(animate);
  }
  function lifecycle() {
    cancelAnimationFrame(raf);
    raf = 0;
    previous = 0;
    const running = !paused && visible && !document.hidden;
    $('#lab').dataset.running = String(running);
    if (running) raf = requestAnimationFrame(animate);
  }
  function change(type, value) {
    lab.command(type, value);
    draw();
    sync();
    $('#announcement').textContent =
      describe(scene.events.at(-1)) +
      (paused
        ? ' Use Play or Advance to see the consequences.'
        : ' Watch how the routes and queues change.');
  }
  function bridge(id) {
    change('bridge', { id, open: !scene.experiment.bridges.find((b) => b.id === id).open });
  }
  try {
    if (contexts.some((c) => !c)) throw new Error('Canvas unavailable');
    canvases.forEach((c) => {
      c.hidden = false;
      c.previousElementSibling.hidden = true;
    });
    draw();
    sync();
    for (const b of document.querySelectorAll('#lab button,#lab select')) b.disabled = false;
    $('#close-market').addEventListener('click', () => bridge('central'));
    for (const b of document.querySelectorAll('[data-bridge]'))
      b.addEventListener('click', () => bridge(b.dataset.bridge));
    $('#rush').addEventListener('click', () =>
      change('demand', scene.experiment.demand === 'busy' ? 'calm' : 'busy'),
    );
    $('#isolate').addEventListener('click', () => change('bridges', false));
    $('#restore').addEventListener('click', () => change('bridges', true));
    $('#play').addEventListener('click', () => {
      paused = !paused;
      sync();
      lifecycle();
    });
    $('#speed').addEventListener('change', (e) => {
      speed = Number(e.target.value);
    });
    $('#step').addEventListener('click', () => {
      paused = true;
      lab.advance(300);
      draw();
      sync();
      lifecycle();
      $('#announcement').textContent =
        'Advanced both cities by 15 simulated seconds. Paused for inspection.';
    });
    $('#reset').addEventListener('click', () => {
      lab.reset();
      carry = 0;
      previous = 0;
      draw();
      sync();
      $('#announcement').textContent =
        'Reset to the same seed and starting traffic. All bridges open, calm demand.';
    });
    $('#export').addEventListener('click', () => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(lab.report(), null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = 'abralo-city-experiment.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    new ResizeObserver(draw).observe($('.worlds'));
    new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        lifecycle();
      },
      { threshold: 0 },
    ).observe($('.worlds'));
    document.addEventListener('visibilitychange', lifecycle);
    reduce.addEventListener('change', () => {
      if (reduce.matches) {
        paused = true;
        sync();
        lifecycle();
      }
    });
    $('#lab').dataset.ready = 'true';
  } catch (error) {
    canvases.forEach((c) => {
      c.hidden = true;
      c.previousElementSibling.hidden = false;
    });
    $('#announcement').textContent =
      'The experiment could not start. The original source, screenshots and recorded work remain available below.';
    console.error(error);
  }
}
start().catch(() => {
  document.querySelector('#announcement').textContent =
    'The experiment could not load. The screenshots, source and recorded work remain available below.';
});
