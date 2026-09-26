# Feature: Live Dashboard

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| APX-US-02 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-US-03 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-07 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-08 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-09 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-11 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| LD-FR-01 | This feature | owns |
| LD-FR-02 | This feature | owns |
| LD-FR-03 | This feature | owns |
| LD-FR-04 | This feature | owns |
| LD-FR-05 | This feature | owns |
| LD-FR-06 | This feature | owns |
| LD-FR-07 | This feature | owns |
| LD-FR-08 | This feature | owns |
| LD-FR-09 | This feature | owns |
| LD-FR-10 | This feature | owns |
| LD-FR-11 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Live Dashboard
**ID Prefix:** LD
**Summary:** The on-demand PixiJS surface the developer lands on, wired to real hub state: repositories grouped with their sessions, urgency that survives without colour, a keyboard and screen-reader path that mirrors the canvas, one acknowledgement control, and a handoff that leaves the agent alone.
**Dependencies:** Dashboard Design Prototype, Hub Core and Delivery Policy, Notification and Tray Presence
**Priority:** Must

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| LD-US-01 | developer returning from a toast | see which repository is asking for me first | so that I know where to go before I read anything | Must |
| LD-US-02 | developer who has already dealt with it | clear a pending item without leaving the page | so that the badge and the page never disagree | Must |
| LD-US-03 | keyboard or screen reader user | get the same information and the same actions as a mouse user sees | so that the canvas is not a dead end | Must |

---

## 3. Functional Requirements

```forge-requirement
{"id":"LD-FR-01","kind":"requirement","text":"The dashboard groups sessions under a repository short-name header, nests each session beneath it, and reveals the full path on hover or focus without using it as the primary label."}
```

```forge-requirement
{"id":"LD-FR-02","kind":"requirement","text":"Each row states its condition as blocked, finished, running or information-only using an icon and a text label, never colour alone, and the visual treatment is stable across all four states."}
```

```forge-requirement
{"id":"LD-FR-03","kind":"requirement","text":"The dashboard subscribes to the hub state stream, updates on change, reconnects with a cursor, and shows an explicit stale or disconnected state rather than presenting old data as current."}
```

```forge-requirement
{"id":"LD-FR-04","kind":"requirement","text":"The pending count is displayed on the page and always equals the tray badge for the same hub state."}
```

```forge-requirement
{"id":"LD-FR-05","kind":"requirement","text":"Acknowledging from the dashboard is the only write the page performs, it updates optimistically, and it corrects itself to the server's answer when the acknowledgement is refused."}
```

```forge-requirement
{"id":"LD-FR-06","kind":"requirement","text":"Opening a toast deep link focuses and highlights that specific session, and the focus survives a later live update."}
```

```forge-requirement
{"id":"LD-FR-07","kind":"requirement","text":"Each row offers a handoff that reveals the attach command for the session so the developer can open it in their own terminal, and the page contains no control that sends, interrupts or approves anything in a harness."}
```

```forge-requirement
{"id":"LD-FR-08","kind":"requirement","text":"A history view lists past events with class, repository, session, timestamp and acknowledgement or resolution state, and shows no conversation content."}
```

```forge-requirement
{"id":"LD-FR-09","kind":"requirement","text":"A visually hidden focusable DOM mirror of every visible row carries accessible names, state and grouping; the page is fully keyboard operable; the reduced-motion preference is honoured; and text meets AA contrast."}
```

```forge-requirement
{"id":"LD-FR-10","kind":"requirement","text":"The same build is served over the loopback origin and loaded in the application window, and both render identical state for identical hub data."}
```

```forge-requirement
{"id":"LD-FR-11","kind":"requirement","text":"Information-only events appear inside the dashboard and never as a toast or a badge change."}
```

**Priority:** every requirement in this feature is Must.

---

## 4. UI / Interaction Design

