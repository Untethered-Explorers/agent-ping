// The tray: the icon that is present for as long as the hub runs, the two menu
// actions it offers, and the deep link a click resolves (NT-FR-05, NT-FR-06,
// NT-FR-07, PRD 10, PRD 11, ADR-004, ADR-009, APX-CON-04, APX-CON-12, APX-FR-01).
//
// WHAT THIS FILE IS, AND WHAT IT IS NOT
// It is the *behaviour* of a tray icon, with every platform call left to a bridge:
//   - presence, for as long as the hub runs
//   - a badge that follows the hub's own pending set (the rule itself is pure and
//     lives in ../tray/badge.ts, where it can be checked without a desktop)
//   - exactly two menu actions, and the routing of a selection to one of them
//   - a click that resolves the dashboard deep link, and the counting of that open
//   - a quit that is the hub's own ordered shutdown rather than a second one
// It is *not* an Electron object graph, a window, or a renderer. Nothing here draws a
// pixel, opens a browser, reads a file, spawns a process or reaches off this machine;
// the icon's bytes come from the pure module and go to a bridge, and the deep link
// goes to a bridge (APX-CON-12). It also does not render the dashboard: the link
// resolves, and what shows up is the Live Dashboard feature's page (ADR-009, and
// this feature's own scope note that it only guarantees the link resolves).
//
// WHY THE ICON IS PRESENT FOR AS LONG AS THE HUB RUNS, AND NOT FOR A MOMENT
// NT-FR-05 says the icon is present for as long as the hub runs, and PRD 10's
// `running` state means "accepting events, with the tray present". So the composition
// root mounts this before it marks the hub running, and `HubTray.close` removes the
// icon as the first step of the ordered shutdown - before the log is closed and before
// the runtime file is released. That order is not tidiness. The badge reads the hub's
// pending set, so a tray that outlived the log would either freeze on a stale number
// or report a read failure on the way out; a hub that removed the runtime file before
// the tray stopped would leave an icon advertising a hub that no longer answers
// (APX-FR-02).
//
// TWO MENU ACTIONS, AND THE ABSENCE IS THE POINT (NT-FR-06)
// `TRAY_MENU_ITEMS` is a two-row table over a two-member union, and there is no third
// kind of item this file can express: a mute, a snooze, a dismiss, a "mark all read",
// a per-session ignore. A block that could be forgotten silently is the failure this
// whole product exists to prevent, so a suppression affordance is not a missing
// feature here, it is the opposite of the feature. The way to deal with a block is to
// resolve it in the harness or acknowledge it in the dashboard, and both of those are
// facts about the durable log (src/domain/pending.ts). The surface of `HubTray` below
// is asserted by name for the same reason: an added method called `dismiss` or `mute`
// has to be a failing test, not a review finding.
//
// THE BADGE FOLLOWS THE PENDING SET, AND NEVER A NUMBER SOMEBODY KEPT IN STEP
// The only input is the hub's own pending read - the accessor `GET /api/pending`
// serves and the restart replay reads, so the tray, the route and the replay cannot
// disagree about what is outstanding (NT-FR-05, EL-FR-08, and the note on that route
// in src/hub/routes/read.ts). The tray re-reads it when it is mounted and on every
// applied transition the change feed publishes, and never on a heartbeat: a heartbeat
// is a keepalive, not a change (src/hub/sse.ts). Nothing polls.
//
// A CLICK FOCUSES THE SESSION THAT HAS WAITED LONGEST
// A toast carries the deep link for its own session (NT-FR-07, built by the class
// policy in src/notify/policy.ts). The tray does not know which toast a developer saw,
// so its own click takes the oldest outstanding item - the same oldest-first rule the
// restart replay uses for the same reason (src/hub/delivery.ts). With nothing pending
// the click is still the dashboard, and it is still an open; it simply has no session
// to focus. The link is built by `deepLinkFor` from the live origin, never from the
// preferred port, because a link built from a port that was only a preference sends a
// developer to whatever else on this machine answers there (HC-FR-01).
//
// WHO COUNTS THE OPEN, AND WHY IT IS NOT ALWAYS THE SAME ANSWER
// HC-6 published `recordDashboardOpen` and `recordDeepLinkOpen` for exactly this case
// and said why: the tray resolves a link in the main process, where no HTTP request
// necessarily happens, and a counter that moved on the click *and* on the document
// request it caused would count one pull twice. So the bridge answers with what it
// did, and there are three answers:
//   dashboard-request-follows  a document request will arrive; the route's own handler
//                              records the open and the deep link, and the tray
//                              records nothing (this is the packaged window's path)
//   resolved-without-request   the surface resolved the target without requesting the
//                              document; the tray records both, because otherwise the
//                              open would be counted nowhere (APX-FR-02)
//   unavailable                nothing was opened; the tray records nothing and says
//                              so on a diagnostic line, because a click that did
//                              nothing must not be a click that counted something
// A deep link counts as *both* a deep-link open and a dashboard open, which is
// NT-FR-07's own sentence, and the plain dashboard counts as the open alone.
//
// A FAILED CLICK IS NEVER SILENT, AND A CLICK IS NEVER HALF-COUNTED
// A bridge that throws, a bridge that reports `unavailable`, and a hub with no live
// origin to build a link from are three different faults and all three are reported as
// a diagnostic line naming the reason, with no count moved (APX-FR-02, ADR-010). A
// badge that cannot be recomputed - because the pending read failed - keeps the last
// number it had and reports the fault, rather than going blank; a blank badge at the
// moment a block appeared is exactly the wrong answer, and the hub is already
// reporting `degraded` on health for the log that failed to read.
//
// NO SOUND, EVER, ON THIS PATH (APX-CON-04)
// There is no sound field, no sound flag and no sound-capable value in this file, in
// the badge module, or in anything either of them hands a bridge. There is also no
// repeat: the tray is updated from the change feed and never re-announces anything, so
// the badge cannot become a re-fired toast by another route (NT-FR-08).

