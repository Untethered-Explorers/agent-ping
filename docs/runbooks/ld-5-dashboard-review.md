# Runbook: reviewing LD-5, the primary dashboard journey

> **Status: this review is owed, not done.** The gate was closed before its subject existed
> — `LD-2`, `LD-3` and `LD-4` were still pending when `LD-5` was attested. See
> [`docs/reviews/LD-5-console-review.md`](../reviews/LD-5-console-review.md) for why, and
> [`docs/reviews/deferred-gates.md`](../reviews/deferred-gates.md) for the debt register.
>
> **This file is the standing procedure for when `LD-4` has completed.** Parts of it cannot
> be written precisely until then: §6 says exactly which parts those are, rather than
> guessing at paths and affordances that `LD-3` has not built yet.
>
> **Do not change code in this task.** `LD-5`'s contract forbids it. List required changes
> as an explicit list; that is the deliverable.

## 0. Why this gate cannot be automated, and what can

`LD-5` asks whether a person can complete a journey. Three of the four acceptance criteria
are about **reach** — what a keyboard user, a screen-reader user, and someone scanning a
busy list can actually get to — and reach is not a property of the DOM. A test can assert a
focusable element exists; it cannot assert you found it.

What *is* already covered, so you do not rebuild it:

| Covered by | What it proves |
| --- | --- |
| `DP-1`…`DP-4`, approved | The design this review holds against real data. `docs/reviews/dashboard-design.json` |
| `LD-2` (pending) | The focusable DOM mirror and keyboard model, unit-tested against live data |
| `LD-4` (pending) | A browser-driven journey through the page against the running hub. It will create `playwright.config.ts` and `scripts/verify-dashboard-e2e.mjs` — **neither file exists yet**, so do not go looking for a run to reuse |
| `NS-4`, complete | The card, its deep link, the tray badge's accessor — `docs/reviews/notification-surface-evidence.json` |

The repository's own `.opencode/skills/canvas-dom-mirror` skill states what the mirror owes,
including *focus retention by identity across a live re-render*. **Read it before the
keyboard pass.** It is where the "can I actually get to it" question is already written down,
and it is the specification your pass is testing.

## 1. Before you start

- A real desktop session with a visible display. A headless run cannot answer any criterion.
- A built repository: `npm run build`, then `npm test` green.
- **A real pending block.** Not a synthetic `POST /api/ingest`. Section 2 says how to get
  one, and the runbook for `OA-6` says how to get one from a real session.
- A screen reader, if you have one. Its absence is a finding to record, not a reason to skip
  the pass — see §4.
- Note your OS, browser, version, display scaling and **any accessibility settings already
  on** (reduced motion, high contrast, screen magnification). Scaling changes density
  judgements, and the review has to name the conditions it was made under.

## 2. Start the hub and get a real pending block

```bash
cd /path/to/agent-ping
npm run build

export AGENT_PING_STATE_DIR="$HOME/.local/state/agent-ping-ld5"
mkdir -p "$AGENT_PING_STATE_DIR"

ELECTRON_DISABLE_SANDBOX=1 \
  node_modules/electron/dist/electron dist/main/main/index.js
```

`ELECTRON_DISABLE_SANDBOX=1` is not optional on a per-user Linux install: Chromium decides
about its sandbox before any JavaScript in this package runs, and without it the binary dies
with the setuid-sandbox FATAL. The same value and the same failure are recorded in
`docs/reviews/notification-surface-evidence.json` under `machine.launchPolicy`.

In a second terminal:

```bash
PORT=$(jq -r .port "$AGENT_PING_STATE_DIR/hub-runtime.json")
TOKEN=$(cat "$AGENT_PING_STATE_DIR/hub-write-token")
curl -sS "http://127.0.0.1:$PORT/api/health" | jq '{status, delivery}'
```

`status` is `ok | degraded` and tracks the **database**. `delivery.status` is a separate
fact and is the one that decides whether a card can appear at all: it must be `"ok"`. A
`not-wired` value means no presenter is attached and criteria 1 and 2 are unanswerable.

The surfaces you need, all read-only except the ack:

| Route | Used for |
| --- | --- |
| `GET /api/pending` | the pending set — the same accessor the badge reads. Use it as your independent count |
| `GET /api/sessions` | sessions grouped by repository short name |
| `GET /api/sessions/:sessionId` | one session and its recent events |
| `GET /api/events` | bounded history |
| `POST /api/ack/:eventId` | acknowledge, with `x-agent-ping-token` |
| `GET /` | the dashboard, under a strict CSP |

A real block comes from a real session — drive `opencode` to a permission decision as
`docs/runbooks/oa-6-opencode-adapter-review.md` §6 describes. **Record which it was.** If
you had to fall back to a manual `POST /api/ingest`, say so, because that is a weaker
starting point and the note must not hide it.

Take a **"before" reading** of the pending set and the badge. You will compare them, and
criterion 2 is about the two agreeing *throughout* the journey, which needs a starting point.

## 3. Pass one — mouse

The primary journey, in order, without skipping steps:

1. Notice the card or the badge.
2. Open the dashboard **from the card's deep link**. The card carries `?session=<id>` on the
   loopback dashboard URL (`src/notify/surface/card.ts`).
3. **Which repository is asking?** This is the first thing a returning developer needs
   (`LD-US-01`) and it must be readable without expanding anything.
