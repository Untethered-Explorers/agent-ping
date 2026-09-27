// Tests the notification-surface verification script (NS-4: NT-FR-02, NT-FR-04, NT-FR-08,
// NT-FR-10, NT-FR-12, APX-CON-06, APX-CON-12, APX-FR-01, APX-FR-02).
//
// Three halves, and all three matter:
//
//   - the decision logic and every parser are driven with injected values, so the
//     judgement and every parse are verified on a machine with no display, no Electron
//     binary and no X tools. This is the half that makes the script's pass/fail trustworthy
//     rather than only ever exercised on a desk that happens to work.
//   - the script's own source is read and swept, so the claim that it supplies no part of
//     the card path - no card document, no stylesheet, no entry module, no renderer bridge,
//     no second process, and one file written - is a failing test rather than a promise in
//     a comment. NT-9 had to substitute all four and could therefore only record what the
//     product could not do; this is what stops a later change quietly bringing any of them
//     back (NT-FR-12).
//   - the real script is spawned as a child process for the properties that can only be
//     established by running it: a missing display is a non-zero exit with a remedy and no
//     evidence file, a bad command line is its own exit code, and the machine-readable
//     summary on stdout is parseable on its own.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// @ts-expect-error the script under test is plain JavaScript with no declaration file; its
// exports are the contract this suite exercises and the ones it names are all it uses.
import * as surface from '../../scripts/verify-notification-surface.mjs'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const scriptPath = path.join(repoRoot, 'scripts', 'verify-notification-surface.mjs')
const scratch = mkdtempSync(path.join(tmpdir(), 'agent-ping-surface-verify-test-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/**
 * A source file with its comments removed and its strings kept.
 *
 * Comments go because a source-level check is about the calls a module makes, not about the
 * sentences describing them - and this repository's prose names every forbidden shape it
 * deliberately avoids, so keeping comments would make the sweep below fail on the script's
 * own documentation of what it no longer does. Strings stay, because a forbidden *name* is
 * most often only ever a string.
 *
 * Known limitation, stated rather than hidden: a backtick template is read as one string to
 * its closing backtick, so a nested template inside a `${...}` would end the scan early. The
 * one template in the script under test contains no `${` of its own inside another, and a
 * missed token would still be caught by the same token in the value the code then uses.
 */
function readWithoutProse(source: string): string {
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
        if (inner === character) {
          cursor += 1
          break
        }
        if (character !== '`' && inner === '\n') break
        cursor += 1
      }
      // The delimiters are kept, so a forbidden *call* spanning them is still seen.
      out += `${character}${source.slice(index + 1, cursor - 1)}${character}`
      index = cursor
      continue
    }
    out += character
    index += 1
  }
  return out
}

/** Hard ceiling on a child run, so a wedged script fails this suite instead of hanging it. */
const CHILD_TIMEOUT_MS = 60_000

interface ChildRun {
  status: number
  summary: Record<string, unknown> | null
  stdout: string
  stderr: string
}

/** Drive the real script the way an operator or CI would. */
function runScript(args: string[], env: NodeJS.ProcessEnv = {}): ChildRun {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
    timeout: CHILD_TIMEOUT_MS,
  })
  if (result.error !== undefined) throw result.error
  const stdout = result.stdout ?? ''
  // A parse failure here means progress leaked onto stdout, which would make the summary
  // unparseable, so it is surfaced rather than swallowed.
  let summary: Record<string, unknown> | null = null
  try {
    summary = stdout.trim() === '' ? null : (JSON.parse(stdout) as Record<string, unknown>)
  } catch {
    summary = null
  }
  return { status: result.status ?? 1, summary, stdout, stderr: result.stderr ?? '' }
}

/** One matching assertion, and one that does not, for the decision tests. */
const ok = (name: string): Record<string, unknown> => ({
  journey: 'test',
  name,
  expected: 'x',
  actual: 'x',
})
const bad = (name: string): Record<string, unknown> => ({
  journey: 'test',
  name,
  expected: 'x',
  actual: 'y',
})
const anyRows = (count: number): Record<string, unknown>[] =>
  Array.from({ length: count }, (_unused, index) => ok(`assertion-${index}`))
const noDependencies = [{ name: 'a dependency', present: true }]

/**
 * The window records the parser returns.
 *
 * Declared here rather than imported, because the script under test is plain JavaScript
 * and its exports arrive untyped: without this, every `.find((window) => ...)` in the
 * parser tests is an implicit `any` and the suite does not typecheck.
 */
interface Rect {
  x: number
  y: number
  width: number
  height: number
}
interface WindowRecord {
  id: string
  name: string | null
  relative: Rect
  absolute: Rect
}
const windowsOf = (text: string): WindowRecord[] => surface.parseWindowList(text) as WindowRecord[]

/**
 * An XWD dump, built in memory.
 *
 * The header is the real layout - 25 big-endian CARD32s, then the window name, then one
 * 12-byte colormap entry - because the offsets in `parseXwdPixels` are the whole reason a
 * capture can be read at all, and a fixture that faked them would verify nothing.
 */
function buildXwd(options: {
  width: number
  height: number
  bitsPerPixel?: number
  pixels: (x: number, y: number) => number
}): Buffer {
  const bitsPerPixel = options.bitsPerPixel ?? 32
  const step = bitsPerPixel / 8
  const bytesPerLine = options.width * step
  const headerSize = 100 + 3
  const ncolors = 1
  const dataOffset = headerSize + ncolors * 12
  const buffer = Buffer.alloc(dataOffset + options.height * bytesPerLine)
  const put = (offset: number, value: number): void => {
    buffer.writeUInt32BE(value >>> 0, offset)
  }
  put(0, headerSize)
  put(4, 7)
  put(8, 2)
  put(12, 24)
  put(16, options.width)
  put(20, options.height)
  put(24, 0)
  put(28, 0)
  put(32, 32)
  put(36, 0)
  put(40, 32)
  put(44, bitsPerPixel)
  put(48, bytesPerLine)
  put(52, 4)
  put(56, 0xff0000)
  put(60, 0x00ff00)
  put(64, 0x0000ff)
  put(68, 8)
  put(72, 256)
  put(76, ncolors)
  buffer.write('wm\0', 100, 'ascii')
  for (let y = 0; y < options.height; y += 1) {
    for (let x = 0; x < options.width; x += 1) {
      const value = options.pixels(x, y)
      const at = dataOffset + y * bytesPerLine + x * step
      // Two things, both of which had to be right before any test could read a colour out
      // of a capture. `>>>`, because a 32-bit pixel value above 2^31 is negative as an
      // int32 and an arithmetic shift sign-extends, which writes the wrong byte for every
      // channel but the top one. And `index * 8`, because an XWD dump stores a pixel least
      // significant byte first, which is the layout `parseXwdPixels` reads back. The
      // previous fixture wrote the bytes most significant first, so every colour it
      // produced was byte-reversed; no test noticed, because every test only counted
      // distinct values.
      for (let index = 0; index < step; index += 1) {
        buffer[at + index] = (value >>> (index * 8)) & 0xff
      }
    }
  }
  return buffer
}

describe('the assertion inventory cannot drift from the rows the journeys emit', () => {
  const lists = (): readonly (readonly string[])[] => [
    surface.OPENING_ASSERTIONS,
    surface.SHIPPED_ASSERTIONS,
    surface.NEEDS_YOU_ASSERTIONS,
    surface.FINISHED_ASSERTIONS,
    surface.GREETING_ASSERTIONS,
  ]

  it('the expected total is the sum of the five lists', () => {
    const total = lists().reduce((sum, list) => sum + list.length, 0)
    expect(total).toBe(surface.ASSERTIONS_EXPECTED)
  })

  it('no two assertions share a name, so a failure names exactly one thing', () => {
    const names = lists().flatMap((list) => [...list])
    expect(new Set(names).size).toBe(names.length)
  })

  it('every list is frozen, because a journey that appends to one would change the count', () => {
    for (const list of lists()) expect(Object.isFrozen(list)).toBe(true)
  })

  it('the shipped build owes its own rows, so what NT-9 could only record is now asserted', () => {
    expect(surface.SHIPPED_ASSERTIONS).toHaveLength(2)
    expect(surface.SHIPPED_ASSERTIONS.join('\n')).toMatch(/built artefacts/)
    expect(surface.SHIPPED_ASSERTIONS.join('\n')).toMatch(/delivery policy is wired/)
  })

  it('the needs-you journey keeps its nine rows and no longer claims to have read the document', () => {
    expect(surface.NEEDS_YOU_ASSERTIONS).toHaveLength(9)
    const names = surface.NEEDS_YOU_ASSERTIONS.join('\n')
    expect(names).not.toMatch(/card view rendered a card into the document/)
    // The reading that replaced it is a comparison against the product's own built
    // stylesheet, which is the only card-document claim a run outside the process can make.
    expect(names).toMatch(/painted fill is the product own stylesheet fill/)
    expect(names).toMatch(/byte for byte/)
  })

  it('the finished journey can tell a finished card from a needs-you one', () => {
    expect(surface.FINISHED_ASSERTIONS).toHaveLength(4)
    expect(surface.FINISHED_ASSERTIONS[2]).toMatch(/finished card/)
  })

  it('keeps the anti-noise journey whole, because it is the one that matters most', () => {
    expect(surface.GREETING_ASSERTIONS).toHaveLength(4)
    expect(surface.GREETING_ASSERTIONS.join('\n')).toMatch(/created no window/)
  })
})

