// Retention pruning over the durable log (EL-FR-09, PRD 16 Open Questions 8).
//
// What this module owns is one question: which rows of the events table may be
// deleted, and in what order the rules that answer it are applied. It deletes
// events and nothing else - no session row, no counter, no file, no table. A
// session summary deliberately outlives its events, because the dashboard groups
// by session and a session that disappeared from history the moment its rows aged
// out would make the PRD 11 question "can the developer name specific sessions the
// tool caught" unanswerable. The floor below guarantees a session never loses its
// last row, so pruning cannot orphan a summary either.
//
// Three rules, and which one wins:
//
//   1. Age. An event that occurred before the retention cutoff is a candidate.
//   2. The per-session floor. A candidate that is one of the most recent
//      PER_SESSION_FLOOR events in its own session is not prunable. The floor wins
//      over the age rule (PRD 16 Open Questions 8), which is why a session with
//      three events from last March keeps all three, and why the floor is counted
//      per session rather than globally: 300 old events in each of three sessions
//      are 900 rows on disk and every one of them is inside a session's floor.
//   3. The pending protection. A candidate that is still a pending item is never
//      prunable, at any age. A block the developer has not dealt with is the one
//      thing this product exists not to lose (EL-FR-08), and thirty days of
//      history is worth less than one unanswered permission ask.
//
// "Still a pending item" is exactly the set src/storage/eventStore.ts reports as
// pending - needs-you, unacknowledged and unresolved - rather than a second
// definition of the word drifting in a second module. So a block the harness
// resolved, or that the developer acknowledged, is no longer a pending item and
// ages out like any other history row. Its session summary survives the rows,
// which is what keeps the history of "this block happened, and here is how it was
// dealt with" readable for as long as the session does.
//
// The cutoff is inclusive: an event that occurred exactly retentionDays before
// the prune instant is pruned, and the boundary is asserted as a boundary in
// tests/storage/retention.test.ts rather than left to the comparison operator.
// Comparing ISO 8601 UTC text lexicographically is comparing timestamps, which
// is why occurred_at is stored in that exact format (src/storage/schema.sql); the
// format itself is validated where untrusted input arrives, the ingest route
// (HC-3), not here.
//
// The window and the floor are parameters with these defaults rather than
// constants in the SQL, because PRD 16 Open Questions 8 records both as
// configurable, and because a rule that cannot be varied is a rule that cannot be
// boundary-tested with anything other than the shipped numbers.
//
// This module opens its own connection to the database file instead of borrowing
// the store's handle. That is deliberate: the store does not hand out its
// database handle or a raw query escape hatch (EL-FR-01, src/storage/eventStore.ts),
// and a query surface handed to a maintenance path is a content surface handed to
// a maintenance path. SQLite's write-ahead log plus the busy timeout
// src/storage/db.ts already sets make a second connection to the same file safe,
// the whole prune runs in one immediate transaction so no other writer can slip
// between choosing the rows and deleting them, and the handle is closed before
// this function returns.
//
// Nothing here opens a socket, spawns a process or renders a surface, and every
// value this module reads and writes is a timestamp, a count or a row identifier
// already in the log (APX-FR-01, APX-CON-12).

import { openDatabase, type OpenDatabase } from './db.js'
import { databaseFilePath } from './paths.js'

/** The default age window, in days (EL-FR-09, PRD 16 Open Questions 8). */
export const RETENTION_DAYS = 30

/**
 * The default per-session floor: how many of a session's most recent events
 * survive the age rule.
 */
export const PER_SESSION_FLOOR = 500

const MILLISECONDS_PER_DAY = 86_400_000

/**
 * The two numbers, named once, so the defaults cannot be spelled two ways in two
 * places. They are data rather than SQL literals for the same reason: a test
 * asserts the boundary against these values and a different pair of values
 * proves the rule is the rule and not the number.
 */
export interface RetentionPolicy {
  readonly retentionDays: number
  readonly perSessionFloor: number
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  retentionDays: RETENTION_DAYS,
  perSessionFloor: PER_SESSION_FLOOR,
}

