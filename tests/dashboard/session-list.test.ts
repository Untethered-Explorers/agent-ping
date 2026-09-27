// LD-1: the live dashboard's rows, driven through the exported mount entry point
// against a stubbed hub.
//
//   npm test -- tests/dashboard/session-list.test.ts
//
// What is asserted here:
//
//   - LD-FR-01: sessions group under the repository short name, nest beneath it,
//     and the full path is revealed on hover and on focus without ever being the
//     primary label.
//   - LD-FR-02: every condition is an icon and a word, the four are distinct from
//     each other, and no piece of text is tinted with a state colour.
//   - LD-FR-03: a change updates the affected row, and a dropped connection shows
//     an explicit stale state rather than quiet old rows.
//   - LD-FR-04: the count the page prints is the hub's own unacknowledged count.
//   - APX-CON-07: every painted row has a focusable mirror entry in the same order,
//     the mirror's hiding rules survive the hub's strict content-security-policy,
//     and the live text tokens meet AA against the surface they are painted on.
//
// What cannot be asserted in jsdom: the pixels, exactly as the prototype suite says
// of itself. The assertions are made against the real mount and the exact command
// stream the browser would paint; `npm run build` and LD-4's browser journey are
// what prove the pixels.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MIRROR_ICON_ATTRIBUTE,
  MIRROR_PATH_ATTRIBUTE,
  MIRROR_REPOSITORY_ATTRIBUTE,
  MIRROR_ROW_ATTRIBUTE,
  MIRROR_STATE_ATTRIBUTE,
  MIRROR_STATE_LABEL_ATTRIBUTE,
  MIRROR_STYLE_ATTRIBUTE,
  mirrorStyleSheet,
} from '@/dashboard/a11y/dom-mirror'
import { DASHBOARD_ROOT_ATTRIBUTE } from '@/dashboard/host'
import {
  CONNECTION_TEXT,
  DASHBOARD_CONNECTION_ATTRIBUTE,
  connectionText,
  DASHBOARD_CONNECTION_TEXT_ATTRIBUTE,
  DASHBOARD_HEADER_ATTRIBUTE,
  DASHBOARD_PENDING_ATTRIBUTE,
  LIVE_AGE_TICK_MS,
  MIRROR_INSPECT_ATTRIBUTE,
  applyInspectionFlag,
  mountDashboard,
  pendingText,
  reportMountFailure,
} from '@/dashboard/main'
import {
  ACTIVATED_MARKER,
  HUB_STATE_STATUS,
  HUB_STATE_TO_DISPLAY,
  LIVE_COLORS,
  LIVE_DISPLAY_STATES,
  LIVE_STATE_ENCODING,
  buildLivePlan,
  groupSessions,
  liveDisplayState,
  sessionStatus,
} from '@/dashboard/live/session-list'
import { LAYOUT, PROTOTYPE_COLORS } from '@/dashboard/prototype/scene'
import { parsePendingCount } from '@/dashboard/live/stream-client'
import type { LiveDisplayState } from '@/dashboard/live/session-list'
import {
  LIVE_NOW,
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
} from './live-harness'

const repositoryRoot = process.cwd()

afterEach(() => {
  destroyLiveMounts()
  document.documentElement.removeAttribute(MIRROR_INSPECT_ATTRIBUTE)
})

/** The two rows of one repository and one row of another, blocked first by the renderer. */
const twoRepositories = [
  hubSession({
    sessionId: 'session-ack',
    repoShortName: 'agent-ping',
    repoFullPath: '/home/dev/Projects/agent-ping',
    state: 'finished',
    lastSeenAt: '2026-09-27T11:00:00.000Z',
  }),
  hubSession({
    sessionId: 'session-render',
    repoShortName: 'agent-ping',
    repoFullPath: '/home/dev/Projects/agent-ping',
    state: 'blocked',
    pendingCount: 2,
    lastSeenAt: '2026-09-27T11:58:00.000Z',
  }),
  hubSession({
    sessionId: 'session-harness',
    repoShortName: 'knowledge-dungeon',
    repoFullPath: '/home/dev/Projects/knowledge-dungeon',
    harness: 'copilot',
    state: 'running',
    lastSeenAt: '2026-09-27T11:59:00.000Z',
  }),
  hubSession({
    sessionId: 'session-note',
    repoShortName: 'knowledge-dungeon',
    repoFullPath: '/home/dev/Projects/knowledge-dungeon',
    harness: 'copilot',
    state: 'idle-after-nothing',
    lastSeenAt: '2026-09-27T10:00:00.000Z',
  }),
]

/** Mount the real entry point, let the hub open and answer, and hand back the mount. */
async function mountWith(
  sessions: readonly ReturnType<typeof hubSession>[],
  options: { pending?: readonly string[] } = {},
): Promise<LiveMount> {
  const hub = createStubHub({ sessions, pending: options.pending ?? [] })
  const mount = await mountLiveDashboard({ hub })
  hub.ready(1)
  await mount.settle()
  return mount
}

// ---------------------------------------------------------------------------
// LD-FR-01: grouping, nesting, and the full path as detail
// ---------------------------------------------------------------------------

