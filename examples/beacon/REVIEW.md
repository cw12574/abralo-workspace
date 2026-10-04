# Beacon independent review

Reviewed 4 October 2026 (Europe/London), using Node v24.16.0 on Windows. Scope: BRIEF.md, API.md, server.mjs, public/, package scripts, README and Docker configuration. Only tests/ and this report were added. No implementation changes, package installs, external requests, commits or deployment.

## Result

The core local HTTP monitoring behavior passed the integration tests. One low-severity API validation defect is reproduced and remains unfixed. The final test suite is **not green: 17 tests, 16 passed, 1 failed**. No blocker to exercising the ordinary local dashboard/API workflow was found. Browser interaction, visual/responsive behavior and Docker execution remain unverified; this is not a production-readiness assessment.

## Reproduced defect: JSON media type validation accepts a different type

- Location: `server.mjs:35`, where `readJson` uses `startsWith('application/json')`.
- Contract: API.md requires application/json and documents HTTP 415 for a wrong content type.
- Reproduction: POST `/api/monitors` with `Content-Type: application/jsonp` and body `{"name":"media type","url":"http://127.0.0.1:1"}`.
- Expected: HTTP 415 with a JSON error, without creating a monitor.
- Actual: HTTP 201; the monitor is created. The fixture uses the factory with scheduling disabled, so this URL is never contacted.
- Permanent regression: `tests/integration.test.mjs:113`, assertion at line 117. The same test first verifies that `Application/JSON; charset=utf-8` is accepted.
- Impact: the documented input media-type restriction is bypassed. Normal dashboard requests use the correct type and are unaffected. No broader exploit is claimed.
- Suggested correction: compare the case-insensitive media type before its optional semicolon parameters for exact equality with application/json. This review did not change the implementation or weaken the failing assertion.

## Executed evidence

Final command: `node --test`, working directory the project root; exit code **1**. Actual test-runner summary:

```text
tests 17
suites 0
pass 16
fail 1
cancelled 0
skipped 0
todo 0
duration_ms 2893.495

AssertionError [ERR_ASSERTION]: application/jsonp is not the documented application/json media type
201 !== 415
at tests/integration.test.mjs:117:10
```

An earlier run of the initial 15 tests passed (exit 0, duration 1990.668 ms). Two subsequent tests added explicit HTTP status boundaries and the media-type regression; the final result above supersedes that initial result. `node --check server.mjs` and `node --check public/app.js` also completed successfully with no syntax diagnostics.

The persistence-error test deliberately makes `state.json.tmp` a directory. Its expected `Beacon request failed: EISDIR: illegal operation on a directory` log was emitted; the test passed by checking HTTP 500, a useful error message and no in-memory mutation. It is not an unexpected test failure.

All service and target listeners bind to ephemeral ports on 127.0.0.1. Tests use real HTTP requests, filesystem persistence and the exported factory. Their unique data directories live beneath tests/ and are removed by cleanup. No pre-existing running demo data is used or changed.

| Area | Actual assertions and outcome |
| --- | --- |
| Factory, CRUD and errors | Unbound factory; health and empty list; trimmed name and normalized URL; default configuration and unknown/null metrics; create/list/detail/delete; deletion survives fresh server instance. Missing routes/monitors return 404; unsupported methods return 405; errors are JSON with no-store. Passed. |
| Input validation | Null/array/string/empty objects, unknown fields, empty/long/non-string names, malformed/non-HTTP/credential/fragment/oversized URLs, numeric strings/null/fractional/out-of-range values rejected without mutation. Minimum and maximum numeric settings accepted. Passed. |
| Body limits | Malformed/empty JSON gives 400; text/plain gives 415; exactly 8192 bytes accepted; 8193 bytes gives 413 for Content-Length and chunked requests; multibyte payload verifies byte rather than character counting. Passed. Media-type prefix regression failed as documented. |
| HTTP checks | Real target responses 200/299/300/399 classified up; 400/599 down; additional 204/302/404/500/503 exercised. A redirect target receives no follow-up request. A response that never finishes its body has its connection closed after headers. Passed. |
| Timeout and transport failure | Hanging target with timeoutMs 100 returns a down result with null status code and timeout error; wall-clock duration asserted between 75 and 2000 ms. Connection refusal also produces a down check. Passed. |
| Concurrency | Eight overlapping manual calls reach the target once, share a check ID and store one result. Delete during a blocked check returns 204; the check returns 404 and neither memory nor disk resurrects the monitor. Passed. |
| Scheduler | A new monitor is checked; repeated ticks and a concurrent manual check share one in-flight request; a recently completed check is not repeated. Restart with an overdue persisted timestamp triggers another scheduled check and persists it. Passed. |
| Incidents and recovery | 503 then 500 share one incident with failureCount 2 and updated lastError; 204 resolves it with matching timestamp/duration; another 404 opens a new incident. Detail arrays newest first; uptime 33.33% then 25%. Full detail survives shutdown/recreation, and the remaining outage resolves afterward. Passed. |
| Retention and limits | Seeded 1000 checks and 100 resolved incidents, then performed a real failing HTTP check. Oldest entries evicted; retained counts remain 1000/100; uptime becomes 49.9%; new open incident and persisted caps verified. Seeded 500 monitors reject an additional create with 409. Passed. |
| Persistence and shutdown | Invalid JSON refuses startup without overwrite; invalid scheduler options reject; failed write rolls back; shutdown aborts an active request with 503 and does not persist a cancelled check. Passed. |
| Static assets and CSP | All five allowlisted paths serve their documented types; HEAD is bodyless and preserves length. CSP restricts scripts/styles/connections to self and disallows frames/base URLs. Source/docs/data/dotfiles/nonallowlisted and encoded traversal paths return 404; static POST returns 405. Passed. |

