// The card surface's channel: how a card model reaches a document running under
// `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`, and what the
// Electron bridge does with it (NT-FR-02, NT-FR-12, NT-FR-10, NT-FR-11, APX-FR-01,
// APX-CON-12, ADR-012).
//
//   npm test -- tests/notify/surface-channel.test.ts tests/notify/surface-host.test.ts
//
// THE EIGHT ACCEPTANCE CRITERIA OF NS-2, AND WHERE EACH IS PROVEN
//
//   1. "A test asserts the electron DesktopBridge supplies renderCard, and a run with it
//      reports delivery status wired with a real posted block counted as delivered."
//      `the electron desktop bridge supplies a card renderer`, below. `electronDesktopBridge`
//      is the real composition-root function, handed a *structural* Electron module, and
//      the result goes to the real `startHub` over a real loopback socket: a real
//      `needs-you` block is posted, and the answer is `wired`, `delivered: 1`, with the
//      card's `show` message recorded on the window. The counterpart - a runtime with no
//      `ipcMain` - is asserted too, because "wired" is only an honest word if the other
//      answer is still reachable.
//
//   2. "A test asserts the context bridge exposes exactly one global whose key set is
//      exactly remove and show."
//      `the context bridge exposes exactly one global`, below, twice: the bridge this
//      product builds is checked as an object, and the preload's own source is read for
//      its single `exposeInMainWorld` call and the key set of the object it hands over.
//      The second is the one that matters, because the preload is a single file that
//      cannot import this one - a sandboxed preload's `require` resolves `electron` and
//      nothing else, measured against Electron 44.4.5 - so its copy of the channel's
//      vocabulary is a copy, and a copy is only safe if something asserts it.
//
//   3. "A test asserts show and remove carry exactly a CardModel and a CardLifetimeCell,
//      and that the payload contains no path, session identifier, harness name or
//      conversation content."
//      `a show message carries exactly a model and a cell`, below, and the poisoned
//      payloads beside it. The positive half enumerates the key set at both levels and
//      checks the cell is the *table's own* cell rather than a copy; the negative half
//      walks a list of values that must be refused.
//
//   4. "A test asserts contextIsolation true, nodeIntegration false and sandbox true are
//      all still present after the change and that the options object is still frozen."
//      `the renderer is not widened to carry a card`, below, and the same three settings
//      in tests/notify/surface-host.test.ts's option-object section. It is here as well
//      because the channel is what a future editor would be tempted to widen them for.
//
//   5. "A test asserts no executeJavaScript and no webSecurity change exists anywhere
//      under src."
//      `nothing anywhere under src widens the renderer`, below: every TypeScript source
//      in the tree, read with its prose stripped.
//
//   6. "A test asserts NotificationSurfaceHost still exposes exactly probe, show, hide,
//      setClickThrough and destroy, and that the host interface was not widened."
//      `the host interface was not widened for the channel`, below, read from the
//      interface's own source rather than from a mounted host, plus the mounted host's
//      own key set through a real `startHub`. The channel reaches the window through an
//      *option* on the host, which is the whole point: a sixth method would have put a
//      card's delivery surface on the window contract.
//
//   7. "A test asserts a card rendered through the real channel carries role=status,
//      aria-live, an aria-label, a tabindex, data-urgency and data-lifetime, and no
//      inline style."
//      `a card rendered through the real channel`, below: the product's own
//      `createCardSurfaceBridge` and `listenForCardSurface` over a real document, the
//      real event the preload dispatches, the real message built by `cardChannelShow`, and
//      the real `createCardView`. jsdom applies no layout and no paint; what this proves
//      is the document, not a compositor.
//
//   8. "A test asserts a card that ends is removed through the channel and the host
//      window is hidden, so nothing occupies screen space."
//      `a card that ends is removed through the channel and the window is hidden`, below:
//      the real `createElectronCardChannel` over a real `createElectronSurfaceHost`, with
//      the clock injected so the fixed interval does not have to be waited out.
//
// AROUND THOSE EIGHT:
//   - the preload's copy of the channel's names is byte-identical to the real ones, and
//     the build compiles the `.cts` that makes it loadable at all;
//   - a message with an extra field, a tampered lifetime cell, a remote deep link or a
//     deep link with a second query parameter is refused, and the refusal quotes no value;
//   - the document's listener takes itself down when asked, and reports rather than
//     throws when a message is refused.
//
// WHAT IS NOT PROVEN HERE
// Nothing about a desktop. No Electron process is started by this suite and no window is
// displayed: the Electron half is a structural stub, so what is proven is every decision
// this product makes and not one thing about how any of the three desktops composites a
// transparent frameless window. The preload and the window options were separately driven
// against the real Electron 44.4.5 binary on the authoring machine (Ubuntu 24.04, X11 :1),
// and that run - not this file - is what stands behind the claim that a card crossed a
// real isolation boundary (NT-FR-03, APX-CON-06).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { electronDesktopBridge, startHub, type RunningHub } from '@/main/index'
import {
  CARD_CHANNEL_PAYLOAD_KEYS,
  CARD_CHANNEL_READY,
  CARD_CHANNEL_REMOVE,
  CARD_CHANNEL_SHOW,
  CARD_SURFACE_GLOBAL,
  CARD_SURFACE_KEYS,
  CardChannelPayloadError,
  assertContentFreeCardModel,
  createCardSurfaceBridge,
  isCardSurfaceBridge,
  listenForCardSurface,
  readCardChannelRemove,
  readCardChannelShow,
  type CardSurfaceSink,
} from '@/notify/surface/channel'
import {
  CARD_CHANNEL_READY_TIMEOUT_MS,
  SURFACE_WINDOW_OPTIONS,
  createElectronCardChannel,
  createElectronSurfaceHost,
  surfaceDocumentUrl,
  type BrowserWindowLike,
  type ScreenLike,
} from '@/notify/surface/electron-host'
import {
  CARD_PRELOAD_FILE_NAME,
  CARD_PRELOAD_FORMAT,
  CARD_PRELOAD_PATH,
  CARD_PRELOAD_SANDBOX_REQUIREMENT,
  CARD_PRELOAD_SOURCE_FILE,
  resolveCardPreloadPath,
} from '@/notify/surface/preload'
import {
  CARD_LIFETIME_ATTRIBUTE,
  CARD_ROOT_ATTRIBUTE,
  CARD_URGENCY_ATTRIBUTE,
  createCardView,
} from '@/notify/surface/card-view'
import { CARD_LIFETIMES, cardLifetimeFor, type CardLifetimeCell } from '@/notify/surface/lifetime'
import type { CardModel } from '@/notify/surface/card'
import { readModuleImports, readModuleWithoutProse, repositoryPath, sourceFilesUnderSrc } from '../helpers/read-module'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_PATH = '/home/dev/Projects/agent-ping'
const SESSION = 'ses_channel_01'
const OCCURRED_AT = '2026-09-26T09:00:00.000Z'
const ORIGIN = 'http://127.0.0.1:43117'
/** The display the pre-flight measured, including the 32px top inset. */
const WORK_AREA = { x: 0, y: 32, width: 1920, height: 1048 }

