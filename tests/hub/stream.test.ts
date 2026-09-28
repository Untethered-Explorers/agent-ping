// The live state stream, over a real loopback socket against a hub started by the
// real main entry point (HC-2, HC-FR-03).
//
//   npm test -- tests/hub/stream.test.ts
//
// Two kinds of assertion live here, and the split is deliberate.
//
// The integration half drives a real hub over a real socket with a real streaming
// client - a `node:http` request that stays open and parses the wire format from
// the specification, and, for the two frames that matter most, a `fetch` client
// reading a `ReadableStream`. Two client implementations exist so that neither can
// be wrong in the same way as the server: a parser written by the same author as
// the writer proves the two agree, and only a second implementation proves they
// both agree with the protocol.
//
// The unit half drives the parts that are decisions rather than transport: the
// replay plan around every edge of the window, the cursor parser, the exact bytes
// of a frame, the sink that refuses, and the feed's own bounds with an injected
// clock. Those are the assertions that make the window bounds a property instead
// of a claim, and they are cheap because they need no port.
//
// What is asserted:
//
//   - A heartbeat frame arrives within the configured interval, and none arrives
//     before it.
//   - Every state transition the store applies becomes exactly one change frame,
//     in cursor order, with a fixed, content-free payload.
//   - A no-op - a duplicate insert, a second acknowledgement, a conflict, an
//     unknown identifier - produces no frame at all.
//   - A reconnect carrying the last cursor replays exactly the changes it missed,
//     through both the query parameter and the `Last-Event-ID` header.
//   - A cursor that is too old, ahead of the feed, or unusable is answered with an
//     explicit full-refresh signal and no change frames.
//   - A live update is visible to a connected client well inside the 250 ms budget,
//     and the retained window is bounded in frames, in age and in bytes.
//   - A client that stops reading is closed rather than buffered, and a hub that
//     will not take another client says so instead of queueing.
//   - The stream changes no stored state, and closing the hub leaves no stream and
//     no heartbeat timer behind.
//
// The hub's store is the one the composition root hands to its handlers, so every
// write in this file is a real write to the real log through the real wrapper, and
// every frame observed is a frame the product itself produced. Nothing here posts
// an event: ingest belongs to HC-3, and the stream does not need it to be proven.

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { startHub, type RunningHub, type StartHubOptions } from '@/main/index'
import { STREAM_ROUTES, readRequestedCursor } from '@/hub/routes/stream'
import {
  changeFrame,
  createChangeFeed,
  cursorRequest,
  encodeStreamFrame,
  encodeStreamPreamble,
  heartbeatFrame,
  parseCursor,
  planReplay,
  readyFrame,
  refreshRequiredFrame,
  resolveStreamSettings,
  withChangeFeed,
  writeFrame,
  StreamFeedClosedError,
  STREAM_CONTENT_TYPE,
  STREAM_HEARTBEAT_INTERVAL_MS,
  STREAM_MAX_CLIENTS,
  STREAM_REPLAY_MAX_FRAMES,
  STREAM_REPLAY_WINDOW_MS,
  type ChangeFeedDeps,
  type ChangeKind,
  type FrameSink,
  type ReplayPlan,
  type StateChange,
  type StateChangeReport,
  type StreamFrame,
  type StreamSettings,
  type TimerHandle,
} from '@/hub/sse'
import { openEventStore, type EventStore, type NewEvent } from '@/storage/eventStore'
import { removeTree } from '../helpers/remove-tree'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const temporaryDirectories: string[] = []
const openHubs: RunningHub[] = []
const openStores: EventStore[] = []
const openClients: SseClient[] = []

/**
 * A heartbeat short enough to watch.
 *
 * The product's interval is twenty-five seconds (Open Questions 3), and a test
 * that waited for that would take a quarter of a minute to assert one fact. The
 * default is asserted separately, as a constant, and the timing assertions are
 * run against an interval this short so they are about the interval being obeyed
 * rather than about a number being waited for.
 */
const TEST_HEARTBEAT_MS = 150

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent-ping-stream-'))
  temporaryDirectories.push(directory)
  return directory
}

async function startStreamHub(
  options: Partial<StartHubOptions> & { readonly stream?: Partial<StreamSettings> } = {},
): Promise<RunningHub> {
  const hub = await startHub({
    stateDir: temporaryDirectory(),
    dashboardRoot: null,
    ...options,
  })
  openHubs.push(hub)
  return hub
}

/** A second connection to the log, which is how this file observes stored state. */
function observeLog(hub: RunningHub): EventStore {
  const store = openEventStore({ filePath: hub.databaseFilePath })
  openStores.push(store)
  return store
}

function storedCounts(hub: RunningHub): { pending: number; events: number; sessions: number } {
  const store = observeLog(hub)
  return {
    pending: store.readPending().length,
    events: store.readEventHistory({ limit: 500 }).length,
    sessions: store.readSessionSummaries().length,
  }
}

let eventSequence = 0

function newEvent(overrides: Partial<NewEvent> = {}): NewEvent {
  eventSequence += 1
  const index = eventSequence
  return {
    harness: 'opencode',
    sessionId: 'ses_alpha',
    repoShortName: 'agent-ping',
    repoFullPath: '/home/dev/Projects/agent-ping',
    rawEventType: 'session.idle',
    class: 'finished',
    occurredAt: new Date(Date.UTC(2026, 8, 26, 10, 0, index)).toISOString(),
    receivedAt: new Date(Date.UTC(2026, 8, 26, 10, 0, index)).toISOString(),
    dedupeKey: `opencode:ses_alpha:idle-${index}`,
    ...overrides,
  }
}

/** One block: the only class that opens a pending item. */
function newBlock(overrides: Partial<NewEvent> = {}): NewEvent {
  eventSequence += 1
  const index = eventSequence
  return {
    ...newEvent({
      rawEventType: 'permission.asked',
      class: 'needs-you',
      occurredAt: new Date(Date.UTC(2026, 8, 26, 9, 0, index)).toISOString(),
      receivedAt: new Date(Date.UTC(2026, 8, 26, 9, 0, index)).toISOString(),
      dedupeKey: `opencode:ses_alpha:block-${index}`,
    }),
    ...overrides,
  }
}

function one<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`)
  return value
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait for something the hub learns asynchronously.
 *
 * A client that destroys its socket is noticed by the hub on a later tick than
 * the one the test called `close` on, so "the subscriber is gone" is a fact to
 * wait for rather than one to assert immediately.
 */
async function eventually(predicate: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs}ms`)
    await delay(10)
  }
}

afterEach(async () => {
  for (const client of openClients.splice(0)) client.close()
  for (const hub of openHubs.splice(0)) {
    await hub.close().catch(() => undefined)
  }
  for (const store of openStores.splice(0)) store.close()
  for (const directory of temporaryDirectories.splice(0)) {
    removeTree(directory)
  }
})

// ---------------------------------------------------------------------------
// A streaming client, written from the wire format rather than from the server
// ---------------------------------------------------------------------------

interface ReceivedFrame {
  readonly event: string
  readonly id: string | null
  /** The joined `data:` payload, as the specification says to join it. */
  readonly data: string
  /** The frame's field lines, before the blank line that dispatched it. */
  readonly raw: string
  readonly receivedAt: number
}

/**
 * An SSE parser written from the specification.
 *
 * Field lines, an optional single leading space after the colon, comments on a
 * leading colon, `data` joined with newlines, a dispatch on a blank line, and no
 * dispatch at all for a block with no data. `id` and `retry` are read as the
 * specification defines them because this is the parser a browser's EventSource
 * is: a client that only understood what this product emits would prove nothing.
 */
class SseParser {
  #buffer = ''
  #data: string[] = []
  #raw: string[] = []
  #event = ''
  /** The persistent last-event-id buffer, which survives a block carrying no id. */
  #lastId: string | null = null
  #blockId: string | null = null
  #blockHasId = false
  #retry: number | null = null

  constructor(private readonly onFrame: (frame: ReceivedFrame) => void) {}

  /** Read a chunk, keeping whatever a frame boundary split. */
  push(chunk: string): void {
    this.#buffer += chunk
    // Any of the three line terminators ends a line, and a terminator split across
    // two chunks is held until the next one completes it.
    const lines = this.#buffer.split(/\r\n|\n|\r/)
    this.#buffer = lines.pop() ?? ''
    for (const line of lines) this.#line(line)
  }

  /**
   * The last id seen, which is what a browser sends as `Last-Event-ID` when it
   * reconnects by itself. Asserted in the ordering test, because it is the whole
   * reason a change frame carries an id.
   */
  get lastEventId(): string | null {
    return this.#lastId
  }

  get reconnectionTime(): number | null {
    return this.#retry
  }