import { badgeForPending, drawTrayIcon, type BadgeDecision, type TrayIcon } from '../tray/badge.js'
import { deepLinkFor } from '../notify/policy.js'
import type { PendingItem } from '../storage/eventStore.js'
import { recordOpenWithoutRequest, type DeepLinkTarget, type MetricsRecorder } from './metrics.js'
import type { StreamSubscriber } from './sse.js'

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

/**
 * The two things the tray menu offers.
 *
 * A closed two-member union, and the table that carries it is two rows long. A third
 * row is a compile error in this file and a failing test in
 * tests/hub/tray.test.ts, which enumerates the ids rather than restating them. What
 * is deliberately *not* in the union is the whole family NT-FR-06 names: no `mute`,
 * no `snooze`, no `dismiss`, no `mark-all-read`, no per-session ignore, and no
 * separator item that could later carry one (src/domain/pending.ts says why a block
 * has exactly two exits and this product must not add a third).
 */
export type TrayMenuItemId = 'open-dashboard' | 'quit'

export interface TrayMenuItem {
  readonly id: TrayMenuItemId
  /** The text a developer reads. No count, no pending item, no session. */
  readonly label: string
}

/**
 * The menu, as data.
 *
 * The order is the order a menu is read in: the action first, the way out second.
 *
 * The quit label carries the answer to the only question it raises - *is it safe to
 * quit with a block outstanding?* - because it is (the pending set is durable and
 * returns on the next start, and the restart replay re-announces it), and because a
 * confirmation dialog that nags about a decision the developer is entitled to make is
 * worse than the question. The feature document's Open Question 4 asked for exactly
 * this: the copy says so instead of a dialog.
 */
