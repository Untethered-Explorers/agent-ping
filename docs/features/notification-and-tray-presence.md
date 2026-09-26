# Feature: Notification and Tray Presence

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| APX-US-02 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-04 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-06 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-11 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| NT-FR-01 | This feature | owns |
| NT-FR-02 | This feature | owns |
| NT-FR-03 | This feature | owns |
| NT-FR-04 | This feature | owns |
| NT-FR-05 | This feature | owns |
| NT-FR-06 | This feature | owns |
| NT-FR-07 | This feature | owns |
| NT-FR-08 | This feature | owns |
| NT-FR-09 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Notification and Tray Presence
**ID Prefix:** NT
**Summary:** The part that actually reaches the developer: one lingering toast when a session is blocked, one expiring toast when a session finishes, in-app-only reporting for everything else, and a tray or menu-bar icon whose badge carries the durable pending count so nothing depends on catching a moment.
**Dependencies:** Hub Core and Delivery Policy
**Priority:** Must

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| NT-US-01 | developer in the middle of something else | get one unmissable toast when a session needs a decision from me | so that I find out without watching any window | Must |
| NT-US-02 | developer who already dealt with it | see the badge drop to zero without dismissing anything | so that I am not nagged for a block that no longer exists | Must |
| NT-US-03 | developer on macOS or Windows | get the same three-class behaviour as on Linux | so that the tool is not a different product per platform | Should |

---

## 3. Functional Requirements

```forge-requirement
{"id":"NT-FR-01","kind":"requirement","text":"A notifier interface takes a delivery request carrying class, title, body, urgency, deep link and persistence, and returns a delivery outcome that records success or failure with a reason."}
```

```forge-requirement
{"id":"NT-FR-02","kind":"requirement","text":"On Linux a toast is delivered through notify-send and libnotify, a needs-you toast requests a non-auto-dismissing resident notification, a finished toast auto-expires, and an fyi request is refused because it never leaves the app."}
```

```forge-requirement
{"id":"NT-FR-03","kind":"requirement","text":"On macOS a toast is delivered through a notification-centre call with the same three-class policy, and the implementation is explicit that it is not live-verified on the authoring machine."}
```

```forge-requirement
{"id":"NT-FR-04","kind":"requirement","text":"On Windows a toast is delivered through a PowerShell notification with the same three-class policy, and the implementation is explicit that it is not live-verified on the authoring machine."}
```

```forge-requirement
{"id":"NT-FR-05","kind":"requirement","text":"A tray or menu-bar icon is present for as long as the hub runs, and its badge shows the number of unacknowledged pending items, with no badge shown at zero and a capped marker above ninety-nine."}
```

```forge-requirement
{"id":"NT-FR-06","kind":"requirement","text":"The tray icon offers exactly two menu actions, open the dashboard and quit, and no mute, snooze or dismiss control that could let a pending block be forgotten silently."}
```

```forge-requirement
{"id":"NT-FR-07","kind":"requirement","text":"Every toast carries a deep link to its session, and opening that link focuses the session in the dashboard and counts as a dashboard open."}
```

```forge-requirement
{"id":"NT-FR-08","kind":"requirement","text":"No repeat timer exists: one needs-you toast is delivered per block, and the badge and history carry persistence instead of re-firing."}
```

```forge-requirement
{"id":"NT-FR-09","kind":"requirement","text":"Every delivery outcome is recorded with its reason, and a failure is visible in the doctor output rather than only in a log line."}
```

**Priority:** every requirement in this feature is Must, except NT-FR-03 and NT-FR-04 which are Should because they can only be confirmed on their own platforms.

---

## 4. UI / Interaction Design

A toast is two lines: the repository short name as the title, and one sentence naming the kind of block as the body. No counts in the toast, no stack of text, no buttons. The tray icon is a single quiet glyph whose badge is the only moving part, so the persistent signal is a number rather than a demand. The dashboard the tray opens is owned by the Live Dashboard feature; this feature only guarantees the link resolves.

---

## 5. Implementation Tasks

Task review table, kept outside the phase contracts as authoring evidence.