  #line(line: string): void {
    if (line === '') {
      this.#dispatch()
      return
    }
    // A comment. The stream preamble is one, and a comment is the specification's
    // own way to write to a connection without dispatching a frame.
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    this.#raw.push(line)
    switch (field) {
      case 'event':
        this.#event = value
        return
      case 'data':
        this.#data.push(value)
        return
      case 'id':
        // An id containing a NUL is ignored, per the specification.
        if (!value.includes('\u0000')) {
          this.#lastId = value
          this.#blockId = value
          this.#blockHasId = true
        }
        return
      case 'retry':
        if (/^\d+$/.test(value)) this.#retry = Number(value)
        return
      default:
        // An unknown field is ignored rather than an error: a future frame kind
        // must not break an older client.
        return
    }
  }

  #dispatch(): void {
    // A block with no data dispatches nothing and clears the event name, which is
    // the rule that makes a lone `retry:` field safe.
    if (this.#data.length === 0) {
      this.#event = ''
      this.#blockId = null
      this.#blockHasId = false
      this.#raw = []
      return
    }
    this.onFrame({
      event: this.#event === '' ? 'message' : this.#event,
      id: this.#blockHasId ? this.#blockId : this.#lastId,
      data: this.#data.join('\n'),
      raw: this.#raw.join('\n'),
      receivedAt: performance.now(),
    })
    this.#data = []
    this.#event = ''
    this.#blockId = null
    this.#blockHasId = false
    this.#raw = []
  }
}

/**
 * Frames as they arrive, with waiting by name.
 *
 * A waiter asks for the next frame of a name it has not been given yet, so a test
 * that wants "the third change" and a test that wants "the first heartbeat" read
 * the same way, and a frame that arrives while nobody is waiting is still
 * delivered to the next waiter rather than lost.
 */
class FrameInbox {
  readonly frames: ReceivedFrame[] = []
  #arrived = new Map<string, number>()
  #taken = new Map<string, number>()
  #waiters: {
    name: string
    ordinal: number
    resolve: (frame: ReceivedFrame) => void
    reject: (cause: Error) => void
    timer: NodeJS.Timeout
  }[] = []

  add(frame: ReceivedFrame): void {
    this.frames.push(frame)
    const ordinal = this.#arrived.get(frame.event) ?? 0
    this.#arrived.set(frame.event, ordinal + 1)
    for (const waiter of [...this.#waiters]) {
      if (waiter.name === frame.event && waiter.ordinal === ordinal) {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1)
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
      }
    }
  }

  of(name: string): ReceivedFrame[] {
    return this.frames.filter((frame) => frame.event === name)
  }

  /** The next frame of `name`, or a rejection if none arrives in time. */
  take(name: string, timeoutMs = 4_000): Promise<ReceivedFrame> {
    // The counter advances on both paths - a frame handed out from the buffer and
    // a frame handed out by a waiter - because a waiter only ever exists when
    // nothing of that name has been handed out yet.
    const taken = this.#taken.get(name) ?? 0
    this.#taken.set(name, taken + 1)
    const already = this.of(name)[taken]
    if (already !== undefined) return Promise.resolve(already)
    const ordinal = taken
    return new Promise<ReceivedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.splice(
          this.#waiters.findIndex((waiter) => waiter.timer === timer),
          1,
        )
        reject(
          new Error(
            `no ${name} frame arrived within ${timeoutMs}ms; saw ${this.frames.map((frame) => frame.event).join(', ')}`,
          ),
        )
      }, timeoutMs)
      this.#waiters.push({ name, ordinal, resolve, reject, timer })
    })
  }

  /** How many frames of `name` have arrived. */
  count(name: string): number {
    return this.of(name).length
  }

  /**
   * Resolves true when no *further* frame of `name` arrives in `ms`.
   *
   * Counted against what has already arrived rather than against zero, because
   * "no more frames" is the question a test asks after taking the ones it wanted,
   * not "no frames ever".
   */
  async quiet(name: string, ms: number): Promise<boolean> {
    const before = this.count(name)
    await delay(ms)
    return this.count(name) === before
  }

  /** Nothing may still be waiting when a test ends, or a rejection is unhandled. */
  abandon(): void {
    for (const waiter of this.#waiters.splice(0)) clearTimeout(waiter.timer)
  }
}

/** One open stream, over a real socket. */
class SseClient {
  readonly inbox = new FrameInbox()
  readonly parser: SseParser
  readonly headers: Record<string, string | string[] | undefined> = {}
  status = 0
  #request: ReturnType<typeof httpRequest>
  #ended = false
  #resolveEnded: () => void = () => undefined
  #resolveReady: (status: number) => void = () => undefined
  /** Resolves when the response head arrives, which is before any frame. */
  readonly ready: Promise<number>
  /** Resolves when the connection ends, for whatever reason. */
  readonly ended: Promise<void>

  private constructor(
    origin: string,
    pathname: string,
    init: { readonly cursor?: string; readonly lastEventId?: string } = {},
  ) {
    const { hostname, port } = new URL(origin)
    this.parser = new SseParser((frame) => {
      this.inbox.add(frame)
    })
    this.ready = new Promise<number>((resolve) => {
      this.#resolveReady = resolve
    })
    this.ended = new Promise<void>((resolve) => {
      this.#resolveEnded = resolve
    })
    const headers: Record<string, string> = { accept: 'text/event-stream' }
    if (init.lastEventId !== undefined) headers['last-event-id'] = init.lastEventId
    this.#request = httpRequest(
      {
        host: hostname,
        port,
        path: init.cursor === undefined ? pathname : `${pathname}?cursor=${init.cursor}`,
        method: 'GET',
        headers,
        // No pooling: a stream holds its connection open, and a pooled socket
        // from a stream that has ended would be handed to the next one.
        agent: false,
      },
      (response: IncomingMessage) => {
        this.status = response.statusCode ?? 0
        this.#resolveReady(this.status)
        for (const [name, value] of Object.entries(response.headers)) this.headers[name] = value
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          this.parser.push(chunk)
        })
        const finish = (): void => {
          if (this.#ended) return
          this.#ended = true
          this.#resolveEnded()
        }
        response.on('end', finish)
        response.on('close', finish)
        response.on('aborted', finish)
        response.on('error', finish)
      },
    )
    this.#request.on('error', () => {
      this.#resolveReady(this.status)
      this.#ended = true
      this.#resolveEnded()
    })
    this.#request.end()
  }

  static async open(
    origin: string,
    pathname = '/api/stream',
    init: { readonly cursor?: string; readonly lastEventId?: string } = {},
  ): Promise<SseClient> {
    const client = new SseClient(origin, pathname, init)
    openClients.push(client)
    // Until the response head arrives there is no status to assert, and a refused
    // request - a 405, a 503 - answers and ends rather than hanging, so both cases
    // are settled by the same race. Waiting on a frame instead would add the
    // stream's own latency to every client's setup.
    await Promise.race([client.ready, client.ended, delay(3_000)])
    return client
  }

  next<T = Record<string, unknown>>(name: string, timeoutMs?: number): Promise<T> {
    return this.inbox.take(name, timeoutMs).then((frame) => JSON.parse(frame.data) as T)
  }

  nextFrame(name: string, timeoutMs?: number): Promise<ReceivedFrame> {
    return this.inbox.take(name, timeoutMs)
  }

  close(): void {
    this.inbox.abandon()
    this.#request.destroy()
  }
}

/**
 * The same stream, read by a `fetch` client.
 *
 * A second implementation on purpose. `node:http` and `fetch` disagree about
 * chunking and about when headers arrive, and both of them are what a browser
 * will do; if only the first can see the frames then the product depends on a
 * detail of one client library.
 *
 * The stream is ended by closing the hub, not by aborting the request. That is a
 * stronger assertion - it proves a fetch-based client sees the stream finish when
 * the hub shuts down - and it avoids an artifact worth knowing about: aborting a
 * fetch in-process leaves undici with cleanup work that delays the *next* server's
 * `close()` callback by about three seconds, on any server, for reasons that have
 * nothing to do with this product. Measured, not guessed: it reproduces with a
 * plain `GET /api/health` and no stream at all.
 */
async function withFetchStream<T>(
  origin: string,
  run: (inbox: FrameInbox, control: { readonly ended: Promise<void> }) => Promise<T>,
  pathname = '/api/stream',
): Promise<T> {
  const inbox = new FrameInbox()
  const parser = new SseParser((frame) => {
    inbox.add(frame)
  })
  const response = await fetch(`${origin}${pathname}`, { headers: { accept: 'text/event-stream' } })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe(STREAM_CONTENT_TYPE)
  const body = response.body
  if (body === null) throw new Error('the stream response had no body')

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let resolveEnded = (): void => undefined
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve
  })
  // Pumped in the background so the body is read while the assertions run. A read
  // error settles `ended` rather than becoming an unhandled rejection, because the
  // one way this stream can fail here is the hub going away, which is the point.
  void (async (): Promise<void> => {
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return
        parser.push(decoder.decode(chunk.value, { stream: true }))
      }
    } catch {
      // A connection that failed is a stream that ended.
    } finally {
      resolveEnded()
    }
  })()

  try {
    return await run(inbox, { ended })
  } finally {
    inbox.abandon()
  }
}