## UI and documentation review

These are source-code findings, not browser interaction test results.

- **API compatibility:** `public/app.js:23` handles JSON errors and the bodyless DELETE 204. Create, detail, manual check and deletion use the documented routes and field names. History consumes newest-first arrays, and the latest 20 checks are explicitly labeled. No route or response-shape mismatch found.
- **Create/check/remove:** create trims text, validates URL protocol/credentials/fragment, converts numeric inputs and submits JSON. HTML supplies required, length, min/max and integer-step validation consistent with API.md. Busy guards disable repeated submissions/checks; actions refresh the list/history; delete requires a native confirmation dialog and removes associated displayed state.
- **Empty/loading/error/stale states:** initial loading, empty list, no checks/incidents, per-action errors and history loading/error elements exist. Refresh failures retain prior values and explicitly label them potentially stale (`app.js:84`, `app.js:106`). Request sequence counters reject outdated list/detail responses. Actual delayed-response and reconnect behavior has not been browser-tested.
- **History:** open and resolved incidents show start/recovery, duration, failure count and last error. Unknown status and null metrics are handled. Uptime is correctly described as a fraction of retained checks rather than time-weighted availability.
- **Keyboard/dialog focus:** native buttons, labels and dialog elements are used. Create explicitly focuses name; delete gives autofocus to Keep monitor; Escape cancellation is blocked only during pending mutations. History open focuses its heading and close returns focus to the row action; successful removal focuses Add monitor. Visible focus styling and a skip link are present. Native focus trapping/restoration and keyboard-only completion remain untested in a browser.
- **Mobile layout:** CSS has 900 px and 580 px breakpoints, stacked history/form layouts, a two-column small-screen metric grid and a viewport-bounded scrolling dialog. The monitor table intentionally retains a 930 px minimum width inside a keyboard-focusable horizontal scrolling region. Actual clipping, scrolling, zoom, contrast and touch usability have not been visually verified.
- **Safe rendering:** monitor names, URLs, HTTP errors and incident text are inserted through textContent/created elements, including dialog messages. No user text is interpolated into HTML. The supplied HTML loads same-origin script/style/favicon resources and uses no inline executable handlers. API values drive the supported status badges.
- **Local scope:** README documents authentication absence, private-network/SSRF exposure, single-process data ownership, telemetry absence and retained-check uptime. Dockerfile uses Node 24, a non-root user, a data volume and an explicit container bind address. README publishes the host port on loopback. Docker configuration was read, not executed.

## Limitations and remaining verification

- No real browser was exercised. UI conclusions above are limited to source inspection and HTTP asset/CSP checks; no visual, accessibility or end-to-end browser pass is claimed.
- `Get-Command docker -ErrorAction SilentlyContinue` returned no command. No image build, container startup, healthcheck or volume-restart test was possible locally. No download was attempted.
- Restart tests shut down and recreate the exported server in one Node process against the same data file. They do not simulate abrupt process termination, machine failure or concurrent processes owning one file.
- Retention/cap tests seed boundary data to keep the suite fast, then test actual HTTP mutations across those boundaries. They do not generate 1000 checks/100 incidents/500 monitors through public create/check calls. Scheduler interval eligibility after restart uses an aged timestamp; no ten-second wall-clock interval test is claimed.
- Fixtures cover local HTTP, not HTTPS certificate validation, DNS behavior, external endpoints, long-duration load or the full set of malformed persisted object schemas.

Reviewed service SHA-256: `D5858C0F7AF2702AE7446A322CF69E3D30C4CB6991AC3C1D70C25F1250426B1D`. Reviewed UI script SHA-256: `8D525543E99FA2AAE158F8914F3B25FA26425996D027239899E895B968188E3E`.
