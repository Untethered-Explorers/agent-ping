// Talking to a running hub from outside its process: the runtime file, the loopback read
// routes, and the one place this product starts a second copy of itself (IO-2).
//
// WHY A COMMAND READS THE RUNTIME FILE AND NEVER GUESSES A PORT
// The hub prefers 43117 and falls back to the next free port (HC-1). An adapter finds the
// live port in `hub-runtime.json`, and so does every command here: a `doctor` that probed
// only 43117 would report a port problem on every machine where something else already
// held the default, and report nothing on the machines that matter. The runtime file is
// the product's own published record, and it is the only thing a second process is
// allowed to believe (APX-CON-12: no outbound call other than to the loopback hub).
//
// EVERY FAILURE IS ITS OWN ANSWER
// `HubReading` is a closed union with seven members rather than a nullable object, because
// "there is no runtime file", "a hub is starting", "the file points at a port nothing is
// serving" and "something else is on that port" are four different faults with four
// different remedies. A caller that collapsed them would tell a developer to delete a
// runtime file that is a live pointer (APX-FR-02).
//
// TWO IDENTITIES, AND THE DIFFERENCE IS LOAD-BEARING
// The runtime file names an `instanceId` and the health payload names one too. A response
// whose instance differs is *not this product's hub*, and reporting it as the hub would
// mean a `status` that reads another program's numbers. It is its own answer, and it is
// the case the loopback security boundary (ADR-002) exists for.
//
// THIS MODULE OPENS A LOOPBACK SOCKET AND NOTHING ELSE
// Every request is a GET to a host that has already been checked to be loopback, so the
// boundary is enforced at the call site rather than trusted from a file. No token is sent
// and no write route is reached: the read routes are unauthenticated by design
// (HC-FR-02), and a command that needed to write would be a second control surface
// (APX-CON-08).

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHROMIUM_LAUNCH_ENVIRONMENT } from '../notify/surface/electron-host.js'
import type { HealthPayload } from '../hub/routes/read.js'
import { DEFAULT_HUB_PORT, LOOPBACK_HOST } from '../hub/server.js'
import { isLoopbackAddress } from '../hub/security.js'
import {
  isProcessAlive,
  readRuntimeFile,
  runtimeFilePath,
  type RuntimeFile,
} from '../hub/runtime-file.js'

/** How long one loopback read may take before it is a failure rather than a hang. */
export const HUB_READ_TIMEOUT_MS = 2_000

/** How long `install` waits for a hub it just started to publish a port. */
export const HUB_START_TIMEOUT_MS = 20_000

/** How often `install` looks while waiting. Not a poll of a file's mtime: a read. */
export const HUB_START_POLL_MS = 250

/**
 * The pause before the one health-read retry.
 *
 * Short enough that a command does not feel it and long enough that a socket the
 * operating system was still tearing down has finished being torn down.
 */
export const HUB_READ_RETRY_MS = 150

/**
 * The session states that count as active.
 *
 * A developer's question is "is anything of mine running right now", and a session that
 * is `finished`, `gone`, `idle-after-nothing` or `unknown` is not. Naming the two states
 * rather than counting every row is what makes the number mean something; a count of all
 * sessions is a count of history.
 */
export const ACTIVE_SESSION_STATES: readonly string[] = ['running', 'blocked']

/** The session states `readStatus` reports, so a caller can print the same rule. */
export function isActiveSessionState(state: string): boolean {
  return ACTIVE_SESSION_STATES.includes(state)
}

/** Why a command could not reach a running hub. One remedy each. */
export type HubUnreachableKind =
  /** No runtime file: this machine has never run the hub, or it shut down cleanly. */
  | 'no-runtime-file'
  /** A runtime file exists with no port in it: a hub is starting. */
  | 'still-starting'
  /** A runtime file exists and names a port nothing is serving. */
  | 'stale-runtime-file'
  /** The file is not a runtime file this build can read. */
  | 'unreadable-runtime-file'
  /** Something is holding the published port and is not this product's hub. */
  | 'port-held-elsewhere'
  /** The request was made and refused before a response. */
  | 'refused'
  /** The hub answered, but not with health. */
  | 'http-error'
  /** The hub answered health with a different instance's identity. */
  | 'not-this-hub'

