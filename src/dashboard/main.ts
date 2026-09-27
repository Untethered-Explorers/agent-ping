// The live dashboard's one mount entry point, and the page the hub serves
// (LD-FR-01, LD-FR-03, LD-FR-04, LD-FR-05, LD-FR-06, LD-FR-07, LD-FR-08,
// LD-FR-10, LD-FR-11).
//
// WHAT THIS IS
// One exported mount, `mountDashboard`, and the composition root that calls it when
// this module is loaded as the page's entry script. Everything the live page shows
// hangs off it: the page header (pending count and connection state), the PixiJS
// canvas of repository groups and session rows, the visually hidden DOM mirror
// that makes every painted row reachable by keyboard and legible to a screen reader
// (APX-CON-07), and the four interactions LD-3 added: the one acknowledgement
// control, the deep-link target, the handoff command and the history panel. All of
// them are built from one row model, in one order, so a row cannot exist on the
// canvas and not in the mirror.
//
// THE PAGE HEADER IS DOM, AND THAT IS THE POINT
// The pending count and the connection state are real text in the accessibility
// tree, not words painted into a canvas. The design puts the count next to the
// connection state so a disconnected page cannot be mistaken for a quiet one, and
// the two facts a developer must never be wrong about are therefore the two things
// this page does not hide in a picture. `stale` and `disconnected` are printed as
// words, and the count is qualified as "last known" whenever the page cannot claim
// it is current - a page showing old rows next to a confident `0 pending` reads as
// "nothing needs me", which is the one answer this surface must never give.
//
// The header is where the fourth of those facts lives too: the acknowledgement
// control, the refusal region and the deep-link sentence. A refused write is not
// console output, and a row's own state cannot be the only place the developer would
// have to look for it.
//
// THE LAYOUT IS THE APPROVED ONE
// `buildLivePlan` lays the hub's sessions out with `layoutGroups`, the function
// the prototype's own plan comes out of, and the painter is the prototype's painter.
// The page adds exactly three marks to that plan - the focused row's band and rail,
// the word in an activated row's meta cell, and the word in a refused row's meta
// cell - and all three go into the row's existing meta cell or band, so no row,
// group or density changed to accommodate them.
//
// WHERE THE FOCUSED ROW SURVIVES AN UPDATE
// Focus and the activated row are held as session identifiers and re-laid into
// every new plan, never as indexes: a live update under the focused row re-renders
// the plan, and an index into a list that just re-sorted is a different row. The
// keyboard model's own callbacks write those two identifiers, and the mirror
// restores DOM focus by identity while it rebuilds, so the two agree about which
// row is focused even when the rows above it have moved. The deep link adds the one
// case the mirror cannot see - a rebuild that left focus nowhere - and asserts it
// after every applied state.
//
// THE ONE THING A SCROLLING PAGE ADDS
// The prototype's three rows always fit, so a focused row was always on screen. The
// live page grows its canvas to the rows and the page scrolls them, and the
// focusable twin of a row is a one-pixel clipped box - so when the keyboard focuses
// a row, nothing scrolls. Focus therefore asks the page to bring that row into view
// (`revealRow`), from the geometry the plan already knows, with the scroll's own
// smoothness governed by the same motion policy as everything else that moves.
//
// THE MIRROR IS BUILT FROM THE PLAN, PLUS ONE FACT
// `liveMirrorModel` derives the mirror's model from the plan - the canvas order,
// one entry per row, the grouping - and joins the pending count from the state by
// session identity. The count is not a fifth thing on the canvas: it is already in
// the row's status line, and putting it in the mirror's accessible name as well
// would make a screen reader say the same number twice. What the mirror adds is the
// machine-readable half (`data-mirror-pending`), which is what an assertion reads
// and what an acknowledgement reads.
//
// ONE WRITE, AND WHERE ITS TOKEN COMES FROM
// Acknowledgement is the only request this page makes that changes anything
// (APX-CON-08). It is a POST to the ack route with no body and one header, and the
// controller in ./live/ack.ts is the only thing in this page that can perform it.
// The write token is an *input*: `mountDashboard({ writeToken })` or a
// `<meta name="agent-ping-write-token">` element in the served document. HC-4 put
// that token in no response and no served asset on purpose (src/hub/security.ts), so
// the page does not pretend to have one: with no token the control is disabled and
// says exactly why, and pressing it still records a refusal. See ./live/ack.ts for
// the full statement of that gap and whose decision it is.
//
// NO CONTROL SENDS, INTERRUPTS OR APPROVES ANYTHING (LD-FR-07, APX-CON-08)
// Everything this page can do to a session is: mark one pending item acknowledged,
// show a command as text, and show what happened. The handoff is a `<code>`
// element, the history is a read, and there is no `<form>`, no `<button>` bound to a
// harness and no handler that reaches outside the document. tests/dashboard/
// live-interactions.test.ts walks every rendered control and asserts it.
//
// THE INSPECTION FLAG DP-4 ASKED FOR
// `?mirror=visible` sets `data-mirror-inspect="on"` on the document element, which
// the page's own stylesheet keys on to un-clip the DOM mirror and to draw the
// mirror's focus and activation classes. The mirror is otherwise invisible, so a
// reviewer otherwise has to reconstruct a console query to verify the accessible
// twin - which is what the DP-4 review had to do. Nothing about the flag changes
// the page for a developer who does not ask for it.
//
// TEARDOWN
// One bag, one `destroy()`, and the same steps the prototype takes: drop the
// subscriptions, stop the render loop, destroy the renderer with its textures. The
// stream client is closed before the bag is emptied, because its reconnect timer is
// the one thing here that would otherwise keep opening connections after the page
// went away. The four LD-3 controllers add their own teardown hooks, so an
// acknowledgement in flight, a revealed command and a rendered history panel all go
// with the page.

import { createDomMirror, type DomMirror, type MirrorModel } from './a11y/dom-mirror'
import { createKeyboardNavigator, type KeyboardNavigator } from './a11y/keyboard-nav'
import {
  createMotionController,
  type MotionController,
  type MotionControllerOptions,
} from './theme/motion'
import {
  DASHBOARD_ROOT_ATTRIBUTE,
  SubscriptionBag,
  createPixiDashboardHost,
  measureContainer,
  type DashboardHost,
  type Size,
} from './host'
import type { Container } from 'pixi.js'
import type { HoverRegion, RenderedRow, ScenePlan, SceneTarget, SceneTargetOptions } from './prototype/scene'
import { createPixiSceneTarget, paintScene } from './prototype/scene'
import type { LiveDisplayState } from './live/session-list'
import { buildLivePlan } from './live/session-list'
import {
  INITIAL_LIVE_STATE,
  createStreamClient,
  type ConnectionState,
  type CreateStreamClientOptions,
  type HubSession,
  type LiveState,
  type StreamClient,
} from './live/stream-client'
import {
  ACK_TOKEN_META_NAME,
  createAckController,
  createFetchAckTransport,
  createFetchPendingReader,
  refusedAckResult,
  type AckController,
  type AckErrorCode,
  type AckResult,
  type FetchLike,
} from './live/ack'
import {
  INITIAL_DEEP_LINK_STATE,
  createDeepLinkController,
  type DeepLinkController,
  type DeepLinkState,
} from './live/deeplink'
import { createHandoffPanel, type HandoffPanel, type HandoffTemplate } from './live/handoff'
import {
  UNKNOWN_REPOSITORY,
  createFetchHistoryReader,
  createHistoryPanel,
  type HistoryPanel,
} from './live/history'

// ---------------------------------------------------------------------------
// The page header's contract
// ---------------------------------------------------------------------------

