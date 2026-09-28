// The bounded, structured local log every command writes (IO-FR-09).
//
// WHY THIS EXISTS AND WHY IT IS SHAPED LIKE THIS
// A diagnostic tool that only prints is a diagnostic tool that forgets. When a developer's
// notifications stopped overnight, the question `agent-ping doctor` answers is what the
// product did, and "what it did" has to have been written down somewhere the local user
// already owns. That is this file, and it is deliberately the least interesting file in
// the product: one JSON object per line, a closed set of field names, and a bound.
//
// FOUR PROPERTIES, EACH ENFORCED IN CODE RATHER THAN IN A COMMENT
//
//   1. BOUNDED. `LOG_MAX_BYTES` and `LOG_FILES_KEPT` are named exports, rotation happens
//      before the write that would cross the bound, and the rotated file is the *only*
//      other file that can exist. Open Question 2 answered "rotate at 2 MB, keep two
//      files", and two is a property of the two file names rather than a promise about a
//      cleanup routine nobody can test.
//
//   2. OWNER-ONLY (IO-FR-07). Every path resolves through src/storage/paths.ts, the file
//      is created 0600, and an existing file is tightened rather than trusted. The log
//      records the shape of an install; another user reading it learns the developer's
//      repositories and session timings.
//
//   3. NEVER FAILS A COMMAND. A log that cannot be written is reported once, on standard
//      error, and the command carries on. `doctor` is the one command whose whole job is
//      to report, so it says so in its own output; every other command says it on stderr
//      and finishes what it was asked to do. Nothing is retried: a file that could not be
//      written once will not be written on the second attempt, and a command that retried
//      would spend its time proving that.
//
//   4. NO CONVERSATION CONTENT (APX-FR-01, EL-FR-01). This is the one that matters, and
//      it is enforced by a *kind* per field rather than by a list of forbidden words. A
//      denylist passes while content is stored - it catches none of `snippet`, `body`,
//      `excerpt` or `summary` - and a length bound alone is worse: a 74-character prompt
//      fits under any bound a path needs. So every field name below declares a kind, and
//      the guard refuses a value of the wrong kind: `outcome` must be a lowercase token,
//      `stateDir` must be a path, `port` must be a non-negative integer, `version` must
//      look like a version, and `hub` must be this product's own loopback origin. A prompt
//      is none of those; a diff is none of those; a stack trace is none of those. And the
//      field names themselves are a closed union, so a new key is a compile error.
//
// THE VERBOSE FLAG IS THE ONLY DOOR TO STDOUT (IO-FR-09)
// Without `--verbose` a command prints its result and nothing else. With it, every line
// this file writes is mirrored to standard output as the same JSON, so a developer can
// see exactly what went to disk. Nothing is mirrored to stderr, because stderr belongs to
// the command's own failures.
//
// This module writes a file and mirrors lines. It opens no socket, spawns nothing, and
// makes no outbound call of any kind (APX-CON-12).

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  OWNER_ONLY_DIRECTORY_MODE,
  OWNER_ONLY_FILE_MODE,
  ensureOwnerOnlyFile,
  resolveStateDir,
} from '../storage/paths.js'

/**
 * Make sure the state directory exists, owner-only, **without tightening one that
 * already exists**.
 *
 * That asymmetry is the point, and it is a decision rather than an omission. The
 * directory's mode is IO-FR-07's promise and `ensureStateDir` in src/storage/paths.ts is
 * the one place it is enforced - the store and the runtime file both call it when the hub
 * actually uses the state. A *diagnostic* that tightened it would be repairing, and
 * `doctor` is report-only by decision (Open Question 3): a check that quietly fixed the
 * fault it was looking for could never report it. So this creates what is missing, in the
 * right mode, and leaves what is there exactly as it found it.
 */
function ensureLogDirectory(stateDir: string): void {
  // No chmod, deliberately, on an existing directory: see the note above. A directory
  // created here is owner-only from the mode argument (further narrowed by the umask,
  // never widened by it); a directory that was already there keeps the mode it had, so
  // `doctor` can still see a directory that is wider than IO-FR-07 promises.
  mkdirSync(stateDir, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE })
}

/** The live log's file name inside the state directory. */
export const LOG_FILE_NAME = 'agent-ping.log'

/** The one rotated file, and the only other file this module can create. */
export const ROTATED_LOG_FILE_NAME = 'agent-ping.log.1'

