// The class policy, as pure code: what one class is worth and what a toast says
// (NT-FR-01, NT-FR-02, NT-FR-08, NT-FR-09, ADR-004, ADR-010, APX-CON-04, APX-FR-01).
//
// THIS IS THE ONLY CLASS TABLE IN THE PRODUCT
// src/domain/classify.ts decides *which* class a harness signal is, and this file
// decides what that class is worth once it has been decided. Nothing else may branch on
// class to decide loudness, and the delivery policy in src/hub/delivery.ts says so in
// its own header: it decides whether a delivery is attempted and what came of it, and
// it deliberately does not know the three classes, because a second class table would be
// the second thing to drift. So the two files divide the question: the classifier says
// "this is a block", this file says "a block is a resident critical toast, an fyi is
// nothing at all".
//
// THREE CLASSES, THREE ANSWERS, AND ONE OF THEM IS "NO"
//   needs-you  deliver, critical, resident   a block somebody is waiting on
//   finished   deliver, normal,  expires    a turn that ended
//   fyi        refuse                        it never leaves the app
//
// The fyi refusal is the whole of "in-app only" (NT-FR-02). It is a *refusal* rather
// than a silent no-op for the reason ADR-004 exists: an fyi that is dropped on the floor
// is indistinguishable from an fyi that was misclassified, and a developer who cannot
// tell those apart stops trusting the toasts they do get. So the refusal is a decided,
// named outcome, the notifier reports it, and nothing is spawned. What the developer
// sees for an fyi is the dashboard, which is where fyi events live.
//
// A RESIDENT REQUEST IS A REQUEST, AND NOTHING HERE RE-FIRES IT
// `persistence: 'resident'` is what this product asks libnotify for (PRD 16 Open
// Question 2); whether the installed notification server honours it is NT-4's human gate
// to confirm on a real desktop, and it is not assumed anywhere in this repository. The
// tempting way to make a resident toast reliable is a timer that re-fires it, and
// NT-FR-08 forbids that outright - one needs-you toast per block, with the badge and the
// history carrying persistence instead of a repeat. There is no timer in this file, and
// there is no way to add one without editing a table that a test enumerates.
//
// NOTHING HERE HAS A MOUTH
// The two strings a person reads are built from a repository short name the durable log
// already holds (ADR-008) and one sentence from the table below. No prompt, no tool
// name, no diff, no transcript, no absolute path, no session identifier and no count
// reach a toast (APX-FR-01, and the feature's own UI rule: two lines, the repository
// name and one sentence, no counts and no stack of text). The deep link is the fourth
// thing this file builds and it is *not* one of the two lines: it is a field on the
// request for the platforms whose tools can act on it, and the badge plus the dashboard
// are how a Linux developer gets to a block (PRD 16 Open Question 3).
//
// NO SOUND, ON ANY CLASS
// There is no sound field, no sound flag and no sound-capable argument anywhere on this
// path, because sound in v1 is forbidden (APX-CON-04) and a vocabulary field is the
// cheapest place to make that structural rather than a matter of remembering. The
// remaining possibility is the desktop's own notification sound, which is a user setting
// outside this process; NT-4's live gate observes it, and this file cannot.
//
// PURITY
// No database, no clock, no subprocess, no I/O, no randomness, no module-level state,
// synchronous. The two inputs that vary - the repository short name and the live origin -
// are arguments, so planning a notification is deterministic and a test can assert the
// whole table without a desktop, a socket or a notifier. Nothing here opens a socket or
// spawns a process, and no value produced here is sent anywhere (APX-CON-12).

import { DEEP_LINK_QUERY_KEY } from '../hub/metrics.js'
import type { NotificationClass, NotificationRequest, NotificationUrgency, NotificationPersistence } from './types.js'
import { NOTIFICATION_APP_NAME } from './types.js'

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * What a `needs-you` or a `finished` class is delivered as.
 *
 * The body is in the cell rather than looked up separately, so the sentence a class is
 * delivered with cannot drift from the cell that decides to deliver it - the two would be
 * two tables, and two tables is the failure this file exists to prevent.
 */
export interface NotificationDeliverPolicy {
  readonly kind: 'deliver'
  /** Why this cell delivers. Recorded in the outcome, closed token. */
  readonly reason: 'deliver-needs-you' | 'deliver-finished'
  readonly urgency: NotificationUrgency
  readonly persistence: NotificationPersistence
  /** The one sentence a person reads. No counts, no list, no identifier. */
  readonly body: string
}

/** What an `fyi` class is: nothing that leaves this process. */
export interface NotificationRefusePolicy {
  readonly kind: 'refuse'
  readonly reason: 'refused-in-app-only'
}

export type NotificationClassPolicy = NotificationDeliverPolicy | NotificationRefusePolicy

/**
 * The whole class policy, as data.
 *
 * Three cells, total over the class union - a fourth class is a compile error here
 * rather than an unreviewed branch, and a class the table does not carry throws rather
 * than defaulting (see `decideNotification`). A test enumerates this table rather than
 * restating it, so the properties that matter are asserted as properties: exactly one
 * class is refused, exactly one class is resident, and the refused one is `fyi`.
 *
 * The wording of each sentence is a product decision about what a developer reads at
 * the moment they are interrupted, and it is deliberately quiet: it names the kind of
 * block and nothing else, because the deep link, the dashboard and the badge carry the
 * specifics. "A decision from you" rather than a permission name, because a permission
 * name would be harness vocabulary leaking into a toast.
 */
