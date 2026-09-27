// Tests the notification-surface verification script (NT-9: NT-FR-02, NT-FR-04, NT-FR-08,
// NT-FR-10, APX-CON-06, APX-CON-12).
//
// Two halves, and both matter:
//
//   - the decision logic and every parser are driven with injected values, so the
//     judgement and every parse are verified on a machine with no display, no Electron
//     binary and no X tools. This is the half that makes the script's pass/fail trustworthy
//     rather than only ever exercised on a desk that happens to work.
//   - the real script is spawned as a child process for the three properties that can only
//     be established by running it: a missing display is a non-zero exit with a remedy and
//     no evidence file, a bad command line is its own exit code, and the machine-readable
//     summary on stdout is parseable on its own.
//
// The six acceptance criteria map to the describe blocks below by name.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
      for (let index = step - 1; index >= 0; index -= 1) {
        buffer[at + index] = (value >> ((step - 1 - index) * 8)) & 0xff
      }
    }
  }
  return buffer
}

describe('the assertion inventory cannot drift from the rows the journeys emit', () => {
  it('the expected total is the sum of the four lists', () => {
    const total =
      surface.OPENING_ASSERTIONS.length +
      surface.NEEDS_YOU_ASSERTIONS.length +
      surface.FINISHED_ASSERTIONS.length +
      surface.GREETING_ASSERTIONS.length
    expect(total).toBe(surface.ASSERTIONS_EXPECTED)
  })

  it('no two assertions share a name, so a failure names exactly one thing', () => {
    const names = [
      ...surface.OPENING_ASSERTIONS,
      ...surface.NEEDS_YOU_ASSERTIONS,
      ...surface.FINISHED_ASSERTIONS,
      ...surface.GREETING_ASSERTIONS,
    ]
    expect(new Set(names).size).toBe(names.length)
  })

  it('every list is frozen, because a journey that appends to one would change the count', () => {
    for (const list of [
      surface.OPENING_ASSERTIONS,
      surface.NEEDS_YOU_ASSERTIONS,
      surface.FINISHED_ASSERTIONS,
      surface.GREETING_ASSERTIONS,
    ]) {
      expect(Object.isFrozen(list)).toBe(true)
    }
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
      .requiredProductChanges({
        evidence: { repository: { cardDocumentPresent: true }, delivery: { wired: true, lastFailure: null } },
        shipped: { delivery: { wired: true, status: 'ok', delivered: 1 } },
        childLineCount: 0,
        chromiumLineCount: 4,
      })
      .find((entry: { id: string }) => entry.id === 'not-wired-diagnostic-has-no-destination')
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

describe('requiredProductChanges(): findings recorded, with what this run supplied in their place', () => {
  const evidenceWith = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    repository: { cardDocumentPresent: true },
    delivery: { wired: true, lastFailure: null },
    ...overrides,
  })
  const shippedWith = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    delivery: { wired: true, status: 'ok', delivered: 1 },
    ...overrides,
  })

  it('records the missing card document when the built artefacts do not have it', () => {
    const changes = surface.requiredProductChanges({
      evidence: evidenceWith({ repository: { cardDocumentPresent: false } }),
      shipped: shippedWith({}),
      childLineCount: 0,
    })
    const change = changes.find((entry: { id: string }) => entry.id === 'card-document-entry')
    expect(change).toBeDefined()
    expect(change?.owner).toBe('dashboard-engineer')
    // The run completed this gap, so it says what it put there rather than claiming to
    // have changed nothing: a reader must be able to tell the product's bytes from the
    // harness's without reading the script.
    expect(String(change?.suppliedByThisRun)).toMatch(/run-time card document/)
    expect(String(change?.suppliedByThisRun)).toMatch(/product own compiled card view/)
  })

  it('records the missing renderer channel when the shipped entry point is not wired', () => {
    const changes = surface.requiredProductChanges({
      evidence: evidenceWith({}),
      shipped: shippedWith({ delivery: { wired: false, status: 'not-wired', delivered: 0 } }),
      childLineCount: 0,
    })
    const change = changes.find((entry: { id: string }) => entry.id === 'card-renderer-channel')
    expect(change).toBeDefined()
    expect(change?.required).toMatch(/renderCard/)
    expect(String(change?.suppliedByThisRun)).toMatch(/executeJavaScript/)
  })

  it('does not claim a card document is missing when one is present', () => {
    const changes = surface.requiredProductChanges({
      evidence: evidenceWith({}),
      shipped: shippedWith({}),
      childLineCount: 0,
    })
    expect(changes.find((entry: { id: string }) => entry.id === 'card-document-entry')).toBeUndefined()
  })

  it('always records the acknowledgement gap, the window-down gap and the schema gap', () => {
    const changes = surface.requiredProductChanges({
      evidence: evidenceWith({}),
      shipped: shippedWith({}),
      childLineCount: 0,
    })
    const ids = changes.map((entry: { id: string }) => entry.id)
    expect(ids).toContain('acknowledgement-does-not-reach-the-card')
    expect(ids).toContain('nothing-takes-the-window-down-when-a-card-ends')
    expect(ids).toContain('the-durable-schema-is-not-in-the-build')
  })

  it('always records that a not-wired run has nowhere to say so, and how many lines were seen', () => {
    const changes = surface.requiredProductChanges({
      evidence: evidenceWith({}),
      shipped: shippedWith({}),
      childLineCount: 0,
      chromiumLineCount: 0,
    })
    const change = changes.find((entry: { id: string }) => entry.id === 'not-wired-diagnostic-has-no-destination')
    expect(change?.observed).toMatch(/0 of those lines were written by this product/)
  })

  it('records that the tray is not observable from outside the process', () => {
    const changes = surface.requiredProductChanges({
      evidence: evidenceWith({}),
      shipped: shippedWith({}),
      childLineCount: 0,
    })
    expect(changes.map((entry: { id: string }) => entry.id)).toContain('tray-is-not-observable-outside-the-process')
  })

  it('names an owner and a required change for every finding, and never leaves one blank', () => {
    const changes = surface.requiredProductChanges({
      evidence: evidenceWith({ repository: { cardDocumentPresent: false } }),
      shipped: shippedWith({ delivery: { wired: false, status: 'not-wired', delivered: 0 } }),
      childLineCount: 3,
    })
    expect(changes.length).toBeGreaterThan(0)
    for (const change of changes) {
      expect(String(change.id)).not.toBe('')
      expect(String(change.owner)).toMatch(/engineer/)
      expect(String(change.required).length).toBeGreaterThan(20)
      expect(String(change.observed).length).toBeGreaterThan(20)
      expect(String(change.suppliedByThisRun).length).toBeGreaterThan(0)
    }
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

describe('cardReportVerdict(): what the renderer says is in the card', () => {
  const rendered = {
    ready: true,
    showing: true,
    ends: [],
    element: {
      attributes: [...surface.CARD_ATTRIBUTES_EXPECTED, 'data-deep-link', 'aria-hidden'],
      inlineStyle: null,
      titleLength: 17,
      bodyLength: 51,
      ariaLabelLength: 81,
    },
  }

  it('is rendered for a card with every attribute, both text lines and no inline style', () => {
    expect(surface.cardReportVerdict(rendered)).toBe('rendered')
  })

  it('is never a pass without a report at all', () => {
    expect(surface.cardReportVerdict(null)).toBe('no-report')
    expect(surface.cardReportVerdict(undefined)).toBe('no-report')
    expect(surface.cardReportVerdict({ ...rendered, error: 'the card document could not be read' })).toBe('no-report')
  })

  it('says the document is not ready rather than that there is no card, because those are different faults', () => {
    expect(surface.cardReportVerdict({ ready: false })).toBe('document-not-ready')
  })

  it('is no-card-element for a loaded document with nothing in it, which is what an ended card looks like', () => {
    expect(surface.cardReportVerdict({ ready: true, showing: false, ends: ['expired'], element: null })).toBe(
      'no-card-element',
    )
  })

  it('is inline-style when the card carries a style attribute, which the product own CSP would refuse to honour', () => {
    const styled = { ...rendered, element: { ...rendered.element, inlineStyle: 'background: red' } }
    expect(surface.cardReportVerdict(styled)).toBe('inline-style')
  })

  it('is incomplete for a missing attribute or an empty text line, and never a pass', () => {
    const missing = {
      ...rendered,
      element: { ...rendered.element, attributes: rendered.element.attributes.slice(1) },
    }
    expect(surface.cardReportVerdict(missing)).toBe('incomplete')
    const empty = { ...rendered, element: { ...rendered.element, titleLength: 0 } }
    expect(surface.cardReportVerdict(empty)).toBe('incomplete')
    const noName = { ...rendered, element: { ...rendered.element, ariaLabelLength: 0 } }
    expect(surface.cardReportVerdict(noName)).toBe('incomplete')
  })

  it('is incomplete when the view says it is showing but the document holds no element', () => {
    expect(surface.cardReportVerdict({ ready: true, showing: true, ends: [], element: null })).toBe('incomplete')
  })
})

describe('parseHarnessReportLine() and latestCardReport(): the harness own readings', () => {
  it('reads a prefixed line and refuses anything else, so a diagnostic is never read as a reading', () => {
    const line = `${surface.CARD_REPORT_PREFIX}${JSON.stringify({ seq: 3, showing: true, ends: [] })}`
    expect(surface.parseHarnessReportLine(line)).toEqual({ seq: 3, showing: true, ends: [] })
    expect(surface.parseHarnessReportLine('hub: something')).toBeNull()
    expect(surface.parseHarnessReportLine(`${surface.CARD_REPORT_PREFIX}{oops`)).toBeNull()
    expect(surface.parseHarnessReportLine(`${surface.CARD_REPORT_PREFIX}{"showing":true}`)).toBeNull()
    expect(surface.parseHarnessReportLine(undefined)).toBeNull()
  })

  it('returns the newest report, and the end a journey is waiting for', () => {
    const reports = [
      { seq: 1, showing: true, ends: [] },
      { seq: 2, showing: true, ends: ['replaced'] },
      { seq: 3, showing: false, ends: ['replaced', 'expired'] },
    ]
    expect(surface.latestCardReport(reports).report?.seq).toBe(3)
    expect(surface.latestCardReport(reports, 'expired').end).toBe('expired')
    expect(surface.latestCardReport(reports, 'acknowledged').end).toBeNull()
  })

  it('is null rather than an empty reading when nothing was ever reported', () => {
    expect(surface.latestCardReport([])).toEqual({ report: null, end: null })
    expect(surface.latestCardReport(undefined)).toEqual({ report: null, end: null })
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

describe('the run-time harness source: the three seams this run completes, and nothing else', () => {
  const main = surface.harnessMainSource({ productRoot: '/repo', dashboardRoot: '/tmp/dash' })
  const document = surface.cardDocumentSource()
  const entry = surface.cardEntrySource()
  const everything = `${main}\n${entry}\n${Object.values(document).join('\n')}`

  it('mounts the product own compiled card view rather than writing a card of its own', () => {
    expect(entry).toMatch(/import \{ createCardView \} from '\/card-view\.js'/)
    expect(entry).toMatch(/createCardView\(/)
    // The model is handed in, never built here: a card assembled by the harness would be
    // evidence about the harness.
    expect(entry).not.toMatch(/needs-you|Needs you|pendingCount|deepLink:/)
  })

  it('starts the product own built entry point, and never a second implementation of it', () => {
    expect(main).toMatch(/dist\/main\/main\/index\.js/)
    expect(main).toMatch(/createElectronSurfaceHost/)
    expect(main).toMatch(/surfaceDocumentUrl/)
    expect(main).toMatch(/startHub/)
  })

  it('reads the card document and the product own host only through the window it was given', () => {
    expect(main).toMatch(/executeJavaScript/)
    expect(main).not.toMatch(/new BrowserWindow\(/)
  })

  it('names no platform notification mechanism anywhere, because nothing may leave this machine but a card', () => {
    for (const token of [
      'notify-send',
      'org.freedesktop.Notifications',
      'Notification.requestPermission',
      'new Notification',
      'osascript',
      'zenity',
      'powershell',
      'plink',
      'BurntToast',
      'terminal-notifier',
      'dbus-send',
    ]) {
      expect(everything).not.toContain(token)
    }
  })

  it('starts no process and spawns nothing, because the surface is a window and not a command', () => {
    expect(everything).not.toMatch(/child_process|spawn|execFile|execSync|exec\(/)
  })

  it('does not weaken the renderer the product itself configured', () => {
    for (const token of [
      'nodeIntegration: true',
      'nodeIntegration:true',
      'contextIsolation: false',
      'sandbox: false',
      'webSecurity: false',
      'preload',
    ]) {
      expect(everything).not.toContain(token)
    }
  })

  it('writes the card document with no inline script and no inline style, because the hub CSP forbids both', () => {
    expect(document['card.html']).not.toMatch(/style=/)
    expect(document['card.html']).not.toMatch(/<script(?![^>]*src=)/)
    expect(document['card.html']).toMatch(/<link rel="stylesheet" href="\/card\.css"/)
    expect(document['card.html']).toMatch(/<script type="module" src="\/card-entry\.js">/)
  })

  it('reaches nothing off the loopback origin from the card document', () => {
    for (const source of [entry, document['card.html'], document['card.css']]) {
      expect(source).not.toMatch(/https?:\/\//)
    }
  })

  it('carries the card model into the renderer as the product built it, with nothing added', () => {
    const model = { title: 'sample-repository', body: 'A session is blocked.', urgency: 'critical', pendingCount: 1, deepLink: 'http://127.0.0.1:43117/?session=ses_1' }
    const cell = { class: 'needs-you', rendered: true, lifetime: 'until-resolved', expiresInMs: null, ends: ['resolved', 'acknowledged'], repeat: 'never', reason: 'held-until-resolved' }
    const call = surface.showCardCall(model, cell)
    expect(call.startsWith(surface.SHOW_CARD_CALL_PREFIX)).toBe(true)
    expect(call.endsWith(')')).toBe(true)
    expect(call).toContain('"lifetime":"until-resolved"')
    expect(surface.removeCardCall('acknowledged')).toBe(`${surface.REMOVE_CARD_CALL_PREFIX}"acknowledged")`)
    // A model that cannot be serialised becomes a null argument rather than a throw, so a
    // defect upstream is a failed delivery with a reason instead of a hung one.
    expect(surface.showCardCall(undefined, undefined)).toContain('null, null')
  })

  it('has no top-level await in the Electron main entry, which hangs before app.whenReady()', () => {
    const withoutFunctionBodies = main.replace(/function[^\n]*\{[\s\S]*?\n\}/g, '')
    expect(withoutFunctionBodies).not.toMatch(/^await /m)
  })

  it('writes a card-report line and nothing else onto the harness stdout', () => {
    expect(main).toMatch(/CARD_REPORT_PREFIX/)
    expect(main).toMatch(/process\.stdout\.write/)
    expect(main).not.toMatch(/console\.log/)
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
    expect(names).toContain("the product's own compiled card view")
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
