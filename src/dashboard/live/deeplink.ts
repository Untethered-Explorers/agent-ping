// Deep links: `?session=<id>` on this page's own URL resolves to one row, focuses
// it, and keeps that focus across later live updates (LD-FR-06, NT-FR-07, NT-FR-08,
// ADR-004, ADR-012).
//
// WHAT THE LINK IS
// A query parameter and not a path or a fragment, because the hub has to be able to
// see it: a fragment is never sent to a server, so `#session/x` would be a request
// the hub could not count, and the deep-link counter (PRD 11) is a measurement of
// this exact event. `DEEP_LINK_QUERY_KEY` is the value src/hub/metrics.ts publishes
// as `DEEP_LINK_QUERY_KEY`; the card (src/notify/surface/card.ts), the tray
// (src/hub/tray.ts) and this file all read the same literal so a link that opens
// from a card and a link that opens from the tray resolve to the same row.
// notification-engineer guarantees the link resolves to a session; this file is the
// half that makes it land on a row rather than merely opening the page, and it is
// the only focus mechanism on the page - the notification surface does not build a
// second one.
//
// THE THREE STATES, AND WHY A MISSING SESSION IS ONE OF THEM
// A link can name a session the page does not have, and the honest answer is a
// sentence rather than silence:
//
//   `none`      the URL carried no target. The most common open.
//   `waiting`   the URL named one and the hub has not answered yet. Saying "gone" here
//               would be a lie for the first frame of every deep link, and the page
//               renders before the hub does.
//   `focused`   the row exists. It is focused, revealed and carried by identity.
//   `missing`   the hub has answered and the row is not there. The sentence says so -
//               docs/features/live-dashboard.md §8 Open Question 3 settled this as an
//               explicit row rather than silently focusing nothing.
//
// THE FOCUS SURVIVES AN UPDATE, AND WHEN IT DELIBERATELY DOES NOT
// Focus is held as the session identifier, and the mirror restores DOM focus by that
// identifier on every rebuild, so an update that re-renders the list under the focused
// row does not lose it. What is left for this file is the case the mirror cannot see:
// a rebuild that leaves focus nowhere (a mirror that emptied and refilled around the
// row), and the canvas growing so the focused row has moved.
//
// It re-asserts focus only while the page's focus is nowhere in the row list. A
// developer who has arrowed to a different row keeps their own choice: a deep link
// that yanks focus back on every frame would make the list unusable, which is a worse
// failure than a focus that moved on purpose.

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * The query parameter a deep link carries.
 *
 * The literal is the one src/hub/metrics.ts exports as `DEEP_LINK_QUERY_KEY`, and it
 * is restated rather than imported because that module reaches the store and the
 * change feed, which have no place in a browser bundle. tests/dashboard/
 * live-interactions.test.ts asserts the two literals are the same, so a rename on
 * either side fails there instead of leaving every card's link focusing nothing.
 */
export const DEEP_LINK_QUERY_KEY = 'session'

/**
 * How long a target may be before the page stops looking for it.
 *
 * A bound, not a validation: the hub stores a UUID, so anything longer than this is
 * not a session this page could hold, and copying an arbitrarily long string out of a
 * URL into a comparison is an unbounded read driven by a URL (APX-CON-12). The value
 * is used only for that comparison and is never logged, stored or sent anywhere.
 */
export const DEEP_LINK_TARGET_MAX_LENGTH = 200

/**
 * Read the session a link names, or null when the URL named none.
 *
 * The value is returned as the URL carried it, because a developer who pasted a
 * wrong link should get the "not on the page" sentence rather than a silent no-op,
 * and because trimming it here would mean the page looked for a session the link
 * never named. A value longer than the bound is refused outright - there is no row
 * it could be.
 */
export function readDeepLinkTarget(search: string | undefined): string | null {
  if (search === undefined) return null
  const raw = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get(
    DEEP_LINK_QUERY_KEY,
  )
  if (raw === null) return null
  const value = raw.trim()
  if (value.length === 0 || value.length > DEEP_LINK_TARGET_MAX_LENGTH) return null
  return value
}

