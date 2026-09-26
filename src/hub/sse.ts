// The live state stream: the change feed, the bounded replay window and the wire
// format behind `GET /api/stream` (HC-FR-03, PRD 6.3, APX-CON-11).
//
// WHY THIS FILE IS THREE THINGS AND NOT ONE
//   1. `ChangeFeed` - an in-process broadcaster. It holds a cursor per change, a
//      bounded window of recent changes, the connected clients and one heartbeat
//      timer. It knows nothing about the store, nothing about HTTP and nothing
//      about the clock except the one it is handed, so every decision in it can
//      be tested without a socket.
//   2. `withChangeFeed` - the only place that knows both this module and the
//      store. It turns a state transition the store actually applied into a
//      change frame, and reports nothing for a no-op. Ingest (HC-3) and the ack
//      route (HC-4) reach the stream through this wrapper rather than knowing the
//      stream exists, which is why neither of them has to be changed for a
//      dashboard to update.
//   3. The wire format - `encodeStreamFrame` and the pure `planReplay`. A test
//      can assert the exact bytes and the exact reconnect decision without
//      opening a port.
//
// A CURSOR, NOT A TIMESTAMP
// The cursor is a monotonic integer scoped to one hub run, not a time. Two
// reasons. A timestamp cannot order two changes inside the same millisecond, and
// a dashboard that missed both of them has to be able to say so exactly; and a
// time cursor is ambiguous across a restart, where a client's "last change I saw
// at 09:00" is indistinguishable from one it saw in a previous run of the same
// process's data. A run-scoped integer is unambiguous, and the ambiguity of a
// cursor from a previous run is answered explicitly (see `planReplay`).
//
// BOUNDED MEANS BOUNDED, IN THREE PLACES
// A stream that replays everything a client missed is an unbounded queue wearing
// a cursor. Three bounds apply, and each is a named export a test reads:
// `STREAM_REPLAY_MAX_FRAMES` caps how many frames are retained (memory), and
// `STREAM_REPLAY_WINDOW_MS` caps how old the oldest retained frame may be (time).
// A fourth bound belongs to the client rather than the feed: a sink that will not
// take another frame is closed instead of buffered, and the client recovers by
// reconnecting with the cursor it last applied - which is the whole point of
// having one.
//
// WHAT A CURSOR TOO OLD MUST LOOK LIKE
// A client whose cursor cannot be honoured gets an explicit `refresh-required`
// frame naming the reason, and no change frames at all. The failure this avoids
// is the expensive one: a dashboard that receives a partial replay and shows it
// as current state. "Here is everything after your cursor" is the answer when it
// is true, and "re-read the hub, you are too far behind" is the answer when it is
// not. There is no third answer, and in particular a malformed cursor is not a
// 400: a browser reconnects this endpoint automatically, and an error response to
// an automatic reconnect is a stream that can never recover on its own.
//
// NOTHING HERE CAN HOLD CONTENT
// A change frame is built from the store's own content-free read shapes - the
// event record, the session summary and a count - and from a kind, a cursor and a
// timestamp. There is no field here that is not one of those, and
// tests/hub/stream.test.ts asserts the key set of a real frame over a real socket
// (APX-FR-01, ADR-003). The `ready` frame carries the stream's own configuration
// and the cursor it is at; no frame echoes the request that opened the stream.
//
// This module opens no socket, spawns no process and calls nothing off the
// machine (APX-CON-12). The heartbeat timer is unref'd on purpose: a keepalive
// must never be the reason a process stays alive, and `close()` clears it.

import type {
  EventRecord,
  EventStore,
  InsertResult,
  MutationResult,
  NewEvent,
  SessionSummary,
} from '../storage/eventStore.js'

// ---------------------------------------------------------------------------
// Configuration, and the numbers behind it
// ---------------------------------------------------------------------------

/**
 * How often an idle stream is told "still here".
 *
 * Twenty-five seconds, from the feature document's Open Questions 3. The job of
 * the frame is to keep an idle connection from being dropped by a middlebox and
 * to let a client notice a dead hub, so it has to be shorter than any plausible
 * idle timeout and long enough that a hub nobody is watching costs almost
 * nothing. It is a named constant rather than an inline literal so the test that
 * asserts the default and the code that sends cannot disagree.
 */
