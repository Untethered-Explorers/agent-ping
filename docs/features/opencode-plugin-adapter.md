# Feature: opencode Plugin Adapter

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| APX-US-01 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-FR-01 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-FR-02 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-03 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-10 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-13 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| OA-FR-01 | This feature | owns |
| OA-FR-02 | This feature | owns |
| OA-FR-03 | This feature | owns |
| OA-FR-04 | This feature | owns |
| OA-FR-05 | This feature | owns |
| OA-FR-06 | This feature | owns |
| OA-FR-07 | This feature | owns |
| OA-FR-08 | This feature | owns |
| OA-FR-09 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** opencode Plugin Adapter
**ID Prefix:** OA
**Summary:** One globally installed opencode plugin that turns opencode's own events into the normalized envelope and pushes them at the loopback hub, with a visible breadcrumb when the hub is not there and a polling fallback for anything that cannot push.
**Dependencies:** Hub Core and Delivery Policy
**Priority:** Must

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| OA-US-01 | developer with twenty repositories open | install the plugin once globally | so that no session is invisible because a repo was never configured | Must |
| OA-US-02 | developer whose hub is not running | see why a notification did not appear | so that a missed block is never silently dropped | Must |
| OA-US-03 | opencode user | be unaffected if the plugin or the hub disappears | so that my agent sessions keep working exactly as before | Must |

---

## 3. Functional Requirements

```forge-requirement
{"id":"OA-FR-01","kind":"requirement","text":"The adapter is a single global plugin file installed into the opencode global plugin directory, loaded by opencode 1.18.32 for every session without any per-repository configuration file."}
```

```forge-requirement
{"id":"OA-FR-02","kind":"requirement","text":"The adapter subscribes through the generic event hook and maps session status and idle transitions, permission asked and replied, session errors, compaction, message updates, tool execution boundaries and todo updates onto the normalized envelope, because the dedicated permission hook is documented as not firing."}
```

```forge-requirement
{"id":"OA-FR-03","kind":"requirement","text":"The adapter tracks whether the current turn performed real work, meaning at least one tool call, file edit or todo update, and reports that signal with each idle transition so the hub can suppress a greeting-and-close turn."}
```

```forge-requirement
{"id":"OA-FR-04","kind":"requirement","text":"Each event is delivered to the hub fire-and-forget with a short bounded timeout and no retry storm, and a delivery failure never throws back into the harness."}
```

```forge-requirement
{"id":"OA-FR-05","kind":"requirement","text":"When the hub is unreachable the adapter writes a breadcrumb through the harness structured logging client, naming the service, the session and the event type, so the failure is visible in the harness's own interface rather than swallowed."}
```

```forge-requirement
{"id":"OA-FR-06","kind":"requirement","text":"Repository identity is the directory basename of the session, and the full path travels with every event without ever being used as the primary label."}
```

```forge-requirement
{"id":"OA-FR-07","kind":"requirement","text":"A polling fallback reads the local opencode HTTP API for active sessions, idle waits and pending permission requests with bounded backoff, and deduplicates what it finds against events already pushed."}
```

```forge-requirement
{"id":"OA-FR-08","kind":"requirement","text":"Installing the plugin is idempotent, and uninstalling removes the installed file and leaves no orphan, verified by a test against a temporary home directory."}
```

```forge-requirement
{"id":"OA-FR-09","kind":"requirement","text":"The adapter works identically for interactive, non-interactive and attached sessions, and adds no per-repository setup that a developer could forget."}
```

**Priority:** every requirement in this feature is Must.

---

## 4. UI / Interaction Design

None. The only user-visible surface is the breadcrumb, and it is deliberately the harness's own log and notification area rather than anything this product draws.

---

## 5. Implementation Tasks

Task review table, kept outside the phase contracts as authoring evidence.

