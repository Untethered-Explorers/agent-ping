// The security boundary: the address check, the per-install write token, and the
// response headers (HC-4, HC-FR-06, APX-CON-01, APX-CON-08).
//
//   npm test -- tests/hub/security.test.ts
//
// The acceptance criteria, and where each is proven:
//
//   1. A test enumerates every registered route and asserts the ack route is the only
//      one that changes stored state. That walk is in tests/hub/ack.test.ts, against the
//      log; here the same registry is walked for the two things a log diff cannot show:
//      that no route's *declaration* is a mutation other than the two known ones, and
//      that no route's name, path or method is shaped like a control over a harness.
//   2. The not-found and conflict answers are the ack route's, and are proven in
//      tests/hub/ack.test.ts.
//   3. A write without the shared token and a request from a non-loopback address are
//      both refused. Both are here, each proven twice: the token check as a pure
//      function over every way a client can present one, and over real sockets against
//      a hub started by the real entry point; the address check as a pure predicate over
//      every form a loopback address arrives in, and through the *real* listener with a
//      socket whose peer is a LAN address - which is the only way a machine with only
//      loopback can present a non-loopback caller.
//   4. The dashboard response carries a strict content-security-policy and no permissive
//      cross-origin header. Asserted on the real page, and then on every other route's
//      real response, because "no cross-origin header" is an absence and an absence is
//      invisible until it is looked for everywhere.
//
// Around those, the properties that make the boundary a boundary:
//   - The token is one random value per install, in an owner-only file, read-or-created
//     and never rotated behind a client's back. A token file this build cannot read is a
//     refusal to start, not a silent regeneration (PRD 16 Open Question 9).
//   - The comparison is constant-time and the refusal never carries a value, so a body
//     cannot leak a secret somebody got nearly right.
//   - Read routes need no token, and the append needs no token: an append is not a
//     control surface (ADR-002), and a harness adapter that had to hold the write
//     capability to report what it observed would be a worse design.
//   - The token is in no response body, no response header, no served asset and no log
//     line. The dashboard must not be able to read it, or the write boundary would be
//     "any script on the loopback origin" (see the project's own security skill).

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { request, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startHub, type RunningHub } from '@/main/index'
import { openCounters, type Counters } from '@/storage/counters'
import { openEventStore, type EventStore, type NewEvent } from '@/storage/eventStore'
import { createPendingLifecycle } from '@/domain/pending'
import { createIngestService } from '@/hub/ingest-service'
import { createChangeFeed, type ChangeFeed } from '@/hub/sse'
import {
  authoriseWriteToken,
  createHubSecurity,
  crossOriginHeadersPresent,
  DASHBOARD_CSP,
  ensureWriteToken,
  isLoopbackAddress,
  presentedWriteToken,
  readWriteToken,
  tokensMatch,
  writeTokenFilePath,
  CROSS_ORIGIN_HEADERS,
  WRITE_TOKEN_BYTES,
  WRITE_TOKEN_FILE_NAME,
  WRITE_TOKEN_HEADER,
  WriteTokenError,
  type HeaderBag,
} from '@/hub/security'
import { ACK_ROUTES } from '@/hub/routes/ack'
import { RUNTIME_FILE_NAME } from '@/hub/runtime-file'
import { INGEST_ROUTES } from '@/hub/routes/ingest'
import { READ_ROUTES } from '@/hub/routes/read'
import {
  createRequestListener,
  MUTATING_ROUTE,
  RouteRegistry,
  type HttpMethod,
} from '@/hub/server'
import type { HubServices } from '@/hub/routes/read'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION = 'ses_security_01'

const temporaryDirectories: string[] = []
const openHubs: RunningHub[] = []
const openStores: EventStore[] = []
const openCountersList: Counters[] = []
const openFeeds: ChangeFeed[] = []

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  for (const hub of openHubs.splice(0)) {
    await hub.close().catch(() => undefined)
  }
  for (const store of openStores.splice(0)) store.close()
  for (const counters of openCountersList.splice(0)) counters.close()
  for (const feed of openFeeds.splice(0)) feed.close()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * A stand-in for the built dashboard.
 *
 * The page's headers are the point of half this file, so the page has to exist. The
 * layout is the one Vite produces: an index and a hashed asset.
 */
function dashboardFixture(): string {
  const root = temporaryDirectory('agent-ping-dashboard-')
  mkdirSync(path.join(root, 'assets'), { recursive: true })
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>agent-ping</title>\n')
  writeFileSync(path.join(root, 'assets', 'index-abc123.js'), 'console.log("dashboard")\n')
  return root
}

async function startFixtureHub(
  options: Partial<Parameters<typeof startHub>[0]> = {},
): Promise<RunningHub> {
  const hub = await startHub({
    stateDir: temporaryDirectory('agent-ping-state-'),
    dashboardRoot: dashboardFixture(),
    ...options,
  })
  openHubs.push(hub)
  return hub
}

