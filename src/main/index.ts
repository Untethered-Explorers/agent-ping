// The Electron main process: agent-ping's composition root (HC-FR-01).
//
// Everything this product is made of is wired here and nowhere else. The order is
// the design:
//
//   1. the state directory, through the one resolver in src/storage/paths.ts
//   2. the runtime file, which is the lock - so a second instance is refused
//      before it can open the same log
//   3. the durable store, then the counters over the same file
//   4. the state change feed, wrapped around the store, so every transition the
//      store applies becomes a frame for the dashboards already watching
//   5. the route registry, with every route registered in one array
//   6. the loopback server, which chooses the live port
//   7. the runtime file again, this time with that port in it
//   8. the desktop shell: window, tray, quit
//
// Each step exists so a later step cannot run in a half-started hub. If the store
// will not open, nothing is listening and no file claims a port. If the port
// cannot be bound, the runtime file is released rather than left advertising a hub
// that does not exist. An adapter that reads a runtime file with no port in it
// finds a hub that is still starting, which it can retry; an adapter that finds a
// stale port would be talking to whatever else on this machine answers there, which
// it must never do.
//
// WHY THE ELECTRON SPECIFICS ARE INJECTED
// The composition is a function of its collaborators, and the desktop shell is one
// of them. That is what lets the real entry point be started by a test on a machine
// with no display, against a temporary state directory, over a real socket - which
// is the only way to prove the address check, the port fallback and the refusals.
// The Electron calls themselves are in `startElectronMain` at the bottom, behind a
// dynamic import of the runtime `electron` module, so importing this file in plain
// Node - for a test, for the CLI, for a verification script - does not require
// Electron to be installed at all.
//
// WHAT IS NOT HERE YET
// Ingest, the ack route, delivery policy, the notifier and the tray arrive in
// HC-3 through HC-5 and NT-2. The seams they need are already in place:
// `registerRoutes` is the single registration point, `close` is the single
// shutdown path the lifecycle work will call, and `desktop.mountTray` is where the
// tray will be mounted. What is deliberately absent is any route that can spawn,
// steer, interrupt, prompt or approve anything inside a harness (APX-CON-08): the
// mutating set in src/hub/server.ts has exactly one member and it is not
// registered here.
//
// The live state stream (HC-2) is wired here rather than inside the store, which
// is what keeps ingest and ack from having to know it exists: they call the
// store's accessors, and the frames follow. The feed is closed before the
// listener in the shutdown order below, so a stream is never left pointing at a
// store that has already been closed.
//
// agent-ping is a sidecar. It observes agent processes and owns none of them
// (APX-CON-03, ADR-001), so nothing in this file starts, stops or signals anything
// outside this process.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openCounters, type Counters } from '../storage/counters.js'
import { openEventStore, type EventStore } from '../storage/eventStore.js'
import { databaseFilePath, ensureStateDir, resolveStateDir } from '../storage/paths.js'
import { READ_ROUTES, type HubIdentity, type HubServices } from '../hub/routes/read.js'
import { STREAM_ROUTES } from '../hub/routes/stream.js'
import {
  createChangeFeed,
  withChangeFeed,
  type ChangeFeed,
  type StreamSettings,
} from '../hub/sse.js'
import {
  createDashboardRoute,
  startServer,
  DEFAULT_HUB_PORT,
  LOOPBACK_HOST,
  RouteRegistry,
  type HubServer,
} from '../hub/server.js'
import {
  claimHubInstance,
  type HubInstanceClaim,
  type RuntimeFile,
} from '../hub/runtime-file.js'

/**
 * The desktop shell the hub runs inside.
 *
 * Every member is optional and none of them is required for the hub to serve a
 * read route, because a headless run is a supported run: a test, `agent-ping
 * status`, and a verification script all read the same loopback origin this
 * process serves. The Electron entry point supplies the members that make it an
 * application; everything else is a local daemon.
 */
