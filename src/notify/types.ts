// The notifier's own vocabulary: what a notification is, what a request for one
// carries, and what came of asking (NT-FR-01, NT-FR-02, ADR-004, ADR-010,
// APX-FR-02, APX-CON-04, APX-CON-12, PRD 16 Open Question 2).
//
// WHAT THIS FILE IS
// Three closed vocabularies, one function type and one error. It renders nothing,
// spawns nothing and decides nothing: the class policy that decides *whether* a
// notification is made lives in ./policy.ts as a pure table, and the platform code
// that makes one lives in ./linux.ts (and, in NT-2, ./macos.ts and ./windows.ts).
// What is here is the contract those two halves share, so a platform notifier cannot
// invent a class, a reason or a field that nothing else in the product knows about.
//
// THE SIX FIELDS A REQUEST CARRIES, AND WHY THOSE SIX (NT-FR-01)
//   class, title, body, urgency, deep link, persistence
// The request is the *rendered* form of what the hub decided, not the stored event:
// the hub's own boundary (src/hub/delivery.ts) hands over a content-free event row, and
// turning that into words a person reads is this half of the product's job and nobody
// else's. `urgency` and `persistence` are separate fields rather than one "loudness"
// number because they are separate mechanisms on every platform: urgency is a hint the
// notification server interprets, and persistence is the pair of flags that decide
// whether a toast stays on screen (ADR-004, PRD 16 Open Question 2).
//
// `deepLink` is a field here and *not* a field on every platform's invocation, which
// is worth stating plainly rather than leaving as a surprise. The contract is
// `?session=<id>` on the loopback dashboard URL, published by src/hub/metrics.ts as
// DEEP_LINK_QUERY_KEY so the notifier, the dashboard and the counter cannot disagree
// (NT-FR-07). The `notify-send` tool exposes no action to receive an activation, so
// the Linux path cannot put the link on screen as a clickable target; the link is
// built, carried and available, and NT-3's tray is what resolves it on this platform.
// The badge and the dashboard are the recovery path, which is why PRD 16 Open Question
// 3 says the badge carries the durable signal rather than a clickable toast.
//
// THREE OUTCOMES, AND WHY A REFUSAL IS NOT ONE OF THEM
// `delivered` means a process was started and it exited zero. `failed` means it did
// not, with a reason that says which way. `refused` means nothing was started at all
// because the class policy declined the request - an `fyi` never leaves the app
// (NT-FR-02), and a refusal is the policy working, not a fault. A record that
// conflated the last two would either alarm an operator about a correct decision or
// count a refusal as a toast; PRD 11 measures notification restraint with the toast
// counter, so the two must stay apart.
//
// EVERY REASON IS A CLOSED TOKEN
// The reason a delivery failed is part of what this product keeps and serves, so it
// cannot be an arbitrary string (APX-FR-01, ADR-010). Six tokens, one per thing that
// can happen to one process: it started and succeeded, it was not started because the
// policy declined, it was not found, it failed, it was killed, or it exceeded the
// bound. The tool's own complaint about *why* is not in the token - it is one bounded
// line on the diagnostic callback, where an operator reads it and a record cannot
// carry it.
//
// A COMMAND IS A FILE AND AN ARGUMENT LIST, NEVER A STRING
// `NotificationCommand` is two values. The whole point is that the executable and its
// arguments are separate, so a title or a body is a value the operating system receives
// as an argument and nothing ever has to be quoted, escaped or parsed: there is no
// shell on this path at all, which is why a repository called `$(rm -rf ~)` is a
// repository name and not an incident. Every platform notifier builds one of these and
// the runner runs it; the test that matters for that claim is the one that watches a
// real process receive the payload as discrete arguments.
//
// VERIFICATION STATE, STATED THE SAME WAY IN EVERY FILE HERE
// The Linux path in ./linux.ts is implemented, unit-tested, and exercised against the
// real `notify-send` binary in this repository's tests. The macOS and Windows paths are
// NOT live-verified on the authoring machine: they arrive in NT-2 with scripted checks
// and a runbook, and their human gate (NT-5) can only be completed on those platforms
// (APX-CON-06).

import type { EventClass } from '../storage/eventStore.js'

/**
 * The loudness class, which is the stored event's own class.
 *
 * Re-used rather than restated: the classifier decides one of three classes
 * (src/domain/classify.ts) and a second union here would be a second class vocabulary
 * to keep in step. Aliasing `EventClass` also means a fourth class is a compile error in
 * the policy table below rather than an unreviewed branch (ADR-004).
 */
export type NotificationClass = EventClass

