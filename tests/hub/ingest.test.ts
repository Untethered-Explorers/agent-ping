// The ingest route and the event pipeline, over a real loopback socket against a
// hub started by the real main entry point (HC-3, HC-FR-04, HC-FR-08, HC-FR-09).
//
//   npm test -- tests/hub/ingest.test.ts
//
// The acceptance criteria, and where each is proven:
//
//   1. A valid envelope is stored, classified, and answered 202 *before* any
//      delivery work completes. Proven over a real socket with a delivery port whose
//      promise is held open by the test: the client has its 202 while the delivery
//      is provably still in flight.
//   2. The same envelope twice yields one stored event and an unchanged pending
//      count, and fires no second delivery. Proven by posting a block three times
//      over the socket and reading the log back through a second connection.
//   3. A malformed payload and an unknown harness both produce a client error with
//      nothing stored. Proven from a table of bodies - bad JSON, an undeclared field,
//      a wrong type, a missing field, an over-cap body, a body that never ends, a
//      harness this build does not know, an unmapped signal, an unresolved one - each
//      checked for a 4xx *and* for a log that did not move.
//   4. A forced store failure records a dropped event and releases the caller within
//      the configured bound. The failure is *real*: the database is closed under a
//      running hub, and the next post is answered 503 rather than 202, because the
//      event is not in the log and saying otherwise is APX-FR-02's exact failure.
//
// Around those four, the properties that make them worth anything:
//
//   - The pipeline is the classifier's and the lifecycle's: this file posts
//     documented opencode event names and asserts the class the classifier's own
//     table decides, including the idle gate that stores nothing at all and a
//     measurement threshold that is read but never carried onward.
//   - A replay fires no second delivery, and neither does a suppression or a
//     resolution - the seam is what makes "exactly once per event" a property of
//     `startDelivery` rather than a rule a caller has to remember.
//   - The refusal bodies carry no value from the request: every field of a refused
//     body is a recognisable string, and none of them appears in any answer.
//   - The mutating surface is exactly two signatures, every other method and path on
//     `/api/ingest` is refused with nothing stored, and a registration that claims
//     the ack mutation on a path that is not the ack route is refused at register
//     time.
//   - The p95 of a real ingest burst is measured and reported against the 50 ms
//     budget rather than asserted as a bare threshold.
//
// The store is opened a second time on purpose: the hub holds one connection, and a
// second connection over the same file is how anything outside the process observes
// the log. Every count is read through the store's typed accessors, because the store
// has no query surface and inventing one in a test would prove nothing about the
// product.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { startHub, type RunningHub } from '@/main/index'
import { openEventStore, type EventStore } from '@/storage/eventStore'
import { KNOWN_HARNESSES } from '@/domain/envelope'
import type { HarnessSignal } from '@/domain/classify'
import {
  createIngestService,
  INGEST_DELIVERY_TIMEOUT_MS,
  INGEST_P95_BUDGET_MS,
  INGEST_STORE_TIMEOUT_MS,
  isCallerFault,
  type DeliveryPort,
  type DeliveryRequest,
  type IngestRefusalCode,
} from '@/hub/ingest-service'
import {
  INGEST_ERROR_CODES,
  INGEST_KNOWN_HARNESSES,
  INGEST_MAX_BODY_BYTES,
  INGEST_REFUSAL_DETAIL,
  INGEST_REFUSAL_STATUS,
  INGEST_ROUTES,
  INGEST_SIGNAL_FIELDS,
  INGEST_SIGNAL_FIELD_NAMES,
  INGEST_TRANSPORT_STATUS,
  validateIngestSignal,
  type IngestAcceptedBody,
} from '@/hub/routes/ingest'
import { MUTATING_ROUTE, MUTATING_ROUTES, RouteRegistry } from '@/hub/server'
import type { HubServices } from '@/hub/routes/read'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_PATH = '/home/dev/Projects/agent-ping'
const SESSION = 'ses_ingest_01'
const OCCURRED_AT = '2026-09-26T09:00:00.000Z'
/** What the hub's own clock stamps on a signal, in place of the wire schema. */
const HUB_RECEIVED_AT = '2026-09-26T09:00:00.250Z'

/**
 * The ceiling the hung-body assertion allows above the route's own bound.
 *
 * The route answers at `INGEST_BODY_TIMEOUT_MS`; this is a generous ceiling for the
 * *measurement*, because the claim being asserted is "a fast error, not a hang" and a
 * scheduler hiccup on a loaded machine should not decide that.
 */
const HUNG_BODY_CEILING_MS = 10_000

const temporaryDirectories: string[] = []
const openHubs: RunningHub[] = []
const openStores: EventStore[] = []

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  for (const hub of openHubs.splice(0)) {
    await hub.close().catch(() => undefined)
  }
  for (const store of openStores.splice(0)) store.close()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * A hub, started by the real entry point against a temporary state directory.
 *
 * `dashboardRoot: null` because nothing here reads a page: a stand-in build would be
 * a second fixture whose only job is to exist.
 */
async function startFixtureHub(
  options: Partial<Parameters<typeof startHub>[0]> = {},
): Promise<RunningHub> {
  const hub = await startHub({
    stateDir: temporaryDirectory('agent-ping-state-'),
    dashboardRoot: null,
    ...options,
  })
  openHubs.push(hub)
  return hub
}

/** A second connection to the log the hub is holding. */
function observeLog(hub: RunningHub): EventStore {
  const store = openEventStore({ filePath: hub.databaseFilePath })
  openStores.push(store)
  return store
}

/** A standalone store, for the unit half of this file. */
function openScratchStore(prefix: string): EventStore {
  const store = openEventStore({ filePath: path.join(temporaryDirectory(prefix), 'scratch.db') })
  openStores.push(store)
  return store
}

/** A block in one session: the only class that leaves the app (EL-FR-07). */
function blockBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    harness: 'opencode',
    eventName: 'permission.asked',
    sessionId: SESSION,
    repoFullPath: REPO_PATH,
    transitionId: 'block-7',
    occurredAt: OCCURRED_AT,
    ...overrides,
  }
}

/** An idle transition that recorded (or did not record) work: the finished class. */
function idleBody(transitionId: string, worked: boolean): Record<string, unknown> {
  return {
    harness: 'opencode',
    eventName: 'session.status',
    variant: 'idle',
    sessionId: SESSION,
    repoFullPath: REPO_PATH,
    transitionId,
    occurredAt: OCCURRED_AT,
    turnWork: { toolCall: worked, fileEdit: false, todoUpdate: false },
  }
}

/** A harness resolution: not a class event, and it clears the pending item. */
function resolutionBody(transitionId: string | undefined): Record<string, unknown> {
  return {
    harness: 'opencode',
    eventName: 'permission.replied',
    sessionId: SESSION,
    repoFullPath: REPO_PATH,
    ...(transitionId === undefined ? {} : { transitionId }),
    occurredAt: OCCURRED_AT,
  }
}

/**
 * A body as the classifier's input, for driving the service directly.
 *
 * The fixtures above are deliberately loose so the same one can carry a deliberately
 * wrong field over the wire; the unit half needs a `HarnessSignal`, and this is the one
 * place that cast happens rather than at a dozen call sites. `receivedAt` is filled in
 * here because in production the *route* stamps it - the wire schema has no such
 * field, and the classifier requires one - so a body used as a signal is missing
 * something the route would have added.
 */
function asSignal(body: Record<string, unknown>): HarnessSignal {
  return { receivedAt: HUB_RECEIVED_AT, ...body } as unknown as HarnessSignal
}

/**
 * A refusal body as the assertions read it.
 *
 * Declared here rather than imported as a closed type because two of these
 * assertions are about fields that are deliberately *absent* - a refusal must not
 * claim to have stored anything - and a closed type would make the absence a
 * compile error instead of a thing worth asserting.
 */
