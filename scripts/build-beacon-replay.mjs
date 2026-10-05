// Build a static, inspectable replay from already-published evidence. No model calls.
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { format } from 'prettier';
const read = (path) =>
  readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const transcript = read('website/assets/demo/build-transcript.txt');
const review = read('examples/beacon/REVIEW.md');
const source = read('examples/beacon/server.mjs');
const validation = read('website/assets/demo/validation.txt');
const brief = read('examples/beacon/BRIEF.md');
const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function excerpt(start, end) {
  const at = transcript.indexOf(start);
  assert.ok(at >= 0, 'Missing recorded excerpt: ' + start);
  const until = transcript.indexOf(end, at);
  assert.ok(until > at, 'Missing excerpt boundary: ' + end);
  return transcript.slice(at, until).trim();
}
const finding = excerpt('The validation check reproduced a defect:', '\n\n\nReview complete;');
const request = excerpt(
  '@Backend engineer the Reviewer reproduced',
  '\n\n2026-10-04T16:09:15.272Z',
);
const fixed = excerpt(
  'Fixed server.mjs: Content-Type now compares',
  '\n\n2026-10-04T16:10:24.913Z',
);
const decision = excerpt('Decision: accept this as a local developer demo.', '\n\n--- OUTCOME ---');
const regression = review.match(
  /AssertionError \[ERR_ASSERTION\]:[^]*?at tests\/integration\.test\.mjs:117:10/,
)[0];
const corrected = source
  .split('\n')
  .filter((line) => /const mediaType =|if \(mediaType !==/.test(line))
  .join('\n')
  .trim();
const passing = validation
  .split('\n')
  .filter((line) =>
    /JSON content type|^# (tests|pass|fail)|^ℹ (tests|pass|fail)|^Exit code:/.test(line),
  )
  .join('\n');
assert.match(corrected, /mediaType !== 'application\/json'/);
assert.match(passing, /Exit code: 0/);
const link = (path, label) => `<a href="${path}">${label} ↗</a>`;
const github = 'https://github.com/cw12574/abralo-workspace/blob/main/';
const message = (who, label, text, role) =>
  `<article class="recorded-message"><span class="replay-avatar ${role}" aria-hidden="true">${role === 'human' ? 'A' : '▦'}</span><div><div class="message-byline"><strong>${who}</strong><span>${label}</span></div><blockquote>${esc(text)}</blockquote></div></article>`;
const artifact = (name, explanation, body, path) =>
  `<aside class="replay-artifact"><div class="artifact-label">${name}</div><p>${explanation}</p><pre tabindex="0"><code>${esc(body)}</code></pre>${link(path, 'Read the original')}</aside>`;
const stages = [
  {
    id: 'defect',
    short: 'The review',
    title: 'An agent found the bug.',
    meta: '16 passed · 1 failed',
    kind: 'failure',
    intro:
      'Three agents built Beacon, a local uptime monitor. The independent review caught an API contract defect. Start here, then follow the handoff.',
    message: message('Reviewer', 'Exact excerpt · collected review message', finding, 'reviewer'),
    artifact: artifact(
      'tests / media-type regression',
      'The API promised HTTP 415. The test received 201. This is the original, pre-fix failure.',
      regression,
      github + 'examples/beacon/REVIEW.md',
    ),
  },
  {
    id: 'handoff',
    short: 'The handoff',
    title: 'The human kept the fix focused.',
    meta: 'Operator → Backend engineer',
    kind: '',
    intro:
      'The operator addressed the backend agent in the same room, preserving the reviewer’s failing test and the scope of the task.',
    message: message('Alex', 'Operator · 16:09:15 UTC', request, 'human'),
    artifact: artifact(
      'BRIEF.md / role boundaries',
      'The original brief assigned the implementation and independent tests to different agents.',
      brief
        .split('\n')
        .filter((line) => line.startsWith('Role file ownership:'))
        .join('\n'),
      github + 'examples/beacon/BRIEF.md',
    ),
  },
  {
    id: 'fix',
    short: 'The correction',
    title: 'The code changed. The test stayed.',
    meta: '17 passed · 0 failed',
    kind: 'success',
    intro:
      'The backend agent reported the narrow fix and reran the unchanged regression. The source below is the published implementation, not a simulated diff.',
    message: message('Backend engineer', 'Recorded message · 16:10:12 UTC', fixed, 'backend'),
    artifact: artifact(
      'server.mjs / corrected check',
      'Compare the normalized media type exactly; allow optional parameters. The recorded review documents the earlier prefix match.',
      corrected,
      github + 'examples/beacon/server.mjs#L35',
    ),
  },
  {
    id: 'result',
    short: 'Human review',
    title: 'A result you can inspect.',
    meta: 'Accepted as a local demo',
    kind: 'success',
    intro:
      'The operator independently checked the result. The preserved review still records its earlier failure; the provenance explains the later fix and validation.',
    message: message('Alex', 'Operator · 16:11:56 UTC', decision, 'human'),
    artifact: artifact(
      'validation.txt / final run',
      'Actual saved output from the published example. This is not a live test runner.',
      passing,
      '/assets/demo/validation.txt',
    ),
  },
];
const navigation = stages
  .map(
    (s, i) =>
      `<a href="#${s.id}" data-stage="${s.id}"><span class="stage-number">0${i + 1}</span><span>${s.short}</span></a>`,
  )
  .join('\n');
const panels = stages
  .map(
    (s, i) =>
      `<section class="replay-stage" id="${s.id}" aria-labelledby="${s.id}-title"><div class="stage-heading"><p class="eyebrow">0${i + 1} / RECORDED BUILD 001</p><h2 id="${s.id}-title">${s.title}</h2><p>${s.intro}</p><span class="evidence-state ${s.kind}">${s.meta}</span></div><div class="stage-columns"><div class="room-message">${s.message}<p class="read-only-label">Recorded messages · No connected account</p></div>${s.artifact}</div><div class="stage-footer">${i ? `<a href="#${stages[i - 1].id}" data-step-link>← ${stages[i - 1].short}</a>` : '<span>Follow the evidence →</span>'}${i < 3 ? `<a href="#${stages[i + 1].id}" data-step-link>${stages[i + 1].short} →</a>` : '<a href="/start.html">Try Abralo ↗</a>'}</div></section>`,
  )
  .join('\n');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#1c1e22"><title>Abralo — Inside a real agent handoff</title><meta name="description" content="Inspect a real three-agent build: the review, a failing test, the handoff, and the verified fix. No account required."><link rel="canonical" href="https://abralo.com/replay.html"><meta property="og:title" content="Abralo — Inside a real agent handoff"><meta property="og:description" content="The reviewer found a bug. Follow the handoff and inspect the fix."><meta property="og:url" content="https://abralo.com/replay.html"><meta property="og:image" content="https://abralo.com/social-card.png"><link rel="icon" href="/mark.svg" type="image/svg+xml"><link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/replay.css"><script src="/replay.js" defer></script></head>
<body><a class="skip-link" href="#main">Skip to content</a><header class="site-header wrap"><a class="brand" href="/"><img src="/mark.svg" width="32" height="32" alt="">Abralo</a><a href="/start.html">Get the preview ↗</a></header>
<main id="main" class="replay-wrap wrap"><div class="replay-intro"><div><p class="eyebrow">PEOPLE ↔ AGENTS ↔ AGENTS</p><h1>Inside a real handoff.</h1></div><p>Read-only replay · 4 October 2026<br>Three Codex agents. No sign-in needed.</p></div>
<div class="replay-shell"><aside class="replay-sidebar"><div class="room-name"><span aria-hidden="true">▦</span> Beacon <small>Shared project room</small></div><nav aria-label="Recorded build chapters">${navigation}</nav><div class="room-team"><p class="eyebrow">IN THIS ROOM</p><p>Alex <small>Operator</small></p><p>Backend engineer</p><p>Interface engineer</p><p>Reviewer</p></div></aside><div class="replay-content">${panels}</div></div>
<section class="replay-source" aria-label="Evidence and next steps"><div><h2>Try the workflow yourself.</h2><p>Start from the same brief in a fresh folder. Give each agent a role, keep the handoffs in one room, and review the result.</p>${link(github + 'examples/beacon/TRY-IT.md', 'Reproduce this workflow')}</div><div><h2>Inspect the whole build.</h2><p>Selected excerpts from actual messages, presented in a reconstructed view. Alex is a fictional operator directed by launch automation, not a customer. Streamed replies were collected; their displayed order can differ from progress timing.</p><div class="evidence-links">${link('/assets/demo/build-transcript.txt', 'Full transcript')}${link('/beacon.html', 'Original recording')}${link(github + 'examples/beacon/PROVENANCE.md', 'Provenance')}</div></div></section>
<details class="replay-brief"><summary>Read the original brief</summary><pre>${esc(brief)}</pre></details><p class="replay-limits">The result is a local developer prototype, not a production service or speed benchmark. Docker was not run. This page makes no model calls and cannot send messages, execute code or connect an account.</p></main><footer class="site-footer wrap"><a class="brand" href="/">Abralo</a><a href="https://github.com/cw12574/abralo-workspace">Source on GitHub ↗</a></footer></body></html>`;
writeFileSync(
  new URL('../website/replay.html', import.meta.url),
  await format(html, { parser: 'html', printWidth: 100 }),
);
console.log('Built replay.html from exact published excerpts and source.');