describe('LD-1 grouping: sessions nest under the repository short name', () => {
  it('draws one group header per short name, with the blocked row first in its group', async () => {
    const { dashboard, target } = await mountWith(twoRepositories)

    // The fixture hands the renderer a finished row before the blocked one, so the
    // order below is the renderer's doing and not the fixture's.
    expect(groupNames(target.commands)).toEqual(['agent-ping', 'knowledge-dungeon'])
    expect(dashboard.plan.groups.map((group) => group.shortName)).toEqual([
      'agent-ping',
      'knowledge-dungeon',
    ])
    expect(dashboard.plan.groups[0]?.rowIds).toEqual(['session-render', 'session-ack'])
    expect(dashboard.plan.groups[1]?.rowIds).toEqual(['session-harness', 'session-note'])
    expect(dashboard.rows.map((row) => row.sessionId)).toEqual([
      'session-render',
      'session-ack',
      'session-harness',
      'session-note',
    ])
  })

  it('labels every row with its short name and never with the full path', async () => {
    const { dashboard, target } = await mountWith(twoRepositories)
    const shortNames = textCommands(target.commands).filter(
      (command) => command.role === 'repository-short-name',
    )
    for (const command of shortNames) {
      expect(command.text).not.toContain('/')
    }
    // The full path is absent until it is asked for, in every role: a path that is
    // painted before it is revealed is a path that has become the primary label.
    expect(revealedPaths(target.commands)).toEqual([])
    for (const row of dashboard.rows) {
      expect(row.repositoryShortName).toBe(
        row.repositoryShortName === 'agent-ping' ? 'agent-ping' : 'knowledge-dungeon',
      )
    }
  })

  it('reveals the full path on hover, and hides it again on leave', async () => {
    const { dashboard, target, hoverRepository } = await mountWith(twoRepositories)

    hoverRepository('agent-ping')
    expect(revealedPaths(target.commands)).toEqual(['/home/dev/Projects/agent-ping'])
    // The short name is still what the group is called, and still drawn.
    expect(groupNames(target.commands)).toEqual(['agent-ping', 'knowledge-dungeon'])

    hoverRepository(null)
    expect(revealedPaths(target.commands)).toEqual([])
    expect(dashboard.plan.hoveredRepositoryId).toBeNull()
  })

  it('reveals the same full path on focus, so a keyboard user gets what a pointer gets', async () => {
    const { dashboard, target } = await mountWith(twoRepositories)

    const entry = dashboard.mirror.entryForSession('session-ack')
    expect(entry).not.toBeNull()
    entry?.focus()

    expect(revealedPaths(target.commands)).toEqual(['/home/dev/Projects/agent-ping'])
    expect(dashboard.focusedSessionId).toBe('session-ack')
    expect(groupNames(target.commands)).toEqual(['agent-ping', 'knowledge-dungeon'])
  })

  it('gives the pointer a region per group, so hover is wired to real geometry', async () => {
    const { target } = await mountWith(twoRepositories)
    expect(target.regions.map((region) => region.repositoryId)).toEqual([
      'agent-ping',
      'knowledge-dungeon',
    ])
    expect(target.regions[0]?.height).toBeGreaterThan(0)
  })

  it('treats two checkouts with the same basename as one group, because the short name is the identity', async () => {
    // APX-CON-09 makes the short name the identity, so two checkouts the product
    // cannot tell apart are one group rather than two rows under an empty header.
    const sameName = [
      hubSession({ sessionId: 'a', repoShortName: 'agent-ping', repoFullPath: '/a/agent-ping' }),
      hubSession({ sessionId: 'b', repoShortName: 'agent-ping', repoFullPath: '/b/agent-ping' }),
    ]
    const groups = groupSessions(sameName, LIVE_NOW)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.repositoryId).toBe('agent-ping')
    expect(groups[0]?.rows.map((row) => row.sessionId)).toEqual(['a', 'b'])
    // The revealed path belongs to the lowest session identifier, so a state
    // change can never change which path the group shows.
    expect(groups[0]?.path).toBe('/a/agent-ping')
  })
})

// ---------------------------------------------------------------------------
// LD-FR-02: four conditions, an icon and a word
// ---------------------------------------------------------------------------

