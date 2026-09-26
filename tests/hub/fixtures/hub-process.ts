// A real hub in a real operating-system process, driven from a test.
//
// The claims HC-5 makes are about a *process*, not about a function: a hub that is
// killed while a block is pending and replays that block after a restart, and a hub
// that is sent a termination signal and leaves no listener, no runtime file and an
// openable database. Both are proven by starting `tests/hub/fixtures/signal-hub.mjs`
// through the real `src/main/index.ts` in a second process and watching what happens to
// it from outside, because an in-process test could assert all the same internal
// effects in a world where no signal was ever delivered and no restart ever happened.
//
// What this helper adds over a raw `spawn`:
//   - discovery the way an adapter does it, by polling the runtime file for a
//     published port rather than by trusting a line on the child's stdout
//   - an attempts file the child's notifier appends to, so "the pipeline attempted a
//     delivery" is evidence that outlives the process that made it
//   - exit observation that cannot be faked: a signal, a code, and a wait
//   - a guarantee that no child outlives the test file, because a leaked hub would
//     hold a loopback port and a runtime file in a temporary directory that is about to
//     be deleted

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..', '..', '..')
const FIXTURES = HERE

/** One line of the child's attempts file, as the notifier received it. */
export interface AttemptLine {
  readonly at: string
  readonly pid: number
  readonly eventId: string
  readonly class: string
  readonly source: 'event' | 'restart-replay'
  readonly pendingCount: number
  readonly repoShortName: string | null
  readonly origin: string
}

export interface Fetched {
  readonly status: number
  readonly text: string
  json<T = unknown>(): T
}

export interface RealHub {
  readonly pid: number
  readonly origin: string
  readonly port: number
  readonly stateDir: string
  readonly attemptsFile: string
  readonly child: ChildProcess
  readonly stderr: () => string
  attempts(): readonly AttemptLine[]
  waitForAttempts(count: number, timeoutMs?: number): Promise<readonly AttemptLine[]>
  get(pathname: string): Promise<Fetched>
  post(pathname: string, body: unknown): Promise<Fetched>
  /** Deliver a real signal to the process. */
  signal(signal: NodeJS.Signals): void
  /** How the process ended, resolved once it has. */
  waitForExit(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

/** Every hub this module started, so none can outlive the test file. */
const running: RealHub[] = []
let reaperInstalled = false

/**
 * Kill anything still running.
 *
 * Called from a test file's `afterEach`, and also from this process's own exit: a
 * child left behind would keep a loopback port bound and a runtime file in a directory
 * the next test is about to delete, which is a confusing failure in a test that is not
 * about either.
 */
export async function stopStrayHubs(): Promise<void> {
  const strays = running.splice(0)
  await Promise.all(
    strays.map(async (hub) => {
      if (hub.child.exitCode !== null || hub.child.signalCode !== null) return
      hub.child.kill('SIGKILL')
      await hub.waitForExit(5_000).catch(() => undefined)
    }),
  )
}

function installReaper(): void {
  if (reaperInstalled) return
  reaperInstalled = true
  process.on('exit', () => {
    for (const hub of running) {
      if (hub.child.exitCode === null && hub.child.signalCode === null) {
        try {
          hub.child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
  })
}

/**
 * The port bands these process-level hubs are given, one per suite.
 *
 * Both start a hundred ports above the product default's twenty-port fallback window
 * (DEFAULT_HUB_PORT 43117, PORT_FALLBACK_ATTEMPTS 20), and they are disjoint from each
 * other. That is not cosmetic. One of the claims these hubs are started for is "nothing
 * answers the port this hub published once it has exited", and a released loopback port
 * is immediately a candidate for the next hub that starts: with both suites on the
 * default band, a hub in the other test file can take the port between the process
 * exiting and the assertion, and the assertion then reports a squatter rather than an
 * orphaned listener. Disjoint bands make the released port reachable by nothing else in
 * the repository, so the assertion is a fact about a port rather than a race between
 * two unrelated tests.
 *
 * A suite passes its own through `preferredPort`; nothing here is a product default and
 * no adapter ever reads these numbers.
 */
export const RESTART_REPLAY_PORT_BASE = 43_317
export const SHUTDOWN_PORT_BASE = 43_417

export interface StartRealHubOptions {
  /** A temporary state directory. One is made when this is absent. */
  readonly stateDir?: string
  /** Where the child's notifier appends one line per attempt. */
  readonly attemptsFile?: string
  /** `ok` delivers, `fail` throws after recording, `none` is not wired at all. */
  readonly notifier?: 'ok' | 'fail' | 'none'
  /** The fixture to run. Defaults to the one this module exists for. */
  readonly fixture?: string
  /**
   * The first port the child tries. Absent means the product default, which is the
   * honest choice for a fixture that is not asserting anything about a released port -
   * and a contention-prone one for a fixture that is.
   */
  readonly preferredPort?: number
  /** Directories created here, so a caller can delete them. */
  readonly temporaryDirectories?: string[]
}

/**
 * Start a hub in a second process and wait until it is serving.
 *
 * Readiness is the runtime file carrying a published port, which is the only
 * discovery mechanism the product actually ships: a line on stdout would prove that
 * the fixture can print, not that an adapter could find the hub (HC-FR-01).
 */
export async function startRealHub(options: StartRealHubOptions = {}): Promise<RealHub> {
  installReaper()
  const stateDir = options.stateDir ?? temporary('agent-ping-hub-', options)
  // The attempts file lives inside its own directory so a caller that did not name one
  // still has a path it can delete without reaching into a shared temporary root.
  const attemptsPath =
    options.attemptsFile ?? path.join(temporary('agent-ping-attempts-', options), 'attempts.jsonl')
  const fixture = options.fixture ?? 'signal-hub.mjs'

  const nodeArgs = [
    '--no-warnings',
    ...(process.features.typescript ? [] : ['--experimental-strip-types']),
    path.join(FIXTURES, fixture),
    stateDir,
    attemptsPath,
    options.notifier ?? 'ok',
    // Empty rather than omitted when there is no preference, so the fixture's argument
    // list is the same shape every time and an absent value is one the child can tell
    // from a port.
    options.preferredPort === undefined ? '' : String(options.preferredPort),
  ]
  const child = spawn(process.execPath, nodeArgs, {
    cwd: REPO_ROOT,
    // The state directory is passed as an argument, but the environment is cleared of
    // the override as well: a fixture that resolved the developer's real state
    // directory from an inherited variable would write to their installation.
    env: { ...process.env, AGENT_PING_STATE_DIR: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  child.stdout.resume()

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })

  const published = await readRuntimeFileWhenPublished(stateDir, child.pid)
  if (published === null) {
    child.kill('SIGKILL')
    throw new Error(
      `the hub fixture did not publish a port in ${stateDir}. stderr: ${stderr.trim() || '(empty)'}`,
    )
  }

  const hub: RealHub = {
    pid: child.pid ?? 0,
    origin: `http://${published.host}:${published.port}`,
    port: published.port,
    stateDir,
    attemptsFile: attemptsPath,
    child,
    stderr: (): string => stderr,
    attempts: (): readonly AttemptLine[] => readAttempts(attemptsPath),
    waitForAttempts,
    get: (pathname: string): Promise<Fetched> =>
      call(`http://${published.host}:${published.port}`, { method: 'GET', pathname }),
    post: (pathname: string, body: unknown): Promise<Fetched> =>
      call(`http://${published.host}:${published.port}`, {
        method: 'POST',
        pathname,
        body: JSON.stringify(body),
      }),
    signal: (signal: NodeJS.Signals): void => {
      child.kill(signal)
    },
    waitForExit: async (timeoutMs = 20_000) => {
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`the hub fixture did not exit within ${timeoutMs} ms: ${stderr}`))
        }, timeoutMs)
        timer.unref()
      })
      return Promise.race([exit, timeout])
    },
  }
  running.push(hub)

