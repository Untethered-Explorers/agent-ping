# Administrator Guide

For whoever installs agent-ping, keeps it running, and has to answer for it: the
prerequisites, the installation procedure on each platform, every configuration
knob, what is on disk and how to back it up, how to tell whether it is healthy, and
what to do when it is not.

For day-to-day use, see the [user guide](user-guide.md). For the durable decisions
behind these boundaries, see the [ADR index](adr/README.md). For what has *not* been
verified against real software, see
[`docs/reviews/deferred-gates.md`](reviews/deferred-gates.md) — read it before
treating any `complete` in a status file as a pass.

## Responsibilities and architecture

agent-ping is a **local-only sidecar**. One install, one user, one machine, one
loopback port. It is not a service, not a shared resource, and not a multi-user
product: there is no authentication because there is no second principal, and no
hosted component because there is nothing off the machine.

Its job is to notice when a coding-agent session is blocked on you, or has finished
real work, and to tell you — without becoming the thing demanding your attention.
It never stores what your agents said and it never drives them
([ADR-003](adr/ADR-003-never-store-conversation-content.md),
[ADR-001](adr/ADR-001-sidecar-not-supervisor.md)).

```text
 opencode session
       │  one global plugin file, every session, every repo
       ▼
 ┌───────────────────────────────────────────────┐
 │  hub · 127.0.0.1 · 6 reads, 1 stream, 2 writes│
 │  classify → store → deliver                   │
 └───┬──────────────┬──────────────┬─────────────┘
     ▼              ▼              ▼
  SQLite log    card surface     tray badge
  state only    needs-you /     durable pending
                finished         count
     │
     ▼
  PixiJS 8 dashboard · fed by the change stream
```

The operator-facing consequence of that diagram:

| Boundary | What it means for you |
| --- | --- |
| The hub is the only listener | exactly one port, on `127.0.0.1`, and nothing of this product is reachable from another machine |
| The adapter is a globally installed file | removing it is the whole uninstall of the reporting side; there is no per-repository state to clean up |
| The state directory is the only writable surface | back it up, and it is the only thing to back up |
| The autostart unit is **user-level** | no `sudo`, no system unit, no machine-wide change; it runs as the account that installed it |

## Prerequisites

| Requirement | Value | Enforced by |
| --- | --- | --- |
| Node.js | `>=22.12.0` | `package.json` `engines.node`, `MINIMUM_NODE_VERSION` in `src/cli/doctor.ts` |
| Operating system | Linux, macOS or Windows | `package.json` `os` |
| Desktop session | a graphical session with a status area (tray) | Electron; `doctor`'s `notification surface` and `tray` rows |
| opencode | any version that loads a global plugin from its config root | opencode itself; resolved through `XDG_CONFIG_HOME` the same way opencode resolves it |
| Disk | a few MiB: one SQLite file, two log files | — |
| Privileges | **none** | every path agent-ping writes is user-owned |

A headless machine is a supported way to *run* the hub — the API answers and the log
accumulates — but it is not a way to *use* the product: no card, no tray icon.