export interface DesktopBridge {
  /**
   * Electron's own single-instance lock.
   *
   * Checked in addition to, and before, the runtime file. The two are not
   * redundant: Electron's lock is per-application and per-user and stops a second
   * *window*; the runtime file is the product's own record and is what an adapter,
   * a CLI or a script reads. A build run as a plain Node process has only the
   * second, and it still refuses a second instance.
   */
  readonly isPrimaryInstance: boolean
  /** The origin the hub published, once it is serving. */
  onHubReady?(hub: RunningHub): void
  /**
   * Mount the tray (NT-2). Absent in HC-1: the tray belongs to
   * notification-engineer and the hub only provides the seam and the pending count
   * it will read.
   */
  mountTray?(hub: RunningHub): void
}

export interface StartHubOptions {
  /** Defaults to the resolved state directory, honouring AGENT_PING_STATE_DIR. */
  readonly stateDir?: string
  /** Defaults to the built dashboard inside this checkout or installation. */
  readonly dashboardRoot?: string | null
  /** The first port tried. Defaults to DEFAULT_HUB_PORT. */
  readonly preferredPort?: number
  /**
   * How many consecutive ports after the preferred one may be tried. Defaults to
   * PORT_FALLBACK_ATTEMPTS. A test lowers it to reach the exhausted-range failure
   * without occupying twenty ports.
   */
  readonly portFallbackAttempts?: number
  /**
   * Overrides for the live state stream's own bounds (HC-FR-03).
   *
   * Absent in production, which is the point: the defaults are the documented
   * five-minute replay window and twenty-five-second heartbeat. A test lowers
   * them so it can watch a heartbeat arrive and a window expire in real time
   * rather than by faking a clock the hub does not have.
   */
  readonly stream?: Partial<StreamSettings>
  readonly desktop?: DesktopBridge
  /** ISO 8601 UTC source for `startedAt` and the store's migration records. */
  readonly now?: () => string
  /** Environment to resolve the state directory from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Reports a diagnostic line. Never called with content, a path or a token. */
  readonly onDiagnostic?: (message: string) => void
}

/** A running hub. Everything a caller needs to talk to it, and to stop it. */
export interface RunningHub {
  readonly instanceId: string
  /** Always 127.0.0.1. */
  readonly host: string
  /** The port that was actually bound, which is not necessarily the preferred one. */
  readonly port: number
  readonly origin: string
  readonly preferredPort: number
  readonly stateDir: string
  readonly databaseFilePath: string
  readonly runtimeFilePath: string
  /** The published record, including the live port. */
  readonly runtimeFile: RuntimeFile
  /** True when this hub took the runtime file from a process that had died. */
  readonly reclaimedStaleRuntimeFile: boolean
  /** The pid whose runtime file was reclaimed, or null when the file was free. */
  readonly reclaimedFromPid: number | null
  readonly registry: RouteRegistry<HubServices>
  readonly server: HubServer<HubServices>
  /**
   * The store, wrapped so every transition it applies is published to the live
   * stream. Reads pass straight through and writes report an outcome; nothing
   * about the store's own contract changes, which is why ingest (HC-3) and the
   * ack route (HC-4) get live dashboards without either of them knowing this
   * exists.
   */
  readonly store: EventStore
  readonly counters: Counters
  /** The live state stream's feed. Closed first on shutdown. */
  readonly stream: ChangeFeed
  readonly startedAt: string
  /** Stop the listener, close the log, and give the runtime file back. Idempotent. */
  close(): Promise<void>
}

/**
 * Start the hub.
 *
 * Rejects with HubAlreadyRunningError when another instance holds the runtime file
 * and its process is still running, which is the single-instance guarantee of
 * HC-FR-01 stated as a failure rather than as a quiet exit: a second process that
 * started anyway would take over the port the adapters are already posting to.
 */
