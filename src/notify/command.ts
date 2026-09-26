// The command boundary every platform notifier shares: start one process with no shell
// and with a bound, and turn what it did into one of this product's three outcomes
// (NT-FR-01, NT-FR-02, NT-FR-09, ADR-004, ADR-010, APX-FR-02, APX-CON-04, APX-CON-10,
// APX-CON-12).
//
// WHY THIS FILE EXISTS, AND WHAT IT IS NOT
// It is not a fourth notifier and it makes no decision about loudness. What it holds is
// the two things that would otherwise be copied per platform and then drift: how a command
// is started, and how what came of it is classified. The three platform files
// (./linux.ts, ./macos.ts, ./windows.ts) each own exactly one thing - the argument list for
// their platform's tool - and each read the class policy from the one table in ./policy.ts
// and the failure vocabulary from here. Three platforms therefore differ in one argument
// array each, which is the shape NT-FR-03 and NT-FR-04 ask for: the same three-class
// policy rather than a second policy, and the same reason for a failure rather than three
// spellings of it.
//
// A CLASS IS DECIDED BY THE POLICY, NOT BY WHAT CAME BACK
// `reportCommandResult` maps a process's result onto a reason and nothing else. It never
// looks at the class, never re-reads the request and never decides that a failure of one
// class matters more than a failure of another. A `notify-send` that exits non-zero, an
// `osascript` that exits non-zero and a PowerShell that catches an exception and exits 1
// are the same fact - nobody was told - and get the same reason, which is what makes
// `doctor`'s one line true across platforms (NT-FR-09, APX-FR-02).
//
// THE EXIT STATUS IS RECORDED, NOT INTERPRETED
// No tool's non-zero exit is this product's to explain: no session bus, no display
// server, a rejected hint, a machine asleep. The status is carried verbatim on the outcome
// and the tool's own first line of stderr is carried beside it as `detail`, so an operator
// can read why without this product pretending to know. `detail` is the one field that
// can hold text from outside, it is bounded to a single short line, and nothing durable
// reads it (APX-FR-01, APX-CON-12).
//
// WHY A FAILURE IS A VALUE AND NOT A THROW
// The notifier interface returns an outcome (NT-FR-01) and nothing here throws for a
// delivery that did not happen. The only place a `failed` outcome becomes an exception is
// the composition root's adapter (./registry.ts), because that is the only place with both
// halves of the boundary in view. A notifier that threw would have lost the reason on the
// way out (APX-FR-02, ADR-010).
//
// ONE ATTEMPT, NO RETRY, NO SOUND
// There is no loop here, no timer that re-fires a notification, and no sound-capable
// argument or option anywhere on this path. A delivery that fails is reported once and the
// block stays stored and pending: a missing notification is never a lost block, and the
// badge and the history are what carry persistence (NT-FR-08, APX-CON-04, APX-CON-10).

import { spawn, type ChildProcess } from 'node:child_process'
import type {
  NotificationAvailability,
  NotificationCommand,
  NotificationCommandResult,
  NotificationCommandRunner,
  NotificationOutcome,
  NotificationOutcomeReason,
  NotifyPlatform,
} from './types.js'

/**
 * How much of a tool's stderr is kept.
 *
 * The first 512 characters, and the runner stops appending at that. The text exists so an
 * operator can read why a delivery failed (NT-FR-09); it is never stored, never served and
 * never put in a record, and a bound is what keeps a chatty tool from turning a diagnostic
 * into something this product has to keep (APX-FR-01).
 */
export const NOTIFY_STDERR_MAX_BYTES = 512

/** How long a wedged process has to die on SIGTERM before it is killed outright. */
const KILL_GRACE_MS = 250

/**
 * The result a rejected command runner is turned into.
 *
 * A runner that throws is a broken runner rather than a failed delivery, and the reason it
 * cannot say more is itself the fact worth recording (APX-FR-02). Modelling it as a result
 * with its own spawn error - rather than as a branch in every platform file - is what keeps
 * one wording for it across three platforms. `ERUNNER` is not a Node errno, so it cannot
 * be confused with a process that failed to start.
 */
