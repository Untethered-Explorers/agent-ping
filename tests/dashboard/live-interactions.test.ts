// LD-3: the page's interactions against the real hub API, driven through the real
// mount entry point against a stubbed hub.
//
//   npm test -- tests/dashboard/live-interactions.test.ts
//
// What is asserted here, one group per acceptance criterion:
//
//   1. A successful acknowledgement removes the row's pending marker and updates the
//      pending count - optimistically while the request is in flight, then from the
//      hub's own answer rather than from a decrement this page computed.
//   2. A refused acknowledgement restores the prior state and shows the refusal, in
//      the header, on the row and on the row's DOM twin.
//   3. A deep link focuses and highlights its session, and the focus survives a later
//      live update; a link naming a session the hub does not have says so instead of
//      focusing nothing.
//   4. The rendered controls contain no send, interrupt or approve action, and the
//      handoff exposes the attach command as text.
//   5. The history panel renders class, repository, session, timestamp and
//      acknowledgement or resolution state, and no content field - asserted against a
//      payload that carries one.
//
// Plus the two things LD-FR-11 and LD-3's own closure need: an information-only
// event appears inside the dashboard and never as a badge or a card, and the
// contracts this page restates rather than imports (the deep-link key, the write
// token's header, the history page size) are the hub's own literals.
//
// How the evidence is produced: the mount runs the real `mountDashboard`, the real
// PixiJS painter behind the harness's recording host, the real keyboard controller
// and the real ack transport - only `fetch`, the stream transport and the three
// readers are the stub's, because jsdom has no socket to the hub. A request the page
// makes is therefore the shipped one, and `hub.ackRequests` is what actually went
// out.
//
// What cannot be asserted in jsdom: the pixels, and the browser's own focus
// rendering. Where a claim is about what a person sees, the assertion is about the
// command stream the page painted or the DOM it built, and it says so.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MIRROR_FOCUSED_ATTRIBUTE, MIRROR_PENDING_ATTRIBUTE } from '@/dashboard/a11y/dom-mirror'
import {
  ACK_ERROR_CODES,
  ACK_REFUSAL_SENTENCE,
  WRITE_TOKEN_HEADER,
  parseAckAnswer,
  parsePendingPayload,
  pendingItemFor,
  type AckAnswer,
} from '@/dashboard/live/ack'
import {
  DEEP_LINK_QUERY_KEY,
  DEEP_LINK_SENTENCE,
  DEEP_LINK_TARGET_MAX_LENGTH,
  readDeepLinkTarget,
} from '@/dashboard/live/deeplink'
import {
  HARNESS_ATTACH,
  HANDOFF_COMMAND_ATTRIBUTE,
  handoffCommand,
} from '@/dashboard/live/handoff'
import {
  HISTORY_ACK_ATTRIBUTE,
  HISTORY_CLASS_ATTRIBUTE,
  HISTORY_ENTRY_ATTRIBUTE,
  HISTORY_PAGE_SIZE,
  HISTORY_REPOSITORY_ATTRIBUTE,
  HISTORY_RESOLUTION_ATTRIBUTE,
  HISTORY_SESSION_ATTRIBUTE,
  HISTORY_TIMESTAMP_ATTRIBUTE,
  HISTORY_UNREADABLE_SENTENCE,
  parseHistoryEntry,
} from '@/dashboard/live/history'
import { ACTIVATED_MARKER, LIVE_COLORS, REFUSED_MARKER } from '@/dashboard/live/session-list'
import {
  DASHBOARD_ACK_ATTRIBUTE,
  DASHBOARD_CONNECTION_TEXT_ATTRIBUTE,
  DASHBOARD_ACK_HINT_ATTRIBUTE,
  DASHBOARD_DEEP_LINK_ATTRIBUTE,
  DASHBOARD_DEEP_LINK_STATUS_ATTRIBUTE,
  DASHBOARD_HISTORY_PANEL_ID,
  DASHBOARD_HISTORY_TOGGLE_ATTRIBUTE,
  DASHBOARD_PENDING_ATTRIBUTE,
  DASHBOARD_REFUSALS_ATTRIBUTE,
  DASHBOARD_REFUSAL_ATTRIBUTE,
  DASHBOARD_REFUSAL_SESSION_ATTRIBUTE,
  DASHBOARD_ROW_REFUSAL_ATTRIBUTE,
} from '@/dashboard/main'
import {
  createStubHub,
  destroyLiveMounts,
  hubHistoryEvent,
  hubPendingItem,
  hubSession,
  mountLiveDashboard,
  rectCommands,
  rowText,
  type LiveMount,
  type MountLiveOptions,
  type StubHub,
} from './live-harness'

const repositoryRoot = process.cwd()

afterEach(() => {
  destroyLiveMounts()
})

// ---------------------------------------------------------------------------
// Fixtures: a repository with something waiting on the developer
// ---------------------------------------------------------------------------

const BLOCKED = 'session-blocked'
const RUNNING = 'session-running'
/** What the hub reported for the blocked row, which is what the page still shows. */
const BLOCKED_PENDING_COUNT = 2

const twoPending = (): readonly ReturnType<typeof hubSession>[] => [
  hubSession({
    sessionId: BLOCKED,
    repoShortName: 'agent-ping',
    repoFullPath: '/home/dev/Projects/agent-ping',
    state: 'blocked',
    pendingCount: 2,
    lastSeenAt: '2026-09-27T11:58:00.000Z',
  }),
  hubSession({
    sessionId: RUNNING,
    repoShortName: 'agent-ping',
    repoFullPath: '/home/dev/Projects/agent-ping',
    state: 'running',
    pendingCount: 0,
    lastSeenAt: '2026-09-27T11:59:00.000Z',
  }),
]

/**
 * Two waiting items for the blocked row, deliberately out of identifier order.
 *
 * The hub stores them in no particular order, so the page has to choose which one a
 * row acknowledges, and it has to choose the same one every time. The older item is
 * also the one with the *later* identifier, so an implementation that picked the
 * first row of the set would be caught by the request it posts.
 */
const waitingItems = (): ReturnType<typeof hubPendingItem>[] => [
  hubPendingItem({ eventId: 'event-b', sessionId: BLOCKED, occurredAt: '2026-09-27T11:57:00.000Z' }),
  hubPendingItem({ eventId: 'event-a', sessionId: BLOCKED, occurredAt: '2026-09-27T11:59:00.000Z' }),
]

interface Mounted extends LiveMount {
  readonly hub: StubHub
}

async function mountWithPending(
  options: MountLiveOptions & { readonly hub?: StubHub } = {},
): Promise<Mounted> {
  const hub =
    options.hub ??
    createStubHub({ sessions: twoPending(), pending: ['event-b', 'event-a'], pendingItems: waitingItems() })
  const mount = await mountLiveDashboard({ ...options, hub, writeToken: 'token' })
  hub.ready()
  await mount.settle()
  return mount
}

// ---------------------------------------------------------------------------
// Reading the page
// ---------------------------------------------------------------------------

