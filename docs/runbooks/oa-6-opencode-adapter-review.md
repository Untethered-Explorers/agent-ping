# Runbook: reviewing OA-6, a real opencode session caught end to end

> **Status: this review is owed, not done.** The gate was closed on **2026-09-27** with a
> deferral: the human journey was not performed, and the three claims only a person can
> settle are named in [`docs/reviews/OA-6-console-review.md`](../reviews/OA-6-console-review.md).
> Read that record first — it says what is already proven and what is not, so you do not
> redo it. This file is the standing procedure for when the review is taken up.
>
> The irreducible part of it is much smaller than the whole document suggests: **one
> permission decision, one card, and a look at the tray.** Everything else here exists so the
> reviewer does not have to rebuild what `OA-5` and `NS-4` already established. Estimated
> residual human time is about five minutes. Tracked in
> [`docs/reviews/deferred-gates.md`](../reviews/deferred-gates.md).
>
> This is the procedure for the one gate in this project that **cannot** be automated.
> Every other gate in the run has either a test or a script behind it. This one needs a
> person, a real model, a real desktop and their own eyes, and that is not a gap in the
> tooling — it is the claim. Follow it as written, record what you actually saw, and
> change no code.
>
> **The task:** `OA-6` in `docs/EXECUTION-MANIFEST.json`. Its machine gate is written to
> `docs/reviews/opencode-adapter.json`; your written review is
> `docs/reviews/OA-6-console-review.md`. The contract's own instruction is *"Do not change
> code in this task."*

## 0. Why this gate exists when two scripts already cover the ground

Two instruments in this repository already prove most of the chain, and each says out loud
where it stops. This gate is the join between them, and the join is the part only a person
can see.

| Instrument | What it proves | What it explicitly does **not** claim |
| --- | --- | --- |
| `scripts/verify-opencode-live.mjs` (OA-5) | A real opencode session that reaches a permission decision and goes idle makes the hub store one needs-you envelope, one resolution and exactly one finished envelope; a greeting session stores nothing; with the hub absent the adapter writes a breadcrumb through the harness's own logging client | It supplies a **recording** surface and presenter, so it counts what it was *asked* to show. Its own header says *"Whether a real window is on a real display is NT-9's script and its X server, not this one's claim."* |
| `scripts/verify-notification-surface.mjs` (NT-9, NS-4) | The product's **shipped build** puts a real, painted, card-shaped window inside the work area, in the product's own fill colour, and takes it down again; the acknowledgement removes it in ~55 ms | *"Nothing in this file is a claim that a human read a word off a card."* It reads pixels and compares fills. Legibility stays a manual, per-platform step. |
| **You** | That a real session caused a real card a real person could read, that the OS notification centre stayed empty, that the tray badge tracked the pending count, and that answering the permission dismissed the card without a second one appearing | — |

So: run both scripts first (steps 1–2 below are fast and they tell you whether there is
anything left to look at). Then do the parts that need your eyes. **Do not skip the
scripts** — if either fails, the finding for OA-6 is that failure, and you should record it
rather than continue to a visual check that would be reading a broken product.

## 1. Before you start

You need all of these. If one is missing, stop and record that you could not run the gate;
a gate that was not performed is not a gate that passed.

- **A real desktop session with a visible display.** On Linux that means a real X11 or
  Wayland session you can see, not `xvfb` — a card nobody can read is not evidence of a
  card being readable. If you are on a headless box, this gate cannot be performed and
  that is the finding.
- **Node ≥ 22.12 on `PATH`.** Steps 3 and the rest call TypeScript source directly, which
  relies on Node's type stripping. `engines` says `>=22.12.0`; this repository was last
  run on 22.22.2.
- **The `opencode` binary on `PATH`, at 1.18.32, with a working model.** A session that
  cannot reach a model cannot reach a permission decision.
- **A repository built:** `npm run build` (below).
- **`jq` and `curl`**, for reading the hub's port and token.
- **`notify-send` available** (Linux) for the positive control in step 7. Without it you
  cannot distinguish "no notification appeared" from "this check cannot see notifications".
