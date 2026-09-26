// The delivery policy, the restart replay, and what `doctor` is told about both
// (HC-5, HC-FR-07, HC-FR-08, APX-FR-02, APX-CON-10, PRD 10).
//
//   npm test -- tests/hub/delivery.test.ts
//
// THE ACCEPTANCE CRITERIA, AND WHERE EACH IS PROVEN
//
//   1. "A test asserts one classified event produces exactly one delivery attempt."
//      Two halves, because "exactly one" has two failure modes. Over a real socket
//      against a hub started by the real main entry point: one posted block becomes
//      one stored event and one notifier call, with the request's fields asserted one
//      by one. And on the policy itself, driven directly: a second attempt for the
//      same event is refused without reaching the notifier, and recorded as a
//      suppression rather than as a second toast (NT-FR-08).
//
//   2. "A test kills the hub with an unacknowledged pending item, restarts it, and
//      asserts the item is replayed exactly once into the pipeline."
//      Two real operating-system processes. The first is started, posts a block over a
//      real loopback socket, and is then SIGKILLed - hard, with no shutdown, so the
//      recovery is a restart and not a graceful exit. The second starts over the same
//      state directory, and the evidence is a file both processes appended to: one line
//      for the live delivery and exactly one more for the replay, carrying the same
//      row key. A third process proves the item is still pending and is replayed once
//      again rather than being forgotten or duplicated.
//
//   3. "A test asserts health reports database, server and delivery status, and that a
//      forced notifier failure is visible there."
//      The notifier is made to fail by a function that throws, in a real hub, with a
//      real block in the log. Health reports `degraded` in its delivery section, names
//      the row, and the same failure is visible in the ingest pipeline's own drop
//      ledger - which is the point of the adapter: one failure, three places a doctor
//      run could look, none of them silent (APX-FR-02, ADR-010, NT-FR-09).
//
// Clean shutdown is a different claim about a different process, and it is proven in
// tests/hub/lifecycle.test.ts.
//
// AROUND THOSE FOUR, the properties that make them worth anything:
//
//   - The decision is a table, and the table is enumerated here rather than restated:
//     every combination of source, wiring and attempt order, and every outcome/reason
//     pair, is checked against the code's own unions.
//   - A failure is never silent and never retried: a notifier that throws, and a
//     notifier that never settles, each produce exactly one record, one count and one
//     health verdict, and the block stays stored and pending either way.
//   - The delivery path writes nothing. Pending, event and session counts are compared
//     through a second connection around every attempt, because a policy that could
//     change a record would be a second control surface (APX-CON-08).
//   - The notification request is the product's content-free shape, asserted field by
//     field: no prompt, no tool name, no path beyond what the log already holds.
//   - Every unacknowledged pending item is replayed, none twice, oldest first, in
//     bounded concurrency - asserted with a real set of pending items rather than with
//     one.
//   - A hub with no notifier behind the port says `not-wired` rather than reporting a
//     delivery, which must never be mistaken for a delivered run. Since NT-1 the
//     composition root wires the platform notifier by default, so the suite asks for
//     that state explicitly where it is the thing under test.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { startHub, type RunningHub } from '@/main/index'
import { openEventStore, type EventStore } from '@/storage/eventStore'
import {
  DELIVERY_ATTEMPT_TIMEOUT_MS,
  DELIVERY_DECISIONS,
  DELIVERY_MAX_OUTCOME_RECORDS,
  DELIVERY_OUTCOME_REASONS,
  DELIVERY_REPLAY_CONCURRENCY,
  DeliveryFailedError,
  createDeliveryPolicy,
  decideDelivery,
  type DeliveryAttemptRecord,
  type DeliveryDecisionKey,
  type DeliveryReason,
  type Notifier,
  type NotificationRequest,
} from '@/hub/delivery'
import { ACK_ROUTES } from '@/hub/routes/ack'
import { INGEST_ROUTES } from '@/hub/routes/ingest'
import { READ_ROUTES, type HealthPayload, type HubServices } from '@/hub/routes/read'
import { STREAM_ROUTES } from '@/hub/routes/stream'
import { MUTATING_ROUTES, RouteRegistry } from '@/hub/server'
import { readRuntimeFile } from '@/hub/runtime-file'
import type { DeliveryRequest } from '@/hub/ingest-service'
import {
  RESTART_REPLAY_PORT_BASE,
  startRealHub,
  stopStrayHubs,
  type RealHub,
} from './fixtures/hub-process'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_PATH = '/home/dev/Projects/agent-ping'
const SESSION = 'ses_delivery_01'
const OCCURRED_AT = '2026-09-26T09:00:00.000Z'

const temporaryDirectories: string[] = []
const openHubs: RunningHub[] = []
const openStores: EventStore[] = []

function temporaryDirectory(prefix = 'agent-ping-state-'): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  // Before the in-process hubs: a wedged child would hold a port and a runtime file in
  // a directory that is about to be deleted.
  await stopStrayHubs()
  for (const hub of openHubs.splice(0)) {
    await hub.close().catch(() => undefined)
  }
  for (const store of openStores.splice(0)) store.close()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * A hub, started by the real entry point, with a notifier behind the delivery policy.
 *
 * The notifier is the only thing a test injects: it is the notifier boundary (NT-1), and
 * recording what it received is how a test observes an attempt that happened. No
 * delivery is faked, and no lifecycle call is substituted for a real request.
 */
async function startFixtureHub(
  notifier: Notifier | undefined,
  options: Partial<Parameters<typeof startHub>[0]> = {},
): Promise<RunningHub> {
  const hub = await startHub({
    stateDir: temporaryDirectory(),
    dashboardRoot: null,
    // The signal handlers are installed by default and a test hub is not a process that
    // should react to this test runner's signals. tests/hub/lifecycle.test.ts proves
    // the real ones against a real process.
    lifecycle: { installSignals: false },
    ...(notifier === undefined ? {} : { delivery: { notifier } }),
    ...options,
  })
  openHubs.push(hub)
  return hub
}

