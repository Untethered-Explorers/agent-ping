# Human Review: Review the hub read-only promise and restart safety

Reviewer: Doug McCusker
Reviewed at: 2026-09-26T18:12:46.994Z
Decision: Approved

## Review notes

## Journey performed

The real hub entry point (`src/main/index.ts`, started through the existing
`tests/hub/fixtures/signal-hub.mjs` fixture — there is no CLI yet, IO-1 and IO-2 are unstarted)
was run against a throwaway state directory and driven over real loopback HTTP.

1. Started the hub. Read the live port from `hub-runtime.json` the way an adapter does, and
   the write token from `hub-write-token` in the same state directory.
2. Read every read route: health, sessions, pending, events and metrics, plus an unknown
   session and the dashboard fallback.
3. Posted one `needs-you` signal (`opencode` / `permission.asked`), one non-blocking signal
   (`session.error`, classified `fyi`), and then a duplicate of the first.
4. Re-read pending, history, one session and the limit / sessionId filters; held the state
   stream open and recorded its frame names; re-read everything a second time to show that
   no read route moved any state.
5. Attempted every forbidden operation (steer, interrupt, prompt, approve, send, cancel,
   harness control) and every write method against a read path.
6. Acknowledged the pending item: with no token, with a wrong token, with the install token,
   twice, plus an unknown id and a non-pending row.
7. Posted a second block, snapshotted pending, history and metrics, killed the hub with
   SIGKILL while that block was pending, and restarted it over the same state directory.
8. Compared pending, history, the delivery ledger and health across the restart.
9. Sent SIGTERM, confirmed the runtime file was released and the counters flushed, then
   started a third time and confirmed there was nothing to reclaim and no row had changed.
