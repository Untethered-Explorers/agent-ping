# agent-ping 0.1.0 — unreleased candidate

**Status:** not tagged, not published. `package.json` declares `0.1.0`; no git tag
exists and nothing has been installed globally from a registry. The release date
below is the date the tag is cut, not a date something already happened.

This file is the release-notes text kept in step with the code. At tagging time it
becomes `docs/releases/0.1.0.md` with the date filled in, and its `[Unreleased]`
contents move to a `## 0.1.0` heading in [`CHANGELOG.md`](../../CHANGELOG.md).

## Summary

agent-ping is a local-only sidecar that tells a developer when one of their coding
agent sessions is blocked on them, and when one finished real work. One global
install, one loopback port, a notification card agent-ping draws in its own window,
and a tray badge. It never stores what the agents said, and it never drives them.

This is the first version, and it is opencode-only.

## Highlights

- **Three classes, three levels of loudness.** A session blocked on you gets one
  card that stays until the block is resolved or you acknowledge it. A session that
  went idle after doing real work gets one card that expires. Everything else —
  errors, retries, long tool calls, compaction, token burn — stays in the app, and
  the dashboard is where you read it. A session that goes idle having done *nothing*
  fires no event at all.
- **A notification surface agent-ping renders itself.** No operating system
  notification service is involved: there is no permission to grant, no focus-assist
  to fight, and no platform-specific behaviour to discover
  ([ADR-012](../adr/ADR-012-surface-is-rendered-by-agent-ping.md)).
- **A content-free durable log.** The event envelope has exactly ten fields, the
  schema has no content-bearing column, and both are asserted as an *exact set*
  rather than a denylist — so a well-meant `snippet` field fails the test suite
  instead of shipping ([ADR-003](../adr/ADR-003-never-store-conversation-content.md)).
- **One control surface.** `POST /api/ack/:eventId` is the only route that can change
  an existing record, it needs a per-install write token, and the route registry
  refuses to register a second one
  ([ADR-002](../adr/ADR-002-loopback-only-single-mutating-route.md)).
- **A dashboard you can drive from the keyboard.** A PixiJS 8 canvas paired with a
  visually hidden, focusable DOM mirror, so every painted row is reachable and
  legible to a screen reader in canvas order, with focus held by identity across
  live updates.
- **Delivery failure is never silent.** If the hub is down the plugin leaves a
  breadcrumb in the harness's own UI, and a failed delivery is visible on health,
  in the delivery ledger and in the metrics
  ([ADR-010](../adr/ADR-010-delivery-failure-is-never-silent.md)).

## Compatibility and prerequisites

| Requirement | Value |
| --- | --- |
| Node.js | `>=22.12.0` (the floor `doctor` enforces and the suite is built against) |
| Platforms | Linux, macOS, Windows — **Linux is the only one ever run**; see Known Limitations |
| Runtime dependencies | `electron` 44.4.5, `better-sqlite3` 13.0.3 |
| Desktop session | A graphical session with a status area. A headless machine starts the hub and serves the API, but shows no card and no tray icon. |
| Harness | **opencode only.** GitHub Copilot CLI was deferred at its gate. |

Minimums are the ones the code enforces: `package.json` `engines.node`,
`MINIMUM_NODE_VERSION` in `src/cli/doctor.ts`, and the `os` allowlist.

## Installation

From a built checkout:

```bash
npm install
npm run build          # tsc -> dist/main (hub + CLI), Vite -> dist/dashboard
npm install -g .       # puts `agent-ping` on PATH
agent-ping install     # writes the opencode plugin, enables autostart, starts the hub
```

`npm install -g .` has not been run against a registry by this project. The claim
that has been observed is that a **built checkout** produces a working `agent-ping`
command and that the four subcommands run from the built entry point; see the task
evidence in [`docs/artifacts/IO-2.md`](../artifacts/IO-2.md) and
[`docs/reviews/operations.json`](../reviews/operations.json).

`agent-ping install` is idempotent: a second run reports that it changed nothing.
The full procedure, including per-platform autostart details, is in the
[administrator guide](../admin-guide.md).

## Upgrade

There is no previous release, so there is no upgrade path to document. For a later
release, the relevant facts are that the durable log is forward-only migrated and
numbered from 1 with no gaps, that an unreadable database is deleted and recreated
from the schema, and that a shipped migration is never edited.

## Known limitations

Read these as part of the release, not as footnotes. The register that owns each
one, with the runbook that discharges it, is
[`docs/reviews/deferred-gates.md`](../reviews/deferred-gates.md).

- **Nothing has been run on macOS or Windows.** Every live observation in this
  repository comes from one Linux desktop (Ubuntu 24.04, X11). The notification
  surface is one code path across all three platforms and only the window manager
  differs, but that is a statement about the code, not an observation. The macOS and
  Windows autostart units are unit-tested bytes and paths and have had no live
  service manager.
