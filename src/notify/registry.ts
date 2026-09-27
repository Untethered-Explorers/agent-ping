// The surface notifier: the one delivery path, from the hub's request to a card in a
// window this product owns (NT-FR-01, NT-FR-02, NT-FR-03, NT-FR-04, NT-FR-09,
// NT-FR-11, ADR-004, ADR-010, ADR-012, APX-CON-04, APX-CON-12, APX-FR-02).
//
// WHAT THIS FILE IS, AND WHAT IT REPLACED
// One construction that composes the class policy (./policy.ts), a card
// (./surface/card.ts) and a host window (./surface/host.ts) into a single notifier,
// and the one adapter that carries its outcome across the hub's delivery boundary.
// It replaces a registry that chose between three platform notifiers, each of which
// started a process: one that built a notification-server command line, one that
// called a notification centre, and one that raised a system toast. ADR-012 withdrew
// all three, and this file is what took their place, so there is now exactly one
// delivery path in the product and exactly one set of claims to prove (NT-FR-03,
// NT-FR-11).
//
// WHY THERE IS NO PLATFORM HERE
// Nothing in this file names an operating system, and a test asserts that rather than
// trusting the sentence. What differs between Linux, macOS and Windows is
// window-manager behaviour - transparency, stacking, placement - and none of that is a
// decision this product makes: the host places the card from the display's *work area*
// (./surface/position.ts) and every desktop's own compositor draws it. A per-platform
// branch would be the start of the second and third delivery path ADR-012 deleted, and
// a claim about macOS or Windows made from a Linux machine would be a claim nobody had
// observed (NT-FR-03, APX-CON-06).
//
// WHAT A CARD IS, IN THIS PRODUCT'S TERMS
//   needs-you  a card that stays until the harness resolves the block or the developer
//              acknowledges it, and is never re-armed
//   finished   a card that expires on one fixed interval
//   fyi        no card at all: the plan is refused before a model exists
// The lifetime vocabulary is `until-resolved` and `expires` rather than a platform's
// `resident` hint, because this product now decides it rather than asking (ADR-012),
// and the interval and the ends belong to the lifetime table
// (./surface/lifetime.ts) rather than to this file. There is no timer here: the only
// clock in the surface path is the one interval that table names, armed by the card
// view (NT-FR-08).
//
// THE TWO THINGS A CARD NEEDS, AND WHY BOTH ARE REQUIRED
//   host       a window to draw in: probe, show, hide, click-through, destroy
//   present    a way to put the card *into* it
// The first is NT-6's host interface, which knows about placement and nothing about
// content. The second is this file's own seam, `CardPresenter`, and it is not
// optional: a window with nothing in it is a transparent rectangle on a developer's
// screen, and reporting that as a delivered card would be the exact lie APX-FR-02
// forbids. A caller that has a host and no presenter is told so by the composition
// root and wires no notifier at all - the same `not-wired` posture the tray already
// takes for a desktop that cannot mount an icon (NT-FR-04).
//
// THE ORDER OF THE TWO HALVES, AND WHY IT IS THIS ORDER
// The host is asked to show the window first, then the card is presented into it. The
// host loads the card document on the first show and awaits it, so presenting first
// would be presenting into a document that has not run its entry point yet - a race
// that shows a stale card or none at all. Showing first also means the document is
// loaded from the hub's *live* origin, which is only knowable after the socket is
// bound (HC-FR-01). If the card then cannot be rendered, the window is hidden again:
// a card that could not be drawn must leave no rectangle behind (NT-FR-10).
//
// THE BOUNDARY, AND THE ONE PLACE A NOTIFIER MEETS THE HUB
// Two shapes meet here and nowhere else:
//   - the hub's own `Notifier` port (src/hub/delivery.ts): a function of a content-free
//     event request that resolves, throws, or throws the typed suppression
//   - this product's notifier interface (./types.ts): a function of a *rendered*
//     request that resolves with an outcome carrying a reason
// `createSurfaceNotifier` composes the first into the second by planning, building a
// card and asking the surface to show it; `toNotifierPort` is the last step, and it is
// the only place an outcome becomes a throw. It is also the only place a *refusal*
// becomes the hub's typed suppression rather than a delivered notification, which is
// the defect ADR-012 names and NT-FR-09 requires fixed (APX-FR-02, ADR-010).
//
// NO SOUND, NO TELEMETRY, NO PLATFORM NOTIFICATION
// Nothing here plays anything, starts a process, or contacts any host but 127.0.0.1.
// There is no sound field to set, no command to build, no network call to make, and no
// notification permission to request, because there is no service to ask (APX-CON-04,
// APX-CON-12, NT-FR-02, NT-FR-11).
//
// VERIFICATION STATE, STATED THE SAME WAY IN EVERY FILE HERE
// Implemented and unit-tested against a host that is this product's own interface. NOT
// live-verified on the authoring machine: no card has been observed on any desktop
// from this checkout, and no claim about macOS or Windows window behaviour is made
// from here. docs/runbooks/notification-surface.md says the same, and NT-9 owns the
// observation (NT-FR-03, APX-CON-06).

