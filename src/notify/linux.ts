// The Linux notifier: `notify-send`, libnotify, and an argument list instead of a
// shell (NT-FR-01, NT-FR-02, NT-FR-08, NT-FR-09, ADR-004, ADR-010, APX-CON-04,
// APX-FR-02, APX-CON-10, PRD 16 Open Question 2).
//
// VERIFICATION STATE, SAID ONCE AND SAID PLAINLY
// This path is implemented, unit-tested, and exercised in this repository's tests
// against the real `notify-send` binary: the real tool is executed, its own exit status
// is recorded, and a real process receives the payload as discrete arguments. What is
// NOT verified here is whether a *particular desktop* honours the resident hint - that is
// NT-4's human gate on a real notification service, and PRD 16 Open Question 2 records
// it as an open question rather than a fact. (APX-CON-06)
//
// THE ARGUMENT LIST IS THE DELIVERY
// `buildNotifySendCommand` is a pure function from a rendered request to a file and an
// array of strings, and the array is the product's real behaviour: there is no command
// string, no quoting, no escaping and no shell anywhere on this path. A repository
// called `$(id)` or a body containing a semicolon is text the operating system receives
// as one argument, because there is nothing that could ever interpret it. The spawn is
// `shell: false` for the same reason stated in code, and the test that proves it is the
// one that watches a real process print its own argv.
//
// THREE FLAGS, AND WHAT EACH ONE IS FOR
//   --app-name=agent-ping   so the notification server groups these under one name
//   --urgency=critical      the loudness half of "needs you" (PRD 16 Open Question 2)
//   --expire-time=0         the other half: notify-send's "never expire", so the toast
//                           is not auto-dismissed. Paired with the resident hint
//                           because a desktop that honours one and not the other still
//                           dismisses the toast, and the pair is the assumed hint set.
//   --hint=boolean:resident:true
//                           libnotify's resident hint, asked for explicitly
//   -- <title> <body>       the two lines, last, after `--` so a title beginning with a
//                           dash is read as text rather than as another option
//
// A `finished` notification gets the same three, with `normal` urgency and a real
// expiry, and *no* resident hint: the AC for NT-FR-02 is that the resident and
// non-auto-dismissing flags are set for needs-you and are not set for finished, and
// omitting the hint is the stronger form of "not set".
//
// NO SOUND, AND NO WAY TO ADD ONE BY ACCIDENT (APX-CON-04)
// There is no sound argument here and no sound field on the request. What remains is
// outside this process: a desktop with a notification sound configured will make one,
// because that is the desktop's setting and not this product's. NT-4's live gate is where
// that is observed, and it is recorded in the review rather than pretended away here.
//
// THE BOUND, AND WHY IT IS SHORTER THAN THE HUB'S
// One notifier call is bounded twice on purpose. The delivery policy bounds the *call* at
// DELIVERY_ATTEMPT_TIMEOUT_MS (2 s, src/hub/delivery.ts); if that expired first, the
// policy would abandon the promise and record `notifier-timeout` while the child process
// kept running, leaking a `notify-send` per delivery. So this file's own bound is shorter
// - 1.5 s - which means the timeout is caught here, the child is killed, and the reason
// recorded is `command-timed-out` with the fact that a process was killed.
//
// ONE ATTEMPT, NO RETRY (NT-FR-08, APX-CON-10)
// There is no loop in this file, no timer that re-fires a notification and no second
// attempt on failure. A `notify-send` that exits non-zero is reported with its own exit
// status and the reason, and the block stays stored and pending, which is the correct
// answer: a failed toast is a missing notification, never a lost block (ADR-010). The
// badge and the dashboard are what carry the block; re-firing is not.
//
// WHY A FAILURE IS A VALUE AND NOT A THROW
// The notifier interface returns an outcome (NT-FR-01), and this file never throws for a
// delivery that did not happen: a missing binary, a rejected hint, a closed session bus
// and a killed process are all facts, and the reason for each is a closed token beside
// the process's own exit status. The throw that carries this across the hub's boundary
// is the composition root's adapter (src/notify/registry.ts), so the only thing that
// decides a delivery failed is something that can see the reason (APX-FR-02, NT-FR-09).
//
// WHAT A TITLE OR BODY CANNOT CONTAIN
// Neither string is built here: they arrive on the request from ./policy.ts, which builds
// them from a repository short name the durable log already holds and one sentence from a
// table. This file puts them on a command line and nowhere else - not in a log line, not
// in a diagnostic, not in a record (APX-FR-01, APX-CON-12).