export async function startHub(options: StartHubOptions = {}): Promise<RunningHub> {
  const now = options.now ?? ((): string => new Date().toISOString())
  const stateDir = ensureStateDir(options.stateDir ?? resolveStateDir(options.env))
  const diagnostic = options.onDiagnostic ?? ((): void => {})

  // 2. The lock, before anything is opened. A refused instance must not have
  //    touched the log, so this is deliberately first.
  const claim = claimHubInstance({ stateDir, now })
  if (claim.reclaimedStaleRuntimeFile) {
    // A sidecar that was killed has to be restartable (APX-CON-03), and a restart
    // that had to take the file over says so rather than doing it quietly.
    diagnostic(
      `agent-ping reclaimed the runtime file left by pid ${String(claim.reclaimedFromPid)}, which is no longer running`,
    )
  }

  let store: EventStore | undefined
  let counters: Counters | undefined
  let server: HubServer<HubServices> | undefined
  let stream: ChangeFeed | undefined
  try {
    // 3. The durable log, and the counters over the same file. Both are opened
    //    against the resolved state directory, never against a second guess at it.
    store = openEventStore({ filePath: databaseFilePath(stateDir), now })
    counters = openCounters({ filePath: store.filePath, now })

    // 4. The live state stream's feed, wrapped around the store. The wrapper is
    //    what makes a frame appear for every transition the store applies, so the
    //    routes that write (HC-3, HC-4) never have to publish anything themselves.
    stream = createChangeFeed(options.stream)
    const watching = withChangeFeed(store, stream)

    // 5. Every route, registered in one place. The list is the product's read
    //    surface; adding a route means adding it here, where the enumeration test
    //    will see it.
    const registry = new RouteRegistry<HubServices>()
    registry.registerAll(READ_ROUTES)
    registry.registerAll(STREAM_ROUTES)
    const dashboardRoot = resolveDashboardRoot(options.dashboardRoot)
    registry.register(createDashboardRoute<HubServices>({ root: dashboardRoot }))

    // The services are read per request rather than captured, because the port they
    // report is the one the bind below produces. `let` with a thunk is the honest
    // shape for that: a request cannot arrive before `listen` resolves, and a
    // request that did arrive always reads the finished object.
    let services: HubServices = {
      store: watching,
      counters,
      stream,
      hub: unpublishedIdentity(claim),
    }

    // 6. The listener. The port is chosen here and nowhere else.
    server = await startServer<HubServices>({
      registry,
      services: () => services,
      dashboard: { root: dashboardRoot },
      preferredPort: options.preferredPort,
      portFallbackAttempts: options.portFallbackAttempts,
      onPortInUse: ({ port }) => {
        diagnostic(`port ${port} is in use; trying the next loopback port`)
      },
    })

    // 7. Publish the live port. Until this line the file is a lock with no pointer
    //    in it, which is exactly what an adapter must see as "not up yet".
    const runtimeFile = claim.publishPort({
      port: server.port,
      host: server.host,
      schemaVersion: store.schemaVersion,
    })
    services = {
      store: watching,
      counters,
      stream,
      hub: {
        instanceId: claim.instanceId,
        pid: claim.pid,
        host: server.host,
        port: server.port,
        origin: server.origin,
        startedAt: runtimeFile.startedAt,
        schemaVersion: store.schemaVersion,
        rebuiltFromMigrations: store.rebuiltFromMigrations,
        dashboardRoot,
        servedRequests: (): number => server?.servedRequests() ?? 0,
      },
    }

    let closed = false
    const hub: RunningHub = {
      instanceId: claim.instanceId,
      host: server.host,
      port: server.port,
      origin: server.origin,
      // The port that was preferred, which is not the port that was bound when the
      // first was taken. Reporting the preferred one is what lets `doctor` say why
      // the live port is not the default.
      preferredPort: options.preferredPort ?? DEFAULT_HUB_PORT,
      stateDir,
      databaseFilePath: store.filePath,
      runtimeFilePath: claim.filePath,
      runtimeFile,
      reclaimedStaleRuntimeFile: claim.reclaimedStaleRuntimeFile,
      reclaimedFromPid: claim.reclaimedFromPid,
      registry,
      server,
      store: watching,
      counters,
      stream,
      startedAt: runtimeFile.startedAt,
      close: async (): Promise<void> => {
        // Idempotent, because a shutdown can be triggered twice: `close` is
        // called by the lifecycle path, by a test's cleanup, and by a quit that
        // arrives after the first one already closed the log. A second call that
        // tried to flush a closed database would turn a clean shutdown into an
        // error, which is exactly the sort of "not silent" that is not a report.
        if (closed) return
        closed = true
        // The order a shutdown has to have: end the live streams, stop answering,
        // fold the counters into the file, close the log, then give the runtime
        // file back. The feed goes first, and both halves of that are deliberate.
        // Ending the streams is what stops a client waiting on a socket that will
        // never speak again, and it is also what stops `server.close` from sitting
        // on a response that is deliberately still open - a streaming response is
        // not an idle connection, so the listener would wait for every dashboard to
        // disconnect on its own. The cost of that order is that a transition
        // reaching a closing feed throws, which is why HC-FR-10's "stop accepting
        // events" step has to come before this call: an ingest still in flight when
        // the feed closes is an ordering bug, and losing its frame quietly would
        // hide it. Publishing a shutdown state is HC-5's work with the signal
        // handler; this is the primitive it calls.
        let firstError: unknown
        try {
          stream?.close()
        } catch (cause) {
          firstError = cause
        }
        try {
          await server?.close()
        } catch (cause) {
          firstError ??= cause
        }
        try {
          counters?.close()
        } catch (cause) {
          firstError ??= cause
        }
        try {
          store?.close()
        } catch (cause) {
          firstError ??= cause
        }
        releaseQuietly(claim)
        if (firstError !== undefined && firstError !== null) throw firstError
      },
    }

    // 8. The desktop shell, last, so nothing is mounted over a hub that is not
    //    yet serving.
    const desktop = options.desktop
    if (desktop !== undefined) {
      if (!desktop.isPrimaryInstance) {
        // Defence in depth for an injected bridge. The Electron entry point quits
        // before it gets here when the application lock is not granted, so this
        // branch is for a caller that assembled the bridge itself: the desktop is
        // not ours to own, so nothing is served and the claim is given back. It is
        // deliberately not a HubAlreadyRunningError - that error carries a live
        // instance's record, and the instance that holds the desktop lock is not
        // this process, so there is no record here to hand it.
        await hub.close()
        throw new Error(
          'this process is not the primary desktop instance, so it will not run the hub. The ' +
            'instance that holds the application lock is the one serving; nothing was bound and no ' +
            'runtime file was left behind.',
        )
      }
      desktop.onHubReady?.(hub)
      desktop.mountTray?.(hub)
    }
    return hub
  } catch (cause) {
    // Every failure path releases what it took, so a failed start never leaves a
    // runtime file that refuses the next attempt, and never leaves a heartbeat
    // timer running in a process that is about to report the failure.
    stream?.close()
    await quietClose(server, counters, store)
    releaseQuietly(claim)
    throw cause
  }
}

