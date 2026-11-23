# Stop, recover and remove the preview

## If something looks wrong

Use **Stop** in the active conversation. Closing the browser tab leaves the service running. If it stays on “Stopping,” do not submit the task again: duplicate actions may occur. Record the build, approximate time and visible error, and contact Chris.

Until child-process cancellation has passed the release check, do not use the preview for important files. If unexpected activity continues, sign out of the OS or shut down the machine normally to end the session; avoid ending every Node process because unrelated applications can use Node too.

After restart, inspect the last activity and actual files before continuing. Interrupted work is not proof that no changes occurred. Do not retry a deployment, payment, send or deletion without checking its real outcome; those actions are outside this trial.

## Back up

Settings → General → **Create a backup** shows the backup location. Keep it private. It contains workspace conversations/settings/attachments, not your working project repositories. Back up important project files separately. The backup is stored on the same computer; copy it to a suitable separate location if you need protection against disk loss.

Restore is currently assisted. Chris can use the package's `scripts/restore.mjs` with the bundled runtime, a backup directory and a **new, nonexistent data directory**. It refuses to overwrite an existing directory. Restored schedules remain disabled and accounts require reconnection. Do not point a restore at your existing workspace.

## Queued updates and storage maintenance

Update preparation is saved before expensive work begins. Settings → General → Updates shows whether it is queued, building, verifying, ready for approval, or waiting for an idle moment. A restart resumes the same request. Agents remain available while preparation or installation is queued. Only the actual idle handoff briefly blocks writes and dispatch; it never kills active agent work.

For engineering preparation, `workspace_maintenance` accepts `action: "prepare"` with either `candidateRoot` (an already staged version), or `sourceRoot` and `pnpmCli` (the exact repository-pinned pnpm JavaScript entry point). Source builds run from a disposable snapshot, use isolated test data and output, and share the existing dependency installation. Do not change installed dependencies during preparation. Type checking, tests, web compilation, service compilation and packaging run sequentially. Tests use one worker. Builds and verification start without a free-RAM threshold. Builds use a 768 MiB V8 heap allowance; an actual memory failure retries with additional heap allowance, up to 1.5 GiB. A V8 allowance is not a total process memory limit. The queued request remains inspectable if preparation fails. Build logs are in the job's `preparation.log`.

Release fingerprints retain the existing byte order and SHA-256 format. A background worker reuses a 1 MiB buffer, including for the bundled Chromium DLL. Preparation does not authorize installation: wait for `phase: "prepared"`, then use the existing owner approval flow. Bundled engines and Chromium are unchanged.

During the next approved update, after the service has exited, maintenance creates a compact database copy with SQLite `VACUUM INTO`. It checks database integrity, schema, every table's contents and row identities, foreign-key results, and application metadata before switching. This includes conversations, drafts and search data. Less than 16 MiB reclaimable, or insufficient temporary disk space, skips compaction safely and records the reason. The first upgrade from an older helper performs the same check before opening the new service's Store. The original database remains recoverable; partial copies are never selected.

After the service is healthy again, recovery copies are compressed in a background process. Each archive is decompressed and its SHA-256 compared before the uncompressed recovery file is removed. This avoids keeping multiple multi-gigabyte copies of unused database pages. The saved maintenance job records the backup path, archive hash and compaction recovery path. An interrupted archive leaves the original available.

Recovery after an interrupted database switch is assisted: retain the job directory and its `active.json` lock. Do not remove the lock or start another service until the recorded database and backup locations have been checked. A `.gz` maintenance backup is a lossless gzip database image, not a backup directory accepted by `restore.mjs`. Decompress it to a new scratch file, verify its recorded SHA-256 and SQLite integrity, and only restore it after confirming the service and handoff helper have stopped. Keep the existing database and its WAL together until recovery is complete. Project files and artifacts are not moved by compaction.

References: [SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html), [SQLite backup snapshots](https://www.sqlite.org/backup.html), [Node background workers](https://nodejs.org/api/worker_threads.html).

## Remove the application while keeping data

There is no one-click uninstaller yet. Ask Chris for assistance if you are unsure of any path. First stop work, disable startup on Windows in Settings → General, and sign out of the OS to end the service. Sign back in before removing program files. On a fresh preview installation, startup is off by default.

- Windows: remove the **Agent Workspace** Desktop/Start-menu shortcuts and the program directory `%LOCALAPPDATA%\Programs\AgentWorkspace`. Check that its Startup shortcut is absent. Keep `%LOCALAPPDATA%\AgentWorkspace` if you want your conversations and backups.
- macOS: remove `~/Applications/Agent Workspace.app` and `~/Library/Application Support/AgentWorkspaceProgram`. Keep `~/Library/Application Support/AgentWorkspace` to preserve data.
- Linux: remove `~/.local/share/applications/agent-workspace.desktop` and `~/.local/lib/agent-workspace`. Keep the data directory shown in the privacy guide.

Verify each exact path before deleting anything. Custom `WORKSPACE_DATA_DIR` installations use a different data path. Project folders/worktrees and provider account/session data are separate and are not removed by these steps. Data deletion and provider credential revocation should be deliberate, separate choices.

These removal steps still need clean-machine acceptance on each target platform; they are not evidence of a completed installer/uninstaller test.