The approved prototype is the layout; this feature changes only what live data requires. Rows group under a muted repository header, each row carrying a state icon, a text state label, an age, and a one-line status. Blocked rows sit at the top of their group because they are the only ones that can need something. The pending count sits in the page header next to the connection state, so a disconnected page cannot be mistaken for a quiet one. Acknowledgement is a single control on a blocked row; handoff reveals a copyable command rather than a button that runs anything. The history view is a second panel, not a new page, so the developer never loses their place.

---

## 5. Implementation Tasks

Task review table, kept outside the phase contracts as authoring evidence.

| ID | Outcome | Owner | Needs | Files | Checks | Excluded |
|---|---|---|---|---|---|---|
| LD-1 | The page renders live hub state grouped by repository and shows staleness | dashboard-engineer | DP-2 mount entry, HC-2 stream, HC-1 reads | src/dashboard/index.html, main.ts, live/stream-client.ts, live/session-list.ts, tests/dashboard/session-list.test.ts, tests/dashboard/stream-client.test.ts | stream and grouping tests through the entry point | No acknowledgement, no history, no tray |
| LD-2 | Every row is reachable and legible without a mouse or colour | dashboard-engineer | LD-1, DP-3 mirror pattern | src/dashboard/main.ts, a11y/dom-mirror.ts, a11y/keyboard-nav.ts, tests/dashboard/live-dom-mirror.test.ts | mirror and keyboard tests on live data | No styling beyond state and contrast |
| LD-3 | Ack, deep-link focus, handoff and history work against the real API | dashboard-engineer | LD-1, HC-4 ack | src/dashboard/live/ack.ts, deeplink.ts, handoff.ts, history.ts, src/dashboard/main.ts, tests/dashboard/live-interactions.test.ts | interaction tests including refused ack | No agent control of any kind |
| LD-4 | A browser-driven journey proves the page against the running hub | qa-engineer | LD-2, LD-3, HC-1 | playwright.config.ts, tests/e2e/dashboard.spec.ts, scripts/verify-dashboard-e2e.mjs | end-to-end journey run | No human judgement |
| LD-5 | A human confirms the primary journey and the design still works | human reviewer | LD-4, NT-4, DP-4 | docs/reviews/live-dashboard.json | recorded verdict plus the journey performed | No code changes |

### Phase 1: Live state on the approved layout

```forge-task
{
  "id": "LD-1",
  "title": "Wire the dashboard to live hub state",
  "description": "Replace the prototype's mock source with the real hub feed while keeping the approved layout. Implement a stream client that subscribes to the hub state stream, applies incoming changes, reconnects with the last cursor, and falls back to a full refresh when the cursor is too old. Implement the session list that groups sessions under their repository short-name header, nests each session beneath it, reveals the full path on hover or focus, orders blocked sessions first within a group, and renders the four states with an icon and a text label. Show the pending count in the page header and an explicit stale or disconnected state, never silent old data. Mount everything from the dashboard entry point, which is also the page the hub serves, and list that entry point as an output so the wiring belongs to this task. Add tests driving the entry point against a stubbed hub for the initial render, a live update, a reconnect and a disconnect. Exclude acknowledgement, deep links, handoff and history.",
  "ownerAgent": "dashboard-engineer",
  "dependencies": ["DP-2", "HC-1", "HC-2"],
  "expectedOutputs": ["src/dashboard/index.html", "src/dashboard/main.ts", "src/dashboard/live/stream-client.ts", "src/dashboard/live/session-list.ts", "tests/dashboard/session-list.test.ts", "tests/dashboard/stream-client.test.ts"],
  "validationCommands": ["npm test -- tests/dashboard/session-list.test.ts tests/dashboard/stream-client.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/live-dashboard.md#LD-FR-01", "docs/features/live-dashboard.md#LD-FR-02", "docs/features/live-dashboard.md#LD-FR-03", "docs/features/live-dashboard.md#LD-FR-04", "docs/features/live-dashboard.md#LD-FR-10"],
    "acceptanceCriteria": [
      "A test drives the entry point against a stubbed hub and asserts sessions render under repository short-name headers with blocked rows first",
      "A test asserts a state change updates the affected row without a full reload and a disconnect shows an explicit stale state",
      "A test asserts a reconnect with a cursor resumes updates and a too-old cursor triggers a full refresh",
      "A test asserts the displayed pending count equals the pending set returned by the hub"
    ],
    "constraints": ["Canvas paired with a visually hidden focusable DOM mirror, reduced motion honoured, AA contrast", "Identity is the repository short name", "Performance budgets: dashboard first paint at most 1 s from warm cache, live update visible within 250 ms of an accepted event"],
    "constraintRefs": ["docs/PRD.md#APX-CON-07", "docs/PRD.md#APX-CON-09", "docs/PRD.md#APX-CON-11"],
    "references": ["docs/features/live-dashboard.md#4. UI / Interaction Design", "docs/features/dashboard-design-prototype.md#4. UI / Interaction Design", "docs/features/dashboard-design-prototype.md#8. Open Questions"]
  }
}
```

