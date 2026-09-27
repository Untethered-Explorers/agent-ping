// Shared jsdom harness for the LD-1, LD-2 and LD-3 suites.
//
// The live page cannot be driven against a real hub here: jsdom has no
// `EventSource`, no `fetch` to a socket, and no 2D or WebGL context for
// `Application.init()`. So this harness supplies the seams the real entry point
// takes - a stream transport, a full-refresh reader, timers, and from LD-3 the
// pending reader, the history reader and the ack transport's `fetch` - plus the two
// recording seams the prototype harness already established (a host and a scene
// target that record what the mount asked of them). Everything asserted in the live
// suites is therefore asserted against the real `mountDashboard` and the exact
// command stream the browser would paint.
//
// The stub hub is a recorder rather than a mock: it keeps the URLs the client
// opened, the frames it was sent, how many times it re-read, the acknowledgement
// requests that were posted and the answer each one got, so "reconnects with the
// last cursor", "a too-old cursor triggers a full refresh" and "the only write is a
// POST to the ack route with the token and no body" are read off the transport
// rather than asserted about a function.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createStreamClient, type HubSession, type HubSessionState, type StreamConnection, type StreamMessage } from '@/dashboard/live/stream-client'
import { ACK_ROUTE_PREFIX, type AckAnswer, type PendingItemRecord } from '@/dashboard/live/ack'
import { mountDashboard, type LiveDashboard, type RevealedRow, type ScrollRowIntoView } from '@/dashboard/main'
import { createMotionController, type MotionControllerOptions } from '@/dashboard/theme/motion'
import type { DrawCommand, HoverRegion, SceneTarget, TextCommand } from '@/dashboard/prototype/scene'
import {
  createFakePreference,
  createRecordingHost,
  createRecordingTarget,
  setContainerSize,
  type FakePreference,
  type RecordingHost,
  type RecordingTarget,
} from './prototype-harness'

export { setContainerSize }

// ---------------------------------------------------------------------------
// The fixed clock
// ---------------------------------------------------------------------------

/** Every age on the live page is measured against this, so the strings are stable. */
export const LIVE_NOW = '2026-09-27T12:00:00.000Z'
export const LIVE_NOW_MS = Date.parse(LIVE_NOW)
/** The origin the page is served from. The only origin this harness ever names. */
export const LIVE_ORIGIN = 'http://127.0.0.1:43117'

// ---------------------------------------------------------------------------
// Hub-shaped fixtures
// ---------------------------------------------------------------------------

export interface HubSessionOverrides {
  readonly sessionId?: string
  readonly harness?: string
  readonly repoShortName?: string
  readonly repoFullPath?: string
  readonly firstSeenAt?: string
  readonly lastSeenAt?: string
  readonly state?: HubSessionState
  readonly workSignal?: 0 | 1
  readonly pendingCount?: number
}

/** One session row in the exact field set the hub's read route serves. */
export function hubSession(overrides: HubSessionOverrides = {}): HubSession {
  return {
    sessionId: overrides.sessionId ?? 'session-one',
    harness: overrides.harness ?? 'opencode',
    repoShortName: overrides.repoShortName ?? 'agent-ping',
    repoFullPath: overrides.repoFullPath ?? '/home/dev/Projects/agent-ping',
    firstSeenAt: overrides.firstSeenAt ?? '2026-09-27T11:00:00.000Z',
    lastSeenAt: overrides.lastSeenAt ?? '2026-09-27T11:58:00.000Z',
    state: overrides.state ?? 'running',
    workSignal: overrides.workSignal ?? 1,
    pendingCount: overrides.pendingCount ?? 0,
  }
}