export const TRAY_MENU_ITEMS: readonly TrayMenuItem[] = Object.freeze([
  Object.freeze({ id: 'open-dashboard', label: 'Open dashboard' }),
  Object.freeze({
    id: 'quit',
    label: 'Quit (blocks still waiting come back when agent-ping restarts)',
  }),
])

/** The menu's ids, derived from the table rather than written beside it. */
export const TRAY_MENU_ITEM_IDS: readonly TrayMenuItemId[] = Object.freeze(
  TRAY_MENU_ITEMS.map((item) => item.id),
)

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

/** Why a click opened nothing. Every one of them is a reported fault. */
export type TrayUnavailableReason =
  /** The socket was not bound, so there is no honest loopback link to hand over. */
  | 'no-live-origin'
  /** The bridge said it could not open anything. */
  | 'bridge-refused'
  /** The bridge threw while opening. */
  | 'bridge-threw'

/**
 * What the bridge did with a resolved link.
 *
 * The three answers, and the middle one is the reason this type exists. A tray click
 * either causes a document request - a window pointed at the URL, or a browser handed
 * it - in which case the hub's own dashboard route records the open and the deep link
 * and the tray must not record them again, or it does not, in which case nobody else
 * will and the tray must. HC-6 said this out loud when it published the two public
 * counter methods, and counting twice would put a success number next to a gap, which
 * is what PRD 11's restraint row is measured against.
 */
export type DeepLinkDispatch =
  | { readonly kind: 'dashboard-request-follows' }
  | { readonly kind: 'resolved-without-request' }
  | { readonly kind: 'unavailable'; readonly reason: TrayUnavailableReason }

/** The menu as the tray wants it drawn, and how a selection comes back. */
export interface TrayMenuView {
  /** Exactly `TRAY_MENU_ITEMS`, in order. Two rows, and no third kind of row. */
  readonly items: readonly TrayMenuItem[]
  /** The bridge calls this with the id the developer picked. */
  select: (id: TrayMenuItemId) => void
}

/**
 * The desktop half, as one small interface.
 *
 * Every platform call the tray needs and nothing else: put an icon on the desktop, put
 * a menu on it, be told when the icon was activated, open a link, take the icon away.
 * The Electron implementation lives in the main entry point (src/main/index.ts),
 * behind a dynamic import, so nothing in this file needs Electron to typecheck, to be
 * started by a test, or to be read.
 *
 * It is deliberately not an `Electron.Tray` typed from Electron's own declarations.
 * Those are the platform's shapes; these are this product's five operations, and a
 * test drives them exactly as a desktop would.
 */
export interface TrayBridge {
  /**
   * Put the icon on the desktop, replacing whatever was there.
   *
   * Called once at mount and again only when the badge changes. The bytes are BGRA and
   * the tooltip is this product's own name with a count - no repository, no path, no
   * session, no event text (APX-FR-01).
   */
  showIcon(icon: TrayIcon): void
  /** Put the two-item menu on the icon, and route a selection back by id. */
  showMenu(view: TrayMenuView): void
  /**
   * Register what a click on the icon does.
   *
   * Called once, at mount. The tray owns the answer; the bridge only reports that a
   * click happened, so there is one place where "a click means open the dashboard" is
   * decided and a platform cannot invent a second meaning.
   */
  onActivate(listener: () => void): void
  /**
   * Open a resolved link, and say whether a document request for it will follow.
   *
   * The answer decides who counts the open, and it is the bridge's to give because
   * the bridge is what knows: a window pointed at a loopback URL requests it, and a
   * desktop that resolved the target some other way does not. See `DeepLinkDispatch`.
   */
  openDashboard(url: string): DeepLinkDispatch
  /**
   * Take the icon off the desktop. Idempotent.
   *
   * Reached from `HubTray.close` and therefore from the hub's ordered shutdown, so
   * the icon does not outlive the process that promised it (NT-FR-05).
   */
  destroy(): void
}

