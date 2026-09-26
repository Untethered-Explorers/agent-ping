// A delivery the hub never received, as a line in the harness's own log
// (OA-FR-05, OA-FR-09, APX-FR-02, APX-CON-03, APX-CON-10).
//
// WHY THIS IS ITS OWN MODULE
// The adapter in src/plugin/opencode/ must not open a socket, and the transport in
// ./http.ts is the only place that does. A breadcrumb is the seam between them: the
// transport knows what went wrong and the adapter owns the harness's log client, so
// the vocabulary of "what can go wrong" is separated from the socket that causes it
// and the two are separately testable. Neither imports the other.
//
// WHY A FAILURE IS NEVER SILENT, AND WHY IT IS NEVER LOUDER THAN THAT
// APX-FR-02 is one sentence long and both halves of it are mandatory: a failure is
// surfaced *where the developer will see it*, and it is never reported as delivered.
// This module is the first half, and the only surface that can do it is the harness's
// own logging client - there is no tray, no window and no console between a plugin
// and the developer, and the console is explicitly not a logging surface in this
// product (OA-FR-09). The hub's own half - recording a dropped event in the durable
// log - is the hub's, and this module says so in the message for the two codes that
// mean the hub reached a verdict (APX-FR-02, src/hub/routes/ingest.ts).
//
// One line per failed delivery, with no throttling and no de-duplication. A quiet
// log during an outage would be a silent failure wearing a rate limit's clothes, and
// the cost of the alternative - a developer reading a handful of repeated lines
// instead of a hundred - is paid by the person who is already debugging something.
// The line is cheap: a level, one fixed sentence, and closed tokens.
//
// WHAT A BREADCRUMB MAY CARRY, AND WHAT IT MAY NOT
// The service name, the harness, the session, the event name, the variant, the
// reason code, the HTTP status, the hub's own error code, and the *names* of a
// socket or internal fault. Never: the signal's payload, a repository path, a
// measurement, an errno message, or the hub's `detail` sentence. A breadcrumb is a
// line a developer reads and a log file keeps, and the values that would be most
// useful there - what the tool was called with, what the provider said - are exactly
// the values that would make this product a transcript (APX-FR-01, EL-FR-01). The
// hub's `detail` is excluded for a second reason: it is a literal in the route, so
// carrying it would couple this module's sentences to another file's, and the hub's
// own `error` code is the closed token that says the same thing.
//
// The `stage` is the same vocabulary the adapter uses in src/plugin/opencode/index.ts
// ('translate-failed', 'delivery-failed', 'delivery-rejected'), so a developer
// filtering the harness log by stage sees one field rather than two. Every line here
// is 'delivery-failed': the transport is a delivery port, so there is no other place
// for it to fail in.

import type { HarnessLog } from '../opencode/translate.js'
import { AGENT_PING_SERVICE } from '../opencode/translate.js'
import type { HarnessSignal } from '../../domain/classify.js'

/**
 * Why a delivery did not happen, as a closed set.
 *
 * Each value is a decision somebody made rather than a message built from a value, and
 * each is answerable: a developer reading `code` knows whether to start the hub
 * (`hub-not-running`, `hub-starting`), whether the install is broken
 * (`runtime-file-unreadable`, `token-missing`, `token-unreadable`), whether the hub
 * is wedged (`delivery-timeout`, `connection-refused`, `request-failed`), or whether
 * the hub reached a verdict about the signal itself (`hub-refused`, `hub-dropped`).
 * A code added here is a code a test has to explain, which is the point.
 */
