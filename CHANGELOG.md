# Changelog

All notable changes to agent-ping are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Which version this is

`package.json` declares `0.1.0`. **No git tag exists and nothing has been published
to a registry**, so there is no released version to name a date for. Everything built
so far therefore sits under `[Unreleased]`, and the first tag moves that section
under its own version heading with the date it was tagged. The release notes for
that release are prepared in advance in
[`docs/releases/UNRELEASED.md`](docs/releases/UNRELEASED.md); the two files change
together at tagging time.

Entries below describe **code that exists in this repository**. A claim about the
outside world — a real desktop, a real login, a real person — is never implied by
an entry here. Every such claim, and its verification state, is in
[`docs/reviews/deferred-gates.md`](docs/reviews/deferred-gates.md),
[`docs/PROGRESS.md`](docs/PROGRESS.md) and
[`docs/runbooks/notification-surface.md`](docs/runbooks/notification-surface.md).

## [Unreleased]

### Added

**The durable log and the event model**

- Content-free SQLite log: `sessions`, `events` and `counters` tables, STRICT, with
  forward-only numbered migrations applied idempotently on every open
  (`src/storage/schema.sql`). The exact column set of every table is asserted by
  `tests/storage/schema.test.ts`, so a content-bearing column fails the suite.
- The normalized event envelope: exactly ten fields, no optional field with no
  writer, no value that grows with what was said (`src/domain/envelope.ts`).
- The classifier: one table that turns a harness signal into one of three
  loudness classes, including the `idle-after-nothing` gate that makes a
  greeting-and-close session fire nothing at all (`src/domain/classify.ts`).
- The pending lifecycle state machine, acknowledgement and harness resolution
  recorded as two independent facts (`src/domain/pending.ts`).
- Retention pruning (30 days, with a 500-event floor per session) and four local
  counters (`src/storage/retention.ts`, `src/storage/counters.ts`).

**The loopback hub**

- A daemon that binds `127.0.0.1` only, refuses any request whose remote address is
  not loopback, and falls back from the preferred port `43117` to the next free
  loopback port rather than ever binding wider (`src/hub/server.ts`).
- Read routes: `GET /api/sessions`, `/api/sessions/:sessionId`, `/api/pending`,
  `/api/events`, `/api/health`, `/api/metrics`.
- The live change stream at `GET /api/stream`: server-sent events with a 25 s
  heartbeat, a 5 min replay window, and a bounded client count
  (`src/hub/sse.ts`).
- `POST /api/ingest`, the single append route, which validates and classifies before
  it stores and rejects an unknown harness (`src/hub/routes/ingest.ts`).
- `POST /api/ack/:eventId`, the only route that can change a record that already
  exists, guarded by a per-install write token in the `x-agent-ping-token` header
  (`src/hub/routes/ack.ts`, `src/hub/security.ts`).
- A route registry that refuses at registration time to accept a second
  `ack-only` or `ingest-append` route, and refuses a route declaring `read-only`
  that is not a `GET`.
- Delivery policy with restart replay, an ordered clean shutdown, and a single
  instance lock published in `hub-runtime.json` (`src/hub/delivery.ts`,
  `src/hub/lifecycle.ts`, `src/hub/runtime-file.ts`).
- `GET /api/metrics`: the four local counters, the desktop section, and delivery
  health.

**The notification surface agent-ping draws itself**

- A card rendered by this product in a `BrowserWindow` it creates and owns:
  frameless, transparent, always-on-top, `skipTaskbar`, non-focusable, created
  hidden so it occupies no screen until a card exists, placed by a pure function of
  the display's **work area** (`src/notify/surface/electron-host.ts`).
- The card document built as its own Vite entry and served by the hub under the
  same strict content-security-policy as the dashboard
  (`src/dashboard/card.html`, `tests/dashboard/card-document.test.ts`).
- A renderer channel that leaves `contextIsolation` on, `nodeIntegration` off and the
  renderer sandbox in force, carrying exactly one card model
  (`src/notify/surface/channel.ts`).
- The class policy as the single class table in the product: `needs-you` is shown
  once and never re-armed, `finished` expires on a fixed interval, `fyi` is
  **refused** and recorded as a suppression rather than a delivery
  (`src/notify/policy.ts`).
- Card dismissal when the block ends, from either end: the developer acknowledging
  it or the harness resolving it (`src/notify/surface/dismissal.ts`,
  `src/hub/routes/ack.ts`).
- A tray icon carrying the durable pending count, capped at `99+`
  (`src/hub/tray.ts`, `src/tray/badge.ts`).
- No sound, on any class, by construction: there is no sound field on the
  notification path.

**The opencode adapter**

- A globally installed opencode plugin that translates harness events into the
  normalized envelope and posts them to the hub, with no dependency of its own so
  it loads inside the harness process (`src/plugin/opencode/`).
- A transport that reports a failed delivery as a breadcrumb in the harness's own
  log rather than swallowing it (`src/plugin/transport/`).
- An idempotent global installer that resolves opencode's config root the way
  opencode does, inlines the adapter's modules into one self-contained file,
  verifies that file loads in a fresh Node process before publishing it, and
  records the version and a `sha256` of the emitted bytes
  (`src/plugin/install/global-plugin.ts`).
- A polling fallback for non-pushing sessions, sharing dedupe keys with the pushing
  path so the two can run at once (`src/plugin/opencode/poll-fallback.ts`).

**The dashboard**

