# Feature: Event Model and Durable Log

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| APX-FR-01 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-FR-02 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-12 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| EL-FR-01 | This feature | owns |
| EL-FR-02 | This feature | owns |
| EL-FR-03 | This feature | owns |
| EL-FR-04 | This feature | owns |
| EL-FR-05 | This feature | owns |
| EL-FR-06 | This feature | owns |
| EL-FR-07 | This feature | owns |
| EL-FR-08 | This feature | owns |
| EL-FR-09 | This feature | owns |
| EL-FR-10 | This feature | owns |
| EL-FR-11 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Event Model and Durable Log
**ID Prefix:** EL
**Summary:** The vocabulary and the storage that everything else depends on: one normalized event envelope, one classification into the three loudness classes, one pending lifecycle, and a SQLite log that records that something happened and never what was said.
**Dependencies:** None
**Priority:** Must

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| EL-US-01 | developer | see that a session was blocked, when, and whether I dealt with it | so that a missed block is still visible after the fact | Must |
| EL-US-02 | implementer of any adapter | hand one envelope to the hub and get one class back | so that a new harness needs no hub change | Must |
| EL-US-03 | security-conscious user | have the log schema provably incapable of holding conversation content | so that the privacy claim is testable rather than promised | Must |

---

## 3. Functional Requirements

```forge-requirement
{"id":"EL-FR-01","kind":"requirement","text":"The normalized envelope carries harness, session identifier, repository short name and full path, raw event type, class, optional subtype, ISO 8601 UTC occurrence and receipt timestamps, and a dedupe key. It has no field capable of holding a prompt, response, tool output or file content."}
```

```forge-requirement
{"id":"EL-FR-02","kind":"requirement","text":"The durable schema has versioned migrations applied at startup and holds session summaries, events and counters, indexed by session and occurrence time and by class and acknowledgement state."}
```

```forge-requirement
{"id":"EL-FR-03","kind":"requirement","text":"An automated test asserts the exact column set of every table, so adding a content-bearing column fails the build rather than silently violating the privacy boundary."}
```

```forge-requirement
{"id":"EL-FR-04","kind":"requirement","text":"Classification maps harness events to exactly one of three classes, needs-you, finished or fyi, with fyi carrying a subtype of error, retry, long-tool-call, compaction or token-burn."}
```

```forge-requirement
{"id":"EL-FR-05","kind":"requirement","text":"A session that goes idle having performed no work in the turn, meaning no tool call, no file edit and no todo update, produces no event at all."}
```

```forge-requirement
{"id":"EL-FR-06","kind":"requirement","text":"A session that goes idle after work produces exactly one finished event per idle transition, and stays silent until the session resumes."}
```

```forge-requirement
{"id":"EL-FR-07","kind":"requirement","text":"A block produces one needs-you event per unresolved block, deduplicated by session and block identifier, and a second permission ask for the same block never produces a second event."}
```

```forge-requirement
{"id":"EL-FR-08","kind":"requirement","text":"A pending item stays pending until the harness reports the block resolved or the developer acknowledges it. No other transition clears it, and it survives hub restart unchanged."}
```

```forge-requirement
{"id":"EL-FR-09","kind":"requirement","text":"Retention prunes events older than thirty days while keeping at least the most recent five hundred per session, and never prunes an unacknowledged pending item."}
```

```forge-requirement
{"id":"EL-FR-10","kind":"requirement","text":"Local counters record dashboard opens, toast deliveries, deep-link opens and pending-count snapshots, hold no content, and are readable through one read-only accessor."}
```

```forge-requirement
{"id":"EL-FR-11","kind":"requirement","text":"The store resolves its database file from a platform state directory that tests can redirect, applies migrations idempotently on every open, and recreates the database from migrations when the file is unreadable rather than refusing to start."}
```

**Priority:** every requirement in this feature is Must.

---

## 4. UI / Interaction Design

None. This feature is the vocabulary the dashboard later renders, so its field names are chosen to be display-ready: the envelope carries exactly what a row needs and nothing more.

---

## 5. Implementation Tasks

Task review table, kept outside the phase contracts as authoring evidence.

| ID | Outcome | Owner | Needs | Files | Checks | Excluded |
|---|---|---|---|---|---|---|
| EL-1 | A migrated database with a provably content-free schema and a usable store API | domain-engineer | DP-1 scripts, better-sqlite3 13.0.3 | src/storage/schema.sql, db.ts, paths.ts, eventStore.ts, tests/storage/schema.test.ts, tests/storage/eventStore.test.ts | schema column-set test; store round-trip test | No classification, no HTTP, no dashboard |
| EL-2 | Retention and counters operate on the real schema | domain-engineer | EL-1 store API | src/storage/retention.ts, counters.ts, tests/storage/retention.test.ts, tests/storage/counters.test.ts | retention boundary tests; counter accessor test | No delivery, no UI |
| EL-3 | Any harness event maps to exactly one class, subtype and dedupe key | domain-engineer | EL-1 envelope shape, DP-1 scripts | src/domain/envelope.ts, classify.ts, tests/domain/classify.test.ts | classification table tests including the idle-after-nothing case | No persistence writes, no notification |
| EL-4 | Pending items resolve or acknowledge exactly once and survive a reopen | domain-engineer | EL-3 classification, EL-2 store | src/domain/pending.ts, tests/domain/pending.test.ts | pending lifecycle tests across reopen | No HTTP, no tray, no toast |