export const RUNNER_REJECTED: NotificationCommandResult = {
  code: null,
  signal: null,
  spawnError: 'ERUNNER',
  stderr: '',
}

/**
 * Run one command, with no shell and with a bound.
 *
 * The production implementation of `NotificationCommandRunner`, and the reason a test can
 * substitute a recording function. Four properties, all of them load-bearing:
 *
 *   - `shell: false` is passed explicitly rather than left to the default, because the
 *     default is a promise and this is the line that would be read by whoever changes it
 *   - stdin is closed and stdout is discarded, so a tool that decides it is interactive
 *     cannot block the hub waiting for a person who is not there
 *   - stderr is collected to a bound, because it is the only text a failing tool produces
 *     and it is a diagnostic rather than a record
 *   - the bound kills the process rather than abandoning the promise, so a wedged tool
 *     cannot outlive the delivery that started it
 *
 * The bound is required rather than defaulted, because it is a property of the *platform*
 * and not of this file: `osascript` starts in tens of milliseconds and PowerShell can take
 * seconds on a cold Windows machine, so each platform file owns its own number and passes
 * it in. A default here would be a fourth opinion nobody had.
 *
 * It never rejects. Every path resolves with a result, because a runner that threw would
 * leave the notifier with an exception where it expects a reason (APX-FR-02).
 */
export function createNodeCommandRunner(
  options: { readonly timeoutMs: number },
): (command: NotificationCommand) => Promise<NotificationCommandResult> {
  const { timeoutMs } = options
  return (command: NotificationCommand): Promise<NotificationCommandResult> =>
    new Promise<NotificationCommandResult>((resolve) => {
      let settled = false
      let stderr = ''
      let killGrace: NodeJS.Timeout | undefined
      const bound = setTimeout(() => {
        // Terminate first, then insist. SIGTERM is what a well-behaved tool exits on;
        // SIGKILL is what a wedged one needs, and the grace between them is short enough
        // that a hung delivery is bounded by the platform's own constant rather than by
        // whatever the child decides to do. The promise settles immediately rather than
        // waiting for the child, so a tool that ignores both signals still cannot hold a
        // delivery open.
        child.kill('SIGTERM')
        killGrace = setTimeout(() => {
          child.kill('SIGKILL')
        }, KILL_GRACE_MS)
        killGrace.unref?.()
        finish({ code: null, signal: null, spawnError: 'ETIMEDOUT', stderr })
      }, timeoutMs)
      bound.unref?.()

      const child = spawnNotificationProcess(command, (chunk: string) => {
        if (stderr.length < NOTIFY_STDERR_MAX_BYTES) {
          stderr = (stderr + chunk).slice(0, NOTIFY_STDERR_MAX_BYTES)
        }
      })

      const finish = (result: NotificationCommandResult): void => {
        if (settled) return
        settled = true
        clearTimeout(bound)
        if (killGrace !== undefined) clearTimeout(killGrace)
        resolve(result)
      }

      child.on('error', (error: NodeJS.ErrnoException) => {
        // The process never started, or could not be started at all: a missing tool
        // (`ENOENT`), a permission problem, an exhausted process table. There is no exit
        // code for this, which is why the result carries both.
        finish({ code: null, signal: null, spawnError: error.code ?? 'ESPAWN', stderr })
      })
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        finish({ code, signal, spawnError: null, stderr })
      })
    })
}

/**
 * Start the process, with the options every platform depends on.
 *
 * Separate from the runner so the real spawn is one small, readable function: a reviewer can
 * confirm the two things that matter here - that the arguments are passed as an array and
 * that `shell` is false - without reading the promise bookkeeping around them. stderr is
 * decoded as utf8 and handed upwards; nothing is read from the process that this product
 * keeps.
 */
