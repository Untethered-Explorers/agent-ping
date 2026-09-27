// The notifier's own vocabulary: what a delivery request carries, and what came of
// asking for one to be shown (NT-FR-01, NT-FR-09, ADR-004, ADR-010, ADR-012,
// APX-FR-02, APX-CON-04, APX-CON-12).
//
// WHAT THIS FILE IS
// Two closed vocabularies, one request shape, one outcome shape and one error. It
// renders nothing, decides nothing and reaches no desktop: the class policy that
// decides *whether* a card is made lives in ./policy.ts as a pure table, and the
// surface that shows it lives in ./registry.ts, which composes that table with a card
// (src/notify/surface/card.ts) and a host window (src/notify/surface/host.ts). What
// is here is the contract those two halves share, so the surface cannot invent a
// class, a reason or a field nothing else in the product knows about.
//
// THE SIX FIELDS A REQUEST CARRIES, AND WHY THOSE SIX (NT-FR-01)
//   class, title, body, urgency, deep link, lifetime
// The request is the *rendered* form of what the hub decided, not the stored event:
// the hub's own boundary (src/hub/delivery.ts) hands over a content-free event row,
// and turning that into words a person reads is this half of the product's job and
// nobody else's. `urgency` and `lifetime` are separate fields rather than one
// "loudness" number because they answer two different questions: urgency is how the
// card announces itself, and lifetime is how long it stays.
//
// `lifetime` is *this product's* word, and it replaces a platform hint rather than
// renaming one (ADR-012). `until-resolved` is what this product guarantees for a
// block - it leaves the screen when the harness resolves it or the developer
// acknowledges it, and not otherwise - and `expires` is a fixed interval this product
// chose rather than a request any desktop may honour or ignore. There is no
// `resident` here, because "resident" only ever described a hint, and a hint is not
// what a card this product draws does (ADR-012, NT-FR-08). The interval itself, and
// the fact that no cell can re-arm, belong to the lifetime table
// (src/notify/surface/lifetime.ts); this file names the vocabulary and nothing else.
//
// `deepLink` is a field here, and the surface carries it. The contract is
// `?session=<id>` on the loopback dashboard URL, published by src/hub/metrics.ts as
// DEEP_LINK_QUERY_KEY so the card, the tray and the counter cannot disagree
// (NT-FR-07). Unlike the version of this file that handed notifications to a
// platform's tool, a link on a card is not decorative: it is the same string
// src/hub/tray.ts resolves on a click, and a test compares the two rather than
// trusting them to agree.
//
// THREE OUTCOMES, AND WHY A REFUSAL IS NOT ONE OF THEM
// `delivered` means a card was shown. `failed` means it was not, with a reason that
// says which way: the window would not open, the card document was unavailable, the
// card could not be rendered. `refused` means the class policy declined the request
// before anything was shown - an `fyi` never leaves the app (NT-FR-02) - and a
// refusal is the policy working, not a fault. A record that conflated the last two
// would either alarm an operator about a correct decision or count a refusal as a
// card, and PRD 11 measures notification restraint with the delivery counter, so the
// two must stay apart. That separation is the defect ADR-012 names and NT-8 fixed: a
// refusal used to resolve through the hub's delivery port as though it had been
// delivered, so every fyi event counted as a notification nobody saw.
//
// EVERY REASON IS A CLOSED TOKEN
// The reason a delivery failed is part of what this product keeps and serves, so it
// cannot be an arbitrary string (APX-FR-01, ADR-010). Each token names a way the
// surface could not show a card, in this product's words: the host is not mounted,
// the desktop refused the window, the window is gone, the card document could not be
// read over the loopback hub, or the card could not be rendered. The reason *why* a
// desktop refused - a compositor, a session with no window manager - is one bounded
// line on the diagnostic callback, where an operator reads it and a record cannot
// carry it. There is no token here for a process that was started, one that exited
// non-zero, or one that was killed: nothing on this path starts a process (NT-FR-02,
// NT-FR-11).
//
// NO NOTIFICATION MECHANISM, NO SOUND, NO OUTBOUND CALL
// This file names none, and that is a property the suite asserts by reading the whole
// of src/notify rather than by believing a comment (NT-FR-11, APX-CON-04,
// APX-CON-12). A card is a document this product draws in a window it owns; there is
// no notification service, no notification centre, no permission request and no
// spawned command anywhere on the path that reaches a developer's attention.
//
// VERIFICATION STATE, STATED THE SAME WAY IN EVERY FILE HERE
// Implemented and unit-tested. NOT live-verified on the authoring machine: this was
// built on Linux, no card has been observed on any desktop from this checkout, and
// no claim about macOS or Windows window behaviour is made from here (NT-FR-03,
// APX-CON-06). docs/runbooks/notification-surface.md says the same, and NT-9 owns
// the observation.