function observer(hub: RunningHub): EventStore {
  const store = openEventStore({ filePath: hub.databaseFilePath })
  openStores.push(store)
  return store
}

function blockEvent(overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    harness: 'opencode',
    sessionId: SESSION,
    repoShortName: 'agent-ping',
    repoFullPath: '/home/dev/Projects/agent-ping',
    rawEventType: 'permission.asked',
    class: 'needs-you',
    subtype: null,
    occurredAt: '2026-09-26T09:00:00.000Z',
    receivedAt: '2026-09-26T09:00:00.100Z',
    dedupeKey: 'opencode:ses_security_01:block-1',
    ...overrides,
  }
}

interface Fetched {
  readonly status: number
  readonly text: string
  readonly headers: HeaderBag
  json<T = unknown>(): T
}

interface CallInit {
  readonly method?: string
  readonly pathname?: string
  readonly body?: string
  /** `HeaderBag`, because the token table is what the pure predicate is driven with. */
  readonly headers?: HeaderBag
}

function call(origin: string, init: CallInit = {}): Promise<Fetched> {
  const { hostname, port } = new URL(origin)
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: hostname,
        port,
        path: init.pathname ?? '/',
        method: init.method ?? 'GET',
        headers: {
          ...(init.body === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(init.body)),
              }),
          ...init.headers,
        },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: response.statusCode ?? 0,
            text,
            headers: response.headers as HeaderBag,
            json: <T,>(): T => JSON.parse(text) as T,
          })
        })
      },
    )
    outgoing.on('error', reject)
    if (init.body === undefined) outgoing.end()
    else outgoing.end(init.body)
  })
}

/** The open stream, read once and closed: a response that never ends cannot be awaited. */
function openStreamAndReadHeaders(hub: RunningHub): Promise<{ status: number; headers: HeaderBag }> {
  const { hostname, port } = new URL(hub.origin)
  return new Promise((resolve, reject) => {
    let settled = false
    const outgoing = request(
      { host: hostname, port, path: '/api/stream', method: 'GET', agent: false },
      (response) => {
        settled = true
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers as HeaderBag,
        })
        outgoing.destroy()
      },
    )
    outgoing.on('error', (cause: Error) => {
      if (settled) return
      reject(cause)
    })
    outgoing.end()
  })
}

function tokenFor(hub: RunningHub): string {
  const token = readWriteToken(hub.stateDir)
  if (token === null) throw new Error('the fixture hub published no write token')
  return token
}

// ---------------------------------------------------------------------------
// The address predicate
// ---------------------------------------------------------------------------

