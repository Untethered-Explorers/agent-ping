# Architecture Decision Records

Durable architectural decisions for **agent-ping**, a local-only notification
surface that tells a developer when one of their coding-agent sessions is blocked
on them or has finished real work.

## Read this first: what is code and what is not

These are **decisions**, not descriptions of running software, and the two
questions are kept apart below. Every ADR is `Accepted` as design. Implementation
state is recorded per record and is the honest current answer:

- **Implemented** — the decision is code, exercised by tests.
- **Partial** — the mechanism exists, but a named part of the decision is
  unbuilt. Each partial record says exactly what is owed.
- **Fulfilled** — a sequencing or process constraint that held.

Where a decision's *verification* is weaker than its implementation — built, but
never run against a real desktop or a real harness — the record says so in its
own **Implementation state** line rather than leaving the gap to be discovered.
The live build log, with every unverified check enumerated, is
[docs/PROGRESS.md](../PROGRESS.md).

Two records diverge from their original text, deliberately and with the reasoning
recorded in place: the [ADR-004](ADR-004-three-loudness-classes.md) amendment
that removed the needs-you repeat timer, and the
[ADR-007](ADR-007-single-node-typescript-toolchain.md) divergence table for the
toolchain as actually installed.

## What belongs here

An ADR records a decision that is expensive to reverse and that constrains
later work — a boundary, a protocol, a storage guarantee, a platform. It does
not record an implementation detail, a library bump, or a task list. If a
decision can be changed by editing one file without invalidating others, it
belongs in a feature document, not here.

## Index

| ADR | Decision | Status | Implementation |
|-----|----------|--------|----------------|
| [ADR-001](ADR-001-sidecar-not-supervisor.md) | agent-ping is a sidecar, never a supervisor | Accepted | Implemented |
| [ADR-002](ADR-002-loopback-only-single-mutating-route.md) | Loopback-only hub with exactly one mutating route | Accepted | Implemented |
| [ADR-003](ADR-003-never-store-conversation-content.md) | Never store or transmit conversation content | Accepted | Implemented |
| [ADR-004](ADR-004-three-loudness-classes.md) | Three loudness classes, silent by default, no sound in v1 | Accepted | Implemented, with an amendment |
| [ADR-005](ADR-005-acp-typed-connector-interface.md) | Connector interface specified in ACP terms | Accepted | Partial — the Copilot spike and its gate decision are owed |
| [ADR-006](ADR-006-global-install-no-per-repo-registry.md) | One global install; no per-repository configuration or registry | Accepted | Partial — the install mechanism is built; the CLI and autostart units are not |
| [ADR-007](ADR-007-single-node-typescript-toolchain.md) | Single toolchain: Node 22 + TypeScript, Electron main, PixiJS dashboard | Accepted | Partial — toolchain verified; Electron and the CLI are not yet installed |
| [ADR-008](ADR-008-repository-short-name-identity.md) | Identity is the repository short name | Accepted | Implemented |
| [ADR-009](ADR-009-on-demand-surface-no-always-on-window.md) | On-demand surface; no always-on window in v1 | Accepted | Partial — the on-demand half is built; the live dashboard is not |
| [ADR-010](ADR-010-delivery-failure-is-never-silent.md) | Delivery failure is never silent | Accepted | Implemented; not yet observed live |
| [ADR-011](ADR-011-settle-dashboard-design-before-connectors.md) | Settle the dashboard design with a static prototype before connector work | Accepted | Fulfilled — the ordering held and the review approved |

## Status vocabulary

`Status` describes whether the **decision** is in force. `Implementation state`
describes whether the **code** exists. They are independent, and conflating them
is the main way this directory could mislead a reader.

| Status | Meaning |
|--------|---------|
| Proposed | Under consideration; not yet binding. |
| Accepted | In force as the governing design. |
| Superseded | Replaced by a later ADR, which is named in the record. |
| Deprecated | No longer relevant; retained for history. |

| Implementation state | Meaning |
|---------------------|---------|
| Implemented | Code exists and tests exercise it. |
| Partial | The mechanism exists; the record names what is unbuilt. |
| Fulfilled | A constraint that was about sequence or process, and it held. |
| Not started | No code exists for this decision. |

## Related documents

- [docs/IDEA.md](../IDEA.md) — idea of record, preserved unchanged.
- [docs/PRD.md](../PRD.md) — product requirements, traceability matrix, open questions.
- [docs/features/](../features/) — the eight canonical feature documents.

There is no `CHANGELOG.md` and no release-notes directory, because there is no
release. Those artifacts are created by the first tagged release, not before.