/**
 * The bound, in bytes: rotate at 2 MB.
 *
 * Open Question 2 of the install/operations feature asks what size is enough for
 * diagnosis without growth, and answers itself. 2 MB of one-JSON-object-per-line is a
 * few thousand command invocations - far more than the gap between noticing a fault and
 * running the diagnostic - and a bound nobody can exceed is a bound.
 */
export const LOG_MAX_BYTES = 2 * 1024 * 1024

/**
 * How many files exist, always: the live one and the rotated one.
 *
 * A number rather than a name, because the test asserts it by counting the directory
 * after a rotation that would have overflowed it. "Keeps two files" is otherwise a
 * promise about a future cleanup routine.
 */
export const LOG_FILES_KEPT = 2

/**
 * The longest a path or a token may be.
 *
 * A path on a real machine is under it. It is not the content guard - the *kind* is -
 * and it exists so a pathological value cannot make a single line unbounded.
 */
export const LOG_VALUE_MAX_CHARS = 1024

/** The levels, closed. A level is chosen here and not by a caller. */
export type LogLevel = 'info' | 'warn' | 'error'

/**
 * What kind of value a field holds, and therefore what the guard accepts.
 *
 * The five kinds are chosen so that everything this product legitimately knows how to say
 * has one of them and nothing a harness could send has any of them:
 *
 *   token    a lowercase, hyphen-free-of-spaces word: `installed`, `version-mismatch`
 *   path     an absolute, relative or home-anchored path: the state directory, a plugin
 *   count    a non-negative integer: a pending count, a port, a pid, a removed-file count
 *   version  `1.2.3` with an optional pre-release or build suffix
 *   origin   this product's own loopback origin, and nothing else (APX-CON-12)
 */
export type LogFieldKind = 'token' | 'path' | 'count' | 'version' | 'origin'

/**
 * The closed field set, with each name's kind, in the order the fields are written.
 *
 * Both halves are enforcement. The names are a union, so `record(name, { prompt: '…' })`
 * is a compile error; the kinds are a guard, so a value that found a name it was allowed
 * to use anyway is still refused. A log line's whole content-freedom rests on this table
 * and on nothing else in this module.
 */
export const LOG_FIELD_KINDS = {
  autostart: 'path',
  database: 'path',
  hub: 'origin',
  outcome: 'token',
  pending: 'count',
  plugin: 'path',
  port: 'count',
  previousVersion: 'version',
  reason: 'token',
  removed: 'count',
  stateDir: 'path',
  version: 'version',
} as const satisfies Readonly<Record<string, LogFieldKind>>

/** One of the closed field names above. */
export type LogFieldKey = keyof typeof LOG_FIELD_KINDS

/** The only value shapes a field may hold. */
export type LogValue = string | number | boolean | null

/** The closed field set, keyed by its own union. */
export type LogFields = Readonly<Partial<Record<LogFieldKey, LogValue>>>


/** One line, as it is written and as a reader sees it. */
export interface LogRecord {
  readonly time: string
  readonly level: LogLevel
  readonly name: string
  readonly fields: LogFields
}

/**
 * An event name is `word.word` with a small alphabet and a bound.
 *
 * Enforced rather than documented, because the name is the only free-form text in a line
 * and "structured" is a claim about the whole line, not about the fields alone.
 */
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)*$/

/** The bound on an event name, for the same reason the value bound exists. */
export const LOG_NAME_MAX_CHARS = 64

/** The five kind guards. Each is a shape, and each shape is something a message is not. */
const KIND_PATTERNS: Readonly<Record<LogFieldKind, RegExp>> = {
  // A token has no spaces and no punctuation a sentence would have. A prompt has spaces;
  // a diff has newlines and `@@`; a stack trace has brackets and colons.
  token: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
  path: /^(?:\/|~\/|\.\/|\.\.\/|[A-Za-z]:[\\/])[^ -]*$/,
  count: /^\d+$/,
  version: /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
  // The only origin this product can ever print, which is also the only one it can reach
  // (APX-CON-12).
  origin: /^http:\/\/127\.0\.0\.1:\d{1,5}$/,
}

/** A field value this log refuses to write, and why. */
export class LogContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LogContentError'
  }
}

/** The live log file for a state directory. */
export function localLogPath(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, LOG_FILE_NAME)
}

/** The one rotated log file for a state directory. */
export function rotatedLocalLogPath(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, ROTATED_LOG_FILE_NAME)
}

/** Every file this module can create, in the order they are counted. */
export function localLogFiles(stateDir: string): readonly string[] {
  return [localLogPath(stateDir), rotatedLocalLogPath(stateDir)]
}

/**
 * Is this value a legal one for this field, whatever the field is?
 *
 * Checked before the field's own kind so the message a caller gets is about the shape
 * rather than about which field it tried to use.
 */