describe('the loopback predicate (APX-CON-01)', () => {
  it('accepts every form a loopback address arrives in, and nothing else', () => {
    // The value forms one loopback address actually arrives in. Refusing
    // ::ffff:127.0.0.1 would break the product on a default dual-stack socket, which is
    // the mistake this table exists to prevent.
    for (const loopback of ['127.0.0.1', '127.0.0.53', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', ' 127.0.0.1 ']) {
      expect(isLoopbackAddress(loopback), loopback).toBe(true)
    }
    for (const other of [
      '0.0.0.0',
      '::',
      '::ffff:10.0.0.5',
      '10.0.0.5',
      '192.168.1.20',
      '172.16.0.1',
      // A name rather than an address: the dotted quad is four bounded decimal parts
      // and nothing may follow them.
      '127.0.0.1.evil.example',
      '127.0.0.256',
      // A peer that does not exist, and a socket with no peer at all.
      '',
      '   ',
      undefined,
      null,
    ]) {
      expect(isLoopbackAddress(other), String(other)).toBe(false)
    }
  })

  it('binds 127.0.0.1 and nothing wider', async () => {
    const hub = await startFixtureHub()
    // Read back from the socket rather than from the option that asked for it: this is
    // what the operating system was told.
    const address = hub.server.nodeServer.address() as AddressInfo
    expect(address.address).toBe('127.0.0.1')
    expect(address.family).toBe('IPv4')
    expect(hub.origin).toBe(`http://127.0.0.1:${address.port}`)
    // And the published port is unreachable from every non-loopback address this machine
    // has. On a machine with only loopback there is nothing to enumerate, and the
    // assertion is that the bound address is the only interface claimed.
    for (const other of nonLoopbackAddresses()) {
      expect(await canConnect(other, address.port), `${other}:${address.port}`).toBe(false)
    }
  })

  it('refuses a non-loopback caller before routing, even with the right token', () => {
    // The real listener, the real registry, the real ack route and a real log - driven
    // with a socket whose peer is a LAN address. What is asserted is the ordering: the
    // refusal happens before any handler, so a peer that reached loopback through a
    // proxy or a container port mapping cannot read, write or reach anything, and the
    // correct token does not help it.
    const stateDir = temporaryDirectory('agent-ping-state-')
    const store = openEventStore({ filePath: path.join(stateDir, 'observer.db') })
    openStores.push(store)
    const block = store.insertEvent(blockEvent())
    const pendingBefore = store.readPending().length

    const counters = openCounters({ filePath: path.join(stateDir, 'observer.db') })
    openCountersList.push(counters)
    const feed = createChangeFeed({ heartbeatIntervalMs: 0 })
    openFeeds.push(feed)
    const ingest = createIngestService({ store })
    const security = createHubSecurity({ stateDir })

    const registry = new RouteRegistry<HubServices>()
    registry.registerAll(READ_ROUTES)
    registry.registerAll(INGEST_ROUTES)
    registry.registerAll(ACK_ROUTES)
    const services: HubServices = {
      store,
      counters,
      stream: feed,
      ingest,
      pending: createPendingLifecycle(store),
      security,
      hub: {
        instanceId: 'synthetic',
        pid: process.pid,
        host: '127.0.0.1',
        port: 0,
        origin: '',
        startedAt: '2026-09-26T09:00:00.000Z',
        schemaVersion: store.schemaVersion,
        rebuiltFromMigrations: false,
        dashboardRoot: null,
        servedRequests: () => 0,
      },
    }
    const listener = createRequestListener<HubServices>({
      registry,
      services: () => services,
      dashboard: { root: null },
    })

    // Every route that exists, asked for by a peer that is not this machine's user. The
    // read ones and the control surface alike: the boundary is not about the method.
    for (const [method, pathname] of [
      ['GET', '/api/pending'],
      ['GET', '/api/sessions'],
      ['GET', '/api/health'],
      ['GET', '/api/metrics'],
      ['GET', '/api/events'],
      ['POST', `/api/ack/${block.event.eventId}`],
      ['POST', '/api/ingest'],
    ] as const) {
      const chunks: string[] = []
      const response = fakeResponse(chunks)
      Object.assign(response.socket, { remoteAddress: '10.1.2.3' })
      // The right token, so the refusal cannot be mistaken for a missing one.
      const headers: Record<string, string> = { [WRITE_TOKEN_HEADER]: security.writeToken }
      listener(
        fakeRequest(method, pathname, response.socket, headers),
        response as unknown as ServerResponse,
      )
      expect(response.statusCode, `${method} ${pathname}`).toBe(403)
      const body = JSON.parse(chunks.join('')) as { error: string }
      expect(body.error).toBe('forbidden')
      // No echo of the address, and no echo of the token: this body is served to whoever
      // asked.
      expect(chunks.join('')).not.toContain('10.1.2.3')
      expect(chunks.join('')).not.toContain(security.writeToken)
    }

    // Nothing was read and nothing was written, through any of them.
    expect(store.readPending().length).toBe(pendingBefore)
    expect(store.readEventHistory({ limit: 10 })).toHaveLength(1)
    expect(store.readPending()[0]?.ackState).toBe('unacknowledged')
  })

  it('does not treat a forwarded address header as the caller', async () => {
    const hub = await startFixtureHub()
    const response = await call(hub.origin, {
      pathname: '/api/pending',
      headers: { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' },
    })
    // A loopback caller with a forwarded header is still a loopback caller: the header
    // is a claim, and the boundary reads the socket. Honouring it would reopen exactly
    // what the address check closes.
    expect(response.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// The token file
// ---------------------------------------------------------------------------

describe('the per-install write token (HC-FR-06)', () => {
  it('is one random value in an owner-only file beside the log', () => {
    const stateDir = temporaryDirectory('agent-ping-state-')

    const issued = ensureWriteToken({ stateDir })

    expect(issued.created).toBe(true)
    expect(issued.filePath).toBe(path.join(stateDir, WRITE_TOKEN_FILE_NAME))
    expect(issued.filePath).toBe(writeTokenFilePath(stateDir))
    // Thirty-two bytes of hex: fixed width, so the comparison is well defined and an
    // operator can transcribe it from a file.
    expect(issued.token).toMatch(new RegExp(`^[0-9a-f]{${WRITE_TOKEN_BYTES * 2}}$`))
    expect(issued.token).toHaveLength(WRITE_TOKEN_BYTES * 2)
    // The file is `0o600` inside a `0o700` directory. A world-readable token is not a
    // token, and this is the only moment it could be one.
    expect(statSync(issued.filePath).mode & 0o777).toBe(0o600)
    expect(statSync(stateDir).mode & 0o777).toBe(0o700)
    // Exactly one line, and reading it back gives the same value.
    expect(readFileSync(issued.filePath, 'utf8')).toBe(`${issued.token}\n`)
    expect(readWriteToken(stateDir)).toBe(issued.token)
    expect(ensureWriteToken({ stateDir })).toEqual({ ...issued, created: false })
  })

  it('issues a different value per install and survives a restart unchanged', async () => {
    const first = ensureWriteToken({ stateDir: temporaryDirectory('agent-ping-state-') })
    const second = ensureWriteToken({ stateDir: temporaryDirectory('agent-ping-state-') })
    // Per install, not per process: two machines' tokens have nothing to do with each
    // other, and a shared value would be a shared capability.
    expect(first.token).not.toBe(second.token)

    // A restarted hub keeps the install's token, because rotating it would silently
    // invalidate every client already holding the old one (PRD 16 Open Question 9).
    const stateDir = temporaryDirectory('agent-ping-state-')
    const hub = await startFixtureHub({ stateDir })
    const before = tokenFor(hub)
    await hub.close()
    openHubs.splice(openHubs.indexOf(hub), 1)

    const restarted = await startFixtureHub({ stateDir })
    expect(tokenFor(restarted)).toBe(before)
    expect(restarted.security.createdWriteToken).toBe(false)
  })

  it('refuses to start rather than silently reissuing a damaged token file', async () => {
    const stateDir = temporaryDirectory('agent-ping-state-')
    const target = writeTokenFilePath(stateDir)
    writeFileSync(target, 'not a token\n')

    const start = await startHub({ stateDir, dashboardRoot: null }).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    // A damaged file is not the same as no file: the first is a machine something has
    // interfered with and the second is a machine that has never installed this build.
    // Reissuing on the first would hand a capability nothing else holds.
    expect(start).toBeInstanceOf(WriteTokenError)
    expect((start as Error).message).toContain(WRITE_TOKEN_BYTES * 2)
    expect((start as Error).message).toContain('Delete the file')
    // And it did not get as far as publishing a hub: the refusal is a start failure, not
    // a hub whose writes are mysteriously refused. The database was opened first, so it
    // is there; the runtime file - the pointer and the lock - is not.
    expect(readdirSync(stateDir)).toContain(WRITE_TOKEN_FILE_NAME)
    expect(readdirSync(stateDir)).not.toContain(RUNTIME_FILE_NAME)
    expect(() => readWriteToken(stateDir)).toThrow(WriteTokenError)
  })

  it('rotates only when the file is removed, and the old value stops working', async () => {
    const hub = await startFixtureHub()
    const original = tokenFor(hub)
    const block = observer(hub).insertEvent(blockEvent())
    await call(hub.origin, {
      method: 'POST',
      pathname: `/api/ack/${block.event.eventId}`,
      headers: { [WRITE_TOKEN_HEADER]: original },
    })

    // The documented reset: remove the file, restart, and the install has a new token.
    rmSync(writeTokenFilePath(hub.stateDir))
    await hub.close()
    openHubs.splice(openHubs.indexOf(hub), 1)
    const restarted = await startFixtureHub({ stateDir: hub.stateDir })
    const rotated = tokenFor(restarted)
    expect(rotated).not.toBe(original)
    expect(restarted.security.createdWriteToken).toBe(true)

    // The old value is refused, which is the whole point of rotating.
    const block2 = observer(restarted).insertEvent(blockEvent({ dedupeKey: 'k2' }))
    expect(
      (
        await call(restarted.origin, {
          method: 'POST',
          pathname: `/api/ack/${block2.event.eventId}`,
          headers: { [WRITE_TOKEN_HEADER]: original },
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await call(restarted.origin, {
          method: 'POST',
          pathname: `/api/ack/${block2.event.eventId}`,
          headers: { [WRITE_TOKEN_HEADER]: rotated },
        })
      ).status,
    ).toBe(200)
  })

  it('is not in the runtime file an adapter reads', async () => {
    const hub = await startFixtureHub()
    // The runtime file is the pointer every client reads. The token is the difference
    // between "may read session metadata" and "may change it", so it is in its own file
    // and not in the one that gets read by anything that can see the state directory.
    const runtime = readFileSync(hub.runtimeFilePath, 'utf8')
    expect(runtime).not.toContain(tokenFor(hub))
    expect(JSON.parse(runtime)).not.toMatchObject({ token: expect.anything() })
    expect(readdirSync(hub.stateDir)).toContain(WRITE_TOKEN_FILE_NAME)
  })
})

// ---------------------------------------------------------------------------
// The token check, as a pure function
// ---------------------------------------------------------------------------

describe('the token check, as a pure function (HC-FR-06)', () => {
  const expected = 'a'.repeat(64)

  it('reads the header, and nothing else, as the token', () => {
    expect(presentedWriteToken({})).toEqual({ kind: 'absent' })
    expect(presentedWriteToken({ [WRITE_TOKEN_HEADER]: '' })).toEqual({ kind: 'absent' })
    expect(presentedWriteToken({ [WRITE_TOKEN_HEADER]: '   ' })).toEqual({ kind: 'absent' })
    // HTTP header names are case-insensitive, so a client that spelled it differently
    // sent the header this product asks for.
    expect(presentedWriteToken({ 'X-Agent-Ping-Token': expected })).toEqual({
      kind: 'present',
      value: expected,
    })
    // A padded value is a transport artefact, not a different token.
    expect(presentedWriteToken({ [WRITE_TOKEN_HEADER]: ` ${expected} ` })).toEqual({
      kind: 'present',
      value: expected,
    })
    // Two values for one header is a confused client or an attempt to have a proxy and
    // the hub disagree about which is authoritative. Neither is answered with a guess.
    expect(presentedWriteToken({ [WRITE_TOKEN_HEADER]: [expected, 'b'.repeat(64)] })).toEqual({
      kind: 'duplicated',
    })
    expect(presentedWriteToken({ [WRITE_TOKEN_HEADER]: [expected, '  '] })).toEqual({
      kind: 'present',
      value: expected,
    })
  })

  it('refuses every guess and accepts exactly the install\'s own value', () => {
    const cases: { readonly label: string; readonly headers: HeaderBag; readonly allowed: boolean }[] = [
      { label: 'no header', headers: {}, allowed: false },
      { label: 'empty', headers: { [WRITE_TOKEN_HEADER]: '' }, allowed: false },
      { label: 'wrong', headers: { [WRITE_TOKEN_HEADER]: 'b'.repeat(64) }, allowed: false },
      { label: 'a shared prefix', headers: { [WRITE_TOKEN_HEADER]: `${'a'.repeat(63)}b` }, allowed: false },
      { label: 'a shared suffix', headers: { [WRITE_TOKEN_HEADER]: `b${'a'.repeat(63)}` }, allowed: false },
      { label: 'one character off', headers: { [WRITE_TOKEN_HEADER]: `${'a'.repeat(63)}b` }, allowed: false },
      { label: 'shorter', headers: { [WRITE_TOKEN_HEADER]: 'a'.repeat(63) }, allowed: false },
      { label: 'longer', headers: { [WRITE_TOKEN_HEADER]: `${'a'.repeat(64)}a` }, allowed: false },
      { label: 'another case', headers: { [WRITE_TOKEN_HEADER]: 'A'.repeat(64) }, allowed: false },
      { label: 'duplicated', headers: { [WRITE_TOKEN_HEADER]: [expected, expected] }, allowed: false },
      { label: 'the value', headers: { [WRITE_TOKEN_HEADER]: expected }, allowed: true },
      { label: 'the value, padded', headers: { [WRITE_TOKEN_HEADER]: ` ${expected} ` }, allowed: true },
    ]
    for (const testCase of cases) {
      expect(authoriseWriteToken({ expected, headers: testCase.headers }).allowed, testCase.label).toBe(
        testCase.allowed,
      )
    }
  })

  it('answers a refusal with a code and a status, and carries no value', () => {
    const missing = authoriseWriteToken({ expected, headers: {} })
    expect(missing).toEqual({ allowed: false, code: 'token-missing', status: 401 })
    const duplicated = authoriseWriteToken({ expected, headers: { [WRITE_TOKEN_HEADER]: [expected, 'b'] } })
    expect(duplicated).toMatchObject({ allowed: false, code: 'token-duplicated' })
    const invalid = authoriseWriteToken({ expected, headers: { [WRITE_TOKEN_HEADER]: 'b'.repeat(64) } })
    expect(invalid).toMatchObject({ allowed: false, code: 'token-invalid' })
    // The verdict is a verdict: no expected value, no presented value, and no hint about
    // which of the two was closer. A body built from this cannot leak a secret.
    for (const decision of [missing, duplicated, invalid, authoriseWriteToken({ expected, headers: { [WRITE_TOKEN_HEADER]: expected } })]) {
      expect(Object.keys(decision).sort()).toEqual(
        decision.allowed ? ['allowed'] : ['allowed', 'code', 'status'],
      )
    }
    expect(JSON.stringify([missing, duplicated, invalid])).not.toContain(expected)
  })

  it('compares in constant time and refuses a mismatched length rather than throwing', () => {
    expect(tokensMatch(expected, expected)).toBe(true)
    expect(tokensMatch(expected, 'b'.repeat(64))).toBe(false)
    expect(tokensMatch(expected, 'a'.repeat(63))).toBe(false)
    expect(tokensMatch(expected, '')).toBe(false)
    // An install with no token must not accept the empty string, which is the one value
    // a caller can always produce.
    expect(tokensMatch('', '')).toBe(false)
    expect(authoriseWriteToken({ expected: '', headers: { [WRITE_TOKEN_HEADER]: '' } }).allowed).toBe(
      false,
    )
  })

  it('compares with the constant-time primitive, asserted at the source', () => {
    // Timing is not observable from a test: a constant-time comparison and a plain string
    // comparison return the same answers for every input, so no behavioural assertion can
    // tell them apart. The one place this claim can be held is the source of the
    // comparison itself, and this is the single source read in this file - a security
    // property that nothing checks is a property that gets refactored away.
    const source = readFileSync(new URL('../../src/hub/security.ts', import.meta.url), 'utf8')
    const start = source.indexOf('export function tokensMatch')
    const end = source.indexOf('\n}\n', start)
    expect(start, 'tokensMatch must exist').toBeGreaterThan(-1)
    expect(end, 'tokensMatch must be a closed function').toBeGreaterThan(start)
    const body = source.slice(start, end)
    expect(body).toContain('timingSafeEqual')
    expect(body).not.toMatch(/expected === presented|presented === expected/)
    // The length branch still runs a comparison, so a wrong length costs what a wrong
    // value of the right length costs.
    expect(body.match(/timingSafeEqual/g)).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// The boundary, over real sockets
// ---------------------------------------------------------------------------

describe('the boundary over real sockets (HC-FR-06)', () => {
  it('refuses a write with no token and a write with the wrong one, changing nothing', async () => {
    const hub = await startFixtureHub()
    const store = observer(hub)
    const block = store.insertEvent(blockEvent())
    const before = store.readPending()

    const attempts: readonly HeaderBag[] = [{}, { [WRITE_TOKEN_HEADER]: 'f'.repeat(64) }]
    for (const headers of attempts) {
      const response = await call(hub.origin, {
        method: 'POST',
        pathname: `/api/ack/${block.event.eventId}`,
        headers,
      })
      expect(response.status).toBe(401)
      expect(response.json<{ error: string }>().error).toBe('unauthorised')
    }

    expect(store.readPending()).toEqual(before)
    expect(store.readPending()[0]?.ackState).toBe('unacknowledged')
    // And the hub is still serving the read surface, which needs no token at all.
    expect((await call(hub.origin, { pathname: '/api/pending' })).status).toBe(200)
  })

  it('needs no token on a read route, or on the append', async () => {
    const hub = await startFixtureHub()
    // Read routes carry no content and the boundary exists to keep the port from being a
    // control surface, not to hide session metadata from the local user (HC-FR-06).
    for (const pathname of [
      '/api/sessions',
      '/api/pending',
      '/api/events',
      '/api/metrics',
      '/api/health',
      '/',
    ]) {
      expect((await call(hub.origin, { pathname })).status, pathname).toBe(200)
    }
    // The append needs no token either, and that is a design decision rather than an
    // oversight: it creates a row and changes nothing that already exists, it reaches no
    // session and no harness, and requiring a secret there would mean every harness
    // adapter had to hold the write capability to report what it observed (ADR-002).
    const posted = await call(hub.origin, {
      method: 'POST',
      pathname: '/api/ingest',
      body: JSON.stringify({
        harness: 'opencode',
        eventName: 'permission.asked',
        sessionId: SESSION,
        repoFullPath: '/home/dev/Projects/agent-ping',
        transitionId: 'block-9',
        occurredAt: '2026-09-26T09:00:00.000Z',
      }),
    })
    expect(posted.status).toBe(202)
    expect(posted.json<{ pendingCount: number }>().pendingCount).toBe(1)
  })

  it('puts the token in no response, no header, no served asset and no log line', async () => {
    const diagnostics: string[] = []
    const hub = await startFixtureHub({ onDiagnostic: (message) => diagnostics.push(message) })
    const store = observer(hub)
    const block = store.insertEvent(blockEvent())
    const token = tokenFor(hub)

    // Every route, plus both of the ack route's interesting answers, plus the served
    // assets: the token must be in none of them.
    const page = (label: string, fetched: Fetched): { label: string; body: string; headers: HeaderBag } => ({
      label,
      body: fetched.text,
      headers: fetched.headers,
    })
    const pages: { readonly label: string; readonly body: string; readonly headers: HeaderBag }[] = []
    for (const route of hub.registry.routes()) {
      if (route.pattern === '/api/stream') continue
      const pathname = route.pattern
        .replace(/:sessionId/g, SESSION)
        .replace(/:eventId/g, block.event.eventId)
      pages.push(
        page(`${route.method} ${route.pattern}`, await call(hub.origin, { method: route.method, pathname })),
      )
    }
    // The refused write, and the accepted one.
    pages.push(
      page(
        'ack without a token',
        await call(hub.origin, { method: 'POST', pathname: `/api/ack/${block.event.eventId}` }),
      ),
    )
    pages.push(
      page(
        'ack with the token',
        await call(hub.origin, {
          method: 'POST',
          pathname: `/api/ack/${block.event.eventId}`,
          headers: { [WRITE_TOKEN_HEADER]: token },
        }),
      ),
    )
    // The served dashboard, file by file. A token readable by the page is a token any
    // script on that origin can use, which weakens the write boundary to "any script on
    // the loopback origin".
    for (const file of ['/', '/assets/index-abc123.js']) {
      pages.push(page(`dashboard ${file}`, await call(hub.origin, { pathname: file })))
    }
    const stream = await openStreamAndReadHeaders(hub)
    pages.push({ label: 'stream', body: '', headers: stream.headers })

    for (const page of pages) {
      expect(page.body, page.label).not.toContain(token)
      expect(JSON.stringify(page.headers), page.label).not.toContain(token)
      expect(JSON.stringify(page.headers), page.label).not.toContain(WRITE_TOKEN_HEADER)
    }
    // The health payload an operator reads, and the diagnostic lines the hub writes.
    const health = await call(hub.origin, { pathname: '/api/health' })
    expect(health.text).not.toContain(token)
    expect(health.text).not.toContain(writeTokenFilePath(hub.stateDir))
    expect(diagnostics.join('\n')).not.toContain(token)
    // The token file's own name may appear in a diagnosis - a path is not a secret - but
    // its contents may not.
    expect(diagnostics.join('\n')).not.toMatch(new RegExp(`[0-9a-f]{${WRITE_TOKEN_BYTES * 2}}`))
  })
})

// ---------------------------------------------------------------------------
// The response headers
// ---------------------------------------------------------------------------

describe('the response headers (HC-FR-06)', () => {
  it('sends the dashboard a strict content-security-policy', async () => {
    const hub = await startFixtureHub()

    const page = await call(hub.origin, { pathname: '/' })

    expect(page.status).toBe(200)
    const csp = page.headers['content-security-policy'] ?? ''
    expect(csp).toBe(DASHBOARD_CSP)
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("object-src 'none'")
    // The negative assertions are the point: a policy that lost frame-ancestors in a
    // merge still contains default-src 'self'. A conflict with the PixiJS bundle is
    // resolved by narrowing the policy, never by weakening it.
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).not.toMatch(/unsafe-inline/)
    expect(csp).not.toMatch(/unsafe-eval/)
    expect(csp).not.toMatch(/\*/)
  })

  it('sends no cross-origin header on any route, including the refusals', async () => {
    const hub = await startFixtureHub()
    const store = observer(hub)
    const block = store.insertEvent(blockEvent())
    const token = { [WRITE_TOKEN_HEADER]: tokenFor(hub) }
    const answers: { readonly label: string; readonly headers: HeaderBag }[] = []

    for (const route of hub.registry.routes()) {
      // The stream is asked for once at the end, with a client that reads its headers and
      // then goes away: a response that never ends cannot be part of a loop.
      if (route.pattern === '/api/stream') continue
      const pathname = route.pattern
        .replace(/:sessionId/g, SESSION)
        .replace(/:eventId/g, block.event.eventId)
      answers.push({
        label: `${route.method} ${route.pattern}`,
        headers: (await call(hub.origin, { method: route.method, pathname })).headers,
      })
    }
    // The answers that matter most are the ones a cross-origin page would be refused by:
    // a 200 on a read, a 401 on the control surface, and a 404 for a path that is not
    // served. Any of them carrying `Access-Control-Allow-Origin` would be the hole.
    for (const [label, init] of [
      ['ack refused', { method: 'POST', pathname: `/api/ack/${block.event.eventId}` }],
      ['ack accepted', { method: 'POST', pathname: `/api/ack/${block.event.eventId}`, headers: token }],
      ['unknown path', { method: 'POST', pathname: '/api/steer', headers: token }],
      ['wrong method', { method: 'DELETE', pathname: '/api/pending' }],
    ] as const) {
      answers.push({ label, headers: (await call(hub.origin, init)).headers })
    }
    // The stream is the response that stays open the longest, so it is the one where a
    // permissive header would do the most damage: opened from any page the developer
    // visits, it would hand that page their whole session feed.
    answers.push({ label: 'stream', headers: (await openStreamAndReadHeaders(hub)).headers })

    for (const answer of answers) {
      expect(crossOriginHeadersPresent(answer.headers), answer.label).toEqual([])
    }
    // And the predicate itself is not vacuous: it names a header that is really there.
    expect(crossOriginHeadersPresent({ 'access-control-allow-origin': '*' })).toEqual([
      'access-control-allow-origin',
    ])
    expect(crossOriginHeadersPresent({ 'Access-Control-Allow-Credentials': 'true' })).toEqual([
      'access-control-allow-credentials',
    ])
    expect([...CROSS_ORIGIN_HEADERS]).toContain('access-control-expose-headers')
  })
})

// ---------------------------------------------------------------------------
// The route inventory
// ---------------------------------------------------------------------------

describe('the registered surface (APX-CON-08)', () => {
  it('declares exactly two mutations, and only one of them changes a record', async () => {
    const hub = await startFixtureHub()

    const routes = hub.registry.routes()
    const mutating = routes.filter((route) => route.mutation !== 'read-only')

    expect(mutating.map((route) => `${route.method} ${route.pattern}`)).toEqual([
      'POST /api/ingest',
      'POST /api/ack/:eventId',
    ])
    expect(mutating.map((route) => route.mutation)).toEqual(['ingest-append', 'ack-only'])
    // The control surface is one route, one signature, one declared mutation - and it is
    // the one the registry checks every `ack-only` registration against, so a second one
    // is a registration-time error rather than a review finding.
    expect(ACK_ROUTES).toHaveLength(1)
    expect(ACK_ROUTES[0]?.mutation).toBe('ack-only')
    expect(`${ACK_ROUTES[0]?.method} ${ACK_ROUTES[0]?.pattern}`).toBe(MUTATING_ROUTE)
    // Every other route is a read, and a read-only route is a GET.
    for (const route of routes.filter((entry) => entry.mutation === 'read-only')) {
      expect(route.method).toBe('GET')
    }
    // And the registry refuses the two shapes a second control surface would arrive in.
    const registry = new RouteRegistry<HubServices>()
    expect(() =>
      registry.register({
        method: 'POST',
        pattern: '/api/harness',
        name: 'read.harness',
        mutation: 'ack-only',
        handle: () => undefined,
      }),
    ).toThrow(/only mutating route/)
    expect(() =>
      registry.register({
        method: 'POST',
        pattern: '/api/events',
        name: 'read.append',
        mutation: 'ingest-append',
        handle: () => undefined,
      }),
    ).toThrow(/only appending route/)
    expect(() =>
      registry.register({
        method: 'PUT',
        pattern: '/api/pending',
        name: 'read.replace',
        mutation: 'read-only',
        handle: () => undefined,
      }),
    ).toThrow(/read-only/)
  })

  it('exposes no route that could spawn, steer, interrupt, prompt or approve anything', async () => {
    const hub = await startFixtureHub()

    // A promise about intent rather than about state, so it is asserted over the running
    // hub's own registration list rather than over a comment (APX-CON-08, HC-US-03).
    const forbidden = /spawn|steer|interrupt|prompt|approve|resume|kill|send|control|execute|input|keypress/i
    for (const route of hub.registry.routes()) {
      expect(`${route.method} ${route.pattern} ${route.name}`).not.toMatch(forbidden)
    }
    // The same check over the route lists themselves, so a route that is exported but not
    // yet registered is caught while it is being written.
    for (const route of [...READ_ROUTES, ...INGEST_ROUTES, ...ACK_ROUTES]) {
      expect(`${route.method} ${route.pattern} ${route.name}`).not.toMatch(forbidden)
    }
  })

  it('answers 405 for a mutating method on a read path, on every one of them', async () => {
    const hub = await startFixtureHub()
    const methods: readonly HttpMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE']

    for (const route of hub.registry.routes().filter((entry) => entry.mutation === 'read-only')) {
      for (const method of methods) {
        const response = await call(hub.origin, { method, pathname: route.pattern })
        // A mutating method on a read path is refused before any handler exists. The
        // dashboard's own fallback answers 404 for an unknown API path, so both are
        // acceptable and neither is a write.
        expect([404, 405], `${method} ${route.pattern} answered ${response.status}`).toContain(
          response.status,
        )
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Helpers used only by the assertions above
// ---------------------------------------------------------------------------

/** Every address this machine has that is not loopback. */
function nonLoopbackAddresses(): string[] {
  const addresses: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!isLoopbackAddress(entry.address)) addresses.push(entry.address)
    }
  }
  return addresses
}

async function canConnect(address: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: address, port })
    const finish = (reachable: boolean): void => {
      socket.destroy()
      resolve(reachable)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })
}

interface FakeResponse {
  statusCode: number
  headersSent: boolean
  socket: { remoteAddress?: string }
  setHeader(name: string, value: string): void
  end(payload?: string): void
}

function fakeResponse(chunks: string[]): FakeResponse {
  return {
    statusCode: 200,
    headersSent: false,
    socket: { remoteAddress: '127.0.0.1' },
    setHeader(): void {
      // The synthetic response records nothing: the assertions are about the status and
      // the body, not about a header table a mock invented.
    },
    end(payload = ''): void {
      this.headersSent = true
      chunks.push(payload)
    },
  }
}

function fakeRequest(
  method: string,
  url: string,
  socket: { remoteAddress?: string },
  headers: Record<string, string> = {},
): IncomingMessage {
  return { method, url, socket, headers } as unknown as IncomingMessage
}
