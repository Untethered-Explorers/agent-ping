// The read routes: the whole of the hub's HTTP surface in HC-1, and the reason
// an unauthenticated loopback port is not a remote control (HC-FR-02, APX-CON-01,
// APX-FR-01, ADR-002).
//
// Every route here is a read. None of them writes: not a session row, not an
// event, not a counter, not a file. That is not a promise in a comment - it is
// asserted by tests/hub/server.test.ts, which counts pending items and events
// through a second connection before and after every request on the enumerated
// route list. The three counters that do get recorded from real request paths
// (dashboard opens, deep links, toast deliveries, and a pending snapshot) live in
// their own table and are recorded by the paths that own them: HC-6. A read route
// that starts writing state breaks the promise the count comparison enforces, so
// this file has no writer in it and is not allowed to grow one.
//
// WHAT CROSSES THE WIRE
// The exact read shapes of the store, and nothing else. The store's shapes are
// themselves the persisted field set: harness, repository short name and full
// path, session identifier, class, optional subtype, raw event type, dedupe key,
// occurrence and receipt timestamps, and acknowledgement or resolution state
// (APX-FR-01, ADR-003). There is no field here that could carry a prompt, a
// response, tool output, a diff or a transcript, because there is no field here
// that is not one of those - the payload builders below construct fixed key sets
// rather than spreading a row, and tests/hub/server.test.ts asserts the key sets
// of real responses.
//
// BOUNDED MEANS BOUNDED
// `/api/events` and `/api/sessions/:id` are the two routes a client can ask for
// "everything" through, so both are bounded in the same three places: the route
// clamps what it was given, the store clamps again in the statement, and the
// bound is a named export that a test reads. A bound one layer down is a
// convention; a bound in three places is a property.
//
// The route table itself is the closed set of the product (PRD 6.3). Ingest, ack
// and the stream arrive in HC-3, HC-4 and HC-2, each registered into the same
// registry from the composition root, so the enumeration test sees all of them
// without this file knowing they exist.

import type { ServerResponse } from 'node:http'
import {
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  RECENT_EVENTS_MAX,
  type EventRecord,
  type EventStore,
  type PendingItem,
  type SessionDetail,
  type SessionSummary,
} from '../../storage/eventStore.js'
import type { Counters, CounterReading } from '../../storage/counters.js'
import type { ChangeFeed } from '../sse.js'
import type { IngestService } from '../ingest-service.js'
import { respondJson, type RouteDefinition } from '../server.js'

/**
 * What a read route is given beyond the request itself.
 *
 * The store, the counters and the state change feed are the only collaborators,
 * and all three are typed accessors rather than handles. A route cannot reach a
 * database handle, so no read route can grow a statement of its own - which is
 * also why a new query is a change to the store's closed API rather than
 * something a route invents.
 *
 * `stream` is the live feed the stream route (HC-FR-03) subscribes to. It is
 * declared here rather than in src/hub/routes/stream.ts because `HubServices` is
 * the one description of what a handler is given, and a handler that reached for
 * a feed that was not in it would be a second, unregistered way to get one.
 *
 * `hub` is the identity the server published: the loopback origin the adapters
 * read out of the runtime file, plus enough of the hub's own state for `doctor` to
 * print a diagnosis without a second process (IO-2).
 */
export interface HubServices {
  readonly store: EventStore
  readonly counters: Counters
  /** The live state stream's feed: cursors, the replay window, the clients. */
  readonly stream: ChangeFeed
  /**
   * The ingest pipeline (HC-FR-04).
   *
   * Declared here rather than in src/hub/routes/ingest.ts for the same reason
   * `stream` is: `HubServices` is the one description of what a handler is given, and
   * a handler that reached for a pipeline which was not in it would be a second,
   * unregistered way to build one. Only the ingest route calls it, and only the
   * composition root constructs it.
   */
  readonly ingest: IngestService
  readonly hub: HubIdentity
}

/**
 * The hub's own reported state. Counts and timestamps only.
 *
 * `servedRequests` is a function rather than a number because it is read when the
 * request is answered: a snapshot taken at construction would be permanently
 * stale, and a stale number in a health payload is worse than no number.
 */