// ---------------------------------------------------------------------------
// The tray
// ---------------------------------------------------------------------------

/** What a click resolved, and where the open was counted. */
export interface TrayActivation {
  /** The link handed to the bridge, or null when there was no honest link to hand. */
  readonly url: string | null
  /** Whether the link focused a session or is the plain dashboard. */
  readonly target: DeepLinkTarget | 'none'
  /** Which half of the counting rule recorded the open, if any. */
  readonly countedBy: 'dashboard-request' | 'this-tray' | 'nobody'
  /** Set when nothing was opened. Absent when the click worked. */
  readonly reason?: TrayUnavailableReason
}

/**
 * Only the two counting methods, narrowed from HC-6's recorder.
 *
 * Named as a `Pick` rather than as a new interface so it cannot drift from the
 * recorder, and narrowed rather than taken whole so holding a tray grants nothing but
 * the two counters NT-FR-07 needs: no log read, no session, no event, no way to write
 * anything a dashboard open does not write (APX-CON-08).
 */
export type TrayDeepLinkCounters = Pick<
  MetricsRecorder,
  'recordDashboardOpen' | 'recordDeepLinkOpen'
>

export interface CreateHubTrayOptions {
  /** The platform half. See `TrayBridge`. */
  readonly bridge: TrayBridge
  /**
   * The hub's own pending read.
   *
   * The accessor `GET /api/pending` serves and the restart replay reads, injected
   * rather than reached for, so the tray holds no store and no database handle: one
   * source of truth for the number, three readers of it, and a tray that cannot be
   * handed a writer (NT-FR-05, APX-CON-08).
   */
  readonly readPending: () => readonly PendingItem[]
  /**
   * The change feed's subscribe, so the badge follows the pending set.
   *
   * Absent is a tray that is present and correct at mount and follows nothing, which
   * is a degraded answer rather than a broken one. A headless run has no desktop to
   * update, and a caller that has a feed passes this in - which is what the
   * composition root does.
   */
  readonly subscribe?: (subscriber: StreamSubscriber) => () => void
  /**
   * The hub's live loopback origin, read when a link is built.
   *
   * A thunk because the socket is bound after the objects above exist, and an empty
   * string is the honest answer before it is: no link is built from a port that was
   * only a preference, because that would send a developer to whatever else on this
   * machine answers there (HC-FR-01, NT-FR-07).
   */
  readonly origin: () => string
  /** HC-6's two counters, narrowed. See `TrayDeepLinkCounters`. */
  readonly counters: TrayDeepLinkCounters
  /**
   * The hub's ordered shutdown, for the quit action.
   *
   * Not a `process.exit` and not an Electron `app.quit`: the same path a signal takes,
   * so a quit from the tray and a `systemctl stop` are not two shutdown
   * implementations (HC-FR-10).
   */
  readonly quit: () => void
  /** Reports a diagnostic line. Never called with content, a path or a token. */
  readonly onDiagnostic?: (message: string) => void
}

/**
 * A mounted tray.
 *
 * The surface is closed and asserted by name, because the absence of a suppression
 * control is a requirement and not an omission (NT-FR-06). There is no `dismiss`, no
 * `mute`, no `snooze`, no `clear` and no `acknowledge` here, and no method that can
 * mark anything dealt with: the one mutation a client can reach in this product is
 * the ack route (APX-CON-08), and a tray that could reach it would be a second one.
 */
