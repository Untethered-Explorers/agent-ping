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
| **A card appearing on a real desktop, inside the work area, painted, and persisting** | **LIVE-VERIFIED on Linux**, with **no seam supplied by the run** — `shippedPosture` is `asserted: true` and the run's own `seams.count` is 0 | `scripts/verify-notification-surface.mjs`, evidence in `docs/reviews/notification-surface-evidence.json`, journey `needs-you`: a real `320x96+1584+48` window, `IsViewable`, inside the advertised work area, 1 127 distinct painted values in its own drawable, painted with the product's own `#3a1f24` fill at a distance of 7 per channel, still there 4.0 s later, gone 55 ms after the acknowledgement with the window unmapped |
| **A finished card leaving the screen on its own** | **LIVE-VERIFIED on Linux** | same evidence file, journey `finished`: the window appeared 63 ms after the event, painted with the product's own `#1b2b24` fill at a distance of 6, and the window was unmapped after the 5 000 ms interval with nothing dismissing it |
| A greeting-and-close session produces no window and no card | **LIVE-VERIFIED on Linux** | same evidence file, journey `greeting-and-close`: zero events, zero windows, pending set unchanged, no viewable card window while nothing was pending |
| The operating system's notification centre received nothing from agent-ping, and the instrument was capable of seeing a notification | **observed on a real desktop** | same evidence file, `notificationCentre`: 0 calls during the journeys, 2 from a deliberate positive control through the same monitor. Recorded as an observation, never asserted |
| The Chromium launch policy is load-bearing | **observed on a real Electron process** | same evidence file, `machine.launchPolicy`: with `ELECTRON_DISABLE_SANDBOX=1` the binary starts; without it, the setuid-sandbox FATAL (PRD 16 Open Question 13) |
| **The product *as shipped* can show a card today** | **YES, in code: the card document is a build entry, the window names a preload, and the Electron bridge supplies `renderCard`** | `tests/dashboard/card-document.test.ts` (the document is in the built artefacts), `src/notify/surface/electron-host.ts` (`SURFACE_WINDOW_OPTIONS.webPreferences.preload`), `src/main/index.ts` (`electronDesktopBridge` supplies `renderCard`), and `tests/notify/surface-channel.test.ts`, which drives the real `startHub` over a real loopback socket with the real bridge and gets `wired` with `delivered: 1` |
| …and that shipped path on a **real desktop** | **LIVE-VERIFIED, all 22 assertions holding, no seam supplied** | section 8: `shippedPosture` asserted true, the four build artefacts present, the policy `wired`, the document served byte for byte under the product's own CSP, both journeys' fills matched against the product's built stylesheet, the acknowledgement taken the card down, and the anti-noise journey produced nothing at all |
| …and that the run cannot quietly substitute for the product again | **ENFORCED FROM SOURCE, not promised** | `tests/scripts/verify-notification-surface.test.ts` reads the script's own source and fails on the card document, the stylesheet, the entry module, the renderer bridge, a dashboard-root override, a second `writeFileSync` call, a second Electron launch, and the seven removed exports |
| The card document is in the built artefacts and is served by the hub | **implemented, unit-tested, and proved over a real socket** | `tests/dashboard/card-document.test.ts` (13 tests, which run the real Vite build), `tests/hub/server.test.ts` (a real `GET /card.html`: 200, `text/html; charset=utf-8`, `nosniff`, the full CSP, no `unsafe-inline`) |
| A card model reaches that document across a channel that leaves `contextIsolation`, `nodeIntegration: false` and the renderer sandbox in force | **implemented, unit-tested, and driven once by hand against the real binary** | `tests/notify/surface-channel.test.ts` (one global, key set exactly `remove` and `show`; the payload is exactly a `CardModel` and a `CardLifetimeCell`; no `executeJavaScript` and no `webSecurity` anywhere under `src`; the host interface still exactly five methods), and the hand-run in `src/notify/surface/electron-host.ts`'s header |
| A card on **macOS** | **NOT LIVE-VERIFIED, AND NOT CLAIMED** | one implementation, but only Linux was ever run. No statement in this repository is evidence about macOS |
| A card on **Windows** | **NOT LIVE-VERIFIED, AND NOT CLAIMED** | as above |

Nothing in this file is a claim that a human read a word off a card. The live run reads
pixels, not text: it counts distinct values in the window's own drawable and compares the
colour the compositor put there with the colour the product's own built stylesheet names,
and legibility stays a manual, per-platform step (section 8.4).