describe('decide(): the judgement, driven with injected results', () => {
  it('passes only when every assertion ran and every one matched', () => {
    const result = surface.decide(anyRows(3), {
      assertionsExpected: 3,
      dependencies: noDependencies,
    })
    expect(result.verdict).toBe('pass')
    expect(result.exitCode).toBe(0)
    expect(result.failures).toEqual([])
  })

  it('fails when zero assertions ran: a green result that exercised nothing is not a pass', () => {
    const result = surface.decide([], { assertionsExpected: 4, dependencies: noDependencies })
    expect(result.verdict).toBe('fail')
    expect(result.exitCode).toBe(1)
    expect(result.failures.join('\n')).toMatch(/executed 0 of 4/)
  })

  it('fails on a shortfall, and says what it did not do', () => {
    const result = surface.decide(anyRows(5), {
      assertionsExpected: surface.ASSERTIONS_EXPECTED,
      dependencies: noDependencies,
    })
    expect(result.verdict).toBe('fail')
    expect(result.failures.join('\n')).toMatch(
      new RegExp(`executed 5 of ${surface.ASSERTIONS_EXPECTED}`),
    )
  })

  it('fails a mismatched observation, naming the assertion and both values', () => {
    const result = surface.decide([ok('a'), bad('b')], {
      assertionsExpected: 2,
      dependencies: noDependencies,
    })
    expect(result.verdict).toBe('fail')
    expect(result.failures.join('\n')).toMatch(/b: expected x, observed y/)
  })

  it('treats a not-observed reading as a mismatch, so an unseen card is never called gone', () => {
    const result = surface.decide(
      [
        {
          journey: 'needs-you',
          name: 'the card was gone after the acknowledgement',
          expected: 'gone',
          actual: 'not-observed: no card window was ever seen, so its disappearance proves nothing',
        },
      ],
      { assertionsExpected: 1, dependencies: noDependencies },
    )
    expect(result.verdict).toBe('fail')
    expect(result.exitCode).toBe(1)
  })

  it('fails a run with no display, and carries the remedy', () => {
    const result = surface.decide([], {
      assertionsExpected: 1,
      dependencies: [
        { name: 'a display', present: false, remedy: 'run this from a graphical session with DISPLAY set' },
      ],
    })
    expect(result.verdict).toBe('fail')
    expect(result.failures.join('\n')).toMatch(/required dependency unavailable: a display/)
    expect(result.failures.join('\n')).toMatch(/run this from a graphical session with DISPLAY set/)
    expect(result.missingDependencies).toHaveLength(1)
  })

  it('fails a run with no electron binary, and carries that remedy too', () => {
    const result = surface.decide(anyRows(1), {
      assertionsExpected: 1,
      dependencies: [
        {
          name: 'the electron binary',
          present: false,
          remedy: 'run `npm install` so node_modules/electron is present',
        },
      ],
    })
    expect(result.verdict).toBe('fail')
    expect(result.failures.join('\n')).toMatch(/npm install/)
  })

  it('still fails a full set of matching assertions when a dependency was absent', () => {
    const result = surface.decide(anyRows(2), {
      assertionsExpected: 2,
      dependencies: [{ name: 'the xwd X tool', present: false, remedy: 'install x11-apps' }],
    })
    expect(result.verdict).toBe('fail')
    expect(result.assertionsRun).toBe(2)
    expect(result.failures.join('\n')).toMatch(/required dependency unavailable/)
  })

  it('names the missing dependency even when the dependency record carries no remedy', () => {
    const result = surface.decide([], {
      assertionsExpected: 1,
      dependencies: [{ name: 'an unnamed thing', present: false }],
    })
    expect(result.failures.join('\n')).toMatch(
      /no remedy is recorded for this dependency, which is itself a defect in this script/,
    )
  })

  it('defaults to the shipped inventory and an empty dependency list', () => {
    const result = surface.decide(anyRows(surface.ASSERTIONS_EXPECTED), {})
    expect(result.verdict).toBe('pass')
    expect(result.assertionsExpected).toBe(surface.ASSERTIONS_EXPECTED)
  })
})

describe('parseWindowList(): the X server answer, read from real output shapes', () => {
  // Captured from `xwininfo -root -tree` on the authoring machine, trimmed to the shapes
  // that matter: a named window, a decoration frame, a nested client, an unnamed helper
  // window, and the two non-window lines the tool prints.
  const TREE = [
    '',
    'xwininfo: Window id: 0x691 (the root window) (has no name)',
    '',
    '  Root window id: 0x691 (the root window) (has no name)',
    '  Parent window id: 0x0 (none)',
    '     82 children:',
    '     0x460c349 "org.gnome.Nautilus": ("org.gnome.Nautilus" "org.gnome.Nautilus")  1x1+0+0  +0+0',
    '        1 child:',
    '        0x460c34a (has no name): ()  1x1+-1+-1  +-1+-1',
    '     0x600161 "xmessage": ("mutter-x11-frames" "mutter-x11-frames")  388x226+106+108  +106+108',
    '        1 child:',
    '        0x440002a "xmessage": ("xmessage" "Xmessage")  360x160+14+49  +120+157',
    '           1 child:',
    '           0x440002b (has no name): ()  360x160+0+0  +120+157',
    '     0x4400004 "agent-ping": ("agent-ping" "agent-ping")  320x96+1584+48  +1584+48',
    '        0 children:',
  ].join('\n')

  it('reads every window line and skips the header lines', () => {
    const windows = windowsOf(TREE)
    expect(windows).toHaveLength(6)
  })

  it('reads the absolute geometry, not the parent-relative one', () => {
    const nested = windowsOf(TREE).find((window) => window.id === '0x440002a')
    expect(nested?.relative).toEqual({ width: 360, height: 160, x: 14, y: 49 })
    expect(nested?.absolute).toEqual({ width: 360, height: 160, x: 120, y: 157 })
  })

  it('finds a card-shaped window nested in the tree, which a children-only query would miss', () => {
    const card = windowsOf(TREE).find((window) => window.id === '0x4400004')
    expect(card?.absolute).toEqual({ width: 320, height: 96, x: 1584, y: 48 })
    expect(card?.name).toBe('agent-ping')
  })

  it('lower-cases the window id, because the same id is compared across two queries', () => {
    expect(windowsOf('     0x4400004 "x": ("a" "a")  1x1+0+0  +0+0')[0]?.id).toBe('0x4400004')
    expect(windowsOf('     0x440000A "x": ("a" "a")  1x1+0+0  +0+0')[0]?.id).toBe('0x440000a')
  })

  it('records a name of null for an unnamed window rather than inventing one', () => {
    const unnamed = windowsOf(TREE).find((window) => window.id === '0x460c34a')
    expect(unnamed?.name).toBeNull()
  })

  it('returns nothing for text that is not a window listing', () => {
    expect(surface.parseWindowList('')).toEqual([])
    expect(surface.parseWindowList('error: unable to open display')).toEqual([])
    expect(surface.parseWindowList(undefined as unknown as string)).toEqual([])
  })

  it('does not let a name that looks like geometry become the geometry', () => {
    const windows = windowsOf('  0x1 "4x5+6+7 thing": ()  320x96+1584+48  +1584+48')
    expect(windows[0]?.absolute).toEqual({ width: 320, height: 96, x: 1584, y: 48 })
  })
})

