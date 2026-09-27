// The card's model: what a card says, built purely from the delivery plan (NT-FR-01,
// NT-FR-02, APX-FR-01, ADR-003, ADR-004, ADR-008, ADR-012).
//
// WHAT THIS FILE IS, AND WHAT IT IS NOT
// A pure function in and a frozen value out. No DOM, no clock, no socket, no notifier,
// no store, no randomness and no module-level state, so the whole of "what a card says"
// can be asserted without a display, a harness or a running hub. The DOM is one file
// over (./card-view.ts) and is the only place the model touches a document.
//
// THE FIVE FIELDS, AND WHY THOSE FIVE
//   title, body, urgency, pendingCount, deepLink
// The title is the repository short name, the body is the one sentence the class policy
// already decided, the urgency token is that cell's own, the count is the hub's
// outstanding-block count, and the link is the loopback dashboard URL. Nothing else is
// in the type, and a test enumerates the keys rather than restating the list - so a
// field added for convenience fails a test instead of appearing on a developer's screen.
//
// A refused plan produces no model at all. That is structural rather than a branch: the
// plan for an `fyi` carries no request, so there is no title, no body and no urgency to
// copy, and `buildCardModel` returns null because it has nothing to return. A caller
// that ignores the null renders an empty card, which is visible; a caller that renders
// *something* for an fyi would have to invent it (NT-FR-02, ADR-004).
//
// WHAT THE MODEL DELIBERATELY DOES NOT CARRY
// No filesystem path, no session identifier, no harness name, no prompt, no tool name,
// no diff, no transcript, no conversation content of any kind. The title is guarded
// against a path and against a line break, so a caller that passed a full repository
// path gets an error rather than a developer's home directory on their screen and in a
// screenshot of it (APX-FR-01, ADR-003, ADR-008). The session identifier exists only
// inside the loopback deep link, which the product builds, serves and never reads
// (APX-CON-01).
//
// THE COUNT IS IN THE MODEL AND NOT IN THE CARD
// `pendingCount` is here because the model is the plan's facts and the count is one of
// them; the view does not render it, and that is a decision rather than an oversight. A
// number in a card is a second place a count exists, it is wrong the moment a second
// block arrives, and the badge and the dashboard already carry it properly - the tray
// badge is this product's durable signal and the count there is read from the pending
// set rather than copied (NT-FR-06, PRD 16 Open Question 3). So the model is honest
// about what it knows and the card stays two lines long.
//
// URGENCY IS AN ICON AND A WORD, NOT A COLOUR
// `CARD_URGENCY` is total over the urgency union, so every urgency a class can produce
// has a shape and a word, and the word is real text a screen reader announces. Colour
// is a third channel the card's stylesheet may add, never the only one (APX-CON-07).
//
// THE ACCESSIBLE NAME IS BUILT HERE, NOT IN THE VIEW
// One sentence, from the same three values the view renders, so the name cannot drift
// from what is on the card: a screen reader announces the urgency, the repository and
// the sentence, in that order (APX-CON-07, NT-FR-02).
//
// VERIFICATION STATE, STATED THE SAME WAY IN EVERY FILE HERE
// Implemented and unit-tested. Not live-verified on the authoring machine: no card has
// been observed on any desktop from this checkout, because the card document the host
// window loads does not exist in the built artefacts yet. NT-9 drives a real card and
// owns that observation; nothing in the tests claims a card was seen on a screen.

import type { NotificationPlan } from '../policy.js'
import type { NotificationUrgency } from '../types.js'

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/**
 * What a card says. Five fields, frozen, and nothing else.
 *
 * The two lines are `title` and `body`; the other three are the facts the view needs to
 * make the card behave - an urgency encoding, a count it deliberately does not print,
 * and the link a click will eventually open.
 */
export interface CardModel {
  /** One line: the repository short name. Never a path. */
  readonly title: string
  /** One sentence naming the kind of block. Never a count, a list or a stack. */
  readonly body: string
  /** The class cell's urgency token, mapped to an icon and a word by `CARD_URGENCY`. */
  readonly urgency: NotificationUrgency
  /** The hub's outstanding-block count. Carried, never rendered. */
  readonly pendingCount: number
  /** `?session=<id>` on the loopback dashboard URL, or null before the socket is bound. */
  readonly deepLink: string | null
}

/**
 * The two lines a card is, named as data.
 *
 * The card is a title and a sentence and nothing else - no stack of text, no count, no
 * identifier (the feature's own UI rule, and PRD 9's "one line of context"). A test
 * enumerates this list and asserts the rendered text is exactly these two values plus
 * the urgency word, so "two lines" is a property of the card rather than of the code
 * that happened to write it.
 */
export const CARD_TEXT_FIELDS = Object.freeze(['title', 'body'] as const)

// ---------------------------------------------------------------------------
// Urgency, as an icon and a word
// ---------------------------------------------------------------------------

