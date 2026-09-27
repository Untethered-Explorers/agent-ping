#!/usr/bin/env node
// Prove the notification card on the running system (NT-9: NT-FR-02, NT-FR-04,
// NT-FR-08, NT-FR-10, APX-CON-06, APX-CON-12, APX-FR-02, PRD 16 Open Questions 13 and 14).
//
//   node scripts/verify-notification-surface.mjs
//   node scripts/verify-notification-surface.mjs --out docs/reviews/notification-surface-evidence.json
//
// THE CLAIM, IN THREE SENTENCES, BEFORE ANY CODE
//
//   positive   A real needs-you event, driven over the real loopback socket into the
//              real built hub running as a real Electron main process on a real
//              display, puts a real window on that display holding real painted content
//              positioned inside the display's work area; the card is still there after
//              a wait; acknowledging the item takes it off the screen and lowers the
//              badge's own number. A real finished event's card leaves the screen on its
//              own fixed interval with nothing dismissing it.
//   negative   A session that opens, greets and closes produces no event, no window and
//              no card, at any point in the run. This is the anti-noise proof and it is
//              the one that matters most, because a card on a developer's screen for a
//              turn that did nothing is the defect this whole feature exists to avoid
//              (ADR-004, NT-FR-02).
//   failure    A missing display, a missing Electron binary, a missing X tool or a
//              missing control window is a non-zero exit naming what was absent and how
//              to obtain it. It is never a skip.
//
// WHY THE OBSERVER IS THE X SERVER AND NOT THE PRODUCT
// The product's own `host.show()` resolving successfully is a claim the product makes
// about itself. What has to be established is that something is on a screen. So the
// window is enumerated from the X server, its rectangle is read from the X server, its
// map state is read from the X server, and its painted pixels are read out of its own
// drawable with `xwd`. The only thing taken from the product is a process id, and that
// from the runtime file the hub itself published. A check the product grades itself is a
// check that passes when the product is broken. The one exception is marked as such
// everywhere it appears: the *contents* of the card document are read from the renderer
// and recorded as corroboration, never as the basis of a visibility claim.
//
// WHAT IS THE PRODUCT'S AND WHAT IS THIS SCRIPT'S - READ THIS BEFORE THE EVIDENCE FILE
// The product as shipped cannot draw a card, and NT-9 was told to record that rather
// than change product code. Three seams are open, each one the product's own documented
// injection point, and this script supplies all three so that the card machinery can be
// observed on a real desktop:
//
//   1. THE CARD DOCUMENT. `src/dashboard/card.html` does not exist and the dashboard's
//      Vite build has one entry, so `GET /card.html` is a 404 on the shipped build.
//      This script writes a run-time document into a prepared dashboard root, and the
//      document mounts the PRODUCT'S OWN compiled card view - `card-view.js`, `card.js`
//      and `lifetime.js` copied byte for byte out of `dist/main/notify/surface/` - so
//      the element tree, the attributes, the accessible name, the live-region role, the
//      expiry timer and the removal are all the product's code running in a real
//      renderer. Only the page and its stylesheet are this script's.
//   2. THE MAIN-TO-RENDERER CHANNEL. The renderer runs with `contextIsolation: true`,
//      `nodeIntegration: false` and `sandbox: true` and there is no preload, so nothing
//      can hand a card model to the document. The product's own `BrowserWindow` is
//      wrapped so the harness can hold the instance, and the model is carried by
//      `webContents.executeJavaScript` - a real call into a real renderer, chosen here
//      only because a verification run cannot choose it for the product. It is recorded
//      as a required product change with an owner, not adopted as the answer.
//   3. THE ACKNOWLEDGEMENT SIGNAL. The ack route has no notifier hook, so nothing tells
//      the card that its block was acknowledged. The harness watches the hub's own
//      pending set and calls the card view's own `remove('acknowledged')` - a product
//      method on a product object - and then the product's own host `hide()`.
//
// Everything else is the product's, unmodified and unstubbed: the real built
// `startHub`, the real loopback server and every real route, the real ingest
// classifier, the real class policy, the real card model, the real surface host with the
// real `SURFACE_WINDOW_OPTIONS`, the real placement arithmetic, the real lifetime table,
// the real card view and the real delivery policy and its ledger. The evidence file
// names every one of those files, and its `harness` section names every one of the three
// seams above. A green run here is evidence about the card machinery, and the run also
// records, in `shippedPosture`, that the product as shipped still reports `not-wired` and
// still serves no card document.
//
// FIVE PROPERTIES THIS SCRIPT MUST NEVER LOSE
//
//   1. Absence of a dependency is never a skip. A missing binary, a missing display, a
//      missing X tool, a missing built product module and a missing control window each
//      exit non-zero with a remedy, and none of them writes the evidence file - a report
//      that says "nothing was there" is indistinguishable from a report that says
//      "nothing was looked for".
//   2. The observer proves itself before it is trusted. A `xmessage` control window is
//      opened, found by the same enumeration the journeys use, and read by the same
//      capture. If the control cannot be found, "no card appeared" is not a finding; it
//      is a broken instrument, and it is a failure.
//   3. An assertion whose precondition never held is a failure, not a pass. A card that
//      was never seen cannot be reported as "gone after the acknowledgement"; it is
//      reported as not-observed, which does not match the expected value and fails.
//   4. No telemetry leaves the machine. Every socket this script opens is 127.0.0.1, and
//      the only other processes it runs are X utilities, the pinned Electron binary, and
//      `notify-send` once, as a *positive control* for the notification-centre
//      instrument. Nothing is uploaded; the evidence file is the artefact (APX-CON-12).
//   5. No conversation content. The evidence file records event ids the log itself
//      generates, class names, counts, rectangles, timings, versions, attribute names and
//      closed reason tokens. Card *lengths* are recorded and card *words* are not, and it
//      records no prompt, no tool name, no diff, no D-Bus payload, and no absolute path
//      from the developer's machine (APX-FR-01).
//
// SHAPE, PER THE LIVE-VERIFICATION DISCIPLINE
//
//   scripts/verify-notification-surface.mjs              pure parsing and judgement,
//                                                         exported, plus the run-time
//                                                         harness source, plus a thin
//                                                         shell that owns every side
//                                                         effect
//   tests/scripts/verify-notification-surface.test.ts    drives `decide`, every parser
//                                                         and every harness source with
//                                                         injected values, so the
//                                                         judgement and every parse are
//                                                         verified with no display and
//                                                         no Electron
//
// WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
// It does not touch a file under src/. It does not re-arm a card, acknowledge anything
// it was not asked to, or fall back to dismissing a card that failed to expire. It does
// not call a platform notification tool, and the one `notify-send` it ever runs is the
// positive control for the notification-centre instrument, after the journeys. It does
// not claim the card is legible: the pixel capture counts painted values and reads no
// word. And it does not report a card it never saw as gone.
import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT_PATH = 'scripts/verify-notification-surface.mjs'

export const SCRIPT_NAME = 'verify-notification-surface'
/** Bumped when the evidence schema changes, so a later reader can tell the two apart. */
export const EVIDENCE_VERSION = 2
export const DEFAULT_EVIDENCE_PATH = 'docs/reviews/notification-surface-evidence.json'

// ─────────────────────────────────────────────────────────────────────────────
// The numbers this run asserts against, and where each one comes from
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The card's own size, as the product declares it.
 *
 * `CARD_SIZE` in src/notify/surface/position.ts, which is the rectangle
 * docs/research/electron-surface-preflight.json measured on this machine
 * ({"x":1584,"y":48,"width":320,"height":96} inside a 1920x1048 work area at a 32px top
 * inset). It is repeated here so the *observer* can tell a card window from any other
 * window the Electron process might own: the assertion is about the product's documented
 * geometry, not about a window of any size that happened to appear.
 */
export const CARD_WINDOW_SIZE = Object.freeze({ width: 320, height: 96 })
export const CARD_WINDOW_SIZE_SOURCE =
  'src/notify/surface/position.ts CARD_SIZE, the rectangle docs/research/electron-surface-preflight.json measured'

/** The one interval the product's lifetime table names, in milliseconds. */
export const FINISHED_CARD_EXPIRES_IN_MS = 5_000
export const FINISHED_CARD_EXPIRY_SOURCE =
  'src/notify/surface/lifetime.ts FINISHED_CARD_EXPIRES_IN_MS, the only cell in the table that expires'

/** How long a needs-you card is given to still be there before it is called gone. */
export const NEEDS_YOU_SETTLE_MS = 4_000

/**
 * How long a finished card is waited out: the product's interval plus a margin.
 *
 * Nothing is acknowledged and nothing is dismissed during the wait, and this script has
 * no fallback dismissal, because a fallback would make an unimplemented expiry look like
 * a working one.
 */
export const FINISHED_EXPIRY_WAIT_MS = FINISHED_CARD_EXPIRES_IN_MS + 3_000

/** How long the observer waits for a card to reach the screen after its event. */
export const CARD_APPEAR_TIMEOUT_MS = 8_000
/** How long the observer waits for a card to reach the screen after it is dismissed. */
export const CARD_END_TIMEOUT_MS = 8_000
/** How long the harness waits for a card document to run its own entry point. */
export const CARD_DOCUMENT_READY_TIMEOUT_MS = 5_000

/** The D-Bus match rule for the notification interface. Read once, so a typo is one diff. */
export const NOTIFICATION_MATCH_RULE = 'type=method_call,interface=org.freedesktop.Notifications'

/** How long a single X query may take before it is called unavailable. */
export const OBSERVER_COMMAND_TIMEOUT_MS = 10_000
/** How long the hub may take to publish a runtime file with a port in it. */
export const HUB_READY_TIMEOUT_MS = 45_000
/** How long the child may take to stop after SIGTERM before it is killed. */
export const HUB_STOP_TIMEOUT_MS = 8_000
/** How long a loopback request may take. */
export const REQUEST_TIMEOUT_MS = 10_000
/** Lines of child stdout/stderr kept. Bounded: this process is not a log sink. */
export const MAX_CHILD_OUTPUT_LINES = 200

/**
 * The prefix on a card-report line the harness writes to its own stdout.
 *
 * The harness and the observer are two processes, so the harness's readings of the
 * renderer travel as lines rather than as a route: the card document must not have to
 * report anything, and the product's HTTP surface must stay exactly the surface the
 * product defines. `parseHarnessReportLine` is the only reader and it is pure.
 */
export const CARD_REPORT_PREFIX = '##CARD## '

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the judgement. No process, no clock, no filesystem, no network, no display.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many assertions a complete run executes.
 *
 * A fixed number, and a shortfall is a failure, because the alternative is a green run
 * in which an exception in the collection phase swallowed the body and the exit code was
 * the only thing anybody read. The journeys below emit exactly this many rows: a journey
 * that cannot produce one of them produces a *failed* row with the reason attached,
 * never a missing one, so the count cannot drift with the product's behaviour.
 */
export const ASSERTIONS_EXPECTED = 19

/**
 * The three rows the observer and the hub contribute, named so the total above cannot
 * drift from the rows the journeys actually emit.
 */
export const OPENING_ASSERTIONS = Object.freeze([
  'the desktop observer found and read a control window it did not create',
  'a built Electron main process started the real hub serving on loopback',
  'the hub published its own runtime file rather than being reached on an assumed port',
])
/** The nine rows journey 1 owes, whatever it managed to observe. */
export const NEEDS_YOU_ASSERTIONS = Object.freeze([
  'a real needs-you event created exactly one pending item',
  'a card window appeared inside the display work area',
  'the card window held painted content',
  'the product own card view rendered a card into the document that window loaded',
  'the card was still on screen after a wait',
  'the delivery outcome for the block was recorded as delivered',
  'the hub served the card document the window loads',
  'the badge number fell when the item was acknowledged',
  'the card was gone after the acknowledgement',
])
/** The three rows journey 2 owes. */
export const FINISHED_ASSERTIONS = Object.freeze([
  'a worked idle transition created exactly one finished event',
  'a card window appeared for the finished event',
  'the finished card expired with nothing dismissing it',
])
/** The four rows journey 3 owes, and the four that matter most: the anti-noise proof. */
export const GREETING_ASSERTIONS = Object.freeze([
  'a greeting-and-close session created no event',
  'a greeting-and-close session left the pending set unchanged',
  'a greeting-and-close session created no window',
  'no card window was viewable while nothing was pending',
])

/** One dependency the run needs, and what to do about it when it is absent. */
export const DependencyStatus = Object.freeze({
  ELECTRON: 'the electron binary',
  DISPLAY: 'a display',
  XWININFO: 'the xwininfo X tool',
  XPROP: 'the xprop X tool',
  XWD: 'the xwd X tool',
  XMESSAGE: 'the xmessage X tool',
  DBUS_MONITOR: 'the dbus-monitor tool',
  BUILT_ENTRY: 'the built Electron main entry point',
  BUILT_SCHEMA: 'the built durable schema',
  BUILT_DASHBOARD: 'the built dashboard',
  BUILT_CARD_VIEW: "the product's own compiled card view",
  WORK_AREA: 'an advertised display work area',
})

/** One thing this run checked. `expected` and `actual` are compared as strings. */
export const ObservationShape = Object.freeze({
  journey: 'string',
  name: 'string',
  expected: 'string',
  actual: 'string',
  measured: 'object',
})

/**
 * The verdict, as a pure function of what was observed and what was available.
 *
 * Three ways this can fail, and all three are failures rather than qualifications:
 *
 *   - a dependency was absent. There is no third option: a green result that exercised
 *     nothing is worse than a red one, because it is indistinguishable from a pass
 *     (property 1). Every absent dependency contributes a line that names it and carries
 *     its remedy, because a non-zero exit with no next action trains people to ignore
 *     the exit code.
 *   - fewer assertions ran than the inventory expects. This is the no-zero-work guard, and
 *     it is checked before the per-observation comparison so a short run says what it did
 *     not do rather than only what it got wrong.
 *   - an observation's `actual` did not equal its `expected`. A *not-observed* reading is
 *     a mismatch like any other, which is what keeps "the card was never seen" from being
 *     reported as "the card was gone" (property 3).
 *
 * No threshold, no scoring and no partial credit: a card either was on a real display
 * inside the work area or it was not.
 */
export function decide(observations, ctx) {
  const expected = ctx?.assertionsExpected ?? ASSERTIONS_EXPECTED
  const dependencies = ctx?.dependencies ?? []
  const rows = Array.isArray(observations) ? observations : []
  const missing = dependencies.filter((dependency) => dependency.present !== true)
  const failures = []

  for (const dependency of missing) {
    failures.push(
      `required dependency unavailable: ${dependency.name}. ${
        dependency.remedy ?? 'no remedy is recorded for this dependency, which is itself a defect in this script'
      }`,
    )
  }
  if (rows.length < expected) {
    failures.push(
      `executed ${rows.length} of ${expected} assertions; a green result that exercised nothing is not a pass`,
    )
  }
  for (const row of rows) {
    if (row.actual !== row.expected) {
      failures.push(`${row.name}: expected ${row.expected}, observed ${row.actual}`)
    }
  }

  return {
    verdict: failures.length === 0 ? 'pass' : 'fail',
    exitCode: failures.length === 0 ? 0 : 1,
    assertionsExpected: expected,
    assertionsRun: rows.length,
    assertions: rows,
    failures,
    missingDependencies: missing.map(
      (dependency) => `${dependency.name}: ${dependency.remedy ?? 'remedy not recorded'}`,
    ),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the parsers. Each one turns a tool's text into a value, and each is tested
// against a captured sample, because a parse that quietly returns nothing turns "no card
// appeared" into "the observer is broken" without ever saying so.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One window line, from `xwininfo -root -tree` or `-root -children`.
 *
 * The shape, as the tool actually prints it on this desktop:
 *
 *      0x4400004 "agent-ping": ("agent-ping" "agent-ping")  320x96+1584+48  +1584+48
 *      0x440002b (has no name): ()  360x160+0+0  +120+157
 *
 * The geometry appears twice - relative to the parent, and absolute - and only the
 * second pair is wanted, because a card's position has to be checked against the display's
 * work area and not against whatever window happens to parent it. The name is optional
 * (many windows have none), the class list is optional, and both are followed by a colon
 * that a stricter reading forgets - which is the whole reason this parser is written
 * around the geometry it needs and reads the name out of the leftover text afterwards.
 * Everything before the geometry is treated as untrusted: a name that happened to contain
 * `4x5+1+2` cannot become this parser's idea of the geometry.
 */
const WINDOW_LINE = /^\s*(0x[0-9a-fA-F]+)\b(.*?)(\d+)x(\d+)\+(-?\d+)\+(-?\d+)\s+\+(-?\d+)\+(-?\d+)\s*$/
/** The first double-quoted run in a window line's head, which is the window's name. */
const WINDOW_NAME = /"((?:[^"\\]|\\.)*)"/

export function parseWindowList(text) {
  const windows = []
  if (typeof text !== 'string') return windows
  for (const line of text.split('\n')) {
    const match = WINDOW_LINE.exec(line)
    if (match === null) continue
    const named = WINDOW_NAME.exec(match[2])
    const width = Number(match[3])
    const height = Number(match[4])
    windows.push({
      id: match[1].toLowerCase(),
      name: named === null ? null : named[1],
      relative: { width, height, x: Number(match[5]), y: Number(match[6]) },
      absolute: { width, height, x: Number(match[7]), y: Number(match[8]) },
    })
  }
  return windows
}

