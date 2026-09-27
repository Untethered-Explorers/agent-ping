// The card's dismissal: the two ends the hub can produce, and the one place that decides
// a card on the screen has finished (NT-FR-12, NT-FR-10, NT-FR-08, APX-FR-02,
// APX-CON-08, ADR-002, ADR-010).
//
//   npm test -- tests/notify/surface-dismissal.test.ts
//
// The lifetime table already named `resolved` and `acknowledged` as the two ends of a
// needs-you card and the card view already removes on either, but nothing produced them:
// a needs-you card left the screen only when the window was destroyed at shutdown. This
// suite is the producer.
//
// THE NINE ACCEPTANCE CRITERIA OF NS-3, AND WHERE EACH IS PROVEN
//
//   1. "A test drives a real ingest of a needs-you event, then a real
//      POST /api/ack/:eventId carrying the per-install token, and asserts the card is
//      removed with the end acknowledged and the host window is hidden."
//      `a real acknowledgement takes the card off the screen`, below. The real
//      `startHub`, the real `electronDesktopBridge` over a structural Electron module, a
//      real loopback socket, and the token read from the file the way a client reads it.
//      The assertion is on the *window*: the removal message the document would receive,
//      and the `hide` the host's own window took because of it (NT-FR-10).
//   2. "A test drives a harness resolution of the same session and asserts the card is
//      removed with the end resolved, with no route involved."
//      `a real resolution takes the card off the screen, with no route`, below: the same
//      run with a resolution posted to the append instead, and the row read back from a
//      second connection to prove the acknowledgement route was never involved - the
//      row is still unacknowledged and is resolved.
//   3. "A test asserts acknowledged and resolved are the only ends this path produces and
//      that both are members of the needs-you cell's own ends."
//      `the two ends this path produces`, below: the exported list compared with the
//      lifetime table's own cell in both directions, and the other three ends refused by
//      name at the type and at run time.
//   4. "A test asserts an unauthorised, rejected and not-found acknowledgement each
//      remove nothing and change nothing." - tests/hub/ack.test.ts, beside the refusals
//      it is about.
//   5. "A test asserts the ack route's 200 body key set is unchanged, the whole-log diff
//      across every registered route and method is still empty, and the exact registered
//      route-signature list is unchanged." - tests/hub/ack.test.ts, beside the route
//      surface it is about.
//   6. "A test asserts src/hub/metrics.ts is still the only caller of a counter write
//      and that a dismissal records none."
//      `a dismissal records no counter`, below: a sweep over every module in `src/` for
//      a counter write, the dismissal's own import list read from its source, and an
//      exact accounting of all four counters across a real ingest and a real
//      acknowledgement.
//   7. "A test asserts dismissal is idempotent and that dismissing a session with no
//      showing card is a no-op rather than an error."
//      `the dismissal is idempotent, and a no-op where nothing shows`, below, over the
//      real module and then over a real hub's second acknowledgement.
//   8. "A test asserts the expired end still removes a finished card, so all five ends in
//      CARD_ENDS are reachable in one run."
//      `all five ends are reachable in one run`, below: one hub, one card document, one
//      recorder, and the five ends in the order the product produces them.
//   9. "A test asserts the dismissal port is present in both the pre-bind and post-bind
//      services objects the composition root builds." - tests/hub/ack.test.ts, which is
//      where the composition root's two literals are read.
//
// WHAT IS NOT PROVEN HERE
// Nothing about a desktop. No Electron process is started and no window is displayed: the
// Electron half is a structural stub, so what is proven is every decision this product
// makes - which end, for which session, whether the cell names it, what the document is
// told and whether the window comes down - and not one thing about how any of the three
// desktops composites a transparent frameless window (NT-FR-03, APX-CON-06).
//
// The document half is jsdom, through the product's own `listenForCardSurface` and its own
// `createCardView`, so the removal is a real event a real listener answered and a real
// element was really removed. jsdom applies no layout and no paint, so nothing here says
// what a card looks like (NT-FR-03).

import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { electronDesktopBridge, startHub, type RunningHub } from '@/main/index'
import {
  CARD_CHANNEL_READY,
  CARD_CHANNEL_REMOVE,
  CARD_CHANNEL_SHOW,
  listenForCardSurface,
} from '@/notify/surface/channel'
import {
  CARD_DISMISSAL_ENDS,
  CARD_RESOLUTION_TRANSITION,
  createCardDismissal,
  isCardTransition,
  type CardDismissal,
  type CardRemover,
  type CardTransition,
  type CardTransitions,
} from '@/notify/surface/dismissal'
import { CARD_LIFETIMES, CARD_ENDS, type CardEnd } from '@/notify/surface/lifetime'
import {
  CARD_ROOT_ATTRIBUTE,
  createCardView,
  type CardView,
  type CardViewOptions,
} from '@/notify/surface/card-view'
import { readWriteToken } from '@/hub/security'
import { openEventStore, type EventStore } from '@/storage/eventStore'
import type { CounterReading } from '@/storage/counters'
import { readModuleImports, readModuleWithoutProse, sourceFilesUnderSrc } from '../helpers/read-module'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_PATH = '/home/dev/Projects/agent-ping'
const SESSION = 'ses_dismiss_01'
const SECOND_SESSION = 'ses_dismiss_02'
const OCCURRED_AT = '2026-09-26T09:00:00.000Z'
/** The display the pre-flight measured, including the 32px top inset. */
const WORK_AREA = { x: 0, y: 32, width: 1920, height: 1048 }

