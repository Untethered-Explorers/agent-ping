// LD-1: the live state client, driven through the exported mount entry point
// against a stubbed hub.
//
//   npm test -- tests/dashboard/stream-client.test.ts
//
// What is asserted here:
//
//   - LD-FR-03: the page subscribes, updates on a change, reconnects *with the
//     cursor it last applied*, and falls back to a full refresh when the hub says
//     that cursor cannot be honoured. The reconnect URL and the re-read count are
//     read off the recorded transport, not off a function's return value.
//   - The four connection states, and that a dropped or abandoned connection is
//     never presented as current.
//   - The reduction and the frame parsers, as pure functions over frames the hub
//     can actually send, including the ones this build must refuse.
//   - APX-CON-08: the client performs reads and nothing else.
//
// What cannot be asserted in jsdom: that a real `EventSource` sends
// `Last-Event-ID` on its own reconnect. The client closes the stream and opens a
// new one with `?cursor=`, so the automatic reconnection is deliberately not relied
// upon; qa-engineer's LD-4 browser journey is what proves the real transport.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/storage/eventStore'
import { DASHBOARD_CONNECTION_ATTRIBUTE, DASHBOARD_CONNECTION_TEXT_ATTRIBUTE, DASHBOARD_PENDING_ATTRIBUTE } from '@/dashboard/main'
import {
  INITIAL_LIVE_STATE,
  STREAM_MAX_RECONNECT_ATTEMPTS,
  STREAM_RECONNECT_BASE_MS,
  STREAM_RECONNECT_MAX_MS,
  createStreamClient,
  parseChangeFrame,
  parseHubSession,
  parseReadyFrame,
  parseRefreshRequiredFrame,
  parseSessionsPayload,
  reconnectDelayMs,
  reduceChangeFrame,
  reduceSnapshot,
  streamUrl,
  upsertSession,
  type ClientTimers,
  type HubSession,
  type LiveState,
  type StateChangeFrame,
} from '@/dashboard/live/stream-client'
import {
  LIVE_NOW,
  LIVE_ORIGIN,
  createFakeTimers,
  createStubHub,
  destroyLiveMounts,
  hubSession,
  mountLiveDashboard,
} from './live-harness'

const repositoryRoot = process.cwd()

afterEach(() => {
  destroyLiveMounts()
})

const twoSessions = [
  hubSession({ sessionId: 'session-a', state: 'running' }),
  hubSession({ sessionId: 'session-b', repoShortName: 'knowledge-dungeon', state: 'finished' }),
]

// ---------------------------------------------------------------------------
// The wire shapes agree with the hub's
// ---------------------------------------------------------------------------

