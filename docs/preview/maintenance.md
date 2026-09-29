# Updating Abralo from Abralo

The installed launcher and a short-lived independent helper handle restart. The agent can finish its reply and exit; it does not need to remain alive to start the replacement service. There is no resident updater service or added dependency.

This machinery must first be included in an installed release. Building these files does not enable it in an older running installation. Installing that first release and restarting the live app are separate actions.

## Normal workflow

1. Make and check the change in source. Run `pnpm build` and package a fresh release using the existing packaging workflow. Never edit a running version in place.
2. Stage that local package with `node scripts/stage-update.mjs PACKAGED_RELEASE INSTALL_ROOT`. This copies a new version and prints its `candidateRoot`; it does not select or run it.
3. From the agent conversation, call `workspace_maintenance` with `action: "prepare"` and the candidate path. Omit `candidateRoot` for a restart of the same build. Preparation validates the release and records a job without stopping anything.
4. Only when the human requests applying it, call `action: "execute"` with the prepared `jobId`. The tool uses the existing owner approval card. After approval and a successful handoff response, finish the agent turn so maintenance can proceed. Do not wait in that turn for restart to finish.
5. After reconnecting, `action: "status"` returns the saved result. Owner-authenticated `/api/maintenance`, `/api/maintenance/prepare`, and `/api/maintenance/execute` endpoints expose the same controller for local clients; mutation requests require the normal request header.

## What happens during handoff

The app starts a detached helper and waits for its readiness acknowledgement before considering shutdown. New agent dispatch and scheduled work pause; active work finishes normally. Messages received during draining remain queued. Once work is idle, mutations briefly return a retryable error while the app creates and checks a SQLite backup.

The helper waits for the old process to exit, starts the prepared version, and verifies its product, build, workspace identity, and maintenance job through the health endpoint. It then atomically updates `current.txt`. Only after this succeeds does the new service release queued work. Shortcuts use a stable launcher that follows this selection.

Preparation and execution check platform, protocol, required release files, the data compatibility declaration, and fingerprints of application code and runtime. Dependencies must be supplied by the trusted local package and left unchanged; they are not recursively fingerprinted. This is local release validation, not package signing or an external update channel.

## Failures and recovery

- Busy work has ten minutes to finish. A timeout leaves the original app running; the helper never kills its agent processes. A helper that fails before acknowledging readiness also leaves the original app running.
- A new service has sixty seconds to become healthy. If startup fails, the helper can start the previous build only when its fingerprint is intact, both builds declare the same data compatibility, and the database passes integrity and unchanged-schema checks.
- Automatic fallback switches code only. It never restores an older database over newer messages.
- If compatibility cannot be established, or the helper disappears after shutdown, retain the saved job, backup, and maintenance lock for inspection. The stable launcher refuses to start blindly while the lock exists. Power loss and hardware failure can still require recovery.

Each job lives in `DATA_DIRECTORY/maintenance/JOB_ID/`, with `job.json`, `helper.log`, `service.log`, and (after draining) a verified `workspace.db` backup. `latest.json` identifies the most recent job; `active.json` prevents a second handoff. States include `prepared`, `armed`, `draining`, `stopping`, `starting`, `succeeded`, `rolled-back`, and `failed`. Status reports a stranded acknowledged helper as `recovery-required`.

For manual recovery, first establish that no helper or service is still running for this data directory and inspect the job and logs. Preserve a copy of the current data before deciding which build can read it. Resolve compatibility or repair the candidate before removing a stale lock and launching the chosen build. Do not delete a lock to bypass an active update. Backups contain private workspace data and should remain local.

Keep the prior versions and the runtime referenced by the installed shortcut scripts. This first implementation intentionally has no automatic release or backup cleanup.

## Release compatibility and validation

`release.json` declares `maintenanceProtocol: 1` and `dataCompatibility: "workspace-v1"`. Change the compatibility identifier whenever an update changes stored data semantics in a way an older build cannot safely read. Such updates need a separate migration procedure. An unchanged SQL schema alone does not prove semantic compatibility.

Windows process handoff is covered by `node scripts/maintenance-smoke.mjs` after building. It uses temporary installations, a fixture database and a separate loopback port, makes no provider calls, and never installs into the live app. Unit tests in `tests/maintenance.test.ts` cover queuing, active and inflight work, interrupted helper startup, changed releases, and incompatible data formats. macOS/Linux installer support is present but has not been exercised on those operating systems in this change.