interface RefusalBody {
  readonly error: string
  readonly detail: string
  readonly accepted?: unknown
  readonly dropped?: unknown
  readonly issues?: readonly { readonly path: string; readonly code: string }[]
}

interface Fetched {
  readonly status: number
  readonly text: string
  json<T = unknown>(): T
}

interface CallInit {
  readonly method?: string
  readonly body?: string
  readonly headers?: Readonly<Record<string, string>>
  /** A raw path, for requests that are not the happy path. */
  readonly pathname?: string
}

/**
 * One request over a real socket, through node:http.
 *
 * Deliberately not `fetch`, for the reason the server test gives: these tests reuse
 * one loopback origin on purpose, and a pooled connection opened against a hub that
 * has since closed would be handed to the next request. One request, one connection.
 */
function call(origin: string, init: CallInit = {}): Promise<Fetched> {
  const { hostname, port } = new URL(origin)
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: hostname,
        port,
        path: init.pathname ?? '/api/ingest',
        method: init.method ?? 'POST',
        headers: {
          'content-type': 'application/json',
          ...(init.body === undefined
            ? {}
            : { 'content-length': String(Buffer.byteLength(init.body)) }),
          ...init.headers,
        },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: response.statusCode ?? 0,
            text,
            json: <T,>(): T => JSON.parse(text) as T,
          })
        })
      },
    )
    outgoing.on('error', reject)
    if (init.body === undefined) outgoing.end()
    else outgoing.end(init.body)
  })
}

/** Post one JSON body to the ingest route. */
async function post(hub: RunningHub, body: unknown): Promise<Fetched> {
  return call(hub.origin, { body: JSON.stringify(body) })
}

/** A GET to any read route, for the "the hub is still serving" assertions. */
async function get(hub: RunningHub, pathname: string): Promise<Fetched> {
  return call(hub.origin, { method: 'GET', pathname })
}

interface LogCounts {
  readonly pending: number
  readonly events: number
  readonly sessions: number
}

/** The counts a refusal must leave exactly as it found them. */
function countsOf(hub: RunningHub): LogCounts {
  const store = observeLog(hub)
  return {
    pending: store.readPending().length,
    events: store.readEventHistory({ limit: 500 }).length,
    sessions: store.readSessionSummaries().length,
  }
}

// ---------------------------------------------------------------------------
// HC-FR-04: the happy path
// ---------------------------------------------------------------------------

describe('a posted signal becomes exactly one stored, classified event', () => {
  it('stores one needs-you event and answers 202', async () => {
    const hub = await startFixtureHub()

    const response = await post(hub, blockBody())

    expect(response.status).toBe(202)
    const body = response.json<IngestAcceptedBody>()
    expect(body.accepted).toBe(true)
    expect(body.outcome).toBe('pending-created')
    // The class is the classifier's decision, read out of the classifier's own table
    // rather than out of a value this test invented.
    expect(body.class).toBe('needs-you')
    expect(body.pendingCount).toBe(1)
    expect(body.duplicate).toBe(false)
    expect(body.reason).toBeNull()
    expect(typeof body.eventId).toBe('string')
    // The 202 body is exactly six fields: no event, no session, no echo of what was
    // posted (APX-FR-01).
    expect(Object.keys(body).sort()).toEqual([
      'accepted',
      'class',
      'duplicate',
      'eventId',
      'outcome',
      'pendingCount',
      'reason',
    ])

    // One row, and it is the row the body named.
    const store = observeLog(hub)
    const history = store.readEventHistory({ limit: 10 })
    expect(history).toHaveLength(1)
    expect(history[0]?.eventId).toBe(body.eventId)
    expect(history[0]?.class).toBe('needs-you')
    expect(history[0]?.rawEventType).toBe('permission.asked')
    // The dedupe key is derived in the hub, from identity alone, so it is the one the
    // classifier's own derivation produces and not something the caller sent.
    expect(history[0]?.dedupeKey).toBe(`opencode:${SESSION}:block-7`)
    // The short name is derived from the path, so an adapter cannot mislabel a row.
    expect(store.readPending()[0]?.repoShortName).toBe('agent-ping')
    // And the received stamp is the hub's own clock, because the wire schema has no
    // receivedAt field at all.
    expect(typeof history[0]?.receivedAt).toBe('string')
  })

  it('stores a finished event for an idle transition that worked, and nothing for one that did not', async () => {
    const hub = await startFixtureHub()

    const worked = await post(hub, idleBody('idle-1', true))
    expect(worked.status).toBe(202)
    expect(worked.json<IngestAcceptedBody>()).toMatchObject({ outcome: 'stored', class: 'finished' })

    // The idle gate: a turn with no tool call, no file edit and no todo update
    // produces no event at all - not a quiet one, no event (EL-FR-05).
    const idle = await post(hub, idleBody('idle-2', false))
    expect(idle.status).toBe(202)
    expect(idle.json<IngestAcceptedBody>()).toMatchObject({
      outcome: 'no-event',
      reason: 'idle-after-nothing',
      eventId: null,
      class: null,
    })

    // So the log holds exactly the one that earned a row, and no pending item exists
    // for either: a finished event is never a block.
    const store = observeLog(hub)
    expect(store.readEventHistory({ limit: 10 })).toHaveLength(1)
    expect(store.readPending()).toHaveLength(0)
  })

  it('carries a measurement the classifier reads, and keeps it out of the log', async () => {
    // The threshold numbers are the classifier's, not this route's: the route's only
    // job is to carry the measurement there intact (EL-FR-04).
    const hub = await startFixtureHub()

    const long = await post(hub, {
      harness: 'opencode',
      eventName: 'tool.execute.after',
      sessionId: SESSION,
      repoFullPath: REPO_PATH,
      transitionId: 'tool-1',
      occurredAt: OCCURRED_AT,
      measurements: { durationMs: 45_000 },
    })
    expect(long.json<IngestAcceptedBody>()).toMatchObject({ class: 'fyi', outcome: 'stored' })
    const stored = observeLog(hub).readEventHistory({ limit: 10 })[0]
    expect(stored?.subtype).toBe('long-tool-call')
    // The measurement decided the class and then died: no number that grows with
    // activity reaches the durable log (APX-FR-01).
    expect(JSON.stringify(stored)).not.toMatch(/durationMs|45000/)

    // Below the threshold the same signal produces no event, and the reason says
    // which gate applied rather than "nothing happened".
    const quick = await post(hub, {
      ...idleBody('tool-2', true),
      eventName: 'tool.execute.after',
      measurements: { durationMs: 12 },
    })
    expect(quick.status).toBe(202)
    expect(quick.json<IngestAcceptedBody>()).toMatchObject({
      outcome: 'no-event',
      reason: 'below-threshold',
      eventId: null,
    })

    // And a harness that cannot report the measurement degrades visibly rather than
    // quietly: `measurement-unavailable` is its own reason, distinct from a threshold
    // that was not reached.
    const unknown = await post(hub, {
      ...idleBody('tool-3', true),
      eventName: 'tool.execute.after',
    })
    expect(unknown.json<IngestAcceptedBody>().reason).toBe('measurement-unavailable')
  })

  it('opens a pending item on a block and clears it on the harness resolution', async () => {
    const hub = await startFixtureHub()
    const store = observeLog(hub)

    expect((await post(hub, blockBody())).json<IngestAcceptedBody>().pendingCount).toBe(1)
    expect(store.readPending()).toHaveLength(1)

    // The resolution is not a class event; it clears the pending item through the
    // lifecycle and answers 202 like every other acceptance (EL-FR-08).
    const resolution = await post(hub, resolutionBody('block-7'))

    expect(resolution.status).toBe(202)
    expect(resolution.json<IngestAcceptedBody>()).toMatchObject({
      outcome: 'resolved',
      pendingCount: 0,
    })
    expect(store.readPending()).toHaveLength(0)
    // The resolution recorded a fact rather than appending an event of its own.
    expect(store.readEventHistory({ limit: 10 })).toHaveLength(1)

    // A second resolution for the same block changes nothing and is not an error:
    // there is no pending item left to clear, and inventing one would create the very
    // pending item the signal says is finished.
    expect((await post(hub, resolutionBody('block-7'))).json<IngestAcceptedBody>()).toMatchObject({
      outcome: 'nothing-pending',
      pendingCount: 0,
      eventId: null,
    })
    expect(store.readPending()).toHaveLength(0)
    expect(store.readEventHistory({ limit: 10 })).toHaveLength(1)
  })

  it('accepts a signal posted without a content-type header', async () => {
    // The content type is not a gate. This is an unauthenticated loopback route whose
    // only client is a plugin inside a harness, and a transport that forgets the header
    // would otherwise learn about it by getting a 415 from a hub that is working
    // perfectly. What the route *does* insist on is that the bytes parse as a JSON
    // object matching the closed schema.
    const hub = await startFixtureHub()
    const { hostname, port } = new URL(hub.origin)
    const body = JSON.stringify(blockBody())

    const response = await new Promise<Fetched>((resolve, reject) => {
      const outgoing = request(
        {
          host: hostname,
          port,
          path: '/api/ingest',
          method: 'POST',
          // Deliberately no content-type at all.
          headers: { 'content-length': String(Buffer.byteLength(body)) },
          agent: false,
        },
        (incoming) => {
          const chunks: Buffer[] = []
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
          incoming.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            resolve({ status: incoming.statusCode ?? 0, text, json: <T,>(): T => JSON.parse(text) as T })
          })
        },
      )
      outgoing.on('error', reject)
      outgoing.end(body)
    })

    expect(response.status).toBe(202)
    expect(observeLog(hub).readPending()).toHaveLength(1)
  })

  it('answers a replay with 202 and a duplicate flag, not a client error', async () => {
    const hub = await startFixtureHub()

    await post(hub, blockBody())
    const replay = await post(hub, blockBody())

    // A 4xx here would be how a transport grows a retry storm over a signal the hub
    // already has (APX-CON-10), so a replay is an acceptance with a flag.
    expect(replay.status).toBe(202)
    expect(replay.json<IngestAcceptedBody>()).toMatchObject({
      accepted: true,
      outcome: 'duplicate',
      duplicate: true,
      pendingCount: 1,
    })
  })
})