describe('parseWindowDetail(): map state, geometry and depth', () => {
  const DETAIL = [
    '',
    'xwininfo: Window id: 0x4400004 "agent-ping"',
    '',
    '  Absolute upper-left X:  1584',
    '  Absolute upper-left Y:  48',
    '  Width: 320',
    '  Height: 96',
    '  Depth: 32',
    '  Map State: IsViewable',
    '  Override Redirect State: no',
  ].join('\n')

  it('reads the absolute position, the size, the depth and the map state', () => {
    expect(surface.parseWindowDetail(DETAIL)).toEqual({
      mapState: 'IsViewable',
      width: 320,
      height: 96,
      x: 1584,
      y: 48,
      depth: 32,
    })
  })

  it('reads an unmapped window as unmapped rather than as absent', () => {
    const unmapped = DETAIL.replace('Map State: IsViewable', 'Map State: IsUnmapped')
    expect(surface.parseWindowDetail(unmapped).mapState).toBe('IsUnmapped')
  })

  it('reports unknown for a window it could not read, which is not the same as no window', () => {
    expect(surface.parseWindowDetail('').mapState).toBe('unknown')
    expect(surface.parseWindowDetail('xwininfo: Window id: 0x1 (has no name)\n  Width: 1\n').mapState).toBe('unknown')
  })
})

describe('parseNetWmPid(): who owns a window', () => {
  it('reads the owning process', () => {
    expect(surface.parseNetWmPid('_NET_WM_PID(CARDINAL) = 2700167')).toBe(2700167)
  })

  it('reads null for a window that has no pid, which is a real answer', () => {
    expect(surface.parseNetWmPid('_NET_WM_NAME(UTF8_STRING) = "xmessage"')).toBeNull()
    expect(surface.parseNetWmPid('')).toBeNull()
    expect(surface.parseNetWmPid(undefined as unknown as string)).toBeNull()
  })
})

describe('parseWorkArea(): the display own answer about where a window may go', () => {
  it('reads one rectangle', () => {
    expect(surface.parseWorkArea('_NET_WORKAREA(CARDINAL) = 0, 32, 1920, 1048').workArea).toEqual({
      x: 0,
      y: 32,
      width: 1920,
      height: 1048,
    })
  })

  it('keeps every rectangle, because a multi-monitor desktop advertises one per monitor', () => {
    const parsed = surface.parseWorkArea('_NET_WORKAREA(CARDINAL) = 0, 32, 1920, 1048, 1920, 0, 1366, 1080')
    expect(parsed.rectangles).toHaveLength(2)
    expect(parsed.workArea).toEqual(parsed.rectangles[0])
  })

  it('accepts the property without a type annotation', () => {
    expect(surface.parseWorkArea('_NET_WORKAREA = 0, 0, 800, 600').workArea).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    })
  })

  it('reads null when the display advertises no work area at all', () => {
    expect(surface.parseWorkArea('_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x400001').workArea).toBeNull()
    expect(surface.parseWorkArea('').rectangles).toEqual([])
  })
})

describe('rectContains(): the placement property, written independently of the product', () => {
  const workArea = { x: 0, y: 32, width: 1920, height: 1048 }
  const card = { x: 1584, y: 48, width: 320, height: 96 }

  it('accepts the rectangle the pre-flight measured on this machine', () => {
    expect(surface.rectContains(workArea, card)).toBe(true)
  })

  it('rejects a card that overlaps the top panel the work area excludes', () => {
    expect(surface.rectContains(workArea, { x: 1584, y: 0, width: 320, height: 96 })).toBe(false)
  })

  it('rejects a card one pixel past the right or bottom edge', () => {
    expect(surface.rectContains(workArea, { x: 1601, y: 48, width: 320, height: 96 })).toBe(false)
    expect(surface.rectContains(workArea, { x: 1584, y: 985, width: 320, height: 96 })).toBe(false)
  })

  it('accepts a rectangle whose edges sit exactly on the work area edges', () => {
    expect(
      surface.rectContains({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 100, height: 100 }),
    ).toBe(true)
  })

  it('is false rather than throwing for a missing or non-numeric rectangle', () => {
    expect(surface.rectContains(null, card)).toBe(false)
    expect(surface.rectContains(workArea, null)).toBe(false)
    expect(surface.rectContains(workArea, { x: 0, y: 0, width: Number.NaN, height: 1 })).toBe(false)
  })
})

describe('appearedWindowIds(): a window this run made appear, not one that was already there', () => {
  const a = { id: '0x1' }
  const b = { id: '0x2' }
  const c = { id: '0x3' }

  it('returns only the ids that were not in the baseline', () => {
    expect(surface.appearedWindowIds([a, b], [a, b, c])).toEqual(['0x3'])
  })

  it('returns nothing when the desktop is unchanged', () => {
    expect(surface.appearedWindowIds([a, b], [a, b])).toEqual([])
  })

  it('treats an empty baseline as everything, which is how the final whole-desktop sweep works', () => {
    expect(surface.appearedWindowIds([], [a, b])).toEqual(['0x1', '0x2'])
    expect(surface.appearedWindowIds(null, [a])).toEqual(['0x1'])
  })
})