/** A notifier that records every request it received. */
function recordingNotifier(seen: NotificationRequest[]): Notifier {
  return (request) => {
    seen.push(request)
  }
}

/** A second connection to the log the hub is holding. */
function observeLog(hub: RunningHub): EventStore {
  const store = openEventStore({ filePath: hub.databaseFilePath })
  openStores.push(store)
  return store
}

/** A standalone store, for the unit half of this file. */
function scratchStore(prefix = 'agent-ping-scratch-'): EventStore {
  const store = openEventStore({ filePath: path.join(temporaryDirectory(prefix), 'scratch.db') })
  openStores.push(store)
  return store
}

/** A block in one session: the only class that leaves the app (EL-FR-07). */
function blockBody(transitionId = 'block-1'): Record<string, unknown> {
  return {
    harness: 'opencode',
    eventName: 'permission.asked',
    sessionId: SESSION,
    repoFullPath: REPO_PATH,
    transitionId,
    occurredAt: OCCURRED_AT,
  }
}

/** The harness resolution for a block, which clears its pending item. */
function resolutionBody(transitionId: string): Record<string, unknown> {
  return {
    harness: 'opencode',
    eventName: 'permission.replied',
    sessionId: SESSION,
    repoFullPath: REPO_PATH,
    transitionId,
    occurredAt: OCCURRED_AT,
  }
}

/** An idle transition that recorded no work, which stores nothing at all. */
function idleBody(): Record<string, unknown> {
  return {
    harness: 'opencode',
    eventName: 'session.status',
    variant: 'idle',
    sessionId: SESSION,
    repoFullPath: REPO_PATH,
    transitionId: 'idle-1',
    occurredAt: OCCURRED_AT,
    turnWork: { toolCall: false, fileEdit: false, todoUpdate: false },
  }
}

interface Fetched {
  readonly status: number
  readonly text: string
  json<T = unknown>(): T
}

interface CallInit {
  readonly method: string
  readonly pathname: string
  readonly body?: string
}

/**
 * One request over a real socket, one connection.
 *
 * Deliberately `node:http` with `agent: false` and not `fetch`: these tests reuse one
 * loopback origin, and a pooled connection opened against a hub that has since closed
 * would be handed to the next request - which would turn a restart assertion into a
 * test about connection pooling.
 */
function call(origin: string, init: CallInit): Promise<Fetched> {
  const { hostname, port } = new URL(origin)
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: hostname,
        port,
        path: init.pathname,
        method: init.method,
        headers: {
          'content-type': 'application/json',
          ...(init.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(init.body)) }),
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

/** Post one signal to a hub in this process. */
async function post(hub: RunningHub, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await call(hub.origin, {
    method: 'POST',
    pathname: '/api/ingest',
    body: JSON.stringify(body),
  })
  return { status: response.status, body: response.json<Record<string, unknown>>() }
}

/** A GET to a read route of a hub in this process. */
async function get(hub: RunningHub, pathname: string): Promise<Fetched> {
  return call(hub.origin, { method: 'GET', pathname })
}

/** The health payload of a hub in this process, asserted to have arrived. */
async function healthOf(hub: RunningHub): Promise<HealthPayload> {
  const response = await get(hub, '/api/health')
  expect(response.status).toBe(200)
  return response.json<HealthPayload>()
}

/** A delivery request for one stored block, for the unit half. */
function requestFor(
  store: EventStore,
  className: 'needs-you' | 'finished' | 'fyi' = 'needs-you',
): DeliveryRequest {
  const stored = store.insertEvent({
    harness: 'opencode',
    sessionId: SESSION,
    repoShortName: 'agent-ping',
    repoFullPath: REPO_PATH,
    rawEventType: 'permission.asked',
    class: className,
    subtype: null,
    occurredAt: OCCURRED_AT,
    receivedAt: OCCURRED_AT,
    dedupeKey: `opencode:${SESSION}:unit-${randomSuffix()}`,
  })
  return { event: stored.event, class: className, pendingCount: store.readPending().length }
}

let unitCounter = 0
function randomSuffix(): string {
  unitCounter += 1
  return `unit-${unitCounter}`
}

/** Seed `count` distinct pending blocks directly into the log, oldest first. */
function seedPendingBlocks(store: EventStore, count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) =>
    store.insertEvent({
      harness: 'opencode',
      sessionId: `${SESSION}-${index}`,
      repoShortName: 'agent-ping',
      repoFullPath: REPO_PATH,
      rawEventType: 'permission.asked',
      class: 'needs-you',
      subtype: null,
      occurredAt: new Date(Date.parse(OCCURRED_AT) + index * 1_000).toISOString(),
      receivedAt: OCCURRED_AT,
      dedupeKey: `opencode:${SESSION}-${index}:seed-${index}`,
    }).event.eventId,
  )
}

// ---------------------------------------------------------------------------
// The decision table, as data
// ---------------------------------------------------------------------------