/** One unreachable answer: what happened, in one sentence, and what to do about it. */
export interface HubUnreachable {
  readonly kind: HubUnreachableKind
  readonly detail: string
  readonly remedy: string
}

/** Everything `status` reports about a hub that is answering, and nothing else. */
export interface HubStatusReport {
  readonly running: true
  readonly origin: string
  readonly port: number
  readonly instanceId: string
  readonly startedAt: string
  readonly uptimeSeconds: number
  readonly pendingCount: number
  /** The newest stored event's occurrence time, or null when the log is empty. */
  readonly lastEventAt: string | null
  /** Sessions in `running` or `blocked`. */
  readonly activeSessions: number
  /** Every session the log knows about, so the two numbers can be compared. */
  readonly totalSessions: number
  /** The delivery policy's own status, verbatim: `ok`, `degraded` or `not-wired`. */
  readonly deliveryStatus: 'ok' | 'degraded' | 'not-wired'
  readonly deliveryLastFailure: string | null
}

/** The answer to "is there a hub, and what is it saying". */
export type HubReading =
  | { readonly kind: 'running'; readonly record: RuntimeFile; readonly health: HealthPayload }
  | { readonly kind: 'down'; readonly failure: HubUnreachable }

export interface HubReadOptions {
  readonly stateDir: string
  readonly timeoutMs?: number
  /** Injectable so a test can answer without a socket; defaults to a loopback GET. */
  readonly fetchHealth?: (origin: string) => Promise<HealthPayload | HubUnreachable>
}

/**
 * One loopback GET, parsed, with the failure shapes named.
 *
 * A `request` is used rather than `fetch` because this has to distinguish a refused
 * connection from a 404 and from a body that is not JSON, and because a loopback read
 * with an injected timeout is clearer as a socket with a timer.
 */
async function getLoopbackJson(
  origin: string,
  pathname: string,
  timeoutMs: number,
): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly failure: HubUnreachable }> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (answer: { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly failure: HubUnreachable }): void => {
      if (settled) return
      settled = true
      resolve(answer)
    }
    const request = httpRequest(`${origin}${pathname}`, { method: 'GET' }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (response.statusCode !== 200) {
          finish({
            ok: false,
            failure: {
              kind: 'http-error',
              detail: `the hub at ${origin} answered ${String(response.statusCode ?? 'no status')} for ${pathname}`,
              remedy: 'run `agent-ping status` again; if it keeps answering that, the hub on this port is not a working agent-ping',
            },
          })
          return
        }
        try {
          finish({ ok: true, body: JSON.parse(text) as unknown })
        } catch {
          finish({
            ok: false,
            failure: {
              kind: 'http-error',
              detail: `the hub at ${origin} answered ${pathname} with something that is not JSON`,
              remedy: 'another program is serving this port; stop it, or let agent-ping bind the next free port',
            },
          })
        }
      })
    })
    request.setTimeout(timeoutMs, () => {
      request.destroy()
      finish({
        ok: false,
        failure: {
          kind: 'refused',
          detail: `the hub at ${origin} did not answer ${pathname} within ${String(timeoutMs)} ms`,
          remedy: 'run `agent-ping doctor`; a hub that is bound but not answering is a different fault from one that is not running',
        },
      })
    })
    request.on('error', (cause) => {
      finish({
        ok: false,
        failure: {
          kind: 'refused',
          detail: `the hub at ${origin} could not be reached for ${pathname} (${codeOf(cause)})`,
          remedy: 'run `agent-ping doctor`; it reports whether the hub is running and what holds its port',
        },
      })
    })
    request.end()
  })
}

/**
 * The health of the hub a state directory points at, or a named reason it cannot be had.
 *
 * The order is the product's own: the runtime file decides *whether* there is a hub, the
 * port it publishes decides *where*, and the instance identity decides *whose*. A command
 * never invents a port and never reports another process's numbers as this product's.
 */
