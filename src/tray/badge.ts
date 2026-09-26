// The tray badge: what the number on the icon is, and how it is drawn
// (NT-FR-05, NT-FR-06, NT-FR-07, PRD 11, PRD 16 Open Question 11, ADR-004,
// ADR-009, APX-CON-04, APX-CON-12, APX-FR-01).
//
// WHY THE BADGE IS A SEPARATE MODULE, AND WHY IT IS PURE
// The badge is the durable signal. NT-FR-08 takes the re-fired toast away - one
// needs-you toast per block, no repeat timer - so the number on the icon is what
// carries "somebody is waiting" for as long as the block is outstanding. That makes
// this the one file where a decision that cannot be checked is a decision nobody can
// trust, and the whole of it is therefore a pure function of the pending set:
//
//   no I/O, no clock, no subprocess, no desktop, no module-level mutable state,
//   synchronous, and a byte-for-byte deterministic result.
//
// `badgeFor` answers "what does the icon say" and `drawTrayIcon` answers "which
// pixels is that". Both are testable on a machine with no display, which is the only
// way NT-FR-05's edges - zero, a small count, above ninety-nine - can be exercised
// exhaustively rather than one screenshot at a time. Nothing here decides *when* to
// redraw (that is the hub's change feed, in ../hub/tray.ts) and nothing here decides
// what a click means (also there). This file is the table and the raster.
//
// WHY THE BADGE IS DRAWN AND NOT A PLATFORM COUNT
// A native per-platform count is three different mechanisms, one per desktop, each
// with its own bounds and its own failure mode, and two of them are documented in
// this repository as unverified on the machine that built it. Drawn into the image
// is one implementation for all three platforms (the feature document's Open
// Question 3), and it is also the only one of the two that this test suite can
// actually check. The cost is stated rather than hidden: a drawn badge is as legible
// as the raster below allows, and whether a real desktop shows it legibly at the real
// tray size is NT-4's and NT-5's human gate, not a claim made here.
//
// THE THREE ANSWERS, AND WHY THEY ARE THREE
//   count <= 0        nothing is drawn at all
//   1 .. 99           the count itself
//   above 99          a capped marker, never the count
//
// The cap is a legibility bound, not a count: "99+" means "at least a hundred", and
// the icon cannot say which. So the decision carries two numbers - `count`, the true
// pending count, never folded - and `label`, what the icon is allowed to show. The
// tooltip carries the true count, and the durable record of it is the dashboard and
// `status` (PRD 16 Open Question 11, and this product's own rule that the badge must
// never become the only place a number exists). A badge that said 99 when a hundred
// and twenty were outstanding would be a lie the developer cannot see through, and
// the whole product is built so that this product is not the thing that lies.
//
// NOTHING HERE HAS A MOUTH
// The glyphs are digits and a plus sign, and the tooltip is this product's own name
// with a count. No repository, no path, no session identifier, no harness and no
// event text reaches an icon (APX-FR-01). The pixels are drawn from a table of
// shapes, not from a string a caller could have filled with anything.
//
// NO SOUND, ON ANY COUNT (APX-CON-04)
// There is no sound field, no sound flag and no sound-capable value in this file or
// in anything that reads it, because a tray icon is not a notification and a
// notification in v1 is silent. The tray's own module carries the same rule for the
// click and the menu. What a desktop does with a badge is a user setting outside this
// process; NT-4's live gate observes it and this file cannot.
//
// NOTHING LEAVES THE MACHINE (APX-CON-12)
// No socket, no subprocess, no file, no environment read and no clock. The output is
// a number and a `Uint8Array` the caller hands to a platform image, which stays on
// this machine. There is no telemetry here and no path by which one could be added
// without adding an import.

/**
 * The count above which the icon stops showing a count.
 *
 * Ninety-nine, from NT-FR-05 and PRD 16 Open Question 11 ("Counts above 99 render as
 * a capped marker"). It is a named export rather than a literal in the branch so the
 * test that asserts the boundary and the code that draws it cannot disagree.
 */
