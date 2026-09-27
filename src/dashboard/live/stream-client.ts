// The live state client: the dashboard's one connection to the hub (LD-FR-03,
// LD-FR-04, LD-FR-10).
//
// WHAT THIS IS
// A client for `GET /api/stream` plus the two read routes a full refresh needs.
// It owns four states and says which one it is in at all times:
//
//   - `connecting`  opened, not yet told what cursor it is at
//   - `live`        the hub confirmed the connection, and the rows on the page are
//                   as current as the last frame it applied
//   - `stale`       the connection dropped and a reconnect is still pending, so the
//                   rows on the page are the last it was told and are not known to
//                   be current
//   - `disconnected` reconnecting gave up (or the first read failed), so nothing
//                   on the page can be called current at all
//
// The split between the last two is the whole point of the file. A page showing
// old rows next to a zero pending count reads as "nothing needs me", which is the
// one thing a developer must never be left believing about their own work. So
// `stale` and `disconnected` are both explicit, both say that the rows below are
// the last the hub sent, and the page prints them.
//
// ORDER, AND WHY IT IS THIS ORDER
// Subscribe, then read. A first connection carries no cursor (the hub answers a
// first connection with `live`, not a replay), so the client's first act is to
// open the stream; the `ready` frame then names the cursor, and only after that
// does the client read `/api/sessions` and `/api/pending`. The read therefore
// happens *after* the subscription exists, so a change published between the two
// is both in the read and in the stream, and applying the frame after the read is
// an idempotent upsert. The other order leaves a window in which a change is
// published, is missing from the read, and never arrives - a change the page would
// quietly never show.
//
// CURSOR, AND WHAT HAPPENS WHEN IT CANNOT BE HONOURED
// The cursor is the hub's own run-scoped integer and is only ever read out of a
// frame. On a reconnect it is sent as `?cursor=`, and the hub either replays what
// was missed or answers `refresh-required` naming why. The client treats that
// frame as an instruction, not as data: it re-reads the read routes, adopts the
// `currentCursor` the frame carries as its own, and clears the problem. It never
// applies a partial replay and never keeps counting from a cursor it has been told
// is wrong.
//
// NO WRITES, NO TELEMETRY, NO CONTENT
// There is no `fetch` with a method other than GET, no token, no origin other than
// the one the page was served from, and no field of anything it parses is rendered
// that could carry conversation content (APX-FR-01, APX-CON-12, ADR-002). The
// acknowledgement write route is LD-3's and this file has no reference to it.

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/**
 * The session lifecycle the store records, in its own six values
 * (`SessionState` in src/storage/eventStore.ts). Declared here rather than
 * imported so the browser bundle never reaches for a Node-hosted module;
 * tests/dashboard asserts in both directions that this union and the hub's are the
 * same, so a state the hub adds is a compile error here rather than a session
 * rendered as something this product has no word for.
 */
export type HubSessionState =
  | 'unknown'
  | 'running'
  | 'blocked'
  | 'finished'
  | 'idle-after-nothing'
  | 'gone'

/**
 * The hub's session row, in the exact field set the read route serves
 * (`SessionSummary` in src/storage/eventStore.ts).
 *
 * tests/dashboard/stream-client.test.ts asserts in both directions that this shape
 * and the hub's own are the same type, so a renamed field on the hub side is a
 * compile error here rather than a runtime surprise (that is the change this file's
 * author would have to make deliberately).
 */
export interface HubSession {
  readonly sessionId: string
  readonly harness: string
  /** The identity the dashboard groups and labels by (APX-CON-09). */
  readonly repoShortName: string
  readonly repoFullPath: string
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  readonly state: HubSessionState
  readonly workSignal: 0 | 1
  readonly pendingCount: number
}

/**
 * One stored event, in the field set the store persists. Typed because the change
 * frame carries it and LD-3 needs it typed; LD-1 renders no field of it, and a row
 * that showed one would be showing conversation content (APX-FR-01).
 */