// ---------------------------------------------------------------------------
// HC-FR-04: the answer arrives before any delivery completes
// ---------------------------------------------------------------------------

describe('the answer does not wait for delivery', () => {
  it('answers 202 while the delivery is still in flight', async () => {
    // The delivery port returns a promise this test holds open. So "the caller was
    // released before the delivery finished" is observed rather than asserted: at the
    // moment the 202 has arrived, the delivery has provably not completed.
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let deliveryFinished = false
    const port: DeliveryPort = () =>
      held.then(() => {
        deliveryFinished = true
      })
    const hub = await startFixtureHub({ ingest: { delivery: port, deliveryWired: true } })

    const response = await post(hub, blockBody())

    expect(response.status).toBe(202)
    expect(response.json<IngestAcceptedBody>().outcome).toBe('pending-created')
    expect(deliveryFinished).toBe(false)

    release?.()
    await hub.ingest.idle()
    expect(deliveryFinished).toBe(true)
    expect(hub.ingest.stats().deliveries).toMatchObject({ attempted: 1, delivered: 1 })
  })

  it('writes the response before it starts the delivery', () => {
    // The other half of the ordering, asserted from the source because both steps
    // happen inside one synchronous turn of the event loop: no observer outside this
    // process can tell which ran first, because the client's own copy of the response
    // is delivered on a later turn either way. What matters, and what the test above
    // observes, is that the delivery is not on the caller's path. This guards the
    // source order so a refactor cannot swap them.
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'hub', 'routes', 'ingest.ts'),
      'utf8',
    )
    const answeredAt = source.indexOf('respondAccepted(response, result)')
    const deliveryAt = source.indexOf('services.ingest.startDelivery(result)')
    expect(answeredAt).toBeGreaterThan(-1)
    expect(deliveryAt).toBeGreaterThan(answeredAt)
  })

  it('hands the delivery port the stored event, the class and the pending count, and nothing else', async () => {
    const calls: DeliveryRequest[] = []
    const hub = await startFixtureHub({
      ingest: { delivery: (delivery): void => void calls.push(delivery), deliveryWired: true },
    })

    await post(hub, blockBody())
    await hub.ingest.idle()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.class).toBe('needs-you')
    expect(calls[0]?.pendingCount).toBe(1)
    expect(calls[0]?.event.dedupeKey).toBe(`opencode:${SESSION}:block-7`)
    // Exactly the three fields the delivery request declares, over the event record's
    // own content-free shape: no prompt, no tool name, no path beyond the ones the
    // store already holds (APX-FR-01).
    expect(Object.keys(calls[0] ?? {}).sort()).toEqual(['class', 'event', 'pendingCount'])
    expect(Object.keys(calls[0]?.event ?? {}).sort()).toEqual([
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
  })

  it('counts a delivery that is not wired yet rather than passing silently', async () => {
    // Every build before HC-5 has no port. "We did not deliver" is a fact an operator
    // can see instead of a bug they infer from a missing toast months later
    // (APX-FR-02).
    const hub = await startFixtureHub()

    await post(hub, blockBody())
    await hub.ingest.idle()

    expect(hub.ingest.stats().deliveries).toEqual({
      attempted: 1,
      delivered: 0,
      failed: 0,
      timedOut: 0,
      notWired: 1,
    })
  })
})

// ---------------------------------------------------------------------------
// HC-FR-08: idempotent under replay
// ---------------------------------------------------------------------------