```forge-task
{
  "id": "LD-2",
  "title": "Carry the accessibility pattern onto live data",
  "description": "Apply the prototype's accessibility pattern to the live dashboard. Build a visually hidden but focusable DOM mirror that contains one entry per visible row with its accessible name, state, repository grouping and pending state, and keep the mirror in the same order as the canvas. Make the whole page keyboard operable: rows are focusable in visual order, activation is observable, and the focused row survives a live update arriving underneath it. Honour the reduced-motion preference for every transition the live feed can trigger, including a newly arrived blocked row, and assert the text contrast tokens used by the live theme meet AA against their actual backgrounds. Mount the mirror and the keyboard controller from the live entry point and list that file as an output. Add jsdom tests against live-shaped data covering mirror contents and ordering, keyboard traversal, focus retention across an update, and the reduced-motion path. Exclude visual restyling beyond state encoding and contrast.",
  "ownerAgent": "dashboard-engineer",
  "dependencies": ["LD-1", "DP-3"],
  "expectedOutputs": ["src/dashboard/main.ts", "src/dashboard/a11y/dom-mirror.ts", "src/dashboard/a11y/keyboard-nav.ts", "tests/dashboard/live-dom-mirror.test.ts"],
  "validationCommands": ["npm test -- tests/dashboard/live-dom-mirror.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/live-dashboard.md#LD-FR-09", "docs/features/live-dashboard.md#LD-FR-02"],
    "acceptanceCriteria": [
      "A jsdom test mounts the live entry point with live-shaped data and asserts one focusable mirror entry per visible row in canvas order",
      "A jsdom test asserts each mirror entry exposes an accessible name, its state text and its repository grouping",
      "A jsdom test asserts the focused row keeps focus when a live update arrives for a different row",
      "A test asserts a newly arrived blocked row produces no movement when reduced motion is requested"
    ],
    "constraints": ["Canvas paired with a visually hidden focusable DOM mirror, reduced motion honoured, AA contrast"],
    "constraintRefs": ["docs/PRD.md#APX-CON-07"],
    "references": ["docs/features/live-dashboard.md#4. UI / Interaction Design", "docs/PRD.md#9. Accessibility", "docs/features/dashboard-design-prototype.md#3. Functional Requirements"]
  }
}
```

### Phase 2: Interactions against the real API

