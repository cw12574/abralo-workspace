# Launch-day references

This is a factual reference and operating checklist, not submission text. Chris should write the HN title, opening comment and replies himself. [HN guidance](https://news.ycombinator.com/item?id=22336638) excludes generated or AI-edited posts/comments and asks for clear explanations, personal context and relevant previous threads.

## Links to keep available

| Reader wants to…                         | Link                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inspect Abralo                           | [Repository](https://github.com/cw12574/abralo-workspace)                                                                                                    |
| Understand the product                   | [Website](https://abralo.com)                                                                                                                                |
| Follow a real handoff without signing in | [Read-only replay](https://abralo.com/replay.html)                                                                                                           |
| Watch the original session               | [Beacon recording](https://abralo.com/beacon.html)                                                                                                           |
| Rebuild the example                      | [Starter workflow](../../examples/beacon/TRY-IT.md)                                                                                                          |
| Download and install                     | [v0.1.3-preview](https://github.com/cw12574/abralo-workspace/releases/tag/v0.1.3-preview), [setup](START-HERE.md)                                            |
| Inspect validation                       | [Four-platform release run](https://github.com/cw12574/abralo-workspace/actions/runs/37115385405), [example provenance](../../examples/beacon/PROVENANCE.md) |
| Report an ordinary bug                   | [Issue forms](https://github.com/cw12574/abralo-workspace/issues/new/choose)                                                                                 |
| Report a vulnerability privately         | [Private report](https://github.com/cw12574/abralo-workspace/security/advisories/new)                                                                        |
| See the earlier product/discussion       | [8 July Show HN](https://news.ycombinator.com/item?id=48832797)                                                                                              |

## Facts and boundaries

- Abralo is Apache-2.0 source, with a local Node/Fastify/SQLite service and browser UI. Model requests go to the connected provider. Bundled runtimes retain their own terms.
- The collaboration mechanism is shared rooms, explicit agent mentions/handoffs, project context and human review. Git worktrees separate repository edits; they are not security sandboxes.
- The current downloadable build remains an unsigned preview. npm installation is not yet published. Avoid suggesting a command people cannot use.
- The real Beacon example used three Codex agents and a detailed brief. A reviewer-found media-type defect was fixed without changing the regression. The final example suite passed 17 tests. Docker was not run.
- The new replay is a reconstruction with exact selected messages and published artifacts. It makes no live agent calls. The homepage's separate illustration uses sample messages and is labeled accordingly.
- Chris reports completing independent first-use checks. No platform/provider coverage, conversion rate, benchmark or customer count is inferred from that statement.
- Claude third-party subscription authentication approval remains unestablished in this work. Do not promise that route without resolving it. OpenCode requires a provider and model selection; account entitlements and billing vary.
- Built-in connections cover Railway, Stripe and Gmail. Gmail needs a per-installation Google OAuth client. macOS/Linux vault key protection and broader external-connection acceptance remain documented limitations.
- Usage reporting is provider-dependent; it is not a guaranteed spending cap or invoice. No measured total-agent memory or thousand-user reliability claim has been established.

## Before submitting

Open the repository, replay, platform release and setup links in a signed-out browser. Confirm the relevant release remains available. Explain the substantial change from the July product and link the old discussion; do not change URLs to evade duplicate handling. [Show HN rules](https://news.ycombinator.com/showhn.html) permit major overhauls more readily than incremental upgrades.

Use one canonical submission. Reserve time to answer questions and help with reproducible installation problems. Do not solicit votes, promotional comments or coordinated replies. Do not post automatically or use agents to reply on HN.

## During and after the discussion

Keep a small issue queue: installation/sign-in blockers, incorrect claims, then suggestions. Acknowledge uncertain causes and link confirmed fixes to a specific release. Check private security reports separately. Never request full logs, credentials or workspace databases in public comments.

Record the submission URL, recurring objections, voluntarily reported first-task outcomes and return use. Keep original anecdotes separate from verified aggregate metrics; do not silently add telemetry. Ask interested users for permission before follow-up. Measure whether people return with real work, rather than treating points or stars as retention or paid demand.

After the initial discussion, consolidate reproducible issues and decide the next release from observed failures. Keep the original thread updated with factual, human-written corrections where appropriate; do not repeatedly delete and repost.