const temporaryDirectories: string[] = []
const openHubs: RunningHub[] = []
const openStores: EventStore[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent-ping-dismissal-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  for (const hub of openHubs.splice(0)) await hub.close().catch(() => undefined)
  for (const store of openStores.splice(0)) store.close()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** One message the window was sent, or one call it was asked to make. */
interface Recorded {
  readonly call: string
  readonly channel?: string
  readonly payload?: unknown
}

/** A `BrowserWindow` that records instead of drawing, and what it was asked to do. */
interface StubWindow {
  readonly window: {
    webContents: { send(channel: string, ...args: readonly unknown[]): void; isDestroyed(): boolean }
    loadURL(url: string): Promise<void>
    showInactive(): void
    hide(): void
    isDestroyed(): boolean
    destroy(): void
    setBounds(bounds: unknown): void
    setIgnoreMouseEvents(ignore: boolean, options?: unknown): void
  }
  readonly calls: Recorded[]
  /** The messages sent on the window's own channel, in order. */
  readonly sent: Recorded[]
}

/**
 * A structural Electron module: a window that records, a display, and an `ipcMain` that
 * announces a listening channel as the window's document would.
 *
 * Two things are modelled rather than stubbed, and both are named in NS-2's suite as
 * well: the window announces readiness when it is created, because a real preload runs
 * before any document script and the channel's wait is a safety net rather than the
 * normal path; and the `send` below can be pointed at a real document, so the message
 * the main process produced is the one a card document would really receive.
 */
function stubElectron(
  onSend?: (channel: string, payload: unknown) => void,
): {
  readonly electron: Parameters<typeof electronDesktopBridge>[0]
  readonly windows: StubWindow[]
  sends(channel: string): Recorded[]
  callsOf(name: string): Recorded[]
} {
  const windows: StubWindow[] = []
  const readyListeners: Array<() => void> = []
  const announce = (): void => {
    for (const listener of readyListeners.splice(0)) listener()
  }
  function record(): StubWindow {
    const calls: Recorded[] = []
    const sent: Recorded[] = []
    let gone = false
    return {
      calls,
      sent,
      window: {
        webContents: {
          send: (channel, ...args): void => {
            const entry: Recorded = { call: 'send', channel, payload: args[0] }
            calls.push(entry)
            sent.push(entry)
            onSend?.(channel, args[0])
          },
          isDestroyed: (): boolean => gone,
        },
        loadURL: async (): Promise<void> => {
          calls.push({ call: 'loadURL' })
        },
        showInactive: (): void => {
          calls.push({ call: 'showInactive' })
        },
        hide: (): void => {
          calls.push({ call: 'hide' })
        },
        isDestroyed: (): boolean => gone,
        destroy: (): void => {
          calls.push({ call: 'destroy' })
          gone = true
        },
        setBounds: (): void => {
          calls.push({ call: 'setBounds' })
        },
        setIgnoreMouseEvents: (): void => {
          calls.push({ call: 'setIgnoreMouseEvents' })
        },
      },
    }
  }
  class BrowserWindow {
    private readonly record: StubWindow
    constructor(options: unknown) {
      void options
      this.record = record()
      windows.push(this.record)
      announce()
    }
    get webContents(): StubWindow['window']['webContents'] {
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
      return this.record.window.isDestroyed()
    }
    destroy(): void {
      this.record.window.destroy()
    }
    setBounds(bounds: unknown): void {
      this.record.window.setBounds(bounds)
    }
    setIgnoreMouseEvents(ignore: boolean, ignoreOptions?: unknown): void {
      this.record.window.setIgnoreMouseEvents(ignore, ignoreOptions)
    }
  }
  // A tray that accepts the two calls the tray module makes and does nothing else, so this
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
    ipcMain: {
      on: (channel: string, listener: (event: unknown) => void): unknown => {
        // The one channel a preload announces on, read from the module that names it, so
        // this stub cannot quietly stop answering the real presenter.
        if (channel !== CARD_CHANNEL_READY) return undefined
        readyListeners.push(() => listener({}))
        return undefined
      },
    },
  }
  return {
    electron: electron as unknown as Parameters<typeof electronDesktopBridge>[0],
    windows,
    sends: (channel: string): Recorded[] =>
      windows.flatMap((entry) => entry.sent.filter((message) => message.channel === channel)),
    callsOf: (name: string): Recorded[] =>
      windows.flatMap((entry) => entry.calls.filter((message) => message.call === name)),
  }
}

