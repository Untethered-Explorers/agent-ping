// Retention pruning against a real better-sqlite3 file (EL-FR-09, PRD 16 #8).
//
//   npm test -- tests/storage/retention.test.ts
//
// The rule under test is three rules in a fixed order, and each has a boundary
// that a happy-path test would never reach:
//
//   1. The age rule prunes at the cutoff, inclusively. A row that occurred
//      exactly thirty days before the prune instant is pruned; a second older row
//      in a small session is not, because rule 2 applies to it.
//   2. The per-session floor keeps the most recent five hundred events of every
//      session and wins over the age rule, and it is counted per session: 300 old
//      events in each of three sessions are 900 rows and every one is inside a
//      session's floor.
//   3. The pending protection keeps an unacknowledged, unresolved needs-you row at
//      any age, even when the row is far outside its session's floor. The tests
//      also pin the other side of that line, because a protection with no edge is
//      an accident: a block that has been resolved or acknowledged is no longer a
//      pending item and ages out like any other history row.
//
// Every database is a real file in a fresh temporary directory and is closed and
// removed after each test, because a leaked native handle makes a later migration
// or prune assertion fail for the wrong reason. Events are inserted through the
// store's own accessor, not by writing rows directly, so what is pruned is what
// the product would really have stored. The events table is then read back through
// a second connection, because the store API deliberately has no read-events
// accessor and a test that reached into the store's handle would be the first step
// towards giving one out.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { DATABASE_FILE_NAME, STATE_DIR_ENV_VAR } from '@/storage/paths'
import { openEventStore, type EventStore, type NewEvent } from '@/storage/eventStore'
import {
  DEFAULT_RETENTION_POLICY,
  PER_SESSION_FLOOR,
  RETENTION_DAYS,
  pruneEvents,
  retentionCutoff,
} from '@/storage/retention'
import { removeTree } from '../helpers/remove-tree'

// ---------------------------------------------------------------------------
// A fixed clock, so every boundary in this file is reproducible
// ---------------------------------------------------------------------------

const NOW = '2026-09-26T12:00:00.000Z'
const DAY_MS = 86_400_000

/** An occurrence time `days` before NOW, offset by `minutes` so a run of events stays ordered and distinct. */
function occurred(days: number, minutes = 0): string {
  return new Date(Date.parse(NOW) - days * DAY_MS + minutes * 60_000).toISOString()
}

const AT_BOUNDARY = occurred(RETENTION_DAYS)
const A_DAY_OLDER_THAN_THE_BOUNDARY = occurred(RETENTION_DAYS + 1)

interface StoredEvent {
  readonly eventId: string
  readonly sessionId: string
  readonly occurredAt: string
}

