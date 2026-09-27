// The notification surface's host interface: what this product needs a desktop to be
// able to do, and nothing about how any desktop does it (NT-FR-02, NT-FR-03, NT-FR-04,
// NT-FR-10, ADR-012).
//
// WHY THIS FILE IMPORTS NOTHING
// There is no import statement in this file, and that is the load-bearing property, not
// an accident of tidiness. Every other part of the surface path can then be built and
// tested on a machine with no display, no window manager and no Electron binary, and the
// only thing that has to exist for tests/notify/surface-host.test.ts to run is the
// product's own contract. The real Electron implementation lives one file over, in
// ./electron-host.ts, and it is the only file in this directory that may name Electron -
// a fact tests/notify/surface-host.test.ts asserts by reading this file's source rather
// than by trusting this comment.
//
// WHAT THE INTERFACE IS, AND WHAT IT DELIBERATELY IS NOT
// Five operations: probe, show, hide, set click-through, destroy. Each one is something
// the hub genuinely does, and each one is something only a window system can do. There is
// no "move", no "set opacity", no "make it beep", no "request permission", and no way to
// ask the host to hand a window to somebody else - because every one of those would be a
// second place a decision about the developer's attention could be made (ADR-004,
// NT-FR-08, APX-CON-08).
//
// `setClickThrough` takes a boolean rather than being split into `ignoreMouse` and
// `acceptMouse`, and the reason is in the name of the boolean: click-through is a
// two-way switch, and an interface with two methods invites an implementation that
// forgets to answer the second one. A card that is always click-through can never be
// clicked; a card that is never click-through swallows the clicks meant for the window
// underneath it. Both are real defects and both are prevented by one boolean.
//
// THE CARD IS NOT PART OF THIS CONTRACT
// `show` takes a placement, not content. What a card *says* is NT-7's (src/notify/
// surface/card.ts) and how long it lives is NT-7's (./lifetime.ts); the host's whole job
// is to own a window, put it in the right place, and take it away again. Keeping content
// out of this file is what stops a window host from becoming a second place a card is
// assembled - and this product has exactly one, and it is not here.
//
// NO TELEMETRY, NO SOUND, NO PLATFORM NOTIFICATION
// Nothing in this interface can send anything anywhere. There is no network operation, no
// sound, and no method that reaches a notification service; the loopback hub the card
// document is served from is the only socket in the whole surface path, and it is
// 127.0.0.1 (APX-CON-12, APX-CON-04, NT-FR-02, NT-FR-11).
//
// THE ONE IMPORT
// One, and it is a type-only import of this product's own geometry from ./position.ts -
// re-exported below so a caller needs one module for the whole contract. There is no
// Electron import anywhere in this file, which is the property
// tests/notify/surface-host.test.ts asserts from its source rather than from this
// comment.

import type { SurfaceCorner } from './position.js'

/**
 * Where in the display's usable area a card is placed.
 *
 * Re-exported from ./position.ts rather than restated, so the interface and the geometry
 * cannot disagree about what a corner is, and so the type is not written down twice.
 */
export type { SurfaceCorner } from './position.js'

/**
 * Why the surface host is or is not available.
 *
 * `available` is the only positive answer, and the rest name the way it stopped being
 * available. They are values rather than throws because a hub that cannot draw a card
 * must still serve, and a health payload and a `doctor` line have to be able to say
 * *which* of these it was (APX-FR-02, NT-FR-09, ADR-010).
 */
export type SurfaceAvailabilityReason =
  /** The window exists and can be shown. */
  | 'available'
  /** No host was mounted: a headless run, or a run whose desktop bridge carried no surface. */
  | 'not-mounted'
  /** The desktop refused to create the window. */
  | 'window-refused'
  /** The window was created and has since been destroyed. */
  | 'window-destroyed'
  /** The card document could not be read over the loopback hub. */
  | 'document-unavailable'

/** What a reachability probe found about the surface. A probe reports; it never shows. */
export interface SurfaceAvailability {
  readonly available: boolean
  readonly reason: SurfaceAvailabilityReason
  /** One bounded line, when there is something to say. Diagnostics only; never persisted. */
  readonly detail?: string
}

/**
 * Everything the host is told about a card it has been asked to show.
 *
 * Placement only. There is no title, no body, no urgency and no deep link here, because
 * this file must not be a place a card is assembled and because the card document the
 * window loads is the same document every card is rendered into (NT-7).
 */
export interface SurfaceCardRequest {
  /** Which corner of the work area to place the card at. Defaults to top-right. */
  readonly corner?: SurfaceCorner
  /**
   * Whether the card is click-through once it is on screen.
   *
   * Defaults to true, matching NT-FR-04: a card is invisible to the pointer until the
   * pointer reaches it, and the host takes click-through back when that happens.
   */
  readonly clickThrough?: boolean
}

