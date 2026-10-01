# Abralo friends preview

This is an early, opt-in preview for friends. The application and shortcuts currently say **Agent Workspace**. The Windows and macOS packages are unsigned; the Linux package has no publisher signature. Automated build and install checks have passed, but native desktop acceptance, signing/trust checks and some live agent-permission checks are still open. This is not a finished or independently security-audited release.

Only install a package Chris has sent you directly for your operating system and CPU. Do not redistribute it. If Chris has not confirmed that your platform is included in this friends preview, wait and ask first. A CI build or checksum alone does not establish that a package is safe or signed by a publisher.

## Before installing

- Use your own provider account. Model requests use its allowance or the billing option you explicitly select. The application is local; model processing is performed by the selected provider.
- Begin with disposable files containing no personal, customer or employer information. The preview has not had an independent security audit.
- Start with one agent in **Ask** mode. Check its settings before giving it work; the application currently defaults to Auto. Ask requests approval for restricted actions, not every read or every action. Permission behavior varies by provider. A project folder or Git worktree is not a universal security sandbox.
- Leave external connections, remote access and schedules unused for this first trial. Do not run as administrator or use Bypass/Full access.
- Before extracting, compare the archive's SHA-256 with the value Chris sent. On Windows, run `Get-FileHash .\PACKAGE.zip -Algorithm SHA256` in PowerShell; on macOS, run `shasum -a 256 PACKAGE.zip`; on Linux, run `sha256sum PACKAGE.zip`. Replace `PACKAGE.zip` with the archive's actual name. A checksum checks file integrity; it is not a publisher signature. If the values differ or no checksum was supplied, stop and ask Chris.
- Extract the archive into a local folder.
- Do not disable antivirus, Gatekeeper or other system protection, and do not change a machine-wide execution policy. If your system blocks a package or script, stop, record the exact message and ask Chris. Do not use instructions from an unsolicited message or download a replacement package from another source.

## Install

### Windows

The package supports Windows x64. Open PowerShell in the extracted package folder and run:

```powershell
.\scripts\install-windows.ps1 -ReleaseDirectory .
```

Open **Agent Workspace** from the Start menu. The installer needs no administrator rights. Startup on login remains off for a new install. If PowerShell reports that the downloaded installer script is blocked by `RemoteSigned`, and you have decided to proceed with the exact package Chris sent and verified its checksum, you may remove the internet mark from just that installer script and run it again:

```powershell
Unblock-File .\scripts\install-windows.ps1
.\scripts\install-windows.ps1 -ReleaseDirectory .
```

This is a one-file exception that lets that script run; it does not verify the publisher or the script's safety. Do not change machine-wide execution policy. If Windows Security/SmartScreen blocks the app, or the warning differs from the expected PowerShell policy message, stop and send Chris the exact warning. Do not select a security override.

### macOS

The package must match your Mac's CPU (Apple silicon or Intel). Open Terminal in the extracted package folder and run:

```sh
./runtime/node scripts/install-posix.mjs
```

Open **Agent Workspace.app** from your home folder's Applications directory. macOS may report that the developer cannot be verified because this preview is unsigned, and cannot confirm the app is free of malware. Do not turn off Gatekeeper or remove quarantine attributes. If you have decided to proceed with the exact package Chris sent and verified its checksum, try opening it once, then go to **System Settings → Privacy & Security**, scroll to **Security**, and choose **Open Anyway** for this app. Read and accept the system warning only if you still choose to continue. This stores a manual exception for the app; it does not verify the publisher or prove the app is safe. If the option is absent or the app still will not open, stop and send Chris the exact message. See [Apple's safety guidance](https://support.apple.com/en-ie/102445).

### Linux

The package supports Linux x64, but desktop acceptance has not been verified on a specific distribution. Do not use WSL as evidence that the native desktop works. Open a terminal in the extracted package folder and run:

```sh
./runtime/node scripts/install-posix.mjs
```

Open **Agent Workspace** in your desktop application menu. Do not use `sudo`. If it does not appear or fails to launch, send Chris your distribution/version and the exact error.

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

## Remove

Stop any active agent and close the app first. Follow [the removal steps](RECOVERY.md#remove-the-application-while-keeping-data) to remove program files and shortcuts. Those steps keep your local conversations and settings. Do not delete the data directory unless you deliberately want to erase that data.