import { spawn, type ChildProcess } from 'node:child_process'
import { decideNotification } from './policy.js'
import {
  NOTIFICATION_APP_NAME,
  type NotificationAvailability,
  type NotificationCommand,
  type NotificationCommandResult,
  type NotificationCommandRunner,
  type NotificationOutcome,
  type NotificationRequest,
  type Notifier,
} from './types.js'

/**
 * The tool.
 *
 * A bare name, resolved through PATH by the operating system when the process is
 * started - never by a shell, and never resolved by this file. A test puts a script with
 * this name at the front of PATH and the product runs it, which is how the tests below
 * watch a real process receive a real argument list.
 */
export const NOTIFY_SEND = 'notify-send'

/**
 * The expiry asked for when a notification must not auto-dismiss.
 *
 * Zero, which is `notify-send`'s "never expire" - and *asked for*, not assumed: whether
 * a desktop honours it is PRD 16 Open Question 2, confirmed by NT-4's gate. Nothing
 * here re-fires a toast if the request is ignored, because a repeat timer is forbidden
 * (NT-FR-08) and the badge is the durable signal.
 */
export const RESIDENT_EXPIRE_MS = 0

/**
 * The expiry asked for when a notification is allowed to go.
 *
 * Five seconds. Long enough to read one line, short enough that a finished turn does not
 * sit on a developer's screen while they work on something else, which is the whole of
 * the difference between the two classes in ADR-004's terms.
 */
export const FINISHED_EXPIRE_MS = 5_000

/**
 * libnotify's resident hint, in `notify-send`'s `-h/--hint` spelling.
 *
 * The second half of the assumed hint set (PRD 16 Open Question 2). A type of `boolean`
 * because that is what libnotify defines the hint as; `notify-send` rejects anything
 * else with a non-zero exit, which is a failure this file would record (see the live
 * evidence in tests/notify/linux.test.ts).
 */
export const RESIDENT_HINT = '--hint=boolean:resident:true'

/**
 * How long one `notify-send` process may take.
 *
 * Deliberately below the delivery policy's own bound of 2 s, so the child is killed and
 * its timeout recorded here rather than abandoned by a caller that would then leave the
 * process running. One and a half seconds is also longer than a real `notify-send` needs
 * on a working session bus by a wide margin, so a process that takes this long is a
 * process that is stuck (APX-CON-10).
 */
export const NOTIFY_COMMAND_TIMEOUT_MS = 1_500

/**
 * How much of a tool's stderr is kept.
 *
 * The first 512 characters of it, and the runner stops appending at that. The text exists
 * so an operator can read why a delivery failed (NT-FR-09); it is never stored, never
 * served and never put in a record, and a bound is what keeps a chatty tool from turning a
 * diagnostic into something this product has to keep (APX-FR-01).
 */
export const NOTIFY_STDERR_MAX_BYTES = 512

/** How long a wedged process has to die on SIGTERM before it is killed outright. */
const KILL_GRACE_MS = 250

// ---------------------------------------------------------------------------
// The argument list
// ---------------------------------------------------------------------------

/**
 * The exact invocation for one rendered request.
 *
 * Pure: same request in, same array out, and the caller's request is not modified. The
 * order is fixed - app name, urgency, expiry, hints, then the two lines after `--` - so
 * the invocation a test asserts is the invocation a developer can copy out of this file
 * and run by hand, which is the same list docs/runbooks/notify-platforms.md records per
 * platform (NT-2).
 *
 * `persistence` is the only field that changes the flags, and it is the field the class
 * policy set: `resident` gets the zero expiry and the resident hint, `expires` gets a
 * real expiry and no hint at all. There is no branch anywhere else in this file, because
 * there is no other decision to make.
 */
