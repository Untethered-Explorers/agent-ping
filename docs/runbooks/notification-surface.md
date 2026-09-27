# Runbook: the notification surface — a card agent-ping draws itself

> Replaces `docs/runbooks/notify-platforms.md`, which described a delivery path that no
> longer exists. That runbook and the three platform notifiers behind it were deleted by
> NT-8. This file describes the only delivery path this product has, and it keeps the
> property the old one had: **it says what has been observed and what has not.**

## 0. The verification state, in one table, stated plainly

| Claim | State | Where it is proven |
| --- | --- | --- |
| A card is a DOM document with a role, an accessible name, real text and icon-plus-word urgency | **implemented, unit-tested** | `tests/notify/surface-card-view.test.ts` (jsdom, real element tree) |
| A needs-you card is shown once and is not re-armed; a finished card expires on one fixed interval | **implemented, unit-tested** | `tests/notify/surface-lifetime.test.ts` (the table is data only, so nothing *can* re-arm) |
| The class table is one table, total, with `fyi` refused | **implemented, unit-tested** | `tests/notify/policy.test.ts` |
| The delivery path starts no process, spawns nothing, names no platform notification mechanism | **implemented, unit-tested** | `tests/notify/policy.test.ts` (source sweep over every module under `src/notify`) and `tests/notify/surface-card.test.ts` |
| A refused class is recorded as a suppression and is never counted as a delivery | **implemented, unit-tested** | `tests/notify/policy.test.ts`, through a real ingest over a real socket |
| A surface that will not show a card is a failure with a reason, visible in `doctor` | **implemented, unit-tested** | `tests/notify/policy.test.ts` (`GET /api/health`, the ingest drop ledger) |
| The window's option set, the placement, the load, the click-through direction, the destroy | **implemented, unit-tested** against a structural Electron stub | `tests/notify/surface-host.test.ts`, `tests/notify/surface-position.test.ts` |
| The same window primitives, driven on a real Electron process | **observed once by hand** on Ubuntu 24.04 / X11 / Electron 44.4.5 | `docs/research/electron-surface-preflight.json`, summarised in `src/notify/surface/electron-host.ts` |
| **A card appearing on a real desktop, inside the work area, painted, and persisting** | **LIVE-VERIFIED on Linux**, through the run-time harness described in section 8.2, 9 of 9 needs-you assertions holding | `scripts/verify-notification-surface.mjs`, evidence in `docs/reviews/notification-surface-evidence.json`, journey `needs-you`: a real `320x96+1584+48` window, `IsViewable`, inside the advertised work area, 772 distinct painted values in its own drawable, still there 4.0 s later, gone 404 ms after the acknowledgement |
| **A finished card leaving the screen on its own** | **LIVE-VERIFIED on Linux** | same evidence file, journey `finished`: the window appeared 38 ms after the event and the card view reported the end `expired` with nothing dismissing it |
| A greeting-and-close session produces no window and no card | **LIVE-VERIFIED on Linux** | same evidence file, journey `greeting-and-close`: zero events, zero windows, pending set unchanged, no viewable card window while nothing was pending |
| The operating system's notification centre received nothing from agent-ping, and the instrument was capable of seeing a notification | **observed on a real desktop** | same evidence file, `notificationCentre`: 0 calls during the journeys, 2 from a deliberate positive control through the same monitor. Recorded as an observation, never asserted |
| The Chromium launch policy is load-bearing | **observed on a real Electron process** | same evidence file, `machine.launchPolicy`: with `ELECTRON_DISABLE_SANDBOX=1` the binary starts; without it, the setuid-sandbox FATAL (PRD 16 Open Question 13) |
| **The product *as shipped* can show a card today** | **NO, and that is the shipped state, not a gap in the evidence** | same evidence file, `shippedPosture`: the real built entry point started, answered `GET /card.html` with **404**, and reported `delivery.status: "not-wired"` with `toast_deliveries: 0` after a real block. Section 4 items 1 and 2 |
| A card on **macOS** | **NOT LIVE-VERIFIED, AND NOT CLAIMED** | one implementation, but only Linux was ever run. No statement in this repository is evidence about macOS |
| A card on **Windows** | **NOT LIVE-VERIFIED, AND NOT CLAIMED** | as above |
| The shipped build serving a card document and showing a card without the run's harness | **NOT LIVE-VERIFIED — it does not happen**, and it is a recorded fact rather than a missing observation | `shippedPosture` in the evidence file: `GET /card.html` → 404, `delivery.status: "not-wired"`, no viewable card window while that hub served |

