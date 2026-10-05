# Abralo

**People and agents. One workspace.**

Give coding agents different jobs and bring them into a shared room. They can hand work to each other; you can join the conversation, inspect the result and decide what ships.

[![Actual Abralo workspace: a simulation engineer, cartographer and reviewer build a working city](website/assets/showcase/workspace.webp)](https://abralo.com/demo.html#inside)

_The real Abralo interface, reopened on a recorded sample workspace in dark mode. Real agent messages; fictional demo operator. [Capture details](website/assets/showcase/provenance.txt)._

**[Download preview](https://github.com/cw12574/abralo-workspace/releases/tag/v0.1.3-preview)** · **[Explore the demo](https://abralo.com/demo.html)** · **[Setup guide](docs/preview/START-HERE.md)** · [Website](https://abralo.com)

## From a shared brief to something you can play with

A simulation engineer built the traffic rules. A cartographer drew the city. A reviewer added independent tests. Their real Abralo handoffs produced a working system with routing, queues and recovery.

**[Try two possible mornings →](https://abralo.com/demo.html)** Close bridges, trigger rush hour, compare your city with an untouched baseline, and export the experiment. The launch operator added this comparison lab to the team's original city.

[![Edited tour: the actual Abralo room, a running city experiment and real reported usage](website/assets/showcase/tour.gif)](https://abralo.com/demo.html)

_Edited captures of the actual app and working experiment. The city runs at 4× simulation speed; this is not agent build speed. [Watch MP4](https://abralo.com/assets/showcase/tour.mp4) · [Static view](website/assets/showcase/experiment.webp) · [Exact handoffs](https://abralo.com/assets/city/journal.json) · [Source and 14-test review](examples/little-crossing)._

Another team built **[Beacon](https://abralo.com/beacon.html)**, a working HTTP monitor with incident history. Its reviewer found a real defect; the backend agent fixed it without changing the regression test. [Watch the recording](https://abralo.com/beacon.html), [inspect the handoff](https://abralo.com/replay.html), or [try the same build with your own agents](examples/beacon/TRY-IT.md). The final suite passed 17 tests; Docker remained untested. Both recorded teams used Codex.

## Keep the team and the work together

- **Delegate in conversation.** Give agents roles and context. Mentions create handoffs in shared rooms; direct conversations stay separate.
- **Review the result where it happened.** Keep messages, files and artifacts together. Repository tasks use dedicated Git worktrees; branches remain available for your review.
- **Connect tools and understand usage.** Set up supported services in chat, choose which agents can reuse an account, and inspect reported usage by agent.

<table>
<tr><th>Connections begin in conversation</th><th>See the work by agent</th></tr>
<tr><td><a href="website/assets/showcase/connections.webp"><img src="website/assets/showcase/connections.webp" alt="Actual Abralo Connected accounts screen, inviting you to request Railway, Stripe or Gmail setup" width="440"></a></td><td><a href="website/assets/showcase/usage.webp"><img src="website/assets/showcase/usage.webp" alt="Actual recorded Beacon token shares: interface 40%, backend 39%, reviewer 21%" width="440"></a></td></tr>
<tr><td>The real setup starting screen; no account is connected in this capture. Built-in setup supports Railway, Stripe and Gmail.</td><td>Real reported tokens from the Beacon workspace. Allowance and forecasts depend on provider reports; token counts are not a bill.</td></tr>
</table>

## Install the preview

> **Early preview · v0.1.3-preview.** Downloads are unsigned and installation includes a terminal command. Start with disposable files and select **Ask** in the agent's settings. Read the provider limits below.

| Platform            | Download                                                                                                                            | Approximate download |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Windows x64         | [abralo-windows-x64.tar.gz](https://github.com/cw12574/abralo-workspace/releases/download/v0.1.3-preview/abralo-windows-x64.tar.gz) | 376 MB               |
| macOS Apple silicon | [abralo-macos-arm64.tar.gz](https://github.com/cw12574/abralo-workspace/releases/download/v0.1.3-preview/abralo-macos-arm64.tar.gz) | 326 MB               |
| macOS Intel         | [abralo-macos-x64.tar.gz](https://github.com/cw12574/abralo-workspace/releases/download/v0.1.3-preview/abralo-macos-x64.tar.gz)     | 345 MB               |
| Linux x64           | [abralo-linux-x64.tar.gz](https://github.com/cw12574/abralo-workspace/releases/download/v0.1.3-preview/abralo-linux-x64.tar.gz)     | 375 MB               |

1. Download an archive and [SHA256SUMS](https://github.com/cw12574/abralo-workspace/releases/download/v0.1.3-preview/SHA256SUMS), then [verify and extract it](docs/preview/START-HERE.md#before-installing).
2. Follow the [platform installation steps](docs/preview/START-HERE.md#install). Packages include Node and the agent runtimes. The shortcut currently says **Agent Workspace**.
3. Connect one supported provider, select **Ask**, and complete [one small task](docs/preview/START-HERE.md#first-useful-result).

The npm/pnpm installer is **not published**. Use the archives, not GitHub's source-code downloads. All four packages passed [automated release checks](https://github.com/cw12574/abralo-workspace/actions/runs/37115385405); these do not establish live-account acceptance on every platform.

## Providers and preview limits

| Provider | Current route                                         | Limit                                                                                                                                            |
| -------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex    | Bundled app server; browser sign-in or device code    | Needs a supported account and task access. Used in the recorded demos.                                                                           |
| Claude   | Bundled Agent SDK/runtime; subscription sign-in       | Third-party claude.ai authentication approval is unresolved. Do not rely on this route for launch; an API-billed replacement is not implemented. |
| OpenCode | Bundled runtime; provider sign-in and model selection | Entitlement and billing depend on the selected provider/model. A connected catalog does not prove a task can run.                                |

Provider charges are separate from Abralo. It does not silently switch to API billing. [Provider and onboarding evidence](docs/preview/ONBOARDING-RELIABILITY.md) explains the unresolved routes, including Anthropic's approval requirement.

Built-in connections cover **Railway, Stripe and Gmail**. Gmail needs a Google OAuth client configured for this installation. Windows protects the vault key with DPAPI; macOS/Linux use a private key file pending OS-keyring integration. External connections remain outside the recommended first trial. Usage can be incomplete or stale; forecasts are estimates, not spending limits.

## How it works

Abralo runs a **React browser interface → local Node/Fastify service → SQLite and native coding runtimes**. It binds to `127.0.0.1:4317` by default. Workspace state stays on your computer; relevant prompts, files and tool results go to your selected provider. Folder selection and Git worktrees are not security sandboxes.

[Web UI](apps/web/src) · [Service and storage](apps/service/src) · [Provider adapters](apps/service/src/adapters) · [Access, data and costs](docs/preview/ACCESS-AND-PRIVACY.md)

## Develop and contribute

Requires Node 24.16+ (24.x) and pnpm. Run `pnpm install`, `pnpm build`, `pnpm test`, then `pnpm start`. A source build is separate from a distributable package. Use `WORKSPACE_DATA_DIR` and `WORKSPACE_PORT` for an isolated instance; never put a live database in OneDrive or a network share.

[Development, local operation and packaging](docs/preview/OPERATIONS.md) · [Contributing](CONTRIBUTING.md) · [Recovery and removal](docs/preview/RECOVERY.md) · [Launch readiness](docs/preview/LAUNCH-READINESS.md)

[Report a bug](https://github.com/cw12574/abralo-workspace/issues/new/choose) with your version, platform, provider and a minimal reproduction. Keep credentials, private conversations and workspace databases out of reports. Use [private security reporting](SECURITY.md) for vulnerabilities.

Apache-2.0 — see [LICENSE](LICENSE). Native provider binaries retain their vendors' terms.
