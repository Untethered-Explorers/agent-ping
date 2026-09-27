// The live session list: what the hub's session rows become on this page
// (LD-FR-01, LD-FR-02, APX-CON-09).
//
// WHAT THIS MODULE OWNS
// Four decisions, in one place so none of them can be made twice:
//
//   - Which of the four conditions a hub session is in. The store records six
//     states and the page shows four, so the mapping is a closed table rather than
//     a chain of `if`s, and it is total: a session is never rendered as a
//     condition this product has no word for.
//   - The icon and the word that carry that condition. `LIVE_STATE_ENCODING` is
//     typed against the four-value union, so a fifth condition cannot be added
//     without an icon and a label, and the test asserts the table is exhaustive,
//     that the four icons are four different shapes and the four words are four
//     different words (LD-FR-02: never colour alone).
//   - The grouping and the order. Identity is the repository short name
//     (APX-CON-09); sessions nest beneath it; blocked comes first within a group,
//     because those are the only rows that can need something.
//   - The one line of status, composed from the hub's own state name. No sentence
//     here could carry conversation content, because every one of them is a fixed
//     string chosen from a six-cell table (APX-FR-01).
//
// WHAT IT DOES NOT OWN
// The geometry. `layoutGroups` in ../prototype/scene is the approved layout and the
// live page draws with it, so the density a human signed off is the density live
// data gets. What this module adds on top of the approved plan is the two row
// marks the DP-4 review required and the prototype had no path for at all: a
// visible focus treatment and a visible activated state. Both are non-colour by
// construction - the focus is a filled band *and* a rail, and activation is a word
// in the row's own meta cell - so neither depends on seeing a hue.

import type { DrawCommand, LayoutGroup, ScenePlan, StateEncoding, StateIconName } from '../prototype/scene'
import { LAYOUT, composeStatusLine, formatAge, layoutGroups } from '../prototype/scene'
import type { HubSession, HubSessionState } from './stream-client'

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/**
 * The live page's colour tokens.
 *
 * The prototype's tokens are reused verbatim - the page background, the group
 * header, the row label, the muted text and the three state accents are the same
 * surface the review judged - and four tokens are added for what live data needs:
 * one more state accent, and the focus band's fill and rail.
 */
export const LIVE_COLORS = Object.freeze({
  pageBackground: 0x0f1115,
  groupHeaderText: 0xc7ccd8,
  rowLabelText: 0xf2f4f8,
  rowMutedText: 0xa8b0c0,
  rowDivider: 0x2a2f3a,
  blockedAccent: 0xff6b6b,
  finishedAccent: 0x7bd88f,
  runningAccent: 0x74a9ff,
  /** Neutral on purpose: this condition is the one that needs nothing. */
  informationAccent: 0x98a2b3,
  /** The focused row's band. A surface change, not a tint of any state accent. */
  focusFill: 0x1b2029,
  /** The focused row's rail. Bright, and a shape rather than a colour swap. */
  focusRail: 0xf2f4f8,
})

/** The focus mark's geometry, in the same units as LAYOUT. */
export const LIVE_FOCUS = Object.freeze({
  /** The rail's thickness. Thick enough to read as a mark at a glance. */
  railWidth: 3,
  /** How far the band stops short of the row's own edges. */
  insetX: 4,
  insetY: 3,
})

/** The word the activated row carries in its meta cell. Never a colour. */
export const ACTIVATED_MARKER = 'activated'
/** Between the age and that word. */
export const META_SEPARATOR = ' · '

// ---------------------------------------------------------------------------
// The four conditions
// ---------------------------------------------------------------------------

/**
 * The conditions a row is drawn in, and the only four LD-FR-02 names.
 *
 * Closed by construction, so `LIVE_STATE_ENCODING` below is exhaustive and a new
 * condition has to arrive with a shape and a word.
 */
export type LiveDisplayState = 'blocked' | 'finished' | 'running' | 'information-only'

/** Every condition, for the tests that walk the table rather than the fixture. */
export const LIVE_DISPLAY_STATES: readonly LiveDisplayState[] = Object.freeze([
  'blocked',
  'finished',
  'running',
  'information-only',
] as const satisfies readonly LiveDisplayState[])