// ---------------------------------------------------------------------------
// The stream, over a real socket
// ---------------------------------------------------------------------------

describe('the stream route (HC-FR-03)', () => {
  it('is a read-only GET on the same origin, carrying no cross-origin header', async () => {
    const hub = await startStreamHub()
    // A change first, so the cursor in the ready frame is not trivially zero.
    hub.store.insertEvent(newEvent())

    const client = await SseClient.open(hub.origin)

    expect(client.status).toBe(200)
    expect(client.headers['content-type']).toBe(STREAM_CONTENT_TYPE)
    // A stream is state: caching it would replay a stale cursor to a later client.
    expect(client.headers['cache-control']).toBe('no-store')
    expect(client.headers['x-content-type-options']).toBe('nosniff')
    // The read surface sends no cross-origin header at all, and a long-lived
    // response is where one would be most tempting: a permissive header here
    // would let any page the developer visits read their session changes
    // (HC-FR-06, ADR-002).
    for (const header of [
      'access-control-allow-origin',
      'access-control-allow-credentials',
      'access-control-allow-headers',
      'access-control-expose-headers',
    ]) {
      expect(client.headers[header], header).toBeUndefined()
    }
    // Registered as what it is, in the registry the composition root holds, and
    // from the same list every other route comes from - so the enumeration test
    // sees it and a second stream route would be a second entry here.
    expect(STREAM_ROUTES.map((route) => `${route.method} ${route.pattern}`)).toEqual([
      'GET /api/stream',
    ])
    expect(STREAM_ROUTES.every((route) => route.mutation === 'read-only')).toBe(true)
    const route = one(
      hub.registry.routes().find((candidate) => candidate.name === 'stream.state'),
      'the stream route to be registered',
    )
    expect(`${route.method} ${route.pattern}`).toBe('GET /api/stream')
    expect(route.mutation).toBe('read-only')
    expect(hub.registry.signatures()).toContain('GET /api/stream')
    // The stream is served from the same origin as the read routes, and reaches
    // the same store: the services a handler is given is the only way in.
    expect(hub.registry.routes().filter((candidate) => candidate.pattern === '/api/stream')).toHaveLength(1)
  })

  it('opens with a preamble a browser can act on, and refuses every other method', async () => {
    const hub = await startStreamHub()

    const client = await SseClient.open(hub.origin)
    const ready = await client.nextFrame('ready')
    // The first bytes are a comment and the retry hint, so the response head goes
    // out immediately rather than waiting for a change that may never come.
    expect(ready.raw.split('\n')[0]).toBe('id: 0')
    expect(ready.raw.split('\n')[1]).toBe('event: ready')
    expect(client.parser.reconnectionTime).toBe(2_000)

    // Every method that is not a read is refused before a byte of stream is
    // written, and the refusal names the method the path does serve.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const response = await rawRequest(hub.origin, '/api/stream', method)
      expect([404, 405], `${method} answered ${response.status}`).toContain(response.status)
      if (response.status === 405) expect(response.headers['allow']).toBe('GET')
    }
    // The refusals changed nothing: the stream that is already open is still
    // receiving, and still at cursor zero.
    expect(client.inbox.count('change')).toBe(0)
    expect(hub.stream.subscriberCount()).toBe(1)
  })

  it('sends a heartbeat frame within the configured interval, and none before it', async () => {
    const hub = await startStreamHub({ stream: { heartbeatIntervalMs: TEST_HEARTBEAT_MS } })
    const client = await SseClient.open(hub.origin)
    await client.nextFrame('ready')

    // Nothing at all before the interval. This is the half that matters: a
    // heartbeat on a tight loop would satisfy "a heartbeat arrives" while costing a
    // write per client per tick forever. Counted from zero rather than as a delta,
    // because a keepalive sent *before* the ready frame is exactly the regression
    // here and a delta would not see it.
    await delay(Math.floor(TEST_HEARTBEAT_MS / 3))
    expect(client.inbox.count('heartbeat')).toBe(0)

    const started = performance.now()
    const beat = await client.nextFrame('heartbeat', 2_000)
    const elapsed = performance.now() - started

    // Within the configured interval, with room for a loaded machine to be slow
    // and no more: an interval of 150ms and an answer at 2s would be a timer that
    // fires when it feels like it.
    expect(elapsed).toBeLessThan(TEST_HEARTBEAT_MS * 4)
    expect(elapsed).toBeGreaterThan(0)
    // A heartbeat carries the cursor the client is at, and no id field: a keepalive
    // must not move the mark a browser reconnects from. A block with no id inherits
    // the previous one, which is why the parser still reports zero here - the
    // frame itself says nothing.
    expect(JSON.parse(beat.data)).toEqual({ cursor: 0, at: expect.any(String) })
    expect(beat.raw.split('\n').some((line) => line.startsWith('id: '))).toBe(false)
    expect(client.parser.lastEventId).toBe('0')
    // And it keeps coming, so an idle connection stays alive rather than being
    // dropped after the first one.
    const second = await client.nextFrame('heartbeat', 2_000)
    expect(second.data).not.toBe(beat.data)
    // The documented defaults are the product's, not the test's.
    expect(STREAM_HEARTBEAT_INTERVAL_MS).toBe(25_000)
    expect(STREAM_REPLAY_WINDOW_MS).toBe(300_000)
    expect(STREAM_REPLAY_MAX_FRAMES).toBe(512)
    expect(resolveStreamSettings().heartbeatIntervalMs).toBe(STREAM_HEARTBEAT_INTERVAL_MS)
    expect(resolveStreamSettings().replayWindowMs).toBe(STREAM_REPLAY_WINDOW_MS)
    expect(resolveStreamSettings().replayMaxFrames).toBe(STREAM_REPLAY_MAX_FRAMES)
    expect(resolveStreamSettings().maxClients).toBe(STREAM_MAX_CLIENTS)
    console.info(
      `[stream] heartbeat every ${STREAM_HEARTBEAT_INTERVAL_MS / 1000}s in production; ` +
        `observed ${elapsed.toFixed(0)}ms at a configured ${TEST_HEARTBEAT_MS}ms`,
    )
  })

  it('delivers one change frame per state transition, in cursor order', async () => {
    const hub = await startStreamHub()
    const client = await SseClient.open(hub.origin)
    const ready = await client.next<{ cursor: number; oldestRetainedCursor: number | null }>('ready')
    expect(ready.cursor).toBe(0)
    expect(ready.oldestRetainedCursor).toBeNull()

    const block = hub.store.insertEvent(newBlock()).event
    const finished = hub.store.insertEvent(newEvent()).event
    const ack = hub.store.markAcknowledged(block.eventId)

    expect(ack.outcome).toBe('applied')

    const first = await client.nextFrame('change')
    const second = await client.nextFrame('change')
    const third = await client.nextFrame('change')

    // In order, and each frame's SSE id is its own cursor, so a browser
    // reconnects from the right place with no code in the dashboard.
    expect([first.id, second.id, third.id]).toEqual(['1', '2', '3'])
    const kinds = [first, second, third].map((frame) => JSON.parse(frame.data).kind)
    expect(kinds).toEqual(['event-stored', 'event-stored', 'acknowledged'])

    const stored = JSON.parse(first.data) as {
      cursor: number
      at: string
      kind: ChangeKind
      pendingCount: number
      event: { eventId: string; class: string; ackState: string }
      session: { sessionId: string; state: string; pendingCount: number }
    }
    // The payload is the store's own content-free read shapes and nothing else.
    // An exact key set, because a field nobody expected is a field nobody has
    // checked for content (APX-FR-01, ADR-003).
    expect(Object.keys(stored).sort()).toEqual([
      'at',
      'cursor',
      'event',
      'kind',
      'pendingCount',
      'session',
    ])
    expect(Object.keys(stored.event).sort()).toEqual([
      'ackState',
      'class',
      'dedupeKey',
      'eventId',
      'occurredAt',
      'rawEventType',
      'receivedAt',
      'resolutionState',
      'sessionId',
      'subtype',
    ])
    expect(stored.event.eventId).toBe(block.eventId)
    expect(stored.event.class).toBe('needs-you')
    expect(stored.pendingCount).toBe(1)
    expect(stored.session.sessionId).toBe('ses_alpha')
    expect(stored.session.state).toBe('blocked')
    expect(stored.session.pendingCount).toBe(1)
    expect(Number.isNaN(Date.parse(stored.at))).toBe(false)

    // The second event is the same session moving on, and the third is the block
    // leaving the pending set - the two transitions a dashboard renders.
    const secondData = JSON.parse(second.data) as {
      event: { eventId: string }
      session: { state: string }
    }
    expect(secondData.event.eventId).toBe(finished.eventId)
    expect(secondData.session.state).toBe('finished')
    const thirdData = JSON.parse(third.data) as {
      kind: ChangeKind
      event: { ackState: string; eventId: string }
      pendingCount: number
    }
    expect(thirdData.event.eventId).toBe(block.eventId)
    expect(thirdData.event.ackState).toBe('acknowledged')
    expect(thirdData.pendingCount).toBe(0)
  })

  it('publishes nothing for a transition that did not change state', async () => {
    const hub = await startStreamHub()
    const client = await SseClient.open(hub.origin)
    await client.nextFrame('ready')

    const block = hub.store.insertEvent(newBlock()).event
    await client.nextFrame('change')
    expect(hub.stream.currentCursor()).toBe(1)

    // Every one of these is the store reporting that it changed nothing: a
    // duplicate envelope (HC-FR-08), a second acknowledgement, an unknown
    // identifier, and a row that is not a pending item at all. A frame for any of
    // them would make a dashboard re-read for nothing and would put a no-op into
    // the replay window a cursor is meant to index.
    expect(hub.store.insertEvent(newBlock({ dedupeKey: block.dedupeKey })).outcome).toBe('duplicate')
    expect(hub.store.markAcknowledged(block.eventId).outcome).toBe('applied')
    expect(hub.store.markAcknowledged(block.eventId).outcome).toBe('unchanged')
    expect(hub.store.markResolved('evt_does_not_exist').outcome).toBe('not-found')
    const fyi = hub.store.insertEvent(newEvent({ class: 'fyi', subtype: 'retry' })).event
    expect(hub.store.markAcknowledged(fyi.eventId).outcome).toBe('conflict')
    expect(hub.store.markResolved(fyi.eventId).outcome).toBe('conflict')

    // Two applied transitions, so two frames - the duplicate and the rest published
    // nothing.
    await client.nextFrame('change')
    await client.nextFrame('change')
    expect(hub.stream.currentCursor()).toBe(3)
    expect(await client.inbox.quiet('change', 120)).toBe(true)
  })

  it('replays exactly the missed changes to a reconnecting client, by cursor and by header', async () => {
    // Both forms are the contract, not one of them being a convenience: the query
    // parameter is what a reloaded page has left, and `Last-Event-ID` is what a
    // browser's EventSource sends when it reconnects by itself.
    const reconnects: {
      readonly label: string
      readonly open: (cursor: number) => {
        readonly cursor?: string
        readonly lastEventId?: string
      }
    }[] = [
      { label: 'a cursor parameter', open: (cursor) => ({ cursor: String(cursor) }) },
      { label: 'a Last-Event-ID header', open: (cursor) => ({ lastEventId: String(cursor) }) },
    ]
    for (const reconnect of reconnects) {
      const hub = await startStreamHub()
      const first = await SseClient.open(hub.origin)
      await first.nextFrame('ready')
      hub.store.insertEvent(newBlock())
      hub.store.insertEvent(newEvent())
      await first.nextFrame('change')
      await first.nextFrame('change')
      expect(first.inbox.of('change').map((frame) => frame.id)).toEqual(['1', '2'])
      // The client goes away, and the hub notices and lets go of it.
      first.close()
      await eventually(
        () => hub.stream.subscriberCount() === 0,
        'the hub to release the disconnected client',
      )

      // Two changes happen while nobody is watching: one needs a developer, one
      // resolves it.
      const missedBlock = hub.store.insertEvent(newBlock()).event
      const missedFinished = hub.store.insertEvent(newEvent()).event
      hub.store.markAcknowledged(missedBlock.eventId)
      expect(hub.stream.currentCursor()).toBe(5)

      const second = await SseClient.open(hub.origin, '/api/stream', reconnect.open(2))
      // The ready frame reports the cursor the client is now looking at - the
      // current one - and the window it could have replayed from.
      const ready = await second.next<{ cursor: number; oldestRetainedCursor: number | null }>('ready')
      expect(ready.cursor, reconnect.label).toBe(5)
      expect(ready.oldestRetainedCursor, reconnect.label).toBe(1)

      const replayed: string[] = []
      const events: string[] = []
      for (let index = 0; index < 3; index += 1) {
        const frame = await second.nextFrame('change')
        replayed.push(one(frame.id, 'a replayed frame id'))
        events.push((JSON.parse(frame.data) as { event: { eventId: string } }).event.eventId)
      }
      // Exactly the three it missed, in order, and not one of the two it already
      // had.
      expect(replayed, reconnect.label).toEqual(['3', '4', '5'])
      expect(events, reconnect.label).toEqual([
        missedBlock.eventId,
        missedFinished.eventId,
        missedBlock.eventId,
      ])

      // And the stream continues from there rather than restarting.
      hub.store.insertEvent(newEvent())
      const live = await second.nextFrame('change')
      expect(live.id).toBe('6')
      expect(await second.inbox.quiet('refresh-required', 80)).toBe(true)
      await hub.close()
    }
  })

  it('answers a cursor older than the replay window with an explicit full-refresh signal', async () => {
    // Count bound: the window is two frames, so a client three changes behind has
    // a real gap. The answer is the signal, and the signal is alone - a partial
    // replay is exactly the stale state the client would then display as current.
    const bounded = await startStreamHub({ stream: { replayMaxFrames: 2 } })
    for (let index = 0; index < 5; index += 1) bounded.store.insertEvent(newEvent())
    expect(bounded.stream.currentCursor()).toBe(5)
    expect(bounded.stream.oldestRetainedCursor()).toBe(4)

    // Every cursor with a real gap behind it is refused the same way. Five
    // changes were published and the window holds four and five, so a client at
    // three is exactly in step with it and a client at two has lost one.
    for (const cursor of ['0', '1', '2']) {
      const client = await SseClient.open(bounded.origin, '/api/stream', { cursor })
      const ready = await client.next<{ cursor: number; oldestRetainedCursor: number | null }>('ready')
      expect(ready.cursor, cursor).toBe(5)
      const refusal = await client.next<{
        reason: string
        requestedCursor: number
        oldestRetainedCursor: number
        currentCursor: number
      }>('refresh-required')
      expect(refusal.reason, cursor).toBe('cursor-too-old')
      expect(refusal.requestedCursor, cursor).toBe(Number(cursor))
      expect(refusal.oldestRetainedCursor, cursor).toBe(4)
      expect(refusal.currentCursor, cursor).toBe(5)
      // Numbers and a reason: enough for a client to log the fact and for a
      // developer to see afterwards whether the gap was time or volume, and
      // nothing that could be content (APX-FR-01).
      expect(Object.keys(refusal).sort(), cursor).toEqual([
        'at',
        'currentCursor',
        'oldestRetainedCursor',
        'reason',
        'requestedCursor',
      ])
      // No partial data follows the signal, which is the whole point of it.
      expect(client.inbox.count('change'), cursor).toBe(0)
      client.close()
    }

    // The other side of the edge, on the same hub in the same test: a client at
    // three needs exactly the two frames the window holds, and gets those two -
    // not the two before them, which are its own.
    const atTheEdge = await SseClient.open(bounded.origin, '/api/stream', { cursor: '3' })
    await atTheEdge.nextFrame('ready')
    expect((await atTheEdge.nextFrame('change')).id).toBe('4')
    expect((await atTheEdge.nextFrame('change')).id).toBe('5')
    expect(await atTheEdge.inbox.quiet('refresh-required', 80)).toBe(true)
    atTheEdge.close()

    // A refused client is still connected and still receives live changes, so
    // "re-read the hub" is an instruction it can follow rather than a dead end.
    const stale = await SseClient.open(bounded.origin, '/api/stream', { cursor: '2' })
    await stale.nextFrame('ready')
    expect((await stale.next<{ reason: string }>('refresh-required')).reason).toBe('cursor-too-old')
    bounded.store.insertEvent(newEvent())
    const live = await stale.nextFrame('change')
    expect(live.id).toBe('6')
    expect(await stale.inbox.quiet('change', 80)).toBe(true)

    // And a cursor the window can honour still replays, on the same hub in the
    // same test - so the refusal is about the gap and not about the route.
    const exact = await SseClient.open(bounded.origin, '/api/stream', { cursor: '6' })
    await exact.nextFrame('ready')
    expect(await exact.inbox.quiet('refresh-required', 80)).toBe(true)
    await bounded.close()

    // Time bound: the same refusal, arrived at by age rather than by volume. The
    // window is forty milliseconds, so a change published before the client
    // connects is not replayable even though it is the only one there is.
    const aged = await startStreamHub({ stream: { replayWindowMs: 40 } })
    aged.store.insertEvent(newEvent())
    expect(aged.stream.retainedFrames().length).toBe(1)
    await delay(90)
    expect(aged.stream.retainedFrames().length).toBe(0)
    const late = await SseClient.open(aged.origin, '/api/stream', { cursor: '0' })
    await late.nextFrame('ready')
    const refusal = await late.next<{ reason: string; oldestRetainedCursor: number | null }>(
      'refresh-required',
    )
    expect(refusal.reason).toBe('cursor-too-old')
    expect(refusal.oldestRetainedCursor).toBeNull()
    expect(late.inbox.count('change')).toBe(0)
  })

  it('refuses a cursor from a previous run, and an unusable one, without breaking the stream', async () => {
    const hub = await startStreamHub()
    hub.store.insertEvent(newEvent())

    // Ahead of the feed: a client that reconnected to a restarted hub, holding a
    // cursor from the run before. Its state may be arbitrarily stale and there is
    // no way to know how stale, so it is told to re-read.
    const ahead = await SseClient.open(hub.origin, '/api/stream', { cursor: '99' })
    await ahead.nextFrame('ready')
    expect((await ahead.next<{ reason: string }>('refresh-required')).reason).toBe('cursor-unknown')
    expect(ahead.inbox.count('change')).toBe(0)
    ahead.close()

    // Unusable: not a cursor at all. Not a 400, because a browser reconnects this
    // endpoint automatically and an error answer would fail forever.
    for (const bad of ['abc', '-1', '1.5', '1e3', '0x10', 'NaN', 'Infinity', '9007199254740993']) {
      const client = await SseClient.open(hub.origin, '/api/stream', { cursor: bad })
      expect(client.status, bad).toBe(200)
      await client.nextFrame('ready')
      expect((await client.next<{ reason: string }>('refresh-required')).reason, bad).toBe(
        'cursor-unusable',
      )
      expect(client.inbox.count('change'), bad).toBe(0)
      client.close()
    }

    // The same stream still delivers live changes after a refusal, so a client
    // that was told to refresh has somewhere to refresh from.
    const live = await SseClient.open(hub.origin)
    await live.nextFrame('ready')
    hub.store.insertEvent(newEvent())
    expect((await live.nextFrame('change')).id).toBe('2')
  })

  it('gives a first connection no replay and no resync signal', async () => {
    const hub = await startStreamHub()
    hub.store.insertEvent(newEvent())

    const client = await SseClient.open(hub.origin)

    const ready = await client.next<Record<string, unknown>>('ready')
    expect(ready['cursor']).toBe(1)
    // A client with no cursor is new: it has no state to catch up on, and it is
    // expected to have read the read routes. Sending it a refresh signal it has no
    // use for would be noise, and ignoring what it already missed silently would be
    // a lie - which is why the ready frame names the cursor the client is looking
    // at, and the window's own bounds, and nothing else.
    expect(Object.keys(ready).sort()).toEqual([
      'at',
      'cursor',
      'heartbeatIntervalMs',
      'oldestRetainedCursor',
      'replayMaxFrames',
      'replayWindowMs',
    ])
    expect(ready['oldestRetainedCursor']).toBe(1)
    expect(client.inbox.count('change')).toBe(0)
    expect(await client.inbox.quiet('refresh-required', 120)).toBe(true)
  })

  it('makes a live update visible well inside the 250 ms budget', async () => {
    const hub = await startStreamHub()
    const client = await SseClient.open(hub.origin)
    await client.nextFrame('ready')

    // Measured from the write the hub accepted to the frame arriving on a real
    // socket, which is the whole of the budget's path: the store is synchronous,
    // the feed publishes in the same tick, and the write is a socket write. The
    // ingest path (HC-3) adds its own budget on top of this one, and the 50 ms
    // p95 belongs to it rather than to the stream.
    const samples: number[] = []
    for (let index = 0; index < 5; index += 1) {
      const acceptedAt = performance.now()
      hub.store.insertEvent(newEvent())
      const frame = await client.nextFrame('change', 1_000)
      samples.push(frame.receivedAt - acceptedAt)
    }

    const worst = Math.max(...samples)
    expect(worst, `worst live-update latency was ${worst.toFixed(1)}ms`).toBeLessThan(250)
    console.info(
      `[stream] live update visible in ${samples.map((value) => value.toFixed(1)).join('/')}ms ` +
        `(worst ${worst.toFixed(1)}ms, budget 250ms)`,
    )
  })

  it('changes no stored state, and bounds what it holds', async () => {
    const hub = await startStreamHub({ stream: { replayMaxFrames: 8 } })
    for (let index = 0; index < 3; index += 1) hub.store.insertEvent(newBlock())

    const client = await SseClient.open(hub.origin)
    await client.nextFrame('ready')
    // A transition while the client is connected, so the stream has real work to do
    // rather than only a preamble and a heartbeat. The counts are read after it, so
    // the comparison is around the stream and not around this test's own write.
    hub.store.insertEvent(newEvent())
    expect((await client.nextFrame('change')).id).toBe('4')
    const before = storedCounts(hub)
    expect(before).toEqual({ pending: 3, events: 4, sessions: 1 })
    client.close()
    await eventually(
      () => hub.stream.subscriberCount() === 0,
      'the hub to release the disconnected client',
    )

    expect(storedCounts(hub)).toEqual(before)
    // The window is bounded in frames, and the bytes it holds are bounded with it:
    // a stream that kept every change since the hub started would be a memory
    // leak wearing a cursor.
    expect(hub.stream.retainedFrames().length).toBe(4)
    for (let index = 0; index < 40; index += 1) hub.store.insertEvent(newEvent())
    const retained = hub.stream.retainedFrames()
    expect(retained.length).toBe(8)
    expect(retained[0]?.cursor).toBe(37)
    const bytes = Buffer.byteLength(JSON.stringify(retained), 'utf8')
    expect(bytes).toBeLessThan(64 * 1024)
    console.info(
      `[stream] retained window: ${retained.length} frames, ${(bytes / 1024).toFixed(1)} KiB ` +
        `at replayMaxFrames 8 (default ${STREAM_REPLAY_MAX_FRAMES})`,
    )
  })

  it('is readable by a fetch client, and ends when the hub does', async () => {
    const hub = await startStreamHub({ stream: { heartbeatIntervalMs: TEST_HEARTBEAT_MS } })

    // A second client implementation reading the same bytes: heartbeat and change
    // through `fetch` and a ReadableStream, not through the http client above.
    await withFetchStream(hub.origin, async (inbox, stream) => {
      await inbox.take('ready')
      const block = hub.store.insertEvent(newBlock()).event
      const change = await inbox.take('change')
      expect(change.id).toBe('1')
      expect((JSON.parse(change.data) as { event: { eventId: string } }).event.eventId).toBe(
        block.eventId,
      )
      const beat = await inbox.take('heartbeat', 2_000)
      // No id field on the frame; the second client inherits the change's id, which
      // is the specification's own rule and exactly what makes an automatic browser
      // reconnect resume from the last change rather than from the keepalive.
      expect(beat.raw.split('\n').some((line) => line.startsWith('id: '))).toBe(false)
      expect(JSON.parse(beat.data).cursor).toBe(1)

      // And the stream finishes for a fetch client when the hub shuts down, rather
      // than hanging on a socket that will never speak again.
      await hub.close()
      await stream.ended
    })
    expect(hub.stream.isClosed()).toBe(true)
  })

  it('ends every open stream when the hub closes, and leaves no timer behind', async () => {
    // Closing the hub ends every open stream and leaves no timer behind.
    const hub = await startStreamHub({ stream: { heartbeatIntervalMs: TEST_HEARTBEAT_MS } })
    const held = await SseClient.open(hub.origin)
    await held.nextFrame('ready')
    expect(hub.stream.subscriberCount()).toBe(1)

    await hub.close()

    // The client is not left waiting on a socket that will never speak again, the
    // feed has released it, and the listener is gone.
    await held.ended
    expect(hub.stream.isClosed()).toBe(true)
    expect(hub.stream.subscriberCount()).toBe(0)
    expect(hub.server.nodeServer.listening).toBe(false)
    // And the log is still openable, which is the sidecar promise a shutdown has to
    // keep alongside a clean stream (APX-CON-03).
    const store = observeLog(hub)
    expect(store.readSessionSummaries()).toEqual([])
  })

  it('says so rather than queueing when it will not take another client', async () => {
    const hub = await startStreamHub({ stream: { maxClients: 1 } })
    const first = await SseClient.open(hub.origin)
    await first.nextFrame('ready')

    const refused = await rawRequest(hub.origin, '/api/stream', 'GET')

    // A JSON error, not a stream that opens and then goes quiet: a client that
    // cannot be served has to be able to tell the difference between "not now" and
    // "now, and here is your cursor".
    expect(refused.status).toBe(503)
    expect(refused.headers['content-type']).toContain('application/json')
    expect(JSON.parse(refused.text)).toMatchObject({ error: 'too-many-stream-clients' })
    expect(refused.text).not.toContain('event: change')
    // The client that was already connected is untouched, and still streaming.
    hub.store.insertEvent(newEvent())
    expect((await first.nextFrame('change')).id).toBe('1')
  })
})

