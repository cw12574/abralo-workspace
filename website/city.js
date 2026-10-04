// Host for the actual engine and drawing made in the Abralo project room.
const canvas = document.querySelector('#city-canvas');
const state = document.querySelector('#scene-state');
const message = document.querySelector('#city-message');
const controls = [...document.querySelectorAll('.town-tools button')];

async function start() {
  const [{ createCity }, { drawCity, bridgeHitTest }] = await Promise.all([
    import('./assets/city/city-engine.mjs'),
    import('./assets/city/city-view.mjs'),
  ]);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable');
  const city = createCity({ seed: 20261005 });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const pause = document.querySelector('#city-pause');
  const demand = document.querySelector('#demand-toggle');
  let paused = reduced.matches,
    visible = false,
    frame = 0,
    previous = 0,
    lastStats = 0;
  let width = 0,
    height = 0,
    pixelRatio = 1,
    snapshot;
  function warmStart() {
    city.reset();
    // Pre-roll 45 deterministic simulated seconds, so the town starts occupied.
    for (let i = 0; i < 180; i++) city.step(0.25);
    snapshot = city.snapshot();
  }
  function render() {
    snapshot = city.snapshot();
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    drawCity(ctx, snapshot, { width, height, pixelRatio });
  }
  function stats() {
    for (const name of ['arrived', 'waiting', 'rerouted'])
      document.querySelector(`#stat-${name}`).textContent = String(snapshot.stats[name]);
  }
  function sync() {
    pause.textContent = paused ? 'Play ▷' : 'Pause Ⅱ';
    pause.setAttribute('aria-label', paused ? 'Play city' : 'Pause city');
    state.textContent = paused ? 'Morning commute · paused' : 'Morning commute · in motion';
    canvas.dataset.paused = String(paused);
    demand.setAttribute('aria-pressed', String(snapshot.demand === 'busy'));
    for (const bridge of snapshot.bridges) {
      const button = document.querySelector(`[data-bridge="${bridge.id}"]`);
      button.setAttribute('aria-pressed', String(!bridge.open));
      button.querySelector('.bridge-state').textContent = bridge.open ? 'open' : 'closed';
      button.setAttribute('aria-label', `${bridge.open ? 'Close' : 'Reopen'} ${bridge.name}`);
    }
    stats();
  }
  function animate(now) {
    frame = 0;
    if (paused || !visible || document.hidden) return;
    if (previous) city.step(Math.min((now - previous) / 1000, 0.1));
    previous = now;
    render();
    if (now - lastStats > 400) {
      stats();
      lastStats = now;
    }
    frame = requestAnimationFrame(animate);
  }
  function lifecycle() {
    cancelAnimationFrame(frame);
    frame = 0;
    previous = 0;
    if (!paused && visible && !document.hidden) frame = requestAnimationFrame(animate);
    canvas.dataset.running = String(!paused && visible && !document.hidden);
  }
  function toggleBridge(id) {
    const bridge = snapshot.bridges.find((b) => b.id === id);
    if (!bridge) return;
    city.setBridgeOpen(id, !bridge.open);
    render();
    sync();
    message.textContent = snapshot.bridges.every((b) => !b.open)
      ? 'All three bridges are closed. Cars already crossing can finish; others will wait. Reopen a bridge to give them a route.'
      : `${bridge.name} ${bridge.open ? 'is closed. Cars already crossing can finish; approaching cars will look for another route.' : 'is open again. The next trips can cross here.'}${paused ? ' Press Play to watch.' : ''}`;
  }
  for (const button of document.querySelectorAll('[data-bridge]'))
    button.addEventListener('click', () => toggleBridge(button.dataset.bridge));
  canvas.addEventListener('click', (event) => {
    const bounds = canvas.getBoundingClientRect();
    const bridge = bridgeHitTest(
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      width,
      height,
    );
    if (bridge) toggleBridge(bridge);
  });
  canvas.addEventListener('pointermove', (event) => {
    const bounds = canvas.getBoundingClientRect();
    canvas.style.cursor = bridgeHitTest(
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      width,
      height,
    )
      ? 'pointer'
      : 'default';
  });
  demand.addEventListener('click', () => {
    const busy = snapshot.demand !== 'busy';
    city.setDemand(busy ? 'busy' : 'calm');
    render();
    sync();
    message.textContent = busy
      ? 'Rush hour. More trips, the same three bridges. Try closing one.'
      : 'Back to a quieter morning. Cars already on the road will finish their trips.';
  });
  pause.addEventListener('click', () => {
    paused = !paused;
    sync();
    lifecycle();
  });
  document.querySelector('#city-reset').addEventListener('click', () => {
    warmStart();
    render();
    sync();
    previous = 0;
    message.textContent = `Back to the same morning: all bridges open, calm traffic.${paused ? ' Press Play to watch.' : ''}`;
  });
  function resize() {
    const bounds = canvas.getBoundingClientRect();
    width = bounds.width;
    height = bounds.height;
    pixelRatio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    render();
  }
  warmStart();
  new ResizeObserver(resize).observe(canvas);
  resize();
  sync();
  window.addEventListener('resize', resize);
  for (const button of controls) button.disabled = false;
  canvas.dataset.ready = 'true';
  new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      lifecycle();
    },
    { threshold: 0.08 },
  ).observe(canvas);
  document.addEventListener('visibilitychange', lifecycle);
  reduced.addEventListener('change', () => {
    if (reduced.matches) {
      paused = true;
      sync();
      lifecycle();
    }
  });
}
if (canvas)
  start().catch(() => {
    canvas.hidden = true;
    const fallback = document.createElement('img');
    fallback.src = '/assets/city/poster.webp';
    fallback.alt = 'The Little Crossing: an illustrated town with three bridges';
    fallback.className = 'city-fallback';
    canvas.after(fallback);
    state.textContent = 'The Little Crossing · still view';
    message.textContent =
      'The interactive town could not load. Reload to try again, or explore the project notebook below.';
  });
