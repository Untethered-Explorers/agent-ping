// The card's DOM view: a real element tree, written through attributes, announced, and
// taken out of the document when its lifetime ends or the host is destroyed
// (NT-FR-02, NT-FR-08, NT-FR-10, APX-CON-07, ADR-012).
//
//   npm test -- tests/notify/surface-card-view.test.ts
//
// WHY THIS SUITE RUNS IN jsdom
// The card is a document, so its obligations - real text, a real focus, a real role, a
// real accessible name, nothing but attributes on the element - are obligations of a DOM
// and cannot be asserted against a string. The file is collected by the `node` Vitest
// project and the docblock above switches the environment to jsdom, so a real `Document`
// builds the tree, a real `focus()` moves the focus, and a real `document.activeElement`
// is what the focus assertion reads. jsdom applies no layout and no paint: what this
// suite proves is the document, not how a compositor draws it.
//
// THE SEVEN ACCEPTANCE CRITERIA OF NT-7, AND WHERE EACH IS PROVEN
//
//   1. lifetime table total, throws for a class it does not carry
//      tests/notify/surface-lifetime.test.ts
//   2. the needs-you cell has no re-arming timer; finished expires on a fixed interval
//      tests/notify/surface-lifetime.test.ts for the policy; `a card is removed...` below
//      for what the view does with it
//   3. "a rendered card carries the repository short name and one sentence and no count,
//      path, session identifier or harness name"
//      `the card is exactly the two lines and the urgency` and `carries the deep link as
//      an attribute and never as text` below - asserted on the *rendered* subtree, not on
//      the model
//   4. "focusable, exposes a role and an accessible name, and encodes urgency with an icon
//      and a word as well as colour"
//      `the card is focusable`, `the card exposes a role and a live politeness`,
//      `the card exposes an accessible name` and `urgency is an icon and a word as well as
//      a colour` below
//   5. "the view writes no inline style"
//      `the card writes no inline style` below, twice: over the rendered subtree at run
//      time, and over the module's own source
//   6. "a card is removed from the document when its lifetime ends and when the host is
//      destroyed"
//      `a card is removed from the document when its lifetime ends` and `... and when the
//      host is destroyed` below
//   7. no platform mechanism anywhere under src/notify
//      tests/notify/surface-card.test.ts, which owns the sweep over the whole tree
//
// AROUND THOSE:
//   - The card is DOM and not a canvas, so APX-CON-07's mirror obligation does not apply
//     and no mirror is built: `the card is a document, not a canvas and not a mirror`
//     asserts there is no canvas, no second copy of the text and no hidden copy of the
//     card but the one decorative icon.
//   - The DOM seam is satisfied by the browser's own objects, asserted rather than
//     assumed: `the seam is satisfied by a real document`.
//   - Reduced motion is honoured, and the query the card reads is asserted to be the same
//     string the dashboard's motion policy reads, so the copy cannot drift.
//
// WHAT IS NOT PROVEN HERE
// Nothing about a desktop: no Electron process, no window, no compositor. The host
// window's `showInactive` and click-through are tests/notify/surface-host.test.ts, and
// whether any of the three desktops composites a transparent frameless window correctly
// is NT-9's live observation, which has not happened yet.

// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CARD_BODY_ATTRIBUTE,
  CARD_DEEP_LINK_ATTRIBUTE,
  CARD_ENDS,
  CARD_EXPIRES_ATTRIBUTE,
  CARD_LIFETIME_ATTRIBUTE,
  CARD_MOTION_ATTRIBUTE,
  CARD_MOTION_MODES,
  CARD_REDUCED_MOTION_QUERY,
  CARD_ROLE,
  CARD_ROOT_ATTRIBUTE,
  CARD_TITLE_ATTRIBUTE,
  CARD_URGENCY_ATTRIBUTE,
  CARD_URGENCY_ICON_ATTRIBUTE,
  CARD_URGENCY_WORD_ATTRIBUTE,
  cardPrefersReducedMotion,
  createCardView,
  renderCardElement,
  type CardDocument,
  type CardElement,
} from '@/notify/surface/card-view'
import { buildCardModel, cardAccessibleName, cardUrgency } from '@/notify/surface/card'
import {
  CARD_ENDS as POLICY_CARD_ENDS,
  FINISHED_CARD_EXPIRES_IN_MS,
  cardLifetimeFor,
  type CardEnd,
  type CardExpiryScheduler,
  type CardTimer,
} from '@/notify/surface/lifetime'
import { planNotification } from '@/notify/policy'
import { REDUCED_MOTION_MEDIA_QUERY } from '@/dashboard/theme/motion'
import type { NotificationClass } from '@/notify/types'

