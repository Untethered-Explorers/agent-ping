// The polling fallback: what opencode's own HTTP API says that the event stream did not
// (OA-FR-07, OA-FR-02, OA-FR-03, APX-FR-02, APX-CON-03, APX-CON-09, APX-CON-10,
// APX-CON-12, ADR-004, PRD 5, PRD 16 #4).
//
//   npm test -- tests/plugin/poll-fallback.test.ts
//
// The four acceptance criteria, and where each one is proven:
//
//   1. BACKOFF GROWS BETWEEN FAILURES AND STOPS AT THE CONFIGURED CAP. Driven through the
//      real `createPollFallback` against a server that is not there: the delay the module
//      asks its scheduler for is recorded on every cycle and is asserted to double, to
//      reach the ceiling and to stay there, and after the configured number of consecutive
//      failures the schedule is disarmed, `givenUp` is true, and exactly one
//      `poll-given-up` breadcrumb exists. `start()` afterwards resumes with a fresh
//      budget. The backoff function itself is asserted as a table, and the numbers in the
//      table are read out of the module rather than restated here.
//   2. A STATE ALREADY DELIVERED BY PUSH IS NOT DELIVERED AGAIN BY POLLING. Two proofs, and
//      the second is the one that matters:
//        - through the real `AGENT_PING_PLUGIN` with the real transport as its `deliver`,
//          a real hub started by the real entry point, and the real durable log: a block
//          pushed by a hook and then seen pending by the poller stores exactly one row, and
//          the hub's pending count is one;
//        - at the fallback's own level, with the dedupe key the classifier produced
//          claimed by the push path and then presented by the poller, so the suppression is
//          the ledger's and not a side effect of the recorder having consumed the turn.
//   3. AN UNEXPECTED RESPONSE SHAPE IS REPORTED AS A FAILURE RATHER THAN AN EMPTY RESULT.
//      Every wrong container the SDK's declarations rule out is answered by a real loopback
//      server, and each one must produce a failed cycle, a named breadcrumb and *no*
//      delivery - the second half being the claim, because reading an unknown shape as "no
//      sessions running" would report every running session finished. The genuine empty
//      result `{ "data": {} }` is asserted to be the opposite: an ok cycle and no failure.
//   4. THE FALLBACK NEVER BLOCKS THE HARNESS LOOP IT RUNS IN. `start()` is asserted to
//      return before a single request has been made, a cycle against a server that accepts
//      and never answers is asserted to be abandoned at the configured bound while the test's
//      own event loop keeps turning, every timer the real scheduler makes is asserted to be
//      unref'd, and after `stop()` the server records no further request at all. The three
//      real plugin hooks are driven against the hung server and each resolves promptly.
//
// Around those four, the properties that make them worth anything:
//
//   - THE THREE ROUTES ARE THE SDK's, NOT A GUESS. `POLL_ROUTES` is asserted against the
//     literals in @opencode-ai/sdk 1.18.32's own generated declarations, and the permission
//     listing's `location[directory]=` query is asserted against that package's own
//     `deepObject` serializer. PRD 16 #4 stays open: these are declarations, not a capture,
//     and OA-5's live script is where they are observed for real.
//   - IT GOES THROUGH THE TRANSLATOR. A polled idle transition and a polled block are
//     driven through the real `classify`, and the resulting envelopes are asserted to have
//     the classes, subtypes and dedupe keys the push path's rows declare. The one
//     documented divergence - a signal the gate suppressed is not delivered - is asserted
//     too, so it stays a decision rather than becoming an accident.
//   - NOTHING FROM A RESPONSE BODY TRAVELS. A permission carrying recognisable content in
//     `action`, `resources` and `metadata` is answered, and none of it reaches the signal,
//     the envelope or the harness's log.
//   - A SESSION THIS PLUGIN WAS NEVER TOLD ABOUT IS COUNTED, NOT REPORTED. A session id is
//     not a repository, and inventing one would put a row under a label that is a guess
//     (APX-CON-09, ADR-008).
//   - A WAIT-ROUTE TIMEOUT IS NOT A FAILURE. It is the expected answer while a session
//     works, and a failure there would grow the backoff on every busy turn.
//   - NOTHING LEAVES THE MACHINE. A non-loopback endpoint is refused before the injected
//     socket is called once.
//   - THE CONSOLE IS NOT A LOGGING SURFACE, AND THE CLASSIFIER IS THE ONLY KEY DERIVATION.
//     Asserted in code, read from the source, as the sibling suites do.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startHub, type RunningHub } from '@/main/index'
import { openEventStore, type EventStore } from '@/storage/eventStore'
import type { HarnessSignal, TurnWorkSignal } from '@/domain/classify'
import { deriveDedupeKey } from '@/domain/classify'
import { AGENT_PING_PLUGIN } from '@/plugin/opencode/index'
import {
  createHarnessLog,
  type HarnessLog,
  type OpencodeLogClient,
  type Translator,
} from '@/plugin/opencode/translate'
import { createTranslator } from '@/plugin/opencode/translate'
import {
  DEFAULT_OPENCODE_HOST,
  DEFAULT_OPENCODE_PORT,
  MAX_CONSECUTIVE_POLL_FAILURES,
  MAX_POLL_ENTRIES,
  POLL_BASE_DELAY_MS,
  POLL_MAX_DELAY_MS,
  POLL_NOTICE_MESSAGES,
  POLL_ROUTES,
  createDedupeLedger,
  createPollFallback,
  isLoopbackHost,
  pendingPermissionsPath,
  pollBackoffDelay,
  pollBreadcrumb,
  sendPollRequest,
  waitForIdlePath,
  writePollNotice,
  type DedupeLedger,
  type PollAnswer,
  type PollCycleResult,
  type PollFallback,
  type PollFallbackStats,
  type PollNotice,
  type PollNoticeCode,
  type PollRequest,
  type PollRequestInput,
  type PollTimerHandle,
} from '@/plugin/opencode/poll-fallback'
import { createHubTransport } from '@/plugin/transport/http'
import { removeTree } from '../helpers/remove-tree'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO = '/home/dev/Projects/agent-ping'
const SESSION = 'ses_poll_01'
const OTHER_SESSION = 'ses_poll_02'
const BLOCK = 'per_poll_01'
const CALL = 'call_poll_01'
const OCCURRED_AT = '2026-09-26T12:00:00.000Z'
const EPOCH = Date.parse(OCCURRED_AT)

/** Values that appear nowhere but in a permission's payload, and must travel nowhere. */
const ACTION = 'ACTION-the-poller-must-never-carry-this'
const RESOURCE = 'RESOURCE-the-poller-must-never-carry-this'
const METADATA = 'METADATA-the-poller-must-never-carry-this'

/** The platform's own timer, captured so a spy can observe what the module does to it. */
const originalSetTimeout = globalThis.setTimeout

const SOURCE_ROOT = fileURLToPath(new URL('../../src', import.meta.url))
const POLL_SOURCE = readFileSync(path.join(SOURCE_ROOT, 'plugin/opencode/poll-fallback.ts'), 'utf8')
const INDEX_SOURCE = readFileSync(path.join(SOURCE_ROOT, 'plugin/opencode/index.ts'), 'utf8')

interface LogLine {
  readonly level: string
  readonly service: string
  readonly message: string
  readonly extra?: Record<string, unknown>
}

interface HarnessLogging {
  readonly log: HarnessLog
  readonly client: OpencodeLogClient
  readonly lines: LogLine[]
}

/** The harness's own logging client, with every line kept so a test can read it. */
function harnessLogging(): HarnessLogging {
  const lines: LogLine[] = []
  const client: OpencodeLogClient = {
    app: {
      log: (input) => {
        const body = input.body
        if (body !== undefined) {
          lines.push({
            level: body.level,
            service: body.service,
            message: body.message,
            ...(body.extra === undefined ? {} : { extra: body.extra }),
          })
        }
        return undefined
      },
    },
  }
  return { log: createHarnessLog(client, { directory: REPO }), client, lines }
}

const directories: string[] = []
const servers: FakeOpencode[] = []
const hubs: RunningHub[] = []
let store: EventStore | null = null

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  for (const server of servers.splice(0)) server.close()
  for (const directory of directories.splice(0)) removeTree(directory)
  for (const hub of hubs.splice(0)) await hub.close()
  store?.close()
  store = null
  vi.restoreAllMocks()
})

/** Let every already-resolved promise chain finish, without waiting on a timer. */
async function flush(turns = 12): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

// ---------------------------------------------------------------------------
// A real loopback server, shaped like the routes the SDK declares
// ---------------------------------------------------------------------------

/** What one route should answer, or the fact that it should not answer at all. */
type RouteAnswer = { readonly status: number; readonly body?: string } | 'hang'

/** A handler for one route: it answers, or it accepts and stays silent. */
type RouteHandler = (response: ServerResponse) => void

interface FakeOpencodeSpec {
  /** The active-sessions route. Defaults to "nothing is running". */
  readonly active?: RouteAnswer | (() => RouteAnswer)
  /** The wait route. Defaults to "still running", which is a timeout in this build. */
  readonly wait?: RouteAnswer | (() => RouteAnswer)
  /** The pending-permissions route. Defaults to "nothing is pending". */
  readonly permissions?: RouteAnswer | (() => RouteAnswer)
}

interface FakeOpencode {
  readonly port: number
  readonly requests: string[]
  close(): Promise<void>
}

const ACTIVE_PATH = '/api/session/active'
const PERMISSIONS_PATH = '/api/permission/request'
const WAIT_PREFIX = '/api/session/'

/**
 * A real opencode-shaped HTTP server on a real loopback port.
 *
 * `hang` accepts the request and never answers, which is the only honest way to test that
 * a bound abandons a request rather than a mock returning a symbol. The port is ephemeral,
 * so a fallback that dialled a default would fail these tests rather than pass them.
 */
