# ADR-005: Connector interface specified in ACP terms

- **Status:** Accepted
- **Date:** 2026-09-26
- **Decision owners:** Project author (settled with the user via `forge-grill-idea`)
- **Implementation state:** **Partial.** The interface exists — the normalized
  envelope is `src/domain/envelope.ts` and the delivery sink is
  `POST /api/ingest` — and opencode is a working reference adapter in
  `src/plugin/opencode/`. What is missing is the second harness: no Copilot
  adapter and no ACP probe exist yet, so the gate decision this ADR depends on
  has not been made. The two things that keep the *decision* honest in the
  meantime are already in place. `KNOWN_HARNESSES` is a closed union, so a
  harness is a one-line addition rather than an edit. And the classifier's table
  already carries eleven `copilot-cli` rows, marked `observed` or `unresolved`
  where upstream is unresolved — the signals are recorded rather than invented,
  which is what this ADR requires before the spike.
  **The ACP version claims below remain research findings recorded in the PRD,
  not verified by this repository**; nothing here has been confirmed against a
  live ACP session.

## Context

The product needs to observe more than one coding-agent harness. The original
framing was "a connector installed in every repository" for one harness. That
was replaced by a global install for one harness (ADR-006), which raises the
question of what happens when a second harness is added.

Two harnesses are in scope: **opencode** (instrumented natively through its
plugin API) and **GitHub Copilot CLI** (instrumented as a second adapter). Both
speak the **Agent Client Protocol** — `opencode acp` and `copilot --acp` — and
ACP is at protocol version 1 with a published TypeScript SDK.

The design question is where the seam goes. If the normalized event model is
defined in terms of one harness's plugin events, adding a second harness means
translating it into the first harness's vocabulary, and the hub's core concepts
acquire the shape of whichever harness happened to be first. If it is defined in
terms of an existing open protocol, a third harness is a new adapter that
produces a known envelope.

There is an important asymmetry to preserve. opencode's native event feed
reports idle and permission events **precisely**, whereas ACP's equivalents are
not established. The connector contract should therefore be shaped by ACP for
portability, without pretending ACP is the best available source for every
signal on every harness.

## Decision

The connector interface is specified in **Agent Client Protocol terms**: a
harness adapter translates its own events into the normalized envelope and
delivers it to the hub. The consequence is that a third harness is **additive
work** rather than a rewrite of the hub, the store, or the dashboard.

The interface is two things:

1. **A normalized event envelope** — harness, session identifier, repository
   short name and full path, raw event type, class, optional subtype, ISO 8601
   UTC occurrence and receipt timestamps, and a dedupe key. No field capable of
   holding content (ADR-003).
2. **A delivery sink** — the hub's ingest endpoint, reached with bounded,
   fire-and-forget delivery (ADR-001, ADR-010).

Two consequences are bound by this decision:

- **opencode is the reference implementation** of the connector interface, via a
  single global plugin. Its native feed is preferred over ACP for that harness
  because it reports idle and permission events precisely rather than by
  inference.
- **Precision is a per-adapter property, not a protocol guarantee.** Where a
  harness cannot report a signal, the adapter must degrade explicitly rather
  than pretend. The recorded position for Copilot is that its documented hooks
  (`sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse`,
  `postToolUse`, `errorOccurred`) contain **no documented idle or permission
  hook**, and whether ACP mode emits `session/request_permission` is unresolved
  upstream. On that harness the needs-you class is therefore a **heuristic**
  until proven otherwise.

The Copilot question is gated behind a spike whose deliverable is a recorded
decision — either a second adapter or an explicit deferral. The PRD's default
position is deferral: v1 ships opencode only unless the spike proves the signals
exist.

## Alternatives Considered

- **Define the connector interface in opencode's native plugin vocabulary.**
  Rejected. It makes opencode structurally privileged and turns every later
  harness into a translation into someone else's event names.
- **Use ACP for everything, including opencode, for symmetry.** Rejected. ACP
  is the portable contract, but using it as the *source* on opencode would
  discard precisely-reported idle and permission events in exchange for
  uniformity. Uniformity is not worth degraded signal on the primary harness.
- **Skip Copilot entirely; opencode only, permanently.** Rejected as a product
  decision — the user runs both harnesses. Retained as the **default shipping
  position** for v1 pending the spike, which is a narrower commitment.
- **Build the Copilot adapter on the assumption its hooks are sufficient.**
  Rejected. This is the specific failure the spike exists to prevent: an adapter
  built on a guess, producing a needs-you class that is unreliable on exactly
  the harness where reliability matters most.

## Consequences

- **Benefit:** A third ACP-speaking harness is an adapter, not a rewrite.
- **Benefit:** The hub, store, and dashboard contain no harness-specific
  concepts, so a harness deprecation does not reach them.
- **Benefit:** The uncertain part of the product is isolated behind one spike
  with a recorded gate decision, rather than being distributed across adapter
  work.
- **Cost:** Two event sources must be understood and kept current — opencode's
  plugin API and ACP version 1 — and each is a drift risk on a future upstream
  release. The PRD mitigates this with a version check in `doctor` and a pinned
  plugin package version.
- **Cost:** The needs-you class has **different reliability on different
  harnesses**. This must be surfaced to the user rather than hidden; a
  notification that is silently less reliable on one harness is worse than an
  absent feature.
- **Cost:** ACP is specified at protocol version 1, so ACP-level changes are
  additive and non-breaking, but the reference is young and the SDK is a
  dependency the project does not control.
- **Risk:** The PRD records the ACP permission/idle notification names as an
  **open question**, to be resolved by recording observed names verbatim during
  the spike rather than assumed. Any mapping written before that evidence exists
  is speculative.

## Implementation References

- Requirements: [APX-CON-13](../PRD.md#63-key-apis-interfaces) — connector
  interface in ACP terms. [APX-CON-09](../PRD.md#63-key-apis-interfaces) —
  repository identity.
- Research findings and their stated verification boundary:
  [PRD §5 Research Findings](../PRD.md#5-research-findings) — verified against
  vendor sources on 2026-09-26, not verified by this repository.
- Technology table including the ACP SDK: [PRD §6.1](../PRD.md#61-technology-stack).
- Open questions 5 and 12 in [PRD §16](../PRD.md#16-open-questions) — ACP
  notification names, and whether the Copilot gate authorises a heuristic
  needs-you for v1.
- Risks: [PRD §12.2](../PRD.md#122-risks), first row.
- Feature documents: [opencode Plugin Adapter](../features/opencode-plugin-adapter.md),
  [Copilot CLI ACP Spike](../features/copilot-cli-acp-spike.md).
- Originating rationale: [IDEA.md — Scope](../IDEA.md#scope) and
  [IDEA.md — Open Questions](../IDEA.md#open-questions), which records the
  Copilot hook question as "a spike to run early, not a design decision".
- Source locations: `src/domain/envelope.ts`, `src/domain/classify.ts`,
  `src/plugin/opencode/` (the reference adapter), `src/plugin/transport/`,
  `src/hub/routes/ingest.ts`, `tests/plugin/opencode-translate.test.ts`.
- **Still owed:** the Copilot CLI ACP spike and its recorded gate decision, per
  [Copilot CLI ACP Spike](../features/copilot-cli-acp-spike.md). Until that
  decision is recorded, the `copilot-cli` rows in the classifier must stay
  marked unresolved rather than gain invented mappings.
