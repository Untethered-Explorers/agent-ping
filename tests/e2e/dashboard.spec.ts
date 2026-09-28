// The dashboard's primary journey, in a real browser, against the real hub
// (LD-4: LD-FR-03, LD-FR-05, LD-FR-09, LD-FR-10, APX-CON-11).
//
//   npm test -- tests/e2e/dashboard.spec.ts
//   node scripts/verify-dashboard-e2e.mjs
//
// WHAT IS ACTUALLY DRIVEN
// One hub, in its own operating-system process, started by the real composition
// root against a temporary state directory, serving the real `dist/dashboard`
// build over its own loopback origin. One real Chromium. Every signal is posted
// to the product's own ingest route over a real socket; every assertion is read
// out of the page the product's own static route served. There is no mock server,
// no stubbed response, no substituted bundle and no injected script anywhere in
// this file.
//
// THE JOURNEYS ARE DECLARED, NOT DISCOVERED
// Every test below is generated from `EXPECTED_JOURNEYS`, the one list
// scripts/verify-dashboard-e2e.mjs owns, and a declared journey with no runner in
// `JOURNEYS` is a hard failure at collection time. That is what makes the two
// halves of LD-4's first acceptance criterion structural rather than a promise:
// the list cannot grow without a journey appearing, and a journey cannot appear
// without a runner, so a run that collected tests and executed none of them has
// nowhere to hide.
//
// WHERE EACH REQUIREMENT IS PROVEN
//
//   LD-FR-03  the stream, its stale state, and a reconnect that resumes on a cursor
//   LD-FR-04  the page's pending count against `/api/pending`, the route the tray
//              badge reads
//   LD-FR-05  the acknowledgement, through the page's one control and the real
//              token, and the refusal path
//   LD-FR-06  a deep link built the way the card and the tray build it
//   LD-FR-08  the history panel, with no content field anywhere in it
//   LD-FR-09  keyboard reach and activation, and the mirror the traversal runs on
//   LD-FR-10  the same build served on the loopback origin
//   APX-CON-11 first paint, live-update latency and hub idle RSS, measured and
//              recorded rather than assumed
//
// WHAT IS DELIBERATELY NOT PROVEN HERE
// No human reads this page, so nothing here is a design verdict; those are
// docs/reviews/live-dashboard.json's work (LD-5). The notification surface's own
// window is not driven either - scripts/verify-notification-surface.mjs owns that
// surface, and a run that opened a card here would be measuring a different
// product claim. And the shipped page's acknowledgement control presents as
// unavailable on purpose (HC-FR-06 keeps the token out of every served file);
// tests/e2e/hub-fixture.ts states exactly the one element it inserts to supply
// that token, and the baseline journey asserts the served document is otherwise
// the build byte for byte.
//
// ONE REAL DEFECT THIS RUN FOUND, RECORDED AND NOT FIXED HERE
// A change frame that arrives while the page's *first* full re-read is in flight is
// lost. `setConnection('live')` runs before that read is issued, and
// `reduceSnapshot` replaces the whole session list with the read's answer rather
// than merging it, so a block ingested in that window is drawn and then erased -
// and because the cursor has already advanced to the change's, a reconnect
// resumes after it and never asks for it again. Every journey here therefore waits
// for the header to show a number before it ingests anything, which is both what a
// developer experiences and the only ordering in which "a live update appeared" is a
// claim about the stream rather than about this race. The fix belongs to
// dashboard-engineer's reduction, not to this suite: a required change, not a
// redesign performed by a test (LD-FR-03, LD-1, LD-3).
//
// THE SECOND ONE, AND IT IS A BIGGER DEAL
// The header's single acknowledgement control cannot currently act on a row, so
// the acknowledgement this product exists for is only reachable from the keyboard.
// A press on the control moves focus out of the row list, and the controller's own
// blur handler releases the row when focus leaves the list
// (`onBlurRow`: "focus left a row", `relatedTarget` outside the mirror), so by the
// time the click handler asks which row it is holding, the answer is null and it
// refuses without issuing a request. A row is only reachable by focus at all
// through the visually hidden mirror - the canvas carries no pointer selection -
// so a pointer user cannot put a row in hand in the first place, and the control
// is unreachable in every state: Enter on a pending row already acknowledges it,
// and a row with nothing pending is exactly the case the control disables itself
// for. The journey below therefore drives the acknowledgement the way the page
// supports it (Enter on a focused row, which is the page's own documented
// equivalent), and the control's label and availability - which do hold - are
// asserted. Asserting the pointer route as it behaves would make this suite green
// only by enshrining a dead control; the required change belongs to
// dashboard-engineer's control/blur wiring, and LD-3's own suite currently pins
// the blur behaviour that causes it (LD-FR-05, LD-FR-09, LD-3).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  MIRROR_ACTIVATIONS_ATTRIBUTE,
  MIRROR_FOCUSED_ATTRIBUTE,
  MIRROR_PENDING_ATTRIBUTE,
  MIRROR_REPOSITORY_ATTRIBUTE,
  MIRROR_ROW_ATTRIBUTE,
  MIRROR_ROOT_ATTRIBUTE,
  MIRROR_STATE_ATTRIBUTE,
  MIRROR_STATE_LABEL_ATTRIBUTE,
} from '../../src/dashboard/a11y/dom-mirror'
import { DEEP_LINK_QUERY_KEY } from '../../src/dashboard/live/deeplink'
import { deepLinkFor } from '../../src/notify/policy'
import {
  HISTORY_ACK_ATTRIBUTE,
  HISTORY_CLASS_ATTRIBUTE,
  HISTORY_ENTRY_ATTRIBUTE,
  HISTORY_REPOSITORY_ATTRIBUTE,
  HISTORY_RESOLUTION_ATTRIBUTE,
  HISTORY_SESSION_ATTRIBUTE,
} from '../../src/dashboard/live/history'
import { startHubForJourneys, type StartedHub } from './hub-fixture'
import { E2E_RUN_ID } from '../../playwright.config'
import {
  EXPECTED_JOURNEYS,
  JOURNEY_LEDGER_PATH,
  OBSERVATION_LEDGER_PATH,
} from '../../scripts/verify-dashboard-e2e.mjs'

