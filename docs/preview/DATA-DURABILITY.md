# Data durability and release gate

We cannot promise that user data will never be lost. A laptop can be destroyed, a disk can fail, a backup destination can be unavailable, and software can contain bugs. Before any public release, we must show that ordinary shutdowns, upgrades, crashes, and recovery do not silently replace a user's workspace with an empty one.

## Current protections

- SQLite uses WAL mode with `synchronous=FULL`, so committed transactions are flushed before the app reports success.
- A device key without its workspace database is treated as an incomplete installation. Startup must stop with a recovery error instead of silently creating a blank workspace.
- The launcher checks that the service on its port belongs to the same build and data directory. It must refuse to attach to a different service and must not terminate that service automatically.
- Manual workspace backups include the database and attachments, but not provider credentials or project working folders. A backup on the same disk does not protect against disk or device loss.

## Required before a public release

- Automated, versioned backups to a user-selected destination on a different device or a properly protected cloud account. Encrypt sensitive backup content, verify every backup, retain multiple restore points, and show the last successful backup time and any failure prominently.
- A documented export and restore flow that validates checksums and database integrity before touching a live workspace. Restore into a new location first; never overwrite the only copy.
- Explicitly inventory every user-owned artifact: conversations, drafts, agents, settings, attachments, schedules, credentials, project folders, Git worktrees, and in-progress task state. Each item needs an owner, storage location, backup policy, and restore test.
- Cross-platform failure tests on Windows, macOS, and Linux: forced process termination during writes, abrupt restart, full disk, interrupted upgrades, duplicate launchers, missing or corrupt databases, backup verification, and restore onto a clean machine.
- Release telemetry that does not collect workspace content but can report startup identity mismatches, failed writes, backup age, and recovery outcomes with user consent.
- A release-blocking acceptance run in which a populated workspace is backed up, the app is upgraded and restarted, the original workspace is verified, and a separate restore is opened and compared.

Do not market local-only storage as disaster-proof. The platform must clearly distinguish a successful local commit from a successful off-device backup, and explain that project folders may need their own backup or version-control policy.