export interface HubTray {
  /** True while the icon is on the desktop. False after `close`. */
  readonly mounted: boolean
  /** The menu as it was put on the desktop: exactly `TRAY_MENU_ITEMS`. */
  menuItems(): readonly TrayMenuItem[]
  /** The badge as it was last decided. Never null: a tray starts at no badge. */
  badge(): BadgeDecision
  /** The last icon handed to the bridge, or null before the first badge decision. */
  icon(): TrayIcon | null
  /** The pending count the badge was decided from, or null if it was never read. */
  pendingCount(): number | null
  /** Re-read the pending set and redraw if the badge changed. Returns the decision. */
  refresh(): BadgeDecision
  /**
   * What a click on the icon does, and what the open-dashboard menu item does.
   *
   * One operation, reached two ways, on purpose: NT-FR-07 makes the toast's link and
   * the tray's click the same promise - open the dashboard on that session - and two
   * implementations of one promise are two things to keep in step.
   */
  activate(): TrayActivation
  /** Route a menu selection. `quit` runs the ordered shutdown and reports nothing. */
  select(id: TrayMenuItemId): TrayActivation | null
  /** Take the icon off the desktop and stop following the pending set. Idempotent. */
  close(): void
}

/**
 * Mount the tray.
 *
 * Synchronous and immediate: the icon is on the desktop and showing the current
 * pending count before this returns, so a caller that mounts a tray has a tray rather
 * than a plan for one. The order inside is the order that fails usefully - read,
 * draw, put the icon up, put the menu on it, register the click, subscribe - and the
 * one failure that can leave something behind (the bridge refusing after the first
 * `showIcon`) is undone before the throw leaves, so a caller never has to clean up a
 * half-mounted tray.
 */