export const STREAM_HEARTBEAT_INTERVAL_MS = 25_000

/**
 * How long a retained change stays replayable.
 *
 * Five minutes, from the same open question. It is longer than any plausible
 * disconnection - a closed laptop lid, a suspended container, a dropped wifi -
 * and short enough that the retained window is small on a hub that is genuinely
 * busy. Past it a client is told to refresh rather than handed a partial answer.
 */
export const STREAM_REPLAY_WINDOW_MS = 300_000

/**
 * How many changes are retained, whatever their age.
 *
 * A time window alone does not bound memory: a harness emitting a hundred blocks
 * a minute would retain five minutes of them, and a hub that is too busy to
 * service its stream is exactly the hub that must not also grow an unbounded
 * array. Five hundred and twelve frames of roughly six hundred bytes is about
 * three hundred kilobytes, which is noise against the 150 MB idle budget
 * (APX-CON-11), and the count is deliberately a power of two so a reader can see
 * it is a budget rather than a measurement.
 *
 * This is my number and not the document's: the open question specifies a time
 * window, and a time window is not a memory bound. Both are asserted by a test.
 */
export const STREAM_REPLAY_MAX_FRAMES = 512

/**
 * How many clients one hub will stream to at once.
 *
 * A bound, because the stream is the only route a caller can hold open
 * indefinitely, the hub is unauthenticated on read (HC-FR-06), and an unbounded
 * set of live connections is a way for any local process to make the hub hold
 * memory on demand. Sixteen is far more than the handful of dashboard windows
 * and scripts a developer runs, and a client over the limit is told so rather
 * than queued: a queue is a latency budget nobody asked for.
 */
export const STREAM_MAX_CLIENTS = 16

/**
 * The reconnection delay the stream asks a browser `EventSource` to use.
 *
 * Sent once in the stream preamble as the `retry` field. Two seconds is quick
 * enough that a hub restart is barely noticed and slow enough that a hub that is
 * down does not get a tight reconnect loop from every open dashboard at once.
 */
export const STREAM_RECONNECT_HINT_MS = 2_000

/**
 * The stream's own media type.
 *
 * Named because the route and the test that asserts the response both need it,
 * and a content type spelled twice is a content type that can drift.
 */
export const STREAM_CONTENT_TYPE = 'text/event-stream; charset=utf-8'

/** Every kind of transition the feed can report. */
export const CHANGE_KINDS = ['event-stored', 'block-resolved', 'acknowledged'] as const

/**
 * What changed, in the product's own vocabulary.
 *
 * A closed union of three literals. The dashboard switches on it (LD-1), so a
 * fourth kind of transition is a change to this file and not a string a caller
 * may invent - the same closed-union discipline the store and the counters use.
 */
export type ChangeKind = (typeof CHANGE_KINDS)[number]

/** Every event name the stream sends. */
export const STREAM_EVENT_NAMES = ['ready', 'change', 'heartbeat', 'refresh-required'] as const

/**
 * The named SSE events on the wire.
 *
 * `ready` opens every stream, `change` is a state transition, `heartbeat` is the
 * keepalive, and `refresh-required` is the explicit "you are too far behind"
 * answer. All four are named rather than anonymous: a default (`message`) frame
 * would make a client that does not understand one of them treat it as data it
 * should apply, which for `refresh-required` is the stale-state failure this
 * stream exists to avoid.
 */
export type StreamEventName = (typeof STREAM_EVENT_NAMES)[number]

// ---------------------------------------------------------------------------
// The change itself
// ---------------------------------------------------------------------------

/**
 * A state transition as the feed reports it, before the feed's own fields.
 *
 * Three facts and nothing else: what kind of transition it was, the event row as
 * the store reports it afterwards, the session row as the store reports it
 * afterwards (null only if the log has no row for it, which a client must treat
 * as "re-read"), and the whole log's pending count - the number the tray badge
 * shows (NT-FR-05), read from the store rather than kept here so there is still
 * one source of truth for it.
 */
export interface StateChangeReport {
  readonly kind: ChangeKind
  readonly event: EventRecord
  readonly session: SessionSummary | null
  readonly pendingCount: number
}