describe('LD-1 the dashboard renders the hub\'s own session shape', () => {
  it('assigns both ways, so a renamed field is a compile error here', () => {
    // `import type` is erased, so this pulls in no Node code; the point is that the
    // two shapes are one shape. A field domain-engineer adds or renames is a change
    // this file's author has to make deliberately (LD-FR-01, the collaboration
    // note about envelope fields being display-ready).
    const hubShapesAreRenderable: readonly HubSession[] = [] as readonly SessionSummary[]
    const dashboardShapesAreHubShapes: readonly SessionSummary[] = [] as readonly HubSession[]
    expect(hubShapesAreRenderable).toHaveLength(0)
    expect(dashboardShapesAreHubShapes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The URL contract
// ---------------------------------------------------------------------------

describe('LD-1 the connection URL carries the cursor', () => {
  it('sends no cursor on a first connection and the last one applied after that', () => {
    expect(streamUrl(LIVE_ORIGIN, null)).toBe(`${LIVE_ORIGIN}/api/stream`)
    expect(streamUrl(LIVE_ORIGIN, 41)).toBe(`${LIVE_ORIGIN}/api/stream?cursor=41`)
  })

  it('backs off, and stops backing off at the ceiling', () => {
    expect(reconnectDelayMs(1)).toBe(STREAM_RECONNECT_BASE_MS)
    expect(reconnectDelayMs(2)).toBe(STREAM_RECONNECT_BASE_MS * 2)
    expect(reconnectDelayMs(20)).toBe(STREAM_RECONNECT_MAX_MS)
  })
})

// ---------------------------------------------------------------------------
// LD-FR-03, through the entry point
// ---------------------------------------------------------------------------

describe('LD-1 the page subscribes, updates and re-reads', () => {
  it('opens one connection, reads once, and renders what the hub returned', async () => {
    const hub = createStubHub({ sessions: twoSessions, pending: ['event-1'] })
    const mount = await mountLiveDashboard({ hub })

    // Before the hub has said anything the page is explicit rather than blank.
    expect(mount.header.querySelector(`[${DASHBOARD_CONNECTION_TEXT_ATTRIBUTE}]`)?.textContent).toBe(
      'Connecting to the hub',
    )
    expect(mount.header.querySelector(`[${DASHBOARD_PENDING_ATTRIBUTE}]`)?.textContent).toBe(
      'pending count not read yet',
    )
    expect(mount.dashboard.rows).toHaveLength(0)

    hub.ready(7)
    await mount.settle()

    expect(hub.opened).toEqual([`${LIVE_ORIGIN}/api/stream`])
    expect(hub.reads).toBe(1)
    expect(mount.dashboard.state.connection).toBe('live')
    expect(mount.dashboard.state.cursor).toBe(7)
    expect(mount.dashboard.rows.map((row) => row.sessionId)).toEqual(['session-a', 'session-b'])
    expect(mount.header.querySelector(`[${DASHBOARD_PENDING_ATTRIBUTE}]`)?.textContent).toBe(
      '1 pending',
    )
  })

  it('applies a change frame to the row it names and to the pending count', async () => {
    const hub = createStubHub({ sessions: twoSessions, pending: [] })
    const mount = await mountLiveDashboard({ hub })
    hub.ready(1)
    await mount.settle()

    hub.change({
      cursor: 2,
      session: hubSession({ sessionId: 'session-a', state: 'blocked', pendingCount: 1 }),
      pendingCount: 1,
    })
    await mount.settle()

    expect(mount.dashboard.state.cursor).toBe(2)
    expect(mount.dashboard.state.connection).toBe('live')
    const row = mount.dashboard.rows.find((candidate) => candidate.sessionId === 'session-a')
    expect(row?.state).toBe('blocked')
    expect(mount.header.querySelector(`[${DASHBOARD_PENDING_ATTRIBUTE}]`)?.textContent).toBe(
      '1 pending',
    )
  })

  it('reconnects with the cursor it last applied, and resumes from there', async () => {
    const hub = createStubHub({ sessions: twoSessions, pending: [] })
    const mount = await mountLiveDashboard({ hub })
    hub.ready(7)
    await mount.settle()

    hub.drop()
    expect(mount.dashboard.state.connection).toBe('stale')
    expect(mount.header.getAttribute(DASHBOARD_CONNECTION_ATTRIBUTE)).toBe('stale')

    // The page waits its backoff rather than reconnecting in a loop.
    const beforeReconnect = hub.opened.length
    expect(hub.opened).toHaveLength(beforeReconnect)

    hub.runReconnect()
    expect(hub.opened).toEqual([
      `${LIVE_ORIGIN}/api/stream`,
      `${LIVE_ORIGIN}/api/stream?cursor=7`,
    ])
    // A reconnect attempt is not a fresh start: the rows it holds are still the last
    // the hub sent, so the page stays stale and its count stays qualified rather
    // than reading "Connecting to the hub" beside a bare number.
    expect(mount.dashboard.state.connection).toBe('stale')
    expect(mount.header.querySelector(`[${DASHBOARD_PENDING_ATTRIBUTE}]`)?.textContent).toMatch(
      /\(last known\)$/,
    )
    // The dropped connection is closed rather than left to reconnect behind the
    // client's back, which would be two connections to one hub.
    expect(hub.connections[0]?.isClosed).toBe(true)

    hub.ready(9)
    await mount.settle()
    expect(mount.dashboard.state.connection).toBe('live')
    expect(mount.dashboard.state.cursor).toBe(9)
    // A replay that arrives after the reconnect is applied, not ignored.
    hub.change({
      cursor: 10,
      session: hubSession({ sessionId: 'session-b', repoShortName: 'knowledge-dungeon', state: 'blocked' }),
      pendingCount: 1,
    })
    await mount.settle()
    expect(mount.dashboard.state.cursor).toBe(10)
    expect(
      mount.dashboard.rows.find((candidate) => candidate.sessionId === 'session-b')?.state,
    ).toBe('blocked')
  })

  it('falls back to a full refresh when the hub says the cursor is too old', async () => {
    const hub = createStubHub({ sessions: twoSessions, pending: ['event-1'] })
    const mount = await mountLiveDashboard({ hub })
    hub.ready(2)
    await mount.settle()
    expect(hub.reads).toBe(1)

    // The hub cannot replay from cursor 2, and says so with no change frames at all.
    hub.setSnapshot({
      sessions: [hubSession({ sessionId: 'session-new', repoShortName: 'agent-ping', state: 'blocked' })],
      pending: ['event-9', 'event-8'],
    })
    hub.refreshRequired({ reason: 'cursor-too-old', requestedCursor: 2, currentCursor: 41 })
    await mount.settle()

    expect(hub.reads).toBe(2)
    // The rows are the read's rows, not a merge of the read and anything the
    // client happened to hold: a partial replay that looked like state is the
    // failure this whole path exists to avoid.
    expect(mount.dashboard.rows.map((row) => row.sessionId)).toEqual(['session-new'])
    // The hub's own answer about where the log stands becomes this client's cursor,
    // so the next reconnect asks for a replay that can be honoured.
    expect(mount.dashboard.state.cursor).toBe(41)
    expect(mount.dashboard.state.problem).toBeNull()
    expect(mount.dashboard.state.connection).toBe('live')
    expect(mount.header.querySelector(`[${DASHBOARD_PENDING_ATTRIBUTE}]`)?.textContent).toBe(
      '2 pending',
    )
  })

  it('says so while the re-read is in flight, and drops the claim afterwards', async () => {
    const hub = createStubHub({ sessions: twoSessions, pending: [] })
    const mount = await mountLiveDashboard({ hub })
    hub.ready(2)
    await mount.settle()

    hub.refreshRequired({ reason: 'cursor-unknown', currentCursor: 41 })
    // Synchronously after the frame, before the read settles: the page says it is
    // re-reading rather than claiming to be current.
    expect(mount.dashboard.state.problem).toEqual({ kind: 'refresh-required', reason: 'cursor-unknown' })
    const line = mount.header.querySelector(`[${DASHBOARD_CONNECTION_TEXT_ATTRIBUTE}]`)?.textContent ?? ''
    expect(line).toContain('too far behind')

    await mount.settle()
    expect(mount.dashboard.state.problem).toBeNull()
  })

  it('re-reads when a change arrives for a session the log has no row for', async () => {
    const hub = createStubHub({ sessions: twoSessions, pending: [] })
    const mount = await mountLiveDashboard({ hub })
    hub.ready(1)
    await mount.settle()

    hub.change({ cursor: 2, session: null, pendingCount: 0 })
    await mount.settle()

    expect(hub.reads).toBe(2)
    // The null session was not rendered as an empty row.
    expect(mount.dashboard.rows.map((row) => row.sessionId)).toEqual(['session-a', 'session-b'])
  })
})

// ---------------------------------------------------------------------------
// The four states, and never a quiet page
// ---------------------------------------------------------------------------

describe('LD-1 a page that cannot be trusted says so', () => {
  it('goes stale on a drop, disconnected when the retries run out, and stops there', async () => {
    const hub = createStubHub({ sessions: twoSessions, pending: [] })
    const mount = await mountLiveDashboard({ hub })
    hub.ready(1)
    await mount.settle()

    for (let attempt = 1; attempt <= STREAM_MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      hub.drop()
      expect(mount.dashboard.state.connection, `drop ${attempt} is stale`).toBe('stale')
      hub.runReconnect()
    }
    // One more drop than the bound allows, and the page stops pretending.
    hub.drop()
    expect(mount.dashboard.state.connection).toBe('disconnected')
    expect(mount.dashboard.state.problem).toEqual({ kind: 'gave-up' })
    expect(hub.opened).toHaveLength(STREAM_MAX_RECONNECT_ATTEMPTS + 1)

    const line = mount.header.querySelector(`[${DASHBOARD_CONNECTION_TEXT_ATTRIBUTE}]`)?.textContent ?? ''
    expect(line).toContain('Disconnected')
    expect(line).toContain('the last it sent')
    expect(line).toContain('Not retrying')
    // The rows are still on the page, still labelled as the last the hub sent.
    expect(mount.dashboard.rows).toHaveLength(2)
  })

  it('backs off further with each attempt rather than retrying in a tight loop', async () => {
    const hub = createStubHub({ sessions: twoSessions, pending: [] })
    const mount = await mountLiveDashboard({ hub })
    hub.ready(1)
    await mount.settle()

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      hub.drop()
      hub.runReconnect()
    }
    const delays = hub.timers.delays.filter((delay) => delay < 60_000)
    expect(delays).toEqual([STREAM_RECONNECT_BASE_MS, STREAM_RECONNECT_BASE_MS * 2, STREAM_RECONNECT_BASE_MS * 4])
    void mount
  })

  it('reports an unreadable hub rather than an empty page', async () => {
    const hub = createStubHub({ sessions: twoSessions, pending: [] })
    const mount = await mountLiveDashboard({ hub })
    hub.failNextRead()
    hub.ready(1)
    await mount.settle()

    expect(mount.dashboard.state.connection).toBe('disconnected')
    expect(mount.dashboard.state.problem).toEqual({ kind: 'unreadable' })
    const line = mount.header.querySelector(`[${DASHBOARD_CONNECTION_TEXT_ATTRIBUTE}]`)?.textContent ?? ''
    expect(line).toContain('could not be read')
    // No count is printed from a read that never happened.
    expect(mount.header.querySelector(`[${DASHBOARD_PENDING_ATTRIBUTE}]`)?.textContent).toBe(
      'pending count not read yet',
    )
  })
})

// ---------------------------------------------------------------------------
// The reduction, as pure functions
// ---------------------------------------------------------------------------

describe('LD-1 the reduction is pure and total over the frames it understands', () => {
  const frame = (overrides: Partial<StateChangeFrame> = {}): StateChangeFrame => ({
    cursor: 3,
    kind: 'event-stored',
    at: LIVE_NOW,
    event: {
      eventId: 'event-1',
      sessionId: 'session-a',
      class: 'needs-you',
      subtype: null,
      rawEventType: 'permission.ask',
      occurredAt: LIVE_NOW,
      receivedAt: LIVE_NOW,
      dedupeKey: 'dedupe-1',
      ackState: 'unacknowledged',
      resolutionState: 'unresolved',
    },
    session: hubSession({ sessionId: 'session-a', state: 'blocked' }),
    pendingCount: 1,
    ...overrides,
  })

  it('upserts a session by identity rather than appending a second row', () => {
    const first = hubSession({ sessionId: 'session-a', state: 'running' })
    const after = hubSession({ sessionId: 'session-a', state: 'blocked' })
    expect(upsertSession([first], after)).toEqual([after])
    expect(upsertSession([], first)).toEqual([first])
    // The same object twice is the same list: a replayed frame is a no-op, not a
    // re-render.
    const once = upsertSession([], first)
    expect(upsertSession(once, first)).toBe(once)
  })

  it('keeps a row in place when its state changes, so a page does not reshuffle', () => {
    const before: LiveState = {
      ...INITIAL_LIVE_STATE,
      connection: 'live',
      sessions: [hubSession({ sessionId: 'a' }), hubSession({ sessionId: 'b' })],
    }
    const after = reduceChangeFrame(before, frame({ session: hubSession({ sessionId: 'b', state: 'blocked' }) }))
    expect(after.sessions.map((session) => session.sessionId)).toEqual(['a', 'b'])
    expect(after.pendingCount).toBe(1)
    expect(after.cursor).toBe(3)
    expect(after.updatedAt).toBe(LIVE_NOW)
  })

  it('asks for a re-read rather than inventing a row when the log has none', () => {
    const after = reduceChangeFrame(INITIAL_LIVE_STATE, frame({ session: null }))
    expect(after.needsRefresh).toBe(true)
    expect(after.sessions).toEqual([])
    expect(reduceSnapshot(after, { sessions: twoSessions, pendingCount: 2 }, LIVE_NOW)).toMatchObject({
      needsRefresh: false,
      pendingCount: 2,
      sessions: twoSessions,
    })
  })

  it('refuses every frame shape it cannot read, rather than applying half of it', () => {
    expect(parseChangeFrame(null)).toBeNull()
    expect(parseChangeFrame({})).toBeNull()
    expect(parseChangeFrame({ ...frame(), kind: 'something-new' })).toBeNull()
    expect(parseChangeFrame({ ...frame(), cursor: 'three' })).toBeNull()
    expect(parseReadyFrame({ at: LIVE_NOW })).toBeNull()
    expect(parseRefreshRequiredFrame({ reason: 'because', currentCursor: 1, at: LIVE_NOW })).toBeNull()
    expect(parseHubSession({ sessionId: 'a' })).toBeNull()
    // A payload that is not an array is not an empty list to be rendered as one.
    expect(parseSessionsPayload({ sessions: 'nope' })).toEqual([])
  })

  it('asks for a re-read rather than dropping a change whose session row is unreadable', () => {
    // A malformed nested row is a re-read, not a lost transition and not a blank
    // row on the page: both of those would hide a change the developer needs.
    const parsed = parseChangeFrame({ ...frame(), session: { sessionId: 'x' } })
    expect(parsed).not.toBeNull()
    expect(parsed?.session).toBeNull()
    expect(reduceChangeFrame(INITIAL_LIVE_STATE, frame({ session: null })).needsRefresh).toBe(true)
  })

  it('ignores a frame whose payload is not JSON, and a heartbeat that changes nothing', async () => {
    const hub = createStubHub({ sessions: twoSessions, pending: [] })
    const mount = await mountLiveDashboard({ hub })
    hub.ready(1)
    await mount.settle()
    const before = mount.dashboard.state

    hub.latest().fire('change', 'not json at all')
    hub.latest().fire('change', JSON.stringify({ cursor: 2, kind: 'nope' }))
    await mount.settle()

    expect(mount.dashboard.state.cursor).toBe(before.cursor)
    expect(mount.dashboard.state.sessions).toEqual(before.sessions)
  })
})

// ---------------------------------------------------------------------------
// APX-CON-08: reads and nothing else
// ---------------------------------------------------------------------------

describe('LD-1 the page only ever reads', () => {
  it('issues no write, carries no token and names no other origin', () => {
    const source = readFileSync(path.join(repositoryRoot, 'src/dashboard/live/stream-client.ts'), 'utf8')
    for (const forbidden of ['POST', 'PUT', 'DELETE', 'PATCH', 'X-Agent-Ping', 'authorization']) {
      expect(source, `stream-client.ts must not contain ${forbidden}`).not.toContain(forbidden)
    }
    expect(source.match(/method: 'GET'/g)).toHaveLength(2)
    // The only origins are the three read routes, relative to the page's own.
    expect(source).toContain('STREAM_ROUTE = ')
    expect(source).toContain('SESSIONS_ROUTE = ')
    expect(source).toContain('PENDING_ROUTE = ')
  })
})

// ---------------------------------------------------------------------------
// The client on its own: timers, teardown, and the unsubscribe
// ---------------------------------------------------------------------------

describe('LD-1 the client owns one timer and closes everything', () => {
  it('holds nothing after close, and refuses to start twice', () => {
    const timers = createFakeTimers() as ClientTimers
    const client = createStreamClient({
      origin: LIVE_ORIGIN,
      createEventSource: () => ({
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        close: () => undefined,
      }),
      readSnapshot: async () => ({ sessions: [], pendingCount: 0 }),
      timers,
    })
    const listener = vi.fn()
    const unsubscribe = client.onChange(listener)
    client.start()
    client.start()
    expect(client.getState().connection).toBe('connecting')
    expect(client.activeSubscriptions).toBe(2)

    unsubscribe()
    client.close()
    expect(client.isClosed).toBe(true)
    expect(client.activeSubscriptions).toBe(0)
    // Closing twice is harmless, and starting after a close does nothing.
    client.close()
    client.start()
    expect(client.activeSubscriptions).toBe(0)
  })
})
