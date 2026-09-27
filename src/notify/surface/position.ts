// Where the notification surface sits on a display, as a pure function (NT-FR-04,
// NT-FR-10, ADR-012).
//
// THE ONE THING THIS FILE EXISTS TO GET RIGHT
// The work area is not the screen. A taskbar, a dock or a top panel lives in the gap
// between them, and a card placed against the screen rectangle is a card drawn over
// the developer's taskbar. So every number here comes from `workArea` - the rectangle
// the display reports as *usable* - and never from `bounds`, and the placement is
// arithmetic over that rectangle rather than anything a window manager is asked to do.
// That is what makes it testable on a machine with no display at all, which is the only
// kind of machine this repository's suite runs on.
//
// WHY A CORNER RATHER THAN A FIXED RECTANGLE
// The four corners are the whole of the choice, and they are enumerated rather than
// computed from a direction pair, so an unsupported placement is a compile error
// instead of a card that lands somewhere nobody chose. `SURFACE_CORNERS` is the list the
// tests enumerate and the one the default is drawn from, so adding a corner means
// adding it there first.
//
// THE CLAMP IS NOT DEFENSIVENESS, IT IS THE REQUIREMENT
// `placeCard` cannot return a rectangle that leaves the work area, whatever it is
// handed. A work area smaller than the card shrinks the card to fit; a work area
// smaller than the margin collapses the margin to whatever space is left, per axis, so a
// short work area cannot push a card past its own right edge. The alternative is a card
// positioned partly off a usable area, which is the same defect as a card over a
// taskbar and is exactly what a 0-height work area (a display with a panel on every
// edge) would produce.
//
// VERIFICATION STATE
// Implemented and unit-tested, and the constants below are measured rather than
// guessed: CARD_SIZE and CARD_MARGIN reproduce the card rectangle the pre-flight
// measured on the authoring machine ({"x":1584,"y":48,"width":320,"height":96} inside
// a 1920x1048 work area at a 32px top inset), which is how tests/notify/
// surface-position.test.ts ties this file to real evidence instead of to a preference.
// What is NOT verified here is how any window manager composites a transparent
// frameless window; that is NT-9's live probe and the per-platform manual steps, and
// nothing in this file is a claim about one (APX-CON-06, NT-FR-03).

/**
 * The display rectangle the platform reports as usable.
 *
 * Structurally Electron's `Rectangle`, and declared here rather than imported so this
 * file has no dependency of any kind - not even the type of a window library.
 */
export interface WorkArea {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The card's own size, in device-independent pixels. */
export interface CardSize {
  readonly width: number
  readonly height: number
}

/** A rectangle, in the same coordinate space as the `WorkArea` it came from. */
export interface CardRect extends CardSize {
  readonly x: number
  readonly y: number
}

/**
 * Where in the work area a card is placed.
 *
 * Four values, all of them usable, and no "centre" because a card in the middle of the
 * screen is a card over whatever the developer is working in.
 */
export const SURFACE_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const

/** One of `SURFACE_CORNERS`: the placement table must carry every one of them. */
export type SurfaceCorner = (typeof SURFACE_CORNERS)[number]

/**
 * The corner a card uses when nobody says otherwise.
 *
 * Top-right on purpose: it is the corner least likely to hold a work-in-progress
 * window's scrollbar or a terminal's prompt, and it is the corner the pre-flight
 * measured. The default is named so a test can assert the fallback rather than assume
 * it.
 */
export const DEFAULT_SURFACE_CORNER: SurfaceCorner = 'top-right'

/**
 * The card's size, from the pre-flight's painted content.
 *
 * Measured, not designed around: the probe reported a laid-out card of 320x96
 * (docs/research/electron-surface-preflight.json, step `card-rectangle-inside-work-area`
 * and `card-has-painted-content`). NT-7 owns what goes *inside* the card and may size it
 * to its own content; what is fixed here is the rectangle the placement arithmetic uses,
 * and a card larger than this is clamped into the work area rather than placed outside
 * it.
 */
export const CARD_SIZE: CardSize = Object.freeze({ width: 320, height: 96 })

/** The gap kept between the card and the work area's edges, in pixels. */
export const CARD_MARGIN = 16

/**
 * Place one card inside one work area at one corner.
 *
 * Total over `SurfaceCorner`: a placement the table does not carry throws rather than
 * falling back to a default, because a card that lands in a corner nobody chose is the
 * same class of surprise as a default that is never reviewed (the reasoning is
 * src/notify/policy.ts's, applied to geometry).
 *
 * Pure: no clock, no display, no module state, so tests/notify/surface-position.test.ts
 * can assert every corner against every work area shape on a machine with no screen.
 */
export function placeCard(
  workArea: WorkArea,
  corner: SurfaceCorner,
  size: CardSize = CARD_SIZE,
  margin: number = CARD_MARGIN,
): CardRect {
  // A negative margin is a caller's arithmetic mistake, and honouring it would push the
  // card past the edge rather than pull it in. Clamped, not thrown: geometry this
  // product chose for itself is not worth failing a start over.
  const wanted = Math.max(0, margin)
  // The card is never larger than the area it must fit inside. A work area of zero
  // width yields a card of zero width at the work area's own x, which is inside it -
  // degenerate, but inside, which is the property being promised.
  const width = Math.max(0, Math.min(size.width, workArea.width))
  const height = Math.max(0, Math.min(size.height, workArea.height))
  // The margin is folded per axis, and this is the line that makes the clamp total: on
  // an axis where the leftover space is smaller than the margin, the margin becomes the
  // leftover. Computing it once for both axes would let a short work area push a card
  // past its own right edge, which is the defect this file exists to prevent.
  const gapX = Math.min(wanted, workArea.width - width)
  const gapY = Math.min(wanted, workArea.height - height)
  const left = workArea.x + gapX
  const top = workArea.y + gapY
  const right = workArea.x + workArea.width - width - gapX
  const bottom = workArea.y + workArea.height - height - gapY

  switch (corner) {
    case 'top-left':
      return { x: left, y: top, width, height }
    case 'top-right':
      return { x: right, y: top, width, height }
    case 'bottom-left':
      return { x: left, y: bottom, width, height }
    case 'bottom-right':
      return { x: right, y: bottom, width, height }
    default:
      return unplacedCorner(corner)
  }
}

/**
 * Whether a rectangle lies entirely inside a work area, edges included.
 *
 * The property NT-FR-04 is actually about, named so the test can assert the property
 * rather than restate the arithmetic, and so a caller that has a rectangle from
 * somewhere else can ask the same question of it.
 */
export function isInsideWorkArea(rect: CardRect, workArea: WorkArea): boolean {
  return (
    rect.x >= workArea.x &&
    rect.y >= workArea.y &&
    rect.x + rect.width <= workArea.x + workArea.width &&
    rect.y + rect.height <= workArea.y + workArea.height
  )
}

/**
 * A corner the placement table does not carry.
 *
 * Thrown rather than defaulted, for the reason `placeCard` says. The message names the
 * table and the corners it holds, so the failure tells the caller what to add.
 */
function unplacedCorner(corner: string): never {
  throw new Error(
    `unhandled surface corner: "${corner}". The placement must be drawn from SURFACE_CORNERS ` +
      `(${SURFACE_CORNERS.join(', ')}), because a corner nobody chose is a card whose position is ` +
      'nobody\'s decision (NT-FR-04).',
  )
}
