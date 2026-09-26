// The runtime file: how a harness adapter finds the live hub, and how a second
// instance is refused the machine (HC-FR-01, PRD 6.3, PRD 16 Open Questions 10).
//
// ONE FILE, TWO JOBS, AND THAT IS WHY IT IS ONE FILE
// The runtime file is the pointer ("the hub is on 127.0.0.1:43117") and it is
// also the lock ("a hub is already running"). Those are the same file on purpose:
//
//   - A pointer alone cannot refuse a second instance. Two hubs would each write
//     their own port, the adapters would follow whichever wrote last, and the
//     developer's badge would be counting one of two logs.
//   - A lock alone cannot be found. The adapters need a port, and a separate
//     lock file is a second thing to go stale, to be cleaned up wrongly, and to
//     disagree with the port.
//
// So the file is created exclusively (O_EXCL) before the store is opened and
// before the socket exists, and the port is written into it afterwards. A
// harness reading the file before the port lands sees `port: null` and must fail
// visibly; it must never fall back to a guessed default port. That is the
// difference between "the hub is not up yet" and "the hub is somewhere else",
// and only one of them is safe to retry.
//
// THE CONTRACT, STATED ONCE HERE
// connector-engineer reads this file in the plugin transport (OA-2). The field
// names below are therefore a published contract, not an implementation detail:
//
//   version     1 while this shape is what adapters are written against
//   instanceId  a UUID for this run; two hubs never share one
//   pid         the owning process, used only to detect a lock left by a crash
//   host        always the loopback address; recorded so a reader never assumes
//   port        the live port, or null between claiming the file and binding
//   stateDir    where the log and the token live, so a reader needs one lookup
//   startedAt   ISO 8601 UTC, the instance's own clock
//   schemaVersion the durable schema the hub is running, for `doctor` (IO-2)
//
// Nothing here is conversation content (APX-FR-01): no session, no repository,
// no event, and no field a caller can extend. It is written owner-only inside
// the owner-only state directory, because a port is the whole of the "control
// surface" story and a world-readable one would hand the port to another user.
//
// CRASHES ARE THE NORMAL CASE, NOT THE EXCEPTION (APX-CON-03)
// agent-ping is a sidecar: it is killed and restarted without ceremony, and it
// has to start again afterwards. A file left behind by `kill -9` must therefore
// not wedge the product forever, so a claim whose recorded process is gone is
// reclaimed rather than respected. The reclaim is reported on the claim
// (`reclaimedStaleRuntimeFile`) instead of being silent, because a lock that
// disappears on its own is the kind of thing that should be visible in a bug
// report (APX-FR-02).
//
// The converse is the important half: a file whose process is still running is
// refused, never stolen, even by a process that would happily bind a different
// port. Enforcing that here rather than in the composition root means the rule
// is one function with one test, and the composition root has no way to skip it.
//
// This module opens a file and nothing else: no socket, no subprocess, no
// surface, and no outbound call of any kind (APX-CON-12).

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import {
  OWNER_ONLY_FILE_MODE,
  ensureOwnerOnlyFile,
  ensureStateDir,
  resolveStateDir,
} from '../storage/paths.js'

/**
 * The file name inside the state directory. Named for what it is rather than for
 * what it contains, because the connector transport looks for exactly this.
 */
export const RUNTIME_FILE_NAME = 'hub-runtime.json'

/**
 * The shape version. Bumped only when a field changes meaning or disappears, and
 * never silently: a reader that does not recognise the version must fail rather
 * than read a port out of a record written to a different contract.
 */
export const RUNTIME_FILE_VERSION = 1

/**
 * What the runtime file holds, in the closed field set of the module header.
 *
 * `port: number | null` is deliberate and load-bearing. The file exists before
 * the socket does, so a reader can legitimately find this file with no port in
 * it. That is a hub that is still starting, and the reader's only correct answer
 * is to say so; a default port here would be a guess that reaches a foreign
 * service on the machine.
 */