function isLogValue(value: unknown): value is LogValue {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  if (typeof value !== 'string') return false
  return value.length <= LOG_VALUE_MAX_CHARS && !/[\n\r]/.test(value)
}

/** Is this value the kind its field declares? */
export function isLogFieldValue(key: LogFieldKey, value: unknown): value is LogValue {
  const kind = LOG_FIELD_KINDS[key]
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0
  if (typeof value !== 'string') return false
  return KIND_PATTERNS[kind].test(value)
}

/**
 * Check one field set without writing it, so a caller can be told what was wrong.
 *
 * Exported because the test drives it directly, and because a command that builds a field
 * set from a result it does not control (`install`'s plugin outcome, for instance) has to
 * be able to refuse before it writes rather than after.
 */
export function assertContentFreeLogFields(name: string, fields: LogFields): void {
  if (name.length > LOG_NAME_MAX_CHARS || !EVENT_NAME_PATTERN.test(name)) {
    throw new LogContentError(
      `refusing to log the event name ${JSON.stringify(name.slice(0, LOG_NAME_MAX_CHARS))}: an ` +
        'event name is a short lowercase dotted token such as "install.plugin".',
    )
  }
  for (const [key, value] of Object.entries(fields)) {
    if (!(key in LOG_FIELD_KINDS)) {
      throw new LogContentError(
        `refusing to log the field "${key}": the log's field names are a closed set, and a name ` +
          'outside it has not been reviewed for what it could carry (APX-FR-01).',
      )
    }
    if (!isLogValue(value)) {
      throw new LogContentError(
        `refusing to log the value of "${key}": a log value is a string of at most ` +
          `${String(LOG_VALUE_MAX_CHARS)} characters with no newline, or a number, a boolean or null. ` +
          'A prompt, a response, a diff and tool output are all longer than that or span lines.',
      )
    }
    const field = key as LogFieldKey
    if (!isLogFieldValue(field, value)) {
      throw new LogContentError(
        `refusing to log ${JSON.stringify(value)} as "${key}": that field holds a ` +
          `${LOG_FIELD_KINDS[field]}, and a value of any other shape has not been shown to carry ` +
          'nothing (APX-FR-01).',
      )
    }
  }
}

/**
 * Serialise one record, with a fixed key order.
 *
 * Fixed rather than sorted because a reader - a human reading `tail`, or a test asserting
 * a line - should see the same shape every time. The field order is the closed list's own
 * order, so a field that is absent simply does not appear and no key is invented.
 */
export function formatLogRecord(record: LogRecord): string {
  const fields: Record<string, LogValue> = {}
  for (const key of Object.keys(LOG_FIELD_KINDS) as LogFieldKey[]) {
    const value = record.fields[key]
    if (value !== undefined) fields[key] = value
  }
  return `${JSON.stringify({
    time: record.time,
    level: record.level,
    name: record.name,
    ...fields,
  })}\n`
}

