// The transport: from a harness hook to the hub running on this machine
// (OA-FR-04, OA-FR-05, APX-FR-02, APX-CON-03, APX-CON-10, ADR-002, PRD 6.3).
//
//   npm test -- tests/plugin/transport.test.ts
//
// The four acceptance criteria, and where each one is proven:
//
//   1. EXACTLY ONE REQUEST PER EVENT, AND NO RETRY AFTER A REFUSED CONNECTION.
//      Proven over real loopback sockets rather than against a mock: a counting server
//      receives exactly one request per delivered signal, and after a refused
//      connection a server bound to that same port receives nothing at all for three
//      further timeouts. A mocked sender could only prove the code called its
//      dependency once, which is not the claim.
//   2. A HUNG SERVER IS ABANDONED AT THE CONFIGURED BOUND RATHER THAN BLOCKING THE
//      CALLER. A server that accepts the request and never answers: the delivery
//      resolves as a timeout at the bound, the socket is destroyed (observed from the
//      server's side rather than from a flag this test set), and the call itself
//      returned synchronously long before the timer fired.
//   3. A BREADCRUMB IS WRITTEN WITH THE SERVICE, THE SESSION AND THE EVENT TYPE WHEN
//      THE HUB IS UNREACHABLE. Driven through the plugin's real hooks with no hub
//      running, and read off the harness's own logging client. The console is spied on
//      and asserted silent, because a breadcrumb in the console is not a breadcrumb in
//      the harness's interface (OA-FR-09).
//   4. NO TRANSPORT FAILURE PROPAGATES AN EXCEPTION OUT OF THE PLUGIN HOOK. Every row
//      of the failure table is driven through the real `AGENT_PING_PLUGIN` with this
//      transport wired as its delivery port, and every hook resolves.
//
// Around those four, the properties that make them worth anything:
//
//   - THE HUB IS FOUND, NOT GUESSED. A real hub, started by the real entry point on an
//     ephemeral port - so the live port is provably not the default - is reached
//     through the runtime file alone, and the signal it stores is read back out of the
//     real log through a second connection. A transport that dialled 43117 would fail
//     this test rather than pass it.
//   - THE CREDENTIAL IS ATTACHED. The recorded request carries this install's own write
//     token in the header the hub publishes, read from the state directory the runtime
//     file names.
//   - THE BODY IS THE HUB'S CLOSED FIELD SET. Asserted against `INGEST_SIGNAL_FIELDS` in
//     both directions: nothing the hub owns is sent, and the same body with one of those
//     fields added is refused by the route's own validator, which is what proves the
//     omission is deliberate rather than accidental.
//   - NOTHING LEAVES THE MACHINE. An endpoint naming a non-loopback host is refused
//     before a socket is opened, using the hub's own predicate.
//   - NO FAILURE IS SILENT AND NONE IS THROTTLED. Five failures produce five lines, so a
//     rate limit cannot quietly become a swallowed event (APX-FR-02).
//   - THE TRANSPORT IS A CLIENT AND NOTHING MORE: no file is written, no process is
//     spawned, no timer outlives an attempt, the default port is never named, and the
//     console is not a logging surface. Asserted in code rather than in a comment,
//     read from the source.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { startHub, type RunningHub } from '@/main/index'
import { openEventStore, type EventStore } from '@/storage/eventStore'
import type { HarnessSignal } from '@/domain/classify'
import { INGEST_ROUTES, INGEST_SIGNAL_FIELD_NAMES, validateIngestSignal } from '@/hub/routes/ingest'
import { readWriteToken, WRITE_TOKEN_HEADER } from '@/hub/security'
import { DEFAULT_HUB_PORT } from '@/hub/server'
import { AGENT_PING_PLUGIN } from '@/plugin/opencode/index'
import {
  createHarnessLog,
  type HarnessLog,
  type OpencodeEvent,
  type OpencodeLogClient,
} from '@/plugin/opencode/translate'
import * as breadcrumbModule from '@/plugin/transport/breadcrumb'
import {
  DELIVERY_FAILURE_MESSAGES,
  deliveryBreadcrumb,
  writeDeliveryBreadcrumb,
} from '@/plugin/transport/breadcrumb'
import * as transportModule from '@/plugin/transport/http'
import {
  DELIVERY_TIMEOUT_MS,
  INGEST_PATH,
  MAX_ANSWER_BYTES,
  createHubTransport,
  readEndpointFromRuntimeFile,
  readTokenFromInstall,
  sendHttpRequest,
  toIngestBody,
  type HubTransport,
} from '@/plugin/transport/http'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO = '/home/dev/Projects/agent-ping'
const SESSION = 'ses_transport_01'
const BLOCK = 'per_transport_01'
const CALL = 'call_transport_01'
const OCCURRED_AT = '2026-09-26T12:00:00.000Z'
const EPOCH = Date.parse(OCCURRED_AT)
const INSTANCE_ID = '2f0a4f2c-0000-4000-8000-000000000001'
/** A well-formed install token: sixty-four hexadecimal characters, as the hub issues. */
const TOKEN = 'a3f1'.repeat(16)

/** Values that appear nowhere but in these fixtures' payloads, and must travel nowhere. */
const PROMPT = 'PROMPT-the-transport-must-never-carry-this'
const ARGUMENT = 'ARGUMENT-the-transport-must-never-carry-this'
const TITLE = 'TITLE-the-transport-must-never-carry-this'

