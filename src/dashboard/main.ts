// The live dashboard's one mount entry point, and the page the hub serves
// (LD-FR-01, LD-FR-03, LD-FR-04, LD-FR-10).
//
// WHAT THIS IS
// One exported mount, `mountDashboard`, and the composition root that calls it when
// this module is loaded as the page's entry script. Everything the live page shows
// hangs off it: the page header (pending count and connection state), the PixiJS
// canvas of repository groups and session rows, and the visually hidden DOM mirror
// that makes every painted row reachable by keyboard and legible to a screen reader
// (APX-CON-07). All three are built from one row model, in one order, so a row
// cannot exist on the canvas and not in the mirror.
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
// THE LAYOUT IS THE APPROVED ONE
// `buildLivePlan` lays the hub's sessions out with `layoutGroups`, the function
// the prototype's own plan comes out of, and the painter is the prototype's painter.
// The page adds exactly two marks to that plan - the focused row's band and rail,
// and the word in an activated row's meta cell - because the DP-4 design review
// required both and the prototype had no render path for either. Nothing about the
// row, the group or the density changed.
//
// WHERE THE FOCUSED ROW SURVIVES AN UPDATE
// Focus and the activated row are held as session identifiers and re-laid into
// every new plan, never as indexes: a live update under the focused row re-renders
// the plan, and an index into a list that just re-sorted is a different row. The
// keyboard model's own callbacks write those two identifiers, and the mirror
// restores DOM focus by identity while it rebuilds, so the two agree about which
// row is focused even when the rows above it have moved.
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
// One bag, one `destroy()`, and the same three steps the prototype takes: drop the
// subscriptions, stop the render loop, destroy the renderer with its textures. The
// stream client is closed before the bag is emptied, because its reconnect timer is
// the one thing here that would otherwise keep opening connections after the page
// went away.

import { createDomMirror, type DomMirror } from './a11y/dom-mirror'
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
  type LiveState,
  type StreamClient,
} from './live/stream-client'

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
 */
export function pendingText(state: LiveState): string {
  if (state.updatedAt === null) return 'pending count not read yet'
  const base = `${String(state.pendingCount)} pending`
  return state.connection === 'live' ? base : `${base} (last known)`
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
  /** Where the inspection flag is read from. Defaults to the page's location. */
  readonly search?: string
  /** Defaults to the page's own timers. */
  readonly timers?: MountTimers
}

export interface LiveDashboard {
  readonly host: DashboardHost
  /** The visually hidden, focusable twin of every painted row (APX-CON-07). */
  readonly mirror: DomMirror
  /** Keyboard traversal and activation over the mirror. */
  readonly navigator: KeyboardNavigator
  readonly motion: MotionController
  readonly client: StreamClient
  /** The hub's state as this page holds it. */
  readonly state: LiveState
  /** The current plan. `rows` is canvas order, which is the mirror's order too. */
  readonly plan: ScenePlan<LiveDisplayState>
  readonly rows: readonly RenderedRow<LiveDisplayState>[]
  /** The header the page prints its count and connection state into. */
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
  /** Re-read the container size and re-lay out. */
  remeasure(): void
  destroy(): void
}

