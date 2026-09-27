// The card's dismissal: the two ends the hub can produce, and the one place that decides
// a card on the screen has finished (NT-FR-02, NT-FR-08, NT-FR-10, NT-FR-12, ADR-004,
// ADR-010, ADR-012, APX-FR-01, APX-FR-02).
//
// WHAT THIS FILE IS
// `./lifetime.ts` already names the five ways a card leaves the screen, and
// `./card-view.ts` already removes one on any of them. Two of those five were produced
// by nobody: `acknowledged`, when a developer answers a block, and `resolved`, when the
// harness reports the block settled. A needs-you card therefore stayed on the screen
// until the host window was destroyed at shutdown - correct at shutdown, and not correct
// in the middle of a run. This file is the missing producer for exactly those two.
//
// WHY IT IS A PORT AND NOT A ROUTE
// Neither trigger is a request. The first is a consequence of the ack route's one
// transition, which is already the product's only control surface (APX-CON-08): the card
// goes down because the block was acknowledged, not because a new path was registered.
// The second is a harness fact arriving as an ordinary ingested event - a class the
// policy refuses, so no card is built and no delivery is attempted (NT-FR-02) - which
// the pending lifecycle turns into a resolution. Adding a route to watch either of them
// would make a card's disappearance something a client could ask for, and this product's
// surface is closed rather than filtered (ADR-002).
//
// THE RULE, AND WHY IT IS THREE CHECKS
//   1. something is showing               - otherwise this is a no-op, not an error
//   2. it is showing for *this* session   - a block somebody else is waiting on must not
//                                           take this developer's card off the screen
//   3. this end is one the card's own lifetime cell names - the table, not this file,
//                                           decides what may end a card, and a finished
//                                           card's only end is `expired` (NT-FR-08)
// All three are the same statement the card view would make if it could see a row: the
// surface holds one card, for one session, under one cell, and only that cell's own ends
// take it away.
//
// WHAT IT DOES NOT DO
// It records no counter, reads no row, writes no row, and returns nothing. The four
// local counters belong to `src/hub/metrics.ts` alone, which is asserted to be the only
// caller of a counter write in the product, and a dismissal that moved one would make a
// card leaving the screen a fact in PRD 11's table - a change to a measurement rather
// than to a screen. Nothing here can reach a harness, a session or a command either: the
// whole of its effect is one call on the surface and one on the host's own `hide`.
//
// NO SOUND, NO NETWORK, NO PLATFORM
// Nothing in this file opens a socket, spawns a process, or reaches a notification
// service. Its only vocabulary is this product's own: a session identifier, a lifetime
// cell and a closed end token (APX-CON-04, APX-CON-12, NT-FR-02, NT-FR-11).

import type { CardEnd, CardLifetimeCell } from './lifetime.js'

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * The two ends this path produces.
 *
 * `acknowledged` and `resolved` are the two the hub can cause, and they are the two the
 * needs-you cell names besides nothing else - `expired` belongs to the finished cell,
 * and `replaced` and `destroyed` are this product's own reasons about the surface rather
 * than about a block (./lifetime.ts). Enumerated rather than narrowed from `CardEnd` so
 * that "these are the only two" is a value a test reads instead of a sentence, and so
 * that a caller handed this port cannot reach the other three at all.
 */
export const CARD_DISMISSAL_ENDS = ['acknowledged', 'resolved'] as const

/** One of `CARD_DISMISSAL_ENDS`. */
export type CardDismissalEnd = (typeof CARD_DISMISSAL_ENDS)[number]

/**
 * The live-state frame kind that means "a resolution cleared a pending item".
 *
 * The store wrapper publishes it when `markResolved` was applied, and nothing else
 * publishes it (src/hub/sse.ts). Named here rather than inlined at the call site so the
 * coupling to the hub's frame vocabulary is one token a reviewer can grep for, and so
 * the reason the dismissal is wired to the feed - rather than to a route - is visible
 * where the decision is.
 */
export const CARD_RESOLUTION_TRANSITION = 'block-resolved'

// ---------------------------------------------------------------------------
// The port a route is handed
// ---------------------------------------------------------------------------

