// Delivery from inside the harness process to the hub running on this machine
// (OA-FR-04, OA-FR-05, APX-FR-02, APX-CON-03, APX-CON-10, ADR-002, PRD 6.3).
//
// THE ONE PROPERTY THIS MODULE EXISTS TO KEEP
// A developer's session must behave exactly as it would with no adapter installed. That
// is not a style preference: this code runs inside someone else's process, on every
// harness event, on a machine that may be running six sessions at once. So every shape
// here is chosen to bound the worst case rather than the average:
//
//   - Fire and forget. `deliver` returns a promise the caller is free to ignore, and
//     nothing here awaits anything before that promise exists. A harness hook that
//     calls this and moves on is not slowed by it.
//   - One attempt, no retry, ever. A refused connection, a 500 and a timeout are all
//     answered with a breadcrumb and the end of the attempt. A retry inside a plugin
//     is a session-latency bug: the hub may be busy or wedged, and recovering from
//     that is the hub's job (APX-CON-10).
//   - A bounded wall-clock timeout that destroys the socket, so a hub which accepts a
//     connection and never answers cannot hold anything open - not the promise, not
//     the event loop, and not the process at the end of a session (the timer is
//     unref'd, so a pending delivery is not a reason a harness stays alive).
//   - Never throws. Every failure is a resolved result plus a breadcrumb through the
//     harness's own logging client, which is the only place a developer can see it
//     (OA-FR-05, ./breadcrumb.ts).
//
// WHERE THE PORT AND THE TOKEN COME FROM, AND WHY NEITHER IS GUESSED
// Both are read out of the state directory, and the runtime file is the published
// contract for finding them (src/hub/runtime-file.ts): it records the live port, and
// its `stateDir` field is documented as "where the log and the token live, so a
// reader needs one lookup". So a machine running two installs, or a hub that bound a
// different port because the preferred one was taken, is found correctly rather than
// mis-dialled - a guessed default port is a silent failure mode, because reaching a
// foreign service on the machine looks exactly like the hub being down.
//
// The token is the install's write token, presented in the header the hub publishes
// (`x-agent-ping-token`, src/hub/security.ts). The ingest route does not require it
// today - the token guards the one route that changes an existing record, and
// requiring it on ingest would mean every adapter had to hold the write capability
// (ADR-002) - but it is sent anyway, because an adapter that only works while a route
// happens to be unauthenticated is an adapter that breaks the day that changes. A
// token that cannot be read is a refused delivery rather than an unauthenticated one:
// quietly dropping the credential is how a client ends up with a broken capability
// nobody diagnosed.
//
// THE LOOPBACK CHECK IS NOT DEFENSIVE PROGRAMMING
// The host is read from a file, so a corrupted or edited runtime file could aim this
// request at another machine. Session identifiers, event names and a repository path
// would then leave the developer's computer on a socket they never asked for, which is
// the one thing a sidecar must never do (APX-CON-12). The same predicate the hub uses
// to refuse a non-loopback caller is used here to refuse to become one.
//
// WHAT IS POSTED, AND WHAT IS NOT
// A harness *signal*, not an envelope, and not the wire field set verbatim: the hub
// owns the class, the subtype and the dedupe key, and it refuses a body carrying any
// of them (src/hub/routes/ingest.ts, ADR-002). `receivedAt` is dropped for the same
// reason in the other direction: it is when the *hub* received the event, so a
// caller-supplied value would be a claim about someone else's clock. `toIngestBody`
// is the whole of that mapping, and it is exported so a test - or OA-4's poller - can
// check it against the route's own field list rather than trusting it.
//
// THE SEAMS, AND WHY THERE ARE FOUR
// `endpoint`, `token`, `send` and `log` are injectable because each names a thing that
// can be wrong in a different way: a hub that is not running, an install whose token
// file is damaged, a server that never answers, and a logging client that throws. The
// defaults are the real readers and the real socket, and a test drives both halves -
// the defaults against a real hub started by the real entry point, and the seams
// against a server that hangs, refuses or answers nonsense. The transport is also the
// plugin's delivery port: `createHubTransport({ log })` is what OA-3's installed
// artefact passes as `deliver`, with the log built by `createHarnessLog` from the
// harness's own client.

import { request as httpRequest } from 'node:http'
import type { HarnessSignal } from '../../domain/classify.js'
import type { RuntimeFile } from '../../hub/runtime-file.js'
import { readRuntimeFile } from '../../hub/runtime-file.js'
import { isLoopbackAddress, readWriteToken, WRITE_TOKEN_HEADER } from '../../hub/security.js'
import { resolveStateDir } from '../../storage/paths.js'
import type { HarnessLog } from '../opencode/translate.js'
import type { DeliveryFailure, DeliveryFailureCode } from './breadcrumb.js'
import { writeDeliveryBreadcrumb } from './breadcrumb.js'

