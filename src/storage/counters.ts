// Local counters: the four numbers the success bar is measured against
// (EL-FR-10, PRD 11, hub-core HC-6).
//
// A counter here is a name from a closed union, a non-negative integer and the
// instant it last moved. There is no fourth kind of field, no label, no dimension
// and no per-request echo, so the metrics payload the hub serves from this is
// counts and timestamps (APX-FR-01, APX-CON-12). A counter row cannot hold
// conversation content even in principle, and the schema asserts its exact column
// set in tests/storage/schema.test.ts.
//
// The four counters, and where each is recorded from:
//
//   dashboard_opens         PRD 11 measures "unprompted dashboard pull" from this.
//                           Recorded when a dashboard client connects (HC-6).
//   toast_deliveries        PRD 11 measures notification restraint from this
//                           against the blocks the log holds.
//   deep_link_opens         The tray icon resolves a deep link into the dashboard
//                           (NT-FR-08), and that is the event worth counting.
//   pending_count_snapshots Recorded whenever the pending set changes (HC-6), so
//                           "how often does a block need me" is answerable from
//                           the local file alone.
//
// Two deliberate omissions, both because the log already holds the fact and a
// second copy of a fact is a second thing to drift:
//
//   - The pending count itself is not stored. readPending() derives it from the
//     events table at any moment, so storing it would duplicate the badge's single
//     source of truth (NT-FR-05) in a place nothing reconciles. This counter
//     records that a snapshot happened; the value is the log's.
//   - There is no per-repository breakdown. PRD 16 Open Questions 3 settles that
//     as "no for v1; aggregate counters plus the event history answer the
//     question", and the event history carries repo_short_name per row
//     (APX-CON-09, ADR-008).
//
// The API is a closed shape for the same reason the store's is: one write method
// per counter and exactly one read. There is no increment(name) that would take a
// string from a caller, no SQL handle, and no query method, because a general
// query surface over a table whose key is a TEXT column is a way for a caller's
// string to become durable state. The name of a counter is chosen here, by this
// union, and the union is asserted in tests/storage/counters.test.ts.
//
// A counter this module did not write is not readable through it. If some other
// writer put an arbitrary string in the name column, read() still returns the four
// readings above, because the return type cannot carry a name this module does not
// know. That is the point of the closed union: an unexpected row is invisible at
// this boundary rather than forwarded into a metrics payload as a string.
//
// Every write is a single committed transaction through better-sqlite3, so there
// is no in-memory buffer that a crash could lose. flush() exists because PRD 10
// names "counters flushed" in the hub's stopping state and the shutdown path
// deserves a typed call rather than a reach for a database handle; what it does is
// fold the write-ahead log back into the database file, so a copy of the single
// file is complete afterwards.
//
// Nothing here opens a socket, spawns a process or renders a surface, and no value
// read or written by this module is ever sent anywhere (APX-CON-12).

import { openDatabase, type OpenDatabase } from './db.js'
import { databaseFilePath } from './paths.js'

/**
 * Every counter name that can exist, in a fixed order.
 *
 * `as const` is what makes this a type rather than an array: CounterName is a
 * union of four literals, so no caller can name a fifth, and the read order is
 * stable so the metrics payload is stable. Appending a counter is a deliberate
 * diff here rather than a string that appears at a call site.
 */
export const COUNTER_NAMES = [
  'dashboard_opens',
  'toast_deliveries',
  'deep_link_opens',
  'pending_count_snapshots',
] as const

export type CounterName = (typeof COUNTER_NAMES)[number]

/**
 * One counter as the metrics route serves it (HC-FR-02, HC-6): a label from the
 * closed union, a count and when it last moved. Exactly three fields, asserted
 * field by field in tests/storage/counters.test.ts, because this shape is what
 * leaves the process over the loopback hub.
 */
export interface CounterReading {
  readonly counter: CounterName
  readonly value: number
  /**
   * When the counter last moved, or null when it has never been recorded. A
   * never-recorded counter reads as 0 with no timestamp rather than being absent,
   * so a client can tell "nothing has happened yet" from "this counter is not one
   * we keep" without a second read.
   */
  readonly updatedAt: string | null
}

