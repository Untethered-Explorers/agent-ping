#!/usr/bin/env node
// Prove the operational contract on the real machine: install, a real user service
// manager, a restart, and pending state that survives it (IO-4: IO-FR-06, IO-FR-08,
// APX-CON-03, APX-CON-06, APX-FR-02, PRD 16 #3).
//
//   node scripts/verify-autostart-linux.mjs
//   node scripts/verify-autostart-linux.mjs --out docs/reviews/autostart-linux-evidence.json
//   node scripts/verify-autostart-linux.mjs --simulate-missing-service-manager
//   node scripts/verify-autostart-linux.mjs --keep-state
//
// THE CLAIM, IN THREE SENTENCES, BEFORE ANY CODE
//
//   positive   With a real `systemd --user` manager on this machine, one
//              `agent-ping install` writes the opencode plugin, writes a user unit the
//              manager itself reports as enabled, and brings up a hub that answers
//              health on loopback. A needs-you item created through the product's own
//              ingest route is still there - once, unchanged - after that hub is stopped
//              through the manager and started again through the manager. Then
//              `agent-ping uninstall` removes the plugin and the unit and keeps the
//              database.
//   negative   A second `agent-ping install` is safe and changes nothing, and a plugin
//              file carrying a different version is *reported* as a mismatch and left
//              alone rather than silently replaced (IO-FR-08). Both halves are read
//              from the command's own output and exit code, not assumed.
//   failure    A machine with no reachable `systemd --user` manager, no built command, no
//              packaged schema, no Electron runtime, or a user manager whose unit search
//              path this shell cannot reach is a non-zero exit naming what was missing
//              and what to do about it. It is never a skip, and no code path exits zero
//              having run nothing.
//
// WHERE THE BOUNDARY IS, AND WHY IT IS NOT WHERE YOU WOULD GUESS
//
//   TEMPORARY:   the product's *state*. `AGENT_PING_STATE_DIR` points at a fresh
//                temporary directory, so the database, the runtime file, the write
//                token and the bounded local log are all created there and the
//                developer's own agent-ping state is never read or written (IO-FR-07).
//   REAL:        the *per-user unit directory*, and nothing can avoid that. A running
//                `systemd --user` manager resolves its own search path from the
//                environment it was started with and ignores a client's
//                `XDG_CONFIG_HOME`: measured on this machine, a unit written under a
//                temporary `XDG_CONFIG_HOME` is invisible to the live manager -
//                `systemctl --user is-enabled` answers `not-found` for a file sitting
//                right there. A run that hid its unit in a temporary directory could
//                not start the hub through the manager, and the restart half of this
//                claim would be a restart by something else. So this script writes the
//                unit where the real manager reads it, and then *restores every path it
//                touched*, byte for byte, on every exit path including the failing ones.
//   VERIFIED:    the preflight refuses to run at all when the manager and this shell
//                disagree about that directory, rather than quietly proving something
//                weaker than it says.
//
// WHAT THE RESTORE IS AND IS NOT SCOPED TO
// "Restored" means *back to what this machine held when the run started*, so a run on a
// machine that already has agent-ping installed puts that install back rather than
// removing it - deleting a developer's own working install to leave the machine tidier
// would be a worse outcome than a leftover. The evidence file records each watched
// path's before and after snapshot, so a reader can tell a restore from a clean-up; the
// `baseline` block names which paths were already there.
// The one thing no restore can cover is a run killed with SIGKILL: nothing runs then, and
// the remedy is `agent-ping uninstall`, which removes the plugin and the unit and keeps
// the database. A crash of *this* script is therefore a maintenance incident, not a claim
// about the product.
//
// WHAT IS THE PRODUCT'S AND WHAT IS THIS SCRIPT'S
//   The CLI is the built `dist/main/cli/index.js`, run as a real child process. The unit
//   is written by the product's own `install`, at the product's own path, from the
//   product's own resolver. The start, the stop, the enablement reading and the
//   "is anything left" reading are `systemctl --user`: the real manager, over its real
//   D-Bus connection. The hub is the product's own packaged Electron entry point, the
//   product's own loopback routes, the product's own ingest classifier and the
//   product's own SQLite log. The pending item is created by posting a harness signal
//   to `POST /api/ingest` exactly as a harness adapter would.
//   This script decides what to observe, when to stop waiting, and whether the run
//   passed. It never reads or writes the database directly, and it does not decide what
//   survives a restart.
//
// SHAPE, PER THE LIVE-VERIFICATION DISCIPLINE
//
//   scripts/verify-autostart-linux.mjs        the assertion inventory, the pure parsers
//                                             and the pure judgement - all exported -
//                                             plus a thin shell that owns every side
//                                             effect
//   tests/scripts/verify-autostart-linux.test.ts
//                                             drives `decide` and every fingerprint
//                                             with injected command results, and spawns
//                                             the real script for the one property that
//                                             can only be established by running it
//
// WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
// It changes no file under `src/` and no product configuration, and it records a product
// defect it finds as a required change rather than patching it. It makes no claim about
// macOS or Windows: the units for those platforms exist and are unit-tested
// (`tests/cli/autostart.test.ts`), and this script is the Linux evidence for a contract
// that has to be re-earned on each of those machines (APX-CON-06). It observes no human
// judgement of any kind - nothing here says a diagnostic was *useful*, because that is
// IO-5's gate and a judgement rather than an assertion.

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export const SCRIPT_NAME = 'verify-autostart-linux'
/** Bumped when the evidence schema changes, so a later reader can tell the two apart. */
export const EVIDENCE_VERSION = 1
export const DEFAULT_EVIDENCE_PATH = 'docs/reviews/autostart-linux-evidence.json'

// ─────────────────────────────────────────────────────────────────────────────
// The product's own names, restated so this script asserts against them
// ─────────────────────────────────────────────────────────────────────────────

/** The manifest's `bin` target: the real command line, run as a child process. */
export const BUILT_CLI = path.join('dist', 'main', 'cli', 'index.js')
/** The packaged durable schema, which `tsc` does not copy and the hub reads at start. */
export const BUILT_SCHEMA = path.join('dist', 'main', 'storage', 'schema.sql')
/** The packaged Electron entry point the unit's `ExecStart` names. */
export const BUILT_ELECTRON_MAIN = path.join('dist', 'main', 'main', 'index.js')
/** The adapter sources the installed plugin is generated from. */
export const PLUGIN_SOURCE_ENTRY = path.join('src', 'plugin', 'opencode', 'index.ts')

export const PLUGIN_FILE_NAME = 'agent-ping.ts'
export const PLUGIN_METADATA_FILE_NAME = 'package.json'
export const RUNTIME_FILE_NAME = 'hub-runtime.json'
export const DATABASE_FILE_NAME = 'agent-ping.db'
export const STATE_DIR_ENV_VAR = 'AGENT_PING_STATE_DIR'
export const XDG_CONFIG_HOME_ENV_VAR = 'XDG_CONFIG_HOME'
export const OPENCODE_DIR_NAME = 'opencode'
export const PLUGIN_DIR_NAME = 'plugins'
/** The unit file systemd expects, and the only name this product uses. */
export const LINUX_UNIT_NAME = 'agent-ping.service'
/** The target a user unit is wanted by; its `.wants` directory is the enablement. */
export const LINUX_WANTS_TARGET = 'default.target'
/** The per-user unit directory, below the XDG configuration root. */
export const LINUX_UNIT_SEGMENTS = Object.freeze(['systemd', 'user'])
/** The line `install` writes into the plugin header, and the next install reads. */
export const PLUGIN_VERSION_LINE = /^\/\/ product-version: (.+)$/m

// ─────────────────────────────────────────────────────────────────────────────
// Bounds
// ─────────────────────────────────────────────────────────────────────────────

/** How long one child process of this script may take before it is killed. */
export const CLI_TIMEOUT_MS = 180_000
/** How long a `systemctl --user` call may take. Short: it is a local D-Bus round trip. */
export const SYSTEMCTL_TIMEOUT_MS = 30_000
/** How long a hub started through the service manager may take to publish a port. */
export const HUB_READY_TIMEOUT_MS = 60_000
/** How long a stopped hub may take to release its runtime file. */
export const HUB_STOP_TIMEOUT_MS = 30_000
/** How long one loopback request may take. */
export const REQUEST_TIMEOUT_MS = 10_000
/** How often a wait re-reads. A poll interval, not a fixed attempt count. */
export const POLL_MS = 200

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the assertion inventory. The number a shortfall is measured against
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many assertions a complete run executes.
 *
 * A fixed number, and a shortfall is a failure. Every row below is emitted by the run
 * whether or not the step it describes succeeded: a step that could not produce its
 * answer emits a `not-observed` row carrying the reason, never no row at all. That is
 * what stops a swallowed exception in the collection phase from becoming a green run
 * that proved nothing.
 */
export const ASSERTIONS_EXPECTED = 24

/**
 * Every assertion this run owes: its id, the sentence a human reads, the exact answer
 * `expected` is compared against, and the group the story reads it under.
 *
 * The list is the contract between the shell and the judgement, and the suite reads it
 * for the reason the dashboard script's journey list exists: a list only the script read
 * could be edited without changing what ran, and a list that names twenty-four
 * obligations is a list a reader can hold against the requirements.
 *
 * `expected` is a short canonical phrase rather than a sentence, so a mismatch in the
 * summary is readable on its own without the evidence file open beside it.
 */
