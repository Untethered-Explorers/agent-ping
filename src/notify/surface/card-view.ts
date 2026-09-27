// The card's DOM view: a real element tree, written through attributes, with no inline
// style anywhere (NT-FR-02, NT-FR-08, NT-FR-10, APX-CON-07, APX-FR-01, ADR-012).
//
// THE CARD IS DOM, AND THAT IS THE WHOLE ACCESSIBILITY ANSWER
// The surface is a document, so the card's words are real text: a screen reader can read
// them, `Tab` can reach them, and a two-line card is two lines of selectable text rather
// than a canvas somebody has to draw a mirror for. APX-CON-07's canvas-plus-mirror
// obligation therefore does not extend to this card, and there is no mirror here - no
// canvas, no duplicated text, no hidden copy. A test asserts all three absences, because
// a mirror added out of habit is exactly the defect ADR-012 closed.
//
// EVERY STATE IS AN ATTRIBUTE, NEVER A STYLE
// `style-src 'self'` is the policy the hub sends with the dashboard
// (src/hub/security.ts), and it carries no `unsafe-inline`. So this view writes
// `setAttribute` and `textContent` and nothing else: no `element.style.x = y`, no
// `cssText`, no `style=` in markup. Everything a stylesheet needs to draw the card -
// which class, which urgency, which lifetime, how long until it goes, which motion mode -
// is in the document as an attribute a test can read. That is also why the card renders
// correctly under the strict policy rather than rendering blank (APX-CON-12, HC-FR-06).
//
// WHY THE DOM IS DECLARED STRUCTURALLY INSTEAD OF IMPORTED
// This file is Node-hosted code: `tsconfig.build.json` compiles `src/notify/**` with
// `lib: ["ES2023"]` and no DOM library, because the Electron main process must not have
// a `document` in scope. So the small part of the DOM this view uses is declared here as
// an interface, exactly as ./electron-host.ts declares the part of `BrowserWindow` it
// uses and ./position.ts declares Electron's `Rectangle`. A real `Document` and a real
// `HTMLElement` satisfy these interfaces - the structural property is asserted in
// tests/notify/surface-card-view.test.ts by assigning the jsdom ones to them, so the
// seam cannot drift into a shape no browser provides.
//
// ONE CARD AT A TIME, AND NO STALE ONE BEHIND IT
// The host window loads the card document once and every card is rendered into it
// (NT-FR-04), so the view owns replacement: showing a second card removes the first with
// the end `replaced` and cancels its timer, rather than stacking two rectangles. Removal
// is the only way a card leaves, and it always names which end happened - `resolved`,
// `acknowledged`, `expired`, `replaced` or `destroyed` - because a card that vanished for
// no stated reason is one nobody can explain afterwards (ADR-010).
//
// THE ONLY CLOCK IS THE ONE THE LIFETIME TABLE AUTHORISED
// The view arms exactly one expiry, and only when the cell it was handed has an interval:
// a needs-you card is shown, sits there until the hub says the block is resolved or
// acknowledged, and is never re-armed. There is no interval anywhere in this file, no
// `setInterval`, and no way to ask for a repeat (NT-FR-08). Persistence is the tray badge
// and the history, not a card that keeps reappearing.
//
// NO SOUND, NO NETWORK, NO NOTIFICATION SERVICE
// Nothing here plays anything, opens a socket, or reaches a platform notification
// mechanism. The card document came from the hub's own loopback origin (NT-FR-04) and
// this view adds no outbound call of any kind (APX-CON-12, NT-FR-02, NT-FR-11).
//
// VERIFICATION STATE, STATED THE SAME WAY IN EVERY FILE HERE
// Implemented and unit-tested, in jsdom, with the real element tree inspected. Not
// live-verified on the authoring machine: no card has been seen on any desktop from this
// checkout, because the card document the host window loads is not in the built
// artefacts yet. NT-9 owns that observation.