/** A hub started by the real composition root over the real desktop bridge. */
async function cardHub(
  onSend?: (channel: string, payload: unknown) => void,
): Promise<{ readonly hub: RunningHub; readonly surface: ReturnType<typeof stubElectron> }> {
  const stub = stubElectron(onSend)
  const hub = await startHub({
    stateDir: temporaryDirectory(),
    dashboardRoot: null,
    lifecycle: { installSignals: false, exit: (): void => undefined },
    // No `delivery` override: the notifier is the surface's own, resolved inside
    // `startHub` from the bridge this test just built, so what is under test is the
    // wiring rather than the policy.
    desktop: { isPrimaryInstance: true, ...electronDesktopBridge(stub.electron) },
  })
  openHubs.push(hub)
  return { hub, surface: stub }
}

interface Fetched {
  readonly status: number
  json<T>(): T
}

/** One request over a real loopback socket. */
function call(
  origin: string,
  method: string,
  pathname: string,
  body?: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<Fetched> {
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
          ...headers,
        },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: response.statusCode ?? 0, json: <T,>(): T => JSON.parse(text) as T })
        })
      },
    )
    outgoing.on('error', reject)
    if (body === undefined) outgoing.end()
    else outgoing.end(body)
  })
}

/** A block in one session: the only class that leaves the app (EL-FR-07). */
function blockBody(transitionId: string, sessionId = SESSION): string {
  return JSON.stringify({
    harness: 'opencode',
    eventName: 'permission.asked',
    sessionId,
    repoFullPath: REPO_PATH,
    transitionId,
    occurredAt: OCCURRED_AT,
  })
}

/** A harness resolution: not a class event, and it clears the pending item. */
function resolutionBody(transitionId: string, sessionId = SESSION): string {
  return JSON.stringify({
    harness: 'opencode',
    eventName: 'permission.replied',
    sessionId,
    repoFullPath: REPO_PATH,
    transitionId,
    occurredAt: OCCURRED_AT,
  })
}

/** A turn that ended, having done some work: the finished class. */
function finishedBody(sessionId = SECOND_SESSION): string {
  return JSON.stringify({
    harness: 'opencode',
    eventName: 'session.status',
    variant: 'idle',
    sessionId,
    repoFullPath: REPO_PATH,
    transitionId: 'turn-1',
    occurredAt: OCCURRED_AT,
    turnWork: { toolCall: true, fileEdit: false, todoUpdate: false },
  })
}

/** Post one signal and wait for the delivery the pipeline makes from it. */
async function signal(hub: RunningHub, body: string): Promise<string> {
  const posted = await call(hub.origin, 'POST', '/api/ingest', body)
  expect(posted.status).toBe(202)
  await hub.ingest.idle()
  return posted.json<{ eventId: string | null }>().eventId ?? ''
}

/** The pending row for one transition, read from a second connection to the log. */
function observer(hub: RunningHub): EventStore {
  const store = openEventStore({ filePath: hub.databaseFilePath })
  openStores.push(store)
  return store
}

/** The one write a client makes, carrying the token the contract says, read from the file. */
function ack(hub: RunningHub, eventId: string): Promise<Fetched> {
  return call(hub.origin, 'POST', `/api/ack/${eventId}`, undefined, {
    'x-agent-ping-token': readWriteToken(hub.stateDir) ?? '',
  })
}

/** A dismissal over a remover that records, and the ends it was asked for. */
function dismissalFixture(
  options: { readonly remove?: CardRemover | null } = {},
): {
  readonly dismissal: CardDismissal
  readonly removed: CardEnd[]
  readonly diagnostics: string[]
} {
  const removed: CardEnd[] = []
  const diagnostics: string[] = []
  // `in` rather than `??`, because a null remover is a case this suite has to be able to
  // ask for and `null ?? recording` would quietly substitute the recording one.
  const remove: CardRemover | null =
    'remove' in options && options.remove !== undefined
      ? options.remove
      : (end: CardEnd): void => {
          removed.push(end)
        }
  const dismissal = createCardDismissal({
    remove,
    onDiagnostic: (message: string): void => {
      diagnostics.push(message)
    },
  })
  return { dismissal, removed, diagnostics }
}

/** A transition source a test publishes into, standing in for the hub's live state feed. */
function transitionSource(): {
  readonly source: CardTransitions
  readonly publish: (transition: CardTransition) => void
  readonly unsubscribed: () => number
} {
  const listeners: Array<(transition: CardTransition) => void> = []
  return {
    source: {
      subscribe: (listener): (() => void) => {
        listeners.push(listener)
        return (): void => {
          const at = listeners.indexOf(listener)
          if (at >= 0) listeners.splice(at, 1)
        }
      },
    },
    publish: (transition): void => {
      for (const listener of [...listeners]) listener(transition)
    },
    unsubscribed: (): number => listeners.length,
  }
}

