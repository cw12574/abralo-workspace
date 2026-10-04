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
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
});
const year = document.querySelector('#year');
if (year) year.textContent = String(new Date().getFullYear());
function revealDetails() {
  for (const id of ['provider-details', 'build-story'])
    if (location.hash === `#${id}`) document.getElementById(id)?.setAttribute('open', '');
}
window.addEventListener('hashchange', revealDetails);
revealDetails();
const journalButton = document.querySelector('#load-journal');
journalButton?.addEventListener('click', async () => {
  journalButton.disabled = true;
  journalButton.textContent = 'Opening the notebook…';
  try {
    const response = await fetch('/assets/city/journal.json');
    if (!response.ok) throw new Error('Notebook unavailable');
    const data = await response.json();
    const journal = document.querySelector('#journal');
    const context = document.createElement('p');
    context.className = 'journal-context';
    context.textContent = data.context;
    journal.replaceChildren(context);
    for (const entry of data.messages) {
      const article = document.createElement('article');
      article.className = 'journal-entry';
      const author = document.createElement('h4');
      const text = document.createElement('p');
      author.textContent = entry.author;
      text.textContent = entry.text;
      article.append(author, text);
      journal.append(article);
    }
    journal.hidden = false;
    journalButton.hidden = true;
  } catch {
    journalButton.textContent = 'Notebook unavailable — try again';
    journalButton.disabled = false;
  }
});