describe('the delivery decision table', () => {
  it('carries every combination of source, wiring and attempt order', () => {
    // Eight cells, written out rather than derived, so a fourth input is a compile
    // error in the table rather than a branch nobody reviewed (the same reasoning as
    // PENDING_TRANSITION_OUTCOMES in src/domain/pending.ts).
    const expected: readonly DeliveryDecisionKey[] = [
      'event:wired:first',
      'event:wired:repeat',
      'event:unwired:first',
      'event:unwired:repeat',
      'restart-replay:wired:first',
      'restart-replay:wired:repeat',
      'restart-replay:unwired:first',
      'restart-replay:unwired:repeat',
    ]
    expect(Object.keys(DELIVERY_DECISIONS).sort()).toEqual([...expected].sort())

    // Exactly-once is the table's shape rather than a rule in a comment: every
    // `repeat` is a skip whatever the wiring (NT-FR-08, HC-FR-08).
    for (const key of expected) {
      if (key.endsWith(':repeat')) {
        expect(DELIVERY_DECISIONS[key].kind, key).toBe('skip')
        expect(DELIVERY_DECISIONS[key].reason, key).toBe('already-delivered-this-run')
      }
    }
    // And an unwired hub never reports a delivery, which is the one thing this product
    // must not do (APX-FR-02). A repeat of an unwired attempt is still the stronger
    // fact - the run already dealt with this event - which is why its reason is the
    // guard's rather than the wiring's.
    for (const key of expected.filter((candidate) => candidate.includes(':unwired'))) {
      expect(DELIVERY_DECISIONS[key].kind, key).toBe('skip')
      if (key.endsWith(':first')) expect(DELIVERY_DECISIONS[key].reason, key).toBe('not-wired')
    }
  })

  it('answers a caller that asks the same question the policy asked', () => {
    for (const key of Object.keys(DELIVERY_DECISIONS) as DeliveryDecisionKey[]) {
      const [source, wiring, order] = key.split(':')
      expect(
        decideDelivery({
          source: source as 'event',
          wired: wiring === 'wired',
          deliveredBefore: order === 'repeat',
        }),
        key,
      ).toEqual(DELIVERY_DECISIONS[key])
    }
  })

  it('gives every outcome a reason, and every reason an outcome', () => {
    // A record is always explainable, and a reason that could carry a message is not a
    // reason this product may keep (APX-FR-01).
    for (const [outcome, reasons] of Object.entries(DELIVERY_OUTCOME_REASONS)) {
      expect(reasons.length, outcome).toBeGreaterThan(0)
    }
    const everyReason: readonly DeliveryReason[] = Object.values(DELIVERY_OUTCOME_REASONS).flat()
    expect([...new Set(everyReason)].sort()).toEqual([
      'already-delivered-this-run',
      'new-event',
      'not-wired',
      'notifier-failed',
      'notifier-timeout',
      'refused-while-closing',
      'restart-replay',
    ])
    // Only `delivered` carries two reasons, because it is the only outcome with two
    // legitimate sources and they are different facts for `doctor`.
    const shared = everyReason.filter((reason) => DELIVERY_OUTCOME_REASONS.delivered.includes(reason))
    expect([...new Set(shared)].sort()).toEqual(['new-event', 'restart-replay'])
  })
})

// ---------------------------------------------------------------------------
// HC-FR-07/AC1: one classified event, exactly one delivery attempt
// ---------------------------------------------------------------------------

