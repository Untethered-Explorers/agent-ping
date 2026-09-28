// The real hub for the browser journeys, and the only HTTP client the journeys use
// to reach it (LD-4: LD-FR-03, LD-FR-05, LD-FR-09, LD-FR-10, APX-CON-11).
//
// WHAT THIS IS
// One temporary state directory, one prepared copy of the built dashboard, one
// write token this run chose, and one child process running the product's own
// composition root (`src/main/index.ts`) over a real loopback socket. Every
// signal the journeys post goes through the product's real ingest route; every
// page the journeys open is served by the product's real static route.
//
// WHY IT IS A CHILD PROCESS
// Three of the claims are properties of something that is not the test runner:
//
//   - LD-FR-10, "the same build is served over the loopback origin": a real
//     listener, a real port, a real content-security policy.
//   - The stale journey interrupts the stream and then needs the hub to still be
//     there, with the same log and the same published port.
//   - The APX-CON-11 idle-RSS reading is a property of the hub process. Measured
//     inside a Playwright worker it would be the worker's number.
//
// It also keeps the composition root out of Playwright's own module graph: it
// resolves relative specifiers with the `.js` extension the tsc build requires and
// loads a native module, neither of which Playwright's loader provides. The
// `ts-resolver` hook the existing hub fixtures use is what lets the real
// `src/main/index.ts` run from an unbuilt checkout.
//
// THE ONE THING THIS RUN SUPPLIES TO THE PAGE
// The write token, and only the write token, through the one input
// `src/dashboard/main.ts` documents for it: a
// `<meta name="agent-ping-write-token">` element in the served document
// (`readWriteToken`, ACK_TOKEN_META_NAME). HC-FR-06 deliberately keeps the token
// out of every served file and every response, and nothing in the product emits
// that element, so the shipped page presents its acknowledgement control as
// unavailable and says why. LD-3 recorded exactly that as an integration
// dependency rather than a defect, and this run is where the write path is proved
// end to end.
//
// So the served document is a byte copy of the build with that one element
// inserted, and `documentServedAs` below reports the comparison: the built bytes,
// the served bytes, the inserted line, and whether the two are identical once
// that line is removed. A substitution that cannot state exactly what it changed
// is not a substitution a reviewer can sign off, so this one can.
//
// Everything else - the page, the bundle, the stylesheet, the route registry, the
// classifier, the store, the stream, the ack boundary - is the product's.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..', '..')

/** The built dashboard, which the hub serves. */
export const BUILT_DASHBOARD_ROOT = path.join(REPO_ROOT, 'dist', 'dashboard')
/** The built document, the one this run copies and adds one element to. */
export const BUILT_DASHBOARD_DOCUMENT = path.join(BUILT_DASHBOARD_ROOT, 'index.html')
/** The element name the page reads the write token from (ACK_TOKEN_META_NAME). */
export const WRITE_TOKEN_META_NAME = 'agent-ping-write-token'
/** The token file's own name inside the state directory (WRITE_TOKEN_FILE_NAME). */
export const WRITE_TOKEN_FILE_NAME = 'hub-write-token'
/** The runtime file the product publishes its port in. */
export const RUNTIME_FILE_NAME = 'hub-runtime.json'

/**
 * The port band this suite asks for first.
 *
 * Above the product default's twenty-port fallback window (DEFAULT_HUB_PORT
 * 43117, PORT_FALLBACK_ATTEMPTS 20) and disjoint from the two bands
 * tests/hub/fixtures/hub-process.ts reserves for its own process-level suites
 * (43317 and 43417). The reasoning is theirs and it applies here: a released
 * loopback port is immediately a candidate for the next hub, and a band nothing
 * else in this repository uses turns a port fact into a fact rather than a race.
 * The product's own next-free fallback still applies, so a taken port is handled
 * by the product rather than by this file.
 */
export const E2E_PORT_BASE = 43_517

// ---------------------------------------------------------------------------
// The hub this run started
// ---------------------------------------------------------------------------

/** One HTTP answer, as the socket delivered it. */
export interface HubResponse<T = unknown> {
  readonly status: number
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly text: string
  readonly body: T
}