The journeys in section 8 are driven against **the product's shipped build, with nothing
substituted**: the card document, the preload, the channel, the presenter and the
acknowledgement hook are the product's own (NS-1, NS-2, NS-3), and a test reads the script's
source to keep it that way (section 8.2). What that arrangement cost is stated rather than
hidden — the run no longer reads the card's contents out of a renderer, because the only
way to do that from outside the process is to inject code into it — and 8.4 says which
suites hold that claim instead.

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

A card reaches that document through a **preload and a context bridge**, because the
document runs with `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`
and therefore has no `require` and no `ipcRenderer` of its own. The window names the
preload in `webPreferences`; the preload puts exactly two calls — `show` and `remove` — on
exactly one global; the main process sends the two messages behind them. Nothing was
widened to make that work: there is no `executeJavaScript` and no `webSecurity` change
anywhere under `src`, and a test asserts both absences over every file in the tree
(NT-FR-12).

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

# 4. Read what the hub recorded about that attempt. With the shipped Electron bridge
#    this is `ok` with `delivered: 1` and a window in the work area. `not-wired` is
#    still the correct answer for a headless run, for a runtime that provides no
#    `ipcMain`, and for a desktop that refused the window (see section 4).
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

### What "by hand" means when the answer is `not-wired`

`GET /api/health` reports `not-wired` in three real cases, and in each of them that is the
correct result rather than a failure of the check:

- **a headless run** — no desktop bridge at all, so no window and no renderer. This is
  what the test suite and the CLI get.
- **a runtime that provides no `ipcMain`** — the window exists and nothing can be put in
  it, so `resolveSurfaceNotifier` answers `no-card-renderer` and every delivery is
  recorded as not-wired with a diagnostic on stderr. A transparent rectangle with nothing
  in it is not a card, and reporting one as a delivery would be the lie APX-FR-02 forbids.
- **a desktop that refused the window** — `window-refused`; the hub keeps serving.

The shipped Electron bridge is none of those: it supplies a window *and* a card presenter,
so a real `permission.asked` on it is a `delivered` delivery. If you are driving a card by
hand and get `not-wired`, the reason field in `.delivery` says which of the three it was.

To see a real card on a real display without any of that, run
`scripts/verify-notification-surface.mjs` (section 8): it starts the product's own shipped
build against a state directory of its own, supplies no part of the card path, and its
evidence file records on the record that it supplied none (`seams.count: 0`).
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
- the card channel: one global, a key set of exactly `remove` and `show`, a payload that is
  exactly a `CardModel` and a lifetime cell and nothing else, and a refusal that quotes no
  value — plus the end-to-end path, where the real `startHub` with the real Electron bridge
  over a real loopback socket answers `wired` and counts a real posted block as `delivered`
  (`tests/notify/surface-channel.test.ts`)
- the verification script's own judgement, every parser, every new verdict and **its own
  source**, in `tests/scripts/verify-notification-surface.test.ts` (144 tests): the fill
  reading against a real built stylesheet, the document's byte-for-byte comparison, the
  shipped-artefact verdict, the comment-stripping reader, a run where nothing executed, a
  run where the display or the Electron binary was absent, and the seven source sweeps that
  keep the run from substituting any part of the card path

Not covered by those, and covered only by the live run in section 8:

- whether a compositor draws a transparent frameless always-on-top window correctly
- whether the card's *contents* are what the product's own suites say they are — the live
  run reads the compositor, not the renderer, because reading a renderer from outside the
  process means injecting code into it. The element tree, the accessible name, the
  live-region role and the text lines are held by `tests/notify/surface-card-view.test.ts`
  and `tests/dashboard/card-document.test.ts`, and are not claimed by the run (section 8.4)
- whether a card is legible at the real size, and whether the real font metrics fit — the
  live run measures *painted pixels*, never a word, so legibility stays manual even on
  Linux, and the stylesheet that drew the card is now the product's own
- whether `showInactive` is unfocused on every window manager — the X server exposes no
  focus reading for a card window on this desktop
- whether a pointer can reach the card, and whether click-through and its release both work
- whether the tray icon mounts, and what number it carries: a StatusNotifierItem is not an X
  window, so neither is observable from outside the process
- anything at all about macOS or Windows

## 4. What is missing, in the order it blocks something