export interface HubEventRecord {
  readonly eventId: string
  readonly sessionId: string
  readonly class: 'needs-you' | 'finished' | 'fyi'
  readonly subtype: 'error' | 'retry' | 'long-tool-call' | 'compaction' | 'token-burn' | null
  readonly rawEventType: string
  readonly occurredAt: string
  readonly receivedAt: string
  readonly dedupeKey: string
  readonly ackState: 'unacknowledged' | 'acknowledged'
  readonly resolutionState: 'unresolved' | 'resolved'
}

/** Every kind of transition the hub reports. */
export const CHANGE_KINDS = ['event-stored', 'block-resolved', 'acknowledged'] as const
export type ChangeKind = (typeof CHANGE_KINDS)[number]

/** Every named event the stream sends, and the ones this client acts on. */
export const STREAM_EVENT_NAMES = ['ready', 'change', 'heartbeat', 'refresh-required'] as const
export type StreamEventName = (typeof STREAM_EVENT_NAMES)[number]

/** Why a cursor could not be honoured. Each is a reason to re-read, never to guess. */
export type RefreshReason = 'cursor-too-old' | 'cursor-unusable' | 'cursor-unknown'

/** One `change` frame, as the hub sends it. */
export interface StateChangeFrame {
  readonly cursor: number
  readonly kind: ChangeKind
  readonly at: string
  readonly event: HubEventRecord
  /** Null only when the log has no row for it, which means re-read. */
  readonly session: HubSession | null
  readonly pendingCount: number
}

/** The `ready` frame's payload. */
export interface ReadyFrame {
  readonly cursor: number
  readonly oldestRetainedCursor: number | null
  readonly heartbeatIntervalMs: number
  readonly at: string
}

/** The `refresh-required` frame's payload: the reason, and the cursor to adopt. */
export interface RefreshRequiredFrame {
  readonly reason: RefreshReason
  readonly requestedCursor: number | null
  readonly oldestRetainedCursor: number | null
  readonly currentCursor: number
  readonly at: string
}

// ---------------------------------------------------------------------------
// The state the page renders
// ---------------------------------------------------------------------------

/**
 * How the page's data relates to the hub right now. Never a boolean and never
 * inferred from a colour: the header prints one of these as words, because a
 * disconnected page that looks like a quiet one is the failure this page exists to
 * prevent.
 */
export type ConnectionState = 'connecting' | 'live' | 'stale' | 'disconnected'

/** Why the page cannot call its rows current, as a closed set a caller can switch on. */
export type StreamProblem =
  /** The stream dropped and a reconnect is pending. The rows are the last it sent. */
  | { readonly kind: 'dropped' }
  /** The hub refused this client's cursor and asked for a full re-read. */
  | { readonly kind: 'refresh-required'; readonly reason: RefreshReason }
  /** The read routes could not be read, so the page has nothing to show. */
  | { readonly kind: 'unreadable' }
  /** Reconnecting gave up. Nothing on the page is current. */
  | { readonly kind: 'gave-up' }

/** Everything the page needs, in one immutable value. */
export interface LiveState {
  readonly connection: ConnectionState
  /** The hub's cursor this client's state is as of. Null until the hub says. */
  readonly cursor: number | null
  readonly sessions: readonly HubSession[]
  /**
   * The hub's unacknowledged pending count: the same number `/api/pending`
   * reports and the tray badge draws for the same state (LD-FR-04). It is read
   * from the hub on every frame and on every refresh, never computed here, so
   * the page and the badge cannot disagree about it.
   */
  readonly pendingCount: number
  readonly problem: StreamProblem | null
  /**
   * True when a frame arrived for a session the log has no row for. The client
   * re-reads when it is true; the page uses it to know its rows are behind.
   */
  readonly needsRefresh: boolean
  /** When the last applied frame or refresh landed. Null before the first one. */
  readonly updatedAt: string | null
}

export const INITIAL_LIVE_STATE: LiveState = Object.freeze({
  connection: 'connecting',
  cursor: null,
  sessions: Object.freeze([]),
  pendingCount: 0,
  problem: null,
  needsRefresh: false,
  updatedAt: null,
})

