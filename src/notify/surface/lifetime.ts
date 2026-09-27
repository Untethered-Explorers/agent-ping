// The card's lifetime, as this product's own policy: one cell per class, no repeat
// arm, one fixed interval (NT-FR-02, NT-FR-08, NT-FR-10, ADR-004, ADR-012, APX-CON-04).
//
// WHY THIS FILE HAS NO TIMER
// A notification service used to negotiate persistence with the desktop, and the
// tempting way to make a resident card reliable is a timer that re-fires it. NT-FR-08
// forbids that outright: one needs-you card is shown per block, and the badge and the
// history carry persistence instead of a repeat. So this file holds *data* - frozen
// cells of strings, numbers and arrays - and nothing that can be called. There is no
// place in a cell to hide a callback, a `setInterval` or a re-arm, which is why
// "the needs-you cell contains no re-arming timer" is a structural property here
// rather than a promise a test has to take on trust: the test walks every cell and
// asserts no value in it is a function.
//
//   class       rendered   lifetime           ends                       interval
//   needs-you   yes        until-resolved     resolved, acknowledged     none
//   finished    yes        expires            expired                    5000 ms
//   fyi         no         never-rendered     none                       none
//
// THE THREE CELLS
//   needs-you   A block somebody is waiting on. It leaves the screen when the item is
//               resolved by the harness or acknowledged by the developer, and not
//               otherwise. There is no interval, so there is nothing to re-arm and
//               nothing that can time the block out while it is still a block.
//   finished    A turn that ended. It expires on one fixed interval, because the answer
//               to "how long has a card that has already said what it says stayed up" is
//               a number, not a negotiation, and because a finished card that never went
//               away would be a second thing on the screen nobody asked for.
//   fyi         Never rendered. It does not leave the app, so there is no card to give a
//               lifetime, and `rendered: false` with an empty `ends` list means a caller
//               that ignores the refusal has nothing to remove either.
//
// WHAT IS NOT IN A CELL
// No handler, no timer, no priority, no sound, no "escalate after", no "re-notify in".
// `repeat` is a closed one-value token on every cell - `'never'` - so a fourth class, or
// an edit to this table, cannot introduce a re-arm without changing the type, and the
// type is what a reviewer reads.
//
// WHY THE TIMER LIVES BEHIND A SEAM INSTEAD OF IN THIS FILE
// `armCardExpiry` is the only function here that can start a clock, it takes a cell as
// an argument rather than a class, and it arms nothing at all for a cell with no
// interval. So the needs-you path cannot reach a timer even by mistake: the function
// that owns timing has nothing to arm. The scheduler is an argument, which is what lets
// a test drive a real expiry with a clock it controls instead of sleeping (NT-FR-08,
// ADR-012).
//
// THE ENDS, AND WHO PRODUCES THEM
// `resolved` and `acknowledged` arrive from the hub; `expired` is produced here by the
// one interval that exists; `replaced` and `destroyed` are this product's own reasons -
// a second card took the surface, and the host window is going away. They are closed
// tokens rather than free text because a card's disappearance is recorded in a delivery
// outcome, and a record cannot carry an arbitrary string (APX-FR-01, ADR-010).
//
// NO SOUND, NO NETWORK, NO PLATFORM
// Nothing in this file can open a socket, spawn a process, reach a notification service
// or make a noise. The only vocabulary is this product's own: a class, an interval and
// a reason (APX-CON-04, APX-CON-12, NT-FR-02, NT-FR-11).

import type { NotificationClass } from '../types.js'

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * How long one card stays, in this product's words.
 *
 * `until-resolved` and `expires` are the two the surface renders; ADR-012 names them
 * explicitly as the replacement for a platform's `resident`/`expires` hint, chosen
 * because they describe what this product guarantees rather than what a desktop may
 * honour. `never-rendered` is the third cell and it renders nothing at all.
 */
export type CardLifetime = 'until-resolved' | 'expires' | 'never-rendered'