export interface StartedHub {
  /** The loopback origin the hub published, e.g. `http://127.0.0.1:43517`. */
  readonly origin: string
  readonly port: number
  readonly pid: number
  /** A temporary directory, never the developer's own. */
  readonly stateDir: string
  /** The prepared copy of the build this hub serves. */
  readonly dashboardRoot: string
  /** The install's write token, which this run chose before the hub started. */
  readonly token: string
  /** How the served document compares with the build. */
  readonly documentServedAs: DocumentServedAs
  get<T = unknown>(pathname: string): Promise<HubResponse<T>>
  postSignal<T = unknown>(signal: unknown): Promise<HubResponse<T>>
  postAck<T = unknown>(eventId: string, token?: string): Promise<HubResponse<T>>
  /** The hub's own pending count, from the route the tray badge reads. */
  pendingCount(): Promise<number>
  health(): Promise<Record<string, unknown>>
  /** Resident set size of the hub process, in bytes, or null when it cannot be read. */
  rssBytes(): number | null
  /**
   * Stop the hub, the way a service manager would, and wait for it to be gone.
   *
   * SIGTERM, not SIGKILL, so the ordered close runs: the stream ends, the runtime
   * file is released and the log is closed. A page watching the stream sees a real
   * shutdown rather than a dropped socket, and the next start against the same state
   * directory is the product's own restart path.
   */
  stop(): Promise<void>
  /** Start it again over the same state directory, on the same port. */
  start(): Promise<void>
  /** Everything this run started or wrote, so a failure can name it. */
  temporaryDirectories: readonly string[]
  close(): Promise<void>
}

/** The served document against the build, stated rather than asserted in prose. */
export interface DocumentServedAs {
  readonly builtFrom: string
  readonly servedFrom: string
  readonly builtBytes: number
  readonly servedBytes: number
  /**
   * The exact line this run inserted, indentation and newline included.
   *
   * The raw bytes rather than the trimmed element, because the check that matters is
   * a byte equality: removing this line from the served document has to leave the
   * build exactly, and a trimmed string would leave its indentation behind and fail
   * for a reason that has nothing to do with the product.
   */
  readonly insertedLine: string
  /** The same element without its indentation, for a reader of the evidence. */
  readonly insertedElement: string
  /**
   * True when removing that one line from the served document leaves the build's
   * bytes exactly. A copy that differs in any other byte is a substituted page,
   * not a served build, and this says so.
   */
  readonly identicalToBuildApartFromTheInsertedLine: boolean
  /** Why the substitution exists, in the product's own terms. */
  readonly whySubstituted: string
}

export class E2EHubError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'E2EHubError'
  }
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

export interface StartHubOptions {
  /** Overrides the first port tried. Defaults to `E2E_PORT_BASE`. */
  readonly preferredPort?: number
  /** Kept when true, so a failure can be inspected. */
  readonly keepState?: boolean
}

/**
 * Start a hub against a temporary state directory and wait until it is serving.
 *
 * Readiness is the runtime file carrying a port published by *this* pid, which is
 * the only discovery mechanism the product ships (HC-FR-01). A line on the
 * child's stdout would prove the fixture can print.
 */
