# Feature: Hub Core and Delivery Policy

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| APX-FR-01 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-FR-02 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-01 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-03 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-08 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-10 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-11 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| HC-FR-01 | This feature | owns |
| HC-FR-02 | This feature | owns |
| HC-FR-03 | This feature | owns |
| HC-FR-04 | This feature | owns |
| HC-FR-05 | This feature | owns |
| HC-FR-06 | This feature | owns |
| HC-FR-07 | This feature | owns |
| HC-FR-08 | This feature | owns |
| HC-FR-09 | This feature | owns |
| HC-FR-10 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Hub Core and Delivery Policy
**ID Prefix:** HC
**Summary:** The local daemon that owns the database, the loopback API, event intake, live state streaming and the decision of what gets delivered, so that a killed and restarted hub loses nothing and no route can ever steer an agent.
**Dependencies:** Event Model and Durable Log
**Priority:** Must

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| HC-US-01 | harness adapter author | post one event and get a fast, predictable answer | so that a busy agent session is never slowed or broken | Must |
| HC-US-02 | developer | restart or crash the hub at any moment | so that a pending block survives without me noticing | Must |
| HC-US-03 | security-conscious user | know that no route can drive my agents | so that an open loopback port is not a remote control | Must |

---

## 3. Functional Requirements

```forge-requirement
{"id":"HC-FR-01","kind":"requirement","text":"The Electron main process is the composition root: it enforces a single running instance, starts the store, binds the loopback server, registers every route and mounts the tray, and writes the live port to a runtime file the adapters read."}
```

```forge-requirement
{"id":"HC-FR-02","kind":"requirement","text":"Read routes return session summaries, one session with its recent events, the pending set, bounded event history, counters and health, and none of them mutates state."}
```

```forge-requirement
{"id":"HC-FR-03","kind":"requirement","text":"A server-sent event stream pushes state changes to connected dashboards with a periodic heartbeat, and a client reconnecting with a cursor receives the changes it missed."}
```

```forge-requirement
{"id":"HC-FR-04","kind":"requirement","text":"The ingest route accepts one normalized envelope, rejects malformed payloads and unknown harnesses with a client error, deduplicates by dedupe key, stores the classified event and answers 202 without waiting for delivery."}
```

```forge-requirement
{"id":"HC-FR-05","kind":"requirement","text":"The ack route marks one pending item acknowledged, answers not-found for an unknown identifier and conflict for an already resolved item, and every other mutating method or path is refused with a method-not-allowed or not-found response."}
```

```forge-requirement
{"id":"HC-FR-06","kind":"requirement","text":"The server binds 127.0.0.1 only, refuses any request whose remote address is not loopback, requires the per-install shared token on the write route, sends a strict content-security-policy with the dashboard, and sends no permissive cross-origin header."}
```

```forge-requirement
{"id":"HC-FR-07","kind":"requirement","text":"On start the hub replays unacknowledged pending items into the delivery pipeline exactly once, and its health route reports database, server and delivery status for the doctor command."}
```

```forge-requirement
{"id":"HC-FR-08","kind":"requirement","text":"Ingest is idempotent under replay, so re-posting an already stored envelope does not duplicate an event, change a pending count or fire a second delivery."}
```

```forge-requirement
{"id":"HC-FR-09","kind":"requirement","text":"Ingest never blocks or fails a calling session: every store and delivery step is time-bounded, a failure is recorded as a dropped event, and the caller is released with a success or a fast error."}
```

```forge-requirement
{"id":"HC-FR-10","kind":"requirement","text":"On a termination signal the hub stops accepting events, flushes counters, closes the database, removes the runtime file and exits, leaving no orphaned listener."}
```

**Priority:** every requirement in this feature is Must.

---

## 4. UI / Interaction Design

None of its own. The hub serves the dashboard page and the health payload the doctor command prints, and it owns no visual surface.

---

## 5. Implementation Tasks

Task review table, kept outside the phase contracts as authoring evidence.