const entryFor = (mount: LiveMount, sessionId: string): HTMLElement | null =>
  mount.dashboard.mirror.entryForSession(sessionId)

const headerText = (mount: LiveMount): string =>
  mount.container.ownerDocument.querySelector(`[${DASHBOARD_PENDING_ATTRIBUTE}]`)?.textContent ?? ''

const refusalLines = (mount: LiveMount): readonly Element[] =>
  [
    ...mount.container.ownerDocument.querySelectorAll(`[${DASHBOARD_REFUSALS_ATTRIBUTE}] [${DASHBOARD_REFUSAL_ATTRIBUTE}]`),
  ]

const ackButton = (mount: LiveMount): HTMLButtonElement => {
  const button = mount.container.ownerDocument.querySelector<HTMLButtonElement>(
    `[${DASHBOARD_ACK_ATTRIBUTE}]`,
  )
  if (button === null) throw new Error('the page rendered no acknowledgement control')
  return button
}

const deepLinkLine = (mount: LiveMount): HTMLElement | null =>
  mount.container.ownerDocument.querySelector<HTMLElement>(`[${DASHBOARD_DEEP_LINK_ATTRIBUTE}]`)

/** The word the row's meta cell carries, read off the painted command stream. */
const metaCell = (mount: LiveMount, sessionId: string): string => {
  const row = mount.dashboard.rows.find((candidate) => candidate.sessionId === sessionId)
  if (row === undefined) throw new Error(`no row for ${sessionId}`)
  return rowText(row, mount.target.commands, 'session-age') ?? ''
}

const paintedStatus = (mount: LiveMount, sessionId: string): string => {
  const row = mount.dashboard.rows.find((candidate) => candidate.sessionId === sessionId)
  if (row === undefined) throw new Error(`no row for ${sessionId}`)
  return rowText(row, mount.target.commands, 'session-status') ?? ''
}

const focusBandPainted = (mount: LiveMount, sessionId: string): boolean => {
  const row = mount.dashboard.rows.find((candidate) => candidate.sessionId === sessionId)
  if (row === undefined) return false
  return rectCommands(mount.target.commands).some(
    (command) =>
      command.y >= row.y &&
      command.y < row.y + row.height &&
      (command.fill === LIVE_COLORS.focusFill || command.fill === LIVE_COLORS.focusRail),
  )
}

const visibleText = (mount: LiveMount): string =>
  mount.container.ownerDocument.body.textContent ?? ''

// ---------------------------------------------------------------------------
// 1. A successful acknowledgement
// ---------------------------------------------------------------------------