- **Permission to change your own opencode user configuration**, for step 4.

Record the platform, the display server, the opencode version and the OS version at the
top of your review. The first two decide which claims are even checkable on your machine.

## 2. Build, and prove the two automated halves

```bash
cd /path/to/agent-ping
npm ci
npm run build          # tsc -> dist/main, Vite -> dist/dashboard
npm test               # the whole suite; it must be green before you look at anything
```

`npm run build` is not optional. The entry point this gate exercises is
`dist/main/main/index.js`, and a card can only be painted by a built renderer. If
`dist/` is missing or stale, you would be reviewing a product that cannot ship. Note that
`npm run build` will **not** produce the plugin installer — see step 3.

Then run both instruments. **Give the surface script an `--out` of its own** — its default
is `docs/reviews/notification-surface-evidence.json`, which is the NS-4 record that
`docs/runbooks/notification-surface.md` and `tests/scripts/verify-notification-surface.test.ts`
both cite, and a re-run would silently overwrite it with your numbers:

```bash
node scripts/verify-opencode-live.mjs --out docs/reviews/opencode-live-evidence.json
node scripts/verify-notification-surface.mjs \
  --out docs/reviews/oa6-surface-evidence.json
```

Both print a machine-readable JSON summary to stdout and progress to stderr, and both exit
non-zero when an assertion fails. Read the summary. Two things to check specifically:

- Every assertion is `pass`. A single `fail` is your finding; record it and stop.
- Neither run reports success by having skipped. Both are written to refuse that: a
  missing binary, a missing built entry point or an absent hub is a failure with a remedy,
  never a skip. If either summary claims it had nothing to look for, that is a defect in
  the instrument, and it belongs in your review as one.

If both are green, the mechanical half of the chain holds and you are looking for the
things only a person can see.

## 3. Install the adapter globally

There **is** an `agent-ping` command now, and this section has been corrected: the
packaging tasks (`IO-1`–`IO-3`) have run, `package.json` names the `bin`, and
`npm run build` followed by `npm install -g .` puts a working command on `PATH`.

What is still true of the build is that `tsconfig.build.json` compiles `src/main`,
`src/hub`, `src/storage`, `src/domain`, `src/notify` and `src/cli` — but **not**
`src/plugin`, because the generated plugin is loaded by opencode as directly loadable
TypeScript. So `agent-ping install` generates the plugin from the package's own
sources rather than from a built artefact. If you would rather not install the command
to run this review, call the module from source instead; Node ≥ 22.12 loads `.ts`
directly, which is the same mechanism the product's own verifier relies on:

```bash
node --input-type=module -e "
import { installGlobalPlugin } from './src/plugin/install/global-plugin.ts'
import { readFileSync } from 'node:fs'
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const result = installGlobalPlugin({ version })
console.log(JSON.stringify({
  outcome: result.outcome,
  pluginFile: result.pluginFile,
  exportNames: result.observed?.exportNames ?? null,
  hookNames: result.observed?.hookNames ?? null,
}, null, 2))
"
```

That command is verified to print `outcome: "installed"`, a `pluginFile` under
`<your config home>/opencode/plugins/agent-ping.ts`, `exportNames: ["AGENT_PING_PLUGIN"]`
and `hookNames: ["event", "tool.execute.before", "tool.execute.after"]`.

Record the printed `pluginFile` path, then check the outcome against the full set of seven:

| Outcome | Meaning | A finding? |
| --- | --- | --- |
| `installed` | Nothing of ours was there; the file and its metadata are new | No |
| `reinstalled` | Our file, same version, different bytes; replaced in place | No — but note it in the review |
| `unchanged` | Our file, same version, same bytes; nothing written | No |
| `conflict` | A **different** version is installed, and was not touched | **Yes.** Report the version found |
| `blocked` | A file that is **not ours** is in the way, and was not touched | **Yes.** The message names it |
| `failed` | The files could not be written | **Yes.** Usually permissions or a read-only config home |
| `unverified` | The generated file **did not load**, so it was not published | **Yes, and the most important one.** Nothing was installed |

