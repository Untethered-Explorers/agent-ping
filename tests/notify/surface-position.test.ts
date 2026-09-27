// Where the notification card sits on a display: the pure work-area placement function
// (NT-FR-04, NT-FR-10, ADR-012).
//
//   npm test -- tests/notify/surface-position.test.ts
//
// THE ACCEPTANCE CRITERION, AND WHERE IT IS PROVEN
//
//   "A test asserts the card rectangle is computed inside the work area and never
//    overlaps its insets, for each supported corner placement."
//
//   The property is asserted, not the arithmetic: every corner of `SURFACE_CORNERS` is
//   driven against a set of work areas whose shape each defeats a different wrong
//   answer, and the rectangle is checked with `isInsideWorkArea` - the same predicate the
//   host itself uses before it will show a card. A test that restated the four formulas
//   would pass while the function was wrong; this one cannot, because the work areas
//   below were chosen so that placing against the *screen* rectangle, or ignoring an
//   inset, or ignoring a negative display origin each produces a rectangle this file
//   rejects.
//
// AROUND THAT:
//   - The constants are measured, not preferred. `CARD_SIZE` and `CARD_MARGIN` are
//     asserted to reproduce the rectangle the pre-flight actually painted on the
//     authoring machine, which is how this file is tied to evidence rather than to taste
//     (docs/research/electron-surface-preflight.json).
//   - The clamp is part of the requirement: a card can never leave the work area,
//     including on a work area smaller than the card, a zero-sized one, and one with a
//     negative origin.
//   - The corner table is total: an unhandled corner throws and names the corners it
//     holds, because a defaulted corner is a card whose position nobody chose.
//   - A placement is a pure function - same inputs, same rectangle, no clock, no display
//     and no module state - which is asserted by calling it twice and by running the
//     whole table with no display, no window manager and no Electron binary present.
//     This file is what makes the surface seam testable without a desktop (NT-FR-04).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CARD_MARGIN,
  CARD_SIZE,
  DEFAULT_SURFACE_CORNER,
  SURFACE_CORNERS,
  isInsideWorkArea,
  placeCard,
  type CardSize,
  type SurfaceCorner,
  type WorkArea,
} from '@/notify/surface/position'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The work area the pre-flight measured on the authoring machine, verbatim.
 *
 * A 32px top inset on a 1920x1080 display, which is the whole reason this file exists: a
 * placement computed against the screen rectangle would put the card at y=16, half under
 * the panel.
 */
const PREFLIGHT_WORK_AREA: WorkArea = { x: 0, y: 32, width: 1920, height: 1048 }

/** The card rectangle the pre-flight reported, verbatim. */
const PREFLIGHT_CARD_RECT = { x: 1584, y: 48, width: 320, height: 96 } as const

/**
 * Work areas that each defeat a different wrong answer.
 *
 * Every one of them is a real display arrangement somebody has: a taskbar at the bottom,
 * a dock on the left, a top panel, a second monitor to the left of the primary (negative
 * origin), a tall-and-narrow window, and a work area so small that honouring the margin
 * exactly would push the card out of it.
 */
const WORK_AREAS: readonly { readonly name: string; readonly area: WorkArea }[] = [
  { name: 'the pre-flight display, 32px top panel', area: PREFLIGHT_WORK_AREA },
  { name: 'no insets at all', area: { x: 0, y: 0, width: 1920, height: 1080 } },
  { name: 'a 48px taskbar along the bottom', area: { x: 0, y: 0, width: 1920, height: 1032 } },
  { name: 'a 64px dock down the left edge', area: { x: 64, y: 0, width: 1856, height: 1080 } },
  { name: 'panels on all four edges', area: { x: 8, y: 28, width: 1904, height: 1024 } },
  { name: 'a second monitor to the left, so a negative x', area: { x: -1920, y: 0, width: 1920, height: 1040 } },
  { name: 'a second monitor above, so a negative y', area: { x: 0, y: -1200, width: 1440, height: 900 } },
  { name: 'a small window on a small screen', area: { x: 40, y: 60, width: 360, height: 200 } },
  { name: 'a work area barely wider than the card', area: { x: 0, y: 0, width: 300, height: 400 } },
  { name: 'a work area barely taller than the card', area: { x: 0, y: 0, width: 800, height: 80 } },
  { name: 'a degenerate zero-height work area', area: { x: 0, y: 0, width: 800, height: 0 } },
  { name: 'a degenerate zero-width work area', area: { x: 12, y: 0, width: 0, height: 600 } },
]

const everyCorner = (): readonly SurfaceCorner[] => SURFACE_CORNERS

// ---------------------------------------------------------------------------
// The acceptance criterion
// ---------------------------------------------------------------------------