| ID | Outcome | Owner | Needs | Files | Checks | Excluded |
|---|---|---|---|---|---|---|
| OA-1 | Documented opencode events map onto the normalized envelope | connector-engineer | HC-3 ingest contract, EL-3 envelope | src/plugin/opencode/index.ts, translate.ts, work-signal.ts, tests/plugin/opencode-translate.test.ts, tests/plugin/opencode-work-signal.test.ts | translation table tests; work-signal tests | No delivery, no install, no polling |
| OA-2 | Events reach the hub fast, or leave a breadcrumb | connector-engineer | OA-1, HC-4 token and port | src/plugin/transport/http.ts, breadcrumb.ts, tests/plugin/transport.test.ts | transport and breadcrumb tests | No install, no polling |
| OA-3 | One global file is installed and removed idempotently | connector-engineer | OA-1 | src/plugin/install/global-plugin.ts, tests/plugin/install.test.ts | install and uninstall tests against a temporary home | No CLI wiring, no autostart |
| OA-4 | Polled state is captured and deduplicated | connector-engineer | OA-1, HC-3 | src/plugin/opencode/poll-fallback.ts, tests/plugin/poll-fallback.test.ts | polling and dedupe tests | No CLI wiring, no live run |
| OA-5 | A repository script drives a real opencode session end to end | qa-engineer | OA-2, OA-3, OA-4, NT-1 | scripts/verify-opencode-live.mjs, tests/scripts/verify-opencode-live.test.ts | script test with a fake harness plus a documented real run | No human judgement |
| OA-6 | A human confirms a real session is caught end to end | human reviewer | OA-5, NT-4 | docs/reviews/opencode-adapter.json | recorded verdict plus the live journey | No code changes |

### Phase 1: Event translation and delivery

```forge-task
{
  "id": "OA-1",
  "title": "Translate opencode events into the normalized envelope",
  "description": "Implement the opencode plugin as a single module that subscribes through the generic event hook and translates harness events into the normalized envelope the hub already accepts. Cover session status and the deprecated idle event as the same transition, permission asked and replied as a block and its resolution, and session error, compaction, message update, tool execution boundary and todo update as fyi with the matching subtype. Track per-turn work signals so an idle transition reports whether the turn made at least one tool call, file edit or todo update, which is what lets the hub suppress a greeting-and-close turn. Derive repository identity from the session directory basename and carry the full path alongside it. Log through the harness structured logging client with this product's service name, never the console. Add a table-driven test covering every documented event name and a test for the work-signal accumulator across a turn boundary. Exclude delivery to the hub, installation and polling.",
  "ownerAgent": "connector-engineer",
  "dependencies": ["HC-3", "EL-3"],
  "expectedOutputs": ["src/plugin/opencode/index.ts", "src/plugin/opencode/translate.ts", "src/plugin/opencode/work-signal.ts", "tests/plugin/opencode-translate.test.ts", "tests/plugin/opencode-work-signal.test.ts"],
  "validationCommands": ["npm test -- tests/plugin/opencode-translate.test.ts tests/plugin/opencode-work-signal.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/opencode-plugin-adapter.md#OA-FR-02", "docs/features/opencode-plugin-adapter.md#OA-FR-03", "docs/features/opencode-plugin-adapter.md#OA-FR-06", "docs/features/opencode-plugin-adapter.md#OA-FR-09"],
    "acceptanceCriteria": [
      "A table-driven test asserts every documented opencode event name maps to the expected class, subtype and dedupe key",
      "A test asserts the deprecated idle event and the status transition produce one envelope rather than two",
      "A test asserts a turn with a tool call, a file edit or a todo update reports work, and a turn with none reports no work",
      "A test asserts the work signal resets at a turn boundary so a later empty turn is not credited with earlier work",
      "A test asserts logging goes through the harness logging client with the product's service name and never writes to the console"
    ],
    "constraints": ["The connector interface is specified in Agent Client Protocol terms", "Never store or transmit conversation content", "Identity is the repository short name"],
    "constraintRefs": ["docs/PRD.md#APX-CON-13", "docs/PRD.md#APX-CON-09", "docs/PRD.md#APX-CON-12"],
    "references": ["docs/PRD.md#5. Research Findings", "docs/features/opencode-plugin-adapter.md#3. Functional Requirements", "docs/IDEA.md#Scope"]
  }
}
```

