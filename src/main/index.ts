// The Electron main process: agent-ping's composition root (HC-FR-01).
//
// Everything this product is made of is wired here and nowhere else. The order is
// the design:
//
//   1. the state directory, through the one resolver in src/storage/paths.ts
//   2. the runtime file, which is the lock - so a second instance is refused
//      before it can open the same log
//   3. the durable store, then the counters over the same file
//   4. the metrics recorder over those counters (HC-6), then the state change feed
//      wrapped around the store, so every transition the store applies becomes a
//      frame for the dashboards already watching and a snapshot for the counters
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
// WHAT IS HERE NOW, AND WHAT IS STILL TO COME
// The platform notifier is wired (NT-1): the registry picks this machine's notifier, the
// notifier applies the one class policy (a resident critical toast for a block, an
// expiring one for a finished turn, and nothing at all for an fyi), and the delivery
// policy calls it - it is the one thing in this process that may call a notifier, and
// the notifier itself is constructed below and injected into the policy, so the restart
// replay and the live path reach the same one. A platform with no notifier is not wired
// and says so on health, which is the honest answer rather than a delivered lie
// (APX-FR-02). The macOS and Windows notifiers arrive in NT-2 and the tray in NT-3.
// What remains deliberately absent is any route that can spawn, steer, interrupt, prompt
// or approve anything inside a harness (APX-CON-08): the mutating set in
// src/hub/server.ts is exactly two signatures, the append-only ingest route and the ack
// route, and the registry refuses to register anything else that claims to write. The
// delivery policy is not a route and is reachable from no request at all.
//
// THE ORDER THE SHUTDOWN AND THE START SHARE
// A hub that is starting replays its pending blocks (HC-FR-07) and a hub that is
// stopping drains them (HC-FR-10), and both go through the two objects built here:
// `delivery` owns the attempt and the bound, `lifecycle` owns the signal and the
// exit. `close` remains the single ordered shutdown - refuse new work, drain, end
// the streams, stop answering, flush the counters, close the log, release the
// runtime file - and the lifecycle calls it rather than restating it, so a test that
// closes a hub directly and a service manager that stops one take the same path.
//
// The live state stream (HC-2) is wired here rather than inside the store, which
// is what keeps ingest and ack from having to know it exists: they call the
// store's accessors, and the frames follow. The feed is closed before the
// listener in the shutdown order below, so a stream is never left pointing at a
// store that has already been closed.
//
// The four local counters (HC-6) are wired the same way and for the same reason. The
// recorder is the only object in this process that calls a counter's write method,
// and each of its four increments is fed by the path the fact happens on: the
// dashboard route's document handler for an open and a deep link, the delivery
// policy's outcome for a toast, and a wrapper inside the store wrapper for a
// pending-set change. Nothing polls and nothing samples, so a counter that is
// wrong is wrong because a path is wrong rather than because a timer fired.
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
import { createPendingLifecycle, type PendingLifecycle } from '../domain/pending.js'
import { READ_ROUTES, type HubIdentity, type HubServices } from '../hub/routes/read.js'
import { STREAM_ROUTES } from '../hub/routes/stream.js'
import { INGEST_ROUTES } from '../hub/routes/ingest.js'
import { ACK_ROUTES } from '../hub/routes/ack.js'
import { createHubSecurity, type CreateHubSecurityOptions, type HubSecurity } from '../hub/security.js'
import {
  createIngestService,
  type DeliveryPort,
  type IngestService,
  type IngestServiceOptions,
} from '../hub/ingest-service.js'
import {
  createChangeFeed,
  withChangeFeed,
  type ChangeFeed,
  type StreamSettings,
} from '../hub/sse.js'
import {
  createMetricsRecorder,
  onDashboardDocumentServed,
  withPendingSnapshot,
  type MetricsRecorder,
} from '../hub/metrics.js'
import {
  DeliveryFailedError,
  createDeliveryPolicy,
  type DeliveryPolicy,
  type DeliveryPolicyOptions,
} from '../hub/delivery.js'
import { createHubLifecycle, type HubLifecycle, type HubState } from '../hub/lifecycle.js'
import {
  createPlatformNotifier,
  toNotifierPort,
  type NotifierResolution,
} from '../notify/registry.js'
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
   * Mount the tray (NT-3). Absent until NT-3: the tray belongs to notification-engineer
   * and the hub only provides the seam and the pending count it will read.
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
  /**
   * Overrides for the ingest pipeline (HC-FR-04).
   *
   * Production passes nothing, and the omission is meaningful: the defaults are the
   * documented bounds. The delivery port below is the policy, and the policy's `wired` is
   * what the pipeline is told, so a hub on a platform with no notifier counts
   * `not-wired` deliveries rather than passing silently (APX-FR-02). A test uses this
   * option to observe that the answer is returned before any delivery work begins.
   */
  readonly ingest?: Partial<Omit<IngestServiceOptions, 'store'>>
  /**
   * Overrides for the delivery policy (HC-FR-07).
   *
   * Production passes nothing. The notifier is the platform's own, constructed by the
   * registry below and injected into the policy, so the live path and the restart replay
   * reach the same notifier without either of them naming a platform. The one override
   * that matters is `notifier`, and it exists so a test can watch one classified event
   * become one attempt without a desktop; passing one replaces the platform notifier, so
   * a test that does it is testing the policy and not the toast, which is the right way
   * round for both claims.
   *
   * `origin` is not a caller option: it is this file's own live origin, read per
   * request, because a deep link cannot be built from a port that was only a preference
   * (HC-FR-01, NT-FR-07).
   */
  readonly delivery?: Partial<Omit<DeliveryPolicyOptions, 'store' | 'origin'>>
  /**
   * Overrides for the shutdown path (HC-FR-10).
   *
   * `installSignals: false` is for a caller that owns the process's signals itself -
   * a test, or a host application that has its own quit handling. A hub that installs
   * the handlers removes them again in `close`, so a test that always closes cannot
   * leave a handler behind on the test runner.
   */
  readonly lifecycle?: {
    readonly installSignals?: boolean
    readonly graceMs?: number
    readonly signals?: readonly string[]
    /**
     * How the process ends after a shutdown. Defaults to `process.exit`.
     *
     * The Electron entry point passes `app.quit` instead, so a quit from the tray
     * takes the same ordered path as a signal and then lets Electron tear the
     * application down in its own way rather than being killed mid-teardown. A test
     * passes a spy so the exit code can be asserted without ending the test runner.
     */
    readonly exit?: (code: number) => void
  }
  /**
   * Overrides for the security boundary (HC-FR-06).
   *
   * Production passes nothing, which means the token is a fresh 32 bytes in the
   * state directory on the first start and the existing file thereafter. The one
   * override that matters is `random`, and it exists so a test can assert a
   * *refused* write against a token whose value it chose - proving the comparison
   * rejects something plausible rather than something absent.
   */
  readonly security?: Partial<CreateHubSecurityOptions>
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
  /**
   * The metrics recorder (HC-6): the four recording decisions PRD 11 is measured
   * against, and the only object in this process that calls a counter's write method.
   *
   * Exposed for `doctor`, for the tray's deep-link click (NT-FR-08) and for a test
   * that has to observe a counter moving through a real path. It can only count: no
   * member of it names a session, an event or a harness, reads a row or returns a
   * payload, so holding one is not a way to change anything (APX-CON-08).
   */
  readonly metrics: MetricsRecorder
  /** The live state stream's feed. Closed first on shutdown. */
  readonly stream: ChangeFeed
  /**
   * The ingest pipeline the `POST /api/ingest` route drives.
   *
   * Exposed for `doctor` and for a test that has to observe a dropped event or a
   * delivery outcome (HC-FR-07, HC-3). It reads and records; it cannot steer, and
   * the only durable effect it has is an appended event.
   */
  readonly ingest: IngestService
  /**
   * The pending lifecycle the `POST /api/ack/:eventId` route drives, and the only
   * mutation a client request can reach (APX-CON-08). Exposed so `doctor` and a test
   * can read the pending set through the same accessor the tray badge uses.
   */
  readonly pending: PendingLifecycle
  /**
   * The delivery policy (HC-FR-07): the one object here that may call a notifier, and
   * the only place a delivery is attempted.
   *
   * Exposed for `doctor` and for a test that has to see a per-event outcome or a
   * replay report. It has no route, so no client can reach it; what a *request* can
   * reach is the ingest port adapter below, which is why this is a plain field on a
   * running hub and not a service in `HubServices` (APX-CON-08).
   */
  readonly delivery: DeliveryPolicy
  /**
   * The notifier resolution this hub was built with (NT-1): which platform answered,
   * whether one did, and a probe for whether the tool it uses is installed.
   *
   * Exposed so `doctor` reports notifier availability from the same resolution the
   * deliveries went through rather than by constructing a second notifier, and so
   * NT-3's tray can read the same answer (IO-2, NT-FR-09). Holding it grants nothing:
   * calling `notifier` is a delivery attempt the policy owns, and `probe` only reports
   * whether a tool is installed.
   */
  readonly notifier: NotifierResolution
  /**
   * The shutdown path (HC-FR-10): PRD 10's lifecycle state, and the one ordered
   * shutdown a signal, an Electron quit and a test all take.
   */
  readonly lifecycle: HubLifecycle
  /**
   * The security boundary: this install's write token, the header it travels in, and
   * where the token file is. In-process only - the token is on no read route, in no
   * response body and in no served asset (HC-FR-06).
   */
  readonly security: HubSecurity
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
  let ingest: IngestService | undefined
  let delivery: DeliveryPolicy | undefined

  // The lifecycle exists before anything is opened, because a termination signal can
  // arrive at any point in this function. What it calls before the hub exists is the
  // honest answer to "stop" at that moment: give the claim back and close whatever had
  // been opened, rather than leaving a half-started process holding a runtime file
  // (HC-FR-10). `closeHub` is filled in below, once there is a hub to close.
  let closeHub: (() => Promise<void>) | undefined
  const lifecycle = createHubLifecycle({
    close: async (): Promise<void> => {
      if (closeHub !== undefined) {
        await closeHub()
        return
      }
      await quietClose(server, counters, store)
      releaseQuietly(claim)
    },
    stateDir,
    instanceId: claim.instanceId,
    pid: claim.pid,
    ...(options.lifecycle?.graceMs === undefined ? {} : { graceMs: options.lifecycle.graceMs }),
    ...(options.lifecycle?.signals === undefined ? {} : { signals: options.lifecycle.signals }),
    ...(options.lifecycle?.exit === undefined ? {} : { exit: options.lifecycle.exit }),
    onDiagnostic: diagnostic,
  })
  // Installed here rather than at the end, so a signal during a slow start is a clean
  // stop rather than a default termination. `close` removes them again on every path,
  // including the failure path below, so a refused or failed start leaves the process
  // exactly as it found it.
  if (options.lifecycle?.installSignals !== false) lifecycle.install()
  try {
    // 3. The durable log, and the counters over the same file. Both are opened
    //    against the resolved state directory, never against a second guess at it.
    store = openEventStore({ filePath: databaseFilePath(stateDir), now })
    counters = openCounters({ filePath: store.filePath, now })

    // 3b. The metrics recorder (HC-6), over those counters, built here and nowhere
    //     else for the same reason every other collaborator is: the composition root
    //     is the one place this product wires things, so "which path increments which
    //     counter" is answerable by reading one file rather than by searching for
    //     every call site.
    //
    //     The baseline is the pending count as the log reports it right now, so a hub
    //     that starts with three blocks outstanding and then stores an `fyi` event is
    //     not recorded as a change to the pending set (src/hub/metrics.ts). The read
    //     happens once, here, because the store is open and no request can arrive
    //     before the socket is bound below.
    //
    //     `log` and `localMetrics` are constants rather than the `let` bindings the
    //     steps above use, because the two closures below capture them and a closure
    //     over a `let` would be re-read at call time - by which point the try block
    //     may have failed and released whatever it took.
    const log: EventStore = store
    const localMetrics: MetricsRecorder = createMetricsRecorder({
      counters,
      initialPendingCount: (): number => log.readPending().length,
      onDiagnostic: diagnostic,
    })

    // 4. The live state stream's feed, wrapped around the store. The wrapper is
    //    what makes a frame appear for every transition the store applies, so the
    //    routes that write (HC-3, HC-4) never have to publish anything themselves.
    //
    //    The metrics wrapper is inside the stream wrapper, and that order is a
    //    decision rather than a habit: an applied transition records its
    //    pending-set snapshot first, so a client that learns about the change from
    //    the frame it produces finds the counter already moved. Both wrappers read
    //    the same bounded pending set, so the cost is one extra small read on the
    //    ingest path that already reads it twice.
    stream = createChangeFeed(options.stream)
    const watching = withChangeFeed(withPendingSnapshot(store, localMetrics), stream)

    // 4b. The delivery policy (HC-FR-07), over the same wrapped store and before the
    //     ingest pipeline, because the pipeline's port *is* this policy. Built here
    //     and nowhere else: the composition root is the single place a collaborator is
    //     constructed, which is what keeps a second delivery path from being a diff
    //     nobody reads.
    //
    //     The notifier is the platform's (NT-1), resolved here rather than inside the
    //     policy, for three reasons. The composition root is the one place in this
    //     product that wires things, so "which notifier answered" is a line of this file
    //     rather than a search. The policy and the notifier then have no dependency on
    //     each other at all - the policy only knows a function it was handed - so a
    //     platform notifier is a replacement rather than an edit. And a platform with no
    //     notifier leaves the port unwired, which the policy reports as `not-wired` on
    //     health and the ingest pipeline counts as `not-wired`, so "nobody was told" is
    //     visible from both ends rather than being papered over with a no-op notifier
    //     that always succeeds (APX-FR-02).
    const platformNotifier = createPlatformNotifier({ onDiagnostic: diagnostic })
    if (!platformNotifier.supported) {
      // A line, because a hub that cannot notify anybody is degraded in a way an
      // operator has to be told about, and the state it reports is `not-wired` rather
      // than a failure (APX-CON-06, APX-FR-02). No notifier is constructed on this
      // path, so nothing can be delivered by accident.
      diagnostic(
        `agent-ping has no notifier for this platform (${platformNotifier.platform}, ` +
          `${platformNotifier.reason}), so every delivery is recorded as not-wired and no ` +
          'notification leaves this machine',
      )
    }
    delivery = createDeliveryPolicy({
      store: watching,
      // The live origin, read per request rather than captured: the bind below is what
      // chooses the port, and a deep link built from the preferred one would point at
      // a port nobody is listening on (HC-FR-01, NT-FR-07).
      origin: (): string => server?.origin ?? '',
      // The one conversion between the two notifier shapes: the platform notifier
      // resolves with an outcome carrying a reason, and the policy's port has only
      // "resolved" and "thrown" - so the adapter is where a `failed` outcome becomes a
      // throw the policy records as a failure, with the reason beside it (APX-FR-02,
      // ADR-010). An `fyi` is refused by the class policy before any platform notifier
      // is reached and never becomes a command (NT-FR-02).
      ...(platformNotifier.notifier === null
        ? {}
        : { notifier: toNotifierPort(platformNotifier.notifier, { onDiagnostic: diagnostic }) }),
      onDiagnostic: diagnostic,
      // The one place a delivery outcome leaves the policy (HC-6). A `delivered`
      // outcome is the increment for `toast_deliveries`; the other four are handed
      // over and deliberately not counted, because counting a gap as a delivery is
      // the one thing PRD 11's notification-restraint row cannot be measured against
      // (APX-FR-02, ADR-010).
      onOutcome: (attempt): void => localMetrics.recordDeliveryOutcome(attempt),
      ...options.delivery,
    })

    // 4c. The ingest pipeline, over the same wrapped store, so an ingested event
    //     becomes a live change frame without the pipeline knowing the stream exists.
    //     It is built here and nowhere else: the composition root is the single place
    //     a route's collaborators are constructed, which is what keeps a second way to
    //     build one from being a diff nobody reads.
    //
    //     The delivery port is the policy, and the adapter's whole job is to turn an
    //     outcome the policy already recorded back into a rejection the pipeline
    //     records as a dropped delivery (HC-FR-09). The policy never throws, so this
    //     is the only place the two layers meet.
    //
    //     `deliveryWired` is the policy's own `wired`: a hub with no notifier behind
    //     the port has told nobody, and the pipeline's `not-wired` count is the
    //     honest answer for it. Reporting those attempts as `delivered` would be the
    //     one thing this product must never do (APX-FR-02).
    ingest = createIngestService({
      store: watching,
      delivery: deliveryPort(delivery),
      deliveryWired: delivery.wired,
      onDiagnostic: diagnostic,
      ...options.ingest,
    })

    // 4c. The pending lifecycle the ack route drives, and the security boundary that
    //     guards it. Both over the same wrapped store, so an acknowledgement also
    //     becomes a live change frame; both built here and nowhere else, because a
    //     second way to obtain either is a second way to change a record.
    //
    //     The lifecycle is the second one in this process: the ingest pipeline holds
    //     its own. They are interchangeable - it is stateless, and every read it does
    //     goes to the store - so this is duplication of a *reference*, not of state,
    //     and it is what lets the ack route be a route rather than a method on the
    //     ingest pipeline (src/domain/pending.ts).
    //
    //     The token file is created or read here, at start, rather than on the first
    //     write: a hub that is serving is a hub whose write route can be reached, and a
    //     state directory that cannot hold the token is a start-up failure rather than
    //     a click that does nothing (HC-FR-06).
    const pending = createPendingLifecycle(watching)
    const security = createHubSecurity({ stateDir, ...options.security })

    // 5. Every route, registered in one place. The list is the product's whole HTTP
    //    surface; adding a route means adding it here, where the enumeration test
    //    will see it.
    const registry = new RouteRegistry<HubServices>()
    registry.registerAll(READ_ROUTES)
    registry.registerAll(STREAM_ROUTES)
    registry.registerAll(INGEST_ROUTES)
    registry.registerAll(ACK_ROUTES)
    const dashboardRoot = resolveDashboardRoot(options.dashboardRoot)
    registry.register(
      // The second argument is the dashboard document handler (HC-6): the hub
      // recording that a client was served the page, and that a request carrying a
      // deep-link target opened it that way. The route tells it only when a file was
      // actually served, so a 404, an unsupported type and a hub with no build record
      // nothing - which is right, because no dashboard was opened in any of them.
      createDashboardRoute<HubServices>({ root: dashboardRoot }, onDashboardDocumentServed(localMetrics)),
    )

    // The services are read per request rather than captured, because the port they
    // report is the one the bind below produces. `let` with a thunk is the honest
    // shape for that: a request cannot arrive before `listen` resolves, and a
    // request that did arrive always reads the finished object.
    let services: HubServices = {
      store: watching,
      counters,
      stream,
      ingest,
      pending,
      delivery,
      security,
      hub: unpublishedIdentity(claim, lifecycle),
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
      ingest,
      pending,
      delivery,
      security,
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
        // Read at request time, not captured: the listener and the lifecycle state
        // both change while a health payload is being built, and a doctor run that
        // reads `listening: true` from a hub that has already closed is worse than no
        // field (HC-FR-07, HC-FR-10).
        listening: (): boolean => server?.nodeServer.listening ?? false,
        state: (): HubState => lifecycle.state().state,
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
      metrics: localMetrics,
      stream,
      ingest,
      /**
       * The pending lifecycle the ack route drives, and the only mutation a client
       * request can reach (APX-CON-08). Exposed for the same reason `ingest` is: a
       * test and `doctor` have to be able to observe what the control surface did.
       */
      pending,
      /**
       * The delivery policy and the shutdown path. Neither is a route, so neither is
       * reachable from a request; both are here because `doctor` and the notification
       * engineer need to read them from a running hub, and because a signal has to
       * reach the shutdown from inside the process (HC-FR-07, HC-FR-10).
       */
      delivery,
      /**
       * The notifier resolution, so `doctor` and NT-3's tray can ask whether a
       * notifier exists and whether its tool is installed without building a second
       * one. The same object the policy above was given (NT-1).
       */
      notifier: platformNotifier,
      lifecycle,
      /**
       * The security boundary: this install's write token, the header it travels in
       * and where the token file is. In-process only - the token is on no read route,
       * in no response and in no served asset (HC-FR-06).
       */
      security,
      startedAt: runtimeFile.startedAt,
      close: async (): Promise<void> => {
        // Idempotent, because a shutdown can be triggered twice: `close` is
        // called by the lifecycle path, by a test's cleanup, and by a quit that
        // arrives after the first one already closed the log. A second call that
        // tried to flush a closed database would turn a clean shutdown into an
        // error, which is exactly the sort of "not silent" that is not a report.
        if (closed) return
        closed = true
        // First, and before anything is closed: the hub is stopping. This is the
        // signal path's own first step (src/hub/lifecycle.ts) and it is repeated here
        // because `close` is reachable without a signal - from a test, from Electron's
        // before-quit, from the CLI - and a health payload that said `running` while
        // the log was being closed would be a lie in all three of those cases.
        // Beginning the shutdown also removes the signal handlers, so a second Ctrl-C
        // is the operating system's answer rather than a second ordered close.
        lifecycle.begin('close')
        // The order a shutdown has to have: refuse new deliveries, stop accepting
        // events, end the live streams, stop answering, fold the counters into the
        // file, close the log, then give the runtime file back. The delivery drain
        // goes first of all, and the feed third; every placement is deliberate.
        //
        // Draining delivery is HC-FR-10's "stop accepting events" reaching the
        // notification path first: the policy refuses new attempts and waits out the
        // ones already in flight - bounded by DELIVERY_ATTEMPT_TIMEOUT_MS, so a wedged
        // notifier cannot decide whether the hub stops (APX-CON-10). Closing the log
        // underneath a delivery would be the ordering bug the comment on the feed
        // describes, seen from the other end.
        //
        // The ingest drain follows, and is the step that refuses new *events*: the
        // pipeline stops accepting, and a post that arrives now is answered 503 and
        // recorded as dropped rather than stored by a half-closed hub. Its own tracked
        // promises include the port calls above, so this is where a live delivery that
        // the ingest started is waited for as well.
        //
        // The feed goes before the listener, and both halves of that are deliberate.
        // Ending the streams is what stops a client waiting on a socket that will never
        // speak again, and it is also what stops `server.close` from sitting on a
        // response that is deliberately still open - a streaming response is not an
        // idle connection, so the listener would wait for every dashboard to disconnect
        // on its own. The cost of that order is that a transition reaching a closing
        // feed throws, which is why the refusal steps have to come before this call.
        let firstError: unknown
        try {
          await delivery?.close()
        } catch (cause) {
          firstError = cause
        }
        try {
          await ingest?.close()
        } catch (cause) {
          firstError ??= cause
        }
        try {
          stream?.close()
        } catch (cause) {
          firstError ??= cause
        }
        try {
          await server?.close()
        } catch (cause) {
          firstError ??= cause
        }
        try {
          // The flush is PRD 10's "counters flushed", and it is a step rather than a
          // detail: it folds the write-ahead log back into the single database file,
          // so a copy of that file taken after a shutdown is complete rather than
          // needing a restart to become so (src/storage/counters.ts). It has to happen
          // while the counters' own connection is still open, which is why it sits
          // between the listener closing and the database closing.
          counters?.flush()
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
        lifecycle.finish()
        if (firstError !== undefined && firstError !== null) throw firstError
      },
    }
    closeHub = hub.close

    // 8. The restart replay (HC-FR-07), with the socket bound and the port published,
    //    because a replayed delivery's deep link needs the live origin and a replayed
    //    block must reach the same notifier a fresh one does. Awaited rather than
    //    fired: every attempt inside it is bounded, so the bound on the start is one
    //    delivery attempt rather than a pending count, and "the hub is running with its
    //    outstanding blocks already re-announced" is a fact its caller can rely on
    //    rather than a race. PRD 10 puts the replay in `starting`, before `running`,
    //    and the state reported on health is `starting` for exactly this window.
    const replay = await delivery.replayPending()
    if (replay.candidates > 0) {
      diagnostic(
        `agent-ping replayed ${replay.candidates} unacknowledged pending item(s) from a previous ` +
          `run: ${replay.delivered} delivered, ${replay.failed} failed or timed out, ` +
          `${replay.suppressed} already delivered in this run, ${replay.notWired} with no notifier ` +
          '(HC-FR-07)',
      )
    }
    lifecycle.markRunning()

    // 9. The desktop shell, last, so nothing is mounted over a hub that is not
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
    // timer or a signal handler running in a process that is about to report the
    // failure. The lifecycle's handlers go first: a failed start is not a hub, and a
    // process that has just reported a failure must not be listening for a signal that
    // would run a shutdown against a hub that was never built.
    lifecycle.dispose()
    try {
      await delivery?.close()
    } catch {
      // The failure being reported is the one that caused this cleanup.
    }
    try {
      await ingest?.close()
    } catch {
      // As above.
    }
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
function unpublishedIdentity(claim: HubInstanceClaim, lifecycle: HubLifecycle): HubIdentity {
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
    listening: () => false,
    state: (): HubState => lifecycle.state().state,
  }
}

/**
 * The bridge from the ingest pipeline's delivery port to the delivery policy.
 *
 * Three lines, and the only place the two layers meet. The policy resolves with an
 * outcome and never throws, which is what lets it keep its own record and its own
 * bound; the ingest pipeline is built to record a throwing port as a dropped delivery
 * with a reason (HC-FR-09). So the adapter turns any outcome that is not `delivered`
 * into a rejection carrying the policy's own record - a `DeliveryFailedError`, whose
 * message names the outcome and the reason and quotes nothing from the event.
 *
 * The consequence is that one failed notification is visible from all three places a
 * caller could look: the policy's ledger, the pipeline's drop ledger, and health
 * (APX-FR-02, ADR-010). And a hub with no notifier behind the port never gets here at
 * all, because the pipeline's `deliveryWired` is the policy's own `wired`.
 */
function deliveryPort(delivery: DeliveryPolicy): DeliveryPort {
  return async (request: Parameters<DeliveryPort>[0]): Promise<void> => {
    const attempt = await delivery.deliver(request, 'event')
    if (attempt.outcome !== 'delivered') throw new DeliveryFailedError(attempt)
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
 * the tray that opens it belongs to NT-3, so the only thing this function does
 * with the desktop is keep the process alive until the hub is closed. The notifier
 * the hub is started with is the same one a plain `startHub` gets, because it is
 * resolved inside `startHub` (NT-1) rather than here: an Electron process and a
 * plain Node process on the same machine must notify the same way.
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
  // `app.quit` rather than `process.exit` as the lifecycle's exit, so the ordered
  // shutdown ends with Electron tearing the application down in its own order. The
  // lifecycle still owns the *sequence* - refuse, drain, flush, close, release - and a
  // second `before-quit` is a no-op because `shutdown` is idempotent, which matters
  // because a quit can be requested twice (a tray click and a session logout, say).
  const hub = await startHub({
    desktop: { isPrimaryInstance: true },
    lifecycle: { exit: (): void => app.quit() },
  })

  // The same path a signal takes, so a quit from the tray and a `systemctl stop` are
  // not two shutdown implementations.
  app.on('before-quit', () => {
    void hub.lifecycle.shutdown('electron-quit')
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