/**
 * What the hub is given: take one session's card off the screen, naming the end.
 *
 * One method, two arguments, both closed vocabulary, and nothing returned. It is a
 * request to *stop showing* something, so it cannot change a record, cannot be aimed at
 * a harness and cannot be told to do anything else (APX-CON-08). Declared as its own
 * interface rather than as the whole dismissal so a route cannot reach the two members
 * that are the composition root's own wiring.
 */
export interface CardDismissalPort {
  /**
   * Take the card for one session off the screen.
   *
   * Never throws and never reports a boolean: a session with no card showing, a card
   * showing for a different session, and an end the card's own cell does not name are
   * all *no-ops*, because in each of those three cases there is nothing on the screen
   * that this call would have changed and a caller with a fault to report has a
   * different route to report it on. What it is not is silent about a fault: a removal
   * that itself failed is reported on the diagnostic callback, because a card that
   * could not be taken down is a real fact about a developer's screen (NT-FR-10,
   * APX-FR-02).
   */
  dismiss(sessionId: string, end: CardDismissalEnd): void
}

/**
 * The whole dismissal, as the composition root holds it.
 *
 * The port above plus the two seams the composition root feeds and nothing else: the
 * card that is currently on the screen (`shown`), and the live transitions that can end
 * it without a route (`watch`).
 */
export interface CardDismissal extends CardDismissalPort {
  /**
   * The card now on the screen, and the cell it is shown under.
   *
   * Called from the one place a session and a card meet, which is the moment a delivery
   * reports a card was shown - not from a route, and not from the document. The cell is
   * the table's own frozen cell for the class that was delivered, read with
   * `cardLifetimeFor`, because the table rather than this file is what decides which
   * ends may take a card away.
   */
  shown(sessionId: string, cell: CardLifetimeCell): void
  /** Which session the card on the screen belongs to, or null when none is showing. */
  showingFor(): string | null
  /**
   * Follow the pending set, so a resolution takes the card down with no route involved.
   *
   * The subscription is one line per published frame and does no work at all for a frame
   * that is not a resolution - a card appearing, a card being acknowledged or a heartbeat
   * are all somebody else's business. On a run with no card renderer it subscribes to
   * nothing at all, because no card can be showing there and a resolution frame could not
   * be acted on: an internal subscriber that can never fire would spend a slot of the
   * budget the stream route spends on dashboards (HC-FR-03).
   *
   * The hub's own feed drops its subscribers when it closes, so this cannot outlive the
   * run; there is no handle to keep and nothing to tear down in the ordered shutdown.
   */
  watch(source: CardTransitions): () => void
}

// ---------------------------------------------------------------------------
// The seams
// ---------------------------------------------------------------------------

/**
 * Removes a card from the document and takes the window down.
 *
 * One function, and it is the *whole* of a dismissal's effect. The main process's half
 * of the card channel implements it: it sends the removal through the channel - so the
 * document's own view removes its own element under its own lifetime cell - and then
 * calls the host's own `hide`, which is what keeps NT-FR-10's promise that nothing
 * occupies screen space once nothing is showing. A surface with no card renderer has no
 * channel and therefore no card to remove, which is why `remove` may be null.
 */
export type CardRemover = (end: CardEnd) => void

export interface CreateCardDismissalOptions {
  /**
   * The channel's removal, or null for a run that cannot show a card at all.
   *
   * Null rather than a stub: a headless run, a run whose window was refused and a run
   * with a window and no renderer all have no card on a screen, and a dismissal built
   * over a function that pretends otherwise would be able to report a removal this
   * product never made (APX-FR-02).
   */
  readonly remove: CardRemover | null
  /** One bounded line when a removal failed. Never called with a card's own text. */
  readonly onDiagnostic?: (message: string) => void
}

/**
 * One live-state transition, as this module reads it.
 *
 * The two fields the decision needs and no more: what kind of transition it was, and the
 * session it happened in. A structural reader rather than the hub's own `StateChange` so
 * that nothing under `src/notify` imports a hub type, and so the test can hand it a
 * value it invented - including one that is not a transition at all.
 */
export interface CardTransition {
  readonly kind: string
  readonly event: { readonly sessionId: string }
}

/** Where those transitions come from: the hub's live state feed, behind one method. */
export interface CardTransitions {
  subscribe(listener: (transition: CardTransition) => void): () => void
}

