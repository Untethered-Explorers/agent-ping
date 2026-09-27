// The card document's one entry module: it mounts the product's own card view on this
// document and gets out of the way (NT-FR-02, NT-FR-12, ADR-012).
//
// WHAT THIS FILE IS, AND WHAT IT IS NOT
// It is the composition root of the card document - the page the notification surface's
// window loads over the hub's loopback origin at `/card.html` (SURFACE_DOCUMENT_PATH in
// src/notify/surface/electron-host.ts). It does three things and stops:
//
//   1. finds the document's own surface element,
//   2. hands it to `createCardView`, this product's own view, imported from
//      src/notify/surface/card-view.ts, and
//   3. exports the mounted view so whoever is allowed to call it can.
//
// Everything a card *is* - the two lines, the urgency icon and word, the live-region
// role, the reduced-motion attribute, the one clock and the five named ends - lives in
// src/notify/surface/card-view.ts and src/notify/surface/lifetime.ts. Nothing is
// re-decided here, because a second copy of the card's rules is a second card (NT-FR-02).
//
// THE VIEW IS IMPORTED FROM TYPESCRIPT SOURCE, NOT COPIED OUT OF dist/main
// The import is `@/notify/surface/card-view`, through the same `@` alias
// vite.config.ts declares for the renderer. The alternative - importing
// `dist/main/notify/surface/card-view.js`, the module the Electron main process
// compiles - would mean a file copied from one build's output into another build's
// input, so the same module is compiled twice from two sources that could disagree and
// a stale copy ships silently. One source, two builds, no copy step:
// tests/dashboard/card-document.test.ts asserts the import closure of this file and that
// nothing in the build reads `dist/main`.
//
// THE CLOSURE IS BROWSER-SAFE, AND THAT IS ASSERTED RATHER THAN ASSUMED
// This module runs in a renderer with `contextIsolation: true`, `nodeIntegration: false`
// and `sandbox: true`, where a `node:` import is not a slower module - it is a page that
// fails to load, and it would fail on a developer's screen rather than in a build. The
// closure this file reaches is therefore checked in the same test: three modules, no
// `node:` import, no subprocess, no filesystem.
//
// THE CHANNEL IS THIS PRODUCT'S OWN, AND IT IS THE ONLY WAY IN (NS-2)
// The surface window's `webPreferences` name a preload (SURFACE_WINDOW_OPTIONS in
// src/notify/surface/electron-host.ts), and that preload exposes exactly two calls on one
// global: `show(model, cell)` and `remove(end)`. This entry installs the document's end
// of that channel with `listenForCardSurface`, which listens for the two messages the
// preload hands over and calls this product's own view.
//
// Three things this file deliberately does not do:
//   - it does not name `window`, `ipcRenderer` or any privileged global. The channel
//     module reaches the target itself, so this entry names no global at all;
//   - it does not build the card. `createCardView` is the view, and it is the sink the
//     channel calls - `CardView` already carries exactly `show` and `remove`, which is why
//     the channel's sink needs nothing more from it;
//   - it does not acknowledge anything. Acknowledging a block is a hub concern whose
//     destination is the dashboard, and the signal belongs on a dismissal port rather
//     than on the card window (NT-FR-12's third clause, and NS-2 excluded it).
//
// A card document with the channel installed and no card delivered still draws nothing
// and occupies no screen space, which is NT-FR-10's promise and the reason an inert
// document is not a defect.

import { createCardView, type CardElement, type CardView } from '@/notify/surface/card-view'
import { listenForCardSurface } from '@/notify/surface/channel'

/**
 * The element cards are put inside.
 *
 * One name, in the document, in this module and in
 * scripts/verify-notification-surface.mjs, so "where does a card go" has one answer
 * rather than three that can drift. It is read from the document rather than created
 * here, because the document is this product's and a card document whose own markup
 * were replaced at run time would be a second document.
 */
export const CARD_SURFACE_ATTRIBUTE = 'data-card-surface'

/** What `mountCardDocument` needs. Both are for a test; the page has neither. */
export interface MountCardDocumentOptions {
  /** The element a card is put inside. Defaults to this document's own surface. */
  readonly parent?: CardElement
  /** The document the surface is read from. Defaults to this document. */
  readonly document?: Document
}

/**
 * Mount the card view on a surface element, and return the mounted view.
 *
 * A named export so a test can mount it against a surface it built, in the same way
 * src/dashboard/main.ts exports `mountDashboard` for the live page. It throws when there
 * is no surface to mount on rather than returning a view that can never show a card: a
 * card document whose own markup has changed is a defect in the document, and a view
 * that quietly cannot render would report it as a card that never arrived.
 */
export function mountCardDocument(options: MountCardDocumentOptions = {}): CardView {
  const doc = options.document ?? document
  // Typed as `HTMLElement` because that is what the surface is: an element the view can
  // append to, take a card out of and focus. `CardElement` is the structural slice of
  // exactly that, and a real element satisfies it (src/notify/surface/card-view.ts).
  const parent: CardElement | null =
    options.parent ?? doc.querySelector<HTMLElement>(`[${CARD_SURFACE_ATTRIBUTE}]`)
  if (parent === null) {
    throw new Error(
      `the card document has no [${CARD_SURFACE_ATTRIBUTE}] element, so a card has nowhere to be ` +
        'drawn. card.html declares it, and a card document without one is a broken document rather ' +
        'than an empty one (NT-FR-02).',
    )
  }
  return createCardView({ parent })
}

// ---------------------------------------------------------------------------
// Page composition root
// ---------------------------------------------------------------------------

/**
 * The view this document mounted, or `null` when there is no surface to mount on.
 *
 * Mounted on load, following the same rule as the live page's and the prototype's entry
 * points (src/dashboard/main.ts, src/dashboard/prototype/main.ts): importing this module
 * in a test to call `mountCardDocument` directly finds no surface in that document and
 * therefore mounts nothing on import, so a test controls when the view exists.
 */
export const cardDocumentView: CardView | null =
  document.querySelector(`[${CARD_SURFACE_ATTRIBUTE}]`) === null
    ? null
    : mountCardDocument()

/**
 * Take the card document's end of the channel down again, or `null` when there was no
 * view to attach it to.
 *
 * Exported rather than kept private because a document that is torn down has to stop
 * listening, and a listener left on a window that is going away is a closure this product
 * can no longer account for (APX-FR-02). A page that is never torn down simply never
 * calls it, which is the normal case: the surface window exists for the life of the hub
 * and is destroyed with it (NT-FR-04).
 */
export const stopCardDocumentChannel: (() => void) | null =
  cardDocumentView === null ? null : listenForCardSurface(cardDocumentView)
