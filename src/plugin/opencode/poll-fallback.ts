// The polling fallback: the path that reports what the event stream did not
// (OA-FR-07, OA-FR-02, OA-FR-03, APX-FR-02, APX-CON-03, APX-CON-09, APX-CON-10,
// APX-CON-12, APX-CON-13, ADR-004, PRD 5, PRD 16 #4).
//
// WHAT THIS MODULE IS
// A client of opencode's own local HTTP API, running beside the event hooks, that
// reads three things the hooks may never have delivered: which sessions are running,
// whether one of them has finished, and which permission requests are still pending. It
// exists for one sentence: a plugin that is present but whose push delivery is
// unavailable must still report, and must report the same state a working push would
// have reported.
//
// IT GOES THROUGH THE TRANSLATOR, NOT AROUND IT
// Every discovery is turned into the *harness event* the push path would have received -
// `{ type: "session.status", properties: { sessionID, status: { type: "idle" } } }` for a
// finished session, `{ type: "permission.updated", properties: { id, sessionID } }` for a
// pending block - and handed to `translator.observe(...)`, the same function
// `src/plugin/opencode/index.ts` calls for every harness hook. That is the whole reason
// a polled signal and a pushed one cannot disagree:
//
//   - the same table row decides the class, the subtype and the `posts` decision;
//   - the same work-signal recorder supplies the turn's work, and the same `reportTurn`
//     clears it, so the idle gate reads the turn the hooks actually saw (OA-FR-03);
//   - the same mint supplies the transition identity. `reportTurn` takes the recorder's
//     own `transitionId`, which is what `currentTransitionId` would have returned, so a
//     poller never derives identity of its own - the seam OA-1 recorded for exactly
//     this caller;
//   - the same `classify` call produces the same `dedupeKey`.
//
// So there is exactly one derivation of a dedupe key in this product, and it is the
// classifier's (src/domain/classify.ts, EL-FR-06). This file builds no key, mints no
// identity and re-implements no rule. A second derivation is a duplicate-event bug
// waiting for the first session that both pushes and is polled (OA-FR-07).
//
// THE ONE PLACE IT DIVERGES FROM THE PUSH PATH, AND WHY IT IS SAFE
// The push path hands every signal it builds to the delivery port, including one the
// classifier says produces no event, because `permission.replied` produces no event and
// still has to travel: the hub's pending lifecycle clears the block on it (EL-FR-08). This
// fallback does not do that, and the reason is that it never infers a resolution (see A
// RESOLUTION IS NEVER INFERRED below), so the only no-event signal it can build is an idle
// transition the gate already suppressed - and posting that would spend a request on a
// greeting turn whose answer is known. Nothing this module can produce is lost by the
// divergence, and the gate's decision stays visible in the translator's counters and in the
// hub's own classification of every signal that is delivered.
//
// THE DEDUPE LEDGER IS SHARED WITH THE PUSH PATH, AND IT IS WHY BOTH CAN RUN
// The entry point records every key it pushes; the fallback claims a key before it
// delivers one, and a refused claim means "this state was already reported". A session
// that pushes and is polled therefore produces ONE delivery of each state. Without a
// shared ledger the two paths could not know about each other, and the hub's unique index
// on the dedupe key would be the only thing standing between a session and a second
// notification.
//
// The ledger records an *attempt*, not an acceptance, because `DeliverPort` returns
// `void` and cannot report an acceptance. That asymmetry is deliberate and its cost is
// stated: a delivery that failed is not re-attempted by the poller, because re-attempting
// it would be a retry, and a retry inside a harness plugin is a session-latency bug
// (APX-CON-10). What the developer sees instead is the delivery breadcrumb OA-2 already
// writes. One consequence worth naming: a turn that ended while the hub was down is
// reported by neither path, and the breadcrumb is the record of it.
//
// THE DIRECTION OF THE DEDUPE, AND ITS ONE RESIDUAL DUPLICATE
// Push records and always delivers; poll claims and delivers only if it wins the claim.
// So a poll that arrives *after* a push is suppressed, which is the case the
// requirement is about, and it is the common one: the hook fires when opencode emits the
// event, and the poller only looks every few seconds. The reverse - a poll that wins and
// a push that arrives afterwards - yields one redundant request, and still one stored
// event, because the two carry the same key and the hub's index collapses them. Making
// the push path suppress as well would mean changing OA-1's `posts: 'always'`
// decision, and a pushed signal is the authoritative one; the cost is bounded by a
// single key per state.
//
// ONLY SESSIONS THIS PLUGIN INSTANCE WAS TOLD ABOUT ARE REPORTED
// `/api/session/active` is not scoped by directory - it lists every session the opencode
// server on this machine is running - and a session id is not a repository. Reporting a
// session this plugin was never loaded for would mean inventing the repository identity
// every event carries, and identity is the one thing this product never guesses
// (APX-CON-09, ADR-008). So the fallback reports only sessions the entry point has seen
// an event for (`noteSession`), and counts the rest in `foreignSessions`.
//
// THE COVERAGE BOUNDARY THAT FOLLOWS, STATED RATHER THAN HIDDEN
// A session this plugin is never loaded for is out of reach of this fallback. The
// opencode API does carry a session's own `location.directory` (`SessionV2Info.location`
// in the SDK - see EVIDENCE), so a later version could label those sessions correctly by
// reading one more route; this version does not, because reading a route this task did
// not name is a decision somebody has to make with evidence behind it rather than a
// guess made inside a fallback. The gap is a counter and a breadcrumb, not a silence
// (APX-FR-02).
//
// EVIDENCE: THE THREE ROUTES, AND WHERE EACH WAS READ
// All three are declarations in the local copy of `@opencode-ai/sdk` 1.18.32 - the
// version the running opencode 1.18.32 ships - and every claim below quotes them. PRD 16
// #4 ("are the HTTP fallback route shapes as documented?") is still OPEN: these are
// generated client declarations, not a capture from a running server, so OA-5's live
// script is where they are observed for real. A route that answers differently is a
// *reported failure*, not an empty result - see UNEXPECTED SHAPES below.
//
//   - `GET /api/session/active`
//       `V2SessionActiveData` (url "/api/session/active", no query) and
//       `V2SessionActiveResponses[200] = { data: { [key: string]: unknown | SessionActive } }`
//       with `SessionActive = { type: "running" }`.
//   - `GET /api/session/{sessionID}/wait`
//       `V2SessionWaitData` (url "/api/session/{sessionID}/wait", no query) with
//       `V2SessionWaitResponses[204] = void`, and 404 as `SessionNotFoundError`.
//   - `GET /api/permission/request`
//       `V2PermissionRequestListData` (url "/api/permission/request", query
//       `{ location?: { directory?: string, workspace?: string } }`) and
//       `V2PermissionRequestListResponses[200] = { location: LocationInfo, data:
//       Array<PermissionV2Request> }` with `PermissionV2Request = { id, sessionID, action,
//       resources, save?, metadata?, source? }`.
//       The `location` query is serialized `deepObject` with `explode: true` and its
//       value percent-encoded, which is `location[directory]=<encoded>`:
//       `createQuerySerializer`, `serializeObjectParam` and `serializePrimitiveParam` in
//       the same package, not a guess about a server's parser.
//
// WHAT IS READ OUT OF A RESPONSE, AND WHAT IS NOT
// A session id, a block id and a status string. Nothing else. `PermissionV2Request`
// carries `action`, `resources` and `metadata` - a command, the files it touches, and
// whatever the tool attached - and all three are dropped when the synthetic event is
// built, because a permission's resources are the developer's content and this product
// never holds content (APX-FR-01, APX-CON-12). The response's own `location` is not read
// either: the listing is already scoped by the query this module sends, and reading the
// scope back would be a second contract this build has no evidence for. The permission
// listing carries no timestamp (`PermissionV2Request` has no `time`), so a polled
// block's `occurredAt` is the adapter's own clock - the only one available, and a fact
// about when *this product saw it*, which is what a polled state's timestamp is.
//
// UNEXPECTED SHAPES ARE REPORTED FAILURES, NEVER EMPTY RESULTS
// This is the most important rule in the file. A body this build cannot read as the
// declared shape is a *contract change*, and reading it as "no sessions running" or "no
// permissions pending" would fabricate a quiet: every running session would look
// finished, and every pending block would vanish. So a wrong container throws, the cycle
// fails, the failure is counted, the backoff grows, and a breadcrumb names the route. An
// answer that really is `{ data: {} }` is an empty result, and is the only way to say
// "nothing is running".
//
// A RESOLUTION IS NEVER INFERRED
// A permission that leaves the listing is not reported as a resolution. A resolution is
// something the harness reported; a disappearance is this build's inference, and the
// hub's pending lifecycle clears a block on the resolution signal (EL-FR-08). Inventing
// one would let a poller clear a badge the developer has not actually answered - a
// falsified state, which is worse than a stale one, because a stale badge is visible and
// a wrongly-cleared one is not (ADR-004's restrained reading, APX-FR-02).
//
// THE SCHEDULE, AND WHY IT IS THIS SHAPE
//   - One cycle at a time. A timer that fires while a cycle is in flight is dropped,
//     never queued, so a slow server cannot turn the fallback into a load generator.
//   - Exponential backoff, capped. A failure doubles the delay up to `POLL_MAX_DELAY_MS`
//     and no further; a success resets it to the base.
//   - A hard cap on consecutive failures. After `MAX_CONSECUTIVE_POLL_FAILURES` the
//     fallback STOPS and writes one breadcrumb. A stopped opencode server is not
//     something a developer's session should keep dialling for the rest of the
//     afternoon, and a permanently quiet poller with one visible line is better than a
//     silent one. `start()` resumes with a fresh budget, and the next session gets that
//     for free.
//   - Every request is bounded by a wall-clock timer that destroys the socket, and every
//     timer is `unref`'d, so a pending poll is never the reason a harness process stays
//     alive (APX-CON-03, APX-CON-10).
//   - The wait route is a long poll, so it gets its own longer bound - and a timeout on
//     it is the *expected* answer while a session is working. It is counted as "still
//     running" and never treated as a failure, because a failure there would grow the
//     backoff on every busy turn and stop the fallback exactly when a session needs
//     watching.
//
// IT NEVER BLOCKS THE HARNESS LOOP
// `start()` returns having armed a timer: it opens no socket and awaits nothing. A cycle
// is a promise nobody waits on, every step inside it is bounded, and the whole thing sits
// in one `try` whose handler cannot throw. No hook in src/plugin/opencode/index.ts awaits
// any of it, and `cycle()` resolves rather than rejects, because a rejected promise
// inside somebody else's process is a session failure (APX-CON-03).