/**
 * A repository-relative path, resolved through node:path rather than `new URL`.
 *
 * `new URL(relative, import.meta.url)` is rewritten by Vite's asset handling and does not
 * survive a change of test environment - the jsdom suite proved that - so the repository
 * root is resolved once from this file's own location and everything else hangs off it.
 */
const REPOSITORY_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..')

function repositoryPath(relative: string): string {
  return resolvePath(REPOSITORY_ROOT, relative)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION = 'ses_view_01'
const ORIGIN = 'http://127.0.0.1:43117'
const HARNESS = 'opencode'
const PENDING = 4

type CardModel = NonNullable<ReturnType<typeof buildCardModel>>

/** A real model, built by the real builder from the real class policy. */
function modelFor(eventClass: NotificationClass, repoShortName = 'agent-ping'): CardModel {
  const model = buildCardModel(
    planNotification({ class: eventClass, repoShortName, origin: ORIGIN, sessionId: SESSION }),
    PENDING,
  )
  if (model === null) throw new Error(`the ${eventClass} class must render a card`)
  return model
}

/**
 * A clock a test owns.
 *
 * Records every start so "this card started no clock" is an observation, and can run a
 * cancelled timer anyway (`runCancelled`) to prove the view's guard rather than the
 * scheduler's cooperation.
 */
interface FakeClock {
  readonly scheduler: CardExpiryScheduler
  readonly delays: number[]
  fire(index: number): void
  fireAll(): void
}

function fakeClock(options: { readonly runCancelled?: boolean } = {}): FakeClock {
  const delays: number[] = []
  const pending: { fn: () => void; cancelled: boolean }[] = []
  return {
    delays,
    scheduler: {
      schedule: (delayMs, onElapsed): CardTimer => {
        const entry = { fn: onElapsed, cancelled: false }
        delays.push(delayMs)
        pending.push(entry)
        return {
          cancel: (): void => {
            entry.cancelled = true
          },
        }
      },
    },
    fire(index): void {
      const entry = pending[index]
      if (entry === undefined) throw new Error(`no timer was started at index ${String(index)}`)
      if (entry.cancelled && options.runCancelled !== true) return
      entry.fn()
    },
    fireAll(): void {
      for (let index = 0; index < pending.length; index += 1) {
        const entry = pending[index]
        if (entry === undefined) continue
        if (entry.cancelled && options.runCancelled !== true) continue
        entry.fn()
      }
    },
  }
}

/** A reduced-motion preference a test sets, standing in for `matchMedia`. */
function motion(matches: boolean): { matchMedia: (query: string) => { matches: boolean } } {
  return { matchMedia: (): { matches: boolean } => ({ matches }) }
}

/** The element a card goes inside: the card document's own body, in production. */
const hosts: HTMLElement[] = []
function hostElement(): HTMLElement {
  const element = document.createElement('main')
  document.body.append(element)
  hosts.push(element)
  return element
}

/**
 * Render a card into a host and hand back the real element.
 *
 * The view is declared against a structural DOM, so what it returns is that seam rather
 * than a `HTMLElement`. A test reads the browser's own object, which is the whole point of
 * the seam: the assertions are made against the element a browser would produce.
 */
function renderInto(
  host: HTMLElement,
  eventClass: NotificationClass = 'needs-you',
  cell = cardLifetimeFor(eventClass),
  motionPreference?: { matchMedia: (query: string) => { matches: boolean } },
): HTMLElement {
  // The one cast in this file. The view is declared against a structural DOM, so what it
  // returns is that seam; a test reads the browser's own element, which is the whole point
  // of the seam - the assertions are made against what a browser would actually produce.
  const element = renderCardElement(modelFor(eventClass), cell, {
    document,
    ...(motionPreference === undefined ? {} : { motion: motionPreference }),
  }) as unknown as HTMLElement
  host.append(element)
  return element
}

afterEach(() => {
  document.body.replaceChildren()
  hosts.length = 0
})

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

describe('the seam is satisfied by a real document', () => {
  it("accepts the browser's own document, element and body", () => {
    // These three assignments are a compile-time statement - the reason the structural
    // declarations may not drift into a shape no browser provides - and the run-time
    // lines after them are what keep a broken seam from passing as unreachable.
    const realDocument: CardDocument = document
    const realElement: CardElement = document.createElement('article')
    const realBody: CardElement = document.body
    expect(typeof realDocument.createElement).toBe('function')
    expect(realElement.nodeType).toBe(1)
    expect(realBody.nodeType).toBe(1)
  })

  it("finds this environment's own document when none is supplied", () => {
    // The production path: the card document's script passes nothing and renders into
    // the page it was loaded into.
    const rendered = renderCardElement(modelFor('needs-you'), cardLifetimeFor('needs-you'))
    expect(rendered.getAttribute(CARD_ROOT_ATTRIBUTE)).toBe('')
  })

  it('refuses to render with a named error rather than a TypeError from three frames later', () => {
    // A `createElement is not a function` says nothing; this says the card has nowhere to
    // be drawn and why that matters. And a document that was supplied and cannot draw is a
    // caller's mistake, so it is reported rather than quietly replaced by the ambient one.
    expect(() =>
      renderCardElement(modelFor('needs-you'), cardLifetimeFor('needs-you'), { document: {} as CardDocument }),
    ).toThrow(/`document` supplied to the card view cannot create elements/)
    expect(() =>
      renderCardElement(modelFor('needs-you'), cardLifetimeFor('needs-you'), { document: {} as CardDocument }),
    ).toThrow(/NT-FR-02/)
  })
})

// ---------------------------------------------------------------------------
// Criteria 3, 4 and 5: the rendered card
// ---------------------------------------------------------------------------

describe('the rendered card', () => {
  it('is a real element tree of real text, with the two lines the policy decided', () => {
    const card = renderInto(hostElement())
    expect(card.tagName).toBe('ARTICLE')
    expect(card.querySelector(`[${CARD_TITLE_ATTRIBUTE}]`)?.textContent).toBe('agent-ping')
    expect(card.querySelector(`[${CARD_BODY_ATTRIBUTE}]`)?.textContent).toBe(
      'A session is blocked and needs a decision from you.',
    )
  })

  it('is the icon, the word, the title and the body, in that order, and nothing else', () => {
    // The order is the reading order, and the count of children is the "two lines, no
    // stack of text, no button" rule: a card with a fifth element in it is a card that
    // grew something nobody asked for.
    const card = renderInto(hostElement())
    const kindOf = (child: Element): string => {
      if (child.hasAttribute(CARD_URGENCY_ICON_ATTRIBUTE)) return 'icon'
      if (child.hasAttribute(CARD_URGENCY_WORD_ATTRIBUTE)) return 'word'
      if (child.hasAttribute(CARD_TITLE_ATTRIBUTE)) return 'title'
      if (child.hasAttribute(CARD_BODY_ATTRIBUTE)) return 'body'
      return 'something-else'
    }
    expect([...card.children].map(kindOf)).toEqual(['icon', 'word', 'title', 'body'])
    expect(card.children).toHaveLength(4)
  })

  it('writes the title as text and never as markup', () => {
    // A repository called `<b>agent-ping</b>` is a repository name, not markup. The card
    // builds text nodes and never parses HTML, so there is nothing to inject into.
    const card = renderInto(hostElement(), 'needs-you', cardLifetimeFor('needs-you'))
    const title = card.querySelector(`[${CARD_TITLE_ATTRIBUTE}]`)
    expect(title?.textContent).toBe('agent-ping')
    expect(card.querySelector('b')).toBeNull()
  })

  it('writes a title that looks like markup as text all the same', () => {
    const host = hostElement()
    const element = renderCardElement(modelFor('needs-you', '<b>agent-ping<em>'), cardLifetimeFor('needs-you'), {
      document,
    }) as unknown as HTMLElement
    host.append(element)
    const title = element.querySelector(`[${CARD_TITLE_ATTRIBUTE}]`) as HTMLElement
    expect(title.textContent).toBe('<b>agent-ping<em>')
    expect(title.children).toHaveLength(0)
    expect(host.querySelector('b')).toBeNull()
  })

  it('is focusable', () => {
    const card = renderInto(hostElement())
    // `tabindex` is the only way to say "this can be reached", and a real focus call is
    // what proves the attribute is honoured rather than merely present.
    expect(card.getAttribute('tabindex')).toBe('0')
    card.focus()
    expect(document.activeElement).toBe(card)
  })

  it('exposes a role and a live politeness', () => {
    // The host window is deliberately unfocusable so a card cannot take a keystroke, so
    // the live region is the only channel a screen reader has for a card that appears.
    const blocked = renderInto(hostElement(), 'needs-you')
    expect(blocked.getAttribute('role')).toBe(CARD_ROLE)
    expect(blocked.getAttribute('aria-live')).toBe('assertive')
    const finished = renderInto(hostElement(), 'finished')
    expect(finished.getAttribute('role')).toBe(CARD_ROLE)
    // A card about work that ended must not interrupt a screen reader mid-sentence, which
    // is the same mistake as stealing a keystroke.
    expect(finished.getAttribute('aria-live')).toBe('polite')
  })

  it('exposes an accessible name built from the same three things it shows', () => {
    const model = modelFor('needs-you')
    const card = renderInto(hostElement())
    expect(card.getAttribute('aria-label')).toBe(cardAccessibleName(model))
    // The label duplicates the visible text rather than replacing it, so a screen reader
    // and a person are told the same thing in the same order.
    for (const part of [cardUrgency(model.urgency).word, model.title, model.body]) {
      expect(card.textContent).toContain(part)
      expect(card.getAttribute('aria-label')).toContain(part)
    }
  })
})

describe('the card writes no inline style', () => {
  it('leaves no style attribute and no CSSOM state on any element it built', () => {
    // Criterion 5, at run time. The hub sends `style-src 'self'` with no `unsafe-inline`,
    // so an inline style here would not be untidy - it would render as nothing at all.
    const host = hostElement()
    renderInto(host, 'finished')
    const elements = [host, ...host.querySelectorAll<HTMLElement>('*')]
    expect(elements).toHaveLength(6)
    for (const element of elements) {
      expect(element.getAttribute('style')).toBeNull()
      expect(element.style.length).toBe(0)
    }
    expect(host.querySelector('style')).toBeNull()
    expect(host.innerHTML).not.toMatch(/style=/)
  })

  it('has no way to write one in its source either', () => {
    // The run-time half checks the tree this module produced; this checks that there is
    // no second path into an inline style a future edit could take.
    const source = readModuleWithoutProse('src/notify/surface/card-view.ts')
    for (const forbidden of ['.style', 'cssText', 'setProperty(', "setAttribute('style'", 'style=', 'innerHTML']) {
      expect(source.includes(forbidden), `card-view.ts must not contain ${forbidden}`).toBe(false)
    }
    // Every write to the document is an attribute or text, which is the whole claim.
    expect(source).toContain('setAttribute(')
    expect(source).toContain('textContent =')
  })
})

describe('urgency is an icon and a word as well as a colour', () => {
  it('carries a glyph, a word and the token, as three separate things', () => {
    const model = modelFor('needs-you')
    const card = renderInto(hostElement())
    const icon = card.querySelector(`[${CARD_URGENCY_ICON_ATTRIBUTE}]`)
    const word = card.querySelector(`[${CARD_URGENCY_WORD_ATTRIBUTE}]`)
    expect(icon?.textContent).toBe(cardUrgency(model.urgency).icon)
    expect(word?.textContent).toBe(cardUrgency(model.urgency).word)
    expect(card.getAttribute(CARD_URGENCY_ATTRIBUTE)).toBe(model.urgency)
    // The glyph is hidden from assistive technology because the word beside it says the
    // same thing: "exclamation mark, needs you" is noise to somebody trying to work.
    expect(icon?.getAttribute('aria-hidden')).toBe('true')
    expect(word?.getAttribute('aria-hidden')).toBeNull()
  })

  it('changes all three channels between the two classes that render', () => {
    const blocked = renderInto(hostElement(), 'needs-you')
    const finished = renderInto(hostElement(), 'finished')
    for (const attribute of [CARD_URGENCY_ATTRIBUTE, CARD_URGENCY_ICON_ATTRIBUTE, CARD_URGENCY_WORD_ATTRIBUTE]) {
      const read = (card: HTMLElement): string | null =>
        card.querySelector(`[${attribute}]`)?.textContent ?? card.getAttribute(attribute)
      expect(read(blocked)).not.toBe(read(finished))
    }
  })
})

describe('the card is exactly the two lines and the urgency', () => {
  it('carries the repository short name and one sentence, and no count', () => {
    // Criterion 3, asserted on what the document shows. The model knows the count - four
    // outstanding blocks - and the card says nothing about it: a number in a card is a
    // second place a count exists, wrong the moment a second block arrives, and the badge
    // already carries it properly (NT-FR-06, PRD 16 Open Question 3).
    const card = renderInto(hostElement())
    const text = card.textContent ?? ''
    expect(text).toContain('agent-ping')
    expect(text).toContain('A session is blocked and needs a decision from you.')
    expect(text).not.toMatch(/\d/)
    for (const attribute of [...card.attributes]) {
      expect(new RegExp(`(^|\\D)${String(PENDING)}(\\D|$)`).test(attribute.value), `${attribute.name} carries the count`).toBe(false)
    }
  })

  it('carries no path, no session identifier and no harness name as text', () => {
    const card = renderInto(hostElement(), 'needs-you')
    const text = card.textContent ?? ''
    expect(text).not.toContain('/')
    expect(text).not.toContain(SESSION)
    expect(text).not.toContain(HARNESS)
    expect(text).not.toMatch(/session=|http|\.ts\b|\.js\b/)
  })

  it('carries the deep link as an attribute and never as text or a control', () => {
    const card = renderInto(hostElement())
    expect(card.getAttribute(CARD_DEEP_LINK_ATTRIBUTE)).toBe(
      'http://127.0.0.1:43117/?session=ses_view_01',
    )
    // Not as text, and not as a link somebody could click into: the card has no buttons,
    // and the deep link the tray and the dashboard share is not the card's to follow.
    expect(card.textContent ?? '').not.toContain('session=')
    expect(card.querySelector('a')).toBeNull()
    expect(card.querySelector('button')).toBeNull()
    expect(card.innerHTML).not.toMatch(/href/)
  })

  it('carries the lifetime it was rendered under, and the interval only when there is one', () => {
    const blocked = renderInto(hostElement(), 'needs-you')
    expect(blocked.getAttribute(CARD_LIFETIME_ATTRIBUTE)).toBe('until-resolved')
    // The absence of this attribute is the statement that nothing will time a block out
    // and nothing will bring it back (NT-FR-08).
    expect(blocked.hasAttribute(CARD_EXPIRES_ATTRIBUTE)).toBe(false)

    const finished = renderInto(hostElement(), 'finished')
    expect(finished.getAttribute(CARD_LIFETIME_ATTRIBUTE)).toBe('expires')
    expect(finished.getAttribute(CARD_EXPIRES_ATTRIBUTE)).toBe(String(FINISHED_CARD_EXPIRES_IN_MS))
  })
})

describe('the card is a document, not a canvas and not a mirror', () => {
  it('has no canvas, no second copy of its text and no hidden copy of itself', () => {
    // ADR-012: the card is DOM, so APX-CON-07's canvas-plus-mirror obligation does not
    // apply to it - and a mirror added out of habit would be the defect this decision
    // closed. One decorative icon is hidden from assistive technology; nothing else is.
    const card = renderInto(hostElement())
    expect(card.querySelector('canvas')).toBeNull()
    expect(card.querySelector('svg')).toBeNull()
    expect(card.querySelector('img')).toBeNull()
    // The repository name appears once. A mirror is a second copy of it, hidden or not,
    // and this is what "no mirror" means in a test.
    expect((card.textContent ?? '').split('agent-ping')).toHaveLength(2)
    const hidden = [...card.querySelectorAll('[aria-hidden="true"]')]
    expect(hidden).toHaveLength(1)
    expect(hidden[0]?.hasAttribute(CARD_URGENCY_ICON_ATTRIBUTE)).toBe(true)
  })
})

describe('reduced motion', () => {
  it('marks a card instant when the preference asks for it, and animated otherwise', () => {
    const instant = renderInto(hostElement(), 'needs-you', cardLifetimeFor('needs-you'), motion(true))
    expect(instant.getAttribute(CARD_MOTION_ATTRIBUTE)).toBe(CARD_MOTION_MODES.instant)
    const animated = renderInto(hostElement(), 'needs-you', cardLifetimeFor('needs-you'), motion(false))
    expect(animated.getAttribute(CARD_MOTION_ATTRIBUTE)).toBe(CARD_MOTION_MODES.animated)
  })

  it('reads the preference at render time, not once at some earlier moment', () => {
    // A developer who turns reduced motion on expects the next card, not a reload.
    const preference = { matches: false }
    const source = { matchMedia: (): { matches: boolean } => ({ matches: preference.matches }) }
    const first = renderInto(hostElement(), 'needs-you', cardLifetimeFor('needs-you'), source)
    expect(first.getAttribute(CARD_MOTION_ATTRIBUTE)).toBe(CARD_MOTION_MODES.animated)
    preference.matches = true
    const second = renderInto(hostElement(), 'needs-you', cardLifetimeFor('needs-you'), source)
    expect(second.getAttribute(CARD_MOTION_ATTRIBUTE)).toBe(CARD_MOTION_MODES.instant)
  })

  it('asks the same media query the dashboard asks, so the copy cannot drift', () => {
    // The two modules cannot import one another - this one is Node-hosted and compiled
    // with no DOM library - so the shared string is asserted equal instead.
    expect(CARD_REDUCED_MOTION_QUERY).toBe(REDUCED_MOTION_MEDIA_QUERY)
    const asked: string[] = []
    cardPrefersReducedMotion({
      matchMedia: (query) => {
        asked.push(query)
        return { matches: false }
      },
    })
    expect(asked).toEqual([CARD_REDUCED_MOTION_QUERY])
  })

  it('answers "not reduced" when there is no preference to read', () => {
    // A source with no `matchMedia` at all is a normal environment, not a failure.
    expect(cardPrefersReducedMotion(null)).toBe(false)
    expect(cardPrefersReducedMotion({})).toBe(false)
    expect(cardPrefersReducedMotion({ matchMedia: () => null })).toBe(false)
    expect(cardPrefersReducedMotion({ matchMedia: () => undefined })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Criterion 6: removal
// ---------------------------------------------------------------------------

describe('a card is removed from the document when its lifetime ends', () => {
  it("is removed when a finished card's interval elapses", () => {
    const host = hostElement()
    const clock = fakeClock()
    const ends: CardEnd[] = []
    const view = createCardView({
      parent: host,
      document,
      scheduler: clock.scheduler,
      onEnd: (end): void => {
        ends.push(end)
      },
    })
    view.show(modelFor('finished'), cardLifetimeFor('finished'))
    const card = host.firstElementChild as HTMLElement
    expect(clock.delays).toEqual([FINISHED_CARD_EXPIRES_IN_MS])
    expect(card.isConnected).toBe(true)

    clock.fireAll()
    expect(ends).toEqual(['expired'])
    expect(card.isConnected).toBe(false)
    expect(card.parentElement).toBeNull()
    expect(host.childElementCount).toBe(0)
    expect(host.innerHTML).toBe('')
    expect(view.showing).toBe(false)
    expect(view.current).toBeNull()
    expect(view.currentLifetime).toBeNull()
  })

  it('is removed when the block is resolved, and when it is acknowledged', () => {
    for (const end of ['resolved', 'acknowledged'] as const) {
      const host = hostElement()
      const ends: CardEnd[] = []
      const view = createCardView({
        parent: host,
        document,
        scheduler: fakeClock().scheduler,
        onEnd: (one): void => {
          ends.push(one)
        },
      })
      view.show(modelFor('needs-you'), cardLifetimeFor('needs-you'))
      const card = host.firstElementChild as HTMLElement
      view.remove(end)
      expect(ends).toEqual([end])
      expect(card.isConnected).toBe(false)
      expect(host.innerHTML).toBe('')
      // Idempotent: a hub that acknowledges twice must not report two removals.
      view.remove(end)
      expect(ends).toEqual([end])
    }
  })

  it('stays on the screen for a needs-you card however long a clock runs', () => {
    // The heart of NT-FR-08. There is no interval to elapse, so there is nothing that
    // could take the card away while the block is still a block, and nothing that could
    // bring it back afterwards.
    const host = hostElement()
    const clock = fakeClock()
    const ends: CardEnd[] = []
    const view = createCardView({
      parent: host,
      document,
      scheduler: clock.scheduler,
      onEnd: (end): void => {
        ends.push(end)
      },
    })
    view.show(modelFor('needs-you'), cardLifetimeFor('needs-you'))
    const card = host.firstElementChild as HTMLElement

    expect(clock.delays).toEqual([])
    clock.fireAll()
    expect(card.isConnected).toBe(true)
    expect(host.childElementCount).toBe(1)
    expect(ends).toEqual([])
  })

  it('cancels the pending expiry when the card is taken off the screen for another reason', () => {
    // A real timer left running after its card has gone would fire in a process nobody is
    // watching, and in a test would remove whatever had taken its place.
    const host = hostElement()
    const clock = fakeClock()
    const ends: CardEnd[] = []
    const view = createCardView({
      parent: host,
      document,
      scheduler: clock.scheduler,
      onEnd: (end): void => {
        ends.push(end)
      },
    })
    view.show(modelFor('finished'), cardLifetimeFor('finished'))
    view.remove('destroyed')
    clock.fireAll()
    expect(ends).toEqual(['destroyed'])
    expect(host.innerHTML).toBe('')
  })
})

describe('a card is removed from the document when the host is destroyed', () => {
  it('takes the card with it, and renders nothing afterwards', () => {
    const host = hostElement()
    const clock = fakeClock()
    const ends: CardEnd[] = []
    const view = createCardView({
      parent: host,
      document,
      scheduler: clock.scheduler,
      onEnd: (end): void => {
        ends.push(end)
      },
    })
    view.show(modelFor('finished'), cardLifetimeFor('finished'))
    const card = host.firstElementChild as HTMLElement

    view.destroy()
    expect(ends).toEqual(['destroyed'])
    expect(card.isConnected).toBe(false)
    expect(card.parentElement).toBeNull()
    expect(host.innerHTML).toBe('')
    expect(view.showing).toBe(false)

    // Nothing after the host is gone: a card outliving the window that promised it would
    // carry a deep link that can no longer be resolved (NT-FR-04, HC-FR-10). The timer
    // count is asserted too, because a card that rendered without a clock is not a card.
    view.show(modelFor('needs-you'), cardLifetimeFor('needs-you'))
    expect(host.innerHTML).toBe('')
    expect(view.showing).toBe(false)
    expect(clock.delays).toEqual([FINISHED_CARD_EXPIRES_IN_MS])
    // And destroying twice is one destroy.
    view.destroy()
    expect(ends).toEqual(['destroyed'])
  })

  it('destroys a card that was never shown, doing nothing at all', () => {
    const host = hostElement()
    const ends: CardEnd[] = []
    const view = createCardView({
      parent: host,
      document,
      scheduler: fakeClock().scheduler,
      onEnd: (end): void => {
        ends.push(end)
      },
    })
    view.remove('resolved')
    view.destroy()
    expect(ends).toEqual([])
    expect(host.innerHTML).toBe('')
  })
})

describe('one card at a time', () => {
  it('replaces the previous card rather than stacking a second one', () => {
    const host = hostElement()
    const ends: CardEnd[] = []
    const view = createCardView({
      parent: host,
      document,
      scheduler: fakeClock().scheduler,
      onEnd: (end): void => {
        ends.push(end)
      },
    })
    view.show(modelFor('finished'), cardLifetimeFor('finished'))
    const first = host.firstElementChild as HTMLElement
    view.show(modelFor('needs-you'), cardLifetimeFor('needs-you'))
    const second = host.firstElementChild as HTMLElement

    expect(host.childElementCount).toBe(1)
    expect(first.isConnected).toBe(false)
    expect(second.isConnected).toBe(true)
    expect(second).not.toBe(first)
    expect(ends).toEqual(['replaced'])
    expect(view.current).toEqual(modelFor('needs-you'))
    expect(view.currentLifetime).toEqual(cardLifetimeFor('needs-you'))
  })

  it("does not let a replaced card's timer take the new one with it", () => {
    // A deliberately badly-behaved scheduler that runs a timer after its cancel. The
    // view's own guard is what stops a cancelled card from ending its replacement, and
    // this is the only way to observe that guard rather than the scheduler's cooperation.
    const host = hostElement()
    const clock = fakeClock({ runCancelled: true })
    const ends: CardEnd[] = []
    const view = createCardView({
      parent: host,
      document,
      scheduler: clock.scheduler,
      onEnd: (end): void => {
        ends.push(end)
      },
    })
    view.show(modelFor('finished'), cardLifetimeFor('finished'))
    view.show(modelFor('needs-you'), cardLifetimeFor('needs-you'))

    clock.fireAll()
    expect(host.childElementCount).toBe(1)
    expect(ends).toEqual(['replaced'])
  })

  it('renders nothing at all for a cell that is never rendered', () => {
    // An fyi takes nothing off the screen: it must not dismiss a needs-you block that is
    // still waiting for a decision, and it must not appear itself (NT-FR-02, ADR-004).
    const host = hostElement()
    const clock = fakeClock()
    const ends: CardEnd[] = []
    const view = createCardView({
      parent: host,
      document,
      scheduler: clock.scheduler,
      onEnd: (end): void => {
        ends.push(end)
      },
    })
    view.show(modelFor('needs-you'), cardLifetimeFor('needs-you'))

    view.show(modelFor('finished'), cardLifetimeFor('fyi'))
    expect(host.childElementCount).toBe(1)
    expect(host.textContent).toContain('agent-ping')
    expect(ends).toEqual([])

    // And an fyi on an empty surface draws nothing at all, and starts no clock.
    view.destroy()
    view.show(modelFor('finished'), cardLifetimeFor('fyi'))
    expect(host.innerHTML).toBe('')
    expect(view.showing).toBe(false)
    expect(clock.delays).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The ends, and the module's own prohibitions
// ---------------------------------------------------------------------------

describe('the view holds no audio, no notification call, no socket and no repeat timer', () => {
  it('has no such call in its source', () => {
    // The per-file half of NT-FR-11 and APX-CON-04. The sweep over the whole notification
    // path is tests/notify/surface-card.test.ts; this is the check that stays with the
    // file that draws the card.
    const source = readModuleWithoutProse('src/notify/surface/card-view.ts')
    for (const forbidden of [
      'Audio(',
      '<audio',
      'new Notification',
      'requestPermission',
      'fetch(',
      'XMLHttpRequest',
      'WebSocket',
      'setInterval',
      'setTimeout',
      'requestAnimationFrame',
    ]) {
      expect(source.includes(forbidden), `card-view.ts must not contain ${forbidden}`).toBe(false)
    }
    // The one clock it starts belongs to the lifetime table, by name.
    expect(source).toContain('armCardExpiry(')
  })

  it('re-exports the ends from the one module that defines them', () => {
    // So the hub's acknowledgement wiring needs one import and the two lists cannot be
    // two lists.
    expect(CARD_ENDS).toEqual(POLICY_CARD_ENDS)
  })
})

// ---------------------------------------------------------------------------
// Fixtures used above, and the source reader
// ---------------------------------------------------------------------------

/**
 * One product source file with its comments removed and its strings kept.
 *
 * Comments go because the check is about the calls a module makes, and this repository's
 * prose names every forbidden thing it deliberately avoids. Strings stay, because a
 * forbidden name is most often only ever a string. Newlines are preserved so a failure's
 * line numbers still point at the line being looked at.
 */
function readModuleWithoutProse(relative: string): string {
  const source = readFileSync(repositoryPath(relative), 'utf8')
  let out = ''
  let index = 0
  const blank = (length: number): void => {
    for (let offset = 0; offset < length; offset += 1) out += source[index + offset] === '\n' ? '\n' : ' '
  }
  while (index < source.length) {
    const pair = source.slice(index, index + 2)
    if (pair === '//') {
      let end = source.indexOf('\n', index)
      if (end === -1) end = source.length
      blank(end - index)
      index = end
      continue
    }
    if (pair === '/*') {
      const found = source.indexOf('*/', index + 2)
      const stop = found === -1 ? source.length : found + 2
      blank(stop - index)
      index = stop
      continue
    }
    const character = source[index] ?? ''
    if (character === "'" || character === '"' || character === '`') {
      let cursor = index + 1
      while (cursor < source.length) {
        const inner = source[cursor]
        if (inner === '\\') {
          cursor += 2
          continue
        }
        if (inner === character || inner === '\n') break
        cursor += 1
      }
      const stop = Math.min(cursor + 1, source.length)
      out += source.slice(index, stop)
      index = stop
      continue
    }
    out += character
    index += 1
  }
  return out
}
