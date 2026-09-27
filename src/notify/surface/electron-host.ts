// The notification surface host, over one Electron `BrowserWindow` (NT-FR-02, NT-FR-03,
// NT-FR-04, NT-FR-10, ADR-012).
//
// THE ONE FILE IN THE SURFACE PATH THAT NAMES ELECTRON
// ./host.ts declares the contract and imports no Electron module; this file is the whole
// of the platform side, and every `BrowserWindow` call in this product is here. The
// Electron module is taken as a *parameter* rather than imported, for the same reason
// src/main/index.ts loads it through a computed specifier: the source tree, the CLI, the
// tests and the verification scripts must all typecheck and run on a machine where
// Electron is not installed, and only the packaged application needs the real module. A
// literal `from 'electron'` here would make `npm run typecheck` depend on a binary.
//
// THE OPTION OBJECT IS DATA, AND IT IS ASSERTED
// `SURFACE_WINDOW_OPTIONS` is a frozen object, built once, and handed to the
// `BrowserWindow` constructor unchanged. It is data rather than an argument list at the
// call site so that tests/notify/surface-host.test.ts can assert the exact object the
// constructor receives - a test that read a spread of a literal at the call site would be
// asserting the call site, not the contract. Every entry in it is load-bearing:
//
//   show: false      NT-FR-10. The window exists for the life of the hub and draws
//                    nothing until a card is actually shown. `show: true` here would put
//                    an empty rectangle on the developer's screen for as long as the hub
//                    runs, which is the always-on panel ADR-009 declined.
//   focusable: false NT-FR-04. A card that can take focus has taken a keystroke from
//                    someone mid-sentence. Shown with `showInactive`, never `show`.
//   frame: true, transparent: true   no title bar, no drop shadow from the compositor,
//                    so the card is only what it draws.
//   skipTaskbar: true  the host is not an application; it must not appear in the taskbar
//                    or the dock as a window the developer can switch to (NT-FR-04).
//   alwaysOnTop: true  a notification under a full-screen window is not a notification.
//   hasShadow: false, resizable: false
//                    the compositor's own shadow and the user's own resize would both
//                    put something on screen this product did not draw.
//   webPreferences    `contextIsolation: true` and `nodeIntegration: false` are the two
//                    that matter most, and `sandbox: true` is a *renderer* setting that
//                    stays in force no matter what the process sandbox below does -
//                    the two are different layers and only one of them is disabled
//                    (see the launch policy below).
//
// WHERE THE CARD DOCUMENT COMES FROM
// Over the loopback hub, as a URL built from the hub's live origin. Not a `file:` URL and
// not an inline `data:` document, for two reasons: the dashboard's strict
// content-security policy then governs the card exactly as it governs the dashboard (the
// card can therefore write its state through attributes and never through an inline
// style), and the card is served by the same process, on the same 127.0.0.1 socket, as
// everything else - so the surface adds no new origin, no new port and no outbound call
// of any kind (APX-CON-12). The path is one entry in the dashboard's Vite build
// (src/dashboard/card.html, built by the dashboard's own build step); NT-7 owns what the
// document contains.
//
// HOW A CARD REACHES THAT DOCUMENT (NT-FR-12)
// Through a preload and a context bridge, and this file's `webPreferences` names it. The
// card document runs with `contextIsolation: true`, `nodeIntegration: false` and
// `sandbox: true`, so it has no `require`, no `process` and no `ipcRenderer`, and nothing
// in it can be reached from here by calling a function. The preload is the standard
// answer and the only one of the three that does not widen the renderer: it exposes
// exactly two calls on one global, and this file's `createElectronCardChannel` sends the
// two messages behind them. `executeJavaScript` would need no boundary at all, which is
// why it is not used, and `webSecurity: false` or `nodeIntegration: true` would trade the
// isolation this product's whole claim rests on for a convenience it does not need - a
// test asserts all three absences across every file under `src`. The two messages carry a
// `CardModel` and a lifetime cell, and nothing else; the guard that decides what may cross
// is src/notify/surface/channel.ts and it runs on both sides (APX-FR-01).
//
// The preload is two files, and both are this product's own: `./preload.ts` names it -
// the source tsc compiles, the `.cjs` it emits, and the path this option set carries -
// and `./preload.cts` is the body, because a preload in a sandboxed renderer is parsed as
// a plain script and this package is an ES module, so tsc would emit a module marker into
// any `.ts` it compiled. src/notify/surface/preload.ts states that at greater length with
// the measurements behind it.
//
// VERIFICATION STATE, AND IT DIFFERS BY LAYER
// The *product* layers are unit-tested against a structural Electron stub in
// tests/notify/surface-host.test.ts, which proves the option set, the placement, the
// click-through direction, the load, the show, the hide and the destroy - and proves
// nothing about any desktop's compositing (NT-FR-03, APX-CON-06).
//
// The *Electron* layers are live-verified. A hand-run check on the authoring machine
// (Ubuntu 24.04, X11 :1, Electron 44.4.5, Chrome 152.0.7977.130) drove the real
// `BrowserWindow` with this product's real option set and reported, with the process
// sandbox disabled by the policy below:
//
//   - the app reached `ready`; the work area read {"x":0,"y":32,"width":1920,"height":1048}
//   - the window was created, and `isFocusable()` was false with `focusable: false`
//   - the placed card was {"x":1584,"y":48,"width":320,"height":96} - byte-for-byte the
//     rectangle docs/research/electron-surface-preflight.json recorded, and the rectangle
//     CARD_SIZE and CARD_MARGIN in ./position.ts are derived from
//   - `setIgnoreMouseEvents(true, { forward: true })` and its release were both accepted
//   - a card document was loaded over 127.0.0.1 and painted real laid-out content
//     (320x96 of text), so the DOM card is a DOM card and APX-CON-07's canvas-plus-mirror
//     obligation does not reach it
//   - `showInactive()` made it visible with `isFocused() === false`, it was still visible
//     after 3s, and `hide()` left `isVisible() === false`
//   - the renderer had neither `process` nor `require`, which is the `webPreferences.sandbox`
//     claim below checked against the real renderer rather than asserted
//   - `destroy()` left `isDestroyed() === true`
//
// NT-9 turns that hand-run check into scripts/verify-notification-surface.mjs and owns it.
// Two findings from those runs are product decisions rather than probe observations, and
// both are written down at CHROMIUM_LAUNCH_POLICY: the sandbox FATAL happens before any
// JavaScript runs, so the policy's switch is delivered on the process command line; and a
// top-level `await` in the Electron main entry hangs before `app.whenReady()` resolves -
// `src/main/index.ts` uses `void startElectronMain()` and has no top-level await, and
// anything added here must keep it that way.
//
// NO TELEMETRY, NO SOUND, NO PLATFORM NOTIFICATION
// Nothing here reaches a notification service, spawns a process, plays a sound, or
// contacts any host but 127.0.0.1. `loadURL` is the only network call in the file and its
// argument is asserted to be a loopback URL (NT-FR-02, NT-FR-11, APX-CON-04, APX-CON-12).