import { request as httpRequest } from 'node:http'
import type { HarnessSignal } from '../../domain/classify.js'
import type { HarnessLog, OpencodeEvent, TranslatedSignal, Translator } from './translate.js'
import { AGENT_PING_SERVICE, HARNESS_NAME } from './translate.js'

// ---------------------------------------------------------------------------
// The routes, and the numbers
// ---------------------------------------------------------------------------

/** The three routes, as the SDK declares them. See EVIDENCE at the head of this file. */
export const POLL_ROUTES = {
  /** Which sessions the opencode server is running. */
  activeSessions: '/api/session/active',
  /** The wait-until-idle route, for one session. */
  waitForIdle: '/api/session/{sessionID}/wait',
  /** The pending permission requests, for one location. */
  pendingPermissions: '/api/permission/request',
} as const

/** Which route a failure or a notice is about, as a closed token. */
export type PollRoute = 'active-sessions' | 'wait-for-idle' | 'pending-permissions'

/** The route token for each of the three. A breadcrumb names this, never a path. */
export const POLL_ROUTE_TOKENS: Readonly<Record<keyof typeof POLL_ROUTES, PollRoute>> = {
  activeSessions: 'active-sessions',
  waitForIdle: 'wait-for-idle',
  pendingPermissions: 'pending-permissions',
}

/**
 * The opencode server's default address, from the SDK's own server launcher.
 *
 * `createOpencodeServer` in `@opencode-ai/sdk` 1.18.32 (`dist/server.js`) defaults to
 * `hostname: "127.0.0.1"`, `port: 4096` and then discovers the live URL by reading the
 * server's own stdout. There is no runtime file and no environment variable naming the
 * port, so - unlike the hub, which publishes one and which OA-2 reads rather than
 * guessing - the address has to be a default plus an override.
 *
 * Which is why every breadcrumb this module writes names the endpoint it dialled. A
 * wrong port must be diagnosable as a wrong port rather than indistinguishable from a
 * server that is not running (the same failure mode OA-2 records for the hub's port, one
 * level up).
 */
export const DEFAULT_OPENCODE_HOST = '127.0.0.1'
export const DEFAULT_OPENCODE_PORT = 4096

/** The opencode server this fallback talks to. Loopback only; see `isLoopbackHost`. */
export interface PollEndpoint {
  readonly host: string
  readonly port: number
}

/**
 * The delay between cycles when nothing has failed.
 *
 * Five seconds is a product number, not a measured one, and it is the cadence of a
 * *fallback*: a session that opened, worked and closed entirely between two cycles is
 * invisible to any poller. Two seconds would halve that window at twice the request rate,
 * inside somebody else's process, for a path whose whole value is that it normally
 * reports nothing. Five seconds against a human turn is comfortably inside the window
 * that matters, and it keeps the fallback's steady-state cost at three small loopback
 * requests per cycle (OA-FR-07, APX-CON-03).
 */
export const POLL_BASE_DELAY_MS = 5_000

/**
 * The ceiling the backoff doubles towards.
 *
 * Thirty seconds: long enough that a hub-less afternoon is a handful of requests rather
 * than a few hundred, short enough that the fallback is still worth running when a
 * session comes back.
 */
export const POLL_MAX_DELAY_MS = 30_000