describe('parseXwdPixels(): a window own painted content', () => {
  it('reads a painted window as holding more than one distinct value', () => {
    const capture = buildXwd({
      width: 8,
      height: 4,
      pixels: (x, y) => (x < 4 ? 0xff202020 : 0xffff0000) + y,
    })
    const parsed = surface.parseXwdPixels(capture)
    expect(parsed.ok).toBe(true)
    if (parsed.ok === false) return
    expect(parsed.width).toBe(8)
    expect(parsed.height).toBe(4)
    expect(parsed.pixels).toBe(32)
    expect(parsed.distinctValues).toBeGreaterThan(1)
    expect(parsed.nonZeroPixels).toBe(32)
  })

  it('reads a window that drew nothing as a single value, which is what blank means', () => {
    const parsed = surface.parseXwdPixels(buildXwd({ width: 8, height: 4, pixels: () => 0 }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok === false) return
    expect(parsed.distinctValues).toBe(1)
    expect(parsed.nonZeroPixels).toBe(0)
  })

  it('reads a window painted in one flat colour as a single value, so a background is not a card', () => {
    const parsed = surface.parseXwdPixels(buildXwd({ width: 8, height: 4, pixels: () => 0xff202020 }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok === false) return
    expect(parsed.distinctValues).toBe(1)
    expect(parsed.nonZeroPixels).toBe(32)
  })

  it('handles a 24-bit capture as well as a 32-bit one', () => {
    const parsed = surface.parseXwdPixels(
      buildXwd({ width: 4, height: 2, bitsPerPixel: 24, pixels: (x) => 0x1000 * (x + 1) }),
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok === false) return
    expect(parsed.bitsPerPixel).toBe(24)
    expect(parsed.distinctValues).toBe(4)
  })

  it('reports a reason rather than throwing on a capture that is not an XWD dump', () => {
    expect(surface.parseXwdPixels(Buffer.alloc(4)).ok).toBe(false)
    expect(surface.parseXwdPixels(undefined as unknown as Buffer).ok).toBe(false)
  })

  it('reports a truncated dump, which is a failed capture rather than a blank window', () => {
    const full = buildXwd({ width: 8, height: 4, pixels: () => 1 })
    const parsed = surface.parseXwdPixels(full.subarray(0, full.length - 8))
    expect(parsed.ok).toBe(false)
    if (parsed.ok !== false) return
    expect(parsed.reason).toMatch(/short/)
  })

  it('reports an unexpected file version rather than reading nonsense out of it', () => {
    const wrong = buildXwd({ width: 4, height: 2, pixels: () => 1 })
    wrong.writeUInt32BE(6, 4)
    const parsed = surface.parseXwdPixels(wrong)
    expect(parsed.ok).toBe(false)
    if (parsed.ok !== false) return
    expect(parsed.reason).toMatch(/file version 6/)
  })

  it('names the dominant painted value, which is how a class of card is read from outside', () => {
    // The shape a real capture has on this desktop: a 32-bit dump of a card window whose
    // fill covers most of the surface, with the alpha byte set.
    const parsed = surface.parseXwdPixels(
      buildXwd({ width: 10, height: 10, pixels: (x, y) => (x < 2 || y < 2 ? 0xffc1395e : 0xff3e1823) }),
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok === false) return
    // 64 of 100 pixels are the fill, so it is the dominant value, reduced to 24 bits: an
    // opaque fill and a translucent one of the same colour are the same colour.
    expect(parsed.dominant?.hex).toBe('#3e1823')
    expect(parsed.dominant?.rgb).toEqual([62, 24, 35])
    expect(parsed.dominant?.count).toBe(64)
  })

  it('has no dominant value for a window that drew nothing, rather than a black one', () => {
    const parsed = surface.parseXwdPixels(buildXwd({ width: 6, height: 4, pixels: () => 0 }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok === false) return
    // Zero is what a transparent background is, so a dominant of #000000 would be a colour
    // a card could be painted in. There is no colour here at all.
    expect(parsed.dominant).toBeNull()
  })
})

describe('whose card is it: the product own built stylesheet, read without opening a renderer', () => {
  const PRODUCT_CSS = [
    ':root{--card-fill:#1f2430;--card-border:#6b7c9c;--card-text:#f2f4f8;',
    '--card-block-fill:#3a1f24;--card-block-border:#b55660;',
    '--card-finished-fill:#1b2b24;--card-finished-border:#3f8a63}',
  ].join('')
  const fills = surface.readCardFillsFromCss(PRODUCT_CSS) as {
    needsYou: { rgb: number[]; hex: string }
    finished: { rgb: number[]; hex: string }
    default: { rgb: number[]; hex: string } | null
  }
  // The values this machine's compositor actually handed over once each card had finished
  // arriving, and therefore the shape a real reading has.
  const aCard = (hex: string) => [
    { id: '0x4400004', pixels: { ok: true, distinctValues: 1127, nonZeroPixels: 30_652, dominant: { hex, rgb: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)], count: 26_975 } } },
  ]

  it('reads the two class fills out of the product own stylesheet, in either order', () => {
    expect(fills.needsYou.hex).toBe('#3a1f24')
    expect(fills.finished.hex).toBe('#1b2b24')
    expect(fills.default?.hex).toBe('#1f2430')
  })

  it('reads a three-digit literal and a six-digit one the same way', () => {
    expect(surface.parseHexColor('#fff')).toEqual({ rgb: [255, 255, 255], hex: '#ffffff' })
    expect(surface.parseHexColor('#3a1f24')).toEqual({ rgb: [58, 31, 36], hex: '#3a1f24' })
  })

  it('refuses a literal that is not a colour, and a stylesheet missing a required fill', () => {
    expect(surface.parseHexColor('rgb(1,2,3)')).toBeNull()
    expect(surface.parseHexColor(undefined)).toBeNull()
    expect(surface.readCardFillsFromCss(':root{--card-fill:#1f2430}')).toBeNull()
    expect(surface.readCardFillsFromCss('not css at all')).toBeNull()
  })

  it('calls a needs-you card the product own needs-you card, on the reading this machine produced', () => {
    expect(surface.cardFillVerdict(aCard('#3e1823'), fills)).toBe('needs-you-fill')
  })

  it('calls a finished card the product own finished card, and tells the two apart', () => {
    expect(surface.cardFillVerdict(aCard('#152e24'), fills)).toBe('finished-fill')
    // The same card cannot pass as the other class: this is the whole point of the
    // comparison, because a needs-you card left on the screen would paint the block fill.
    expect(surface.cardFillVerdict(aCard('#3e1823'), fills)).not.toBe('finished-fill')
  })

  it('records the distance it found, so a reader sees the number and not only the verdict', () => {
    const readings = surface.cardFillReadings(aCard('#152e24'), fills)
    expect(readings[0]?.distances['finished-fill']).toBe(6)
    expect(readings[0]?.distances['needs-you-fill']).toBe(37)
    expect(readings[0]?.best?.verdict).toBe('finished-fill')
    expect(readings[0]?.withinTolerance).toBe(true)
  })

  it('is not a pass for a colour that is none of the product own, however painted it is', () => {
    // A blank page, a different tool's window, or a card drawn in a colour the product's
    // build does not name: none of them may read as this product's card.
    for (const hex of ['#000000', '#ff0000', '#ffffff', '#7f7f7f']) {
      expect(surface.cardFillVerdict(aCard(hex), fills)).toBe('no-card-fill')
    }
  })

  it('reads the product own exact values as their own class, before any tolerance is needed', () => {
    expect(surface.cardFillVerdict(aCard('#3a1f24'), fills)).toBe('needs-you-fill')
    expect(surface.cardFillVerdict(aCard('#1b2b24'), fills)).toBe('finished-fill')
  })

  it('cannot separate the product own default fill from its finished fill, and says why that is safe', () => {
    // The one pair the tolerance cannot tell apart: `--card-fill` and
    // `--card-finished-fill` are 12 apart, which is the tolerance. The default cannot be
    // painted on a card at all, because the view writes a `data-urgency` on every card and
    // the stylesheet carries a fill rule for each of the two urgencies, so the default is
    // only ever the value underneath one that has already replaced it. The test records the
    // boundary rather than pretending the comparison is finer than it is.
    expect(surface.channelDistance([31, 36, 48], [27, 43, 36])).toBe(12)
    expect(surface.cardFillVerdict(aCard('#1f2430'), fills)).toBe('finished-fill')
  })

  it('is unreadable rather than a match when the capture failed or held no colour at all', () => {
    expect(surface.cardFillVerdict([{ id: '0x1', pixels: { ok: false, reason: 'xwd failed' } }], fills)).toBe(
      'unreadable',
    )
    expect(
      surface.cardFillVerdict([{ id: '0x1', pixels: { ok: true, distinctValues: 1, dominant: null } }], fills),
    ).toBe('unreadable')
  })

  it('has no verdict at all for no window, which a journey treats as a missing precondition', () => {
    expect(surface.cardFillVerdict([], fills)).toBe('no-card-window')
  })

  it('refuses the comparison outright when the build carries no fills to compare against', () => {
    expect(surface.cardFillVerdict(aCard('#3e1823'), null)).toBe('no-card-fill')
  })

  it('measures the largest per-channel distance, and says so rather than throwing', () => {
    expect(surface.channelDistance([58, 31, 36], [62, 24, 35])).toBe(7)
    expect(surface.channelDistance([0, 0, 0], [10, 10, 10])).toBe(10)
    expect(surface.channelDistance(null, [1, 2, 3])).toBeNull()
    expect(surface.channelDistance([1, 2], [1, 2, 3])).toBeNull()
  })
})

describe('nothing painted is on the screen: two answers, one meaning', () => {
  it('is true for an unmapped window and for a mapped one that drew nothing', () => {
    // The distinction NT-FR-10 turns on, and the distinction the evidence file records:
    // a card element removed out of a window nobody took down is a mapped empty
    // rectangle, which is not a card either.
    expect(surface.noCardOnScreen('no-card-window')).toBe(true)
    expect(surface.noCardOnScreen('blank')).toBe(true)
  })

  it('is false for a painted card, an unreadable capture and no answer at all', () => {
    expect(surface.noCardOnScreen('painted')).toBe(false)
    expect(surface.noCardOnScreen('unreadable')).toBe(false)
    expect(surface.noCardOnScreen(null)).toBe(false)
  })
})

describe('countNotifications(): what the notification centre was asked for', () => {
  const STREAM = [
    'signal time=1 sender=org.freedesktop.DBus -> destination=:1.7 path=/org/freedesktop/DBus; interface=org.freedesktop.DBus; member=NameAcquired',
    'method call time=2 sender=:1.8 -> destination=:1.48 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=GetServerInformation',
    'method call time=3 sender=:1.8 -> destination=:1.48 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=Notify',
    'method call time=4 sender=:1.9 -> destination=:1.48 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=Notify',
  ].join('\n')

  it('counts the Notify calls and not the capability queries around them', () => {
    expect(surface.countNotifications(STREAM)).toBe(2)
  })

  it('reads zero for a stream in which nothing was notified', () => {
    expect(surface.countNotifications('signal time=1 sender=org.freedesktop.DBus; member=NameLost')).toBe(0)
    expect(surface.countNotifications('')).toBe(0)
    expect(surface.countNotifications(undefined as unknown as string)).toBe(0)
  })

  it('does not count a member whose name merely starts with Notify', () => {
    expect(surface.countNotifications('interface=org.freedesktop.Notifications; member=NotifyResponse')).toBe(0)
  })
})

describe("splitChildDiagnostics(): whose line is it", () => {
  // Captured from the shipped entry point on this machine, verbatim apart from the pids.
  const CHROMIUM_TEARDOWN = [
    '[2753645:0927/125950.763423:ERROR:content/common/zygote/zygote_communication_linux.cc:291] Failed to send GetTerminationStatus message to zygote',
    '[2753645:0927/125950.767609:ERROR:content/browser/network_service_instance_impl.cc:650] Network service crashed or was terminated, restarting service.',
    '[2753645:0927/125950.773192:ERROR:content/browser/gpu/gpu_process_host.cc:1029] GPU process launch failed: error_code=1002',
    '[2753645:0927/125950.776233:FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:417] GPU process isn\'t usable. Goodbye.',
  ]

  it('separates the runtime teardown noise from the lines the product wrote', () => {
    const split = surface.splitChildDiagnostics([...CHROMIUM_TEARDOWN, 'agent-ping: a card window could not be created'])
    expect(split.chromiumCount).toBe(4)
    expect(split.productCount).toBe(1)
    expect(split.product).toEqual(['agent-ping: a card window could not be created'])
  })

  it('reads a product line that carries no timestamp as the product own, never as Chromium', () => {
    const split = surface.splitChildDiagnostics(['hub: agent-ping: stopping on signal:SIGTERM'])
    expect(split.productCount).toBe(1)
    expect(split.chromiumCount).toBe(0)
  })

  it('reads a shipped run that said nothing as a zero product count, not as a missing count', () => {
    const split = surface.splitChildDiagnostics(CHROMIUM_TEARDOWN)
    expect(split.productCount).toBe(0)
    expect(split.chromium).toHaveLength(4)
  })

  it('produces a zero split from nothing at all, rather than throwing', () => {
    const split = surface.splitChildDiagnostics(undefined as unknown as string[])
    expect(split).toEqual({ product: [], chromium: [], productCount: 0, chromiumCount: 0 })
  })

  it('is what keeps the not-wired finding from contradicting its own count', () => {
    const change = surface
      .productChanges({
        shipped: { artefacts: 'in-the-build' },
        productLineCount: 0,
        chromiumLineCount: 4,
      })
      .open.find((entry: { id: string }) => entry.id === 'not-wired-diagnostic-has-no-destination')
    expect(change?.observed).toMatch(/0 of those lines were written by this product/)
    expect(change?.observed).toMatch(/4 by the Electron runtime tearing itself down/)
    // A count of every captured line would have read "found 4 diagnostic line(s)" beside
    // "never reported anywhere", which is a contradiction a reader cannot resolve.
    expect(change?.observed).not.toMatch(/found 4 diagnostic line/)
  })
})

describe('cardWindowVerdict() and cardPixelsVerdict(): what the observer concluded', () => {
  const workArea = { x: 0, y: 32, width: 1920, height: 1048 }
  const card = { x: 1584, y: 48, width: 320, height: 96, pixels: { ok: true, distinctValues: 310 } }

  it('reads a card inside the work area as inside it', () => {
    expect(surface.cardWindowVerdict([{ ...card }], workArea)).toBe('inside-the-work-area')
  })

  it('reads a card over the top panel as outside the work area', () => {
    expect(surface.cardWindowVerdict([{ ...card, y: 0 }], workArea)).toBe('outside-the-work-area')
  })

  it('reads an empty candidate list as no card window rather than as a pass', () => {
    expect(surface.cardWindowVerdict([], workArea)).toBe('no-card-window')
    expect(surface.cardPixelsVerdict([])).toBe('no-card-window')
  })

  it('reads painted pixels as painted, and a failed capture as not painted', () => {
    expect(surface.cardPixelsVerdict([{ ...card }])).toBe('painted')
    expect(surface.cardPixelsVerdict([{ ...card, pixels: { ok: false, reason: 'too short' } }])).toBe('blank')
    expect(surface.cardPixelsVerdict([{ ...card, pixels: { ok: true, distinctValues: 1 } }])).toBe('blank')
  })
})

describe('screenWindowFacts(): the four conditions before a window is called a card', () => {
  const hubPid = 4_242
  const cardFact = { id: '0x4400004', pid: hubPid, detail: { mapState: 'IsViewable', width: 320, height: 96, x: 1584, y: 48, depth: 32 } }

  it('accepts a new, viewable, correctly-sized window owned by the hub', () => {
    const { candidates, rejected } = surface.screenWindowFacts([cardFact], hubPid)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.id).toBe('0x4400004')
    expect(rejected).toEqual([])
  })

  it("rejects another process's window, including a decoration frame around one", () => {
    const frame = { id: '0x600161', pid: 900, detail: { mapState: 'IsViewable', width: 388, height: 226, x: 106, y: 108, depth: 32 } }
    const { candidates, rejected } = surface.screenWindowFacts([frame], hubPid)
    expect(candidates).toEqual([])
    expect(rejected[0]?.why).toBe('not owned by the hub process')
  })

  it('rejects a window that exists but is not on the screen, which is the NT-FR-10 distinction', () => {
    const unmapped = { ...cardFact, detail: { ...cardFact.detail, mapState: 'IsUnmapped' } }
    const { candidates, rejected } = surface.screenWindowFacts([unmapped], hubPid)
    expect(candidates).toEqual([])
    expect(rejected[0]?.why).toMatch(/map state is IsUnmapped/)
  })

  it('rejects a window of some other size, and says which size it was', () => {
    const other = { ...cardFact, detail: { ...cardFact.detail, width: 1100, height: 760 } }
    const { candidates, rejected } = surface.screenWindowFacts([other], hubPid)
    expect(candidates).toEqual([])
    expect(rejected[0]?.why).toMatch(/1100x760/)
  })

  it('rejects a window the display would not let it read, rather than calling it a card', () => {
    const unreadable = { id: '0x1', pid: hubPid, detail: { mapState: 'unknown', width: null, height: null, x: null, y: null, depth: null } }
    const { candidates, rejected } = surface.screenWindowFacts([unreadable], hubPid)
    expect(candidates).toEqual([])
    expect(rejected[0]?.why).toMatch(/map state is unknown/)
  })

  it('produces nothing at all from nothing at all', () => {
    expect(surface.screenWindowFacts([], hubPid)).toEqual({ candidates: [], rejected: [] })
    expect(surface.screenWindowFacts(undefined, hubPid)).toEqual({ candidates: [], rejected: [] })
  })
})