Nothing in this file is a claim that a human read a word off a card. The pixel capture counts
distinct values in the window's own drawable, which separates a painted card from a blank
rectangle and reads no text; legibility stays a manual, per-platform step (section 8.4). And
nothing in it claims the shipped build can produce that card on its own: the journeys in
section 8 are driven through a run-time harness that supplies exactly three seams the product
has not built, and every one of them is named, owned and recorded as a required product change.

## 1. What the surface is

A **card** is a document this product renders in a window it creates and owns:

- one `BrowserWindow` per hub, `frameless`, `transparent`, `alwaysOnTop`,
  `skipTaskbar`, `focusable: false`, `hasShadow: false`, created with `show: false`
  so it draws nothing and occupies no screen space until a card exists (NT-FR-10)
- shown with `showInactive()` — never `show()` — so a card cannot take the keystroke
  someone is typing (NT-FR-04)
- placed by a pure function of the display's **work area**, never its `bounds`: a
  taskbar, a dock or a top panel lives in the gap between the two, and this product's
  authoring machine reported a 32 px top inset
- click-through until the pointer reaches it, and never a second window: showing a
  card while one is showing re-places it
- destroyed first in the ordered shutdown, before the tray and before the listener
  closes, so a card cannot outlive the hub that could resolve its deep link
- loaded from `/card.html` **on the hub's own loopback origin**, so the dashboard's
  strict content-security policy governs the card and no new origin exists

**No operating system notification mechanism is involved on any platform.** There is no
notification service, no notification centre, no focus-assist integration, no permission
prompt and no spawned command. That is a decision, not an accident — see
[ADR-012](../adr/ADR-012-surface-is-rendered-by-agent-ping.md) — and
`tests/notify/policy.test.ts` enforces it by reading every module under `src/notify` with
its prose stripped.

### The three classes, and what a card is allowed to say

| Class | Card? | Lifetime | Urgency | The one sentence |
| --- | --- | --- | --- | --- |
| `needs-you` | yes | `until-resolved` | `critical` | "A session is blocked and needs a decision from you." |
| `finished` | yes | `expires` (5 000 ms) | `normal` | "A session finished after working." |
| `fyi` | **no** | `never-rendered` | — | none; it stays in the dashboard |

A card is two lines: the repository short name and one sentence. No count, no path, no
session identifier, no harness name, no conversation content (APX-FR-01). The pending
count is deliberately *not* printed on a card: the tray badge and the dashboard carry it,
and a number on a card would be a second place a count exists that is wrong the moment a
second block arrives.

## 2. Driving a card by hand, on each platform

The manual check is now a **window-and-document** check rather than a tool invocation,
because there is no tool to invoke. The same four steps apply on all three platforms;
only the desktop's own compositor behaviour differs.

### Linux (GNOME, KDE, X11, Wayland)

```bash
# 1. The launch policy a per-user install needs. Chromium decides about its sandbox
#    before any JavaScript in this package runs, so this has to be on the command line
#    (or on the process's own command line, for a service that starts it).
npm install -g agent-ping
ELECTRON_DISABLE_SANDBOX=1 agent-ping

# 2. Read the live port. 43117 is the preferred one and is not necessarily the bound
#    one, so the runtime file is the only place to read it from.
PORT=$(jq -r .port "${XDG_STATE_HOME:-$HOME/.local/state}/agent-ping/hub-runtime.json")

# 3. Drive one block through the real pipeline, with the per-install write token.
TOKEN=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/agent-ping/hub-write-token")
curl -sS -X POST "http://127.0.0.1:$PORT/api/ingest" \
  -H 'content-type: application/json' \
  -H "x-agent-ping-token: $TOKEN" \
  -d '{"harness":"opencode","eventName":"permission.asked","sessionId":"ses_manual_01",
       "repoFullPath":"/home/you/Projects/agent-ping","transitionId":"manual-1",
       "occurredAt":"2026-09-27T09:00:00.000Z"}'

# 4. Read what the hub recorded about that attempt. Today this is the honest answer:
#    `not-wired`, because the card document is not in the build (see section 4).
curl -sS "http://127.0.0.1:$PORT/api/health" | jq '.delivery'
```

