# Access, data and costs

The preview runs a service on your own computer, bound to localhost by default. It is intended for a trusted single OS-user environment, not a shared computer or remote multi-user server. Other software running as you may access local data or the service. Localhost is not a sandbox against local software.

Agents can read files, run commands and change files according to the provider harness's permissions. A chosen folder sets working context; it does not guarantee all reads are confined there. Ask mode requests approval for restricted actions, with different rules across providers. Decline unexpected requests. Git worktrees separate edits but are not security isolation.

Your messages and relevant files/tool results may be sent to the selected model provider. Local storage does not mean offline model processing. Provider account terms, retention and billing apply. Sign in through the provider's supported flow using your own account; do not use Chris's credentials. Subscription allowances and explicit API billing choices are separate.

## Data on your computer

| Platform | Default workspace data |
| --- | --- |
| Windows | `%LOCALAPPDATA%\AgentWorkspace` |
| macOS | `~/Library/Application Support/AgentWorkspace` |
| Linux | `$XDG_DATA_HOME/AgentWorkspace`, or `~/.local/share/AgentWorkspace` |

Data includes conversations, settings, generated attachments and service logs. Provider harnesses also maintain their own account/session data outside this folder. Do not put the workspace database on OneDrive or a network share.

The connection vault uses Windows user protection on Windows. macOS/Linux currently keep a private key file rather than an OS-keyring-protected key; external connectors are outside this trial. Chat and artifact storage are not described as encrypted by that vault.

Backups contain conversations, settings and attachments. They exclude the dedicated provider-secret vault and working repositories, but can still contain sensitive text you typed or generated. Do not send a backup, provider session folder or unreviewed logs as a bug report.

## Trial boundaries

Use disposable data, one agent in Ask mode, no remote hosting, no external service connections and no unattended schedules. Do not enable Bypass/Full access for testing. The app may still expose those features; these are trial instructions, not claims they have been technically disabled.

Chris will collect feedback you deliberately send. This trial does not request automatic transcript uploads. Share only the minimum reproduction and redact screenshots. To stop using a connected provider, stop all work and use that provider's own sign-out/revocation controls; uninstalling this application does not promise to revoke provider credentials.