describe('the card rectangle, for every supported corner', () => {
  it('carries a placement for every corner SURFACE_CORNERS names', () => {
    // The list the tests enumerate and the list the default comes from are the same
    // fact, so a corner added to one and not the other fails here rather than being
    // silently unplaced.
    expect([...SURFACE_CORNERS].sort()).toEqual(['bottom-left', 'bottom-right', 'top-left', 'top-right'])
    expect(everyCorner()).toHaveLength(4)
    expect(everyCorner()).toContain(DEFAULT_SURFACE_CORNER)
  })

  for (const { name, area } of WORK_AREAS) {
    for (const corner of SURFACE_CORNERS) {
      it(`is entirely inside the work area and touches none of its insets: ${name}, ${corner}`, () => {
        const rect = placeCard(area, corner)

        expect(isInsideWorkArea(rect, area)).toBe(true)
        // Asserted as arithmetic as well as through the predicate, so a failure says which
        // edge broke rather than only that containment failed.
        expect(rect.x).toBeGreaterThanOrEqual(area.x)
        expect(rect.y).toBeGreaterThanOrEqual(area.y)
        expect(rect.x + rect.width).toBeLessThanOrEqual(area.x + area.width)
        expect(rect.y + rect.height).toBeLessThanOrEqual(area.y + area.height)
        // The inset gap: the card starts no closer to the area's edge than the margin -
        // except on an axis where the leftover space is smaller than the margin, where
        // the margin is exactly the leftover.
        expect(rect.x - area.x).toBeGreaterThanOrEqual(Math.min(CARD_MARGIN, area.width - rect.width))
        expect(rect.y - area.y).toBeGreaterThanOrEqual(Math.min(CARD_MARGIN, area.height - rect.height))
      })
    }
  }

  it('never covers a 32px top panel, which the pre-flight measured on the authoring machine', () => {
    // The concrete defect NT-FR-04 names. Placed against the screen rectangle the card's
    // top edge would be at y=16, i.e. inside the panel by 16px.
    for (const corner of SURFACE_CORNERS) {
      const rect = placeCard(PREFLIGHT_WORK_AREA, corner)
      expect(rect.y).toBeGreaterThanOrEqual(PREFLIGHT_WORK_AREA.y)
    }
    const againstTheScreen = placeCard({ x: 0, y: 0, width: 1920, height: 1080 }, 'top-right')
    expect(againstTheScreen.y).toBeLessThan(PREFLIGHT_WORK_AREA.y)
  })

  it('keeps a card inside a work area with a negative origin, where a naive y+margin goes off-screen', () => {
    const area: WorkArea = { x: -1920, y: 0, width: 1920, height: 1040 }
    const rect = placeCard(area, 'bottom-left')
    expect(rect).toEqual({ x: -1904, y: 928, width: 320, height: 96 })
    expect(isInsideWorkArea(rect, area)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The four placements, exactly
// ---------------------------------------------------------------------------

describe('each corner places the card against its own pair of edges', () => {
  const area: WorkArea = { x: 100, y: 200, width: 1000, height: 800 }
  const size: CardSize = { width: 320, height: 96 }
  const margin = 16

  it('top-left is against the top and the left', () => {
    expect(placeCard(area, 'top-left', size, margin)).toEqual({ x: 116, y: 216, width: 320, height: 96 })
  })

  it('top-right is against the top and the right', () => {
    expect(placeCard(area, 'top-right', size, margin)).toEqual({ x: 764, y: 216, width: 320, height: 96 })
  })

  it('bottom-left is against the bottom and the left', () => {
    expect(placeCard(area, 'bottom-left', size, margin)).toEqual({ x: 116, y: 888, width: 320, height: 96 })
  })

  it('bottom-right is against the bottom and the right', () => {
    expect(placeCard(area, 'bottom-right', size, margin)).toEqual({ x: 764, y: 888, width: 320, height: 96 })
  })

  it('the four corners give four distinct placements, and all four are inside the area', () => {
    const rects = SURFACE_CORNERS.map((corner) => JSON.stringify(placeCard(area, corner, size, margin)))
    expect(new Set(rects).size).toBe(4)
    for (const corner of SURFACE_CORNERS) {
      expect(isInsideWorkArea(placeCard(area, corner, size, margin), area)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// The constants are measured, not preferred
// ---------------------------------------------------------------------------

describe('CARD_SIZE and CARD_MARGIN reproduce what the pre-flight measured', () => {
  it('places the default corner at the pre-flight\'s card rectangle', () => {
    // docs/research/electron-surface-preflight.json, step
    // `card-rectangle-inside-work-area`: {"x":1584,"y":48,"width":320,"height":96}
    // inside a 1920x1048 work area at a 32px top inset.
    expect(placeCard(PREFLIGHT_WORK_AREA, DEFAULT_SURFACE_CORNER)).toEqual(PREFLIGHT_CARD_RECT)
  })

  it('names the values rather than hiding them', () => {
    expect(CARD_SIZE).toEqual({ width: 320, height: 96 })
    expect(CARD_MARGIN).toBe(16)
  })

  it('reproduces the pre-flight rectangle from the values in the probe file itself', () => {
    // Read rather than restated, so the constant above cannot drift away from the
    // evidence it claims to come from without this failing.
    const probe = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../docs/research/electron-surface-preflight.json', import.meta.url)),
        'utf8',
      ),
    ) as {
      machine: { primaryWorkArea: WorkArea }
      steps: { name: string; detail: string }[]
    }
    const step = probe.steps.find((entry) => entry.name === 'card-rectangle-inside-work-area')
    expect(step).toBeDefined()
    expect(placeCard(probe.machine.primaryWorkArea, DEFAULT_SURFACE_CORNER)).toEqual(
      JSON.parse(step?.detail ?? '{}') as unknown,
    )
  })
})

// ---------------------------------------------------------------------------
// The clamp, which is part of the requirement rather than defensiveness
// ---------------------------------------------------------------------------

describe('a card that does not fit is made to fit', () => {
  it('shrinks a card to a work area narrower than the card', () => {
    const area: WorkArea = { x: 0, y: 0, width: 200, height: 600 }
    const rect = placeCard(area, 'top-left')
    expect(rect.width).toBe(200)
    expect(rect).toEqual({ x: 0, y: 16, width: 200, height: 96 })
    expect(isInsideWorkArea(rect, area)).toBe(true)
  })

  it('collapses the margin rather than pushing a card out of a small area', () => {
    const area: WorkArea = { x: 10, y: 10, width: 60, height: 60 }
    const rect = placeCard(area, 'bottom-right')
    expect(isInsideWorkArea(rect, area)).toBe(true)
    // The margin is larger than the area, so the card sits at the area's own origin and
    // is bounded by it.
    expect(rect).toEqual({ x: 10, y: 10, width: 60, height: 60 })
  })

  it('honours a negative margin as zero rather than pushing the card past the edge', () => {
    const area: WorkArea = { x: 0, y: 0, width: 800, height: 600 }
    const rect = placeCard(area, 'top-left', CARD_SIZE, -100)
    expect(rect).toEqual({ x: 0, y: 0, width: 320, height: 96 })
    expect(isInsideWorkArea(rect, area)).toBe(true)
  })

  it('returns a degenerate but contained rectangle for a zero-height work area', () => {
    const area: WorkArea = { x: 5, y: 7, width: 800, height: 0 }
    const rect = placeCard(area, 'top-left')
    // The horizontal margin still applies - there is 480px of leftover width - while the
    // vertical one collapses to the zero height.
    expect(rect).toEqual({ x: 21, y: 7, width: 320, height: 0 })
    expect(isInsideWorkArea(rect, area)).toBe(true)
  })

  it('shrinks a card the caller asked to be larger than the whole screen', () => {
    const area: WorkArea = { x: 0, y: 0, width: 1920, height: 1080 }
    const rect = placeCard(area, 'bottom-right', { width: 4000, height: 2000 }, 0)
    expect(rect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
    expect(isInsideWorkArea(rect, area)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The corner table is total
// ---------------------------------------------------------------------------

describe('a corner the table does not carry', () => {
  it('throws and names the corners it does carry, rather than defaulting to one', () => {
    // A defaulted corner is a card in a position nobody chose, which is the same class of
    // defect as a defaulted loudness class (src/notify/policy.ts, and ADR-004).
    expect(() => placeCard(PREFLIGHT_WORK_AREA, 'centre' as SurfaceCorner)).toThrow(
      /unhandled surface corner: "centre"/,
    )
    expect(() => placeCard(PREFLIGHT_WORK_AREA, 'middle' as SurfaceCorner)).toThrow(
      /top-left, top-right, bottom-left, bottom-right/,
    )
  })
})

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe('placement is a pure function', () => {
  it('returns the identical rectangle for identical inputs, and mutates nothing', () => {
    const area: WorkArea = { x: 0, y: 32, width: 1920, height: 1048 }
    const frozenArea = Object.freeze({ ...area })
    for (const corner of SURFACE_CORNERS) {
      const first = placeCard(frozenArea, corner)
      const second = placeCard(frozenArea, corner)
      expect(second).toEqual(first)
      // The returned rectangle is a fresh object, so a caller cannot corrupt the next
      // caller's placement by writing to the last one's result.
      expect(Object.isFrozen(first)).toBe(false)
      ;(first as { x: number }).x = -9999
      expect(placeCard(frozenArea, corner)).toEqual(second)
    }
    expect(frozenArea).toEqual(area)
  })

  it('reads no display, no clock and no module state, so it needs none to be present', () => {
    // This file runs in the `node` Vitest project: no jsdom, no Electron runtime, no X
    // server, no window manager. The fact that the whole table above ran at all is the
    // assertion, and this line names the environment it ran in so a later move to a
    // DOM project cannot quietly take the seam away.
    expect(process.versions['electron']).toBeUndefined()
  })
})