// The journey list, the ledger paths and the pass/fail judgement are imported from
// scripts/verify-dashboard-e2e.mjs rather than restated, and its declarations live
// beside it. They must have one home: a copy here could be edited to agree with
// whatever the last run printed, and a run that proved nothing would then look like
// a run that proved something. The same three names are what the Playwright
// teardown reads, so the runner and the script cannot disagree about what a run owes.

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// ---------------------------------------------------------------------------
// The page's own contract
// ---------------------------------------------------------------------------

/**
 * The header and panel attribute names this suite reaches.
 *
 * Written out rather than imported: `src/dashboard/main.ts` pulls in the PixiJS
 * renderer through the session list, so importing it into a Node test worker would
 * load a canvas library this suite has no use for. A rename of any of these on the
 * product's side is a failure here with an obvious cause - the selector stops
 * matching - which is the right direction for the error to point.
 */
const PAGE = {
  header: 'data-dashboard-header',
  pending: 'data-dashboard-pending',
  connection: 'data-dashboard-connection',
  connectionText: 'data-dashboard-connection-text',
  ack: 'data-dashboard-ack',
  ackHint: 'data-dashboard-ack-hint',
  refusals: 'data-dashboard-refusals',
  refusal: 'data-dashboard-refusal',
  deepLink: 'data-dashboard-deep-link',
  deepLinkStatus: 'data-dashboard-deep-link-status',
  historyToggle: 'data-dashboard-history-toggle',
  historyPanel: 'data-dashboard-history',
} as const

// ---------------------------------------------------------------------------
// Budgets and synthetic facts
// ---------------------------------------------------------------------------

/** APX-CON-11, restated so a change to the budget is a diff here. */
const BUDGET = {
  hubIdleRssBytes: 150 * 1024 * 1024,
  ingestP95Ms: 50,
  dashboardFirstPaintMs: 1_000,
  liveUpdateVisibleMs: 250,
} as const

/**
 * One repository per journey, so each journey's rows sit in a group of their own.
 *
 * Grouping is by repository short name and that is the product's identity rule
 * (APX-CON-09), so a shared repository would mix the journeys' rows together and a
 * pending-count assertion could no longer name what it was counting. These are
 * synthetic facts, not a developer's machine: the paths live under a directory
 * that does not exist.
 */
const REPOS: Readonly<Record<string, string>> = {
  baseline: '/tmp/agent-ping-e2e-repos/baseline-repository',
  blocked: '/tmp/agent-ping-e2e-repos/blocked-repository',
  keyboard: '/tmp/agent-ping-e2e-repos/keyboard-repository',
  acknowledged: '/tmp/agent-ping-e2e-repos/acknowledged-repository',
  stale: '/tmp/agent-ping-e2e-repos/stale-repository',
  'deep-link': '/tmp/agent-ping-e2e-repos/deep-link-repository',
  greeting: '/tmp/agent-ping-e2e-repos/greeting-repository',
  incoming: '/tmp/agent-ping-e2e-repos/incoming-repository',
}

const sessionIdFor = (journey: string): string => `ses_e2e_${journey.replace(/-/g, '_')}`
const repositoryShortNameFor = (journey: string): string => `${journey}-repository`

/** A repository path a journey owns, and a missing one is a bug rather than a 422. */
const repositoryPathFor = (journey: string): string => {
  const found = REPOS[journey]
  if (found === undefined) throw new Error(`no repository path is declared for the journey "${journey}"`)
  return found
}

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

let hub: StartedHub

/** Browser-side complaints worth failing on, collected while a page is open. */
interface PageComplaint {
  readonly kind: 'console' | 'pageerror' | 'requestfailed'
  readonly text: string
}

function watchPage(page: Page): PageComplaint[] {
  const complaints: PageComplaint[] = []
  page.on('console', (message) => {
    const type = message.type()
    if (type !== 'error' && type !== 'warning') return
    complaints.push({ kind: 'console', text: message.text() })
  })
  page.on('pageerror', (error) => {
    complaints.push({ kind: 'pageerror', text: error.message })
  })
  page.on('requestfailed', (request) => {
    // The interrupted-stream journey takes the browser offline on purpose, and
    // every request it fails is that journey working. The caller decides which
    // complaints matter; this one only records them.
    complaints.push({ kind: 'requestfailed', text: `${request.url()} ${request.failure()?.errorText ?? ''}` })
  })
  return complaints
}

/**
 * Open the dashboard over the hub's own origin and wait until it is ready for a
 * journey to say something about it.
 *
 * Two conditions, in this order, and the second is the one that matters:
 *
 *   1. the connection is `live`, which is the `ready` frame arriving
 *   2. the header's count is a number rather than "pending count not read yet",
 *      which is the page's first full re-read having been applied
 *
 * The second is not politeness. `setConnection('live')` runs before the first read
 * is issued, and the read that follows replaces the session list wholesale
 * (`reduceSnapshot`). A change frame that lands while that read is in flight is
 * applied to a page that has not drawn yet and is then overwritten by the read's
 * older answer - a real window, recorded for dashboard-engineer below, and the
 * reason a journey must not call a live update observed before the page has shown
 * a number at all. Waiting for the number is also what a developer's page does: the
 * page loads, shows the count, and the block arrives afterwards.
 */
async function openDashboard(page: Page, search = ''): Promise<void> {
  await page.goto(`${hub.origin}/${search}`)
  await expect(page.locator(`[${PAGE.header}]`)).toHaveAttribute(PAGE.connection, 'live')
  await expect(page.locator(`[${PAGE.pending}]`)).toHaveText(/^\d+ pending/)
}

const row = (page: Page, sessionId: string): Locator => page.locator(`[${MIRROR_ROW_ATTRIBUTE}="${sessionId}"]`)

/**
 * Wait until the mirror holds a row, polling inside the page.
 *
 * One round trip in, one out, and the poll itself costs nothing on this side of the
 * wire - so a latency measured around this call is the interval the page took, not
 * the interval the instrument spent asking. `raf` rather than a timer because a row
 * is added by the same task that paints, and a timer could report a row before the
 * frame that shows it.
 */
const waitForRow = (page: Page, sessionId: string, timeoutMs = 15_000): Promise<unknown> =>
  page.waitForFunction(
    ([attribute, id]) => document.querySelector(`[${attribute}="${String(id)}"]`) !== null,
    [MIRROR_ROW_ATTRIBUTE, sessionId] as const,
    { polling: 'raf', timeout: timeoutMs },
  )

/** What the page-side recorder holds; `null` until each instant has happened. */
interface RowTiming {
  readonly presentAt: number | null
  readonly paintedAt: number | null
}

