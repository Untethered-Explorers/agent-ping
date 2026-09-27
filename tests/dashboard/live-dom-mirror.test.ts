// LD-2: the accessibility pattern carried onto live data, driven through the real
// mount entry point against a stubbed hub.
//
//   npm test -- tests/dashboard/live-dom-mirror.test.ts
//
// What is asserted here, against the four acceptance criteria:
//
//   1. One focusable mirror entry per visible row, in canvas order. The order is
//      read off the recorded command stream - the order the page actually painted -
//      and not off the plan's own row list, so a mirror that agreed with the plan
//      and disagreed with the picture would still fail.
//   2. Every entry exposes an accessible name, its state as an icon and a word, its
//      repository grouping, and its pending state.
//   3. The focused row keeps focus when a live update arrives for a different row.
//   4. A newly arrived blocked row produces no movement when reduced motion is
//      requested, while the state change itself stays visible.
//
// Plus the three things LD-FR-09 names that are not in those four: the page is
// operable from the keyboard end to end (traversal, activation, and a focused row
// that is scrolled to), the reduced-motion preference is honoured for every
// transition the feed can trigger, and the live theme's text meets AA against the
// background it is really painted on - which on the focused row is the focus band,
// not the page.
//
// What cannot be asserted in jsdom: the pixels and the browser's own focus
// rendering. jsdom applies no layout, so a row is a zero-height rect and a scroll
// is a recorded call; where that is the case the test says so at the assertion.
// `npm run build` and LD-4's browser journey are what prove the pixels.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MIRROR_ACTIVATED_CLASS,
  MIRROR_ACTIVATIONS_ATTRIBUTE,
  MIRROR_FOCUSED_ATTRIBUTE,
  MIRROR_FOCUSED_CLASS,
  MIRROR_ICON_ATTRIBUTE,
  MIRROR_ICON_TEXT_ATTRIBUTE,
  MIRROR_PENDING_ATTRIBUTE,
  MIRROR_REPOSITORY_ATTRIBUTE,
  MIRROR_ROOT_ATTRIBUTE,
  MIRROR_ROW_ATTRIBUTE,
  MIRROR_ROW_SELECTOR,
  MIRROR_STATE_ATTRIBUTE,
  MIRROR_STATE_LABEL_ATTRIBUTE,
  MIRROR_STYLE_ATTRIBUTE,
  MIRROR_STATUS_ATTRIBUTE,
  type MirrorRow,
  mirrorPending,
  mirrorRowName,
  mirrorStyleSheet,
} from '@/dashboard/a11y/dom-mirror'
import type { LiveDashboard } from '@/dashboard/main'
import { MIRROR_INSPECT_ATTRIBUTE, REVEAL_MARGIN_PX } from '@/dashboard/main'
import {
  ACTIVATED_MARKER,
  LIVE_COLORS,
  LIVE_DISPLAY_STATES,
  LIVE_FOCUS,
  LIVE_STATE_ENCODING,
} from '@/dashboard/live/session-list'
import type { DrawCommand } from '@/dashboard/prototype/scene'
import {
  MOTION_STATE_CHANGE_ATTRIBUTE,
  MOTION_SUPPRESSED_DECLARATION,
  MOTION_TRANSITION_DECLARATION,
  NON_ESSENTIAL_MOTION,
  STATE_CHANGE_MODE,
  motionAttribute,
} from '@/dashboard/theme/motion'
import {
  createStubHub,
  destroyLiveMounts,
  groupNames,
  hubSession,
  iconCommands,
  mountLiveDashboard,
  rectCommands,
  revealedPaths,
  rowText,
  textCommands,
  type LiveMount,
  type MountLiveOptions,
} from './live-harness'

const repositoryRoot = process.cwd()
const stylesheet = (): string => readFileSync(path.join(repositoryRoot, 'src/dashboard/dashboard.css'), 'utf8')

afterEach(() => {
  destroyLiveMounts()
  document.documentElement.removeAttribute(MIRROR_INSPECT_ATTRIBUTE)
})

// ---------------------------------------------------------------------------
// Fixtures: live-shaped sessions, one per condition
// ---------------------------------------------------------------------------

/**
 * Seven sessions across two repositories, covering all four conditions the live
 * page draws, with one blocked row in each group so the blocked-first ordering is
 * observable, and with pending counts that are not all the same.
 */
const fourConditions = [
  hubSession({
    sessionId: 'session-blocked',
    repoShortName: 'agent-ping',
    repoFullPath: '/home/dev/Projects/agent-ping',
    state: 'blocked',
    pendingCount: 2,
    lastSeenAt: '2026-09-27T11:58:00.000Z',
  }),
  hubSession({
    sessionId: 'session-running',
    repoShortName: 'agent-ping',
    repoFullPath: '/home/dev/Projects/agent-ping',
    state: 'running',
    pendingCount: 0,
    lastSeenAt: '2026-09-27T11:59:00.000Z',
  }),
  hubSession({
    sessionId: 'session-fyi',
    repoShortName: 'agent-ping',
    repoFullPath: '/home/dev/Projects/agent-ping',
    state: 'idle-after-nothing',
    pendingCount: 0,
    lastSeenAt: '2026-09-27T10:00:00.000Z',
  }),
  hubSession({
    sessionId: 'session-done',
    repoShortName: 'agent-ping',
    repoFullPath: '/home/dev/Projects/agent-ping',
    state: 'finished',
    pendingCount: 0,
    lastSeenAt: '2026-09-27T11:00:00.000Z',
  }),
  hubSession({
    sessionId: 'village-blocked',
    repoShortName: 'knowledge-dungeon',
    repoFullPath: '/home/dev/Projects/knowledge-dungeon',
    harness: 'copilot',
    state: 'blocked',
    pendingCount: 1,
    lastSeenAt: '2026-09-27T11:57:00.000Z',
  }),
  hubSession({
    sessionId: 'village-running',
    repoShortName: 'knowledge-dungeon',
    repoFullPath: '/home/dev/Projects/knowledge-dungeon',
    harness: 'copilot',
    state: 'running',
    lastSeenAt: '2026-09-27T11:59:30.000Z',
  }),
  hubSession({
    sessionId: 'village-gone',
    repoShortName: 'knowledge-dungeon',
    repoFullPath: '/home/dev/Projects/knowledge-dungeon',
    harness: 'copilot',
    state: 'gone',
    lastSeenAt: '2026-09-27T09:00:00.000Z',
  }),
]

/**
 * Twenty sessions across five repositories, which is what a busy afternoon looks
 * like and what the prototype's three rows never were. Density is where a layout
 * and a mirror disagree, so the ordering assertions are made against this as well.
 */
function denseSessions(): ReturnType<typeof hubSession>[] {
  const repositories = [
    'agent-ping',
    'forge-workflow-engine',
    'knowledge-dungeon',
    'pixi-playground',
    'village-game',
  ]
  const states = ['running', 'finished', 'idle-after-nothing', 'gone'] as const
  return repositories.flatMap((repo, index) =>
    states.map((state, nth) =>
      hubSession({
        sessionId: `dense-${index}-${nth}`,
        repoShortName: repo,
        repoFullPath: `/home/dev/Projects/${repo}`,
        state,
        lastSeenAt: `2026-09-27T${String(10 + nth).padStart(2, '0')}:00:00.000Z`,
      }),
    ),
  )
}

interface MountOptions {
  readonly pending?: readonly string[]
  readonly reducedMotion?: boolean
  readonly scrollRowIntoView?: MountLiveOptions['scrollRowIntoView']
}

/** Mount the real entry point, let the hub answer, and hand back the mount. */
async function mountWith(
  sessions: readonly ReturnType<typeof hubSession>[],
  options: MountOptions = {},
): Promise<LiveMount> {
  const hub = createStubHub({ sessions, pending: options.pending ?? [] })
  const mount = await mountLiveDashboard({
    hub,
    ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }),
    ...(options.scrollRowIntoView === undefined ? {} : { scrollRowIntoView: options.scrollRowIntoView }),
  })
  hub.ready(1)
  await mount.settle()
  return mount
}

// ---------------------------------------------------------------------------
// Reading the page
// ---------------------------------------------------------------------------

const entries = (mount: LiveMount): HTMLElement[] =>
  [...mount.container.querySelectorAll<HTMLElement>(MIRROR_ROW_SELECTOR)]

const attributeText = (entry: HTMLElement, attribute: string): string =>
  entry.querySelector(`[${attribute}]`)?.textContent ?? ''

const entryFor = (mount: LiveMount, sessionId: string): HTMLElement => {
  const entry = mount.dashboard.mirror.entryForSession(sessionId)
  if (entry === null) throw new Error(`${sessionId} has no mirror entry`)
  return entry
}

const focusedSession = (): string | null => document.activeElement?.getAttribute(MIRROR_ROW_ATTRIBUTE) ?? null

