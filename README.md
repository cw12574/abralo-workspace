# Abralo

Abralo is a local, cross-platform workspace where people and AI agents work together through direct conversations, shared rooms, and project context. This new product generation centers the shared conversation experience. Start with the [tester guide](docs/preview/START-HERE.md). See [contributing](CONTRIBUTING.md) and the [security policy](SECURITY.md). This source tree is licensed under [Apache-2.0](LICENSE).

## Install the friends preview

For normal use, download the matching package artifact from the [latest successful build](https://github.com/cw12574/abralo-workspace/actions/workflows/build.yml). Choose the artifact for your operating system and CPU, download it, and extract it. Follow [the tester guide](docs/preview/START-HERE.md). Do not use GitHub's **Download ZIP** source archive or run `pnpm build` to install the app: those are for developers and do not include the packaged runtime. A packaged app directory contains `release.json`, `runtime/`, and `scripts/`.

## Source development

Requires Node 24.16+ (24.x). Run `pnpm install`, `pnpm build`, `pnpm test`, and `pnpm start`. `pnpm dev` runs the service from source; `pnpm web` runs Vite. The service serves built browser assets at http://127.0.0.1:4317. `pnpm build` compiles the app but does not create a distributable package or the `runtime/` directory; packaging is a separate step.

Data is stored under the OS user application-data directory, outside the checkout. Set `WORKSPACE_DATA_DIR` for an isolated test instance and `WORKSPACE_PORT` for another port. Never use a live database in OneDrive or a network share.

Native harnesses use the owner's supported login. Invitations do not grant other humans access to the host owner's provider credentials. No model API fallback is selected automatically.

## Local test build

This is a working preview, not a signed public release. No sample conversations or simulated agent activity are installed in the user's workspace.

On Windows the installer adds **Agent Workspace** to the Desktop and Start menu. New installations do not enable startup on login unless `-StartOnLogin` is selected; existing startup preferences are preserved. It opens the browser at your last conversation while a detached local service keeps working if you close the tab. Sleeping or shutting down the host stops execution; unconfirmed work is marked interrupted on restart rather than blindly repeated. Settings → General lets you turn automatic startup off or on.

The default data directory is `%LOCALAPPDATA%\AgentWorkspace` on Windows, `~/Library/Application Support/AgentWorkspace` on macOS and `$XDG_DATA_HOME/AgentWorkspace` (or `~/.local/share/AgentWorkspace`) on Linux. Installation code and user data are separate. Backups omit provider tokens; `scripts/restore.mjs` restores into a new directory and leaves schedules disabled until explicitly re-enabled.

Codex and Claude employees require native subscription sign-in. OpenCode exposes native provider sign-in and an explicit API billing choice. Account owners can grant a trusted human access to an employee in employee settings; that human gets a separate DM and uses the owner's provider allowance. Membership in a workspace alone does not grant account use.

Repository tasks use a dedicated Git worktree from HEAD. Uncommitted changes are not copied or overwritten. Working copies and branches remain available for inspection; this preview does not automatically merge or delete them. Ordinary folders are used directly. Run artifacts are downloaded through authenticated routes.

Connection setup happens in chat. Stripe and Railway use their official MCP endpoints. Gmail uses Google's OAuth library and API and requires a Google client configured for this self-hosted installation. Secrets go to dedicated forms and the encrypted vault, never ordinary chat. On Windows the vault key uses DPAPI; the other platforms' keyring integration remains a release gate.

Browser notifications require permission. HTTPS is required for remote phone access; this installation defaults to loopback and does not expose a public listener. `WORKSPACE_PUBLIC_URL` and an authenticated HTTPS reverse proxy are required when setting a non-loopback `WORKSPACE_HOST`. Native OS banners/sounds vary by browser and platform. In-app sounds are synthesized locally and respect preferences and browser gesture restrictions.

## Packaging and development

All direct dependency versions and the lockfile are pinned. `pnpm build` emits the browser bundle and service modules. No Docker, Redis, external vector database, Electron runtime or bundled browser is required. The browser bundle is about 141 KB gzip plus CSS and lazily requested local fonts. Native coding harness binaries dominate the installation's disk size and their active processes dominate memory; the service's measured memory is not a total-agent memory claim.

Set `WORKSPACE_PNPM_CLI` to pnpm's JavaScript entry point and run `node scripts/package.mjs NEW_OUTPUT_DIRECTORY`. Packaging uses a hoisted production dependency tree for portable Windows copies and removes redundant OpenCode binary copies. On Windows run `scripts/install-windows.ps1 -ReleaseDirectory OUTPUT`. On macOS/Linux run the packaged `runtime/node scripts/install-posix.mjs`; those installers still require platform acceptance testing.

Tests: `pnpm test`; `scripts/ui-smoke.ts` uses an isolated fixture through Playwright; `scripts/workflow-smoke.ts codex` (or `claude`, `opencode`) makes real provider calls, including native resume. `scripts/image-smoke.ts` checks native vision. Live tests use the user's account allowance and should not be run redundantly. `scripts/mixed-smoke.ts` is a short concurrency check, not the required two-hour soak.

Third-party packages retain their own license files; native provider binaries remain subject to their vendors' terms.