/**
 * Which condition each of the hub's six session states is drawn as.
 *
 * Total, and the only two collapses are forced by the question the page answers:
 *
 *   - `gone` is drawn as finished. A session that is no longer there cannot need
 *     anything, and the row's status line says the session is gone.
 *   - `idle-after-nothing` and `unknown` are drawn as information-only. Both mean
 *     "nothing is known to need you", which is exactly what that condition is for,
 *     and neither may claim to be blocked: a row that says "Blocked" when nothing
 *     is waiting is the one lie this page must not tell.
 */
export const HUB_STATE_TO_DISPLAY: Readonly<Record<HubSessionState, LiveDisplayState>> =
  Object.freeze({
    blocked: 'blocked',
    running: 'running',
    finished: 'finished',
    gone: 'finished',
    'idle-after-nothing': 'information-only',
    unknown: 'information-only',
  })

/**
 * One line of status per hub state, in the product's own words.
 *
 * Keyed by the hub's six states rather than by the four conditions, because two
 * conditions cover two very different situations and one sentence each would have
 * to be vague enough to be wrong for one of them. Every cell is a fixed string, so
 * no field of the hub's data reaches this sentence.
 */
export const HUB_STATE_STATUS: Readonly<Record<HubSessionState, string>> = Object.freeze({
  blocked: 'waiting on you',
  running: 'working',
  finished: 'nothing further is needed',
  gone: 'the session is gone',
  'idle-after-nothing': 'went idle without needing anything',
  unknown: 'no state is recorded for this session',
})

/**
 * The non-colour encoding: a shape and a word, for every condition.
 *
 * `accent` tints the icon and nothing else. The live suite asserts that no text
 * command the plan draws carries one, the same way the prototype's suite does for
 * its three, because an accent on body text would make the accent the encoding.
 */
export const LIVE_STATE_ENCODING: Readonly<Record<LiveDisplayState, StateEncoding>> = Object.freeze({
  blocked: Object.freeze({
    icon: 'stop' as StateIconName,
    label: 'Blocked',
    token: '[stop]',
    accent: LIVE_COLORS.blockedAccent,
  }),
  finished: Object.freeze({
    icon: 'check' as StateIconName,
    label: 'Finished',
    token: '[check]',
    accent: LIVE_COLORS.finishedAccent,
  }),
  running: Object.freeze({
    icon: 'triangle' as StateIconName,
    label: 'Running',
    token: '[play]',
    accent: LIVE_COLORS.runningAccent,
  }),
  'information-only': Object.freeze({
    icon: 'dot' as StateIconName,
    label: 'Information only',
    token: '[info]',
    accent: LIVE_COLORS.informationAccent,
  }),
})

export function liveStateEncoding(state: LiveDisplayState): StateEncoding {
  return LIVE_STATE_ENCODING[state]
}

// ---------------------------------------------------------------------------
// The row model
// ---------------------------------------------------------------------------

/** One live row, in canvas order. Satisfies the DOM mirror's row model as it stands. */
export interface LiveRow {
  readonly sessionId: string
  readonly repositoryId: string
  readonly repositoryShortName: string
  readonly repositoryPath: string
  /** The condition, not the hub's own state name. */
  readonly state: LiveDisplayState
  /** The hub's own state name, carried for the mirror and for LD-3. */
  readonly hubState: HubSessionState
  readonly encoding: StateEncoding
  /** The row's short label: which harness the session ran in. */
  readonly label: string
  /** One line of state text. Never conversation content. */
  readonly status: string
  readonly age: string
  readonly pendingCount: number
  readonly harness: string
  readonly lastSeenAt: string
}

export interface LiveGroup {
  /** The short name. It is the identity, so it is also the group's key (APX-CON-09). */
  readonly repositoryId: string
  readonly shortName: string
  readonly path: string
  readonly rows: readonly LiveRow[]
}

/** The condition a hub session is drawn in. */
export function liveDisplayState(session: HubSession): LiveDisplayState {
  return HUB_STATE_TO_DISPLAY[session.state]
}

/**
 * The one line of status, plus the pending count when the session has any.
 *
 * The harness is the row's label: the hub stores no session title, and a title
 * invented from a session identifier would be a name this product made up. The
 * harness is the one thing a row can honestly say about itself that the state
 * sentence does not already say.
 */
