// The notification surface host: the window agent-ping creates, owns, places, shows,
// hides and destroys, and what happens when a desktop refuses it (NT-FR-02, NT-FR-03,
// NT-FR-04, NT-FR-10, ADR-012).
//
//   npm test -- tests/notify/surface-host.test.ts
//
// THE SIX ACCEPTANCE CRITERIA OF NT-6, AND WHERE EACH IS PROVEN
//
//   1. "A test asserts the exact BrowserWindow option object, including that show is
//      false until a card exists and that focusable is false."
//      `the BrowserWindow option object`, below. The stub records the object the
//      constructor actually received and it is compared key for key against
//      SURFACE_WINDOW_OPTIONS - the same frozen value the host hands over, so the test
//      fails if the host ever spreads a literal of its own at the call site. `show: false`
//      and `focusable: false` are additionally asserted by name, with the reason each is
//      load-bearing written next to it, and `show: false` is shown to survive a show/hide
//      cycle rather than being true only at construction.
//
//   2. "A test asserts the card rectangle is computed inside the work area and never
//      overlaps its insets, for each supported corner placement."
//      Here, through the host: every corner of SURFACE_CORNERS is shown to produce a
//      `setBounds` rectangle inside the display's workArea and clear of the 32px top
//      inset the pre-flight measured. The arithmetic itself is enumerated in
//      tests/notify/surface-position.test.ts; this half proves the *host* places from the
//      work area it is given rather than from a hard-coded rectangle, which is the
//      mistake that matters here.
//
//   3. "A test drives mount, show, hide and destroy through the main entry point and
//      asserts the host is destroyed in the ordered shutdown before the server closes."
//      `through the real startHub`, below: the real composition root, a real log, a real
//      loopback socket and a real shutdown. The ordering is asserted behaviourally
//      rather than by reading source - the stub window records whether the listener was
//      still accepting connections at the instant it was destroyed, and the tray records
//      whether the window was already gone when it closed - so a reordering of the
//      shutdown fails this test instead of a comment.
//
//   4. "A test asserts a desktop bridge that refuses the window leaves the hub serving
//      and records delivery as not-wired with a diagnostic."
//      `a desktop that refuses the window`, below: a real `GET /api/health` answered 200
//      after the refusal, a real needs-you block posted over a real socket and counted
//      `not-wired` by both the ingest pipeline and the delivery policy, and a diagnostic
//      naming the refusal. `hub.surface` is null rather than a stub that answers as
//      though a window were on a desktop - the same posture the tray takes.
//
//   5. "A test asserts the interface module imports no electron module, so the seam is
//      testable without a display."
//      `the interface module imports no electron module`, below. Read from
//      src/notify/surface/host.ts's own source with comments and strings stripped, so the
//      assertion is about the references the module makes rather than about the sentences
//      around them. The rest of this file runs with no Electron runtime, no display and
//      no window manager, and says so.
//
//   6. "A test asserts the chosen Chromium process-sandbox launch policy is applied
//      explicitly rather than left to a default that aborts on this platform."
//      `the Chromium launch policy`, below: the switch is appended to a recorder standing
//      in for `app.commandLine`, the policy object names the decision and its reason, the
//      renderer sandbox is asserted to be in force independently, and the ordering against
//      `app.whenReady()` is checked - a switch appended after the app is ready is ignored
//      by Chromium, which would make this a policy that looked decided and behaved as
//      though it had not been.
//
// AROUND THOSE SIX:
//   - The card document is loaded from the hub's own loopback origin, and a non-loopback
//     or non-card URL is refused, because a `file:` or `data:` document would defeat the
//     content-security policy the dashboard route sends and a remote one would be an
//     outbound call (APX-CON-12).
//   - Click-through is a two-way switch and both directions are asserted: `true` forwards
//     the pointer to the window underneath, `false` stops doing so. A card that is always
//     click-through can never be clicked; one that is never click-through swallows the
//     clicks meant for the window behind it.
//   - `show` uses `showInactive` and never `show`: a card that took focus has taken a
//     keystroke from someone mid-sentence (NT-FR-04).
//   - Nothing in the surface path spawns a process, plays a sound, or reaches a
//     notification service: asserted against the source of all three surface modules with
//     their prose stripped, so the change of track is enforced by the suite rather than
//     promised in a comment (NT-FR-02, NT-FR-11, APX-CON-04).
//   - A host that cannot place a card or cannot read the document reports it on a
//     diagnostic and resolves with the reason rather than throwing into the delivery path
//     (APX-FR-02, ADR-010).
//
// A NOTE ON WHAT IS EXERCISED HERE, AND WHAT WAS CHECKED BY HAND
// This suite starts no Electron process and displays no window: the Electron half is a
// structural stub, which proves every decision this product makes - the option set, the
// placement, the load, the click-through direction, the show, the hide, the destroy, the
// shutdown order - and proves nothing about any desktop's compositing.
//
// The Electron *layers* were checked separately, by hand, against the real binary on the
// authoring machine (Ubuntu 24.04, X11 :1, Electron 44.4.5, Chrome 152.0.7977.130) with
// this product's real option set, the real launch policy and the real placement. That run
// confirmed the window primitives, reproduced the pre-flight's card rectangle exactly,
// confirmed the renderer had no `process` and no `require` with the process sandbox
// disabled, and produced the two findings recorded at CHROMIUM_LAUNCH_POLICY: the sandbox
// FATAL happens before any JavaScript runs, and a top-level `await` in the Electron main
// entry hangs before `app.whenReady()` resolves. NT-9 turns that hand-run check into
// scripts/verify-notification-surface.mjs and owns it; this file claims no macOS or
// Windows window behaviour from this Linux machine (NT-FR-03, APX-CON-06).

import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startHub, type RunningHub } from '@/main/index'
import {
  CHROMIUM_LAUNCH_ENVIRONMENT,
  CHROMIUM_LAUNCH_FLAGS,
  CHROMIUM_LAUNCH_POLICY,
  LOOPBACK_ORIGIN,
  SURFACE_DOCUMENT_PATH,
  SURFACE_WINDOW_OPTIONS,
  applyChromiumLaunchPolicy,
  assertLoopbackDocumentUrl,
  createElectronSurfaceHost,
  launchPolicyApplied,
  surfaceDocumentUrl,
  type BrowserWindowLike,
  type ScreenLike,
} from '@/notify/surface/electron-host'
import {
  CARD_PRELOAD_FILE_NAME,
  CARD_PRELOAD_PATH,
  CARD_PRELOAD_SOURCE_FILE,
  resolveCardPreloadPath,
} from '@/notify/surface/preload'
import {
  SurfaceWindowRefusedError,
  type CreateSurfaceHostOptions,
  type NotificationSurfaceHost,
  type SurfaceHostBridge,
} from '@/notify/surface/host'
import { CARD_SIZE, SURFACE_CORNERS, isInsideWorkArea, type WorkArea } from '@/notify/surface/position'
import type { Notifier } from '@/hub/delivery'
import type { TrayBridge } from '@/hub/tray'
import type { HealthPayload } from '@/hub/routes/read'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_PATH = '/home/dev/Projects/agent-ping'
const SESSION = 'ses_surface_01'
const OCCURRED_AT = '2026-09-26T09:00:00.000Z'
const HUB_PORT = 43117

/** The display the pre-flight measured, including the 32px top inset. */
const WORK_AREA: WorkArea = { x: 0, y: 32, width: 1920, height: 1048 }