/** The page header, found or created, with the two elements it prints into. */
function resolveHeader(options: MountDashboardOptions, container: HTMLElement): HTMLElement {
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
  for (const attribute of [DASHBOARD_PENDING_ATTRIBUTE, DASHBOARD_CONNECTION_TEXT_ATTRIBUTE]) {
    if (header.querySelector(`[${attribute}]`) !== null) continue
    const element = doc.createElement('span')
    element.setAttribute(attribute, '')
    header.append(element)
  }
  // The connection state is a live region: a page that silently stops updating is
  // the failure this page exists to prevent, and a live region is the only channel
  // that reaches someone who is not looking at the header.
  header.querySelector(`[${DASHBOARD_CONNECTION_TEXT_ATTRIBUTE}]`)?.setAttribute('role', 'status')
  return header
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

export async function mountDashboard(options: MountDashboardOptions): Promise<LiveDashboard> {
  const container = options.container
  const now = options.now ?? ((): string => new Date().toISOString())
  const createHost = options.createHost ?? createPixiDashboardHost
  const createTarget = options.createTarget ?? createPixiSceneTarget
  const buildMotionController = options.createMotionController ?? createMotionController
  const timers = options.timers ?? defaultMountTimers
  const bag = new SubscriptionBag()
  const header = resolveHeader(options, container)

  applyInspectionFlag(container.ownerDocument, options.search ?? globalThis.location?.search)

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

  const navigator = (options.createNavigator ?? createKeyboardNavigator)({
    container: mirror.root,
    motion,
    onActivate: (sessionId) => {
      // Recorded and painted rather than performed: the acknowledgement this row
      // needs is LD-3's, and what DP-4 asked for here is that activating a row is
      // visible rather than silent.
      activatedSessionId = sessionId
      replan()
    },
    onFocusRow: (sessionId) => {
      // Focus reveals the full path exactly as hover does, and holds the row's
      // identity so the focus mark survives an update under it.
      focusedSessionId = sessionId
      const repositoryId = repositoryIdFor(sessionId)
      if (repositoryId !== null) setHoveredRepository(repositoryId)
      replan()
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

  const client = (options.createClient ?? createStreamClient)({
    origin: options.origin ?? globalThis.location?.origin ?? '',
  })
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
    mirror.render(plan)
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
    const pending = header.querySelector(`[${DASHBOARD_PENDING_ATTRIBUTE}]`)
    const connection = header.querySelector(`[${DASHBOARD_CONNECTION_TEXT_ATTRIBUTE}]`)
    if (pending !== null) pending.textContent = pendingText(current)
    if (connection !== null) connection.textContent = connectionText(current)
    header.setAttribute(DASHBOARD_CONNECTION_ATTRIBUTE, current.connection)
  }

  const buildPlan = (): ScenePlan<LiveDisplayState> =>
    buildLivePlan(state.sessions, {
      width: host.getSize().width,
      height: surfaceHeight,
      now: now(),
      hoveredRepositoryId,
      focusedSessionId,
      activatedSessionId,
    })

  /**
   * Lay the page out again from the state this client holds.
   *
   * The one place the canvas and the mirror are updated together, and the reason
   * the focused row survives a live update: focus, the revealed path and the
   * activated row are identifiers laid into the plan, so a change under the focused
   * row re-renders the same row rather than a row that has moved out from under it.
   */
  const replan = (): void => {
    if (destroyed) return
    let plan = buildPlan()
    if (plan.contentHeight > surfaceHeight) {
      // The canvas grows to the rows rather than hiding them below its own edge: a
      // page that silently drops the sessions past the fold is a page that is wrong
      // about what needs the developer. The page's own container scrolls.
      surfaceHeight = Math.ceil(plan.contentHeight)
      host.setSize({ width: host.getSize().width, height: surfaceHeight })
      plan = buildPlan()
    }
    const previous = currentRows
    currentRows = plan.rows
    repaint(plan)
    markChanges(plan.rows, previous)
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
    renderHeader(current)
    const next = contentSignature(current)
    if (next === lastContent) return
    lastContent = next
    replan()
  }

  function setHoveredRepository(repositoryId: string | null): void {
    if (destroyed) return
    if (repositoryId === hoveredRepositoryId) return
    hoveredRepositoryId = repositoryId
    replan()
  }

  function remeasure(): void {
    if (destroyed) return
    const next = measureContainer(container)
    const width = next.width
    surfaceHeight = Math.max(surfaceHeight, next.height)
    if (width !== host.getSize().width || surfaceHeight !== host.getSize().height) {
      host.setSize({ width, height: surfaceHeight })
    }
    replan()
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
  // not. The pending count reads as not-yet-read until the hub has said.
  replan()
  renderHeader(state)

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
    header,
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
    get activeSubscriptions(): number {
      return bag.size
    },
    get isDestroyed(): boolean {
      return destroyed
    },
    setHoveredRepository,
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
