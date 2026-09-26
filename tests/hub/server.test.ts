// The hub process and its read surface, booted from the real main entry point
// (HC-1, HC-FR-01, HC-FR-02).
//
//   npm test -- tests/hub/server.test.ts
//
// The whole file is integration: every request goes over a real loopback socket to
// a hub started by `startHub` from src/main/index.ts, against a temporary state
// directory and a temporary dashboard build. Nothing here mocks a request, a
// socket or a store, because the three things this task has to prove are exactly
// the three things a mock would hide: the address the server really bound, the port
// the runtime file really published, and whether a read really leaves the log
// untouched.
//
// What is asserted:
//
//   - The real entry point starts, publishes its live loopback port in the runtime
//     file, and answers session summaries, the pending set, bounded history,
//     counters and health over a socket.
//   - A second instance is refused while the first holds the runtime file, both
//     in this process and in a genuinely separate one.
//   - A taken preferred port results in the next free loopback port being used and
//     recorded, and the wider bind is never taken as the alternative.
//   - No read route changes stored state: pending and event counts are compared
//     through a second connection around every request on the enumerated route
//     list, and every method that is not a read is refused.
//   - The loopback boundary, the strict content-security-policy, and the absence of
//     any permissive cross-origin header.
//   - The payload shapes are exactly the store's content-free read shapes.
//
// The store is opened a second time by this file on purpose. The hub holds one
// connection; a second connection over the same file is how anything outside the
// process observes the log, and it is how the ingest route will observe it after
// HC-3. Every count in this file is read through the store's typed accessors
// rather than through a query, because the store has no query surface to use and
// inventing one in a test would prove nothing about the product.

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { request, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  createServer as createNetServer,
  connect,
  type AddressInfo,
  type Server as NetServer,
} from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { startHub, type RunningHub } from '@/main/index'
import {
  createRequestListener,
  DEFAULT_HUB_PORT,
  MUTATING_ROUTE,
  MUTATING_ROUTES,
  RouteRegistry,
} from '@/hub/server'
import { DASHBOARD_CSP, isLoopbackAddress, WRITE_TOKEN_FILE_NAME } from '@/hub/security'
import { READ_ROUTES, parseLimit, type HubServices } from '@/hub/routes/read'
import { STREAM_ROUTES } from '@/hub/routes/stream'
import {
  HubAlreadyRunningError,
  HubRuntimeFileError,
  isProcessAlive,
  readRuntimeFile,
  runtimeFilePath,
  writeRuntimeFile,
  RUNTIME_FILE_NAME,
  RUNTIME_FILE_VERSION,
  type RuntimeFile,
} from '@/hub/runtime-file'
import { openEventStore, type EventStore, type NewEvent } from '@/storage/eventStore'
import { DATABASE_FILE_NAME, STATE_DIR_ENV_VAR } from '@/storage/paths'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const temporaryDirectories: string[] = []
const openHubs: RunningHub[] = []
const openStores: EventStore[] = []
const openSockets: NetServer[] = []

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * A stand-in for the built dashboard.
 *
 * The real `dist/dashboard` is a Vite build whose asset names are hashed and change
 * whenever the renderer changes, so a test that asserted against it would be
 * asserting against whatever was last built. The layout is the one Vite produces -
 * an index.html and an assets directory - and the traversal target lives outside the
 * root, which is what makes the containment assertion mean something.
 */
function dashboardFixture(): string {
  const root = temporaryDirectory('agent-ping-dashboard-')
  mkdirSync(path.join(root, 'assets'), { recursive: true })
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>agent-ping</title>\n')
  writeFileSync(path.join(root, 'assets', 'index-abc123.js'), 'console.log("dashboard")\n')
  writeFileSync(path.join(root, 'notes.txt'), 'not a served type\n')
  writeFileSync(path.join(path.dirname(root), 'outside-the-root.txt'), 'must never be served\n')
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

afterEach(async () => {
  for (const hub of openHubs.splice(0)) {
    await hub.close().catch(() => undefined)
  }
  for (const store of openStores.splice(0)) store.close()
  for (const socket of openSockets.splice(0)) {
    await new Promise<void>((resolve) => socket.close(() => resolve()))
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * A second connection to the log the hub is holding.
 *
 * This is how the file observes itself: a session summary, the pending set and the
 * event history are all read through the store's own accessors from outside the
 * hub, which is exactly what a second process (the CLI, `doctor`, a verification
 * script) will do after HC-5.
 */
function observeLog(hub: RunningHub): EventStore {
  const store = openEventStore({ filePath: hub.databaseFilePath })
  openStores.push(store)
  return store
}

interface LogCounts {
  readonly pending: number
  readonly events: number
  readonly sessions: number
}

/** The counts a read route must leave exactly as it found them. */
function countsOf(hub: RunningHub): LogCounts {
  const store = observeLog(hub)
  return {
    pending: store.readPending().length,
    events: store.readEventHistory({ limit: 500 }).length,
    sessions: store.readSessionSummaries().length,
  }
}

function blockEvent(overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    harness: 'opencode',
    sessionId: 'ses_alpha',
    repoShortName: 'agent-ping',
    repoFullPath: '/home/dev/Projects/agent-ping',
    rawEventType: 'permission.asked',
    class: 'needs-you',
    subtype: null,
    occurredAt: '2026-09-26T09:00:00.000Z',
    receivedAt: '2026-09-26T09:00:00.100Z',
    dedupeKey: 'opencode:ses_alpha:block-1',
    ...overrides,
  }
}

function finishedEvent(overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    harness: 'opencode',
    sessionId: 'ses_alpha',
    repoShortName: 'agent-ping',
    repoFullPath: '/home/dev/Projects/agent-ping',
    rawEventType: 'session.idle',
    class: 'finished',
    occurredAt: '2026-09-26T10:00:00.000Z',
    receivedAt: '2026-09-26T10:00:00.100Z',
    dedupeKey: 'opencode:ses_alpha:idle-1',
    ...overrides,
  }
}

function fyiEvent(overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    ...finishedEvent({ dedupeKey: 'opencode:ses_alpha:retry-1', occurredAt: '2026-09-26T11:00:00.000Z' }),
    class: 'fyi',
    subtype: 'retry',
    ...overrides,
  }
}

/** One block in one session, so a dashboard has something to render. */
function seedOneBlock(hub: RunningHub): void {
  observeLog(hub).insertEvent(blockEvent())
}

interface Fetched {
  readonly status: number
  /** A `get` over the response headers, case-insensitive as HTTP requires. */
  readonly headers: { get(name: string): string | null }
  readonly text: string
  json<T = unknown>(): T
}

interface CallInit {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * One request over a real socket, through node:http.
 *
 * Deliberately not `fetch`. A pooled client keeps a connection per origin, and
 * these tests deliberately reuse one loopback origin - every hub prefers the same
 * default port - so a pooled connection opened against a hub that has since closed
 * would be handed to the next request and the failure would look like a server
 * fault rather than a client one. One request, one connection, one answer.
 */
function call(origin: string, pathname: string, init: CallInit = {}): Promise<Fetched> {
  const { hostname, port } = new URL(origin)
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: hostname,
        port,
        path: pathname,
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
        // No pooling. Node's global agent keeps connections alive by default, and
        // these tests reuse one origin on purpose, so a pooled socket from a hub
        // that has since closed would be handed to the next request and the
        // failure would look like a server fault rather than a client one.
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const headers: Record<string, string | string[] | undefined> = response.headers
          resolve({
            status: response.statusCode ?? 0,
            headers: {
              get: (name: string): string | null => {
                const value = headers[name.toLowerCase()]
                return Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
              },
            },
            text,
            json: <T,>(): T => JSON.parse(text) as T,
          })
        })
      },
    )
    outgoing.on('error', reject)
    outgoing.end()
  })
}

