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
navigation?.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
});
const year = document.querySelector('#year');
if (year) year.textContent = String(new Date().getFullYear());

const steps = [
  {
    counter: '01 / THE BRIEF',
    title: 'One room. A clear job for each agent.',
    description:
      'Ask the code reviewer to check the free-shipping boundary and the docs reviewer to compare the README with the implementation.',
    fact: 'Both reviewers use Codex in this recording. The shop and its files are sample data.',
    image: 'brief',
    alt: 'Actual Abralo application with a review brief addressed to two agents',
    next: 'See what they found →',
  },
  {
    counter: '02 / THE FINDINGS',
    title: 'Two checks. Two concrete problems.',
    description:
      'At exactly £50, the code charges £4.99 instead of offering free shipping. The README also lists a different standard shipping price: £3.99.',
    fact: 'These findings came from live Codex runs in Abralo. Open the transcript below for the exact responses.',
    image: 'findings',
    alt: 'Actual Abralo application showing both agents’ completed review findings',
    next: 'See the decision →',
  },
  {
    counter: '03 / THE DECISION',
    title: 'You decide what ships.',
    description:
      'Hold the release. Fix the boundary condition and confirm the shipping price before updating the README. The brief, findings, and decision remain in the same room.',
    fact: 'The review was read-only: no project files were changed. The final decision was entered by the person operating the demonstration.',
    image: 'decision',
    alt: 'Actual Abralo application showing the operator’s decision after reviewing the agent findings',
    next: 'Back to the brief ↺',
  },
];
let currentStep = 0;
const tabs = [...document.querySelectorAll('[data-step]')];
function showStep(index, focus = false) {
  if (!tabs.length) return;
  currentStep = (index + steps.length) % steps.length;
  const step = steps[currentStep];
  tabs.forEach((tab, i) => {
    tab.setAttribute('aria-selected', String(i === currentStep));
    tab.tabIndex = i === currentStep ? 0 : -1;
  });
  document.querySelector('#demo-panel').setAttribute('aria-labelledby', 'step-tab-' + currentStep);
  for (const [id, value] of Object.entries({
    'demo-counter': step.counter,
    'demo-title': step.title,
    'demo-description': step.description,
    'demo-fact': step.fact,
    'next-step': step.next,
  }))
    document.getElementById(id).textContent = value;
  const img = document.querySelector('#demo-image');
  img.src = '/assets/demo/' + step.image + '.webp';
  img.alt = step.alt;
  if (focus) tabs[currentStep].focus();
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => showStep(index));
  tab.addEventListener('keydown', (event) => {
    let target;
    if (event.key === 'ArrowRight') target = currentStep + 1;
    if (event.key === 'ArrowLeft') target = currentStep - 1;
    if (event.key === 'Home') target = 0;
    if (event.key === 'End') target = steps.length - 1;
    if (target !== undefined) {
      event.preventDefault();
      showStep(target, true);
    }
  });
});
document.querySelector('#next-step')?.addEventListener('click', () => showStep(currentStep + 1));
document.querySelector('#open-capture')?.addEventListener('click', () => {
  const dialog = document.querySelector('#capture-dialog');
  const image = dialog.querySelector('img');
  image.src = document.querySelector('#demo-image').src;
  image.alt = steps[currentStep].alt;
  dialog.showModal();
});
document
  .querySelector('#open-video')
  ?.addEventListener('click', () => document.querySelector('#video-dialog').showModal());
document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.querySelector('.dialog-close')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        dialog.close();
    }
  });
  dialog.addEventListener('close', () => dialog.querySelector('video')?.pause());
});
document.querySelector('#share-demo')?.addEventListener('click', async () => {
  const status = document.querySelector('#share-status');
  try {
    await navigator.clipboard.writeText('https://abralo.com/#walkthrough');
    status.textContent = 'Link copied.';
  } catch {
    status.textContent = 'Copy this address: https://abralo.com/#walkthrough';
  }
});
function revealDetails() {
  if (location.hash === '#provider-details')
    document.querySelector('#provider-details')?.setAttribute('open', '');
}
window.addEventListener('hashchange', revealDetails);
revealDetails();
if (document.querySelector('#findings-text')) {
  fetch('/assets/demo/responses.json')
    .then((r) => {
      if (!r.ok) throw Error('Transcript unavailable');
      return r.json();
    })
    .then((data) => {
      const target = document.querySelector('#findings-text');
      target.replaceChildren();
      data.results.forEach((result) => {
        const article = document.createElement('article');
        const h = document.createElement('h3');
        h.textContent = result.agent + ' · Codex';
        const p = document.createElement('p');
        p.textContent = result.text;
        article.append(h, p);
        target.append(article);
      });
    })
    .catch(() => {});
}