/**
 * One window's own record, as `xwininfo -id` prints it.
 *
 * `Map State` is the field that matters: a window that exists but is not viewable
 * occupies nothing on the screen, and this product's whole quiet-by-default promise is
 * the difference between those two things (NT-FR-10). A window whose detail cannot be
 * read reports `unknown` rather than being treated as absent, because a window this
 * script cannot interrogate is not the same as a window that is not there.
 */
export function parseWindowDetail(text) {
  const detail = { mapState: 'unknown', width: null, height: null, x: null, y: null, depth: null }
  if (typeof text !== 'string') return detail
  const map = /Map State:\s*(\S+)/.exec(text)
  if (map !== null) detail.mapState = map[1]
  const width = /^\s*Width:\s*(\d+)\s*$/m.exec(text)
  if (width !== null) detail.width = Number(width[1])
  const height = /^\s*Height:\s*(\d+)\s*$/m.exec(text)
  if (height !== null) detail.height = Number(height[1])
  const x = /Absolute upper-left X:\s*(-?\d+)/.exec(text)
  if (x !== null) detail.x = Number(x[1])
  const y = /Absolute upper-left Y:\s*(-?\d+)/.exec(text)
  if (y !== null) detail.y = Number(y[1])
  const depth = /^\s*Depth:\s*(\d+)\s*$/m.exec(text)
  if (depth !== null) detail.depth = Number(depth[1])
  return detail
}

/**
 * `_NET_WM_PID`, the window's owning client process, as `xprop` prints it.
 *
 * Ownership is what separates the hub's card window from the eighty other windows on a
 * developer's desktop. `null` is a real answer - some windows have no pid - and it is not
 * read as "belongs to the hub".
 */
export function parseNetWmPid(text) {
  if (typeof text !== 'string') return null
  const match = /_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)/.exec(text)
  return match === null ? null : Number(match[1])
}

/**
 * The desktop's own work area, as `_NET_WORKAREA` advertises it.
 *
 * The EWMH property, which is the answer a window manager gives to "where may a window be
 * placed", and therefore the right external answer to the question NT-FR-04 asks. The
 * property carries one rectangle per monitor, so all of them are kept in the evidence file
 * rather than reduced to one number: a card has to be inside a *usable* area, and a card
 * over the 32-pixel top panel this machine reports would be visible to the person it
 * interrupted.
 */
export function parseWorkArea(text) {
  if (typeof text !== 'string') return { workArea: null, rectangles: [] }
  const match = /_NET_WORKAREA(?:\(CARDINAL\))?\s*=\s*(.+)$/m.exec(text)
  if (match === null) return { workArea: null, rectangles: [] }
  const numbers = match[1]
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value))
  const rectangles = []
  for (let index = 0; index + 3 < numbers.length; index += 4) {
    rectangles.push({
      x: numbers[index],
      y: numbers[index + 1],
      width: numbers[index + 2],
      height: numbers[index + 3],
    })
  }
  return { workArea: rectangles[0] ?? null, rectangles }
}

/**
 * Whether `inner` lies entirely inside `outer`, edges included.
 *
 * The same shape as `isInsideWorkArea` in src/notify/surface/position.ts, written
 * independently here on purpose: the point of this script is to check the product's
 * arithmetic against the desktop's own answer, and importing the product's own function
 * to do it would make the check a tautology.
 */
