# ADR-004: Three loudness classes, silent by default, no sound in v1

- **Status:** Accepted
- **Date:** 2026-09-26
- **Decision owners:** Project author (settled with the user via `forge-grill-idea`)
- **Implementation state:** Implemented, with one platform gate still open. The
  classifier table in `src/domain/classify.ts` is the single place a harness
  event becomes a class, and it carries explicit `suppressed` rows for the
  signals this ADR says must not fire — the idle-after-nothing gate is a row in
  that table, not a branch in a notifier. The class *policy* is a second, pure
  table in `src/notify/policy.ts` (`CLASS_POLICIES`), total over the class union,
  where `fyi` is a **named refusal** rather than a no-op and no cell carries a
  sound field. Both tables are enumerated by tests rather than restated:
  `tests/domain/classify.test.ts` and `tests/notify/policy.test.ts`. **Not yet
  verified on a real desktop:** `persistence: 'resident'` is a request to the
  installed notification server, and only Linux has had a real binary run against
  it. Whether a real notification server honours it is still the NT-4 human gate
  (see the Consequences entry on platform sensitivity).

## Context

The product's stated success criterion is **absence of harm**: after two weeks
of use it has not been muted, ignored, or uninstalled. The leading indicator is
*unprompted pull* — the user opening the dashboard without being asked to.

That criterion sets a hard budget. A notification tool's failure mode is not
annoyance; it is becoming ambient background that the user learns to filter out.
Once filtered, the tool is worse than absent, because the user still believes
they are covered.

The specific noise sources to avoid were identified in the source material:

- **Per-subtask firing.** Reporting every completed step of a long task. This is
  the most common way agent tooling becomes noise, because a long task genuinely
  does contain many sub-completions.
- **Repeat timers.** Re-notifying on a timer until acknowledged. Correct for an
  emergency pager, wrong for a tool the user chose to keep running.
- **Sound.** The fastest route to being the notification people kill, and the
  least reversible socially — a sound plays in whatever context the user is in.
- **The empty session.** A session that was opened, greeted, and closed did no
  work and needs no notification.
- **"Task done" versus "session complete" as separate events.** These are the
  same event from the user's point of view, and treating them separately
  multiplies notifications without adding information.

## Decision

Every harness event is classified into **exactly one** of three classes, each
with a fixed delivery policy.

| Class | Trigger | Delivery |
|-------|---------|----------|
| **Needs You** | Session blocked on a permission decision or user input | OS toast, non-auto-dismissing, one per block; persistence carried by the badge and the history |
| **Finished** | Session went idle after doing real work | One notification per idle transition, then silent until the session resumes |
| **FYI** | Errors, retries, long tool calls, compaction, token burn | In-app only; never leaves the app |

Binding rules:

- **FYI carries a subtype** of `error`, `retry`, `long-tool-call`, `compaction`,
  or `token-burn`.
- **The idle gate.** A session that goes idle having performed no work in the
  turn — no tool call, no file edit, no todo update — produces **no event at
  all**. Not a silent event; no event.
- **One finished event per idle transition**, and the session stays silent until
  it resumes.
- **Per-block deduplication.** A block produces one needs-you event per
  unresolved block, deduplicated by session and block identifier. A second
  permission ask for the same block never produces a second event.
- **One needs-you toast per block; no repeat timer.** See the amendment below.
  Persistence across time is the badge and the dashboard history, not a second
  toast.
- **"Task done" and "session complete" are not separate events.** Per-subtask
  firing does not exist in this product.
- **No sound in v1**: no audio, no terminal bell, no notification sound on any
  platform.

## Amendment: needs-you no longer repeats (2026-09-26)

This ADR originally specified that a needs-you notification "repeats until
acknowledged", and the Consequences section flagged that as "a mild escalation
loop … it must not become an unbounded retry". The notification feature
requirement settled that open risk in the opposite direction: **NT-FR-08 forbids
the repeat timer outright** — one needs-you toast per block, with the tray badge
and the history carrying persistence instead.

