# Website integration

The three agents built this example in an isolated Abralo room on 4 October 2026.
The original brief, API documentation, standalone preview, test suite and review
are preserved here. All runs used Codex. The fictional operator account was Alex.

After the agent handoffs, the launch operator integrated the model into the public
website and added optional OffscreenCanvas caching to `city-view.mjs`. This avoids
redrawing the static map on each animation frame. The renderer still falls back
to its immediate drawing path in hosts without OffscreenCanvas. The fingerprints
in `REVIEW.md` describe the original implementation, before that integration edit.

`website/city.js` is a separate accessible/responsive host: the engine begins at
45 simulated seconds using seed 20261005; the counters and cars are real model
state. Reset reproduces that morning. Playing the public demo makes no model calls.

Run the independent agent suite with `node --test tests/integration.mjs` from this
folder. Serve this directory using any static HTTP server to open `preview.html`.
The launch website has its own browser checks in `scripts/website-smoke.mjs`.

This is a small graph-and-queue toy. It is not a transport planning model or a
production-readiness benchmark. See `REVIEW.md` for exact coverage and limitations.