4. Open the dashboard **from the tray** instead, and confirm it focuses the same session.
5. Read the blocked row: what is blocked, in which repository, since when.
6. Acknowledge it, and confirm the card comes down and the count follows.
7. Hand the session off to a terminal.

Record for each step: what you expected, what you got, and how long it took you to find.
The "how long" column is the useful one — a control that is present, labelled and
technically reachable but that you had to hunt for has failed in practice, and that is
exactly the judgement a test cannot make.

## 4. Pass two — keyboard only, and pass three — screen reader

Put the mouse down. Not "prefer reduced motion" — **unplug it or put it out of reach**, and
do not use it for the rest of the pass.

| Pass | What must hold | What to record |
| --- | --- | --- |
| Keyboard only | Every action in §3 reachable by keyboard. Focus visible at all times. One focusable entry per visible row, in canvas order. Urgency never signalled by colour alone. Focus not lost when the live stream re-renders under you | What you reached, what you could not, and the two or three places you got lost |
| Screen reader (if available) | The same journey again | Same, plus what the reader *announced*: row identity, state, and what the actions are called |

`APX-CON-07` is the constraint these passes exist to check: the PixiJS canvas is always
paired with a visually hidden but focusable DOM mirror of every visible row, so the
dashboard is operable by keyboard and legible to a screen reader.

**The obligation is symmetric.** A pass that reports only what worked is not evidence of a
pass. If the screen reader is not available to you, write that plainly — *"no screen reader
available on this machine; criterion 3 unverified"* — and **do not report a pass for it**.
That is the exact wording `IO-5`'s own criterion 4 demands of the platform claims, and the
reason it is worded that way is that a review which quietly reports success for something it
did not do is worse than no review.

## 5. Pass four — density, and whether the approved design survived

The design was approved in `DP-4` against **synthetic data**. This is the criterion that
cannot be substituted, because it is the one thing the prototype could not tell you.

- A repository with **several sessions** and a **long history**.
- Does grouping by repository still work, or does the second group become invisible?
- Can you find the blocked row among the finished ones, without reading everything?
- Does the state encoding survive contact with repetition — does urgency still read as
  urgent when eight other rows are also coloured?
- At your display scaling, with your window size.

Record the verdict as a judgement in words, plus any specific density failure with the row
count and window size it happened at. "It got busy" is not a usable finding.

## 6. What this runbook cannot tell you yet, and must not guess

Written before `LD-2`, `LD-3` and `LD-4` exist. These are the places to fill in once they
have run, rather than assumptions baked in now:

- **The exact affordances** `LD-3` will provide for acknowledge, deep-link focus, handoff
  and history — the key bindings, the control names, the focus targets.
- **Whether the mirror's focus retention** survives a live update in practice. `LD-2`'s unit
  tests will cover the identity-keyed behaviour; §4 is the only place it gets used on
  purpose.
- **What `LD-4`'s Playwright journey already asserts**, so you do not repeat it and so you
  know which parts of your pass are the *only* evidence.

Update this section when `LD-4` completes. A runbook that guesses at affordances is worse
than one that admits it does not know them yet.

## 7. Record the verdict

Write `docs/reviews/LD-5-console-review.md`. It currently holds the "not reviewable"
decision and the list of owed criteria — **replace the decision, keep the owed list and
update it.** A verdict that deletes the residual rather than resolving it is the failure
mode this project has hit before.

```markdown
## Verdict
<approved / not approved, one sentence>

## Required changes
Explicit list. Each: what, where, and why it blocks. Listing is the deliverable;
fixing is out of scope for this task.

## Conditions
OS, browser, scaling, accessibility settings, screen reader used or not.

## Per-pass reach
Mouse: <reached / not reached>. Keyboard: <…>. Screen reader: <…, or "not available —
unverified">.

## Density
<row count, window size, judgement, specific failure if any>

## Residuals
<what remains unverified after this review, if anything>
```

Then attest, from the CLI. **Not** the console's approve form: it regenerates
`docs/reviews/LD-5-console-review.md` from a single notes field and would overwrite
everything above.

```bash
cd .opencode/skills/forge-workflow-engine
npm run workflow-engine -- approve-task LD-5 \
  --repo /path/to/agent-ping \
  --reviewer "Your Name" \
  --evidence docs/reviews/LD-5-console-review.md \
  --confirm-human-review
```

Then remove `LD-5`'s row from `docs/reviews/deferred-gates.md` and date it.

## 8. The traps

- **Reviewing a synthetic pending set.** A hand-written `POST /api/ingest` proves the page
  renders an event. It does not prove the journey a developer takes after a real
  interruption. Say which you used.
- **Passing the keyboard journey with the mouse within reach.** You will cheat without
  noticing. Put it down.
- **Reporting a screen-reader pass you did not run.** See §4. This is the specific failure
  the wording of criterion 4 exists to prevent.
- **Checking the badge and the page at one instant.** Criterion 2 is that they agree
  *throughout*. Watch them across an acknowledgement, not once.
- **Judging density on three rows.** That is what `DP-4` already approved.
- **A pass that only lists successes.** Every pass reports what it could not reach.
- **Fixing what you find.** `LD-5` forbids code changes. The list is the deliverable.
- **Attesting, then tidying the review file.** The gate re-hashes its evidence on every
  check; editing after attesting silently invalidates it and the next `run` will reset the
  task and everything downstream of it.