Two further requirements for this step:

- `hookNames` must contain `event`. OA-FR-02 is explicit that the adapter subscribes
  through the generic event hook *because the dedicated permission hook is documented as
  not firing*, so a plugin file without `event` cannot do this job at all. An empty
  `hookNames` means the file loaded but returned nothing.
- The path must be opencode's **global** plugin directory, resolved from your real config
  home because no path options were passed. That is what OA-FR-01 asks for: one globally
  installed file, no per-repository configuration.

To undo: the module exports `uninstallGlobalPlugin`, or delete the file it printed and run
`installGlobalPlugin` again. Leave it installed until you have finished every journey.

## 4. Make the harness reach a permission decision

In this build a `bash` call is **auto-allowed** unless the harness is told to ask, so a
naive session will sail past the exact moment you need to observe. Configure the harness
to ask, in your **user-level** opencode configuration — not in a repository:

```jsonc
// ~/.config/opencode/opencode.json
{ "permission": { "bash": "ask" } }
```

Two consequences to hold onto:

- This configures the *harness*, not agent-ping. agent-ping is given no configuration
  anywhere, and it must stay that way: OA-FR-01 and OA-FR-09 are precisely the claim that
  one globally installed plugin is the whole of the setup, with no per-repository file a
  developer could forget.
- If you already keep a user config, **merge** this key in rather than replacing the file.
  Note in your review that you changed it, and restore it afterwards.

## 5. Start the shipped build and read its port and token

```bash
export AGENT_PING_STATE_DIR="$HOME/.local/state/agent-ping-oa6"
mkdir -p "$AGENT_PING_STATE_DIR"

ELECTRON_DISABLE_SANDBOX=1 \
  node_modules/electron/dist/electron dist/main/main/index.js
```

Leave that running in its own terminal. Three details are load-bearing, and each is
recorded in `docs/reviews/notification-surface-evidence.json`:

- **`ELECTRON_DISABLE_SANDBOX=1` is not optional here.** Chromium decides about its
  sandbox before any JavaScript in this package runs, so on a per-user Linux install
  without it the binary dies with the setuid-sandbox FATAL. If the app fails to start and
  you skipped this, that is the cause.
- **`node_modules/electron/dist/electron`** is how the binary is resolved, so the evidence
  file records its resolved path rather than trusting `PATH`.
- The launch must be a real windowed session. A card that appears in a compositor you
  cannot see is not a card you have reviewed.

In a second terminal:

```bash
PORT=$(jq -r .port "$AGENT_PING_STATE_DIR/hub-runtime.json")
TOKEN=$(cat "$AGENT_PING_STATE_DIR/hub-write-token")
echo "hub on $PORT"
curl -sS "http://127.0.0.1:$PORT/api/health" | jq '.delivery'
```

`43117` is the *preferred* port and is not necessarily the bound one, so read the runtime
file rather than assuming.

Look at `.delivery` before you start and note it:

- `.delivery.status` must be `"ok"`, and `.delivery.wired` `true`. **`"not-wired"` means
  the shipped Electron bridge supplied no presenter**, so every visual claim below is
  unanswerable — record it and stop. (`not-wired` is the correct answer for a headless
  run, which is why a reviewer on a headless machine must not treat it as a product
  defect; it is also the correct answer for a desktop that refused the window.)
- Do not confuse it with the **top-level** `.status`, which is `"ok" | "degraded"` and
  tracks whether the *database* is readable. A hub can be `status: "ok"` while
  `delivery.status` is `not-wired`. Read both.

Keep this command handy — you will use it again after each journey:

```bash
curl -sS "http://127.0.0.1:$PORT/api/health" | jq '{status, delivery}'
```

The `.delivery` counters (`attempted`, `delivered`, `failed`, `timedOut`, `suppressed`,
`notWired`, `inFlight`) are an **independent count of what the product decided to show**.
That makes them a genuine cross-check on your own eyes: when you say you saw one card, you
can also say `delivered` went from 0 to 1. Record both, and where they disagree, trust the
counter and say so — that disagreement is a finding in its own right.

