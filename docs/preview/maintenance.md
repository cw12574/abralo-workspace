# Updating Abralo from Abralo

The installed launcher and a short-lived independent helper handle restart. The agent can finish its reply and exit; it does not need to remain alive to start the replacement service. There is no resident updater service or added dependency.

This machinery must first be included in an installed release. Building these files does not enable it in an older running installation. Installing that first release and restarting the live app are separate actions.

## Normal workflow

1. Make and check the change in source. Run `pnpm build` and package a fresh release using the existing packaging workflow. Never edit a running version in place.
2. Stage that local package with `node scripts/stage-update.mjs PACKAGED_RELEASE INSTALL_ROOT`. This copies a new version and prints its `candidateRoot`; it does not select or run it.
3. From the agent conversation, call `workspace_maintenance` with `action: "prepare"` and the candidate path. Omit `candidateRoot` for a restart of the same build. Preparation validates the release and records a job without stopping anything.
4. Only when the human requests applying it, call `action: "execute"` with the prepared `jobId`. The tool returns a durable owner approval card immediately. The agent may finish its turn while approval is pending; the card has no time limit and survives service restarts. Clicking Allow revalidates the saved build and workspace before starting the helper. Do not wait in an active turn for restart to finish.
5. After reconnecting, `action: "status"` returns the saved result. Owner-authenticated `/api/maintenance`, `/api/maintenance/prepare`, and `/api/maintenance/execute` endpoints expose the same controller for local clients; mutation requests require the normal request header.

## What happens during handoff

Approval durably queues the update and immediately pauses new agent dispatch and scheduled work. Active work finishes normally; the queue has no idle deadline. Messages received during draining remain queued. The app starts a detached helper and waits for its readiness acknowledgement before considering shutdown. At the first idle point, mutations briefly return a retryable error while the app creates and checks a SQLite backup.

The helper waits for the old process to exit, starts the prepared version, and verifies its product, build, workspace identity, and maintenance job through the health endpoint. It then atomically updates `current.txt`. Only after this succeeds does the new service release queued work. Shortcuts use a stable launcher that follows this selection.

Windows sign-in scripts resolve the runtime from `current.txt` each time, rather than retaining a path into the first installed version. Successful handoffs also refresh the background script so existing installations receive this repair. Shortcut working directories belong to the stable installation root.

Repeated approval attempts for an already-started maintenance job return its saved status without starting another helper. A changed selected installation, workspace identity or build fingerprint requires a new prepared job; elapsed time alone never invalidates approval.

Preparation and execution check platform, protocol, required release files, the data compatibility declaration, and fingerprints of application code and runtime. Dependencies must be supplied by the trusted local package and left unchanged; they are not recursively fingerprinted. This is local release validation, not package signing or an external update channel.

## Failures and recovery

- Busy work can take as long as needed. The approved update stays queued and proceeds automatically when active work finishes; it never kills agents to manufacture an idle moment. Once shutdown actually starts, it has a separate sixty-second timeout.
- If the service stops before the verified handoff, the independent helper revalidates the selected build and workspace and restarts that service automatically. The restarted service reclaims the same approved queue before dispatching new work. Repeated service crashes are limited to three recovery attempts per job. A replaced helper cannot update the new helper's job. Helper startup is retried up to three times; repeated startup failures are reported while leaving the original app running. If both processes were lost, the stable launcher can reclaim the queue on the next launch.
- Before backup, free space must cover the full logical database plus a 256 MiB reserve. An insufficient-space update stays queued and checks again every thirty seconds without making model calls or taking the app offline. Backup progress also checks the reserve, because other applications may consume space after the initial check. An interrupted partial backup is discarded and recreated; a committed verified backup is retained. Storage errors and failures to write a failure record are contained rather than escaping the maintenance timer and crashing the service.
- A new service has sixty seconds to become healthy. If startup fails, the helper can start the previous build only when its fingerprint is intact, both builds declare the same data compatibility, and the database passes integrity and unchanged-schema checks.
- Automatic fallback switches code only. It never restores an older database over newer messages.
- If compatibility cannot be established, or the helper disappears after shutdown, retain the saved job, backup, and maintenance lock for inspection. The stable launcher may recover an approved queue only before backup/shutdown and only for the same selected installation and data directory; later phases still require inspection. Power loss and hardware failure during the actual switch can still require recovery.

Each job lives in `DATA_DIRECTORY/maintenance/JOB_ID/`, with `job.json`, `helper.log`, `service.log`, and (after draining) a verified `workspace.db` backup. `latest.json` identifies the most recent job; `active.json` prevents a second handoff. States include `prepared`, `armed`, `draining`, `stopping`, `starting`, `succeeded`, `rolled-back`, and `failed`. Status reports a stranded acknowledged helper as `recovery-required`.

For manual recovery, first establish that no helper or service is still running for this data directory and inspect the job and logs. Preserve a copy of the current data before deciding which build can read it. Resolve compatibility or repair the candidate before removing a stale lock and launching the chosen build. Do not delete a lock to bypass an active update. Backups contain private workspace data and should remain local.

Keep the prior versions and the runtime referenced by the installed shortcut scripts. This first implementation intentionally has no automatic release or backup cleanup.

## Release compatibility and validation

`release.json` declares `maintenanceProtocol: 1` and `dataCompatibility: "workspace-v1"`. Change the compatibility identifier whenever an update changes stored data semantics in a way an older build cannot safely read. Such updates need a separate migration procedure. An unchanged SQL schema alone does not prove semantic compatibility.

Windows process handoff is covered by `node scripts/maintenance-smoke.mjs` after building. It uses temporary installations, a fixture database and a separate loopback port, makes no provider calls, and never installs into the live app. Unit tests in `tests/maintenance.test.ts` cover queuing, active and inflight work, interrupted helper startup, changed releases, and incompatible data formats. macOS/Linux installer support is present but has not been exercised on those operating systems in this change.

The October 31 goal staffing update retains workspace-v1. Capacity checks and automatic staffing run inside service transactions without adding SQL constraints. Startup reassigns legacy duplicate or missing leads using existing employee, goal and policy fields; it preserves goal history and paused/saved execution states. The compatibility fixture in `artifacts/check-goals-compatibility.ts` opens data with the prior installed build, applies reconciliation, then verifies that the prior build can still read and update it with an unchanged schema and a passing integrity check.
