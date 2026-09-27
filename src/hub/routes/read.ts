// The read routes: the whole of the hub's HTTP surface in HC-1, and the reason
// an unauthenticated loopback port is not a remote control (HC-FR-02, APX-CON-01,
// APX-FR-01, ADR-002).
//
// Every route here is a read. None of them writes: not a session row, not an
// event, not a counter, not a file. That is not a promise in a comment - it is
// asserted by tests/hub/server.test.ts, which counts pending items and events
// through a second connection before and after every request on the enumerated
// route list. The four counters that do get recorded from real request paths
// (dashboard opens, deep-link opens, toast deliveries and a pending-count
// snapshot) live in their own table and are recorded by the paths that own them:
// the dashboard route's document handler, the delivery policy's outcome and a
// wrapper around the store (HC-6, ../metrics.ts). A read route that starts writing
// state breaks the promise the count comparison enforces, so this file has no
// writer in it and is not allowed to grow one - which is why `/api/metrics`, whose
// recording side is the busiest of the four, is served from its own module and
// still cannot write.
//
// SINCE NS-3: A PORT, WHICH IS NOT A WRITER
// `HubServices` also carries the card dismissal port, because the ack route has to be
// able to take a needs-you card off the screen when a block is acknowledged
// (NT-FR-12). What this file gained is a *declaration* of it: there is no dismissal
// here, no implementation, and nothing in this module that changes a row, a counter
// or a file. The one place a card is taken down is src/notify/surface/dismissal.ts, and
// the same object reaches the surface notifier and the ack route, so there is one
// dismissal in the product rather than one per caller. Nothing in the read routes
// reaches it, and the walk in tests/hub/ack.test.ts asserts the whole log is unchanged
// by every one of them with a card on the screen.
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
//
// `/api/health` is the one route whose *payload* is assembled by the tasks around it:
// HC-1 gave it the database section, HC-5 filled in the server and delivery sections
// and wired the delivery policy into `HubServices`. It stays a read-only GET, it
// still carries nothing that could be content, and the whole route is still in this
// file - the one list a reviewer reads to see what a client can ask for.

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
import type { Counters } from '../../storage/counters.js'
import { METRICS_ROUTES } from './metrics.js'
import type { ChangeFeed } from '../sse.js'
import type { IngestService } from '../ingest-service.js'
import type { DeliveryStatus } from '../delivery.js'
import type { HubState } from '../lifecycle.js'
import type { HubSecurity } from '../security.js'
import type { PendingLifecycle } from '../../domain/pending.js'
import type { CardDismissalPort } from '../../notify/surface/dismissal.js'
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
  /**
   * The pending lifecycle (HC-FR-05).
   *
   * The ack route's only collaborator, and declared here for the reason `ingest` is:
   * the one description of what a handler is given. It is built by the composition
   * root over the same change-feed-wrapped store the read routes use, so an
   * acknowledgement becomes a live stream frame without either route knowing the
   * stream exists. The ingest pipeline holds a second lifecycle of its own, which is
   * interchangeable with this one: it is stateless, and every read it does goes to
   * the store (src/domain/pending.ts).
   */
  readonly pending: PendingLifecycle
  /**
   * The delivery policy (HC-FR-07).
   *
   * The health route's only collaborator here, and declared in `HubServices` for the
   * reason `ingest` is: the one description of what a handler is given. A route that
   * reached for a policy which was not in it would be a second, unregistered way to
   * build one - and the policy is the only thing in this product that can call a
   * notifier, so a second one would be a second way to interrupt a developer.
   */
  readonly delivery: DeliveryStatusReader
  /**
   * The security boundary (HC-FR-06): the per-install write token, the header it
   * travels in, and the one function that judges a write. The ack route is its only
   * caller, and a route that needs the boundary has to be handed it here - there is
   * no ambient way to reach it.
   */
  readonly security: HubSecurity
  /**
   * The card dismissal port (NT-FR-12).
   *
   * The one thing a route may ask of the notification surface: take one session's card
   * off the screen, naming the end. It is here for the reason `pending` is - `HubServices`
   * is the one description of what a handler is given, and the ack route is the ack
   * route's own collaborator rather than something it reaches for on the side.
   *
   * Narrow on purpose. It cannot show a card, cannot deliver anything, cannot read a row
   * and cannot change one, and it records no counter: the whole of its effect is a
   * removal and a `hide` on a window this product owns (NT-FR-10). A route that needed
   * more than "this card is no longer wanted" is asking for a second delivery path, and
   * the delivery policy - which `HubServices.delivery` is narrowed to `status()` on
   * precisely so a route calling `deliver` is a compile error - is not where to look
   * (APX-CON-08, ADR-002).
   *
   * This file gains a *declaration* and not a writer: there is no dismissal here, no
   * implementation, and nothing in this module that changes anything. The one place a
   * card is taken down is src/notify/surface/dismissal.ts, and the composition root is
   * what hands the same object to the surface notifier and to both of the services
   * objects built here.
   */
  readonly dismissal: CardDismissalPort
  readonly hub: HubIdentity
}