// ---------------------------------------------------------------------------
// The reduction, pure
// ---------------------------------------------------------------------------

/**
 * Apply one session row to a session list, by identity.
 *
 * An upsert rather than a replace, so a replay of a change the client already
 * applied lands on the same row instead of duplicating it. The list keeps its
 * existing position for a session that is already there, which is what stops a
 * reconnect from making every row jump: the list's order is the hub's read order
 * and this only ever corrects a row's own fields.
 */
export function upsertSession(
  sessions: readonly HubSession[],
  session: HubSession,
): readonly HubSession[] {
  const index = sessions.findIndex((candidate) => candidate.sessionId === session.sessionId)
  if (index < 0) return [...sessions, session]
  if (sessions[index] === session) return sessions
  const next = [...sessions]
  next[index] = session
  return next
}

/**
 * Apply one `change` frame. Pure, and total over the frames it can recognise.
 *
 * A frame whose `session` is null is not applied and not swallowed: the state it
 * returns carries `needsRefresh`, which is the client's instruction to re-read.
 * A frame the hub sent with a pending count carries the badge's own number, so
 * this is the only place a live update moves the count.
 */
export function reduceChangeFrame(state: LiveState, frame: StateChangeFrame): LiveState {
  const sessions =
    frame.session === null ? state.sessions : upsertSession(state.sessions, frame.session)
  return {
    ...state,
    connection: 'live',
    cursor: frame.cursor,
    sessions,
    pendingCount: frame.pendingCount,
    needsRefresh: frame.session === null,
    problem: null,
    updatedAt: frame.at,
  }
}

/** Apply a full re-read. The read is newer than anything a frame carried. */
export function reduceSnapshot(
  state: LiveState,
  snapshot: HubSnapshot,
  at: string,
): LiveState {
  return {
    ...state,
    sessions: snapshot.sessions,
    pendingCount: snapshot.pendingCount,
    needsRefresh: false,
    updatedAt: at,
  }
}

/** Move to a connection state, with the problem that explains it, or without one. */
export function reduceConnection(
  state: LiveState,
  connection: ConnectionState,
  problem: StreamProblem | null = null,
): LiveState {
  return { ...state, connection, problem }
}

// ---------------------------------------------------------------------------
// The transport seam
// ---------------------------------------------------------------------------

/** The one message shape this client needs from a stream. */
export interface StreamMessage {
  readonly type: string
  readonly data: string
}

/**
 * The slice of `EventSource` this client uses.
 *
 * Declared as an interface rather than taking the DOM type so jsdom - which has
 * no `EventSource` - can drive the real client through a recorder, and so a test
 * can assert the exact URL the page opened, which is where the cursor contract
 * lives.
 */
export interface StreamConnection {
  addEventListener(type: string, listener: (event: StreamMessage) => void): void
  removeEventListener(type: string, listener: (event: StreamMessage) => void): void
  close(): void
}

export type EventSourceFactory = (url: string) => StreamConnection

/** A full re-read: the sessions and the pending set, at one moment. */
export interface HubSnapshot {
  readonly sessions: readonly HubSession[]
  readonly pendingCount: number
}

export type SnapshotReader = () => Promise<HubSnapshot>

