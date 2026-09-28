# ADR-012: The surface is rendered by agent-ping, not the platform

- **Status:** Accepted
- **Date:** 2026-09-27
- **Decision owners:** Project author (settled with the user)
- **Supersedes:** the clause in [ADR-009](ADR-009-on-demand-surface-no-always-on-window.md) that the notification is an OS toast, and the per-platform implementation strategy in [ADR-004](ADR-004-three-loudness-classes.md)
- **Implementation state:** **Implemented, and live-verified on Linux.** NT-8 removed
  the three platform notifiers, their registry and their 56 tests, and the card this
  product renders is now the only delivery path; `tests/notify/policy.test.ts` sweeps
  `src/notify` so none of them can come back. NS-1 through NS-3 built the card
  document, the renderer channel that leaves `contextIsolation` on and the renderer
  sandbox in force, and the dismissal when a block ends. NS-4 then re-proved the
  **shipped build** on a real Linux desktop with no seam supplied by the run: a real
  window inside the work area, painted with the product's own fill, taken down 55 ms
  after acknowledgement, and silence for a session that does nothing. Evidence:
  [docs/reviews/notification-surface-evidence.json](../reviews/notification-surface-evidence.json);
  claims tabulated in
  [docs/runbooks/notification-surface.md](../runbooks/notification-surface.md).
  **What has not been observed:** a card on macOS or Windows. The implementation is
  one code path with no platform branch, but only Linux was ever run, and the
  compositing that differs between the three desktops is unobserved elsewhere.

## Context

Version 1.0 of this product delivered its one interruption — a session blocked on a
decision only the developer can make — through the operating system's own notification
service: `notify-send` and libnotify on Linux, a notification-centre call through
`osascript` on macOS, a PowerShell toast on Windows. Three problems with that turned out
to be one problem.

**The mechanisms are not equivalent, and the differences land on the user.** Only Linux
had a resident, non-auto-dismissing notification. The macOS call could not express
persistence, urgency or activation at all, and the runbook recorded as much. Windows
needed a hand-built toast XML payload, base64-encoded through a PowerShell script, with
a deliberately long timeout because the hub can abandon the call before the toast lands.
The product's core promise — tell me once, clearly, and then leave me alone — was the one
thing the platform could not reliably honour on two of three platforms.

**The verification could not be completed by construction.** A needs-you delivery is the
product's one interruption, and the design required proving it on a real desktop. That
meant NT-4, a real toast on Linux, and NT-5, the same on macOS and Windows. NT-5 could
only be performed on machines that did not exist for the person building this, and it
blocked fourteen later tasks behind it, because a cross-feature dependency in the
execution manifest resolves to the *last* phase of the feature it depends on. The
toolchain was paying for a decision nobody could check.

**The real adoption cost was not the toast, it was the permission prompt.** Integrating
with a platform notification service means asking the user for a notification
permission, inheriting their focus-assist and do-not-disturb settings, and depending on
a notification daemon being present and configured at all. A developer whose desktop has
no working notification service, or who has muted notifications on purpose, would get
nothing at all from a tool whose entire job is to tell them when they are blocked. The
runbook flagged the macOS first-run permission prompt as "a real observation to record" —
it was not a footnote, it was the adoption barrier.

Underneath all of it sat a worse problem. `electron` was not a dependency of this
package at all. `src/main/index.ts` loads the desktop shell through a non-literal
specifier specifically so the tree stays typecheckable without it, and the header on the
tray bridge says plainly that none of that code has ever run. The tray badge — the
*durable* signal that ADR-004, ADR-009 and ADR-010 all lean on — had never been observed
on a real desktop. NT-4 was approved with a review recording that the reviewer did not
see the badge increment. So the platform-toast decision was not the only thing
unverified; the entire desktop shell was.

## Decision

**agent-ping renders its own notification. No platform notification service,
notification centre, focus-assist mechanism or notification permission is used on any
platform.**

Concretely:

- A **card** is a DOM document that agent-ping draws in an always-on-top, frameless,
  transparent, taskbar-skipping, unfocusable window it creates and owns. It is
  positioned inside the display work area, it is click-through until the pointer reaches
  it, and it is shown with `showInactive` so it never steals a keystroke.
- The card's **lifetime is this product's own policy**, expressed as `until-resolved` or
  `expires` rather than a platform's `resident`. A needs-you card is shown once and is
  not re-armed; persistence is carried by the tray badge and the history, exactly as
  ADR-004 already decided.
- The **tray icon and its drawn badge are unchanged.** A status-area icon is presence,
  not notification, and it remains the durable signal.
- The **class policy, the deep link and the three loudness classes are unchanged.** Only
  the mechanism underneath them moved.
- The card is **DOM, not canvas**, so it has real text, real focus and a real accessible
  name, and the canvas-plus-DOM-mirror obligation in APX-CON-07 does not extend to it.
- **One implementation serves all three platforms.** There is no per-platform branch, and
  a test enforces that rather than a promise asserting it.

## Alternatives Considered

- **Keep the platform notification services and fix the weak platforms.** Rejected. It
  cannot fix the permission prompt, it cannot fix a machine with no notification daemon,
  and it cannot make NT-5 completable. It also leaves the badge, which is the durable
  signal, resting on a desktop integration that has never run.
- **A persistently visible always-on-top panel (the deferred v2).** Rejected for now. It
  answers the interruption need continuously and permanently occupies screen space, which
  is the exact trade ADR-009 declined and the reason this product promises to stay quiet.
  It remains the named promotion path if the badge and the card prove too easy to miss.
- **Both a visible panel and a transient card.** Rejected for the same reason as the
  panel alone, at twice the surface cost. The badge already carries the durable count, so
  a visible panel duplicates a signal that exists.