describe('one classified event produces exactly one delivery attempt', () => {
  it('delivers a posted block once, with the request the notifier receives', async () => {
    const seen: NotificationRequest[] = []
    const hub = await startFixtureHub(recordingNotifier(seen))

    const response = await post(hub, blockBody())

    expect(response.status).toBe(202)
    expect(response.body['outcome']).toBe('pending-created')
    await hub.ingest.idle()

    // One attempt, for the event the log actually holds, at the class the classifier
    // decided.
    expect(seen).toHaveLength(1)
    const delivered = seen[0]
    const stored = observeLog(hub).readEventHistory({ limit: 10 })[0]
    expect(delivered?.event.eventId).toBe(stored?.eventId)
    expect(delivered?.class).toBe('needs-you')
    expect(delivered?.source).toBe('event')
    expect(delivered?.pendingCount).toBe(1)
    // The repository's short name and the live origin are the two fields the ingest
    // pipeline's own request cannot carry, and the two a deep link needs (ADR-008,
    // NT-FR-07). The origin is the port that was actually bound, not the preferred one.
    expect(delivered?.repoShortName).toBe('agent-ping')
    expect(delivered?.origin).toBe(hub.origin)

    // Exactly six fields, and the event is the store's own content-free row: no prompt,
    // no tool name, no file content, nothing that could carry a conversation
    // (APX-FR-01, ADR-003).
    expect(Object.keys(delivered ?? {}).sort()).toEqual([
      'class',
      'event',
      'origin',
      'pendingCount',
      'repoShortName',
      'source',
    ])
    expect(Object.keys(delivered?.event ?? {}).sort()).toEqual([
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

    // And the notifier's one call is the policy's one record, counted once.
    expect(hub.delivery.status()).toMatchObject({
      status: 'ok',
      wired: true,
      attempted: 1,
      delivered: 1,
      failed: 0,
      suppressed: 0,
      replayed: 0,
    })
    expect(hub.delivery.outcomes()).toHaveLength(1)
    expect(hub.delivery.outcomes()[0]).toMatchObject({
      eventId: stored?.eventId,
      outcome: 'delivered',
      reason: 'new-event',
      source: 'event',
    })
  })

  it('refuses a second attempt for the same event and records it as a suppression', async () => {
    // The policy's own guard, driven directly rather than through the ingest pipeline:
    // the pipeline already refuses a replay, and a policy that depended on that would
    // have exactly-once as a property of somebody else's code.
    const store = scratchStore()
    const seen: NotificationRequest[] = []
    const policy = createDeliveryPolicy({ store, notifier: recordingNotifier(seen) })
    const request = requestFor(store)

    const first = await policy.deliver(request)
    const second = await policy.deliver(request)

    expect(first.outcome).toBe('delivered')
    expect(second).toMatchObject({ outcome: 'suppressed', reason: 'already-delivered-this-run' })
    // One notifier call. A second toast for one block is the failure NT-FR-08 and
    // ADR-004 both exist to prevent.
    expect(seen).toHaveLength(1)
    expect(policy.status()).toMatchObject({ attempted: 1, delivered: 1, suppressed: 1 })
    // Both attempts are recorded, so the second is visible rather than silent.
    expect(policy.outcomes().map((entry) => entry.outcome)).toEqual(['delivered', 'suppressed'])
  })

  it('refuses a delivery that arrives after the policy has started closing', async () => {
    const store = scratchStore()
    const seen: NotificationRequest[] = []
    const policy = createDeliveryPolicy({ store, notifier: recordingNotifier(seen) })
    const request = requestFor(store)

    await policy.close()
    const attempt = await policy.deliver(request)

    // HC-FR-10's "stops accepting events" reaching the notification path: refused,
    // recorded, and the notifier never called.
    expect(attempt).toMatchObject({ outcome: 'suppressed', reason: 'refused-while-closing' })
    expect(seen).toHaveLength(0)
    expect(policy.status()).toMatchObject({ attempted: 0, suppressed: 1 })
  })
})

// ---------------------------------------------------------------------------
// HC-FR-08: idempotent under replay
// ---------------------------------------------------------------------------

describe('re-posting a stored envelope delivers nothing a second time', () => {
  it('stores one event, leaves the pending count alone, and delivers once', async () => {
    const seen: NotificationRequest[] = []
    const hub = await startFixtureHub(recordingNotifier(seen))
    const store = observeLog(hub)

    const first = await post(hub, blockBody())
    const second = await post(hub, blockBody())
    const third = await post(hub, blockBody())
    await hub.ingest.idle()

    // One row from three posts, one pending item so the badge cannot double-count, and
    // the same row key in all three answers (HC-FR-08, EL-FR-07).
    expect(store.readEventHistory({ limit: 10 })).toHaveLength(1)
    expect(store.readPending()).toHaveLength(1)
    expect(second.body['eventId']).toBe(first.body['eventId'])
    expect(third.body['eventId']).toBe(first.body['eventId'])
    // One delivery for the event, not one per post: the two replays never reach the
    // policy at all, and the policy would refuse them if they did.
    expect(seen).toHaveLength(1)
    expect(hub.delivery.status()).toMatchObject({ attempted: 1, delivered: 1, suppressed: 0 })
    // The pipeline's own five delivery counters agree with the policy's: one attempt,
    // one delivery, and nothing that failed, timed out or had no port.
    expect(hub.ingest.stats().deliveries).toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
      timedOut: 0,
      notWired: 0,
    })
    // Two of the three posts were replays the store deduplicated (HC-FR-08, EL-FR-07).
    expect(hub.ingest.stats()).toMatchObject({ stored: 1, duplicates: 2, submitted: 3 })
  })

  it('delivers nothing for a suppression, a resolution or a second resolution', async () => {
    const seen: NotificationRequest[] = []
    const hub = await startFixtureHub(recordingNotifier(seen))

    await post(hub, blockBody('block-a'))
    await post(hub, idleBody())
    await post(hub, resolutionBody('block-a'))
    await post(hub, resolutionBody('block-a'))
    await hub.ingest.idle()

    // Only the block. The class policy belongs to the notifier (NT-1, ADR-004), so this
    // file does not suppress by class; what it must never produce is a second event
    // for one block, or an attempt for a signal that stored nothing (APX-CON-10).
    expect(seen).toHaveLength(1)
    expect(seen[0]?.event.dedupeKey).toBe(`opencode:${SESSION}:block-a`)
  })

  it('changes nothing in the log while a delivery is made', async () => {
    // The delivery path is read-only. A policy that could change a record would be a
    // second control surface reachable from nowhere (APX-CON-08), and the counts are
    // compared through a second connection rather than by reading the code.
    const seen: NotificationRequest[] = []
    const hub = await startFixtureHub(recordingNotifier(seen))
    const store = observeLog(hub)
    const counts = (): { pending: number; events: number; sessions: number } => ({
      pending: store.readPending().length,
      events: store.readEventHistory({ limit: 50 }).length,
      sessions: store.readSessionSummaries().length,
    })
    const before = counts()

    await post(hub, blockBody())
    await hub.ingest.idle()
    await post(hub, blockBody('block-2'))
    await hub.ingest.idle()

    // Two deliveries happened between the same two reads. The two posts each added one
    // event, in the one session they share; the deliveries added nothing to any count.
    expect(seen).toHaveLength(2)
    expect(counts()).toEqual({
      pending: before.pending + 2,
      events: before.events + 2,
      sessions: before.sessions + 1,
    })
  })
})

// ---------------------------------------------------------------------------
// HC-FR-07/AC3: health, and a forced notifier failure
// ---------------------------------------------------------------------------

