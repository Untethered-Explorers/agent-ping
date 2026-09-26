// The platform registry: which notifier this machine gets, and the one adapter that
// carries a notifier's outcome across the hub's boundary (NT-FR-01, NT-FR-02,
// NT-FR-09, APX-CON-06, APX-FR-02, ADR-010).
//
// WHAT THIS FILE DECIDES, AND WHAT IT REFUSES TO DECIDE
// It decides which implementation answers on this platform, and it reports an explicit
// answer for every platform rather than a throw: a platform with a notifier gets one, a
// platform whose notifier has not been written yet says so, and a platform nobody
// supports says so differently. All three are values, because the caller is a hub that
// must be able to start on all of them and report what it will not be able to do
// (APX-CON-06, APX-FR-02). What it does not decide is the class policy - that is one
// table in ./policy.ts, and it is applied here to every platform rather than
// reimplemented per platform, which is the requirement NT-2 inherits (NT-FR-03,
// NT-FR-04).
//
// LINUX IS IMPLEMENTED HERE; macOS AND WINDOWS ARE NOT, AND SAY SO
// `IMPLEMENTED_NOTIFY_PLATFORMS` carries one entry. NT-2 adds the other two and changes
// nothing else about this file's shape. The distinction is worth a separate reason token
// rather than one "unsupported" answer, because the two cases mean different things to
// an operator on a developer machine: `not-implemented-for-this-platform` says the
// product intends to support it, and `unsupported-platform` says it does not (APX-CON-06).
//
// VERIFICATION STATE
// The Linux notifier this registry constructs is implemented, unit-tested, and exercised
// in this repository's tests against the real `notify-send` binary. The macOS and
// Windows notifiers are NOT live-verified on the authoring machine and are not in this
// build: they arrive in NT-2 with scripted checks, a runbook, and a human gate (NT-5)
// that can only be completed on those platforms. Nothing in this file may be read as
// evidence that either of them works.
//
// THE BOUNDARY, AND THE ONE PLACE A NOTIFIER MEETS THE HUB
// Two shapes meet here and nowhere else:
//   - the hub's own `Notifier` port (src/hub/delivery.ts): a function of a content-free
//     event request that resolves or throws, and a throw is the only failure signal it
//     has
//   - this product's notifier interface (./types.ts): a function of a *rendered*
//     request that resolves with an outcome carrying a reason
// `createPlatformNotifier` composes them into one function that takes the hub's request,
// plans it, and either delivers it or reports a refusal; `toNotifierPort` is the last
// step, and it is the only place a `failed` outcome becomes a throw. That is the whole
// of APX-FR-02's boundary: nothing here swallows an exit status, and nothing here turns
// a failure into a success.
//
// ONE GAP IN THE HUB'S VOCABULARY, NAMED RATHER THAN PAPERED OVER
// The hub's port has two answers: resolved means delivered, thrown means failed. This
// product has three outcomes, and the third is a *refusal* - an `fyi`, which NT-FR-02
// says never leaves the app. There is no way to say "answered correctly, nothing was
// sent" across a two-valued boundary, so the refusal resolves, and the delivery policy
// records that event as a delivered attempt. Nothing about the developer's experience is
// wrong - no toast appeared, no health verdict changed, no block was lost - but the
// `toast_deliveries` counter counts an fyi it should not, which distorts the
// notification-restraint figure PRD 11 is measured against.
//
// This is a contract gap in the hub's outcome vocabulary, not in this file, and the fix
// belongs to the hub owner: a `refused` member of `DeliveryOutcome` (counted as neither a
// delivery nor a failure), or a `refused` reason on the policy's existing
// `suppressed` outcome. It is deliberately not made here, because the delivery decision
// and the notifier port contract are hub-engineer's files (HC-5) and a second writer
// would be a second answer to the same question. Until that change lands, a refusal is
// counted, not hidden, and the fyi event is still in the dashboard where it belongs.

import { createLinuxNotifier, probeLinuxNotifier } from './linux.js'
import { planNotification } from './policy.js'
import {
  NotificationFailedError,
  type NotificationAvailability,
  type NotificationCommandRunner,
  type NotificationOutcome,
  type NotifyPlatform,
  type Notifier,
} from './types.js'
import type { NotificationRequest as HubNotificationRequest, Notifier as HubNotifier } from '../hub/delivery.js'