/** The clock and the one timer this client owns. Both injected, both teardown-visible. */
export interface ClientTimers {
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

// ---------------------------------------------------------------------------
// The routes and their URLs
// ---------------------------------------------------------------------------

/** The stream, the sessions and the pending set. All reads; none of them writes. */
export const STREAM_ROUTE = '/api/stream'
export const SESSIONS_ROUTE = '/api/sessions'
export const PENDING_ROUTE = '/api/pending'

/**
 * The URL a connection is opened with.
 *
 * The cursor rides as `?cursor=` rather than only as `Last-Event-ID`, because the
 * header is what a browser's own `EventSource` sends on an automatic reconnect and
 * the parameter is what a client that reloaded the page has left. The hub accepts
 * both and answers either one it cannot honour with `refresh-required`.
 */
export function streamUrl(origin: string, cursor: number | null): string {
  const base = `${origin}${STREAM_ROUTE}`
  return cursor === null ? base : `${base}?cursor=${String(cursor)}`
}

// ---------------------------------------------------------------------------
// Reconnecting
// ---------------------------------------------------------------------------

/** The first reconnect delay. Short: a dropped loopback socket is not a retry-able host. */
export const STREAM_RECONNECT_BASE_MS = 400
/** The ceiling the backoff doubles towards. */
export const STREAM_RECONNECT_MAX_MS = 8_000
/**
 * How many consecutive reconnects are attempted before the page says it is
 * disconnected. Bounded because a page that retries forever behind a dead hub
 * never says anything at all, which is the quiet page this whole feature exists to
 * prevent.
 */
export const STREAM_MAX_RECONNECT_ATTEMPTS = 5

/** The delay before attempt `attempt` (1-based), doubling up to the ceiling. */
export function reconnectDelayMs(attempt: number): number {
  const step = Math.max(0, attempt - 1)
  return Math.min(STREAM_RECONNECT_BASE_MS * 2 ** step, STREAM_RECONNECT_MAX_MS)
}

// ---------------------------------------------------------------------------
// Reading the hub
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

/**
 * Read a session row out of an untrusted payload, or null when it is not one.
 *
 * A frame this build cannot read is a frame that must not be applied: rendering a
 * half-understood row is how a page ends up showing a session with no repository
 * under it. Every field is checked, and the whole row is refused if any is missing.
 */
export function parseHubSession(value: unknown): HubSession | null {
  if (!isRecord(value)) return null
  const sessionId = asString(value['sessionId'])
  const harness = asString(value['harness'])
  const repoShortName = asString(value['repoShortName'])
  const repoFullPath = asString(value['repoFullPath'])
  const firstSeenAt = asString(value['firstSeenAt'])
  const lastSeenAt = asString(value['lastSeenAt'])
  const state = asString(value['state'])
  const pendingCount = asCount(value['pendingCount'])
  if (
    sessionId === null ||
    harness === null ||
    repoShortName === null ||
    repoFullPath === null ||
    firstSeenAt === null ||
    lastSeenAt === null ||
    state === null ||
    pendingCount === null
  ) {
    return null
  }
  return {
    sessionId,
    harness,
    repoShortName,
    repoFullPath,
    firstSeenAt,
    lastSeenAt,
    state: state as HubSessionState,
    workSignal: value['workSignal'] === 1 ? 1 : 0,
    pendingCount,
  }
}

/** The sessions a read route returned, dropping any row that is not readable. */
export function parseSessionsPayload(payload: unknown): readonly HubSession[] {
  if (!isRecord(payload)) return []
  const sessions = payload['sessions']
  if (!Array.isArray(sessions)) return []
  return sessions
    .map((entry) => parseHubSession(entry))
    .filter((entry): entry is HubSession => entry !== null)
}

/**
 * The pending count out of a `/api/pending` payload.
 *
 * The hub's own `count` wins when it is a count, because that is the number the
 * tray badge draws for the same state and the page must not be the one place that
 * disagrees (LD-FR-04). The length of the item list is the fallback, and the test
 * that drives the entry point asserts both halves of that.
 */
export function parsePendingCount(payload: unknown): number {
  if (!isRecord(payload)) return 0
  const declared = asCount(payload['count'])
  if (declared !== null) return declared
  const items = payload['items']
  return Array.isArray(items) ? items.length : 0
}

/**
 * Parse a `change` frame's payload, or null when it is not one this build can apply.
 *
 * A frame whose `session` is present but unreadable is still a frame this build can
 * act on: it is parsed with a null session, which is the same shape the hub sends
 * when the log has no row for the event, and a null session asks the client to
 * re-read. Refusing the whole frame instead would drop a real transition on the
 * grounds that one nested object was malformed, and re-reading recovers from both.
 */
export function parseChangeFrame(value: unknown): StateChangeFrame | null {
  if (!isRecord(value)) return null
  const cursor = asCount(value['cursor'])
  const kind = asString(value['kind'])
  const at = asString(value['at'])
  const pendingCount = asCount(value['pendingCount'])
  if (
    cursor === null ||
    kind === null ||
    at === null ||
    pendingCount === null ||
    !(CHANGE_KINDS as readonly string[]).includes(kind)
  ) {
    return null
  }
  return {
    cursor,
    kind: kind as ChangeKind,
    at,
    // The event row is carried so a later task can read it without reshaping the
    // frame. It is never rendered here: a row of it is conversation content.
    event: (isRecord(value['event']) ? value['event'] : {}) as unknown as HubEventRecord,
    session: value['session'] === null ? null : parseHubSession(value['session']),
    pendingCount,
  }
}

/** Parse a `ready` frame's payload, or null. */
export function parseReadyFrame(value: unknown): ReadyFrame | null {
  if (!isRecord(value)) return null
  const cursor = asCount(value['cursor'])
  const at = asString(value['at'])
  if (cursor === null || at === null) return null
  const oldest = value['oldestRetainedCursor']
  return {
    cursor,
    oldestRetainedCursor: asCount(oldest),
    heartbeatIntervalMs: asCount(value['heartbeatIntervalMs']) ?? 0,
    at,
  }
}

/** Parse a `refresh-required` frame's payload, or null. */
export function parseRefreshRequiredFrame(value: unknown): RefreshRequiredFrame | null {
  if (!isRecord(value)) return null
  const reason = asString(value['reason'])
  const currentCursor = asCount(value['currentCursor'])
  const at = asString(value['at'])
  if (
    reason === null ||
    currentCursor === null ||
    at === null ||
    !(['cursor-too-old', 'cursor-unusable', 'cursor-unknown'] as readonly string[]).includes(reason)
  ) {
    return null
  }
  return {
    reason: reason as RefreshReason,
    requestedCursor: asCount(value['requestedCursor']),
    oldestRetainedCursor: asCount(value['oldestRetainedCursor']),
    currentCursor,
    at,
  }
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown
  } catch {
    // A frame whose payload is not JSON is a frame this build does not understand.
    // Ignoring it is right; applying half of it would not be.
    return null
  }
}