export interface RuntimeFile {
  readonly version: typeof RUNTIME_FILE_VERSION
  readonly instanceId: string
  readonly pid: number
  readonly host: string
  readonly port: number | null
  readonly stateDir: string
  readonly startedAt: string
  readonly schemaVersion: number
}

/**
 * A malformed or unrecognised runtime file.
 *
 * Thrown rather than swallowed, and it quotes the path and the reason but never
 * the file's contents: a runtime file cannot hold content, but an error message
 * that dumped an arbitrary file into a breadcrumb would be a habit worth not
 * having.
 */
export class HubRuntimeFileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'HubRuntimeFileError'
  }
}

/**
 * Another instance holds the runtime file and its process is still running.
 *
 * A distinct class because the caller's response is a policy decision, not an
 * error handler's: the Electron main entry treats it as "focus the window that
 * already exists and exit quietly", and a packaging script treats it as "the hub
 * is already installed and running". Neither should read as a crash.
 *
 * `existing` is the record the live instance published, so a caller can name the
 * port to connect to rather than guessing.
 */
export class HubAlreadyRunningError extends Error {
  readonly existing: RuntimeFile

  constructor(existing: RuntimeFile) {
    super(
      `agent-ping is already running (instance ${existing.instanceId}, pid ${existing.pid}` +
        `${existing.port === null ? ', still starting' : `, on ${existing.host}:${existing.port}`}` +
        `, started ${existing.startedAt}). Refusing to start a second instance: two hubs would ` +
        'each publish a port and the adapters would follow only one of them.',
    )
    this.name = 'HubAlreadyRunningError'
    this.existing = existing
  }
}

/** The runtime file for a state directory. */
export function runtimeFilePath(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, RUNTIME_FILE_NAME)
}

/** The fields, in a fixed order, so the file is diffable and never gains a key. */
const RUNTIME_FILE_KEYS: readonly (keyof RuntimeFile)[] = [
  'version',
  'instanceId',
  'pid',
  'host',
  'port',
  'stateDir',
  'startedAt',
  'schemaVersion',
]

export interface WriteRuntimeFileOptions {
  /**
   * The schema version to record. Written after the store is opened, because a
   * runtime file that claims a schema the hub is not running is a lie the doctor
   * command would repeat.
   */
  readonly schemaVersion?: number
}

/**
 * Publish the runtime file atomically.
 *
 * Write to a sibling temporary file and rename over the target. A reader either
 * sees the previous complete record or the new complete record, never a
 * half-written one, which matters because the reader is another process polling
 * for the port and a truncated file would be read as a corrupt file (APX-FR-02).
 * The temporary file is owner-only before any byte is written, and the rename
 * preserves that mode, so the port is never briefly world-readable.
 */
export function writeRuntimeFile(
  record: RuntimeFile,
  stateDir: string = resolveStateDir(),
): string {
  const target = runtimeFilePath(stateDir)
  ensureStateDir(stateDir)
  // A record written with a different version is refused rather than rewritten:
  // downgrading the file would destroy the field set a newer adapter reads.
  if (record.version !== RUNTIME_FILE_VERSION) {
    throw new HubRuntimeFileError(
      `refusing to write ${target}: runtime file version ${String(record.version)} is not the ` +
        `version this build publishes (${RUNTIME_FILE_VERSION}).`,
    )
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  const body = `${JSON.stringify(toOrderedRecord(record), null, 2)}\n`
  try {
    ensureOwnerOnlyFile(temporary)
    writeFileSync(temporary, body, { mode: OWNER_ONLY_FILE_MODE })
    renameSync(temporary, target)
  } catch (cause) {
    // The temporary file is this call's own artefact; leaving it behind would
    // accumulate debris in the state directory that nothing ever cleans up.
    try {
      unlinkSync(temporary)
    } catch {
      // Already gone, or a directory we may not touch. Either way the rename
      // below is the thing that failed and that is what the caller must see.
    }
    throw new HubRuntimeFileError(
      `the hub runtime file could not be written to ${target}. The adapters discover the live ` +
        'port from this file, so a hub that cannot write it cannot be found and must not start.',
      { cause },
    )
  }
  return target
}

/**
 * Read the runtime file.
 *
 * Returns null when there is no file, which is the ordinary state of a machine
 * where the hub has never run or has shut down cleanly. Throws when there *is* a
 * file and it cannot be understood, because those are different situations and a
 * reader that treats them the same will either invent a port or report a hub that
 * is not there.
 */
export function readRuntimeFile(stateDir: string = resolveStateDir()): RuntimeFile | null {
  const target = runtimeFilePath(stateDir)
  if (!existsSync(target)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(target, 'utf8'))
  } catch (cause) {
    throw new HubRuntimeFileError(
      `the hub runtime file at ${target} exists but is not readable JSON. Delete it only after ` +
        'confirming no hub is running; a hub that cannot be found by its adapters cannot receive ' +
        'their events.',
      { cause },
    )
  }
  return toRuntimeFile(parsed, target)
}