// ---------------------------------------------------------------------------
// The bounds
// ---------------------------------------------------------------------------

/**
 * The path the signal is posted to.
 *
 * Named here rather than imported from the route table, because this is the connector
 * end of a wire contract and a connector that imports the hub's server module would
 * have to load the hub to say where it posts. tests/plugin/transport.test.ts asserts
 * this string against `INGEST_ROUTES` in the hub, so the two cannot drift apart
 * without a failure.
 */
export const INGEST_PATH = '/api/ingest'

/**
 * How long one delivery may take, end to end.
 *
 * 750 ms, against an observed ingest p95 of about 5 ms: two orders of magnitude of
 * headroom for a busy Electron main process, and short enough that a wedged hub is
 * abandoned before a developer would call it a pause. The number is a default rather
 * than a constant because a test drives a hung server at a tenth of it - the property
 * under test is that the configured bound is honoured, not what the bound is.
 */
export const DELIVERY_TIMEOUT_MS = 750

/**
 * The largest answer this transport will read.
 *
 * The hub's 202 and refusal bodies are a few hundred bytes of closed tokens, so four
 * kilobytes is generous. The cap is here for the same reason the route has one: this
 * process belongs to the developer, and a socket that answers forever must not be
 * able to make it allocate forever.
 */
export const MAX_ANSWER_BYTES = 4_096

// ---------------------------------------------------------------------------
// Finding the hub
// ---------------------------------------------------------------------------

/** A live hub, as published by its own runtime file. */
export interface HubEndpoint {
  readonly host: string
  readonly port: number
  /**
   * Where this hub's log and token live, taken from the runtime file's own `stateDir`
   * field rather than assumed - that field exists so a client needs one lookup
   * (src/hub/runtime-file.ts).
   */
  readonly stateDir: string
  readonly instanceId: string
}

/** What looking for a hub produced, as the four answers there are. */
export type EndpointLookup =
  /** A hub with a published port. */
  | { readonly kind: 'found'; readonly endpoint: HubEndpoint }
  /** No runtime file: nothing is running, or it shut down cleanly. */
  | { readonly kind: 'not-running' }
  /** The file exists and has no port yet: the hub is still starting. */
  | { readonly kind: 'starting' }
  /** The file is there and cannot be understood. */
  | { readonly kind: 'unreadable' }

export type EndpointReader = (stateDir: string) => EndpointLookup

/** What reading the install's token produced, as the three answers there are. */
export type TokenLookup =
  | { readonly kind: 'found'; readonly token: string }
  /** No token file: this install has none, which is a broken install beside a hub. */
  | { readonly kind: 'absent' }
  /** The file is there and cannot be understood. */
  | { readonly kind: 'unreadable' }

export type TokenReader = (stateDir: string) => TokenLookup

/**
 * The live hub, from the runtime file.
 *
 * A missing file is `not-running` and an unreadable one is `unreadable`, and the
 * difference is the whole reason this is a four-way answer rather than a nullable
 * endpoint: the first is a machine where the developer has not started the product
 * and the second is a machine something has damaged. A reader that collapsed them
 * would report one of them as the other, and one of those two reports is a lie.
 *
 * Never a default port. A hub that has not published one has not bound a socket yet,
 * and a guessed port reaches whatever is listening there (src/hub/runtime-file.ts).
 */
export function readEndpointFromRuntimeFile(stateDir: string): EndpointLookup {
  let record: RuntimeFile | null
  try {
    record = readRuntimeFile(stateDir)
  } catch {
    return { kind: 'unreadable' }
  }
  if (record === null) return { kind: 'not-running' }
  if (record.port === null) return { kind: 'starting' }
  return {
    kind: 'found',
    endpoint: {
      host: record.host,
      port: record.port,
      stateDir: record.stateDir,
      instanceId: record.instanceId,
    },
  }
}

/**
 * The install's write token, from the state directory beside the runtime file.
 *
 * Read, never created: a token this transport generated would be a token no other
 * client holds, and the hub's own `ensureWriteToken` is the only thing allowed to
 * issue one (src/hub/security.ts). A damaged file is `unreadable` rather than absent,
 * because the difference is a repairable file versus a missing one.
 */
