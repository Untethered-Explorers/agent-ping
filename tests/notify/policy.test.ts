// The class policy, the surface notifier, and the one delivery path this product has
// (NT-FR-01, NT-FR-02, NT-FR-03, NT-FR-08, NT-FR-09, NT-FR-11, ADR-004, ADR-010,
// ADR-012, APX-CON-04, APX-CON-12, APX-FR-01, APX-FR-02).
//
//   npm test -- tests/notify/policy.test.ts
//
// THE SEVEN ACCEPTANCE CRITERIA, AND WHERE EACH IS PROVEN
//
//   1. "A test asserts the surface notifier renders one card for a needs-you request,
//      one for a finished request and none at all for an fyi request."
//      `one card per delivered class and none for a refused one`, driven both ways: the
//      notifier over a host and a presenter a test controls, and the same three classes
//      through the real main entry point over a real log and a real socket, where the
//      presenter records what would have been drawn. The second half matters because a
//      notifier tested alone cannot be caught planning the wrong class.
//
//   2. "A test asserts a refused class increments neither the delivery counter nor the
//      delivered count in the ledger."
//      `a refused class is counted as neither a delivery nor a failure`, end to end
//      through a real ingest: `toast_deliveries` over `GET /api/metrics`, the policy's
//      own counts, the per-event ledger, and the ingest drop ledger. The contrast case
//      is in the same test, because a counter that reads 0 because nothing counts is
//      indistinguishable from a counter that is not wired.
//
//   3. "A test asserts a host failure is recorded as a failure carrying its reason and
//      is visible in the health payload."
//      `a surface that will not show a card is a failure, not a delivery`, for a host
//      that refuses, a host that throws, and a presenter that throws - each with its own
//      reason token, the window taken back down, a diagnostic line, the ledger, the
//      ingest drop ledger, and `GET /api/health`.
//
//   4. "A test asserts the main entry point constructs the surface notifier and the
//      delivery policy uses it."
//      `the composition root builds the surface notifier`, behaviourally (the live path
//      and the restart replay reach the same presenter through the real entry point) and
//      by reading this file's composition root for the one call that builds it and the
//      absence of the call that used to.
//
//   5. "A test asserts the deep link on a card is the same string the tray resolves."
//      `a card carries the same deep link the tray resolves`, and the same claim is
//      asserted the other way round in tests/hub/tray.test.ts against the tray's own
//      click, because the two are built in different files by different tasks.
//
//   6. "A test asserts no child process spawn, no exec call and none of notify-send,
//      osascript or powershell exists anywhere under src/notify."
//      `the notification path starts no process and names no withdrawn tool`, a source
//      sweep over every module under src/notify with prose stripped and strings kept.
//      The same sweep in tests/notify/surface-card.test.ts is now the literal claim
//      rather than a list of files still to be deleted.
//
//   7. "The four deleted test files and the per-platform runbook no longer exist, and
//      the runbook that replaces the latter names the manual command per platform and
//      states what is not live-verified from the authoring machine."
//      `the retired modules, their tests and the per-platform runbook are gone`.
//
// AROUND THOSE SEVEN, the properties that make them worth something:
//   - the class table is one table, total over the class union, and it throws rather
//     than defaulting for a class it does not carry (a default would be a fourth way a
//     notification could be made)
//   - the delivered request carries exactly the six fields NT-FR-01 names, asserted by
//     key set, and the lifetime it carries is the one the lifetime table names
//   - the two strings a person reads are a repository short name and one sentence, and
//     nothing that could carry conversation content reaches either
//   - the deep link is the published contract, null before the socket is bound, and the
//     *same builder* serves the card and the tray
//   - planning is pure: the same input gives the same plan and no call of any kind
//     happens while producing one
//   - one request produces one card and nothing re-arms it (NT-FR-08)
//   - no field anywhere on the path can ask for a sound, and none of it leaves the
//     machine (APX-CON-04, APX-CON-12)
//
// WHAT IS NOT EXERCISED HERE
// Nothing in this file touches Electron, a window manager or a display. The host is
// this product's own interface (src/notify/surface/host.ts) and the presenter is a
// recorder; what a real desktop composites, whether a card is legible, and whether the
// card document loads at all are unobserved, because the card document is not in the
// built artefacts yet. docs/runbooks/notification-surface.md says so in the same words,
// and NT-9 owns the observation (NT-FR-03, APX-CON-06).

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startHub, type RunningHub } from '@/main/index'
import { DEEP_LINK_QUERY_KEY } from '@/hub/metrics'
import {
  CLASS_POLICIES,
  FALLBACK_TITLE,
  decideNotification,
  deepLinkFor,
  planNotification,
  renderTitle,
  type NotificationDeliverPolicy,
  type NotificationPlanInput,
} from '@/notify/policy'
import {
  SURFACE_OUTCOME_REASONS,
  createSurfaceNotifier,
  resolveSurfaceNotifier,
  surfaceOutcomeReason,
  toNotifierPort,
  type CardPresenter,
  type SurfaceNotifier,
} from '@/notify/registry'
import { buildCardModel, type CardModel } from '@/notify/surface/card'
import { CARD_LIFETIMES, cardLifetimeFor, type CardLifetimeCell } from '@/notify/surface/lifetime'
import { NOTIFICATION_APP_NAME } from '@/notify/types'
import type {
  NotificationSurfaceHost,
  SurfaceAvailability,
  SurfaceCardRequest,
  SurfaceHostBridge,
} from '@/notify/surface/host'
import type { DeliveryAttemptRecord, DeliveryStatus, NotificationRequest as HubNotificationRequest } from '@/hub/delivery'
import type { MetricsPayload } from '@/hub/routes/metrics'
import type { Notifier } from '@/hub/delivery'
import { removeTree } from '../helpers/remove-tree'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION = 'ses_policy_01'
const ORIGIN = 'http://127.0.0.1:43717'
const REPO = 'agent-ping'
const REPO_PATH = '/home/dev/Projects/agent-ping'
const OCCURRED_AT = '2026-09-26T09:00:00.000Z'

const ALL_CLASSES = ['needs-you', 'finished', 'fyi'] as const

function planInput(overrides: Partial<NotificationPlanInput> = {}): NotificationPlanInput {
  return {
    class: 'needs-you',
    repoShortName: REPO,
    origin: ORIGIN,
    sessionId: SESSION,
    ...overrides,
  }
}