Items 1, 2 and 5 were open when this section was written and have since been built; they
are kept, with what closed them, because a list that deletes its own history is a list
nobody can date. Item 3 is **closed by NS-4**, the re-run of the live verification against
the shipped build. Items 4 and 5 are closed by NS-3. **Item 6 is the only one still open.**

1. **The card document — CLOSED by NS-1.** `src/dashboard/card.html` is now a third entry in
   the dashboard's one Vite build, so `npm run build:dashboard` emits
   `dist/dashboard/card.html` and the hub's existing static route serves it at
   `GET /card.html`. The view it mounts is the product's own `createCardView`, and the
   document writes its state through attributes under the dashboard's strict CSP.
   **Proven** by `tests/dashboard/card-document.test.ts` (which runs the real build itself
   and compares the other two pages byte for byte) and by `tests/hub/server.test.ts`, which
   drives a real `GET /card.html` over a real socket and asserts 200, `text/html;
   charset=utf-8`, `nosniff`, the full CSP and no `unsafe-inline`. **Not re-observed on a
   desktop:** the 404 in the evidence file is a capture of a build that predates this.
2. **The main-to-renderer channel — CLOSED by NS-2.** The card document runs with
   `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`, so it has no
   `require` and no `ipcRenderer`. The channel is a **preload with a context bridge**:
   `SURFACE_WINDOW_OPTIONS.webPreferences.preload` names `preload.cjs`, the preload exposes
   exactly two calls on exactly one global (`show` and `remove`), and the main process's
   side sends the two messages behind them with `webContents.send`. `executeJavaScript` was
   not used (it needs no boundary at all, which is exactly why it is not used) and the
   renderer settings were not widened. The Electron bridge now supplies
   `DesktopBridge.renderCard`, so a real block becomes a real card and the delivery is
   counted as delivered. **Proven** by `tests/notify/surface-channel.test.ts`, which drives
   the real `startHub` over a real loopback socket with a structural Electron module and
   asserts `wired: true` with `delivered: 1` for a real posted block, that the key set is
   exactly `remove` and `show`, that the payload is content-free, that the three renderer
   settings and the frozen option object survive, and that a card which ends is removed
   through the channel with the window hidden. **Observed by hand** against the real
   Electron 44.4.5 binary: the exposed surface arrived in the document with a key set of
   exactly `remove` and `show`, a model crossed and rendered, and the page had neither
   `process` nor `require`.
3. **The consequence — CLOSED by NS-4.** With all three pieces in place, the composition
   root finds a renderer, the delivery policy is wired, and a real block is recorded as
   `delivered` with a card in the work area. `scripts/verify-notification-surface.mjs` was
   re-run against the shipped build with **no seam supplied by the run** and now
   *asserts* what it could only record: `shippedPosture.asserted: true`, all four card
   artefacts present in the build, the policy `wired`, `GET /card.html` served **byte for
   byte** under the product's own CSP, both classes' fills matched against the product's
   built stylesheet, the acknowledgement taking the card down, and the anti-noise journey
   producing nothing at all. 22 of 22 assertions, exit 0. The three gaps the old evidence
   file carried as required product changes are recorded as closed, with the task that
   closed each of them, under `productChanges.closed`; what the run still cannot cover is
   in section 8.4 and in the evidence file's `notVerified`.
   What is left is the set of things a run cannot observe from outside a process — the
   card's contents, legibility, focus, pointer reach, the tray icon, the exact colour, and
   any second platform — each named in 8.4 with the suite that holds it instead. **Item 6
   below is the only open product change left in this file.**