export function readTokenFromInstall(stateDir: string): TokenLookup {
  try {
    const token = readWriteToken(stateDir)
    return token === null ? { kind: 'absent' } : { kind: 'found', token }
  } catch {
    return { kind: 'unreadable' }
  }
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** What one request was asked to send. Everything a test needs to inspect it. */
export interface SendRequestInput {
  readonly host: string
  readonly port: number
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  /** The wall-clock bound, after which the socket is destroyed. */
  readonly timeoutMs: number
}

/** What one attempt produced. Three answers, because a timeout is not a refusal. */
export type SendResult =
  /** The hub answered, or something did. `body` is capped, not necessarily complete. */
  | { readonly kind: 'answered'; readonly status: number; readonly body: string }
  /** The bound elapsed with no answer; the socket was destroyed. */
  | { readonly kind: 'timeout' }
  /** The request itself failed. Names only, never a message. */
  | { readonly kind: 'failed'; readonly errorName: string; readonly errorCode?: string }

export type SendRequest = (input: SendRequestInput) => Promise<SendResult>

/**
 * One POST, one socket, one bound.
 *
 * There is no retry anywhere in this function and there is no path that reopens a
 * socket, which is what makes "no retry storm" a property of the code rather than a
 * promise about the code (APX-CON-10). `agent: false` gives the request its own
 * one-shot agent so nothing is pooled and kept warm inside somebody else's process.
 *
 * The bound is a wall-clock timer rather than the socket's own inactivity timer,
 * because the two answer different questions and this one needs both: a hub that
 * accepts and then dribbles a body forever is answered by the wall clock, and a
 * response whose body never ends is answered by it too since the timer is only
 * cleared when the whole answer has been read. On expiry the request is destroyed,
 * which is what releases the socket - a promise that resolved while a connection sat
 * open would be a session's worth of leaked descriptor.
 */
export function sendHttpRequest(input: SendRequestInput): Promise<SendResult> {
  return new Promise<SendResult>((resolve) => {
    let settled = false
    const finish = (result: SendResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const request = httpRequest(
      {
        host: input.host,
        port: input.port,
        path: input.path,
        method: 'POST',
        headers: input.headers,
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
          if (received > MAX_ANSWER_BYTES) {
            // The cap is a property of this client, so it stops reading and says the
            // answer was incomplete rather than growing to match whatever arrived.
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
          finish(failedFrom(cause))
        })
        response.once('aborted', () => {
          finish({ kind: 'failed', errorName: 'AbortError', errorCode: 'ECONNRESET' })
        })
      },
    )
    // Armed before the request can be answered, and a timer callback only runs on a
    // later tick of the event loop - so the `clearTimeout` in `finish` can never read
    // `timer` before this line has initialised it.
    const timer = setTimeout(() => {
      finish({ kind: 'timeout' })
      // Destroying is the release: the request is abandoned, not merely ignored.
      request.destroy()
    }, input.timeoutMs)
    // A pending delivery must never be the reason a harness process stays alive.
    timer.unref?.()

    request.once('error', (cause: unknown) => {
      // A fault after the answer was already recorded is a socket artefact of closing
      // a connection this transport no longer needs; `finish` keeps the first answer.
      finish(failedFrom(cause))
    })
    request.end(input.body)
  })
}

/** A socket fault, as a name and an errno code, and never as a message. */
function failedFrom(cause: unknown): SendResult {
  if (!(cause instanceof Error)) return { kind: 'failed', errorName: 'unknown' }
  const code = (cause as NodeJS.ErrnoException).code
  return {
    kind: 'failed',
    errorName: cause.name,
    ...(typeof code === 'string' ? { errorCode: code } : {}),
  }
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

/**
 * The signal as the ingest route's closed field set, and nothing else.
 *
 * Three fields are deliberately not here. `class`, `subtype` and `dedupeKey` are the
 * hub's to decide and the route refuses a body carrying any of them, so producing them
 * here would be a guaranteed 422 (ADR-002). `receivedAt` is absent for the opposite
 * reason: the route stamps the hub's own clock, and a caller-supplied value would be
 * a claim about a daemon this process does not own. What remains is exactly
 * `INGEST_SIGNAL_FIELDS`, and the test asserts that against the route's own list.
 */
export function toIngestBody(signal: HarnessSignal): Readonly<Record<string, unknown>> {
  return {
    harness: signal.harness,
    eventName: signal.eventName,
    ...(signal.variant === undefined ? {} : { variant: signal.variant }),
    sessionId: signal.sessionId,
    repoFullPath: signal.repoFullPath,
    ...(signal.transitionId === undefined ? {} : { transitionId: signal.transitionId }),
    occurredAt: signal.occurredAt,
    ...(signal.turnWork === undefined ? {} : { turnWork: { ...signal.turnWork } }),
    ...(signal.measurements === undefined ? {} : { measurements: { ...signal.measurements } }),
  }
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/**
 * What one attempt achieved.
 *
 * `accepted` is the only outcome that means the hub has the signal, and it means the
 * hub answered 202 - not that this process heard an acknowledgement of anything else.
 * The other two carry the code the breadcrumb was written with, so a caller that wants
 * to count failures (OA-5's live script) does not have to parse log lines.
 */
export type DeliveryResult =
  | {
      readonly outcome: 'accepted'
      readonly status: number
      /** The hub's own outcome token, when its answer was readable. */
      readonly hubOutcome?: string
      /** The stored row's key, or null when the hub stored nothing. */
      readonly eventId?: string | null
    }
  | {
      readonly outcome: 'refused'
      readonly status: number
      readonly code: DeliveryFailureCode
      readonly hubError?: string
    }
  | { readonly outcome: 'failed'; readonly code: DeliveryFailureCode }

export interface HubTransportOptions {
  /** The harness's own logging client, as `createHarnessLog` built it. */
  readonly log: HarnessLog
  /** Defaults to the resolved state directory, honouring AGENT_PING_STATE_DIR. */
  readonly stateDir?: string
  /** Defaults to `DELIVERY_TIMEOUT_MS`. */
  readonly timeoutMs?: number
  /** Injection seam for the runtime file reader. */
  readonly endpoint?: EndpointReader
  /** Injection seam for the token reader. */
  readonly token?: TokenReader
  /** Injection seam for the socket. */
  readonly send?: SendRequest
}

/** The plugin's delivery port: a signal in, a promise that never rejects. */
export type HubTransport = (signal: HarnessSignal) => Promise<DeliveryResult>

/** The failure each unsuccessful lookup is reported as, in one table. */
const ENDPOINT_FAILURES: Readonly<Record<Exclude<EndpointLookup['kind'], 'found'>, DeliveryFailureCode>> = {
  'not-running': 'hub-not-running',
  starting: 'hub-starting',
  unreadable: 'runtime-file-unreadable',
}

const TOKEN_FAILURES: Readonly<Record<Exclude<TokenLookup['kind'], 'found'>, DeliveryFailureCode>> = {
  absent: 'token-missing',
  unreadable: 'token-unreadable',
}

/**
 * Build the transport.
 *
 * Returns the plugin's `DeliverPort` with a stronger promise: it never rejects, and it
 * resolves with what happened. Nothing in the returned function can throw - the body
 * below is `async`, so even a synchronous fault inside it becomes a resolved result -
 * and there is no retry, no queue and no timer that outlives one attempt.
 *
 * The state directory is resolved once, here, and the endpoint and the token are read
 * per delivery rather than cached. That is deliberate in both directions: a harness
 * session outlives several hub restarts, and a cached port would keep dialling a port
 * that is gone while a live one is published (APX-CON-03), while resolving the
 * directory per event would mean reading an environment variable on every harness
 * event for no benefit.
 */
export function createHubTransport(options: HubTransportOptions): HubTransport {
  const log = options.log
  const stateDir = options.stateDir ?? resolveStateDir()
  const timeoutMs = options.timeoutMs ?? DELIVERY_TIMEOUT_MS
  const findEndpoint = options.endpoint ?? readEndpointFromRuntimeFile
  const readToken = options.token ?? readTokenFromInstall
  const send = options.send ?? sendHttpRequest

  return async (signal: HarnessSignal): Promise<DeliveryResult> => {
    try {
      const located = findEndpoint(stateDir)
      if (located.kind !== 'found') return failed(log, signal, ENDPOINT_FAILURES[located.kind])
      const { endpoint } = located
      // A host read out of a file is a claim until it is checked, and the check is the
      // hub's own loopback predicate: this process must never put a session id on a
      // socket that leaves the machine (APX-CON-12).
      if (!isLoopbackAddress(endpoint.host)) return failed(log, signal, 'endpoint-not-loopback')

      const token = readToken(endpoint.stateDir)
      if (token.kind !== 'found') return failed(log, signal, TOKEN_FAILURES[token.kind])

      const body = JSON.stringify(toIngestBody(signal))
      const answer = await send({
        host: endpoint.host,
        port: endpoint.port,
        path: INGEST_PATH,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body, 'utf8')),
          // The install's capability, presented in the header the hub publishes. Sent
          // even though ingest does not require it today, so this client keeps working
          // if that changes (ADR-002).
          [WRITE_TOKEN_HEADER]: token.token,
        },
        body,
        timeoutMs,
      })
      return readAnswer(log, signal, answer)
    } catch (cause) {
      // An injected seam that throws, or a fault nobody anticipated inside this
      // function. Either way the session continues and a breadcrumb names the fault,
      // which is the outcome both halves of APX-CON-03 and OA-FR-04 require.
      return failed(log, signal, 'request-failed', describe(cause))
    }
  }
}