export async function startHubForJourneys(options: StartHubOptions = {}): Promise<StartedHub> {
  const temporaryDirectories: string[] = []
  const stateDir = mkdtempSync(path.join(tmpdir(), 'agent-ping-e2e-state-'))
  const dashboardRoot = mkdtempSync(path.join(tmpdir(), 'agent-ping-e2e-dashboard-'))
  temporaryDirectories.push(stateDir, dashboardRoot)

  // The token is written before the hub starts, in the format the hub itself
  // issues (`randomBytes(32).toString('hex')` plus one newline), and the hub
  // reads an existing file rather than regenerating one. That is a product
  // mechanism, not a seam: the page cannot acknowledge without knowing the value
  // and the ack route cannot be satisfied without it, so a run that generated the
  // value privately would be proving a path nothing in the product can take.
  const token = randomBytes(32).toString('hex')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const tokenPath = path.join(stateDir, WRITE_TOKEN_FILE_NAME)
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600, flag: 'wx' })
  chmodSync(tokenPath, 0o600)

  const documentServedAs = prepareDashboardRoot(dashboardRoot, token)

  /**
   * One hub process, held in a box the interface reads through.
   *
   * The indirection is for one reason: `stop()` and `start()` have to replace the
   * process behind an object whose `origin` a page already has loaded, and a
   * `readonly pid` on the interface has to become the new pid. Everything else the
   * journeys read is derived from the origin and the token, neither of which changes
   * across a restart.
   */
  const live = {
    child: null as ChildProcess | null,
    origin: '',
    port: options.preferredPort ?? E2E_PORT_BASE,
    pid: 0,
  }

  const spawnHub = async (port: number): Promise<void> => {
    const child = spawn(
      process.execPath,
      [
        '--no-warnings',
        ...(process.features.typescript ? [] : ['--experimental-strip-types']),
        path.join(HERE, 'fixtures', 'dashboard-hub.mjs'),
        stateDir,
        dashboardRoot,
        String(port),
      ],
      {
        cwd: REPO_ROOT,
        // Cleared as well as overridden by the argument: a fixture that resolved a
        // developer's real state directory from an inherited variable would write
        // to their installation.
        env: { ...process.env, AGENT_PING_STATE_DIR: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.stdout.resume()
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    live.child = child
    live.pid = child.pid ?? 0

    let published: { host: string; port: number } | null = null
    try {
      published = await readRuntimeFileWhenPublished(stateDir, child.pid, exit)
    } catch (cause) {
      child.kill('SIGKILL')
      await exit.catch(() => undefined)
      if (options.keepState === true) throw cause
      for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
      throw cause
    }
    if (published === null) {
      child.kill('SIGKILL')
      await exit.catch(() => undefined)
      const message =
        `the hub fixture did not publish a port in ${stateDir} within 30 s. ` +
        `stderr: ${stderr.trim() || '(empty)'}`
      if (options.keepState === true) throw new E2EHubError(message)
      for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
      throw new E2EHubError(message)
    }
    live.origin = `http://${published.host}:${published.port}`
    live.port = published.port
  }

  await spawnHub(live.port)
  const firstOrigin = live.origin

  const origin = (): string => live.origin
  const child = (): ChildProcess | null => live.child

  const stop = async (): Promise<void> => {
    const running = child()
    if (running === null) return
    if (running.exitCode === null && running.signalCode === null) {
      // SIGTERM, not SIGKILL: the hub installs the signal handlers itself, and this
      // is the ordered close - the stream ends, the runtime file is released and the
      // log is closed - rather than a dropped socket the next run has to reclaim.
      running.kill('SIGTERM')
      const gone = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        if (running.exitCode !== null || running.signalCode !== null) {
          resolve({ code: running.exitCode, signal: running.signalCode })
        }
        running.once('exit', (code, signal) => resolve({ code, signal }))
      })
      await Promise.race([gone, sleep(15_000)])
      if (running.exitCode === null && running.signalCode === null) running.kill('SIGKILL')
    }
    live.child = null
  }

  const hub: StartedHub = {
    get origin(): string {
      return origin()
    },
    get port(): number {
      return live.port
    },
    get pid(): number {
      return live.pid
    },
    stateDir,
    dashboardRoot,
    token,
    documentServedAs,
    temporaryDirectories,
    get: <T,>(pathname: string): Promise<HubResponse<T>> => call<T>(origin(), { method: 'GET', pathname }),
    postSignal: <T,>(signal: unknown): Promise<HubResponse<T>> =>
      call<T>(origin(), { method: 'POST', pathname: '/api/ingest', body: JSON.stringify(signal) }),
    postAck: <T,>(eventId: string, ackToken?: string): Promise<HubResponse<T>> =>
      call<T>(origin(), {
        method: 'POST',
        pathname: `/api/ack/${encodeURIComponent(eventId)}`,
        headers: {
          'x-agent-ping-token': ackToken ?? token,
        },
      }),
    pendingCount: async (): Promise<number> => {
      const response = await call<{ count?: unknown }>(origin(), { method: 'GET', pathname: '/api/pending' })
      const count = response.body?.count
      return typeof count === 'number' ? count : Number.NaN
    },
    health: async (): Promise<Record<string, unknown>> => {
      const response = await call<Record<string, unknown>>(origin(), {
        method: 'GET',
        pathname: '/api/health',
      })
      return response.body
    },
    rssBytes: (): number | null => {
      const running = child()
      return running === null ? null : readRssBytes(running)
    },
    stop,
    start: async (): Promise<void> => {
      if (child() !== null) throw new E2EHubError('this hub is already running; stop it first')
      // The same port, because a page has this run's origin loaded and a hub on
      // another port is a different page. The product's own next-free fallback
      // applies, and a different port is reported rather than papered over.
      await spawnHub(live.port)
      if (origin() !== firstOrigin) {
        throw new E2EHubError(
          `the hub restarted on ${origin()} rather than on ${firstOrigin}. A page already has ` +
            `${firstOrigin} loaded, so a restart on another port is not a restart a page can recover ` +
            'from; this is reported rather than tolerated',
        )
      }
    },
    close: async (): Promise<void> => {
      await stop()
      if (options.keepState !== true) {
        for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
      }
    },
  }

  return hub
}

// ---------------------------------------------------------------------------
// The prepared dashboard root
// ---------------------------------------------------------------------------

/**
 * Copy the build and insert the one element the page reads the write token from.
 *
 * The copy rather than an interception, because a page served by something other
 * than the product's own static route would not be the claim LD-FR-10 makes. The
 * hub still serves it, over its own origin, with its own content-security policy;
 * only the directory it reads from is a copy.
 */