/** The window property the recorder writes into, named so it cannot collide. */
const ROW_TIMING_KEY = '__ld4RowTiming'

/**
 * Start a page-side recorder for one row, *before* anything is ingested.
 *
 * This exists because APX-CON-11's fourth budget is "live update visible within
 * 250 ms of an accepted event", and a number measured around `page.waitForFunction`
 * is not that: it contains this process's HTTP request, the hub's 202, the CDP round
 * trip that carried the poll's answer, and the wall time between the poll firing and
 * Node reading its reply. The recorder is installed in the page first, so both
 * instants are stamped by the page's own clock and no round trip is inside the
 * interval being measured.
 *
 * Two instants, because "visible" is not one moment:
 *
 *   presentAt  the row is in the document - the reduction ran and the mirror rebuilt
 *   paintedAt  two animation frames later - the frame the canvas is painted in
 *
 * The budget is judged against `paintedAt`, which is the later and therefore the
 * stricter of the two. Two frames rather than one because a mutation delivered
 * during a frame is painted by the next.
 */
async function recordRowAppearance(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(
    ([attribute, id, key]) => {
      const scope = window as unknown as Record<string, { presentAt: number | null; paintedAt: number | null }>
      scope[key] = { presentAt: null, paintedAt: null }
      const observer = new MutationObserver(() => {
        const timing = scope[key]
        if (timing === undefined || timing.presentAt !== null) return
        if (document.querySelector(`[${attribute}="${String(id)}"]`) === null) return
        timing.presentAt = Date.now()
        observer.disconnect()
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            timing.paintedAt = Date.now()
          })
        })
      })
      observer.observe(document.documentElement, { childList: true, subtree: true })
    },
    [MIRROR_ROW_ATTRIBUTE, sessionId, ROW_TIMING_KEY] as const,
  )
}

/** The instants the recorder took, or nulls when the row never appeared. */
const readRowTiming = (page: Page): Promise<RowTiming> =>
  page.evaluate(
    (key) => (window as unknown as Record<string, RowTiming>)[key] ?? { presentAt: null, paintedAt: null },
    ROW_TIMING_KEY,
  )

/** The session the browser currently has focus on, read from the live document. */
const focusedSessionId = (page: Page): Promise<string | null> =>
  page.evaluate((attribute) => document.activeElement?.getAttribute(attribute) ?? null, MIRROR_ROW_ATTRIBUTE)

/** How many rows the mirror holds, in the order the canvas paints them. */
const mirrorSessionOrder = (page: Page): Promise<string[]> =>
  page.evaluate(
    (attribute) => [...document.querySelectorAll(`[${attribute}]`)].map((entry) => entry.getAttribute(attribute) ?? ''),
    MIRROR_ROW_ATTRIBUTE,
  )

/**
 * Tab until the keyboard is inside the row list.
 *
 * Tab order is the page's own, so the number of presses depends on the header's
 * controls and would change if the page's chrome changed. Bounded so a page that
 * never puts focus in the list fails with a message rather than hanging.
 */
async function tabIntoTheRowList(page: Page, limit = 20): Promise<number> {
  for (let press = 1; press <= limit; press += 1) {
    await page.keyboard.press('Tab')
    const session = await focusedSessionId(page)
    if (session !== null) return press
    const inside = await page.evaluate(
      (root) => document.activeElement !== null && document.querySelector(root)?.contains(document.activeElement) === true,
      `[${MIRROR_ROOT_ATTRIBUTE}]`,
    )
    if (inside) return press
  }
  throw new Error(
    `Tab did not reach the row list after ${String(limit)} presses. The mirror root is in the document: ` +
      `${String(await page.locator(`[${MIRROR_ROOT_ATTRIBUTE}]`).count())}`,
  )
}

/**
 * Walk to one row with the arrow keys alone.
 *
 * `Home` first, so the traversal starts from the list's own answer rather than from
 * wherever a previous journey's focus happened to be left, and the step count comes
 * from the mirror's own document order rather than from a guess about the layout.
 */
async function arrowToRow(page: Page, sessionId: string): Promise<void> {
  const order = await mirrorSessionOrder(page)
  const index = order.indexOf(sessionId)
  expect(index, `the mirror holds a row for ${sessionId}; it holds ${JSON.stringify(order)}`).toBeGreaterThanOrEqual(0)
  await page.keyboard.press('Home')
  for (let step = 0; step < index; step += 1) await page.keyboard.press('ArrowDown')
  expect(await focusedSessionId(page)).toBe(sessionId)
}

/** Post one signal to the product's own ingest route, over a real socket. */
async function ingest(signal: {
  eventName: string
  sessionId: string
  repoFullPath: string
  transitionId: string
  turnWork?: { toolCall: boolean; fileEdit: boolean; todoUpdate: boolean }
}): Promise<{ status: number; eventId: string | null; class: string | null; pendingCount: number | null }> {
  const response = await hub.postSignal<{
    eventId?: string | null
    class?: string | null
    pendingCount?: number | null
  }>({
    harness: 'opencode',
    eventName: signal.eventName,
    sessionId: signal.sessionId,
    repoFullPath: signal.repoFullPath,
    transitionId: signal.transitionId,
    occurredAt: new Date().toISOString(),
    ...(signal.turnWork === undefined ? {} : { turnWork: signal.turnWork }),
  })
  return {
    status: response.status,
    eventId: response.body?.eventId ?? null,
    class: response.body?.class ?? null,
    pendingCount: response.body?.pendingCount ?? null,
  }
}

/** One needs-you block for a journey, driven through the real ingest route. */
async function ingestNeedsYou(journey: string): Promise<{ sessionId: string }> {
  const sessionId = sessionIdFor(journey)
  const accepted = await ingest({
    eventName: 'permission.asked',
    sessionId,
    repoFullPath: repositoryPathFor(journey),
    transitionId: `e2e-${journey}-block-1`,
  })
  expect(accepted.status, `the ingest route accepted the needs-you signal: ${JSON.stringify(accepted)}`).toBe(202)
  expect(accepted.class, 'the hub classified the signal as needs-you').toBe('needs-you')
  return { sessionId }
}