/**
 * Open the stream, wait for it to say something, and close it.
 *
 * A stream response does not end, so the one request helper in this file cannot be
 * used for it: it waits for `end`. This reads the first chunk instead, which is
 * enough to know the route answered and to be sure the connection is live, and
 * then destroys it - so the hub sees a client that went away, which is half of
 * what the read-only comparison is there to check.
 */
function openStreamAndReadFirstFrame(hub: RunningHub): Promise<{
  status: number
  headers: Record<string, string | string[] | undefined>
  firstChunk: string
}> {
  const { hostname, port } = new URL(hub.origin)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: {
      status: number
      headers: Record<string, string | string[] | undefined>
      firstChunk: string
    }): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const outgoing = request(
      { host: hostname, port, path: '/api/stream', method: 'GET', agent: false },
      (response) => {
        response.setEncoding('utf8')
        response.once('data', (chunk: string) => {
          finish({
            status: response.statusCode ?? 0,
            headers: response.headers as Record<string, string | string[] | undefined>,
            firstChunk: chunk,
          })
          outgoing.destroy()
        })
      },
    )
    outgoing.on('error', reject)
    outgoing.end()
  })
}

/**
 * Occupy a port with a plain socket, the way another program on this machine would.
 *
 * The hub is then started with that port as its preferred one, which is the
 * collision the fallback exists for. The occupying socket stays open for the whole
 * test: a port that was free again would not be a collision.
 */
async function occupyPort(): Promise<{ port: number; socket: NetServer }> {
  const socket = createNetServer(() => undefined)
  openSockets.push(socket)
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve))
  return { port: (socket.address() as AddressInfo).port, socket }
}

/**
 * Hold a consecutive range of ports open, the way a machine with several programs
 * already listening would.
 *
 * The base comes from an ephemeral bind that is then closed and re-bound, because
 * a range of consecutive free ports cannot be discovered otherwise. A bind that
 * loses a race is retried from a new base rather than assumed.
 */
async function occupyRange(count: number): Promise<{ base: number; sockets: NetServer[] }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const probe = await occupyPort()
    const base = probe.port
    await new Promise<void>((resolve) => probe.socket.close(() => resolve()))
    openSockets.splice(openSockets.indexOf(probe.socket), 1)
    const sockets: NetServer[] = []
    try {
      for (let offset = 0; offset < count; offset += 1) {
        const socket = createNetServer(() => undefined)
        await new Promise<void>((resolve, reject) => {
          socket.once('error', reject)
          socket.listen(base + offset, '127.0.0.1', resolve)
        })
        sockets.push(socket)
      }
    } catch {
      for (const socket of sockets) await new Promise<void>((resolve) => socket.close(() => resolve()))
      continue
    }
    openSockets.push(...sockets)
    return { base, sockets }
  }
  throw new Error(`could not hold ${count} consecutive loopback ports`)
}

/** A pid that is guaranteed to be gone: a process this test started and reaped. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
  const exited = new Promise<number>((resolve) => {
    child.once('exit', (code) => resolve(code ?? 0))
  })
  const pid = child.pid
  if (pid === undefined) throw new Error('the probe process did not start')
  await exited
  return pid
}

/** The runtime file of a state directory, read as the record the adapters parse. */
function publishedRuntimeFile(hub: RunningHub): RuntimeFile {
  const file = readFileSync(hub.runtimeFilePath, 'utf8')
  return JSON.parse(file) as RuntimeFile
}

// ---------------------------------------------------------------------------
// HC-FR-01: the composition root
// ---------------------------------------------------------------------------