/**
 * The slice of the delivery policy a read route may hold.
 *
 * `status()` only, and deliberately: the health route reports counts, and the
 * policy's per-event ledger and its `deliver` method are not a read route's business.
 * Narrowing the type here rather than importing the whole policy is what makes it a
 * compile error for a future read route to call `deliver` - a route that could
 * interrupt the developer would be the loudest possible regression (APX-CON-08,
 * ADR-002).
 */
export interface DeliveryStatusReader {
  status(): DeliveryStatus
}

/**
 * The hub's own reported state. Counts and timestamps only.
 *
 * `servedRequests`, `listening` and `state` are functions rather than values because
 * they are read when the request is answered: a snapshot taken at construction would
 * be permanently stale, and a stale number in a health payload is worse than no
 * number. The same is true of `state`, which changes at most twice in a run but can
 * change while a doctor request is being built.
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
  /** Whether the loopback listener is still accepting connections (HC-FR-07). */
  listening(): boolean
  /** PRD 10's lifecycle state, read from the shutdown path (HC-FR-10). */
  state(): HubState
}

/**
 * The health payload: what `doctor` reads, in the three sections HC-FR-07 names -
 * database, server and delivery.
 *
 * `status` is `ok` or `degraded`, and a degraded hub still answers 200. That is
 * deliberate: the question a doctor run asks is whether the hub is alive, and a 503
 * from a hub that is alive and holding an unreadable log would collapse two different
 * faults into one. The `database.readable` field is how the two are told apart.
 *
 * The top-level `status` follows PRD 10's own definition of `degraded` - the database
 * is unavailable - rather than widening it to cover a failed delivery. A delivery
 * failure is reported in `delivery.status` instead, because the two are different
 * facts with different remedies: one needs the log reopened, the other needs a window
 * that will show a card. A doctor run reads both, and a hub whose surface failed once
 * is not the same thing as a hub that cannot read its own log.
 *
 * Every field is a count, a timestamp, a path the local user already knows, a row key
 * or a closed token. None of them can carry conversation content (APX-FR-01,
 * APX-CON-12).
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
  readonly server: {
    readonly host: string
    readonly port: number
    readonly origin: string
    readonly listening: boolean
    /** PRD 10's state: starting, running, stopping or stopped. */
    readonly state: HubState
    readonly servedRequests: number
  }
  readonly dashboard: {
    readonly available: boolean
    readonly root: string | null
  }
  /**
   * The delivery policy's own status, verbatim (HC-FR-07, NT-FR-09).
   *
   * The policy's shape rather than a restatement of it, so a field the policy starts
   * reporting is reported here and a field it stops reporting disappears, with no
   * second list in a route to keep in step. `lastFailure` names a row key and a closed
   * reason token: enough for `doctor` to say which block nobody was told about, and
   * nothing that could carry a message (APX-FR-01).
   */
  readonly delivery: DeliveryStatus
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
  // HC-FR-02 lists the counters among the read routes, so the metrics route is
  // registered from this list like every other one. Its own module
  // (./metrics.ts) is where the payload and its bounds live, and where the
  // recording side is visibly absent: the route is a read, and a read route that
  // could increment a counter would be a read route that mutates.
  ...METRICS_ROUTES,
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
 *
 * Every other read route keeps failing loudly on a closed log rather than degrading
 * quietly to an empty answer, and that asymmetry is deliberate: health is the
 * diagnostic route, and its job is to say what is wrong, while a client that gets a
 * 500 from `/api/pending` knows its request failed and a client that got an empty 200
 * would not.
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
    server: {
      host: hub.host,
      port: hub.port,
      origin: hub.origin,
      listening: hub.listening(),
      state: hub.state(),
      servedRequests: hub.servedRequests(),
    },
    dashboard: {
      available: hub.dashboardRoot !== null,
      root: hub.dashboardRoot,
    },
    delivery: services.delivery.status(),
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