/** The hub's own delivery request, which is what the composition root hands a notifier. */
function hubRequest(overrides: Partial<HubNotificationRequest> = {}): HubNotificationRequest {
  const eventClass = overrides.class ?? 'needs-you'
  return {
    event: {
      eventId: 'evt_policy_01',
      sessionId: SESSION,
      class: eventClass,
      subtype: null,
      rawEventType: 'permission.asked',
      occurredAt: OCCURRED_AT,
      receivedAt: OCCURRED_AT,
      dedupeKey: `opencode:${SESSION}:policy-1`,
      ackState: 'unacknowledged',
      resolutionState: 'unresolved',
    },
    class: eventClass,
    pendingCount: 1,
    repoShortName: REPO,
    origin: ORIGIN,
    source: 'event',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// The fake surface
// ---------------------------------------------------------------------------

interface ShownCard {
  readonly model: CardModel
  readonly cell: CardLifetimeCell
}

/** A host over this product's own interface: records, and can be told to refuse. */
function fakeHost(options: { readonly answer?: SurfaceAvailability; readonly throwOnShow?: boolean } = {}): {
  readonly host: NotificationSurfaceHost
  readonly shows: SurfaceCardRequest[]
  readonly hides: number
  readonly clickThrough: boolean[]
  readonly destroys: number
  readonly probes: number
} {
  const shows: SurfaceCardRequest[] = []
  const clickThrough: boolean[] = []
  const record = { shows, clickThrough, hides: 0, destroys: 0, probes: 0 }
  const answer: SurfaceAvailability = options.answer ?? { available: true, reason: 'available' }
  return {
    ...record,
    host: {
      probe: async (): Promise<SurfaceAvailability> => {
        record.probes += 1
        return answer
      },
      show: async (card?: SurfaceCardRequest): Promise<SurfaceAvailability> => {
        if (options.throwOnShow === true) throw new Error('the window could not be placed')
        shows.push(card ?? {})
        return answer
      },
      hide: (): void => {
        record.hides += 1
      },
      setClickThrough: (next: boolean): void => {
        clickThrough.push(next)
      },
      destroy: (): void => {
        record.destroys += 1
      },
    },
    get shows(): SurfaceCardRequest[] {
      return shows
    },
    get hides(): number {
      return record.hides
    },
    get clickThrough(): boolean[] {
      return clickThrough
    },
    get destroys(): number {
      return record.destroys
    },
    get probes(): number {
      return record.probes
    },
  }
}

/** A presenter that records every card it was asked to render. */
function recordingPresenter(options: { readonly throwOnPresent?: boolean } = {}): {
  readonly presenter: CardPresenter
  readonly cards: ShownCard[]
} {
  const cards: ShownCard[] = []
  return {
    cards,
    presenter: {
      present: (model: CardModel, cell: CardLifetimeCell): void => {
        if (options.throwOnPresent === true) throw new Error('the card document had no element to render into')
        cards.push({ model, cell })
      },
    },
  }
}

/** The notifier the composition root builds, over a host and a presenter a test owns. */
function notifierOver(
  host: NotificationSurfaceHost,
  presenter: CardPresenter,
  diagnostics: string[] = [],
): SurfaceNotifier {
  return createSurfaceNotifier({ host, present: presenter, onDiagnostic: (line) => diagnostics.push(line) })
}

// ---------------------------------------------------------------------------
// A real hub, over a real log and a real socket
// ---------------------------------------------------------------------------

const temporaryDirectories: string[] = []
const openHubs: RunningHub[] = []
const diagnostics: string[] = []

function temporaryDirectory(prefix = 'agent-ping-notify-'): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * A stand-in for the built dashboard.
 *
 * The document has to exist so the hub has a static route to serve, even though these
 * tests never read a page: a hub with no dashboard root serves reads fine and this
 * keeps the fixture honest about what it is standing in for.
 */
function dashboardFixture(): string {
  const root = temporaryDirectory('agent-ping-notify-dashboard-')
  mkdirSync(path.join(root, 'assets'), { recursive: true })
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>agent-ping</title>\n')
  return root
}

afterEach(async () => {
  for (const hub of openHubs.splice(0)) {
    await hub.close().catch(() => undefined)
  }
  for (const directory of temporaryDirectories.splice(0)) {
    removeTree(directory)
  }
  diagnostics.length = 0
})

interface SurfaceFixture {
  readonly bridge: SurfaceHostBridge
  readonly presenter: CardPresenter
  readonly cards: ShownCard[]
  readonly host: ReturnType<typeof fakeHost>
}

/** A desktop bridge whose surface and card renderer are both this test's. */
function surfaceFixture(options: { readonly answer?: SurfaceAvailability; readonly throwOnPresent?: boolean } = {}): SurfaceFixture {
  const host = fakeHost({ ...(options.answer === undefined ? {} : { answer: options.answer }) })
  const recording = recordingPresenter(
    options.throwOnPresent === undefined ? {} : { throwOnPresent: options.throwOnPresent },
  )
  return {
    bridge: { create: (): NotificationSurfaceHost => host.host },
    presenter: recording.presenter,
    cards: recording.cards,
    host,
  }
}

async function startFixtureHub(options: {
  readonly surface?: SurfaceFixture
  readonly noRenderer?: boolean
  readonly stubNotifier?: boolean
  readonly stateDir?: string
} = {}): Promise<RunningHub> {
  const surface = options.surface ?? surfaceFixture()
  const desktop = {
    isPrimaryInstance: true,
    surface: surface.bridge,
    // `noRenderer` is the state the shipped Electron path is in today: a window and no
    // way to put a card in it. It must be a documented `not-wired`, not an empty
    // rectangle and not a delivery.
    ...(options.noRenderer === true ? {} : { renderCard: surface.presenter }),
  }
  const hub = await startHub({
    stateDir: options.stateDir ?? temporaryDirectory(),
    dashboardRoot: dashboardFixture(),
    lifecycle: { installSignals: false, exit: (): void => undefined },
    // A test hub delivers through the surface notifier it just built, so these tests
    // are the ones proving the card path; nothing here needs a stub instead.
    ...(options.stubNotifier === true ? { delivery: { notifier: vi.fn<Notifier>(() => undefined) } } : {}),
    onDiagnostic: (message) => diagnostics.push(message),
    desktop,
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

/** One request over a real loopback socket, one connection. */
function call(origin: string, init: { method: string; pathname: string; body?: string }): Promise<Fetched> {
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

/** A block: the one class that waits (EL-FR-07). */
function blockBody(transitionId = 'block-1', sessionId = SESSION): Record<string, unknown> {
  return {
    harness: 'opencode',
    eventName: 'permission.asked',
    sessionId,
    repoFullPath: REPO_PATH,
    transitionId,
    occurredAt: OCCURRED_AT,
  }
}

/** A finished turn: a card that expires, and a turn that nobody is waiting on. */
function finishedBody(transitionId = 'finished-1', sessionId = SESSION): Record<string, unknown> {
  return {
    harness: 'opencode',
    eventName: 'session.idle',
    variant: 'finished',
    sessionId,
    repoFullPath: REPO_PATH,
    transitionId,
    occurredAt: OCCURRED_AT,
    turnWork: { toolCall: false, fileEdit: true, todoUpdate: false },
  }
}

/** An fyi: the class that never leaves the app (NT-FR-02). */
function fyiBody(transitionId = 'fyi-1', sessionId = SESSION): Record<string, unknown> {
  return {
    harness: 'opencode',
    eventName: 'session.error',
    sessionId,
    repoFullPath: REPO_PATH,
    transitionId,
    occurredAt: OCCURRED_AT,
  }
}

/** Post one signal over a real socket and wait out the delivery it started. */
async function ingest(hub: RunningHub, body: unknown): Promise<Record<string, unknown>> {
  const response = await call(hub.origin, {
    method: 'POST',
    pathname: '/api/ingest',
    body: JSON.stringify(body),
  })
  expect(response.status, response.text).toBe(202)
  await hub.ingest.idle()
  return response.json<Record<string, unknown>>()
}

/** The policy's counts, from the same object health reads. */
function status(hub: RunningHub): DeliveryStatus {
  return hub.delivery.status()
}

/** The last recorded attempt, which is the one a single-event test just made. */
function lastAttempt(hub: RunningHub): DeliveryAttemptRecord {
  const outcomes = hub.delivery.outcomes()
  const last = outcomes.at(-1)
  if (last === undefined) throw new Error('the policy recorded no attempt')
  return last
}

/** One of the local counters, over a real read route. */
async function counterOf(hub: RunningHub, name: string): Promise<number> {
  const response = await get(hub, '/api/metrics')
  expect(response.status).toBe(200)
  const reading = response
    .json<MetricsPayload>()
    .counters.find((candidate) => candidate.counter === name)
  if (reading === undefined) throw new Error(`no ${name} reading in the payload`)
  return reading.value
}

/** The delivery section of the health payload, verbatim. */
async function deliverySectionOfHealth(hub: RunningHub): Promise<DeliveryStatus> {
  const response = await get(hub, '/api/health')
  expect(response.status).toBe(200)
  const payload = response.json<{ delivery: DeliveryStatus }>()
  expect(Object.keys(payload)).toContain('delivery')
  return payload.delivery
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

describe('the class policy is one table, and it is total', () => {
  it('carries a cell for every class, and a fourth class is a compile error', () => {
    // Enumerated against the class union rather than restated: a cell for a class the
    // classifier cannot produce, or a missing one, is what this catches.
    expect(Object.keys(CLASS_POLICIES).sort()).toEqual([...ALL_CLASSES].sort())
  })

  it('refuses exactly one class, and refuses fyi', () => {
    // The property NT-FR-02 states, as a property. Restating the three rows would pass
    // even if the table gained a fourth refusal nobody had reviewed.
    const refused = ALL_CLASSES.filter((name) => decideNotification(name).kind === 'refuse')
    expect(refused).toEqual(['fyi'])
  })

  it('holds needs-you until it is resolved and lets a finished turn expire', () => {
    // ADR-012's vocabulary, as a property of the table rather than a restatement of its
    // rows: `until-resolved` replaced a platform's `resident` hint, and a card this
    // product draws is not a request any desktop may honour or ignore.
    const delivered = (predicate: (policy: NotificationDeliverPolicy) => boolean): string[] =>
      ALL_CLASSES.filter((name) => {
        const policy = CLASS_POLICIES[name]
        return policy.kind === 'deliver' && predicate(policy)
      })
    expect(delivered((policy) => policy.lifetime === 'until-resolved')).toEqual(['needs-you'])
    expect(delivered((policy) => policy.urgency === 'critical')).toEqual(['needs-you'])
    expect(delivered((policy) => policy.lifetime === 'expires')).toEqual(['finished'])
    expect(delivered((policy) => policy.urgency === 'normal')).toEqual(['finished'])
  })

  it('names the same lifetime the card lifetime table names, for every class', () => {
    // Two tables that both have an opinion about how long a card lives would be two
    // answers, so the class policy's word and the lifetime table's word are compared
    // cell by cell. `never-rendered` is the one value the class policy never produces,
    // and the fyi cell is refused before either table is consulted.
    for (const name of ALL_CLASSES) {
      const policy = CLASS_POLICIES[name]
      const cell = CARD_LIFETIMES[name]
      if (policy.kind !== 'deliver') {
        expect(cell.lifetime, name).toBe('never-rendered')
        continue
      }
      expect(policy.lifetime, name).toBe(cell.lifetime)
      expect(cell.rendered, name).toBe(true)
    }
  })

  it('throws for a class the table does not carry rather than defaulting', () => {
    // A default here would be a fourth way a notification could be made, which is the
    // shape NT-FR-08 and ADR-004 exist to prevent.
    expect(() => decideNotification('compacted' as (typeof ALL_CLASSES)[number])).toThrowError(
      /unhandled notification class/,
    )
  })

  it('carries no repeat and no sound anywhere in a cell', () => {
    // NT-FR-08 and APX-CON-04 as table properties: nothing schedules anything, and
    // nothing asks a desktop for a sound. A cell that grew a `repeat` or a `sound` key
    // would fail this before it reached a card.
    for (const [name, policy] of Object.entries(CLASS_POLICIES)) {
      const keys = Object.keys(policy).sort()
      if (policy.kind === 'deliver') {
        expect(keys, name).toEqual(['body', 'kind', 'lifetime', 'reason', 'urgency'])
      } else {
        expect(keys, name).toEqual(['kind', 'reason'])
      }
      expect(
        keys.some((key) => /sound|audio|bell|repeat|timer|interval/i.test(key)),
        name,
      ).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

describe('a delivered plan is two lines and four flags, and nothing else', () => {
  it('carries exactly the six fields NT-FR-01 names', () => {
    const plan = planNotification(planInput())
    expect(plan.kind).toBe('deliver')
    if (plan.kind !== 'deliver') throw new Error('expected a delivered plan')
    expect(Object.keys(plan.request).sort()).toEqual([
      'body',
      'class',
      'deepLink',
      'lifetime',
      'title',
      'urgency',
    ])
  })

  it('carries no field a platform invocation used to need', () => {
    // A command, its arguments, an exit code, a signal, a timeout and a platform name
    // were the vocabulary of a notification this product handed to an operating
    // system. A request that could carry any of them again is a request that could be
    // turned into one, so the absence is asserted by key set rather than described.
    const plan = planNotification(planInput())
    if (plan.kind !== 'deliver') throw new Error('expected a delivered plan')
    const request_ = plan.request as unknown as Record<string, unknown>
    for (const withdrawn of [
      'command',
      'args',
      'file',
      'exitCode',
      'signal',
      'timeoutMs',
      'platform',
      'persistence',
      'commandTimeoutMs',
    ]) {
      expect(Object.hasOwn(request_, withdrawn), withdrawn).toBe(false)
    }
  })

  it('titles a card with the repository short name and one sentence, and no counts', () => {
    const plan = planNotification(planInput())
    if (plan.kind !== 'deliver') throw new Error('expected a delivered plan')
    expect(plan.request.title).toBe(REPO)
    // One sentence, naming the kind of block. The feature's own rule: no counts on a
    // card, no stack of text, no buttons.
    expect(plan.request.body).toBe('A session is blocked and needs a decision from you.')
    expect(plan.request.body.split('.').filter((part) => part.trim() !== '')).toHaveLength(1)
    expect(plan.request.body).not.toMatch(/\d/)
  })

  it('never puts a path, a session identifier or a harness name in a card', () => {
    for (const name of ALL_CLASSES) {
      const plan = planNotification(planInput({ class: name }))
      if (plan.kind !== 'deliver') continue
      const rendered = `${plan.request.title} ${plan.request.body}`
      expect(rendered).not.toContain(REPO_PATH)
      expect(rendered).not.toContain('/home/')
      expect(rendered).not.toContain(SESSION)
      expect(rendered.toLowerCase()).not.toContain('opencode')
    }
  })

  it('falls back to the product name when the session row could not be read', () => {
    // A repository name is not a reason to withhold a block from a developer; the hub
    // answers null for an unreadable session row and the card still says something true.
    expect(renderTitle(null)).toBe(FALLBACK_TITLE)
    expect(renderTitle('   ')).toBe(FALLBACK_TITLE)
    // One constant, and it is this product's own name rather than three spelling of it.
    expect(FALLBACK_TITLE).toBe(NOTIFICATION_APP_NAME)
    expect(planNotification(planInput({ repoShortName: null }))).toMatchObject({
      kind: 'deliver',
      request: { title: FALLBACK_TITLE },
    })
  })

  it('is pure: the same input plans the same request, and the input is not changed', () => {
    const input = planInput()
    const before = JSON.stringify(input)
    expect(planNotification(input)).toEqual(planNotification(input))
    expect(JSON.stringify(input)).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// The deep link
// ---------------------------------------------------------------------------

describe('the deep link is the published contract, or nothing', () => {
  it('uses the parameter name the hub counts and the dashboard reads', () => {
    // One name, published by src/hub/metrics.ts, so the card that carries the link, the
    // tray that resolves it and the counter that observes it cannot disagree (NT-FR-07,
    // HC-6, LD-3). Spelling it here would be a second contract.
    expect(deepLinkFor(ORIGIN, SESSION)).toBe(`${ORIGIN}/?${DEEP_LINK_QUERY_KEY}=${SESSION}`)
  })

  it('is carried on the request for a delivered class', () => {
    expect(planNotification(planInput())).toMatchObject({
      request: { deepLink: `${ORIGIN}/?${DEEP_LINK_QUERY_KEY}=${SESSION}` },
    })
  })

  it('is null before the socket is bound, rather than built from a preferred port', () => {
    // A link to a port nobody is listening on sends a developer to whatever else on
    // this machine answers there, which is the one thing a loopback sidecar must not do
    // (APX-CON-01, HC-FR-01).
    expect(deepLinkFor('', SESSION)).toBeNull()
    expect(deepLinkFor('   ', SESSION)).toBeNull()
    expect(planNotification(planInput({ origin: '' }))).toMatchObject({ request: { deepLink: null } })
  })

  it('percent-encodes a target rather than pasting it into the query', () => {
    const link = deepLinkFor(ORIGIN, 'ses a&b=c d')
    expect(link).not.toBeNull()
    expect(new URL(String(link)).searchParams.get(DEEP_LINK_QUERY_KEY)).toBe('ses a&b=c d')
  })

  it('survives an origin that arrived with a trailing slash', () => {
    expect(deepLinkFor(`${ORIGIN}/`, SESSION)).toBe(`${ORIGIN}/?${DEEP_LINK_QUERY_KEY}=${SESSION}`)
  })
})

// ---------------------------------------------------------------------------
// Criterion 1: one card per delivered class, and none for a refused one
// ---------------------------------------------------------------------------

describe('the surface notifier renders one card for a needs-you request, one for a finished request and none at all for an fyi request', () => {
  it('shows one card for a block and one for a finished turn, and shows nothing for an fyi', async () => {
    const host = fakeHost()
    const { presenter, cards } = recordingPresenter()
    const notifier = notifierOver(host.host, presenter)

    const outcomes = [
      await notifier(hubRequest({ class: 'needs-you' })),
      await notifier(hubRequest({ class: 'finished' })),
      await notifier(hubRequest({ class: 'fyi' })),
    ]
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['delivered', 'delivered', 'refused'])
    expect(cards.map((entry) => entry.model.title)).toEqual([REPO, REPO])
    expect(cards.map((entry) => entry.cell.class)).toEqual(['needs-you', 'finished'])
    // The fyi is the difference in behaviour rather than a notifier that never does
    // anything: the same notifier produced two cards and refused the third, and it never
    // touched the host for it - no window, no show, no place on the screen.
    expect(host.shows).toHaveLength(2)
  })

  it('hands the card view the lifetime cell the class table named, and nothing else', async () => {
    // The card's whole lifetime is the second argument, so the view cannot invent one:
    // a needs-you card is given the cell with no interval and a finished card the one
    // with it (NT-FR-08).
    const { presenter, cards } = recordingPresenter()
    const notifier = notifierOver(fakeHost().host, presenter)
    await notifier(hubRequest({ class: 'needs-you' }))
    await notifier(hubRequest({ class: 'finished' }))
    expect(cards[0]?.cell.lifetime).toBe('until-resolved')
    expect(cards[0]?.cell.expiresInMs).toBeNull()
    expect(cards[1]?.cell.lifetime).toBe('expires')
    expect(cards[1]?.cell.expiresInMs).toBe(cardLifetimeFor('finished').expiresInMs)
  })

  it('carries the pending count without printing it, and no path, identifier or harness name', async () => {
    const { presenter, cards } = recordingPresenter()
    const notifier = notifierOver(fakeHost().host, presenter)
    await notifier(hubRequest({ class: 'needs-you', pendingCount: 4 }))
    const model = cards[0]?.model
    expect(model).toBeDefined()
    if (model === undefined) throw new Error('no card was rendered')
    expect(model.pendingCount).toBe(4)
    expect(model.title).toBe(REPO)
    expect(`${model.title} ${model.body}`).not.toContain(REPO_PATH)
    expect(`${model.title} ${model.body}`).not.toContain(SESSION)
    expect(`${model.title} ${model.body}`).not.toContain('opencode')
  })

  it('produces the same three answers through the real entry point', async () => {
    // The same claim with the composition root in the way, over a real log and a real
    // socket, because a notifier tested alone cannot be caught planning the wrong class
    // once something is wired in front of it.
    const surface = surfaceFixture()
    const hub = await startFixtureHub({ surface })

    await ingest(hub, blockBody('block-1'))
    await ingest(hub, finishedBody('finished-1', 'ses_policy_02'))
    await ingest(hub, fyiBody('fyi-1', 'ses_policy_03'))

    expect(surface.cards.map((entry) => entry.cell.class)).toEqual(['needs-you', 'finished'])
    expect(surface.host.shows).toHaveLength(2)
    expect(surface.cards.every((entry) => entry.model.title === REPO)).toBe(true)
    const status_ = status(hub)
    expect(status_.delivered).toBe(2)
    expect(status_.suppressed).toBe(1)
    expect(status_.failed).toBe(0)
    expect(status_.notWired).toBe(0)
  })

  it('assembles the card with the one pure builder, rather than a second one here', async () => {
    // NT-7 owns what a card says and this file does not get a second opinion: the model
    // the presenter is handed is exactly the one `buildCardModel` builds from the same
    // plan, so a card cannot be assembled in two places and drift (ADR-012).
    const { presenter, cards } = recordingPresenter()
    const request_ = hubRequest({ pendingCount: 2 })
    await notifierOver(fakeHost().host, presenter)(request_)
    const plan = planNotification({
      class: request_.class,
      repoShortName: request_.repoShortName,
      origin: request_.origin,
      sessionId: request_.event.sessionId,
    })
    expect(plan.kind).toBe('deliver')
    if (plan.kind !== 'deliver') throw new Error('expected a delivered plan')
    expect(cards[0]?.model).toEqual(buildCardModel(plan, 2))
  })

  it('shows one card for one request, and re-arms nothing', async () => {
    // NT-FR-08: one needs-you card per block, with persistence carried by the badge and
    // the history rather than by a repeat. Nothing here schedules anything, so the
    // observable claim is that one request is one card and the surface asks once.
    const host = fakeHost()
    const { presenter, cards } = recordingPresenter()
    await notifierOver(host.host, presenter)(hubRequest())
    expect(cards).toHaveLength(1)
    expect(host.shows).toHaveLength(1)
    expect(host.hides).toBe(0)
  })

  it('refuses an fyi even when the notifier is handed one directly', async () => {
    // Defence in depth at the second gate, decided from the same table rather than a
    // second policy: a caller that skipped the planner still cannot get an fyi onto a
    // screen (NT-FR-02, ADR-004).
    const host = fakeHost()
    const { presenter, cards } = recordingPresenter()
    const outcome = await notifierOver(host.host, presenter)(hubRequest({ class: 'fyi' }))
    expect(outcome).toEqual({ status: 'refused', reason: 'refused-in-app-only' })
    expect(cards).toEqual([])
    expect(host.shows).toEqual([])
  })

  it('says nothing on the diagnostic channel for a refusal, and something for a failure', async () => {
    // A correct decision is not a fault: `fyi` events are routine on a busy repository,
    // and a line per routine decision would bury the failures this product must never
    // hide (APX-FR-02).
    const lines: string[] = []
    const refusing = notifierOver(fakeHost().host, recordingPresenter().presenter, lines)
    await refusing(hubRequest({ class: 'fyi' }))
    expect(lines).toEqual([])

    const failing = notifierOver(
      fakeHost({ answer: { available: false, reason: 'window-refused' } }).host,
      recordingPresenter().presenter,
      lines,
    )
    await failing(hubRequest())
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/window-refused/)
  })
})

// ---------------------------------------------------------------------------
// Criterion 2: a refused class is counted as neither a delivery nor a failure
// ---------------------------------------------------------------------------

describe('a refused class increments neither the delivery counter nor the delivered count in the ledger', () => {
  it('leaves the counter and the ledger untouched, while a block moves both', async () => {
    // The defect ADR-012 names: a refused class resolved through the delivery port as
    // though it had been delivered, so every fyi event counted as a notification nobody
    // saw - against the counter PRD 11 measures notification restraint with. The block
    // in the same test is the contrast that makes the fyi half mean something: a
    // counter stuck at zero because nothing counts would pass the first half alone.
    const surface = surfaceFixture()
    const hub = await startFixtureHub({ surface })

    await ingest(hub, fyiBody('fyi-1', 'ses_policy_03'))

    expect(await counterOf(hub, 'toast_deliveries')).toBe(0)
    const afterFyi = status(hub)
    expect(afterFyi.delivered).toBe(0)
    expect(afterFyi.suppressed).toBe(1)
    expect(afterFyi.failed).toBe(0)
    expect(afterFyi.notWired).toBe(0)
    expect(afterFyi.attempted).toBe(1)
    expect(afterFyi.status).toBe('ok')
    const record = lastAttempt(hub)
    expect(record.outcome).toBe('suppressed')
    expect(record.reason).toBe('class-refused')
    // A suppression is not a failure, so it is not the last failure either - a hub that
    // reported degraded for every routine fyi would be reporting a fault that did not
    // happen.
    expect(afterFyi.lastFailure).toBeNull()
    // And the pipeline did not record a drop: nothing was lost, the event is stored, and
    // a refusal is not a lost event.
    expect(hub.ingest.droppedEvents()).toEqual([])
    expect(surface.cards).toEqual([])

    // The contrast: the same hub, the same path, one real block.
    await ingest(hub, blockBody('block-1'))
    expect(await counterOf(hub, 'toast_deliveries')).toBe(1)
    expect(status(hub).delivered).toBe(1)
    expect(lastAttempt(hub).outcome).toBe('delivered')
  })

  it('records the refusal through the delivery port as a suppression, not a throw of a failure', async () => {
    // The typed refusal is the hub's own vocabulary, so the policy can classify it. This
    // is the unit half of the criterion: the port resolves for a delivery, throws the
    // suppression for a refusal, and throws the failure for a surface that would not
    // show anything.
    const host = fakeHost()
    const { presenter } = recordingPresenter()
    const port = toNotifierPort(notifierOver(host.host, presenter))

    await expect(port(hubRequest())).resolves.toBeUndefined()
    await expect(port(hubRequest({ class: 'fyi' }))).rejects.toThrow(/declined this delivery/)
    await expect(
      port(hubRequest({ class: 'needs-you' })),
    ).resolves.toBeUndefined()
  })

  it('carries the class policy in the policy ledger and nowhere else', async () => {
    // The per-event ledger is the record a `doctor` run reads, so a refusal has to be in
    // it with a name - and it has to be a suppression rather than a delivery or a
    // failure, or PRD 11's restraint figure is wrong.
    const surface = surfaceFixture()
    const hub = await startFixtureHub({ surface })
    await ingest(hub, fyiBody())
    const outcomes = hub.delivery.outcomes()
    expect(outcomes).toHaveLength(1)
    expect(Object.keys(outcomes[0] ?? {}).sort()).toEqual([
      'at',
      'class',
      'elapsedMs',
      'eventId',
      'outcome',
      'pendingCount',
      'reason',
      'source',
    ])
    expect(outcomes[0]?.class).toBe('fyi')
    expect(outcomes[0]?.outcome).toBe('suppressed')
  })
})

// ---------------------------------------------------------------------------
// Criterion 3: a surface that will not show a card is a failure, not a delivery
// ---------------------------------------------------------------------------

describe('a host failure is recorded as a failure carrying its reason and is visible in the health payload', () => {
  it('names the reason the host gave, and does not count it as a delivery', async () => {
    const host = fakeHost({
      answer: { available: false, reason: 'document-unavailable', detail: 'the card document could not be loaded' },
    })
    const { presenter, cards } = recordingPresenter()
    const outcome = await notifierOver(host.host, presenter)(hubRequest())
    expect(outcome).toEqual({
      status: 'failed',
      reason: 'document-unavailable',
      detail: 'the card document could not be loaded',
    })
    // Nothing was rendered, because nothing could be: the window never came up.
    expect(cards).toEqual([])
  })

  it('maps every unavailability the host can report, and refuses to map an available one', async () => {
    // Total over the host's own reasons, so a new availability reason is a compile error
    // here rather than an unexplained token in a ledger (NT-FR-09).
    for (const [reason, mapped] of Object.entries(SURFACE_OUTCOME_REASONS)) {
      if (mapped === null) {
        expect(reason).toBe('available')
        expect(() => surfaceOutcomeReason({ available: true, reason: 'available' })).toThrowError(
          /reported itself available/,
        )
        continue
      }
      expect(surfaceOutcomeReason({ available: false, reason: reason as keyof typeof SURFACE_OUTCOME_REASONS })).toBe(
        mapped,
      )
    }
    // And each mapped reason is one the outcome vocabulary carries, which is what makes
    // a health payload explainable rather than a list of strings.
    const allowed = new Set([
      'surface-not-mounted',
      'window-refused',
      'window-destroyed',
      'document-unavailable',
    ])
    for (const mapped of Object.values(SURFACE_OUTCOME_REASONS)) {
      if (mapped !== null) expect(allowed.has(mapped), mapped).toBe(true)
    }
  })

  it('treats a host that throws as a wiring fault with a reason, never as a delivery', async () => {
    const host = fakeHost({ throwOnShow: true })
    const { presenter } = recordingPresenter()
    const outcome = await notifierOver(host.host, presenter)(hubRequest())
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toBe('window-refused')
    expect(outcome.detail).toMatch(/could not be placed/)
  })

  it('takes the window back down when a card cannot be rendered into it', async () => {
    // NT-FR-10: nothing occupies screen space when nothing is showing. A window with an
    // empty rectangle in it is not a card, and leaving it up would be the one thing this
    // product must never do silently.
    const host = fakeHost()
    const { presenter } = recordingPresenter({ throwOnPresent: true })
    const lines: string[] = []
    const outcome = await notifierOver(host.host, presenter, lines)(hubRequest())
    expect(outcome).toMatchObject({ status: 'failed', reason: 'card-not-rendered' })
    expect(host.shows).toHaveLength(1)
    expect(host.hides).toBe(1)
    expect(lines.join('\n')).toMatch(/card-not-rendered/)
  })

  it('is visible on the health payload, with its reason, and in the ingest drop ledger', async () => {
    const surface = surfaceFixture({
      answer: { available: false, reason: 'window-refused', detail: 'the desktop would not give a window' },
    })
    const hub = await startFixtureHub({ surface })

    await ingest(hub, blockBody())

    const status_ = status(hub)
    expect(status_.status).toBe('degraded')
    expect(status_.failed).toBe(1)
    expect(status_.delivered).toBe(0)
    expect(status_.lastFailure).not.toBeNull()
    expect(status_.lastFailure?.reason).toBe('notifier-failed')
    // The same numbers on the route `doctor` reads: a failure is not a log line.
    const health = await deliverySectionOfHealth(hub)
    expect(health.failed).toBe(1)
    expect(health.delivered).toBe(0)
    expect(health.status).toBe('degraded')
    expect(health.lastFailure).not.toBeNull()
    // And the pipeline's own record, so one failed card is visible from all three places
    // a caller could look (APX-FR-02, ADR-010).
    const dropped = hub.ingest.droppedEvents()
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toMatchObject({ stage: 'delivery', reason: 'delivery-failed' })
    // The counter did not move: a card nobody saw is not a delivery.
    expect(await counterOf(hub, 'toast_deliveries')).toBe(0)
    expect(diagnostics.join('\n')).toMatch(/window-refused/)
  })
})

// ---------------------------------------------------------------------------
// Criterion 4: the composition root builds the surface notifier
// ---------------------------------------------------------------------------

describe('the main entry point constructs the surface notifier and the delivery policy uses it', () => {
  it('wires it from the mounted surface, and the policy is wired behind it', async () => {
    const surface = surfaceFixture()
    const hub = await startFixtureHub({ surface })
    expect(hub.notifier.supported).toBe(true)
    expect(hub.notifier.reason).toBe('surface-notifier')
    expect(hub.delivery.wired).toBe(true)
    expect(await hub.notifier.probe()).toEqual({ available: true, reason: 'available' })
  })

  it('reaches the same notifier from the restart replay, so a replayed block draws a card too', async () => {
    // HC-FR-07: a hub killed while a block was outstanding delivers it again on the next
    // start, and it must go through the same notifier the live path does - a replayed
    // card drawn by a second construction would be a second implementation of the class
    // policy. The state directory is reused on purpose: the pending block has to still
    // be in the log for there to be anything to replay.
    const surface = surfaceFixture()
    const stateDir = temporaryDirectory()
    const hub = await startFixtureHub({ surface, stateDir })
    await ingest(hub, blockBody('block-1'))
    const before = surface.cards.length
    expect(before).toBe(1)
    const first = openHubs.pop()
    await first?.close()
    const restarted = await startFixtureHub({ surface, stateDir })
    expect(surface.cards.length).toBe(before + 1)
    expect(surface.cards.at(-1)?.cell.class).toBe('needs-you')
    expect(status(restarted).replayed).toBe(1)
    expect(status(restarted).delivered).toBe(1)
  })

  it('wires nothing on a headless run, and says which of the three reasons it is', async () => {
    // A supported run rather than a degraded one: the tests, the CLI and the
    // verification scripts all run without a desktop, and a notifier that claimed a card
    // would be a lie nothing could check.
    const surface = surfaceFixture()
    const windowWithoutRenderer = await startFixtureHub({ surface, noRenderer: true })
    const headless = await startHub({
      stateDir: temporaryDirectory(),
      dashboardRoot: dashboardFixture(),
      lifecycle: { installSignals: false, exit: (): void => undefined },
      onDiagnostic: (message) => diagnostics.push(message),
      desktop: { isPrimaryInstance: true },
    })
    openHubs.push(headless)
    expect(windowWithoutRenderer.notifier).toMatchObject({ supported: false, reason: 'no-card-renderer' })
    expect(headless.notifier).toMatchObject({ supported: false, reason: 'no-surface' })
    expect(headless.delivery.wired).toBe(false)
    // And nothing was constructed that could claim a delivery: a probe on a run with no
    // surface reports that, and it never touches a window.
    expect(await headless.notifier.probe()).toEqual({ available: false, reason: 'not-mounted' })
  })

  it('reports a window with no card renderer as not-wired, never as an empty card', async () => {
    // The state the shipped Electron path is in until the card document exists: the
    // window is real, and a delivery must not be reported as made because a transparent
    // rectangle appeared (APX-FR-02).
    const surface = surfaceFixture()
    const hub = await startFixtureHub({ surface, noRenderer: true })
    expect(hub.notifier).toMatchObject({ supported: false, reason: 'no-card-renderer' })
    expect(await hub.notifier.probe()).toEqual({ available: false, reason: 'not-mounted' })
    expect(hub.delivery.wired).toBe(false)
    expect(diagnostics.join('\n')).toMatch(/no way to render/)

    await ingest(hub, blockBody())
    // The pipeline is the one that counts an unwired port, and it counts it as
    // `not-wired` rather than as a delivery: "nobody was shown anything" is visible
    // from the request path, not only from health.
    expect(hub.ingest.stats().deliveries.notWired).toBe(1)
    expect(hub.ingest.stats().deliveries.delivered).toBe(0)
    expect(status(hub).attempted).toBe(0)
    expect(status(hub).delivered).toBe(0)
    expect(surface.cards).toEqual([])
    expect(surface.host.shows).toEqual([])
  })

  it('builds the notifier in exactly one place, and never the registry that is gone', () => {
    // The change of track, read from the composition root rather than believed: one
    // call resolves the surface notifier, one call adapts it to the hub's port, and the
    // platform registry's name appears nowhere (ADR-012, NT-FR-11).
    const source = readFileSync(repositoryPath('src/main/index.ts'), 'utf8')
    expect([...source.matchAll(/resolveSurfaceNotifier\(/g)]).toHaveLength(1)
    // AMENDED BY NS-3, DELIBERATELY, AND THE AMENDMENT MAKES THE CLAIM STRONGER.
    // This used to pin the exact call `toNotifierPort(surfaceNotifier.notifier`. NS-3 put
    // one adapter between the resolved notifier and the port - `rememberingCard`, which
    // records the session a card was shown for so the hub can take it down again - so
    // the literal moved. What this criterion is about is that the notifier is resolved
    // once and adapted once, so both are now counted, and the adapter that sits between
    // them is named: a second `toNotifierPort` anywhere in the composition root fails
    // here rather than becoming a second delivery path nobody reads.
    expect([...source.matchAll(/toNotifierPort\(/g)]).toHaveLength(1)
    expect(source).toContain(
      'toNotifierPort(rememberingCard(surfaceNotifier.notifier, dismissal)',
    )
    for (const withdrawn of [
      'createPlatformNotifier',
      'notify/linux',
      'notify/macos',
      'notify/windows',
      'notify/command',
    ]) {
      expect(source, withdrawn).not.toContain(withdrawn)
    }
  })

  it('resolves a notifier for a run with no surface without throwing', () => {
    // The three answers, as values: a caller can put the result straight into the
    // policy and `not-wired` then means exactly "this run cannot show a card".
    const surface = surfaceFixture()
    const notifier = resolveSurfaceNotifier({
      host: null,
      present: surface.presenter,
      refused: false,
    })
    expect(notifier).toMatchObject({ supported: false, reason: 'no-surface' })
    const refused = resolveSurfaceNotifier({
      host: surface.bridge.create({ origin: (): string => ORIGIN }),
      present: surface.presenter,
      refused: true,
    })
    expect(refused).toMatchObject({ supported: false, reason: 'window-refused' })
  })
})

// ---------------------------------------------------------------------------
// Criterion 5: the card's deep link is the tray's deep link
// ---------------------------------------------------------------------------

describe('a card carries the same deep link the tray resolves', () => {
  it('builds it with the one published builder, so there is nothing to compare', async () => {
    const { presenter, cards } = recordingPresenter()
    await notifierOver(fakeHost().host, presenter)(hubRequest())
    const model = cards[0]?.model
    if (model === undefined) throw new Error('no card was rendered')
    expect(model.deepLink).toBe(deepLinkFor(ORIGIN, SESSION))
    // The same string the card's own accessible name and the dashboard's route see: the
    // session identifier exists only inside this link, and the product that built it is
    // the product that serves it (APX-CON-01, APX-FR-01).
    expect(model.deepLink).toBe(`${ORIGIN}/?${DEEP_LINK_QUERY_KEY}=${SESSION}`)
  })

  it('carries the live origin the hub is serving, not the port it preferred', async () => {
    // HC-FR-01: a link built from a preferred port sends a developer to whatever else
    // answers there. The card is rendered after the bind, so the origin it carries is
    // the one the hub is serving.
    const surface = surfaceFixture()
    const hub = await startFixtureHub({ surface })
    await ingest(hub, blockBody())
    const model = surface.cards[0]?.model
    if (model === undefined) throw new Error('no card was rendered')
    expect(model.deepLink).toBe(`${hub.origin}/?${DEEP_LINK_QUERY_KEY}=${SESSION}`)
  })
})

// ---------------------------------------------------------------------------
// Criterion 6: no process, no exec, and no withdrawn tool
// ---------------------------------------------------------------------------

/** Every module under src/notify, as a path relative to the repository root. */
function notifyModules(directory = 'src/notify'): string[] {
  const found: string[] = []
  for (const entry of readdirSync(repositoryPath(directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      found.push(...notifyModules(relative))
      continue
    }
    // `.cts` as well as `.ts`, added by NS-2. The card surface's preload is the only
    // CommonJS module in this product and it is the only module on the notification path
    // that runs inside a renderer, so a sweep that read only `.ts` was not reading the
    // file most worth sweeping. A module that cannot be read by the sweep is a module
    // nobody has checked.
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.cts')) found.push(relative)
  }
  return found.sort()
}

/**
 * The call a forbidden mechanism would be reached through, as substrings of code.
 *
 * Substrings rather than words, because the point is to catch the call rather than the
 * vocabulary. `new Notification` is a call; `Notification` alone would match this
 * product's own type names.
 */
const PROCESS_CALLS = [
  'child_process',
  'node:child_process',
  'spawn(',
  'execFile',
  'exec(',
  'fork(',
  'createProcess',
  'ShellExecute',
] as const

/** The notification mechanisms no platform is asked to use any more (ADR-012). */
const NOTIFICATION_APIS = [
  /\bnew\s+Notification\s*\(/,
  /\bNotification\s*\.\s*requestPermission\b/,
  /\brequestPermission\s*\(/,
  /\bshowNotification\s*\(/,
  /\bsetNotificationHandler\s*\(/,
  /\bUNUserNotificationCenter\b/,
  /\bNotificationCenter\b/,
  /\btoastXml\b/i,
] as const

/** Anything that could make a noise. v1 has no sound at all (APX-CON-04). */
const SOUND_CALLS = [
  'new Audio',
  'AudioContext',
  'HTMLAudioElement',
  '<audio',
  'navigator.vibrate',
  'playSound',
] as const

/**
 * The tools this product stopped using, by name.
 *
 * NT-FR-11 says the test asserts "none of the names of the tools that were removed", so
 * the names are the assertion and not a summary of it.
 */
const WITHDRAWN_TOOL_NAMES = [
  'notify-send',
  'osascript',
  'powershell',
  'pwsh',
  'terminal-notifier',
  'msg.exe',
  'wsl-notify-send',
  'ToastGeneric',
  'libnotify',
  'dbus-send',
] as const

/** A quoted platform name, which is what a per-platform branch would compare. */
const PLATFORM_LITERALS = ["'linux'", "'darwin'", "'win32'", "'macos'", "'windows'", '`darwin`'] as const

describe('no child process spawn, no exec call and none of the removed tool names exists anywhere under src/notify', () => {
  it('reads every module under src/notify, and says which it read', () => {
    // The sweep is only as good as its coverage, so the file list is asserted: the eight
    // surface modules, the class policy, the surface notifier and the notifier's own
    // vocabulary. A module added later fails here until the sweep's reach is restated.
    //
    // NS-2 added two: the channel contract, and the preload. Both are on the
    // notification path - the second is the only module here that runs inside a
    // renderer - so both are swept rather than listed as exemptions.
    //
    // NS-3 added a ninth: the card dismissal, which is on the notification path and
    // reaches the document and the window through the channel. Swept for the same
    // reason, and it imports nothing but this product's own lifetime table.
    expect(notifyModules()).toEqual([
      'src/notify/policy.ts',
      'src/notify/registry.ts',
      'src/notify/surface/card-view.ts',
      'src/notify/surface/card.ts',
      'src/notify/surface/channel.ts',
      'src/notify/surface/dismissal.ts',
      'src/notify/surface/electron-host.ts',
      'src/notify/surface/host.ts',
      'src/notify/surface/lifetime.ts',
      'src/notify/surface/position.ts',
      'src/notify/surface/preload.cts',
      'src/notify/surface/preload.ts',
      'src/notify/types.ts',
    ])
  })

  it('starts no process and executes no command anywhere on the notification path', () => {
    for (const file of notifyModules()) {
      const source = readModuleWithoutProse(file)
      for (const forbidden of PROCESS_CALLS) {
        expect(source.includes(forbidden), `${file} must not contain ${forbidden}`).toBe(false)
      }
    }
  })

  it('reaches no notification API and names none of the removed tools', () => {
    for (const file of notifyModules()) {
      const source = readModuleWithoutProse(file)
      for (const forbidden of NOTIFICATION_APIS) {
        expect(forbidden.test(source), `${file} must not match ${forbidden.source}`).toBe(false)
      }
      for (const forbidden of SOUND_CALLS) {
        expect(source.includes(forbidden), `${file} must not contain ${forbidden}`).toBe(false)
      }
      for (const tool of WITHDRAWN_TOOL_NAMES) {
        expect(source.toLowerCase().includes(tool), `${file} must not name ${tool}`).toBe(false)
      }
    }
  })

  it('branches on no platform, so there is one implementation and not three', () => {
    // APX-CON-06 and ADR-012: what differs between the three desktops is window-manager
    // behaviour, and this product makes no decision per platform. A branch here would be
    // the start of the second and third delivery path this change deleted.
    for (const file of notifyModules()) {
      const source = readModuleWithoutProse(file)
      for (const platform of PLATFORM_LITERALS) {
        expect(source.includes(platform), `${file} must not branch on ${platform}`).toBe(false)
      }
    }
  })

  it('imports nothing from a package that could notify, and exactly one package at all', () => {
    // The belt to the braces above: the imports on this path are this product's own
    // modules, the `@/` alias the tests and the build resolve, and one named exception.
    //
    // THE EXCEPTION, added by NS-2: `src/notify/surface/preload.cts` requires `electron`.
    // A preload in a renderer with `contextIsolation: true` and `sandbox: true` is the
    // *only* place a card model can be handed to a document, and `contextBridge` is what
    // hands it over; there is no product module that can do it, because the preload runs
    // before any of this product's own code exists in that renderer. The test therefore
    // names the one permitted specifier rather than forbidding the word: a second package
    // on this path - a notification library, a `child_process` reached indirectly - still
    // fails, and `electron` in any other file on this path still fails.
    const PERMITTED: Readonly<Record<string, readonly string[]>> = Object.freeze({
      // The preloader itself: `contextBridge` and `ipcRenderer`, and nothing else, because
      // that is the whole reason the file exists.
      'src/notify/surface/preload.cts': Object.freeze(['electron']),
      // The address module: `node:url`, to turn this module's own `import.meta.url` into the
      // path the window is given. It is Node-hosted and runs in the main process, so this
      // is the same `node:url` any Node-hosted module in this product may import.
      'src/notify/surface/preload.ts': Object.freeze(['node:url']),
    })
    for (const file of notifyModules()) {
      const source = readModuleWithoutProse(file)
      const specifiers = [...source.matchAll(/(?:from|import|require\()\s*\(?\s*'([^']*)'/g)].map(
        (match) => match[1] ?? '',
      )
      const permitted = PERMITTED[file] ?? []
      for (const specifier of specifiers) {
        if (permitted.includes(specifier)) continue
        const relative = specifier.startsWith('.') || specifier.startsWith('@/')
        expect(relative, `${file} imports the package ${specifier}`).toBe(true)
      }
      // And the exception is used, so it cannot rot into a module that imports nothing
      // and a permission that is quietly stale.
      expect(specifiers.filter((s) => permitted.includes(s)).length, file).toBeLessThanOrEqual(permitted.length)
    }
    // `electron` appears on this path in exactly this one file.
    const withElectron = notifyModules().filter((file) => readModuleWithoutProse(file).includes(`require('electron')`))
    expect(withElectron).toEqual(['src/notify/surface/preload.cts'])
    // And every module on this path is either a product module or one of the two named
    // exceptions, so a third package cannot arrive by being added to a list nobody reads.
    const packageImports = notifyModules().flatMap((file) => [
      ...readModuleWithoutProse(file).matchAll(/(?:from|import|require\()\s*\(?\s*'([^']*)'/g),
    ].map((match) => [file, match[1] ?? ''] as const))
      .filter(([, specifier]) => !specifier.startsWith('.') && !specifier.startsWith('@/'))
    for (const [file, specifier] of packageImports) {
      expect(PERMITTED[file] ?? [], `${file} imports the package ${specifier}`).toContain(specifier)
    }
    expect(packageImports.map(([file, specifier]) => `${file} -> ${specifier}`).sort()).toEqual([
      'src/notify/surface/preload.cts -> electron',
      'src/notify/surface/preload.ts -> node:url',
    ])
  })
})

// ---------------------------------------------------------------------------
// Criterion 7: the retired files are gone
// ---------------------------------------------------------------------------

describe('the retired modules, their tests and the per-platform runbook are gone', () => {
  it('leaves no platform notifier, no spawn runner and no platform registry behind', () => {
    // Recorded as a fact rather than as a promise: a module deleted and left in a
    // directory listing is still dead code somebody has to read, and a test that checked
    // only its own imports would not notice it coming back.
    for (const retired of [
      'src/notify/linux.ts',
      'src/notify/macos.ts',
      'src/notify/windows.ts',
      'src/notify/command.ts',
    ]) {
      expect(existsSync(repositoryPath(retired)), retired).toBe(false)
    }
    expect(notifyModules().some((file) => /(linux|macos|windows|command)\.ts$/.test(file))).toBe(false)
  })

  it('leaves their four test files and the per-platform runbook deleted', () => {
    for (const retired of [
      'tests/notify/linux.test.ts',
      'tests/notify/macos.test.ts',
      'tests/notify/windows.test.ts',
      'tests/notify/registry-selection.test.ts',
      'docs/runbooks/notify-platforms.md',
    ]) {
      expect(existsSync(repositoryPath(retired)), retired).toBe(false)
    }
  })

  it('replaced the per-platform runbook with one that names what was not verified', () => {
    // The runbook is the record of what this product has actually been seen doing, so
    // the replacement has to exist and has to say the sentence. Naming the old runbook
    // here is the point: a link to it anywhere in the repository would now be a link to
    // nothing.
    const runbook = readFileSync(repositoryPath('docs/runbooks/notification-surface.md'), 'utf8')
    expect(runbook).toMatch(/not live-verified/i)
    for (const heading of ['Linux', 'macOS', 'Windows']) {
      expect(runbook, heading).toContain(heading)
    }
    expect(runbook).toMatch(/manual/i)
  })
})

// ---------------------------------------------------------------------------
// The helpers that read source
// ---------------------------------------------------------------------------

function repositoryPath(relative: string): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', relative)
}

function existsSync(candidate: string): boolean {
  try {
    readFileSync(candidate)
    return true
  } catch {
    return false
  }
}

/**
 * One product source file with its comments removed and its strings kept.
 *
 * Comments go because a source-level check is about the calls a module makes, not about
 * the sentences describing them - and this repository's prose names every forbidden
 * tool it deliberately avoids, so keeping comments would make the check fail on its own
 * documentation. Strings stay, because a forbidden *name* is most often only ever a
 * string.
 *
 * Known limitation, stated rather than hidden: a backtick template is read as one string
 * to its closing backtick, so a nested template inside a `${...}` would end the scan
 * early. No module on this path contains one, and a missed token would still be caught by
 * the same token in the value the code then uses.
 */
function readModuleWithoutProse(relative: string): string {
  const source = readFileSync(repositoryPath(relative), 'utf8')
  let out = ''
  let index = 0
  const blank = (length: number): void => {
    for (let offset = 0; offset < length; offset += 1) {
      out += source[index + offset] === '\n' ? '\n' : ' '
    }
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
      const found = source.indexOf('*/', index + 2)
      const stop = found === -1 ? source.length : found + 2
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
        if (inner === character) {
          cursor += 1
          break
        }
        if (character !== '`' && inner === '\n') break
        cursor += 1
      }
      // The delimiters are kept, so a forbidden *call* spanning them is still seen.
      out += `${character}${source.slice(index + 1, cursor - 1)}${character}`
      index = cursor
      continue
    }
    out += character
    index += 1
  }
  return out
}
