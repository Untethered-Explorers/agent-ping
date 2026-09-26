// The tray: the icon that is present for as long as the hub runs, its badge, its two
// menu actions, and the deep link a click resolves (NT-FR-05, NT-FR-06, NT-FR-07).
//
//   npm test -- tests/hub/tray.test.ts
//
// THE ACCEPTANCE CRITERIA, AND WHERE EACH IS PROVEN
//
//   1. "A test asserts the badge renders zero pending items as no badge, a small
//      count as that count, and a count above ninety-nine as the capped marker."
//      The rule itself, with no desktop, is tests/tray/badge.test.ts. Here the badge
//      is driven *through the real main entry point* against a real log over real
//      sockets: zero at mount, one after a real block arrives over a real ingest,
//      two after a second, one after an acknowledgement, zero again - and at every
//      step the badge is compared against the count a real `GET /api/pending` returns,
//      which is the property that matters (the icon and the route cannot disagree).
//      The capped marker is asserted on a mounted tray too, with a hundred and one
//      outstanding items, because NT-FR-05's third case belongs here and not only
//      there.
//
//   2. "A test asserts the tray menu exposes exactly open-dashboard and quit and no
//      suppression control."
//      The ids are enumerated from the table rather than restated, the view handed to
//      the desktop is asserted to be the same two rows, every id and label is checked
//      against the vocabulary NT-FR-06 names, and the tray's own public surface is
//      enumerated - because a `dismiss` method would be the suppression control, and
//      it would be a compile error that nobody reads rather than a failing test.
//
//   3. "A test asserts clicking the icon resolves a deep link that focuses the session
//      and increments the deep-link counter."
//      Through the bridge the tray registered its click handler with, twice over: once
//      where the desktop answers that a document request will follow - and a real
//      request is then made over a real socket, so the counters move through the hub's
//      own dashboard route - and once where it answers that no request will follow, so
//      the tray has to count the open itself. Both must land on one open and one deep
//      link, and neither on two: the double count HC-6 warned about is the failure
//      this asserts the absence of. The session focused is the oldest outstanding one,
//      and with nothing outstanding the link is the plain dashboard and is counted as
//      an open alone.
//
//   4. "A test drives the tray through the main entry point and asserts the badge
//      follows the pending set returned by the hub."
//      `startHub` is the real one, over a real log, with the real routes: a block
//      posted over a real socket moves the badge before the response is even read, an
//      acknowledgement moves it back, and a restarted hub mounts with the badge
//      already showing what was outstanding. The tray is also shown to be subscribed
//      to the hub's own change feed, which is the mechanism rather than a timer.
//
// AROUND THOSE FOUR, the properties that make them worth anything:
//
//   - Presence is an ordering claim, not a promise: the icon is on the desktop before
//     the hub reports `running` (PRD 10), and it is gone - before the log closes - on
//     the way down, with the log still readable at that moment.
//   - A failed click is never silent and never half counted: three different faults,
//     three diagnostic lines, no counter moved in any of them (APX-FR-02).
//   - A badge that cannot be recomputed keeps the number it had and says so, rather
//     than going blank at the moment a block appeared.
//   - A desktop that cannot mount leaves the hub serving, with a line saying so, and
//     no stub pretending an icon is there.
//   - No sound, no repeat timer, and no way out of the machine: asserted against the
//     two modules' own source rather than described (APX-CON-04, APX-CON-12, NT-FR-08).
//
// A NOTE ON WHAT IS NOT EXERCISED HERE
// Nothing in this file touches Electron. The platform half - the `Tray` object, the
// menu template, the bitmap, and whether a left click reaches a handler on any of the
// three desktops - is in src/main/index.ts behind a dynamic import, was written on a
// Linux machine with no Electron installed, and has never been run. What is proven
// here is everything the bridge is asked to do, which is the whole of what this
// product decides; the bridge itself is NT-4's and NT-5's human gate, and this file
// claims nothing about it.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startHub, type RunningHub } from '@/main/index'
import {
  TRAY_MENU_ITEM_IDS,
  TRAY_MENU_ITEMS,
  createHubTray,
  type DeepLinkDispatch,
  type HubTray,
  type TrayBridge,
  type TrayMenuItemId,
  type TrayMenuView,
} from '@/hub/tray'
import { badgeFor, drawTrayIcon, type TrayIcon } from '@/tray/badge'
import { DEEP_LINK_QUERY_KEY } from '@/hub/metrics'
import { planNotification } from '@/notify/policy'
import { createChangeFeed, type StateChange } from '@/hub/sse'
import { WRITE_TOKEN_HEADER } from '@/hub/security'
import type { MetricsPayload } from '@/hub/routes/metrics'
import type { PendingItem } from '@/storage/eventStore'
import type { Notifier } from '@/hub/delivery'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_PATH = '/home/dev/Projects/agent-ping'
const REPO_NAME = 'agent-ping'
const SESSION = 'ses_tray_01'
const OLDER_SESSION = 'ses_tray_00'
const OCCURRED_AT = '2026-09-26T09:00:00.000Z'
const OLDER_OCCURRED_AT = '2026-09-26T08:00:00.000Z'

const temporaryDirectories: string[] = []
const openHubs: RunningHub[] = []
const diagnostics: string[] = []
const exits: string[] = []

function temporaryDirectory(prefix = 'agent-ping-state-'): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * A stand-in for the built dashboard.
 *
 * The document has to exist: the tray's whole promise is that its click lands on a
 * page, and a click that resolved a link nobody can serve would be counted as an open
 * of nothing.
 */
function dashboardFixture(): string {
  const root = temporaryDirectory('agent-ping-dashboard-')
  mkdirSync(path.join(root, 'assets'), { recursive: true })
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>agent-ping</title>\n')
  return root
}