export const BADGE_CAP = 99

/**
 * What the icon shows when the pending count is above `BADGE_CAP`.
 *
 * A marker, and deliberately not a number: it says "there are more than ninety-nine"
 * and nothing finer. The true count is in the decision beside it, in the tooltip, in
 * the dashboard and in `status` - a marker is a legibility bound, not a count.
 */
export const BADGE_CAPPED_LABEL = '99+'

/**
 * The product's name, as an icon's tooltip says it.
 *
 * Duplicated rather than imported from the notifier's own constant, for a reason
 * worth stating: this file takes no import at all, so it can be read, tested and
 * reasoned about as the pure table it is, and so a change to what a *toast* is called
 * cannot silently move what a *tray icon* is called. A test asserts the two agree, so
 * the duplication cannot rot.
 */
export const TRAY_APP_NAME = 'agent-ping'

/**
 * The edge of the icon this module draws, in pixels, square.
 *
 * Thirty-two, a size every v1 desktop's tray and menu bar can show at its native
 * scale. It is the default and not a constant the callers may assume: `drawTrayIcon`
 * takes a size, because a menu bar at 22 and a Windows notification area at 32 are
 * different sizes and one drawn raster serves neither best.
 */
export const TRAY_ICON_SIZE = 32

/** What a badge is. A closed union, so a fourth answer is a compile error here. */
export type BadgeKind = 'none' | 'count' | 'capped'

/**
 * What the icon should say about the pending set.
 *
 * `count` is the truth and is never folded: a capped decision still carries the real
 * number, which is what makes the cap a display decision rather than a data loss.
 * `label` is what the raster is allowed to draw, and is null exactly when nothing is
 * drawn at all.
 */
export interface BadgeDecision {
  readonly kind: BadgeKind
  /** The unacknowledged pending count, as a whole number of zero or more. */
  readonly count: number
  /** The text to draw, or null for no badge. */
  readonly label: string | null
  /** True when `label` is the capped marker rather than the count. */
  readonly capped: boolean
  /** The one shape of the glyph run, exposed so a test can assert the raster. */
  readonly glyphs: number
}

/**
 * What a count is worth on an icon.
 *
 * Total over the whole non-negative integers and nothing else, which is the domain
 * of a pending set's length. A count that is not a whole non-negative number throws
 * rather than defaulting: a default here would be a second answer to "is anything
 * waiting", and a badge that quietly read "no" because a caller handed it `NaN` is
 * the one failure this product exists to prevent. The caller that can produce such a
 * count - the hub's pending read - is the one that catches this and reports it
 * (../hub/tray.ts), so the throw is a reported fault rather than a crash of the hub.
 */
export function badgeFor(pendingCount: number): BadgeDecision {
  if (!Number.isSafeInteger(pendingCount) || pendingCount < 0) {
    throw new Error(
      `unusable pending count: ${String(pendingCount)}. The badge is a function of a pending set's ` +
        'length, which is always a whole number of zero or more; a value that is not one is a fault in ' +
        'the reader rather than a badge to draw (NT-FR-05).',
    )
  }
  if (pendingCount === 0) {
    return { kind: 'none', count: 0, label: null, capped: false, glyphs: 0 }
  }
  if (pendingCount > BADGE_CAP) {
    return {
      kind: 'capped',
      count: pendingCount,
      label: BADGE_CAPPED_LABEL,
      capped: true,
      glyphs: BADGE_CAPPED_LABEL.length,
    }
  }
  const label = String(pendingCount)
  return { kind: 'count', count: pendingCount, label, capped: false, glyphs: label.length }
}

/**
 * What a pending set is worth on an icon.
 *
 * The one the tray calls, and the shape the requirement is written in: the badge is a
 * function of *the pending set*, not of a number somebody remembered to keep in step
 * with it. Reading the length here rather than at the call site is what makes a
 * second source of that number impossible rather than merely discouraged - which is
 * the property the whole of NT-FR-05 rests on.
 */
export function badgeForPending(pending: readonly unknown[]): BadgeDecision {
  return badgeFor(pending.length)
}