export type DeliveryFailureCode =
  /** No runtime file: no hub is running for this install, or it shut down cleanly. */
  | 'hub-not-running'
  /** The runtime file exists and has no port yet, so the hub is still starting. */
  | 'hub-starting'
  /** The runtime file is there and cannot be understood. */
  | 'runtime-file-unreadable'
  /** The published endpoint is not a loopback address, so nothing was sent to it. */
  | 'endpoint-not-loopback'
  /** The hub is running and this install has no token file. */
  | 'token-missing'
  /** The token file is there and cannot be understood. */
  | 'token-unreadable'
  /** Nothing is listening on the published port: a stale pointer, or a hub that died. */
  | 'connection-refused'
  /** The hub accepted the connection and did not answer within the bound. */
  | 'delivery-timeout'
  /** The hub answered with a status this adapter does not treat as acceptance. */
  | 'hub-refused'
  /** The hub answered 503: the event was NOT stored and the hub recorded it dropped. */
  | 'hub-dropped'
  /** The hub answered with a body this build cannot read as an ingest answer. */
  | 'hub-unreadable'
  /** The request itself failed: a socket fault, a reset, an address that is not there. */
  | 'request-failed'
  /** A fault nobody anticipated inside the transport. The session was not affected. */
  | 'transport-fault'

/**
 * The fixed sentence each reason is reported with.
 *
 * A `Record` over the union rather than a `switch`, so a new code is a compile error
 * until it has a sentence - a code with no sentence is a line in the developer's log
 * that says nothing, which is the failure mode this module exists to prevent. Every
 * sentence is a literal in this file: no value from a signal, a socket or a response
 * body can reach it (APX-FR-01).
 */
export const DELIVERY_FAILURE_MESSAGES: Readonly<Record<DeliveryFailureCode, string>> = {
  'hub-not-running':
    'agent-ping found no hub to report to: there is no runtime file for this install, so agent-ping ' +
    'is not running or has shut down. The event was not reported. Start agent-ping and it will pick ' +
    'the next event up.',
  'hub-starting':
    'agent-ping found a hub that has not published its port yet, so this event was not reported. This ' +
    'is normal for the moments after a start; nothing is wrong with the session.',
  'runtime-file-unreadable':
    "agent-ping found a hub runtime file it cannot read, so it did not guess a port and this event was " +
    'not reported. Check the runtime file named in the agent-ping log.',
  'endpoint-not-loopback':
    'agent-ping found a hub runtime file naming an address that is not on this machine, so it sent ' +
    'nothing. agent-ping only ever reports to a loopback hub.',
  'token-missing':
    'agent-ping found a running hub but no write token for this install, so it did not report the ' +
    'event rather than sending it without the token the hub expects. Reinstall agent-ping.',
  'token-unreadable':
    'agent-ping found a write token file it cannot read, so it did not report the event. A damaged ' +
    'token file is repaired by removing it and restarting agent-ping, which issues a new one.',
  'connection-refused':
    'agent-ping could not reach the hub: nothing is listening on the port the hub published. The hub ' +
    'may have exited without cleaning up. The event was not reported.',
  'delivery-timeout':
    'agent-ping reached the hub but the hub did not answer in time, so agent-ping gave up and the event ' +
    'was not reported. A hub that is busy is the hub\'s problem to recover from, not the session\'s to ' +
    'wait on.',
  'hub-refused':
    'agent-ping reported the event and the hub refused it, so nothing was stored. The hub\'s own error ' +
    'code is on this line.',
  'hub-dropped':
    'agent-ping reported the event and the hub could not store it. The hub recorded the event as ' +
    'dropped, so the session is unaffected and the event is not lost silently - it is in the agent-ping ' +
    'log as a drop.',
  'hub-unreadable':
    'agent-ping reported the event and the hub answered with something this build cannot read, so the ' +
    'answer was treated as a failure rather than as acceptance. That is a version mismatch worth ' +
    'reporting.',
  'request-failed':
    'agent-ping could not send the event to the hub, so it was not reported and nothing was stored.',
  'transport-fault':
    'agent-ping hit an internal fault while trying to report an event to the hub. The session was not ' +
    'affected and the event was not reported.',
}

/**
 * One failure, as far as a breadcrumb is allowed to describe it.
 *
 * The three optional fields are all closed tokens or small integers:
 * `status` is the HTTP status the hub answered, `hubError` is the `error` field of
 * an ingest refusal body (a member of the hub's own closed set), and
 * `errorName`/`errorCode` are the *name* of a fault and its errno code - a name, never
 * a message, because a fault raised while building a request is exactly the fault
 * whose message quotes the value it choked on.
 */
export interface DeliveryFailure {
  readonly code: DeliveryFailureCode
  readonly status?: number
  readonly hubError?: string
  readonly errorName?: string
  readonly errorCode?: string
}