import { buildCardModel, type CardModel } from './surface/card.js'
import { cardLifetimeFor, rendersCard, type CardLifetimeCell } from './surface/lifetime.js'
import type {
  NotificationSurfaceHost,
  SurfaceAvailability,
  SurfaceAvailabilityReason,
} from './surface/host.js'
import { planNotification } from './policy.js'
import {
  NotificationFailedError,
  type NotificationOutcome,
  type NotificationOutcomeReason,
} from './types.js'
import type { NotificationRequest as HubNotificationRequest, Notifier as HubNotifier } from '../hub/delivery.js'
import { DeliverySuppressedError } from '../hub/delivery.js'

// ---------------------------------------------------------------------------
// The card presenter
// ---------------------------------------------------------------------------

/**
 * Renders one card into the surface.
 *
 * The seam between "this product decided what the card says" (./surface/card.ts, a pure
 * function) and "something can put that card in a document" - which is the card
 * document NT-7 built the view for, and which this module deliberately does not know
 * about. One method, because one is all a delivery needs: a card is shown, and how it
 * leaves the screen is the card view's own business, driven by the lifetime cell this
 * file hands it (NT-FR-08, NT-FR-10).
 *
 * It must not throw for a card it can render: a failure here is a delivery this
 * product did not make, and it is reported as `card-not-rendered` with a diagnostic
 * rather than escaping into the hub (APX-FR-02). It may return a promise, and the
 * notifier awaits it, so a presenter that renders asynchronously is still reported
 * honestly rather than optimistically.
 */
export interface CardPresenter {
  present(model: CardModel, cell: CardLifetimeCell): Promise<void> | void
}

// ---------------------------------------------------------------------------
// The notifier
// ---------------------------------------------------------------------------

/**
 * The notifier the composition root hands to the delivery policy.
 *
 * It takes the hub's own request - the closed six-field shape, a content-free event row
 * plus the repository's short name and the live origin (src/hub/delivery.ts) - and
 * resolves with the outcome. It never throws: the reason a delivery failed has to
 * cross the hub's boundary intact, and an exception would be the shape that loses it
 * (APX-FR-02).
 */
export type SurfaceNotifier = (request: HubNotificationRequest) => Promise<NotificationOutcome>

export interface CreateSurfaceNotifierOptions {
  /** The window a card is drawn in. Probe, show, hide, click-through, destroy. */
  readonly host: NotificationSurfaceHost
  /** How a card is put into that window. Required: a window alone is not a card. */
  readonly present: CardPresenter
  /**
   * Reports a diagnostic line, on a failure only.
   *
   * Never called with a title, a body, a session identifier or a path. A refusal is
   * deliberately *not* a line: `fyi` events are routine on a busy repository, and a
   * diagnostic per routine decision would bury the failures this product must never
   * hide (APX-FR-02).
   */
  readonly onDiagnostic?: (message: string) => void
}

/**
 * Every availability the host can report, and the outcome reason each one carries.
 *
 * Total over `SurfaceAvailabilityReason`, which is what makes this a table rather than
 * a chain of conditionals: a new host reason is a compile error here, and `null` says
 * "the surface is available", which is the only row that is not a failure. A test
 * enumerates both unions and compares them, so the host and this file cannot disagree
 * about what a refusal is called (NT-FR-09, ADR-010).
 */
export const SURFACE_OUTCOME_REASONS: Readonly<
  Record<SurfaceAvailabilityReason, NotificationOutcomeReason | null>
> = Object.freeze({
  available: null,
  'not-mounted': 'surface-not-mounted',
  'window-refused': 'window-refused',
  'window-destroyed': 'window-destroyed',
  'document-unavailable': 'document-unavailable',
})