describe('parseArgs(): the command line, with no way to tolerate a failure', () => {
  it('defaults to the evidence path in the repository', () => {
    expect(surface.parseArgs([])).toEqual({
      out: 'docs/reviews/notification-surface-evidence.json',
      keepState: false,
      help: false,
    })
  })

  it('takes an output path and keeps the temporary state on request', () => {
    expect(surface.parseArgs(['--out', '/tmp/x.json', '--keep-state'])).toEqual({
      out: '/tmp/x.json',
      keepState: true,
      help: false,
    })
  })

  it('refuses --out with no path rather than writing to "undefined"', () => {
    expect(() => surface.parseArgs(['--out'])).toThrow(/--out needs a path/)
    expect(() => surface.parseArgs(['--out', '--keep-state'])).toThrow(/--out needs a path/)
  })

  it('refuses an unrecognised argument, and refuses the two that would weaken the verdict', () => {
    expect(() => surface.parseArgs(['--tolerate-failures'])).toThrow(/unrecognised argument/)
    expect(() => surface.parseArgs(['--skip'])).toThrow(/unrecognised argument/)
    expect(() => surface.parseArgs(['--display'])).toThrow(/unrecognised argument/)
  })
})

describe('resolveOnPath(): a preflight that reports the desktop honestly', () => {
  it('finds a command in the first PATH entry that has it', () => {
    const found = surface.resolveOnPath('sh', { PATH: '/nowhere:/bin' })
    expect(found).toBe('/bin/sh')
  })

  it('reads null rather than a bare name, so a preflight cannot claim a tool it never resolved', () => {
    expect(surface.resolveOnPath('definitely-not-installed-xyz', { PATH: '/bin' })).toBeNull()
    expect(surface.resolveOnPath('xwininfo', { PATH: '' })).toBeNull()
  })

  it('accepts a path with a separator as given, and answers whether it exists', () => {
    expect(surface.resolveOnPath('/bin/sh', { PATH: '' })).toBe('/bin/sh')
    expect(surface.resolveOnPath('/definitely/not/here', { PATH: '' })).toBeNull()
  })
})

