// `POST /api/ingest`: the only way an event enters this product (HC-FR-04,
// HC-FR-08, HC-FR-09, ADR-002, PRD 6.3).
//
// WHAT POSTS HERE
// One *harness signal*: the harness's own event name, the session and repository it
// belongs to, the identity the dedupe key is derived from, when it happened, and -
// for an idle transition - whether the turn did any work. Nine fields, listed in
// `INGEST_SIGNAL_FIELDS` below and nowhere else.
//
// The signal is deliberately *not* the normalized envelope, and the difference is
// the whole design of the route:
//
//   - The class, the subtype and the dedupe key are the hub's to decide. The
//     classifier is the authority on loudness (src/domain/classify.ts) and an
//     adapter with its own class table is a second copy of that decision; ADR-002
//     states outright that deduplication happens in the hub against a dedupe key,
//     not in transit. A wire format carrying `class` or `dedupeKey` would make the
//     caller the authority over both, so both are *refused* here rather than
//     ignored - an ignored field is a field a future change can start reading.
//   - The turn work signal has to travel, because "the session opened, greeted and
//     closed" produces no event at all and only the adapter can see a turn boundary
//     (EL-FR-05, OA-FR-03). The gate itself is the classifier's.
//   - `receivedAt` does not travel. The envelope documents it as the instant the
//     *hub* received the event, and a caller-supplied value would be a claim about
//     this daemon's clock. The hub stamps it.
//
// CONNECTOR ENGINEERS: this file is the ingest contract OA-1 and OA-2 depend on.
// `INGEST_SIGNAL_FIELDS` is the closed field set, `INGEST_REFUSAL_STATUS` is the
// status table, and the 202 body is `IngestAcceptedBody`. A harness adapter posts
// one of these per signal with a short bounded timeout and no retry loop
// (APX-CON-10), reads the port out of the runtime file rather than assuming it, and
// leaves a breadcrumb through the harness's own logging client for any status other
// than 202 (OA-FR-05).
//
// THE ORDER THAT IS THE REQUIREMENT
// 1. Read the body, bounded in bytes and in time. A client that never finishes
//    sending cannot hold a connection open indefinitely, and a body this product
//    cannot use is refused before a byte of it is interpreted.
// 2. Parse and validate against the closed schema. Structural only: types, required
//    fields, the closed key set, and the known-harness check. Value rules stay in
//    the classifier, so there is one place that decides what a valid signal is and
//    the route cannot disagree with it.
// 3. `submit`: classify, dedupe, store, time it.
// 4. Answer 202 - or the refusal status.
// 5. *Then* start delivery, and never await it. HC-FR-04 says the answer does not
//    wait for delivery, and this is the only order in which that is a property
//    rather than a comment: the response is written before the delivery port is
//    called, and tests/hub/ingest.test.ts watches exactly that order with a port
//    that records when the client had already been answered.
//
// THE ANSWER TABLE, IN FULL
//   202  the hub took the signal; `outcome` says which of the six things happened.
//        A replay is a 202 and not a 409, because the adapter did nothing wrong and
//        a 4xx there is how a transport grows a retry storm (APX-CON-10).
//   400  the body was not JSON, was not an object, or the connection died mid-body.
//   408  the client took longer than `INGEST_BODY_TIMEOUT_MS` to finish sending.
//   413  the body was over `INGEST_MAX_BODY_BYTES`.
//   422  a well-formed body the domain refuses: an unknown harness, an unknown
//        field, a wrong type, a missing field, an unmapped or unresolved signal.
//   503  the log could not be written. The event was NOT stored, it is recorded as
//        dropped, and saying so is mandatory (APX-FR-02).
//   500  a fault nobody anticipated, which is also recorded rather than swallowed.
//
// NOTHING HERE CAN STEER A HARNESS
// The route has exactly one effect: it appends an event to a local log. It reads no
// request field other than the nine above, it opens no connection outward, it
// spawns nothing, and it has no path to any harness. Every other method on
// `/api/ingest` is refused with 405 by the registry before this handler exists, and
// every other path is 404 (HC-FR-05, APX-CON-08). tests/hub/ingest.test.ts asserts
// both, and asserts that a body carrying a control-shaped field is refused rather
// than read.
//
// NO PAYLOAD ECHO, EVER
// The 202 body carries the outcome, the row key, the class and the pending count -
// four values the client could not otherwise know without a second request. It does
// not carry the event, the session, the request, or any value the caller sent: a
// payload that echoes a request is a payload that can hold a request, and this
// product's payloads cannot hold content (APX-FR-01, ADR-003). The refusal bodies
// quote no value either; the field-level issues name *field names* from a closed
// schema and nothing more.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { KNOWN_HARNESSES, isKnownHarness, type Harness } from '../../domain/envelope.js'
import type { HarnessSignal, Measurement, TurnWorkSignal } from '../../domain/classify.js'
import type { EventClass } from '../../storage/eventStore.js'
import {
  isCallerFault,
  type IngestAccepted,
  type IngestOutcome,
  type IngestRefusalCode,
} from '../ingest-service.js'
import { respondJson, type RouteContext, type RouteDefinition } from '../server.js'
import type { HubServices } from './read.js'