// ---------------------------------------------------------------------------
// The platforms
// ---------------------------------------------------------------------------

/**
 * The platforms agent-ping supports in v1 (APX-CON-06).
 *
 * All three, in every build: the *product* supports them. Which of them has a notifier in
 * this build is the next constant, and keeping the two apart is what lets a build say
 * "this platform is supported and its notifier is not written yet" rather than implying
 * agent-ping does not run there.
 */
export const NOTIFY_PLATFORMS = ['linux', 'macos', 'windows'] as const

/**
 * The platforms whose notifier exists in this build.
 *
 * One entry. NT-2 adds `macos` and `windows` to this array and the resolution below
 * gains a branch per platform; nothing else in this file, and nothing in the class
 * policy, changes when it does.
 */
export const IMPLEMENTED_NOTIFY_PLATFORMS = ['linux'] as const

/**
 * Why a notifier was chosen, or why there is none.
 *
 * `linux-notifier` names the implementation, so a diagnostic or a doctor line can say
 * what answered rather than only that something did. The other two are the explicit
 * answers this file must never replace with a throw.
 */
export type PlatformNotifierReason = 'linux-notifier'
export type MissingNotifierReason = 'not-implemented-for-this-platform' | 'unsupported-platform'

/**
 * Normalise Node's `process.platform` (or any caller-supplied string) to a platform.
 *
 * `process.platform` is a small closed set on the three platforms agent-ping supports, so
 * this is a three-way match with one honest fallback rather than a heuristic: anything
 * else, including the Cygwin and MSYS values a Windows Node build can report, is
 * `other` - which the registry reports as unsupported. Guessing there would mean
 * delivering a notification with a tool the product has never run.
 */
export function resolveNotifyPlatform(value: string | undefined): NotifyPlatform {
  switch (value?.trim().toLowerCase()) {
    case 'linux':
      return 'linux'
    case 'darwin':
      return 'macos'
    case 'win32':
      return 'windows'
    default:
      return 'other'
  }
}

// ---------------------------------------------------------------------------
// The resolution
// ---------------------------------------------------------------------------

/**
 * What the notifier for this machine is called.
 *
 * A discriminated union rather than an object with a nullable field, so `notifier` being
 * non-null and the reason being "no notifier" cannot both be true: the type says a
 * caller that has a notifier does not have to re-check the reason, and the two states
 * cannot drift apart the way a nullable field and a parallel flag can.
 */
export interface SupportedNotifier {
  readonly supported: true
  readonly platform: NotifyPlatform
  readonly reason: PlatformNotifierReason
  /**
   * The composed notifier: the hub's request in, an outcome out, and never a throw.
   *
   * Its own signature rather than the platform notifier's, because a caller should be
   * able to substitute a notifier in a test without reproducing the planning step.
   */
  readonly notifier: ComposedNotifier
  /** Reachability, for `install` and `doctor`. A probe never delivers a toast. */
  probe(): Promise<NotificationAvailability>
}

/** No notifier for this platform, and the reason there is none. */
export interface UnsupportedNotifier {
  readonly supported: false
  readonly platform: NotifyPlatform
  readonly reason: MissingNotifierReason
  readonly notifier: null
  probe(): Promise<NotificationAvailability>
}

export type NotifierResolution = SupportedNotifier | UnsupportedNotifier

/**
 * The notifier the composition root hands to the delivery policy.
 *
 * It takes the hub's own request - the closed six-field shape, a content-free event row
 * plus the repository's short name and the live origin (src/hub/delivery.ts) - and
 * resolves with the outcome. It never throws: the reason a delivery failed has to cross
 * the hub's boundary intact, and an exception would be the shape that loses it
 * (APX-FR-02).
 */
export type ComposedNotifier = (request: HubNotificationRequest) => Promise<NotificationOutcome>

export interface CreatePlatformNotifierOptions {
  /** Defaults to `process.platform`. A caller states its own platform in a test. */
  readonly platform?: string
  /** The command runner the platform notifier uses. Injected by tests. */
  readonly run?: NotificationCommandRunner
  /** Overrides the per-command bound. A test lowers it to watch a process be killed. */
  readonly timeoutMs?: number
  /**
   * Reports a diagnostic line, on a failure only.
   *
   * Never called with a title, a body, a session identifier or a path. A refusal is
   * deliberately *not* a line: `fyi` events are routine on a busy repository, and a
   * diagnostic per routine decision would bury the failures this product must never hide
   * (APX-FR-02).
   */
  readonly onDiagnostic?: (message: string) => void
}