export interface Counters {
  readonly filePath: string
  readonly schemaVersion: number
  /** Record one dashboard open. Returns the new value. */
  recordDashboardOpen(): number
  /** Record one delivered toast. Returns the new value. */
  recordToastDelivery(): number
  /** Record one deep-link open. Returns the new value. */
  recordDeepLinkOpen(): number
  /** Record that the pending set changed. Returns the new value. */
  recordPendingCountSnapshot(): number
  /**
   * The one read-only accessor. Returns all four counters, in COUNTER_NAMES order,
   * whether or not each has been recorded.
   */
  read(): readonly CounterReading[]
  /**
   * Fold the write-ahead log back into the database file. Idempotent, and safe to
   * call at any time; it records nothing and changes no value. See the module
   * header for why it exists and what it actually does.
   */
  flush(): void
  /** Idempotent. Safe to call twice. */
  close(): void
}

export interface OpenCountersOptions {
  /** Defaults to the database file inside the resolved state directory. */
  readonly filePath?: string
  /**
   * ISO 8601 UTC source for counters.updated_at. Injectable so a test can assert
   * the stamp; there is deliberately no per-call timestamp parameter, so a caller
   * cannot write a timestamp of its own choosing.
   */
  readonly now?: () => string
}

/**
 * Increment by one and stamp the instant, in one statement.
 *
 * `counters.value + 1` is qualified with the table name so it is unambiguously the
 * stored value being incremented rather than the proposed row's, which is the
 * mistake that turns a counter into "the last value written".
 */
const RECORD_ONE = `
  INSERT INTO counters (name, value, updated_at) VALUES (?, 1, ?)
    ON CONFLICT (name) DO UPDATE SET value = counters.value + 1, updated_at = excluded.updated_at
`

const READ_ALL = 'SELECT name, value, updated_at FROM counters'

interface CounterRow {
  readonly name: string
  readonly value: number
  readonly updated_at: string
}

/**
 * Open the counters in the database file the product already writes.
 *
 * A second connection to that file, for the same reason src/storage/retention.ts
 * has one: the store does not hand out its handle, so a feature that needs its own
 * write path opens the same file itself rather than widening the store's API. Pass
 * `store.filePath` to guarantee both point at the same log.
 *
 * The handle stays open for the lifetime of the returned accessor, because a
 * counter is recorded on request paths and re-opening a database per increment
 * would be the wrong trade. Call close() when the caller is done with it.
 */
export function openCounters(options: OpenCountersOptions = {}): Counters {
  const filePath = options.filePath ?? databaseFilePath()
  const now = options.now ?? ((): string => new Date().toISOString())
  const opened: OpenDatabase = openDatabase({ filePath })

  const db = opened.db
  const recordOne = db.prepare<[string, string]>(RECORD_ONE)
  const readOne = db.prepare<[string], { value: number }>('SELECT value FROM counters WHERE name = ?')
  const readAll = db.prepare<[], CounterRow>(READ_ALL)

  const record = (counter: CounterName): number => {
    recordOne.run(counter, now())
    // The value is read back from the row just written rather than computed in
    // memory, so a caller that records and reads can never see two different
    // numbers for one counter.
    return readOne.get(counter)?.value ?? 0
  }

  return {
    filePath,
    schemaVersion: opened.schemaVersion,
    recordDashboardOpen: (): number => record('dashboard_opens'),
    recordToastDelivery: (): number => record('toast_deliveries'),
    recordDeepLinkOpen: (): number => record('deep_link_opens'),
    recordPendingCountSnapshot: (): number => record('pending_count_snapshots'),
    read: (): readonly CounterReading[] => {
      const rows = readAll.all()
      return COUNTER_NAMES.map((counter) => {
        const row = rows.find((candidate) => candidate.name === counter)
        return { counter, value: row?.value ?? 0, updatedAt: row?.updated_at ?? null }
      })
    },
    flush: (): void => {
      // TRUNCATE rather than the default PASSIVE, because the caller of flush wants
      // the file complete, not merely checkpointed at the last safe boundary. A
      // busy result is not an error: it means another connection was mid-read, and
      // the committed values are already safe in the write-ahead log.
      db.pragma('wal_checkpoint(TRUNCATE)')
    },
    close: (): void => {
      opened.close()
    },
  }
}