/** The header element the pending count and the connection state live in. */
export const DASHBOARD_HEADER_ATTRIBUTE = 'data-dashboard-header'
/** The element carrying the pending count. */
export const DASHBOARD_PENDING_ATTRIBUTE = 'data-dashboard-pending'
/**
 * The connection state, as an attribute on the header itself and as text in the
 * element below it. The attribute is the machine-readable half and the text is the
 * half a developer reads; a test that only read the attribute would prove the page
 * knows a state, not that it says one.
 */
export const DASHBOARD_CONNECTION_ATTRIBUTE = 'data-dashboard-connection'
export const DASHBOARD_CONNECTION_TEXT_ATTRIBUTE = 'data-dashboard-connection-text'
/**
 * The one acknowledgement control (LD-FR-05, APX-CON-08).
 *
 * A single control rather than one per row, and it acts on the row the developer is
 * on - named in the button's own label, so nobody can acknowledge a row they did not
 * mean. A page with forty acknowledge buttons is a page with forty ways to change a
 * record by accident, and the row-level path is the same control: Enter on a focused
 * row activates it, and activating a row that is waiting on something acknowledges
 * it.
 */
export const DASHBOARD_ACK_ATTRIBUTE = 'data-dashboard-ack'
/** Why the control is or is not available, as a sentence a person can read. */
export const DASHBOARD_ACK_HINT_ATTRIBUTE = 'data-dashboard-ack-hint'
/** The refusals region. A live region, because a refused write is the answer to an action. */
export const DASHBOARD_REFUSALS_ATTRIBUTE = 'data-dashboard-refusals'
/** One refusal, with the code it was refused under. */
export const DASHBOARD_REFUSAL_ATTRIBUTE = 'data-dashboard-refusal'
/** Which session a refusal was about, so an assertion and a screen reader can find the row. */
export const DASHBOARD_REFUSAL_SESSION_ATTRIBUTE = 'data-dashboard-refusal-session'
/** The refused row's DOM twin, marked from outside the mirror so its own rendering is untouched. */
export const DASHBOARD_ROW_REFUSAL_ATTRIBUTE = 'data-dashboard-row-refusal'
/** What a deep link is doing, in words, when it has something to say. */
export const DASHBOARD_DEEP_LINK_ATTRIBUTE = 'data-dashboard-deep-link'
/** The deep link's state, for an assertion and for anyone reading the element. */
export const DASHBOARD_DEEP_LINK_STATUS_ATTRIBUTE = 'data-dashboard-deep-link-status'
/** The header's control that shows and hides the history panel. */
export const DASHBOARD_HISTORY_TOGGLE_ATTRIBUTE = 'data-dashboard-history-toggle'
/** The panel's id, so the toggle can point at it with `aria-controls`. */
export const DASHBOARD_HISTORY_PANEL_ID = 'dashboard-history'
/**
 * How many refusals the page keeps on screen at once.
 *
 * Bounded because a developer who clicks a row repeatedly must not be able to grow
 * the header without limit, and because the newest refusal is the one they are
 * looking at. The full list is on `dashboard.refusals` for anything that needs it.
 */
export const REFUSAL_VISIBLE_LIMIT = 5
/** Set on the document element by the mirror inspection flag. */
export const MIRROR_INSPECT_ATTRIBUTE = 'data-mirror-inspect'
/** The query parameter that turns the mirror on. `?mirror=visible` */
export const MIRROR_INSPECT_PARAMETER = 'mirror'
export const MIRROR_INSPECT_VALUE = 'visible'

/**
 * The connection state as words, one per state.
 *
 * Words, not a dot and a hue: the state is the one thing on this page a developer
 * must be able to read without seeing colour at all, and `stale` and `disconnected`
 * both say plainly that the rows below them are the last the hub sent.
 */
export const CONNECTION_TEXT: Readonly<Record<ConnectionState, string>> = Object.freeze({
  connecting: 'Connecting to the hub',
  live: 'Live',
  stale: 'Stale: the hub stopped sending. The rows below are the last it sent.',
  disconnected: 'Disconnected: the hub is not answering. The rows below are the last it sent.',
})

/**
 * The header's connection line: the state, and the cause when there is one.
 *
 * The cause is part of the sentence rather than a separate field because a state
 * without its cause is the thing this page must not show: "Stale" on its own is a
 * fact the developer has to interpret, and a sentence that says the rows are the
 * last it sent is one they can act on.
 */
export function connectionText(state: LiveState): string {
  const base = CONNECTION_TEXT[state.connection]
  const problem = state.problem
  if (problem === null) return base
  const clause =
    problem.kind === 'refresh-required'
      ? `Re-reading the hub: this page was too far behind (${problem.reason})`
      : problem.kind === 'unreadable'
        ? 'The hub could not be read'
        : problem.kind === 'gave-up'
          ? 'Not retrying'
          : null
  if (clause === null) return base
  // One sentence per clause, joined without doubling the full stop: a header that
  // reads "it sent.. Not retrying" is a header nobody finishes reading.
  return `${base.replace(/\.$/, '')}. ${clause}`
}

/**
 * The header's pending line.
 *
 * The number is the hub's own unacknowledged count, which is the number the tray
 * badge draws for the same state (LD-FR-04), and it is never computed here. Two
 * qualifications are added rather than a bare number, because a bare number on a
 * page that is not current is a lie with a confident look:
 *
 *   - Nothing has been read yet, so there is no count to show and the page says so.
 *   - The connection is anything other than `live`, so the number is the last known
 *     one and says so. Every state that is not `live` qualifies, including a
 *     connection that is still being established.
 *
 * `serverPendingCount` is the one thing that may replace the client's own figure, and
 * only for the window between an acknowledgement's answer and the hub's next frame.
 * It is the hub's number in either case - read out of the write's own 200 body - and
 * it is dropped the moment the client's state moves.
 */
export function pendingText(state: LiveState, serverPendingCount: number | null = null): string {
  if (state.updatedAt === null) return 'pending count not read yet'
  const count = serverPendingCount ?? state.pendingCount
  const base = `${String(count)} pending`
  return state.connection === 'live' ? base : `${base} (last known)`
}

// ---------------------------------------------------------------------------
// The write token, and the refusal
// ---------------------------------------------------------------------------

/**
 * The token this page presents, or null when it has none.
 *
 * Three inputs in one function, in the order a real page meets them: an explicit
 * mount option (a test, or an application window that was handed one), then the
 * served document's `<meta name="agent-ping-write-token">` element if there is one,
 * then nothing.
 *
 * There is no fourth input. This product deliberately keeps the token out of every
 * response, every served asset and every log line (src/hub/security.ts, HC-FR-06),
 * so a page that reached for it anywhere else would be a page that had found a hole
 * in that boundary, and this file does not get to be the place that finds it. What
 * the hub serves, or whether it decides the dashboard's own same-origin request may
 * write without one, is a boundary decision and belongs to hub-engineer; this
 * function is what lets their answer land without a change here.
 */
export function readWriteToken(doc: Document, given?: string | null): string | null {
  if (given !== undefined) return given
  const meta = doc.querySelector(`meta[name="${ACK_TOKEN_META_NAME}"]`)
  const content = meta?.getAttribute('content')?.trim()
  return content !== undefined && content.length > 0 ? content : null
}

/** One refused acknowledgement, as the page records it and shows it. */
export interface AckRefusalRecord {
  readonly sessionId: string
  /** The repository short name, which is how a row is identified (APX-CON-09). */
  readonly repositoryShortName: string
  readonly code: AckErrorCode
  readonly status: number | null
  /** The fixed sentence for the code. What the page prints. */
  readonly sentence: string
  /** The page's clock, never the hub's. */
  readonly at: string
}

// ---------------------------------------------------------------------------
// Ages
// ---------------------------------------------------------------------------