```forge-task
{
  "id": "OA-2",
  "title": "Deliver events to the hub and leave a breadcrumb on failure",
  "description": "Deliver translated envelopes to the loopback hub from inside the harness process. Read the live port from the hub runtime file rather than assuming the default, attach the per-install shared token, and post each envelope with a short bounded timeout and no retry loop, so a busy or wedged hub can never slow a session. Never throw back into the harness: catch every failure, and when the hub is unreachable write a breadcrumb through the harness structured logging client naming the service, the session and the event type, so the developer sees the reason in the harness's own interface. Add tests asserting a single request per event, a bounded timeout on a hung server, no retry storm, and a breadcrumb written with the expected fields when the hub refuses the connection. Exclude installation and the polling fallback.",
  "ownerAgent": "connector-engineer",
  "dependencies": ["OA-1", "HC-4"],
  "expectedOutputs": ["src/plugin/transport/http.ts", "src/plugin/transport/breadcrumb.ts", "tests/plugin/transport.test.ts"],
  "validationCommands": ["npm test -- tests/plugin/transport.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/opencode-plugin-adapter.md#OA-FR-04", "docs/features/opencode-plugin-adapter.md#OA-FR-05", "docs/PRD.md#APX-FR-02"],
    "acceptanceCriteria": [
      "A test asserts exactly one request is made per event and no retry follows a refused connection",
      "A test asserts a hung server is abandoned at the configured timeout rather than blocking the caller",
      "A test asserts a breadcrumb is written with the service, session and event type when the hub is unreachable",
      "A test asserts no transport failure propagates an exception out of the plugin hook"
    ],
    "constraints": ["Harness delivery is fire-and-forget with a bounded timeout and no retry storm", "A delivery failure is never silent"],
    "constraintRefs": ["docs/PRD.md#APX-CON-10", "docs/PRD.md#APX-CON-03"],
    "references": ["docs/PRD.md#6.3 Key APIs / Interfaces", "docs/features/opencode-plugin-adapter.md#3. Functional Requirements", "docs/IDEA.md#Availability Contract"]
  }
}
```

```forge-task
{
  "id": "OA-3",
  "title": "Install and remove the global plugin idempotently",
  "description": "Implement the installer for the global opencode plugin as a reusable module the CLI will call later. Write exactly one plugin file plus the package metadata the global plugin directory needs into the opencode global plugin directory, replacing an existing copy of the same version without duplicating it, and refuse to overwrite a different version without saying so. Implement removal that deletes the installed file and leaves no orphan, and is safe to run when nothing is installed. Resolve the global directory from the platform configuration path rather than a hard-coded string, and verify the written file loads as a plugin module. Add tests for fresh install, repeat install, version mismatch and uninstall against a temporary home directory. Exclude the agent-ping command-line entry points and any autostart work.",
  "ownerAgent": "connector-engineer",
  "dependencies": ["OA-1"],
  "expectedOutputs": ["src/plugin/install/global-plugin.ts", "tests/plugin/install.test.ts"],
  "validationCommands": ["npm test -- tests/plugin/install.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/opencode-plugin-adapter.md#OA-FR-01", "docs/features/opencode-plugin-adapter.md#OA-FR-08"],
    "acceptanceCriteria": [
      "A test installs into a temporary home and asserts exactly one plugin file and its metadata exist afterwards",
      "A test installs twice and asserts no duplicate file and no error",
      "A test asserts a different installed version is reported rather than silently overwritten",
      "A test uninstalls and asserts the file is gone and a second uninstall is a safe no-op"
    ],
    "constraints": ["agent-ping is a sidecar"],
    "constraintRefs": ["docs/PRD.md#APX-CON-03"],
    "references": ["docs/PRD.md#5. Research Findings", "docs/features/opencode-plugin-adapter.md#3. Functional Requirements", "docs/IDEA.md#How It Connects"]
  }
}
```

### Phase 2: Polling fallback and live verification