export async function readHub(options: HubReadOptions): Promise<HubReading> {
  let record: RuntimeFile | null
  try {
    record = readRuntimeFile(options.stateDir)
  } catch (cause) {
    return {
      kind: 'down',
      failure: {
        kind: 'unreadable-runtime-file',
        detail: `the hub runtime file at ${runtimeFilePath(options.stateDir)} exists but cannot be read (${nameOf(cause)})`,
        remedy: `delete ${runtimeFilePath(options.stateDir)} once you have confirmed no hub is running, then start agent-ping again`,
      },
    }
  }
  if (record === null) {
    return {
      kind: 'down',
      failure: {
        kind: 'no-runtime-file',
        detail: `there is no hub runtime file at ${runtimeFilePath(options.stateDir)}, so no hub has published a port from this state directory`,
        remedy: 'start agent-ping (the tray icon, or the autostart unit) and run this command again',
      },
    }
  }
  if (record.port === null) {
    return {
      kind: 'down',
      failure: {
        kind: 'still-starting',
        detail: `a hub has claimed ${runtimeFilePath(options.stateDir)} (pid ${String(record.pid)}) but has not published a port yet`,
        remedy: 'wait a moment and run this command again; a hub that never publishes a port is reported by `agent-ping doctor`',
      },
    }
  }
  if (!isLoopbackAddress(record.host)) {
    return {
      kind: 'down',
      failure: {
        kind: 'unreadable-runtime-file',
        detail: `the hub runtime file names host ${JSON.stringify(record.host)}, which is not a loopback address`,
        remedy: `delete ${runtimeFilePath(options.stateDir)} once you have confirmed no hub is running; agent-ping only ever binds 127.0.0.1`,
      },
    }
  }

  const origin = `http://${record.host}:${String(record.port)}`
  const health = options.fetchHealth
    ? await options.fetchHealth(origin)
    : await fetchHealthOverLoopback(origin, options.timeoutMs ?? HUB_READ_TIMEOUT_MS)
  if ('kind' in health) return { kind: 'down', failure: classifyRefusal(health, record) }

  if (health.instanceId !== record.instanceId) {
    return {
      kind: 'down',
      failure: {
        kind: 'not-this-hub',
        detail: `${origin} answered health for instance ${health.instanceId}, but ${runtimeFilePath(options.stateDir)} names ${record.instanceId}`,
        remedy: `stop the program serving ${origin} so agent-ping can take the port, or remove ${runtimeFilePath(options.stateDir)} if no hub is running`,
      },
    }
  }
  return { kind: 'running', record, health }
}

/**
 * A refused connection is two different faults, and the recorded pid is what tells them
 * apart.
 *
 * A runtime file whose process is gone is a file left by a crash or a kill, and the
 * remedy is to remove it: the next start reclaims it anyway (APX-CON-03), so leaving it
 * only makes every command report a hub that is not there. A file whose process is still
 * running on a port nothing is serving is a live program this product must not displace,
 * and the remedy is to find out what it is rather than delete the pointer. Collapsing
 * the two would send a developer to delete a live lock.
 */
function classifyRefusal(failure: HubUnreachable, record: RuntimeFile): HubUnreachable {
  if (failure.kind !== 'refused') return failure
  if (isProcessAlive(record.pid)) return failure
  return {
    kind: 'stale-runtime-file',
    detail: `the hub runtime file names pid ${String(record.pid)} on port ${String(record.port)}, and that process is no longer running`,
    remedy: `delete ${runtimeFilePath(record.stateDir)}; the next start of agent-ping reclaims a runtime file left by a dead process (APX-CON-03)`,
  }
}

/**
 * The health payload over a real loopback socket, or the reason there was none.
 *
 * ONE RETRY, AND ONLY ON A CONNECTION-LEVEL FAILURE. A hub that has just bound a port
 * this machine used moments ago can have the first connection to it reset by the
 * operating system, which is observable and reproducible on this checkout: start a hub,
 * close it, bind the same port again and the first loopback GET comes back ECONNRESET
 * while the second succeeds. A diagnostic that reported that as "the hub is not running"
 * would be wrong, and a developer chasing it would be sent to look at a process that is
 * serving. So one retry, after a short pause, for a connection-level failure only. A hub
 * that genuinely cannot answer fails both attempts and is reported exactly as before -
 * nothing here can turn a fault into a pass.
 */
