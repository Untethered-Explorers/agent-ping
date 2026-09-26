// `POST /api/ack/:eventId`: the only route in agent-ping that can change a record
// that already exists, and the whole of the product's control surface
// (HC-FR-05, APX-CON-08, ADR-002, PRD 6.3).
//
// WHAT IT DOES
// One thing: it marks one pending item acknowledged, through the pending lifecycle
// (src/domain/pending.ts), which is the only state machine a block passes through.
// The lifecycle's update is guarded in the store to `class = 'needs-you'`, so this
// route cannot mark a finished or an fyi row, and it cannot record a resolution -
// a resolution is a fact the harness reported, never an instruction this product
// sends anybody.
//
// The identifier is in the path and the token is in a header. That is the entire
// request: there is no body, no query, and no field of a caller's request is read
// except the row key. A body that arrives anyway is discarded rather than buffered
// (`request.resume()` below), because a route that reads no body must still not
// hold one. Everything a client sends is therefore incapable of being interpreted,
// which is what makes "it can only mark a pending item acknowledged" a property
// rather than an intention.
//
// THE ANSWER TABLE, IN FULL
//   200  the row is acknowledged. `outcome` distinguishes the transition that
//        recorded the fact (`applied`) from the one that found it already recorded
//        (`unchanged`) - a double acknowledgement must never look like a second
//        count, and never must it look like a failure to a dashboard that retried
//        (HC-FR-08).
//   401  the write token was missing, duplicated or wrong. Nothing was read and
//        nothing was written, because the check is the first statement in the
//        handler (HC-FR-06).
//   404  no such event identifier. Nothing was written.
//   409  the row is in a state this transition cannot apply to: already resolved
//        by the harness, or not a pending item at all. Both are the lifecycle's
//        `rejected`, told apart by `reason`, and neither writes anything.
//   500  the log could not be written, or a fault nobody anticipated. Reported, and
//        deliberately contentless (APX-FR-02).
//
// There is no status for "please try again later" on a state question: the store is
// local and synchronous, so every answer here is a fact about the log rather than
// about a remote service.
//
// NOTHING THIS ROUTE CAN REACH
// No outbound connection, no subprocess, no harness, no agent, and no second way to
// change a record. The registry refuses to register any other route that declares
// `ack-only` (src/hub/server.ts), so a second control surface is a registration-time
// error rather than a review finding. `POST /api/ingest` is the other mutating
// route and it *appends*: it creates a row and changes nothing that already exists,
// which is why it needs no token (ADR-002). Every other method on this path is 405
// and every other path is 404, both answered before this handler exists.
//
// WHAT CROSSES THE WIRE
// A row key the store generated (a UUID), a class, a subtype, two state literals,
// a reason from the pending lifecycle's own table, and a count. There is no field
// here that could carry a prompt, a response, tool output, a diff or a transcript,
// and the value echoed as `eventId` is the *store's* row key rather than the text
// the caller sent - so a caller cannot get its own input reflected back through
// this response (APX-FR-01, ADR-003). Every refusal sentence is a literal in this
// file, and the token is never in any of them.

import type { AckState, ResolutionState } from '../../storage/eventStore.js'
import type {
  PendingTransitionOutcome,
  PendingTransitionReason,
  PendingTransitionResult,
} from '../../domain/pending.js'
import { respondJson, type RouteContext, type RouteDefinition } from '../server.js'
import type { HubServices } from './read.js'

/**
 * The status every outcome answers with, in one table.
 *
 * `Record<..., number>` over a union that includes the boundary's own refusals, so a
 * new outcome is a compile error until someone decides what a client is told about
 * it. Nothing in it answers 2xx for a transition that did not happen, and nothing
 * in it answers 5xx for a question about state: the log is a local file and a
 * failure to read it is a fault (HC-FR-05, APX-FR-02).
 */
export const ACK_STATUS: Readonly<
  Record<PendingTransitionOutcome | 'unauthorised' | 'internal-error', number>
> = {
  applied: 200,
  unchanged: 200,
  rejected: 409,
  'not-found': 404,
  unauthorised: 401,
  'internal-error': 500,
}

/** The error codes this route answers with, in the vocabulary it uses. */
export const ACK_ERROR_CODES = [
  'unauthorised',
  'not-found',
  'conflict',
  'internal-error',
] as const

export type AckErrorCode = (typeof ACK_ERROR_CODES)[number]

/**
 * The fixed sentence for each refusal.
 *
 * Never a value from the request, and never the token: `token-missing`,
 * `token-duplicated` and `token-invalid` are three internal codes that all answer
 * with the same sentence on purpose. A client that cannot tell them apart learns
 * nothing about the value it guessed, and a body that echoes the guess is a body
 * that leaks a secret somebody got nearly right.
 */
export const ACK_REFUSAL_MESSAGE: Readonly<Record<AckErrorCode, string>> = {
  // The header name is spelled out rather than interpolated, because this is a table of
  // literals and a refusal body built from a value is a refusal body that can carry one.
  // tests/hub/ack.test.ts asserts this sentence still names `WRITE_TOKEN_HEADER`, so a
  // renamed header fails there rather than leaving a stale instruction in an answer.
  unauthorised:
    'this write needs the per-install hub write token, sent in the ' +
    'x-agent-ping-token request header. Read routes need no token; this one is the only route ' +
    'that can change a record (HC-FR-06).',
  'not-found': 'no such event identifier, so nothing was changed.',
  conflict:
    'that item is not a pending item this acknowledgement can apply to, so nothing was changed. ' +
    'The reason says which state it is in (HC-FR-05).',
  'internal-error':
    'the hub could not complete this acknowledgement. Nothing was changed, and the fault is ' +
    'reported rather than swallowed (APX-FR-02).',
}