export function buildNotifySendCommand(request: NotificationRequest): NotificationCommand {
  const args: string[] = [
    `--app-name=${NOTIFICATION_APP_NAME}`,
    `--urgency=${request.urgency}`,
    `--expire-time=${
      request.persistence === 'resident' ? String(RESIDENT_EXPIRE_MS) : String(FINISHED_EXPIRE_MS)
    }`,
  ]
  if (request.persistence === 'resident') args.push(RESIDENT_HINT)
  // The terminator before the first free-text argument. `notify-send`'s parser stops
  // reading options at `--`, which is what keeps a repository short name that begins
  // with a dash from being read as one. Confirmed against the real binary in
  // tests/notify/linux.test.ts; NT-4 records the adjustment if a desktop's notify-send
  // version does not accept it.
  args.push('--', request.title, request.body)
  return { file: NOTIFY_SEND, args }
}

// ---------------------------------------------------------------------------
// The real runner
// ---------------------------------------------------------------------------

/**
 * Run one command, with no shell and with a bound.
 *
 * The production implementation of `NotificationCommandRunner`, and the reason a test
 * can substitute a recording function. Four properties, all of them load-bearing:
 *
 *   - `shell: false` is passed explicitly rather than left to the default, because the
 *     default is a promise and this is the line that would be read by whoever changes it
 *   - stdin is closed and stdout is discarded, so a tool that decides it is interactive
 *     cannot block the hub waiting for a person who is not there
 *   - stderr is collected to a bound, because it is the only text a failing tool
 *     produces and it is a diagnostic rather than a record
 *   - the bound kills the process rather than abandoning the promise, so a wedged
 *     `notify-send` cannot outlive the delivery that started it
 *
 * It never rejects. Every path resolves with a result, because a runner that threw would
 * leave the notifier with an exception where it expects a reason (APX-FR-02).
 */
export function createNodeCommandRunner(
  options: { readonly timeoutMs?: number } = {},
): NotificationCommandRunner {
  const timeoutMs = options.timeoutMs ?? NOTIFY_COMMAND_TIMEOUT_MS
  return (command: NotificationCommand): Promise<NotificationCommandResult> =>
    new Promise<NotificationCommandResult>((resolve) => {
      let settled = false
      let stderr = ''
      let killGrace: NodeJS.Timeout | undefined
      const bound = setTimeout(() => {
        // Terminate first, then insist. SIGTERM is what a well-behaved tool exits on;
        // SIGKILL is what a wedged one needs, and the grace between them is short enough
        // that a hung delivery is bounded by this file's own constant rather than by
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
        // The process never started, or could not be started at all: a missing
        // `notify-send` (`ENOENT`), a permission problem, an exhausted process table.
        // There is no exit code for this, which is why the result carries both.
        finish({ code: null, signal: null, spawnError: error.code ?? 'ESPAWN', stderr })
      })
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        finish({ code, signal, spawnError: null, stderr })
      })
    })
}

/**
 * Start the process, with the options this file's argument list depends on.
 *
 * Separate from the runner so the real spawn is one small, readable function: a
 * reviewer can confirm the two things that matter here - that the arguments are passed
 * as an array and that `shell` is false - without reading the promise bookkeeping
 * around them. stderr is decoded as utf8 and handed upwards; nothing is read from the
 * process that this product keeps.
 */