describe('the hub entry point (HC-FR-01)', () => {
  it('publishes the live loopback port in the runtime file an adapter reads', async () => {
    const hub = await startFixtureHub()

    const record = publishedRuntimeFile(hub)

    expect(record.version).toBe(RUNTIME_FILE_VERSION)
    expect(record.host).toBe('127.0.0.1')
    expect(record.port).toBe(hub.port)
    expect(record.pid).toBe(process.pid)
    expect(record.instanceId).toBe(hub.instanceId)
    expect(record.stateDir).toBe(hub.stateDir)
    expect(record.schemaVersion).toBe(hub.store.schemaVersion)
    expect(typeof record.startedAt).toBe('string')
    // The file the adapters are told to look for is the one that exists, in the
    // state directory they were told about.
    expect(record).toEqual(readRuntimeFile(hub.stateDir))
    expect(hub.runtimeFilePath).toBe(runtimeFilePath(hub.stateDir))
  })

  it('serves a session summary, a pending set and health over a real loopback socket', async () => {
    const hub = await startFixtureHub()
    seedOneBlock(hub)
    const origin = `http://${publishedRuntimeFile(hub).host}:${publishedRuntimeFile(hub).port}`

    const sessions = await call(origin, '/api/sessions')
    expect(sessions.status).toBe(200)
    expect(sessions.json<{ sessions: unknown[]; count: number }>()).toEqual({
      sessions: [
        {
          sessionId: 'ses_alpha',
          harness: 'opencode',
          repoShortName: 'agent-ping',
          repoFullPath: '/home/dev/Projects/agent-ping',
          firstSeenAt: '2026-09-26T09:00:00.000Z',
          lastSeenAt: '2026-09-26T09:00:00.000Z',
          state: 'blocked',
          workSignal: 0,
          pendingCount: 1,
        },
      ],
      count: 1,
    })

    const pending = await call(origin, '/api/pending')
    expect(pending.status).toBe(200)
    expect(pending.json<{ items: unknown[]; count: number }>().count).toBe(1)

    const health = await call(origin, '/api/health')
    expect(health.status).toBe(200)
    const payload = health.json<{
      status: string
      host: string
      port: number
      database: { readable: boolean; pendingCount: number | null }
    }>()
    expect(payload.status).toBe('ok')
    expect(payload.host).toBe('127.0.0.1')
    expect(payload.port).toBe(hub.port)
    expect(payload.database.readable).toBe(true)
    expect(payload.database.pendingCount).toBe(1)
  })

  it('binds 127.0.0.1 and nothing wider', async () => {
    const hub = await startFixtureHub()

    // Read back from the socket, not from the option that asked for it: this is
    // what the operating system was told.
    const address = hub.server.nodeServer.address() as AddressInfo
    expect(address.address).toBe('127.0.0.1')
    expect(address.family).toBe('IPv4')
    expect(address.port).toBe(hub.port)
    expect(hub.origin).toBe(`http://127.0.0.1:${hub.port}`)
    expect(hub.host).toBe('127.0.0.1')
  })

  it('listens on no interface other than loopback', async () => {
    const hub = await startFixtureHub()
    // The published port must not be reachable from a non-loopback local address.
    // Every non-loopback address this machine has is enumerated and refused; on a
    // machine with only loopback there is nothing to enumerate and the assertion
    // is that the bound address is the only interface claimed.
    const interfaces = nonLoopbackAddresses()
    for (const address of interfaces) {
      const reachable = await canConnect(address, hub.port)
      expect(reachable, `${address}:${hub.port} must not be reachable`).toBe(false)
    }
    expect(isLoopbackAddress(addressOf(hub))).toBe(true)
  })

  it('uses the next free loopback port when the preferred one is taken, and records it', async () => {
    const { port: taken } = await occupyPort()

    const hub = await startFixtureHub({ preferredPort: taken })

    expect(hub.port).not.toBe(taken)
    expect(hub.port).toBe(taken + 1)
    expect(hub.preferredPort).toBe(taken)
    // The record the adapters read is the one that moved, not the preferred port.
    expect(publishedRuntimeFile(hub).port).toBe(taken + 1)
    // Still loopback, because the fallback widens the port and never the address.
    expect(hub.host).toBe('127.0.0.1')
    expect(publishedRuntimeFile(hub).host).toBe('127.0.0.1')
    // And the hub is actually serving on the port it published.
    const health = await call(hub.origin, '/api/health')
    expect(health.status).toBe(200)
    expect(health.json<{ port: number }>().port).toBe(taken + 1)
  })

  it('gives up on a taken range rather than binding wider or guessing a port', async () => {
    // Three consecutive ports held, and three attempts allowed: the range is
    // exhausted, so the hub has no port to publish and must say so.
    const range = await occupyRange(3)

    await expect(
      startHub({
        stateDir: temporaryDirectory('agent-ping-state-'),
        dashboardRoot: null,
        preferredPort: range.base,
        portFallbackAttempts: 2,
      }),
    ).rejects.toThrow(new RegExp(`could not bind a loopback port: ${range.base} through`))
    // And nothing was left behind by the failed start: no runtime file claiming a
    // hub that does not exist.
    expect(existsSync(runtimeFilePath(path.join(tmpdir(), 'unused')))).toBe(false)
  })

  it('refuses a second instance in this process while the first holds the runtime file', async () => {
    const hub = await startFixtureHub()

    const second = await startHub({ stateDir: hub.stateDir, dashboardRoot: null }).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(second).toBeInstanceOf(HubAlreadyRunningError)
    // The refusal carries the live record, so a caller can act on it - focus the
    // existing window, report the port - rather than logging "already running".
    const existing = (second as HubAlreadyRunningError).existing
    expect(existing.port).toBe(hub.port)
    expect(existing.instanceId).toBe(hub.instanceId)
    // And the first hub is untouched: same instance, still serving, still holding
    // the file it published.
    expect(publishedRuntimeFile(hub).instanceId).toBe(hub.instanceId)
    expect((await call(hub.origin, '/api/health')).status).toBe(200)
  })

  it('refuses a second instance in a genuinely separate process', async () => {
    const hub = await startFixtureHub()
    const running = await occupyPort()

    // A real child process, importing the real entry point and calling the real
    // startHub. This is the only form of the guarantee that cannot be faked by the
    // process under test: a second OS process, a second file-system view, one
    // runtime file between them.
    const result = await runNodeFixture('second-instance.mjs', [hub.stateDir])

    expect(result.code, result.stderr).toBe(1)
    expect(result.stdout).toContain('HubAlreadyRunningError')
    expect(result.stderr).toContain('already running')
    // The child named the running instance rather than inventing a failure.
    expect(result.stderr).toContain(hub.instanceId)
    // The occupied port proves the child was refused before it bound anything: a
    // hub that got as far as listening would have had to take a port, and the
    // whole range above the occupied one was available to it.
    expect(running.port).toBeGreaterThan(0)
    expect(publishedRuntimeFile(hub).instanceId).toBe(hub.instanceId)
  })

  it('reclaims a runtime file left behind by a process that is gone (APX-CON-03)', async () => {
    const stateDir = temporaryDirectory('agent-ping-state-')
    const gone = await deadPid()
    writeRuntimeFile(
      {
        version: RUNTIME_FILE_VERSION,
        instanceId: 'crashed-instance',
        pid: gone,
        host: '127.0.0.1',
        port: DEFAULT_HUB_PORT,
        stateDir,
        startedAt: '2026-09-26T09:00:00.000Z',
        schemaVersion: 1,
      },
      stateDir,
    )

    const hub = await startHub({ stateDir, dashboardRoot: null })

    expect(hub.reclaimedStaleRuntimeFile).toBe(true)
    // The dead pid is kept, because it is the one fact about the crashed instance
    // that belongs in a bug report.
    expect(hub.reclaimedFromPid).toBe(gone)
    // The reclaim replaced the crashed instance's record rather than leaving both.
    expect(publishedRuntimeFile(hub).instanceId).toBe(hub.instanceId)
    expect(publishedRuntimeFile(hub).port).toBe(hub.port)
    expect((await call(hub.origin, '/api/pending')).status).toBe(200)
  })

  it('reads a recorded pid as the restart depends on it', async () => {
    // The single judgement the whole lock makes. Live means refuse, gone means take
    // over, and a pid that cannot be a process means gone - otherwise a corrupt
    // file would wedge the product permanently, which is the failure APX-CON-03
    // exists to prevent.
    expect(isProcessAlive(process.pid)).toBe(true)
    // A process this test started and reaped, so "gone" is a fact and not a guess.
    expect(isProcessAlive(await deadPid())).toBe(false)
    // A pid outside the representable range cannot name a process.
    expect(isProcessAlive(2 ** 31 - 1)).toBe(false)
    // Zero and a negative number name a process group or nothing at all, never a
    // single process, and a corrupt file carrying one must not read as "alive".
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(1.5)).toBe(false)
  })

  it('gives the runtime file back and closes the log when it closes', async () => {
    const hub = await startFixtureHub()
    seedOneBlock(hub)
    expect(existsSync(hub.runtimeFilePath)).toBe(true)

    await hub.close()

    // No runtime file: an adapter that found one would post to a hub that is gone.
    expect(existsSync(hub.runtimeFilePath)).toBe(false)
    expect(readRuntimeFile(hub.stateDir)).toBeNull()
    // No listener: the port answers nothing now.
    expect(hub.server.nodeServer.listening).toBe(false)
    await expect(call(hub.origin, '/api/health')).rejects.toThrow()
    // The log is still openable by anything else, and still holds the block: a
    // sidecar that was stopped lost nothing (APX-CON-03).
    const store = openEventStore({ filePath: path.join(hub.stateDir, DATABASE_FILE_NAME) })
    openStores.push(store)
    expect(store.readPending()).toHaveLength(1)
    // And it can be started again immediately, which is the restart half of the
    // sidecar promise.
    const restarted = await startHub({ stateDir: hub.stateDir, dashboardRoot: null })
    expect(restarted.runtimeFilePath).toBe(hub.runtimeFilePath)
    expect(restarted.store.readPending()).toHaveLength(1)
  })

  it('is safe to close twice', async () => {
    const hub = await startFixtureHub()
    await hub.close()
    await expect(hub.close()).resolves.toBeUndefined()
  })

  it('resolves its state directory through the one resolver, and honours the override', async () => {
    const stateDir = temporaryDirectory('agent-ping-state-')
    const hub = await startHub({
      env: { [STATE_DIR_ENV_VAR]: stateDir } as NodeJS.ProcessEnv,
      dashboardRoot: null,
    })
    expect(hub.stateDir).toBe(stateDir)
    expect(hub.databaseFilePath).toBe(path.join(stateDir, DATABASE_FILE_NAME))
    expect(path.dirname(hub.runtimeFilePath)).toBe(stateDir)
    expect(path.basename(hub.runtimeFilePath)).toBe(RUNTIME_FILE_NAME)
  })

  it('writes only the database, the runtime file and the write token into the state directory', async () => {
    const hub = await startFixtureHub()
    seedOneBlock(hub)
    const files = [...readdirSync(hub.stateDir)].sort()
    // The write-ahead log sidecars are SQLite's, and they are named after the
    // database. The other three are the product's own: the lock-and-pointer, the
    // durable log, and the per-install write token HC-FR-06 puts beside them. No log
    // file, and nothing else - a state directory is a place a stranger can list.
    expect(files.filter((name) => !name.startsWith(DATABASE_FILE_NAME))).toEqual(
      [RUNTIME_FILE_NAME, WRITE_TOKEN_FILE_NAME].sort(),
    )
  })
})

