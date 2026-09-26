// The durable log against a real better-sqlite3 file (EL-FR-11, EL-FR-01, EL-FR-08).
//
//   npm test -- tests/storage/eventStore.test.ts
//
// What is asserted here:
//
//   - The store resolves its file from the overridable state directory, creates
//     both with owner-only permissions, and writes nothing else into that
//     directory.
//   - Opening the same file twice applies the migrations once and destroys
//     nothing.
//   - A database file that cannot be read is deleted and recreated from the
//     migrations, and the store says so, rather than refusing to start
//     (APX-CON-03) or losing the fact silently (APX-FR-02).
//   - An inserted event round-trips into a pending row and a session summary.
//   - Every read shape has exactly the approved field set, which is the API half
//     of the privacy boundary: the schema cannot hold content, and neither can
//     anything this module hands out.
//   - The accessor's surface is exactly the approved typed accessors plus a
//     close, so there is no raw query escape hatch to grow. Two bounded reads
//     (readSession, readEventHistory) were added for the read routes of HC-FR-02.
//   - Resolution and acknowledgement are idempotent, and acknowledging a block
//     the harness already resolved is refused distinguishably and changes
//     nothing (HC-FR-05, EL-FR-08).
//   - The sources in src/storage open no socket, spawn no process and render no
//     surface.
//
// Every database is a real file in a fresh temporary directory, opened and
// closed inside the test, because a leaked native handle makes a later
// migration test fail for the wrong reason.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { DATABASE_FILE_NAME, STATE_DIR_ENV_VAR, resolveStateDir } from '@/storage/paths'
import {
  openEventStore,
  type EventStore,
  type NewEvent,
  type PendingItem,
  type SessionSummary,
} from '@/storage/eventStore'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** An envelope-shaped insert, which is the whole field set of EL-FR-01. */
function needsYouBlock(overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    harness: 'opencode',
    sessionId: 'ses_block_01',
    repoShortName: 'agent-ping',
    repoFullPath: '/home/dev/Projects/agent-ping',
    rawEventType: 'permission.asked',
    class: 'needs-you',
    subtype: null,
    occurredAt: '2026-09-26T09:00:00.000Z',
    receivedAt: '2026-09-26T09:00:00.250Z',
    dedupeKey: 'opencode:ses_block_01:block-7',
    ...overrides,
  }
}

function finishedTurn(overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    harness: 'opencode',
    sessionId: 'ses_finished_01',
    repoShortName: 'knowledge-dungeon',
    repoFullPath: '/home/dev/Projects/knowledge-dungeon',
    rawEventType: 'session.status',
    class: 'finished',
    occurredAt: '2026-09-26T08:00:00.000Z',
    receivedAt: '2026-09-26T08:00:00.100Z',
    dedupeKey: 'opencode:ses_finished_01:idle-3',
    ...overrides,
  }
}

