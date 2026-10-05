# Launch-day references

This is a factual reference and operating checklist, not submission text. Chris should write the HN title, opening comment and replies himself. [HN guidance](https://news.ycombinator.com/item?id=22336638) excludes generated or AI-edited posts/comments and asks for clear explanations, personal context and relevant previous threads.

## Links to keep available

| Reader wants to…                         | Link                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inspect Abralo                           | [Repository](https://github.com/cw12574/abralo-workspace)                                                                                                    |
| Understand the product                   | [Website](https://abralo.com)                                                                                                                                |
| Try an agent-built output                | [City comparison demo](https://abralo.com/demo.html), with source, exact handoffs and operator contributions identified                                      |
| Follow a real handoff without signing in | [Read-only replay](https://abralo.com/replay.html)                                                                                                           |
| Watch the original session               | [Beacon recording](https://abralo.com/beacon.html)                                                                                                           |
| Rebuild the example                      | [Starter workflow](../../examples/beacon/TRY-IT.md)                                                                                                          |
| Download and install                     | [v0.1.3-preview](https://github.com/cw12574/abralo-workspace/releases/tag/v0.1.3-preview), [setup](START-HERE.md)                                            |
| Inspect validation                       | [Four-platform release run](https://github.com/cw12574/abralo-workspace/actions/runs/37115385405), [example provenance](../../examples/beacon/PROVENANCE.md) |
| Report an ordinary bug                   | [Issue forms](https://github.com/cw12574/abralo-workspace/issues/new/choose)                                                                                 |
| Get personal setup help                  | [Chris — chris@abralo.com](mailto:chris@abralo.com?subject=Abralo%20setup%20help)                                                                            |
| Report a vulnerability privately         | [Private report](https://github.com/cw12574/abralo-workspace/security/advisories/new)                                                                        |
| See the earlier product/discussion       | [8 July Show HN](https://news.ycombinator.com/item?id=48832797)                                                                                              |

## Facts and boundaries

- Abralo is Apache-2.0 source, with a local Node/Fastify/SQLite service and browser UI. Model requests go to the connected provider. Bundled runtimes retain their own terms.
- The collaboration mechanism is shared rooms, explicit agent mentions/handoffs, project context and human review. Git worktrees separate repository edits; they are not security sandboxes.
- The current downloadable build remains an unsigned preview. npm installation is not yet published. Avoid suggesting a command people cannot use.
- The real Beacon example used three Codex agents and a detailed brief. A reviewer-found media-type defect was fixed without changing the regression. The final example suite passed 17 tests. Docker was not run.
- The new replay is a reconstruction with exact selected messages and published artifacts. It makes no live agent calls. The homepage's separate illustration uses sample messages and is labeled accordingly.
- The city demo reuses the original three-agent engine and map. The launch operator added the comparison, charts, export and media edit. The actual app captures reopen recorded sample workspaces; they are not a new build. [Capture/authorship record](../../website/assets/showcase/provenance.txt).
- Chris reports completing independent first-use checks. No platform/provider coverage, conversion rate, benchmark or customer count is inferred from that statement.
- Claude third-party subscription authentication approval remains unestablished in this work. Do not promise that route without resolving it. OpenCode requires a provider and model selection; account entitlements and billing vary.
- Built-in connections cover Railway, Stripe and Gmail. Gmail needs a per-installation Google OAuth client. macOS/Linux vault key protection and broader external-connection acceptance remain documented limitations.
- Usage reporting is provider-dependent; it is not a guaranteed spending cap or invoice. No measured total-agent memory or thousand-user reliability claim has been established.
- Computer use is in development, as reported by Chris on 5 October; it is not part of v0.1.3-preview. Describe the intended visual-interface workflow without promising platform/provider coverage. Separate the three managed connection routes in this release from additional native-runtime tools and the wider MCP ecosystem; no hundreds/thousands-of-integrations claim has been verified.

## Before submitting

Open the repository, replay, platform release and setup links in a signed-out browser. Confirm the relevant release remains available. Explain the substantial change from the July product and link the old discussion; do not change URLs to evade duplicate handling. [Show HN rules](https://news.ycombinator.com/showhn.html) permit major overhauls more readily than incremental upgrades.

Check that Chris can receive and reply to an ordinary test email at the published address, and can open private security reports. No delivery test or mailbox review is established by adding a mailto link. Add the contact address to Chris's HN profile if he chooses; this preparation has not edited that account. Pick a launch window when Chris can cover the discussion and the following day's failures. No launch date is set here.

Keep these evidence sources open for likely questions; they are references for human-written answers, not comments to paste:

| Question                                        | Evidence to consult                                                                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Why another agent workspace?                    | A real room handoff and review in [Beacon](https://abralo.com/replay.html); describe Chris's own coordination problem                         |
| Can I use my existing subscription?             | [Current provider routes and limits](../../README.md#providers-and-preview-limits); do not generalize across providers or promise cloud reuse |
| Can agents see my private files or spend money? | [Access, privacy and billing boundaries](ACCESS-AND-PRIVACY.md); distinguish Ask, folder context and provider processing                      |
| How do worktrees behave?                        | [Setup](START-HERE.md#first-useful-result): Git tasks start at committed HEAD in isolated worktrees; ordinary folders are edited directly     |
| How much memory or time does it save?           | No comparative benchmark established; recorded duration and reported tokens are one example, not performance claims                           |
| How will Abralo make money?                     | Free local preview; paid hosting is being explored. Features, price and availability are uncommitted                                          |
| What changed since the previous Show HN?        | Earlier Tauri parallel sessions versus the current Node/browser workspace, public Apache-2.0 source, rooms and handoffs                       |

Use one canonical submission. Reserve time to answer questions and help with reproducible installation problems. Do not solicit votes, promotional comments or coordinated replies. Do not post automatically or use agents to reply on HN.

## During and after the discussion

Keep a small issue queue: installation/sign-in blockers, incorrect claims, then suggestions. Acknowledge uncertain causes and link confirmed fixes to a specific release. Check private security reports separately. Never request full logs, credentials or workspace databases in public comments.

Use the following triage order. Chris owns the queue initially; assign a named owner before handing off a report. Keep private reports private even if a public issue describes similar symptoms.

| Priority | Trigger                                                     | Next action                                                                                               |
| -------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Urgent   | Data loss, unexpected access, or work continuing after Stop | Request a redacted private summary, preserve evidence and establish the cause before recommending retries |
| First    | Cannot install, sign in or complete the first task          | Record version/OS/provider, last successful step, exact error and reproducibility; link duplicates        |
| Next     | Misleading claim, broken download or setup instruction      | Correct the source; publish only through the normal authorized release/deployment process                 |
| Later    | Missing feature or usability suggestion                     | Record the underlying task and frequency; avoid promising a delivery date in the thread                   |

Record each issue's source, stage, reproducibility, owner, next action, workaround and verified fix version. An acknowledgement is not a resolution. Keep a known-issues entry for repeat failures so every reader can find the same verified workaround.

Record the submission URL, recurring objections, voluntarily reported first-task outcomes and return use. Keep original anecdotes separate from verified aggregate metrics; do not silently add telemetry. Ask interested users for permission before follow-up. Measure whether people return with real work, rather than treating points or stars as retention or paid demand.

After the initial discussion, consolidate reproducible issues and decide the next release from observed failures. Keep the original thread updated with factual, human-written corrections where appropriate; do not repeatedly delete and repost.

## Measure use and hosted demand

Use voluntary [feedback](FEEDBACK.md) for the first cohort. No analytics integration or automatic transcript collection is part of this preparation. Keep identifiable answers and consent records outside the public repository.

| Measure                  | Count only when                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| First task               | A person reports an actual useful output they inspected, including build/OS/provider and any assistance      |
| Review handoff           | A second agent reports findings in a shared room and the person records a decision                           |
| Repeat use               | The person voluntarily reports returning with another real task within seven days; note whether prompted     |
| Hosted need              | A recurring task and a specific limitation of local execution are described                                  |
| Qualified pilot interest | The person describes the task, hosting need, budget and willingness to discuss a paid pilot                  |
| Paid commitment          | The customer explicitly agrees to a concrete scope, price and terms; an email or a star alone does not count |

Record dates and anonymous participant IDs so one person is not counted twice. Record unknown outcomes as unknown, not failures or successes. Report counts over the people who actually supplied evidence, with the cohort size and observation window. Website visits, archive downloads and stars do not establish installation or activation; voluntary replies do not establish a site-wide conversion rate.

Working targets proposed for the first fortnight: 10 verified first-task reports, 5 returning users and 3 qualified paid-pilot conversations. These are planning targets, not observed results or industry benchmarks. Record actual paid commitments separately after terms exist. Ask permission before a later follow-up; leaving a public HN comment is not permission for email outreach.

## Before offering a paid cloud pilot

The public preparation states intent and offers an optional email conversation. No cloud service, payment flow, newsletter, price or launch date is established. Validate the problem before choosing the architecture: hosted agent execution and browser access to a customer's own runner have different costs and data boundaries.

- Establish which recurring tasks justify hosting, who will use them, and what buyers can pay. Keep model charges distinct from workspace, compute and storage costs; measure cost per active workspace before setting included usage. Do not promise unlimited execution.
- Confirm provider authentication and commercial routes for the chosen architecture. Local subscription sign-in is not evidence of permission to resell or host it.
- Specify authentication, workspace access, tenant data and execution isolation, secrets protection/revocation, durable state and tested restore/export/deletion. The current localhost application is not a hardened hosted service. [Agent hosting guidance](https://code.claude.com/docs/en/agent-sdk/hosting) explains the execution and persistence requirements.
- Add explicit approval boundaries, execution and spend limits, cancellation and resource cleanup. Test failure and recovery across the full run lifecycle before inviting paid work.
- Establish billing consent, included usage, overage behavior, cancellation/refunds and a support process before taking payment. A payment integration alone does not settle unit economics.
- Before collecting a pilot list or introducing tracking, document the actual data controller/contact, purpose and lawful basis, recipients/transfers, retention and rights. Verify that the published notice matches the mailbox and any service used. A mailto link is a direct enquiry route, not a complete privacy notice. [ICO transparency guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/the-right-to-be-informed/what-privacy-information-should-we-provide/).

Prefer a small, defined paid pilot once demand and these prerequisites are established. Keep future paid scope separate from the currently published Apache-2.0 source; do not promise an unapproved permanent feature split or a change to the existing license.