```forge-task
{
  "id": "OA-4",
  "title": "Add the polling fallback for non-pushing sessions",
  "description": "Add the fallback path for anything that cannot push. Poll the local opencode HTTP API for active sessions, wait for a session to reach idle, and list pending permission requests, using bounded exponential backoff and a hard cap on consecutive failures so a stopped server is not hammered. Start the fallback from the plugin entry point when push delivery is unavailable, so it is actually running rather than merely present. Deduplicate everything discovered against envelopes already pushed, using the same dedupe keys, so a session that both pushes and is polled never produces two events. Treat an unexpected response shape as a failure that is reported, not as an empty result that hides a contract change. Add tests for backoff, the failure cap, dedupe against pushed events and the unexpected-shape failure. Exclude the CLI entry points and any live harness run.",
  "ownerAgent": "connector-engineer",
  "dependencies": ["OA-1", "HC-3"],
  "expectedOutputs": ["src/plugin/opencode/poll-fallback.ts", "src/plugin/opencode/index.ts", "tests/plugin/poll-fallback.test.ts"],
  "validationCommands": ["npm test -- tests/plugin/poll-fallback.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/opencode-plugin-adapter.md#OA-FR-07"],
    "acceptanceCriteria": [
      "A test asserts backoff grows between failures and stops at the configured cap",
      "A test asserts a state already delivered by push is not delivered again by polling",
      "A test asserts an unexpected response shape is reported as a failure rather than an empty result",
      "A test asserts the fallback never blocks the harness loop it runs in"
    ],
    "constraints": ["Harness delivery is fire-and-forget with a bounded timeout and no retry storm", "A delivery failure is never silent"],
    "constraintRefs": ["docs/PRD.md#APX-CON-10"],
    "references": ["docs/PRD.md#16. Open Questions", "docs/features/opencode-plugin-adapter.md#3. Functional Requirements", "docs/IDEA.md#How It Connects"]
  }
}
```

```forge-task
{
  "id": "OA-5",
  "title": "Write the live opencode verification script",
  "description": "Write one repository script that proves the adapter against the real harness rather than a mock. It installs the plugin into a temporary configuration directory, starts the hub against a temporary state directory, launches a real opencode session that reaches a permission decision and then goes idle, and asserts the hub received a needs-you envelope, a resolution and one finished envelope with the correct repository short name. It must also assert the reverse: a session that opens, greets and closes produces no finished envelope and no card on the notification surface, and a hub that is not running produces a breadcrumb rather than a silent drop. Print a machine-readable summary of what was observed and exit non-zero on any failed assertion, with no path that reports success when nothing ran. Cover the script's own logic with a test that drives it against a stub harness. Exclude human judgement and any code change to the product.",
  "ownerAgent": "qa-engineer",
  "dependencies": ["OA-2", "OA-3", "OA-4", "NT-8"],
  "expectedOutputs": ["scripts/verify-opencode-live.mjs", "tests/scripts/verify-opencode-live.test.ts"],
  "validationCommands": ["npm test -- tests/scripts/verify-opencode-live.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/opencode-plugin-adapter.md#OA-FR-01", "docs/features/opencode-plugin-adapter.md#OA-FR-09", "docs/features/opencode-plugin-adapter.md#OA-FR-05"],
    "acceptanceCriteria": [
      "A test drives the script against a stub harness and asserts it fails when the expected envelopes are missing",
      "A test asserts the script exits non-zero when the hub is absent and records the breadcrumb instead of reporting success",
      "The script asserts a permission-then-idle session produces a needs-you envelope, a resolution and exactly one finished envelope",
      "The script asserts an open-greet-close session produces no finished envelope and no card on the notification surface"
    ],
    "constraints": ["Never invent passing results, tool availability, deployed resources, human review or compliance"],
    "constraintRefs": ["docs/PRD.md#APX-CON-03"],
    "references": ["docs/PRD.md#5. Research Findings", "docs/features/opencode-plugin-adapter.md#6. Testing Strategy", "docs/IDEA.md#Availability Contract"]
  }
}
```

### Phase 3: Live adapter gate