Look for: a top-right rectangle inside the work area, no focus change, no sound, nothing
in the notification centre, and the tray badge moving to 1.

### macOS

```bash
npm install -g agent-ping
ELECTRON_DISABLE_SANDBOX=1 agent-ping
# then steps 2 to 4 above, with the state directory at
#   ${XDG_STATE_HOME:-$HOME/.local/state}/agent-ping
```

Look for the same four things, and additionally confirm that **Notification Centre stays
empty** — that is the platform-specific claim this product now makes, and it is only
checkable here. Nothing in this repository asserts it has been checked.

### Windows

```powershell
npm install -g agent-ping
$env:ELECTRON_DISABLE_SANDBOX = '1'
agent-ping
# then the same two requests, with the token from
#   $env:LOCALAPPDATA\agent-ping\token
```

Look for the same four things, including that the Windows Action Center and the toast
surface stay empty.

### What "by hand" means when nothing is wired yet

If `GET /api/health` reports `not-wired`, then **that is the correct result, not a failure
of the check** — and on the shipped build today that is what you will get, because there is
no card renderer to wire (section 4, items 1 and 2, both re-confirmed on the running system
by the script in section 8). Section 4 explains why. To see a real card on a real display
today, run that script rather than a hand-rolled command: it supplies the three missing
seams itself and tells you, in the evidence file, exactly which three things it supplied.
Do not work around it by calling any notification tool by hand: the whole point of ADR-012
is that there is no such call in this product, and a manual check that reached for one
would be checking the wrong thing.

## 3. What the automated tests here cover, and what they deliberately do not

Covered, with no display and no Electron binary in the process:

- the class table, the plan, the deep link and the six fields of a request
- the card model and the card view (jsdom), the lifetime table, the placement function
- the surface notifier over this product's own `NotificationSurfaceHost` interface: one
  card per delivered class, none for a refused one, a failure carrying the host's own
  reason, the window taken back down when a card cannot be rendered
- the composition root, end to end over a real log and a real socket: the three classes,
  the refused-class counter, the failure on health, the restart replay
- the absence of every withdrawn mechanism, asserted from source over all of `src/notify`
- the verification script's own judgement and every parser, with injected results and
  captured tool output, in `tests/scripts/verify-notification-surface.test.ts` (120 tests,
  including a run where nothing executed and a run where the display or the Electron
  binary was absent)

Not covered by those, and covered only by the live run in section 8:

- whether a compositor draws a transparent frameless always-on-top window correctly
- whether a card is legible at the real size, and whether the real font metrics fit — the
  live run measures *painted pixels*, never a word, and the stylesheet that drew the card
  in that run is the harness's own, so legibility stays manual even on Linux
- whether `showInactive` is unfocused on every window manager — the X server exposes no
  focus reading for a card window on this desktop
- whether a pointer can reach the card, and whether click-through and its release both work
- whether the tray icon mounts, and what number it carries: a StatusNotifierItem is not an X
  window, so neither is observable from outside the process
- whether the card document loads at all in the built artefacts — **it does not**
- anything at all about macOS or Windows

## 4. What is missing, in the order it blocks something

Every item below was confirmed on the running system by `scripts/verify-notification-surface.mjs`
(section 8) rather than inferred from the source.

1. **The card document.** `src/dashboard/card.html` does not exist, and the dashboard's
   Vite build has one entry, so `GET /card.html` currently 404s. The card view exists
   (`src/notify/surface/card-view.ts`) and is unit-tested; the page that mounts it does
   not. Owner: dashboard-engineer, because the Vite root and the entry list are its file.
   **Observed:** the live run asked the running hub for `/card.html` and got 404.
2. **The main-to-renderer channel.** The main process has a window and a card model, and
   the renderer runs with `contextIsolation: true`, `nodeIntegration: false` and
   `sandbox: true` — so it has no `require` and no `ipcRenderer`, confirmed on real
   Electron. Something has to carry the model from the first to the second. It has not
   been chosen, and choosing it is a decision about the host's Electron surface, not a
   detail. **Observed:** because nothing supplies a `DesktopBridge.renderCard`, the
   delivery policy is never wired and no delivery is even attempted.