/**
 * Consecutive failures after which the fallback stops and says so.
 *
 * The requirement names this bound, and the failure it prevents is specific: an opencode
 * server that is not running - an interactive session with no server, or one that has
 * exited - would otherwise be dialled for the rest of the process's life from inside a
 * developer's agent. One breadcrumb and then silence is the honest end state, and
 * silence after a *reported* stop is not the silent failure APX-FR-02 forbids.
 */
export const MAX_CONSECUTIVE_POLL_FAILURES = 10

/**
 * The wall-clock bound on one ordinary request.
 *
 * The same shape as OA-2's delivery bound and for the same reason: a server that accepts
 * a connection and never answers must be abandoned, not waited on. 750 ms against
 * loopback answers measured in single-digit milliseconds.
 */
export const POLL_REQUEST_TIMEOUT_MS = 750

/**
 * The bound on the wait route, which is longer because it is a long poll.
 *
 * `GET /api/session/{id}/wait` answers 204 when the session goes idle, so a turn that
 * takes two minutes would hold the socket for two minutes if the bound allowed it. Two
 * seconds is a compromise: a wait long enough to be worth making, short enough that one
 * socket is not held open in somebody else's process. The active listing is what makes
 * idleness observable without it, so a wait that times out costs nothing - and is
 * explicitly not a failure.
 */
export const POLL_WAIT_TIMEOUT_MS = 2_000

/**
 * How many entries one response may list before it is treated as a contract change.
 *
 * A developer has nowhere near this many sessions open. A response that claims to is
 * either a different API or a hostile one, and both are failures this build reports
 * rather than allocates for - the same reason the transport caps its answer body.
 */
export const MAX_POLL_ENTRIES = 512

/**
 * How many keys one ledger holds before the oldest is forgotten.
 *
 * The fallback runs for the life of a process and the push path claims a key per event,
 * so without a bound this is a slow leak. Forgetting the oldest key can only cause one
 * redundant delivery, which the hub's own dedupe collapses - so the failure mode of the
 * bound is a wasted request, never a second event.
 */
export const MAX_LEDGER_ENTRIES = 4_096

/**
 * The largest answer this module will read.
 *
 * A session listing and a permission listing for one location are both a few kilobytes
 * of identifiers. Sixteen is generous, and the cap is here for the same reason it is in
 * the transport: this process belongs to the developer.
 */
export const MAX_POLL_ANSWER_BYTES = 16_384

// ---------------------------------------------------------------------------
// The request seam
// ---------------------------------------------------------------------------

/** One request this module was asked to make. Everything a test needs to inspect it. */
export interface PollRequestInput {
  readonly host: string
  readonly port: number
  readonly path: string
  /** The wall-clock bound, after which the socket is destroyed. */
  readonly timeoutMs: number
}

/** What one attempt produced. Three answers, because a timeout is not a refusal. */
export type PollAnswer =
  | { readonly kind: 'answered'; readonly status: number; readonly body: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed'; readonly errorName: string; readonly errorCode?: string }

export type PollRequest = (input: PollRequestInput) => Promise<PollAnswer>

/**
 * One GET, one socket, one bound.
 *
 * No retry, no queue, no pooled agent, and a wall-clock timer rather than the socket's own
 * inactivity timer: a server that dribbles a body forever is answered by the wall clock,
 * and the timer is cleared only once the whole answer has been read. On expiry the
 * request is destroyed, which releases the socket rather than merely ignoring it
 * (APX-CON-10, and the same three guards as src/plugin/transport/http.ts).
 */
export function sendPollRequest(input: PollRequestInput): Promise<PollAnswer> {
  return new Promise<PollAnswer>((resolve) => {
    let settled = false
    const finish = (answer: PollAnswer): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(answer)
    }

    const request = httpRequest(
      {
        host: input.host,
        port: input.port,
        path: input.path,
        method: 'GET',
        // No pooling: this process is the developer's session, not a service.
        agent: false,
      },
      (response) => {
        const status = response.statusCode ?? 0
        const chunks: Buffer[] = []
        let received = 0
        response.on('data', (chunk: Buffer | string) => {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
          received += buffer.length
          if (received > MAX_POLL_ANSWER_BYTES) {
            finish({ kind: 'answered', status, body: Buffer.concat(chunks).toString('utf8') })
            response.destroy()
            return
          }
          chunks.push(buffer)
        })
        response.once('end', () => {
          finish({ kind: 'answered', status, body: Buffer.concat(chunks).toString('utf8') })
        })
        response.once('error', (cause: unknown) => {
          finish(answerFrom(cause))
        })
        response.once('aborted', () => {
          finish({ kind: 'failed', errorName: 'AbortError', errorCode: 'ECONNRESET' })
        })
      },
    )
    // Armed before the request can be answered, and a timer callback only runs on a later
    // tick of the event loop, so `finish` can never read `timer` before this line set it.
    const timer = setTimeout(() => {
      finish({ kind: 'timeout' })
      // Destroying is the release: the request is abandoned, not merely ignored.
      request.destroy()
    }, input.timeoutMs)
    // A pending poll must never be the reason a harness process stays alive.
    timer.unref?.()

    request.once('error', (cause: unknown) => {
      // A fault after the answer was recorded is a socket artefact of closing a
      // connection this module no longer needs; `finish` keeps the first answer.
      finish(answerFrom(cause))
    })
    request.end()
  })
}

/** A socket fault, as a name and an errno code, and never as a message. */
function answerFrom(cause: unknown): PollAnswer {
  if (!(cause instanceof Error)) return { kind: 'failed', errorName: 'unknown' }
  const code = (cause as NodeJS.ErrnoException).code
  return {
    kind: 'failed',
    errorName: cause.name,
    ...(typeof code === 'string' ? { errorCode: code } : {}),
  }
}

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

/**
 * Everything this module can report, as one closed set.
 *
 * Two kinds share one vocabulary on purpose. A `poll-failed` line is a request that did
 * not produce the answer it was for. A `poll-degraded` line is a *fact about what this
 * fallback cannot report* - a session it may not label, a discovery with nowhere to go,
 * the budget it gave up on - and those are exactly the lines that would otherwise be
 * missing. A developer asking "why did agent-ping not report that session?" is answered
 * by one of them (OA-FR-05, APX-FR-02).
 */
export type PollNoticeCode =
  /** Nothing is listening, or the socket failed: no opencode server on that address. */
  | 'harness-unreachable'
  /** The bound elapsed on an ordinary route. The socket was destroyed. */
  | 'harness-timeout'
  /** The server answered with a status this build does not accept on that route. */
  | 'unexpected-status'
  /** The body is not the shape the SDK declares. A contract change, not an empty result. */
  | 'unexpected-response'
  /** A fault nobody anticipated inside this module. The session was not affected. */
  | 'poll-fault'
  /** Running sessions exist that this plugin instance was never told about. */
  | 'session-not-ours'
  /** A state was discovered and there is no delivery port to report it through. */
  | 'no-delivery-port'
  /** The consecutive-failure cap was reached. Polling has stopped. */
  | 'poll-given-up'