describe('health reports the delivery status a doctor run needs', () => {
  it('reports database, server and delivery for a hub that has delivered', async () => {
    const seen: NotificationRequest[] = []
    const hub = await startFixtureHub(recordingNotifier(seen))
    await post(hub, blockBody())
    await hub.ingest.idle()

    const health = await healthOf(hub)

    // HC-FR-07 names three sections, and the payload has exactly those three plus the
    // identity and the dashboard it already had.
    expect(Object.keys(health).sort()).toEqual([
      'dashboard',
      'database',
      'delivery',
      'host',
      'instanceId',
      'origin',
      'pid',
      'port',
      'requests',
      'server',
      'startedAt',
      'status',
      'uptimeSeconds',
    ])
    expect(health.database).toMatchObject({ readable: true, pendingCount: 1, sessionCount: 1 })
    expect(health.server).toMatchObject({
      host: '127.0.0.1',
      port: hub.port,
      origin: hub.origin,
      listening: true,
      state: 'running',
    })
    expect(health.delivery).toEqual({
      status: 'ok',
      wired: true,
      attempted: 1,
      delivered: 1,
      failed: 0,
      timedOut: 0,
      suppressed: 0,
      notWired: 0,
      replayed: 0,
      inFlight: 0,
      lastAttemptAt: expect.any(String) as unknown as string,
      lastFailure: null,
    })
  })

  it('makes a forced notifier failure visible, and keeps the block', async () => {
    // A notifier that throws, not a simulated outcome. The block is stored and still
    // pending either way: a failed toast is a missing notification, never a lost block
    // (APX-FR-02, ADR-010).
    const hub = await startFixtureHub(() => {
      throw new Error('the notifier is failing on purpose')
    })
    const store = observeLog(hub)

    const response = await post(hub, blockBody())
    expect(response.status).toBe(202)
    await hub.ingest.idle()

    // The event is there. The notification is not, and three places say so.
    expect(store.readPending()).toHaveLength(1)
    expect(store.readEventHistory({ limit: 10 })).toHaveLength(1)

    const health = await healthOf(hub)
    // The top-level status follows PRD 10's definition of degraded, which is about the
    // database; the delivery verdict has its own field, because the two faults have
    // different remedies.
    expect(health.status).toBe('ok')
    expect(health.delivery.status).toBe('degraded')
    expect(health.delivery).toMatchObject({ wired: true, attempted: 1, delivered: 0, failed: 1 })
    // The row nobody was told about, named by key and by a closed reason token: enough
    // for `doctor` to be specific, and nothing that could carry a message.
    expect(health.delivery.lastFailure).toMatchObject({
      eventId: store.readPending()[0]?.eventId,
      reason: 'notifier-failed',
    })
    expect(Object.keys(health.delivery.lastFailure ?? {}).sort()).toEqual(['at', 'eventId', 'reason'])

    // The pipeline's own ledger has it too, because the port adapter turned the recorded
    // failure back into a rejection the pipeline records as a drop (HC-FR-09). One
    // failure, two records, the same event id in both.
    expect(hub.ingest.stats().deliveries).toMatchObject({ attempted: 1, delivered: 0, failed: 1 })
    expect(hub.ingest.droppedEvents()[0]).toMatchObject({ stage: 'delivery', reason: 'delivery-failed' })
    expect(hub.delivery.outcomes()[0]).toMatchObject({ outcome: 'failed', reason: 'notifier-failed' })
  })

  it('reports not-wired for a hub with no notifier, and delivers nothing', async () => {
    // `not-wired` means "this hub has no notifier behind the port", and it is now a state
    // a caller asks for rather than the default: since NT-1 the composition root
    // constructs the platform's notifier, so a hub that wanted the unwired state has to
    // say so. Two things in the product still produce it without asking - a platform with
    // no notifier (APX-CON-06, and the reason `createPlatformNotifier` reports rather than
    // throws), and this explicit override, which is how the state stays tested after the
    // default changed. Visible, counted, and never a success (APX-FR-02).
    const hub = await startFixtureHub(undefined, { delivery: { notifier: undefined } })
    const store = observeLog(hub)

    await post(hub, blockBody())
    await hub.ingest.idle()

    const health = await healthOf(hub)
    expect(health.delivery).toMatchObject({ status: 'not-wired', wired: false, delivered: 0 })
    // The pipeline never called a port it does not have, and says `not-wired` rather
    // than reporting an attempt it did not make.
    expect(hub.ingest.stats().deliveries).toMatchObject({ attempted: 1, delivered: 0, notWired: 1 })
    expect(store.readPending()).toHaveLength(1)
  })

  it('says degraded while a delivery is failing, and ok again once one lands', async () => {
    // The status reflects the most recent attempt rather than the run's history, so a
    // notifier that failed once and then worked is not left permanently degraded - and
    // the cumulative count and the last failure stay visible.
    let shouldFail = true
    const hub = await startFixtureHub(() => {
      if (shouldFail) throw new Error('failing on purpose')
    })

    await post(hub, blockBody('block-1'))
    await hub.ingest.idle()
    expect((await healthOf(hub)).delivery.status).toBe('degraded')

    shouldFail = false
    await post(hub, blockBody('block-2'))
    await hub.ingest.idle()
    const health = await healthOf(hub)

    expect(health.delivery.status).toBe('ok')
    expect(health.delivery).toMatchObject({ attempted: 2, delivered: 1, failed: 1 })
    // The failure is still on the record, because a count that disappears is a silent
    // failure.
    expect(health.delivery.lastFailure?.reason).toBe('notifier-failed')
  })
})

// ---------------------------------------------------------------------------
// A failure is never silent, and is never retried
// ---------------------------------------------------------------------------

describe('a delivery failure is bounded, recorded and never retried', () => {
  it('abandons a notifier that never settles, once, and records it', async () => {
    // APX-CON-10: fire-and-forget with a bounded timeout and no retry storm. The
    // notifier here never returns at all, so the bound is the only thing that can end
    // the attempt - and the timing is measured rather than taken on trust.
    const store = scratchStore()
    const started: number[] = []
    const policy = createDeliveryPolicy({
      store,
      attemptTimeoutMs: 40,
      notifier: () => {
        started.push(Date.now())
        return new Promise<void>(() => undefined)
      },
    })

    const beganAt = Date.now()
    const attempt = await policy.deliver(requestFor(store))
    const elapsed = Date.now() - beganAt

    expect(attempt).toMatchObject({ outcome: 'timed-out', reason: 'notifier-timeout' })
    expect(started).toHaveLength(1)
    expect(elapsed, `the attempt was abandoned after ${elapsed} ms`).toBeLessThan(5_000)
    // One record, one count, one health verdict.
    expect(policy.status()).toMatchObject({ attempted: 1, timedOut: 1, failed: 0, status: 'degraded' })
    expect(policy.outcomes()).toHaveLength(1)
    // And no second call, however long the test waits.
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(started).toHaveLength(1)
  })

  it('does not hold a shutdown open for a notifier that never settles', async () => {
    // The property the shutdown depends on: `close` drains, and a notifier that never
    // returns is bounded rather than waited for (APX-CON-10, HC-FR-10).
    const store = scratchStore()
    const policy = createDeliveryPolicy({
      store,
      attemptTimeoutMs: 40,
      notifier: () => new Promise<void>(() => undefined),
    })
    void policy.deliver(requestFor(store))

    const beganAt = Date.now()
    await policy.close()

    expect(Date.now() - beganAt).toBeLessThan(5_000)
    expect(policy.status().inFlight).toBe(0)
  })

  it('names the bounds the code and this file agree on', () => {
    // Product numbers rather than test-local constants: a budget that lived only in a
    // test would stop being checked the moment the test changed.
    expect(DELIVERY_ATTEMPT_TIMEOUT_MS).toBe(2_000)
    expect(DELIVERY_REPLAY_CONCURRENCY).toBe(8)
    expect(DELIVERY_MAX_OUTCOME_RECORDS).toBeGreaterThan(0)
  })

  it('carries a failure to the caller as a rejection, with no content in its message', () => {
    // The adapter the composition root uses: the policy never throws, so this is how a
    // recorded failure reaches the ingest pipeline's drop ledger (HC-FR-09).
    const record: DeliveryAttemptRecord = {
      at: '2026-09-26T09:00:00.000Z',
      eventId: 'e-1',
      class: 'needs-you',
      source: 'event',
      outcome: 'failed',
      reason: 'notifier-failed',
      elapsedMs: 2,
      pendingCount: 1,
    }
    const error = new DeliveryFailedError(record)

    expect(error.attempt).toBe(record)
    expect(error.message).toContain('failed/notifier-failed')
    expect(error.message).not.toContain('e-1')
  })
})

