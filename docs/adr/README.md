# Architecture Decision Records

Durable architectural decisions for **agent-ping**, a local-only notification
surface that tells a developer when one of their coding-agent sessions is blocked
on them or has finished real work.

## Read this first: none of this is implemented

Every ADR in this directory has **Implementation state: not started**. The
repository currently contains requirements documents only — no `package.json`,
no `src/`, no `tests/`, no build scripts, and no release tag. The decisions
below are *accepted design*, not descriptions of running software.

Nothing in this directory has been validated by a build, a test run, or a live
run against a real harness. Where an ADR names a source path, that path is
**planned and does not exist yet**. Where an ADR names an alternative that was
rejected, that rejection is a design judgement recorded in
[docs/IDEA.md](../IDEA.md) or [docs/PRD.md](../PRD.md), not an experimental
result.

## What belongs here

An ADR records a decision that is expensive to reverse and that constrains
later work — a boundary, a protocol, a storage guarantee, a platform. It does
not record an implementation detail, a library bump, or a task list. If a
decision can be changed by editing one file without invalidating others, it
belongs in a feature document, not here.

## Index

| ADR | Decision | Status | Implementation |
|-----|----------|--------|----------------|
| [ADR-001](ADR-001-sidecar-not-supervisor.md) | agent-ping is a sidecar, never a supervisor | Accepted | Not started |
| [ADR-002](ADR-002-loopback-only-single-mutating-route.md) | Loopback-only hub with exactly one mutating route | Accepted | Not started |
| [ADR-003](ADR-003-never-store-conversation-content.md) | Never store or transmit conversation content | Accepted | Not started |
| [ADR-004](ADR-004-three-loudness-classes.md) | Three loudness classes, silent by default, no sound in v1 | Accepted | Not started |
| [ADR-005](ADR-005-acp-typed-connector-interface.md) | Connector interface specified in ACP terms | Accepted | Not started |
| [ADR-006](ADR-006-global-install-no-per-repo-registry.md) | One global install; no per-repository configuration or registry | Accepted | Not started |
| [ADR-007](ADR-007-single-node-typescript-toolchain.md) | Single toolchain: Node 22 + TypeScript, Electron main, PixiJS dashboard | Accepted | Not started |
| [ADR-008](ADR-008-repository-short-name-identity.md) | Identity is the repository short name | Accepted | Not started |
| [ADR-009](ADR-009-on-demand-surface-no-always-on-window.md) | On-demand surface; no always-on window in v1 | Accepted | Not started |
| [ADR-010](ADR-010-delivery-failure-is-never-silent.md) | Delivery failure is never silent | Accepted | Not started |
| [ADR-011](ADR-011-settle-dashboard-design-before-connectors.md) | Settle the dashboard design with a static prototype before connector work | Accepted | Not started |

## Status vocabulary

`Status` describes whether the **decision** is in force. `Implementation state`
describes whether any **code** exists. They are independent, and every ADR here
is currently `Accepted` / `Not started`.

| Status | Meaning |
|--------|---------|
| Proposed | Under consideration; not yet binding. |
| Accepted | In force as the governing design. |
| Superseded | Replaced by a later ADR, which is named in the record. |
| Deprecated | No longer relevant; retained for history. |

## Related documents

- [docs/IDEA.md](../IDEA.md) — idea of record, preserved unchanged.
- [docs/PRD.md](../PRD.md) — product requirements, traceability matrix, open questions.
- [docs/features/](../features/) — the eight canonical feature documents.

There is no `CHANGELOG.md` and no release-notes directory, because there is no
release. Those artifacts are created by the first tagged release, not before.