/**
 * The fixed sentence each notice is reported with.
 *
 * A `Record` over the union, so a new code is a compile error until somebody has written
 * the sentence a developer will read. Every sentence is a literal in this file: no value
 * from a response body, a socket or a signal can reach it (APX-FR-01, APX-CON-12).
 */
export const POLL_NOTICE_MESSAGES: Readonly<Record<PollNoticeCode, string>> = {
  'harness-unreachable':
    'agent-ping polled opencode for state the event stream did not deliver and could not reach it, so ' +
    'nothing was reported by the fallback. The opencode server is not running on the address in the ' +
    'agent-ping log, or that address is not on this machine. The event stream is unaffected.',
  'harness-timeout':
    'agent-ping polled opencode for state the event stream did not deliver and the server did not ' +
    'answer in time, so agent-ping gave up on that attempt and reported nothing. The request was ' +
    'abandoned, not retried.',
  'unexpected-status':
    'agent-ping polled opencode and the server answered with a status this build does not accept on ' +
    'that route, so agent-ping reported a failure rather than reading the answer as "nothing is ' +
    'happening". The status is on this line. A version mismatch like this is worth reporting.',
  'unexpected-response':
    'agent-ping polled opencode and the answer was not the shape this build was written against, so ' +
    'agent-ping reported a failure rather than reading it as an empty result. A contract change has to ' +
    'be loud: reading an unknown shape as "nothing is running" would report every session finished.',
  'poll-fault':
    'agent-ping hit an internal fault in its polling fallback. The session was not affected and the ' +
    'event stream is unaffected; this cycle reported nothing.',
  'session-not-ours':
    'agent-ping saw sessions running on the opencode server that this plugin was never given an event ' +
    'for, so the fallback did not report them: a session id is not a repository, and agent-ping does ' +
    'not invent one. Sessions it is attached to are reported normally.',
  'no-delivery-port':
    'agent-ping discovered state worth reporting but no delivery port is wired, so there was nowhere ' +
    'to send it and it was not reported. The adapter is installed; the transport is not connected.',
  'poll-given-up':
    'agent-ping stopped polling opencode after too many consecutive failures, so it is no longer ' +
    'covering the state the event stream did not deliver. Nothing is wrong with the session. Start ' +
    'agent-ping again - or let the next session start it - to resume.',
}

/** One notice, as far as a breadcrumb is allowed to describe it. */
export interface PollNotice {
  readonly code: PollNoticeCode
  readonly route: PollRoute
  /** Present only for a status a server answered with. */
  readonly status?: number
  /** A session, when the notice is about one. */
  readonly sessionId?: string
  /** A fault's name and errno code. Names, never messages. */
  readonly errorName?: string
  readonly errorCode?: string
}

/** The line itself, as the harness's log client is handed it. */
export interface PollBreadcrumb {
  readonly service: string
  readonly stage: 'poll-failed' | 'poll-degraded'
  readonly code: PollNoticeCode
  readonly harness: string
  readonly route: PollRoute
  readonly endpoint: string
  readonly status?: number
  readonly sessionId?: string
  readonly errorName?: string
  readonly errorCode?: string
}

/** The notices that describe a degraded capability rather than a failed request. */
const DEGRADED_CODES: readonly PollNoticeCode[] = [
  'session-not-ours',
  'no-delivery-port',
  'poll-given-up',
]

/**
 * The breadcrumb for one notice, as a pure function.
 *
 * The endpoint is `host:port`, a closed pair of tokens this module chose or was
 * configured with and never anything a response body carried. A session id appears only
 * for a notice that is about one session. Both are there because a breadcrumb is a line a
 * developer reads and a log file keeps (OA-FR-05, APX-CON-12).
 */
export function pollBreadcrumb(notice: PollNotice, endpoint: PollEndpoint): PollBreadcrumb {
  const code = isNoticeCode(notice.code) ? notice.code : 'poll-fault'
  return {
    service: AGENT_PING_SERVICE,
    stage: DEGRADED_CODES.includes(code) ? 'poll-degraded' : 'poll-failed',
    code,
    harness: HARNESS_NAME,
    route: notice.route,
    endpoint: `${endpoint.host}:${endpoint.port}`,
    ...(typeof notice.status === 'number' ? { status: notice.status } : {}),
    ...(isToken(notice.sessionId) ? { sessionId: notice.sessionId } : {}),
    ...(isToken(notice.errorName) ? { errorName: notice.errorName } : {}),
    ...(isToken(notice.errorCode) ? { errorCode: notice.errorCode } : {}),
  }
}

/** Write one breadcrumb through the harness's own logging client, and never throw. */
export function writePollNotice(log: HarnessLog, notice: PollNotice, endpoint: PollEndpoint): void {
  const crumb = pollBreadcrumb(notice, endpoint)
  try {
    log.warn({ message: POLL_NOTICE_MESSAGES[crumb.code], extra: { ...crumb } })
  } catch {
    // A logging client that throws must not turn a poll failure into a session failure.
    // This call is the only remaining path to the developer's screen, and the session
    // continues either way (APX-CON-03, APX-CON-10).
  }
}

function isNoticeCode(value: unknown): value is PollNoticeCode {
  return typeof value === 'string' && Object.hasOwn(POLL_NOTICE_MESSAGES, value)
}

/** A non-empty, single-line token: what a breadcrumb field and a request path may carry. */
function isToken(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !/[\r\n]/.test(value)
}

// ---------------------------------------------------------------------------
// The dedupe ledger
// ---------------------------------------------------------------------------

/**
 * The keys already delivered, shared by the push path and the fallback.
 *
 * `record` is what the push path calls: idempotent, and it answers no question.
 * `claim` is what the fallback calls: it answers "is this mine to deliver?" and takes the
 * key when it is. Two names rather than one because the asymmetry is real - a pushed
 * signal is delivered whatever the ledger says, because it is the primary path, while a
 * polled one is suppressed when the key is already taken.
 */
export interface DedupeLedger {
  /** Note a key that was pushed. Idempotent, and never answers a question. */
  record(key: string): void
  /** Take a key. False when it was already taken, which means "do not deliver". */
  claim(key: string): boolean
  has(key: string): boolean
  forget(key: string): void
  clear(): void
  readonly size: number
}

/**
 * Build the ledger.
 *
 * A `Set` because its iteration order is insertion order, so the oldest key is the first
 * one and the cap evicts in the right direction. Nothing here derives a key or looks
 * inside one: keys arrive from the classifier, already derived, and this object only
 * remembers them (EL-FR-06).
 */
export function createDedupeLedger(maxEntries: number = MAX_LEDGER_ENTRIES): DedupeLedger {
  const cap = Math.max(1, maxEntries)
  const keys = new Set<string>()
  const remember = (key: string): void => {
    // Re-inserting keeps the iteration order the recency order, so a session working
    // now is not the one whose key gets forgotten.
    keys.delete(key)
    keys.add(key)
    while (keys.size > cap) {
      const oldest = keys.values().next()
      if (oldest.done === true) return
      keys.delete(oldest.value)
    }
  }
  return {
    record(key: string): void {
      if (isToken(key)) remember(key)
    },
    claim(key: string): boolean {
      if (!isToken(key)) return false
      if (keys.has(key)) return false
      remember(key)
      return true
    },
    has(key: string): boolean {
      return keys.has(key)
    },
    forget(key: string): void {
      keys.delete(key)
    },
    clear(): void {
      keys.clear()
    },
    get size(): number {
      return keys.size
    },
  }
}