export async function fetchHealthOverLoopback(
  origin: string,
  timeoutMs: number = HUB_READ_TIMEOUT_MS,
  retryDelayMs: number = HUB_READ_RETRY_MS,
): Promise<HealthPayload | HubUnreachable> {
  const first = await getLoopbackJson(origin, '/api/health', timeoutMs)
  if (first.ok) return first.body as HealthPayload
  if (first.failure.kind !== 'refused') return first.failure
  await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs))
  const second = await getLoopbackJson(origin, '/api/health', timeoutMs)
  return second.ok ? (second.body as HealthPayload) : second.failure
}

/** One bounded array out of a read payload, or null when the route refused or changed. */
async function getLoopbackArray(
  origin: string,
  pathname: string,
  key: string,
  timeoutMs: number,
): Promise<readonly unknown[] | null> {
  const answer = await getLoopbackJson(origin, pathname, timeoutMs)
  if (!answer.ok || !isRecord(answer.body)) return null
  const value = answer.body[key]
  return Array.isArray(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The four numbers `status` reports, read from the routes that own them.
 *
 * Each fact comes from the route that already owns it: the pending count is the badge's
 * own accessor over the same route, the newest event is one row of the bounded history,
 * and the session states are the session list. Nothing is re-derived here, so a number
 * `status` prints and the same number on the dashboard cannot disagree.
 *
 * Every read is allowed to be refused. The health payload already carries the pending
 * count and the uptime, so a route that will not answer costs precision rather than the
 * whole report - and a `status` that printed nothing because one read failed would be a
 * worse tool than one that says what it could and what it could not.
 */
export async function readStatus(options: HubReadOptions): Promise<
  ({ readonly kind: 'running' } & HubStatusReport) | { readonly kind: 'down'; readonly failure: HubUnreachable }
> {
  const reading = await readHub(options)
  if (reading.kind === 'down') return reading
  const { health, record } = reading
  const origin = `http://${record.host}:${String(record.port)}`
  const timeoutMs = options.timeoutMs ?? HUB_READ_TIMEOUT_MS

  const pending = await getLoopbackArray(origin, '/api/pending', 'items', timeoutMs)
  const events = await getLoopbackArray(origin, '/api/events?limit=1', 'events', timeoutMs)
  const sessions = await getLoopbackArray(origin, '/api/sessions', 'sessions', timeoutMs)

  const pendingCount = pending === null ? (health.database.pendingCount ?? 0) : pending.length
  // The history route is newest first, so the first row is the most recent event; a
  // limit of 1 is what keeps this read bounded however long the log is (HC-FR-02).
  const newest = Array.isArray(events) ? events[0] : undefined
  const lastEventAt =
    isRecord(newest) && typeof newest['occurredAt'] === 'string' ? newest['occurredAt'] : null
  const summaries = sessions ?? []
  let activeSessions = 0
  for (const entry of summaries) {
    if (isRecord(entry) && typeof entry['state'] === 'string' && isActiveSessionState(entry['state'])) {
      activeSessions += 1
    }
  }
  const failure = health.delivery.lastFailure
  // `record.port` is `number | null` on the record and non-null here, because
  // `readHub` refuses a record with no port in it before it ever reads health.
  const port = record.port ?? DEFAULT_HUB_PORT
  return {
    kind: 'running',
    running: true,
    origin,
    port,
    instanceId: record.instanceId,
    startedAt: record.startedAt,
    uptimeSeconds: health.uptimeSeconds,
    pendingCount,
    lastEventAt,
    activeSessions,
    totalSessions: summaries.length,
    deliveryStatus: health.delivery.status,
    deliveryLastFailure:
      failure === null || typeof failure.reason !== 'string' ? null : failure.reason,
  }
}

// ---------------------------------------------------------------------------
// Starting the hub
// ---------------------------------------------------------------------------

/**
 * What one attempt to start the hub did.
 *
 * `started` is the only claim here: the launcher reports that it launched a process, not
 * that a hub is serving. `install` waits for health separately, because a process that
 * exited a millisecond later and a process that is serving are different outcomes and
 * only one of them is an install.
 */
export interface HubLaunchOutcome {
  readonly started: boolean
  readonly pid: number | null
  readonly detail: string
  /** The command's own argv, for a diagnostic that says what was launched. */
  readonly command: string
}

export interface HubLauncher {
  launch(): Promise<HubLaunchOutcome>
}

export interface HubLauncherOptions {
  readonly env?: NodeJS.ProcessEnv
  /** The Electron binary. Defaults to what the `electron` package resolves to. */
  readonly electronPath?: string
  /** The package directory Electron loads `main` from. */
  readonly packageRoot?: string
  /** Injectable for a test; defaults to `child_process.spawn`. */
  readonly spawnImpl?: typeof spawn
}

/**
 * This package's own root, found by walking up to the manifest that names it.
 *
 * Two layouts have to work and neither can be assumed: `dist/main/cli/hub-client.js` in an
 * installed package, and `src/cli/hub-client.ts` in a checkout. A fixed number of `..`
 * segments gets one of them right and the other catastrophically wrong, so the search is
 * for the manifest rather than for a distance.
 */
export function findPackageRoot(from: string = path.dirname(fileURLToPath(import.meta.url))): string {
  let directory = from
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(directory, 'package.json')
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'))
      if (isRecord(parsed) && parsed['name'] === 'agent-ping') return directory
    } catch {
      // Not here, or not readable: keep walking.
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return from
}

/**
 * The product version, read out of the same manifest.
 *
 * The version is never guessed and never hard-coded: `install` writes it into the plugin
 * file's own header, and the header is what the *next* install reads to decide whether
 * the installed plugin is this product's. A wrong version here is how a developer ends up
 * debugging a build that is not the one on their disk.
 */
export function readProductVersion(from: string = findPackageRoot()): string {
  const manifest = path.join(from, 'package.json')
  const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
  const version = isRecord(parsed) ? parsed['version'] : undefined
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error(
      `the package manifest at ${manifest} declares no version, and agent-ping writes that ` +
        'version into the plugin file it installs. A file with no version cannot be recognised ' +
        'by the next install.',
    )
  }
  return version
}

/** The Electron binary this package installed, or null when it cannot be resolved. */
export function resolveElectronPath(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const resolved: unknown = require('electron')
    return typeof resolved === 'string' && resolved.trim() !== '' ? resolved : null
  } catch {
    return null
  }
}