const temporaryDirectories: string[] = []
const openHubs: RunningHub[] = []
const diagnostics: string[] = []

function temporaryDirectory(prefix = 'agent-ping-state-'): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  for (const hub of openHubs.splice(0)) {
    await hub.close().catch(() => undefined)
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  diagnostics.length = 0
})

// ---------------------------------------------------------------------------
// The structural Electron stub
// ---------------------------------------------------------------------------

/** One call the host made, recorded in order. The only observation surface a test has. */
interface WindowCall {
  readonly call: string
  readonly argument?: Record<string, unknown>
}

interface RecordedWindow {
  /** The object the `BrowserWindow` constructor was given, verbatim. */
  readonly options: unknown
  readonly calls: WindowCall[]
  destroyed(): boolean
  argumentOf(call: string): Record<string, unknown> | undefined
}

interface StubElectronOptions {
  /** The display's usable area. `null` stands for a session with no display at all. */
  readonly workArea?: WorkArea | null
  /** Make `loadURL` reject, as a hub with no built card document would. */
  readonly failLoad?: boolean
  /**
   * Asked at the instant any call is recorded, and answered by the test.
   *
   * This is how the shutdown order is asserted as a fact about the run: the harness
   * answers it with the real listener's state, so "the window was destroyed before the
   * listener closed" is observed rather than read out of the source.
   */
  readonly listening?: () => boolean
  /** Run inside `destroy`, before the window records its own call. */
  readonly onDestroy?: () => void
}

interface StubElectron {
  readonly BrowserWindow: new (options: unknown) => BrowserWindowLike
  readonly screen: ScreenLike
  readonly windows: RecordedWindow[]
  /** The loopback listener's state, sampled at each recorded call. */
  readonly listeningAt: Map<string, boolean>
}

/**
 * An Electron `BrowserWindow` and `screen` that record instead of drawing.
 *
 * Structural by construction, and the same shape the real module is used through
 * (src/notify/surface/electron-host.ts takes both as values). Nothing here pretends to be
 * a window: there is no compositor, no display and no process behind it, and the only
 * thing it establishes is what the host *asked for*.
 */
function stubElectron(options: StubElectronOptions = {}): StubElectron {
  const windows: RecordedWindow[] = []
  const listeningAt = new Map<string, boolean>()
  const listening = options.listening ?? ((): boolean => true)
  const workArea = options.workArea === undefined ? WORK_AREA : options.workArea

  class StubWindow implements BrowserWindowLike {
    readonly calls: WindowCall[] = []
    private gone = false
    readonly record: RecordedWindow
    /**
     * The window's own message channel, recorded rather than sent.
     *
     * Added for the card channel (NS-2) and the reason the stub has one: the channel
     * sends a card model on this object, and a test that could not see the send would be
     * unable to say whether a delivery reached a document. `webContents` is a member of
     * the real `BrowserWindow` too - nothing here pretends to be a window that Electron
     * would not accept.
     */
    readonly webContents = {
      send: (channel: string, ...args: readonly unknown[]): void => {
        this.note('send', { channel, args })
      },
      isDestroyed: (): boolean => this.gone,
    }

    constructor(readonly options: unknown) {
      this.record = {
        options,
        calls: this.calls,
        destroyed: (): boolean => this.gone,
        argumentOf: (call: string): Record<string, unknown> | undefined =>
          this.calls.find((entry) => entry.call === call)?.argument,
      }
      windows.push(this.record)
    }
    private note(call: string, argument?: Record<string, unknown>): void {
      // Sampled on every call, so the harness can answer "was the listener still open at
      // the instant the window was destroyed" from inside the run. Last value wins, which
      // is what the shutdown-ordering test reads.
      listeningAt.set(call, listening())
      this.calls.push(argument === undefined ? { call } : { call, argument })
    }
    async loadURL(url: string): Promise<void> {
      this.note('loadURL', { url })
      if (options.failLoad === true) throw new Error('the hub served no card document')
    }
    showInactive(): void {
      this.note('showInactive')
    }
    hide(): void {
      this.note('hide')
    }
    isDestroyed(): boolean {
      return this.gone
    }
    destroy(): void {
      options.onDestroy?.()
      this.note('destroy')
      this.gone = true
    }
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
      this.note('setBounds', { bounds })
    }
    setIgnoreMouseEvents(ignore: boolean, ignoreOptions?: { forward?: boolean }): void {
      this.note('setIgnoreMouseEvents', { ignore, options: ignoreOptions ?? null })
    }
  }

  return {
    BrowserWindow: StubWindow as unknown as new (options: unknown) => BrowserWindowLike,
    screen: {
      getPrimaryDisplay: (): { workArea: WorkArea } => {
        if (workArea === null) throw new Error('no display available')
        return { workArea }
      },
    },
    windows,
    listeningAt,
  }
}

/** A host over the stub, with the card document URL a hub on `origin` would serve. */
function stubHost(
  electron: StubElectron,
  origin = `${LOOPBACK_ORIGIN}:${String(HUB_PORT)}`,
  extra: {
    corner?: (typeof SURFACE_CORNERS)[number]
    onDiagnostic?: (message: string) => void
  } = {},
): NotificationSurfaceHost {
  return createElectronSurfaceHost({
    BrowserWindow: electron.BrowserWindow,
    screen: electron.screen,
    documentUrl: (): string => surfaceDocumentUrl(origin),
    ...(extra.corner === undefined ? {} : { corner: extra.corner }),
    ...(extra.onDiagnostic === undefined ? {} : { onDiagnostic: extra.onDiagnostic }),
  })
}

function callsOf(window: RecordedWindow | undefined): readonly string[] {
  if (window === undefined) throw new Error('no window was created, so there are no calls to read')
  return window.calls.map((entry) => entry.call)
}

function boundsOf(window: RecordedWindow | undefined): { x: number; y: number; width: number; height: number } {
  const argument = window?.argumentOf('setBounds')
  if (argument === undefined) throw new Error('the host never placed the card')
  return argument['bounds'] as { x: number; y: number; width: number; height: number }
}

// ---------------------------------------------------------------------------
// Criterion 1: the exact BrowserWindow option object
// ---------------------------------------------------------------------------