| ID | Outcome | Owner | Needs | Files | Checks | Excluded |
|---|---|---|---|---|---|---|
| HC-1 | A running hub serves read routes on loopback from the main entry point | hub-engineer | EL-1 store, DP-1 scripts, Electron 44.4.5 | src/main/index.ts, src/hub/server.ts, src/hub/routes/read.ts, src/hub/runtime-file.ts, tests/hub/server.test.ts | server test through the main entry point; typecheck | No ingest, no tray, no notification |
| HC-2 | Dashboards receive live state changes with heartbeat and cursor replay | hub-engineer | HC-1 server | src/hub/sse.ts, src/hub/routes/stream.ts, tests/hub/stream.test.ts | stream test with a real client | No ingest, no delivery policy |
| HC-3 | One posted envelope becomes exactly one stored, classified event | hub-engineer | HC-1, EL-3, EL-4 | src/hub/routes/ingest.ts, src/hub/ingest-service.ts, tests/hub/ingest.test.ts | ingest tests including dedupe and rejection | No ack route, no delivery |
| HC-4 | Ack is the only mutation, and non-loopback and untokened writes are refused | hub-engineer | HC-3, EL-4 | src/hub/routes/ack.ts, src/hub/security.ts, tests/hub/ack.test.ts, tests/hub/security.test.ts | ack and security tests | No tray, no notification |
| HC-5 | Delivery is decided, replayed after restart, and shutdown is clean | hub-engineer | HC-3, HC-4, EL-4 | src/hub/delivery.ts, src/hub/lifecycle.ts, tests/hub/delivery.test.ts, tests/hub/lifecycle.test.ts | replay-once and shutdown tests | No platform notifier, no tray |
| HC-6 | Counters are recorded from real request paths and readable | hub-engineer | HC-1, EL-2 | src/hub/metrics.ts, src/hub/routes/metrics.ts, tests/hub/metrics.test.ts | metrics route test | No dashboard rendering |
| HC-7 | A human confirms the read-only promise and restart safety on the running hub | human reviewer | HC-5, HC-6 | docs/reviews/hub-core.json | recorded verdict plus the restart journey performed | No code changes |

### Phase 1: Process, read surface and live stream

```forge-task
{
  "id": "HC-1",
  "title": "Stand up the hub process and its read routes",
  "description": "Create the Electron main process as the composition root and give it a loopback HTTP server. The main entry point must enforce a single running instance, open the store, start the server, register the read routes and write the chosen port to a runtime file that adapters read, and it must serve the built dashboard from the same origin. Implement the read routes for session summaries, one session with recent events, the pending set, bounded history, counters and health, none of which may mutate state. Bind 127.0.0.1 only and fall back to the next free port when the default is taken, recording the live port in the runtime file. Add a test that boots the real main entry point against a temporary state directory and exercises the read routes over a real socket. Exclude ingest, the ack route, the tray and any notification.",
  "ownerAgent": "hub-engineer",
  "dependencies": ["DP-1", "EL-1"],
  "expectedOutputs": ["src/main/index.ts", "src/hub/server.ts", "src/hub/routes/read.ts", "src/hub/runtime-file.ts", "tests/hub/server.test.ts"],
  "validationCommands": ["npm test -- tests/hub/server.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/hub-core-and-delivery-policy.md#HC-FR-01", "docs/features/hub-core-and-delivery-policy.md#HC-FR-02"],
    "acceptanceCriteria": [
      "A test boots the real main entry point, reads the port from the runtime file and gets a session summary, a pending set and a health payload over a real loopback socket",
      "A test asserts a second instance refuses to start while the first holds the runtime file",
      "A test asserts the default port being occupied results in the next free port being used and recorded",
      "A test asserts no read route changes stored state, by comparing pending and event counts before and after every read request"
    ],
    "constraints": ["The hub binds to 127.0.0.1 only and rejects any connection whose remote address is not loopback", "agent-ping is a sidecar", "Node.js 22 LTS or newer with TypeScript and npm only"],
    "constraintRefs": ["docs/PRD.md#APX-CON-01", "docs/PRD.md#APX-CON-03", "docs/PRD.md#APX-CON-05", "docs/PRD.md#APX-CON-11"],
    "references": ["docs/PRD.md#6.3 Key APIs / Interfaces", "docs/features/hub-core-and-delivery-policy.md#3. Functional Requirements", "docs/IDEA.md#How It Connects"]
  }
}
```