// ---------------------------------------------------------------------------
// One request, no stream, for the method refusals
// ---------------------------------------------------------------------------

/**
 * One request that is answered and ended, for the paths that are not streams.
 *
 * A refused method, or a hub that will not take another client, answers and closes
 * rather than hanging - so a plain request is the right tool for them and the
 * streaming client would be waiting for a frame that is never coming.
 */
function rawRequest(
  origin: string,
  pathname: string,
  method: string,
): Promise<{
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
}> {
  const { hostname, port } = new URL(origin)
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      { host: hostname, port, path: pathname, method, agent: false },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers as Record<string, string | string[] | undefined>,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    call.on('error', reject)
    call.end()
  })
}

// ---------------------------------------------------------------------------
// The decisions, with no socket
// ---------------------------------------------------------------------------

describe('the replay decision (no socket)', () => {
  const window = (cursors: readonly number[]): StateChange[] =>
    cursors.map((cursor) => change(cursor, { cursor, at: atOf(cursor) }))

  it('answers every edge of the window with a named, explicit plan', () => {
    const cases: {
      readonly label: string
      readonly retained: readonly StateChange[]
      readonly currentCursor: number
      readonly requested: Parameters<typeof planReplay>[0]['requested']
      readonly expect: (plan: ReplayPlan) => void
    }[] = [
      {
        label: 'no cursor is a live connection',
        retained: window([3, 4, 5]),
        currentCursor: 5,
        requested: { kind: 'none' },
        expect: (plan) => expect(plan).toEqual({ kind: 'live' }),
      },
      {
        label: 'a cursor at the head replays nothing',
        retained: window([3, 4, 5]),
        currentCursor: 5,
        requested: { kind: 'cursor', cursor: 5 },
        expect: (plan) => expect(plan).toEqual({ kind: 'live' }),
      },
      {
        label: 'one behind replays one',
        retained: window([3, 4, 5]),
        currentCursor: 5,
        requested: { kind: 'cursor', cursor: 4 },
        expect: (plan) =>
          expect(plan.kind === 'replay' ? plan.frames.map((frame) => frame.cursor) : null).toEqual([5]),
      },
      {
        label: 'at the edge of the window replays all of it',
        retained: window([3, 4, 5]),
        currentCursor: 5,
        requested: { kind: 'cursor', cursor: 2 },
        expect: (plan) =>
          expect(plan.kind === 'replay' ? plan.frames.map((frame) => frame.cursor) : null).toEqual([
            3, 4, 5,
          ]),
      },
      {
        label: 'a window that starts before the cursor is still a complete answer',
        // The client is at 2 and the window holds 1..5. Frames 1 and 2 are the
        // client's own and are not resent; a rule that demanded the window to
        // begin one past the cursor would refuse a replay it can give in full.
        retained: window([1, 2, 3, 4, 5]),
        currentCursor: 5,
        requested: { kind: 'cursor', cursor: 2 },
        expect: (plan) =>
          expect(plan.kind === 'replay' ? plan.frames.map((frame) => frame.cursor) : null).toEqual([
            3, 4, 5,
          ]),
      },
      {
        label: 'one before the edge is a gap, not a replay',
        retained: window([3, 4, 5]),
        currentCursor: 5,
        requested: { kind: 'cursor', cursor: 1 },
        expect: (plan) => {
          expect(plan.kind).toBe('refresh-required')
          expect(plan.kind === 'refresh-required' && plan.reason).toBe('cursor-too-old')
          expect(plan.kind === 'refresh-required' && plan.requestedCursor).toBe(1)
          expect(plan.kind === 'refresh-required' && plan.oldestRetainedCursor).toBe(3)
        },
      },
      {
        label: 'an empty window with history behind it is a gap',
        retained: [],
        currentCursor: 9,
        requested: { kind: 'cursor', cursor: 4 },
        expect: (plan) => {
          expect(plan.kind === 'refresh-required' && plan.reason).toBe('cursor-too-old')
          expect(plan.kind === 'refresh-required' && plan.oldestRetainedCursor).toBeNull()
        },
      },
      {
        label: 'an empty window with no history is a live connection',
        retained: [],
        currentCursor: 0,
        requested: { kind: 'cursor', cursor: 0 },
        expect: (plan) => expect(plan).toEqual({ kind: 'live' }),
      },
      {
        label: 'a cursor ahead of the feed is from another run',
        retained: window([3, 4, 5]),
        currentCursor: 5,
        requested: { kind: 'cursor', cursor: 6 },
        expect: (plan) => {
          expect(plan.kind === 'refresh-required' && plan.reason).toBe('cursor-unknown')
          expect(plan.kind === 'refresh-required' && plan.currentCursor).toBe(5)
        },
      },
      {
        label: 'an unusable cursor is refused as unusable, not as too old',
        retained: window([3, 4, 5]),
        currentCursor: 5,
        requested: { kind: 'unusable', raw: 'nonsense' },
        expect: (plan) => {
          expect(plan.kind === 'refresh-required' && plan.reason).toBe('cursor-unusable')
          expect(plan.kind === 'refresh-required' && plan.requestedCursor).toBeNull()
        },
      },
      {
        label: 'a window short by one frame is a gap, not a replay',
        // Four changes were published and three are retained. Three of four is not
        // an answer, and answering with it is how a dashboard ends up showing a
        // state that never existed.
        retained: window([2, 3, 4]),
        currentCursor: 4,
        requested: { kind: 'cursor', cursor: 0 },
        expect: (plan) => {
          expect(plan.kind === 'refresh-required' && plan.reason).toBe('cursor-too-old')
          expect(plan.kind === 'refresh-required' && plan.oldestRetainedCursor).toBe(2)
        },
      },
      {
        label: 'a window that does not reach the current cursor is a gap',
        retained: window([3, 4]),
        currentCursor: 7,
        requested: { kind: 'cursor', cursor: 2 },
        expect: (plan) => {
          expect(plan.kind === 'refresh-required' && plan.reason).toBe('cursor-too-old')
          expect(plan.kind === 'refresh-required' && plan.currentCursor).toBe(7)
        },
      },
      {
        label: 'a hole in the window is a gap, not a replay',
        // The bus never produces one of these - it appends at the end and evicts
        // from the front, so a run is contiguous by construction - but a decision
        // function that is handed a window with a hole in it must refuse it rather
        // than serve a replay with a frame missing from the middle of it. This is
        // the one case only the cursor equality can catch: the run is long enough
        // for the first needed frame to exist, and it is the wrong frame.
        retained: window([1, 2, 4, 5]),
        currentCursor: 5,
        requested: { kind: 'cursor', cursor: 1 },
        expect: (plan) => {
          expect(plan.kind === 'refresh-required' && plan.reason).toBe('cursor-too-old')
          expect(plan.kind === 'refresh-required' && plan.oldestRetainedCursor).toBe(1)
        },
      },
    ]

    for (const testCase of cases) {
      // Each case is labelled, because a table that fails without saying which row
      // failed is a table nobody can fix.
      expect(
        planReplay({
          retained: testCase.retained,
          currentCursor: testCase.currentCursor,
          requested: testCase.requested,
        }),
        testCase.label,
      ).toBeDefined()
      testCase.expect(
        planReplay({
          retained: testCase.retained,
          currentCursor: testCase.currentCursor,
          requested: testCase.requested,
        }),
      )
    }
    // Every case really ran; a table that silently matched nothing would be a
    // green test of nothing.
    expect(cases.length).toBe(13)
  })
})