/**
 * Where the built dashboard is.
 *
 * Resolved by walking up to the directory that owns this package, so the same code
 * finds `dist/dashboard` whether it is running from `src/main` under a test or from
 * `dist/main/main` in the packaged application. An explicit `dashboardRoot` wins,
 * and an explicit null means "serve no dashboard", which is how a CLI invocation
 * and a packaging check run the same entry point without a built page.
 */
export function resolveDashboardRoot(explicit: string | null | undefined): string | null {
  if (explicit !== undefined) return explicit
  return path.join(projectRoot(), 'dist', 'dashboard')
}

/** The directory that owns this package: the first ancestor with a package.json. */
function projectRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(path.join(directory, 'package.json'))) return directory
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return path.dirname(fileURLToPath(import.meta.url))
}

/**
 * The identity a handler would see before the socket is bound.
 *
 * It exists only inside the composition root, between the claim and the bind, and
 * it is replaced before any request can be answered. `port` is 0 rather than the
 * preferred port on purpose: "not bound yet" is the truth, and a health payload
 * that claimed a port the hub had not taken would be a lie with a plausible number
 * in it.
 */
function unpublishedIdentity(claim: HubInstanceClaim): HubIdentity {
  return {
    instanceId: claim.instanceId,
    pid: claim.pid,
    host: LOOPBACK_HOST,
    port: 0,
    origin: '',
    startedAt: claim.record().startedAt,
    schemaVersion: claim.record().schemaVersion,
    rebuiltFromMigrations: false,
    dashboardRoot: null,
    servedRequests: () => 0,
  }
}