/**
 * What the icon's tooltip says.
 *
 * The one place the true count reaches a human, which is why a capped badge carries
 * the real number here even though the pixels do not: the marker is a legibility
 * bound and the tooltip is not. Two lines' worth of text at most, this product's name
 * and a number - no repository, no path, no session (APX-FR-01).
 */
export function badgeTooltip(badge: BadgeDecision): string {
  if (badge.kind === 'none') return `${TRAY_APP_NAME} — nothing is waiting on you`
  return `${TRAY_APP_NAME} — ${String(badge.count)} waiting`
}

// ---------------------------------------------------------------------------
// Drawing it
// ---------------------------------------------------------------------------

/**
 * The glyph cell, in unscaled pixels: three wide, five tall.
 *
 * A five-row cell is the smallest that keeps 0, 1, 6, 8 and 9 apart from each other
 * at a size a tray can show, and three columns is the narrowest that lets 4 and 9 be
 * drawn without merging into one another. The font is a table of shapes rather than
 * a renderer because a renderer would be a font dependency, and this file takes no
 * import at all (see the header).
 */
export const BADGE_GLYPH_WIDTH = 3
export const BADGE_GLYPH_HEIGHT = 5

/** Whole pixels one glyph is scaled by. The cap, so a large icon is not enormous. */
export const BADGE_GLYPH_SCALE = 2

/** Transparent pixels between the badge's edge and its glyphs. */
export const BADGE_PATCH_PADDING = 1

/**
 * The whole alphabet this module can draw, as five rows of three cells.
 *
 * A `'1'` cell is opaque and a `'0'` cell is not. Digits only, plus the one symbol
 * the capped marker uses: a glyph table is the cheapest place to make "the icon can
 * only ever show a number" structural, and a label carrying anything else throws
 * rather than drawing a box (APX-FR-01, APX-CON-04).
 */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
}

/** A colour, as red, green, blue and alpha. The pixel format below is BGRA. */
type Rgba = readonly [number, number, number, number]

/**
 * The icon's own quiet glyph: a ring, drawn not loaded.
 *
 * The feature document asks for "a single quiet glyph whose badge is the only moving
 * part", and this is that glyph: neutral, unchanging, and legible at sixteen pixels
 * where a filled shape would blob. It is drawn rather than loaded because this
 * repository ships no icon asset, and an icon file is a packaging question (IO-1,
 * packaging-engineer) rather than something the badge's rules should depend on - a
 * caller that does have a base image composes this badge onto it instead (see
 * `drawTrayIcon`).
 */
const BASE_COLOUR: Rgba = [148, 163, 184, 255]

/** The badge's patch. The one alarming colour in the product, and it is a number. */
const BADGE_COLOUR: Rgba = [180, 35, 24, 255]

/** The glyphs on the patch. */
const BADGE_TEXT_COLOUR: Rgba = [255, 255, 255, 255]

/** How thick the base ring is, in pixels at the default size. */
const BASE_RING_THICKNESS = 2

/** Four bytes per pixel: blue, green, red, alpha, in that order. */
const CHANNELS = 4

/**
 * The pixel format, spelled out because the platform half is untyped.
 *
 * Electron's `nativeImage.createFromBitmap` takes exactly this: BGRA, one byte each,
 * tightly packed, no row padding, top row first. Naming it here means the bridge that
 * hands these bytes to a platform image does not have to know a platform's order by
 * heart, and a byte order that did not match would produce an icon whose badge is
 * the right shape in the wrong colour rather than an error anybody would see.
 */
export const TRAY_ICON_PIXEL_FORMAT = 'bgra-tightly-packed'

/**
 * A drawn icon, as the platform half receives it.
 *
 * The bytes, the two dimensions they are, and the decision they were drawn from -
 * the last one so a test, `doctor` or a bridge can answer "what is on the icon"
 * without parsing pixels, and so the pixels and the number beside them cannot be
 * from two different refreshes.
 */
