// The content-free schema guard (EL-FR-03, EL-FR-02, EL-FR-11, APX-FR-01).
//
//   npm test -- tests/storage/schema.test.ts
//
// This file is the mechanism ADR-003 depends on, not a formality. The claim
// "agent-ping never stores conversation content" is only true because the schema
// cannot hold content, and this is where that becomes falsifiable:
//
//   - Every table's column list is compared against a literal expected set. Not
//     a denylist of forbidden names: a denylist passes the day someone invents
//     `snippet`, `excerpt` or `last_message`, and those are exactly the names a
//     well-meant change picks. Adding any column fails here until a human adds
//     it to the list and accepts that it holds no content.
//   - The column's type, nullability and key position are asserted too, so a
//     column cannot be widened into something it was not reviewed as.
//   - The table list, the index list and the migration record are asserted for
//     the same reason. A table created outside the migration set, or an index
//     on a column nobody vetted, is the same leak by another route.
//   - A name-shape check runs alongside the exact list as a second net, never
//     instead of it.
//   - The guard is itself tested: a real ALTER TABLE that adds a column must
//     make the guard throw. A guard that has been edited until it passes has
//     stopped guarding, so the failing path is exercised, not assumed.
//
// Every database here is a real better-sqlite3 file in a fresh temporary
// directory, closed and removed after the test, because a leaked native handle
// makes a later migration test fail for the wrong reason.
//
// What this file cannot check: that no query, log line or outbound request
// carries content. Those are the ingest payload, metrics payload, history panel
// and local log assertions owned by hub-engineer, dashboard-engineer and
// packaging-engineer. This is the storage half of the boundary.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SqliteDatabase } from '@/storage/db'
import { applyMigrations, openDatabase, readMigrations, readSchemaVersion, type OpenDatabase } from '@/storage/db'
import { removeTree } from '../helpers/remove-tree'

// ---------------------------------------------------------------------------
// The expected schema, written out literally
// ---------------------------------------------------------------------------

interface ExpectedColumn {
  readonly type: 'TEXT' | 'INTEGER'
  readonly notNull: boolean
  readonly primaryKey: boolean
}

/**
 * Every column of every table, spelled out. The order is the order the columns
 * are declared in schema.sql, and the assertion compares the whole set, so a
 * column cannot be added, removed, reordered in intent, retyped or made
 * nullable without this list changing.
 *
 * Every entry here is metadata that is needed to render a row or decide a class
 * (APX-FR-01). There is no column here for a prompt, a response, tool output,
 * file contents, a diff, or anything said or done inside a turn.
 */
const EXPECTED_SCHEMA: Readonly<Record<string, readonly (readonly [string, ExpectedColumn])[]>> = {
  sessions: [
    ['session_id', { type: 'TEXT', notNull: true, primaryKey: true }],
    ['harness', { type: 'TEXT', notNull: true, primaryKey: false }],
    // Identity is the short name; the full path is hover detail and is
    // deliberately not a key (APX-CON-09, ADR-008).
    ['repo_short_name', { type: 'TEXT', notNull: true, primaryKey: false }],
    ['repo_full_path', { type: 'TEXT', notNull: true, primaryKey: false }],
    ['first_seen_at', { type: 'TEXT', notNull: true, primaryKey: false }],
    ['last_seen_at', { type: 'TEXT', notNull: true, primaryKey: false }],
    ['state', { type: 'TEXT', notNull: true, primaryKey: false }],
    // A flag, never a count: a per-turn tally of what the agent did is a
    // transcript wearing a numeric disguise (EL-FR-05).
    ['work_signal', { type: 'INTEGER', notNull: true, primaryKey: false }],
  ],
  events: [
    ['event_id', { type: 'TEXT', notNull: true, primaryKey: true }],
    ['session_id', { type: 'TEXT', notNull: true, primaryKey: false }],
    ['class', { type: 'TEXT', notNull: true, primaryKey: false }],
    ['subtype', { type: 'TEXT', notNull: false, primaryKey: false }],
    ['raw_event_type', { type: 'TEXT', notNull: true, primaryKey: false }],
    ['occurred_at', { type: 'TEXT', notNull: true, primaryKey: false }],
    ['received_at', { type: 'TEXT', notNull: true, primaryKey: false }],
    ['dedupe_key', { type: 'TEXT', notNull: true, primaryKey: false }],
    ['ack_state', { type: 'TEXT', notNull: true, primaryKey: false }],
    ['resolution_state', { type: 'TEXT', notNull: true, primaryKey: false }],
  ],
  counters: [
    ['name', { type: 'TEXT', notNull: true, primaryKey: true }],
    // A count. A counter cannot carry content even in principle (EL-FR-10).
    ['value', { type: 'INTEGER', notNull: true, primaryKey: false }],
    ['updated_at', { type: 'TEXT', notNull: true, primaryKey: false }],
  ],
  schema_version: [
    ['version', { type: 'INTEGER', notNull: true, primaryKey: true }],
    ['applied_at', { type: 'TEXT', notNull: true, primaryKey: false }],
  ],
}

