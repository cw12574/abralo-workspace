# Getting started with Abralo

Abralo runs on your own computer. Your conversations, goals and files stay on your machine; model requests go only to the AI provider you sign in with, using that account's allowance.

## What you need

- Windows 10 or 11 (x64), macOS on Apple silicon or Intel, or Linux (x64).
- An account for at least one agent: **Codex** (a ChatGPT account), **Claude Code** (a Claude account) or **OpenCode** (works with a range of providers).
- About 2 GB of free disk space.

## Install

Download the archive for your computer from the [latest release](https://github.com/cw12574/abralo-workspace/releases/latest). If you want to check the download, compare its SHA-256 with the `SHA256SUMS` file in the release.

The builds are not yet code-signed, so your system will ask you to confirm before running them. The steps below say what to expect.

### Windows

1. Extract the `.tar.gz` archive into a folder (right-click → **Extract All**).
2. Open PowerShell in that folder and run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -ReleaseDirectory .
   ```

   `-ExecutionPolicy Bypass` applies only to this one command; it does not change your computer's settings. No administrator rights are needed.
3. Open **Abralo** from the Start menu or the desktop shortcut.

### macOS

1. Double-click the archive to extract it, then open Terminal in the extracted folder.
2. Because the build is not yet notarised by Apple, remove the download quarantine from this folder only, then install:

   ```sh
   xattr -dr com.apple.quarantine .
   ./runtime/node scripts/install-posix.mjs
   ```
3. Open **Abralo** from the Applications folder in your home folder.

Choose the archive that matches your Mac: `macos-arm64` for Apple silicon (M1 and later), `macos-x64` for Intel.

### Linux

```sh
mkdir abralo && tar -xzf abralo-linux-x64.tar.gz -C abralo && cd abralo
./runtime/node scripts/install-posix.mjs
```

Open **Abralo** from your application menu. Do not use `sudo`.

## First run

1. Tell Abralo your name.
2. Connect your Chief of Staff to Codex, Claude Code or OpenCode. Choose **Sign in** and finish in the browser tab that opens; for Codex, enter the code shown. Abralo notices when you're signed in. Never paste passwords or API keys into ordinary chat.
3. Add one or two outcomes you'd like to work towards, then start the conversation.

A good first request:

> Help me plan something I'm working on this week. Ask me what you need, then write a one-page plan.

To make something lasting, ask your Chief of Staff to **make it a goal**. You'll see it on the Goals page with its lead, success check and next step.

## Good to know

- **Permissions.** Each employee has a permission mode in its settings. **Ask** requests your approval for restricted actions; start there if you're unsure.
- **Your files.** Git projects are worked on in a separate worktree from your last commit, so uncommitted changes are never overwritten. Ordinary folders are edited directly.
- **Stopping work.** Closing the browser tab does not stop agents. Use **Stop** in the conversation. Sleeping or shutting down the computer stops work; anything unfinished is marked interrupted when Abralo restarts, so nothing is repeated without you checking it first.
- **Updates.** Download new Abralo releases from GitHub and install them over the old one; your workspace is kept.
- **Your data** lives in `%LOCALAPPDATA%\AgentWorkspace` on Windows, `~/Library/Application Support/AgentWorkspace` on macOS and `~/.local/share/AgentWorkspace` on Linux. See [recovery](RECOVERY.md) for backups.

Read [access and privacy](ACCESS-AND-PRIVACY.md) for what Abralo can reach and how approvals work. Problems or ideas: [open an issue](https://github.com/cw12574/abralo-workspace/issues).
