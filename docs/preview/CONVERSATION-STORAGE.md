# Conversation continuity and storage

Recent conversation summaries use an optional, account-scoped IndexedDB cache: at most eight views, 16 MiB total payload, 2 MiB per view, retained for seven days. Full activity output stays on the server and is fetched when opened. Browser storage can be evicted or unavailable; authoritative reads still work. Permissions are checked before restoring cached content, and logout/revocation clears it.

Snapshots include the reading position, historical page and expanded activity steps. Returning to a conversation displays its cached content while fetching current data. Drafts are saved separately until acknowledged by the server; snapshot eviction never discards unsent typing. Neither snapshots nor browser drafts replace durable conversation records.

The service retains up to 2,048 replay events, each with at most 16 KiB of payload, for up to 24 hours. A two-second maintenance tick removes expired rows. Oversized replay updates become scoped catch-up signals. Live internal events retain their original payload so notification consumers keep working; browser activity events use summaries. This bounds retained replay payload to 32 MiB, excluding SQLite/index overhead and the brief maintenance interval.

Ordinary reconnects replay missing events without refreshing every conversation. An expired or invalid cursor explicitly requests background reconciliation. Snapshot watermarks and in-flight event journals prevent older responses from overwriting newer updates. If a catch-up signal arrives during a request, a fresh request follows without clearing the current view.

Existing unbounded replay history is retired immediately and deleted in small batches. Messages, activities, goals, approvals and action receipts are preserved. SQLite reuses freed pages; deleting rows does **not** immediately shrink the physical database. Reclaiming that existing allocation requires separately verified maintenance/compaction with a recoverable backup.

## Verification

Run the event-replay, activity-details, conversation-cache and conversation-persistence Vitest suites. For real IndexedDB checks, build the app, then run `node --import tsx scripts/conversation-storage-preview.ts` and open its printed local origin at `/verification`. The fixture uses disposable data and no AI provider. Results are also written to `browser-storage-result.json`. `/preview` opens the built conversation UI; `/preview?slow=1` delays message reads for background-refresh checks. Stop the fixture after use.