async function serveOpencode(spec: FakeOpencodeSpec = {}): Promise<FakeOpencode> {
  const requests: string[] = []
  const open: ServerResponse[] = []
  const answerFor = (
    configured: RouteAnswer | (() => RouteAnswer) | undefined,
    fallback: RouteAnswer,
  ): RouteHandler => {
    const value =
      configured === undefined ? fallback : typeof configured === 'function' ? configured() : configured
    if (value === 'hang') return (response) => void open.push(response)
    const status = value.status
    const body = value.body ?? ''
    return (response) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(body)
    }
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? ''
    requests.push(`${request.method ?? 'GET'} ${url}`)
    const answer = url.startsWith(ACTIVE_PATH)
      ? answerFor(spec.active, { status: 200, body: JSON.stringify({ data: {} }) })
      : url.startsWith(WAIT_PREFIX)
        ? answerFor(spec.wait, 'hang')
        : answerFor(spec.permissions, { status: 200, body: JSON.stringify({ location: {}, data: [] }) })
    answer(response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const fake: FakeOpencode = {
    port: (server.address() as AddressInfo).port,
    requests,
    close: async () => {
      for (const response of open.splice(0)) response.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  servers.push(fake)
  return fake
}

/** The documented active-sessions body, for the sessions named. */
function activeBody(sessionIds: readonly string[]): string {
  const data: Record<string, { type: string }> = {}
  for (const sessionId of sessionIds) data[sessionId] = { type: 'running' }
  return JSON.stringify({ data })
}

/** The documented pending-permissions body, for the blocks named. */
function permissionsBody(
  blocks: readonly { id: string; sessionID: string; action?: string; resources?: string[] }[],
): string {
  return JSON.stringify({
    location: { directory: REPO, project: { id: 'prj_01', directory: REPO } },
    data: blocks.map((block) => ({
      id: block.id,
      sessionID: block.sessionID,
      action: block.action ?? ACTION,
      resources: block.resources ?? [RESOURCE],
      metadata: { note: METADATA },
    })),
  })
}

// ---------------------------------------------------------------------------
// A manual clock for the schedule
// ---------------------------------------------------------------------------

interface FakeHandle extends PollTimerHandle {
  run: () => void
  readonly delayMs: number
  cancelled: boolean
}

interface ManualSchedule {
  readonly schedule: (run: () => void, delayMs: number) => PollTimerHandle
  readonly cancel: (handle: PollTimerHandle) => void
  /** Every delay the fallback has asked for, oldest first. */
  readonly delays: number[]
  /** Fire every currently armed timer once, and let the resulting cycle finish. */
  fire(): Promise<void>
  readonly armed: number
}

function manualSchedule(): ManualSchedule {
  const handles: FakeHandle[] = []
  const delays: number[] = []
  return {
    schedule: (run, delayMs) => {
      const handle: FakeHandle = { run, delayMs, cancelled: false, unref: () => undefined }
      handles.push(handle)
      delays.push(delayMs)
      return handle
    },
    cancel: (handle) => {
      const found = handles.find((candidate) => candidate === handle)
      if (found !== undefined) found.cancelled = true
    },
    delays,
    fire: async () => {
      const due = handles.splice(0).filter((handle) => !handle.cancelled)
      for (const handle of due) handle.run()
      await flush()
    },
    get armed(): number {
      return handles.filter((handle) => !handle.cancelled).length
    },
  }
}

/**
 * The three routes answering normally: nothing running, a wait that times out because a
 * session is still working, and nothing pending.
 *
 * The wait timeout is the ordinary answer on a busy machine, which is why it is the
 * default here rather than a 204: a test that does not care about the wait should be
 * exercising the path a real busy session exercises.
 */
const QUIET_ANSWERS: Readonly<Record<string, PollAnswer>> = {
  active: { kind: 'answered', status: 200, body: JSON.stringify({ data: {} }) },
  wait: { kind: 'timeout' },
  permissions: { kind: 'answered', status: 200, body: JSON.stringify({ location: {}, data: [] }) },
}

/** The quiet table, as `HarnessOptions` sees it. */
const QUIET: Pick<HarnessOptions, 'requests'> = { requests: { ...QUIET_ANSWERS } }

/** A socket seam that answers from a table and records what it was asked. */
function scriptedRequest(table: Readonly<Record<string, PollAnswer>>): {
  readonly request: PollRequest
  readonly calls: PollRequestInput[]
} {
  const calls: PollRequestInput[] = []
  return {
    calls,
    request: async (input) => {
      calls.push(input)
      const route = routeOf(input.path)
      const answer = table[route]
      if (answer === undefined) throw new Error(`no scripted answer for ${route}`)
      return answer
    },
  }
}

function routeOf(requestPath: string): string {
  if (requestPath.startsWith(ACTIVE_PATH)) return 'active'
  if (requestPath.startsWith(PERMISSIONS_PATH)) return 'permissions'
  if (requestPath.startsWith(WAIT_PREFIX)) return 'wait'
  return requestPath
}

// ---------------------------------------------------------------------------
// A fallback, wired the way the entry point wires it
// ---------------------------------------------------------------------------

interface Harness {
  readonly fallback: PollFallback
  readonly delivered: HarnessSignal[]
  readonly lines: LogLine[]
  readonly ledger: DedupeLedger
  readonly translator: Translator
  readonly schedule: ManualSchedule
  readonly calls: PollRequestInput[]
  readonly requests: Record<string, PollAnswer>
  stats(): PollFallbackStats
}

interface HarnessOptions {
  readonly requests?: Record<string, PollAnswer>
  readonly withDelivery?: boolean
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  readonly maxConsecutiveFailures?: number
  readonly requestTimeoutMs?: number
  readonly waitTimeoutMs?: number
  readonly endpoint?: { host: string; port: number }
  readonly directory?: string
}

function harnessOver(options: HarnessOptions = {}): Harness {
  const { log, lines } = harnessLogging()
  const delivered: HarnessSignal[] = []
  const ledger = createDedupeLedger()
  const translator = createTranslator({ directory: options.directory ?? REPO, now: () => EPOCH })
  // A scripted table when the test names one, and the real socket otherwise. The
  // default is the real one on purpose: a fallback pointed at a real loopback server
  // must reach it, and a test that quietly answered from a table would pass while
  // proving nothing about the path under test.
  //
  // The table is copied, so a test that changes one route's answer changes only its own
  // harness: a shared table would let one test's mutation answer the next test's route.
  const calls: PollRequestInput[] = []
  const table: Record<string, PollAnswer> = { ...(options.requests ?? {}) }
  const inner: PollRequest = options.requests === undefined ? sendPollRequest : scriptedRequest(table).request
  const request: PollRequest = async (input) => {
    calls.push(input)
    return inner(input)
  }
  const schedule = manualSchedule()
  const fallback = createPollFallback({
    log,
    translator,
    directory: options.directory ?? REPO,
    ledger,
    ...(options.withDelivery === false
      ? {}
      : { deliver: (signal: HarnessSignal) => void delivered.push(signal) }),
    endpoint: options.endpoint ?? { host: DEFAULT_OPENCODE_HOST, port: DEFAULT_OPENCODE_PORT },
    request,
    schedule: schedule.schedule,
    cancel: schedule.cancel,
    ...(options.baseDelayMs === undefined ? {} : { baseDelayMs: options.baseDelayMs }),
    ...(options.maxDelayMs === undefined ? {} : { maxDelayMs: options.maxDelayMs }),
    ...(options.maxConsecutiveFailures === undefined
      ? {}
      : { maxConsecutiveFailures: options.maxConsecutiveFailures }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.waitTimeoutMs === undefined ? {} : { waitTimeoutMs: options.waitTimeoutMs }),
  })
  return {
    fallback,
    delivered,
    lines,
    ledger,
    translator,
    schedule,
    calls,
    requests: table,
    stats: () => fallback.stats,
  }
}

const NO_WORK: TurnWorkSignal = { toolCall: false, fileEdit: false, todoUpdate: false }
const WORK: TurnWorkSignal = { toolCall: true, fileEdit: false, todoUpdate: false }

/** Every breadcrumb code written to a log, in order. */
function codesIn(lines: readonly LogLine[]): PollNoticeCode[] {
  return lines.flatMap((line) => {
    const code = line.extra?.['code']
    return typeof code === 'string' ? [code as PollNoticeCode] : []
  })
}

/** Every signal delivered, as `eventName:sessionId:transitionId`, which is readable. */
function deliveredKeys(signals: readonly HarnessSignal[]): string[] {
  return signals.map((signal) => `${signal.eventName}:${signal.sessionId}:${signal.transitionId ?? '-'}`)
}

// ---------------------------------------------------------------------------
// 0. The routes are the SDK's, and the module's own discipline
// ---------------------------------------------------------------------------

describe('the fallback speaks to the three routes the SDK declares (OA-FR-07, PRD 5)', () => {
  it('names the active-session, wait-until-idle and permission-listing routes verbatim', () => {
    // The literals below are the `url` fields of V2SessionActiveData, V2SessionWaitData and
    // V2PermissionRequestListData in @opencode-ai/sdk 1.18.32
    // (dist/v2/gen/types.gen.d.ts). They are the evidence, and this is the assertion that
    // the module's copy of them cannot drift without a failure.
    expect(POLL_ROUTES.activeSessions).toBe('/api/session/active')
    expect(POLL_ROUTES.waitForIdle).toBe('/api/session/{sessionID}/wait')
    expect(POLL_ROUTES.pendingPermissions).toBe('/api/permission/request')
    expect(Object.keys(POLL_ROUTES)).toHaveLength(3)
  })

  it('encodes the wait route with a percent-encoded path parameter and refuses a multi-line id', () => {
    expect(waitForIdlePath('ses with space/and slash')).toBe('/api/session/ses%20with%20space%2Fand%20slash/wait')
    expect(() => waitForIdlePath('ses\nrm -rf /')).toThrow(/single-line token/)
    expect(() => waitForIdlePath('')).toThrow(/single-line token/)
  })

  it('serializes the permission listing the way the SDK deepObject serializer does', () => {
    // `createQuerySerializer` with `{ object: { explode: true, style: "deepObject" } }` and
    // `serializeObjectParam` produce `name[key]=<encodeURIComponent(value)>`: the brackets
    // belong to the parameter name and the value is percent-encoded.
    expect(pendingPermissionsPath('/home/dev/Projects/agent-ping')).toBe(
      '/api/permission/request?location[directory]=%2Fhome%2Fdev%2FProjects%2Fagent-ping',
    )
    expect(pendingPermissionsPath('/with space/and?and=more')).toBe(
      '/api/permission/request?location[directory]=%2Fwith%20space%2Fand%3Fand%3Dmore',
    )
  })

  it('defaults to the address the SDK\'s own server launcher defaults to, and says so', () => {
    // `createOpencodeServer` in @opencode-ai/sdk 1.18.32 dist/server.js: hostname
    // "127.0.0.1", port 4096, then the live URL is read out of the server's stdout. There
    // is no runtime file and no environment variable naming the port, which is why the
    // address is a default plus an override rather than a lookup.
    expect(DEFAULT_OPENCODE_HOST).toBe('127.0.0.1')
    expect(DEFAULT_OPENCODE_PORT).toBe(4096)
    const h = harnessOver()
    expect(h.fallback.endpoint).toEqual({ host: '127.0.0.1', port: 4096 })
  })

  it('has a sentence for every notice code, and no notice code without one', () => {
    const codes = Object.keys(POLL_NOTICE_MESSAGES)
    expect(codes.length).toBeGreaterThanOrEqual(8)
    for (const code of codes) {
      const message = POLL_NOTICE_MESSAGES[code as PollNoticeCode]
      expect(typeof message).toBe('string')
      expect(message.length).toBeGreaterThan(40)
      expect(message).toContain('agent-ping')
      // A breadcrumb travels through the harness's log and onto a screen, so no sentence
      // may quote a value (APX-FR-01, APX-CON-12).
      expect(message).not.toContain(REPO)
    }
  })

  it('writes no breadcrumb through anything but the harness logging client', () => {
    expect(POLL_SOURCE).not.toMatch(/\bconsole\./)
    expect(POLL_SOURCE).not.toMatch(/process\.stdout|process\.stderr/)
    // The classifier is the only derivation of a dedupe key in this product (EL-FR-06);
    // a second one here would be a duplicate-event bug waiting for a polled session.
    expect(POLL_SOURCE).not.toContain('deriveDedupeKey')
    expect(POLL_SOURCE).not.toMatch(/`\$\{[a-zA-Z]*harness[a-zA-Z]*\}:`/)
  })

  it('bounds a ledger and forgets the oldest key rather than growing without limit', () => {
    const ledger = createDedupeLedger(3)
    for (const key of ['a', 'b', 'c', 'd']) ledger.record(key)
    expect(ledger.size).toBe(3)
    expect(ledger.has('a')).toBe(false)
    expect(ledger.has('d')).toBe(true)
    ledger.forget('d')
    expect(ledger.size).toBe(2)
    ledger.clear()
    expect(ledger.size).toBe(0)
  })

  it('refuses a key that is not a single-line token, and claims each key exactly once', () => {
    const ledger = createDedupeLedger()
    expect(ledger.claim('opencode:ses:x')).toBe(true)
    expect(ledger.claim('opencode:ses:x')).toBe(false)
    expect(ledger.claim('opencode:ses:\nInjected')).toBe(false)
    expect(ledger.record('opencode:ses:\nInjected')).toBeUndefined()
    expect(ledger.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 1. Backoff grows between failures and stops at the configured cap
// ---------------------------------------------------------------------------

describe('the backoff grows and stops at the cap (OA-FR-07)', () => {
  it('doubles per consecutive failure, reaches the ceiling and stays there', () => {
    // The rule as a table, read off the module's own exported function rather than
    // restated: base 5s, ceiling 30s.
    expect(pollBackoffDelay(0, POLL_BASE_DELAY_MS, POLL_MAX_DELAY_MS)).toBe(5_000)
    expect(pollBackoffDelay(1, POLL_BASE_DELAY_MS, POLL_MAX_DELAY_MS)).toBe(5_000)
    expect(pollBackoffDelay(2, POLL_BASE_DELAY_MS, POLL_MAX_DELAY_MS)).toBe(10_000)
    expect(pollBackoffDelay(3, POLL_BASE_DELAY_MS, POLL_MAX_DELAY_MS)).toBe(20_000)
    expect(pollBackoffDelay(4, POLL_BASE_DELAY_MS, POLL_MAX_DELAY_MS)).toBe(30_000)
    // Past the ceiling, and past a shift that would overflow: the cap is the real ceiling.
    expect(pollBackoffDelay(9, POLL_BASE_DELAY_MS, POLL_MAX_DELAY_MS)).toBe(30_000)
    expect(pollBackoffDelay(400, POLL_BASE_DELAY_MS, POLL_MAX_DELAY_MS)).toBe(30_000)
    // A ceiling below the base is raised to the base rather than producing a shorter
    // delay than a healthy cycle.
    expect(pollBackoffDelay(3, 5_000, 1_000)).toBe(5_000)
  })

  it('grows the delay it asks its scheduler for on every real failure', async () => {
    const h = harnessOver({
      requests: {
        active: { kind: 'failed', errorName: 'Error', errorCode: 'ECONNREFUSED' },
        wait: { kind: 'timeout' },
        permissions: { kind: 'timeout' },
      },
      baseDelayMs: 1_000,
      maxDelayMs: 8_000,
      maxConsecutiveFailures: 99,
    })
    h.fallback.start()
    await flush()
    expect(h.schedule.delays).toEqual([1_000])

    // Each fire runs a real cycle through the real failure path and re-arms, so the
    // delays below are the ones the module asked its scheduler for rather than a value
    // this test computed.
    for (let index = 0; index < 5; index += 1) {
      await h.schedule.fire()
    }
    expect(h.stats().failures).toBe(5)
    expect(h.stats().givenUp).toBe(false)
    // Every failure doubled the delay, and the ceiling held once it was reached.
    expect(h.schedule.delays).toEqual([1_000, 1_000, 2_000, 4_000, 8_000, 8_000])
    expect(h.stats().nextDelayMs).toBe(8_000)
    // One request per cycle: the failure is not retried inside the attempt.
    expect(h.calls).toHaveLength(5)
  })

  it('resets to the base delay after one good cycle, and reports the streak as zero', async () => {
    const h = harnessOver({ ...QUIET, baseDelayMs: 1_000, maxDelayMs: 8_000, maxConsecutiveFailures: 99 })
    h.requests['active'] = { kind: 'failed', errorName: 'Error', errorCode: 'ECONNREFUSED' }
    await h.fallback.cycle()
    await h.fallback.cycle()
    expect(h.stats().nextDelayMs).toBe(2_000)
    h.requests['active'] = { kind: 'answered', status: 200, body: JSON.stringify({ data: {} }) }
    const ok = await h.fallback.cycle()
    expect(ok.outcome).toBe('ok')
    expect(h.stats().nextDelayMs).toBe(1_000)
    expect(h.stats().consecutiveFailures).toBe(0)
    expect(h.stats().cycles).toBe(1)
  })

  it('stops after the configured number of consecutive failures, disarms, and says so once', async () => {
    const maxFailures = 4
    const h = harnessOver({
      requests: {
        active: { kind: 'failed', errorName: 'Error', errorCode: 'ECONNREFUSED' },
        wait: { kind: 'timeout' },
        permissions: { kind: 'timeout' },
      },
      baseDelayMs: 100,
      maxDelayMs: 400,
      maxConsecutiveFailures: maxFailures,
    })
    h.fallback.start()
    await flush()

    const results: PollCycleResult[] = []
    for (let index = 0; index < maxFailures - 1; index += 1) {
      results.push(await h.fallback.cycle())
    }
    expect(results.every((result) => result.outcome === 'failed')).toBe(true)
    expect(h.stats().givenUp).toBe(false)
    // The cap is a hard stop, not a longer wait: the schedule is disarmed and no further
    // timer is armed, so a stopped opencode server is not dialled for the life of the
    // session.
    const final = await h.fallback.cycle()
    expect(final).toMatchObject({ outcome: 'failed', code: 'harness-unreachable', gaveUp: true })
    expect(h.stats().givenUp).toBe(true)
    expect(h.schedule.armed).toBe(0)
    expect(codesIn(h.lines)).toContain('poll-given-up')
    // One line for the stop, and one per earlier failure: no throttling and no duplicate.
    expect(codesIn(h.lines).filter((code) => code === 'poll-given-up')).toHaveLength(1)
    // And no further request is made at all, not even when a cycle is asked for.
    const before = h.calls.length
    expect(await h.fallback.cycle()).toEqual({ outcome: 'skipped', reason: 'given-up' })
    expect(h.calls.length).toBe(before)
  })

  it('the default cap is the documented one, and a default fallback gives up on a dead port', async () => {
    // Nothing is listening on this port, so every request fails and the real socket is
    // used: the bound, the backoff and the cap are all the production paths.
    const closed = await serveOpencode()
    const deadPort = closed.port
    await closed.close()
    const { log, lines } = harnessLogging()
    const ledger = createDedupeLedger()
    const schedule = manualSchedule()
    const fallback = createPollFallback({
      log,
      translator: createTranslator({ directory: REPO, now: () => EPOCH }),
      directory: REPO,
      ledger,
      deliver: () => undefined,
      endpoint: { host: '127.0.0.1', port: deadPort },
      baseDelayMs: 1,
      maxDelayMs: 2,
    })
    fallback.start()
    for (let index = 0; index < MAX_CONSECUTIVE_POLL_FAILURES; index += 1) {
      await fallback.cycle()
    }
    expect(fallback.stats.givenUp).toBe(true)
    expect(fallback.stats.failures).toBe(MAX_CONSECUTIVE_POLL_FAILURES)
    expect(codesIn(lines)).toContain('poll-given-up')
    expect(codesIn(lines).filter((code) => code === 'poll-given-up')).toHaveLength(1)
    void schedule
  })

  it('start() after the cap resumes with a fresh budget and a fresh schedule', async () => {
    const h = harnessOver({
      requests: {
        active: { kind: 'failed', errorName: 'Error', errorCode: 'ECONNREFUSED' },
        wait: { kind: 'timeout' },
        permissions: { kind: 'timeout' },
      },
      baseDelayMs: 50,
      maxDelayMs: 50,
      maxConsecutiveFailures: 1,
    })
    await h.fallback.cycle()
    expect(h.stats().givenUp).toBe(true)
    h.requests['active'] = { kind: 'answered', status: 200, body: JSON.stringify({ data: {} }) }
    h.requests['permissions'] = { kind: 'answered', status: 200, body: JSON.stringify({ location: {}, data: [] }) }
    h.fallback.start()
    await flush()
    expect(h.stats().givenUp).toBe(false)
    expect(h.stats().consecutiveFailures).toBe(0)
    expect(h.schedule.armed).toBe(1)
    expect(await h.fallback.cycle()).toMatchObject({ outcome: 'ok' })
  })
})

// ---------------------------------------------------------------------------
// 2. A state already delivered by push is not delivered again by polling
// ---------------------------------------------------------------------------

describe('a state already delivered by push is not delivered again by polling (OA-FR-07, EL-FR-06)', () => {
  it('suppresses a block whose dedupe key the push path already took', async () => {
    const h = harnessOver({ ...QUIET })
    h.fallback.noteSession(SESSION)

    // The push path's own key, taken from the classifier through the real translator. This
    // is what `publish` records in src/plugin/opencode/index.ts.
    const pushed = h.translator.observe({
      type: 'permission.updated',
      properties: { id: BLOCK, sessionID: SESSION },
    })
    expect(pushed?.classification.outcome).toBe('event')
    const key =
      pushed?.classification.outcome === 'event' ? pushed.classification.event.dedupeKey : ''
    expect(key).toBe(deriveDedupeKey('opencode', SESSION, BLOCK))
    h.ledger.record(key)

    // Now the poller finds the same block pending. Nothing is delivered, and the
    // suppression is counted rather than hidden.
    h.requests['permissions'] = { kind: 'answered', status: 200, body: permissionsBody([{ id: BLOCK, sessionID: SESSION }]) }
    expect(await h.fallback.cycle()).toMatchObject({ outcome: 'ok' })
    expect(h.delivered).toHaveLength(0)
    expect(h.stats().reported).toBe(0)
    expect(h.stats().suppressed).toBe(1)

    // And it stays suppressed on every later cycle, because the key is still taken.
    await h.fallback.cycle()
    await h.fallback.cycle()
    expect(h.stats().suppressed).toBe(3)
    expect(h.delivered).toHaveLength(0)
  })

  it('reports a block once and suppresses every later sighting of the same block', async () => {
    const h = harnessOver({ ...QUIET })
    h.fallback.noteSession(SESSION)
    h.requests['permissions'] = { kind: 'answered', status: 200, body: permissionsBody([{ id: BLOCK, sessionID: SESSION }]) }
    for (let index = 0; index < 3; index += 1) await h.fallback.cycle()
    expect(h.delivered).toHaveLength(1)
    expect(h.stats().reported).toBe(1)
    expect(h.stats().suppressed).toBe(2)
    const [signal] = h.delivered
    expect(signal?.eventName).toBe('permission.asked')
    expect(signal?.transitionId).toBe(BLOCK)
    expect(signal?.sessionId).toBe(SESSION)
    expect(signal?.repoFullPath).toBe(REPO)
  })

  it('the real plugin and the real poller store one row for a block that both of them saw', async () => {
    const stateDir = temporaryDirectory('agent-ping-poll-state-')
    const hub = await startHub({
      stateDir,
      dashboardRoot: null,
      // Port 0: the live port is provably not the default, so a transport that dialled it
      // could not pass this test.
      preferredPort: 0,
      delivery: { notifier: () => undefined },
    })
    hubs.push(hub)
    const opencode = await serveOpencode({
      // The block the plugin is about to push is also, from the poller's point of view,
      // still pending. Both paths see the same state.
      permissions: { status: 200, body: permissionsBody([{ id: BLOCK, sessionID: SESSION }]) },
    })
    const { log, lines } = harnessLogging()
    const deliver = createHubTransport({ log, stateDir })

    const hooks = await AGENT_PING_PLUGIN(
      { client: harnessLogging().client, directory: REPO },
      {
        deliver,
        poll: {
          endpoint: { host: '127.0.0.1', port: opencode.port },
          baseDelayMs: 5,
          maxDelayMs: 10,
          requestTimeoutMs: 200,
          waitTimeoutMs: 200,
        },
      },
    )

    // A turn with real work, then the block, pushed through the real hooks.
    await hooks['tool.execute.before']?.({ tool: 'bash', sessionID: SESSION, callID: CALL })
    await hooks.event?.({
      event: { type: 'permission.updated', properties: { id: BLOCK, sessionID: SESSION } },
    })

    // Let the poller run several cycles against the same pending block.
    await new Promise((resolve) => setTimeout(resolve, 150))

    const events = openEventStore({ filePath: hub.databaseFilePath })
    store = events
    const rows = events.readEventHistory({ limit: 50, sessionId: SESSION })
    const needsYou = rows.filter((row) => row.class === 'needs-you')
    expect(needsYou).toHaveLength(1)
    expect(needsYou[0]?.dedupeKey).toBe(deriveDedupeKey('opencode', SESSION, BLOCK))
    expect(needsYou[0]?.rawEventType).toBe('permission.asked')
    // And the hub's own pending count is one, so the badge is one too.
    const pending = events.readPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.repoShortName).toBe('agent-ping')
    expect(pending[0]?.repoFullPath).toBe(REPO)
    // The poller really ran: it asked the real server, and the only breadcrumb about it is
    // the ordinary "still working" quiet - no failure and no duplicate.
    expect(opencode.requests.filter((entry) => entry.includes(PERMISSIONS_PATH)).length).toBeGreaterThan(1)
    expect(codesIn(lines).filter((code) => code !== 'session-not-ours')).toEqual([])
  })

  it('the entry point records a pushed key in the ledger the fallback claims from', async () => {
    // A counting port rather than the hub, deliberately: the hub's unique index would
    // collapse a duplicate key anyway, so a real store cannot tell "the poller did not
    // deliver" from "the poller delivered and the hub deduplicated". What this proves is
    // the ledger itself, in the plugin's own wiring.
    const pushed = await serveOpencode({
      permissions: { status: 200, body: permissionsBody([{ id: BLOCK, sessionID: SESSION }]) },
    })
    const seen: HarnessSignal[] = []
    const { client } = harnessLogging()
    const hooks = await AGENT_PING_PLUGIN(
      { client, directory: REPO },
      {
        deliver: (signal: HarnessSignal) => void seen.push(signal),
        poll: { endpoint: { host: '127.0.0.1', port: pushed.port }, baseDelayMs: 5, maxDelayMs: 10 },
      },
    )
    await hooks.event?.({
      event: { type: 'permission.updated', properties: { id: BLOCK, sessionID: SESSION } },
    })
    expect(seen).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 150))
    // The poller really ran, several times, against a block that was still pending...
    expect(pushed.requests.filter((entry) => entry.includes(PERMISSIONS_PATH)).length).toBeGreaterThan(1)
    // ...and it delivered nothing, because the push path had already taken that key.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.transitionId).toBe(BLOCK)
  })

  it('the poller does deliver a block the push path never delivered, so the suppression above is the ledger', async () => {
    const server = await serveOpencode({
      permissions: { status: 200, body: permissionsBody([{ id: 'per_unpushed', sessionID: SESSION }]) },
    })
    const seen: HarnessSignal[] = []
    const { client } = harnessLogging()
    const hooks = await AGENT_PING_PLUGIN(
      { client, directory: REPO },
      {
        deliver: (signal: HarnessSignal) => void seen.push(signal),
        poll: { endpoint: { host: '127.0.0.1', port: server.port }, baseDelayMs: 5, maxDelayMs: 10 },
      },
    )
    // Only a tool boundary, which produces no signal at all and posts nothing.
    await hooks['tool.execute.before']?.({ tool: 'bash', sessionID: SESSION, callID: CALL })
    await new Promise((resolve) => setTimeout(resolve, 150))
    // The poller found a block the event stream never delivered and reported it. The
    // session was named to the fallback by the tool boundary, which is the only thing that
    // makes it attributable to this repository (APX-CON-09).
    expect(server.requests.filter((entry) => entry.includes(PERMISSIONS_PATH)).length).toBeGreaterThan(1)
    expect(seen.map((signal) => signal.transitionId)).toEqual(['per_unpushed'])
    expect(seen[0]?.eventName).toBe('permission.asked')
    expect(seen[0]?.repoFullPath).toBe(REPO)
  })

  it('the push path recording its key is what suppresses the poll, and removing it does not', async () => {
    // The same scenario with the ledger deliberately not shared, which is what a second
    // derivation of the dedupe state would look like: the block is delivered twice.
    const pushedLedger = createDedupeLedger()
    const pushedTranslator = createTranslator({ directory: REPO, now: () => EPOCH })
    const pushed = pushedTranslator.observe({
      type: 'permission.updated',
      properties: { id: BLOCK, sessionID: SESSION },
    })
    if (pushed?.classification.outcome === 'event') pushedLedger.record(pushed.classification.event.dedupeKey)

    const separate = createDedupeLedger()
    const { log } = harnessLogging()
    const delivered: HarnessSignal[] = []
    const translator = createTranslator({ directory: REPO, now: () => EPOCH })
    const fallback = createPollFallback({
      log,
      translator,
      directory: REPO,
      // Deliberately NOT the push path's ledger.
      ledger: separate,
      deliver: (signal) => void delivered.push(signal),
      request: async (input) =>
        routeOf(input.path) === 'permissions'
          ? { kind: 'answered', status: 200, body: permissionsBody([{ id: BLOCK, sessionID: SESSION }]) }
          : { kind: 'answered', status: 200, body: JSON.stringify({ data: {} }) },
    })
    fallback.noteSession(SESSION)
    await fallback.cycle()
    expect(delivered).toHaveLength(1)
    expect(pushedLedger.has(deriveDedupeKey('opencode', SESSION, BLOCK))).toBe(true)
    expect(separate.has(deriveDedupeKey('opencode', SESSION, BLOCK))).toBe(true)
  })

  it('a polled idle transition and a pushed one of the same turn produce one signal', async () => {
    const h = harnessOver({ ...QUIET })
    h.fallback.noteSession(SESSION)
    // The turn's work, seen by the hooks exactly as opencode delivers it.
    h.translator.observe({ type: 'tool.execute.before', properties: { sessionID: SESSION, callID: CALL } })
    // The tool call is what opened turn 1 and recorded its work, so the polled idle
    // transition that follows is keyed `idle:1` - the identity the push path would have
    // used for the same turn, taken from the recorder rather than minted here.
    // The poller finds the session running, then finds it stopped: one idle edge.
    h.requests['active'] = { kind: 'answered', status: 200, body: activeBody([SESSION]) }
    await h.fallback.cycle()
    h.requests['active'] = { kind: 'answered', status: 200, body: JSON.stringify({ data: {} }) }
    expect(await h.fallback.cycle()).toMatchObject({ outcome: 'ok' })
    expect(deliveredKeys(h.delivered)).toEqual([`session.status:${SESSION}:idle:1`])
    const finished = h.delivered[0]
    expect(finished?.turnWork).toEqual(WORK)

    // The push path then delivers the same transition. The recorder has already reported
    // the turn, so the second form is inert on its own - and the key is in the ledger
    // besides. Either way there is one signal, not two.
    const pushed = h.translator.observe({
      type: 'session.status',
      properties: { sessionID: SESSION, status: { type: 'idle' } },
    })
    if (pushed?.classification.outcome === 'event') h.ledger.record(pushed.classification.event.dedupeKey)
    expect(pushed?.classification).toMatchObject({ outcome: 'no-event', reason: 'idle-after-nothing' })
    expect(h.delivered).toHaveLength(1)
  })

  it('a greeting turn produces nothing from either path, and a second empty turn is not credited', async () => {
    const h = harnessOver({ ...QUIET })
    h.fallback.noteSession(SESSION)
    h.requests['active'] = { kind: 'answered', status: 200, body: activeBody([SESSION]) }
    await h.fallback.cycle()
    h.requests['active'] = { kind: 'answered', status: 200, body: JSON.stringify({ data: {} }) }
    await h.fallback.cycle()
    expect(h.delivered).toHaveLength(0)
    expect(h.stats().reported).toBe(0)

    // A turn that works, and then a turn that does not: the second must stay quiet even
    // though the recorder has seen work before.
    // The greeting turn was turn 1 and consumed its identity, so the working turn is turn
    // 2 - which is exactly why the reset exists: the work belongs to this turn, not to the
    // greeting's.
    h.translator.recorder.beginTurn(SESSION)
    h.translator.observe({ type: 'tool.execute.before', properties: { sessionID: SESSION, callID: 'call_02' } })
    h.requests['active'] = { kind: 'answered', status: 200, body: activeBody([SESSION]) }
    await h.fallback.cycle()
    h.requests['active'] = { kind: 'answered', status: 200, body: JSON.stringify({ data: {} }) }
    await h.fallback.cycle()
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]?.transitionId).toBe('idle:2')

    h.translator.recorder.beginTurn(SESSION)
    h.requests['active'] = { kind: 'answered', status: 200, body: activeBody([SESSION]) }
    await h.fallback.cycle()
    h.requests['active'] = { kind: 'answered', status: 200, body: JSON.stringify({ data: {} }) }
    await h.fallback.cycle()
    expect(h.delivered).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 3. An unexpected response shape is a reported failure, not an empty result
// ---------------------------------------------------------------------------

describe('an unexpected response shape is reported as a failure (OA-FR-07, PRD 16 #4)', () => {
  const wrongActiveAnswers: readonly { readonly name: string; readonly body: string }[] = [
    { name: 'a renamed container', body: JSON.stringify({ sessions: [] }) },
    { name: 'a bare array', body: JSON.stringify([{ id: SESSION, type: 'running' }]) },
    { name: 'a null body', body: 'null' },
    { name: 'no data key', body: JSON.stringify({}) },
    { name: 'data as an array', body: JSON.stringify({ data: [{ id: SESSION }] }) },
    { name: 'data as a string', body: JSON.stringify({ data: 'running' }) },
    { name: 'a value that is not an object', body: JSON.stringify({ data: { [SESSION]: 'running' } }) },
    { name: 'a value with no type', body: JSON.stringify({ data: { [SESSION]: {} } }) },
    { name: 'a value whose type is not a string', body: JSON.stringify({ data: { [SESSION]: { type: 7 } } }) },
    { name: 'an empty session key', body: JSON.stringify({ data: { '': { type: 'running' } } }) },
    { name: 'text that is not JSON at all', body: 'running: ses_poll_01' },
    { name: 'an empty body', body: '' },
  ]

  for (const { name, body } of wrongActiveAnswers) {
    it(`reports a failure for ${name} rather than reading it as no active sessions`, async () => {
      const server = await serveOpencode({
        active: { status: 200, body },
        // A running session on the wait route, so a "no sessions running" reading would
        // have produced a finished event here and the assertion below would catch it.
        wait: { status: 204 },
        permissions: { status: 200, body: permissionsBody([{ id: BLOCK, sessionID: SESSION }]) },
      })
      const h = harnessOver({ endpoint: { host: '127.0.0.1', port: server.port }, waitTimeoutMs: 20 })
      h.fallback.noteSession(SESSION)
      h.translator.observe({ type: 'tool.execute.before', properties: { sessionID: SESSION, callID: CALL } })

      const result = await h.fallback.cycle()
      expect(result).toMatchObject({ outcome: 'failed', code: 'unexpected-response', route: 'active-sessions' })
      // The claim being proven: nothing was reported. Reading this body as "nothing is
      // running" would have reported the session finished and the block asked.
      expect(h.delivered).toHaveLength(0)
      expect(h.stats().reported).toBe(0)
      expect(h.stats().cycles).toBe(0)
      expect(h.stats().failures).toBe(1)
      expect(h.stats().nextDelayMs).toBeGreaterThan(0)
      // The failure is visible, in the harness's own log, naming the route.
      const crumbs = h.lines.filter((line) => line.extra?.['code'] === 'unexpected-response')
      expect(crumbs).toHaveLength(1)
      expect(crumbs[0]?.message).toBe(POLL_NOTICE_MESSAGES['unexpected-response'])
      expect(crumbs[0]?.extra).toMatchObject({
        service: 'agent-ping',
        stage: 'poll-failed',
        harness: 'opencode',
        route: 'active-sessions',
        endpoint: `127.0.0.1:${server.port}`,
      })
    })
  }

  it('reports a failure for a status the route does not declare, and names the status', async () => {
    for (const status of [204, 301, 401, 404, 500, 503]) {
      const server = await serveOpencode({ active: { status, body: JSON.stringify({ data: {} }) } })
      const h = harnessOver({ endpoint: { host: '127.0.0.1', port: server.port } })
      const result = await h.fallback.cycle()
      expect(result).toMatchObject({ outcome: 'failed', code: 'unexpected-status', status })
      expect(h.delivered).toHaveLength(0)
      const crumbs = h.lines.filter((line) => line.extra?.['code'] === 'unexpected-status')
      expect(crumbs).toHaveLength(1)
      expect(crumbs[0]?.extra?.['status']).toBe(status)
      await server.close()
    }
  })

  it('reports a failure for a permission listing whose container is wrong', async () => {
    const wrongPermissionBodies: readonly { readonly name: string; readonly body: string }[] = [
      { name: 'a renamed container', body: JSON.stringify({ requests: [] }) },
      { name: 'data as an object', body: JSON.stringify({ location: {}, data: { a: 1 } }) },
      { name: 'data as a string', body: JSON.stringify({ data: 'none' }) },
      { name: 'a bare array', body: JSON.stringify([]) },
      { name: 'text that is not JSON', body: '<html>404</html>' },
    ]
    for (const { name, body } of wrongPermissionBodies) {
      const server = await serveOpencode({
        active: { status: 200, body: activeBody([SESSION]) },
        wait: 'hang',
        permissions: { status: 200, body },
      })
      const h = harnessOver({
        endpoint: { host: '127.0.0.1', port: server.port },
        // A small wait bound, so a test about the permission container is not also a test
        // about how long a long poll is allowed to hang.
        waitTimeoutMs: 20,
      })
      h.fallback.noteSession(SESSION)
      const result = await h.fallback.cycle()
      expect(result, name).toMatchObject({
        outcome: 'failed',
        code: 'unexpected-response',
        route: 'pending-permissions',
      })
      expect(h.delivered).toHaveLength(0)
      expect(codesIn(h.lines)).toContain('unexpected-response')
      await server.close()
    }
  })

  it('counts one malformed permission entry and still reports the rest of the listing', async () => {
    const server = await serveOpencode({
      permissions: {
        status: 200,
        body: JSON.stringify({
          location: {},
          data: [
            { id: BLOCK, sessionID: SESSION, action: ACTION },
            { sessionID: SESSION },
            { id: 'per_02' },
            'not an object',
            { id: 'per_03', sessionID: SESSION },
          ],
        }),
      },
    })
    const h = harnessOver({ endpoint: { host: '127.0.0.1', port: server.port } })
    h.fallback.noteSession(SESSION)
    expect(await h.fallback.cycle()).toMatchObject({ outcome: 'ok' })
    expect(h.stats().malformedEntries).toBe(3)
    expect(h.delivered.map((signal) => signal.transitionId)).toEqual([BLOCK, 'per_03'])
  })

  it('treats a listing larger than the cap as a contract change rather than allocating for it', async () => {
    const entries: Record<string, { type: string }> = {}
    for (let index = 0; index <= MAX_POLL_ENTRIES; index += 1) entries[`ses_${index}`] = { type: 'running' }
    const server = await serveOpencode({ active: { status: 200, body: JSON.stringify({ data: entries }) } })
    const h = harnessOver({ endpoint: { host: '127.0.0.1', port: server.port }, waitTimeoutMs: 20 })
    expect(await h.fallback.cycle()).toMatchObject({ outcome: 'failed', code: 'unexpected-response' })
    expect(h.stats().failures).toBe(1)
  })

  it('reads a genuinely empty listing as an empty result, not as a failure', async () => {
    const server = await serveOpencode({
      active: { status: 200, body: JSON.stringify({ data: {} }) },
      permissions: { status: 200, body: JSON.stringify({ location: {}, data: [] }) },
    })
    const h = harnessOver({ endpoint: { host: '127.0.0.1', port: server.port }, waitTimeoutMs: 20 })
    expect(await h.fallback.cycle()).toMatchObject({ outcome: 'ok' })
    expect(h.stats().cycles).toBe(1)
    expect(h.stats().failures).toBe(0)
    expect(codesIn(h.lines)).toEqual([])
    // Exactly the three documented routes, one request each, and nothing else.
    expect(server.requests).toEqual([
      `GET ${ACTIVE_PATH}`,
      `GET ${PERMISSIONS_PATH}?location[directory]=%2Fhome%2Fdev%2FProjects%2Fagent-ping`,
    ])
  })

  it('reports an answer body that is not JSON rather than throwing out of the cycle', async () => {
    // A hub-shaped JSON error body from something that is not opencode at all: the classic
    // "a foreign service is on this port" case, which must be a named failure.
    const foreign = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ agent_ping: 'this is the hub, not opencode', port: 51234 }))
    })
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve))
    const port = (foreign.address() as AddressInfo).port
    try {
      const h = harnessOver({ endpoint: { host: '127.0.0.1', port } })
      const result = await h.fallback.cycle()
      expect(result).toMatchObject({ outcome: 'failed', code: 'unexpected-response' })
      expect(h.delivered).toHaveLength(0)
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()))
    }
  })
})