/**
 * How often the rows' ages are re-derived.
 *
 * Real data means a real clock, and an age that froze when the page opened would be
 * wrong within a minute on the one surface whose whole job is telling a developer
 * how long something has been waiting. A recursive timeout rather than an interval,
 * so it is one bag entry and teardown cancels one handle.
 */
export const LIVE_AGE_TICK_MS = 60_000

// ---------------------------------------------------------------------------
// Bringing a focused row into view
// ---------------------------------------------------------------------------

/**
 * One row's position on the surface, which is all a scroll needs to know.
 *
 * The row's own `y`, not a pixel offset from the document: the caller has the
 * geometry and the browser has the scroll, and this is the seam between them.
 */
export interface RevealedRow {
  readonly sessionId: string
  /** The row's top edge, in the canvas's own coordinates. */
  readonly y: number
  readonly height: number
}

/** Asked to bring one row into view when the keyboard focuses it. */
export type ScrollRowIntoView = (row: RevealedRow) => void

/**
 * How much of the page is kept above and below the revealed row.
 *
 * One row's worth, so the rows around the focused one stay on screen: a focus band
 * alone at the very top edge of the viewport says which row has focus and nothing
 * about where it is.
 */
export const REVEAL_MARGIN_PX = 44

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/** The page's own timers, for the age tick. Injected so a test drives no clock. */
export interface MountTimers {
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const defaultMountTimers: MountTimers = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  },
}

export interface MountDashboardOptions {
  readonly container: HTMLElement
  /** Defaults to `[data-dashboard-header]` in the document, or one created here. */
  readonly header?: HTMLElement
  /**
   * The origin to read from. Defaults to the page's own origin, which is the hub's
   * own origin because the hub serves the page (LD-FR-10). Never anything else.
   */
  readonly origin?: string
  /** The clock ages are measured against. Defaults to the wall clock. */
  readonly now?: () => string
  /** Defaults to the real PixiJS 8 host. */
  readonly createHost?: (options: { container: HTMLElement; size: Size }) => Promise<DashboardHost>
  /** Defaults to the approved painter. */
  readonly createTarget?: (root: Container, options: SceneTargetOptions) => SceneTarget
  /** Defaults to the real motion policy. */
  readonly createMotionController?: (options: MotionControllerOptions) => MotionController
  /** Defaults to the real DOM mirror, without the sheet this policy refuses. */
  readonly createMirror?: (options: { parent: HTMLElement; injectStyleSheet: boolean }) => DomMirror
  /** Defaults to the real keyboard controller over the mirror. */
  readonly createNavigator?: (options: {
    container: HTMLElement
    motion: MotionController
    onActivate: (sessionId: string) => void
    onFocusRow: (sessionId: string) => void
    onBlurRow: (sessionId: string, relatedTarget: Element | null) => void
  }) => KeyboardNavigator
  /** Defaults to the real stream client over the page's own origin. */
  readonly createClient?: (options: CreateStreamClientOptions) => StreamClient
  /**
   * Brings the focused row into view. Defaults to the real scroll.
   *
   * The prototype's three rows always fit, so it never needed this. The live page
   * grows its canvas to the rows and the page scrolls them, and the focusable twin
   * of a row is a one-pixel clipped element: a keyboard user arrowing down a long
   * list would watch the painted focus band walk off the bottom of the window with
   * no scroll to follow, because nothing they focused is anywhere near where they
   * are looking. Injected so a headless test can assert what was asked for without
   * a viewport to scroll.
   */
  readonly scrollRowIntoView?: ScrollRowIntoView
  /** Where the inspection flag is read from. Defaults to the page's location. */
  readonly search?: string
  /** Defaults to the page's own timers. */
  readonly timers?: MountTimers
  // -------------------------------------------------------------------------
  // LD-3's inputs
  // -------------------------------------------------------------------------
  /**
   * The per-install write token the ack route requires.
   *
   * `undefined` means "read the served document", and `null` means "this page has
   * none", which is the state a dashboard served as a static file is in today
   * (src/hub/security.ts). Either way the page says so out loud rather than
   * presenting a control it cannot use. See `readWriteToken`.
   */
  readonly writeToken?: string | null
  /**
   * The `fetch` every request this page makes goes through.
   *
   * One seam for all three routes - the ack write, the pending read and the bounded
   * history read - so a test drives the *shipped* requests rather than substituting
   * them: the URL, the method, the one header and the absent body are the product's
   * own, and a stub only answers them. Defaults to the page's own `fetch`.
   */
  readonly fetchImpl?: FetchLike
  /** Replaces the built-in attach-command table. See `HandoffTemplate`. */
  readonly attachCommands?: Readonly<Record<string, HandoffTemplate>>
  /** Whether the history panel starts open. Defaults to true: a panel, not a page. */
  readonly historyOpen?: boolean
}

export interface LiveDashboard {
  readonly host: DashboardHost
  /** The visually hidden, focusable twin of every painted row (APX-CON-07). */
  readonly mirror: DomMirror
  /** Keyboard traversal and activation over the mirror. */
  readonly navigator: KeyboardNavigator
  readonly motion: MotionController
  readonly client: StreamClient
  /** The one write this page can perform, and the refusal it records when it cannot (LD-FR-05). */
  readonly ack: AckController
  /** The attach command for the row in hand, as text (LD-FR-07). */
  readonly handoff: HandoffPanel
  /** Past events, as a panel below the rows (LD-FR-08). */
  readonly history: HistoryPanel
  /** What the page did with the `?session=` the link carried (LD-FR-06). */
  readonly deepLink: DeepLinkController
  /** Every refused acknowledgement, oldest first. The header shows the last few. */
  readonly refusals: readonly AckRefusalRecord[]
  /** Whether this page holds the token the ack route needs. */
  readonly writeTokenAvailable: boolean
  /** The hub's state as this page holds it. */
  readonly state: LiveState
  /** The current plan. `rows` is canvas order, which is the mirror's order too. */
  readonly plan: ScenePlan<LiveDisplayState>
  readonly rows: readonly RenderedRow<LiveDisplayState>[]
  /** The header the page prints into: count, connection state, and the one ack control. */
  readonly header: HTMLElement
  /** The row the keyboard has focused, by identity rather than by index. */
  readonly focusedSessionId: string | null
  /** The row the keyboard last activated. */
  readonly activatedSessionId: string | null
  /** How many teardown hooks are still registered. Zero once destroyed. */
  readonly activeSubscriptions: number
  readonly isDestroyed: boolean
  /** Reveal one repository's full path, or `null` for none. Pointer and focus both call this. */
  setHoveredRepository(repositoryId: string | null): void
  /**
   * Bring a row into view, as focusing one does. Exposed because the deep link
   * resolves to a row and the page must land on it, not merely paint it.
   */
  revealRow(sessionId: string): void
  /**
   * Acknowledge one row, defaulting to the focused one. The only write this page
   * performs; resolves with what the hub answered, and never rejects.
   */
  acknowledge(sessionId?: string): Promise<AckResult>
  /** Show or hide the history panel, and say which through the header's control. */
  setHistoryOpen(open: boolean): void
  readonly isHistoryOpen: boolean
  /** Re-read the container size and re-lay out. */
  remeasure(): void
  destroy(): void
}

/**
 * The page's own chrome, found or created: the header's two facts and the controls
 * LD-3 added.
 *
 * Everything is created rather than required, for the reason the two header elements
 * are: a test mounts the entry point against a bare container, and a page whose
 * interactions only exist when the HTML remembered to declare them would be a page
 * whose controls appear and disappear with the markup. Created here, owned by this
 * module, and removed by the same teardown as everything else.
 */
interface PageChrome {
  readonly header: HTMLElement
  readonly pending: HTMLElement
  readonly connection: HTMLElement
  readonly ack: HTMLButtonElement
  readonly ackHint: HTMLElement
  readonly refusals: HTMLElement
  readonly deepLink: HTMLElement
  readonly historyToggle: HTMLButtonElement
}