// ---------------------------------------------------------------------------
// The bounds
// ---------------------------------------------------------------------------

/**
 * The largest body this route will read.
 *
 * Sixty-four kilobytes against a signal that is four short tokens and two
 * timestamps. The cap is not a courtesy: this is an unauthenticated loopback port,
 * so the amount of work one request can demand has to be a property of the code
 * rather than of the client, and a body that arrives over the cap is refused
 * without ever being interpreted.
 */
export const INGEST_MAX_BODY_BYTES = 65_536

/**
 * How long a client may take to finish sending a body.
 *
 * Two seconds, matching the delivery bound in ../ingest-service.ts. It is the bound
 * on a *malformed or hostile* client rather than a slow one: a local adapter sends a
 * few hundred bytes in well under a millisecond, and the number exists so a socket
 * opened with no intention of closing cannot be held by this route.
 */
export const INGEST_BODY_TIMEOUT_MS = 2_000

// ---------------------------------------------------------------------------
// The closed wire schema
// ---------------------------------------------------------------------------

/** The kinds of value a field may hold on the wire. */
type FieldKind = 'harness' | 'string' | 'turn-work' | 'measurements'

interface SignalFieldSpec {
  readonly name: string
  readonly required: boolean
  readonly kind: FieldKind
}

/**
 * Every field a posted signal may carry, and nothing else.
 *
 * The runtime half of a closed schema, and the list a reviewer reads when a field is
 * added. `satisfied` keeps the literal's own type, so the validator below can index
 * it and the compiler still knows each entry is well formed.
 *
 * The absence of `class`, `subtype`, `dedupeKey`, `receivedAt` and `repoShortName`
 * is the design above, not an oversight: each of them is the hub's to decide, and
 * `repoShortName` is derived from the path so an adapter cannot mislabel a row
 * (APX-CON-09, ADR-008). A client that posts one is told the field is not accepted;
 * it is never quietly ignored.
 */
export const INGEST_SIGNAL_FIELDS = [
  { name: 'harness', required: true, kind: 'harness' },
  { name: 'eventName', required: true, kind: 'string' },
  { name: 'variant', required: false, kind: 'string' },
  { name: 'sessionId', required: true, kind: 'string' },
  { name: 'repoFullPath', required: true, kind: 'string' },
  { name: 'transitionId', required: false, kind: 'string' },
  { name: 'occurredAt', required: true, kind: 'string' },
  { name: 'turnWork', required: false, kind: 'turn-work' },
  { name: 'measurements', required: false, kind: 'measurements' },
] as const satisfies readonly SignalFieldSpec[]

/** Every field name the schema accepts, for the tests that assert the key set. */
export const INGEST_SIGNAL_FIELD_NAMES: readonly string[] = INGEST_SIGNAL_FIELDS.map(
  (field) => field.name,
)

/**
 * The measurements a signal may carry, keyed by the classifier's own union.
 *
 * A `Record<Measurement, ...>` rather than an array, because a `Record` over a union
 * is total: a fourth measurement added to the classifier is a compile error here
 * rather than a field this route would refuse forever. The keys are the names, and
 * the value is the only kind each may hold.
 */
