// `GET /api/metrics`: the local counters PRD 11 measures the product against, and
// nothing else (HC-FR-02, HC-6, EL-FR-10, PRD 11, APX-FR-01, APX-CON-12).
//
// WHAT THIS ROUTE SERVES
// A name, a count and an instant for each of the four counters, plus the instant
// the payload was assembled. That is the whole payload, and it is a fixed key set
// rather than a spread of a row: the payload builders construct it field by field,
// so a field cannot appear here without someone writing it.
//
// The shape is counters.ts's `CounterReading` rather than a restatement of it
// (domain-engineer's EL-FR-10, `value` and `updatedAt` in that order, one reading
// per name in the closed union). Restating it would be a second list to keep in
// step, and this route is the one that hands these values to whatever asks.
//
// WHY THE RECORDING IS NOT HERE
// Which of the four counters moved is decided in ../metrics.ts, from the paths that
// move them, and this file never writes. It holds no `MetricsRecorder`: a read route
// that could increment a counter is a read route that mutates, and HC-FR-02's
// promise is that the counters are the only thing in this product a request path
// writes - which is exactly why they are recorded by the owning paths rather than
// by a route that happens to serve them.
//
// WHY THE ROUTE LIVES IN ITS OWN FILE
// It is still the same route, with the same name and the same position in the
// registry's order, and the composition root registers it from READ_ROUTES exactly
// as before (src/hub/routes/read.ts). It is its own module so the whole of the
// metrics surface - the payload, its bounds and the route that serves it - is one
// file a reviewer can read, and so the recording side and the serving side are
// visibly different files with different privileges.
//
// IT IS A READ
// Declared `read-only` and answered by a GET, and proven rather than promised:
// tests/hub/server.test.ts walks the enumerated registry and compares stored
// counts through a second connection before and after every request on it,
// including this one. The counters table is a separate table from the log and is
// not what that comparison reads, which is the point: reading the counters must
// not move the log, and reading the log must not be what moves the counters.
//
// NOTHING LEAVES AND NOTHING IS ECHOED
// There is no wrapper around the request, no echo of the query, no per-request
// payload and no field carrying a session, a repository, a harness, an event
// identifier or any text at all. tests/hub/metrics.test.ts asserts the exact key
// set of the payload and of every reading, that every value is a number, a
// closed token or an ISO 8601 instant, and that a request carrying a session id
// and a repository path in its query gets back a body containing neither
// (APX-FR-01, APX-CON-12).

import type { Counters, CounterReading } from '../../storage/counters.js'
import { respondJson, type RouteDefinition } from '../server.js'
import type { HubServices } from './read.js'

/**
 * The metrics payload, in full.
 *
 * Two fields, and the second is the only one this file added to HC-1's original
 * `{ counters }`: the instant the reading was taken, so a reader can tell a counter
 * that has not moved in an hour from one that was read a second ago, and so two
 * readings of the same payload are never silently different snapshots. A timestamp
 * is the one addition that cannot carry content.
 */
export interface MetricsPayload {
  readonly counters: readonly CounterReading[]
  /** When this payload was assembled. ISO 8601 UTC. */
  readonly generatedAt: string
}

/**
 * The slice of the services this route needs: the counters accessor and nothing
 * else.
 *
 * Narrower than `HubServices` on purpose. A route that can be handed an `EventStore`
 * can be handed one, and the argument for the read-only promise is that no read
 * route can reach a mutation; a route that cannot even see the store cannot be
 * argued with on that point.
 */
export interface MetricsReader {
  readonly counters: Counters
}

/**
 * Build the payload, apart from the socket.
 *
 * Split out from the handler for the same reason health's is: the shape can then be
 * asserted with an injected clock and no request, and the four counters are read
 * through the same accessor a test and `doctor` use.
 */
export function readMetrics(
  services: MetricsReader,
  now: Date = new Date(),
): MetricsPayload {
  return {
    // Four readings in the closed union's order, whether or not each has been
    // recorded: a never-recorded counter reads as 0 with no timestamp, so a client
    // can tell "nothing has happened yet" from "this is not one we keep" without a
    // second request (src/storage/counters.ts).
    counters: services.counters.read(),
    generatedAt: now.toISOString(),
  }
}

/**
 * The metrics route, in the same shape as every other read route so the
 * composition root registers it from the same list and the enumeration test sees
 * it (HC-FR-02).
 */
export const METRICS_ROUTES: readonly RouteDefinition<HubServices>[] = [
  {
    method: 'GET',
    pattern: '/api/metrics',
    name: 'read.metrics',
    mutation: 'read-only',
    handle: ({ services, response }): void => {
      respondJson(response, 200, readMetrics(services))
    },
  },
]
