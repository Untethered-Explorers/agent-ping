// Opening the durable database: where the file is, how migrations are applied,
// and what happens when the file cannot be read (EL-FR-02, EL-FR-11).
//
// Three properties this module owns, each with a test in
// tests/storage/schema.test.ts or tests/storage/eventStore.test.ts:
//
//   1. Migrations are versioned, forward-only and applied idempotently on every
//      open. Opening the same file twice applies nothing the second time.
//   2. An unreadable database is deleted and recreated from the migrations
//      rather than refusing to start. A sidecar that will not boot after a bad
//      shutdown is worse than losing history (APX-CON-03), so history is the
//      thing that is sacrificed and it is reported, never silent (APX-FR-02):
//      `rebuiltFromMigrations` is the breadcrumb the hub surfaces.
//   3. The schema file is the only source of the schema. A column that exists
//      only because a debug path created it would disappear on a rebuild and
//      the exact-column-set assertion would then fail on a table that worked
//      yesterday, so every column is reachable from src/storage/schema.sql.
//
// This module opens a file and nothing else: no socket, no subprocess, no
// surface (PRD 6.2), and no outbound call of any kind (APX-CON-12).

import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { databaseFilePath, databaseFilePaths, ensureOwnerOnlyFile, ensureStateDir } from './paths.js'

/** The better-sqlite3 handle, named once so no caller imports the driver itself. */
export type SqliteDatabase = Database.Database

/** One versioned migration, as parsed out of src/storage/schema.sql. */
export interface Migration {
  /** The migration's number. Version 1 is the initial schema. */
  readonly version: number
  /** The human label from the marker line, used only in error messages. */
  readonly title: string
  /** The statements to run, in file order. */
  readonly sql: string
}

/**
 * The marker that opens a migration. Everything between one marker and the next
 * is that migration's SQL; the text before the first marker is the file's
 * header comment and is not executed.
 */
const MIGRATION_MARKER = /^--\s*migration:\s*(\d+)\s*(.*?)\s*$/

/**
 * The version record, created by the runner rather than by a migration because
 * the runner has to read it to know which migrations are pending. It is the one
 * table in the schema that no `-- migration:` block creates, and its columns are
 * asserted exactly like every other table's.
 */