const temporaryDirectories: string[] = []
const openStores: EventStore[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent-ping-store-'))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * Open a store and register it for cleanup. Every store in this file goes
 * through here or through openTemporaryStore, because a better-sqlite3 handle
 * that outlives its test holds a native descriptor open and makes a later
 * migration or rebuild assertion fail for the wrong reason.
 */
function openStoreAt(filePath: string): EventStore {
  const store = openEventStore({ filePath })
  openStores.push(store)
  return store
}

/** A store in a fresh temporary directory. */
function openTemporaryStore(): EventStore {
  return openStoreAt(path.join(temporaryDirectory(), DATABASE_FILE_NAME))
}

afterEach(() => {
  for (const store of openStores.splice(0)) store.close()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
})

/**
 * A second connection for schema introspection, closed before the call returns,
 * so the store API stays closed and this test file leaks no handle of its own.
 */
function withDatabase(filePath: string, inspect: (db: Database.Database) => void): void {
  const db = new Database(filePath, { timeout: 5_000 })
  try {
    inspect(db)
  } finally {
    db.close()
  }
}

/**
 * Linux exposes this process's open descriptors as symlinks, which is the only
 * portable-enough way to prove the rebuild closes the handle it gave up on. The
 * test that uses it is skipped where that directory does not exist.
 */
const LINUX_FD_DIRECTORY = '/proc/self/fd'

function openDescriptorsFor(fileName: string): number {
  let open = 0
  for (const entry of readdirSync(LINUX_FD_DIRECTORY)) {
    try {
      if (readlinkSync(path.join(LINUX_FD_DIRECTORY, entry)).includes(fileName)) open += 1
    } catch {
      // The descriptor closed while the directory was being read.
    }
  }
  return open
}

// ---------------------------------------------------------------------------
// Opening the store
// ---------------------------------------------------------------------------

describe('resolving the database file (EL-FR-11, IO-FR-07)', () => {
  it('resolves the database file from the state directory the environment variable names', () => {
    const stateDir = temporaryDirectory()
    vi.stubEnv(STATE_DIR_ENV_VAR, stateDir)

    const store = openEventStore()
    openStores.push(store)

    expect(store.filePath).toBe(path.join(stateDir, DATABASE_FILE_NAME))
    expect(existsSync(store.filePath)).toBe(true)
    expect(store.schemaVersion).toBe(1)
    expect(store.rebuiltFromMigrations).toBe(false)
  })

  it('resolves the platform state directory when nothing overrides it', () => {
    const home = '/home/dev'
    expect(resolveStateDir({}, 'linux', home)).toBe('/home/dev/.local/state/agent-ping')
    expect(resolveStateDir({ XDG_STATE_HOME: '/xdg/state' }, 'linux', home)).toBe('/xdg/state/agent-ping')
    expect(resolveStateDir({}, 'darwin', home)).toBe('/home/dev/Library/Application Support/agent-ping')
    expect(resolveStateDir({ LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }, 'win32', home)).toBe(
      path.join('C:\\Users\\dev\\AppData\\Local', 'agent-ping'),
    )
    // The override wins over every platform rule, and a quoted ~ resolves.
    expect(resolveStateDir({ [STATE_DIR_ENV_VAR]: '~/state' }, 'linux', home)).toBe('/home/dev/state')
    expect(resolveStateDir({ [STATE_DIR_ENV_VAR]: '/tmp/explicit' }, 'darwin', home)).toBe('/tmp/explicit')
  })

  it.skipIf(process.platform === 'win32')('creates the state directory and the file owner-only', () => {
    const stateDir = path.join(temporaryDirectory(), 'state')
    vi.stubEnv(STATE_DIR_ENV_VAR, stateDir)

    const store = openEventStore()
    openStores.push(store)
    store.insertEvent(needsYouBlock())
    store.close()

    expect(statSync(stateDir).mode & 0o777).toBe(0o700)
    expect(statSync(store.filePath).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('tightens an existing state directory to owner-only', () => {
    const wide = path.join(temporaryDirectory(), 'state')
    mkdirSync(wide, { recursive: true, mode: 0o755 })
    chmodSync(wide, 0o755)
    vi.stubEnv(STATE_DIR_ENV_VAR, wide)

    const store = openEventStore()
    openStores.push(store)
    store.close()

    // A directory created by an older install, or by a script that ran with a
    // wide umask, is tightened rather than trusted.
    expect(statSync(wide).mode & 0o777).toBe(0o700)
  })

  it('writes nothing into the state directory except the database file', () => {
    const stateDir = temporaryDirectory()
    vi.stubEnv(STATE_DIR_ENV_VAR, stateDir)

    const store = openEventStore()
    openStores.push(store)
    store.insertEvent(needsYouBlock())
    store.close()

    // No log file, no export, no sidecar of its own: the local log and its
    // formatting belong to packaging-engineer (IO-FR-09), and a second file
    // would be a second place for content to land. SQLite's own write-ahead log
    // is removed when the last connection closes.
    expect(readdirSync(stateDir).sort()).toEqual([DATABASE_FILE_NAME])
  })

  it('applies the migrations once across two opens of the same path, keeping what was stored', () => {
    const filePath = path.join(temporaryDirectory(), DATABASE_FILE_NAME)

    const first = openStoreAt(filePath)
    const inserted = first.insertEvent(needsYouBlock())
    const firstVersion = first.schemaVersion
    first.close()

    const second = openStoreAt(filePath)
    expect(second.schemaVersion).toBe(firstVersion)
    expect(second.readPending()).toEqual([{ ...inserted.event, harness: 'opencode', repoShortName: 'agent-ping', repoFullPath: '/home/dev/Projects/agent-ping' }])

    withDatabase(filePath, (db) => {
      const versionRows = db
        .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM schema_version')
        .get()
      expect(versionRows?.count).toBe(1)
    })
  })

  it.each([
    [
      'bytes that are not a database at all',
      (filePath: string): void => {
        writeFileSync(filePath, 'this file is not a database\n'.repeat(64))
      },
    ],
    [
      'a database header with no pages behind it',
      (filePath: string): void => {
        writeFileSync(
          filePath,
          Buffer.concat([Buffer.from('SQLite format 3\0', 'binary'), Buffer.alloc(4096)]),
        )
      },
    ],
  ])(
    'recreates the database from migrations when the file holds %s',
    (_label: string, write: (filePath: string) => void) => {
      const filePath = path.join(temporaryDirectory(), DATABASE_FILE_NAME)
      const first = openStoreAt(filePath)
      first.insertEvent(needsYouBlock())
      first.close()

      write(filePath)

      // If the rebuild threw instead of returning, this line is where the test
      // fails; the assertions below are on the handle that comes back.
      const rebuilt = openStoreAt(filePath)
      expect(rebuilt.rebuiltFromMigrations).toBe(true)
      expect(rebuilt.schemaVersion).toBe(1)
      // History recorded only in the lost file is gone, and reported: the hub
      // surfaces this rather than pretending the log was never there (APX-FR-02).
      expect(rebuilt.readPending()).toEqual([])
      expect(rebuilt.readSessionSummaries()).toEqual([])

      // The schema came back complete, so the store is usable again rather than
      // half-alive.
      withDatabase(filePath, (db) => {
        const tables = db
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all()
          .map((row) => row.name)
        expect(tables).toEqual(['counters', 'events', 'schema_version', 'sessions'])
      })

      rebuilt.insertEvent(needsYouBlock())
      expect(rebuilt.readPending()).toHaveLength(1)
    },
  )

  it
    .skipIf(!existsSync(LINUX_FD_DIRECTORY))
    .each([
      [
        'a file that is not a database at all',
        (filePath: string): void => {
          writeFileSync(filePath, 'this file is not a database\n'.repeat(64))
        },
      ],
      [
        'a readable database whose schema this store cannot apply itself to',
        (filePath: string): void => {
          // Valid SQLite, wrong shape: CREATE TABLE IF NOT EXISTS is a no-op against
          // the existing table, and the version record then fails to insert. This is
          // the case that reaches past the pragmas, so it is the case where the
          // handle that gave up has to be closed rather than abandoned.
          rmSync(filePath, { force: true })
          withDatabase(filePath, (db) => {
            db.exec('CREATE TABLE schema_version (version TEXT NOT NULL PRIMARY KEY)')
          })
        },
      ],
    ])('leaks no descriptor when it replaces %s', (_label: string, write: (filePath: string) => void) => {
    const filePath = path.join(temporaryDirectory(), DATABASE_FILE_NAME)
    expect(openDescriptorsFor(DATABASE_FILE_NAME)).toBe(0)

    const first = openStoreAt(filePath)
    first.insertEvent(needsYouBlock())
    first.close()

    write(filePath)
    const rebuilt = openStoreAt(filePath)
    expect(rebuilt.rebuiltFromMigrations).toBe(true)
    rebuilt.insertEvent(needsYouBlock())
    rebuilt.close()

    // A handle left open on the deleted file keeps a descriptor alive pointing at
    // "(deleted)", which is why the match is on the name and not on the whole path.
    expect(openDescriptorsFor(DATABASE_FILE_NAME)).toBe(0)
  })

  it('is safe to close twice', () => {
    const store = openTemporaryStore()
    store.close()
    expect(() => store.close()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// The accessors
// ---------------------------------------------------------------------------

describe('the store surface', () => {
  it('exposes exactly the approved accessors, with no query escape hatch', () => {
    const store = openTemporaryStore()
    // readSession and readEventHistory were added for the two bounded read routes
    // of HC-FR-02 (`GET /api/sessions/:id` and `GET /api/events`). The list is
    // still closed: two typed accessors grew, and no way to run a statement did.
    expect(Object.keys(store).sort()).toEqual([
      'close',
      'filePath',
      'insertEvent',
      'markAcknowledged',
      'markResolved',
      'readEventHistory',
      'readPending',
      'readSession',
      'readSessionSummaries',
      'rebuiltFromMigrations',
      'schemaVersion',
    ])
  })

  it('reads the file path for the doctor command without exposing the handle', () => {
    const store = openTemporaryStore()
    expect(typeof store.filePath).toBe('string')
    expect('db' in store).toBe(false)
    expect('prepare' in store).toBe(false)
    expect('exec' in store).toBe(false)
  })
})

describe('inserting an event (EL-FR-01)', () => {
  it('round-trips an event into a session summary and a pending row', () => {
    const store = openTemporaryStore()

    const inserted = store.insertEvent(needsYouBlock())

    expect(inserted.outcome).toBe('inserted')
    expect(inserted.event.eventId).toMatch(/^[0-9a-f-]{36}$/)

    const pending = store.readPending()
    expect(pending).toEqual([
      {
        ...inserted.event,
        harness: 'opencode',
        repoShortName: 'agent-ping',
        repoFullPath: '/home/dev/Projects/agent-ping',
      },
    ])

    expect(store.readSessionSummaries()).toEqual([
      {
        sessionId: 'ses_block_01',
        harness: 'opencode',
        repoShortName: 'agent-ping',
        repoFullPath: '/home/dev/Projects/agent-ping',
        firstSeenAt: '2026-09-26T09:00:00.000Z',
        lastSeenAt: '2026-09-26T09:00:00.000Z',
        state: 'blocked',
        workSignal: 0,
        pendingCount: 1,
      },
    ])
  })

  it('carries exactly the approved fields out of every read shape', () => {
    const store = openTemporaryStore()
    store.insertEvent(needsYouBlock())
    store.insertEvent(finishedTurn())

    const inserted = store.insertEvent(
      finishedTurn({ sessionId: 'ses_fyi_01', class: 'fyi', subtype: 'token-burn', dedupeKey: 'opencode:ses_fyi_01:burn-1' }),
    )
    expect(Object.keys(inserted.event).sort()).toEqual([
      'ackState',
      'class',
      'dedupeKey',
      'eventId',
      'occurredAt',
      'rawEventType',
      'receivedAt',
      'resolutionState',
      'sessionId',
      'subtype',
    ])

    const pending: PendingItem | undefined = store.readPending()[0]
    expect(Object.keys(pending ?? {}).sort()).toEqual([
      'ackState',
      'class',
      'dedupeKey',
      'eventId',
      'harness',
      'occurredAt',
      'rawEventType',
      'receivedAt',
      'repoFullPath',
      'repoShortName',
      'resolutionState',
      'sessionId',
      'subtype',
    ])

    const summary: SessionSummary | undefined = store.readSessionSummaries()[0]
    expect(Object.keys(summary ?? {}).sort()).toEqual([
      'firstSeenAt',
      'harness',
      'lastSeenAt',
      'pendingCount',
      'repoFullPath',
      'repoShortName',
      'sessionId',
      'state',
      'workSignal',
    ])
  })

  it('records a second event with the same dedupe key as a duplicate, not a second row', () => {
    const store = openTemporaryStore()
    const first = store.insertEvent(needsYouBlock())
    const second = store.insertEvent(needsYouBlock())

    expect(second.outcome).toBe('duplicate')
    expect(second.event).toEqual(first.event)
    expect(store.readPending()).toHaveLength(1)
  })

  it('derives the session state and the turn work signal from the class of the event', () => {
    const store = openTemporaryStore()
    store.insertEvent(needsYouBlock())
    store.insertEvent(
      finishedTurn({ sessionId: 'ses_block_01', repoShortName: 'agent-ping', repoFullPath: '/home/dev/Projects/agent-ping', dedupeKey: 'opencode:ses_block_01:idle-1', occurredAt: '2026-09-26T10:00:00.000Z' }),
    )
    store.insertEvent(
      finishedTurn({ sessionId: 'ses_block_01', repoShortName: 'agent-ping', repoFullPath: '/home/dev/Projects/agent-ping', class: 'fyi', subtype: 'retry', dedupeKey: 'opencode:ses_block_01:retry-1', occurredAt: '2026-09-26T11:00:00.000Z' }),
    )

    const summary = store.readSessionSummaries().find((row) => row.sessionId === 'ses_block_01')
    // blocked, then finished after work, then running again for the retry.
    expect(summary?.state).toBe('running')
    expect(summary?.workSignal).toBe(1)
    expect(summary?.firstSeenAt).toBe('2026-09-26T09:00:00.000Z')
    expect(summary?.lastSeenAt).toBe('2026-09-26T11:00:00.000Z')
    // The block is still pending: nothing has resolved or acknowledged it.
    expect(summary?.pendingCount).toBe(1)
  })

  it('does not let an event that arrives out of order move the recorded session state backwards', () => {
    const store = openTemporaryStore()
    store.insertEvent(finishedTurn())
    store.insertEvent(
      finishedTurn({
        class: 'needs-you',
        dedupeKey: 'opencode:ses_finished_01:block-late',
        occurredAt: '2026-09-26T07:00:00.000Z',
        receivedAt: '2026-09-26T12:00:00.000Z',
      }),
    )

    const summary = store.readSessionSummaries()[0]
    expect(summary?.state).toBe('finished')
    // The late block happened first, so it is the first sighting, and it did not
    // become the recorded state.
    expect(summary?.firstSeenAt).toBe('2026-09-26T07:00:00.000Z')
    expect(summary?.lastSeenAt).toBe('2026-09-26T08:00:00.000Z')
    // The block is still a pending item even though it did not move the state.
    expect(store.readPending()).toHaveLength(1)
  })

  it('leaves the session state alone when a pending item is cleared, because the state is observed', () => {
    const store = openTemporaryStore()
    const inserted = store.insertEvent(needsYouBlock())
    store.markAcknowledged(inserted.event.eventId)

    const summary = store.readSessionSummaries()[0]
    expect(summary?.state).toBe('blocked')
    expect(summary?.pendingCount).toBe(0)
  })

  it('refuses an event the schema does not allow, rather than storing a fourth class', () => {
    const store = openTemporaryStore()
    // The class is read before it is stored, because the session row is derived
    // from it, so the store refuses it by name.
    expect(() =>
      store.insertEvent({ ...needsYouBlock(), class: 'urgent' as NewEvent['class'] }),
    ).toThrow(/unknown event class/)
    // A subtype is only a column value, so the schema's constraint refuses it.
    expect(() =>
      store.insertEvent({ ...needsYouBlock(), class: 'fyi', subtype: 'chat' as NewEvent['subtype'] }),
    ).toThrow(/CHECK/)
    // Neither attempt left anything behind: the insert is one transaction.
    expect(store.readPending()).toEqual([])
    expect(store.readSessionSummaries()).toEqual([])
  })
})

describe('the pending set (EL-FR-08, NT-FR-05)', () => {
  it('lists unresolved, unacknowledged needs-you items oldest first, and nothing else', () => {
    const store = openTemporaryStore()
    const older = store.insertEvent(
      needsYouBlock({ sessionId: 'ses_a', dedupeKey: 'opencode:ses_a:block-1', occurredAt: '2026-09-26T09:00:00.000Z' }),
    )
    const newer = store.insertEvent(
      needsYouBlock({ sessionId: 'ses_b', dedupeKey: 'opencode:ses_b:block-1', occurredAt: '2026-09-26T10:00:00.000Z' }),
    )
    store.insertEvent(finishedTurn({ sessionId: 'ses_c' }))
    store.insertEvent(
      finishedTurn({ sessionId: 'ses_d', class: 'fyi', subtype: 'error', dedupeKey: 'opencode:ses_d:error-1' }),
    )

    expect(store.readPending().map((item) => item.eventId)).toEqual([older.event.eventId, newer.event.eventId])

    store.markResolved(older.event.eventId)
    store.markAcknowledged(newer.event.eventId)
    expect(store.readPending()).toEqual([])
  })
})

describe('resolution and acknowledgement (EL-FR-08, HC-FR-05)', () => {
  it('applies a resolution once and treats a repeated one as an explicit no-op', () => {
    const store = openTemporaryStore()
    const inserted = store.insertEvent(needsYouBlock())

    const first = store.markResolved(inserted.event.eventId)
    expect(first.outcome).toBe('applied')
    expect(first.event?.resolutionState).toBe('resolved')
    expect(store.readPending()).toEqual([])

    const second = store.markResolved(inserted.event.eventId)
    expect(second.outcome).toBe('unchanged')
    expect(second.event?.resolutionState).toBe('resolved')
  })

  it('applies an acknowledgement once and treats a repeated one as an explicit no-op', () => {
    const store = openTemporaryStore()
    const inserted = store.insertEvent(needsYouBlock())

    const first = store.markAcknowledged(inserted.event.eventId)
    expect(first.outcome).toBe('applied')
    expect(first.event?.ackState).toBe('acknowledged')
    expect(store.readPending()).toEqual([])

    const second = store.markAcknowledged(inserted.event.eventId)
    expect(second.outcome).toBe('unchanged')
    expect(second.event?.ackState).toBe('acknowledged')
  })

  it('refuses to acknowledge a block the harness already resolved, and changes nothing', () => {
    const store = openTemporaryStore()
    const inserted = store.insertEvent(needsYouBlock())
    store.markResolved(inserted.event.eventId)

    const refused = store.markAcknowledged(inserted.event.eventId)
    expect(refused.outcome).toBe('conflict')
    expect(refused.event?.ackState).toBe('unacknowledged')
    expect(refused.event?.resolutionState).toBe('resolved')

    // A resolution is recorded whatever the acknowledgement state is: the two
    // facts are independent, so a block resolved after being acknowledged is
    // still recorded as resolved.
    store.markAcknowledged(inserted.event.eventId)
    const afterAck = store.insertEvent(
      needsYouBlock({ sessionId: 'ses_block_01', dedupeKey: 'opencode:ses_block_01:block-8' }),
    )
    store.markAcknowledged(afterAck.event.eventId)
    const resolvedAfterAck = store.markResolved(afterAck.event.eventId)
    expect(resolvedAfterAck.outcome).toBe('applied')
    expect(resolvedAfterAck.event?.ackState).toBe('acknowledged')
  })

  it('reports an acknowledgement of an already acknowledged and since resolved block as the idempotent no-op', () => {
    const store = openTemporaryStore()
    const inserted = store.insertEvent(needsYouBlock())
    store.markAcknowledged(inserted.event.eventId)
    store.markResolved(inserted.event.eventId)

    // The acknowledgement already happened once, so counting it again is the
    // double count EL-FR-08 forbids; the conflict case is for a block the
    // developer never acknowledged.
    expect(store.markAcknowledged(inserted.event.eventId).outcome).toBe('unchanged')
  })

  it('refuses both transitions on a row that is not a needs-you block, and writes nothing', () => {
    // APX-CON-08: the ack route may only mark a pending item acknowledged, and a
    // resolution is a fact about a block. A finished or fyi row is neither, so the
    // class guard refuses the write at the statement and answers with the conflict
    // outcome, which src/domain/pending.ts turns into a distinguishable rejection.
    const store = openTemporaryStore()
    const finished = store.insertEvent(finishedTurn())
    const fyi = store.insertEvent(
      finishedTurn({ sessionId: 'ses_finished_01', class: 'fyi', subtype: 'error', dedupeKey: 'opencode:ses_finished_01:err-1' }),
    )
    for (const row of [finished.event, fyi.event]) {
      expect(store.markAcknowledged(row.eventId)).toEqual({
        outcome: 'conflict',
        event: { ...row, ackState: 'unacknowledged', resolutionState: 'unresolved' },
      })
      expect(store.markResolved(row.eventId)).toEqual({
        outcome: 'conflict',
        event: { ...row, ackState: 'unacknowledged', resolutionState: 'unresolved' },
      })
    }

    // Nothing became pending, and the two facts are still unset on both rows.
    expect(store.readPending()).toEqual([])
    expect(store.readSessionSummaries().every((summary) => summary.pendingCount === 0)).toBe(true)
  })

  it('answers not-found for an identifier that does not exist, without creating anything', () => {
    const store = openTemporaryStore()
    expect(store.markResolved('evt_missing')).toEqual({ outcome: 'not-found', event: null })
    expect(store.markAcknowledged('evt_missing')).toEqual({ outcome: 'not-found', event: null })
    expect(store.readPending()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The two bounded reads HC-FR-02 needs
// ---------------------------------------------------------------------------

describe('one session with its recent events (HC-FR-02)', () => {
  it('returns the same summary shape as the list route, plus newest-first recent events', () => {
    const store = openTemporaryStore()
    const block = store.insertEvent(needsYouBlock())
    const idle = store.insertEvent(
      finishedTurn({
        sessionId: 'ses_block_01',
        repoShortName: 'agent-ping',
        repoFullPath: '/home/dev/Projects/agent-ping',
        dedupeKey: 'opencode:ses_block_01:idle-1',
        occurredAt: '2026-09-26T10:00:00.000Z',
      }),
    )
    const retry = store.insertEvent(
      finishedTurn({
        sessionId: 'ses_block_01',
        repoShortName: 'agent-ping',
        repoFullPath: '/home/dev/Projects/agent-ping',
        class: 'fyi',
        subtype: 'retry',
        dedupeKey: 'opencode:ses_block_01:retry-1',
        occurredAt: '2026-09-26T11:00:00.000Z',
      }),
    )

    const detail = store.readSession('ses_block_01')
    const summary = store.readSessionSummaries()[0]

    // The summary fields are the list route's fields, unchanged.
    expect({ ...detail, recentEvents: undefined }).toEqual(summary)
    expect(Object.keys(detail ?? {}).sort()).toEqual([
      'firstSeenAt',
      'harness',
      'lastSeenAt',
      'pendingCount',
      'recentEvents',
      'repoFullPath',
      'repoShortName',
      'sessionId',
      'state',
      'workSignal',
    ])
    // Newest first: the detail panel asks what just happened.
    expect(detail?.recentEvents.map((event) => event.eventId)).toEqual([
      retry.event.eventId,
      idle.event.eventId,
      block.event.eventId,
    ])
    // And the events are the same shape the bounded history returns.
    expect(detail?.recentEvents[0]).toEqual(retry.event)
  })

  it('answers null for a session that does not exist, and reads nothing else', () => {
    const store = openTemporaryStore()
    store.insertEvent(needsYouBlock())
    expect(store.readSession('ses_missing')).toBeNull()
    expect(store.readSession('')).toBeNull()
  })

  it('does not leak one session into another', () => {
    const store = openTemporaryStore()
    const mine = store.insertEvent(needsYouBlock())
    store.insertEvent(finishedTurn({ sessionId: 'ses_other' }))

    expect(store.readSession('ses_block_01')?.recentEvents.map((event) => event.eventId)).toEqual([
      mine.event.eventId,
    ])
  })
})

describe('bounded event history (HC-FR-02)', () => {
  /** One session with `count` finished events, oldest first. */
  function seedRun(store: EventStore, count: number): void {
    for (let index = 0; index < count; index += 1) {
      store.insertEvent(
        finishedTurn({
          sessionId: 'ses_run',
          dedupeKey: `opencode:ses_run:idle-${index}`,
          occurredAt: new Date(Date.UTC(2026, 8, 26, 0, 0, index)).toISOString(),
        }),
      )
    }
  }

  it('returns the newest events first, in a total order', () => {
    const store = openTemporaryStore()
    seedRun(store, 3)

    const history = store.readEventHistory()
    expect(history.map((event) => event.dedupeKey)).toEqual([
      'opencode:ses_run:idle-2',
      'opencode:ses_run:idle-1',
      'opencode:ses_run:idle-0',
    ])
  })

  it('breaks an occurrence-timestamp tie by row key descending, so a page boundary is stable', () => {
    const store = openTemporaryStore()
    const at = '2026-09-26T09:00:00.000Z'
    const first = store.insertEvent(finishedTurn({ sessionId: 'ses_tie', dedupeKey: 'a', occurredAt: at }))
    const second = store.insertEvent(finishedTurn({ sessionId: 'ses_tie', dedupeKey: 'b', occurredAt: at }))

    const ordered = [first.event.eventId, second.event.eventId].sort().reverse()
    expect(store.readEventHistory().map((event) => event.eventId)).toEqual(ordered)
  })

  it('clamps a limit above the ceiling instead of honouring it, and defaults a nonsense one', () => {
    const store = openTemporaryStore()
    seedRun(store, 5)

    expect(store.readEventHistory({ limit: 2 })).toHaveLength(2)
    // A caller cannot widen the bound, and a caller that asks for everything gets
    // the largest page this product serves rather than an unbounded read.
    expect(store.readEventHistory({ limit: 1_000_000 })).toHaveLength(5)
    expect(store.readEventHistory({ limit: 0 })).toHaveLength(5)
    expect(store.readEventHistory({ limit: -10 })).toHaveLength(5)
    expect(store.readEventHistory({ limit: Number.NaN })).toHaveLength(5)
    expect(store.readEventHistory()).toHaveLength(5)
  })

  it('narrows to one session when asked, and does not answer another session events', () => {
    const store = openTemporaryStore()
    seedRun(store, 2)
    store.insertEvent(finishedTurn({ sessionId: 'ses_elsewhere' }))

    expect(store.readEventHistory({ sessionId: 'ses_run' })).toHaveLength(2)
    expect(store.readEventHistory({ sessionId: 'ses_elsewhere' })).toHaveLength(1)
    expect(store.readEventHistory({ sessionId: 'ses_missing' })).toEqual([])
  })

  it('includes pending blocks, because history is the whole log and not the pending set', () => {
    const store = openTemporaryStore()
    store.insertEvent(needsYouBlock({ occurredAt: '2026-09-26T12:00:00.000Z' }))
    store.insertEvent(finishedTurn({ sessionId: 'ses_finished_01' }))

    expect(store.readEventHistory()[0]?.class).toBe('needs-you')
    expect(store.readEventHistory()).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// What the feature must not do (PRD 6.2, APX-CON-12)
// ---------------------------------------------------------------------------

describe('what the storage sources do not do', () => {
  const storageDir = path.resolve(process.cwd(), 'src/storage')
  const sources = readdirSync(storageDir)
    .filter((name) => name.endsWith('.ts') || name.endsWith('.sql'))
    .map((name) => ({ name, text: readFileSync(path.join(storageDir, name), 'utf8') }))

  it('finds the storage sources at all, so the scan below is not vacuous', () => {
    // Every module in src/storage is listed, so a new one cannot join the scan
    // silently. retention.ts and counters.ts (EL-2) each open the same file with
    // their own connection rather than borrowing the store's handle, which is why
    // they are covered by these two checks as well as by their own suites.
    expect(sources.map((source) => source.name).sort()).toEqual([
      'counters.ts',
      'db.ts',
      'eventStore.ts',
      'paths.ts',
      'retention.ts',
      'schema.sql',
    ])
  })

  it('imports nothing that could open a socket, spawn a process or render a surface', () => {
    const allowed = new Set(['node:crypto', 'node:fs', 'node:os', 'node:path', 'node:url', 'better-sqlite3'])
    for (const source of sources) {
      const specifiers = [...source.text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '')
      for (const specifier of specifiers) {
        if (specifier?.startsWith('.')) continue
        expect(allowed.has(specifier), `${source.name} imports ${specifier}`).toBe(true)
      }
    }
  })

  it('calls no network or process API', () => {
    // SQLite's own exec is db.exec(...), so the lookbehind keeps it and only it
    // out of the match.
    const forbidden = /(?<![\w.])(fetch|WebSocket|XMLHttpRequest|spawn|spawnSync|exec|execSync|execFile|createServer|listen)\s*\(/
    for (const source of sources) {
      expect(forbidden.test(source.text), `${source.name} calls a network or process API`).toBe(false)
    }
  })

  it('never passes a verbose callback to the driver, which would print bound values to a local log', () => {
    for (const source of sources.filter((entry) => entry.name.endsWith('.ts'))) {
      expect(source.text, source.name).not.toMatch(/verbose\s*:/)
    }
  })
})