interface ExpectedIndex {
  readonly unique: boolean
  readonly columns: readonly string[]
}

/**
 * Every explicitly declared index. The auto-indexes SQLite creates for a
 * WITHOUT ROWID primary key are not listed: they are an artifact of the primary
 * key, which is already asserted.
 */
const EXPECTED_INDEXES: Readonly<Record<string, ExpectedIndex>> = {
  // Session plus occurrence time: the per-session history reads (LD-FR-08).
  idx_events_session_occurred: { unique: false, columns: ['session_id', 'occurred_at'] },
  // Class plus acknowledgement state: the pending set, read on every poll.
  idx_events_class_ack: { unique: false, columns: ['class', 'ack_state'] },
  // One event per dedupe key (EL-FR-07).
  ux_events_dedupe_key: { unique: true, columns: ['dedupe_key'] },
  // Repository grouping by short name (APX-CON-09).
  idx_sessions_repo_short_name: { unique: false, columns: ['repo_short_name'] },
}

/**
 * Column name shapes that must never appear. The second net, not the guard.
 *
 * These are the names that actually turn up in a well-meant change. The
 * word-boundary shapes are deliberate: `raw_event_type` is a harness event name
 * (metadata), while a bare `raw` or `text` column is not.
 */
const CONTENT_NAME_SHAPES: readonly RegExp[] = [
  /prompt/i,
  /respons/i,
  /\brepl(y|ies)\b/i,
  /messag/i,
  /content/i,
  /\bbod(y|ies)\b/i,
  /snippet/i,
  /excerpt/i,
  /preview/i,
  /summar/i,
  /descript/i,
  /detail/i,
  /\bnote(s)?\b/i,
  /comment/i,
  /output/i,
  /transcript/i,
  /last_message/i,
  /last_prompt/i,
  /diff/i,
  /patch/i,
  /argument/i,
  /\binput\b/i,
  /\bresult/i,
  /attach/i,
  /blob/i,
  /payload/i,
  /\bdata\b/i,
  /buffer/i,
  /\braw\b/i,
  /\btext\b/i,
  // The same words as a suffix or segment of a compound name. \btext\b does not
  // match block_text, because an underscore is a word character, and a guard that
  // misses block_text misses it every time.
  /_(text|body|content|message|summary|prompt|output|excerpt|snippet|note|transcript|diff|patch|preview|reply|response|result|label|title)\b/i,
  // Names that pass a shape check and still break the promise, because they
  // invite a quoted string. Blocked for that reason (ADR-003 gotchas).
  /state_(detail|text|note|message)/i,
]

/** Column names that look like a leak, by shape. */
function contentNameViolations(name: string): readonly string[] {
  return CONTENT_NAME_SHAPES.filter((shape) => shape.test(name)).map((shape) => shape.source)
}

// ---------------------------------------------------------------------------
// Reading a schema back out of a real database
// ---------------------------------------------------------------------------

interface ColumnSnapshot {
  readonly name: string
  readonly type: string
  readonly notNull: boolean
  readonly primaryKey: boolean
}