/**
 * The hub's own instant for the moment a session's block became its event, in
 * milliseconds on this machine's clock.
 *
 * `receivedAt` is the store's own field on the record the ingest route created - the
 * envelope's "when the hub received it" - read back from the product's own history
 * route. It is the start of APX-CON-11's interval because it is the hub's answer
 * rather than this process's timing of its own request, and it is read *after* the
 * row has been observed so that the read cannot sit inside the measurement.
 */
async function acceptedAtMsFor(sessionId: string): Promise<number> {
  const response = await hub.get<{ events: readonly { receivedAt?: unknown }[] }>(
    `/api/events?sessionId=${encodeURIComponent(sessionId)}&limit=1`,
  )
  const receivedAt = response.body?.events?.[0]?.['receivedAt']
  if (typeof receivedAt !== 'string') {
    throw new Error(
      `the hub's own event for ${sessionId} carries no receivedAt, so the instant the event was accepted ` +
        `cannot be read and the live-update budget cannot be measured from it. Answer was: ${response.text}`,
    )
  }
  const at = Date.parse(receivedAt)
  if (!Number.isFinite(at)) {
    throw new Error(`the hub's receivedAt for ${sessionId} is not a timestamp this clock can read: ${receivedAt}`)
  }
  return at
}

// ---------------------------------------------------------------------------
// The ledgers
// ---------------------------------------------------------------------------

interface JourneyOutcome {
  readonly id: string
  readonly name: string
  readonly outcome: string
  readonly durationMs: number
  readonly at: string
}

const journeyOutcomes = new Map<string, JourneyOutcome>()
const observations: {
  name: string
  expected: string
  actual: string
  measured?: string
  ok?: boolean
}[] = []

/** One measured fact, judged by the verification script rather than silently kept. */
function observe(input: { name: string; expected: string; actual: string; measured?: string; ok: boolean }): void {
  observations.push({
    name: input.name,
    expected: input.expected,
    actual: input.actual,
    ...(input.measured === undefined ? {} : { measured: input.measured }),
    ok: input.ok,
  })
}