import { cardAccessibleName, cardUrgency, type CardModel } from './card.js'
import type { CardEnd, CardExpiryScheduler, CardLifetimeCell } from './lifetime.js'
import { armCardExpiry, rendersCard, timerCardScheduler } from './lifetime.js'

// ---------------------------------------------------------------------------
// The attribute contract
// ---------------------------------------------------------------------------

/** The card's root element marker. Its presence is what a stylesheet hangs rules on. */
export const CARD_ROOT_ATTRIBUTE = 'data-card'
/** The urgency token, so colour can be a third channel and never the only one. */
export const CARD_URGENCY_ATTRIBUTE = 'data-urgency'
/** Which lifetime cell rendered this card: `until-resolved`, `expires`, `never-rendered`. */
export const CARD_LIFETIME_ATTRIBUTE = 'data-lifetime'
/**
 * The fixed interval, in milliseconds, for a card that expires.
 *
 * Written only when the cell has one, so a needs-you card's *absence* of this attribute
 * is the statement that nothing will time it out and nothing will bring it back
 * (NT-FR-08). A duration, never a period: there is no value of this attribute that means
 * "again in".
 */
export const CARD_EXPIRES_ATTRIBUTE = 'data-expires-in'
/** The loopback deep link, as an attribute. Never rendered as text, never a path. */
export const CARD_DEEP_LINK_ATTRIBUTE = 'data-deep-link'
/** The title line, so a test and a stylesheet can find it without guessing at a class. */
export const CARD_TITLE_ATTRIBUTE = 'data-card-title'
/** The body line. */
export const CARD_BODY_ATTRIBUTE = 'data-card-body'
/** The urgency icon. Hidden from assistive technology: the word beside it says it. */
export const CARD_URGENCY_ICON_ATTRIBUTE = 'data-card-urgency-icon'
/** The urgency word. The non-colour channel, in real text. */
export const CARD_URGENCY_WORD_ATTRIBUTE = 'data-card-urgency-word'
/**
 * The motion mode: `animated` or `instant`.
 *
 * The same attribute name and the same two values the dashboard's motion policy uses
 * (src/dashboard/theme/motion.ts), and `cardPrefersReducedMotion` reads the same media
 * query, so the card and the dashboard cannot disagree about what a developer who has
 * asked for reduced motion gets. A test asserts the two modules' query strings are the
 * same string, because a copy is drift waiting to happen.
 */
export const CARD_MOTION_ATTRIBUTE = 'data-motion-state-arrival'

/** The two motion modes. Reduced motion is `instant`; nothing here is ever `off`. */
export const CARD_MOTION_MODES = Object.freeze({ animated: 'animated', instant: 'instant' } as const)

/**
 * The role every card carries.
 *
 * A live region, so a card that appears in a window the platform deliberately made
 * unfocusable is still announced. A card cannot be reached by `Tab` at the window level
 * - the host window is `focusable: false` so that a notification never takes the
 * keystroke someone is typing - which leaves the live region as the only channel a
 * screen reader has, so the role is load-bearing rather than decorative (APX-CON-07).
 */
export const CARD_ROLE = 'status'

/**
 * The reduced-motion query, as this file reads it.
 *
 * The same string the dashboard reads. Declared here rather than imported because
 * `src/dashboard/**` is not part of the Node-hosted build this file belongs to, and
 * `tests/notify/surface-card-view.test.ts` asserts the two are equal so the copy cannot
 * drift.
 */
export const CARD_REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * How a card is announced: assertive for a block, polite for a turn that ended.
 *
 * The distinction is the class policy's own, applied to a live region rather than to a
 * request line. A needs-you block is somebody waiting on a decision, so it is announced
 * at once; a finished turn is news rather than a demand, so it waits for a pause. A
 * card about work that ended interrupting a screen reader mid-sentence would be the same
 * mistake as stealing a keystroke.
 */
