const stage = document.querySelector('#graph-stage');
const form = document.querySelector('#waitlist-form');
const note = document.querySelector('#form-note');
const submitButton = form?.querySelector('button[type="submit"]');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (reducedMotion) stage?.querySelector('svg.flow-lines')?.pauseAnimations();

if (stage && !reducedMotion && window.matchMedia('(pointer: fine)').matches) {
  stage.addEventListener('pointermove', (event) => {
    const bounds = stage.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * 100;
    const y = ((event.clientY - bounds.top) / bounds.height) * 100;
    stage.style.setProperty('--pointer-x', `${x}%`);
    stage.style.setProperty('--pointer-y', `${y}%`);
  });
  stage.addEventListener('pointerleave', () => {
    stage.style.removeProperty('--pointer-x');
    stage.style.removeProperty('--pointer-y');
  });
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  if (note) note.textContent = 'Sending...';
  if (submitButton) submitButton.disabled = true;

  try {
    const response = await fetch(form.action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: new FormData(form).get('email') }),
    });
    if (!response.ok) throw new Error('Early-access request failed');
    form.reset();
    if (note) note.textContent = 'Thanks. Your request has been sent to Chris at Abralo.';
  } catch {
    if (note) note.textContent = "Sorry, we couldn't send that just now. Please try again.";
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});
