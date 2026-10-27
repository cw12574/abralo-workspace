# Abralo private preview

This is an early local workspace for humans and AI agents. The application and shortcuts currently say **Agent Workspace**. Chris will supply a package for your computer after its release checks pass. A build existing does not mean it has passed those checks.

## Before installing

- Tell Chris your Windows version/CPU, Mac chip (Apple silicon or Intel), or Linux distribution/version/CPU, and which provider you can sign into.
- Use your own provider account. Model requests use its allowance or the billing option you explicitly select. The application is local; model processing is performed by the selected provider.
- Begin with disposable files containing no personal, customer or employer information. The preview has not had an independent security audit.
- Use one agent in **Ask** mode. Check its settings before giving it work; the application currently defaults to Auto. Ask requests approval for restricted actions, not every read or every action. Permission behavior varies by provider. A project folder or Git worktree is not a universal security sandbox.
- Leave external connections, remote access and schedules unused for this first trial. Do not run as administrator or use Bypass/Full access.

## Install the package supplied for your computer

Extract the archive into a local folder. If Chris supplies a SHA-256 checksum, compare it before installation. A checksum checks file integrity; it is not a publisher signature. Do not disable antivirus, Gatekeeper or other system protection. If the downloaded preview is blocked, record the exact message and contact Chris.

### Windows

Open PowerShell in the extracted package folder and run:

```powershell
.\scripts\install-windows.ps1 -ReleaseDirectory .
```

Open **Agent Workspace** from the Start menu. New installations leave startup on login off. Existing startup preferences are preserved; Settings → General controls it. The installer needs no administrator rights. If PowerShell blocks the unsigned script, stop and ask Chris to help verify the package rather than changing machine-wide policy.

### macOS — only once Chris confirms your build has passed

Open Terminal in the extracted package folder and run:

```sh
./runtime/node scripts/install-posix.mjs
```

Open **Agent Workspace.app** from your home folder's Applications directory. The package must match your Mac's chip. macOS signing, downloaded-package trust behavior and native testing remain release gates until Chris confirms otherwise.

### Linux — only once Chris confirms your build has passed

Open a terminal in the extracted package folder and run:

```sh
./runtime/node scripts/install-posix.mjs
```

Open **Agent Workspace** in your desktop application menu. The package must match your CPU and a verified distribution; a WSL test does not establish support for your desktop. Do not use sudo.

## First useful result

1. Open the app and complete onboarding using your own provider sign-in. Never paste passwords or API keys into ordinary chat.
2. Check the selected agent's settings and choose **Ask**. Give it access only to your disposable test folder when prompted.
3. Try your own small task, or use this example with a short fictional notes file:

   > Read notes.txt and draft a short README in this folder. Use only those notes, do not browse or install anything, and show me what you changed.

4. Review the permission request and actual result. Ask for one small revision.
5. Close the tab, reopen the application, and check that you can find the conversation and result.

Git projects start from committed HEAD in a separate worktree. Uncommitted changes are not copied. Ordinary folders are edited directly. Inspect the work location and changes before using any output.

Closing the tab does not stop agents. Use **Stop** in the conversation and wait for completion; see [recovery](RECOVERY.md) if it remains on “Stopping.”

## Feedback

Use [the feedback sheet](FEEDBACK.md), then explore independently if you wish. You do not need to try every feature. The useful questions are: could you get started, did you get something useful, and would you choose to return?

Read [access and privacy](ACCESS-AND-PRIVACY.md) and [recovery](RECOVERY.md) before adding anything you care about.