export function createHubTray(options: CreateHubTrayOptions): HubTray {
  const diagnostic = options.onDiagnostic ?? ((): void => {})
  let present = true
  let unsubscribe: (() => void) | null = null
  let lastBadge: BadgeDecision | null = null
  let lastIcon: TrayIcon | null = null
  let lastCount: number | null = null

  /**
   * Re-read the pending set and redraw if the badge changed.
   *
   * The decision is remembered so a redraw happens only when the badge moves: an icon
   * repainted on every stored event would repaint the same pixels on a quiet
   * repository, and a tray that repaints is a tray a desktop cannot cache.
   */
  const redraw = (): BadgeDecision => {
    const pending = options.readPending()
    const badge = badgeForPending(pending)
    lastCount = badge.count
    const unchanged =
      lastBadge !== null && lastBadge.kind === badge.kind && lastBadge.count === badge.count
    if (unchanged) return badge
    const icon = drawTrayIcon(badge)
    lastBadge = badge
    lastIcon = icon
    options.bridge.showIcon(icon)
    return badge
  }

  /**
   * Follow the pending set, and never let a failure cost the badge.
   *
   * Reached from the change feed, inside a transition the store has already applied.
   * A throw here would be caught by the feed's own client guard, which *unsubscribes*
   * this tray - a badge frozen on a stale number for the rest of the run, silently. So
   * the read is guarded, the fault is reported, and the last good number stays on the
   * icon (APX-FR-02).
   */
  const follow = (): BadgeDecision => {
    if (!present) return lastBadge ?? badgeForPending([])
    try {
      return redraw()
    } catch (cause) {
      diagnostic(
        'tray: the pending set could not be read, so the badge still shows the last count it could ' +
          `read (${lastCount === null ? 'none yet' : String(lastCount)}). The hub reports the same ` +
          `fault on health, and nothing about the pending set has changed (APX-FR-02). ${describe(cause)}`,
      )
      return lastBadge ?? badgeForPending([])
    }
  }

  /**
   * The session a click focuses: the oldest outstanding one.
   *
   * `readPending` is ordered oldest-first by the store's own statement
   * (src/storage/eventStore.ts), so the first row is the block that has been waiting
   * longest - the same rule, and for the same reason, as the restart replay's ordering
   * (src/hub/delivery.ts).
   *
   * A read that fails answers null, which makes the click the plain dashboard: a
   * developer who clicks gets the dashboard, which is what the row promised, rather
   * than a session that might be the wrong one or an error they cannot act on. The
   * fault is reported rather than swallowed, because a click that quietly lost its
   * target is not a click that worked - and the badge path reports the same fault
   * separately, since it is a different fact (APX-FR-02).
   */
  const focusedSessionId = (): string | null => {
    try {
      return options.readPending()[0]?.sessionId ?? null
    } catch (cause) {
      diagnostic(
        'tray: the pending set could not be read, so this click opens the dashboard without ' +
          `focusing a session. The badge reports the same fault (APX-FR-02). ${describe(cause)}`,
      )
      return null
    }
  }

  /**
   * Resolve the dashboard deep link and open it.
   *
   * The whole of the click, in the order the failure has to be discovered in. No
   * origin means no honest link, so nothing is handed over and nothing is counted. A
   * link is built from the live origin and the oldest outstanding session - or from
   * the origin alone when nothing is outstanding - and the bridge answers which of
   * the three counting cases it is in, because only it knows whether a document
   * request will follow.
   */
  const openDashboard = (): TrayActivation => {
    const origin = options.origin()
    const sessionId = focusedSessionId()
    const url = sessionId === null ? dashboardUrl(origin) : deepLinkFor(origin, sessionId)
    if (url === null) {
      // Before the socket is bound, or after it was released. There is no other origin
      // this product may use, so the answer is a reported fault and a click that
      // opened nothing and counted nothing.
      diagnostic(
        'tray: a click could not be resolved because this hub has no live loopback origin, so ' +
          'nothing was opened and no open was counted. The dashboard is still reachable at the port ' +
          'in the runtime file (HC-FR-01, NT-FR-07).',
      )
      return { url: null, target: 'none', countedBy: 'nobody', reason: 'no-live-origin' }
    }
    const target: DeepLinkTarget = sessionId === null ? 'dashboard' : 'deep-link'
    let dispatch: DeepLinkDispatch
    try {
      dispatch = options.bridge.openDashboard(url)
    } catch (cause) {
      diagnostic(
        'tray: the desktop could not open the dashboard, so nothing was opened and no open was ' +
          `counted (NT-FR-07, APX-FR-02). ${describe(cause)}`,
      )
      return { url, target, countedBy: 'nobody', reason: 'bridge-threw' }
    }
    if (dispatch.kind === 'unavailable') {
      diagnostic(
        `tray: the desktop reported it could not open the dashboard (${dispatch.reason}), so nothing ` +
          'was opened and no open was counted. The pending set is unchanged and the badge still shows ' +
          'it (APX-FR-02).',
      )
      return { url, target, countedBy: 'nobody', reason: dispatch.reason }
    }
    if (dispatch.kind === 'resolved-without-request') {
      // Nobody else is going to count this one, and an open counted nowhere is the
      // silent version of the failure this product forbids. The counting rule is
      // HC-6's and lives in src/hub/metrics.ts, because that module is the only one
      // allowed to call a counter write; the tray decides *that* this open needs
      // recording and asks that module *how*.
      recordOpenWithoutRequest(options.counters, target)
      return { url, target, countedBy: 'this-tray' }
    }
    // The document request that follows is counted by the route that serves it, which
    // is the same handler that counts any dashboard a person pulled up themselves
    // (HC-6). Counting here as well would report one pull twice.
    return { url, target, countedBy: 'dashboard-request' }
  }

  /**
   * Route a menu selection, by id.
   *
   * The only place a menu row becomes an action, which is what makes "exactly two
   * actions" a routing fact as well as a table fact: a row that is not in the union
   * cannot be dispatched, so a third row would be a compile error rather than a
   * control nobody wired up.
   */
  const selectMenuItem = (id: TrayMenuItemId): TrayActivation | null => {
    if (id === 'open-dashboard') return openDashboard()
    options.quit()
    return null
  }

  let mountedIcon: TrayIcon
  try {
    // The first read is the one that can fail for a reason a developer must know
    // about, so it propagates: a hub that could not draw its icon has not mounted a
    // tray, and the composition root reports that as a fault rather than pretending a
    // tray is there (APX-FR-02).
    redraw()
    mountedIcon = lastIcon ?? drawTrayIcon(badgeForPending([]))
    options.bridge.showMenu({ items: TRAY_MENU_ITEMS, select: selectMenuItem })
    options.bridge.onActivate(openDashboard)
    if (options.subscribe !== undefined) {
      // Subscribed after the first read, so a transition landing between the two can
      // neither be missed nor double counted: the read either happened before the frame
      // or after it, and a frame after the read triggers another read.
      unsubscribe = options.subscribe({
        onFrame: (): void => {
          follow()
        },
        // A heartbeat is a keepalive, not a change: re-reading on one would be polling
        // with extra steps (src/hub/sse.ts).
        onHeartbeat: (): void => undefined,
        onClose: (): void => {
          // The feed is closing, so the hub is shutting down and the log is about to
          // be closed. Nothing is read here on purpose: a read now would either fail
          // or, worse, succeed and redraw an icon for a hub that is already stopping.
          present = false
        },
      })
    }
  } catch (cause) {
    // Undo what the bridge was already given, so a caller that catches this has
    // nothing on the desktop and no subscription. The pending set and the log are
    // untouched either way: a tray that could not be mounted is a missing icon, never
    // a lost block (ADR-010).
    present = false
    try {
      options.bridge.destroy()
    } catch {
      // The failure being reported is the one that caused this cleanup.
    }
    throw new Error(
      'the tray could not be mounted: ' +
        `${describe(cause)} The icon was taken back down, the pending set is unchanged, and the hub ` +
        'is serving (NT-FR-05, APX-FR-02).',
    )
  }

  return {
    get mounted(): boolean {
      return present
    },

    menuItems: (): readonly TrayMenuItem[] => TRAY_MENU_ITEMS,

    badge: (): BadgeDecision => lastBadge ?? badgeForPending([]),

    icon: (): TrayIcon | null => lastIcon ?? mountedIcon,

    pendingCount: (): number | null => lastCount,

    refresh: follow,

    activate: openDashboard,

    select: selectMenuItem,

    close: (): void => {
      // Idempotent, and in this order: stop following first, so no read can arrive
      // after the log is closed, and only then take the icon away. A bridge whose
      // destroy throws must still have been unsubscribed, because the subscription is
      // what would otherwise reach a closed store.
      if (!present && unsubscribe === null) return
      present = false
      const stop = unsubscribe
      unsubscribe = null
      if (stop !== null) {
        try {
          stop()
        } catch (cause) {
          diagnostic(`tray: the state feed could not be unsubscribed cleanly. ${describe(cause)}`)
        }
      }
      try {
        options.bridge.destroy()
      } catch (cause) {
        diagnostic(
          'tray: the icon could not be taken off the desktop, so this process is ending with a tray ' +
            `icon still on screen and nobody behind it (APX-FR-02). ${describe(cause)}`,
        )
      }
    },
  }
}

/**
 * The dashboard's own URL, with no session on it.
 *
 * Null before the socket is bound, for the same reason `deepLinkFor` is: a link built
 * from a port that was only a preference points at whatever else answers on this
 * machine (HC-FR-01). It is not a deep link and is never counted as one - an empty
 * `?session=` is explicitly not a deep link (src/hub/metrics.ts), which is the same
 * rule seen from the counting side.
 */
function dashboardUrl(origin: string): string | null {
  const trimmed = origin.trim().replace(/\/+$/, '')
  return trimmed === '' ? null : `${trimmed}/`
}

/**
 * A fault, as one line.
 *
 * The message only, never a stack and never a value read out of the log: a diagnostic
 * line is somewhere an operator reads, and this product's records carry no content to
 * quote (APX-FR-01).
 */
function describe(cause: unknown): string {
  if (cause instanceof Error) return `The reason was: ${cause.message}`
  return `The reason was: ${String(cause)}`
}
