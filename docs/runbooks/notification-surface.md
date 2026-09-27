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
| **A card appearing on a desktop inside a running hub** | **NOT LIVE-VERIFIED** | the card document (`dist/dashboard/card.html`) is not in the built artefacts, and the main-to-renderer channel is not wired. NT-9 owns this and must record it as a required product change rather than skip it |
| A card on **macOS** | **NOT VERIFIED, AND NOT CLAIMED** | one implementation, but only Linux was ever run. No statement in this repository is evidence about macOS |
| A card on **Windows** | **NOT VERIFIED, AND NOT CLAIMED** | as above |

Nothing in this file is a claim that a card was seen on a screen by a human. The one
hand-run Electron check in this product's history drove a window and a *document* and
observed real laid-out text; it did not drive a delivery, and the composition that
delivers has never been run.

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

If `GET /api/health` reports `not-wired` with a diagnostic saying the run has no way to
render a card, then **that is the correct result, not a failure of the check**. Section 4
explains why, and NT-9's script must fail on it rather than pass. Do not work around it
by calling any notification tool by hand: the whole point of ADR-012 is that there is no
such call in this product, and a manual check that reached for one would be checking the
wrong thing.

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

Not covered, and not claimable from here:

- whether a compositor draws a transparent frameless always-on-top window correctly
- whether a card is legible at the real size, and whether the real font metrics fit
- whether `showInactive` is unfocused on every window manager
- whether the card document loads at all in the built artefacts — **it does not**
- anything at all about macOS or Windows

## 4. What is missing, in the order it blocks something

1. **The card document.** `src/dashboard/card.html` does not exist, and the dashboard's
   Vite build has one entry, so `GET /card.html` currently 404s. The card view exists
   (`src/notify/surface/card-view.ts`) and is unit-tested; the page that mounts it does
   not. Owner: dashboard-engineer, because the Vite root and the entry list are its file.
2. **The main-to-renderer channel.** The main process has a window and a card model, and
   the renderer runs with `contextIsolation: true`, `nodeIntegration: false` and
   `sandbox: true` — so it has no `require` and no `ipcRenderer`, confirmed on real
   Electron. Something has to carry the model from the first to the second. It has not
   been chosen, and choosing it is a decision about the host's Electron surface, not a
   detail.
3. **The consequence, stated rather than hidden.** Until both exist, the composition root
   finds no renderer, reports the run as `not-wired` with a diagnostic, and
   **records no deliveries as made**. That is the honest answer and it is the behaviour
   `tests/notify/policy.test.ts` asserts. A transparent rectangle with nothing in it is
   not a card, and reporting one as a delivery would be the exact lie APX-FR-02 forbids.
4. **Removing a card when the block is acknowledged.** The lifetime table names
   `resolved` and `acknowledged` as the two ends of a needs-you card, and the card view
   removes on either. Nothing in the delivery path is *told* about an acknowledgement
   yet: the ack route has no notifier hook, and adding one is a hub change rather than a
   delivery one. Until then a needs-you card leaves the screen when its window is
   destroyed, which is correct at shutdown and not yet correct in the middle of a run.
   Owner: hub-engineer, as a handoff.

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
| `not-wired`, reason `no-card-renderer` | a window exists and nothing can be put in it. Today's shipped state (section 4) | the diagnostic at start-up |
| `not-wired`, reason `window-refused` | the desktop would not give the window. The hub keeps serving; every delivery is `not-wired` | `CHROMIUM_LAUNCH_POLICY` first, then the compositor |
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
   destroyed — correct at shutdown, not yet correct mid-run. See section 4, item 4.
