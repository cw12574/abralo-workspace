# Beacon: local uptime monitor
Build a small working product, not a mockup. Node 24, no third-party dependencies, vanilla browser UI.
The service checks HTTP/HTTPS endpoints periodically, stores checks and incident history in a local JSON file, and shows a dashboard.
Required UI: monitor list with current status, latency, last check and uptime percentage; create a monitor; check now; remove a monitor; inspect outage/recovery history.
Required backend: bounded HTTP timeout, cancel response bodies, one in-flight check per monitor, validate URLs and inputs, cap retained history, persist mutations, static file allowlist, limit JSON bodies, useful errors.
Choose and document a stable JSON API in API.md before handing off the frontend. Export createMonitorServer(options) for tests; importing must not listen. Allow port 0, configurable data file, configurable scheduler in tests. Default host 127.0.0.1; Docker may bind 0.0.0.0 explicitly.
A checks result outside 200-399 is down. Group consecutive failures into one incident, resolve on recovery.
Use package.json scripts: start (node server.mjs), test (node --test). Provide README.md, Dockerfile, .dockerignore.
This is a LOCAL developer demo without authentication. Never claim it is safe for public hosting, multi-tenant use, arbitrary untrusted users, or production readiness. Document SSRF/private-network exposure and no provider telemetry.
Work only in this folder. Do not install packages, browse, deploy, contact people, or read outside this directory. Local test HTTP fixtures are permitted.
Role file ownership: Backend engineer owns root service/package/API/docs/Docker; Interface engineer owns public/; Reviewer owns tests/ and REVIEW.md.
