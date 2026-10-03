Abralo is an early preview for opt-in testers. The application and shortcuts currently say **Agent Workspace**. The Windows and macOS packages are unsigned, and the Linux package has no publisher signature. Automated checks do not replace testing on your own machine. This preview has not had an independent security audit.

## Onboarding and connection recovery

- Provider startup and broken-pipe failures are contained so they cannot take down the workspace service through the repaired error paths. Failed startup can be retried.
- Connection checks have deadlines and avoid duplicate requests. Checking one provider does not wait for an unrelated provider.
- Codex uses browser sign-in by default, with device-code fallback, cancellation and automatic status refresh.
- Claude connection checks distinguish a signed-out account from a runtime failure. The bundled runtime is found reliably in both source and packaged installations.
- Setup details survive a page reload in the same tab. OpenCode setup explicitly selects a model from its connected providers.
- Service connection errors provide recovery instructions instead of only showing “Failed to fetch”.

All four packages must pass automated tests, clean-profile native provider probes, browser onboarding recovery checks, and installer/lifecycle checks before this release publishes. Provider probes make no model calls; they do not establish live-account entitlement or guarantee that every previously reported incident has the same cause.

For a retest, quit the old Abralo instance, install this version using the guide, and reopen it. Keep your existing workspace data. If connection still fails, record the OS/browser, the exact step, and the corresponding redacted `service.log` lines; do not share credentials or sign-in codes.

Download the archive matching your operating system and CPU. Compare its SHA-256 with `SHA256SUMS` before extracting it. A matching checksum detects a damaged download; it does not verify the publisher or prove the application is safe.

See the [friends preview guide](https://github.com/cw12574/abralo-workspace/blob/main/docs/preview/START-HERE.md) for installation, safety notes, first-task guidance, feedback, and removal instructions. Use disposable files and your own provider account. Do not redistribute the preview package.