const MEASUREMENT_KINDS: Readonly<Record<Measurement, 'number'>> = {
  durationMs: 'number',
  tokensUsed: 'number',
  attempt: 'number',
}

const MEASUREMENT_NAMES: readonly string[] = Object.keys(MEASUREMENT_KINDS)

/**
 * The three fields of the turn work signal, keyed by name.
 *
 * Booleans, not counts: a tally of tool calls across a turn is a transcript wearing a
 * numeric disguise, and the store's work_signal column is a 0 or 1 for the same reason
 * (EL-FR-05). The names are also what `INGEST_SIGNAL_FIELDS` checks `turnWork`
 * against, so a fourth measure cannot arrive undeclared.
 */
const TURN_WORK_KINDS: Readonly<Record<keyof TurnWorkSignal, 'boolean'>> = {
  toolCall: 'boolean',
  fileEdit: 'boolean',
  todoUpdate: 'boolean',
}

const TURN_WORK_NAMES: readonly string[] = Object.keys(TURN_WORK_KINDS)

/** Why a field was refused. Field-level only: no value is ever carried. */
export type IngestIssueCode =
  /** The body was valid JSON but not an object. */
  | 'not-an-object'
  /** A field the schema does not declare. */
  | 'unrecognised-field'
  /** A field the schema requires was absent. */
  | 'missing-field'
  /** A field held the wrong kind of value. */
  | 'wrong-type'
  /** `harness` named a harness this product does not know. */
  | 'unknown-harness'

/**
 * One field-level problem, named by path and nothing else.
 *
 * The path is a field name from a closed schema, or a dotted path inside `turnWork`
 * or `measurements`. No value is attached, deliberately: this list is serialised into
 * a response body, and a body that can carry a value can carry a pasted prompt
 * (APX-FR-01). The whole issue list for a body with a content-shaped field is
 * therefore one path and one code, and tests/hub/ingest.test.ts asserts the value
 * itself never appears.
 */
export interface IngestIssue {
  readonly path: string
  readonly code: IngestIssueCode
}

/** The outcome of validating a parsed body. */
export type IngestValidation =
  | { readonly ok: true; readonly signal: HarnessSignal; readonly receivedAt: string }
  | { readonly ok: false; readonly error: 'invalid-signal' | 'unknown-harness'; readonly issues: readonly IngestIssue[] }

/**
 * Validate a parsed body against the closed schema.
 *
 * Structural only, and the reason is that the value rules live in one place: the
 * classifier bounds every identifier, every timestamp and every measurement, and it
 * reports its own refusals with a code the route maps to 422. A second set of value
 * rules here would be a second thing to drift from the first, and the observable
 * outcome would be the same 422 either way.
 *
 * The two things checked here that the classifier cannot be the authority on are the
 * *key set* and the *harness name*: the first is what stops a field this product has
 * never heard of from arriving, and the second is the closed vocabulary the
 * classifier is handed rather than a value it can be asked to compare.
 */
