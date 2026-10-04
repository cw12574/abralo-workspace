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
const year = document.querySelector('#year');
if (year) year.textContent = String(new Date().getFullYear());
function revealDetails() {
  if (location.hash === '#provider-details')
    document.querySelector('#provider-details')?.setAttribute('open', '');
}
window.addEventListener('hashchange', revealDetails);
revealDetails();
const video = document.querySelector('#hero-video');
if (video) {
  video.controls = false;
  const toggle = document.querySelector('#toggle-demo'),
    status = document.querySelector('#player-status');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const connection = navigator.connection;
  let visible = false,
    userPaused = false,
    userStarted = false,
    finished = false,
    playAttempt = 0;
  const chapters = [
    {
      at: 0,
      label: '01 / RESULT',
      text: 'A real monitoring service, dashboard, and incident history.',
    },
    {
      at: 6,
      label: '02 / BRIEF',
      text: 'Give the backend engineer the goal and a detailed brief.',
    },
    {
      at: 14,
      label: '03 / HANDOFF',
      text: 'The backend hands the API to the interface engineer. The interface hands off to review.',
    },
    {
      at: 26,
      label: '04 / VERIFY',
      text: 'Inspect the review, run the tests, and make the next decision.',
    },
  ];
  const autoAllowed = () => !reduced.matches && !connection?.saveData;
  video.preload = autoAllowed() ? 'metadata' : 'none';
  document.addEventListener('fullscreenchange', () => {
    video.controls = document.fullscreenElement === video;
  });
  function sync() {
    const playing = !video.paused && !video.ended;
    toggle.textContent = playing ? 'Pause Ⅱ' : finished ? 'Replay ↺' : 'Play ▶';
    toggle.setAttribute(
      'aria-label',
      playing ? 'Pause demo' : finished ? 'Replay demo' : 'Play demo',
    );
    status.textContent = playing
      ? 'Recorded demo · Playing'
      : finished
        ? 'Build complete · Inspect the source below'
        : userPaused
          ? 'Recorded demo · Paused'
          : !autoAllowed()
            ? 'Recorded demo · Press Play to watch'
            : 'Recorded demo · Press Play to watch';
  }
  async function play(explicit = false) {
    if (explicit) {
      userPaused = false;
      userStarted = true;
      if (finished) {
        video.currentTime = 0;
        finished = false;
      }
    }
    if (!explicit && (userPaused || finished || !autoAllowed() || !visible || document.hidden))
      return;
    const attempt = ++playAttempt;
    try {
      await video.play();
      if (attempt !== playAttempt || document.hidden || (!visible && !explicit) || userPaused)
        video.pause();
    } catch {
      sync();
    }
  }
  function pause() {
    ++playAttempt;
    video.pause();
    sync();
  }
  toggle.addEventListener('click', () => {
    if (!video.paused) {
      userPaused = true;
      pause();
    } else void play(true);
  });
  document.querySelector('#replay-demo').addEventListener('click', () => {
    video.currentTime = 0;
    finished = false;
    void play(true);
  });
  document.querySelectorAll('[data-chapter]').forEach((button) =>
    button.addEventListener('click', () => {
      video.currentTime = chapters[Number(button.dataset.chapter)].at;
      finished = false;
      userStarted = true;
      userPaused = true;
      pause();
      updateChapter();
    }),
  );
  function updateChapter() {
    const index = chapters.findLastIndex((chapter) => video.currentTime >= chapter.at);
    const chapter = chapters[Math.max(index, 0)];
    document.querySelector('#chapter-number').textContent = chapter.label;
    const moment = video.currentTime;
    document.querySelector('#chapter-description').textContent =
      moment >= 48
        ? 'The generated app records an outage, then recovers on a real HTTP 200 response.'
        : moment >= 42
          ? 'The operator accepts the local prototype. Docker remains untested.'
          : moment >= 34
            ? 'The backend fixes the defect. All 17 tests pass without changing the regression.'
            : moment >= 26
              ? 'The review catches a content-type bug. The operator asks for a narrow fix.'
              : moment >= 20
                ? 'The interface engineer hands the working dashboard to the reviewer.'
                : chapter.text;
    document.querySelectorAll('[data-chapter]').forEach((button, i) => {
      if (i === index) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
  }
  video.addEventListener('timeupdate', updateChapter);
  video.addEventListener('playing', sync);
  video.addEventListener('pause', sync);
  video.addEventListener('ended', () => {
    finished = true;
    sync();
  });
  video.addEventListener('error', () => {
    pause();
    status.textContent = 'Video unavailable. Read the build transcript below.';
  });
  new IntersectionObserver(
    (entries) => {
      visible = entries[0].isIntersecting;
      if (!visible) pause();
      else if (!userPaused && !finished && (autoAllowed() || userStarted)) void play(userStarted);
    },
    { threshold: 0.12 },
  ).observe(video);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
    else if (visible && !userPaused && !finished) void play(userStarted);
  });
  reduced.addEventListener('change', () => {
    if (reduced.matches && !userStarted) pause();
    else if (visible) void play();
  });
  document.querySelector('#expand-demo').addEventListener('click', async () => {
    try {
      if (video.requestFullscreen) await video.requestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else window.open('/assets/demo/build.mp4', '_blank', 'noopener');
    } catch {
      status.textContent = 'Use your browser zoom or open the full recording.';
    }
  });
  sync();
}