/** The reason an outcome carries for a surface that would not show a card. */
export function surfaceOutcomeReason(availability: {
  readonly available: boolean
  readonly reason: SurfaceAvailabilityReason
}): NotificationOutcomeReason {
  const mapped = SURFACE_OUTCOME_REASONS[availability.reason]
  if (mapped === null || availability.available) {
    throw new Error(
      `the surface reported itself available (${availability.reason}) and this call is the one ` +
        'that handles a refusal. SURFACE_OUTCOME_REASONS must map every unavailability to a reason ' +
        'and only the available row to null (NT-FR-09).',
    )
  }
  return mapped
}

/**
 * Build the one notifier this product has.
 *
 * One order, for every platform and every class: decide what the class is worth, build
 * the card if there is one to build, show the window, render the card into it. A
 * refused plan has no request and no model, so there is nothing to render and nothing
 * to hand a host - the refusal is structural rather than a branch somebody has to
 * remember, and it is the reason an `fyi` cannot produce a card even if this notifier
 * is handed one directly (NT-FR-02, ADR-004).
 *
 * Never throws: every way this can fail resolves as a `failed` outcome carrying the
 * host's own reason, because a throw here would be caught one layer up as an opaque
 * failure with the reason lost (APX-FR-02, ADR-010).
 *
 * The hub's request is projected onto the four facts rendering needs - the class, the
 * repository's short name, the live origin and the session identifier - and nothing
 * else. The event row, the pending count and the source are the hub's own diagnostics,
 * and copying any of them into a card would put a record this product keeps one field
 * away from a developer's screen (APX-FR-01).
 */
export function createSurfaceNotifier(options: CreateSurfaceNotifierOptions): SurfaceNotifier {
  const diagnostic = options.onDiagnostic ?? ((): void => {})
  const host = options.host
  const renderCard = options.present
  return async (request: HubNotificationRequest): Promise<NotificationOutcome> => {
    const plan = planNotification({
      class: request.class,
      repoShortName: request.repoShortName,
      origin: request.origin,
      sessionId: request.event.sessionId,
    })
    // The fyi refusal, and the whole of "in-app only". No card model, no window, no
    // present call, and no diagnostic: a correct decision is not a fault (NT-FR-02).
    if (plan.kind === 'refuse') {
      return { status: 'refused', reason: plan.policy.reason }
    }
    const cell = cardLifetimeFor(plan.request.class)
    if (!rendersCard(cell)) {
      // Unreachable through `planNotification`, because a cell that renders nothing is
      // the cell a refused class has. It is checked rather than assumed: a lifetime
      // table that grew a delivered cell with `rendered: false` would otherwise show a
      // window with an empty card in it, and this is the one place that can stop it.
      const detail = 'the class policy delivered a class whose card is never rendered'
      reportSurfaceFailure(diagnostic, 'card-not-rendered', detail)
      return failed('card-not-rendered', detail)
    }
    let model: CardModel | null
    try {
      model = buildCardModel(plan, request.pendingCount)
    } catch (cause) {
      // A card this product cannot honestly render - a repository path, a count that is
      // not a count - is a failure with its reason, not a card with something odd on
      // it. The detail is a product error message, never the card's own text
      // (APX-FR-01, APX-FR-02).
      const detail = detailOf(cause)
      reportSurfaceFailure(diagnostic, 'card-not-rendered', detail)
      return failed('card-not-rendered', detail)
    }
    if (model === null) return failed('card-not-rendered', 'the delivery plan carried no card to render')

    // The window first, because showing it is what loads the card document from the
    // hub's live origin, and a card presented into a document that has not loaded would
    // be a race (see the header).
    let shown: { readonly available: boolean; readonly reason: SurfaceAvailabilityReason; readonly detail?: string }
    try {
      shown = await host.show()
    } catch (cause) {
      // A host is built not to throw, so a throw is a wiring fault rather than a
      // desktop refusal - and it is reported with its reason rather than escaping
      // (ADR-010).
      const detail = detailOf(cause)
      reportSurfaceFailure(diagnostic, 'window-refused', detail)
      return failed('window-refused', detail)
    }
    if (!shown.available) {
      const reason = surfaceOutcomeReason(shown)
      reportSurfaceFailure(diagnostic, reason, shown.detail)
      return failed(reason, shown.detail)
    }

    try {
      await renderCard.present(model, cell)
    } catch (cause) {
      // The window is up and there is nothing in it, so it goes back down before the
      // failure is reported: an empty rectangle is not a card, and NT-FR-10's promise
      // is that nothing occupies screen space when nothing is showing. The line is the
      // other half of APX-FR-02: a card this product could not draw is never a fact
      // that exists only in a ledger.
      const detail = detailOf(cause)
      hideQuietly(host, diagnostic)
      reportSurfaceFailure(diagnostic, 'card-not-rendered', detail)
      return failed('card-not-rendered', detail)
    }
    return { status: 'delivered', reason: 'shown-as-a-card' }
  }
}