/** A `change` frame's event row, in the field set the store persists. */
export function hubEvent(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    eventId: 'event-1',
    sessionId: 'session-one',
    class: 'needs-you',
    subtype: null,
    rawEventType: 'permission.ask',
    occurredAt: LIVE_NOW,
    receivedAt: LIVE_NOW,
    dedupeKey: 'dedupe-1',
    ackState: 'unacknowledged',
    resolutionState: 'unresolved',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// The pending set and the history
// ---------------------------------------------------------------------------

/**
 * One pending item, in the field set `/api/pending` serves and the page reads.
 *
 * Note what is *not* here: `harness`, `repoShortName` and `repoFullPath` exist on
 * the store's row and are deliberately absent, because the page's
 * `PendingItemRecord` does not carry them (a repository is a session row's identity,
 * APX-CON-09) and a fixture that had them would be a fixture the parser drops.
 */
export function hubPendingItem(
  overrides: Partial<PendingItemRecord> = {},
): PendingItemRecord {
  return {
    eventId: 'event-1',
    sessionId: 'session-one',
    class: 'needs-you',
    occurredAt: LIVE_NOW,
    ackState: 'unacknowledged',
    resolutionState: 'unresolved',
    ...overrides,
  }
}

/**
 * One event as `/api/events` serves it, with two extra keys no payload has.
 *
 * `body` and `transcript` are here so a test can prove the parser drops them: a
 * hostile payload is the only honest way to assert that a field this product cannot
 * store cannot reach the page (APX-FR-01, ADR-003).
 */
export function hubHistoryEvent(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    eventId: 'event-1',
    sessionId: 'session-one',
    class: 'needs-you',
    subtype: null,
    rawEventType: 'permission.ask',
    occurredAt: LIVE_NOW,
    receivedAt: LIVE_NOW,
    dedupeKey: 'dedupe-1',
    ackState: 'unacknowledged',
    resolutionState: 'unresolved',
    ...overrides,
  }
}