```forge-task
{
  "id": "OA-6",
  "title": "Confirm a real opencode session is caught end to end",
  "description": "Human review of the adapter against the real harness on a real repository. Install the plugin globally, start the hub, and run an ordinary opencode session that asks for a permission decision. Confirm from the harness's own interface and from the dashboard that exactly one card appeared on the notification surface for the block, that the tray badge went to one, and that answering the permission cleared it without a second card. Confirm also that the operating system's own notification centre showed nothing at all, because this product renders the card itself. Then run a session that does real work and confirm exactly one finished card, and run a session that opens and closes without work and confirm nothing appeared at all: no card, no window, no badge change, no history row. Finally stop the hub and confirm a blocked session leaves a visible breadcrumb rather than failing silently, and confirm the plugin does not measurably slow the session. Record every observation, the commands used and the verdict in the review file. Do not change code in this task.",
  "dependencies": ["OA-5", "NT-9"],
  "expectedOutputs": [],
  "validationCommands": [],
  "contract": {
    "version": 2,
    "kind": "human-review",
    "requirements": [],
    "requirementRefs": ["docs/features/opencode-plugin-adapter.md#OA-FR-01", "docs/features/opencode-plugin-adapter.md#OA-FR-02", "docs/features/opencode-plugin-adapter.md#OA-FR-05", "docs/features/opencode-plugin-adapter.md#OA-FR-09"],
    "acceptanceCriteria": [
      "The reviewer ran a real session that asked for a permission decision and stated what appeared, how many times, and how the badge behaved",
      "The reviewer confirmed the operating system's notification centre showed nothing, since the card is rendered by agent-ping rather than handed to the platform",
      "The reviewer ran a session that did real work and an open-greet-close session and stated the observed difference",
      "The reviewer stopped the hub, blocked a session, and confirmed a visible breadcrumb rather than a silent drop",
      "The reviewer recorded the commands used and a verdict, including any event the adapter failed to report"
    ],
    "constraints": ["A subjective judgement never stands alone; the journey must have been performed against the running system"],
    "constraintRefs": ["docs/PRD.md#APX-CON-10"],
    "reviewFile": "docs/reviews/opencode-adapter.json",
    "references": ["docs/PRD.md#11. Analytics / Success Metrics", "docs/features/opencode-plugin-adapter.md#3. Functional Requirements", "docs/IDEA.md#Success"]
  }
}
```

---

## 6. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Event translation, work signals, dedupe keys | Table-driven cases over the documented opencode event names |
| Unit | Transport and breadcrumbs | Injected fetch and injected logging client, including a hung server |
| Integration | Install and uninstall | Real filesystem against a temporary home directory |
| Live | Real opencode session | Repository script driving the actual binary, asserting hub-side receipt |
| Manual | End-to-end feel and no slowdown | Human gate on a real repository |

Key test scenarios:

1. Every documented opencode event maps to one expected envelope.
2. A hung hub is abandoned at the timeout with one breadcrumb and no retry storm.
3. A repeated install leaves one file; uninstall leaves none.
4. A permission-then-idle session produces a block, a resolution and exactly one finished event.
5. An open-greet-close session produces no event at all.

---

## 7. Acceptance Criteria

1. One globally installed plugin file covers every repository, with no per-repository configuration.
2. All documented opencode events are translated, including the deprecated idle event without double counting.
3. Delivery is bounded, never throws into the harness, and always leaves a breadcrumb on failure.
4. The polling fallback discovers state, dedupes against pushed events and cannot hammer a stopped server.
5. The live script passes against the real binary, and the human review file records the journey.

---

## 8. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Are the opencode HTTP fallback route shapes and payload fields exactly as documented? | Parsed defensively; an unexpected shape is a loud failure, and the live script proves the real shape |
| 2 | Does the status event fully replace the deprecated idle event in practice? | Both are handled and deduplicated, so either firing produces one transition |
| 3 | Is the work-signal definition sufficient to tell real work from a greeting? | Tool call, file edit or todo update, reviewed against real sessions during the live gate |
| 4 | Should the plugin also be published to npm for opencode's plugin loader? | No; a global file is enough for one user and avoids a registry dependency |