describe('productChanges(): what is closed, by whom, and what is still open', () => {
  const shipped = { artefacts: 'in-the-build' }
  const changes = (overrides: Record<string, unknown> = {}): {
    closed: Array<Record<string, unknown>>
    open: Array<Record<string, unknown>>
  } => surface.productChanges({ shipped, productLineCount: 0, chromiumLineCount: 0, ...overrides }) as never

  it('closes the card document, the renderer channel and the acknowledgement hook, each with the task that closed it', () => {
    const byTask = new Map(changes().closed.map((entry) => [String(entry.id), String(entry.closedBy)]))
    // The three gaps NT-9 could only record because its own run had substituted all three.
    expect(byTask.get('card-document-entry')).toBe('NS-1')
    expect(byTask.get('card-renderer-channel')).toBe('NS-2')
    expect(byTask.get('acknowledgement-does-not-reach-the-card')).toBe('NS-3')
  })

  it('names before and after on every closed gap, because a closure is a claim about a change', () => {
    for (const entry of changes().closed) {
      expect(String(entry.observedBefore).length).toBeGreaterThan(20)
      expect(String(entry.observedNow).length).toBeGreaterThan(20)
      // The assertion in this run that holds the closure up, by name, so a reader can
      // find it in the assertions list rather than take the sentence's word for it.
      expect(String(entry.howThisRunProvesIt).length).toBeGreaterThan(10)
    }
  })

  it('says on every entry that this run supplied nothing, because it supplies nothing', () => {
    for (const entry of [...changes().closed, ...changes().open]) {
      expect(String(entry.suppliedByThisRun).toLowerCase()).toMatch(/nothing|no |none/)
    }
  })

  it('keeps the three findings that are genuinely still open', () => {
    expect(changes().open.map((entry) => String(entry.id))).toEqual([
      'not-wired-diagnostic-has-no-destination',
      'tray-is-not-observable-outside-the-process',
      'the-durable-schema-is-not-in-the-build',
    ])
  })

  it('reports the diagnostic finding with the line counts it actually saw', () => {
    const entry = changes({ productLineCount: 3, chromiumLineCount: 11 }).open.find(
      (candidate) => String(candidate.id) === 'not-wired-diagnostic-has-no-destination',
    )
    expect(String(entry?.observed)).toMatch(/3 of those lines were written by this product/)
    expect(String(entry?.observed)).toMatch(/11 by the Electron runtime/)
  })

  it('raises a missing built artefact as an open change rather than quietly passing', () => {
    const missing = changes({ shipped: { artefacts: 'missing: the preload the surface window loads' } })
    expect(missing.open[0]?.id).toBe('the-shipped-build-is-missing-a-card-artefact')
    expect(String(missing.open[0]?.observed)).toMatch(/missing: the preload/)
    // And it says why the run did not create it, which is the whole discipline.
    expect(String(missing.open[0]?.suppliedByThisRun)).toMatch(/would prove itself/)
  })

  it('names an owner and something to do on every open change', () => {
    for (const entry of changes().open) {
      expect(String(entry.owner)).toMatch(/engineer/)
      expect(String(entry.required).length).toBeGreaterThan(20)
    }
  })
})

describe('the shipped build: the two rows NT-9 recorded and this run asserts', () => {
  const allPresent = { document: true, preload: true, entry: true, stylesheet: true }

  it('accepts a build that carries all four of the artefacts the card needs', () => {
    expect(surface.shippedArtefactsVerdict(allPresent)).toBe('in-the-build')
  })

  it('names each missing artefact, because a missing dependency is never a skip', () => {
    expect(surface.shippedArtefactsVerdict({ ...allPresent, document: false })).toMatch(
      /missing: the built card document/,
    )
    expect(surface.shippedArtefactsVerdict({ ...allPresent, preload: false })).toMatch(
      /missing: the preload the surface window loads/,
    )
    expect(surface.shippedArtefactsVerdict({ ...allPresent, entry: false, stylesheet: false })).toMatch(
      /the entry bundle the card document loads, the stylesheet the card document links/,
    )
    expect(surface.shippedArtefactsVerdict(null)).toMatch(/^missing:/)
  })

  it('reads the delivery policy own answer about whether a card presenter is wired', () => {
    expect(surface.wiredVerdict({ wired: true, status: 'ok' })).toBe('wired')
    // The product's own reason travels into the failure, so a red row says why.
    expect(surface.wiredVerdict({ wired: false, status: 'not-wired' })).toBe('not-wired: not-wired')
    expect(surface.wiredVerdict(null)).toBe('no-delivery-section')
  })

  it('accepts the document the build produced, byte for byte, under the product own policy', () => {
    const html = '<!doctype html><div data-card-surface></div>'
    expect(
      surface.servedDocumentVerdict({
        status: 200,
        served: html,
        built: html,
        policy: "default-src 'self'",
        permissiveHeader: false,
      }),
    ).toBe('served-identically')
  })

  it('refuses a body that is not the built document, which is what a substituted one looks like', () => {
    // The exact shape NT-9 needed: a document that answers 200 and is not the product's.
    expect(
      surface.servedDocumentVerdict({
        status: 200,
        served: '<!doctype html><div data-card-surface></div><script type="module" src="/card-entry.js">',
        built: '<!doctype html><div data-card-surface></div>',
        policy: "default-src 'self'",
        permissiveHeader: false,
      }),
    ).toBe('served-something-else: the body is not the built document')
  })

  it('refuses a document served with no policy, or with a permissive cross-origin header', () => {
    const html = 'x'
    expect(
      surface.servedDocumentVerdict({ status: 200, served: html, built: html, policy: null, permissiveHeader: false }),
    ).toBe('served-without-a-content-security-policy')
    expect(
      surface.servedDocumentVerdict({
        status: 200,
        served: html,
        built: html,
        policy: "default-src 'self'",
        permissiveHeader: true,
      }),
    ).toMatch(/^served-with-a-permissive-header/)
  })

  it('refuses a document that was not served at all', () => {
    expect(
      surface.servedDocumentVerdict({ status: 404, served: null, built: 'x', policy: null, permissiveHeader: false }),
    ).toBe('not-served: 404')
  })
})

describe('emergingCardWindows(): a card that came into being, not one that was already there', () => {
  const hubPid = 4_242
  const viewable = (id: string) => ({
    id,
    pid: hubPid,
    detail: { mapState: 'IsViewable', width: 320, height: 96, x: 1584, y: 48, depth: 32 },
    pixels: { ok: true, distinctValues: 310 },
  })
  const unmapped = (id: string) => ({
    ...viewable(id),
    detail: { ...viewable(id).detail, mapState: 'IsUnMapped' },
  })

  it('calls a window that was not there before a new window', () => {
    const { emerging, rejected } = surface.emergingCardWindows([], [viewable('0x4400004')], hubPid)
    expect(emerging).toHaveLength(1)
    expect(emerging[0]?.emergedBecause).toBe('new-window')
    expect(rejected).toEqual([])
  })

  it('calls the same window shown again a card that came into being, which is the second card in a run', () => {
    const { emerging } = surface.emergingCardWindows([unmapped('0x4400004')], [viewable('0x4400004')], hubPid)
    expect(emerging).toHaveLength(1)
    expect(emerging[0]?.emergedBecause).toMatch(/shown-again/)
  })

  it('refuses to count a window that was already on the screen, and says why', () => {
    const { emerging, rejected } = surface.emergingCardWindows(
      [viewable('0x4400004')],
      [viewable('0x4400004')],
      hubPid,
    )
    expect(emerging).toEqual([])
    expect(rejected[0]?.why).toMatch(/already viewable before this journey/)
  })

  it('keeps the four conditions: another process, another size or an unreadable window is still not a card', () => {
    const other = { ...viewable('0x1'), pid: 900 }
    expect(surface.emergingCardWindows([], [other], hubPid).emerging).toEqual([])
    const big = { ...viewable('0x1'), detail: { ...viewable('0x1').detail, width: 1100 } }
    expect(surface.emergingCardWindows([], [big], hubPid).emerging).toEqual([])
  })

  it('produces nothing at all from nothing at all', () => {
    expect(surface.emergingCardWindows(undefined, undefined, hubPid)).toEqual({ emerging: [], rejected: [] })
  })
})

describe('cardOnScreenVerdict(): painted, blank, absent and unreadable are four different answers', () => {
  const hubPid = 99
  const fact = (pixels: unknown) => ({
    id: '0x4400004',
    pid: hubPid,
    detail: { mapState: 'IsViewable', width: 320, height: 96, x: 1584, y: 48, depth: 32 },
    pixels,
  })

  it('is painted only when the window own drawable holds drawn content', () => {
    expect(surface.cardOnScreenVerdict([fact({ ok: true, distinctValues: 310 })], hubPid)).toBe('painted')
  })

  it('is blank for a mapped window that drew nothing, which is a card that ended and a window that did not', () => {
    expect(surface.cardOnScreenVerdict([fact({ ok: true, distinctValues: 1, nonZeroPixels: 0 })], hubPid)).toBe('blank')
  })

  it('is unreadable rather than blank when the capture failed, so a broken xwd is never evidence of absence', () => {
    expect(surface.cardOnScreenVerdict([fact({ ok: false, reason: 'too short' })], hubPid)).toBe('unreadable')
  })

  it('is no-card-window when the hub owns no viewable card-shaped window at all', () => {
    expect(surface.cardOnScreenVerdict([], hubPid)).toBe('no-card-window')
    const hidden = { ...fact({ ok: true, distinctValues: 310 }), detail: { ...fact({}).detail, mapState: 'IsUnMapped' } }
    expect(surface.cardOnScreenVerdict([hidden], hubPid)).toBe('no-card-window')
  })

  it('carries the pixels through the four conditions, so one reading answers both questions', () => {
    const { candidates } = surface.screenWindowFacts([fact({ ok: true, distinctValues: 7 })], hubPid)
    expect(candidates[0]?.pixels).toEqual({ ok: true, distinctValues: 7 })
    const without = surface.screenWindowFacts([{ ...fact({ ok: true, distinctValues: 7 }), pixels: undefined }], hubPid)
    expect('pixels' in (without.candidates[0] as object)).toBe(false)
  })
})

