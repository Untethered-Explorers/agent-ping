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
//   8. the restart replay, with the socket bound and the port published
//   9. the desktop shell: the tray icon, then the hub reporting `running`
//
// One step sits earlier than its neighbours and is deliberately so: the notification
// surface host (4a, NT-6) is created before the delivery policy rather than beside the
// tray, because NT-FR-04 says a desktop that refuses the card window must leave every
// delivery recorded as `not-wired`, and a notifier wired before the refusal was known
// could not be unwired again. It takes the live origin as a thunk for the same reason -
// the port is not known until step 6 - so the window exists from the hub's start and the
// card document is loaded with the first card.
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
// The surface notifier is wired (NT-8): there is one delivery path in this product and
// it is the card - a document this product draws in a window it owns - so the
// composition root hands the delivery policy a notifier built over the mounted surface
// host and the card renderer, and the notifier applies the one class policy (a card
// that stays until it is resolved for a block, one that expires for a finished turn,
// and nothing at all for an fyi). The platform registry and its three notifiers, which
// started a process each and asked an operating system to speak, were deleted: nothing
// in this product now reaches a notification service on any platform (ADR-012,
// NT-FR-02, NT-FR-11). A run with no surface, a run whose desktop refused the window,
// and a run with a window but no card renderer are all `not-wired` with a diagnostic
// line, which is the honest answer rather than a delivered lie (APX-FR-02). A refused
// class is a *suppression* in the policy's own ledger: it is recorded, and it is
// counted neither as a delivery nor as a failure (NT-FR-09).
// The tray is wired too (NT-3): the icon is mounted here, over the desktop bridge's five
// platform calls and this file's own pending set, its badge is the pure function in
// src/tray/badge.ts, its menu is two rows and has no suppression control in it, and its
// click resolves the same deep link the card carries. The icon goes down first in the
// shutdown, because it reads the log this file closes.
// The card surface is wired as well (NT-6): a frameless, transparent, always-on-top,
// taskbar-skipping, unfocusable window, created here with `show: false` so it draws
// nothing until a card exists, positioned inside the display *work area* rather than the
// screen rectangle, and shown with `showInactive` so a card cannot take the keystroke the
// developer is typing. The window is destroyed first in the shutdown, before the tray and
// before the listener closes, because a card outliving the hub is a screen advertising a
// block whose deep link can no longer be resolved. `electron` is a real dependency of
// this package as of NT-6, and the Chromium process-sandbox launch policy is applied
// explicitly before the app is ready rather than inherited from a default that aborts at
// startup on a per-user install (src/notify/surface/electron-host.ts).
// The Electron bridge also supplies `renderCard` (NS-2), so a real block now becomes a
// real card: the window's `webPreferences` name a preload, the preload exposes exactly
// `show` and `remove` on one global, and this file's presenter sends the one message
// behind each. Nothing about the renderer was widened to make that work - `contextIsolation`,
// `nodeIntegration: false` and the renderer `sandbox` are all still in force, and a test
// asserts all three survive this wiring. A runtime with no `ipcMain` gets a diagnostic and
// the previous honest `not-wired` answer rather than a card it cannot deliver (NT-FR-12).
// The bridge supplies `dismissCard` as well (NS-3), and the hub wires the two triggers
// that take a card off the screen: the ack route's one transition, and the live state
// feed's own resolution frame. The dismissal is a port, not a second delivery path - it
// cannot show a card, cannot deliver anything, cannot read a row and records no counter -
// and it is held in both of the `HubServices` objects below rather than in one of them.
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

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openCounters, type Counters } from '../storage/counters.js'
import { openEventStore, type EventStore, type PendingItem } from '../storage/eventStore.js'
import { databaseFilePath, ensureStateDir, resolveStateDir } from '../storage/paths.js'
import { createPendingLifecycle, type PendingLifecycle } from '../domain/pending.js'
import { READ_ROUTES, type HubDesktopState, type HubIdentity, type HubServices } from '../hub/routes/read.js'
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
  createHubTray,
  type DeepLinkDispatch,
  type HubTray,
  type TrayBridge,
} from '../hub/tray.js'
import {
  resolveSurfaceNotifier,
  toNotifierPort,
  type CardPresenter,
  type SurfaceNotifier,
  type SurfaceNotifierResolution,
} from '../notify/registry.js'
import {
  createCardDismissal,
  isCardTransition,
  type CardDismissal,
  type CardRemover,
  type CardTransition,
} from '../notify/surface/dismissal.js'
import { cardLifetimeFor } from '../notify/surface/lifetime.js'
import {
  applyChromiumLaunchPolicy,
  createElectronCardChannel,
  createElectronSurfaceHost,
  launchPolicyApplied,
  surfaceDocumentUrl,
  type BrowserWindowLike,
  type ScreenLike,
} from '../notify/surface/electron-host.js'
import {
  SurfaceWindowRefusedError,
  type NotificationSurfaceHost,
  type SurfaceHostBridge,
} from '../notify/surface/host.js'
import { DEFAULT_SURFACE_CORNER } from '../notify/surface/position.js'
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
  /**
   * The platform's tray surface, and the only way this product can put an icon on a
   * desktop (NT-3, NT-FR-05).
   *
   * Absent in a headless run - a test, `agent-ping status`, a verification script -
   * and then the hub runs without an icon, which is a supported run rather than a
   * degraded one: those callers read the same loopback origin this process serves.
   * Present, the composition root builds the tray over it (src/hub/tray.ts) and mounts
   * it before the hub reports `running`, because PRD 10's `running` means "accepting
   * events, with the tray present".
   *
   * This replaced a bare `mountTray?(hub)` seam that HC-1 left for NT-3 to fill. The
   * seam was a callback with nowhere to get a tray *from*; the tray is this product's
   * behaviour and the desktop supplies only the five platform calls, so asking the
   * desktop to mount it would have made the platform the owner of a decision it
   * cannot make (which session a click focuses, and when a badge is redrawn).
   */
  readonly tray?: TrayBridge
  /**
   * The platform's window surface, and the only way this product can draw a card
   * (NT-6, NT-FR-04, ADR-012).
   *
   * Absent in a headless run, exactly as `tray` is, and the two are answered the same
   * way: the hub runs without a card surface, which is a supported run rather than a
   * degraded one, and nothing pretends a window is on a desktop. `agent-ping status`, a
   * test and a verification script all read the loopback origin this process serves.
   *
   * Present, the composition root creates the host here rather than asking the desktop
   * to mount it, for the same reason it builds the tray: the option set, the placement,
   * the click-through direction and the load are decisions no platform gets to make, and
   * the desktop's whole contribution is one window.
   *
   * It is mounted *before* the delivery policy is built rather than beside the tray,
   * which is a deliberate ordering and the only ordering that makes NT-FR-04's last
   * clause true: a desktop that refuses the window must leave every delivery recorded as
   * `not-wired`, and a notifier wired before the refusal was known could not be unwired
   * again. The host takes the live origin as a thunk for the same reason - the loopback
   * port is not known until the socket is bound, and the card document is loaded with
   * the first card rather than at mount.
   */
  readonly surface?: SurfaceHostBridge
  /**
   * How a card is rendered into the surface window, when this run has one.
   *
   * The second half of a card, and the reason a window on its own is not enough: the
   * surface host owns a window and knows about placement and nothing about content
   * (src/notify/surface/host.ts), while what a card *says* is a pure model
   * (src/notify/surface/card.ts) that has to become a document somewhere. This member
   * is that somewhere (NT-8, ADR-012).
   *
   * The Electron bridge supplies it (NS-2): a preload named in the window's
   * `webPreferences`, one global on the card document carrying exactly `show` and
   * `remove`, and this file's presenter sending the one message behind each. A run with
   * it is wired, and a real block posted to it becomes a real card counted as delivered.
   *
   * Absent means this run has a window and no way to put a card in it, which is
   * reported as `not-wired` with a diagnostic rather than as a delivery - a transparent
   * rectangle on a developer's screen is not a card, and reporting it as one would be the
   * exact lie APX-FR-02 forbids. That is what a headless run, a test, a verification
   * script and an Electron runtime with no `ipcMain` all get today.
   *
   * Absent entirely on a headless run, exactly as `tray` and `surface` are: no desktop,
   * no window, no card, and no stub pretending otherwise.
   */
  readonly renderCard?: CardPresenter
  /**
   * How a card is taken off the screen, when this run has one.
   *
   * The other half of a card, and it is a separate member rather than a second method on
   * the presenter for the reason the surface host is not handed its window: the notifier
   * *shows* a card and this product is done with it, while a dismissal arrives from the
   * hub's own acknowledgement and from a harness's resolution, and is a different event
   * with a different reason (NS-3, NT-FR-12).
   *
   * The Electron bridge supplies it (NS-2's channel, with the removal NS-3 added): it
   * sends the one message that carries an end and then calls the host's own `hide`, so
   * nothing occupies screen space once nothing is showing (NT-FR-10). The decision that
   * a card *should* go down is the hub's (src/notify/surface/dismissal.ts) and this
   * function makes no decision at all.
   *
   * Absent means this run can put a card in the document but has no way to take it out.
   * That is a line on the diagnostic callback and nothing else: the delivery itself still
   * happened and is still counted, and the card stays up until the next one replaces it or
   * the hub stops. It is *not* a `not-wired` run - a card that is on the screen was shown,
   * and reporting a delivery as not made because the card cannot be dismissed would be a
   * different lie (NT-FR-09, APX-FR-02). The shipped bridge supplies both halves, so a
   * run that has one and not the other is a bridge somebody assembled by hand.
   */
  readonly dismissCard?: CardRemover
  /** The origin the hub published, once it is serving. */
  onHubReady?(hub: RunningHub): void
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
   * what the pipeline is told, so a hub that can show nobody anything counts
   * `not-wired` deliveries rather than passing silently (APX-FR-02). A test uses this
   * option to observe that the answer is returned before any delivery work begins.
   */
  readonly ingest?: Partial<Omit<IngestServiceOptions, 'store'>>
  /**
   * Overrides for the delivery policy (HC-FR-07).
   *
   * Production passes nothing. The notifier is the surface's own, constructed by
   * `resolveSurfaceNotifier` below and injected into the policy, so the live path and
   * the restart replay reach the same notifier without either of them naming a
   * platform or a window. The one override that matters is `notifier`, and it exists
   * so a test can watch one classified event become one attempt without a desktop;
   * passing one replaces the surface notifier, so a test that does it is testing the
   * policy and not the card, which is the right way round for both claims. The suites
   * that do exactly that are the ones that must not put a real card on a developer's
   * screen during a full `npm test` run.
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
   * The notifier resolution this hub was built with (NT-8): whether this run can show a
   * card, and if it cannot, which of the three reasons it is.
   *
   * Exposed so `doctor` reports notifier availability from the same resolution the
   * deliveries went through rather than by constructing a second notifier (IO-2,
   * NT-FR-09). Holding it grants nothing: calling `notifier` is a delivery attempt the
   * policy owns, and `probe` only reports whether a window can be created - there is
   * no tool to be installed, because nothing here starts a process (ADR-012, NT-FR-11).
   */
  readonly notifier: SurfaceNotifierResolution
  /**
   * The shutdown path (HC-FR-10): PRD 10's lifecycle state, and the one ordered
   * shutdown a signal, an Electron quit and a test all take.
   */
  readonly lifecycle: HubLifecycle
  /**
   * The tray, once it is mounted (NT-FR-05): the icon's badge, the two menu actions
   * and the deep link a click resolves.
   *
   * Null on a headless run, which is the honest answer rather than a stub that looks
   * mounted: there is no desktop to be present on. Exposed for `doctor` and for a test
   * that has to watch a badge follow the pending set through the real entry point, and
   * because the hub's own shutdown has to take the icon down. Holding it grants
   * nothing beyond reading a number and opening a dashboard - the menu has no
   * suppression control and the tray cannot acknowledge anything (NT-FR-06,
   * APX-CON-08).
   */
  readonly tray: HubTray | null
  /**
   * The notification surface host, once its window is created (NT-FR-04, NT-FR-10,
   * ADR-012): the always-on-top, frameless, transparent, unfocusable window a card is
   * painted into.
   *
   * Null in two different situations, and both are honest rather than stubbed. On a
   * headless run there is no desktop to create a window on, which is a supported run: the
   * tests, the CLI and the verification scripts read this hub's loopback origin without
   * ever needing a card. And on a run whose desktop *refused* the window, where the
   * diagnostic above says so and every delivery is recorded as `not-wired` - a missing
   * card surface is never a lost block and never a delivery somebody was told about.
   *
   * Exposed for `doctor`, for NT-8's surface notifier and for NT-9's probe, and because
   * the hub's own ordered shutdown has to destroy the window before the listener closes.
   * Holding it grants nothing beyond showing and hiding a card: it cannot be moved, made
   * audible, or pointed at anything but this hub (APX-CON-08).
   */
  readonly surface: NotificationSurfaceHost | null
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
  // The tray (NT-3). Out here with the other half-started objects because both
  // shutdown paths have to be able to take it down: the one inside the try below and
  // the one in the catch, which is a start that failed after it was mounted.
  let tray: HubTray | null = null
  // Read through a function rather than directly, because a `let` the type checker
  // has narrowed to `null` at the declaration is still the live tray by the time the
  // catch below runs, and the honest reading is a function whose return type the
  // checker cannot narrow.
  const mountedTray = (): HubTray | null => tray
  // The notification surface host (NT-6), declared here for the same reason the tray is:
  // both shutdown paths - the ordered one below and the catch for a start that failed
  // after it was created - have to be able to destroy the window.
  let surface: NotificationSurfaceHost | null = null
  const mountedSurface = (): NotificationSurfaceHost | null => surface

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
    // The feed as a constant rather than through the `let` above, for the same reason
    // `log` is one: the closures built further down outlive this block's narrowing, and
    // the shutdown path re-reads them long after the try has either finished or failed.
    const feed: ChangeFeed = stream

    // 4a. The notification surface host (NT-6, NT-FR-04), before the delivery policy and
    //     therefore before any notifier is wired. The order is the requirement, not a
    //     habit: NT-FR-04 says a desktop that refuses the window leaves every delivery
    //     recorded as `not-wired`, and a notifier wired before the refusal was known could
    //     not be unwired again. The window itself is created here, with `show: false`, so
    //     it draws nothing and occupies no screen space until a card exists (NT-FR-10).
    //
    //     The live origin is a thunk rather than a string because the bind below has not
    //     happened yet; the card document is loaded with the first card, by which time
    //     `server.origin` is the port this hub actually took.
    //
    //     A refusal is a supported run, not a crash, and it is answered the way the tray
    //     answers one: a line, a hub that keeps serving, and no stub pretending a window
    //     is on a desktop.
    if (options.desktop?.surface !== undefined) {
      try {
        surface = options.desktop.surface.create({
          origin: (): string => server?.origin ?? '',
          corner: DEFAULT_SURFACE_CORNER,
        })
      } catch (cause) {
        // The refusal's own sentence reaches the operator, and `SurfaceWindowRefusedError`
        // is an Error, so this covers both it and an unforeseen fault.
        diagnostic(
          'agent-ping could not create its notification surface window, so this run can show no ' +
            'card. The pending set, the log and the tray badge are unaffected, and every delivery ' +
            'is recorded as not-wired rather than as something somebody saw (NT-FR-04, APX-FR-02). ' +
            (cause instanceof Error ? cause.message : String(cause)),
        )
      }
    }
    // Asked for and not created. Distinct from "not asked for", which is the headless run
    // and is not a refusal - see the note on the notifier below.
    const surfaceRefused = options.desktop?.surface !== undefined && surface === null

    // 4a-ter. What this run's desktop holds, for the health payload (IO-2, IO-FR-04).
    //
    //     A function over the two `let`s above rather than a value, for two reasons that
    //     are the same reason. It is read at request time because the tray is mounted
    //     later in this function and taken down before the log closes, so a snapshot
    //     would be stale in both directions. And it is one function handed to both
    //     `HubServices` literals for the reason `dismissal` is named in both: a field
    //     that exists before the bind and not after it is a field a reader cannot rely
    //     on (NS-3).
    //
    //     "Asked for and refused" and "never asked for" stay apart here, because that
    //     distinction is what `doctor`'s remedies are built on: a headless Node run is a
    //     supported run, and a desktop that refused the window or the icon is a fault
    //     with a fault's remedy (NT-FR-04, NT-FR-05, NT-FR-11).
    const desktopState = (): HubDesktopState => {
      const bridge = options.desktop === undefined ? 'absent' : 'present'
      const trayRequested = options.desktop?.tray !== undefined
      const liveTray = mountedTray()
      return {
        bridge,
        tray: !trayRequested
          ? 'absent'
          : liveTray === null
            ? 'unavailable'
            : liveTray.mounted
              ? 'mounted'
              : 'closed',
        surface: options.desktop?.surface === undefined
          ? 'not-mounted'
          : mountedSurface() !== null
            ? 'available'
            : surfaceRefused
              ? 'window-refused'
              : 'not-mounted',
      }
    }

    // 4a-bis. The card dismissal (NS-3, NT-FR-12), between the host and the notifier
    //     because it needs both: the channel's removal, to take the card out of the
    //     document, and the hub's own live state feed, to hear about a resolution.
    //
    //     The decision this object makes is a card's own: whether the end that just
    //     arrived is one the card on the screen may end on, for the session it belongs
    //     to. The decision that a block was acknowledged, or resolved, is the hub's - the
    //     ack route's one transition and the pending lifecycle's one resolution - and
    //     neither is a route this added (APX-CON-08, ADR-002).
    //
    //     `remove` is the desktop's own dismissal and is null when the bridge did not
    //     supply one - a headless run, a run whose window was refused, and a runtime with
    //     no `ipcMain`. A null removal records no card and dismisses nothing, so a
    //     stub cannot report a removal this product never made (APX-FR-02). A bridge that
    //     can *show* a card but supplied no way to take it down is said out loud below,
    //     because a card whose only ending is the window being destroyed is the
    //     situation NS-3 exists to close and a caller deserves to know it is still there.
    const dismissal: CardDismissal = createCardDismissal({
      remove: options.desktop?.dismissCard ?? null,
      onDiagnostic: diagnostic,
    })
    if (options.desktop?.renderCard !== undefined && options.desktop.dismissCard === undefined) {
      diagnostic(
        'agent-ping can put a card on the screen on this run but was given no way to take it ' +
          'down, so an acknowledged or resolved block leaves its card up until the next one ' +
          'replaces it or the hub stops (NT-FR-12, NT-FR-10, APX-FR-02)',
      )
    }
    // The live state feed, as the one line the dismissal reads. A structural reader
    // rather than the feed itself, so nothing under src/notify imports a hub type and
    // the narrowing is a guard a test can hand a poisoned value: a heartbeat, a close
    // and anything the feed published that is not a transition all pass through here and
    // none of them reaches a dismissal (HC-FR-03).
    dismissal.watch({
      subscribe: (listener): (() => void) =>
        feed.subscribe({
          onFrame: (frame): void => {
            if (frame.event !== 'change') return
            if (!isCardTransition(frame.data)) return
            listener(frame.data as CardTransition)
          },
          onHeartbeat: (): void => undefined,
          // The feed is closing, so the hub is shutting down and the surface window has
          // already been destroyed. Nothing is read and nothing is removed here: the
          // ordered shutdown took the card down, which is the `destroyed` end and not
          // either of the two this port produces (HC-FR-10).
          onClose: (): void => undefined,
        }),
    })

    // 4b. The delivery policy (HC-FR-07), over the same wrapped store and before the
    //     ingest pipeline, because the pipeline's port *is* this policy. Built here
    //     and nowhere else: the composition root is the single place a collaborator is
    //     constructed, which is what keeps a second delivery path from being a diff
    //     nobody reads.
    //
    //     The notifier is the surface's (NT-8), resolved here rather than inside the
    //     policy, for two reasons. The composition root is the one place in this
    //     product that wires things, so "what can reach a developer" is a line of this
    //     file rather than a search. And the policy and the notifier then have no
    //     dependency on each other at all - the policy only knows a function it was
    //     handed - so the surface is a replacement rather than an edit.
    //
    //     There is one notifier and it is this one. The platform registry NT-1 built
    //     is gone, and so are the three notifiers behind it: a card is a document this
    //     product draws in a window it owns, on every platform, and no operating
    //     system's notification service is involved (ADR-012, NT-FR-02, NT-FR-11).
    //
    //     A run with no surface, a run whose window was refused, and a run with a
    //     window but no card renderer all leave the port unwired, and the policy reports
    //     `not-wired` on health while the ingest pipeline counts `not-wired` attempts,
    //     so "nobody was shown anything" is visible from both ends rather than papered
    //     over with a notifier that always succeeds (APX-FR-02). A *headless* run is the
    //     first of those three, deliberately: the tests, the CLI and the verification
    //     scripts keep the wiring they already have.
    const surfaceNotifier = resolveSurfaceNotifier({
      host: surface,
      present: options.desktop?.renderCard ?? null,
      refused: surfaceRefused,
      onDiagnostic: diagnostic,
    })
    if (!surfaceNotifier.supported) {
      // A line, because a hub that can show nobody anything is degraded in a way an
      // operator has to be told about, and the state it reports is `not-wired` rather
      // than a failure. No notifier is constructed on this path, so no card can be
      // claimed by accident.
      diagnostic(
        `agent-ping has no way to show a card on this run (${surfaceNotifier.reason}), so every ` +
          'delivery is recorded as not-wired and nothing is put on a developer\'s screen (NT-FR-04, ' +
          'APX-FR-02)',
      )
    }
    const notifierUnwired = !surfaceNotifier.supported
    delivery = createDeliveryPolicy({
      store: watching,
      // The live origin, read per request rather than captured: the bind below is what
      // chooses the port, and a deep link built from the preferred one would point at
      // a port nobody is listening on (HC-FR-01, HC-FR-07).
      origin: (): string => server?.origin ?? '',
      //     The one conversion between the two notifier shapes: the surface notifier
      //     resolves with an outcome carrying a reason, and the policy's port has
      //     "resolved", "thrown" and one typed suppression - so the adapter is where a
      //     `failed` outcome becomes a throw the policy records as a failure with its
      //     reason beside it, and where a *refused* class becomes a suppression rather than
      //     a delivery (APX-FR-02, ADR-010, NT-FR-09). An `fyi` is refused by the class
      //     policy before a card is built at all and is never counted as a notification
      //     (NT-FR-02).
      //
      //     The wrapper below it is where a session and a card finally meet, and it is
      //     the only place in this process that knows which session the card on the
      //     screen belongs to (NS-3). The notifier's own request is the only value that
      //     carries both, and a `delivered` outcome is the only answer that means a card
      //     is on the screen - a refusal drew nothing, and a failure says so itself.
      ...(notifierUnwired || surfaceNotifier.notifier === null
        ? {}
        : {
            notifier: toNotifierPort(rememberingCard(surfaceNotifier.notifier, dismissal), {
              onDiagnostic: diagnostic,
            }),
          }),
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
      // The same object the post-bind literal below carries, and it is named in both on
      // purpose: these two literals are the whole of what a handler is ever given, and a
      // port present in one of them and absent from the other is a field that exists
      // until the socket is bound and then stops existing (NS-3).
      dismissal,
      // The pre-bind identity, which reports a desktop of its own because nothing is
      // mounted yet - the same closure the post-bind literal below carries, so the two
      // cannot disagree about what a desktop is.
      hub: { ...unpublishedIdentity(claim, lifecycle), desktop: desktopState },
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
      // The same object the pre-bind literal above carries, for the reason given there
      // (NS-3).
      dismissal,
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
        // The same closure the pre-bind literal above carries, read at request time for
        // the same reason `listening` is (IO-2, IO-FR-04).
        desktop: desktopState,
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
       * The notifier resolution, so `doctor` can ask whether this run can show a card
       * at all - and why not if it cannot - without building a second notifier. The
       * same object the policy above was given (NT-8).
       */
      notifier: surfaceNotifier,
      lifecycle,
      /**
       * The tray, behind a getter because it is mounted after this object is built.
       * Null on a headless run and on a hub whose desktop bridge could not mount one;
       * never a stub that answers as though an icon were on a desktop.
       */
      get tray(): HubTray | null {
        return mountedTray()
      },
      /**
       * The surface host, behind a getter for the same reason `tray` is one: it is
       * mounted before this object is built but replaced on a refusal. Null on a headless
       * run and on a run whose desktop refused the window; never a stub that answers as
       * though a card surface were on a desktop (NT-FR-04).
       */
      get surface(): NotificationSurfaceHost | null {
        return mountedSurface()
      },
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
        // The order a shutdown has to have: destroy the card surface, take the icon down,
        // refuse new deliveries, stop accepting events, end the live streams, stop
        // answering, fold the counters into the file, close the log, then give the
        // runtime file back. The delivery drain goes second and the feed fourth; every
        // placement is deliberate.
        //
        // The surface goes first of all, before the tray and before the listener, and
        // that is NT-FR-04's "destroyed in the ordered shutdown" made load-bearing rather
        // than chronological. A card is the only thing this product puts on a developer's
        // screen without being asked, so a card that outlives the hub is a screen
        // advertising a block nobody can acknowledge, retry, or open a dashboard for: the
        // deep link in it resolves against a listener that has already closed. It is
        // destroyed first because there is no state it needs that outlives the next step,
        // and because a transparent frameless window that a compositor is still holding
        // while this process tears down is the shape of an application that did not shut
        // down cleanly (APX-FR-02, ADR-010).
        //
        // The tray follows, and before the feed, and the two are the same decision
        // (NT-FR-05): the icon reads this hub's pending set through the change
        // feed's transitions, so a tray that outlived the feed or the log is an icon
        // advertising a hub that no longer answers - and, on the way out, either a read
        // failure or a redraw of a number nobody can act on any more. Taking it down
        // first is what makes "present for as long as the hub runs" true at both ends
        // rather than only at the start (APX-FR-02).
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
          mountedSurface()?.destroy()
        } catch (cause) {
          firstError = cause
        }
        try {
          mountedTray()?.close()
        } catch (cause) {
          firstError ??= cause
        }
        try {
          await delivery?.close()
        } catch (cause) {
          firstError ??= cause
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
    // 9. The desktop shell and the tray, with the socket bound and the port
    //    published but before the hub reports `running`.
    //
    //    That order is the requirement rather than a habit. PRD 10's `running` state
    //    means "accepting events, with the tray present" (NT-FR-05), so a client that
    //    trusted `running` and looked for the icon would be right. The hub is already
    //    serving at this point, so nothing is mounted over a hub that cannot answer -
    //    which is the other half of the rule step 9 used to state on its own.
    const desktop = options.desktop
    if (desktop !== undefined && !desktop.isPrimaryInstance) {
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

    if (desktop?.tray !== undefined) {
      // The tray is this product's behaviour (src/hub/tray.ts) and the bridge is only
      // the platform's five calls, so the composition root builds it here rather than
      // asking the desktop to mount one: the badge's rule, the menu's two rows and the
      // click's deep link are decisions no platform gets to make.
      //
      // A bridge that refuses leaves the hub serving with no icon and a line saying
      // so. That is the honest answer rather than a stub that answers as though an
      // icon were on a desktop, and rather than refusing to start a hub over a missing
      // tray: the pending set, the log and the toasts are all still correct, and the
      // badge is a signal rather than the record (APX-FR-02, ADR-010).
      try {
        tray = createHubTray({
          bridge: desktop.tray,
          // The same accessor `GET /api/pending` serves and the restart replay reads,
          // so the icon, the route and the replay cannot disagree about what is
          // outstanding (NT-FR-05).
          readPending: (): readonly PendingItem[] => watching.readPending(),
          // The feed, so the badge follows the pending set without polling: a
          // transition the store applied is a redraw, and a heartbeat is not
          // (src/hub/sse.ts).
          subscribe: (subscriber): (() => void) => stream?.subscribe(subscriber) ?? ((): void => undefined),
          // The live origin, read per click rather than captured: the bind above is
          // what chose the port, and a link built from the preferred one would send a
          // developer to whatever else on this machine answers there (HC-FR-01,
          // NT-FR-07).
          origin: (): string => server?.origin ?? '',
          counters: localMetrics,
          // The tray's quit is the hub's own ordered shutdown, so a quit from the menu
          // and a `systemctl stop` are not two shutdown implementations (HC-FR-10).
          quit: (): void => {
            void lifecycle.shutdown('tray-quit')
          },
          onDiagnostic: diagnostic,
        })
      } catch (cause) {
        diagnostic(
          'agent-ping could not mount its tray icon, so this run has no icon and no badge. The ' +
            `pending set, the log and the notifications are unaffected (NT-FR-05). ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
    }

    lifecycle.markRunning()
    desktop?.onHubReady?.(hub)
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
      // The surface before the tray here too, for the reason the ordered shutdown does
      // it in that order: a window created by a start that then failed must not be left
      // on the developer's screen by a process that is about to report the failure.
      mountedSurface()?.destroy()
    } catch {
      // The failure being reported is the one that caused this cleanup.
    }
    try {
      mountedTray()?.close()
    } catch {
      // The failure being reported is the one that caused this cleanup.
    }
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
    desktop: (): HubDesktopState => ({
      bridge: 'absent',
      tray: 'absent',
      surface: 'not-mounted',
    }),
  }
}

/**
 * The bridge from the ingest pipeline's delivery port to the delivery policy.
 *
 * Three lines, and the only place the two layers meet. The policy resolves with an
 * outcome and never throws, which is what lets it keep its own record and its own
 * bound; the ingest pipeline is built to record a throwing port as a dropped delivery
 * with a reason (HC-FR-09). So the adapter turns any outcome that means nobody was
 * told into a rejection carrying the policy's own record - a `DeliveryFailedError`,
 * whose message names the outcome and the reason and quotes nothing from the event.
 *
 * `suppressed` is the one outcome deliberately excluded, and it is the defect NT-8
 * fixed rather than a new rule: a refused class - every `fyi`, which by design never
 * leaves the app (NT-FR-02) - used to resolve as a delivery, so it counted as a
 * notification nobody saw and inflated the figure PRD 11 measures notification
 * restraint with. It is now a suppression, and a suppression is not a drop: nothing was
 * lost, the event is stored, and the pipeline has a separate word for an event it
 * declined to store (ADR-012, APX-FR-02, NT-FR-09).
 *
 * The consequence is that one failed card is visible from all three places a caller
 * could look: the policy's ledger, the pipeline's drop ledger, and health. And a hub
 * with no notifier behind the port never gets here at all, because the pipeline's
 * `deliveryWired` is the policy's own `wired`.
 */
function deliveryPort(delivery: DeliveryPolicy): DeliveryPort {
  return async (request: Parameters<DeliveryPort>[0]): Promise<void> => {
    const attempt = await delivery.deliver(request, 'event')
    if (attempt.outcome === 'delivered' || attempt.outcome === 'suppressed') return
    throw new DeliveryFailedError(attempt)
  }
}

/**
 * The bridge from a card on the screen to the hub that has to be able to take it down.
 *
 * The counterpart to `deliveryPort`, and the same shape for the same reason: this is the
 * one place the two halves meet, and the composition root is where a collaborator is
 * wired rather than where behaviour is decided.
 *
 * The only thing it adds is the session, and it adds it *after* the notifier has answered
 * rather than before. A `delivered` outcome is the notifier's own statement that a card
 * was rendered, so a refusal - an `fyi`, which never leaves the app (NT-FR-02) - records
 * nothing, and a failure records nothing either because nothing is on the screen to
 * remember. The cell is the lifetime table's own for the class the hub classified, read
 * with the same `cardLifetimeFor` the notifier itself used, so the table and not this
 * function decides which ends may take the card away (NT-FR-08, ADR-004).
 *
 * Nothing else changes: the outcome is passed through untouched, so a delivery is counted
 * exactly as it would have been, and no counter, row or request field is read on the way
 * (NT-FR-09, APX-FR-01).
 */
function rememberingCard(notifier: SurfaceNotifier, dismissal: CardDismissal): SurfaceNotifier {
  return async (request) => {
    const outcome = await notifier(request)
    if (outcome.status === 'delivered') {
      dismissal.shown(request.event.sessionId, cardLifetimeFor(request.class))
    }
    return outcome
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
  /**
   * Chromium's command line, which the launch policy is appended to before the
   * application is ready (src/notify/surface/electron-host.ts, CHROMIUM_LAUNCH_POLICY).
   */
  commandLine: import('../notify/surface/electron-host.js').CommandLineLike
}

/**
 * The slice of Electron's tray and image API the bridge below uses.
 *
 * Structural for the same reason `ElectronAppLike` is, and no more so: the package is
 * a runtime dependency of the packaged application rather than of the source tree, and
 * an interface this small is checkable by reading. `createFromBitmap` is the reason
 * the badge is drawn rather than loaded - it takes exactly the tightly packed BGRA
 * bytes src/tray/badge.ts produces, so the number on the icon is rendered by this
 * product's own pure code and not by a platform's idea of a badge (NT-FR-05, and the
 * feature document's Open Question 3).
 */
interface ElectronTrayLike {
  setImage(image: unknown): void
  setToolTip(tooltip: string): void
  setContextMenu(menu: unknown): void
  popUpContextMenu(): void
  on(event: string, listener: () => void): unknown
  destroy(): void
}

interface ElectronNativeImageLike {
  createFromBitmap(
    bitmap: Buffer,
    options: { width: number; height: number; scaleFactor?: number },
  ): unknown
}

/**
 * The slice of `screen` the surface bridge uses.
 *
 * One method, returning one display's *work area* - the usable rectangle, not
 * `bounds`. `bounds` is the screen rectangle, and a taskbar, a dock or a top panel lives
 * between the two; placing a card against `bounds` is the defect NT-FR-04 forbids
 * (docs/research/electron-surface-preflight.json recorded a 32px top inset on the
 * authoring machine, which is exactly the kind of thing an assumption gets wrong).
 */
interface ElectronScreenLike {
  getPrimaryDisplay(): { readonly workArea: { x: number; y: number; width: number; height: number } }
}

/**
 * The slice of `ipcMain` the card channel uses.
 *
 * One method, and it is the whole of the main process's use of `ipcMain`: the card
 * document's preload announces once that its channel is listening, and the composition
 * root's card presenter waits for that before it sends anything
 * (src/notify/surface/electron-host.ts, `createElectronCardChannel`).
 *
 * Structural for the reason `ElectronAppLike` is: the package is a runtime dependency of
 * the packaged application rather than of the source tree, so nothing under `src` may
 * import an Electron type, and an interface this small is checkable by reading.
 */
interface ElectronIpcMainLike {
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}

interface ElectronModuleLike {
  readonly app?: ElectronAppLike
  readonly Tray?: new (icon: unknown) => ElectronTrayLike
  readonly Menu?: { buildFromTemplate(template: readonly unknown[]): unknown }
  readonly BrowserWindow?: new (options: unknown) => {
    loadURL(url: string): Promise<void>
    destroy(): void
    showInactive(): void
    hide(): void
    isDestroyed(): boolean
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void
    setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void
    /** How a card model reaches the document (NT-FR-12). */
    webContents: {
      send(channel: string, ...args: readonly unknown[]): void
      isDestroyed(): boolean
    }
  }
  readonly screen?: ElectronScreenLike
  readonly nativeImage?: ElectronNativeImageLike
  readonly ipcMain?: ElectronIpcMainLike
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
 * The Electron tray, as this product's five platform calls.
 *
 * Everything Electron-specific about a tray icon is here and nowhere else: the
 * `Tray` object, the `Menu` built from the two rows the tray decides, the bitmap the
 * badge module drew, and whether opening a link will produce a document request. The
 * decisions - which session a click focuses, when the badge is redrawn, whether a
 * click counted anything - are the tray's (src/hub/tray.ts) and this file cannot
 * make them.
 *
 * The `openDashboard` answer is the load-bearing part. A `BrowserWindow` pointed at a
 * loopback URL *does* request the document, so that path reports
 * `dashboard-request-follows` and lets the hub's own dashboard route count the open -
 * counting it here as well would report one pull twice (HC-6). Anything that cannot
 * produce a request says so honestly rather than claiming an open that nobody made,
 * and the tray then counts nothing and reports the fault (APX-FR-02).
 *
 * VERIFICATION STATE: NOT LIVE-VERIFIED HERE. This was written on a Linux machine
 * with no Electron installed, so none of it has been run: not the `Tray`
 * constructor, not `createFromBitmap`'s byte order, not whether a left click reaches
 * `on('click')` on each of the three desktops. What *is* verified is everything above
 * this function - the badge's rules, the menu's two rows, the click's deep link and
 * the counting rule - through tests/hub/tray.test.ts against this interface. NT-4's
 * and NT-5's human gates are where the platform half is observed, and the runbook
 * says the same (APX-CON-06).
 */
function electronTrayBridge(electron: ElectronModuleLike): TrayBridge {
  const Tray = electron.Tray
  const Menu = electron.Menu
  const nativeImage = electron.nativeImage
  // Electron's own names are read off a module that may not have them - a headless
  // build, a stripped runtime - and a missing one is a reported fault rather than a
  // crash, so every platform object is fetched through here and nothing is assumed to
  // exist before the first call that needs it.
  const needed = <T,>(what: string, available: T | undefined): T => {
    if (available === undefined) {
      throw new Error(
        `the Electron runtime did not provide \`${what}\`, so this build cannot put a tray icon on ` +
          'the desktop. The hub is unaffected: the pending set, the log and the notifications are ' +
          'unchanged and the badge is a signal rather than the record (NT-FR-05, APX-FR-02).',
      )
    }
    return available
  }
  let tray: ElectronTrayLike | null = null
  let activated: (() => void) | null = null

  const present = (): ElectronTrayLike => {
    if (tray === null) {
      const image = needed('nativeImage', nativeImage).createFromBitmap(Buffer.alloc(0), {
        width: 1,
        height: 1,
      })
      tray = new (needed('Tray', Tray))(image)
      // A left click is the activation NT-FR-07 promises. A right click opens the menu,
      // which is the platform's own convention and the reason the menu is reachable
      // without a keyboard.
      tray.on('click', () => {
        activated?.()
      })
      tray.on('right-click', () => {
        tray?.popUpContextMenu()
      })
    }
    return tray
  }

  return {
    showIcon: (icon): void => {
      const current = present()
      const image = needed('nativeImage', nativeImage).createFromBitmap(Buffer.from(icon.pixels), {
        width: icon.width,
        height: icon.height,
      })
      current.setImage(image)
      current.setToolTip(icon.tooltip)
    },

    showMenu: (view): void => {
      const menu = needed('Menu', Menu)
      present().setContextMenu(
        menu.buildFromTemplate(
          view.items.map((item) => ({
            label: item.label,
            // Electron hands the selection back through the row's own click, so the
            // tray's table stays the only place a menu action is defined.
            click: (): void => {
              view.select(item.id)
            },
          })),
        ),
      )
    },

    onActivate: (listener): void => {
      activated = listener
      present()
    },

    openDashboard: (url): DeepLinkDispatch => {
      // A window pointed at the URL is the request: Electron will fetch the dashboard
      // document over the loopback socket, and the hub's own route counts the open and
      // the deep link. Returning any other answer here would double count it (HC-6).
      const window = new (needed('BrowserWindow', electron.BrowserWindow))({
        show: true,
        width: 1100,
        height: 760,
        title: 'agent-ping',
      })
      void window.loadURL(url)
      return { kind: 'dashboard-request-follows' }
    },

    destroy: (): void => {
      tray?.destroy()
      tray = null
      activated = null
    },
  }
}

/**
 * The Electron window surface and its card channel, as this product's two operations.
 *
 * The counterpart to `electronTrayBridge`, and shaped the same way on purpose: the
 * desktop supplies the platform objects and this product supplies every decision about
 * what to do with them. Everything Electron-specific about a notification card is in the
 * two calls below - the `BrowserWindow` option set (which is data in
 * src/notify/surface/electron-host.ts, and is asserted rather than restated), the
 * `workArea` read that keeps a card off the taskbar, `showInactive`, which is the
 * difference between a notification and an interruption, and the two ipc messages the
 * preload carries. The composition root decides when a card exists and what corner it goes
 * in, because those are this product's decisions (src/notify/surface/host.ts).
 *
 * ONE HOLDER, BECAUSE BOTH HALVES NEED THE SAME WINDOW
 * The host owns the window and creates it when the hub mounts the surface; the channel
 * needs that window's `webContents` to send on. The host is given an `onWindowCreated`
 * hook rather than being widened, because `NotificationSurfaceHost` must stay exactly
 * `probe`, `show`, `hide`, `setClickThrough` and `destroy` - tests/notify/surface-host.test.ts
 * enumerates the interface from source, and a sixth member added to make this convenient
 * would be a card's delivery surface on the window contract (NT-FR-12).
 *
 * The origin arrives as a thunk because the host is mounted before the loopback socket
 * is bound, and the card document must be loaded from the port this hub actually took
 * rather than the one it preferred (HC-FR-01). `surfaceDocumentUrl` is applied here, at
 * the boundary, so the loopback guarantee is a property of how the bridge is built and
 * not of every future caller.
 *
 * WHAT SUPPLIES THE CARD RENDERER, AND WHAT IT DOES NOT
 * `renderCard` is built over the real preload and the real `ipcMain`, and a run with them
 * is a *wired* run: a real block becomes a real card, and the notifier reports
 * `delivered` rather than `not-wired`. That is the change this wiring exists for - before
 * it, the shipped Electron bridge handed out a window and nothing else, so every delivery
 * was honestly recorded as not-wired and no card ever left this machine
 * (NT-FR-12, APX-FR-02).
 *
 * `dismissCard` is the same channel's other half, and it is handed over beside the
 * renderer rather than on its own (NS-3): a channel that can put a card into the document
 * and not take it out is a card whose only ending is the window being destroyed at
 * shutdown, so the two are never separated. The composition root decides *whether* a card
 * should go down; this function only knows how to send the one message that takes it out
 * and to call the host's own `hide` afterwards (NT-FR-10).
 *
 * It is still absent in one case, and it is absent rather than throwing: a runtime with
 * no `ipcMain` cannot carry a model into a document at all, so this reports a diagnostic
 * and hands the composition root no renderer, which is the product's existing `not-wired`
 * answer with its existing words. A window with nothing in it is not a card, and reporting
 * it as one would be the exact lie APX-FR-02 forbids.
 *
 * VERIFICATION STATE: the window primitives and the channel were both driven against the
 * real Electron 44.4.5 binary on the authoring machine (Ubuntu 24.04, X11 :1) with this
 * product's own option set: the exposed surface arrived in the document with a key set of
 * exactly `remove` and `show`, a model crossed and rendered, a removal emptied the
 * surface, and the page had neither `process` nor `require`. What that run cannot say is
 * anything about how the three desktops composite the window (NT-FR-03, APX-CON-06).
 */
function electronSurfaceChannel(electron: ElectronModuleLike): {
  readonly surface: SurfaceHostBridge
  readonly renderCard: CardPresenter | undefined
  readonly dismissCard: CardRemover | undefined
} {
  // The one window both halves share, read rather than captured: the host is created when
  // the hub mounts the surface, which is after this runs.
  const holder: { host: NotificationSurfaceHost | null; window: BrowserWindowLike | null } = {
    host: null,
    window: null,
  }
  const needed = <T,>(what: string, available: T | undefined): T => {
    if (available === undefined) {
      throw new SurfaceWindowRefusedError(
        `the Electron runtime did not provide \`${what}\`. The hub is unaffected and every ` +
          'delivery is recorded as not-wired rather than as a card somebody saw (NT-FR-04).',
      )
    }
    return available
  }
  const surface: SurfaceHostBridge = {
    create: (options): NotificationSurfaceHost => {
      const host = createElectronSurfaceHost({
        BrowserWindow: needed('BrowserWindow', electron.BrowserWindow) as unknown as new (
          options: unknown,
        ) => BrowserWindowLike,
        screen: needed('screen', electron.screen) as ScreenLike,
        documentUrl: (): string => surfaceDocumentUrl(options.origin()),
        onWindowCreated: (window): void => {
          holder.window = window
        },
        onDiagnostic: (message: string): void => {
          process.stderr.write(`${message}\n`)
        },
        ...(options.corner === undefined ? {} : { corner: options.corner }),
      })
      holder.host = host
      return host
    },
  }

  const ipcMain = electron.ipcMain
  if (ipcMain === undefined) {
    process.stderr.write(
      'agent-ping: the Electron runtime provided no `ipcMain`, so no card model can cross into the ' +
        'card document and this run can show no card. The hub is unaffected, the tray badge and the ' +
        'pending set are unchanged, and every delivery is recorded as not-wired rather than as a ' +
        'card somebody saw (NT-FR-12, APX-FR-02).\n',
    )
    return { surface, renderCard: undefined, dismissCard: undefined }
  }
  // Built once, here, and not per card. The channel's `ipcMain` listener is registered
  // eagerly so it is in place before the card document loads, and its readiness state and
  // its one expiry have to be shared across every card; a channel built per presentation
  // would register a second listener, arrive after the announcement it was waiting for,
  // and give every card a fresh expiry arm (APX-FR-02, NT-FR-08).
  const channel = createElectronCardChannel({
    ipcMain,
    window: (): BrowserWindowLike | null => holder.window,
    hide: (): void => {
      holder.host?.hide()
    },
    onDiagnostic: (message: string): void => {
      process.stderr.write(`${message}\n`)
    },
  })
  // The same object under two names, and that is deliberate: the notifier is given the
  // presenting half, the composition root the dismissing half, and neither can reach the
  // other's job. `renderCard`'s type does not carry `dismiss`, so a caller holding the
  // presenter cannot take a card down by accident (NS-3).
  return { surface, renderCard: channel, dismissCard: channel.dismiss }
}

/**
 * Everything the Electron entry point hands `startHub` as its desktop shell.
 *
 * One function rather than three bridges constructed at the call site, and exported for a
 * reason that is a test rather than a caller: a test can build a *structural* Electron
 * module - a `BrowserWindow` that records, a `screen`, an `ipcMain` - and hand the result
 * to the real `startHub`, so the question "does the shipped bridge supply a card renderer,
 * and does a real block then count as delivered" is answered by the real composition root
 * over a real socket rather than by reading this file's source. That is the only way the
 * claim can be made without a display and without an Electron binary in the test runner,
 * and it is what tests/notify/surface-channel.test.ts does.
 */
export function electronDesktopBridge(electron: ElectronModuleLike): {
  readonly tray: TrayBridge
  readonly surface: SurfaceHostBridge
  readonly renderCard: CardPresenter | undefined
  readonly dismissCard: CardRemover | undefined
} {
  const { surface, renderCard, dismissCard } = electronSurfaceChannel(electron)
  return {
    tray: electronTrayBridge(electron),
    surface,
    renderCard,
    dismissCard,
  }
}

/**
 * Start the hub as an Electron main process.
 *
 * The application lock is taken first, because Electron's is the one that knows
 * about the window; then the hub takes its own, because that is the one the
 * adapters and the CLI read. Both or neither.
 *
 * Two windows exist, and only one of them is a document. The card surface host is
 * mounted inside `startHub` (NT-6), beside the tray and before the delivery policy, over
 * the bridge built here. The dashboard is an on-demand surface (ADR-009), and the only
 * other thing this function opens is the window a tray click asks for. The tray itself is
 * mounted inside `startHub` (NT-3) over the bridge built here, so the mounted tray is
 * the same object a plain `startHub` produces and there is one implementation of the
 * badge, the menu and the click. The notifier the hub is started with is likewise the one
 * a plain `startHub` gets, because it is resolved inside `startHub` (NT-8) rather than
 * here: an Electron process and a plain Node process on the same machine must reach a
 * developer the same way.
 */
export async function startElectronMain(): Promise<RunningHub | null> {
  const electron = (await importModule('electron')) as ElectronModuleLike
  const app = electron.app
  if (app === undefined) {
    throw new Error(
      'the Electron runtime is not available: `electron` did not provide an `app`. This entry ' +
        'point is the Electron main process; a plain Node process should call startHub() instead.',
    )
  }

  // Before the application is ready, and therefore before any window exists, so every
  // Chromium child this process starts inherits the switch. This is the part of the
  // launch policy a running process can still affect and it is NOT what prevents the
  // abort: Chromium reads its command line and decides about the sandbox before any
  // JavaScript in this package runs, which was confirmed on the authoring machine (an
  // `app.commandLine.appendSwitch` from this line still died of the helper SIGTRAP). So
  // the gap between "the policy is decided" and "the policy reached the process" is
  // reported rather than assumed away - a readable line is the difference between an
  // operator who knows to add `--no-sandbox` and one holding a SIGTRAP with no message.
  // See CHROMIUM_LAUNCH_POLICY in src/notify/surface/electron-host.ts (NT-FR-04).
  const launchGap = launchPolicyApplied(process.argv, process.env)
  if (launchGap !== null) {
    process.stderr.write(`agent-ping: ${launchGap}\n`)
  }
  applyChromiumLaunchPolicy(app.commandLine)

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
    desktop: {
      isPrimaryInstance: true,
      // The tray, the card surface and the card channel, built together over the one
      // Electron module: the surface is mounted beside the tray and before the delivery
      // policy (NT-6), and the channel is what turns a delivery into a card rather than
      // into a `not-wired` record (NT-FR-12). A desktop that refuses the window still
      // leaves the hub serving with every delivery recorded as `not-wired`
      // (NT-FR-04, APX-FR-02).
      ...electronDesktopBridge(electron),
    },
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
 * Three conditions, all necessary. `process.versions.electron` is present only
 * inside Electron, so importing this file from a test or a script does nothing. The
 * entry check keeps a second `import` of this module inside the application from
 * starting a second hub, which the runtime file would then refuse anyway - but
 * refusing at the file level is a clearer failure than refusing at the lock.
 *
 * THE ENTRY CHECK SCANS ARGV RATHER THAN READING argv[1], and that is a fix.
 * Electron's `process.argv` puts Chromium's own switches *before* the script path, so
 * `electron --no-sandbox dist/main/main/index.js` gives
 * `['<electron>', '--no-sandbox', 'dist/main/main/index.js']` - and `argv[1]` is the
 * switch. A check that compared `argv[1]` to this module therefore answered "not the
 * entry point" for exactly the launch this product's own Chromium launch policy
 * requires (CHROMIUM_LAUNCH_POLICY in src/notify/surface/electron-host.ts), and the
 * application started nothing at all: no hub, no port, no runtime file, and no line on
 * stderr, because the branch that was taken was the one that returns. Every argv entry
 * that is not a switch is compared instead, so a switch anywhere in the command line no
 * longer hides the script. This was found by running the real built entry point under the
 * real binary on the authoring machine; the environment form of the policy
 * (`ELECTRON_DISABLE_SANDBOX=1`) does not shift argv, which is why it was not seen
 * before.
 */
function isElectronEntryPoint(): boolean {
  if (process.versions['electron'] === undefined) return false
  let self: string
  try {
    self = fileURLToPath(import.meta.url)
  } catch {
    return false
  }
  return process.argv.some((argument) => {
    // A Chromium switch is never a path this module could be, and one that resolves to
    // nothing is not evidence either way.
    if (argument.startsWith('-')) return false
    try {
      if (path.resolve(argument) === self) return true
    } catch {
      return false
    }
    // `electron .` is the documented way to run a package, and it is what an autostart
    // unit and this repository's own install command both use: Electron reads
    // `package.json`'s `main` and loads this module, but the argument in argv is the
    // package *directory*, which resolves to nothing this module could be. Without this
    // arm the process starts, loads nothing and exits - a silent no-op that looks like a
    // successful start to anything watching for a port. Found on this machine by
    // launching the built package that way and watching no hub appear.
    return namesThisModuleAsMain(path.resolve(argument))
  })
}

/**
 * Is this directory the package whose `main` is this module?
 *
 * Read out of the manifest rather than assumed from a `dist/` path, so the answer is the
 * manifest's own and a rename of the build output does not silently stop the application
 * from starting.
 */
function namesThisModuleAsMain(directory: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return false
    const main = (parsed as { main?: unknown }).main
    if (typeof main !== 'string' || main === '') return false
    return path.resolve(directory, main) === fileURLToPath(import.meta.url)
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