### Phase 1: Durable store

```forge-task
{
  "id": "EL-1",
  "title": "Create the content-free schema and store API",
  "description": "Define the durable schema as versioned SQL migrations and wrap it in a small store API. Create session summaries, events and counters with indexes on session and occurrence time and on class and acknowledgement state, and a schema version record. Resolve the database file from an overridable platform state directory so tests can redirect it to a temporary path, apply migrations idempotently on every open, and rebuild the database from migrations when the existing file cannot be read. Add a test that asserts the exact column set of every table so a content-bearing column fails the build. Expose only typed accessors: insert event, read pending, mark resolved, mark acknowledged, read session summaries. Exclude classification rules, HTTP and any dashboard code.",
  "ownerAgent": "domain-engineer",
  "dependencies": ["DP-1"],
  "expectedOutputs": ["src/storage/schema.sql", "src/storage/db.ts", "src/storage/paths.ts", "src/storage/eventStore.ts", "tests/storage/schema.test.ts", "tests/storage/eventStore.test.ts"],
  "validationCommands": ["npm test -- tests/storage/schema.test.ts tests/storage/eventStore.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/event-model-and-durable-log.md#EL-FR-02", "docs/features/event-model-and-durable-log.md#EL-FR-03", "docs/features/event-model-and-durable-log.md#EL-FR-11", "docs/PRD.md#APX-FR-01"],
    "acceptanceCriteria": [
      "A test asserts the exact column list of every table and fails if any column name suggests stored content",
      "A test opens a store twice against the same temporary path and asserts migrations are idempotent",
      "A test corrupts the database file and asserts the store rebuilds from migrations rather than throwing",
      "A round-trip test inserts an event and reads back the session summary and pending row"
    ],
    "constraints": ["Never store or transmit conversation content", "No telemetry leaves the machine", "Node.js 22 LTS or newer with TypeScript and npm only"],
    "constraintRefs": ["docs/PRD.md#APX-CON-05", "docs/PRD.md#APX-CON-12"],
    "references": ["docs/PRD.md#6.2 Project Structure", "docs/features/event-model-and-durable-log.md#3. Functional Requirements", "docs/IDEA.md#Boundaries"]
  }
}
```

```forge-task
{
  "id": "EL-2",
  "title": "Add retention pruning and local counters",
  "description": "Add retention and counters on top of the existing store API. Prune events older than thirty days while always keeping at least the most recent five hundred per session, and never pruning a row that is an unacknowledged pending item. Add one counter accessor for dashboard opens, toast deliveries, deep-link opens and pending-count snapshots, stored locally with no content. Cover the boundary cases with tests: exactly-thirty-day rows, the per-session floor, an old pending item that must survive, and counters that survive a reopen. Expose a single read-only accessor for counters rather than a query surface. Exclude delivery, HTTP and UI.",
  "ownerAgent": "domain-engineer",
  "dependencies": ["EL-1"],
  "expectedOutputs": ["src/storage/retention.ts", "src/storage/counters.ts", "tests/storage/retention.test.ts", "tests/storage/counters.test.ts"],
  "validationCommands": ["npm test -- tests/storage/retention.test.ts tests/storage/counters.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/event-model-and-durable-log.md#EL-FR-09", "docs/features/event-model-and-durable-log.md#EL-FR-10"],
    "acceptanceCriteria": [
      "A test asserts a row exactly at the retention boundary is pruned and one a day older is kept by the per-session floor",
      "A test asserts an unacknowledged pending item survives pruning regardless of age",
      "A test asserts each counter increments through the accessor and survives reopening the store"
    ],
    "constraints": ["Never store or transmit conversation content", "No telemetry leaves the machine"],
    "constraintRefs": ["docs/PRD.md#APX-CON-12"],
    "references": ["docs/PRD.md#16. Open Questions", "docs/features/event-model-and-durable-log.md#3. Functional Requirements"]
  }
}
```

### Phase 2: Event model and pending lifecycle