/**
 * A `failed` outcome, built in one place so `detail` is always a named field.
 *
 * A detail is a bounded line of this product's own error text, never the card's own
 * text: an outcome is a record this product keeps and serves, and it cannot carry
 * anything a developer typed (APX-FR-01, ADR-010).
 */
function failed(reason: NotificationOutcomeReason, detail?: string): NotificationOutcome {
  return detail === undefined || detail === ''
    ? { status: 'failed', reason }
    : { status: 'failed', reason, detail }
}

/**
 * The sentence beside a surface failure. Never the card's own text.
 *
 * "The event is stored and the pending set is unchanged" rather than "the block is still
 * pending", because a card can be a finished turn: what is true for every failed card is
 * that nothing was lost and the developer's pending set is exactly what it was
 * (APX-FR-02, ADR-010).
 */
function reportSurfaceFailure(
  diagnostic: (message: string) => void,
  reason: NotificationOutcomeReason,
  detail: string | undefined,
): void {
  diagnostic(
    `notify: a card could not be shown (${reason}${
      detail === undefined || detail === '' ? '' : `, ${detail}`
    }); the event is stored, the pending set is unchanged, no window is left showing anything, and ` +
      'nothing was retried (NT-FR-04, NT-FR-10, APX-FR-02)',
  )
}

/** Take the window down after a card could not be rendered, and say so if it cannot. */
function hideQuietly(
  host: CreateSurfaceNotifierOptions['host'],
  diagnostic: (message: string) => void,
): void {
  try {
    host.hide()
  } catch (cause) {
    diagnostic(
      `notify: the card could not be rendered and the window could not be taken down either (${detailOf(
        cause,
      )}); a card surface is a topmost window, so this run may leave an empty rectangle on the ` +
        'screen (NT-FR-10, APX-FR-02)',
    )
  }
}

/** A bounded detail line, from this product's own error text and nothing else. */
function detailOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * The last step: an outcome-reporting notifier as the hub's notifier port.
 *
 * The hub's port can express "resolved" (delivered), "thrown" (failed) and - since
 * NT-8 - one typed throw for a decision rather than a fault. This is where the
 * translation happens, and it is the only place that throws.
 *
 * A `failed` outcome throws `NotificationFailedError`, carrying the whole outcome, so
 * the reason is available to whoever handles it rather than flattened into a message,
 * and a line goes to the diagnostic callback beside it (APX-FR-02, ADR-010).
 *
 * A `refused` outcome throws `DeliverySuppressedError`, the hub's own type for "this
 * delivery was declined on purpose". The policy records that as `suppressed` with the
 * reason `class-refused`: not a delivery, not a failure, not a health verdict, and
 * definitely not an increment of the delivery counter PRD 11 measures notification
 * restraint with. This is the defect the platform registry documented and never fixed,
 * and fixing it is the reason this adapter has three branches instead of two
 * (NT-FR-09, ADR-012, APX-FR-02).
 */
export function toNotifierPort(
  notifier: SurfaceNotifier,
  options: { readonly onDiagnostic?: (message: string) => void } = {},
): HubNotifier {
  const diagnostic = options.onDiagnostic ?? ((): void => {})
  return async (request: HubNotificationRequest): Promise<void> => {
    const result = await notifier(request)
    if (result.status === 'failed') {
      diagnostic(
        `notify: a card was not shown (${result.reason}${
          result.detail === undefined ? '' : `, ${result.detail}`
        }); the event is stored, the block is still pending, and nothing was retried (APX-FR-02)`,
      )
      throw new NotificationFailedError(result)
    }
    if (result.status === 'refused') {
      // No diagnostic line: `fyi` events are routine, and a line per routine decision
      // would bury the failures above. The suppression itself is recorded by the policy.
      throw new DeliverySuppressedError(result.reason)
    }
  }
}