export interface HubIdentity {
  readonly instanceId: string
  readonly pid: number
  readonly host: string
  readonly port: number
  readonly origin: string
  readonly startedAt: string
  readonly schemaVersion: number
  /** True when the previous log file was unreadable and was rebuilt (EL-FR-11). */
  readonly rebuiltFromMigrations: boolean
  readonly dashboardRoot: string | null
  servedRequests(): number
}

/**
 * The health payload.
 *
 * `status` is `ok` or `degraded`, and a degraded hub still answers 200. That is
 * deliberate: the question a doctor run asks is whether the hub is alive, and a
 * 503 from a hub that is alive and holding an unreadable log would collapse two
 * different faults into one. The `database.readable` field is how the two are
 * told apart.
 *
 * `delivery` is the seam HC-5 fills with the real delivery status. It says
 * `not-wired` until then rather than being absent, so a doctor run against this
 * build can tell "delivery is not implemented yet" from "the field was forgotten".
 */
export interface HealthPayload {
  readonly status: 'ok' | 'degraded'
  readonly instanceId: string
  readonly pid: number
  readonly host: string
  readonly port: number
  readonly origin: string
  readonly startedAt: string
  readonly uptimeSeconds: number
  readonly requests: number
  readonly database: {
    readonly filePath: string
    readonly schemaVersion: number
    readonly rebuiltFromMigrations: boolean
    readonly readable: boolean
    readonly sessionCount: number | null
    readonly pendingCount: number | null
  }
  readonly dashboard: {
    readonly available: boolean
    readonly root: string | null
  }
  readonly delivery: {
    readonly status: 'not-wired'
  }
}

export interface SessionsPayload {
  readonly sessions: readonly SessionSummary[]
  readonly count: number
}

export interface SessionDetailPayload {
  readonly session: SessionDetail
  readonly recentEventsLimit: number
}

export interface PendingPayload {
  readonly items: readonly PendingItem[]
  readonly count: number
}

export interface EventHistoryPayload {
  readonly events: readonly EventRecord[]
  readonly count: number
  /** The effective page size after clamping, echoed so a client can page. */
  readonly limit: number
  readonly sessionId: string | null
}

export interface MetricsPayload {
  readonly counters: readonly CounterReading[]
}

/**
 * Every read route, in one array.
 *
 * Registration is the composition root's job (src/main/index.ts), which is the
 * one place a route enters the product; this array is what it registers. The
 * names are the ones the enumeration test and the diagnostics use, so they are
 * stable identifiers rather than labels.
 */
export const READ_ROUTES: readonly RouteDefinition<HubServices>[] = [
  {
    method: 'GET',
    pattern: '/api/sessions',
    name: 'read.sessions',
    mutation: 'read-only',
    handle: ({ services, response }): void => {
      const sessions = services.store.readSessionSummaries()
      respond(response, 200, { sessions, count: sessions.length } satisfies SessionsPayload)
    },
  },
  {
    method: 'GET',
    pattern: '/api/sessions/:sessionId',
    name: 'read.session',
    mutation: 'read-only',
    handle: ({ services, response, params }): void => {
      const sessionId = params['sessionId'] ?? ''
      const session = services.store.readSession(sessionId)
      if (session === null) {
        respond(response, 404, { error: 'not-found', message: 'no such session.' })
        return
      }
      respond(response, 200, {
        session,
        recentEventsLimit: RECENT_EVENTS_MAX,
      } satisfies SessionDetailPayload)
    },
  },
  {
    method: 'GET',
    pattern: '/api/pending',
    name: 'read.pending',
    mutation: 'read-only',
    handle: ({ services, response }): void => {
      // The single source of truth for the tray badge (NT-FR-05): the same
      // accessor, on the same file, that the badge reads.
      const items = services.store.readPending()
      respond(response, 200, { items, count: items.length } satisfies PendingPayload)
    },
  },
  {
    method: 'GET',
    pattern: '/api/events',
    name: 'read.events',
    mutation: 'read-only',
    handle: ({ services, response, query }): void => {
      const limit = parseLimit(query.get('limit'), HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT)
      const sessionId = query.get('sessionId')
      const events = services.store.readEventHistory(
        sessionId === null || sessionId === '' ? { limit } : { limit, sessionId },
      )
      respond(response, 200, {
        events,
        count: events.length,
        limit,
        sessionId: sessionId === null || sessionId === '' ? null : sessionId,
      } satisfies EventHistoryPayload)
    },
  },
  {
    method: 'GET',
    pattern: '/api/metrics',
    name: 'read.metrics',
    mutation: 'read-only',
    // Registered here because HC-FR-02 lists the counters among the read routes.
    // HC-6 owns the recording side, in src/hub/metrics.ts, and extends this
    // payload; the route itself stays where the read surface is declared so there
    // is still one list of routes.
    handle: ({ services, response }): void => {
      respond(response, 200, { counters: services.counters.read() } satisfies MetricsPayload)
    },
  },
  {
    method: 'GET',
    pattern: '/api/health',
    name: 'read.health',
    mutation: 'read-only',
    handle: ({ services, response }): void => {
      respond(response, 200, readHealth(services))
    },
  },
]