| ID | Outcome | Owner | Needs | Files | Checks | Excluded |
|---|---|---|---|---|---|---|
| NT-1 | One delivery request becomes one platform toast with the right class policy | notification-engineer | HC-5 delivery pipeline | src/notify/types.ts, policy.ts, linux.ts, registry.ts, tests/notify/policy.test.ts, tests/notify/linux.test.ts | policy tests; exact notify-send argument test | No macOS, no Windows, no tray |
| NT-2 | macOS and Windows notifiers build the same requests behind the same interface | notification-engineer | NT-1 interface | src/notify/macos.ts, windows.ts, tests/notify/macos.test.ts, tests/notify/windows.test.ts, docs/runbooks/notify-platforms.md | exact argument and payload tests; documented verification state | No live run on those platforms |
| NT-3 | The tray shows a live pending badge and opens the dashboard | notification-engineer | HC-1 read routes, HC-6, NT-1 | src/hub/tray.ts, src/tray/badge.ts, src/main/index.ts, tests/hub/tray.test.ts, tests/tray/badge.test.ts | tray test through the main entry point | No dashboard rendering |
| NT-4 | A human confirms real toast and badge behaviour on Linux | human reviewer | NT-1, NT-3 | docs/reviews/notification-linux.json | recorded verdict plus the live journey | No code changes |
| NT-5 | A human confirms real toast and badge behaviour on macOS and Windows | human reviewer | NT-2, NT-3 | docs/reviews/notification-macos-windows.json | recorded verdict from those machines | Not completable on Linux alone |

### Phase 1: Notifier and toast policy

```forge-task
{
  "id": "NT-1",
  "title": "Define the notifier interface and the Linux notifier",
  "description": "Define the notifier interface and implement the Linux notifier behind the delivery boundary the hub already calls. A delivery request carries class, title, body, urgency, deep link and persistence; the notifier returns an outcome recording success or failure with a reason. Implement the class policy as pure code: a needs-you request is delivered with a non-auto-dismissing resident notification, a finished request is delivered and allowed to expire, and an fyi request is refused because it never leaves the app. Build the notify-send invocation as an inspectable argument list rather than a shell string, construct the notifier for the current platform in the Electron main entry point and pass it to the delivery pipeline, and record every outcome. Add tests asserting the policy decisions, the exact argument list for each class, that the main entry point wires the platform notifier into delivery, and that a failing notify-send is reported as a failure with a reason. Exclude macOS, Windows and the tray.",
  "ownerAgent": "notification-engineer",
  "dependencies": ["HC-5"],
  "expectedOutputs": ["src/notify/types.ts", "src/notify/policy.ts", "src/notify/linux.ts", "src/notify/registry.ts", "src/main/index.ts", "tests/notify/policy.test.ts", "tests/notify/linux.test.ts", "tests/notify/registry-selection.test.ts"],
  "validationCommands": ["npm test -- tests/notify/policy.test.ts tests/notify/linux.test.ts tests/notify/registry-selection.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/notification-and-tray-presence.md#NT-FR-01", "docs/features/notification-and-tray-presence.md#NT-FR-02", "docs/features/notification-and-tray-presence.md#NT-FR-08", "docs/features/notification-and-tray-presence.md#NT-FR-09"],
    "acceptanceCriteria": [
      "A test asserts an fyi request is refused by policy and never reaches a platform notifier",
      "A test asserts the needs-you request sets the resident, non-auto-dismissing flags and the finished request does not",
      "A test asserts the notify-send argument list contains no shell interpolation of the title or body",
      "A test asserts the main entry point constructs the platform notifier and the delivery pipeline uses it",
      "A test asserts a non-zero exit from the notifier is recorded as a failure with a reason rather than swallowed"
    ],
    "constraints": ["No sound in v1", "No repeat timer exists: one needs-you toast per block"],
    "constraintRefs": ["docs/PRD.md#APX-CON-04"],
    "references": ["docs/PRD.md#16. Open Questions", "docs/features/notification-and-tray-presence.md#3. Functional Requirements", "docs/IDEA.md#What Earns An Interruption"]
  }
}
```

```forge-task
{
  "id": "NT-2",
  "title": "Add the macOS and Windows notifiers",
  "description": "Add the macOS and Windows notifier implementations behind the existing interface, applying the same three-class policy rather than a second policy. Build each platform invocation as an inspectable argument list, assert the exact arguments and payload shape in unit tests, and register both in the platform registry alongside Linux. Write a runbook that states, per platform, the exact command a developer can run to reproduce a toast by hand, which parts are covered by automated tests here, and which parts can only be confirmed on that platform. Be explicit in the runbook and in the code that these two paths are not live-verified on the authoring machine, so nothing downstream treats them as proven. Exclude the tray and any live run on those platforms.",
  "ownerAgent": "notification-engineer",
  "dependencies": ["NT-1"],
  "expectedOutputs": ["src/notify/macos.ts", "src/notify/windows.ts", "tests/notify/macos.test.ts", "tests/notify/windows.test.ts", "docs/runbooks/notify-platforms.md"],
  "validationCommands": ["npm test -- tests/notify/macos.test.ts tests/notify/windows.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/notification-and-tray-presence.md#NT-FR-03", "docs/features/notification-and-tray-presence.md#NT-FR-04", "docs/features/notification-and-tray-presence.md#NT-FR-01"],
    "acceptanceCriteria": [
      "A test asserts the macOS invocation argument list and payload shape for each class, including the refusal of fyi",
      "A test asserts the Windows invocation argument list and payload shape for each class, including the refusal of fyi",
      "A test asserts the platform registry resolves exactly one notifier per supported platform and reports an explicit unsupported result elsewhere",
      "The runbook names the manual command per platform and states that these paths are not live-verified on the authoring machine"
    ],
    "constraints": ["Platform support is Linux, macOS and Windows in v1", "No sound in v1"],
    "constraintRefs": ["docs/PRD.md#APX-CON-06", "docs/PRD.md#APX-CON-04"],
    "references": ["docs/PRD.md#16. Open Questions", "docs/features/notification-and-tray-presence.md#8. Open Questions", "docs/IDEA.md#Where The Surface Lives"]
  }
}
```