function spawnNotificationProcess(
  command: NotificationCommand,
  onStderr: (chunk: string) => void,
): ChildProcess {
  const child = spawn(command.file, [...command.args], {
    // Stated, not defaulted. Every argument in `command.args` reaches the operating system
    // as one argument, and no shell ever sees a title or a body on any of the three
    // platforms.
    shell: false,
    // stdin closed, stdout discarded, stderr piped: a tool that expects a terminal cannot
    // make the hub wait for one, and its only useful complaint is collected.
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', onStderr)
  return child
}

// ---------------------------------------------------------------------------
// The three outcomes
// ---------------------------------------------------------------------------

/**
 * The refusal: the class policy declined, so nothing was started.
 *
 * Carries no command, because there was no process - which is what makes "an fyi never
 * reaches a command line" checkable from the outcome alone. A refusal is a correct answer
 * and not a gap, so it is never a diagnostic line: `fyi` events are routine on a busy
 * repository and a line per routine decision would bury the failures this product must
 * never hide (NT-FR-02, APX-FR-08).
 */
export function refusedOutcome(
  platform: NotifyPlatform,
  reason: Extract<NotificationOutcomeReason, 'refused-in-app-only'>,
): NotificationOutcome {
  return { status: 'refused', reason, platform }
}

/**
 * The delivery: a process was started and it exited zero.
 *
 * `command` is a copy of the argument list, so an outcome cannot be changed afterwards by
 * anything still holding the array it was built from, and `exitCode` is the process's own
 * status rather than an assumption that zero happened.
 */
export function deliveredOutcome(
  command: NotificationCommand,
  platform: NotifyPlatform,
): NotificationOutcome {
  return {
    status: 'delivered',
    reason: 'delivered-to-desktop',
    platform,
    command: [...command.args],
    exitCode: 0,
  }
}

/**
 * A failed outcome, built the same way in every failure branch.
 *
 * The command is copied rather than referenced, and `exitCode` is the process's own: null
 * when it never ran or was killed, which is a different fact from a non-zero code and reads
 * as one on `doctor`.
 */
export function failedOutcome(
  command: NotificationCommand,
  platform: NotifyPlatform,
  exitCode: number | null,
  reason: Exclude<NotificationOutcomeReason, 'delivered-to-desktop' | 'refused-in-app-only'>,
  detail?: string,
): NotificationOutcome {
  return {
    status: 'failed',
    reason,
    platform,
    command: [...command.args],
    exitCode,
    ...(detail === undefined || detail === '' ? {} : { detail }),
  }
}

/**
 * Classify one command's result, report a failure, and return the outcome.
 *
 * The whole of the platform-neutral half of a notifier: the caller's only remaining job is
 * to have built the right argument list. The order of the branches is the order of the
 * facts, and each one is a thing that can happen to one process:
 *
 *   - it was never started, because the tool is not on PATH (`command-not-found`) - the
 *     answer a Linux hub without libnotify, or a trimmed Windows PATH, gives
 *   - it exceeded the platform's own bound and was killed (`command-timed-out`)
 *   - it could not be started for another reason, or the runner rejected (`command-failed`)
 *   - it was killed by a signal (`command-signalled`)
 *   - it exited non-zero (`command-failed`), which is the case a tool uses for reasons this
 *     product does not control, so the status is carried rather than interpreted
 *   - it exited zero (`delivered`)
 *
 * `onDiagnostic` is called exactly once, only for a failure, and with a line that names the
 * reason and the status and no content from the notification (APX-FR-02, NT-FR-09).
 */
export function reportCommandResult(
  input: {
    readonly command: NotificationCommand
    readonly platform: NotifyPlatform
    readonly result: NotificationCommandResult
    /** What this platform's tool is called in a diagnostic line, e.g. `notify-send`. */
    readonly toolName: string
    readonly onDiagnostic?: (message: string) => void
  },
): NotificationOutcome {
  const { command, platform, result, toolName } = input
  const detail = firstLine(result.stderr)
  if (result.spawnError === 'ENOENT') {
    return report(
      failedOutcome(command, platform, null, 'command-not-found', detail ?? `${toolName} is not on PATH`),
    )
  }
  if (result.spawnError === 'ETIMEDOUT') {
    return report(failedOutcome(command, platform, null, 'command-timed-out', detail))
  }
  if (result.spawnError !== null) {
    const reason =
      result.spawnError === 'ERUNNER' ? 'the command runner rejected' : (detail ?? result.spawnError)
    return report(failedOutcome(command, platform, null, 'command-failed', reason))
  }
  if (result.signal !== null) {
    return report(failedOutcome(command, platform, null, 'command-signalled', detail ?? `killed by ${result.signal}`))
  }
  if (result.code !== 0) {
    return report(failedOutcome(command, platform, result.code, 'command-failed', detail))
  }
  return deliveredOutcome(command, platform)

  function report(outcome: NotificationOutcome): NotificationOutcome {
    input.onDiagnostic?.(failureLine(toolName, outcome, outcome.detail))
    return outcome
  }
}

/**
 * Ask one platform's tool whether it can be reached, without delivering anything.
 *
 * A reachability probe for `install` and `doctor` (IO-2), and the reason a hub can tell
 * "there is no notifier" (nothing is attempted, health says `not-wired`) from "the notifier
 * cannot work" (every delivery is attempted and every one fails with `command-not-found`) -
 * a distinction an operator needs and a health payload alone cannot express (APX-FR-02,
 * NT-FR-09).
 *
 * The command is the platform's own and is chosen to be answered without a notification
 * server: `--version` on Linux, a script that returns a literal on macOS, a script that
 * exits on Windows. A probe that could put a toast on a developer's screen is a probe
 * nobody runs, so the argument list each platform passes is asserted in its own test file
 * and contains no notification call.
 *
 * The command's output is not read: availability is a boolean and a closed reason, because
 * the string a tool prints about itself is not a fact this product keeps. A rejected runner
 * is `command-unusable` rather than an exception, because `doctor` asks this question on a
 * machine that may be in any state at all.
 */
export async function probeAvailability(input: {
  readonly platform: NotifyPlatform
  readonly command: NotificationCommand
  readonly run?: NotificationCommandRunner
  readonly timeoutMs: number
}): Promise<NotificationAvailability> {
  const run = input.run ?? createNodeCommandRunner({ timeoutMs: input.timeoutMs })
  let result: NotificationCommandResult
  try {
    result = await run(input.command)
  } catch {
    return { available: false, platform: input.platform, reason: 'command-unusable' }
  }
  if (result.spawnError === 'ENOENT') {
    return { available: false, platform: input.platform, reason: 'command-not-found' }
  }
  if (result.spawnError === 'ETIMEDOUT') {
    return { available: false, platform: input.platform, reason: 'probe-timed-out' }
  }
  if (result.spawnError !== null || result.code !== 0) {
    return {
      available: false,
      platform: input.platform,
      reason: 'command-unusable',
      detail: firstLine(result.stderr),
    }
  }
  return { available: true, platform: input.platform, reason: 'available' }
}

/**
 * One line naming the reason, the exit status and the tool's own complaint.
 *
 * Identical on all three platforms on purpose: an operator reading a log or a `doctor` line
 * should not have to know which platform produced it, and the reason token beside it is the
 * closed vocabulary this product keeps (APX-FR-02, NT-FR-09). It says the block is still
 * pending and that nothing was retried, because those are the two facts that decide what an
 * operator does next, and it says no sound was requested because a reader who cannot rule
 * that out will assume the worst (APX-CON-04). No title, no body, no path, no identifier.
 */
export function failureLine(
  toolName: string,
  outcome: NotificationOutcome,
  detail?: string,
): string {
  return (
    `notify: a ${toolName} delivery did not happen (${outcome.reason}` +
    `${outcome.exitCode === undefined || outcome.exitCode === null ? '' : `, exit ${String(outcome.exitCode)}`}` +
    `). The event is stored and the block is still pending; nothing was retried, and no sound was ` +
    `requested (APX-FR-02, APX-CON-04, NT-FR-09)${detail === undefined || detail === '' ? '' : `: ${detail}`}`
  )
}

/**
 * A tool's complaint, as one bounded line.
 *
 * A newline in a diagnostic is two lines in whatever reads it, and a bound is what keeps a
 * verbose tool from becoming a paragraph in the middle of a shutdown. Absent rather than
 * empty when the tool said nothing, so a caller can tell "no complaint" from "no detail
 * yet".
 */
export function firstLine(stderr: string): string | undefined {
  const first = stderr.split('\n', 1)[0]?.trim() ?? ''
  if (first === '') return undefined
  return first.length > NOTIFY_STDERR_MAX_BYTES ? first.slice(0, NOTIFY_STDERR_MAX_BYTES) : first
}
