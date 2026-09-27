// The card surface's preload: the only code in this product that runs inside the card
// document's renderer, and the only file that may `require('electron')` (NT-FR-02,
// NT-FR-12, ADR-012).
//
// THIS IS THE BODY. `./preload.ts` is its address - the source tsc compiles, the `.cjs` it
// emits, and the path `SURFACE_WINDOW_OPTIONS.webPreferences.preload` carries - so the two
// halves of one preload are two files, and `tests/notify/surface-channel.test.ts` asserts
// that they agree. If you are looking for "which preload is this window running", that is
// the other file; if you are looking for what it does, this is it.
//
// WHY THIS FILE IS `.cts` AND NOT `.ts`, AND WHY IT IS A SINGLE FILE
// Both answers were measured against the real Electron 44.4.5 binary on the authoring
// machine (Ubuntu 24.04, X11 :1), driving a real `BrowserWindow` with this product's
// own `SURFACE_WINDOW_OPTIONS`, and both are the reason a plain `preload.ts` cannot be
// the answer:
//
//   1. A preload in a renderer with `sandbox: true` has no ESM context. Chromium parses
//      the file as a plain script: a `.mjs` preload and a `.js` preload containing
//      `import` both fail with `SyntaxError: Cannot use import statement outside a
//      module`, and no `preload-error` is the only trace. This repository's
//      `tsconfig.json` sets `"moduleDetection": "force"`, so tsc emits a module marker
//      into *every* file it compiles - `export {};` - which is exactly the syntax that
//      fails. A `.cts` source is always compiled to CommonJS regardless of that setting,
//      which is why this file's extension is the decision it is.
//   2. A sandboxed preload's `require` is a polyfill. It resolves `electron`, `events`,
//      `timers`, `url` and their `node:` forms, and nothing else: `require('./x')` fails
//      with `module not found`. So this file cannot `require('../channel.js')`, cannot
//      `import` anything at run time, and cannot be split. The names below are the only
//      copy of the channel's vocabulary outside src/notify/surface/channel.ts, and
//      tests/notify/surface-channel.test.ts asserts the two are byte-identical and that
//      the surface this file exposes is exactly `remove` and `show`. A copy is the
//      price of the platform; an unasserted copy would not be.
//
// WHAT THIS FILE DOES, IN ORDER
//   1. listens for the two messages the main process sends,
//   2. turns each into a call on the two-call surface,
//   3. hands that surface to the document through `contextBridge`, and
//   4. announces, once, that the surface is listening.
//
// The surface is exposed as an object literal passed straight to
// `exposeInMainWorld`, and the two operations are named the same string on both sides of
// the world boundary: as the ipc channel the main process sends on, and as the DOM event
// this file dispatches for the document to hear. A function defined here runs in *this*
// world and cannot call a function the document defined - the DOM is the one thing the
// two worlds share - so a call has to become an event to arrive. That was verified
// against the real binary: a `CustomEvent` dispatched from this file is received by the
// card document's own `window` listener, and the page still has neither `process` nor
// `require`.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO
//   - It validates nothing. A value crosses here from this product's own main process,
//     which validates it with `cardChannelShow` before sending, and the document
//     re-validates it with `readCardChannelShow` before rendering. Two validations, one
//     implementation, and this file is the pipe between them. Validating a third time
//     here would mean a third copy of the rules, in the one file that cannot share them.
//   - It exposes nothing else. No `ipcRenderer`, no `require`, no `process`, no
//     `openExternal`, no `executeJavaScript`, no `webSecurity` change, no `webFrame`, no
//     Node built-in. A document that can be handed a second global is a document whose
//     privileges are decided by a list (NT-FR-12, APX-FR-01).
//   - It refuses nothing and throws nothing. A preload that raised would leave the
//     document with no channel at all and every delivery would be `not-wired` for a
//     reason nobody could see. The key set is enforced by a test, which runs on every
//     change, rather than by a runtime check that turns a small mistake into no cards.
//   - It sends nothing about a card. The one message it sends is the `ready`
//     announcement, it carries no payload, and it is the reason a `send` to a document
//     that has not finished loading is a reported failure rather than a card that never
//     arrived (APX-FR-02).
//
// NO TELEMETRY, NO SOUND, NO PLATFORM NOTIFICATION
// Nothing here opens a socket, plays a sound, spawns anything or reaches a notification
// service. The only two things that cross this boundary are a five-field model and a
// closed token, and both were content-free before they got here (APX-CON-12, APX-FR-01,
// NT-FR-02, NT-FR-11).

// Type-only, and therefore erased: this is the contract the two functions below are
// checked against, which is worth having and costs nothing at run time. A *value*
// import would be erased too but would be a lie about what the file needs.
import type { CardModel } from './card.js'
import type { CardEnd, CardLifetimeCell } from './lifetime.js'