```forge-task
{
  "id": "LD-3",
  "title": "Add acknowledgement, deep-link focus, handoff and history",
  "description": "Add the page's interactions against the real hub API. Acknowledgement posts to the single write route, updates the row optimistically, and reverts to the server's state when the acknowledgement is refused, with the refusal visible rather than swallowed. Deep links resolve to a specific session, focus and highlight it, and the focus survives later live updates. Handoff reveals the attach command for a session as text to copy, and the page must contain no control that sends a prompt, interrupts a session or approves anything. The history panel lists past events with class, repository, session, timestamp and acknowledgement or resolution state, and never renders conversation content. Mount all four from the live entry point and list it as an output. Add tests for a successful ack, a refused ack, deep-link focus, the absence of any agent-control control, and a history payload containing no content fields. Exclude the tray and the notifier.",
  "ownerAgent": "dashboard-engineer",
  "dependencies": ["LD-1", "HC-4"],
  "expectedOutputs": ["src/dashboard/live/ack.ts", "src/dashboard/live/deeplink.ts", "src/dashboard/live/handoff.ts", "src/dashboard/live/history.ts", "src/dashboard/main.ts", "tests/dashboard/live-interactions.test.ts"],
  "validationCommands": ["npm test -- tests/dashboard/live-interactions.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/live-dashboard.md#LD-FR-05", "docs/features/live-dashboard.md#LD-FR-06", "docs/features/live-dashboard.md#LD-FR-07", "docs/features/live-dashboard.md#LD-FR-08", "docs/features/live-dashboard.md#LD-FR-11"],
    "acceptanceCriteria": [
      "A test asserts a successful acknowledgement removes the pending marker and updates the pending count",
      "A test asserts a refused acknowledgement restores the prior state and shows the refusal",
      "A test asserts a deep link focuses and highlights its session and the focus survives a later update",
      "A test asserts the rendered controls contain no send, interrupt or approve action and that handoff exposes the command as text",
      "A test asserts the history panel renders class, repository, session, timestamp and state and no content field"
    ],
    "constraints": ["Exactly one mutating route exists, the ack route", "Information-only events appear inside the dashboard and never as a toast or a badge change"],
    "constraintRefs": ["docs/PRD.md#APX-CON-08"],
    "references": ["docs/features/live-dashboard.md#4. UI / Interaction Design", "docs/PRD.md#6.3 Key APIs / Interfaces", "docs/IDEA.md#Boundaries"]
  }
}
```

### Phase 3: End-to-end journey and review

```forge-task
{
  "id": "LD-4",
  "title": "Prove the dashboard journey in a real browser",
  "description": "Add a browser-driven end-to-end suite that runs against the real hub rather than a mock server. Start the hub against a temporary state directory, serve the built dashboard, drive one needs-you event through the ingest route, and assert the new blocked row appears, the pending count increments, a keyboard-only path can reach and activate the row, the acknowledgement clears it, and the history panel then shows it. Assert the page reports a stale state when the stream is interrupted, and that a deep link opens the dashboard focused on the expected session. Fail on zero executed tests and print which journeys ran, so a green result cannot mean nothing was exercised. Add a repository script that installs the browser if needed and runs the suite, failing loudly when the browser cannot be obtained rather than skipping. Exclude human judgement.",
  "ownerAgent": "qa-engineer",
  "dependencies": ["LD-2", "LD-3", "HC-1"],
  "expectedOutputs": ["playwright.config.ts", "tests/e2e/dashboard.spec.ts", "scripts/verify-dashboard-e2e.mjs"],
  "validationCommands": ["npm test -- tests/e2e/dashboard.spec.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/live-dashboard.md#LD-FR-03", "docs/features/live-dashboard.md#LD-FR-05", "docs/features/live-dashboard.md#LD-FR-09", "docs/features/live-dashboard.md#LD-FR-10"],
    "acceptanceCriteria": [
      "The suite fails when no test executes and prints the journeys it ran",
      "A journey asserts a real ingested needs-you event produces a blocked row, an incremented pending count and a keyboard-reachable row",
      "A journey asserts acknowledgement clears the row and the history panel then lists it",
      "A journey asserts an interrupted stream produces a visible stale state rather than stale data presented as current"
    ],
    "constraints": ["Never invent passing results, tool availability, deployed resources, human review or compliance"],
    "constraintRefs": ["docs/PRD.md#APX-CON-11"],
    "references": ["docs/PRD.md#16. Open Questions", "docs/features/live-dashboard.md#6. Testing Strategy", "docs/IDEA.md#Where The Surface Lives"]
  }
}
```