/** The list the page is listening on, which is what a keypress is delivered to. */
const dashboardRootOf = (mount: LiveMount): HTMLElement => mount.dashboard.mirror.root

/**
 * Mount, then deliver a change the keyboard controller is never told about.
 *
 * The mirror announces every rebuild it makes to the controller that keeps its entry
 * list fresh, so the controller holding nodes that are gone from the document takes
 * two things to reach: a caller that renders the mirror itself, and the window
 * between a rebuild and the announcement. Both leave the same shape behind - a
 * cached list of detached nodes beside a document holding the real one - and that
 * shape is what the three tests below drive one entry point at a time, each from
 * its own mount, so a fix for one cannot refresh the cache on behalf of another.
 */
async function mountWithUnannouncedRebuild(): Promise<{
  readonly mount: LiveMount
  readonly order: readonly string[]
}> {
  const mount = await mountWith(fourConditions)
  mount.dashboard.mirror.onRebuilt(() => {})
  // A change that changes the list's length, which is what makes a cached length the
  // wrong answer rather than a coincidentally right one.
  mount.hub.change({ cursor: 2, session: arrivedBlocked(), pendingCount: 4 })
  await mount.settle()
  const order = mount.dashboard.rows.map((row) => row.sessionId)
  expect(order).toHaveLength(8)
  expect(mount.dashboard.navigator.entries.some((entry) => !entry.isConnected)).toBe(true)
  return { mount, order }
}

/** The mode each declared effect is in on an element, `null` where it is not in play. */
const motionModes = (element: Element): readonly (string | null)[] =>
  NON_ESSENTIAL_MOTION.map((effect) => element.getAttribute(motionAttribute(effect)))

/**
 * The order the page painted its rows, read out of the command stream.
 *
 * The group headers come out in paint order, and each group contributes its rows
 * in the order the plan says it drew them, so this is the canvas's own order and
 * not the plan's row list restated. A mirror that sorted differently from the
 * picture fails against this and would not fail against `plan.rows` alone.
 */
function paintedRowOrder(dashboard: LiveDashboard, commands: readonly DrawCommand[]): readonly string[] {
  const order: string[] = []
  for (const shortName of groupNames(commands)) {
    const group = dashboard.plan.groups.find((candidate) => candidate.shortName === shortName)
    if (group === undefined) throw new Error(`the page painted a group the plan does not have: ${shortName}`)
    order.push(...group.rowIds)
  }
  return order
}

const pendingById = (dashboard: LiveDashboard): ReadonlyMap<string, number> =>
  new Map(dashboard.state.sessions.map((session) => [session.sessionId, session.pendingCount]))