/**
 * Every way a card can leave the screen.
 *
 * Enumerated rather than described, because the two cells that render a card have to
 * differ in exactly which of these can end it, and a test asserts the difference
 * without restating either cell. `replaced` and `destroyed` are here so a card's
 * disappearance always has a name: a card removed for no stated reason is a card
 * somebody has to guess about.
 */
export const CARD_ENDS = ['resolved', 'acknowledged', 'expired', 'replaced', 'destroyed'] as const

/** One of `CARD_ENDS`. */
export type CardEnd = (typeof CARD_ENDS)[number]

/**
 * One cell of the lifetime policy.
 *
 * Data only. Every field is a string, a number, a boolean or an array of strings, and
 * the table is frozen, so there is nowhere for behaviour to hide - no callback, no
 * closure, no interval that re-arms itself. `tests/notify/surface-lifetime.test.ts`
 * walks every value of every cell and asserts none of them is callable, which is how
 * the no-repeat-timer rule is enforced rather than asserted in prose.
 */
export interface CardLifetimeCell {
  /** The class this cell is about, restated so a mismatched lookup is visible. */
  readonly class: NotificationClass
  /** Whether a card is rendered for this class at all. False for exactly one cell. */
  readonly rendered: boolean
  readonly lifetime: CardLifetime
  /**
   * The fixed interval, in milliseconds, for a cell that expires.
   *
   * `null` for the two cells that do not expire. A cell with a number here is the only
   * thing in this product that can start a clock, and `armCardExpiry` is the only
   * function that reads it.
   */
  readonly expiresInMs: number | null
  /** The ends that take this card off the screen. Empty when nothing is rendered. */
  readonly ends: readonly CardEnd[]
  /**
   * Whether this cell can ever re-arm. One value, on every cell.
   *
   * The type admits only `'never'`, so adding a re-arm is a change to this type and not
   * a value somebody can type into a table (NT-FR-08).
   */
  readonly repeat: 'never'
  /** Recorded with a delivery outcome, closed token. Never a free sentence. */
  readonly reason: 'held-until-resolved' | 'expiring-on-a-fixed-interval' | 'never-rendered-in-app-only'
}

/**
 * How long a finished card stays up.
 *
 * A number, chosen rather than negotiated, and asserted by a test that it is a fixed
 * positive integer rather than "however long the desktop felt like". Long enough that
 * the sentence is readable at a glance, short enough that a card about a turn that ended
 * never becomes a second rectangle on the developer's screen. The value here is a
 * product decision no document states; what the documents do state is that the interval
 * is fixed, that exactly one cell has one, and that no cell re-arms.
 */
export const FINISHED_CARD_EXPIRES_IN_MS = 5_000

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * The whole lifetime policy, as data.
 *
 * Three cells, total over the class union - a fourth class is a compile error here
 * rather than an unreviewed branch - and `cardLifetimeFor` throws for a class this table
 * does not carry rather than defaulting, because a default would be a fourth way a card
 * could live (ADR-004, NT-FR-08).
 *
 * Frozen all the way down so a caller cannot edit a cell at run time and then claim the
 * table says otherwise.
 */
export const CARD_LIFETIMES: Readonly<Record<NotificationClass, Readonly<CardLifetimeCell>>> = Object.freeze({
  'needs-you': Object.freeze({
    class: 'needs-you',
    rendered: true,
    lifetime: 'until-resolved',
    expiresInMs: null,
    ends: Object.freeze(['resolved', 'acknowledged'] as const),
    repeat: 'never',
    reason: 'held-until-resolved',
  }),
  finished: Object.freeze({
    class: 'finished',
    rendered: true,
    lifetime: 'expires',
    expiresInMs: FINISHED_CARD_EXPIRES_IN_MS,
    ends: Object.freeze(['expired'] as const),
    repeat: 'never',
    reason: 'expiring-on-a-fixed-interval',
  }),
  fyi: Object.freeze({
    class: 'fyi',
    rendered: false,
    lifetime: 'never-rendered',
    expiresInMs: null,
    ends: Object.freeze([] as const),
    repeat: 'never',
    reason: 'never-rendered-in-app-only',
  }),
})