- **Drop notifications entirely and rely on the dashboard and the badge.** Rejected. The
  orientation need and the interruption need are genuinely different; a badge that
  changes while you are not looking is not an interruption.
- **A terminal or CLI surface.** Rejected, as in ADR-009. The user is in a GUI desktop
  context and already runs agents in terminals.

## Consequences

- **Benefit:** one implementation, one set of claims, one runbook. What remains
  platform-specific is window-manager compositing, which is a far smaller and far more
  honestly stateable surface than three notification APIs.
- **Benefit:** no permission prompt, no focus-assist inheritance, and no dependency on a
  notification daemon existing. A developer who has muted notifications on purpose still
  hears from this tool, which is the whole point of it.
- **Benefit:** the interruption is now *reliably* persistent on every platform, because
  persistence is our policy rather than a platform's hint.
- **Benefit:** NT-5's reason to exist is gone, and with it the block on the fourteen tasks
  behind it.
- **Cost, and it is the significant one:** **the desktop shell becomes load-bearing and
  had never run.** The card, the badge and the dashboard window all execute inside
  Electron, which was not a dependency. NT-6 makes it one; NT-9 drives a real window from
  a script. Until NT-9 passes, this decision is a design that has been probed but not
  shipped.
- **Cost:** Electron is now a runtime dependency with its footprint, autostart behaviour
  and platform quirks, and this product is still a notification daemon. ADR-007 already
  accepted that trade for the tray; this decision makes it unavoidable rather than
  optional.
- **Cost, and it is a real one:** the pre-flight found that an unprivileged per-user
  Electron install **cannot use a Chromium sandbox on Ubuntu 24.04** — the npm-installed
  `chrome-sandbox` helper is not setuid-root, and the unprivileged user-namespace
  fallback is blocked by AppArmor. A per-user install must launch with `--no-sandbox`.
  NT-6 must choose and assert that policy explicitly rather than let the packaged
  application abort at startup, and the runbook must state it. `webPreferences`
  `sandbox: true` is a renderer-level setting and remains in force independently.
- **Cost:** a topmost window now exists for as long as the hub runs, where version 1.0
  promised no always-on window at all. ADR-009 is amended rather than ignored: the
  distinction drawn there is between an always-on *host* that renders nothing and
  occupies no screen space, and an always-on *visible* surface, and only the second is
  the thing the product promised not to become. `NT-FR-10` makes that a testable
  requirement rather than a distinction in prose.
- **Cost:** transparency compositing is window-manager dependent, so a card could be
  mispositioned or invisible somewhere. This is now a one-line manual check per desktop
  instead of a three-platform API integration, and the honest claim is narrower.
- **Constraint carried forward:** the badge remains the durable signal. Nothing about this
  decision weakens ADR-010's reliance on it; a missed card is still a missed signal and
  the count is still what proves the block is real.
- **Known misnomer left in place:** the local counter is still called
  `toast_deliveries`. Renaming a persisted counter would pull the content-free schema
  guard into this track change for no functional gain, so it is deferred to its own
  change and recorded in PRD Open Question 15.
- **Also fixed in passing:** a refused class — every fyi event — currently resolves
  through the delivery port as though it had been delivered, so the delivery counter and
  the ledger overstate what was shown. NT-8 fixes it, because a surface that renders its
  own output makes the difference between "refused" and "delivered" visible and
  unignorable.

## Superseded and amended records

- [ADR-009](ADR-009-on-demand-surface-no-always-on-window.md) — the OS-toast clause is
  superseded; the always-on wording is amended to distinguish a host window from a
  visible surface. The ambient-panel promotion path is unchanged.
- [ADR-004](ADR-004-three-loudness-classes.md) — the three classes, the no-repeat-timer
  amendment and the no-sound rule all stand. Only the delivery mechanism named in the
  needs-you row changes.
- [ADR-001](ADR-001-sidecar-not-supervisor.md) — the enumeration of process spawn sites
  loses the notification command, because the surface spawns nothing.
- [ADR-007](ADR-007-single-node-typescript-toolchain.md) — the technology table loses its
  libnotify row, and Electron's status changes from a shell that is not installed to a
  runtime dependency.
- [ADR-010](ADR-010-delivery-failure-is-never-silent.md) — a refused or un-mountable
  surface joins the failure-visibility list.

## Implementation References

- Requirements: [APX-CON-02 style delivery boundary](../PRD.md#6.3-key-apis-interfaces) —
  the surface is reached through the same delivery port the platform notifiers used, so
  nothing above that boundary changed. [APX-CON-04](../PRD.md#9-accessibility) — no
  sound, now a property of our own renderer. [APX-CON-06](../PRD.md#61-technology-stack)
  — one implementation for three platforms. [APX-CON-07](../PRD.md#9-accessibility) —
  canvas plus DOM mirror, which the DOM card does not require.
  [APX-CON-12](../PRD.md#7-non-functional-requirements) — no telemetry leaves the
  machine, and the surface adds no outbound call.
- Feature: [Notification and Tray Presence](../features/notification-and-tray-presence.md),
  requirements `NT-FR-01` through `NT-FR-11`, tasks NT-6 through NT-9.
- Probe: [docs/research/electron-surface-preflight.json](../research/electron-surface-preflight.json).
- Runbook: `docs/runbooks/notification-surface.md`, written by NT-8 and completed by
  NT-9.
- Originating rationale: [IDEA.md — What Earns An Interruption](../IDEA.md#what-earns-an-interruption),
  whose class table is unchanged in substance and only in mechanism. IDEA.md itself is
  the frozen idea of record and was not edited.