describe('LD-1 conditions: an icon and a word, never colour alone', () => {
  it('encodes every condition with a distinct shape and a distinct word', () => {
    expect(Object.keys(LIVE_STATE_ENCODING).sort()).toEqual([...LIVE_DISPLAY_STATES].sort())
    for (const state of LIVE_DISPLAY_STATES) {
      const encoding = LIVE_STATE_ENCODING[state]
      expect(encoding.icon, `${state} has a shape`).toBeTruthy()
      expect(encoding.label, `${state} has a word`).toBeTruthy()
      expect(encoding.token, `${state} has a reader token`).toBeTruthy()
    }
    expect(new Set(LIVE_DISPLAY_STATES.map((state) => LIVE_STATE_ENCODING[state].icon)).size).toBe(4)
    expect(new Set(LIVE_DISPLAY_STATES.map((state) => LIVE_STATE_ENCODING[state].label)).size).toBe(4)
    expect(new Set(LIVE_DISPLAY_STATES.map((state) => LIVE_STATE_ENCODING[state].token)).size).toBe(4)
  })

  it('maps all six of the hub\'s own session states onto the four conditions', () => {
    // Total over the hub's union, so a state the store adds is a compile error here
    // rather than a session drawn as a condition this product has no word for.
    expect(Object.keys(HUB_STATE_TO_DISPLAY).sort()).toEqual(
      [
        'blocked',
        'finished',
        'gone',
        'idle-after-nothing',
        'running',
        'unknown',
      ].sort(),
    )
    expect(Object.keys(HUB_STATE_STATUS).sort()).toEqual(Object.keys(HUB_STATE_TO_DISPLAY).sort())
    for (const hubState of Object.keys(HUB_STATE_TO_DISPLAY) as (keyof typeof HUB_STATE_TO_DISPLAY)[]) {
      expect(LIVE_DISPLAY_STATES).toContain(HUB_STATE_TO_DISPLAY[hubState])
      expect(HUB_STATE_STATUS[hubState].length).toBeGreaterThan(0)
    }
    // The two collapses are the forced ones and nothing else: a session that is
    // gone cannot need anything, and an idle-after-nothing session never blocked.
    expect(HUB_STATE_TO_DISPLAY.blocked).toBe('blocked')
    expect(HUB_STATE_TO_DISPLAY.running).toBe('running')
    expect(HUB_STATE_TO_DISPLAY.finished).toBe('finished')
    expect(HUB_STATE_TO_DISPLAY.gone).toBe('finished')
    expect(HUB_STATE_TO_DISPLAY['idle-after-nothing']).toBe('information-only')
    expect(HUB_STATE_TO_DISPLAY.unknown).toBe('information-only')
  })

  it('draws all six of the hub\'s own session states as one of the four conditions', () => {
    // Exhaustive over the hub's union rather than over the fixture, so a session
    // state the store adds cannot arrive on this page without a condition.
    const drawn = new Set<LiveDisplayState>()
    for (const hubState of Object.keys(HUB_STATE_TO_DISPLAY) as (keyof typeof HUB_STATE_TO_DISPLAY)[]) {
      const row = liveDisplayState(hubSession({ state: hubState }))
      expect(LIVE_DISPLAY_STATES, `${hubState} is one of the four`).toContain(row)
      expect(LIVE_STATE_ENCODING[row].label.length).toBeGreaterThan(0)
      drawn.add(row)
    }
    expect([...drawn].sort()).toEqual([...LIVE_DISPLAY_STATES].sort())
  })

  it('draws all four conditions on the canvas and spells every one of them out', async () => {
    const all = LIVE_DISPLAY_STATES.map((state, index) =>
      hubSession({
        sessionId: `session-${state}`,
        repoShortName: 'agent-ping',
        state:
          state === 'information-only'
            ? 'idle-after-nothing'
            : (state as 'blocked' | 'finished' | 'running'),
        lastSeenAt: `2026-09-27T1${9 - index}:00:00.000Z`,
      }),
    )
    const { dashboard, target } = await mountWith(all)
    const icons = iconCommands(target.commands)

    for (const state of LIVE_DISPLAY_STATES) {
      const row = dashboard.rows.find((candidate) => candidate.state === state)
      expect(row, `a ${state} row is rendered`).toBeDefined()
      if (row === undefined) continue
      expect(rowText(row, target.commands, 'session-state-label')).toBe(LIVE_STATE_ENCODING[state].label)
      const entry = dashboard.mirror.entryForSession(row.sessionId)
      expect(entry?.getAttribute(MIRROR_ICON_ATTRIBUTE)).toBe(LIVE_STATE_ENCODING[state].icon)
      expect(
        entry?.querySelector(`[${MIRROR_STATE_LABEL_ATTRIBUTE}]`)?.textContent,
      ).toBe(LIVE_STATE_ENCODING[state].label)
    }
    expect(new Set(icons.map((icon) => icon.icon)).size).toBe(4)
  })

  it('never tints body text with a state colour', async () => {
    const all = LIVE_DISPLAY_STATES.map((state) =>
      hubSession({
        sessionId: `session-${state}`,
        state: state === 'information-only' ? 'idle-after-nothing' : (state as 'blocked'),
      }),
    )
    const { target } = await mountWith(all)
    const accents = new Set(LIVE_DISPLAY_STATES.map((state) => LIVE_STATE_ENCODING[state].accent))

    for (const command of textCommands(target.commands)) {
      expect(accents.has(command.color), `text "${command.text}" is not a state accent`).toBe(false)
    }
    for (const icon of iconCommands(target.commands)) {
      expect(accents.has(icon.color)).toBe(true)
    }
  })

  it('gives every row an age and one line of status, and nothing else', async () => {
    const { dashboard, target } = await mountWith(twoRepositories)
    const ages = new Map(
      twoRepositories.map((session) => [session.sessionId, compactAge(session.lastSeenAt)] as const),
    )
    for (const row of dashboard.rows) {
      expect(row.age).toBe(ages.get(row.sessionId))
      expect(rowText(row, target.commands, 'session-age')).toBe(row.age)
      const status = rowText(row, target.commands, 'session-status')
      expect(status).toContain(row.label)
      expect(status).toContain(row.status)
    }
  })

  it('says what the session is waiting on, in one line, with the pending count when it has one', () => {
    expect(sessionStatus(hubSession({ state: 'blocked' }))).toBe('waiting on you')
    expect(sessionStatus(hubSession({ state: 'blocked', pendingCount: 3 }))).toBe(
      'waiting on you · 3 pending',
    )
    expect(sessionStatus(hubSession({ state: 'gone' }))).toBe('the session is gone')
    expect(sessionStatus(hubSession({ state: 'unknown' }))).toBe(
      'no state is recorded for this session',
    )
  })
})

// ---------------------------------------------------------------------------
// LD-FR-03: a live update, and a stale page that says so
// ---------------------------------------------------------------------------