### Phase 2: Tray presence

```forge-task
{
  "id": "NT-3",
  "title": "Add the tray icon with its pending-count badge",
  "description": "Add persistent tray or menu-bar presence to the running hub. The icon exists for as long as the hub runs, its badge shows the number of unacknowledged pending items read from the hub's own pending route, nothing is drawn at zero, and counts above ninety-nine render a capped marker. Keep the badge a pure function of the pending set so it can be tested without a desktop. Offer exactly two menu actions, open the dashboard and quit, and deliberately provide no mute, snooze or dismiss control. Clicking the icon or the menu action resolves the dashboard deep link, which focuses that session and counts as a dashboard open. Mount the tray from the Electron main entry point and list that file as an output so the wiring is part of this task, with a test that drives the badge and the click handler through it. Exclude dashboard rendering.",
  "ownerAgent": "notification-engineer",
  "dependencies": ["NT-1", "HC-1", "HC-6"],
  "expectedOutputs": ["src/hub/tray.ts", "src/tray/badge.ts", "src/main/index.ts", "tests/hub/tray.test.ts", "tests/tray/badge.test.ts"],
  "validationCommands": ["npm test -- tests/hub/tray.test.ts tests/tray/badge.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/notification-and-tray-presence.md#NT-FR-05", "docs/features/notification-and-tray-presence.md#NT-FR-06", "docs/features/notification-and-tray-presence.md#NT-FR-07"],
    "acceptanceCriteria": [
      "A test asserts the badge renders zero pending items as no badge, a small count as that count, and a count above ninety-nine as the capped marker",
      "A test asserts the tray menu exposes exactly open-dashboard and quit and no suppression control",
      "A test asserts clicking the icon resolves a deep link that focuses the session and increments the deep-link counter",
      "A test drives the tray through the main entry point and asserts the badge follows the pending set returned by the hub"
    ],
    "constraints": ["No sound in v1", "No telemetry leaves the machine"],
    "constraintRefs": ["docs/PRD.md#APX-CON-04", "docs/PRD.md#APX-CON-12"],
    "references": ["docs/features/notification-and-tray-presence.md#4. UI / Interaction Design", "docs/PRD.md#16. Open Questions", "docs/IDEA.md#Where The Surface Lives"]
  }
}
```

### Phase 3: Live notification gates

```forge-task
{
  "id": "NT-4",
  "title": "Verify real toasts and the badge on Linux",
  "description": "Human review of the real notification behaviour on Linux. With the hub running and the notifier wired, drive a real needs-you event and a real finished event and confirm on screen that the needs-you toast does not auto-dismiss and the finished toast expires on its own. Use the manual commands recorded in docs/runbooks/notify-platforms.md to reproduce each toast by hand as well. Confirm the badge increments when a block appears, decrements when the block is resolved in the harness, and decrements when the item is acknowledged from the dashboard. Confirm clicking the tray icon opens the dashboard focused on that session, and confirm nothing occupied screen space before the first event. Record every observation, including timings and any platform hint that had to be adjusted, in the review file. Do not change code in this task; record required changes instead.",
  "dependencies": ["NT-1", "NT-3"],
  "expectedOutputs": [],
  "validationCommands": [],
  "contract": {
    "version": 2,
    "kind": "human-review",
    "requirements": [],
    "requirementRefs": ["docs/features/notification-and-tray-presence.md#NT-FR-02", "docs/features/notification-and-tray-presence.md#NT-FR-05", "docs/features/notification-and-tray-presence.md#NT-FR-07", "docs/features/notification-and-tray-presence.md#NT-FR-08"],
    "acceptanceCriteria": [
      "The reviewer observed a real needs-you toast stay on screen and a real finished toast expire, and stated how each was produced",
      "The reviewer observed the badge increment, then decrement on harness resolution, and separately decrement on acknowledgement",
      "The reviewer clicked the tray icon and confirmed the dashboard opened focused on that session",
      "The reviewer recorded which libnotify hints were required for the resident behaviour on this desktop"
    ],
    "constraints": ["A subjective visual judgement never stands alone; the journey must have been performed on the running system"],
    "constraintRefs": ["docs/PRD.md#APX-CON-06"],
    "reviewFile": "docs/reviews/notification-linux.json",
    "references": ["docs/features/notification-and-tray-presence.md#3. Functional Requirements", "docs/features/notification-and-tray-presence.md#4. UI / Interaction Design", "docs/PRD.md#11. Analytics / Success Metrics"]
  }
}
```