export interface TrayIcon {
  readonly width: number
  readonly height: number
  /** BGRA, four bytes per pixel, row-major, `width * height * 4` of them. */
  readonly pixels: Uint8Array
  /** The decision these pixels draw. */
  readonly badge: BadgeDecision
  /** What the tooltip should say. See `badgeTooltip`. */
  readonly tooltip: string
}

/**
 * An image to draw a badge onto, when the caller has one.
 *
 * Optional, and the only way the ring above is not used. A packaged application will
 * have a real icon file and hands its pixels here; the badge is composited onto it by
 * the same pure function, so "the count is drawn into the icon" is one implementation
 * whether the icon came from disk or from a table.
 */
export interface TrayIconBase {
  readonly width: number
  readonly height: number
  /** BGRA, four bytes per pixel, row-major, exactly `width * height * 4` of them. */
  readonly pixels: Uint8Array
}

export interface DrawTrayIconOptions {
  /**
   * The edge of the icon in pixels, for the built-in glyph. Defaults to
   * TRAY_ICON_SIZE.
   *
   * Not consulted when a `base` is supplied: a caller holding a real image has
   * already chosen the size, and a raster stretched to a different one would be a
   * second, blurrier answer to the same question.
   */
  readonly size?: number
  /** An image to draw onto. When absent, the built-in quiet ring is drawn. */
  readonly base?: TrayIconBase
}

/**
 * The icon a decision is drawn as.
 *
 * Deterministic: the same decision and the same options produce the same bytes, every
 * time, on every machine. That is the property that lets a test assert what is drawn
 * rather than that something was drawn - and it is also what makes a drawn badge
 * auditable at all, since a raster that varied with a clock or a random seed could
 * only ever be checked by looking at it.
 *
 * At zero pending items the result is the base image and nothing else: no patch, no
 * glyph, no marker. "No badge shown at zero" is NT-FR-05, and it is a property of the
 * bytes rather than of a caller's decision not to draw, so a bridge cannot show an
 * empty badge by forgetting to check.
 *
 * The badge sits in the bottom-right corner, which is where every desktop's tray
 * convention puts it, and its scale is reduced if the icon is too small for the glyph
 * run rather than being drawn off the edge. A glyph that does not fit is clipped; the
 * label beside the pixels still carries the count, so clipping costs legibility and
 * never accuracy.
 */
export function drawTrayIcon(badge: BadgeDecision, options: DrawTrayIconOptions = {}): TrayIcon {
  const base = options.base
  const size = base === undefined ? (options.size ?? TRAY_ICON_SIZE) : base.width
  const pixels = basePixels(size, base)
  if (badge.kind !== 'none') drawBadge(pixels, size, badge)
  return { width: size, height: size, pixels, badge, tooltip: badgeTooltip(badge) }
}

/**
 * The pixels the badge is drawn onto: the caller's image, or the quiet ring.
 *
 * The caller's buffer is copied rather than adopted, because the caller is very
 * likely to be holding a platform image's own bitmap and a badge that wrote into it
 * would mutate what the desktop is already showing.
 */
function basePixels(size: number, base: TrayIconBase | undefined): Uint8Array {
  if (base === undefined) {
    const blank = new Uint8Array(size * size * CHANNELS)
    drawRing(blank, size, BASE_COLOUR)
    return blank
  }
  const expected = base.width * base.height * CHANNELS
  if (base.pixels.length !== expected || base.width !== base.height) {
    throw new Error(
      `unusable tray icon base: ${String(base.width)}x${String(base.height)} with ` +
        `${String(base.pixels.length)} bytes, which needs a square image of exactly ${String(expected)} ` +
        'bytes. A base whose shape or length does not match would be drawn from the wrong pixels, and ' +
        'a rectangular one has no bottom right for the badge to sit in (NT-FR-05).',
    )
  }
  return Uint8Array.from(base.pixels)
}

/**
 * The quiet glyph: a ring, one pixel ring, centred.
 *
 * Written as a distance test rather than a shape table because a ring is not a thing
 * a table can hold, and a rasterised glyph would be a font dependency this file
 * refuses. The test is on pixel centres, which keeps the ring symmetric on an even
 * icon size instead of shifting by half a pixel.
 */
