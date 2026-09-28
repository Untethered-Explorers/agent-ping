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

  [Status](#status) • [Features](#features) • [Architecture](#architecture) • [Security](#security) • [Getting started](#getting-started) • [HTTP API](#http-api) • [Configuration](#configuration) • [What's next](#whats-next) • [Documentation](#documentation)

</div>

## About

You run several long-lived agent sessions at once, across several repositories, and
you lose track of them. One blocks on a permission decision you never see, and you
find out an hour later. agent-ping watches those sessions and tells you when one is
waiting on you and when one finished real work — quietly enough that you are willing
to leave it running.

It is a **local-only sidecar**: one global install, a loopback port, a notification
card agent-ping draws in its own window, and a tray badge. It never stores what your
agents said, and it never drives them.

Start with the **[user guide](docs/user-guide.md)** for day-to-day use, or the
**[administrator guide](docs/admin-guide.md)** to install, configure and operate it.

## Status

**The build is finished; the human reviews are not.** All 46 tasks in
[`docs/EXECUTION-MANIFEST.json`](docs/EXECUTION-MANIFEST.json) are complete and none
failed, and [`docs/PROGRESS.md`](docs/PROGRESS.md) reports `Status: Complete`.
**There is still no release and nothing has been installed globally** — see
[What's next](#whats-next) for the work that a status file cannot show you.

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
| Tray icon with pending badge | Built, tested. The icon itself has never been seen by a human — a `StatusNotifierItem` is not an X window |
| Self-rendered notification card, replacing the platform notifiers (NT-6 → NT-9) | **Built.** The three platform notifiers and their 56 tests were deleted by NT-8; this is the only delivery path |
| opencode adapter: event translation, transport with visible failure, global plugin install, polling fallback | Built, tested, and **driven against the real `opencode` binary** by OA-5 |
| PixiJS 8 dashboard prototype, DOM mirror, keyboard model | Built, reviewed (`DP-4`) |
| Live dashboard wired to the hub, with acknowledgement, deep-link focus, handoff and history (LD-1 → LD-4) | Built and **driven through a real browser** by LD-4. A human has not used it |
| CLI, npm package, autostart, `doctor` (IO-1 → IO-4) | The package, its `files` allowlist and its prepack guard are done (`IO-1`). `install`, `uninstall`, `status` and `doctor` are built and tested through the command entry point (`IO-2`), including the failure exits. The per-platform autostart units are done (`IO-3`) — a systemd user unit, a launchd user agent and a per-user Startup-folder entry, each idempotent, reversible, owner-only and root-free. `IO-4` drives a **real `systemd --user` manager**: it installs into a temporary state directory, has the live manager enable, start, stop and start the unit again, and asserts a pending item, its history row and the pending count survive that restart unchanged and once, then that `uninstall` removes the plugin and the unit and keeps the database. **Live-verified on Linux only** |
| Polling fallback, live run against a real session (OA-4 → OA-6) | `OA-4` and `OA-5` done — real binary, real permission decision, real hub, breadcrumb when the hub is absent. **`OA-6` deferred**: the human journey was not performed |
| GitHub Copilot CLI ACP spike (CP-1 → CP-2) | Done. `CP-3` **deferred** the adapter, and `CP-4` turned that into a runbook and a test. v1 ships opencode only |

> [!IMPORTANT]
> `package.json` declares the `agent-ping` binary, a `files` allowlist and a `prepack`
> guard ([`scripts/prepack-check.mjs`](scripts/prepack-check.mjs)) that refuses to pack a
> build missing any required artefact — and the build now passes it, so
> `npm install -g .` from a built checkout gives you a working command. It now also
> gives you a login unit: `agent-ping install` writes the plugin, enables autostart
> and starts the hub, and on Linux a real `systemd --user` manager has been shown to
> accept that unit and to start, stop and start it again. What is **not** yet observed
> against real software is a **login** that starts it, on any platform, and a
> **global install** from a registry. [docs/PROGRESS.md](docs/PROGRESS.md) is the
> running build log, including every check that is *not* yet verified against real
> software.

Four things in this repository are **known not to be verified**, and each is recorded
rather than glossed:

1. **Nothing has ever run on macOS or Windows.** Every observation comes from one Linux
   desktop. The notification surface is one code path across all three platforms and only
   the window manager differs, but that is a statement about the code, not an observation.
   The same goes for autostart: the macOS and Windows units are unit-tested against a
   temporary home and have had no live service manager of their own. The same script, run on
   those machines, is what would earn the claim — see
   [`docs/runbooks/io-5-operations-review.md`](docs/runbooks/io-5-operations-review.md) §2a.
2. **No login has been observed anywhere.** `systemctl --user start` is not a log out and
   back in. A reboot or a session restart is the only evidence for that, and it is the
   operations review's to collect.
3. **No human has watched the product work end to end.** Three review gates — `OA-6`,
   `LD-5` and `IO-5` — were closed without the review being performed, and two of them
   (`LD-5`, `IO-5`) were closed before the software they review had been written. Read
   [`docs/reviews/deferred-gates.md`](docs/reviews/deferred-gates.md) before trusting a
   `complete` in the workflow state; it lists exactly what is owed, and the runbooks that
   discharge it.
4. **Half the end-to-end evidence was not retained.** `OA-5` declared only its script and
   test as outputs, so the machine summary of the real-harness run was never committed.

## Features

Three classes, three levels of loudness. The design constraint is that this tool
must never become the thing demanding your attention, so most signals stay inside
the app.

| Class | Trigger | What you get |
|-------|---------|--------------|
| **Needs you** | Session blocked on a permission decision or your input | One card, drawn by agent-ping, that stays until the block is resolved or acknowledged. One card per block — the badge and the history carry persistence, not a repeat timer. |
| **Finished** | Session went idle *after doing real work* | One card that expires on its own. |
| **FYI** | Errors, retries, long tool calls, compaction, token burn | Nothing. In-app only; the dashboard is where you read it. |

The rest of what the product does:

| Capability | What it does |
| --- | --- |
| **Global adapter** | One installed opencode plugin file covers every session in every repository. There is no per-repository setup and no registry to drift. |
| **Notification card agent-ping draws itself** | A small always-on-top window it creates and owns, in a corner that never covers a taskbar or dock. Nothing is handed to your operating system's notification service, so there is no permission to grant and no behaviour that differs between platforms. See [ADR-012](docs/adr/ADR-012-surface-is-rendered-by-agent-ping.md). |
| **Tray badge** | The durable count of what is waiting on you, capped at `99+`, with a click that opens the dashboard focused on the oldest outstanding item. |
| **Live dashboard** | PixiJS 8, served by the hub, fed by the change stream, grouped by repository, with the pending count and connection state as real text. Acknowledgement, `?session=<id>` deep-link focus, a copyable `opencode attach` command and a history panel. |
| **Accessible canvas** | Every painted row has a visually hidden, focusable DOM twin in canvas order, icon-plus-text state, focus held by identity across live updates, and `prefers-reduced-motion` honoured. |
| **A durable, content-free log** | SQLite, owner-only, pruned at 30 days with a 500-event floor per session, storing *that* something happened and never *what was said*. |
| **One control surface** | `POST /api/ack/:eventId` is the only route that can change a record, and the registry refuses a second one at registration time. |
| **Commands** | `install`, `uninstall`, `status`, `doctor` — with `doctor` reporting seven checks, one remedy each, and repairing nothing. |
| **A verification harness** | Scripts that drive the real `opencode` binary, a real desktop, a real browser and a real service manager against the shipped build. |

Three rules that matter more than the class table:

- A session that goes idle having done **nothing** — opened, greeted, closed — fires
  no event at all. That gate lives in the classifier, not in the card.
- **Nothing occupies your screen when nothing is happening.** The host window exists but
  draws nothing unless a card is showing.
- **No sound in v1.** Deferred rather than rejected, and structurally so: there is no
  sound field anywhere on the notification path.

## Tech stack

| Layer | Choice | Version |
| --- | --- | --- |
| Runtime | Node.js + TypeScript (`strict`, `noUncheckedIndexedAccess`) | Node `>=22.12.0`, TypeScript 5.9.3 |
| Host process | Electron (the hub, the tray, the card window, the CLI's hub launch) | 44.4.5 |
| Dashboard | PixiJS 8 on a canvas, with a DOM mirror for accessibility | 8.21.0 |
| Durable store | SQLite through `better-sqlite3`, WAL mode, `STRICT` tables | 13.0.3 |
| HTTP surface | Node's own `node:http` — no web framework | — |
| Build | `tsc` for the Node-hosted sources, Vite for the three documents | Vite 8.3.1 |
| Tests | Vitest for units and integration on real loopback sockets; Playwright for the browser journey | Vitest 5.0.2, Playwright 1.63.0 |
| Lint | ESLint with `typescript-eslint` | ESLint 10.11.0 |

One package, one dependency set, one toolchain
([ADR-007](docs/adr/ADR-007-single-node-typescript-toolchain.md)). The adapter
deliberately has no dependency of its own, because it loads inside a process the user
already runs.

## Architecture

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
local SQLite log, and delivers what the class is worth. The dashboard updates from
the same change feed — so there is no per-repository configuration and no registry
that can drift out of sync with reality.

The boundaries sit where they do for recorded reasons: the sidecar boundary
([ADR-001](docs/adr/ADR-001-sidecar-not-supervisor.md)), the loopback surface and
its single write route ([ADR-002](docs/adr/ADR-002-loopback-only-single-mutating-route.md)),
the content-free guarantee
([ADR-003](docs/adr/ADR-003-never-store-conversation-content.md)), the loudness policy
([ADR-004](docs/adr/ADR-004-three-loudness-classes.md)), and the self-rendered
surface ([ADR-012](docs/adr/ADR-012-surface-is-rendered-by-agent-ping.md)). The
[ADR index](docs/adr/README.md) lists all twelve.

## Security

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
  address is checked before routing; a port collision falls back to another loopback
  port rather than binding wider; the one write route requires a per-install
  token; the dashboard is served under a strict CSP; and no CORS header is ever sent.
- **Never own a session.** It is a sidecar: kill it, restart it, lose the race with
  it — no agent process is affected, and a repository that was never configured keeps
  working.
- **Never fail silently.** If the hub is down, the plugin leaves a breadcrumb in your
  harness's own UI instead of swallowing the event. A delivery that fails is reported
  on health, in the delivery ledger and in the metrics — never as a silent success.

**Secrets.** One: a 32-byte per-install token in `<state dir>/hub-write-token`,
required only by the ack route, in no response and no served asset. There is no API
key, no account and no cloud credential. There is **no TLS**: adding it to a loopback
listener would mean managing a certificate for a socket no other machine can reach,
while the real risk — a cross-origin page on the same machine — is addressed by sending
no CORS header at all. **Do not put agent-ping behind a proxy, a tunnel or a port
mapping**; the [administrator guide](docs/admin-guide.md#identity-secrets-and-tls) says
why, and what to use instead.

**Known hardening cost.** The autostart units and the launcher carry `--no-sandbox` and
`ELECTRON_DISABLE_SANDBOX=1`; the packaged Electron runtime aborts without them, which
was observed on a real Electron process. The Chromium sandbox is therefore disabled for
agent-ping's own card window. The window loads a local document under a strict CSP with
`contextIsolation` on, `nodeIntegration` off and the renderer sandbox in force, and never
a remote origin. The administrator guide's
[security checklist](docs/admin-guide.md#security-and-privacy-checklist) says what to
weigh on a shared machine.

**Reporting a vulnerability.** There is no `SECURITY.md` in this repository yet. Open a
GitHub security advisory on the repository, or contact the maintainer directly (see
[Author](#author)), and prefer a private report over a public issue: a loopback service
that a public report describes is a service everybody can probe.

## Getting started

Requires **Node.js 22.12 or newer**, and a graphical desktop session if you want the
card and the tray icon.

From a checkout:

```bash
npm install          # one package; better-sqlite3 and electron are the runtime dependencies
npm run build        # tsc -> dist/main (hub + CLI), Vite -> dist/dashboard, schema copied
npm test             # on real loopback sockets
npm run typecheck    # tsc --strict, noUncheckedIndexedAccess
npm run lint
npm install -g .     # puts `agent-ping` on PATH
agent-ping install   # plugin, autostart, hub — and says exactly what changed
```

Then read the **[user guide](docs/user-guide.md)**. For an install you are responsible
for — state directory, permissions, backups, autostart per platform — read the
**[administrator guide](docs/admin-guide.md)**.

### The command line

Four subcommands, and one command to run when something is wrong. `doctor` never
repairs anything: it reports, names one remedy per fault, and exits non-zero if any
check failed — a tool that fixes things behind your back is harder to trust than one
that says what is broken.

```bash
agent-ping install      # write the opencode plugin, enable autostart, start the hub,
                        # and print exactly what changed (nothing, on a second run)
agent-ping status       # pending count, last event, hub uptime, active sessions
agent-ping doctor       # the seven checks, one remedy each, non-zero on any failure
agent-ping uninstall    # remove the plugin and autostart and the local log;
                        # the database stays unless you pass --purge
```

| Flag | Meaning |
|------|---------|
| `--purge` | with `uninstall`: also delete the database. It is kept without this flag, so a mistaken uninstall is recoverable |
| `--force` | with `install`: replace a different installed plugin version. Without it a version mismatch is reported and nothing is overwritten |
| `--verbose` | mirror every local log line to standard output |
| `--help` | print the commands and flags this build accepts |

Exit codes are part of the interface: `0` the command did what it was asked, `1` a
check failed or a step could not be completed, `2` the command line named a command or
flag that does not exist.

Point `AGENT_PING_STATE_DIR` at a temporary directory and every path the product writes
resolves there instead, which is how the test suite and the live verification scripts run
without touching your own state.

### Autostart

`agent-ping install` enables a **user-level** login unit: one that belongs to your
account, needs no `sudo`, and is removed completely by `agent-ping uninstall`. Each
platform gets the unit its own convention expects.

| Platform | What `install` writes | How it is enabled |
| --- | --- | --- |
| Linux | `$XDG_CONFIG_HOME/systemd/user/agent-ping.service` (or `~/.config/...`) | a `default.target.wants/agent-ping.service` symlink beside it — exactly what `systemctl --user enable` writes, so `systemctl --user is-enabled agent-ping` agrees afterwards |
| macOS | `~/Library/LaunchAgents/local.agent-ping.hub.plist` | writing the agent is the enablement; launchd loads that directory at login |
| Windows | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\agent-ping.cmd` | Explorer's per-user Startup folder runs it at logon; no registry key, no scheduled task, nothing that needs elevation |

Every unit names **this install's own** Electron runtime and package root as absolute
paths, so a login cannot start a different build off your `PATH`, and carries
`--no-sandbox` plus `ELECTRON_DISABLE_SANDBOX=1` — the packaged application aborts at
startup without them. If you set `AGENT_PING_STATE_DIR`, the unit carries it too, so a
login-started hub writes its runtime file where your commands look for it. Each unit
file is `0600` and each directory agent-ping creates is `0700`.

Enabling twice writes nothing the second time; disabling twice removes nothing and
reports no change. If something that agent-ping did not write already occupies the unit
path, `install` refuses with a remedy instead of replacing it, and `uninstall` leaves it
alone. A unit from an older agent-ping is recognised as ours and rewritten.

To bring it up in the *current* session on Linux rather than waiting for the next login:

```bash
systemctl --user daemon-reload
systemctl --user start agent-ping.service
```

**Verification state:** implemented and unit-tested against a temporary home on all
three platforms (`tests/cli/autostart.test.ts`), and on **Linux** driven against a real
`systemd --user` manager by [`scripts/verify-autostart-linux.mjs`](scripts/verify-autostart-linux.mjs)
— that run has the live manager report the unit `enabled`, stop and start it again, and a
pending item, its history row and the pending count survive that restart unchanged and once
(`docs/reviews/autostart-linux-evidence.json`). **No login has been observed on any
platform**, and macOS and Windows have had no live service manager at all: the same script
run on those machines is what would earn either claim, and
[`docs/runbooks/io-5-operations-review.md`](docs/runbooks/io-5-operations-review.md) §2a says
what a reviewer has to do there.

#### The live autostart and restart run

```bash
npm run build
node scripts/verify-autostart-linux.mjs     # ~5 s; JSON summary on stdout, progress on stderr
```

It installs into a temporary state directory (`AGENT_PING_STATE_DIR`), so the database, the
runtime file, the write token and the local log never touch your own. The unit directory
cannot be made temporary — a live user service manager reads unit files from the environment
*it* was started with and ignores your shell's `XDG_CONFIG_HOME` — so the run writes the
plugin, its install record and the unit where a real manager reads them, then **restores
every one of those paths byte for byte**, including on the failure paths. The summary says
which of them already existed, so a run on a machine that has agent-ping installed puts that
install back rather than deleting it. A missing service manager, a missing build artefact or
a shell whose `XDG_CONFIG_HOME` disagrees with the manager's is a **non-zero exit naming the
remedy**, never a skip; so is a run that executed fewer than the 24 assertions it declares.

### The dashboard prototype

The static prototype renders three mock rows in PixiJS with no hub, no plugin and no
real data. It exists to settle the layout and the accessibility model before any
connector work.

```bash
npx vite                                    # dev server on the prototype page
npm run build:dashboard                     # -> dist/dashboard/index.html
```

### The hub, by hand

`agent-ping install` starts the hub; this is what a development checkout does instead.
`tsc` emits JavaScript only, so the build copies the durable schema beside the emitted
store itself:

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

The dashboard is at the hub's origin, `<http://127.0.0.1:43117/>` by default;
`agent-ping status` prints the one your install bound. State directories, the database,
the runtime file and the write token are all owner-only (`0700` directory, `0600` files).

## Configuration

| Variable | Effect | Default |
|----------|--------|---------|
| `AGENT_PING_STATE_DIR` | Redirects all state. The layout inside it is agent-ping's, on every platform. | the platform state directory |
| `XDG_CONFIG_HOME` | Where the opencode plugin is installed, as opencode itself resolves it. | `$HOME/.config` |
| `XDG_STATE_HOME` | Consulted only when `AGENT_PING_STATE_DIR` is unset, on Linux and other POSIX. | `$HOME/.local/state` |
| `LOCALAPPDATA` | Consulted only when `AGENT_PING_STATE_DIR` is unset, on Windows. | `%USERPROFILE%\AppData\Local` |

```text
$XDG_STATE_HOME/agent-ping/            # Linux
~/Library/Application Support/agent-ping/   # macOS
%LOCALAPPDATA%\agent-ping/             # Windows

  agent-ping.db        durable log: sessions, events, counters
  hub-runtime.json     the single-instance lock and the live port
  hub-write-token      the per-install write token
  agent-ping.log       bounded structured local log; two files, no content
```

There is no configuration file and no per-repository configuration, by decision: a
per-repository registration is a step that can be forgotten, and a forgotten
registration produces an **invisible session**
([ADR-006](docs/adr/ADR-006-global-install-no-per-repo-registry.md)). The full
configuration surface, including the command-line flags, is in the
[administrator guide](docs/admin-guide.md#configuration).

## Project structure

```text
src/
  domain/      the normalized envelope, the classifier, the pending lifecycle
  storage/     the content-free SQLite schema, the store, retention, counters
  hub/         the loopback server, routes, SSE feed, delivery, security, tray
  notify/      the notifier interface, the class policy, and the self-rendered
               notification surface (host window, card, lifetime)
  plugin/      the opencode adapter, its transport, and the global installer
  dashboard/   the PixiJS 8 dashboard, the design prototype and the accessibility modules
  main/        the composition root: the one place collaborators are wired
  cli/         install, uninstall, status, doctor; the state directory and the log
tests/         one suite per area, run by scripts/run-tests.mjs; tests/e2e for Playwright
scripts/       the build, the test runner, the prepack guard and the verify-* probes
docs/          the guides, ADRs, requirements, evidence and build log
```

Tooling and editor configuration live in `package.json`, `tsconfig.json`,
`tsconfig.build.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts` and
`eslint.config.js`.

## How to contribute

There is no `CONTRIBUTING.md` yet, so this is the workflow.

1. **Set up.** `npm install`, then `npm run build && npm test && npm run typecheck &&
   npm run lint`. The four gates are the contract: `tests/tooling/runner-convention.test.ts`
   enforces how tests are run, and `scripts/prepack-check.mjs` refuses to pack a build
   missing a required artefact.
2. **Expectations for a change.** Every change ships with tests, and the suites run
   against real loopback sockets rather than mocks wherever that is possible. Two
   invariants are load-bearing and will fail a change that breaks them: the event
   envelope and the schema are asserted as **exact sets**, so a new field is a decision
   a human has to accept in writing; and the route registry refuses a second mutating
   route at registration time.
3. **Comment the way this repository comments.** Non-obvious reasoning lives at the top
   of the module, in prose that says *why* and names the failure it prevents. Match the
   surrounding style rather than introducing a new one.
4. **Claim only what you observed.** A change that has been tested is "tested"; a change
   that has been run against a real desktop, a real harness or a real login says which,
   and the [runbooks](docs/runbooks/) and
   [deferred-gates register](docs/reviews/deferred-gates.md) are where that distinction is
   kept.
5. **Review.** There is no automated PR process configured; open a pull request. For a
   change that touches the notification path, the loopback boundary, the schema or the
   envelope, expect the corresponding ADR and its tests to be part of the change, not a
   follow-up.

## What's next

**The build is finished and the reviews are not.** This table is what a status file
cannot show you. The full register, with per-gate detail and an issue log, is
[`docs/reviews/deferred-gates.md`](docs/reviews/deferred-gates.md).

| Owed | Why it is not done | What closes it |
| --- | --- | --- |
| **Nobody has watched the product work end to end** | `OA-6` was closed with a deferral. The subject existed and two instruments measured most of it; three claims did not survive being measured | `docs/runbooks/oa-6-opencode-adapter-review.md` — one permission decision, one card, a look at the tray. **About five minutes** |
| **No keyboard or screen-reader user has used the dashboard** | `LD-5` was closed *before* `LD-2`–`LD-4` built it. Acknowledge, deep-link focus, handoff and history are all `LD-3`; the focusable mirror is `LD-2` | `docs/runbooks/ld-5-dashboard-review.md` |
| **Nobody has installed this, or broken it on purpose** | `IO-5` was closed *before* `IO-1`–`IO-4` built it. `src/cli` did not exist when the gate closed | `docs/runbooks/io-5-operations-review.md` |
| **No login has ever started the hub** | `IO-4` drives a real `systemd --user` manager, which is not a log out and back in. True on all three platforms | The same operations review; `systemctl --user start` is not the observation |
| **macOS and Windows have never run** | Every observation in this repository comes from one Linux desktop. The surface is one code path and only the window manager differs — a statement about the code, not an observation | The same scripts and reviews, run on those machines |
| **No human judge has seen the approved dashboard design meet real data** | `DP-4` approved it as a design artefact, against a static prototype with three mock rows. "Does the density hold with eight live sessions" is not a property of the prototype | `docs/runbooks/ld-5-dashboard-review.md` §5 |
| **The first release has not been cut** | `package.json` declares `0.1.0`; there is no tag, no publish, and the release notes are prepared but undated | [`docs/releases/UNRELEASED.md`](docs/releases/UNRELEASED.md) plus the deferred gates above |

**Five of these are gaps in what is known. One is a defect.** A missing macOS run is a
platform this project has not been taken to yet. The other five are missing observations —
about a real login, about a real human, about a real install, and about a real release —
and the runbooks above were written so each can be closed in an afternoon rather than
reconstructed later. The last row of the table above is different in kind: a gate that
reads `complete` in a status file while its review was never performed is a defect in this
repository's own accounting, and
[`docs/reviews/deferred-gates.md`](docs/reviews/deferred-gates.md) is the fix.

## Documentation

| Document | What it is |
|----------|------------|
| [docs/user-guide.md](docs/user-guide.md) | **Day-to-day use:** the three classes, the dashboard, keyboard and screen-reader use, privacy, troubleshooting. |
| [docs/admin-guide.md](docs/admin-guide.md) | **Operating it:** installation, configuration, state and backups, health and monitoring, upgrades, per-platform autostart, hardening. |
| [CHANGELOG.md](CHANGELOG.md) | Change history, in Keep a Changelog form. Everything so far is under `[Unreleased]`. |
| [docs/releases/UNRELEASED.md](docs/releases/UNRELEASED.md) | The release notes prepared for `0.1.0`, undated because no tag exists. |
| [docs/IDEA.md](docs/IDEA.md) | The idea of record: the problem, the boundaries, the questions left open on purpose. |
| [docs/PRD.md](docs/PRD.md) | Product requirements, constraints, risks and the requirement-ID matrix. |
| [docs/adr/](docs/adr/) | Twelve architecture decision records: the sidecar boundary, the loopback surface, the content-free guarantee, the loudness policy, the connector interface, the global install, the toolchain, identity, the on-demand surface, visible failure, build ordering, and the self-rendered notification surface. Each record separates whether the decision is in force from whether code exists for it. |
| [docs/features/](docs/features/) | Eight canonical feature documents with requirements, task contracts, testing strategy and acceptance criteria. |
| [docs/PROGRESS.md](docs/PROGRESS.md) | The running build log: completed tasks, remaining work, and every unverified check. |
| [docs/reviews/](docs/reviews/) | Human review records, the deferred-gate register, and the evidence files behind the README's claims. |
| [docs/runbooks/](docs/runbooks/) | Per-surface operational notes and the procedures the unperformed reviews will use. |
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

## License

[MIT](LICENSE) — © 2026 Doug McCusker. See [`LICENSE`](LICENSE) for the full text.

## Acknowledgements

- **[opencode](https://opencode.ai)** — the harness this product watches, and the only
  one supported in this version. The adapter mirrors its plugin contract and resolves its
  configuration root the way opencode resolves it.
- **[Electron](https://www.electronjs.org/)** and Chromium — the host process, the tray,
  the card window and the renderer channel.
- **[PixiJS](https://pixijs.com/)** — the dashboard's WebGL renderer.
- **[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)** — the synchronous
  SQLite driver behind the durable log.
- **[TypeScript](https://www.typescriptlang.org/)**, **[Vite](https://vite.dev/)**,
  **[Vitest](https://vitest.dev/)**, **[Playwright](https://playwright.dev/)** and
  **[ESLint](https://eslint.org/)** — the toolchain, in the versions pinned in
  [`package.json`](package.json).
- The **[Agent Client Protocol](https://agentclientprotocol.com/)**, whose shape informed
  the connector interface in
  [ADR-005](docs/adr/ADR-005-acp-typed-connector-interface.md), and the GitHub Copilot
  CLI team, whose ACP and hook surfaces were probed rather than guessed at.
- Everyone who filed a review, answered a grill-idea question, or read a draft and said
  the claim was not true. The gates this project owes are owed because that list was
  short.

## Author

**Doug McCusker** — <mcsquirrel@outlook.com> · <https://github.com/Untethered-Explorers/agent-ping>

For bug reports, questions or collaboration, use the repository's issue tracker or the
address above. For a security report, prefer a private GitHub security advisory on the
repository; see [Security](#security).
