// The motion policy for the dashboard (DP-FR-04, APX-CON-07).
//
// One question lives here and nowhere else: may this effect move? Every effect
// the surface can play asks before it plays, and the answer is read at the moment
// of the request rather than snapshotted at mount. A preference changed while the
// page is open is honoured, because a developer who turns reduced motion on
// expects the next row that arrives to stop moving without reloading the page.
//
// The distinction the requirement turns on is between movement and information.
// Movement is decoration: the focus indicator's transition, the revealed full
// path, a row arriving. It may be suppressed and nothing is lost, because each of
// those is duplicated as text. The fact that a session is blocked is the
// information, so it is not an effect at all: `showStateChange` marks a state
// change visible and the stylesheet never transitions that attribute, which makes
// "suppress the movement, keep the state" a structural property rather than a
// promise.
//
// This module owns the decision and the attribute contract, and the declaration
// text a stylesheet needs. It does not own any stylesheet: it does not know what
// the mirror's root selector is, and guessing would couple the policy to one
// caller. `dom-mirror.ts` composes these pieces into the rules for its own
// subtree.

/** The preference this policy reads. */
export const REDUCED_MOTION_MEDIA_QUERY = '(prefers-reduced-motion: reduce)'

/** How long a permitted movement runs. Long enough to read, short enough to ignore. */
export const MOTION_DURATION_MS = 120

/**
 * Every movement the surface can play. All three are decoration, and all three
 * are enumerated so a test can assert each one individually rather than
 * assuming the list the implementation happens to have.
 */
export type MotionEffect = 'focus-indicator' | 'full-path-reveal' | 'state-arrival'

export const NON_ESSENTIAL_MOTION: readonly MotionEffect[] = Object.freeze([
  'focus-indicator',
  'full-path-reveal',
  'state-arrival',
] as const satisfies readonly MotionEffect[])

/**
 * `off` when the effect is not in play at all, `instant` when it is in play and
 * must not move, `animated` when it is in play and may transition. The mode is
 * written to the DOM rather than applied as an inline style so a strict
 * content-security-policy never has to allow inline styles, and so the state is
 * assertable: a test reads the attribute, not a computed transition duration.
 */
export type MotionMode = 'animated' | 'instant' | 'off'

/** The attribute a state change is marked with. Never transitioned, never suppressed. */
export const MOTION_STATE_CHANGE_ATTRIBUTE = 'data-motion-state-change'

/** The only value `MOTION_STATE_CHANGE_ATTRIBUTE` ever takes. */
export const STATE_CHANGE_MODE = 'visible'

/** The attribute an effect's current mode is written to. */
export function motionAttribute(effect: MotionEffect): string {
  return `data-motion-${effect}`
}

/** A selector matching the elements an effect is currently animating. */
export function animatedSelector(effect: MotionEffect): string {
  return `[${motionAttribute(effect)}='animated']`
}

/** The declaration an animating element gets. */
export const MOTION_TRANSITION_DECLARATION = `transition: opacity ${MOTION_DURATION_MS}ms ease-out, transform ${MOTION_DURATION_MS}ms ease-out;`

/**
 * The declaration a reduced-motion backstop applies. `!important` because this
 * has to beat the animated rule above it; it is the second line of defence for
 * anything that reaches the DOM without asking the policy first.
 */
export const MOTION_SUPPRESSED_DECLARATION = 'transition: none !important; animation: none !important;'

/**
 * The part of `MediaQueryList` this module uses. Declared structurally so a test
 * can supply a preference it controls, and so an environment without
 * `matchMedia` (jsdom has none) degrades to "not reduced" instead of throwing.
 */
export interface MotionPreference {
  readonly matches: boolean
  addEventListener?: (type: 'change', listener: () => void) => void
  removeEventListener?: (type: 'change', listener: () => void) => void
}

export interface MotionQuerySource {
  matchMedia?: (query: string) => MotionPreference | null | undefined
}

/**
 * Read the preference once, for callers that need a boolean rather than a
 * controller. The surface itself uses `createMotionController`, which re-reads it
 * on every change; this exists for the one-shot questions.
 */