/**
 * The line itself, as the harness's log client is handed it.
 *
 * `service`, `sessionId` and `eventName` are the three OA-FR-05 names, and they are
 * fields rather than prose so a log reader can filter on them.
 */
export interface DeliveryBreadcrumb {
  /** Always `AGENT_PING_SERVICE`, so the line is attributable to this product. */
  readonly service: string
  readonly stage: 'delivery-failed'
  readonly code: DeliveryFailureCode
  /** The harness the signal came from, as the adapter named it. */
  readonly harness: string
  /** The harness's own event name, verbatim. */
  readonly eventName: string
  readonly sessionId: string
  readonly variant?: string
  readonly status?: number
  readonly hubError?: string
  readonly errorName?: string
  readonly errorCode?: string
}

/**
 * Build the breadcrumb for one failed delivery, as a pure function.
 *
 * Separate from the write so the exact fields are testable without a logging client,
 * and so there is one place where the field set is decided. A signal whose fields are
 * not strings - which a hostile or broken caller could produce, and which would
 * otherwise put `[object Object]` into a log field - is reported with `unknown`
 * rather than with the value, because a value that is not a closed token is not a
 * thing this line may carry.
 */
export function deliveryBreadcrumb(
  failure: DeliveryFailure,
  signal: HarnessSignal,
): DeliveryBreadcrumb {
  const variant = optional(signal.variant)
  const status =
    typeof failure.status === 'number' && Number.isFinite(failure.status) ? failure.status : undefined
  return {
    service: AGENT_PING_SERVICE,
    stage: 'delivery-failed',
    // An unrecognised code would have no sentence, and a line with no sentence is the
    // silent failure this module exists to prevent. The fallback is the generic
    // request fault, whose sentence is true of any fault nobody anticipated.
    code: isFailureCode(failure.code) ? failure.code : 'request-failed',
    harness: text(signal.harness),
    eventName: text(signal.eventName),
    sessionId: text(signal.sessionId),
    ...(variant === undefined ? {} : { variant }),
    ...(status === undefined ? {} : { status }),
    ...(optional(failure.hubError) === undefined ? {} : { hubError: failure.hubError as string }),
    ...(optional(failure.errorName) === undefined ? {} : { errorName: failure.errorName as string }),
    ...(optional(failure.errorCode) === undefined ? {} : { errorCode: failure.errorCode as string }),
  }
}

/**
 * Write one breadcrumb through the harness's own logging client, and never throw.
 *
 * Two guards, and both are load-bearing. The outer one is that a logging client which
 * throws must not turn a delivery failure into a session failure: the transport calls
 * this from inside a promise chain, and an exception here would be the one exception
 * that reaches the developer's session (APX-CON-03, OA-FR-04). The inner one is
 * already `createHarnessLog`'s, and it is not repeated - the client it wraps is
 * caught there, so the only thing left to catch here is a client that was supplied by
 * a caller other than that factory.
 *
 * `warn` and not `error`: opencode surfaces warnings in the session's own log panel,
 * and a line about a hub that is not running is information about the environment
 * rather than a fault in the developer's work.
 */
export function writeDeliveryBreadcrumb(
  log: HarnessLog,
  failure: DeliveryFailure,
  signal: HarnessSignal,
): void {
  const crumb = deliveryBreadcrumb(failure, signal)
  const message = DELIVERY_FAILURE_MESSAGES[crumb.code]
  try {
    log.warn({ message, extra: { ...crumb } })
  } catch {
    // Nowhere left to report, and reporting a failed report is the recursion this
    // guard exists to stop. The session continues, which is the outcome that is never
    // negotiable (APX-CON-03).
  }
}

/** Is this one of the codes this build reports, with a sentence of its own? */
function isFailureCode(value: unknown): value is DeliveryFailureCode {
  return typeof value === 'string' && Object.hasOwn(DELIVERY_FAILURE_MESSAGES, value)
}

/** A required field value, when it is a non-empty string, and `unknown` otherwise. */
function text(value: unknown): string {
  return optional(value) ?? 'unknown'
}

/** An optional field value, when it is a non-empty string, and absent otherwise. */
function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