/**
 * How urgent a notification is, as the notification server understands it.
 *
 * libnotify's three levels, because they are what `notify-send --urgency` takes and
 * what a macOS or Windows implementation maps onto. The values are closed because the
 * policy table's cell names one of them and a platform notifier passes it straight to a
 * command line (PRD 16 Open Question 2).
 */
export type NotificationUrgency = 'low' | 'normal' | 'critical'

/**
 * Whether a notification is asked to stay or allowed to go.
 *
 * `resident` is the request that the toast not dismiss itself; `expires` is the request
 * that it may. This is a *request*, and on Linux it is a request: whether the installed
 * notification server honours the resident hint is PRD 16 Open Question 2, which NT-4's
 * human gate confirms rather than this file assuming. Nothing here re-fires a toast to
 * make a request effective - that is the no-repeat-timer rule (NT-FR-08).
 */
export type NotificationPersistence = 'resident' | 'expires'

/**
 * One notification to deliver: NT-FR-01's delivery request, rendered.
 *
 * Six fields, closed, and asserted field by field in tests/notify/policy.test.ts. The
 * title and the body are the only free text in this file, and they are built from a
 * repository short name the log already holds plus one sentence from a closed table -
 * never from a prompt, a tool name, a diff, a transcript or a full path
 * (APX-FR-01, ADR-003, ADR-008).
 */
export interface NotificationRequest {
  readonly class: NotificationClass
  /** One line: the repository short name. Two lines in total with `body`. */
  readonly title: string
  /** One sentence naming the kind of block. Never a count, a list or a stack. */
  readonly body: string
  readonly urgency: NotificationUrgency
  /** `?session=<id>` on the loopback dashboard URL, or null when nothing is bound. */
  readonly deepLink: string | null
  readonly persistence: NotificationPersistence
}

/**
 * What became of one request.
 *
 * `delivered` is the only status that means a person was told. `refused` is the class
 * policy declining, which is a correct outcome and not a gap. `failed` is a gap, and it
 * is the status that must be visible in `doctor`'s output rather than only in a log line
 * (NT-FR-09, APX-FR-02, ADR-010).
 */
export type NotificationOutcomeStatus = 'delivered' | 'refused' | 'failed'

/**
 * Why, as six closed tokens.
 *
 * Platform-neutral on purpose: "which binary was missing" is answered by `platform` and
 * by the recorded command, not by a reason string that would have to be extended per
 * platform (APX-FR-01).
 */
export type NotificationOutcomeReason =
  | 'delivered-to-desktop'
  | 'refused-in-app-only'
  | 'command-not-found'
  | 'command-failed'
  | 'command-signalled'
  | 'command-timed-out'

/**
 * Every reason each status can carry, as data.
 *
 * Total over the two unions, so an outcome is always explainable and a new status or
 * reason is a compile error in this table rather than an unexplained value in a ledger.
 */
export const NOTIFICATION_OUTCOME_REASONS: Readonly<
  Record<NotificationOutcomeStatus, readonly NotificationOutcomeReason[]>
> = {
  delivered: ['delivered-to-desktop'],
  refused: ['refused-in-app-only'],
  failed: ['command-not-found', 'command-failed', 'command-signalled', 'command-timed-out'],
}

/**
 * The answer for one request. Never an exception, and never a bare boolean.
 *
 * `command` is the exact argument list the process was started with - present for
 * `delivered` and `failed`, absent for `refused`, which rendered nothing - and it is
 * kept because a delivery that cannot be inspected is a delivery that cannot be
 * explained. `exitCode` is the process's own status, `null` when it never ran or was
 * killed, and it is recorded rather than interpreted: `notify-send` exits non-zero for
 * reasons this product does not control (no session bus, no display server, a rejected
 * hint) and each of them is a failure with the process's own status beside it.
 *
 * `detail` is the one field that can hold text from outside, so it is bounded to a
 * single short line of the tool's own complaint and it exists for the diagnostic
 * callback, not for a record. Nothing in this product's durable state reads it
 * (APX-FR-01, APX-CON-12).
 */
export interface NotificationOutcome {
  readonly status: NotificationOutcomeStatus
  readonly reason: NotificationOutcomeReason
  /** Which platform's notifier answered. */
  readonly platform: NotifyPlatform
  /** The argument list, verbatim, for an outcome that started a process. */
  readonly command?: readonly string[]
  readonly exitCode?: number | null
  /** One bounded line of the tool's stderr. Diagnostics only; never persisted. */
  readonly detail?: string
}

/**
 * The platforms this product supports (APX-CON-06), normalised from Node's
 * `process.platform`.
 *
 * `other` is a real answer rather than a failure: a platform nobody has implemented a
 * notifier for gets an explicit unsupported result from the registry instead of a
 * throw, and the hub then reports `not-wired` on health, which is the truth (APX-FR-02).
 */