function releaseQuietly(claim: HubInstanceClaim): void {
  try {
    claim.release()
  } catch {
    // Releasing a file that is not there is the outcome that was wanted; a
    // shutdown must not fail because of it.
  }
}

async function quietClose(
  server: HubServer<HubServices> | undefined,
  counters: Counters | undefined,
  store: EventStore | undefined,
): Promise<void> {
  try {
    await server?.close()
  } catch {
    // The failure being reported is the one that caused this cleanup.
  }
  try {
    counters?.close()
  } catch {
    // As above.
  }
  try {
    store?.close()
  } catch {
    // As above.
  }
}

// ---------------------------------------------------------------------------
// The Electron entry point
// ---------------------------------------------------------------------------

/**
 * The slice of Electron's main-process API this entry point uses.
 *
 * Declared structurally rather than imported as a type, for two reasons: the
 * package is a runtime dependency of the packaged application rather than of the
 * source tree, and an interface this small is checkable by reading. Nothing here
 * can steer an agent: it starts an application, holds a lock, and quits.
 */
interface ElectronAppLike {
  requestSingleInstanceLock(): boolean
  whenReady(): Promise<void>
  on(event: string, listener: (...args: never[]) => void): unknown
  quit(): void
}

/**
 * Load the runtime `electron` module.
 *
 * Through a function parameter on purpose. A literal specifier would be resolved
 * by the type checker, which would make the whole source tree - tests, the CLI,
 * every verification script - unable to typecheck without Electron installed. A
 * specifier the compiler cannot fold keeps this file honest in both directions: it
 * typechecks with no Electron present, and it loads the real module when the
 * packaged application runs.
 */
async function importModule(specifier: string): Promise<unknown> {
  return import(specifier)
}

/**
 * Start the hub as an Electron main process.
 *
 * The application lock is taken first, because Electron's is the one that knows
 * about the window; then the hub takes its own, because that is the one the
 * adapters and the CLI read. Both or neither.
 *
 * No window is opened here. The dashboard is an on-demand surface (ADR-009), and
 * the tray that opens it belongs to NT-2, so the only thing this function does
 * with the desktop is keep the process alive until the hub is closed.
 */
export async function startElectronMain(): Promise<RunningHub | null> {
  const electron = (await importModule('electron')) as { app?: ElectronAppLike }
  const app = electron.app
  if (app === undefined) {
    throw new Error(
      'the Electron runtime is not available: `electron` did not provide an `app`. This entry ' +
        'point is the Electron main process; a plain Node process should call startHub() instead.',
    )
  }

  const isPrimaryInstance = app.requestSingleInstanceLock()
  if (!isPrimaryInstance) {
    // A second launch of the application is not a failure and not a hub: the
    // instance that already holds the lock is the one serving, so this one exits
    // without touching the log, the port or the runtime file.
    app.quit()
    return null
  }

  await app.whenReady()
  const hub = await startHub({ desktop: { isPrimaryInstance: true } })

  // The hub owns the shutdown order (close listener, flush, close, release), and
  // this only decides when to start it. A second `before-quit` is a no-op because
  // `close` is idempotent, which matters because a quit can be requested twice.
  app.on('before-quit', () => {
    void hub.close().catch(() => {
      // A shutdown that cannot finish still has to end the process; the error is
      // already reported through health while the hub was up.
    })
  })
  return hub
}

/**
 * Run the Electron entry point when this module is the process entry.
 *
 * Two conditions, both necessary. `process.versions.electron` is present only
 * inside Electron, so importing this file from a test or a script does nothing. The
 * entry check keeps a second `import` of this module inside the application from
 * starting a second hub, which the runtime file would then refuse anyway - but
 * refusing at the file level is a clearer failure than refusing at the lock.
 */
function isElectronEntryPoint(): boolean {
  if (process.versions['electron'] === undefined) return false
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isElectronEntryPoint()) {
  void startElectronMain().catch((cause: unknown) => {
    // The one place this process reports a fatal start failure. It quotes the
    // message, which is this product's own error text and never a payload.
    process.exitCode = 1
    process.stderr.write(`agent-ping could not start: ${describe(cause)}\n`)
  })
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}
