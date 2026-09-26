// Local counters against a real better-sqlite3 file (EL-FR-10, PRD 11, HC-6).
//
//   npm test -- tests/storage/counters.test.ts
//
// What is asserted here:
//
//   - Each of the four counters increments through the accessor's own method and
//     the value survives closing and reopening the file, because a counter that
//     only lives in memory is a number the success bar cannot be measured from.
//   - The read shape is exactly a counter name from a closed union, a count and a
//     timestamp. This is the payload the metrics route serves, so the field set is
//     asserted field by field rather than sniffed for forbidden names.
//   - The accessor has no query surface: no database handle, no SQL, and no
//     method that takes a counter name as a string.
//   - A counter written by anything other than this module is not readable through
//     it, which is what keeps an arbitrary string in the name column from
//     travelling outward.
//   - The counters table's exact columns are asserted here as well as in
//     tests/storage/schema.test.ts, because this module is what writes to it.
//   - flush() leaves a copy of the single database file complete, which is the
//     "counters flushed" step of PRD 10's stopping state.
//
// Every database is a real file in a fresh temporary directory, closed and removed
// after each test, because a leaked native handle makes a later assertion fail for
// the wrong reason. The store is open on the same file throughout, which is how
// the hub runs this: one log, several accessors, no shared handle.

import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { DATABASE_FILE_NAME, STATE_DIR_ENV_VAR } from '@/storage/paths'
import { openEventStore, type EventStore } from '@/storage/eventStore'
import { COUNTER_NAMES, openCounters, type Counters } from '@/storage/counters'

const NOW = '2026-09-26T12:00:00.000Z'
const LATER = '2026-09-26T12:05:00.000Z'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const temporaryDirectories: string[] = []
const openStores: EventStore[] = []
const openCountersHandles: Counters[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent-ping-counters-'))
  temporaryDirectories.push(directory)
  return directory
}

function temporaryFilePath(): string {
  return path.join(temporaryDirectory(), DATABASE_FILE_NAME)
}

/**
 * A store and a counter accessor on the same fresh file, both tracked for
 * cleanup. The store is opened in every test on purpose: the hub holds the log
 * open while counters are recorded, and a test that only ever opened counters
 * would not prove the two coexist.
 */
function openTemporaryLog(): { store: EventStore; filePath: string } {
  const filePath = temporaryFilePath()
  const store = openEventStore({ filePath })
  openStores.push(store)
  return { store, filePath }
}

function openCounterAccessor(filePath: string, now: () => string = () => NOW): Counters {
  const counters = openCounters({ filePath, now })
  openCountersHandles.push(counters)
  return counters
}

afterEach(() => {
  for (const counters of openCountersHandles.splice(0)) counters.close()
  for (const store of openStores.splice(0)) store.close()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
})

/**
 * A second connection for reading the counters table back, closed before the call
 * returns, so the accessor stays closed and this file leaks no handle of its own.
 */
function withDatabase(filePath: string, inspect: (db: Database.Database) => void): void {
  const db = new Database(filePath, { timeout: 5_000 })
  try {
    inspect(db)
  } finally {
    db.close()
  }
}

function counterRows(filePath: string): readonly { name: string; value: number; updated_at: string }[] {
  const rows: { name: string; value: number; updated_at: string }[] = []
  withDatabase(filePath, (db) => {
    rows.push(
      ...db
        .prepare<[], { name: string; value: number; updated_at: string }>(
          'SELECT name, value, updated_at FROM counters ORDER BY name',
        )
        .all(),
    )
  })
  return rows
}

function valuesByName(readings: ReturnType<Counters['read']>): Readonly<Record<string, number>> {
  return Object.fromEntries(readings.map((reading) => [reading.counter, reading.value]))
}

// ---------------------------------------------------------------------------
// The four counters
// ---------------------------------------------------------------------------