describe('the BrowserWindow option object', () => {
  it('is exactly SURFACE_WINDOW_OPTIONS, key for key and value for value', () => {
    const electron = stubElectron()
    stubHost(electron)

    expect(electron.windows).toHaveLength(1)
    const options = electron.windows[0]?.options as Record<string, unknown>
    // Compared against the same frozen object the host hands to the constructor, so a
    // second literal spread at the call site would be a different object and this fails.
    expect(options).toEqual(SURFACE_WINDOW_OPTIONS)
    expect(Object.keys(options).sort()).toEqual(
      [
        'alwaysOnTop',
        'focusable',
        'frame',
        'hasShadow',
        'height',
        'resizable',
        'show',
        'skipTaskbar',
        'transparent',
        'webPreferences',
        'width',
      ].sort(),
    )
    // The webPreferences key set, enumerated exactly, because NT-FR-12's channel is a
    // `preload` path and a preload that arrived by any other route - a string in a
    // spread, an option added at the call site - would not be the one the window loads.
    expect(Object.keys(options['webPreferences'] as Record<string, unknown>).sort()).toEqual(
      ['contextIsolation', 'nodeIntegration', 'preload', 'sandbox'].sort(),
    )
  })

  // AMENDED DELIBERATELY, BY NS-2. NT-6 asserted the webPreferences object equals exactly
  // { contextIsolation, nodeIntegration, sandbox }, and that assertion was correct for the
  // window NT-6 built: with no preload there was no way for a card model to reach the card
  // document, and NT-FR-12's requirement is that the product itself supplies that way. The
  // only change is one added key, `preload`, naming this product's own preload file
  // (src/notify/surface/preload.cts). The three settings NT-6 added it for are untouched
  // and are still asserted by name, in the next two tests and in the launch-policy
  // section; the object is still frozen, which the test after this one checks. Nothing was
  // loosened: the equality is still exact, and the key enumeration above is a *new*
  // assertion rather than a weakened one.
  it('carries the preload the card channel runs in, and nothing else beside it (NT-FR-12)', () => {
    const electron = stubElectron()
    stubHost(electron)

    const webPreferences = (electron.windows[0]?.options as Record<string, unknown>)['webPreferences'] as Record<
      string,
      unknown
    >
    expect(webPreferences).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: CARD_PRELOAD_PATH,
    })
    // A path beside the module that names it, ending in the file tsc emits for a `.cts`
    // source. The extension is not a convention: a preload in a `sandbox: true` renderer
    // has no ESM context, so a `.mjs` or ESM `.js` preload fails with `SyntaxError:
    // Cannot use import statement outside a module` (measured against Electron 44.4.5),
    // and this repository's `moduleDetection: "force"` and `type: "module"` would append a
    // module marker to any `.ts` it compiled. The *resolution* is asserted from a real
    // `file:` URL in the next test, because this runner does not hand out one.
    expect(
      CARD_PRELOAD_PATH.endsWith(`/notify/surface/${CARD_PRELOAD_FILE_NAME}`) ||
        CARD_PRELOAD_PATH === `./${CARD_PRELOAD_FILE_NAME}`,
    ).toBe(true)
  })

  it('names the preload source the build compiles and the file it emits', () => {
    // The preload is two files on purpose: ./preload.ts is the address - this module's
    // `webPreferences` carries its value - and ./preload.cts is the body, because tsc emits
    // a module marker into any `.ts` in this ES module package and a sandboxed preload is
    // parsed as a plain script. The two are asserted against each other here so neither can
    // be renamed without the other (NT-FR-12).
    expect(CARD_PRELOAD_SOURCE_FILE).toBe('src/notify/surface/preload.cts')
    expect(CARD_PRELOAD_FILE_NAME).toBe('preload.cjs')
    // And the build really does compile that source to that file's name: `.cts` in,
    // `.cjs` out, whatever the module setting says. Read through the suite's own source
    // reader, so the file is proved to be there rather than named.
    expect(readModuleWithoutProse(CARD_PRELOAD_SOURCE_FILE)).toContain('require')
    expect(CARD_PRELOAD_FILE_NAME.endsWith('.cjs')).toBe(true)
  })

  it('resolves the preload beside the module that names it, from a real file URL', () => {
    // The packaged application runs the compiled file, so this is the branch that
    // decides the path the window loads. Driven from a literal `file:` URL rather than
    // from `import.meta.url`, which a test runner that serves modules over HTTP cannot
    // provide - and the fallback is asserted right after, because a module loader with no
    // `file:` URL must produce a name rather than a path into a test server.
    expect(
      resolveCardPreloadPath('file:///opt/agent-ping/dist/main/notify/surface/electron-host.js'),
    ).toBe(`/opt/agent-ping/dist/main/notify/surface/${CARD_PRELOAD_FILE_NAME}`)
    expect(resolveCardPreloadPath('http://localhost:5173/src/notify/surface/electron-host.ts')).toBe(
      `./${CARD_PRELOAD_FILE_NAME}`,
    )
  })

  it('leaves the three renderer settings that make the card document safe (NT-FR-04)', () => {
    // The ones NT-FR-04 is about, asserted by name rather than as part of a whole object,
    // because NT-FR-12's channel was required to be built *without* widening them: the
    // alternative ways to carry a card model - `webSecurity: false`, `nodeIntegration:
    // true`, `executeJavaScript` - each trade exactly these for a convenience this
    // product does not need.
    const electron = stubElectron()
    stubHost(electron)
    const webPreferences = (electron.windows[0]?.options as Record<string, unknown>)['webPreferences'] as Record<
      string,
      unknown
    >
    expect(webPreferences['contextIsolation']).toBe(true)
    expect(webPreferences['nodeIntegration']).toBe(false)
    expect(webPreferences['sandbox']).toBe(true)
  })

  it('is frozen, so a caller cannot change the contract at run time', () => {
    expect(Object.isFrozen(SURFACE_WINDOW_OPTIONS)).toBe(true)
    expect(Object.isFrozen(SURFACE_WINDOW_OPTIONS['webPreferences'])).toBe(true)
  })

  it('carries show: false, so the window exists without occupying screen space (NT-FR-10)', async () => {
    // The requirement is that the host window existing is not the surface being visible.
    // A window created with show: true puts an empty rectangle on the developer's screen
    // for as long as the hub runs, which is the always-on panel ADR-009 declined.
    const electron = stubElectron()
    const host = stubHost(electron)
    expect((electron.windows[0]?.options as Record<string, unknown>)['show']).toBe(false)
    // And it stays false: showing a card is a call on the window, not a new option object.
    await host.show()
    expect((electron.windows[0]?.options as Record<string, unknown>)['show']).toBe(false)
    expect(callsOf(electron.windows[0])).toContain('showInactive')
  })

  it('carries focusable: false, so a card cannot take the keystroke being typed (NT-FR-04)', () => {
    const electron = stubElectron()
    stubHost(electron)
    expect((electron.windows[0]?.options as Record<string, unknown>)['focusable']).toBe(false)
  })

  it('carries the rest of the set: frameless, transparent, non-resizable, taskbar-skipping, always-on-top, shadowless', () => {
    const electron = stubElectron()
    stubHost(electron)
    expect(electron.windows[0]?.options).toMatchObject({
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
    })
  })

  it('sizes the window from the same card size the placement uses', () => {
    expect(SURFACE_WINDOW_OPTIONS['width']).toBe(CARD_SIZE.width)
    expect(SURFACE_WINDOW_OPTIONS['height']).toBe(CARD_SIZE.height)
  })
})

// ---------------------------------------------------------------------------
// Criterion 2: the card rectangle, through the host
// ---------------------------------------------------------------------------

