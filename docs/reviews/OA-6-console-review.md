# Human Review: a real opencode session caught end to end

Reviewer: Doug McCusker
Reviewed at: 2026-09-27T21:40:00.000Z
Task: OA-6
Decision: **deferral**

Evidence read, all of it in this repository and all of it re-checkable:

| Source | Built by | What it is |
| --- | --- | --- |
| `docs/reviews/notification-surface-evidence.json` | NS-4 | A real X11 display, the product's shipped build, 22/22 assertions, `verdict: "pass"`, `seams.count: 0` |
| `scripts/verify-opencode-live.mjs` | OA-5 | Drives the **real** `opencode` binary through a real permission decision against a real hub; three journeys |
| `tests/scripts/verify-opencode-live.test.ts` | OA-5 | The script's own test |
| `docs/runbooks/oa-6-opencode-adapter-review.md` | this task's runbook | The procedure this record defers |
| `docs/research/electron-surface-preflight.json` | NT-6 | Electron 44.4.5 on Ubuntu 24.04 / X11, and the launch policy |

---

## Decision: **deferral**

**The human journey was not performed. This gate is closed on machine evidence, and the
three claims that machine evidence cannot reach are named below rather than assumed.**

This is a decision about *evidence*, not about capability. The adapter is built, installed
by one global plugin file, and exercised against a real harness binary. Nothing below
claims the product is broken, and nothing below claims it works in a way these artefacts
do not already show.

## What is already proven, and by what

| Claim | Evidence | Figure |
| --- | --- | --- |
| The product **as shipped** shows a card, with no test-supplied seam | NS-4 `shippedPosture.asserted: true` | 22/22 assertions, `seams.count: 0`; a test reads the script's own source and fails if it substitutes the card document, stylesheet, entry module or renderer bridge |
| The card is a real window inside the work area | NS-4 journey `needs-you` | `320x96+1584+48`, `IsViewable`, inside a `1920x1048` work area reported by `xprop`; 1127 distinct painted values in its own drawable |
| The card uses the product's own colours | NS-4 | needs-you filled with the built stylesheet's own token; finished journey likewise |
| Acknowledging takes the card down | NS-4 | gone **55 ms** after the ack, `ackStatus: 200`, `cardGoneBecause: "no-card-window"` |
| The card appears promptly | NS-4 | **726 ms** after the event |
| A session that does nothing produces nothing | NS-4 journey `greeting-and-close` | no card window; pending set `0 → 0` |
| The OS notification centre received nothing | NS-4 `notificationCentre` | `duringJourneys: 0`, with `positiveControl: 2` from a deliberate `notify-send` through the same monitor. Recorded as `asserted: false` — observed, not asserted, and correctly so |
| A **real opencode session** reaches a real permission decision and the hub stores one needs-you envelope, one resolution and exactly one finished envelope | OA-5 | the script's positive journey, driving the real binary |
| With the hub absent the session still completes and the adapter writes a breadcrumb through the harness's own logging client | OA-5 | absent-hub journey |
| The tray badge's number comes from the accessor the badge reads | NS-4 `badge` | `finalPendingCount: 0`, `toast_deliveries: 2` |
| The Chromium launch policy is load-bearing | NS-4 `machine.launchPolicy` | with `ELECTRON_DISABLE_SANDBOX=1` exit 0; without it, `SIGTRAP` and the setuid-sandbox FATAL |

## What deferral leaves unproven

These are the claims **not** being made. Each is stated so that no reader can infer it
from a green run.

1. **The join nobody has watched: a real permission answered, and the card going away.**
   NS-4 proved the ack *route* dismisses the card. OA-5 proved a real permission *event*
   produces the envelope. No run has joined them, so *"answering a real permission cleared
   the card without a second one appearing"* is unproven. This is the single most important
   claim in OA-6 and it is a person watching a screen for about fifteen seconds.
2. **The tray icon itself.** NS-4 records `tray.observableFromOutside: false` — an Electron
   `Tray` is a `StatusNotifierItem`, not an X window, so the number was read from the
   accessor rather than seen on the icon. Whether the icon mounts, and whether it carries
   the number, has not been observed by a person.
3. **Whether a person can read the card.** NS-4 reads pixels and compares fills. It
   deliberately does not read the card's contents, because doing so from outside the
   process would mean injecting code into the renderer — the shape this product exists not
   to need. The element tree, accessible name, live-region role and reduced-motion
   behaviour are held by `tests/notify/surface-card-view.test.ts` (jsdom) and the
   contrast work, but nobody has looked at the thing on a real display.

A fourth item is a gap in the evidence rather than in the product: **OA-5 declared only the
script and its test as outputs, so `docs/reviews/opencode-live-evidence.json` was never
committed.** Half the end-to-end proof is therefore a script that ran once during OA-5 with
no retained output. Re-running it and committing the file is the cheapest way to strengthen
this record, and it is the one piece of outstanding work here that needs no human.

## Residual risk, including what a user is not told

A developer installing this is told the notification path works. On the evidence above that
is well founded for everything the scripts measure, and a reader who goes to
`docs/reviews/notification-surface-evidence.json` will find the boundary stated in the same
words used here. The risk is narrower than "it might not work": it is that **three
specific things have never been watched by a person**, and one of them — the permission
join — is the one a developer would notice first if it were broken.

`docs/runbooks/notification-surface.md` already refuses to claim macOS or Windows from a
Linux machine, and NS-4's `notVerified` block says so again. This record adds nothing to
that boundary; it records a second one, about who was looking.

## What this decision does not change

- The adapter remains the only delivery path. No platform notifier was reinstated.
- No requirement was weakened, and no acceptance criterion was deleted. The criteria in the
  contract are still the criteria; they are simply not met yet.
- `NT-FR-12` and the NS-4 shipped-posture assertion are unaffected. That assertion was
  about substituting the product, not about human observation, and it holds.

## What would have to change to revisit

Run `docs/runbooks/oa-6-opencode-adapter-review.md`. It is written to be followed, and the
irreducible part of it is smaller than the full document suggests: one permission decision,
one card, and a look at the tray. The bulk of the runbook exists so the reviewer does not
have to rebuild what OA-5 and NS-4 already established. Estimated residual human time is
about five minutes, not a session.

## What this task did not do

- No human ran an opencode session against a real harness for this task.
- No code was changed.
- No claim above was inferred from a passing test. Where a number is cited it is cited from
  the evidence file; where something was not measured, this record says so.