function drawRing(pixels: Uint8Array, size: number, colour: Rgba): void {
  const centre = (size - 1) / 2
  const outer = centre - 1
  const inner = outer - BASE_RING_THICKNESS
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - centre, y - centre)
      if (distance <= outer && distance >= inner) setPixel(pixels, size, x, y, colour)
    }
  }
}

/**
 * The badge: a patch in the bottom-right corner with the glyphs on it.
 *
 * The patch rather than the digits alone, because a number in the tray's own
 * background colour is a number that disappears on a light menu bar and doubles on a
 * dark one. A patch with an opaque colour behind it reads the same on all three.
 */
function drawBadge(pixels: Uint8Array, size: number, badge: BadgeDecision): void {
  const label = badge.label
  if (label === null) return
  const glyphs = label.split('')
  const scale = glyphScale(glyphs.length, size)
  const cellWidth = BADGE_GLYPH_WIDTH * scale
  const cellHeight = BADGE_GLYPH_HEIGHT * scale
  const runWidth = glyphs.length * cellWidth + (glyphs.length - 1) * scale
  const patchWidth = runWidth + BADGE_PATCH_PADDING * 2
  const patchHeight = cellHeight + BADGE_PATCH_PADDING * 2
  const originX = size - patchWidth
  const originY = size - patchHeight

  fillRect(pixels, size, originX, originY, patchWidth, patchHeight, BADGE_COLOUR)
  glyphs.forEach((glyph, index) => {
    const rows = GLYPHS[glyph]
    if (rows === undefined) {
      throw new Error(
        `undrawable badge character: "${glyph}". The badge can only draw digits and the capped ` +
          "marker's plus sign, because an icon that could draw a word could be made to say one " +
          '(APX-FR-01, NT-FR-05).',
      )
    }
    const cellX = originX + BADGE_PATCH_PADDING + index * (cellWidth + scale)
    rows.forEach((row, rowIndex) => {
      for (let column = 0; column < row.length; column += 1) {
        if (row[column] !== '1') continue
        fillRect(
          pixels,
          size,
          cellX + column * scale,
          originY + BADGE_PATCH_PADDING + rowIndex * scale,
          scale,
          scale,
          BADGE_TEXT_COLOUR,
        )
      }
    })
  })
}

/**
 * How large one glyph may be drawn, given how many there are and how wide the icon is.
 *
 * The largest whole-pixel scale that still fits the run and the padding, capped at
 * `BADGE_GLYPH_SCALE` so a 32-pixel icon does not get a 30-pixel-tall number. One
 * pixel is the floor rather than zero, because a run that cannot fit at all is
 * clipped instead of vanishing - the count is in the tooltip and in the decision
 * either way, and a badge that is hard to read beats one that is not there.
 */
function glyphScale(glyphCount: number, size: number): number {
  const unit = glyphCount * BADGE_GLYPH_WIDTH + (glyphCount - 1)
  const available = size - BADGE_PATCH_PADDING * 2
  return Math.max(1, Math.min(BADGE_GLYPH_SCALE, Math.floor(available / unit)))
}

/** Paint one pixel, out of bounds quietly. A clipped badge is a legible one. */
function setPixel(pixels: Uint8Array, size: number, x: number, y: number, colour: Rgba): void {
  if (x < 0 || y < 0 || x >= size || y >= size) return
  const offset = (y * size + x) * CHANNELS
  pixels[offset] = colour[2]
  pixels[offset + 1] = colour[1]
  pixels[offset + 2] = colour[0]
  pixels[offset + 3] = colour[3]
}

/** Paint a rectangle, one pixel at a time, clipped to the icon. */
function fillRect(
  pixels: Uint8Array,
  size: number,
  x: number,
  y: number,
  width: number,
  height: number,
  colour: Rgba,
): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) setPixel(pixels, size, column, row, colour)
  }
}