/**
 * A published change: the report plus the cursor and instant the feed gave it.
 *
 * `cursor` is the whole contract with a reconnecting client, and `at` is the
 * feed's own clock rather than the store's `receivedAt`, because the age bound
 * is about how long the frame has been retained and not about when the harness
 * said the thing happened.
 */
export interface StateChange extends StateChangeReport {
  readonly cursor: number
  readonly at: string
}

// ---------------------------------------------------------------------------
// The replay decision
// ---------------------------------------------------------------------------

/**
 * What a client asked for, after reading both places a cursor can arrive in.
 *
 * `Last-Event-ID` is how a browser's `EventSource` reconnects on its own, and
 * `?cursor=` is how a client that reloaded the page - and lost its last id -
 * reconnects. Both are accepted, the query parameter first, because an explicit
 * parameter is a deliberate choice and a header is a leftover.
 */
export type CursorRequest =
  /** No cursor at all: a first connection, which has no state to catch up on. */
  | { readonly kind: 'none' }
  /** A cursor this build understands. */
  | { readonly kind: 'cursor'; readonly cursor: number }
  /**
   * Something was asked for and it cannot be a cursor. Recorded rather than
   * dropped, because "the client sent a cursor this build cannot read" and "the
   * client sent no cursor" are different situations and only one of them is
   * worth a bug report.
   */
  | { readonly kind: 'unusable'; readonly raw: string }

/** Why a cursor could not be honoured. Each is answered, none is swallowed. */
export type RefreshReason =
  /** A change the client needs is no longer retained: a real gap. */
  | 'cursor-too-old'
  /** The client sent something that is not a cursor. */
  | 'cursor-unusable'
  /**
   * The cursor is ahead of this feed. In practice a client reconnecting to a hub
   * that restarted, because cursors are scoped to one run; its state may be
   * arbitrarily stale and there is no way to know how stale.
   */
  | 'cursor-unknown'

/** What the feed will do about the cursor a client arrived with. */
export type ReplayPlan =
  /** Send these frames in order, then go live. */
  | { readonly kind: 'replay'; readonly frames: readonly StateChange[] }
  /** The client is already at the current cursor. Go live. */
  | { readonly kind: 'live' }
  /** Tell the client to re-read, and send no change frames. */
  | {
      readonly kind: 'refresh-required'
      readonly reason: RefreshReason
      readonly requestedCursor: number | null
      readonly oldestRetainedCursor: number | null
      readonly currentCursor: number
    }

/**
 * Decide what a connecting client needs, from the retained window alone.
 *
 * A pure function of the window, the current cursor and the request, with no
 * clock and no I/O, because it is the decision most worth testing exhaustively:
 * the interesting inputs are the ones around the edges of the window, and a
 * decision that needs a socket to exercise is a decision nobody will exercise.
 *
 * The rules, in the order they are checked:
 *
 *   - Nothing requested: `live`. A first connection has no state to catch up on;
 *     it is expected to have read the read routes already, and inventing a
 *     resync for it would send it a refresh signal it has no use for.
 *   - Unusable: `refresh-required`. Never a 400, because an automatic reconnect
 *     would be answered with the same error forever.
 *   - Ahead of the feed: `refresh-required` with `cursor-unknown`. A run-scoped
 *     cursor from a previous run lands here, and it is the case where the
 *     client's state is most likely to be stale and least possible to repair by
 *     replay.
 *   - Equal to the current cursor: `live`.
 *   - Older, and every change after it is still retained: `replay`, exactly
 *     those changes. "Every change after it" means the run
 *     `requested + 1 .. currentCursor`, so a window that starts *earlier* than
 *     the client's cursor is still a complete answer - the frames before it are
 *     the client's own and are not resent.
 *   - Older, and at least one change after it is gone: `refresh-required` with
 *     `cursor-too-old`. The check is on both ends of the run, because a window
 *     that is short by one frame, or one that does not reach the current cursor,
 *     must not be mistaken for a complete answer.
 *
 * The retained run is contiguous by construction - the feed appends at the end
 * and evicts from the front - so its length and its last cursor are enough to
 * locate the first frame the client needs. That is what the two end checks
 * assert, and a caller handing in a window with a hole in it gets a refusal
 * rather than a partial replay.
 */
