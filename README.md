# Abralo — lasting goals for your AI team

**Give your AI team a goal you can pick up tomorrow.**

Abralo is an open-source, local workspace for people and coding agents. Keep an outcome, its current position, decisions and next step together across sessions. A named lead maintains the goal; substantial tasks record checks and inspectable results.

1. Tell your agent what you want to achieve and ask it to keep a lasting goal.
2. Agree on success and a useful next step. Ask the agent to do that work and show its checks.
3. Reopen Abralo, review the saved progress and continue the same project.

Work starts from your requests or an explicit schedule. Lasting goals do not promise continuous background execution or guaranteed outcomes. Ordinary conversation remains available while work runs.

**[Website and assisted trial](https://abralo.com/#try)** · **[Release status and older previews](https://github.com/cw12574/abralo-workspace/releases)** · **[Goals walkthrough](docs/preview/GOALS-TRIAL.md)** · **[Setup guide](docs/preview/START-HERE.md)**

## Durable-goals release candidate

Version `0.2.0-preview` adds lasting goals, task checks, shared browser tools and durable connection actions. Windows x64, Linux x64, macOS Intel and macOS Apple silicon are build targets. Until a release is published with matching assets and checksums, a CI build is a candidate, not a supported download. The older `0.1.3-preview` download does not include durable goals.

Use disposable, non-sensitive files and your own supported provider account for initial trials. Packages are unsigned; macOS notarization and interactive platform acceptance remain separate checks. Model requests go to your selected provider. See [release notes](docs/preview/RELEASE-NOTES.md) and [data durability requirements](docs/preview/DATA-DURABILITY.md).

This source tree is licensed under [Apache-2.0](LICENSE).

## Source development

Requires Node 24.16+ (24.x) for source development. `pnpm install`, `pnpm exec playwright install chromium`, `pnpm build`, `pnpm test`, `pnpm start`. `pnpm dev` runs the service from source; `pnpm web` runs Vite. The service serves built browser assets at http://127.0.0.1:4317.

Data is stored under the OS user application-data directory, outside the checkout. Set `WORKSPACE_DATA_DIR` for an isolated test instance and `WORKSPACE_PORT` for another port. Never use a live database in OneDrive or a network share.

Native harnesses use the owner's supported login. Invitations do not grant other humans access to the host owner's provider credentials. No model API fallback is selected automatically.

## Local test build

This is a working preview, not a signed public release. No sample conversations or simulated agent activity are installed in the user's workspace.

On Windows the installer adds **Agent Workspace** to the Desktop and Start menu with startup on login off for new installations. Existing startup preferences are preserved. It opens the browser at your last conversation while a detached local service keeps working if you close the tab. Sleeping or shutting down the host stops execution; unconfirmed work is marked interrupted on restart rather than blindly repeated. Settings → General lets you turn automatic startup off or on.

The default data directory is `%LOCALAPPDATA%\AgentWorkspace` on Windows, `~/Library/Application Support/AgentWorkspace` on macOS and `$XDG_DATA_HOME/AgentWorkspace` (or `~/.local/share/AgentWorkspace`) on Linux. Installation code and user data are separate. Backups omit provider tokens; `scripts/restore.mjs` restores into a new directory and leaves schedules disabled until explicitly re-enabled.

Codex and Claude employees require native subscription sign-in. OpenCode exposes native provider sign-in and an explicit API billing choice. Account owners can grant a trusted human access to an employee in employee settings; that human gets a separate DM and uses the owner's provider allowance. Membership in a workspace alone does not grant account use.

Repository tasks use a dedicated Git worktree from HEAD. Uncommitted changes are not copied or overwritten. Working copies and branches remain available for inspection; this preview does not automatically merge or delete them. Ordinary folders are used directly. Run artifacts are downloaded through authenticated routes.

Connection setup happens in chat. Stripe and Railway use their official MCP endpoints. Gmail uses Google's OAuth library and API and requires a Google client configured for this self-hosted installation. Secrets go to dedicated forms and the encrypted vault, never ordinary chat. On Windows the vault key uses DPAPI; the other platforms' keyring integration remains a release gate.

Notifications are on by default. The installed, single-user Windows host sends desktop alerts directly through Windows; a focused Abralo page handles alerts in-app. If browser notification permission has already been granted, Abralo repairs its push subscription automatically and uses it when native delivery fails. On other hosts, desktop alerts need browser permission, while in-app alerts and the unread inbox work immediately. An explicit turn-off is preserved. Windows notification settings and Do not disturb can suppress banners even when Abralo sends one. HTTPS is required for remote phone access; this installation defaults to loopback and does not expose a public listener. `WORKSPACE_PUBLIC_URL` and an authenticated HTTPS reverse proxy are required when setting a non-loopback `WORKSPACE_HOST`.

## Packaging and development

All direct dependency versions and the lockfile are pinned. `pnpm build` emits the web bundle and service modules. No Docker, Redis, external vector database or Electron runtime is required. Desktop packages include Chromium for agent browser sessions. Native coding harnesses and Chromium dominate the installation's disk size; the service's measured memory is not a total-agent memory claim.

Set `WORKSPACE_PNPM_CLI` to pnpm's JavaScript entry point and run `node scripts/package.mjs NEW_OUTPUT_DIRECTORY`. Packaging uses a hoisted production dependency tree for portable Windows copies, includes the pinned Chromium browser, and removes redundant OpenCode binary copies. On Windows run `scripts/install-windows.ps1 -ReleaseDirectory OUTPUT`. On macOS/Linux run the packaged `runtime/node scripts/install-posix.mjs`; those installers still require platform acceptance testing.

Agents on all three harnesses use Abralo's shared MCP browser tool with a separate browser context per run. Windows desktop control requires an explicit owner decision for a five-minute lease. The owner can stop it from the persistent banner; cancellation, expiry, restart, and run completion also end access. Desktop control requires an unlocked interactive Windows session.

Tests: `pnpm test`; `scripts/ui-smoke.ts` uses an isolated fixture through Playwright; `scripts/workflow-smoke.ts codex` (or `claude`, `opencode`) makes real provider calls, including native resume. `scripts/image-smoke.ts` checks native vision. Live tests use the user's account allowance and should not be run redundantly. `scripts/mixed-smoke.ts` is a short concurrency check, not the required two-hour soak.

Third-party packages retain their own license files; native provider binaries remain subject to their vendors' terms.
