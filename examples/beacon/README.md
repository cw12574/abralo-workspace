> Recorded Abralo example, 4 October 2026. Three real Codex agents built this local prototype from BRIEF.md. The reviewer found a content-type validation defect; the backend engineer fixed it without changing the regression test. The final suite passes all 17 tests. See [PROVENANCE.md](PROVENANCE.md) and [REVIEW.md](REVIEW.md), which preserves the earlier, failing review as historical evidence. Docker execution remains unverified.

# Beacon

A self-hosted, local uptime monitor using Node 24 and a vanilla browser dashboard. HTTP checks, latency, retained-check uptime, and grouped outage/recovery history are stored in a local JSON file. No npm dependencies or provider telemetry.

## Run

With Node 24 installed, run `npm start` (or `node server.mjs`) from this directory, then open http://127.0.0.1:3000. No install step is needed. Create a monitor for a service you control. The first scheduled check runs within about one second; Check now waits for and displays a real result.

Environment variables: `PORT` defaults to 3000 (0 chooses an available port), `HOST` defaults to `127.0.0.1`, and `DATA_FILE` defaults to `data/beacon.json` alongside the server. Data is written by atomic replacement after each mutation. Keep the data directory writable; run only one service process per data file. Back up the JSON file while the service is stopped. A malformed file causes startup to fail without overwriting it. SIGINT/SIGTERM stop scheduling and drain persistence.

`npm test` uses Node's built-in test runner. The test suite belongs in `tests/`. See [API.md](API.md) for the complete frontend and fixture contract, including `createMonitorServer(options)`.

## Docker

After the interface files exist in `public/`:

```sh
docker build -t beacon .
docker run --rm --name beacon -p 127.0.0.1:3000:3000 -v beacon-data:/app/data beacon
```

The container uses Node 24, runs as the node user, explicitly binds `0.0.0.0` internally, and persists data in the named volume. The published host port is restricted to loopback. `127.0.0.1` in a monitor URL inside Docker refers to the container itself; use the appropriate reachable service hostname for your own environment. Building the image requires the base image to be available locally or downloaded separately. No image has been built as part of the offline implementation.

## Scope and limits

This is an unauthenticated local developer demo. Anyone with access to the listener can read/delete data and trigger requests to any reachable HTTP/HTTPS endpoint, including private networks and metadata services (SSRF exposure). Keep it on loopback or a trusted isolated network. It is not safe for public hosting, arbitrary untrusted users, multi-tenant use, or production. No notification integrations or external telemetry exist; the only intended outbound traffic is to configured monitor targets.

Each check is a GET with a bounded timeout. Response bodies are cancelled and redirects are not followed. Status 200–399 is up. Consecutive failures form one incident, resolved by the next successful check. The scheduler checks due monitors every second and prevents overlapping requests per monitor. Latency measures time to headers/failure. Uptime is the success fraction of at most 1000 retained checks, not elapsed-time availability. At most 100 incidents per monitor and 500 monitors are retained. There is no retry threshold, distributed coordination or downtime inference while Beacon is stopped.

The server exposes only the static assets listed in API.md. Runtime state, source and documentation are not served. See API.md for request limits and error responses.
