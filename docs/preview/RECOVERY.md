# Stop, recover and remove the preview

## If something looks wrong

Use **Stop** in the active conversation. Closing the browser tab leaves the service running. If it stays on “Stopping,” do not submit the task again: duplicate actions may occur. Record the build, approximate time and visible error, and contact Chris.

Until child-process cancellation has passed the release check, do not use the preview for important files. If unexpected activity continues, sign out of the OS or shut down the machine normally to end the session; avoid ending every Node process because unrelated applications can use Node too.

After restart, inspect the last activity and actual files before continuing. Interrupted work is not proof that no changes occurred. Do not retry a deployment, payment, send or deletion without checking its real outcome; those actions are outside this trial.

## Back up

Settings → General → **Create a backup** shows the backup location. Keep it private. It contains workspace conversations/settings/attachments, not your working project repositories. Back up important project files separately. The backup is stored on the same computer; copy it to a suitable separate location if you need protection against disk loss.

Restore is currently assisted. Chris can use the package's `scripts/restore.mjs` with the bundled runtime, a backup directory and a **new, nonexistent data directory**. It refuses to overwrite an existing directory. Restored schedules remain disabled and accounts require reconnection. Do not point a restore at your existing workspace.

## Remove the application while keeping data

There is no one-click uninstaller yet. Ask Chris for assistance if you are unsure of any path. First stop work, disable startup on Windows in Settings → General, and sign out of the OS to end the service. Sign back in before removing program files. On a fresh preview installation, startup is off by default.

- Windows: remove the **Agent Workspace** Desktop/Start-menu shortcuts and the program directory `%LOCALAPPDATA%\Programs\AgentWorkspace`. Check that its Startup shortcut is absent. Keep `%LOCALAPPDATA%\AgentWorkspace` if you want your conversations and backups.
- macOS: remove `~/Applications/Agent Workspace.app` and `~/Library/Application Support/AgentWorkspaceProgram`. Keep `~/Library/Application Support/AgentWorkspace` to preserve data.
- Linux: remove `~/.local/share/applications/agent-workspace.desktop` and `~/.local/lib/agent-workspace`. Keep the data directory shown in the privacy guide.

Verify each exact path before deleting anything. Custom `WORKSPACE_DATA_DIR` installations use a different data path. Project folders/worktrees and provider account/session data are separate and are not removed by these steps. Data deletion and provider credential revocation should be deliberate, separate choices.

These removal steps still need clean-machine acceptance on each target platform; they are not evidence of a completed installer/uninstaller test.
