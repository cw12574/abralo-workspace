# Abralo 1.0.0

The first full release of Abralo: an open-source workspace where you and a team of AI employees work towards lasting goals, on your own computer.

## What's in 1.0

- **Your AI team.** Employees with names, roles and their own conversations, organised by a Chief of Staff who hands out work.
- **Lasting goals.** Each goal has a lead, a success check and a next step. Work continues across sessions, and a goal only closes after an independent review against its success check.
- **Morning briefing.** Talk or type with your Chief of Staff to review what moved and agree the day's goals.
- **Clearer conversations.** Agent steps sit quietly under the text, with plain labels such as "Edited connections.ts" or "Ran the test suite".
- **Connections with approvals.** Connect Stripe, Railway and Gmail; any outside change waits for your approval and is never blindly repeated.
- **Three agent engines.** Claude Code, Codex and OpenCode, signed in with your own account.
- **Rooms removed.** Conversations are now direct with each employee, which keeps the workspace simpler.

## Fixed since 0.2.0

- New users are asked to sign in to Claude Code instead of seeing "Could not check Claude Code on this host".
- Finishing sign-in during setup now unlocks **Continue**; previously the account showed as connected but setup stayed blocked.
- Reloading the page during setup keeps your progress, and a resolved connection error no longer stays on screen.
- Clear messages when Abralo's local service can't be reached, a session has expired or a provider takes too long, and an expired Claude sign-in says so plainly.
- A replaced OpenCode server is always stopped, so model refreshes no longer accumulate background processes.

## Security

- All dependencies updated to versions without known advisories (`pnpm audit`: no known vulnerabilities), including the MCP SDK, Fastify, Zod and Vite.
- The local service accepts requests only for the local machine's host name, checks the origin of browser requests, requires a custom header on every change and uses `SameSite=Strict` session cookies. The development server's origin is trusted only when running from source.
- Remote access stays off unless you configure HTTPS and a public address.

## Known limitations

- **Unsigned builds.** Windows asks you to confirm the installer script and macOS needs the download quarantine removed; see [Getting started](START-HERE.md). Code signing and notarisation are planned.
- **Secrets on macOS and Linux** are encrypted with a key stored in your user-only data folder. Windows protects that key with your Windows account (DPAPI). System keychain support on macOS and Linux is planned.
- **Backups** are local; keep your own off-device copy (see [data durability](DATA-DURABILITY.md)).
- **Upgrading from 0.2.0 or earlier:** install 1.0 over it; your workspace data is kept. Shortcuts are renamed from "Agent Workspace" to "Abralo".

## Platforms and checks

Windows x64, macOS Apple silicon, macOS Intel and Linux x64. Each build runs the dependency audit, type check, full test suite, packaged runtime and browser checks, clean-profile provider probes, the onboarding recovery check, installer and removal, and the launcher lifecycle (sign-in, restart and backup) on its own platform. Download checksums are published as `SHA256SUMS`.
