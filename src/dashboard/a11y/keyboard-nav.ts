// Keyboard traversal and activation over the DOM mirror (DP-FR-04, APX-CON-07).
//
// The mirror gives every row a focusable element; this decides where focus goes
// next and what activating a row means. Three decisions are baked in and each one
// has a failure mode worth naming:
//
//   - Traversal follows the mirror's document order, which is the canvas's order.
//     Nothing here sorts, so the two cannot disagree about what "next" is.
//   - Tab leaves the list. Only the arrows, Home, End, Enter and Space are
//     handled, and a list of thirty tab stops is unusable in practice. The
//     roving tabindex keeps the list one tab stop, and it follows focus, so a
//     re-render cannot make the list unreachable by Tab.
//   - Activation is reported, not implied: an entry is marked in the DOM, the
//     activation is counted, and the surface is told through a callback. In this
//     prototype the callback records the row; in the live page it is where
//     acknowledgement and deep-link focus hang off. The count is held here and the
//     mark is re-applied by identity on every rebuild, so a row that has been
//     activated still is after the feed has replaced the elements.
//
// ONE THING THE LIVE FEED CHANGED
// A static list of rows is rendered once, so the entries read at construction are
// the entries that exist forever. A live feed replaces them under this controller:
// every state change that changes what a row says rebuilds the mirror, and the
// element that was the third row a moment ago is no longer in the document.
// `focusIndex` therefore refuses to work from a detached node - focusing one
// silently does nothing, which a person experiences as the keyboard having stopped
// working - and re-reads the list once instead. Traversal locates the focused row in
// the list as it is now, for the same reason: an unannounced rebuild moves a row's
// position, and a controller that remembered the old one would send a developer
// arrowing down the list back to the top of it. This is what makes
// `navigator.focusSession` usable straight after a hub frame, which is how
// LD-FR-06's deep link lands on its row.
//
// The activation mark is the same problem in a different place. A count read back off
// an element is a count the next rebuild forgets, so the counts are held here by
// session identifier and re-applied to whichever element now holds that row.

import type { MotionController } from '../theme/motion'
import {
  MIRROR_ACTIVATIONS_ATTRIBUTE,
  MIRROR_ACTIVATED_CLASS,
  MIRROR_FOCUSED_ATTRIBUTE,
  MIRROR_FOCUSED_CLASS,
  MIRROR_ROW_ATTRIBUTE,
  MIRROR_ROW_SELECTOR,
} from './dom-mirror'

/** The key that moves focus, and where it moves it. */
export const NAVIGATION_KEYS: Readonly<Record<string, NavigationAction>> = Object.freeze({
  ArrowDown: 'next',
  ArrowRight: 'next',
  ArrowUp: 'previous',
  ArrowLeft: 'previous',
  Home: 'first',
  End: 'last',
})

/** The keys that activate the focused row. `Spacebar` is the legacy IE/Edge spelling. */
export const ACTIVATION_KEYS: readonly string[] = Object.freeze(['Enter', ' ', 'Spacebar'])

export type NavigationAction = 'next' | 'previous' | 'first' | 'last'

export interface ActivationDetail {
  /** The key that activated the row, or 'programmatic'. */
  readonly key: string
  /** How many times this row has been activated, including this one. */
  readonly count: number
}

export interface KeyboardNavigator {
  /** The row entries, in visual order. */
  readonly entries: readonly HTMLElement[]
  readonly focusedSessionId: string | null
  readonly focusedEntry: HTMLElement | null
  readonly activatedSessionId: string | null
  /** The most recent activation, or null if there has been none. */
  readonly lastActivation: ActivationDetail & { readonly sessionId: string } | null
  focusIndex(index: number): HTMLElement | null
  focusNext(): HTMLElement | null
  focusPrevious(): HTMLElement | null
  focusFirst(): HTMLElement | null
  focusLast(): HTMLElement | null
  focusSession(sessionId: string): HTMLElement | null
  /** Activate a row by identifier, defaulting to the focused one. */
  activate(sessionId?: string, key?: string): boolean
  /** Re-read the entries after a rebuild and re-apply the focus marks. */
  refresh(): void
  readonly isDestroyed: boolean
  destroy(): void
}