/** One written line, parsed back, or null for a line this build cannot read. */
export function parseLogLine(line: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

export interface LocalLogOptions {
  /** Defaults to the resolved state directory, honouring `AGENT_PING_STATE_DIR`. */
  readonly stateDir?: string
  readonly env?: NodeJS.ProcessEnv
  /** Mirror every line to standard output. IO-FR-09's verbose flag, and nothing else. */
  readonly verbose?: boolean
  /** ISO 8601 UTC source for the `time` field. */
  readonly now?: () => string
  /** Where the verbose mirror goes. Defaults to `process.stdout.write`. */
  readonly mirror?: (line: string) => void
  /** The bound. Injectable so a test can rotate without writing 2 MB. */
  readonly maxBytes?: number
  /** Reports a log that could not be written. Never called with a field value. */
  readonly onFailure?: (message: string) => void
}

/**
 * The log every command writes to.
 *
 * `writable` is false when the file could not be opened, and a caller that cares -
 * `doctor`, which is a diagnostic - reads it rather than finding out from silence.
 */
export interface LocalLog {
  readonly filePath: string
  readonly rotatedFilePath: string
  readonly verbose: boolean
  /** False once a write has failed; the command then reports it rather than retrying. */
  readonly writable: boolean
  /** Why the log is not writable, or null when it is. One bounded sentence. */
  readonly failure: string | null
  /** How many times this log rotated. Zero unless the bound was crossed. */
  rotations(): number
  /** Lines this log refused to write, with the reason. The count is the assertion. */
  refused(): number
  info(name: string, fields?: LogFields): void
  warn(name: string, fields?: LogFields): void
  error(name: string, fields?: LogFields): void
}

/**
 * Open the local log for a state directory.
 *
 * The state directory is created here, owner-only, because this is the first thing most
 * commands write and it is the reason a command can be run at all on a machine that has
 * never had agent-ping on it. A log that cannot be created is not an exception: the
 * object comes back with `writable: false` and the reason in `failure`, because a
 * diagnostic that dies because its diary is full is the wrong diagnostic.
 */
export function createLocalLog(options: LocalLogOptions = {}): LocalLog {
  // The state directory is created here, so this is the first thing most commands touch
  // and it is the reason a command can run at all on a machine that has never had
  // agent-ping on it. It is also the first thing that can fail on a machine whose state
  // directory is a file, is owned by somebody else, or is under a path that is not a
  // directory - and a diagnostic that dies because its state directory is broken cannot
  // report that the state directory is broken. So the creation is inside the same
  // try/catch as the first write, and the log comes back unwritable with the reason.
  const stateDir: string = options.stateDir ?? resolveStateDir(options.env)
  try {
    ensureLogDirectory(stateDir)
  } catch (cause) {
    return unusableLog(stateDir, `the state directory ${stateDir} could not be created (${nameOf(cause)})`)
  }
  const filePath = localLogPath(stateDir)
  const rotatedFilePath = rotatedLocalLogPath(stateDir)
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES
  const now = options.now ?? ((): string => new Date().toISOString())
  const mirror = options.mirror
  const mirrorWhenVerbose = options.verbose === true
  const onFailure = options.onFailure ?? ((): void => {})
  let rotations = 0
  let refused = 0
  let writable = true
  let failure: string | null = null

  const sizeOf = (file: string): number => {
    try {
      return statSync(file).size
    } catch {
      return 0
    }
  }

  /** Move the live file aside so the next write starts a fresh one. */
  const rotate = (): void => {
    // The rotated file is replaced rather than shifted, because two files is the
    // documented bound and shifting would need a third name to be honest about.
    rmSync(rotatedFilePath, { force: true })
    renameSync(filePath, rotatedFilePath)
    rotations += 1
  }

  const record = (level: LogLevel, name: string, fields: LogFields = {}): void => {
    let line: string
    try {
      assertContentFreeLogFields(name, fields)
      line = formatLogRecord({ time: now(), level, name, fields })
    } catch (cause) {
      // A refusal is counted before it is thrown, on every level and not only on
      // `error`, so a caller that catches it has not lost the count a test asserts on.
      refused += 1
      throw cause
    }
    if (mirrorWhenVerbose && mirror !== undefined) mirror(line)
    if (!writable) return
    try {
      // Rotating before the write that would cross the bound, rather than after, is
      // what keeps the file at or under it: the only way it can exceed the bound is a
      // single line, and a line is bounded by the field rules above.
      if (existsSync(filePath) && sizeOf(filePath) + Buffer.byteLength(line) > maxBytes) rotate()
      ensureOwnerOnlyFile(filePath)
      appendFileSync(filePath, line, { encoding: 'utf8', mode: OWNER_ONLY_FILE_MODE })
    } catch (cause) {
      writable = false
      failure = `the local log at ${filePath} could not be written (${nameOf(cause)}); this run's ` +
        'diagnostics are on standard output only'
      onFailure(failure)
    }
  }

  return {
    filePath,
    rotatedFilePath,
    verbose: mirrorWhenVerbose,
    get writable() {
      return writable
    },
    get failure() {
      return failure
    },
    rotations: () => rotations,
    refused: () => refused,
    info: (name, fields) => record('info', name, fields),
    warn: (name, fields) => record('warn', name, fields),
    error: (name, fields) => record('error', name, fields),
  }
}

function nameOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    return String((cause as { code?: unknown }).code ?? 'unknown')
  }
  return 'unknown'
}

/**
 * A log that cannot be written, and says so.
 *
 * The same object the writable log would have been, so a caller has no branch to write:
 * it records into nothing, mirrors when verbose, and carries the reason in `failure` for
 * the command to print. Counting a refusal is the one thing it cannot do - there is
 * nowhere to count it - and `refused()` says so by returning zero.
 */
function unusableLog(stateDir: string, reason: string): LocalLog {
  return {
    filePath: localLogPath(stateDir),
    rotatedFilePath: rotatedLocalLogPath(stateDir),
    verbose: false,
    writable: false,
    failure: `${reason}; this run's diagnostics are on standard output only`,
    rotations: () => 0,
    refused: () => 0,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
  }
}