/**
 * Start the hub the way the autostart unit will, in a process that outlives this one.
 *
 * Detached and unref'd, because `install` is a command that exits and the hub is a
 * sidecar that does not (APX-CON-03). The Chromium launch policy travels in the
 * environment, read from the product's own table rather than restated here: Chromium
 * decides about the process sandbox before any JavaScript in this package runs, so this
 * is the only form that can reach a process this command starts (NT-FR-04, PRD 16
 * Open Question 13).
 */
export function createHubLauncher(options: HubLauncherOptions = {}): HubLauncher {
  const env = options.env ?? process.env
  const electronPath = options.electronPath ?? resolveElectronPath()
  const packageRoot = options.packageRoot ?? findPackageRoot()
  const spawnProcess = options.spawnImpl ?? spawn
  return {
    launch: (): Promise<HubLaunchOutcome> => {
      const command = `${electronPath ?? 'electron'} ${packageRoot}`
      if (electronPath === null) {
        return Promise.resolve({
          started: false,
          pid: null,
          detail:
            `the Electron runtime could not be resolved from ${packageRoot}, so agent-ping cannot ` +
            'start itself',
          command,
        })
      }
      return new Promise<HubLaunchOutcome>((resolve) => {
        let child: ChildProcess
        try {
          child = spawnProcess(electronPath, [packageRoot], {
            // The launch policy's environment form, in one place: the product's own
            // table, not a restatement that could drift from it.
            env: { ...env, ...CHROMIUM_LAUNCH_ENVIRONMENT },
            detached: true,
            stdio: 'ignore',
          })
        } catch (cause) {
          resolve({
            started: false,
            pid: null,
            detail: `agent-ping could not be launched (${codeOf(cause)})`,
            command,
          })
          return
        }
        child.once('error', (cause) => {
          resolve({
            started: false,
            pid: null,
            detail: `agent-ping could not be launched (${codeOf(cause)})`,
            command,
          })
        })
        child.once('spawn', () => {
          const pid = child.pid ?? null
          if (pid !== null) child.unref()
          resolve({
            started: true,
            pid,
            detail: `launched ${command}`,
            command,
          })
        })
      })
    },
  }
}