import type { EventClass } from '../storage/eventStore.js'

/**
 * The loudness class, which is the stored event's own class.
 *
 * Re-used rather than restated: the classifier decides one of three classes
 * (src/domain/classify.ts) and a second union here would be a second class vocabulary
 * to keep in step. Aliasing `EventClass` also means a fourth class is a compile error
 * in the policy table rather than an unreviewed branch (ADR-004).
 */
export type NotificationClass = EventClass

/**
 * How urgent a card announces itself, as this product means it.
 *
 * Three closed levels, and the middle one is the default rather than a platform's
 * idea of a default: `critical` is a block somebody is waiting on, `normal` is a turn
 * that ended, and `low` exists for totality - no class currently delivers at it,
 * because an `fyi` is refused before it can be rendered at all. The values are closed
 * because the class table's cell names one of them and the card maps each to an icon
 * and a word (APX-CON-07, PRD 16 Open Question 2).
 */
export type NotificationUrgency = 'low' | 'normal' | 'critical'

/**
 * How long this product keeps a card up.
 *
 * `until-resolved` for a block: it stays until the harness resolves it or the
 * developer acknowledges it, and there is no interval that can take it away while it
 * is still a block. `expires` for a turn that ended, on one fixed interval this
 * product chose. `never-rendered` is not a member of *this* union: a class that
 * renders nothing has no request to carry a lifetime, because the refused plan
 * carries no request at all (NT-FR-02, ADR-012). The table that owns the interval
 * and the ends is src/notify/surface/lifetime.ts, and a test asserts the two tables
 * agree cell by cell rather than leaving them to drift.
 */
export type NotificationLifetime = 'until-resolved' | 'expires'

/**
 * One delivery request: NT-FR-01's request, rendered.
 *
 * Six fields, closed, and asserted field by field in tests/notify/policy.test.ts. The
 * title and the body are the only free text here, and they are built from a
 * repository short name the durable log already holds plus one sentence from a closed
 * table - never from a prompt, a tool name, a diff, a transcript or a full path
 * (APX-FR-01, ADR-003, ADR-008). There is no `command`, no `file`, no `args` and no
 * `exitCode` field, and no such field can be added without a review that would have
 * to explain what process it starts (NT-FR-02, NT-FR-11).
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
  readonly lifetime: NotificationLifetime
}

/**
 * What became of one request.
 *
 * `delivered` is the only status that means a person was shown something. `refused`
 * is the class policy declining, which is a correct outcome and not a gap.
 * `failed` is a gap, and it is the status that must be visible in `doctor`'s output
 * rather than only in a log line (NT-FR-09, APX-FR-02, ADR-010).
 */
export type NotificationOutcomeStatus = 'delivered' | 'refused' | 'failed'

/**
 * Why, as closed tokens in this product's own words.
 *
 * Every one of them names something about *the surface* - a window, a document, a
 * card - rather than a process, an exit status or a platform's persistence hint. The
 * two that are not failures are the two that are not gaps: a card was shown, or the
 * class policy declined to show one.
 */