export function planReplay(input: {
  readonly retained: readonly StateChange[]
  readonly currentCursor: number
  readonly requested: CursorRequest
}): ReplayPlan {
  const { retained, currentCursor, requested } = input
  const oldest = retained[0]?.cursor ?? null
  const refuse = (reason: RefreshReason, requestedCursor: number | null): ReplayPlan => ({
    kind: 'refresh-required',
    reason,
    requestedCursor,
    oldestRetainedCursor: oldest,
    currentCursor,
  })

  if (requested.kind === 'unusable') return refuse('cursor-unusable', null)
  if (requested.kind === 'none') return { kind: 'live' }
  if (requested.cursor > currentCursor) return refuse('cursor-unknown', requested.cursor)

  const missed = currentCursor - requested.cursor
  if (missed === 0) return { kind: 'live' }

  const start = retained[retained.length - missed]
  const last = retained[retained.length - 1]
  if (
    start === undefined ||
    last === undefined ||
    last.cursor !== currentCursor ||
    start.cursor !== requested.cursor + 1
  ) {
    return refuse('cursor-too-old', requested.cursor)
  }
  return { kind: 'replay', frames: retained.slice(retained.length - missed) }
}

/**
 * Read a cursor out of a raw string.
 *
 * A plain run of at most fifteen decimal digits, and nothing else. Strictness is
 * the point: `'1.5'`, `'-1'`, `'0x10'`, `'1e3'`, `'NaN'`, `'Infinity'` and a
 * sixteen-digit value that would lose precision as a double are all answered
 * with the refresh signal rather than quietly rounded into a cursor that means
 * something else. An empty or blank string is no cursor at all, because `?cursor=`
 * is a client that templated an absent value and treating it as a corrupt cursor
 * would be unkind.
 */
export function parseCursor(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (!/^\d{1,15}$/.test(trimmed)) return Number.NaN
  return Number(trimmed)
}

/**
 * Read a cursor out of a raw string into a request.
 *
 * A number that `parseCursor` refused becomes `unusable` rather than `none`,
 * which is the whole difference between "this client is new" and "this client is
 * broken", and `planReplay` answers the two differently.
 */
export function cursorRequest(raw: string | null | undefined): CursorRequest {
  const parsed = parseCursor(raw)
  if (parsed === null) return { kind: 'none' }
  if (Number.isNaN(parsed)) return { kind: 'unusable', raw: String(raw ?? '') }
  return { kind: 'cursor', cursor: parsed }
}

// ---------------------------------------------------------------------------
// The wire format
// ---------------------------------------------------------------------------

/** One frame as it goes on the wire. */
export interface StreamFrame {
  /**
   * The cursor this frame carries, or null for a frame that advances nothing.
   *
   * The SSE `id` field is what a browser's `EventSource` remembers as
   * `Last-Event-ID`, so putting the cursor here is what makes an automatic
   * reconnect resume from the right place with no code in the dashboard at all.
   * A heartbeat carries no id precisely so it cannot move that mark: a keepalive
   * is not a change and must not look like one.
   */
  readonly id: number | null
  readonly event: StreamEventName
  readonly data: unknown
}

/**
 * Encode one frame as SSE wire text.
 *
 * A frame is `field: value` lines terminated by a blank line, and the rules that
 * matter here are two. A `data` payload never contains a raw newline - JSON
 * escapes them - and this encodes a multi-line payload as several `data:` lines
 * anyway, because the specification's own rule is to join them with newlines and
 * a caller who finds a way to put one in has then written a valid frame rather
 * than a corrupted stream. And the terminating blank line is always written, so a
 * truncated frame is a frame the client never dispatches rather than one it
 * dispatches with half a payload.
 */
export function encodeStreamFrame(frame: StreamFrame): string {
  const lines: string[] = []
  if (frame.id !== null) lines.push(`id: ${frame.id}`)
  lines.push(`event: ${frame.event}`)
  for (const line of JSON.stringify(frame.data ?? null).split('\n')) lines.push(`data: ${line}`)
  return `${lines.join('\n')}\n\n`
}

/** The stream preamble: a comment to flush the headers, and the retry hint. */
export function encodeStreamPreamble(comment: string, retryMs: number): string {
  return `: ${comment}\nretry: ${retryMs}\n\n`
}