/** One event for the store, defaulted to a needs-you block and overridable per test. */
function event(
  sessionId: string,
  occurredAt: string,
  overrides: Partial<NewEvent> = {},
): NewEvent {
  return {
    harness: 'opencode',
    sessionId,
    repoShortName: 'agent-ping',
    repoFullPath: '/home/dev/Projects/agent-ping',
    rawEventType: 'permission.asked',
    class: 'needs-you',
    subtype: null,
    occurredAt,
    receivedAt: occurredAt,
    dedupeKey: `opencode:${sessionId}:${occurredAt}`,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const temporaryDirectories: string[] = []
const openStores: EventStore[] = []
const temporaryFilePaths: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent-ping-retention-'))
  temporaryDirectories.push(directory)
  return directory
}

function temporaryFilePath(): string {
  const filePath = path.join(temporaryDirectory(), DATABASE_FILE_NAME)
  temporaryFilePaths.push(filePath)
  return filePath
}

/** A store in a fresh temporary directory, and the file it opened. */
function openTemporaryStore(): { store: EventStore; filePath: string } {
  const filePath = temporaryFilePath()
  const store = openEventStore({ filePath })
  openStores.push(store)
  return { store, filePath }
}

afterEach(() => {
  for (const store of openStores.splice(0)) store.close()
  for (const directory of temporaryDirectories.splice(0)) {
    removeTree(directory)
  }
  temporaryFilePaths.length = 0
  vi.unstubAllEnvs()
})

/**
 * A second connection for reading the events table back, closed before the call
 * returns, so the store API stays closed and this file leaks no handle of its own.
 */
function readEvents(filePath: string): readonly StoredEvent[] {
  const db = new Database(filePath, { timeout: 5_000 })
  try {
    return db
      .prepare<[], { event_id: string; session_id: string; occurred_at: string }>(
        'SELECT event_id, session_id, occurred_at FROM events ORDER BY occurred_at ASC, event_id ASC',
      )
      .all()
      .map((row) => ({ eventId: row.event_id, sessionId: row.session_id, occurredAt: row.occurred_at }))
  } finally {
    db.close()
  }
}

function eventIdsFor(filePath: string, sessionId: string): readonly string[] {
  return readEvents(filePath)
    .filter((row) => row.sessionId === sessionId)
    .map((row) => row.eventId)
}

/**
 * Insert a run of events into one session, oldest first.
 *
 * `daysAgo[i]` is how many days before NOW the i-th event occurred, and the
 * minute offset keeps every timestamp in the run distinct so the floor's ordering
 * tie-break is never what decides a test.
 */
function insertRun(store: EventStore, sessionId: string, daysAgo: readonly number[]): readonly string[] {
  return daysAgo.map((days, index) => {
    const result = store.insertEvent(
      event(sessionId, occurred(days, index), {
        class: 'fyi',
        subtype: 'error',
        rawEventType: 'tool.error',
      }),
    )
    return result.event.eventId
  })
}

/** `count` events one day old, the recent bulk of a session sitting above its floor. */
function recentBulk(count: number): number[] {
  return Array.from({ length: count }, () => 1)
}

// ---------------------------------------------------------------------------
// The cutoff
// ---------------------------------------------------------------------------

describe('the retention cutoff (EL-FR-09)', () => {
  it('ships thirty days and five hundred per session, and applies the floor to the age rule', () => {
    expect(DEFAULT_RETENTION_POLICY).toEqual({ retentionDays: 30, perSessionFloor: 500 })
    expect([RETENTION_DAYS, PER_SESSION_FLOOR]).toEqual([30, 500])
  })

  it('is the first prunable instant, so an event exactly at the cutoff is pruned', () => {
    expect(retentionCutoff(NOW)).toBe('2026-08-27T12:00:00.000Z')
    // One millisecond inside the window is still inside it.
    expect(retentionCutoff(NOW, 30)).toBe(occurred(30))
  })

  it('refuses an unreadable instant rather than computing a cutoff that prunes everything', () => {
    expect(() => retentionCutoff('not-a-timestamp')).toThrow(/parseable ISO 8601 UTC instant/)
    expect(() => retentionCutoff(NOW, 0)).toThrow(/whole number of at least 1/)
  })
})

// ---------------------------------------------------------------------------
// The age rule and the boundary
// ---------------------------------------------------------------------------

describe('the age rule boundary (EL-FR-09)', () => {
  it('prunes a row exactly at the boundary and keeps one a day older on the per-session floor', () => {
    const { store, filePath } = openTemporaryStore()

    // A session with 501 events: the 500 most recent sit inside the floor and the
    // oldest is exactly at the cutoff, so the boundary is the only thing that can
    // decide it.
    const bulkSession = 'ses_bulky'
    const boundaryId = insertRun(store, bulkSession, [RETENTION_DAYS, ...recentBulk(500)])[0] as string

    // A session with three events, one of them a day older than the boundary. Age
    // alone would prune both old rows; the floor is what keeps them, because three
    // events is fewer than the floor of five hundred.
    const smallSession = 'ses_small'
    const oldIds = insertRun(store, smallSession, [RETENTION_DAYS + 1, RETENTION_DAYS + 1, 2])
    const oldId = oldIds[0] as string

    // Both rows are really in the log before the prune, at the two instants this
    // test is about, so a later assertion that one survived means what it says.
    const before = readEvents(filePath)
    expect(before.find((row) => row.eventId === boundaryId)?.occurredAt).toBe(AT_BOUNDARY)
    expect(before.find((row) => row.eventId === oldId)?.occurredAt).toBe(A_DAY_OLDER_THAN_THE_BOUNDARY)

    const result = pruneEvents({ filePath, now: NOW })

    expect(result.cutoff).toBe(AT_BOUNDARY)
    expect(result.policy).toEqual({ retentionDays: 30, perSessionFloor: 500 })
    expect(result.prunedEventIds).toEqual([boundaryId])
    expect(result.prunedCount).toBe(1)

    // The boundary row is gone and the floor is still exactly satisfied.
    const bulky = readEvents(filePath).filter((row) => row.sessionId === bulkSession)
    expect(bulky).toHaveLength(500)
    expect(bulky.map((row) => row.eventId)).not.toContain(boundaryId)
    expect(readEvents(filePath).find((row) => row.eventId === boundaryId)).toBeUndefined()

    // The a-day-older row survived because its session is under the floor, and the
    // floor is what saved it, not its age: it is still there, at its own old
    // timestamp.
    expect(eventIdsFor(filePath, smallSession)).toEqual(oldIds)
    expect(readEvents(filePath).find((row) => row.eventId === oldId)?.occurredAt).toBe(
      A_DAY_OLDER_THAN_THE_BOUNDARY,
    )
    expect(result.keptPendingCount).toBe(0)

    // A session summary outlives its rows, so pruning never orphans one.
    expect(store.readSessionSummaries().map((row) => row.sessionId).sort()).toEqual([bulkSession, smallSession])
  })

  it('keeps the five hundred most recent events of a session and prunes the oldest, however old they all are', () => {
    const { store, filePath } = openTemporaryStore()
    const sessionId = 'ses_all_old'
    // 501 events, all of them a hundred days old. Age alone would prune all 501.
    const ids = insertRun(store, sessionId, Array.from({ length: 501 }, () => 100))

    const result = pruneEvents({ filePath, now: NOW })

    expect(result.prunedEventIds).toEqual([ids[0]])
    const remaining = readEvents(filePath)
    expect(remaining).toHaveLength(500)
    // The survivors are the newest 500: the oldest of them is the second-oldest
    // event that was ever stored.
    expect(remaining[0]?.eventId).toBe(ids[1])
    expect(remaining.map((row) => row.eventId)).not.toContain(ids[0])
  })

  it('counts the floor per session, so old history in three sessions is all inside three floors', () => {
    const { store, filePath } = openTemporaryStore()
    const sessions = ['ses_one', 'ses_two', 'ses_three']
    for (const sessionId of sessions) {
      insertRun(store, sessionId, Array.from({ length: 300 }, () => 100))
    }

    const result = pruneEvents({ filePath, now: NOW })

    // 900 rows on disk, none of them prunable, because no session reaches its own
    // floor. A global cap would have deleted 400 of them.
    expect(result.prunedEventIds).toEqual([])
    expect(readEvents(filePath)).toHaveLength(900)
    for (const sessionId of sessions) {
      expect(eventIdsFor(filePath, sessionId)).toHaveLength(300)
    }
  })

  it('is idempotent, because a prune that ran twice must not delete anything twice', () => {
    const { store, filePath } = openTemporaryStore()
    insertRun(store, 'ses_bulky', [RETENTION_DAYS, ...recentBulk(500)])

    const first = pruneEvents({ filePath, now: NOW })
    const second = pruneEvents({ filePath, now: NOW })

    expect(first.prunedCount).toBe(1)
    expect(second.prunedCount).toBe(0)
    expect(second.prunedEventIds).toEqual([])
    expect(readEvents(filePath)).toHaveLength(500)
  })

  it('applies configurable numbers rather than the shipped ones', () => {
    const { store, filePath } = openTemporaryStore()
    const sessionId = 'ses_configured'
    const ids = insertRun(store, sessionId, [2, 1.5, 0.9, 0.2])

    // A one-day window with a floor of two: the two oldest rows are candidates by
    // age and both sit outside the floor, so both go. The same shape of rule, two
    // different numbers, which is what makes this a boundary test rather than a
    // rehearsal of the defaults.
    const result = pruneEvents({ filePath, now: NOW, retentionDays: 1, perSessionFloor: 2 })

    expect(result.policy).toEqual({ retentionDays: 1, perSessionFloor: 2 })
    expect(result.prunedEventIds).toEqual([ids[0], ids[1]])
    expect(readEvents(filePath).map((row) => row.eventId)).toEqual([ids[2], ids[3]])
  })

  it('refuses a floor SQLite would read as no limit, before it opens the file', () => {
    const { filePath } = openTemporaryStore()

    expect(() => pruneEvents({ filePath, now: NOW, perSessionFloor: -1 })).toThrow(
      /perSessionFloor must be a whole number of at least 0/,
    )
    expect(() => pruneEvents({ filePath, now: NOW, perSessionFloor: 2.5 })).toThrow(/perSessionFloor/)
  })
})

// ---------------------------------------------------------------------------
// The pending protection
// ---------------------------------------------------------------------------

describe('the pending protection (EL-FR-09, EL-FR-08)', () => {
  it('keeps an unacknowledged pending item at any age, and prunes the settled rows beside it', () => {
    const { store, filePath } = openTemporaryStore()
    const sessionId = 'ses_aged'
    const ancient = (minutes: number): string => occurred(200, minutes)

    // Four rows two hundred days old, all outside the 500 most recent because
    // six hundred recent rows sit above them, so age and the floor alone would
    // prune all four.
    const pending = store.insertEvent(event(sessionId, ancient(0)))
    const resolved = store.insertEvent(event(sessionId, ancient(1)))
    const acknowledged = store.insertEvent(event(sessionId, ancient(2)))
    const fyi = store.insertEvent(
      event(sessionId, ancient(3), { class: 'fyi', subtype: 'error', rawEventType: 'tool.error' }),
    )
    insertRun(store, sessionId, recentBulk(600))

    // A pending item is unacknowledged and unresolved, so the harness reports the
    // resolution.
    expect(store.markResolved(resolved.event.eventId).outcome).toBe('applied')
    // An acknowledgement can only be made while the block is still unresolved.
    expect(store.markAcknowledged(acknowledged.event.eventId).outcome).toBe('applied')
    // The pending item is exactly the one nothing has touched.
    expect(store.readPending().map((item) => item.eventId)).toEqual([pending.event.eventId])

    const result = pruneEvents({ filePath, now: NOW })

    // The three settled rows aged out. The pending item did not, and it is
    // reported rather than left for a reader to infer.
    expect(result.prunedEventIds).toEqual([resolved.event.eventId, acknowledged.event.eventId, fyi.event.eventId])
    expect(result.keptPendingCount).toBe(1)

    const survivors = readEvents(filePath)
    expect(survivors).toHaveLength(601)
    expect(survivors.map((row) => row.eventId)).toContain(pending.event.eventId)
    // Still the one pending item, and still pending: pruning did not clear it or
    // change its state, because retention has no business doing either (EL-FR-08).
    expect(store.readPending().map((item) => item.eventId)).toEqual([pending.event.eventId])
    expect(store.readSessionSummaries()[0]?.pendingCount).toBe(1)
  })

  it('keeps a pending item in a session that is entirely old, where the floor alone would have kept it anyway', () => {
    const { store, filePath } = openTemporaryStore()
    const sessionId = 'ses_quiet'
    const pending = store.insertEvent(event(sessionId, occurred(200)))

    const result = pruneEvents({ filePath, now: NOW })

    // Three rules, only the third of which is in play here, and the honest reading
    // of the result: the floor protected this row, so the protection count is zero.
    expect(result.prunedEventIds).toEqual([])
    expect(result.keptPendingCount).toBe(0)
    expect(readEvents(filePath).map((row) => row.eventId)).toEqual([pending.event.eventId])
  })

  it('prunes a pending item once it is no longer pending, because the protection follows the pending set', () => {
    const { store, filePath } = openTemporaryStore()
    const sessionId = 'ses_cleared'
    const block = store.insertEvent(event(sessionId, occurred(200)))
    insertRun(store, sessionId, recentBulk(600))

    expect(pruneEvents({ filePath, now: NOW }).prunedEventIds).toEqual([])

    // The developer acknowledged it, so it left the pending set (EL-FR-08), and the
    // age rule applies to it exactly as it does to any other history row.
    expect(store.markAcknowledged(block.event.eventId).outcome).toBe('applied')
    expect(store.readPending()).toEqual([])

    const afterAck = pruneEvents({ filePath, now: NOW })
    expect(afterAck.prunedEventIds).toEqual([block.event.eventId])
    expect(afterAck.keptPendingCount).toBe(0)
    expect(readEvents(filePath)).toHaveLength(600)
  })
})

// ---------------------------------------------------------------------------
// How the module reaches the file
// ---------------------------------------------------------------------------

describe('how retention reaches the durable log (EL-FR-11)', () => {
  it('resolves the database file from the state directory when no file is given', () => {
    const stateDir = temporaryDirectory()
    vi.stubEnv(STATE_DIR_ENV_VAR, stateDir)

    const result = pruneEvents({ now: NOW })

    expect(result.filePath).toBe(path.join(stateDir, DATABASE_FILE_NAME))
    expect(result.schemaVersion).toBe(1)
    expect(result.rebuiltFromMigrations).toBe(false)
  })

  it('prunes while the store holds the same file open, which is how the hub runs it', () => {
    const { store, filePath } = openTemporaryStore()
    const ids = insertRun(store, 'ses_live', [RETENTION_DAYS, ...recentBulk(500)])

    // The store's connection is open for the whole prune, so this is the WAL
    // two-writer case rather than a tidy single-connection test.
    const result = pruneEvents({ filePath, now: NOW })

    expect(result.prunedEventIds).toEqual([ids[0]])
    expect(result.schemaVersion).toBe(store.schemaVersion)
    // The store is still usable afterwards, and still holds the same file.
    expect(store.readSessionSummaries()).toHaveLength(1)
    expect(store.insertEvent(event('ses_live', occurred(0, 1))).outcome).toBe('inserted')
    expect(store.readPending()).toHaveLength(1)
  })

  it('reports a file it had to rebuild rather than refusing to prune it', () => {
    const filePath = temporaryFilePath()
    // Bytes that are not a database at all, the same shape the rebuild path in
    // src/storage/db.ts exists for.
    writeFileSync(filePath, 'this file is not a database\n'.repeat(64))

    // Rebuild, do not refuse: a maintenance path that threw here would leave the
    // log growing forever on a machine whose file was truncated by a bad shutdown
    // (APX-CON-03).
    const result = pruneEvents({ filePath, now: NOW })

    expect(result.rebuiltFromMigrations).toBe(true)
    expect(result.prunedEventIds).toEqual([])
    expect(result.schemaVersion).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// What the feature must not do (PRD 6.2, APX-CON-12)
// ---------------------------------------------------------------------------

describe('what the retention and counter sources do not do', () => {
  const storageDir = path.resolve(process.cwd(), 'src/storage')
  const source = (name: string): string => readFileSync(path.join(storageDir, name), 'utf8')
  const retentionSource = source('retention.ts')
  const countersSource = source('counters.ts')

  it('reads the sources at all, so the scans below are not vacuous', () => {
    expect(retentionSource.length).toBeGreaterThan(0)
    expect(countersSource.length).toBeGreaterThan(0)
  })

  it('imports nothing that could open a socket, spawn a process or render a surface', () => {
    const allowed = new Set(['node:fs', 'node:path', 'better-sqlite3'])
    for (const [name, text] of [
      ['retention.ts', retentionSource],
      ['counters.ts', countersSource],
    ] as const) {
      const specifiers = [...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '')
      for (const specifier of specifiers) {
        if (specifier?.startsWith('.')) continue
        expect(allowed.has(specifier), `${name} imports ${specifier}`).toBe(true)
      }
    }
  })

  it('calls no network or process API', () => {
    const forbidden = /(?<![\w.])(fetch|WebSocket|XMLHttpRequest|spawn|spawnSync|execFile|createServer|listen)\s*\(/
    for (const [name, text] of [
      ['retention.ts', retentionSource],
      ['counters.ts', countersSource],
    ] as const) {
      expect(forbidden.test(text), `${name} calls a network or process API`).toBe(false)
    }
  })

  it('decides what to keep from the event columns and nothing else', () => {
    // The exact set of events-table columns retention reads. Every one of them is
    // metadata needed to decide a row's age, identity or pending state; a column
    // that could describe what was said could not appear here without failing this
    // test, which is the storage half of ADR-003 for this module.
    const columns = new Set(
      [...retentionSource.matchAll(/\b(?:events|recent)\.(\w+)/g)].map((match) => match[1] ?? ''),
    )
    expect([...columns].sort()).toEqual([
      'ack_state',
      'class',
      'event_id',
      'occurred_at',
      'resolution_state',
      'session_id',
    ])
  })

  it('resolves its file through paths.js rather than assembling a path of its own', () => {
    for (const [name, text] of [
      ['retention.ts', retentionSource],
      ['counters.ts', countersSource],
    ] as const) {
      expect(text, name).toMatch(/databaseFilePath/)
      expect(text, name).not.toMatch(/\bjoin\(|resolve\(/)
    }
  })
})