describe('the readings this run gave up, and what it says instead of them', () => {
  // These are gone, and this block is the record of why. A card's contents - its element
  // tree, its attributes, its accessible name, its live-region role - were read through a
  // bridge this script had to build, because the product had no way to hand a card model to
  // a document. NS-2 gave the product its own channel and NS-1 gave it its own document, so
  // the bridge went with them, and a run that rebuilt it would be back to measuring itself.
  it('no longer exports anything that reads a renderer', () => {
    const exports = Object.keys(surface)
    for (const name of [
      'cardReportVerdict',
      'CARD_ATTRIBUTES_EXPECTED',
      'parseHarnessReportLine',
      'latestCardReport',
      'CARD_REPORT_PREFIX',
      'CARD_DOCUMENT_READY_TIMEOUT_MS',
    ]) {
      expect(exports).not.toContain(name)
    }
  })

  it('names the loss in the evidence file rather than quietly dropping the claim', () => {
    const runbook = readFileSync(
      path.join(repoRoot, 'docs', 'runbooks', 'notification-surface.md'),
      'utf8',
    )
    // The runbook is where a human looks for what a run does not cover, and the card's
    // contents are the biggest thing this run no longer covers.
    expect(runbook).toMatch(/contents of the card/i)
    expect(runbook).toMatch(/not[\s\S]{0,80}read/i)
  })
})

describe('deliveryVerdict(): the claim, not the status string', () => {
  const status = (overrides: Record<string, unknown>) => ({
    status: 'ok',
    wired: true,
    attempted: 2,
    delivered: 2,
    failed: 0,
    timedOut: 0,
    notWired: 0,
    ...overrides,
  })

  it('is delivered only when a card went out and nothing failed', () => {
    expect(surface.deliveryVerdict(status({}))).toBe('delivered')
  })

  it('refuses a hub that answered ok with nothing delivered, which is the case a status check would pass', () => {
    expect(surface.deliveryVerdict(status({ delivered: 0 }))).toMatch(/nothing-delivered/)
  })

  it('names an unwired hub rather than calling it delivered', () => {
    expect(surface.deliveryVerdict(status({ wired: false, status: 'not-wired', delivered: 0 }))).toMatch(/not-wired/)
  })

  it('names a failure beside the delivery, because one card going out is not a clean path', () => {
    expect(surface.deliveryVerdict(status({ failed: 1 }))).toMatch(/some-failed/)
  })

  it('has no answer at all when the payload is missing', () => {
    expect(surface.deliveryVerdict(null)).toBe('no-delivery-section')
  })
})

describe('the window options the shipped build carries, and the prose that would have lied about them', () => {
  // The shape of the real built module's header: the settings this product refuses to use
  // are named in the prose, next to the object that does not use them. A reader that took
  // the first match of either would have published the opposite of the configuration in an
  // evidence file, which is the one thing a verification run exists to prevent.
  const MODULE_WITH_MISLEADING_PROSE = [
    '/**',
    ' * NO webSecurity: `webSecurity: false` or `nodeIntegration: true` would trade the',
    ' * boundary for convenience.',
    ' */',
    'export const SURFACE_WINDOW_OPTIONS = Object.freeze({',
    '    width: CARD_SIZE.width,',
    '    transparent: true,',
    '    show: false,',
    '    webPreferences: Object.freeze({',
    '        contextIsolation: true,',
    '        nodeIntegration: false,',
    '        sandbox: true,',
    '        preload: CARD_PRELOAD_PATH,',
    '    }),',
    '});',
    '// webSecurity: false is deliberately absent from the object above.',
  ].join('\n')

  it('reads the three settings the isolation claim rests on out of the option object', () => {
    const options = surface.readSurfaceWindowOptions(MODULE_WITH_MISLEADING_PROSE)
    expect(options.available).toBe(true)
    expect(options.contextIsolation).toBe('true')
    expect(options.nodeIntegration).toBe('false')
    expect(options.sandbox).toBe('true')
    expect(options.preload).toBe('CARD_PRELOAD_PATH')
  })

  it('never takes a setting from the prose that names the opposite, which is the whole point', () => {
    const options = surface.readSurfaceWindowOptions(MODULE_WITH_MISLEADING_PROSE)
    // Absent is the answer and null is the honest way to say it: the product does not widen
    // it, so the key is not in the object at all.
    expect(options.webSecurity).toBeNull()
    expect(options.nodeIntegration).toBe('false')
  })

  it('says plainly that it read the build and not the running window', () => {
    const options = surface.readSurfaceWindowOptions(MODULE_WITH_MISLEADING_PROSE)
    expect(String(options.notObserved)).toMatch(/record of the build/)
    expect(String(options.howThisWasRead)).toMatch(/comments stripped/)
  })

  it('reports a module with no option object rather than reading a setting out of nothing', () => {
    expect(surface.readSurfaceWindowOptions('// nothing here').available).toBe(false)
    expect(surface.readSurfaceWindowOptions('').available).toBe(false)
  })

  it('strips comments and keeps strings, which is what every source sweep in this repository does', () => {
    // Blanking rather than deleting, so offsets and line numbers survive: the sweep has to
    // point at a line as well as to find a token.
    const stripped = surface.stripComments('a // gone\nb /* also gone */ c')
    expect(stripped).toHaveLength('a // gone\nb /* also gone */ c'.length)
    expect(stripped.split('\n')).toHaveLength(2)
    expect(stripped).not.toMatch(/gone/)
    expect(stripped.replace(/\s/g, '')).toBe('abc')
    // A string that looks like a comment is a name, and a forbidden name is most often
    // only ever a string.
    expect(surface.stripComments("keep 'a // b' here")).toBe("keep 'a // b' here")
    expect(surface.stripComments('block /* with newline */ after')).toContain('after')
  })
})