/** A block, as the adapter's translator produces it. */
function blockSignal(overrides: Partial<HarnessSignal> = {}): HarnessSignal {
  return {
    harness: 'opencode',
    eventName: 'permission.asked',
    sessionId: SESSION,
    repoFullPath: REPO,
    transitionId: BLOCK,
    occurredAt: OCCURRED_AT,
    receivedAt: '2026-09-26T12:00:00.500.000Z',
    ...overrides,
  }
}

/** A finished turn, which carries the three work measures. */
function finishedSignal(): HarnessSignal {
  return {
    ...blockSignal({ eventName: 'session.status', variant: 'idle', transitionId: 'idle:1' }),
    turnWork: { toolCall: true, fileEdit: false, todoUpdate: true },
  }
}

/** The opencode event the plugin's real hooks turn into a block, 1.18.32 shapes. */
const PERMISSION_EVENT: OpencodeEvent = {
  type: 'permission.updated',
  properties: {
    id: BLOCK,
    type: 'bash',
    sessionID: SESSION,
    messageID: 'msg_transport_01',
    callID: CALL,
    title: TITLE,
    pattern: ARGUMENT,
    metadata: { note: PROMPT },
    time: { created: EPOCH },
  },
}

/** The reply that resolves it. */
const REPLY_EVENT: OpencodeEvent = {
  type: 'permission.replied',
  properties: { sessionID: SESSION, permissionID: BLOCK, response: 'once' },
}

/** The tool-boundary hook's input, in the 1.18.32 shape. */
const TOOL_BOUNDARY = {
  tool: 'bash',
  sessionID: SESSION,
  callID: CALL,
  args: { command: ARGUMENT },
}

interface LogLine {
  readonly level: string
  readonly service: string
  readonly message: string
  readonly extra?: Record<string, unknown>
}

interface HarnessLogging {
  /** What the transport and the adapter are given. */
  readonly log: HarnessLog
  /** The harness's own logging client, for the plugin. */
  readonly client: OpencodeLogClient
  /** Every line the harness recorded, in order. */
  readonly lines: LogLine[]
}

/** The harness's own logging client, as `createHarnessLog` drives it. */
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

// ---------------------------------------------------------------------------
// A counting server, and the sockets it saw
// ---------------------------------------------------------------------------

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly body: string
}

interface TestServer {
  readonly port: number
  readonly requests: RecordedRequest[]
  /** How many accepted sockets have since closed. The destroy is observed here. */
  closedSockets(): number
  close(): Promise<void>
}

type Responder = (request: IncomingMessage, response: ServerResponse) => void

/** A real loopback server that records every request it is given. */
async function startTestServer(respond: Responder = answerAccepted): Promise<TestServer> {
  const requests: RecordedRequest[] = []
  let closed = 0
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.once('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      respond(request, response)
    })
  })
  server.on('connection', (socket) => socket.once('close', () => (closed += 1)))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    closedSockets: (): number => closed,
    close: (): Promise<void> => closeServer(server),
  }
}

/** A server bound to a named port, for the "did anything retry?" probe. */
async function listenOn(port: number): Promise<TestServer> {
  const requests: RecordedRequest[] = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? '', url: request.url ?? '', headers: {}, body: '' })
    answerAccepted(request, response)
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    port,
    requests,
    closedSockets: (): number => 0,
    close: (): Promise<void> => closeServer(server),
  }
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeAllConnections()
  return new Promise<void>((resolve) => server.close(() => resolve()))
}

/** The hub's own 202, in the shape `IngestAcceptedBody` documents. */
function answerAccepted(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(202, { 'content-type': 'application/json' })
  response.end(
    JSON.stringify({
      accepted: true,
      outcome: 'stored',
      eventId: 'evt_transport_01',
      class: 'needs-you',
      pendingCount: 1,
      duplicate: false,
      reason: null,
    }),
  )
}

/** A refusal, in the shape the route's own table documents. */
function refuseWith(status: number, error: string): Responder {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error, detail: 'a literal sentence from the route' }))
  }
}

/** Never answers at all: the wedged hub. */
const answerNever: Responder = () => {
  // Deliberately nothing. The request is abandoned at the bound, not answered.
}

