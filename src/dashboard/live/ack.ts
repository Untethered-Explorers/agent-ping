// Acknowledgement: the one write this page performs (LD-FR-05, APX-CON-08,
// HC-FR-05, HC-FR-06, ADR-002).
//
// WHAT THIS MODULE OWNS
// Four decisions, in one place so none of them can be made twice:
//
//   - WHICH ITEM a row acknowledges. The page holds session rows, and a row that
//     says "2 pending" is two items. The oldest unacknowledged needs-you item of
//     that session is the one a developer means by "deal with this row", so the
//     choice is here and is total (APX-US-02).
//   - THE REQUEST. One POST to the ack route, with no body and no field of any
//     request this module can make interpreted by the hub. The route reads the
//     identifier out of the path and the token out of a header and nothing else,
//     which is what makes "it can only mark a pending item acknowledged" a property
//     of the product rather than an intention (HC-FR-05).
//   - THE OPTIMISM. The row's pending marker clears the moment the developer acts,
//     and the header's number is the one thing on this page that is never guessed:
//     it follows the hub's own answer (the 200 body's `pendingCount`, then the
//     hub's own `acknowledged` frame). A page that optimistically decremented the
//     count and was wrong would disagree with the tray badge for the same state,
//     which is the exact failure LD-FR-04 exists to prevent.
//   - THE REFUSAL. Every way this can fail has a closed code, one fixed sentence,
//     and a visible place on the page. Nothing is swallowed, and nothing from the
//     hub's answer body becomes a word the page speaks - the sentences in
//     `ACK_REFUSAL_SENTENCE` are literals here, the same way `CONNECTION_TEXT` in
//     ../main.ts is.
//
// THE TOKEN, AND THE GAP THIS MODULE DOES NOT CLOSE
// `POST /api/ack/:eventId` requires the per-install write token in the
// `x-agent-ping-token` header, and HC-4 deliberately put that token in no response,
// no header, no served asset and no log line (src/hub/security.ts, asserted by
// tests/hub/security.test.ts: "A token readable by the page is a token any page on
// the machine can read"). The served dashboard is a static file, so there is nowhere
// in this page's own inputs for the token to arrive from.
//
// This module therefore takes the token as an injected input and does nothing to
// obtain it: `mountDashboard({ writeToken })`, or a `<meta name="agent-ping-write-token">`
// element in the served document, which the page reads if one is there. What the
// hub serves it, or whether it decides to authorise the dashboard document's own
// same-origin request without one, is a decision on the security boundary and
// belongs to hub-engineer - inventing a second credential channel from here would
// be exactly the change that must not be made from this file.
//
// When no token is available the page does not pretend: the acknowledgement control
// is disabled and says why, pressing it still records a refusal, and nothing is
// posted. A page that could not acknowledge and said nothing would be a page lying
// about a capability it does not have.
//
// WHAT THIS MODULE CANNOT DO
// It cannot send a prompt, interrupt a session, approve a permission, spawn
// anything or reach any harness. It has one method that performs one request, to
// one path, with one method. The suite asserts the shape of that request field by
// field and walks every control the page renders; there is no second one to find.

// ---------------------------------------------------------------------------
// The route and the credential
// ---------------------------------------------------------------------------

/** The one path that can change a record that already exists. */
export const ACK_ROUTE_PREFIX = '/api/ack/'

/**
 * The header the write token travels in.
 *
 * The value `x-agent-ping-token` is the one src/hub/security.ts publishes as
 * `WRITE_TOKEN_HEADER` and the one its refusal sentence names. It is restated here
 * because src/hub/security.ts imports `node:crypto` and `node:fs`: importing the
 * hub's own module from the browser bundle would pull Node built-ins into the page
 * (the same reason `HubSession` is declared rather than imported in
 * ./stream-client). tests/dashboard/live-interactions.test.ts asserts this literal
 * still equals the hub's own, so a renamed header fails there rather than leaving
 * every acknowledgement quietly unauthorised.
 */
export const WRITE_TOKEN_HEADER = 'x-agent-ping-token'

/**
 * The `<meta>` name a served document may carry the token in.
 *
 * A seam and not a mechanism: the page reads it if the document has one and does
 * nothing to put it there. The served document is the hub's to build, and the
 * boundary decision about whether it may carry this value is hub-engineer's
 * (src/hub/security.ts states the current answer: no served asset holds it).
 */
export const ACK_TOKEN_META_NAME = 'agent-ping-write-token'

