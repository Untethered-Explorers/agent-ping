# ADR-011: Settle the dashboard design with a static prototype before connector work

- **Status:** Accepted
- **Date:** 2026-09-26
- **Decision owners:** Project author (settled with the user via `forge-grill-idea`)
- **Implementation state:** **Fulfilled — the decision was a sequencing
  constraint, and the sequence held.** The prototype was built first: the
  toolchain and test-runner convention (DP-1), the static three-row page (DP-2),
  the non-colour urgency encoding, keyboard order and DOM mirror (DP-3), and the
  human design review (DP-4, `docs/reviews/DP-4-console-review.md`,
  **approved**). The first connector task, OA-1, came after the prototype and its
  review. The convention the decision was really buying is in force and
  self-enforcing: `tests/tooling/runner-convention.test.ts` asserts that a named
  path selecting zero test files exits non-zero, so "tests passed" cannot mean
  "nothing ran".
  The toolchain risk this decision named also materialised and was recorded
  rather than absorbed silently: the build pinned **TypeScript 5.9.3** instead of
  the PRD's recorded 7.0.2 (see the divergence table in
  [ADR-007](ADR-007-single-node-typescript-toolchain.md)).

## Context

The dashboard's layout, density, how urgency is encoded, and whether motion
helps or adds noise were recorded as **deliberately unresolved**. The reasoning
in the source material is that this cannot be settled by discussion: two designs
can both satisfy every stated requirement while one is clearly better in the
hand.

This is a real risk to the schedule, not just to aesthetics. The live dashboard
depends on three other features — the hub core, the notification and tray
presence, and the design prototype itself. If the layout is discovered to be
wrong after the connector work lands, the rework is not a mock-data swap; it
touches the row model, the urgency encoding, the DOM mirror structure required
by accessibility, and the tray badge's relationship to the page. That is
expensive. ADR-012 did not disturb this ordering, and the reasoning behind it
strengthened: the notification card is a DOM document that must agree with the
page's own vocabulary, so the design is settled before either surface is built.

The same problem applies to the toolchain. The recorded project structure has
three separate build entry points (ADR-007) and an untested assumption about
TypeScript 7 compatibility with Vitest 5. A prototype that must be built anyway
is the cheapest possible place to discover that the toolchain does not work.

## Decision

**Build a fully static PixiJS page first — before any connector work — and
judge the design by looking at it.**

The prototype, per its feature document:

- Is **fully static**: no hub, no plugin, no HTTP request, no filesystem read,
  no live data. It opens from a built page and renders **three hardcoded mock
  rows**.
- Exists to settle layout, density, and urgency encoding **before** live data is
  wired, and to establish the **toolchain and test-runner convention** every
  later feature depends on.
- Carries the accessibility requirement from the start: the canvas is paired
  with a DOM mirror, keyboard navigation is exercised, and a screen reader can
  read the rows.
- Is judged by **a human confirming the primary journey**, recorded as evidence
  with the journey performed.

It is ordered first among the eight features, alongside the event model, with
no prerequisites. The recorded expectation is that it is **accepted with minor
changes**; a rejection reopens the design work before the live dashboard starts.
**Outcome: approved, with no conditions** — see
[docs/reviews/DP-4-console-review.md](../reviews/DP-4-console-review.md).

The same reasoning produced the Copilot spike (ADR-005): where an outcome is
genuinely unknown, the response is a small, cheap, evidence-producing step whose
deliverable is a recorded decision — not a design debate and not a build on an
assumption.

## Alternatives Considered

- **Build connectors first, design the dashboard against real data.** Rejected.
  Real data is genuinely more informative, but it makes the design question
  depend on the whole pipeline being finished, and makes a late layout change
  maximally expensive. Three mock rows settle the layout question; they cannot
  settle the classification question, and they are not meant to.
- **Settle the design in writing or in discussion.** Rejected. Explicitly
  rejected in the source material: the outcome is not decidable by argument.
- **Skip the prototype and design during live dashboard implementation.**
  Rejected. It couples the layout decision to real data and to the connector
  pipeline, removing the cheapest possible moment to change one's mind.
- **Build a throwaway prototype in a different stack, then rebuild.** Rejected.
  It would double the work and, more importantly, would fail to establish the
  toolchain and test-runner convention that every later feature depends on.
- **Wire the prototype to a fake hub to make it more realistic.** Rejected. It
  reintroduces the coupling the prototype exists to avoid, and the three rows
  are hardcoded precisely so the prototype has no dependencies to break.

## Consequences

- **Benefit:** The most expensive-to-change question — the layout — is answered
  while changing it is still cheap.
- **Benefit:** Toolchain risk (TypeScript 7, Vitest 5, three build entry points)
  surfaces in the first feature rather than the last.
- **Benefit:** The test-runner convention is established by a feature whose
  success criteria are almost entirely visual, which is where an unfalsifiable
  "tests passed" is most likely to hide. The recorded convention is that a green
  result must mean real assertions actually ran — the test command fails when it
  selects nothing.
- **Benefit:** The pattern is consistent with the Copilot spike, so the project
  has one answer to "what do we do when we do not know": build the cheap thing
  that produces evidence and record the decision.
- **Cost:** Some prototype work is thrown away. The prototype's data layer,
  which is intentionally absent, is real work that does not carry forward. This
  is the price of de-risking and is accepted knowingly.
- **Cost:** A static prototype cannot answer questions about real data volume,
  long repository names, or many simultaneous sessions. Those surface during
  live dashboard work regardless, and the recorded mitigation is bounded
  retention and the per-repository grouping decision in ADR-008.
- **Risk:** The prototype can be over-fitted to three rows. Mitigation: three
  rows are chosen to span the interesting cases (grouped under a repository,
  one blocked, one finished), and the live dashboard feature owns the change
  from mock to real data.
- **Dependency carried forward:** if the human review rejects the prototype, the
  design feature reopens before live dashboard work starts. This ordering is the
  whole point of the decision, so a rejection is a schedule event, not a
  setback.

## Implementation References

- Feature document: [Dashboard Design Prototype](../features/dashboard-design-prototype.md)
  — requirements DP-FR-01 through DP-FR-08, and its recorded task review table.
- Ordering and dependency graph: [PRD §14 Features](../PRD.md#14-features) and
  the feature dependency graph, which places the prototype with no
  prerequisites.
- Open question 1 in [PRD §16](../PRD.md#16-open-questions) — whether the design
  review approves the prototype or forces a layout change, with the default
  assumption being acceptance with minor changes.
- Toolchain decisions established here: [ADR-007](ADR-007-single-node-typescript-toolchain.md).
  Open question 6 ([PRD §16](../PRD.md#16-open-questions)) — TypeScript 7.0.2
  with Vitest 5.
- Same pattern applied to the unknown harness question:
  [ADR-005](ADR-005-acp-typed-connector-interface.md) and
  [Copilot CLI ACP Spike](../features/copilot-cli-acp-spike.md).
- Originating rationale: [IDEA.md — Open Questions](../IDEA.md#open-questions),
  "What the dashboard looks like", including the note that this "should be built
  first, before any connector work".
- Paths: `src/dashboard/prototype/`, `src/dashboard/a11y/`,
  `src/dashboard/theme/motion.ts`, `tests/dashboard/`,
  `tests/tooling/runner-convention.test.ts`, `package.json`, `tsconfig.json`,
  `vitest.config.ts`, `eslint.config.js`, `scripts/`.
- Open question 1 is **answered**: the design review approved the prototype, so
  the dependency above did not fire and live dashboard work is unblocked.
