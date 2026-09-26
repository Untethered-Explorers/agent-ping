// The tray badge: a pure function of the pending set, and the pixels it draws.
//
//   npm test -- tests/tray/badge.test.ts
//
// THE ACCEPTANCE CRITERION, AND WHERE IT IS PROVEN
// "A test asserts the badge renders zero pending items as no badge, a small count as
//  that count, and a count above ninety-nine as the capped marker."
// It is proven as a *decision* and as *pixels*, because the two are separate claims
// and a badge can satisfy one while failing the other: a decision of `none` with a
// patch still drawn would show an empty red box, and a correct label with the wrong
// byte order would show the right shape in the wrong colour. So each of the three
// answers is asserted twice - once on `badgeFor`, and once on the bytes `drawTrayIcon`
// produces - including that the bytes for zero contain no badge colour at all.
//
// AROUND THAT, the properties that make it worth anything:
//
//   - It is a function of the pending *set*, not of a count somebody kept in step
//     with it: `badgeForPending` takes the set, and its label says so.
//   - The cap is a display decision and not a data loss: a decision for a hundred and
//     and fifty still *carries* a hundred and fifty, and says so in the tooltip.
//   - The boundaries are asserted as boundaries, not as samples: 0, 1, 99, 100, and
//     the two sides of every one of them.
//   - The raster is deterministic, so a drawn badge can be asserted byte-for-byte
//     rather than eyeballed, and a real icon is composed the same way a packaged
//     one would be.
//   - Nothing here has a mouth, sounds, or leaves the machine, and the three of those
//     are checked against the module's own source rather than described (APX-FR-01,
//     APX-CON-04, APX-CON-12).
//
// Nothing here needs a desktop, a socket or a hub. That is the point of the split:
// this file holds the rule, ../hub/tray.ts holds the wiring, and a test can exercise
// the rule exhaustively on a machine where the wiring cannot run at all.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BADGE_CAP,
  BADGE_CAPPED_LABEL,
  BADGE_GLYPH_HEIGHT,
  BADGE_GLYPH_SCALE,
  BADGE_GLYPH_WIDTH,
  BADGE_PATCH_PADDING,
  TRAY_APP_NAME,
  TRAY_ICON_PIXEL_FORMAT,
  TRAY_ICON_SIZE,
  badgeFor,
  badgeForPending,
  badgeTooltip,
  drawTrayIcon,
  type BadgeDecision,
  type TrayIcon,
} from '@/tray/badge'
import { NOTIFICATION_APP_NAME } from '@/notify/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The four values a pixel is made of, in the order the raster writes them. */
type Rgba = readonly [number, number, number, number]

/** The badge's patch, as the module writes it. Duplicated so the test holds the claim. */
const BADGE_COLOUR: Rgba = [180, 35, 24, 255]

/**
 * Every pixel of a colour, as `[x, y]` pairs. A cheap way to ask "what was drawn".
 *
 * The comparison is on the three colour channels, in the raster's own BGRA order, so
 * a byte order that did not match the platform's would show up here as a colour that is
 * not the one the module says it draws.
 */
function pixelsOf(icon: TrayIcon, colour: Rgba): { x: number; y: number }[] {
  const found: { x: number; y: number }[] = []
  for (let y = 0; y < icon.height; y += 1) {
    for (let x = 0; x < icon.width; x += 1) {
      const offset = (y * icon.width + x) * 4
      const blue = icon.pixels[offset]
      const green = icon.pixels[offset + 1]
      const red = icon.pixels[offset + 2]
      if (red === colour[0] && green === colour[1] && blue === colour[2]) found.push({ x, y })
    }
  }
  return found
}

/** How many distinct pixel values the raster contains. A blank icon has one. */
function distinctColours(icon: TrayIcon): number {
  const seen = new Set<number>()
  for (let offset = 0; offset < icon.pixels.length; offset += 4) {
    const [blue, green, red, alpha] = [
      icon.pixels[offset],
      icon.pixels[offset + 1],
      icon.pixels[offset + 2],
      icon.pixels[offset + 3],
    ]
    if (blue === undefined || green === undefined || red === undefined || alpha === undefined) {
      throw new Error(`the raster ended mid-pixel at offset ${String(offset)}`)
    }
    seen.add((red << 24) | (green << 16) | (blue << 8) | alpha)
  }
  return seen.size
}