/**
 * Whether a published frame's payload is a transition this module can act on.
 *
 * A guard rather than a cast, because the value crossed from the hub's feed and the
 * feed publishes exactly one shape on a change frame - but "exactly one shape" is a fact
 * about `publish`, and this is where a value nobody checked would otherwise be read as
 * though somebody had. Two fields, a string and a string, and nothing else is asked of
 * it (APX-FR-01).
 */
export function isCardTransition(value: unknown): value is CardTransition {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { kind?: unknown; event?: unknown }
  if (typeof record.kind !== 'string') return false
  if (typeof record.event !== 'object' || record.event === null) return false
  return typeof (record.event as { sessionId?: unknown }).sessionId === 'string'
}

// ---------------------------------------------------------------------------
// The dismissal
// ---------------------------------------------------------------------------

/**
 * Build the one dismissal in this product.
 *
 * Holds one fact: which session the card on the screen belongs to, and under which
 * cell. That is the whole of its state, and it is state rather than a cache because a
 * card that was never rendered is not a card somebody needs taken down - there is
 * nothing on the screen, and NT-FR-10 is satisfied by the absence rather than by a
 * dismissal.
 */
export function createCardDismissal(options: CreateCardDismissalOptions): CardDismissal {
  const diagnostic = options.onDiagnostic ?? ((): void => {})
  const remove = options.remove
  let showing: { readonly sessionId: string; readonly cell: CardLifetimeCell } | null = null

  const dismiss = (sessionId: string, end: CardDismissalEnd): void => {
    // Narrowed into a local rather than checked at the point of use: this is a closure
    // and the `remove` it closes over is a `let` the checker cannot narrow into it. On
    // this path there is nothing showing either - `shown` refused to record one - so the
    // two refusals say the same thing: a run with no card renderer has no card to take
    // down.
    const take = remove
    if (take === null) return
    const card = showing
    // No-op, not an error, in all three of these cases - and the check is the whole
    // rule, so it is written out rather than folded into one condition somebody could
    // weaken by accident.
    if (card === null) return
    if (card.sessionId !== sessionId) return
    // The table decides what may end a card, and the cell it decides it with is the
    // one the card was shown under: a finished card's only end is `expired`, so a
    // resolution of some other block in the same session cannot take it away.
    if (!card.cell.ends.includes(end)) return
    // Cleared before the removal rather than after it, so a re-entrant call from
    // inside the removal finds nothing showing and cannot remove the same card twice.
    // The cost is that a removal which *fails* leaves the surface as it was, and that
    // is reported below rather than papered over: the next card replaces this one, and
    // the window still comes down at shutdown.
    showing = null
    try {
      take(end)
    } catch (cause) {
      diagnostic(
        `notify: a card could not be taken off the screen (${end}): ${
          cause instanceof Error ? cause.message : String(cause)
        }. The block is no longer pending, so nothing is lost and nothing was retried, and a ` +
          'transparent window may stay on the screen until the next card replaces it or the hub ' +
          'stops (NT-FR-10, APX-FR-02)',
      )
    }
  }

  return {
    shown: (sessionId: string, cell: CardLifetimeCell): void => {
      // Nothing to remember on a run that cannot show a card: with no channel there is
      // no document to remove anything from, and a record here would be a fact about a
      // card that was never drawn.
      if (remove === null) return
      showing = { sessionId, cell }
    },

    showingFor: (): string | null => showing?.sessionId ?? null,

    dismiss,

    /**
     * Follow the pending set, so a resolution takes the card down with no route involved.
     *
     * The rule that makes this safe on a headless run lives here rather than at the call
     * site, and it is the interface's rule rather than this implementation's: with no
     * removal there is no card and no frame that could end one, so a subscription would
     * be a consumer of the feed's client budget (which the stream route spends on
     * dashboards) for nothing (HC-FR-03, src/hub/sse.ts).
     */
    watch: (source: CardTransitions): (() => void) => {
      if (remove === null) return (): void => undefined
      return source.subscribe((transition): void => {
        // One frame kind, and it is the one the store publishes when a harness
        // resolution cleared a pending item. Everything else - an event stored, an
        // acknowledgement this module was already told about, a heartbeat - is somebody
        // else's business, and acting on one would be polling with extra steps
        // (src/hub/sse.ts).
        if (transition.kind !== CARD_RESOLUTION_TRANSITION) return
        dismiss(transition.event.sessionId, 'resolved')
      })
    },
  }
}