/** One read of `/api/events`, as the route answers it. */
export function historyPayload(events: readonly Record<string, unknown>[]): unknown {
  return { events, count: events.length, limit: 100, sessionId: null }
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

export interface FakeTimer {
  readonly ms: number
  run(): void
}

export interface FakeTimers {
  /** What the client's reconnect timer and the page's age tick see. */
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
  /** Everything scheduled, oldest first. */
  readonly pending: readonly FakeTimer[]
  /** The delays scheduled so far, in order. A test asserts the backoff from these. */
  readonly delays: readonly number[]
  /** Run every timer scheduled right now. */
  runAll(): void
}

export function createFakeTimers(): FakeTimers {
  interface Scheduled {
    readonly ms: number
    handler: () => void
  }
  let scheduled: Scheduled[] = []
  let nextHandle = 1
  const handles = new Map<number, Scheduled>()
  const delays: number[] = []

  return {
    setTimeout(handler: () => void, ms: number): unknown {
      const handle = nextHandle
      nextHandle += 1
      const entry: Scheduled = { ms, handler }
      handles.set(handle, entry)
      scheduled.push(entry)
      delays.push(ms)
      return handle
    },
    clearTimeout(handle: unknown): void {
      const key = handle as number
      const entry = handles.get(key)
      if (entry === undefined) return
      handles.delete(key)
      scheduled = scheduled.filter((candidate) => candidate !== entry)
    },
    now(): number {
      return LIVE_NOW_MS
    },
    get pending(): readonly FakeTimer[] {
      return scheduled.map((entry) => ({
        ms: entry.ms,
        // A real timer fires once and is then gone. Removing the entry before the
        // handler runs is what keeps `runReconnect` from re-running the reconnects
        // a test already performed, which would be a harness artefact and not the
        // client's behaviour.
        run(): void {
          scheduled = scheduled.filter((candidate) => candidate !== entry)
          for (const [handle, candidate] of handles) {
            if (candidate === entry) handles.delete(handle)
          }
          entry.handler()
        },
      }))
    },
    get delays(): readonly number[] {
      return [...delays]
    },
    runAll(): void {
      const due = scheduled
      scheduled = []
      for (const entry of due) entry.handler()
    },
  }
}

// ---------------------------------------------------------------------------
// The stub hub
// ---------------------------------------------------------------------------

/** One opened connection, recorded rather than mocked. */
export interface StubConnection {
  readonly url: string
  addEventListener(type: string, listener: (event: StreamMessage) => void): void
  removeEventListener(type: string, listener: (event: StreamMessage) => void): void
  close(): void
  /** Deliver a frame to this connection's listeners, as the hub would. */
  fire(type: string, data: unknown): void
  /** True once `close` has been called, which is what `close()` on the client does. */
  isClosed: boolean
  readonly listenerCount: number
}

export interface StubHubOptions {
  /** What the read routes return until a test says otherwise. */
  readonly sessions?: readonly HubSession[]
  /** The pending set the read routes return. The count is derived from it. */
  readonly pending?: readonly string[]
  /** The pending *items*, which the acknowledgement path reads. */
  readonly pendingItems?: readonly PendingItemRecord[]
  /** The raw `/api/events` payload, before the page's parser has seen it. */
  readonly events?: readonly Record<string, unknown>[]
}

/** One acknowledgement request, as the page actually put it on the wire. */
export interface AckRequestRecord {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  /** The body the page sent, verbatim. `null` when the body was undefined. */
  readonly body: string | null
  readonly eventId: string
}

export interface StubHub {
  /** Every URL the page opened, in order. The cursor contract is read off these. */
  readonly opened: readonly string[]
  readonly connections: readonly StubConnection[]
  /** Every URL the page read or wrote over `fetch`, in order. */
  readonly requests: readonly { readonly url: string; readonly method: string }[]
  /** Every acknowledgement the page posted, in order. The write audit. */
  readonly ackRequests: readonly AckRequestRecord[]
  /** The connection currently open, or the last one opened. */
  latest(): StubConnection
  /** How many times the read routes have been read. */
  reads: number
  /** How many times the pending set has been read by the acknowledgement path. */
  pendingReads: number
  /** How many times the bounded history has been read. */
  historyReads: number
  /** The cursor the hub's `ready` and `heartbeat` frames report by default. */
  cursor: number
  /** What the read routes return. */
  sessions: readonly HubSession[]
  /** The pending set, as event identifiers. Its length is the pending count. */
  pending: readonly string[]
  /** The pending items the acknowledgement path reads. */
  pendingItems: readonly PendingItemRecord[]
  /** The events `/api/events` serves, verbatim and unparsed. */
  events: readonly Record<string, unknown>[]
  /** Set the read routes' answer. */
  setSnapshot(options: { sessions?: readonly HubSession[]; pending?: readonly string[] }): void
  /** Make the next read fail, as a hub that has gone away would. */
  failNextRead(): void
  /** Make the next pending read fail. */
  failNextPendingRead(): void
  /** Make the next history read fail. */
  failNextHistoryRead(): void
  /**
   * Hold the next acknowledgement's answer until the returned function is called.
   *
   * The optimistic half of an acknowledgement is only observable while the request is
   * in flight, so the stub has to be able to leave it in flight. One hold at a time:
   * the function releases the hold and further acknowledgements answer normally.
   */
  deferAck(): () => void
  /**
   * Answer the next acknowledgement with a refusal instead of applying it.
   *
   * Sticky until `acceptAck()`: a test that refuses an acknowledgement and then
   * presses the control again is testing a second refusal, not a fresh default.
   */
  refuseAck(answer: AckAnswer): void
  /** Go back to applying acknowledgements. */
  acceptAck(): void
  /** Fire the `ready` frame the hub opens every stream with. */
  ready(cursor?: number): void
  /** Fire one `change` frame. */
  change(frame: {
    cursor: number
    kind?: 'event-stored' | 'block-resolved' | 'acknowledged'
    session?: HubSession | null
    pendingCount?: number
    at?: string
  }): void
  /** Fire a `refresh-required` frame. */
  refreshRequired(frame: {
    reason?: 'cursor-too-old' | 'cursor-unusable' | 'cursor-unknown'
    requestedCursor?: number | null
    currentCursor: number
  }): void
  /** Fire a heartbeat. */
  heartbeat(cursor?: number): void
  /** Drop the open connection, as a socket that went away would. */
  drop(): void
  /** Run the reconnect timers the client scheduled. */
  runReconnect(): void
  readonly timers: FakeTimers
  createEventSource(url: string): StreamConnection
  readSnapshot(): Promise<{ sessions: readonly HubSession[]; pendingCount: number }>
  /**
   * The page's `fetch`, for the ack transport.
   *
   * A recorder that answers from the stub rather than a socket, so the *real*
   * transport builds the real request - its URL, its method, its one header and its
   * absent body - and this records what the page actually asked for.
   */
  fetch(input: string, init?: RequestInit): Promise<Response>
  now(): string
}

/**
 * A `Response` shaped like the one the transport reads.
 *
 * Two members, because `createFetchAckTransport` reads two: the status and the JSON
 * body. A real `Response` would work too, but building the shape here keeps the
 * harness independent of whether the jsdom environment carries undici's globals.
 */
function stubResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json(): Promise<unknown> {
      return body
    },
  } as unknown as Response
}