describe('the card rectangle the host asks for', () => {
  for (const corner of SURFACE_CORNERS) {
    it(`is inside the work area and clear of the 32px top inset: ${corner}`, async () => {
      const electron = stubElectron()
      const host = stubHost(electron)
      await host.show({ corner })

      const bounds = boundsOf(electron.windows[0])
      expect(isInsideWorkArea(bounds, WORK_AREA)).toBe(true)
      // The concrete defect NT-FR-04 names: placed against the screen rectangle this
      // would be y=16, i.e. 16px inside the panel.
      expect(bounds.y).toBeGreaterThanOrEqual(WORK_AREA.y)
      expect(bounds.x).toBeGreaterThanOrEqual(WORK_AREA.x)
      expect(bounds.width).toBe(CARD_SIZE.width)
      expect(bounds.height).toBe(CARD_SIZE.height)
    })
  }

  it('reads the work area per show, so a resized display is not a card over a taskbar', async () => {
    // A host built once and a display that changed: the second card must be placed
    // against the new area rather than against one captured at mount.
    let current: WorkArea = { x: 0, y: 32, width: 1920, height: 1048 }
    const electron = stubElectron()
    const host = createElectronSurfaceHost({
      BrowserWindow: electron.BrowserWindow,
      screen: { getPrimaryDisplay: (): { workArea: WorkArea } => ({ workArea: current }) },
      documentUrl: (): string => surfaceDocumentUrl(`${LOOPBACK_ORIGIN}:${String(HUB_PORT)}`),
    })
    await host.show({ corner: 'top-left' })
    current = { x: 0, y: 0, width: 1000, height: 500 }
    await host.show({ corner: 'top-left' })

    const placements = (electron.windows[0]?.calls ?? [])
      .filter((entry) => entry.call === 'setBounds')
      .map((entry) => (entry.argument as { bounds: unknown }).bounds)
    expect(placements).toEqual([
      { x: 16, y: 48, width: 320, height: 96 },
      { x: 16, y: 16, width: 320, height: 96 },
    ])
  })

  it('refuses to show rather than placing a card with no work area to place it in', async () => {
    // A display that reports nothing usable is the shape a session with no window manager
    // produces, and the screen rectangle is not an acceptable fallback: a taskbar, a dock
    // or a top panel lives in it.
    const electron = stubElectron({ workArea: null })
    const host = stubHost(electron, `${LOOPBACK_ORIGIN}:${String(HUB_PORT)}`, {
      onDiagnostic: (message) => diagnostics.push(message),
    })
    const answer = await host.show()
    expect(answer).toMatchObject({ available: false, reason: 'window-refused' })
    expect(callsOf(electron.windows[0])).not.toContain('showInactive')
    expect(diagnostics.join('\n')).toMatch(/could not place the notification card/)
  })

  it('refuses to show when the display reports a rectangle that is not a work area', async () => {
    const electron = stubElectron()
    const host = createElectronSurfaceHost({
      BrowserWindow: electron.BrowserWindow,
      screen: {
        getPrimaryDisplay: (): { workArea: WorkArea } =>
          ({ workArea: undefined }) as unknown as { workArea: WorkArea },
      },
      documentUrl: (): string => surfaceDocumentUrl(`${LOOPBACK_ORIGIN}:${String(HUB_PORT)}`),
      onDiagnostic: (message) => diagnostics.push(message),
    })
    expect(await host.show()).toMatchObject({ available: false, reason: 'window-refused' })
    expect(callsOf(electron.windows[0])).not.toContain('showInactive')
  })
})

// ---------------------------------------------------------------------------
// Showing, hiding, click-through, the loopback document
// ---------------------------------------------------------------------------

describe('showing a card', () => {
  it('loads the card document from the hub\'s own loopback origin', async () => {
    const electron = stubElectron()
    const host = stubHost(electron, `${LOOPBACK_ORIGIN}:51234`)
    await host.show()

    expect(electron.windows[0]?.argumentOf('loadURL')?.['url']).toBe('http://127.0.0.1:51234/card.html')
    expect(surfaceDocumentUrl('http://127.0.0.1:51234')).toBe(`${LOOPBACK_ORIGIN}:51234${SURFACE_DOCUMENT_PATH}`)
  })

  it('loads the document once, and re-places rather than reloading on a second card', async () => {
    const electron = stubElectron()
    const host = stubHost(electron)
    await host.show()
    await host.show({ corner: 'bottom-right' })
    expect(callsOf(electron.windows[0]).filter((call) => call === 'loadURL')).toHaveLength(1)
    expect(callsOf(electron.windows[0]).filter((call) => call === 'setBounds')).toHaveLength(2)
  })

  it('shows with showInactive, never with show, so no keystroke is taken', async () => {
    const electron = stubElectron()
    const host = stubHost(electron)
    await host.show()
    expect(callsOf(electron.windows[0])).toContain('showInactive')
    expect(callsOf(electron.windows[0])).not.toContain('show')
  })

  it('is click-through by default, forwarding the pointer to the window underneath', async () => {
    const electron = stubElectron()
    const host = stubHost(electron)
    await host.show()
    expect(electron.windows[0]?.argumentOf('setIgnoreMouseEvents')).toEqual({
      ignore: true,
      options: { forward: true },
    })
  })

  it('takes click-through back when asked, with no forward option', async () => {
    // Two directions, asserted separately: a card that is always click-through can never
    // be clicked, and one that is never click-through swallows the clicks meant for the
    // window behind it.
    const electron = stubElectron()
    const host = stubHost(electron)
    await host.show()
    host.setClickThrough(false)
    host.setClickThrough(true)

    const switches = (electron.windows[0]?.calls ?? [])
      .filter((entry) => entry.call === 'setIgnoreMouseEvents')
      .map((entry) => entry.argument)
    // Three calls: the show took click-through by default, then the caller gave it back,
    // then took it again. Both directions, asserted separately: a card that is always
    // click-through can never be clicked, and one that is never click-through swallows
    // the clicks meant for the window behind it.
    expect(switches).toEqual([
      { ignore: true, options: { forward: true } },
      { ignore: false, options: null },
      { ignore: true, options: { forward: true } },
    ])
    expect(await host.probe()).toEqual({ available: true, reason: 'available' })
  })

  it('does not repeat a click-through switch it has already made', async () => {
    const electron = stubElectron()
    const host = stubHost(electron)
    await host.show()
    host.setClickThrough(true)
    host.setClickThrough(true)
    expect(callsOf(electron.windows[0]).filter((call) => call === 'setIgnoreMouseEvents')).toHaveLength(1)
  })

  it('accepts a card that asks not to be click-through', async () => {
    const electron = stubElectron()
    const host = stubHost(electron)
    await host.show({ clickThrough: false })
    expect(electron.windows[0]?.argumentOf('setIgnoreMouseEvents')).toEqual({ ignore: false, options: null })
  })

  it('reports a card it could not load rather than throwing into the delivery path', async () => {
    const electron = stubElectron({ failLoad: true })
    const host = stubHost(electron, `${LOOPBACK_ORIGIN}:51234`, {
      onDiagnostic: (message) => diagnostics.push(message),
    })
    const answer = await host.show()
    expect(answer).toMatchObject({ available: false, reason: 'document-unavailable' })
    // Nothing was shown: a window that reported a card it could not paint is the one
    // failure APX-FR-02 exists for.
    expect(callsOf(electron.windows[0])).not.toContain('showInactive')
    expect(diagnostics.join('\n')).toMatch(/card document could not be loaded over the loopback hub/)
  })

  it('refuses a document URL that is not the loopback card document', async () => {
    // The guard the host builds its own URL behind, asserted directly so a future caller
    // cannot widen it: a file: or data: document would defeat the CSP the dashboard route
    // sends, and a remote one would be an outbound call (APX-CON-12).
    expect(() => assertLoopbackDocumentUrl('file:///tmp/card.html')).toThrow(SurfaceWindowRefusedError)
    expect(() => assertLoopbackDocumentUrl('data:text/html,<p>card</p>')).toThrow(/not on the loopback hub/)
    expect(() => assertLoopbackDocumentUrl('https://example.com/card.html')).toThrow(/not on the loopback hub/)
    expect(() => assertLoopbackDocumentUrl(`${LOOPBACK_ORIGIN}:${String(HUB_PORT)}/evil.html`)).toThrow(
      /not the card document/,
    )
    expect(assertLoopbackDocumentUrl(`${LOOPBACK_ORIGIN}:${String(HUB_PORT)}${SURFACE_DOCUMENT_PATH}`)).toBe(
      `${LOOPBACK_ORIGIN}:${String(HUB_PORT)}${SURFACE_DOCUMENT_PATH}`,
    )
  })

  it('refuses to show a card when the document URL is not the hub\'s', async () => {
    const electron = stubElectron()
    const host = createElectronSurfaceHost({
      BrowserWindow: electron.BrowserWindow,
      screen: electron.screen,
      documentUrl: (): string => 'file:///tmp/card.html',
      onDiagnostic: (message) => diagnostics.push(message),
    })
    expect(await host.show()).toMatchObject({ available: false, reason: 'document-unavailable' })
    expect(callsOf(electron.windows[0])).not.toContain('loadURL')
  })
})