afterEach(async () => {
  for (const hub of openHubs.splice(0)) {
    await hub.close().catch(() => undefined)
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  diagnostics.length = 0
  exits.length = 0
})

async function startFixtureHub(
  options: Partial<Parameters<typeof startHub>[0]> = {},
): Promise<RunningHub> {
  const hub = await startHub({
    stateDir: temporaryDirectory(),
    dashboardRoot: dashboardFixture(),
    // A test hub is not a process that should react to this test runner's signals, and
    // the tray's quit runs the real ordered shutdown, so the exit is a spy rather than
    // a `process.exit` in the middle of a test run.
    lifecycle: { installSignals: false, exit: (): void => undefined },
    // Every needs-you block in this file is stored through the real pipeline, and the
    // real pipeline delivers. A stub notifier keeps a full `npm test` from putting a
    // toast on the developer's desktop (NT-1's own warning about this), and it is the
    // notifier under test in tests/notify, not here.
    delivery: { notifier: vi.fn<Notifier>(() => undefined) },
    onDiagnostic: (message) => diagnostics.push(message),
    ...options,
  })
  openHubs.push(hub)
  return hub
}

interface Fetched {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly text: string
  json<T = unknown>(): T
}

interface CallInit {
  readonly method: string
  readonly pathname: string
  readonly body?: string
  readonly headers?: Readonly<Record<string, string>>
}

/** One request over a real loopback socket, one connection. */
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
          ...init.headers,
          ...(init.body === undefined
            ? {}
            : { 'content-length': String(Buffer.byteLength(init.body)) }),
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
            headers: response.headers,
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

async function get(hub: RunningHub, pathname: string): Promise<Fetched> {
  return call(hub.origin, { method: 'GET', pathname })
}

/** The pending count the hub's own read route reports, over a real socket. */
async function pendingCountFromHub(hub: RunningHub): Promise<number> {
  const response = await get(hub, '/api/pending')
  expect(response.status).toBe(200)
  return response.json<{ count: number }>().count
}

async function metricsOf(hub: RunningHub): Promise<MetricsPayload> {
  const response = await get(hub, '/api/metrics')
  expect(response.status).toBe(200)
  return response.json<MetricsPayload>()
}

async function counterOf(hub: RunningHub, name: string): Promise<number> {
  const payload = await metricsOf(hub)
  const reading = payload.counters.find((candidate) => candidate.counter === name)
  if (reading === undefined) throw new Error(`no ${name} reading in the payload`)
  return reading.value
}

/** A block: the one class that leaves the app and waits (EL-FR-07). */
function blockBody(
  transitionId = 'block-1',
  sessionId = SESSION,
  occurredAt = OCCURRED_AT,
): Record<string, unknown> {
  return {
    harness: 'opencode',
    eventName: 'permission.asked',
    sessionId,
    repoFullPath: REPO_PATH,
    transitionId,
    occurredAt,
  }
}

/** A finished turn, which is stored and never blocks anybody. */
function finishedBody(transitionId = 'finished-1'): Record<string, unknown> {
  return {
    harness: 'opencode',
    eventName: 'session.idle',
    variant: 'finished',
    sessionId: SESSION,
    repoFullPath: REPO_PATH,
    transitionId,
    occurredAt: OCCURRED_AT,
    turnWork: { toolCall: false, fileEdit: true, todoUpdate: false },
  }
}

/** An fyi: the class that never leaves the app (NT-FR-02). */
function fyiBody(transitionId = 'fyi-1'): Record<string, unknown> {
  return {
    harness: 'opencode',
    eventName: 'session.error',
    sessionId: SESSION,
    repoFullPath: REPO_PATH,
    transitionId,
    occurredAt: OCCURRED_AT,
  }
}

/** Post one signal over a real socket, and wait for anything it started. */
async function ingest(hub: RunningHub, body: unknown): Promise<Record<string, unknown>> {
  const response = await call(hub.origin, {
    method: 'POST',
    pathname: '/api/ingest',
    body: JSON.stringify(body),
  })
  expect(response.status, response.text).toBe(202)
  // The pipeline's own drain rather than a sleep: the store transition that moves the
  // pending set - and therefore the badge - has already happened by the time this
  // resolves, and this waits out the delivery it started.
  await hub.ingest.idle()
  return response.json<Record<string, unknown>>()
}

/** Acknowledge one pending item through the one write route, with the real token. */
async function acknowledge(hub: RunningHub, eventId: string): Promise<number> {
  const response = await call(hub.origin, {
    method: 'POST',
    pathname: `/api/ack/${eventId}`,
    headers: { [WRITE_TOKEN_HEADER]: hub.security.writeToken },
  })
  return response.status
}

/**
 * Wait for a fact, in real time.
 *
 * For the things this product does asynchronously on purpose: the ordered shutdown a
 * tray click starts is a promise the lifecycle owns, and a menu row cannot await one. A
 * test that assumed it had already finished would be asserting a race rather than a
 * behaviour; one that polls is asserting the behaviour.
 */
async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('a fact that should have become true never did')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** A short fingerprint of an icon's bytes, for "is this the same image". */
function digest(icon: TrayIcon): string {
  let hash = 2166136261
  for (const byte of icon.pixels) {
    hash = Math.imul(hash ^ byte, 16777619) >>> 0
  }
  return `${icon.width}x${icon.height}:${hash.toString(16)}:${icon.badge.label ?? '-'}`
}

// ---------------------------------------------------------------------------
// The fake desktop
// ---------------------------------------------------------------------------

interface FakeDesktop extends TrayBridge {
  /** Every icon the tray put on the desktop, in order. */
  readonly icons: TrayIcon[]
  /** Every menu the tray put on the desktop, in order. */
  readonly menus: TrayMenuView[]
  /** Every link the tray handed over, in order. */
  readonly opened: string[]
  /** How many times the tray took the icon back down. */
  destroys: number
  /** A shared event log, so orderings can be asserted. */
  readonly log: string[]
  /** What `openDashboard` answers. Changed by a test that needs another case. */
  dispatch: DeepLinkDispatch
  /** When set, `showIcon` throws this - a desktop that cannot take the icon. */
  iconFailure: Error | null
  /** When true, `destroy` throws - a desktop that will not let the icon go. */
  destroyFailure: boolean
  /** Runs when a link is handed over. The default records it and answers `dispatch`. */
  onOpen: (url: string) => DeepLinkDispatch
  /** The click handler the tray last registered, so a test can deliver a real click. */
  onActivateSaved: (() => void) | null
  /** A click on the icon, exactly as a desktop would deliver it. */
  click(): void
  /** A menu row, exactly as a desktop would deliver it. */
  choose(id: TrayMenuItemId): void
}

function fakeDesktop(overrides: Partial<DeepLinkDispatch> = {}): FakeDesktop {
  const icons: TrayIcon[] = []
  const menus: TrayMenuView[] = []
  const opened: string[] = []
  const log: string[] = []
  let activate: (() => void) | null = null
  const desktop: FakeDesktop = {
    icons,
    menus,
    opened,
    log,
    destroys: 0,
    dispatch: { kind: 'dashboard-request-follows' },
    iconFailure: null,
    destroyFailure: false,
    onActivateSaved: null,
    onOpen: (url: string): DeepLinkDispatch => {
      opened.push(url)
      log.push('open-dashboard')
      return desktop.dispatch
    },
    showIcon: (icon: TrayIcon): void => {
      if (desktop.iconFailure !== null) throw desktop.iconFailure
      icons.push(icon)
      log.push(`icon:${icon.badge.label ?? 'none'}`)
    },
    showMenu: (view: TrayMenuView): void => {
      menus.push(view)
      log.push('menu')
    },
    onActivate: (listener: () => void): void => {
      activate = listener
      desktop.onActivateSaved = listener
      log.push('activate-registered')
    },
    openDashboard: (url: string): DeepLinkDispatch => desktop.onOpen(url),
    destroy: (): void => {
      if (desktop.destroyFailure) throw new Error('the desktop would not take the icon down')
      desktop.destroys += 1
      log.push('destroy')
    },
    click: (): void => {
      if (activate === null) throw new Error('no click handler was registered')
      activate()
    },
    choose: (id: TrayMenuItemId): void => {
      const view = menus.at(-1)
      if (view === undefined) throw new Error('no menu was put on the desktop')
      view.select(id)
    },
  }
  void overrides
  return desktop
}

/** A tray built over a fake desktop and a pending set a test controls. */
function mountTray(options: {
  readonly desktop: FakeDesktop
  readonly pending: () => readonly PendingItem[]
  readonly origin?: () => string
  readonly quit?: () => void
  readonly dispatchCounters?: { dashboard: number; deepLink: number }
  /** A real change feed, for the tests about what the subscription does. */
  readonly feed?: ReturnType<typeof createChangeFeed>
}): HubTray {
  const counters = options.dispatchCounters ?? { dashboard: 0, deepLink: 0 }
  return createHubTray({
    bridge: options.desktop,
    readPending: options.pending,
    // Wrapped rather than passed by reference: the feed's `subscribe` reads private
    // state, so handing the method over unbound would fail on a real hub too.
    ...(options.feed === undefined
      ? {}
      : { subscribe: (subscriber: Parameters<typeof options.feed.subscribe>[0]): (() => void) => options.feed?.subscribe(subscriber) ?? ((): void => undefined) }),
    origin: options.origin ?? ((): string => 'http://127.0.0.1:43117'),
    counters: {
      recordDashboardOpen: (): void => {
        counters.dashboard += 1
      },
      recordDeepLinkOpen: (): void => {
        counters.deepLink += 1
      },
    },
    quit: options.quit ?? ((): void => undefined),
    onDiagnostic: (message) => diagnostics.push(message),
  })
}

/** `count` pending items, as the store's accessor would report them. */
function pendingItems(count: number, sessionId: string = SESSION): PendingItem[] {
  return Array.from({ length: count }, (_unused, index) => ({
    eventId: `evt_${String(index)}`,
    sessionId,
    harness: 'opencode',
    repoShortName: REPO_NAME,
    repoFullPath: REPO_PATH,
    class: 'needs-you' as const,
    subtype: null,
    rawEventType: 'permission.asked',
    occurredAt: OCCURRED_AT,
    receivedAt: OCCURRED_AT,
    dedupeKey: `dedupe_${String(index)}`,
    ackState: 'unacknowledged' as const,
    resolutionState: 'unresolved' as const,
  }))
}

// ---------------------------------------------------------------------------
// 1. The badge, through the real main entry point
// ---------------------------------------------------------------------------

describe('the badge follows the pending set the hub returns, through the real entry point', () => {
  it('mounts with no badge, and no badge at all for a hub with nothing outstanding', async () => {
    const desktop = fakeDesktop()
    const hub = await startFixtureHub({ desktop: { isPrimaryInstance: true, tray: desktop } })

    // Mounted: the real entry point built the tray and the icon went on the desktop
    // before anybody asked, which is NT-FR-05's "present for as long as the hub runs".
    expect(hub.tray).not.toBeNull()
    expect(hub.tray?.mounted).toBe(true)
    expect(desktop.icons).toHaveLength(1)

    // Zero pending: no badge, and the icon is the icon with nothing drawn on it.
    const badge = hub.tray?.badge()
    expect(badge?.kind).toBe('none')
    expect(badge?.label).toBeNull()
    expect(badge?.count).toBe(0)
    expect(hub.tray?.icon()?.badge.kind).toBe('none')
    // And the hub agrees: nothing is pending, over a real request.
    expect(await pendingCountFromHub(hub)).toBe(0)
    expect(hub.tray?.pendingCount()).toBe(0)
  })

  it('moves on a real block, on a real acknowledgement, and back to no badge', async () => {
    const desktop = fakeDesktop()
    const hub = await startFixtureHub({ desktop: { isPrimaryInstance: true, tray: desktop } })
    const tray = hub.tray
    if (tray === null) throw new Error('the hub mounted no tray')
    const blank = digest(tray.icon() as TrayIcon)

    // One real block, stored through the real pipeline over a real socket. The badge
    // has moved by the time the response is read, because the tray follows the store's
    // own applied transition rather than being asked later.
    const first = await ingest(hub, blockBody('block-1'))
    expect(first['outcome']).toBe('pending-created')
    expect(tray.badge()).toEqual({ kind: 'count', count: 1, label: '1', capped: false, glyphs: 1 })
    expect(await pendingCountFromHub(hub)).toBe(1)
    expect(tray.pendingCount()).toBe(1)
    expect(digest(tray.icon() as TrayIcon)).not.toBe(blank)

    // A second is a second, and the icon is redrawn for it.
    const second = await ingest(hub, blockBody('block-2'))
    expect(tray.badge().count).toBe(2)
    expect(tray.badge().label).toBe('2')
    expect(await pendingCountFromHub(hub)).toBe(2)

    // The one control surface a client has takes one away, and the icon follows it down
    // rather than waiting to be asked.
    expect(await acknowledge(hub, String(first['eventId']))).toBe(200)
    expect(tray.badge().count).toBe(1)
    expect(await pendingCountFromHub(hub)).toBe(1)
    expect(await acknowledge(hub, String(second['eventId']))).toBe(200)

    // Back to nothing: the same bytes as the icon that was mounted, which is what "no
    // badge shown at zero" means as a property of the image rather than of a label.
    expect(tray.badge().kind).toBe('none')
    expect(await pendingCountFromHub(hub)).toBe(0)
    expect(digest(tray.icon() as TrayIcon)).toBe(blank)
  })

  it('moves for a harness resolution too, and not at all for an event nobody waits on', async () => {
    const desktop = fakeDesktop()
    const hub = await startFixtureHub({ desktop: { isPrimaryInstance: true, tray: desktop } })
    const tray = hub.tray
    if (tray === null) throw new Error('the hub mounted no tray')

    // A finished turn and an fyi are both stored, and neither is a block: the badge
    // must not move for either, because a number that counts events rather than
    // outstanding work is a number nobody can act on (NT-FR-05, EL-FR-07).
    await ingest(hub, finishedBody())
    await ingest(hub, fyiBody())
    expect(tray.badge().kind).toBe('none')
    expect(await pendingCountFromHub(hub)).toBe(0)
    // Not one redraw for either: the icon the hub mounted is still the icon on screen.
    expect(desktop.icons).toHaveLength(1)

    // A block moves it, and the harness resolving that block moves it back.
    await ingest(hub, blockBody('block-1'))
    expect(tray.badge().count).toBe(1)
    await ingest(hub, {
      harness: 'opencode',
      eventName: 'permission.replied',
      sessionId: SESSION,
      repoFullPath: REPO_PATH,
      transitionId: 'block-1',
      occurredAt: OCCURRED_AT,
    })
    expect(tray.badge().kind).toBe('none')
    expect(await pendingCountFromHub(hub)).toBe(0)
  })

  it('mounts on a restarted hub already showing what was still outstanding', async () => {
    // The badge is the durable signal, so it cannot depend on this process having been
    // the one that saw the block (NT-FR-08, and the restart replay's own rule). Two
    // hubs over one state directory, with nothing in between but a restart.
    const stateDir = temporaryDirectory()
    const first = await startFixtureHub({ stateDir })
    await ingest(first, blockBody('block-1'))
    await ingest(first, blockBody('block-2', OLDER_SESSION, OLDER_OCCURRED_AT))
    expect(await pendingCountFromHub(first)).toBe(2)
    await first.close()

    const desktop = fakeDesktop()
    const second = await startFixtureHub({
      stateDir,
      desktop: { isPrimaryInstance: true, tray: desktop },
    })
    // The first icon this process ever put on a desktop already reads two, because the
    // icon is decided from the pending set at mount rather than from anything this run
    // has seen happen.
    expect(desktop.icons).toHaveLength(1)
    expect(desktop.icons[0]?.badge).toEqual({ kind: 'count', count: 2, label: '2', capped: false, glyphs: 1 })
    expect(await pendingCountFromHub(second)).toBe(2)
  })

  it('renders the capped marker on a mounted tray, and keeps the real count beside it', async () => {
    // NT-FR-05's third case, on a real tray rather than only on the pure rule: a hub
    // with a hundred and one outstanding items shows a marker, and the number that says
    // a hundred and one is still there in the decision and in the tooltip.
    const desktop = fakeDesktop()
    const tray = mountTray({ desktop, pending: (): PendingItem[] => pendingItems(101) })
    const badge = tray.badge()
    expect(badge.kind).toBe('capped')
    expect(badge.capped).toBe(true)
    expect(badge.count).toBe(101)
    expect(badge.label).toBe('99+')
    expect(tray.icon()?.tooltip).toContain('101')
    // And the marker's pixels, drawn rather than counted: this icon is not the icon for
    // a small count.
    expect(digest(tray.icon() as TrayIcon)).not.toBe(digest(drawTrayIcon(badgeFor(1))))
  })

  it('mounts no tray at all on a headless run, and says so by being null', async () => {
    // A supported run, not a degraded one: a test, `status` and a verification script
    // all run without a desktop, and a stub that answered as though an icon were on a
    // screen would be a lie nothing could check.
    const hub = await startFixtureHub()
    expect(hub.tray).toBeNull()
    expect(existsSync(hub.runtimeFilePath)).toBe(true)
    expect((await get(hub, '/api/health')).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// 2. The menu: exactly two actions, and no suppression control
// ---------------------------------------------------------------------------

describe('the tray menu is exactly open-dashboard and quit, with no way to forget a block', () => {
  it('offers two rows, and the view on the desktop is those two rows', async () => {
    const desktop = fakeDesktop()
    const tray = mountTray({ desktop, pending: (): PendingItem[] => [] })

    // The table, enumerated rather than restated: the ids come from the module.
    expect([...TRAY_MENU_ITEM_IDS]).toEqual(['open-dashboard', 'quit'])
    expect(TRAY_MENU_ITEMS).toHaveLength(2)
    expect(tray.menuItems()).toEqual([...TRAY_MENU_ITEMS])

    // And what actually went on the desktop, which is the claim that matters - a
    // product can have a two-row table and put something else on the screen.
    expect(desktop.menus).toHaveLength(1)
    expect(desktop.menus[0]?.items.map((item) => item.id)).toEqual(['open-dashboard', 'quit'])
    for (const item of desktop.menus[0]?.items ?? []) {
      expect(TRAY_MENU_ITEM_IDS).toContain(item.id)
      expect(item.label.length).toBeGreaterThan(0)
    }
  })

  it('carries the vocabulary of no suppression control anywhere in the menu', () => {
    // NT-FR-06 names mute, snooze and dismiss; a developer would also call it
    // silencing, ignoring, clearing, hiding, marking read or archiving. All of them
    // are the same affordance and none of them is here.
    // Word-bounded, because `ack` inside "come back" is not an acknowledgement
    // control - it is the copy answering the feature's own Open Question 4.
    const forbidden = /\b(?:mute|snooz|dismiss|silenc|ignor|clear|hide|archi|mark.?read|forget|suppress|resolv|ack)\b/i
    for (const item of TRAY_MENU_ITEMS) {
      expect(item.id, item.id).not.toMatch(forbidden)
      expect(item.label, item.id).not.toMatch(forbidden)
    }
    // The two ids that exist are the two the requirement names, spelled as its own
    // words rather than as a synonym.
    expect(TRAY_MENU_ITEMS.map((item) => item.id)).toEqual(['open-dashboard', 'quit'])
  })

  it('tells the developer in the copy that quitting is safe with a block outstanding', () => {
    // The feature document's Open Question 4: the answer is yes, because the pending
    // set is durable and the restart replay re-announces it, so the answer goes in the
    // menu rather than in a confirmation dialog that nags about a decision they are
    // entitled to make.
    const quit = TRAY_MENU_ITEMS.find((item) => item.id === 'quit')
    expect(quit?.label).toMatch(/restart/i)
    expect(quit?.label).toMatch(/come back|return/i)
    // It does not promise the block is gone, because it is not.
    expect(quit?.label).not.toMatch(/forget|ignore|dismiss|clear/i)
  })

  it('exposes no method that could suppress, mark read, acknowledge or resolve anything', () => {
    // A tray with a `dismiss` on it would be the affordance the requirement forbids,
    // and a tray with an `acknowledge` on it would be a second way to mutate the one
    // thing a client request is allowed to mutate (APX-CON-08). The surface is
    // enumerated, so a new method is a failing test rather than a review finding.
    const desktop = fakeDesktop()
    const tray = mountTray({ desktop, pending: (): PendingItem[] => pendingItems(2) })
    expect(Object.keys(tray).sort()).toEqual([
      'activate',
      'badge',
      'close',
      'icon',
      'menuItems',
      'mounted',
      'pendingCount',
      'refresh',
      'select',
    ])
    for (const forbidden of [
      'mute',
      'snooze',
      'dismiss',
      'clear',
      'hide',
      'ignore',
      'ack',
      'acknowledge',
      'resolve',
      'mark',
      'prompt',
      'approve',
      'send',
      'notify',
      'deliver',
    ]) {
      expect(Object.keys(tray), forbidden).not.toContain(forbidden)
    }
  })

  it('routes the quit row to the hub\'s own ordered shutdown, not to a second one', async () => {
    // Through the real entry point, so what the tray calls is the hub's lifecycle and
    // not a test's function: a quit from the menu must take the same path a signal
    // takes (HC-FR-10).
    const desktop = fakeDesktop()
    const hub = await startFixtureHub({
      desktop: { isPrimaryInstance: true, tray: desktop },
      lifecycle: {
        installSignals: false,
        exit: (): void => {
          exits.push('exit')
        },
      },
    })
    const tray = hub.tray
    if (tray === null) throw new Error('the hub mounted no tray')

    // The row, delivered the way a desktop delivers it: by id, through the view the
    // tray put on the screen.
    expect(tray.select('open-dashboard')).not.toBeNull()
    desktop.choose('quit')

    // The ordered shutdown ran: the icon is down, the runtime file is released, and the
    // lifecycle's exit was reached with the tray's own reason on it. It is awaited by
    // the lifecycle rather than by the tray - a menu click cannot await anything - so
    // the test waits for the fact instead of assuming it has already happened.
    await until((): boolean => !existsSync(hub.runtimeFilePath))
    expect(exits).toEqual(['exit'])
    expect(hub.lifecycle.state().state).toBe('stopped')
    expect(desktop.destroys).toBe(1)
    expect(tray.mounted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. A click resolves a deep link, and counts the open exactly once
// ---------------------------------------------------------------------------

describe('clicking the icon resolves a deep link to the session that has waited longest', () => {
  it('hands the desktop a link to the oldest outstanding session, and the hub counts the open once', async () => {
    const desktop = fakeDesktop()
    // The desktop really opens it: a real request over a real socket, which is what a
    // window pointed at a loopback URL does. So the counters move through the hub's own
    // dashboard route rather than through a method the tray called itself (HC-6).
    const hub = await startFixtureHub({ desktop: { isPrimaryInstance: true, tray: desktop } })
    const tray = hub.tray
    if (tray === null) throw new Error('the hub mounted no tray')
    await ingest(hub, blockBody('block-new', SESSION, '2026-09-26T10:00:00.000Z'))
    await ingest(hub, blockBody('block-old', OLDER_SESSION, OLDER_OCCURRED_AT))

    // Zero before, so every increment below is attributable to the click.
    expect(await counterOf(hub, 'deep_link_opens')).toBe(0)
    expect(await counterOf(hub, 'dashboard_opens')).toBe(0)

    const served: Promise<Fetched>[] = []
    desktop.onOpen = (url: string): DeepLinkDispatch => {
      desktop.opened.push(url)
      const target = new URL(url)
      served.push(call(hub.origin, { method: 'GET', pathname: `${target.pathname}${target.search}` }))
      return desktop.dispatch
    }
    // The click, delivered the way a desktop delivers it: through the handler the tray
    // registered with the bridge, and once. One click, so every increment below is
    // attributable to it rather than to a second one a test made while reaching for a
    // return value.
    const activation = tray.activate()
    const responses = await Promise.all(served)

    // The link names the oldest outstanding session - the one that has been waiting
    // longest, the same order the restart replay uses - and nothing but the loopback
    // origin, the dashboard and that one session (NT-FR-07, APX-FR-01).
    expect(desktop.opened).toEqual([`${hub.origin}/?${DEEP_LINK_QUERY_KEY}=${OLDER_SESSION}`])
    expect(activation.target).toBe('deep-link')
    // The tray itself recorded nothing, because a document request is on its way: the
    // route counts it. One open and one deep link for one click - and not two of either,
    // which is the double count HC-6 warned about (APX-FR-02).
    expect(activation.countedBy).toBe('dashboard-request')
    expect(await counterOf(hub, 'dashboard_opens')).toBe(1)
    expect(await counterOf(hub, 'deep_link_opens')).toBe(1)
    // And the request really was served the document, at the link the tray resolved.
    expect(responses.at(0)?.status).toBe(200)
    expect(responses.at(0)?.text).toContain('agent-ping')
    // The second click, delivered through the bridge's registered handler rather than
    // through the tray's own method, is the same operation and the same one count: a
    // developer's click on the icon is what a test calling `activate` simulates, and
    // the wiring in between is the point of the assertion.
    desktop.click()
    const second = await Promise.all(served.slice(1))
    expect(second.at(0)?.status).toBe(200)
    expect(desktop.opened).toHaveLength(2)
    expect(await counterOf(hub, 'dashboard_opens')).toBe(2)
    expect(await counterOf(hub, 'deep_link_opens')).toBe(2)
  })

  it('counts the open itself when the desktop resolves the target without a request', async () => {
    // The other half of HC-6's rule. A desktop that focused a window it already had
    // open, at this same deep link, produces no document request - and then nobody but
    // the tray would count the open, which would make an open counted nowhere.
    const desktop = fakeDesktop()
    desktop.dispatch = { kind: 'resolved-without-request' }
    const hub = await startFixtureHub({ desktop: { isPrimaryInstance: true, tray: desktop } })
    const tray = hub.tray
    if (tray === null) throw new Error('the hub mounted no tray')
    await ingest(hub, blockBody())

    desktop.click()
    expect(desktop.opened).toEqual([`${hub.origin}/?${DEEP_LINK_QUERY_KEY}=${SESSION}`])
    // Both counters, because NT-FR-07 says opening a toast's link focuses the session
    // *and* counts as a dashboard open.
    expect(await counterOf(hub, 'dashboard_opens')).toBe(1)
    expect(await counterOf(hub, 'deep_link_opens')).toBe(1)
    // And the open-dashboard row is the same operation as the click, so it resolves the
    // same link rather than a second answer to the same question.
    const viaMenu = desktop.menus[0] !== undefined ? tray.select('open-dashboard') : null
    expect(viaMenu?.url).toBe(`${hub.origin}/?${DEEP_LINK_QUERY_KEY}=${SESSION}`)
    expect(await counterOf(hub, 'dashboard_opens')).toBe(2)
  })

  it('opens the plain dashboard, counted once, when nothing is outstanding', async () => {
    // No session to focus is not a failure and not a lost click: the dashboard is what
    // the row says it is, and an empty `?session=` is explicitly not a deep link
    // (src/hub/metrics.ts), so it must not be counted as one.
    const desktop = fakeDesktop()
    desktop.dispatch = { kind: 'resolved-without-request' }
    const hub = await startFixtureHub({ desktop: { isPrimaryInstance: true, tray: desktop } })
    const tray = hub.tray
    if (tray === null) throw new Error('the hub mounted no tray')

    tray.activate()
    expect(desktop.opened).toEqual([`${hub.origin}/`])
    expect(await counterOf(hub, 'dashboard_opens')).toBe(1)
    expect(await counterOf(hub, 'deep_link_opens')).toBe(0)
  })

  it('resolves the same link the notifier builds for a toast, so the two agree', () => {
    // NT-FR-07 has two consumers: the link a toast carries (built by the one class
    // policy) and the link a tray click resolves. If they disagreed, a developer would
    // follow one and land somewhere the other was not - and the two are built in
    // different files by different tasks, so "they agree" is a fact to check rather
    // than a consequence of there being one URL builder.
    const desktop = fakeDesktop()
    const tray = mountTray({ desktop, pending: (): PendingItem[] => pendingItems(1, SESSION) })
    tray.activate()
    const plan = planNotification({
      class: 'needs-you',
      repoShortName: REPO_NAME,
      origin: 'http://127.0.0.1:43117',
      sessionId: SESSION,
    })
    if (plan.kind !== 'deliver') throw new Error('a needs-you plan must deliver')
    expect(desktop.opened).toEqual([plan.request.deepLink])
    expect(desktop.opened[0]).toBe(`http://127.0.0.1:43117/?${DEEP_LINK_QUERY_KEY}=${SESSION}`)
  })

  it('reports a click that opened nothing, and counts nothing for it', async () => {
    // Three different faults, three different reasons, and in every one of them no
    // counter moves: a click that did nothing must not be a click that counted
    // something (APX-FR-02, ADR-010).
    const counters = { dashboard: 0, deepLink: 0 }
    const throwing = fakeDesktop()
    throwing.onOpen = (): DeepLinkDispatch => {
      throw new Error('no window server on this display')
    }
    const byThrow = mountTray({ desktop: throwing, pending: (): PendingItem[] => pendingItems(1), dispatchCounters: counters })
    const thrown = byThrow.activate()
    expect(thrown.countedBy).toBe('nobody')
    expect(thrown.reason).toBe('bridge-threw')
    expect(thrown.url).toBe('http://127.0.0.1:43117/?session=ses_tray_01')
    expect(diagnostics.filter((line) => line.includes('could not open the dashboard'))).toHaveLength(1)

    const refusing = fakeDesktop()
    refusing.dispatch = { kind: 'unavailable', reason: 'bridge-refused' }
    const byRefusal = mountTray({ desktop: refusing, pending: (): PendingItem[] => pendingItems(1), dispatchCounters: counters })
    const refused = byRefusal.activate()
    expect(refused.countedBy).toBe('nobody')
    expect(refused.reason).toBe('bridge-refused')
    expect(diagnostics.filter((line) => line.includes('could not open the dashboard'))).toHaveLength(2)

    // No live origin is the third: there is no other origin this product may use, so
    // the honest answer is a reported fault and a link that was never built.
    const noOrigin = fakeDesktop()
    const originless = mountTray({
      desktop: noOrigin,
      pending: (): PendingItem[] => pendingItems(1),
      origin: (): string => '',
      dispatchCounters: counters,
    })
    const orphan = originless.activate()
    expect(orphan.url).toBeNull()
    expect(orphan.target).toBe('none')
    expect(orphan.reason).toBe('no-live-origin')
    expect(noOrigin.opened).toEqual([])
    expect(diagnostics.filter((line) => line.includes('no live loopback origin'))).toHaveLength(1)
    // And a fourth, which is not a failure at all: a pending read that breaks after
    // the tray is mounted. The click still opens the dashboard - which is what the row
    // promised - and says that it could not focus a session, rather than focusing the
    // wrong one or failing the click.
    const unreadable = fakeDesktop()
    let readable = true
    const broken = mountTray({
      desktop: unreadable,
      pending: (): PendingItem[] => {
        if (!readable) throw new Error('the log is not readable')
        return pendingItems(1)
      },
      dispatchCounters: counters,
    })
    readable = false
    expect(broken.activate().url).toBe('http://127.0.0.1:43117/')
    expect(unreadable.opened).toEqual(['http://127.0.0.1:43117/'])
    expect(
      diagnostics.filter((line) => line.includes('without focusing a session')),
    ).toHaveLength(1)

    // Not one counter moved for any of the three.
    expect(counters).toEqual({ dashboard: 0, deepLink: 0 })
  })
})

// ---------------------------------------------------------------------------
// 4. Presence, the mechanism, and the teardown
// ---------------------------------------------------------------------------

describe('the icon is present for as long as the hub runs, and gone before the log closes', () => {
  it('puts the icon up before the hub reports running, and takes it down on close', async () => {
    const desktop = fakeDesktop()
    const order: string[] = []
    desktop.showIcon = (icon: TrayIcon): void => {
      desktop.icons.push(icon)
      order.push('icon')
    }
    desktop.showMenu = (view: TrayMenuView): void => {
      desktop.menus.push(view)
      order.push('menu')
    }
    desktop.onActivate = (listener: () => void): void => {
      desktop.onActivateSaved = listener
      order.push('activate-registered')
    }

    let stateAtFirstIcon = ''
    const hub = await startFixtureHub({
      desktop: {
        isPrimaryInstance: true,
        tray: desktop,
        onHubReady: (ready: RunningHub): void => {
          order.push('onHubReady')
          // The two facts PRD 10's `running` is made of, observed from inside the hub:
          // the icon is already on the desktop, and the tray is reachable.
          stateAtFirstIcon = ready.lifecycle.state().state
          expect(ready.tray?.mounted).toBe(true)
        },
      },
    })
    expect(order).toEqual(['icon', 'menu', 'activate-registered', 'onHubReady'])
    expect(stateAtFirstIcon).toBe('running')

    // The tray is subscribed to the hub's own change feed, which is the mechanism
    // rather than a timer: a hub with no tray has no subscriber, and this one has
    // exactly the tray's.
    expect(hub.stream.subscriberCount()).toBe(1)
    const headless = await startFixtureHub()
    expect(headless.stream.subscriberCount()).toBe(0)

    // On the way down: the log is still readable when the icon is taken away, which is
    // what "the tray stops before the log does" means as a fact rather than as an
    // intention. A tray that outlived the log would redraw from a closed database, or
    // leave an icon advertising a hub that no longer answers.
    let readableAtDestroy: string | null = null
    const closable = fakeDesktop()
    closable.showIcon = (icon: TrayIcon): void => {
      closable.icons.push(icon)
    }
    closable.showMenu = (view: TrayMenuView): void => {
      closable.menus.push(view)
    }
    closable.destroy = (): void => {
      closable.destroys += 1
      try {
        readableAtDestroy = `readable:${String(hub.store.readPending().length)}`
      } catch (cause) {
        readableAtDestroy = `closed:${cause instanceof Error ? cause.message : String(cause)}`
      }
    }
    const other = await startFixtureHub({ desktop: { isPrimaryInstance: true, tray: closable } })
    await other.close()
    expect(closable.destroys).toBe(1)
    expect(readableAtDestroy).toBe('readable:0')
    expect(other.stream.subscriberCount()).toBe(0)

    // And the running hub's own close takes it down too, once, however many times it
    // is called - a shutdown can be triggered by a signal, a quit and a test.
    await hub.close()
    expect(desktop.destroys).toBe(1)
    await hub.close()
    expect(desktop.destroys).toBe(1)
    expect(hub.tray?.mounted).toBe(false)
    expect(hub.stream.subscriberCount()).toBe(0)
  })

  it('mounts the tray before the hub reports running, as the order the entry point uses', () => {
    // The observable half of that rule is the assertion above: the icon is on the
    // desktop before the desktop is told the hub is ready. The position of
    // `markRunning` itself has no in-process observable, and saying so is more useful
    // than pretending otherwise: the mount is synchronous, so it holds the event loop,
    // and a health request cannot be answered while it runs - the two orders answer the
    // same request identically.
    //
    // So the order is asserted against the composition root's own source. A change
    // that moved the mount below `markRunning()` would then be a failing test rather
    // than something a reviewer has to notice in a thousand-line file - and PRD 10's
    // `running` means "accepting events, with the tray present", which is only true if
    // the icon is up first.
    const source = readFileSync(path.join(repositoryRoot(), 'src/main/index.ts'), 'utf8')
    const startHub = source.slice(source.indexOf('export async function startHub'))
    const mount = startHub.indexOf('createHubTray(')
    const running = startHub.indexOf('lifecycle.markRunning()')
    expect(mount, 'the tray is mounted inside startHub').toBeGreaterThan(-1)
    expect(running, 'the hub reports running').toBeGreaterThan(-1)
    expect(mount).toBeLessThan(running)
  })

  it('follows the pending set from applied transitions, and not from a heartbeat', async () => {
    // A real feed with a real heartbeat, so "a heartbeat is a keepalive and not a
    // change" is observed rather than asserted: without the distinction the badge would
    // be redrawn by a timer, which is a poll wearing a subscription's clothes.
    const desktop = fakeDesktop()
    const feed = createChangeFeed({ heartbeatIntervalMs: 5, replayMaxFrames: 8 })
    let reads = 0
    const tray = mountTray({
      desktop,
      feed,
      pending: (): PendingItem[] => {
        reads += 1
        return pendingItems(reads)
      },
    })
    // The mount itself is exercised through the real entry point above; what this is
    // about is what the subscription does with a transition and with a heartbeat.
    expect(reads).toBe(1)
    expect(feed.subscriberCount()).toBe(1)
    const beat = (): void => {
      feed.publish(change())
    }
    // Several heartbeats' worth of time with no transition: not one read, and not one
    // redraw. This is the half of the rule that stops a badge being a poll.
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(reads).toBe(1)
    expect(desktop.icons).toHaveLength(1)

    // One applied transition is one read, because that is the only thing that can have
    // changed what is outstanding.
    beat()
    expect(reads).toBe(2)
    expect(tray.pendingCount()).toBe(2)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reads).toBe(2)
    // And the closing is the tray's: unsubscribed before the feed goes, so no read can
    // arrive after the hub has stopped.
    tray.close()
    expect(feed.subscriberCount()).toBe(0)
    feed.close()
  })

  it('keeps the last number it could read when the pending set cannot be read', async () => {
    // A log that cannot be read is already `degraded` on health, and a badge that went
    // blank at the moment a block appeared would be the wrong answer twice over. So the
    // number stays, the fault is reported, and the tray is still following afterwards -
    // a throw here would be caught by the feed's own client guard, which *unsubscribes*
    // the tray, and the badge would freeze for the rest of the run in silence.
    const desktop = fakeDesktop()
    const feed = createChangeFeed({ heartbeatIntervalMs: 0 })
    let fail = false
    const tray = mountTray({
      desktop,
      feed,
      pending: (): PendingItem[] => {
        if (fail) throw new Error('the log is not readable')
        return pendingItems(3)
      },
    })
    expect(tray.badge().count).toBe(3)

    fail = true
    feed.publish(change())
    expect(tray.badge().count).toBe(3)
    expect(desktop.icons).toHaveLength(1)
    expect(diagnostics.filter((line) => line.includes('could not be read'))).toHaveLength(1)

    // Still subscribed: the fault was reported and the badge kept, not the other way
    // round, and the next readable transition moves it.
    fail = false
    feed.publish(change())
    expect(tray.badge().count).toBe(3)
    expect(feed.subscriberCount()).toBe(1)
    tray.close()
    feed.close()
  })

  it('leaves nothing on the desktop when the desktop refuses the icon, and keeps serving', async () => {
    // A tray that could not be mounted is a missing icon, never a lost block
    // (ADR-010), and a hub that refuses to serve over a missing tray would be a worse
    // trade than a missing icon.
    const refusing = fakeDesktop()
    refusing.iconFailure = new Error('no status area on this desktop')
    expect(() =>
      mountTray({ desktop: refusing, pending: (): PendingItem[] => pendingItems(1) }),
    ).toThrow(/the tray could not be mounted/)
    // The refusal was undone rather than left for a caller to clean up: whatever the
    // bridge was already given, it was given back.
    expect(refusing.destroys).toBe(1)

    // Through the real entry point: the hub runs, says so, and `tray` is null rather
    // than an object that answers as though an icon were on a screen.
    const hub = await startFixtureHub({
      desktop: { isPrimaryInstance: true, tray: refusing },
    })
    expect(hub.tray).toBeNull()
    expect(
      diagnostics.filter((line) => line.includes('could not mount its tray icon')),
    ).toHaveLength(1)
    expect((await get(hub, '/api/health')).status).toBe(200)
    // The pending set, the log and the notifications are all still correct: a block
    // stored now is a block the dashboard shows, which is where the record lives.
    await ingest(hub, blockBody())
    expect(await pendingCountFromHub(hub)).toBe(1)
  })

  it('reports a desktop that will not let the icon go, and unsubscribes anyway', async () => {
    // The icon stays on screen for a moment, and that is a fault somebody has to be
    // told about rather than a shutdown that quietly continues (APX-FR-02). The
    // subscription is dropped first regardless, so a bridge that throws cannot leave
    // this tray reading a closed log.
    const desktop = fakeDesktop()
    desktop.destroyFailure = true
    const tray = mountTray({ desktop, pending: (): PendingItem[] => pendingItems(1) })
    tray.close()
    expect(tray.mounted).toBe(false)
    expect(
      diagnostics.filter((line) => line.includes('could not be taken off the desktop')),
    ).toHaveLength(1)
    // Idempotent, and no second attempt at a bridge that has already said no.
    tray.close()
    expect(desktop.destroys).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 5. No sound, no repeat timer, no way out of the machine
// ---------------------------------------------------------------------------

describe('neither tray module can sound, repeat, or leave this machine', () => {
  it('has no sound-capable value and no timer in either module', () => {
    for (const file of ['src/hub/tray.ts', 'src/tray/badge.ts']) {
      const code = codeOf(file)
      for (const forbidden of [
        'sound',
        'audio',
        'beep',
        'bell',
        'setTimeout',
        'setInterval',
        'setImmediate',
        'requestAnimationFrame',
        'Notification',
        'shell.openExternal',
      ]) {
        // The prose in the headers is stripped first: both modules discuss sound and
        // the desktop at length, and the rule is about the values and the calls.
        expect(code.includes(forbidden), `${file} contains ${forbidden}`).toBe(false)
      }
    }
  })

  it('has no outbound call and no statement of its own in either module', () => {
    for (const file of ['src/hub/tray.ts', 'src/tray/badge.ts']) {
      const code = codeOf(file)
      for (const outbound of [
        'fetch(',
        'node:http',
        'node:https',
        'node:net',
        'node:dgram',
        'node:child_process',
        'XMLHttpRequest',
        'sendBeacon',
        'WebSocket',
        'process.env',
      ]) {
        expect(code.includes(outbound), `${file} contains ${outbound}`).toBe(false)
      }
      // The tray is handed an accessor and two counter methods, and holds no handle:
      // it cannot write a row, and it cannot write anything but a count.
      for (const own of ['new Database', '.prepare(', '.exec(', '.run(']) {
        expect(code.includes(own), `${file} contains ${own}`).toBe(false)
      }
    }
  })

  it('opens no window of its own: the deep link is a string handed to the desktop', () => {
    // ADR-009: the dashboard is on demand. The tray builds a loopback URL and the
    // desktop decides what to do with it, which is the only thing in this product that
    // decides to show the developer something.
    const desktop = fakeDesktop()
    const tray = mountTray({ desktop, pending: (): PendingItem[] => pendingItems(1) })
    tray.activate()
    expect(desktop.opened).toEqual(['http://127.0.0.1:43117/?session=ses_tray_01'])
    // The link is loopback, the dashboard, and one session. No path, no repository, no
    // harness and no event text (APX-FR-01, APX-CON-01).
    const url = new URL(String(desktop.opened[0]))
    expect(url.protocol).toBe('http:')
    expect(url.hostname).toBe('127.0.0.1')
    expect(url.pathname).toBe('/')
    expect([...url.searchParams.keys()]).toEqual([DEEP_LINK_QUERY_KEY])
    expect(url.search).not.toContain(REPO_PATH)
    expect(url.search).not.toContain(REPO_NAME)
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One change frame's worth of report, for a feed nobody is listening to. */
function change(): StateChange {
  const item = pendingItems(1)[0]
  if (item === undefined) throw new Error('pendingItems(1) produced nothing')
  return {
    kind: 'event-stored',
    event: item,
    session: null,
    pendingCount: 1,
    cursor: 1,
    at: OCCURRED_AT,
  }
}

function repositoryRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/**
 * A module's code, with its prose taken out.
 *
 * Whole-line comments only, and deliberately: both modules discuss sound, the desktop
 * and the cap in their headers, and the rules being checked are about the values and
 * the calls rather than about the sentences.
 */
function codeOf(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot(), relativePath), 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
}