export function createStubHub(options: StubHubOptions = {}): StubHub {
  const opened: string[] = []
  const connections: StubConnection[] = []
  const requests: { url: string; method: string }[] = []
  const ackRequests: AckRequestRecord[] = []
  const timers = createFakeTimers()
  const hub: StubHub = {
    opened,
    connections,
    requests,
    ackRequests,
    cursor: 0,
    sessions: options.sessions ?? [],
    pending: options.pending ?? [],
    pendingItems: options.pendingItems ?? [],
    events: options.events ?? [],
    reads: 0,
    pendingReads: 0,
    historyReads: 0,
    timers,
    latest(): StubConnection {
      const connection = connections[connections.length - 1]
      if (connection === undefined) throw new Error('the page has not opened a connection yet')
      return connection
    },
    setSnapshot(next): void {
      if (next.sessions !== undefined) hub.sessions = next.sessions
      if (next.pending !== undefined) hub.pending = next.pending
    },
    failNextRead(): void {
      failing = true
    },
    failNextPendingRead(): void {
      pendingFailing = true
    },
    failNextHistoryRead(): void {
      historyFailing = true
    },
    deferAck(): () => void {
      let release = (): void => {}
      deferredAck = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => {
        release()
      }
    },
    refuseAck(answer): void {
      ackRefusal = answer
    },
    acceptAck(): void {
      ackRefusal = null
    },
    ready(cursor?: number): void {
      const at = cursor ?? hub.cursor
      hub.latest().fire('ready', {
        cursor: at,
        oldestRetainedCursor: null,
        heartbeatIntervalMs: 25_000,
        replayWindowMs: 300_000,
        replayMaxFrames: 512,
        at: LIVE_NOW,
      })
    },
    change(frame): void {
      hub.latest().fire('change', {
        cursor: frame.cursor,
        kind: frame.kind ?? 'event-stored',
        at: frame.at ?? LIVE_NOW,
        event: hubEvent({ sessionId: frame.session?.sessionId ?? 'session-one' }),
        session: frame.session ?? null,
        pendingCount: frame.pendingCount ?? hub.pending.length,
      })
    },
    refreshRequired(frame): void {
      hub.latest().fire('refresh-required', {
        reason: frame.reason ?? 'cursor-too-old',
        requestedCursor: frame.requestedCursor ?? null,
        oldestRetainedCursor: null,
        currentCursor: frame.currentCursor,
        at: LIVE_NOW,
      })
    },
    heartbeat(cursor?: number): void {
      hub.latest().fire('heartbeat', { cursor: cursor ?? hub.cursor, at: LIVE_NOW })
    },
    drop(): void {
      hub.latest().fire('error', { type: 'error', data: '' })
    },
    runReconnect(): void {
      // Everything except the page's own sixty-second age tick, which is not a
      // reconnect and must not be run by a test asking to reconnect.
      for (const timer of timers.pending.filter((candidate) => candidate.ms < 60_000)) timer.run()
    },
    createEventSource(url: string): StreamConnection {
      opened.push(url)
      const listeners = new Map<string, (event: StreamMessage) => void>()
      const connection: StubConnection = {
        url,
        addEventListener(type, listener) {
          listeners.set(type, listener)
        },
        removeEventListener(type, listener) {
          if (listeners.get(type) === listener) listeners.delete(type)
        },
        close() {
          connection.isClosed = true
          listeners.clear()
        },
        fire(type, data) {
          const listener = listeners.get(type)
          if (listener === undefined || connection.isClosed) return
          listener({ type, data: JSON.stringify(data) })
        },
        isClosed: false,
        get listenerCount(): number {
          return listeners.size
        },
      }
      connections.push(connection)
      return connection
    },
    async readSnapshot() {
      hub.reads = hub.reads + 1
      if (failing) {
        failing = false
        throw new Error('the hub could not be read')
      }
      return { sessions: hub.sessions, pendingCount: hub.pending.length }
    },
    async fetch(input, init) {
      const method = init?.method ?? 'GET'
      requests.push({ url: input, method })

      // `/api/pending`: the set the acknowledgement path chooses its item from. A
      // failure is answered with a status rather than thrown, because that is what a
      // hub does and the page's reader turns it into the `unreadable` refusal.
      if (input === `${LIVE_ORIGIN}/api/pending`) {
        hub.pendingReads = hub.pendingReads + 1
        if (pendingFailing) {
          pendingFailing = false
          return stubResponse(500, { error: 'internal-error' })
        }
        return stubResponse(200, { items: hub.pendingItems, count: hub.pendingItems.length })
      }

      // `/api/events`: the bounded history. The limit in the URL is the page's, and
      // the answer is clamped to it the way the route clamps what it is given.
      if (input.startsWith(`${LIVE_ORIGIN}/api/events`)) {
        hub.historyReads = hub.historyReads + 1
        if (historyFailing) {
          historyFailing = false
          return stubResponse(500, { error: 'internal-error' })
        }
        const limit = Number(new URLSearchParams(input.split('?')[1] ?? '').get('limit'))
        const events = hub.events.slice(0, Number.isFinite(limit) && limit > 0 ? limit : undefined)
        return stubResponse(200, historyPayload(events))
      }

      // `POST /api/ack/:eventId`: the one route that can change a record.
      if (!input.startsWith(`${LIVE_ORIGIN}${ACK_ROUTE_PREFIX}`)) {
        throw new Error(`the stub hub serves no route for ${method} ${input}`)
      }
      if (method !== 'POST') {
        return stubResponse(405, { error: 'method-not-allowed' })
      }
      const eventId = decodeURIComponent(input.slice(`${LIVE_ORIGIN}${ACK_ROUTE_PREFIX}`.length))
      const headers = normaliseHeaders(init?.headers)
      ackRequests.push({
        url: input,
        method,
        headers,
        body: typeof init?.body === 'string' ? init.body : null,
        eventId,
      })
      if (deferredAck !== null) {
        const hold = deferredAck
        deferredAck = null
        await hold
      }
      if (ackRefusal !== null) return stubResponse(ackRefusal.status, ackRefusal.body)
      // Apply it the way the hub does: the item leaves the pending set, and the count
      // the answer carries is the set's length afterwards - which is the number the
      // tray badge draws for the same state (NT-FR-05).
      hub.pending = hub.pending.filter((id) => id !== eventId)
      hub.pendingItems = hub.pendingItems
        .filter((item) => item.eventId !== eventId)
        .concat(
          hub.pendingItems
            .filter((item) => item.eventId === eventId)
            .map((item) => ({ ...item, ackState: 'acknowledged' as const })),
        )
      return stubResponse(200, {
        acknowledged: true,
        eventId,
        outcome: 'applied',
        reason: 'acknowledged',
        ackState: 'acknowledged',
        resolutionState: 'unresolved',
        pendingCount: hub.pending.length,
      })
    },
    now(): string {
      return LIVE_NOW
    },
  }
  let failing = false
  let pendingFailing = false
  let historyFailing = false
  let ackRefusal: AckAnswer | null = null
  let deferredAck: Promise<void> | null = null
  return hub
}