/**
 * A claim on the runtime file: the exclusive create that refuses a second
 * instance, plus the typed way to publish the port and to give the file back.
 */
export interface HubInstanceClaim {
  /** Where the claim lives, so a caller can report it. */
  readonly filePath: string
  readonly instanceId: string
  readonly pid: number
  /**
   * True when this claim took the file over from a process that is no longer
   * running. Surfaced rather than logged, so the composition root and a test can
   * both see that a restart after a crash happened the way it is designed to.
   */
  readonly reclaimedStaleRuntimeFile: boolean
  /**
   * The pid whose runtime file was reclaimed, or null when the file was free. The
   * number belongs in a bug report about a hub that restarted unexpectedly, and it
   * is the only fact about the dead instance that is safe to keep.
   */
  readonly reclaimedFromPid: number | null
  /** The record as it currently stands on disk. */
  record(): RuntimeFile
  /**
   * Record the live port, turning the file from a lock into the pointer an
   * adapter reads. Called once, after the socket is bound; a second call is
   * refused, because two ports in one file is the failure this whole module exists
   * to prevent.
   *
   * `schemaVersion` is passed here rather than at claim time because the store is
   * opened between the two, and a runtime file that advertises a schema the hub is
   * not running is a lie `doctor` would repeat.
   */
  publishPort(bound: { port: number; host: string; schemaVersion: number }): RuntimeFile
  /**
   * Remove the file. Idempotent, and a no-op once another instance has replaced
   * it, so a late shutdown cannot delete the record of a hub that is now running.
   */
  release(): void
}

export interface ClaimHubInstanceOptions {
  /** Defaults to the resolved state directory. */
  readonly stateDir?: string
  /** The process claiming the file. Defaults to this one; injectable for a test. */
  readonly pid?: number
  /** ISO 8601 UTC source for `startedAt`. */
  readonly now?: () => string
  /** The schema version to publish with the port, once the store is open. */
  readonly schemaVersion?: number
  /**
   * Liveness probe for a recorded pid. Injectable so a test can present a
   * running process and a dead one without guessing at pids; the default asks
   * the operating system, which is the only answer that is true across machines.
   */
  readonly isProcessAlive?: (pid: number) => boolean
}

/**
 * Take the runtime file, or refuse because a live hub already has it.
 *
 * The exclusive create is the whole mechanism. Two processes racing here cannot
 * both win: one gets the file, the other gets EEXIST and then has to decide
 * whether the holder is alive. That decision is the only judgement in this
 * module, and it is deliberately biased towards refusing, because the cost of a
 * false refusal is a message and a retry while the cost of a false takeover is
 * two hubs writing the same log.
 */
