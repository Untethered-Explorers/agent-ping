# ADR-003: Never store or transmit conversation content

- **Status:** Accepted
- **Date:** 2026-09-26
- **Decision owners:** Project author (settled with the user via `forge-grill-idea`)
- **Implementation state:** Not started. No code, schema, or test exists for this
  decision. In particular, the invariant test this ADR relies on does not exist.

## Context

agent-ping sits alongside sessions in which an agent reads source code, writes
files, and runs commands. Any durable record of those sessions could therefore
accumulate a second copy of everything the user and their agents read and wrote
— prompts, responses, tool output, diffs, file contents.

A notification log does not need any of that to do its job. The user-facing
question is "which of my projects is asking for me". Answering it requires
repository identity, session identity, a class, and a timestamp. Nothing more.

The risk is not that a developer would deliberately archive their conversations.
It is that content-bearing fields accumulate *incidentally*, one debugging
convenience at a time, until a schema that was designed to be content-free
quietly is not. A privacy promise enforced only by developer discipline is not
a privacy boundary.

## Decision

agent-ping **persists that something happened, never what was said.**

The following are never written to the durable log, any log file, or any
outbound request: prompts, model responses, tool output, file contents, diffs,
or any conversation transcript.

The persisted set is limited to metadata:

| Persisted | Not persisted |
|-----------|---------------|
| Harness identifier | Prompt text |
| Repository short name and full path | Model response text |
| Session identifier | Tool output |
| Event class and optional subtype | File contents or diffs |
| Occurrence and receipt timestamps (ISO 8601 UTC) | Any transcript |
| Acknowledgement / resolution state and timestamps | |
| Dedupe key | |

This is enforced as an **invariant, not a convention**:

1. The normalized event envelope type has no field capable of holding content.
2. An automated test asserts the **exact column set of every table**, so adding
   a content-bearing column fails the build rather than silently violating the
   boundary.
3. No telemetry leaves the machine. The only outbound network calls permitted
   are to the loopback hub and to harnesses already running on this machine.

## Alternatives Considered

- **Store a short excerpt for context** ("session asked to edit 3 files").
  Rejected. It is the natural first step toward a transcript, it has no bearing
  on the notification decision, and it is indistinguishable in practice from
  storing the content once excerpts get long enough to be useful.
- **Store content in a separate, encrypted, clearly-labelled store.** Rejected.
  Encryption at rest does not reduce exposure from an agent-ping defect, and a
  second store weakens the "one content-free log" property that makes the
  guarantee auditable by reading the schema.
- **Rely on documentation to keep the log content-free.** Rejected. See Context:
  discipline erodes; a build-failing column-set assertion does not.
- **Persist nothing at all — keep state in memory only.** Rejected. It
  contradicts the requirement that a pending block survive a hub restart. The
  durability requirement is what makes a content-free durable log necessary
  rather than merely preferable.

## Consequences

- **Benefit:** The privacy claim is falsifiable. A reviewer can read the schema
  and the envelope type and confirm the boundary, rather than taking a promise
  on trust.
- **Benefit:** The compromise of an agent-ping defect is bounded to metadata
  disclosure, which combined with ADR-002 is a small and mostly non-sensitive
  set.
- **Benefit:** The dashboard cannot become a transcript reader, which removes an
  entire category of scope (history search, content filtering) from the product.
- **Cost:** The dashboard's history view is necessarily coarser than a
  transcript. A user wanting to know *why* a session is blocked must go to the
  harness, which is consistent with the handoff posture in ADR-001.
- **Cost:** Debugging agent-ping itself cannot rely on captured payloads. This
  is accepted; the design substitutes counters and health endpoints for
  payload inspection.
- **Enforcement cost:** The exact-column-set test is a maintenance tax. Every
  intentional schema change must update the expected column list. This is
  deliberate — the tax is the control.
- **Risk:** If a future feature appears to need content, this ADR must be
  reopened and the threat model re-examined. It must not be amended in place.

## Implementation References

- Requirements: [APX-FR-01](../PRD.md#8-security-and-privacy) — never store
  or transmit content. [APX-CON-12](../PRD.md#7-non-functional-requirements) —
  no telemetry leaves the machine.
- Envelope and schema requirements: EL-FR-01, EL-FR-02, EL-FR-03 in
  [Event Model and Durable Log](../features/event-model-and-durable-log.md).
  EL-FR-03 is the exact-column-set invariant test referenced above.
- Metrics: content safety is tracked as
  [PRD §11](../PRD.md#11-analytics-success-metrics) — "zero content columns,
  zero content fields in any payload", measured by schema invariant test plus
  ingest payload test.
- Originating rationale: [IDEA.md — Boundaries](../IDEA.md#boundaries), "No
  content storage, ever."
- Planned source locations (**do not exist yet**): `src/storage/schema.sql`,
  `src/storage/eventStore.ts`, `src/domain/envelope.ts`,
  `tests/storage/schema.test.ts`.