/** Headers as a plain object, however the request expressed them. */
function normaliseHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {}
  const entries: [string, string][] =
    headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers.map(([key, value]) => [key, value] as [string, string])
        : Object.entries(headers)
  return Object.fromEntries(entries.map(([key, value]) => [key.toLowerCase(), value]))
}

// ---------------------------------------------------------------------------
// Mounting the real entry point
// ---------------------------------------------------------------------------

export interface LiveMount {
  readonly dashboard: LiveDashboard
  readonly hub: StubHub
  readonly host: RecordingHost
  readonly target: RecordingTarget
  readonly container: HTMLElement
  /** The header the page prints into. */
  readonly header: HTMLElement
  /** The injected reduced-motion preference, or null when none was requested. */
  readonly preference: FakePreference | null
  /**
   * Every row the page asked to be brought into view, in order.
   *
   * A recorder rather than a scroll: the real one needs a viewport and a layout,
   * which jsdom has neither, so the default here is a seam that records. A test
   * that wants the real arithmetic asks for `'default'` and reads the window's
   * `scrollBy` instead. Mutable, so a test can clear it and read only the requests
   * its own keypresses caused.
   */
  readonly revealed: RevealedRow[]
  /**
   * The pointer path itself: the callback the painter is handed. Calling this is
   * what a pointer hovering a repository group does, so a test drives the real
   * wiring rather than the setter the callback happens to reach.
   */
  hoverRepository(repositoryId: string | null): void
  /** Let the client's pending promise work settle, without a real delay. */
  settle(): Promise<void>
  destroy(): void
}