const temporaryDirectories: string[] = []
const openHubs: RunningHub[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent-ping-channel-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  for (const hub of openHubs.splice(0)) await hub.close().catch(() => undefined)
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A content-free model, and the cell it would be shown under. */
function model(overrides: Partial<CardModel> = {}): CardModel {
  return {
    title: 'agent-ping',
    body: 'A tool permission is waiting on a decision.',
    urgency: 'critical',
    pendingCount: 1,
    deepLink: `${ORIGIN}/?session=${SESSION}`,
    ...overrides,
  }
}

/** One real `window`, from jsdom, typed as the DOM this build already declares. */
async function browserWindow(html: string): Promise<Window & typeof globalThis> {
  // Through a specifier the compiler cannot fold, for the reason src/main/index.ts loads
  // `electron` the same way: `jsdom` ships no type declarations, and a literal specifier
  // would make this test file unable to typecheck over a missing ambient module.
  const specifier = 'jsdom'
  const jsdom = (await import(specifier)) as unknown as {
    JSDOM: new (markup: string) => { window: unknown }
  }
  // `Window & typeof globalThis`, because the DOM's own `CustomEvent` constructor is what
  // the preload dispatches and the page listens for, and it is declared as a global rather
  // than as a property of `Window`.
  return new jsdom.JSDOM(html).window as unknown as Window & typeof globalThis
}

/** One call a stub window was asked to make. */
interface Recorded {
  readonly call: string
  readonly channel?: string
  readonly payload?: unknown
}

interface StubWindow {
  readonly window: BrowserWindowLike
  readonly calls: Recorded[]
  /** The messages sent on the window's own channel, in order. */
  readonly sent: Recorded[]
  destroyed(): boolean
}

/** A `BrowserWindow` that records instead of drawing. */
function stubWindow(onCreate?: (window: BrowserWindowLike) => void): StubWindow {
  const calls: Recorded[] = []
  const sent: Recorded[] = []
  let gone = false
  const note = (call: string, extra: Partial<Recorded> = {}): void => {
    calls.push({ call, ...extra })
  }
  const window: BrowserWindowLike = {
    webContents: {
      send: (channel, ...args): void => {
        const record: Recorded = { call: 'send', channel, payload: args[0] }
        calls.push(record)
        sent.push(record)
      },
      isDestroyed: (): boolean => gone,
    },
    loadURL: async (): Promise<void> => {
      note('loadURL')
    },
    showInactive: (): void => {
      note('showInactive')
    },
    hide: (): void => {
      note('hide')
    },
    isDestroyed: (): boolean => gone,
    destroy: (): void => {
      note('destroy')
      gone = true
    },
    setBounds: (): void => {
      note('setBounds')
    },
    setIgnoreMouseEvents: (): void => {
      note('setIgnoreMouseEvents')
    },
  }
  onCreate?.(window)
  return { window, calls, sent, destroyed: (): boolean => gone }
}

/** A structural `ipcMain` whose readiness listener is fired by `announce()`. */
function stubIpcMain(): {
  readonly ipcMain: { on(channel: string, listener: (event: unknown) => void): unknown }
  readonly channels: string[]
  announce(): void
} {
  const channels: string[] = []
  const listeners: Array<() => void> = []
  return {
    ipcMain: {
      on: (channel, listener): unknown => {
        channels.push(channel)
        if (channel === CARD_CHANNEL_READY) listeners.push(() => listener({}))
        return undefined
      },
    },
    channels,
    announce: (): void => {
      for (const listener of listeners.splice(0)) listener()
    },
  }
}

/** A scheduler a test drives by hand, so a fixed interval need not be waited out. */
function manualScheduler(): {
  readonly scheduler: {
    schedule(delayMs: number, onElapsed: () => void): { cancel(): void }
  }
  readonly delays: number[]
  elapse(): void
  readonly armed: number
} {
  const delays: number[] = []
  const pending: Array<() => void> = []
  return {
    scheduler: {
      schedule: (delayMs, onElapsed) => {
        delays.push(delayMs)
        let live = true
        pending.push(() => {
          if (!live) return
          live = false
          onElapsed()
        })
        return {
          cancel: (): void => {
            live = false
          },
        }
      },
    },
    delays,
    get armed(): number {
      return pending.filter((entry) => entry !== undefined).length
    },
    elapse: (): void => {
      for (const entry of pending.splice(0)) entry()
    },
  }
}

/** One request over a real loopback socket. */
function call(
  origin: string,
  method: string,
  pathname: string,
  body?: string,
): Promise<{ status: number; json<T>(): T }> {
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
          resolve({
            status: response.statusCode ?? 0,
            json: <T,>(): T => JSON.parse(text) as T,
          })
        })
      },
    )
    outgoing.on('error', reject)
    if (body === undefined) outgoing.end()
    else outgoing.end(body)
  })
}

const NEEDS_YOU_BLOCK = JSON.stringify({
  harness: 'opencode',
  eventName: 'permission.asked',
  sessionId: SESSION,
  repoFullPath: REPO_PATH,
  transitionId: 'block-channel-1',
  occurredAt: OCCURRED_AT,
})

