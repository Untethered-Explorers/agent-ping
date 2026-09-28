// The local metrics surface: the four counters PRD 11 measures the product
// against, recorded from the paths that actually happen (HC-6).
//
//   npm test -- tests/hub/metrics.test.ts
//
// THE ACCEPTANCE CRITERIA, AND WHERE EACH IS PROVEN
//
//   1. "A test asserts dashboard opens, deep-link opens and toast deliveries each
//      increment through their real request path."
//      Three real paths, none of them a test calling a counter:
//
//        - dashboard opens        a real `GET /` and a real `GET /index.html` over a
//                                  real loopback socket against a hub started by the
//                                  real main entry point, serving a stand-in build
//        - deep-link opens        a real `GET /?session=...`, which is the link the
//                                  notifier builds (NT-FR-07) and the one the
//                                  dashboard resolves (LD-3)
//        - toast deliveries       a real `POST /api/ingest` of a real blocked signal
//                                  with a notifier behind the delivery policy, waited
//                                  out through the pipeline's own `idle()`
//
//      Each is also proven *negatively*, because a counter that increments on
//      everything is as wrong as one that never increments: an asset request is not
//      an open, a hub serving no build records nothing, an empty `?session=` is not a
//      deep link, a failed delivery is not a delivery, a duplicate ingest and a
//      non-block are not changes to the pending set, and an acknowledgement is.
//
//   2. "A test asserts the metrics payload contains counts and timestamps only and
//      no field carrying event content."
//      The exact key set of the payload and of every reading, the exact four counter
//      names, every value's type, and then the assertion that matters: a real event
//      with a distinctive session id and repository path in the log, and a request
//      carrying that same session id in its query, and *neither* string appears
//      anywhere in the response body (APX-FR-01, APX-CON-12).
//
// AROUND THOSE TWO, the properties that make them worth anything:
//
//   - The recording is on the real paths and nowhere else: this file walks the
//     product's own source and asserts that src/hub/metrics.ts is the only file that
//     calls a counter write. A counter a test writes measures the test.
//   - A counter write can never decide anything else. The counters' database is
//     closed under a running hub and a real ingest is posted: the event is stored,
//     the response is 202, the pending set is right, the notifier was called, and the
//     failed write is counted and reported rather than thrown (APX-FR-02).
//   - The counts are durable, because they are in the log's own file: a hub is
//     started, a dashboard is opened, the hub is closed, and a second hub over the
//     same state directory reports the open.
//   - The restart replay is a real delivery path too: a block left pending by one
//     hub is replayed into a second hub's notifier and counted once.
//   - Nothing leaves the machine. The two modules are read as source and asserted to
//     contain no outbound call of any kind (APX-CON-12).
//   - The recorder's surface is enumerated: it can only count, and no member of it
//     names a session, an event or a harness (APX-CON-08).
//   - The rules that decide what an open, a deep link and a pending set *are* are pure
//     functions, and their edges are asserted without a socket: the document paths,
//     the query parameter, the target's length bound, the payload builder with an
//     injected clock, and the baseline the snapshot watcher compares against.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startHub, type RunningHub } from '@/main/index'
import { openEventStore, type EventStore } from '@/storage/eventStore'
import { COUNTER_NAMES, type CounterReading, type Counters } from '@/storage/counters'
import {
  DASHBOARD_DOCUMENT_PATHS,
  DEEP_LINK_QUERY_KEY,
  DEEP_LINK_TARGET_MAX_LENGTH,
  createMetricsRecorder,
  isDashboardDocumentPath,
  isDeepLinkRequest,
  onDashboardDocumentServed,
  withPendingSnapshot,
  type MetricsRecorder,
} from '@/hub/metrics'
import { METRICS_ROUTES, readMetrics, type MetricsPayload } from '@/hub/routes/metrics'
import { RouteRegistry } from '@/hub/server'
import { WRITE_TOKEN_HEADER } from '@/hub/security'
import type { Notifier } from '@/hub/delivery'
import { removeTree } from '../helpers/remove-tree'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_PATH = '/home/dev/Projects/agent-ping'
const REPO_NAME = 'agent-ping'
const SESSION = 'ses_metrics_01'
const OCCURRED_AT = '2026-09-26T09:00:00.000Z'

const temporaryDirectories: string[] = []
const openHubs: RunningHub[] = []
const openStores: EventStore[] = []
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
  for (const store of openStores.splice(0)) store.close()
  for (const directory of temporaryDirectories.splice(0)) {
    removeTree(directory)
  }
  diagnostics.length = 0
})

/**
 * A stand-in for the built dashboard.
 *
 * The document is the point of half this file, so the page has to exist: the layout
 * is the one Vite produces, an index and a hashed asset, so "the document" and "an
 * asset" are two different requests a hub has to tell apart. The card document is
 * here for the same reason and for the harder one: a card is a page too, it is served
 * by the same route and the same policy, and PRD 11 measures how often a *person*
 * pulled the dashboard up (NT-FR-02, NT-FR-12).
 */
function dashboardFixture(): string {
  const root = temporaryDirectory('agent-ping-dashboard-')
  mkdirSync(path.join(root, 'assets'), { recursive: true })
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>agent-ping</title>\n')
  writeFileSync(path.join(root, 'assets', 'index-abc123.js'), 'console.log("dashboard")\n')
  writeFileSync(
    path.join(root, 'card.html'),
    [
      '<!doctype html>',
      '<html lang="en"><head><title>agent-ping card</title>',
      '<link rel="stylesheet" href="./assets/card-abc123.css" />',
      '<script type="module" src="./assets/card-abc123.js"></script>',
      '</head><body><div data-card-surface></div></body></html>',
      '',
    ].join('\n'),
  )
  writeFileSync(path.join(root, 'assets', 'card-abc123.js'), 'console.log("card")\n')
  writeFileSync(path.join(root, 'assets', 'card-abc123.css'), '[data-card]{color:#fff}\n')
  return root
}