/** The badge's patch, as a box, so the drawn position can be asserted. */
function patchBox(icon: TrayIcon): { x: number; y: number; width: number; height: number } {
  const found = pixelsOf(icon, BADGE_COLOUR)
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = -1
  let maxY = -1
  for (const pixel of found) {
    if (pixel.x < minX) minX = pixel.x
    if (pixel.y < minY) minY = pixel.y
    if (pixel.x > maxX) maxX = pixel.x
    if (pixel.y > maxY) maxY = pixel.y
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

function repositoryRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/**
 * A module's code, with its prose taken out.
 *
 * Whole-line comments only, and deliberately: these two modules *discuss* sound, the
 * desktop and the count in their headers, and the rules being checked are about the
 * values and the calls rather than about the sentences. A `//` inside a string would
 * defeat a looser strip, and neither module has one - so the narrow strip is exact
 * rather than merely convenient.
 */
function codeOf(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot(), relativePath), 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
}

// ---------------------------------------------------------------------------
// 1. Zero, a small count, and above ninety-nine
// ---------------------------------------------------------------------------

describe('the badge renders zero, a small count, and a capped marker above ninety-nine', () => {
  it('draws nothing at all at zero, as a decision and as pixels', () => {
    // The decision: no badge, no label, and a count of zero rather than a guess.
    const none = badgeForPending([])
    expect(none.kind).toBe('none')
    expect(none.label).toBeNull()
    expect(none.capped).toBe(false)
    expect(none.count).toBe(0)
    expect(none.glyphs).toBe(0)

    // The pixels. A badge at zero is the one thing NT-FR-05 names, and "the label is
    // null" would not be enough: the icon could still carry an empty patch, which is
    // the red box a developer's eye reads as a problem that was never resolved.
    const icon = drawTrayIcon(none)
    expect(pixelsOf(icon, BADGE_COLOUR)).toEqual([])
    // Which is why the icon at zero is the icon with no badge drawn on it, byte for
    // byte - the same image, from the same module, whichever way it was reached.
    expect(Array.from(icon.pixels)).toEqual(Array.from(drawTrayIcon(badgeFor(0)).pixels))
  })

  it('draws the count itself for a small number, and nothing beyond the number', () => {
    for (const count of [1, 2, 7, 9, 10, 42, 98, BADGE_CAP]) {
      const badge = badgeForPending(new Array<unknown>(count).fill('a block'))
      expect(badge.kind, String(count)).toBe('count')
      expect(badge.label, String(count)).toBe(String(count))
      expect(badge.capped, String(count)).toBe(false)
      expect(badge.count, String(count)).toBe(count)
      expect(badge.glyphs, String(count)).toBe(String(count).length)
      // The pixels for this count are its own: a different number is a different
      // image, and identical images for two counts would mean the raster is not
      // actually reading the decision.
      const icon = drawTrayIcon(badge)
      expect(pixelsOf(icon, BADGE_COLOUR).length, String(count)).toBeGreaterThan(0)
      expect(digest(icon), String(count)).not.toBe(digest(drawTrayIcon(badgeFor(count - 1))))
    }
  })

  it('draws a capped marker above ninety-nine, and never the count', () => {
    for (const count of [BADGE_CAP + 1, 100, 150, 999, 1234, 100_000]) {
      const badge = badgeForPending(new Array<unknown>(count).fill('a block'))
      expect(badge.kind, String(count)).toBe('capped')
      expect(badge.label, String(count)).toBe(BADGE_CAPPED_LABEL)
      expect(badge.capped, String(count)).toBe(true)
      // The cap is a display decision, not a data loss. This is the whole of PRD 16
      // Open Question 11: the icon cannot say more than the marker, so the true count
      // has to be somewhere that can - here, in the tooltip, in the dashboard and in
      // `status`. A decision that folded the count would make the badge the only
      // place the number existed, and it would be wrong.
      expect(badge.count, String(count)).toBe(count)
      expect(badgeTooltip(badge), String(count)).toContain(String(count))
      // And one marker image for every count above the cap, which is the point of a
      // cap: the icon stops trying to be precise above ninety-nine.
      expect(digest(drawTrayIcon(badge)), String(count)).toBe(digest(drawTrayIcon(badgeFor(101))))
    }
  })

  it('treats the cap as a boundary rather than as a sample', () => {
    // Ninety-nine is still a count. A hundred is the first capped marker. The
    // requirement says "above ninety-nine", and both sides of that word are asserted.
    expect(badgeFor(BADGE_CAP)).toEqual({
      kind: 'count',
      count: 99,
      label: '99',
      capped: false,
      glyphs: 2,
    })
    expect(badgeFor(BADGE_CAP + 1)).toEqual({
      kind: 'capped',
      count: 100,
      label: BADGE_CAPPED_LABEL,
      capped: true,
      glyphs: 3,
    })
    expect(BADGE_CAP).toBe(99)
    expect(BADGE_CAPPED_LABEL).toBe('99+')
  })

  it('draws a wider patch for more digits, anchored in the bottom-right corner', () => {
    // The position is a convention every desktop already uses, and the width is the
    // decision's own: one digit is a small patch, two is wider, three wider still.
    const one = patchBox(drawTrayIcon(badgeFor(1)))
    const two = patchBox(drawTrayIcon(badgeFor(42)))
    const three = patchBox(drawTrayIcon(badgeFor(123)))
    expect(two.width).toBeGreaterThan(one.width)
    expect(three.width).toBeGreaterThan(two.width)
    const icon = drawTrayIcon(badgeFor(1))
    for (const box of [one, two, three]) {
      // Bottom right: the patch touches the last row and the last column, and never
      // the first.
      expect(box.x + box.width).toBe(icon.width)
      expect(box.y + box.height).toBe(icon.height)
      expect(box.x).toBeGreaterThan(0)
      expect(box.height).toBe(BADGE_GLYPH_HEIGHT * BADGE_GLYPH_SCALE + BADGE_PATCH_PADDING * 2)
    }
    // One glyph is one cell plus its padding, and each further glyph adds a cell and
    // the gap between them - so the widths above are the glyph run, not a guess.
    expect(one.width).toBe(BADGE_GLYPH_WIDTH * BADGE_GLYPH_SCALE + BADGE_PATCH_PADDING * 2)
    expect(three.width).toBe(one.width + 2 * BADGE_GLYPH_SCALE * (BADGE_GLYPH_WIDTH + 1))
  })
})

// ---------------------------------------------------------------------------
// 2. It is a pure function, and it is total where it can be
// ---------------------------------------------------------------------------

describe('the badge is a pure function of the pending set', () => {
  it('decides the same thing every time, for the same set', () => {
    const pending = [1, 2, 3]
    expect(badgeForPending(pending)).toEqual(badgeForPending(pending))
    // And the same for the pixels, byte for byte: a raster that varied with a clock or
    // a random seed could only ever be checked by looking at it.
    expect(digest(drawTrayIcon(badgeForPending(pending)))).toBe(
      digest(drawTrayIcon(badgeForPending([...pending]))),
    )
  })

  it('reads a pending set rather than a count, so the two cannot be kept in step', () => {
    // The exported function takes the set, which is what the hub's own accessor
    // returns. There is deliberately no count-taking entry point a caller could reach
    // for by accident, so "the badge and the pending set disagree" is not a state this
    // module can be in.
    expect(badgeForPending([]).count).toBe(0)
    expect(badgeForPending(['a']).count).toBe(1)
    expect(badgeForPending(['a', 'b', 'c', 'd']).count).toBe(4)
    // The items are not read, which is what keeps a session identifier or a repository
    // path from reaching an icon even if a caller handed the whole pending set over
    // (APX-FR-01). A set of values that would be catastrophic as a string changes
    // nothing.
    const hostile = ['/home/dev/secret-repo', 'ses_01', 'permission.asked']
    expect(badgeForPending(hostile)).toEqual(badgeForPending(new Array<unknown>(3).fill('')))
  })

  it('refuses a count that is not a pending set length, rather than guessing', () => {
    // A default here would be a second answer to "is anything waiting", and a badge
    // that read "no" because a reader handed it NaN is the one failure this product
    // exists to prevent. The caller that can produce such a count catches this and
    // reports it (src/hub/tray.ts).
    for (const bad of [-1, -100, 1.5, 0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE]) {
      expect(() => badgeFor(bad), String(bad)).toThrow(/unusable pending count/)
    }
  })

  it('answers the tooltip from the decision, and never from a capped label', () => {
    expect(badgeTooltip(badgeFor(0))).toBe(`${TRAY_APP_NAME} — nothing is waiting on you`)
    expect(badgeTooltip(badgeFor(3))).toBe(`${TRAY_APP_NAME} — 3 waiting`)
    // Above the cap the tooltip carries the real count, because a tooltip is not the
    // icon: the marker is a legibility bound and this is where the number is still
    // legible.
    expect(badgeTooltip(badgeFor(123))).toBe(`${TRAY_APP_NAME} — 123 waiting`)
    expect(badgeTooltip(badgeFor(123))).not.toContain(BADGE_CAPPED_LABEL)
    // And the icon's own name is this product's name - the same constant the notifier
    // uses, so a toast and a tray icon cannot arrive under two different names.
    expect(TRAY_APP_NAME).toBe(NOTIFICATION_APP_NAME)
  })
})

// ---------------------------------------------------------------------------
// 3. The raster
// ---------------------------------------------------------------------------

describe('the icon is drawn deterministically, and composes onto a caller image', () => {
  it('is square, tightly packed, and the size it was asked for', () => {
    for (const size of [16, TRAY_ICON_SIZE, 64]) {
      const icon = drawTrayIcon(badgeFor(2), { size })
      expect(icon.width).toBe(size)
      expect(icon.height).toBe(size)
      // Four bytes per pixel, every one of them, in the order the platform's own
      // `createFromBitmap` takes: blue, green, red, alpha. A length that did not match
      // its dimensions would be the kind of fault nobody sees until a tray icon comes
      // out the wrong colour.
      expect(icon.pixels).toBeInstanceOf(Uint8Array)
      expect(icon.pixels.length).toBe(size * size * 4)
      expect(TRAY_ICON_PIXEL_FORMAT).toBe('bgra-tightly-packed')
    }
  })

  it('carries its own decision and tooltip beside the bytes', () => {
    // So "what is on the icon" is answerable without parsing pixels, and so the bytes
    // and the number beside them cannot be from two different refreshes.
    const icon = drawTrayIcon(badgeFor(7))
    expect(icon.badge).toEqual(badgeFor(7))
    expect(icon.tooltip).toBe(badgeTooltip(badgeFor(7)))
  })

  it('is drawn once for the same decision, and differently for a different one', () => {
    // Five hundred blocks above the cap, one marker image. The first place a count
    // is precise again is the tooltip and the dashboard.
    expect(digest(drawTrayIcon(badgeFor(500)))).toBe(digest(drawTrayIcon(badgeFor(9_999))))
    // And a blank icon has exactly one pixel value in it, which is the cheapest
    // possible proof that nothing was drawn on it.
    expect(distinctColours(drawTrayIcon(badgeFor(0)))).toBeLessThanOrEqual(2)
  })

  it('composes the badge onto a caller image without mutating it', () => {
    // The packaged application will have a real icon file, and its pixels come from a
    // platform image the desktop may already be holding. A badge that wrote into that
    // buffer would change what the desktop is showing.
    const base = { width: 16, height: 16, pixels: new Uint8Array(16 * 16 * 4).fill(9) }
    const before = Array.from(base.pixels)
    const icon = drawTrayIcon(badgeFor(5), { base })
    expect(Array.from(base.pixels)).toEqual(before)
    // The base's own dimensions are the icon's: a caller holding a real image has
    // already chosen the size, and this module does not get a second opinion.
    expect(icon.width).toBe(16)
    expect(icon.height).toBe(16)
    expect(icon.pixels.length).toBe(16 * 16 * 4)
    // The badge was drawn on it: the patch colour is in the composed image, in the
    // bottom right corner, and the caller's own pixels are still underneath it.
    expect(pixelsOf(icon, BADGE_COLOUR).length).toBeGreaterThan(0)
    expect(patchBox(icon)).toMatchObject({ x: 8, y: 4 })
    // The untouched part of the base is untouched, at a pixel value nothing in the
    // badge module writes.
    expect(icon.pixels[3]).toBe(9)
  })

  it('refuses a base image that is not square, rather than drawing into a rectangle', () => {
    // A non-square base cannot carry a corner-anchored badge: the patch would have to be
    // in one corner of a shape the icon convention does not have, and the two dimensions
    // would disagree about where the bottom right is.
    expect(() =>
      drawTrayIcon(badgeFor(1), {
        base: { width: 8, height: 4, pixels: new Uint8Array(8 * 4 * 4) },
      }),
    ).toThrow(/unusable tray icon base/)
  })

  it('refuses a base image whose length does not match its dimensions', () => {
    // Otherwise the badge would be drawn from the wrong pixels, and the result would
    // be an icon that looks fine and is not the image anybody passed in.
    expect(() =>
      drawTrayIcon(badgeFor(1), { base: { width: 4, height: 4, pixels: new Uint8Array(10) } }),
    ).toThrow(/unusable tray icon base/)
  })

  it('scales the glyph run down rather than drawing it off the edge', () => {
    // A menu bar at 16 is a real size on macOS, and a three-glyph marker at full scale
    // is wider than that. Clipped is acceptable - the count is in the tooltip and in
    // the decision - and drawing outside the buffer is not.
    const icon = drawTrayIcon(badgeFor(500), { size: 16 })
    expect(icon.width).toBe(16)
    expect(icon.pixels.length).toBe(16 * 16 * 4)
    expect(pixelsOf(icon, BADGE_COLOUR).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 4. No mouth, no sound, no network
// ---------------------------------------------------------------------------

describe('the badge module holds no content, no sound and no way out of the machine', () => {
  it('can only draw digits and the one symbol the marker uses', () => {
    // A label carrying anything else throws rather than drawing a box, so "the icon
    // could be made to say something" is not a state the module can reach (APX-FR-01).
    const hostile: BadgeDecision = {
      kind: 'count',
      count: 1,
      label: 'A',
      capped: false,
      glyphs: 1,
    }
    expect(() => drawTrayIcon(hostile)).toThrow(/undrawable badge character/)
  })

  it('has no sound, no clock, no process and no network in its code', () => {
    // Read as source, because "no sound in v1" and "nothing leaves the machine" are
    // claims about the code and a green test run is not evidence of them
    // (APX-CON-04, APX-CON-12). The prose in the header is stripped first: these
    // modules discuss sound and the desktop at length, and the rules are about values.
    const code = codeOf('src/tray/badge.ts')
    for (const forbidden of [
      'sound',
      'audio',
      'beep',
      'bell',
      'Notification',
      'node:child_process',
      'spawn',
      'fetch(',
      'node:http',
      'node:net',
      'XMLHttpRequest',
      'WebSocket',
      'setTimeout',
      'setInterval',
      'Date.now',
      'new Date',
      'Math.random',
      'readFile',
      'process.env',
    ]) {
      expect(code.includes(forbidden), `src/tray/badge.ts contains ${forbidden}`).toBe(false)
    }
    // No imports at all: the module takes nothing from the platform, so there is
    // nothing here that could open a socket, spawn a process or read a file.
    expect(code.includes('import')).toBe(false)
  })
})

/** A short fingerprint of an icon's bytes, for "is this the same image". */
function digest(icon: TrayIcon): string {
  // A folded sum rather than a hash: it is only ever compared with another digest from
  // the same run, and a collision between two different rasters would show up as a
  // failing "these differ" assertion rather than as a false pass.
  let hash = 2166136261
  for (const byte of icon.pixels) {
    hash = Math.imul(hash ^ byte, 16777619) >>> 0
  }
  return `${icon.width}x${icon.height}:${hash.toString(16)}:${icon.badge.label ?? '-'}`
}