export type NotificationOutcomeReason =
  | 'shown-as-a-card'
  | 'refused-in-app-only'
  | 'surface-not-mounted'
  | 'window-refused'
  | 'window-destroyed'
  | 'document-unavailable'
  | 'card-not-rendered'

/**
 * Every reason each status can carry, as data.
 *
 * Total over the two unions, so an outcome is always explainable and a new status or
 * reason is a compile error in this table rather than an unexplained value in a
 * ledger. The `failed` row is a subset of the surface host's own availability reasons
 * plus the one failure that is not about the window at all - a card that could not be
 * rendered into it - and ./registry.ts holds the total table that maps one to the
 * other, so the mapping is enumerated by a test rather than written out at a call
 * site.
 */
export const NOTIFICATION_OUTCOME_REASONS: Readonly<
  Record<NotificationOutcomeStatus, readonly NotificationOutcomeReason[]>
> = {
  delivered: ['shown-as-a-card'],
  refused: ['refused-in-app-only'],
  failed: [
    'surface-not-mounted',
    'window-refused',
    'window-destroyed',
    'document-unavailable',
    'card-not-rendered',
  ],
}

/**
 * The answer for one request. Never an exception, and never a bare boolean.
 *
 * Three fields and no more: what happened, why, and one bounded line of detail when
 * there is something to say. There is no `command` to inspect and no `exitCode` to
 * interpret, because nothing on this path starts a process - a delivery that could not
 * be inspected was a delivery to a platform's tool, and there is no longer one
 * (ADR-012, NT-FR-11). `detail` is the one field that can hold text from outside, so
 * it is bounded to a single short line and it exists for the diagnostic callback, not
 * for a record. Nothing in this product's durable state reads it (APX-FR-01,
 * APX-CON-12).
 */
export interface NotificationOutcome {
  readonly status: NotificationOutcomeStatus
  readonly reason: NotificationOutcomeReason
  /** One bounded line, when there is something to say. Diagnostics only. */
  readonly detail?: string
}

/**
 * The notifier behind NT-FR-01: a rendered request in, an outcome out.
 *
 * A function rather than an interface, for the reason the delivery policy's port is
 * one too (src/hub/delivery.ts): there is one caller and one operation. It may
 * return a promise; it must not throw, because the boundary that turns a `failed`
 * outcome into the hub's failure record - and a `refused` one into the hub's
 * suppression - is the composition root's adapter, and a notifier that threw past it
 * would be a notifier that had already lost the reason.
 */
export type Notifier = (request: NotificationRequest) => Promise<NotificationOutcome>

/**
 * The name this product answers to on a developer's screen and in its own fallback
 * title.
 *
 * One constant, because it is one product: the card's fallback title is this name
 * (src/notify/policy.ts) and the tray's tooltip is built from the same pending set.
 */
export const NOTIFICATION_APP_NAME = 'agent-ping'

/**
 * A delivery that did not happen, as a rejection the delivery policy can record.
 *
 * Thrown by the composition root's adapter (./registry.ts) and by nothing else, and
 * only for `failed`: the policy's own vocabulary is resolve-means-delivered and
 * throw-means-failed, so an outcome is the only way a reason can cross the boundary
 * intact. The message names the status, the reason and the surface's own state, and
 * quotes nothing from the card.
 */
export class NotificationFailedError extends Error {
  readonly outcome: NotificationOutcome

  constructor(outcome: NotificationOutcome) {
    super(
      `the card was not shown (${outcome.status}/${outcome.reason}). The block is stored and still ` +
        'pending, and the developer was not told: this is recorded rather than reported as delivered ' +
        '(APX-FR-02, NT-FR-09).',
    )
    this.name = 'NotificationFailedError'
    this.outcome = outcome
  }
}
