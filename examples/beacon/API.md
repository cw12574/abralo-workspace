# Beacon API v1

Same-origin JSON API; no dependencies, authentication, CORS, or telemetry. This is a trusted local developer demo. All timestamps are UTC ISO 8601 strings; IDs are opaque UUID strings. Poll `GET /api/monitors` every 5 seconds for dashboard updates. No WebSocket is required.

## Routes

| Method | Path | Success |
| --- | --- | --- |
| GET | `/api/health` | 200 `{ "status": "ok" }` |
| GET | `/api/monitors` | 200 `{ "monitors": [Monitor] }`, creation order |
| POST | `/api/monitors` | 201 `{ "monitor": Monitor }` |
| GET | `/api/monitors/:id` | 200 `{ "monitor": Monitor, "checks": [Check], "incidents": [Incident] }` |
| POST | `/api/monitors/:id/check` | 200 `{ "monitor": Monitor, "check": Check }` after persistence |
| DELETE | `/api/monitors/:id` | 204, empty body; deletes associated history |

Create request: `Content-Type: application/json`, body up to 8192 bytes:

```json
{"name":"Local service","url":"http://127.0.0.1:8080/health","intervalSeconds":60,"timeoutMs":5000}
```

`name` is trimmed, required, 1–100 characters. `url` is required, at most 2048 characters, normalized using URL parsing, HTTP/HTTPS only, with no credentials or fragment. Local/private network targets are intentionally allowed. `intervalSeconds` is an integer 10–86400, default 60. `timeoutMs` is an integer 100–30000, default 5000. Unknown fields, strings in numeric fields, null, and arrays are rejected. At most 500 monitors can exist. No edit endpoint in v1; remove and recreate instead.

## Monitor

```json
{
  "id":"opaque-id",
  "name":"Local service",
  "url":"http://127.0.0.1:8080/health",
  "intervalSeconds":60,
  "timeoutMs":5000,
  "createdAt":"2026-10-04T15:00:00.000Z",
  "status":"unknown",
  "lastCheckedAt":null,
  "latencyMs":null,
  "statusCode":null,
  "error":null,
  "uptimePercent":null,
  "checkCount":0,
  "activeIncident":null
}
```

Status is `unknown`, `up`, or `down`. Newly created monitors are unknown until checked. The scheduler checks them on its next tick (normally within one second). `uptimePercent` is the percentage of retained checks that succeeded, rounded to two decimals, not time-weighted uptime. It is null before the first check. `checkCount` counts retained checks (maximum 1000). `latencyMs` is elapsed time to response headers or failure; bodies are cancelled, never buffered. `statusCode` is null on transport errors. `error` is null for success. `activeIncident` is null or the open Incident object.

## Check and Incident

```json
{
  "id":"opaque-check-id",
  "checkedAt":"2026-10-04T15:00:01.000Z",
  "status":"down",
  "statusCode":503,
  "latencyMs":12,
  "error":"HTTP 503"
}
```

```json
{
  "id":"opaque-incident-id",
  "monitorId":"opaque-monitor-id",
  "startedAt":"2026-10-04T15:00:01.000Z",
  "resolvedAt":null,
  "durationMs":null,
  "failureCount":1,
  "lastError":"HTTP 503"
}
```

HTTP 200–399 is up, including redirects; redirects are not followed. All other statuses, timeouts, DNS/TLS and connection failures are down. One request at a time per monitor; overlapping manual/scheduled checks share the same result. Consecutive down checks share one incident. The next up check resolves it, setting `resolvedAt` and `durationMs`. For an open incident, the UI may calculate duration from `startedAt`. A down check is a successful API operation (200) with `check.status: "down"`.

Detail arrays are newest first. Retention is the latest 1000 checks and 100 incidents per monitor. History survives restart. All successful mutations are persisted before the API responds. Removing a monitor during a check makes that check return 404; it never recreates the monitor.

## Errors

Errors are JSON `{ "error": "Human-readable message." }`. Statuses: 400 invalid JSON/input, 404 missing route/monitor/asset, 405 unsupported method, 409 monitor limit, 413 body too large, 415 wrong content type, 500 persistence/internal failure, 503 shutting down. Always test `response.ok` before using a response. DELETE success has no JSON body.

## Interface file contract

Interface owns `public/index.html`, `public/app.js`, `public/styles.css`, and optionally `public/favicon.svg`. These are the only allowed static paths (plus `/` for index). No inline scripts/styles, third-party assets, fonts, imports, or external connections: the server's content security policy allows same-origin resources. Use DOM text nodes/textContent for monitor names, URLs and errors. Show loading, empty, error and busy states; refresh list and selected history after actions.

## Test entry point

`server.mjs` exports async `createMonitorServer(options)`, returning an unbound native `http.Server`. Importing it does not listen. Options: `dataFile` (absolute or cwd-relative JSON path; default `data/beacon.json` alongside server), `scheduler` (boolean, default true), `schedulerIntervalMs` (integer >=10, default 1000). Start with `server.listen(0, '127.0.0.1')` and wait for `listening`; read assigned port from `server.address().port`. For cleanup `await server.shutdown()` aborts active checks, waits for persistence, and closes the listener. `server.close()` also stops scheduling and aborts active checks. A server instance is single-use; create a fresh instance to restart. Use a unique data path per fixture and local HTTP servers only. Corrupt persisted files fail startup rather than being overwritten. Only one process may own a data file.