export function sessionStatus(session: HubSession): string {
  const base = HUB_STATE_STATUS[session.state]
  return session.pendingCount > 0 ? `${base}${META_SEPARATOR}${String(session.pendingCount)} pending` : base
}

/** One hub session as a row: the condition, the encoding, the age, the status line. */
export function liveRow(session: HubSession, now: string, repositoryPath: string): LiveRow {
  const state = liveDisplayState(session)
  return {
    sessionId: session.sessionId,
    repositoryId: session.repoShortName,
    repositoryShortName: session.repoShortName,
    repositoryPath,
    state,
    hubState: session.state,
    encoding: liveStateEncoding(state),
    label: session.harness,
    status: sessionStatus(session),
    age: formatAge(session.lastSeenAt, now),
    pendingCount: session.pendingCount,
    harness: session.harness,
    lastSeenAt: session.lastSeenAt,
  }
}

/**
 * Order within a group: the rows that can need something first, then the most
 * recently active, then the identifier so the order is total and therefore stable
 * between two renders of the same data.
 */
const DISPLAY_RANK: Readonly<Record<LiveDisplayState, number>> = Object.freeze({
  blocked: 0,
  running: 1,
  'information-only': 2,
  finished: 3,
})

export function compareRows(left: LiveRow, right: LiveRow): number {
  const byState = DISPLAY_RANK[left.state] - DISPLAY_RANK[right.state]
  if (byState !== 0) return byState
  const byRecency = Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt)
  if (byRecency !== 0) return byRecency
  return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0
}

/**
 * Group the hub's sessions by repository short name, blocked rows first.
 *
 * Groups are ordered by short name, which is total and independent of when a block
 * arrives: a group that moved to the top of the page every time something in it
 * blocked would put rows under a developer's focus as a side effect of a change
 * somewhere else. Within a group the order is `compareRows`, so the blocked row is
 * the first thing found when scanning (LD-US-01) without the page reshuffling.
 *
 * A group is keyed by the short name, so two checkouts whose basenames are equal
 * are one group - that is the identity rule, not an oversight (APX-CON-09). The
 * revealed path is the one belonging to the lowest session identifier in the group,
 * so a state change can never change which path a group reveals.
 */