describe('LD-3 a successful acknowledgement removes the pending marker and updates the count', () => {
  it('posts one request to the one mutating route, with the token and no body', async () => {
    const mount = await mountWithPending()

    await mount.dashboard.acknowledge(BLOCKED)

    expect(mount.hub.ackRequests).toHaveLength(1)
    const request = mount.hub.ackRequests[0]!
    // The path carries the row key and nothing else; the route reads no body, so a
    // page that sent one would be a page whose request the hub has to ignore.
    expect(request.method).toBe('POST')
    expect(request.url).toBe(`http://127.0.0.1:43117/api/ack/event-b`)
    expect(request.body).toBeNull()
    expect(request.headers[WRITE_TOKEN_HEADER]).toBe('test-write-token')
    // And the write is the only mutating request the page can make at all: every
    // other URL it touched is a GET of a read route.
    const mutating = mount.hub.requests.filter((entry) => entry.method !== 'GET')
    expect(mutating.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'POST http://127.0.0.1:43117/api/ack/event-b',
    ])
  })

  it('clears the row marker optimistically, then follows the hub count rather than a decrement', async () => {
    const mount = await mountWithPending()
    const release = mount.hub.deferAck()

    const pressed = mount.dashboard.acknowledge(BLOCKED)
    await mount.settle()

    // In flight: the row's marker has already moved, on the canvas and on the twin.
    // This is the optimistic half of LD-FR-05, and it is a *row* fact: the header's
    // number is still the hub's, because a page that guessed a count could disagree
    // with the tray badge for the same state (LD-FR-04).
    expect(entryFor(mount, BLOCKED)?.getAttribute(MIRROR_PENDING_ATTRIBUTE)).toBe('1')
    expect(paintedStatus(mount, BLOCKED)).toBe('opencode – waiting on you · 1 pending')
    expect(headerText(mount)).toBe('2 pending')

    release()
    const result = await pressed
    await mount.settle()

    expect(result.outcome).toBe('applied')
    // The number now is the one out of the hub's own 200 body: the stub applied the
    // acknowledgement, so one item is left, and the page says one.
    expect(result.pendingCount).toBe(1)
    expect(headerText(mount)).toBe('1 pending')
    // The hub then publishes its own `acknowledged` frame, which is the state the
    // page keeps. The row's marker is the hub's by then, not the optimistic one.
    mount.hub.change({
      cursor: 7,
      kind: 'acknowledged',
      session: hubSession({
        sessionId: BLOCKED,
        repoShortName: 'agent-ping',
        state: 'blocked',
        pendingCount: 1,
        lastSeenAt: '2026-09-27T12:00:00.000Z',
      }),
      pendingCount: 1,
    })
    await mount.settle()
    expect(headerText(mount)).toBe('1 pending')
    expect(entryFor(mount, BLOCKED)?.getAttribute(MIRROR_PENDING_ATTRIBUTE)).toBe('1')
    expect(refusalLines(mount)).toHaveLength(0)
  })

  it('finds exactly one of each of its own regions when the served document declares them', async () => {
    // src/dashboard/index.html declares the header's elements so the page's chrome is
    // readable in its own markup, and the entry point owns the other half of the
    // same job. A real browser found what happens when the two disagree: two
    // acknowledgement hints, two refusals regions, and every reader - `aria-describedby`,
    // a query, a screen reader - landing on the empty one. jsdom cannot see it,
    // because its document has no pre-declared header to duplicate, so this mounts
    // against the real markup.
    const hub = createStubHub({
      sessions: twoPending(),
      pending: ['event-b', 'event-a'],
      pendingItems: waitingItems(),
      events: [hubHistoryEvent({ eventId: 'event-1', sessionId: BLOCKED })],
    })
    const mount = await mountLiveDashboard({
      hub,
      writeToken: 'token',
      servedHeader: true,
    })
    hub.ready()
    await mount.settle()
    mount.dashboard.navigator.focusSession(BLOCKED)
    await mount.settle()
    await mount.dashboard.acknowledge(BLOCKED)
    await mount.settle()

    const doc = mount.container.ownerDocument
    for (const attribute of [
      DASHBOARD_PENDING_ATTRIBUTE,
      DASHBOARD_CONNECTION_TEXT_ATTRIBUTE,
      DASHBOARD_ACK_ATTRIBUTE,
      DASHBOARD_ACK_HINT_ATTRIBUTE,
      DASHBOARD_REFUSALS_ATTRIBUTE,
      DASHBOARD_DEEP_LINK_ATTRIBUTE,
      DASHBOARD_HISTORY_TOGGLE_ATTRIBUTE,
    ]) {
      expect(doc.querySelectorAll(`[${attribute}]`).length, `${attribute} is declared twice`).toBe(1)
    }
    // The one the control points at is the one the page fills in, so the reason a
    // control is disabled is actually on the screen.
    const describedBy = ackButton(mount).getAttribute('aria-describedby')
    const hint = doc.querySelector(`[${describedBy ?? ''}]`)
    expect(hint?.textContent).toContain('oldest of the 2 items')
    // And the refusals the region shows are the ones inside the announced region -
    // which is the point of the whole check: with two regions, the one the screen
    // reader announces is the empty one.
    hub.refuseAck({ status: 409, body: { error: 'conflict' } })
    await mount.dashboard.acknowledge(BLOCKED)
    await mount.settle()
    const alerts = doc.querySelectorAll('[role="alert"]')
    expect(alerts).toHaveLength(1)
    expect(refusalLines(mount).length).toBeGreaterThan(0)
    expect(alerts[0]?.querySelectorAll(`[${DASHBOARD_REFUSAL_ATTRIBUTE}]`).length).toBe(
      refusalLines(mount).length,
    )
  })

  it('releases the row when focus leaves the list, and holds the last activated one', async () => {
    const mount = await mountWithPending()
    mount.dashboard.navigator.focusSession(BLOCKED)
    await mount.settle()
    expect(ackButton(mount).hasAttribute('disabled')).toBe(false)
    expect(focusBandPainted(mount, BLOCKED)).toBe(true)

    // Focus leaves the row list for good: a Tab out of it, or the pointer landing on
    // the header's own control. A real focus move, so the related target really is
    // outside the list, and the real `focusout` the browser fires.
    const outside = mount.container.ownerDocument.createElement('button')
    mount.container.ownerDocument.body.append(outside)
    outside.focus()
    await mount.settle()

    // Neither of those is a row, so the page must stop painting a focus band on one
    // and stop offering a control that would act on it.
    expect(focusBandPainted(mount, BLOCKED)).toBe(false)
    expect(ackButton(mount).hasAttribute('disabled')).toBe(true)
    expect(
      mount.container.ownerDocument
        .querySelector(`[${DASHBOARD_ACK_HINT_ATTRIBUTE}]`)
        ?.textContent,
    ).toContain('Focus a row')

    // Traversal inside the list is not a leave, and must not release the row: moving
    // from one row to the next is the ordinary use of the arrow keys.
    mount.dashboard.navigator.focusSession(BLOCKED)
    await mount.settle()
    expect(focusBandPainted(mount, BLOCKED)).toBe(true)
    entryFor(mount, BLOCKED)?.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: entryFor(mount, RUNNING) }),
    )
    await mount.settle()
    expect(focusBandPainted(mount, BLOCKED)).toBe(true)
    expect(ackButton(mount).hasAttribute('disabled')).toBe(false)

    // The row in hand is the focused one, else the last activated one. A developer
    // who activated a row with Enter and then moved their pointer away has still
    // named that row, and the control saying so is the difference between a control
    // that acts on a remembered choice and one that acts on a guess. Enter, so the
    // activation is recorded the way a keypress records it.
    entryFor(mount, BLOCKED)?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
    await mount.settle()
    expect(mount.hub.ackRequests).toHaveLength(1)
    expect(mount.dashboard.activatedSessionId).toBe(BLOCKED)

    outside.focus()
    await mount.settle()
    // The control is still about the row that was activated, and its label still
    // names that row, so the press that follows is not a guess. It is still enabled
    // because the page shows the hub's count for that row, and a write's own answer
    // is not a state change the page may paint ahead of the hub's next frame.
    expect(ackButton(mount).textContent).toContain(BLOCKED)
    expect(ackButton(mount).textContent).toContain('agent-ping')
    expect(
      mount.container.ownerDocument
        .querySelector(`[${DASHBOARD_ACK_HINT_ATTRIBUTE}]`)
        ?.textContent,
    ).toContain(`${String(BLOCKED_PENDING_COUNT)} item`)
  })

  it('says nothing about a session with nothing waiting, and refuses in words when pressed', async () => {
    const mount = await mountWithPending()
    mount.dashboard.navigator.focusSession(RUNNING)
    await mount.settle()

    // The control is disabled with a reason rather than enabled for a third of its
    // presses: a control that refuses routinely is a control nobody trusts.
    expect(ackButton(mount).hasAttribute('disabled')).toBe(true)
    expect(
      mount.container.ownerDocument
        .querySelector(`[${DASHBOARD_ACK_HINT_ATTRIBUTE}]`)
        ?.textContent,
    ).toContain('not waiting on anything')

    // Asked for directly, it refuses - visibly, and without a request.
    const result = await mount.dashboard.acknowledge(RUNNING)
    expect(result.outcome).toBe('refused')
    expect(result.refusal?.code).toBe('no-pending-item')
    expect(mount.hub.ackRequests).toHaveLength(0)
    expect(refusalLines(mount)).toHaveLength(1)
  })

  it('acknowledges the oldest waiting item, and only a needs-you one', () => {
    const items = parsePendingPayload({ items: waitingItems() })
    // Out of order in the payload, and the older item has the later identifier.
    expect(items.map((item) => item.eventId)).toEqual(['event-b', 'event-a'])
    expect(pendingItemFor(items, BLOCKED)?.eventId).toBe('event-b')

    const withAnFyi = parsePendingPayload({
      items: [
        ...waitingItems(),
        hubPendingItem({
          eventId: 'event-fyi',
          sessionId: BLOCKED,
          class: 'fyi',
          occurredAt: '2026-09-27T11:50:00.000Z',
        }),
      ],
    })
    // An fyi is older than both and is still not eligible: the ack route's lifecycle
    // refuses anything that is not a pending item with a 409 (HC-FR-05), and a page
    // that asked for a refusal it knew was coming would be worse than one that says
    // there is nothing to acknowledge.
    expect(pendingItemFor(withAnFyi, BLOCKED)?.eventId).toBe('event-b')
  })
})

// ---------------------------------------------------------------------------
// 2. A refused acknowledgement
// ---------------------------------------------------------------------------

