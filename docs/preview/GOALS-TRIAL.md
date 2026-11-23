# Try lasting goals

This Windows preview opens beside your existing Abralo installation. It uses separate local data and port 4328, so it does not change your current conversations or agents.

From the packaged preview folder, open `scripts\open-goals-preview.cmd`. The browser opens automatically. Complete the short setup with a provider you can sign into.

Try this:

1. Tell your agent: “I want to grow PollyTalks to $10K in monthly recurring revenue. Keep this as a lasting goal. Start by helping me establish the current revenue and customer count.”
2. Open **Goals** in the sidebar. Each row shows a project, its lead, one status and a concrete next action or waiting reason. Expand Progress and completion criteria to inspect the outcome, recorded progress and step evidence. Select the title or lead to talk about the project.
3. Ask the agent to take one concrete step and show how it checked the result. Substantial work should appear as a compact card in the conversation.
4. Close and reopen the preview with the same script. The goal and its updates should still be there.
5. Try a simple question. It should remain an ordinary conversation without a work card.

Choose **New goal**, describe the outcome, and select **Create goal**. The Chief of Staff chooses an available lead or creates an employee if everyone is assigned. You can choose a free employee yourself. Each employee leads at most one unfinished goal, including saved and paused goals. Passing independent completion review releases their capacity; completed projects remain in the expandable history. Existing saved goals remain idle until started from their row menu. The menu also lets you pause or reassign a project. Reassign a goal before deleting or deactivating its lead.

The Goals page and conversation share one status: Saved, Working, Waiting, Checking, Complete or Paused. Only Working, Waiting and Checking goals appear above conversations. Waiting includes the specific question, permission or external result needed. Completed goals move into a collapsed section. Saved means idle, including older projects where some implementation work already happened; it does not mean no work has ever been done. The lead records evidence and a concrete next step after each session. Ready work continues automatically, timed reviews resume when due, and unresolved decisions produce a check-in in the conversation and on the goal. Answer on the goal or in the same conversation/thread to continue. Permission requests still require their own explicit approval. Connected setup/action results can also wake the goal, subject to its current state and limits.

Users may create any number of goals. Agents can also recognise a long-term outcome within the work you requested and create a goal for it. New goals continue ready work without a daily session cap or fixed session cutoff. Checkpoints persist facts, uncertainties, evidence and the next action while work continues naturally. External waits resume on a relevant result or the chosen review time; they do not consume model calls while idle. Existing saved work limits and authority are preserved. New employees inherit no folder, provider or permission-bypass grants. Publishing, deployment, outreach and spending still require your instruction and existing provider approvals. Milestone counts are not displayed as overall progress bars. The completion outcome remains visible in the criteria even after every listed step is checked; the goal stays unfinished until completion is verified. This presentation does not start, pause or complete legacy goals automatically.

Pause prevents new goal work and requests cancellation of the current session. Already dispatched external actions may finish; pause does not undo them. Resume rechecks current evidence and access. Interrupted sessions inspect saved work before continuing, with a limited number of unsuccessful attempts before asking you to review the approach. Closing the service or switching off the computer suspends execution. Reopening recovers pending work without a catch-up burst. Ordinary user messages retain priority over new goal sessions.

This is a local trial. For an ordinary installation, see [START-HERE.md](START-HERE.md) after you have verified the package with its supplier.

Before completing a goal, Abralo runs a fresh independent reviewer against the outcome and each milestone's completion criteria. The reviewer uses the same model and existing read access but receives no prior conversation or native session. It inspects the actual deliverable in the lead's working folder. Concrete failures go back to the lead automatically; optional improvements do not expand scope. The Goals page briefly shows **Checking**, and completed goals expose their verification evidence under **Independently checked**. The row menu's **Check completion** requests the same review. A review failure or interruption never counts as completion.

Reviews are read-only: checks that require writing or additional authority return a specific verification task to the lead. Review quality still depends on the model and on clear criteria; a separate verdict is not a guarantee. Existing saved daily and session limits remain in force, including for review sessions.

Confirmed connected writes are deduplicated across sessions of the same goal. Unknown provider outcomes are preserved for inspection, never replayed automatically. This guarantee applies to Abralo's connected action ledger; shell commands and third-party tools still require inspection of their actual effects during recovery.
