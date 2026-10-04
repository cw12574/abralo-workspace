# The Little Crossing

A dependency-free browser traffic toy with a seeded simulation, three closable bridges and actual routing and queues. Built as a small illustrative city, not a transport-engineering model.

## Run locally

From this directory, start a local static server with an installed Python:

```sh
python -m http.server 8000 --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/preview.html`. ES modules require serving the page over HTTP rather than opening it as a file. No package install, external assets or backend are required.

## Checks

With Node.js installed, run the integration suite:

```sh
npm test
```

This executes `node --test tests/*.mjs`. All 14 tests passed after website integration. See [API.md](API.md) for the model contract, [REVIEW.md](REVIEW.md) for the original review and [INTEGRATION.md](INTEGRATION.md) for subsequent operator changes and verification boundaries.

## Files

- `city-engine.mjs`: deterministic state, routing, traffic and bridge controls.
- `city-view.mjs`: canvas drawing and bridge hit testing.
- `preview.html`: standalone host, controls and animation loop.
- `API.md`: public engine contract and model limits.
- `tests/*.mjs` and `REVIEW.md`: integration checks and findings.

The engine can be embedded independently using `createCity()`, `step(seconds)` and `snapshot()`. Each instance is isolated; reset reproduces its original seed and settings. The public-site operator integrated and polished the website; that contribution is documented in INTEGRATION.md.