export function prefersReducedMotion(source?: MotionQuerySource | null): boolean {
  // `undefined` means "ask the window"; an explicit `null` means "there is no
  // source", which is a different answer and the one a test wants to be able to ask
  // for without depending on what the environment happens to implement.
  const resolved =
    source === undefined ? (typeof globalThis.window === 'undefined' ? null : globalThis.window) : source
  if (resolved === null || typeof resolved.matchMedia !== 'function') return false
  return resolved.matchMedia(REDUCED_MOTION_MEDIA_QUERY)?.matches ?? false
}

export interface MotionController {
  /** The preference as it stands right now, not as it stood at mount. */
  readonly reducedMotion: boolean
  /** May this effect move? False for every effect while reduced motion is on. */
  isAnimated(effect: MotionEffect): boolean
  /** The mode an effect is in: `off`, `instant` or `animated`. */
  mode(effect: MotionEffect, active: boolean): MotionMode
  /** Record an effect as in play or not, and write the resulting mode to the element. */
  apply(target: HTMLElement, effect: MotionEffect, active: boolean): void
  /** Mark a state change as visible. Never suppressed, never transitioned. */
  showStateChange(target: HTMLElement): void
  /** How many elements carry a mode. Zero after `destroy`. */
  readonly watchedTargets: number
  readonly isDestroyed: boolean
  destroy(): void
}

export interface MotionControllerOptions {
  /** The preference to read. Defaults to the window's reduced-motion query. */
  readonly preference?: MotionPreference | null
  /** Where the preference comes from, when it is not supplied directly. */
  readonly source?: MotionQuerySource | null
}

export function createMotionController(options: MotionControllerOptions = {}): MotionController {
  const preference =
    options.preference ??
    (options.source ?? (typeof globalThis.window === 'undefined' ? null : globalThis.window))?.matchMedia?.(
      REDUCED_MOTION_MEDIA_QUERY,
    ) ??
    null

  let reducedMotion = preference?.matches ?? false
  let destroyed = false
  // The elements carrying a mode, so a preference change can rewrite them all
  // without the surface having to re-render. Map-of-Maps rather than a flat list
  // because an element can be in play for more than one effect at a time: a
  // focused row in a repository whose full path is revealed is two.
  const applied = new Map<HTMLElement, Map<MotionEffect, boolean>>()

  // An effect the policy has not declared non-essential is information, and
  // information does not move. Declaring the list is therefore load-bearing: an
  // effect that appears without being declared stays still.
  const isEssential = (effect: MotionEffect): boolean => !NON_ESSENTIAL_MOTION.includes(effect)

  const mode = (effect: MotionEffect, active: boolean): MotionMode => {
    if (!active) return 'off'
    if (reducedMotion || isEssential(effect)) return 'instant'
    return 'animated'
  }

  const isAnimated = (effect: MotionEffect): boolean => mode(effect, true) === 'animated'

  const write = (target: HTMLElement, effect: MotionEffect, active: boolean): void => {
    target.setAttribute(motionAttribute(effect), mode(effect, active))
  }

  const onPreferenceChange = (): void => {
    if (destroyed || preference === null) return
    const next = preference.matches
    if (next === reducedMotion) return
    reducedMotion = next
    for (const [target, effects] of applied) {
      for (const [effect, active] of effects) write(target, effect, active)
    }
  }

  if (preference !== null && typeof preference.addEventListener === 'function') {
    preference.addEventListener('change', onPreferenceChange)
  }

  return {
    get reducedMotion(): boolean {
      return reducedMotion
    },
    isAnimated,
    mode,
    apply(target: HTMLElement, effect: MotionEffect, active: boolean): void {
      if (destroyed) return
      let effects = applied.get(target)
      if (effects === undefined) {
        effects = new Map<MotionEffect, boolean>()
        applied.set(target, effects)
      }
      if (active) {
        effects.set(effect, true)
      } else {
        // An effect that is not in play is not tracked, so the watched set stays
        // the set of things currently moving rather than a list of every element
        // that ever moved.
        effects.delete(effect)
        if (effects.size === 0) applied.delete(target)
      }
      write(target, effect, active)
    },
    showStateChange(target: HTMLElement): void {
      if (destroyed) return
      target.setAttribute(MOTION_STATE_CHANGE_ATTRIBUTE, STATE_CHANGE_MODE)
    },
    get watchedTargets(): number {
      return applied.size
    },
    get isDestroyed(): boolean {
      return destroyed
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      applied.clear()
      preference?.removeEventListener?.('change', onPreferenceChange)
    },
  }
}