/** A structural Electron module: enough for the real desktop bridge, and nothing more. */
function stubElectron(options: { readonly withIpcMain?: boolean } = {}): {
  readonly electron: Parameters<typeof electronDesktopBridge>[0]
  readonly windows: StubWindow[]
  readonly ipcChannels: string[]
  announce(): void
} {
  const windows: StubWindow[] = []
  const ipc: ReturnType<typeof stubIpcMain> | null =
    options.withIpcMain === false ? null : stubIpcMain()
  function announce(): void {
    ipc?.announce()
  }
  class BrowserWindow {
    readonly record: StubWindow
    constructor(options: unknown) {
      void options
      this.record = stubWindow()
      windows.push(this.record)
      // A real preload announces itself as the document loads, which happens before
      // anything can ask for a card. Modelling that here is what makes the readiness
      // wait in the real presenter a safety net rather than the normal path.
      announce()
    }
    get webContents(): BrowserWindowLike['webContents'] {
      return this.record.window.webContents
    }
    loadURL(url: string): Promise<void> {
      return this.record.window.loadURL(url)
    }
    showInactive(): void {
      this.record.window.showInactive()
    }
    hide(): void {
      this.record.window.hide()
    }
    isDestroyed(): boolean {
      return this.record.destroyed()
    }
    destroy(): void {
      this.record.window.destroy()
    }
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
      this.record.window.setBounds(bounds)
    }
    setIgnoreMouseEvents(ignore: boolean, ignoreOptions?: { forward?: boolean }): void {
      this.record.window.setIgnoreMouseEvents(ignore, ignoreOptions)
    }
  }
  // A tray that accepts what the tray module hands it and does nothing else, so this
  // suite can mount the real desktop bridge without the tray becoming the subject.
  class TrayStub {
    setImage(): void {}
    setToolTip(): void {}
    setContextMenu(): void {}
    popUpContextMenu(): void {}
    on(): void {}
    destroy(): void {}
  }
  const electron = {
    BrowserWindow,
    screen: { getPrimaryDisplay: (): { workArea: typeof WORK_AREA } => ({ workArea: WORK_AREA }) },
    nativeImage: { createFromBitmap: (): unknown => ({}) },
    Menu: { buildFromTemplate: (): unknown => ({}) },
    Tray: TrayStub,
    ...(ipc === null ? {} : { ipcMain: ipc.ipcMain }),
  }
  return {
    electron: electron as unknown as Parameters<typeof electronDesktopBridge>[0],
    windows,
    ipcChannels: ipc?.channels ?? [],
    announce,
  }
}

// ---------------------------------------------------------------------------
// Criterion 1: the shipped bridge supplies a renderer, and a block becomes a card
// ---------------------------------------------------------------------------