export interface KeyboardNavigatorOptions {
  /** The mirror root the rows live in. */
  readonly container: HTMLElement
  /** Defaults to the mirror's row selector. */
  readonly rowSelector?: string
  /** The surface's real reaction to activating a row. */
  readonly onActivate?: (sessionId: string, detail: ActivationDetail) => void
  /** Focus landed on a row, so the surface can reveal what belongs to it. */
  readonly onFocusRow?: (sessionId: string, entry: HTMLElement) => void
  /**
   * Focus left a row. `relatedTarget` is where focus went, which is how the
   * surface tells traversal inside the list (relatedTarget is another entry) from
   * leaving it (null or something outside).
   */
  readonly onBlurRow?: (sessionId: string, relatedTarget: Element | null) => void
  /** Applied to the focused entry, so the focus indicator obeys the motion policy. */
  readonly motion?: MotionController
}

/**
 * Roving tabindex: exactly one entry is in the tab order, and it is the focused
 * one, or the first when nothing is focused. Every other entry stays focusable,
 * because arrow traversal needs to reach it.
 *
 * The index is clamped into range rather than trusted, because the one outcome
 * that must never happen is a list with no tab stop in it at all: a stale index
 * from a render that has since shrunk the list would leave the whole row list
 * unreachable by Tab with no visible cause.
 */
export function applyRovingTabIndex(entries: readonly HTMLElement[], focusedIndex: number): void {
  if (entries.length === 0) return
  const active = Math.min(Math.max(focusedIndex, 0), entries.length - 1)
  entries.forEach((entry, index) => {
    entry.setAttribute('tabindex', index === active ? '0' : '-1')
  })
}