export function validateIngestSignal(
  value: unknown,
  receivedAt: string,
): IngestValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'invalid-signal', issues: [{ path: '', code: 'not-an-object' }] }
  }
  const body = value as Readonly<Record<string, unknown>>
  const issues: IngestIssue[] = []
  const declared = new Set(INGEST_SIGNAL_FIELD_NAMES)

  for (const key of Object.keys(body)) {
    if (!declared.has(key)) issues.push({ path: key, code: 'unrecognised-field' })
  }

  for (const field of INGEST_SIGNAL_FIELDS) {
    const present = Object.hasOwn(body, field.name)
    if (!present) {
      if (field.required) issues.push({ path: field.name, code: 'missing-field' })
      continue
    }
    const held = body[field.name]
    if (field.kind === 'string') {
      if (typeof held !== 'string') issues.push({ path: field.name, code: 'wrong-type' })
      continue
    }
    if (field.kind === 'harness') {
      if (typeof held !== 'string') {
        issues.push({ path: field.name, code: 'wrong-type' })
        continue
      }
      if (!isKnownHarness(held)) issues.push({ path: field.name, code: 'unknown-harness' })
      continue
    }
    if (field.kind === 'turn-work') {
      // All three: the work signal is three named measures, and a partial one is a
      // caller that could not decide whether a turn worked (EL-FR-05).
      issues.push(...checkFlatObject(held, 'turnWork', TURN_WORK_KINDS, TURN_WORK_NAMES, 'all'))
      continue
    }
    // None of them: a harness reports the measurements it has, and a signal carrying
    // one is read against the threshold that one needs. Demanding all three would
    // refuse every real signal for the sake of symmetry.
    issues.push(...checkFlatObject(held, 'measurements', MEASUREMENT_KINDS, MEASUREMENT_NAMES, 'none'))
  }

  if (issues.length === 0) {
    return { ok: true, signal: toHarnessSignal(body, receivedAt), receivedAt }
  }
  // `unknown-harness` is reported under its own error code even when other issues
  // came with it, because it is the one refusal an adapter has to distinguish: the
  // harness name is a contract between two components, and a caller naming a harness
  // this build does not know needs to hear that rather than a list of field names.
  return issues.some((issue) => issue.code === 'unknown-harness')
    ? { ok: false, error: 'unknown-harness', issues }
    : { ok: false, error: 'invalid-signal', issues }
}

/**
 * A nested object checked key by key, with no extras either way.
 *
 * Shared by `turnWork` and `measurements` because the rule is the same: a fixed key
 * set, nothing undeclared, and one kind per key. What differs is whether every
 * declared key has to be there - all three measures for a work signal, none for a
 * measurement - and `requiredKeys` is what says so. An absent parent is handled by
 * the caller, which knows the field is optional.
 */
function checkFlatObject(
  value: unknown,
  parent: string,
  kinds: Readonly<Record<string, string>>,
  names: readonly string[],
  requiredKeys: 'all' | 'none',
): readonly IngestIssue[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ path: parent, code: 'wrong-type' }]
  }
  const held = value as Readonly<Record<string, unknown>>
  const issues: IngestIssue[] = []
  for (const key of Object.keys(held)) {
    if (!names.includes(key)) issues.push({ path: `${parent}.${key}`, code: 'unrecognised-field' })
  }
  for (const name of names) {
    if (!Object.hasOwn(held, name)) {
      if (requiredKeys === 'all') {
        issues.push({ path: `${parent}.${name}`, code: 'missing-field' })
      }
      continue
    }
    // One kind per table, so the check is the table's own value rather than a second
    // list of type names that could disagree with it.
    if (kinds[name] === 'number' && !isFiniteNumber(held[name])) {
      issues.push({ path: `${parent}.${name}`, code: 'wrong-type' })
    }
    if (kinds[name] === 'boolean' && typeof held[name] !== 'boolean') {
      issues.push({ path: `${parent}.${name}`, code: 'wrong-type' })
    }
  }
  return issues
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * The validated body, as the classifier's input.
 *
 * The only field invented here is `receivedAt`, and the envelope documents why: it is
 * when the *hub* received the event, so a caller cannot supply it (see the header).
 * Everything else is the body as validated, and the compiler is what proves the
 * shapes line up: `harness` was narrowed by `isKnownHarness` above, and the three
 * nested objects were checked key by key.
 */
function toHarnessSignal(body: Readonly<Record<string, unknown>>, receivedAt: string): HarnessSignal {
  const turnWork = body['turnWork']
  const measurements = body['measurements']
  return {
    harness: body['harness'] as Harness,
    eventName: body['eventName'] as string,
    ...(typeof body['variant'] === 'string' ? { variant: body['variant'] } : {}),
    sessionId: body['sessionId'] as string,
    repoFullPath: body['repoFullPath'] as string,
    ...(typeof body['transitionId'] === 'string' ? { transitionId: body['transitionId'] } : {}),
    occurredAt: body['occurredAt'] as string,
    receivedAt,
    ...(isTurnWork(turnWork) ? { turnWork } : {}),
    ...(isMeasurements(measurements) ? { measurements } : {}),
  }
}

