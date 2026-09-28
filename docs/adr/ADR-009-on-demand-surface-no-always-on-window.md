# ADR-009: On-demand surface; no always-on window in v1

- **Status:** Accepted, **amended in part by [ADR-012](ADR-012-surface-is-rendered-by-agent-ping.md)**
- **Date:** 2026-09-26
- **Amended:** 2026-09-27. Two clauses change: the notification is no longer an OS toast
  (it is a card this product renders), and "no always-on window" is restated as "no
  always-on **visible** surface". The promotion path for a visible panel is unchanged.
- **Decision owners:** Project author (settled with the user via `forge-grill-idea`)
- **Implementation state:** **Partial.** The on-demand half is built; the
  surface it opens is not finished. The hub is a daemon with no window, the
  notification is a card agent-ping renders in its own topmost host window, and
  the card carries a deep link (`DEEP_LINK_QUERY_KEY` = `session`, built from the
  live origin) that the tray click also resolves. The badge is the durable signal
  and it is implemented,
  including the cap this ADR leaves open: `src/tray/badge.ts` renders `1..99` as
  the count, anything above `BADGE_CAP` as `99+`, and never as a wrong number.
  The canvas-plus-DOM-mirror pairing exists and is tested:
  `src/dashboard/prototype/scene.ts` draws with icon-plus-text state encoding
  rather than colour alone, and `src/dashboard/a11y/dom-mirror.ts` pairs every
  visible row with a visually hidden focusable entry keyed by row identity.
  The live half is built too: the hub serves the dashboard at `/`, the page is fed
  by the change stream, and the page-header pending count beside the connection
  state, the acknowledgement control on a blocked row, the copyable handoff
  command and the history panel all exist (LD-1 through LD-3, with the journey
  driven in a real browser by LD-4). The host window exists (NT-6), the card is
  rendered by this product and taken down when its block ends (NS-1 through
  NS-3), and the shipped build's card was **live-verified on Linux/X11 with no
  seam supplied by the run** (NS-4; evidence in
  [docs/reviews/notification-surface-evidence.json](../reviews/notification-surface-evidence.json),
  claims tabulated in [docs/runbooks/notification-surface.md](../runbooks/notification-surface.md)).
  **What has not been observed:** a card has never been seen on macOS or Windows,
  and the tray icon has never been seen on *any* desktop by a human — a
  `StatusNotifierItem` is not an X window, so the live run could not observe it.

## Context

The product has to answer two different needs at two different moments, and they
pull in opposite directions:

1. **Interruption.** The user is doing something else and must learn that a
   session is blocked. This needs to reach them without them watching a window.
2. **Orientation.** The user has arrived and needs to see which projects are
   asking for them. This needs a surface they can look at.

An always-on ambient panel satisfies the second continuously and the first
never. It also occupies screen real estate permanently, which is a cost paid
every minute to solve a problem that occurs a few times a day.

There is a second, non-negotiable constraint: **the product must never become
the thing demanding attention.** Anything permanently on screen is a candidate
for becoming exactly that, regardless of how well designed it is.

A third constraint shapes the implementation rather than the policy: the
dashboard is a **PixiJS canvas**, and a canvas has no accessibility semantics.
Whatever the layout turns out to be, it must be paired with a visually hidden
but focusable DOM mirror so the surface is keyboard-operable and legible to a
screen reader.

## Decision

**The surface is on demand. Nothing occupies screen space until something
actually happens.**

- The hub is a **daemon**; the notification is a **card agent-ping renders
  itself** in its own always-on-top host window, which deep-links into a local
  dashboard page. Nothing is pinned on screen or permanently visible.
- **Amended 2026-09-27.** A topmost *host window* now exists for as long as the
  hub runs. That is not the same as an always-on *visible surface*, and the
  distinction is the whole point: the host window draws nothing and occupies no
  screen space unless a card is actually showing, and `NT-FR-10` makes that a
  testable requirement rather than a distinction in prose. The promise this ADR
  makes is about screen real estate and about the product not becoming the thing
  demanding attention — neither is weakened by a window that is empty.
- The **PixiJS dashboard is still built in v1** — it is what the user lands on
  when a card is followed. What is deferred is *pinning it to the screen
  permanently*, not the renderer work.
- A **persistently visible always-on-top panel is explicitly deferred, not
  rejected.** It is the named promotion path if the badge and the card prove too
  easy to miss.
- **Accessibility is part of the surface, not an add-on**: the canvas is always
  paired with a visually hidden but focusable DOM mirror of every visible row;
  reduced-motion preferences are honoured; **urgency is never encoded by colour
  alone**; text meets **WCAG 2.1 AA contrast** against its background. The card
  is a DOM document rather than a canvas, so it has real text, real focus and a
  real accessible name, and the mirror obligation does not extend to it.
- The **pending count sits next to the connection state** in the page header, so
  a disconnected page cannot be mistaken for a quiet one. This is a correctness
  requirement, not a layout preference.
- **Acknowledgement is a single control on a blocked row.** **Handoff reveals a
  copyable command rather than a button that runs anything** — consistent with
  the sidecar property in ADR-001.
- The history view is a **second panel, not a new page**, so the user never
  loses their place.

## Alternatives Considered

- **Always-on-top ambient panel as the primary surface.** Rejected for v1,
  deferred to v2. It converts a tool that is quiet by default into permanent
  screen furniture, against the "must never become the thing demanding
  attention" constraint. Deferred explicitly so it can be promoted on evidence
  rather than smuggled in. **Reconsidered and still rejected on 2026-09-27** when
  ADR-012 chose the same three-way comparison between an ambient panel, a
  transient card and both; the answer did not change when the delivery mechanism
  underneath it did.