export function groupSessions(sessions: readonly HubSession[], now: string): readonly LiveGroup[] {
  const byShortName = new Map<string, { path: string; lowestId: string; sessions: HubSession[] }>()
  for (const session of sessions) {
    const key = session.repoShortName
    const existing = byShortName.get(key)
    if (existing === undefined) {
      byShortName.set(key, { path: session.repoFullPath, lowestId: session.sessionId, sessions: [session] })
      continue
    }
    existing.sessions.push(session)
    if (session.sessionId < existing.lowestId) {
      existing.lowestId = session.sessionId
      existing.path = session.repoFullPath
    }
  }

  return [...byShortName.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([shortName, group]) => ({
      repositoryId: shortName,
      shortName,
      path: group.path,
      rows: group.sessions
        .map((session) => liveRow(session, now, group.path))
        .sort(compareRows),
    }))
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface BuildLivePlanOptions {
  readonly width: number
  readonly height: number
  readonly now: string
  /** Repository whose full path is revealed. `null` for none. */
  readonly hoveredRepositoryId?: string | null
  /** The row the keyboard has focused. Painted, because DP-4 required it. */
  readonly focusedSessionId?: string | null
  /** The row the keyboard last activated. Painted, because DP-4 required it. */
  readonly activatedSessionId?: string | null
}

/**
 * Lay the live sessions out on the approved layout, with the two row marks the
 * design review required.
 *
 * The marks are added to the plan rather than by the painter, for the same reason
 * the plan exists: what the page draws is one value a test can read. The focus band
 * and its rail are inserted *before* the focused row's own commands so they sit
 * under its text, and activation extends the row's existing meta cell rather than
 * adding a column, because the review settled the row's four elements and this is
 * not a fifth.
 */
export function buildLivePlan(
  sessions: readonly HubSession[],
  options: BuildLivePlanOptions,
): ScenePlan<LiveDisplayState> {
  const groups = groupSessions(sessions, options.now)
  const layout: LayoutGroup<LiveDisplayState>[] = groups.map((group) => ({
    id: group.repositoryId,
    shortName: group.shortName,
    path: group.path,
    rows: group.rows.map((row) => ({
      id: row.sessionId,
      state: row.state,
      encoding: row.encoding,
      label: row.label,
      status: row.status,
      age: row.age,
    })),
  }))

  const base = layoutGroups(layout, {
    width: options.width,
    height: options.height,
    now: options.now,
    hoveredRepositoryId: options.hoveredRepositoryId ?? null,
  })

  // The plan's groups, rows, hover regions and geometry all come from the shared
  // layout untouched; only the draw commands gain the two marks DP-4 required.
  const focused = base.rows.find((row) => row.sessionId === options.focusedSessionId)
  const activated = base.rows.find((row) => row.sessionId === options.activatedSessionId)
  const marked =
    focused === undefined ? base : { ...base, draws: insertFocusMark(base.draws, focused, base.width) }

  return activated === undefined ? marked : { ...marked, draws: markActivated(marked.draws, activated) }
}

/**
 * Insert the focused row's band and rail immediately before that row's own
 * commands, so the row's text and icon are painted on top of the band.
 *
 * The rail is drawn separately from the band on purpose: a band alone is a fill
 * change, which is the one thing DP-4 said would not do, and a rail alone reads as
 * a border on a row that has none. Together they are a shape a monochrome reading
 * still sees.
 */
function insertFocusMark(
  draws: readonly DrawCommand[],
  row: { readonly y: number; readonly height: number },
  width: number,
): readonly DrawCommand[] {
  const firstIndex = draws.findIndex((command) => commandTopY(command) >= row.y)
  if (firstIndex < 0) return draws
  const bandWidth = Math.max(0, width - LAYOUT.pagePaddingX * 2)
  const mark: readonly DrawCommand[] = [
    {
      kind: 'rect',
      x: LAYOUT.pagePaddingX,
      y: row.y + LIVE_FOCUS.insetY,
      width: bandWidth,
      height: Math.max(0, row.height - LIVE_FOCUS.insetY * 2),
      fill: LIVE_COLORS.focusFill,
      radius: LAYOUT.cornerRadius,
    },
    {
      kind: 'rect',
      x: LAYOUT.pagePaddingX,
      y: row.y + LIVE_FOCUS.insetY,
      width: LIVE_FOCUS.railWidth,
      height: Math.max(0, row.height - LIVE_FOCUS.insetY * 2),
      fill: LIVE_COLORS.focusRail,
      radius: LAYOUT.cornerRadius,
    },
  ]
  return [...draws.slice(0, firstIndex), ...mark, ...draws.slice(firstIndex)]
}

/**
 * A command's top edge, for finding the first command that belongs to a row.
 *
 * A divider is a line rather than a rect, so it has two y values and the lower one
 * is its top. Getting this wrong would put the focus band one divider too low, which
 * looks like a focus mark on the row below.
 */
function commandTopY(command: DrawCommand): number {
  return command.kind === 'line' ? Math.min(command.y1, command.y2) : command.y
}

/**
 * Extend the activated row's meta cell with the word that says it was activated.
 *
 * A word rather than a colour or a fill, because a row that only changed shade is a
 * dead end for anyone who cannot see shades and for anyone reading the mirror. The
 * cell is the row's own age cell, which the approved layout already draws right
 * aligned and unclipped, so nothing about the row's geometry changes.
 */
function markActivated(
  draws: readonly DrawCommand[],
  row: { readonly y: number; readonly height: number },
): readonly DrawCommand[] {
  return draws.map((command) => {
    if (command.kind !== 'text' || command.role !== 'session-age') return command
    if (command.y < row.y || command.y >= row.y + row.height) return command
    if (command.text.includes(ACTIVATED_MARKER)) return command
    return { ...command, text: `${command.text}${META_SEPARATOR}${ACTIVATED_MARKER}` }
  })
}

// ---------------------------------------------------------------------------
// Reading a row the way the page does
// ---------------------------------------------------------------------------

/** The one line of status the canvas draws, composed exactly as the layout composes it. */
export function rowStatusLine(row: LiveRow): string {
  return composeStatusLine(row.label, row.status)
}