export const ASSERTION_INVENTORY = Object.freeze([
  {
    id: 'built-command-and-schema-are-present',
    group: 'opening',
    expected: 'all present',
    name: 'the built command entry point, the packaged schema, the packaged Electron main and the adapter sources are all present',
  },
  {
    id: 'install-wrote-the-global-plugin',
    group: 'opening',
    expected: 'one plugin file',
    name: 'install wrote exactly one opencode plugin file at the per-user global plugin path',
  },
  {
    id: 'install-enabled-a-unit-the-live-manager-reads',
    group: 'opening',
    expected: 'unit + wants link + manager enabled',
    name: 'install wrote a systemd user unit that the live user service manager itself reports as enabled (IO-FR-06)',
  },
  {
    id: 'install-brought-up-a-serving-hub',
    group: 'opening',
    expected: 'published port + health',
    name: 'install brought up a hub that published a runtime file and answered health on its own loopback origin',
  },
  {
    id: 'health-payload-is-ok-and-readable',
    group: 'health',
    expected: 'status ok + readable',
    name: 'the health payload reports status ok and a readable database',
  },
  {
    id: 'hub-is-listening-on-loopback-with-its-own-pid',
    group: 'health',
    expected: 'loopback + listening + named by the runtime file',
    name: 'the hub is listening on the loopback address and the runtime file names the serving process',
  },
  {
    id: 'doctor-reads-the-unit-as-ok',
    group: 'health',
    expected: 'autostart ok',
    name: 'agent-ping doctor read the autostart unit as ok, from outside the process that wrote it',
  },
  {
    id: 'ingest-accepted-a-needs-you-block',
    group: 'pending',
    expected: '202 accepted, class needs-you',
    name: 'a needs-you harness signal posted through the product own ingest route was accepted as needs-you',
  },
  {
    id: 'pending-set-holds-exactly-one-item',
    group: 'pending',
    expected: 'exactly 1 pending item',
    name: 'the pending set holds exactly one item after the signal',
  },
  {
    id: 'the-item-is-the-block-this-run-created',
    group: 'pending',
    expected: 'this run block identity',
    name: 'the pending item carries the repository short name and the block identity this run sent',
  },
  {
    id: 'stop-through-the-manager-released-the-runtime-file',
    group: 'restart',
    expected: 'stopped + runtime file released',
    name: 'stopping the process install started took the hub down and released its runtime file',
  },
  {
    id: 'start-through-the-manager-activated-the-unit',
    group: 'restart',
    expected: 'is-active active + a port published',
    name: 'starting the unit through the service manager activated it and brought a hub up',
  },
  {
    id: 'the-restarted-hub-is-a-different-process-and-instance',
    group: 'restart',
    expected: 'different pid + different instance',
    name: 'the restarted hub is a different process with a different instance identity, so the restart really happened',
  },
  {
    id: 'the-pending-item-survived-the-restart',
    group: 'restart',
    expected: 'identical pending fingerprint',
    name: 'the pending item survived the restart unchanged and exactly once',
  },
  {
    id: 'its-history-row-survived-the-restart',
    group: 'restart',
    expected: 'identical history fingerprint, 1 occurrence',
    name: 'the history row for that block survived the restart unchanged and exactly once',
  },
  {
    id: 'the-pending-count-is-unchanged',
    group: 'restart',
    expected: 'same pending count',
    name: 'the pending count the restarted hub reports is the count the previous hub reported',
  },
  {
    id: 'a-second-install-changes-nothing',
    group: 'repeat',
    expected: 'exit 0 + nothing changed',
    name: 'a second install is safe, exits zero and reports that nothing was changed (IO-FR-08)',
  },
  {
    id: 'a-differing-plugin-version-is-reported-not-replaced',
    group: 'repeat',
    expected: 'non-zero + remedy names both ways + file untouched',
    name: 'an installed plugin carrying a different version is reported as a mismatch, names both ways forward and is not replaced (IO-FR-08)',
  },
  {
    id: 'uninstall-removed-the-plugin-file',
    group: 'teardown',
    expected: 'plugin file gone',
    name: 'uninstall removed the opencode plugin file',
  },
  {
    id: 'uninstall-removed-the-unit-and-its-wants-link',
    group: 'teardown',
    expected: 'unit + wants link gone',
    name: 'uninstall removed the systemd user unit and its wants symlink',
  },
  {
    id: 'the-manager-reports-no-agent-ping-unit-left',
    group: 'teardown',
    expected: 'not-found + nothing in the wants directory',
    name: 'the live user service manager reports no agent-ping unit and nothing wants it',
  },
  {
    id: 'uninstall-kept-the-database',
    group: 'teardown',
    expected: 'database present + output said kept',
    name: 'uninstall kept the database, and said so',
  },
  {
    id: 'product-state-stays-inside-the-temporary-directory',
    group: 'isolation',
    expected: 'inside the temporary state directory',
    name: 'the database and the runtime file were created inside the temporary state directory, not in the developer own',
  },
  {
    id: 'every-real-machine-path-was-restored',
    group: 'isolation',
    expected: 'every watched path restored',
    name: 'every path this run touched outside the temporary directory is back to exactly what it was before',
  },
])

/** One dependency this run needs, and what to do about it when it is absent. */
export const DependencyStatus = Object.freeze({
  PLATFORM: 'a Linux machine (this script drives systemd --user and nothing else)',
  SERVICE_MANAGER: 'a reachable systemd user service manager for this account',
  UNIT_DIRECTORY: 'a per-user unit directory the live service manager actually reads',
  NO_LIVE_HUB: 'no agent-ping already running against this account own state directory',
  BUILT_CLI: 'the built command entry point',
  BUILT_SCHEMA: 'the packaged durable schema beside the build',
  BUILT_MAIN: 'the packaged Electron main entry point',
  PLUGIN_SOURCES: 'the adapter sources the installed plugin is generated from',
  ELECTRON: 'the Electron runtime this package installed',
})

/** The reading a step produces when it could not answer. Never a pass. */
export const NOT_OBSERVED = 'not-observed'

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the judgement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The verdict, as a pure function of what was observed and what was available.
 *
 * Three ways this can fail, and all three are failures rather than qualifications:
 *
 *   - a dependency was absent. There is no third option: a green result that exercised
 *     nothing is worse than a red one, because it is indistinguishable from a pass. Every
 *     absent dependency contributes a line naming it and carrying its remedy, because a
 *     non-zero exit with no next action trains people to ignore the exit code.
 *   - fewer assertions produced an answer than the inventory expects. This is the
 *     no-zero-work guard, and it is checked before the per-row comparison so a short run
 *     says what it did not do rather than only what it got wrong.
 *   - a row's `actual` did not equal its `expected`. A `not-observed` reading is a
 *     mismatch like any other, which is what keeps "the step never ran" from being
 *     reported as "the step found nothing wrong".
 *
 * No threshold, no scoring and no partial credit. A pending item either survived a real
 * service-manager restart, once, or it did not.
 */
export function decide(observations, ctx) {
  const expected = ctx?.assertionsExpected ?? ASSERTIONS_EXPECTED
  const dependencies = ctx?.dependencies ?? []
  const rows = Array.isArray(observations) ? observations : []
  const missing = dependencies.filter((dependency) => dependency.present !== true)
  const failures = []
  const answered = rows.filter((entry) => entry.actual !== NOT_OBSERVED)

  for (const dependency of missing) {
    failures.push(
      `required dependency unavailable: ${dependency.name}. ${
        dependency.remedy ??
        'no remedy is recorded for this dependency, which is itself a defect in this script'
      }`,
    )
  }
  if (answered.length < expected) {
    const tail =
      rows.length < expected
        ? `The run emitted ${rows.length} rows, so ${String(expected - rows.length)} declared assertions produced no row at all - a filter, a rename, or a refactor that dropped a step.`
        : `${String(expected - answered.length)} declared assertions were not observed.`
    failures.push(
      `executed ${answered.length} of ${expected} assertions; a green result that exercised nothing is not a pass. ${tail}`,
    )
  }
  for (const entry of rows) {
    if (entry.actual === entry.expected) continue
    failures.push(`${entry.id} (${entry.name}): expected ${entry.expected}, observed ${entry.actual}`)
  }

  return {
    verdict: failures.length === 0 ? 'pass' : 'fail',
    exitCode: failures.length === 0 ? 0 : 1,
    assertionsExpected: expected,
    assertionsRun: answered.length,
    assertions: rows,
    failures,
    missingDependencies: missing.map(
      (dependency) => `${dependency.name}: ${dependency.remedy ?? 'remedy not recorded'}`,
    ),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the parsers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One command's own output, read as the report the product documents.
 *
 * `install` and `uninstall` print a header sentence, then one aligned row per subject,
 * then one `remedy (<subject>):` line per failure (src/cli/output.ts, `summarise` and
 * `checkBlock`). This reads that shape and nothing else: the first non-blank line is the
 * header, a `  <subject>  <value>` line is a row whose subject is its first token, and a
 * `  remedy (<subject>): <text>` line is that subject's remedy.
 *
 * Pure, and the reason IO-FR-08's "reports that nothing changed" can be asserted at all:
 * that is a sentence the product prints, and a script that judged it by re-deriving
 * whether bytes changed would be asserting something the product never claimed.
 */
export function parseCommandReport(text) {
  const rows = Object.create(null)
  const remedies = Object.create(null)
  let header = ''
  let summary = ''
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (header === '') {
      header = trimmed
      continue
    }
    const remedy = /^remedy \(([^)]+)\):\s*(.*)$/.exec(trimmed)
    if (remedy !== null) {
      const subject = remedy[1]
      remedies[subject] = remedies[subject] === undefined ? remedy[2] : `${remedies[subject]} ${remedy[2]}`
      continue
    }
    if (/checks? (passed|failed)\.?$/.test(trimmed)) {
      summary = trimmed
      continue
    }
    if (!line.startsWith('  ')) continue
    const parts = trimmed.split(/\s+/)
    const subject = parts[0]
    const value = parts.slice(1).join(' ')
    if (subject === undefined || value === '') continue
    rows[subject] = value
  }
  return { header, summary, rows, remedies }
}

/**
 * How many subjects a report says it changed.
 *
 * `install` and `uninstall` print `nothing was changed` when the answer is zero and
 * `N change(s).` otherwise, so the header carries the product's own count and this reads
 * it rather than re-deriving it.
 */
export function reportChangeCount(report) {
  if (typeof report?.header !== 'string') return 0
  if (report.header.includes('nothing was changed')) return 0
  const match = /(\d+) change/.exec(report.header)
  return match === null ? 0 : Number.parseInt(match[1], 10)
}

/** Did the command's own header say it changed nothing? */
export function reportChangedNothing(report) {
  return typeof report?.header === 'string' && report.header.includes('nothing was changed')
}