// The runtime module, through the sandboxed preload's polyfilled `require`. This is the
// one `require` in this product's renderer, and it is the reason the whole file exists.
const { contextBridge, ipcRenderer } = require('electron')

// ---------------------------------------------------------------------------
// The channel's vocabulary, restated. Asserted equal to channel.ts by a test.
// ---------------------------------------------------------------------------

/** The one global this file puts on the document's window. */
const CARD_SURFACE_GLOBAL = 'agentPingCardSurface'
/** Show a card: the one message that carries a model. */
const CARD_CHANNEL_SHOW = 'agent-ping:card-surface:show'
/** Take a card off the screen, naming the end. */
const CARD_CHANNEL_REMOVE = 'agent-ping:card-surface:remove'
/** The document's channel is listening. Carries nothing. */
const CARD_CHANNEL_READY = 'agent-ping:card-surface:ready'

// ---------------------------------------------------------------------------
// The world this file runs in, declared rather than imported
// ---------------------------------------------------------------------------

/** An event, as far as this file dispatches one. */
interface PreloadEventLike {
  readonly type: string
  readonly detail?: unknown
}

/** The `CustomEvent` constructor the renderer provides, as this file uses it. */
interface CustomEventLikeConstructor {
  new (type: string, options?: { readonly detail?: unknown }): PreloadEventLike
}

/**
 * The renderer global, as far as this file uses it: something to dispatch on, and the
 * `CustomEvent` constructor that makes the thing to dispatch.
 *
 * Declared here because `tsconfig.build.json` compiles `src/notify/**` with
 * `lib: ["ES2023"]` and no DOM library - the Electron main process must not have a
 * `document` in scope - so `window` and `CustomEvent` are not types this build can
 * depend on. A real renderer has both, and the structural declaration is satisfied by
 * the browser's own objects for the same reason ./card-view.ts declares its own DOM
 * (APX-CON-07).
 */
interface PreloadGlobalLike {
  dispatchEvent(event: PreloadEventLike): boolean
  CustomEvent?: CustomEventLikeConstructor
}

const preloadGlobal = globalThis as unknown as PreloadGlobalLike

/**
 * Hand one message to the card document.
 *
 * Throws rather than dropping a message if this environment cannot make an event: the
 * renderer this product runs on always has `CustomEvent` (verified on Electron
 * 44.4.5), and a channel that cannot speak must say so instead of taking a card
 * silently (APX-FR-02).
 */
function hand(type: string, detail: unknown): void {
  const Event = preloadGlobal.CustomEvent
  if (typeof Event !== 'function') {
    throw new Error(
      'the card surface preload has no CustomEvent in this renderer, so it cannot hand a card to ' +
        'the card document and every delivery will be recorded as not-wired rather than as a card ' +
        'somebody saw (NT-FR-12, APX-FR-02).',
    )
  }
  preloadGlobal.dispatchEvent(new Event(type, { detail }))
}

// ---------------------------------------------------------------------------
// The surface: exactly two calls
// ---------------------------------------------------------------------------

/**
 * The channel, as the document sees it.
 *
 * Two methods, and the object literal is passed to `exposeInMainWorld` unchanged so
 * that what a test reads out of this file's source is what the document received - a
 * wrapper variable would mean the exposed object and the asserted one were two things.
 */
const bridge = {
  /** Put a card on the screen, under the lifetime cell it was sent with. */
  show: (model: CardModel, cell: CardLifetimeCell): void => {
    hand(CARD_CHANNEL_SHOW, { model, cell })
  },
  /** Take the current card off the screen, naming the end that did it. */
  remove: (end: CardEnd): void => {
    hand(CARD_CHANNEL_REMOVE, { end })
  },
}

// A message arriving from the main process becomes a call on that same surface, so there
// is one set of two operations rather than a second path that ought to match it. The
// incoming payload is not validated here and the comment at the top says why: it was
// validated before it was sent, it is validated again before it is rendered, and this
// file is the pipe.
ipcRenderer.on(CARD_CHANNEL_SHOW, (_event: unknown, payload: unknown): void => {
  const message = (payload ?? {}) as { model?: CardModel; cell?: CardLifetimeCell }
  bridge.show(message.model as CardModel, message.cell as CardLifetimeCell)
})

ipcRenderer.on(CARD_CHANNEL_REMOVE, (_event: unknown, payload: unknown): void => {
  const message = (payload ?? {}) as { end?: CardEnd }
  bridge.remove(message.end as CardEnd)
})

// The exposure. One call, one key, one object.
contextBridge.exposeInMainWorld(CARD_SURFACE_GLOBAL, bridge)

// Last, and once: a main process that sends before this line has run would be talking to
// a document nobody is listening in, so the surface announces itself rather than making
// the sender guess. It carries no payload at all.
ipcRenderer.send(CARD_CHANNEL_READY)