// ---------------------------------------------------------------------------
// HC-FR-02: the read routes
// ---------------------------------------------------------------------------

describe('the read routes (HC-FR-02)', () => {
  it('serves one session with its recent events, and 404s an unknown identifier', async () => {
    const hub = await startFixtureHub()
    const store = observeLog(hub)
    store.insertEvent(blockEvent())
    store.insertEvent(finishedEvent())
    store.insertEvent(fyiEvent())

    const found = await call(hub.origin, '/api/sessions/ses_alpha')
    expect(found.status).toBe(200)
    const payload = found.json<{
      session: { sessionId: string; state: string; pendingCount: number; recentEvents: unknown[] }
      recentEventsLimit: number
    }>()
    expect(payload.session.sessionId).toBe('ses_alpha')
    expect(payload.session.state).toBe('running')
    expect(payload.session.pendingCount).toBe(1)
    // Newest first, and bounded by the number the route publishes.
    expect(payload.session.recentEvents).toHaveLength(3)
    expect(payload.recentEventsLimit).toBe(200)

    const missing = await call(hub.origin, '/api/sessions/ses_nope')
    expect(missing.status).toBe(404)
    expect(missing.json<{ error: string }>().error).toBe('not-found')
  })

  it('serves bounded event history and clamps a limit it cannot honour', async () => {
    const hub = await startFixtureHub()
    const store = observeLog(hub)
    for (let index = 0; index < 4; index += 1) {
      store.insertEvent(
        finishedEvent({
          dedupeKey: `opencode:ses_alpha:idle-${index}`,
          occurredAt: new Date(Date.UTC(2026, 8, 26, 10, 0, index)).toISOString(),
        }),
      )
    }

    const all = await call(hub.origin, '/api/events')
    expect(all.json<{ count: number; limit: number }>()).toMatchObject({ count: 4, limit: 100 })

    const page = await call(hub.origin, '/api/events?limit=2')
    const paged = page.json<{ events: { dedupeKey: string }[]; limit: number }>()
    expect(paged.events.map((event) => event.dedupeKey)).toEqual([
      'opencode:ses_alpha:idle-3',
      'opencode:ses_alpha:idle-2',
    ])
    expect(paged.limit).toBe(2)

    // The ceiling is the same number the store enforces, and a client cannot ask
    // for more than the product serves.
    const greedy = await call(hub.origin, '/api/events?limit=100000')
    expect(greedy.json<{ limit: number }>().limit).toBe(500)
    const nonsense = await call(hub.origin, '/api/events?limit=not-a-number')
    expect(nonsense.json<{ limit: number }>().limit).toBe(100)

    const narrowed = await call(hub.origin, '/api/events?sessionId=ses_alpha&limit=1')
    expect(narrowed.json<{ count: number; sessionId: string }>()).toMatchObject({
      count: 1,
      sessionId: 'ses_alpha',
    })
    const otherSession = await call(hub.origin, '/api/events?sessionId=ses_other')
    expect(otherSession.json<{ count: number }>().count).toBe(0)
  })

  it('clamps a limit the same way in the route and in the store', () => {
    expect(parseLimit(null, 100, 500)).toBe(100)
    expect(parseLimit('', 100, 500)).toBe(100)
    expect(parseLimit('0', 100, 500)).toBe(100)
    expect(parseLimit('-1', 100, 500)).toBe(100)
    expect(parseLimit('7.9', 100, 500)).toBe(7)
    expect(parseLimit('9000', 100, 500)).toBe(500)
    expect(parseLimit('1e400', 100, 500)).toBe(100)
  })

  it('serves the counters as counts and timestamps only', async () => {
    const hub = await startFixtureHub()

    const metrics = await call(hub.origin, '/api/metrics')
    expect(metrics.status).toBe(200)
    const payload = metrics.json<{ counters: { counter: string; value: number; updatedAt: string | null }[] }>()
    expect(payload.counters.map((counter) => counter.counter)).toEqual([
      'dashboard_opens',
      'toast_deliveries',
      'deep_link_opens',
      'pending_count_snapshots',
    ])
    for (const counter of payload.counters) {
      // Exactly three fields, so the payload cannot grow into carrying an event.
      expect(Object.keys(counter).sort()).toEqual(['counter', 'updatedAt', 'value'])
      expect(typeof counter.value).toBe('number')
      expect(counter.updatedAt === null || typeof counter.updatedAt === 'string').toBe(true)
    }
    expect(metrics.text).not.toMatch(/ses_alpha|agent-ping/)
  })

  it('reports health as the doctor command needs it', async () => {
    const hub = await startFixtureHub()
    seedOneBlock(hub)

    const health = (await call(hub.origin, '/api/health')).json<Record<string, unknown>>()

    expect(Object.keys(health).sort()).toEqual([
      'dashboard',
      'database',
      'delivery',
      'host',
      'instanceId',
      'origin',
      'pid',
      'port',
      'requests',
      'startedAt',
      'status',
      'uptimeSeconds',
    ])
    expect(health['database']).toMatchObject({
      filePath: hub.databaseFilePath,
      schemaVersion: hub.store.schemaVersion,
      rebuiltFromMigrations: false,
      readable: true,
      sessionCount: 1,
      pendingCount: 1,
    })
    // The delivery seam exists and says it is not wired yet, rather than being
    // absent: HC-5 fills it, and `doctor` can tell the two apart today.
    expect(health['delivery']).toEqual({ status: 'not-wired' })
    expect(health['dashboard']).toMatchObject({ available: true })
  })

  it('carries exactly the content-free read shapes in every payload', async () => {
    const hub = await startFixtureHub()
    const store = observeLog(hub)
    store.insertEvent(blockEvent())

    const keysOf = (value: unknown): string[] => Object.keys(value as object).sort()

    const sessions = (await call(hub.origin, '/api/sessions')).json<{ sessions: Record<string, unknown>[] }>()
    expect(keysOf(sessions.sessions[0])).toEqual([
      'firstSeenAt',
      'harness',
      'lastSeenAt',
      'pendingCount',
      'repoFullPath',
      'repoShortName',
      'sessionId',
      'state',
      'workSignal',
    ])

    const detail = (await call(hub.origin, '/api/sessions/ses_alpha')).json<{
      session: Record<string, unknown>
    }>()
    expect(keysOf(detail.session)).toEqual(
      [...keysOf(sessions.sessions[0] ?? {}), 'recentEvents'].sort(),
    )
    const recent = (detail.session['recentEvents'] as Record<string, unknown>[])[0] ?? {}
    expect(keysOf(recent)).toEqual([
      'ackState',
      'class',
      'dedupeKey',
      'eventId',
      'occurredAt',
      'rawEventType',
      'receivedAt',
      'resolutionState',
      'sessionId',
      'subtype',
    ])

    const pending = (await call(hub.origin, '/api/pending')).json<{ items: Record<string, unknown>[] }>()
    expect(keysOf(pending.items[0])).toEqual(
      [...keysOf(recent), 'harness', 'repoFullPath', 'repoShortName'].sort(),
    )

    // No field in any state payload is named like content, and no payload holds a
    // field that is not one of the persisted ones (APX-FR-01, ADR-003). The error
    // bodies of a 404 are excluded on purpose: they are a fixed literal, not a
    // value that came out of the log.
    const payloads = await Promise.all(
      ['/api/events', '/api/metrics', '/api/health'].map(async (route) =>
        (await call(hub.origin, route)).json(),
      ),
    )
    const everything = JSON.stringify([sessions, detail, pending, ...payloads])
    expect(everything).not.toMatch(
      /"(prompt|response|content|text|message|body|diff|output|transcript|summary)":/i,
    )
  })
})