export interface MountLiveOptions {
  readonly hub?: StubHub
  readonly width?: number
  readonly height?: number
  /** The query string the page was opened with. */
  readonly search?: string
  /**
   * Whether the page believes the developer asked for less motion. `undefined`
   * leaves the real policy in place, which jsdom answers as "not reduced" because
   * it has no `matchMedia`. Declared since LD-1 and ignored until LD-2, which is
   * the suite that had to prove a newly arrived row does not move.
   */
  readonly reducedMotion?: boolean
  /**
   * How the page should bring a focused row into view. Omitted, the page is given
   * a recorder and the requests land in `revealed`; `'default'` uses the shipped
   * implementation, which a test then observes through the window's `scrollBy`.
   */
  readonly scrollRowIntoView?: ScrollRowIntoView | 'default'
  /**
   * The write token this page holds. Omitted, the page reads the served document,
   * which in jsdom has no `<meta name="agent-ping-write-token">` and therefore no
   * token - the state a dashboard served as a static file is really in
   * (src/hub/security.ts). `'token'` gives it one, which is what makes an
   * acknowledgement possible at all.
   */
  readonly writeToken?: 'token' | null
  /** Whether the history panel starts open. Defaults to the page's own default. */
  readonly historyOpen?: boolean
  /**
   * Mount against the header exactly as `src/dashboard/index.html` declares it.
   *
   * The served document and the entry point each own half of the page's chrome, and
   * a real browser found what happens when the two disagree: the mount created a
   * second copy of the acknowledgement hint and of the refusals region, and every
   * reader found the empty one. jsdom cannot find that defect because its document
   * has no pre-declared header - so this option mounts with the real markup, and the
   * suite asserts there is exactly one of each.
   */
  readonly servedHeader?: boolean
}

const mounted: LiveDashboard[] = []