/**
 * `doctor`'s check block, read as name -> verdict.
 *
 * `checkBlock` prints `  <name>  <verdict>  <detail>` with the three closed verdicts
 * `ok`, `fail` and `unknown` in a fixed-width column. A check this run looks up by name
 * that is absent is a failure of the *script's* assumption, reported as such rather than
 * read as `fail`.
 */
export function parseCheckBlock(text) {
  const checks = Object.create(null)
  for (const line of String(text ?? '').split('\n')) {
    if (!line.startsWith('  ')) continue
    const parts = line.trim().split(/\s+/)
    const name = parts[0]
    const verdict = parts[1]
    if (name === undefined || verdict === undefined) continue
    if (verdict !== 'ok' && verdict !== 'fail' && verdict !== 'unknown') continue
    checks[name] = { verdict, detail: parts.slice(2).join(' ') }
  }
  return checks
}

/**
 * The runtime file, as the closed field set `src/hub/runtime-file.ts` publishes.
 *
 * A missing or unreadable file is `null` rather than a thrown error: the question the
 * caller asks - "is a hub publishing a port right now" - has a negative answer, and a
 * reader that threw would report a crash where the finding is a shortfall.
 */
export function parseRuntimeFile(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed
  if (typeof record.host !== 'string' || typeof record.port !== 'number') return null
  if (typeof record.pid !== 'number' || typeof record.instanceId !== 'string') return null
  return {
    host: record.host,
    port: record.port,
    pid: record.pid,
    instanceId: record.instanceId,
    stateDir: typeof record.stateDir === 'string' ? record.stateDir : '',
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
  }
}

/**
 * One pending set, as a canonical string.
 *
 * Sorted and field-selected, so the comparison asks "is this the same set" rather than
 * "did the JSON come back in the same order". Only the product's own content-free fields
 * are read - the row key, the class, the dedupe key, the two state columns and the
 * repository short name - so nothing here can hold a prompt and neither can the evidence
 * file this ends up in (APX-FR-01).
 */
export function pendingFingerprint(items) {
  const list = Array.isArray(items) ? items : []
  return list
    .map((item) => {
      const record = item ?? {}
      return [
        String(record.eventId ?? '?'),
        String(record.class ?? '?'),
        String(record.dedupeKey ?? '?'),
        String(record.ackState ?? '?'),
        String(record.resolutionState ?? '?'),
        String(record.repoShortName ?? '?'),
      ].join('|')
    })
    .sort()
    .join('\n')
}

/** The bounded history, as a canonical string, narrowed to the fields that matter. */
export function historyFingerprint(events) {
  const list = Array.isArray(events) ? events : []
  return list
    .map((event) => {
      const record = event ?? {}
      return [
        String(record.eventId ?? '?'),
        String(record.class ?? '?'),
        String(record.rawEventType ?? '?'),
        String(record.dedupeKey ?? '?'),
        String(record.ackState ?? '?'),
        String(record.resolutionState ?? '?'),
        String(record.occurredAt ?? '?'),
      ].join('|')
    })
    .sort()
    .join('\n')
}

/** The health payload, as a canonical string. Counts and closed tokens only. */
export function healthFingerprint(health) {
  const record = health ?? {}
  const database = record.database ?? {}
  return [
    `status=${String(record.status ?? '?')}`,
    `readable=${String(database.readable ?? '?')}`,
    `pendingCount=${String(database.pendingCount ?? '?')}`,
  ].join(' ')
}

/** How many times one row key appears in a history list. The duplication counter. */
export function historyOccurrences(events, eventId) {
  const list = Array.isArray(events) ? events : []
  return list.filter((event) => (event ?? {}).eventId === eventId).length
}

/** Does a path sit inside a directory? The isolation check, as one comparison. */
export function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** Is this process alive? Signal 0: the only liveness question there is. */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return typeof cause === 'object' && cause !== null && cause.code === 'EPERM'
  }
}

/** `KEY=VALUE` lines, as a map. `systemctl --user show-environment` prints nothing else. */
export function parseManagerEnvironment(text) {
  const variables = Object.create(null)
  for (const line of String(text ?? '').split('\n')) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    variables[line.slice(0, at)] = line.slice(at + 1)
  }
  return variables
}

/**
 * The XDG configuration root both the manager and the product resolve, the same way.
 *
 * `path.posix`, not `path`. Everything below this point is an XDG path, and an XDG path
 * is a POSIX path by definition: `~/.config`, `$XDG_STATE_HOME`, `$XDG_CONFIG_HOME` are
 * Linux conventions with forward slashes whether or not the script happens to be running
 * on Linux. Using the ambient `path` meant these three functions returned
 * `\home\dev\.config` on a Windows host while returning `/home/dev/.config` on Linux, so
 * the same function had two different answers and the Windows CI cell caught it. The
 * ambient flavour is correct nowhere here, so these are deliberately the POSIX one.
 */
export function effectiveConfigRoot(xdgConfigHome, home) {
  const override = typeof xdgConfigHome === 'string' ? xdgConfigHome.trim() : ''
  return override === '' ? path.posix.join(home, '.config') : override
}

/**
 * This account's own agent-ping state directory, resolved the product's way.
 *
 * `HOME` falls back to `homedir()` rather than to an empty string. An empty string makes
 * `path.join` return a *relative* path, so a missing `HOME` would resolve the state
 * directory against the current working directory and this script would then watch and
 * assert against a path that does not exist — a failure that reads as a missing product
 * rather than as a missing variable. `path.posix.join` for the reason given on
 * `effectiveConfigRoot`.
 */
export function resolveRealStateDir(env = process.env) {
  const xdgStateHome = typeof env['XDG_STATE_HOME'] === 'string' ? env['XDG_STATE_HOME'].trim() : ''
  const base =
    xdgStateHome === ''
      ? path.posix.join(env['HOME'] ?? homedir(), '.local', 'state')
      : xdgStateHome
  return path.posix.join(base, 'agent-ping')
}

/** The opencode global plugin directory, resolved the product's way. See resolveRealStateDir. */
export function resolveRealPluginDir(env = process.env) {
  return path.posix.join(
    effectiveConfigRoot(env[XDG_CONFIG_HOME_ENV_VAR], env['HOME'] ?? homedir()),
    OPENCODE_DIR_NAME,
    PLUGIN_DIR_NAME,
  )
}

/** The Electron runtime this package installed, or null. The unit's own resolution. */
export function resolveElectronPath() {
  try {
    const resolved = createRequire(import.meta.url)('electron')
    return typeof resolved === 'string' && resolved.trim() === '' ? null : resolved
  } catch {
    const direct = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron')
    return existsSync(direct) ? direct : null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The shell's impure half: running things
// ─────────────────────────────────────────────────────────────────────────────

const log = (message) => {
  process.stderr.write(`[${SCRIPT_NAME}] ${message}\n`)
}
const emit = (summary) => {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}
const nowIso = () => new Date().toISOString()
/**
 * A ref'd pause, deliberately not unref'd.
 *
 * Every wait in this script polls a *detached* process - a hub the service manager
 * started, or one this run asked to stop - so nothing in this event loop is holding the
 * process open except the poll itself. An unref'd timer there empties the loop, Node
 * exits 13, and the `finally` that restores every path this run touched never runs: the
 * first version of this script sent SIGTERM to a hub and was killed by its own timer
 * before it could watch the hub shut down. The timer is the work; it stays referenced.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A handle that keeps this process alive for the duration of the run.
 *
 * Belt and braces over the ref'd poll above, and it encodes the same lesson: this script
 * is *about* other processes, so there is no natural handle keeping it running and a
 * future refactor that unrefs something must not be able to end the run half way with a
 * unit and a plugin file on the developer's machine.
 */
function keepAlive() {
  const handle = setInterval(() => {}, 60_000)
  return () => clearInterval(handle)
}

/** A one-line description of a value, for putting into a comparison string. */
function describe(value) {
  if (value === null || value === undefined) return 'absent'
  if (typeof value === 'string') return value === '' ? 'empty' : value
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  return typeof value
}

/** The verdict for a boolean fact, in the product's own language. */
function verdictFor(condition) {
  return condition ? 'true' : 'false'
}

/** Run a child process to completion, capturing both streams. Never throws. */
function runProcess(command, args, options = {}) {
  const started = Date.now()
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? CLI_TIMEOUT_MS,
    // stdin closed: a child of a verification run must never be able to wait on a human.
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  })
  return {
    command: `${command} ${args.join(' ')}`,
    status: result.status ?? null,
    signal: result.signal ?? null,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error === undefined ? null : `${result.error.name}: ${result.error.message}`,
    durationMs: Date.now() - started,
  }
}

/** Run the product's own command line as a child process, and read its own report. */
export function runCli(env, args) {
  const result = runProcess(process.execPath, [path.join(repoRoot, BUILT_CLI), ...args], { env })
  return { ...result, report: parseCommandReport(`${result.stdout}\n${result.stderr}`) }
}

/** Run `systemctl --user`: the real manager, over its real D-Bus connection. */
export function systemctl(args, options = {}) {
  return runProcess('systemctl', ['--user', ...args], {
    timeoutMs: options.timeoutMs ?? SYSTEMCTL_TIMEOUT_MS,
    ...(options.env === undefined ? {} : { env: options.env }),
  })
}