- A PixiJS 8 dashboard served at `/`, fed by the change stream, grouped by
  repository short name, with the pending count and the connection state as real
  DOM text rather than painted pixels (`src/dashboard/main.ts`).
- A visually hidden, focusable DOM mirror giving every painted row a keyboard and
  screen-reader twin in canvas order, with icon-plus-text state encoding and
  identity-keyed focus retention across live updates (`src/dashboard/a11y/`).
- Acknowledgement from the page, `?session=<id>` deep-link focus that survives
  updates, a copyable handoff command shown as text, and a history panel
  (`src/dashboard/live/`).
- A static three-row design prototype with no hub behind it, which existed to settle
  the layout and the accessibility model before any connector work
  (`src/dashboard/prototype/`).

**Installation and operations**

- The `agent-ping` command: `install`, `uninstall`, `status`, `doctor`, with
  `--purge`, `--force`, `--verbose` and `--help`, and exit codes `0`, `1` and `2` as
  the interface (`src/cli/`).
- Per-platform user-level autostart units — a systemd user unit, a launchd user
  agent and a per-user Startup-folder entry — each idempotent, reversible, owner-only
  and root-free, and each naming this install's own Electron runtime as an absolute
  path (`src/cli/autostart/`).
- `AGENT_PING_STATE_DIR` as the one override through which every path the product
  writes resolves, and `XDG_CONFIG_HOME` for the plugin directory, resolved the way
  opencode resolves it.
- A package with a `files` allowlist and a `prepack` guard that refuses to pack a
  build missing any required artefact (`scripts/prepack-check.mjs`).
- A bounded local log, rotated at 2 MiB across two files, with `--verbose` mirroring
  it to standard output.

**Evidence scripts**

- `scripts/verify-opencode-live.mjs` — the real `opencode` binary reaching a real
  permission decision against a real hub.
- `scripts/verify-notification-surface.mjs` — the notification surface against the
  shipped build on a real Linux desktop.
- `scripts/verify-dashboard-e2e.mjs` and `tests/e2e/dashboard.spec.ts` — the dashboard
  journey in a real browser.
- `scripts/verify-autostart-linux.mjs` — a real `systemd --user` manager enabling,
  starting, stopping and starting the unit again, with a pending item surviving the
  restart.
- `scripts/probe-copilot-acp.mjs` and `scripts/probe-copilot-hooks.mjs` — the
  GitHub Copilot CLI surface probe that produced the deferral record.

**Documentation**

- Twelve architecture decision records and their index (`docs/adr/`).
- A product idea of record and a PRD with a requirement-ID matrix (`docs/IDEA.md`,
  `docs/PRD.md`).
- Eight canonical feature documents (`docs/features/`).
- Five operational runbooks (`docs/runbooks/`), a review register, probe evidence and
  a per-task build log with every unverified check enumerated
  (`docs/PROGRESS.md`).
- This changelog, the user guide, the administrator guide and the release notes.

### Changed

- The notification path is no longer delivered through the operating system's
  notification service. agent-ping draws and owns the card itself
  ([ADR-012](docs/adr/ADR-012-surface-is-rendered-by-agent-ping.md)), which amends the
  delivery clause of [ADR-009](docs/adr/ADR-009-on-demand-surface-no-always-on-window.md)
  and the per-platform implementation strategy of
  [ADR-004](docs/adr/ADR-004-three-loudness-classes.md). The three classes, the
  no-repeat-timer rule and the no-sound rule are unchanged.
- The needs-you class is described as `until-resolved`, a fact about a card this
  product draws, rather than as a hint requested of a notification server.

### Removed

- The three platform notifiers (libnotify/notify-send, osascript, and the PowerShell
  WinRT toast), the notifier registry and their 56 tests. The card is the only
  delivery path. `tests/notify/policy.test.ts` sweeps `src/notify` to keep it that way.

### Security

- The write surface is a closed union: `POST /api/ack/:eventId` is the only route
  that can change an existing record, it requires the per-install write token, and
  the registry refuses a second one at registration time.
- The bind is `127.0.0.1` and the socket's remote address is checked before routing.
  A collision falls back to another loopback port; it never binds wider.
- The dashboard and the card document are served under a strict
  content-security-policy, and no CORS header is ever sent.
- State directories, the database, the runtime file, the write token and the
  autostart units are created owner-only (`0700` directories, `0600` files), and
  `doctor` reports rather than repairs a state directory that is wider than that.
- The event envelope and the schema cannot hold conversation content, and the
  assertions that keep it that way are exact-set rather than denylist.
- The autostart units carry `--no-sandbox` and `ELECTRON_DISABLE_SANDBOX=1`, which
  the packaged Electron runtime requires to start at all. This weakens the Chromium
  sandbox for agent-ping's own window. It is load-bearing, was observed as
  load-bearing on a real Electron process, and is called out in the administrator
  guide rather than left for a reader to find.

### Known limitations at this version

Recorded rather than glossed, with the register that owns each one in
[`docs/reviews/deferred-gates.md`](docs/reviews/deferred-gates.md):

- No observation of any kind on macOS or Windows. Every live result in this
  repository comes from one Linux desktop.
- No login has ever been observed starting the hub, on any platform.
- Three human review gates (`OA-6`, `LD-5`, `IO-5`) were closed by attestation rather
  than by review, and two of them were closed before the software they review existed.
- Only the opencode adapter is built. The GitHub Copilot CLI adapter was deferred at
  its gate on 2026-09-27 against Copilot CLI 1.0.88.

[Unreleased]: https://github.com/Untethered-Explorers/agent-ping/commits/main
