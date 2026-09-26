# Claim shapes and assertion inventories

> Load when starting one of this project's four verification scripts, or when reviewing whether
> an existing script's assertions actually cover the claim it names.

## The four scripts

| Script | Proves | Dependency that may be absent |
|--------|--------|-------------------------------|
| `verify-opencode-live.mjs` | The adapter works against a real opencode session | The `opencode` binary |
| `verify-autostart-linux.mjs` | Install, autostart and restart preserve pending state | The user service manager (systemd --user) |
| `verify-dashboard-e2e.mjs` | The dashboard journey works in a real browser | A Playwright browser |
| `probe-copilot-acp.mjs` / `probe-copilot-hooks.mjs` | What the real Copilot CLI emits | The `copilot` binary |

Each has a claim with a positive, a negative and a failure path. Each treats its dependency as
required.

## verify-opencode-live

**Claim.** A real opencode session is caught end to end, with correct suppression and correct
failure reporting.

- Positive: a session reaching a permission decision and then going idle produces a
  needs-you envelope, a resolution, and exactly one finished envelope carrying the correct
  repository short name.
- Negative: a session that opens, greets and closes produces no finished envelope.
- Failure: with the hub not running, the adapter writes a breadcrumb rather than dropping the
  event silently.

Isolate by installing the plugin into a temporary configuration directory and starting the hub
against a temporary state directory. Assert against what the hub actually stored, not against
what the harness logged.

## verify-autostart-linux

**Claim.** The operational contract holds on the real machine, across a real restart.

1. Install into a temporary state directory using the real user service manager.
2. Start the hub; assert health.
3. Create a pending item.
4. Stop the hub.
5. Start it again **through the service manager**, not by running the binary directly.
6. Assert the pending item, its history row and the pending count survived unchanged and were
   not duplicated.
7. Disable autostart; assert the unit is gone.
8. Assert uninstall removes the plugin file while the database survives.

Every step is an assertion. Steps 5 and 6 are the point of the script: a restart that loses or
duplicates pending state is the failure the badge exists to prevent.

The script also records in the runbook that macOS and Windows need the same script run on those
machines for those platforms to be claimed. Record the platform each observation was made on.

## verify-dashboard-e2e

**Claim.** The primary journey works in a real browser against the real hub.

Start the hub against a temporary state directory, serve the built dashboard, then:

- Drive one needs-you event through the ingest route.
- Assert the new blocked row appears.
- Assert the pending count increments.
- Assert a keyboard-only path can reach and activate the row.
- Assert acknowledgement clears it.
- Assert the history panel then lists it.
- Assert the page reports a stale state when the stream is interrupted, rather than presenting
  old data as current.
- Assert a deep link opens the dashboard focused on the expected session.

Two script-level requirements on top of the journeys:

- The suite **fails when no test executes**, and prints which journeys ran. A green run with an
  empty journey list is the failure this prevents.
- The repository script installs the browser if needed and fails loudly when the browser cannot
  be obtained, rather than skipping.

The loopback fallback matters: the dashboard is also served over the loopback origin, so the
journey can be driven in an existing browser when a Playwright download is blocked. That is a
different recorded path, not a skip.

## probe-copilot-acp and probe-copilot-hooks

**Claim.** What the real Copilot CLI actually emits, captured verbatim.

ACP probe:

- Launch the real CLI in ACP mode and perform the initialize handshake.
- Record the negotiated protocol version, the agent capabilities and the authentication methods.
- Subscribe to notifications and record every notification type actually observed.

Hook probe:

- Enumerate the documented hook triggers and capture their real payloads.
- Record explicitly whether any idle or permission equivalent exists, and what a session-end
  reason can express.

Both write one report containing the verbatim captured evidence, timestamps and the exact CLI
version. A summary is not evidence; a later reader must be able to re-check the conclusion.

See the `harness-signal-mapping` skill for the three-state evidence classification and the
recorded decision shape; do not restate it here.

## Assertion inventory

Every script asserts at least these. Add to them; do not substitute them.

| Category | Assertion |
|----------|-----------|
| Positive | The expected real-world behaviour was observed |
| Negative | The suppressed or absent case produced nothing, and that "nothing" was verified rather than assumed |
| Failure | A missing dependency or absent service produced a non-zero exit and a recorded breadcrumb or remedy |
| Isolation | The run touched only temporary paths and left nothing behind |
| Non-vacuity | The executed-assertion count is at least the expected count |
| Identity | Observed repository short names and session ids match what the run set up |

The negative category is the one most often skipped and the one that catches the most: a
greeting-and-close session that wrongly produces a `finished` event, a restarted hub that
duplicates a pending item, and a second mutating route all pass a happy-path-only script.