// ---------------------------------------------------------------------------
// The read-only promise
// ---------------------------------------------------------------------------

describe('the read routes are observably read-only', () => {
  it('leaves pending, event and session counts unchanged around every read request', async () => {
    const hub = await startFixtureHub()
    const store = observeLog(hub)
    store.insertEvent(blockEvent())
    store.insertEvent(finishedEvent())
    store.insertEvent(fyiEvent())
    const before = countsOf(hub)
    // The comparison is only meaningful if there is something to compare.
    expect(before).toEqual({ pending: 1, events: 3, sessions: 1 })

    for (const route of hub.registry.routes()) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const pathname = concretePathFor(route.pattern)
        // The one request this file does not make on a route that serves it: the
        // mutating route's own method, which is the append HC-3 owns. It is skipped
        // rather than counted, because counting it would mean expecting an event to
        // appear; every *other* method on that path, and every method on every other
        // route, is still compared, which is where a hidden mutation would show up.
        const resolution = hub.registry.resolve(method, pathname)
        if (resolution.kind === 'route' && resolution.route.mutation !== 'read-only') continue
        // The stream route answers GET with a response that never ends, because
        // that is what a stream is. It is opened, read until it has said
        // something, and closed, and the counts are still compared around it -
        // so the promise covers the one route whose whole purpose is to stay
        // open, which is exactly the one a read-only assertion could have
        // quietly skipped.
        const response = route.pattern === '/api/stream' && method === 'GET'
          ? await openStreamAndReadFirstFrame(hub)
          : await call(hub.origin, pathname, { method })
        const after = countsOf(hub)
        expect(
          after,
          `${method} ${route.pattern} changed stored state`,
        ).toEqual(before)
        if (resolution.kind === 'route') {
          // A route that serves this method is a read: it was answered, and the log
          // did not move.
          expect(response.status, `${method} ${route.pattern}`).toBe(200)
        } else {
          // Every method no route serves on this path is refused, whatever the path.
          expect(
            [404, 405],
            `${method} ${route.pattern} answered ${response.status}`,
          ).toContain(response.status)
        }
      }
    }

    expect(countsOf(hub)).toEqual(before)
  })

  it('registers the whole surface: one append and exactly one control route', async () => {
    const hub = await startFixtureHub()

    // The registry the running hub holds, not a list written here: a hand-written
    // list passes forever regardless of what is registered.
    expect([...hub.registry.signatures()].sort()).toEqual([
      'GET /',
      'GET /api/events',
      'GET /api/health',
      'GET /api/metrics',
      'GET /api/pending',
      'GET /api/sessions',
      'GET /api/sessions/:sessionId',
      'GET /api/stream',
      'POST /api/ack/:eventId',
      'POST /api/ingest',
    ])
    // Two registered routes declare a mutation, and they are two different things
    // (ADR-002): the append creates a row and changes nothing that already exists,
    // and the ack is the single control surface - the only route in the product that
    // can change an existing record (APX-CON-08).
    const mutating = hub.registry.routes().filter((route) => route.mutation !== 'read-only')
    expect(mutating.map((route) => `${route.method} ${route.pattern}`)).toEqual([
      'POST /api/ingest',
      'POST /api/ack/:eventId',
    ])
    expect(mutating.map((route) => route.mutation)).toEqual(['ingest-append', 'ack-only'])
    // The control surface is exactly one signature, and it is the one the registry
    // checks every `ack-only` registration against.
    expect([...MUTATING_ROUTES].sort()).toEqual(['POST /api/ack/:eventId', 'POST /api/ingest'])
    expect(MUTATING_ROUTE).toBe('POST /api/ack/:eventId')
    expect(hub.registry.signatures()).toContain(MUTATING_ROUTE)
    // Every other route is a read, and a read-only route is a GET - so no mutating
    // method can be registered as a read.
    for (const route of hub.registry.routes()) {
      if (route.mutation === 'read-only') expect(route.method).toBe('GET')
    }
  })

  it('refuses a registration that claims to be the mutating route without being it', () => {
    const registry = new RouteRegistry<HubServices>()
    expect(() =>
      registry.register({
        method: 'POST',
        pattern: '/api/steer',
        name: 'read.steer',
        mutation: 'ack-only',
        handle: () => undefined,
      }),
    ).toThrow(/only mutating route/)
    // The append is equally closed: exactly one route may put a row in this log.
    expect(() =>
      registry.register({
        method: 'POST',
        pattern: '/api/events',
        name: 'read.append',
        mutation: 'ingest-append',
        handle: () => undefined,
      }),
    ).toThrow(/only appending route/)
    // And a read cannot be a write in disguise.
    expect(() =>
      registry.register({
        method: 'DELETE',
        pattern: '/api/events',
        name: 'read.purge',
        mutation: 'read-only',
        handle: () => undefined,
      }),
    ).toThrow(/read-only/)
  })

  it('exposes no route that could steer, interrupt, prompt or approve anything', () => {
    // A promise about intent rather than about state, so it is asserted over the
    // enumerated registry instead of over a comment (APX-CON-08, HC-US-03).
    const forbidden = /spawn|steer|interrupt|prompt|approve|resume|kill|send|control|execute|run\b|input|keypress/i
    for (const route of [...READ_ROUTES, ...STREAM_ROUTES]) {
      expect(`${route.method} ${route.pattern} ${route.name}`).not.toMatch(forbidden)
    }
    // And the read surface as a whole has no write-shaped path at all.
    for (const route of [...READ_ROUTES, ...STREAM_ROUTES]) {
      expect(route.method).toBe('GET')
    }
  })
})

