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
//     acknowledgement and deep-link focus hang off.

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
  let lastActivation: (ActivationDetail & { readonly sessionId: string }) | null = null
  let markedEntry: HTMLElement | null = null
  let destroyed = false

  const sessionIdOf = (entry: HTMLElement | null): string | null =>
    entry?.getAttribute(MIRROR_ROW_ATTRIBUTE) ?? null

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

  const focusIndex = (index: number): HTMLElement | null => {
    if (destroyed || entries.length === 0) return null
    const clamped = Math.min(Math.max(index, 0), entries.length - 1)
    const entry = entries[clamped]
    if (entry === undefined) return null
    entry.focus()
    return entry
  }

  const focusOffsetFrom = (current: HTMLElement | null, delta: number): HTMLElement | null => {
    if (entries.length === 0) return null
    const from = current === null ? -1 : entries.indexOf(current)
    // With nothing focused, forward traversal starts at the first row and backward
    // traversal at the last, which is where a list entry is entered from either
    // way round.
    const next = from < 0 ? (delta > 0 ? 0 : entries.length - 1) : from + delta
    return focusIndex(next)
  }

  const focusSession = (sessionId: string): HTMLElement | null => {
    const index = entries.findIndex((entry) => entry.getAttribute(MIRROR_ROW_ATTRIBUTE) === sessionId)
    if (index < 0) return null
    return focusIndex(index)
  }

  const activate = (sessionId?: string, key = 'programmatic'): boolean => {
    if (destroyed) return false
    const target = sessionId === undefined ? focusedEntry() : focusSession(sessionId)
    if (target === null) return false
    const id = sessionIdOf(target)
    if (id === null) return false
    // Activation is observable in three places: on the element, in this
    // controller's own state, and in the surface's callback. A row that only
    // changed colour would be a dead end for anyone who cannot see it.
    const count = Number(target.getAttribute(MIRROR_ACTIVATIONS_ATTRIBUTE) ?? '0') + 1
    target.setAttribute(MIRROR_ACTIVATIONS_ATTRIBUTE, String(count))
    target.classList.add(MIRROR_ACTIVATED_CLASS)
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
    const target =
      action === 'next'
        ? focusOffsetFrom(focusedEntry(), 1)
        : action === 'previous'
          ? focusOffsetFrom(focusedEntry(), -1)
          : action === 'first'
            ? focusIndex(0)
            : focusIndex(entries.length - 1)
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
    focusFirst(): HTMLElement | null {
      return focusIndex(0)
    },
    focusLast(): HTMLElement | null {
      return focusIndex(entries.length - 1)
    },
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
      entries = [...container.querySelectorAll<HTMLElement>(selector)]
      const focused = focusedEntry()
      const index = focused === null ? -1 : entries.indexOf(focused)
      applyRovingTabIndex(entries, index < 0 ? 0 : index)
      markFocused(focused)
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
      entries = []
    },
  }
}