describe('the cursor parser', () => {
  it('reads a plain decimal cursor and refuses everything else', () => {
    expect(parseCursor('0')).toBe(0)
    expect(parseCursor('42')).toBe(42)
    expect(parseCursor(' 42 ')).toBe(42)
    // An empty or absent value is no cursor at all: `?cursor=` is a client that
    // templated an absent value, not a broken one.
    expect(parseCursor('')).toBeNull()
    expect(parseCursor('   ')).toBeNull()
    expect(parseCursor(null)).toBeNull()
    expect(parseCursor(undefined)).toBeNull()
    // Anything that is not a run of decimal digits is unusable, and is reported
    // as unusable rather than rounded into a cursor that means something else.
    for (const bad of ['-1', '1.5', '1e3', '0x10', 'NaN', 'Infinity', '1 2', '١٢٣', '1.0', '+1']) {
      expect(parseCursor(bad), bad).toBeNaN()
    }
    // Sixteen digits would lose precision as a double, so it is refused rather
    // than silently truncated to a cursor the client never held.
    expect(parseCursor('9007199254740993')).toBeNaN()
    expect(parseCursor('999999999999999')).toBe(999_999_999_999_999)

    expect(cursorRequest(null)).toEqual({ kind: 'none' })
    expect(cursorRequest('7')).toEqual({ kind: 'cursor', cursor: 7 })
    expect(cursorRequest('nope')).toEqual({ kind: 'unusable', raw: 'nope' })
  })

  it('prefers the parameter over the header, because one is a choice and one is a leftover', () => {
    const header = (value: string): IncomingMessage =>
      ({ headers: { 'last-event-id': value } }) as unknown as IncomingMessage

    expect(readRequestedCursor(header('3'), new URLSearchParams())).toEqual({
      kind: 'cursor',
      cursor: 3,
    })
    expect(readRequestedCursor(header('3'), new URLSearchParams('cursor=9'))).toEqual({
      kind: 'cursor',
      cursor: 9,
    })
    expect(readRequestedCursor(header('3'), new URLSearchParams('cursor='))).toEqual({
      kind: 'cursor',
      cursor: 3,
    })
    expect(readRequestedCursor(header(''), new URLSearchParams())).toEqual({ kind: 'none' })
    expect(readRequestedCursor(header('junk'), new URLSearchParams())).toEqual({
      kind: 'unusable',
      raw: 'junk',
    })
  })
})