function spawnNotificationProcess(
  command: NotificationCommand,
  onStderr: (chunk: string) => void,
): ChildProcess {
  const child = spawn(command.file, [...command.args], {
    // Stated, not defaulted. Every argument in `command.args` reaches the operating
    // system as one argument, and no shell ever sees the title or the body.
    shell: false,
    // stdin closed, stdout discarded, stderr piped: a tool that expects a terminal
    // cannot make the hub wait for one, and its only useful complaint is collected.
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', onStderr)
  return child
}

// ---------------------------------------------------------------------------
// The notifier
// ---------------------------------------------------------------------------

export interface CreateLinuxNotifierOptions {
  /** The runner. A test passes a recording function; production passes the real one. */
  readonly run?: NotificationCommandRunner
  /**
   * Overrides the bound of the runner this notifier builds.
   *
   * An injected `run` owns its own bound, so this does not apply to one: the notifier
   * cannot bound a runner it did not write, and a test that wants a short bound asks the
   * runner for it rather than setting a number here that would be ignored (a silent
   * no-op option is worse than none).
   */
  readonly timeoutMs?: number
  /** Reports a diagnostic line, on a failure only. Never called with content. */
  readonly onDiagnostic?: (message: string) => void
}

/**
 * The Linux notifier behind the shared interface.
 *
 * Three steps, and the first one is the class policy rather than a branch of its own:
 * an `fyi` request is refused here too, so a caller that skipped the planner still
 * cannot get one onto a command line. That is defence in depth rather than a second
 * policy - the decision comes from the one table in ./policy.ts, so there is nothing to
 * drift (NT-FR-02).
 *
 * A delivered request becomes one command and one outcome. A refusal becomes an outcome
 * with no command, because no process was started. A failure becomes an outcome carrying
 * the process's own exit status and the reason, and a diagnostic line naming both.
 */
export function createLinuxNotifier(options: CreateLinuxNotifierOptions = {}): Notifier {
  const timeoutMs = options.timeoutMs ?? NOTIFY_COMMAND_TIMEOUT_MS
  const diagnostic = options.onDiagnostic ?? ((): void => {})
  const run = options.run ?? createNodeCommandRunner({ timeoutMs })

  return async (request: NotificationRequest): Promise<NotificationOutcome> => {
    // The same table the planner used. A refused class cannot be delivered even if this
    // notifier is handed one directly, which is what makes "an fyi never reaches
    // notify-send" true of the notifier and not only of the planner.
    const policy = decideNotification(request.class)
    if (policy.kind === 'refuse') {
      return { status: 'refused', reason: policy.reason, platform: 'linux' }
    }
    const command = buildNotifySendCommand(request)
    let result: NotificationCommandResult
    try {
      result = await run(command)
    } catch {
      // A runner that rejects is a broken runner, not a delivered toast, and the reason
      // it cannot say more is itself the fact worth recording (APX-FR-02).
      return failedOutcome(command, null, 'command-failed', 'the command runner rejected')
    }
    const detail = firstLine(result.stderr)
    if (result.spawnError === 'ENOENT') {
      const outcome = failedOutcome(
        command,
        null,
        'command-not-found',
        detail ?? `${NOTIFY_SEND} is not on PATH`,
      )
      reportFailure(outcome, detail)
      return outcome
    }
    if (result.spawnError === 'ETIMEDOUT') {
      const outcome = failedOutcome(command, null, 'command-timed-out', detail)
      reportFailure(outcome, detail)
      return outcome
    }
    if (result.spawnError !== null) {
      const outcome = failedOutcome(command, null, 'command-failed', detail ?? result.spawnError)
      reportFailure(outcome, detail)
      return outcome
    }
    if (result.signal !== null) {
      const outcome = failedOutcome(
        command,
        null,
        'command-signalled',
        detail ?? `killed by ${result.signal}`,
      )
      reportFailure(outcome, detail)
      return outcome
    }
    if (result.code !== 0) {
      // The exit status is recorded rather than interpreted, because this product does
      // not control the reasons a notification server refuses a notification: no
      // session bus, no display server, a rejected hint, a saturated queue. All of them
      // mean the same thing here - nobody was told - and the tool's own complaint is
      // beside them in the diagnostic.
      const outcome = failedOutcome(command, result.code, 'command-failed', detail)
      reportFailure(outcome, detail)
      return outcome
    }
    return {
      status: 'delivered',
      reason: 'delivered-to-desktop',
      platform: 'linux',
      command: [...command.args],
      exitCode: 0,
    }
  }

  /** One line naming the reason, the exit code and the tool's complaint. No content. */
  function reportFailure(outcome: NotificationOutcome, detail: string | undefined): void {
    diagnostic(
      `notify: a ${NOTIFY_SEND} delivery did not happen (${outcome.reason}` +
        `${outcome.exitCode === undefined || outcome.exitCode === null ? '' : `, exit ${String(outcome.exitCode)}`}` +
        `). The event is stored and the block is still pending; nothing was retried, and no sound was ` +
        `requested (APX-FR-02, APX-CON-04, NT-FR-09)${detail === undefined ? '' : `: ${detail}`}`,
    )
  }
}

/**
 * Is there a notifier to deliver with on this machine?
 *
 * A reachability probe for `install` and `doctor` (IO-2), and the reason a Linux hub can
 * tell "there is no notifier" (nothing is attempted, health says `not-wired`) from "the
 * notifier cannot work" (every delivery is attempted and every one fails with
 * `command-not-found`) - a distinction an operator needs and a health payload alone
 * cannot express (APX-FR-02, NT-FR-09).
 *
 * `--version`, which the real tool answers and exits on without contacting a
 * notification server, so a probe cannot itself put a toast on a developer's screen. The
 * command's output is not read: availability is a boolean and a closed reason, because
 * the string a tool prints about its own version is not a fact this product keeps.
 */
export async function probeLinuxNotifier(
  options: CreateLinuxNotifierOptions = {},
): Promise<NotificationAvailability> {
  const run = options.run ?? createNodeCommandRunner({ timeoutMs: options.timeoutMs })
  const command: NotificationCommand = { file: NOTIFY_SEND, args: ['--version'] }
  let result: NotificationCommandResult
  try {
    result = await run(command)
  } catch {
    return { available: false, platform: 'linux', reason: 'command-unusable' }
  }
  if (result.spawnError === 'ENOENT') {
    return { available: false, platform: 'linux', reason: 'command-not-found' }
  }
  if (result.spawnError === 'ETIMEDOUT') {
    return { available: false, platform: 'linux', reason: 'probe-timed-out' }
  }
  if (result.spawnError !== null || result.code !== 0) {
    return { available: false, platform: 'linux', reason: 'command-unusable', detail: firstLine(result.stderr) }
  }
  return { available: true, platform: 'linux', reason: 'available' }
}

// ---------------------------------------------------------------------------
// The helpers
// ---------------------------------------------------------------------------

/**
 * A failed outcome, built the same way in every failure branch.
 *
 * The command is copied rather than referenced so an outcome cannot be changed by
 * anything that still holds the array it was built from, and `exitCode` is the process's
 * own: null when it never ran or was killed, which is a different fact from a non-zero
 * code and reads as one on `doctor`.
 */
function failedOutcome(
  command: NotificationCommand,
  exitCode: number | null,
  reason: 'command-not-found' | 'command-failed' | 'command-signalled' | 'command-timed-out',
  detail?: string,
): NotificationOutcome {
  return {
    status: 'failed',
    reason,
    platform: 'linux',
    command: [...command.args],
    exitCode,
    ...(detail === undefined || detail === '' ? {} : { detail }),
  }
}

/**
 * A tool's complaint, as one bounded line.
 *
 * A newline in a diagnostic is two lines in whatever reads it, and a bound is what keeps
 * a verbose tool from becoming a paragraph in the middle of a shutdown. Empty rather than
 * undefined when the tool said nothing, so a caller can tell "no complaint" from "no
 * detail yet".
 */
function firstLine(stderr: string): string | undefined {
  const first = stderr.split('\n', 1)[0]?.trim() ?? ''
  if (first === '') return undefined
  return first.length > NOTIFY_STDERR_MAX_BYTES ? first.slice(0, NOTIFY_STDERR_MAX_BYTES) : first
}