import {
  CARD_SIZE,
  DEFAULT_SURFACE_CORNER,
  isInsideWorkArea,
  placeCard,
  type CardRect,
  type SurfaceCorner,
  type WorkArea,
} from './position.js'
import {
  SurfaceWindowRefusedError,
  type NotificationSurfaceHost,
  type SurfaceAvailability,
  type SurfaceCardRequest,
} from './host.js'
import {
  CARD_CHANNEL_READY,
  CARD_CHANNEL_REMOVE,
  CARD_CHANNEL_SHOW,
  cardChannelRemove,
  cardChannelShow,
} from './channel.js'
import { CARD_PRELOAD_PATH } from './preload.js'
import { armCardExpiry, timerCardScheduler, type CardEnd, type CardExpiryScheduler, type CardLifetimeCell } from './lifetime.js'
import type { CardModel } from './card.js'

// ---------------------------------------------------------------------------
// The window option set
// ---------------------------------------------------------------------------

/**
 * The exact options the host window is created with.
 *
 * Frozen, because this is a contract rather than a set of preferences: a spread of a
 * literal at the constructor would be a second copy of these values, and the copy is what
 * a test would then be asserting. `width` and `height` are here because a window has to
 * be given a size before anything can be placed, and they are the same two numbers
 * ./position.ts places by - the pre-flight's measured card (NT-FR-04).
 *
 * The `webPreferences` object grew exactly one key since NT-6 asserted it: `preload`,
 * which is what carries a card into the document at all (NT-FR-12). Its value comes from
 * ./preload.ts rather than from a literal here, so the option set states *which* preload
 * and the preload module is the one that says where it is and why it is CommonJS. The
 * three NT-FR-04 settings it already carried are unchanged, the object is still frozen,
 * and tests/notify/surface-host.test.ts asserts the exact key set of both levels - with
 * that one addition made deliberately, and said so where the assertion is.
 */
export const SURFACE_WINDOW_OPTIONS: Readonly<Record<string, unknown>> = Object.freeze({
  width: CARD_SIZE.width,
  height: CARD_SIZE.height,
  frame: false,
  transparent: true,
  resizable: false,
  skipTaskbar: true,
  alwaysOnTop: true,
  show: false,
  focusable: false,
  hasShadow: false,
  webPreferences: Object.freeze({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload: CARD_PRELOAD_PATH,
  }),
})