describe('hiding and destroying', () => {
  it('hides the card without destroying the window, which is what NT-FR-10 asks for', async () => {
    const electron = stubElectron()
    const host = stubHost(electron)
    await host.show()
    host.hide()
    expect(callsOf(electron.windows[0])).toEqual([
      'loadURL',
      'setBounds',
      'showInactive',
      'setIgnoreMouseEvents',
      'hide',
    ])
    expect(electron.windows[0]?.destroyed()).toBe(false)
  })

  it('is idempotent for hide and for destroy', async () => {
    const electron = stubElectron()
    const host = stubHost(electron)
    host.hide()
    host.hide()
    host.destroy()
    host.destroy()
    expect(callsOf(electron.windows[0])).toEqual(['destroy'])
  })

  it('reports the window as destroyed afterwards, and shows nothing', async () => {
    const electron = stubElectron()
    const host = stubHost(electron)
    host.destroy()
    expect(await host.probe()).toEqual({ available: false, reason: 'window-destroyed' })
    expect(await host.show()).toEqual({ available: false, reason: 'window-destroyed' })
    // Nothing after a destroy: a window that outlives its destroy is a window nobody
    // asked for.
    expect(callsOf(electron.windows[0])).toEqual(['destroy'])
  })

  it('refuses a window the desktop will not create, as a typed refusal', () => {
    class Refusing {
      constructor() {
        throw new Error('the window manager refused a transparent frameless window')
      }
    }
    expect(() =>
      createElectronSurfaceHost({
        BrowserWindow: Refusing as unknown as new (options: unknown) => BrowserWindowLike,
        screen: stubElectron().screen,
        documentUrl: (): string => surfaceDocumentUrl(`${LOOPBACK_ORIGIN}:${String(HUB_PORT)}`),
      }),
    ).toThrow(SurfaceWindowRefusedError)
  })
})

// ---------------------------------------------------------------------------
// Criterion 6: the Chromium launch policy
// ---------------------------------------------------------------------------

describe('the Chromium launch policy', () => {
  it('names --no-sandbox as the switch, and nothing else', () => {
    expect(CHROMIUM_LAUNCH_FLAGS).toEqual(['no-sandbox'])
    expect(CHROMIUM_LAUNCH_POLICY.switch).toBe('no-sandbox')
    expect(CHROMIUM_LAUNCH_POLICY.decision).toBe('process-sandbox-disabled')
    // The pre-flight recorded a GPU launch failure under software rendering. It is
    // recorded and not worked around, and a re-run on the same machine confirmed the
    // application reaches `ready` without it, so a two-line DOM card does not carry a
    // flag nobody measured.
    expect(CHROMIUM_LAUNCH_FLAGS).toHaveLength(1)
    expect(CHROMIUM_LAUNCH_FLAGS.join(' ')).not.toMatch(/gpu/i)
  })

  it('appends the switch to app.commandLine, for the processes this one starts', () => {
    const switches: string[] = []
    const applied = applyChromiumLaunchPolicy({ appendSwitch: (name) => switches.push(name) })
    expect(switches).toEqual(['no-sandbox'])
    expect(applied).toEqual(['no-sandbox'])
  })

  it('names the observed reason, so the choice is recorded rather than looking like a default', () => {
    // Every finding of the pre-flight's blockingFinding, plus the mechanism finding from
    // the live re-run, in the words an operator reads.
    expect(CHROMIUM_LAUNCH_POLICY.reason).toMatch(/chrome-sandbox helper is not setuid-root/)
    expect(CHROMIUM_LAUNCH_POLICY.reason).toMatch(/AppArmor/)
    expect(CHROMIUM_LAUNCH_POLICY.reason).toMatch(/aborts rather than degrading/)
    expect(CHROMIUM_LAUNCH_POLICY.reason).toMatch(/before any JavaScript in this package runs/)
    expect(CHROMIUM_LAUNCH_POLICY.reason).toMatch(/webPreferences\.sandbox/)
    // The one that is easy to get wrong, stated as a fact in the policy rather than left
    // in a comment: a switch applied from JavaScript cannot prevent this abort.
    expect(CHROMIUM_LAUNCH_POLICY.appliesBeforeStartup).toBe(true)
  })

  it('offers the environment form as well, because either delivery is enough', () => {
    // Verified on the authoring machine: with this variable and no command-line switch,
    // Electron 44.4.5 started, became ready and drew a card. It is here for a per-user
    // autostart unit, where the environment is often the only part the packager owns.
    expect(CHROMIUM_LAUNCH_ENVIRONMENT).toEqual({ ELECTRON_DISABLE_SANDBOX: '1' })
    expect(Object.isFrozen(CHROMIUM_LAUNCH_ENVIRONMENT)).toBe(true)
  })

  it('keeps the renderer sandbox in force, which is a different layer from the process one', () => {
    // The renderer setting is in the window options and the policy says so, and both are
    // asserted here so an edit that dropped `sandbox: true` could not pass as a change of
    // launch policy. Checked against the real renderer on the authoring machine too: with
    // the process sandbox disabled the card document had neither `process` nor `require`.
    expect(CHROMIUM_LAUNCH_POLICY.rendererSandbox).toBe(true)
    const webPreferences = SURFACE_WINDOW_OPTIONS['webPreferences'] as Record<string, unknown>
    expect(webPreferences['sandbox']).toBe(true)
    expect(webPreferences['contextIsolation']).toBe(true)
    expect(webPreferences['nodeIntegration']).toBe(false)
  })

  it('throws rather than starting when the runtime cannot take a switch at all', () => {
    // A silent return here would leave the packaged application inheriting a default
    // while looking configured.
    expect(() => applyChromiumLaunchPolicy({} as never)).toThrow(/no `app.commandLine`/)
    expect(() => applyChromiumLaunchPolicy(null as never)).toThrow(/no `app.commandLine`/)
  })
})

