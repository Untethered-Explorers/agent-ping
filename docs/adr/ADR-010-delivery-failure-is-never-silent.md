# ADR-010: Delivery failure is never silent

- **Status:** Accepted, **amended by [ADR-012](ADR-012-surface-is-rendered-by-agent-ping.md)**
- **Date:** 2026-09-26
- **Amended:** 2026-09-27. A surface that cannot mount joins the failure classes this
  decision already covers; a refused class must not be counted as a delivery.
- **Decision owners:** Project author (settled with the user via `forge-grill-idea`)
- **Implementation state:** Implemented, and the failure is visible from all three
  places a caller could look. The breadcrumb is `src/plugin/transport/breadcrumb.ts`
  — one line per failed delivery, written through the harness's own log client,
  carrying a level, one fixed sentence and closed tokens, with **no throttling and
  no de-duplication** (a quiet log during an outage would be a silent failure
  wearing a rate limit's clothes). The storage-failure path is
  `src/hub/ingest-service.ts`, which records a dropped event rather than storing
  it. On the hub side, `src/hub/delivery.ts` keeps a per-event ledger and a
  `lastFailure`, `GET /api/health` reports `delivery.status`, and the
  `toast_deliveries` counter moves only on a real `delivered` outcome — a failed
  attempt is never counted as a delivery, and since ADR-012 a refused class must
  not be counted as one either, which NT-8 fixes in a defect the old registry
  documented and left. A desktop with no usable surface is recorded as
  `not-wired` from both ends rather than passing silently.
  `tests/plugin/transport.test.ts` drives the failure table over **real loopback
  failures**, not mocks. **Not yet verified live:** the breadcrumb path has been
  exercised through a stub logging client and through a live opencode run that
  never reached a hub; no real harness session has yet failed to deliver to a
  real hub. A real desktop *has* been shown a real card from the shipped build
  (NS-4), and a surface that refuses to mount is reported as `not-wired` from
  both ends; macOS and Windows are unobserved. Under ADR-012 the delivery
  mechanism is this product's own rendering, so a surface that refuses to mount is a
  first-class failure of this decision rather than an edge case of someone else's API.

## Context

The hub is a daemon that autostarts on login. Adapters live inside agent
sessions. These two have independent lifetimes: the hub can be down, crashed,
upgrading, or not yet started, while sessions are running. That is a direct
consequence of the sidecar property — agent-ping does not own the sessions, so it
cannot guarantee it is present when they are (ADR-001).

This creates the project's worst available failure mode. The product exists so a
developer learns that a session is blocked. If delivery fails silently, the
developer is not told a session is blocked — and critically, **they have no way
to know that the notification system is the reason they were not told.** Silence
is indistinguishable from "nothing is wrong". That is strictly worse than an
error, because an error would prompt a check.

The same reasoning applies to storage. If an event reaches the hub but cannot be
persisted, the block has effectively been lost. Recording the loss honestly is
required for the failure to be diagnosable at all.

## Decision

**A delivery failure is never silent.** Two failure paths are specified
separately.

### Transport failure — hub absent or unreachable

Delivery from an adapter to the hub is **fire-and-forget with a bounded timeout
and no retry storm**. On failure, the adapter leaves a **visible breadcrumb in
the harness's own user interface** rather than swallowing the event.

The breadcrumb goes in the harness UI deliberately. agent-ping has no surface
of its own that the user is looking at when this happens (ADR-009 — nothing is
on screen), so the only place a message can actually be seen is the harness the
user is already in. Per the research findings, opencode plugins are expected to
log through `client.app.log` with a service name rather than writing to the
console, which is the mechanism that makes the breadcrumb visible rather than
invisible.

### Storage failure — event accepted but not persisted

The durable log **records that an event was dropped** rather than pretending it
was delivered.

### The durable signal

Because the on-demand surface can be missed (ADR-009), a single delivery channel
is not sufficient. The **tray or menu-bar badge carrying the pending count is
the durable signal** — it persists on screen, needs no action, and does not
depend on catching a card at the right moment. A block remains pending until
the harness reports it resolved or the developer acknowledges it, and it
**survives hub restart** unchanged.

## Alternatives Considered

- **Retry delivery until the hub accepts.** Rejected. Many concurrent agent
  sessions retrying against a hub that is down produces a retry storm against
  the user's own machine. It also delays harness shutdown, violating the
  bounded-delivery requirement.
- **Queue events on disk in the adapter and drain when the hub returns.**
  Rejected. This is the standard answer to at-least-once delivery, and it was
  rejected for two reasons. It requires a durable write path in the adapter,
  inside a process owned by someone else, which is a much harder thing to get
  right. And it creates a second store that would need the same content-free
  guarantee as the main log (ADR-003) — a second place to audit, for a
  single-user tool, to solve a problem the breadcrumb already makes visible.
- **Swallow the error and rely on `doctor` being run.** Rejected. `doctor` is
  run when the user already suspects something is wrong. The whole point is to
  surface the failure at the moment it happens.
- **Log to a file only.** Rejected as the sole channel. A log file is not seen
  unless someone goes looking, which reintroduces the silence problem.
- **Raise an error that fails the harness session.** Rejected. This would make
  the notifier able to break the thing it observes — a direct violation of
  ADR-001. The user must never lose agent work because a notification failed.
- **A repeating card as a primary durability mechanism for needs-you.**
  Rejected, and the question is now closed rather than bounded. ADR-004
  originally retained a bounded, deduplicated form of this; its
  [amendment](ADR-004-three-loudness-classes.md) removed the repetition entirely.
  The badge carries the durable signal, so a repeating card is neither needed
  nor wanted. ADR-012 did not reopen this: the card's lifetime policy explicitly
  forbids re-arming.

## Consequences

- **Benefit:** The single most important property of the product — that a
  missed block is not silently missed — has an explicit mechanism behind it
  rather than an assumption.
- **Benefit:** Because the failure is visible in the harness, diagnosis does not
  require the user to suspect agent-ping specifically.
- **Benefit:** The badge is meaningful even if every card is missed, so the
  design degrades to a persistent, glanceable signal rather than to nothing.
- **Cost:** Events are lost when the hub is down. This is accepted and
  deliberately **not** fixed by queueing; the breadcrumb makes the loss visible
  so the user knows the hub was the problem. The alternative — durable adapter
  queues — was considered and rejected for the reasons above.
- **Cost:** A breadcrumb in the harness UI is noise in a context the user did
  not ask to instrument. It is justified because the alternative is invisible
  data loss, and it is bounded to the failure case only.
- **Cost, now resolved:** Per-platform toast behaviour used to differ, so
  "non-auto-dismissing" was only verified on one platform. ADR-012 removes the
  cause: the card is rendered by this product on every platform, so the
  interruption is uniformly persistent. The badge remains the durable signal, but
  for the original reason rather than as compensation for a platform defect.
- **Cost, newly introduced:** the surface can now fail to mount — no usable
  window, no display, a Chromium sandbox abort. That failure is in the same class
  as the ones this ADR already covers: it must be reported, recorded as
  `not-wired` or failed with a reason, visible in `doctor`, and never silently
  treated as delivered. NT-6 and NT-9 own it.
- **Constraint carried forward:** this decision and ADR-001 are load-bearing
  together. The sidecar property is what makes hub-absent a routine state; this
  decision is what makes that state survivable. Removing either one breaks the
  other's assumption.
- **Delivery semantics, stated precisely:** adapter-to-hub delivery is
  at-least-once-with-dedupe *intent*, achieved by a bounded fire-and-forget
  attempt plus hub-side deduplication against a dedupe key. It is **not**
  transport-level exactly-once delivery, and it is not at-least-once in the
  strict sense either, because a failed attempt is dropped rather than retried.
  When the hub is unreachable, the event is lost and the loss is surfaced.

## Implementation References

- Requirements: [APX-FR-02](../PRD.md#8-security-and-privacy) — delivery
  failure is never silent. [APX-CON-10](../PRD.md#8-security-and-privacy) —
  fire-and-forget with a visible breadcrumb. [APX-CON-03](../PRD.md#8-security-and-privacy)
  — sidecar. [APX-CON-01](../PRD.md#8-security-and-privacy) — loopback.
- Pending lifecycle requirements: EL-FR-07, EL-FR-08 in
  [Event Model and Durable Log](../features/event-model-and-durable-log.md) —
  per-block dedupe, and pending surviving restart.
- Research finding on visible logging: [PRD §5 Research Findings](../PRD.md#5-research-findings)
  — `client.app.log` with a service name, rather than the console.
- Risk: [PRD §12.2](../PRD.md#122-risks), second row.
- Originating rationale: [IDEA.md — Availability Contract](../IDEA.md#availability-contract),
  which states the failure mode must never be silence.
- Feature documents: [opencode Plugin Adapter](../features/opencode-plugin-adapter.md),
  [Hub Core and Delivery Policy](../features/hub-core-and-delivery-policy.md),
  [Notification and Tray Presence](../features/notification-and-tray-presence.md).
- Source locations: `src/plugin/transport/breadcrumb.ts`,
  `src/plugin/transport/http.ts`, `src/hub/delivery.ts`,
  `src/hub/ingest-service.ts`, `src/domain/pending.ts`, `src/notify/policy.ts`,
  `src/tray/badge.ts`, `src/hub/metrics.ts`, `tests/plugin/transport.test.ts`,
  `tests/hub/delivery.test.ts`.
- **Still owed:** `doctor`, the diagnostic command that turns this decision's
  evidence into one readable answer, per
  [Install, Autostart and Operations](../features/install-autostart-and-operations.md).