```forge-task
{
  "id": "HC-2",
  "title": "Add the live state stream with heartbeat and cursor replay",
  "description": "Add a server-sent event stream to the existing server so dashboards update without polling. Emit a change frame for every state transition the store reports, send a periodic heartbeat so idle connections are not dropped, and accept a cursor so a client that reconnects receives the changes it missed rather than only new ones. Bound the replay window and say so in the response when a cursor is too old to replay, so a client can fall back to a full refresh instead of showing stale state. Add a test with a real client that asserts heartbeat frames arrive, changes arrive in order, and a reconnect with a cursor replays exactly the missed changes. Exclude ingest, delivery policy and any dashboard code.",
  "ownerAgent": "hub-engineer",
  "dependencies": ["HC-1"],
  "expectedOutputs": ["src/hub/sse.ts", "src/hub/routes/stream.ts", "tests/hub/stream.test.ts"],
  "validationCommands": ["npm test -- tests/hub/stream.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/hub-core-and-delivery-policy.md#HC-FR-03"],
    "acceptanceCriteria": [
      "A test with a real streaming client asserts a heartbeat frame arrives within the configured interval",
      "A test asserts a change is delivered in order and a reconnect carrying the last cursor replays exactly the missed changes",
      "A test asserts a cursor older than the replay window returns an explicit full-refresh signal rather than silent partial data"
    ],
    "constraints": ["Performance budgets: hub idle RSS at most 150 MB, live update visible within 250 ms of an accepted event"],
    "constraintRefs": ["docs/PRD.md#APX-CON-11"],
    "references": ["docs/PRD.md#6.3 Key APIs / Interfaces", "docs/features/hub-core-and-delivery-policy.md#3. Functional Requirements"]
  }
}
```

```forge-task
{
  "id": "HC-3",
  "title": "Build the ingest route and event pipeline",
  "description": "Build the ingest route on the existing server. Validate the incoming envelope, reject a malformed payload or an unknown harness with a client error, deduplicate by dedupe key, classify the event with the domain classifier, open or resolve a pending item through the pending lifecycle, store it and answer 202 without waiting for any delivery. Make the whole path time-bounded so a slow store or a slow delivery can never hold a calling session, and record a dropped event when storage fails instead of pretending it was stored. Re-posting an already stored envelope must be a no-op that does not duplicate an event, change the pending count or trigger a second delivery. Add tests for the happy path, malformed input, unknown harness, duplicate delivery and a forced store failure. Exclude the ack route, the tray and any notification.",
  "ownerAgent": "hub-engineer",
  "dependencies": ["HC-1", "EL-3", "EL-4"],
  "expectedOutputs": ["src/hub/routes/ingest.ts", "src/hub/ingest-service.ts", "tests/hub/ingest.test.ts"],
  "validationCommands": ["npm test -- tests/hub/ingest.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/hub-core-and-delivery-policy.md#HC-FR-04", "docs/features/hub-core-and-delivery-policy.md#HC-FR-08", "docs/features/hub-core-and-delivery-policy.md#HC-FR-09"],
    "acceptanceCriteria": [
      "A test posts a valid envelope and asserts one stored event, the expected class, and a 202 answer returned before any delivery work completes",
      "A test posts the same envelope twice and asserts one stored event and an unchanged pending count",
      "A test posts a malformed envelope and an unknown harness and asserts a client error with nothing stored",
      "A test forces a store failure and asserts a dropped event is recorded and the caller is released within the configured bound"
    ],
    "constraints": ["Harness delivery is fire-and-forget with a bounded timeout and no retry storm", "Performance budgets: local ingest p95 at most 50 ms"],
    "constraintRefs": ["docs/PRD.md#APX-CON-10", "docs/PRD.md#APX-CON-11"],
    "references": ["docs/features/hub-core-and-delivery-policy.md#3. Functional Requirements", "docs/PRD.md#6.3 Key APIs / Interfaces", "docs/IDEA.md#Availability Contract"]
  }
}
```

### Phase 2: Write surface, security, delivery and metrics