// ---------------------------------------------------------------------------
// The fallback
// ---------------------------------------------------------------------------

/** A timer handle, as this module needs one: opaque, and optionally unref-able. */
export interface PollTimerHandle {
  unref?(): void
}

export type PollTimerScheduler = (run: () => void, delayMs: number) => PollTimerHandle
export type PollTimerCanceller = (handle: PollTimerHandle) => void

/** What one cycle did. Three answers, because a cycle can also do nothing. */
export type PollCycleResult =
  /**
   * `discovered` is what THIS cycle found and ran through the table, so a quiet cycle
   * reports zero rather than a constant.
   */
  | { readonly outcome: 'ok'; readonly discovered: number }
  | {
      readonly outcome: 'failed'
      readonly code: PollNoticeCode
      readonly route: PollRoute
      readonly gaveUp: boolean
    }
  | { readonly outcome: 'skipped'; readonly reason: 'in-flight' | 'given-up' | 'stopped' }

/**
 * What the fallback has seen. Counters and no event data.
 *
 * This is the surface an operator asks "why did nothing arrive?" with, and a count answers
 * that where a log line would carry content (APX-FR-01, APX-FR-02). The two that matter
 * most are `suppressed` - states the push path had already delivered, which is the dedupe
 * working - and `foreignSessions`, which is the coverage boundary stated in numbers.
 */
export interface PollFallbackStats {
  /** Whether the schedule is armed. */
  readonly running: boolean
  /** Whether the consecutive-failure cap stopped it. */
  readonly givenUp: boolean
  readonly cycles: number
  readonly failures: number
  readonly consecutiveFailures: number
  /** The delay the next cycle will wait: the backoff made visible. */
  readonly nextDelayMs: number
  /**
   * States the fallback found and ran through the table, whether or not each one became
   * an event.
   *
   * This is deliberately *not* the same as `reported` or `reported + suppressed`: a state
   * the idle gate refused (a greeting-and-close turn) is a discovery, and it is the count
   * that answers "did the poller see it?". A row that produced no signal at all - a
   * non-idle status, a tool boundary - is not counted, because nothing was found.
   */
  readonly discovered: number
  /** States handed to the delivery port. */
  readonly reported: number
  /** States whose dedupe key was already taken, so nothing was delivered. */
  readonly suppressed: number
  /** Running sessions this plugin instance was never told about. */
  readonly foreignSessions: number
  /** Pending blocks belonging to a session this plugin instance was never told about. */
  readonly foreignPermissions: number
  /** Wait-route answers that meant "this session went idle". */
  readonly idleWaits: number
  /** Wait-route timeouts, which mean "still working" and are not failures. */
  readonly stillRunning: number
  /** Answer entries skipped because they carried no usable identity. */
  readonly malformedEntries: number
  /** Sessions this instance was told about, and can therefore report. */
  readonly trackedSessions: number
}

/**
 * What a caller may tune, as opposed to what the entry point supplies.
 *
 * The four things the entry point owns - the harness's log, the adapter's translator, the
 * repository this instance is attached to, and the shared dedupe ledger - are not
 * tunables, and neither is the delivery port: a second delivery path would be a second
 * place for classification, pending state and delivery policy to diverge. Everything
 * `Omit` leaves is a bound, an address or a seam, and a bound is exactly the kind of thing
 * a test needs to shrink.
 */
export type PollFallbackTuning = Omit<
  PollFallbackOptions,
  'log' | 'translator' | 'directory' | 'ledger' | 'deliver'
>

export interface PollFallbackOptions {
  /** The harness's own logging client, as `createHarnessLog` built it. */
  readonly log: HarnessLog
  /** The adapter's own translator. The same one the hooks call. */
  readonly translator: Translator
  /**
   * The directory this plugin instance is attached to.
   *
   * It scopes the permission listing, and it is the repository path every reported signal
   * carries - which is why only sessions of *this* instance are reported (APX-CON-09,
   * ADR-008).
   */
  readonly directory: string
  /** The shared dedupe ledger: one per plugin instance, shared with the push path. */
  readonly ledger: DedupeLedger
  /** Absent means "push delivery is unavailable", and discoveries become breadcrumbs. */
  readonly deliver?: (signal: HarnessSignal) => void | Promise<void>
  /** Defaults to the SDK's own server default. */
  readonly endpoint?: PollEndpoint
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  readonly maxConsecutiveFailures?: number
  readonly requestTimeoutMs?: number
  readonly waitTimeoutMs?: number
  /** The socket. A test injects a counting fake or points it at a real loopback server. */
  readonly request?: PollRequest
  readonly schedule?: PollTimerScheduler
  readonly cancel?: PollTimerCanceller
}

/** What the entry point holds, and what a test drives. */
export interface PollFallback {
  /** Arm the schedule. Returns having awaited nothing and opened no socket. */
  start(): void
  /** Disarm the schedule. `start()` is what arms it again. */
  stop(): void
  /**
   * Run one cycle now, without arming the schedule.
   *
   * Never throws and never rejects: a cycle that failed resolves with the notice it wrote,
   * because a rejected promise inside somebody else's process is a session failure
   * (APX-CON-03). Resolves `skipped` when a cycle is already in flight, when the failure
   * cap has stopped it, or after `stop()`.
   */
  cycle(): Promise<PollCycleResult>
  /**
   * Tell the fallback a session exists, so it knows which running sessions are ours.
   *
   * Called by the entry point for every harness event that names a session, whether or
   * not the event produced a signal. A session this was never told about is one whose
   * repository this build cannot establish, so it is counted rather than reported
   * (APX-CON-09).
   */
  noteSession(sessionId: string): void
  /** The endpoint this fallback dials, for a breadcrumb and for a test. */
  readonly endpoint: PollEndpoint
  readonly stats: PollFallbackStats
}

/** A failure raised inside a cycle, carrying the notice it should become. */
class PollFailure extends Error {
  readonly notice: PollNotice

  constructor(notice: PollNotice) {
    super(`poll failure: ${notice.code} on ${notice.route}`)
    this.name = 'PollFailure'
    this.notice = notice
  }
}

/**
 * The delay for a streak of consecutive failures, capped. The whole backoff rule.
 *
 * Exported because it is a rule rather than a detail: a test asserts the growth and the
 * ceiling against this function directly, so "the cap holds" is a property of the code and
 * not of a sequence of sleeps.
 */
export function pollBackoffDelay(
  consecutiveFailures: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const base = Math.max(1, baseDelayMs)
  const cap = Math.max(base, maxDelayMs)
  if (consecutiveFailures <= 0) return base
  // Shifting past 30 would overflow the multiplier into a non-finite number, and the cap
  // would stop holding, so the shift is bounded and the cap is the real ceiling.
  const doublings = Math.min(consecutiveFailures - 1, 30)
  return Math.min(base * 2 ** doublings, cap)
}

