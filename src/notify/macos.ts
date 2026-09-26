// The macOS notifier: an `osascript` notification-centre call, with the two lines a
// person reads passed as discrete arguments (NT-FR-01, NT-FR-02, NT-FR-03, NT-FR-08,
// NT-FR-09, ADR-004, ADR-010, APX-CON-04, APX-CON-06, APX-FR-02).
//
// VERIFICATION STATE, SAID ONCE AND SAID PLAINLY
// This path is implemented and unit-tested. It is NOT live-verified on the authoring
// machine: this code was written on Linux, no macOS machine has run it, and nothing in
// this repository may be read as evidence that a macOS banner ever appeared. What the
// tests here prove is the argument list, the payload placement, the refusal of an `fyi`,
// the failure vocabulary, and that a real process receives the payload as discrete
// arguments. What only a macOS machine can confirm is recorded in
// docs/runbooks/notify-platforms.md and belongs to NT-5's human gate (APX-CON-06,
// NT-FR-03).
//
// THE PAYLOAD IS ARGUMENT ELEMENTS, NOT SCRIPT SOURCE
// The obvious way to write this is to interpolate the title and the body into the
// AppleScript and hope the escaping holds: `display notification "<body>" with title
// "<title>"`. This file does not, and the difference is the whole of its safety argument.
// The script is a fixed constant and the two strings are separate arguments after `--`,
// read by the handler's own `argv`:
//
//   osascript -e 'on run argv' -e '<one fixed line>' -e 'end run' -- <title> <body>
//
// So there is no second parser between the title and the screen. A repository called
// `$(rm -rf ~)` or a body containing a quote, a backslash or a newline is one argument
// with a newline in it, which is the same property the Linux path has and for the same
// reason: there is no shell and no string built by joining (APX-FR-01).
//
// WHAT THE BASIC NOTIFICATION CALL CANNOT DO, STATED HERE RATHER THAN DISCOVERED
// PRD 16 Open Question 3 records the assumed mechanism as an `osascript` notification
// centre call, and this file implements exactly that and no more. The consequences are
// real and a developer on a Mac should know them before they rely on the toast:
//   - no persistence. `display notification` has no option that asks for a banner to stay,
//     so the resident half of a needs-you class is not available here (feature Open
//     Question 2: "Not through the basic notification call; the badge carries persistence
//     there"). Nothing in this file fakes it: there is no re-firing, because NT-FR-08
//     forbids a repeat timer more seriously than it forbids a missing toast, and the
//     badge plus the dashboard are what carry a pending block on this platform (NT-3).
//   - no urgency. The three libnotify urgency levels have no counterpart in this call, so
//     the class decides *whether* a banner appears and the loudness difference between
//     the two delivered classes is carried by the badge rather than by the banner.
//   - no activation. The call cannot report which banner was clicked, so the deep link on
//     the request is carried and available but nothing on this platform can act on it;
//     NT-3's tray resolves it, exactly as on Linux.
//   - no bundle identity. The basic call carries no application identifier, so macOS
//     attributes the banner to the process that made the call. This is a known cosmetic
//     gap, it is listed in the runbook as something NT-5 should observe, and it is not
//     worked around here by shipping a signed bundle.
// None of these gaps is a reason to refuse a delivery, and none of them is a reason to
// claim more than happened: the outcome says a process was started and it exited zero,
// and nothing here says a banner was read.
//
// NO SOUND, AND NO WAY TO ADD ONE BY ACCIDENT (APX-CON-04)
// The AppleScript `display notification` command has a `sound name` parameter. This file
// does not use it, does not expose it, and has no field that could carry it, because sound
// in v1 is forbidden on every platform and every class. A test sweeps the whole argument
// list - script lines included - against sound-capable spellings so a later edit that adds
// one fails rather than shipping. What remains is outside this process: a Mac configured
// with a system notification sound will make one, because that is the user's setting. NT-5
// observes it; this file cannot.
//
// ONE ATTEMPT, NO RETRY, AND THE BOUND
// `osascript` starts in tens of milliseconds, so this platform's bound is short: a process
// that takes a second and a half is wedged, and being killed at the bound is a recorded
// failure with a reason rather than a delivery held open (APX-CON-10). There is no loop
// here and no second attempt. A non-zero exit from `osascript` is reported with its own
// status and its own first line of stderr, through the same classification the other two
// platforms use (./command.ts), so `doctor` reads one vocabulary on every platform.