function isTurnWork(value: unknown): value is TurnWorkSignal {
  if (typeof value !== 'object' || value === null) return false
  const held = value as Readonly<Record<string, unknown>>
  return TURN_WORK_NAMES.every((name) => typeof held[name] === 'boolean')
}

function isMeasurements(
  value: unknown,
): value is Readonly<Partial<Record<Measurement, number>>> {
  if (typeof value !== 'object' || value === null) return false
  const held = value as Readonly<Record<string, unknown>>
  return MEASUREMENT_NAMES.every((name) => !Object.hasOwn(held, name) || isFiniteNumber(held[name]))
}

// ---------------------------------------------------------------------------
// The answer table
// ---------------------------------------------------------------------------

/**
 * The status each refusal code answers with, in one table.
 *
 * `Record<IngestRefusalCode, number>` is total, so a new refusal code is a compile
 * error until someone decides what a client is told about it. The split is the whole
 * of APX-FR-02: five codes are the caller's fault and answer 4xx, one is the hub's
 * own log failing and answers 503, and one is a fault nobody anticipated and answers
 * 500. Nothing here answers 2xx, because nothing here stored anything.
 */
export const INGEST_REFUSAL_STATUS: Readonly<Record<IngestRefusalCode, number>> = {
  'unknown-harness': 422,
  'unmapped-signal': 422,
  'unresolved-signal': 422,
  'invalid-signal': 422,
  'unidentifiable-block': 422,
  'store-failed': 503,
  'internal-error': 500,
}

/** Which of the two tables an error string belongs to, so a body is never ambiguous. */
export const INGEST_ERROR_CODES = [
  'not-json',
  'body-too-large',
  'body-timeout',
  'body-aborted',
  'invalid-signal',
  'unknown-harness',
] as const

export type IngestErrorCode = (typeof INGEST_ERROR_CODES)[number]

/** The transport-level refusals and their statuses. */
export const INGEST_TRANSPORT_STATUS: Readonly<Record<Exclude<IngestErrorCode, 'invalid-signal' | 'unknown-harness'>, number>> =
  {
    'not-json': 400,
    'body-too-large': 413,
    'body-timeout': 408,
    'body-aborted': 400,
  }

/**
 * The fixed sentence each refusal code answers with.
 *
 * Never the classifier's own message, which quotes the signal's three tokens and one
 * of those is a string the caller chose. Every sentence here is a literal in this
 * file, so no value from a request can reach a response body (APX-FR-01), and
 * tests/hub/ingest.test.ts posts a signal whose every field is a recognisable string
 * and asserts none of them appears in any answer.
 */
export const INGEST_REFUSAL_DETAIL: Readonly<Record<IngestRefusalCode, string>> = {
  'unknown-harness':
    'this hub does not know that harness. A harness name is a closed set, and adding one is a ' +
    'deliberate change rather than something a caller may decide (HC-FR-04).',
  'unmapped-signal':
    'this build has no classification for that harness event. Every event name a harness delivers ' +
    'needs a row in the table, mapped to a class or explicitly to nothing (EL-FR-04).',
  'unresolved-signal':
    'that signal is not established upstream, so this build refuses it rather than treating a ' +
    'heuristic as a proven mapping (ADR-005).',
  'invalid-signal':
    'that signal carries a value this build will not store: an identifier, a timestamp, a ' +
    'measurement or a work signal that does not meet the rules. Nothing was stored (EL-FR-04).',
  'unidentifiable-block':
    'that signal reports a resolved block but named no block identifier, so it names no block to ' +
    'clear. Nothing was stored (EL-FR-07).',
  'store-failed':
    'the durable log could not be written, so this event was NOT stored. It is recorded as dropped ' +
    'and the hub should not be reported as having received it (APX-FR-02).',
  'internal-error':
    'the hub could not process this event and did not store it. It is recorded as dropped (APX-FR-02).',
}

