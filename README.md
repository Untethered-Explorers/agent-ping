# agent-ping

A local-only notification surface that watches long-lived coding-agent sessions
across every repository on one machine, and tells you when a session is blocked
waiting on you, or when it finished real work.

> **Status: requirements only — nothing is implemented.**
>
> This repository currently contains **no `package.json`, no `src/`, no `tests/`,
> no build scripts, and no release tag**. There is no installable package, no
> runnable daemon, and no released version. Everything under `docs/` describes
> intended behaviour, not observed behaviour.
>
> `agent-ping` does not exist yet, and nothing here has been validated by a
> build, a test run, or a live run against a real agent harness. Treat every
> document in this repository as a plan.
>
> There is also **no `CHANGELOG.md`, no user guide, and no administrator
> guide** — those describe shipped behaviour, and there is none to describe.
> See [Documentation](#documentation) for what does exist and why.

## What it is meant to be

One person, one machine, on loopback. Not a team product, not a hosted service,
not a remote agent monitor. There is no authentication because there is one
user, and that user is at the keyboard.

The core design constraints, all deliberate:

- **Sidecar, never supervisor.** agent-ping observes agent processes and never
  owns them. It can be killed and restarted at any moment without loss, and a
  repository that was never configured still works.
- **Read-only.** The surface shows state. Exactly one route mutates anything,
  and it only marks a pending item acknowledged. Nothing can approve a
  permission or steer a session.
- **No content storage, ever.** It persists *that* something happened, never
  *what* was said. No prompts, responses, tool output, or file contents — in
  the log, in a log file, or in any request.
- **Three loudness classes.** *Needs You* (blocked, OS toast, repeats until
  acknowledged), *Finished* (idle after real work, one notification), and *FYI*
  (errors, retries, long tool calls, compaction, token burn — in-app only).
- **No sound in v1.** Deferred, not rejected, until the signal is trusted.
- **One global install** covering every repository, with no per-repository
  configuration and no registry to drift.

The full rationale, including the open questions left open on purpose, is in
[docs/IDEA.md](docs/IDEA.md).

## Documentation

### Architecture decisions

[docs/adr/](docs/adr/README.md) — eleven ADRs covering the sidecar boundary, the
loopback API surface, the content-free storage guarantee, the loudness policy,
the ACP-typed connector interface, the global install, the toolchain, identity,
the on-demand surface, visible failure, and build ordering. **All eleven are
`Accepted` as design and `Not started` as implementation.**

### Requirements

| Document | What it is |
|----------|-----------|
| [docs/IDEA.md](docs/IDEA.md) | Idea of record, preserved unchanged. The product rationale and the boundaries. |
| [docs/PRD.md](docs/PRD.md) | Product requirements: goals, non-goals, personas, constraints, architecture, risks, open questions, and the requirement-ID traceability matrix. |
| [docs/features/](docs/features/) | Eight canonical feature documents, each with requirements, task contracts, testing strategy, and acceptance criteria. |

Feature documents, in dependency order:

1. [Dashboard Design Prototype](docs/features/dashboard-design-prototype.md) — a static PixiJS page with three mock rows, to settle the design and the toolchain before any connector work.
2. [Event Model and Durable Log](docs/features/event-model-and-durable-log.md) — the envelope, the three classes, the pending lifecycle, and the content-free SQLite log.
3. [Hub Core and Delivery Policy](docs/features/hub-core-and-delivery-policy.md) — the daemon, the loopback API, ingest, streaming, and what gets delivered.
4. [Notification and Tray Presence](docs/features/notification-and-tray-presence.md) — toasts per class, and the tray badge as the durable signal.
5. [opencode Plugin Adapter](docs/features/opencode-plugin-adapter.md) — the global plugin, the breadcrumb on failure, and the polling fallback.
6. [Live Dashboard](docs/features/live-dashboard.md) — the on-demand PixiJS surface wired to real state, with its DOM mirror.
7. [Install, Autostart and Operations](docs/features/install-autostart-and-operations.md) — the global install, per-platform autostart, `doctor`, and uninstall.
8. [Copilot CLI ACP Spike](docs/features/copilot-cli-acp-spike.md) — whether Copilot can report idle and permission signals, ending in a recorded gate decision.

### Not present, and why

| Artifact | Why it is absent |
|----------|------------------|
| `CHANGELOG.md` | No release exists, so there is no change history to record. Created by the first tag. |
| `docs/releases/` | No versioned release to write notes for. |
| `docs/user-guide.md` | Would have to document commands and UI that do not exist. Writing it now would be fiction. |
| `docs/admin-guide.md` | Would have to document installing, configuring, and operating a daemon with no code. |
| `AGENTS.md` | Not created. Documentation-upkeep rules for agents belong with a codebase that has code to keep documented. |

## Repository layout

```text
docs/
  IDEA.md        idea of record (preserved unchanged)
  PRD.md         product requirements and traceability
  adr/           architecture decision records
  features/      eight canonical feature documents
  research/      local model inventory (not a requirement source)
.opencode/       MyForge authoring tooling (agents and skills), not product code
```

There is no `src/`, `tests/`, or `scripts/` yet. The intended layout is
recorded in [PRD §6.2](docs/PRD.md#62-project-structure).

## Status vocabulary

Because this repository is pre-implementation, **two independent axes** are used
throughout the documentation, and conflating them is the main way these documents
could mislead:

| Axis | Values | Question it answers |
|------|--------|---------------------|
| **Decision / document status** | Proposed, Accepted, Superseded, Deprecated | Is this decision in force? |
| **Implementation state** | Not started, Partial, Complete | Does code exist? |

Every ADR is currently **Accepted / Not started**.

## Contributing

There is no build, no test command, and no contribution guide, because there is
no code. The intended toolchain is recorded in
[ADR-007](docs/adr/ADR-007-single-node-typescript-toolchain.md): Node.js 22 LTS
or newer, TypeScript, and npm, as a single package.