/** The read route the pending set - and therefore the item to acknowledge - comes from. */
export const PENDING_ROUTE = '/api/pending'

// ---------------------------------------------------------------------------
// The pending set
// ---------------------------------------------------------------------------

/**
 * The fields of one pending item this page reads.
 *
 * A subset of `PendingItem` in src/storage/eventStore.ts, declared rather than
 * imported for the reason `HubSession` is, and read field by field out of an
 * untrusted payload by `parsePendingItem`. `harness`, `repoShortName` and
 * `repoFullPath` exist on the store's row and are deliberately absent here: the
 * repository a row belongs to is the session row's own identity (APX-CON-09), and a
 * second copy of it on the pending item is a second thing to keep in step.
 *
 * There is no field here that could carry conversation content, and this page
 * renders none of them except through a closed label table (APX-FR-01).
 */
export interface PendingItemRecord {
  readonly eventId: string
  readonly sessionId: string
  readonly class: 'needs-you' | 'finished' | 'fyi'
  readonly occurredAt: string
  readonly ackState: 'unacknowledged' | 'acknowledged'
  readonly resolutionState: 'unresolved' | 'resolved'
}

/** A full read of the pending set, from the route the badge's own count comes from. */
export type PendingItemReader = () => Promise<readonly PendingItemRecord[]>

// ---------------------------------------------------------------------------
// Parsing: closed field sets, nothing spread
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A non-empty string, or null. Bounded because every identifier here is one. */
function asToken(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

const PENDING_CLASSES: readonly string[] = ['needs-you', 'finished', 'fyi']
const ACK_STATES: readonly string[] = ['unacknowledged', 'acknowledged']
const RESOLUTION_STATES: readonly string[] = ['unresolved', 'resolved']

/**
 * One pending item out of an untrusted payload, or null when it is not readable.
 *
 * Built by naming each field rather than by spreading the object, so a field the
 * hub starts sending - a message, a diff, a path from inside a tool call - cannot
 * reach this page by being added to a payload. That is the whole of the
 * content-free argument on this path, and it is why the history panel in
 * ./history.ts is built the same way.
 */
export function parsePendingItem(value: unknown): PendingItemRecord | null {
  if (!isRecord(value)) return null
  const eventId = asToken(value['eventId'])
  const sessionId = asToken(value['sessionId'])
  const eventClass = asToken(value['class'])
  const occurredAt = asToken(value['occurredAt'])
  const ackState = asToken(value['ackState'])
  const resolutionState = asToken(value['resolutionState'])
  if (
    eventId === null ||
    sessionId === null ||
    occurredAt === null ||
    eventClass === null ||
    !PENDING_CLASSES.includes(eventClass) ||
    ackState === null ||
    !ACK_STATES.includes(ackState) ||
    resolutionState === null ||
    !RESOLUTION_STATES.includes(resolutionState)
  ) {
    return null
  }
  return {
    eventId,
    sessionId,
    class: eventClass as PendingItemRecord['class'],
    occurredAt,
    ackState: ackState as PendingItemRecord['ackState'],
    resolutionState: resolutionState as PendingItemRecord['resolutionState'],
  }
}

/**
 * The pending set a read route returned, dropping any row that is not readable.
 *
 * The set is *not* sorted here: `pendingItemFor` below chooses by age, and choosing
 * in one place is what stops the row's marker and the acknowledged item from being
 * decided by two different rules.
 */
export function parsePendingPayload(payload: unknown): readonly PendingItemRecord[] {
  if (!isRecord(payload)) return []
  const items = payload['items']
  if (!Array.isArray(items)) return []
  return items
    .map((entry) => parsePendingItem(entry))
    .filter((entry): entry is PendingItemRecord => entry !== null)
}

/**
 * The item a row acknowledges: the oldest unacknowledged needs-you one.
 *
 * Oldest first, because the row is a single line and a developer pressing Enter on
 * it means "the thing that has been waiting longest". Only a `needs-you` item is
 * eligible, because the ack route's own lifecycle refuses anything else with a 409
 * (HC-FR-05) and a page that asks for a refusal it knows is coming is worse than one
 * that says there is nothing to acknowledge.
 *
 * Ties break on the identifier, so two items stored in the same millisecond are
 * acknowledged in the same order every time - a choice that depended on the hub's
 * row order would change which item a retry acknowledged.
 */
export function pendingItemFor(
  items: readonly PendingItemRecord[],
  sessionId: string,
): PendingItemRecord | null {
  const candidates = items.filter(
    (item) =>
      item.sessionId === sessionId &&
      item.class === 'needs-you' &&
      item.ackState === 'unacknowledged' &&
      item.resolutionState === 'unresolved',
  )
  if (candidates.length === 0) return null
  return (
    [...candidates].sort((left, right) => {
      const byAge = Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
      if (Number.isFinite(byAge) && byAge !== 0) return byAge
      return left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0
    })[0] ?? null
  )
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** One answer, as the transport hands it over: a status and whatever body arrived. */
export interface AckAnswer {
  readonly status: number
  readonly body: unknown
}

/**
 * The one function this page can perform against the hub.
 *
 * An identifier in, an answer out, never a throw: a rejected fetch is a refused
 * acknowledgement, and a refusal that reached the page as an exception would have to
 * be caught to be shown, which is one more place for it to be forgotten.
 */
export type AckTransport = (eventId: string) => Promise<AckAnswer>

/** The slice of `fetch` the transport uses, so a test drives the request and not a mock of it. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface CreateAckTransportOptions {
  /** The origin the page was served from. The only origin this ever posts to. */
  readonly origin: string
  /** The install's write token. `null` yields a transport that refuses without a request. */
  readonly token: string | null
  /** Defaults to the page's own `fetch`. */
  readonly fetchImpl?: FetchLike
}

/**
 * The ack request itself, over `fetch`, from the page's own origin.
 *
 * No body, no `content-type`, no query, and `credentials: 'omit'`: the route reads
 * no body and the token is the whole of the authentication, so anything else in the
 * request would be a field this product sends for no reason. The identifier goes in
 * the path encoded, because a row key is a UUID and a path segment built by
 * concatenation is a path segment a crafted key could walk out of.
 */
export function createFetchAckTransport(options: CreateAckTransportOptions): AckTransport {
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init))
  return async (eventId: string): Promise<AckAnswer> => {
    if (options.token === null) {
      // No credential, no request. Not a 401 the page fabricates: nothing was sent,
      // so nothing may be reported as though the hub had refused it.
      throw new Error(
        `this page has no hub write token, so no acknowledgement was sent (see ${WRITE_TOKEN_HEADER})`,
      )
    }
    const response = await doFetch(
      `${options.origin}${ACK_ROUTE_PREFIX}${encodeURIComponent(eventId)}`,
      {
        method: 'POST',
        headers: { [WRITE_TOKEN_HEADER]: options.token },
        credentials: 'omit',
        cache: 'no-store',
      },
    )
    return { status: response.status, body: await readJson(response) }
  }
}