/**
 * The 200 body: the transition, the row's own state, and the count after it.
 *
 * A fixed key set, asserted exactly by tests/hub/ack.test.ts. `eventId` is the
 * store's row key rather than the requested text, and is null when there is no row
 * at all - which is what keeps a caller-chosen identifier from being reflected into
 * a payload this product serves.
 */
export interface AckAcceptedBody {
  /** True only when the row is acknowledged as a result of this request. */
  readonly acknowledged: boolean
  readonly eventId: string | null
  readonly outcome: PendingTransitionOutcome
  readonly reason: PendingTransitionReason
  readonly ackState: AckState | null
  readonly resolutionState: ResolutionState | null
  /** The store's pending count after the attempt: the badge's single source of truth. */
  readonly pendingCount: number
}

/** A refusal, or a transition that could not be applied. */
export interface AckErrorBody {
  readonly error: AckErrorCode
  readonly message: string
  /** The lifecycle's reason, when the answer is about the row's state. */
  readonly reason?: PendingTransitionReason
  /** The store's row key, when a row was found. Never the requested text. */
  readonly eventId?: string | null
}

/**
 * The ack route, in the same shape as every other route so the composition root
 * registers it from one list and the enumeration test sees it (HC-FR-05).
 */
export const ACK_ROUTES: readonly RouteDefinition<HubServices>[] = [
  {
    method: 'POST',
    pattern: '/api/ack/:eventId',
    name: 'ack.pending',
    // `ack-only`, and the registry refuses this declaration on any other path: the
    // mutating set is a closed union, so a second control surface cannot be
    // registered by accident (APX-CON-08).
    mutation: 'ack-only',
    handle: (context): void => serveAck(context),
  },
]

/**
 * One acknowledgement, end to end.
 *
 * Synchronous on purpose. The store is a local file behind a synchronous driver and
 * the lifecycle is synchronous, so there is nothing to await, and a handler that
 * returned a promise would only add a turn of the event loop between the store
 * write and the answer.
 *
 * Never throws: every fault is an answered response, because a rejection would reach
 * the listener's catch and become a contentless 500 - right for an unanticipated
 * fault, wrong for a request the caller can fix.
 */
function serveAck({ request, response, params, services }: RouteContext<HubServices>): void {
  // The body is discarded rather than read. The identifier is in the path and the
  // token is in a header, so no byte of a request body is interpreted by this route,
  // and `resume` is what keeps a client that sent one from having it buffered here.
  request.resume()

  // 1. The boundary, before anything is read and before anything is written. A
  //    refused write never reaches the store, so it cannot have changed a record.
  const verdict = services.security.authorise(request.headers)
  if (!verdict.allowed) {
    respondJson(response, ACK_STATUS.unauthorised, {
      error: 'unauthorised',
      message: ACK_REFUSAL_MESSAGE.unauthorised,
    } satisfies AckErrorBody)
    return
  }

  // 2. The transition, through the lifecycle. The only store call reachable from
  //    here is the guarded acknowledgement, so the only durable effect a caller can
  //    cause is one column flip on one pending row.
  let transition: PendingTransitionResult
  try {
    transition = services.pending.acknowledge(params['eventId'] ?? '')
  } catch {
    // A closed log, or a fault nobody anticipated. Contentless, because a SQLite
    // message carries the statement and the file path (APX-FR-01), and reported,
    // because a write that did not happen must not look like one that did.
    respondJson(response, ACK_STATUS['internal-error'], {
      error: 'internal-error',
      message: ACK_REFUSAL_MESSAGE['internal-error'],
    } satisfies AckErrorBody)
    return
  }

  // 3. The answer, from the table. `rejected` is the conflict: the row is in a state
  //    this transition cannot apply to, and the reason says which one.
  if (transition.outcome === 'rejected') {
    respondJson(response, ACK_STATUS.rejected, {
      error: 'conflict',
      message: ACK_REFUSAL_MESSAGE.conflict,
      reason: transition.reason,
      eventId: transition.event?.eventId ?? null,
    } satisfies AckErrorBody)
    return
  }
  if (transition.outcome === 'not-found') {
    respondJson(response, ACK_STATUS['not-found'], {
      error: 'not-found',
      message: ACK_REFUSAL_MESSAGE['not-found'],
      // The requested identifier is deliberately not echoed: a caller-chosen string
      // must not come back out of a payload this product serves.
      eventId: null,
    } satisfies AckErrorBody)
    return
  }

  respondJson(response, ACK_STATUS[transition.outcome], {
    acknowledged: transition.outcome === 'applied',
    eventId: transition.event?.eventId ?? null,
    outcome: transition.outcome,
    reason: transition.reason,
    ackState: transition.event?.ackState ?? null,
    resolutionState: transition.event?.resolutionState ?? null,
    pendingCount: transition.pendingCountAfter,
  } satisfies AckAcceptedBody)
}

/** The one route a write token is required on, as a sentence a log can quote. */
export const ACK_ROUTE_DESCRIPTION = 'POST /api/ack/:eventId'