function resolveChrome(options: MountDashboardOptions, container: HTMLElement): PageChrome {
  const doc = container.ownerDocument
  const given = options.header ?? doc.querySelector<HTMLElement>(`[${DASHBOARD_HEADER_ATTRIBUTE}]`)
  const header = given ?? doc.createElement('header')
  if (given === null) {
    header.setAttribute(DASHBOARD_HEADER_ATTRIBUTE, '')
    // Above the rows it counts, so the count and the rows it counts read as one
    // thing rather than as a number stuck to the bottom of a scroll area.
    if (container.parentNode !== null) container.parentNode.insertBefore(header, container)
    else container.append(header)
  }

  const child = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attribute: string,
  ): HTMLElementTagNameMap[K] => {
    const existing = header.querySelector<HTMLElementTagNameMap[K]>(`[${attribute}]`)
    if (existing !== null) return existing
    const element = doc.createElement(tag)
    element.setAttribute(attribute, '')
    header.append(element)
    return element
  }

  const pending = child('span', DASHBOARD_PENDING_ATTRIBUTE)
  // The connection state is a live region: a page that silently stops updating is
  // the failure this page exists to prevent, and a live region is the only channel
  // that reaches someone who is not looking at the header.
  const connection = child('span', DASHBOARD_CONNECTION_TEXT_ATTRIBUTE)
  connection.setAttribute('role', 'status')

  // The one control, and the sentence that says why it is or is not available. The
  // hint is a sibling rather than a `title`, because a tooltip is unreachable by
  // keyboard and unannounced by a screen reader.
  const ack = child('button', DASHBOARD_ACK_ATTRIBUTE)
  ack.setAttribute('type', 'button')
  ack.setAttribute('aria-describedby', DASHBOARD_ACK_HINT_ATTRIBUTE)
  const ackHint = child('span', DASHBOARD_ACK_HINT_ATTRIBUTE)

  // A refusal is the answer to something the developer just did, so it is announced
  // rather than painted: `alert` is the assertive live region, and this is the one
  // place on the page where interrupting a screen reader is the right answer.
  //
  // Every region here goes through `child`, which finds the one the served document
  // already declares. A real browser found what happens when one of them did not:
  // index.html declares the hint and the refusals region, the mount created a second
  // of each, and every reader - `aria-describedby`, `querySelector`, a screen reader -
  // found the empty first one. The page shipped an acknowledgement control whose
  // reason for being disabled was invisible, and jsdom passed every assertion about
  // it because jsdom's document has no pre-declared header to duplicate.
  const refusals = child('div', DASHBOARD_REFUSALS_ATTRIBUTE)
  refusals.setAttribute('role', 'alert')

  const deepLink = child('p', DASHBOARD_DEEP_LINK_ATTRIBUTE)
  deepLink.textContent = INITIAL_DEEP_LINK_STATE.sentence ?? ''

  const historyToggle = child('button', DASHBOARD_HISTORY_TOGGLE_ATTRIBUTE)
  historyToggle.setAttribute('type', 'button')
  historyToggle.setAttribute('aria-controls', DASHBOARD_HISTORY_PANEL_ID)
  historyToggle.setAttribute('aria-expanded', 'true')
  historyToggle.textContent = 'History'

  return { header, pending, connection, ack, ackHint, refusals, deepLink, historyToggle }
}

/** Whether the page was asked to show the mirror, and the attribute that does it. */
export function applyInspectionFlag(doc: Document, search: string | undefined): boolean {
  if (search === undefined) return false
  const requested = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get(
    MIRROR_INSPECT_PARAMETER,
  )
  const on = requested === MIRROR_INSPECT_VALUE
  if (on) doc.documentElement.setAttribute(MIRROR_INSPECT_ATTRIBUTE, MIRROR_INSPECT_VALUE)
  return on
}

/**
 * Say, in the header, that the page could not start.
 *
 * A blank surface under a header that still reads "Connecting to the hub" is a page
 * that looks like a hub that has stopped answering, which is the one reading this
 * page must never invite. So a mount failure is printed where the connection state
 * normally is, in the same words-a-person-can-read style, and the state attribute
 * says `disconnected` because from a reader's point of view that is what happened.
 */
export function reportMountFailure(doc: Document, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const header = doc.querySelector(`[${DASHBOARD_HEADER_ATTRIBUTE}]`)
  if (header !== null) {
    header.setAttribute(DASHBOARD_CONNECTION_ATTRIBUTE, 'disconnected')
    const line = header.querySelector(`[${DASHBOARD_CONNECTION_TEXT_ATTRIBUTE}]`)
    if (line !== null) {
      line.textContent = `This page could not start: ${message}. Nothing below is current.`
      return
    }
  }
  // No header to write into: leave a line of text in the document rather than
  // failing silently, which is what a caught rejection with only a console line is.
  const fallback = doc.createElement('p')
  fallback.setAttribute(DASHBOARD_CONNECTION_ATTRIBUTE, 'disconnected')
  fallback.textContent = `agent-ping could not start: ${message}`
  doc.body?.append(fallback)
}

/** How the rows themselves changed, which is what decides whether a repaint is needed. */
function contentSignature(state: LiveState): string {
  return state.sessions
    .map((session) =>
      [session.sessionId, session.state, String(session.pendingCount), session.lastSeenAt].join('~'),
    )
    .join('|')
}

function hoverSignature(regions: readonly HoverRegion[]): string {
  return regions.map((region) => `${region.repositoryId}~${region.y}~${region.height}`).join('|')
}

/**
 * The row model the mirror renders, in the canvas's own order.
 *
 * The plan's rows are the canvas order and carry everything the mirror shows except
 * one thing: the pending count. The plan is a drawing, and a drawing has no use for
 * a count it already spells inside the status line, so the count is joined here from
 * the same session list the plan was built from - by session identity, so a row
 * cannot pick up another row's count. Deriving the model in one function, from one
 * list, is what keeps the two renderers from being fed different data (APX-CON-07)
 * and what makes an optimistic marker land on the canvas and in the mirror together.
 */
function liveMirrorModel(
  plan: ScenePlan<LiveDisplayState>,
  sessions: readonly HubSession[],
): MirrorModel {
  const pendingBySession = new Map(
    sessions.map((session) => [session.sessionId, session.pendingCount] as const),
  )
  return {
    groups: plan.groups.map((group) => ({
      repositoryId: group.repositoryId,
      shortName: group.shortName,
      path: group.path,
      rowIds: group.rowIds,
    })),
    rows: plan.rows.map((row) => ({
      sessionId: row.sessionId,
      repositoryId: row.repositoryId,
      repositoryShortName: row.repositoryShortName,
      repositoryPath: row.repositoryPath,
      state: row.state,
      encoding: row.encoding,
      label: row.label,
      status: row.status,
      age: row.age,
      // A row the plan draws is a row the state holds, so the lookup cannot miss;
      // the fallback is a zero rather than a claim the page cannot support.
      pendingCount: pendingBySession.get(row.sessionId) ?? 0,
    })),
  }
}