- **No login has ever started the hub.** `systemctl --user start` is not a log out
  and back in, on any platform.
- **No human has watched the product work end to end.** Three review gates were
  closed by attestation rather than by review, and two were closed before the
  software they review had been written.
- **Half the end-to-end evidence was not retained.** The real-harness run's machine
  summary was never committed; re-running the script and committing it is the
  cheapest outstanding item.
- **Copilot CLI is not supported in this version.** The gate recorded deferral on
  2026-09-27 against Copilot CLI 1.0.88, with residual risk written down in
  [`docs/runbooks/copilot-support.md`](../runbooks/copilot-support.md).
- **No sound, by decision.** There is no sound field anywhere on the notification
  path; the two intervals the ADR calls "planned" were not built.

## Validation

What has been observed, and by what instrument:

| Claim | State |
| --- | --- |
| Unit and integration suites, on real loopback sockets | Green via `npm test`; `npm run typecheck` and `npm run lint` are part of the documented gates |
| The `opencode` binary reaching a real permission decision against a real hub | `scripts/verify-opencode-live.mjs` (OA-5) |
| A card on a real desktop, inside the work area, painted, persisting, taken down on acknowledgement, and silence for a session that does nothing | **Live-verified on Linux/X11 against the product's own shipped build, with no test-supplied seam** — `scripts/verify-notification-surface.mjs`, evidence in [`docs/reviews/notification-surface-evidence.json`](../reviews/notification-surface-evidence.json), claims tabulated in [`docs/runbooks/notification-surface.md`](../runbooks/notification-surface.md) |
| The dashboard journey in a real browser | `npm run test:e2e` / `scripts/verify-dashboard-e2e.mjs` (LD-4) |
| A real `systemd --user` manager enabling, starting, stopping and restarting the unit, with a pending item surviving | `scripts/verify-autostart-linux.mjs` (IO-4), evidence in [`docs/reviews/autostart-linux-evidence.json`](../reviews/autostart-linux-evidence.json) |
| The Copilot CLI ACP and hook surfaces | Probed against a real binary at 1.0.88; the probe evidence is in [`docs/research/`](../research/), the decision in [`docs/reviews/copilot-gate.json`](../reviews/copilot-gate.json) |

What has **not** been observed is stated in Known Limitations and repeated in
[`docs/PROGRESS.md`](../PROGRESS.md), which enumerates every unverified check by task.
No support claim, integration claim or production-readiness claim is made beyond the
table above.

## Security and privacy

- **Loopback only.** The hub binds `127.0.0.1` and refuses any request whose remote
  address is not loopback. A port collision falls back to another loopback port; it
  never binds wider.
- **One write route, one token.** Acknowledgement is the only mutation, and it
  requires the per-install token in `hub-write-token`. Ingest is append-only and
  needs no token, because it can create a row and reach no session, no agent and no
  harness.
- **Owner-only state.** `0700` directories and `0600` files for the state directory,
  the database, the runtime file, the write token and the autostart units. `doctor`
  reports a directory that is wider than that rather than silently tightening it.
- **No content, anywhere.** No prompt, response, tool output, file content or diff
  is stored, logged or displayed. What is left behind is where the state directory
  is, and it is documented in the [user guide](../user-guide.md#privacy-and-data-handling).
- **Nothing leaves the machine.** There is no telemetry, no update check and no crash
  report. The only outbound call any command makes is a GET to the loopback hub.
- **The Chromium sandbox is disabled for agent-ping's own window.** The autostart
  units and the launcher carry `--no-sandbox` and `ELECTRON_DISABLE_SANDBOX=1`,
  without which the packaged runtime aborts at startup. This was observed as
  load-bearing on a real Electron process. The administrator guide says what it means
  for your machine.
- **Reporting a vulnerability:** there is no `SECURITY.md` in this repository yet.
  Open a GitHub security advisory on the repository, or contact the maintainer
  directly (see the README's Author section), and prefer a private report over a
  public issue.

## Documentation

| Document | What it is |
| --- | --- |
| [User guide](../user-guide.md) | Day-to-day use: install, the three classes, the dashboard, keyboard and screen-reader use, privacy, troubleshooting |
| [Administrator guide](../admin-guide.md) | Installation, configuration, state and backups, health and monitoring, upgrades, autostart per platform, hardening |
| [ADR index](../adr/README.md) | The twelve durable decisions, each with its implementation state |
| [Changelog](../../CHANGELOG.md) | Full change history |
| [docs/PROGRESS.md](../PROGRESS.md) | The build log, including every check that is not verified against real software |
| [docs/reviews/deferred-gates.md](../reviews/deferred-gates.md) | What this release owes, and the runbook that closes each item |
| [docs/features/](../features/) | The eight canonical feature documents |
| [docs/runbooks/](../runbooks/) | Per-surface operational notes and the review procedures |