/** The frame that opens a stream: the cursor it is at and how it behaves. */
export function readyFrame(input: {
  readonly cursor: number
  readonly oldestRetainedCursor: number | null
  readonly heartbeatIntervalMs: number
  readonly replayWindowMs: number
  readonly replayMaxFrames: number
  readonly at: string
}): StreamFrame {
  return {
    // The id matters here: a first connection is current as of this cursor, so a
    // browser that reconnects on its own resumes from the right place without
    // the dashboard having to remember anything.
    id: input.cursor,
    event: 'ready',
    data: {
      cursor: input.cursor,
      oldestRetainedCursor: input.oldestRetainedCursor,
      heartbeatIntervalMs: input.heartbeatIntervalMs,
      replayWindowMs: input.replayWindowMs,
      replayMaxFrames: input.replayMaxFrames,
      at: input.at,
    },
  }
}

/** The frame for one state transition. */
export function changeFrame(change: StateChange): StreamFrame {
  return { id: change.cursor, event: 'change', data: change }
}

/**
 * The keepalive frame.
 *
 * Carries the cursor the client is at, so a client that has been quiet for a
 * while can tell "nothing has changed" from "the connection is alive but I have
 * lost track of where I am" without asking. No id: see `StreamFrame.id`.
 */
export function heartbeatFrame(input: { readonly cursor: number; readonly at: string }): StreamFrame {
  return { id: null, event: 'heartbeat', data: { cursor: input.cursor, at: input.at } }
}

/**
 * The frame that tells a client its cursor could not be honoured.
 *
 * The data is the reason, the cursor asked for, the oldest change still
 * retained and the current cursor: enough for a client to log the fact and for a
 * developer to see afterwards whether the gap was time or volume. No request
 * detail, no payload echo, nothing but numbers and a reason (APX-FR-01).
 */
export function refreshRequiredFrame(
  plan: Extract<ReplayPlan, { readonly kind: 'refresh-required' }>,
  at: string,
): StreamFrame {
  return {
    id: plan.currentCursor,
    event: 'refresh-required',
    data: {
      reason: plan.reason,
      requestedCursor: plan.requestedCursor,
      oldestRetainedCursor: plan.oldestRetainedCursor,
      currentCursor: plan.currentCursor,
      at,
    },
  }
}

/**
 * Where a client's frames go.
 *
 * An interface rather than a `ServerResponse` so the memory bound below is
 * testable without a stalled socket, and so this module keeps no dependency on
 * node:http.
 */
export interface FrameSink {
  /**
   * Write one chunk.
   *
   * Returns false when the sink cannot take more data promptly, which is Node's
   * backpressure signal and the only honest measure of "this client is not
   * reading".
   */
  write(chunk: string): boolean
  /** End the stream. Must be safe to call on a response that is already gone. */
  end(): void
}

/** Why a connected client was closed. */
export type StreamCloseReason =
  /** The client stopped reading and its frames were being buffered. */
  | 'client-overrun'
  /** The hub is closing. */
  | 'hub-closing'

/**
 * Write one frame, and close the client if it will not take it.
 *
 * The alternative - keep writing into a buffer the client is not draining - is
 * the unbounded half of a stream's memory, and it is the half that is easy to
 * miss because the frames are small. A client that is not reading is closed, and
 * it recovers on its own: it reconnects with the cursor of the last frame it
 * actually applied, and `planReplay` hands it the changes it missed. Every
 * browser `EventSource` in the product does exactly that without being asked.
 */
