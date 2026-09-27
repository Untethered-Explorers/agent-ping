// The ack route: the only route in agent-ping that can change a record that
// already exists, and the proof that it is the only one (HC-4, HC-FR-05, APX-CON-08).
//
//   npm test -- tests/hub/ack.test.ts
//
// The acceptance criteria, and where each is proven:
//
//   1. A test enumerates every registered route and asserts the ack route is the only
//      one that changes stored state. Proven by walking `hub.registry.routes()` - the
//      running hub's own registration list, not a list written here - against every
//      mutating method, and diffing the *whole* log around each request: every event
//      row field by field, every session row, and the pending set. The recorded table of
//      what each route did is asserted, so a second control surface is a test failure
//      rather than a review finding.
//   2. A test asserts an unknown identifier answers not-found and an already resolved
//      item answers conflict, neither changing state. Both diffed to nothing.
//   3. A write without the shared token is refused. The non-loopback half of this
//      criterion is in tests/hub/security.test.ts, because it is a property of the
//      listener rather than of this route; the token half is here because the check is
//      the first statement in this handler and the file is the boundary's.
//   4. The dashboard response's policy and cross-origin headers are asserted in
//      tests/hub/security.test.ts too, for the same reason.
//
// SINCE NS-3, THE CARD DISMISSAL
// Acknowledging a block also takes the card showing it off the screen, through the
// dismissal port the ack route is handed in `HubServices`. Three claims came with that and
// they are the last describe block in this file:
//   - an unauthorised, a rejected and a not-found acknowledgement each remove *nothing*
//     and change *nothing*, and only a successful one takes a card down (criterion 4);
//   - the 200 body keeps its exact key set, the whole-log diff across every registered
//     route and method is still empty for everything but the ack route's one column, and
//     the registered route-signature list is byte-identical - all of it re-asserted on a
//     hub with a real card surface, because a dismissal that could change a record would
//     not show up in any of the tests above (criterion 5);
//   - the dismissal port is in *both* of the two `HubServices` objects the composition
//     root builds, and a source read is the only way to see the pre-bind one, which no
//     request can reach (criterion 9).
// The dismissal itself - which end, for which session, and what the document is told - is
// tests/notify/surface-dismissal.test.ts, which is where the card lives.
//
// Around those four, the properties that make the ack route trustworthy:
//   - The one effect is one column flip on one pending row. Not the class, not the
//     session state, not the resolution, and not a count that is accumulated rather
//     than read.
//   - It is idempotent: a second acknowledgement is a 200 that changed nothing, and
//     never a second count (HC-FR-08).
//   - It reads no request body, so a body carrying a class, a state or a resolution is
//     discarded rather than acted on - and posting one cannot un-acknowledge a row.
//   - A finished or an fyi row answers conflict rather than being flipped, because only
//     a pending item may be acknowledged (APX-CON-08).
//   - Nothing it serves can carry conversation content, and the identifier it echoes is
//     the store's own row key rather than the text a caller sent (APX-FR-01).
//   - Every method no route serves on its path is 405 and every other write-shaped path
//     is 404, both with the log untouched.
//
// The store is opened a second time on purpose: the hub holds one connection, and a
// second connection over the same file is how anything outside the process observes
// the log. Every read goes through the store's typed accessors, because the store has
// no query surface and inventing one in a test would prove nothing about the product.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { electronDesktopBridge, startHub, type RunningHub } from '@/main/index'
import {
  openEventStore,
  type EventRecord,
  type EventStore,
  type NewEvent,
  type PendingItem,
  type SessionSummary,
} from '@/storage/eventStore'
import {
  ACK_ERROR_CODES,
  ACK_REFUSAL_MESSAGE,
  ACK_ROUTE_DESCRIPTION,
  ACK_ROUTES,
  ACK_STATUS,
  type AckAcceptedBody,
} from '@/hub/routes/ack'
import { MUTATING_ROUTE, MUTATING_ROUTES, RouteRegistry } from '@/hub/server'
import { WRITE_TOKEN_HEADER, readWriteToken } from '@/hub/security'
import type { HubServices } from '@/hub/routes/read'
import { CARD_CHANNEL_REMOVE, CARD_CHANNEL_SHOW, CARD_CHANNEL_READY } from '@/notify/surface/channel'
import { readModuleWithoutProse } from '../helpers/read-module'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_PATH = '/home/dev/Projects/agent-ping'
const SESSION = 'ses_ack_01'
/** A second session, so the walk's ingest probe adds a row without editing one. */
const OTHER_SESSION = 'ses_ack_02'
/** The methods a client may try on a path. HEAD and OPTIONS are covered separately. */
const WALK_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

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
 * A stand-in for the built dashboard.
 *
 * The walk requests every registered route, and `GET /` is one of them: a hub serving
 * no dashboard answers 503 there, which would make the walk assert against a fixture's
 * absence rather than against a route's behaviour. The layout is the one Vite produces.
 */
function dashboardFixture(): string {
  const root = temporaryDirectory('agent-ping-dashboard-')
  mkdirSync(path.join(root, 'assets'), { recursive: true })
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>agent-ping</title>\n')
  writeFileSync(path.join(root, 'assets', 'index-abc123.js'), 'console.log("dashboard")\n')
  return root
}

/** A hub, started by the real entry point against a temporary state directory. */
async function startFixtureHub(
  options: Partial<Parameters<typeof startHub>[0]> = {},
): Promise<RunningHub> {
  const hub = await startHub({
    stateDir: temporaryDirectory('agent-ping-state-'),
    dashboardRoot: dashboardFixture(),
    ...options,
  })
  openHubs.push(hub)
  return hub
}

/** A second connection to the log the hub is holding, opened once per test. */
function observer(hub: RunningHub): EventStore {
  const store = openEventStore({ filePath: hub.databaseFilePath })
  openStores.push(store)
  return store
}

function blockEvent(overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    harness: 'opencode',
    sessionId: SESSION,
    repoShortName: 'agent-ping',
    repoFullPath: REPO_PATH,
    rawEventType: 'permission.asked',
    class: 'needs-you',
    subtype: null,
    occurredAt: '2026-09-26T09:00:00.000Z',
    receivedAt: '2026-09-26T09:00:00.100Z',
    dedupeKey: 'opencode:ses_ack_01:block-1',
    ...overrides,
  }
}

function finishedEvent(overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    harness: 'opencode',
    sessionId: SESSION,
    repoShortName: 'agent-ping',
    repoFullPath: REPO_PATH,
    rawEventType: 'session.idle',
    class: 'finished',
    occurredAt: '2026-09-26T10:00:00.000Z',
    receivedAt: '2026-09-26T10:00:00.100Z',
    dedupeKey: 'opencode:ses_ack_01:idle-1',
    ...overrides,
  }
}

