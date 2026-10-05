// Progressive enhancement only. Every recorded excerpt is readable without JS.
const stages = [...document.querySelectorAll('.replay-stage')];
const links = [...document.querySelectorAll('[data-stage]')];
function showStage() {
  const stage = stages.find((s) => '#' + s.id === location.hash) || stages[0];
  for (const s of stages) s.hidden = s !== stage;
  for (const link of links) {
    if (link.dataset.stage === stage.id) link.setAttribute('aria-current', 'step');
    else link.removeAttribute('aria-current');
  }
}
for (const link of document.querySelectorAll('[data-stage], [data-step-link]')) {
  link.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const hash = link.getAttribute('href');
    if (location.hash !== hash) history.pushState(null, '', hash);
    showStage();
    if (link.hasAttribute('data-step-link')) {
      const heading = document.querySelector('.replay-stage:not([hidden]) h2');
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
      heading.scrollIntoView({ block: 'nearest' });
    }
  });
}
window.addEventListener('popstate', showStage);
window.addEventListener('hashchange', showStage);
showStage();
document.documentElement.classList.add('replay-ready');
