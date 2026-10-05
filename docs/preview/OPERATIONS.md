# Local operation and packaging

Detailed reference for the Abralo preview. [Return to the README](../../README.md) or [start with installation](START-HERE.md).

## Current limits and local operation

This is a working preview, not a signed public release. No sample conversations or simulated agent activity are installed in the user's workspace.

On Windows the installer adds **Agent Workspace** to the Desktop and Start menu. New installations do not enable startup on login unless `-StartOnLogin` is selected; existing startup preferences are preserved. It opens the browser at your last conversation while a detached local service keeps working if you close the tab. Sleeping or shutting down the host stops execution; unconfirmed work is marked interrupted on restart rather than blindly repeated. Settings → General lets you turn automatic startup off or on.

The default data directory is `%LOCALAPPDATA%\AgentWorkspace` on Windows, `~/Library/Application Support/AgentWorkspace` on macOS and `$XDG_DATA_HOME/AgentWorkspace` (or `~/.local/share/AgentWorkspace`) on Linux. Installation code and user data are separate. Backups omit provider tokens; `scripts/restore.mjs` restores into a new directory and leaves schedules disabled until explicitly re-enabled.

Provider routes and limitations are listed in the [README](../../README.md#providers-and-preview-limits). Account owners can grant a trusted human access to an employee in employee settings; that human gets a separate DM and uses the owner's provider allowance. Membership in a workspace alone does not grant account use.

Repository tasks use a dedicated Git worktree from HEAD. Uncommitted changes are not copied or overwritten. Working copies and branches remain available for inspection; this preview does not automatically merge or delete them. Ordinary folders are used directly. Run artifacts are downloaded through authenticated routes.

Connection setup happens in chat. The built-in setup supports Railway, Stripe and Gmail, not arbitrary services. Stripe and Railway use their official MCP endpoints. Gmail uses Google's OAuth library and API and requires a Google client configured for this self-hosted installation. Secrets go to dedicated forms and the encrypted vault, never ordinary chat. On Windows the vault key uses DPAPI; macOS/Linux currently use a private key file. OS-keyring integration remains a release gate for those platforms; external connections are outside the recommended first trial.

Usage depends on provider reports, which can be incomplete or stale. Agent shares cover up to 500 recent runs with reported tokens; forecasts are estimates, not hard spending limits or an invoice. Folder selection and Git worktrees are not security sandboxes. The app currently defaults to Auto; select Ask before a first trial. Permission behavior varies by provider.

Browser notifications require permission. HTTPS is required for remote phone access; this installation defaults to loopback and does not expose a public listener. `WORKSPACE_PUBLIC_URL` and an authenticated HTTPS reverse proxy are required when setting a non-loopback `WORKSPACE_HOST`. Native OS banners/sounds vary by browser and platform. In-app sounds are synthesized locally and respect preferences and browser gesture restrictions.

## Packaging and development

All direct dependency versions and the lockfile are pinned. `pnpm build` emits the browser bundle and service modules. No Docker, Redis, external vector database, Electron runtime or bundled browser is required. Native coding harness binaries account for much of the download size; no total-agent memory or large-scale performance claim is established here.

Set `WORKSPACE_PNPM_CLI` to pnpm's JavaScript entry point and run `node scripts/package.mjs NEW_OUTPUT_DIRECTORY`. Packaging uses a hoisted production dependency tree for portable Windows copies and removes redundant OpenCode binary copies. On Windows run `scripts/install-windows.ps1 -ReleaseDirectory OUTPUT`. On macOS/Linux run the packaged `runtime/node scripts/install-posix.mjs`; those installers still require platform acceptance testing.

Tests: `pnpm test`; `scripts/ui-smoke.ts` uses an isolated fixture through Playwright; `scripts/workflow-smoke.ts codex` (or `claude`, `opencode`) makes real provider calls, including native resume. `scripts/image-smoke.ts` checks native vision. Live tests use the user's account allowance and should not be run redundantly. `scripts/mixed-smoke.ts` is a short concurrency check, not the required two-hour soak.

Third-party packages retain their own license files; native provider binaries remain subject to their vendors' terms.
