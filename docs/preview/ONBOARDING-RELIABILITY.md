# Onboarding reliability review — 3 October 2026

## Incident and confidence

A preview tester reported “Failed to fetch” on the connection step in v0.1.2-preview, followed by unresponsive sign-in/status controls. His screenshot contents and service log have not been supplied here, so the exact incident cause remains unconfirmed.

Review and fault injection found an unhandled Codex stdin error path capable of terminating the service, shared status checks that waited on unrelated providers, and missing bounds/recovery in OpenCode startup. A clean-profile runtime probe also found that the source pnpm layout did not resolve the bundled Claude binary. These are verified code defects; none alone is proof of the tester's incident cause.

## Changes in this branch

- Provider processes contain pipe and startup failures; failed initialization can be retried. Old process exits cannot clear a replacement runtime.
- Status checks are bounded, coalesced per provider, and isolated. A selected provider does not wait for another provider. Unknown state is distinct from signed out.
- Codex reads account state before requesting optional models/quotas; catalog failure cannot erase a successful account check.
- Codex defaults to browser sign-in, offers device-code fallback, serializes login operations and supports cancellation. Polling is bounded and non-overlapping; returning to the tab refreshes status.
- Claude login has a deadline and cancellation, publishes late-arriving sign-in URLs, and is terminated on app shutdown. Claude status distinguishes structured signed-out results from runtime failure.
- Browser errors identify service reachability, request timeout and expired workspace sessions. Mutating requests are not silently retried.
- Setup preserves name, provider and objectives in this tab's session storage across reloads. No credentials, codes or sign-in URLs are persisted there.
- OpenCode onboarding requires a model from its connected-provider catalog.
- Bundled Claude lookup supports pnpm symlinks and prefers the pinned binary. CI includes clean-profile native probes and browser fault injection against packaged web assets on all four target runners.

## Provider design requirements from primary documentation

| Provider | Supported integration evidence | Product consequence |
| --- | --- | --- |
| Codex | App Server exposes browser login, device-code login, completion notifications and cancellation. | Use browser login first for this local desktop product; retain device fallback and clear stale attempts. [OpenAI App Server](https://learn.chatgpt.com/docs/app-server) |
| Codex | Device-code login may require account/admin enablement. | Explain the fallback and never treat its availability as universal. [OpenAI authentication](https://learn.chatgpt.com/docs/auth) |
| Claude | Agent SDK documentation requires prior approval for third-party products offering claude.ai login/rate limits; otherwise it directs developers to API-key authentication. | Establish approval or implement an explicit API-billed Claude route before a public launch. Approval is not established by this review. The existing subscription route has not been converted or silently billed to an API. [Anthropic SDK](https://code.claude.com/docs/en/agent-sdk/overview) |
| Claude | Credential precedence and expiry can affect which account actually runs. | Detected credentials are not proof of entitlement. A first task must surface access/expiry errors accurately. [Claude authentication](https://code.claude.com/docs/en/authentication) |
| OpenCode | Server API exposes provider catalog, authentication methods and OAuth callbacks. Its provider guide separates connection from model selection. | Discover supported methods, preserve billing consent, select an available model, and handle each method's completion. [Server API](https://opencode.ai/docs/server/), [Providers](https://opencode.ai/docs/providers/) |

The product recommendations are engineering judgments based on these contracts, not claims that the providers guarantee frictionless authentication. Provider authentication, billing and outages remain external dependencies.

The native-app OAuth best practice is to use the user's external browser, which can reuse an existing provider session and keeps the provider's password entry outside Abralo. Leave OAuth protocol handling to the supported provider runtime. Device authorization needs explicit pending/denied/expired handling and provider-directed polling; Abralo's account-status polling is separate from token-endpoint polling. [IETF RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html), [IETF RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html).

## Validation completed locally

- Production build passed; the existing large JavaScript chunk warning remains.
- Full automated suite: 103 tests across 27 files passed.
- Browser fault injection passed against the fresh Windows package's web assets.
- Windows x64 package verification passed (bundled Node 24.16.0 and SQLite).
- All three native provider probes returned status in an isolated profile. OpenCode exposes connected built-in models even without user credentials; this is not proof of paid-account access.
- Packaged launcher, conflicting-workspace protection, authentication boundary, backup and restart/session persistence checks passed in a disposable data directory.

No live model calls, other-platform runs, external telemetry, deployment or release publication were performed. The live workspace was not restarted. The new CI gates are prepared locally and have not run remotely.

## Acceptance before another release

1. Pass build and full automated suite, including provider crash, timeout, deduplication, restart, signed-out and malformed-status regressions.
2. Pass browser fault injection: local-service failure and recovery, sign-in delay, cancellation, device fallback, automatic completion, reload and OpenCode model selection.
3. Run the native clean-profile probe, installer/lifecycle checks and packaged browser checks on Windows x64, Linux x64, macOS Intel and Apple silicon. A local Windows run does not replace that matrix.
4. Perform opt-in live-account acceptance for each supported authentication method: new/returning account, declined login, expired login, unavailable entitlement, quota exhaustion, slow/offline network and successful first task. Test Safari on macOS as well as Chromium. Automated fixtures do not establish these outcomes.
5. Obtain the tester's OS/browser and redacted service log, reproduce his failure or identify the incident cause, then have him retest the candidate.
6. Resolve the Claude distribution/authentication route before expanding public availability.

## Remaining work for broader scale

Use an explicit end-to-end state model: service starting/unreachable, runtime unavailable, signed out, awaiting user authorization, credentials detected, model selected, task verified, expired, failed and cancelled. The current branch improves these boundaries but does not implement a durable, server-owned login transaction across every provider. Abralo currently polls account status; Codex completion events can later drive UI updates directly.

Offer a short, user-triggered first-task verification with a clear allowance/billing explanation. Do not equate “signed in” or a public OpenCode model catalog with a successfully executable account. Do not make paid verification calls automatically or silently fall back to a different billing source.

Add local, redacted support diagnostics (build/OS/runtime versions, stage, duration, safe error code and correlation ID), plus a deliberate user action to export them. Exclude account identifiers, tokens, codes, URLs containing authorization parameters, prompts and objectives. No external telemetry or outreach was enabled in this change.

Measure the onboarding funnel with an agreed privacy model: setup opened → provider chosen → login started → credentials detected → first successful task → repeat use. Track abandonment, retries, failure category and p50/p95 time to first task by build/platform/provider. Proposed launch targets should be agreed after baseline measurement; this work does not establish a conversion rate, a thousand-user load result, or a zero-failure guarantee.

The installed service runs locally for each user. A thousand installations primarily increase the diversity of machines, browsers, accounts and support incidents; they are not a thousand sessions on this one local service. Shared/cloud services need their own load and tenancy validation before offering a hosted product.

## Reproduction commands

```text
pnpm build
pnpm test
pnpm exec tsx scripts/onboarding-reliability-smoke.ts
node scripts/provider-runtime-smoke.mjs <package-directory>
```

The runtime probe constructs a disposable credential profile and makes no model calls. Browser tests use provider fixtures. CI uses the actual packaged browser bundle, while the browser-test HTTP backend runs the candidate source; native package behavior is covered separately by the runtime and lifecycle checks.