describe('the counter set (EL-FR-10)', () => {
  it('is exactly the four counters the requirements name, in a fixed order', () => {
    // PRD 11 measures dashboard_opens and toast_deliveries by name; HC-6 adds
    // deep-link opens and a pending-count snapshot. A fifth counter has to be a
    // deliberate addition here, in this array, where the reviewer sees it.
    expect([...COUNTER_NAMES]).toEqual([
      'dashboard_opens',
      'toast_deliveries',
      'deep_link_opens',
      'pending_count_snapshots',
    ])
  })

  it('increments each counter through its own method and survives reopening the store', () => {
    const { filePath } = openTemporaryLog()
    const counters = openCounterAccessor(filePath)

    expect(counters.recordDashboardOpen()).toBe(1)
    expect(counters.recordToastDelivery()).toBe(1)
    expect(counters.recordDeepLinkOpen()).toBe(1)
    expect(counters.recordPendingCountSnapshot()).toBe(1)
    // Twice more on one counter, so an accessor that returned a constant would
    // fail here rather than on the first read.
    expect(counters.recordDashboardOpen()).toBe(2)
    expect(counters.recordDashboardOpen()).toBe(3)
    counters.close()

    // The file is closed and reopened: these are durable numbers, not memory.
    const reopened = openCounterAccessor(filePath)
    expect(valuesByName(reopened.read())).toEqual({
      dashboard_opens: 3,
      toast_deliveries: 1,
      deep_link_opens: 1,
      pending_count_snapshots: 1,
    })
    // And they keep counting from there rather than restarting.
    expect(reopened.recordToastDelivery()).toBe(2)
    expect(valuesByName(reopened.read())['toast_deliveries']).toBe(2)
  })

  it('keeps a counter for a metric whose increments are recorded from different call sites', () => {
    const { filePath } = openTemporaryLog()
    const first = openCounterAccessor(filePath, () => NOW)
    const second = openCounterAccessor(filePath, () => LATER)

    // Two accessors on the same log, the way the hub's request paths and its
    // delivery pipeline would use it. Neither holds a cache, so a read through the
    // second sees the first's write at once and the metrics route cannot serve a
    // stale number.
    expect(first.recordDeepLinkOpen()).toBe(1)
    expect(valuesByName(second.read())['deep_link_opens']).toBe(1)
    expect(second.recordDeepLinkOpen()).toBe(2)
    expect(valuesByName(first.read())['deep_link_opens']).toBe(2)

    const stamped = second.read().find((reading) => reading.counter === 'deep_link_opens')
    expect(stamped?.updatedAt).toBe(LATER)
  })
})

// ---------------------------------------------------------------------------
// The read shape, which is the payload that leaves the process
// ---------------------------------------------------------------------------

