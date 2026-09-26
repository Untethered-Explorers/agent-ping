# ADR-009: On-demand surface; no always-on window in v1

- **Status:** Accepted
- **Date:** 2026-09-26
- **Decision owners:** Project author (settled with the user via `forge-grill-idea`)
- **Implementation state:** Not started. No dashboard, no prototype, and no
  layout exists for this decision.

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

- The hub is a **daemon**; the notification is an **OS toast** that deep-links
  into a local dashboard page. Nothing is pinned, always-on, or topmost in v1.
- The **PixiJS dashboard is still built in v1** — it is what the user lands on
  when a toast is followed. What is deferred is *pinning it to the screen
  permanently*, not the renderer work.
- An **always-on-top ambient panel is explicitly deferred to v2, not
  rejected.** It is the named promotion path if toasts and the badge prove too
  easy to miss.
- **Accessibility is part of the surface, not an add-on**: the canvas is always
  paired with a visually hidden but focusable DOM mirror of every visible row;
  reduced-motion preferences are honoured; **urgency is never encoded by colour
  alone**; text meets **WCAG 2.1 AA contrast** against its background.
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
  rather than smuggled in.
- **Native OS notification only, no dashboard.** Rejected. The orientation need
  is real: a toast can say *that* something is blocked but answering *which
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
- **Cost:** The user must take an action to see state. A missed toast with a
  missed badge means a missed block, which is why the badge count is treated as
  the **durable** signal in ADR-010 rather than the toast.
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
  must be correct at a glance without the dashboard being open. Badge rendering
  for arbitrary counts on every desktop is an open question in the PRD; counts
  above 99 are planned to render as a capped marker while the true count
  remains available in the dashboard and in `status`.

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
- Open questions 2, 3, and 11 in [PRD §16](../PRD.md#16-open-questions) —
  per-platform non-dismissing toast mechanism, and badge rendering for large
  counts.
- Risk: [PRD §12.2](../PRD.md#122-risks), second row — per-platform toast
  behaviour differs, so the badge is the durable signal.
- Feature documents: [Live Dashboard](../features/live-dashboard.md),
  [Dashboard Design Prototype](../features/dashboard-design-prototype.md),
  [Notification and Tray Presence](../features/notification-and-tray-presence.md).
- Originating rationale: [IDEA.md — Where The Surface Lives](../IDEA.md#where-the-surface-lives).
- Planned source locations (**do not exist yet**): `src/dashboard/`,
  `src/notify/`.