The decision is therefore **narrowed**, not reversed. The class, its trigger and
its urgency are unchanged, and the badge already existed as the durable signal
this ADR named in Alternatives Considered. What is removed is the repetition.

The rule is now structural rather than documented: `CLASS_POLICIES` in
`src/notify/policy.ts` has no repeat field, no timer and no re-fire path, and
adding one means editing a table a test enumerates. `tests/notify/policy.test.ts`
asserts the absence of a sound-capable argument and the single-toast property.

## Alternatives Considered

- **Sound as opt-in from the start.** Rejected for v1, explicitly deferred
  rather than rejected. The reasoning is ordering: sound is added once the
  signal is trusted, because an untrusted signal that is also audible gets
  silenced in a way that is hard to notice and hard to undo.
- **Per-subtask progress notifications.** Rejected. Directly contradicts the
  absence-of-harm criterion.
- **Repeat on a timer until acknowledged, for all classes.** Rejected. Retained
  only for the needs-you class, where the block is genuinely unresolved and the
  user may be away from the screen. The badge count carries the durable signal
  (see ADR-010).
- **A separate "session complete" event distinct from "finished".** Rejected as
  noise multiplication with no added information.
- **Let the user configure class thresholds in v1.** Rejected. Configuration UI
  before the defaults are trusted would invite tuning toward silence.

## Consequences

- **Benefit:** The default configuration is the restrained one, which is the one
  that has to survive two weeks of contact with a real user.
- **Benefit:** The idle gate is an explicit rule rather than a heuristic
  threshold, so "why did this session not notify me" has a precise answer.
- **Benefit:** Sound being deferred keeps the fastest route to being muted
  unavailable until the signal has earned it.
- **Cost:** A user who genuinely wants per-subtask progress must wait for a
  later version, and the FYI class gives them no escape hatch beyond opening the
  dashboard.
- **Cost:** The non-auto-dismissing toast for needs-you is platform-sensitive.
  The PRD records this as a live risk: the badge count, not the toast, is the
  durable signal, and per-platform implementations ship with scripted checks
  whose human review gate can only be completed on that platform. This is now
  also the *only* persistence mechanism, since the amendment removed the repeat
  timer — which raises the stakes of that gate.
- **Cost:** The idle gate depends on reliably observing tool calls, edits, and
  todo updates for every harness. On a harness that cannot report these
  precisely, the gate is inferred — which is exactly the risk recorded for the
  Copilot adapter (see ADR-005).
- **Resolved risk:** "Repeats until acknowledged" for needs-you was recorded here
  as a mild escalation loop that "must not become an unbounded retry". The
  amendment settled it by removing the repetition rather than bounding it. The
  escalation loop no longer exists; the cost is that an unacknowledged block
  depends on the developer noticing the badge, or a notification server that
  honours `persistence: 'resident'`.

## Implementation References

- Requirements: [APX-CON-04](../PRD.md#9-accessibility) — no sound.
  [APX-CON-11](../PRD.md#7-non-functional-requirements) — performance budgets.
- Classification and gating requirements: EL-FR-04 through EL-FR-07 in
  [Event Model and Durable Log](../features/event-model-and-durable-log.md).
- Delivery requirements: [Notification and Tray Presence](../features/notification-and-tray-presence.md).
- Metrics: notification restraint is tracked as
  [PRD §11](../PRD.md#11-analytics-success-metrics) — zero repeat toasts per
  block, zero sound events, via `toast_deliveries` against `blocks` counters.
- Platform risk: [PRD §12.2 Risks](../PRD.md#122-risks), and open questions 2
  and 3 in [PRD §16](../PRD.md#16-open-questions) on the exact per-platform
  mechanism for a non-auto-dismissing toast.
- Originating rationale: [IDEA.md — What Earns An Interruption](../IDEA.md#what-earns-an-interruption).
- Source locations: `src/domain/classify.ts`, `src/notify/policy.ts`,
  `src/notify/registry.ts`, `src/hub/delivery.ts`, `tests/domain/classify.test.ts`,
  `tests/notify/policy.test.ts`, `tests/notify/registry-selection.test.ts`.