export const CLASS_POLICIES: Readonly<Record<NotificationClass, NotificationClassPolicy>> = {
  'needs-you': {
    kind: 'deliver',
    reason: 'deliver-needs-you',
    urgency: 'critical',
    persistence: 'resident',
    body: 'A session is blocked and needs a decision from you.',
  },
  finished: {
    kind: 'deliver',
    reason: 'deliver-finished',
    urgency: 'normal',
    persistence: 'expires',
    body: 'A session finished after working.',
  },
  fyi: {
    kind: 'refuse',
    reason: 'refused-in-app-only',
  },
}

/**
 * What this class is worth.
 *
 * Pure, synchronous, and total over the table. Throws for a class the table does not
 * carry: a default here would be a fourth way a notification could be made, which is
 * precisely the shape NT-FR-08 and ADR-004 are about.
 */
export function decideNotification(eventClass: NotificationClass): NotificationClassPolicy {
  const policy = CLASS_POLICIES[eventClass]
  if (policy === undefined) {
    throw new Error(
      `unhandled notification class: "${String(eventClass)}". CLASS_POLICIES must carry every class ` +
        'the classifier can produce, because a class with no cell is a class whose loudness nobody ' +
        'decided (ADR-004, NT-FR-02).',
    )
  }
  return policy
}

// ---------------------------------------------------------------------------
// The rendered request
// ---------------------------------------------------------------------------

/**
 * The title used when the repository short name could not be read.
 *
 * The hub reads the session row at attempt time and answers null when that read fails
 * (src/hub/delivery.ts), and a missing repository name is not a reason to withhold a
 * block from a developer. The product's own name is the honest fallback: it is what the
 * toast says when this product cannot say whose session it is.
 */
export const FALLBACK_TITLE = NOTIFICATION_APP_NAME

/**
 * The facts rendering needs, and nothing else.
 *
 * Deliberately not the hub's whole delivery request: a plan takes a class, a repository
 * short name, a live origin and a session identifier, so it can be built and asserted
 * without a store, a socket or an event row (and so that this file has no import from
 * the hub at all, keeping the direction of the dependency one-way).
 */
export interface NotificationPlanInput {
  readonly class: NotificationClass
  /** The repository's short name, or null when the session row could not be read. */
  readonly repoShortName: string | null
  /** The hub's live loopback origin, or '' before the socket is bound. */
  readonly origin: string
  /** The session this notification is about. Never rendered into the toast. */
  readonly sessionId: string
}

/**
 * A plan: a request to deliver, or a decision not to.
 *
 * The refused plan carries no request at all, which is what makes "an fyi never reaches
 * a platform notifier" a structural property rather than a branch somebody has to
 * remember: there is nothing to pass onwards, so a platform notifier cannot be called
 * with one even by accident.
 */
export type NotificationPlan =
  | { readonly kind: 'deliver'; readonly policy: NotificationDeliverPolicy; readonly request: NotificationRequest }
  | { readonly kind: 'refuse'; readonly policy: NotificationRefusePolicy }

/**
 * Decide, and render only if the decision is to deliver.
 *
 * The whole of this module's behaviour in one call: `fyi` in, a refusal out, and no
 * title or body rendered for it. A delivered plan's request carries exactly the six
 * fields NT-FR-01 names, in a fixed order, from the table and the two inputs.
 */
export function planNotification(input: NotificationPlanInput): NotificationPlan {
  const policy = decideNotification(input.class)
  if (policy.kind === 'refuse') return { kind: 'refuse', policy }
  return {
    kind: 'deliver',
    policy,
    request: {
      class: input.class,
      title: renderTitle(input.repoShortName),
      body: policy.body,
      urgency: policy.urgency,
      deepLink: deepLinkFor(input.origin, input.sessionId),
      persistence: policy.persistence,
    },
  }
}

/**
 * The one line that names whose session this is.
 *
 * The short name, trimmed, and never a full path: a path would put a developer's home
 * directory on their screen and in a screenshot of it (APX-FR-01, ADR-008). A
 * repository whose short name is only whitespace falls back to the product's name rather
 * than rendering a blank title.
 */
export function renderTitle(repoShortName: string | null): string {
  const trimmed = repoShortName?.trim() ?? ''
  return trimmed === '' ? FALLBACK_TITLE : trimmed
}

/**
 * The deep link for one session, or null when there is nothing to link to.
 *
 * `?session=<id>` on the dashboard URL, and the parameter name is imported from the file
 * that counts it rather than spelled here: src/hub/metrics.ts publishes
 * DEEP_LINK_QUERY_KEY precisely so the notifier that builds the link, the dashboard that
 * resolves it and the counter that observes it cannot disagree (NT-FR-07, HC-6, LD-3).
 *
 * Null before the socket is bound. A link built from a port that was only a preference
 * would send a developer to whatever else on this machine answers there, which is the
 * one thing a loopback sidecar must never do (APX-CON-01, HC-FR-01). The target is
 * percent-encoded, and its *value* is never read, stored or served by the hub that
 * receives it (APX-FR-01).
 */
export function deepLinkFor(origin: string, sessionId: string): string | null {
  const trimmedOrigin = origin.trim().replace(/\/+$/, '')
  if (trimmedOrigin === '') return null
  const query = new URLSearchParams([[DEEP_LINK_QUERY_KEY, sessionId]])
  return `${trimmedOrigin}/?${query.toString()}`
}