/**
 * How long this class's card lives.
 *
 * Pure, synchronous, and total over the table. Throws for a class the table does not
 * carry: a class with no cell is a class whose persistence nobody decided, and a default
 * would be a second way for a card to exist that the requirements do not describe.
 */
export function cardLifetimeFor(eventClass: NotificationClass): CardLifetimeCell {
  const cell = CARD_LIFETIMES[eventClass]
  if (cell === undefined) {
    throw new Error(
      `unhandled card lifetime class: "${String(eventClass)}". CARD_LIFETIMES must carry every class ` +
        'the classifier can produce, because a card whose lifetime is undecided is a card that either ' +
        'never goes away or goes away too soon (NT-FR-08, ADR-004).',
    )
  }
  return cell
}

/**
 * Whether a card is rendered for this cell.
 *
 * A named question rather than a `cell.rendered` read at three call sites, so "an fyi
 * never produces a card" is one decided answer with one test rather than a property
 * three code paths happen to share.
 */
export function rendersCard(cell: CardLifetimeCell): boolean {
  return cell.rendered && cell.ends.length > 0
}

// ---------------------------------------------------------------------------
// The one clock
// ---------------------------------------------------------------------------

/** A started timer, in the shape this module needs and no more. */
export interface CardTimer {
  cancel(): void
}

/**
 * Where a timer comes from.
 *
 * An argument, never `window` or `globalThis.setTimeout` read directly, so the expiry
 * can be driven by a clock a test controls. Production passes the default below.
 */
export interface CardExpiryScheduler {
  schedule(delayMs: number, onElapsed: () => void): CardTimer
}

/**
 * The clock this product uses when nothing else is supplied.
 *
 * Both environment timers, not a renderer API: the card document is a web page, and a
 * page that has to reach a window object to expire a card could not be tested at all.
 * Nothing here repeats - one schedule, one cancel.
 */
export const timerCardScheduler: CardExpiryScheduler = Object.freeze({
  schedule: (delayMs: number, onElapsed: () => void): CardTimer => {
    let handle: ReturnType<typeof setTimeout> | undefined = setTimeout(onElapsed, delayMs)
    return {
      cancel: (): void => {
        if (handle === undefined) return
        clearTimeout(handle)
        handle = undefined
      },
    }
  },
})

/** What a caller gets back from `armCardExpiry`, so a cancel is possible and visible. */
export interface CardExpiryArm {
  /** True only when a clock was actually started. */
  readonly armed: boolean
  /** Stop the expiry. Idempotent, and it cannot be un-cancelled. */
  cancel(): void
}

/**
 * Start this cell's expiry - if it has one.
 *
 * The only function in the surface path that can start a clock, and it takes a *cell*
 * rather than a class so a caller cannot ask for a needs-you expiry by naming a
 * duration: a cell with no interval arms nothing and reports `armed: false`. That is
 * what makes "the needs-you cell contains no re-arming timer" true of the code and not
 * only of the table.
 *
 * `onExpired` fires at most once, and not at all after a cancel even if the scheduler
 * misbehaves and runs a cancelled timer anyway - a removed card being re-removed is the
 * shape of a bug nobody would find, so the handle closes the door itself.
 */
export function armCardExpiry(
  cell: CardLifetimeCell,
  scheduler: CardExpiryScheduler,
  onExpired: () => void,
): CardExpiryArm {
  const interval = cell.expiresInMs
  if (interval === null) {
    return { armed: false, cancel: (): void => undefined }
  }
  let cancelled = false
  const timer = scheduler.schedule(interval, () => {
    if (cancelled) return
    cancelled = true
    onExpired()
  })
  return {
    armed: true,
    cancel: (): void => {
      if (cancelled) return
      cancelled = true
      timer.cancel()
    },
  }
}