/**
 * Build the notifier for a platform, or say why there is not one.
 *
 * Never throws, and never returns a notifier that is not wired to something real: a
 * caller can put the result straight into the delivery policy, and the hub's
 * `not-wired` state then means exactly "this platform has no notifier" (APX-FR-02).
 */
export function createPlatformNotifier(
  options: CreatePlatformNotifierOptions = {},
): NotifierResolution {
  const platform = resolveNotifyPlatform(options.platform ?? process.platform)
  if (platform === 'linux') {
    const deliver = createLinuxNotifier({
      ...(options.run === undefined ? {} : { run: options.run }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    })
    return {
      supported: true,
      platform,
      reason: 'linux-notifier',
      notifier: composeNotifier(platform, deliver),
      probe: (): Promise<NotificationAvailability> =>
        probeLinuxNotifier({
          ...(options.run === undefined ? {} : { run: options.run }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        }),
    }
  }
  const reason =
    platform === 'macos' || platform === 'windows'
      ? 'not-implemented-for-this-platform'
      : 'unsupported-platform'
  return {
    supported: false,
    platform,
    reason,
    notifier: null,
    probe: async (): Promise<NotificationAvailability> => ({ available: false, platform, reason }),
  }
}

/**
 * Plan, then deliver - the join between the class policy and a platform notifier.
 *
 * One direction, one order, for every platform: decide what the class is worth, and only
 * then ask a platform to make it. A refused plan has no request in it, so there is
 * nothing to hand a platform notifier and the refusal is structural rather than a branch
 * somebody has to remember (NT-FR-02). The platform notifier re-applies the same table
 * as a second gate, so a caller that hands one an `fyi` directly still cannot get it onto
 * a command line - and since both read the one table, there is no second policy to
 * drift (ADR-004).
 *
 * The hub's request is projected onto the four facts rendering needs - the class, the
 * repository's short name, the live origin and the session identifier - and nothing else.
 * The event row, the pending count and the source are the hub's own diagnostics, and
 * copying any of them into a request would put a record this product keeps one field away
 * from a command line (APX-FR-01).
 */
function composeNotifier(platform: NotifyPlatform, deliver: Notifier): ComposedNotifier {
  return async (request: HubNotificationRequest): Promise<NotificationOutcome> => {
    const plan = planNotification({
      class: request.class,
      repoShortName: request.repoShortName,
      origin: request.origin,
      sessionId: request.event.sessionId,
    })
    if (plan.kind === 'refuse') {
      return { status: 'refused', reason: plan.policy.reason, platform }
    }
    return deliver(plan.request)
  }
}

/**
 * The last step: an outcome-reporting notifier as the hub's notifier port.
 *
 * The hub's port can only be resolved (delivered) or thrown (failed), so this is where
 * the translation happens, and it is the only place that throws. A `refused` outcome
 * resolves, for the reason the header of this file gives at length: the hub has no third
 * answer, and a correct refusal must not be recorded as a failure, because a hub that
 * reported `degraded` for every routine `fyi` would be reporting a fault that did not
 * happen. The cost of that choice is one inflated counter, and it is named in the header
 * as a contract gap for the hub owner rather than worked around here.
 *
 * The error it throws carries the whole outcome, so the reason and the exit code are
 * available to whoever handles it rather than flattened into a message (APX-FR-02).
 */
export function toNotifierPort(
  notifier: ComposedNotifier,
  options: { readonly onDiagnostic?: (message: string) => void } = {},
): HubNotifier {
  const diagnostic = options.onDiagnostic ?? ((): void => {})
  return async (request: HubNotificationRequest): Promise<void> => {
    const outcome = await notifier(request)
    if (outcome.status === 'failed') {
      // The reason is the whole point of the boundary: the hub records a row key, a
      // closed token and a timestamp, and the exit code and the tool's own complaint
      // live in this error and in the diagnostic line beside it.
      diagnostic(
        `notify: a delivery failed (${outcome.reason}${
          outcome.exitCode === undefined || outcome.exitCode === null
            ? ''
            : `, exit ${String(outcome.exitCode)}`
        }); the event is stored, the block is still pending, and nothing was retried (APX-FR-02)`,
      )
      throw new NotificationFailedError(outcome)
    }
  }
}