export async function mountLiveDashboard(options: MountLiveOptions = {}): Promise<LiveMount> {
  const hub = options.hub ?? createStubHub()
  const container = document.createElement('div')
  document.body.append(container)
  setContainerSize(container, options.width ?? 1024, options.height ?? 540)
  const target = createRecordingTarget()
  const fakePreference =
    options.reducedMotion === undefined ? null : createFakePreference(options.reducedMotion)
  const revealed: RevealedRow[] = []
  let host: RecordingHost | null = null
  // The header exactly as the hub serves it, when a test asks for it.
  const servedHeader =
    options.servedHeader === true
      ? (() => {
          const html = readFileSync(path.join(process.cwd(), 'src/dashboard/index.html'), 'utf8')
          const markup = /<header[^>]*data-dashboard-header[\s\S]*?<\/header>/.exec(html)?.[0]
          if (markup === undefined) throw new Error('index.html declares no dashboard header')
          const header = document.createElement('div')
          // The markup as served, wrapper and all: `mountDashboard` finds its header
          // by the attribute on the `<header>` itself, so the element handed to it is
          // that element rather than the div it was parsed inside.
          header.innerHTML = markup
          document.body.append(header)
          return header.firstElementChild as HTMLElement
        })()
      : null
  let hover: (repositoryId: string | null) => void = () => undefined

  const dashboard = await mountDashboard({
    container,
    ...(servedHeader === null ? {} : { header: servedHeader }),
    origin: LIVE_ORIGIN,
    now: () => LIVE_NOW,
    search: options.search ?? '',
    timers: hub.timers,
    ...(fakePreference === null
      ? {}
      : {
          createMotionController: (controllerOptions: MotionControllerOptions) =>
            createMotionController({ ...controllerOptions, preference: fakePreference.preference }),
        }),
    ...(options.scrollRowIntoView === 'default'
      ? {}
      : {
          scrollRowIntoView:
            options.scrollRowIntoView ?? ((row: RevealedRow): void => void revealed.push(row)),
        }),
    createHost: async ({ size }) => {
      host = createRecordingHost(container, size)
      return host
    },
    createTarget: (_root, sceneOptions) => {
      hover = sceneOptions.onRepositoryHover
      return target
    },
    createClient: (clientOptions) =>
      createStreamClient({
        ...clientOptions,
        createEventSource: hub.createEventSource,
        readSnapshot: hub.readSnapshot,
        timers: hub.timers,
        now: hub.now,
      }),
    // One `fetch` behind all three routes, so the requests this page makes are the
    // shipped ones: the ack transport builds its own URL, method, header and absent
    // body, and the pending and history readers build their own. The stub only
    // answers them, and records what it was asked.
    fetchImpl: hub.fetch,
    ...(options.writeToken === undefined ? {} : { writeToken: options.writeToken === 'token' ? 'test-write-token' : null }),
    ...(options.historyOpen === undefined ? {} : { historyOpen: options.historyOpen }),
  })
  mounted.push(dashboard)

  return {
    dashboard,
    hub,
    host: host as unknown as RecordingHost,
    target,
    container,
    header: dashboard.header,
    preference: fakePreference,
    revealed,
    hoverRepository(repositoryId: string | null): void {
      hover(repositoryId)
    },
    async settle(): Promise<void> {
      // Two turns: one for the reader's own promise, one for the publish that
      // follows it.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    },
    destroy(): void {
      dashboard.destroy()
    },
  }
}

export function destroyLiveMounts(): void {
  while (mounted.length > 0) mounted.pop()?.destroy()
  document.body.replaceChildren()
}

// ---------------------------------------------------------------------------
// Reading the command stream
// ---------------------------------------------------------------------------

export const textCommands = (commands: readonly DrawCommand[]): readonly TextCommand[] =>
  commands.filter((command): command is TextCommand => command.kind === 'text')

export const iconCommands = (commands: readonly DrawCommand[]) =>
  commands.filter(
    (command): command is Extract<DrawCommand, { kind: 'icon' }> => command.kind === 'icon',
  )

export const rectCommands = (commands: readonly DrawCommand[]) =>
  commands.filter(
    (command): command is Extract<DrawCommand, { kind: 'rect' }> => command.kind === 'rect',
  )

/** The commands drawn inside one row's band, which is how a row is inspected. */
export function commandsInRow(
  commands: readonly DrawCommand[],
  row: { readonly y: number; readonly height: number },
): readonly DrawCommand[] {
  return commands.filter((command) => {
    const top = command.kind === 'line' ? Math.min(command.y1, command.y2) : command.y
    return top >= row.y && top < row.y + row.height
  })
}

export function rowText(row: {
  readonly y: number
  readonly height: number
}, commands: readonly DrawCommand[], role: TextCommand['role']): string | undefined {
  return textCommands(commandsInRow(commands, row))
    .find((command) => command.role === role)
    ?.text
}

export function groupNames(commands: readonly DrawCommand[]): readonly string[] {
  return textCommands(commands)
    .filter((command) => command.role === 'repository-short-name')
    .map((command) => command.text)
}

export function revealedPaths(commands: readonly DrawCommand[]): readonly string[] {
  return textCommands(commands)
    .filter((command) => command.role === 'repository-full-path')
    .map((command) => command.text)
}

export function hoverRegionsOf(target: { regions: readonly HoverRegion[] }): readonly HoverRegion[] {
  return target.regions
}

/** Re-exported so a suite can type a recording target without importing PixiJS. */
export type { RecordingTarget, SceneTarget }
