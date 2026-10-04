const menuButton = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#site-nav');
function closeMenu() {
  menuButton?.setAttribute('aria-expanded', 'false');
  menuButton?.setAttribute('aria-label', 'Open menu');
  navigation?.classList.remove('is-open');
}
menuButton?.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') !== 'true';
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  navigation?.classList.toggle('is-open', open);
});
navigation?.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeMenu));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
function revealDetails() {
  if (location.hash === '#provider-details')
    document.querySelector('#provider-details')?.setAttribute('open', '');
}
window.addEventListener('hashchange', revealDetails);
revealDetails();

// This is an explicitly labeled illustration, not a live agent session.
const demo = document.querySelector('#workspace');
if (demo) {
  const tabs = [...demo.querySelectorAll('[role=tab]')];
  const panels = [...demo.querySelectorAll('[role=tabpanel]')];
  const play = document.querySelector('#tour-play');
  const caption = document.querySelector('#tour-caption');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const steps = [
    {
      note: 'Give each agent a role and a piece of the project.',
      active: ['Backend', 'Interface'],
    },
    {
      note: 'Agents can address each other in the same conversation.',
      active: ['Interface', 'Reviewer'],
    },
    { note: 'Read the findings, ask for a change, decide what ships.', active: ['Backend'] },
  ];
  const duration = 8000;
  let current = 0,
    paused = reduced.matches,
    visible = false,
    finished = false;
  let timer = 0,
    started = 0,
    remaining = duration;
  function stopTimer() {
    if (timer) {
      clearTimeout(timer);
      remaining = Math.max(0, remaining - (performance.now() - started));
    }
    timer = 0;
  }
  function schedule() {
    stopTimer();
    demo.dataset.playing = String(!paused && visible && !document.hidden);
    if (paused || !visible || document.hidden) return;
    started = performance.now();
    timer = setTimeout(() => {
      timer = 0;
      if (current < 2) {
        current++;
        if (current === 2) {
          paused = true;
          finished = true;
        }
        remaining = duration;
        render();
        schedule();
      }
    }, remaining);
  }
  function render() {
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === current));
      tab.tabIndex = i === current ? 0 : -1;
      panels[i].hidden = i !== current;
    });
    for (const member of demo.querySelectorAll('[data-member]'))
      member.classList.toggle('active', steps[current].active.includes(member.dataset.member));
    caption.textContent = steps[current].note;
    play.textContent = finished ? 'Replay ↺' : paused ? 'Play ▷' : 'Pause Ⅱ';
    play.setAttribute(
      'aria-label',
      finished ? 'Replay walkthrough' : paused ? 'Play walkthrough' : 'Pause walkthrough',
    );
    demo.dataset.step = String(current);
    demo.dataset.paused = String(paused);
  }
  function choose(index, focus = false) {
    stopTimer();
    current = index;
    paused = true;
    finished = false;
    remaining = duration;
    render();
    schedule();
    if (focus) tabs[index].focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => choose(index));
    tab.addEventListener('keydown', (e) => {
      let next;
      if (e.key === 'ArrowRight') next = (index + 1) % 3;
      if (e.key === 'ArrowLeft') next = (index + 2) % 3;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = 2;
      if (next !== undefined) {
        e.preventDefault();
        choose(next, true);
      }
    });
  });
  play.addEventListener('click', () => {
    stopTimer();
    if (finished || (paused && current === 2)) {
      current = 0;
      remaining = duration;
      finished = false;
      paused = false;
    } else paused = !paused;
    render();
    schedule();
  });
  // Keyboard readers control the pacing as soon as they enter the example.
  demo.addEventListener('focusin', (e) => {
    if (e.target === play || paused) return;
    paused = true;
    render();
    schedule();
  });
  new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      schedule();
    },
    { threshold: 0.2 },
  ).observe(demo);
  document.addEventListener('visibilitychange', schedule);
  reduced.addEventListener('change', () => {
    if (reduced.matches) {
      paused = true;
      render();
      schedule();
    }
  });
  render();
  schedule();
  demo.dataset.ready = 'true';
}