```forge-task
{
  "id": "NT-5",
  "title": "Verify real toasts and the badge on macOS and Windows",
  "description": "Human review of the same notification behaviour on macOS and on Windows, performed on those machines. Install the package, drive a real needs-you event and a real finished event using the manual commands in docs/runbooks/notify-platforms.md, and confirm the same three-class policy holds: the needs-you toast persists until dealt with, the finished toast expires, and nothing appears for an fyi event. Confirm the tray or menu-bar badge increments and decrements with the pending set, and that the two menu actions are the only ones present. Record per platform the exact command used, the observed behaviour, and any platform-specific mechanism that had to replace the assumed one. This gate cannot be completed from a Linux machine and must be run where those platforms exist; record it as outstanding rather than approximating it. Do not change code in this task.",
  "dependencies": ["NT-2", "NT-3"],
  "expectedOutputs": [],
  "validationCommands": [],
  "contract": {
    "version": 2,
    "kind": "human-review",
    "requirements": [],
    "requirementRefs": ["docs/features/notification-and-tray-presence.md#NT-FR-03", "docs/features/notification-and-tray-presence.md#NT-FR-04", "docs/features/notification-and-tray-presence.md#NT-FR-05"],
    "acceptanceCriteria": [
      "For each of macOS and Windows the reviewer recorded the command used, the observed toast persistence per class, and the badge behaviour",
      "For each platform the reviewer recorded whether the assumed notification mechanism worked or had to be replaced",
      "Where a platform was unavailable the review records the gate as outstanding with the reason, rather than reporting a pass"
    ],
    "constraints": ["Platform support is Linux, macOS and Windows in v1", "A subjective visual judgement never stands alone; the journey must have been performed on the running system"],
    "constraintRefs": ["docs/PRD.md#APX-CON-06"],
    "reviewFile": "docs/reviews/notification-macos-windows.json",
    "references": ["docs/features/notification-and-tray-presence.md#3. Functional Requirements", "docs/PRD.md#16. Open Questions", "docs/features/notification-and-tray-presence.md#8. Open Questions"]
  }
}
```

---

## 6. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Class policy, argument construction, badge rendering | Pure functions over an injected spawner and an injected pending set |
| Integration | Notifier registry and outcome recording | Real subprocess invocation for Linux, fake for the other platforms |
| Manual | Toast persistence and badge behaviour | Human gates against the real desktop notification service |
| Regression | No repeat, no sound | Policy tests asserting one delivery per block and no sound-capable argument anywhere |

Key test scenarios:

1. An fyi request is refused by policy and never spawns a notifier.
2. A needs-you request produces the resident, non-auto-dismissing argument list.
3. The badge renders zero, a small count and the capped marker above ninety-nine.
4. The tray menu exposes exactly two actions and no suppression control.
5. A real toast persists for needs-you and expires for finished on Linux.

---

## 7. Acceptance Criteria

1. One needs-you toast per block, never repeated by a timer, with no sound on any class.
2. The tray badge is always equal to the unacknowledged pending count and reaches zero when the last item is resolved or acknowledged.
3. Every toast deep-links to its session and opening the link focuses it.
4. macOS and Windows implementations exist behind the same interface with documented, unproven-here verification state.
5. Both platform review files record real observations, and the Linux one is complete.

---

## 8. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Which libnotify hint set makes a toast resident on the target desktops? | Critical urgency plus the resident hint, confirmed by the Linux gate rather than assumed |
| 2 | Does macOS allow a notification that persists until acted on? | Not through the basic notification call; the badge carries persistence there and the runbook records what was actually achieved |
| 3 | Should the badge be a native platform count or a drawn count? | Drawn into the icon image so one implementation serves all three platforms |
| 4 | Is a quit action in the tray menu safe while blocks are pending? | Yes, because pending state is durable and returns after restart; the menu copy says so |