/** The 202 body. Four values the client could not otherwise know in one request. */
export interface IngestAcceptedBody {
  readonly accepted: true
  readonly outcome: IngestOutcome
  /** The stored row's key, or null when nothing was stored. */
  readonly eventId: string | null
  readonly class: EventClass | null
  /** The store's pending count after the step. */
  readonly pendingCount: number
  /** True only for a replay of an envelope already in the log (HC-FR-08). */
  readonly duplicate: boolean
  /** The gate's reason, when the classifier deliberately produced no event. */
  readonly reason: string | null
}

export interface IngestErrorBody {
  readonly error: IngestErrorCode | IngestRefusalCode
  readonly detail: string
  /** Field paths and codes only, for the refusals that have them. */
  readonly issues?: readonly IngestIssue[]
  /** True when the event was dropped rather than refused: nothing was stored. */
  readonly dropped?: true
}

// ---------------------------------------------------------------------------
// The bounded body read
// ---------------------------------------------------------------------------

/** What the body read produced. */
export type IngestBodyRead =
  | { readonly kind: 'body'; readonly text: string }
  | { readonly kind: 'not-json' }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' }

export interface ReadIngestBodyOptions {
  readonly maxBytes?: number
  readonly timeoutMs?: number
}

/**
 * Read the request body, bounded in bytes and in time.
 *
 * Two bounds and three refusals, each for a different failure:
 *
 *   - Over the byte cap the body is refused *without being interpreted*, and the rest
 *     of it is drained rather than buffered. Draining is what lets the 413 actually
 *     reach the client instead of turning into a reset it cannot read, and it is
 *     bounded by the same timer: a client that keeps sending after the cap has been
 *     hit gets the same 413 when the timer fires and the socket stops being read.
 *   - Past the time bound the answer is 408. A local adapter sends a few hundred
 *     bytes in under a millisecond, so this bound is about a socket opened with no
 *     intention of finishing, not about a slow one.
 *   - A connection that dies mid-body is 400 and not a hang: the client is already
 *     gone and waiting for its own timeout would be the one slow path in the route.
 *
 * The `data` listener is removed on every exit, so a finished read leaves the socket
 * read normally rather than pausing it.
 */
export function readIngestBody(
  request: IncomingMessage,
  options: ReadIngestBodyOptions = {},
): Promise<IngestBodyRead> {
  const maxBytes = options.maxBytes ?? INGEST_MAX_BODY_BYTES
  const timeoutMs = options.timeoutMs ?? INGEST_BODY_TIMEOUT_MS
  return new Promise<IngestBodyRead>((resolve) => {
    const chunks: string[] = []
    let received = 0
    let overflowed = false
    let settled = false

    function finish(result: IngestBodyRead): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.removeListener('data', onData)
      request.removeListener('end', onEnd)
      request.removeListener('error', onAbort)
      request.removeListener('aborted', onAbort)
      request.removeListener('close', onClose)
      resolve(result)
    }

    function onData(chunk: Buffer | string): void {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      // Measured in bytes, not characters: the cap is about work and memory, and a
      // multi-byte body is larger on the wire than the string it decodes to.
      received += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length
      if (received > maxBytes) {
        // Drop what has been collected rather than keep it: the body is already
        // refused and holding 64 KB of it per request is the cost this avoids.
        overflowed = true
        chunks.length = 0
        return
      }
      if (!overflowed) chunks.push(text)
    }

    function onEnd(): void {
      if (overflowed) {
        finish({ kind: 'too-large' })
        return
      }
      finish({ kind: 'body', text: chunks.join('') })
    }

    function onAbort(): void {
      finish(overflowed ? { kind: 'too-large' } : { kind: 'aborted' })
    }

    function onClose(): void {
      // `close` fires after a normal end too, and the `settled` guard makes the
      // ordering irrelevant: whichever arrives first decides, once.
      if (!settled) finish(overflowed ? { kind: 'too-large' } : { kind: 'aborted' })
    }

    // Armed before the listeners are attached, and a timer callback can only run on
    // a later turn of the event loop - so the `clearTimeout` in `finish` above never
    // reads `timer` before this line has initialised it.
    const timer = setTimeout(() => {
      finish(overflowed ? { kind: 'too-large' } : { kind: 'timeout' })
    }, timeoutMs)
    // A held-open request must not be the reason this process stays alive.
    timer.unref?.()

    request.setEncoding('utf8')
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', onAbort)
    request.once('aborted', onAbort)
    request.once('close', onClose)
  })
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/**
 * The ingest route, in the same shape as the read routes so the composition root
 * registers it from one list and the enumeration test sees it (HC-FR-02).
 */