/**
 * Report a failure as a breadcrumb and resolve with it, never rejecting.
 *
 * Every unsuccessful path in this module goes through here, so there is exactly one
 * place where a failure becomes visible and one place where the code a caller counts
 * is decided (OA-FR-05, APX-FR-02).
 */
function failed(
  log: HarnessLog,
  signal: HarnessSignal,
  code: DeliveryFailureCode,
  extra: Omit<DeliveryFailure, 'code'> = {},
): DeliveryResult {
  writeDeliveryBreadcrumb(log, { code, ...extra }, signal)
  return { outcome: 'failed', code }
}

/**
 * Turn the attempt into a result, and breadcrumb anything that is not acceptance.
 *
 * A 202 is acceptance whatever its body says: the status is the route's contract, and
 * an unreadable 202 body is the hub's business rather than a delivery failure. Every
 * other status is a verdict about the signal, and 503 is singled out because it is the
 * one that means the event was not stored and the hub recorded it dropped
 * (APX-FR-02).
 */
function readAnswer(log: HarnessLog, signal: HarnessSignal, answer: SendResult): DeliveryResult {
  if (answer.kind === 'timeout') return failed(log, signal, 'delivery-timeout')
  if (answer.kind === 'failed') {
    return failed(
      log,
      signal,
      answer.errorCode === 'ECONNREFUSED' ? 'connection-refused' : 'request-failed',
      {
        errorName: answer.errorName,
        ...(answer.errorCode === undefined ? {} : { errorCode: answer.errorCode }),
      },
    )
  }
  if (answer.status === 202) {
    const accepted = readAccepted(answer.body)
    return {
      outcome: 'accepted',
      status: answer.status,
      ...(accepted.hubOutcome === undefined ? {} : { hubOutcome: accepted.hubOutcome }),
      ...(accepted.eventId === undefined ? {} : { eventId: accepted.eventId }),
    }
  }
  const hubError = readHubError(answer.body)
  const code: DeliveryFailureCode = answer.status === 503 ? 'hub-dropped' : 'hub-refused'
  writeDeliveryBreadcrumb(
    log,
    {
      code,
      status: answer.status,
      ...(hubError === undefined ? {} : { hubError }),
    },
    signal,
  )
  return {
    outcome: 'refused',
    status: answer.status,
    code,
    ...(hubError === undefined ? {} : { hubError }),
  }
}