/**
 * Build the fallback.
 *
 * A closure over one state object rather than a class, so there is no `this` to lose when
 * the entry point hands it to a harness callback, and so the whole of the state is one
 * readable block.
 */
export function createPollFallback(options: PollFallbackOptions): PollFallback {
  const log = options.log
  const translator = options.translator
  const deliver = options.deliver
  const ledger = options.ledger
  const directory = options.directory
  const endpoint: PollEndpoint = {
    host: options.endpoint?.host ?? DEFAULT_OPENCODE_HOST,
    port: options.endpoint?.port ?? DEFAULT_OPENCODE_PORT,
  }
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? POLL_BASE_DELAY_MS)
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? POLL_MAX_DELAY_MS)
  const maxFailures = Math.max(1, options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_POLL_FAILURES)
  const requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? POLL_REQUEST_TIMEOUT_MS)
  const waitTimeoutMs = Math.max(1, options.waitTimeoutMs ?? POLL_WAIT_TIMEOUT_MS)
  const request = options.request ?? sendPollRequest
  const schedule =
    options.schedule ??
    ((run: () => void, delayMs: number): PollTimerHandle => {
      const timer = setTimeout(run, delayMs)
      // A pending poll is not a reason a harness process stays alive (APX-CON-03).
      timer.unref?.()
      return timer
    })
  const cancel =
    options.cancel ??
    ((handle: PollTimerHandle): void => {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    })

  const state = {
    stopped: false,
    givenUp: false,
    inFlight: false,
    cycles: 0,
    failures: 0,
    consecutiveFailures: 0,
    discovered: 0,
    reported: 0,
    suppressed: 0,
    foreignSessions: 0,
    foreignPermissions: 0,
    idleWaits: 0,
    stillRunning: 0,
    malformedEntries: 0,
    foreignReported: false,
    undeliverableReported: false,
    timer: undefined as PollTimerHandle | undefined,
  }

  /** Sessions this instance was told about: the only ones it may report. */
  const ours = new Set<string>()

  /**
   * Running sessions, oldest first.
   *
   * A `Set` rather than a map of timestamps: insertion order *is* the order they started
   * running, so the wait route can be spent on the session that has been working longest
   * and no clock is read to decide it.
   */
  const running = new Set<string>()

  const nextDelayMs = (): number =>
    pollBackoffDelay(state.consecutiveFailures, baseDelayMs, maxDelayMs)

  // -------------------------------------------------------------------------
  // Requesting
  // -------------------------------------------------------------------------

  /**
   * One GET, and whatever answered - the raw answer, classified by the caller.
   *
   * Not classified here because the three routes disagree about what a timeout means: on
   * the two listings it is a failure, and on the wait route it is the expected answer
   * while a session works.
   */
  const send = async (
    route: PollRoute,
    path: string,
    timeoutMs: number,
  ): Promise<PollAnswer> => {
    // The loopback check runs before a socket is opened: a session id and a repository
    // path must never leave this machine because a configured address was wrong
    // (APX-CON-12).
    if (!isLoopbackHost(endpoint.host)) {
      throw new PollFailure({ code: 'harness-unreachable', route })
    }
    try {
      return await request({ host: endpoint.host, port: endpoint.port, path, timeoutMs })
    } catch (cause) {
      // An injected seam that throws, or a fault nobody anticipated. Either way the
      // session continues and the cycle is reported as failed.
      throw new PollFailure({ code: 'poll-fault', route, ...faultNames(cause) })
    }
  }

  /** A 200 whose body this build can go on to read, or a failure. */
  const fetchJson = async (route: PollRoute, path: string, timeoutMs: number): Promise<string> => {
    const answer = await send(route, path, timeoutMs)
    if (answer.kind === 'timeout') throw new PollFailure({ code: 'harness-timeout', route })
    if (answer.kind === 'failed') {
      throw new PollFailure({
        code: 'harness-unreachable',
        route,
        errorName: answer.errorName,
        ...(answer.errorCode === undefined ? {} : { errorCode: answer.errorCode }),
      })
    }
    if (answer.status !== 200) {
      throw new PollFailure({ code: 'unexpected-status', route, status: answer.status })
    }
    return answer.body
  }

  // -------------------------------------------------------------------------
  // Discovering
  // -------------------------------------------------------------------------

  /**
   * Which sessions the server is running, and which of them stopped.
   *
   * Only our own sessions are kept; the rest are counted, because "a session id is not a
   * repository" is the rule and the count is how the boundary becomes visible rather than
   * a silence (APX-CON-09, APX-FR-02).
   */
  const readRunning = async (): Promise<void> => {
    const route = POLL_ROUTE_TOKENS.activeSessions
    const body = await fetchJson(route, POLL_ROUTES.activeSessions, requestTimeoutMs)
    const listed = readSessionMap(body, route)
    let foreign = 0
    for (const sessionId of listed) {
      if (!ours.has(sessionId)) foreign += 1
    }
    state.foreignSessions += foreign
    if (foreign > 0 && !state.foreignReported) {
      // Once, not once per cycle: a repeated line for the life of a session is noise, and
      // the count in `stats` is where a developer reads the number.
      state.foreignReported = true
      writePollNotice(log, { code: 'session-not-ours', route }, endpoint)
    }
    // Edge detection. A session we believed was running and that is not in the listing has
    // stopped running, and that is the only idle evidence this fallback has. The edge
    // fires whether the session went idle, was deleted, or the server it was on was
    // restarted - all three are "it was running, it is not running now", and telling them
    // apart would be a guess about a server this build has not read.
    for (const sessionId of [...running]) {
      if (listed.has(sessionId)) continue
      running.delete(sessionId)
      reportIdle(sessionId)
    }
    for (const sessionId of listed) {
      if (ours.has(sessionId)) running.add(sessionId)
    }
  }

  /**
   * Spend the wait route on the session that has been running longest.
   *
   * One wait per cycle, so there is never more than one long-poll socket open. A 204 is
   * the same "stopped running" edge the listing reports, and so is a 404 - the session is
   * gone, which is the edge the next listing would have produced anyway. A timeout is the
   * *expected* answer while a session works, so it is counted and never treated as a
   * failure: a failure here would grow the backoff on every busy turn and stop the
   * fallback exactly when a session needs watching.
   */
  const waitOnOldest = async (): Promise<void> => {
    const route = POLL_ROUTE_TOKENS.waitForIdle
    const oldest = running.values().next()
    if (oldest.done === true) return
    const sessionId = oldest.value
    const answer = await send(route, waitForIdlePath(sessionId), waitTimeoutMs)
    if (answer.kind === 'timeout') {
      state.stillRunning += 1
      return
    }
    if (answer.kind === 'failed') {
      throw new PollFailure({
        code: 'harness-unreachable',
        route,
        errorName: answer.errorName,
        ...(answer.errorCode === undefined ? {} : { errorCode: answer.errorCode }),
      })
    }
    if (answer.status === 204) state.idleWaits += 1
    // 204 is "idle", 404 is `SessionNotFoundError`, and every other status is a verdict this
    // build does not accept on this route - including a 401 from a server that wants a
    // credential, which is worth a named failure rather than a quiet assumption.
    else if (answer.status !== 404) {
      throw new PollFailure({ code: 'unexpected-status', route, status: answer.status })
    }
    // Either way the session is not running any more, which is the edge. The edge is
    // consumed here so the next cycle's listing does not report the same turn again.
    running.delete(sessionId)
    reportIdle(sessionId)
  }

  /** The blocks still waiting for an answer. See A RESOLUTION IS NEVER INFERRED above. */
  const readBlocks = async (): Promise<void> => {
    const route = POLL_ROUTE_TOKENS.pendingPermissions
    const body = await fetchJson(route, pendingPermissionsPath(directory), requestTimeoutMs)
    for (const block of readPermissionList(body, route)) {
      if (block === undefined) {
        state.malformedEntries += 1
        continue
      }
      if (!ours.has(block.sessionId)) {
        state.foreignPermissions += 1
        continue
      }
      reportBlock(block)
    }
  }

  // -------------------------------------------------------------------------
  // Reporting, through the translator
  // -------------------------------------------------------------------------

  /**
   * One discovered state, as the harness event the push path would have received.
   *
   * The payload is built field by field and never spread, so `PermissionV2Request`'s
   * `action`, `resources` and `metadata` cannot ride along into a signal or a log
   * (APX-FR-01). This is the only place a polled state becomes an event.
   */
  const observe = (event: OpencodeEvent): void => {
    let translated: TranslatedSignal | null
    try {
      translated = translator.observe(event)
    } catch (cause) {
      // A signal this build cannot build. The translator's own ClassificationError quotes
      // no value, and anything else is reported by name only - the same discipline
      // src/plugin/opencode/index.ts applies to a hook.
      writePollNotice(log, { code: 'poll-fault', route: POLL_ROUTE_TOKENS.activeSessions, ...faultNames(cause) }, endpoint)
      return
    }
    if (translated === null) {
      // A row whose effects were applied and which posts nothing: a non-idle status, a tool
      // boundary, an unmapped name. The translator counts those; there is nothing to do.
      return
    }
    const { signal, classification } = translated
    // Counted the moment it is a discovery, before the ledger decides anything, so the
    // number is what was *found*. A count taken after the claim would conflate "the
    // fallback found nothing" with "the fallback found it and the push path already had
    // it", and those are the two questions a developer asks separately.
    state.discovered += 1
    if (classification.outcome !== 'event') {
      // A signal that becomes no event is not delivered, which is the one place the
      // fallback diverges from the push path on purpose. The push path posts a
      // no-event signal because `permission.replied` produces no event and still has to
      // travel: the hub's pending lifecycle clears the block on it (EL-FR-08). A poller
      // never infers a resolution, so the only no-event signal it can build is an idle
      // transition the gate suppressed - and posting that would spend a request on a
      // greeting turn whose answer is already known. Nothing the poller can produce is
      // lost by this, and the gate's decision is still visible in `translator.stats` and
      // in the hub's own classification of every signal that is delivered.
      return
    }
    // The classifier's own key, from the classifier's own derivation. The ledger is the
    // only thing that decides whether this state was already reported, and it is the same
    // ledger the push path writes to, which is what makes a session that both pushes and is
    // polled produce one event (OA-FR-07, EL-FR-06).
    if (!ledger.claim(classification.event.dedupeKey)) {
      state.suppressed += 1
      return
    }
    if (deliver === undefined) {
      // Push delivery is unavailable and there is no other port. The state is real and it
      // is not reported, so it says so once - the degradation is the requirement, not the
      // silence that would otherwise follow.
      if (!state.undeliverableReported) {
        state.undeliverableReported = true
        writePollNotice(
          log,
          { code: 'no-delivery-port', route: POLL_ROUTE_TOKENS.activeSessions, sessionId: signal.sessionId },
          endpoint,
        )
      }
      return
    }
    state.reported += 1
    handOff(signal)
  }

  /** Hand one signal to the delivery port, exactly as the push path does: never await it. */
  const handOff = (signal: HarnessSignal): void => {
    if (deliver === undefined) return
    try {
      const result = deliver(signal)
      if (isThenable(result)) result.then(undefined, () => undefined)
    } catch {
      // A delivery port that throws must not become a session failure. The port owns the
      // breadcrumb for a delivery it could not make (OA-2); this only stops the exception
      // (APX-CON-03, APX-CON-10).
    }
  }

  /** A session that stopped running: the idle transition, through the table. */
  const reportIdle = (sessionId: string): void => {
    observe({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } })
  }

  /** A permission still pending: the block, through the table, with two fields only. */
  const reportBlock = (block: PendingBlock): void => {
    observe({ type: 'permission.updated', properties: { id: block.id, sessionID: block.sessionId } })
  }

  // -------------------------------------------------------------------------
  // The cycle
  // -------------------------------------------------------------------------

  const runCycle = async (): Promise<void> => {
    await readRunning()
    await waitOnOldest()
    await readBlocks()
  }

  const cycle = async (): Promise<PollCycleResult> => {
    if (state.givenUp) return { outcome: 'skipped', reason: 'given-up' }
    if (state.stopped) return { outcome: 'skipped', reason: 'stopped' }
    if (state.inFlight) {
      // A cycle is still going. The next one is dropped rather than queued, so a slow
      // server cannot turn into a pile of cycles.
      return { outcome: 'skipped', reason: 'in-flight' }
    }
    state.inFlight = true
    // The discoveries this cycle made, counted rather than assumed: a cycle that found
    // nothing reports zero, which is the whole difference between a number an operator can
    // read and a constant that only looks like one.
    const before = state.discovered
    try {
      await runCycle()
      state.cycles += 1
      state.consecutiveFailures = 0
      return { outcome: 'ok', discovered: state.discovered - before }
    } catch (cause) {
      const notice = noticeOf(cause)
      state.failures += 1
      state.consecutiveFailures += 1
      if (state.consecutiveFailures >= maxFailures) {
        // The hard cap. Polling stops and says so, once, and the schedule is disarmed: a
        // stopped opencode server is not something a developer's session keeps dialling
        // for the rest of the afternoon.
        state.givenUp = true
        disarm()
        writePollNotice(log, { code: 'poll-given-up', route: notice.route }, endpoint)
        return { outcome: 'failed', ...notice, gaveUp: true }
      }
      writePollNotice(log, notice, endpoint)
      return { outcome: 'failed', ...notice, gaveUp: false }
    } finally {
      state.inFlight = false
    }
  }

  const disarm = (): void => {
    if (state.timer === undefined) return
    cancel(state.timer)
    state.timer = undefined
  }

  /**
   * Arm one cycle from now.
   *
   * Armed only when idle, so there is never more than one pending timer, and never after
   * `stop()` or the failure cap. The callback re-arms *after* the cycle resolves, which is
   * what guarantees a slow cycle delays the next one rather than overlapping it.
   */
  const arm = (): void => {
    if (state.stopped || state.givenUp || state.timer !== undefined) return
    state.timer = schedule(() => {
      state.timer = undefined
      void cycle().then(arm, arm)
    }, nextDelayMs())
  }

  return {
    start(): void {
      if (state.givenUp) {
        // `start` is the recovery: a fresh attempt budget, a fresh schedule, and the same
        // visible reason it stopped last time.
        state.givenUp = false
        state.consecutiveFailures = 0
      }
      state.stopped = false
      arm()
    },
    stop(): void {
      state.stopped = true
      disarm()
    },
    cycle,
    noteSession(sessionId: string): void {
      if (isToken(sessionId)) ours.add(sessionId)
    },
    endpoint,
    get stats(): PollFallbackStats {
      return {
        running: state.timer !== undefined,
        givenUp: state.givenUp,
        cycles: state.cycles,
        failures: state.failures,
        consecutiveFailures: state.consecutiveFailures,
        nextDelayMs: nextDelayMs(),
        discovered: state.discovered,
        reported: state.reported,
        suppressed: state.suppressed,
        foreignSessions: state.foreignSessions,
        foreignPermissions: state.foreignPermissions,
        idleWaits: state.idleWaits,
        stillRunning: state.stillRunning,
        malformedEntries: state.malformedEntries,
        trackedSessions: ours.size,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// The paths
// ---------------------------------------------------------------------------

/**
 * The wait route for one session, with the id percent-encoded.
 *
 * The encoding is the SDK's own `pathSerializer`, which percent-encodes a path parameter.
 * An id that is not a single-line token cannot go in a path at all, so it is refused here
 * rather than turned into a request nobody could attribute.
 */
export function waitForIdlePath(sessionId: string): string {
  if (!isToken(sessionId)) {
    throw new Error('a session id must be a single-line token to be used in a request path')
  }
  return POLL_ROUTES.waitForIdle.replace('{sessionID}', encodeURIComponent(sessionId))
}

/**
 * The pending-permission route for one location, as the SDK serializes it.
 *
 * `location[directory]=<encoded>`: `deepObject` style, `explode: true`, the value
 * percent-encoded, and the brackets part of the parameter name rather than part of an
 * encoded value. That is `createQuerySerializer` and `serializeObjectParam` in the same
 * package, so this string is the client's own encoding rather than a guess about a server's
 * parser.
 */
export function pendingPermissionsPath(directory: string): string {
  return `${POLL_ROUTES.pendingPermissions}?location[directory]=${encodeURIComponent(directory)}`
}

// ---------------------------------------------------------------------------
// Reading a response, or reporting that it is not one
// ---------------------------------------------------------------------------

/** The two identities a block carries, and nothing else. */
interface PendingBlock {
  readonly id: string
  readonly sessionId: string
}

/**
 * The running session ids, or a failure.
 *
 * `V2SessionActiveResponses[200]` is `{ data: { [key: string]: unknown | SessionActive } }`,
 * so the container must be an object, `data` must be an object, and every value must be an
 * object with a string `type`. Anything else is a contract change - and reading it as an
 * empty listing would report every running session finished, which is the most destructive
 * thing this fallback could possibly do.
 */
function readSessionMap(body: string, route: PollRoute): ReadonlySet<string> {
  const container = parseObject(body)
  if (container === undefined) throw shapeFailure(route)
  const data = container['data']
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw shapeFailure(route)
  const entries = Object.entries(data as Readonly<Record<string, unknown>>)
  if (entries.length > MAX_POLL_ENTRIES) throw shapeFailure(route)
  const listed = new Set<string>()
  for (const [sessionId, value] of entries) {
    if (!isToken(sessionId)) throw shapeFailure(route)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw shapeFailure(route)
    }
    if (!isToken((value as Readonly<Record<string, unknown>>)['type'])) throw shapeFailure(route)
    listed.add(sessionId)
  }
  return listed
}

/**
 * The pending blocks, or a failure for the container and `undefined` for one bad entry.
 *
 * `V2PermissionRequestListResponses[200]` is `{ location: LocationInfo, data:
 * Array<PermissionV2Request> }` and each request is `{ id, sessionID, ... }`. The container
 * is a contract and is enforced as one; a single entry without the two identities is counted
 * and skipped rather than failing the whole listing, because a container that is right with
 * one bad row is a data problem and a container that is wrong is a version change. The count
 * is in `stats` and the row is dropped rather than guessed at.
 */
function readPermissionList(body: string, route: PollRoute): readonly (PendingBlock | undefined)[] {
  const container = parseObject(body)
  if (container === undefined) throw shapeFailure(route)
  const data = container['data']
  if (!Array.isArray(data)) throw shapeFailure(route)
  if (data.length > MAX_POLL_ENTRIES) throw shapeFailure(route)
  return data.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const record = entry as Readonly<Record<string, unknown>>
    const id = record['id']
    const sessionId = record['sessionID']
    if (!isToken(id) || !isToken(sessionId)) return undefined
    // `action`, `resources`, `save`, `metadata` and `source` are dropped here and are never
    // read: they are the developer's content (APX-FR-01, APX-CON-12).
    return { id, sessionId }
  })
}