/** How one urgency is shown without relying on colour. */
export interface CardUrgencyEncoding {
  /**
   * A shape a person can see at a glance. A real character in the card's own text, not
   * a drawn silhouette: the card is a document, and a glyph is the one icon a document
   * can carry under a strict content-security policy.
   */
  readonly icon: string
  /** The word beside it. Read by a screen reader and legible with no colour at all. */
  readonly word: string
}

/**
 * Every urgency the class policy can produce, with its icon and its word.
 *
 * Total over the urgency union, and frozen, so a new urgency is a compile error here
 * rather than a card that renders no icon and no word. The `low` cell exists only for
 * totality: no class currently delivers at that urgency, because an `fyi` is refused
 * before it can be rendered at all (NT-FR-02, ADR-004).
 */
export const CARD_URGENCY: Readonly<Record<NotificationUrgency, Readonly<CardUrgencyEncoding>>> =
  Object.freeze({
    critical: Object.freeze({ icon: '!', word: 'Needs you' }),
    normal: Object.freeze({ icon: '✓', word: 'Finished' }),
    low: Object.freeze({ icon: 'i', word: 'For your information' }),
  })

/** This urgency's icon and word. Throws for an urgency the table does not carry. */
export function cardUrgency(urgency: NotificationUrgency): CardUrgencyEncoding {
  const encoding = CARD_URGENCY[urgency]
  if (encoding === undefined) {
    throw new Error(
      `unhandled card urgency: "${String(urgency)}". CARD_URGENCY must carry every urgency the class ` +
        'policy can produce, because an urgency with no icon and no word is urgency carried by colour ' +
        'alone (APX-CON-07).',
    )
  }
  return encoding
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/**
 * Build the model for one delivery plan, or nothing at all for a refused one.
 *
 * Pure, and the only place a card's words are assembled. A refused plan - every `fyi` -
 * yields `null`, because the plan carries no request to copy: the refusal is the class
 * policy working, and an fyi is visible in the dashboard and nowhere else.
 *
 * Throws for a title that is a path, a line break or empty whitespace, and for a count
 * that is not a non-negative integer. Those are defects in the caller's own facts rather
 * than conditions a card could honestly render: a card is the one place this product
 * puts words on a developer's screen, so a wrong value here has to be loud rather than
 * displayed. The throw happens in the delivery path, where it is recorded as a failure
 * with its reason rather than shown (APX-FR-02, ADR-010).
 */
export function buildCardModel(plan: NotificationPlan, pendingCount: number): CardModel | null {
  if (plan.kind === 'refuse') return null
  const { request } = plan
  assertCardTitle(request.title)
  assertSingleLine('body', request.body)
  if (!Number.isInteger(pendingCount) || pendingCount < 0) {
    throw new RangeError(
      `the pending count a card was built from is not a count: ${String(pendingCount)}. It must be a ` +
        'non-negative integer, because a card must never print a number that is not the number of ' +
        'outstanding blocks (NT-FR-06).',
    )
  }
  return Object.freeze({
    title: request.title,
    body: request.body,
    urgency: request.urgency,
    pendingCount,
    deepLink: request.deepLink,
  })
}

/**
 * The card's accessible name: the urgency, the repository, and the sentence.
 *
 * One sentence, from the same three values the view renders, so what a screen reader
 * announces and what a person reads are the same three things in the same order. The
 * icon is decorative beside it and is hidden from assistive technology for exactly that
 * reason (APX-CON-07).
 */
export function cardAccessibleName(model: CardModel): string {
  return `${cardUrgency(model.urgency).word}: ${model.title}. ${model.body}`
}

/**
 * Refuse a title that is not a repository short name.
 *
 * A path separator or a line break is the shape of the two things this product must
 * never put on a screen: a filesystem path, which would carry a developer's home
 * directory into a screenshot, and a second line, which would make a two-line card a
 * four-line one. An empty title falls back upstream in the class policy; a whitespace
 * one that reached here is a defect (APX-FR-01, ADR-008).
 */
function assertCardTitle(title: string): void {
  if (/[/\\]/.test(title)) {
    throw new Error(
      `a card title may not be a filesystem path: ${JSON.stringify(title)}. The title is the repository ` +
        'short name the durable log already holds; a full path would put a home directory on a ' +
        "developer's screen and in a screenshot of it (APX-FR-01, ADR-008).",
    )
  }
  assertSingleLine('title', title)
  if (title.trim() === '') {
    throw new Error(
      'a card title may not be blank. The class policy falls back to this product\'s own name when a ' +
        'repository short name cannot be read, so a blank title means a caller bypassed that (ADR-008).',
    )
  }
}

/** One line, no line break, whatever else it is. */
function assertSingleLine(field: 'title' | 'body', value: string): void {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(
      `a card ${field} may not span lines. A card is two lines - the repository short name and one ` +
        'sentence - and anything longer is content this product does not put on a screen (APX-FR-01).',
    )
  }
}