function fyiEvent(overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    harness: 'opencode',
    sessionId: SESSION,
    repoShortName: 'agent-ping',
    repoFullPath: REPO_PATH,
    rawEventType: 'session.retry',
    class: 'fyi',
    subtype: 'retry',
    occurredAt: '2026-09-26T11:00:00.000Z',
    receivedAt: '2026-09-26T11:00:00.100Z',
    dedupeKey: 'opencode:ses_ack_01:retry-1',
    ...overrides,
  }
}

/**
 * One block, one finished event and one fyi event, so "it changed nothing else" has
 * something to be false about.
 *
 * Returns the pending row's key, because that is the only one of the three a client is
 * allowed to acknowledge.
 */
function seedThreeClasses(store: EventStore): string {
  const block = store.insertEvent(blockEvent())
  store.insertEvent(finishedEvent())
  store.insertEvent(fyiEvent())
  return block.event.eventId
}

interface Fetched {
  readonly status: number
  readonly text: string
  readonly headers: Record<string, string | string[] | undefined>
  json<T = unknown>(): T
}

interface CallInit {
  readonly method?: string
  readonly pathname?: string
  readonly body?: string
  readonly headers?: Readonly<Record<string, string | string[]>>
}

/**
 * One request over a real socket, through node:http.
 *
 * Deliberately not `fetch`, for the reason the other hub tests give: these tests reuse
 * one loopback origin on purpose, and a pooled connection opened against a hub that has
 * since closed would be handed to the next request. One request, one connection, one
 * answer.
 */
function call(origin: string, init: CallInit = {}): Promise<Fetched> {
  const { hostname, port } = new URL(origin)
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: hostname,
        port,
        path: init.pathname ?? '/',
        method: init.method ?? 'GET',
        headers: {
          ...(init.body === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(init.body)),
              }),
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
            headers: response.headers as Record<string, string | string[] | undefined>,
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

/**
 * Open the stream, wait for it to say something, and close it.
 *
 * A stream response does not end, so the one request helper in this file cannot be used
 * for it: it waits for `end`. This reads the first chunk instead - enough to know the
 * route answered - and then destroys the request, so the hub sees a client that went
 * away, which is half of what the read-only comparison is for.
 */
function openStreamAndReadFirstFrame(hub: RunningHub): Promise<{ status: number }> {
  const { hostname, port } = new URL(hub.origin)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (status: number): void => {
      if (settled) return
      settled = true
      resolve({ status })
    }
    const outgoing = request(
      { host: hostname, port, path: '/api/stream', method: 'GET', agent: false },
      (response) => {
        response.once('data', () => {
          finish(response.statusCode ?? 0)
          outgoing.destroy()
        })
        response.on('end', () => finish(response.statusCode ?? 0))
      },
    )
    outgoing.on('error', (cause: Error) => {
      // A destroyed request is the point of this helper, not a fault.
      if (settled) return
      finish(0)
      reject(cause)
    })
    outgoing.end()
  })
}

/**
 * The install's write token, read from the file the way a client reads it.
 *
 * The in-process value is deliberately not used: proving the file is the contract is
 * part of what this task delivers, and a test that read `hub.security.writeToken` would
 * pass even if the file were unreadable.
 */
function tokenFor(hub: RunningHub): string {
  const token = readWriteToken(hub.stateDir)
  if (token === null) throw new Error('the fixture hub published no write token')
  return token
}