// ---------------------------------------------------------------------------
// 4. The fallback never blocks the harness loop it runs in
// ---------------------------------------------------------------------------

describe('the fallback never blocks the harness loop (APX-CON-03, APX-CON-10)', () => {
  it('start() returns before a single request has been made', async () => {
    const server = await serveOpencode({ active: 'hang', wait: 'hang', permissions: 'hang' })
    const h = harnessOver({ endpoint: { host: '127.0.0.1', port: server.port } })
    h.fallback.start()
    // Synchronously, before anything could have answered: no socket, no await.
    expect(h.calls).toHaveLength(0)
    expect(server.requests).toHaveLength(0)
    expect(h.schedule.delays).toEqual([POLL_BASE_DELAY_MS])
    expect(h.stats().running).toBe(true)
    h.fallback.stop()
  })

  it('abandons a hung request at the bound while the event loop keeps turning', async () => {
    const server = await serveOpencode({ active: 'hang' })
    const bound = 150
    const h = harnessOver({
      endpoint: { host: '127.0.0.1', port: server.port },
      requestTimeoutMs: bound,
    })
    // A tick counter that only advances if this process's event loop is free while the
    // cycle is in flight against a server that will never answer.
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 5)
    try {
      const started = Date.now()
      const pending = h.fallback.cycle()
      // The cycle's caller is not waiting on it: the promise was handed back immediately.
      expect(pending).toBeInstanceOf(Promise)
      await new Promise((resolve) => setTimeout(resolve, bound + 60))
      const elapsed = Date.now() - started
      const result = await pending
      expect(result).toMatchObject({ outcome: 'failed', code: 'harness-timeout', route: 'active-sessions' })
      // Abandoned near the bound rather than waited on indefinitely.
      expect(elapsed).toBeLessThan(bound + 500)
      // And the loop really was free: two dozen ticks at 5ms is a lot of process time for a
      // 150ms wait, and zero would mean the cycle had blocked the event loop.
      expect(ticks).toBeGreaterThan(20)
      expect(codesIn(h.lines)).toEqual(['harness-timeout'])
    } finally {
      clearInterval(ticker)
    }
  })

  it('makes no further request after stop(), and a stopped fallback refuses to cycle', async () => {
    const server = await serveOpencode({ active: { status: 200, body: JSON.stringify({ data: {} }) } })
    const h = harnessOver({ endpoint: { host: '127.0.0.1', port: server.port } })
    h.fallback.start()
    await flush()
    expect(h.schedule.armed).toBe(1)
    h.fallback.stop()
    expect(h.schedule.armed).toBe(0)
    expect(h.stats().running).toBe(false)
    const before = server.requests.length
    await h.schedule.fire()
    expect(server.requests.length).toBe(before)
    expect(await h.fallback.cycle()).toEqual({ outcome: 'skipped', reason: 'stopped' })
  })

  it('drops a cycle that arrives while one is in flight rather than queueing it', async () => {
    const server = await serveOpencode({ active: 'hang' })
    const h = harnessOver({ endpoint: { host: '127.0.0.1', port: server.port }, requestTimeoutMs: 120 })
    const first = h.fallback.cycle()
    expect(await h.fallback.cycle()).toEqual({ outcome: 'skipped', reason: 'in-flight' })
    await first
    expect(h.calls).toHaveLength(1)
  })

  it('unrefs every timer it makes, so a pending poll cannot hold the process', async () => {
    const server = await serveOpencode({ active: 'hang', wait: 'hang', permissions: 'hang' })
    const handles: NodeJS.Timeout[] = []
    const spy = vi.spyOn(globalThis, 'setTimeout')
    spy.mockImplementation(((run: () => void, delay?: number) => {
      const handle = originalSetTimeout(run, delay)
      handles.push(handle)
      return handle
    }) as typeof setTimeout)
    try {
      const { log } = harnessLogging()
      const fallback = createPollFallback({
        log,
        translator: createTranslator({ directory: REPO, now: () => EPOCH }),
        directory: REPO,
        ledger: createDedupeLedger(),
        endpoint: { host: '127.0.0.1', port: server.port },
        requestTimeoutMs: 60,
        waitTimeoutMs: 60,
      })
      // The schedule's own timer, and then the socket's per-request timer: both are made
      // while the spy is watching, and neither may hold the process.
      fallback.start()
      await fallback.cycle()
      // Observed from the platform's own timer rather than from a flag this test set:
      // `hasRef()` is false only for a handle `unref()` has been called on, and a
      // referenced timer is a reason a developer's harness process stays alive
      // (APX-CON-03, APX-CON-10).
      expect(handles.length).toBeGreaterThanOrEqual(2)
      for (const handle of handles) expect(handle.hasRef()).toBe(false)
      fallback.stop()
    } finally {
      spy.mockRestore()
    }
  })

  it('the three real plugin hooks resolve promptly while the opencode server hangs', async () => {
    const server = await serveOpencode({ active: 'hang', wait: 'hang', permissions: 'hang' })
    const { client } = harnessLogging()
    const started = Date.now()
    const hooks = await AGENT_PING_PLUGIN(
      { client, directory: REPO },
      {
        deliver: () => undefined,
        poll: {
          endpoint: { host: '127.0.0.1', port: server.port },
          baseDelayMs: 5,
          maxDelayMs: 10,
          requestTimeoutMs: 100,
          waitTimeoutMs: 100,
        },
      },
    )
    const eventHook = hooks.event
    const before = hooks['tool.execute.before']
    const after = hooks['tool.execute.after']
    expect(typeof eventHook).toBe('function')
    await before?.({ tool: 'bash', sessionID: SESSION, callID: CALL })
    await after?.({ tool: 'bash', sessionID: SESSION, callID: CALL })
    await eventHook?.({ event: { type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } } })
    // Three hooks, a hung server behind them, and none of them waited for it.
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('a delivery port that throws is contained inside the cycle and never reaches the session', async () => {
    const { log } = harnessLogging()
    const fallback = createPollFallback({
      log,
      translator: createTranslator({ directory: REPO, now: () => EPOCH }),
      directory: REPO,
      ledger: createDedupeLedger(),
      deliver: () => {
        throw new Error('the delivery port is broken')
      },
      endpoint: { host: '127.0.0.1', port: 1 },
      request: async (input) =>
        routeOf(input.path) === 'permissions'
          ? { kind: 'answered', status: 200, body: permissionsBody([{ id: BLOCK, sessionID: SESSION }]) }
          : { kind: 'answered', status: 200, body: JSON.stringify({ data: {} }) },
    })
    fallback.noteSession(SESSION)
    // The wait route times out, the listing answers with a block, and the delivery port
    // throws. None of that may become an exception.
    // The port threw; the cycle still resolved, and the attempt is counted rather than
    // lost. The port itself owns the breadcrumb for a delivery it could not make (OA-2),
    // and this module's job is only to stop the exception (APX-CON-03, APX-CON-10).
    await expect(fallback.cycle().then((result) => result.outcome)).resolves.toBe('ok')
    expect(fallback.stats.reported).toBe(1)
    expect(fallback.stats.failures).toBe(0)
  })

  it('a fault nobody anticipated is reported by name and does not escape the cycle', async () => {
    const { log, lines } = harnessLogging()
    const fallback = createPollFallback({
      log,
      translator: createTranslator({ directory: REPO, now: () => EPOCH }),
      directory: REPO,
      ledger: createDedupeLedger(),
      endpoint: { host: '127.0.0.1', port: 1 },
      // An injected seam that throws is a cycle failure, not a session failure.
      request: () => {
        throw new TypeError('the seam is broken')
      },
    })
    fallback.noteSession(SESSION)
    const result = await fallback.cycle()
    expect(result).toMatchObject({ outcome: 'failed', code: 'poll-fault', route: 'active-sessions' })
    const crumbs = lines.filter((line) => line.extra?.['code'] === 'poll-fault')
    expect(crumbs).toHaveLength(1)
    expect(crumbs[0]?.extra).toMatchObject({ errorName: 'TypeError' })
    // The message never quotes the fault's own text, which is built from a value.
    expect(JSON.stringify(crumbs[0]?.extra)).not.toContain('the seam is broken')
  })
})