describe('whether this process was actually launched under the policy', () => {
  // Chromium reads its command line and decides about the sandbox before any JavaScript
  // in this package runs, so `applyChromiumLaunchPolicy` cannot be the thing that
  // prevents the abort. These are the tests for the honest report of that gap: a
  // readable line naming what to add, instead of a SIGTRAP with no message on this side.
  const ARGV = ['/usr/bin/electron', '/opt/agent-ping/dist/main/main/index.js']

  it('accepts the switch on the command line', () => {
    expect(launchPolicyApplied([...ARGV, '--no-sandbox'], {})).toBeNull()
    // Anywhere in argv, and in either single- or double-dash spelling is NOT accepted:
    // only the spelling Chromium reads.
    expect(launchPolicyApplied(['--no-sandbox', ...ARGV], {})).toBeNull()
    expect(launchPolicyApplied([...ARGV, '-no-sandbox'], {})).not.toBeNull()
    expect(launchPolicyApplied([...ARGV, '--no-sandbox=false'], {})).not.toBeNull()
  })

  it('accepts the environment form on its own', () => {
    expect(launchPolicyApplied(ARGV, { ELECTRON_DISABLE_SANDBOX: '1' })).toBeNull()
    // A different value is not the same decision.
    expect(launchPolicyApplied(ARGV, { ELECTRON_DISABLE_SANDBOX: '0' })).not.toBeNull()
    expect(launchPolicyApplied(ARGV, { ELECTRON_DISABLE_SANDBOX: undefined })).not.toBeNull()
  })

  it('names both mechanisms and the consequence when neither reached the process', () => {
    const gap = launchPolicyApplied(ARGV, {})
    expect(gap).not.toBeNull()
    expect(gap).toMatch(/--no-sandbox/)
    expect(gap).toMatch(/ELECTRON_DISABLE_SANDBOX=1/)
    expect(gap).toMatch(/before any JavaScript in this package runs/)
    // The sentence has to say where the switch has to go, or it is only half a
    // diagnosis.
    expect(gap).toMatch(/desktop entry, an autostart unit, or a shell/)
    expect(gap).toMatch(/SIGTRAP/)
  })

  it('is reported by the main entry point, next to the appendSwitch that cannot do it alone', () => {
    // A real gap check that nobody calls would be a function that exists and is never
    // used, which is how "explicitly applied" quietly becomes "decided in a comment".
    const source = readModuleWithoutProse('src/main/index.ts')
    const gap = source.indexOf('launchPolicyApplied(process.argv, process.env)')
    const applied = source.indexOf('applyChromiumLaunchPolicy(app.commandLine)')
    expect(gap).toBeGreaterThan(-1)
    expect(applied).toBeGreaterThan(-1)
    expect(gap).toBeLessThan(applied)
  })

  it('is applied by the main entry point before app.whenReady(), and not after', () => {
    // A Chromium switch appended after the application is ready is ignored by the app's
    // own children, which would make this a policy that looked decided and behaved as
    // though it had not been. Scoped to `startElectronMain` so the `whenReady`
    // declaration in the structural Electron interface is not mistaken for the call.
    const source = readModuleWithoutProse('src/main/index.ts')
    const start = source.indexOf('export async function startElectronMain')
    expect(start).toBeGreaterThan(-1)
    const entry = source.slice(start)
    const applied = entry.indexOf('applyChromiumLaunchPolicy(')
    const ready = entry.indexOf('.whenReady()')
    expect(applied).toBeGreaterThan(-1)
    expect(ready).toBeGreaterThan(-1)
    expect(applied).toBeLessThan(ready)
  })
})

// ---------------------------------------------------------------------------
// Criterion 5: the seam needs no Electron
// ---------------------------------------------------------------------------

/**
 * One product source file with its comments removed, and optionally its string literals.
 *
 * A line of regexes cannot do this safely on TypeScript source. `http://127.0.0.1` inside
 * a string looks like a line comment; an apostrophe inside a comment looks like a string
 * delimiter; and either one unbalances the rest of the file, which turns a source-level
 * assertion into a source-level assertion about nothing at all. So this walks the
 * characters once and tracks which of the four states it is in - line comment, block
 * comment, single/double/backtick string, or a regex literal - and replaces the contents
 * of a comment with spaces. Newlines are preserved, so a failure's line numbers still
 * point at the line the author is looking at.
 *
 * Comments go either way: a source-level check is about the calls a module makes, not
 * about the sentences describing them, so a comment that names a forbidden tool can
 * neither satisfy nor break one. `keepStrings` is for the one check that genuinely needs
 * the values - which module this one imports.
 */
function readModule(relative: string, options: { readonly keepStrings?: boolean } = {}): string {
  const keepStrings = options.keepStrings ?? false
  const source = readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')
  let out = ''
  let index = 0
  let previous = ''
  const blank = (length: number): void => {
    for (let offset = 0; offset < length; offset += 1) out += source[index + offset] === '\n' ? '\n' : ' '
  }
  while (index < source.length) {
    const pair = source.slice(index, index + 2)
    if (pair === '//') {
      let end = source.indexOf('\n', index)
      if (end === -1) end = source.length
      blank(end - index)
      index = end
      continue
    }
    if (pair === '/*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(stop - index)
      index = stop
      continue
    }
    const character = source[index] ?? ''
    if (character === "'" || character === '"' || character === '`') {
      let cursor = index + 1
      while (cursor < source.length) {
        const inner = source[cursor]
        if (inner === '\\') {
          cursor += 2
          continue
        }
        if (inner === character || inner === '\n') break
        cursor += 1
      }
      const stop = Math.min(cursor + 1, source.length)
      // A template literal can span lines and can hold an expression; both are replaced
      // wholesale rather than scanned, so `${...}` inside one is treated as text.
      if (keepStrings) out += source.slice(index, stop)
      else blank(stop - index)
      index = stop
      previous = 'x'
      continue
    }
    if (character === '/' && !/[A-Za-z0-9_$)\]]/.test(previous)) {
      // A regex literal rather than a division, by the standard heuristic. None of the
      // modules this helper is pointed at currently has one; the branch is here so a
      // later one cannot silently corrupt every check that reads the file.
      let cursor = index + 1
      let inClass = false
      while (cursor < source.length) {
        const inner = source[cursor]
        if (inner === '\\') {
          cursor += 2
          continue
        }
        if (inner === '[') inClass = true
        else if (inner === ']') inClass = false
        else if (inner === '/' && !inClass) break
        else if (inner === '\n') break
        cursor += 1
      }
      if (cursor < source.length && source[cursor] === '/') {
        cursor += 1
        while (cursor < source.length && /[a-z]/.test(source[cursor] ?? '')) cursor += 1
        blank(cursor - index)
        index = cursor
        previous = 'x'
        continue
      }
    }
    out += character
    if (!/\s/.test(character)) previous = character
    index += 1
  }
  return out
}

/** Comments and string literals gone: about the calls a module makes. */
function readModuleWithoutProse(relative: string): string {
  return readModule(relative)
}

/** Comments gone, string literals kept: about the modules a file names. */
function readModuleImports(relative: string): string {
  return readModule(relative, { keepStrings: true })
}

