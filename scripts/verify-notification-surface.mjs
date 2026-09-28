#!/usr/bin/env node
// Prove the notification card on the running system (NS-4: NT-FR-02, NT-FR-04, NT-FR-08,
// NT-FR-10, NT-FR-12, APX-CON-06, APX-CON-12, APX-FR-01, APX-FR-02, PRD 16 Open
// Questions 13 and 14).
//
//   node scripts/verify-notification-surface.mjs
//   node scripts/verify-notification-surface.mjs --out docs/reviews/notification-surface-evidence.json
//
// THE CLAIM, IN THREE SENTENCES, BEFORE ANY CODE
//
//   positive   A real needs-you event, driven over the real loopback socket into the
//              product's SHIPPED built entry point running as a real Electron main
//              process on a real display, puts a real window on that display holding
//              real painted content positioned inside the display's work area; the card
//              is still there after a wait; acknowledging the item through the product's
//              own write route takes it off the screen and lowers the badge's own
//              number. A real finished event's card leaves the screen on its own fixed
//              interval with nothing dismissing it.
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
// check that passes when the product is broken.
//
// WHAT IS THE PRODUCT'S AND WHAT IS THIS SCRIPT'S - READ THIS BEFORE THE EVIDENCE FILE
// The product as shipped draws its own card. There is no run-time harness, no
// substituted document, no substituted stylesheet, no substituted entry module and no
// substituted renderer bridge anywhere in this file, and there is no second Electron
// main process: the one process this run starts is the product's own built entry point
// at `dist/main/main/index.js`, started with the product's own state directory override
// and nothing else, and the card document it loads is `dist/dashboard/card.html` served
// by the product's own static route. This is the change from NT-9, which had to supply
// all three of those itself and therefore could only report what the product as shipped
// did. NS-1 built and served the card document, NS-2 opened the renderer channel and
// wired the card presenter, and NS-3 took the card down when its block ends, so the
// withheld assertion became real and is now asserted.
//
// Three things follow from that, and each one costs this script a claim it used to make:
//
//   1. The card's *contents* are no longer observable from outside the process. Reading a
//      renderer from here would mean injecting code into it, and the shape this run
//      exists to prove is that the product does not have to do that. So the evidence
//      file no longer claims to have read the card's element tree, its attributes, its
//      accessible name or its live-region role: `notVerified` names those, and says which
//      suites hold them instead.
//   2. What replaces that reading is stronger than a report from inside the process. The
//      observer reads the product's own BUILT stylesheet for the fill it paints a card of
//      each class with, and then asks the compositor whether that colour is on the screen.
//      The pixels cannot come from anywhere else now, because there is nowhere else in
//      this run for them to come from, and the comparison tells the two classes apart -
//      which the old "painted" reading could not.
//   3. The renderer options are recorded, not observed. `contextIsolation`,
//      `nodeIntegration`, `sandbox` and `webSecurity` are read out of the built artefact
//      and attributed to the suite that asserts them, because a run outside the process
//      cannot read the live window's options and must not pretend to.
//
// Everything else is the product's, unmodified and unstubbed: the real built entry point,
// the real loopback server and every real route, the real ingest classifier, the real
// class policy, the real card model, the real surface host with the real
// `SURFACE_WINDOW_OPTIONS`, the real preload, the real placement arithmetic, the real
// lifetime table, the real card view, the real card channel and the real delivery policy
// and its ledger.
//
// SIX PROPERTIES THIS SCRIPT MUST NEVER LOSE
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
//      generates, class names, counts, rectangles, colours, timings, versions and closed
//      reason tokens. Card *words* are not recorded anywhere - not even a length, because
//      this run no longer reads the document - and it records no prompt, no tool name, no
//      diff, no D-Bus payload, and no absolute path from the developer's machine
//      (APX-FR-01).
//   6. This run supplies no part of the card path, and that is enforced rather than
//      promised. The only file it writes is the evidence file, the only artefact it
//      starts is the product's own built entry point, and
//      tests/scripts/verify-notification-surface.test.ts reads this file's own source and
//      fails on the four implementations NT-9 used to substitute. A green result cannot
//      mean the run did the work again (NT-FR-12).
//
// SHAPE, PER THE LIVE-VERIFICATION DISCIPLINE
//
//   scripts/verify-notification-surface.mjs              pure parsing and judgement,
//                                                         exported, plus a thin shell
//                                                         that owns every side effect
//   tests/scripts/verify-notification-surface.test.ts    drives `decide`, every parser
//                                                         and every verdict with injected
//                                                         values, so the judgement and
//                                                         every parse are verified with
//                                                         no display and no Electron
//
// WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
// It does not touch a file under src/ or under dist/. It does not write a document, a
// stylesheet, an entry module or a dashboard root for the product to serve, and it does
// not point the hub at a root of its own. It does not re-arm a card, acknowledge
// anything it was not asked to, or fall back to dismissing a card that failed to expire.
// It does not call a platform notification tool, and the one `notify-send` it ever runs is
// the positive control for the notification-centre instrument, after the journeys. It
// does not claim the card is legible or that a word was read: the pixel capture measures
// painted values and reads no text. And it does not report a card it never saw as gone.
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
export const EVIDENCE_VERSION = 3
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

/**
 * How far, per channel, the compositor's own value may sit from the product's own
 * stylesheet value and still be called the product's colour.
 *
 * A tolerance, and a measured one rather than a guessed one. On this machine the
 * desktop's colour management moved the product's `--card-block-fill: #3a1f24` to
 * (62, 24, 35) and its `--card-finished-fill: #1b2b24` to (21, 46, 36) once each had
 * finished arriving - errors of 7 and 6 per channel - while the two fills are 35 apart
 * in red from each other. So a tolerance of 12 separates a card of each class from the
 * other class, from the product's default fill, from a page background and from a blank
 * window, with room to spare on this desktop, and every reading records the actual
 * distance rather than only the verdict (APX-CON-06: a per-platform difference is
 * documented, not asserted).
 */
export const CARD_FILL_TOLERANCE = 12

/**
 * How many consecutive identical readings count as a settled paint, and how long the run
 * will wait for them.
 *
 * This is not politeness about the capture. A card arrives with an animation the product
 * owns (`data-motion-state-arrival` in src/notify/surface/card-view.ts, and the transition
 * it drives in src/dashboard/card.css), and a capture taken while the card is still
 * arriving reads a colour blended part way between the fill and nothing: on this machine
 * the finished card measured 13 per channel from its own fill mid-flight against 6 at
 * rest, which is outside the tolerance above. So the run waits for the window's own
 * drawable to stop changing and only then compares, and a paint that never settles within
 * the deadline is compared anyway and fails - a card that is still moving is not a card at
 * rest, and this run does not get to decide which moment of one is the real one.
 */
export const CARD_PAINT_STABLE_READS = 2
export const CARD_PAINT_STABLE_TIMEOUT_MS = 3_000

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
export const ASSERTIONS_EXPECTED = 22

/**
 * The three rows the observer and the hub contribute, named so the total above cannot
 * drift from the rows the journeys actually emit.
 */
export const OPENING_ASSERTIONS = Object.freeze([
  'the desktop observer found and read a control window it did not create',
  'a built Electron main process started the real hub serving on loopback',
  'the hub published its own runtime file rather than being reached on an assumed port',
])
/**
 * The two rows the shipped build owes before any journey runs, and they are the rows
 * NT-9 had to record instead of assert: the product's own artefacts, on disk, and the
 * product's own delivery policy, wired. A product that grew neither would answer
 * `missing` and `not-wired` here, and that is a failed run rather than a record.
 */