// ---------------------------------------------------------------------------
// HC-FR-07/AC2: the restart replay, on real processes
// ---------------------------------------------------------------------------

describe('a hub killed with a pending block replays it exactly once after a restart', () => {
  /**
   * The first run: a hub in its own process, a real block posted over a real socket,
   * and then a hard kill.
   *
   * SIGKILL rather than SIGTERM on purpose. A graceful stop drains, closes and removes
   * the runtime file, and a test that used it would be proving that a *clean* shutdown
   * preserved the block. The claim is that a hub which was killed - stopped so hard it
   * never ran its own shutdown - still comes back with the block outstanding and
   * delivers it again. That is PRD 10's "a crashed hub is indistinguishable from a
   * stopped one and recovers to running on next start with pending state intact", and it
   * is the claim a sidecar has to make (APX-CON-03).
   */
  async function killedRun(stateDir: string, attemptsFile: string): Promise<RealHub> {
    const hub = await startRealHub({ stateDir, attemptsFile, notifier: 'ok', preferredPort: RESTART_REPLAY_PORT_BASE })
    const response = await hub.post('/api/ingest', blockBody())
    expect(response.status).toBe(202)
    expect(response.json<{ outcome: string }>().outcome).toBe('pending-created')
    const attempts = await hub.waitForAttempts(1)
    expect(attempts[0]?.source).toBe('event')

    hub.signal('SIGKILL')
    const exit = await hub.waitForExit()
    // Killed, not stopped: the process died on the signal rather than exiting 0.
    expect(exit.code).toBeNull()
    expect(exit.signal).toBe('SIGKILL')
    return hub
  }

  it('replays it once in the next run, and once again in the one after that', async () => {
    const stateDir = temporaryDirectory('agent-ping-restart-')
    const attemptsFile = path.join(temporaryDirectory('agent-ping-attempts-'), 'attempts.jsonl')

    // ---- run 1: a block arrives, is delivered, and the process is killed.
    const first = await killedRun(stateDir, attemptsFile)
    const firstEventId = first.attempts()[0]?.eventId
    expect(firstEventId).toBeDefined()
    // The hard kill left the runtime file behind with the dead pid still in it, which
    // is the state a restart has to reclaim rather than refuse (HC-FR-01, APX-CON-03).
    const afterKill = readRuntimeFile(stateDir)
    expect(afterKill?.pid).toBe(first.pid)
    expect(afterKill?.port).toBe(first.port)

    // ---- run 2: a restart over the same state directory.
    const second = await startRealHub({ stateDir, attemptsFile, notifier: 'ok', preferredPort: RESTART_REPLAY_PORT_BASE })
    // It reclaimed the dead instance's file rather than refusing the start, and it is a
    // different instance with its own record.
    const reclaimed = readRuntimeFile(stateDir)
    expect(reclaimed?.pid).toBe(second.pid)
    expect(reclaimed?.instanceId).not.toBe(afterKill?.instanceId)

    // The pending block is still outstanding, and it is the same block.
    const health = (await second.get('/api/health')).json<HealthPayload>()
    expect(health.database.pendingCount).toBe(1)
    expect(health.delivery).toMatchObject({
      status: 'ok',
      wired: true,
      attempted: 1,
      delivered: 1,
      replayed: 1,
    })
    const pending = (await (await second.get('/api/pending')).json<{ count: number; items: { eventId: string }[] }>())
    expect(pending.count).toBe(1)
    expect(pending.items[0]?.eventId).toBe(firstEventId)

    // ---- the evidence: exactly one new line, for the same row, from the replay.
    const attempts = await second.waitForAttempts(2)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toMatchObject({ pid: first.pid, source: 'event' })
    expect(attempts[1]).toMatchObject({ pid: second.pid, source: 'restart-replay' })
    expect(attempts[1]?.eventId).toBe(firstEventId)
    // The replay carried the badge count and a real deep-link origin, so a replayed
    // toast is as usable as a live one.
    expect(attempts[1]?.pendingCount).toBe(1)
    expect(attempts[1]?.origin).toBe(second.origin)
    expect(attempts[1]?.repoShortName).toBe('agent-ping')
    // The log has one event and one session: a restart duplicated no row, and the
    // pending count did not double (EL-FR-08).
    expect((await (await second.get('/api/events?limit=50')).json<{ count: number }>()).count).toBe(1)
    expect((await (await second.get('/api/sessions')).json<{ count: number }>()).count).toBe(1)

    second.signal('SIGTERM')
    expect((await second.waitForExit()).code).toBe(0)

    // ---- run 3: still exactly one replay per run, and the block is still one block.
    // A replay is not a "notified" mark: a developer who missed both toasts must be
    // told again, because the badge is the durable signal rather than a toast anyone
    // was watching for (ADR-010, NT-FR-08).
    const third = await startRealHub({ stateDir, attemptsFile, notifier: 'ok', preferredPort: RESTART_REPLAY_PORT_BASE })
    const healthThird = (await (await third.get('/api/health')).json<HealthPayload>())
    expect(healthThird.delivery).toMatchObject({ replayed: 1, delivered: 1, attempted: 1 })
    await third.waitForAttempts(3)
    expect(third.attempts()).toHaveLength(3)
    expect(third.attempts()[2]).toMatchObject({ source: 'restart-replay' })
    expect(third.attempts()[2]?.eventId).toBe(firstEventId)
    expect((await (await third.get('/api/pending')).json<{ count: number }>()).count).toBe(1)
    expect((await (await third.get('/api/events?limit=50')).json<{ count: number }>()).count).toBe(1)

    third.signal('SIGTERM')
    expect((await third.waitForExit()).code).toBe(0)
  }, 90_000)

  it('makes a notifier failure in the replaying run visible there', async () => {
    // The forced failure, this time in the run that replays: the replayed delivery
    // fails, and the new process's health says so - which is the whole of APX-FR-02 for
    // the path nobody is watching, because nobody was told.
    const stateDir = temporaryDirectory('agent-ping-restart-fail-')
    const attemptsFile = path.join(temporaryDirectory('agent-ping-attempts-'), 'attempts.jsonl')

    const first = await startRealHub({ stateDir, attemptsFile, notifier: 'ok', preferredPort: RESTART_REPLAY_PORT_BASE })
    await first.post('/api/ingest', blockBody())
    await first.waitForAttempts(1)
    first.signal('SIGKILL')
    await first.waitForExit()

    const second = await startRealHub({ stateDir, attemptsFile, notifier: 'fail', preferredPort: RESTART_REPLAY_PORT_BASE })
    const health = (await (await second.get('/api/health')).json<HealthPayload>())
    expect(health.delivery).toMatchObject({ status: 'degraded', failed: 1, replayed: 1, delivered: 0 })
    expect(health.delivery.lastFailure?.reason).toBe('notifier-failed')
    // The block survived the failure, because a failed notification is not a lost block.
    expect(health.database.pendingCount).toBe(1)
    const attempts = await second.waitForAttempts(2)
    expect(attempts[1]).toMatchObject({ source: 'restart-replay' })

    second.signal('SIGTERM')
    expect((await second.waitForExit()).code).toBe(0)
  }, 90_000)
})