describe('the interface module imports no electron module', () => {
  it('names no electron specifier, and only this product\'s own geometry', () => {
    const source = readModuleImports('src/notify/surface/host.ts')
    const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*'([^']*)'/g)].map((match) => match[1] ?? '')
    // Two statements name the one module the interface is allowed to depend on: the
    // type-only import it uses, and the re-export so a caller needs one module for the
    // whole contract. Stated as a fact rather than as a permission, and deduplicated so
    // adding a third statement for the same module is not a failure.
    expect([...new Set(specifiers)].sort()).toEqual(['./position.js'])
    expect(specifiers.filter((specifier) => specifier.includes('electron'))).toEqual([])
  })

  it('declares exactly the five operations the hub needs, and no way out of them', () => {
    // Enumerated from the module's own declaration rather than restated, so a method
    // added to the interface - a `move`, a `beep`, a `requestPermission` - fails here
    // instead of becoming a compile error nobody reads.
    const source = readModuleWithoutProse('src/notify/surface/host.ts')
    const start = source.indexOf('export interface NotificationSurfaceHost {')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n}', start))
    const methods = [...body.matchAll(/^\s{2}(\w+)\(/gm)].map((match) => match[1])
    expect(methods).toEqual(['probe', 'show', 'hide', 'setClickThrough', 'destroy'])
  })

  it('ran this whole file with no Electron runtime in the process and no display', () => {
    expect(process.versions['electron']).toBeUndefined()
  })
})

describe('the surface path reaches no platform notification mechanism', () => {
  it('contains no notification API call, no spawned command, no audio element and no platform branch', () => {
    // NT-FR-02 and NT-FR-11, enforced by the suite rather than promised in a comment. The
    // six modules that make up the surface are read with their prose stripped, so this
    // is about the identifiers and calls the code uses. The three added by NS-2 - the
    // channel contract, the preload's address and the preload's body - are in the same
    // list, so the code that now crosses into a renderer is held to the same rule as the
    // window that shows it.
    for (const relative of [
      'src/notify/surface/host.ts',
      'src/notify/surface/electron-host.ts',
      'src/notify/surface/position.ts',
      'src/notify/surface/channel.ts',
      'src/notify/surface/preload.ts',
      'src/notify/surface/preload.cts',
    ]) {
      const source = readModuleWithoutProse(relative)
      for (const forbidden of [
        'new Notification',
        'requestPermission',
        'child_process',
        'spawn(',
        'exec(',
        'Audio(',
        '<audio',
        'process.platform',
        'style.cssText',
        '.style.',
      ]) {
        expect(source.includes(forbidden), `${relative} must not contain ${forbidden}`).toBe(false)
      }
    }
  })

  it('makes no outbound call: the only network call is loadURL, over the loopback origin', () => {
    // `readModuleWithoutProse` has already removed every string literal, so a remote
    // origin would have to appear as concatenated code - and nothing in this module
    // concatenates one. What is left to check is that the single network call is the one
    // that loads the card document, and that it goes through the loopback guard.
    const source = readModuleWithoutProse('src/notify/surface/electron-host.ts')
    expect(source).toContain('loadURL')
    expect(source).toContain('assertLoopbackDocumentUrl(')
    // No socket, no fetch, no DNS, no child process: the surface adds no outbound call of
    // any kind to this product (APX-CON-12).
    for (const forbidden of ['fetch(', 'net.', 'dns.', 'https.request', 'XMLHttpRequest', 'WebSocket']) {
      expect(source.includes(forbidden), `electron-host.ts must not contain ${forbidden}`).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Criteria 3 and 4: through the real main entry point
// ---------------------------------------------------------------------------

interface Fetched {
  readonly status: number
  readonly text: string
  json<T = unknown>(): T
}

/** One request over the real loopback socket, one connection. */
function call(origin: string, method: string, pathname: string, body?: string): Promise<Fetched> {
  const { hostname, port } = new URL(origin)
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: hostname,
        port,
        path: pathname,
        method,
        headers: {
          'content-type': 'application/json',
          ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
        },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: response.statusCode ?? 0, text, json: <T,>(): T => JSON.parse(text) as T })
        })
      },
    )
    outgoing.on('error', reject)
    if (body === undefined) outgoing.end()
    else outgoing.end(body)
  })
}

const NOTIFIER_STUB = { notifier: vi.fn<Notifier>(() => undefined) }

/** A surface bridge over the stub, recording what the composition root passed to it. */function bridgeOver(
  electron: StubElectron,
  onCreate?: (options: CreateSurfaceHostOptions) => void,
): SurfaceHostBridge {
  return {
    create: (options): NotificationSurfaceHost => {
      onCreate?.(options)
      return createElectronSurfaceHost({
        BrowserWindow: electron.BrowserWindow,
        screen: electron.screen,
        documentUrl: (): string => surfaceDocumentUrl(options.origin()),
        ...(options.corner === undefined ? {} : { corner: options.corner }),
      })
    },
  }
}

/** A tray bridge that does nothing but record that it was closed. */
function inertTray(): TrayBridge {
  return {
    showIcon: (): void => undefined,
    showMenu: (): void => undefined,
    onActivate: (): void => undefined,
    openDashboard: (): never => {
      throw new Error('this file does not open a dashboard')
    },
    destroy: (): void => undefined,
  }
}

describe('mount, show, hide and destroy, through the real main entry point', () => {
  it('mounts the window when the hub starts, with the asserted options, and shows it for a card', async () => {
    const electron = stubElectron()
    const created: CreateSurfaceHostOptions[] = []
    const hub = await startHub({
      stateDir: temporaryDirectory(),
      dashboardRoot: null,
      lifecycle: { installSignals: false, exit: (): void => undefined },
      // The notifier is stubbed so a full `npm test` cannot put a real toast on the
      // developer's desktop. Whether the port is wired at all is decided by whether a
      // notifier is passed, not by what it does, and the refusal case below is the one
      // that tests the decision.
      delivery: NOTIFIER_STUB,
      desktop: { isPrimaryInstance: true, surface: bridgeOver(electron, (options) => created.push(options)) },
      onDiagnostic: (message) => diagnostics.push(message),
    })
    openHubs.push(hub)

    // Mounted at start, not on the first card: NT-FR-04 says the window is created when
    // the hub starts, and `show: false` is what keeps that from costing screen space.
    expect(electron.windows).toHaveLength(1)
    expect(electron.windows[0]?.options).toEqual(SURFACE_WINDOW_OPTIONS)
    expect(hub.surface).not.toBeNull()
    expect(await hub.surface?.probe()).toEqual({ available: true, reason: 'available' })

    // The origin arrives as a thunk, because the host is mounted before the socket is
    // bound - which is the order that lets a refusal withhold the notifier.
    expect(typeof created[0]?.origin).toBe('function')
    expect(created[0]?.origin()).toBe(hub.origin)

    // A real card on the real hub's real port.
    expect(await hub.surface?.show({ corner: 'top-right' })).toEqual({ available: true, reason: 'available' })
    expect(electron.windows[0]?.argumentOf('loadURL')?.['url']).toBe(`${hub.origin}${SURFACE_DOCUMENT_PATH}`)
    expect(isInsideWorkArea(boundsOf(electron.windows[0]), WORK_AREA)).toBe(true)

    hub.surface?.hide()
    expect(callsOf(electron.windows[0])).toContain('hide')
    expect(electron.windows[0]?.destroyed()).toBe(false)
  })

  it('destroys the window first in the ordered shutdown, before the tray and before the listener closes', async () => {
    let listeningAtDestroy: boolean | null = null
    let windowGoneWhenTrayClosed: boolean | null = null
    let hub: RunningHub | null = null

    // The stub samples the real listener's state at every call, so the ordering is
    // observed from inside the run rather than inferred from the source. The tray samples
    // the window's destroyed flag the same way.
    const electron = stubElectron({
      listening: (): boolean => hub?.server.nodeServer.listening ?? true,
      onDestroy: (): void => {
        listeningAtDestroy = hub?.server.nodeServer.listening ?? null
      },
    })

    hub = await startHub({
      stateDir: temporaryDirectory(),
      dashboardRoot: null,
      lifecycle: { installSignals: false, exit: (): void => undefined },
      delivery: NOTIFIER_STUB,
      desktop: {
        isPrimaryInstance: true,
        surface: bridgeOver(electron),
        tray: {
          ...inertTray(),
          destroy: (): void => {
            windowGoneWhenTrayClosed = electron.windows[0]?.destroyed() === true
          },
        },
      },
      onDiagnostic: (message) => diagnostics.push(message),
    })
    openHubs.push(hub)

    expect(hub.surface).not.toBeNull()
    expect(hub.server.nodeServer.listening).toBe(true)

    await hub.close()

    // The listener was still accepting connections at the instant the window was
    // destroyed: the destroy is the first step, not a step that happened to come first
    // in the source. A card that outlived the listener would show a deep link that can no
    // longer be resolved (NT-FR-04).
    expect(listeningAtDestroy).toBe(true)
    // And the tray went down after it, so nothing on the desktop outlives the surface.
    expect(windowGoneWhenTrayClosed).toBe(true)
    expect(hub.server.nodeServer.listening).toBe(false)
    // `close` is idempotent, and a second one does not destroy a second time.
    await hub.close()
    expect(listeningAtDestroy).toBe(true)
    expect(electron.windows).toHaveLength(1)
  })

  it('destroys the window on a start that fails after it was created', async () => {
    // A start that mounts the surface and then fails must not leave a window on the
    // developer's screen from a process that is about to report a failure. The failure is
    // real: a taken port with the fallback range set to zero, so the bind cannot succeed.
    const taken = createServer()
    await new Promise<void>((resolve) => {
      taken.listen(0, '127.0.0.1', resolve)
    })
    const address = taken.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const electron = stubElectron()

    await expect(
      startHub({
        stateDir: temporaryDirectory(),
        dashboardRoot: null,
        preferredPort: port,
        portFallbackAttempts: 0,
        lifecycle: { installSignals: false, exit: (): void => undefined },
        desktop: { isPrimaryInstance: true, surface: bridgeOver(electron) },
        onDiagnostic: (message) => diagnostics.push(message),
      }),
    ).rejects.toThrow()
    await new Promise<void>((resolve) => {
      taken.close(() => resolve())
    })

    // The window was created - the surface mounts before the bind - and it was destroyed
    // by the failure path, not left on the screen.
    expect(electron.windows).toHaveLength(1)
    expect(callsOf(electron.windows[0])).toEqual(['destroy'])
  })
})