/**
 * Wait for a hub to publish a port and answer health.
 *
 * A deadline rather than a fixed number of attempts, because the answer a caller needs is
 * "is it up yet", and a hub that is not up yet is a hub that is still starting. The
 * returned reading is the last one observed, so a caller can report the real reason
 * rather than "it did not come up".
 */
export async function waitForHub(options: {
  readonly stateDir: string
  readonly timeoutMs?: number
  readonly pollMs?: number
  readonly read?: () => Promise<HubReading>
  readonly delay?: (ms: number) => Promise<void>
}): Promise<HubReading> {
  const timeoutMs = options.timeoutMs ?? HUB_START_TIMEOUT_MS
  const pollMs = options.pollMs ?? HUB_START_POLL_MS
  const read = options.read ?? ((): Promise<HubReading> => readHub({ stateDir: options.stateDir }))
  const delay = options.delay ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))
  const deadline = Date.now() + timeoutMs
  let last: HubReading = await read()
  while (Date.now() < deadline) {
    if (last.kind === 'running') return last
    await delay(pollMs)
    last = await read()
  }
  return last
}

/** The port the hub prefers, named so a command can say which one it meant. */
export const PREFERRED_HUB_PORT = DEFAULT_HUB_PORT

/** The only host the hub ever binds, restated for a message that names it. */
export const HUB_HOST = LOOPBACK_HOST

/**
 * Can this process bind the preferred port right now?
 *
 * Asked only when no hub is running, and only so the check can say *why* the live port
 * will not be the documented one. The answer is a fact about this instant, which is why
 * it is a note on a passing check rather than a check of its own: the hub falls back to
 * the next free port (HC-1), so an occupied preferred port does not stop this product
 * working. A runbook reviewer breaking the port deliberately needs the port and the way
 * to find its holder, and this is where both come from.
 *
 * `unknown` is a real answer and is reported as such: a machine whose network stack
 * refuses the probe outright is not a machine on which to claim the port is free.
 */
export type PortAvailability = 'free' | 'in-use' | 'unknown'

export function probePortAvailability(port: number = PREFERRED_HUB_PORT): Promise<PortAvailability> {
  const probe = createServer()
  return new Promise<PortAvailability>((resolve) => {
    let settled = false
    const finish = (answer: PortAvailability): void => {
      if (settled) return
      settled = true
      resolve(answer)
    }
    probe.once('error', (cause) => {
      probe.close()
      // EADDRINUSE is the answer we came for; anything else is a probe that could not
      // run, which is not the same thing as a free port.
      finish(codeOf(cause) === 'EADDRINUSE' ? 'in-use' : 'unknown')
    })
    probe.listen({ host: LOOPBACK_HOST, port, exclusive: true }, () => {
      probe.close(() => {
        finish('free')
      })
    })
  })
}

/** The way to find what holds a port, per platform. A command, not a guess. */
export function portHolderCommand(port: number, platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin':
      return `lsof -nP -iTCP:${String(port)} -sTCP:LISTEN`
    case 'win32':
      return `netstat -ano | findstr :${String(port)}`
    default:
      return `ss -ltnp | grep :${String(port)}`
  }
}

function codeOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    return String((cause as { code?: unknown }).code ?? 'unknown')
  }
  return 'unknown'
}

function nameOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'name' in cause) {
    return String((cause as { name?: unknown }).name)
  }
  return 'unknown'
}