```forge-task
{
  "id": "LD-5",
  "title": "Review the primary dashboard journey",
  "description": "Human review of the live dashboard as the surface the developer actually lands on. Complete the primary journey end to end against the running system with a real pending block: notice the badge or toast, open the dashboard from the tray, identify which repository is asking, read the blocked row, acknowledge it, and hand the session off to a terminal. Then repeat the journey with the keyboard only, and once more with a screen reader if available, and record what each pass could and could not reach. Judge whether the approved design survived contact with real data, including repositories with many sessions and a long history. Record every observation and the verdict in the review file, listing any required change rather than making it. Do not change code in this task.",
  "dependencies": ["LD-4", "NT-4", "DP-4"],
  "expectedOutputs": [],
  "validationCommands": [],
  "contract": {
    "version": 2,
    "kind": "human-review",
    "requirements": [],
    "requirementRefs": ["docs/features/live-dashboard.md#LD-FR-01", "docs/features/live-dashboard.md#LD-FR-05", "docs/features/live-dashboard.md#LD-FR-09", "docs/features/live-dashboard.md#LD-FR-10"],
    "acceptanceCriteria": [
      "The reviewer performed the mouse journey, the keyboard-only journey and, where available, a screen-reader pass, and stated in the notes what each could reach",
      "The reviewer confirmed the dashboard opened from the tray focused on the right session and that the pending count matched the badge throughout",
      "The reviewer exercised a repository with several sessions and a long history and recorded whether density still holds",
      "The reviewer recorded a verdict and every required change as an explicit list"
    ],
    "constraints": ["A subjective visual judgement never stands alone; the journey must have been performed against the running system"],
    "constraintRefs": ["docs/PRD.md#APX-CON-07"],
    "reviewFile": "docs/reviews/live-dashboard.json",
    "references": ["docs/features/live-dashboard.md#4. UI / Interaction Design", "docs/PRD.md#11. Analytics / Success Metrics", "docs/IDEA.md#Success"]
  }
}
```

---

## 6. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Grouping, ordering, state encoding, pending count | Pure functions over live-shaped fixtures shared with the prototype |
| DOM | Mirror contents, keyboard traversal, focus retention | jsdom against the live entry point |
| Component | Ack, deep link, handoff, history | Stubbed hub responses including a refused acknowledgement |
| End-to-end | The primary journey | Playwright against the running hub and the served build |
| Manual | Density and reachability | Human gate with mouse, keyboard and screen-reader passes |

Key test scenarios:

1. An ingested needs-you event produces a blocked row and an incremented pending count.
2. A refused acknowledgement restores the prior state and shows the refusal.
3. A deep link focuses its session and the focus survives a later update.
4. An interrupted stream shows a stale state instead of stale data.
5. A keyboard-only pass can reach and activate every row.

---

## 7. Acceptance Criteria

1. The page renders live hub state grouped by repository with blocked rows first and a pending count matching the badge.
2. Every row is reachable and legible by keyboard and through the DOM mirror, with reduced motion honoured.
3. Acknowledgement is the only write, deep links focus their session, handoff exposes a command, and history shows no content.
4. The same build renders identically in the application window and in a browser on the loopback origin.
5. The end-to-end suite passes against the running hub and the human review file records all three access passes.

---

## 8. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Does the approved prototype layout survive repositories with many sessions? | Tested in the review with a busy fixture; the layout changes only if that review fails |
| 2 | Should history be a panel or a separate view? | A panel, so the developer never loses their place in the list |
| 3 | How is deep-link focus expressed when the target session has since disappeared? | Show an explicit row saying the session is gone rather than silently focusing nothing |
| 4 | Is a screen-reader pass part of acceptance or best effort? | Best effort in v1, recorded either way, because the DOM mirror is what makes it possible |