describe('re-posting a stored envelope is a no-op', () => {
  it('stores one event, leaves the pending count alone, and fires no second delivery', async () => {
    const calls: DeliveryRequest[] = []
    const hub = await startFixtureHub({
      ingest: { delivery: (delivery): void => void calls.push(delivery), deliveryWired: true },
    })
    const store = observeLog(hub)

    const first = await post(hub, blockBody())
    const second = await post(hub, blockBody())
    const third = await post(hub, blockBody())
    await hub.ingest.idle()

    // One event, from three posts of the same signal.
    expect(store.readEventHistory({ limit: 10 })).toHaveLength(1)
    // One pending item, so the badge does not double-count the block (EL-FR-08).
    expect(store.readPending()).toHaveLength(1)
    // The same row each time: the dedupe key found the first one.
    const firstId = first.json<IngestAcceptedBody>().eventId
    expect(second.json<IngestAcceptedBody>().eventId).toBe(firstId)
    expect(third.json<IngestAcceptedBody>().eventId).toBe(firstId)
    // Exactly one delivery for the event, not one per post.
    expect(calls).toHaveLength(1)
    expect(hub.ingest.stats()).toMatchObject({ stored: 1, duplicates: 2, suppressed: 0, dropped: 0 })
  })

  it('delivers nothing for a suppression, a resolution or a second resolution', async () => {
    const calls: DeliveryRequest[] = []
    const hub = await startFixtureHub({
      ingest: { delivery: (delivery): void => void calls.push(delivery), deliveryWired: true },
    })

    await post(hub, blockBody({ transitionId: 'block-a' }))
    await post(hub, idleBody('idle-1', false)) // the idle gate: no event
    await post(hub, resolutionBody('block-a')) // clears the pending item
    await post(hub, resolutionBody('block-a')) // nothing left to clear
    await hub.ingest.idle()

    // Only the block. A delivery policy may later decide that a finished event is
    // worth a toast; what it may not do is receive a second event for one block, or
    // an event for a resolution that stored nothing (APX-CON-10, HC-FR-08).
    expect(calls).toHaveLength(1)
    expect(calls[0]?.event.dedupeKey).toBe(`opencode:${SESSION}:block-a`)
  })

  it('publishes exactly one change frame for a replayed envelope', async () => {
    // The stream is fed by the store's own outcomes, so a no-op must produce no
    // frame: a dashboard that re-read for a duplicate would be paying for a replay
    // (HC-FR-03, HC-FR-08).
    const hub = await startFixtureHub()

    await post(hub, blockBody())
    expect(hub.stream.currentCursor()).toBe(1)
    await post(hub, blockBody())
    expect(hub.stream.currentCursor()).toBe(1)
  })

  it('leaves the pending count and the history untouched across a whole replay burst', async () => {
    const hub = await startFixtureHub()
    await post(hub, blockBody())
    const before = countsOf(hub)
    expect(before).toEqual({ pending: 1, events: 1, sessions: 1 })

    for (let index = 0; index < 5; index += 1) await post(hub, blockBody())

    expect(countsOf(hub)).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// HC-FR-04: the refusals
// ---------------------------------------------------------------------------

describe('a malformed payload or an unknown harness is a client error with nothing stored', () => {
  const refusals: readonly { readonly why: string; readonly body: string }[] = [
    { why: 'not JSON at all', body: 'this is not json' },
    { why: 'an empty body', body: '' },
    { why: 'JSON but not an object', body: '[1,2,3]' },
    { why: 'a null body', body: 'null' },
    {
      why: 'a field this product does not declare',
      body: JSON.stringify({ ...blockBody(), prompt: 'a pasted prompt' }),
    },
    {
      why: 'a class the caller decided for itself',
      body: JSON.stringify({ ...blockBody(), class: 'needs-you' }),
    },
    {
      why: 'a dedupe key derived in transit',
      body: JSON.stringify({ ...blockBody(), dedupeKey: 'made-up' }),
    },
    {
      why: 'a receivedAt the caller stamped',
      body: JSON.stringify({ ...blockBody(), receivedAt: OCCURRED_AT }),
    },
    {
      why: 'a repoShortName the caller chose',
      body: JSON.stringify({ ...blockBody(), repoShortName: 'whatever' }),
    },
    { why: 'a missing harness', body: JSON.stringify({ ...blockBody(), harness: undefined }) },
    { why: 'a missing event name', body: JSON.stringify({ ...blockBody(), eventName: undefined }) },
    { why: 'a numeric session id', body: JSON.stringify({ ...blockBody(), sessionId: 7 }) },
    {
      why: 'a turn work signal carrying a count',
      body: JSON.stringify({
        ...idleBody('idle-9', true),
        turnWork: { toolCall: 3, fileEdit: false, todoUpdate: false },
      }),
    },
    {
      why: 'a turn work signal with an undeclared measure',
      body: JSON.stringify({
        ...idleBody('idle-10', true),
        turnWork: { toolCall: true, fileEdit: false, todoUpdate: false, words: 900 },
      }),
    },
    { why: 'a harness this build does not know', body: JSON.stringify(blockBody({ harness: 'claude-code' })) },
    {
      why: 'a harness event name this build does not map',
      body: JSON.stringify(blockBody({ eventName: 'session.exploded' })),
    },
    {
      why: 'a harness event recorded as unresolved upstream',
      body: JSON.stringify({ ...blockBody(), harness: 'copilot-cli', eventName: 'session/update' }),
    },
    {
      why: 'a resolution naming no block',
      body: JSON.stringify(resolutionBody(undefined)),
    },
    {
      why: 'a timestamp that is not ISO 8601 UTC',
      body: JSON.stringify({ ...blockBody(), occurredAt: 'yesterday' }),
    },
    {
      why: 'a multi-line identifier',
      body: JSON.stringify({ ...blockBody(), sessionId: 'ses\nthe rest of a prompt' }),
    },
  ]

  it('refuses every body in the table, with a 4xx and an unmoved log', async () => {
    const hub = await startFixtureHub()
    // Seed one good event so the comparison is against a log that is not empty: a
    // refusal that does not move a count is only interesting when the count is real.
    await post(hub, blockBody({ transitionId: 'block-seed' }))
    const before = countsOf(hub)
    expect(before).toEqual({ pending: 1, events: 1, sessions: 1 })

    for (const entry of refusals) {
      const response = await call(hub.origin, { body: entry.body })
      // Every client fault is a 4xx: the caller can fix it, and a 5xx here would send
      // an adapter looking for a broken hub instead of a broken signal.
      expect(response.status, `${entry.why} answered ${response.status}`).toBeGreaterThanOrEqual(400)
      expect(response.status, entry.why).toBeLessThan(500)
      const body = response.json<RefusalBody>()
      // A refusal never claims to have stored anything, and never claims to have
      // lost anything either: a client error is the caller's signal, not a drop.
      expect(body.accepted, entry.why).toBeUndefined()
      expect(body.dropped, entry.why).toBeUndefined()
      expect(body.error, entry.why).toBeTypeOf('string')
      expect(countsOf(hub), `${entry.why} changed the log`).toEqual(before)
    }
  })

  it('refuses an unknown harness under its own error code, with the field named', async () => {
    const hub = await startFixtureHub()

    const response = await post(hub, blockBody({ harness: 'claude-code' }))

    expect(response.status).toBe(422)
    const body = response.json<RefusalBody>()
    // The adapter has to be able to tell "your harness name is not one we know" from
    // "your payload was malformed": the first is a contract problem, the second a
    // transport problem.
    expect(body.error).toBe('unknown-harness')
    expect(body.issues).toEqual([{ path: 'harness', code: 'unknown-harness' }])
    expect(body.detail).toBe(INGEST_REFUSAL_DETAIL['unknown-harness'])
  })

  it('names the fields it refused and quotes no value from the request', async () => {
    const hub = await startFixtureHub()
    // Every value here is a recognisable string, so an answer that quoted one would be
    // obvious. The content boundary is the point: a refused field is a field a caller
    // filled with something they should not have (APX-FR-01).
    const recognisable = 'a pasted prompt nobody should ever send to a hub'
    const body = JSON.stringify({ ...blockBody(), prompt: recognisable, sessionId: 42 })

    const response = await call(hub.origin, { body })

    expect(response.status).toBe(422)
    const parsed = response.json<RefusalBody>()
    expect(parsed.issues).toEqual(
      expect.arrayContaining([
        { path: 'prompt', code: 'unrecognised-field' },
        { path: 'sessionId', code: 'wrong-type' },
      ]),
    )
    // Field names yes, values never.
    expect(response.text).not.toContain(recognisable)
    expect(response.text).not.toContain(SESSION)
  })

  it('refuses a body over the byte cap without interpreting it', async () => {
    const hub = await startFixtureHub()
    const before = countsOf(hub)
    const oversized = JSON.stringify({
      ...blockBody(),
      eventName: 'permission.asked'.repeat(INGEST_MAX_BODY_BYTES),
    })
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(INGEST_MAX_BODY_BYTES)

    const response = await call(hub.origin, { body: oversized })

    expect(response.status).toBe(413)
    expect(response.json<RefusalBody>().error).toBe('body-too-large')
    expect(countsOf(hub)).toEqual(before)
  })

  it('releases a client that opens a request and never finishes sending one', async () => {
    const hub = await startFixtureHub()
    const before = countsOf(hub)
    const { hostname, port } = new URL(hub.origin)

    // A body that is announced as large and then never sent. The route's own bound is
    // what answers this, and the answer is a fast 408 rather than a held connection.
    const startedAt = Date.now()
    const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const outgoing = request(
        {
          host: hostname,
          port,
          path: '/api/ingest',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': '1000' },
          agent: false,
        },
        (incoming) => {
          const chunks: Buffer[] = []
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
          incoming.on('end', () =>
            resolve({
              status: incoming.statusCode ?? 0,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          )
        },
      )
      outgoing.on('error', reject)
      // Half a body, and no end.
      outgoing.write('{"harness":"opencode"')
    })
    const elapsed = Date.now() - startedAt

    expect(response.status).toBe(408)
    expect(JSON.parse(response.text).error).toBe('body-timeout')
    // A fast error rather than a hang, and the bound is the route's own.
    expect(elapsed).toBeLessThan(HUNG_BODY_CEILING_MS)
    expect(countsOf(hub)).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// HC-FR-09: a forced store failure
// ---------------------------------------------------------------------------

describe('a store that cannot write drops the event and releases the caller', () => {
  it('answers 503, records a dropped event, and returns within the bound', async () => {
    const hub = await startFixtureHub()
    // Seed one good event, so "nothing was stored" is a claim about this request and
    // not about a log that happened to be empty anyway.
    await post(hub, blockBody({ transitionId: 'block-seed' }))

    // The failure is real, not injected: the database is closed under a running hub,
    // which is what a machine that lost its disk, or a file replaced underneath it,
    // looks like from this route.
    hub.store.close()

    const startedAt = Date.now()
    const response = await post(hub, blockBody({ transitionId: 'block-lost' }))
    const elapsed = Date.now() - startedAt

    // Not 202. The event is not in the log, and a 202 would be the exact failure
    // APX-FR-02 names: reporting an event as received that was not.
    expect(response.status).toBe(503)
    const body = response.json<RefusalBody>()
    expect(body.error).toBe('store-failed')
    // `dropped` is the difference between "refused" and "we lost it", which is the
    // distinction the adapter's breadcrumb needs.
    expect(body.dropped).toBe(true)
    // Released within the configured bound, and in practice far inside it: a store
    // that throws releases the caller on the first turn of the event loop.
    expect(elapsed).toBeLessThan(INGEST_STORE_TIMEOUT_MS)
    // And the bound is the named, documented one rather than whatever the code does.
    expect(INGEST_STORE_TIMEOUT_MS).toBe(1_000)

    // The drop is a record, not a log line: it is in the ledger and in the count.
    const dropped = hub.ingest.droppedEvents()
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toMatchObject({
      stage: 'store',
      reason: 'store-failed',
      harness: 'opencode',
      eventName: 'permission.asked',
    })
    expect(hub.ingest.stats().dropped).toBe(1)
    // Exactly seven fields, none of which can hold a value from the request beyond
    // the two closed tokens the classifier has already bounded.
    expect(Object.keys(dropped[0] ?? {}).sort()).toEqual([
      'at',
      'elapsedMs',
      'eventName',
      'harness',
      'reason',
      'stage',
      'variant',
    ])
    // The event that was stored before the failure is untouched, and the one that
    // could not be stored is nowhere in the log.
    expect(observeLog(hub).readEventHistory({ limit: 10 })).toHaveLength(1)
  })

  it('keeps serving reads after a dropped event, and drops each one it is told about', async () => {
    const hub = await startFixtureHub()
    hub.store.close()

    await post(hub, blockBody({ transitionId: 'block-a' }))
    await post(hub, blockBody({ transitionId: 'block-b' }))
    // Both posts were recorded as dropped.
    expect(hub.ingest.stats().dropped).toBe(2)
    expect(hub.ingest.droppedEvents()).toHaveLength(2)

    // A wedged log must not take the hub down with it, and health is how a developer
    // finds out anything is wrong: it reports the database as unreadable rather than
    // failing, which is the distinction `doctor` needs between "hub is down" and "hub
    // is up and its log is broken" (HC-FR-07).
    const health = (await get(hub, '/api/health')).json<{
      status: string
      database: { readable: boolean; pendingCount: number | null }
    }>()
    expect(health.status).toBe('degraded')
    expect(health.database.readable).toBe(false)
    expect(health.database.pendingCount).toBeNull()
    // A read route that cannot read answers a contentless 500 rather than a body
    // carrying the database's message or a stack trace. The store being unreadable is
    // reported through health, not through a payload.
    const pending = await get(hub, '/api/pending')
    expect(pending.status).toBe(500)
    expect(pending.json<RefusalBody>().error).toBe('internal-error')
    expect(pending.text).not.toMatch(/SQLITE|at Object|\.ts:\d/)
    // And the hub is still accepting and refusing events rather than wedged: a third
    // post is refused the same way and recorded the same way, and the count is not the
    // list's length, so a bounded tail can never under-report.
    expect((await post(hub, blockBody({ transitionId: 'block-c' }))).status).toBe(503)
    expect(hub.ingest.stats().dropped).toBe(3)
    expect(hub.ingest.droppedEvents()).toHaveLength(3)
  })

  it('refuses a new event once the hub is closing, rather than half-storing it', async () => {
    const hub = await startFixtureHub()
    await hub.ingest.close()

    const response = await post(hub, blockBody())

    // HC-FR-10: a hub that is shutting down stops accepting events. The refusal is a
    // dropped event rather than a client error, because from the caller's side the
    // difference is "your signal was wrong" against "we did not take it".
    expect(response.status).toBe(503)
    expect(response.json<RefusalBody>().dropped).toBe(true)
    expect(hub.ingest.stats().dropped).toBe(1)
    // And nothing was stored: the pipeline refused before the store was reached.
    expect(observeLog(hub).readEventHistory({ limit: 10 })).toHaveLength(0)
  })

  it('reports a store step that overran the bound instead of hiding it', async () => {
    // A synchronous driver cannot be interrupted, so the watchdog measures rather than
    // cancels. What it must never do is lie: the event *is* stored, so the answer is
    // still a success, and the overrun is reported for the operator (APX-FR-02).
    const base = openScratchStore('agent-ping-slow-')
    const diagnostics: string[] = []
    const service = createIngestService({
      store: {
        ...base,
        insertEvent: (event) => {
          // A real wait, so the measured elapsed time is real. 40 ms is past a 20 ms
          // bound and far below anything a caller would notice.
          const until = Date.now() + 40
          while (Date.now() < until) {
            // Spin.
          }
          return base.insertEvent(event)
        },
      },
      storeTimeoutMs: 20,
      onDiagnostic: (message) => diagnostics.push(message),
    })

    const result = await service.submit(asSignal(blockBody()))

    expect(result.ok).toBe(true)
    expect(service.stats().storeOverruns).toBe(1)
    expect(service.stats().slowestStoreMs).toBeGreaterThanOrEqual(40)
    expect(diagnostics.join('\n')).toMatch(/past the 20 ms bound/)
    // Reported as slow, never recorded as a drop: nothing was dropped, because the
    // event is in the log.
    expect(service.droppedEvents()).toHaveLength(0)
    expect(base.readEventHistory({ limit: 10 })).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The delivery bound
// ---------------------------------------------------------------------------

describe('delivery is fire-and-forget with a bounded timeout and no retry', () => {
  it('abandons a delivery that exceeds its bound, once, and records it', async () => {
    let attempts = 0
    const hub = await startFixtureHub({
      ingest: {
        deliveryWired: true,
        deliveryTimeoutMs: 20,
        delivery: (): Promise<void> => {
          attempts += 1
          // Never settles: the port that hangs is the failure the bound exists for.
          return new Promise<void>(() => undefined)
        },
      },
    })

    const startedAt = Date.now()
    const response = await post(hub, blockBody())

    // The caller was answered without waiting for the delivery that will never end.
    expect(response.status).toBe(202)
    expect(hub.ingest.droppedEvents()).toHaveLength(0)
    await hub.ingest.idle()
    const elapsed = Date.now() - startedAt

    // Exactly one attempt: a bound that retried would be a retry storm against a
    // failing notifier (APX-CON-10).
    expect(attempts).toBe(1)
    // And the bound is a bound, measured rather than taken on trust: a delivery that
    // never settles is abandoned promptly, so a wedged notifier cannot hold the hub -
    // or a shutdown's drain - open for as long as it likes.
    expect(elapsed, `the delivery was abandoned after ${elapsed} ms`).toBeLessThan(1_000)
    expect(hub.ingest.stats().deliveries).toMatchObject({ attempted: 1, timedOut: 1, failed: 0 })
    expect(hub.ingest.droppedEvents()[0]).toMatchObject({ stage: 'delivery', reason: 'delivery-timeout' })
    // The event is still stored and still pending: a failed delivery is a missing
    // notification, never a lost block.
    expect(observeLog(hub).readPending()).toHaveLength(1)
    // And the bound is the documented one, not an inline literal.
    expect(INGEST_DELIVERY_TIMEOUT_MS).toBe(2_000)
  })

  it('records a delivery that throws, and keeps the stored event', async () => {
    const hub = await startFixtureHub({
      ingest: {
        deliveryWired: true,
        delivery: (): void => {
          throw new Error('the notification centre refused the toast')
        },
      },
    })

    await post(hub, blockBody())
    await hub.ingest.idle()

    expect(hub.ingest.stats().deliveries).toMatchObject({ attempted: 1, failed: 1 })
    expect(hub.ingest.droppedEvents()[0]).toMatchObject({
      stage: 'delivery',
      reason: 'delivery-failed',
    })
    expect(observeLog(hub).readPending()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The mutating surface
// ---------------------------------------------------------------------------

describe('ingest appends, and nothing else on this route can change anything', () => {
  it('registers one appending route, and it is not the control surface', () => {
    expect(INGEST_ROUTES).toHaveLength(1)
    const [route] = INGEST_ROUTES
    expect(route?.method).toBe('POST')
    expect(route?.pattern).toBe('/api/ingest')
    expect(route?.mutation).toBe('ingest-append')
    // The control surface is the ack route, and it is HC-4's. Ingest is not it, and
    // the two are separate entries in the mutating set for exactly that reason: one
    // appends, one changes an existing record (APX-CON-08, ADR-002).
    expect(MUTATING_ROUTE).toBe('POST /api/ack/:eventId')
    expect([...MUTATING_ROUTES]).toEqual(['POST /api/ack/:eventId', 'POST /api/ingest'])
  })

  it('refuses every other method and path on /api/ingest, storing nothing', async () => {
    const hub = await startFixtureHub()
    const before = countsOf(hub)

    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const) {
      const response = await call(hub.origin, { method })
      expect([404, 405], `${method} answered ${response.status}`).toContain(response.status)
    }
    // And paths that merely look like it are not served either.
    for (const pathname of ['/api/ingest/something', '/api/ingested', '/api/ingest/extra']) {
      const response = await call(hub.origin, { pathname })
      expect([404, 405], `${pathname} answered ${response.status}`).toContain(response.status)
    }
    expect(countsOf(hub)).toEqual(before)
  })

  it('serves a trailing slash as the same route, and stores nothing for it', async () => {
    // The router filters empty segments, so `/api/ingest/` reaches the same handler as
    // `/api/ingest` - the tolerance every HTTP router has, and the same one the read
    // routes have. It is asserted rather than left unremarked because this is a
    // mutating path and a second accepted spelling of one is a thing to know about.
    const hub = await startFixtureHub()
    const before = countsOf(hub)

    const response = await call(hub.origin, { pathname: '/api/ingest/' })

    // The route answered - it is the same handler - and refused the empty body as a
    // client error, which is the point: two spellings, one route, nothing stored.
    expect(response.status).toBe(400)
    expect(response.json<RefusalBody>().error).toBe('not-json')
    expect(countsOf(hub)).toEqual(before)
  })

  it('has no surface that could steer, interrupt, prompt or approve anything', () => {
    // Asserted over the route itself rather than over a comment: a route whose name or
    // path is shaped like a control would be a reviewer finding, and this is the
    // assertion that makes it a test failure instead (APX-CON-08).
    const forbidden = /spawn|steer|interrupt|prompt|approve|resume|kill|send|control|execute|input|keypress/i
    for (const route of INGEST_ROUTES) {
      expect(`${route.method} ${route.pattern} ${route.name}`).not.toMatch(forbidden)
    }
    const registry = new RouteRegistry<HubServices>()
    registry.registerAll(INGEST_ROUTES)
    expect(registry.signatures()).toEqual(['POST /api/ingest'])
    // And the other half: even if a field were named that, nothing acts on it - a
    // control-shaped field in a body is refused as unrecognised, which is in the
    // refusal table above.
    const validated = validateIngestSignal(
      { ...blockBody(), approve: 'yes', interrupt: true },
      'now',
    )
    expect(validated.ok).toBe(false)
  })

  it('refuses a registration that claims a mutation it is not', () => {
    const registry = new RouteRegistry<HubServices>()
    // Claiming the ack mutation on a path that is not the ack route is refused at
    // registration, so a second control surface cannot be added quietly.
    expect(() =>
      registry.register({
        method: 'POST',
        pattern: '/api/approve',
        name: 'ingest.approve',
        mutation: 'ack-only',
        handle: () => undefined,
      }),
    ).toThrow(/only mutating route/)
    // And so is claiming the append on a path that is not the ingest route.
    expect(() =>
      registry.register({
        method: 'POST',
        pattern: '/api/events',
        name: 'ingest.append',
        mutation: 'ingest-append',
        handle: () => undefined,
      }),
    ).toThrow(/only appending route/)
    // A read-only route that answers a mutating method is refused too, which is the
    // failure a count comparison would only catch after it had written something.
    expect(() =>
      registry.register({
        method: 'DELETE',
        pattern: '/api/events',
        name: 'read.purge',
        mutation: 'read-only',
        handle: () => undefined,
      }),
    ).toThrow(/read-only/)
  })
})

// ---------------------------------------------------------------------------
// The wire schema, as data
// ---------------------------------------------------------------------------

describe('the closed wire schema', () => {
  it('declares exactly the nine fields a signal may carry', () => {
    // An exact list. A tenth field has to be added here deliberately, and a field the
    // classifier requires and this schema omits would be one a caller can never send.
    expect([...INGEST_SIGNAL_FIELD_NAMES].sort()).toEqual([
      'eventName',
      'harness',
      'measurements',
      'occurredAt',
      'repoFullPath',
      'sessionId',
      'transitionId',
      'turnWork',
      'variant',
    ])
    // The fields the hub decides for itself are not among them, and a client that
    // sends one is refused rather than ignored (see the refusals above).
    for (const hubOwned of ['class', 'subtype', 'dedupeKey', 'receivedAt', 'repoShortName']) {
      expect(INGEST_SIGNAL_FIELD_NAMES).not.toContain(hubOwned)
    }
    // Only five are required; the two optional identifiers are the ones a signal that
    // produces no event has no use for.
    const required = INGEST_SIGNAL_FIELDS.filter((field) => field.required).map((field) => field.name)
    expect(required.sort()).toEqual(['eventName', 'harness', 'occurredAt', 'repoFullPath', 'sessionId'])
  })

  it('validates a well-formed signal into the classifier input, stamping the hub clock', () => {
    const validated = validateIngestSignal(blockBody(), '2026-09-26T09:00:01.000Z')

    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    // The stamp is the hub's, and no caller value reached the signal.
    expect(validated.signal.receivedAt).toBe('2026-09-26T09:00:01.000Z')
    expect(validated.signal.harness).toBe('opencode')
    expect(validated.signal.transitionId).toBe('block-7')
    expect(validated.signal.occurredAt).toBe(OCCURRED_AT)
    // Optional fields stay absent rather than arriving as undefined, because the
    // classifier distinguishes "no variant" from a variant that is the empty string.
    expect(Object.hasOwn(validated.signal, 'variant')).toBe(false)
    expect(Object.hasOwn(validated.signal, 'turnWork')).toBe(false)
  })

  it('reports every undeclared field and every missing required field in one pass', () => {
    const validated = validateIngestSignal({ eventName: 'permission.asked', prompt: 'x', output: 'y' }, 'now')

    expect(validated.ok).toBe(false)
    if (validated.ok) return
    expect(validated.issues).toEqual(
      expect.arrayContaining([
        { path: 'harness', code: 'missing-field' },
        { path: 'sessionId', code: 'missing-field' },
        { path: 'repoFullPath', code: 'missing-field' },
        { path: 'occurredAt', code: 'missing-field' },
        { path: 'prompt', code: 'unrecognised-field' },
        { path: 'output', code: 'unrecognised-field' },
      ]),
    )
  })

  it('accepts every known harness and refuses every other name', () => {
    for (const harness of KNOWN_HARNESSES) {
      // A `copilot-cli` signal with a documented hook validates here; one with a name
      // the classifier has no row for is refused there, which is the division of
      // labour between the wire schema and the classifier.
      expect(validateIngestSignal(blockBody({ harness }), 'now').ok, harness).toBe(true)
    }
    expect(INGEST_KNOWN_HARNESSES).toEqual([...KNOWN_HARNESSES])
    for (const harness of ['claude-code', 'OpenCode', 'opencode ', '', 'cursor']) {
      expect(validateIngestSignal(blockBody({ harness }), 'now').ok, harness).toBe(false)
    }
  })

  it('checks turnWork and measurements key by key, with no extras either way', () => {
    const bad = validateIngestSignal(
      {
        ...idleBody('i', true),
        turnWork: { toolCall: 'yes', fileEdit: false, todoUpdate: false, count: 3 },
      },
      'now',
    )
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.issues).toEqual(
      expect.arrayContaining([
        { path: 'turnWork.toolCall', code: 'wrong-type' },
        { path: 'turnWork.count', code: 'unrecognised-field' },
      ]),
    )

    const measurements = validateIngestSignal(
      { ...blockBody(), measurements: { durationMs: 45_000, tokensUsed: 'lots', words: 900 } },
      'now',
    )
    expect(measurements.ok).toBe(false)
    if (measurements.ok) return
    expect(measurements.issues).toEqual(
      expect.arrayContaining([
        { path: 'measurements.tokensUsed', code: 'wrong-type' },
        { path: 'measurements.words', code: 'unrecognised-field' },
      ]),
    )

    const good = validateIngestSignal(
      { ...blockBody(), measurements: { durationMs: 45_000, tokensUsed: 60_000, attempt: 2 } },
      'now',
    )
    expect(good.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The answer tables, as data
// ---------------------------------------------------------------------------

describe('the refusal tables are total and quote no value', () => {
  it('gives every refusal code a status, and none a 2xx', () => {
    for (const [code, status] of Object.entries(INGEST_REFUSAL_STATUS)) {
      expect(status, code).toBeGreaterThanOrEqual(400)
      expect(status, code).toBeLessThan(600)
      // The five caller faults are 4xx; the hub's own two are not. A harness that
      // cannot tell them apart writes the wrong breadcrumb.
      expect(status < 500, code).toBe(isCallerFault(code as IngestRefusalCode))
    }
    expect(INGEST_REFUSAL_STATUS['store-failed']).toBe(503)
    expect(INGEST_REFUSAL_STATUS['internal-error']).toBe(500)
    expect(INGEST_REFUSAL_STATUS['unknown-harness']).toBe(422)
    expect(INGEST_REFUSAL_STATUS['unidentifiable-block']).toBe(422)
  })

  it('gives every error code a status and a fixed sentence with nothing caller-chosen in it', () => {
    // The transport half, and the wire half: together they are every error the route
    // can answer with besides a refusal from the pipeline.
    for (const [code, status] of Object.entries(INGEST_TRANSPORT_STATUS)) {
      expect(status, code).toBeGreaterThanOrEqual(400)
      expect(INGEST_ERROR_CODES, code).toContain(code)
    }
    expect(INGEST_TRANSPORT_STATUS['body-too-large']).toBe(413)
    expect(INGEST_TRANSPORT_STATUS['body-timeout']).toBe(408)
    expect(INGEST_TRANSPORT_STATUS['not-json']).toBe(400)

    for (const code of Object.keys(INGEST_REFUSAL_DETAIL) as IngestRefusalCode[]) {
      const detail = INGEST_REFUSAL_DETAIL[code]
      expect(detail.length, code).toBeGreaterThan(20)
      // No value from any request: the sentinels a test posts are recognisable, and
      // every sentence here is a literal in the source file.
      expect(detail, code).not.toContain(SESSION)
      expect(detail, code).not.toContain('claude-code')
      expect(detail, code).not.toMatch(/permission\.asked|opencode/)
    }
  })

  it('refuses a body the hub cannot parse without throwing out of the route', async () => {
    // A route that threw would reach the listener's catch and become a contentless
    // 500, which is right for an unanticipated fault and wrong for a bad request.
    const hub = await startFixtureHub()
    for (const body of ['', '{', 'null', '[]', '"a string"', '12', 'true']) {
      const response = await call(hub.origin, { body })
      expect(response.status, body).toBeGreaterThanOrEqual(400)
      expect(response.status, body).toBeLessThan(500)
    }
    // The hub is still serving afterwards: one malformed body took nothing down.
    expect((await get(hub, '/api/health')).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// The performance budget
// ---------------------------------------------------------------------------

describe('the local ingest budget (APX-CON-11)', () => {
  it('keeps the p95 of a real ingest burst inside 50 ms', async () => {
    const hub = await startFixtureHub()

    // Sixty distinct events through the real route over a real socket. Distinct
    // transition identifiers, because posting one event sixty times would measure the
    // duplicate path rather than the write path.
    const samples: number[] = []
    for (let index = 0; index < 60; index += 1) {
      const body = {
        ...blockBody(),
        transitionId: `block-${index}`,
        occurredAt: new Date(Date.UTC(2026, 8, 26, 9, 0, index)).toISOString(),
      }
      const startedAt = performance.now()
      const response = await post(hub, body)
      samples.push(performance.now() - startedAt)
      expect(response.status, `post ${index}`).toBe(202)
    }
    samples.sort((left, right) => left - right)
    const at = (quantile: number): number =>
      samples[Math.min(samples.length - 1, Math.floor(samples.length * quantile))] ?? 0
    const p50 = at(0.5)
    const p95 = at(0.95)
    const worst = samples.at(-1) ?? 0

    // Reported as well as asserted, so the observed numbers are visible in the test
    // output rather than living only in a threshold. `process.stdout.write` rather than
    // `console.info`, because this runner does not forward the console to the report.
    process.stdout.write(
      `[ingest] local ingest over a real socket: p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, ` +
        `max ${worst.toFixed(2)} ms over ${samples.length} posts (budget ${INGEST_P95_BUDGET_MS} ms); ` +
        `slowest store step seen by the hub ${hub.ingest.stats().slowestStoreMs} ms\n`,
    )
    expect(p95, `ingest p95 was ${p95.toFixed(2)} ms`).toBeLessThanOrEqual(INGEST_P95_BUDGET_MS)
    // The budget is the documented one, not whatever the measurement came out at.
    expect(INGEST_P95_BUDGET_MS).toBe(50)
    // Sixty posts, sixty rows, and no dedupe key collapsed: the measurement is of the
    // write path and not of a path that short-circuits.
    expect(observeLog(hub).readEventHistory({ limit: 500 })).toHaveLength(60)
    expect(observeLog(hub).readPending()).toHaveLength(60)
  })
})

// ---------------------------------------------------------------------------
// The service, driven directly
// ---------------------------------------------------------------------------

describe('the pipeline as a unit', () => {
  it('answers every outcome exactly once and never throws out of submit', async () => {
    const store = openScratchStore('agent-ping-unit-')
    const service = createIngestService({ store })

    const block = await service.submit(asSignal(blockBody()))
    expect(block.ok && block.outcome).toBe('pending-created')
    const replay = await service.submit(asSignal(blockBody()))
    expect(replay.ok && replay.outcome).toBe('duplicate')
    const suppressed = await service.submit(asSignal(idleBody('i-1', false)))
    expect(suppressed.ok && suppressed.reason).toBe('idle-after-nothing')
    const refused = await service.submit(asSignal(blockBody({ harness: 'nope' })))
    expect(!refused.ok && refused.code).toBe('unknown-harness')

    expect(service.stats()).toMatchObject({
      submitted: 4,
      stored: 1,
      duplicates: 1,
      suppressed: 1,
      dropped: 0,
    })
    // Nothing has been delivered, because `submit` alone never starts a delivery: the
    // route answers first and starts one after. That is the seam, and it is why the
    // two halves of the order are separately testable.
    expect(service.stats().deliveries.attempted).toBe(0)
    // A caller fault recorded no drop: nothing was ever going to be stored, so calling
    // it a dropped event would overstate the loss.
    expect(service.droppedEvents()).toHaveLength(0)

    // And with the port started, a build that has no notifier yet counts the delivery
    // it did not make rather than reporting it as made (APX-FR-02).
    service.startDelivery(block)
    expect(service.stats().deliveries).toEqual({
      attempted: 1,
      delivered: 0,
      failed: 0,
      timedOut: 0,
      notWired: 1,
    })
  })

  it('drops the event when the store throws, and does not carry the database message forward', async () => {
    const base = openScratchStore('agent-ping-broken-')
    const service = createIngestService({
      store: {
        ...base,
        insertEvent: () => {
          throw new Error('SQLITE_IOERR: the disk went away at /home/dev/.local/share/agent-ping')
        },
      },
    })

    const result = await service.submit(asSignal(blockBody()))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('store-failed')
    // The database's own message names the file and the statement; an answer or a
    // response body built from one would leak the machine's directory layout
    // (APX-FR-01).
    expect(result.operatorDetail).not.toMatch(/SQLITE|disk went away|home\/dev/)
    expect(service.droppedEvents()).toHaveLength(1)
    expect(service.droppedEvents()[0]?.reason).toBe('store-failed')
  })

  it('bounds the drop ledger without losing the count', async () => {
    const base = openScratchStore('agent-ping-ledger-')
    const service = createIngestService({
      store: {
        ...base,
        insertEvent: () => {
          throw new Error('nope')
        },
      },
      maxDroppedRecords: 3,
    })

    for (let index = 0; index < 5; index += 1) {
      await service.submit(asSignal(blockBody({ transitionId: `block-${index}` })))
    }

    // A bounded tail, and a count that is not the tail's length: five events were
    // dropped even though only three records are kept.
    expect(service.droppedEvents()).toHaveLength(3)
    expect(service.stats().dropped).toBe(5)
  })

  it('drains in-flight deliveries on close, is idempotent, and refuses events afterwards', async () => {
    const store = openScratchStore('agent-ping-close-')
    const order: string[] = []
    const service = createIngestService({
      store,
      deliveryWired: true,
      delivery: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push('delivered')
      },
    })

    await service.submit(asSignal(blockBody()))
    service.startDelivery(await service.submit(asSignal(blockBody({ transitionId: 'b2' }))))
    await service.close()

    // The drain is what makes a shutdown safe: a delivery in flight is finished rather
    // than abandoned, because the notifier is HC-5's and may still be recording.
    expect(order).toEqual(['delivered'])
    await expect(service.close()).resolves.toBeUndefined()
    // After closing, a new event is refused rather than half-stored (HC-FR-10).
    const after = await service.submit(asSignal(blockBody({ transitionId: 'b3' })))
    expect(after.ok).toBe(false)
  })

  it('delivers only a freshly stored event, whatever the outcome was', () => {
    // The seam, driven directly, so the rule is stated once and asserted once: a
    // replay, a suppression and a resolution are all things that stored nothing new,
    // and none of them may reach a notifier.
    const base = openScratchStore('agent-ping-seam-')
    const calls: DeliveryRequest[] = []
    const service = createIngestService({
      store: base,
      deliveryWired: true,
      delivery: (delivery): void => void calls.push(delivery),
    })

    const first = service.submit(asSignal(blockBody()))
    const second = service.submit(asSignal(blockBody()))
    const third = service.submit(asSignal(idleBody('i-1', false)))
    const fourth = service.submit(asSignal(resolutionBody('block-7')))
    const refused = service.submit(asSignal(blockBody({ harness: 'nope' })))

    // Nothing has been delivered yet, because nothing has been asked to: the route
    // starts a delivery after it has answered, and this test has not answered anyone.
    expect(calls).toHaveLength(0)

    return Promise.all([first, second, third, fourth, refused]).then(([one, two, three, four, five]) => {
      service.startDelivery(one)
      service.startDelivery(two)
      service.startDelivery(three)
      service.startDelivery(four)
      service.startDelivery(five)
      // One delivery: the first block. A replay, an idle turn, a resolution and a
      // refused signal are all nothing-new (HC-FR-08).
      expect(calls).toHaveLength(1)
      expect(calls[0]?.event.dedupeKey).toBe(`opencode:${SESSION}:block-7`)
    })
  })
})

// ---------------------------------------------------------------------------
// The sources themselves
// ---------------------------------------------------------------------------

describe('the ingest sources hold the properties the tests exercise', () => {
  const sourceOf = (...parts: string[]): string =>
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', ...parts), 'utf8')
  const serviceSource = sourceOf('src', 'hub', 'ingest-service.ts')
  const routeSource = sourceOf('src', 'hub', 'routes', 'ingest.ts')

  it('reaches the log only through the lifecycle, never through a query', () => {
    // The store's closed API is how a content column would first be read out of this
    // product. "No SQL here" is asserted from the source because a test that proved it
    // by reading every row would have to invent the query surface it is checking the
    // absence of.
    expect(serviceSource).not.toMatch(/\b(SELECT|INSERT INTO|UPDATE |DELETE FROM|DROP )\b/)
    // The driver is named in the prose that explains why it is not reached, so the
    // assertion is about importing it rather than about the word appearing.
    expect(serviceSource).not.toMatch(/from ['"](better-sqlite3|node:sqlite)['"]|require\(['"]node:sqlite/)
    expect(serviceSource).not.toMatch(/createPendingLifecycle\(\s*options\.store\.db/)
  })

  it('calls nothing off the machine and opens no outward connection', () => {
    for (const source of [serviceSource, routeSource]) {
      expect(source).not.toMatch(/\bfetch\(|https?\.request|node:dgram|net\.connect/)
      // APX-CON-12: no telemetry leaves the machine. The only socket in this product
      // is the loopback listener, and neither of these files is it.
      expect(source).not.toMatch(/child_process|execFile|spawn\(/)
      // agent-ping is a sidecar: it observes agent processes and owns none of them
      // (APX-CON-03).
      expect(source).not.toMatch(/process\.kill|SIGTERM|SIGKILL/)
    }
  })

  it('keeps the route free of any harness action or platform notifier', () => {
    // Delivery crosses a function boundary; the boundary is this task's to define and
    // HC-5's to fill, and the notifier itself belongs to notification-engineer
    // (NT-2, HC-5).
    expect(routeSource).not.toMatch(/notify|Notification|tray|Toast|osascript|terminal-notifier/)
    expect(routeSource).not.toMatch(/keypress|approve|steer|interrupt/)
    // And the service only ever calls a port it was handed.
    expect(serviceSource).toMatch(/type DeliveryPort/)
    expect(serviceSource).toMatch(/await delivery\(request\)/)
  })
})