// ---------------------------------------------------------------------------
// The states
// ---------------------------------------------------------------------------

export type DeepLinkStatus = 'none' | 'waiting' | 'focused' | 'missing'

/** What the page knows about the link it was opened with. */
export interface DeepLinkState {
  /** The session the link named, or null when it named none. */
  readonly target: string | null
  readonly status: DeepLinkStatus
  /** What the page prints. Null for `none` and for `focused`, which the row itself shows. */
  readonly sentence: string | null
}

/**
 * What the page says, in its own words, for every status that has something to say.
 *
 * Two sentences and a null, closed, so no status can be added without a sentence -
 * and a status with no sentence would be a status the page could enter silently,
 * which is the one outcome this file exists to prevent.
 */
export const DEEP_LINK_SENTENCE: Readonly<Record<Exclude<DeepLinkStatus, 'none' | 'focused'>, string>> =
  Object.freeze({
    waiting: 'Looking for the session this link named…',
    missing:
      'The session this link named is not on the page. It may have finished, been removed, or ' +
      'never have been here.',
  })

export const INITIAL_DEEP_LINK_STATE: DeepLinkState = Object.freeze({
  target: null,
  status: 'none',
  sentence: null,
})

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

export interface CreateDeepLinkControllerOptions {
  /** The page's query string. Defaults to the page's own location. */
  readonly search?: string
  /** Whether the hub has answered at all. False is `waiting`, never `missing`. */
  readonly hasRead: () => boolean
  /** Whether the page's rows currently include this session. */
  readonly hasRow: (sessionId: string) => boolean
  /**
   * Focus the row and bring it into view.
   *
   * One function, because focusing and revealing are the same act from a person's
   * point of view: a row that has focus above the fold is not a row they can see.
   */
  readonly focus: (sessionId: string) => void
  /** Whether the page's focus is inside the row list right now. */
  readonly isFocusInList: () => boolean
  /** Called whenever the state changes. */
  readonly onState?: (state: DeepLinkState) => void
}

export interface DeepLinkController {
  /**
   * Re-resolve the link against the page as it is now. Called after every applied
   * state, so this is what carries the focus across a live update.
   */
  resolve(): void
  readonly state: DeepLinkState
  readonly isDestroyed: boolean
  destroy(): void
}

export function createDeepLinkController(
  options: CreateDeepLinkControllerOptions,
): DeepLinkController {
  const search = options.search ?? globalThis.location?.search
  const target = readDeepLinkTarget(search)
  let state: DeepLinkState = INITIAL_DEEP_LINK_STATE
  let destroyed = false

  const publish = (next: DeepLinkState): void => {
    if (
      next.status === state.status &&
      next.target === state.target &&
      next.sentence === state.sentence
    ) {
      return
    }
    state = next
    options.onState?.(next)
  }

  const resolve = (): void => {
    if (destroyed) return
    if (target === null) {
      publish(INITIAL_DEEP_LINK_STATE)
      return
    }
    if (!options.hasRead()) {
      // Before the hub's first answer there is no "not there" to report, and a page
      // that rendered for the first frame as a dead link would be a page that says
      // every deep link is broken.
      publish({ target, status: 'waiting', sentence: DEEP_LINK_SENTENCE.waiting })
      return
    }
    if (!options.hasRow(target)) {
      publish({ target, status: 'missing', sentence: DEEP_LINK_SENTENCE.missing })
      return
    }
    // Re-assert only while focus is nowhere in the list. A rebuild that dropped focus
    // to the body is the case this exists for; a developer who moved to another row
    // has answered the question this link asked, and taking it back would be hostile.
    if (!options.isFocusInList()) options.focus(target)
    publish({ target, status: 'focused', sentence: null })
  }

  return {
    resolve,
    get state(): DeepLinkState {
      return state
    },
    get isDestroyed(): boolean {
      return destroyed
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
    },
  }
}