/** A body, when it is JSON, and `null` when it is not or there is not one. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

/** The read side of the same boundary, for the item to acknowledge. */
export function createFetchPendingReader(options: {
  readonly origin: string
  readonly fetchImpl?: FetchLike
}): PendingItemReader {
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init))
  return async (): Promise<readonly PendingItemRecord[]> => {
    const response = await doFetch(`${options.origin}${PENDING_ROUTE}`, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
    })
    if (!response.ok) {
      throw new Error(`the hub answered ${String(response.status)} for ${PENDING_ROUTE}`)
    }
    return parsePendingPayload((await response.json()) as unknown)
  }
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/**
 * Every way an acknowledgement can fail, as a closed set.
 *
 * Four of the seven are the hub's own `error` codes (src/hub/routes/ack.ts) and
 * three are this page's: it can have no token to present, nothing to acknowledge,
 * and a pending set it could not read. A closed set means a refusal sentence is
 * looked up in a table rather than composed from a status code, which is what keeps
 * a hub-side change from putting a sentence on this page that nobody reviewed.
 */
export const ACK_ERROR_CODES = [
  'unauthorised',
  'not-found',
  'conflict',
  'internal-error',
  'unreadable',
  'no-pending-item',
  'unavailable',
] as const

export type AckErrorCode = (typeof ACK_ERROR_CODES)[number]

/** The hub's own codes, for the check that decides how an answer is read. */
const HUB_ERROR_CODES: readonly string[] = [
  'unauthorised',
  'not-found',
  'conflict',
  'internal-error',
]

/**
 * One fixed sentence per refusal, written here rather than taken from the answer.
 *
 * Nothing from the hub's body becomes a word on this page. The hub's own messages
 * are literals in its ack route and are written for a developer reading a log line;
 * a page composes its own vocabulary, and a page that echoed a body would echo
 * whatever a future body contained.
 */
