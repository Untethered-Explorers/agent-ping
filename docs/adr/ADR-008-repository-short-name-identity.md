# ADR-008: Identity is the repository short name

- **Status:** Accepted
- **Date:** 2026-09-26
- **Decision owners:** Project author (settled with the user via `forge-grill-idea`)
- **Implementation state:** Not started. No envelope, schema, or dashboard row
  rendering exists for this decision.

## Context

The dashboard's question is **"which of my projects is asking for me"**. That is
a repository-level question, not a session-level one and not a file-level one.
The user running twenty repositories does not think in session identifiers; they
think in projects.

The available identity candidates each fail differently:

- **Full absolute path** — unambiguous, but long, and it pushes the user's
  mental model toward filesystem layout. `/home/user/src/.../packages/thing` is
  not how anyone refers to their own work. Two checkouts of the same project
  become indistinguishable at the tail.
- **Session identifier** — the harness's own key. Meaningless to the user as a
  label, and it nests the wrong way: sessions are nested under repositories, not
  the reverse.
- **Repository short name (directory basename)** — matches how the user names
  their projects out loud, keeps labels short enough to scan, and is what the
  user would type to find the right terminal.

## Decision

**Identity is the repository short name: the directory basename of the session.**
Sessions nest beneath it.

- The short name is the **primary label**. It is never a truncated or
  decorated form of the path.
- The **full path is available on hover or focus**, but is never the primary
  label.
- Identity is **derived from the session**, not registered or configured. This is
  what makes ADR-006's no-registry property possible: there is nothing to keep in
  sync because nothing is stored.
- The **directory basename is a deliberate choice, with a known cost**: two
  checkouts of the same repository share a short name. The PRD records
  session-level grouping beyond the short name as future consideration, not a
  v1 capability, which is the honest handling of that cost.

## Alternatives Considered

- **Full path as the primary label.** Rejected. Too long to scan, and it makes
  the layout the organising principle rather than the project.
- **Session identifier as the primary label.** Rejected. It inverts the
  hierarchy — repositories are what the user is asking about — and it is opaque.
- **A user-configured project nickname.** Rejected for v1. It reintroduces a
  per-repository configuration file, which is precisely what ADR-006 exists to
  eliminate. A nickname store is a registry with extra steps.
- **Git remote or repository URL as identity.** Rejected. It requires a git
  invocation per session, fails outside a git checkout, and adds latency to a
  path that runs on every event. It is also a network-adjacent identifier the
  user did not ask to surface.
- **Content hash or UUID for identity, with the name as decoration.** Rejected.
  It adds an opaque key with no benefit over the basename, which is already
  stable within a machine.

## Consequences

- **Benefit:** The dashboard answers the actual user question at the actual
  level of abstraction, so scanning a list is a glance rather than a reading
  task.
- **Benefit:** Derivation rather than registration means identity cannot drift
  out of sync with reality, and there is no configuration to forget.
- **Benefit:** The short name is naturally the right thing to type or search
  for, which keeps the handoff affordance (ADR-001) coherent with the label.
- **Cost:** Full paths are still persisted alongside the short name for the
  hover detail, so the metadata set includes them. This is metadata, not content
  (ADR-003), but it is the full filesystem location of the user's work.
- **Cost:** Two checkouts of the same repository are indistinguishable in the
  primary label. Deferred rather than solved; see Future Considerations in the
  PRD.
- **Cost:** Renaming or moving a repository changes its label, so history rows
  group differently after a move. The recorded resolution is that history is
  bounded by retention, and both timestamps are persisted.
- **Constraint carried forward:** Because sessions nest under repositories,
  repository-level grouping is a hard requirement of the dashboard layout, not a
  presentation preference. Blocked rows sort to the top of their group.
- **Risk:** On a harness that does not report a usable working directory, the
  basename cannot be derived and identity degrades. This is a per-adapter
  concern, governed by the degradation rule in ADR-005.

## Implementation References

- Requirements: [APX-CON-09](../PRD.md#63-key-apis-interfaces) — identity is
  the repository short name.
- Envelope requirement: EL-FR-01 in
  [Event Model and Durable Log](../features/event-model-and-durable-log.md) —
  the envelope carries both the short name and the full path.
- Grouping and layout: [Live Dashboard](../features/live-dashboard.md) —
  repositories as muted group headers, blocked rows first, full path on hover or
  focus.
- Future consideration: [PRD §13](../PRD.md#13-future-considerations) — grouping
  beyond the repository short name once multiple windows per repo are common.
- Originating rationale: [IDEA.md — Boundaries](../IDEA.md#boundaries), "The
  dashboard's question is 'which of my projects is asking for me', which is a
  repo-level question."
- Planned source locations (**do not exist yet**): `src/domain/envelope.ts`,
  `src/storage/`, `src/dashboard/`.