/** The one write a client makes, carrying the token the way the contract says. */
function ack(
  hub: RunningHub,
  eventId: string,
  overrides: Partial<CallInit> = {},
): Promise<Fetched> {
  return call(hub.origin, {
    method: 'POST',
    pathname: `/api/ack/${eventId}`,
    headers: { [WRITE_TOKEN_HEADER]: tokenFor(hub) },
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// The whole log, and a diff of it
// ---------------------------------------------------------------------------

interface LogSnapshot {
  readonly events: readonly EventRecord[]
  readonly sessions: readonly SessionSummary[]
  readonly pending: readonly PendingItem[]
}

/**
 * Everything the log holds, in a stable order.
 *
 * A snapshot rather than a count, because a count cannot tell "acknowledged the row I
 * was asked to" from "changed a row I was not". Every field of every row is here, so a
 * diff says exactly which field of which row moved.
 */
function snapshotOf(store: EventStore): LogSnapshot {
  return {
    events: [...store.readEventHistory({ limit: 500 })].sort(byEventId),
    sessions: [...store.readSessionSummaries()].sort((a, b) =>
      a.sessionId.localeCompare(b.sessionId),
    ),
    pending: [...store.readPending()].sort(byEventId),
  }
}

function byEventId(a: { eventId: string }, b: { eventId: string }): number {
  return a.eventId.localeCompare(b.eventId)
}

/** What changed between two snapshots, in enough detail to assert on. */
interface LogDiff {
  /** Rows that did not exist before. */
  readonly added: readonly string[]
  readonly removed: readonly string[]
  /** Rows that existed before, with the names of the fields that moved. */
  readonly changed: readonly { readonly eventId: string; readonly fields: readonly string[] }[]
  readonly sessionsAdded: readonly string[]
  /** Sessions that existed before, with the names of the fields that moved. */
  readonly sessionsChanged: readonly { readonly sessionId: string; readonly fields: readonly string[] }[]
  readonly pendingAdded: readonly string[]
  readonly pendingRemoved: readonly string[]
}

function diffLogs(before: LogSnapshot, after: LogSnapshot): LogDiff {
  const beforeEvents = new Map(before.events.map((event) => [event.eventId, event]))
  const afterEvents = new Map(after.events.map((event) => [event.eventId, event]))
  const added = [...afterEvents.keys()].filter((id) => !beforeEvents.has(id)).sort()
  const removed = [...beforeEvents.keys()].filter((id) => !afterEvents.has(id)).sort()
  const changed: { eventId: string; fields: string[] }[] = []
  for (const [eventId, event] of afterEvents) {
    const previous = beforeEvents.get(eventId)
    if (previous === undefined) continue
    const fields = changedFields(previous, event)
    if (fields.length > 0) changed.push({ eventId, fields })
  }
  changed.sort((a, b) => a.eventId.localeCompare(b.eventId))

  const beforeSessions = new Map(before.sessions.map((row) => [row.sessionId, row]))
  const sessionsAdded: string[] = []
  const sessionsChanged: { sessionId: string; fields: string[] }[] = []
  for (const session of after.sessions) {
    const previous = beforeSessions.get(session.sessionId)
    if (previous === undefined) {
      sessionsAdded.push(session.sessionId)
      continue
    }
    const fields = changedNames(previous, session)
    if (fields.length > 0) sessionsChanged.push({ sessionId: session.sessionId, fields })
  }

  const beforePending = new Set(before.pending.map((item) => item.eventId))
  const afterPending = new Set(after.pending.map((item) => item.eventId))
  return {
    added,
    removed,
    changed,
    sessionsAdded: sessionsAdded.sort(),
    sessionsChanged: sessionsChanged.sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    pendingAdded: [...afterPending].filter((id) => !beforePending.has(id)).sort(),
    pendingRemoved: [...beforePending].filter((id) => !afterPending.has(id)).sort(),
  }
}

/** The names of `after`'s fields that differ from `before`'s, in a fixed order. */
function changedFields(before: EventRecord, after: EventRecord): string[] {
  return changedNames(before, after)
}

function changedNames(before: object, after: object): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed: string[] = []
  for (const name of [...names].sort()) {
    const key = name as keyof typeof before & keyof typeof after
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.push(name)
  }
  return changed
}

/** The diff a read, a refusal or a no-op must produce: none of it. */
const NOTHING_CHANGED: LogDiff = {
  added: [],
  removed: [],
  changed: [],
  sessionsAdded: [],
  sessionsChanged: [],
  pendingAdded: [],
  pendingRemoved: [],
}

// ---------------------------------------------------------------------------
// HC-FR-05: the ack route
// ---------------------------------------------------------------------------

describe('the ack route (HC-FR-05)', () => {
  it('marks one pending item acknowledged and changes nothing else', async () => {
    const hub = await startFixtureHub()
    const store = observer(hub)
    const blockId = seedThreeClasses(store)
    const before = snapshotOf(store)
    expect(before.events).toHaveLength(3)
    expect(before.pending.map((item) => item.eventId)).toEqual([blockId])

    const response = await ack(hub, blockId)

    expect(response.status).toBe(ACK_STATUS.applied)
    const body = response.json<AckAcceptedBody>()
    // Exactly the store's row key, and exactly the closed key set: a payload this
    // product serves has to be a fixed shape (APX-FR-01, ADR-003).
    expect(Object.keys(body).sort()).toEqual([
      'ackState',
      'acknowledged',
      'eventId',
      'outcome',
      'pendingCount',
      'reason',
      'resolutionState',
    ])
    expect(body).toEqual({
      acknowledged: true,
      eventId: blockId,
      outcome: 'applied',
      reason: 'developer-acknowledgement',
      ackState: 'acknowledged',
      resolutionState: 'unresolved',
      pendingCount: 0,
    })

    // The whole log, field by field. Exactly one *stored* field moved, on one row; the
    // two rows that are not pending items were not touched; and the one session field
    // that moved is the derived `pendingCount`, which is a subquery over the pending
    // set rather than a stored column - naming it is the point, because "the ack changed
    // the session row" is true and "the ack rewrote a session" is not.
    expect(diffLogs(before, snapshotOf(store))).toEqual({
      added: [],
      removed: [],
      changed: [{ eventId: blockId, fields: ['ackState'] }],
      sessionsAdded: [],
      sessionsChanged: [{ sessionId: SESSION, fields: ['pendingCount'] }],
      pendingAdded: [],
      pendingRemoved: [blockId],
    })
  })

  it('publishes one live change frame for the acknowledgement', async () => {
    // The stream is HC-2's, but the change-feed wrapper is what makes the ack route's
    // write visible to a dashboard without the route knowing the stream exists - and a
    // silent write is the failure APX-FR-02 names.
    const hub = await startFixtureHub()
    const store = observer(hub)
    const blockId = seedThreeClasses(store)
    const cursorBefore = hub.stream.currentCursor()

    await ack(hub, blockId)

    expect(hub.stream.currentCursor()).toBe(cursorBefore + 1)
    const frames = hub.stream.retainedFrames()
    const published = frames[frames.length - 1]
    expect(published?.kind).toBe('acknowledged')
    expect(published?.event.eventId).toBe(blockId)
    expect(published?.pendingCount).toBe(0)
    // Exactly one frame: the insertion that seeded the log is not in this hub's window,
    // because it went in through a second connection rather than through the hub.
    expect(frames).toHaveLength(1)
  })

  it('is idempotent: a second acknowledgement is a 200 that changed nothing', async () => {
    const hub = await startFixtureHub()
    const store = observer(hub)
    const blockId = seedThreeClasses(store)
    await ack(hub, blockId)
    const before = snapshotOf(store)

    const repeat = await ack(hub, blockId)

    expect(repeat.status).toBe(ACK_STATUS.unchanged)
    // Reported as `unchanged`, not as a second applied: a retried click that looks like
    // new work is how a badge double-counts (HC-FR-08).
    expect(repeat.json<AckAcceptedBody>()).toEqual({
      acknowledged: false,
      eventId: blockId,
      outcome: 'unchanged',
      reason: 'already-acknowledged',
      ackState: 'acknowledged',
      resolutionState: 'unresolved',
      pendingCount: 0,
    })
    expect(diffLogs(before, snapshotOf(store))).toEqual(NOTHING_CHANGED)
  })

  it('answers not-found for an unknown identifier, changing nothing', async () => {
    const hub = await startFixtureHub()
    const store = observer(hub)
    seedThreeClasses(store)
    const before = snapshotOf(store)

    const response = await ack(hub, 'evt_no_such_row')

    expect(response.status).toBe(ACK_STATUS['not-found'])
    const body = response.json<{ error: string; message: string; eventId: string | null }>()
    expect(body.error).toBe('not-found')
    expect(body.eventId).toBeNull()
    // The identifier the caller sent is not reflected back: a caller-chosen string must
    // not come out of a payload this product serves.
    expect(response.text).not.toContain('evt_no_such_row')
    expect(diffLogs(before, snapshotOf(store))).toEqual(NOTHING_CHANGED)
  })

  it('answers conflict for an item the harness already resolved, changing nothing', async () => {
    const hub = await startFixtureHub()
    const store = observer(hub)
    const blockId = seedThreeClasses(store)
    // The harness reported the block resolved: a fact, recorded by the ingest path
    // (src/domain/pending.ts), and nothing to do with this route.
    expect(store.markResolved(blockId).outcome).toBe('applied')
    const before = snapshotOf(store)

    const response = await ack(hub, blockId)

    expect(response.status).toBe(ACK_STATUS.rejected)
    const body = response.json<{ error: string; reason: string; eventId: string | null }>()
    expect(body.error).toBe('conflict')
    expect(body.reason).toBe('already-resolved-by-harness')
    expect(body.eventId).toBe(blockId)
    // It did not become acknowledged on the way: acknowledging a decision the harness
    // already took is refused, and the row is left exactly as it was.
    expect(diffLogs(before, snapshotOf(store))).toEqual(NOTHING_CHANGED)
  })

  it('answers conflict for a row that is not a pending item', async () => {
    const hub = await startFixtureHub()
    const store = observer(hub)
    seedThreeClasses(store)
    const rows = store.readEventHistory({ limit: 500 })
    const before = snapshotOf(store)

    for (const row of rows.filter((event) => event.class !== 'needs-you')) {
      const response = await ack(hub, row.eventId)
      expect(response.status, row.class).toBe(ACK_STATUS.rejected)
      expect(response.json<{ error: string; reason: string }>()).toMatchObject({
        error: 'conflict',
        reason: 'not-a-pending-item',
      })
    }

    // Only a pending item may be acknowledged (APX-CON-08), and neither of the other
    // two classes was flipped on the way to saying so.
    expect(rows.filter((event) => event.class !== 'needs-you')).toHaveLength(2)
    expect(diffLogs(before, snapshotOf(store))).toEqual(NOTHING_CHANGED)
  })

  it('cannot resolve, un-resolve or reclassify the row it acknowledges', async () => {
    const hub = await startFixtureHub()
    const store = observer(hub)
    const blockId = seedThreeClasses(store)

    await ack(hub, blockId)

    const row = store.readEventHistory({ limit: 500 }).find((event) => event.eventId === blockId)
    expect(row?.ackState).toBe('acknowledged')
    // A resolution is a fact the harness reported, never something this route records
    // (src/domain/pending.ts), and the class of a stored event is not a caller's to set.
    expect(row?.resolutionState).toBe('unresolved')
    expect(row?.class).toBe('needs-you')
    expect(row?.dedupeKey).toBe('opencode:ses_ack_01:block-1')
  })

  it('reads no request body, so a body cannot change anything', async () => {
    const hub = await startFixtureHub()
    const store = observer(hub)
    const blockId = seedThreeClasses(store)
    const before = snapshotOf(store)

    // A body shaped like an instruction: flip both states, reclassify the event, name a
    // different row, approve and interrupt. The route reads a path segment and a header,
    // so none of it is interpreted.
    const response = await ack(hub, blockId, {
      body: JSON.stringify({
        ackState: 'unacknowledged',
        resolutionState: 'resolved',
        class: 'fyi',
        eventId: 'evt_somewhere_else',
        approved: true,
        interrupt: 'now',
      }),
    })

    expect(response.status).toBe(ACK_STATUS.applied)
    expect(response.json<AckAcceptedBody>().eventId).toBe(blockId)
    // Exactly the one column flip (plus the derived session count that follows from it),
    // and no row inserted from the body.
    expect(diffLogs(before, snapshotOf(store))).toEqual({
      added: [],
      removed: [],
      changed: [{ eventId: blockId, fields: ['ackState'] }],
      sessionsAdded: [],
      sessionsChanged: [{ sessionId: SESSION, fields: ['pendingCount'] }],
      pendingAdded: [],
      pendingRemoved: [blockId],
    })
  })
})

// ---------------------------------------------------------------------------
// The refusals: every other method, and every other path
// ---------------------------------------------------------------------------

describe('every other mutating method and path is refused (HC-FR-05)', () => {
  it('refuses every method no route serves on the ack path, changing nothing', async () => {
    const hub = await startFixtureHub()
    const store = observer(hub)
    const blockId = seedThreeClasses(store)
    const before = snapshotOf(store)
    const token = { [WRITE_TOKEN_HEADER]: tokenFor(hub) }

    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await call(hub.origin, {
        method,
        pathname: `/api/ack/${blockId}`,
        headers: token,
      })
      // Method-not-allowed rather than not-found: the honest answer to `PUT
      // /api/ack/x` is "that path is a write", and "no such path" would hide the surface
      // from a reviewer looking for write paths (src/hub/server.ts).
      expect([404, 405], `${method} answered ${response.status}`).toContain(response.status)
      expect(response.json<{ error: string }>().error).toMatch(/method-not-allowed|not-found/)
      if (method === 'OPTIONS') {
        // The one method whose answer is allowed to say what *is* served, so that a
        // client is not left guessing the surface.
        expect(String(response.headers['allow'] ?? '')).toContain('POST')
      }
    }
    // HEAD carries no body to assert on, and is answered the same way.
    expect(
      (await call(hub.origin, { method: 'HEAD', pathname: `/api/ack/${blockId}`, headers: token }))
        .status,
    ).toBe(405)

    expect(diffLogs(before, snapshotOf(store))).toEqual(NOTHING_CHANGED)
  })

  it('refuses every write-shaped path that is not the ack route, changing nothing', async () => {
    const hub = await startFixtureHub()
    const store = observer(hub)
    seedThreeClasses(store)
    const before = snapshotOf(store)
    const token = { [WRITE_TOKEN_HEADER]: tokenFor(hub) }

    // The routes somebody would add to drive an agent. Each one is a 404, because none
    // of them exists: the surface is closed, not filtered (APX-CON-08).
    for (const pathname of [
      '/api/steer',
      '/api/spawn',
      '/api/interrupt',
      '/api/approve',
      '/api/prompt',
      '/api/resolve',
      '/api/sessions/ses_ack_01/ack',
      '/api/pending/ack',
      '/api/ack',
      '/api/ack/one/two',
    ]) {
      const response = await call(hub.origin, { method: 'POST', pathname, headers: token })
      expect(response.status, pathname).toBe(404)
      expect(response.json<{ error: string }>().error).toBe('not-found')
    }

    expect(diffLogs(before, snapshotOf(store))).toEqual(NOTHING_CHANGED)
  })

  it('answers not-found for the empty identifier rather than acting on one', async () => {
    // The router filters empty segments, so `POST /api/ack/` reaches this handler with
    // no identifier. Asserted rather than left unremarked: it is a mutating path, and
    // two accepted spellings of one are worth knowing.
    const hub = await startFixtureHub()
    const store = observer(hub)
    seedThreeClasses(store)
    const before = snapshotOf(store)

    const response = await ack(hub, '')

    expect(response.status).toBe(ACK_STATUS['not-found'])
    expect(response.json<{ error: string }>().error).toBe('not-found')
    expect(diffLogs(before, snapshotOf(store))).toEqual(NOTHING_CHANGED)
  })
})

// ---------------------------------------------------------------------------
// The token on the control surface
// ---------------------------------------------------------------------------

describe('a write without the shared token is refused (HC-FR-06)', () => {
  it('answers 401 for a missing, wrong or duplicated token, changing nothing', async () => {
    const hub = await startFixtureHub()
    const store = observer(hub)
    const blockId = seedThreeClasses(store)
    const before = snapshotOf(store)
    const real = tokenFor(hub)

    const cases: {
      readonly label: string
      readonly headers: Readonly<Record<string, string | string[]>>
      readonly query?: string
    }[] = [
      { label: 'no header at all', headers: {} },
      { label: 'an empty value', headers: { [WRITE_TOKEN_HEADER]: '' } },
      { label: 'a wrong value', headers: { [WRITE_TOKEN_HEADER]: 'f'.repeat(64) } },
      { label: 'a value sharing a prefix', headers: { [WRITE_TOKEN_HEADER]: real.slice(0, 63) } },
      { label: 'the value with a suffix', headers: { [WRITE_TOKEN_HEADER]: `${real}0` } },
      { label: 'the value in another case', headers: { [WRITE_TOKEN_HEADER]: real.toUpperCase() } },
      { label: 'the value sent twice', headers: { [WRITE_TOKEN_HEADER]: [real, 'f'.repeat(64)] } },
      // The last case is the one the header exists to prevent: a token in a URL lands in
      // access logs, in browser history and in any copied link.
      { label: 'the value in a query string', headers: {}, query: real },
    ]

    for (const testCase of cases) {
      const response = await call(hub.origin, {
        method: 'POST',
        pathname: `/api/ack/${blockId}${testCase.query === undefined ? '' : `?token=${testCase.query}`}`,
        headers: testCase.headers,
      })
      expect(response.status, testCase.label).toBe(401)
      const body = response.json<{ error: string; message: string }>()
      expect(body.error, testCase.label).toBe('unauthorised')
      // The refusal names the header and never the value, and a body that echoed a guess
      // would leak a secret somebody got nearly right.
      expect(body.message, testCase.label).toContain(WRITE_TOKEN_HEADER)
      expect(response.text, testCase.label).not.toContain(real)
      expect(JSON.stringify(response.headers), testCase.label).not.toContain(real)
    }

    // Not one of those wrote anything: the check is the first statement in the handler.
    expect(diffLogs(before, snapshotOf(store))).toEqual(NOTHING_CHANGED)
  })

  it('accepts the token with any header casing and surrounding padding', async () => {
    // HTTP header names are case-insensitive and Node reports them lower-case, so a
    // client that spelled the header differently sent the header this product asks for;
    // a padded value is a transport artefact rather than a different token.
    const hub = await startFixtureHub()
    const store = observer(hub)
    const blockId = seedThreeClasses(store)
    const real = tokenFor(hub)

    const response = await call(hub.origin, {
      method: 'POST',
      pathname: `/api/ack/${blockId}`,
      headers: { 'X-Agent-Ping-Token': `  ${real}  ` },
    })

    expect(response.status).toBe(ACK_STATUS.applied)
    expect(response.json<AckAcceptedBody>().eventId).toBe(blockId)
  })
})

// ---------------------------------------------------------------------------
// The proof obligation: ack is the only route that changes stored state
// ---------------------------------------------------------------------------

describe('ack is the only route that changes stored state (APX-CON-08)', () => {
  it('records what every registered route did, and changes only through ack', async () => {
    const hub = await startFixtureHub()
    const store = observer(hub)
    const blockId = seedThreeClasses(store)
    const token = tokenFor(hub)

    // The registry the running hub holds. A hand-written list passes forever regardless
    // of what is registered, so this walks the real one.
    const records: {
      readonly signature: string
      readonly mutation: string
      readonly readOnly: boolean
      readonly answered: number
      readonly changed: string
    }[] = []

    for (const route of hub.registry.routes()) {
      for (const method of WALK_METHODS) {
        const before = snapshotOf(store)
        const resolution = hub.registry.resolve(method, concretePath(route.pattern, blockId))
        const answered = (await requestFor(hub, route.pattern, method, blockId, token)).status
        const diff = diffLogs(before, snapshotOf(store))

        // A route that serves this method answered it; every other method on this path
        // is refused, and a refusal is a promise too.
        if (resolution.kind === 'route') {
          expect(answered, `${method} ${route.pattern}`).toBeLessThan(400)
        } else {
          expect([404, 405], `${method} ${route.pattern} answered ${answered}`).toContain(answered)
        }

        records.push({
          signature: `${route.method} ${route.pattern}`,
          mutation: route.mutation,
          readOnly: route.mutation === 'read-only',
          answered,
          changed: describeDiff(diff),
        })

        // The one permitted change to an existing record: the ack route, on its own
        // method, applied.
        if (method === 'POST' && route.pattern === '/api/ack/:eventId') {
          expect(answered).toBe(ACK_STATUS.applied)
          expect(diff).toEqual({
            added: [],
            removed: [],
            changed: [{ eventId: blockId, fields: ['ackState'] }],
            sessionsAdded: [],
            // The one derived field: the session's pending count is a subquery over the
            // pending set, so it follows an acknowledgement without being written.
            sessionsChanged: [{ sessionId: SESSION, fields: ['pendingCount'] }],
            pendingAdded: [],
            pendingRemoved: [blockId],
          })
          continue
        }
        if (method === 'POST' && route.pattern === '/api/ingest') {
          // The append. It creates a row - and the session projection that row implies -
          // and changes nothing that already exists, which is what makes it not a
          // control surface (ADR-002). Its own session is a different one, so even the
          // derived projection cannot be confused with an edit.
          expect(diff.added, 'the append adds exactly one row').toHaveLength(1)
          expect(diff.changed).toEqual([])
          expect(diff.removed).toEqual([])
          expect(diff.sessionsAdded).toEqual([OTHER_SESSION])
          expect(diff.sessionsChanged).toEqual([])
          expect(diff.pendingAdded).toHaveLength(1)
          continue
        }
        // Everything else - every read, every refused method, every refused path -
        // leaves the whole log byte-identical.
        expect(diff, `${method} ${route.pattern} changed the log`).toEqual(NOTHING_CHANGED)
      }
    }

    // The recorded table, asserted rather than only walked. This is the inventory a
    // reviewer reads, and a route added without updating it fails here.
    const summary = records
      .map((record) => `${record.signature} [${record.mutation}] -> ${record.answered} (${record.changed})`)
      .sort()
    console.info(`[hub] route inventory:\n  ${summary.join('\n  ')}`)

    // Exactly two registered routes declare a mutation: the append and the control
    // surface. Everything else is a read. Deduplicated because the table holds one row
    // per route *and method*, and the inventory is a statement about routes.
    expect(
      [...new Set(records.filter((record) => !record.readOnly).map((record) => record.signature))],
    ).toEqual(['POST /api/ingest', 'POST /api/ack/:eventId'])
    // And the recorded answer for the control surface, on its own method: one row, one
    // field. Every other combination is `nothing`.
    expect(
      records
        .filter((record) => record.signature === MUTATING_ROUTE)
        .map((record) => `${record.answered} ${record.changed}`),
    ).toEqual([
      '405 nothing',
      `${ACK_STATUS.applied} ${blockId}.ackState session:${SESSION}.pendingCount`,
      '405 nothing',
      '405 nothing',
      '405 nothing',
    ])
    // Two routes moved anything at all, and only on the method they are declared for.
    expect(
      records.filter((record) => record.changed !== 'nothing').map((record) => record.signature),
    ).toEqual(['POST /api/ingest', 'POST /api/ack/:eventId'])

    // And the promised shape of the surface itself, from the running hub.
    expect([...hub.registry.signatures()].sort()).toEqual([
      'GET /',
      'GET /api/events',
      'GET /api/health',
      'GET /api/metrics',
      'GET /api/pending',
      'GET /api/sessions',
      'GET /api/sessions/:sessionId',
      'GET /api/stream',
      'POST /api/ack/:eventId',
      'POST /api/ingest',
    ])
    // Exactly one control surface, and it is the one the registry checks every
    // `ack-only` registration against.
    const control = hub.registry.routes().filter((route) => route.mutation === 'ack-only')
    expect(control.map((route) => `${route.method} ${route.pattern}`)).toEqual([MUTATING_ROUTE])
    expect([...MUTATING_ROUTES].sort()).toEqual(['POST /api/ack/:eventId', 'POST /api/ingest'])
  })

  it('refuses a second route that claims to change a record', () => {
    const registry = new RouteRegistry<HubServices>()
    registry.registerAll(ACK_ROUTES)
    expect(registry.signatures()).toEqual([MUTATING_ROUTE])
    // The closed set is a property of the code, not a convention: a second control
    // surface is a registration-time error rather than a review finding.
    expect(() =>
      registry.register({
        method: 'POST',
        pattern: '/api/resolve',
        name: 'ack.resolve',
        mutation: 'ack-only',
        handle: () => undefined,
      }),
    ).toThrow(/only mutating route/)
    // And a read cannot be a write in disguise.
    expect(() =>
      registry.register({
        method: 'DELETE',
        pattern: '/api/pending',
        name: 'ack.purge',
        mutation: 'read-only',
        handle: () => undefined,
      }),
    ).toThrow(/read-only/)
  })

  it('exposes no route that could steer, interrupt, prompt or approve anything', () => {
    // A promise about intent rather than about state, so it is asserted over the route
    // itself rather than over a comment (APX-CON-08, HC-US-03).
    const forbidden = /spawn|steer|interrupt|prompt|approve|resume|kill|send|control|execute|input|keypress/i
    const registry = new RouteRegistry<HubServices>()
    registry.registerAll(ACK_ROUTES)
    for (const route of registry.routes()) {
      expect(`${route.method} ${route.pattern} ${route.name}`).not.toMatch(forbidden)
    }
    // The route's own declared effect, in one line: mark a pending item acknowledged.
    // There is no second verb on it and no body it reads, so there is nothing for a
    // caller to have found.
    expect(ACK_ROUTE_DESCRIPTION).toBe(MUTATING_ROUTE)
    expect(ACK_ROUTES).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The answer table, as data
// ---------------------------------------------------------------------------

describe('the ack answer table', () => {
  it('answers every outcome with the status the table names', () => {
    expect(ACK_STATUS).toEqual({
      applied: 200,
      unchanged: 200,
      rejected: 409,
      'not-found': 404,
      unauthorised: 401,
      'internal-error': 500,
    })
    // Nothing in it answers 2xx for a transition that did not happen, and the only 5xx
    // is a fault rather than an answer about the state of a local file.
    expect(Object.values(ACK_STATUS).filter((status) => status >= 500)).toEqual([500])
  })

  it('has one fixed sentence per refusal, none of which can carry a value', () => {
    expect([...ACK_ERROR_CODES].sort()).toEqual([
      'conflict',
      'internal-error',
      'not-found',
      'unauthorised',
    ])
    for (const [code, message] of Object.entries(ACK_REFUSAL_MESSAGE)) {
      expect(message.length, code).toBeGreaterThan(0)
      // A refusal sentence is a literal in this file: no interpolation, no value, and in
      // particular no token and no caller-supplied identifier.
      expect(message, code).not.toMatch(/\$\{|\$\(/u)
      expect(message, code).not.toContain('undefined')
    }
    // And every code in the table has a sentence, so a new code cannot answer with
    // nothing at all.
    expect(Object.keys(ACK_REFUSAL_MESSAGE).sort()).toEqual([...ACK_ERROR_CODES].sort())
  })

  it('reports a store failure as a contentless 500 rather than a success', async () => {
    // A real failure, not a simulated one: the database is closed under a running hub,
    // which is what a machine that lost its disk looks like from this route. The
    // property is that an acknowledgement which did not happen is never reported as one
    // that did (APX-FR-02).
    const hub = await startFixtureHub()
    const store = observer(hub)
    const blockId = seedThreeClasses(store)
    const untouched = store.readPending().length
    hub.store.close()

    const response = await ack(hub, blockId)

    expect(response.status).toBe(ACK_STATUS['internal-error'])
    const body = response.json<{ error: string; message: string }>()
    expect(body.error).toBe('internal-error')
    // Contentless: a SQLite message carries the statement and the file path.
    expect(response.text).not.toContain(hub.databaseFilePath)
    expect(response.text).not.toMatch(/SQLITE|database/i)
    expect(response.text).not.toMatch(/Error|at /u)
    // And the row the caller named is still pending in the log the hub could not write.
    expect(store.readPending().length).toBe(untouched)
    expect(
      store.readPending().some((item) => item.eventId === blockId && item.ackState === 'unacknowledged'),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// NS-3: the card dismissal this route causes
// ---------------------------------------------------------------------------

/**
 * A structural Electron module, so the real composition root can build the real card
 * surface over a window that records.
 *
 * The same three things a real runtime provides and nothing else: a window with
 * `webContents`, a display's work area, and an `ipcMain` that answers the preload's
 * readiness announcement. The announcement is fired as the window is created, because a
 * real preload runs before any document script and the channel's readiness wait is a
 * safety net rather than the normal path (src/notify/surface/electron-host.ts).
 */
function stubElectron(): {
  readonly electron: Parameters<typeof electronDesktopBridge>[0]
  /** The messages sent on the card window's channel, in order. */
  readonly sent: { readonly channel: string; readonly payload: unknown }[]
  /** How many times the card window was hidden. */
  hides(): number
} {
  const sent: { readonly channel: string; readonly payload: unknown }[] = []
  const readyListeners: Array<() => void> = []
  let hides = 0
  class BrowserWindow {
    private gone = false
    constructor(options: unknown) {
      void options
      for (const listener of readyListeners.splice(0)) listener()
    }
    get webContents(): {
      send(channel: string, ...args: readonly unknown[]): void
      isDestroyed(): boolean
    } {
      return {
        send: (channel, ...args): void => {
          sent.push({ channel, payload: args[0] })
        },
        isDestroyed: (): boolean => this.gone,
      }
    }
    loadURL(): Promise<void> {
      return Promise.resolve()
    }
    showInactive(): void {}
    hide(): void {
      hides += 1
    }
    isDestroyed(): boolean {
      return this.gone
    }
    destroy(): void {
      this.gone = true
    }
    setBounds(): void {}
    setIgnoreMouseEvents(): void {}
  }
  // A tray that accepts the two calls the tray module makes and does nothing else, so the
  // real bridge can be mounted without the tray becoming the subject of this file.
  class TrayStub {
    setImage(): void {}
    setToolTip(): void {}
    setContextMenu(): void {}
    popUpContextMenu(): void {}
    on(): void {}
    destroy(): void {}
  }
  const electron = {
    BrowserWindow,
    screen: {
      getPrimaryDisplay: (): { workArea: { x: number; y: number; width: number; height: number } } => ({
        workArea: { x: 0, y: 32, width: 1920, height: 1048 },
      }),
    },
    nativeImage: { createFromBitmap: (): unknown => ({}) },
    Menu: { buildFromTemplate: (): unknown => ({}) },
    Tray: TrayStub,
    ipcMain: {
      on: (channel: string, listener: (event: unknown) => void): unknown => {
        if (channel !== CARD_CHANNEL_READY) return undefined
        readyListeners.push(() => listener({}))
        return undefined
      },
    },
  }
  return {
    electron: electron as unknown as Parameters<typeof electronDesktopBridge>[0],
    sent,
    hides: (): number => hides,
  }
}

/** A hub with a real card surface, and the messages its window was sent. */
async function startCardHub(): Promise<{
  readonly hub: RunningHub
  readonly sent: { readonly channel: string; readonly payload: unknown }[]
  readonly hides: () => number
}> {
  const stub = stubElectron()
  const hub = await startHub({
    stateDir: temporaryDirectory('agent-ping-state-'),
    dashboardRoot: dashboardFixture(),
    lifecycle: { installSignals: false, exit: (): void => undefined },
    // No `delivery` override: the notifier is the surface's own, resolved inside
    // `startHub` from the bridge this test just built.
    desktop: { isPrimaryInstance: true, ...electronDesktopBridge(stub.electron) },
  })
  openHubs.push(hub)
  return { hub, sent: stub.sent, hides: stub.hides }
}

/** The one write a client makes, without the token, for the refusal half. */
function ackWithoutToken(hub: RunningHub, eventId: string): Promise<Fetched> {
  return call(hub.origin, { method: 'POST', pathname: `/api/ack/${eventId}` })
}

/** The pending set's row keys, in a stable order. */
function pendingIds(hub: RunningHub): string[] {
  return hub.pending
    .readPending()
    .map((item) => item.eventId)
    .sort()
}

describe('a card comes off the screen only for an applied acknowledgement (NS-3)', () => {
  it('removes nothing for an unauthorised, a rejected or a not-found answer', async () => {
    const { hub, sent, hides } = await startCardHub()
    const store = observer(hub)
    // A real block, so a real card is on the screen before any of the refusals: a test
    // that asserted "removes nothing" against an empty surface would prove nothing.
    const blockId = seedThreeClasses(store)
    await call(hub.origin, {
      method: 'POST',
      pathname: '/api/ingest',
      body: JSON.stringify({
        harness: 'opencode',
        eventName: 'permission.asked',
        sessionId: SESSION,
        repoFullPath: REPO_PATH,
        transitionId: 'block-card',
        occurredAt: '2026-09-26T13:00:00.000Z',
      }),
    })
    await hub.ingest.idle()
    const cardId = hub.pending.readPending().find((item) => item.dedupeKey.endsWith('block-card'))?.eventId
    expect(cardId).toBeDefined()
    expect(sent.filter((message) => message.channel === CARD_CHANNEL_SHOW)).toHaveLength(1)
    expect(hides()).toBe(0)

    // The finished row this session also holds: acknowledging it is refused, because only
    // a pending item may be acknowledged (APX-CON-08), and the card on the screen is a
    // different block's - which is the case where a careless dismissal would take it down.
    const finishedId = store
      .readEventHistory({ limit: 10 })
      .find((event) => event.class === 'finished')?.eventId as string

    // 1. Unauthorised: no token at all. The check is the first statement in the handler,
    //    so nothing was read and nothing was written (HC-FR-06).
    let before = snapshotOf(store)
    expect((await ackWithoutToken(hub, cardId as string)).status).toBe(401)
    expect(diffLogs(before, snapshotOf(store))).toEqual(NOTHING_CHANGED)
    expect(sent.filter((message) => message.channel === CARD_CHANNEL_REMOVE)).toEqual([])
    expect(hides()).toBe(0)

    // 2. Not-found: an identifier that names no row, with the right token.
    before = snapshotOf(store)
    expect((await ack(hub, 'evt_no_such_row')).status).toBe(404)
    expect(diffLogs(before, snapshotOf(store))).toEqual(NOTHING_CHANGED)
    expect(sent.filter((message) => message.channel === CARD_CHANNEL_REMOVE)).toEqual([])
    expect(hides()).toBe(0)

    // 3. Rejected: a row this transition cannot apply to, for a block that is still
    //    pending and still showing.
    before = snapshotOf(store)
    const conflict = await ack(hub, finishedId)
    expect(conflict.status).toBe(409)
    expect(conflict.json<{ reason: string }>().reason).toBe('not-a-pending-item')
    expect(diffLogs(before, snapshotOf(store))).toEqual(NOTHING_CHANGED)
    expect(sent.filter((message) => message.channel === CARD_CHANNEL_REMOVE)).toEqual([])
    expect(hides()).toBe(0)
    // The card is still up, and both blocks are still pending: the surface answers the
    // block's state rather than the request's outcome (NT-FR-10). Both, because the block
    // this file seeded went in through a second connection and the one that was ingested
    // over the socket is the one the card is showing.
    expect(pendingIds(hub).sort()).toEqual([blockId, cardId].sort())

    // And the one that does apply takes it down, which is what makes the three above
    // refusals rather than a dismissal that never fires.
    const applied = await ack(hub, cardId as string)
    expect(applied.status).toBe(ACK_STATUS.applied)
    const removals = sent.filter((message) => message.channel === CARD_CHANNEL_REMOVE)
    expect(removals).toEqual([{ channel: CARD_CHANNEL_REMOVE, payload: { end: 'acknowledged' } }])
    expect(hides()).toBe(1)
    // The block that was seeded through the second connection was never shown - that
    // connection is outside the hub, so no delivery was made for it - and it is the only
    // one left pending.
    expect(pendingIds(hub)).toEqual([blockId])
  })
})

describe('the route surface is byte-identical with a card on the screen (NS-3)', () => {
  it('keeps the 200 body, empties the whole-log diff everywhere else, and the route list', async () => {
    const { hub } = await startCardHub()
    const store = observer(hub)
    const blockId = seedThreeClasses(store)
    const token = tokenFor(hub)

    // The 200 body: the same seven keys, asserted by name rather than by memory, because
    // a dismissal gave the handler something to say and the temptation to say it in the
    // answer is exactly what this criterion forbids (APX-FR-01, ADR-003).
    const applied = await ack(hub, blockId)
    expect(applied.status).toBe(ACK_STATUS.applied)
    expect(Object.keys(applied.json<AckAcceptedBody>()).sort()).toEqual([
      'ackState',
      'acknowledged',
      'eventId',
      'outcome',
      'pendingCount',
      'reason',
      'resolutionState',
    ])

    // The whole log, every registered route and every mutating method, on a hub whose
    // window exists and whose card is not wired to anything: the ack route's one column
    // and nothing else moves. A dismissal is a window operation, and this is where a
    // window operation that wrote a row would be caught.
    const changed: string[] = []
    for (const route of hub.registry.routes()) {
      for (const method of WALK_METHODS) {
        const before = snapshotOf(store)
        await requestFor(hub, route.pattern, method, blockId, token)
        const diff = diffLogs(before, snapshotOf(store))
        const signature = `${method} ${route.pattern}`
        if (method === 'POST' && route.pattern === MUTATING_ROUTE) {
          // The repeat acknowledgement is `unchanged`, so it flips nothing at all - and
          // the card is already down, so it removes nothing either (HC-FR-08).
          expect(diff, signature).toEqual(NOTHING_CHANGED)
          continue
        }
        if (method === 'POST' && route.pattern === '/api/ingest') {
          // The append, restated rather than skipped: it creates a row and changes nothing
          // that already exists, and the walk would be weaker if the one route that does
          // move the log were the one route left unasserted (ADR-002).
          expect(diff.added, signature).toHaveLength(1)
          expect(diff.changed, signature).toEqual([])
          expect(diff.removed, signature).toEqual([])
          expect(diff.sessionsChanged, signature).toEqual([])
          continue
        }
        if (describeDiff(diff) !== 'nothing') changed.push(`${signature} ${describeDiff(diff)}`)
      }
    }
    expect(changed).toEqual([])

    // And the surface itself, from the running hub: no route was added, removed or
    // renamed by the dismissal, and the control surface is still exactly one route.
    expect([...hub.registry.signatures()].sort()).toEqual([
      'GET /',
      'GET /api/events',
      'GET /api/health',
      'GET /api/metrics',
      'GET /api/pending',
      'GET /api/sessions',
      'GET /api/sessions/:sessionId',
      'GET /api/stream',
      'POST /api/ack/:eventId',
      'POST /api/ingest',
    ])
    expect(hub.registry.routes().filter((route) => route.mutation === 'ack-only')).toHaveLength(1)
  })

  it('carries the dismissal port in both services objects the composition root builds', async () => {
    // Criterion 9. The pre-bind object exists only between the claim and the bind, and no
    // request can arrive in that window, so a source read is the only way to see it - and
    // it is the only way that matters, because a port present in one of the two literals
    // and absent from the other is a field that exists until the socket is bound and then
    // stops existing. The two literals are located by their own markers and read to their
    // closing brace, so the assertion is about each object rather than about a count.
    const source = readModuleWithoutProse('src/main/index.ts')
    const literals = ['let services: HubServices = {', 'services = {'].map((marker) => {
      const start = source.indexOf(marker)
      expect(start, marker).toBeGreaterThan(-1)
      let depth = 0
      for (let index = source.indexOf('{', start); index < source.length; index += 1) {
        if (source[index] === '{') depth += 1
        else if (source[index] === '}') {
          depth -= 1
          if (depth === 0) return source.slice(start, index)
        }
      }
      throw new Error(`the services object beginning at "${marker}" is not closed`)
    })

    expect(literals).toHaveLength(2)
    for (const literal of literals) {
      // Every collaborator, and the port among them: the two objects are the whole of
      // what a handler is ever handed, so a field that differs between them is a field
      // that exists in one run and not the other.
      for (const field of [
        'store',
        'counters',
        'stream',
        'ingest',
        'pending',
        'delivery',
        'security',
        'dismissal',
        'hub',
      ]) {
        expect(literal, `a services object is missing ${field}`).toMatch(
          new RegExp(`^\\s{6}${field}[,:]`, 'm'),
        )
      }
    }
    // And the port is only declared, never built, in either of them: the one dismissal in
    // this product is built once at step 4a-bis, above the first literal.
    expect([...source.matchAll(/createCardDismissal\(/g)]).toHaveLength(1)
    expect(literals.some((literal) => literal.includes('createCardDismissal'))).toBe(false)
  })
})

/** The path a pattern addresses once its parameters are filled in. */
function concretePath(pattern: string, blockId: string): string {
  return pattern.replace(/:sessionId/g, SESSION).replace(/:eventId/g, blockId)
}

/** A one-line description of a diff, for the recorded inventory. */
function describeDiff(diff: LogDiff): string {
  const parts: string[] = []
  if (diff.added.length > 0) parts.push(`added:${diff.added.length}`)
  if (diff.removed.length > 0) parts.push(`removed:${diff.removed.length}`)
  for (const change of diff.changed) parts.push(`${change.eventId}.${change.fields.join('+')}`)
  for (const session of diff.sessionsAdded) parts.push(`session+${session}`)
  for (const session of diff.sessionsChanged) {
    parts.push(`session:${session.sessionId}.${session.fields.join('+')}`)
  }
  return parts.length === 0 ? 'nothing' : parts.join(' ')
}

/** The harness signal the ingest route is probed with during the walk. */
const INGEST_SAMPLE = {
  harness: 'opencode',
  eventName: 'permission.asked',
  sessionId: OTHER_SESSION,
  repoFullPath: REPO_PATH,
  transitionId: 'block-2',
  occurredAt: '2026-09-26T12:00:00.000Z',
}

/**
 * One request against a route, with whatever that route needs to be exercised.
 *
 * The token goes only to the ack route and a body only to the two POST routes, so the
 * walk cannot accidentally hand the write capability to a read. The stream is opened
 * and closed rather than waited on, because a response that never ends cannot be part
 * of a loop that is measuring the log around each request.
 */
function requestFor(
  hub: RunningHub,
  pattern: string,
  method: string,
  blockId: string,
  token: string,
): Promise<{ status: number }> {
  if (pattern === '/api/stream' && method === 'GET') return openStreamAndReadFirstFrame(hub)
  const isAck = pattern === '/api/ack/:eventId'
  const isIngest = pattern === '/api/ingest'
  const isPost = method === 'POST'
  return call(hub.origin, {
    method,
    pathname: concretePath(pattern, blockId),
    ...(isPost && isIngest ? { body: JSON.stringify(INGEST_SAMPLE) } : {}),
    ...(isPost && isAck ? { headers: { [WRITE_TOKEN_HEADER]: token } } : {}),
  })
}