export function cardLivePoliteness(cell: CardLifetimeCell): 'assertive' | 'polite' {
  return cell.lifetime === 'until-resolved' ? 'assertive' : 'polite'
}

// ---------------------------------------------------------------------------
// The DOM, structurally
// ---------------------------------------------------------------------------

/**
 * The one thing an element needs of a node it puts inside itself.
 *
 * `nodeType` alone, and that is the point: it is the smallest property every real node
 * has, so a real `Node` and a real `HTMLElement` both satisfy it and the seam below
 * accepts the browser's own objects without a cast.
 */
export interface CardNode {
  readonly nodeType: number
}

/**
 * The part of an element this view uses.
 *
 * Deliberately small - set and read an attribute, read or write text, take a child, be
 * removed, be focused, count children - and deliberately structural, so the seam is
 * testable in jsdom today and satisfied by a real element tomorrow.
 */
export interface CardElement extends CardNode {
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | null
  appendChild(child: CardNode): unknown
  remove(): void
  focus(): void
  readonly childElementCount: number
  readonly isConnected: boolean
  /** Writable, because a line of a card is written as text and never as markup. */
  textContent: string | null
}

/** The part of a document this view uses. */
export interface CardDocument {
  createElement(tagName: string): CardElement
}

/** The reduced-motion preference, as the part of `MediaQueryList` this file reads. */
export interface CardMotionPreference {
  readonly matches: boolean
}

/** Where the preference comes from. An argument, so a test supplies the answer. */
export interface CardMotionSource {
  matchMedia?: (query: string) => CardMotionPreference | null | undefined
}

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

/**
 * Read the reduced-motion preference now.
 *
 * Read at render time rather than snapshotted, and read from an argument rather than
 * from `window`, so a developer who turns it on gets the next card without a reload and
 * a test can ask both questions without a display server. No source, or a source with no
 * `matchMedia`, answers "not reduced" rather than throwing (APX-CON-07).
 */
