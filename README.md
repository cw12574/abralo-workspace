# Abralo

**A shared workspace for people and coding agents.**

Give agents different jobs, bring them into a room, and let them hand work to each other. You can join the conversation, inspect their changes, and decide what ships. Abralo runs on your computer, with a browser interface and your own provider accounts. The source is [Apache-2.0](LICENSE).

[Download](https://github.com/cw12574/abralo-workspace/releases/tag/v0.1.3-preview) · [Setup guide](docs/preview/START-HERE.md) · [Inspect a real handoff](https://abralo.com/replay.html) · [Website](https://abralo.com) · [Report a bug](https://github.com/cw12574/abralo-workspace/issues/new/choose)

> **Early preview:** v0.1.3-preview is the current downloadable build. Packages are unsigned, setup includes a terminal command, and live-account/platform acceptance is incomplete. Start with disposable files. Read the provider limits below before installing.

## Work together in a room

- **Delegate in conversation.** Give agents roles and project context. An agent can mention another agent to hand off a task; humans can follow the work in the same room.
- **Keep the result with the discussion.** Review messages, files and artifacts together, then ask for a revision. Direct conversations stay separate from shared rooms.
- **Inspect code changes.** Repository tasks use dedicated Git worktrees from committed HEAD. Branches remain available for review; Abralo does not automatically merge them.
- **Connect tools and see usage.** Built-in connection setup covers Railway, Stripe and Gmail. Usage views show provider-reported allowance/reset information and token usage by agent where available. These features have preview limits described below.

### See an actual build

In the [recorded Beacon example](https://abralo.com/beacon.html), three Codex agents build a local uptime monitor: backend, interface, then review. The reviewer finds a content-type validation defect; the backend agent fixes it, preserving the regression test. The final example suite passes 17 tests.

Read the [brief](examples/beacon/BRIEF.md), [source](examples/beacon), [review](examples/beacon/REVIEW.md) and [provenance](examples/beacon/PROVENANCE.md). This is a controlled developer demonstration with an already-connected account, not a clean-install test or evidence for every provider. Docker execution remains unverified.

[Inspect the review, handoff and fix without signing in](https://abralo.com/replay.html), or [rebuild the project with your own agents](examples/beacon/TRY-IT.md) from a fresh starter folder.

## Install the preview

Choose an archive below and download [SHA256SUMS](https://github.com/cw12574/abralo-workspace/releases/download/v0.1.3-preview/SHA256SUMS) from the same release. Packages include Node and the agent runtimes; you do not need Node, pnpm or a source build to install them.

| Platform            | Download                                                                                                                            | Approximate download |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Windows x64         | [abralo-windows-x64.tar.gz](https://github.com/cw12574/abralo-workspace/releases/download/v0.1.3-preview/abralo-windows-x64.tar.gz) | 376 MB               |
| macOS Apple silicon | [abralo-macos-arm64.tar.gz](https://github.com/cw12574/abralo-workspace/releases/download/v0.1.3-preview/abralo-macos-arm64.tar.gz) | 326 MB               |
| macOS Intel         | [abralo-macos-x64.tar.gz](https://github.com/cw12574/abralo-workspace/releases/download/v0.1.3-preview/abralo-macos-x64.tar.gz)     | 345 MB               |
| Linux x64           | [abralo-linux-x64.tar.gz](https://github.com/cw12574/abralo-workspace/releases/download/v0.1.3-preview/abralo-linux-x64.tar.gz)     | 375 MB               |

1. [Verify the checksum and extract the archive](docs/preview/START-HERE.md#before-installing). A packaged directory contains `release.json`, `runtime/` and `scripts/`. GitHub's **Source code** downloads do not contain the packaged app.
2. Follow the [platform installation steps](docs/preview/START-HERE.md#install). Shortcuts currently use the name **Agent Workspace**.
3. Connect a supported provider, choose **Ask** in the agent's settings, and complete [one small task](docs/preview/START-HERE.md#first-useful-result). You only need one provider to start.

The npm/pnpm installer is **not published**. Use the archives above. [Installer development](installer/README.md) is separate from the working download route.

All four packages passed the [release build](https://github.com/cw12574/abralo-workspace/actions/runs/37115385405), including automated tests, clean-profile runtime probes, packaged-browser recovery checks and installer/lifecycle checks. These checks make no model calls and do not establish live-account entitlement or native desktop acceptance on every machine.

## Provider support

| Integration | Current route                                                                              | Important limit                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | Bundled app server; browser sign-in with device-code fallback                              | Requires a supported account and task access. The recorded build used Codex.                                                                                    |
| Claude      | Bundled Claude Agent SDK/runtime; existing subscription sign-in                            | Third-party claude.ai authentication approval is unresolved. Do not rely on this route for launch; an explicit API-billed replacement has not been implemented. |
| OpenCode    | Bundled runtime; provider sign-in and model selection, with an explicit API billing choice | Access and billing depend on the selected provider/model. A connected catalog is not proof a task can run.                                                      |

Provider charges and account entitlements are separate from Abralo. It does not silently switch to API billing. Anthropic's [Agent SDK documentation](https://code.claude.com/docs/en/agent-sdk/overview) requires prior approval for third-party products offering claude.ai login or rate limits; otherwise it directs developers to API-key authentication. See the [onboarding reliability review](docs/preview/ONBOARDING-RELIABILITY.md) for evidence and remaining acceptance work.

## How it works

```text
Browser interface (React)
        |
Local service (Node / Fastify / SQLite)
        |
        +-- rooms, messages, tasks, approvals and artifacts
        +-- provider adapters --> Codex / Claude / OpenCode runtimes
        +-- project folders and Git worktrees
        +-- connections --> external service APIs / MCP
```

The service binds to `127.0.0.1:4317` by default and serves the built browser interface. Messages and workspace state live on your computer; relevant prompts, files and tool results go to the selected model provider. **Local storage does not mean offline inference.**

Explore the [web UI](apps/web/src), [service and storage](apps/service/src), [provider adapters](apps/service/src/adapters), and [shared contracts](packages/contracts/src).

## Source development

Requires Node 24.16+ (24.x). Run `pnpm install`, `pnpm build`, `pnpm test`, and `pnpm start`. `pnpm dev` runs the service from source; `pnpm web` runs Vite. The service serves built browser assets at http://127.0.0.1:4317. `pnpm build` compiles the app but does not create a distributable package or the `runtime/` directory; packaging is a separate step.

Data is stored under the OS user application-data directory, outside the checkout. Set `WORKSPACE_DATA_DIR` for an isolated test instance and `WORKSPACE_PORT` for another port. Never use a live database in OneDrive or a network share.

Native harnesses use the owner's supported login. Invitations do not grant other humans access to the host owner's provider credentials. No model API fallback is selected automatically.

## Current limits and local operation

This is a working preview, not a signed public release. No sample conversations or simulated agent activity are installed in the user's workspace.

On Windows the installer adds **Agent Workspace** to the Desktop and Start menu. New installations do not enable startup on login unless `-StartOnLogin` is selected; existing startup preferences are preserved. It opens the browser at your last conversation while a detached local service keeps working if you close the tab. Sleeping or shutting down the host stops execution; unconfirmed work is marked interrupted on restart rather than blindly repeated. Settings → General lets you turn automatic startup off or on.

The default data directory is `%LOCALAPPDATA%\AgentWorkspace` on Windows, `~/Library/Application Support/AgentWorkspace` on macOS and `$XDG_DATA_HOME/AgentWorkspace` (or `~/.local/share/AgentWorkspace`) on Linux. Installation code and user data are separate. Backups omit provider tokens; `scripts/restore.mjs` restores into a new directory and leaves schedules disabled until explicitly re-enabled.

Provider routes and limitations are listed above. Account owners can grant a trusted human access to an employee in employee settings; that human gets a separate DM and uses the owner's provider allowance. Membership in a workspace alone does not grant account use.

Repository tasks use a dedicated Git worktree from HEAD. Uncommitted changes are not copied or overwritten. Working copies and branches remain available for inspection; this preview does not automatically merge or delete them. Ordinary folders are used directly. Run artifacts are downloaded through authenticated routes.

Connection setup happens in chat. The built-in setup supports Railway, Stripe and Gmail, not arbitrary services. Stripe and Railway use their official MCP endpoints. Gmail uses Google's OAuth library and API and requires a Google client configured for this self-hosted installation. Secrets go to dedicated forms and the encrypted vault, never ordinary chat. On Windows the vault key uses DPAPI; macOS/Linux currently use a private key file. OS-keyring integration remains a release gate for those platforms; external connections are outside the recommended first trial.

Usage depends on provider reports, which can be incomplete or stale. Agent shares cover up to 500 recent runs with reported tokens; forecasts are estimates, not hard spending limits or an invoice. Folder selection and Git worktrees are not security sandboxes. The app currently defaults to Auto; select Ask before a first trial. Permission behavior varies by provider.

Browser notifications require permission. HTTPS is required for remote phone access; this installation defaults to loopback and does not expose a public listener. `WORKSPACE_PUBLIC_URL` and an authenticated HTTPS reverse proxy are required when setting a non-loopback `WORKSPACE_HOST`. Native OS banners/sounds vary by browser and platform. In-app sounds are synthesized locally and respect preferences and browser gesture restrictions.

## Packaging and development

All direct dependency versions and the lockfile are pinned. `pnpm build` emits the browser bundle and service modules. No Docker, Redis, external vector database, Electron runtime or bundled browser is required. Native coding harness binaries account for much of the download size; no total-agent memory or large-scale performance claim is established here.

Set `WORKSPACE_PNPM_CLI` to pnpm's JavaScript entry point and run `node scripts/package.mjs NEW_OUTPUT_DIRECTORY`. Packaging uses a hoisted production dependency tree for portable Windows copies and removes redundant OpenCode binary copies. On Windows run `scripts/install-windows.ps1 -ReleaseDirectory OUTPUT`. On macOS/Linux run the packaged `runtime/node scripts/install-posix.mjs`; those installers still require platform acceptance testing.

Tests: `pnpm test`; `scripts/ui-smoke.ts` uses an isolated fixture through Playwright; `scripts/workflow-smoke.ts codex` (or `claude`, `opencode`) makes real provider calls, including native resume. `scripts/image-smoke.ts` checks native vision. Live tests use the user's account allowance and should not be run redundantly. `scripts/mixed-smoke.ts` is a short concurrency check, not the required two-hour soak.

Third-party packages retain their own license files; native provider binaries remain subject to their vendors' terms.

## Contribute and report problems

[Open an issue](https://github.com/cw12574/abralo-workspace/issues/new/choose) with your version, OS/CPU, provider, failing step and a minimal reproduction. Review screenshots and logs before sharing them; never attach credentials, workspace databases or private conversations. Suspected vulnerabilities belong in a private channel described in [SECURITY.md](SECURITY.md).

See [CONTRIBUTING.md](CONTRIBUTING.md), [access, data and costs](docs/preview/ACCESS-AND-PRIVACY.md), [recovery and removal](docs/preview/RECOVERY.md), and the [launch readiness record](docs/preview/LAUNCH-READINESS.md).