/** A real keydown, as the browser would deliver it to the focused entry. */
function press(target: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

/** WCAG relative luminance of an sRGB colour given as 0xRRGGBB. */
function relativeLuminance(color: number): number {
  const channel = (value: number): number => {
    const srgb = value / 255
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  return (
    0.2126 * channel((color >> 16) & 0xff) +
    0.7152 * channel((color >> 8) & 0xff) +
    0.0722 * channel(color & 0xff)
  )
}

function contrastRatio(foreground: number, background: number): number {
  const first = relativeLuminance(foreground)
  const second = relativeLuminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

const AA_NORMAL_TEXT = 4.5
const AA_NON_TEXT = 3

/**
 * The fill actually painted behind a mark, from the command stream.
 *
 * Every rectangle painted before the mark that covers the mark's own position
 * counts, and the last one wins. Both coordinates matter: the focused row paints a
 * three-pixel rail as well as a band, and a probe that only looked at `y` would read
 * the rail's near-white as the background behind the row's own label - a ratio of
 * 1.0, and a test that fails for the wrong reason. For right-aligned text the probe
 * is one pixel to the left of the anchor, because that is where the glyphs are.
 *
 * `covered` is false when nothing painted a rectangle there, which happens for the
 * last row's status line: the approved layout's `contentHeight` is one page padding
 * shorter than the rows it lays out, so the final status line falls past the
 * surface the plan paints. The page's own `body` paints the same token underneath
 * it, which the stylesheet assertion in this suite pins, and the caller is told so
 * rather than handed a guess.
 */
function fillUnder(
  commands: readonly DrawCommand[],
  x: number,
  y: number,
): { readonly fill: number | null; readonly covered: boolean } {
  let fill: number | null = null
  for (const command of commands) {
    if (command.kind !== 'rect') continue
    const coversX = x >= command.x && x < command.x + command.width
    const coversY = y >= command.y && y < command.y + command.height
    if (coversX && coversY) fill = command.fill
  }
  return { fill, covered: fill !== null }
}

/** Where a drawn mark's glyphs are, for probing what is behind them. */
const probeX = (command: { readonly x: number; readonly align?: string }): number =>
  command.align === 'right' ? command.x - 1 : command.x

/**
 * One marked section of the stylesheet, comments included.
 *
 * Section titles live inside the comments that head them, so a slice starts at the
 * comment's opening `/*` rather than at the title text - otherwise the tail of the
 * comment is read as a rule - and ends at the next section's comment, or at the end
 * of the file.
 */
function cssSection(css: string, marker: string, until?: string): string {
  const at = css.indexOf(marker)
  if (at < 0) throw new Error(`dashboard.css has no section called "${marker}"`)
  const start = css.lastIndexOf('/*', at)
  const next = until === undefined ? -1 : css.indexOf(until, at)
  if (until !== undefined && next < 0) {
    throw new Error(`dashboard.css has no section after "${marker}" called "${until}"`)
  }
  const end = next < 0 ? css.length : css.lastIndexOf('/*', next)
  return css.slice(start, end)
}

const hex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`

/** The custom properties the page declares, as name to hexadecimal value. */
function declaredTokens(css: string): ReadonlyMap<string, number> {
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))
  const tokens = new Map<string, number>()
  for (const [, name, value] of root.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6});/gi)) {
    tokens.set(`--${name}`, Number.parseInt(value!.slice(1), 16))
  }
  return tokens
}

// ---------------------------------------------------------------------------
// 1. One focusable entry per visible row, in canvas order
// ---------------------------------------------------------------------------

describe('LD-2 the live mirror: one focusable entry per visible row, in canvas order', () => {
  it('holds one entry per painted row, in the order the page painted them', async () => {
    const mount = await mountWith(fourConditions)
    const { dashboard, target } = mount

    const painted = paintedRowOrder(dashboard, target.commands)
    const found = entries(mount)

    // The picture, not the plan: three rows, two repositories, and the blocked row
    // first in each group.
    expect(painted).toEqual([
      'session-blocked',
      'session-running',
      'session-fyi',
      'session-done',
      'village-blocked',
      'village-running',
      'village-gone',
    ])
    expect(found).toHaveLength(painted.length)
    expect(found.map((entry) => entry.getAttribute(MIRROR_ROW_ATTRIBUTE))).toEqual(painted)
    expect(dashboard.mirror.order).toEqual(painted)
    // One painted row per entry, and one entry per painted row, so a mirror entry
    // cannot be sitting on a row nothing drew.
    expect(textCommands(target.commands).filter((command) => command.role === 'session-state-label'))
      .toHaveLength(painted.length)
  })

  it('holds twenty rows across five repositories in the painted order', async () => {
    const mount = await mountWith(denseSessions())
    const { dashboard, target } = mount

    const painted = paintedRowOrder(dashboard, target.commands)

    expect(painted).toHaveLength(20)
    expect(new Set(dashboard.plan.groups.map((group) => group.shortName)).size).toBe(5)
    expect(dashboard.mirror.order).toEqual(painted)
    expect(entries(mount).map((entry) => entry.getAttribute(MIRROR_ROW_ATTRIBUTE))).toEqual(painted)
    // The surface grew to the rows rather than dropping the ones past its edge, so
    // every row the mirror names is a row that is on the page.
    expect(dashboard.plan.height).toBeGreaterThanOrEqual(dashboard.plan.contentHeight)
  })

  it('grows the surface past the last row it drew, so the last row is reachable', async () => {
    // The surface is the scrolling page, so its height decides whether the bottom
    // row can be scrolled into view at all. The approved layout's own
    // `contentHeight` stops one page padding short of the last row it laid out - the
    // same fact the contrast assertions here record for the final status line - so a
    // surface sized from it alone ends 27px above the last row's bottom edge, and
    // the page reaches its maximum scroll with that row still off the fold. A row the
    // keyboard can focus and never see is a dead end, and the extra height is empty
    // canvas below the last row: nothing in the layout moves.
    const mount = await mountWith(denseSessions())
    const { dashboard, host } = mount
    const lastRow = dashboard.rows[dashboard.rows.length - 1]!

    expect(dashboard.plan.height).toBeGreaterThanOrEqual(lastRow.y + lastRow.height)
    expect(host.getSize().height).toBeGreaterThanOrEqual(lastRow.y + lastRow.height)
    // Which is strictly more than the layout's own measure here, or the assertion
    // above would be satisfied by the measure alone and prove nothing.
    expect(lastRow.y + lastRow.height).toBeGreaterThan(dashboard.plan.contentHeight)
  })

  it('keeps the mirror in the painted order when a live change re-sorts a group', async () => {
    const mount = await mountWith(fourConditions)
    const { dashboard, hub, target } = mount

    // The information-only row becomes blocked, so it moves to the top of its group
    // and every row below it moves down one place.
    hub.change({
      cursor: 2,
      session: hubSession({
        sessionId: 'session-fyi',
        repoShortName: 'agent-ping',
        repoFullPath: '/home/dev/Projects/agent-ping',
        state: 'blocked',
        pendingCount: 1,
        lastSeenAt: '2026-09-27T11:59:45.000Z',
      }),
      pendingCount: 3,
    })
    await mount.settle()

    const painted = paintedRowOrder(dashboard, target.commands)
    expect(painted).toEqual([
      'session-fyi',
      'session-blocked',
      'session-running',
      'session-done',
      'village-blocked',
      'village-running',
      'village-gone',
    ])
    expect(dashboard.mirror.order).toEqual(painted)
    expect(dashboard.rows.map((row) => row.sessionId)).toEqual(painted)
  })

  it('makes every entry focusable, and the whole list one tab stop', async () => {
    const mount = await mountWith(fourConditions)
    const found = entries(mount)

    // Focusable: every entry carries a tabindex, so the arrows can reach all of
    // them. One tab stop: a list of seven, let alone twenty, tab stops is not
    // operable in practice, and the one that is must be the focused row.
    for (const entry of found) expect(entry.getAttribute('tabindex')).toMatch(/^(0|-1)$/)
    const tabStops = found.filter((entry) => entry.getAttribute('tabindex') === '0')
    expect(tabStops).toHaveLength(1)
    expect(tabStops[0]).toBe(found[0])

    // And it moves with focus, so the list cannot become unreachable by Tab once
    // the developer has walked into it.
    entryFor(mount, 'session-done').focus()
    expect(entries(mount).filter((entry) => entry.getAttribute('tabindex') === '0')).toEqual([
      entryFor(mount, 'session-done'),
    ])
    // Focus inside the mirror is real focus on a real element, not a node reference.
    expect(document.activeElement).toBe(entryFor(mount, 'session-done'))
  })

  it('mounts one mirror and one keyboard controller from the live entry point', async () => {
    const mount = await mountWith(fourConditions)
    const { dashboard, container } = mount

    // One of each, inside the container the page mounted into.
    expect(document.querySelectorAll(`[${MIRROR_ROOT_ATTRIBUTE}]`)).toHaveLength(1)
    expect(container.querySelector(`[${MIRROR_ROOT_ATTRIBUTE}]`)).toBe(dashboard.mirror.root)
    // The controller reads the same entries the mirror built, in the same order:
    // the two are the same list, not two lists that agree today.
    expect(dashboard.navigator.entries.map((entry) => entry.getAttribute(MIRROR_ROW_ATTRIBUTE)))
      .toEqual(dashboard.mirror.order)
    // The list carries a name of its own, so focus entering it says what it is.
    expect(dashboard.mirror.root.getAttribute('aria-label')).toBeTruthy()
    // The page's rules are linked, so nothing was injected for this page to carry.
    expect(document.querySelectorAll(`[${MIRROR_STYLE_ATTRIBUTE}]`)).toHaveLength(0)
  })

  it('leaves the mirror and the keyboard controller nothing behind on teardown', async () => {
    const mount = await mountWith(fourConditions)
    const { dashboard, container } = mount

    expect(entries(mount).length).toBeGreaterThan(0)
    entryFor(mount, 'session-running').focus()

    dashboard.destroy()

    expect(container.querySelector(`[${MIRROR_ROOT_ATTRIBUTE}]`)).toBeNull()
    expect(dashboard.mirror.isDestroyed).toBe(true)
    expect(dashboard.navigator.isDestroyed).toBe(true)
    expect(dashboard.motion.isDestroyed).toBe(true)
    expect(dashboard.activeSubscriptions).toBe(0)
    // A destroyed controller no longer answers the keyboard, which is the
    // difference between a teardown and a detached node.
    const before = document.activeElement
    press(dashboard.mirror.root, 'ArrowDown')
    expect(document.activeElement).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// 2. Accessible name, state text, repository grouping, pending state
// ---------------------------------------------------------------------------

describe('LD-2 the live mirror: accessible name, state, grouping and pending state', () => {
  it('gives every entry the accessible name its row carries', async () => {
    const mount = await mountWith(fourConditions)

    for (const row of mount.dashboard.rows) {
      const entry = entryFor(mount, row.sessionId)
      // One function builds the name and the elements, so the spoken name and the
      // DOM cannot describe different things. Asserted on textContent because that
      // is what a screen reader derives the name from.
      expect(entry.textContent, row.sessionId).toBe(mirrorRowName(row))
      expect(entry.textContent).toContain(row.repositoryShortName)
      expect(entry.textContent).toContain(row.status)
      expect(entry.textContent).toContain(`${row.age} ago`)
      // The full path is detail, never the label (APX-CON-09).
      expect(entry.textContent).not.toContain(row.repositoryPath)
      expect(entry.textContent).not.toContain('/home/dev/')
    }
  })

  it('states every condition as an icon and a word, on all four of them', async () => {
    const mount = await mountWith(fourConditions)
    const { dashboard, target } = mount

    // Exhaustive over the four conditions, not over the fixture: a fifth condition
    // cannot arrive without a shape and a word, and cannot be added to the table
    // without a label that differs from these four.
    expect(Object.keys(LIVE_STATE_ENCODING).sort()).toEqual([...LIVE_DISPLAY_STATES].sort())
    for (const state of LIVE_DISPLAY_STATES) {
      const encoding = LIVE_STATE_ENCODING[state]
      expect(encoding.icon, `${state} has a shape`).toBeTruthy()
      expect(encoding.label, `${state} has a word`).toBeTruthy()
      expect(encoding.token, `${state} has a reader token`).toBeTruthy()
    }
    expect(new Set(LIVE_DISPLAY_STATES.map((state) => LIVE_STATE_ENCODING[state].icon)).size).toBe(4)
    expect(new Set(LIVE_DISPLAY_STATES.map((state) => LIVE_STATE_ENCODING[state].label)).size).toBe(4)

    // And each of the four is actually on the page right now, in both renderers.
    for (const row of dashboard.rows) {
      const encoding = LIVE_STATE_ENCODING[row.state]
      const entry = entryFor(mount, row.sessionId)
      expect(entry.getAttribute(MIRROR_STATE_ATTRIBUTE), row.sessionId).toBe(row.state)
      expect(entry.getAttribute(MIRROR_ICON_ATTRIBUTE), row.sessionId).toBe(encoding.icon)
      expect(attributeText(entry, MIRROR_ICON_TEXT_ATTRIBUTE), row.sessionId).toBe(encoding.token)
      expect(attributeText(entry, MIRROR_STATE_LABEL_ATTRIBUTE), row.sessionId).toBe(encoding.label)
      // The canvas says the same thing in the same row: an icon there, and the word
      // itself rather than only the icon (LD-FR-02).
      expect(rowText(row, target.commands, 'session-state-label')).toBe(encoding.label)
      expect(
        iconCommands(target.commands).find(
          (command) => command.x >= row.y * 0 && command.y >= row.y && command.y < row.y + row.height,
        )?.icon,
      ).toBe(encoding.icon)
    }
  })

  it('nests every entry under its repository group, named by the short name', async () => {
    const mount = await mountWith(fourConditions)
    const { dashboard } = mount

    for (const group of dashboard.plan.groups) {
      const element = dashboard.mirror.groupForRepository(group.repositoryId)
      expect(element, `${group.shortName} has a group`).not.toBeNull()
      // The group's own list is named by the short-name heading, so focus entering
      // it announces which repository the rows below belong to.
      const heading = element?.querySelector('[data-mirror-group-label]')
      expect(heading?.textContent).toBe(group.shortName)
      const list = element?.querySelector('ul')
      expect(list?.getAttribute('aria-labelledby')).toBe(heading?.id)
      expect(
        dashboard.mirror
          .entriesForRepository(group.repositoryId)
          .map((entry) => entry.getAttribute(MIRROR_ROW_ATTRIBUTE)),
      ).toEqual([...group.rowIds])
    }

    for (const row of dashboard.rows) {
      const entry = entryFor(mount, row.sessionId)
      expect(entry.closest('[data-mirror-group]')?.getAttribute('data-mirror-group')).toBe(
        row.repositoryId,
      )
      expect(entry.getAttribute(MIRROR_REPOSITORY_ATTRIBUTE)).toBe(row.repositoryShortName)
      // The full path is carried as detail and is reachable on focus.
      expect(entry.getAttribute('data-mirror-path')).toBe(row.repositoryPath)
    }
  })

  it('carries the pending state on every entry, and says it exactly once', async () => {
    const mount = await mountWith(fourConditions, { pending: ['event-1', 'event-2', 'event-3'] })
    const pending = pendingById(mount.dashboard)

    for (const row of mount.dashboard.rows) {
      const entry = entryFor(mount, row.sessionId)
      // The machine-readable half, joined by session identity rather than position.
      expect(entry.getAttribute(MIRROR_PENDING_ATTRIBUTE), row.sessionId).toBe(
        String(pending.get(row.sessionId)),
      )
    }

    // Spoken once, in the status line the canvas also paints. A second copy in the
    // accessible name would make a screen reader say the same number twice, which
    // is why the count rides in the status and only the attribute was added.
    const blocked = entryFor(mount, 'session-blocked')
    expect(blocked.getAttribute(MIRROR_PENDING_ATTRIBUTE)).toBe('2')
    expect(blocked.textContent).toContain('2 pending')
    expect(blocked.textContent?.split('2 pending').length).toBe(2)
    expect(attributeText(blocked, MIRROR_STATUS_ATTRIBUTE)).toContain('2 pending')

    // A row waiting on nothing says so, in both halves.
    const running = entryFor(mount, 'session-running')
    expect(running.getAttribute(MIRROR_PENDING_ATTRIBUTE)).toBe('0')
    expect(running.textContent).not.toContain('pending')
  })

  it('updates the pending state when the hub says the count changed', async () => {
    const mount = await mountWith(fourConditions, { pending: ['event-1', 'event-2'] })
    const { dashboard, hub } = mount
    expect(entryFor(mount, 'session-blocked').getAttribute(MIRROR_PENDING_ATTRIBUTE)).toBe('2')

    hub.change({
      cursor: 2,
      kind: 'acknowledged',
      session: hubSession({
        sessionId: 'session-blocked',
        repoShortName: 'agent-ping',
        repoFullPath: '/home/dev/Projects/agent-ping',
        state: 'finished',
        pendingCount: 0,
        lastSeenAt: '2026-09-27T11:59:50.000Z',
      }),
      pendingCount: 0,
    })
    await mount.settle()

    const entry = entryFor(mount, 'session-blocked')
    expect(entry.getAttribute(MIRROR_PENDING_ATTRIBUTE)).toBe('0')
    expect(entry.getAttribute(MIRROR_STATE_ATTRIBUTE)).toBe('finished')
    expect(entry.textContent).not.toContain('pending')
    // Still exactly one entry for that session: the rebuild replaced it, it did not
    // append a second row for the same session.
    expect(entries(mount).filter((candidate) => candidate === entry)).toHaveLength(1)
    expect(entries(mount)).toHaveLength(dashboard.rows.length)
  })

  it('leaves the pending state off a row whose renderer has no count', async () => {
    const mount = await mountWith(fourConditions)
    const counted: MirrorRow = { ...mount.dashboard.rows[0]!, pendingCount: 2 }
    // Spelled out rather than destructured, because dropping a key to see what
    // happens without it is a statement about the shape, not a leftover variable.
    const withoutCount: MirrorRow = { ...counted, pendingCount: undefined }

    // Two different facts: a session waiting on nothing, and a renderer that has no
    // pending count to report at all. Only the live page has the second, and a
    // mirror that reported `0` for it would be claiming nothing needs the developer
    // on a surface that never said so.
    expect(mirrorPending(counted)).toBe('2')
    expect(mirrorPending(withoutCount)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. The page is keyboard operable, and focus survives a live update
// ---------------------------------------------------------------------------

describe('LD-2 the live page is operable from the keyboard', () => {
  it('walks the rows in visual order with the arrows, and the ends with Home and End', async () => {
    const mount = await mountWith(fourConditions)
    const painted = paintedRowOrder(mount.dashboard, mount.target.commands)
    const first = entryFor(mount, painted[0]!)

    first.focus()
    expect(focusedSession()).toBe(painted[0])

    // Forward through every row, one keypress each, exactly as a person would.
    const walked: (string | null)[] = []
    for (let step = 1; step < painted.length; step += 1) {
      const event = press(document.activeElement ?? first, 'ArrowDown')
      // Handled, so the page does not scroll underneath the traversal.
      expect(event.defaultPrevented, `ArrowDown ${step}`).toBe(true)
      walked.push(focusedSession())
    }
    expect(walked).toEqual(painted.slice(1))

    const up = press(document.activeElement ?? first, 'ArrowUp')
    expect(up.defaultPrevented).toBe(true)
    expect(focusedSession()).toBe(painted[painted.length - 2])

    expect(press(document.activeElement ?? first, 'End').defaultPrevented).toBe(true)
    expect(focusedSession()).toBe(painted[painted.length - 1])
    expect(press(document.activeElement ?? first, 'Home').defaultPrevented).toBe(true)
    expect(focusedSession()).toBe(painted[0])
  })

  it('leaves Tab alone, so the row list is one tab stop and not one per row', async () => {
    const mount = await mountWith(fourConditions)
    const first = entryFor(mount, mount.dashboard.rows[0]!.sessionId)
    first.focus()

    const event = press(first, 'Tab')

    // Not handled here: Tab leaves the row list and goes to the browser.
    expect(event.defaultPrevented).toBe(false)
    expect(focusedSession()).toBe(mount.dashboard.rows[0]!.sessionId)
    expect(entries(mount).filter((entry) => entry.getAttribute('tabindex') === '0')).toHaveLength(1)
  })

  it('ignores a modified key, so a browser shortcut is not a row command', async () => {
    const mount = await mountWith(fourConditions)
    const first = entryFor(mount, mount.dashboard.rows[0]!.sessionId)
    first.focus()

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
      metaKey: true,
    })
    first.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(focusedSession()).toBe(mount.dashboard.rows[0]!.sessionId)
  })

  it('reports activation for the focused row, on the element and on the page', async () => {
    const mount = await mountWith(fourConditions)
    const { dashboard, target } = mount
    const row = dashboard.rows[1]!
    const entry = entryFor(mount, row.sessionId)
    entry.focus()

    const enter = press(entry, 'Enter')
    expect(enter.defaultPrevented).toBe(true)
    // Three places a person or a test can see it: the element, the controller, and
    // the picture. A row that only changed colour would be a dead end for anyone
    // who cannot see it.
    expect(entry.getAttribute(MIRROR_ACTIVATIONS_ATTRIBUTE)).toBe('1')
    expect(entry.classList.contains(MIRROR_ACTIVATED_CLASS)).toBe(true)
    expect(dashboard.activatedSessionId).toBe(row.sessionId)
    expect(dashboard.navigator.lastActivation).toEqual({ sessionId: row.sessionId, key: 'Enter', count: 1 })
    expect(rowText(dashboard.rows[1]!, target.commands, 'session-age')).toContain(ACTIVATED_MARKER)

    // Space does the same thing, and each activation is counted.
    const space = press(entry, ' ')
    expect(space.defaultPrevented).toBe(true)
    expect(entry.getAttribute(MIRROR_ACTIVATIONS_ATTRIBUTE)).toBe('2')
    expect(dashboard.navigator.lastActivation).toEqual({ sessionId: row.sessionId, key: ' ', count: 2 })

    // A row that was never activated carries no mark.
    const other = entryFor(mount, dashboard.rows[0]!.sessionId)
    expect(other.hasAttribute(MIRROR_ACTIVATIONS_ATTRIBUTE)).toBe(false)
    expect(other.classList.contains(MIRROR_ACTIVATED_CLASS)).toBe(false)
  })

  it('keeps the activation on the same session when another row changes', async () => {
    const mount = await mountWith(fourConditions)
    const { dashboard, hub, target } = mount
    const row = dashboard.rows[2]!
    entryFor(mount, row.sessionId).focus()
    press(document.activeElement as Element, 'Enter')
    expect(dashboard.activatedSessionId).toBe(row.sessionId)

    hub.change({
      cursor: 2,
      session: hubSession({
        sessionId: 'village-running',
        repoShortName: 'knowledge-dungeon',
        repoFullPath: '/home/dev/Projects/knowledge-dungeon',
        harness: 'copilot',
        state: 'finished',
        lastSeenAt: '2026-09-27T11:59:55.000Z',
      }),
      pendingCount: 3,
    })
    await mount.settle()

    // Held by identity, exactly as focus is: an update elsewhere does not move it.
    expect(dashboard.activatedSessionId).toBe(row.sessionId)
    expect(entryFor(mount, row.sessionId).classList.contains(MIRROR_ACTIVATED_CLASS)).toBe(true)
    const row2 = dashboard.rows.find((candidate) => candidate.sessionId === row.sessionId)
    expect(row2).toBeDefined()
    expect(rowText(row2!, target.commands, 'session-age')).toContain(ACTIVATED_MARKER)
  })

  it('asks the page to bring a focused row into view', async () => {
    const mount = await mountWith(fourConditions)
    const { dashboard } = mount
    mount.revealed.length = 0

    // Every row focused in turn, by the keyboard, is asked for: the mirror is
    // clipped to a pixel, so nothing the browser scrolls reaches the row's real
    // position on a canvas taller than the window.
    for (const row of dashboard.rows) {
      const entry = entryFor(mount, row.sessionId)
      entry.focus()
      const asked = mount.revealed.at(-1)
      expect(asked?.sessionId, row.sessionId).toBe(row.sessionId)
      expect(asked?.y).toBe(row.y)
      expect(asked?.height).toBe(row.height)
    }
    expect(mount.revealed).toHaveLength(dashboard.rows.length)

    // Blurring does not ask for anything, and the page's own reveal is the only
    // caller.
    entryFor(mount, dashboard.rows[0]!.sessionId).focus()
    mount.revealed.length = 0
    entryFor(mount, dashboard.rows[0]!.sessionId).blur()
    expect(mount.revealed).toEqual([])
  })

  it('scrolls a row below the fold into view, smoothly or instantly per the preference', async () => {
    // The real implementation, observed through the window rather than a seam: it
    // needs a viewport and a layout, which jsdom has neither, so the geometry is
    // supplied here and the arithmetic is the shipped one.
    const originalScrollBy = globalThis.scrollBy
    const originalInnerHeight = Object.getOwnPropertyDescriptor(globalThis, 'innerHeight')
    const scrolls: { top: number; behavior: string }[] = []
    globalThis.scrollBy = ((options: { top: number; behavior?: string }) => {
      scrolls.push({ top: options.top, behavior: options.behavior ?? 'auto' })
    }) as typeof globalThis.scrollBy
    Object.defineProperty(globalThis, 'innerHeight', { value: 320, configurable: true })

    try {
      const mount = await mountWith(denseSessions(), { scrollRowIntoView: 'default' })
      const { dashboard, host } = mount
      // A canvas that starts below the fold, as a scrolled page's would.
      Object.defineProperty(host.canvas, 'getBoundingClientRect', {
        value: () => ({ top: 0, bottom: dashboard.plan.height, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }),
        configurable: true,
      })

      const last = dashboard.rows[dashboard.rows.length - 1]!
      entryFor(mount, last.sessionId).focus()

      // One scroll, by the amount that puts the last row's bottom edge at the
      // margin above the fold, and not before: a row already in view is left alone.
      expect(scrolls).toHaveLength(1)
      expect(scrolls[0]?.top).toBe(last.y + last.height - (320 - REVEAL_MARGIN_PX))
      expect(scrolls[0]?.behavior).toBe('smooth')

      scrolls.length = 0
      const first = dashboard.rows[0]!
      entryFor(mount, first.sessionId).focus()
      // The first row sits at the top, inside the margin, so there is nothing to do.
      expect(scrolls).toEqual([])

      // Under reduced motion the same scroll happens and does not slide: arriving
      // instantly is the whole of what the preference is allowed to take away here.
      const reduced = await mountWith(denseSessions(), {
        scrollRowIntoView: 'default',
        reducedMotion: true,
      })
      Object.defineProperty(reduced.host.canvas, 'getBoundingClientRect', {
        value: () => ({ top: 0, bottom: reduced.dashboard.plan.height, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }),
        configurable: true,
      })
      scrolls.length = 0
      const lastReduced = reduced.dashboard.rows[reduced.dashboard.rows.length - 1]!
      entryFor(reduced, lastReduced.sessionId).focus()
      expect(scrolls).toEqual([
        { top: lastReduced.y + lastReduced.height - (320 - REVEAL_MARGIN_PX), behavior: 'auto' },
      ])
    } finally {
      globalThis.scrollBy = originalScrollBy
      if (originalInnerHeight === undefined) {
        Reflect.deleteProperty(globalThis, 'innerHeight')
      } else {
        Object.defineProperty(globalThis, 'innerHeight', originalInnerHeight)
      }
    }
  })

  it('keeps the focused row focused when a live update arrives for a different row', async () => {
    const mount = await mountWith(fourConditions)
    const { dashboard, hub } = mount

    // The last row, so an implementation that always refocuses the first row cannot
    // pass this by accident, and a row in the second group, so the update can be
    // in a different group from the focus.
    const focused = dashboard.rows[dashboard.rows.length - 1]!
    const entry = entryFor(mount, focused.sessionId)
    entry.focus()
    expect(document.activeElement).toBe(entry)
    expect(dashboard.focusedSessionId).toBe(focused.sessionId)

    hub.change({
      cursor: 2,
      session: hubSession({
        sessionId: 'session-fyi',
        repoShortName: 'agent-ping',
        repoFullPath: '/home/dev/Projects/agent-ping',
        state: 'blocked',
        pendingCount: 1,
        lastSeenAt: '2026-09-27T11:59:40.000Z',
      }),
      pendingCount: 3,
    })
    await mount.settle()

    // The rebuild really happened, so this is focus held across a replacement and
    // not a render that was skipped.
    const after = entryFor(mount, focused.sessionId)
    expect(after).not.toBe(entry)
    expect(after.isConnected).toBe(true)
    expect(document.activeElement, 'focus stays on the same session').toBe(after)
    expect(focusedSession()).toBe(focused.sessionId)
    expect(dashboard.focusedSessionId).toBe(focused.sessionId)
    // The single tab stop moved with it, or the list is unreachable by Tab.
    expect(after.getAttribute('tabindex')).toBe('0')
    expect(entries(mount).filter((candidate) => candidate.getAttribute('tabindex') === '0')).toHaveLength(1)
    // And the mark is on the focused row, in the DOM and on the canvas.
    expect(after.getAttribute(MIRROR_FOCUSED_ATTRIBUTE)).toBe('true')
    expect(after.classList.contains(MIRROR_FOCUSED_CLASS)).toBe(true)
    const still = dashboard.rows.find((row) => row.sessionId === focused.sessionId)
    expect(still).toBeDefined()
    const rails = rectCommands(mount.target.commands).filter(
      (rect) => rect.fill === LIVE_COLORS.focusRail,
    )
    expect(rails).toHaveLength(1)
    expect(rails[0]?.y).toBeGreaterThanOrEqual(still!.y)
    // The mirror is still in the painted order after all of that.
    expect(dashboard.mirror.order).toEqual(
      paintedRowOrder(dashboard, mount.target.commands),
    )
  })

  it('keeps the focused row focused when a row above it arrives or the focused row changes', async () => {
    const mount = await mountWith(fourConditions)
    const { dashboard, hub } = mount
    const focused = dashboard.rows[1]!
    entryFor(mount, focused.sessionId).focus()
    const indexBefore = dashboard.mirror.order.indexOf(focused.sessionId)

    // A new blocked session arrives in the focused row's own group, above it.
    hub.change({
      cursor: 2,
      session: hubSession({
        sessionId: 'session-arrived',
        repoShortName: 'agent-ping',
        repoFullPath: '/home/dev/Projects/agent-ping',
        state: 'blocked',
        pendingCount: 1,
        lastSeenAt: '2026-09-27T11:59:58.000Z',
      }),
      pendingCount: 4,
    })
    await mount.settle()

    // The focused row moved down the page, and focus moved with it: identity, not
    // position, is what holds a focus across a re-sort.
    expect(dashboard.mirror.order[0]).toBe('session-arrived')
    expect(dashboard.mirror.order.indexOf(focused.sessionId)).toBe(indexBefore + 1)
    expect(focusedSession()).toBe(focused.sessionId)
    expect(entryFor(mount, focused.sessionId).getAttribute('tabindex')).toBe('0')

    // And the focused row's own condition changing is the same story.
    hub.change({
      cursor: 3,
      session: hubSession({
        sessionId: focused.sessionId,
        repoShortName: 'agent-ping',
        repoFullPath: '/home/dev/Projects/agent-ping',
        state: 'blocked',
        pendingCount: 2,
        lastSeenAt: '2026-09-27T11:59:59.000Z',
      }),
      pendingCount: 4,
    })
    await mount.settle()

    expect(focusedSession()).toBe(focused.sessionId)
    expect(entryFor(mount, focused.sessionId).getAttribute(MIRROR_STATE_ATTRIBUTE)).toBe('blocked')
  })

  it('moves focus to a surviving row when the focused session is gone', async () => {
    const mount = await mountWith(fourConditions)
    const { dashboard, hub } = mount
    const last = dashboard.rows[dashboard.rows.length - 1]!
    entryFor(mount, last.sessionId).focus()
    expect(focusedSession()).toBe(last.sessionId)

    // The hub says this page is too far behind and the session is no longer in the
    // re-read: the one case where the focused row cannot survive, because it is not
    // there any more.
    hub.setSnapshot({ sessions: fourConditions.filter((session) => session.sessionId !== last.sessionId) })
    hub.refreshRequired({ reason: 'cursor-too-old', currentCursor: 99 })
    await mount.settle()

    expect(dashboard.rows.map((row) => row.sessionId)).not.toContain(last.sessionId)
    // Focus stays inside the list rather than falling to the body, which is what an
    // implementation with no retention path does.
    expect(document.activeElement).not.toBe(document.body)
    expect(focusedSession()).toBe(dashboard.rows[dashboard.rows.length - 1]!.sessionId)
    expect(dashboard.focusedSessionId).toBe(focusedSession())
  })

  it('focuses a row by identity even when a rebuild has not been announced', async () => {
    const mount = await mountWith(fourConditions)
    const { dashboard, hub } = mount

    // The mirror's rebuild hook is the fast path that keeps the controller's cached
    // list fresh. Dropping it here is the case a caller hits when it renders the
    // mirror itself: the entries are new and the controller has not been told.
    dashboard.mirror.onRebuilt(() => {})
    hub.change({
      cursor: 2,
      session: hubSession({
        sessionId: 'session-arrived',
        repoShortName: 'agent-ping',
        repoFullPath: '/home/dev/Projects/agent-ping',
        state: 'blocked',
        pendingCount: 1,
        lastSeenAt: '2026-09-27T11:59:58.000Z',
      }),
      pendingCount: 4,
    })
    await mount.settle()

    const before = dashboard.navigator.entries.at(0)
    const focused = dashboard.navigator.focusSession('session-arrived')
    // Not the stale node, and not a silent no-op: the row the caller named.
    expect(focused).not.toBe(before)
    expect(focusedSession()).toBe('session-arrived')
    expect(focused?.getAttribute('tabindex')).toBe('0')
    // And a row that genuinely is not there still reports nothing rather than
    // moving focus somewhere arbitrary.
    const held = focusedSession()
    expect(dashboard.navigator.focusSession('session-that-never-existed')).toBeNull()
    expect(focusedSession()).toBe(held)
  })

  it('keeps traversing by visual position when a rebuild was not announced', async () => {
    // The same unannounced rebuild, reached with the arrows rather than by name.
    // A controller that worked only from its cached list would either focus a node
    // that is no longer in the document - which focuses nothing at all, so the
    // keyboard simply stops - or, having lost track of where the focused row now
    // sits, jump back to the top of the list. Either is a person arrowing down a
    // list of rows and the page taking them somewhere they did not ask for.
    const mount = await mountWith(fourConditions)
    const { dashboard, hub } = mount
    dashboard.mirror.onRebuilt(() => {})

    const third = dashboard.rows[2]!.sessionId
    entryFor(mount, third).focus()
    expect(focusedSession()).toBe(third)

    // A blocked row arrives at the top of its group, so every row below it moves
    // down one place and the row that had focus moves with the feed.
    hub.change({
      cursor: 2,
      session: arrivedBlocked(),
      pendingCount: 4,
    })
    await mount.settle()

    // The controller still holds nodes that are gone from the document.
    expect(dashboard.navigator.entries.some((entry) => !entry.isConnected)).toBe(true)
    expect(focusedSession()).toBe(third)

    // One press forward from the focused row lands on the row the page painted
    // after it - the session that follows `third` in the new order.
    const order = dashboard.rows.map((row) => row.sessionId)
    const expected = order[order.indexOf(third) + 1]!
    press(document.activeElement as Element, 'ArrowDown')
    expect(focusedSession()).toBe(expected)
    // The mirror and the canvas still agree, and the tab stop went with focus.
    expect(dashboard.mirror.order).toEqual(order)
    expect(
      dashboard.mirror
        .order.map((sessionId) => mount.dashboard.mirror.entryForSession(sessionId))
        .filter((entry) => entry?.getAttribute('tabindex') === '0'),
    ).toEqual([entryFor(mount, expected)])

    // And backward returns to where it started, which is the other half of the same
    // traversal.
    press(document.activeElement as Element, 'ArrowUp')
    expect(focusedSession()).toBe(third)
  })

  it('takes End from the list as it is, after an unannounced rebuild', async () => {
    // End takes a position rather than an offset, so it reads the list without
    // consulting where focus is - the path where the position comes from the
    // controller's own cached length. Focusing a node from before the rebuild would
    // move nothing at all, and a list whose End key does nothing reads as a broken
    // keyboard; clamping a stale length into the new list is worse, because it
    // lands on a row nobody asked for with no keypress to explain it.
    const { mount, order } = await mountWithUnannouncedRebuild()

    press(dashboardRootOf(mount), 'End')
    expect(focusedSession()).toBe(order[order.length - 1])
  })

  it('takes Home from the list as it is, after an unannounced rebuild', async () => {
    const { mount, order } = await mountWithUnannouncedRebuild()

    press(dashboardRootOf(mount), 'End')
    press(dashboardRootOf(mount), 'Home')
    expect(focusedSession()).toBe(order[0])
  })

  it('focuses a position the caller read from the list as it is, after an unannounced rebuild', async () => {
    // The public positional method, which is what an external caller reaches for
    // when it has a list of its own. A position computed from a list read before the
    // rebuild is a position in a list that no longer exists, and focusing the node
    // at that position in the cached one does nothing at all - the keypress appears
    // to be ignored, which is the failure mode this whole path exists to prevent.
    const { mount, order } = await mountWithUnannouncedRebuild()
    const stale = mount.dashboard.navigator.entries[3]
    expect(stale?.isConnected).toBe(false)

    const focused = mount.dashboard.navigator.focusIndex(3)
    expect(focusedSession()).toBe(order[3])
    expect(focused).toBe(entryFor(mount, order[3]!))
    // The roving tab stop followed it, so the list stays one tab stop.
    expect(entryFor(mount, order[3]!).getAttribute('tabindex')).toBe('0')
  })

  it('keeps an activation count across a rebuild of the whole list', async () => {
    const mount = await mountWith(fourConditions)
    const { dashboard } = mount
    const row = dashboard.rows[1]!
    const entry = entryFor(mount, row.sessionId)
    entry.focus()
    press(entry, 'Enter')
    press(entry, ' ')
    expect(entry.getAttribute(MIRROR_ACTIVATIONS_ATTRIBUTE)).toBe('2')
    expect(dashboard.navigator.lastActivation).toEqual({ sessionId: row.sessionId, key: ' ', count: 2 })

    // The list is rebuilt from scratch, so the element that carried the count is
    // gone. Held by session identity instead, the count is put back on the row that
    // has it - a count that resets to zero on the next hub frame would make the
    // activation history a lie for anyone reading it.
    dashboard.mirror.onRebuilt(() => {})
    mount.hub.change({
      cursor: 2,
      session: hubSession({
        sessionId: 'village-running',
        repoShortName: 'knowledge-dungeon',
        repoFullPath: '/home/dev/Projects/knowledge-dungeon',
        harness: 'copilot',
        state: 'finished',
        lastSeenAt: '2026-09-27T11:59:55.000Z',
      }),
      pendingCount: 3,
    })
    await mount.settle()
    dashboard.navigator.refresh()

    const rebuilt = entryFor(mount, row.sessionId)
    expect(rebuilt).not.toBe(entry)
    expect(rebuilt.getAttribute(MIRROR_ACTIVATIONS_ATTRIBUTE)).toBe('2')
    expect(rebuilt.classList.contains(MIRROR_ACTIVATED_CLASS)).toBe(true)
    expect(dashboard.activatedSessionId).toBe(row.sessionId)
    // And it keeps counting from there rather than from the attribute's new value.
    rebuilt.focus()
    press(rebuilt, 'Enter')
    expect(rebuilt.getAttribute(MIRROR_ACTIVATIONS_ATTRIBUTE)).toBe('3')
    expect(dashboard.navigator.lastActivation).toEqual({ sessionId: row.sessionId, key: 'Enter', count: 3 })
  })
})

// ---------------------------------------------------------------------------
// 4. Reduced motion, including a newly arrived blocked row
// ---------------------------------------------------------------------------

/** One session that arrives in the blocked condition, for the arrival tests. */
function arrivedBlocked(): ReturnType<typeof hubSession> {
  return hubSession({
    sessionId: 'session-arrived',
    repoShortName: 'agent-ping',
    repoFullPath: '/home/dev/Projects/agent-ping',
    state: 'blocked',
    pendingCount: 1,
    lastSeenAt: '2026-09-27T11:59:58.000Z',
  })
}

/** Mount, then deliver one change that brings a blocked session into the page. */
async function mountThenArrive(
  options: { reducedMotion?: boolean } = {},
): Promise<LiveMount> {
  const mount = await mountWith(fourConditions, {
    ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }),
  })
  mount.hub.change({ cursor: 2, session: arrivedBlocked(), pendingCount: 4 })
  await mount.settle()
  return mount
}

describe('LD-2 reduced motion: a newly arrived blocked row produces no movement', () => {
  it('marks the arrived row instant, and nothing on the page animated', async () => {
    const mount = await mountThenArrive({ reducedMotion: true })
    const { dashboard } = mount
    expect(mount.preference?.preference?.matches).toBe(true)
    expect(dashboard.motion.reducedMotion).toBe(true)

    // The row really arrived, and really arrived blocked: an arrival assertion
    // against a page that never moved proves nothing.
    const row = dashboard.rows.find((candidate) => candidate.sessionId === 'session-arrived')
    expect(row).toBeDefined()
    expect(row?.state).toBe('blocked')
    expect(dashboard.mirror.order[0]).toBe('session-arrived')
    expect(rowText(row!, mount.target.commands, 'session-state-label')).toBe('Blocked')

    // No movement: the arrival is in play, and the mode it is in is the one the
    // policy produces under the preference, which is not the one a transition
    // selects.
    const entry = entryFor(mount, 'session-arrived')
    expect(entry.getAttribute(motionAttribute('state-arrival'))).toBe('instant')
    expect(motionModes(entry)).not.toContain('animated')
    // Nothing anywhere on the page is in the animated mode, so there is no rule
    // that could move anything: the whole surface, not just this row.
    const animated = [...document.querySelectorAll('*')].filter((element) =>
      NON_ESSENTIAL_MOTION.some((effect) => element.getAttribute(motionAttribute(effect)) === 'animated'),
    )
    expect(animated).toEqual([])
  })

  it('keeps the arrived state visible while suppressing the movement', async () => {
    const mount = await mountThenArrive({ reducedMotion: true })
    const entry = entryFor(mount, 'session-arrived')

    // A state change is information, not movement: it is marked, and the sheet
    // declares no transition for the attribute it is marked with, so it appears in
    // place rather than not at all.
    expect(entry.getAttribute(MOTION_STATE_CHANGE_ATTRIBUTE)).toBe(STATE_CHANGE_MODE)
    const css = stylesheet()
    const stateRule = css.slice(css.indexOf(`[data-motion-state-change='${STATE_CHANGE_MODE}']`))
    expect(stateRule.slice(0, stateRule.indexOf('}'))).not.toContain('transition')
    // And the word is on the row, in both renderers: the change was not swallowed
    // with the animation.
    expect(entry.getAttribute(MIRROR_STATE_ATTRIBUTE)).toBe('blocked')
    expect(attributeText(entry, MIRROR_STATE_LABEL_ATTRIBUTE)).toBe(
      LIVE_STATE_ENCODING.blocked.label,
    )
    expect(entry.getAttribute(MIRROR_ICON_ATTRIBUTE)).toBe(LIVE_STATE_ENCODING.blocked.icon)
  })

  it('animates the same arrival when the preference is not set, and paints the same picture', async () => {
    const reduced = await mountThenArrive({ reducedMotion: true })
    const allowed = await mountThenArrive({ reducedMotion: false })

    const reducedEntry = entryFor(reduced, 'session-arrived')
    const allowedEntry = entryFor(allowed, 'session-arrived')

    // The control for the assertion above: with no preference the same arrival is in
    // the animated mode, so the difference is the preference and not a constant.
    expect(reducedEntry.getAttribute(motionAttribute('state-arrival'))).toBe('instant')
    expect(allowedEntry.getAttribute(motionAttribute('state-arrival'))).toBe('animated')
    expect(allowed.dashboard.motion.reducedMotion).toBe(false)

    // And the picture is identical either way, so "no movement" is a property of
    // the policy and not of what the plan happens to draw.
    expect(allowed.target.commands).toEqual(reduced.target.commands)
    expect(allowed.dashboard.rows.map((row) => `${row.sessionId}:${row.state}:${row.y}`)).toEqual(
      reduced.dashboard.rows.map((row) => `${row.sessionId}:${row.state}:${row.y}`),
    )
  })

  it('suppresses the focus indicator and the revealed path too, and still reveals the path', async () => {
    const mount = await mountWith(fourConditions, { reducedMotion: true })
    const { dashboard } = mount
    const row = dashboard.rows[1]!
    const entry = entryFor(mount, row.sessionId)

    entry.focus()

    // Both are decoration and both are suppressed; the path itself is information
    // and is still revealed, because a keyboard user gets what a pointer user gets
    // whatever the preference is.
    expect(entry.getAttribute(motionAttribute('focus-indicator'))).toBe('instant')
    const group = dashboard.mirror.groupForRepository(row.repositoryId)
    expect(group?.getAttribute(motionAttribute('full-path-reveal'))).toBe('instant')
    expect(revealedPaths(mount.target.commands)).toEqual([row.repositoryPath])
    expect(entry.getAttribute('data-mirror-path')).toBe(row.repositoryPath)

    // The focus mark itself is still on the row: suppressing the movement must not
    // mean losing the indicator.
    expect(entry.getAttribute(MIRROR_FOCUSED_ATTRIBUTE)).toBe('true')
    const rails = rectCommands(mount.target.commands).filter(
      (rect) => rect.fill === LIVE_COLORS.focusRail,
    )
    expect(rails).toHaveLength(1)
  })

  it('re-reads the preference when it changes, with no remount', async () => {
    const mount = await mountWith(fourConditions, { reducedMotion: false })
    const { dashboard } = mount
    const row = dashboard.rows[1]!
    const entry = entryFor(mount, row.sessionId)
    entry.focus()
    expect(entry.getAttribute(motionAttribute('focus-indicator'))).toBe('animated')

    // A developer who turns reduced motion on expects the next row that arrives to
    // stop moving without reloading the page.
    mount.preference?.set(true)

    expect(dashboard.motion.reducedMotion).toBe(true)
    expect(entry.getAttribute(motionAttribute('focus-indicator'))).toBe('instant')
    const group = dashboard.mirror.groupForRepository(row.repositoryId)
    expect(group?.getAttribute(motionAttribute('full-path-reveal'))).toBe('instant')

    // And the next arrival is suppressed from then on.
    mount.hub.change({ cursor: 2, session: arrivedBlocked(), pendingCount: 4 })
    await mount.settle()
    expect(entryFor(mount, 'session-arrived').getAttribute(motionAttribute('state-arrival'))).toBe(
      'instant',
    )
  })

  it('carries the mirror\'s own motion rules in the page\'s linked stylesheet', () => {
    const css = stylesheet()
    const sheet = mirrorStyleSheet()

    // The page asks the mirror not to inject its sheet, because the hub's policy
    // refuses an inline <style> element. That is an obligation: the rules have to
    // arrive by a route the policy allows, or the preference has nothing to switch
    // off on this page.
    const section = cssSection(css, "The mirror's motion rules", 'The inspection flag')
    const declarations = section
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !['{', '}', '},'].includes(line))
    expect(declarations.length).toBeGreaterThan(0)
    // Every line the page writes is a line the module's own sheet writes, so the
    // two copies cannot drift: a changed duration or a renamed effect in either
    // place fails here rather than on a page that quietly stopped honouring it.
    for (const line of declarations) {
      expect(sheet.includes(line), `dashboard.css carries "${line}" from the mirror's sheet`).toBe(true)
    }

    // Named rather than merely present: one animated selector per declared effect.
    for (const effect of NON_ESSENTIAL_MOTION) {
      expect(section).toContain(`.dashboard-mirror [${motionAttribute(effect)}='animated']`)
    }
    expect(section).toContain(MOTION_TRANSITION_DECLARATION.trim())
    expect(section.replace(/\s+/g, ' ')).toContain(
      MOTION_SUPPRESSED_DECLARATION.replace(/\s+/g, ' '),
    )
    expect(section).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('declares no transition anywhere else on the page', () => {
    const css = stylesheet().replace(/\/\*[\s\S]*?\*\//g, '')

    // Every transition this page can apply is one of the two the policy declares:
    // the animated-mode declaration, and the reduced-motion backstop that switches
    // all of them off. Any other `transition` on this page would be movement the
    // policy does not know about, and a preference that could not reach it.
    const declarations = [...css.matchAll(/transition:[^;]+;/g)].map((match) => match[0])
    expect(declarations).toEqual([
      MOTION_TRANSITION_DECLARATION.trim(),
      MOTION_SUPPRESSED_DECLARATION.split(';')[0]!.trim() + ';',
    ])
    // And an animation appears only inside that backstop.
    expect([...css.matchAll(/animation:/g)]).toHaveLength(1)
    // The state change is marked on the row, and no rule transitions that marker:
    // a state change is information, so it appears in place.
    expect(css).toContain(`[data-motion-state-change='${STATE_CHANGE_MODE}']`)
    const stateRule = css.slice(css.indexOf(`[data-motion-state-change='${STATE_CHANGE_MODE}']`))
    expect(stateRule.slice(0, stateRule.indexOf('}'))).not.toContain('transition')
  })
})

// ---------------------------------------------------------------------------
// 5. The live theme's text meets AA against the background it is painted on
// ---------------------------------------------------------------------------

describe('LD-2 the live theme meets AA against the surfaces it is painted on', () => {
  it('meets AA for every piece of text the plan draws, including on a focused row', async () => {
    const mount = await mountWith(denseSessions())
    const { dashboard, target } = mount
    // Focus a row in the middle, so the band is under its text and the other rows
    // are measured against the page.
    const focused = dashboard.rows[Math.floor(dashboard.rows.length / 2)]!
    entryFor(mount, focused.sessionId).focus()

    const texts = textCommands(target.commands)
    expect(texts.length).toBeGreaterThan(0)
    let measuredOnTheBand = 0
    const pastTheSurface: { readonly text: string; readonly y: number }[] = []
    for (const command of texts) {
      const { fill, covered } = fillUnder(target.commands, probeX(command), command.y)
      // Past the painted surface, the page's own body background is what is behind
      // the glyphs, and it is the same token. Pinned rather than assumed, and named
      // in the report as an observation about the approved layout rather than
      // something this task changed.
      const background = fill ?? LIVE_COLORS.pageBackground
      if (!covered) pastTheSurface.push({ text: command.text, y: command.y })
      if (fill === LIVE_COLORS.focusFill) measuredOnTheBand += 1
      expect(
        contrastRatio(command.color, background),
        `"${command.text}" over ${hex(background)}`,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
    }
    // Not vacuous: the focused row's own text was measured against the band, which
    // is the pair a page-level assertion cannot see.
    expect(measuredOnTheBand).toBeGreaterThan(0)
    // And the one place the plan's own surface does not reach is the final row's
    // status line, which the body paints in the same colour. If the layout ever
    // stops doing that - or spills anywhere else - this fails rather than quietly
    // measuring against a background nothing is actually painted.
    const lastRow = dashboard.rows[dashboard.rows.length - 1]!
    for (const mark of pastTheSurface) expect(mark.y).toBeGreaterThanOrEqual(lastRow.y)
    expect(pastTheSurface.length).toBeLessThanOrEqual(1)
    expect(stylesheet()).toContain('background: var(--page-background)')
  })

  it('meets the non-text ratio for every state icon, on every surface it sits on', async () => {
    // The fixture that carries all four conditions, so each shape is checked where
    // it actually lands rather than where a table says it could.
    const mount = await mountWith(fourConditions)
    const { dashboard, target } = mount
    const focused = dashboard.rows[Math.floor(dashboard.rows.length / 2)]!
    entryFor(mount, focused.sessionId).focus()

    const icons = iconCommands(target.commands)
    // All four conditions are on this page, so each shape is checked where it lands.
    expect(new Set(icons.map((command) => command.icon)).size).toBe(4)
    for (const command of icons) {
      const { fill, covered } = fillUnder(target.commands, probeX(command), command.y)
      // An icon always sits inside the surface the plan paints; a state icon drawn
      // past it would be a shape on the body's colour with no surface behind it,
      // which is a contrast claim this suite could not make.
      expect(covered, `${command.icon} is painted over the surface`).toBe(true)
      expect(
        contrastRatio(command.color, fill as number),
        `${command.icon} over ${hex(fill as number)}`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT)
    }
    // And no body text is tinted with a state accent, so a hue is never the only
    // cue (APX-CON-07).
    const accents = new Set(LIVE_DISPLAY_STATES.map((state) => LIVE_STATE_ENCODING[state].accent))
    for (const command of textCommands(target.commands)) {
      expect(accents.has(command.color), `"${command.text}" is not a state accent`).toBe(false)
    }
  })

  it('makes the focus indicator a rail that meets the non-text ratio on both surfaces', async () => {
    const mount = await mountWith(fourConditions)
    const { dashboard, target } = mount
    const row = dashboard.rows[1]!
    entryFor(mount, row.sessionId).focus()

    const rails = rectCommands(target.commands).filter((rect) => rect.fill === LIVE_COLORS.focusRail)
    const bands = rectCommands(target.commands).filter((rect) => rect.fill === LIVE_COLORS.focusFill)
    expect(rails).toHaveLength(1)
    expect(bands).toHaveLength(1)
    // The indicator is a shape, not only a colour: a rail of the declared
    // thickness, drawn inside the focused row's own band.
    expect(rails[0]?.width).toBe(LIVE_FOCUS.railWidth)
    expect(rails[0]?.y).toBeGreaterThanOrEqual(row.y)
    expect((rails[0]?.y ?? 0) + (rails[0]?.height ?? 0)).toBeLessThanOrEqual(row.y + row.height)
    // Against the band it sits on and against the page around it, because it has to
    // be visible in both.
    for (const background of [LIVE_COLORS.focusFill, LIVE_COLORS.pageBackground]) {
      expect(contrastRatio(LIVE_COLORS.focusRail, background), `rail over ${hex(background)}`)
        .toBeGreaterThanOrEqual(AA_NON_TEXT)
    }
  })

  it('paints the page header with the same two tokens the canvas uses, and both meet AA', async () => {
    const css = stylesheet()
    const tokens = declaredTokens(css)

    // One theme. The header's text and the canvas's text are the same values, so a
    // change to one is a change to both and cannot leave the DOM quietly illegible
    // behind a canvas that is fine.
    expect(tokens.get('--page-background')).toBe(LIVE_COLORS.pageBackground)
    expect(tokens.get('--row-label-text')).toBe(LIVE_COLORS.rowLabelText)
    expect(tokens.get('--row-muted-text')).toBe(LIVE_COLORS.rowMutedText)
    expect(tokens.get('--focus-fill')).toBe(LIVE_COLORS.focusFill)
    expect(tokens.get('--focus-rail')).toBe(LIVE_COLORS.focusRail)

    // No text anywhere in the stylesheet is coloured by anything else, so every
    // piece of text on the page is one of the two checked pairs below.
    const colours = [...css.matchAll(/(?:^|[;{]\s*)color:\s*([^;]+);/g)].map((match) => match[1]!.trim())
    expect(colours.length).toBeGreaterThan(0)
    for (const colour of colours) {
      expect(['var(--row-label-text)', 'var(--row-muted-text)'], `colour: ${colour}`).toContain(colour)
    }

    // The two checked pairs, against the backgrounds they are actually used on.
    const page = LIVE_COLORS.pageBackground
    for (const text of [LIVE_COLORS.rowLabelText, LIVE_COLORS.rowMutedText]) {
      expect(contrastRatio(text, page), `${hex(text)} on ${hex(page)}`).toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT,
      )
    }
    // The mirror's focused row paints the label token on the focus fill, which is
    // the second surface the same token is used on.
    const focusedRule = css.slice(css.indexOf('html[data-mirror-inspect=\'visible\'] .dashboard-mirror .is-focused'))
    expect(focusedRule.slice(0, focusedRule.indexOf('}'))).toContain('background: var(--focus-fill)')
    expect(contrastRatio(LIVE_COLORS.rowLabelText, LIVE_COLORS.focusFill)).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT,
    )

    // And no state accent appears in the stylesheet at all, so nothing in the DOM
    // is encoded by a hue the live page can change.
    const cssColours = [...css.matchAll(/#[0-9a-f]{6}/gi)].map((match) => Number.parseInt(match[0].slice(1), 16))
    const accents = new Set(LIVE_DISPLAY_STATES.map((state) => LIVE_STATE_ENCODING[state].accent))
    for (const colour of cssColours) {
      expect(accents.has(colour), `${hex(colour)} is not a state accent`).toBe(false)
    }
    // The only literal is the approved row divider, the same value the prototype
    // painted with, so this page adds no colour of its own.
    for (const colour of cssColours) {
      expect([LIVE_COLORS.rowDivider, ...[...tokens.values()]].includes(colour)).toBe(true)
    }
  })

  it('says the connection state in words, and emphasises it with more than colour', async () => {
    const mount = await mountWith(fourConditions)
    const { dashboard, hub, header } = mount
    expect(dashboard.state.connection).toBe('live')
    const live = header.querySelector('[data-dashboard-connection-text]')?.textContent
    expect(live).toBe('Live')

    hub.drop()
    await mount.settle()

    // The words change, which is the encoding; the weight is what backs it up, so a
    // stale page cannot be distinguished by hue alone (APX-CON-07).
    const stale = header.querySelector('[data-dashboard-connection-text]')?.textContent
    expect(stale).not.toBe(live)
    expect(stale).toContain('Stale')
    const rule = stylesheet().slice(
      stylesheet().indexOf("[data-dashboard-connection='stale']"),
    )
    const block = rule.slice(0, rule.indexOf('}'))
    expect(block).toContain('color: var(--row-label-text)')
    expect(block).toContain('font-weight')
  })
})