// ---------------------------------------------------------------------------
// What the fallback reports, and what it refuses to guess
// ---------------------------------------------------------------------------

describe('the fallback reports states it can attribute and counts the ones it cannot', () => {
  it('classifies a polled block and a polled idle through the real classifier', async () => {
    const h = harnessOver({ ...QUIET })
    h.fallback.noteSession(SESSION)
    h.translator.observe({ type: 'tool.execute.before', properties: { sessionID: SESSION, callID: CALL } })
    h.requests['active'] = { kind: 'answered', status: 200, body: activeBody([SESSION]) }
    h.requests['permissions'] = { kind: 'answered', status: 200, body: permissionsBody([{ id: BLOCK, sessionID: SESSION }]) }
    await h.fallback.cycle()
    h.requests['active'] = { kind: 'answered', status: 200, body: JSON.stringify({ data: {} }) }
    await h.fallback.cycle()

    // The two states arrived as the block first and the finished transition second.
    expect(h.delivered).toHaveLength(2)
    expect(h.delivered[0]).toMatchObject({ eventName: 'permission.asked', transitionId: BLOCK, sessionId: SESSION })
    expect(h.delivered[1]).toMatchObject({
      eventName: 'session.status',
      variant: 'idle',
      transitionId: 'idle:1',
      turnWork: WORK,
    })

    // And the classifier, asked directly about the same two signals through a translator
    // whose turn the poller has not already reported, says what each is worth. A probed
    // translator rather than `h.translator` because reporting a turn is a one-shot thing:
    // asking the same recorder again would read the gate's own silence, not the class.
    const probe = createTranslator({ directory: REPO, now: () => EPOCH })
    probe.observe({ type: 'tool.execute.before', properties: { sessionID: SESSION, callID: CALL } })
    const idle = probe.observe({
      type: 'session.status',
      properties: { sessionID: SESSION, status: { type: 'idle' } },
    })
    const block = probe.observe({
      type: 'permission.updated',
      properties: { id: BLOCK, sessionID: SESSION },
    })
    expect(idle?.classification).toMatchObject({ outcome: 'event' })
    expect(idle?.classification.outcome === 'event' ? idle.classification.event.class : '').toBe('finished')
    expect(idle?.classification.outcome === 'event' ? idle.classification.event.dedupeKey : '').toBe(
      deriveDedupeKey('opencode', SESSION, 'idle:1'),
    )
    expect(block?.classification).toMatchObject({ outcome: 'event' })
    expect(block?.classification.outcome === 'event' ? block.classification.event.class : '').toBe('needs-you')
    expect(block?.classification.outcome === 'event' ? block.classification.event.dedupeKey : '').toBe(
      deriveDedupeKey('opencode', SESSION, BLOCK),
    )
  })

  it('never lets a permission payload reach a signal, an envelope or the log', async () => {
    const server = await serveOpencode({
      permissions: {
        status: 200,
        body: permissionsBody([
          { id: BLOCK, sessionID: SESSION, action: ACTION, resources: [RESOURCE] },
        ]),
      },
    })
    const h = harnessOver({ endpoint: { host: '127.0.0.1', port: server.port }, waitTimeoutMs: 20 })
    h.fallback.noteSession(SESSION)
    await h.fallback.cycle()
    expect(h.delivered).toHaveLength(1)
    const serialised = JSON.stringify({
      signal: h.delivered,
      log: h.lines,
      result: await h.fallback.cycle(),
    })
    expect(serialised).not.toContain(ACTION)
    expect(serialised).not.toContain(RESOURCE)
    expect(serialised).not.toContain(METADATA)
  })

  it('counts a running session it was never told about and does not report it', async () => {
    const server = await serveOpencode({
      active: { status: 200, body: activeBody([SESSION, OTHER_SESSION]) },
      permissions: {
        status: 200,
        body: permissionsBody([{ id: BLOCK, sessionID: SESSION }, { id: 'per_02', sessionID: OTHER_SESSION }]),
      },
    })
    const h = harnessOver({
      endpoint: { host: '127.0.0.1', port: server.port },
      waitTimeoutMs: 20,
    })
    h.fallback.noteSession(SESSION)
    expect(await h.fallback.cycle()).toMatchObject({ outcome: 'ok' })
    // The other repository's session and its block are counted, never reported under this
    // instance's directory (APX-CON-09, ADR-008).
    expect(h.stats().foreignSessions).toBe(1)
    expect(h.stats().foreignPermissions).toBe(1)
    expect(h.delivered.map((signal) => signal.transitionId)).toEqual([BLOCK])
    // The boundary is visible once, not once per cycle.
    const notices = h.lines.filter((line) => line.extra?.['code'] === 'session-not-ours')
    expect(notices).toHaveLength(1)
    expect(notices[0]?.extra).toMatchObject({ stage: 'poll-degraded', route: 'active-sessions' })
    await h.fallback.cycle()
    expect(h.lines.filter((line) => line.extra?.['code'] === 'session-not-ours')).toHaveLength(1)
  })

  it('waits on the session that has been running longest, and one wait per cycle', async () => {
    const server = await serveOpencode({
      active: { status: 200, body: activeBody([SESSION, OTHER_SESSION]) },
      wait: 'hang',
    })
    const h = harnessOver({
      endpoint: { host: '127.0.0.1', port: server.port },
      requestTimeoutMs: 200,
      waitTimeoutMs: 60,
    })
    h.fallback.noteSession(SESSION)
    h.fallback.noteSession(OTHER_SESSION)
    await h.fallback.cycle()
    const waits = server.requests.filter((entry) => entry.includes('/wait'))
    expect(waits).toEqual([`GET /api/session/${SESSION}/wait`])
    // A timeout on the wait route is the expected answer while a session works, so it is
    // counted and never treated as a failure.
    expect(h.stats().stillRunning).toBe(1)
    expect(h.stats().failures).toBe(0)
  })

  it('a 204 on the wait route is the same idle edge the listing reports', async () => {
    const h = harnessOver({
      requests: {
        active: { kind: 'answered', status: 200, body: activeBody([SESSION]) },
        wait: { kind: 'answered', status: 204, body: '' },
        permissions: { kind: 'answered', status: 200, body: JSON.stringify({ location: {}, data: [] }) },
      },
    })
    h.fallback.noteSession(SESSION)
    h.translator.observe({ type: 'tool.execute.before', properties: { sessionID: SESSION, callID: CALL } })
    // First cycle: the session is running, and the wait answers 204 in the same cycle.
    expect(await h.fallback.cycle()).toMatchObject({ outcome: 'ok' })
    expect(h.stats().idleWaits).toBe(1)
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]?.eventName).toBe('session.status')
    expect(h.delivered[0]?.variant).toBe('idle')
    expect(h.delivered[0]?.transitionId).toBe('idle:1')
    // The edge was consumed, so the next cycle reports nothing more for that turn.
    expect(await h.fallback.cycle()).toMatchObject({ outcome: 'ok' })
    expect(h.delivered).toHaveLength(1)
  })

  it('a 404 on the wait route is the same edge, and a status this build cannot accept is not', async () => {
    const gone = harnessOver({
      requests: {
        active: { kind: 'answered', status: 200, body: activeBody([SESSION]) },
        wait: { kind: 'answered', status: 404, body: '' },
        permissions: { kind: 'answered', status: 200, body: JSON.stringify({ location: {}, data: [] }) },
      },
    })
    gone.fallback.noteSession(SESSION)
    gone.translator.observe({ type: 'tool.execute.before', properties: { sessionID: SESSION, callID: CALL } })
    expect(await gone.fallback.cycle()).toMatchObject({ outcome: 'ok' })
    expect(gone.delivered).toHaveLength(1)

    const refused = harnessOver({
      requests: {
        active: { kind: 'answered', status: 200, body: activeBody([SESSION]) },
        wait: { kind: 'answered', status: 500, body: '' },
        permissions: { kind: 'answered', status: 200, body: JSON.stringify({ location: {}, data: [] }) },
      },
    })
    refused.fallback.noteSession(SESSION)
    const result = await refused.fallback.cycle()
    expect(result).toMatchObject({ outcome: 'failed', code: 'unexpected-status', route: 'wait-for-idle', status: 500 })
    expect(refused.delivered).toHaveLength(0)
  })

  it('reports a discovered state as a breadcrumb when there is no delivery port', async () => {
    const server = await serveOpencode({
      permissions: { status: 200, body: permissionsBody([{ id: BLOCK, sessionID: SESSION }]) },
    })
    const h = harnessOver({ endpoint: { host: '127.0.0.1', port: server.port }, withDelivery: false })
    h.fallback.noteSession(SESSION)
    // The state is real and there is nowhere to send it, which is the case the fallback
    // exists to cover: it says so rather than letting the discovery vanish.
    expect(await h.fallback.cycle()).toMatchObject({ outcome: 'ok' })
    expect(h.stats().reported).toBe(0)
    const notices = h.lines.filter((line) => line.extra?.['code'] === 'no-delivery-port')
    expect(notices).toHaveLength(1)
    expect(notices[0]?.extra).toMatchObject({ stage: 'poll-degraded', sessionId: SESSION })
    // Once, not once per cycle.
    await h.fallback.cycle()
    expect(h.lines.filter((line) => line.extra?.['code'] === 'no-delivery-port')).toHaveLength(1)
  })

  it('refuses a non-loopback endpoint before a socket is opened', async () => {
    for (const host of ['0.0.0.0', '10.0.0.5', 'example.com', '::ffff:10.0.0.1', '127.0.0.1.evil.com', '999.1.1.1']) {
      expect(isLoopbackHost(host), host).toBe(false)
      const h = harnessOver({ endpoint: { host, port: 4096 } })
      h.fallback.noteSession(SESSION)
      const result = await h.fallback.cycle()
      expect(result, host).toMatchObject({ outcome: 'failed', code: 'harness-unreachable' })
      // Zero requests: the address is refused, not dialled (APX-CON-12).
      expect(h.calls, host).toHaveLength(0)
      expect(codesIn(h.lines), host).toEqual(['harness-unreachable'])
    }
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackHost(host), host).toBe(true)
    }
  })

  it('a breadcrumb names the service, the route and the endpoint, and nothing else', () => {
    const crumb = pollBreadcrumb(
      { code: 'unexpected-status', route: 'active-sessions', status: 500 },
      { host: '127.0.0.1', port: 4096 },
    )
    expect(crumb).toEqual({
      service: 'agent-ping',
      stage: 'poll-failed',
      code: 'unexpected-status',
      harness: 'opencode',
      route: 'active-sessions',
      endpoint: '127.0.0.1:4096',
      status: 500,
    })
    // An unrecognised code has no sentence, and a line with no sentence is the silent
    // failure this product exists to prevent, so it falls back to the generic one.
    const unknown = pollBreadcrumb(
      { code: 'made-up' as PollNoticeCode, route: 'wait-for-idle' },
      { host: '127.0.0.1', port: 1 },
    )
    expect(unknown.code).toBe('poll-fault')
    // A multi-line value never reaches a log field.
    const injected = pollBreadcrumb(
      { code: 'poll-fault', route: 'active-sessions', sessionId: 'ses\nInjected: value' },
      { host: '127.0.0.1', port: 1 },
    )
    expect(injected.sessionId).toBeUndefined()
  })

  it('a logging client that throws does not become a session failure', () => {
    const hostile: HarnessLog = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => {
        throw new Error('the harness log client is broken')
      },
      error: () => undefined,
    }
    const notice: PollNotice = { code: 'harness-unreachable', route: 'active-sessions' }
    expect(() => writePollNotice(hostile, notice, { host: '127.0.0.1', port: 1 })).not.toThrow()
  })

  it('the real socket answers a GET, honours its bound, and destroys a hung connection', async () => {
    const server = await serveOpencode({ wait: 'hang' })
    // A real GET over a real loopback socket, with the real request function.
    const ok = await sendPollRequest({
      host: '127.0.0.1',
      port: server.port,
      path: ACTIVE_PATH,
      timeoutMs: 2_000,
    })
    expect(ok).toEqual({ kind: 'answered', status: 200, body: JSON.stringify({ data: {} }) })

    // The wait route on this server accepts the request and never answers, so the bound
    // is what ends it - and the socket is destroyed rather than left open.
    const bound = 120
    const started = Date.now()
    const hung = await sendPollRequest({
      host: '127.0.0.1',
      port: server.port,
      path: waitForIdlePath(SESSION),
      timeoutMs: bound,
    })
    expect(hung).toEqual({ kind: 'timeout' })
    expect(Date.now() - started).toBeLessThan(bound + 400)
  })

  it('the entry point starts the fallback, and poll: false switches it off', async () => {
    const on = await serveOpencode({ active: { status: 200, body: JSON.stringify({ data: {} }) } })
    const off = await serveOpencode({ active: { status: 200, body: JSON.stringify({ data: {} }) } })
    const { client } = harnessLogging()
    await AGENT_PING_PLUGIN(
      { client, directory: REPO },
      {
        deliver: () => undefined,
        poll: { endpoint: { host: '127.0.0.1', port: on.port }, baseDelayMs: 5, maxDelayMs: 10 },
      },
    )
    await AGENT_PING_PLUGIN(
      { client, directory: REPO },
      { deliver: () => undefined, poll: false },
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    // The first is running: it asked the real server, repeatedly.
    expect(on.requests.length).toBeGreaterThan(1)
    // The second never opened a socket at all, and the default port was never dialled.
    expect(off.requests).toHaveLength(0)
  })

  it('a mistyped poll value leaves the fallback on with its defaults and the hooks untouched', async () => {
    const { client } = harnessLogging()
    const hooks = await AGENT_PING_PLUGIN({ client, directory: REPO }, { deliver: () => undefined, poll: 'yes please' })
    // Only `false` switches the fallback off. A value that is not a tuning record is read
    // as "on with the defaults", because treating a typo as `off` would silently switch
    // off the one path that covers a missing push - and the same rule the delivery port is
    // read by. Nothing was configured here, so the fallback is running on the default
    // address, which is a hub-less breadcrumb and never an exception.
    expect(Object.keys(hooks).sort()).toEqual(['event', 'tool.execute.after', 'tool.execute.before'])
    await hooks.event?.({ event: { type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } } })
    await expect(
      hooks['tool.execute.before']?.({ tool: 'bash', sessionID: SESSION, callID: CALL }),
    ).resolves.toBeUndefined()
  })

  it('the entry point records a pushed key in the ledger the fallback claims from', () => {
    // The wiring itself, read from the source: a second key derivation or a second
    // classification path would be the duplicate-event bug OA-FR-07 exists to prevent.
    expect(INDEX_SOURCE).toContain('createDedupeLedger')
    expect(INDEX_SOURCE).toMatch(/ledger\.record\(translated\.classification\.event\.dedupeKey\)/)
    expect(INDEX_SOURCE).toContain('fallback?.noteSession')
    expect(INDEX_SOURCE).toContain('createPollFallback')
    // The hook set is unchanged: the fallback is started, not exposed as a fourth hook.
    expect(INDEX_SOURCE).not.toMatch(/^\s*poll\?:.*=> Promise/m)
  })

  it('records a real idle edge for a session whose work signal the hooks never saw', async () => {
    // A turn with no work: the poller finds the edge, the recorder has nothing, and the
    // idle gate reads that as silence rather than as work (ADR-004's restrained reading).
    const h = harnessOver({
      requests: {
        active: { kind: 'answered', status: 200, body: activeBody([SESSION]) },
        wait: { kind: 'timeout' },
        permissions: { kind: 'answered', status: 200, body: JSON.stringify({ location: {}, data: [] }) },
      },
    })
    h.fallback.noteSession(SESSION)
    h.translator.recorder.beginTurn(SESSION)
    // Awaited, not floated: an assertion inside a promise nobody awaited is an assertion
    // the runner never sees, and a failing one would be reported as an unhandled rejection
    // against no test at all.
    await h.fallback.cycle()
    h.requests['active'] = { kind: 'answered', status: 200, body: JSON.stringify({ data: {} }) }
    const result = await h.fallback.cycle()
    expect(result.outcome).toBe('ok')
    expect(h.delivered).toHaveLength(0)
    // The gate was evaluated, and the answer was silence rather than a wrong toast.
    const translated = h.translator.observe({
      type: 'session.status',
      properties: { sessionID: SESSION, status: { type: 'idle' } },
    })
    expect(translated?.classification).toMatchObject({ outcome: 'no-event', reason: 'idle-after-nothing' })
    expect(NO_WORK.toolCall).toBe(false)
  })

  it('counts what a cycle found, so an idle cycle reports zero rather than a constant', async () => {
    // The number a developer reads has to be the number of things that happened. A cycle
    // that found nothing must say zero: a hardcoded non-zero would make a quiet fallback
    // and a busy one indistinguishable, which is the opposite of what this counter is for.
    const h = harnessOver({ ...QUIET })
    h.fallback.noteSession(SESSION)
    expect(await h.fallback.cycle()).toEqual({ outcome: 'ok', discovered: 0 })
    expect(h.stats().discovered).toBe(0)

    // One pending block, then an idle edge: one discovery each, and each is counted even
    // when the ledger suppresses the delivery.
    h.requests['permissions'] = { kind: 'answered', status: 200, body: permissionsBody([{ id: BLOCK, sessionID: SESSION }]) }
    expect(await h.fallback.cycle()).toEqual({ outcome: 'ok', discovered: 1 })
    expect(h.stats().discovered).toBe(1)
    // The same block again: found again, suppressed again, and the find is still counted.
    expect(await h.fallback.cycle()).toEqual({ outcome: 'ok', discovered: 1 })
    expect(h.stats().discovered).toBe(2)
    expect(h.stats().suppressed).toBe(1)
    expect(h.delivered).toHaveLength(1)

    // The idle edge: the recorder has no work, so the gate suppresses it - and a suppressed
    // discovery is still a discovery. The permission listing is emptied first, so this
    // measures the edge rather than the block still being pending.
    h.requests['permissions'] = { kind: 'answered', status: 200, body: JSON.stringify({ location: {}, data: [] }) }
    h.translator.recorder.beginTurn(SESSION)
    h.requests['active'] = { kind: 'answered', status: 200, body: activeBody([SESSION]) }
    expect(await h.fallback.cycle()).toEqual({ outcome: 'ok', discovered: 0 })
    h.requests['active'] = { kind: 'answered', status: 200, body: JSON.stringify({ data: {} }) }
    expect(await h.fallback.cycle()).toEqual({ outcome: 'ok', discovered: 1 })
    expect(h.stats().discovered).toBe(3)
    expect(h.delivered).toHaveLength(1)
  })
})