export type NotifyPlatform = 'linux' | 'macos' | 'windows' | 'other'

/**
 * One command, as a file and an argument list.
 *
 * Two values, and the second is an array of strings that are passed to the operating
 * system as they are. There is no shell, no quoting and no joining anywhere on this
 * path, which is the property tests/notify/linux.test.ts proves against a real process
 * rather than asserting about a string.
 */
export interface NotificationCommand {
  /** The executable, resolved through PATH by the operating system, never by a shell. */
  readonly file: string
  readonly args: readonly string[]
}

/**
 * What a command did.
 *
 * `spawnError` is Node's own code for a process that never started (`ENOENT` when the
 * tool is not installed, `ETIMEDOUT` when the runner's own bound expired), and it is
 * distinct from an exit code because a process that never ran has no code. `stderr` is
 * the tool's own complaint, kept to a bounded prefix by the runner that collects it.
 */
export interface NotificationCommandResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | string | null
  readonly spawnError: string | null
  readonly stderr: string
}

/**
 * Runs one command and reports what it did. Never throws.
 *
 * The one injection point in the notification path, and the reason every platform
 * notifier can be tested without a desktop: a test passes a recording function, and
 * production passes the real spawner. A runner that rejects is a broken runner, not a
 * failed delivery, so the notifier treats a thrown runner as `command-failed` rather
 * than letting it escape (APX-FR-02).
 */
export type NotificationCommandRunner = (
  command: NotificationCommand,
) => Promise<NotificationCommandResult>

/**
 * The notifier behind NT-FR-01: a rendered request in, an outcome out.
 *
 * A function rather than an interface, for the reason the delivery policy's port is one
 * too (src/hub/delivery.ts): there is one caller and one operation. It may return a
 * promise; it must not throw, because the boundary that turns a `failed` outcome into
 * the hub's failure record is the composition root's adapter, and a notifier that threw
 * past it would be a notifier that had already lost the reason.
 */
export type Notifier = (request: NotificationRequest) => Promise<NotificationOutcome>

/**
 * The name this product answers to on the desktop.
 *
 * One constant for all three platforms, because the notification server groups by
 * application and a toast that arrives under three different names is a product that
 * looks like three.
 */
export const NOTIFICATION_APP_NAME = 'agent-ping'

/**
 * Why the notifier for this machine is usable or not.
 *
 * Availability is not the same fact as wiring. A hub whose platform has no notifier is
 * `not-wired` and nothing was attempted; a hub on Linux without `notify-send` installed
 * has a notifier, attempts every delivery, and fails every one of them with
 * `command-not-found`. `install` and `doctor` read this to tell those apart
 * (NT-FR-09, APX-FR-02).
 */
export type NotificationAvailabilityReason =
  | 'available'
  | 'command-not-found'
  | 'command-unusable'
  | 'probe-timed-out'
  // The two answers a *registry* can give rather than a probe: the platform is supported
  // and its notifier is not written yet, or the platform is not supported at all. They
  // are here rather than in the registry's own vocabulary so a caller holding an
  // availability reading - `install`, `doctor` - reads one closed union either way
  // (APX-CON-06, APX-FR-02).
  | 'not-implemented-for-this-platform'
  | 'unsupported-platform'

/** What a reachability probe found. A probe reports; it never delivers a toast. */
export interface NotificationAvailability {
  readonly available: boolean
  readonly platform: NotifyPlatform
  readonly reason: NotificationAvailabilityReason
  /** One bounded line, when there is something to say. Diagnostics only. */
  readonly detail?: string
}

/**
 * A delivery that did not happen, as a rejection the delivery policy can record.
 *
 * Thrown by the composition root's adapter (src/notify/registry.ts) and by nothing
 * else, and only for `failed`: the policy's own vocabulary is resolve-means-delivered
 * and throw-means-failed, so an outcome is the only way a reason can cross the boundary
 * intact. The message names the status, the reason and the exit code and quotes nothing
 * from the notification.
 */
export class NotificationFailedError extends Error {
  readonly outcome: NotificationOutcome

  constructor(outcome: NotificationOutcome) {
    super(
      `the notification was not delivered (${outcome.status}/${outcome.reason}` +
        `${outcome.exitCode === undefined || outcome.exitCode === null ? '' : `, exit ${String(outcome.exitCode)}`}` +
        `). The block is stored and still pending, and the developer was not told: this is recorded ` +
        'rather than reported as delivered (APX-FR-02, NT-FR-09).',
    )
    this.name = 'NotificationFailedError'
    this.outcome = outcome
  }
}