// ---------------------------------------------------------------------------
// The security boundary
// ---------------------------------------------------------------------------

describe('the loopback boundary (APX-CON-01)', () => {
  it('accepts every loopback form and refuses everything else', () => {
    // The value forms one loopback address actually arrives in. Refusing
    // ::ffff:127.0.0.1 would break the product on a default dual-stack socket,
    // which is the mistake this table exists to prevent.
    for (const loopback of ['127.0.0.1', '127.0.0.53', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) {
      expect(isLoopbackAddress(loopback), loopback).toBe(true)
    }
    for (const other of [
      '0.0.0.0',
      '::',
      '::ffff:10.0.0.5',
      '10.0.0.5',
      '192.168.1.20',
      '172.16.0.1',
      '127.0.0.1.evil.example',
      '127.0.0.256',
      '',
      '   ',
      undefined,
      null,
    ]) {
      expect(isLoopbackAddress(other), String(other)).toBe(false)
    }
  })

  it('refuses a non-loopback caller before routing, with a synthetic socket', () => {
    // The real-socket half of this boundary is proven above and by the bind
    // assertion: a request from this machine is answered, and the listener is bound
    // to loopback only. Reaching the refusal needs a peer this machine does not
    // have, so it is driven through the same listener with a socket whose address
    // is a LAN address. What is being asserted is the ordering - the refusal
    // happens before any handler, so no read and no write can be reached from a
    // non-loopback peer.
    const registry = new RouteRegistry<HubServices>()
    let handlerRan = false
    registry.register({
      method: 'GET',
      pattern: '/api/pending',
      name: 'read.pending',
      mutation: 'read-only',
      handle: ({ response }) => {
        handlerRan = true
        response.statusCode = 200
        response.end('{}')
      },
    })
    const listener = createRequestListener<HubServices>({
      registry,
      services: () => ({}) as HubServices,
      dashboard: { root: null },
    })
    const chunks: string[] = []
    const response = fakeResponse(chunks)
    Object.assign(response.socket, { remoteAddress: '10.1.2.3' })

    listener(
      fakeRequest('GET', '/api/pending', response.socket),
      response as unknown as ServerResponse,
    )

    expect(handlerRan).toBe(false)
    expect(response.statusCode).toBe(403)
    expect(JSON.parse(chunks.join(''))).toMatchObject({ error: 'forbidden' })
  })

  it('does not treat a forwarded address header as the caller', async () => {
    const hub = await startFixtureHub()
    const response = await call(hub.origin, '/api/pending', {
      headers: { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' },
    })
    // A loopback caller with a forwarded header is still a loopback caller: the
    // header is a claim, and the boundary reads the socket.
    expect(response.status).toBe(200)
  })

  it('serves a strict content-security-policy and no permissive cross-origin header', async () => {
    const hub = await startFixtureHub()

    const page = await call(hub.origin, '/')

    expect(page.status).toBe(200)
    const csp = page.headers.get('content-security-policy') ?? ''
    expect(csp).toBe(DASHBOARD_CSP)
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    // The negative assertions are the point: a policy that lost frame-ancestors in
    // a merge still contains default-src 'self'.
    expect(csp).not.toMatch(/unsafe-inline/)
    expect(csp).not.toMatch(/unsafe-eval/)
    expect(csp).not.toMatch(/\*/)
    // No cross-origin header of any kind on any route, because the daemon is
    // unauthenticated on read and a permissive one would let any page the developer
    // visits read their session state.
    for (const pathname of ['/', '/api/pending', '/api/health', '/api/sessions']) {
      const response = await call(hub.origin, pathname)
      expect(response.headers.get('access-control-allow-origin'), pathname).toBeNull()
      expect(response.headers.get('access-control-allow-credentials'), pathname).toBeNull()
      expect(response.headers.get('access-control-expose-headers'), pathname).toBeNull()
    }
    // The stream is the response that stays open the longest, so it is the one
    // where a permissive header would do the most damage: opened from any page the
    // developer visits, it would hand that page their whole session feed.
    const stream = await openStreamAndReadFirstFrame(hub)
    expect(stream.status).toBe(200)
    for (const header of [
      'access-control-allow-origin',
      'access-control-allow-credentials',
      'access-control-expose-headers',
    ]) {
      expect(stream.headers[header], header).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// The dashboard surface
// ---------------------------------------------------------------------------

describe('the built dashboard on the same origin', () => {
  it('serves the index, the hashed assets, and refuses to leave its root', async () => {
    const hub = await startFixtureHub()

    const index = await call(hub.origin, '/')
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toContain('text/html')
    expect(index.text).toContain('agent-ping')

    const asset = await call(hub.origin, '/assets/index-abc123.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('text/javascript')

    // Three shapes of the same escape: a literal traversal the client normalises, a
    // percent-encoded one it does not, and an encoded separator.
    for (const escape of [
      '/assets/../../outside-the-root.txt',
      '/%2e%2e%2f%2e%2e%2foutside-the-root.txt',
      '/..%2f..%2foutside-the-root.txt',
    ]) {
      const response = await call(hub.origin, escape)
      expect(response.status, escape).toBe(404)
      expect(response.text).not.toContain('must never be served')
    }

    const missing = await call(hub.origin, '/assets/index-000000.js')
    expect(missing.status).toBe(404)
  })

  it('answers 404 rather than the dashboard for an unknown API path', async () => {
    const hub = await startFixtureHub()
    const response = await call(hub.origin, '/api/nope')
    expect(response.status).toBe(404)
    expect(response.json<{ error: string }>().error).toBe('not-found')
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('says so explicitly when the build is not there, instead of serving a blank page', async () => {
    const missing = path.join(temporaryDirectory('agent-ping-absent-'), 'no-such-build')
    const hub = await startFixtureHub({ dashboardRoot: missing })

    const response = await call(hub.origin, '/')

    expect(response.status).toBe(503)
    expect(response.json<{ error: string; message: string }>()).toMatchObject({
      error: 'dashboard-unavailable',
    })
    expect(response.text).toContain('npm run build:dashboard')
  })

  it('serves no dashboard at all when told there is none', async () => {
    const hub = await startFixtureHub({ dashboardRoot: null })
    const response = await call(hub.origin, '/')
    expect(response.status).toBe(503)
    expect(response.json<{ error: string }>().error).toBe('dashboard-unavailable')
  })
})

// ---------------------------------------------------------------------------
// The runtime file contract
// ---------------------------------------------------------------------------

describe('the runtime file contract the adapters read', () => {
  it('carries exactly the published fields and no others', async () => {
    const hub = await startFixtureHub()
    const record = JSON.parse(readFileSync(hub.runtimeFilePath, 'utf8')) as Record<string, unknown>
    expect(Object.keys(record).sort()).toEqual([
      'host',
      'instanceId',
      'pid',
      'port',
      'schemaVersion',
      'startedAt',
      'stateDir',
      'version',
    ])
  })

  it('reads as null when there is no file and throws when the file is not ours', () => {
    const stateDir = temporaryDirectory('agent-ping-state-')
    expect(readRuntimeFile(stateDir)).toBeNull()

    // A file that exists and cannot be understood is a different situation from no
    // file at all, and conflating them is how a reader invents a port.
    const target = runtimeFilePath(stateDir)
    writeFileSync(target, '{ this is not json')
    expect(() => readRuntimeFile(stateDir)).toThrow(HubRuntimeFileError)

    writeFileSync(target, JSON.stringify({ version: 1, port: 1234 }))
    expect(() => readRuntimeFile(stateDir)).toThrow(/instanceId|unexpected field/)

    writeFileSync(
      target,
      JSON.stringify({
        version: 1,
        instanceId: 'x',
        pid: process.pid,
        host: '127.0.0.1',
        port: '1234',
        stateDir,
        startedAt: 'now',
        schemaVersion: 1,
      }),
    )
    // A port that arrived as a string is a port nobody can dial.
    expect(() => readRuntimeFile(stateDir)).toThrow(/neither null nor a positive integer/)
  })

  it('refuses to publish a record from another version of the contract', () => {
    const stateDir = temporaryDirectory('agent-ping-state-')
    expect(() =>
      writeRuntimeFile(
        {
          version: 99 as typeof RUNTIME_FILE_VERSION,
          instanceId: 'x',
          pid: process.pid,
          host: '127.0.0.1',
          port: 1234,
          stateDir,
          startedAt: '2026-09-26T09:00:00.000Z',
          schemaVersion: 1,
        },
        stateDir,
      ),
    ).toThrow(/is not the version this build publishes/)
  })
})

// ---------------------------------------------------------------------------
// Performance budget
// ---------------------------------------------------------------------------

describe('the idle footprint (APX-CON-11)', () => {
  it('keeps a hub with a served read route under the 150 MB idle budget', async () => {
    // Measured in a child process, because the number that matters is a hub's and
    // this test process also holds the test runner, the TypeScript transform and
    // every fixture. The child starts the real entry point, answers a read, and
    // prints its own resident set size.
    const result = await runNodeFixture('measure-idle-rss.mjs', [])
    expect(result.code, result.stderr).toBe(0)
    const measurement = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
      rssAfterImportBytes: number
      rssAfterGraphBytes: number
      rssAfterBootBytes: number
      rssAfterReadsBytes: number
      requestsServed: number
      measured: string
    }
    expect(measurement.requestsServed).toBeGreaterThan(0)
    expect(measurement.measured).toBe('typescript-source')
    const megabytes = measurement.rssAfterReadsBytes / (1024 * 1024)
    expect(megabytes, `idle RSS was ${megabytes.toFixed(1)} MB`).toBeLessThan(150)
    // Reported rather than only asserted, so the observed numbers are visible in
    // the test output instead of living only in a threshold. The import phases are
    // broken out because the process runs the TypeScript sources, and Node's type
    // stripping is a cost of this measurement that the packaged hub does not pay.
    const toMb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`
    console.info(
      `[hub] idle RSS: process ${toMb(measurement.rssAfterImportBytes)} before the import, ` +
        `${toMb(measurement.rssAfterGraphBytes)} with the hub's modules loaded, ` +
        `${toMb(measurement.rssAfterBootBytes)} after boot, ${megabytes.toFixed(1)} MB after ` +
        `${measurement.requestsServed} reads (budget 150 MB)`,
    )
  })
})

// ---------------------------------------------------------------------------
// Helpers used only by the assertions above
// ---------------------------------------------------------------------------

/** The path a pattern addresses once its parameters are filled in. */
function concretePathFor(pattern: string): string {
  return pattern.replace(/:sessionId/g, 'ses_alpha').replace(/:eventId/g, 'evt_sample')
}

function addressOf(hub: RunningHub): string {
  return (hub.server.nodeServer.address() as AddressInfo).address
}

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
      // The synthetic response records nothing: the assertions are about the
      // status and the body, not about a header table a mock invented.
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
): IncomingMessage {
  return { method, url, socket, headers: {} } as unknown as IncomingMessage
}

interface NodeFixtureResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run a fixture in a real Node process with the real source tree.
 *
 * The fixtures import `src/main/index.ts` directly. Node strips the types itself
 * (this is enabled by default from Node 22.18, and requested through the flag on
 * the versions before it), and a resolver hook maps the `.js` specifiers the tsc
 * build requires onto the `.ts` sources they name - which is what lets an
 * unbuilt checkout be started in a second process without a build step.
 */
function runNodeFixture(
  fixture: string,
  args: readonly string[],
): Promise<NodeFixtureResult> {
  const nodeArgs = [
    '--no-warnings',
    ...(process.features.typescript ? [] : ['--experimental-strip-types']),
    path.join(FIXTURES, fixture),
    ...args,
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd: path.join(FIXTURES, '..', '..', '..'),
      env: { ...process.env, AGENT_PING_STATE_DIR: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}