describe('the read shape (EL-FR-10, APX-FR-01, HC-6)', () => {
  it('is exactly a name from the closed union, a count and a timestamp', () => {
    const { filePath } = openTemporaryLog()
    const counters = openCounterAccessor(filePath)
    counters.recordDashboardOpen()

    const readings = counters.read()
    expect(readings).toHaveLength(4)
    for (const reading of readings) {
      expect(Object.keys(reading).sort()).toEqual(['counter', 'updatedAt', 'value'])
      expect(COUNTER_NAMES).toContain(reading.counter)
      expect(Number.isSafeInteger(reading.value)).toBe(true)
      expect(reading.value).toBeGreaterThanOrEqual(0)
      if (reading.updatedAt !== null) {
        expect(reading.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      }
    }
  })

  it('reads a counter that has never been recorded as zero with no timestamp, and writes no row for it', () => {
    const { filePath } = openTemporaryLog()
    const counters = openCounterAccessor(filePath)

    // Reading is not writing: a read-only accessor that created rows would make
    // "has this ever happened" unanswerable.
    expect(counters.read()).toEqual([
      { counter: 'dashboard_opens', value: 0, updatedAt: null },
      { counter: 'toast_deliveries', value: 0, updatedAt: null },
      { counter: 'deep_link_opens', value: 0, updatedAt: null },
      { counter: 'pending_count_snapshots', value: 0, updatedAt: null },
    ])
    expect(counterRows(filePath)).toEqual([])

    counters.recordDeepLinkOpen()
    // The three untouched counters still read as never recorded, and the table has
    // exactly one row, not four.
    expect(counters.read().filter((reading) => reading.updatedAt !== null)).toHaveLength(1)
    expect(counterRows(filePath).map((row) => row.name)).toEqual(['deep_link_opens'])
  })

  it('stamps each record with the injected clock, and moves the stamp on every record', () => {
    const { filePath } = openTemporaryLog()
    const times = [NOW, LATER]
    let index = 0
    const counters = openCounterAccessor(filePath, () => times[Math.min(index++, times.length - 1)] as string)

    expect(counters.recordToastDelivery()).toBe(1)
    expect(counters.read()[1]?.updatedAt).toBe(NOW)
    expect(counters.recordToastDelivery()).toBe(2)
    const second = counters.read()[1]
    expect(second?.updatedAt).toBe(LATER)
    // The clock is the only source of the stamp: there is no per-call timestamp a
    // caller could choose, and a value with no timestamp is the only way to have
    // never been recorded.
    expect(counterRows(filePath)).toEqual([{ name: 'toast_deliveries', value: 2, updated_at: LATER }])
  })

  it('exposes one read accessor and one write method per counter, with no query surface', () => {
    const { filePath } = openTemporaryLog()
    const counters = openCounterAccessor(filePath)

    expect(Object.keys(counters).sort()).toEqual([
      'close',
      'filePath',
      'flush',
      'read',
      'recordDashboardOpen',
      'recordDeepLinkOpen',
      'recordPendingCountSnapshot',
      'recordToastDelivery',
      'schemaVersion',
    ])
    // No handle, no SQL, and no method that takes a counter name as a string: a
    // name this module did not choose can never become durable state through the
    // API, which is the same rule the store follows (EL-FR-01).
    for (const absent of ['db', 'prepare', 'exec', 'query', 'increment', 'record', 'set', 'run']) {
      expect(absent in counters, absent).toBe(false)
    }
    // The one read accessor, and nothing else that returns stored data.
    expect(typeof counters.read).toBe('function')
  })

  it('cannot be made to read a row this module did not write', () => {
    const { filePath } = openTemporaryLog()
    const counters = openCounterAccessor(filePath)
    counters.recordDashboardOpen()

    // The counters table's key is a TEXT column and the schema constrains its
    // value only as a non-negative integer, so some other writer could put an
    // arbitrary string there. This accessor cannot read it: the return type is a
    // union of four literals, and the name is a row key, never a value handed in.
    withDatabase(filePath, (db) => {
      db.prepare<[string, number, string], []>(
        'INSERT INTO counters (name, value, updated_at) VALUES (?, ?, ?)',
      ).run('prompt_text', 7, NOW)
    })

    const readings = counters.read()
    expect(readings).toHaveLength(4)
    expect(readings.map((reading) => reading.counter)).toEqual([...COUNTER_NAMES])
    expect(JSON.stringify(readings)).not.toContain('prompt_text')
    // The four real numbers are unaffected by the stray row.
    expect(valuesByName(readings)['dashboard_opens']).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The table this module writes
// ---------------------------------------------------------------------------

describe('the counters table (EL-FR-10, EL-FR-03)', () => {
  it('holds a name, a non-negative integer and an instant, and no other column', () => {
    const { filePath } = openTemporaryLog()
    openCounterAccessor(filePath).recordToastDelivery()

    // The same three columns tests/storage/schema.test.ts asserts exactly, read
    // here as well because this module is the only thing that writes the table and
    // a fourth column would be this feature's addition.
    withDatabase(filePath, (db) => {
      const columns = db
        .prepare<[string], { name: string; type: string; notnull: number }>(
          'SELECT name, type, "notnull" AS "notnull" FROM pragma_table_info(?) ORDER BY cid',
        )
        .all('counters')
        .map((row) => [row.name, row.type, row.notnull === 1])
      expect(columns).toEqual([
        ['name', 'TEXT', true],
        ['value', 'INTEGER', true],
        ['updated_at', 'TEXT', true],
      ])
    })

    const rows = counterRows(filePath)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.value).toBe(1)
    expect(Number.isInteger(rows[0]?.value)).toBe(true)
  })

  it('writes nothing into the state directory except the database file', () => {
    const stateDir = temporaryDirectory()
    vi.stubEnv(STATE_DIR_ENV_VAR, stateDir)

    const counters = openCounters({ now: () => NOW })
    openCountersHandles.push(counters)
    counters.recordDashboardOpen()
    counters.close()

    // No export, no sidecar of this module's own: the counters live in the one
    // local file, and SQLite's write-ahead log goes when the last connection does.
    expect(readdirSync(stateDir).sort()).toEqual([DATABASE_FILE_NAME])
    expect(counters.filePath).toBe(path.join(stateDir, DATABASE_FILE_NAME))
  })

  it('resolves the same file as the store when both come from the state directory', () => {
    const stateDir = temporaryDirectory()
    vi.stubEnv(STATE_DIR_ENV_VAR, stateDir)

    const store = openEventStore()
    openStores.push(store)
    const counters = openCounterAccessor(store.filePath)
    counters.recordPendingCountSnapshot()

    expect(counters.filePath).toBe(store.filePath)
    expect(counters.schemaVersion).toBe(store.schemaVersion)
    // The store is untouched by a counter write and still reads its own log.
    expect(store.readSessionSummaries()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Flushing
// ---------------------------------------------------------------------------

describe('flushing (PRD 10 stopping state, HC-FR-10)', () => {
  it('leaves a copy of the single database file complete, and changes no value', () => {
    const { filePath } = openTemporaryLog()
    const counters = openCounterAccessor(filePath)
    counters.recordDashboardOpen()
    counters.recordToastDelivery()

    counters.flush()

    expect(valuesByName(counters.read())).toEqual({
      dashboard_opens: 1,
      toast_deliveries: 1,
      deep_link_opens: 0,
      pending_count_snapshots: 0,
    })

    // A copy of the one file, taken while the connection is still open, carries
    // both counts: the write-ahead log has been folded back in, so a clean
    // shutdown does not need anything else on disk.
    const copyPath = path.join(temporaryDirectory(), 'copy.db')
    copyFileSync(filePath, copyPath)
    const rows: { value: number }[] = []
    withDatabase(copyPath, (db) => {
      rows.push(...db.prepare<[], { value: number }>('SELECT value FROM counters ORDER BY name').all())
    })
    expect(rows.map((row) => row.value).reduce((total, value) => total + value, 0)).toBe(2)

    // Flushing again is a no-op, and so is closing twice.
    expect(() => counters.flush()).not.toThrow()
    counters.close()
    expect(() => counters.close()).not.toThrow()
  })

  it('is not needed for durability, so a value survives without it', () => {
    const { filePath } = openTemporaryLog()
    const counters = openCounterAccessor(filePath)
    counters.recordPendingCountSnapshot()
    // No flush: the write is already committed, and a caller that forgets to flush
    // must not lose a number.
    counters.close()

    const reopened = openCounterAccessor(filePath)
    expect(valuesByName(reopened.read())['pending_count_snapshots']).toBe(1)
  })
})