export interface PruneOptions extends Partial<RetentionPolicy> {
  /** Defaults to the database file inside the resolved state directory. */
  readonly filePath?: string
  /**
   * The instant to measure the age rule from, as ISO 8601 UTC. Defaults to now.
   * A parameter rather than an ambient clock so the boundary is reproducible.
   */
  readonly now?: string
}

export interface PruneResult {
  readonly filePath: string
  readonly schemaVersion: number
  /**
   * True when the file could not be read and was recreated from the migrations
   * before the prune ran, which means the history this prune was going to look at
   * is gone. Reported rather than silent (APX-FR-02), the same flag the store
   * carries.
   */
  readonly rebuiltFromMigrations: boolean
  /** The instant at or before which an event is old enough to be a candidate. */
  readonly cutoff: string
  /** The numbers this run actually applied, echoed back so a log line can name them. */
  readonly policy: RetentionPolicy
  /** The pruned rows, oldest first. Row identifiers and nothing else. */
  readonly prunedEventIds: readonly string[]
  readonly prunedCount: number
  /**
   * How many rows the age rule and the floor would have pruned and the pending
   * protection saved. Non-zero means the protection did real work, which is worth
   * a breadcrumb in the local log and is the reason a prune that "pruned nothing"
   * is not automatically a bug.
   */
  readonly keptPendingCount: number
}

/**
 * The first prunable occurrence time, as ISO 8601 UTC: an event that occurred at
 * this instant or earlier is a candidate for the age rule.
 *
 * The boundary is inclusive, which is what makes "exactly thirty days old" a
 * decision rather than an accident of the comparison operator.
 *
 * Throws on an instant that is not a parseable timestamp: a cutoff computed from
 * NaN would make every event look old, which is the one failure mode retention
 * must not have.
 */
export function retentionCutoff(now: string, retentionDays: number = RETENTION_DAYS): string {
  assertWholeNumber('retentionDays', retentionDays, 1)
  const instant = Date.parse(now)
  if (Number.isNaN(instant)) {
    throw new Error(
      `retention needs a parseable ISO 8601 UTC instant, and "${now}" is not one. ` +
        'A cutoff computed from an unreadable clock would make every event look old, ' +
        'so the prune refuses to run rather than guessing.',
    )
  }
  return new Date(instant - retentionDays * MILLISECONDS_PER_DAY).toISOString()
}

/**
 * The most recent events of one session, as row identifiers.
 *
 * This subquery *is* the per-session floor, which is why there is no second
 * session-level count anywhere in the module: a second copy of the rule is a
 * second thing to keep in step with the first. A session with at most
 * `perSessionFloor` events has all of them returned by this subquery, so none of
 * them is ever a candidate, whatever its age.
 *
 * Ordering is by occurrence time then row key, so a session holding several events
 * with the same timestamp still has a deterministic floor: the same 500 events are
 * protected on every run, and the 500th and 501st are never decided by whatever
 * order the query planner happened to produce.
 */
const MOST_RECENT_IN_SESSION = `
  SELECT recent.event_id FROM events recent
   WHERE recent.session_id = events.session_id
   ORDER BY recent.occurred_at DESC, recent.event_id DESC
   LIMIT ?
`

/**
 * The pending condition, identical to the one src/storage/eventStore.ts uses for
 * readPending, written here rather than imported because a maintenance path must
 * not need the store's handle to agree with it. The comment above names the
 * single definition both copies answer to.
 */
const PENDING_CONDITION =
  "events.class = 'needs-you' AND events.ack_state = 'unacknowledged' AND events.resolution_state = 'unresolved'"

/**
 * Rows the age rule and the floor would prune, oldest first.
 *
 * `occurred_at <= cutoff` is the inclusive boundary; `event_id NOT IN (...)` is
 * the floor; the negated pending condition is the protection. All three live in
 * this one statement so a change to one of them cannot be applied to the
 * candidate query and forgotten in the delete.
 */
