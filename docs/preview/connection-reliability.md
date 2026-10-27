# Reliable connections in Abralo

Research and implementation, 3 October 2026.

## Product decision

Abralo should own the connection lifecycle. Codex, Claude Code and OpenCode use the same small set of authenticated workspace tools. The person connects an account, chooses which employee can read or write, and approves a concrete action in the conversation. The agent receives the same account status and saved action result regardless of its harness.

The experience should answer three separate questions clearly: **Is my account connected? What can this employee access? What is happening to this action?** A successful login must not imply that a deployment succeeded. An action waiting for approval must not send the person back through login.

## Research findings

| Evidence | Application to Abralo |
| --- | --- |
| [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) specifies discovery, OAuth authorization and scope escalation. | Keep credentials in the broker/vault. Preserve the distinction between provider authentication and Abralo employee grants. Request additional access explicitly on the existing account. |
| [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) defines paginated discovery and tool-list change notifications; annotations are not universally trustworthy. | Follow all discovery pages, expose grant capabilities alongside tools, and offer a refresh path. Only the configured provider recipes participate; absent read-only annotations are treated as writes. |
| [MCP tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks) describes durable IDs, deferred results and capability negotiation. The cited version labels tasks experimental. | Use the durable-action pattern now through ordinary workspace tools. Do not require native task support from every harness. This is an application-level implementation, not a claim of MCP task-protocol support. |
| [MCP elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) separates structured questions from sensitive, out-of-band interactions. | Keep sign-in and credentials outside ordinary agent chat. Continue to render setup and approval in Abralo, independently of native harness dialogs. |
| [Nango authentication](https://nango.dev/platform/auth/) emphasizes token refresh, connection health and reconnect notifications. | Repair stale sessions where safe, keep the original connection identity, and distinguish recoverable transport problems from human authorization. A separate integration vendor is not required to fix these lifecycle bugs. |
| [Anthropic advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) explains on-demand discovery and the context cost of loading large tool catalogs. | Retain a compact workspace gateway and discover provider tools when needed instead of copying every tool into every agent run. |
| [OpenCode MCP documentation](https://opencode.ai/docs/mcp-servers/) documents remote servers, configured headers and OAuth behavior. | Authenticate the harness to Abralo with its run credential. Provider OAuth remains inside Abralo; the OpenCode workspace connection disables a second OAuth flow. |

These are engineering conclusions drawn from the sources and Abralo's code, not a promise that any protocol can eliminate provider outages or account-specific restrictions.

## Failures found in the existing implementation

- Setup records and account records shared an ID-shaped interface. Passing a setup ID to tool discovery returned an empty list even after a grant was approved.
- Write approval waited inside a tool call and depended on an in-memory promise. A harness timeout or service restart could leave the agent unable to retrieve a result.
- Access validation happened after requesting action approval. Invalid tools or missing grants could therefore generate misleading prompts.
- Discovery fetched only the first tool page.
- A reuse card also offered Connect, allowing another OAuth flow for what was only an employee-sharing request.
- First-time setup defaulted to read access even when the user was trying to authorize writes.

## Implemented behavior

**Setup:** repeated requests reuse a card; requested read access can be upgraded on that card. Reuse records resolve to canonical account IDs. The UI sends the access level it displayed, and the server rejects stale consent if that level changed. Initial setup records the explicit read/write choice. An old read-only sharing request cannot silently downgrade an existing write grant.

**Discovery and recovery:** `workspace_connection_status` reads status without creating setup. `workspace_connection_tools` includes capabilities and supports refresh. Provider discovery follows pagination with a bounded cursor loop. A stale read session can reconnect once; writes are never automatically replayed after dispatch.

**Actions:** a write request persists the account, employee, request, exact arguments and fingerprint. It immediately returns an action ID. Approval atomically claims the saved action; repeated clicks and repeated pending submissions share the same receipt. Results survive browser reloads and service restarts. A crash during execution becomes `unknown`, requiring inspection of provider state. Abralo offers no automatic replay of that action. This is at-most-once dispatch per saved action, not provider-level exactly-once delivery.

**Permissions:** grants and room access are checked before an approval is shown and before execution. Read-only research can use connected reads, but cannot prepare writes. Native Claude and OpenCode connection-tool permissions defer to Abralo's checks instead of adding a second approval. Codex already configures the first-party workspace gateway for tool approval in its adapter.

**Conversation:** the action card distinguishes approval, execution, completion, rejection and uncertain outcomes. It shows the account and exact action details. The saved action result drives a continuation of the original task, using the existing supervisor/outbox path.

## Verification and boundaries

Automated coverage includes provider fixtures for Railway, Stripe and Gmail; shared HTTP/MCP contracts for all three employee harness settings; native adapter fixtures; setup-ID resolution; grant escalation; duplicate approval; restart recovery; uncertain writes; stale-read recovery; and paginated discovery. The browser smoke test uses an isolated database and a simulated provider, verifies refresh persistence and one dispatch, and checks desktop and 390px layouts.

These tests do not certify every external account, organization policy or provider endpoint. Before release, exercise real sign-in and a harmless approved action for each supported provider and each authenticated harness. New providers need their own recipe and conformance checks. Provider-specific step-up scopes, tool-list notifications and richer health telemetry remain extensions; this change does not claim to implement them universally.

The repository changes do not themselves update the running installation or deploy the website. Existing pending approvals from the older, in-memory implementation are not migrated into executable writes.
