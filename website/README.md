# Abralo website

Standalone HTML, CSS and JavaScript served by a small Node server. The website runs
separately from the desktop application. IBM Plex fonts are self-hosted under their
included SIL Open Font Licenses. No visitor analytics or external font requests.

## Run and verify

From this directory: `npm start`. With the site on port 4387, run from the repo root:

```sh
node scripts/website-smoke.mjs http://127.0.0.1:4387
node --test examples/little-crossing/tests/integration.mjs
```

The smoke also accepts a public origin. It checks widths 320, 390, 768 and 1440,
including DPR 2; actual canvas motion, pause, keyboard/touch bridge controls, rush
hour, deterministic reset, offscreen suspension, notebook loading, navigation,
setup layout, reduced motion, module-failure and no-JavaScript fallbacks, the
Beacon archive, asset boundaries and byte ranges. Inspect screenshots as well.
Both commands passed locally on 4 October 2026. The engine suite has 14 tests.
Physical-device, screen-reader and cross-browser verification remain separate.

## The Little Crossing

The illustration is a playable graph-and-queue traffic toy. The engine, drawing
and independent integration suite were built by three actual Codex employees in
an isolated Abralo room on 4 October 2026. The initial folder contained BRIEF.md.
The launch operator supplied that brief, then integrated and polished the website.
Alex is the fictional account used to operate the recorded workspace.

The engine handles seeded trips, shortest open paths, bridge closures, lane gaps,
simple junction admission and bounded active traffic. Counters reflect that model.
The site starts at 45 simulated seconds with seed 20261005; reset reproduces it.
This is a toy, not a transport planning model or a production-readiness benchmark.
Playing the town makes no model calls. All three agents used Codex; no claim is
made here about a Claude Code or OpenCode demonstration.

The exact room messages are in `assets/city/journal.json`. Original brief and agent
review are `brief.txt` and `review.txt`. Local paths are replaced with a placeholder
in the journal. No workspace database or credentials are shipped. `room.webp` is
an actual application screenshot. The source is in `../examples/little-crossing`.

`city.js` adds accessible button equivalents, motion preferences, responsive DPR,
offscreen/hidden-tab lifecycle and failure fallback. The operator also added an
optional OffscreenCanvas cache to the drawing. The agent review fingerprints
precede that edit; the complete published example passed the suite afterward.
See `assets/city/validation.txt` for coverage and limitations. The original native
build capture remains local; the homepage presents the actual playable result.

## Beacon archive

`beacon.html` preserves the previous technical homepage and its 56-second edited
recording, full recording, captions and transcript under `assets/demo`. That
separate example was also built by three real Codex employees in an isolated
workspace. Its controlled HTTP fixtures, source and review are in `../examples/beacon`.
The edited video omits waiting intervals; the full capture retains them. Its
validation notes and limitations remain available alongside the recording.

## Railway

Production domains abralo.com and www.abralo.com belong to service **Service**
(`2d368d7c-59cb-4887-9531-dd46be7cb79e`), project Abralo, production environment.
The similarly named abralo-web service does not own these domains. Deploy only
this directory:

```sh
railway up ./website --path-as-root --project 411e6cdc-97ba-4f74-8f72-175697f6df9b --environment production --service 2d368d7c-59cb-4887-9531-dd46be7cb79e --detach
```

The preceding successful deployment was fd18b103-64b4-43c8-b64f-e269dd3386f9.
GitHub pushes alone do not deploy this service. Verify Railway SUCCESS, both
domains, /health, smoke checks and matching asset hashes. The server binds PORT;
the Dockerfile defaults to 8080. Public files use exact allowlists; ES modules have
JavaScript MIME types. Video supports HEAD and byte ranges. The setup guide and
desktop downloads remain on v0.1.3-preview. This is a website deployment, not a new
desktop release.