type TableSnapshot = Readonly<Record<string, readonly ColumnSnapshot[]>>

interface IndexSnapshot {
  readonly unique: boolean
  readonly columns: readonly string[]
}

interface ObjectRow {
  readonly type: string
  readonly name: string
  readonly tbl_name: string
}

function readTableSnapshot(db: SqliteDatabase): TableSnapshot {
  const tables = db
    .prepare<[], ObjectRow>(
      `SELECT type, name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all()

  const snapshot: Record<string, readonly ColumnSnapshot[]> = {}
  for (const table of tables) {
    snapshot[table.name] = db
      .prepare<[string], { name: string; type: string; not_null: number; pk: number }>(
        'SELECT name, type, "notnull" AS not_null, pk FROM pragma_table_info(?) ORDER BY cid',
      )
      .all(table.name)
      .map((row) => ({
        name: row.name,
        type: row.type,
        notNull: row.not_null === 1,
        primaryKey: row.pk > 0,
      }))
  }
  return snapshot
}

function readIndexSnapshot(db: SqliteDatabase): Readonly<Record<string, IndexSnapshot>> {
  const indexes = db
    .prepare<[], ObjectRow>(
      `SELECT type, name, tbl_name FROM sqlite_master
        WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all()

  const snapshot: Record<string, IndexSnapshot> = {}
  for (const index of indexes) {
    snapshot[index.name] = {
      // pragma_index_list is keyed by table, so the table the index belongs to
      // has to be read back from sqlite_master rather than assumed.
      unique:
        db
          .prepare<[string, string], { is_unique: number }>(
            'SELECT "unique" AS is_unique FROM pragma_index_list(?) WHERE name = ?',
          )
          .get(index.tbl_name, index.name)?.is_unique === 1,
      columns: db
        .prepare<[string], { name: string }>('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
        .all(index.name)
        .map((row) => row.name),
    }
  }
  return snapshot
}

/**
 * The guard. Throws with a message naming the exact discrepancy.
 *
 * Kept pure so the tests below can feed it a snapshot the real database does
 * not have, which is the only way to prove the guard fails rather than merely
 * that it passes.
 */
export function assertContentFreeSchema(schema: TableSnapshot, indexes: Readonly<Record<string, IndexSnapshot>>): void {
  const expectedTables = Object.keys(EXPECTED_SCHEMA).sort()
  const actualTables = Object.keys(schema).sort()
  const extraTables = actualTables.filter((name) => !expectedTables.includes(name))
  if (extraTables.length > 0) {
    throw new Error(
      `tables not in the approved schema: ${extraTables.join(', ')}. ` +
        'A table created outside the migration set is still a store on disk, so the whole table ' +
        'list is asserted, not only the expected tables.',
    )
  }

  for (const table of expectedTables) {
    const expected = EXPECTED_SCHEMA[table] ?? []
    const actual = schema[table] ?? []
    const expectedNames = expected.map(([name]) => name)
    const actualNames = actual.map((column) => column.name)

    const extra = actualNames.filter((name) => !expectedNames.includes(name))
    if (extra.length > 0) {
      throw new Error(
        `table ${table} has columns that are not in the approved set: ${extra.join(', ')}. ` +
          'If the column is needed, add it to EXPECTED_SCHEMA here and record why it cannot hold ' +
          'content. If the reason is "a feature might need it later", delete it: a column with no ' +
          'writer is a column that can hold content later.',
      )
    }
    const missing = expectedNames.filter((name) => !actualNames.includes(name))
    if (missing.length > 0) {
      throw new Error(`table ${table} is missing approved columns: ${missing.join(', ')}`)
    }

    for (const [name, expectedColumn] of expected) {
      const actualColumn = actual.find((column) => column.name === name)
      if (actualColumn === undefined) continue
      if (
        actualColumn.type !== expectedColumn.type ||
        actualColumn.notNull !== expectedColumn.notNull ||
        actualColumn.primaryKey !== expectedColumn.primaryKey
      ) {
        throw new Error(
          `column ${table}.${name} is ${actualColumn.type} ` +
            `${actualColumn.notNull ? 'NOT NULL' : 'nullable'} ` +
            `${actualColumn.primaryKey ? 'PRIMARY KEY' : ''}, ` +
            `and is approved as ${expectedColumn.type} ` +
            `${expectedColumn.notNull ? 'NOT NULL' : 'nullable'} ` +
            `${expectedColumn.primaryKey ? 'PRIMARY KEY' : ''}`,
        )
      }
    }
  }

  for (const columns of Object.values(schema)) {
    for (const column of columns) {
      const violations = contentNameViolations(column.name)
      if (violations.length > 0) {
        throw new Error(
          `column name ${column.name} matches a stored-content name shape (${violations.join(', ')})`,
        )
      }
    }
  }

  const expectedIndexes = Object.keys(EXPECTED_INDEXES).sort()
  const actualIndexes = Object.keys(indexes).sort()
  const extraIndexes = actualIndexes.filter((name) => !expectedIndexes.includes(name))
  const missingIndexes = expectedIndexes.filter((name) => !actualIndexes.includes(name))
  if (extraIndexes.length > 0 || missingIndexes.length > 0) {
    throw new Error(
      `index set differs. unexpected: [${extraIndexes.join(', ')}], missing: [${missingIndexes.join(', ')}]`,
    )
  }
  for (const [name, expectedIndex] of Object.entries(EXPECTED_INDEXES)) {
    const actualIndex = indexes[name]
    if (actualIndex === undefined) continue
    if (actualIndex.unique !== expectedIndex.unique) {
      throw new Error(`index ${name} uniqueness is ${actualIndex.unique}, approved as ${expectedIndex.unique}`)
    }
    if (actualIndex.columns.join(',') !== expectedIndex.columns.join(',')) {
      throw new Error(
        `index ${name} covers (${actualIndex.columns.join(', ')}), approved as (${expectedIndex.columns.join(', ')})`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// A real database per test
// ---------------------------------------------------------------------------

const openHandles: OpenDatabase[] = []
const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent-ping-schema-'))
  temporaryDirectories.push(directory)
  return directory
}

/** A migrated database in a fresh temporary directory, tracked for cleanup. */
function openTemporaryDatabase(): OpenDatabase {
  const opened = openDatabase({ filePath: path.join(temporaryDirectory(), 'agent-ping.db') })
  openHandles.push(opened)
  return opened
}

afterEach(() => {
  for (const opened of openHandles.splice(0)) opened.close()
  for (const directory of temporaryDirectories.splice(0)) {
    removeTree(directory)
  }
})

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

describe('the content-free schema (EL-FR-03, APX-FR-01)', () => {
  it('has exactly the approved columns, with the approved type, nullability and key position', () => {
    const opened = openTemporaryDatabase()
    expect(() =>
      assertContentFreeSchema(readTableSnapshot(opened.db), readIndexSnapshot(opened.db)),
    ).not.toThrow()
  })

  it('has no table outside the approved set, so a table created outside the migrations cannot escape the guard', () => {
    const opened = openTemporaryDatabase()
    const tables = opened.db
      .prepare<[], ObjectRow>(
        `SELECT type, name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((row) => row.name)
    expect(tables).toEqual(['counters', 'events', 'schema_version', 'sessions'])
  })

  it('declares no view, trigger or other object the assertions do not read', () => {
    const opened = openTemporaryDatabase()
    const objects = opened.db
      .prepare<[], ObjectRow>(
        `SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      )
      .all()
    expect(objects.map((object) => object.type)).toEqual([
      'index',
      'index',
      'index',
      'index',
      'table',
      'table',
      'table',
      'table',
    ])
  })

  it('holds no column that can hold a BLOB, because every table is STRICT', () => {
    const opened = openTemporaryDatabase()
    for (const [table, columns] of Object.entries(readTableSnapshot(opened.db))) {
      for (const column of columns) {
        expect(`${table}.${column.name}: ${column.type}`, table).toMatch(/ (TEXT|INTEGER)$/)
      }
    }
  })

  it('has no key, index or uniqueness constraint on the repository full path', () => {
    const opened = openTemporaryDatabase()
    for (const [name, index] of Object.entries(readIndexSnapshot(opened.db))) {
      expect(index.columns, name).not.toContain('repo_full_path')
    }
    // The full path is hover detail. Identity is the short name (APX-CON-09).
    expect(readIndexSnapshot(opened.db)['idx_sessions_repo_short_name']).toBeDefined()
  })

  it('fails when a content-bearing column is added to a real table', () => {
    const opened = openTemporaryDatabase()
    opened.db.exec("ALTER TABLE events ADD COLUMN excerpt TEXT")
    expect(() =>
      assertContentFreeSchema(readTableSnapshot(opened.db), readIndexSnapshot(opened.db)),
    ).toThrow(/excerpt/)
  })

  it('fails when a neutral-sounding column is added to a real table, because the guard is exact', () => {
    const opened = openTemporaryDatabase()
    opened.db.exec('ALTER TABLE events ADD COLUMN token_total INTEGER')
    expect(() =>
      assertContentFreeSchema(readTableSnapshot(opened.db), readIndexSnapshot(opened.db)),
    ).toThrow(/token_total/)
  })

  it('fails when a table is added outside the migration set', () => {
    const opened = openTemporaryDatabase()
    opened.db.exec('CREATE TABLE scratch (id TEXT NOT NULL PRIMARY KEY) STRICT, WITHOUT ROWID')
    expect(() =>
      assertContentFreeSchema(readTableSnapshot(opened.db), readIndexSnapshot(opened.db)),
    ).toThrow(/scratch/)
  })

  it('fails when an approved column is retyped or made nullable', () => {
    const opened = openTemporaryDatabase()
    // Recreating a table with the same names and different shapes is the only way
    // to change a declared column without a new migration, which is why the type,
    // nullability and key position are asserted and not just the names.
    opened.db.exec('DROP TABLE counters')
    opened.db.exec(
      'CREATE TABLE counters (name TEXT NOT NULL PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)',
    )
    expect(() =>
      assertContentFreeSchema(readTableSnapshot(opened.db), readIndexSnapshot(opened.db)),
    ).toThrow(/counters\.value/)
  })

  it('fails on every stored-content name shape, including fresh synonyms', () => {
    const opened = openTemporaryDatabase()
    const snapshot = readTableSnapshot(opened.db)
    const indexes = readIndexSnapshot(opened.db)
    const invented = ['snippet', 'excerpt', 'last_message', 'state_detail', 'preview', 'notes', 'tool_arguments', 'block_text']

    for (const name of invented) {
      // The second net has to actually fire on the name...
      expect(contentNameViolations(name), name).not.toEqual([])
      // ...and the exact set has to reject the column even when the name is clean.
      const withCleanName = { ...snapshot, events: [...(snapshot['events'] ?? []), { name: 'token_total', type: 'TEXT', notNull: true, primaryKey: false }] }
      expect(() => assertContentFreeSchema(withCleanName, indexes), name).toThrow(/token_total/)
      const withInventedName = { ...snapshot, events: [...(snapshot['events'] ?? []), { name, type: 'TEXT', notNull: true, primaryKey: false }] }
      expect(() => assertContentFreeSchema(withInventedName, indexes), name).toThrow(new RegExp(name))
    }
  })

  it('accepts every approved column name, so the second net has no false positive', () => {
    for (const [table, columns] of Object.entries(EXPECTED_SCHEMA)) {
      for (const [name] of columns) {
        expect(contentNameViolations(name), `${table}.${name}`).toEqual([])
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Migrations (EL-FR-02, EL-FR-11)
// ---------------------------------------------------------------------------

describe('versioned migrations (EL-FR-02)', () => {
  it('records the applied version in the database, not only in the build', () => {
    const opened = openTemporaryDatabase()
    expect(opened.schemaVersion).toBe(1)
    const rows = opened.db
      .prepare<[], { version: number; applied_at: string }>(
        'SELECT version, applied_at FROM schema_version ORDER BY version',
      )
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.version).toBe(1)
    expect(rows[0]?.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('is idempotent when the migrations are applied again over an open database', () => {
    const opened = openTemporaryDatabase()
    expect(applyMigrations(opened.db, { now: () => '2026-09-26T12:00:00.000Z' })).toBe(1)
    expect(applyMigrations(opened.db, { now: () => '2026-09-26T12:00:00.000Z' })).toBe(1)
    expect(
      opened.db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM schema_version').get()?.count,
    ).toBe(1)
    expect(() =>
      assertContentFreeSchema(readTableSnapshot(opened.db), readIndexSnapshot(opened.db)),
    ).not.toThrow()
  })

  it('applies a later migration forward, leaving the data already stored alone', () => {
    const opened = openTemporaryDatabase()
    opened.db
      .prepare<[string, string, string, string, string, string, string, number]>(
        `INSERT INTO sessions (session_id, harness, repo_short_name, repo_full_path, first_seen_at, last_seen_at, state, work_signal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('ses_seed', 'opencode', 'agent-ping', '/home/dev/Projects/agent-ping', '2026-09-26T09:00:00.000Z', '2026-09-26T09:00:00.000Z', 'blocked', 0)

    const applied = applyMigrations(opened.db, {
      migrations: [
        ...readMigrations(),
        { version: 2, title: 'a later migration', sql: 'CREATE INDEX idx_events_ack ON events (ack_state)' },
      ],
      now: () => '2026-09-26T12:00:00.000Z',
    })

    expect(applied).toBe(2)
    expect(readSchemaVersion(opened.db)).toBe(2)
    expect(
      opened.db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM sessions').get()?.count,
    ).toBe(1)
    expect(opened.db.prepare<[], ObjectRow>("SELECT type, name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_ack'").get()).toBeDefined()
  })

  it('numbers migrations from 1 with no gaps, and refuses a renumbered or empty one', () => {
    expect(readMigrations('-- migration: 1 initial\nCREATE TABLE a (id TEXT PRIMARY KEY);\n').map((m) => m.version)).toEqual([1])
    expect(() => readMigrations('-- migration: 2 second\nCREATE TABLE a (id TEXT PRIMARY KEY);\n')).toThrow(
      /migration 1 is numbered 2/,
    )
    expect(() =>
      readMigrations('-- migration: 1 first\nCREATE TABLE a (id TEXT PRIMARY KEY);\n-- migration: 3 third\nCREATE TABLE b (id TEXT PRIMARY KEY);\n'),
    ).toThrow(/migration 2 is numbered 3/)
    expect(() => readMigrations('-- migration: 1 empty\n-- only a comment\n')).toThrow(/no statements/)
  })

  it('leaves the database at the previous version when a migration fails part-way', () => {
    const opened = openTemporaryDatabase()
    expect(() =>
      applyMigrations(opened.db, {
        migrations: [
          ...readMigrations(),
          { version: 2, title: 'a migration that cannot apply', sql: 'CREATE TABLE half (id TEXT PRIMARY KEY); CREATE TABLE also_half (id TEXT PRIMARY KEY); NOT SQL AT ALL;' },
        ],
        now: () => '2026-09-26T12:00:00.000Z',
      }),
    ).toThrow()
    // A half-migrated database is worse than an unmigrated one: the version
    // record and the schema would disagree about what exists.
    expect(readSchemaVersion(opened.db)).toBe(1)
    const tables = opened.db
      .prepare<[], ObjectRow>(
        "SELECT type, name, tbl_name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name)
    expect(tables).toEqual(['counters', 'events', 'schema_version', 'sessions'])
  })

  it('reads the migration set from the schema file, so the file is the only source of the schema', () => {
    const migrations = readMigrations()
    expect(migrations.map((migration) => migration.version)).toEqual([1])
    expect(migrations[0]?.sql).toContain('CREATE TABLE sessions')
    expect(migrations[0]?.sql).toContain('CREATE TABLE events')
    expect(migrations[0]?.sql).toContain('CREATE TABLE counters')
  })
})

// ---------------------------------------------------------------------------
// The enumerations the database enforces (ADR-004, PRD 10)
// ---------------------------------------------------------------------------

describe('the values the database accepts (ADR-004, PRD 10)', () => {
  const insertSession = (db: SqliteDatabase): void => {
    db.prepare<[string], []>(
      `INSERT INTO sessions (session_id, harness, repo_short_name, repo_full_path, first_seen_at, last_seen_at, state, work_signal)
       VALUES (?, 'opencode', 'agent-ping', '/home/dev/Projects/agent-ping', '2026-09-26T09:00:00.000Z', '2026-09-26T09:00:00.000Z', 'running', 1)`,
    ).run('ses_01')
  }
  const insertEvent = (db: SqliteDatabase, eventClass: string, subtype: string | null): void => {
    db.prepare<[string, string, string | null, string]>(
      `INSERT INTO events (event_id, session_id, class, subtype, raw_event_type, occurred_at, received_at, dedupe_key)
       VALUES (?, 'ses_01', ?, ?, 'raw.type', '2026-09-26T09:00:00.000Z', '2026-09-26T09:00:00.000Z', ?)`,
    ).run(`evt_${eventClass}_${subtype ?? 'none'}`, eventClass, subtype, `key:${eventClass}:${subtype ?? 'none'}`)
  }

  it('refuses a class outside the three loudness classes', () => {
    const opened = openTemporaryDatabase()
    insertSession(opened.db)
    for (const className of ['urgent', 'info', 'needs-you ']) {
      expect(() => insertEvent(opened.db, className, null), className).toThrow(/CHECK/)
    }
    for (const className of ['needs-you', 'finished', 'fyi']) {
      expect(() => insertEvent(opened.db, className, null), className).not.toThrow()
    }
  })

  it('refuses a subtype outside the five fyi subtypes, and a subtype on a class that has none', () => {
    const opened = openTemporaryDatabase()
    insertSession(opened.db)
    for (const subtype of ['error', 'retry', 'long-tool-call', 'compaction', 'token-burn']) {
      expect(() => insertEvent(opened.db, 'fyi', subtype), subtype).not.toThrow()
    }
    expect(() => insertEvent(opened.db, 'fyi', 'chat')).toThrow(/CHECK/)
    expect(() => insertEvent(opened.db, 'needs-you', 'error')).toThrow(/CHECK/)
  })

  it('refuses a session state outside the PRD 10 lifecycle, and a work signal that is not a flag', () => {
    const opened = openTemporaryDatabase()
    expect(() =>
      opened.db
        .prepare<[], []>(
          `INSERT INTO sessions (session_id, harness, repo_short_name, repo_full_path, first_seen_at, last_seen_at, state, work_signal)
           VALUES ('ses_state', 'opencode', 'agent-ping', '/home/dev/Projects/agent-ping', '2026-09-26T09:00:00.000Z', '2026-09-26T09:00:00.000Z', 'vibing', 1)`,
        )
        .run(),
    ).toThrow(/CHECK/)
    expect(() =>
      opened.db
        .prepare<[], []>(
          `INSERT INTO sessions (session_id, harness, repo_short_name, repo_full_path, first_seen_at, last_seen_at, state, work_signal)
           VALUES ('ses_work', 'opencode', 'agent-ping', '/home/dev/Projects/agent-ping', '2026-09-26T09:00:00.000Z', '2026-09-26T09:00:00.000Z', 'running', 7)`,
        )
        .run(),
    ).toThrow(/CHECK/)
  })

  it('refuses a negative counter value and an event referencing a session that does not exist', () => {
    const opened = openTemporaryDatabase()
    expect(() =>
      opened.db
        .prepare<[], []>("INSERT INTO counters (name, value, updated_at) VALUES ('dashboard_opens', -1, '2026-09-26T09:00:00.000Z')")
        .run(),
    ).toThrow(/CHECK/)
    expect(() => insertEvent(opened.db, 'fyi', 'error')).toThrow(/FOREIGN KEY/)
  })
})