export const ACK_REFUSAL_SENTENCE: Readonly<Record<AckErrorCode, string>> = Object.freeze({
  unauthorised:
    'The hub refused this acknowledgement because the page could not prove it may write. ' +
    'Nothing was changed.',
  'not-found': 'The hub has no record of that item, so nothing was changed. It may have expired.',
  conflict:
    'The hub would not apply this acknowledgement: that item is no longer waiting on you. ' +
    'Nothing was changed.',
  'internal-error': 'The hub could not complete this acknowledgement. Nothing was changed.',
  unreadable:
    "The hub's pending set could not be read, so nothing was acknowledged rather than " +
    'acknowledging an item this page could not see.',
  'no-pending-item': 'This row is not waiting on anything, so there was nothing to acknowledge.',
  unavailable:
    'This page has no hub write token, so it cannot acknowledge anything. The hub keeps that ' +
    'token out of every response and every served file on purpose.',
})

/** What a refused acknowledgement is, as the page records and shows it. */
export interface AckRefusal {
  readonly code: AckErrorCode
  /** The hub's status, or null for the three failures that never reached it. */
  readonly status: number | null
  /** The lifecycle's reason, when the hub gave one. A closed token, never free text. */
  readonly reason: string | null
  /** The fixed sentence for this code. What the page prints. */
  readonly sentence: string
}

const refusal = (
  code: AckErrorCode,
  status: number | null,
  reason: string | null = null,
): AckRefusal => ({ code, status, reason, sentence: ACK_REFUSAL_SENTENCE[code] })

/**
 * A refusal, as a complete result.
 *
 * Exported because there are two callers that need one: this module's controller,
 * and the page when a caller asks it to acknowledge with no row in hand. Both answer
 * the same shape, because a caller must not have to know which of the two produced
 * what it got.
 */
export function refusedAckResult(sessionId: string, code: AckErrorCode): AckResult {
  return {
    outcome: 'refused',
    sessionId,
    eventId: null,
    pendingCount: null,
    refusal: refusal(code, null),
  }
}

/** What became of an acknowledgement. */
export type AckOutcome =
  /** The hub recorded it as a result of this request. */
  | 'applied'
  /** The hub had already recorded it. A retried click, not a second success. */
  | 'unchanged'
  /** Anything else, with `refusal` saying which. */
  | 'refused'

export interface AckResult {
  readonly outcome: AckOutcome
  readonly sessionId: string
  /** The store's own row key, or null when nothing was acknowledged. */
  readonly eventId: string | null
  /**
   * The hub's count after the attempt, taken from the 200 body.
   *
   * The hub's number and not a decrement this page computed: `/api/pending` is the
   * single source the tray badge draws from (NT-FR-05), and the page and the badge
   * must not be able to disagree about the same state (LD-FR-04).
   */
  readonly pendingCount: number | null
  readonly refusal: AckRefusal | null
}

/**
 * Read one answer, whatever it was.
 *
 * A 200 whose body this build cannot read is a refusal rather than a silent success:
 * a page that treated an unreadable answer as "done" would clear a pending marker on
 * the strength of a response nobody could interpret.
 */