function shapeFailure(route: PollRoute): PollFailure {
  return new PollFailure({ code: 'unexpected-response', route })
}

/** A JSON object, or undefined for anything else. Never throws. */
function parseObject(body: string): Readonly<Record<string, unknown>> | undefined {
  if (body === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Readonly<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Small guards
// ---------------------------------------------------------------------------

/** A fault's name and errno code, and never its message. */
function faultNames(cause: unknown): { errorName?: string; errorCode?: string } {
  if (!(cause instanceof Error)) return { errorName: 'unknown' }
  const code = (cause as NodeJS.ErrnoException).code
  return {
    errorName: cause.name,
    ...(typeof code === 'string' ? { errorCode: code } : {}),
  }
}

/** Whatever a cycle threw, as the notice it should have been. */
function noticeOf(cause: unknown): Omit<PollNotice, 'status' | 'sessionId' | 'errorName' | 'errorCode'> & {
  status?: number
  sessionId?: string
  errorName?: string
  errorCode?: string
} {
  if (cause instanceof PollFailure) return { ...cause.notice }
  return { code: 'poll-fault', route: POLL_ROUTE_TOKENS.activeSessions }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/**
 * Is this a loopback host?
 *
 * The same shape the hub's own predicate accepts, written out here because this file has to
 * load inside the harness with no dependency: the literal names, plus the whole
 * `127.0.0.0/8` block, which is what a developer on a machine with several loopback
 * addresses is bound to. A name that is not one of them is refused rather than dialled,
 * because a session id and a repository path must never leave this machine because an
 * address was misconfigured (APX-CON-12).
 */
export function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true
  if (host === '::ffff:127.0.0.1') return true
  const literal = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (literal === null) return false
  const octets = literal.slice(1, 5).map(Number)
  if (octets.some((octet) => octet > 255)) return false
  return octets[0] === 127
}