/** One JSON request over the hub's own loopback socket. Never throws. */
function httpJson(origin, init) {
  const { hostname, port } = new URL(origin)
  return new Promise((resolve) => {
    let settled = false
    const finish = (answer) => {
      if (settled) return
      settled = true
      resolve(answer)
    }
    const body = init.body === undefined ? null : JSON.stringify(init.body)
    const outgoing = httpRequest(
      {
        host: hostname,
        port,
        path: init.pathname,
        method: init.method,
        headers: {
          accept: 'application/json',
          ...(body === null
            ? {}
            : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
        },
        agent: false,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed
          try {
            parsed = text === '' ? null : JSON.parse(text)
          } catch {
            parsed = null
          }
          finish({ ok: true, status: response.statusCode ?? 0, body: parsed, text })
        })
      },
    )
    outgoing.setTimeout(REQUEST_TIMEOUT_MS, () => {
      outgoing.destroy()
      finish({ ok: false, status: 0, body: null, text: '', error: 'the request timed out' })
    })
    outgoing.on('error', (cause) => {
      finish({ ok: false, status: 0, body: null, text: '', error: `${cause.code ?? cause.name}` })
    })
    if (body === null) outgoing.end()
    else outgoing.end(body)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The preflight
// ─────────────────────────────────────────────────────────────────────────────

/** One dependency reading, in the shape `decide` and the summary both read. */
function dependency(name, present, remedy, detail) {
  return { name, present, remedy, detail }
}

/**
 * What this run needs before it may touch anything.
 *
 * Every answer is a fact about this machine, read from the machine: a dependency is never
 * assumed, never stubbed and never tolerated. The second refusal is the one worth reading
 * twice - the manager's unit search path is fixed when the manager started, so a shell
 * whose `XDG_CONFIG_HOME` differs from the manager's would write a unit the manager cannot
 * see, and a run in that state would "prove" a restart by something that is not a service
 * manager at all.
 */
export function preflight(options = {}) {
  const simulate = options.simulateMissingServiceManager === true
  const dependencies = []

  dependencies.push(
    dependency(
      DependencyStatus.PLATFORM,
      process.platform === 'linux',
      'this script drives `systemctl --user` and the systemd per-user unit layout, so it runs on Linux. ' +
        'macOS and Windows have their own units (a launchd user agent, a Startup-folder entry) and the same ' +
        'contract has to be re-earned on those machines; APX-CON-06 forbids claiming either from a Linux one',
      `this process reports platform ${process.platform}`,
    ),
  )

  // The manager itself. `show-environment` is the cheapest call that proves a D-Bus
  // connection to *this account's* manager exists and answers.
  const managerEnv = simulate ? null : systemctl(['show-environment'])
  const managerReachable = !simulate && managerEnv.status === 0
  dependencies.push(
    dependency(
      DependencyStatus.SERVICE_MANAGER,
      managerReachable,
      'log in on a desktop session and run this again: the user manager answers over $XDG_RUNTIME_DIR ' +
        '(`/run/user/<uid>`). `loginctl show-user $USER` says whether a user manager is running, and it has to be ' +
        'one that can reach that socket without root',
      simulate
        ? 'the service-manager reading was suppressed by --simulate-missing-service-manager'
        : `systemctl --user show-environment exited ${describe(managerEnv.status)}${managerEnv.error === null ? '' : ` (${managerEnv.error})`}`,
    ),
  )

  // The environment the manager itself was started with, which is what decides its unit
  // search path. Parsed from the same call and compared with this shell's. `homedir()`
  // rather than `process.env.HOME`: this script is invoked from a service-manager context
  // and from a CI step, and neither guarantees HOME is in the environment, while a
  // `systemd --user` manager can be reading the account's real home either way.
  const managerVariables = managerReachable ? parseManagerEnvironment(managerEnv.stdout) : null
  const shellHome = homedir()
  const shellRoot = effectiveConfigRoot(process.env[XDG_CONFIG_HOME_ENV_VAR], shellHome)
  const managerRoot =
    managerVariables === null
      ? null
      : effectiveConfigRoot(managerVariables[XDG_CONFIG_HOME_ENV_VAR], managerVariables['HOME'] ?? shellHome)
  const unitDirectory =
    managerRoot === null ? null : path.join(managerRoot, ...LINUX_UNIT_SEGMENTS)
  const unitFile = unitDirectory === null ? null : path.join(unitDirectory, LINUX_UNIT_NAME)
  dependencies.push(
    dependency(
      DependencyStatus.UNIT_DIRECTORY,
      !simulate && managerRoot !== null && managerRoot === shellRoot,
      'the running user manager resolves unit files from the environment it was *started* with and ignores a ' +
        "client's XDG_CONFIG_HOME, so a unit written anywhere else can never be started by it. Re-run this from a " +
        'shell whose XDG_CONFIG_HOME is the one the user manager was started with - usually: neither sets it and ' +
        'both use $HOME/.config - and log out and back in if the two have drifted',
      `the manager reads units from ${describe(managerRoot)} while this shell resolves agent-ping's unit into ` +
        `${describe(path.join(shellRoot, ...LINUX_UNIT_SEGMENTS))}`,
    ),
  )

  // A hub already running for this account's own state directory would hold both the
  // runtime file and Electron's single-instance lock, so the unit this run starts would
  // quit on start and the run would be observing something that is not this run.
  const realStateDir = resolveRealStateDir()
  const realRuntimeFile = path.join(realStateDir, RUNTIME_FILE_NAME)
  const existingHub = readRuntimeFileOrNull(realStateDir)
  const liveHub = existingHub !== null && isProcessAlive(existingHub.pid)
  dependencies.push(
    dependency(
      DependencyStatus.NO_LIVE_HUB,
      !liveHub,
      'stop the agent-ping already running for this account before running this: it holds the runtime file and ' +
        'Electron single-instance lock, so the hub this run starts would be refused. `agent-ping status` reports ' +
        `whether one is up; its runtime file is ${realRuntimeFile}`,
      liveHub
        ? `pid ${existingHub.pid} is alive and publishing ${describe(existingHub.host)}:${describe(existingHub.port)} from ${realStateDir}`
        : `no live hub publishes ${realRuntimeFile}`,
    ),
  )

  for (const [name, relative, remedy] of [
    [
      DependencyStatus.BUILT_CLI,
      BUILT_CLI,
      'run `npm run build` in the repository root; `tsc` emits the command into dist/main',
    ],
    [
      DependencyStatus.BUILT_SCHEMA,
      BUILT_SCHEMA,
      'run `npm run build`; scripts/build.mjs copies the durable schema beside the emitted store, and `tsc` alone does not copy it',
    ],
    [
      DependencyStatus.BUILT_MAIN,
      BUILT_ELECTRON_MAIN,
      'run `npm run build`; the unit starts this file as the Electron main entry point',
    ],
    [
      DependencyStatus.PLUGIN_SOURCES,
      PLUGIN_SOURCE_ENTRY,
      'run `npm install` in a checkout, or install the published package: `install` generates the plugin file from these sources and cannot generate it from a package that does not ship them',
    ],
  ]) {
    const target = path.join(repoRoot, relative)
    dependencies.push(
      dependency(name, existsSync(target), remedy, `${target} (${existsSync(target) ? 'present' : 'absent'})`),
    )
  }

  const electron = resolveElectronPath()
  dependencies.push(
    dependency(
      DependencyStatus.ELECTRON,
      electron !== null,
      'run `npm install` in the repository root; Electron is a runtime dependency, and the unit this run starts is ' +
        "this package's own Electron runtime by absolute path, so a build without it cannot start a hub at all",
      electron === null ? 'the `electron` package resolved to nothing from this checkout' : electron,
    ),
  )

  const version = simulate ? null : systemctl(['--version'])
  return {
    dependencies,
    unitFile,
    unitDirectory,
    realStateDir,
    managerVariables,
    systemdVersion: version === null ? null : (version.stdout.split('\n')[0] ?? null),
    sessionType: managerVariables === null ? null : (managerVariables['XDG_SESSION_TYPE'] ?? null),
  }
}

function readRuntimeFileOrNull(stateDir) {
  const file = path.join(stateDir, RUNTIME_FILE_NAME)
  if (!existsSync(file)) return null
  try {
    return parseRuntimeFile(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The paths this run touches outside its temporary directory, and how it puts them back
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One watched path: what it was before, and what to make it be again.
 *
 * A per-user autostart unit cannot live in a temporary directory and still be a real one
 * (see the header), so this run writes three real paths - the plugin file, its install
 * record, and the unit with its wants symlink - and every one of them is watched,
 * recorded and restored. The Electron runtime's own per-user profile directory is watched
 * for the same reason: the packaged application creates it whenever it runs, on any
 * platform, and a run that reported "nothing left behind" while a Chromium profile sat
 * in the configuration directory would be reporting something untrue.
 */
export class WatchedPath {
  constructor(label, target) {
    this.label = label
    this.target = target
    this.before = snapshotPath(target)
    this.backup = null
  }

  /** Put this path back the way it was. Returns a line saying what happened. */
  restore() {
    const after = snapshotPath(this.target)
    if (sameSnapshot(this.before, after)) return `${this.label}: unchanged`
    if (this.before.kind === 'absent') {
      if (after.kind === 'directory') {
        if (!isEmptyDirectory(this.target)) {
          return `${this.label}: RESIDUE - ${this.target} exists and is not empty, so it was left in place`
        }
        rmdirSync(this.target)
        return `${this.label}: removed the directory this run created`
      }
      unlinkIfPresent(this.target)
      return `${this.label}: removed what this run wrote`
    }
    // It was there before, so it goes back: the recorded bytes for a file, the recorded
    // target for a symlink, and the recorded existence for a directory.
    if (this.before.kind === 'directory') {
      mkdirIfAbsent(this.target, 0o700)
      return `${this.label}: present again as the directory it was`
    }
    unlinkIfPresent(this.target)
    ensureParent(this.target)
    if (this.before.kind === 'file' && this.backup !== null) copyFileSync(this.backup, this.target)
    if (this.before.kind === 'symlink') symlinkSync(this.before.target, this.target)
    return `${this.label}: restored the ${this.before.kind} it was`
  }
}

function snapshotPath(target) {
  try {
    const stats = lstatSync(target)
    if (stats.isSymbolicLink()) {
      return { kind: 'symlink', target: readlinkSync(target), mode: stats.mode & 0o777 }
    }
    if (stats.isDirectory()) return { kind: 'directory', mode: stats.mode & 0o777 }
    return { kind: 'file', mode: stats.mode & 0o777, size: stats.size }
  } catch {
    return { kind: 'absent' }
  }
}

function sameSnapshot(left, right) {
  if (left.kind !== right.kind) return false
  if (left.kind === 'absent') return true
  if (left.kind === 'symlink') return left.target === right.target
  if (left.kind === 'directory') return true
  return left.size === right.size && left.mode === right.mode
}

function isEmptyDirectory(target) {
  try {
    return readdirSync(target).length === 0
  } catch {
    return false
  }
}

function unlinkIfPresent(target) {
  try {
    unlinkSync(target)
  } catch {
    // Already gone, which is the outcome the caller wanted.
  }
}

function mkdirIfAbsent(target, mode) {
  if (existsSync(target)) return
  mkdirSync(target, { recursive: true, mode })
}

function ensureParent(target) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
}

/** Copy a watched file's bytes into the backup area, once. */
function backUpFile(watched, backupDir, index) {
  if (watched.before.kind !== 'file') return
  const copy = path.join(backupDir, `${String(index)}-${path.basename(watched.target)}`)
  copyFileSync(watched.target, copy)
  watched.backup = copy
}

/**
 * Put every watched path back, deepest first.
 *
 * Deepest first because that is the only order in which a directory this run created is
 * empty by the time its own entry is considered: the unit file and the wants symlink are
 * restored before `systemd/user` is asked whether it should still exist.
 */
export function restoreWatched(watched) {
  const lines = []
  const residue = []
  for (const entry of [...watched].sort((left, right) => right.target.length - left.target.length)) {
    const line = entry.restore()
    lines.push(line)
    if (line.includes('RESIDUE')) residue.push(line)
  }
  systemctl(['daemon-reload'])
  return { lines, residue }
}

// ─────────────────────────────────────────────────────────────────────────────
// The observations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The inventory entry for an id, or a thrown error.
 *
 * Thrown rather than tolerated, because a typo in an id would otherwise be a row with no
 * entry behind it: a comparison against an undefined `expected` can only ever fail, which
 * is a broken run reported as a failed assertion. The inventory is the closed set of
 * obligations and this is where that is enforced.
 */
function knownFor(id) {
  const known = ASSERTION_INVENTORY.find((entry) => entry.id === id)
  if (known === undefined) {
    throw new Error(`this run has no assertion called ${id}; add it to ASSERTION_INVENTORY`)
  }
  return known
}

/** A row for a step that could not produce an answer, carrying why. */
function unobserved(id, reason) {
  const known = knownFor(id)
  return {
    id,
    name: known.name,
    group: known.group,
    expected: known.expected,
    actual: NOT_OBSERVED,
    note: reason,
  }
}

/**
 * A row for a step that produced an answer, pass or fail.
 *
 * Three strings, and the distinction between the last two is the point. `expected` is
 * the canonical outcome the inventory declares. `actual` is what the judgement compares:
 * the expected phrase when the condition held, and the evidence when it did not, so a
 * mismatch reads as a fact rather than as a token. `observed` is always the evidence,
 * pass or fail, so a reader can check a passing row rather than take it on trust.
 */
function outcome(id, ok, passText, failText) {
  const known = knownFor(id)
  const observed = ok ? passText : failText
  return {
    id,
    name: known.name,
    group: known.group,
    expected: known.expected,
    actual: ok ? known.expected : observed,
    observed,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The whole run, as a list of observations and an evidence record.
 *
 * Every step is guarded and every step runs, even after one has failed: a step that
 * throws emits a `not-observed` row carrying the reason and the run continues to the
 * teardown, because leaving a real unit and a real plugin file on the machine because an
 * assertion three steps earlier failed would trade an honest failure for a mess.
 */
export async function run(ctx) {
  const observations = []
  const commands = []
  const evidence = {
    machine: {
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      repoVersion: readRepoVersion(),
      display: process.env['DISPLAY'] ?? null,
      systemdVersion: ctx.systemdVersion,
      sessionType: ctx.sessionType,
    },
    temporary: { root: ctx.root, stateDir: ctx.stateDir, repoFullPath: ctx.repoFullPath },
    unit: { path: ctx.unitFile, wantsLink: ctx.wantsLink, managerBefore: null, managerAfter: null },
    plugin: { file: ctx.pluginFile, metadata: ctx.pluginMetadata, existedBefore: null },
    stateDir: { database: path.join(ctx.stateDir, DATABASE_FILE_NAME), runtimeFile: ctx.runtimeFile },
    commands,
    // Filled after the watched set has been re-pointed at the unit the product actually
    // wrote, so it describes the whole set rather than the guess made before install ran.
    baseline: { preexisting: [], createdByThisRun: [] },
    watched: ctx.watched.map((entry) => ({
      label: entry.label,
      target: entry.target,
      before: entry.before,
      after: null,
    })),
    restore: [],
    residue: [],
    pending: { before: null, after: null, historyBefore: null, historyAfter: null },
    health: { before: null, after: null },
    serviceManager: { before: null, after: null, activeAfterStart: null },
    requiredProductChanges: [],
  }

  const record = (label, result) => {
    commands.push({
      label,
      command: result.command,
      exit: result.status,
      signal: result.signal,
      durationMs: result.durationMs,
      error: result.error,
      header: result.report === undefined ? null : result.report.header,
      rows: result.report === undefined ? null : result.report.rows,
      remedies: result.report === undefined ? null : result.report.remedies,
    })
    return result
  }

  // --- opening ---------------------------------------------------------------

  const buildArtefacts = [BUILT_CLI, BUILT_SCHEMA, BUILT_ELECTRON_MAIN, PLUGIN_SOURCE_ENTRY]
  const buildReadings = buildArtefacts.map((relative) => {
    const target = path.join(repoRoot, relative)
    return `${relative}=${existsSync(target) ? 'present' : 'absent'}`
  })
  const allPresent = buildReadings.every((entry) => entry.endsWith('=present'))
  observations.push(
    allPresent
      ? outcome('built-command-and-schema-are-present', true, buildReadings.join(', '), '')
      : unobserved('built-command-and-schema-are-present', buildReadings.join(', ')),
  )

  // What the manager says before this run has written anything. A clean machine has to
  // report nothing here, or the "nothing was left behind" reading later is meaningless.
  const managerBefore = systemctl(['is-enabled', LINUX_UNIT_NAME])
  evidence.serviceManager.before = { command: managerBefore.stdout.trim(), exit: managerBefore.status }

  const install = record('install', runCli(ctx.env, ['install']))
  if (install.status !== 0) {
    log(`install exited ${describe(install.status)}; the header was ${JSON.stringify(install.report.header)}`)
  }

  // The unit path the product used, read out of what it printed rather than assumed.
  const reportedUnit = unitFileFromReport(install)
  if (reportedUnit !== null) {
    ctx.unitFile = reportedUnit
    ctx.wantsLink = path.join(
      path.dirname(reportedUnit),
      `${LINUX_WANTS_TARGET}.wants`,
      path.basename(reportedUnit),
    )
  }
  evidence.unit.path = ctx.unitFile
  evidence.unit.wantsLink = ctx.wantsLink
  ctx.watched = rewireWatched(ctx, evidence)
  // Which real-machine paths already held something when the run started. A path listed
  // here was *restored* at the end; one absent here was created by this run and removed by
  // it. The distinction is what tells a reader whether the machine is the way they left
  // it, and it is a fact about the run rather than a claim.
  evidence.baseline = {
    preexisting: ctx.watched.filter((entry) => entry.before.kind !== 'absent').map((entry) => entry.label),
    createdByThisRun: ctx.watched.filter((entry) => entry.before.kind === 'absent').map((entry) => entry.label),
  }
  evidence.plugin.file = ctx.pluginFile
  evidence.plugin.metadata = ctx.pluginMetadata

  // `systemctl --user daemon-reload` is what a human runs after a unit appears; without
  // it the manager is answering from a unit list that does not contain the new file.
  systemctl(['daemon-reload'])
  const managerAfterInstall = systemctl(['is-enabled', LINUX_UNIT_NAME])
  evidence.unit.managerAfter = managerAfterInstall.stdout.trim()

  const unitExists = ctx.unitFile !== null && existsSync(ctx.unitFile)
  const wantsLinkCorrect =
    ctx.wantsLink !== null && existsSync(ctx.wantsLink) && safeReadLink(ctx.wantsLink) === ctx.unitFile
  const enabledByManager = managerAfterInstall.stdout.trim() === 'enabled'
  observations.push(
    outcome(
      'install-enabled-a-unit-the-live-manager-reads',
      unitExists && wantsLinkCorrect && enabledByManager,
      `unit at ${ctx.unitFile}, its ${LINUX_WANTS_TARGET}.wants link resolves to it, and the live manager says enabled`,
      `unit=${verdictFor(unitExists)} wantsLink=${verdictFor(wantsLinkCorrect)} managerIsEnabled=${JSON.stringify(managerAfterInstall.stdout.trim())} (install exit ${describe(install.status)})`,
    ),
  )

  const pluginPresent = ctx.pluginFile !== null && existsSync(ctx.pluginFile)
  observations.push(
    outcome(
      'install-wrote-the-global-plugin',
      pluginPresent,
      `one plugin file at ${ctx.pluginFile}`,
      `${describe(ctx.pluginFile)} does not exist (install exit ${describe(install.status)})`,
    ),
  )

  const opened = await waitForHub(ctx, HUB_READY_TIMEOUT_MS)
  evidence.health.before = opened.health
  observations.push(
    opened.record !== null && opened.health !== null
      ? outcome(
          'install-brought-up-a-serving-hub',
          true,
          `published ${opened.record.host}:${String(opened.record.port)} as pid ${String(opened.record.pid)} and answered health`,
          '',
        )
      : unobserved('install-brought-up-a-serving-hub', opened.detail),
  )

  // --- health ----------------------------------------------------------------

  observations.push(
    opened.health === null
      ? unobserved('health-payload-is-ok-and-readable', 'no health payload was read')
      : outcome(
          'health-payload-is-ok-and-readable',
          opened.health.status === 'ok' && opened.health.database?.readable === true,
          healthFingerprint(opened.health),
          healthFingerprint(opened.health),
        ),
  )

  observations.push(
    opened.record === null
      ? unobserved('hub-is-listening-on-loopback-with-its-own-pid', 'no runtime file was published')
      : outcome(
          'hub-is-listening-on-loopback-with-its-own-pid',
          opened.record.host === '127.0.0.1' && opened.health?.server?.listening === true,
          `bound to ${opened.record.host}:${String(opened.record.port)}, listening, and named by ${RUNTIME_FILE_NAME} as pid ${String(opened.record.pid)}`,
          `host=${describe(opened.record.host)} listening=${describe(opened.health?.server?.listening)} pid=${describe(opened.record.pid)}`,
        ),
  )

  const doctor = record('doctor', runCli(ctx.env, ['doctor']))
  const checks = parseCheckBlock(`${doctor.stdout}\n${doctor.stderr}`)
  const autostartCheck = checks['autostart']
  observations.push(
    autostartCheck === undefined
      ? unobserved('doctor-reads-the-unit-as-ok', 'doctor printed no autostart check')
      : outcome(
          'doctor-reads-the-unit-as-ok',
          autostartCheck.verdict === 'ok',
          `the autostart check is ok: ${autostartCheck.detail}`,
          `the autostart check is ${autostartCheck.verdict}: ${autostartCheck.detail}`,
        ),
  )

  // --- pending ---------------------------------------------------------------

  const signal = {
    harness: 'opencode',
    eventName: 'permission.asked',
    sessionId: ctx.sessionId,
    repoFullPath: ctx.repoFullPath,
    transitionId: ctx.transitionId,
    occurredAt: nowIso(),
  }
  const accepted =
    opened.origin === null
      ? null
      : await httpJson(opened.origin, { method: 'POST', pathname: '/api/ingest', body: signal })
  const acceptedBody = accepted?.body ?? null
  observations.push(
    accepted === null
      ? unobserved('ingest-accepted-a-needs-you-block', 'there was no hub to post to')
      : outcome(
          'ingest-accepted-a-needs-you-block',
          accepted.status === 202 && acceptedBody?.accepted === true && acceptedBody?.class === 'needs-you',
          `202 accepted, outcome=${describe(acceptedBody?.outcome)} class=needs-you pendingCount=${describe(acceptedBody?.pendingCount)}`,
          `${describe(accepted.status)} with ${JSON.stringify(acceptedBody)}`,
        ),
  )

  const pendingBefore = await readPending(opened.origin)
  evidence.pending.before = pendingBefore
  observations.push(
    pendingBefore === null
      ? unobserved('pending-set-holds-exactly-one-item', 'the pending route did not answer')
      : outcome(
          'pending-set-holds-exactly-one-item',
          pendingBefore.items.length === 1,
          '1 pending item',
          `${String(pendingBefore.items.length)} pending items`,
        ),
  )

  const item = pendingBefore?.items?.[0] ?? null
  const expectedDedupe = `opencode:${ctx.sessionId}:${ctx.transitionId}`
  observations.push(
    item === null
      ? unobserved('the-item-is-the-block-this-run-created', 'there was no pending item to identify')
      : outcome(
          'the-item-is-the-block-this-run-created',
          item.repoShortName === path.basename(ctx.repoFullPath) && item.dedupeKey === expectedDedupe,
          `repoShortName=${item.repoShortName} dedupeKey=${item.dedupeKey} class=${item.class}`,
          `repoShortName=${describe(item.repoShortName)} (expected ${path.basename(ctx.repoFullPath)}), dedupeKey=${describe(item.dedupeKey)} (expected ${expectedDedupe})`,
        ),
  )

  const historyBefore = await readHistory(opened.origin, ctx.sessionId)
  evidence.pending.historyBefore = historyBefore?.events ?? null

  // --- restart ---------------------------------------------------------------

  // `install` brought the hub up with its own launcher, so the unit is not what is
  // running. That process is stopped by the pid in the product's own runtime file, and
  // then the *unit* is what starts the next one. A run that left install's process alive
  // would have the manager refuse a second instance, and the restart would prove nothing.
  const stopped = await stopInstallLaunchedHub(ctx, opened.record)
  observations.push(
    outcome(
      'stop-through-the-manager-released-the-runtime-file',
      stopped.stopped,
      `pid ${describe(stopped.pid)} is gone and ${RUNTIME_FILE_NAME} was released`,
      `pid=${describe(stopped.pid)} stillAlive=${verdictFor(stopped.alive)} runtimeFile=${describe(stopped.runtimeFileState)}`,
    ),
  )

  systemctl(['stop', LINUX_UNIT_NAME])
  systemctl(['daemon-reload'])
  const started = systemctl(['start', LINUX_UNIT_NAME])
  const active = systemctl(['is-active', LINUX_UNIT_NAME])
  evidence.serviceManager.after = { startExit: started.status, active: active.stdout.trim() }
  evidence.serviceManager.activeAfterStart = active.stdout.trim()
  const restarted = await waitForHub(ctx, HUB_READY_TIMEOUT_MS)
  observations.push(
    outcome(
      'start-through-the-manager-activated-the-unit',
      active.stdout.trim() === 'active' && restarted.record !== null,
      `systemctl --user start activated it (is-active active) and the hub published ${describe(restarted.record?.host)}:${describe(restarted.record?.port)}`,
      `start exit ${describe(started.status)}, is-active ${JSON.stringify(active.stdout.trim())}, a hub published ${describe(restarted.record?.port)}`,
    ),
  )

  observations.push(
    opened.record === null || restarted.record === null
      ? unobserved(
          'the-restarted-hub-is-a-different-process-and-instance',
          'one of the two hubs published nothing, so there is no pair of identities to compare',
        )
      : outcome(
          'the-restarted-hub-is-a-different-process-and-instance',
          restarted.record.pid !== opened.record.pid && restarted.record.instanceId !== opened.record.instanceId,
          `pid ${String(opened.record.pid)} -> ${String(restarted.record.pid)} and instance ${opened.record.instanceId} -> ${restarted.record.instanceId}`,
          `pid ${String(opened.record.pid)} -> ${String(restarted.record.pid)}, instanceId ${opened.record.instanceId} -> ${restarted.record.instanceId}`,
        ),
  )

  const pendingAfter = await readPending(restarted.origin)
  const historyAfter = await readHistory(restarted.origin, ctx.sessionId)
  evidence.pending.after = pendingAfter
  evidence.pending.historyAfter = historyAfter?.events ?? null
  evidence.health.after = restarted.health

  const beforePending = pendingFingerprint(pendingBefore?.items ?? null)
  const afterPending = pendingFingerprint(pendingAfter?.items ?? null)
  observations.push(
    pendingAfter === null
      ? unobserved('the-pending-item-survived-the-restart', 'the restarted hub did not answer the pending route')
      : outcome(
          'the-pending-item-survived-the-restart',
          beforePending !== '' && beforePending === afterPending,
          afterPending.replaceAll('\n', '; '),
          `before ${beforePending === '' ? 'nothing pending' : beforePending.replaceAll('\n', '; ')}; after ${
            afterPending === '' ? 'nothing pending' : afterPending.replaceAll('\n', '; ')
          }`,
        ),
  )

  const eventId = item?.eventId ?? null
  const beforeHistory = historyFingerprint(historyBefore?.events ?? null)
  const afterHistory = historyFingerprint(historyAfter?.events ?? null)
  const occurrences = eventId === null ? 0 : historyOccurrences(historyAfter?.events ?? null, eventId)
  observations.push(
    historyAfter === null || eventId === null
      ? unobserved(
          'its-history-row-survived-the-restart',
          'the bounded history did not answer, or there was no row key to look for',
        )
      : outcome(
          'its-history-row-survived-the-restart',
          beforeHistory !== '' && beforeHistory === afterHistory && occurrences === 1,
          `1 row, unchanged, ${String(occurrences)} occurrence of ${eventId}`,
          `before ${String(historyBefore?.events?.length ?? 0)} row(s); after ${String(historyAfter.events.length)} row(s); ${String(occurrences)} occurrence(s) of ${eventId}`,
        ),
  )

  const countBefore = pendingBefore?.count ?? null
  const countAfter = pendingAfter?.count ?? null
  observations.push(
    countBefore === null || countAfter === null
      ? unobserved('the-pending-count-is-unchanged', 'one of the two pending routes did not answer')
      : outcome(
          'the-pending-count-is-unchanged',
          countBefore === countAfter,
          `${String(countAfter)} before and after`,
          `${String(countBefore)} before, ${String(countAfter)} after`,
        ),
  )

  // --- repeat ----------------------------------------------------------------

  const second = record('install (second run)', runCli(ctx.env, ['install']))
  observations.push(
    outcome(
      'a-second-install-changes-nothing',
      second.status === 0 && reportChangedNothing(second.report) && reportChangeCount(second.report) === 0,
      `exit 0 and the header said ${JSON.stringify(second.report.header)}`,
      `exit ${describe(second.status)}, header ${JSON.stringify(second.report.header)}, ${String(reportChangeCount(second.report))} change(s) reported`,
    ),
  )

  const mismatchVersion = provokeVersionMismatch(ctx)
  const third = record('install (with a mismatched plugin version)', runCli(ctx.env, ['install']))
  const remedy = third.report.remedies['plugin'] ?? ''
  const stillOurs = readInstalledVersion(ctx.pluginFile)
  const namesBothWays = remedy.includes('uninstall') && remedy.includes('--force')
  observations.push(
    outcome(
      'a-differing-plugin-version-is-reported-not-replaced',
      third.status !== 0 && namesBothWays && stillOurs === mismatchVersion,
      `exit ${String(third.status)}, the plugin file still reports agent-ping ${describe(stillOurs)}, and the remedy names both ways forward`,
      `exit ${describe(third.status)}, the plugin file now reports ${describe(stillOurs)} (was asked to be ${mismatchVersion}), remedy ${JSON.stringify(remedy)}`,
    ),
  )

  // --- teardown --------------------------------------------------------------

  systemctl(['stop', LINUX_UNIT_NAME])
  const uninstall = record('uninstall', runCli(ctx.env, ['uninstall']))

  observations.push(
    outcome(
      'uninstall-removed-the-plugin-file',
      ctx.pluginFile !== null && !existsSync(ctx.pluginFile),
      `gone: ${ctx.pluginFile}`,
      `${describe(ctx.pluginFile)} still exists (uninstall exit ${describe(uninstall.status)})`,
    ),
  )

  const unitGone = ctx.unitFile !== null && !existsSync(ctx.unitFile)
  const linkGone = ctx.wantsLink !== null && !existsSync(ctx.wantsLink)
  observations.push(
    outcome(
      'uninstall-removed-the-unit-and-its-wants-link',
      unitGone && linkGone,
      `both gone: ${ctx.unitFile} and ${ctx.wantsLink}`,
      `unitGone=${verdictFor(unitGone)} (${describe(ctx.unitFile)}) wantsLinkGone=${verdictFor(linkGone)} (${describe(ctx.wantsLink)}), uninstall exit ${describe(uninstall.status)}`,
    ),
  )

  systemctl(['daemon-reload'])
  const managerAfterUninstall = systemctl(['is-enabled', LINUX_UNIT_NAME])
  const isEnabledText = managerAfterUninstall.stdout.trim()
  const wantsDir = ctx.wantsLink === null ? null : path.dirname(ctx.wantsLink)
  const leftInWants =
    wantsDir === null || !existsSync(wantsDir)
      ? []
      : readdirSync(wantsDir).filter((name) => name.includes('agent-ping'))
  evidence.unit.managerAfterUninstall = isEnabledText
  observations.push(
    outcome(
      'the-manager-reports-no-agent-ping-unit-left',
      (isEnabledText === 'not-found' || isEnabledText === 'disabled' || isEnabledText === '') &&
        leftInWants.length === 0,
      `is-enabled is ${JSON.stringify(isEnabledText)} and nothing named agent-ping is left in the wants directory`,
      `is-enabled is ${JSON.stringify(isEnabledText)}; entries left in the wants directory: ${
        leftInWants.length === 0 ? 'none' : leftInWants.join(', ')
      }`,
    ),
  )

  const databasePath = path.join(ctx.stateDir, DATABASE_FILE_NAME)
  const stateNote = uninstall.report.rows['state'] ?? ''
  const databaseKept = existsSync(databasePath)
  const saysKept = stateNote.includes('kept') && stateNote.includes(DATABASE_FILE_NAME)
  observations.push(
    outcome(
      'uninstall-kept-the-database',
      databaseKept && saysKept,
      `${databasePath} exists and the output said it was kept`,
      `exists=${verdictFor(databaseKept)}; the state row said ${JSON.stringify(stateNote)}`,
    ),
  )

  // --- isolation -------------------------------------------------------------

  const insideState = isInside(databasePath, ctx.stateDir) && isInside(ctx.runtimeFile, ctx.stateDir)
  const leakedToRealStateDir = existsSync(path.join(ctx.realStateDir, DATABASE_FILE_NAME))
  observations.push(
    outcome(
      'product-state-stays-inside-the-temporary-directory',
      insideState && !leakedToRealStateDir,
      `${databasePath} and ${ctx.runtimeFile} are both inside ${ctx.stateDir}, and this account's own state directory has no database`,
      `inside=${verdictFor(insideState)}; a database appeared in this account's own state directory (${ctx.realStateDir})=${verdictFor(leakedToRealStateDir)}`,
    ),
  )

  const restore = restoreWatched(ctx.watched)
  evidence.restore = restore.lines
  evidence.residue = restore.residue
  for (const entry of evidence.watched) entry.after = snapshotPath(entry.target)
  observations.push(
    outcome(
      'every-real-machine-path-was-restored',
      restore.residue.length === 0 && evidence.watched.every((entry) => sameSnapshot(entry.before, entry.after)),
      `${String(ctx.watched.length)} paths watched, all back to what they were before the run`,
      `${String(restore.residue.length)} path(s) not restored: ${restore.residue.join('; ')}`,
    ),
  )

  evidence.requiredProductChanges = requiredProductChanges(observations)
  return { observations, evidence }
}

/**
 * What a failed assertion is a bug report about, recorded rather than fixed.
 *
 * A verification run that patches the product it is verifying ends up proving a
 * configuration nobody ships, so every failure becomes a line a maintainer can act on and
 * no product file is touched (APX-FR-02).
 */
export function requiredProductChanges(observations) {
  const changes = []
  for (const entry of observations) {
    if (entry.actual === entry.expected) continue
    const detail = entry.actual === NOT_OBSERVED ? `not observed: ${describe(entry.note)}` : entry.actual
    changes.push(
      `${entry.id}: ${entry.name} - observed ${detail}. Investigate before claiming the operational contract holds ` +
        `on this platform; the ${entry.group} half of the claim is unproven until it does.`,
    )
  }
  return changes
}

/** The unit path `install` reported, when it printed one. Never assumed from a guess. */
function unitFileFromReport(install) {
  const reported = `${install.report.rows['autostart'] ?? ''}`
  const match = /(\/[^\s]*agent-ping\.service)/.exec(reported)
  return match === null ? null : match[1]
}

function safeReadLink(target) {
  try {
    return path.resolve(path.dirname(target), readlinkSync(target))
  } catch {
    return null
  }
}

function readInstalledVersion(pluginFile) {
  if (pluginFile === null || !existsSync(pluginFile)) return null
  const head = readFileSync(pluginFile, 'utf8').slice(0, 2000)
  return PLUGIN_VERSION_LINE.exec(head)?.[1]?.trim() ?? null
}

/**
 * Make the installed plugin look like a different version, and say what it claims.
 *
 * The header line is the product's own record: `installedVersionOf` reads
 * `// product-version:` out of the first lines of the file, so editing that one line is
 * exactly what an older install on this machine would have left behind. Every other byte
 * is untouched, so a second install that replaced the file would be replacing a plugin it
 * would otherwise consider identical - which is the case IO-FR-08 is about.
 */
function provokeVersionMismatch(ctx) {
  const version = '0.0.0-io4-verified-elsewhere'
  if (ctx.pluginFile === null || !existsSync(ctx.pluginFile)) return version
  const text = readFileSync(ctx.pluginFile, 'utf8')
  writeFileSync(ctx.pluginFile, text.replace(PLUGIN_VERSION_LINE, `// product-version: ${version}`))
  return version
}

/** Read the hub's runtime file and its health, as one snapshot. */
async function readHubSnapshot(ctx) {
  const record = readRuntimeFileOrNull(ctx.stateDir)
  if (record === null) {
    return { record: null, origin: null, health: null, detail: `no ${RUNTIME_FILE_NAME} in ${ctx.stateDir}` }
  }
  const origin = `http://${record.host}:${String(record.port)}`
  const answer = await httpJson(origin, { method: 'GET', pathname: '/api/health' })
  if (!answer.ok) {
    return { record, origin, health: null, detail: `health at ${origin} did not answer (${describe(answer.error)})` }
  }
  return { record, origin, health: answer.body, detail: '' }
}

/** Wait until the runtime file names a live process and health answers. */
async function waitForHub(ctx, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest
  for (;;) {
    latest = await readHubSnapshot(ctx)
    if (latest.record !== null && latest.health !== null) return latest
    if (Date.now() >= deadline) return latest
    await sleep(POLL_MS)
  }
}

/**
 * Stop the process `install` started, and wait for the runtime file to go.
 *
 * By the pid in the product's own runtime file, with SIGTERM so the hub's ordered close
 * runs: the log is flushed and the file is released. A file left behind by a killed
 * process would be reclaimed by the next start, so a run that *observed* that reclaim
 * would not be observing a stop.
 */
async function stopInstallLaunchedHub(ctx, record) {
  if (record === null) {
    return { stopped: false, pid: null, alive: false, runtimeFileState: 'no runtime file' }
  }
  const pid = record.pid
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Already gone, which is the outcome this is waiting for.
  }
  const deadline = Date.now() + HUB_STOP_TIMEOUT_MS
  let alive = isProcessAlive(pid)
  while (alive && Date.now() < deadline) {
    await sleep(POLL_MS)
    alive = isProcessAlive(pid)
  }
  const fileDeadline = Date.now() + 5_000
  while (existsSync(ctx.runtimeFile) && Date.now() < fileDeadline) await sleep(POLL_MS)
  const runtimeFileState = existsSync(ctx.runtimeFile) ? 'still present' : 'released'
  return { stopped: !alive && runtimeFileState === 'released', pid, alive, runtimeFileState }
}

/** The pending route, narrowed to the two values this run compares. */
async function readPending(origin) {
  if (origin === null || origin === undefined) return null
  const answer = await httpJson(origin, { method: 'GET', pathname: '/api/pending' })
  if (!answer.ok || answer.status !== 200) return null
  const body = answer.body ?? {}
  const items = Array.isArray(body.items) ? body.items : null
  if (items === null) return null
  return { items, count: typeof body.count === 'number' ? body.count : items.length }
}

/** The bounded history for this run's session. */
async function readHistory(origin, sessionId) {
  if (origin === null || origin === undefined) return null
  const answer = await httpJson(origin, {
    method: 'GET',
    pathname: `/api/events?sessionId=${encodeURIComponent(sessionId)}&limit=50`,
  })
  if (!answer.ok || answer.status !== 200) return null
  const body = answer.body ?? {}
  const events = Array.isArray(body.events) ? body.events : null
  if (events === null) return null
  return { events, count: typeof body.count === 'number' ? body.count : events.length }
}

/**
 * Re-point the watched set at the unit the product actually wrote.
 *
 * The path the product used is read out of its own output rather than assumed, and the
 * watching follows it: a run that watched one path while the product wrote another would
 * report a clean machine over a unit it never looked at.
 */
function rewireWatched(ctx, evidence) {
  const kept = ctx.watched
  if (ctx.unitFile === null) return kept
  const known = new Set(kept.map((entry) => entry.target))
  const unitDir = path.dirname(ctx.unitFile)
  const wantsDir = path.join(unitDir, `${LINUX_WANTS_TARGET}.wants`)
  const additions = [
    new WatchedPath(`the unit wants symlink (${ctx.wantsLink})`, ctx.wantsLink),
    new WatchedPath(`the ${LINUX_WANTS_TARGET}.wants directory (${wantsDir})`, wantsDir),
    new WatchedPath(`the systemd user unit (${ctx.unitFile})`, ctx.unitFile),
    new WatchedPath(`the systemd per-user unit directory (${unitDir})`, unitDir),
  ].filter((entry) => !known.has(entry.target))
  evidence.watched.push(
    ...additions.map((entry) => ({ label: entry.label, target: entry.target, before: entry.before, after: null })),
  )
  additions.forEach((entry, index) => backUpFile(entry, ctx.backupDir, 100 + index))
  return [...kept, ...additions]
}

// ─────────────────────────────────────────────────────────────────────────────
// The command line
// ─────────────────────────────────────────────────────────────────────────────

export const USAGE = `node scripts/verify-autostart-linux.mjs [options]

  --out <file>       where the JSON evidence is written (default ${DEFAULT_EVIDENCE_PATH})
  --keep-state       leave the temporary directories in place for inspection
  --simulate-missing-service-manager
                     report the service manager as unavailable without touching the machine,
                     so that "this run cannot pass here" is a claim a test can make. The run
                     then stops at the preflight and exits non-zero
  --help             print this text

This script drives a real systemd user manager. It points agent-ping's own state at a
temporary directory and restores every other path it touches. It makes no claim about
macOS and Windows: the same contract has to be re-earned on those machines, and APX-CON-06
forbids claiming either from a Linux one.
`

export function parseArgs(argv) {
  const args = {
    out: path.join(repoRoot, DEFAULT_EVIDENCE_PATH),
    keepState: false,
    simulateMissingServiceManager: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--out') {
      const next = argv[index + 1]
      if (next === undefined) throw new Error('--out needs a file to write to')
      args.out = path.resolve(repoRoot, next)
      index += 1
      continue
    }
    if (argument === '--keep-state') {
      args.keepState = true
      continue
    }
    if (argument === '--simulate-missing-service-manager') {
      args.simulateMissingServiceManager = true
      continue
    }
    if (argument === '--help' || argument === '-h') {
      args.help = true
      continue
    }
    throw new Error(`unknown option ${argument}`)
  }
  return args
}

function readRepoVersion() {
  try {
    const parsed = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

function writeEvidence(outPath, evidence) {
  try {
    mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
    writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    return { written: true, path: outPath }
  } catch (cause) {
    return {
      written: false,
      path: outPath,
      error: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n\n${USAGE}`)
    return 2
  }
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }

  const startedAt = nowIso()
  const release = keepAlive()
  try {
    return await runMain(args, startedAt)
  } finally {
    release()
  }
}

/** Everything `main` does once the command line is understood. */
async function runMain(args, startedAt) {
  const pre = preflight({ simulateMissingServiceManager: args.simulateMissingServiceManager })
  if (pre.dependencies.some((entry) => entry.present !== true)) {
    // No evidence file and no assertion for a machine that cannot answer the question: a
    // report that says "nothing was there" is indistinguishable from one that says
    // "nothing was looked for".
    const decision = decide([], { assertionsExpected: ASSERTIONS_EXPECTED, dependencies: pre.dependencies })
    emit(buildSummary({ decision, args, dependencies: pre.dependencies, startedAt, evidence: null, artifact: null }))
    for (const failure of decision.failures) log(`FAIL ${failure}`)
    log(
      'the preflight found something this run needs and this machine does not have, so no assertion was ' +
        'attempted. This is a failed run, not a skipped one.',
    )
    return decision.exitCode
  }

  // One temporary root per run. Everything the product writes goes inside it through
  // AGENT_PING_STATE_DIR, and it is removed on the way out on every path.
  const root = mkdtempSync(path.join(tmpdir(), 'agent-ping-autostart-verify-'))
  const stateDir = path.join(root, 'state')
  const repoFullPath = path.join(root, 'repo')
  const backupDir = path.join(root, 'backup')
  for (const directory of [stateDir, repoFullPath, backupDir]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  const realPluginDir = resolveRealPluginDir()
  const electronProfileDir = path.join(
    effectiveConfigRoot(process.env[XDG_CONFIG_HOME_ENV_VAR], homedir()),
    'agent-ping',
  )
  const wantsDir =
    pre.unitDirectory === null ? null : path.join(pre.unitDirectory, `${LINUX_WANTS_TARGET}.wants`)

  const watched = [
    new WatchedPath(`the opencode plugin file (${path.join(realPluginDir, PLUGIN_FILE_NAME)})`, path.join(realPluginDir, PLUGIN_FILE_NAME)),
    new WatchedPath(`the plugin install record (${path.join(realPluginDir, PLUGIN_METADATA_FILE_NAME)})`, path.join(realPluginDir, PLUGIN_METADATA_FILE_NAME)),
    new WatchedPath(`the opencode plugin directory (${realPluginDir})`, realPluginDir),
    new WatchedPath(`the unit wants symlink (${pre.unitFile === null ? null : path.join(wantsDir, LINUX_UNIT_NAME)})`, pre.unitFile === null ? null : path.join(wantsDir, LINUX_UNIT_NAME)),
    new WatchedPath(`the ${LINUX_WANTS_TARGET}.wants directory (${wantsDir})`, wantsDir),
    new WatchedPath(`the systemd user unit (${pre.unitFile})`, pre.unitFile),
    new WatchedPath(`the systemd per-user unit directory (${pre.unitDirectory})`, pre.unitDirectory),
    new WatchedPath(`this account's own agent-ping state directory (${pre.realStateDir})`, pre.realStateDir),
    // The Electron runtime creates its own per-user profile directory the first time the
    // packaged application runs on an account. No command writes it, and a run claiming
    // to have left nothing behind while it sat there would be untrue.
    new WatchedPath(`the Electron per-user profile directory (${electronProfileDir})`, electronProfileDir),
  ].filter((entry) => entry.target !== null)
  watched.forEach((entry, index) => backUpFile(entry, backupDir, index))

  const runId = `${process.pid.toString(36)}-${Date.now().toString(36)}`
  const ctx = {
    root,
    stateDir,
    runtimeFile: path.join(stateDir, RUNTIME_FILE_NAME),
    repoFullPath,
    backupDir,
    sessionId: `ses_io4_${runId}`,
    transitionId: `blk_io4_${runId}`,
    // Cleared as well as overridden: a child that resolved a developer's real state
    // directory from an inherited variable would write to their installation.
    env: { ...process.env, [STATE_DIR_ENV_VAR]: stateDir },
    unitFile: pre.unitFile,
    wantsLink: pre.unitFile === null ? null : path.join(wantsDir, LINUX_UNIT_NAME),
    pluginFile: path.join(realPluginDir, PLUGIN_FILE_NAME),
    pluginMetadata: path.join(realPluginDir, PLUGIN_METADATA_FILE_NAME),
    realStateDir: pre.realStateDir,
    systemdVersion: pre.systemdVersion,
    sessionType: pre.sessionType,
    watched,
  }

  let observations = []
  let evidence
  let threw = null
  try {
    // Named `result`, not `outcome`: that is the name of the observation constructor this
    // file exports, and a local that shadows it is a reader's problem for nothing.
    const result = await run(ctx)
    observations = result.observations
    evidence = result.evidence
  } catch (cause) {
    threw = cause instanceof Error ? cause.message : String(cause)
    log(`the run itself failed: ${threw}`)
    // The machine is still put back: a run that throws in the collection phase must not be
    // the reason a unit and a plugin file are left behind, and `evidence` is null here
    // because `run` returns both together or neither.
    const restore = restoreWatched(ctx.watched)
    evidence = {
      machine: {
        platform: `${process.platform}-${process.arch}`,
        node: process.version,
        repoVersion: readRepoVersion(),
        systemdVersion: pre.systemdVersion,
        sessionType: pre.sessionType,
      },
      temporary: { root, stateDir },
      residue: restore.residue,
      restore: restore.lines,
      requiredProductChanges: [`the run threw before it could report: ${threw}`],
    }
  } finally {
    if (args.keepState) log(`temporary root kept at ${root}`)
    else rmSync(root, { recursive: true, force: true })
  }

  if (threw !== null) {
    emit({
      script: SCRIPT_NAME,
      evidenceVersion: EVIDENCE_VERSION,
      verdict: 'fail',
      exitCode: 1,
      startedAt,
      finishedAt: nowIso(),
      assertionsRun: 0,
      assertionsExpected: ASSERTIONS_EXPECTED,
      assertions: [],
      failures: [`the run threw before any assertion could be reported: ${threw}`],
      dependencies: pre.dependencies,
      requiredProductChanges: [`the run threw before it could report: ${threw}`],
      residue: evidence?.residue ?? [],
      evidence: args.out,
      evidenceWritten: false,
    })
    return 1
  }

  const decision = decide(observations, {
    assertionsExpected: ASSERTIONS_EXPECTED,
    dependencies: pre.dependencies,
  })
  const artifact = writeEvidence(args.out, evidence)
  emit(buildSummary({ decision, args, dependencies: pre.dependencies, startedAt, evidence, artifact }))
  for (const failure of decision.failures) log(`FAIL ${failure}`)
  log(
    decision.verdict === 'pass'
      ? `all ${String(ASSERTIONS_EXPECTED)} declared assertions passed on ${process.platform}.`
      : `${String(decision.assertionsRun)} of ${String(ASSERTIONS_EXPECTED)} declared assertions passed. See the failures above.`,
  )
  return decision.exitCode
}

function buildSummary({ decision, args, dependencies, startedAt, evidence, artifact }) {
  const summary = {
    script: SCRIPT_NAME,
    evidenceVersion: EVIDENCE_VERSION,
    verdict: decision.verdict,
    exitCode: decision.exitCode,
    startedAt,
    finishedAt: nowIso(),
    machine: evidence?.machine ?? {
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      repoVersion: readRepoVersion(),
    },
    dependencies,
    assertionsRun: decision.assertionsRun,
    assertionsExpected: decision.assertionsExpected,
    assertions: decision.assertions,
    failures: decision.failures,
    missingDependencies: decision.missingDependencies,
    requiredProductChanges: evidence?.requiredProductChanges ?? [],
    residue: evidence?.residue ?? [],
    evidence: args.out,
    evidenceWritten: artifact?.written ?? false,
  }
  if (artifact?.error !== undefined) summary.evidenceError = artifact.error
  return summary
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2))
}