3. **The consequence, stated rather than hidden.** Until both exist, the composition root
   finds no renderer, reports the run as `not-wired`, and **records no deliveries as
   made**. That is the honest answer and it is the behaviour `tests/notify/policy.test.ts`
   asserts. A transparent rectangle with nothing in it is not a card, and reporting one as
   a delivery would be the exact lie APX-FR-02 forbids. **Observed on the shipped build,
   before the harness started and in a state directory of its own:** `GET /api/health`
   reported `delivery.status: "not-wired"` and `wired: false`, `GET /card.html` answered
   404, `toast_deliveries` stayed at 0 through a real `permission.asked`, the pending set
   still went 0 → 1, and the display held **no viewable card window at all** while the hub
   that owns one was serving. That is the `shippedPosture` section of the evidence file,
   and it is a record rather than an assertion on purpose: a build that grows either piece
   tomorrow would make a passing assertion here a false alarm, and this runbook would be
   the stale artefact.
4. **Removing a card when the block is acknowledged.** The lifetime table names
   `resolved` and `acknowledged` as the two ends of a needs-you card, and the card view
   removes on either. Nothing in the delivery path is *told* about an acknowledgement
   yet: the ack route has no notifier hook, and adding one is a hub change rather than a
   delivery one. On the shipped entry point a needs-you card would therefore leave the
   screen only when its window was destroyed at shutdown, which is correct at shutdown and
   not yet correct in the middle of a run. Owner: hub-engineer, as a handoff.
   **Observed, and observed through the harness:** the run watched the real pending set,
   issued a real `POST /api/ack/:eventId` (status 200), and saw the card view's own
   `remove('acknowledged')` take the card off the screen 404 ms later — the card view
   reported the end `acknowledged`, and the badge's own number fell 1 → 0. What is
   observed is that the *product's* card view and the *product's* lifetime cell do the
   right thing the moment anything tells them; what is missing is the telling, and the
   harness's `suppliedByThisRun` field says so on the record.
5. **Nothing takes the window down when a card ends.** The same missing edge, one step on:
   the card view's end never reaches the host, so `host.hide()` never runs and a mapped
   transparent window outlives its card. NT-FR-10 promises the surface occupies no screen
   space and draws nothing when nothing is showing. **Observed:** at the moment the
   finished card expired, the host window was still mapped and visible and its own
   drawable was empty. An empty mapped rectangle is not a card, so the card itself had
   gone — but the window outliving it is a real gap. Owner: notification-engineer with
   hub-engineer.
