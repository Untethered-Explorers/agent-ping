# Human Review: the primary dashboard journey

Reviewer: Doug McCusker
Reviewed at: 2026-09-27T21:40:00.000Z
Task: LD-5
Decision: **not reviewable — the subject does not exist yet. The review is owed.**

---

## Decision: this is not a deferral of a reviewable thing

**At the moment this record was written, there was no live dashboard to review.** This gate
is being closed against work that has not been written, which is a different thing from OA-6
and is recorded differently on purpose.

The distinction matters because of *when* the engine will run. Closing this gate now marks
it complete, and the tasks that build the subject — `LD-2`, `LD-3`, `LD-4` — run **after**
this point. So this gate will read "complete" in `docs/WORKFLOW-STATE.json` while the
software it exists to judge is still being built, and nothing in the engine will ever
re-open it.

That is not a reason to leave it blocking. It is a reason to be exact about what is owed,
and to record the debt somewhere it cannot be lost. The debt register is
`docs/reviews/deferred-gates.md`; the procedure is `docs/runbooks/ld-5-dashboard-review.md`.

## State of the subject at decision time

| Task | State | What it would have provided |
| --- | --- | --- |
| `LD-1` | **complete** | The page rendering live hub state, grouped by repository, with staleness. Real, and reviewed by no one at the level of a journey |
| `LD-2` | pending | The focusable DOM mirror and the keyboard model. This is what makes `LD-5`'s keyboard pass possible at all |
| `LD-3` | pending | Acknowledge, deep-link focus, terminal handoff, history. Four of the five things `LD-5` is asked to judge |
| `LD-4` | pending | A browser-driven Playwright journey against the running hub |
| `NS-4` | complete | The notification card, the deep link's origin, the tray badge's accessor |
| `DP-4` | complete, approved | The design record this review is meant to hold against real data |

So of the five acceptance criteria below, **none could be exercised.** Not one. `LD-3` is
where acknowledge, deep-link focus, handoff and history live, and it had not run.

## The review that is owed

Each criterion is restated with the specific thing that must be observed, so that whoever
picks this up does not have to reconstruct the intent from the task text.

1. **Three passes, and what each can reach.**
   - *Mouse*: the full journey — notice the card or the badge, open the dashboard from the
     card's deep link, identify which repository is asking, read the blocked row,
     acknowledge it, hand the session off to a terminal.
   - *Keyboard only*: the same journey with no pointing device at any point. `APX-CON-07`
     requires the PixiJS canvas to be paired with a visually hidden but focusable DOM mirror
     of every visible row, so the pass must confirm the mirror is real, focusable, and
     reaches the same rows in the same order.
   - *Screen reader*, where available: the same journey again, and this pass must state
     what it **could not** reach, not only what it could.

   The obligation is to state what each pass could and could not reach. A pass that reports
   only successes is not evidence of three passes.
2. **Deep link and tray both focus the right session, and the count matches the badge
   throughout.** Open the dashboard from the card's deep link and again from the tray, and
   confirm each time that the correct session is focused. Watch the pending count against
   the tray badge for the whole journey — the product's promise is that the badge and the
   page never disagree (`LD-US-02`), and a disagreement is invisible to any single-instant
   check.
3. **Density under real data.** A repository with several sessions and a long history, and
   a judgement on whether the approved design survived contact with it. The prototype was
   approved on synthetic data (`DP-4`); this is the criterion that cannot be substituted.
4. **A verdict, and every required change as an explicit list.** Listing required changes
   is not a code change. `LD-5`'s own contract forbids editing code in this task.

## What the constraints require that a test cannot

`LD-5` carries `APX-CON-07` as a constraint, and the interesting half of it is not
machine-checkable in this repository's current state:

- the canvas/mirror pairing — checkable, and `LD-2` will hold it
- urgency never encoded by colour alone — checkable
- text meeting WCAG 2.1 AA contrast — checkable
- **reduced-motion preferences honoured** — checkable in a jsdom test, and only really
  visible to a person watching a live update
- and the whole of criterion 1, which is about what a person can *reach*, not about what
  the DOM contains

The project's own `.opencode/skills/canvas-dom-mirror` skill holds the obligations `LD-2`
implements, including focus retention by identity across a live re-render. A reviewer
should read it before the keyboard pass, because it states what the mirror owes; that is
where the "can I actually get to it" question is already written down.

## Residual risk, including what a user is not told

The dashboard is the surface a developer lands on after being interrupted, and **no
keyboard or screen-reader user has ever used it.** The mirror, the keyboard model and the
`APX-CON-07` pairing are specified and will be unit-tested by `LD-2`, and `LD-4` will drive
a browser through a journey. None of that is the same as a person who does not use a mouse
finding that the journey completes.

The narrower and more likely risk: **`LD-3`'s four interactions are unbuilt, so the primary
journey this gate names does not currently exist end to end.** A reader must not infer from
this record that the dashboard was found to work. It was not examined.

## What this decision does not change

- No acceptance criterion was deleted, weakened, or marked met. All four stand, unmet.
- `DP-4`'s approval is untouched. The design was approved; this record does not withdraw
  that, and does not claim the design met real data.
- No code was changed, and none of the four pending tasks was re-scoped to make closing
  this gate easier.

## What would have to change to revisit

Run `docs/runbooks/ld-5-dashboard-review.md` after `LD-4` completes, then re-open this
gate. A gate cannot be re-opened by the engine once it is complete, so a follow-up has to
be raised as new work; `docs/reviews/deferred-gates.md` tracks that obligation.

## What this task did not do

- No human opened the live dashboard.
- No journey was performed, by mouse, keyboard or screen reader.
- No judgement was formed about density, focus, legibility or the approved design.
- No code was changed.