/** A card document, and the view that renders into it. */
async function cardDocument(): Promise<{
  readonly window: Window & typeof globalThis
  /** The view itself, so a test can destroy it and watch the `destroyed` end. */
  readonly view: CardView
  readonly ends: CardEnd[]
  readonly elapse: () => void
  readonly armed: () => number
  readonly stop: () => void
}> {
  // Through a specifier the compiler cannot fold, for the reason src/main/index.ts loads
  // `electron` the same way: `jsdom` ships no type declarations, and a literal specifier
  // would make this file unable to typecheck over a missing ambient module.
  const specifier = 'jsdom'
  const jsdom = (await import(specifier)) as unknown as {
    JSDOM: new (markup: string) => { window: unknown }
  }
  const window = new jsdom.JSDOM('<!doctype html><div data-card-surface></div>').window as unknown as
    Window & typeof globalThis
  const document = window.document
  const ends: CardEnd[] = []
  const pending: Array<() => void> = []
  const options: CardViewOptions = {
    parent: document.querySelector('[data-card-surface]') as unknown as CardViewOptions['parent'],
    document: document as unknown as CardViewOptions['document'],
    // The card's own clock, driven by hand: the one interval the lifetime table names is
    // five seconds of real time, and what is under test here is which end a card leaves
    // on rather than how long it waits.
    scheduler: {
      schedule: (delayMs: number, onElapsed: () => void): { cancel(): void } => {
        // The interval is the lifetime table's own and not a number this test chose, so
        // the only clock the product arms for a finished card is the one asserted here.
        expect(delayMs).toBe(CARD_LIFETIMES['finished'].expiresInMs)
        let live = true
        pending.push(() => {
          if (!live) return
          live = false
          onElapsed()
        })
        return {
          cancel: (): void => {
            live = false
            pending.length = 0
          },
        }
      },
    },
    onEnd: (end: CardEnd): void => {
      ends.push(end)
    },
  }
  const view = createCardView(options)
  const stop = listenForCardSurface(view, { target: window })
  return {
    window,
    view,
    ends,
    elapse: (): void => {
      for (const entry of pending.splice(0)) entry()
    },
    armed: (): number => pending.length,
    stop,
  }
}

// ---------------------------------------------------------------------------
// Criterion 3: the two ends this path produces
// ---------------------------------------------------------------------------