6. **The `not-wired` reason has nowhere to go.** `startHub` defaults `onDiagnostic` to a
   no-op and `startElectronMain` passes none, so the diagnostic the composition root emits
   when it finds no renderer is written nowhere at all. **Observed:** the run captured the
   shipped entry point's stdout and stderr across its whole life and found **0 lines the
   product wrote** (4 more came from the Electron runtime tearing itself down — zygote,
   network service, GPU — and the script separates the two populations by the shape of the
   line rather than counting Chromium's noise as a diagnostic). The reason a run cannot
   show a card is exactly the thing an operator needs told. Owner: hub-engineer.

## 5. The launch policy, and its cost

`CHROMIUM_LAUNCH_POLICY` in `src/notify/surface/electron-host.ts` decides, in one
asserted place, that an unprivileged per-user install launches Chromium with
`--no-sandbox`. The reason is measured, not assumed:

- the npm-installed `chrome-sandbox` helper is owned by the installing user with mode
  0755, so it is not setuid-root, and Chromium aborts with a `FATAL` and dies of
  `SIGTRAP` rather than degrading
- with the helper removed, the unprivileged user-namespace fallback is blocked by
  Ubuntu 24.04's AppArmor profile, and Chromium aborts with `No usable sandbox!`

The switch is delivered **two ways** because Chromium reads its command line before any
JavaScript in this package runs: on the process command line (`CHROMIUM_LAUNCH_FLAGS`),
and as `ELECTRON_DISABLE_SANDBOX=1` (`CHROMIUM_LAUNCH_ENVIRONMENT`). `applyChromiumLaunchPolicy`
still appends the switch to `app.commandLine` for the children a running process starts,
and `launchPolicyApplied` reports the gap as a readable sentence rather than letting an
operator hold a `SIGTRAP` with no message.

**Both halves were re-measured by the live run, on the real binary, and the measurement is
in the evidence file.** With `ELECTRON_DISABLE_SANDBOX=1` the binary starts and reports
`v44.4.5`; with the variable removed it aborts with
`FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166] The SUID sandbox helper binary
was found, but is not configured correctly`. That is PRD 16 Open Question 13 confirmed
rather than remembered, and it is why the script sets the environment form for the hub it
launches: a run that omitted it would not reach a single assertion.

**`webPreferences.sandbox: true` is not disabled by any of this.** It is a renderer-level
setting, enforced by Chromium's renderer isolation, and it was checked on the real
Electron: with the process sandbox off, a card document loaded over 127.0.0.1 still had
neither `process` nor `require` in the renderer. The two are different layers.

**The cost, stated:** with the process sandbox disabled, a renderer is not confined by
the kernel, so a renderer-level escape would be easier. The renderer is this product's
own card document, loaded from 127.0.0.1, with `contextIsolation` on, `nodeIntegration`
off, no remote content and no third-party code — and the input to it is a repository
short name and one sentence from a closed table, never content. Re-deciding this for a
privileged install is a change to that object, not to a call site.

## 6. If something is wrong

| Symptom | What it means | Where to look |
| --- | --- | --- |
| `not-wired`, reason `no-surface` | a headless run: no desktop bridge, so no window. A supported run, not a fault | the diagnostic at start-up |
| `not-wired`, reason `no-card-renderer` | a window exists and nothing can be put in it. Today's shipped state (section 4) | `GET /api/health`, and section 8's evidence file |
| `not-wired`, reason `window-refused` | the desktop would not give the window. The hub keeps serving; every delivery is `not-wired` | `CHROMIUM_LAUNCH_POLICY` first, then the compositor |
| `not-wired` and **nothing in the log or on stderr** | the reason is real but has no destination: the Electron entry point passes no `onDiagnostic` (section 4, item 6) | the child process's stderr; this is a product gap, not a silent success |
| `failed` with `document-unavailable` | `GET /card.html` did not serve a document | the dashboard build, and `dashboardRoot` |
| `failed` with `card-not-rendered` | the window came up and the card did not go in; the window was taken back down | the renderer channel (section 4) |
| a `SIGTRAP` at start-up with no message | the launch policy did not reach the process | `agent-ping` writes the gap to stderr; see section 5 |
| the tray badge is right and no card appeared | the badge is the durable signal and does not depend on the card (NT-FR-05, PRD 16 Open Question 3) | this is expected, not a fault |

`agent-ping doctor` reports the delivery section of health: counts, the last attempt, the
last failure with its reason, and whether a notifier is wired at all. A failure is
recorded, counted and reported there — never only in a log line (APX-FR-02, ADR-010).

## 7. A handoff, recorded rather than worked around

Two facts about the delivery path are this product's now and belong to the hub owner, so
they are written down instead of being fixed by a second writer:

1. **`IngestService.stats().deliveries.delivered` counts a resolved port**, and a refused
   class now resolves rather than throws — so a hub with a surface wired counts an `fyi`
   in that number. The number has no reader in `src/` today, and the *authority* on what a
   delivery was is the policy's own ledger and counts, which are correct. Giving the
   pipeline's port a third answer (so a refusal is neither delivered nor failed) is a
   change to `src/hub/ingest-service.ts`'s contract, which is hub-engineer's.
2. **Nothing tells the card surface that a block was acknowledged.** The ack route has no
   notifier hook, so a needs-you card currently leaves the screen when its window is
   destroyed — correct at shutdown, not yet correct mid-run. See section 4, items 4 and 5.

## 8. What the live run actually observed

This is NT-9's section, and it exists because everything above it is either a claim about
code or a claim about a desktop nobody re-checked. The script is
`scripts/verify-notification-surface.mjs`; the evidence it wrote on this machine is
`docs/reviews/notification-surface-evidence.json`; the judgement, every parser and every
harness source are unit-tested against injected values in
`tests/scripts/verify-notification-surface.test.ts` (120 tests).

```bash
npm run build                                           # dist/main and dist/dashboard
cp src/storage/schema.sql dist/main/storage/schema.sql   # see the note below
node scripts/verify-notification-surface.mjs            # ~20 s; JSON summary on stdout
```

The `cp` is a real gap, not a habit: the tsc build emits JavaScript only, so a hub started
from `dist/` cannot find its schema and refuses to open its log. The script treats the
missing file as a **missing dependency with a non-zero exit and that remedy**, rather than
starting a hub that would fail later for a less legible reason. The permanent fix is a copy
step in `scripts/build.mjs` (tooling-engineer, DP-1) plus the package `files` allowlist
(packaging-engineer, IO-1).

Exit codes: `0` only when every assertion ran and every one matched; `1` on a failed
assertion or an absent dependency; `2` on a bad command line; `3` on a missing dependency,
in which case **no evidence file is written at all** — a report that says "nothing was
there" is indistinguishable from a report that says "nothing was looked for".

### 8.1 The run, and the verdict

On the authoring machine — Ubuntu 24.04, X11 `:1` under Mutter, Electron 44.4.5, Node
22.22.2, work area `{x: 0, y: 32, width: 1920, height: 1048}` — the script:

1. proved its own observer could see a window at all,
2. started **the real built entry point, `dist/main/main/index.js`**, and recorded what the
   product as shipped does on this display,
3. started a second real Electron main process through a run-time harness (8.2) that
   completes the three seams the product has not built, and drove three journeys over the
   real loopback socket,
4. counted what the session's notification bus carried while it did.

**Verdict: pass. 19 of 19 assertions executed, 19 matched, exit 0**, in 19 725 ms wall
clock. Every row of the inventory below is a row the summary prints with its expected and
observed value, so the verdict is 19 named comparisons and not a score.

| Journey | Assertion | Expected | Observed |
| --- | --- | --- | --- |
| observer | found and read a control window it did not create | `found-and-painted` | `found-and-painted` |
| hub | a built Electron main process started the real hub on loopback | `serving` | `serving` |
| hub | published its own runtime file rather than being reached on an assumed port | `runtime-file-read` | `runtime-file-read` |
| needs-you | a real event created exactly one pending item | `1` | `1` |
| needs-you | a card window appeared inside the display work area | `inside-the-work-area` | `inside-the-work-area` |
| needs-you | the card window held painted content | `painted` | `painted` |
| needs-you | the product's own card view rendered into the document that window loaded | `rendered` | `rendered` |
| needs-you | the card was still on screen after a wait | `still-present` | `still-present` |
| needs-you | the delivery outcome for the block was recorded as delivered | `delivered` | `delivered` |
| needs-you | the hub served the card document the window loads | `200` | `200` |
| needs-you | the badge number fell when the item was acknowledged | `0` | `0` |
| needs-you | the card was gone after the acknowledgement | `gone` | `gone` |
| finished | a worked idle transition created exactly one finished event | `1` | `1` |
| finished | a card window appeared for the finished event | `inside-the-work-area` | `inside-the-work-area` |
| finished | the finished card expired with nothing dismissing it | `expired` | `expired` |
| greeting-and-close | created no event | `0` | `0` |
| greeting-and-close | left the pending set unchanged | `0` | `0` |
| greeting-and-close | created no window | `none` | `none` |
| greeting-and-close | no card window was viewable while nothing was pending | `none` | `none` |

### 8.2 What the run had to supply, and what it did not

The product as shipped **cannot draw a card** (section 4, items 1 and 2). NT-9 was told to
record that rather than change product code, and to prove the card on the running system.
Both are only satisfiable if the run supplies the open seams itself — and then says so on
the record, which is what the `harness` section of the evidence file is for. Three seams,
each one the product's own documented injection point:

| Seam | What the product has | What the run supplied, and why that is not a rewrite |
| --- | --- | --- |
| the card document | `src/dashboard/card.html` does not exist; `GET /card.html` is a 404 | a run-time document, stylesheet and module entry in a copy of the built dashboard. The card those two files show is mounted by the **product's own compiled card view** — `card-view.js`, `card.js` and `lifetime.js` copied byte for byte out of `dist/main/notify/surface/`, and the evidence file records `identicalToTheBuild: true` for each |
| the main-to-renderer channel | no `DesktopBridge.renderCard`, and the renderer has `contextIsolation`, no `nodeIntegration`, `sandbox: true` and no preload | `webContents.executeJavaScript` into the product's own window. The renderer options were **not** touched: they came from the product's own frozen `SURFACE_WINDOW_OPTIONS`. The channel shape is recorded as a required product change with an owner, not adopted as the answer — choosing it is a decision about NT-6's Electron surface |
| the acknowledgement signal | `POST /api/ack/:eventId` has no notifier hook, and nothing takes the window down when a card ends | the hub's own pending accessor watched by the run, which then calls the card view's own `remove('acknowledged')` and the host's own `hide()` — **only after** the product's card view has reported an end the product's lifetime cell names |

Everything else was the product's, unmodified and unstubbed: the real built `startHub`,
the real loopback server and every real route, the real ingest classifier, the real class
policy, the real card model, the real surface host with the real window options, the real
placement arithmetic, the real lifetime table, the real card view, and the real delivery
policy with its own ledger. The evidence file's `harness.manifest` names every file the run
wrote and who wrote it.

### 8.3 What was observed, positive and negative

**Positive — the needs-you journey.** One real `POST /api/ingest` with `permission.asked`
returned `pending-created`; `GET /api/pending` went 0 → 1. **234 ms** later the display held
a card-sized window at `320x96+1584+48`, `IsViewable` (its X id differs per run and
is recorded in the evidence file rather than quoted here), and
`{x: 0, y: 32, width: 1920, height: 1048}` is the work area the display server itself
advertised through `_NET_WORKAREA` — the check is against the desktop's own answer, not
against the arithmetic under test. Its own drawable held **772 distinct values across
30 720 pixels** with no inline style and 5 elements carrying `role=status`,
`aria-live=assertive`, an `aria-label` and the icon-plus-word urgency. **4 001 ms later it
was still there**: one card per block, not re-armed, no repeat timer (NT-FR-08). A real
`POST /api/ack/:eventId` returned **200**; the badge's own accessor went **1 → 0** and the
card was gone **404 ms** later, with the product's card view reporting the end
`acknowledged` — the end its own lifetime cell names. `GET /api/metrics` reported
`toast_deliveries: 2` at the end of the run: one per delivered card, and none for anything
that was not one.

**Positive — the finished journey.** A worked idle transition created exactly one
`finished` event, a card window appeared **38 ms** later, and the card left the screen on
the product's own fixed 5 000 ms interval with **nothing dismissing it**: the card view
reported the end `expired`. The run waited 8 003 ms and then read the display.

**Positive, and the one that matters most — the anti-noise proof.** A session that opened,
greeted and closed produced **nothing at all**: the greeting was `no-event` with the reason
`below-threshold`, the closing was `no-event` with `idle-after-nothing`, and the journey
recorded **0 events, 0 windows created, pending 0 → 0**, and no viewable card window on the
whole desktop afterwards. The host window exists while it draws nothing, and the run
distinguishes those two facts rather than conflating them: at that moment the hub still
owned its 320×96 window and the X server reported it `IsUnMapped`, which is the NT-FR-10
distinction between *the host window existing* and *the surface being visible*
(APX-CON-06, ADR-004).

**Positive — the observer proved itself before it was trusted.** A `xmessage` control window
was opened, found by the same `xwininfo -root -tree` enumeration the journeys use, and read
by the same `xwd` capture: `IsViewable`, 1 164 distinct values across 87 688 pixels. That
control is one of the 19 assertions. Without it, "no card appeared" would be
indistinguishable from "the observer is broken", and a green run would be unfalsifiable.

**Positive — the shipped build's own answer, recorded before the harness started, in a
state directory of its own so its block could never be replayed into the journeys.** The
real `dist/main/main/index.js` came up, published its runtime file, served every read
route, answered `GET /card.html` with **404**, reported `delivery.status: "not-wired"`,
`wired: false`, `toast_deliveries: 0` after a real block whose pending count still went to
1 — and the display held **no viewable card window at all**. It is a record and not an
assertion, on purpose: a build that grows either missing piece tomorrow would make a
passing assertion here a false alarm, and this runbook would be the stale artefact.

**Positive — the Chromium launch policy, measured both ways on the real binary.** With
`ELECTRON_DISABLE_SANDBOX=1` the binary starts and reports `v44.4.5`; with the variable
removed it dies of `SIGTRAP` and `FATAL: … setuid_sandbox_host.cc:166] The SUID sandbox
helper binary was found, but is not configured correctly`. That is PRD 16 Open Question 13
confirmed rather than remembered.

**Negative, and the point of the whole feature — what the operating system's notification
centre received: nothing.** `dbus-monitor` watched the session bus filtered to
`org.freedesktop.Notifications` for the entire run: **0 `Notify` calls** while two cards
were delivered. Then one deliberate `notify-send` was issued as a positive control and the
same monitor counted **2** (one from `notify-send`, one relayed by GNOME Shell), so the
zero is a reading and not a broken instrument. This is recorded in the evidence file under
`notificationCentre` with `"asserted": false` and a note saying why: nothing in this product
is permitted to raise a platform notification, and `tests/notify/policy.test.ts` enforces
that from source. The D-Bus stream itself is never stored, because it carries notification
text (APX-FR-01). `notify-send` appears in this repository only as that control, after the
journeys — and it is why a human checking a card by hand must not reach for one either.

**Negative — the product's own diagnostic is written nowhere.** The shipped entry point's
stdout and stderr were captured across its whole life: **0 lines the product wrote**, and 10
from the Electron runtime tearing itself down (zygote, network service, GPU — the count varies
between runs and the number above is this run's). The script
separates the two populations by the shape of the line and reports both counts, because
"found 4 diagnostic lines" beside "the reason is never reported anywhere" would be a
contradiction a reader has to resolve. See section 4, item 6.

### 8.4 Timings, and what the run still could not see

Timings from this run, all recorded in `evidence.timings`: hub ready **61 ms** against a
45 s deadline; observer control **324 ms**; needs-you journey **4 944 ms** total (234 ms to
the window, 4 001 ms settle, 404 ms from acknowledgement to gone); finished journey
**8 112 ms** total (38 ms to the window, 8 003 ms waited against a 5 000 ms interval);
greeting journey **1 619 ms**; whole run **19 725 ms**.

These are timings of *this machine's* Electron and compositor, not a budget, and nothing in
this file claims they hold elsewhere.

- **Whether the card is legible.** The capture counts distinct values in the window's own
  drawable. That separates a painted card from a blank rectangle and reads no word — and the
  stylesheet that drew the card in this run is the run's own, because the product has none.
  Legibility, real font metrics and contrast stay a manual, per-platform step with the
  product's own stylesheet.
- **Whether `showInactive` left the keyboard focus alone.** The X server exposes no focus
  reading for a card window on this desktop, so the run observed visibility, not focus
  (NT-FR-04).
- **Whether a pointer can reach the card**, and whether click-through and its release both
  work. No pointer was moved; both are asserted against this product's own
  `NotificationSurfaceHost` interface in `tests/notify/surface-host.test.ts`.
- **Whether the tray icon mounted, and what number it carries.** An Electron Tray is a
  StatusNotifierItem and not an X window, so neither is observable from outside the process.
  The badge's number was read from `GET /api/pending`, which is the accessor the badge itself
  reads — an honest substitute, and the same one `tests/hub/tray.test.ts` asserts against.
- **That the product as shipped can show a card.** It cannot, and `shippedPosture` is the
  record of that rather than a footnote. Every card in 8.3 was produced through the harness
  in 8.2, and each of the three seams is a required product change with a named owner.
- **Anything about macOS or Windows.** One Linux desktop, one compositor, one run
  (APX-CON-06). No statement in this file or in the evidence file is evidence about another
  platform, and the manual steps in section 2 are where macOS and Windows belong.

### 8.5 Why the observer is the X server and not the product

The product's own `host.show()` resolving is a claim the product makes about itself. What
has to be established is that something is on a screen. So every window rectangle, map state
and pixel reading in the evidence file came out of the display server through `xwininfo`,
`xprop` and `xwd`, and the only value taken from the product is the process id, read from
the runtime file the hub published. A check the product grades itself is a check that passes
when the product is broken.

The one value read from inside the renderer is the *contents* of the card document — its
attribute names, element count, role, live-region, `aria-label` length and the two text-line
lengths, with the words themselves never recorded. That reading is corroboration for the
card's shape, never the basis of a visibility claim: visibility is the X server's answer.
Card *lengths* are recorded and card *words* are not, and the file records no prompt, no
tool name, no diff, no D-Bus payload and no absolute path from this machine (APX-FR-01,
APX-CON-12).