const PRUNABLE_CANDIDATES = `
  SELECT events.event_id FROM events
   WHERE events.occurred_at <= ?
     AND NOT (${PENDING_CONDITION})
     AND events.event_id NOT IN (${MOST_RECENT_IN_SESSION})
   ORDER BY events.occurred_at ASC, events.event_id ASC
`

/**
 * How many rows the same three rules would prune if the pending protection were
 * not there. It is the number the protection saved, and it is counted by the same
 * floor subquery so a pending row inside a session's floor is not counted as
 * saved: it was never a candidate.
 */
const PENDING_SAVED_BY_PROTECTION = `
  SELECT COUNT(*) AS count FROM events
   WHERE events.occurred_at <= ?
     AND (${PENDING_CONDITION})
     AND events.event_id NOT IN (${MOST_RECENT_IN_SESSION})
`

/**
 * Prune the durable log once, and report exactly what it did.
 *
 * One shot: it opens the file, applies the migrations idempotently (the store has
 * done that too, so this is a no-op), prunes in a single immediate transaction and
 * closes the handle again. The caller decides when retention runs - the hub on
 * start and on a slow interval (HC-2, HC-5) - because a timer in this module would
 * be a second process model (PRD 6.2).
 *
 * Idempotent by construction: the second call finds nothing the first one left
 * prunable, so a hub that prunes twice for any reason deletes nothing twice.
 */
export function pruneEvents(options: PruneOptions = {}): PruneResult {
  const policy: RetentionPolicy = {
    retentionDays: options.retentionDays ?? DEFAULT_RETENTION_POLICY.retentionDays,
    perSessionFloor: options.perSessionFloor ?? DEFAULT_RETENTION_POLICY.perSessionFloor,
  }
  // Both numbers are checked before anything is opened, so a nonsensical policy
  // cannot even reach the file. retentionDays is checked again inside
  // retentionCutoff, which is also the public path callers use on their own.
  assertWholeNumber('perSessionFloor', policy.perSessionFloor, 0)
  const cutoff = retentionCutoff(options.now ?? new Date().toISOString(), policy.retentionDays)
  const filePath = options.filePath ?? databaseFilePath()

  const opened: OpenDatabase = openDatabase({ filePath })
  try {
    const db = opened.db
    const selectCandidates = db.prepare<[string, number], { event_id: string }>(PRUNABLE_CANDIDATES)
    const countSavedPending = db.prepare<[string, number], { count: number }>(PENDING_SAVED_BY_PROTECTION)
    const deleteRow = db.prepare<[string]>('DELETE FROM events WHERE event_id = ?')

    // Immediate, so the rows chosen and the rows deleted cannot have another
    // writer's insert in between: a concurrent insert could otherwise push one of
    // them inside a session's floor after it was chosen, and the delete would then
    // remove a row the floor protects.
    const prunedEventIds = db
      .transaction((): string[] => {
        const ids = selectCandidates.all(cutoff, policy.perSessionFloor).map((row) => row.event_id)
        for (const eventId of ids) {
          deleteRow.run(eventId)
        }
        return ids
      })
      .immediate()

    return {
      filePath,
      schemaVersion: opened.schemaVersion,
      rebuiltFromMigrations: opened.rebuiltFromMigrations,
      cutoff,
      policy,
      prunedEventIds,
      prunedCount: prunedEventIds.length,
      keptPendingCount: countSavedPending.get(cutoff, policy.perSessionFloor)?.count ?? 0,
    }
  } finally {
    opened.close()
  }
}

/**
 * Reject a policy that would delete more than intended.
 *
 * A negative floor is the dangerous one: SQLite reads `LIMIT -1` as no limit at
 * all, so the floor subquery would protect nothing and the age rule would delete
 * every old event in every session, including the ones the requirement exists to
 * keep. That is worth an explicit refusal rather than a comment.
 */
function assertWholeNumber(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(
      `${name} must be a whole number of at least ${minimum}, and ${String(value)} is not. ` +
        'A value below zero reads as "no limit" to the LIMIT in the floor subquery, and the ' +
        'age rule would then prune rows this requirement says to keep, so the prune refuses ' +
        'to run rather than deleting more than it was asked to.',
    )
  }
}