export function writeFrame(sink: FrameSink, frame: StreamFrame): boolean {
  if (sink.write(encodeStreamFrame(frame))) return true
  sink.end()
  return false
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

/** The bounds a stream runs under. */
export interface StreamSettings {
  /** How often an idle client is kept alive. 0 disables the heartbeat. */
  readonly heartbeatIntervalMs: number
  /** How long a retained change stays replayable. */
  readonly replayWindowMs: number
  /** How many changes are retained, whatever their age. */
  readonly replayMaxFrames: number
  /** How many clients may be connected at once. */
  readonly maxClients: number
}

export const DEFAULT_STREAM_SETTINGS: StreamSettings = {
  heartbeatIntervalMs: STREAM_HEARTBEAT_INTERVAL_MS,
  replayWindowMs: STREAM_REPLAY_WINDOW_MS,
  replayMaxFrames: STREAM_REPLAY_MAX_FRAMES,
  maxClients: STREAM_MAX_CLIENTS,
}

/**
 * Fold partial settings into the defaults, clamped into their ranges.
 *
 * A value that is not a finite number takes the default rather than becoming
 * `NaN` in a timer or a comparison, and a value below a range's floor takes the
 * floor. `heartbeatIntervalMs` is the exception: 0 is a real setting meaning "no
 * heartbeat", because a test that wants to prove the absence of one needs to be
 * able to ask for it, and a negative interval is not.
 */
export function resolveStreamSettings(partial?: Partial<StreamSettings>): StreamSettings {
  const pick = (value: number | undefined, fallback: number, floor: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(floor, Math.floor(value))
      : fallback
  return {
    heartbeatIntervalMs: pick(
      partial?.heartbeatIntervalMs,
      DEFAULT_STREAM_SETTINGS.heartbeatIntervalMs,
      0,
    ),
    replayWindowMs: pick(partial?.replayWindowMs, DEFAULT_STREAM_SETTINGS.replayWindowMs, 0),
    replayMaxFrames: pick(partial?.replayMaxFrames, DEFAULT_STREAM_SETTINGS.replayMaxFrames, 1),
    maxClients: pick(partial?.maxClients, DEFAULT_STREAM_SETTINGS.maxClients, 1),
  }
}

/** A connected client, as the feed sees it. */
export interface StreamSubscriber {
  /** One frame for this client. A throw closes it rather than the hub. */
  onFrame(frame: StreamFrame): void
  /** The periodic keepalive. */
  onHeartbeat(frame: StreamFrame): void
  /** The stream is over; end the response. */
  onClose(reason: StreamCloseReason): void
}

/** The opaque handle a timer library hands back. */
export type TimerHandle = unknown

/**
 * The clock and the timer, injected.
 *
 * A hub needs one real clock and one real interval. A test needs to know that a
 * timer was cleared and that a frame ages out, and both of those are invisible
 * from the outside on a five-minute window and a twenty-five-second heartbeat.
 * The defaults are the globals; nothing else in the product passes anything.
 */
export interface ChangeFeedDeps {
  /** Milliseconds since the epoch. Drives the replay window's age bound. */
  now(): number
  setInterval(handler: () => void, ms: number): TimerHandle
  clearInterval(handle: TimerHandle): void
}

const defaultFeedDeps: ChangeFeedDeps = {
  now: (): number => Date.now(),
  setInterval: (handler: () => void, ms: number): TimerHandle => {
    const timer: NodeJS.Timeout = setInterval(handler, ms)
    // A keepalive must never be the reason a process stays alive: an unclosed
    // hub holding a 25-second timer is fine, a closed one is a bug, and unref
    // means the bug cannot outlive the thing it was keeping alive.
    timer.unref?.()
    return timer
  },
  clearInterval: (handle: TimerHandle): void => clearInterval(handle as NodeJS.Timeout),
}

/** The feed, as the route and the composition root use it. */
export interface ChangeFeed {
  readonly settings: StreamSettings
  /** The highest cursor published, or 0 when nothing has been published. */
  currentCursor(): number
  /** The oldest cursor still replayable, or null when nothing is retained. */
  oldestRetainedCursor(): number | null
  /** The retained window, oldest first, pruned to the age bound. */
  retainedFrames(now?: number): readonly StateChange[]
  /** How many clients are connected. */
  subscriberCount(): number
  /** Publish a transition. Returns the change as it was stamped. */
  publish(report: StateChangeReport): StateChange
  /** Connect a client. Returns the idempotent disconnect function. */
  subscribe(subscriber: StreamSubscriber): () => void
  /** True once `close` has run. */
  isClosed(): boolean
  /** Drop every client, clear the timer and release the retained window. */
  close(): void
}

/**
 * A publish after the hub is closing.
 *
 * Thrown rather than dropped. HC-FR-10 says the hub stops accepting events on a
 * termination signal, and a transition reaching the feed after `close` means the
 * shutdown ordering is wrong - which is a bug to find, not a frame to lose in
 * silence (APX-FR-02).
 */
export class StreamFeedClosedError extends Error {
  constructor() {
    super(
      'the state change feed is closed: a state transition was published after the hub began ' +
        'shutting down. The shutdown order is wrong - the hub must stop accepting events before ' +
        'it closes the stream (HC-FR-10).',
    )
    this.name = 'StreamFeedClosedError'
  }
}

class ChangeBus implements ChangeFeed {
  readonly settings: StreamSettings
  readonly #deps: ChangeFeedDeps
  #retained: StateChange[] = []
  #subscribers = new Set<StreamSubscriber>()
  #cursor = 0
  #timer: TimerHandle | null = null
  #closed = false

  constructor(settings: StreamSettings, deps: ChangeFeedDeps = defaultFeedDeps) {
    this.settings = settings
    this.#deps = deps
    if (settings.heartbeatIntervalMs > 0) {
      this.#timer = deps.setInterval(() => this.#beat(), settings.heartbeatIntervalMs)
    }
  }

  currentCursor(): number {
    return this.#cursor
  }

  oldestRetainedCursor(): number | null {
    // Pruned on read, like `retainedFrames`, so a caller never learns that a frame
    // is still replayable when the age bound has already passed.
    this.#prune(this.#deps.now())
    return this.#retained[0]?.cursor ?? null
  }

  retainedFrames(now: number = this.#deps.now()): readonly StateChange[] {
    this.#prune(now)
    return [...this.#retained]
  }

  subscriberCount(): number {
    return this.#subscribers.size
  }

  isClosed(): boolean {
    return this.#closed
  }

  publish(report: StateChangeReport): StateChange {
    if (this.#closed) throw new StreamFeedClosedError()
    const now = this.#deps.now()
    this.#cursor += 1
    const change: StateChange = {
      cursor: this.#cursor,
      at: new Date(now).toISOString(),
      ...report,
    }
    this.#retained.push(change)
    this.#prune(now)
    // A copy, because a subscriber is allowed to unsubscribe from inside its own
    // callback and a live set must not be mutated underneath the iteration.
    for (const subscriber of [...this.#subscribers]) this.#deliver(subscriber, change)
    return change
  }

  subscribe(subscriber: StreamSubscriber): () => void {
    if (this.#closed) return (): void => undefined
    this.#subscribers.add(subscriber)
    return (): void => {
      this.#subscribers.delete(subscriber)
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#timer !== null) {
      this.#deps.clearInterval(this.#timer)
      this.#timer = null
    }
    for (const subscriber of [...this.#subscribers]) {
      this.#subscribers.delete(subscriber)
      this.#notify(subscriber, 'hub-closing')
    }
    // The window goes with the run. The cursor does not: a client that reconnects
    // to a closed feed must be told its cursor is from a run that no longer
    // exists, and that answer depends on the cursor still reading as ahead of
    // this feed rather than as a feed that never published anything.
    this.#retained = []
  }

  /**
   * Age and count bounds, in that order.
   *
   * The count bound is applied first because memory is the property that can end
   * the process, while the age bound is a freshness promise. `retainedFrames`
   * prunes on read as well as on publish, so a hub that goes quiet still ages its
   * window out rather than holding the last change before a lunch break as though
   * it were replayable.
   */
  #prune(now: number): void {
    while (this.#retained.length > this.settings.replayMaxFrames) this.#retained.shift()
    while (this.#retained.length > 0) {
      const oldest = this.#retained[0]
      if (oldest === undefined) break
      if (now - Date.parse(oldest.at) <= this.settings.replayWindowMs) break
      this.#retained.shift()
    }
  }

  #beat(): void {
    if (this.#closed) return
    const at = new Date(this.#deps.now()).toISOString()
    const frame = heartbeatFrame({ cursor: this.#cursor, at })
    for (const subscriber of [...this.#subscribers]) {
      this.#guard(subscriber, () => {
        subscriber.onHeartbeat(frame)
      })
    }
  }

  #deliver(subscriber: StreamSubscriber, change: StateChange): void {
    this.#guard(subscriber, () => {
      subscriber.onFrame(changeFrame(change))
    })
  }

  /**
   * One client's failure must not become the hub's.
   *
   * A dashboard that navigated away mid-write would otherwise throw out of
   * `publish`, and `publish` is called from inside `store.insertEvent` - so a
   * broken socket would turn into a failed store write, and then into a reported
   * dropped event for an event that was in fact stored (APX-FR-02). The client
   * is unsubscribed and told why; everything else carries on.
   */
  #guard(subscriber: StreamSubscriber, run: () => void): void {
    try {
      run()
    } catch {
      this.#subscribers.delete(subscriber)
      this.#notify(subscriber, 'client-overrun')
    }
  }

  #notify(subscriber: StreamSubscriber, reason: StreamCloseReason): void {
    try {
      subscriber.onClose(reason)
    } catch {
      // The client is already gone. There is nothing left to tell it, and a
      // shutdown must not fail because a socket was closed twice.
    }
  }
}

/** Build a feed. */
export function createChangeFeed(
  settings?: Partial<StreamSettings>,
  deps?: ChangeFeedDeps,
): ChangeFeed {
  return new ChangeBus(resolveStreamSettings(settings), deps)
}

// ---------------------------------------------------------------------------
// The one place that knows the store
// ---------------------------------------------------------------------------

/**
 * Wrap a store so every transition it actually applied is published.
 *
 * The stream's source of truth is the store's own outcomes rather than a
 * parallel notion of "something changed", which is what keeps two things true:
 *
 *   - A no-op publishes nothing. A duplicate insert (HC-FR-08), an
 *     acknowledgement of something already acknowledged, a conflict on a
 *     resolved row and an unknown identifier are all `unchanged`, `conflict` or
 *     `not-found` - no state moved, so there is no change to report. A stream
 *     that emitted a frame for them would make a dashboard re-read for nothing
 *     and would put a no-op into the replay window, which is the opposite of
 *     what a cursor is for.
 *   - Ingest and the ack route do not know the stream exists. They call the
 *     store's accessors; the frames follow. That is why HC-3 and HC-4 get live
 *     updates for free instead of having to remember to publish.
 *
 * The two derived reads per frame are the price. A change frame that carries only
 * an event identifier would make every dashboard re-read the sessions and
 * pending sets to learn anything, which is a poll wearing a stream's clothes. The
 * pending count is read from `readPending()` rather than kept here, because that
 * number is the tray badge's single source of truth and a second copy of it is a
 * second thing to drift (NT-FR-05).
 *
 * The cost is two prepared queries per transition, and one of them -
 * `readSessionSummaries`, to find the one row this event belongs to - reads the
 * whole sessions table. That is one row per agent session, so tens in any real
 * run, and it is why a hub serving a burst of transitions still measures
 * single-digit milliseconds per frame. If a machine ever held thousands of
 * sessions, the fix is a `readSessionSummary(sessionId)` accessor on the store's
 * closed API rather than a second guess at the session row kept here - which is
 * domain-engineer's to add, not this file's to invent.
 */
export function withChangeFeed(store: EventStore, feed: ChangeFeed): EventStore {
  const report = (kind: ChangeKind, event: EventRecord): void => {
    const session =
      store
        .readSessionSummaries()
        .find((candidate) => candidate.sessionId === event.sessionId) ?? null
    feed.publish({ kind, event, session, pendingCount: store.readPending().length })
  }
  return {
    filePath: store.filePath,
    schemaVersion: store.schemaVersion,
    rebuiltFromMigrations: store.rebuiltFromMigrations,
    insertEvent: (event: NewEvent): InsertResult => {
      const result = store.insertEvent(event)
      if (result.outcome === 'inserted') report('event-stored', result.event)
      return result
    },
    markResolved: (eventId: string): MutationResult => {
      const result = store.markResolved(eventId)
      if (result.outcome === 'applied' && result.event !== null) report('block-resolved', result.event)
      return result
    },
    markAcknowledged: (eventId: string): MutationResult => {
      const result = store.markAcknowledged(eventId)
      if (result.outcome === 'applied' && result.event !== null) report('acknowledged', result.event)
      return result
    },
    readPending: (): ReturnType<EventStore['readPending']> => store.readPending(),
    readSessionSummaries: (): ReturnType<EventStore['readSessionSummaries']> =>
      store.readSessionSummaries(),
    readSession: (sessionId: string): ReturnType<EventStore['readSession']> =>
      store.readSession(sessionId),
    readEventHistory: (query?: Parameters<EventStore['readEventHistory']>[0]) =>
      store.readEventHistory(query),
    close: (): void => store.close(),
  }
}