describe('this script supplies no part of the card path, and the source proves it', () => {
  // ── The reader ────────────────────────────────────────────────────────────
  // One product source file with its comments removed and its strings kept.
  //
  // Comments go because a source-level check is about the calls a module makes, not about
  // the sentences describing them - and this repository's prose names every forbidden
  // shape it deliberately avoids, so keeping comments would make the check fail on its own
  // documentation. Strings stay, because a forbidden *name* is most often only ever a
  // string.
  //
  // Known limitation, stated rather than hidden: a backtick template is read as one string
  // to its closing backtick, so a nested template inside a `${...}` would end the scan
  // early. No template in this file contains one, and a missed token would still be caught
  // by the same token in the value the code then uses.
  const withoutProse = readWithoutProse(readFileSync(scriptPath, 'utf8'))
  const exports = Object.keys(surface).sort()

  it('contains no card document, because the product built and serves its own', () => {
    // NT-9 generated a document into a prepared dashboard root so that a card window had
    // something to load. Four tokens, one per thing a generated document contains.
    for (const token of ['<!doctype html>', '<div data-card-surface', 'data-card-surface', '<link rel="stylesheet"']) {
      expect(withoutProse).not.toContain(token)
    }
    expect(exports).not.toContain('cardDocumentSource')
  })

  it('contains no card stylesheet, because the product paint its own', () => {
    // A stylesheet is a rule block keyed on the card's own attributes. The one attribute
    // the product's view writes and this run has no business knowing about is the surface
    // element; the rules that hang on the card's own attributes are the stylesheet's.
    for (const token of [
      "data-card-urgency-icon",
      "data-card-urgency-word",
      "[data-card][data-urgency",
      "border-radius:",
      "box-sizing: border-box",
    ]) {
      expect(withoutProse).not.toContain(token)
    }
  })

  it('contains no card entry module, because the product ships its own', () => {
    // The harness wrote card-entry.js and imported the product's compiled card view by
    // the name the hub served it under. Neither the file name nor the import is left.
    for (const token of ['card-entry.js', 'createCardView', 'card-view.js', 'GENERATED by']) {
      expect(withoutProse).not.toContain(token)
    }
    expect(exports).not.toContain('cardEntrySource')
    expect(exports).not.toContain('harnessMainSource')
  })

  it('contains no renderer bridge, because the product has a channel of its own', () => {
    // The shape NT-9 used to carry a card model into a real renderer, and the shape this
    // run exists to prove the product does not need. The whole token family goes.
    for (const token of [
      'executeJavaScript',
      'webContents',
      'exposeInMainWorld',
      'ipcRenderer',
      'contextBridge',
      '__agentPingCardSurface',
      '##CARD##',
    ]) {
      expect(withoutProse).not.toContain(token)
    }
    expect(exports).not.toContain('SHOW_CARD_CALL_PREFIX')
    expect(exports).not.toContain('REMOVE_CARD_CALL_PREFIX')
    expect(exports).not.toContain('READ_CARD_REPORT_JS')
    expect(exports).not.toContain('CARD_SURFACE_GLOBAL')
  })

  it('points the hub at no root of its own, so the document it serves is the product own', () => {
    // The override that would let a run serve its own dashboard. The state directory
    // stays, because that is the product's own mechanism and a fresh one is what keeps a
    // run from touching an installation.
    expect(withoutProse).not.toContain('AGENT_PING_SURFACE_DASHBOARD_ROOT')
    expect(withoutProse).not.toContain('dashboardRoot:')
    expect(withoutProse).toContain('AGENT_PING_STATE_DIR')
  })

  it('writes exactly one file, and that file is the evidence', () => {
    // The bluntest of the four checks and the one that cannot be evaded: no substituted
    // document, no substituted stylesheet, no substituted module and no manifest of what
    // was written, because the run writes nothing but its own report.
    const writes = withoutProse.match(/writeFileSync\(/g) ?? []
    expect(writes).toHaveLength(1)
    expect(withoutProse).not.toContain('mkdirSync(path.join(rootDir')
    expect(exports).not.toContain('prepareHarness')
  })

  it('starts the product own entry point and no second process', () => {
    // One Electron launch, and it is the built entry point. There is no generated main
    // process, so there is no second implementation of anything the product decides.
    expect(exports).toContain('launchHub')
    expect(exports).not.toContain('launchChild')
    const spawns = withoutProse.match(/spawn\(/g) ?? []
    expect(spawns).toHaveLength(3)
    // Three, and each one is accounted for: the hub, the control window, the bus monitor.
    expect(withoutProse).toContain('spawn(electronBinary')
    expect(withoutProse).toContain('spawn(observer.tools.xmessage')
    expect(withoutProse).toContain('spawn(dbusMonitor')
  })

  it('still refuses to name a platform notification mechanism anywhere', () => {
    // Kept from NT-9 unchanged: the one `notify-send` in this file is a positive control
    // and it is named only in a string, so the sweep below is about the code.
    const calls = withoutProse.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
    for (const token of [
      'notify-send',
      'org.freedesktop.Notifications',
      'Notification.requestPermission',
      'new Notification',
      'osascript',
      'zenity',
      'powershell',
      'terminal-notifier',
      'dbus-send',
    ]) {
      expect(calls).not.toContain(token)
    }
  })

  it('carries the new verdicts rather than the readings it gave up', () => {
    // The exports are the contract, so a verifier that lost a claim says so here.
    for (const name of [
      'readCardFillsFromCss',
      'cardFillVerdict',
      'cardFillReadings',
      'noCardOnScreen',
      'shippedArtefactsVerdict',
      'servedDocumentVerdict',
      'wiredVerdict',
      'cardPaintSignature',
      'readBuiltCardDocument',
      'productChanges',
    ]) {
      expect(exports).toContain(name)
    }
    // And the ones it no longer has: a card's contents are not readable from outside.
    for (const name of [
      'cardReportVerdict',
      'CARD_ATTRIBUTES_EXPECTED',
      'parseHarnessReportLine',
      'latestCardReport',
      'CARD_REPORT_PREFIX',
      'requiredProductChanges',
      'BUILT_CARD_MODULES',
    ]) {
      expect(exports).not.toContain(name)
    }
  })

  it('waits for a card to stop arriving before it compares the card with its own colour', () => {
    // The arrival is the product's own animation, and a mid-flight capture reads a colour
    // blended part way between the fill and nothing. The tolerance and the settle both come
    // from that measurement, so both are named in one place.
    expect(surface.CARD_FILL_TOLERANCE).toBe(12)
    expect(surface.CARD_PAINT_STABLE_READS).toBe(2)
    expect(surface.CARD_PAINT_STABLE_TIMEOUT_MS).toBe(3_000)
    const hubPid = 99
    const painted = (hex: string) => [
      { id: '0x1', pid: hubPid, detail: { mapState: 'IsViewable', width: 320, height: 96 }, pixels: { ok: true, distinctValues: 2, nonZeroPixels: 10, dominant: { hex, rgb: [1, 2, 3], count: 8 } } },
    ]
    expect(surface.cardPaintSignature(painted('#3e1823'), hubPid)).toContain('0x1:#3e1823:2:10')
    // A card that is still fading has a different signature each time, and an empty
    // desktop has none, so neither is mistaken for a card at rest.
    expect(surface.cardPaintSignature(painted('#3e1823'), hubPid)).not.toBe(
      surface.cardPaintSignature(painted('#3b1721'), hubPid),
    )
    expect(surface.cardPaintSignature([], hubPid)).toBeNull()
  })
})

describe('preflight(): every dependency a journey needs is named before any assertion runs', () => {
  it('asks for a display, the X tools, the built hub, the built dashboard and the product own card view', () => {
    const names = surface.preflight().dependencies.map((dependency: { name: string }) => dependency.name)
    expect(names).toContain('a display')
    expect(names).toContain('the xwininfo X tool')
    expect(names).toContain('the xwd X tool')
    expect(names).toContain('the built Electron main entry point')
    expect(names).toContain('the built dashboard')
    // The card document and the preload are the product's own artefacts now, so a build
    // without them is a failed dependency rather than something this run supplies.
    expect(names).toContain("the product's own built card document and the preload its window loads")
  })

  it('gives every dependency a remedy, because a non-zero exit with no next action trains people to ignore it', () => {
    for (const dependency of surface.preflight().dependencies) {
      expect(String(dependency.remedy).length).toBeGreaterThan(10)
    }
  })

  it('starts the real Electron binary rather than the shim, so a stop takes the windows with it', () => {
    const dependency = surface
      .preflight()
      .dependencies.find((entry: { name: string }) => entry.name === 'the electron binary')
    expect(String(dependency?.detail)).toMatch(/dist[\\/]electron/)
  })
})

describe('the shipped script, driven as a child process', () => {
  it('prints usage and exits zero for --help', () => {
    const run = runScript(['--help'])
    expect(run.status).toBe(0)
    expect(run.stdout).toMatch(/usage: node scripts\/verify-notification-surface\.mjs/)
  })

  it('exits 2 on an unrecognised argument, and writes no summary claiming a verdict', () => {
    const run = runScript(['--tolerate-failures'])
    expect(run.status).toBe(2)
    expect(run.summary).toBeNull()
  })

  it('a missing display fails the script rather than skipping it, and names the remedy', () => {
    const evidencePath = path.join(scratch, 'no-display.json')
    const run = runScript(['--out', evidencePath], { DISPLAY: '', WAYLAND_DISPLAY: '' })
    expect(run.status).toBe(3)
    expect(run.summary?.verdict).toBe('fail')
    expect(run.summary?.assertionsRun).toBe(0)
    expect(run.summary?.evidenceWritten).toBe(false)
    const failures = (run.summary?.failures as string[] | undefined) ?? []
    expect(failures.join('\n')).toMatch(/required dependency unavailable: a display/)
    expect(failures.join('\n')).toMatch(/graphical session/)
    // The control that matters most: an absent dependency writes no report at all, because
    // a report saying "nothing was there" is indistinguishable from one saying "nothing
    // was looked for".
    expect(existsSync(evidencePath)).toBe(false)
  })

  it('a missing electron binary fails the script with npm install as the remedy', () => {
    // An empty PATH removes every tool including the Electron wrapper, which is the same
    // shape of failure as an uninstalled dependency and is the one this suite can produce
    // on any machine.
    const run = runScript([], { PATH: '' })
    expect(run.status).toBe(3)
    const failures = (run.summary?.failures as string[] | undefined) ?? []
    expect(failures.join('\n')).toMatch(/required dependency unavailable/)
  })

  it('stdout carries the summary and nothing else, so it stays parseable', () => {
    const run = runScript(['--out', path.join(scratch, 'parse.json')], { PATH: '' })
    expect(run.summary).not.toBeNull()
    expect(run.summary?.script).toBe('verify-notification-surface')
    expect(run.stderr).toBe('')
  })
})