export function claimHubInstance(options: ClaimHubInstanceOptions = {}): HubInstanceClaim {
  const stateDir = ensureStateDir(options.stateDir ?? resolveStateDir())
  const target = runtimeFilePath(stateDir)
  const pid = options.pid ?? process.pid
  const now = options.now ?? ((): string => new Date().toISOString())
  const isAlive = options.isProcessAlive ?? isProcessAlive

  const record: RuntimeFile = {
    version: RUNTIME_FILE_VERSION,
    instanceId: randomUUID(),
    pid,
    host: '',
    port: null,
    stateDir,
    startedAt: now(),
    // Recorded as 0 until the store reports its real version: an unknown schema
    // version is honest, a guessed one is not.
    schemaVersion: options.schemaVersion ?? 0,
  }

  let reclaimedStaleRuntimeFile = false
  let reclaimedFromPid: number | null = null
  if (existsSync(target)) {
    const existing = readRuntimeFile(stateDir)
    if (existing === null) {
      // Unreachable in practice: the file existed a moment ago. Treated as a
      // refusal rather than a takeover, because the one thing this function must
      // never do is proceed on a file it could not read.
      throw new HubRuntimeFileError(
        `the hub runtime file at ${target} disappeared while it was being claimed. Retry; if it ` +
          'keeps happening, another process is managing the state directory.',
      )
    }
    if (isAlive(existing.pid)) {
      throw new HubAlreadyRunningError(existing)
    }
    // The holder is gone (APX-CON-03): a killed sidecar must be restartable. The
    // takeover is reported through the claim rather than logged, so it is visible
    // to the composition root and to a test instead of disappearing.
    reclaimedStaleRuntimeFile = true
    reclaimedFromPid = existing.pid
    // The stale file has to go before the exclusive create below, which is the
    // step that does the locking. Removing it is not the claim: if another
    // process wins the create in the gap, the EEXIST path below refuses us
    // rather than letting two hubs share the file.
    try {
      unlinkSync(target)
    } catch {
      // Already removed, most likely by another instance reclaiming it at the
      // same moment. The create below decides who actually holds it.
    }
  }

  try {
    // O_EXCL is the lock. `wx` fails rather than truncating, so a second
    // process cannot delete the record of the first by "creating" it.
    closeSync(openSync(target, 'wx', OWNER_ONLY_FILE_MODE))
  } catch (cause) {
    if (isAlreadyExists(cause)) {
      // Lost the race for the create. The winner wrote the file a moment ago, so
      // its holder is treated as live without a second liveness probe: in a
      // three-way reclaim the bias has to stay towards refusing, because a false
      // refusal costs one retry while a false takeover costs two hubs on one log.
      const winner = readRuntimeFile(stateDir)
      throw winner === null
        ? new HubRuntimeFileError(
            `the hub runtime file at ${target} was claimed by another process and could not then ` +
              'be read. Retry the start.',
            { cause },
          )
        : new HubAlreadyRunningError(winner)
    }
    throw new HubRuntimeFileError(
      `the hub runtime file could not be created at ${target}. A second instance must be refused, ` +
        'and a hub that cannot take this file cannot guarantee that it is the only one.',
      { cause },
    )
  }
  ensureOwnerOnlyFile(target)
  writeRuntimeFile(record, stateDir)

  let published: RuntimeFile = record
  let released = false

  return {
    filePath: target,
    instanceId: record.instanceId,
    pid,
    reclaimedStaleRuntimeFile,
    reclaimedFromPid,
    record: (): RuntimeFile => published,
    publishPort: (bound: { port: number; host: string; schemaVersion: number }): RuntimeFile => {
      if (published.port !== null) {
        throw new HubRuntimeFileError(
          `the hub runtime file at ${target} already publishes port ${published.port}; a second ` +
            'port cannot be published from one instance.',
        )
      }
      const filePath = writeRuntimeFile(
        {
          ...published,
          port: bound.port,
          host: bound.host,
          schemaVersion: bound.schemaVersion,
        },
        stateDir,
      )
      // Read back rather than trusting the object that was written: the published
      // record is the one an adapter will parse, so it is the one the hub reports.
      // A read that cannot succeed is a HubRuntimeFileError from readRuntimeFile,
      // which is the correct outcome - a port this process believes it published
      // and nobody can read is worse than a visible failure.
      const reread = readRuntimeFile(path.dirname(filePath))
      if (reread === null) {
        throw new HubRuntimeFileError(
          `the hub runtime file at ${filePath} was written and then could not be read back.`,
        )
      }
      published = reread
      return published
    },
    release: (): void => {
      if (released) return
      released = true
      // Only remove the file while it is still this instance's record. If a
      // crashed instance's file was reclaimed and this instance has since been
      // replaced, removing it would delete somebody else's live pointer.
      const current = readRuntimeFile(stateDir)
      if (current !== null && current.instanceId !== record.instanceId) return
      try {
        unlinkSync(target)
      } catch {
        // Already gone. Releasing a file that is not there is the outcome the
        // caller wanted.
      }
    },
  }
}

