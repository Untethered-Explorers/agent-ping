// The card's lifetime policy: one cell per class, no re-arm, one fixed interval
// (NT-FR-02, NT-FR-08, NT-FR-10, ADR-004, ADR-012).
//
//   npm test -- tests/notify/surface-lifetime.test.ts
//
// THE SEVEN ACCEPTANCE CRITERIA OF NT-7, AND WHERE EACH IS PROVEN
//
//   1. "A test asserts the lifetime table carries a cell for every class and throws for
//      a class it does not carry rather than defaulting."
//      `the table is total over the class union` and `throws for a class it does not
//      carry`. The keys are compared against the classifier's own three classes rather
//      than against a copy of them, the count of rendered cells is asserted, and the
//      throw is asserted for a class the union cannot produce - which is the only way to
//      ask for a default.
//
//   2. "A test asserts the needs-you cell contains no re-arming timer and the finished
//      cell expires on a fixed interval."
//      `the needs-you cell contains no re-arming timer` (three ways: the cell's data, the
//      only function that can start a clock refusing to arm it, and the table's own
//      source holding no callable and no timer) and `the finished cell expires on a fixed
//      interval`.
//
//   3. "A test asserts a rendered card carries the repository short name and one sentence
//      and no count, path, session identifier or harness name."
//      Not here: this file renders nothing. It is tests/notify/surface-card.test.ts for
//      the model and tests/notify/surface-card-view.test.ts for the rendered text.
//
//   4. "A test asserts the card view is focusable, exposes a role and an accessible
//      name, and encodes urgency with an icon and a word as well as colour."
//      tests/notify/surface-card-view.test.ts.
//
//   5. "A test asserts the view writes no inline style."
//      tests/notify/surface-card-view.test.ts, at the level of the rendered subtree and
//      at the level of the module's source.
//
//   6. "A test asserts a card is removed from the document when its lifetime ends and
//      when the host is destroyed."
//      tests/notify/surface-card-view.test.ts.
//
//   7. "A test asserts no notification API call, no audio element, no notify-send,
//      osascript or powershell string and no inline style exists anywhere under
//      src/notify."
//      tests/notify/surface-card.test.ts, which owns the sweep over the whole
//      notification path so one suite answers it for every module.
//
// AROUND THOSE:
//   - The cells are data. A recursive walk asserts no value in the table is callable,
//     which is the structural form of "there is no timer in the needs-you cell" - there
//     is nowhere in a cell for one to go.
//   - Every `CardEnd` is produced by something: the cells' own ends plus the two this
//     product produces, with nothing spare and nothing unreachable.
//   - The default scheduler is a real timer, cancelled for real, because a test that
//     only ever used a fake would not know the real one cancels.
//
// Nothing in this file starts Electron, opens a socket, reads a clock it did not
// receive, or renders anything. It is a table and one clock, and it says so.

import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CARD_ENDS,
  CARD_LIFETIMES,
  FINISHED_CARD_EXPIRES_IN_MS,
  armCardExpiry,
  cardLifetimeFor,
  rendersCard,
  timerCardScheduler,
  type CardEnd,
  type CardExpiryScheduler,
  type CardLifetimeCell,
  type CardTimer,
} from '@/notify/surface/lifetime'
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

/**
 * A clock a test owns: nothing fires until the test says so.
 *
 * Records every start, so "this cell started no clock" is an observation rather than an
 * absence, and can be run again by `fireAll` to check a cancelled timer that a
 * deliberately badly-behaved scheduler still runs.
 */
interface FakeClock {
  readonly scheduler: CardExpiryScheduler
  /** Delays passed to `schedule`, in the order they were started. */
  readonly delays: number[]
  /** Run every timer started so far, cancelled ones included. */
  fireAll(): void
  /** Run the timer started at `index`, cancelled or not. */
  fire(index: number): void
}