// ---------------------------------------------------------------------------
// The resolution the composition root is handed
// ---------------------------------------------------------------------------

/** Why the notifier for this run is not wired, as a closed token an operator can read. */
export type SurfaceUnavailableReason =
  /** No desktop bridge, so there is no window to draw in. A headless run. */
  | 'no-surface'
  /** A window exists but this run has no way to render a card into it. */
  | 'no-card-renderer'
  /** The desktop refused the window. NT-FR-04's degraded-but-serving run. */
  | 'window-refused'

/** One notifier, and what it is. */
export interface SupportedSurfaceNotifier {
  readonly supported: true
  readonly reason: 'surface-notifier'
  readonly notifier: SurfaceNotifier
  /**
   * Whether a card can be shown right now, for `install` and `doctor` (IO-2, NT-FR-09).
   *
   * A probe reports; it never shows a card, and it never reports a tool as installed -
   * there is no tool, and the question "can a window be created" is a different
   * question from "is anything installed" (APX-FR-02).
   */
  probe(): Promise<SurfaceAvailability>
}

/** No notifier for this run, and the reason there is none. */
export interface UnsupportedSurfaceNotifier {
  readonly supported: false
  readonly reason: SurfaceUnavailableReason
  readonly notifier: null
  probe(): Promise<SurfaceAvailability>
}

export type SurfaceNotifierResolution = SupportedSurfaceNotifier | UnsupportedSurfaceNotifier

/**
 * The surface notifier, or the reason this run has none.
 *
 * Three answers rather than a throw, because the caller is a hub that must start and
 * keep serving on a machine with no window, and a health payload and a `doctor` line
 * have to be able to say *which* of the three situations it was (APX-FR-02, NT-FR-04).
 * A hub that cannot draw a card is degraded in a way an operator has to be told about,
 * and the honest way to tell it is `not-wired` rather than a failure and rather than a
 * stub that claims a card was shown.
 *
 * A *headless* run - no surface at all, which is every test, `agent-ping status` and
 * every verification script - is `no-surface`. A run with a window but no card renderer
 * is `no-card-renderer`, and it is a different fault with a different fix: the window
 * exists and something has to be put in it. A refused window is NT-FR-04's own case.
 */
export function resolveSurfaceNotifier(input: {
  readonly host: NotificationSurfaceHost | null
  readonly present: CardPresenter | null
  readonly refused: boolean
  readonly onDiagnostic?: (message: string) => void
}): SurfaceNotifierResolution {
  const diagnostic = input.onDiagnostic ?? ((): void => {})
  if (input.refused) {
    diagnostic(
      'agent-ping could not create its notification surface window, so this run can show no card. ' +
        'The pending set, the log and the tray badge are unaffected, and every delivery is recorded ' +
        'as not-wired rather than as a card somebody saw (NT-FR-04, APX-FR-02).',
    )
    return {
      supported: false,
      reason: 'window-refused',
      notifier: null,
      probe: (): Promise<SurfaceAvailability> => unavailable('window-refused'),
    }
  }
  const host = input.host
  if (host === null) {
    return {
      supported: false,
      reason: 'no-surface',
      notifier: null,
      probe: (): Promise<SurfaceAvailability> => unavailable('not-mounted'),
    }
  }
  const present = input.present
  if (present === null) {
    diagnostic(
      'agent-ping has a window for its notification card but no way to render one into it, so every ' +
        'delivery is recorded as not-wired and no card leaves this machine. A window with nothing in ' +
        'it is not a card (NT-FR-01, APX-FR-02).',
    )
    return {
      supported: false,
      reason: 'no-card-renderer',
      notifier: null,
      probe: (): Promise<SurfaceAvailability> => unavailable('not-mounted'),
    }
  }
  return {
    supported: true,
    reason: 'surface-notifier',
    notifier: createSurfaceNotifier({ host, present, onDiagnostic: diagnostic }),
    probe: (): Promise<SurfaceAvailability> => host.probe(),
  }
}

/**
 * A probe answer for a run with no surface, and the one honest reason for it.
 *
 * `not-mounted` rather than a platform's answer because "a host was never mounted" is
 * the truth on a headless run, and inventing a reason per platform is exactly the
 * vocabulary NT-FR-11 withdrew.
 */
function unavailable(reason: SurfaceAvailabilityReason): Promise<SurfaceAvailability> {
  return Promise.resolve({ available: false, reason })
}
