# Hacker News launch readiness

Repository review: 5 October 2026. This is an evidence record, not a claim that a stable release has passed acceptance.

## Release decision

Keep `v0.1.3-preview` labeled as a prerelease. A Show HN can be early software, but readers must be able to try it: the [Show HN guidance](https://news.ycombinator.com/showhn.html) explicitly welcomes early work and discourages landing pages without a usable product. Removing the preview label does not establish reliability.

The repository can be prepared now. Broader launch readiness still requires a supported authentication route, independent first-use acceptance, and working support/security reporting. Do not promise all three providers, frictionless installation, arbitrary service connectivity, or thousand-user reliability from the current evidence.

## Verified repository state

| Item                       | Evidence                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public source and license  | `cw12574/abralo-workspace`, Apache-2.0; provider binaries retain their own terms                                                                           |
| Downloadable release       | [v0.1.3-preview](https://github.com/cw12574/abralo-workspace/releases/tag/v0.1.3-preview), published 3 October from `873d79e`                              |
| Four-platform checks       | [Run 37115385405](https://github.com/cw12574/abralo-workspace/actions/runs/37115385405) passed Windows x64, Linux x64, macOS Intel and Apple silicon       |
| Published files            | Four platform archives, approximately 326–376 MB each, and `SHA256SUMS`                                                                                    |
| What CI establishes        | Build, dependency audit, automated tests, package contents, clean-profile runtime status, browser failure/recovery fixtures and installer/lifecycle checks |
| What CI does not establish | Live provider entitlement, independent native desktop acceptance, successful first task for a new user, or a match to the original tester's incident       |
| Inspectable example        | [Beacon](../../examples/beacon): real Codex output, recorded handoffs, reviewer-found defect and fix; Docker remains unverified                            |
| Current source vs release  | At review, main was `79dda46`; changes since the release were website, examples and documentation, not application runtime changes                         |
| npm installer              | Unpublished; `installer/releases.json` contains no pinned hashes. Do not advertise the command as usable                                                   |
| Repository settings        | Website field and topics were empty; private vulnerability reporting was disabled. Issues were enabled; no open issues or PRs at review                    |

## Required before inviting a broad audience

1. **Resolve the Claude route.** The existing implementation uses the Agent SDK with subscription sign-in. [Anthropic's documentation](https://code.claude.com/docs/en/agent-sdk/overview) requires prior approval for third-party claude.ai login/rate limits, otherwise API-key authentication. Establish approval or implement a supported route with explicit billing consent. Alternatively, remove this route from the launch build and claims; documentation alone does not disable it. Review the SDK branding requirements at the same time.
2. **Finish independent first-use acceptance.** On each advertised platform, install the exact candidate in a clean OS profile, connect a real supported account, complete a small task, review a permission request, stop work, restart and recover the conversation. Include Safari on macOS. Record package version, OS/browser/provider, result and any intervention. Runtime status probes and already-signed-in demos are not substitutes. Live model calls require the account owner's agreement.
3. **Close the original onboarding report.** Obtain the affected tester's redacted log and environment, match the failure or reproduce it, and get a candidate retest. The fixes address verified defects, but the original incident cause remains unconfirmed. Do not describe it as conclusively resolved.
4. **Make security reporting usable.** Enable and verify GitHub private vulnerability reporting; update `SECURITY.md` to match. Do not collect sensitive reports through public issue forms.
5. **Choose an honest connection scope.** macOS/Linux currently store the vault key in a private file rather than the OS keyring. The existing trial excludes external connections. Complete keyring protection and connection acceptance before promoting this as a production-ready capability across platforms, or keep the trial boundary explicit. Gmail needs a per-installation Google OAuth client.

These are acceptance requirements, not permission to make paid calls, contact testers, change provider billing, publish a release or deploy the website.

## Repository presentation

- Lead with shared rooms, agent-to-agent handoffs and human review. Keep source, downloads, setup and a real recorded build one click away.
- Use version-specific release links while all releases are prereleases; verify that four archives and checksums are present. Do not rely on a latest-stable redirect.
- Keep unsupported install commands out of the primary path. Clearly separate packaged installation from building source.
- Add structured bug reports covering version, OS/CPU/browser, provider, failing stage and minimal reproduction; warn against uploading secrets or full logs.
- Set the GitHub About website to `https://abralo.com`. Suggested description: `A local, open-source workspace for people and coding agents`. Suggested topics: `ai-agents`, `developer-tools`, `local-first`, `agent-orchestration`, `mcp`.
- Use the same product name in shortcuts and UI when a tested installer update is ready. Until then, explain that the shortcut says Agent Workspace.
- Keep unsigned-package guidance visible. Signing/notarization would reduce installation friction; removing warnings from the documentation would not.

## Submission and launch-day work

Recommend linking the repository, with the website and recorded build prominent in the README. This is a positioning choice for a technical audience, not an HN ranking claim.

The [previous submission](https://news.ycombinator.com/item?id=48832797), posted 8 July 2026, received 37 points and 31 comments when checked. That product presented parallel Claude Code sessions in a Tauri window. Explain the substantial change to an open-source workspace with shared human/agent rooms, handoffs and inspectable worktrees. Link the old thread; changing the submitted URL is not a duplicate-policy workaround. Show HN guidance says major overhauls may qualify, while routine feature updates generally do not.

Chris should write the submission title and opening comment himself. [HN guidelines](https://news.ycombinator.com/newsguidelines.html) exclude generated posts and generated or AI-edited comments. Useful factual points to cover: why he rebuilt it, one concrete workflow, the local architecture, provider/billing limits, what changed since July and a specific request for technical feedback. Do not solicit votes/comments or repeatedly delete and repost.

Choose a time when Chris can remain available for technical replies and troubleshooting. Keep a short issue queue: install/sign-in blockers first, incorrect claims second, feature suggestions later. Record voluntarily shared first-task success, time to useful result and return use; do not add silent telemetry or collect transcripts for launch measurement. Points and stars are attention signals, not evidence of retention or paid demand.

## Promoting a future stable release

After the acceptance requirements are closed, build and test the exact release candidate on all four platforms. Record live-account acceptance separately, verify published archive hashes, and review install/upgrade/backup/removal behavior and provider terms. Update release notes and all download/version references together. Publishing a tag without a hyphen currently creates a non-prerelease automatically, so do not create such a tag as a cosmetic relabeling step.

The npm route is optional for HN. It requires a matching package version, verified pinned hashes, package-name ownership and a tested published package. Do not let an unfinished optional installer obscure the usable release archives.