describe('LD-1 live updates: the affected row changes and the page does not reload', () => {
  it('repaints the affected row and moves it to the top of its group, with no re-read', async () => {
    const before = [
      hubSession({ sessionId: 'session-a', state: 'running', lastSeenAt: '2026-09-27T11:50:00.000Z' }),
      hubSession({ sessionId: 'session-b', state: 'finished', lastSeenAt: '2026-09-27T11:40:00.000Z' }),
    ]
    const hub = createStubHub({ sessions: before, pending: [] })
    const mount = await mountLiveDashboard({ hub })
    hub.ready(1)
    await mount.settle()

    const { dashboard, target, host, container } = mount
    expect(dashboard.rows.map((row) => row.sessionId)).toEqual(['session-a', 'session-b'])
    const readsBefore = hub.reads
    const canvasBefore = dashboard.host.canvas
    const sizesBefore = host.sizes.length

    // The hub says session-a blocked. Nothing else changed.
    hub.change({
      cursor: 2,
      session: hubSession({
        sessionId: 'session-a',
        state: 'blocked',
        pendingCount: 1,
        lastSeenAt: '2026-09-27T11:59:00.000Z',
      }),
      pendingCount: 1,
    })
    await mount.settle()

    // The same page: one canvas, no re-read, no re-mount.
    expect(container.querySelectorAll('canvas')).toHaveLength(1)
    expect(dashboard.host.canvas).toBe(canvasBefore)
    expect(host.sizes.length).toBe(sizesBefore)
    expect(hub.reads).toBe(readsBefore)

    // The affected row changed, and the blocked one is now first in its group.
    expect(dashboard.rows.map((row) => row.sessionId)).toEqual(['session-a', 'session-b'])
    const row = dashboard.rows[0]
    expect(row?.state).toBe('blocked')
    expect(rowText(row!, target.commands, 'session-state-label')).toBe('Blocked')
    expect(
      iconCommands(target.commands).some((icon) => icon.icon === 'stop' && icon.y >= row!.y && icon.y < row!.y + row!.height),
    ).toBe(true)
    // The row that did not change did not move or change.
    const other = dashboard.rows[1]
    expect(rowText(other!, target.commands, 'session-state-label')).toBe('Finished')

    // And the mirror followed the canvas, in the same order.
    expect(dashboard.mirror.order).toEqual(['session-a', 'session-b'])
    expect(dashboard.mirror.entryForSession('session-a')?.getAttribute(MIRROR_STATE_ATTRIBUTE)).toBe(
      'blocked',
    )
  })

  it('shows an explicit stale state when the connection drops, and never a confident count', async () => {
    const mount = await mountWith(twoRepositories, { pending: ['event-1'] })
    const { dashboard, header, hub } = mount
    expect(header.getAttribute(DASHBOARD_CONNECTION_ATTRIBUTE)).toBe('live')
    expect(header.querySelector(`[${DASHBOARD_PENDING_ATTRIBUTE}]`)?.textContent).toBe('1 pending')

    hub.drop()

    // The rows are still there, and the page says so in words.
    expect(dashboard.rows).toHaveLength(4)
    expect(header.getAttribute(DASHBOARD_CONNECTION_ATTRIBUTE)).toBe('stale')
    const line = header.querySelector(`[${DASHBOARD_CONNECTION_TEXT_ATTRIBUTE}]`)?.textContent ?? ''
    expect(line).toContain('Stale')
    expect(line).toContain('the last it sent')
    // The count is qualified rather than presented as current: a stale page next
    // to a bare `0 pending` reads as "nothing needs me".
    expect(header.querySelector(`[${DASHBOARD_PENDING_ATTRIBUTE}]`)?.textContent).toBe(
      '1 pending (last known)',
    )
  })

  it('is loud about a stale state without depending on colour', () => {
    expect(CONNECTION_TEXT.stale).toContain('the last it sent')
    expect(CONNECTION_TEXT.disconnected).toContain('the last it sent')
    // Every state has words. A state with no words is a dot and a hue, which is
    // the encoding this product refuses.
    for (const text of Object.values(CONNECTION_TEXT)) expect(text.length).toBeGreaterThan(0)
  })

  it('says the cause in one sentence per clause, with no doubled full stop', () => {
    // A real browser's screenshot read "it sent.. Not retrying", which is a header
    // nobody finishes reading.
    const line = connectionText({
      ...blankState(),
      connection: 'disconnected',
      updatedAt: LIVE_NOW,
      problem: { kind: 'gave-up' },
    })
    expect(line).toBe(
      'Disconnected: the hub is not answering. The rows below are the last it sent. Not retrying',
    )
    expect(line).not.toContain('..')
    expect(
      connectionText({
        ...blankState(),
        connection: 'live',
        updatedAt: LIVE_NOW,
        problem: { kind: 'refresh-required', reason: 'cursor-too-old' },
      }),
    ).toBe('Live. Re-reading the hub: this page was too far behind (cursor-too-old)')
    // No problem, no clause: the plain state is the whole sentence.
    expect(connectionText({ ...blankState(), connection: 'live', updatedAt: LIVE_NOW })).toBe('Live')
  })

  it('never prints a count it has not read, and never prints a stale one as current', () => {
    expect(pendingText({ ...blankState(), updatedAt: null })).toBe('pending count not read yet')
    expect(
      pendingText({ ...blankState(), connection: 'live', updatedAt: LIVE_NOW, pendingCount: 2 }),
    ).toBe('2 pending')
    // Every state that is not `live` qualifies, a reconnect attempt included: a
    // count next to "Connecting to the hub" with nothing to say it is last known is
    // the one reading this page must not invite.
    for (const connection of ['connecting', 'stale', 'disconnected'] as const) {
      expect(
        pendingText({ ...blankState(), connection, updatedAt: LIVE_NOW, pendingCount: 2 }),
        `${connection} qualifies the count`,
      ).toBe('2 pending (last known)')
    }
    expect(
      pendingText({ ...blankState(), connection: 'disconnected', updatedAt: LIVE_NOW, pendingCount: 0 }),
    ).toBe('0 pending (last known)')
  })

  it('keeps the header live while the canvas is quiet, so a heartbeat repaints nothing', async () => {
    const mount = await mountWith(twoRepositories)
    const { target, hub } = mount
    const before = target.commands.length
    hub.heartbeat(1)
    await mount.settle()
    expect(target.commands.length).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// LD-FR-04: the pending count
// ---------------------------------------------------------------------------

describe('LD-1 the pending count is the hub\'s own', () => {
  it('prints the pending set the hub returned', async () => {
    const mount = await mountWith(twoRepositories, { pending: ['a', 'b', 'c'] })
    expect(mount.header.querySelector(`[${DASHBOARD_PENDING_ATTRIBUTE}]`)?.textContent).toBe(
      '3 pending',
    )
    expect(mount.dashboard.state.pendingCount).toBe(3)
    expect(mount.dashboard.state.pendingCount).toBe(mount.hub.pending.length)
  })

  it('prints zero rather than nothing when nothing is pending', async () => {
    const mount = await mountWith(twoRepositories, { pending: [] })
    expect(mount.header.querySelector(`[${DASHBOARD_PENDING_ATTRIBUTE}]`)?.textContent).toBe(
      '0 pending',
    )
  })

  it('moves the count on a live change, from the frame the hub sent', async () => {
    const mount = await mountWith(twoRepositories, { pending: [] })
    mount.hub.change({ cursor: 2, session: twoRepositories[0]!, pendingCount: 4 })
    await mount.settle()
    expect(mount.header.querySelector(`[${DASHBOARD_PENDING_ATTRIBUTE}]`)?.textContent).toBe(
      '4 pending',
    )
  })

  it('counts the number the tray badge draws, not the length of a list it did not receive', () => {
    // `/api/pending` carries the count the tray badge draws; a payload whose item
    // list is shorter than its count is still a count, and the page must show the
    // number the badge shows (LD-FR-04).
    expect(parsePendingCount({ items: [], count: 7 })).toBe(7)
    expect(parsePendingCount({ items: [{ eventId: 'a' }] })).toBe(1)
    expect(parsePendingCount({})).toBe(0)
    expect(parsePendingCount(null)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// APX-CON-07: the canvas and its mirror
// ---------------------------------------------------------------------------

describe('LD-1 the mirror: one focusable entry per painted row, in canvas order', () => {
  it('pairs every painted row with one mirror entry, in the same order', async () => {
    const { dashboard } = await mountWith(twoRepositories)
    const entries = dashboard.mirror.entries
    expect(entries).toHaveLength(dashboard.rows.length)
    expect(dashboard.mirror.order).toEqual(dashboard.rows.map((row) => row.sessionId))
    // Every entry is focusable, and the list is one tab stop: the roving tabindex
    // puts exactly one entry in the tab order and leaves the rest arrow-reachable.
    const tabIndexes = entries.map((entry) => entry.getAttribute('tabindex'))
    expect(tabIndexes.filter((value) => value === '0')).toHaveLength(1)
    for (const value of tabIndexes) expect(['0', '-1']).toContain(value)
    for (const row of dashboard.rows) {
      const entry = dashboard.mirror.entryForSession(row.sessionId)
      expect(entry, `${row.sessionId} has an entry`).not.toBeNull()
      expect(entry?.getAttribute(MIRROR_REPOSITORY_ATTRIBUTE)).toBe(row.repositoryShortName)
      expect(entry?.getAttribute(MIRROR_PATH_ATTRIBUTE)).toBe(row.repositoryPath)
      expect(entry?.getAttribute(MIRROR_STATE_ATTRIBUTE)).toBe(row.state)
    }
  })

  it("nests each group's rows under that group's heading", async () => {
    const { dashboard } = await mountWith(twoRepositories)
    for (const group of dashboard.plan.groups) {
      const element = dashboard.mirror.groupForRepository(group.repositoryId)
      expect(element, `${group.shortName} has a group`).not.toBeNull()
      expect(
        dashboard.mirror.entriesForRepository(group.repositoryId).map((entry) =>
          entry.getAttribute(MIRROR_ROW_ATTRIBUTE),
        ),
      ).toEqual([...group.rowIds])
    }
  })

  it('re-reads the mirror when a live change reorders the rows', async () => {
    const mount = await mountWith(twoRepositories)
    const { dashboard, hub } = mount
    expect(dashboard.mirror.order).toEqual([
      'session-render',
      'session-ack',
      'session-harness',
      'session-note',
    ])
    hub.change({
      cursor: 2,
      session: hubSession({
        sessionId: 'session-note',
        repoShortName: 'knowledge-dungeon',
        repoFullPath: '/home/dev/Projects/knowledge-dungeon',
        harness: 'copilot',
        state: 'blocked',
        pendingCount: 1,
        lastSeenAt: '2026-09-27T11:59:30.000Z',
      }),
      pendingCount: 3,
    })
    await mount.settle()
    expect(dashboard.mirror.order).toEqual([
      'session-render',
      'session-ack',
      'session-note',
      'session-harness',
    ])
  })

  it('keeps the mirror hidden by clipping, in a stylesheet this policy will accept', () => {
    // The mirror injects its own sheet, and the hub sends `style-src 'self'` with no
    // `unsafe-inline`, which a browser refuses for an inline <style> element. The
    // page's linked stylesheet therefore has to say the same thing, and this is the
    // assertion that the two cannot drift: a page where they did drift would show
    // the mirror as an ordinary visible list above the canvas.
    const css = readFileSync(path.join(repositoryRoot, 'src/dashboard/dashboard.css'), 'utf8')
    const mirrorRules = css.slice(css.indexOf('.dashboard-mirror {'))
    expect(mirrorRules).toContain('clip: rect(0 0 0 0)')
    expect(mirrorRules).toContain('clip-path: inset(50%)')
    for (const forbidden of ['display: none', 'visibility: hidden', '[hidden]']) {
      expect(mirrorRules).not.toContain(forbidden)
    }
    // The module's own sheet, for the same three properties.
    expect(mirrorStyleSheet()).toContain('clip: rect(0 0 0 0)')
  })

  it('injects no stylesheet the hub\'s policy would refuse', async () => {
    // A real browser under the real hub is what found this: the page logged
    // "Applying inline style violates the following Content Security Policy
    // directive 'style-src 'self''" on every load, because the mirror injects a
    // `<style>` element. The rules come from the page's linked stylesheet instead,
    // and this is the assertion that the injection has not come back - a page that
    // both injected the sheet and carried the rules would be correct only by luck.
    const mount = await mountWith(twoRepositories)
    expect(mount.container.querySelectorAll('style')).toHaveLength(0)
    expect(document.querySelectorAll(`[${MIRROR_STYLE_ATTRIBUTE}]`)).toHaveLength(0)
    // And the mirror is still mounted, clipped and focusable: skipping the sheet
    // must not have skipped the mirror.
    expect(mount.dashboard.mirror.entries).toHaveLength(4)
    for (const entry of mount.dashboard.mirror.entries) {
      expect(entry.hasAttribute('tabindex')).toBe(true)
    }
  })

  it('leaves the mirror visible only when the page was opened with the inspection flag', async () => {
    const hub = createStubHub({ sessions: twoRepositories })
    const off = await mountLiveDashboard({ hub, search: '' })
    hub.ready(1)
    await off.settle()
    expect(document.documentElement.hasAttribute(MIRROR_INSPECT_ATTRIBUTE)).toBe(false)
    expect(off.dashboard.mirror.entries.length).toBeGreaterThan(0)
    off.destroy()

    const on = await mountLiveDashboard({ hub, search: '?mirror=visible' })
    hub.ready(2)
    await on.settle()
    expect(document.documentElement.getAttribute(MIRROR_INSPECT_ATTRIBUTE)).toBe('visible')
    // The mirror is mounted either way: the flag reveals it, it does not create it.
    expect(on.dashboard.mirror.entries.length).toBeGreaterThan(0)
    expect(applyInspectionFlag(document, '?mirror=hidden')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// DP-4's required changes: focus and activation are painted
// ---------------------------------------------------------------------------

describe('LD-1 the focus and activated states are visible, not only recorded', () => {
  it('paints a band and a rail on the focused row, and nothing on the others', async () => {
    const { dashboard, target } = await mountWith(twoRepositories)
    const before = rectCommands(target.commands).filter((rect) => rect.fill === LIVE_COLORS.focusRail)
    expect(before).toHaveLength(0)

    const row = dashboard.rows[1]
    if (row === undefined) throw new Error('the fixture rendered no second row')
    dashboard.navigator.focusSession(row.sessionId)

    const rails = rectCommands(target.commands).filter((rect) => rect.fill === LIVE_COLORS.focusRail)
    const bands = rectCommands(target.commands).filter((rect) => rect.fill === LIVE_COLORS.focusFill)
    expect(rails).toHaveLength(1)
    expect(bands).toHaveLength(1)
    // The rail sits inside the focused row's own band: a mark on the wrong row is
    // worse than no mark.
    expect(rails[0]?.y).toBeGreaterThanOrEqual(row!.y)
    expect((rails[0]?.y ?? 0) + (rails[0]?.height ?? 0)).toBeLessThanOrEqual(row!.y + row!.height)
    // The mark is drawn before the row's own text, so the text is still legible.
    const railIndex = target.commands.indexOf(rails[0]!)
    const labelIndex = target.commands.findIndex(
      (command) =>
        command.kind === 'text' &&
        command.role === 'session-state-label' &&
        command.y >= row!.y &&
        command.y < row!.y + row!.height,
    )
    expect(railIndex).toBeLessThan(labelIndex)
  })

  it('paints the activated row as activated, in words', async () => {
    const { dashboard, target } = await mountWith(twoRepositories)
    const row = dashboard.rows[0]
    expect(rowText(row!, target.commands, 'session-age')).toBe(row!.age)

    expect(dashboard.navigator.activate(row!.sessionId, 'Enter')).toBe(true)

    expect(dashboard.activatedSessionId).toBe(row!.sessionId)
    expect(rowText(dashboard.rows[0]!, target.commands, 'session-age')).toBe(
      `${row!.age} · ${ACTIVATED_MARKER}`,
    )
  })

  it('holds the focused row when a live update arrives underneath it', async () => {
    const mount = await mountWith(twoRepositories)
    const { dashboard, hub } = mount
    const focused = dashboard.rows[1]!
    dashboard.navigator.focusSession(focused.sessionId)
    expect(dashboard.focusedSessionId).toBe(focused.sessionId)

    hub.change({
      cursor: 2,
      session: hubSession({
        sessionId: 'session-harness',
        repoShortName: 'knowledge-dungeon',
        repoFullPath: '/home/dev/Projects/knowledge-dungeon',
        harness: 'copilot',
        state: 'finished',
        lastSeenAt: '2026-09-27T11:59:45.000Z',
      }),
      pendingCount: 2,
    })
    await mount.settle()

    expect(dashboard.focusedSessionId).toBe(focused.sessionId)
    // A single focus mark, on the row that has it, after the re-render.
    const rails = rectCommands(mount.target.commands).filter(
      (rect) => rect.fill === LIVE_COLORS.focusRail,
    )
    expect(rails).toHaveLength(1)
    const still = dashboard.rows.find((row) => row.sessionId === focused.sessionId)
    expect(still).toBeDefined()
    expect(rails[0]?.y).toBeGreaterThanOrEqual(still!.y)
  })
})

// ---------------------------------------------------------------------------
// The approved layout, the same one
// ---------------------------------------------------------------------------

describe('LD-1 the live page draws the approved layout', () => {
  it('lays the same shape of list out to the same geometry the prototype does', () => {
    // The same group and row structure through the shared layout, so the density a
    // human signed off is the density live data gets: the third group starts where
    // the shared arithmetic puts it, whatever the data was.
    const sessions = [
      hubSession({ sessionId: 'a', state: 'blocked' }),
      hubSession({ sessionId: 'b', state: 'running' }),
      hubSession({
        sessionId: 'c',
        repoShortName: 'knowledge-dungeon',
        repoFullPath: '/home/dev/Projects/knowledge-dungeon',
        state: 'finished',
      }),
    ]
    const plan = buildLivePlan(sessions, { width: 1024, height: 540, now: LIVE_NOW })
    const firstGroupRows = plan.rows.filter((row) => row.repositoryId === 'agent-ping')
    expect(firstGroupRows.map((row) => row.sessionId)).toEqual(['a', 'b'])
    for (const row of firstGroupRows) {
      expect(row.y).toBe(LAYOUT.pagePaddingTop + LAYOUT.groupHeaderHeight + 1 + LAYOUT.rowHeight * (row.sessionId === 'a' ? 0 : 1))
    }
    const second = plan.rows.find((row) => row.sessionId === 'c')
    expect(second?.y).toBe(
      LAYOUT.pagePaddingTop + LAYOUT.groupHeaderHeight + 1 + LAYOUT.rowHeight * 2 + LAYOUT.groupGap + LAYOUT.groupHeaderHeight + 1,
    )
  })

  it('grows the canvas to the rows rather than hiding the ones past its edge', async () => {
    // Ten sessions across five repositories is the busy-afternoon case the design
    // review asked for, and it is taller than one screen. A page that dropped the
    // overflow would be a page that is wrong about what needs the developer.
    const busy = Array.from({ length: 10 }, (_unused, index) =>
      hubSession({
        sessionId: `session-${String(index)}`,
        repoShortName: `repo-${String(Math.floor(index / 2))}`,
        repoFullPath: `/home/dev/Projects/repo-${String(Math.floor(index / 2))}`,
        state: index === 0 ? 'blocked' : index % 3 === 0 ? 'finished' : 'running',
        lastSeenAt: `2026-09-27T11:${String(50 - index).padStart(2, '0')}:00.000Z`,
      }),
    )
    const mount = await mountWith(busy)
    const { dashboard, host, target } = mount

    expect(dashboard.rows).toHaveLength(10)
    expect(dashboard.plan.contentHeight).toBeGreaterThan(540)
    // The surface grew, and every row is painted inside it.
    expect(host.sizes[host.sizes.length - 1]?.height).toBeGreaterThanOrEqual(
      Math.ceil(dashboard.plan.contentHeight),
    )
    // The content height is measured from the first row, so the last row's bottom
    // is the content height plus the page's own top padding - and no further.
    const last = dashboard.rows[dashboard.rows.length - 1]!
    expect(last.y + last.height).toBeLessThanOrEqual(
      dashboard.plan.contentHeight + LAYOUT.pagePaddingTop,
    )
    expect(rowText(last, target.commands, 'session-state-label')).toBeTruthy()
    // And the mirror carries all ten, because all ten are painted.
    expect(dashboard.mirror.entries).toHaveLength(10)
  })

  it('never shrinks the surface, so a change cannot move the ground under a reader', async () => {
    const many = Array.from({ length: 6 }, (_unused, index) =>
      hubSession({ sessionId: `session-${String(index)}` }),
    )
    const mount = await mountWith(many)
    const tallest = mount.host.sizes[mount.host.sizes.length - 1]?.height ?? 0

    mount.hub.change({
      cursor: 2,
      session: hubSession({ sessionId: 'session-0', state: 'finished' }),
      pendingCount: 0,
    })
    await mount.settle()
    expect(mount.dashboard.rows).toHaveLength(6)
    expect(mount.host.sizes[mount.host.sizes.length - 1]?.height).toBe(tallest)
  })
})

// ---------------------------------------------------------------------------
// Contrast, the page contract, and teardown
// ---------------------------------------------------------------------------

describe('LD-1 the live text meets AA against the surface it is painted on', () => {
  it('meets AA for every piece of text the live plan draws', async () => {
    const all = LIVE_DISPLAY_STATES.map((state) =>
      hubSession({ sessionId: `s-${state}`, state: state === 'information-only' ? 'idle-after-nothing' : (state as 'blocked') }),
    )
    const mount = await mountWith(all)
    mount.hoverRepository('agent-ping')

    const background = LIVE_COLORS.pageBackground
    for (const command of textCommands(mount.target.commands)) {
      expect(contrast(command.color, background), `"${command.text}" meets AA`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('uses the same page background the prototype painted', () => {
    expect(LIVE_COLORS.pageBackground).toBe(PROTOTYPE_COLORS.pageBackground)
    expect(LIVE_COLORS.rowLabelText).toBe(PROTOTYPE_COLORS.rowLabelText)
    expect(LIVE_COLORS.rowMutedText).toBe(PROTOTYPE_COLORS.rowMutedText)
    expect(LIVE_COLORS.groupHeaderText).toBe(PROTOTYPE_COLORS.groupHeaderText)
    expect(LIVE_COLORS.blockedAccent).toBe(PROTOTYPE_COLORS.blockedAccent)
    expect(LIVE_COLORS.finishedAccent).toBe(PROTOTYPE_COLORS.finishedAccent)
    expect(LIVE_COLORS.runningAccent).toBe(PROTOTYPE_COLORS.runningAccent)
  })
})

describe('LD-1 the page is one document for both surfaces', () => {
  it('serves the same relative page in the application window and on the loopback origin', () => {
    const html = readFileSync(path.join(repositoryRoot, 'src/dashboard/index.html'), 'utf8')
    // Relative entries, so one artefact renders identically wherever it is loaded
    // from. An absolute base or a `file:` reference would work for one surface and
    // break the other, and a window-specific code path is a defect (LD-FR-10).
    expect(html).toContain('src="./main.ts"')
    expect(html).toContain('href="./dashboard.css"')
    expect(html).not.toContain('file://')
    expect(html).not.toContain('http://')
    expect(html).not.toContain('https://')

    const entry = readFileSync(path.join(repositoryRoot, 'src/dashboard/main.ts'), 'utf8')
    expect(entry).not.toContain('file://')
    // The origin is the page's own, read at runtime; nothing hardcodes one.
    expect(entry).toContain('globalThis.location?.origin')
  })

  it('mounts only when the page has provided a root, so a test import mounts nothing', () => {
    expect(document.querySelector(`[${DASHBOARD_ROOT_ATTRIBUTE}]`)).toBeNull()
    expect(document.querySelectorAll('canvas')).toHaveLength(0)
  })

  it('says so in the header when the page could not start, rather than looking quiet', () => {
    // A blank surface under a header still reading "Connecting to the hub" is a
    // page that looks like a hub that has gone away. This is the surface a real
    // browser found one way: PixiJS refusing to initialise under the strict CSP,
    // which is why the failure has to be printed rather than only logged.
    const header = document.createElement('header')
    header.setAttribute(DASHBOARD_HEADER_ATTRIBUTE, '')
    const line = document.createElement('span')
    line.setAttribute(DASHBOARD_CONNECTION_TEXT_ATTRIBUTE, '')
    header.append(line)
    document.body.append(header)

    reportMountFailure(document, new Error('the renderer refused to start'))

    expect(header.getAttribute(DASHBOARD_CONNECTION_ATTRIBUTE)).toBe('disconnected')
    expect(line.textContent).toContain('could not start')
    expect(line.textContent).toContain('the renderer refused to start')
    expect(line.textContent).toContain('Nothing below is current')
  })

  it('imports the PixiJS entry that runs without eval, because the hub forbids it', () => {
    // A real browser found this: `Application.init()` rejects under
    // `script-src 'self'` with no `unsafe-eval` unless `pixi.js/unsafe-eval` is
    // imported, and jsdom never gets far enough to see it. The alternative is a
    // weakened policy, which the security module refuses in as many words.
    const host = readFileSync(path.join(repositoryRoot, 'src/dashboard/host.ts'), 'utf8')
    expect(host).toContain("import 'pixi.js/unsafe-eval'")
  })

  it('mounts into the root the page HTML provides', async () => {
    const container = document.createElement('main')
    container.setAttribute(DASHBOARD_ROOT_ATTRIBUTE, '')
    document.body.append(container)
    const dashboard = await mountDashboard({
      container,
      origin: 'http://127.0.0.1:43117',
      now: () => LIVE_NOW,
      search: '',
      createHost: async ({ size }) => {
        const canvas = document.createElement('canvas')
        container.append(canvas)
        return {
          canvas,
          root: { addChild: () => undefined } as never,
          getSize: () => size,
          setSize: () => undefined,
          stopRendering: () => undefined,
          isTornDown: false,
          teardown: () => undefined,
        }
      },
      createTarget: () => ({
        clear: () => undefined,
        rect: () => undefined,
        line: () => undefined,
        icon: () => undefined,
        text: () => undefined,
        setHoverRegions: () => undefined,
      }),
      createClient: () => ({
        start: () => undefined,
        onChange: () => () => undefined,
        getState: () => ({
          connection: 'connecting',
          cursor: null,
          sessions: [],
          pendingCount: 0,
          problem: null,
          needsRefresh: false,
          updatedAt: null,
        }),
        refresh: async () => undefined,
        close: () => undefined,
        isClosed: false,
        activeSubscriptions: 0,
      }),
    })
    expect(container.contains(dashboard.host.canvas)).toBe(true)
    dashboard.destroy()
  })
})

describe('LD-1 teardown leaves nothing running', () => {
  it('closes the stream, drops every subscription and destroys the renderer', async () => {
    const mount = await mountWith(twoRepositories)
    const { dashboard, hub, host } = mount
    const connection = hub.latest()
    expect(dashboard.activeSubscriptions).toBeGreaterThan(0)
    expect(hub.timers.pending.length).toBeGreaterThan(0)

    dashboard.destroy()

    expect(dashboard.isDestroyed).toBe(true)
    expect(dashboard.activeSubscriptions).toBe(0)
    expect(connection.isClosed).toBe(true)
    expect(connection.listenerCount).toBe(0)
    expect(hub.timers.pending).toHaveLength(0)
    expect(dashboard.client.activeSubscriptions).toBe(0)
    expect(host.log).toEqual(['stopRendering', 'teardown'])
    expect(mount.container.querySelectorAll('canvas')).toHaveLength(0)
  })

  it('re-ages the rows on a timer, and cancels that timer on teardown', async () => {
    const mount = await mountWith(twoRepositories)
    const ticks = mount.hub.timers.pending.filter((timer) => timer.ms === LIVE_AGE_TICK_MS)
    expect(ticks).toHaveLength(1)
    mount.destroy()
    expect(mount.hub.timers.pending).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A state with nothing read, for the pure header-text assertions. */
function blankState(): {
  connection: 'connecting'
  cursor: null
  sessions: readonly never[]
  pendingCount: number
  problem: null
  needsRefresh: boolean
  updatedAt: string | null
} {
  return {
    connection: 'connecting',
    cursor: null,
    sessions: [],
    pendingCount: 0,
    problem: null,
    needsRefresh: false,
    updatedAt: null,
  }
}

/** WCAG 2.1 relative luminance of an sRGB colour given as 0xRRGGBB. */
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

/** The WCAG 2.1 contrast ratio between two opaque colours. */
function contrast(foreground: number, background: number): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

/** A compact age, the same shape the plan draws, used to check a row's age. */
function compactAge(lastSeenAt: string): string {
  const minutes = Math.floor((Date.parse(LIVE_NOW) - Date.parse(lastSeenAt)) / 60_000)
  return minutes < 60 ? `${String(minutes)}m` : `${String(Math.floor(minutes / 60))}h`
}