// ---------------------------------------------------------------------------
// The browser transport
// ---------------------------------------------------------------------------

/**
 * The real `EventSource`, behind this file's interface.
 *
 * The wrapper exists rather than an `EventSource` being cast to `StreamConnection`
 * because the DOM listener takes an `Event` and this client wants the payload of a
 * `MessageEvent`. Every listener it adds is remembered so `close` can take them off
 * again: a page that navigates away must leave nothing of itself behind.
 */
export function browserEventSource(url: string): StreamConnection {
  const source = new EventSource(url)
  const registered = new Map<string, (event: Event) => void>()
  return {
    addEventListener(type, listener) {
      const wrapper = (event: Event): void => {
        listener({ type, data: (event as MessageEvent).data })
      }
      registered.set(type, wrapper)
      source.addEventListener(type, wrapper)
    },
    removeEventListener(type) {
      const wrapper = registered.get(type)
      if (wrapper === undefined) return
      source.removeEventListener(type, wrapper)
      registered.delete(type)
    },
    close() {
      source.close()
    },
  }
}

/**
 * A full re-read over `fetch`, from the origin the page itself was served from.
 *
 * The origin is never hardcoded and never read from an environment: a page that
 * fetched from anywhere but its own origin would be reaching across the boundary
 * the hub's loopback policy draws (APX-CON-01, ADR-002), and it is the page's own
 * origin by construction because the hub serves it.
 */
export function createFetchSnapshotReader(origin: string): SnapshotReader {
  return async (): Promise<HubSnapshot> => {
    const [sessionsResponse, pendingResponse] = await Promise.all([
      fetch(`${origin}${SESSIONS_ROUTE}`, { method: 'GET' }),
      fetch(`${origin}${PENDING_ROUTE}`, { method: 'GET' }),
    ])
    if (!sessionsResponse.ok || !pendingResponse.ok) {
      throw new Error(
        `the hub answered ${String(sessionsResponse.status)} for ${SESSIONS_ROUTE} and ` +
          `${String(pendingResponse.status)} for ${PENDING_ROUTE}`,
      )
    }
    return {
      sessions: parseSessionsPayload((await sessionsResponse.json()) as unknown),
      pendingCount: parsePendingCount((await pendingResponse.json()) as unknown),
    }
  }
}