// ---------------------------------------------------------------------------
// The replay batch, in full
// ---------------------------------------------------------------------------

describe('the replay delivers every outstanding block, oldest first, bounded', () => {
  it('replays each pending item exactly once and nothing that is settled', async () => {
    const store = scratchStore()
    const pendingIds = seedPendingBlocks(store, 12)
    // One that is not pending: it was acknowledged, so it must not be replayed - a block
    // the developer has already dealt with is a block that must not nag (NT-FR-06,
    // NT-FR-08).
    const acknowledged = requestFor(store)
    store.markAcknowledged(acknowledged.event.eventId)
    expect(store.readPending()).toHaveLength(12)

    const seen: NotificationRequest[] = []
    const policy = createDeliveryPolicy({
      store,
      notifier: recordingNotifier(seen),
      replayConcurrency: 3,
    })

    const report = await policy.replayPending()

    expect(report).toEqual({
      candidates: 12,
      attempted: 12,
      delivered: 12,
      failed: 0,
      suppressed: 0,
      notWired: 0,
    })
    // Every pending item, once, and nothing else.
    expect([...seen.map((request) => request.event.eventId)].sort()).toEqual([...pendingIds].sort())
    expect(seen.every((request) => request.source === 'restart-replay')).toBe(true)
    // Oldest first: the store's own pending read is ordered by occurrence and the batch
    // is issued in that order, so the block that has waited longest is the first one a
    // developer is told about.
    expect(seen[0]?.event.eventId).toBe(pendingIds[0])
  }, 30_000)

  it('issues the batch in bounded concurrency', async () => {
    // Asserted rather than assumed: the notifier counts its own concurrent calls, so a
    // limit that was ignored would show a peak above the configured bound. A restart
    // with two hundred pending blocks must not hand a desktop two hundred notifications
    // in the same millisecond (APX-CON-10).
    const store = scratchStore()
    seedPendingBlocks(store, 9)
    let inFlight = 0
    let peak = 0
    const policy = createDeliveryPolicy({
      store,
      replayConcurrency: 2,
      notifier: () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            inFlight -= 1
            resolve()
          }, 5)
        })
      },
    })

    const report = await policy.replayPending()

    expect(report.attempted).toBe(9)
    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThanOrEqual(2)
  }, 30_000)

  it('replays nothing when there is nothing outstanding, and reports it', async () => {
    const store = scratchStore()
    const seen: NotificationRequest[] = []
    const policy = createDeliveryPolicy({ store, notifier: recordingNotifier(seen) })

    expect(await policy.replayPending()).toEqual({
      candidates: 0,
      attempted: 0,
      delivered: 0,
      failed: 0,
      suppressed: 0,
      notWired: 0,
    })
    expect(seen).toHaveLength(0)
  })

  it('reports a not-wired replay instead of counting it as a delivery', async () => {
    // A restart with no notifier must not look like a restart that notified anybody.
    const store = scratchStore()
    seedPendingBlocks(store, 3)
    const policy = createDeliveryPolicy({ store })

    const report = await policy.replayPending()

    expect(report).toMatchObject({ candidates: 3, attempted: 3, delivered: 0, notWired: 3 })
    expect(policy.status()).toMatchObject({ status: 'not-wired', notWired: 3, delivered: 0, replayed: 3 })
    expect(policy.outcomes()).toHaveLength(3)
  })

  it('replays a block the previous run delivered, because nobody may have seen it', async () => {
    // The per-run scope of the exactly-once guard, stated as a test rather than as a
    // comment. A new process has an empty guard, so an outstanding block is delivered
    // again - which is the whole point of HC-FR-07 and of the badge being the durable
    // signal (ADR-010).
    const store = scratchStore()
    const request = requestFor(store)
    const seen: NotificationRequest[] = []
    const firstRun = createDeliveryPolicy({ store, notifier: recordingNotifier(seen) })
    expect((await firstRun.deliver(request)).outcome).toBe('delivered')

    const secondRun = createDeliveryPolicy({ store, notifier: recordingNotifier(seen) })
    const replayed = await secondRun.deliver(request, 'restart-replay')

    expect(replayed.outcome).toBe('delivered')
    expect(seen).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// What the policy may not do
// ---------------------------------------------------------------------------

describe('the delivery policy has no surface that could steer a harness', () => {
  it('is not a route, and the mutating surface is still exactly two signatures', () => {
    // Asserted over the enumerated registry rather than over a comment: the policy is
    // the one thing in this product that may interrupt a developer, so it must be
    // unreachable from a request (APX-CON-08, ADR-002).
    const registry = new RouteRegistry<HubServices>()
    registry.registerAll(READ_ROUTES)
    registry.registerAll(STREAM_ROUTES)
    registry.registerAll(INGEST_ROUTES)
    registry.registerAll(ACK_ROUTES)

    expect([...MUTATING_ROUTES].sort()).toEqual(['POST /api/ack/:eventId', 'POST /api/ingest'])
    const forbidden = /spawn|steer|interrupt|prompt|approve|resume|kill|send|control|execute|input|keypress/i
    for (const route of registry.routes()) {
      expect(`${route.method} ${route.pattern} ${route.name}`).not.toMatch(forbidden)
    }
  })

  it('exposes no route that reaches the policy', async () => {
    // Every plausible path for a delivery control, asked for over a real socket, is a
    // 404. A `GET /api/delivery` would be the obvious wrong answer, and its absence is
    // what this asserts.
    const hub = await startFixtureHub(() => undefined)
    for (const pathname of ['/api/delivery', '/api/notifier', '/api/replay', '/api/policy', '/api/notify']) {
      const response = await get(hub, pathname)
      expect(response.status, pathname).toBe(404)
    }
  })

  it('exposes no method that could reach a harness, a session or a row key', () => {
    // The policy's members, asserted by name and shape: one attempt, one replay, three
    // reads and a close. Nothing that could be a control verb, and nothing that accepts
    // an identifier a client chose - `deliver` takes the request the policy itself
    // builds, so it cannot be a second ack route wearing a hat.
    const policy = createDeliveryPolicy({ store: scratchStore() })
    const members = Object.keys(policy).sort()

    expect(members).toEqual(['close', 'deliver', 'outcomes', 'replayPending', 'status', 'wired'])
    for (const forbidden of ['acknowledge', 'resolve', 'prompt', 'approve', 'send', 'spawn', 'interrupt']) {
      expect(members, forbidden).not.toContain(forbidden)
    }
    expect(policy.deliver).toHaveLength(1)
  })

  it('carries no content in anything it records', async () => {
    const store = scratchStore()
    const policy = createDeliveryPolicy({ store, notifier: (): void => undefined })
    await policy.deliver(requestFor(store))

    const [record] = policy.outcomes()
    // Keys, a class, counts and a timestamp: the same content-free field set the log
    // itself holds (APX-FR-01, ADR-003). A title, a body, a prompt or an error message
    // would be able to appear here the moment a notifier grew one.
    expect(Object.keys(record ?? {}).sort()).toEqual([
      'at',
      'class',
      'elapsedMs',
      'eventId',
      'outcome',
      'pendingCount',
      'reason',
      'source',
    ])
    expect(JSON.stringify(policy.status())).not.toContain(REPO_PATH)
  })
})

// ---------------------------------------------------------------------------
// The composition root wires the one policy
// ---------------------------------------------------------------------------

describe('the main entry point wires exactly one delivery policy', () => {
  it('gives the ingest pipeline a port that is the policy, and agrees with it', async () => {
    const seen: NotificationRequest[] = []
    const hub = await startFixtureHub(recordingNotifier(seen))

    // One hub, one policy, one notifier call per event: the port the pipeline holds and
    // the policy the health route reads are the same object rather than two that agree.
    await post(hub, blockBody())
    await hub.ingest.idle()
    expect(seen).toHaveLength(1)
    expect(hub.delivery.status().delivered).toBe(1)
    expect(hub.ingest.stats().deliveries.delivered).toBe(1)
  })

  it('exposes the policy and the shutdown path on the running hub, for doctor', async () => {
    const hub = await startFixtureHub(() => undefined)

    expect(hub.delivery).toBeDefined()
    expect(hub.lifecycle.state().state).toBe('running')
    expect((await healthOf(hub)).server.state).toBe('running')
  })

  it('closes the policy before the log, so a delivery can never outlive the store', () => {
    // The ordering is asserted from the source, because both steps happen inside one
    // synchronous turn of the event loop and no observer outside this process can see
    // which ran first. What matters is that the refusal step is there at all: a close
    // that closed the database first could hand a notifier a store that has gone.
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'main', 'index.ts'),
      'utf8',
    )
    const steps = {
      deliveryClose: source.indexOf('await delivery?.close()'),
      ingestClose: source.indexOf('await ingest?.close()'),
      streamClose: source.indexOf('stream?.close()'),
      serverClose: source.indexOf('await server?.close()'),
      countersFlush: source.indexOf('counters?.flush()'),
      storeClose: source.indexOf('store?.close()'),
      release: source.indexOf('lifecycle.finish()'),
    }
    for (const [name, at] of Object.entries(steps)) {
      expect(at, name).toBeGreaterThan(-1)
    }
    // The whole order, top to bottom: refuse, drain, end streams, stop answering,
    // flush, close, mark stopped (HC-FR-10, PRD 10).
    expect(steps.deliveryClose).toBeLessThan(steps.ingestClose)
    expect(steps.ingestClose).toBeLessThan(steps.streamClose)
    expect(steps.streamClose).toBeLessThan(steps.serverClose)
    expect(steps.serverClose).toBeLessThan(steps.countersFlush)
    expect(steps.countersFlush).toBeLessThan(steps.storeClose)
    expect(steps.storeClose).toBeLessThan(steps.release)
  })
})