export function parseAckAnswer(sessionId: string, answer: AckAnswer): AckResult {
  const body = isRecord(answer.body) ? answer.body : null
  if (answer.status === 200) {
    const outcome = asToken(body?.['outcome'])
    const acknowledged = body?.['acknowledged'] === true
    const declared = body?.['pendingCount']
    const pendingCount =
      typeof declared === 'number' && Number.isFinite(declared) && declared >= 0
        ? Math.floor(declared)
        : null
    const eventId = asToken(body?.['eventId'])
    if (outcome === 'applied' || (outcome === null && acknowledged)) {
      return { outcome: 'applied', sessionId, eventId, pendingCount, refusal: null }
    }
    if (outcome === 'unchanged') {
      return { outcome: 'unchanged', sessionId, eventId, pendingCount, refusal: null }
    }
    return {
      outcome: 'refused',
      sessionId,
      eventId,
      pendingCount,
      refusal: refusal('internal-error', answer.status),
    }
  }
  const code = asToken(body?.['error'])
  const hubCode =
    code !== null && HUB_ERROR_CODES.includes(code) ? (code as AckErrorCode) : 'internal-error'
  return {
    outcome: 'refused',
    sessionId,
    eventId: null,
    pendingCount: null,
    refusal: refusal(hubCode, answer.status, asToken(body?.['reason'])),
  }
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

/** The optimistic half, told to the page before the request goes out. */
export interface AckOptimistic {
  readonly sessionId: string
  readonly eventId: string
  /** When the page decided this. The page's clock, never the hub's. */
  readonly at: string
}

export interface CreateAckControllerOptions {
  /** `null` when this page holds no write token. Nothing is sent, and it says so. */
  readonly transport: AckTransport | null
  /** How the pending set is read. Re-read immediately before each acknowledgement. */
  readonly readPending: PendingItemReader
  /** The page's clock. Defaults to the wall clock. */
  readonly now?: () => string
  /** Called before the request, so the row's marker can clear immediately. */
  readonly onOptimistic?: (optimistic: AckOptimistic) => void
  /** Called once with the answer, refused or not. */
  readonly onSettled?: (result: AckResult) => void
}

export interface AckController {
  /**
   * Acknowledge one row's oldest waiting item.
   *
   * Resolves with what happened; never rejects. A rejected request is a refusal with
   * a code, because the one thing this page must not do with a failed write is
   * nothing at all.
   */
  acknowledge(sessionId: string): Promise<AckResult>
  /** The item a row would acknowledge right now, from the last read. Null when none. */
  pendingItemFor(sessionId: string): PendingItemRecord | null
  /** Re-read the pending set. The page does this when the rows change. */
  refreshPending(): Promise<void>
  /** Whether the last read of the pending set succeeded. */
  readonly pendingSetReadable: boolean
  /** Whether this page holds the token the write route needs. */
  readonly hasToken: boolean
  /** What the page says when it does not. The same sentence the refusal carries. */
  readonly unavailableSentence: string
  /** Called after every re-read, so the page can re-render a row's marker. */
  onChange(listener: () => void): void
  readonly isClosed: boolean
  destroy(): void
}

export function createAckController(options: CreateAckControllerOptions): AckController {
  const now = options.now ?? ((): string => new Date().toISOString())
  const listeners = new Set<() => void>()
  let pending: readonly PendingItemRecord[] = []
  let pendingSetReadable = true
  let destroyed = false

  const refused = (sessionId: string, code: AckErrorCode): AckResult => {
    const result = refusedAckResult(sessionId, code)
    options.onSettled?.(result)
    return result
  }

  const refreshPending = async (): Promise<void> => {
    if (destroyed) return
    try {
      const next = await options.readPending()
      if (destroyed) return
      pending = next
      pendingSetReadable = true
    } catch {
      // A pending set this page could not read is remembered as empty, and the
      // acknowledgement that follows is refused with `unreadable` rather than
      // answered against a set that may be stale. `pendingSetReadable` is what
      // tells "nothing is waiting" from "this page could not see".
      if (destroyed) return
      pending = []
      pendingSetReadable = false
    }
    for (const listener of [...listeners]) listener()
  }

  const acknowledge = async (sessionId: string): Promise<AckResult> => {
    if (destroyed || options.transport === null) return refused(sessionId, 'unavailable')
    // Read the pending set immediately before choosing the item. The page's copy can
    // be a frame behind, and acknowledging an item the hub has already resolved is
    // a 409 that tells the developer their action was wrong when it was not.
    await refreshPending()
    if (destroyed) return refused(sessionId, 'unavailable')
    if (!pendingSetReadable) return refused(sessionId, 'unreadable')
    const item = pendingItemFor(pending, sessionId)
    if (item === null) return refused(sessionId, 'no-pending-item')
    options.onOptimistic?.({ sessionId, eventId: item.eventId, at: now() })
    let result: AckResult
    try {
      result = parseAckAnswer(sessionId, await options.transport(item.eventId))
    } catch {
      // A socket that would not open, a body that could not be read: both are "the
      // hub did not answer", which is a refusal and not an exception. The message is
      // deliberately not carried into the sentence: this page's words are the
      // table's words, and a thrown message is a transport's words.
      result = {
        outcome: 'refused',
        sessionId,
        eventId: item.eventId,
        pendingCount: null,
        refusal: refusal('internal-error', null),
      }
    }
    options.onSettled?.(result)
    return result
  }

  return {
    acknowledge,
    pendingItemFor: (sessionId: string) => pendingItemFor(pending, sessionId),
    refreshPending,
    get pendingSetReadable(): boolean {
      return pendingSetReadable
    },
    get hasToken(): boolean {
      return options.transport !== null && !destroyed
    },
    get unavailableSentence(): string {
      return ACK_REFUSAL_SENTENCE.unavailable
    },
    onChange(listener: () => void): void {
      listeners.add(listener)
    },
    get isClosed(): boolean {
      return destroyed
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      listeners.clear()
      pending = []
    },
  }
}
