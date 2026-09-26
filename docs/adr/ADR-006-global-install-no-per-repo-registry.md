# ADR-006: One global install; no per-repository configuration or registry

- **Status:** Accepted
- **Date:** 2026-09-26
- **Decision owners:** Project author (settled with the user via `forge-grill-idea`)
- **Implementation state:** **Partial — the mechanism is built, the commands are
  not.** `src/plugin/install/global-plugin.ts` implements the whole of the
  single-file global install: it resolves opencode's config root the way opencode
  does, generates one self-contained plugin file by inlining the adapter's own
  modules, **verifies that file loads and translates an event in a fresh Node
  process before publishing it**, and records the product version and a `sha256`
  of the emitted bytes so a second install is a no-op and a *different* installed
  version is reportable rather than overwritable. It was exercised against a live
  `opencode run` with the file in the real plugin directory. What does not exist
  yet is anything a user can invoke: `src/cli/` is absent, so there is no
  `agent-ping install` or `agent-ping uninstall`, and the per-platform autostart
  units in the Decision below are unimplemented. The polling fallback is also
  unbuilt — push is currently the only path.

## Context

The user runs several long-lived agent sessions at once, across several
repositories. The product's second stated goal is to cover **every** repository
from **one** global install, with no per-repository setup and no registry.

The original framing was "a connector installed in every repo". That was
explicitly reconsidered and replaced. The reason is failure asymmetry: a
per-repository install is a step that can be forgotten, and a forgotten
registration produces an **invisible session** — precisely the failure the
product exists to prevent. The user cannot notice the gap, because the symptom
is the absence of a notification they did not know they should have received.

This interacts with a second insight recorded in the source material: "multiple
repos" is satisfied by N opencode servers and plugins across N repositories —
**not** by supporting N harnesses. Repository coverage and harness coverage are
different axes, and conflating them would have produced a much larger product.

The research behind this decision: opencode loads global plugins from
`~/.config/opencode/plugins/` and project plugins from `.opencode/plugins/`.
Global plugins load for every session regardless of how the session was started
— TUI, `opencode run`, or `opencode attach`.

## Decision

**One global install covers every repository.** There is no per-repository
configuration file, no repository registry, and no registration step.

- The opencode adapter is a **single global plugin file** in the opencode global
  plugin directory, loaded for every session with no per-repository
  configuration. This is the mechanism that makes coverage automatic rather
  than remembered.
- Coverage is a property of the harness loading a global plugin, not of
  anything agent-ping tracks. There is no list of repositories to drift out of
  sync with reality, because **there is no list**.
- Repository identity is **derived** from the session, not registered — see
  ADR-008.
- **Multiple repositories are covered by one harness integration**, not by
  adding harnesses. Repository breadth and harness breadth are independent.
- The hub is a **daemon** that autostarts on login via a per-user facility —
  systemd user unit on Linux, launchd agent on macOS, Startup entry on Windows —
  at user level, with **no root**.

A **polling fallback** is retained as an explicit secondary path, not a primary
one: where a session cannot push events, the opencode session store and HTTP
API (active-session listing, wait-until-idle, permission-request listing) may be
polled. Push is the default because it is timely; polling exists so that
anything which cannot push is not invisible.

## Alternatives Considered

- **Per-repository plugin install (the original framing).** Rejected. Every
  repository becomes a chance to forget, and the failure is silent. Rejected in
  favour of the global install, as recorded in the idea of record.
- **A central repository registry the user maintains.** Rejected for the same
  reason, one level removed. A registry is a second source of truth that can
  disagree with reality, and it adds a thing to keep in sync.
- **Discover repositories by scanning the filesystem.** Rejected. It guesses at
  which directories are projects, and a wrong guess is a false notification.
  Deriving identity from the session itself is strictly more accurate.
- **Polling as the primary mechanism.** Rejected. Polling is inherently delayed
  relative to the event, and polling every opencode store on a machine with many
  sessions is a recurring cost for a worse result. It is kept as an explicit
  fallback, which is the distinction that matters.
- **A system-level (root) autostart unit.** Rejected. A user notification tool
  does not justify root, and root autostart would make uninstall require
  elevated cleanup.

## Consequences

- **Benefit:** Coverage is automatic. A repository the user has never
  configured cannot be invisible, because no configuration exists to be missing.
- **Benefit:** There is no registry to desynchronise, so no reconciliation logic
  and no class of bug about "the registry disagrees with reality".
- **Benefit:** Uninstallation is complete by removing one global plugin and one
  user-level autostart unit.
- **Cost:** agent-ping depends on a specific harness behaviour — that global
  plugins load for every session regardless of launch path. If a future opencode
  release changes global plugin loading, coverage degrades globally rather than
  in one repository. The PRD mitigates this with a version check in `doctor`
  and records plugin API drift as a named risk.
- **Cost:** Because the install is global, it cannot be enabled for one project
  and disabled for another. Per-repository opt-out is not offered in v1.
- **Cost:** A global plugin is loaded into **every** opencode session on the
  machine, including ones the user would not choose to instrument. This is
  accepted because the adapter is bounded and non-blocking (ADR-001), but it
  does mean the blast radius of a plugin bug is every session.
- **Operational implication:** the hub's live port is written to a runtime file
  that the plugin reads, so a port collision with an existing default is
  resolved without editing plugin configuration. This is shipped behaviour, not
  an open question: the port is published only after the socket is bound, so an
  adapter that finds a runtime file with no port in it sees a hub that is still
  starting and can retry, and an adapter can never be pointed at a stale port.
- **Risk:** A global plugin that throws could degrade opencode itself. The
  sidecar property in ADR-001 — sessions work identically with the plugin
  absent — is what bounds this, and it is a load-bearing dependency between
  ADR-001 and this one.

## Implementation References

- Requirements: [APX-US-01](../PRD.md#4-personas), [APX-CON-03](../PRD.md#8.
  Security and Privacy), [APX-CON-05](../PRD.md#7-non-functional-requirements),
  [APX-CON-06](../PRD.md#61-technology-stack), [APX-CON-12](../PRD.md#7.
  Non-Functional Requirements).
- Research finding behind the mechanism: [PRD §5 Research Findings](../PRD.md#5-research-findings)
  — global plugin loading paths, verified against vendor sources on 2026-09-26.
- Goals: [PRD G-2](../PRD.md#3-goals-and-non-goals) — one global install, no
  registry.
- Risk: [PRD §12.2](../PRD.md#122-risks), final row — plugin API drift causing
  silent loss of events.
- Open question 10 in [PRD §16](../PRD.md#16-open-questions) — default loopback
  port and collision behaviour.
- Feature documents: [opencode Plugin Adapter](../features/opencode-plugin-adapter.md),
  [Install, Autostart and Operations](../features/install-autostart-and-operations.md).
- Originating rationale: [IDEA.md — Scope](../IDEA.md#scope) and
  [IDEA.md — How It Connects](../IDEA.md#how-it-connects).
- Source locations: `src/plugin/install/global-plugin.ts`,
  `src/hub/runtime-file.ts`, `src/storage/paths.ts` (the two places a platform
  directory is resolved), `tests/plugin/install.test.ts`.
- **Still owed:** the `install` / `uninstall` / `status` / `doctor` commands in
  `src/cli/`, and the per-platform autostart unit templates, per
  [Install, Autostart and Operations](../features/install-autostart-and-operations.md).