async function startFixtureHub(
  options: Partial<Parameters<typeof startHub>[0]> = {},
): Promise<RunningHub> {
  const hub = await startHub({
    stateDir: temporaryDirectory(),
    dashboardRoot: dashboardFixture(),
    // A test hub is not a process that should react to this test runner's signals.
    // tests/hub/lifecycle.test.ts proves the real ones against a real process.
    lifecycle: { installSignals: false },
    onDiagnostic: (message) => diagnostics.push(message),
    ...options,
  })
  openHubs.push(hub)
  return hub
}

/** A second connection to the log the hub is holding. */
function observeLog(hub: RunningHub): EventStore {
  const store = openEventStore({ filePath: hub.databaseFilePath })
  openStores.push(store)
  return store
}

interface Fetched {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly text: string
  json<T = unknown>(): T
}

interface CallInit {
  readonly method: string
  /** A path, with its query string if it has one. */
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

/** A GET to a hub in this process, path and query included. */
async function get(hub: RunningHub, pathname: string): Promise<Fetched> {
  return call(hub.origin, { method: 'GET', pathname })
}

/** The metrics payload of a hub in this process, asserted to have arrived. */
async function metricsOf(hub: RunningHub): Promise<MetricsPayload> {
  const response = await get(hub, '/api/metrics')
  expect(response.status).toBe(200)
  return response.json<MetricsPayload>()
}

/** One counter as the payload reports it, or a failure naming which one is missing. */
function counterOf(payload: MetricsPayload, name: string): number {
  return readingOf(payload, name).value
}

function readingOf(payload: MetricsPayload, name: string): CounterReading {
  const reading = payload.counters.find((candidate) => candidate.counter === name)
  if (reading === undefined) throw new Error(`no ${name} reading in the payload`)
  return reading
}

/** Every counter as a name-to-value map, for a before/after comparison. */
function readingsOf(payload: MetricsPayload): Record<string, number> {
  return Object.fromEntries(payload.counters.map((reading) => [reading.counter, reading.value]))
}

let unitCounter = 0
function unique(what: string): string {
  unitCounter += 1
  return `${what}-${unitCounter}`
}

/**
 * A notifier that records every request it received.
 *
 * A spy rather than a closure over an array, so "the notifier was called once" is
 * asserted the same way everywhere and the call count cannot drift from what was
 * recorded.
 */
function recordingNotifier(): ReturnType<typeof vi.fn<Notifier>> {
  return vi.fn<Notifier>(() => undefined)
}

/** A block: the one class that leaves the app (EL-FR-07). */
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

/** Post one signal over a real socket, and assert it was accepted. */
async function ingest(hub: RunningHub, body: unknown): Promise<Record<string, unknown>> {
  const response = await call(hub.origin, {
    method: 'POST',
    pathname: '/api/ingest',
    body: JSON.stringify(body),
  })
  expect(response.status, response.text).toBe(202)
  return response.json<Record<string, unknown>>()
}

/** Post a signal and wait for anything it started, so a counter has moved. */
async function ingestAndSettle(hub: RunningHub, body: unknown): Promise<Record<string, unknown>> {
  const accepted = await ingest(hub, body)
  // The pipeline's own drain rather than a sleep: the delivery this request started
  // is awaited here, and the policy records its outcome before that promise settles.
  await hub.ingest.idle()
  return accepted
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

/** A counters accessor that accepts a write and stores nothing anywhere. */
const silentCounters: Counters = {
  filePath: '/dev/null',
  schemaVersion: 1,
  recordDashboardOpen: (): number => 1,
  recordToastDelivery: (): number => 1,
  recordDeepLinkOpen: (): number => 1,
  recordPendingCountSnapshot: (): number => 1,
  read: (): readonly CounterReading[] =>
    COUNTER_NAMES.map((counter) => ({ counter, value: 0, updatedAt: null })),
  flush: (): void => undefined,
  close: (): void => undefined,
}

/**
 * A recorder that only listens: it records nothing and answers every question about
 * the pending set by appending the count it was handed.
 *
 * Used where the property under test is whether the *caller* asked at all, which the
 * real recorder's own comparison would otherwise hide.
 */
function listeningRecorder(asked: number[]): MetricsRecorder {
  const recorder = createMetricsRecorder({ counters: silentCounters })
  return {
    recordDashboardOpen: recorder.recordDashboardOpen,
    recordDeepLinkOpen: recorder.recordDeepLinkOpen,
    recordDeliveryOutcome: recorder.recordDeliveryOutcome,
    failedWrites: recorder.failedWrites,
    notePendingSet: (pendingCount): boolean => {
      asked.push(pendingCount)
      return false
    },
  }
}

/** One event to write straight into the log, with a unique dedupe key. */
function newEvent(dedupeKey: string): {
  readonly harness: string
  readonly sessionId: string
  readonly repoShortName: string
  readonly repoFullPath: string
  readonly rawEventType: string
  readonly class: 'needs-you' | 'finished'
  readonly subtype: null
  readonly occurredAt: string
  readonly receivedAt: string
  readonly dedupeKey: string
} {
  return {
    harness: 'opencode',
    sessionId: SESSION,
    repoShortName: REPO_NAME,
    repoFullPath: REPO_PATH,
    rawEventType: 'permission.asked',
    class: 'needs-you',
    subtype: null,
    occurredAt: OCCURRED_AT,
    receivedAt: OCCURRED_AT,
    dedupeKey,
  }
}

function isIsoInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value))
}

/** Every object key in a parsed JSON value, at every depth. */
function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => collectKeys(entry))
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, entry]) => [key, ...collectKeys(entry)])
}

function repositoryRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

// ---------------------------------------------------------------------------
// 1. Dashboard opens, through the real request path
// ---------------------------------------------------------------------------