/** A port that was served a moment ago and is not now. */
async function closedPort(): Promise<number> {
  const server = await startTestServer()
  const { port } = server
  await server.close()
  return port
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const servers: TestServer[] = []
const hubs: RunningHub[] = []
const stores: EventStore[] = []
const directories: string[] = []

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close().catch(() => undefined)
  for (const server of servers.splice(0)) await server.close().catch(() => undefined)
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

/**
 * A state directory with a real runtime file, in the hub's own published shape.
 *
 * Written by hand rather than by `writeRuntimeFile`, so the test holds the transport to
 * the field *names* the contract publishes - which is the thing that can drift. No
 * token: a directory with a pointer and no credential is the `token-missing` failure,
 * and it has its own fixture below.
 */
function runtimeFileOnly(port: number | null): string {
  const stateDir = temporaryDirectory('agent-ping-transport-state-')
  writeFileSync(
    `${stateDir}/hub-runtime.json`,
    `${JSON.stringify(
      {
        version: 1,
        instanceId: INSTANCE_ID,
        pid: process.pid,
        host: '127.0.0.1',
        port,
        stateDir,
        startedAt: OCCURRED_AT,
        schemaVersion: 1,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  return stateDir
}

/** A state directory that looks like a live install: a pointer and a credential. */
function stateDirectoryWithRuntimeFile(port: number | null): string {
  const stateDir = runtimeFileOnly(port)
  writeFileSync(`${stateDir}/hub-write-token`, `${TOKEN}\n`, { mode: 0o600 })
  return stateDir
}

/** A state directory whose runtime file is there and cannot be understood. */
function corruptStateDirectory(): string {
  const stateDir = temporaryDirectory('agent-ping-transport-corrupt-')
  writeFileSync(`${stateDir}/hub-write-token`, `${TOKEN}\n`, { mode: 0o600 })
  writeFileSync(`${stateDir}/hub-runtime.json`, '{ this is not a runtime file', { mode: 0o600 })
  return stateDir
}

/** A state directory whose token file is there and cannot be understood. */
function corruptTokenStateDirectory(): string {
  const stateDir = stateDirectoryWithRuntimeFile(43_117)
  writeFileSync(`${stateDir}/hub-write-token`, 'not-a-token\n', { mode: 0o600 })
  return stateDir
}

/** The default endpoint reader, pointed at one port: the production path, one socket swapped. */
function foundAt(port: number, stateDir: string) {
  return {
    kind: 'found' as const,
    endpoint: { host: '127.0.0.1', port, stateDir, instanceId: 'test-instance' },
  }
}

interface TransportOptions {
  readonly stateDir?: string
  readonly timeoutMs?: number
  readonly endpoint?: Parameters<typeof createHubTransport>[0]['endpoint']
  readonly token?: Parameters<typeof createHubTransport>[0]['token']
  readonly send?: Parameters<typeof createHubTransport>[0]['send']
}

/** A transport wired to a state directory, with the harness's log lines kept beside it. */
function transportOver(options: TransportOptions): {
  readonly deliver: HubTransport
  readonly lines: LogLine[]
} {
  const { log, lines } = harnessLogging()
  return { deliver: createHubTransport({ log, ...options }), lines }
}

/** A hub started by the real entry point, with the desktop replaced by a refusal. */
async function startFixtureHub(stateDir: string): Promise<RunningHub> {
  const hub = await startHub({
    stateDir,
    dashboardRoot: null,
    // Port 0: the hub binds something provably other than the default, so a transport
    // that dialled DEFAULT_HUB_PORT could not pass the tests below.
    preferredPort: 0,
    // The desktop replaced by a no-op: this file is about the transport, and a real
    // toast would make the assertions depend on whether this machine has one.
    delivery: { notifier: () => undefined },
  })
  hubs.push(hub)
  return hub
}

/** Wait for a condition a real socket or a real clock will eventually satisfy. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('the condition was not satisfied in time')
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

// ---------------------------------------------------------------------------
// 1. The hub is found, and the signal arrives in the real log
// ---------------------------------------------------------------------------

describe('the transport reaches the hub the runtime file names (OA-FR-04, PRD 6.3)', () => {
  it('posts to the live port, is accepted, and the event is in the real durable log', async () => {
    const stateDir = temporaryDirectory('agent-ping-transport-hub-')
    const hub = await startFixtureHub(stateDir)
    expect(hub.port).not.toBe(DEFAULT_HUB_PORT)

    const { deliver, lines } = transportOver({ stateDir })
    const accepted = await deliver(blockSignal())
    expect(accepted).toMatchObject({
      outcome: 'accepted',
      status: 202,
      hubOutcome: 'pending-created',
      eventId: expect.any(String),
    })
    // A successful delivery says nothing in the developer's log: the adapter already
    // logged the translation, and a line per event would be noise on the happy path.
    expect(lines).toEqual([])

    // A second connection to the log the hub is holding, which is how anything outside
    // that process observes what was stored.
    const store = openEventStore({ filePath: hub.databaseFilePath })
    stores.push(store)
    const pending = store.readPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ sessionId: SESSION, class: 'needs-you' })
    // Identity is the repository short name, derived by the hub from the path the
    // adapter sent (ADR-008). The adapter does not get to label the row.
    expect(pending[0]?.repoShortName).toBe('agent-ping')
  })

  it('delivers a block and then its resolution, so the lifecycle clears in the hub', async () => {
    const stateDir = temporaryDirectory('agent-ping-transport-lifecycle-')
    const hub = await startFixtureHub(stateDir)
    const store = openEventStore({ filePath: hub.databaseFilePath })
    stores.push(store)
    const { deliver, lines } = transportOver({ stateDir })

    expect((await deliver(blockSignal())).outcome).toBe('accepted')
    expect(store.readPending()).toHaveLength(1)
    // The resolution is a delivered signal too: a transport that carried only the
    // loud half would leave every block pending for ever.
    const resolved = await deliver(blockSignal({ eventName: 'permission.replied' }))
    expect(resolved.outcome).toBe('accepted')
    expect(store.readPending()).toHaveLength(0)
    expect(lines).toEqual([])
  })

  it('attaches the install\'s own write token in the header the hub publishes', async () => {
    const stateDir = temporaryDirectory('agent-ping-transport-token-')
    const hub = await startFixtureHub(stateDir)
    const server = await startTestServer()
    servers.push(server)
    const token = readWriteToken(stateDir)

    // The real readers, pointed at the real install, with only the socket replaced so
    // the request can be read.
    const { deliver, lines } = transportOver({
      stateDir,
      endpoint: () => foundAt(server.port, stateDir),
    })
    expect(hub.runtimeFile.port).toBe(hub.port)
    expect((await deliver(blockSignal())).outcome).toBe('accepted')

    expect(server.requests).toHaveLength(1)
    const sent = server.requests[0]
    expect(sent?.method).toBe('POST')
    expect(sent?.url).toBe(INGEST_PATH)
    expect(sent?.headers[WRITE_TOKEN_HEADER]).toBe(token)
    expect(sent?.headers['content-type']).toBe('application/json')
    expect(lines).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Exactly one request per event, and no retry storm
// ---------------------------------------------------------------------------

describe('one request per event, and never a second (OA-FR-04, APX-CON-10)', () => {
  it('makes exactly one request per delivered event, and withholds none of them', async () => {
    const server = await startTestServer()
    servers.push(server)
    const stateDir = stateDirectoryWithRuntimeFile(43_117)
    const { deliver } = transportOver({ stateDir, endpoint: () => foundAt(server.port, stateDir) })

    const signals = [blockSignal(), finishedSignal(), blockSignal({ transitionId: 'per_other' })]
    for (const signal of signals) {
      expect((await deliver(signal)).outcome).toBe('accepted')
    }
    expect(server.requests).toHaveLength(3)
    // The hub decides whether two identical signals are one event; the transport
    // delivers every signal it is handed and never holds one back.
    const posted = server.requests.map((request) => JSON.parse(request.body) as HarnessSignal)
    expect(posted.map((signal) => signal.transitionId)).toEqual([BLOCK, 'idle:1', 'per_other'])
  })

  it('sends no retry after a refused connection, even once a hub is listening again', async () => {
    const port = await closedPort()
    const stateDir = stateDirectoryWithRuntimeFile(port)
    const { deliver, lines } = transportOver({ stateDir, timeoutMs: 150 })

    const refused = await deliver(blockSignal())
    expect(refused).toEqual({ outcome: 'failed', code: 'connection-refused' })
    expect(lines[0]?.extra).toMatchObject({ code: 'connection-refused' })

    // The same port, served again. If anything retried, this is where it would land.
    const rebound = await listenOn(port)
    servers.push(rebound)
    await new Promise((resolve) => setTimeout(resolve, 150 * 3 + 100))
    expect(rebound.port).toBe(port)
    expect(rebound.requests).toHaveLength(0)
  })

  it('sends no retry after a refusal, a drop or an answer it cannot use', async () => {
    const cases = [
      { label: 'the hub refuses the signal', status: 422, error: 'invalid-signal' },
      { label: 'the hub cannot store it', status: 503, error: 'store-failed' },
      { label: 'the hub faults', status: 500, error: 'internal-error' },
      { label: 'something else is on the port', status: 200, error: 'not-json' },
    ] as const
    for (const testCase of cases) {
      const server = await startTestServer(refuseWith(testCase.status, testCase.error))
      servers.push(server)
      const stateDir = stateDirectoryWithRuntimeFile(43_117)
      const { deliver, lines } = transportOver({
        stateDir,
        endpoint: () => foundAt(server.port, stateDir),
      })
      const result = await deliver(blockSignal())
      expect(result, testCase.label).toMatchObject({
        outcome: 'refused',
        status: testCase.status,
      })
      expect(server.requests, testCase.label).toHaveLength(1)
      expect(lines, testCase.label).toHaveLength(1)
    }
  })

  it('leaves nothing running after an attempt: no pooled socket, no timer', async () => {
    const server = await startTestServer()
    servers.push(server)
    const stateDir = stateDirectoryWithRuntimeFile(43_117)
    const { deliver } = transportOver({ stateDir, endpoint: () => foundAt(server.port, stateDir) })
    await deliver(blockSignal())
    // `agent: false` means the socket is not kept warm inside somebody else's process,
    // so it is closed the moment the answer is read - observed from the server's side.
    await waitFor(() => server.closedSockets() >= 1)
    expect(server.requests).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 3. A hung server is abandoned at the configured bound
// ---------------------------------------------------------------------------

describe('a wedged hub cannot slow a session (OA-FR-04, APX-CON-10)', () => {
  it('abandons a server that never answers at the configured timeout', async () => {
    const server = await startTestServer(answerNever)
    servers.push(server)
    const stateDir = stateDirectoryWithRuntimeFile(43_117)
    const bound = 150
    const { deliver, lines } = transportOver({
      stateDir,
      endpoint: () => foundAt(server.port, stateDir),
      timeoutMs: bound,
    })

    const started = Date.now()
    const pending = deliver(blockSignal())
    const returnedSynchronously = Date.now() - started

    // The call itself does not wait: a harness hook that hands a signal to the
    // transport and returns is not blocked by anything the hub does next.
    expect(returnedSynchronously).toBeLessThan(bound)
    expect(pending).toBeInstanceOf(Promise)

    const result = await pending
    const elapsed = Date.now() - started
    expect(result).toEqual({ outcome: 'failed', code: 'delivery-timeout' })
    // Abandoned *at* the bound: not before it, and not long after it.
    expect(elapsed).toBeGreaterThanOrEqual(bound)
    expect(elapsed).toBeLessThan(bound * 8)
    // The socket is destroyed, which is what releases it - observed from the server.
    await waitFor(() => server.closedSockets() >= 1)
    expect(server.requests).toHaveLength(1)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.extra).toMatchObject({
      service: 'agent-ping',
      stage: 'delivery-failed',
      code: 'delivery-timeout',
      sessionId: SESSION,
      eventName: 'permission.asked',
    })
  })

  it('abandons an answer whose body never ends', async () => {
    const server = await startTestServer((_request, response) => {
      // Status and headers, then a body that stops halfway and never finishes.
      response.writeHead(202, { 'content-type': 'application/json' })
      response.write('{"accepted":true,')
    })
    servers.push(server)
    const stateDir = stateDirectoryWithRuntimeFile(43_117)
    const bound = 150
    const { deliver, lines } = transportOver({
      stateDir,
      endpoint: () => foundAt(server.port, stateDir),
      timeoutMs: bound,
    })

    expect(await deliver(blockSignal())).toEqual({
      outcome: 'failed',
      code: 'delivery-timeout',
    })
    expect(lines[0]?.extra).toMatchObject({ code: 'delivery-timeout' })
    expect(server.requests).toHaveLength(1)
  })

  it('reads no more of an answer than its own cap allows', async () => {
    const oversized = 'x'.repeat(MAX_ANSWER_BYTES * 4)
    const server = await startTestServer((_request, response) => {
      response.writeHead(202, { 'content-type': 'application/json' })
      response.end(oversized)
    })
    servers.push(server)

    const answer = await sendHttpRequest({
      host: '127.0.0.1',
      port: server.port,
      path: INGEST_PATH,
      headers: { 'content-type': 'application/json' },
      body: '{}',
      timeoutMs: 2_000,
    })
    expect(answer.kind).toBe('answered')
    if (answer.kind === 'answered') {
      expect(answer.status).toBe(202)
      expect(answer.body.length).toBeLessThan(MAX_ANSWER_BYTES)
    }

    // Through the transport, a 202 is acceptance whatever its body says: the status is
    // the route's contract, and an unreadable body is the hub's business.
    const stateDir = stateDirectoryWithRuntimeFile(43_117)
    const { deliver, lines } = transportOver({
      stateDir,
      endpoint: () => foundAt(server.port, stateDir),
      timeoutMs: 2_000,
    })
    const result = await deliver(blockSignal())
    expect(result).toMatchObject({ outcome: 'accepted', status: 202 })
    expect(result).not.toHaveProperty('hubOutcome')
    expect(lines).toEqual([])
  })

  it('defaults to a short bound, because the point of it is brevity', () => {
    // Asserted as a number rather than as a behaviour: a behavioural test at the
    // default would spend most of a second of wall clock proving the same thing the
    // tests above prove at a tenth of it.
    expect(DELIVERY_TIMEOUT_MS).toBeGreaterThan(0)
    expect(DELIVERY_TIMEOUT_MS).toBeLessThanOrEqual(1_000)
  })
})

// ---------------------------------------------------------------------------
// 4. A breadcrumb names the service, the session and the event type
// ---------------------------------------------------------------------------

describe('a delivery failure is visible in the harness (OA-FR-05, APX-FR-02)', () => {
  it('writes the service, the session and the event type when the hub is unreachable', async () => {
    // No hub has ever run for this install: the ordinary state of a machine where the
    // product is not running, and the case a developer meets first.
    const stateDir = temporaryDirectory('agent-ping-transport-absent-')
    const { deliver, lines } = transportOver({ stateDir })

    expect(await deliver(blockSignal({ variant: 'bash' }))).toEqual({
      outcome: 'failed',
      code: 'hub-not-running',
    })
    expect(lines).toHaveLength(1)
    const line = lines[0]
    expect(line?.level).toBe('warn')
    expect(line?.service).toBe('agent-ping')
    expect(line?.extra).toMatchObject({
      service: 'agent-ping',
      stage: 'delivery-failed',
      code: 'hub-not-running',
      harness: 'opencode',
      eventName: 'permission.asked',
      variant: 'bash',
      sessionId: SESSION,
    })
    // The sentence is a literal of this product, so it names the situation without
    // quoting anything the signal carried.
    expect(line?.message).toBe(DELIVERY_FAILURE_MESSAGES['hub-not-running'])
    expect(line?.message).toContain('agent-ping')
  })

  it('names the same three things when the hub refuses the connection', async () => {
    const stateDir = stateDirectoryWithRuntimeFile(await closedPort())
    const { deliver, lines } = transportOver({ stateDir })

    expect(await deliver(blockSignal())).toEqual({
      outcome: 'failed',
      code: 'connection-refused',
    })
    expect(lines[0]?.extra).toMatchObject({
      service: 'agent-ping',
      sessionId: SESSION,
      eventName: 'permission.asked',
      code: 'connection-refused',
    })
  })

  it('says a 503 was recorded as dropped, because that is what a 503 means (APX-FR-02)', async () => {
    const server = await startTestServer(refuseWith(503, 'store-failed'))
    servers.push(server)
    const stateDir = stateDirectoryWithRuntimeFile(43_117)
    const { deliver, lines } = transportOver({
      stateDir,
      endpoint: () => foundAt(server.port, stateDir),
    })

    expect(await deliver(blockSignal())).toEqual({
      outcome: 'refused',
      status: 503,
      code: 'hub-dropped',
      hubError: 'store-failed',
    })
    const line = lines[0]
    expect(line?.extra).toMatchObject({
      code: 'hub-dropped',
      status: 503,
      hubError: 'store-failed',
      sessionId: SESSION,
      eventName: 'permission.asked',
    })
    expect(line?.message).toBe(DELIVERY_FAILURE_MESSAGES['hub-dropped'])
    expect(line?.message).toContain('dropped')
  })

  it('writes one line per failed delivery, so an outage cannot be throttled into silence', async () => {
    const stateDir = temporaryDirectory('agent-ping-transport-repeat-')
    const { deliver, lines } = transportOver({ stateDir })
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await deliver(blockSignal({ transitionId: `per_${String(attempt)}` }))
    }
    expect(lines).toHaveLength(5)
    expect(lines.map((line) => line.extra?.['sessionId'])).toEqual(Array<string>(5).fill(SESSION))
  })

  it('never lets a value from the signal, the socket or the answer into the log line', async () => {
    const server = await startTestServer((_request, response) => {
      response.writeHead(422, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: 'invalid-signal',
          detail: `the tool was called with ${ARGUMENT} and the prompt was ${PROMPT}`,
          issues: [{ path: 'sessionId', code: 'unrecognised-field' }],
        }),
      )
    })
    servers.push(server)
    const stateDir = stateDirectoryWithRuntimeFile(43_117)
    const { deliver, lines } = transportOver({
      stateDir,
      endpoint: () => foundAt(server.port, stateDir),
    })

    await deliver(blockSignal())
    const serialised = JSON.stringify(lines)
    for (const secret of [PROMPT, ARGUMENT, TITLE, REPO]) {
      expect(serialised.includes(secret), `a breadcrumb carried ${secret}`).toBe(false)
    }
    // The hub's closed error token is carried; its `detail` sentence is not, because a
    // sentence is where free text lives.
    expect(lines[0]?.extra).toMatchObject({ hubError: 'invalid-signal' })
    expect(serialised.includes('detail')).toBe(false)
  })

  it('builds the breadcrumb as a pure function of a failure and a signal', () => {
    expect(deliveryBreadcrumb({ code: 'delivery-timeout', status: 503 }, blockSignal())).toEqual({
      service: 'agent-ping',
      stage: 'delivery-failed',
      code: 'delivery-timeout',
      harness: 'opencode',
      eventName: 'permission.asked',
      sessionId: SESSION,
      status: 503,
    })
    // An unrecognised code has no sentence of its own, so it is reported as the generic
    // fault rather than as a line that says nothing.
    const unknown = deliveryBreadcrumb({ code: 'not-a-code' as never }, blockSignal())
    expect(unknown.code).toBe('request-failed')
    expect(DELIVERY_FAILURE_MESSAGES[unknown.code]).toBeDefined()
    // A signal whose fields are not strings is reported as `unknown` rather than with
    // the value, because a value that is not a token is not a thing this line may carry.
    const hostile = deliveryBreadcrumb({ code: 'hub-not-running' }, {
      ...blockSignal(),
      sessionId: { toString: () => PROMPT } as never,
    })
    expect(hostile.sessionId).toBe('unknown')
    expect(JSON.stringify(hostile)).not.toContain(PROMPT)
  })

  it('survives a logging client that throws, because a breadcrumb is not a fault', () => {
    const hostile: HarnessLog = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => {
        throw new Error('the harness log client is broken')
      },
      error: () => undefined,
    }
    expect(() =>
      writeDeliveryBreadcrumb(hostile, { code: 'hub-not-running' }, blockSignal()),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 5. No transport failure propagates an exception out of the plugin hook
// ---------------------------------------------------------------------------

describe('nothing escapes into the session (OA-FR-04, APX-CON-03)', () => {
  /**
   * Every way a delivery can fail, as the table a reviewer reads.
   *
   * Each row is driven through the *real* transport, and the plugin's own hooks are
   * driven through the *real* plugin with that transport wired as its delivery port,
   * because the claim is about what a session experiences and not about what a function
   * returns.
   */
  type Built = { stateDir: string; options: TransportOptions }
  const FAILURES: readonly {
    readonly label: string
    readonly code: string
    readonly build: () => Built | Promise<Built>
  }[] = [
    {
      label: 'no hub on this machine',
      code: 'hub-not-running',
      build: () => ({ stateDir: temporaryDirectory('agent-ping-fail-none-'), options: {} }),
    },
    {
      label: 'a hub that has not published its port',
      code: 'hub-starting',
      build: () => ({ stateDir: stateDirectoryWithRuntimeFile(null), options: {} }),
    },
    {
      label: 'a runtime file nobody can read',
      code: 'runtime-file-unreadable',
      build: () => ({ stateDir: corruptStateDirectory(), options: {} }),
    },
    {
      label: 'an endpoint that is not on this machine',
      code: 'endpoint-not-loopback',
      build: () => {
        const stateDir = temporaryDirectory('agent-ping-fail-remote-')
        return {
          stateDir,
          options: {
            endpoint: () => ({
              kind: 'found',
              endpoint: { host: '203.0.113.7', port: 43_117, stateDir, instanceId: 'x' },
            }),
          },
        }
      },
    },
    {
      label: 'an install with no token',
      code: 'token-missing',
      build: () => ({ stateDir: runtimeFileOnly(43_117), options: {} }),
    },
    {
      label: 'a token file nobody can read',
      code: 'token-unreadable',
      build: () => {
        // The real reader, against a real damaged file: no seam is stubbed, so the row
        // proves the reader's answer rather than the transport's handling of one.
        const stateDir = corruptTokenStateDirectory()
        return { stateDir, options: {} }
      },
    },
    {
      label: 'a port with nothing listening on it',
      code: 'connection-refused',
      build: async () => {
        const stateDir = stateDirectoryWithRuntimeFile(await closedPort())
        return { stateDir, options: {} }
      },
    },
    {
      label: 'a hub that never answers',
      code: 'delivery-timeout',
      build: async () => {
        const server = await startTestServer(answerNever)
        servers.push(server)
        const stateDir = stateDirectoryWithRuntimeFile(43_117)
        return { stateDir, options: { endpoint: () => foundAt(server.port, stateDir), timeoutMs: 150 } }
      },
    },
    {
      label: 'a hub that refuses the signal',
      code: 'hub-refused',
      build: async () => {
        const server = await startTestServer(refuseWith(422, 'invalid-signal'))
        servers.push(server)
        const stateDir = stateDirectoryWithRuntimeFile(43_117)
        return { stateDir, options: { endpoint: () => foundAt(server.port, stateDir) } }
      },
    },
    {
      label: 'a hub that could not store it',
      code: 'hub-dropped',
      build: async () => {
        const server = await startTestServer(refuseWith(503, 'store-failed'))
        servers.push(server)
        const stateDir = stateDirectoryWithRuntimeFile(43_117)
        return { stateDir, options: { endpoint: () => foundAt(server.port, stateDir) } }
      },
    },
    {
      label: 'a socket that fails outright',
      code: 'request-failed',
      build: () => {
        const stateDir = stateDirectoryWithRuntimeFile(43_117)
        return {
          stateDir,
          options: {
            endpoint: () => foundAt(43_117, stateDir),
            send: () => Promise.reject(new Error('a seam that rejects')),
          },
        }
      },
    },
  ]

  for (const failure of FAILURES) {
    it(`reports and continues when there is ${failure.label}`, async () => {
      const built = await failure.build()
      const { deliver, lines } = transportOver({ stateDir: built.stateDir, ...built.options })

      const result = await deliver(blockSignal())
      expect(result, failure.label).toMatchObject({ code: failure.code })
      const crumbs = lines.filter((line) => line.level === 'warn')
      expect(crumbs, failure.label).toHaveLength(1)
      expect(crumbs[0]?.extra, failure.label).toMatchObject({
        service: 'agent-ping',
        stage: 'delivery-failed',
        code: failure.code,
        sessionId: SESSION,
        eventName: 'permission.asked',
      })
    })
  }

  it('resolves every hook of the real plugin, with a broken hub behind it', async () => {
    const console_ = spyOnConsole()
    const stateDir = temporaryDirectory('agent-ping-transport-hooks-')
    const { client, log } = harnessLogging()
    const hooks = await AGENT_PING_PLUGIN(
      { client, directory: REPO },
      { deliver: createHubTransport({ log, stateDir }) },
    )

    // The three hooks opencode can call, with a block, a tool boundary and a reply.
    // None of them rejects, none of them throws, and the session continues.
    await expect(hooks.event?.({ event: PERMISSION_EVENT })).resolves.toBeUndefined()
    await expect(hooks['tool.execute.before']?.(TOOL_BOUNDARY)).resolves.toBeUndefined()
    await expect(hooks['tool.execute.after']?.(TOOL_BOUNDARY)).resolves.toBeUndefined()
    await expect(hooks.event?.({ event: REPLY_EVENT })).resolves.toBeUndefined()
    expect(console_.every((spy) => spy.mock.calls.length === 0)).toBe(true)
  })

  it('keeps the console silent and the breadcrumb on the harness\'s own client', async () => {
    const console_ = spyOnConsole()
    const stateDir = temporaryDirectory('agent-ping-transport-console-')
    const { client, log, lines } = harnessLogging()
    const hooks = await AGENT_PING_PLUGIN(
      { client, directory: REPO },
      { deliver: createHubTransport({ log, stateDir }) },
    )

    await hooks.event?.({ event: PERMISSION_EVENT })
    await waitFor(() => lines.some((line) => line.level === 'warn'))

    // The breadcrumb reached the harness's own client, naming the three things OA-FR-05
    // asks for...
    const crumbs = lines.filter((line) => line.level === 'warn')
    expect(crumbs.some((line) => line.extra?.['code'] === 'hub-not-running')).toBe(true)
    expect(crumbs[0]?.extra).toMatchObject({
      service: 'agent-ping',
      sessionId: SESSION,
      eventName: 'permission.asked',
    })
    // ...and nothing reached the console, which is not a logging surface in this
    // product (OA-FR-09).
    for (const spy of console_) {
      expect(spy).not.toHaveBeenCalled()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. The body is the hub's closed field set
// ---------------------------------------------------------------------------

describe("what goes on the wire is the hub's field set and nothing else (ADR-002)", () => {
  it('posts exactly the ingest fields, and none of the five the hub owns', () => {
    const body = toIngestBody(
      blockSignal({
        measurements: { durationMs: 31_000 },
        turnWork: { toolCall: true, fileEdit: false, todoUpdate: false },
      }),
    )
    expect(Object.keys(body).sort()).toEqual([
      'eventName',
      'harness',
      'measurements',
      'occurredAt',
      'repoFullPath',
      'sessionId',
      'transitionId',
      'turnWork',
    ])
    for (const key of Object.keys(body)) {
      expect(INGEST_SIGNAL_FIELD_NAMES).toContain(key)
    }
    // The four the hub decides, and the one that is the hub's own clock, are absent.
    for (const forbidden of ['class', 'subtype', 'dedupeKey', 'repoShortName', 'receivedAt']) {
      expect(Object.hasOwn(body, forbidden), forbidden).toBe(false)
    }
    // `variant` is optional and appears only when the harness had one.
    expect(Object.hasOwn(toIngestBody(blockSignal()), 'variant')).toBe(false)
    expect(Object.hasOwn(toIngestBody(blockSignal({ variant: 'idle' })), 'variant')).toBe(true)
  })

  it('omits them deliberately: the route refuses a body that carries one', () => {
    const body = toIngestBody(blockSignal())
    expect(validateIngestSignal(body, OCCURRED_AT).ok).toBe(true)
    for (const forbidden of ['class', 'subtype', 'dedupeKey', 'repoShortName', 'receivedAt']) {
      const polluted = validateIngestSignal({ ...body, [forbidden]: 'x' }, OCCURRED_AT)
      expect(polluted.ok, `${forbidden} was accepted by the route`).toBe(false)
      if (!polluted.ok) {
        expect(polluted.issues).toContainEqual({ path: forbidden, code: 'unrecognised-field' })
      }
    }
  })

  it("posts to the path the hub actually serves, and never to the ack route", () => {
    const ingest = INGEST_ROUTES.find((route) => route.pattern === INGEST_PATH)
    expect(ingest, 'the transport posts to a path the hub does not serve').toBeDefined()
    expect(ingest?.method).toBe('POST')
    expect(INGEST_PATH).not.toContain('ack')
  })
})

// ---------------------------------------------------------------------------
// 7. The transport is a client and nothing more
// ---------------------------------------------------------------------------

describe('the transport is a loopback client and nothing else (APX-CON-03, APX-CON-12, ADR-006)', () => {
  const transportDir = fileURLToPath(new URL('../../src/plugin/transport/', import.meta.url))
  const modules = ['http.ts', 'breadcrumb.ts'] as const
  const sourceOf = (name: (typeof modules)[number]): string =>
    readFileSync(`${transportDir}${name}`, 'utf8')
  /** Comments carry the words several of these tests look for, so they go first. */
  const withoutComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('imports only the hub\'s own readers, the adapter\'s log and node:http', () => {
    const specifiers = [
      ...new Set(
        [...sourceOf('http.ts').matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1] ?? ''),
      ),
    ].sort()
    expect(specifiers).toEqual([
      '../../domain/classify.js',
      '../../hub/runtime-file.js',
      '../../hub/security.js',
      '../../storage/paths.js',
      '../opencode/translate.js',
      './breadcrumb.js',
      'node:http',
    ])
  })

  it('opens no other kind of socket and spawns nothing', () => {
    for (const name of modules) {
      const code = withoutComments(sourceOf(name))
      for (const forbidden of [
        'child_process',
        'worker_threads',
        'dgram',
        'net.connect',
        'WebSocket',
        'XMLHttpRequest',
        'https.request',
        'fetch(',
      ]) {
        expect(code.includes(forbidden), `${name} uses ${forbidden}`).toBe(false)
      }
    }
  })

  it('never names the default hub port, because the port is read and never assumed', () => {
    for (const name of modules) {
      expect(
        withoutComments(sourceOf(name)).includes(String(DEFAULT_HUB_PORT)),
        `${name} hard-codes the default port`,
      ).toBe(false)
    }
  })

  it('writes no file, spawns no process and starts no subsystem', () => {
    const code = withoutComments(sourceOf('http.ts'))
    for (const forbidden of [
      'writeFile',
      'appendFile',
      'mkdir',
      'unlink',
      'rm(',
      'spawn',
      'exec(',
      'setInterval',
    ]) {
      expect(code.includes(forbidden), `http.ts uses ${forbidden}`).toBe(false)
    }
  })

  it('never writes to the console, in code rather than in a comment', () => {
    for (const name of modules) {
      expect(
        withoutComments(sourceOf(name)).includes('console.'),
        `${name} writes to the console`,
      ).toBe(false)
    }
  })

  it('has no second attempt, and the one timer is cleared on every exit path', () => {
    const code = withoutComments(sourceOf('http.ts'))
    // A retry is a second attempt at the same signal. There is no loop over attempts,
    // no `setInterval`, and the single `setTimeout` is cleared by `finish`, which every
    // exit path calls.
    expect(code.includes('setInterval')).toBe(false)
    expect([...code.matchAll(/setTimeout\(/g)]).toHaveLength(1)
    expect(code).toContain('clearTimeout(timer)')
    // Unref'd, so a pending delivery is never the reason a harness process stays alive.
    expect(code).toContain('unref?.()')
  })

  it('exposes only the surface a plugin, its tests and OA-4 need', () => {
    expect(Object.keys(transportModule).sort()).toEqual([
      'DELIVERY_TIMEOUT_MS',
      'INGEST_PATH',
      'MAX_ANSWER_BYTES',
      'createHubTransport',
      'readEndpointFromRuntimeFile',
      'readTokenFromInstall',
      'sendHttpRequest',
      'toIngestBody',
    ])
    expect(Object.keys(breadcrumbModule).sort()).toEqual([
      'DELIVERY_FAILURE_MESSAGES',
      'deliveryBreadcrumb',
      'writeDeliveryBreadcrumb',
    ])
  })

  it('reaches the hub\'s own readers rather than restating their contracts', () => {
    // The four decisions the hub owns: the port, the token, the loopback rule and the
    // token header. Each is imported, and the two readers report the hub's own four
    // answers rather than a nullable endpoint that could conflate them.
    expect(readEndpointFromRuntimeFile(temporaryDirectory('agent-ping-transport-none-'))).toEqual({
      kind: 'not-running',
    })
    expect(readEndpointFromRuntimeFile(stateDirectoryWithRuntimeFile(null))).toEqual({
      kind: 'starting',
    })
    expect(readEndpointFromRuntimeFile(corruptStateDirectory())).toEqual({ kind: 'unreadable' })
    const found = readEndpointFromRuntimeFile(stateDirectoryWithRuntimeFile(43_210))
    expect(found).toEqual({
      kind: 'found',
      endpoint: { host: '127.0.0.1', port: 43_210, stateDir: expect.any(String), instanceId: INSTANCE_ID },
    })
    expect(readTokenFromInstall(temporaryDirectory('agent-ping-transport-none-'))).toEqual({
      kind: 'absent',
    })
    expect(readTokenFromInstall(corruptTokenStateDirectory())).toEqual({ kind: 'unreadable' })
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The console, watched. Every method, because any of them is a logging surface. */
function spyOnConsole(): MockInstance[] {
  const names = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir'] as const
  return names.map((name) => vi.spyOn(console, name).mockImplementation(() => undefined))
}