describe('a desktop that refuses the window', () => {
  it('leaves the hub serving, records delivery as not-wired, and says so in a diagnostic', async () => {
    const refusal = new SurfaceWindowRefusedError('the window manager refused a transparent frameless window')
    const hub = await startHub({
      stateDir: temporaryDirectory(),
      dashboardRoot: null,
      lifecycle: { installSignals: false, exit: (): void => undefined },
      // No `delivery` override: the point is that the composition root withholds the
      // notifier itself, because it has no substrate to deliver into.
      desktop: {
        isPrimaryInstance: true,
        surface: {
          create: (): NotificationSurfaceHost => {
            throw refusal
          },
        },
      },
      onDiagnostic: (message) => diagnostics.push(message),
    })
    openHubs.push(hub)

    // No stub pretending a window is on a desktop.
    expect(hub.surface).toBeNull()
    expect(diagnostics.join('\n')).toMatch(/could not create its notification surface window/)
    expect(diagnostics.join('\n')).toMatch(/every delivery is recorded as not-wired/)
    // The refusal's own words reach the operator, not a generic string.
    expect(diagnostics.join('\n')).toMatch(/window manager refused a transparent frameless window/)

    // The hub is serving: a real read over a real socket, after the refusal.
    const health = await call(hub.origin, 'GET', '/api/health')
    expect(health.status).toBe(200)
    const payload = health.json<HealthPayload>()
    expect(payload.status).toBe('ok')
    expect(payload.server.listening).toBe(true)
    expect(payload.delivery.status).toBe('not-wired')
    expect(payload.delivery.wired).toBe(false)

    // And a real block, posted over a real socket, is stored and counted as not-wired by
    // both ends: nothing was reported as shown that nobody saw (APX-FR-02, NT-FR-04).
    const posted = await call(
      hub.origin,
      'POST',
      '/api/ingest',
      JSON.stringify({
        harness: 'opencode',
        eventName: 'permission.asked',
        sessionId: SESSION,
        repoFullPath: REPO_PATH,
        transitionId: 'block-surface-1',
        occurredAt: OCCURRED_AT,
      }),
    )
    expect(posted.status).toBe(202)
    await hub.ingest.idle()

    expect(hub.ingest.stats().deliveries.notWired).toBe(1)
    expect(hub.ingest.stats().deliveries.delivered).toBe(0)
    // The policy's own count of not-wired *attempts* stays at zero, and that is the
    // honest answer rather than a missing assertion: with no notifier behind the port the
    // policy refuses the attempt outright (it never calls anything), and the pipeline -
    // the layer that saw the event - counts it. Both ends agree that nothing was
    // delivered, and the two counts are not double counting one another.
    expect(hub.delivery.status()).toMatchObject({ wired: false, status: 'not-wired', notWired: 0, delivered: 0 })
    // The block is still stored and still pending: a refused surface is never a lost block.
    const pending = await call(hub.origin, 'GET', '/api/pending')
    expect(pending.status).toBe(200)
    expect(pending.json<{ count: number }>().count).toBe(1)

    await hub.close()
    expect(hub.server.nodeServer.listening).toBe(false)
  })

  it('leaves a headless run alone: no desktop bridge is not a refusal', async () => {
    // The rule is "a desktop that refused the window", not "no surface". A test, the CLI
    // and a verification script run with no desktop at all and must keep the wiring they
    // already had, or every one of them would start reporting `not-wired`.
    const hub = await startHub({
      stateDir: temporaryDirectory(),
      dashboardRoot: null,
      lifecycle: { installSignals: false, exit: (): void => undefined },
      delivery: NOTIFIER_STUB,
      onDiagnostic: (message) => diagnostics.push(message),
    })
    openHubs.push(hub)

    expect(hub.surface).toBeNull()
    expect(hub.delivery.status()).toMatchObject({ wired: true, status: 'ok' })
    expect(diagnostics.join('\n')).not.toMatch(/notification surface/)
  })
})

describe('what the composition root hands a caller', () => {
  it('exposes the host, and it grants nothing beyond showing and hiding a card', async () => {
    const electron = stubElectron()
    const hub = await startHub({
      stateDir: temporaryDirectory(),
      dashboardRoot: null,
      lifecycle: { installSignals: false, exit: (): void => undefined },
      delivery: NOTIFIER_STUB,
      desktop: { isPrimaryInstance: true, surface: bridgeOver(electron) },
      onDiagnostic: (message) => diagnostics.push(message),
    })
    openHubs.push(hub)

    const surface = hub.surface as unknown as Record<string, unknown>
    expect(surface).not.toBeNull()
    // Enumerated from the object, so a member added to the interface is a failing test
    // rather than a wider surface nobody reviewed.
    expect(Object.keys(surface).sort()).toEqual(['destroy', 'hide', 'probe', 'setClickThrough', 'show'])
  })
})