export const INGEST_ROUTES: readonly RouteDefinition<HubServices>[] = [
  {
    method: 'POST',
    pattern: '/api/ingest',
    name: 'ingest.signal',
    // `ingest-append`, not `ack-only`: this route appends an event and changes
    // nothing that already exists. The registry refuses any other route that claims
    // either mutation, so the mutating surface of this product is exactly these two
    // signatures and the ack route is the only one that can change a record
    // (APX-CON-08, ADR-002).
    mutation: 'ingest-append',
    handle: (context): Promise<void> => serveIngest(context),
  },
]

/**
 * One posted signal, end to end.
 *
 * Never throws: every fault is an answered response, because a rejection would reach
 * the listener's catch and become a contentless 500, which is right for an
 * unanticipated fault and wrong for a refused signal the caller can fix.
 */
async function serveIngest({ request, response, services }: RouteContext<HubServices>): Promise<void> {
  // 1. The body, bounded in bytes and in time.
  const read = await readIngestBody(request)
  if (read.kind !== 'body') {
    respondTransportFailure(response, read)
    return
  }

  // 2. JSON, then the closed schema. Both refusals quote no value from the body.
  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch {
    respondTransportFailure(response, { kind: 'not-json' })
    return
  }
  const receivedAt = new Date().toISOString()
  const validation = validateIngestSignal(parsed, receivedAt)
  if (!validation.ok) {
    respondJson(response, INGEST_REFUSAL_STATUS[validation.error], {
      error: validation.error,
      detail: INGEST_REFUSAL_DETAIL[validation.error],
      issues: validation.issues,
    } satisfies IngestErrorBody)
    return
  }

  // 3. The store step: classify, dedupe, record, time it.
  const result = await services.ingest.submit(validation.signal)

  // 4. The answer. Every refusal status comes from the table; nothing here can
  //    answer 2xx for a signal that was not stored (APX-FR-02).
  if (!result.ok) {
    const status = INGEST_REFUSAL_STATUS[result.code]
    respondJson(response, status, {
      error: result.code,
      detail: INGEST_REFUSAL_DETAIL[result.code],
      ...(isCallerFault(result.code) ? {} : { dropped: true }),
    } satisfies IngestErrorBody)
    return
  }
  respondAccepted(response, result)

  // 5. Delivery, after the response above has been written and without awaiting it.
  //    This is the order HC-FR-04 requires, and putting the call here rather than
  //    inside `submit` is what makes it observable.
  services.ingest.startDelivery(result)
}

function respondAccepted(response: ServerResponse, result: IngestAccepted): void {
  respondJson(response, 202, {
    accepted: true,
    outcome: result.outcome,
    eventId: result.event?.eventId ?? null,
    class: result.class,
    pendingCount: result.pendingCount,
    duplicate: result.duplicate,
    reason: result.reason,
  } satisfies IngestAcceptedBody)
}

function respondTransportFailure(
  response: ServerResponse,
  read: Exclude<IngestBodyRead, { readonly kind: 'body' }>,
): void {
  const code: IngestErrorCode =
    read.kind === 'not-json'
      ? 'not-json'
      : read.kind === 'too-large'
        ? 'body-too-large'
        : read.kind === 'timeout'
          ? 'body-timeout'
          : 'body-aborted'
  respondJson(response, INGEST_TRANSPORT_STATUS[code], {
    error: code,
    detail:
      'the request body could not be accepted: a harness event is a small JSON object and this hub ' +
      `reads at most ${INGEST_MAX_BODY_BYTES} bytes of it (HC-FR-09).`,
  } satisfies IngestErrorBody)
}

/** Every harness name this route accepts, for the test that asserts the closed set. */
export const INGEST_KNOWN_HARNESSES: readonly string[] = KNOWN_HARNESSES