/**
 * Is this process still running?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. EPERM means the process exists and belongs to another user, which
 * for our purposes is alive; ESRCH means it does not exist. Anything else (a pid
 * outside the representable range, for instance) is treated as alive, because the
 * bias of this function is towards assuming a hub is running.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return isPermissionError(cause)
  }
}

function isPermissionError(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === 'EPERM'
  )
}

function isAlreadyExists(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === 'EEXIST'
  )
}

/** The record in a fixed key order, so the published file never varies in shape. */
function toOrderedRecord(record: RuntimeFile): Record<string, unknown> {
  const ordered: Record<string, unknown> = {}
  for (const key of RUNTIME_FILE_KEYS) ordered[key] = record[key]
  return ordered
}

/**
 * Validate a parsed runtime file against the closed field set.
 *
 * Every key must be present and no extra key is tolerated, because a record with
 * an unknown field is a record written by something other than this contract and
 * a reader cannot reason about what it does not recognise. Types are checked
 * rather than coerced: a port that arrived as a string is a port nobody can dial.
 */
function toRuntimeFile(parsed: unknown, source: string): RuntimeFile {
  const reject = (reason: string): never => {
    throw new HubRuntimeFileError(
      `the hub runtime file at ${source} is not a runtime file this build can read: ${reason}. ` +
        'Delete it only after confirming no hub is running.',
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return reject('it is not a JSON object')
  }
  const record = parsed as Record<string, unknown>
  const unknownKeys = Object.keys(record).filter(
    (key) => !RUNTIME_FILE_KEYS.includes(key as keyof RuntimeFile),
  )
  if (unknownKeys.length > 0) {
    return reject(`unexpected field(s) ${unknownKeys.sort().join(', ')}`)
  }
  if (record['version'] !== RUNTIME_FILE_VERSION) {
    return reject(
      `its version is ${JSON.stringify(record['version'])}, not ${RUNTIME_FILE_VERSION}`,
    )
  }
  if (typeof record['instanceId'] !== 'string' || record['instanceId'] === '') {
    return reject('its instanceId is missing or empty')
  }
  if (typeof record['pid'] !== 'number' || !Number.isInteger(record['pid'])) {
    return reject('its pid is not an integer')
  }
  if (typeof record['host'] !== 'string') {
    return reject('its host is not a string')
  }
  const port = record['port']
  if (port !== null && (typeof port !== 'number' || !Number.isInteger(port) || port <= 0)) {
    return reject('its port is neither null nor a positive integer')
  }
  if (typeof record['stateDir'] !== 'string' || record['stateDir'] === '') {
    return reject('its stateDir is missing or empty')
  }
  if (typeof record['startedAt'] !== 'string' || record['startedAt'] === '') {
    return reject('its startedAt is missing or empty')
  }
  if (typeof record['schemaVersion'] !== 'number' || !Number.isInteger(record['schemaVersion'])) {
    return reject('its schemaVersion is not an integer')
  }
  return {
    version: RUNTIME_FILE_VERSION,
    instanceId: record['instanceId'],
    pid: record['pid'],
    host: record['host'],
    port,
    stateDir: record['stateDir'],
    startedAt: record['startedAt'],
    schemaVersion: record['schemaVersion'],
  }
}