  async function waitForAttempts(count: number, timeoutMs = 20_000): Promise<readonly AttemptLine[]> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = readAttempts(attemptsPath)
      if (found.length >= count) return found
      await sleep(20)
    }
    throw new Error(
      `expected ${count} delivery attempt(s) in ${attemptsPath} and saw ${readAttempts(attemptsPath).length} ` +
        `within ${timeoutMs} ms. stderr: ${stderr.trim() || '(empty)'}`,
    )
  }

  return hub
}

/**
 * A temporary directory, handed to the caller so it can be removed.
 *
 * The caller owns the cleanup rather than this module, because the test file's
 * `afterEach` is where every other temporary thing in these suites is removed, and two
 * cleanup places is one too many.
 */
function temporary(prefix: string, options: StartRealHubOptions): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  options.temporaryDirectories?.push(directory)
  return directory
}

/**
 * Poll the runtime file until *this* process has published a port in it.
 *
 * Polling the file rather than the child's stdout, because the runtime file is the
 * discovery mechanism the product actually ships (HC-FR-01), and a line on stdout would
 * only prove the fixture can print.
 *
 * The pid is part of the condition, and it is the half that matters after a kill: a
 * crashed hub leaves its runtime file behind with its own port still in it, and a
 * restart reclaims that file. A waiter that only looked for "a published port" would
 * find the dead process's port and hand the test a connection to a process that is
 * gone - which is a test that passes its own readiness check and then fails every
 * request it makes. So this waits for the record to name the process that was started.
 */
async function readRuntimeFileWhenPublished(
  stateDir: string,
  pid: number | undefined,
): Promise<{ host: string; port: number } | null> {
  const file = path.join(stateDir, 'hub-runtime.json')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
          host?: string
          port?: number | null
          pid?: number
        }
        if (
          typeof parsed.host === 'string' &&
          typeof parsed.port === 'number' &&
          parsed.pid === pid
        ) {
          return { host: parsed.host, port: parsed.port }
        }
      } catch {
        // Written by rename, so a partial read is not expected; the next poll settles it.
      }
    }
    await sleep(25)
  }
  return null
}

function readAttempts(file: string): readonly AttemptLine[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as AttemptLine)
}

interface CallInit {
  readonly method: string
  readonly pathname: string
  readonly body?: string
}

/**
 * One request over a real socket, one connection.
 *
 * `agent: false` because these hubs are short-lived and a pooled connection held
 * against a process that has since exited would be reused for the next request, which
 * would turn a restart assertion into a test about connection pooling.
 */
function call(origin: string, init: CallInit): Promise<Fetched> {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

/** Remove a state directory and everything in it. */
export function removeDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true })
}
