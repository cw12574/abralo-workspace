# Abralo website

Standalone HTML, CSS and JavaScript served by a small Node server. The website runs separately from the desktop application. IBM Plex fonts are self-hosted under the included SIL Open Font Licenses. No visitor analytics or external font requests are added.

## Run and verify

From this directory: npm start. From the repository root with the site running on port 4387:

```sh
node scripts/website-smoke.mjs http://127.0.0.1:4387
```

The same smoke accepts a public origin. It checks responsive layouts, above-fold autoplay, pause/resume, off-screen suspension, chapter seeking, replay/end state, captions, reduced-motion preferences, navigation, public file boundaries and byte-range delivery. Inspect desktop and mobile captures visually as well. Human comprehension and first-install tests remain separate.

## Recorded build provenance

Captured on 4 October 2026 in the real Abralo application, using an isolated disposable workspace, fictional operator Alex, and three actual Codex agents. The starting project contained only BRIEF.md. The backend engineer implemented the service and handed its API contract to the interface engineer; the interface engineer implemented the dashboard and handed it to the reviewer. The reviewer added and ran permanent integration tests. Exact room messages and operator decisions are in assets/demo/build-transcript.txt.

The resulting source is in ../examples/beacon. The displayed monitors use controlled local HTTP fixture servers; statuses, checks and incident records were produced by real requests. There is no customer data and no live provider invocation in the visitor's browser. This sample demonstrates a local developer prototype, not production readiness or a speed benchmark. All agent runs used Codex; this is not evidence of a Claude or OpenCode run.

assets/demo/build.mp4 is an edited highlight recording. It opens on the completed app, then shows the brief, handoffs, and review before returning to the app. Waiting intervals are omitted; the room clips themselves run at normal speed. assets/demo/full-build.mp4 preserves the full room capture at normal speed, including waiting. The product capture was recorded separately during browser verification. See validation.txt for actual checks and explicit limitations, including Docker verification status.

Muted inline playback starts when the video is visible, with pause, replay, chapters and fullscreen controls. Reduced-motion and save-data preferences disable automatic playback. Browser autoplay rejection falls back to Play. Playback pauses off-screen or when the tab is hidden, and does not loop. A native video control fallback remains when JavaScript is disabled. Readable captions and a text transcript are available.

## Railway

Production domains abralo.com and www.abralo.com belong to service Service (2d368d7c-59cb-4887-9531-dd46be7cb79e), project Abralo, production environment. The similarly named abralo-web service does not own these domains. Deploy only this directory:

```sh
railway up ./website --path-as-root --project 411e6cdc-97ba-4f74-8f72-175697f6df9b --environment production --service 2d368d7c-59cb-4887-9531-dd46be7cb79e --detach
```

The preceding successful deployment was 4f17e564-b5ae-4fca-92ba-42f35b82eba5. GitHub pushes alone do not deploy this service. Check Railway SUCCESS, both domains, /health, smoke checks and matching asset hashes after deploying. The server binds Railway PORT; the Dockerfile uses port 8080.

Public files use an exact allowlist. Video responses support HEAD and byte ranges. Railway may reject raw malformed percent escapes at its edge; public checks use /%25. Release and setup links currently target v0.1.3-preview; keep them aligned for later releases.
