# Recorded build provenance

This example was produced in a disposable Abralo workspace on 4 October 2026, with fictional operator Alex and three real Codex agents. The project started with BRIEF.md only. Backend engineer built the service and API contract, Interface engineer built public/, and Reviewer added independent integration tests. The operator followed up on an actual review defect, and Backend engineer fixed the media-type check. All 17 final tests pass on Node 24.16.0 / Windows.

The original review is preserved in REVIEW.md. Its 16-pass/1-fail result and unverified-browser statement describe the review at that time. Later operator verification exercised the actual UI in Chromium at 320/390/768/1440px: create/check/delete, grouped outage and recovery passed with controlled loopback fixtures and no uncaught JavaScript errors. This does not establish full accessibility, production security, cross-platform runtime behavior or load capacity. Docker was unavailable and has not been built or run.

Publication changes: the test file was renamed from tests/integration.test.mjs to tests/integration.mjs, and package.json explicitly targets it, to keep this standalone Node suite separate from Abralo's Vitest discovery. Test contents and implementation are unchanged from the final agent-produced files, apart from removing an extra trailing blank line in public/styles.css. README received this provenance introduction; PROVENANCE.md is maintainer-written. REVIEW.md references the original filename. Runtime data and local absolute paths are not included.

Run with Node 24: npm test, then npm start. No npm install is needed. Keep this unauthenticated service on loopback and use only trusted targets. See README for SSRF/private-network and single-process storage limits.

Watch the edited demonstration, read exact room messages and validation output, or download the full room recording at https://abralo.com/#walkthrough. The completed app was recorded separately against real local fixture servers. The highlight edit omits waits; the full room recording runs at normal speed. All agents used Codex; this is not a mixed-provider or speed benchmark.