export function rectContains(outer, inner) {
  if (outer === null || outer === undefined || inner === null || inner === undefined) return false
  const numbers = [outer.x, outer.y, outer.width, outer.height, inner.x, inner.y, inner.width, inner.height]
  if (!numbers.every((value) => Number.isFinite(value))) return false
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

/**
 * The window ids in `after` that are not in `before`, in `after`'s order.
 *
 * The journeys diff against a snapshot rather than searching the whole desktop for
 * something card-shaped, because a card-shaped window that was already on the screen
 * before the run started is not evidence that this product put it there. X window ids are
 * not reused while a window lives, so a set difference is a sound "appeared between these
 * two moments".
 */
export function appearedWindowIds(before, after) {
  const seen = new Set((before ?? []).map((window) => window.id))
  return (after ?? []).filter((window) => !seen.has(window.id)).map((window) => window.id)
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the pixel capture
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A window's own pixels, out of the `xwd` dump of its drawable.
 *
 * What is measured is deliberately modest and stated exactly: how many distinct 32-bit
 * pixel values the window's own buffer holds, and how many of its pixels are non-zero.
 * That is a real reading of what the compositor was handed, and it separates a window
 * with painted content from a blank one - the difference between "a card was on screen"
 * and "a transparent rectangle was on screen", which is the distinction NT-FR-10 turns on
 * and the one APX-FR-02 forbids collapsing.
 *
 * What it does *not* do is read the text. Nothing here recognises a glyph or a word, so
 * no observation in this script claims that a particular sentence was legible. Legibility
 * is a manual, per-platform step and docs/runbooks/notification-surface.md says so.
 *
 * The XWD header is 25 big-endian CARD32s (100 bytes) followed by the window name and
 * then `ncolors` 12-byte colormap entries, so the pixel data starts at
 * `header_size + ncolors * 12`. Channel order is read as the dump states it and reduced
 * to a number either way, because the question is "how many distinct colours are in here"
 * and not "which channel is red".
 */
export function parseXwdPixels(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) {
    return { ok: false, reason: 'the capture is too short to carry an XWD header' }
  }
  const read = (offset) => buffer.readUInt32BE(offset)
  const headerSize = read(0)
  const fileVersion = read(4)
  if (fileVersion !== 7) return { ok: false, reason: `unexpected XWD file version ${fileVersion}` }
  const width = read(16)
  const height = read(20)
  const bitsPerPixel = read(44)
  const bytesPerLine = read(48)
  const ncolors = read(76)
  const dataOffset = headerSize + ncolors * 12
  if (bitsPerPixel === 0 || bitsPerPixel % 8 !== 0) {
    return { ok: false, reason: `unsupported bits per pixel: ${bitsPerPixel}` }
  }
  const expected = dataOffset + height * bytesPerLine
  if (buffer.length < expected) {
    return {
      ok: false,
      reason: `the capture is short: ${buffer.length} bytes for a ${width}x${height} dump needing ${expected}`,
    }
  }
  const step = bitsPerPixel / 8
  const distinct = new Set()
  let nonZero = 0
  for (let y = 0; y < height; y += 1) {
    const row = dataOffset + y * bytesPerLine
    for (let x = 0; x < width; x += 1) {
      const at = row + x * step
      let value = 0
      for (let index = step - 1; index >= 0; index -= 1) value = value * 256 + buffer[at + index]
      distinct.add(value)
      if (value !== 0) nonZero += 1
    }
  }
  return {
    ok: true,
    width,
    height,
    bitsPerPixel,
    bytesPerLine,
    pixels: width * height,
    distinctValues: distinct.size,
    nonZeroPixels: nonZero,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the notification-centre reading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many notification calls a captured `dbus-monitor` stream contains.
 *
 * `member=Notify`, and not every mention of the interface: a client that merely asks the
 * service `GetServerInformation` has not notified anybody, and counting those would let a
 * run report a notification that never happened. The stream itself is never stored - it
 * carries the notification's own summary and body text, which is exactly the kind of
 * content that has no business in an evidence file - so a count is the whole reading
 * (APX-FR-01).
 */
export function countNotifications(text) {
  if (typeof text !== 'string') return 0
  const matches = text.match(/member=Notify\b/g)
  return matches === null ? 0 : matches.length
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: whose line is it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A line Chromium's own logging wrote, rather than the product.
 *
 * The shape is the one Chromium prints on every platform's stderr:
 *
 *     [2753645:0927/125950.763423:ERROR:content/browser/gpu/gpu_process_host.cc:1029] GPU process launch failed
 *     [2753645:0927/125950.776233:FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:417] GPU process isn't usable.
 *
 * `pid:MMDD/HHMMSS.mmm:SEVERITY:file:line] message`. The timestamp is what makes it
 * unambiguous rather than a guess: this product writes no bracketed timestamped prefix
 * anywhere, so a line that starts this way is the runtime's and no reading of this
 * product's own behaviour can be taken from it.
 */
const CHROMIUM_LOG_LINE = /^\[\d+:\d{4}\/\d{6}\.\d+:[A-Z]+:[^\]]*\]/

/**
 * Split a child's captured lines into the runtime's and the product's.
 *
 * This exists because one finding in this script is about whether the product's own
 * diagnostic reaches an operator, and a count that included Chromium's teardown noise
 * would answer the wrong question twice over: "found 10 diagnostic lines" beside "the
 * reason is never reported anywhere" is a contradiction a reader has to resolve, and the
 * resolution would be to distrust the file. So the two populations are separated here, both
 * are reported, and the finding is worded from the product's own count (APX-FR-02).
 *
 * Chromium writes its GPU and zygote lines while a process is being torn down on this
 * desktop, so a nonzero `chromium` count with a zero `product` count is the expected
 * reading for a healthy hub and is not a fault in the product or in this script.
 */
export function splitChildDiagnostics(lines) {
  const rows = Array.isArray(lines) ? lines : []
  const chromium = []
  const product = []
  for (const line of rows) {
    if (typeof line === 'string' && CHROMIUM_LOG_LINE.test(line)) chromium.push(line)
    else product.push(typeof line === 'string' ? line : String(line))
  }
  return { product, chromium, productCount: product.length, chromiumCount: chromium.length }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the verdicts the journeys compare against
// ─────────────────────────────────────────────────────────────────────────────

/** Turn a window reading into the one word the assertions compare against. */
export function cardWindowVerdict(cardWindows, workArea) {
  if (cardWindows.length === 0) return 'no-card-window'
  const outside = cardWindows.filter(
    (window) => !rectContains(workArea, { x: window.x, y: window.y, width: window.width, height: window.height }),
  )
  return outside.length > 0 ? 'outside-the-work-area' : 'inside-the-work-area'
}

/**
 * Whether a card window's own pixels hold painted content.
 *
 * "blank" means fewer than two distinct 32-bit values, which is what a window that drew
 * nothing at all produces. It is deliberately not a threshold on colour: the question is
 * whether anything was drawn into the surface, not whether the drawing was pretty.
 */
export function cardPixelsVerdict(cardWindows) {
  if (cardWindows.length === 0) return 'no-card-window'
  const blank = cardWindows.filter(
    (window) => window.pixels?.ok !== true || (window.pixels.distinctValues ?? 0) < 2,
  )
  return blank.length > 0 ? 'blank' : 'painted'
}

/**
 * Which of a set of freshly-appeared windows are this product's card.
 *
 * Four conditions, and all four are needed before a window is called a card: it appeared
 * during the journey, it is viewable now (a window that exists but is not on the screen
 * occupies nothing, which is the distinction NT-FR-10 turns on), it belongs to the hub's
 * own process, and it is the product's documented size. A window that fails any one of
 * them is returned in `rejected` with the reason, so a reader of the evidence file can
 * see what was turned down rather than only what survived - which matters on a desktop
 * with eighty windows on it, where a decoration frame around somebody else's window is
 * otherwise indistinguishable from a finding.
 *
 * Pure, and the only judgement the observer makes. The pixel capture is deliberately not
 * here: it needs the display, and the question "was anything drawn into the surface" is
 * asked separately by `cardPixelsVerdict` so that a window this script could not read can
 * be reported as unreadable rather than as blank.
 */
export function screenWindowFacts(facts, hubPid) {
  const candidates = []
  const rejected = []
  for (const fact of facts ?? []) {
    const record = {
      id: fact.id,
      ownerPid: fact.pid ?? null,
      mapState: fact.detail?.mapState ?? 'unknown',
      width: fact.detail?.width ?? null,
      height: fact.detail?.height ?? null,
      x: fact.detail?.x ?? null,
      y: fact.detail?.y ?? null,
      depth: fact.detail?.depth ?? null,
      // Carried through when the caller captured it, so one fact can answer both "is
      // there a card window" and "did it paint" without being read from the display twice.
      ...(fact.pixels === undefined ? {} : { pixels: fact.pixels }),
    }
    if (record.ownerPid !== hubPid) {
      rejected.push({ ...record, why: 'not owned by the hub process' })
      continue
    }
    if (record.mapState !== 'IsViewable') {
      rejected.push({ ...record, why: `map state is ${record.mapState}` })
      continue
    }
    if (record.width !== CARD_WINDOW_SIZE.width || record.height !== CARD_WINDOW_SIZE.height) {
      rejected.push({
        ...record,
        why: `size is ${String(record.width)}x${String(record.height)}, not the product's ${CARD_WINDOW_SIZE.width}x${CARD_WINDOW_SIZE.height}`,
      })
      continue
    }
    candidates.push(record)
  }
  return { candidates, rejected }
}

/**
 * The card windows that came *into being* between two moments.
 *
 * `appearedWindowIds` alone is not enough once there is more than one journey, because
 * the product keeps ONE window for the life of the hub and shows it, hides it and shows
 * it again: a finished card that replaces a needs-you card does not create a second X
 * window, it puts the first one back on the screen. Diffing on window ids alone would
 * therefore report "no card appeared" for the second card of the run, which is the
 * opposite of what happened.
 *
 * So emergence is two conditions, either of which is enough: the window is new, or the
 * window was there and is not viewable now and was not viewable before. Both need the
 * four `screenWindowFacts` conditions first - owned by the hub's process, viewable now,
 * and the product's documented size - so "emerged" always means the same four things plus
 * one. A window that was already viewable before this journey is returned in `rejected`
 * with that as its reason, so a card left over from an earlier journey is visible in the
 * evidence rather than silently counted.
 *
 * Pure: `before` and `after` are the fact arrays `DesktopObserver.cardWindowFacts`
 * gathers, and nothing here touches a display.
 */
export function emergingCardWindows(before, after, hubPid) {
  const beforeById = new Map((before ?? []).map((fact) => [fact.id, fact]))
  const { candidates, rejected } = screenWindowFacts(after ?? [], hubPid)
  const emerging = []
  for (const candidate of candidates) {
    const previous = beforeById.get(candidate.id)
    if (previous === undefined) {
      emerging.push({ ...candidate, emergedBecause: 'new-window' })
      continue
    }
    const wasViewable = previous.detail?.mapState === 'IsViewable'
    if (wasViewable) {
      rejected.push({ ...candidate, why: 'already viewable before this journey, so it is not evidence for it' })
      continue
    }
    emerging.push({ ...candidate, emergedBecause: `shown-again (map state was ${String(previous.detail?.mapState ?? 'unknown')})` })
  }
  return { emerging, rejected }
}

/**
 * What is on the screen in the hub's card window right now.
 *
 * Three answers, and the third is the one this run depends on most:
 *
 *   'painted'          a card-shaped window the hub owns is viewable and its own drawable
 *                      holds drawn content. This is the only answer that counts as a card
 *                      being on a developer's screen.
 *   'blank'            the window is there and viewable and its drawable is empty. A card
 *                      whose element has been removed leaves exactly this, and it is the
 *                      difference between "the card expired" and "the window is still
 *                      mapped": a mapped, transparent, unpainted rectangle is not a card
 *                      (NT-FR-10), and a card that drew nothing is not a delivery
 *                      (APX-FR-02).
 *   'no-card-window'   the hub owns no viewable card-shaped window. Either the window
 *                      never appeared, or it was taken down, and the two are told apart by
 *                      the journey rather than by this function.
 *   'unreadable'       a card-shaped window the hub owns is viewable and its pixels could
 *                      not be captured. Reported rather than read as blank, because a
 *                      broken `xwd` must never become evidence that a card was absent.
 */
export function cardOnScreenVerdict(after, hubPid) {
  const { candidates } = screenWindowFacts(after ?? [], hubPid)
  if (candidates.length === 0) return 'no-card-window'
  if (candidates.some((candidate) => candidate.pixels?.ok !== true)) return 'unreadable'
  return candidates.every((candidate) => (candidate.pixels?.distinctValues ?? 0) < 2) ? 'blank' : 'painted'
}

/**
 * The attributes a rendered card must carry, as a closed list.
 *
 * Every entry is one the product's own view writes (src/notify/surface/card-view.ts):
 * the root marker a stylesheet hangs on, the urgency and lifetime tokens, the two
 * non-colour urgency channels, the two lines of text, the live-region role, the
 * politeness, the accessible name, the tab stop and the motion mode. The list is compared
 * against the attribute names the renderer reports, so "the card is a real element tree
 * with real semantics" is a reading rather than a claim.
 */
export const CARD_ATTRIBUTES_EXPECTED = Object.freeze([
  'data-card',
  'data-urgency',
  'data-lifetime',
  'data-card-urgency-icon',
  'data-card-urgency-word',
  'data-card-title',
  'data-card-body',
  'data-motion-state-arrival',
  'role',
  'aria-live',
  'aria-label',
  'tabindex',
])

/**
 * What the renderer's own report says about the card in it.
 *
 * Six answers, and each one names something that could be wrong:
 *
 *   'rendered'            the element is in the document, every expected attribute is on
 *                         it, both text lines are non-empty, and it carries no inline
 *                         style - which is what `style-src 'self'` with no
 *                         `unsafe-inline` requires (src/hub/security.ts).
 *   'incomplete'          the element is there and something is missing: an attribute, a
 *                         text line, or a reason a reader can look up.
 *   'inline-style'        the element carries a `style` attribute. Under the product's own
 *                         content-security policy the card would be drawn wrongly, and a
 *                         card that cannot be drawn is not a card.
 *   'no-card-element'     the document is loaded and running and there is no card in it.
 *                         That is the honest reading after a card ends.
 *   'document-not-ready'  the harness read the document before its entry point ran.
 *   'no-report'           nothing has been read at all, which is never a pass.
 *
 * The card's own words are deliberately not read: the report carries the *lengths* of the
 * two text lines and the length of the accessible name, so "the card said something" is a
 * fact and no content reaches the evidence file (APX-FR-01).
 */
export function cardReportVerdict(report) {
  if (report === null || report === undefined) return 'no-report'
  if (report.error !== undefined && report.error !== null && report.error !== '') return 'no-report'
  if (report.ready !== true) return 'document-not-ready'
  const element = report.element ?? null
  if (element === null || element === undefined) {
    return report.showing === true ? 'incomplete' : 'no-card-element'
  }
  if (typeof element.inlineStyle === 'string' && element.inlineStyle !== '') return 'inline-style'
  const attributes = Array.isArray(element.attributes) ? element.attributes : []
  const missing = CARD_ATTRIBUTES_EXPECTED.filter((name) => !attributes.includes(name))
  if (missing.length > 0) return 'incomplete'
  if (!(Number(element.titleLength) > 0) || !(Number(element.bodyLength) > 0)) return 'incomplete'
  if (!(Number(element.ariaLabelLength) > 0)) return 'incomplete'
  return 'rendered'
}

/**
 * What the hub's own health payload says about the delivery that was attempted.
 *
 * The payload's own `status` is not the claim, because a hub with a wired policy and a
 * failed card also answers `ok`: the claim is that at least one card went out through the
 * product's own notifier and that nothing failed. Every answer other than `delivered`
 * therefore carries the numbers that made it wrong, so a failure is legible rather than
 * merely red (APX-FR-02).
 */
export function deliveryVerdict(delivery) {
  if (delivery === null || delivery === undefined) return 'no-delivery-section'
  if (delivery.wired !== true) return `not-wired: ${String(delivery.status)}`
  if (!Number.isInteger(delivery.delivered) || delivery.delivered < 1) {
    return `nothing-delivered: ${String(delivery.delivered)} of ${String(delivery.attempted)} attempted`
  }
  if (Number(delivery.failed) > 0 || Number(delivery.timedOut) > 0) {
    return `some-failed: ${String(delivery.failed)} failed, ${String(delivery.timedOut)} timed out`
  }
  return 'delivered'
}

/**
 * One card-report line, or null.
 *
 * The harness writes one line per change to what its renderer holds, prefixed so it can
 * never be confused with a diagnostic. Anything that is not a prefixed line, or a prefixed
 * line that is not a JSON object with a `seq`, is `null` rather than a partial read: a
 * half-parsed report that looked like a card would be the worst possible failure here.
 */
export function parseHarnessReportLine(line) {
  if (typeof line !== 'string' || !line.startsWith(CARD_REPORT_PREFIX)) return null
  let parsed
  try {
    parsed = JSON.parse(line.slice(CARD_REPORT_PREFIX.length))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || !Number.isInteger(parsed.seq)) return null
  return parsed
}

/**
 * The newest report in a list, and the newest one that ends a card the way a caller is
 * waiting for.
 *
 * Two questions, asked of the same immutable list, so a journey can wait for "a card is
 * gone" and "a card ended as `acknowledged`" without polling two channels. `end` is the
 * first end in the newest report's list that matches, or null.
 */
export function latestCardReport(reports, end = null) {
  const list = Array.isArray(reports) ? reports : []
  const newest = list.length === 0 ? null : list[list.length - 1]
  if (newest === null || end === null) return { report: newest, end: null }
  const ends = Array.isArray(newest.ends) ? newest.ends : []
  return { report: newest, end: ends.find((value) => value === end) ?? null }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the arguments
// ─────────────────────────────────────────────────────────────────────────────

export const USAGE = `usage: node ${SCRIPT_PATH} [--out <path>] [--keep-state] [--help]

Starts the product's shipped Electron main entry point, records what it does on this display
today, then starts the real built hub in a run-time harness that supplies the three seams the
product has not built (the card document, the main-to-renderer channel, the acknowledgement
signal), drives three real journeys over the real loopback socket, and observes the desktop
from outside the product. One machine-readable JSON summary goes to stdout; progress goes to
stderr. The evidence file names every file the harness wrote and every product file it used.

  --out <path>   where to write the evidence file (default ${DEFAULT_EVIDENCE_PATH})
  --keep-state   do not delete the temporary state and harness directories on exit
  --help         this text

Exit codes: 0 only when every assertion ran and matched. 1 on a failed assertion. 2 on a
bad command line. 3 on a missing dependency, in which case no evidence file is written.`

/**
 * The command line.
 *
 * `--out` exists because the evidence file is an artefact a reviewer reads and a reviewer
 * may want it elsewhere. There is no other option, because every other input this run
 * takes is a fact about the machine rather than something a caller chooses - and in
 * particular there is no `--skip` and no `--tolerate`, because either would reintroduce
 * exactly the green-but-empty result this script exists to make impossible.
 */
export function parseArgs(argv) {
  const args = { out: DEFAULT_EVIDENCE_PATH, keepState: false, help: false }
  const list = Array.isArray(argv) ? argv : []
  for (let index = 0; index < list.length; index += 1) {
    const argument = list[index]
    if (argument === '--help' || argument === '-h') args.help = true
    else if (argument === '--keep-state') args.keepState = true
    else if (argument === '--out') {
      const value = list[index + 1]
      if (value === undefined || value.startsWith('--')) throw new UsageError('--out needs a path')
      args.out = value
      index += 1
    } else throw new UsageError(`unrecognised argument: ${argument}`)
  }
  return args
}

export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
    this.code = 2
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the run-time harness source
//
// The product ships no card document, no main-to-renderer channel and no
// acknowledgement hook, and this task may not change product code. Those three seams are
// generated here rather than written in the product, and the generated code is a string
// so that it can be swept by a test in exactly the way tests/notify/policy.test.ts sweeps
// src/notify: no platform notification mechanism, no subprocess, no weakened renderer
// sandbox, no `nodeIntegration`.
// ─────────────────────────────────────────────────────────────────────────────

/** The global the harness's card-document entry point mounts the product's view on. */
export const CARD_SURFACE_GLOBAL = '__agentPingCardSurface'
/** The prefix of the call that presents a card, so the name exists in exactly one place. */
export const SHOW_CARD_CALL_PREFIX = `globalThis.${CARD_SURFACE_GLOBAL}.show(`
/** The prefix of the call that ends a card, the same way. */
export const REMOVE_CARD_CALL_PREFIX = `globalThis.${CARD_SURFACE_GLOBAL}.remove(`

/** The expression a renderer is asked to evaluate to report what its document holds. */
export const READ_CARD_REPORT_JS =
  '(function () { const s = globalThis.' +
  CARD_SURFACE_GLOBAL +
  '; return s === undefined ? { ready: false } : s.report() })()'

/**
 * The one call that puts a card into the document, as a string.
 *
 * Pure, and the JSON is the product's own `CardModel` and `CardLifetimeCell` exactly as
 * the notifier built them: nothing is added, renamed or defaulted on the way in. A model
 * that cannot be serialised is a null argument rather than a crash, so a defect upstream
 * becomes a failed delivery with a reason instead of a hung delivery.
 */
export function showCardCall(model, cell) {
  return `${SHOW_CARD_CALL_PREFIX}${JSON.stringify(model ?? null)}, ${JSON.stringify(cell ?? null)})`
}

/** The one call that takes a card off the document, naming the end the product's table allows. */
export function removeCardCall(end) {
  return `${REMOVE_CARD_CALL_PREFIX}${JSON.stringify(end)})`
}

/**
 * The card document's own entry point: the harness's mount, the product's view.
 *
 * The only thing this file does is hand the product's `createCardView` an element to put
 * cards inside and expose three calls. What a card *is*, how it is announced, when it
 * expires and how it leaves are all `dist/main/notify/surface/card-view.js` and
 * `dist/main/notify/surface/lifetime.js` - copied byte for byte out of the build and
 * imported here by the same URL the hub serves them from.
 *
 * The report is attribute names and character counts. No word of the card is read, so
 * nothing that reaches the evidence file can carry content (APX-FR-01).
 */
export function cardEntrySource() {
  return `// GENERATED by ${SCRIPT_PATH} on every run. Do not edit.
// The card view this mounts is the product's own compiled module, served from this origin.
import { createCardView } from '/card-view.js'

const parent = document.querySelector('[data-card-surface]')
const ends = []
const view = createCardView({
  parent: parent,
  onEnd: function (end) { ends.push(end) },
})

const report = function () {
  const element = document.querySelector('[data-card]')
  if (element === null) {
    return { ready: true, showing: view.showing, ends: ends.slice(), childElementCount: parent.childElementCount, element: null }
  }
  // The whole subtree, not the root: the urgency icon and word and the two text lines are
  // child elements, and "a real element tree with real semantics" is a claim about all of
  // them rather than about one node.
  const attributes = []
  for (const node of [element].concat(Array.prototype.slice.call(element.querySelectorAll('*')))) {
    for (const name of node.getAttributeNames()) {
      if (attributes.indexOf(name) === -1) attributes.push(name)
    }
  }
  return {
    ready: true,
    showing: view.showing,
    ends: ends.slice(),
    childElementCount: parent.childElementCount,
    element: {
      attributes: attributes,
      elementCount: element.querySelectorAll('*').length + 1,
      inlineStyle: element.getAttribute('style'),
      urgency: element.getAttribute('data-urgency'),
      lifetime: element.getAttribute('data-lifetime'),
      expiresIn: element.getAttribute('data-expires-in'),
      role: element.getAttribute('role'),
      ariaLive: element.getAttribute('aria-live'),
      motion: element.getAttribute('data-motion-state-arrival'),
      hasDeepLink: element.hasAttribute('data-deep-link'),
      ariaLabelLength: (element.getAttribute('aria-label') || '').length,
      titleLength: ((element.querySelector('[data-card-title]') || {}).textContent || '').length,
      bodyLength: ((element.querySelector('[data-card-body]') || {}).textContent || '').length,
    },
  }
}

globalThis.${CARD_SURFACE_GLOBAL} = {
  show: function (model, cell) { view.show(model, cell) },
  remove: function (end) { view.remove(end) },
  report: report,
}
`
}

/**
 * The card document, and the stylesheet that draws it.
 *
 * Both are the harness's, because the product's are dashboard-engineer's and do not exist
 * (see the header). The document declares no inline style and no inline script, because the
 * hub sends the dashboard a strict content-security policy with no `unsafe-inline` and no
 * `unsafe-eval` (src/hub/security.ts): a card that needed either would be a card this
 * product's own boundary refuses to run. The stylesheet is served as its own file for the
 * same reason - `style-src 'self'`.
 */
export function cardDocumentSource() {
  return {
    'card.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>agent-ping card</title>
    <link rel="stylesheet" href="/card.css" />
  </head>
  <body>
    <div data-card-surface></div>
    <script type="module" src="/card-entry.js"></script>
  </body>
</html>
`,
    'card.css': `/* GENERATED by ${SCRIPT_PATH}. The product's own card stylesheet is
   dashboard-engineer's and is not in the build; this one exists so the card document has
   something to draw with, and it paints the product's attributes rather than inventing any
   state of its own. No inline style, because the hub's policy carries no unsafe-inline. */
html,
body {
  margin: 0;
  padding: 0;
  background: transparent;
  font-family: system-ui, sans-serif;
}

[data-card-surface] {
  width: 100%;
  height: 100%;
}

[data-card] {
  box-sizing: border-box;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 1px 8px;
  align-content: center;
  width: 100%;
  height: 100%;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid #3a4256;
  background: #1f2430;
  color: #f2f5fb;
  font-size: 13px;
  line-height: 1.25;
}

[data-card][data-urgency='critical'] {
  background: #3a1f24;
  border-color: #7d2b34;
}

[data-card][data-urgency='normal'] {
  background: #1b2b24;
  border-color: #2f5b46;
}

[data-card-urgency-icon,
[data-card-urgency-word,
[data-card-title],
[data-card-body] {
  margin: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

[data-card-urgency-icon {
  grid-row: span 3;
  align-self: center;
  font-weight: 700;
}

[data-card-urgency-word {
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.9;
}

[data-card-title] {
  font-weight: 600;
}

[data-motion-state-arrival='instant'] {
  transition: none;
}
`,
  }
}

/**
 * The Electron main process this run launches, as a string.
 *
 * What it is: the smallest possible Electron main process that starts the PRODUCT'S OWN
 * built `startHub` and hands it the three collaborators the product documents as injected
 * seams - a `SurfaceHostBridge` built by the product's own `createElectronSurfaceHost` with
 * the product's own option set, a `CardPresenter`, and the run-time dashboard root. The
 * class policy, the classifier, the routes, the store, the policy, the placement arithmetic,
 * the card model, the lifetime table and the card view are all the product's, and none of
 * them is stubbed, replaced or wrapped.
 *
 * What it is not: a second product. It does not re-decide anything the product decides. It
 * does not re-arm a card, does not acknowledge anything, and does not take a window down
 * except in response to an end the product's own lifetime cell names - which is the
 * stand-in for the ack-route hook the product does not have, and is recorded as such in
 * every line it writes.
 *
 * No top-level await anywhere, because Chromium decides about the app before the module
 * graph finishes and a top-level await in an Electron main entry hangs before
 * `app.whenReady()` resolves (src/notify/surface/electron-host.ts records that measurement).
 */
export function harnessMainSource({ productRoot, dashboardRoot }) {
  return `// GENERATED by ${SCRIPT_PATH} on every run. Do not edit.
// The verification harness: a real Electron main process that starts the real built hub.
'use strict'
const path = require('node:path')

const PRODUCT_ROOT = ${JSON.stringify(productRoot)}
const DASHBOARD_ROOT = ${JSON.stringify(dashboardRoot)}
const CARD_REPORT_PREFIX = ${JSON.stringify(CARD_REPORT_PREFIX)}
const READ_CARD_REPORT_JS = ${JSON.stringify(READ_CARD_REPORT_JS)}
const SHOW_CALL_PREFIX = ${JSON.stringify(SHOW_CARD_CALL_PREFIX)}
const REMOVE_CALL_PREFIX = ${JSON.stringify(REMOVE_CARD_CALL_PREFIX)}
const READY_TIMEOUT_MS = ${String(CARD_DOCUMENT_READY_TIMEOUT_MS)}
const POLL_MS = 200

const windows = []
const handled = new Set()
let hub = null
let electronApp = null
let model = null
let cell = null
let presents = 0
let ackRemovals = 0
let seenEnds = 0
let seq = 0
let lastLine = null
let polling = false
let latest = { ready: false, showing: false, ends: [], element: null, error: null }
let cardEnd = null

const sleep = function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms) }) }

function emit(extra) {
  const body = Object.assign({}, latest, extra === undefined ? {} : extra)
  // Compared without the clock, so a poll that changed nothing writes nothing: the report
  // stream is a record of changes, and a line every 200 ms would bury the two that matter.
  const comparable = JSON.stringify(body)
  if (comparable === lastLine) return
  lastLine = comparable
  seq = seq + 1
  process.stdout.write(
    CARD_REPORT_PREFIX + JSON.stringify(Object.assign({ seq: seq, at: Date.now() }, body)) + '\\n',
  )
}

function fail(reason) {
  latest = Object.assign({}, latest, { error: reason })
  emit()
}

function sessionFromDeepLink(link) {
  if (typeof link !== 'string' || link === '') return null
  const at = link.indexOf('session=')
  if (at === -1) return null
  const tail = link.slice(at + 'session='.length)
  const end = tail.search(/[&#]/)
  return decodeURIComponent(end === -1 ? tail : tail.slice(0, end))
}

// One end per card, taken off the screen when the CELL the product handed this harness
// names that end. 'replaced' is in no cell's list, because a replacement is a new card in
// the same window and the host has just re-shown it. 'destroyed' is the host's own.
function actOnEnds(ends) {
  if (!Array.isArray(ends)) return 'not-a-list'
  if (ends.length <= seenEnds) return 'no-new-end'
  const fresh = ends.slice(seenEnds)
  seenEnds = ends.length
  let state = 'no-cell-names-this-end'
  for (const end of fresh) {
    if (cell === null || !Array.isArray(cell.ends) || cell.ends.indexOf(end) === -1) continue
    const window = windows[0]
    const visibleWhenItEnded =
      window !== undefined && !window.isDestroyed() ? window.isVisible() : null
    const at = Date.now()
    hub.surface.hide()
    cardEnd = {
      end: end,
      at: at,
      windowWasVisibleWhenTheCardEnded: visibleWhenItEnded,
      hiddenBy:
        'this harness, standing in for the product hook that does not exist: nothing in the ' +
        'product takes the window down when a card ends, so the run records that gap and ' +
        'completes it here (NT-FR-10)',
    }
    state = 'hid-the-window-for-' + end
    emit({ cardEnd: cardEnd })
  }
  return state
}

// The acknowledgement the ack route cannot deliver. The route changed a record and said
// nothing to the surface; the harness watches the hub's own pending accessor and calls the
// card view's own remove('acknowledged'), which is a product method on a product object.
//
// Every answer is a closed token and every one of them is reported, because a harness that
// silently did not complete the gap would leave the run asserting a card had gone for a
// reason nobody could name - the failure mode this whole script exists to prevent.
function watchForAcknowledgement() {
  if (hub === null || latest.showing !== true) return 'no-card-showing'
  if (cell === null || cell.lifetime !== 'until-resolved') return 'not-a-block'
  const session = sessionFromDeepLink(model === null ? null : model.deepLink)
  if (session === null) return 'no-session-on-the-card'
  if (handled.has(session)) return 'already-handled'
  const pending = hub.store.readPending()
  for (const item of pending) {
    if (item.sessionId === session) return 'still-pending'
  }
  handled.add(session)
  ackRemovals = ackRemovals + 1
  const window = windows[0]
  void window.webContents
    .executeJavaScript(REMOVE_CALL_PREFIX + JSON.stringify('acknowledged') + ')')
    .then(function () {
      emit({ ackState: 'removed' })
    })
    .catch(function (cause) {
      fail(
        'the card could not be told its block was acknowledged: ' +
          (cause && cause.message ? cause.message : String(cause)),
      )
    })
  return 'removing'
}

async function poll() {
  if (hub === null || polling) return
  const window = windows[0]
  if (window === undefined || window.isDestroyed()) return
  polling = true
  try {
    const value = await window.webContents.executeJavaScript(READ_CARD_REPORT_JS)
    if (value === null || typeof value !== 'object') {
      fail('the card document answered the report with ' + JSON.stringify(value))
      return
    }
    latest = Object.assign({}, value, { error: null })
    const endState = actOnEnds(value.ends)
    const ackState = watchForAcknowledgement()
    emit({ endState: endState, ackState: ackState, ackRemovals: ackRemovals })
  } catch (cause) {
    fail(
      'the card document could not be read: ' +
        (cause && cause.message ? cause.message : String(cause)),
    )
  } finally {
    polling = false
  }
}

async function main() {
  const entry = await import(path.join(PRODUCT_ROOT, 'dist/main/main/index.js'))
  const hostModule = await import(path.join(PRODUCT_ROOT, 'dist/main/notify/surface/electron-host.js'))
  const imported = await import('electron')
  const runtime = imported.default === undefined ? imported : imported.default
  const { app, BrowserWindow, screen } = runtime
  electronApp = app

  // The real BrowserWindow, held. The product creates it with its own frozen option set
  // and places it with its own arithmetic; this class only remembers the instance so a
  // renderer can be talked to, which is the channel the product has not chosen yet.
  class RecordingWindow extends BrowserWindow {
    constructor(options) {
      super(options)
      windows.push(this)
      if (windows.length > 1) {
        fail('the product created more than one surface window: ' + String(windows.length))
      }
    }
  }

  const surface = {
    create: function (options) {
      return hostModule.createElectronSurfaceHost({
        BrowserWindow: RecordingWindow,
        screen: screen,
        documentUrl: function () {
          return hostModule.surfaceDocumentUrl(options.origin())
        },
        onDiagnostic: function (message) {
          process.stderr.write('surface-host: ' + message + '\\n')
        },
      })
    },
  }

  const renderCard = {
    present: async function (nextModel, nextCell) {
      model = nextModel
      cell = nextCell
      presents = presents + 1
      const window = windows[0]
      if (window === undefined) {
        throw new Error(
          'the product presented a card before it had created a surface window to present it into',
        )
      }
      const deadline = Date.now() + READY_TIMEOUT_MS
      for (;;) {
        const ready = await window.webContents.executeJavaScript(
          'typeof globalThis.' + ${JSON.stringify(CARD_SURFACE_GLOBAL)},
        )
        if (ready === 'object') break
        if (Date.now() > deadline) {
          throw new Error(
            'the card document did not run its entry point within ' +
              String(READY_TIMEOUT_MS) +
              ' ms, so no card could be presented into it (a window with nothing in it is not a card)',
          )
        }
        await sleep(50)
      }
      await window.webContents.executeJavaScript(
        SHOW_CALL_PREFIX + JSON.stringify(nextModel) + ', ' + JSON.stringify(nextCell) + ')',
      )
      emit({ presented: presents, presentedAt: Date.now() })
    },
  }

  await app.whenReady()
  hub = await entry.startHub({
    desktop: { isPrimaryInstance: true, surface: surface, renderCard: renderCard },
    dashboardRoot: DASHBOARD_ROOT,
    lifecycle: { exit: function () { app.quit() } },
    onDiagnostic: function (message) {
      process.stderr.write('hub: ' + message + '\\n')
    },
  })
  process.stderr.write(
    'harness: origin=' +
      hub.origin +
      ' surfaceMounted=' +
      String(hub.surface !== null) +
      ' notifier=' +
      JSON.stringify({ supported: hub.notifier.supported, reason: hub.notifier.reason }) +
      '\\n',
  )
  app.on('before-quit', function () { void hub.lifecycle.shutdown('electron-quit') })
  setInterval(function () { void poll() }, POLL_MS)
  emit({
    harness: {
      origin: hub.origin,
      surfaceMounted: hub.surface !== null,
      notifierSupported: hub.notifier.supported,
      notifierReason: hub.notifier.reason,
      windows: windows.length,
    },
  })
}

void main().catch(function (cause) {
  process.stderr.write(
    'harness: could not start: ' + (cause && cause.stack ? cause.stack : String(cause)) + '\\n',
  )
  process.exitCode = 1
  if (electronApp !== null) electronApp.exit(1)
})
`
}

// ─────────────────────────────────────────────────────────────────────────────
// Impure: the shell. Everything below owns a side effect.
// ─────────────────────────────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => process.stderr.write(`[${SCRIPT_NAME}] ${message}\n`)

/** Replace the operator's home directory with `~`, recursively. */
function scrubHomePaths(value) {
  const home = homedir()
  if (typeof value === 'string') return value.split(home).join('~')
  if (Array.isArray(value)) return value.map(scrubHomePaths)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) out[key] = scrubHomePaths(child)
    return out
  }
  return value
}

/**
 * Whether a command is on `PATH`, and where.
 *
 * `fs.existsSync('xwininfo')` answers a question about the current directory, not about
 * `PATH`, and a preflight that reported every X tool as absent on a desktop that has all
 * four would be worse than no preflight at all. So the lookup walks `PATH` the way a shell
 * does, and returns the directory it resolved to so the evidence file records which copy
 * answered.
 */
export function resolveOnPath(command, environment = process.env) {
  if (typeof command !== 'string' || command === '') return null
  if (command.includes('/')) return existsSync(command) ? command : null
  for (const directory of (environment.PATH ?? '').split(path.delimiter)) {
    if (directory === '') continue
    const candidate = path.join(directory, command)
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // An unreadable PATH entry is a directory this run cannot use, and the next one is
      // just as good a candidate.
    }
  }
  return null
}

function runTool(tool, args, options = {}) {
  const environment = { ...(options.env ?? process.env) }
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete environment[key]
  }
  const result = spawnSync(tool, args, {
    encoding: options.binary ? 'buffer' : 'utf8',
    timeout: options.timeoutMs ?? OBSERVER_COMMAND_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    ...(options.env === undefined ? {} : { env: environment }),
  })
  return {
    ok: result.error === undefined && result.status === 0,
    status: result.status ?? null,
    signal: result.signal ?? null,
    stdout: result.stdout ?? (options.binary ? Buffer.alloc(0) : ''),
    stderr: result.stderr === undefined ? '' : String(result.stderr),
    error: result.error === undefined ? null : result.error.message,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Impure: the desktop observer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything it does is a question asked of the X server, and nothing it is told by the
 * product except which process id to look for. It is a class rather than loose functions
 * so the two control questions - is the observer working, and was the tool it needs
 * present at all - have exactly one place to be answered.
 */
class DesktopObserver {
  constructor(tools) {
    this.tools = tools
  }

  /** The display's advertised usable rectangle, or a refusal that names the tool. */
  workArea() {
    const result = runTool(this.tools.xprop, ['-root', '_NET_WORKAREA'])
    if (!result.ok) return { workArea: null, rectangles: [], error: result.error ?? result.stderr.trim() }
    return parseWorkArea(result.stdout)
  }

  /**
   * Every window in the tree under the root, with its absolute geometry.
   *
   * `-root -tree` and not `-root -children`, because "direct children of the root" is not
   * the same set as "the windows on this desktop": a window manager reparents a managed
   * window under a decoration frame, so a card-sized window this product created can sit
   * two levels down and be invisible to the shallower query. A shallower observer that
   * found nothing would report "no card appeared" for a card that was there, which is the
   * one answer this script must never give by accident.
   */
  listWindows() {
    const result = runTool(this.tools.xwininfo, ['-root', '-tree'])
    if (!result.ok) return { windows: [], error: result.error ?? result.stderr.trim() }
    return { windows: parseWindowList(result.stdout), error: null }
  }

  /** One window's map state, geometry and depth. */
  detail(id) {
    const result = runTool(this.tools.xwininfo, ['-id', id])
    if (!result.ok) return { detail: parseWindowDetail(''), error: result.error ?? result.stderr.trim() }
    return { detail: parseWindowDetail(result.stdout), error: null }
  }

  /** One window's owning process, or null when it has none. */
  ownerPid(id) {
    const result = runTool(this.tools.xprop, ['-id', id, '_NET_WM_PID'])
    if (!result.ok) return { pid: null, error: result.error ?? result.stderr.trim() }
    return { pid: parseNetWmPid(result.stdout), error: null }
  }

  /** One window's own pixels. */
  capture(id) {
    const result = runTool(this.tools.xwd, ['-silent', '-id', id], { binary: true })
    if (!result.ok) return { capture: { ok: false, reason: result.error ?? result.stderr.trim() }, error: result.error }
    return { capture: parseXwdPixels(result.stdout), error: null }
  }

  /**
   * Every window that is new, viewable, owned by `pid` and card-shaped, with its pixels.
   *
   * The judgement is `screenWindowFacts`, which is pure and unit-tested; this method only
   * gathers the facts the display has to be asked for and then reads the candidates'
   * pixels. Anything turned down comes back in `rejected` with its reason, so a reader
   * sees what was rejected rather than only what survived.
   */
  cardWindows(before, pid) {
    const listing = this.listWindows()
    const facts = appearedWindowIds(before, listing.windows).map((id) => {
      const { detail } = this.detail(id)
      const { pid: owner } = this.ownerPid(id)
      return { id, detail, pid: owner }
    })
    const { candidates, rejected } = screenWindowFacts(facts, pid)
    return {
      candidates: candidates.map((window) => ({ ...window, pixels: this.capture(window.id).capture })),
      rejected,
      listingError: listing.error,
    }
  }

  /**
   * Every card-shaped window on the desktop right now, with its facts and its pixels.
   *
   * Not a diff against a baseline, because the product keeps one window for the life of
   * the hub and shows it again for the next card: a second card in a run is the same
   * window becoming viewable, not a new id, so the diff has to be taken by the caller
   * against its own previous reading of this (`emergingCardWindows`).
   *
   * Only windows of the product's documented size are interrogated, so this costs one
   * `xwininfo`, one `xprop` and one `xwd` per card-shaped window on the desktop - normally
   * one, and the count is returned so a reader can see it.
   */
  cardWindowFacts(pid) {
    const listing = this.listWindows()
    const shaped = listing.windows.filter(
      (window) =>
        window.relative.width === CARD_WINDOW_SIZE.width && window.relative.height === CARD_WINDOW_SIZE.height,
    )
    const facts = shaped.map((window) => {
      const { detail } = this.detail(window.id)
      const { pid: owner } = this.ownerPid(window.id)
      return {
        id: window.id,
        detail,
        pid: owner,
        pixels: owner === pid ? this.capture(window.id).capture : { ok: false, reason: 'not owned by the hub process' },
      }
    })
    return { facts, listingError: listing.error, cardShapedWindows: shaped.length }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Impure: the hub, as a child process
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Chromium launch policy, read from the product's own decision rather than guessed.
 *
 * `CHROMIUM_LAUNCH_ENVIRONMENT` in src/notify/surface/electron-host.ts exists because
 * Chromium reads its command line and decides about the process sandbox before any
 * JavaScript in this package runs. This run sets the environment form; a run that did not
 * would die of SIGTRAP, and that it does is measured below rather than assumed.
 */
export const CHROMIUM_LAUNCH_ENVIRONMENT = Object.freeze({ ELECTRON_DISABLE_SANDBOX: '1' })

/** The built Electron main entry point the shipped run starts. */
const BUILT_ENTRY_POINT = 'dist/main/main/index.js'
/** The schema the tsc build does not copy and a hub started from the build needs. */
const BUILT_SCHEMA_FILE = 'dist/main/storage/schema.sql'

/**
 * The product's own compiled card view, copied out of the build and served to the card
 * document.
 *
 * Three files, and the closure is closed: `card-view.js` imports `./card.js` and
 * `./lifetime.js` and nothing else, and the two of those import no module at all once
 * their type-only imports are erased. So these three bytes are the whole of "what a card
 * is" and "how long it lives" as the product compiled them, and a card rendered from them
 * is the product's card.
 */
export const BUILT_CARD_MODULES = Object.freeze([
  'dist/main/notify/surface/card-view.js',
  'dist/main/notify/surface/card.js',
  'dist/main/notify/surface/lifetime.js',
])

/**
 * Start a real Electron main process and keep everything it says.
 *
 * One launcher for both runs this script makes, because the difference between them is
 * the entry point and the extra environment and nothing else: the same binary, the same
 * Chromium launch policy, the same fresh temporary state directory, the same capture of
 * stdout and stderr, the same stop.
 *
 * Card-report lines - the harness's readings of its own renderer - are separated out of
 * stdout as they arrive and kept in full, because they are data this run asserts on and a
 * ring buffer would drop exactly the ones a slow journey needs. They are still kept out of
 * the diagnostic lines, which stay a bounded ring: this process is not a log sink.
 */
function launchChild({ electronBinary, stateDir, entryPoint, env = {} }) {
  const child = spawn(electronBinary, [entryPoint], {
    cwd: repoRoot,
    env: { ...process.env, ...CHROMIUM_LAUNCH_ENVIRONMENT, AGENT_PING_STATE_DIR: stateDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so the stop below can take the GPU, zygote and renderer
    // children with it. A verification run that leaves a window on the next run's display
    // has destroyed the thing it exists to measure.
    detached: true,
  })
  const stdout = []
  const stderr = []
  const reports = []
  const keep = (lines, chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim() === '') continue
      lines.push(line)
      if (lines.length > MAX_CHILD_OUTPUT_LINES) lines.shift()
    }
  }
  const takeReports = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      const report = parseHarnessReportLine(line)
      if (report !== null) reports.push(report)
    }
  }
  child.stdout.on('data', (chunk) => {
    takeReports(chunk)
    keep(stdout, chunk)
  })
  child.stderr.on('data', (chunk) => keep(stderr, chunk))
  /** Signal the whole group, and say whether there was anything left to signal. */
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal)
      return true
    } catch {
      try {
        child.kill(signal)
        return true
      } catch {
        return false
      }
    }
  }
  return {
    child,
    entryPoint,
    stdout,
    stderr,
    reports,
    /** The newest card report, or null when the harness has never sent one. */
    latestReport: () => latestCardReport(reports).report,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return { alreadyExited: true, escalated: false }
      signalGroup('SIGTERM')
      const deadline = Date.now() + HUB_STOP_TIMEOUT_MS
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) return { alreadyExited: false, escalated: false }
        await sleep(100)
      }
      const escalated = signalGroup('SIGKILL')
      const hardDeadline = Date.now() + 2_000
      while (Date.now() < hardDeadline) {
        if (child.exitCode !== null || child.signalCode !== null) return { alreadyExited: false, escalated }
        await sleep(100)
      }
      return { alreadyExited: false, escalated, stillRunning: true }
    },
  }
}

/**
 * Start the product's shipped Electron main entry point, as shipped.
 *
 * Kept separate from the harness run because the claim it answers is a different one: not
 * "can a card be shown" but "what does the product do on a developer's machine today". The
 * evidence file records that separately, as `shippedPosture`, and it is not an assertion -
 * a shipped build that grew a card document tomorrow would make a passing assertion here a
 * false alarm, and the runbook would be the stale artefact instead.
 */
function launchHub({ electronBinary, stateDir, entryPoint = BUILT_ENTRY_POINT }) {
  return launchChild({ electronBinary, stateDir, entryPoint })
}

/**
 * Write the run-time harness: the card document, its stylesheet, its entry point, the
 * product's own compiled card modules beside it, and the Electron main that starts the hub.
 *
 * Everything goes into a directory of this run's own, never into the checkout, and the
 * directory is removed on the way out. The dashboard root is a *copy* of the built
 * dashboard rather than the build itself, so serving this run's document cannot alter what
 * the next `npm run build` produces or what a developer's running hub serves.
 *
 * The manifest it returns names every file it wrote and every product file it copied, and
 * that list is what the evidence file carries: a reader can see exactly which bytes were
 * the product's and which were this script's.
 */
function prepareHarness(rootDir) {
  const dashboardRoot = path.join(rootDir, 'dashboard')
  const mainPath = path.join(rootDir, 'harness-main.cjs')
  mkdirSync(dashboardRoot, { recursive: true })
  const written = []
  const write = (name, contents) => {
    writeFileSync(path.join(dashboardRoot, name), contents)
    written.push({ file: name, bytes: Buffer.byteLength(contents), origin: 'this script' })
  }
  for (const [name, contents] of Object.entries(cardDocumentSource())) write(name, contents)
  write('card-entry.js', cardEntrySource())

  // The real built dashboard, copied rather than referenced.
  const builtDashboard = path.join(repoRoot, 'dist', 'dashboard')
  for (const entry of readdirSync(builtDashboard, { withFileTypes: true })) {
    const from = path.join(builtDashboard, entry.name)
    const to = path.join(dashboardRoot, entry.name)
    if (entry.isDirectory()) {
      cpSync(from, to, { recursive: true })
    } else {
      copyFileSync(from, to)
    }
    written.push({ file: entry.name, bytes: statSync(to).size, origin: 'the built dashboard, copied' })
  }

  // The product's own compiled card view, byte for byte.
  const copied = []
  for (const relative of BUILT_CARD_MODULES) {
    const from = path.join(repoRoot, relative)
    const name = path.basename(relative)
    copyFileSync(from, path.join(dashboardRoot, name))
    copied.push({
      product: relative,
      servedAs: name,
      bytes: statSync(path.join(dashboardRoot, name)).size,
      identicalToTheBuild: readFileSync(from).equals(readFileSync(path.join(dashboardRoot, name))),
    })
  }

  const main = harnessMainSource({ productRoot: repoRoot, dashboardRoot })
  writeFileSync(mainPath, main)
  return {
    root: rootDir,
    dashboardRoot,
    mainPath,
    manifest: { written, productCardModules: copied, mainBytes: Buffer.byteLength(main) },
  }
}

/** The hub's published record, or null while it is still starting. */
function readRuntimeFile(stateDir) {
  const file = path.join(stateDir, 'hub-runtime.json')
  if (!existsSync(file)) return null
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'))
    return typeof record === 'object' && record !== null && Number.isInteger(record.port) ? record : null
  } catch {
    return null
  }
}

/** The per-install write token, which exists as soon as the hub is serving. */
function readWriteToken(stateDir) {
  const file = path.join(stateDir, 'hub-write-token')
  if (!existsSync(file)) return null
  const token = readFileSync(file, 'utf8').trim()
  return token === '' ? null : token
}

/** The largest response this script will read, and why it is bounded. */
export const MAX_RESPONSE_BYTES = 1_048_576

/**
 * One loopback HTTP request.
 *
 * `node:http` rather than the global `fetch`, for three reasons that are all about being
 * able to state what this script does. It can refuse a non-loopback host outright, which
 * is the whole of APX-CON-12 for a verification script: there is no code path here that
 * can reach anything but 127.0.0.1, and the refusal says so rather than relying on every
 * URL being well formed. It can bound the response in bytes, so a route that answered with
 * a large document cannot exhaust this process. And it can apply its own timeout, so a hub
 * that stopped answering is a failed assertion with a reason rather than a run that hangs
 * until something else notices.
 *
 * Never rejects. Every outcome is a resolved value, because the callers are building
 * observations and a rejected promise in the middle of a journey would leave the assertion
 * count short for no stated reason.
 */
export function request(url, options = {}) {
  return new Promise((resolve) => {
    let target
    try {
      target = new URL(url)
    } catch {
      resolve({ ok: false, status: 0, body: null, error: `not a URL: ${url}` })
      return
    }
    if (target.hostname !== '127.0.0.1' && target.hostname !== 'localhost' && target.hostname !== '[::1]') {
      resolve({
        ok: false,
        status: 0,
        body: null,
        error: `refusing a request to ${target.hostname}: this script only ever talks to the loopback hub (APX-CON-12)`,
      })
      return
    }
    const chunks = []
    let received = 0
    const outgoing = http.request(
      {
        hostname: target.hostname,
        port: target.port === '' ? 80 : target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (response) => {
        response.on('data', (chunk) => {
          received += chunk.length
          if (received <= MAX_RESPONSE_BYTES) chunks.push(chunk)
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body = null
          try {
            body = text === '' ? null : JSON.parse(text)
          } catch {
            // Not JSON. A `GET /card.html` answers text/html and is measured by its status
            // code, so a null body here is a normal outcome rather than a fault.
          }
          const status = response.statusCode ?? 0
          resolve({ ok: status >= 200 && status < 300, status, body })
        })
      },
    )
    outgoing.setTimeout(REQUEST_TIMEOUT_MS, () => {
      outgoing.destroy(new Error(`the request exceeded ${REQUEST_TIMEOUT_MS} ms`))
    })
    outgoing.on('error', (cause) => {
      resolve({ ok: false, status: 0, body: null, error: cause.message })
    })
    if (typeof options.body === 'string') outgoing.write(options.body)
    outgoing.end()
  })
}

const getJson = (url) => request(url)

/** Drive one real signal through the real ingest route, with the real write token. */
const postSignal = (origin, token, body) =>
  request(`${origin}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-ping-token': token },
    body: JSON.stringify(body),
  })

/** Acknowledge one pending item through the only route that can change a record. */
const postAck = (origin, token, eventId) =>
  request(`${origin}/api/ack/${encodeURIComponent(eventId)}`, {
    method: 'POST',
    headers: { 'x-agent-ping-token': token },
  })

async function readPending(origin) {
  const response = await getJson(`${origin}/api/pending`)
  return {
    ok: response.ok,
    count: Number.isInteger(response.body?.count) ? response.body.count : null,
    items: Array.isArray(response.body?.items) ? response.body.items : [],
  }
}

async function readHealth(origin) {
  const response = await getJson(`${origin}/api/health`)
  return { ok: response.ok, status: response.status, health: response.body }
}

async function readEvents(origin, sessionId) {
  const response = await getJson(`${origin}/api/events?sessionId=${encodeURIComponent(sessionId)}&limit=500`)
  return { ok: response.ok, events: Array.isArray(response.body?.events) ? response.body.events : [] }
}

async function readMetrics(origin) {
  const response = await getJson(`${origin}/api/metrics`)
  const counters = Array.isArray(response.body?.counters) ? response.body.counters : []
  return Object.fromEntries(counters.map((counter) => [counter.counter, counter.value]))
}

// ─────────────────────────────────────────────────────────────────────────────
// Impure: the notification-centre instrument
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the operating system's own notification centre did, as an observation.
 *
 * An observation and never an assertion, because "nothing appeared" is not something a
 * script can turn into a positive fact on its own: the honest question is whether the
 * instrument could have seen a notification at all, and the only way to answer that is to
 * cause one deliberately and watch.
 *
 * So: `dbus-monitor` is started on the session bus, filtered to the notification
 * interface, before the journeys; the journeys run; the during-journeys count is sealed;
 * then one `notify-send` is sent as a positive control and counted by the same monitor.
 * The control is the point - without it "zero notifications" is indistinguishable from "a
 * monitor pointed at the wrong bus". `notify-send` is used *only* as the control and is
 * never counted as a product delivery; that is the same distinction this product makes
 * between a probe reaching for a notification tool and a product doing it, and it is why
 * the runbook tells a human not to reach for `notify-send` when checking a card.
 */
function startNotificationMonitor({ dbusMonitor, notifySend }) {
  const available = { monitor: resolveOnPath(dbusMonitor) !== null || existsSync(dbusMonitor), control: resolveOnPath(notifySend) !== null || existsSync(notifySend) }
  const record = {
    question: 'what did the operating system notification centre receive while agent-ping delivered?',
    asserted: false,
    instrument: {
      monitor: `dbus-monitor --session "${NOTIFICATION_MATCH_RULE}"`,
      positiveControl:
        'one notify-send issued after the journeys and counted by the same monitor, so that a zero count is a reading rather than a broken instrument',
      available,
    },
    duringJourneys: null,
    positiveControl: null,
    note:
      'an observation, not an assertion. Nothing in this product is permitted to raise a platform ' +
      'notification, and the source sweep in tests/notify/policy.test.ts is what enforces that; what this ' +
      'section reports is what the desktop could have seen. The D-Bus stream itself is not stored, ' +
      'because it carries the notification text (APX-FR-01).',
  }
  if (!available.monitor) {
    record.instrument.error = 'dbus-monitor is not installed, so the session bus was never watched'
    return { record, sealDuring: () => {}, finish: () => {} }
  }
  const child = spawn(dbusMonitor, ['--session', NOTIFICATION_MATCH_RULE], { stdio: ['ignore', 'pipe', 'pipe'] })
  let buffer = ''
  let count = 0
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    if (buffer.length > 1_000_000) buffer = buffer.slice(-500_000)
    count = countNotifications(buffer)
  })
  let spawnError = null
  child.on('error', (cause) => {
    spawnError = cause.message
  })
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  return {
    record,
    sealDuring() {
      record.duringJourneys = count
    },
    async runPositiveControl() {
      record.duringJourneys = count
      buffer = ''
      count = 0
      if (available.control) {
        const sent = runTool(notifySend, [
          'agent-ping notification-surface verification: positive control',
          'A deliberate control notification, not an agent-ping card.',
        ])
        record.instrument.controlCommandOk = sent.ok
      }
      await sleep(2_000)
      record.positiveControl = available.control ? count : null
      if (spawnError !== null) record.instrument.error = `dbus-monitor could not be started: ${spawnError}`
      stop()
      return record
    },
    finish: stop,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Impure: the preflight
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything that has to exist before a single assertion can run.
 *
 * Every absent item is a failure with a remedy, and the remedies are commands. A missing
 * dependency here is not an environment this script adapts to; it is a run that would
 * otherwise produce a green summary having proven nothing, which is the one outcome this
 * discipline exists to prevent.
 */
function preflight() {
  const names = {
    xwininfo: 'xwininfo',
    xprop: 'xprop',
    xwd: 'xwd',
    xmessage: 'xmessage',
    dbusMonitor: 'dbus-monitor',
    notifySend: 'notify-send',
    xrandr: 'xrandr',
  }
  // Resolved through PATH rather than handed to spawn bare, so the evidence file records
  // which copy answered and the preflight's own answer about availability is the same
  // question the journeys will put to the shell.
  const tools = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, resolveOnPath(name) ?? name]))
  const located = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, resolveOnPath(name)]))
  // The real binary, not the `node_modules/.bin/electron` shim.
  //
  // The shim is a Node program that spawns the binary as its own child, so a signal sent
  // to the shim leaves the Electron process - and every window it owns - running. A
  // verification run that leaves a card window behind on the next run's display is worse
  // than no run at all, so the binary itself is what gets started, and the stop is a
  // process-group signal so the GPU, zygote and renderer children go with it.
  const electronBinary = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron')
  const electronShim = path.join(repoRoot, 'node_modules', '.bin', 'electron')
  const realElectronBinary = electronBinary
  // An empty DISPLAY is not a display. `DISPLAY=''` is what a caller that wants to hide the
  // variable writes, and a preflight that read it as "set" would carry on and then fail
  // somewhere less legible; `present` here is the answer the summary will report.
  const display = process.env.DISPLAY ?? null
  const waylandDisplay = process.env.WAYLAND_DISPLAY ?? null
  const hasDisplay = [display, waylandDisplay].some((value) => typeof value === 'string' && value.trim() !== '')
  const dependencies = []
  const add = (name, present, remedy, detail) => dependencies.push({ name, present, remedy, detail })

  add(
    DependencyStatus.ELECTRON,
    existsSync(realElectronBinary),
    'run `npm install` in the repository root so node_modules/electron is present; the package pins electron 44.4.5 as a runtime dependency. The binary itself is started rather than the node_modules/.bin shim, because a signal to the shim leaves the Electron process and its windows running',
    existsSync(electronShim) ? `${realElectronBinary} (the shim at ${electronShim} exists and is deliberately not used)` : `${realElectronBinary} is not present`,
  )
  add(
    DependencyStatus.DISPLAY,
    hasDisplay,
    'run this from a graphical session with DISPLAY (or WAYLAND_DISPLAY) set - for example on a desktop, or over SSH with X11 forwarding. A headless machine cannot show a card, so it cannot prove one, and this script fails rather than skipping',
    `DISPLAY=${display ?? 'unset'} WAYLAND_DISPLAY=${waylandDisplay ?? 'unset'} XDG_SESSION_TYPE=${process.env.XDG_SESSION_TYPE ?? 'unset'}`,
  )
  const xTools = [
    [DependencyStatus.XWININFO, 'xwininfo', 'install the X.Org utilities (Debian/Ubuntu: `sudo apt-get install x11-utils`) so `xwininfo` is on PATH'],
    [DependencyStatus.XPROP, 'xprop', 'install the X.Org utilities (Debian/Ubuntu: `sudo apt-get install x11-utils`) so `xprop` is on PATH'],
    [DependencyStatus.XWD, 'xwd', 'install the X.Org applications (Debian/Ubuntu: `sudo apt-get install x11-apps`) so `xwd` is on PATH'],
    [
      DependencyStatus.XMESSAGE,
      'xmessage',
      'install the X.Org utilities (Debian/Ubuntu: `sudo apt-get install x11-utils`) so `xmessage` is on PATH. The control window is how this script proves its own observer works, and a run whose observer is unvalidated cannot report that no card appeared',
    ],
  ]
  for (const [status, key, remedy] of xTools) {
    add(status, located[key] !== null, remedy, located[key] ?? `${names[key]} is not on PATH`)
  }
  add(
    DependencyStatus.DBUS_MONITOR,
    located.dbusMonitor !== null,
    'install the D-B utilities (Debian/Ubuntu: `sudo apt-get install dbus`) so `dbus-monitor` is on PATH; without it the notification-centre instrument can be reported as nothing at all',
    located.dbusMonitor ?? 'dbus-monitor is not on PATH',
  )
  add(
    DependencyStatus.BUILT_ENTRY,
    existsSync(path.join(repoRoot, BUILT_ENTRY_POINT)),
    'run `npm run build` in the repository root so dist/main/main/index.js exists',
    BUILT_ENTRY_POINT,
  )
  add(
    DependencyStatus.BUILT_SCHEMA,
    existsSync(path.join(repoRoot, BUILT_SCHEMA_FILE)),
    'the tsc build emits JavaScript only and does not copy src/storage/schema.sql next to it, so copy it with `cp src/storage/schema.sql dist/main/storage/schema.sql`. A hub started from the tsc build cannot open its log without it; the permanent fix is a copy step in scripts/build.mjs, owned by tooling-engineer under DP-1',
    BUILT_SCHEMA_FILE,
  )
  add(
    DependencyStatus.BUILT_DASHBOARD,
    existsSync(path.join(repoRoot, 'dist', 'dashboard', 'index.html')),
    'run `npm run build` so the dashboard is built; the run copies the built dashboard into its own run-time root and adds the card document to it',
    'dist/dashboard/index.html',
  )
  const missingCardModules = BUILT_CARD_MODULES.filter(
    (relative) => !existsSync(path.join(repoRoot, relative)),
  )
  add(
    DependencyStatus.BUILT_CARD_VIEW,
    missingCardModules.length === 0,
    'run `npm run build` so dist/main/notify/surface/{card-view,card,lifetime}.js exist. This run serves the product own compiled card view to the card document rather than writing its own, so those three files are the card: ' +
      missingCardModules.join(', '),
    missingCardModules.length === 0 ? BUILT_CARD_MODULES.join(', ') : `missing ${missingCardModules.join(', ')}`,
  )

  const workArea = new DesktopObserver(tools).workArea()
  add(
    DependencyStatus.WORK_AREA,
    workArea.workArea !== null,
    'the display must advertise _NET_WORKAREA, which is what a window manager publishes so a window can be placed inside the usable area. On a bare X server with no window manager there is none, a card has nowhere correct to go, and this script fails rather than placing it against the screen rectangle',
    workArea.workArea === null ? (workArea.error ?? 'xprop printed no _NET_WORKAREA') : JSON.stringify(workArea.workArea),
  )

  return { tools, electronBinary, display, dependencies, workArea, located }
}

// ─────────────────────────────────────────────────────────────────────────────
// Impure: the journeys
// ─────────────────────────────────────────────────────────────────────────────

/** Synthetic facts for three journeys. Nothing here is a developer's own session. */
const REPO_PATH = '/home/developer/Projects/sample-repository'
const BLOCK_SESSION = 'ses_verify_needs_you'
const FINISHED_SESSION = 'ses_verify_finished'
const GREETING_SESSION = 'ses_verify_greeting'
const occurredAt = () => new Date().toISOString()

/** One assertion row, built in one place so `journey` is never forgotten. */
const observation = (journey, name, expected, actual, measured) => ({
  journey,
  name,
  expected,
  actual,
  ...(measured === undefined ? {} : { measured }),
})

/** The rows a journey owes when the hub never served, so the count cannot drift. */
const notServed = (journey, names) =>
  names.map((name) => observation(journey, name, 'as-expected', 'not-observed: the hub never served, so no journey could be driven'))

/**
 * Poll one reading until it is what a journey is waiting for, or until the deadline.
 *
 * A journey's claim is about a card reaching a screen and then leaving it, and both of
 * those are events with a delay in them: a delivery attempt, a document load and a paint
 * take real time, and so does the 5 000 ms the product's own lifetime table waits. So every
 * claim that could be "not yet" is asked repeatedly with a deadline rather than once after
 * a guessed sleep.
 *
 * The last reading is always returned, whether or not the deadline was reached, so a claim
 * that never became true is reported with what was actually seen rather than with nothing.
 * `ok` is the bookkeeping, never the verdict: the verdict is what the caller compares.
 */
async function settle(deadlineMs, read, ready) {
  const startedAt = Date.now()
  let reads = 0
  for (;;) {
    const last = await read()
    reads += 1
    if (ready(last)) return { ok: true, value: last, elapsedMs: Date.now() - startedAt, reads }
    if (Date.now() - startedAt >= deadlineMs) {
      return { ok: false, value: last, elapsedMs: Date.now() - startedAt, reads }
    }
    await sleep(150)
  }
}

/**
 * One reading of the desktop, for a journey that wants a card window that came into being.
 *
 * `before` is the previous reading of the same method, so "came into being" is decided by
 * `emergingCardWindows` against a fact the observer recorded earlier rather than against an
 * id list captured at some unrelated moment. One reading, three pure judgements on it.
 */
const readCardWindowsNow = (observer, before, hubPid) => () => {
  const { facts, listingError, cardShapedWindows } = observer.cardWindowFacts(hubPid)
  const { emerging, rejected } = emergingCardWindows(before, facts, hubPid)
  return { facts, emerging, rejected, listingError, cardShapedWindows }
}

/**
 * Journey 1: a real block, a real card, a real acknowledgement.
 *
 * The whole positive path, and the order matters. The block is driven first so the
 * window-facts reading taken before it is a true baseline. The card is then looked for,
 * once immediately and once after a wait, because "it was on screen" and "it stayed on
 * screen" are two different claims and NT-FR-08's promise is the second one. Only then is
 * the item acknowledged through the product's own write route, and only then are the
 * pending count - the badge's own source - and the desktop read again.
 *
 * Every visibility claim here is answered by the X server. The renderer's own report is
 * recorded beside each one and is never the basis of a visibility claim: it is what says
 * the card *inside* the window is the product's card view, which the pixels cannot.
 */
async function runNeedsYouJourney({ observer, hub, origin, token, workArea, hubPid }) {
  if (origin === null || token === null) {
    return { observations: notServed('needs-you', NEEDS_YOU_ASSERTIONS), records: [], timings: {} }
  }
  const observations = []
  const timings = {}
  const baseline = observer.cardWindowFacts(hubPid)
  const before = await readPending(origin)

  const posted = await postSignal(origin, token, {
    harness: 'opencode',
    eventName: 'permission.asked',
    sessionId: BLOCK_SESSION,
    repoFullPath: REPO_PATH,
    transitionId: 'verify-block-1',
    occurredAt: occurredAt(),
  })
  const afterIngest = await readPending(origin)
  const eventId = typeof posted.body?.eventId === 'string' ? posted.body.eventId : null

  observations.push(
    observation('needs-you', NEEDS_YOU_ASSERTIONS[0], '1', String(afterIngest.count), {
      ingestStatus: posted.status,
      ingestOutcome: posted.body?.outcome ?? null,
      eventClass: posted.body?.class ?? null,
      pendingBefore: before.count,
      pendingAfter: afterIngest.count,
      thisIs: 'the badge number, read from the same accessor the tray badge reads',
    }),
  )

  // Wait for painted content, not merely for a window: the host shows the window and the
  // card view renders into it afterwards, so a reading taken the instant the window became
  // viewable would find a transparent rectangle and call it blank. The claim being made is
  // "a card is on the screen", and a window with nothing drawn in it is not that
  // (APX-FR-02, NT-FR-10).
  const emerged = await settle(
    CARD_APPEAR_TIMEOUT_MS,
    readCardWindowsNow(observer, baseline.facts, hubPid),
    (reading) => cardOnScreenVerdict(reading.facts, hubPid) === 'painted',
  )
  const immediate = emerged.value ?? { facts: [], emerging: [], rejected: [] }
  timings.cardAppearedMs = emerged.elapsedMs
  observations.push(
    observation('needs-you', NEEDS_YOU_ASSERTIONS[1], 'inside-the-work-area', cardWindowVerdict(immediate.emerging, workArea), {
      workArea,
      workAreaSource: 'xprop -root _NET_WORKAREA, the display server own answer',
      waitedMs: emerged.elapsedMs,
      reads: emerged.reads,
      candidates: immediate.emerging,
      rejectedWindows: immediate.rejected,
    }),
  )
  observations.push(
    observation('needs-you', NEEDS_YOU_ASSERTIONS[2], 'painted', cardPixelsVerdict(immediate.emerging), {
      whatWasMeasured:
        'the number of distinct 32-bit pixel values in the window own xwd drawable. No word is read, so no claim is made about legibility',
    }),
  )

  const rendered = await settle(
    CARD_END_TIMEOUT_MS,
    async () => hub.latestReport(),
    (report) => cardReportVerdict(report) === 'rendered',
  )
  timings.cardRenderedMs = rendered.elapsedMs
  const cardReport = rendered.value ?? null
  observations.push(
    observation('needs-you', NEEDS_YOU_ASSERTIONS[3], 'rendered', cardReportVerdict(cardReport), {
      readFrom:
        "the renderer inside the hub's own window, by the harness's channel; corroboration for what is IN the card, never the basis of whether anything is ON the screen",
      viewModule: 'dist/main/notify/surface/card-view.js, the product own compiled card view',
      element: cardReport?.element ?? null,
      childElementCount: cardReport?.childElementCount ?? null,
      harnessError: cardReport?.error ?? null,
    }),
  )

  const settledAt = Date.now()
  await sleep(NEEDS_YOU_SETTLE_MS)
  timings.settleWaitMs = Date.now() - settledAt
  const persisted = readCardWindowsNow(observer, baseline.facts, hubPid)()
  const persistedVerdict = cardOnScreenVerdict(persisted.facts, hubPid)
  observations.push(
    observation(
      'needs-you',
      NEEDS_YOU_ASSERTIONS[4],
      'still-present',
      persistedVerdict === 'painted'
        ? 'still-present'
        : cardOnScreenVerdict(immediate.facts, hubPid) !== 'painted'
          ? 'not-observed: no card window was ever seen, so it cannot be called persistent'
          : `gone-within-the-wait: ${persistedVerdict}`,
      {
        waitedMs: NEEDS_YOU_SETTLE_MS,
        reArmed: false,
        why:
          'NT-FR-08: one needs-you card per block, never re-armed, so the only thing that can remove it ' +
          'in this window is the block being resolved or acknowledged - neither of which has happened yet',
        candidates: persisted.emerging,
        onScreenVerdict: persistedVerdict,
      },
    ),
  )

  const health = (await readHealth(origin)).health
  observations.push(
    observation('needs-you', NEEDS_YOU_ASSERTIONS[5], 'delivered', deliveryVerdict(health?.delivery), {
      delivery: health?.delivery ?? null,
      whatThisMeans:
        'the product own delivery policy recorded a delivered outcome, which it can only do when the ' +
        'product own notifier showed the product own window and the product own card view accepted the ' +
        'product own card model. A status of ok on its own would not be enough: a hub with a wired policy ' +
        'and a failed card answers ok too, so the counts are compared as well',
    }),
  )

  const cardDocument = await request(`${origin}/card.html`)
  observations.push(
    observation('needs-you', NEEDS_YOU_ASSERTIONS[6], '200', String(cardDocument.status), {
      path: '/card.html',
      servedFrom:
        "this run's own dashboard root: a copy of the built dashboard plus the card document this run wrote, because the product ships no card document",
      presentInTheProductBuild: existsSync(path.join(repoRoot, 'dist', 'dashboard', 'card.html')),
    }),
  )

  const ack = eventId === null ? { status: 0, error: 'the block never produced an event id to acknowledge' } : await postAck(origin, token, eventId)
  const afterAck = await readPending(origin)
  observations.push(
    observation('needs-you', NEEDS_YOU_ASSERTIONS[7], '0', String(afterAck.count), {
      ackStatus: ack.status,
      pendingBefore: afterIngest.count,
      pendingAfter: afterAck.count,
      thisIs:
        'the number the tray badge reads (GET /api/pending, read through the same accessor src/hub/tray.ts ' +
        'uses), so a fall here is a fall of the badge own number. An Electron Tray is a StatusNotifierItem and ' +
        'not an X window, so the icon itself cannot be observed from outside the process - see notVerified',
    }),
  )

  // Wait for the card to be off the display, not merely for its pixels to stop: a card whose
  // element has been removed out of a window that is still mapped is `blank`, and calling
  // that "gone" would leave a mapped rectangle on the next journey's baseline - where it
  // would look like a card that had appeared before the next one did (NT-FR-10).
  const gone = await settle(
    CARD_END_TIMEOUT_MS,
    readCardWindowsNow(observer, baseline.facts, hubPid),
    (reading) => cardOnScreenVerdict(reading.facts, hubPid) === 'no-card-window',
  )
  const afterAckWindows = gone.value ?? { facts: [], emerging: [], rejected: [] }
  const afterAckReport = hub.latestReport()
  timings.cardGoneMs = gone.elapsedMs
  observations.push(
    observation(
      'needs-you',
      NEEDS_YOU_ASSERTIONS[8],
      'gone',
      cardOnScreenVerdict(afterAckWindows.facts, hubPid) === 'no-card-window'
        ? cardOnScreenVerdict(immediate.facts, hubPid) === 'painted'
          ? 'gone'
          : 'not-observed: no card window was ever seen, so its disappearance proves nothing'
        : `still-on-the-display: ${cardOnScreenVerdict(afterAckWindows.facts, hubPid)}`,
      {
        waitedMs: gone.elapsedMs,
        onScreenVerdict: cardOnScreenVerdict(afterAckWindows.facts, hubPid),
        cardElementInTheDocument: cardReportVerdict(afterAckReport),
        cardEndReportedByTheCardView: afterAckReport?.ends ?? [],
        acknowledgementCompletedByTheHarness: afterAckReport?.ackState ?? null,
        candidates: afterAckWindows.emerging,
        whoRemovedIt:
          'the product own card view removed the card element on an end its own lifetime cell names, and ' +
          'the product own host took the window down. Nothing in the product tells the surface that a block ' +
          'was acknowledged, so the harness supplied that signal - see requiredProductChanges',
      },
    ),
  )

  return {
    observations,
    timings,
    records: [
      {
        journey: 'needs-you',
        eventClass: 'needs-you',
        eventId,
        ingestOutcome: posted.body?.outcome ?? null,
        pendingBefore: before.count,
        pendingAfterIngest: afterIngest.count,
        pendingAfterAck: afterAck.count,
        cardWindowAppeared: immediate.emerging.length > 0,
        cardAppearedAfterMs: emerged.elapsedMs,
        cardRectangles: immediate.emerging.map((window) => ({
          windowId: window.id,
          x: window.x,
          y: window.y,
          width: window.width,
          height: window.height,
          mapState: window.mapState,
          emergedBecause: window.emergedBecause,
          insideWorkArea: rectContains(workArea, { x: window.x, y: window.y, width: window.width, height: window.height }),
          pixels: window.pixels,
        })),
        cardSizeSource: CARD_WINDOW_SIZE_SOURCE,
        cardViewReported: cardReportVerdict(cardReport),
        cardElement: cardReport?.element ?? null,
        ackStatus: ack.status,
        cardGoneAfterMs: gone.elapsedMs,
        cardEndReportedByTheCardView: afterAckReport?.ends ?? [],
        rejectedWindows: immediate.rejected,
      },
    ],
  }
}

/**
 * Journey 2: a real finished turn, whose card must leave on its own.
 *
 * Nothing is acknowledged and nothing is dismissed during the wait, and this script has
 * no fallback dismissal, because a fallback would make an unimplemented expiry look like a
 * working one. The only thing that can take this card off the screen is the one interval
 * the product's lifetime table names, armed by the product's own card view, so a card still
 * painted after the interval plus a margin is a card that was never dismissed at all.
 *
 * The window is the product's one window, already on screen before this journey, so the
 * card appearing here is that same window becoming viewable again - which is why emergence
 * is judged on a map-state transition and not on a window id.
 */
async function runFinishedJourney({ observer, hub, origin, token, workArea, hubPid }) {
  if (origin === null || token === null) {
    return { observations: notServed('finished', FINISHED_ASSERTIONS), records: [], timings: {} }
  }
  const observations = []
  const timings = {}
  const baseline = observer.cardWindowFacts(hubPid)
  const posted = await postSignal(origin, token, {
    harness: 'opencode',
    eventName: 'session.status',
    variant: 'idle',
    sessionId: FINISHED_SESSION,
    repoFullPath: REPO_PATH,
    transitionId: 'verify-turn-1',
    occurredAt: occurredAt(),
    turnWork: { toolCall: true, fileEdit: false, todoUpdate: false },
  })
  const events = await readEvents(origin, FINISHED_SESSION)
  const finished = events.events.filter((event) => event.class === 'finished')
  observations.push(
    observation('finished', FINISHED_ASSERTIONS[0], '1', String(finished.length), {
      ingestStatus: posted.status,
      ingestOutcome: posted.body?.outcome ?? null,
      turnWork: 'toolCall: the turn recorded work, which is the condition the classifier requires for finished',
    }),
  )

  const emerged = await settle(
    CARD_APPEAR_TIMEOUT_MS,
    readCardWindowsNow(observer, baseline.facts, hubPid),
    (reading) => cardOnScreenVerdict(reading.facts, hubPid) === 'painted',
  )
  const immediate = emerged.value ?? { facts: [], emerging: [], rejected: [] }
  timings.cardAppearedMs = emerged.elapsedMs
  observations.push(
    observation('finished', FINISHED_ASSERTIONS[1], 'inside-the-work-area', cardWindowVerdict(immediate.emerging, workArea), {
      workArea,
      waitedMs: emerged.elapsedMs,
      candidates: immediate.emerging,
      rejectedWindows: immediate.rejected,
      cardWasPainted: cardOnScreenVerdict(immediate.facts, hubPid) === 'painted',
    }),
  )

  const waitedAt = Date.now()
  await sleep(FINISHED_EXPIRY_WAIT_MS)
  timings.expiryWaitMs = Date.now() - waitedAt
  const afterwards = readCardWindowsNow(observer, baseline.facts, hubPid)()
  const expiryVerdict = cardOnScreenVerdict(afterwards.facts, hubPid)
  const wasPainted = cardOnScreenVerdict(immediate.facts, hubPid) === 'painted'
  const reportAfterExpiry = hub.latestReport()
  observations.push(
    observation(
      'finished',
      FINISHED_ASSERTIONS[2],
      'expired',
      wasPainted === false
        ? 'not-observed: no card window was ever seen, so it cannot be called expired'
        : expiryVerdict === 'painted'
          ? 'still-present'
          : expiryVerdict === 'unreadable'
            ? 'unreadable: the drawable could not be captured, so nothing can be said about the card'
            : 'expired',
      {
        productIntervalMs: FINISHED_CARD_EXPIRES_IN_MS,
        intervalSource: FINISHED_CARD_EXPIRY_SOURCE,
        waitedMs: FINISHED_EXPIRY_WAIT_MS,
        onScreenVerdict: expiryVerdict,
        cardElementInTheDocument: cardReportVerdict(reportAfterExpiry),
        cardEndReportedByTheCardView: reportAfterExpiry?.ends ?? [],
        acknowledgedDuringTheWait: false,
        dismissedByTheScript: false,
        howItLeft:
          'the product own card view armed the product own one interval for this class and removed the ' +
          'card element when it elapsed. Nothing was acknowledged, nothing was dismissed, and this script ' +
          'has no fallback dismissal that could have hidden an unimplemented expiry',
        windowStateWhenTheCardEnded:
          reportAfterExpiry?.cardEnd?.windowWasVisibleWhenTheCardEnded === true
            ? 'the host window was still visible when the card ended, because nothing in the product takes ' +
              'a window down when a card ends. The harness did, and that gap is a recorded product change'
            : 'the host window was not visible when the card ended',
      },
    ),
  )

  return {
    observations,
    timings,
    records: [
      {
        journey: 'finished',
        eventClass: 'finished',
        ingestOutcome: posted.body?.outcome ?? null,
        finishedEvents: finished.length,
        cardWindowAppeared: immediate.emerging.length > 0,
        cardAppearedAfterMs: emerged.elapsedMs,
        cardRectangles: immediate.emerging.map((window) => ({
          windowId: window.id,
          x: window.x,
          y: window.y,
          width: window.width,
          height: window.height,
          emergedBecause: window.emergedBecause,
          pixels: window.pixels,
        })),
        cardGoneAfterTheInterval: expiryVerdict !== 'painted' && wasPainted,
        cardEndReportedByTheCardView: reportAfterExpiry?.ends ?? [],
        cardEnd: reportAfterExpiry?.cardEnd ?? null,
      },
    ],
  }
}
/**
 * Journey 3: a session that opened, greeted and closed.
 *
 * The anti-noise proof, and the one that matters most. A greeting is an `fyi`, which this
 * product refuses before a card model exists, and a session that goes idle having recorded
 * no work is suppressed by the classifier's turn-work gate. So this journey must produce
 * no event, no window and no card - and it is checked against a reading taken immediately
 * before it, so a card left over from an earlier journey cannot be counted against it and a
 * card from this one cannot hide behind an earlier one.
 */
async function runGreetingJourney({ observer, origin, token, workArea, hubPid }) {
  if (origin === null || token === null) {
    return { observations: notServed('greeting-and-close', GREETING_ASSERTIONS), records: [], timings: {} }
  }
  const observations = []
  const timings = {}
  const baseline = observer.cardWindowFacts(hubPid)
  const pendingBefore = await readPending(origin)
  const eventsBefore = await readEvents(origin, GREETING_SESSION)

  const greeting = await postSignal(origin, token, {
    harness: 'opencode',
    eventName: 'message.updated',
    sessionId: GREETING_SESSION,
    repoFullPath: REPO_PATH,
    transitionId: 'verify-greeting-1',
    occurredAt: occurredAt(),
    measurements: { tokensUsed: 12 },
  })
  const closing = await postSignal(origin, token, {
    harness: 'opencode',
    eventName: 'session.status',
    variant: 'idle',
    sessionId: GREETING_SESSION,
    repoFullPath: REPO_PATH,
    transitionId: 'verify-greeting-close-1',
    occurredAt: occurredAt(),
    turnWork: { toolCall: false, fileEdit: false, todoUpdate: false },
  })
  await sleep(1_500)
  timings.settleWaitMs = 1_500

  const eventsAfter = await readEvents(origin, GREETING_SESSION)
  const pendingAfter = await readPending(origin)
  const created = eventsAfter.events.length - eventsBefore.events.length
  observations.push(
    observation('greeting-and-close', GREETING_ASSERTIONS[0], '0', String(created), {
      greetingStatus: greeting.status,
      greetingOutcome: greeting.body?.outcome ?? null,
      greetingReason: greeting.body?.reason ?? null,
      closingStatus: closing.status,
      closingOutcome: closing.body?.outcome ?? null,
      closingReason: closing.body?.reason ?? null,
      why:
        'a greeting is an fyi, which the class policy refuses before a card model exists, and an idle ' +
        'transition that recorded no work is suppressed by the classifier turn-work gate (ADR-004, NT-FR-02)',
    }),
  )
  observations.push(
    observation('greeting-and-close', GREETING_ASSERTIONS[1], String(pendingBefore.count), String(pendingAfter.count), {
      pendingBefore: pendingBefore.count,
      pendingAfter: pendingAfter.count,
    }),
  )

  const appeared = readCardWindowsNow(observer, baseline.facts, hubPid)()
  observations.push(
    observation('greeting-and-close', GREETING_ASSERTIONS[2], 'none', appeared.emerging.length === 0 ? 'none' : 'a-card-window', {
      baseline: 'the card-window facts read immediately before this journey',
      candidates: appeared.emerging,
      rejectedWindows: appeared.rejected,
    }),
  )

  const stillUp = observer.cardWindowFacts(hubPid)
  const stillUpVerdict = cardOnScreenVerdict(stillUp.facts, hubPid)
  observations.push(
    observation(
      'greeting-and-close',
      GREETING_ASSERTIONS[3],
      'none',
      stillUpVerdict === 'no-card-window' ? 'none' : `a-card-window: ${stillUpVerdict}`,
      {
        why:
          'NT-FR-10: the surface occupies no screen space and draws nothing when no card is showing and ' +
          'nothing is pending, and the host window existing is not the same as the surface being visible',
        pendingCount: pendingAfter.count,
        onScreenVerdict: stillUpVerdict,
        cardShapedWindowsOnTheDesktop: stillUp.cardShapedWindows,
        facts: stillUp.facts,
      },
    ),
  )

  return {
    observations,
    timings,
    records: [
      {
        journey: 'greeting-and-close',
        greetingOutcome: greeting.body?.outcome ?? null,
        greetingReason: greeting.body?.reason ?? null,
        closingOutcome: closing.body?.outcome ?? null,
        closingReason: closing.body?.reason ?? null,
        eventsCreated: created,
        windowsCreated: appeared.emerging.length,
        pendingBefore: pendingBefore.count,
        pendingAfter: pendingAfter.count,
        onScreenVerdictAfterTheJourney: stillUpVerdict,
        workArea,
      },
    ],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Impure: the control window
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The control window, and the proof that this script's observer works.
 *
 * A `xmessage` dialog is opened for a moment and then closed. If the enumeration, the
 * map-state read and the pixel capture cannot find *it*, they cannot be trusted to report
 * that a card did not appear - and "the observer is broken" and "the product drew nothing"
 * would otherwise be the same run. The control is therefore an assertion, not a
 * diagnostic.
 */
async function runObserverControl(observer) {
  const startedAt = Date.now()
  const before = observer.listWindows()
  const child = spawn(observer.tools.xmessage, ['-geometry', '360x160+120+120', '-buttons', '', 'agent-ping observer control'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const childOutput = []
  child.stdout.on('data', (chunk) => childOutput.push(String(chunk)))
  child.stderr.on('data', (chunk) => childOutput.push(String(chunk)))
  let spawnError = null
  child.on('error', (cause) => {
    spawnError = cause.message
  })
  const diagnostics = { windowsBefore: before.windows.length, listError: before.error, spawnError, childOutput: '' }
  try {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await sleep(250)
      const listing = observer.listWindows()
      for (const id of appearedWindowIds(before.windows, listing.windows)) {
        const { detail } = observer.detail(id)
        if (detail.mapState !== 'IsViewable') continue
        const { capture } = observer.capture(id)
        return {
          found: { windowId: id, mapState: detail.mapState, width: detail.width, height: detail.height, pixels: capture },
          diagnostics: { ...diagnostics, windowsAfter: listing.windows.length, listErrorAfter: listing.error, childOutput: childOutput.join('') },
          elapsedMs: Date.now() - startedAt,
        }
      }
    }
    const listing = observer.listWindows()
    return {
      found: null,
      diagnostics: { ...diagnostics, windowsAfter: listing.windows.length, listErrorAfter: listing.error, childOutput: childOutput.join('') },
      elapsedMs: Date.now() - startedAt,
    }
  } finally {
    child.kill('SIGTERM')
    await sleep(250)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Impure: the artefact and the summary
// ─────────────────────────────────────────────────────────────────────────────

function writeEvidence(outPath, evidence) {
  const absolute = path.isAbsolute(outPath) ? outPath : path.join(repoRoot, outPath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, `${JSON.stringify(scrubHomePaths(evidence), null, 2)}\n`)
  return absolute
}

const emitSummary = (summary) => process.stdout.write(`${JSON.stringify(scrubHomePaths(summary), null, 2)}\n`)

/**
 * The product changes this run found, recorded rather than applied.
 *
 * Each one names what the product has to do, what was observed on the running system, and
 * - because this run completed the gap itself so that the card machinery could be observed
 * - exactly what this script supplied in its place. `suppliedByThisRun` is never empty for
 * the three gaps the harness completes, and saying so here is what keeps the evidence file
 * from reading as though the product had shipped them (APX-FR-02, ADR-010).
 */
function requiredProductChanges({ evidence, childLineCount = 0, chromiumLineCount = 0, shipped = null }) {
  const changes = []
  const delivery = evidence?.delivery ?? null
  const shippedDelivery = shipped?.delivery ?? null
  if (evidence?.repository?.cardDocumentPresent === false) {
    changes.push({
      id: 'card-document-entry',
      owner: 'dashboard-engineer',
      required:
        'src/dashboard/card.html as a second entry in the dashboard Vite build, so GET /card.html serves a card document in the shipped artefacts, and a stylesheet that draws the attributes src/notify/surface/card-view.ts writes',
      observed:
        'the shipped build serves no card document: dist/dashboard/card.html does not exist, GET /card.html answers 404, and src/notify/surface/electron-host.ts refuses to show a card whose document will not load (document-unavailable). A window showing a Chromium error page is not a card (APX-FR-02)',
      suppliedByThisRun:
        'a run-time card document, a stylesheet and a module entry, written into a copy of the built dashboard. The card those two files show is mounted by the product own compiled card view, copied byte for byte out of dist/main/notify/surface/; the document is this script and the stylesheet is this script, because the product has neither',
    })
  }
  if (shippedDelivery !== null && shippedDelivery.wired === false) {
    changes.push({
      id: 'card-renderer-channel',
      owner: 'notification-engineer with dashboard-engineer',
      required:
        'a DesktopBridge.renderCard presenter on the shipped Electron bridge, and the main-to-renderer channel that carries a card model into a document running with contextIsolation, no nodeIntegration and sandbox: true. A preload with a context bridge, or a loopback route the document polls, are the two shapes that do not weaken the renderer; this run used neither, because choosing one is a decision about NT-6 own Electron surface',
      observed:
        'src/main/index.ts electronSurfaceBridge deliberately supplies no renderer, so resolveSurfaceNotifier answers no-card-renderer, the delivery policy is not wired, and every delivery on the shipped entry point is recorded not-wired with nothing delivered. The product own tests assert exactly this state',
      suppliedByThisRun:
        'a presenter on the run own DesktopBridge, carrying the model with webContents.executeJavaScript into the product own card view running in the product own window. The renderer options were not touched: contextIsolation, nodeIntegration and sandbox came from the product own frozen SURFACE_WINDOW_OPTIONS',
    })
  }
  changes.push({
    id: 'acknowledgement-does-not-reach-the-card',
    owner: 'hub-engineer',
    required:
      'a notifier hook on POST /api/ack/:eventId, so the card surface is told a block was acknowledged and the card can be removed with the end `acknowledged` its own lifetime cell names',
    observed:
      'the lifetime table names `acknowledged` as an end and the card view removes on it, but no path calls it during a run. On the shipped entry point a needs-you card would leave the screen only when its window was destroyed at shutdown',
    suppliedByThisRun:
      'the harness watches the hub own pending accessor and calls the card view own remove("acknowledged") - a product method on a product object - as soon as the acknowledged item is gone from the pending set',
  })
  changes.push({
    id: 'nothing-takes-the-window-down-when-a-card-ends',
    owner: 'notification-engineer with hub-engineer',
    required:
      'the card view own end must reach the host, so host.hide() runs when a card ends. NT-FR-10 promises the surface occupies no screen space and draws nothing when no card is showing, and a mapped transparent window that nothing takes down is neither',
    observed:
      'this run watched the host window at the moment a finished card expired: it was still mapped and visible, and its own drawable was empty. An empty mapped rectangle is not a card and nothing is painted, so the card itself had gone - but the window outliving its card is a real gap and it is why the run had to complete it',
    suppliedByThisRun:
      'the harness calls the product own host hide() only after the product own card view reported an end that the product own lifetime cell names, and only for the ends a cell lists. Nothing in this script takes a window down for any other reason',
  })
  changes.push({
    id: 'not-wired-diagnostic-has-no-destination',
    owner: 'hub-engineer',
    required: 'startElectronMain should pass an onDiagnostic that writes to stderr, so the not-wired reason reaches the operator',
    observed:
      `this run captured the shipped entry point stdout and stderr across its whole life. ` +
      `${String(childLineCount)} of those lines were written by this product, and ` +
      `${String(chromiumLineCount)} by the Electron runtime tearing itself down (zygote, network service and ` +
      'GPU), which this script separates by the shape of the line rather than counting as a diagnostic. ' +
      'startHub defaults onDiagnostic to a no-op and the Electron entry point supplies none, so the reason a run ' +
      'can show no card is never reported anywhere by the product itself (APX-FR-02, ADR-010)',
    suppliedByThisRun:
      'none on the shipped entry point. The run-time harness passes an onDiagnostic that writes to stderr, which is why its own line count is not zero and the shipped one is',
  })
  changes.push({
    id: 'tray-is-not-observable-outside-the-process',
    owner: 'notification-engineer',
    required:
      'a way for a verification run to observe the tray: a diagnostic on mount, or the badge number through a route that already exists',
    observed:
      'an Electron Tray is a StatusNotifierItem and not an X window, so this run could not see whether the icon mounted or what number it carried. The badge number was read from GET /api/pending, which is the accessor the badge itself reads',
    suppliedByThisRun: 'none',
  })
  if (delivery !== null || shippedDelivery !== null) {
    changes.push({
      id: 'the-durable-schema-is-not-in-the-build',
      owner: 'tooling-engineer, with packaging-engineer for the package allowlist',
      required:
        'a copy step in scripts/build.mjs for src/storage/schema.sql, and dist/main/storage/schema.sql in the package files allowlist',
      observed:
        'the tsc build emits JavaScript only, so a hub started from the build cannot find its schema and refuses to open its log. This run has to copy the file by hand before it can start anything at all',
      suppliedByThisRun: 'none: the remedy is a command in the preflight, and it is the preflight and the runbook that say so',
    })
  }
  return changes
}

// ─────────────────────────────────────────────────────────────────────────────
// Impure: environment readers
// ─────────────────────────────────────────────────────────────────────────────

function readElectronVersion() {
  const file = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'version')
  if (!existsSync(file)) return null
  const version = readFileSync(file, 'utf8').trim()
  return version === '' ? null : version
}

function readWindowManager(tools) {
  const result = runTool(tools.xprop, ['-root', '_NET_SUPPORTING_WM_CHECK'])
  if (!result.ok) return null
  const id = /window id # (0x[0-9a-fA-F]+)/.exec(result.stdout)
  return id === null ? null : id[1]
}

function readPrimaryDisplays(tools) {
  const result = runTool(tools.xrandr, ['--query'])
  if (!result.ok) return []
  const displays = []
  for (const line of result.stdout.split('\n')) {
    const match = /^(e?\S+) connected( primary)? (\d+)x(\d+)\+(-?\d+)\+(-?\d+)/.exec(line)
    if (match === null) continue
    displays.push({
      name: match[1],
      primary: match[2] !== undefined,
      width: Number(match[3]),
      height: Number(match[4]),
      x: Number(match[5]),
      y: Number(match[6]),
    })
  }
  return displays
}

/**
 * The launch policy, measured rather than assumed.
 *
 * Chromium decides about the process sandbox before any JavaScript in this package runs,
 * so the cheapest demonstration that the policy is load-bearing is to run the binary twice:
 * once with the environment form the product documents, and once with it deliberately
 * absent. The second run is expected to fail with the setuid-sandbox FATAL, and that
 * expectation is what PRD 16 Open Question 13 records.
 */
function measureLaunchPolicy(electronBinary) {
  const withPolicy = runTool(electronBinary, ['--version'], {
    timeoutMs: 20_000,
    env: { ...process.env, ...CHROMIUM_LAUNCH_ENVIRONMENT },
  })
  const without = runTool(electronBinary, ['--version'], {
    timeoutMs: 20_000,
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: undefined },
  })
  return {
    source: 'src/notify/surface/electron-host.ts CHROMIUM_LAUNCH_ENVIRONMENT and CHROMIUM_LAUNCH_POLICY',
    environment: CHROMIUM_LAUNCH_ENVIRONMENT,
    electronVersionReported: withPolicy.ok ? String(withPolicy.stdout).trim() : null,
    electronVersionFromDistFile: readElectronVersion(),
    withThePolicy: { ok: withPolicy.ok, exit: withPolicy.status, signal: withPolicy.signal },
    withoutThePolicy: {
      ok: without.ok,
      exit: without.status,
      signal: without.signal,
      firstStderrLine: without.stderr.split('\n').find((line) => line.trim() !== '') ?? null,
    },
    why:
      'Chromium reads its command line and decides about the sandbox before any JavaScript in this ' +
      'package runs, so the switch has to reach the process rather than be appended from here. This run ' +
      'measured both halves (PRD 16 Open Question 13)',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────

async function waitForServing(stateDir, hub) {
  const started = Date.now()
  let lastReason = 'the runtime file never appeared'
  while (Date.now() - started < HUB_READY_TIMEOUT_MS) {
    if (hub.child.exitCode !== null || hub.child.signalCode !== null) {
      return {
        ready: false,
        record: null,
        origin: null,
        elapsedMs: Date.now() - started,
        reason:
          `the Electron process exited with code ${String(hub.child.exitCode)} before publishing a runtime ` +
          'file. On a developer machine the usual cause is a second agent-ping application already holding ' +
          "the Electron single-instance lock: close it and re-run. The child's own lines are in the evidence file",
      }
    }
    const record = readRuntimeFile(stateDir)
    if (record !== null) {
      const origin = `http://${record.host}:${record.port}`
      const health = await readHealth(origin)
      if (health.ok) return { ready: true, record, origin, elapsedMs: Date.now() - started, reason: null }
      lastReason = `the runtime file exists but GET /api/health answered ${String(health.status)}`
    }
    await sleep(200)
  }
  return { ready: false, record: null, origin: null, elapsedMs: Date.now() - started, reason: lastReason }
}

/**
 * What the product does on this machine today, as shipped.
 *
 * A second Electron process, the shipped entry point, started and read from the outside and
 * then stopped. It is a *record*, not an assertion, and the difference is deliberate: a
 * shipped build that grew a card document or a renderer channel tomorrow would make a
 * passing assertion here a false alarm, and the runbook would be the stale artefact
 * instead. What this section answers is "what does a developer's machine get today", which
 * is the question NT-9 was also told to record rather than change.
 *
 * It runs before the harness so the two never overlap: a second Electron process owning a
 * card-sized window on the same display would be indistinguishable from the hub's own.
 */
async function observeShippedPosture({ pre, stateDir }) {
  const child = launchHub({ electronBinary: pre.electronBinary, stateDir, entryPoint: BUILT_ENTRY_POINT })
  const record = {
    entryPoint: BUILT_ENTRY_POINT,
    question:
      'what does the product as shipped do on this display today: can it show a card at all?',
    asserted: false,
    why:
      'a record and not an assertion. A shipped build that grew a card document or a renderer channel ' +
      'would make a passing assertion here a false alarm, and the runbook would be the stale artefact. It ' +
      'also runs against a state directory of its own, so a block stored here cannot be replayed into the ' +
      'journeys and put a card on the screen before the first journey has taken its baseline',
    startedAt: nowIso(),
    readyMs: null,
    delivery: null,
    cardDocument: { path: '/card.html', status: null },
    toastDeliveries: null,
    pendingAfterARealBlock: null,
    cardWindowOnTheDisplay: null,
    diagnosticLines: [],
    productDiagnosticLines: [],
    chromiumDiagnosticLines: [],
    productDiagnosticCount: null,
    chromiumDiagnosticCount: null,
    diagnosticLinesNote:
      "the two populations are kept apart because one finding is about whether this product's own " +
      'diagnostic reaches an operator, and a count that included Chromium teardown noise would answer a ' +
      'different question. Chromium writes its GPU and zygote lines while a process is being stopped on this ' +
      'desktop, so a nonzero chromium count beside a zero product count is the expected reading for a healthy ' +
      'hub and is not a fault',
    stopped: null,
  }
  try {
    const ready = await waitForServing(stateDir, child)
    record.readyMs = ready.elapsedMs
    if (ready.ready) {
      const health = (await readHealth(ready.origin)).health
      record.delivery = health?.delivery ?? null
      const document = await request(`${ready.origin}/card.html`)
      record.cardDocument.status = document.status
      const token = readWriteToken(stateDir)
      if (token !== null) {
        await postSignal(ready.origin, token, {
          harness: 'opencode',
          eventName: 'permission.asked',
          sessionId: BLOCK_SESSION,
          repoFullPath: REPO_PATH,
          transitionId: 'verify-shipped-block',
          occurredAt: occurredAt(),
        })
        record.pendingAfterARealBlock = (await readPending(ready.origin)).count
        const metrics = await readMetrics(ready.origin)
        record.toastDeliveries = metrics.toast_deliveries ?? null
        // The shipped bridge creates its window from hub start, with show: false, and
        // nothing ever asks it to show: so the display must have no viewable card window
        // at all, and the drawable of the window it does own must be empty.
        const facts = observerOf(pre).cardWindowFacts(ready.record.pid).facts
        record.cardWindowOnTheDisplay = cardOnScreenVerdict(facts, ready.record.pid)
        record.cardWindowFacts = facts
      }
    } else {
      record.reason = ready.reason
    }
  } finally {
    record.stopped = await child.stop()
    record.finishedAt = nowIso()
    record.diagnosticLines = [...child.stderr, ...child.stdout]
    const split = splitChildDiagnostics(record.diagnosticLines)
    record.productDiagnosticLines = split.product
    record.chromiumDiagnosticLines = split.chromium
    record.productDiagnosticCount = split.productCount
    record.chromiumDiagnosticCount = split.chromiumCount
  }
  return record
}

/** One observer, for the shipped probe, from the same tools every other reading uses. */
const observerOf = (pre) => new DesktopObserver(pre.tools)

async function run({ pre, stateDir, probeStateDir, harnessRoot }) {
  const startedAt = nowIso()
  const observations = []
  const observer = new DesktopObserver(pre.tools)
  const desktop = pre.workArea

  // Started before anything is started, because the only thing worth counting is what the
  // bus carried while the product was delivering.
  const centre = startNotificationMonitor({ dbusMonitor: pre.tools.dbusMonitor, notifySend: pre.tools.notifySend })

  const control = await runObserverControl(observer)
  observations.push(
    observation(
      'observer',
      OPENING_ASSERTIONS[0],
      'found-and-painted',
      control.found === null
        ? 'not-found: the control window could not be enumerated, so this run cannot report that no card appeared'
        : control.found.pixels?.ok === true && (control.found.pixels.distinctValues ?? 0) > 1
          ? 'found-and-painted'
          : `found-but-blank: ${String(control.found.pixels?.reason ?? 'fewer than two distinct pixel values')}`,
      control.found === null
        ? { controlWindow: null, why: 'no viewable window appeared in the tree during the control interval', diagnostics: control.diagnostics }
        : { controlWindow: { windowId: control.found.windowId, mapState: control.found.mapState, width: control.found.width, height: control.found.height, pixels: control.found.pixels }, diagnostics: control.diagnostics },
    ),
  )

  // The shipped build first, on its own, and stopped before the harness starts: what a
  // developer's machine gets today, recorded rather than asserted.
  const shipped = await observeShippedPosture({ pre, stateDir: probeStateDir })

  const harness = prepareHarness(harnessRoot)
  const hub = launchChild({
    electronBinary: pre.electronBinary,
    stateDir,
    entryPoint: harness.mainPath,
    env: { AGENT_PING_SURFACE_DASHBOARD_ROOT: harness.dashboardRoot },
  })
  const evidence = {
    taskId: 'NT-9',
    evidenceVersion: EVIDENCE_VERSION,
    script: SCRIPT_NAME,
    producedBy: SCRIPT_PATH,
    startedAt,
    finishedAt: null,
    finding: null,
    observer: control,
    repository: {
      builtEntryPoint: BUILT_ENTRY_POINT,
      builtDashboard: 'dist/dashboard',
      cardDocumentPresent: existsSync(path.join(repoRoot, 'dist', 'dashboard', 'card.html')),
      cardDocumentSource: 'src/dashboard/card.html, a second entry in the dashboard Vite build',
      stateDirUsed: 'a fresh temporary directory per run, so this run cannot touch a real installation',
    },
    harness: {
      whatThisIs:
        'the run-time harness that completes the three seams the product has not built, and only those. ' +
        'The card itself - its words, its attributes, its accessible name, its lifetime, its expiry and its ' +
        'removal - is the product own compiled code, imported from the build and served to the document by ' +
        'the hub itself (NT-FR-02, NT-FR-08, APX-FR-01)',
      seams: [
        {
          seam: 'the card document',
          productState: 'src/dashboard/card.html does not exist and the dashboard build has one entry, so GET /card.html is a 404 on the shipped build',
          suppliedHere: 'a run-time document, its stylesheet and its module entry, in a copy of the built dashboard',
          productCodeUsed: BUILT_CARD_MODULES,
        },
        {
          seam: 'the main-to-renderer channel',
          productState:
            'the shipped bridge supplies no DesktopBridge.renderCard, and the renderer has contextIsolation, no nodeIntegration and sandbox: true with no preload, so nothing can carry a card model into a document',
          suppliedHere: 'webContents.executeJavaScript on the product own BrowserWindow, which the harness holds only by wrapping the class so the instance can be reached',
          productCodeUsed: ['src/notify/surface/electron-host.ts SURFACE_WINDOW_OPTIONS, unchanged'],
        },
        {
          seam: 'the acknowledgement signal',
          productState: 'POST /api/ack/:eventId has no notifier hook, and nothing takes the window down when a card ends',
          suppliedHere:
            'the hub own pending accessor watched by the harness, which then calls the product own card view remove("acknowledged") and the product own host hide() - and only after the product own card view has reported an end the product own lifetime cell names',
          productCodeUsed: ['src/notify/surface/card-view.ts remove', 'src/notify/surface/electron-host.ts hide'],
        },
      ],
      manifest: harness.manifest,
      dashboardRoot: 'this run own directory, never the checkout',
    },
    shippedPosture: shipped,
    machine: {
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
      launchPolicy: measureLaunchPolicy(pre.electronBinary),
      display: {
        DISPLAY: pre.display,
        XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE ?? null,
        windowManager: readWindowManager(pre.tools),
        advertisedWorkArea: desktop.workArea,
        advertisedWorkAreaRectangles: desktop.rectangles,
        primaryDisplays: readPrimaryDisplays(pre.tools),
        note:
          'the work area is the display server own answer through _NET_WORKAREA, not the product, so the ' +
          'placement check is against the desktop rather than against the arithmetic under test',
      },
    },
    journeys: [],
    timings: {},
    delivery: null,
    badge: null,
    tray: null,
    cardReports: [],
    childDiagnostics: null,
    notificationCentre: null,
    requiredProductChanges: [],
    notVerified: [
      'anything at all about macOS or Windows: this run happened on one Linux desktop and no statement in this file is evidence about another platform (APX-CON-06)',
      'whether the card text is legible at its real size: the pixel capture measures painted content and cannot read a word, and the stylesheet that drew the card in this run is the harness own, so legibility remains a manual per-platform step with the product own stylesheet',
      'whether showInactive left the keyboard focus alone: the X server exposes no focus reading for a card window on this desktop, so this run observed visibility and not focus (NT-FR-04)',
      'whether a pointer can reach the card: the surface is click-through until a pointer arrives, and no synthetic pointer was moved',
      'whether the click-through switch and the release both work: they are asserted against this product own host interface in tests/notify/surface-host.test.ts, and no pointer was moved here',
      'whether the tray icon mounted and what number it carried: an Electron Tray is a StatusNotifierItem, not an X window. The number was read through the accessor the badge reads',
      'that the product as shipped can show a card: it cannot, and shippedPosture is the record of that. The journeys were driven through the run-time harness described in the harness section',
    ],
  }

  try {
    const ready = await waitForServing(stateDir, hub)
    evidence.timings.hubReadyMs = ready.elapsedMs
    observations.push(
      observation('hub', OPENING_ASSERTIONS[1], 'serving', ready.ready ? 'serving' : `not-serving: ${ready.reason}`, ready.record === null ? null : { host: ready.record.host, port: ready.record.port, pid: ready.record.pid }),
    )
    observations.push(
      observation(
        'hub',
        OPENING_ASSERTIONS[2],
        'runtime-file-read',
        ready.record === null ? 'no-runtime-file' : 'runtime-file-read',
        {
          why:
            '43117 is a first-candidate preference and is not necessarily the bound port (HC-FR-01), so the ' +
            'port is read from hub-runtime.json in this run own temporary state directory and never assumed',
        },
      ),
    )

    const token = ready.ready ? readWriteToken(stateDir) : null
    const origin = ready.origin
    const hubPid = ready.record?.pid ?? null
    const journeyInput = { observer, hub, origin, token, workArea: desktop.workArea, hubPid }

    for (const [name, journey] of [
      ['needs-you', runNeedsYouJourney],
      ['finished', runFinishedJourney],
      ['greeting-and-close', runGreetingJourney],
    ]) {
      const journeyStartedAt = nowIso()
      const journeyStarted = Date.now()
      const result = await journey(journeyInput)
      const elapsedMs = Date.now() - journeyStarted
      observations.push(...result.observations)
      evidence.timings[name] = { ...result.timings, startedAt: journeyStartedAt, finishedAt: nowIso(), elapsedMs }
      evidence.journeys.push(...result.records)
    }

    const finalHealth = origin === null ? null : (await readHealth(origin)).health
    const finalPending = origin === null ? null : await readPending(origin)
    const metrics = origin === null ? null : await readMetrics(origin)
    evidence.delivery = finalHealth?.delivery ?? null
    evidence.cardReports = hub.reports.map((report) => ({
      seq: report.seq,
      at: report.at,
      showsCard: report.showing === true,
      ends: Array.isArray(report.ends) ? report.ends : [],
      cardElement: report.element === undefined ? null : report.element,
      cardEnd: report.cardEnd ?? null,
      harnessStarted: report.harness ?? null,
      endState: report.endState ?? null,
      ackState: report.ackState ?? null,
      presented: report.presented ?? null,
      ackRemovals: report.ackRemovals ?? null,
      error: report.error ?? null,
    }))
    evidence.badge = {
      source: 'GET /api/pending, the same accessor the tray badge reads (src/hub/tray.ts)',
      finalPendingCount: finalPending?.count ?? null,
      toastDeliveriesCounter: metrics?.toast_deliveries ?? null,
      allCounters: metrics,
      note:
        'a StatusNotifierItem is not an X window, so the icon itself was not observable from outside the ' +
        'process. The number on it was read from the accessor the badge reads, which is the honest substitute ' +
        'and the one tests/hub/tray.test.ts asserts against',
    }
    evidence.tray = {
      observableFromOutside: false,
      why:
        'an Electron Tray is a StatusNotifierItem and not an X window, so this run could not observe whether ' +
        'the icon mounted or what it carried',
    }
  } finally {
    evidence.harnessStopped = await hub.stop()
    evidence.childDiagnostics = {
      stdoutLines: hub.stdout.filter((line) => !line.startsWith(CARD_REPORT_PREFIX)),
      stderrLines: hub.stderr,
      note:
        'bounded at 200 lines each, and the harness own card-report lines are kept out of them and recorded ' +
        'under cardReports instead. The shipped entry point, by contrast, passes no onDiagnostic into ' +
        'startHub, so its own not-wired reason is written nowhere - see shippedPosture',
    }
    centre.sealDuring()
    await centre.runPositiveControl()
    evidence.notificationCentre = centre.record
  }

  evidence.finishedAt = nowIso()
  evidence.timings.totalMs = Date.parse(evidence.finishedAt) - Date.parse(evidence.startedAt)
  evidence.timings.observerControlMs = control.elapsedMs ?? null
  evidence.requiredProductChanges = requiredProductChanges({
    evidence,
    shipped,
    childLineCount: shipped.productDiagnosticCount ?? 0,
    chromiumLineCount: shipped.chromiumDiagnosticCount ?? 0,
  })

  const decision = decide(observations, { assertionsExpected: ASSERTIONS_EXPECTED, dependencies: pre.dependencies })
  // The verdict travels with the evidence rather than only on stdout: a later reader must
  // be able to see whether this capture passed without re-running the script against a
  // desktop that has since changed underneath it.
  evidence.verdict = decision.verdict
  evidence.assertionsExpected = decision.assertionsExpected
  evidence.assertionsRun = decision.assertionsRun
  evidence.assertions = decision.assertions
  evidence.failures = decision.failures
  evidence.missingDependencies = decision.missingDependencies
  evidence.finding =
    decision.verdict === 'pass'
      ? 'a real card was drawn into a real window inside the display work area, held while its block was ' +
        'outstanding, and left the screen under this product own rules; the journeys were driven through the ' +
        'run-time harness, and shippedPosture records that the product as shipped still cannot show a card ' +
        'without it. See harness, assertions, journeys and requiredProductChanges'
      : `the run exercised every assertion and ${String(decision.failures.length)} did not hold. The reasons ` +
        'are in failures and requiredProductChanges, and none of them was worked around'
  return { decision, evidence, dependencies: pre.dependencies }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`)
    return error.code ?? 2
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const pre = preflight()
  if (pre.dependencies.some((dependency) => dependency.present !== true)) {
    const decision = decide([], { assertionsExpected: ASSERTIONS_EXPECTED, dependencies: pre.dependencies })
    emitSummary({
      script: SCRIPT_NAME,
      verdict: 'fail',
      exitCode: 3,
      startedAt: nowIso(),
      finishedAt: nowIso(),
      assertionsRun: 0,
      assertionsExpected: ASSERTIONS_EXPECTED,
      assertions: [],
      failures: decision.failures,
      dependencies: pre.dependencies,
      evidence: args.out,
      evidenceWritten: false,
      why: 'no evidence file is written for an absent dependency: a report that says nothing was there is indistinguishable from a report that says nothing was looked for',
    })
    return 3
  }

  // A fresh state directory per run, in the OS temporary area, owner-only. The product
  // resolves it from AGENT_PING_STATE_DIR, so this run cannot touch a developer's real
  // log, token or runtime file, and a leftover directory from a failed run cannot turn the
  // next run into a false failure. Removed in the `finally` below, on the failure path
  // too.
  //
  // The harness root is a sibling of it and holds the run-time card document and the
  // Electron main that starts the hub. Also temporary, also removed: nothing this run
  // writes lands in the checkout, so a card document written by one run cannot be served
  // by the next one or mistaken for a product artefact.
  const stateDir = path.join(tmpdir(), `agent-ping-surface-verify-${process.pid}-${Date.now()}`)
  const probeStateDir = `${stateDir}-shipped`
  const harnessRoot = `${stateDir}-harness`
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  mkdirSync(probeStateDir, { recursive: true, mode: 0o700 })

  let result
  try {
    result = await run({ pre, stateDir, probeStateDir, harnessRoot })
  } catch (cause) {
    process.stderr.write(`[${SCRIPT_NAME}] the run itself failed: ${cause?.stack ?? cause}\n`)
    emitSummary({
      script: SCRIPT_NAME,
      verdict: 'fail',
      exitCode: 1,
      startedAt: nowIso(),
      finishedAt: nowIso(),
      assertionsRun: 0,
      assertionsExpected: ASSERTIONS_EXPECTED,
      assertions: [],
      failures: [`the run threw before any assertion could be reported: ${cause?.message ?? String(cause)}`],
      evidence: args.out,
      evidenceWritten: false,
    })
    return 1
  } finally {
    if (args.keepState) log(`temporary state kept at ${stateDir}, ${probeStateDir} and ${harnessRoot}`)
    else {
      rmSync(stateDir, { recursive: true, force: true })
      rmSync(probeStateDir, { recursive: true, force: true })
      rmSync(harnessRoot, { recursive: true, force: true })
    }
  }

  const { decision, evidence, dependencies } = result
  const artifact = writeEvidence(args.out, evidence)
  emitSummary({
    script: SCRIPT_NAME,
    verdict: decision.verdict,
    exitCode: decision.exitCode,
    startedAt: evidence.startedAt,
    finishedAt: evidence.finishedAt,
    platform: evidence.machine.platform,
    node: evidence.machine.node,
    electron: evidence.machine.launchPolicy.electronVersionReported,
    display: evidence.machine.display,
    dependencies,
    shippedPosture: {
      delivery: evidence.shippedPosture?.delivery ?? null,
      cardDocumentStatus: evidence.shippedPosture?.cardDocument?.status ?? null,
    },
    assertionsRun: decision.assertionsRun,
    assertionsExpected: decision.assertionsExpected,
    assertions: decision.assertions,
    failures: decision.failures,
    evidence: args.out,
    evidenceWritten: true,
  })
  log(`evidence written to ${artifact}`)
  for (const failure of decision.failures) log(`FAIL ${failure}`)
  return decision.exitCode
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) process.exit(await main(process.argv.slice(2)))

export {
  main,
  requiredProductChanges,
  DesktopObserver,
  preflight,
  run,
  launchHub,
  launchChild,
  readRuntimeFile,
  prepareHarness,
}