/** The timers this client uses, defaulting to the ones the page has. */
export const defaultClientTimers: ClientTimers = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  },
  now: () => Date.now(),
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface CreateStreamClientOptions {
  /** The origin the page was served from. The only origin this client ever uses. */
  readonly origin: string
  /** Defaults to the browser's `EventSource`. */
  readonly createEventSource?: EventSourceFactory
  /** Defaults to a full re-read over `fetch` from `origin`. */
  readonly readSnapshot?: SnapshotReader
  /** Defaults to the page's own timers. */
  readonly timers?: ClientTimers
  /** The instant the page was opened. Used only as a fallback clock. */
  readonly now?: () => string
}

export interface StreamClient {
  /** Open the connection. Idempotent. */
  start(): void
  /** Observe every state change. Returns the unsubscribe. */
  onChange(listener: (state: LiveState) => void): () => void
  getState(): LiveState
  /**
   * Re-read the read routes now. Exposed because `refresh-required` needs it, and
   * because a page that is told it is behind must be able to catch up without a
   * reload.
   */
  refresh(): Promise<void>
  /** Close the connection, cancel the pending reconnect and drop every listener. */
  close(): void
  readonly isClosed: boolean
  /**
   * How many things this client still holds: an open connection, a pending
   * reconnect timer, and the state listeners. Zero after `close`, which is the
   * teardown assertion the entry point makes.
   */
  readonly activeSubscriptions: number
}