export const SHIPPED_ASSERTIONS = Object.freeze([
  'the built artefacts carry the product own card document, its stylesheet, its entry bundle and the preload its window loads',
  'the shipped delivery policy is wired, so the card model crossed a channel the product owns',
])
/** The nine rows journey 1 owes, whatever it managed to observe. */
export const NEEDS_YOU_ASSERTIONS = Object.freeze([
  'a real needs-you event created exactly one pending item',
  'a card window appeared inside the display work area',
  'the card window held painted content',
  'the painted fill is the product own stylesheet fill for a needs-you card',
  'the card was still on screen after a wait',
  'the delivery outcome for the block was recorded as delivered',
  'the hub served the card document the window loads, byte for byte under the product own policy',
  'the badge number fell when the item was acknowledged',
  'the card was gone after the acknowledgement',
])
/** The four rows journey 2 owes. */
export const FINISHED_ASSERTIONS = Object.freeze([
  'a worked idle transition created exactly one finished event',
  'a card window appeared for the finished event',
  'the painted fill is the product own stylesheet fill for a finished card',
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
  BUILT_CARD_DOCUMENT: "the product's own built card document and the preload its window loads",
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
 * The `dominant` reading is the one addition NT-9 did not need. With the run-time harness
 * gone there is no report from inside the renderer to say what the card was, so the
 * question "whose colour is this?" is answered by asking the compositor: the most
 * frequent non-zero value in the window's own drawable, reduced to 24 bits so a 32-bit
 * capture's alpha does not make an opaque fill and a translucent one look different.
 * Compared against the product's own BUILT stylesheet with a stated per-channel
 * tolerance, that is what tells a needs-you card from a finished one, and it can only
 * come from the product's stylesheet because this run has no other one.
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
  const counts = new Map()
  let nonZero = 0
  for (let y = 0; y < height; y += 1) {
    const row = dataOffset + y * bytesPerLine
    for (let x = 0; x < width; x += 1) {
      const at = row + x * step
      let value = 0
      for (let index = step - 1; index >= 0; index -= 1) value = value * 256 + buffer[at + index]
      const colour = value & 0xffffff
      counts.set(colour, (counts.get(colour) ?? 0) + 1)
      if (value !== 0) nonZero += 1
    }
  }
  let dominant = null
  let best = 0
  for (const [colour, count] of counts) {
    if (colour === 0) continue
    if (count > best) {
      best = count
      dominant = colour
    }
  }
  return {
    ok: true,
    width,
    height,
    bitsPerPixel,
    bytesPerLine,
    pixels: width * height,
    distinctValues: counts.size,
    nonZeroPixels: nonZero,
    dominant: dominant === null ? null : { ...colourToRgb(dominant), count: best, share: best / (width * height) },
  }
}

/** One 24-bit value as `{ rgb, hex }`, the shape every colour in this script travels as. */
export function colourToRgb(value) {
  return { rgb: [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff], hex: `#${value.toString(16).padStart(6, '0')}` }
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
 * Whether nothing painted is on the screen in the hub's card window.
 *
 * Two answers say yes and they are not the same event. `no-card-window` is the window
 * itself being unmapped or gone, which is what the product's own dismissal does; `blank`
 * is a window that is still mapped with an empty drawable, which is what a card whose
 * element was removed out of a window nobody took down would leave. Neither is a card
 * (NT-FR-10), so a journey waiting for a card to leave waits for both - and the
 * assertion's `measured` block records which of the two it was, because the difference
 * is worth knowing.
 */
export function noCardOnScreen(verdict) {
  return verdict === 'no-card-window' || verdict === 'blank'
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: whose card is it
//
// With the run-time harness gone, the question the old renderer report answered - "is
// the thing in that window a card, and which kind" - is answered from outside the
// process instead: the observer reads the product's own BUILT stylesheet for the fill it
// paints each class with, and then asks the compositor whether that colour is on the
// screen. The comparison is a tolerance, and every reading records the distance it
// found, so a reader sees the number rather than only the verdict.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One `#rgb`/`#rrggbb` literal as `{ rgb, hex }`, or null for anything else.
 *
 * Null rather than a throw, because a stylesheet that does not carry a value is a
 * missing dependency this run reports by name, and an exception here would abort a
 * journey instead of naming what was absent.
 */
export function parseHexColor(literal) {
  if (typeof literal !== 'string') return null
  const digits = literal.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]+$/.test(digits)) return null
  const expanded = digits.length === 3 ? digits.split('').map((digit) => digit + digit).join('') : digits
  if (expanded.length !== 6) return null
  return {
    rgb: [parseInt(expanded.slice(0, 2), 16), parseInt(expanded.slice(2, 4), 16), parseInt(expanded.slice(4, 6), 16)],
    hex: `#${expanded.toLowerCase()}`,
  }
}

/**
 * The fill this product's own built card stylesheet paints each class with.
 *
 * Read out of the *built* artefact, not out of `src`, and not hardcoded here: the point
 * is that the colour the observer looks for on the screen is the one the product's build
 * carries, so the two cannot drift apart without the run noticing. Three names are
 * looked for and two are required - the product writes a fill per class, and the default
 * fill is recorded too so a reader can see all three of its values (NT-FR-02, NT-FR-08).
 *
 * null when a required name is absent, which the shipped-build journey reports as a
 * missing artefact rather than as a colour that happened not to match.
 */
export function readCardFillsFromCss(css) {
  if (typeof css !== 'string') return null
  const read = (name) => {
    const match = new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,6})`).exec(css)
    return match === null ? null : parseHexColor(match[1])
  }
  const needsYou = read('card-block-fill')
  const finished = read('card-finished-fill')
  if (needsYou === null || finished === null) return null
  return { needsYou, finished, default: read('card-fill') }
}

/**
 * The largest per-channel distance between two colours, or null when either is unknown.
 *
 * A maximum rather than a Euclidean distance on purpose: a tolerance stated in
 * "how far may one channel be" is a tolerance an operator can picture, and it is the
 * same number in the code and in the evidence file.
 */
export function channelDistance(one, other) {
  if (!Array.isArray(one) || !Array.isArray(other) || one.length !== 3 || other.length !== 3) return null
  if (![...one, ...other].every((value) => Number.isFinite(value))) return null
  return Math.max(...one.map((value, index) => Math.abs(value - other[index])))
}

/**
 * One reading per card-shaped window: the colour the compositor put there, and how far it
 * sits from each of the product's own fills.
 *
 * The distances are the measurement; `cardFillVerdict` is the judgement over them. They
 * are separate so the evidence file can record how far off the desktop actually put the
 * colour rather than only whether it was inside the tolerance.
 */
export function cardFillReadings(cardWindows, fills, tolerance = CARD_FILL_TOLERANCE) {
  const named = [
    ['needs-you-fill', fills?.needsYou ?? null],
    ['finished-fill', fills?.finished ?? null],
  ]
  return (cardWindows ?? []).map((window) => {
    const dominant = window?.pixels?.dominant ?? null
    const distances = {}
    let best = null
    for (const [verdict, fill] of named) {
      const distance = channelDistance(dominant?.rgb ?? null, fill?.rgb ?? null)
      distances[verdict] = distance
      if (distance === null) continue
      if (best === null || distance < best.distance) best = { verdict, distance }
    }
    return {
      windowId: window?.id ?? null,
      dominant: dominant === null ? null : { hex: dominant.hex, rgb: dominant.rgb, count: dominant.count, share: dominant.share },
      distances,
      best,
      withinTolerance: best !== null && best.distance <= tolerance,
    }
  })
}

/**
 * Which class of card the compositor is showing, as the product's own stylesheet names
 * the classes.
 *
 * Five answers, and each one is a claim that could be wrong:
 *
 *   'needs-you-fill'   the dominant painted value is the product's own block fill.
 *   'finished-fill'    the dominant painted value is the product's own finished fill.
 *   'no-card-fill'     something is painted and it is none of the product's fills. That
 *                      is a failed comparison rather than a pass, and it is how a card
 *                      drawn by something other than this product's build is reported.
 *   'unreadable'       the window's pixels could not be captured, or carried no non-zero
 *                      value to compare. A broken `xwd` must never become a colour match.
 *   'no-card-window'   no card-shaped window was offered at all, which a journey treats
 *                      as a missing precondition rather than as a verdict.
 *
 * Every candidate must agree: two windows on the desktop with different fills is a
 * desktop with two things on it, and the run reports the first one rather than picking
 * the one that suits.
 */
export function cardFillVerdict(cardWindows, fills, tolerance = CARD_FILL_TOLERANCE) {
  if (!Array.isArray(cardWindows) || cardWindows.length === 0) return 'no-card-window'
  if (fills === null || fills === undefined) return 'no-card-fill'
  const readings = cardFillReadings(cardWindows, fills, tolerance)
  if (readings.some((reading) => reading.dominant === null)) return 'unreadable'
  if (readings.some((reading) => !reading.withinTolerance)) return 'no-card-fill'
  const first = readings[0]
  if (first.best === null) return 'no-card-fill'
  if (readings.some((reading) => reading.best.verdict !== first.best.verdict)) return 'no-card-fill'
  return first.best.verdict
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
 * Whether the shipped delivery policy is wired at all, which is the product's own answer
 * to "is there a card presenter behind the surface".
 *
 * Separate from `deliveryVerdict` because it answers a different question and is asked
 * before anything has been delivered: `resolveSurfaceNotifier` refuses a host with no
 * renderer, so a `not-wired` policy means the shipped bridge carried no presenter and no
 * card could have been shown at all (NT-FR-12). The status string is carried into the
 * failure so a reader gets the product's own reason.
 */
export function wiredVerdict(delivery) {
  if (delivery === null || delivery === undefined) return 'no-delivery-section'
  return delivery.wired === true ? 'wired' : `not-wired: ${String(delivery.status)}`
}

/**
 * The product's own shipped artefacts, as this run found them on disk.
 *
 * Pure, so the verdict is testable without a build: the caller reads the files and hands
 * in what it found. Every path is one the product's own build produces and the surface's
 * own window names, and none of them can be satisfied by anything this run writes - the
 * run writes no file outside the evidence file.
 *
 *   'in-the-build'   the card document, the stylesheet and entry bundle it references,
 *                    and the preload its window loads are all present.
 *   otherwise       `missing: a, b`, naming what is absent, which is a failed run.
 */
export function shippedArtefactsVerdict(found) {
  const wanted = [
    ['the built card document', found?.document],
    ['the preload the surface window loads', found?.preload],
    ['the entry bundle the card document loads', found?.entry],
    ['the stylesheet the card document links', found?.stylesheet],
  ]
  const missing = wanted.filter(([, present]) => present !== true).map(([what]) => what)
  return missing.length === 0 ? 'in-the-build' : `missing: ${missing.join(', ')}`
}

/**
 * Whether the card document the window loaded is the product's own built one.
 *
 * Three conditions, and the middle one is the one this run exists for: the bytes served
 * must be the bytes the build produced. A status code alone would pass for any document
 * that happens to answer 200 - including one this script had written itself, which is
 * exactly what NT-9 had to do and exactly what must now be impossible. The policy header
 * is compared too, because a document served without the product's own strict policy is
 * a document that was allowed to do something this product forbids.
 */
export function servedDocumentVerdict({ status, served, built, policy, permissiveHeader }) {
  if (status !== 200) return `not-served: ${String(status)}`
  if (typeof served !== 'string' || typeof built !== 'string') return 'not-served: no body to compare'
  if (served !== built) return 'served-something-else: the body is not the built document'
  if (typeof policy !== 'string' || policy === '') return 'served-without-a-content-security-policy'
  if (permissiveHeader === true) return `served-with-a-permissive-header: ${String(permissiveHeader)}`
  return 'served-identically'
}


// ─────────────────────────────────────────────────────────────────────────────
// Pure: the arguments
// ─────────────────────────────────────────────────────────────────────────────

export const USAGE = `usage: node ${SCRIPT_PATH} [--out <path>] [--keep-state] [--help]

Starts the product's shipped Electron main entry point against a state directory of this
run's own, asserts that the build carries the product's own card document and a wired
delivery policy, drives three real journeys over the real loopback socket, and observes the
desktop from outside the product with the X server. One machine-readable JSON summary goes to
stdout; progress goes to stderr. The run supplies no part of the card path: it writes no
document, no stylesheet, no entry module and no dashboard root, it starts no second process,
and the only file it writes is the evidence file.

  --out <path>   where to write the evidence file (default ${DEFAULT_EVIDENCE_PATH})
  --keep-state   do not delete the temporary state directory on exit
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
// What is NOT here, and is not coming back
//
// NT-9 generated four things at run time and this file no longer contains any of them:
// a card document, a card stylesheet, a card entry module, and a renderer bridge that
// carried a card model into the window by injecting code into it. With NS-1 building and
// serving the card document, NS-2 opening the product's own channel and wiring the card
// presenter, and NS-3 taking the card down when its block ends, the product draws its own
// card and a run that substituted any of those four would be measuring itself.
//
// The guarantee is not a promise in this comment. It is a source-level test: see
// `describe('this script supplies no part of the card path')` in
// tests/scripts/verify-notification-surface.test.ts, which reads this file's own source and
// fails on the four implementations, on the one file it is allowed to write, and on the one
// artefact it is allowed to start.
// ─────────────────────────────────────────────────────────────────────────────

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
 *
 * `path.delimiter` and both separators, because this is a preflight about the machine a
 * developer is sitting at and that machine is not necessarily the one the script was
 * authored on: `PATH` entries are `;`-separated on Windows, and a path handed in with a
 * backslash is a path there rather than a bare command name to look up.
 */
export function resolveOnPath(command, environment = process.env) {
  if (typeof command !== 'string' || command === '') return null
  if (command.includes('/') || command.includes('\\')) {
    return existsSync(command) ? command : null
  }
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
 * The card document this run asks the product's own static route for.
 *
 * The path is the product's, not this script's: SURFACE_DOCUMENT_PATH in
 * src/notify/surface/electron-host.ts is the string the surface window loads, and a run that
 * asked for a different path would be asking about a document the window never opens.
 */
export const CARD_DOCUMENT_PATH = '/card.html'

/** The built card document, served from the dashboard root the product resolved. */
export const BUILT_CARD_DOCUMENT = 'dist/dashboard/card.html'
/** The preload the surface window loads, emitted as CommonJS beside its TypeScript source. */
export const BUILT_CARD_PRELOAD = 'dist/main/notify/surface/preload.cjs'

/**
 * The card document the build produced, the two files it points at, and the two colours the
 * card stylesheet paints the classes with.
 *
 * Read out of the built artefacts rather than hardcoded, so the observer's expectation is
 * the product's build and not this script's memory of it: the entry bundle and the
 * stylesheet come from the document's own `src` and `href` attributes, and the two fills
 * come from the stylesheet's own custom properties. A card this run did not paint could
 * only match those values if the product's build had changed underneath it, and then the
 * distances recorded in the evidence file are what says so (NT-FR-12).
 *
 * Nothing here writes: a missing artefact is reported by name rather than created, which is
 * the difference between a run that proves the product and one that supplies it.
 */
export function readBuiltCardDocument() {
  const documentPath = path.join(repoRoot, BUILT_CARD_DOCUMENT)
  const document = {
    path: BUILT_CARD_DOCUMENT,
    present: false,
    bytes: 0,
    entry: null,
    stylesheet: null,
    source: 'src/dashboard/card.html, the surface document entry of the dashboard build (NS-1)',
  }
  if (!existsSync(documentPath)) return { document, entry: null, stylesheet: null, fills: null }
  const html = readFileSync(documentPath, 'utf8')
  document.present = true
  document.bytes = Buffer.byteLength(html)
  // Relative, as a bundler writes them, and resolved against the document's own directory -
  // which is how the browser that loads it resolves them.
  const resolve = (reference) => {
    if (reference === null) return null
    const from = path.resolve(path.dirname(documentPath), reference)
    return existsSync(from) ? from : null
  }
  const entryMatch = /<script[^>]+src="([^"]+)"/.exec(html)
  const styleMatch = /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/.exec(html)
  const entry = resolve(entryMatch === null ? null : entryMatch[1])
  const stylesheet = resolve(styleMatch === null ? null : styleMatch[1])
  document.entry = entry === null ? null : path.relative(repoRoot, entry).split(path.sep).join('/')
  document.stylesheet = stylesheet === null ? null : path.relative(repoRoot, stylesheet).split(path.sep).join('/')
  const fills = stylesheet === null ? null : readCardFillsFromCss(readFileSync(stylesheet, 'utf8'))
  return { document, entry, stylesheet, fills }
}