describe('the two ends this path produces', () => {
  it('are exactly two, and both are ends the needs-you cell names', () => {
    expect([...CARD_DISMISSAL_ENDS]).toEqual(['acknowledged', 'resolved'])
    // Compared with the table in both directions, and with the table's own frozen cell
    // rather than a copy of it: a dismissal end that the lifetime table does not name is
    // a card removed for a reason this product has not agreed to (NT-FR-08, ADR-010).
    for (const end of CARD_DISMISSAL_ENDS) {
      expect(CARD_LIFETIMES['needs-you'].ends).toContain(end)
    }
    expect([...CARD_LIFETIMES['needs-you'].ends].sort()).toEqual([...CARD_DISMISSAL_ENDS].sort())
    // And the other three ends belong to somebody else: `expired` to the finished cell,
    // `replaced` and `destroyed` to this product's own reasons about the surface.
    expect(CARD_ENDS.filter((end) => !CARD_DISMISSAL_ENDS.includes(end as never))).toEqual([
      'expired',
      'replaced',
      'destroyed',
    ])
  })

  it('removes the card on either, and refuses the three this path cannot produce', () => {
    const { dismissal, removed } = dismissalFixture()
    dismissal.shown(SESSION, CARD_LIFETIMES['needs-you'])
    dismissal.dismiss(SESSION, 'acknowledged')
    expect(removed).toEqual(['acknowledged'])
    dismissal.shown(SESSION, CARD_LIFETIMES['needs-you'])
    dismissal.dismiss(SESSION, 'resolved')
    expect(removed).toEqual(['acknowledged', 'resolved'])
    // The type refuses the other three; the run-time check refuses them too, because a
    // card's lifetime is a table and a hand-typed end is not in it.
    for (const end of ['expired', 'replaced', 'destroyed'] as CardEnd[]) {
      dismissal.shown(SESSION, CARD_LIFETIMES['needs-you'])
      dismissal.dismiss(SESSION, end as never)
    }
    expect(removed).toEqual(['acknowledged', 'resolved'])
  })

  it('refuses an end the showing card\'s own cell does not name', () => {
    // The rule that keeps a finished card on the screen: a resolution of some other block
    // in the same session must not take this card away, because `expired` is the only end
    // a finished card's cell carries (NT-FR-08, ADR-004).
    const { dismissal, removed } = dismissalFixture()
    dismissal.shown(SESSION, CARD_LIFETIMES['finished'])
    dismissal.dismiss(SESSION, 'resolved')
    dismissal.dismiss(SESSION, 'acknowledged')
    expect(removed).toEqual([])
    expect(dismissal.showingFor()).toBe(SESSION)
    // And the one that *is* its own end is honoured, so the refusal above is the table's
    // rule and not a hole. The port's two-value vocabulary is the type's job: a caller
    // would have to defeat `CardDismissalEnd` to reach an end this product does not name
    // for the cell it is holding.
    dismissal.dismiss(SESSION, 'expired' as never)
    expect(removed).toEqual(['expired'])
    expect(dismissal.showingFor()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Criterion 7: idempotent, and a no-op where nothing shows
// ---------------------------------------------------------------------------

describe('the dismissal is idempotent, and a no-op where nothing shows', () => {
  it('removes once however many times it is asked, and never throws', () => {
    const { dismissal, removed, diagnostics } = dismissalFixture()
    // Nothing is showing: a session with no card on the screen is a no-op rather than an
    // error, and a hub that acknowledged a block nobody was shown a card for must not
    // have anything to report (APX-FR-02).
    expect(() => dismissal.dismiss(SESSION, 'acknowledged')).not.toThrow()
    expect(dismissal.dismiss(SESSION, 'acknowledged')).toBeUndefined()
    expect(removed).toEqual([])
    expect(diagnostics).toEqual([])

    dismissal.shown(SESSION, CARD_LIFETIMES['needs-you'])
    for (let attempt = 0; attempt < 5; attempt += 1) dismissal.dismiss(SESSION, 'acknowledged')
    expect(removed).toEqual(['acknowledged'])
    // And a different block's acknowledgement is a no-op as well, which is the check that
    // makes one card per surface safe.
    dismissal.shown(SESSION, CARD_LIFETIMES['needs-you'])
    dismissal.dismiss('ses_somewhere_else', 'acknowledged')
    expect(removed).toEqual(['acknowledged'])
    expect(dismissal.showingFor()).toBe(SESSION)
  })

  it('records no card on a run with no card renderer, so a dismissal can do nothing', () => {
    const { dismissal, removed } = dismissalFixture({ remove: null })
    dismissal.shown(SESSION, CARD_LIFETIMES['needs-you'])
    expect(dismissal.showingFor()).toBeNull()
    dismissal.dismiss(SESSION, 'acknowledged')
    expect(removed).toEqual([])
    // And it does not subscribe to the live state feed either, which is the same fact
    // seen from the other side: a card cannot be showing on this run, so a resolution
    // frame could not be acted on, and an internal subscriber that can never fire would
    // spend a slot of the budget the stream route spends on dashboards (HC-FR-03).
    const feed = transitionSource()
    expect(() => dismissal.watch(feed.source)).not.toThrow()
    expect(feed.unsubscribed()).toBe(0)
    feed.publish({ kind: CARD_RESOLUTION_TRANSITION, event: { sessionId: SESSION } })
    expect(removed).toEqual([])
  })

  it('reports a removal that fails, and does not fail the caller', () => {
    const { dismissal, diagnostics } = dismissalFixture({
      remove: (): never => {
        throw new Error('the window was already gone')
      },
    })
    dismissal.shown(SESSION, CARD_LIFETIMES['needs-you'])
    expect(() => dismissal.dismiss(SESSION, 'acknowledged')).not.toThrow()
    // A card that could not be taken off the screen is a real fact about a developer's
    // screen, so it is reported rather than swallowed (NT-FR-10, APX-FR-02).
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain('could not be taken off the screen (acknowledged)')
    expect(diagnostics[0]).toContain('the window was already gone')
    // Nothing about the block appears in it: this is a diagnostic about a window, not a
    // record of an event (APX-FR-01).
    expect(diagnostics[0]).not.toContain(SESSION)
    expect(diagnostics[0]).not.toContain(REPO_PATH)
    // And the second attempt does not re-raise it: the dismissal is one attempt per card
    // and a card that is gone is gone.
    dismissal.dismiss(SESSION, 'acknowledged')
    expect(diagnostics).toHaveLength(1)
  })

  it('takes a card off on a resolution frame, and on nothing else in the feed', () => {
    const { dismissal, removed } = dismissalFixture()
    const feed = transitionSource()
    dismissal.watch(feed.source)
    expect(feed.unsubscribed()).toBe(1)
    // The three frames a hub publishes that are not a resolution: an event stored, an
    // acknowledgement this module was already told about, and a heartbeat. None of them
    // may reach a dismissal (src/hub/sse.ts, src/domain/pending.ts).
    feed.publish({ kind: 'event-stored', event: { sessionId: SESSION } })
    feed.publish({ kind: 'acknowledged', event: { sessionId: SESSION } })
    expect(removed).toEqual([])
    // The one that is: a resolution cleared a pending item, and the card was showing for
    // that item's session.
    dismissal.shown(SESSION, CARD_LIFETIMES['needs-you'])
    feed.publish({ kind: CARD_RESOLUTION_TRANSITION, event: { sessionId: SESSION } })
    expect(removed).toEqual(['resolved'])
    // And the frame kind is the store wrapper's own, read from the source rather than
    // restated: `markResolved` is the only transition that publishes this name.
    const feedSource = readModuleImports('src/hub/sse.ts')
    expect(feedSource).toMatch(/report\('block-resolved'/)
    expect(CARD_RESOLUTION_TRANSITION).toBe('block-resolved')
  })

  it('reads a published frame through a guard, and refuses anything that is not one', () => {
    // The hub's feed puts the transition it published in the frame's `data`, and this is
    // the one place that value is read, so the narrowing is checked rather than cast.
    // The positive half is a real `StateChange` with everything it carries: the reader
    // asks for two fields and not for equality, which is what lets a frame that grows a
    // field keep working.
    expect(
      isCardTransition({
        cursor: 4,
        at: OCCURRED_AT,
        kind: 'block-resolved',
        event: { eventId: 'evt_1', sessionId: SESSION },
        session: null,
        pendingCount: 0,
      }),
    ).toBe(true)
    // The negative half, one reason at a time: not an object, no kind, a kind that is not
    // a string, no event, and an event with no session in it. Each is a value the feed
    // would never publish, and each is one a value nobody checked would have been read
    // as though somebody had.
    for (const value of [
      null,
      undefined,
      'block-resolved',
      42,
      {},
      { kind: 'block-resolved' },
      { kind: 42, event: { sessionId: SESSION } },
      { kind: 'block-resolved', event: null },
      { kind: 'block-resolved', event: { sessionId: 42 } },
    ]) {
      expect(isCardTransition(value), JSON.stringify(value ?? null)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Criterion 1: a real acknowledgement takes the card off the screen
// ---------------------------------------------------------------------------

describe('a real acknowledgement takes the card off the screen', () => {
  it('removes the card with the end acknowledged, and the host window goes down', async () => {
    const { hub, surface } = await cardHub()
    const store = observer(hub)
    // A real block, ingested over a real socket by the real pipeline.
    const eventId = await signal(hub, blockBody('block-ack'))
    const row = store.readPending()[0]
    expect(row?.eventId).toBe(eventId)
    // The card is on the screen, and the window is up.
    expect(surface.sends(CARD_CHANNEL_SHOW)).toHaveLength(1)
    expect(surface.callsOf('showInactive')).toHaveLength(1)
    expect(surface.callsOf('hide')).toHaveLength(0)

    const answered = await ack(hub, eventId)

    expect(answered.status).toBe(200)
    // The removal crossed the channel, naming the end, and the host's own window came
    // down behind it: NT-FR-10's promise is about what the desktop does, so the hide is
    // the assertion that matters as much as the message.
    const removals = surface.sends(CARD_CHANNEL_REMOVE)
    expect(removals).toHaveLength(1)
    expect(removals[0]?.payload).toEqual({ end: 'acknowledged' })
    expect(surface.callsOf('hide')).toHaveLength(1)
    // Nothing else was sent, and no second card was drawn.
    expect(surface.sends(CARD_CHANNEL_SHOW)).toHaveLength(1)
    // The record changed exactly as it did before this task existed, and the dismissal is
    // not in it: one column, on one row.
    expect(row?.ackState).toBe('unacknowledged')
    expect(store.readPending()).toEqual([])
  })

  it('leaves a retried acknowledgement with nothing left to remove', async () => {
    const { hub, surface } = await cardHub()
    const eventId = await signal(hub, blockBody('block-retry'))
    await ack(hub, eventId)
    const repeat = await ack(hub, eventId)

    // A second acknowledgement is a 200 that changed nothing (HC-FR-08), and it must not
    // produce a second removal: the card is already off the screen, and a repeated
    // message would be a second card ending for no stated reason (NT-FR-08).
    expect(repeat.status).toBe(200)
    expect(repeat.json<{ outcome: string }>().outcome).toBe('unchanged')
    expect(surface.sends(CARD_CHANNEL_REMOVE)).toHaveLength(1)
    expect(surface.callsOf('hide')).toHaveLength(1)
  })

  it('leaves a card for a block that was never acknowledged alone', async () => {
    const { hub, surface } = await cardHub()
    await signal(hub, blockBody('block-still-pending'))

    // No route is involved here at all, and nothing else was done: the card is still up,
    // which is the promise a needs-you cell makes (NT-FR-02, ADR-004).
    expect(surface.sends(CARD_CHANNEL_REMOVE)).toEqual([])
    expect(surface.callsOf('hide')).toEqual([])
    expect(hub.delivery.status()).toMatchObject({ wired: true, delivered: 1 })
  })
})

// ---------------------------------------------------------------------------
// Criterion 2: a real resolution, with no route
// ---------------------------------------------------------------------------

describe('a real resolution takes the card off the screen, with no route', () => {
  it('removes the card with the end resolved, and no request was made', async () => {
    const { hub, surface } = await cardHub()
    const store = observer(hub)
    await signal(hub, blockBody('block-resolve'))
    expect(surface.sends(CARD_CHANNEL_SHOW)).toHaveLength(1)

    // The harness reports the block settled. Its class is refused by the policy, so no
    // card is built and no delivery is attempted - the card comes down from the
    // pending-set transition instead, with no route in it (NT-FR-02, NT-FR-12).
    await signal(hub, resolutionBody('block-resolve'))

    const removals = surface.sends(CARD_CHANNEL_REMOVE)
    expect(removals).toHaveLength(1)
    expect(removals[0]?.payload).toEqual({ end: 'resolved' })
    expect(surface.callsOf('hide')).toHaveLength(1)

    // The proof that no route was involved: the row is resolved and still
    // unacknowledged, so nothing acknowledged it, and the pending set is empty.
    const row = store.readEventHistory({ limit: 10 }).find((event) => event.eventId !== '')
    expect(row?.ackState).toBe('unacknowledged')
    expect(row?.resolutionState).toBe('resolved')
    expect(store.readPending()).toEqual([])
    // And the resolution was not a delivery at all: a resolution is not a class event, so
    // the pipeline stored nothing, attempted nothing and told nobody - one attempt, the one
    // the block itself made, and one suppression in the pipeline's own count. The card came
    // down from the pending-set transition rather than from a card somebody was shown
    // (NT-FR-09, EL-FR-07).
    expect(hub.delivery.status()).toMatchObject({
      attempted: 1,
      delivered: 1,
      suppressed: 0,
      failed: 0,
      notWired: 0,
    })
    expect(hub.ingest.stats()).toMatchObject({
      submitted: 2,
      stored: 1,
      // The pipeline's own count of what a resolution is: a resolved pending item, and
      // not a drop - nothing was lost, and the block is still in the log (HC-FR-09).
      resolved: 1,
      dropped: 0,
    })
  })

  it('leaves a card for another session alone when one block is resolved', async () => {
    const { hub, surface } = await cardHub()
    // Two blocks, two cards: the second one replaced the first, so the card on the screen
    // is the second session's.
    await signal(hub, blockBody('block-one', SESSION))
    await signal(hub, blockBody('block-two', SECOND_SESSION))
    expect(surface.sends(CARD_CHANNEL_SHOW)).toHaveLength(2)

    await signal(hub, resolutionBody('block-one', SESSION))

    // The first session's block is gone and the card on the screen was not its own, so
    // nothing was removed: one card per surface, and it belongs to the second block.
    expect(surface.sends(CARD_CHANNEL_REMOVE)).toEqual([])
    expect(surface.callsOf('hide')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Criterion 6: a dismissal records no counter
// ---------------------------------------------------------------------------

describe('a dismissal records no counter', () => {
  it('is the only module in the product that may call a counter write', () => {
    // The same sweep tests/hub/metrics.test.ts runs, widened to every module in `src/`
    // rather than to the four directories it walked - the dismissal lives under
    // `src/notify`, and a card leaving the screen must not become a number in a table
    // somebody measures the product with (HC-6, PRD 11).
    const pattern = /\.record(DashboardOpen|ToastDelivery|DeepLinkOpen|PendingCountSnapshot)\s*\(/
    expect(sourceFilesUnderSrc().filter((file) => pattern.test(readModuleWithoutProse(file)))).toEqual([
      'src/hub/metrics.ts',
    ])
  })

  it('cannot reach a counter, because its only import is a type', () => {
    // Structural rather than behavioural, and it is the stronger of the two: the module
    // has no value import at all, so there is nothing for it to reach a counter through -
    // no counters accessor, no store, no hub module, and no package (APX-CON-12).
    const imports = [...readModuleImports('src/notify/surface/dismissal.ts').matchAll(/^import .*$/gm)].map(
      (match) => match[0].trim(),
    )
    expect(imports).toHaveLength(1)
    expect(imports[0]).toMatch(/^import type /)
    expect(imports[0]).toContain("'./lifetime.js'")
  })

  it('moves no counter through a real acknowledgement', async () => {
    const { hub } = await cardHub()
    await signal(hub, blockBody('block-counters'))
    const afterIngest = await metricsOf(hub)
    await ack(hub, afterIngest.eventId)

    // Every counter, accounted for: the one delivery the ingest made, and the two
    // applied transitions the store reported. A dismissal that recorded anything would
    // make one of these numbers differ, and the accounting says which path owes what.
    const after = await metricsOf(hub)
    expect(after.counts).toEqual({
      dashboard_opens: 0,
      deep_link_opens: 0,
      // One, and only from the delivery: taking a card off the screen is not a delivery
      // and must never be counted as one (NT-FR-09, APX-FR-02).
      toast_deliveries: 1,
      // Two applied transitions - the block was stored, then acknowledged - and a
      // dismissal is not a third (HC-6).
      pending_count_snapshots: 2,
    })
  })
})

/** The four counters, as a name-to-value map a test can compare in one assertion. */
async function metricsOf(hub: RunningHub): Promise<{
  readonly counts: Readonly<Record<string, number>>
  readonly eventId: string
}> {
  const payload = (
    await call(hub.origin, 'GET', '/api/metrics')
  ).json<{ counters: readonly CounterReading[] }>()
  const eventId = hub.pending.readPending()[0]?.eventId ?? ''
  return {
    counts: Object.fromEntries(payload.counters.map((reading) => [reading.counter, reading.value])),
    eventId,
  }
}

// ---------------------------------------------------------------------------
// Criterion 8: all five ends, in one run
// ---------------------------------------------------------------------------

describe('all five ends are reachable in one run', () => {
  it('walks one card document through acknowledged, resolved, expired, replaced and destroyed', async () => {
    // One hub, one window, one document, one recorder. Every end in CARD_ENDS is produced
    // by the product's own code in this single run: the two the hub causes through the
    // channel, the one the lifetime table's interval produces, and this product's own two
    // reasons about the surface (NT-FR-08).
    const document = await cardDocument()
    const { hub, surface } = await cardHub((channel, payload) => {
      // What `preload.cts` does on receiving a message: hand it to the document as the
      // event the document listens for, carrying exactly what crossed.
      document.window.dispatchEvent(
        new document.window.CustomEvent(channel, { detail: payload }),
      )
    })

    // 1. A real block, ingested over a real socket, becomes a real card in the document.
    const first = await signal(hub, blockBody('block-a'))
    expect(surface.sends(CARD_CHANNEL_SHOW)).toHaveLength(1)
    expect(cardsIn(document.window)).toBe(1)
    expect(document.armed()).toBe(0)

    // 2. The developer acknowledges it: `acknowledged`, through the real route.
    await ack(hub, first)
    expect(document.ends).toEqual(['acknowledged'])
    expect(cardsIn(document.window)).toBe(0)

    // 3. A second block in the same session, and then the harness resolves it: `resolved`,
    //    with no route involved.
    await signal(hub, blockBody('block-b'))
    expect(cardsIn(document.window)).toBe(1)
    await signal(hub, resolutionBody('block-b'))
    expect(document.ends).toEqual(['acknowledged', 'resolved'])
    expect(cardsIn(document.window)).toBe(0)

    // 4. A turn that ended is shown under the finished cell, and the one interval that
    //    table names is the only clock in the product: elapse it and the card expires.
    await signal(hub, finishedBody())
    expect(cardsIn(document.window)).toBe(1)
    expect(document.armed()).toBe(1)
    document.elapse()
    expect(document.ends).toEqual(['acknowledged', 'resolved', 'expired'])
    expect(cardsIn(document.window)).toBe(0)

    // 5. A second card while one is showing replaces it, which is the surface's own reason
    //    and not anything the hub had to say.
    await signal(hub, blockBody('block-c', SECOND_SESSION))
    await signal(hub, blockBody('block-d', 'ses_dismiss_03'))
    expect(document.ends).toEqual(['acknowledged', 'resolved', 'expired', 'replaced'])
    expect(cardsIn(document.window)).toBe(1)

    // 6. And the host window going away takes the last card with it, which is what the
    //    ordered shutdown does first (HC-FR-10).
    document.view.destroy()

    // Every card that left the screen left with a name, all five of the table's own ends,
    // and no sixth: the set is compared rather than the order, because a card's
    // disappearance always has a name and nothing else may be produced (NT-FR-08).
    expect([...document.ends].sort()).toEqual([...CARD_ENDS].sort())
    expect(new Set(document.ends).size).toBe(CARD_ENDS.length)
    // The order they were produced in, which is the order the two hub ends, the interval
    // and this product's own two reasons happen to fall in.
    expect(document.ends).toEqual(['acknowledged', 'resolved', 'expired', 'replaced', 'destroyed'])
    expect(cardsIn(document.window)).toBe(0)
    // Exactly the two hub-originated ends took the window down in this run, because the
    // window can only come down from the main process: the other three are the card
    // document's own reasons about its own element (NT-FR-10). The main process's own arm
    // of the same interval is what takes the window down for a finished card, and that is
    // proven with a real clock in tests/notify/surface-channel.test.ts - here the clock
    // under test is the document's, so only the two hub ends produced a hide.
    expect(surface.callsOf('hide')).toHaveLength(2)
    document.stop()
  })
})

/** How many cards the document is currently showing. */
function cardsIn(window: Window & typeof globalThis): number {
  return window.document.querySelectorAll(`[${CARD_ROOT_ATTRIBUTE}]`).length
}