**The honest scope of that table:** everything in it has been satisfied on Linux only.
macOS and Windows are supported by the manifest and by unit-tested code paths and
have never been run. See [Known gaps](#known-gaps).

## Installation

### From a checkout

```bash
npm install
npm run build          # tsc -> dist/main (hub + CLI); Vite -> dist/dashboard
npm install -g .
agent-ping install
agent-ping status
agent-ping doctor
```

`npm run build` is not optional: `tsc` emits JavaScript only, so the build copies the
durable schema beside the emitted store. A checkout without a build has no `bin` to
install.

`agent-ping install` performs, in order, and prints one row per step saying what it
changed or what it checked and left alone:

1. **The opencode plugin.** Written to `<opencode config>/plugins/agent-ping.ts` — one
   self-contained file, with the adapter's modules inlined, verified to load and
   translate an event in a fresh Node process *before* it is published, and recorded
   with the product version and a `sha256` of the emitted bytes.
2. **The autostart unit** for your platform, enabled (see below).
3. **The hub**, launched the way the unit will launch it, then *waited for*. What the
   command reports is the health read, not the spawned pid: a hub that never
   publishes a port is a failure with a remedy.

A second run changes nothing and says so. If a **different** agent-ping version is
already installed, `install` refuses, names both versions, and gives you two ways
forward: `agent-ping uninstall` first, or `agent-ping install --force` once you have
decided. Nothing is replaced silently.

### Autostart units, per platform

| Platform | What is written | How it is enabled | Live-manager evidence |
| --- | --- | --- | --- |
| Linux | `$XDG_CONFIG_HOME/systemd/user/agent-ping.service` (or `~/.config/systemd/user/…`) | a `default.target.wants/agent-ping.service` symlink beside it — exactly what `systemctl --user enable` writes | **Yes, on Linux only.** A real `systemd --user` manager has accepted the unit, reported it enabled, stopped and started it, and a pending item survived that restart unchanged and once |
| macOS | `~/Library/LaunchAgents/local.agent-ping.hub.plist` | writing the agent *is* the enablement; launchd loads that directory at login | **None.** Unit-tested bytes and paths only |
| Windows | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\agent-ping.cmd` | Explorer runs the per-user Startup folder at logon; no registry key, no scheduled task, nothing elevated | **None.** Unit-tested bytes and paths only |

Properties of every unit, on every platform:

- it names **this install's own** Electron runtime and package root as **absolute
  paths**, so a login cannot start a different build found on `PATH`;
- it carries `--no-sandbox` and `ELECTRON_DISABLE_SANDBOX=1` — see
  [Security](#security-and-privacy-checklist) for what that costs;
- it carries `AGENT_PING_STATE_DIR` **only if you set it**, so a login-started hub
  writes its runtime file where your commands look for it;
- the unit file is `0600` and every directory agent-ping creates is `0700`.

Enabling twice writes nothing the second time; disabling twice removes nothing and
reports no change. If a file agent-ping did not write already occupies the unit path,
`install` refuses with a remedy instead of replacing it, and `uninstall` leaves it
alone. A unit from an older agent-ping is recognised as ours and rewritten.

To start it now, rather than at the next login:

```bash
systemctl --user daemon-reload
systemctl --user start agent-ping.service
```

**A login has never been observed, on any platform.** `systemctl --user start` is not
a log out and back in, and the operations review that would collect that evidence is
listed in [`docs/reviews/deferred-gates.md`](reviews/deferred-gates.md).

### Uninstalling

```bash
agent-ping uninstall            # plugin, autostart unit, local log. Database kept.
agent-ping uninstall --purge    # the database too
```

The database is kept by default because it is the only thing in the state directory
that cannot be reconstructed, and a mistaken uninstall should be recoverable. Every
path removed is named in the output. The runtime file and the write token belong to a
live hub, so if a hub is answering they are kept — and the output says which and why —
because deleting a running hub's pointer would leave every adapter posting to a port
nobody is serving.

## Configuration

### Environment variables

| Variable | Effect | Default |
| --- | --- | --- |
| `AGENT_PING_STATE_DIR` | Redirects **every** path the product writes: the database, the runtime file, the write token and the local log. A leading `~` is expanded. | platform state directory, below |
| `XDG_CONFIG_HOME` | Where the opencode plugin directory is found — resolved the way opencode resolves it, not the way agent-ping would | `$HOME/.config` |
| `XDG_STATE_HOME` | Only consulted when `AGENT_PING_STATE_DIR` is unset (Linux and other POSIX) | `$HOME/.local/state` |
| `LOCALAPPDATA` | Only consulted when `AGENT_PING_STATE_DIR` is unset (Windows) | `%USERPROFILE%\AppData\Local` |
| `ELECTRON_DISABLE_SANDBOX` | Set to `1` by every unit agent-ping writes. See [Security](#security-and-privacy-checklist) | unset by you; required by the runtime |

State directory defaults:

```text
Linux    $XDG_STATE_HOME/agent-ping/  (or ~/.local/state/agent-ping/)
macOS    ~/Library/Application Support/agent-ping/
Windows  %LOCALAPPDATA%\agent-ping\
```

`AGENT_PING_STATE_DIR` is the one door: set it and the test suite, the verification
scripts and a second side-by-side install all resolve there instead. Note that
`AGENT_PING_STATE_DIR` set in your *shell* is not inherited by a login-started hub
unless the unit carries it — which it does, but only if the variable was set at the
time `agent-ping install` wrote the unit. Re-run `install` after changing it.

### Command-line flags

| Flag | Command | Meaning |
| --- | --- | --- |
| `--purge` | `uninstall` | Also delete the database. It is kept without this flag |
| `--force` | `install` | Replace a *different* installed plugin version. Without it, a mismatch is reported and nothing is overwritten |
| `--verbose` | any | Mirror every local-log line to standard output |
| `--help` | any | Print the command list and the flags |

A flag is refused on a command it does not belong to, rather than ignored: `--purge`
on `status` is a typo, and silently running `status` would report success for
something that did not happen.

**Exit codes are part of the interface.** `0` the command did what it was asked, `1`
a check failed or a step could not be completed, `2` the command line named a command
or flag that does not exist. `status` deliberately exits `0` when the hub is down —
a stopped sidecar is a supported state, and `doctor` is the command whose exit code
means "something is wrong".

### There is no configuration file

There is no `.agent-pingrc`, no settings file, and no per-repository configuration.
That is a decision, not an omission: a per-repository registration is a step that
can be forgotten, and a forgotten registration produces an **invisible session** —
the exact failure the product exists to prevent
([ADR-006](adr/ADR-006-global-install-no-per-repo-registry.md),
[ADR-008](adr/ADR-008-repository-short-name-identity.md)).

## Identity, secrets, and TLS

**Identity.** There is none, and that is structural rather than aspirational. The hub
binds `127.0.0.1` and refuses any request whose remote address is not loopback. A
proxy, a container port mapping or a forwarded socket can deliver a request that
*reached* loopback from somewhere else, so the check that matters reads the socket
before routing. There is exactly one principal: the user on the machine.

**Secrets.** One: the per-install write token.

| Property | Value |
| --- | --- |
| File | `<state dir>/hub-write-token`, `0600` |
| Size | 32 bytes, generated once per state directory |
| Header | `x-agent-ping-token` on `POST /api/ack/:eventId` only |
| Exposure | It is in **no response and no served asset**, deliberately. A page served without a token has no control, and says so |
| Rotation | Delete the file and restart the hub; a new token is generated |

Nothing else is secret. There is no API key, no account, no cloud credential.

**TLS: there is none, and there will not be.** Adding TLS to a loopback listener would
mean managing a certificate for a socket no other machine can reach, while the real
risk — a cross-origin page on the same machine talking to the hub — is addressed by
sending **no CORS header at all** and by serving the dashboard under a strict
content-security-policy.

> **Do not put agent-ping behind a reverse proxy, an SSH tunnel, a container port
> mapping or any other forwarder.** Every one of them breaks the boundary the product
> is built on, and the token on the single write route is the only thing between a
> forwarded socket and an unauthenticated acknowledgement. If you need the dashboard
> from another machine, use a display forwarder or a remote desktop session, which
> keeps the socket on the machine.

The one request that mutates stored state and needs no token is
`POST /api/ingest`. That is not a hole: it appends a row to **your own** local log and
reaches no session, no agent and no harness. The registry refuses at registration
time to accept a second route declaring `ack-only` or `ingest-append`
([ADR-002](adr/ADR-002-loopback-only-single-mutating-route.md)).

## Storage and backups

Everything on disk, in the state directory:

| Entry | What it is | Size behaviour |
| --- | --- | --- |
| `agent-ping.db` | the durable log: `sessions`, `events`, `counters`, and the migration record | pruned at **30 days**, with a **floor of 500 events per session** so a busy session is not emptied from under you |
| `agent-ping.db-wal`, `agent-ping.db-shm` | SQLite's own sidecars | created by SQLite with your umask, inside the `0700` state directory |
| `hub-runtime.json` | the single-instance lock and the live port | rewritten each start |
| `hub-write-token` | the write token | fixed 32 bytes |
| `agent-ping.log`, `agent-ping.log.1` | a bounded structured local log, carrying **no content** | rotates at **2 MiB**, two files kept |

The state directory is `0700`; the files are `0600`. `doctor` **reports** a state
directory that is wider than `0700` rather than silently tightening it — a tool that
changes things behind your back is harder to trust.

**Backups.** agent-ping has no backup command, and inventing one is out of scope for
this version. Because SQLite is in WAL mode, copying a live database can capture a
torn moment. The safe procedure is:

1. Quit agent-ping from the tray menu, or `systemctl --user stop agent-ping.service`.
2. Copy the whole state directory, `-wal` and `-shm` sidecars included.
3. Restart agent-ping, or let the login unit do it.

If you would rather not stop it, use SQLite's own backup from another shell, with the
database path resolved for your platform (the `database` row of `agent-ping doctor`
prints it, including the state directory it used):

```bash
sqlite3 /path/to/state/dir/agent-ping.db ".backup '/path/to/agent-ping-backup.db'"
```

Restoring is a file copy with agent-ping stopped: put the file back as
`agent-ping.db`, and if you saved sidecars, put those back too. An unreadable
database is not a support incident — the store deletes and recreates it from the
schema on open, and you lose history, not function.

**What a backup contains: event metadata only.** Session identifiers, repository
names and paths, event class and subtype, the harness's own event name, two
timestamps, and acknowledgement and resolution state. There is no conversation
content in it to leak, because there is none to have leaked.

## Health checks and monitoring

### `agent-ping doctor`

Seven checks, one remedy per failure, non-zero exit if any failed. **It repairs
nothing** — everything it says, it observed.

| Check | What it answers |
| --- | --- |
| `runtime` | is this Node new enough (`22.12.0`) |
| `database` | where the log is, whether the machine can write it, and whether the directory is owner-only |
| `port` | is the port this install published serving *this* hub — and if not, whether the preferred `43117` is taken and by what |
| `plugin` | is the opencode adapter installed, and at *this* version |
| `autostart` | is the user-level unit written, and is it enabled |
| `notification surface` | can a card window be created here: `available`, `window-refused`, or not mounted |
| `tray` | is the badge icon on this desktop: `mounted`, `closed`, or `unavailable` |

Two of these are worth reading carefully rather than pattern-matching:

- **`notification surface: window-refused` is not a missing Electron.** The runtime is
  present and the desktop refused the window. The remedy names the Chromium launch
  policy first, because that is the one thing measured to stop a card on this
  platform, and then the compositor. Reinstalling Electron in response to this row
  reinstalls something that is already installed.
- **`port` reports a collision rather than hiding it.** The hub prefers `43117` and
  falls back to the next free loopback port; `status` prints the origin it actually
  bound, and the failed `port` row prints the command that shows the holder.

### The HTTP surface

Every route the product serves. The mutating set is a closed union: `ack` is the only
control surface, and `ingest` only appends.

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| `GET` | `/` | the built dashboard, under a strict CSP | — |
| `GET` | `/api/sessions` | every session, grouped by repository short name | — |
| `GET` | `/api/sessions/:sessionId` | one session and its most recent events | — |
| `GET` | `/api/pending` | the pending set — the same accessor the badge and the card read | — |
| `GET` | `/api/events` | bounded event history, optionally filtered by `sessionId` | — |
| `GET` | `/api/health` | instance, database, server, dashboard, delivery and desktop status | — |
| `GET` | `/api/metrics` | four local counters and when each last moved | — |
| `GET` | `/api/stream` | server-sent changes: 25 s heartbeat, 5 min replay window, bounded clients | — |
| `POST` | `/api/ingest` | append one harness signal | — |
| `POST` | `/api/ack/:eventId` | mark one block acknowledged | **required** |

Port: preferred `43117`, falling back to the next free loopback port; the live port
is published in `hub-runtime.json` and printed by `agent-ping status`.

### The four local counters

`GET /api/metrics` serves exactly four, each a name, a count and when it last moved:
`dashboard_opens`, `toast_deliveries`, `deep_link_opens`,
`pending_count_snapshots`. They are numbers, stored as numbers — a counter cannot
carry content even in principle — and they are diagnostics: a failing counter write
is reported and never decides anything else. There is no export, and no remote
metrics endpoint; read them over the loopback interface or not at all.

### Live verification scripts

These drive real software, are the evidence behind the README's claims, and are not
part of the install. Each prints a machine-readable summary and exits non-zero on a
failed assertion; none of them can report success without having exercised something.

```bash
npm run build
node scripts/verify-autostart-linux.mjs         # Linux: real systemd --user manager
node scripts/verify-notification-surface.mjs   # real Linux desktop, the shipped build
node scripts/verify-dashboard-e2e.mjs           # the dashboard journey in a real browser
node scripts/verify-opencode-live.mjs           # the real opencode binary
npm run test:e2e                                # the Playwright suite
```

`verify-autostart-linux.mjs` installs into a temporary state directory, writes the
unit where a live user service manager actually reads it, and then **restores every
one of those paths byte for byte** — including on its failure paths. It needs a
graphical session: the unit's `ExecStart` is the packaged Electron runtime, so a
machine with no `DISPLAY` is a fault of the environment, not a skip.

## Upgrades and rollback

**There is no previous release.** This is the first version, so there is no upgrade
path to document and no published version to roll back to.

The rules that will govern a later one:

- The durable log is **forward-only** migrated, numbered from 1 with no gaps, and
  applied idempotently on every open. A shipped migration is never edited; a new
  `-- migration: N` block is appended.
- An unreadable database is deleted and recreated from the schema, so a migration
  failure costs history, not function.
- The plugin is version-checked in both directions. `install` refuses to overwrite a
  different installed version; `doctor` reports a mismatch as a failure. After
  upgrading agent-ping, run `agent-ping install` again so the plugin matches the new
  build — otherwise a card you are debugging came from the wrong build.

**Rollback, once a release exists.** There is no schema downgrade, so rolling back
means restoring the backup from [Storage and backups](#storage-and-backups) with
agent-ping stopped. Re-run `agent-ping install` after rolling back, because the
installed plugin records the version that wrote it.

## Troubleshooting

| Symptom | Where the answer is | Note |
| --- | --- | --- |
| `agent-ping` is not on `PATH` | `which agent-ping` | the build must exist before `npm install -g .`; check `dist/main/cli/index.js` |
| `doctor` says the plugin is a different version | the `plugin` row | `agent-ping install --force`, or uninstall then install |
| `doctor` says `port` failed | the row itself | it prints the command that shows the holder of `43117` on your platform |
| `doctor` says the surface is `window-refused` | the row's remedy | the runtime is present; check the launch policy, then the compositor. **Do not reinstall Electron** |
| `doctor` says the tray is `unavailable` | the row's remedy | the session has no status area (a `StatusNotifierItem` host on Linux) |
| `doctor` says the surface and tray are `unknown` | the `port` row | with no hub running there is no window or tray to judge; that is what the `port` row is for |
| No events arriving | `status`, then the `plugin` row | the plugin's own breadcrumb line appears in opencode's output when a delivery fails |
| A card did not appear for a block | the dashboard's history panel | `fyi` never produces a card, and a session that did nothing produces no event at all |
| The dashboard shows `stale` or `disconnected` | — | the page reconnects up to five times with a doubling backoff capped at 8 s, then says it gave up; the pending count is qualified as *last known* while that is true |
| The port changed after a restart | `status` | the previous port was taken; the fallback is deliberate and the live port is always printed |
| The state directory is wider than `0700` | the `database` row | `doctor` reports it and names the `chmod`; it does not fix it for you |

## Security and privacy checklist

Work through this before letting agent-ping run unattended on a machine you care
about. Each line is a fact the code enforces, with where it is enforced.

- [ ] **The bind is `127.0.0.1`, and the socket's remote address is checked before
      routing.** Binding alone is not enough: a forwarded socket can reach loopback
      from elsewhere. `src/hub/server.ts`, `src/hub/security.ts`.
- [ ] **Nothing forwards it.** No reverse proxy, no tunnel, no container port
      mapping. See [Identity, secrets, and TLS](#identity-secrets-and-tls).
- [ ] **Exactly one route can change an existing record**, it needs the per-install
      token, and the registry refuses a second one at registration time.
- [ ] **The write token is in no response and no served asset.** A dashboard served
      without a token has an acknowledgement control that is disabled and says why.
- [ ] **No CORS header is ever sent**, and the dashboard is served under a strict
      content-security-policy. A read-only daemon still hands a cross-origin page a
      channel to it.
- [ ] **State is owner-only**: `0700` directories, `0600` files, for the state
      directory, database, runtime file, write token and autostart units.
- [ ] **No conversation content can be stored**, by exact-set assertions on the
      envelope and on every table's column set — a `snippet` or `body` field fails
      the suite rather than shipping.
- [ ] **No telemetry, no update check, no crash report.** The only outbound call any
      command makes is a `GET` to the loopback hub.
- [ ] **Delivery failure is never silent.** A failed delivery becomes a breadcrumb in
      the harness's own UI, a row in the delivery ledger, and a failed status on
      health.
- [ ] **The autostart units carry `--no-sandbox` and `ELECTRON_DISABLE_SANDBOX=1`.**
      This is load-bearing — the packaged Electron runtime aborts at startup without
      them, which was observed on a real Electron process — and it means the Chromium
      sandbox is disabled for agent-ping's own window. The window is agent-ping's
      own card document under a strict CSP, with `contextIsolation` on,
      `nodeIntegration` off and the renderer sandbox in force, and it loads no remote
      origin. On a shared or multi-tenant machine, weigh that against what this window
      can reach.
- [ ] **The plugin file is not a secret** and needs no protection, but it *is* code
      that runs inside every opencode session: it is generated from this package,
      `0600`, in opencode's own config directory.
- [ ] **A vulnerability report goes to a private channel.** There is no `SECURITY.md`
      yet: open a GitHub security advisory on the repository, or contact the
      maintainer listed in the [README](../README.md#author). A public issue on a
      loopback service tells everyone how to probe it.

## Known gaps

Administration-grade confidence exists on **one Linux desktop**. Everything below is
a gap in what has been observed, and the register that owns each one — with the
procedure that closes it — is
[`docs/reviews/deferred-gates.md`](reviews/deferred-gates.md).

- macOS and Windows have never run agent-ping. Their autostart units are
  unit-tested bytes and paths, and have had no live service manager.
- No login has ever been observed starting the hub, on any platform.
- No human has installed this, broken it on purpose, or uninstalled it. The
  operations review that would is written and unperformed:
  [`docs/runbooks/io-5-operations-review.md`](runbooks/io-5-operations-review.md).
- Half the end-to-end evidence was not retained: the real-harness run's machine
  summary was never committed.
- No backup, restore, upgrade or rollback procedure has been exercised, because there
  has been nothing to back up, upgrade or roll back. The procedures above are derived
  from the code and are marked as untested for that reason.

## Recovery and support

1. **Diagnose first.** `agent-ping doctor` names the state directory, the port, the
   plugin, and one remedy per fault, and exits non-zero if any check failed. It
   repairs nothing, on purpose.
2. **Read the local log.** `<state dir>/agent-ping.log`, or `agent-ping --verbose
   <command>` to mirror it. It is structured and carries no content.
3. **Read the health surface.** `GET /api/health` on the origin `agent-ping status`
   prints — by default `curl -s http://127.0.0.1:43117/api/health` — reports the
   desktop and delivery state directly. Anything that could not happen is named there
   rather than swallowed.
4. **Worst case, and it is cheap.** `agent-ping uninstall --purge` removes the plugin,
   the unit, the log and the database. Nothing outside the state directory and
   opencode's plugin directory is touched, and nothing in the log was worth
   re-acquiring: it holds no conversation content.
5. **Then ask.** Include the `doctor` output, the platform, and whether the problem
   is reproducible from a clean install. The repository's issue tracker is linked from
   the [README](../README.md#author).

## Related documents

| Document | What it is |
| --- | --- |
| [User guide](user-guide.md) | Day-to-day use |
| [ADR index](adr/README.md) | The twelve durable decisions and their implementation state |
| [docs/PROGRESS.md](PROGRESS.md) | The build log, with every unverified check enumerated |
| [docs/reviews/deferred-gates.md](reviews/deferred-gates.md) | What this project owes |
| [docs/runbooks/notification-surface.md](runbooks/notification-surface.md) | The notification surface's evidence table |
| [docs/runbooks/io-5-operations-review.md](runbooks/io-5-operations-review.md) | The unperformed install-and-break-it review |
| [docs/runbooks/copilot-support.md](runbooks/copilot-support.md) | Why Copilot CLI is not supported in this version |
| [CHANGELOG.md](../CHANGELOG.md) | Change history |