/**
 * Start the product's shipped Electron main entry point, as shipped, and keep everything it
 * says.
 *
 * The real binary rather than the `node_modules/.bin/electron` shim, the Chromium launch
 * policy in its environment form, a fresh temporary state directory, and the product's own
 * entry point with no other argument. The only environment this run adds beyond that is the
 * state directory, and the only processes it starts besides this one are the X tools and a
 * single `notify-send` used as a positive control after the journeys.
 *
 * The child's stdout and stderr are kept as a bounded ring rather than a log, and the two
 * populations are separated before anything is counted: a run that says "the product
 * reported nothing" has to be able to say how many of the lines it saw were the runtime's
 * own teardown noise.
 */
function launchHub({ electronBinary, stateDir, entryPoint = BUILT_ENTRY_POINT, env = {} }) {
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
  const keep = (lines, chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim() === '') continue
      lines.push(line)
      if (lines.length > MAX_CHILD_OUTPUT_LINES) lines.shift()
    }
  }
  child.stdout.on('data', (chunk) => keep(stdout, chunk))
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
 *
 * The response's own `text` and `headers` travel with it, because the card document is not
 * JSON and the claim about it is a byte-for-byte comparison under a named policy header -
 * neither of which a parsed body can answer.
 */
export function request(url, options = {}) {
  return new Promise((resolve) => {
    let target
    try {
      target = new URL(url)
    } catch {
      resolve({ ok: false, status: 0, body: null, text: null, headers: {}, error: `not a URL: ${url}` })
      return
    }
    if (target.hostname !== '127.0.0.1' && target.hostname !== 'localhost' && target.hostname !== '[::1]') {
      resolve({
        ok: false,
        status: 0,
        body: null,
        text: null,
        headers: {},
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
            // Not JSON. A `GET /card.html` answers text/html and is compared as text against
            // the built document byte for byte, so a null body here is a normal outcome rather
            // than a fault.
          }
          const status = response.statusCode ?? 0
          resolve({ ok: status >= 200 && status < 300, status, body, text, headers: response.headers })
        })
      },
    )
    outgoing.setTimeout(REQUEST_TIMEOUT_MS, () => {
      outgoing.destroy(new Error(`the request exceeded ${REQUEST_TIMEOUT_MS} ms`))
    })
    outgoing.on('error', (cause) => {
      resolve({ ok: false, status: 0, body: null, text: null, headers: {}, error: cause.message })
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
    'run `npm run build` so the dashboard is built. This run serves nothing of its own: the surface window loads the built card document from the dashboard root the product resolved',
    'dist/dashboard/index.html',
  )
  const built = readBuiltCardDocument()
  const preloadPresent = existsSync(path.join(repoRoot, BUILT_CARD_PRELOAD))
  add(
    DependencyStatus.BUILT_CARD_DOCUMENT,
    shippedArtefactsVerdict({
      document: built.document.present,
      preload: preloadPresent,
      entry: built.entry !== null,
      stylesheet: built.stylesheet !== null,
    }) === 'in-the-build',
    'run `npm run build` so dist/dashboard/card.html exists as the dashboard build’s third entry, ' +
      'together with the entry bundle and stylesheet it references, and so tsc emits ' +
      `${BUILT_CARD_PRELOAD}, the preload the surface window loads. The surface window's own options ` +
      'name that preload, so a build without it can show a card window that can never receive a card ' +
      '(NS-1, NS-2, NT-FR-12)',
    [
      `${BUILT_CARD_DOCUMENT} (${built.document.present ? 'present' : 'absent'})`,
      built.document.entry ?? 'the entry bundle the card document references (absent)',
      built.document.stylesheet ?? 'the stylesheet the card document links (absent)',
      `${BUILT_CARD_PRELOAD} (${preloadPresent ? 'present' : 'absent'})`,
    ].join(', '),
  )

  const workArea = new DesktopObserver(tools).workArea()
  add(
    DependencyStatus.WORK_AREA,
    workArea.workArea !== null,
    'the display must advertise _NET_WORKAREA, which is what a window manager publishes so a window can be placed inside the usable area. On a bare X server with no window manager there is none, a card has nowhere correct to go, and this script fails rather than placing it against the screen rectangle',
    workArea.workArea === null ? (workArea.error ?? 'xprop printed no _NET_WORKAREA') : JSON.stringify(workArea.workArea),
  )

  return { tools, electronBinary, display, dependencies, workArea, located, built }
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
 * A one-line description of what is painted in the card window, or null when nothing is.
 *
 * Two identical signatures mean the window's own drawable did not change between two
 * readings, which is the only evidence available from outside the process that a card has
 * finished arriving. The signature carries the id, the dominant value and the two counts,
 * so a card that is still fading - changing colour, changing how much of the surface it
 * covers - produces a different signature each time and is not mistaken for a settled one.
 */
export function cardPaintSignature(facts, hubPid) {
  const { candidates } = screenWindowFacts(facts ?? [], hubPid)
  if (candidates.length === 0) return null
  return candidates
    .map((candidate) => {
      const pixels = candidate.pixels
      return [
        candidate.id,
        pixels?.dominant?.hex ?? 'none',
        String(pixels?.distinctValues ?? 0),
        String(pixels?.nonZeroPixels ?? 0),
      ].join(':')
    })
    .join('|')
}

/**
 * Wait for the card on the display to stop moving, and return the reading taken once it
 * has.
 *
 * The product's card animates in, and a comparison against its own stylesheet taken while
 * the animation is running measures the animation. The last reading is always returned,
 * with `settled: false` when the deadline passed first, so a card that never comes to rest
 * is compared as it was and fails rather than being quietly retried until it passes
 * (CARD_PAINT_STABLE_READS).
 */
async function waitForSettledPaint(observer, baseline, hubPid) {
  const startedAt = Date.now()
  let reading = { facts: [], emerging: [], rejected: [] }
  let previous = null
  let stable = 0
  while (Date.now() - startedAt < CARD_PAINT_STABLE_TIMEOUT_MS) {
    reading = readCardWindowsNow(observer, baseline, hubPid)()
    const signature = cardPaintSignature(reading.facts, hubPid)
    if (signature !== null) {
      stable = signature === previous ? stable + 1 : 1
      previous = signature
      if (stable >= CARD_PAINT_STABLE_READS) break
    }
    await sleep(150)
  }
  return { settled: stable >= CARD_PAINT_STABLE_READS, value: reading, elapsedMs: Date.now() - startedAt, stableReads: stable }
}

/**
 * Journey 0: what the shipped build is, before any journey drives it.
 *
 * The two rows NT-9 had to record instead of assert. There is no run-time harness any
 * more, so the question "can the product as shipped show a card" is no longer a matter of
 * what this script supplies: it is answered by the product's own artefacts on disk and the
 * product's own health payload, and a build that had neither would fail this run instead of
 * producing a record of its own absence.
 *
 * It runs after the hub is serving, because one of the two rows is the hub's own answer
 * about its delivery policy - and it runs before the first journey, so the window-facts
 * baseline every journey takes is a reading of a desktop with no card on it.
 */
async function runShippedBuildJourney({ origin, built }) {
  if (origin === null) {
    return { observations: notServed('shipped-build', SHIPPED_ASSERTIONS), records: [], timings: {} }
  }
  const observations = []
  const preloadPresent = existsSync(path.join(repoRoot, BUILT_CARD_PRELOAD))
  const artefacts = shippedArtefactsVerdict({
    document: built.document.present,
    preload: preloadPresent,
    entry: built.entry !== null,
    stylesheet: built.stylesheet !== null,
  })
  observations.push(
    observation('shipped-build', SHIPPED_ASSERTIONS[0], 'in-the-build', artefacts, {
      builtCardDocument: built.document,
      builtPreload: BUILT_CARD_PRELOAD,
      preloadPresent,
      builtEntryPoint: BUILT_ENTRY_POINT,
      suppliedByThisRun: 'nothing. This run writes one file, the evidence file, and this row is a failed run if any of the four artefacts is absent',
      fillsReadFromTheBuild: built.fills,
    }),
  )

  const health = (await readHealth(origin)).health
  observations.push(
    observation('shipped-build', SHIPPED_ASSERTIONS[1], 'wired', wiredVerdict(health?.delivery), {
      delivery: health?.delivery ?? null,
      whatThisMeans:
        'the product own resolveSurfaceNotifier refuses a surface with no card presenter, so a wired policy ' +
        'means the shipped Electron bridge carried one and a card model had a channel to cross. The renderer ' +
        'runs with the product own frozen options, which name its preload; nothing about them is set, ' +
        'widened or replaced by this run (NT-FR-12, APX-FR-01)',
      rendererOptionsReadFromTheBuild: readRendererOptionsFromBuild(),
    }),
  )

  return {
    observations,
    timings: {},
    records: [
      {
        journey: 'shipped-build',
        artefacts,
        builtCardDocument: built.document,
        builtPreload: BUILT_CARD_PRELOAD,
        cardFillsReadFromTheBuild: built.fills,
        delivery: health?.delivery ?? null,
        wiredVerdict: wiredVerdict(health?.delivery),
      },
    ],
  }
}

/**
 * The renderer options the shipped build carries, read out of the built artefact.
 *
 * A record and never an assertion, and the distinction matters: a run outside the process
 * cannot read the live window's options, so a source-level reading of the built module is
 * the only honest thing available, and tests/notify/surface-host.test.ts is what asserts the
 * object itself. Recording it here means a reader can see the three settings the isolation
 * claim rests on next to the card that was observed, with both provenance labels on them.
 */
function readRendererOptionsFromBuild() {
  const file = path.join(repoRoot, 'dist', 'main', 'notify', 'surface', 'electron-host.js')
  if (!existsSync(file)) {
    return { available: false, reason: 'the built Electron surface module is absent', readFrom: file }
  }
  return { available: true, readFrom: 'dist/main/notify/surface/electron-host.js, read as code', ...readSurfaceWindowOptions(readFileSync(file, 'utf8')) }
}

/**
 * The window options the shipped build creates its surface window with, read out of the
 * built module.
 *
 * Two decisions, and both of them exist because of a way this could have lied:
 *
 *   - the module's comments are stripped first. Its prose names `webSecurity: false` and
 *     `nodeIntegration: true` *while explaining why neither is done*, and a reader that took
 *     the first match of either would have recorded the opposite of the product's
 *     configuration in an evidence file. Publishing a false claim is the one thing this
 *     run exists to prevent.
 *   - only the frozen option object is read. A setting named anywhere else in the module
 *     cannot then be mistaken for one the window was created with.
 *
 * `webSecurity` is expected to come back `null`, and `null` is the honest answer rather than
 * a missing one: the product does not widen it, so the key is not in the object. A reader
 * who needs the positive is pointed at the suite that asserts the object as a whole.
 *
 * Pure, so the shape that would have produced a false claim is a test rather than a
 * surprise.
 */
export function readSurfaceWindowOptions(source) {
  const code = stripComments(source)
  const at = code.indexOf('SURFACE_WINDOW_OPTIONS')
  if (at === -1) {
    return { available: false, reason: 'the built surface module declares no frozen window option object' }
  }
  const block = code.slice(at, at + 2_000)
  const read = (name) => {
    const match = new RegExp(`\\b${name}:\\s*(true|false|'[^']*')`).exec(block)
    return match === null ? null : match[1]
  }
  const preload = /\bpreload:\s*([^,\n]+)/.exec(block)
  return {
    available: true,
    contextIsolation: read('contextIsolation'),
    nodeIntegration: read('nodeIntegration'),
    sandbox: read('sandbox'),
    webSecurity: read('webSecurity'),
    preload: preload === null ? null : preload[1].trim(),
    howThisWasRead:
      'the module as code, its comments stripped, and only the frozen option object. Its prose names the ' +
      'settings this product refuses to use, so a first-match sweep over commented source would record the ' +
      'opposite of the configuration',
    notObserved:
      "these are the values the built artefact carries. A run outside the process cannot read the live " +
      "window's own options, so this is a record of the build and not a reading of the running window",
  }
}

/**
 * A source file with its comments removed, as the repository's own sweeps do.
 *
 * Line comments and block comments become spaces of the same length, so offsets and line
 * numbers survive and a token that only ever appeared in prose is gone. String literals are
 * left alone, because a forbidden *name* is most often only ever a string.
 */
export function stripComments(source) {
  let out = ''
  let index = 0
  const blank = (length) => {
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
    const character = source[index]
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
      out += source.slice(index, cursor)
      index = cursor
      continue
    }
    out += character
    index += 1
  }
  return out
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
 * Every visibility claim here is answered by the X server, and every claim about *which*
 * card is answered by comparing the compositor's own colour against the product's built
 * stylesheet. There is no report from inside the renderer to corroborate them with any
 * more, and there does not need to be one: this run has no card document and no renderer
 * bridge to substitute, so the pixels on the screen came from the product's build.
 */
async function runNeedsYouJourney({ observer, origin, token, workArea, hubPid, built, fills }) {
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
  // Then wait for the card to stop arriving, so every reading below is of the card at rest
  // rather than of its own entrance animation.
  const rested = await waitForSettledPaint(observer, baseline.facts, hubPid)
  const immediate = rested.value ?? { facts: [], emerging: [], rejected: [] }
  timings.cardAppearedMs = emerged.elapsedMs
  timings.paintSettledAfterMs = rested.elapsedMs
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

  const fillReadings = cardFillReadings(immediate.emerging, fills)
  timings.fillVerdictMs = 0
  observations.push(
    observation('needs-you', NEEDS_YOU_ASSERTIONS[3], 'needs-you-fill', cardFillVerdict(immediate.emerging, fills), {
      whatThisReplaces:
        'NT-9 read the card element out of the renderer through a bridge this script had to build, and the ' +
        'run could therefore only prove the card machinery rather than the product. That reading is gone with ' +
        'the bridge: the colour is read out of the product own built stylesheet and compared with what the ' +
        'compositor actually put on the screen, which no substituted document could have faked (NT-FR-12)',
      fillsTheProductBuildCarries: fills,
      tolerancePerChannel: CARD_FILL_TOLERANCE,
      paintSettled: rested.settled,
      paintSettledAfterMs: rested.elapsedMs,
      readings: fillReadings,
      whyATolerance:
        'the desktop colour-manages what it is handed. On this machine it moved the product own ' +
        '--card-block-fill by at most 7 per channel, and the two class fills are 35 apart in red from each ' +
        'other, so the tolerance separates the classes and says nothing about exact colour (APX-CON-06)',
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
        'product own notifier showed the product own window and the product own channel accepted the ' +
        'product own card model. A status of ok on its own would not be enough: a hub with a wired policy ' +
        'and a failed card answers ok too, so the counts are compared as well',
    }),
  )

  // The document the window loaded, compared as bytes with the one the build produced and
  // under the policy header the product's own static route sends. A status code would
  // answer this for any document that happens to answer 200, including one a run had
  // written for itself - which is precisely what must now be impossible.
  const cardDocument = await request(`${origin}${CARD_DOCUMENT_PATH}`)
  const policy = cardDocument.headers?.['content-security-policy'] ?? null
  const permissiveHeader =
    cardDocument.headers?.['access-control-allow-origin'] !== undefined ||
    cardDocument.headers?.['access-control-allow-headers'] !== undefined
  const documentVerdict = servedDocumentVerdict({
    status: cardDocument.status,
    served: cardDocument.text,
    built: built.document.present ? readFileSync(path.join(repoRoot, BUILT_CARD_DOCUMENT), 'utf8') : null,
    policy,
    permissiveHeader,
  })
  observations.push(
    observation(
      'needs-you',
      NEEDS_YOU_ASSERTIONS[6],
      'served-identically',
      documentVerdict,
      {
        path: CARD_DOCUMENT_PATH,
        source: built.document.source,
        presentInTheProductBuild: built.document.present,
        bytesCompared: built.document.bytes,
        contentSecurityPolicy: policy,
        permissiveCrossOriginHeader: permissiveHeader,
        servedFrom: 'the dashboard root the product resolved for itself, with no root supplied by this run',
      },
    ),
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
    (reading) => noCardOnScreen(cardOnScreenVerdict(reading.facts, hubPid)),
  )
  const afterAckWindows = gone.value ?? { facts: [], emerging: [], rejected: [] }
  timings.cardGoneMs = gone.elapsedMs
  const afterAckVerdict = cardOnScreenVerdict(afterAckWindows.facts, hubPid)
  observations.push(
    observation(
      'needs-you',
      NEEDS_YOU_ASSERTIONS[8],
      'gone',
      noCardOnScreen(afterAckVerdict)
        ? cardOnScreenVerdict(immediate.facts, hubPid) === 'painted'
          ? 'gone'
          : 'not-observed: no card window was ever seen, so its disappearance proves nothing'
        : `still-on-the-display: ${afterAckVerdict}`,
      {
        waitedMs: gone.elapsedMs,
        onScreenVerdict: afterAckVerdict,
        windowUnmapped: afterAckVerdict === 'no-card-window',
        candidates: afterAckWindows.emerging,
        whoRemovedIt:
          'the product own ack route called the product own dismissal port after its 2xx, which ended the ' +
          "card with the end its own lifetime cell names and took the host's own window down. Nothing in this " +
          'script did any of that, and there is no fallback dismissal here that could have hidden a product that ' +
          'had not done it (NT-FR-12 third clause, ADR-010)',
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
        cardFillVerdict: cardFillVerdict(immediate.emerging, fills),
        cardFillReadings: fillReadings,
        cardDocumentServed: documentVerdict,
        cardDocumentStatus: cardDocument.status,
        contentSecurityPolicy: policy,
        ackStatus: ack.status,
        cardGoneAfterMs: gone.elapsedMs,
        cardGoneBecause: afterAckVerdict,
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
async function runFinishedJourney({ observer, origin, token, workArea, hubPid, fills }) {
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
  // As in journey 1: the card has to finish arriving before its colour is the colour the
  // product's stylesheet names, and this card lives for 5 s, which is longer than the
  // animation and than the wait for it.
  const rested = await waitForSettledPaint(observer, baseline.facts, hubPid)
  const immediate = rested.value ?? { facts: [], emerging: [], rejected: [] }
  timings.cardAppearedMs = emerged.elapsedMs
  timings.paintSettledAfterMs = rested.elapsedMs
  observations.push(
    observation('finished', FINISHED_ASSERTIONS[1], 'inside-the-work-area', cardWindowVerdict(immediate.emerging, workArea), {
      workArea,
      waitedMs: emerged.elapsedMs,
      candidates: immediate.emerging,
      rejectedWindows: immediate.rejected,
      cardWasPainted: cardOnScreenVerdict(immediate.facts, hubPid) === 'painted',
    }),
  )

  const fillReadings = cardFillReadings(immediate.emerging, fills)
  observations.push(
    observation('finished', FINISHED_ASSERTIONS[2], 'finished-fill', cardFillVerdict(immediate.emerging, fills), {
      whyThisRow:
        'a needs-you card left on the screen would paint the block fill, so a reading of the block fill here ' +
        'is a card of the wrong class on the screen. Two cards of two classes, distinguished from the display ' +
        "server's own pixels rather than from a report the product wrote about itself (NT-FR-02)",
      fillsTheProductBuildCarries: fills,
      tolerancePerChannel: CARD_FILL_TOLERANCE,
      paintSettled: rested.settled,
      paintSettledAfterMs: rested.elapsedMs,
      readings: fillReadings,
    }),
  )

  const waitedAt = Date.now()
  await sleep(FINISHED_EXPIRY_WAIT_MS)
  timings.expiryWaitMs = Date.now() - waitedAt
  const afterwards = readCardWindowsNow(observer, baseline.facts, hubPid)()
  const expiryVerdict = cardOnScreenVerdict(afterwards.facts, hubPid)
  const wasPainted = cardOnScreenVerdict(immediate.facts, hubPid) === 'painted'
  observations.push(
    observation(
      'finished',
      FINISHED_ASSERTIONS[3],
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
        windowUnmapped: expiryVerdict === 'no-card-window',
        acknowledgedDuringTheWait: false,
        dismissedByTheScript: false,
        howItLeft:
          'the product own card view armed the product own one interval for this class and removed the ' +
          'card element when it elapsed, and the product own card channel took the host window down with it. ' +
          'Nothing was acknowledged, nothing was dismissed, and this script has no fallback dismissal that ' +
          'could have hidden an unimplemented expiry (NT-FR-08, NT-FR-10)',
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
        cardFillVerdict: cardFillVerdict(immediate.emerging, fills),
        cardFillReadings: fillReadings,
        cardGoneAfterTheInterval: expiryVerdict !== 'painted' && wasPainted,
        cardGoneBecause: expiryVerdict,
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
      noCardOnScreen(stillUpVerdict) ? 'none' : `a-card-window: ${stillUpVerdict}`,
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
 * What the product still has to do, and what it no longer has to do, as this run found it.
 *
 * Two lists, because the honest answer is two answers. NT-9 could only record the three
 * gaps it had itself completed, because a run that substitutes the product's card document
 * has no standing to say the product is missing one. This run supplies nothing, so what it
 * observed about the shipped build is evidence, and the three gaps NS-1, NS-2 and NS-3
 * closed are closed *with the tasks that closed them named* and with the assertion in this
 * run that holds the closure up.
 *
 * Every entry on either list names an owner and what was observed. `suppliedByThisRun` is
 * the same sentence on every one of them, and that is the point: there is nothing left for
 * a verification run to put in a product's place (APX-FR-02, ADR-010).
 */
export function productChanges({ shipped = null, productLineCount = 0, chromiumLineCount = 0 }) {
  const nothingSupplied =
    'nothing. This run supplies no seam, writes no file but the evidence file, and starts no process but the ' +
    "product's own built entry point, so a green result cannot mean the run did the product's work again"
  const closed = [
    {
      id: 'card-document-entry',
      closedBy: 'NS-1',
      required: 'src/dashboard/card.html as a third entry of the dashboard build, with its stylesheet and its entry bundle',
      observedBefore:
        'the shipped build served no card document: dist/dashboard/card.html did not exist, GET /card.html ' +
        'answered 404, and a window showing a Chromium error page is not a card (APX-FR-02)',
      observedNow:
        'the build carries dist/dashboard/card.html with the entry bundle and stylesheet it references, and the ' +
        "hub's own static route served those exact bytes, under the product's own content-security policy, for " +
        'the path the surface window loads',
      howThisRunProvesIt: SHIPPED_ASSERTIONS[0],
      suppliedByThisRun: nothingSupplied,
    },
    {
      id: 'card-renderer-channel',
      closedBy: 'NS-2',
      required:
        'a card presenter on the shipped Electron bridge and a main-to-renderer channel that leaves ' +
        'contextIsolation, nodeIntegration and the renderer sandbox in force',
      observedBefore:
        'the shipped bridge supplied no presenter, so resolveSurfaceNotifier answered no-card-renderer, the ' +
        'delivery policy was not wired, and every delivery on the shipped entry point was recorded not-wired',
      observedNow:
        "the shipped delivery policy answered wired, which the product only reports when a presenter is behind " +
        'the surface, and a card then reached a real window on a real display and painted the product own fill',
      howThisRunProvesIt: `${SHIPPED_ASSERTIONS[1]}; ${NEEDS_YOU_ASSERTIONS[1]}`,
      notObservedHere:
        "the three renderer settings are recorded from the built artefact rather than read from the live " +
        'window, and tests/notify/surface-host.test.ts is what asserts the option object itself',
      suppliedByThisRun: nothingSupplied,
    },
    {
      id: 'acknowledgement-does-not-reach-the-card',
      closedBy: 'NS-3',
      required: 'a notifier hook on POST /api/ack/:eventId, so the card can be removed with the end its own lifetime cell names',
      observedBefore:
        'the lifetime table named `acknowledged` as an end and the card view removed on it, but nothing called ' +
        'it during a run: a needs-you card left the screen only when its window was destroyed at shutdown',
      observedNow:
        'after a real POST /api/ack, the card window the hub owns was no longer viewable, nothing painted was on ' +
        'the display, and the pending count the badge reads fell to zero - with no dismissal from this script',
      howThisRunProvesIt: `${NEEDS_YOU_ASSERTIONS[7]}; ${NEEDS_YOU_ASSERTIONS[8]}`,
      suppliedByThisRun: nothingSupplied,
    },
    {
      id: 'nothing-takes-the-window-down-when-a-card-ends',
      closedBy: 'NS-3',
      required:
        "the card view's own end must reach the host, so host.hide() runs when a card ends. A mapped transparent " +
        'window that nothing takes down is neither a card nor the quiet surface NT-FR-10 promises',
      observedBefore:
        'the host window was still mapped and visible when a finished card expired, and its drawable was empty, ' +
        'so the run had to complete the gap itself',
      observedNow:
        'the host window was unmapped after an acknowledged block and again after an expired finished card, and ' +
        'in both cases the map state is recorded so a reader can tell unmapped from merely empty',
      howThisRunProvesIt: `${NEEDS_YOU_ASSERTIONS[8]}; ${FINISHED_ASSERTIONS[3]}`,
      suppliedByThisRun: nothingSupplied,
    },
  ]
  const open = [
    {
      id: 'not-wired-diagnostic-has-no-destination',
      owner: 'hub-engineer',
      required: 'startElectronMain should pass an onDiagnostic that writes to stderr, so the not-wired reason reaches the operator',
      observed:
        `this run captured the shipped entry point's stdout and stderr across its whole life. ${String(productLineCount)} ` +
        `of those lines were written by this product, and ${String(chromiumLineCount)} by the Electron runtime ` +
        'tearing itself down (zygote, network service and GPU), which this script separates by the shape of the ' +
        'line rather than counting as a diagnostic. startHub defaults onDiagnostic to a no-op and the Electron ' +
        'entry point supplies none, so on a desktop where the surface refuses the reason a run can show no card ' +
        'is never reported by the product itself (APX-FR-02, ADR-010)',
      suppliedByThisRun: 'none, and there is nothing to supply: the surface was wired on this run, so nothing refused',
    },
    {
      id: 'tray-is-not-observable-outside-the-process',
      owner: 'notification-engineer',
      required:
        'a way for a verification run to observe the tray: a diagnostic on mount, or the badge number through a ' +
        'route that already exists',
      observed:
        'an Electron Tray is a StatusNotifierItem and not an X window, so this run could not see whether the icon ' +
        'mounted or what number it carried. The badge number was read from GET /api/pending, which is the ' +
        'accessor the badge itself reads',
      suppliedByThisRun: 'none',
    },
    {
      id: 'the-durable-schema-is-not-in-the-build',
      owner: 'tooling-engineer, with packaging-engineer for the package allowlist',
      required: 'a copy step in scripts/build.mjs for src/storage/schema.sql, and dist/main/storage/schema.sql in the package files allowlist',
      observed:
        'the tsc build emits JavaScript only, so a hub started from the build cannot find its schema and refuses ' +
        'to open its log. This run has to copy the file by hand before it can start anything at all',
      suppliedByThisRun: 'none: the remedy is a command in the preflight, and it is the preflight and the runbook that say so',
    },
  ]
  if (shipped?.artefacts !== 'in-the-build') {
    open.unshift({
      id: 'the-shipped-build-is-missing-a-card-artefact',
      owner: 'dashboard-engineer with notification-engineer',
      required: 'npm run build must produce the card document, its entry bundle, its stylesheet and the surface preload together',
      observed: `this run found the shipped build without them: ${String(shipped?.artefacts ?? 'the artefacts were never read')}`,
      suppliedByThisRun: 'none, deliberately: a run that created the artefact it is here to prove would prove itself',
    })
  }
  return { closed, open }
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

async function run({ pre, stateDir }) {
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

  // The one process, started once, with nothing of this run's own in its environment but
  // the state directory.
  const hub = launchHub({ electronBinary: pre.electronBinary, stateDir })
  const evidence = {
    taskId: 'NS-4',
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
      builtCardDocument: BUILT_CARD_DOCUMENT,
      cardDocumentPresent: pre.built.document.present,
      cardDocumentSource: pre.built.document.source,
      stateDirUsed: 'a fresh temporary directory per run, so this run cannot touch a real installation',
    },
    seams: {
      count: 0,
      suppliedByThisRun: [],
      whatThisRunUsesInstead:
        "the product's own built entry point, the product's own built dashboard, the product's own preload, the " +
        'product own static route, the product own loopback routes, and the X server and the product own runtime ' +
        'file for everything observed',
      whatItWouldHaveToWriteToSubstitute: [
        'a card document',
        'a card stylesheet',
        'a card entry module',
        'a renderer bridge that injects a card model into the window',
      ],
      enforcedBy:
        "tests/scripts/verify-notification-surface.test.ts reads this file's own source and fails on all four, on " +
        'the one file it is allowed to write, and on the one artefact it is allowed to start',
      whyThisMatters:
        'a verification script that has to substitute for any of those four is measuring the script, not the ' +
        'product, and a green run would say nothing about the card a developer sees (NT-FR-12)',
    },
    shippedPosture: {
      entryPoint: BUILT_ENTRY_POINT,
      question: 'can the product as shipped show a card on this display, with no seam supplied by a test?',
      asserted: true,
      whyItIsAnAssertionNow:
        'NT-9 recorded this instead of asserting it, on purpose, because the product could not do it and the run ' +
        'had substituted all three of the missing pieces itself. NS-1 built and served the card document, NS-2 ' +
        'opened the renderer channel and wired the card presenter and NS-3 took the card down when its block ends, ' +
        'so the withheld assertion became real. A run that still recorded it would now be the stale artefact, ' +
        'and the runbook section behind it is the thing that should be stale instead',
      artefacts: null,
      delivery: null,
      wiredVerdict: null,
      cardDocument: { path: CARD_DOCUMENT_PATH, status: null, servedIdentically: null },
      rendererOptionsReadFromTheBuild: null,
      pendingAfterARealBlock: null,
      pendingAfterTheAcknowledgement: null,
      toastDeliveries: null,
      cardWindowOnTheDisplayAtTheEnd: null,
      diagnosticLines: [],
      productDiagnosticLines: [],
      chromiumDiagnosticLines: [],
      productDiagnosticCount: null,
      chromiumDiagnosticCount: null,
      diagnosticLinesNote:
        "the two populations are kept apart because one open finding is about whether this product's own " +
        'diagnostic reaches an operator, and a count that included Chromium teardown noise would answer a ' +
        'different question. Chromium writes its GPU and zygote lines while a process is being stopped on this ' +
        'desktop, so a nonzero chromium count beside a zero product count is the expected reading for a healthy ' +
        'hub and is not a fault',
      stateDirectory: 'a directory of this run own, so a block stored here cannot be replayed into a later run',
    },
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
    childDiagnostics: null,
    notificationCentre: null,
    productChanges: { closed: [], open: [] },
    notVerified: [
      'anything at all about macOS or Windows: this run happened on one Linux desktop and no statement in this file is evidence about another platform (APX-CON-06)',
      'the contents of the card. Reading a renderer from outside the process would mean injecting code into it, which is the shape this run exists to prove the product does not need, so nothing here reads the card document. Its element tree, its attributes, its accessible name, its live-region role and its reduced-motion behaviour are held by tests/notify/surface-card-view.test.ts and tests/dashboard/card-document.test.ts rather than by this run (NT-FR-02, NT-FR-12)',
      'whether the card text is legible at its real size: the pixel capture measures painted values and reads no word, and no human read a card off this run display. Legibility remains a manual per-platform step with the product own stylesheet (NT-FR-02)',
      'the exact colour on the screen: the fill comparison is a per-channel tolerance, because the desktop colour-manages what it is handed. On this machine it moved the product own fill by at most 7 per channel, and every reading records the distance it found, but no claim is made that a given hexadecimal value reached the compositor (APX-CON-06)',
      'whether showInactive left the keyboard focus alone: the X server exposes no focus reading for a card window on this desktop, so this run observed visibility and not focus (NT-FR-04)',
      'whether a pointer can reach the card, and whether the click-through switch and its release both work: the surface is click-through until a pointer arrives, no pointer was moved, and tests/notify/surface-host.test.ts is what asserts the switch itself',
      'whether the tray icon mounted and what number it carried: an Electron Tray is a StatusNotifierItem, not an X window. The number was read through the accessor the badge reads',
      "the renderer settings of the running window: contextIsolation, nodeIntegration, sandbox and webSecurity are recorded from the built artefact and attributed to tests/notify/surface-host.test.ts, because a run outside the process cannot read a live window's options (NT-FR-12)",
      "an installation that is already running: the shipped entry point takes Electron's single-instance lock, so a second launch quits before it serves. This run therefore proves the build in a state directory of its own and cannot verify a hub that is in use on the same desktop",
      'GPU behaviour: Chromium reported a failed GPU process launch on this machine under software rendering, both during the run and while it was being stopped. The application reached ready and served regardless, and the failure is recorded rather than worked around, so nothing in this file says anything about a machine with a working GPU (PRD 16 Open Question 13)',
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
    const built = pre.built
    const fills = built.fills

    // The shipped build, asserted, before any journey takes a baseline of the display.
    const shipped = await runShippedBuildJourney({ origin, built })
    observations.push(...shipped.observations)
    evidence.journeys.push(...shipped.records)
    evidence.shippedPosture.artefacts = shipped.records[0]?.artefacts ?? null
    evidence.shippedPosture.delivery = shipped.records[0]?.delivery ?? null
    evidence.shippedPosture.wiredVerdict = shipped.records[0]?.wiredVerdict ?? null
    evidence.shippedPosture.rendererOptionsReadFromTheBuild = readRendererOptionsFromBuild()

    const journeyInput = { observer, origin, token, workArea: desktop.workArea, hubPid, built, fills }
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
    const needsYou = evidence.journeys.find((record) => record.journey === 'needs-you') ?? null
    evidence.shippedPosture.cardDocument = {
      path: CARD_DOCUMENT_PATH,
      status: needsYou?.cardDocumentStatus ?? null,
      servedIdentically: needsYou?.cardDocumentServed ?? null,
      contentSecurityPolicy: needsYou?.contentSecurityPolicy ?? null,
      provedBy: NEEDS_YOU_ASSERTIONS[6],
    }
    evidence.shippedPosture.pendingAfterARealBlock = needsYou?.pendingAfterIngest ?? null
    evidence.shippedPosture.pendingAfterTheAcknowledgement = needsYou?.pendingAfterAck ?? null
    evidence.shippedPosture.toastDeliveries = metrics?.toast_deliveries ?? null
    evidence.shippedPosture.cardWindowOnTheDisplayAtTheEnd =
      origin === null || hubPid === null ? null : cardOnScreenVerdict(observer.cardWindowFacts(hubPid).facts, hubPid)
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
    evidence.hubStopped = await hub.stop()
    evidence.childDiagnostics = {
      stdoutLines: hub.stdout,
      stderrLines: hub.stderr,
      note:
        `bounded at ${String(MAX_CHILD_OUTPUT_LINES)} lines each. The shipped entry point passes no onDiagnostic ` +
        'into startHub, so a reason a run can show no card is written nowhere by the product itself - see ' +
        'productChanges.open',
    }
    evidence.shippedPosture.diagnosticLines = [...hub.stderr, ...hub.stdout]
    const split = splitChildDiagnostics(evidence.shippedPosture.diagnosticLines)
    evidence.shippedPosture.productDiagnosticLines = split.product
    evidence.shippedPosture.chromiumDiagnosticLines = split.chromium
    evidence.shippedPosture.productDiagnosticCount = split.productCount
    evidence.shippedPosture.chromiumDiagnosticCount = split.chromiumCount
    centre.sealDuring()
    await centre.runPositiveControl()
    evidence.notificationCentre = centre.record
  }

  evidence.finishedAt = nowIso()
  evidence.timings.totalMs = Date.parse(evidence.finishedAt) - Date.parse(evidence.startedAt)
  evidence.timings.observerControlMs = control.elapsedMs ?? null
  evidence.productChanges = productChanges({
    shipped: { artefacts: evidence.shippedPosture.artefacts },
    productLineCount: evidence.shippedPosture.productDiagnosticCount ?? 0,
    chromiumLineCount: evidence.shippedPosture.chromiumDiagnosticCount ?? 0,
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
      ? "the product as shipped, built by this repository and started by this run with no seam supplied, put a " +
        'real card on a real display inside the work area, painted it with its own stylesheet fill for the class, ' +
        'held it while its block was outstanding, took it off the screen when the block was acknowledged through ' +
        "the product's own write route, expired a finished card on its own interval with nothing dismissing it, " +
        'and showed nothing at all for a session that did no work. See shippedPosture, seams, assertions, ' +
        'journeys and productChanges'
      : `the run exercised every assertion and ${String(decision.failures.length)} did not hold. The reasons ` +
        'are in failures and productChanges, and none of them was worked around'
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
  // One directory, and it holds a log, a token and a runtime file — nothing else. There is
  // no dashboard root beside it and no run-time document in it, because there is nothing
  // of the card path here to write: the whole of what this run produces is the evidence
  // file, in the repository, on request.
  const stateDir = path.join(tmpdir(), `agent-ping-surface-verify-${process.pid}-${Date.now()}`)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })

  let result
  try {
    result = await run({ pre, stateDir })
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
    if (args.keepState) log(`temporary state kept at ${stateDir}`)
    else rmSync(stateDir, { recursive: true, force: true })
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
      asserted: evidence.shippedPosture?.asserted ?? null,
      artefacts: evidence.shippedPosture?.artefacts ?? null,
      delivery: evidence.shippedPosture?.delivery ?? null,
      wiredVerdict: evidence.shippedPosture?.wiredVerdict ?? null,
      cardDocumentStatus: evidence.shippedPosture?.cardDocument?.status ?? null,
      cardWindowOnTheDisplayAtTheEnd: evidence.shippedPosture?.cardWindowOnTheDisplayAtTheEnd ?? null,
    },
    seamsSuppliedByThisRun: evidence.seams?.count ?? null,
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
  DesktopObserver,
  preflight,
  run,
  launchHub,
  readRuntimeFile,
}