describe('the wire format', () => {
  it('writes a frame as the specification describes it', () => {
    expect(encodeStreamFrame({ id: 7, event: 'change', data: { kind: 'event-stored' } })).toBe(
      'id: 7\nevent: change\ndata: {"kind":"event-stored"}\n\n',
    )
    // No id on a frame that advances nothing, which is what keeps a keepalive from
    // moving the mark a browser reconnects from.
    expect(encodeStreamFrame({ id: null, event: 'heartbeat', data: { cursor: 7 } })).toBe(
      'event: heartbeat\ndata: {"cursor":7}\n\n',
    )
    // Every frame ends with the blank line that dispatches it, so a truncated
    // frame is one the client never dispatches rather than one it dispatches
    // half-built.
    expect(encodeStreamFrame({ id: null, event: 'ready', data: null }).endsWith('\n\n')).toBe(true)
    // A payload with a newline in it becomes several data lines, which the
    // specification joins back into the same string. JSON escapes newlines inside
    // strings, so this only fires for a payload that is not a single JSON value.
    expect(encodeStreamFrame({ id: null, event: 'change', data: 'one\ntwo' })).toBe(
      'event: change\ndata: "one\\ntwo"\n\n',
    )
    // And the frame shapes are built in one place, so the stream cannot answer
    // three different payload shapes for three different names.
    expect(readyFrame({
      cursor: 4,
      oldestRetainedCursor: 2,
      heartbeatIntervalMs: 25_000,
      replayWindowMs: 300_000,
      replayMaxFrames: 512,
      at: '2026-09-26T10:00:00.000Z',
    })).toEqual({
      id: 4,
      event: 'ready',
      data: {
        cursor: 4,
        oldestRetainedCursor: 2,
        heartbeatIntervalMs: 25_000,
        replayWindowMs: 300_000,
        replayMaxFrames: 512,
        at: '2026-09-26T10:00:00.000Z',
      },
    })
    expect(heartbeatFrame({ cursor: 9, at: 'x' }).id).toBeNull()
    expect(
      changeFrame(change(1, { cursor: 1, at: atOf(1) })).data,
    ).toMatchObject({ cursor: 1 })
    expect(
      refreshRequiredFrame(
        {
          kind: 'refresh-required',
          reason: 'cursor-too-old',
          requestedCursor: 1,
          oldestRetainedCursor: 3,
          currentCursor: 5,
        },
        'now',
      ),
    ).toEqual({
      id: 5,
      event: 'refresh-required',
      data: {
        reason: 'cursor-too-old',
        requestedCursor: 1,
        oldestRetainedCursor: 3,
        currentCursor: 5,
        at: 'now',
      },
    })
    expect(encodeStreamPreamble('agent-ping state stream', 2_000)).toBe(
      ': agent-ping state stream\nretry: 2000\n\n',
    )
  })

  it('closes a client that stops reading rather than buffering for it', () => {
    // The memory bound on the client side. A sink that refuses a frame is a
    // client that is not draining its socket, and the two answers - buffer without
    // bound, or close and let the cursor replay catch it up - are not
    // interchangeable. The second is the only one that cannot exhaust the hub.
    let ended = 0
    const written: string[] = []
    const refusing: FrameSink = {
      write: () => false,
      end: () => {
        ended += 1
      },
    }
    const accepting: FrameSink = {
      write: (chunk) => {
        written.push(chunk)
        return true
      },
      end: () => {
        ended += 1
      },
    }

    expect(writeFrame(refusing, { id: 1, event: 'change', data: {} })).toBe(false)
    expect(ended).toBe(1)
    expect(writeFrame(accepting, { id: 1, event: 'change', data: {} })).toBe(true)
    expect(written).toHaveLength(1)
    expect(ended).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The feed's own bounds, on an injected clock
// ---------------------------------------------------------------------------

describe('the feed (no socket)', () => {
  it('evicts by count and by age, and answers a cursor that fell out of the window', () => {
    // The clock is injected because a five-minute window cannot be watched in a
    // test that has to finish, and because "the age bound fired" is a fact about
    // this code rather than about how long a test slept.
    let clock = 1_000
    const deps: ChangeFeedDeps = {
      now: () => clock,
      setInterval: (): TimerHandle => 0,
      clearInterval: (): void => undefined,
    }
    const feed = createChangeFeed(
      { replayMaxFrames: 3, replayWindowMs: 1_000, heartbeatIntervalMs: 0 },
      deps,
    )

    for (let index = 1; index <= 5; index += 1) {
      clock += 10
      feed.publish(report(index))
    }
    expect(feed.currentCursor()).toBe(5)
    expect(feed.retainedFrames().map((frame) => frame.cursor)).toEqual([3, 4, 5])
    expect(feed.oldestRetainedCursor()).toBe(3)

    // Age: the window is a second and nothing has been published, so the retained
    // frames age out even though the feed is quiet. A feed that only pruned on
    // publish would hold the last change before a lunch break as though it were
    // still replayable.
    clock += 1_001
    expect(feed.retainedFrames().length).toBe(0)
    expect(
      planReplay({ retained: feed.retainedFrames(), currentCursor: 5, requested: { kind: 'cursor', cursor: 4 } }),
    ).toMatchObject({ kind: 'refresh-required', reason: 'cursor-too-old' })
    // The cursor survives the eviction, so a client reconnecting to a feed whose
    // window has emptied is told it is behind rather than being told the feed has
    // never published anything.
    expect(feed.currentCursor()).toBe(5)
  })

  it('folds partial settings into their ranges', () => {
    expect(resolveStreamSettings({ heartbeatIntervalMs: 0 }).heartbeatIntervalMs).toBe(0)
    expect(resolveStreamSettings({ heartbeatIntervalMs: -5 }).heartbeatIntervalMs).toBe(0)
    expect(resolveStreamSettings({ replayMaxFrames: 0 }).replayMaxFrames).toBe(1)
    expect(resolveStreamSettings({ maxClients: 0.9 }).maxClients).toBe(1)
    expect(resolveStreamSettings({ replayMaxFrames: 10.7 }).replayMaxFrames).toBe(10)
    expect(resolveStreamSettings({ replayWindowMs: Number.NaN }).replayWindowMs).toBe(
      STREAM_REPLAY_WINDOW_MS,
    )
    expect(resolveStreamSettings({ maxClients: Number.POSITIVE_INFINITY }).maxClients).toBe(
      STREAM_MAX_CLIENTS,
    )
  })

  it('runs one heartbeat for every client and clears it on close', () => {
    // The timer is the one handle in this process that would otherwise outlive the
    // hub, so its creation and its clearing are both asserted rather than assumed.
    let ticks = 0
    const cleared: TimerHandle[] = []
    let handle = 0
    const deps: ChangeFeedDeps = {
      now: () => 1_000,
      setInterval: (): TimerHandle => {
        ticks += 1
        return ++handle
      },
      clearInterval: (clearedHandle): void => {
        cleared.push(clearedHandle)
      },
    }
    const frames: string[] = []
    const subscriber: {
      onFrame(frame: StreamFrame): void
      onHeartbeat(frame: StreamFrame): void
      onClose(reason: string): void
    } = {
      onFrame: (frame): void => {
        frames.push(frame.event)
      },
      onHeartbeat: (): void => {},
      onClose: (): void => {},
    }
    const feed = createChangeFeed({ heartbeatIntervalMs: 25_000 }, deps)
    expect(ticks).toBe(1)
    expect(feed.subscriberCount()).toBe(0)
    const unsubscribe = feed.subscribe(subscriber)
    expect(feed.subscriberCount()).toBe(1)
    feed.publish(report(1))
    expect(frames).toEqual(['change'])
    unsubscribe()
    expect(feed.subscriberCount()).toBe(0)
    // Publishing with no client is still a cursor, because the cursor belongs to
    // the feed's run and not to whoever is watching.
    expect(feed.publish(report(2)).cursor).toBe(2)
    expect(feed.isClosed()).toBe(false)
    feed.close()
    expect(cleared).toEqual([1])
    expect(feed.isClosed()).toBe(true)
    expect(feed.retainedFrames().length).toBe(0)
    expect(feed.subscriberCount()).toBe(0)
    // Close is idempotent and a publish afterwards is an ordering bug, reported
    // rather than dropped: a transition that reached a closing feed means the
    // shutdown order is wrong, and losing the frame would hide that (APX-FR-02).
    feed.close()
    expect(() => feed.publish(report(3))).toThrow(StreamFeedClosedError)
  })

  it('keeps one broken client from breaking the publisher', () => {
    // A dashboard that navigated away mid-write must not turn into a failed store
    // write. The subscriber is dropped, the publish returns, and the hub carries
    // on - which is why the guard is in the feed and not in the route.
    const feed = createChangeFeed({ heartbeatIntervalMs: 0 })
    const healthy: string[] = []
    const closeReasons: string[] = []
    feed.subscribe({
      onFrame: (): void => {
        throw new Error('EPIPE: the client went away')
      },
      onHeartbeat: (): void => {},
      onClose: (reason): void => {
        closeReasons.push(reason)
      },
    })
    feed.subscribe({
      onFrame: (frame): void => {
        healthy.push(String(frame.id))
      },
      onHeartbeat: (): void => {},
      onClose: (): void => {},
    })

    expect(() => feed.publish(report(1))).not.toThrow()
    expect(feed.subscriberCount()).toBe(1)
    expect(healthy).toEqual(['1'])
    expect(closeReasons).toEqual(['client-overrun'])
    feed.publish(report(2))
    expect(healthy).toEqual(['1', '2'])
    feed.close()
  })

  it('ends every client when the hub closes', () => {
    const feed = createChangeFeed({ heartbeatIntervalMs: 0 })
    const closed: string[] = []
    feed.subscribe({
      onFrame: (): void => {},
      onHeartbeat: (): void => {},
      onClose: (reason): void => {
        closed.push(reason)
      },
    })
    feed.close()
    expect(closed).toEqual(['hub-closing'])
    // And a subscription taken after the close is a no-op rather than a client
    // that never hears from the feed again.
    feed.subscribe({
      onFrame: (): void => {},
      onHeartbeat: (): void => {},
      onClose: (): void => {},
    })
    expect(feed.subscriberCount()).toBe(0)
  })
})

describe('the store wrapper', () => {
  it('publishes only what the store actually applied, and reads straight through', async () => {
    const hub = await startStreamHub()
    const published: ChangeKind[] = []
    // A second feed over the same wrapper, so the assertions are about which
    // outcomes publish rather than about what a socket did with them.
    const feed = createChangeFeed({ heartbeatIntervalMs: 0 })
    const original = hub.store
    const store = withChangeFeed(original, feed)
    const recording = { ...store }
    expect(recording.filePath).toBe(original.filePath)
    expect(recording.schemaVersion).toBe(original.schemaVersion)
    // Reads are the store's own, and identical.
    expect(recording.readPending()).toEqual(original.readPending())
    expect(recording.readSessionSummaries()).toEqual(original.readSessionSummaries())
    expect(recording.readEventHistory({ limit: 5 })).toEqual(original.readEventHistory({ limit: 5 }))
    expect(recording.readSession('ses_alpha')).toEqual(original.readSession('ses_alpha'))

    // A publish spy: the feed's own subscriber list is the record of what happened.
    const seen: string[] = []
    feed.subscribe({
      onFrame: (frame): void => {
        seen.push(String(frame.id))
      },
      onHeartbeat: (): void => {},
      onClose: (): void => {},
    })
    const block = recording.insertEvent(newBlock()).event
    published.push('event-stored')
    expect(recording.markAcknowledged(block.eventId).outcome).toBe('applied')
    expect(seen).toEqual(['1', '2'])
    expect(feed.currentCursor()).toBe(2)
    feed.close()
  })
})

// ---------------------------------------------------------------------------
// The performance budget
// ---------------------------------------------------------------------------

describe('the footprint of a hub with streams attached (APX-CON-11)', () => {
  it('keeps a hub with four live streams and a full replay window under 150 MB', async () => {
    // Measured in a child process, because the number that matters is a hub's and
    // this test process also holds the test runner, the TypeScript transform and
    // every fixture. The child starts the real entry point, opens four real
    // loopback streams, publishes six hundred transitions so the replay window is
    // filled and overrun, answers the read routes, and prints its own resident set
    // size. The budget is an idle-RSS budget, and a hub nobody is streaming to is
    // the cheaper half of the question.
    const result = await runNodeFixture('measure-stream-rss.mjs')
    expect(result.code, result.stderr).toBe(0)
    const measurement = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
      rssAfterBootBytes: number
      rssAfterStreamsBytes: number
      rssAfterChangesBytes: number
      rssAfterReadsBytes: number
      clients: number
      changes: number
      retainedFrames: number
      retainedBytes: number
      requestsServed: number
      measured: string
    }
    // Every client was still connected when the number was taken, so the figure is
    // a hub with streams attached rather than a hub that closed them.
    expect(measurement.clients).toBe(4)
    expect(measurement.changes).toBe(600)
    expect(measurement.requestsServed).toBeGreaterThan(0)
    expect(measurement.measured).toBe('typescript-source')
    // The window held its bound rather than all six hundred frames, which is the
    // property the byte count rests on.
    expect(measurement.retainedFrames).toBe(STREAM_REPLAY_MAX_FRAMES)
    expect(measurement.retainedBytes).toBeLessThan(1024 * 1024)

    const toMb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    const worst = measurement.rssAfterReadsBytes
    expect(
      worst / (1024 * 1024),
      `a hub with four live streams used ${toMb(worst)}`,
    ).toBeLessThan(150)
    console.info(
      `[stream] hub RSS: ${toMb(measurement.rssAfterBootBytes)} after boot, ` +
        `${toMb(measurement.rssAfterStreamsBytes)} with 4 streams open, ` +
        `${toMb(measurement.rssAfterChangesBytes)} after 600 transitions, ` +
        `${toMb(worst)} after ${measurement.requestsServed} reads ` +
        `(retained window ${(measurement.retainedBytes / 1024).toFixed(0)} KiB; budget 150 MB)`,
    )
  })
})

// ---------------------------------------------------------------------------
// Running a fixture in a real Node process
// ---------------------------------------------------------------------------

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

/**
 * Run a fixture in a real Node process against the real source tree.
 *
 * The fixture imports `src/main/index.ts` directly: Node strips the types itself
 * (on by default from 22.18, and requested through the flag before that), and the
 * resolver hook beside it maps the build's `.js` specifiers onto the `.ts` sources
 * they name. So the measurement is of the product, not of a build.
 */
function runNodeFixture(fixture: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const nodeArgs = [
    '--no-warnings',
    ...(process.features.typescript ? [] : ['--experimental-strip-types']),
    path.join(FIXTURES, fixture),
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd: path.join(FIXTURES, '..', '..', '..'),
      env: { ...process.env, AGENT_PING_STATE_DIR: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

// ---------------------------------------------------------------------------
// Builders for the unit half
// ---------------------------------------------------------------------------

function atOf(cursor: number): string {
  return new Date(Date.UTC(2026, 8, 26, 10, 0, cursor)).toISOString()
}

function report(index: number): StateChangeReport {
  return {
    kind: 'event-stored',
    event: {
      eventId: `evt_${index}`,
      sessionId: 'ses_alpha',
      class: 'needs-you',
      subtype: null,
      rawEventType: 'permission.asked',
      occurredAt: atOf(index),
      receivedAt: atOf(index),
      dedupeKey: `opencode:ses_alpha:block-${index}`,
      ackState: 'unacknowledged',
      resolutionState: 'unresolved',
    },
    session: {
      sessionId: 'ses_alpha',
      harness: 'opencode',
      repoShortName: 'agent-ping',
      repoFullPath: '/home/dev/Projects/agent-ping',
      firstSeenAt: atOf(1),
      lastSeenAt: atOf(index),
      state: 'blocked',
      workSignal: 0,
      pendingCount: index,
    },
    pendingCount: index,
  }
}

function change(cursor: number, overrides: Partial<StateChange>): StateChange {
  return { ...report(cursor), cursor, at: atOf(cursor), ...overrides }
}