function prepareDashboardRoot(target: string, token: string): DocumentServedAs {
  if (!existsSync(BUILT_DASHBOARD_DOCUMENT)) {
    throw new E2EHubError(
      `the built dashboard is not present at ${BUILT_DASHBOARD_DOCUMENT}. ` +
        'Run `npm run build` first; this run serves the build and does not build it.',
    )
  }
  cpSync(BUILT_DASHBOARD_ROOT, target, { recursive: true })

  const built = readFileSync(BUILT_DASHBOARD_DOCUMENT, 'utf8')
  const insertedLine = `    <meta name="${WRITE_TOKEN_META_NAME}" content="${token}" />\n`
  const served = insertBeforeHead(built, insertedLine)
  const servedPath = path.join(target, 'index.html')
  writeFileSync(servedPath, served)

  const withoutTheLine = served.replace(insertedLine, '')
  return {
    builtFrom: BUILT_DASHBOARD_DOCUMENT,
    servedFrom: servedPath,
    builtBytes: Buffer.byteLength(built),
    servedBytes: Buffer.byteLength(served),
    insertedLine,
    insertedElement: insertedLine.trim(),
    identicalToBuildApartFromTheInsertedLine: withoutTheLine === built,
    whySubstituted:
      'the write token is an explicit input of the page (`readWriteToken`, ' +
      'ACK_TOKEN_META_NAME) and the product deliberately serves no token in any file or response ' +
      '(HC-FR-06), so a run that has to exercise the acknowledgement path has to supply it the way ' +
      'the page documents. Everything else in the served document is the build, byte for byte.',
  }
}

/** Insert one line immediately before the document's own `</head>`. */
function insertBeforeHead(document: string, line: string): string {
  const at = document.indexOf('</head>')
  if (at === -1) {
    throw new E2EHubError(
      'the built dashboard document has no </head>, so the write-token element could not be ' +
        'inserted. This is a failure and not a skip: a run that served a document it had ' +
        'rebuilt would be proving a page this product does not ship.',
    )
  }
  return `${document.slice(0, at)}${line}${document.slice(at)}`
}

// ---------------------------------------------------------------------------
// Discovery and process facts
// ---------------------------------------------------------------------------

/**
 * Poll the runtime file until *this* process has published a port in it.
 *
 * The pid is part of the condition: a crashed hub leaves its runtime file behind
 * with its own port still in it, and a waiter that only looked for "a published
 * port" would hand a journey a connection to a process that is gone.
 */
async function readRuntimeFileWhenPublished(
  stateDir: string,
  pid: number | undefined,
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<{ host: string; port: number } | null> {
  const file = path.join(stateDir, RUNTIME_FILE_NAME)
  const deadline = Date.now() + 30_000
  for (;;) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
          host?: string
          port?: number | null
          pid?: number
        }
        if (typeof parsed.host === 'string' && typeof parsed.port === 'number' && parsed.pid === pid) {
          return { host: parsed.host, port: parsed.port }
        }
      } catch {
        // Written by rename, so a partial read is not expected; the next poll settles it.
      }
    }
    // The child dying before it publishes is a failure with a real cause in it,
    // not a 30 s wait followed by a message that names nothing.
    const gone = await Promise.race([exit, sleep(50).then(() => null)])
    if (gone !== null) return null
    if (Date.now() >= deadline) return null
    await sleep(25)
  }
}

/**
 * The hub process's own resident set size, in bytes.
 *
 * Read from the kernel through `/proc`, so the number is the hub's and not this
 * worker's. Returns null where the file is absent rather than a zero, because a
 * zero would read as "the hub uses no memory" (APX-CON-11).
 */
export function readRssBytes(child: ChildProcess): number | null {
  const pid = child.pid
  if (pid === undefined) return null
  const statusPath = `/proc/${String(pid)}/status`
  if (!existsSync(statusPath)) return null
  const status = readFileSync(statusPath, 'utf8')
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
  if (match === null) return null
  const kilobytes = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : null
}

// ---------------------------------------------------------------------------
// One request over a real socket
// ---------------------------------------------------------------------------

interface CallInit {
  readonly method: 'GET' | 'POST'
  readonly pathname: string
  readonly body?: string
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * One request, one connection, over the hub's own loopback socket.
 *
 * `agent: false` because these hubs are short-lived and a pooled connection held
 * against a process that has since exited would be reused for the next request,
 * which would turn an assertion about the hub into one about connection pooling.
 */
function call<T>(origin: string, init: CallInit): Promise<HubResponse<T>> {
  const { hostname, port } = new URL(origin)
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: hostname,
        port,
        path: init.pathname,
        method: init.method,
        headers: {
          'content-type': 'application/json',
          ...(init.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(init.body)) }),
          ...(init.headers ?? {}),
        },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body: unknown = null
          try {
            body = text === '' ? null : (JSON.parse(text) as unknown)
          } catch {
            body = null
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text,
            body: body as T,
          })
        })
      },
    )
    outgoing.on('error', reject)
    if (init.body === undefined) outgoing.end()
    else outgoing.end(init.body)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}