/**
 * The surface host: one always-on-top, frameless, transparent window this product
 * creates, owns, positions and destroys.
 *
 * There is no implementation of this interface in this file, and no import that could
 * bring one in. The seam is the point: a test drives the product's decisions over this
 * interface on a machine with no display, and the real window behind it is the only part
 * that needs a desktop to check (NT-FR-04).
 */
export interface NotificationSurfaceHost {
  /**
   * Report whether a card can be shown right now.
   *
   * Never shows one, and never creates a window as a side effect: a probe that flashed a
   * card would be an interruption caused by asking whether an interruption is possible.
   */
  probe(): Promise<SurfaceAvailability>

  /**
   * Place and show one card, without taking keyboard focus from whatever the developer
   * is doing.
   *
   * Idempotent per card: showing while a card is already showing re-places it and leaves
   * it showing rather than stacking a second window. Never throws for a desktop that
   * cannot do it - it resolves, and `probe` then reports why - because the caller is the
   * delivery path and an exception here would be a swallowed block (APX-FR-02).
   */
  show(card?: SurfaceCardRequest): Promise<SurfaceAvailability>

  /**
   * Take the card off the screen.
   *
   * This is NT-FR-10's requirement in one call: the host window may keep existing -
   * Electron owns its lifetime, and destroying and recreating a window per card is a
   * visible flash on some compositors - but it draws nothing and occupies no screen
   * space. Idempotent.
   */
  hide(): void

  /**
   * Take click-through, or give it back.
   *
   * A boolean and not two methods, because it is one switch. `true` means the window
   * ignores the pointer (and forwards what the pointer does to the window underneath, so
   * the developer never has to hunt for it); `false` means the card can be clicked.
   */
  setClickThrough(clickThrough: boolean): void

  /**
   * Destroy the window for good.
   *
   * Reached from the hub's ordered shutdown before the listener closes, so a card cannot
   * outlive the hub that promised it. Idempotent, and a host that was never created
   * answers it without doing anything (NT-FR-04, HC-FR-10).
   */
  destroy(): void
}

/**
 * What the composition root is told when it mounts a surface.
 *
 * The live origin is a *thunk*, not a string, and that is load-bearing rather than
 * defensive: the host is mounted before the loopback socket is bound - it has to be, so
 * that a desktop which refuses the window is known before any delivery is wired - and
 * the port only exists afterwards. Reading the origin at show time is what makes a card
 * load from this hub rather than from a preferred port nobody is listening on.
 */
export interface CreateSurfaceHostOptions {
  /** The hub's live loopback origin, read when the card document is loaded. */
  readonly origin: () => string
  /** The corner every card is placed at unless a show says otherwise. */
  readonly corner?: SurfaceCorner
}

/**
 * The desktop's surface, as this product's one operation.
 *
 * Exactly the shape of the tray's `TrayBridge`, and for the same reason: the desktop
 * supplies the platform object and this product supplies every decision about what to do
 * with it. Asking the desktop to mount a window would make the platform the owner of
 * whether a card appears, which is the decision ADR-004 and this feature are about.
 *
 * `create` throws `SurfaceWindowRefusedError` when the desktop will not give a window.
 * That is the one failure path, and the composition root's whole answer to it is: a
 * diagnostic, a running hub, and no delivery reported as shown.
 */
export interface SurfaceHostBridge {
  create(options: CreateSurfaceHostOptions): NotificationSurfaceHost
}

/**
 * A refusal to create the window, as a typed error rather than a string.
 *
 * A desktop that refuses - a compositor that will not give a transparent frameless
 * window, a session with no window manager at all - is a supported run, not a crash: the
 * hub keeps serving, the diagnostic says what happened, and every delivery is recorded as
 * `not-wired` so nothing was reported as shown that nobody saw (NT-FR-04, APX-FR-02,
 * ADR-010). The type exists so the composition root can tell a refusal from any other
 * failure and say which it was.
 */
export class SurfaceWindowRefusedError extends Error {
  readonly reason: 'window-refused'

  constructor(detail: string) {
    super(
      `the desktop refused to create the notification surface window: ${detail}. The hub is ` +
        'unaffected - the pending set, the log and the badge are unchanged - and every delivery is ' +
        'recorded as not-wired rather than as something somebody saw (NT-FR-04, APX-FR-02).',
    )
    this.name = 'SurfaceWindowRefusedError'
    this.reason = 'window-refused'
  }
}