```forge-task
{
  "id": "HC-4",
  "title": "Add the ack-only write surface and its security boundary",
  "description": "Add the single mutating route to the existing server and the security boundary around it. The ack route marks one pending item acknowledged through the pending lifecycle, answers not-found for an unknown identifier and conflict for an already resolved item, and must not be able to change anything else. Refuse every other mutating method or path with method-not-allowed or not-found, and assert by test that no route exists which can spawn, steer, interrupt, prompt or approve anything. Reject any request whose remote address is not loopback, require the per-install shared token on the write route only, send a strict content-security-policy with the dashboard, and send no permissive cross-origin header. Add tests that walk every registered route and record which are read-only, plus tests for the refused methods, the non-loopback rejection and the missing token. Exclude the tray and any notification.",
  "ownerAgent": "hub-engineer",
  "dependencies": ["HC-3"],
  "expectedOutputs": ["src/hub/routes/ack.ts", "src/hub/security.ts", "tests/hub/ack.test.ts", "tests/hub/security.test.ts"],
  "validationCommands": ["npm test -- tests/hub/ack.test.ts tests/hub/security.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/hub-core-and-delivery-policy.md#HC-FR-05", "docs/features/hub-core-and-delivery-policy.md#HC-FR-06"],
    "acceptanceCriteria": [
      "A test enumerates every registered route and asserts the ack route is the only one that changes stored state",
      "A test asserts an unknown identifier answers not-found and an already resolved item answers conflict without changing state",
      "A test asserts a write without the shared token and a request from a non-loopback address are both refused",
      "A test asserts the dashboard response carries a strict content-security-policy and no permissive cross-origin header"
    ],
    "constraints": ["Exactly one mutating route exists, the ack route", "The hub binds to 127.0.0.1 only and rejects any connection whose remote address is not loopback"],
    "constraintRefs": ["docs/PRD.md#APX-CON-01", "docs/PRD.md#APX-CON-08"],
    "references": ["docs/PRD.md#8. Security and Privacy", "docs/features/hub-core-and-delivery-policy.md#3. Functional Requirements", "docs/IDEA.md#Boundaries"]
  }
}
```

```forge-task
{
  "id": "HC-5",
  "title": "Implement delivery policy, restart replay and clean shutdown",
  "description": "Implement the hub side of delivery and the availability contract on top of the existing routes. Decide from the classified event what must be delivered, exactly once per event, and hand it to the notifier boundary without implementing any platform notifier here. On start, replay unacknowledged pending items into that pipeline exactly once, so a hub that was killed while a block was pending delivers it again after restart. Track delivery outcomes per event for diagnostics, and extend the health route to report database, server and delivery status for the doctor command. Handle termination signals by refusing new events, flushing counters, closing the database, removing the runtime file and exiting with no orphaned listener. Add tests for single delivery, replay-once-after-restart and clean shutdown. Exclude platform notifiers, the tray and the dashboard.",
  "ownerAgent": "hub-engineer",
  "dependencies": ["HC-3", "HC-4", "EL-4"],
  "expectedOutputs": ["src/hub/delivery.ts", "src/hub/lifecycle.ts", "tests/hub/delivery.test.ts", "tests/hub/lifecycle.test.ts"],
  "validationCommands": ["npm test -- tests/hub/delivery.test.ts tests/hub/lifecycle.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/hub-core-and-delivery-policy.md#HC-FR-07", "docs/features/hub-core-and-delivery-policy.md#HC-FR-10", "docs/features/hub-core-and-delivery-policy.md#HC-FR-08"],
    "acceptanceCriteria": [
      "A test asserts one classified event produces exactly one delivery attempt",
      "A test kills the hub with an unacknowledged pending item, restarts it, and asserts the item is replayed exactly once into the pipeline",
      "A test asserts health reports database, server and delivery status, and that a forced notifier failure is visible there",
      "A test asserts a termination signal closes the listener, flushes counters, closes the database and removes the runtime file"
    ],
    "constraints": ["agent-ping is a sidecar", "A delivery failure is never silent"],
    "constraintRefs": ["docs/PRD.md#APX-CON-03", "docs/PRD.md#APX-CON-10"],
    "references": ["docs/PRD.md#10. System States / Lifecycle", "docs/features/hub-core-and-delivery-policy.md#3. Functional Requirements", "docs/IDEA.md#Availability Contract"]
  }
}
```

```forge-task
{
  "id": "HC-6",
  "title": "Expose the local metrics surface",
  "description": "Expose the counters the success bar needs on the existing server, and record them from the real request paths rather than from tests. Increment dashboard opens when a dashboard client connects, deep-link opens when a deep link is resolved, toast deliveries when the delivery pipeline reports an outcome, and record a pending-count snapshot whenever the pending set changes. Serve them from the existing metrics read route as counts and timestamps only, with no content and no per-request payload echo. Add a test asserting each counter increments through its real path and that the payload contains no field carrying event content. Exclude any external reporting, remote export or dashboard rendering.",
  "ownerAgent": "hub-engineer",
  "dependencies": ["HC-1", "EL-2"],
  "expectedOutputs": ["src/hub/metrics.ts", "src/hub/routes/metrics.ts", "tests/hub/metrics.test.ts"],
  "validationCommands": ["npm test -- tests/hub/metrics.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/hub-core-and-delivery-policy.md#HC-FR-02"],
    "acceptanceCriteria": [
      "A test asserts dashboard opens, deep-link opens and toast deliveries each increment through their real request path",
      "A test asserts the metrics payload contains counts and timestamps only and no field carrying event content"
    ],
    "constraints": ["No telemetry leaves the machine", "Never store or transmit conversation content"],
    "constraintRefs": ["docs/PRD.md#APX-CON-12", "docs/PRD.md#APX-CON-05"],
    "references": ["docs/PRD.md#11. Analytics / Success Metrics", "docs/features/event-model-and-durable-log.md#3. Functional Requirements"]
  }
}
```