/**
 * The Chromium process-sandbox launch policy, decided here rather than inherited.
 *
 * WHAT WAS OBSERVED, AND WHERE. Reproduced on the authoring machine (Ubuntu 24.04,
 * Electron 44.4.5, Chrome 152.0.7977.130) with the npm package installed per-user, and
 * already recorded by docs/research/electron-surface-preflight.json. Three runs, three
 * answers:
 *
 *   1. Helper in place, no flag:
 *      `FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166] The SUID sandbox
 *      helper binary was found, but is not configured correctly. Rather than run without
 *      sandboxing I'm aborting now.` and the process dies of SIGTRAP. The npm-installed
 *      `chrome-sandbox` is owned by the installing user with mode 0755, and is therefore
 *      not setuid-root.
 *   2. Helper renamed away, no flag:
 *      `FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:129] No usable
 *      sandbox!` - `kernel.unprivileged_userns_clone` is 1, but Ubuntu 24.04's AppArmor
 *      `unprivileged_userns_restrictions` profile blocks the user-namespace fallback.
 *   3. Either of this policy's two delivery mechanisms present: the process starts, the
 *      app becomes ready, and the card is drawn.
 *
 * WHAT IS DECIDED: a per-user install of this package cannot obtain a root-owned
 * mode-4755 helper - that needs a privileged install this product does not do and cannot
 * ask a developer to do - so the Chromium *process* sandbox is **disabled by an explicit
 * launch flag** rather than left to a default that aborts the packaged application at a
 * user's login.
 *
 * WHERE THE FLAG HAS TO BE, WHICH IS THE PART THAT IS EASY TO GET WRONG.
 * Chromium reads its command line and decides about the sandbox **before any
 * JavaScript in this package runs**. A fourth run made that concrete: calling
 * `app.commandLine.appendSwitch('no-sandbox')` from the main script, before
 * `app.whenReady()`, still died of the run-1 SIGTRAP with the first line of the script
 * never executed. So the policy's delivery is a property of the *process launch*, not of
 * this package's code:
 *
 *   - `CHROMIUM_LAUNCH_FLAGS` is the switch, for whatever composes the command line: the
 *     desktop entry, the autostart unit, or a developer running the binary.
 *   - `CHROMIUM_LAUNCH_ENVIRONMENT` is the environment form, verified on the same machine
 *     to get the same process past the same check. It is here because for a per-user
 *     autostart unit the environment is often the only part a packager can own without
 *     rewriting somebody else's command line.
 *   - `applyChromiumLaunchPolicy` still appends the switch to `app.commandLine`, because
 *     that is the part a running process can still affect - every Chromium child started
 *     after this point inherits it - and because the switch is the decision this product
 *     made and it should be applied in one named place rather than in a launch script
 *     nobody reads. It is *not* relied on to prevent the abort, and the comment above
 *     says so, because a reader would otherwise reasonably assume it was.
 *
 * WHAT IS NOT DISABLED: `webPreferences.sandbox: true` in `SURFACE_WINDOW_OPTIONS` is a
 * *renderer* setting, enforced by Chromium's renderer isolation, and it is in force
 * independently of the process sandbox. Both layers were checked on the real Electron:
 * with the process sandbox disabled, a card document loaded over 127.0.0.1 still had
 * neither `process` nor `require` in the renderer. The two are different layers; this
 * decision removes one of them where no usable one exists, and the other is asserted in
 * the same test so a future edit cannot quietly drop it.
 *
 * THE COST, STATED: a disabled process sandbox means the renderer is not confined by the
 * kernel, so a renderer-level escape would be easier. The renderer is this product's own
 * card document, loaded from 127.0.0.1, with `contextIsolation` on, `nodeIntegration`
 * off, no remote content and no third-party code - and the input to it is a repository
 * short name and one sentence, never content (APX-FR-01, APX-CON-12). It is recorded in
 * docs/runbooks/notification-surface.md, and re-deciding it for a privileged install is a
 * change to this object, not to a call site.
 *
 * ONE IMPLEMENTATION FOR THREE PLATFORMS: neither mechanism is chosen per platform, and
 * there is no `process.platform` branch anywhere in this module. A per-user npm install
 * has the same class of problem on all three, and a platform whose helper *is* usable is
 * unharmed by a switch it did not need (NT-FR-03, APX-CON-06).
 */
export const CHROMIUM_LAUNCH_POLICY: Readonly<{
  readonly decision: 'process-sandbox-disabled'
  readonly switch: 'no-sandbox'
  readonly environment: Readonly<Record<string, string>>
  readonly rendererSandbox: true
  /** True, and the reason the flag is delivered two ways: Chromium reads it before JS. */
  readonly appliesBeforeStartup: true
  readonly reason: string
}> = Object.freeze({
  decision: 'process-sandbox-disabled',
  switch: 'no-sandbox',
  environment: Object.freeze({ ELECTRON_DISABLE_SANDBOX: '1' }),
  rendererSandbox: true,
  appliesBeforeStartup: true,
  reason:
    'the npm-installed chrome-sandbox helper is not setuid-root and the unprivileged ' +
    'user-namespace fallback is blocked by AppArmor on Ubuntu 24.04, so an unprivileged per-user ' +
    'install has no usable Chromium process sandbox and Chromium aborts rather than degrading. ' +
    'Chromium decides this before any JavaScript in this package runs, so the switch is delivered ' +
    'on the process command line and, equivalently, as ELECTRON_DISABLE_SANDBOX=1. ' +
    'webPreferences.sandbox (a renderer setting) remains in force independently, verified on the ' +
    'real Electron (NT-FR-04).',
})

/**
 * The Chromium switches this product's launch requires, in order.
 *
 * Exactly one. The pre-flight also recorded that the GPU process fails to launch under
 * software rendering on that machine; it is deliberately NOT worked around here, and a
 * re-run on the same machine confirmed the application reaches `ready` without it.
 */