function fakeClock(options: { readonly runCancelled?: boolean } = {}): FakeClock {
  const delays: number[] = []
  const pending: { readonly fn: () => void; cancelled: boolean }[] = []
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

/** The three classes this product classifies into, as a value rather than a copy. */
const CLASSES: readonly NotificationClass[] = Object.freeze([
  'needs-you',
  'finished',
  'fyi',
] as const)

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Criterion 1: totality
// ---------------------------------------------------------------------------

describe('the table is total over the class union', () => {
  it('carries a cell for every class, and no cell for anything else', () => {
    expect(Object.keys(CARD_LIFETIMES).sort()).toEqual([...CLASSES].sort())
    for (const eventClass of CLASSES) {
      const cell = cardLifetimeFor(eventClass)
      // Restated in the cell, so a cell filed under the wrong class is visible rather
      // than merely reachable by the right key.
      expect(cell.class).toBe(eventClass)
    }
  })

  it('renders a card for exactly the two classes that leave the app', () => {
    const rendered = CLASSES.filter((eventClass) => rendersCard(cardLifetimeFor(eventClass)))
    expect(rendered).toEqual(['needs-you', 'finished'])
    expect(rendersCard(cardLifetimeFor('fyi'))).toBe(false)
  })

  it('renders a cell only when it also names at least one end, so a card cannot be unremovable', () => {
    // The two halves of "a card is shown" and "a card can be taken away" agreeing is a
    // property of the table rather than of any caller: a cell that rendered and had no end
    // would be a card that could only be left by a process exit. Asked of a synthetic cell
    // rather than of today's three, so the answer is a rule and not a coincidence.
    const unremovable = { ...cardLifetimeFor('needs-you'), ends: [] } as CardLifetimeCell
    expect(rendersCard(unremovable)).toBe(false)
    for (const eventClass of CLASSES) {
      const cell = cardLifetimeFor(eventClass)
      if (rendersCard(cell)) expect(cell.ends.length).toBeGreaterThan(0)
    }
  })

  it('throws for a class it does not carry rather than defaulting', () => {
    // A default would be a fourth way a card could live, which is the shape NT-FR-08
    // and ADR-004 are about. The cast is deliberate: this asks the question the union
    // normally prevents, and the answer has to be a throw rather than a card.
    expect(() => cardLifetimeFor('shouting' as NotificationClass)).toThrow(/unhandled card lifetime class/)
    expect(() => cardLifetimeFor('shouting' as NotificationClass)).toThrow(/"shouting"/)
    expect(() => cardLifetimeFor(undefined as unknown as NotificationClass)).toThrow(/unhandled card lifetime class/)
    // And the message says what to fix, because a throw nobody can act on is a crash.
    expect(() => cardLifetimeFor('' as NotificationClass)).toThrow(/CARD_LIFETIMES must carry every class/)
  })

  it('is frozen, and frozen all the way down', () => {
    expect(Object.isFrozen(CARD_LIFETIMES)).toBe(true)
    for (const eventClass of CLASSES) {
      const cell = cardLifetimeFor(eventClass)
      expect(Object.isFrozen(cell)).toBe(true)
      expect(Object.isFrozen(cell.ends)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// The cells are data, and there is nowhere for a timer to go
// ---------------------------------------------------------------------------

describe('the cells hold data and no behaviour', () => {
  it('contains no function value anywhere in the table', () => {
    // The structural half of NT-FR-08. A cell that carried a callback could carry a
    // re-arm; this asserts at run time, over every value of every cell, that none does.
    const seen: string[] = []
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'function') {
        seen.push(path)
        return
      }
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${String(index)}]`))
        return
      }
      if (value !== null && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
          walk(entry, `${path}.${key}`)
        }
      }
    }
    walk(CARD_LIFETIMES, 'CARD_LIFETIMES')
    expect(seen).toEqual([])
  })

  it('declares every cell as never repeating, and the type admits no other value', () => {
    for (const eventClass of CLASSES) {
      expect(cardLifetimeFor(eventClass).repeat).toBe('never')
    }
    // The source of the declaration, because a cell that could say 'sometimes' would not
    // be caught by asserting today's values: the union has to have one member.
    const source = readModuleWithoutProse('src/notify/surface/lifetime.ts')
    expect(source).toContain("readonly repeat: 'never'")
    expect(source).not.toMatch(/repeat:\s*'(?!never)[a-z-]+'/)
  })

  it('writes the table as a frozen literal with no callable and no timer in it', () => {
    // Read from the module's own source rather than trusted: the table's definition is
    // the claim, and a claim a comment can edit is not a claim.
    const source = readModuleWithoutProse('src/notify/surface/lifetime.ts')
    const start = source.indexOf('export const CARD_LIFETIMES')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('export function cardLifetimeFor', start)
    const table = source.slice(start, end)
    expect(table).toContain('Object.freeze(')
    for (const forbidden of ['=>', 'function', 'setTimeout', 'setInterval', 'setImmediate', 'schedule', 'Promise']) {
      expect(table.includes(forbidden), `CARD_LIFETIMES must not contain ${forbidden}`).toBe(false)
    }
  })

  it('starts a clock in exactly one place, through the scheduler argument', () => {
    const source = readModuleWithoutProse('src/notify/surface/lifetime.ts')
    // One call site, so "one needs-you card per block" is a property of the module
    // rather than of any one code path reading it.
    expect([...source.matchAll(/scheduler\.schedule\(/g)]).toHaveLength(1)
    expect([...source.matchAll(/\bsetInterval\b/g)]).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Criterion 2: the needs-you cell has no re-arming timer
// ---------------------------------------------------------------------------

describe('the needs-you cell contains no re-arming timer', () => {
  const needsYou = (): CardLifetimeCell => cardLifetimeFor('needs-you')

  it('is held until the block is resolved or acknowledged, with no interval at all', () => {
    const cell = needsYou()
    expect(cell.rendered).toBe(true)
    expect(cell.lifetime).toBe('until-resolved')
    expect(cell.expiresInMs).toBeNull()
    expect(cell.ends).toEqual(['resolved', 'acknowledged'])
    expect(cell.reason).toBe('held-until-resolved')
    // Not one of the ends is a time passing. A card that ended on a clock would be a
    // card that could time out while the block was still a block.
    expect(cell.ends).not.toContain('expired')
  })

  it('cannot have an expiry armed, because the only clock refuses a cell with no interval', () => {
    const clock = fakeClock()
    const arm = armCardExpiry(needsYou(), clock.scheduler, (): void => {
      throw new Error('a needs-you card must never expire on its own')
    })
    expect(arm.armed).toBe(false)
    expect(clock.delays).toEqual([])
    // Cancelling a timer that was never started is still safe, and still does nothing.
    arm.cancel()
    clock.fireAll()
    expect(clock.delays).toEqual([])
  })

  it('cannot be re-armed by arming it again, or by asking for a different delay', () => {
    // The call signature takes a cell, not a duration, so there is no argument a caller
    // could pass to give this cell a clock. Twice is still nothing.
    const clock = fakeClock()
    armCardExpiry(needsYou(), clock.scheduler, (): void => undefined)
    armCardExpiry(needsYou(), clock.scheduler, (): void => undefined)
    expect(clock.delays).toEqual([])
  })

  it('says so in its own reasons and never names persistence as a platform hint', () => {
    // 'held-until-resolved' rather than a platform's 'resident': the persistence is
    // this product's promise now, and the reason travels into a delivery outcome.
    expect(Object.values(CARD_LIFETIMES).map((cell) => cell.reason)).toEqual([
      'held-until-resolved',
      'expiring-on-a-fixed-interval',
      'never-rendered-in-app-only',
    ])
  })
})

// ---------------------------------------------------------------------------
// Criterion 2: the finished cell expires on a fixed interval
// ---------------------------------------------------------------------------

describe('the finished cell expires on a fixed interval', () => {
  const finished = (): CardLifetimeCell => cardLifetimeFor('finished')

  it('names one fixed interval, and it is a positive whole number of milliseconds', () => {
    const cell = finished()
    expect(cell.rendered).toBe(true)
    expect(cell.lifetime).toBe('expires')
    expect(cell.expiresInMs).toBe(FINISHED_CARD_EXPIRES_IN_MS)
    expect(cell.ends).toEqual(['expired'])
    expect(Number.isInteger(cell.expiresInMs)).toBe(true)
    expect(cell.expiresInMs).toBeGreaterThan(0)
    // The interval is a property of the table, not of a caller, so two reads agree.
    expect(cardLifetimeFor('finished').expiresInMs).toBe(cell.expiresInMs)
  })

  it('arms exactly one timer, for exactly that interval', () => {
    const clock = fakeClock()
    const expired: string[] = []
    const arm = armCardExpiry(finished(), clock.scheduler, () => expired.push('expired'))
    expect(arm.armed).toBe(true)
    expect(clock.delays).toEqual([FINISHED_CARD_EXPIRES_IN_MS])

    clock.fireAll()
    expect(expired).toEqual(['expired'])
    // Once. A timer that could fire twice would be a card that came back.
    clock.fireAll()
    expect(expired).toEqual(['expired'])
  })

  it('does not fire after a cancel, even when the scheduler runs the timer anyway', () => {
    // The defensive half: a scheduler that ignores its own cancel must not be able to
    // end a card that has already gone. A removed card being re-removed is the kind of
    // defect nobody finds.
    const clock = fakeClock({ runCancelled: true })
    const expired: string[] = []
    const arm = armCardExpiry(finished(), clock.scheduler, () => expired.push('expired'))
    arm.cancel()
    arm.cancel()
    clock.fireAll()
    expect(expired).toEqual([])
    // Cancelling twice is one cancel, so the underlying timer is cancelled once more
    // only if it has not been: no error, no second schedule, no exception.
    expect(clock.delays).toEqual([FINISHED_CARD_EXPIRES_IN_MS])
  })

  it('uses a real clock by default, and cancels it for real', () => {
    // The default scheduler is the only piece of this file a fake would not exercise,
    // and a fake would not catch a cancel that did not cancel. Fake timers, so the
    // timing is deterministic; real `setTimeout` underneath.
    vi.useFakeTimers()
    const fired: string[] = []
    const cancelled = armCardExpiry(finished(), timerCardScheduler, () => fired.push('cancelled'))
    const armed = armCardExpiry(finished(), timerCardScheduler, () => fired.push('armed'))
    cancelled.cancel()

    vi.advanceTimersByTime(FINISHED_CARD_EXPIRES_IN_MS)
    // The cancelled timer did not fire and the armed one did, which is the whole claim:
    // `clearTimeout` really was reached.
    expect(fired).toEqual(['armed'])
    vi.advanceTimersByTime(FINISHED_CARD_EXPIRES_IN_MS * 10)
    expect(fired).toEqual(['armed'])
    // And nothing is left pending: a real timer that outlived its card would fire in a
    // process nobody is watching, so the count is the assertion as much as the value.
    expect(vi.getTimerCount()).toBe(0)
    // Cancelling after the timer already fired is safe, and fires nothing more.
    armed.cancel()
    vi.advanceTimersByTime(FINISHED_CARD_EXPIRES_IN_MS * 10)
    expect(fired).toEqual(['armed'])
    expect(vi.getTimerCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The fyi cell
// ---------------------------------------------------------------------------

describe('the fyi cell is never rendered', () => {
  it('renders nothing, expires on nothing, and has no end because it is never shown', () => {
    const cell = cardLifetimeFor('fyi')
    expect(cell.rendered).toBe(false)
    expect(cell.lifetime).toBe('never-rendered')
    expect(cell.expiresInMs).toBeNull()
    expect(cell.ends).toEqual([])
    expect(cell.reason).toBe('never-rendered-in-app-only')
  })

  it('arms no clock either', () => {
    const clock = fakeClock()
    expect(armCardExpiry(cardLifetimeFor('fyi'), clock.scheduler, (): void => undefined).armed).toBe(false)
    expect(clock.delays).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The ends, and the reasons they exist
// ---------------------------------------------------------------------------

describe('the ends', () => {
  it('is a closed list, and every one of them is produced by something', () => {
    expect([...CARD_ENDS].sort()).toEqual(['acknowledged', 'destroyed', 'expired', 'replaced', 'resolved'])
    // The two the hub produces, the one this product's own interval produces, and the
    // two the view produces when a card is replaced or the host is destroyed. Nothing
    // spare, nothing unreachable: an end that nothing can produce would be a reason
    // recorded for something that never happened.
    const fromTheTable = Object.values(CARD_LIFETIMES).flatMap((cell) => [...cell.ends])
    const producedElsewhere: CardEnd[] = ['replaced', 'destroyed']
    expect([...new Set([...fromTheTable, ...producedElsewhere])].sort()).toEqual([...CARD_ENDS].sort())
  })

  it('is what a caller of the view can pass, re-exported from one module', async () => {
    // The view re-exports the ends so the hub's acknowledgement wiring needs one import,
    // and the two lists cannot be two lists.
    const view = await import('@/notify/surface/card-view')
    expect(view.CARD_ENDS).toEqual(CARD_ENDS)
  })
})

// ---------------------------------------------------------------------------
// The source reader
// ---------------------------------------------------------------------------

/**
 * One product source file with its comments removed.
 *
 * Two of the assertions above are about how this module's own table is *written*, not
 * about what it returns, and that needs the text. The walk tracks the three states a
 * line of TypeScript can be in - a line comment, a block comment, or a string - and
 * replaces the comment bodies with spaces, preserving newlines so a failure's line
 * numbers still point at the line being looked at. A `//` inside a string (`http://`)
 * cannot end the scan, because the scanner knows it is inside a string when it gets
 * there.
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