export function createKeyboardNavigator(options: KeyboardNavigatorOptions): KeyboardNavigator {
  const container = options.container
  const selector = options.rowSelector ?? MIRROR_ROW_SELECTOR
  const doc = container.ownerDocument
  const motion = options.motion

  let entries: readonly HTMLElement[] = [...container.querySelectorAll<HTMLElement>(selector)]
  let activatedSessionId: string | null = null
  /**
   * How many times each row has been activated, held here rather than read back off
   * an element. A live rebuild replaces the elements, so an element attribute would
   * forget the count and the row would go back to "never activated" the moment
   * anything changed - which is what the earlier version of this did, and the
   * activated row lost its mark on every frame the hub sent.
   */
  const activationCounts = new Map<string, number>()
  let lastActivation: (ActivationDetail & { readonly sessionId: string }) | null = null
  let markedEntry: HTMLElement | null = null
  let markedActivated: HTMLElement | null = null
  let destroyed = false

  const sessionIdOf = (entry: HTMLElement | null): string | null =>
    entry?.getAttribute(MIRROR_ROW_ATTRIBUTE) ?? null

  /** The entries the container holds right now, in visual order. */
  const readEntries = (): readonly HTMLElement[] => [
    ...container.querySelectorAll<HTMLElement>(selector),
  ]

  /** Whether a re-read found a different list, so a stale cache is never used twice. */
  const entriesChanged = (next: readonly HTMLElement[]): boolean =>
    next.length !== entries.length || next.some((entry, index) => entry !== entries[index])

  const focusedEntry = (): HTMLElement | null => {
    const active = doc.activeElement
    if (active === null || !container.contains(active)) return null
    return (active as HTMLElement).matches(selector) ? (active as HTMLElement) : null
  }

  /**
   * Move the focus marks and the focus indicator's motion state onto one entry.
   * Only the previously marked entry is cleared, so a focus move costs two
   * attribute writes rather than a pass over the whole list.
   */
  const markFocused = (entry: HTMLElement | null): void => {
    if (markedEntry !== null && markedEntry !== entry) {
      markedEntry.removeAttribute(MIRROR_FOCUSED_ATTRIBUTE)
      markedEntry.classList.remove(MIRROR_FOCUSED_CLASS)
      // The focus indicator is decoration: with reduced motion it is applied, and
      // applied instantly, rather than not applied at all. Losing the indicator
      // would be worse than having it arrive without a transition.
      motion?.apply(markedEntry, 'focus-indicator', false)
    }
    if (entry !== null) {
      entry.setAttribute(MIRROR_FOCUSED_ATTRIBUTE, 'true')
      entry.classList.add(MIRROR_FOCUSED_CLASS)
      motion?.apply(entry, 'focus-indicator', true)
    }
    markedEntry = entry
  }

  /**
   * Put the activation mark on one entry, or take it off when passed null.
   *
   * The mark is addressed by session identity, so a rebuild re-applies it to the
   * row that was activated rather than losing it. Only the previously marked entry
   * is cleared, as with the focus mark, so a re-render costs two attribute writes
   * rather than a pass over the list.
   */
  const markActivated = (entry: HTMLElement | null): void => {
    if (markedActivated !== null && markedActivated !== entry) {
      markedActivated.removeAttribute(MIRROR_ACTIVATIONS_ATTRIBUTE)
      markedActivated.classList.remove(MIRROR_ACTIVATED_CLASS)
    }
    if (entry !== null) {
      entry.classList.add(MIRROR_ACTIVATED_CLASS)
      const id = sessionIdOf(entry)
      if (id !== null) {
        const seen = activationCounts.get(id)
        if (seen !== undefined && seen > 0) {
          entry.setAttribute(MIRROR_ACTIVATIONS_ATTRIBUTE, String(seen))
        }
      }
    }
    markedActivated = entry
  }

  const focusIndex = (index: number): HTMLElement | null => {
    if (destroyed || entries.length === 0) return null
    const clamped = Math.min(Math.max(index, 0), entries.length - 1)
    const entry = entries[clamped]
    if (entry === undefined) return null
    if (container.contains(entry)) {
      entry.focus()
      return entry
    }
    // The row at this position is a node from before the last rebuild. Focus it
    // and nothing happens at all, so re-read the list once and try the same
    // position in it: a caller that chose the row by identity still gets that row
    // as long as it survived, and a caller that chose a position gets the row now
    // in that position rather than a silent no-op.
    const next = readEntries()
    if (!entriesChanged(next)) return null
    entries = next
    if (entries.length === 0) return null
    const retried = entries[Math.min(clamped, entries.length - 1)]
    if (retried === undefined) return null
    // The single tab stop follows, so the list cannot be left unreachable by Tab
    // because a rebuild moved the row the tab stop was on.
    applyRovingTabIndex(entries, entries.indexOf(retried))
    retried.focus()
    return retried
  }

  /**
   * The cached list, re-read once when it is not the list in the document.
   *
   * The mirror announces every rebuild it makes, so this is the defensive path: a
   * caller that renders the mirror itself leaves the cache holding nodes that are
   * no longer attached, and working from those means focusing a node that does
   * nothing at all. One re-read costs a query and turns a silently dead keypress
   * into a working one.
   */
  const liveEntries = (): readonly HTMLElement[] => {
    if (entries.length === 0) {
      const next = readEntries()
      if (next.length > 0) entries = next
    } else if (!entries.some((entry) => container.contains(entry))) {
      const next = readEntries()
      if (entriesChanged(next)) entries = next
    }
    return entries
  }

  const focusOffsetFrom = (current: HTMLElement | null, delta: number): HTMLElement | null => {
    const list = liveEntries()
    if (list.length === 0) return null
    // The focused row is located by identity in the list as it is now, so an
    // unannounced rebuild moves the position with the row rather than losing it -
    // which is what would otherwise send a developer arrowing down a list of rows
    // back to the top of it.
    const from = current === null ? -1 : list.indexOf(current)
    // With nothing focused, forward traversal starts at the first row and backward
    // traversal at the last, which is where a list entry is entered from either
    // way round.
    const next = from < 0 ? (delta > 0 ? 0 : list.length - 1) : from + delta
    return focusIndex(next)
  }

  const focusSession = (sessionId: string): HTMLElement | null => {
    let index = entries.findIndex((entry) => entry.getAttribute(MIRROR_ROW_ATTRIBUTE) === sessionId)
    if (index < 0) {
      // The row is not in the cached list. Before answering "no such row", check
      // the document: this controller is asked to focus a row most often right
      // after the feed changed the list, and a rebuild that has not been announced
      // to it yet must not look like a row that does not exist.
      const next = readEntries()
      if (!entriesChanged(next)) return null
      entries = next
      index = entries.findIndex((entry) => entry.getAttribute(MIRROR_ROW_ATTRIBUTE) === sessionId)
      if (index < 0) return null
    }
    return focusIndex(index)
  }

  const focusFirst = (): HTMLElement | null => focusIndex(0)

  const focusLast = (): HTMLElement | null =>
    // The live list, not the cached length: a cached length from before a rebuild is
    // a position in a list that no longer exists, and clamping it into the new one
    // lands on a row nobody asked for - the second-to-last instead of the last,
    // silently, with no keypress to explain it.
    focusIndex(liveEntries().length - 1)

  const activate = (sessionId?: string, key = 'programmatic'): boolean => {
    if (destroyed) return false
    const target = sessionId === undefined ? focusedEntry() : focusSession(sessionId)
    if (target === null) return false
    const id = sessionIdOf(target)
    if (id === null) return false
    // Activation is observable in three places: on the element, in this
    // controller's own state, and in the surface's callback. A row that only
    // changed colour would be a dead end for anyone who cannot see it.
    const count = (activationCounts.get(id) ?? 0) + 1
    activationCounts.set(id, count)
    markActivated(target)
    activatedSessionId = id
    lastActivation = { sessionId: id, key, count }
    options.onActivate?.(id, { key, count })
    return true
  }

  const onFocusIn = (event: FocusEvent): void => {
    if (destroyed) return
    const entry = (event.target as HTMLElement | null)?.closest<HTMLElement>(selector) ?? null
    if (entry === null || !container.contains(entry)) return
    const index = entries.indexOf(entry)
    applyRovingTabIndex(entries, index < 0 ? 0 : index)
    markFocused(entry)
    const sessionId = sessionIdOf(entry)
    if (sessionId !== null) options.onFocusRow?.(sessionId, entry)
  }

  const onFocusOut = (event: FocusEvent): void => {
    if (destroyed) return
    const entry = (event.target as HTMLElement | null)?.closest<HTMLElement>(selector) ?? null
    if (entry === null || !container.contains(entry)) return
    motion?.apply(entry, 'focus-indicator', false)
    entry.removeAttribute(MIRROR_FOCUSED_ATTRIBUTE)
    entry.classList.remove(MIRROR_FOCUSED_CLASS)
    const related = event.relatedTarget
    const sessionId = sessionIdOf(entry)
    if (sessionId !== null) {
      options.onBlurRow?.(sessionId, related instanceof Element ? related : null)
    }
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (destroyed || event.altKey || event.ctrlKey || event.metaKey) return
    if (ACTIVATION_KEYS.includes(event.key)) {
      if (activate(undefined, event.key)) event.preventDefault()
      return
    }
    const action = NAVIGATION_KEYS[event.key]
    if (action === undefined) return
    // Tab is deliberately not handled: it leaves the row list entirely.
    // The four movements are the four methods, not a second copy of them - a key
    // handler with its own positions is a second answer to where End goes, and the
    // two drift apart the first time one of them is corrected.
    const target =
      action === 'next'
        ? focusOffsetFrom(focusedEntry(), 1)
        : action === 'previous'
          ? focusOffsetFrom(focusedEntry(), -1)
          : action === 'first'
            ? focusFirst()
            : focusLast()
    if (target !== null) event.preventDefault()
  }

  container.addEventListener('focusin', onFocusIn)
  container.addEventListener('focusout', onFocusOut)
  container.addEventListener('keydown', onKeyDown)

  applyRovingTabIndex(entries, 0)

  return {
    get entries(): readonly HTMLElement[] {
      return entries
    },
    get focusedSessionId(): string | null {
      return sessionIdOf(focusedEntry())
    },
    get focusedEntry(): HTMLElement | null {
      return focusedEntry()
    },
    get activatedSessionId(): string | null {
      return activatedSessionId
    },
    get lastActivation(): (ActivationDetail & { readonly sessionId: string }) | null {
      return lastActivation
    },
    focusIndex,
    focusNext(): HTMLElement | null {
      return focusOffsetFrom(focusedEntry(), 1)
    },
    focusPrevious(): HTMLElement | null {
      return focusOffsetFrom(focusedEntry(), -1)
    },
    focusFirst,
    focusLast,
    focusSession,
    activate,
    /**
     * Re-read the entries after the mirror rebuilt and re-apply the focus marks.
     *
     * Focus itself is not touched here: the mirror restores it by session
     * identity while it rebuilds, and this only makes the roving tabindex and the
     * focus marks agree with where focus ended up. Recomputing the roving index
     * from the post-rebuild focus position is what keeps the list reachable by Tab
     * after an update.
     */
    refresh(): void {
      if (destroyed) return
      entries = readEntries()
      const focused = focusedEntry()
      const index = focused === null ? -1 : entries.indexOf(focused)
      applyRovingTabIndex(entries, index < 0 ? 0 : index)
      markFocused(focused)
      // The activation mark is re-applied by identity for the same reason focus is:
      // the row that was activated is the one that carries the mark, whichever
      // element it is after a rebuild.
      markActivated(
        activatedSessionId === null
          ? null
          : (entries.find(
              (entry) => entry.getAttribute(MIRROR_ROW_ATTRIBUTE) === activatedSessionId,
            ) ?? null),
      )
    },
    get isDestroyed(): boolean {
      return destroyed
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      container.removeEventListener('focusin', onFocusIn)
      container.removeEventListener('focusout', onFocusOut)
      container.removeEventListener('keydown', onKeyDown)
      markFocused(null)
      markActivated(null)
      activationCounts.clear()
      entries = []
    },
  }
}