const CREATE_VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER NOT NULL PRIMARY KEY,
  applied_at TEXT    NOT NULL
) STRICT, WITHOUT ROWID
`

/** Applied to every connection, outside any transaction. */
const PRAGMAS_ON_OPEN: readonly string[] = [
  // WAL so a reader (a verification script, the CLI) can read a consistent
  // snapshot while the hub is writing. It is persistent in the file header, so
  // setting it on every open is a no-op after the first.
  'journal_mode = WAL',
  'synchronous = NORMAL',
  // Off by default in SQLite. Without it, an event could reference a session
  // row that does not exist.
  'foreign_keys = ON',
]

/**
 * Read the migration set from the schema file.
 *
 * Versions must start at 1 and increase by exactly one. A gap, a repeat or a
 * reordering is a mistake in the file, and a store that quietly skipped the
 * out-of-order migration would be a store with a schema nobody wrote.
 */
export function readMigrations(source: string = loadSchemaSql()): readonly Migration[] {
  const migrations: Migration[] = []
  let current: { version: number; title: string; lines: string[] } | undefined

  for (const line of source.split(/\r?\n/)) {
    const marker = MIGRATION_MARKER.exec(line)
    if (marker === null) {
      current?.lines.push(line)
      continue
    }
    if (current !== undefined) {
      migrations.push(finishMigration(current))
    }
    current = { version: Number(marker[1]), title: marker[2] ?? '', lines: [] }
  }
  if (current !== undefined) {
    migrations.push(finishMigration(current))
  }

  migrations.forEach((migration, index) => {
    const expected = index + 1
    if (migration.version !== expected) {
      throw new Error(
        `src/storage/schema.sql numbers its migrations 1..N with no gaps: migration ${expected} ` +
          `is numbered ${migration.version}${migration.title === '' ? '' : ` (${migration.title})`}. ` +
          'A migration that has shipped is never renumbered or edited; append a new one.',
      )
    }
  })

  return migrations
}

function finishMigration(pending: { version: number; title: string; lines: string[] }): Migration {
  const sql = pending.lines.join('\n').trim()
  // A migration that carries nothing but comments has no statements to apply.
  // Treating it as empty is the point: a version that records itself as applied
  // without changing anything is a version that hides a forgotten statement.
  const hasStatement = pending.lines.some((line) => line.trim() !== '' && !line.trimStart().startsWith('--'))
  if (!hasStatement) {
    throw new Error(
      `migration ${pending.version}${pending.title === '' ? '' : ` (${pending.title})`} in ` +
        'src/storage/schema.sql has no statements.',
    )
  }
  return { version: pending.version, title: pending.title, sql }
}

/**
 * Read the migration file that sits beside this module.
 *
 * A missing file is a packaging failure, not a corrupt database, so it is
 * reported with the remedy rather than papered over: the tsc build emits
 * JavaScript only, so the build step (scripts/build.mjs) and the package
 * `files` allowlist (IO-1) must carry src/storage/schema.sql through to
 * dist/main/storage/schema.sql.
 */
export function loadSchemaSql(): string {
  const schemaUrl = new URL('./schema.sql', import.meta.url)
  try {
    return readFileSync(schemaUrl, 'utf8')
  } catch (cause) {
    throw new Error(
      'the durable schema could not be read beside this module: ' +
        `${fileURLToPath(schemaUrl)}. The tsc build emits JavaScript only, so the build and the ` +
        "package `files` allowlist must copy src/storage/schema.sql next to the emitted module; " +
        'the store has no other source for its schema and will not start without it.',
      { cause },
    )
  }
}

export interface ApplyMigrationsOptions {
  /** Defaults to the migration set parsed from the schema file. */
  readonly migrations?: readonly Migration[]
  /** ISO 8601 UTC source for `schema_version.applied_at`. Injectable for tests. */
  readonly now?: () => string
}

/**
 * Apply every migration that has not been applied yet and return the schema
 * version the database is now at.
 *
 * Idempotent by construction: an already-recorded version is skipped, and a
 * migration and its version record are written in one transaction, so a failure
 * part-way through leaves the database at the previous version rather than at a
 * half-migrated one.
 */
export function applyMigrations(db: SqliteDatabase, options: ApplyMigrationsOptions = {}): number {
  const migrations = options.migrations ?? readMigrations()
  const now = options.now ?? ((): string => new Date().toISOString())

  db.transaction(() => {
    db.exec(CREATE_VERSION_TABLE)
  }).immediate()

  const applied = new Set(
    db
      .prepare<[], { version: number }>('SELECT version FROM schema_version')
      .all()
      .map((row) => row.version),
  )

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue
    db.transaction(() => {
      db.exec(migration.sql)
      db
        .prepare<[number, string]>('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
        .run(migration.version, now())
    }).immediate()
  }

  return readSchemaVersion(db)
}

/** The highest applied migration version, or 0 on a database with no record. */
export function readSchemaVersion(db: SqliteDatabase): number {
  const row = db
    .prepare<[], { version: number | null }>('SELECT MAX(version) AS version FROM schema_version')
    .get()
  return row?.version ?? 0
}

export interface OpenDatabaseOptions {
  /** Defaults to the database file inside the resolved state directory. */
  readonly filePath?: string
  /** ISO 8601 UTC source for migration records. Injectable for tests. */
  readonly now?: () => string
}

export interface OpenDatabase {
  readonly db: SqliteDatabase
  readonly filePath: string
  readonly schemaVersion: number
  /**
   * True when an existing file could not be read and the database was deleted
   * and recreated from the migrations. History recorded only in that file is
   * gone; the hub reports this rather than pretending nothing happened
   * (APX-FR-02).
   */
  readonly rebuiltFromMigrations: boolean
  /** Idempotent. Safe to call twice. */
  close(): void
}

/**
 * Open the durable database, create its directory if needed, and bring the
 * schema up to date.
 *
 * When the file exists but cannot be read - a corrupt page, a truncated write
 * after a power loss, bytes that are not a database at all - it is deleted along
 * with its write-ahead log sidecars and recreated from the migrations. Refusing
 * to start is the one outcome that is not offered: agent-ping is a sidecar
 * (APX-CON-03), and a sidecar that cannot open its log is a sidecar that cannot
 * tell the developer anything.
 */
export function openDatabase(options: OpenDatabaseOptions = {}): OpenDatabase {
  const filePath = options.filePath ?? databaseFilePath()
  ensureStateDir(path.dirname(filePath))
  // better-sqlite3 has no file-mode option, so the file is created and tightened
  // before SQLite opens it, including after a rebuild.
  ensureOwnerOnlyFile(filePath)

  const migrations = readMigrations()

  try {
    const migrated = openAndMigrate(filePath, migrations, options.now)
    return wrap(migrated.db, filePath, migrated.schemaVersion, false)
  } catch {
    // A failure this early means the file itself is the problem, so the second
    // attempt starts from nothing. If that also fails, the error propagates:
    // there is no third state to offer.
    discardDatabaseFiles(filePath)
    ensureOwnerOnlyFile(filePath)
    const migrated = openAndMigrate(filePath, migrations, options.now)
    return wrap(migrated.db, filePath, migrated.schemaVersion, true)
  }
}

/**
 * Open one connection and bring it up to date, closing the handle again if the
 * migrations do not apply.
 *
 * Closing here rather than in the caller is what keeps the rebuild path honest:
 * deleting a file that is still open works on POSIX and fails outright on
 * Windows, and a leaked native handle outlives the call to make a later
 * migration or rebuild assertion fail for the wrong reason.
 */
function openAndMigrate(
  filePath: string,
  migrations: readonly Migration[],
  now: (() => string) | undefined,
): { db: SqliteDatabase; schemaVersion: number } {
  const database = connect(filePath)
  try {
    return { db: database, schemaVersion: applyMigrations(database, { migrations, now }) }
  } catch (cause) {
    closeQuietly(database)
    throw cause
  }
}

function connect(filePath: string): SqliteDatabase {
  // No `verbose` callback, ever: it writes every statement and its bound values
  // to the console, which is a local log line carrying whatever a caller passed
  // in (APX-FR-01). Diagnostics come from counters and health instead.
  const database = new Database(filePath, { timeout: 5_000 })
  try {
    for (const pragma of PRAGMAS_ON_OPEN) {
      database.pragma(pragma)
    }
  } catch (cause) {
    closeQuietly(database)
    throw cause
  }
  return database
}

function wrap(
  database: SqliteDatabase,
  filePath: string,
  schemaVersion: number,
  rebuiltFromMigrations: boolean,
): OpenDatabase {
  let closed = false
  return {
    db: database,
    filePath,
    schemaVersion,
    rebuiltFromMigrations,
    close(): void {
      if (closed) return
      closed = true
      closeQuietly(database)
    },
  }
}

/** Remove the database and its write-ahead log sidecars, so nothing can replay onto a fresh file. */
function discardDatabaseFiles(filePath: string): void {
  for (const file of databaseFilePaths(filePath)) {
    // `force` makes a missing file a no-op. A path that cannot be removed (a
    // directory, a read-only mount) throws, which is the correct outcome: the
    // alternative is opening the same unreadable file again.
    rmSync(file, { force: true })
  }
}

function closeQuietly(database: SqliteDatabase): void {
  try {
    if (database.open) database.close()
  } catch {
    // A handle that will not close is already unusable; the rebuild opens a new
    // one and the original is dropped with this scope.
  }
}