For your own reference, the state directory holds `hub-runtime.json` (the port) and
`hub-write-token` (the per-install write token). The token is needed only for the ack
route; `/api/ingest` takes no token.

## 6. The four journeys

Do these in order. Each names what to **look at** and what to **write down**. The wording
of the requirement is the acceptance criterion, so quote what you saw rather than
concluding "looks right".

### Journey A — a permission decision (the positive path)

1. Note the tray badge and the notification centre **before** you start. Both should be at
   zero/empty. Run `curl -sS "http://127.0.0.1:$PORT/api/health" | jq '.delivery'` and
   keep the numbers — you will compare them after each step.
2. In a scratch repository, run a real `opencode` session and ask it to run a shell
   command, e.g. *"Run the shell command: `echo oa6-permission-decision`"*.
3. The harness asks for permission. **Stop there and look at the screen.**

Record, each as its own line:

- **What appeared.** A card, top-right, inside the work area. Its shape, its wording, and
  whether you could read it **without moving focus** — the card must not steal focus, and
  the session must not be interrupted.
- **How many times.** Exactly one card for the block. Two is a finding: a card that
  re-arms on its own is the escalation loop ADR-004's 2026-09-26 amendment removed
  ("needs-you no longer repeats"; the badge and the history carry persistence instead).
- **The tray badge.** It should read 1.
- **The hub's own count.** `.delivery.delivered` should have gone up by exactly one, with
  `failed`, `timedOut` and `notWired` still 0. This is the number that makes your "I saw
  one card" checkable by someone else.
- **The OS notification centre.** Still empty. See step 7 for the control that makes this
  claim mean something.
- **Whether the window is still there after ~4 s.** A card that vanishes while the block
  is unresolved is a finding; persistence is the whole point.
- **The sound.** There must be none.

4. Now **answer the permission** in the harness.

Record:

- The card is **gone**, with no second card appearing. This is the specific defect OA-6
  exists to catch, so state it explicitly either way.
- **The hub's count did not go up again.** If `delivered` incremented a second time when
  you answered, the product re-armed — a finding even if you only *saw* one card, and one
  the counter catches where the eye might not.
- The tray badge returns to 0.
- The session continues normally — answering the permission is not supposed to disrupt it.

5. Let the session come to rest, and record the **finished** card: one card, which expires
   on its own after the fixed interval without you dismissing it. `delivered` increments
   once more.

### Journey B — a session that does real work

Run a session that does something with a real answer — ask it to read a file and explain
it, or to make a small edit. Record:

- Exactly **one finished card** when the turn completes, and no needs-you card unless the
  work genuinely asked for a decision.
- No card during the work itself. Long tool calls are `fyi`, and `fyi` presents **nothing**
  (README, loudness table). A card mid-work is a finding.

### Journey C — open, greet, close (the anti-noise path)

This is the one that matters most. ADR-004 and the whole design exist so that a session
which did nothing is **silent**.

1. Note the badge, the notification centre, and open the dashboard's history panel. Note
   `.delivery` too — this journey is the one where the counter is most informative,
   because **every** counter must stay exactly where it was.
2. Start a session, say hello, and close it. No tools, no work.
3. Wait ~10 s.

Record each as its own line, all of which must hold:

- **No card.** No window, no flash, nothing in the work area.
- **No window at all** while nothing is pending. The host window exists but must be
  invisible and empty when quiet; if a transparent window is sitting there taking focus or
  showing in the window list, that is a finding.
- **No badge change.**
- **No new history row** in the dashboard.
- **`.delivery` completely unmoved** — `attempted`, `delivered`, `suppressed` all
  unchanged from your "before" reading. This is the quantitative form of the anti-noise
  claim, and it is the reason to have taken the "before" reading: without it you have
  only your eyes, and "I didn't see anything" is a weak claim about a product whose entire
  purpose is to be silent when it should be.

### Journey D — the hub is absent (the breadcrumb path)

1. Stop the hub from step 5 (Ctrl-C in its terminal).
2. Run the same permission-producing session from Journey A again.

Record:

- The **session still completes.** The adapter is fire-and-forget with a bounded timeout;
  a missing hub must not hang or fail the session.
- **A visible breadcrumb in opencode's own interface**, naming the service, the session and
  the event type. Read it out of the harness's log/output, not from agent-ping — the claim
  is that the failure is visible where the developer already is.
- **No retry storm.** Bounded, and the session is not slowed to a crawl.
- **Nothing was stored.** The absence leaves no local trace claiming otherwise.

Then restart the hub before continuing.

## 7. Prove your notification-centre check can see a notification

This is the step people skip, and skipping it makes the most important claim in OA-6
meaningless. "No notification appeared" is also what you observe if the check is broken,
or if you looked at the wrong display, or if desktop notifications are off entirely.

**Before the journeys**, or immediately after, on Linux:

```bash
notify-send "agent-ping OA-6 control" "if you can read this, the check works"
```

Confirm it appears in your notification centre, then dismiss it. Record that you saw it.
Without this positive control, your "the OS notification centre showed nothing" line is an
unverified assumption, and you must write it as one.

The same applies in reverse on macOS (Notification Centre) and Windows (Action Center and
the toast surface). Neither platform has ever been run in this repository — see the table
in `docs/runbooks/notification-surface.md` — so if you review on one of them you are
establishing a **first** observation for that platform. Say so, and do not generalise it to
the others.

## 8. Check the plugin does not slow the session down

The claim is "does not **measurably** slow the session", so this is a comparison, not a
threshold. Record the numbers and their spread, and let the numbers be the verdict.

1. With the plugin installed, time the same prompt three times. Use something with a
   fixed, small cost so model variance does not swamp the effect — e.g. *"reply with the
   single word ok and run no tools"*, or the `echo` prompt.
2. Remove the plugin file (step 3 printed its path) and time the identical prompt three
   times.
3. Restore the plugin afterwards.

Record: the six durations, the two medians, and the within-group spread. If the medians
differ by less than the spread, the honest verdict is "no measurable difference", not
"no difference". If the installed group is consistently slower, that is a finding —
check the bounded timeout and the fire-and-forget send in the adapter.

Model latency dominates this measurement and you cannot remove it. Say so in the review
rather than presenting a small delta as a result.

## 9. Write the review, then attest — in that order

Copy the skeleton below into `docs/reviews/OA-6-console-review.md` and fill it in.

```markdown
# Human Review: a real opencode session caught end to end

- Reviewer: <name>
- Date: <ISO date>
- Platform: <OS + version>, display server <X11/Wayland/…>
- opencode: <version>
- Product build: <version>, <commit>
- Automated halves: verify-opencode-live.mjs <pass/fail, N assertions>,
  verify-notification-surface.mjs <pass/fail, N assertions>
- Evidence files: docs/reviews/opencode-live-evidence.json,
  docs/reviews/oa6-surface-evidence.json

## 1. Install (OA-FR-01)
Plugin file: <path>. Outcome: <one of installed|reinstalled|unchanged|conflict|blocked|failed|unverified>.
Loaded with exportNames <…> and hookNames <…>; `event` present: <yes/no>.
No per-repository configuration file was created: <yes/no>.
Harness config change made for step 4 (and whether it was restored): <…>.

## 2. A permission decision (OA-FR-02, acceptance 1)
`.delivery.status` / `.wired` before starting: <…>.
What appeared: <…>. How many times: <n>. Badge: <…>.
`.delivery.delivered` before / after the block: <n> / <n>. failed/timedOut/notWired: <…>.
Window still present after ~4 s: <yes/no>. Sound: <none/…>. Focus stolen: <no/…>.
After answering: card gone <yes/no>, second card <yes/no>,
`.delivery.delivered` again <yes — re-arm finding / no>, badge <…>, session continued <yes/no>.
If it did re-arm, quote that amendment and say the amendment is not holding.
Finished card: <n>, expired on its own: <yes/no>.

## 3. The operating system's notification centre (acceptance 2)
Positive control seen: <yes/no — if no, this claim is unverified>.
During all journeys: <n> notifications from agent-ping.

## 4. A session doing real work, and a session doing none (acceptance 3)
Real work: <n> finished cards, <n> cards during the work.
Greeting: cards <n>, windows <n>, badge change <…>, new history rows <n>,
`.delivery` before / after: <…> / <…> (every counter unmoved).

## 5. The hub absent (OA-FR-05, APX-CON-10, acceptance 4)
Session completed: <yes/no>. Breadcrumb, quoted verbatim: <…>.
Named the service / session / event type: <yes/no>.
Retries: <n>. Session slowdown: <…>. Anything stored locally: <…>.

## 6. Overhead (OA-FR-09)
With plugin: <3 durations>. Without: <3 durations>. Medians <…> vs <…>, spread <…>.
Verdict: <no measurable difference / measurable slowdown, with numbers>.

## 7. Events the adapter failed to report
<Every event you expected and did not see. "None observed" is an acceptable answer
only if you can say which events you were watching for.>

## 8. Verdict
<approved / not approved, and the one-sentence reason.>
```

