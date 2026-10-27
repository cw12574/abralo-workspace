# Abralo 0.2.0-preview — durable goals

Release candidate. Download availability depends on the checks for each asset.

## What changes

- Lasting goals keep a success measure, current position, named lead and next step.
- Progress updates and evidence for completed steps survive across sessions.
- Substantial tasks have a definition of done and visible checks; ordinary chat remains available.
- Shared browser tools use isolated sessions. Chromium is bundled for all four build targets.
- Supported connections and durable action approvals are reused across agent harnesses.
- Published provider onboarding/recovery fixes are retained alongside the new goals workflow.
- The last active agent is protected from deletion; Windows notification support is included.

Work starts from a human request or explicit schedule. This version does not promise continuous autonomous goal pursuit or guaranteed outcomes.

## Platforms and verification

Targets: Windows x64, Linux x64, macOS Intel and macOS Apple silicon. Native CI runs the dependency audit, build, unit tests, packaged runtime/browser checks, clean-profile provider probes without model calls, onboarding recovery, installer/removal and lifecycle checks. Archives are created on each native runner to preserve executable permissions.

The lifecycle check seeds a goal and completed step, backs up the populated workspace, restores it into a separate directory, and verifies the goal and evidence after service restart. Maintenance tests cover upgrade handoff, verified backup and failure recovery in disposable fixtures.

Passing CI does not establish live-account entitlement, native notification delivery, signing/notarization or interactive installation on every desktop distribution. Packages are unsigned. macOS downloaded-package trust and Linux desktop acceptance remain release checks. See [data durability requirements](DATA-DURABILITY.md) for broader public-release gates, including off-device backups.

## Trying the candidate

Use your own supported provider account, one agent in Ask mode and disposable non-sensitive files. Read [START-HERE](START-HERE.md), [access and privacy](ACCESS-AND-PRIVACY.md) and [the goals walkthrough](GOALS-TRIAL.md). Model requests use your provider's allowance or explicitly chosen billing option.

Choose the archive for your OS/CPU and compare its SHA-256 with the release checksum. Checksums verify download integrity, not publisher identity. Do not bypass operating-system security warnings. Back up existing workspaces before upgrades.

Older 0.1.3-preview downloads do not contain durable goals. An unpublished candidate or CI artifact is not a stable release.