4. **Removing a card when the block is acknowledged — CLOSED by NS-3.** The lifetime table
   names `resolved` and `acknowledged` as the two ends of a needs-you card, and the card
   view removes on either; until NS-3 nothing produced either, so a needs-you card left the
   screen only when its window was destroyed at shutdown. The producer is now
   `src/notify/surface/dismissal.ts`, a narrow port on `HubServices`, called from exactly
   two places: the ack route after a successful acknowledgement (end `acknowledged`), and
   the hub's own live state feed when a harness resolution clears a pending item (end
   `resolved`) — which needs no route at all, because a resolution arrives as an ordinary
   ingested signal whose class the policy refuses. The decision that a card *should* go
   down stays the hub's; the channel's new `dismiss` owns the removal itself, the message
   to the document and the host's own `hide` behind it. **Proven** by
   `tests/notify/surface-dismissal.test.ts` (a real `startHub` over a real socket, the
   real bridge, a real `POST /api/ack/:eventId` and a real harness resolution, with the
   window's sends and hides asserted) and by `tests/hub/ack.test.ts` for the refusals, the
   unchanged 200 body, the empty whole-log diff and the two services objects.
   **Also observed on a real desktop**, by NS-4's re-run against the shipped build: after a
   real `POST /api/ack/:eventId` the badge's own accessor fell 1 → 0 and the card's window
   was unmapped 55 ms later, with nothing in the script doing it and no fallback dismissal
   that could have hidden a product which had not done it (section 8.3).
5. **Nothing takes the window down when a card ends — CLOSED by NS-2 for the card's own
   end, and by NS-3 for the hub's two.** The main process's half of the channel now arms
   the *same* clock the card document's own view arms, from the same lifetime cell and
   through the same `armCardExpiry`; when it elapses it sends the removal through the
   channel and calls the host's own `hide()`. Two arms of one interval, not two policies:
   the document's arm takes the card out of the document, the main process's arm takes the
   *window* down, and only the main process can do that. A needs-you cell arms nothing at
   all, so a block somebody is waiting on cannot be timed out (NT-FR-08, NT-FR-10). **Proven**
   by `tests/notify/surface-channel.test.ts` over a real host and a real channel with the
   clock injected: the interval is the table's own, the removal names `expired`, `hide()`
   is called once, and a needs-you card arms nothing. The acknowledgement edge that was
   open here is now the dismissal above, and it ends in this same path: the same
   `endCard`, the same `hide()`.
6. **The `not-wired` reason has nowhere to go — STILL OPEN.** `startHub` defaults
   `onDiagnostic` to a no-op and `startElectronMain` passes none, so the diagnostic the
   composition root emits when it finds no renderer is written nowhere at all. **Observed
   again on the shipped build, by the NS-4 re-run:** the run captured the shipped entry
   point's stdout and stderr across its whole life and found **0 lines the product wrote**,
   and 10 from the Electron runtime tearing itself down (zygote, network service, GPU — the
   count varies between runs). The script separates the two populations by the shape of the
   line rather than counting Chromium's noise as a diagnostic, because "found 10 diagnostic
   lines" beside "the reason is never reported anywhere" is a contradiction a reader has to
   resolve. A wired run has nothing to report, which is why this gap is invisible in
   section 8; it is exactly what an operator would need told on the desktop where it bites.
   Owner: hub-engineer.

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
| `not-wired`, reason `no-card-renderer` | a window exists and nothing can be put in it: a runtime that provided no `ipcMain`, so the bridge hands the composition root no renderer (section 2) | the child's stderr, which carries the diagnostic, and `CHROMIUM_LAUNCH_ENVIRONMENT` first |
| `not-wired`, reason `window-refused` | the desktop would not give the window. The hub keeps serving; every delivery is `not-wired` | `CHROMIUM_LAUNCH_POLICY` first, then the compositor |
| `not-wired` and **nothing in the log or on stderr** | the reason is real but has no destination: the Electron entry point passes no `onDiagnostic` (section 4, item 6) | the child process's stderr; this is a product gap, not a silent success |
| `failed` with `document-unavailable` | `GET /card.html` did not serve a document | the dashboard build, and `dashboardRoot` |
| `failed` with `card-not-rendered` | the window came up and the card did not go in; the window was taken back down | the renderer channel (section 4) |
| `failed` with `card-channel-payload-refused` | the guard in `src/notify/surface/channel.ts` refused what was about to cross, so nothing was rendered and no value appears in the reason | the model's five fields; a session identifier or a path has no field to travel in, and a deep link with a second query parameter is refused (section 4, item 2) |
| no card, no failure, and a finished session | the preload is refused because the build has no `preload.cjs` beside `preload.js` — the same class of gap as a missing `schema.sql` | `npm run build` (tsc emits `dist/main/notify/surface/preload.cjs` from the `.cts` source), and `CARD_PRELOAD_SANDBOX_REQUIREMENT` in `src/notify/surface/preload.ts` for why it is a `.cjs` |
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
2. **Nothing told the card surface that a block was acknowledged — CLOSED by NS-3.** The
   ack route now holds a narrow dismissal port (`HubServices.dismissal`) and calls it after
   a successful acknowledgement, and the hub's live state feed calls the same object when a
   harness resolution clears a pending item, so a needs-you card comes down mid-run through
   the channel's `dismiss` and the host's own `hide`. It is *not* a notifier hook: the port
   cannot show a card, cannot deliver anything and cannot change a record, and it is only
   reachable from the two places above. See section 4, items 4 and 5. NS-4 then observed the
   edge itself on a real desktop, with nothing in the verification run doing it.

## 8. What the live run actually observed

Everything above this line is a claim about code. This section is the claim about a desktop:
one Linux desktop, one compositor, one run, made on 2026-09-27 at 18:50 UTC by
`scripts/verify-notification-surface.mjs`. The evidence it wrote is
`docs/reviews/notification-surface-evidence.json` (`"evidenceVersion": 3`), and the
judgement, every parser, every verdict and **the script's own source** are unit-tested in
`tests/scripts/verify-notification-surface.test.ts` (144 tests).

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
assertion; `2` on a bad command line; `3` on a missing dependency, in which case **no
evidence file is written at all** — a report that says "nothing was there" is
indistinguishable from a report that says "nothing was looked for". A missing display, a
missing Electron binary, a missing X tool and a missing built artefact are all exit 3, and
none of them is a skip.

### 8.1 The run, and the verdict

On the authoring machine — Ubuntu 24.04, X11 `:1`, Electron 44.4.5, Node 22.22.2, work area
`{x: 0, y: 32, width: 1920, height: 1048}` — the script:

1. proved its own observer could see a window at all, with a control window it did not
   create,
2. started **the product's shipped built entry point, `dist/main/main/index.js`**, against a
   state directory of its own,
3. asserted what that build *is* — the four card artefacts present, the delivery policy
   wired — and then drove three journeys against it over the real loopback socket,
4. counted what the session's notification bus carried while it did.

**Verdict: pass. 22 of 22 assertions executed, 22 matched, exit 0**, in 20 430 ms wall
clock. Every row below is a row the summary prints with its expected and observed value, so
the verdict is 22 named comparisons and not a score.

| Journey | Assertion | Expected | Observed |
| --- | --- | --- | --- |
| observer | found and read a control window it did not create | `found-and-painted` | `found-and-painted` |
| hub | a built Electron main process started the real hub serving on loopback | `serving` | `serving` |
| hub | published its own runtime file rather than being reached on an assumed port | `runtime-file-read` | `runtime-file-read` |
| shipped-build | the built artefacts carry the product's own card document, its stylesheet, its entry bundle and the preload its window loads | `in-the-build` | `in-the-build` |
| shipped-build | the shipped delivery policy is wired, so the card model crossed a channel the product owns | `wired` | `wired` |
| needs-you | a real needs-you event created exactly one pending item | `1` | `1` |
| needs-you | a card window appeared inside the display work area | `inside-the-work-area` | `inside-the-work-area` |
| needs-you | the card window held painted content | `painted` | `painted` |
| needs-you | the painted fill is the product's own stylesheet fill for a needs-you card | `needs-you-fill` | `needs-you-fill` |
| needs-you | the card was still on screen after a wait | `still-present` | `still-present` |
| needs-you | the delivery outcome for the block was recorded as delivered | `delivered` | `delivered` |
| needs-you | the hub served the card document the window loads, byte for byte under the product's own policy | `served-identically` | `served-identically` |
| needs-you | the badge number fell when the item was acknowledged | `0` | `0` |
| needs-you | the card was gone after the acknowledgement | `gone` | `gone` |
| finished | a worked idle transition created exactly one finished event | `1` | `1` |
| finished | a card window appeared for the finished event | `inside-the-work-area` | `inside-the-work-area` |
| finished | the painted fill is the product's own stylesheet fill for a finished card | `finished-fill` | `finished-fill` |
| finished | the finished card expired with nothing dismissing it | `expired` | `expired` |
| greeting-and-close | created no event | `0` | `0` |
| greeting-and-close | left the pending set unchanged | `0` | `0` |
| greeting-and-close | created no window | `none` | `none` |
| greeting-and-close | no card window was viewable while nothing was pending | `none` | `none` |

### 8.2 What the run supplies, which is nothing

**The one thing to know about this run: it substitutes no part of the card path.** It
starts the product's own built entry point, lets the product resolve its own dashboard
root, and observes. The evidence file's `seams` section says so in machine-readable form:
`"count": 0`, an empty `suppliedByThisRun`, and the list of the four things it would have had
to write in order to substitute — a card document, a card stylesheet, a card entry module,
and a renderer bridge that injects a model into the window.

That is a change from NT-9, which had to supply all three of the open seams itself and
could therefore only *record* what the product as shipped did. `shippedPosture` is now
`"asserted": true`, with the reason spelled out in the file: NS-1 built and served the card
document, NS-2 opened the renderer channel and wired the card presenter, and NS-3 took the
card down when its block ends, so the withheld assertion became real. A run that still
recorded it would now be the stale artefact.

The substitution cannot creep back, because a test reads this script's own source and fails
on it:

- no card document — `<!doctype html>`, `data-card-surface` and the stylesheet link are all
  absent from the file
- no card stylesheet — no rule keyed on the card's own attributes, no `border-radius`, no
  `box-sizing`
- no card entry module — no `card-entry.js`, no `createCardView`, no `card-view.js`, and the
  `cardDocumentSource` / `cardEntrySource` / `harnessMainSource` exports are gone
- no renderer bridge — no `executeJavaScript`, no `webContents`, no `exposeInMainWorld`, no
  `contextBridge`, no `__agentPingCardSurface`
- no dashboard root of its own — `AGENT_PING_SURFACE_DASHBOARD_ROOT` appears nowhere; the
  state directory stays, because that is the product's own mechanism
- **exactly one** `writeFileSync` call in the file, and it writes the evidence file
- exactly one Electron launch, and it is the built entry point: three `spawn(` calls in all,
  and each is accounted for (the hub, the `xmessage` control, the `dbus-monitor`)

`tests/scripts/verify-notification-surface.test.ts` holds all seven, reads the source with
its comments stripped so the check is about the calls and not about the prose describing
them, and is in the suite that runs on every change.

### 8.3 What was observed, positive and negative

**Positive — the shipped build is the product's own, and this run checks that rather than
assuming it.** Four artefacts, all read out of `dist/`: the card document itself, the entry
bundle its `src` names, the stylesheet its `href` names, and `preload.cjs`, which the
surface window's own frozen options load. The delivery policy answered `wired` — which the
product only reports when a card presenter is behind the surface, so this row is the
answer to "is the renderer channel the product's?" asked of the product's own health
payload.

**Positive — the document the window loaded is the document the build produced.** A real
`GET /card.html` answered **200** with a body compared **byte for byte** against
`dist/dashboard/card.html` — the same 2 957 bytes — and with the product's own
`content-security-policy`: `default-src 'self'; script-src 'self'; style-src 'self'; …;
object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`, and no
permissive cross-origin header. This row is the one that could not have passed five minutes
ago, and it is the row that makes "the document is the product's" a reading rather than a
hope: a status code of 200 would have answered it for any document at all, including one
this script had written itself.

**Positive — the needs-you journey.** One real `POST /api/ingest` with `permission.asked`
returned `pending-created`; `GET /api/pending` went 0 → 1. **726 ms** later the display
held a card-sized window at `320x96+1584+48`, `IsViewable` (its X id differs per run and is
recorded in the evidence file rather than quoted here), inside the work area the display
server itself advertised through `_NET_WORKAREA`. Its own drawable held **1 127 distinct
values across 30 720 pixels**. **4 005 ms later it was still there**: one card per block,
not re-armed, no repeat timer (NT-FR-08). A real `POST /api/ack/:eventId` returned **200**;
the badge's own accessor went **1 → 0** and the card was gone **55 ms** later, with the
hub's own window `IsUnMapped` — taken down by the product's own dismissal port after the
route's 2xx, not by anything in this script, and this run has no fallback dismissal that
could have hidden a product that had not done it. `GET /api/metrics` reported
`toast_deliveries: 2` at the end: one per delivered card, and none for anything that was not
one.

**Positive — which card it was, read from the compositor against the product's own build.**
This is the claim that replaced the old "read the card out of the renderer" row. The run
reads the **built** card stylesheet for the fill this product paints each class with
(`--card-block-fill: #3a1f24`, `--card-finished-fill: #1b2b24`), waits for the card to stop
arriving, and then asks the X server what colour is actually in the window's own drawable:

| Card | Product's own fill | What the compositor put there | Distance | The other class |
| --- | --- | --- | --- | --- |
| needs-you | `#3a1f24` | `#3e1823` (26 975 px of 30 720) | **7** | 35 |
| finished | `#1b2b24` | `#152e24` (27 463 px) | **6** | 37 |

Two things follow, and both are stronger than anything the old row could say. The pixels
came from the product's own stylesheet, because there is no other stylesheet in this run.
And a needs-you card cannot pass as a finished one: the two fills are 35 apart in red, so
the comparison tells the classes apart — which a "painted" reading could not.

The tolerance is 12 per channel and it is measured, not guessed: the desktop colour-manages
what it is handed, and on this machine that moved the product's own fill by 7 and 6. The
one pair it cannot separate is the product's `--card-fill` and `--card-finished-fill`, which
are exactly 12 apart — and the default cannot be painted on a card at all, because the view
writes a `data-urgency` on every card and the stylesheet carries a fill rule for each of the
two urgencies. `tests/scripts/verify-notification-surface.test.ts` asserts that boundary
rather than pretending the comparison is finer than it is.

**The wait for the card to stop arriving is not politeness.** A card arrives with the
product's own animation, and a capture taken mid-flight reads a colour blended part way
between the fill and nothing: measured on this machine, the finished card was 13 per channel
from its own fill while arriving and 6 at rest — outside the tolerance, on the same card, in
the same run. So the run waits for the window's own drawable to stop changing and only then
compares (265 ms for the needs-you card, 452 ms for the finished one). A paint that never
settles is compared anyway and fails.

**Positive — the finished journey.** A worked idle transition created exactly one `finished`
event, a card window appeared **63 ms** later and was painted with the finished fill, and
the card left the screen on the product's own fixed 5 000 ms interval with **nothing
dismissing it**: the run waited 8 004 ms and then read the display, and the window was
`IsUnMapped`. This is the row that holds NT-FR-08's no-repeat-timer promise, because a
re-armed card would still be there.

**Positive, and the one that matters most — the anti-noise proof.** A session that opened,
greeted and closed produced **nothing at all**: the greeting was `no-event` with the reason
`below-threshold`, the closing was `no-event` with `idle-after-nothing`, and the journey
recorded **0 events, 0 windows created, pending 0 → 0**, and no viewable card window on the
whole desktop afterwards. The host window exists while it draws nothing, and the run
distinguishes those two facts rather than conflating them: at that moment the hub still
owned its 320×96 window and the X server reported it `IsUnMapped`, which is the NT-FR-10
distinction between *the host window existing* and *the surface being visible*
(APX-CON-06, ADR-004). "No card is on the screen" has two answers here — the window unmapped,
or the window mapped and empty — and both count, while a painted card never does.

**Positive — the observer proved itself before it was trusted.** A `xmessage` control window
was opened, found by the same `xwininfo -root -tree` enumeration the journeys use, and read
by the same `xwd` capture: `IsViewable`, 1 240 distinct values across 87 688 pixels. That
control is one of the 22 assertions. Without it, "no card appeared" would be
indistinguishable from "the observer is broken", and a green run would be unfalsifiable.

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
from the Electron runtime tearing itself down (zygote, network service, GPU — the count
varies between runs and the number above is this run's). The script separates the two
populations by the shape of the line and reports both counts, because "found 10 diagnostic
lines" beside "the reason is never reported anywhere" would be a contradiction a reader has
to resolve. See section 4, item 6, which is still open.

**Negative — a GPU process that would not start.** Chromium reported a failed GPU launch on
this machine under software rendering, both during the run and while it was being stopped.
The application reached ready and served regardless, and the failure is recorded rather than
worked around, so nothing in this section says anything about a machine with a working GPU.

### 8.4 Timings, and what this run still could not see

Timings from this run, all recorded in `evidence.timings`: hub ready **599 ms** against a
45 s deadline; observer control **384 ms**; needs-you journey **5 277 ms** total (726 ms to
the window, 265 ms to a settled paint, 4 005 ms settle, 55 ms from acknowledgement to gone);
finished journey **8 696 ms** total (63 ms to the window, 452 ms to a settled paint, 8 004 ms
waited against a 5 000 ms interval); greeting journey **1 849 ms**; whole run **20 430 ms**.

These are timings of *this machine's* Electron and compositor, not a budget, and nothing in
this file claims they hold elsewhere.

- **The contents of the card.** This is the largest thing the run no longer covers, and it
  gave the claim up on purpose. NT-9 read the card's element tree, its attribute names, its
  accessible name, its live-region role and its two text-line lengths out of the renderer,
  through a bridge the script had to build. Reading a renderer from outside the process
  means injecting code into it — the exact shape this run exists to prove the product does
  not need — so those readings are **not** made any more, and `notVerified` in the evidence
  file says so in the same words. What holds those claims now is
  `tests/notify/surface-card-view.test.ts` (a real element tree in jsdom, through the
  product's own `createCardView`) and `tests/dashboard/card-document.test.ts` (the built
  document itself). They are strong, and they are not a desktop.
- **Whether the card is legible.** The capture reads pixels and no word, and no human read a
  card off this run's display. Legibility, real font metrics and real contrast stay a
  manual, per-platform step — on Linux too.
- **The exact colour on the screen.** The fill comparison is a per-channel tolerance,
  because the desktop colour-manages what it is handed. Every reading records the distance
  it found, but no claim is made that a given hexadecimal value reached the compositor.
- **The renderer settings of the running window.** `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true` and an absent `webSecurity` are **recorded from
  the built artefact** and attributed to `tests/notify/surface-host.test.ts`, which pins the
  whole frozen object. A run outside the process cannot read a live window's options. The
  reading strips the module's comments first, and that is not tidiness: the module's prose
  names `webSecurity: false` and `nodeIntegration: true` while explaining why neither is
  done, and a first-match sweep over commented source recorded `webSecurity: false` for
  this product on the first attempt. A false claim in an evidence file is the one thing
  this run exists to prevent, so the reader that could produce one is a test now.
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
- **An installation that is already running.** The shipped entry point takes Electron's
  single-instance lock, so a second launch quits before it serves. This run therefore proves
  the *build*, in a state directory of its own, and cannot verify a hub that is in use on
  the same desktop. The first attempt of the re-run hit exactly this, and the script
  reported it as a failure with the remedy rather than as a missing card.
- **Anything about macOS or Windows.** One Linux desktop, one compositor, one run
  (APX-CON-06). No statement in this file or in the evidence file is evidence about another
  platform, and the manual steps in section 2 are where macOS and Windows belong.

### 8.5 Why the observer is the X server and not the product

The product's own `host.show()` resolving is a claim the product makes about itself. What
has to be established is that something is on a screen. So every window rectangle, map
state, pixel count and colour in the evidence file came out of the display server through
`xwininfo`, `xprop` and `xwd`, and the only values taken from the product are its process id
(read from the runtime file the hub published), its health payload, its static route's
answer, and its built stylesheet. A check the product grades itself is a check that passes
when the product is broken.

Nothing is read from inside a renderer any more (8.4), which is the reason the two readings
that replaced it are *stronger* than the one they replaced: the pixels on the screen could
only have come from the product's own stylesheet, because a run that supplies no stylesheet
has nowhere else for them to come from. The file records event ids the log itself generates,
class names, counts, rectangles, colours, distances, timings, versions and closed reason
tokens — and no prompt, no tool name, no diff, no D-Bus payload, no card word, and no
absolute path from this machine (APX-FR-01, APX-CON-12).

### 8.6 What this section replaced, and what is still open

Section 8 of the previous revision of this file described NT-9's run, which supplied three
seams and therefore could only record the product's own posture: `GET /card.html` → 404,
`delivery.status: "not-wired"`, `toast_deliveries: 0`, no viewable card window. Those were
true of the build that run exercised and false of this one, and they are superseded by
everything above. Section 8.6 of the old revision, which recorded a hand-driven run of the
shipped path after NS-1 and NS-2, is superseded too — but it was the first observation of
the product's own card on a desktop, and its findings are the ones this run now asserts.

Three things the old section listed as missing, and their state now:

- **the card document** — closed by NS-1, and asserted here: present in the build and served
  byte for byte
- **the renderer channel** — closed by NS-2, and asserted here: the shipped policy answers
  `wired`, which the product only reports when a presenter is behind the surface
- **the acknowledgement edge** — closed by NS-3, and asserted here: a real
  `POST /api/ack/:eventId`, the badge's number falling and the card's window unmapped 55 ms
  later, with nothing in this script doing it

Still open, unchanged, with owners: **section 4 item 6**, the `not-wired` reason having
nowhere to go (hub-engineer); **section 4 item 3's remainder**, nothing — it is closed now,
and the rest of what a run cannot cover is in 8.4; the tray's unobservability
(notification-engineer); and the missing `schema.sql` copy step (tooling-engineer with
packaging-engineer).