export function createStreamClient(options: CreateStreamClientOptions): StreamClient {
  const createEventSource = options.createEventSource ?? browserEventSource
  const readSnapshot = options.readSnapshot ?? createFetchSnapshotReader(options.origin)
  const timers = options.timers ?? defaultClientTimers
  const now = options.now ?? ((): string => new Date().toISOString())

  let state: LiveState = INITIAL_LIVE_STATE
  let connection: StreamConnection | null = null
  let registeredListeners: readonly [string, (event: StreamMessage) => void][] = []
  let reconnectTimer: unknown = null
  let attempts = 0
  let started = false
  let closed = false
  /** True once a full re-read has succeeded, so a dropped stream knows what it has. */
  let hasSnapshot = false
  const listeners = new Set<(state: LiveState) => void>()

  const publish = (next: LiveState): void => {
    state = next
    for (const listener of [...listeners]) listener(state)
  }

  const setConnection = (connectionState: ConnectionState, problem: StreamProblem | null = null): void => {
    if (state.connection === connectionState && state.problem === problem) return
    publish(reduceConnection(state, connectionState, problem))
  }

  const readAndApply = async (): Promise<void> => {
    try {
      const snapshot = await readSnapshot()
      if (closed) return
      hasSnapshot = true
      publish(reduceSnapshot(state, snapshot, now()))
      // A successful re-read clears a "too far behind" problem, but not a dropped
      // connection: the rows are current as of this read while the stream that
      // keeps them current is still gone.
      if (state.problem?.kind === 'refresh-required') {
        publish({ ...state, problem: null })
      }
    } catch {
      if (closed) return
      setConnection('disconnected', { kind: 'unreadable' })
    }
  }

  const refresh = (): Promise<void> => readAndApply()

  const closeConnection = (): void => {
    if (connection === null) return
    for (const [type, listener] of registeredListeners) {
      connection.removeEventListener(type, listener)
    }
    registeredListeners = []
    connection.close()
    connection = null
  }

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer !== null) return
    attempts += 1
    if (attempts > STREAM_MAX_RECONNECT_ATTEMPTS) {
      // Out of attempts. The page is told, rather than left retrying in silence
      // behind a hub that is not answering.
      setConnection('disconnected', { kind: 'gave-up' })
      return
    }
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null
      open()
    }, reconnectDelayMs(attempts))
  }

  const onFrame = (type: string, data: string): void => {
    if (closed) return
    switch (type) {
      case 'ready': {
        const ready = parseReadyFrame(parseJson(data))
        if (ready === null) return
        attempts = 0
        // A connection that reached `ready` is live. The re-read it triggers is
        // what fills the page, and it happens after this subscription exists, so
        // no change can fall between the two.
        setConnection('live')
        publish({ ...state, cursor: ready.cursor, problem: null })
        if (!hasSnapshot) void readAndApply()
        return
      }
      case 'change': {
        const change = parseChangeFrame(parseJson(data))
        if (change === null) return
        attempts = 0
        publish(reduceChangeFrame(state, change))
        if (state.needsRefresh) void readAndApply()
        return
      }
      case 'refresh-required': {
        const refreshRequired = parseRefreshRequiredFrame(parseJson(data))
        if (refreshRequired === null) return
        // Explicit, and acted on: the cursor the frame reports becomes this
        // client's cursor, because it is the hub's own answer about where the log
        // now stands, and the read routes are re-read from scratch. No partial
        // replay is applied and no count is kept from the frames that were missed.
        publish({
          ...state,
          cursor: refreshRequired.currentCursor,
          problem: { kind: 'refresh-required', reason: refreshRequired.reason },
        })
        void readAndApply()
        return
      }
      case 'heartbeat':
        // Deliberately nothing to apply: a keepalive is not a change, and
        // repainting the page for one would be work with no visible result.
        return
      default:
        return
    }
  }

  const onDrop = (): void => {
    if (closed) return
    closeConnection()
    if (hasSnapshot) {
      // Rows on the page, not known to be current, and a reconnect still to come.
      setConnection('stale', { kind: 'dropped' })
      scheduleReconnect()
      return
    }
    // Nothing has ever been read, so there is no "last known" to show and no
    // reconnect worth pretending about: the page says the hub is not answering.
    if (attempts >= STREAM_MAX_RECONNECT_ATTEMPTS) {
      setConnection('disconnected', { kind: 'gave-up' })
      return
    }
    attempts += 1
    setConnection('connecting', { kind: 'dropped' })
    scheduleReconnect()
  }

  const open = (): void => {
    if (closed) return
    closeConnection()
    // A reconnect attempt does not make the page current again. While it holds rows
    // it cannot vouch for, it stays `stale`; only a page that has read nothing yet is
    // merely `connecting`. Promoting the state here would put "Connecting to the hub"
    // next to an unqualified pending count for the whole length of a retry, which is
    // the one reading this page must not invite.
    setConnection(hasSnapshot ? 'stale' : 'connecting')
    const url = streamUrl(options.origin, state.cursor)
    try {
      connection = createEventSource(url)
    } catch {
      // A transport that cannot even be constructed is the same failure as one
      // that dies on open, and is answered the same way.
      onDrop()
      return
    }
    // One listener per named event plus the drop signal. All of them are removed
    // by `closeConnection`, and `close()` calls it, so teardown leaves nothing.
    const listeners: [string, (event: StreamMessage) => void][] = [
      ['ready', (event) => onFrame('ready', event.data)],
      ['change', (event) => onFrame('change', event.data)],
      ['heartbeat', (event) => onFrame('heartbeat', event.data)],
      ['refresh-required', (event) => onFrame('refresh-required', event.data)],
      ['error', () => onDrop()],
    ]
    registeredListeners = listeners
    for (const [type, listener] of listeners) {
      connection.addEventListener(type, listener)
    }
  }

  const close = (): void => {
    if (closed) return
    closed = true
    closeConnection()
    if (reconnectTimer !== null) {
      timers.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    listeners.clear()
  }

  return {
    start(): void {
      if (started || closed) return
      started = true
      open()
    },
    onChange(listener: (state: LiveState) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getState(): LiveState {
      return state
    },
    refresh,
    close,
    get isClosed(): boolean {
      return closed
    },
    get activeSubscriptions(): number {
      return listeners.size + (connection === null ? 0 : 1) + (reconnectTimer === null ? 0 : 1)
    },
  }
}