describe('a dashboard open is recorded when a client is served the page', () => {
  it('counts one open per served document, over a real socket, from the real entry point', async () => {
    const hub = await startFixtureHub()

    // Zero on a hub that has served nobody, which is what makes the increments
    // below attributable to the requests rather than to a fixture.
    expect(counterOf(await metricsOf(hub), 'dashboard_opens')).toBe(0)

    // The request a person pulling the dashboard up makes.
    const root = await get(hub, '/')
    expect(root.status).toBe(200)
    expect(root.text).toContain('agent-ping')
    expect(counterOf(await metricsOf(hub), 'dashboard_opens')).toBe(1)

    // The same document under its other spelling is the same open: not a second one,
    // and not a missed one.
    expect((await get(hub, '/index.html')).status).toBe(200)
    expect(counterOf(await metricsOf(hub), 'dashboard_opens')).toBe(2)

    // And a reload is a third, because PRD 11 measures pulls and nobody dedupes
    // those by hand.
    await get(hub, '/')
    expect(counterOf(await metricsOf(hub), 'dashboard_opens')).toBe(3)
  })

  it('does not count an asset, a missing file or an API path as an open', async () => {
    const hub = await startFixtureHub()

    // The three requests a dashboard build makes that are not the dashboard.
    expect((await get(hub, '/assets/index-abc123.js')).status).toBe(200)
    expect((await get(hub, '/assets/index-abc123.css')).status).toBe(404)
    expect((await get(hub, '/api/metrics?limit=10')).status).toBe(200)

    // Not one open: a hashed script and a stylesheet are bytes the page needs, and a
    // mistyped API path is a client that got a 404. Counting either would inflate the
    // one number PRD 11 reads to mean "a person looked".
    expect(counterOf(await metricsOf(hub), 'dashboard_opens')).toBe(0)
  })

  it('does not count the card document, which is a page a person did not pull', async () => {
    const hub = await startFixtureHub()

    // A block produces a card, and the card document is what the surface window loads -
    // over this same origin, on this same route, with this same policy (NT-FR-02,
    // NT-FR-12). It is not a person opening the dashboard, and PRD 11 measures "the
    // unprompted dashboard pull": counting a notification's own document here would
    // report a developer looking at their dashboard every time a tool asked a question,
    // which is the number the success metric is not allowed to mean.
    const card = await get(hub, '/card.html')
    expect(card.status).toBe(200)
    expect(card.text).toContain('data-card-surface')
    // The card's stylesheet and its module script are the same two requests as the live
    // page's, and are as much not an open.
    expect((await get(hub, '/assets/card-abc123.js')).status).toBe(200)
    expect((await get(hub, '/assets/card-abc123.css')).status).toBe(200)
    expect(counterOf(await metricsOf(hub), 'dashboard_opens')).toBe(0)

    // The dashboard itself, in the same run and against the same hub, is the one that
    // moves it - so the zero above is a rule and not a broken counter.
    expect((await get(hub, '/')).status).toBe(200)
    expect(counterOf(await metricsOf(hub), 'dashboard_opens')).toBe(1)

    // And a card document carrying a deep link is still not an open and still not a
    // deep-link open, because nothing navigates a surface window: the link is an
    // attribute on the card, not a request (NT-FR-04, NT-FR-07).
    expect((await get(hub, `/${'card.html'}?${DEEP_LINK_QUERY_KEY}=${SESSION}`)).status).toBe(200)
    expect(counterOf(await metricsOf(hub), 'dashboard_opens')).toBe(1)
    expect(counterOf(await metricsOf(hub), 'deep_link_opens')).toBe(0)
  })

  it('records nothing on a hub that serves no dashboard, because nothing was opened', async () => {
    // The 503 is the honest answer for a missing build, and a counter that counted it
    // would claim somebody opened a page they were shown an error for.
    const hub = await startFixtureHub({ dashboardRoot: null })
    expect((await get(hub, '/')).status).toBe(503)
    expect(counterOf(await metricsOf(hub), 'dashboard_opens')).toBe(0)

    const missing = await startFixtureHub({ dashboardRoot: '/nonexistent/agent-ping-dashboard' })
    expect((await get(missing, '/')).status).toBe(503)
    expect(counterOf(await metricsOf(missing), 'dashboard_opens')).toBe(0)
  })

  it('survives a restart, because the count is in the log\'s own file', async () => {
    const stateDir = temporaryDirectory()
    const first = await startFixtureHub({ stateDir })
    await get(first, '/')
    expect(counterOf(await metricsOf(first), 'dashboard_opens')).toBe(1)
    await first.close()

    // A second hub over the same state directory, with nothing in this process having
    // called a counter method at all.
    const second = await startFixtureHub({ stateDir })
    expect(counterOf(await metricsOf(second), 'dashboard_opens')).toBe(1)
    await get(second, '/')
    expect(counterOf(await metricsOf(second), 'dashboard_opens')).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 1b. Deep-link opens, through the real request path
// ---------------------------------------------------------------------------

describe('a deep-link open is recorded when the link is resolved into the dashboard', () => {
  it('counts the deep link and the dashboard open from one served link, over a real socket', async () => {
    const hub = await startFixtureHub()

    // The link a toast carries: the live origin, the dashboard, and the session it
    // focuses (NT-FR-07). It is a query parameter because a browser never sends a
    // fragment, so a `#/session/...` link would be a request the hub cannot see at all.
    const response = await get(hub, `/?${DEEP_LINK_QUERY_KEY}=${encodeURIComponent(SESSION)}`)
    expect(response.status).toBe(200)

    // Both counters, because NT-FR-07 says opening a toast's deep link "focuses the
    // session in the dashboard and counts as a dashboard open", and NT-FR-08 wants
    // the tray's click to move the deep-link counter. Recording one without the other
    // would leave two numbers disagreeing about one event.
    const payload = await metricsOf(hub)
    expect(counterOf(payload, 'deep_link_opens')).toBe(1)
    expect(counterOf(payload, 'dashboard_opens')).toBe(1)
  })

  it('does not count an empty or unusable target, and never reads the value', async () => {
    const hub = await startFixtureHub()

    for (const pathname of [
      '/',
      `/?${DEEP_LINK_QUERY_KEY}=`,
      `/?${DEEP_LINK_QUERY_KEY}=%20%20`,
      `/?${DEEP_LINK_QUERY_KEY}=${'x'.repeat(DEEP_LINK_TARGET_MAX_LENGTH + 1)}`,
      '/?sessionId=ses_metrics_01',
      `/?repoFullPath=${encodeURIComponent(REPO_PATH)}`,
    ]) {
      expect((await get(hub, pathname)).status, pathname).toBe(200)
    }

    // Every one of those is still a dashboard being opened, so the open counter moved
    // six times and the deep-link counter did not move at all.
    const payload = await metricsOf(hub)
    expect(counterOf(payload, 'dashboard_opens')).toBe(6)
    expect(counterOf(payload, 'deep_link_opens')).toBe(0)
    // And none of the values any of them carried reached the payload, which is the
    // half of the rule a reader would otherwise have to take on trust.
    expect(payload.counters.every((reading) => !JSON.stringify(reading).includes(REPO_NAME))).toBe(
      true,
    )
  })
})

// ---------------------------------------------------------------------------
// 1c. Toast deliveries, through the real delivery path
// ---------------------------------------------------------------------------

describe('a toast delivery is recorded from the outcome the delivery policy reports', () => {
  it('counts one delivery for one blocked signal posted over a real socket', async () => {
    const notifier = recordingNotifier()
    const hub = await startFixtureHub({ delivery: { notifier } })

    // Nothing has been attempted, so the counter is zero even though a notifier is
    // wired and ready.
    expect(counterOf(await metricsOf(hub), 'toast_deliveries')).toBe(0)

    const accepted = await ingestAndSettle(hub, blockBody())
    expect(accepted['class']).toBe('needs-you')
    expect(accepted['outcome']).toBe('pending-created')

    // One ingest, one notifier call, one increment: this is the delivery pipeline's
    // own report, not a count of posts.
    expect(counterOf(await metricsOf(hub), 'toast_deliveries')).toBe(1)
    expect(notifier).toHaveBeenCalledTimes(1)

    // A second block is a second delivery, and a replay of the first is neither
    // (HC-FR-08).
    await ingestAndSettle(hub, blockBody('block-2'))
    expect(counterOf(await metricsOf(hub), 'toast_deliveries')).toBe(2)
    await ingestAndSettle(hub, blockBody('block-1'))
    expect(counterOf(await metricsOf(hub), 'toast_deliveries')).toBe(2)
  })

  it('does not count a failed or unwired attempt as a delivery', async () => {
    // A notifier that throws. The attempt is recorded, the block stays stored and
    // pending, and the number that moves is the count of failures - a success
    // counter beside a gap is the one thing PRD 11's notification-restraint row
    // cannot be measured against (APX-FR-02, ADR-010).
    const hub = await startFixtureHub({
      delivery: {
        notifier: () => {
          throw new Error('the desktop said no')
        },
      },
    })
    await ingestAndSettle(hub, blockBody())
    expect(counterOf(await metricsOf(hub), 'toast_deliveries')).toBe(0)
    expect(hub.delivery.status().delivered).toBe(0)
    expect(hub.delivery.status().failed).toBe(1)
    // The block is not lost by the failure being uncounted: it is the badge's job.
    expect(observeLog(hub).readPending()).toHaveLength(1)

    // A hub with no notifier at all: nobody was told, and the counter says so. Asked for
    // explicitly, because the composition root wires the platform notifier by default
    // since NT-1.
    const unwired = await startFixtureHub({ delivery: { notifier: undefined } })
    await ingestAndSettle(unwired, blockBody())
    expect(counterOf(await metricsOf(unwired), 'toast_deliveries')).toBe(0)
    // The pending set still changed, and that is still recorded: the two counters
    // answer different questions and neither stands in for the other.
    expect(counterOf(await metricsOf(unwired), 'pending_count_snapshots')).toBe(1)
  })

  it('counts the restart replay, because a replayed block really is delivered again', async () => {
    // Two hubs over one state directory: the first stores a block with no notifier
    // behind it, the second starts over the same log and replays it into a real
    // notifier (HC-FR-07). The counter answers in the second run, which is the whole
    // point of a durable local count.
    const stateDir = temporaryDirectory()
    // The first run stores the block with nothing behind the port, so the number it
    // leaves behind is zero for the reason the test is about rather than by accident -
    // the composition root wires the platform notifier by default since NT-1.
    const first = await startFixtureHub({ stateDir, delivery: { notifier: undefined } })
    await ingestAndSettle(first, blockBody())
    expect(counterOf(await metricsOf(first), 'toast_deliveries')).toBe(0)
    await first.close()

    const notifier = recordingNotifier()
    const second = await startFixtureHub({ stateDir, delivery: { notifier } })
    expect(notifier).toHaveBeenCalledTimes(1)
    expect(counterOf(await metricsOf(second), 'toast_deliveries')).toBe(1)

    // And once more: the replay is once per run, so a third run adds exactly one and
    // the total is the number of toasts a person could actually have seen.
    await second.close()
    const third = await startFixtureHub({ stateDir, delivery: { notifier } })
    expect(notifier).toHaveBeenCalledTimes(2)
    expect(counterOf(await metricsOf(third), 'toast_deliveries')).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 1d. The pending-count snapshot, through the real store path
// ---------------------------------------------------------------------------

describe('a pending-count snapshot is recorded when the pending set changes', () => {
  it('counts a block opening and an acknowledgement clearing it, and nothing in between', async () => {
    const hub = await startFixtureHub()
    expect(counterOf(await metricsOf(hub), 'pending_count_snapshots')).toBe(0)

    // A finished turn is a real event in the real log, and it changes nothing about
    // what is waiting for the developer.
    await ingestAndSettle(hub, finishedBody())
    expect(observeLog(hub).readEventHistory({ limit: 10 })).toHaveLength(1)
    expect(counterOf(await metricsOf(hub), 'pending_count_snapshots')).toBe(0)

    // A block opens the set.
    const accepted = await ingestAndSettle(hub, blockBody())
    const eventId = String(accepted['eventId'])
    expect(counterOf(await metricsOf(hub), 'pending_count_snapshots')).toBe(1)
    expect(observeLog(hub).readPending()).toHaveLength(1)

    // The same block again: the store's own dedupe verdict, and no second change
    // (HC-FR-08).
    await ingestAndSettle(hub, blockBody())
    expect(counterOf(await metricsOf(hub), 'pending_count_snapshots')).toBe(1)

    // The one control surface clears it, and that is a second change.
    expect(await acknowledge(hub, eventId)).toBe(200)
    expect(observeLog(hub).readPending()).toHaveLength(0)
    expect(counterOf(await metricsOf(hub), 'pending_count_snapshots')).toBe(2)

    // Acknowledging it again changes nothing, so nothing is recorded.
    expect(await acknowledge(hub, eventId)).toBe(200)
    expect(counterOf(await metricsOf(hub), 'pending_count_snapshots')).toBe(2)
  })

  it('counts a harness resolution, which closes a block the store already had', async () => {
    const hub = await startFixtureHub()
    await ingestAndSettle(hub, blockBody())
    expect(counterOf(await metricsOf(hub), 'pending_count_snapshots')).toBe(1)

    await ingestAndSettle(hub, {
      harness: 'opencode',
      eventName: 'permission.replied',
      sessionId: SESSION,
      repoFullPath: REPO_PATH,
      transitionId: 'block-1',
      occurredAt: OCCURRED_AT,
    })
    expect(observeLog(hub).readPending()).toHaveLength(0)
    expect(counterOf(await metricsOf(hub), 'pending_count_snapshots')).toBe(2)
  })

  it('does not record a change for a hub that started with blocks already pending', async () => {
    // The baseline matters. A restarted hub with two outstanding blocks that then
    // stores a finished event has not had a block change, and a counter that said
    // otherwise would answer "how often did a block need me" with every event in the
    // log.
    const stateDir = temporaryDirectory()
    const first = await startFixtureHub({ stateDir })
    await ingestAndSettle(first, blockBody('block-1'))
    await ingestAndSettle(first, blockBody('block-2', 'ses_metrics_02'))
    expect(counterOf(await metricsOf(first), 'pending_count_snapshots')).toBe(2)
    await first.close()

    const second = await startFixtureHub({ stateDir })
    expect(observeLog(second).readPending()).toHaveLength(2)
    expect(counterOf(await metricsOf(second), 'pending_count_snapshots')).toBe(2)

    await ingestAndSettle(second, finishedBody())
    expect(counterOf(await metricsOf(second), 'pending_count_snapshots')).toBe(2)
    await ingestAndSettle(second, blockBody('block-3'))
    expect(counterOf(await metricsOf(second), 'pending_count_snapshots')).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 2. The payload carries counts and timestamps only
// ---------------------------------------------------------------------------

describe('the metrics payload is counts and timestamps and nothing else', () => {
  it('is exactly a list of readings and the instant it was read', async () => {
    const hub = await startFixtureHub()
    const response = await get(hub, '/api/metrics')
    expect(response.status).toBe(200)

    const payload = response.json<MetricsPayload>()
    // Two fields. A payload that grew a third could grow a field carrying content, so
    // the key set is asserted rather than described.
    expect(Object.keys(payload).sort()).toEqual(['counters', 'generatedAt'])
    // And the readings are counters.ts's own shape, verbatim, in the closed union's
    // order, whether or not each has been recorded (EL-FR-10).
    expect(payload.counters.map((reading) => reading.counter)).toEqual([...COUNTER_NAMES])
    for (const reading of payload.counters) {
      expect(Object.keys(reading).sort()).toEqual(['counter', 'updatedAt', 'value'])
      expect(COUNTER_NAMES).toContain(reading.counter)
      expect(Number.isInteger(reading.value)).toBe(true)
      expect(reading.value).toBeGreaterThanOrEqual(0)
      expect(reading.updatedAt === null || isIsoInstant(reading.updatedAt)).toBe(true)
    }
    expect(isIsoInstant(payload.generatedAt)).toBe(true)
  })

  it('stamps a counter with the instant it moved', async () => {
    const hub = await startFixtureHub()
    // A counter nobody has recorded reads as zero with no timestamp, so a client can
    // tell "nothing has happened yet" from "this is not one we keep".
    expect(readingOf(await metricsOf(hub), 'dashboard_opens').updatedAt).toBeNull()

    await get(hub, '/')
    const after = readingOf(await metricsOf(hub), 'dashboard_opens')
    // Stamped when it moved, not when it was asked for: the instant is no later than
    // the payload that carries it.
    expect(after.updatedAt !== null && isIsoInstant(after.updatedAt)).toBe(true)
    expect(Date.parse(String(after.updatedAt))).toBeLessThanOrEqual(
      Date.parse((await metricsOf(hub)).generatedAt),
    )
  })

  it('carries no session, repository, harness, event or text from a real log', async () => {
    const notifier = recordingNotifier()
    const hub = await startFixtureHub({ delivery: { notifier } })
    // A real blocked signal, so there is a real session id, a real repository path, a
    // real dedupe key and a real event id in the log behind this payload.
    const accepted = await ingestAndSettle(hub, blockBody())
    const eventId = String(accepted['eventId'])
    await acknowledge(hub, eventId)
    await get(hub, `/?${DEEP_LINK_QUERY_KEY}=${encodeURIComponent(SESSION)}`)

    // Asked with the very strings that would be a leak, in the query, where a naive
    // echo would put them.
    const response = await get(
      hub,
      `/api/metrics?${DEEP_LINK_QUERY_KEY}=${encodeURIComponent(SESSION)}` +
        `&sessionId=${encodeURIComponent(SESSION)}` +
        `&repoFullPath=${encodeURIComponent(REPO_PATH)}` +
        `&eventId=${encodeURIComponent(eventId)}`,
    )
    expect(response.status).toBe(200)

    // Not the identifiers, not the paths, and not the names of the fields that would
    // carry them: the payload is four closed names, four integers and four instants,
    // so there is nowhere for any of it to be.
    for (const forbidden of [
      SESSION,
      REPO_PATH,
      REPO_NAME,
      eventId,
      'permission.asked',
      'opencode',
      'repoFullPath',
      'dedupeKey',
      'eventId',
      'sessionId',
      'harness',
    ]) {
      expect(response.text, forbidden).not.toContain(forbidden)
    }
    // Every key in the body, at every depth, is one of the five the payload is
    // allowed to have.
    const keys = [...new Set(collectKeys(JSON.parse(response.text) as unknown))].sort()
    expect(keys).toEqual(['counter', 'counters', 'generatedAt', 'updatedAt', 'value'])
    // And none of them is a name that suggests stored content, which is the second net
    // the project's own content-free guard runs alongside an exact list: a field
    // called `summary` or `body` or `payload` would hold no content today and be
    // ready to hold some tomorrow.
    for (const key of keys) {
      expect(key, key).not.toMatch(
        /prompt|response|reply|message|content|body|text|snippet|excerpt|preview|summary|detail|note|comment|output|transcript|log|diff|patch|file_content|arguments|input|result|attachment|blob|payload|data|buffer|raw/i,
      )
    }
  })

  it('is a read: it changes nothing in the log', async () => {
    const notifier = recordingNotifier()
    const hub = await startFixtureHub({ delivery: { notifier } })
    await ingestAndSettle(hub, blockBody())
    const store = observeLog(hub)
    const counts = (): Record<string, number> => ({
      pending: store.readPending().length,
      events: store.readEventHistory({ limit: 500 }).length,
      sessions: store.readSessionSummaries().length,
    })
    const before = counts()

    await get(hub, '/api/metrics')
    await get(hub, '/api/metrics?limit=1')

    // The counters are the one table a request path writes, and it is not this one.
    // (tests/hub/server.test.ts walks the whole enumerated surface and proves the
    // same for every route; this is the focused half for the route whose subject is a
    // table that is written.)
    expect(counts()).toEqual(before)
    // And reading it recorded nothing itself: the one delivery and the one pending
    // change above, unchanged.
    expect(readingsOf(await metricsOf(hub))).toEqual({
      dashboard_opens: 0,
      toast_deliveries: 1,
      deep_link_opens: 0,
      pending_count_snapshots: 1,
    })
  })

  it('refuses every method that could change the counters', async () => {
    const hub = await startFixtureHub()
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const response = await call(hub.origin, { method, pathname: '/api/metrics' })
      expect(response.status, `${method} /api/metrics`).toBe(405)
      expect(response.headers['allow']).toBe('GET')
    }
    // Still zero opens from all of that: a refused request is not a dashboard.
    expect(counterOf(await metricsOf(hub), 'dashboard_opens')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The recording cannot decide anything else
// ---------------------------------------------------------------------------

describe('a counter write is never allowed to decide anything but the counter', () => {
  it('records the failure, keeps the event stored and still answers 202', async () => {
    const notifier = recordingNotifier()
    const hub = await startFixtureHub({ delivery: { notifier } })

    // The counters' own database, closed underneath a running hub. Everything else in
    // the process is untouched: this is a real failure of the table, not a stub.
    hub.counters.close()

    const accepted = await ingestAndSettle(hub, blockBody())
    expect(accepted['outcome']).toBe('pending-created')
    // The event is in the log, the pending item is open and the notifier was called:
    // the diagnostic write decided none of those.
    const store = observeLog(hub)
    expect(store.readEventHistory({ limit: 10 })).toHaveLength(1)
    expect(store.readPending()).toHaveLength(1)
    expect(notifier).toHaveBeenCalledTimes(1)

    // Two writes could not happen - the pending snapshot and the delivery - and both
    // are counted and reported, which is what "never silent" means for a table whose
    // failure would otherwise be invisible (APX-FR-02).
    expect(hub.metrics.failedWrites()).toBe(2)
    expect(diagnostics.filter((line) => line.includes('could not be written'))).toHaveLength(2)

    // A dashboard request, which records from inside the request path, still serves
    // the page and still counts its own failure.
    expect((await get(hub, '/')).status).toBe(200)
    expect(hub.metrics.failedWrites()).toBe(3)
  })

  it('exposes a surface that can only count', () => {
    // Asserted by name and shape, the way the delivery policy's is: no member reads a
    // row, names a session or returns a payload, so holding a recorder is not a way to
    // reach the log or a harness (APX-CON-08).
    const members = Object.keys(createMetricsRecorder({ counters: silentCounters })).sort()
    expect(members).toEqual([
      'failedWrites',
      'notePendingSet',
      'recordDashboardOpen',
      'recordDeepLinkOpen',
      'recordDeliveryOutcome',
    ])
    for (const forbidden of ['deliver', 'insert', 'mark', 'read', 'ack', 'resolve', 'prompt', 'send']) {
      expect(members, forbidden).not.toContain(forbidden)
    }
  })
})

// ---------------------------------------------------------------------------
// The rules, as pure functions
// ---------------------------------------------------------------------------

describe('the rules that decide what an open, a deep link and a payload are', () => {
  it('names the dashboard document and nothing else', () => {
    expect([...DASHBOARD_DOCUMENT_PATHS]).toEqual(['/', '/index.html'])
    for (const pathname of ['/', '/index.html', '//index.html', '//']) {
      expect(isDashboardDocumentPath(pathname), pathname).toBe(true)
    }
    // A trailing slash names a directory rather than the document - the hub answers
    // 404 for it - and a path is not a request target, so a query is never part of
    // the answer.
    for (const pathname of ['/index.html/', '/?session=x', '/index.html?v=2', '/api/']) {
      expect(isDashboardDocumentPath(pathname), pathname).toBe(false)
    }
    // And the assets a dashboard build is made of, and the card document - which is a
    // document this hub serves, is a page, and is emphatically not a person opening the
    // dashboard (NT-FR-12).
    for (const pathname of [
      '/assets/index-abc123.js',
      '/assets/index-abc123.css',
      '/favicon.ico',
      '/api/metrics',
      '/api',
      '/index.htm',
      '/card.html',
      '//card.html',
      '/card.html/',
      '/card.html?v=2',
    ]) {
      expect(isDashboardDocumentPath(pathname), pathname).toBe(false)
    }
  })

  it('decides a deep link from the parameter alone, and never reads the value', () => {
    expect(isDeepLinkRequest(new URLSearchParams())).toBe(false)
    expect(isDeepLinkRequest(new URLSearchParams('session=ses_1'))).toBe(true)
    expect(isDeepLinkRequest(new URLSearchParams('session=%20ses_1%20'))).toBe(true)
    // A template with no value is not a link somebody followed.
    expect(isDeepLinkRequest(new URLSearchParams('session='))).toBe(false)
    expect(isDeepLinkRequest(new URLSearchParams('session=%20'))).toBe(false)
    // Past the bound, which is the classifier's own bound on a single-line token.
    expect(
      isDeepLinkRequest(new URLSearchParams(`session=${'x'.repeat(DEEP_LINK_TARGET_MAX_LENGTH)}`)),
    ).toBe(true)
    expect(
      isDeepLinkRequest(new URLSearchParams(`session=${'x'.repeat(DEEP_LINK_TARGET_MAX_LENGTH + 1)}`)),
    ).toBe(false)
    // A different parameter is a different request.
    expect(isDeepLinkRequest(new URLSearchParams('sessionId=ses_1'))).toBe(false)
    expect(DEEP_LINK_QUERY_KEY).toBe('session')
  })

  it('builds a payload from the counters and a clock, and adds nothing to either', () => {
    const at = new Date('2026-09-26T10:11:12.000Z')
    const payload = readMetrics({ counters: silentCounters }, at)
    expect(Object.keys(payload).sort()).toEqual(['counters', 'generatedAt'])
    expect(payload.generatedAt).toBe('2026-09-26T10:11:12.000Z')
    expect(payload.counters.map((reading) => reading.counter)).toEqual([...COUNTER_NAMES])
    expect(payload.counters.every((reading) => reading.value === 0)).toBe(true)
  })

  it('records a pending-set change only when the count moved, from an explicit baseline', () => {
    const reads: number[] = []
    const recorder = createMetricsRecorder({
      counters: silentCounters,
      initialPendingCount: (): number => {
        reads.push(1)
        return 3
      },
    })
    // The baseline is taken once, at construction, because the store is open then and
    // no request can arrive before the hub is serving.
    expect(reads).toHaveLength(1)
    expect(recorder.notePendingSet(3)).toBe(false)
    expect(recorder.notePendingSet(4)).toBe(true)
    expect(recorder.notePendingSet(4)).toBe(false)
    expect(recorder.notePendingSet(0)).toBe(true)
    expect(recorder.failedWrites()).toBe(0)
    // And the baseline is not re-read behind the caller's back.
    expect(reads).toHaveLength(1)
  })

  it('records the first observation when the baseline could not be read', () => {
    // A hub whose pending read failed at start has no baseline, and "we do not know
    // what the set was" is answered by counting what can be seen.
    const recorder = createMetricsRecorder({
      counters: silentCounters,
      initialPendingCount: (): number => {
        throw new Error('the log is not readable')
      },
    })
    expect(recorder.notePendingSet(0)).toBe(true)
    expect(recorder.notePendingSet(0)).toBe(false)
    expect(recorder.notePendingSet(1)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The recording is on the real paths, and the route is the only surface
// ---------------------------------------------------------------------------

describe('the recorder is wired where the events happen, and nowhere else', () => {
  it('is the only caller of a counter write in the product', () => {
    // A counter a test writes measures the test, so the set of files that may call a
    // `recordX` method is walked from the source rather than listed here: a new caller
    // in a route is a failing test rather than a stale assertion. Nothing in the read
    // routes, the ingest route, the ack route or the stream route writes a counter,
    // which is what makes HC-FR-02's promise true of the metrics table too.
    expect(sourceCallersOfCounterWrites()).toEqual(['src/hub/metrics.ts'])
  })

  it('registers exactly one read route, declared read-only, and it is a GET', () => {
    const registry = new RouteRegistry<never>()
    registry.registerAll(METRICS_ROUTES as unknown as readonly never[])
    expect(registry.signatures()).toEqual(['GET /api/metrics'])
    const route = registry.routes()[0]
    expect(route?.name).toBe('read.metrics')
    expect(route?.method).toBe('GET')
    expect(route?.mutation).toBe('read-only')
    // Not a fallback: the dashboard's own catch-all is the only route that may answer
    // for a path nothing matched.
    expect(route?.fallback).toBeUndefined()
  })

  it('has no way out of the machine', () => {
    // Read as source, because "no telemetry leaves the machine" is a claim about the
    // code and a green test run is not evidence of it (APX-CON-12).
    for (const file of ['src/hub/metrics.ts', 'src/hub/routes/metrics.ts']) {
      const source = readFileSync(path.join(repositoryRoot(), file), 'utf8')
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
        'process.env.',
      ]) {
        expect(source.includes(outbound), `${file} contains ${outbound}`).toBe(false)
      }
      // Nor a statement of its own. The recorder holds the counters accessor it was
      // handed and no handle, and the route holds no recorder at all, so neither can
      // write anything but a counter (or nothing).
      for (const own of ['storage/db.js', '.prepare(', '.exec(', '.run(', 'new Database']) {
        expect(source.includes(own), `${file} contains ${own}`).toBe(false)
      }
    }
    // And the route cannot reach a counter write even indirectly: it is handed the
    // counters accessor and nothing else (src/hub/routes/metrics.ts).
    const route = readFileSync(path.join(repositoryRoot(), 'src/hub/routes/metrics.ts'), 'utf8')
    expect(/\.record(DashboardOpen|ToastDelivery|DeepLinkOpen|PendingCountSnapshot)/.test(route)).toBe(
      false,
    )
  })

  it('wires the document handler the dashboard route calls, and moves nothing else', () => {
    const moved: string[] = []
    const metrics: MetricsRecorder = createMetricsRecorder({
      counters: {
        ...silentCounters,
        recordDashboardOpen: (): number => {
          moved.push('dashboard_opens')
          return moved.length
        },
        recordDeepLinkOpen: (): number => {
          moved.push('deep_link_opens')
          return moved.length
        },
      },
      initialPendingCount: (): number => 0,
    })
    const handler = onDashboardDocumentServed(metrics)
    handler({ pathname: '/assets/index-abc123.js', query: new URLSearchParams() })
    handler({ pathname: '/', query: new URLSearchParams() })
    handler({ pathname: '/', query: new URLSearchParams(`session=${SESSION}`) })
    handler({ pathname: '/index.html', query: new URLSearchParams('session=') })
    // One open per document, one deep link, never an asset - the same two rules the
    // socket tests above prove, with the route's own argument shape.
    expect(moved).toEqual([
      'dashboard_opens',
      'dashboard_opens',
      'deep_link_opens',
      'dashboard_opens',
    ])
  })

  it('asks about the pending set only for a transition the store applied', async () => {
    // The wrapper's rule, with a recorder that only *listens*. The count comparison
    // the real recorder makes would mask a wrapper that asked about a no-op anyway -
    // the set did not change either way - so the thing asserted here is whether the
    // wrapper asked at all, which is what keeps a duplicate insert from costing a
    // read and what keeps a no-op out of every downstream observer (HC-FR-08).
    const hub = await startFixtureHub()
    const store = openEventStore({ filePath: hub.databaseFilePath })
    openStores.push(store)
    const asked: number[] = []
    const listening = listeningRecorder(asked)
    const watched = withPendingSnapshot(store, listening)

    const block = { ...newEvent(unique('asked')), class: 'needs-you' } as const
    const finished = { ...newEvent(unique('asked')), class: 'finished' } as const

    const stored = watched.insertEvent(block)
    expect(stored.outcome).toBe('inserted')
    expect(asked).toHaveLength(1)

    // Four shapes of no-op, and not one of them asks: a duplicate insert, a repeated
    // acknowledgement, an unknown identifier, and a transition the store refuses to
    // apply to a row that was never pending.
    expect(watched.insertEvent(block).outcome).toBe('duplicate')
    expect(watched.markAcknowledged(stored.event.eventId).outcome).toBe('applied')
    expect(watched.markAcknowledged(stored.event.eventId).outcome).toBe('unchanged')
    expect(watched.markAcknowledged('evt_does_not_exist').outcome).toBe('not-found')
    const finishedRow = watched.insertEvent(finished)
    expect(asked).toHaveLength(3)
    expect(watched.markResolved(finishedRow.event.eventId).outcome).toBe('conflict')
    expect(watched.markResolved('evt_does_not_exist').outcome).toBe('not-found')
    expect(asked).toHaveLength(3)
  })

  it('takes a snapshot only on a transition the store applied', async () => {
    // The wrapper's rule, driven against a real log: an applied insert and an applied
    // acknowledgement each record once, and a duplicate insert, an unknown identifier
    // and a repeated acknowledgement record nothing (HC-FR-08).
    const hub = await startFixtureHub()
    const store = openEventStore({ filePath: hub.databaseFilePath })
    openStores.push(store)
    const watched = withPendingSnapshot(
      store,
      createMetricsRecorder({
        counters: hub.counters,
        initialPendingCount: (): number => store.readPending().length,
      }),
    )
    const dedupeKey = unique('wrap')
    const newEvent = {
      harness: 'opencode',
      sessionId: SESSION,
      repoShortName: REPO_NAME,
      repoFullPath: REPO_PATH,
      rawEventType: 'permission.asked',
      class: 'needs-you',
      subtype: null,
      occurredAt: OCCURRED_AT,
      receivedAt: OCCURRED_AT,
      dedupeKey,
    } as const

    const stored = watched.insertEvent(newEvent)
    expect(stored.outcome).toBe('inserted')
    expect(counterOf(await metricsOf(hub), 'pending_count_snapshots')).toBe(1)

    // The same dedupe key again: nothing stored, no set changed, nothing recorded.
    expect(watched.insertEvent(newEvent).outcome).toBe('duplicate')
    expect(counterOf(await metricsOf(hub), 'pending_count_snapshots')).toBe(1)

    // An unknown identifier is not a change, and an applied acknowledgement is.
    expect(watched.markAcknowledged('evt_does_not_exist').outcome).toBe('not-found')
    expect(counterOf(await metricsOf(hub), 'pending_count_snapshots')).toBe(1)
    expect(watched.markAcknowledged(stored.event.eventId).outcome).toBe('applied')
    expect(counterOf(await metricsOf(hub), 'pending_count_snapshots')).toBe(2)
    expect(watched.markAcknowledged(stored.event.eventId).outcome).toBe('unchanged')
    expect(counterOf(await metricsOf(hub), 'pending_count_snapshots')).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Helpers that read the repository's own source
// ---------------------------------------------------------------------------

/**
 * The product files that call a counter write.
 *
 * `src/` only, and walked rather than listed, so a new caller in a route is a failing
 * test rather than a stale assertion. The recorder itself is the only file allowed to
 * appear, and it is the file that owns the four decisions.
 */
function sourceCallersOfCounterWrites(): string[] {
  const pattern = /\.record(DashboardOpen|ToastDelivery|DeepLinkOpen|PendingCountSnapshot)\s*\(/
  const found: string[] = []
  for (const directory of ['src/hub', 'src/main', 'src/storage', 'src/domain']) {
    for (const file of walkTypeScript(path.join(repositoryRoot(), directory))) {
      if (pattern.test(readFileSync(file, 'utf8'))) {
        found.push(path.relative(repositoryRoot(), file).split(path.sep).join('/'))
      }
    }
  }
  return found.sort()
}

/** Every `.ts` file under a directory, depth first, in a stable order. */
function walkTypeScript(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...walkTypeScript(full))
    else if (entry.name.endsWith('.ts')) found.push(full)
  }
  return found
}
