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

Several records diverge from their original text, deliberately and with the
reasoning recorded in place: the [ADR-004](ADR-004-three-loudness-classes.md)
amendment that removed the needs-you repeat timer, the
[ADR-007](ADR-007-single-node-typescript-toolchain.md) divergence table for the
toolchain as actually installed, and the set of records amended on 2026-09-27 by
[ADR-012](ADR-012-surface-is-rendered-by-agent-ping.md), which replaced delivery
through the platform notification services with a surface this product renders
itself. The rows above were last checked against the tree on 2026-09-28; where a
row and a record disagree, the record is right.

## What belongs here

An ADR records a decision that is expensive to reverse and that constrains
later work — a boundary, a protocol, a storage guarantee, a platform. It does
not record an implementation detail, a library bump, or a task list. If a
decision can be changed by editing one file without invalidating others, it
belongs in a feature document, not here.

## Index

`Date` is the date the record was last updated, which for an amended record is not
the date it was first written. Read the record's own **Amended** line for what
changed and when.

| ADR | Decision | Status | Date | Implementation |
|-----|----------|--------|------|----------------|
| [ADR-001](ADR-001-sidecar-not-supervisor.md) | agent-ping is a sidecar, never a supervisor | Accepted | 2026-09-26 (amended 2026-09-27) | Implemented |
| [ADR-002](ADR-002-loopback-only-single-mutating-route.md) | Loopback-only hub with exactly one mutating route | Accepted | 2026-09-26 | Implemented |
| [ADR-003](ADR-003-never-store-conversation-content.md) | Never store or transmit conversation content | Accepted | 2026-09-26 | Implemented |
| [ADR-004](ADR-004-three-loudness-classes.md) | Three loudness classes, silent by default, no sound in v1 | Accepted | 2026-09-26 (amended 2026-09-27) | Implemented; the card's lifetime observed on a real Linux window |
| [ADR-005](ADR-005-acp-typed-connector-interface.md) | Connector interface specified in ACP terms | Accepted | 2026-09-26 | Partial — the interface and the opencode adapter are built; the Copilot gate recorded deferral, so v1 ships opencode only |
| [ADR-006](ADR-006-global-install-no-per-repo-registry.md) | One global install; no per-repository configuration or registry | Accepted | 2026-09-26 | Implemented — the install mechanism, the four commands, the per-platform units and the polling fallback are all built; no login observed on any platform |
| [ADR-007](ADR-007-single-node-typescript-toolchain.md) | Single toolchain: Node 22 + TypeScript, Electron main, PixiJS dashboard | Accepted | 2026-09-26 (amended 2026-09-27) | Implemented, with one recorded divergence; run inside Electron on Linux only |
| [ADR-008](ADR-008-repository-short-name-identity.md) | Identity is the repository short name | Accepted | 2026-09-26 | Implemented |
| [ADR-009](ADR-009-on-demand-surface-no-always-on-window.md) | On-demand surface; no always-on *visible* surface in v1 | Accepted, amended by ADR-012 | 2026-09-26 (amended 2026-09-27) | Implemented — dashboard, badge and card all built; a card observed on Linux, a tray icon by no human on any desktop |
| [ADR-010](ADR-010-delivery-failure-is-never-silent.md) | Delivery failure is never silent | Accepted | 2026-09-26 (amended 2026-09-27) | Implemented; the breadcrumb path not yet seen failing inside a real harness |
| [ADR-011](ADR-011-settle-dashboard-design-before-connectors.md) | Settle the dashboard design with a static prototype before connector work | Accepted | 2026-09-26 | Fulfilled — the ordering held and the review approved |
| [ADR-012](ADR-012-surface-is-rendered-by-agent-ping.md) | The notification surface is rendered by agent-ping, not by the platform | Accepted | 2026-09-27 | Implemented, and live-verified on Linux against the shipped build; never run on macOS or Windows |

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

- [docs/user-guide.md](../user-guide.md) — day-to-day use.
- [docs/admin-guide.md](../admin-guide.md) — installation, configuration, state, backups and hardening.
- [docs/IDEA.md](../IDEA.md) — idea of record, preserved unchanged.
- [docs/PRD.md](../PRD.md) — product requirements, traceability matrix, open questions.
- [docs/features/](../features/) — the eight canonical feature documents.
- [CHANGELOG.md](../../CHANGELOG.md) and [docs/releases/UNRELEASED.md](../releases/UNRELEASED.md)
  — change history and the prepared release notes. There is no tagged release yet:
  `package.json` declares `0.1.0`, and everything built so far is under
  `[Unreleased]`.
- [docs/research/electron-surface-preflight.json](../research/electron-surface-preflight.json)
  — the live probe ADR-012's decision rests on, including the Chromium sandbox
  finding the autostart units now carry.