### Fill it in completely, then attest

`approve-task` hashes your review file, and `humanTaskApproved` **re-hashes it on every
check**. So **any edit after you attest silently invalidates the gate**, and the next
`replay` or `run` refuses with `incomplete dependencies OA-6`. This has already cost this
project one re-attestation on `CP-3`. Write the file once, completely, then attest.

Attestation is yours alone — an agent must not run it:

```bash
cd .opencode/skills/forge-workflow-engine
npm run workflow-engine -- approve-task OA-6 \
  --repo /path/to/agent-ping \
  --reviewer "Your Name" \
  --evidence docs/reviews/OA-6-console-review.md \
  --confirm-human-review
```

The engine writes the machine gate to `docs/reviews/opencode-adapter.json` and hashes your
review into it. **You do not edit that file.** If attestation reports a digest mismatch,
your review file changed after the fact — restore it rather than re-running to force it
through.

## 10. The traps, collected

- **Looking for an installer in `dist/`.** There isn't one. `tsconfig.build.json` does not
  compile `src/plugin`, because the generated plugin is loaded by opencode as TypeScript.
  If you import from `dist/main/plugin/...` the path will not exist. Use the source
  command in step 3.
- **`agent-ping` may not be on your `PATH` yet.** The `bin` entry has landed (`IO-1` has
  run), so `npm run build && npm install -g .` gives you the command; if you have not
  installed it, run the built entry point directly:
  `node_modules/electron/dist/electron dist/main/main/index.js`.
- **Running the surface script without `--out`.** Its default overwrites
  `docs/reviews/notification-surface-evidence.json`, which is NS-4's record and which the
  runbook and a test both cite. Pass `--out docs/reviews/oa6-surface-evidence.json`.
- **Forgetting `ELECTRON_DISABLE_SANDBOX=1`** looks like a product crash and is not one.
- **A `bash` call is auto-allowed** unless step 4 configures the harness, so Journey A
  silently becomes Journey B and you conclude the adapter is broken.
- **Reading `.status` instead of `.delivery.status`.** The top-level `status` tracks the
  database. A hub can be `status: "ok"` and `delivery.status: "not-wired"`, which looks
  healthy and means no card can appear at all.
- **Reading the badge but not the screen**, or the screen but not the badge. The card is
  the product; the badge is the durable fallback. Both are claims.
- **Not taking a "before" reading of `.delivery`.** Without it, Journey C's silence is
  only "I saw nothing", which is the weakest possible evidence for the claim this product
  exists to make.
- **A missing positive control** (step 7) turns the notification-centre claim into an
  assumption. This is the single most common way this gate produces a worthless "pass".
- **Reviewing on macOS or Windows.** No run in this repository has ever touched either
  platform. A first observation is worth having and is not a generalisation.
- **A card you could not read.** The scripts count pixels; nobody has confirmed a human can
  read the words. If it is illegible at your resolution and scaling, that is a finding, and
  it is the class of finding only this gate can produce.
- **Attesting, then tidying the review.** See step 9. It invalidates the gate silently.
