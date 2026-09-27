// Shared jsdom harness for the LD-1 suites.
//
// The live page cannot be driven against a real hub here: jsdom has no
// `EventSource`, no `fetch` to a socket, and no 2D or WebGL context for
// `Application.init()`. So this harness supplies the three seams the real entry
// point takes - a stream transport, a full-refresh reader, and timers - and the
// two recording seams the prototype harness already established (a host and a
// scene target that record what the mount asked of them). Everything asserted in
// the two live suites is therefore asserted against the real `mountDashboard` and
// the exact command stream the browser would paint.
//
// The stub hub is a recorder rather than a mock: it keeps the URLs the client
// opened, the frames it was sent and how many times it re-read, so "reconnects
// with the last cursor" and "a too-old cursor triggers a full refresh" are read
// off the transport rather than asserted about a function.

import { createStreamClient, type HubSession, type HubSessionState, type StreamConnection, type StreamMessage } from '@/dashboard/live/stream-client'
import { mountDashboard, type LiveDashboard } from '@/dashboard/main'
import type { DrawCommand, HoverRegion, SceneTarget, TextCommand } from '@/dashboard/prototype/scene'
import { createRecordingHost, createRecordingTarget, setContainerSize, type RecordingHost, type RecordingTarget } from './prototype-harness'

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
}

export interface StubHub {
  /** Every URL the page opened, in order. The cursor contract is read off these. */
  readonly opened: readonly string[]
  readonly connections: readonly StubConnection[]
  /** The connection currently open, or the last one opened. */
  latest(): StubConnection
  /** How many times the read routes have been read. */
  reads: number
  /** The cursor the hub's `ready` and `heartbeat` frames report by default. */
  cursor: number
  /** What the read routes return. */
  sessions: readonly HubSession[]
  /** The pending set, as event identifiers. Its length is the pending count. */
  pending: readonly string[]
  /** Set the read routes' answer. */
  setSnapshot(options: { sessions?: readonly HubSession[]; pending?: readonly string[] }): void
  /** Make the next read fail, as a hub that has gone away would. */
  failNextRead(): void
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
  now(): string
}

export function createStubHub(options: StubHubOptions = {}): StubHub {
  const opened: string[] = []
  const connections: StubConnection[] = []
  const timers = createFakeTimers()
  const hub: StubHub = {
    opened,
    connections,
    cursor: 0,
    sessions: options.sessions ?? [],
    pending: options.pending ?? [],
    reads: 0,
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
    now(): string {
      return LIVE_NOW
    },
  }
  let failing = false
  return hub
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
  /** A reduced-motion preference the test controls. */
  readonly reducedMotion?: boolean
}

const mounted: LiveDashboard[] = []

export async function mountLiveDashboard(options: MountLiveOptions = {}): Promise<LiveMount> {
  const hub = options.hub ?? createStubHub()
  const container = document.createElement('div')
  document.body.append(container)
  setContainerSize(container, options.width ?? 1024, options.height ?? 540)
  const target = createRecordingTarget()
  let host: RecordingHost | null = null
  let hover: (repositoryId: string | null) => void = () => undefined

  const dashboard = await mountDashboard({
    container,
    origin: LIVE_ORIGIN,
    now: () => LIVE_NOW,
    search: options.search ?? '',
    timers: hub.timers,
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
  })
  mounted.push(dashboard)

  return {
    dashboard,
    hub,
    host: host as unknown as RecordingHost,
    target,
    container,
    header: dashboard.header,
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
