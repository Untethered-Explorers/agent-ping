<div align="center">
  <img src="assets/images/agent-ping-logo.png" width="96" alt="agent-ping logo">

  # agent-ping

  *Know when a coding agent is blocked on you — and when it is actually done.*

  ![node](https://img.shields.io/badge/node-%3E%3D22.12-3c873a?style=flat-square)
  ![typescript](https://img.shields.io/badge/typescript-strict-3178c6?style=flat-square)
  ![pixi](https://img.shields.io/badge/pixijs-8-e91e63?style=flat-square)
  ![platforms](https://img.shields.io/badge/platforms-linux%20%7C%20macos%20%7C%20windows-555?style=flat-square)
  ![loopback](https://img.shields.io/badge/network-loopback%20only-2ea44f?style=flat-square)
  ![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

  [Status](#status) • [How it works](#how-it-works) • [Notifications](#notifications) • [Getting started](#getting-started) • [HTTP API](#http-api) • [Configuration](#configuration) • [Documentation](#documentation)

</div>

You run several long-lived agent sessions at once, across several repositories, and
you lose track of them. One blocks on a permission decision you never see, and you
find out an hour later. agent-ping watches those sessions and tells you when one is
waiting on you and when one finished real work — quietly enough that you are willing
to leave it running.

It is a **local-only sidecar**: one global install, a loopback port, a notification
card agent-ping draws in its own window, and a tray badge. It never stores what your
agents said, and it never drives them.

## Status

**Under active build.** The hub, the log, the notification path and the opencode
adapter are implemented. The packaged install, the command line and the live dashboard
are not. 36 of 46 build tasks are complete and no task has failed.

The notification card has been **live-verified on Linux/X11 against the product's own
shipped build** with no test-supplied seam: a real window inside the work area, painted
with the product's own fill, taken down 55 ms after acknowledgement, and silence for a
session that does nothing. The evidence is
[`notification-surface-evidence.json`](docs/reviews/notification-surface-evidence.json)
and the claims are tabulated in
[`docs/runbooks/notification-surface.md`](docs/runbooks/notification-surface.md).

| Area | State |
|------|-------|
| Content-free SQLite log, retention, local counters | Built, tested |
| Loopback hub: reads, live stream, ingest, ack + security, delivery, restart replay, metrics, clean shutdown | Built, tested |
| Tray icon with pending badge | Built, tested |
| Self-rendered notification card, replacing the platform notifiers (NT-6 → NT-9) | **Built.** The three platform notifiers and their 56 tests were deleted by NT-8; this is the only delivery path |
| opencode adapter: event translation, transport with visible failure, global plugin install | Built, tested, and **driven against the real `opencode` binary** by OA-5 |
| PixiJS 8 dashboard prototype, DOM mirror, keyboard model | Built, reviewed (`DP-4`) |
| Live dashboard wired to the hub (LD-1 → LD-4) | `LD-1` done — renders live state, grouped, with staleness. `LD-2`–`LD-4` (mirror, interactions, browser journey) not started |
| CLI, npm package, autostart, `doctor` (IO-1 → IO-4) | The package, its `files` allowlist and its prepack guard are done (`IO-1`). The CLI, autostart and `doctor` are not: there is still no `agent-ping` command to run |
| Polling fallback, live run against a real session (OA-4 → OA-6) | `OA-4` and `OA-5` done — real binary, real permission decision, real hub, breadcrumb when the hub is absent. **`OA-6` deferred**: the human journey was not performed |
| GitHub Copilot CLI ACP spike (CP-1 → CP-2) | Done. `CP-3` **deferred** the adapter, and `CP-4` turned that into a runbook and a test. v1 ships opencode only |

> [!IMPORTANT]
> There is no `agent-ping` command to run yet, and no release. `package.json` now
> declares the `agent-ping` binary, a `files` allowlist and a `prepack` guard
> ([`scripts/prepack-check.mjs`](scripts/prepack-check.mjs)), but `src/cli` does not
> exist, so the guard refuses to publish and nothing has been installed globally.
> [docs/PROGRESS.md](docs/PROGRESS.md) is the running build log, including every check
> that is *not* yet verified against real software.

Three things in this repository are **known not to be verified**, and each is recorded
rather than glossed:

1. **Nothing has ever run on macOS or Windows.** Every observation comes from one Linux
   desktop. The notification surface is one code path across all three platforms and only
   the window manager differs, but that is a statement about the code, not an observation.
2. **No human has watched the product work end to end.** Three review gates — `OA-6`,
   `LD-5` and `IO-5` — were closed without the review being performed, and two of them
   (`LD-5`, `IO-5`) were closed before the software they review had been written. Read
   [`docs/reviews/deferred-gates.md`](docs/reviews/deferred-gates.md) before trusting a
   `complete` in the workflow state; it lists exactly what is owed, and the runbooks that
   discharge it.
3. **Half the end-to-end evidence was not retained.** `OA-5` declared only its script and
   test as outputs, so the machine summary of the real-harness run was never committed.

## How it works

```text
   opencode session
         │
         │  one global plugin file, every session, every repo
         ▼
  ┌────────────────────────────────────────────┐
  │  hub  ·  127.0.0.1  ·  6 reads, 1 stream   │
  │  classify → store → deliver                │
  └───┬─────────────┬─────────────┬────────────┘
     │             │             │
     ▼             ▼             ▼
   SQLite log     card surface  tray badge
   state only     needs-you /  durable pending
                  finished      count
     │
     ▼
   PixiJS 8 dashboard  ·  fed by the change stream
```

A globally installed opencode plugin translates harness events into one normalized
envelope and posts it to the hub. The hub classifies the signal, writes it to a
local SQLite log, and delivers what the class is worth. Watching dashboards update
from the same change feed — so there is no per-repository configuration and no
registry that can drift out of sync with reality.

## Notifications

Three classes, three levels of loudness. The design constraint is that this tool
must never become the thing demanding your attention, so most signals stay inside
the app.

| Class | Trigger | What you get |
|-------|---------|--------------|
| **Needs you** | Session blocked on a permission decision or your input | One card, drawn by agent-ping, that stays until the block is resolved or acknowledged. One card per block — the badge and the history carry persistence, not a repeat timer. |
| **Finished** | Session went idle *after doing real work* | One card that expires on its own. |
| **FYI** | Errors, retries, long tool calls, compaction, token burn | Nothing. In-app only; the dashboard is where you read it. |

**agent-ping renders the card itself** — in a small always-on-top window it creates and
owns, in a corner of your screen that never covers a taskbar or dock. Nothing is handed
to your operating system's notification service, so there is no permission to grant, no
focus-assist to fight, and no behaviour that differs between Linux, macOS and Windows.
See [ADR-012](docs/adr/ADR-012-surface-is-rendered-by-agent-ping.md) for why, and for
what it costs.

Three rules that matter more than the table:

- A session that goes idle having done **nothing** — opened, greeted, closed — fires
  no event at all. That gate lives in the classifier, not in the card.
- **Nothing occupies your screen when nothing is happening.** The host window exists but
  draws nothing unless a card is showing.
- **No sound in v1.** Deferred rather than rejected, and structurally so: there is no
  sound field anywhere on the notification path.

## What agent-ping will not do

These are enforced in code and asserted by tests, not conventions.

- **Never store conversation content.** The event envelope is exactly ten fields —
  harness, session id, repository name and path, raw event name, class, subtype, two
  timestamps and a dedupe key. There is no field that *could* hold a prompt, a
  response, tool output or a diff, and the test asserting that is an exact set rather
  than a denylist, so adding a `snippet` field fails the suite.
- **Never drive an agent.** No route spawns, steers, interrupts, prompts or approves
  anything. `POST /api/ack/:eventId` is the only route that can change an existing
  record, and it can only mark a block acknowledged. The route registry refuses at
  registration time to accept a second one.
- **Never bind wider than loopback.** The bind is `127.0.0.1`; the socket's remote
  address is checked before routing; the one write route requires a per-install
  token; the dashboard is served under a strict CSP; and no CORS header is ever sent.
- **Never own a session.** It is a sidecar: kill it, restart it, lose the race with
  it — no agent process is affected, and a repository that was never configured keeps
  working.
- **Never fail silently.** If the hub is down, the plugin leaves a breadcrumb in your
  harness's own UI instead of swallowing the event. A delivery that fails is reported
  on health, in the delivery ledger and in the metrics — never as a silent success.

## Getting started

Requires **Node.js 22.12 or newer**. This is a development checkout: there is nothing
to install globally yet.

```bash
npm install          # one package; better-sqlite3 is the only runtime dependency
npm test             # 877 tests across 29 files, on real loopback sockets
npm run typecheck    # tsc --strict, noUncheckedIndexedAccess
npm run lint
npm run build        # tsc -> dist/main, Vite -> dist/dashboard
```

### The dashboard prototype

The static prototype renders three mock rows in PixiJS with no hub, no plugin and no
real data. It exists to settle the layout and the accessibility model before any
connector work.

```bash
npx vite                                    # dev server on the prototype page
npm run build:dashboard                     # -> dist/dashboard/index.html
```

### The hub, by hand

There is no CLI yet, so the hub is started programmatically. `tsc` emits JavaScript
only, so the build copies the durable schema beside the emitted store itself:

```bash
npm run build
```

```js
import { startHub } from './dist/main/main/index.js'
import { readFileSync } from 'node:fs'

const hub = await startHub({ lifecycle: { installSignals: false } })
const token = readFileSync(`${hub.stateDir}/hub-write-token`, 'utf8').trim()

// A block reported by a harness adapter.
await fetch(`${hub.origin}/api/ingest`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    harness: 'opencode',
    eventName: 'permission.asked',
    sessionId: 'ses_demo',
    repoFullPath: '/home/dev/Projects/agent-ping',
    transitionId: 'blk_1',
    occurredAt: new Date().toISOString(),
  }),
})

const { items } = await (await fetch(`${hub.origin}/api/pending`)).json()

// The one mutation a client can reach.
await fetch(`${hub.origin}/api/ack/${items[0].eventId}`, {
  method: 'POST',
  headers: { 'x-agent-ping-token': token },
})

await hub.close()
```

## HTTP API

Every route the product serves, in one table. The mutating set is a closed union:
`POST /api/ack/:eventId` is the only control surface, and `POST /api/ingest` only
appends a row.

| Method | Path | What it does |
|--------|------|--------------|
| `GET` | `/api/sessions` | Every session, grouped by repository short name |
| `GET` | `/api/sessions/:sessionId` | One session and its most recent events |
| `GET` | `/api/pending` | The pending set — the same accessor the tray badge and the card read |
| `GET` | `/api/events` | Bounded event history, optionally filtered by `sessionId` |
| `GET` | `/api/metrics` | Four local counters and when each last moved |
| `GET` | `/api/health` | Instance, database, server, dashboard and delivery status |
| `GET` | `/api/stream` | Server-sent change frames: 25 s heartbeat, 5 min replay window |
| `POST` | `/api/ingest` | Append one harness signal (append-only; no token) |
| `POST` | `/api/ack/:eventId` | Mark one block acknowledged (requires the write token) |
| `GET` | `/` | The built dashboard, under a strict content-security-policy |

State directories, the database, the runtime file and the write token are all
owner-only (`0700` directory, `0600` files).

## Configuration

| Variable | Effect |
|----------|--------|
| `AGENT_PING_STATE_DIR` | Redirects all state. The layout inside it is agent-ping's, on every platform. |
| `XDG_CONFIG_HOME` | Where the opencode plugin is installed, as opencode itself resolves it. |

```text
$XDG_STATE_HOME/agent-ping/            # Linux
~/Library/Application Support/agent-ping/   # macOS
%LOCALAPPDATA%\agent-ping/             # Windows

  agent-ping.db        durable log: sessions, events, counters
  hub-runtime.json     the single-instance lock and the live port
  hub-write-token      the per-install write token
```

## Project layout

```text
src/
  domain/      the normalized envelope, the classifier, the pending lifecycle
  storage/     the content-free SQLite schema, the store, retention, counters
  hub/         the loopback server, routes, SSE feed, delivery, security, tray
  notify/      the notifier interface, the class policy, and the self-rendered
               notification surface (host window, card, lifetime)
  plugin/      the opencode adapter, its transport, and the global installer
  dashboard/   the PixiJS 8 prototype and its accessibility modules
  main/        the composition root: the one place collaborators are wired
tests/         one suite per area, run by scripts/run-tests.mjs
scripts/       the build and test entry points
docs/          the requirements, decisions, evidence and build log
```

## Documentation

| Document | What it is |
|----------|------------|
| [docs/IDEA.md](docs/IDEA.md) | The idea of record: the problem, the boundaries, the questions left open on purpose. |
| [docs/PRD.md](docs/PRD.md) | Product requirements, constraints, risks and the requirement-ID matrix. |
| [docs/adr/](docs/adr/) | Twelve architecture decision records: the sidecar boundary, the loopback surface, the content-free guarantee, the loudness policy, the connector interface, the global install, the toolchain, identity, the on-demand surface, visible failure, build ordering, and the self-rendered notification surface. Each record separates whether the decision is in force from whether code exists for it. |
| [docs/features/](docs/features/) | Eight canonical feature documents with requirements, task contracts, testing strategy and acceptance criteria. |
| [docs/PROGRESS.md](docs/PROGRESS.md) | The running build log: completed tasks, remaining work, and every unverified check. |
| [docs/reviews/](docs/reviews/) | Human review records for the completed design and hub gates. |
| [docs/runbooks/](docs/runbooks/) | Operational notes, currently the per-platform notification path. |
| [docs/research/](docs/research/) | Probe evidence, including the live Electron pre-flight the notification surface decision rests on. |
| [docs/artifacts/](docs/artifacts/) | Per-task evidence captured by the build engine. |

> [!NOTE]
> The requirements documents in `docs/` were written before the build and are
> **plans, not reports**. Read an ADR's *Implementation state* line and
> [docs/PROGRESS.md](docs/PROGRESS.md) for what actually exists; where the two
> disagree, those two are current and the requirements document is not.

## Non-goals

Listed so they do not get quietly smuggled back in:

- Multi-user, authentication, or any hosted or remote component.
- Supervising agent processes — spawning, steering or killing sessions.
- Write endpoints for approving permissions, sending prompts or remote control.
- Transcript history or search over conversation content.
- Sound.
- An always-on-top ambient window (deferred to v2, not rejected).
- Harnesses beyond opencode and Copilot CLI.