describe('the electron desktop bridge supplies a card renderer', () => {
  it('reports a run with it as wired, and counts a real posted block as delivered', async () => {
    const stub = stubElectron()
    const hub = await startHub({
      stateDir: temporaryDirectory(),
      dashboardRoot: null,
      lifecycle: { installSignals: false, exit: (): void => undefined },
      // No `delivery` override, and that is the point: the notifier is the surface's
      // own, resolved inside `startHub` from the bridge this test just built. A test that
      // passed a notifier would be testing the policy rather than the wiring.
      desktop: { isPrimaryInstance: true, ...electronDesktopBridge(stub.electron) },
    })
    openHubs.push(hub)

    expect(hub.delivery.status()).toMatchObject({ wired: true, status: 'ok' })
    expect(hub.notifier.supported).toBe(true)

    // A real needs-you block, posted over a real socket.
    const posted = await call(hub.origin, 'POST', '/api/ingest', NEEDS_YOU_BLOCK)
    expect(posted.status).toBe(202)
    await hub.ingest.idle()

    // The delivery the notifier made is a `delivered` one, counted by both ends.
    expect(hub.delivery.status()).toMatchObject({ wired: true, status: 'ok', delivered: 1, failed: 0 })
    expect(hub.ingest.stats().deliveries.delivered).toBe(1)
    expect(hub.ingest.stats().deliveries.notWired).toBe(0)
    // And the card document was reached over the loopback hub, not out of a bundle.
    expect(stub.windows).toHaveLength(1)
    expect(stub.windows[0]?.calls.map((entry) => entry.call)).toContain('loadURL')
    // And the model crossed the channel as the one message that carries one.
    const shows = stub.windows[0]?.sent.filter((entry) => entry.channel === CARD_CHANNEL_SHOW) ?? []
    expect(shows).toHaveLength(1)
    expect(Object.keys(shows[0]?.payload as object).sort()).toEqual(['cell', 'model'])
  })

  it('announces readiness on the one channel that carries no card', async () => {
    const stub = stubElectron()
    // The listener is registered when the bridge is built, which is before the window
    // exists - a listener added on the first card would arrive after the announcement.
    electronDesktopBridge(stub.electron)
    expect(stub.ipcChannels).toEqual([CARD_CHANNEL_READY])
  })

  it('leaves a run whose runtime has no ipcMain not-wired, with a diagnostic', async () => {
    // The other half of "wired" being an honest word: a runtime that cannot carry a model
    // reports the product's existing answer rather than a card it cannot deliver, and
    // nothing about a window changes (APX-FR-02).
    const stub = stubElectron({ withIpcMain: false })
    const hub = await startHub({
      stateDir: temporaryDirectory(),
      dashboardRoot: null,
      lifecycle: { installSignals: false, exit: (): void => undefined },
      desktop: { isPrimaryInstance: true, ...electronDesktopBridge(stub.electron) },
    })
    openHubs.push(hub)

    expect(hub.notifier.supported).toBe(false)
    expect(hub.notifier.reason).toBe('no-card-renderer')
    expect(hub.delivery.status()).toMatchObject({ wired: false, status: 'not-wired' })
    const posted = await call(hub.origin, 'POST', '/api/ingest', NEEDS_YOU_BLOCK)
    expect(posted.status).toBe(202)
    await hub.ingest.idle()
    expect(hub.ingest.stats().deliveries.notWired).toBe(1)
    expect(hub.ingest.stats().deliveries.delivered).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Criterion 2: one global, two calls
// ---------------------------------------------------------------------------

describe('the context bridge exposes exactly one global', () => {
  it('carries exactly remove and show, and nothing else', () => {
    const shown: string[] = []
    const bridge = createCardSurfaceBridge({
      show: (): void => {
        shown.push('show')
      },
      remove: (): void => {
        shown.push('remove')
      },
    })
    expect(Object.keys(bridge).sort()).toEqual([...CARD_SURFACE_KEYS].sort())
    expect(isCardSurfaceBridge(bridge)).toBe(true)
    bridge.show(model(), cardLifetimeFor('needs-you'))
    bridge.remove('acknowledged')
    expect(shown).toEqual(['show', 'remove'])
  })

  it('exposes one global, once, in the preload, with that key set', () => {
    // Read from the preload's own source, because the preload is the only file that
    // decides what the document gets: a sandboxed preload's `require` resolves `electron`
    // and nothing else (measured against Electron 44.4.5 - `require('./sibling')` fails
    // with `module not found`), so it cannot import this product's channel and the
    // surface it hands over can only be checked by reading it.
    const source = readModuleWithoutProse(CARD_PRELOAD_SOURCE_FILE)
    const exposures = [...source.matchAll(/exposeInMainWorld\(([^,]+),\s*(\w+)\)/g)]
    expect(exposures).toHaveLength(1)
    const [, keyExpression, handed] = exposures[0] ?? []
    expect(keyExpression).toBe('CARD_SURFACE_GLOBAL')
    expect(handed).toBe('bridge')
    // The object handed over is the two-call literal, and nothing else is exposed.
    expect(bridgeKeysOf(source).sort()).toEqual([...CARD_SURFACE_KEYS].sort())
    expect(source).not.toMatch(/exposeInIsolatedWorld/)
  })

  it('keeps the preload copy of the channel names byte-identical to the real ones', () => {
    // The copy is the price of the platform, so it is asserted rather than trusted: five
    // names, read out of the preload's own source and compared to the exported constants.
    const source = readModuleImports(CARD_PRELOAD_SOURCE_FILE)
    const literal = (name: string): string | undefined =>
      new RegExp(`const ${name} = '([^']*)'`).exec(source)?.[1]
    expect(literal('CARD_SURFACE_GLOBAL')).toBe(CARD_SURFACE_GLOBAL)
    expect(literal('CARD_CHANNEL_SHOW')).toBe(CARD_CHANNEL_SHOW)
    expect(literal('CARD_CHANNEL_REMOVE')).toBe(CARD_CHANNEL_REMOVE)
    expect(literal('CARD_CHANNEL_READY')).toBe(CARD_CHANNEL_READY)
  })

  it('is compiled as CommonJS, because a sandboxed preload has no ESM context', () => {
    // A preload in a renderer with `sandbox: true` is parsed by Chromium as a plain
    // script. Both were measured against Electron 44.4.5: a `.mjs` preload and a `.js`
    // preload using `import` both fail with `SyntaxError: Cannot use import statement
    // outside a module`. This repository's `moduleDetection: "force"` would append an
    // `export {};` marker to any `.ts` it compiles - the exact syntax that fails - so the
    // source is `.cts` and the build has to say so. The extension, not a convention.
    const build = readFileText('tsconfig.build.json')
    expect(build).toMatch(/"src\/notify\/\*\*\/\*\.cts"/)
    expect(build).toMatch(/"module"\s*:\s*"NodeNext"/)
    // And nothing at run time: the only imports in the file are type-only, so the emitted
    // CommonJS keeps its single `require('electron')` and gains no specifier of its own.
    // A value import would be erased by the bundler that could have resolved it, and would
    // be a syntax error in the one context that has to run it.
    const imports = [...readModuleWithoutProse(CARD_PRELOAD_SOURCE_FILE).matchAll(/^import .*$/gm)].map(
      (match) => match[0].trim(),
    )
    expect(imports.length).toBeGreaterThan(0)
    for (const statement of imports) expect(statement).toMatch(/^import type /)
    expect(readModuleImports(CARD_PRELOAD_SOURCE_FILE)).toMatch(
      /import type \{ CardModel \} from '\.\/card\.js'/,
    )
    // And the two halves agree: the address module names the file this source compiles to,
    // and declares the format the renderer can parse. Read from the address module rather
    // than repeated, so a rename cannot leave the two disagreeing (NT-FR-12).
    expect(CARD_PRELOAD_SOURCE_FILE).toBe('src/notify/surface/preload.cts')
    expect(CARD_PRELOAD_FILE_NAME).toBe('preload.cjs')
    expect(CARD_PRELOAD_FORMAT).toBe('commonjs')
    expect(CARD_PRELOAD_PATH.endsWith(CARD_PRELOAD_FILE_NAME)).toBe(true)
    // And the operator-facing sentence, which is the one thing a person would be told if a
    // card never arrived. Asserted for the words a diagnosis is made of, because a comment
    // is not something an operator can be given.
    expect(CARD_PRELOAD_SANDBOX_REQUIREMENT).toMatch(/sandbox: true/)
    expect(CARD_PRELOAD_SANDBOX_REQUIREMENT).toMatch(/SyntaxError/)
    expect(CARD_PRELOAD_SANDBOX_REQUIREMENT).toMatch(/NT-FR-12/)
    // The address module resolves beside itself, and falls back to the bare emitted name
    // rather than to a path into a test server. Asserted from both a real `file:` URL and
    // a dev-server one, so neither branch is untested (src/notify/surface/preload.ts).
    expect(resolveCardPreloadPath(`file:///opt/agent-ping/dist/main/notify/surface/preload.js`)).toBe(
      `/opt/agent-ping/dist/main/notify/surface/${CARD_PRELOAD_FILE_NAME}`,
    )
    expect(resolveCardPreloadPath('http://localhost:5173/src/notify/surface/preload.ts')).toBe(
      `./${CARD_PRELOAD_FILE_NAME}`,
    )
  })
})

/** The key set of the `bridge` object literal in a preloaded source, read from the file. */
function bridgeKeysOf(source: string): string[] {
  const start = source.indexOf('const bridge = {')
  expect(start).toBeGreaterThan(-1)
  const body = source.slice(start, source.indexOf('\n}', start))
  return [...body.matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1] ?? '')
}

// ---------------------------------------------------------------------------
// Criterion 3: what the channel carries
// ---------------------------------------------------------------------------

describe('a show message carries exactly a model and a cell', () => {
  const cell = cardLifetimeFor('needs-you')

  it('has exactly the two top-level keys, the five model fields and the seven cell fields', () => {
    const payload = { model: model(), cell }
    const built = readCardChannelShow(payload)

    expect(Object.keys(built).sort()).toEqual([...CARD_CHANNEL_PAYLOAD_KEYS.show].sort())
    expect(Object.keys(built.model).sort()).toEqual([
      'body',
      'deepLink',
      'pendingCount',
      'title',
      'urgency',
    ])
    expect(Object.keys(built.cell).sort()).toEqual([
      'class',
      'ends',
      'expiresInMs',
      'lifetime',
      'reason',
      'rendered',
      'repeat',
    ])
    // The cell is the table's own, not a copy that arrived: nothing on the wire can
    // change how long a card lives, what can end it, or the no-repeat rule (NT-FR-08).
    expect(built.cell).toBe(CARD_LIFETIMES['needs-you'])
  })

  it('is frozen, so nothing downstream can edit a card after the guard saw it', () => {
    const built = readCardChannelShow({ model: model(), cell })
    expect(Object.isFrozen(built)).toBe(true)
    expect(Object.isFrozen(built.model)).toBe(true)
  })

  it('carries no path, no harness name and no conversation content', () => {
    // The *validated* payload, not the object that was handed in: what crosses is what
    // the guard produced, so that is what the absence is asserted about.
    const wire = JSON.stringify(readCardChannelShow({ model: model(), cell }))
    // A repository path, a home directory, a harness name, a diff, a prompt, a transcript.
    for (const forbidden of [
      '/home/',
      '/Projects/',
      'opencode',
      'permission.asked',
      'diff',
      'prompt',
      'transcript',
      'toolOutput',
      'stdout',
    ]) {
      expect(wire, `the channel payload must not carry ${forbidden}`).not.toContain(forbidden)
    }
    // The session identifier exists in exactly one place: the `session` parameter of a
    // loopback URL. Counted rather than asserted by eye, because "exactly one" is the claim.
    const sessionOccurrences = wire.match(/ses_[A-Za-z0-9_]+/g) ?? []
    expect(sessionOccurrences).toEqual([SESSION])
    expect(readCardChannelShow({ model: model(), cell }).model.deepLink).toBe(`${ORIGIN}/?session=${SESSION}`)
    // And nothing anywhere in the payload is a filesystem path.
    expect(wire).not.toMatch(/\/[\w.-]+\//)
  })

  it('refuses a model with any field this product did not declare', () => {
    // The structural half of "no session identifier, no harness name, no content": there
    // is no field for one of those to travel in, whatever builds the model.
    for (const extra of ['sessionId', 'harness', 'repoFullPath', 'content', 'diff', 'transcript', 'message']) {
      const poisoned = { ...model(), [extra]: 'anything' }
      expect(() => readCardChannelShow({ model: poisoned, cell }), extra).toThrow(CardChannelPayloadError)
    }
  })

  it('refuses a title or a body that is a path, a second line, or blank', () => {
    expect(() => assertContentFreeCardModel(model({ title: '/home/dev/Projects/agent-ping' }))).toThrow(
      /repository path/,
    )
    expect(() => assertContentFreeCardModel(model({ body: 'line one\nline two' }))).toThrow(/no usable `body`/)
    expect(() => assertContentFreeCardModel(model({ title: '   ' }))).toThrow(/blank/)
  })

  it('refuses a count that is not a count', () => {
    for (const count of [Number.NaN, -1, 1.5, '1' as unknown as number]) {
      expect(() => assertContentFreeCardModel(model({ pendingCount: count })), String(count)).toThrow(
        CardChannelPayloadError,
      )
    }
  })

  it('refuses a deep link that leaves this machine or carries a second parameter', () => {
    // A remote link is an outbound call on a developer's screen (APX-CON-12), and a
    // parameter a caller appended is content this product did not choose to put there.
    expect(() => assertContentFreeCardModel(model({ deepLink: 'https://example.com/?session=x' }))).toThrow(
      /loopback hub/,
    )
    expect(() => assertContentFreeCardModel(model({ deepLink: `${ORIGIN}/?session=x&q=secret` }))).toThrow(
      /parameter/,
    )
    expect(() => assertContentFreeCardModel(model({ deepLink: 'not a url' }))).toThrow(/loopback hub/)
    // Null is allowed: it is the value before the socket is bound.
    expect(assertContentFreeCardModel(model({ deepLink: null })).deepLink).toBeNull()
  })

  it('refuses a lifetime cell that is not the table own, so a message cannot retime a card', () => {
    for (const tampered of [
      { ...cell, expiresInMs: 600_000 },
      { ...cell, ends: [...cell.ends, 'expired'] },
      { ...cell, repeat: 'always' },
      { ...cell, lifetime: 'expires' },
      { ...cell, reason: 'escalate' },
    ]) {
      expect(() => readCardChannelShow({ model: model(), cell: tampered })).toThrow(/not the product's own cell/)
    }
    // A cell for a class the table does not carry has no lookup and is refused.
    expect(() =>
      readCardChannelShow({ model: model(), cell: { ...cell, class: 'escalated' } }),
    ).toThrow(CardChannelPayloadError)
  })

  it('refuses a message that carries anything beside the model and the cell', () => {
    for (const extra of ['end', 'reason', 'detail', 'cell ']) {
      expect(
        () => readCardChannelShow({ model: model(), cell, [extra]: 'anything' }),
        extra,
      ).toThrow(CardChannelPayloadError)
    }
    expect(() => readCardChannelShow({ model: model() })).toThrow(CardChannelPayloadError)
    expect(() => readCardChannelShow({ model: model(), cell, extra: 1 })).toThrow(/other than cell and model/)
  })

  it('quotes no value in a refusal, because a refused value is still a value', () => {
    // The detail that reaches a diagnostic, a health payload and a ledger.
    try {
      readCardChannelShow({ model: model({ title: '/home/dev/secret/repo' }), cell, sessionId: 'ses_secret_01' })
      throw new Error('the guard was supposed to refuse this payload')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      expect(cause).toBeInstanceOf(CardChannelPayloadError)
      expect(message).not.toContain('/home/dev/secret/repo')
      expect(message).not.toContain('ses_secret_01')
      expect(message).toMatch(/refused a payload/)
    }
  })
})

describe('a remove message carries exactly a named end', () => {
  it('names one of the ends this product has, and nothing else', () => {
    const built = readCardChannelRemove({ end: 'acknowledged' })
    expect(Object.keys(built)).toEqual([...CARD_CHANNEL_PAYLOAD_KEYS.remove])
    expect(Object.isFrozen(built)).toBe(true)
  })

  it('refuses an end nobody declared, and a message that carries more', () => {
    for (const end of ['dismissed', 'snoozed', '', 'EXPIRED', 1]) {
      expect(() => readCardChannelRemove({ end }), String(end)).toThrow(CardChannelPayloadError)
    }
    expect(() => readCardChannelRemove({ end: 'expired', reason: 'because' })).toThrow(CardChannelPayloadError)
    expect(() => readCardChannelRemove(null)).toThrow(/was not an object/)
  })
})

// ---------------------------------------------------------------------------
// Criteria 4, 5 and 6: nothing was widened
// ---------------------------------------------------------------------------

describe('the renderer is not widened to carry a card', () => {
  it('keeps contextIsolation true, nodeIntegration false and sandbox true, frozen', () => {
    const webPreferences = SURFACE_WINDOW_OPTIONS['webPreferences'] as Record<string, unknown>
    expect(webPreferences['contextIsolation']).toBe(true)
    expect(webPreferences['nodeIntegration']).toBe(false)
    expect(webPreferences['sandbox']).toBe(true)
    expect(Object.isFrozen(SURFACE_WINDOW_OPTIONS)).toBe(true)
    expect(Object.isFrozen(SURFACE_WINDOW_OPTIONS['webPreferences'])).toBe(true)
    // The one key the channel needed, and the only one.
    expect(Object.keys(webPreferences).sort()).toEqual([
      'contextIsolation',
      'nodeIntegration',
      'preload',
      'sandbox',
    ])
    expect(webPreferences['preload']).toBe(CARD_PRELOAD_PATH)
  })

  it('widens nothing else either: no webSecurity, no nodeIntegration-on, no extra window', () => {
    const webPreferences = SURFACE_WINDOW_OPTIONS['webPreferences'] as Record<string, unknown>
    expect(webPreferences['webSecurity']).toBeUndefined()
    expect(webPreferences['webviewTag']).toBeUndefined()
    expect(webPreferences['nodeIntegrationInWorker']).toBeUndefined()
    expect(SURFACE_WINDOW_OPTIONS['enableRemoteModule']).toBeUndefined()
  })
})

describe('nothing anywhere under src widens the renderer', () => {
  it('contains no executeJavaScript and no webSecurity change, in any file', () => {
    // The three shapes that would have carried a card without a preload, and the two that
    // would have widened the renderer to make the preload unnecessary. One of them -
    // `webContents.executeJavaScript` - injects code into the document and needs no
    // boundary at all, which is exactly why it is not used; the other two trade the
    // isolation this product's whole claim rests on for a convenience it does not need.
    const files = sourceFilesUnderSrc()
    expect(files.length).toBeGreaterThan(20)
    for (const file of files) {
      const source = readModuleWithoutProse(file)
      for (const forbidden of ['executeJavaScript', 'webSecurity', 'enableRemoteModule', 'webviewTag']) {
        expect(source.includes(forbidden), `${file} must not contain ${forbidden}`).toBe(false)
      }
    }
  })
})

describe('the host interface was not widened for the channel', () => {
  it('still declares exactly probe, show, hide, setClickThrough and destroy', () => {
    // Read from the interface's own source rather than from a mounted host, so a member
    // that no implementation happens to satisfy still fails here.
    const source = readModuleWithoutProse('src/notify/surface/host.ts')
    const start = source.indexOf('export interface NotificationSurfaceHost {')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n}', start))
    expect([...body.matchAll(/^\s{2}(\w+)\(/gm)].map((match) => match[1])).toEqual([
      'probe',
      'show',
      'hide',
      'setClickThrough',
      'destroy',
    ])
    // The channel reaches the window through an *option* on the host's constructor, not
    // through a sixth call on the host it returns.
    const host = readModuleWithoutProse('src/notify/surface/electron-host.ts')
    expect(host).toMatch(/readonly onWindowCreated\?: \(window: BrowserWindowLike\) => void/)
  })

  it('hands a real host exactly those five operations, through a real startHub', async () => {
    const stub = stubElectron()
    const hub = await startHub({
      stateDir: temporaryDirectory(),
      dashboardRoot: null,
      lifecycle: { installSignals: false, exit: (): void => undefined },
      delivery: { notifier: (): Promise<void> => Promise.resolve() },
      desktop: { isPrimaryInstance: true, ...electronDesktopBridge(stub.electron) },
    })
    openHubs.push(hub)

    const surface = hub.surface as unknown as Record<string, unknown>
    expect(Object.keys(surface).sort()).toEqual(['destroy', 'hide', 'probe', 'setClickThrough', 'show'])
  })
})

// ---------------------------------------------------------------------------
// Criterion 7: a real card, rendered through the real channel
// ---------------------------------------------------------------------------

describe('a card rendered through the real channel', () => {
  it('carries role=status, aria-live, an accessible name, a tabindex, its urgency and its lifetime', async () => {
    // The whole path, with nothing stubbed except the two things the platform owns: the
    // real bridge, the real document listener, the real event name the preload
    // dispatches, the real message, the real `createCardView`, and a real DOM.
    const window = await browserWindow('<!doctype html><div data-card-surface></div>')
    const document = window.document
    const parent = document.querySelector('[data-card-surface]') as unknown as Parameters<
      typeof createCardView
    >[0]['parent']
    const sink = createCardView({ parent, document: document as unknown as Parameters<typeof createCardView>[0]['document'] })
    const stop = listenForCardSurface(sink, { target: window })

    // What `preload.cts` does on receiving a `show` message: hand it to the document as
    // the event the document listens for, carrying exactly the model and the cell.
    const cell = cardLifetimeFor('needs-you')
    window.dispatchEvent(
      new window.CustomEvent(CARD_CHANNEL_SHOW, {
        detail: { model: model(), cell },
      }),
    )

    const card = document.querySelector(`[${CARD_ROOT_ATTRIBUTE}]`)
    expect(card).not.toBeNull()
    if (card === null) return
    expect(card.getAttribute('role')).toBe('status')
    expect(card.getAttribute('aria-live')).toBe('assertive')
    expect(card.getAttribute('aria-label')).toBe('Needs you: agent-ping. A tool permission is waiting on a decision.')
    expect(card.getAttribute('tabindex')).toBe('0')
    expect(card.getAttribute(CARD_URGENCY_ATTRIBUTE)).toBe('critical')
    expect(card.getAttribute(CARD_LIFETIME_ATTRIBUTE)).toBe('until-resolved')
    // The two lines, and nothing else: no count, no path, no identifier as text.
    expect(card.textContent).toBe('!Needs youagent-pingA tool permission is waiting on a decision.')
    expect(card.textContent).not.toContain(REPO_PATH)
    expect(card.textContent).not.toContain(SESSION)

    // A removal arrives through the same channel and takes the card out of the document.
    window.dispatchEvent(new window.CustomEvent(CARD_CHANNEL_REMOVE, { detail: { end: 'acknowledged' } }))
    expect(document.querySelector(`[${CARD_ROOT_ATTRIBUTE}]`)).toBeNull()
    stop()
  })

  it('writes no inline style, in the rendered card or in the code that renders it', () => {
    const document = readModuleWithoutProse('src/notify/surface/card-view.ts')
    expect(document).not.toMatch(/\.style\./)
    expect(document).not.toMatch(/cssText/)
    expect(document).not.toMatch(/setProperty\(/)
    // The channel and the preload write no markup and no style either, so the pair of
    // them is what a strict `style-src 'self'` card document has to live with.
    for (const file of ['src/notify/surface/channel.ts', CARD_PRELOAD_SOURCE_FILE]) {
      const source = readModuleWithoutProse(file)
      expect(source, file).not.toMatch(/\.style\./)
      expect(source, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/)
    }
  })

  it('reports a refused message instead of throwing into the document', async () => {
    const window = await browserWindow('<!doctype html><div data-card-surface></div>')
    const document = window.document
    const diagnostics: string[] = []
    const sink: CardSurfaceSink = {
      show: (): void => {
        throw new Error('the sink must not be reached for a refused message')
      },
      remove: (): void => {
        throw new Error('the sink must not be reached for a refused message')
      },
    }
    const stop = listenForCardSurface(sink, { target: window, onDiagnostic: (m) => diagnostics.push(m) })

    // Three refusals, three diagnostics, and an exception thrown *at the listener* would
    // be an unhandled error in a document nobody is watching.
    window.dispatchEvent(new window.CustomEvent(CARD_CHANNEL_SHOW, { detail: { model: model() } }))
    window.dispatchEvent(
      new window.CustomEvent(CARD_CHANNEL_SHOW, {
        detail: { model: model({ title: '/home/dev/x/y' }), cell: cardLifetimeFor('needs-you') },
      }),
    )
    window.dispatchEvent(new window.CustomEvent(CARD_CHANNEL_REMOVE, { detail: { end: 'nope' } }))

    expect(diagnostics).toHaveLength(3)
    expect(diagnostics.join('\n')).toMatch(/refused a message and nothing was rendered/)
    expect(diagnostics.join('\n')).not.toContain('/home/dev/x/y')
    expect(document.querySelector('[data-card-surface]')?.childElementCount).toBe(0)
    stop()
  })

  it('stops listening when it is taken down', async () => {
    const window = await browserWindow('<!doctype html><div data-card-surface></div>')
    const seen: string[] = []
    const stop = listenForCardSurface(
      {
        show: (): void => {
          seen.push('show')
        },
        remove: (): void => {
          seen.push('remove')
        },
      },
      { target: window },
    )
    window.dispatchEvent(new window.CustomEvent(CARD_CHANNEL_SHOW, { detail: { model: model(), cell: cardLifetimeFor('needs-you') } }))
    expect(seen).toEqual(['show'])
    stop()
    window.dispatchEvent(new window.CustomEvent(CARD_CHANNEL_REMOVE, { detail: { end: 'expired' } }))
    // A listener left on a window that is going away is a closure this product can no
    // longer account for (APX-FR-02).
    expect(seen).toEqual(['show'])
  })

  it('is a no-op where there is no event target, rather than a failure the delivery path can see', () => {
    // The document's half running in the Node-hosted main process must not throw: this
    // function is the document's, and the document's half running where there is no
    // document is not a fault anybody can act on.
    const stop = listenForCardSurface({ show: (): void => {}, remove: (): void => {} })
    expect(typeof stop).toBe('function')
    expect(() => stop()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Criterion 8: a card that ends leaves the screen
// ---------------------------------------------------------------------------

describe('a card that ends is removed through the channel and the window is hidden', () => {
  /** A real host, a real window, and the real channel over both. */
  async function surfaceAndChannel(
    options: { readonly cell: CardLifetimeCell; finished?: boolean },
  ): Promise<{
    readonly clock: ReturnType<typeof manualScheduler>
    readonly record: StubWindow
    readonly hideCalls: () => number
    present(): Promise<void>
  }> {
    const record = stubWindow()
    // A real class rather than a cast, because the host does `new options.BrowserWindow(...)`
    // and a cast that is not constructible fails in a way that has nothing to do with the
    // channel.
    class StubWindowClass implements BrowserWindowLike {
      constructor(options: unknown) {
        void options
      }
      get webContents(): BrowserWindowLike['webContents'] {
        return record.window.webContents
      }
      loadURL(url: string): Promise<void> {
        return record.window.loadURL(url)
      }
      showInactive(): void {
        record.window.showInactive()
      }
      hide(): void {
        record.window.hide()
      }
      isDestroyed(): boolean {
        return record.window.isDestroyed()
      }
      destroy(): void {
        record.window.destroy()
      }
      setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
        record.window.setBounds(bounds)
      }
      setIgnoreMouseEvents(ignore: boolean, ignoreOptions?: { forward?: boolean }): void {
        record.window.setIgnoreMouseEvents(ignore, ignoreOptions)
      }
    }
    const host = createElectronSurfaceHost({
      BrowserWindow: StubWindowClass,
      screen: { getPrimaryDisplay: (): { workArea: typeof WORK_AREA } => ({ workArea: WORK_AREA }) } as ScreenLike,
      documentUrl: (): string => surfaceDocumentUrl(ORIGIN),
    })
    const clock = manualScheduler()
    const ipc = stubIpcMain()
    const channel = createElectronCardChannel({
      ipcMain: ipc.ipcMain,
      window: (): BrowserWindowLike => record.window,
      hide: (): void => {
        host.hide()
      },
      scheduler: clock.scheduler,
      readyTimeoutMs: 50,
    })
    // The window is shown first and awaited, in the order the notifier does it: `show()`
    // is what loads the card document, and presenting into a document that had not loaded
    // would be a race (src/notify/registry.ts).
    const shown = await host.show({ corner: 'top-right' })
    expect(shown).toEqual({ available: true, reason: 'available' })
    ipc.announce()
    return {
      clock,
      record,
      hideCalls: (): number => record.calls.filter((entry) => entry.call === 'hide').length,
      present: async (): Promise<void> => {
        await channel.present(model({ urgency: options.finished === true ? 'normal' : 'critical' }), options.cell)
      },
    }
  }

  it('sends the removal, then takes the window down, for the one cell that expires', async () => {
    const harness = await surfaceAndChannel({ cell: cardLifetimeFor('finished'), finished: true })
    await harness.present()

    // A finished card is one of the two cells the policy renders, and the card is up.
    expect(harness.record.sent.map((entry) => entry.channel)).toEqual([CARD_CHANNEL_SHOW])
    expect(harness.record.calls.map((entry) => entry.call)).toContain('showInactive')
    // The interval is the table's own, not one this file chose.
    expect(harness.clock.delays).toEqual([CARD_LIFETIMES['finished'].expiresInMs])

    harness.clock.elapse()

    // Removed through the channel, naming the end, and then the window goes down: a card
    // that has left the screen must leave no rectangle behind it (NT-FR-10).
    expect(harness.record.sent.map((entry) => entry.channel)).toEqual([CARD_CHANNEL_SHOW, CARD_CHANNEL_REMOVE])
    expect(harness.record.sent[1]?.payload).toEqual({ end: 'expired' })
    expect(harness.hideCalls()).toBe(1)
  })

  it('arms nothing for a needs-you card, so nothing can time a block out', async () => {
    const harness = await surfaceAndChannel({ cell: cardLifetimeFor('needs-you') })
    await harness.present()
    expect(harness.clock.delays).toEqual([])
    harness.clock.elapse()
    // No interval, so no removal and no window: a block somebody is waiting on stays.
    expect(harness.record.sent.map((entry) => entry.channel)).toEqual([CARD_CHANNEL_SHOW])
    expect(harness.hideCalls()).toBe(0)
  })

  it('cancels the previous card clock when a second card arrives', async () => {
    const harness = await surfaceAndChannel({ cell: cardLifetimeFor('finished'), finished: true })
    await harness.present()
    await harness.present()
    // One live clock, never two: a replaced card must not come back later to take down
    // the window a newer card is using (NT-FR-08).
    expect(harness.clock.delays).toHaveLength(2)
    harness.clock.elapse()
    expect(harness.record.sent.filter((entry) => entry.channel === CARD_CHANNEL_REMOVE)).toHaveLength(1)
  })

  it('sends nothing and reports a failure when the document never announced a channel', async () => {
    // The safety net: a window whose document did not run the preload would otherwise be a
    // card that never arrives with nothing to say so (APX-FR-02, ADR-010).
    const record = stubWindow()
    const diagnostics: string[] = []
    const channel = createElectronCardChannel({
      ipcMain: stubIpcMain().ipcMain,
      window: (): BrowserWindowLike => record.window,
      hide: (): void => record.window.hide(),
      readyTimeoutMs: 5,
      onDiagnostic: (message): void => {
        diagnostics.push(message)
      },
    })
    await expect(channel.present(model(), cardLifetimeFor('needs-you'))).rejects.toThrow(
      /did not announce a listening channel/,
    )
    expect(record.sent).toEqual([])
    expect(diagnostics.join('\n')).toMatch(/nothing was retried/)
  })

  it('refuses a payload it would not send, and a cell that is never rendered', async () => {
    const record = stubWindow()
    const channel = createElectronCardChannel({
      ipcMain: stubIpcMain().ipcMain,
      window: (): BrowserWindowLike => record.window,
      hide: (): void => record.window.hide(),
      readyTimeoutMs: 5,
    })
    await expect(channel.present(model({ title: '/home/dev/x/y' }), cardLifetimeFor('needs-you'))).rejects.toThrow(
      CardChannelPayloadError,
    )
    await expect(channel.present(model(), { ...cardLifetimeFor('fyi') })).rejects.toThrow(/never rendered/)
    expect(record.sent).toEqual([])
  })

  it('refuses to send into a destroyed window rather than throwing at the window', async () => {
    const record = stubWindow()
    const ipc = stubIpcMain()
    const channel = createElectronCardChannel({
      ipcMain: ipc.ipcMain,
      window: (): BrowserWindowLike => record.window,
      hide: (): void => record.window.hide(),
      readyTimeoutMs: 5,
    })
    ipc.announce()
    record.window.destroy()
    await expect(channel.present(model(), cardLifetimeFor('needs-you'))).rejects.toThrow(/destroyed surface window/)
    expect(record.sent).toEqual([])
  })

  it('names a bounded readiness wait, and it is not a card lifetime', () => {
    // A number, not a policy: no card's persistence is expressed here, and the clock is a
    // single timeout that the announcement clears (NT-FR-08).
    expect(typeof CARD_CHANNEL_READY_TIMEOUT_MS).toBe('number')
    expect(CARD_CHANNEL_READY_TIMEOUT_MS).toBeGreaterThan(0)
    const source = readModuleWithoutProse('src/notify/surface/electron-host.ts')
    // No interval anywhere, and one timeout: the announcement wait. A card's own clock is
    // armed by `armCardExpiry` from the cell, so there is no way for this module to time a
    // card out on its own decision (NT-FR-08).
    expect(source).not.toMatch(/setInterval/)
    expect([...source.matchAll(/setTimeout\(/g)]).toHaveLength(1)
    expect(source).toMatch(/armCardExpiry\(cell, scheduler, /)
  })
})

// ---------------------------------------------------------------------------
// The two build-config assertions read a file the helper module does not expose, which is
// the only reason this file imports `node:fs` for one call.
// ---------------------------------------------------------------------------

function readFileText(relative: string): string {
  return readFileSync(repositoryPath(relative), 'utf8')
}
