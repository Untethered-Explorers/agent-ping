# User Guide

How to use agent-ping day to day: what it tells you, how to get to it, what it will
never show you, and what to do when something looks wrong.

For installing on a machine you administer, configuring state, backups, upgrades and
hardening, see the [administrator guide](admin-guide.md). For what this project
still owes and what has *not* been verified on real software, see
[`docs/reviews/deferred-gates.md`](reviews/deferred-gates.md).

## Who this is for

You run several long-lived coding-agent sessions at once, across several
repositories, and you lose track of them. One blocks on a permission decision you
never saw and you find out an hour later. agent-ping is for that person.

It is also for someone who does not want a second dashboard demanding their
attention. Most of what your agents do stays inside the app: you only get interrupted
for a block, and for a turn that finished real work.

## Before you begin

| Requirement | Why |
| --- | --- |
| **Node.js 22.12.0 or newer** | The build and the runtime both require it. `agent-ping doctor` checks and names the remedy. |
| A **graphical desktop session** | agent-ping draws its own notification card and a tray icon. On a headless machine the hub still starts and the API still answers, but nothing appears on screen. |
| An **opencode installation** | This version supports opencode only. GitHub Copilot CLI was deferred at its gate; see [`docs/runbooks/copilot-support.md`](runbooks/copilot-support.md). |
| Linux, macOS or Windows | Only Linux has ever actually been run. See [Known gaps](#known-gaps) at the end of this guide. |

Nothing needs an account, a token to obtain, or a configuration file. There is no
sign-in, because there is nothing to sign in to.

## Install and first use

From a built checkout:

```bash
npm install
npm run build
npm install -g .
agent-ping install
```

`agent-ping install` does three things and prints one line per thing, saying whether
it changed it or checked it and left it alone:

1. writes the opencode plugin into opencode's global plugin directory, so **every**
   session in **every** repository reports to agent-ping — there is no
   per-repository setup;
2. writes and enables a **user-level** login unit, so agent-ping starts when you log
   in (no `sudo`, nothing system-wide);
3. starts the hub and waits until it is actually answering, not merely spawned.

Run it a second time and it changes nothing. That is the point: a repeat install is
safe.

Then:

```bash
agent-ping status
```

It prints the hub's origin, how long it has been up, the pending count, when the
last event arrived, how many sessions are active, and the delivery status. If the
hub is not running, `status` says so in words and names the remedy — it never prints
a table of zeroes, which would read as "nothing needs me" rather than "nothing is
running".

## Main workflows

### The card: something is waiting on you

When a session blocks on a permission decision or on your input, one card appears in
the corner of the screen, inside your work area, never over a taskbar or a dock. It
names the repository and says one sentence. It stays until the block is resolved or
until you acknowledge it. It is never shown twice for one block — persistence comes
from the tray badge and the history, not from a repeat timer.

The card is drawn by agent-ping itself, so your operating system's notification
service sees nothing from it. It cannot steal your keystroke: the window is shown
without focus.

To act on a block, go to the session. The card deliberately has no buttons — the
only control agent-ping has over a session is marking a block acknowledged. The
**tray icon** opens the dashboard focused on the oldest outstanding item; so does a
deep link the card carries.

### The badge: how many are waiting

The tray icon carries the durable pending count: the number for one to
ninety-nine, and `99+` above that. It never shows a wrong number. Clicking it opens
the dashboard; the tray menu's **Open dashboard** item opens it without a target, and
**Quit** stops agent-ping — blocks still waiting come back when it restarts, so
quitting loses nothing that was pending.

### The dashboard: everything at once

The hub serves it at its own origin — by default **<http://127.0.0.1:43117/>**, and
`agent-ping status` prints the one your install actually bound. It shows sessions
grouped by repository, each row carrying its state as an icon *and* a word, and the
header carries the pending count beside the connection state as real text.

Four things you can do on the page:

| Action | What it does |
| --- | --- |
| **Acknowledge** | Marks one pending block acknowledged, with `POST /api/ack/:eventId` — the only thing this product can do to a session. |
| **Focus by deep link** | `?session=<id>` on the dashboard's own URL focuses that row and keeps it focused across later updates. If the hub has answered and the row is not there, the page says so rather than focusing nothing. |
| **Handoff** | Shows the command that attaches to the focused session — `opencode attach <session-id>` for opencode — as selectable text you copy and run yourself. agent-ping never runs it. |
| **History** | A panel of past events: class, repository, session, timestamp, and the two independent states (acknowledged by you, resolved by the harness). |

Add `?mirror=visible` to the dashboard URL to un-clip the invisible accessibility
mirror, which is useful when you want to see what a screen reader would.

### Reading the classes

| Class | What you see | What it means |
| --- | --- | --- |
| **needs-you** | a card, and the row's icon and word on the dashboard | a session is blocked on a decision only you can make |
| **finished** | a card that expires on its own, and a row | a session went idle *after doing real work* |
| **fyi** | a row and a history entry — never a card, never a badge change | errors, retries, long tool calls, compaction, token burn |

A session that opened, said hello and closed fires **no event at all**. The gate
lives in the classifier, not in the card, so nothing is built to display it.

## Offline and reconnect behaviour

There is no cloud service and nothing to be "offline" from in the usual sense. What
can happen is that the hub is not answering:

- **The plugin cannot reach the hub.** It leaves a breadcrumb line in opencode's own
  output rather than swallowing the event, so the failure is visible where you are
  already looking.
- **The dashboard loses its stream.** The page says so in words. `stale` means the
  connection dropped and a reconnect is pending; `disconnected` means reconnecting
  gave up after five attempts. In both cases the pending count is qualified as
  *last known*, because a page showing old rows next to a confident `0 pending` is
  the one answer this surface must never give.
- **The card window cannot be opened.** `agent-ping doctor` reports it as a named
  failure with its own remedy rather than as a missing install. On a headless run it
  says the run is a plain Node process rather than the application.
- **The tray cannot be mounted.** Same treatment: the desktop refused the icon, or
  there is no desktop bridge.

## Statuses and notifications

The states you can see, and where each lives:

| Where | What it tells you |
| --- | --- |
| Card | one block, or one finished turn. Icon plus word, so nothing is colour-only. |
| Tray badge | the count of things waiting on you, durable until acknowledged or resolved. |
| Dashboard row | the session's own state, joined with the pending count for that session. |
| Dashboard header | pending count and connection state, as text. |
| History panel | past events with both states: acknowledged-by-you and resolved-by-harness, recorded separately. |
| `agent-ping status` | the same numbers in a terminal, read from the same accessors the badge reads. |
| `agent-ping doctor` | seven checks, one remedy per failure, non-zero exit on any failure. |
| `GET /api/health` | instance, database, server, dashboard and delivery status, including the desktop section. |

**No sound.** There is no sound field anywhere on the notification path, so nothing
can enable one.

**Nothing occupies your screen when nothing is happening.** The host window exists
from startup but draws nothing and takes no space until a card is showing.

## Attachments and other data

There is nothing to attach, and nothing to download. This is not a gap; it is the
product's central promise. agent-ping stores **that** something happened and never
**what was said** — no prompt, no response, no tool output, no file content, no
diff, no transcript. The event envelope is exactly ten fields and the database has
no content-bearing column, both asserted as exact sets in the test suite.

What you can read is the history panel and the dashboard rows, and what they carry
is: the harness, the session identifier, the repository short name and full path,
the harness's own event name, the class and subtype, two timestamps, and the
dedupe key.

## Accessibility and mobile use

The dashboard's canvas is paired with a **visually hidden, focusable DOM mirror**:
every painted row has a twin in the accessibility tree, in the same order, carrying
the same state as an icon and a word. The pending count and connection state are
real DOM text, not pixels, so they are readable even if the canvas never paints.

Keyboard model:

| Key | Effect |
| --- | --- |
| `Tab` / `Shift+Tab` | Enter and leave the row list |
| `↓` / `↑` | next / previous row, with the focused row scrolled into view |
| `Home` / `End` | first / last row |
| `Enter` or `Space` | activate the focused row: reveal the handoff command and its state |

`Tab` and `Shift+Tab` are the only ways into and out of the row list; there is no
`Esc` shortcut, and there is no keyboard shortcut anywhere on this page that sends,
interrupts or approves anything.

Focus is held as a session identifier, not as a row index, so a live update that
re-sorts the list does not move your focus. A deep link re-asserts focus only when
the page's focus is nowhere in the list — if you have arrowed to another row, your
choice is kept.

`prefers-reduced-motion: reduce` is honoured: the arrival of a row does not animate
for anyone who has asked their system not to animate things.

**Mobile: not applicable.** This is a desktop sidecar. It needs a desktop session for
its tray and its card, and it binds a loopback port on the machine it runs on. There
is no mobile build, no remote mode, and no hosted component.

## Privacy and data handling

**What is written, and where.** Everything the product writes resolves through one
state directory, which `AGENT_PING_STATE_DIR` can point anywhere:

| Platform | Default location |
| --- | --- |
| Linux | `$XDG_STATE_HOME/agent-ping/`, else `~/.local/state/agent-ping/` |
| macOS | `~/Library/Application Support/agent-ping/` |
| Windows | `%LOCALAPPDATA%\agent-ping\` |

Inside it:

```text
agent-ping.db        the durable log: sessions, events, counters (with SQLite -wal/-shm)
hub-runtime.json     the single-instance lock and the live port
hub-write-token      the per-install write token
agent-ping.log       a bounded local log, rotated at 2 MiB across two files
```

The directory is `0700` and the files are `0600`. The log is structured and
carries no content either; `--verbose` mirrors it to your terminal.

**Retention.** Events are pruned after 30 days, with a floor of 500 events per
session so a busy session is not emptied out from under you. Counters are numbers,
not records.

**What leaves your machine: nothing.** There is no telemetry, no update check and
no crash report. The only outbound call any command makes is a `GET` to the
loopback hub.

**What the network sees: only loopback.** The hub binds `127.0.0.1` and refuses any
request whose remote address is not loopback.

**Deletion.** `agent-ping uninstall` removes the plugin, the autostart unit and the
local log, and **keeps the database** so a mistaken uninstall is recoverable.
`agent-ping uninstall --purge` deletes the database too.

## Troubleshooting

Start here:

```bash
agent-ping doctor     # seven checks, one remedy each, exit 1 if any failed
agent-ping status     # is the hub up, and what is it saying
```

| Symptom | What it usually means | Where to look |
| --- | --- | --- |
| No cards, and `doctor` says the surface is `window-refused` | the runtime is installed and the desktop refused the window. This is **not** a missing Electron — do not reinstall it | the `notification surface` row's own remedy; it names the Chromium launch policy and then the compositor |
| No tray icon | the desktop has no status area, or agent-ping is running as a plain Node process | the `tray` row in `doctor` |
| `plugin` row fails with a version mismatch | the installed opencode plugin is a different agent-ping build | `agent-ping install --force`, or `agent-ping uninstall` then `agent-ping install` |
| `port` row fails and the preferred port is in use | something else holds `43117`; agent-ping falls back to the next free loopback port, and `status` prints the one it bound | the row prints the command that shows the holder for your platform |
| Events are not arriving at all | the plugin is not installed for this opencode, or the hub is down | the `plugin` and `port` rows; the plugin's own breadcrumb line in opencode's output |
| A card did not appear for something that was blocked | check the class: `fyi` never produces a card, and a session that did nothing produces no event at all | the dashboard's history panel |
| Acknowledgement is refused | the page has no write token, which is by design — the token is in no response and no served asset | the page says why on the control itself; see the [administrator guide](admin-guide.md) |

The full evidence table for the notification surface — what was observed, on what,
and by which script — is
[`docs/runbooks/notification-surface.md`](runbooks/notification-surface.md).

## Known gaps

These are part of this version, not surprises. The register that owns each one, with
the procedure that closes it, is
[`docs/reviews/deferred-gates.md`](reviews/deferred-gates.md).

- **macOS and Windows have never run agent-ping.** Every live observation behind
  every claim in this guide comes from one Linux desktop. The code path is one; the
  window manager is not the same, and that has not been observed.
- **No login has been observed starting the hub** on any platform.
- **No human has watched the product work end to end.** Three review gates were
  closed by attestation rather than by review, and two were closed before the
  software they review existed.
- **The dashboard has not been used by a keyboard-only or screen-reader user.** The
  mirror, the keyboard model and the reduced-motion path are implemented and
  automatically tested; the human judgement is owed.

## Getting help

- Something is broken: run `agent-ping doctor` and include its output. It names the
  state directory, the port, the plugin and one remedy per fault.
- A claim in this guide looks wrong: check
  [`docs/PROGRESS.md`](PROGRESS.md) first, which enumerates every check that is *not*
  verified against real software, and the [ADR index](adr/README.md) for whether a
  decision is a decision or merely a plan.
- Bug reports and questions: the repository's issue tracker, or the maintainer
  contact in the [README](../README.md#author).
- Security reports: see the [README's Security section](../README.md#security).
  There is no `SECURITY.md` yet, and a private report is preferable to a public
  issue for a loopback service.