export const CHROMIUM_LAUNCH_FLAGS: readonly string[] = Object.freeze([
  CHROMIUM_LAUNCH_POLICY.switch,
])

/**
 * The environment form of the same decision, for whatever launches the process.
 *
 * Verified on the authoring machine to be sufficient on its own: with this variable set
 * and no command-line switch, Electron 44.4.5 started, became ready and drew a card.
 */
export const CHROMIUM_LAUNCH_ENVIRONMENT: Readonly<Record<string, string>> =
  CHROMIUM_LAUNCH_POLICY.environment

/**
 * The slice of `app.commandLine` the policy is applied through.
 *
 * Structural, and one method, for the reason the rest of this file is structural: an
 * interface this small is checkable by reading, and a test can hand it a recorder and
 * assert the exact switch without an Electron binary.
 */
export interface CommandLineLike {
  appendSwitch(name: string): void
}

/**
 * Apply the launch policy to the processes this one goes on to start.
 *
 * Exactly what a running process can still affect, and no more: the switch is appended
 * before `app.whenReady()` so every Chromium child inherits it, and so the decision is
 * applied in one named place in this product rather than in a launch script. It is NOT
 * what prevents the abort - Chromium has already decided by the time this is called - and
 * `launchPolicyApplied` exists to report that gap rather than to paper over it.
 *
 * Throws if the runtime has no `commandLine`, because that is an Electron this product
 * cannot claim to have configured at all, and a silent return would be indistinguishable
 * from success.
 */
export function applyChromiumLaunchPolicy(commandLine: CommandLineLike): readonly string[] {
  if (commandLine === null || typeof commandLine.appendSwitch !== 'function') {
    throw new Error(
      'the Electron runtime provided no `app.commandLine`, so the Chromium launch policy ' +
        '(`--no-sandbox`, required on this platform because no usable process sandbox exists for a ' +
        'per-user install) cannot be applied to the processes this one starts (NT-FR-04, ' +
        'CHROMIUM_LAUNCH_POLICY).',
    )
  }
  for (const flag of CHROMIUM_LAUNCH_FLAGS) commandLine.appendSwitch(flag)
  return CHROMIUM_LAUNCH_FLAGS
}

/**
 * Whether *this* process was actually launched under the policy.
 *
 * Pure, and the honest report of the one thing `applyChromiumLaunchPolicy` cannot do.
 * Both delivery mechanisms are checked because either is enough: the switch on the
 * command line, or the environment variable. `null` means the policy reached the process;
 * a string is the operator-facing sentence for when it did not, which is the difference
 * between a readable diagnosis and a SIGTRAP with no message on this side of it.
 *
 * A `false` here is not automatically a fault: a machine with a usable setuid helper runs
 * a sandboxed Chromium whether or not this product asked for one, and the caller is
 * expected to say so rather than to refuse to start.
 */
export function launchPolicyApplied(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const switchOnCommandLine = argv.some((argument) => argument === `--${CHROMIUM_LAUNCH_POLICY.switch}`)
  if (switchOnCommandLine) return null
  for (const [name, value] of Object.entries(CHROMIUM_LAUNCH_ENVIRONMENT)) {
    if (value === undefined) continue
    if (env[name] === value) return null
  }
  return (
    `this process was started without --${CHROMIUM_LAUNCH_POLICY.switch} and without ` +
    `${Object.entries(CHROMIUM_LAUNCH_ENVIRONMENT)
      .map(([name, value]) => `${name}=${value}`)
      .join(' or ')}. Chromium decides about the sandbox before any JavaScript in this package ` +
    'runs, so agent-ping cannot apply the policy from here: whatever launches it - a desktop entry, ' +
    'an autostart unit, or a shell - has to carry one of the two. A machine whose ' +
    '`chrome-sandbox` helper is not setuid-root will otherwise abort with SIGTRAP before this ' +
    `line is reached (${CHROMIUM_LAUNCH_POLICY.reason})`
  )
}

// ---------------------------------------------------------------------------
// The card document
// ---------------------------------------------------------------------------

/**
 * The path the card document is served from.
 *
 * A second entry in the dashboard's one Vite build rather than a separate asset tree, so
 * the hub's existing static route serves it and there is no new route, no new origin and
 * no second copy of the content-security policy (NT-FR-03).
 */
export const SURFACE_DOCUMENT_PATH = '/card.html'

/** The loopback origin a hub serves on, as a string this product builds. */
export const LOOPBACK_ORIGIN = 'http://127.0.0.1'

/**
 * The card document's URL, built from the hub's live origin.
 *
 * Read at show time rather than captured at mount, because the mount happens before the
 * loopback socket is bound and the port is only known afterwards. A URL built from the
 * *preferred* port would be a card loaded from whatever else on this machine answers
 * there, which is the failure mode the hub's port fallback exists to prevent (HC-FR-01).
 */
export function surfaceDocumentUrl(origin: string): string {
  return `${origin}${SURFACE_DOCUMENT_PATH}`
}

/**
 * Assert that a document URL is the loopback card document and nothing else.
 *
 * Exported so the test can assert the rule and the call site can rely on it: a `file:`
 * URL, a `data:` document, a `javascript:` URL or a remote host would all defeat the
 * content-security policy the dashboard route sends, and the last two would be an
 * outbound call (APX-CON-12). This is a guard on our own construction, not a sandbox.
 */