export function cardPrefersReducedMotion(source?: CardMotionSource | null): boolean {
  const resolved =
    source === undefined
      ? (typeof globalThis === 'undefined' ? null : (globalThis as unknown as CardMotionSource))
      : source
  if (resolved === null || typeof resolved.matchMedia !== 'function') return false
  return resolved.matchMedia(CARD_REDUCED_MOTION_QUERY)?.matches ?? false
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** What `renderCardElement` needs beyond the model and the cell. */
export interface RenderCardOptions {
  /** The document to create elements in. Defaults to this environment's own document. */
  readonly document?: CardDocument
  /** Where the reduced-motion preference comes from. Defaults to this environment. */
  readonly motion?: CardMotionSource | null
}

/**
 * Render one card as an element tree, and return it unattached.
 *
 * A pure function of the model, the lifetime cell and the motion preference: same three
 * inputs, same tree, no clock and no insertion. The caller decides where it goes and
 * when it is removed, which is what keeps "what a card says" and "how long it lives"
 * separate questions (NT-FR-02, NT-FR-08).
 *
 * The tree, in order: the urgency icon, the urgency word, the title, the body. Two lines
 * of real text and two one-word channels for urgency - never a count, never a path,
 * never a session identifier as text, never a button (APX-FR-01, APX-CON-07).
 */
export function renderCardElement(
  model: CardModel,
  cell: CardLifetimeCell,
  options: RenderCardOptions = {},
): CardElement {
  const doc = resolveCardDocument(options.document)
  const urgency = cardUrgency(model.urgency)
  const reduced = cardPrefersReducedMotion(options.motion)

  const root = doc.createElement('article')
  root.setAttribute(CARD_ROOT_ATTRIBUTE, '')
  root.setAttribute(CARD_URGENCY_ATTRIBUTE, model.urgency)
  root.setAttribute(CARD_LIFETIME_ATTRIBUTE, cell.lifetime)
  if (cell.expiresInMs !== null) {
    root.setAttribute(CARD_EXPIRES_ATTRIBUTE, String(cell.expiresInMs))
  }
  if (model.deepLink !== null) {
    root.setAttribute(CARD_DEEP_LINK_ATTRIBUTE, model.deepLink)
  }
  root.setAttribute(CARD_MOTION_ATTRIBUTE, reduced ? CARD_MOTION_MODES.instant : CARD_MOTION_MODES.animated)
  root.setAttribute('role', CARD_ROLE)
  root.setAttribute('aria-live', cardLivePoliteness(cell))
  root.setAttribute('aria-label', cardAccessibleName(model))
  // Focusable, even though the host window is deliberately unfocusable: a card reached by
  // a pointer, by `Tab` in a card document that is given focus deliberately, or by a
  // screen reader's virtual cursor all need the element itself to be a tab stop, and
  // `tabindex` is the only way to say so (APX-CON-07).
  root.setAttribute('tabindex', '0')

  const icon = doc.createElement('span')
  icon.setAttribute(CARD_URGENCY_ICON_ATTRIBUTE, '')
  // The word beside it carries the same meaning, so announcing the glyph too would say
  // "exclamation mark, needs you" to somebody who is trying to work.
  icon.setAttribute('aria-hidden', 'true')
  icon.textContent = urgency.icon
  root.appendChild(icon)

  const word = doc.createElement('span')
  word.setAttribute(CARD_URGENCY_WORD_ATTRIBUTE, '')
  word.textContent = urgency.word
  root.appendChild(word)

  const title = doc.createElement('p')
  title.setAttribute(CARD_TITLE_ATTRIBUTE, '')
  title.textContent = model.title
  root.appendChild(title)

  const body = doc.createElement('p')
  body.setAttribute(CARD_BODY_ATTRIBUTE, '')
  body.textContent = model.body
  root.appendChild(body)

  return root
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/** What `createCardView` needs. */
export interface CardViewOptions {
  /** The element a card is put inside. The card document's own body, in production. */
  readonly parent: CardElement
  /** The document to create elements in. Defaults to this environment's own document. */
  readonly document?: CardDocument
  /** Where the expiry clock comes from. Defaults to this environment's `setTimeout`. */
  readonly scheduler?: CardExpiryScheduler
  /** Where the reduced-motion preference comes from. Defaults to this environment. */
  readonly motion?: CardMotionSource | null
  /** Called once per card, when it leaves the screen, with the end that took it. */
  readonly onEnd?: (end: CardEnd) => void
}

/**
 * One card at a time, in one place, removed when its lifetime ends or the host dies.
 *
 * The view owns removal because removal is the half of the lifetime that touches the
 * document: the policy in ./lifetime.ts says how long a card lives and this is what
 * makes that true. A card is removed when the block is `resolved` or `acknowledged`,
 * when a `finished` card's interval elapses, when a second card `replaces` it, and when
 * the host is `destroyed` - and every one of those leaves the parent element exactly as
 * it was found, with no card and no timer behind it (NT-FR-08, NT-FR-10, APX-FR-02).
 */
export interface CardView {
  /** The element cards are put inside. Never the card itself. */
  readonly parent: CardElement
  /** Whether a card is on the screen right now. */
  readonly showing: boolean
  /** The model being shown, or null when nothing is. */
  readonly current: CardModel | null
  /** The lifetime cell the current card was rendered under. */
  readonly currentLifetime: CardLifetimeCell | null
  /** Show one card, replacing whatever was showing. Renders nothing for a refused cell. */
  show(model: CardModel, cell: CardLifetimeCell): void
  /** Take the current card off the screen, naming the end. Idempotent; a no-op if empty. */
  remove(end: CardEnd): void
  /** Take the card down for good: the host window is going away. Idempotent. */
  destroy(): void
}

export function createCardView(options: CardViewOptions): CardView {
  const scheduler = options.scheduler ?? timerCardScheduler
  let element: CardElement | null = null
  let model: CardModel | null = null
  let cell: CardLifetimeCell | null = null
  let arm: { cancel(): void } | null = null
  let destroyed = false

  /** Remove whatever is showing, naming the end. The one place a card leaves. */
  const take = (end: CardEnd): void => {
    const leaving = element
    if (leaving === null) return
    element = null
    model = null
    cell = null
    // The timer goes before the node, so a callback that is already in flight finds
    // nothing to do and cannot remove a card that has since been replaced.
    arm?.cancel()
    arm = null
    leaving.remove()
    options.onEnd?.(end)
  }

  return {
    parent: options.parent,
    get showing(): boolean {
      return element !== null
    },
    get current(): CardModel | null {
      return model
    },
    get currentLifetime(): CardLifetimeCell | null {
      return cell
    },
    show(next: CardModel, nextCell: CardLifetimeCell): void {
      // A card that is never rendered takes nothing off the screen. An `fyi` arriving
      // must not dismiss a needs-you block that is still waiting for a decision, so the
      // refusal is a complete no-op rather than a replacement (NT-FR-02, ADR-004).
      if (destroyed || !rendersCard(nextCell)) return
      // One card at a time: the document is loaded once and reused, so a second card
      // replaces the first rather than stacking on it.
      take('replaced')
      const rendered = renderCardElement(next, nextCell, {
        ...(options.document === undefined ? {} : { document: options.document }),
        ...(options.motion === undefined ? {} : { motion: options.motion }),
      })
      options.parent.appendChild(rendered)
      element = rendered
      model = next
      cell = nextCell
      // One clock, only for the one cell that has an interval. A needs-you cell arms
      // nothing, so there is nothing here that can re-arm it (NT-FR-08).
      arm = armCardExpiry(nextCell, scheduler, () => {
        take('expired')
      })
    },
    remove(end: CardEnd): void {
      take(end)
    },
    destroy(): void {
      if (destroyed) return
      take('destroyed')
      destroyed = true
    },
  }
}

/**
 * The document to render into: the one supplied, or this environment's own.
 *
 * A typed failure rather than an unhandled `undefined` when there is neither, because a
 * card with no document is a card nobody can see and a `TypeError: createElement is not a
 * function` three frames later says nothing about that. The card document is a web page,
 * and this module is the only place that needs one (NT-FR-02).
 *
 * The ambient document is looked up as `document` first and only then as a global object
 * that can create elements, because that is the order a page answers in: a renderer
 * always has `document`, and an environment that has a `createElement` but no
 * `document` is not a page.
 */
function resolveCardDocument(candidate?: CardDocument): CardDocument {
  if (candidate !== undefined) {
    if (isCardDocument(candidate)) return candidate
    // Supplied and unusable is a caller's mistake, and it is reported rather than quietly
    // replaced by the ambient one: a card drawn into a document nobody chose is a card
    // somewhere nobody looked.
    throw new Error(
      'the `document` supplied to the card view cannot create elements, so the card has nowhere to ' +
        'be drawn. Pass the card document the window loaded (NT-FR-02).',
    )
  }
  const environment = typeof globalThis === 'undefined' ? null : (globalThis as unknown as { document?: unknown })
  if (isCardDocument(environment?.document)) return environment.document
  if (isCardDocument(environment)) return environment as unknown as CardDocument
  throw new Error(
    'the card view needs a document to render into, and this environment has none. Pass one as ' +
      '`document`: the card document is a web page, and a card with no document is a card nobody ' +
      'can see (NT-FR-02).',
  )
}

/** Whether this value is something a card can be built in. A capability, not a name. */
function isCardDocument(value: unknown): value is CardDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { createElement?: unknown }).createElement === 'function'
  )
}

/** The ends, re-exported so a caller wiring the hub's acknowledgement needs one import. */
export { CARD_ENDS, type CardEnd } from './lifetime.js'