- **Deliver the interruption through the platform notification service.**
  Superseded by [ADR-012](ADR-012-surface-is-rendered-by-agent-ping.md), which
  records why three platform mechanisms, two un-completable verification gates
  and a notification permission prompt were a worse bargain than one card this
  product draws.
- **Native OS notification only, no dashboard.** Rejected. The orientation need
  is real: a card can say *that* something is blocked but answering *which
  projects* needs a surface, and answering it must cost the user nothing
  (unprompted pull is the success metric).
- **A terminal or CLI dashboard.** Rejected. The user is in a GUI desktop
  context, and a terminal surface competes with the terminals they are already
  running agents in.
- **A web page in the user's own browser rather than an Electron window.**
  Rejected as the primary path. It would lose the tray badge's coherence with
  the dashboard and make handoff to a live session awkward. Note that the
  loopback-served dashboard remains important as a **fallback** for driving the
  journey when Playwright browsers cannot be downloaded — that is a test
  affordance, not the product surface.
- **Encode urgency by colour alone on the canvas.** Rejected. Fails the
  accessibility constraint and fails colour-blind users outright.
- **A page per session instead of a grouped list.** Rejected. Contradicts
  ADR-008: the user asks a repository-level question.

## Consequences

- **Benefit:** Screen real estate cost is zero in the common case, which is
  what makes "leave it running" an acceptable instruction.
- **Benefit:** The absence-of-harm criterion is protected structurally, not by
  restraint in configuration.
- **Cost:** The user must take an action to see state. A missed card with a
  missed badge means a missed block, which is why the badge count is treated as
  the **durable** signal in ADR-010 rather than the card. This did not change in
  ADR-012; a card is drawn by this product rather than delegated, and the badge is
  still the thing that is true whether or not anyone looked.
- **Cost:** On-demand surfaces are inherently easier to forget than ambient
  ones. This is a real usability risk, and it is the stated trigger for
  promoting the ambient panel in v2 — the decision is falsifiable in use.
- **Cost, and it is significant:** a **PixiJS canvas is not accessible by
  itself.** Every visible row needs a DOM mirror, and the two must be kept in
  sync. This roughly doubles the surface's rendering work relative to a plain
  DOM UI, and it is the main ongoing cost of choosing a canvas.
- **Cost:** The copyable-command handoff is less convenient than a button. This
  is deliberate — a button that runs a command is a control path, which ADR-001
  and ADR-002 exclude — and it is an accepted friction.
- **Risk:** Motion could help or could add noise; the source material records
  this as unsettleable by discussion, which is why ADR-011 sequences a prototype
  first. Reduced-motion support is mandatory regardless of the outcome.
- **Constraint carried forward:** Because nothing is ambient, the tray badge
  must be correct at a glance without the dashboard being open. The open question
  is now closed in code: `src/tray/badge.ts` caps at `BADGE_CAP = 99` and renders
  `99+` above it, so a badge never claims a number it cannot legibly show. The
  true count remains available through `GET /api/pending` and the dashboard, so
  the badge is never the only place a number exists. **Whether a real desktop
  renders a drawn badge legibly at its real tray size, and whether a click
  reaches the handler, are unverified** — that is the NT-4 and NT-5 human gate.

## Implementation References

- Requirements: [APX-CON-07](../PRD.md#9-accessibility) — canvas plus DOM
  mirror, reduced motion, non-colour urgency encoding, WCAG 2.1 AA contrast.
  [APX-CON-08](../PRD.md#8-security-and-privacy) — single mutating route.
  [APX-CON-09](../PRD.md#63-key-apis-interfaces) — repository identity.
  [APX-CON-11](../PRD.md#7-non-functional-requirements) — first-paint and
  update-latency budgets.
- Goals and non-goals: [PRD G-4](../PRD.md#3-goals-and-non-goals) and the
  non-goal excluding an always-on-top window. Deferred promotion is listed in
  [PRD §13](../PRD.md#13-future-considerations).
- Open questions 11, 13 and 14 in [PRD §16](../PRD.md#16-open-questions) — badge
  rendering for large counts, the Chromium sandbox launch policy, and per-desktop
  compositing. Questions 2 and 3, which asked how to make a per-platform toast
  persistent, are **closed**: no platform notification mechanism is used.
- Risk: [PRD §12.2](../PRD.md#122-risks) — the per-platform toast-behaviour risk is
  removed, and replaced by the risk that the surface host has never run because
  Electron was not a dependency.
- Feature documents: [Live Dashboard](../features/live-dashboard.md),
  [Dashboard Design Prototype](../features/dashboard-design-prototype.md),
  [Notification and Tray Presence](../features/notification-and-tray-presence.md).
- Originating rationale: [IDEA.md — Where The Surface Lives](../IDEA.md#where-the-surface-lives).
- Source locations: `src/dashboard/prototype/`, `src/dashboard/a11y/`,
  `src/dashboard/theme/motion.ts`, `src/tray/badge.ts`, `src/hub/tray.ts`,
  `src/notify/policy.ts` (the deep link), `src/hub/server.ts` (the dashboard
  document route and its CSP).
- **Still owed:** the live page, per [Live Dashboard](../features/live-dashboard.md) — the header pending count, the ack control, the handoff command, the history panel, and the browser-driven journey that would prove them.