export function assertLoopbackDocumentUrl(url: string): string {
  if (!url.startsWith(`${LOOPBACK_ORIGIN}:`) && !url.startsWith(`${LOOPBACK_ORIGIN}/`)) {
    throw new SurfaceWindowRefusedError(
      `the card document URL is not on the loopback hub (${url}). The surface loads its document ` +
        'from the hub it already serves, so this is a wiring fault rather than a desktop refusal.',
    )
  }
  if (!url.endsWith(SURFACE_DOCUMENT_PATH)) {
    throw new SurfaceWindowRefusedError(
      `the card document URL is not the card document (${url}); expected it to end in ` +
        `${SURFACE_DOCUMENT_PATH}.`,
    )
  }
  return url
}

// ---------------------------------------------------------------------------
// The structural Electron surface
// ---------------------------------------------------------------------------

/**
 * The slice of a window's `webContents` this file uses. One call, and that is the list.
 *
 * `send` is how a card model crosses into the document, and it is the *only* way: the
 * alternative - `executeJavaScript` - injects code into a renderer and needs no boundary
 * at all, which is why a test asserts this member exists and that `executeJavaScript`
 * appears nowhere under `src` (NT-FR-12, APX-FR-01).
 *
 * `isDestroyed` is read before every send, because sending to a destroyed window throws
 * and the caller is the delivery path, where an exception would be a swallowed block
 * (APX-FR-02).
 */
export interface WebContentsLike {
  send(channel: string, ...args: readonly unknown[]): void
  isDestroyed(): boolean
}

/** The slice of `BrowserWindow` this host uses. Nine calls, and that is the whole list. */
export interface BrowserWindowLike {
  loadURL(url: string): Promise<void>
  showInactive(): void
  hide(): void
  isDestroyed(): boolean
  destroy(): void
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void
  /** How a card model reaches the document. Added for the channel (NT-FR-12). */
  readonly webContents: WebContentsLike
}

/** The slice of `screen` this host uses: one display's usable rectangle, read per show. */
export interface ScreenLike {
  getPrimaryDisplay(): { readonly workArea: WorkArea }
}