export async function mountDashboard(options: MountDashboardOptions): Promise<LiveDashboard> {
  const container = options.container
  const now = options.now ?? ((): string => new Date().toISOString())
  const createHost = options.createHost ?? createPixiDashboardHost
  const createTarget = options.createTarget ?? createPixiSceneTarget
  const buildMotionController = options.createMotionController ?? createMotionController
  const timers = options.timers ?? defaultMountTimers
  const bag = new SubscriptionBag()
  const chrome = resolveChrome(options, container)
  const header = chrome.header
  const doc = container.ownerDocument
  const origin = options.origin ?? globalThis.location?.origin ?? ''

  applyInspectionFlag(doc, options.search ?? globalThis.location?.search)

  let destroyed = false
  let state: LiveState = INITIAL_LIVE_STATE
  let hoveredRepositoryId: string | null = null
  let focusedSessionId: string | null = null
  let activatedSessionId: string | null = null
  /** The surface only ever grows: shrinking it on every change would resize the canvas continuously. */
  let surfaceHeight = measureContainer(container).height
  let currentRows: readonly RenderedRow<LiveDisplayState>[] = []
  /**
   * The signature of the rows the last repaint drew, or null before the first one.
   * Null rather than `''`, because a hub that answers with no sessions at all has
   * the empty signature and the page has to repaint that, not mistake it for "the
   * last repaint already drew nothing".
   */
  let lastContent: string | null = null
  let lastHover = ''
  /**
   * How many items this page has optimistically taken off each row, by session
   * identity. The optimistic half of an acknowledgement and nothing else: it moves a
   * row's marker, never the header's count (LD-FR-04).
   */
  let optimisticBySession = new Map<string, number>()
  /**
   * The hub's own count from an acknowledgement's 200 body, until the hub's next
   * frame says the same thing.
   *
   * The header's number is the hub's number in every state, and this is the hub's
   * number - read out of the answer to the write rather than computed here. It exists
   * so the count follows the acknowledgement immediately instead of waiting for the
   * frame, and it is dropped the moment the client's own state moves, so it can never
   * outlive the state it was correcting.
   */
  let serverPendingCount: number | null = null
  let refusals: readonly AckRefusalRecord[] = []
  const inFlight = new Map<string, Promise<AckResult>>()

  const host = await createHost({ container, size: measureContainer(container) })
  const canvas = host.canvas
  const target = createTarget(host.root, {
    onRepositoryHover: (repositoryId) => {
      setHoveredRepository(repositoryId)
    },
  })

  const motion = buildMotionController({})
  bag.add(() => {
    motion.destroy()
  })

  /**
   * Scroll the page so a focused row is where the developer is looking.
   *
   * The mirror is clipped to a one-pixel box, so the browser has nothing to scroll
   * to when a row is focused: it scrolls the focus into view *inside* that box, which
   * moves nothing a person can see. The row's real position is the canvas's, so the
   * offset is computed from the canvas's own rectangle and the row's `y` - the two
   * things only a browser with layout has, which is why this is the one behaviour
   * here a headless test asserts through a seam rather than by its result.
   */
  const scrollRowIntoView =
    options.scrollRowIntoView ??
    ((row: RevealedRow): void => {
      const rect = canvas.getBoundingClientRect()
      const top = rect.top + row.y
      const bottom = top + row.height
      const viewport = globalThis.innerHeight
      if (top >= REVEAL_MARGIN_PX && bottom <= viewport - REVEAL_MARGIN_PX) return
      const delta =
        top < REVEAL_MARGIN_PX ? top - REVEAL_MARGIN_PX : bottom - (viewport - REVEAL_MARGIN_PX)
      // The scroll is movement, so the same preference that suppresses an arriving
      // row's transition decides whether it slides or jumps. Jumping still brings
      // the row into view, so nothing is lost by suppressing it.
      globalThis.scrollBy({
        top: delta,
        behavior: motion.isAnimated('focus-indicator') ? 'smooth' : 'auto',
      })
    })

  /** Bring one row into view, if the plan still draws it. */
  const revealRow = (sessionId: string): void => {
    if (destroyed) return
    const row = currentRows.find((candidate) => candidate.sessionId === sessionId)
    if (row === undefined) return
    scrollRowIntoView({ sessionId: row.sessionId, y: row.y, height: row.height })
  }

  // The mirror's own sheet is an inline `<style>` element, which this page's
  // content-security-policy refuses: `style-src 'self'` with no `unsafe-inline`
  // (DASHBOARD_CSP in src/hub/security.ts) makes a browser drop the sheet and log
  // a policy violation on every load. The page's linked stylesheet
  // (src/dashboard/dashboard.css) carries the same rules and is what the policy is
  // for, so the live page injects nothing. A real browser under the real hub is
  // what found this; see the CSP assertion in tests/dashboard/session-list.test.ts.
  const mirror = (options.createMirror ?? createDomMirror)({ parent: container, injectStyleSheet: false })
  bag.add(() => {
    mirror.destroy()
  })

  // The handoff panel and the history panel are siblings of the canvas rather than
  // children of the container, and that is a measurement decision as much as a layout
  // one: `measureSurface` reads the container's own box, so panels inside it would
  // grow the surface the canvas is sized from, and a page whose rows are taller
  // because of the panel under them is a page whose geometry is a function of its
  // history. Outside, they cannot move anything the rows depend on. (A container with
  // no parent has no box to measure, so there the panels land inside it and
  // `measureContainer`'s fallback applies; the shipped page and every test that
  // drives a size are the other case.)
  const panelParent: HTMLElement = container.parentElement ?? container
  /** After the canvas, in order, so the panels read as one region under the rows. */
  const insertIntoPage = (element: HTMLElement, after: Element | null): void => {
    if (after !== null && after.parentNode !== null) {
      after.parentNode.insertBefore(element, after.nextSibling)
      return
    }
    if (container.parentNode !== null) {
      container.parentNode.insertBefore(element, container.nextSibling)
      return
    }
    container.append(element)
  }

  const handoff = createHandoffPanel({
    parent: panelParent,
    document: doc,
    ...(options.attachCommands === undefined ? {} : { templates: options.attachCommands }),
  })
  insertIntoPage(handoff.root, null)
  bag.add(() => {
    handoff.destroy()
  })

  // A second panel, not a new page: the developer never loses their place in the
  // list of rows (docs/features/live-dashboard.md §8, Open Question 2).
  const history = createHistoryPanel({
    parent: panelParent,
    document: doc,
    id: DASHBOARD_HISTORY_PANEL_ID,
    now,
  })
  insertIntoPage(history.root, handoff.root)
  bag.add(() => {
    history.destroy()
  })

  const navigator = (options.createNavigator ?? createKeyboardNavigator)({
    container: mirror.root,
    motion,
    onActivate: (sessionId) => {
      // Recorded and painted, and on a row that is waiting on something the same
      // keypress acknowledges it. That is the row-level half of the one control
      // (LD-FR-05, LD-FR-07): the pointer path is the button in the header, the
      // keyboard path is Enter, and both go through `acknowledge`, so a page cannot
      // grow a second way to write.
      //
      // Gated on the page being able to write at all. A page with no token pressing
      // Enter on a row has not failed an acknowledgement - the header already says
      // this page cannot acknowledge, and why - and recording a refusal for someone
      // who was only looking at a row would make the refusal region a lie.
      activatedSessionId = sessionId
      replan()
      const session = sessionFor(sessionId)
      if (writeToken !== null && session !== null && session.pendingCount > 0) {
        void acknowledge(sessionId)
      }
    },
    onFocusRow: (sessionId) => {
      // Focus reveals the full path exactly as hover does, and holds the row's
      // identity so the focus mark survives an update under it.
      focusedSessionId = sessionId
      const repositoryId = repositoryIdFor(sessionId)
      if (repositoryId !== null) setHoveredRepository(repositoryId)
      replan()
      // After the replan, so the geometry is the one the page is painting now and
      // not the one the row had before this focus.
      revealRow(sessionId)
    },
    onBlurRow: (_sessionId, relatedTarget) => {
      // Traversal inside the list is not a leave, and the mirror's own rebuild
      // handles the case where the focused element was replaced.
      if (relatedTarget !== null && mirror.root.contains(relatedTarget)) return
      focusedSessionId = null
      setHoveredRepository(null)
      replan()
    },
  })
  bag.add(() => {
    navigator.destroy()
  })

  // The mirror announces its own rebuilds and the keyboard model answers, so no
  // update path can replace the entries and leave the roving tabindex behind.
  mirror.onRebuilt(() => {
    navigator.refresh()
  })

  // -------------------------------------------------------------------------
  // LD-3: the one write, the deep link, the handoff, the history
  // -------------------------------------------------------------------------

  /** The row this page's single control acts on: the focused one, else the last activated. */
  const rowInHand = (): string | null => focusedSessionId ?? activatedSessionId

  const sessionFor = (sessionId: string | null): HubSession | null =>
    sessionId === null
      ? null
      : (state.sessions.find((session) => session.sessionId === sessionId) ?? null)

  const renderDeepLink = (next: DeepLinkState): void => {
    chrome.deepLink.textContent = next.sentence ?? ''
    chrome.deepLink.setAttribute(DASHBOARD_DEEP_LINK_STATUS_ATTRIBUTE, next.status)
  }

  const renderRefusals = (): void => {
    chrome.refusals.replaceChildren()
    for (const record of refusals.slice(-REFUSAL_VISIBLE_LIMIT)) {
      const line = doc.createElement('p')
      line.setAttribute(DASHBOARD_REFUSAL_ATTRIBUTE, record.code)
      line.setAttribute(DASHBOARD_REFUSAL_SESSION_ATTRIBUTE, record.sessionId)
      // The repository short name leads, because that is how a developer identifies
      // the row this is about (APX-CON-09), and the sentence says what did not happen.
      line.textContent = `${record.repositoryShortName} · ${record.sessionId}: ${record.sentence}`
      chrome.refusals.append(line)
    }
  }

  /**
   * The label, the availability and the reason, for the one control.
   *
   * Three conditions in a fixed order, and the order is the argument: a page that
   * cannot write at all says so whatever row is focused, because "this page cannot
   * acknowledge" is a fact about the page and not about the row; a row that is not
   * waiting on anything says so because a control that would refuse a third of the
   * time is a control nobody trusts. The label always names the row it will act on,
   * so an acknowledgement is never a guess about which row was meant.
   */
  const renderAckControl = (): void => {
    const target = rowInHand()
    if (writeToken === null) {
      chrome.ack.textContent = 'Acknowledgement is not available on this page'
      chrome.ack.setAttribute('disabled', '')
      chrome.ackHint.textContent = ack.unavailableSentence
      return
    }
    if (target === null) {
      chrome.ack.textContent = 'Acknowledge'
      chrome.ack.setAttribute('disabled', '')
      chrome.ackHint.textContent =
        'Focus a row that is waiting on something to acknowledge it. A row is focused with the ' +
        'arrow keys, and Enter on a focused row does the same thing.'
      return
    }
    const session = sessionFor(target)
    const waiting = session?.pendingCount ?? 0
    if (waiting <= 0) {
      chrome.ack.textContent = 'Acknowledge'
      chrome.ack.setAttribute('disabled', '')
      chrome.ackHint.textContent =
        'This row is not waiting on anything, so there is nothing to acknowledge.'
      return
    }
    chrome.ack.removeAttribute('disabled')
    const busy = inFlight.has(target)
    chrome.ack.textContent = busy
      ? 'Acknowledging…'
      : `Acknowledge ${session?.repoShortName ?? UNKNOWN_REPOSITORY} · ${target}`
    chrome.ackHint.textContent =
      `Acknowledges the oldest of the ${String(waiting)} item${waiting === 1 ? '' : 's'} this row ` +
      'is waiting on. Nothing else changes, and the hub decides whether it is allowed.'
  }

  /**
   * What became of one acknowledgement, applied to the page.
   *
   * The optimistic marker always comes off, whatever the answer, because leaving it
   * on after a refusal would be the page claiming an acknowledgement that did not
   * happen. The refusal itself is recorded, rendered in the header and marked on the
   * row, and the hub's own count - not a decrement - becomes the header's number.
   */
  const applyAckResult = (result: AckResult): void => {
    if (destroyed) return
    optimisticBySession = new Map()
    if (result.outcome === 'refused' && result.refusal !== null) {
      refusals = [
        ...refusals,
        {
          sessionId: result.sessionId,
          repositoryShortName: sessionFor(result.sessionId)?.repoShortName ?? UNKNOWN_REPOSITORY,
          code: result.refusal.code,
          status: result.refusal.status,
          sentence: result.refusal.sentence,
          at: now(),
        },
      ]
    } else {
      // A write that landed clears this row's earlier refusals: the developer acted
      // again and it worked, so a row must not keep saying it failed.
      refusals = refusals.filter((record) => record.sessionId !== result.sessionId)
    }
    if (result.pendingCount !== null) serverPendingCount = result.pendingCount
    renderRefusals()
    renderAckControl()
    renderHeader(state)
    replan()
  }

  const writeToken = readWriteToken(doc, options.writeToken)
  const doFetch = options.fetchImpl
  const ack = createAckController({
    // No token, no transport. The page then has a control that says it cannot
    // acknowledge rather than one that would fail against the boundary (HC-FR-06).
    transport:
      writeToken === null
        ? null
        : createFetchAckTransport({
            origin,
            token: writeToken,
            ...(doFetch === undefined ? {} : { fetchImpl: doFetch }),
          }),
    readPending:
      doFetch === undefined
        ? createFetchPendingReader({ origin })
        : createFetchPendingReader({ origin, fetchImpl: doFetch }),
    now,
    onOptimistic: ({ sessionId }) => {
      optimisticBySession = new Map(optimisticBySession).set(
        sessionId,
        (optimisticBySession.get(sessionId) ?? 0) + 1,
      )
      renderAckControl()
      replan()
    },
    onSettled: applyAckResult,
  })
  bag.add(() => {
    ack.destroy()
  })

  /**
   * Acknowledge one row, through the one control.
   *
   * A second press while the first is in flight joins the first rather than starting
   * a second write: two writes for one press is how a pending item gets acknowledged
   * twice, and the hub's `unchanged` answer would then be read as two successes.
   */
  const acknowledge = async (sessionId?: string): Promise<AckResult> => {
    const target = sessionId ?? rowInHand()
    if (target === null) return refusedAckResult('', 'no-pending-item')
    const existing = inFlight.get(target)
    if (existing !== undefined) return existing
    const started = ack.acknowledge(target)
    inFlight.set(target, started)
    renderAckControl()
    try {
      return await started
    } finally {
      inFlight.delete(target)
      renderAckControl()
    }
  }

  const onAckClick = (): void => {
    void acknowledge()
  }
  chrome.ack.addEventListener('click', onAckClick)
  bag.add(() => {
    chrome.ack.removeEventListener('click', onAckClick)
  })

  /**
   * The deep link's focus, and the case the mirror cannot see.
   *
   * The mirror restores focus by identity on every rebuild, so an update under the
   * focused row does not lose it. What it cannot see is a rebuild that left focus
   * nowhere at all - the list emptied and refilled around the row, or the element the
   * browser had focused was removed and the mirror had no previous row to restore
   * from. That is what this asserts after every applied state, and it is why LD-FR-06
   * can say the focus survives a later live update rather than that it usually does.
   */
  const deepLink = createDeepLinkController({
    search: options.search ?? globalThis.location?.search,
    hasRead: () => state.updatedAt !== null,
    hasRow: (sessionId) => currentRows.some((row) => row.sessionId === sessionId),
    focus: (sessionId) => {
      navigator.focusSession(sessionId)
      // After the focus, because focusing a row reveals its repository's full path
      // and re-lays the page: the geometry to scroll to is the one being painted now.
      revealRow(sessionId)
    },
    isFocusInList: () => {
      const active = doc.activeElement
      return active !== null && mirror.root.contains(active)
    },
    onState: renderDeepLink,
  })
  bag.add(() => {
    deepLink.destroy()
  })

  /**
   * The bounded history, read after every change to the rows.
   *
   * Gated on the same signature as the canvas repaint, so a heartbeat or a duplicate
   * frame costs no request, and guarded by a token so a slow read cannot overwrite a
   * newer one. An unreadable read renders an empty panel that says so rather than
   * leaving the last good list on screen as though it were current.
   */
  const readHistory =
    doFetch === undefined
      ? createFetchHistoryReader({ origin })
      : createFetchHistoryReader({ origin, fetchImpl: doFetch })
  let historyRead = 0
  const refreshHistory = async (): Promise<void> => {
    if (destroyed) return
    const read = (historyRead += 1)
    history.setStatus('reading')
    try {
      const entries = await readHistory()
      if (destroyed || read !== historyRead) return
      history.render(entries, state.sessions)
    } catch {
      if (destroyed || read !== historyRead) return
      history.render([], state.sessions)
      history.setStatus('unreadable')
    }
  }

  const setHistoryOpen = (open: boolean): void => {
    if (destroyed) return
    history.setOpen(open)
    chrome.historyToggle.setAttribute('aria-expanded', open ? 'true' : 'false')
  }

  const onHistoryToggle = (): void => {
    setHistoryOpen(!history.isOpen)
  }
  chrome.historyToggle.addEventListener('click', onHistoryToggle)
  bag.add(() => {
    chrome.historyToggle.removeEventListener('click', onHistoryToggle)
  })
  setHistoryOpen(options.historyOpen ?? true)

  const client = (options.createClient ?? createStreamClient)({ origin })
  const unsubscribeClient = client.onChange((next) => {
    state = next
    applyState(next)
  })
  bag.add(() => {
    unsubscribeClient()
  })
  bag.add(() => {
    client.close()
  })

  function repositoryIdFor(sessionId: string): string | null {
    const session = state.sessions.find((candidate) => candidate.sessionId === sessionId)
    return session?.repoShortName ?? null
  }

  /**
   * The session rows the page paints, with any optimistic marker applied.
   *
   * One list, derived once per repaint, and the *same* list feeds the plan and the
   * mirror: an optimistic marker that reached the canvas and not the mirror - or the
   * other way round - would leave the keyboard user looking at a row that disagrees
   * with the one they are on (APX-CON-07).
   *
   * Only the row's own count moves. The header's number is never derived from this
   * list, so a page that guessed here could not put a guessed number in the header.
   */
  const displaySessions = (): readonly HubSession[] => {
    if (optimisticBySession.size === 0) return state.sessions
    return state.sessions.map((session) => {
      const taken = optimisticBySession.get(session.sessionId) ?? 0
      if (taken === 0) return session
      return { ...session, pendingCount: Math.max(0, session.pendingCount - taken) }
    })
  }

  /** Repaint the canvas and hand the plan to the mirror, which is the only update path. */
  const repaint = (plan: ScenePlan<LiveDisplayState>): void => {
    target.clear()
    paintScene(plan, target)
    // Pointer targets follow the layout, not the state: rebuilding them on a
    // state-only repaint destroys the object the pointer is inside, which reads as
    // a hover that appears and instantly reverts.
    const nextHover = hoverSignature(plan.hoverRegions)
    if (nextHover !== lastHover) {
      lastHover = nextHover
      target.setHoverRegions(plan.hoverRegions)
    }
    mirror.render(liveMirrorModel(plan, displaySessions()))
  }

  /** Mark a row that has just arrived, and any row whose state just changed. */
  const markChanges = (
    rows: readonly RenderedRow<LiveDisplayState>[],
    previous: readonly RenderedRow<LiveDisplayState>[],
  ): void => {
    const before = new Map(previous.map((row) => [row.sessionId, row.state] as const))
    for (const row of rows) {
      const stateBefore = before.get(row.sessionId)
      const arrived = stateBefore === undefined
      if (!arrived && stateBefore === row.state) continue
      const entry = mirror.entryForSession(row.sessionId)
      if (entry === null) continue
      // An arriving row may move in; a state change never does. Under reduced
      // motion the arrival is instant and the state change is still visible, which
      // is the whole of what reduced motion is allowed to suppress here.
      if (arrived) motion.apply(entry, 'state-arrival', true)
      motion.showStateChange(entry)
    }
  }

  const renderHeader = (current: LiveState): void => {
    chrome.pending.textContent = pendingText(current, serverPendingCount)
    chrome.connection.textContent = connectionText(current)
    header.setAttribute(DASHBOARD_CONNECTION_ATTRIBUTE, current.connection)
  }

  const buildPlan = (): ScenePlan<LiveDisplayState> =>
    buildLivePlan(displaySessions(), {
      width: host.getSize().width,
      height: surfaceHeight,
      now: now(),
      hoveredRepositoryId,
      focusedSessionId,
      activatedSessionId,
      // Every row with an unresolved refusal on it, so a row says so where the
      // developer is looking and not only in the header (LD-FR-05).
      refusedSessionIds: refusedSessionIds(),
    })

  /**
   * How tall the surface has to be to hold every row the plan drew.
   *
   * The plan's own `contentHeight` is the approved layout's measure of itself, and it
   * is one page padding short of the last row it laid out: `contentHeight` stops
   * where the group gap starts, while the final row's status line is drawn past it.
   * The surface is sized from the rows rather than from that measure, because the
   * surface is the scrolling page and a row at its very bottom that the page cannot
   * scroll any further is a row the keyboard can focus and never see. The layout's
   * arithmetic is untouched - nothing moves, and the extra is empty canvas below the
   * last row - so this completes LD-1's own "grow to the rows" rule rather than
   * restating the design. The under-measure is the prototype's and is recorded for
   * the design review rather than changed here.
   */
  const requiredHeight = (plan: ScenePlan<LiveDisplayState>): number => {
    const drawn = plan.rows.reduce((bottom, row) => Math.max(bottom, row.y + row.height), 0)
    return Math.max(plan.contentHeight, drawn)
  }

  /** The rows with a refusal on them, by identity, newest record per row. */
  const refusedSessionIds = (): readonly string[] => [
    ...new Set(refusals.map((record) => record.sessionId)),
  ]

  /**
   * Mark the row's own DOM twin for a refusal, from outside the mirror.
   *
   * The attribute is set here rather than through the mirror's model because the
   * mirror renders the row and this is the page's verdict about an action, not a
   * property of the row's data: a session that is still blocked is still blocked
   * whether or not its last acknowledgement was refused. The canvas carries the same
   * fact as a word in the row's meta cell, so both renderers say it and the mirror's
   * own model is untouched.
   */
  const markRowRefusals = (): void => {
    const latest = new Map(refusals.map((record) => [record.sessionId, record.code] as const))
    for (const row of currentRows) {
      const entry = mirror.entryForSession(row.sessionId)
      if (entry === null) continue
      const code = latest.get(row.sessionId)
      if (code === undefined) entry.removeAttribute(DASHBOARD_ROW_REFUSAL_ATTRIBUTE)
      else entry.setAttribute(DASHBOARD_ROW_REFUSAL_ATTRIBUTE, code)
    }
  }

  /**
   * Reveal the attach command for the row in hand (LD-FR-07).
   *
   * Text, in a `<code>` element, for the row the developer is on. There is no button
   * here and no handler: the page can show a command and nothing else, which is the
   * whole of what the boundary allows it to do with a session.
   */
  const renderHandoff = (): void => {
    const session = sessionFor(rowInHand())
    handoff.reveal(
      session === null ? null : { harness: session.harness, sessionId: session.sessionId },
    )
  }

  /**
   * Lay the page out again from the state this client holds.
   *
   * The one place the canvas, the mirror and everything derived from the rows are
   * updated together, and the reason the focused row survives a live update: focus,
   * the revealed path and the activated row are identifiers laid into the plan, so a
   * change under the focused row re-renders the same row rather than a row that has
   * moved out from under it.
   *
   * The three LD-3 renderings are here rather than at their own call sites, so there
   * is no path that repaints the rows and leaves the control, the handoff or the
   * refusal marks describing a page that no longer exists.
   */
  const replan = (): void => {
    if (destroyed) return
    let plan = buildPlan()
    if (requiredHeight(plan) > surfaceHeight) {
      // The canvas grows to the rows rather than hiding them below its own edge: a
      // page that silently drops the sessions past the fold is a page that is wrong
      // about what needs the developer. The page's own container scrolls.
      surfaceHeight = Math.ceil(requiredHeight(plan))
      host.setSize({ width: host.getSize().width, height: surfaceHeight })
      plan = buildPlan()
    }
    const previous = currentRows
    currentRows = plan.rows
    repaint(plan)
    markChanges(plan.rows, previous)
    markRowRefusals()
    renderHandoff()
    renderAckControl()
    for (const group of plan.groups) {
      const revealed = group.repositoryId === hoveredRepositoryId
      const element = mirror.groupForRepository(group.repositoryId)
      if (element !== null) motion.apply(element, 'full-path-reveal', revealed)
    }
  }

  /**
   * Apply a state from the client: the header always, the canvas when the rows
   * changed.
   *
   * The canvas is the expensive half, and a heartbeat or a duplicate frame changes
   * nothing a person can see, so the repaint is gated on a signature of the rows
   * themselves. Everything the header shows is applied every time, because a
   * connection state that lagged a frame would be a connection state that lied.
   */
  const applyState = (current: LiveState): void => {
    if (destroyed) return
    // The client's own state has moved, so it is the authority from here: an
    // acknowledgement's 200 body was a correction for the window before the hub's
    // frame arrived, and nothing keeps it afterwards.
    serverPendingCount = null
    renderHeader(current)
    const next = contentSignature(current)
    const changed = next !== lastContent
    lastContent = next
    if (changed) {
      replan()
      // One read per change to the rows, and not one per frame: the history is a
      // panel, not a stream, and the rows' signature is already the gate for the
      // canvas repaint.
      void refreshHistory()
    }
    // After the repaint, so the deep link resolves against rows that exist. This is
    // what carries a deep-linked focus across a live update (LD-FR-06).
    deepLink.resolve()
  }

  function setHoveredRepository(repositoryId: string | null): void {
    if (destroyed) return
    if (repositoryId === hoveredRepositoryId) return
    hoveredRepositoryId = repositoryId
    replan()
  }

  function remeasure(): void {
    if (destroyed) return
    const next = measureSurface()
    const width = next.width
    surfaceHeight = Math.max(surfaceHeight, next.height)
    if (width !== host.getSize().width || surfaceHeight !== host.getSize().height) {
      host.setSize({ width, height: surfaceHeight })
    }
    replan()
  }

  /**
   * The container's box, with the mirror's own height taken out.
   *
   * The mirror is a child of the container, and in the inspection view
   * (`?mirror=visible`, which the design review asked to be inspectable) it is in
   * normal flow rather than clipped to one pixel. Feeding its height back into the
   * surface makes every repaint grow the canvas by the mirror's height, and the
   * ResizeObserver fires again: a feedback loop with no fixed point, which a real
   * browser showed as a 1594px canvas for one row. Subtracted here rather than in
   * `measureContainer`, which the prototype page shares and which has no mirror of
   * its own to account for. A clipped mirror contributes its one pixel, and the
   * surface only ever grows, so the shipped view is unchanged.
   */
  function measureSurface(): Size {
    const size = measureContainer(container)
    const mirrorHeight = mirror.root.getBoundingClientRect().height
    return { width: size.width, height: Math.max(0, size.height - mirrorHeight) }
  }

  // Two independent size sources, because neither covers the other: a
  // ResizeObserver sees the container change for any reason, and the window
  // listener is the only one that exists in an environment without the observer.
  const onWindowResize = (): void => {
    remeasure()
  }
  window.addEventListener('resize', onWindowResize)
  bag.add(() => {
    window.removeEventListener('resize', onWindowResize)
  })

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => {
      remeasure()
    })
    observer.observe(container)
    bag.add(() => {
      observer.disconnect()
    })
  }

  // One timer for the ages, as a recursive timeout so teardown cancels one handle.
  let ageHandle: unknown = null
  const scheduleAgeTick = (): void => {
    if (destroyed) return
    ageHandle = timers.setTimeout(() => {
      ageHandle = null
      replan()
      scheduleAgeTick()
    }, LIVE_AGE_TICK_MS)
  }
  bag.add(() => {
    if (ageHandle === null) return
    timers.clearTimeout(ageHandle)
    ageHandle = null
  })
  scheduleAgeTick()

  // The first paint happens before the hub has answered anything: an empty page
  // with a header that says it is connecting is honest, where a blank surface is
  // not. The pending count reads as not-yet-read until the hub has said. The deep
  // link resolves here too, and answers "looking" rather than "gone" for the frames
  // before the hub's first read.
  replan()
  renderHeader(state)
  deepLink.resolve()

  const destroy = (): void => {
    if (destroyed) return
    destroyed = true
    bag.removeAll()
    host.stopRendering()
    host.teardown()
    if (canvas.parentNode !== null) canvas.parentNode.removeChild(canvas)
  }

  // Unload, not a bespoke teardown hook: closing the window or navigating away has
  // to be enough for the renderer, the stream and its subscriptions to go away.
  const onUnload = (): void => {
    destroy()
  }
  window.addEventListener('beforeunload', onUnload)
  bag.add(() => {
    window.removeEventListener('beforeunload', onUnload)
  })

  client.start()

  return {
    host,
    mirror,
    navigator,
    motion,
    client,
    ack,
    handoff,
    history,
    deepLink,
    header,
    get refusals(): readonly AckRefusalRecord[] {
      return refusals
    },
    get writeTokenAvailable(): boolean {
      return writeToken !== null
    },
    get state(): LiveState {
      return state
    },
    get plan(): ScenePlan<LiveDisplayState> {
      return buildPlan()
    },
    get rows(): readonly RenderedRow<LiveDisplayState>[] {
      return currentRows
    },
    get focusedSessionId(): string | null {
      return focusedSessionId
    },
    get activatedSessionId(): string | null {
      return activatedSessionId
    },
    get isHistoryOpen(): boolean {
      return history.isOpen
    },
    get activeSubscriptions(): number {
      return bag.size
    },
    get isDestroyed(): boolean {
      return destroyed
    },
    setHoveredRepository,
    revealRow,
    acknowledge,
    setHistoryOpen,
    remeasure,
    destroy,
  }
}

// ---------------------------------------------------------------------------
// Page composition root
// ---------------------------------------------------------------------------

/**
 * Mount automatically when this module is loaded as the page's entry script and
 * the page has provided a root. A test importing the module to call
 * `mountDashboard` directly finds no root in the document, so importing it mounts
 * nothing - the same rule the prototype's entry point follows.
 */
const pageRoot = document.querySelector<HTMLElement>(`[${DASHBOARD_ROOT_ATTRIBUTE}]`)
if (pageRoot !== null) {
  void mountDashboard({ container: pageRoot }).catch((error: unknown) => {
    // The page is the only surface there is, so a failure to start has to be
    // visible on it rather than only in the console.
    reportMountFailure(document, error)
    console.error('agent-ping dashboard failed to mount', error)
  })
}