describe('LD-3 a refused acknowledgement restores the prior state and shows the refusal', () => {
  it('puts the marker back, says what the hub said, and marks the row', async () => {
    const hub = createStubHub({
      sessions: twoPending(),
      pending: ['event-b', 'event-a'],
      pendingItems: waitingItems(),
    })
    hub.refuseAck({
      status: 409,
      // The hub's own message is a literal in its route and a body this page must not
      // echo, so a distinctive string is here to be proven absent from the page.
      body: {
        error: 'conflict',
        message: 'that item is not a pending item this acknowledgement can apply to',
        reason: 'already-resolved',
      },
    })
    const mount = await mountWithPending({ hub })
    const release = hub.deferAck()

    const pressed = mount.dashboard.acknowledge(BLOCKED)
    await mount.settle()
    // Optimistic: the marker is off while the request is out.
    expect(entryFor(mount, BLOCKED)?.getAttribute(MIRROR_PENDING_ATTRIBUTE)).toBe('1')

    release()
    const result = await pressed
    await mount.settle()

    expect(result.outcome).toBe('refused')
    expect(result.refusal?.code).toBe('conflict')
    expect(result.refusal?.status).toBe(409)
    expect(result.refusal?.reason).toBe('already-resolved')

    // The prior state is back: the row is exactly as the hub's last answer left it.
    expect(entryFor(mount, BLOCKED)?.getAttribute(MIRROR_PENDING_ATTRIBUTE)).toBe('2')
    expect(paintedStatus(mount, BLOCKED)).toBe('opencode – waiting on you · 2 pending')
    // The count never moved, because a refused write changed nothing and the header
    // was never optimistic to begin with.
    expect(headerText(mount)).toBe('2 pending')

    // The refusal is visible, in three places, and the words are this page's.
    const lines = refusalLines(mount)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.getAttribute(DASHBOARD_REFUSAL_SESSION_ATTRIBUTE)).toBe(BLOCKED)
    expect(lines[0]?.textContent).toBe(
      `agent-ping · ${BLOCKED}: ${ACK_REFUSAL_SENTENCE.conflict}`,
    )
    expect(visibleText(mount)).not.toContain('is not a pending item this acknowledgement')
    // The row says so in words, where the developer is looking, and its twin carries
    // the code for a screen reader and for the next assertion.
    expect(metaCell(mount, BLOCKED)).toContain(REFUSED_MARKER)
    expect(entryFor(mount, BLOCKED)?.getAttribute(DASHBOARD_ROW_REFUSAL_ATTRIBUTE)).toBe('conflict')
  })

  it('clears the refusal when a later acknowledgement of the same row lands', async () => {
    const hub = createStubHub({
      sessions: twoPending(),
      pending: ['event-b', 'event-a'],
      pendingItems: waitingItems(),
    })
    hub.refuseAck({ status: 401, body: { error: 'unauthorised', message: 'nope' } })
    const mount = await mountWithPending({ hub })

    await mount.dashboard.acknowledge(BLOCKED)
    expect(refusalLines(mount)).toHaveLength(1)
    expect(mount.dashboard.refusals[0]?.code).toBe('unauthorised')

    hub.acceptAck()
    await mount.dashboard.acknowledge(BLOCKED)
    await mount.settle()

    // A row must not keep saying it failed after a write that worked.
    expect(refusalLines(mount)).toHaveLength(0)
    expect(mount.dashboard.refusals).toHaveLength(0)
    expect(entryFor(mount, BLOCKED)?.hasAttribute(DASHBOARD_ROW_REFUSAL_ATTRIBUTE)).toBe(false)
    expect(headerText(mount)).toBe('1 pending')
  })

  it('refuses without a request at all when this page holds no write token', async () => {
    // The state a dashboard served as a static file is really in: HC-4 keeps the
    // token out of every response and every served asset, so the page has none
    // (src/hub/security.ts). It says so, and it does not reach the boundary.
    const hub = createStubHub({
      sessions: twoPending(),
      pending: ['event-b', 'event-a'],
      pendingItems: waitingItems(),
    })
    const mount = await mountLiveDashboard({ hub, writeToken: null })
    hub.ready()
    await mount.settle()

    expect(mount.dashboard.writeTokenAvailable).toBe(false)
    const button = ackButton(mount)
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.textContent).toBe('Acknowledgement is not available on this page')
    expect(
      mount.container.ownerDocument
        .querySelector(`[${DASHBOARD_ACK_HINT_ATTRIBUTE}]`)
        ?.textContent,
    ).toContain('no hub write token')

    const result = await mount.dashboard.acknowledge(BLOCKED)
    expect(result.refusal?.code).toBe('unavailable')
    // Nothing was sent, and nothing pretended the hub had refused it.
    expect(mount.hub.ackRequests).toHaveLength(0)
    expect(mount.hub.requests.filter((entry) => entry.method !== 'GET')).toHaveLength(0)
    expect(refusalLines(mount)).toHaveLength(1)
  })

  it('refuses in its own words for every way it can fail, and a table covers them all', () => {
    // Every code has a sentence, and every sentence is this page's own: no status
    // code and no hub body reaches the page's words.
    expect(ACK_ERROR_CODES.every((code) => (ACK_REFUSAL_SENTENCE[code] ?? '').length > 20)).toBe(true)
    const answers: readonly { status: number; body: unknown }[] = [
      { status: 401, body: { error: 'unauthorised' } },
      { status: 404, body: { error: 'not-found' } },
      { status: 409, body: { error: 'conflict' } },
      { status: 500, body: { error: 'internal-error' } },
      { status: 200, body: { outcome: 'applied', eventId: 'event-b', pendingCount: 1 } },
      { status: 200, body: { outcome: 'unchanged', eventId: 'event-b', pendingCount: 1 } },
    ]
    for (const answer of answers) {
      const parsed = parseAckAnswer(BLOCKED, answer as AckAnswer)
      expect(parsed.sessionId).toBe(BLOCKED)
      if (answer.status === 200) expect(parsed.refusal).toBeNull()
      else expect(ACK_ERROR_CODES).toContain(parsed.refusal?.code)
    }
    // A 200 this build cannot read is a refusal, not a silent success: clearing a
    // marker on the strength of an answer nobody could interpret is the failure.
    expect(parseAckAnswer(BLOCKED, { status: 200, body: null }).refusal?.code).toBe('internal-error')
    // A body with no `error` is reported as the hub's own worst case, not as a code
    // a payload made up.
    expect(parseAckAnswer(BLOCKED, { status: 418, body: { error: 'teapot' } }).refusal?.code).toBe(
      'internal-error',
    )
  })

  it('refuses when the pending set could not be read, rather than acknowledging blind', async () => {
    const hub = createStubHub({
      sessions: twoPending(),
      pending: ['event-b', 'event-a'],
      pendingItems: waitingItems(),
    })
    const mount = await mountWithPending({ hub })
    hub.failNextPendingRead()

    const result = await mount.dashboard.acknowledge(BLOCKED)

    expect(result.refusal?.code).toBe('unreadable')
    expect(hub.ackRequests).toHaveLength(0)
    expect(refusalLines(mount)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 3. A deep link focuses its session, and the focus survives an update
// ---------------------------------------------------------------------------

describe('LD-3 a deep link focuses and highlights its session, and the focus survives', () => {
  const deepLinkSearch = `?${DEEP_LINK_QUERY_KEY}=${BLOCKED}`

  it('focuses and highlights the row once the hub has answered', async () => {
    const hub = createStubHub({
      sessions: twoPending(),
      pending: ['event-b', 'event-a'],
      pendingItems: waitingItems(),
    })
    const mount = await mountLiveDashboard({ hub, writeToken: 'token', search: deepLinkSearch })
    hub.ready()

    // Before the hub's first answer there is nothing to find, and the page says
    // "looking" rather than "gone" - a page that called every deep link broken in its
    // first frame would be right for a quarter of a second and wrong afterwards.
    expect(deepLinkLine(mount)?.textContent).toBe(DEEP_LINK_SENTENCE.waiting)
    expect(deepLinkLine(mount)?.getAttribute(DASHBOARD_DEEP_LINK_STATUS_ATTRIBUTE)).toBe('waiting')
    expect(mount.dashboard.deepLink.state.status).toBe('waiting')

    await mount.settle()

    const entry = entryFor(mount, BLOCKED)
    expect(mount.container.ownerDocument.activeElement).toBe(entry)
    expect(entry?.getAttribute(MIRROR_FOCUSED_ATTRIBUTE)).toBe('true')
    expect(mount.dashboard.focusedSessionId).toBe(BLOCKED)
    expect(deepLinkLine(mount)?.textContent).toBe('')
    expect(mount.dashboard.deepLink.state.status).toBe('focused')
    // The highlight is painted, not only recorded: the band and the rail are in the
    // row's own commands, and it is a shape rather than a colour swap (DP-4).
    expect(focusBandPainted(mount, BLOCKED)).toBe(true)
  })

  it('keeps that focus and highlight when a live update lands under it', async () => {
    const hub = createStubHub({
      sessions: twoPending(),
      pending: ['event-b', 'event-a'],
      pendingItems: waitingItems(),
    })
    const mount = await mountLiveDashboard({ hub, writeToken: 'token', search: deepLinkSearch })
    hub.ready()
    await mount.settle()
    const before = entryFor(mount, BLOCKED)

    // An update for a *different* row, which re-orders the group and rebuilds the
    // mirror - the case that loses focus in a page that addresses rows by index.
    hub.change({
      cursor: 9,
      kind: 'event-stored',
      session: hubSession({
        sessionId: 'session-newcomer',
        repoShortName: 'agent-ping',
        repoFullPath: '/home/dev/Projects/agent-ping',
        state: 'blocked',
        pendingCount: 1,
        lastSeenAt: '2026-09-27T12:00:00.000Z',
      }),
      pendingCount: 3,
    })
    await mount.settle()

    // The newcomer is a blocked row in the same group, so it sorts above the one the
    // link named: a page that held an index would now be focused on the wrong row.
    expect(mount.dashboard.rows[0]?.sessionId).toBe('session-newcomer')
    expect(mount.dashboard.focusedSessionId).toBe(BLOCKED)
    const after = entryFor(mount, BLOCKED)
    expect(mount.container.ownerDocument.activeElement).toBe(after)
    expect(after?.getAttribute(MIRROR_FOCUSED_ATTRIBUTE)).toBe('true')
    expect(after).not.toBe(before)
    expect(focusBandPainted(mount, BLOCKED)).toBe(true)
    expect(focusBandPainted(mount, 'session-newcomer')).toBe(false)
  })

  it('re-asserts a focus a rebuild left nowhere, but never steals a row the developer chose', async () => {
    const hub = createStubHub({
      sessions: twoPending(),
      pending: ['event-b', 'event-a'],
      pendingItems: waitingItems(),
    })
    const mount = await mountLiveDashboard({ hub, writeToken: 'token', search: deepLinkSearch })
    hub.ready()
    await mount.settle()
    expect(mount.container.ownerDocument.activeElement).toBe(entryFor(mount, BLOCKED))

    // A rebuild that leaves focus on the body is the one case the mirror cannot
    // cover, and the deep link's resolve after every applied state is what covers it.
    ;(mount.container.ownerDocument.body as HTMLElement).focus()
    mount.dashboard.deepLink.resolve()
    expect(mount.container.ownerDocument.activeElement).toBe(entryFor(mount, BLOCKED))

    // A developer who arrowed to another row keeps their own choice.
    mount.dashboard.navigator.focusSession(RUNNING)
    await mount.settle()
    mount.dashboard.deepLink.resolve()
    expect(mount.container.ownerDocument.activeElement).toBe(entryFor(mount, RUNNING))
  })

  it('says the session is gone rather than silently focusing nothing', async () => {
    const hub = createStubHub({ sessions: twoPending(), pending: [] })
    const mount = await mountLiveDashboard({
      hub,
      writeToken: 'token',
      search: `?${DEEP_LINK_QUERY_KEY}=session-that-ended`,
    })
    hub.ready()
    await mount.settle()

    // docs/features/live-dashboard.md §8, Open Question 3: an explicit row, not
    // silence. The page is a valid one - every other row is on it.
    expect(mount.dashboard.rows).toHaveLength(2)
    expect(deepLinkLine(mount)?.textContent).toBe(DEEP_LINK_SENTENCE.missing)
    expect(deepLinkLine(mount)?.getAttribute(DASHBOARD_DEEP_LINK_STATUS_ATTRIBUTE)).toBe('missing')
    expect(mount.dashboard.deepLink.state.status).toBe('missing')
    expect(mount.container.ownerDocument.activeElement).toBe(mount.container.ownerDocument.body)
  })

  it('ignores a link that named nothing, and never sends a target anywhere', async () => {
    const hub = createStubHub({ sessions: twoPending(), pending: [] })
    const mount = await mountLiveDashboard({ hub, writeToken: 'token', search: '?mirror=visible' })
    hub.ready()
    await mount.settle()

    expect(mount.dashboard.deepLink.state.status).toBe('none')
    expect(deepLinkLine(mount)?.textContent).toBe('')
    // The deep-link counter is the hub's: the target's value is never stored, logged
    // or sent (src/hub/metrics.ts), so the page has to behave the same way.
    expect(JSON.stringify(mount.hub.requests)).not.toContain('session-blocked')
  })

  it('treats a target longer than any row key as no link at all', async () => {
    // The bound is the page's, and its purpose is that an arbitrarily long string in
    // a URL is never copied out of it and compared (APX-CON-12). The hub stores a
    // UUID, so a value this long is not a session this page could hold.
    const huge = 'x'.repeat(DEEP_LINK_TARGET_MAX_LENGTH + 1)
    expect(readDeepLinkTarget(`?${DEEP_LINK_QUERY_KEY}=${huge}`)).toBeNull()
    expect(readDeepLinkTarget(`?${DEEP_LINK_QUERY_KEY}=${'x'.repeat(9)}`)).toBe('xxxxxxxxx')
    expect(readDeepLinkTarget(`?${DEEP_LINK_QUERY_KEY}=%20%20`)).toBeNull()

    const hub = createStubHub({ sessions: twoPending(), pending: [] })
    const mount = await mountLiveDashboard({
      hub,
      writeToken: 'token',
      search: `?${DEEP_LINK_QUERY_KEY}=${huge}`,
    })
    hub.ready()
    await mount.settle()

    // So the page renders normally and says nothing about a session it never named.
    expect(mount.dashboard.deepLink.state.status).toBe('none')
    expect(mount.dashboard.rows).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 4. No control sends, interrupts or approves; handoff is text
// ---------------------------------------------------------------------------

describe('LD-3 the page contains no agent-control control, and handoff is text', () => {
  /**
   * The vocabulary a control that could reach a harness would be named in.
   *
   * Matched against every control's accessible name and against every `data-`
   * attribute on the page, because a control's name is where a reader looks first and
   * its attributes are what an assertion and a screen reader both read.
   */
  const FORBIDDEN_ACTIONS = [
    'send',
    'interrupt',
    'approve',
    'reject',
    'prompt',
    'continue',
    'resume',
    'reply',
    'answer',
    'allow',
    'deny',
    'cancel',
    'steer',
    'skip',
    'stop the session',
    'attach and run',
  ] as const

  const isInteractive = (element: Element): boolean =>
    ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'FORM'].includes(element.tagName) ||
    element.hasAttribute('role')

  it('renders no control that could send, interrupt, prompt or approve anything', async () => {
    const hub = createStubHub({
      sessions: twoPending(),
      pending: ['event-b', 'event-a'],
      pendingItems: waitingItems(),
    })
    const mount = await mountWithPending({ hub })
    // Put the page in the state a developer would be in when they press something: a
    // focused row, a revealed command, a read history and a refusal on the screen.
    mount.dashboard.navigator.focusSession(BLOCKED)
    await mount.settle()
    hub.refuseAck({ status: 409, body: { error: 'conflict' } })
    await mount.dashboard.acknowledge(BLOCKED)
    await mount.settle()

    const doc = mount.container.ownerDocument
    const controls = [...doc.querySelectorAll('*')].filter(isInteractive)
    const named = controls.map((element) => ({
      tag: element.tagName,
      name:
        element.getAttribute('aria-label') ??
        element.getAttribute('title') ??
        element.textContent?.trim() ??
        '',
    }))

    for (const control of named) {
      for (const action of FORBIDDEN_ACTIONS) {
        expect(
          control.name.toLowerCase(),
          `a control named "${control.name}" reads as an agent action`,
        ).not.toContain(action)
      }
    }
    // Every role on the page is from a closed list, so a new region cannot introduce
    // one by being added to a markup file.
    const roles = new Set(
      [...doc.querySelectorAll('[role]')].map((element) => element.getAttribute('role')),
    )
    expect([...roles].sort()).toEqual(['alert', 'status'])

    // Nothing on the page can submit anything, navigate anywhere, or carry a handler.
    expect(doc.querySelectorAll('form')).toHaveLength(0)
    expect([...doc.querySelectorAll('a')]).toHaveLength(0)
    for (const element of doc.querySelectorAll('*')) {
      for (const attribute of element.getAttributeNames()) {
        if (attribute.toLowerCase().startsWith('on')) {
          throw new Error(`${element.tagName} carries the inline handler ${attribute}`)
        }
      }
    }

    // And across the whole interaction - two presses on the control, one refusal and
    // one acceptance - the only mutating requests are acknowledgements. There is no
    // third path out of this page, and no method other than GET and this POST.
    await mount.dashboard.acknowledge(BLOCKED)
    await mount.settle()
    const mutating = mount.hub.requests.filter((entry) => entry.method !== 'GET')
    expect(mutating).toHaveLength(2)
    expect([...new Set(mutating.map((entry) => `${entry.method} ${entry.url}`))]).toEqual([
      `POST http://127.0.0.1:43117/api/ack/event-b`,
    ])
    expect([...new Set(mount.hub.requests.map((entry) => entry.method))].sort()).toEqual([
      'GET',
      'POST',
    ])
  })

  it('reveals the attach command as selectable text for the row in hand', async () => {
    const hub = createStubHub({ sessions: twoPending(), pending: ['event-b', 'event-a'] })
    const mount = await mountWithPending({ hub })
    const command = mount.container.ownerDocument.querySelector<HTMLElement>(
      `[data-dashboard-handoff] [${HANDOFF_COMMAND_ATTRIBUTE}]`,
    )

    // Nothing is revealed before a row is in hand, and the panel says so.
    expect(command?.textContent).toBe('')
    expect(mount.dashboard.handoff.command).toBeNull()

    mount.dashboard.navigator.focusSession(BLOCKED)
    await mount.settle()

    expect(command?.tagName).toBe('CODE')
    expect(command?.textContent).toBe(HARNESS_ATTACH['opencode']!(BLOCKED))
    expect(mount.dashboard.handoff.command?.command).toBe('opencode attach session-blocked')
    expect(
      mount.container.ownerDocument
        .querySelector('[data-dashboard-handoff]')
        ?.getAttribute('data-handoff-session'),
    ).toBe(BLOCKED)
    // The command is text a person copies; the page says in words that it cannot run
    // it, and the sentence is there because "it is only text" is a claim about the
    // product that the page should be making out loud.
    expect(
      mount.container.ownerDocument
        .querySelector('[data-dashboard-handoff] [data-handoff-instruction]')
        ?.textContent,
    ).toContain('cannot run it')
  })

  it('says it has no attach command for a harness it does not know, rather than inventing one', () => {
    const command = handoffCommand({ harness: 'some-other-harness', sessionId: 'ses_1' })
    expect(command.command).toBeNull()
    expect(command.sentence).toContain('does not know an attach command for some-other-harness')
  })

  it('acknowledges on Enter as well, and both paths are the same write', async () => {
    const hub = createStubHub({
      sessions: twoPending(),
      pending: ['event-b', 'event-a'],
      pendingItems: waitingItems(),
    })
    const mount = await mountWithPending({ hub })
    const entry = entryFor(mount, BLOCKED)!
    entry.focus()
    await mount.settle()

    // The keyboard path. DP-4's activated mark is still painted, so activating a row
    // is observable whether or not it changed anything.
    entry.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await mount.settle()

    expect(mount.hub.ackRequests).toHaveLength(1)
    expect(mount.dashboard.activatedSessionId).toBe(BLOCKED)
    expect(metaCell(mount, BLOCKED)).toContain(ACTIVATED_MARKER)
    expect(headerText(mount)).toBe('1 pending')
  })
})

// ---------------------------------------------------------------------------
// 5. The history panel
// ---------------------------------------------------------------------------

describe('LD-3 the history panel renders five facts per event and no content', () => {
  const events = (): readonly Record<string, unknown>[] => [
    hubHistoryEvent({
      eventId: 'event-1',
      sessionId: BLOCKED,
      class: 'needs-you',
      occurredAt: '2026-09-27T11:57:00.000Z',
    }),
    hubHistoryEvent({
      eventId: 'event-2',
      sessionId: RUNNING,
      class: 'finished',
      occurredAt: '2026-09-27T11:30:00.000Z',
      ackState: 'acknowledged',
      resolutionState: 'resolved',
    }),
    // An information-only event: the class that must appear inside the dashboard and
    // nowhere else (LD-FR-11).
    hubHistoryEvent({
      eventId: 'event-3',
      sessionId: RUNNING,
      class: 'fyi',
      subtype: 'token-burn',
      occurredAt: '2026-09-27T10:00:00.000Z',
    }),
  ]

  /**
   * A payload that carries content on every field it can.
   *
   * This is the only honest way to assert that the panel cannot render conversation
   * content: the store has no such column, but "the store has no such column" is a
   * claim about another file, and a parser that spread its input would pass every
   * other assertion in this suite while putting a prompt on the page.
   */
  const hostile = (): readonly Record<string, unknown>[] =>
    events().map((event, index) => ({
      ...event,
      body: `CONTENT-BODY-${String(index)}`,
      content: `CONTENT-CONTENT-${String(index)}`,
      message: `CONTENT-MESSAGE-${String(index)}`,
      text: `CONTENT-TEXT-${String(index)}`,
      transcript: `CONTENT-TRANSCRIPT-${String(index)}`,
      prompt: `CONTENT-PROMPT-${String(index)}`,
      diff: `CONTENT-DIFF-${String(index)}`,
    }))

  const historyEntries = (mount: LiveMount): readonly HTMLElement[] => [
    ...mount.container.ownerDocument.querySelectorAll<HTMLElement>(`[${HISTORY_ENTRY_ATTRIBUTE}]`),
  ]

  it('renders class, repository, session, timestamp and state for every event', async () => {
    const hub = createStubHub({
      sessions: twoPending(),
      pending: ['event-b', 'event-a'],
      pendingItems: waitingItems(),
      events: events(),
    })
    const mount = await mountWithPending({ hub })

    // The panel is a panel, not a page: it is in the document, below the rows, and it
    // does not move the developer away from the list.
    const panel = mount.container.ownerDocument.querySelector(
      '[data-dashboard-history]',
    )
    expect(panel).not.toBeNull()
    expect(panel?.parentElement).toBe(mount.container.parentElement)
    expect(panel?.id).toBe(DASHBOARD_HISTORY_PANEL_ID)

    // And it is not inside the surface the canvas is sized from. `measureContainer`
    // reads the container's own box, so a panel inside it would make the rows taller
    // than the rows need to be. jsdom applies no layout, so what this can assert is
    // the placement the arithmetic depends on rather than the size it produces - the
    // size itself is a browser measurement, and LD-4's journey is where it is taken.
    expect([...mount.container.children].map((child) => child.tagName)).toEqual(['CANVAS', 'UL'])

    const entries = historyEntries(mount)
    expect(entries.map((entry) => entry.getAttribute(HISTORY_ENTRY_ATTRIBUTE))).toEqual([
      'event-1',
      'event-2',
      'event-3',
    ])

    // The five facts, each in its own element with its own attribute, in reading
    // order. The repository is joined from the session rows the page holds, by
    // session identity - the event record does not carry one (APX-CON-09).
    const fields = (entry: HTMLElement): Record<string, string> =>
      Object.fromEntries(
        [...entry.children].map((child) => [
          child.getAttributeNames().find((name) => name.startsWith('data-history-')) ?? 'unknown',
          child.textContent ?? '',
        ]),
      )
    expect(fields(entries[0]!)).toEqual({
      [HISTORY_CLASS_ATTRIBUTE]: 'Needs you',
      [HISTORY_REPOSITORY_ATTRIBUTE]: 'agent-ping',
      [HISTORY_SESSION_ATTRIBUTE]: BLOCKED,
      [HISTORY_TIMESTAMP_ATTRIBUTE]: '3m ago',
      [HISTORY_ACK_ATTRIBUTE]: 'Unacknowledged',
      [HISTORY_RESOLUTION_ATTRIBUTE]: 'Unresolved',
    })
    expect(fields(entries[1]!)).toEqual({
      [HISTORY_CLASS_ATTRIBUTE]: 'Finished',
      [HISTORY_REPOSITORY_ATTRIBUTE]: 'agent-ping',
      [HISTORY_SESSION_ATTRIBUTE]: RUNNING,
      [HISTORY_TIMESTAMP_ATTRIBUTE]: '30m ago',
      [HISTORY_ACK_ATTRIBUTE]: 'Acknowledged',
      [HISTORY_RESOLUTION_ATTRIBUTE]: 'Resolved',
    })
    // `fyi` reads in the product's own words - the same word LD-FR-02's fourth row
    // condition uses - rather than as a storage token.
    expect(fields(entries[2]!)).toMatchObject({
      [HISTORY_CLASS_ATTRIBUTE]: 'Information only',
      [HISTORY_ACK_ATTRIBUTE]: 'Unacknowledged',
    })
    // The exact instant is on the element for a machine, and the age is what is read.
    expect(entries[0]?.getAttribute('datetime')).toBe('2026-09-27T11:57:00.000Z')
  })

  it('drops every field it does not name, so a payload with content cannot reach the page', async () => {
    const hub = createStubHub({
      sessions: twoPending(),
      pending: ['event-b', 'event-a'],
      pendingItems: waitingItems(),
      events: hostile(),
    })
    const mount = await mountWithPending({ hub })

    // The model is exactly six fields, named. A `body`, a `content`, a `message`, a
    // `text`, a `transcript`, a `prompt` and a `diff` are all read past.
    const entry = parseHistoryEntry(hostile()[0])
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      'ackState',
      'class',
      'eventId',
      'occurredAt',
      'resolutionState',
      'sessionId',
    ])

    // And nothing a hostile payload carried appears anywhere in the document, as text
    // or as an attribute value.
    const doc = mount.container.ownerDocument
    const everything = `${doc.body.textContent ?? ''} ${doc.body.innerHTML}`
    for (let index = 0; index < 3; index += 1) {
      for (const field of ['BODY', 'CONTENT', 'MESSAGE', 'TEXT', 'TRANSCRIPT', 'PROMPT', 'DIFF']) {
        expect(everything).not.toContain(`CONTENT-${field}-${String(index)}`)
      }
    }
    // The panel's own row carries only the six fields it is allowed to.
    const attributes = new Set(
      [...doc.querySelectorAll('[data-history-entry]')].flatMap((row) =>
        [...row.querySelectorAll('*')].flatMap((child) =>
          child.getAttributeNames().filter((name) => name.startsWith('data-history-')),
        ),
      ),
    )
    expect([...attributes].sort()).toEqual([
      HISTORY_ACK_ATTRIBUTE,
      HISTORY_CLASS_ATTRIBUTE,
      HISTORY_REPOSITORY_ATTRIBUTE,
      HISTORY_RESOLUTION_ATTRIBUTE,
      HISTORY_SESSION_ATTRIBUTE,
      HISTORY_TIMESTAMP_ATTRIBUTE,
    ])
  })

  it('shows an unreadable history as an empty panel that says so', async () => {
    const hub = createStubHub({ sessions: twoPending(), pending: [] })
    const mount = await mountWithPending({ hub })
    hub.failNextHistoryRead()
    hub.change({
      cursor: 3,
      kind: 'event-stored',
      session: hubSession({
        sessionId: 'session-later',
        repoShortName: 'knowledge-dungeon',
        state: 'finished',
        pendingCount: 0,
        lastSeenAt: '2026-09-27T12:00:00.000Z',
      }),
      pendingCount: 0,
    })
    await mount.settle()

    expect(historyEntries(mount)).toHaveLength(0)
    expect(visibleText(mount)).toContain(HISTORY_UNREADABLE_SENTENCE)
    // The last good list is not left on screen as though it were current.
    expect(mount.dashboard.history.status).toBe('unreadable')
  })

  it('reads the bounded history from the page\'s own origin, on GET, and can be closed', async () => {
    const hub = createStubHub({ sessions: twoPending(), pending: [], events: events() })
    const mount = await mountWithPending({ hub })
    await mount.settle()

    expect(mount.dashboard.history.status).toBe('idle')
    expect(mount.dashboard.isHistoryOpen).toBe(true)

    const toggle = mount.container.ownerDocument.querySelector<HTMLButtonElement>(
      `[${DASHBOARD_HISTORY_TOGGLE_ATTRIBUTE}]`,
    )
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(toggle?.getAttribute('aria-controls')).toBe(DASHBOARD_HISTORY_PANEL_ID)
    toggle?.click()
    expect(mount.dashboard.isHistoryOpen).toBe(false)
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(mount.dashboard.history.root.hidden).toBe(true)
    toggle?.click()
    expect(mount.dashboard.isHistoryOpen).toBe(true)

    // The read is a GET of the bounded route, from the origin the page was served
    // from, and never asks for more than the route's own default.
    const historyReads = mount.hub.requests.filter((entry) => entry.url.includes('/api/events'))
    expect(historyReads.length).toBeGreaterThan(0)
    for (const read of historyReads) {
      expect(read.method).toBe('GET')
      expect(read.url).toBe(
        `http://127.0.0.1:43117/api/events?limit=${String(HISTORY_PAGE_SIZE)}`,
      )
    }
  })

  it('shows an information-only event in the panel and never as a badge or a card', async () => {
    const hub = createStubHub({
      sessions: twoPending(),
      pending: ['event-b', 'event-a'],
      pendingItems: waitingItems(),
      events: events(),
    })
    const mount = await mountWithPending({ hub })
    const doc = mount.container.ownerDocument

    // It is in the dashboard, in the panel, in the product's words.
    const fyi = historyEntries(mount).find(
      (entry) => entry.getAttribute(HISTORY_ENTRY_ATTRIBUTE) === 'event-3',
    )
    expect(fyi?.querySelector(`[${HISTORY_CLASS_ATTRIBUTE}]`)?.textContent).toBe(
      'Information only',
    )
    // And the count is the hub's: an fyi does not move it, because nothing about an
    // fyi is waiting on the developer (LD-FR-04, LD-FR-11).
    expect(headerText(mount)).toBe('2 pending')
    // Nothing on this page is a card, a toast or a badge, and no region claims to be
    // one: the only live regions are the connection state and the refusals.
    expect(doc.querySelectorAll('form, [data-toast], [data-card]')).toHaveLength(0)
    expect([...doc.querySelectorAll('[class]')].map((element) => element.className)).not.toContain(
      expect.stringContaining('toast'),
    )
  })
})

// ---------------------------------------------------------------------------
// The contracts this page restates rather than imports
// ---------------------------------------------------------------------------

describe('LD-3 the page and the hub agree on the three literals this page states', () => {
  const source = (relative: string): string =>
    readFileSync(path.join(repositoryRoot, relative), 'utf8')

  it('uses the hub\'s deep-link key', () => {
    // Read from the hub's own source rather than imported: src/hub/metrics.ts reaches
    // Node built-ins through the store, and importing a hub module into a
    // browser-shaped suite is exactly what the browser bundle must not do. The page's
    // constant is declared in ./live/deeplink.ts for the same reason.
    expect(source('src/hub/metrics.ts')).toContain(
      `export const DEEP_LINK_QUERY_KEY = '${DEEP_LINK_QUERY_KEY}'`,
    )
    expect(source('src/notify/surface/card.ts')).toContain(`?session=`)
  })

  it('uses the header the write token travels in', () => {
    expect(source('src/hub/security.ts')).toContain(
      `export const WRITE_TOKEN_HEADER = '${WRITE_TOKEN_HEADER}'`,
    )
    // And the ack route is the only path this page may post to.
    expect(source('src/hub/routes/ack.ts')).toContain("pattern: '/api/ack/:eventId'")
  })

  it('asks the history route for the page size the route serves by default', () => {
    expect(source('src/storage/eventStore.ts')).toContain(
      `export const HISTORY_DEFAULT_LIMIT = ${String(HISTORY_PAGE_SIZE)}`,
    )
  })

  it('keeps a style rule for every region it renders, and inlines no style', async () => {
    // A real browser under the hub's `style-src 'self'` refuses an inline `<style>`
    // element and an attribute-set style, and the page is loaded in an application
    // window and over loopback from the same build (LD-FR-10). So the regions LD-3
    // added are styled in the page's linked sheet and nowhere else.
    const css = source('src/dashboard/dashboard.css')
    for (const selector of [
      '[data-dashboard-ack]',
      '[data-dashboard-ack-hint]',
      '[data-dashboard-refusals]',
      '[data-dashboard-deep-link]',
      '[data-dashboard-history-toggle]',
      '[data-dashboard-handoff]',
      '[data-dashboard-history]',
    ]) {
      expect(css, `${selector} is unstyled`).toContain(selector)
    }
    const mount = await mountWithPending()
    expect(mount.container.querySelectorAll('style')).toHaveLength(0)
    for (const element of mount.container.ownerDocument.querySelectorAll('*')) {
      expect(element.getAttribute('style')).toBeNull()
    }
  })

  it('leaves no subscription and no panel behind on teardown', async () => {
    const hub = createStubHub({
      sessions: twoPending(),
      pending: ['event-b', 'event-a'],
      pendingItems: waitingItems(),
      events: [
        hubHistoryEvent({ eventId: 'event-1', sessionId: BLOCKED, class: 'needs-you' }),
      ],
    })
    const mount = await mountWithPending({ hub })
    const doc = mount.container.ownerDocument
    expect(doc.querySelector('[data-dashboard-handoff]')).not.toBeNull()
    expect(doc.querySelector('[data-dashboard-history]')).not.toBeNull()
    expect(mount.dashboard.activeSubscriptions).toBeGreaterThan(0)

    mount.dashboard.destroy()

    expect(mount.dashboard.activeSubscriptions).toBe(0)
    expect(mount.dashboard.isDestroyed).toBe(true)
    expect(mount.dashboard.ack.isClosed).toBe(true)
    expect(mount.dashboard.handoff.isDestroyed).toBe(true)
    expect(mount.dashboard.history.isDestroyed).toBe(true)
    expect(mount.dashboard.deepLink.isDestroyed).toBe(true)
    expect(mount.dashboard.client.isClosed).toBe(true)
    expect(doc.querySelector('[data-dashboard-handoff]')).toBeNull()
    expect(doc.querySelector('[data-dashboard-history]')).toBeNull()
  })
})