/**
 * The health read, separated from the route so a test can drive it with an
 * injected clock and assert the payload's shape without a socket.
 *
 * A store that cannot be read is reported as `degraded` with null counts rather
 * than as a 500: the counts are unknown, and saying so is more useful to `doctor`
 * than an error body (APX-FR-02, HC-FR-07).
 */
export function readHealth(services: HubServices, now: Date = new Date()): HealthPayload {
  const { hub } = services
  let readable = true
  let sessionCount: number | null = null
  let pendingCount: number | null = null
  try {
    sessionCount = services.store.readSessionSummaries().length
    pendingCount = services.store.readPending().length
  } catch {
    readable = false
  }
  const startedAt = Date.parse(hub.startedAt)
  const uptimeSeconds = Number.isNaN(startedAt)
    ? 0
    : Math.max(0, Math.round((now.getTime() - startedAt) / 1000))
  return {
    status: readable ? 'ok' : 'degraded',
    instanceId: hub.instanceId,
    pid: hub.pid,
    host: hub.host,
    port: hub.port,
    origin: hub.origin,
    startedAt: hub.startedAt,
    uptimeSeconds,
    requests: hub.servedRequests(),
    database: {
      filePath: services.store.filePath,
      schemaVersion: services.store.schemaVersion,
      rebuiltFromMigrations: hub.rebuiltFromMigrations,
      readable,
      sessionCount,
      pendingCount,
    },
    dashboard: {
      available: hub.dashboardRoot !== null,
      root: hub.dashboardRoot,
    },
    delivery: { status: 'not-wired' },
  }
}

/**
 * Read a page size from a query string and fold it into [default, maximum].
 *
 * A client that asks for too much gets the largest page this product serves
 * rather than an error, and a client that asks for something that is not a number
 * gets the ordinary default. Neither can widen the bound, which is the property
 * that matters; a read route that fails a dashboard over a bad `limit` would be a
 * worse trade than a smaller page.
 */
export function parseLimit(raw: string | null, fallback: number, maximum: number): number {
  if (raw === null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  const whole = Math.floor(parsed)
  if (whole < 1) return fallback
  return Math.min(whole, maximum)
}

/**
 * Write a JSON response.
 *
 * The store's shapes are already content-free, so this serialises what it is
 * given without adding a field: there is no wrapper object, no echoed request and
 * no per-request payload here, which is the same rule the metrics payload follows
 * (APX-FR-01, APX-CON-12).
 */
function respond(response: ServerResponse, status: number, body: unknown): void {
  // The store's shapes are already content-free, so this serialises what it is
  // given without adding a field: there is no wrapper object, no echoed request and
  // no per-request payload here, which is the same rule the metrics payload follows
  // (APX-FR-01, APX-CON-12).
  respondJson(response, status, body)
}