```forge-task
{
  "id": "EL-3",
  "title": "Define the envelope and the classification rules",
  "description": "Define the normalized envelope and the pure classification rules that turn a harness event into exactly one class, an optional subtype and a dedupe key. Map permission asks and user-input blocks to needs-you, idle transitions to finished, and errors, retries, long tool calls, compaction and token burn to fyi with the matching subtype. Implement the idle gate: an idle transition whose turn recorded no tool call, no file edit and no todo update yields no event at all. Implement per-block deduplication so a repeated permission ask for the same session and block identifier yields the same dedupe key. Keep this task pure and synchronous with no database writes. Exclude pending lifecycle, delivery and notification.",
  "ownerAgent": "domain-engineer",
  "dependencies": ["EL-1"],
  "expectedOutputs": ["src/domain/envelope.ts", "src/domain/classify.ts", "tests/domain/classify.test.ts"],
  "validationCommands": ["npm test -- tests/domain/classify.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/event-model-and-durable-log.md#EL-FR-01", "docs/features/event-model-and-durable-log.md#EL-FR-04", "docs/features/event-model-and-durable-log.md#EL-FR-05", "docs/features/event-model-and-durable-log.md#EL-FR-06", "docs/features/event-model-and-durable-log.md#EL-FR-07"],
    "acceptanceCriteria": [
      "A table-driven test asserts every documented harness event maps to its expected class and subtype, and that no event maps to two classes",
      "A test asserts an idle transition after a turn with no tool call, file edit or todo update produces no event",
      "A test asserts two idle transitions separated by a resume produce two finished events and a repeated permission ask for one block produces one dedupe key",
      "A test asserts the envelope type has no field able to hold prompt, response or tool output text"
    ],
    "constraints": ["Never store or transmit conversation content"],
    "constraintRefs": ["docs/PRD.md#APX-CON-12"],
    "references": ["docs/PRD.md#5. Research Findings", "docs/features/event-model-and-durable-log.md#3. Functional Requirements", "docs/IDEA.md#What Earns An Interruption"]
  }
}
```

```forge-task
{
  "id": "EL-4",
  "title": "Implement the pending lifecycle state machine",
  "description": "Implement the pending lifecycle on top of the classification and the store: a needs-you event creates a pending item, and it leaves pending only when the harness reports the block resolved or the developer acknowledges it. Make every transition idempotent so a duplicated resolution or acknowledgement cannot double-count, reject an acknowledgement of an already resolved item with a distinguishable result, and prove that reopening the database reports the same pending set. Expose the pending set as the single source of truth the tray badge and dashboard will later read. Exclude HTTP routes, notification delivery and any dashboard code.",
  "ownerAgent": "domain-engineer",
  "dependencies": ["EL-2", "EL-3"],
  "expectedOutputs": ["src/domain/pending.ts", "tests/domain/pending.test.ts"],
  "validationCommands": ["npm test -- tests/domain/pending.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/event-model-and-durable-log.md#EL-FR-08"],
    "acceptanceCriteria": [
      "A test asserts a pending item survives closing and reopening the database with identical state",
      "A test asserts a duplicated resolution and a duplicated acknowledgement are both idempotent and never double-count",
      "A test asserts acknowledging an already resolved item returns a distinguishable rejected result and leaves state unchanged"
    ],
    "constraints": [],
    "constraintRefs": ["docs/PRD.md#APX-CON-08"],
    "references": ["docs/features/event-model-and-durable-log.md#3. Functional Requirements", "docs/PRD.md#10. System States / Lifecycle"]
  }
}
```

---

## 6. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Classification, dedupe keys, pending transitions | Pure functions, no database, table-driven cases |
| Integration | Schema, migrations, retention, counters | Real better-sqlite3 database in a temporary directory per test |
| Invariant | Content-free schema and envelope | Column-set assertion plus envelope field assertion |
| Regression | Restart safety | Reopen the same temporary database and compare pending sets |

Key test scenarios:

1. An idle transition with no work produces no event.
2. A repeated permission ask for the same block produces one dedupe key.
3. A pending item survives reopen and is cleared by exactly one of resolution or acknowledgement.
4. Retention keeps the per-session floor and never prunes an unacknowledged pending item.
5. A content-bearing column name fails the schema test.

---

## 7. Acceptance Criteria

1. Every harness event maps to exactly one class, subtype and dedupe key through a table-driven test.
2. The schema test asserts the exact column set of every table and no column can hold conversation content.
3. Pending state is identical after closing and reopening the database, and only resolution or acknowledgement clears it.
4. Retention and counters operate on the real schema with boundary tests.
5. Nothing in this feature opens a socket, spawns a process or renders a surface.

---

## 8. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Are thirty days and five hundred events per session the right retention numbers? | Yes as defaults, both configurable, and the floor wins over the age rule |
| 2 | Should a resolved block keep a resolution timestamp distinct from acknowledgement? | Yes, both are recorded so history can show which happened first |
| 3 | Does the counter set need a per-repository breakdown to be useful? | No for v1; aggregate counters plus the event history answer the question |