import {
  createNodeCommandRunner,
  probeAvailability,
  refusedOutcome,
  reportCommandResult,
  RUNNER_REJECTED,
} from './command.js'
import { decideNotification } from './policy.js'
import {
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
 * A bare name, resolved through PATH by the operating system when the process is started
 * and never by a shell. `osascript` is in `/usr/bin` on every macOS install, so the bare
 * name is the portable form and it is also the form a developer can type by hand exactly
 * as this file builds it (docs/runbooks/notify-platforms.md).
 */
export const OSASCRIPT = 'osascript'

/**
 * The script, as three fixed lines and never anything else.
 *
 * Passed as three `-e` arguments rather than one string with newlines in it, so the
 * command a developer runs by hand is the command this file builds, character for
 * character. The three lines are:
 *
 *   on run argv
 *   display notification ((item 2 of argv) as text) with title ((item 1 of argv) as text)
 *   end run
 *
 * `on run argv` is what makes the payload discrete: arguments after `--` arrive as the
 * handler's argument list, so the title and the body are argv elements and never text
 * inside the script. The `as text` coercions are defensive rather than decorative - a
 * `osascript` that coerced a numeric-looking argument to a number would hand the
 * notification centre a number where a title belongs, and the project parses defensively
 * everywhere else for the same reason (PRD 16 Open Question 4).
 *
 * Note what is absent: no `sound name`, no urgency, no persistence parameter. The
 * omissions are the point; see the header for what each one costs and why none of them is
 * faked (APX-CON-04, PRD 16 Open Question 3).
 */
export const OSASCRIPT_SCRIPT_LINES: readonly string[] = [
  'on run argv',
  'display notification ((item 2 of argv) as text) with title ((item 1 of argv) as text)',
  'end run',
]

/**
 * The terminator between the script and the payload.
 *
 * `osascript` stops reading its own options at `--` and hands everything after it to the
 * handler as `argv`. Without it a repository short name beginning with a dash could be
 * read as another option - the same hazard the Linux path guards against, and the reason
 * the constant is named rather than typed into the array.
 */
export const OSASCRIPT_PAYLOAD_TERMINATOR = '--'

/**
 * How long one `osascript` process may take.
 *
 * 1.5 s, the same bound the Linux path uses and for the same reason: it is below the
 * delivery policy's own 2 s call bound (src/hub/delivery.ts), so the child is killed and
 * the reason recorded here rather than a promise being abandoned with the process still
 * running. `osascript` is a small tool that returns as soon as the notification centre
 * call returns, so anything slower is wedged (APX-CON-10).
 */
export const OSASCRIPT_COMMAND_TIMEOUT_MS = 1_500

/**
 * The argument list before the two lines, as one constant.
 *
 * Frozen because it is the part that has to be identical for every class on this platform:
 * a class may not change what kind of call is made, only whether one is made at all. A
 * test asserts the prefix is the same array for a block, for a finished turn and for a
 * title built to be hostile.
 */
const OSASCRIPT_PREFIX: readonly string[] = [
  ...OSASCRIPT_SCRIPT_LINES.flatMap((line): string[] => ['-e', line]),
  OSASCRIPT_PAYLOAD_TERMINATOR,
]

/**
 * The exact invocation for one rendered request.
 *
 * Pure: the same request in, the same array out, and the caller's request is not
 * modified. Title then body, in the order the handler reads them (`item 1`, `item 2`),
 * each one discrete argument.
 *
 * `urgency` and `persistence` are not consulted, and that is not an oversight: this
 * platform's call has no parameter that either could set. The class has already been
 * decided by the one table in ./policy.ts before this function is reached, and a refused
 * class never reaches it at all (NT-FR-02, NT-FR-03).
 */
export function buildOsascriptCommand(request: NotificationRequest): NotificationCommand {
  return { file: OSASCRIPT, args: [...OSASCRIPT_PREFIX, request.title, request.body] }
}

// ---------------------------------------------------------------------------
// The notifier
// ---------------------------------------------------------------------------

export interface CreateMacosNotifierOptions {
  /** The runner. A test passes a recording function; production passes the real one. */
  readonly run?: NotificationCommandRunner
  /**
   * Overrides the bound of the runner this notifier builds.
   *
   * An injected `run` owns its own bound, so this does not apply to one: the notifier
   * cannot bound a runner it did not write, and a silent no-op option is worse than none.
   */
  readonly timeoutMs?: number
  /** Reports a diagnostic line, on a failure only. Never called with content. */
  readonly onDiagnostic?: (message: string) => void
}

/**
 * The macOS notifier behind the shared interface.
 *
 * Structurally the same four steps as the Linux one and the Windows one, and deliberately
 * so: read the one class policy, refuse what it refuses, build this platform's argument
 * list, and hand the result to the shared classification in ./command.ts. There is no
 * second policy here and no second failure vocabulary - the only thing this file knows
 * that the other two do not is what an `osascript` call looks like (NT-FR-02, NT-FR-03).
 */
export function createMacosNotifier(options: CreateMacosNotifierOptions = {}): Notifier {
  const run = options.run ?? createNodeCommandRunner({ timeoutMs: options.timeoutMs ?? OSASCRIPT_COMMAND_TIMEOUT_MS })

  return async (request: NotificationRequest): Promise<NotificationOutcome> => {
    // The same table the planner used. A refused class cannot be delivered even if this
    // notifier is handed one directly, which is what makes "an fyi never reaches
    // osascript" true of the notifier and not only of the planner.
    const policy = decideNotification(request.class)
    if (policy.kind === 'refuse') return refusedOutcome('macos', policy.reason)
    const command = buildOsascriptCommand(request)
    let result: NotificationCommandResult
    try {
      result = await run(command)
    } catch {
      // A runner that rejects is a broken runner, not a delivered banner (APX-FR-02).
      result = RUNNER_REJECTED
    }
    return reportCommandResult({
      command,
      platform: 'macos',
      result,
      toolName: OSASCRIPT,
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    })
  }
}

/**
 * The script a reachability probe asks `osascript` to run.
 *
 * `return 1` - the smallest script that compiles, runs and exits zero. It touches no
 * application, sends no Apple event, shows nothing, and therefore cannot prompt for an
 * automation permission or put a banner on a developer's screen. The value it returns is
 * discarded with stdout, so availability stays a boolean and a closed reason rather than a
 * string this product would have to keep (APX-FR-01, NT-FR-09).
 */
export const OSASCRIPT_PROBE_ARGS: readonly string[] = ['-e', 'return 1']

/**
 * Is there a notifier to deliver with on this machine?
 *
 * The shared probe from ./command.ts with this platform's tool and bound. A macOS machine
 * without a usable `osascript` - a stripped install, a PATH that does not include
 * `/usr/bin` - answers `command-not-found`, which is the fact `doctor` needs in order to
 * tell "no notifier" apart from "notifier that cannot deliver" (NT-FR-09, APX-FR-02).
 */
export async function probeMacosNotifier(
  options: CreateMacosNotifierOptions = {},
): Promise<NotificationAvailability> {
  return probeAvailability({
    platform: 'macos',
    command: { file: OSASCRIPT, args: OSASCRIPT_PROBE_ARGS },
    timeoutMs: options.timeoutMs ?? OSASCRIPT_COMMAND_TIMEOUT_MS,
    ...(options.run === undefined ? {} : { run: options.run }),
  })
}