### Phase 3: Read-only and restart-safety gate

```forge-task
{
  "id": "HC-7",
  "title": "Review the hub read-only promise and restart safety",
  "description": "Human review of the running hub. Start the hub against a temporary state directory, exercise the read routes and the ack route, and attempt the operations the product promises not to offer: steering, interrupting, prompting or approving anything in a harness. Kill the hub while a block is pending, restart it, and confirm the pending item, its history row and the pending count are intact and were not duplicated. Read the metrics and health routes and confirm they carry no content. Record every attempt, the observed result and the verdict in the review file, including any route the reviewer found that should not exist. Do not change code in this task.",
  "dependencies": ["HC-5", "HC-6"],
  "expectedOutputs": [],
  "validationCommands": [],
  "contract": {
    "version": 2,
    "kind": "human-review",
    "requirements": [],
    "requirementRefs": ["docs/features/hub-core-and-delivery-policy.md#HC-FR-05", "docs/features/hub-core-and-delivery-policy.md#HC-FR-06", "docs/features/hub-core-and-delivery-policy.md#HC-FR-08", "docs/features/hub-core-and-delivery-policy.md#HC-FR-10"],
    "acceptanceCriteria": [
      "The reviewer ran the hub, completed the journey of reading state, acknowledging a pending item, killing and restarting the hub, and stated in the notes what was observed after restart",
      "The reviewer attempted each forbidden operation and recorded the observed refusal for every one",
      "The reviewer confirmed the metrics and health payloads carry no conversation content",
      "The reviewer recorded a verdict on whether the read-only promise holds"
    ],
    "constraints": ["A subjective judgement never stands alone; the journey must have been performed against the running hub"],
    "constraintRefs": ["docs/PRD.md#APX-CON-08", "docs/PRD.md#APX-CON-03"],
    "reviewFile": "docs/reviews/hub-core.json",
    "references": ["docs/PRD.md#8. Security and Privacy", "docs/PRD.md#10. System States / Lifecycle", "docs/IDEA.md#Boundaries"]
  }
}
```

---

## 6. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Integration | Server, routes, ingest, ack | Boot the real main entry point against a temporary state directory, talk to it over a real loopback socket |
| Unit | Ingest pipeline, dedupe, delivery policy, security predicates | Pure functions with an injected store and notifier boundary |
| Streaming | Server-sent events | Real streaming client asserting heartbeat, ordering and cursor replay |
| Lifecycle | Restart and shutdown | Kill and restart the process, assert pending and history survive exactly once |
| Manual | Read-only promise | Human gate attempting the forbidden operations against the running hub |

Key test scenarios:

1. A valid envelope is stored, classified and answered 202 before delivery runs.
2. The same envelope twice yields one event and an unchanged pending count.
3. Ack is the only state-changing route; every other mutating request is refused.
4. A non-loopback request and a write without the shared token are both refused.
5. The hub is killed with a pending item, restarted, and replays it exactly once.

---

## 7. Acceptance Criteria

1. The hub boots from its main entry point, serves every read route on loopback, and writes the live port to a runtime file.
2. Ingest validates, deduplicates, classifies, stores and answers 202 without blocking the caller.
3. Ack is the only mutating route and cannot affect a harness.
4. Pending state and delivery replay survive a kill and restart exactly once.
5. Termination leaves no listener, no runtime file and an openable database.
6. A human review file records the read-only verdict and the restart journey.

---

## 8. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should the loopback port be fixed or discovered? | Fixed default with automatic next-free fallback, recorded in a runtime file the adapters read |
| 2 | How long should a write token live and how is it rotated? | A random token in a 0600 file in the state directory, regenerated by reinstall |
| 3 | What heartbeat interval and replay window keep the stream cheap? | Heartbeat at 25 seconds, replay window of five minutes, both asserted by tests |
| 4 | Is a strict content-security-policy compatible with the PixiJS bundle? | Yes with no inline script; if a build needs one, the policy is narrowed explicitly rather than relaxed |