function writeLedgers(): void {
  mkdirSync(path.dirname(JOURNEY_LEDGER_PATH), { recursive: true })
  writeFileSync(
    JOURNEY_LEDGER_PATH,
    `${JSON.stringify(
      // The run that wrote this, so a reader inside a run can tell it from the one the
      // previous run left behind. A run that collects no test never gets here, and a
      // stale ledger must not be readable as that run's evidence.
      { startedAt: new Date().toISOString(), runId: E2E_RUN_ID, journeys: [...journeyOutcomes.values()] },
      null,
      2,
    )}\n`,
  )
  writeFileSync(OBSERVATION_LEDGER_PATH, `${JSON.stringify(observations, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// Suite lifecycle
// ---------------------------------------------------------------------------

test.describe.configure({ mode: 'default' })

test.beforeAll(async () => {
  journeyOutcomes.clear()
  observations.length = 0
  for (const file of [JOURNEY_LEDGER_PATH, OBSERVATION_LEDGER_PATH]) {
    rmSync(file, { force: true })
  }
  hub = await startHubForJourneys()
  writeLedgers()
})

test.afterAll(async () => {
  if (hub !== undefined) await hub.close()
  writeLedgers()
})

// `afterEach` runs whether the test passed, failed or was interrupted inside, which
// is what makes the ledger an answer about every declared journey rather than only
// the ones that got to their last line.
test.afterEach(({}, testInfo) => {
  const id = testInfo.title.split(' — ')[0] ?? testInfo.title
  const expected = EXPECTED_JOURNEYS.find((journey) => journey.id === id)
  journeyOutcomes.set(id, {
    id,
    name: expected?.name ?? testInfo.title,
    outcome: testInfo.status ?? 'unknown',
    durationMs: testInfo.duration,
    at: new Date().toISOString(),
  })
  writeLedgers()
})

// ---------------------------------------------------------------------------
// The journeys
// ---------------------------------------------------------------------------

const JOURNEYS: Record<string, (page: Page) => Promise<void>> = {
  /**
   * The baseline: the product's own build, over the product's own origin, with the
   * product's own policy, and a page that reaches a live connection.
   *
   * Everything after this journey assumes it, so the things it asserts are the
   * preconditions rather than the interesting part: the document is the build
   * apart from the one element the write-token input needs, the response carries
   * the strict policy and no cross-origin header, the browser reported no policy
   * violation and no script error, and the page reports a live connection with the
   * hub's own count of zero.
   */
  'served-build-on-the-loopback-origin': async (page) => {
    const complaints = watchPage(page)
    const response = await page.goto(`${hub.origin}/`)

    expect(response?.status(), 'the hub served the dashboard document').toBe(200)
    const policy = response?.headers()['content-security-policy'] ?? ''
    expect(policy, 'the served document carries the product own strict policy').toContain("default-src 'self'")
    expect(policy, 'no unsafe-inline, or an injected stylesheet would be allowed').not.toContain('unsafe-inline')
    expect(policy, 'script-src stays self').toContain("script-src 'self'")

    const headerNames = Object.keys(response?.headers() ?? {})
    const crossOrigin = headerNames.filter((name) => name.toLowerCase().startsWith('access-control-allow'))
    expect(crossOrigin, 'the hub sends no cross-origin header of any kind').toEqual([])

    // The one substitution this run makes, stated as a fact about bytes.
    expect(
      hub.documentServedAs.identicalToBuildApartFromTheInsertedLine,
      `the served document is the build apart from the one inserted element. Inserted: ` +
        `${hub.documentServedAs.insertedElement}`,
    ).toBe(true)
    const built = readFileSync(path.join(REPO_ROOT, 'dist', 'dashboard', 'index.html'), 'utf8')
    const served = await response?.text()
    expect(
      served?.replace(hub.documentServedAs.insertedLine, ''),
      'what arrived over the socket is the build once the inserted element is removed',
    ).toBe(built)

    await expect(page.locator(`[${PAGE.header}]`)).toHaveAttribute(PAGE.connection, 'live')
    await expect(page.locator(`[${PAGE.pending}]`)).toHaveText('0 pending')
    await expect(page.locator(`[${MIRROR_ROOT_ATTRIBUTE}]`)).toHaveCount(1)
    await expect(page.locator(`[${MIRROR_ROW_ATTRIBUTE}]`)).toHaveCount(0)
    await expect(page.locator(`[${PAGE.historyPanel}]`)).toBeVisible()
    // The deep-link line exists in the served markup and stays empty: with no target
    // the controller never publishes a state, because `publish` is a no-op when the
    // state has not changed, so there is nothing for the page to say.
    await expect(page.locator(`[${PAGE.deepLink}]`)).toHaveText('')
    await expect(page.locator(`[${PAGE.deepLinkStatus}]`)).toHaveCount(0)

    // A page that mounted without the policy being broken, and without a script
    // throwing, is a claim the browser itself can make about itself.
    const policyViolations = complaints.filter((complaint) =>
      /content security policy|refused to/i.test(complaint.text),
    )
    expect(policyViolations, 'the browser reported no content-security-policy violation').toEqual([])
    const scriptErrors = complaints.filter((complaint) => complaint.kind === 'pageerror')
    expect(scriptErrors, 'the page raised no uncaught error').toEqual([])

    const health = await hub.health()
    const server = health['server'] as Record<string, unknown> | undefined
    const dashboard = health['dashboard'] as Record<string, unknown> | undefined
    expect(health['status'], 'the hub reports itself healthy').toBe('ok')
    expect(server?.['state'], 'the hub is accepting events').toBe('running')
    expect(server?.['listening'], 'and is listening on its own port').toBe(true)
    expect(server?.['origin'], 'and published the origin this page came from').toBe(hub.origin)
    expect(dashboard?.['available'], 'and is serving the built dashboard').toBe(true)

    // APX-CON-11: the three budgets, measured rather than assumed.
    const rss = hub.rssBytes()
    observe({
      name: 'hub idle resident set (APX-CON-11)',
      expected: `<= ${String(Math.round(BUDGET.hubIdleRssBytes / (1024 * 1024)))} MB`,
      actual: rss === null ? 'not readable on this platform' : `${(rss / (1024 * 1024)).toFixed(1)} MB`,
      measured: rss === null ? undefined : String(rss),
      ok: rss !== null && rss <= BUDGET.hubIdleRssBytes,
    })

    // First paint from a warm cache: the page has been served once, so the
    // measurement is of a cache that is warm, which is the budget's own wording.
    await page.reload()
    await expect(page.locator(`[${PAGE.header}]`)).toHaveAttribute(PAGE.connection, 'live')
    const firstPaintMs = await page.evaluate(() => {
      const entry = performance
        .getEntriesByType('paint')
        .find((candidate) => candidate.name === 'first-contentful-paint')
      return entry === undefined ? null : entry.startTime
    })
    observe({
      name: 'dashboard first contentful paint from a warm cache (APX-CON-11)',
      expected: `<= ${String(BUDGET.dashboardFirstPaintMs)} ms`,
      actual: firstPaintMs === null ? 'not reported by this browser' : `${firstPaintMs.toFixed(0)} ms`,
      measured: firstPaintMs === null ? undefined : firstPaintMs.toFixed(1),
      ok: firstPaintMs !== null && firstPaintMs <= BUDGET.dashboardFirstPaintMs,
    })
  },

  /**
   * The positive path, first half: a real ingested block becomes a blocked row, the
   * page's count goes up by one, and the keyboard can reach that row.
   *
   * Nothing is acknowledged here on purpose - the acknowledgement is its own
   * journey, and a journey that also acked would leave the count it asserted
   * ambiguous.
   */
  'needs-you-blocked-row-and-pending-count': async (page) => {
    watchPage(page)
    await openDashboard(page)

    const before = await hub.pendingCount()
    // The recorder goes in first, so both ends of the interval are stamped by clocks
    // that are not this process's request: the hub's own `receivedAt` for the event,
    // and the page's own clock when the row has been painted.
    await recordRowAppearance(page, sessionIdFor('blocked'))
    const { sessionId } = await ingestNeedsYou('blocked')
    await waitForRow(page, sessionId)
    const timing = await readRowTiming(page)
    const acceptedAt = await acceptedAtMsFor(sessionId)
    await expect(row(page, sessionId)).toHaveCount(1)
    expect(timing.paintedAt, 'the page recorded when it painted the row').not.toBeNull()
    const visibleAfterMs = (timing.paintedAt ?? timing.presentAt ?? Number.NaN) - acceptedAt
    const presentAfterMs = (timing.presentAt ?? Number.NaN) - acceptedAt

    // The row's own four encodings: an icon and a word, the repository it belongs
    // to, and the machine-readable pending state (LD-FR-02, LD-FR-09).
    const blocked = row(page, sessionId)
    await expect(blocked).toHaveAttribute(MIRROR_STATE_ATTRIBUTE, 'blocked')
    await expect(blocked.locator(`[${MIRROR_STATE_LABEL_ATTRIBUTE}]`)).toHaveText('Blocked')
    await expect(blocked).toHaveAttribute(MIRROR_PENDING_ATTRIBUTE, '1')
    await expect(blocked).toHaveAttribute(MIRROR_REPOSITORY_ATTRIBUTE, repositoryShortNameFor('blocked'))
    await expect(blocked).toContainText('waiting on you')
    await expect(blocked).toContainText(repositoryShortNameFor('blocked'))
    // Grouping: the row is nested under a heading carrying the repository's short
    // name, and the full path is detail rather than the primary label.
    const group = page.locator(`[data-mirror-group="${repositoryShortNameFor('blocked')}"]`)
    await expect(group).toHaveCount(1)
    await expect(group.locator(`[data-mirror-group-label]`)).toHaveText(repositoryShortNameFor('blocked'))
    await expect(group).toHaveAttribute('data-mirror-path', repositoryPathFor('blocked'))

    // The page's count against the hub's own, which is the badge's own number
    // (LD-FR-04). Both halves, so a page that computed its own figure is caught.
    await expect(page.locator(`[${PAGE.pending}]`)).toHaveText(`${String(before + 1)} pending`)
    expect(await hub.pendingCount(), 'the hub own pending count moved by one').toBe(before + 1)

    // Keyboard reach, and nothing else: focus is placed and asserted, and no
    // activation happens in this journey.
    await tabIntoTheRowList(page)
    await arrowToRow(page, sessionId)
    expect(await focusedSessionId(page), 'the keyboard is on the blocked row').toBe(sessionId)
    await expect(row(page, sessionId)).toHaveAttribute(MIRROR_FOCUSED_ATTRIBUTE, 'true')
    // The single control names the row it will act on, so a developer is never
    // acknowledging a row they did not mean (LD-FR-05).
    await expect(page.locator(`[${PAGE.ack}]`)).toHaveText(
      `Acknowledge ${repositoryShortNameFor('blocked')} · ${sessionId}`,
    )
    await expect(page.locator(`[${PAGE.ack}]`)).toBeEnabled()
    // No key was pressed that activates, so nothing was written.
    await expect(row(page, sessionId)).not.toHaveAttribute(MIRROR_ACTIVATIONS_ATTRIBUTE, /.+/)
    expect(await hub.pendingCount(), 'this journey acknowledged nothing').toBe(before + 1)

    // APX-CON-11's fourth budget, measured as the budget words it: from the instant
    // the hub recorded the accepted event to the instant the page had painted the row
    // for it. Both ends are read from a clock that is not this process's request, so
    // the number is the product's latency and not the instrument's overhead. The
    // canvas is not sampled pixel by pixel; what is measured is the row's arrival in
    // the page and the two frames after it, which is where the canvas paint of the
    // same row model happens.
    observe({
      name: 'live update painted in the page after an accepted event (APX-CON-11)',
      expected: `<= ${String(BUDGET.liveUpdateVisibleMs)} ms`,
      actual: `${String(visibleAfterMs)} ms`,
      measured: String(visibleAfterMs),
      ok: visibleAfterMs <= BUDGET.liveUpdateVisibleMs,
    })
    // The same interval at the earlier of the two instants, recorded rather than
    // judged: it separates "the page had the row" from "the page had shown it", so a
    // future run can tell a slow reduction from a slow frame.
    observe({
      name: 'live update present in the page after an accepted event (recorded, not budgeted)',
      expected: `for comparison with the budgeted reading above`,
      actual: `${String(presentAfterMs)} ms`,
      measured: String(presentAfterMs),
      ok: presentAfterMs <= visibleAfterMs,
    })
  },

  /**
   * The keyboard-only path, end to end: Tab into the list, arrow to the block, and
   * Enter. The activation is marked on the row and the count that was marked
   * activated is the product's own, re-read from the hub.
   */
  'keyboard-only-reach-and-activate': async (page) => {
    watchPage(page)
    await openDashboard(page)

    const before = await hub.pendingCount()
    const { sessionId } = await ingestNeedsYou('keyboard')
    await expect(row(page, sessionId)).toHaveCount(1)

    await tabIntoTheRowList(page)
    await arrowToRow(page, sessionId)

    // Enter on a focused row that is waiting on something acknowledges it, which
    // is the row-level half of the page's one control.
    await page.keyboard.press('Enter')
    await expect(row(page, sessionId)).toHaveAttribute(MIRROR_ACTIVATIONS_ATTRIBUTE, '1')
    await expect(page.locator(`[${PAGE.refusals}] [${PAGE.refusal}]`)).toHaveCount(0)
    await expect(row(page, sessionId)).toHaveAttribute(MIRROR_PENDING_ATTRIBUTE, '0')
    await expect(page.locator(`[${PAGE.pending}]`)).toHaveText(`${String(before)} pending`)
    expect(await hub.pendingCount(), 'the hub own count came back down').toBe(before)

    // Focus survived the acknowledgement's own live update, which is the case that
    // is easy to lose: the mirror rebuilds under the focused element.
    expect(await focusedSessionId(page), 'focus is still on the row that was activated').toBe(sessionId)
  },

  /**
   * Acknowledgement through the page's only write, and the history panel after it.
   *
   * Driven from the keyboard - Enter on the focused row - because that is the route
   * the page currently supports end to end; the header control's pointer route is a
   * recorded required change, and this file's header says why proving it as it
   * behaves would mean enshrining a dead control.
   *
   * The history is the panel that must stay content-free, so the entry is read whole
   * - every field it has and every attribute it carries - rather than the one field
   * the assertion happens to be about (LD-FR-08, APX-FR-01).
   */
  'acknowledgement-clears-the-row-and-history-lists-it': async (page) => {
    watchPage(page)
    await openDashboard(page)

    const before = await hub.pendingCount()
    const { sessionId } = await ingestNeedsYou('acknowledged')
    const blocked = row(page, sessionId)
    await expect(blocked).toHaveCount(1)
    await expect(blocked).toHaveAttribute(MIRROR_PENDING_ATTRIBUTE, '1')
    expect(await hub.pendingCount()).toBe(before + 1)
    await expect(page.locator(`[${PAGE.pending}]`)).toHaveText(`${String(before + 1)} pending`)

    await tabIntoTheRowList(page)
    await arrowToRow(page, sessionId)
    // The single control names the row it will act on, and is offered, on the row the
    // keyboard is on (LD-FR-05).
    await expect(page.locator(`[${PAGE.ack}]`)).toHaveText(
      `Acknowledge ${repositoryShortNameFor('acknowledged')} · ${sessionId}`,
    )
    await expect(page.locator(`[${PAGE.ack}]`)).toBeEnabled()

    await page.keyboard.press('Enter')

    // The optimistic marker comes off whatever the answer was, and the count is the
    // hub's own number rather than a decrement the page computed. A refusal would
    // have printed in the refusals region, and there is none.
    await expect(page.locator(`[${PAGE.pending}]`)).toHaveText(`${String(before)} pending`)
    await expect(row(page, sessionId)).toHaveAttribute(MIRROR_PENDING_ATTRIBUTE, '0')
    await expect(page.locator(`[${PAGE.refusals}] [${PAGE.refusal}]`)).toHaveCount(0)
    await expect(page.locator(`[${PAGE.refusals}]`)).toHaveText('')
    expect(await hub.pendingCount(), 'the hub own count came back down').toBe(before)
    await expect(page.locator(`[${PAGE.ack}]`)).toBeDisabled()
    await expect(page.locator(`[${PAGE.ackHint}]`)).toContainText('not waiting on anything')

    // The history panel now lists the event, with the five facts and nothing else.
    const historyRow = page.locator(`[${HISTORY_ENTRY_ATTRIBUTE}]`).filter({ hasText: sessionId }).first()
    await expect(historyRow).toBeVisible({ timeout: 20_000 })
    await expect(historyRow.locator(`[${HISTORY_CLASS_ATTRIBUTE}]`)).toHaveText('Needs you')
    await expect(historyRow.locator(`[${HISTORY_REPOSITORY_ATTRIBUTE}]`)).toHaveText(
      repositoryShortNameFor('acknowledged'),
    )
    await expect(historyRow.locator(`[${HISTORY_SESSION_ATTRIBUTE}]`)).toHaveText(sessionId)
    await expect(historyRow.locator(`[${HISTORY_ACK_ATTRIBUTE}]`)).toHaveText('Acknowledged')
    await expect(historyRow.locator(`[${HISTORY_RESOLUTION_ATTRIBUTE}]`)).toHaveText('Unresolved')
    await expect(historyRow).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/)

    // No content, and no field shaped like content, anywhere in the panel.
    const rendered = await page.evaluate(
      (panelAttribute) => {
        const panel = document.querySelector(`[${panelAttribute}]`)
        const fields = new Set<string>()
        for (const element of panel?.querySelectorAll('*') ?? []) {
          for (const name of element.getAttributeNames()) fields.add(name)
        }
        return {
          fields: [...fields].sort(),
          text: panel?.textContent ?? '',
          elementCount: panel?.querySelectorAll('*').length ?? 0,
        }
      },
      PAGE.historyPanel,
    )
    const forbidden = /content|prompt|response|message|body|text|snippet|diff|output|transcript/i
    expect(
      rendered.fields.filter((name) => forbidden.test(name)),
      'the history panel carries no content-shaped attribute',
    ).toEqual([])
    expect(rendered.text, 'the history panel renders no raw payload').not.toMatch(forbidden)
    expect(rendered.elementCount, 'the panel holds one entry, not a page of them').toBeLessThan(40)

    // And the route agrees, which is the half a browser cannot grade itself.
    const events = await hub.get<{ events: readonly { eventId: string; class: string }[] }>(
      `/api/events?sessionId=${encodeURIComponent(sessionId)}&limit=50`,
    )
    const mine = events.body.events
    expect(mine.length, 'the hub stored exactly the one event for this session').toBe(1)
    expect(mine[0]?.class).toBe('needs-you')
  },

  /**
   * The interrupted stream, and the reconnect that resumes on a cursor.
   *
   * The interruption is the hub stopping, the way a service manager stops it: SIGTERM
   * through the product's own ordered close, which ends the stream. A page that
   * cannot hear from the hub must say so, and a hub that comes back over the same
   * state directory on the same port is what makes the reconnect half provable
   * afterwards (LD-FR-03).
   *
   * Why the hub and not the browser: `browserContext.setOffline(true)` was tried
   * first and did not close an already-established `EventSource` on this Chromium -
   * the page stayed `live` and the header kept presenting the last state as current,
   * which is precisely the presentation this journey exists to forbid. An offline
   * browser that still looks live is a finding about the instrument, not about the
   * product, so the instrument changed rather than the assertion.
   */
  'interrupted-stream-shows-a-stale-state': async (page) => {
    watchPage(page)
    await openDashboard(page)

    const before = await hub.pendingCount()
    const { sessionId } = await ingestNeedsYou('stale')
    await expect(row(page, sessionId)).toHaveCount(1)
    await expect(page.locator(`[${PAGE.pending}]`)).toHaveText(`${String(before + 1)} pending`)

    await hub.stop()
    // The state is explicit, and the sentence says the rows are the last the hub
    // sent. A page that showed the same rows with a quiet header would be exactly
    // the failure this journey exists to catch.
    await expect(page.locator(`[${PAGE.header}]`)).toHaveAttribute(PAGE.connection, 'stale', { timeout: 30_000 })
    await expect(page.locator(`[${PAGE.connectionText}]`)).toHaveText(
      'Stale: the hub stopped sending. The rows below are the last it sent.',
    )
    // The count is qualified, because an unqualified number next to rows that are
    // not known to be current is a lie with a confident look.
    await expect(page.locator(`[${PAGE.pending}]`)).toHaveText(`${String(before + 1)} pending (last known)`)
    // The rows are still there, and are still the hub's last word rather than a
    // guess: nothing was discarded.
    await expect(row(page, sessionId)).toHaveCount(1)
    // And the page really is holding the last state: the hub has no listener at all
    // now, so a request cannot succeed and the row cannot have been re-read.
    await expect(hub.get('/api/health')).rejects.toThrow()

    // The hub comes back over the same state directory on the same port. The page
    // reconnects on its cursor, becomes current again without a reload, and a new
    // event arriving on the resumed connection is what proves it is a live stream
    // rather than a second snapshot.
    await hub.start()
    await expect(page.locator(`[${PAGE.header}]`)).toHaveAttribute(PAGE.connection, 'live', { timeout: 30_000 })
    await expect(page.locator(`[${PAGE.connectionText}]`)).toHaveText('Live')
    await expect(page.locator(`[${PAGE.pending}]`)).toHaveText(`${String(before + 1)} pending`)

    const incoming = sessionIdFor('incoming')
    await ingest({
      eventName: 'permission.asked',
      sessionId: incoming,
      repoFullPath: repositoryPathFor('incoming'),
      transitionId: 'e2e-stale-after-reconnect-1',
    })
    await expect(row(page, incoming)).toHaveCount(1, { timeout: 30_000 })
    await expect(page.locator(`[${PAGE.pending}]`)).toHaveText(`${String(before + 2)} pending`)
  },

  /**
   * A deep link, built the way the card and the tray build it.
   *
   * "The way they build it" is checked rather than assumed: the query key this
   * journey uses is the literal the dashboard's own deep-link module declares, and
   * it is compared against the literal the hub's metrics module publishes - which is
   * the one the card (src/notify/surface/card.ts) and the tray (src/hub/tray.ts)
   * both read. If the three ever disagree, this journey fails before it opens a
   * page, because a deep link that focuses nothing is worse than one that does
   * nothing (LD-FR-06, NT-FR-07).
   */
  'deep-link-focuses-its-session-and-survives-a-live-update': async (page) => {
    watchPage(page)
    await openDashboard(page)

    const { sessionId } = await ingestNeedsYou('deep-link')

    // "The way the card and the tray build it" is the product's own builder, not a
    // URL this suite assembles: `deepLinkFor` is the single builder
    // src/notify/policy.ts hands to `planNotification` (which is how a card gets its
    // link) and src/hub/tray.ts calls for a click. So the two entry points cannot
    // disagree, and this journey opens exactly what they open.
    //
    // The literal behind it is checked too, because the builder imports it from the
    // module that publishes it and the page restates it: three copies of one name
    // is the failure this catches, and a link that focuses nothing is worse than one
    // that does nothing (LD-FR-06, NT-FR-07).
    const metricsSource = readFileSync(path.join(REPO_ROOT, 'src', 'hub', 'metrics.ts'), 'utf8')
    const published = /export const DEEP_LINK_QUERY_KEY = '([^']+)'/.exec(metricsSource)
    expect(published, 'the hub publishes a deep-link query key literal').not.toBeNull()
    expect(published?.[1], "the page's deep-link key and the hub's published key are the same literal").toBe(
      DEEP_LINK_QUERY_KEY,
    )
    const built = deepLinkFor(hub.origin, sessionId)
    expect(built, 'the product own builder produced a link for the live origin').not.toBeNull()
    expect(built).toBe(`${hub.origin}/?${DEEP_LINK_QUERY_KEY}=${encodeURIComponent(sessionId)}`)

    await page.goto(built ?? `${hub.origin}/`)
    await expect(page.locator(`[${PAGE.deepLinkStatus}]`)).toHaveAttribute(PAGE.deepLinkStatus, 'focused', {
      timeout: 20_000,
    })
    expect(await focusedSessionId(page), 'the deep-linked row took focus').toBe(sessionId)
    await expect(row(page, sessionId)).toHaveAttribute(MIRROR_FOCUSED_ATTRIBUTE, 'true')

    // The focus survives a live update arriving for a different session underneath
    // it, which is the whole of LD-FR-06's second clause.
    const other = sessionIdFor('incoming')
    await ingest({
      eventName: 'permission.asked',
      sessionId: other,
      repoFullPath: repositoryPathFor('incoming'),
      transitionId: 'e2e-deeplink-update-1',
    })
    await expect(row(page, other)).toHaveCount(1, { timeout: 30_000 })
    expect(await focusedSessionId(page), 'the deep link still holds focus after the update').toBe(sessionId)
    await expect(page.locator(`[${PAGE.deepLinkStatus}]`)).toHaveAttribute(PAGE.deepLinkStatus, 'focused')

    // A link naming a session that is not there says so, rather than focusing
    // nothing silently (docs/features/live-dashboard.md §8 Open Question 3).
    await page.goto(`${hub.origin}/?${DEEP_LINK_QUERY_KEY}=ses_e2e_not_a_session`)
    await expect(page.locator(`[${PAGE.deepLinkStatus}]`)).toHaveAttribute(PAGE.deepLinkStatus, 'missing', {
      timeout: 20_000,
    })
    await expect(page.locator(`[${PAGE.deepLink}]`)).toContainText('not on the page')
  },

  /**
   * The negative path, and the one that catches the most.
   *
   * A session that opens, greets and closes is suppressed by the classifier and by
   * the class policy, so it must produce no event, no row and no change in the
   * count. A page that invented a row for it - or a hub that stored an event for
   * it - would pass every other journey in this file and still be wrong, which is
   * why this one exists (ADR-004, LD-FR-02).
   */
  'greeting-and-close-produce-nothing': async (page) => {
    watchPage(page)
    await openDashboard(page)

    const sessionId = sessionIdFor('greeting')
    const pendingBefore = await hub.pendingCount()

    const greeting = await ingest({
      eventName: 'message.updated',
      sessionId,
      repoFullPath: repositoryPathFor('greeting'),
      transitionId: 'e2e-greeting-1',
    })
    const closing = await ingest({
      eventName: 'session.status',
      sessionId,
      repoFullPath: repositoryPathFor('greeting'),
      transitionId: 'e2e-greeting-close-1',
      turnWork: { toolCall: false, fileEdit: false, todoUpdate: false },
    })

    // The hub accepted both signals and stored neither as an event: an fyi is
    // refused before a card model exists, and an idle turn that recorded no work is
    // suppressed by the classifier's own gate.
    expect([greeting.status, closing.status], 'both signals were accepted and classified').toEqual([202, 202])

    const events = await hub.get<{ events: readonly unknown[]; count: number }>(
      `/api/events?sessionId=${encodeURIComponent(sessionId)}&limit=50`,
    )
    expect(events.body.count, 'the hub stored no event for a greeting and a close').toBe(0)
    expect(await hub.pendingCount(), 'and the pending count did not move').toBe(pendingBefore)

    // Give the page every chance to have invented a row, then check it did not.
    await page.waitForTimeout(1_500)
    await expect(row(page, sessionId), 'no row was invented for the greeting session').toHaveCount(0)
    await expect(page.locator(`[${PAGE.pending}]`)).toHaveText(`${String(pendingBefore)} pending`)
    await expect(
      page.locator(`[${HISTORY_ENTRY_ATTRIBUTE}]`).filter({ hasText: sessionId }),
      'no history entry was invented for the greeting session',
    ).toHaveCount(0)
    await expect(page.locator(`[${PAGE.header}]`)).toHaveAttribute(PAGE.connection, 'live')
  },
}

// ---------------------------------------------------------------------------
// The suite, generated from the declared journey list
// ---------------------------------------------------------------------------

/**
 * Every declared id has a runner, and every runner is declared.
 *
 * Checked with a throw rather than an `expect`, because this runs while the file is
 * being collected and outside any test: a declared journey with no runner is a gap
 * in the suite that must stop the run before it starts, not an assertion a test makes
 * after a journey has already been reported as missing.
 */
const missing = EXPECTED_JOURNEYS.filter((journey) => JOURNEYS[journey.id] === undefined).map(
  (journey) => journey.id,
)
const extra = Object.keys(JOURNEYS).filter(
  (id) => !EXPECTED_JOURNEYS.some((journey) => journey.id === id),
)
if (missing.length > 0) {
  throw new Error(
    `every declared journey needs a runner in tests/e2e/dashboard.spec.ts, and these have none: ` +
      `${missing.join(', ')}. A journey that is declared and never driven is a green result that ` +
      'exercised nothing (LD-4).',
  )
}
if (extra.length > 0) {
  throw new Error(
    `every runner in tests/e2e/dashboard.spec.ts must be a declared journey, and these are not: ` +
      `${extra.join(', ')}. Add them to EXPECTED_JOURNEYS in scripts/verify-dashboard-e2e.mjs, which ` +
      'is the list the teardown and the summary both read (LD-4).',
  )
}

for (const journey of EXPECTED_JOURNEYS) {
  const run = JOURNEYS[journey.id]
  if (run === undefined) continue
  test(`${journey.id} — ${journey.name}`, async ({ page }) => {
    await run(page)
  })
}