export interface CreateElectronSurfaceHostOptions {
  /** Electron's `BrowserWindow` constructor, taken as a value so a test can pass a stub. */
  readonly BrowserWindow: new (options: unknown) => BrowserWindowLike
  /** Electron's `screen`, read for the work area every time a card is placed. */
  readonly screen: ScreenLike
  /**
   * The card document's URL, read when the first card is shown rather than captured at
   * mount, because the loopback port is not known until the socket is bound.
   */
  readonly documentUrl: () => string
  /** The corner every card is placed at unless a show says otherwise. */
  readonly corner?: SurfaceCorner
  /** One bounded line on a diagnostic callback when a card cannot be shown. */
  readonly onDiagnostic?: (message: string) => void
  /**
   * Told about the window, once, as it is created.
   *
   * The seam the channel needs, and it is an option rather than a sixth method for the
   * reason NT-FR-12 is a test's business: the host owns the window, the channel needs its
   * `webContents`, and `NotificationSurfaceHost` must still carry exactly `probe`, `show`,
   * `hide`, `setClickThrough` and `destroy` (tests/notify/surface-host.test.ts enumerates
   * the interface from source). A host that widened to hand out its window would put a
   * card's delivery surface on the window contract; this way the host says nothing about
   * cards and the channel is told about a window that already exists.
   *
   * Called before `createElectronSurfaceHost` returns, so a caller that answers straight
   * away has the window before anything can ask for a card.
   */
  readonly onWindowCreated?: (window: BrowserWindowLike) => void
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

/**
 * Create the surface host over an Electron `BrowserWindow`.
 *
 * The window is created *now* - at mount, when the hub starts, which is what NT-FR-04
 * asks for - and is created with `show: false`, so until a card is shown it draws nothing
 * and occupies no screen space (NT-FR-10). It is created lazily-on-first-show as far as
 * the *document* is concerned: the URL is not knowable until the hub's port is bound, and
 * a window that loaded `''` would paint an error page into a transparent rectangle.
 *
 * A desktop that refuses to create the window does not reach this function: the caller
 * constructs it, so a refusal is a `SurfaceWindowRefusedError` from `create` rather than a
 * half-built host. What this function does refuse is a *display*: no work area means the
 * card cannot be placed inside the usable area, and placing it against the screen
 * rectangle instead is the defect this product refuses to ship.
 */
export function createElectronSurfaceHost(
  options: CreateElectronSurfaceHostOptions,
): NotificationSurfaceHost {
  const defaultCorner = options.corner ?? DEFAULT_SURFACE_CORNER
  const diagnostic = options.onDiagnostic ?? ((): void => {})
  let window: BrowserWindowLike
  try {
    window = new options.BrowserWindow(SURFACE_WINDOW_OPTIONS)
  } catch (cause) {
    throw new SurfaceWindowRefusedError(
      `the BrowserWindow constructor threw (${cause instanceof Error ? cause.message : String(cause)})`,
    )
  }
  let documentLoaded = false
  let destroyed = false
  let visible = false
  let clickThrough: boolean | null = null
  // Told once, straight after construction, so a channel mounted alongside the host is
  // holding this window before a delivery can ask for a card (NT-FR-12).
  try {
    options.onWindowCreated?.(window)
  } catch (cause) {
    throw new SurfaceWindowRefusedError(
      `the caller that adopts the surface window threw (${cause instanceof Error ? cause.message : String(cause)})`,
    )
  }

  /** The display's usable rectangle, or a refusal that names why it has none. */
  const workArea = (): WorkArea => {
    let area: WorkArea
    try {
      area = options.screen.getPrimaryDisplay().workArea
    } catch (cause) {
      throw new SurfaceWindowRefusedError(
        `the display reported no usable area (${cause instanceof Error ? cause.message : String(cause)})`,
      )
    }
    if (area === null || typeof area !== 'object' || !Number.isFinite(area.width) || !Number.isFinite(area.height)) {
      throw new SurfaceWindowRefusedError(
        'the display reported no work area, so the card cannot be placed inside the usable area. ' +
          'The screen rectangle is not an answer: a taskbar, a dock or a top panel lives in it (NT-FR-04).',
      )
    }
    return area
  }

  /**
   * Load the card document, once.
   *
   * Failures are reported rather than thrown: a card that cannot be painted is a delivery
   * this host did not perform, and the caller records that. An exception here would be
   * caught one layer up as an opaque failure with the reason lost (APX-FR-02, ADR-010).
   */
  const loadDocument = async (): Promise<SurfaceAvailability> => {
    if (documentLoaded) return { available: true, reason: 'available' }
    let url: string
    try {
      url = assertLoopbackDocumentUrl(options.documentUrl())
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      diagnostic(`agent-ping could not build a loopback URL for the notification card: ${detail}`)
      return { available: false, reason: 'document-unavailable', detail }
    }
    try {
      await window.loadURL(url)
    } catch (cause) {
      const detail = `the card document could not be loaded over the loopback hub (${url}): ${
        cause instanceof Error ? cause.message : String(cause)
      }`
      diagnostic(`agent-ping ${detail}`)
      return { available: false, reason: 'document-unavailable', detail }
    }
    documentLoaded = true
    return { available: true, reason: 'available' }
  }

  /**
   * Take click-through, or give it back.
   *
   * `forward: true` while click-through is on, so the pointer still reaches the window
   * underneath and the developer never has to hunt for what is behind the card; `false`
   * with no options, because a forwarded event to a card that is meant to be clickable
   * would deliver the click to the wrong window. Both directions are explicit because a
   * card that is always click-through can never be clicked and one that is never
   * click-through swallows clicks meant for the window behind it (NT-FR-04).
   */
  const applyClickThrough = (enabled: boolean): void => {
    if (destroyed || clickThrough === enabled) return
    window.setIgnoreMouseEvents(enabled, enabled ? { forward: true } : undefined)
    clickThrough = enabled
  }

  return {
    probe: async (): Promise<SurfaceAvailability> => {
      if (destroyed || window.isDestroyed()) {
        return { available: false, reason: 'window-destroyed' }
      }
      // Available whether or not the document has been loaded. Not loading it yet is not a
      // fault: it is loaded with the first card, because the loopback port is not known
      // before the socket is bound, and a probe that loaded it would be a probe with a
      // side effect.
      return { available: true, reason: 'available' }
    },

    show: async (card?: SurfaceCardRequest): Promise<SurfaceAvailability> => {
      if (destroyed || window.isDestroyed()) {
        return { available: false, reason: 'window-destroyed' }
      }
      const loaded = await loadDocument()
      if (!loaded.available) return loaded

      let rect: CardRect
      try {
        rect = placeCard(workArea(), card?.corner ?? defaultCorner, CARD_SIZE)
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        diagnostic(`agent-ping could not place the notification card: ${detail}`)
        return { available: false, reason: 'window-refused', detail }
      }
      // Belt and braces, and cheap: the rectangle is arithmetic over the work area, and
      // this is the assertion that it stayed inside. It would be a defect in
      // ./position.ts, and a card over a taskbar is visible to the person it interrupts.
      if (!isInsideWorkArea(rect, workArea())) {
        const detail = `the placed card ${JSON.stringify(rect)} is not inside the work area`
        diagnostic(`agent-ping refused to show the notification card: ${detail} (NT-FR-04)`)
        return { available: false, reason: 'window-refused', detail }
      }

      window.setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
      // `showInactive`, never `show`: this is the difference between a notification and
      // an interruption. A card that took focus has taken a keystroke from someone
      // mid-sentence (NT-FR-04).
      window.showInactive()
      visible = true
      // Click-through by default, so the card is invisible to the pointer until the
      // pointer reaches it (NT-FR-04).
      applyClickThrough(card?.clickThrough ?? true)
      return { available: true, reason: 'available' }
    },

    hide: (): void => {
      // Idempotent, and not merely harmless-if-repeated: a hide for a window that is
      // already hidden is a round trip to a window manager for no change in what is on
      // the screen, and NT-FR-10's promise is about what the desktop does rather than
      // about how many times this product asked.
      if (destroyed || !visible) return
      visible = false
      window.hide()
    },

    setClickThrough: (clickThroughNext: boolean): void => {
      applyClickThrough(clickThroughNext)
    },

    destroy: (): void => {
      if (destroyed) return
      destroyed = true
      visible = false
      window.destroy()
    },
  }
}

// ---------------------------------------------------------------------------
// The main-process end of the card channel
// ---------------------------------------------------------------------------

/**
 * The slice of `ipcMain` the channel uses. One listener, registered once, at
 * construction.
 *
 * Structural for the same reason everything else here is, and registered eagerly rather
 * than on the first card because the message it waits for is sent by the preload as the
 * window's document loads - which happens before anything can ask for a card. A
 * listener added on first use would arrive after the announcement and wait for a second
 * one that never comes.
 */
export interface IpcMainLike {
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}

/**
 * How long a card waits for the card document to announce that its channel is listening.
 *
 * A safety net, not the normal path, and it is worth saying why. `host.show()` resolves
 * on the document's load, and the preload runs before any document script, so by the time
 * the notifier calls `present` the announcement has already been sent - the wait is
 * already satisfied and this number is never reached. It exists for the case the ordering
 * does not cover: a window whose document failed to run the preload, or a preload that
 * Electron refused, either of which would otherwise be a card that never arrives with
 * nothing to say so.
 *
 * A number and not a policy: no card lifetime is expressed here, nothing re-arms, and
 * the clock is a single `setTimeout` that is cleared the moment it is answered
 * (NT-FR-08, APX-FR-02).
 */
export const CARD_CHANNEL_READY_TIMEOUT_MS = 2_000

export interface CreateCardChannelOptions {
  /** Electron's `ipcMain`, for the one readiness announcement. */
  readonly ipcMain: IpcMainLike
  /**
   * The window to send on, read when a card is presented.
   *
   * A reader rather than a value because the channel is built before the window exists:
   * the composition root builds both and the window is created when the hub mounts the
   * host. Reading at send time is also what keeps a destroyed window from being a stale
   * reference.
   */
  readonly window: () => BrowserWindowLike | null
  /**
   * Takes the window down when a card ends on its own.
   *
   * The host's own `hide`, passed in rather than reimplemented: the host knows whether it
   * is visible, and a second hide would be a second place NT-FR-10's promise is decided.
   */
  readonly hide: () => void
  /** One bounded line on a diagnostic callback. Never the card's own text. */
  readonly onDiagnostic?: (message: string) => void
  /** Where the expiry clock comes from. Defaults to this environment's `setTimeout`. */
  readonly scheduler?: CardExpiryScheduler
  /** Overrides `CARD_CHANNEL_READY_TIMEOUT_MS`, for a test that will not wait. */
  readonly readyTimeoutMs?: number
}

/**
 * The main process's half of the card channel: the `CardPresenter` NT-8 made a required
 * port, over the two messages the preload carries, plus the one call that takes a card
 * back off the screen.
 *
 * `present` is structurally the notifier's `CardPresenter`, which is why
 * src/main/index.ts can hand the same object to `resolveSurfaceNotifier` without either
 * file naming the other's type - and why `dismiss` is a *separate* member rather than a
 * second argument to `present`: the notifier delivers a card and this product is done
 * with it, while a dismissal arrives from the hub's own acknowledgement and is a
 * different event with a different reason (NT-FR-12).
 */
export interface CardChannelPresenter {
  present(model: CardModel, cell: CardLifetimeCell): Promise<void>
  /**
   * Take the card off the screen, naming the end.
   *
   * The one place a hub-originated end crosses into the document, and it is the same
   * three lines the expiry path uses: send the removal through the channel, so the
   * document's own view removes its own element under its own lifetime cell, and then
   * call the host's own `hide` (NT-FR-10). It also cancels the card's own clock, because
   * an arm that outlives its card would take down the *window* a later card is using.
   *
   * Never throws and never waits: the caller is an HTTP handler or a change-feed
   * subscriber, and a removal that cannot be delivered is reported rather than turned
   * into a failed acknowledgement (APX-FR-02, ADR-010).
   */
  dismiss(end: CardEnd): void
}

/**
 * Build the main process's end of the card channel.
 *
 * It does four things and refuses two.
 *
 *   1. It waits for the card document to say its channel is listening. `webContents.send`
 *      to a document that has not finished loading is a message nobody receives, and a
 *      card that silently never arrived is the one failure this product exists to avoid
 *      (APX-FR-02, ADR-010).
 *   2. It refuses a payload the guard in ./channel.ts refuses, by throwing - the delivery
 *      path turns that into a recorded failure with its reason, and the value never
 *      crosses (APX-FR-01).
 *   3. It sends the one `show` message.
 *   4. It arms the *same* clock the card document's own view arms, from the same cell and
 *      through the same `armCardExpiry`, and when it elapses it removes the card through
 *      the channel and takes the window down. Two arms of one interval, not two policies:
 *      the document's arm takes the card out of the document, this one takes the *window*
 *      down, and only the main process can do that. A cell with no interval - needs-you,
 *      which is every cell that waits for a decision - arms nothing here either, so there
 *      is nothing that can time a block out while it is still a block (NT-FR-08,
 *      ADR-004).
 *
 *   Refusal 1: no window, or a destroyed one. That is a wiring fault or a shutdown, and
 *   it throws with a reason rather than resolving as though a card were shown.
 *   Refusal 2: a cell that is never rendered. `planNotification` never produces one -
 *   the cell that renders nothing belongs to a class that is refused before it gets here -
 *   so it is checked rather than assumed, because a window with an empty card in it is
 *   exactly what NT-FR-10 forbids.
 *
 * IT IS ALSO THE ACKNOWLEDGEMENT PATH, AND ONLY FOR REMOVING
 * `dismiss` is how the hub's acknowledgement and a harness's resolution reach the card.
 * It is not how anything is *told*: this channel does not know a block was acknowledged,
 * does not read a row and has no route, and the decision that a card should go down is
 * the hub's (src/notify/surface/dismissal.ts). What this side owns is the removal - the
 * message to the document and the host's own `hide` - and it owns it for the card's own
 * end and for a hub-originated one alike, so there is one place a card leaves the screen
 * rather than two (NT-FR-12's third clause, ADR-010).
 */
export function createElectronCardChannel(options: CreateCardChannelOptions): CardChannelPresenter {
  const diagnostic = options.onDiagnostic ?? ((): void => {})
  const scheduler = options.scheduler ?? timerCardScheduler
  const readyTimeoutMs = options.readyTimeoutMs ?? CARD_CHANNEL_READY_TIMEOUT_MS
  if (options.ipcMain === null || typeof options.ipcMain.on !== 'function') {
    throw new Error(
      'the Electron runtime provided no `ipcMain`, so a card model cannot reach the card document ' +
        'and this build can show no card at all. The hub is unaffected and every delivery is ' +
        'recorded as not-wired rather than as a card somebody saw (NT-FR-12, APX-FR-02).',
    )
  }

  let ready = false
  let waiting: Array<() => void> = []
  options.ipcMain.on(CARD_CHANNEL_READY, (): void => {
    if (ready) return
    ready = true
    const answered = waiting
    waiting = []
    for (const resolve of answered) resolve()
  })

  /** The announcement, or a refusal that says the document never listened. */
  const whenReady = (): Promise<void> => {
    if (ready) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        clearTimeout(handle)
        resolve()
      }
      const handle = setTimeout(() => {
        if (settled) return
        settled = true
        waiting = waiting.filter((entry) => entry !== settle)
        const detail =
          `the card document did not announce a listening channel within ${String(readyTimeoutMs)}ms, ` +
          'so nothing was sent and no card is on the screen. The event is stored, the block is still ' +
          'pending and nothing was retried (NT-FR-12, APX-FR-02)'
        diagnostic(`notify: ${detail}`)
        reject(new Error(detail))
      }, readyTimeoutMs)
      waiting.push(settle)
    })
  }

  // One expiry at a time, and cancelled by the next card: a replaced card must not come
  // back later to take down the window a newer card is using. Nothing here re-arms.
  let arm: { cancel(): void } | null = null

  /** Remove the current card through the channel, and take the window down. */
  const endCard = (end: CardEnd): void => {
    const window = options.window()
    if (window === null || window.isDestroyed()) return
    window.webContents.send(CARD_CHANNEL_REMOVE, cardChannelRemove(end))
    options.hide()
  }

  return {
    present: async (model: CardModel, cell: CardLifetimeCell): Promise<void> => {
      // Throws `CardChannelPayloadError` for anything the guard refuses, which the
      // notifier records as a failure with its reason. Nothing crosses before this.
      const payload = cardChannelShow(model, cell)
      if (!cell.rendered) {
        throw new Error(
          `a card was presented for the class "${String(cell.class)}", whose card is never rendered. ` +
            'The class policy refuses that class before it reaches here, so this is a defect in the ' +
            "policy's own table rather than something to draw (NT-FR-02, NT-FR-10).",
        )
      }
      arm?.cancel()
      arm = null
      await whenReady()
      const window = options.window()
      if (window === null) {
        throw new Error(
          'the card channel was asked to present a card with no surface window, so nothing was sent ' +
            'and no card is on the screen (NT-FR-12, APX-FR-02).',
        )
      }
      if (window.isDestroyed()) {
        throw new Error(
          'the card channel was asked to present a card into a destroyed surface window, so nothing ' +
            'was sent and no card is on the screen (NT-FR-12, APX-FR-02).',
        )
      }
      window.webContents.send(CARD_CHANNEL_SHOW, payload)
      arm = armCardExpiry(cell, scheduler, () => {
        arm = null
        endCard('expired')
      })
    },

    dismiss: (end: CardEnd): void => {
      // The card's own clock goes first, for the same reason the view cancels its arm
      // before it takes the node out: a callback that is already in flight must not find
      // a card to remove and take down the window a later card is using (NT-FR-08).
      arm?.cancel()
      arm = null
      endCard(end)
    },
  }
}
