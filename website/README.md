# Abralo website

Standalone HTML, CSS and JavaScript served by a small Node server. The homepage
explains people and coding agents collaborating in shared rooms. It uses the
product's dark palette from `apps/web/src/style.css`, the same IBM Plex fonts,
the exact app icon from `apps/web/public/icon.svg`, and its seeded pixel-avatar
algorithm. Keep these aligned when the product branding changes.

Fonts are self-hosted with their included SIL Open Font Licenses. The page makes
no model calls and adds no visitor analytics or third-party font requests.

## Workflow illustration

The main room is explicitly labeled **Interactive illustration · sample messages**.
It is an explanatory HTML recreation using shortened, invented messages, not a
live agent session, product recording, or evidence of test results. The three
states explain delegation, agent-to-agent handoff and human review. A separate
link opens the actual recorded three-agent Beacon build.

The walkthrough advances after eight seconds per state, then stops on Review.
Manual tab selection pauses it. Native buttons support keyboard, pointer and
touch; arrow keys, Home and End navigate the tabs. Reduced motion starts paused.
Offscreen and hidden-tab states suspend the timer without losing remaining time.
With JavaScript disabled, the first example, explanation, navigation and downloads
remain available. The illustrated message composer is deliberately not an input.

## Connections and usage examples

The two feature panels follow the current preview implementation, checked against
`apps/service/src/workspace-tools.ts`, `connections.ts`, `usage.ts` and the
`Connections`/`Usage` components in `apps/web/src/main.tsx`. Those files match
v0.1.3-preview. The built-in connection request schema supports Railway, Stripe
and Gmail; it does not support a claim of universal service connectivity. Gmail
requires a Google OAuth client configured once per installation. Existing
connections can be granted to another employee with human approval.

The service selector is a labeled illustration. It changes names and setup notes
only and makes no network request or account mutation. The connected state is
example data. The usage card is also explicitly illustrative: 64% remaining and
100,000 tokens split 58/31/11 across three agents. The chart palette follows the
real Usage component. It does not show a customer's account or a billing total.

Allowance/reset data depends on provider reports; agent shares represent up to
500 recent workspace runs with reported tokens. Forecasts need sufficient fresh
samples and are estimates. Account allowance can be shared with other apps.

The browser smoke covers all three service choices at every viewport, keyboard
activation, correct Gmail setup disclosure, no sign-in/network side effects and
usage example semantics. Both feature panels were visually inspected at desktop
and mobile widths, including 320px. No live third-party OAuth flow was performed
as part of this website-only change.

## Run and verify

Run `npm start` in this directory, setting PORT to 4388 for the local smoke default.
From the repository root:

```sh
node scripts/website-smoke.mjs http://127.0.0.1:4388
```

The same command accepts a public origin. It checks 320, 390, 768 and 1440 CSS
pixels, including DPR 2; every workflow state, touch/click and keyboard tabs,
pause/resume, offscreen suspension, timed progression and stop/replay, reduced
motion, no-JavaScript layout, navigation, setup, asset boundaries and both archive
demos. All passed locally on 4 October 2026. Desktop/mobile screenshots and the
sharing image were inspected. A tablet overflow in the decorative team diagram
was fixed before that passing run. Physical-device, screen-reader and full
cross-browser testing remain separate.

## Read-only evidence replay

`replay.html` opens at the actual Beacon review failure, followed by the operator's
handoff, the backend fix and the final decision. It uses the current dark palette,
fonts and icon. It is a reconstructed view containing exact selected excerpts,
not a live connected workspace; no model calls or account actions are possible.
The original full transcript, recording and source remain linked.

Regenerate with `node scripts/build-beacon-replay.mjs`. The generator extracts
excerpts from the published transcript, review, source and validation files and
escapes their text. Run `node scripts/replay-smoke.mjs http://127.0.0.1:4389`
against a running website. Checks cover four widths, keyboard activation, history,
deep links, focus, no-JavaScript access and no network side effects from controls.
The fresh project generator and role instructions are documented in
`examples/beacon/TRY-IT.md`; it makes no model calls and refuses existing folders.

## Visual README and comparison demo

`demo.html` makes the recorded Little Crossing output playable as two synchronized
experiments. Both branches reuse the unchanged agent-built traffic engine and
the map with its previously documented operator cache. The launch operator added
`assets/city/experiment.mjs`, the comparison page, chart, controls and JSON export.
This is an extension of the existing recorded work, not a new multi-agent build.
The page also shows the actual app and the separate Beacon example.

The simulation starts after a deterministic 45-second warm-up. Bridge changes
affect only the experimental branch; demand changes affect both. Capacity limits
can change admitted trips, so this is a toy comparison, not a transport forecast.
The UI and exported report state the model and retained-history limits.
The model uses fixed 20Hz ticks; rendering is capped at 30fps with DPR capped at 2.
Reduced motion starts paused; offscreen and hidden-tab states suspend animation.
The Advance control provides a still-frame alternative. Static maps and evidence
remain available without JavaScript or when canvas cannot initialize.

`assets/showcase` contains actual dark-mode product captures, a 23-second edited
tour (single-play GIF and MP4), a static experiment view and detailed provenance.
The app was reopened on copies of the existing disposable demo databases, without
dispatching new agents or querying live provider allowance. Usage shows recorded
Beacon token reports. Connections shows the actual empty setup starting screen.
No fabricated messages or connected accounts were added. These files are explicitly
allowlisted by the server; the Dockerfile includes the new page and all assets.

Run `node scripts/experiment-check.mjs` and
`node scripts/demo-smoke.mjs http://127.0.0.1:4392`. The latter checks four widths,
DPR2, keyboard controls, interruption/recovery, reset, export, reduced motion,
offscreen pause, no-JavaScript fallback, assets and read-only same-origin requests.
The original independent city tests still run from `examples/little-crossing`.

## Prior examples

- `beacon.html`, `beacon.css` and `beacon.js` preserve the actual recorded developer
  demo, with video, captions, transcript and checks in `assets/demo`. Source is in
  `examples/beacon`. Three actual Codex employees built it in an isolated workspace.
- `crossing.html`, `crossing.css`, `crossing.js` and `city.js` preserve the previous
  playable traffic-town page. Its source, real room messages and review remain in
  `examples/little-crossing` and `assets/city`. That page's 14 integration tests
  passed after its renderer integration. It is no longer the main product pitch.

These real examples used Codex only. Neither establishes Claude Code or OpenCode
execution. Their original verification limits remain in the archived evidence.

## Railway

Production domains abralo.com and www.abralo.com belong to service **Service**
(`2d368d7c-59cb-4887-9531-dd46be7cb79e`), project Abralo, production environment.
The similarly named abralo-web service does not own those domains. Deploy only
this directory:

```sh
railway up ./website --path-as-root --project 411e6cdc-97ba-4f74-8f72-175697f6df9b --environment production --service 2d368d7c-59cb-4887-9531-dd46be7cb79e --detach
```

The preceding successful deployment was e9bd8b5c-cef0-4eb2-b21e-178e2bec0c97.
GitHub pushes alone do not deploy this service. Verify Railway SUCCESS, both
domains, health, browser smoke and published asset hashes after deployment.
The server binds PORT, defaulting to 8080 in Docker. Public files use an exact
allowlist; archived videos support HEAD and byte ranges. Downloads still target
v0.1.3-preview. This deployment changes the website, not the desktop release.
