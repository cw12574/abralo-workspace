# Reproduce the Beacon workflow

Build a local uptime monitor with three agents in one Abralo room, then inspect their review and changes. The recorded example used Codex. Your output, time and usage will vary; the agents are not expected to reproduce the same bug or byte-identical code.

## Before you start

Install [Abralo](../../docs/preview/START-HERE.md), connect a supported account and complete one small task. Read the [provider limitations](../../README.md#provider-support). This exercise makes real model calls using your account allowance or explicitly selected API billing. There is no fixed cost or completion-time estimate. Stop when you need to; the recorded run is evidence of one outcome, not a quota guarantee.

Use Node 24 to run the resulting project. No package installation is needed for the recorded Beacon implementation. Keep the project and HTTP fixtures local; do not deploy it or monitor a third party's service.

## 1. Make a fresh project

From a checkout of this repository:

```sh
node scripts/create-beacon-starter.mjs ../my-beacon
```

The command creates a **new** directory containing only the original `BRIEF.md` and this guide as `README.md`. It refuses to overwrite an existing directory. It does not install dependencies, launch agents, contact a provider or copy the completed solution.

You can also create an empty folder manually, copy [BRIEF.md](BRIEF.md) into it and follow the steps below. Keep this as an ordinary disposable folder for the exercise, so all three roles see the same files. Git repository tasks use separate worktrees; that is a different collaboration setup.

## 2. Set up the room

Create a project room named **Beacon** and three agents with these names and instructions. Use your connected provider and choose **Ask** in each agent's settings. Select the fresh folder as the room's working folder and grant access when prompted. Add the three agents to the room.

| Agent              | Role instructions                                                                                                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend engineer   | Read BRIEF.md. Own the root service, API contract, package scripts, README and Docker files. Agree API.md before handing off to Interface engineer. Keep public/ and tests/ for their owners. Report actual checks and limitations in the room. |
| Interface engineer | Read BRIEF.md and API.md. Own public/ only. Build the dashboard against the documented API, check what you can, and hand off to Reviewer in this room. Distinguish source inspection from browser verification.                                 |
| Reviewer           | Read BRIEF.md, API.md and the implementation. Own tests/ and REVIEW.md only. Add independent tests, report actual failures and limitations, and do not modify implementation files to make tests pass.                                          |

Folder selection is working context, not a security sandbox. Do not place credentials or important files in the exercise folder. Read permission requests before approving them.

## 3. Give the first task

Send this in the room, mentioning the actual Backend engineer agent:

> @Backend engineer build the local uptime monitor described in BRIEF.md. Agree API.md, then hand off the dashboard to Interface engineer, who should hand off to Reviewer. Use the role boundaries. Keep the work, handoffs and findings in this room. Do not browse, install dependencies, deploy or contact outside services. Use only controlled loopback HTTP fixtures for checks. Bring me the result and any unresolved issues.

Watch for the API handoff, the interface handoff and an independent review. If progress stalls, ask the responsible agent for its current blocker rather than starting a duplicate task. Use Stop in the conversation to cancel work; closing the browser tab does not stop agents.

## 4. Review, then revise

Inspect the generated files and `REVIEW.md`. Ask which checks actually ran and which could not. If the reviewer finds a defect, mention the owner in the room and request a narrow fix with the existing regression test preserved. If no defect is found, ask for a concrete missing boundary test; do not manufacture a failure for the demo.

Inspect package.json and the scripts before executing the generated project. For an output following the brief, run these commands in the new folder:

```sh
npm test
npm start
```

Open the loopback URL printed by the service. Use a local HTTP fixture you control to create a monitor, trigger an outage and recovery, and inspect the incident history. Ask for help in the room if the output differs from the brief. A passing test suite does not establish production readiness.

## What success looks like

- Backend and interface agree on an API and exchange an explicit handoff.
- A separate reviewer produces permanent tests and records limitations.
- You can inspect the monitor's source and run its tests locally.
- The local UI can create/check/delete a monitor and show an outage followed by recovery.
- You make the final decision, with any unresolved checks recorded.

The [recorded reference implementation](https://github.com/cw12574/abralo-workspace/tree/main/examples/beacon), [exact transcript](https://abralo.com/assets/demo/build-transcript.txt) and [read-only replay](https://abralo.com/replay.html) are available for comparison. The reference passed 17 tests; your independent build may organize its tests differently. Docker remained unverified in the recording. Keep the generated unauthenticated service on loopback; it is not suitable for public hosting.