/**
 * The hub's own answer to an accepted signal, or nothing.
 *
 * Two closed values, and both are optional: an answer this build cannot read is not a
 * delivery failure, and guessing at it would put a value from another process's body
 * into a result a caller may log.
 */
function readAccepted(body: string): { hubOutcome?: string; eventId?: string | null } {
  const parsed = parseObject(body)
  if (parsed === undefined) return {}
  const outcome = parsed['outcome']
  const eventId = parsed['eventId']
  return {
    ...(typeof outcome === 'string' ? { hubOutcome: outcome } : {}),
    ...(eventId === null || typeof eventId === 'string' ? { eventId } : {}),
  }
}

/**
 * The hub's `error` token from a refusal body, or nothing.
 *
 * Filtered to the shape of a closed token before it is believed. This is the only
 * value in a breadcrumb that comes from a response body, and a body is the one place
 * in this path that some other process wrote; anything that is not a token-shaped
 * string is dropped rather than logged (APX-FR-01).
 */
function readHubError(body: string): string | undefined {
  const parsed = parseObject(body)
  if (parsed === undefined) return undefined
  const error = parsed['error']
  return typeof error === 'string' && CLOSED_TOKEN.test(error) ? error : undefined
}

/** A lower-case hyphenated token, which is what every code in this product looks like. */
const CLOSED_TOKEN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

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

/** A fault's name and errno code, and never its message. */
function describe(cause: unknown): Omit<DeliveryFailure, 'code'> {
  if (!(cause instanceof Error)) return {}
  const code = (cause as NodeJS.ErrnoException).code
  return {
    errorName: cause.name,
    ...(typeof code === 'string' ? { errorCode: code } : {}),
  }
}
