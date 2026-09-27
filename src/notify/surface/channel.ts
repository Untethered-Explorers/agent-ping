// The card surface's channel: the one way a card model reaches a document running under
// `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true` (NT-FR-02,
// NT-FR-12, APX-FR-01, APX-CON-12, ADR-012).
//
// WHAT THIS FILE IS
// The channel's contract, its two payload shapes, the guard that decides whether a
// payload is allowed across, and the two halves of the channel that are pure: the bridge
// a side hands to the other, and the listener the card document installs. It names no
// Electron module and imports nothing outside this product's own surface, so it
// compiles into the Node-hosted main build *and* into the card document's Vite bundle
// from one source (src/notify/surface/preload.cts is the one thing it cannot share,
// and the comment there says why).
//
// WHY A CHANNEL IS A HOLE, AND WHY IT IS THIS SMALL
// `contextIsolation: true` means the card document's JavaScript and this process's
// JavaScript are two worlds. A message between them crosses the boundary in both
// directions, so every value on the wire is a value that has left the main process. The
// whole point of the isolation settings is that the card document is this product's own
// two lines of text and nothing else - so the surface exposed to that document is
// exactly two calls, `show` and `remove`, and the payload is exactly a `CardModel` and
// a `CardLifetimeCell`. A third call, a fifth field or a free string on the wire is a
// hole somebody will eventually put something in (APX-FR-01, ADR-003, ADR-008).
//
// THE TWO ENDS, AND WHY THERE IS NO THIRD
//   main   -> document   the model and the cell. `CARD_CHANNEL_SHOW` / `CARD_CHANNEL_REMOVE`.
//   document -> main     nothing, today. Acknowledging a block is a hub concern, the
//                        destination is the dashboard, and the signal belongs on a
//                        dismissal port rather than on the host window (NT-FR-12's
//                        third clause is the hub's, and this task excluded it). The
//                        one message the document does send is the preload's `ready`
//                        announcement, and the preload sends that - not the document,
//                        and not through the exposed surface.
// A readiness announcement is not a card, and it carries nothing: it exists because
// `webContents.send` to a document that has not finished loading is a message nobody
// receives, and a card that silently never arrived is the exact failure APX-FR-02
// exists to prevent. `CARD_CHANNEL_READY` carries no payload at all.
//
// ONE NAME PER OPERATION, USED ON BOTH SIDES OF THE WORLD BOUNDARY
// `CARD_CHANNEL_SHOW` and `CARD_CHANNEL_REMOVE` are both the ipc channel name the main
// process sends on and the DOM event name the preload dispatches and the document
// listens for. One name, one operation, so there is no second vocabulary to keep in
// step - and the reason an event is involved at all is the isolation boundary itself:
// a function defined in a preload runs in the *preload's* world and cannot call a
// function the document defined. The DOM is the one thing the two worlds share, so it
// is where a call becomes a call. Verified against Electron 44.4.5 on the authoring
// machine: a `CustomEvent` dispatched from a sandboxed preload is received by the
// document's own `window` listener, and the page still has neither `process` nor
// `require`.
//
// WHY THE GUARD EXISTS TWICE, AND WHY IT IS ONE GUARD
// `cardChannelShow` and `readCardChannelShow` are the same rules read twice: once as
// the main process builds what it is about to send, and once as the document decides
// what it is about to render. A guard on only one side would be a guard on the side
// least able to be attacked - the main process built the payload and the document
// renders it, so the document is where a forged or corrupted value would do damage.
// There is no third copy: the preload is deliberately a dumb pipe that moves two values
// and validates nothing, because the value it moves is validated on both ends by this
// module (APX-FR-01, ADR-010).
//
// NO EXECUTEJAVASCRIPT, NO webSecurity, NO LOOPBACK POLL
// The three shapes that would have carried this without a preload are all refused on
// purpose, and a test asserts all three absences across every file under `src`:
//   - `webContents.executeJavaScript` injects code into the document; it needs no
//     boundary at all, which is exactly why it is not used.
//   - `webSecurity: false` and `nodeIntegration: true` widen the renderer to make the
//     channel unnecessary. The renderer settings NT-6 asserted are the reason this
//     product can put a two-line document on a developer's screen at all.
//   - a loopback route the document polls adds a second origin-facing surface, a timer,
//     and a window during which a card is late for no reason (NT-FR-08).
//
// VERIFICATION STATE, STATED THE SAME WAY IN EVERY FILE HERE
// Implemented and unit-tested: the contract, the guard, the bridge and the document
// listener are exercised in this repository with a real jsdom document and the product's
// own `createCardView`, and the end-to-end wiring is exercised through the real
// `startHub` over a real loopback socket with a structural Electron stub. The preload
// itself was driven against the real Electron 44.4.5 binary on the authoring machine
// (Ubuntu 24.04, X11 :1) with the real window options: the global arrived with a key
// set of exactly `remove` and `show`, a card model crossed the boundary and rendered in
// the document with `role="status"` and its lifetime attribute, and a removal emptied
// the surface. What that run cannot say is anything about how the three desktops
// composite the window; nothing here changed a window option (NT-FR-03, APX-CON-06).

import { cardUrgency, type CardModel } from './card.js'
import { CARD_ENDS, cardLifetimeFor, type CardEnd, type CardLifetimeCell } from './lifetime.js'

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * The one global the preload puts on the card document's window.
 *
 * One, and named, because a document that can be handed a second global is a document
 * whose privileges are decided by a list rather than by a name. A test asserts the
 * preload calls `exposeInMainWorld` exactly once, with this string.
 */
export const CARD_SURFACE_GLOBAL = 'agentPingCardSurface'

/**
 * The two calls that global carries. The whole surface, named as data.
 *
 * A test enumerates this list, reads the preload's own exposed object out of its
 * source, and compares - so a third call added to the preload fails a test rather than
 * becoming a capability a card document quietly has.
 */
export const CARD_SURFACE_KEYS = Object.freeze(['remove', 'show'] as const)

/** One of `CARD_SURFACE_KEYS`. */
export type CardSurfaceKey = (typeof CARD_SURFACE_KEYS)[number]

/**
 * The document announcing that the channel is listening.
 *
 * Sent by the preload as it installs the bridge, carries no payload, and exists so a
 * `send` to a document that has not finished loading is a reported failure rather than
 * a card that never arrived. The document does not send it: the document cannot, and
 * should not be able to.
 */
export const CARD_CHANNEL_READY = 'agent-ping:card-surface:ready'

/** Show a card. The one message that carries a model. */
export const CARD_CHANNEL_SHOW = 'agent-ping:card-surface:show'

/** Take the card off the screen, naming the end. The one message that carries a token. */
export const CARD_CHANNEL_REMOVE = 'agent-ping:card-surface:remove'

/** Every channel name this product uses, so a test can enumerate rather than restate. */
export const CARD_CHANNEL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  ready: CARD_CHANNEL_READY,
  show: CARD_CHANNEL_SHOW,
  remove: CARD_CHANNEL_REMOVE,
})

/** The document's own view is the sink: `show`, `remove`, and nothing else it needs. */
export interface CardSurfaceSink {
  show(model: CardModel, cell: CardLifetimeCell): void
  remove(end: CardEnd): void
}

/**
 * The channel as the document sees it: two calls, and a channel that hands over the
 * bridge hands over nothing else.
 *
 * Declared as its own interface rather than reusing `CardSurfaceSink` so that the two
 * roles are named, and a test asserts the two are the same shape - so a change to one
 * that is not a change to the other is a failing test rather than a drift.
 */
export interface CardSurfaceBridge {
  show(model: CardModel, cell: CardLifetimeCell): void
  remove(end: CardEnd): void
}

/** The two things the channel can carry, named as data. */
export const CARD_CHANNEL_PAYLOAD_KEYS = Object.freeze({
  show: Object.freeze(['cell', 'model'] as const),
  remove: Object.freeze(['end'] as const),
})

// ---------------------------------------------------------------------------
// The payload, and the guard
// ---------------------------------------------------------------------------

/** A card on the wire: a model and the lifetime cell it is shown under. */
export interface CardChannelShow {
  readonly model: CardModel
  readonly cell: CardLifetimeCell
}

/** A card leaving: the named end that took it off the screen. */
export interface CardChannelRemove {
  readonly end: CardEnd
}

/**
 * A payload the channel refused.
 *
 * A typed error rather than a string, for the reason `SurfaceWindowRefusedError` is
 * one: the caller is the delivery path, and an error that says *which* rule was broken
 * is recorded in a health payload and a ledger rather than swallowed (APX-FR-02,
 * ADR-010). Nothing in the message is a payload value beyond a field *name*, because a
 * refused value is still something this product must not put in a record.
 */
export class CardChannelPayloadError extends Error {
  readonly reason: 'card-channel-payload-refused'

  constructor(what: string) {
    super(
      `the notification card channel refused a payload: ${what}. Nothing was rendered, nothing ` +
        'was stored, and no value that was refused appears in this message. A channel is a hole ' +
        'in the isolation boundary, so a value that cannot be shown safely is a delivery failure ' +
        'with a reason rather than something a card is built from (APX-FR-01, NT-FR-12, ADR-010).',
    )
    this.name = 'CardChannelPayloadError'
    this.reason = 'card-channel-payload-refused'
  }
}

/** The five fields a `CardModel` carries, and the only five. */
const CARD_MODEL_KEYS = Object.freeze(['body', 'deepLink', 'pendingCount', 'title', 'urgency'] as const)

/** The fields a `CardLifetimeCell` carries, and the only ones. */
const CARD_LIFETIME_KEYS = Object.freeze([
  'class',
  'ends',
  'expiresInMs',
  'lifetime',
  'reason',
  'repeat',
  'rendered',
] as const)

/** The only query parameter a card's deep link may carry, and its only value shape. */
const CARD_DEEP_LINK_QUERY_KEY = 'session'

/**
 * Assert that a model is content-free, and return it frozen.
 *
 * FOUR CHECKS, and each one closes a different hole:
 *
 *   1. the key set is exactly the five fields `CardModel` declares. This is the
 *      structural half of "no session identifier, no harness name, no prompt": a field
 *      carrying one of those cannot be added to a model that crosses the channel,
 *      whatever builds it. `src/notify/surface/card.ts` already refuses a path-shaped
 *      title at build time; the check is repeated here because the two are different
 *      failure modes - one guards the builder, this guards the wire.
 *   2. neither line is a filesystem path, spans lines, or is blank.
 *   3. the count is a count, because a card that printed a number that is not the
 *      outstanding count would be a second, wrong place a count exists (NT-FR-06).
 *   4. the deep link is `null` or a loopback dashboard URL whose *only* query parameter
 *      is `session`. The loopback link is the one place a session identifier appears, it
 *      is built by this product and never read back by it, and a second parameter -
 *      anything a caller might have appended - is refused rather than forwarded
 *      (APX-CON-01, ADR-008).
 *
 * Throws `CardChannelPayloadError`. Callers on the delivery path turn that into a
 * recorded failure; callers in the document turn it into a dropped message and a
 * diagnostic. Neither renders anything.
 */
export function assertContentFreeCardModel(model: CardModel): CardModel {
  if (typeof model !== 'object' || model === null) {
    throw new CardChannelPayloadError('the model is not an object')
  }
  const keys = Object.keys(model).sort()
  if (!sameKeySet(keys, CARD_MODEL_KEYS)) {
    // Field *names* only, and only because a name is a name this product already wrote.
    // A refused *value* never reaches a message, a ledger or a log line.
    throw new CardChannelPayloadError(
      `a card model carried fields other than the five it declares (${keys.join(', ')}); a ` +
        'session identifier, a harness name, a repository path or conversation content has no ' +
        'field to travel in (APX-FR-01, ADR-003)',
    )
  }
  assertSingleLine('title', model.title)
  assertSingleLine('body', model.body)
  if (/[/\\]/.test(model.title)) {
    throw new CardChannelPayloadError(
      "a card model carried a repository path as its title; a card is the repository short name, " +
        'and a path would put a home directory on a screen and in a screenshot of it (APX-FR-01)',
    )
  }
  if (model.title.trim() === '' || model.body.trim() === '') {
    throw new CardChannelPayloadError('a card model carried a blank line')
  }
  if (typeof model.pendingCount !== 'number' || !Number.isInteger(model.pendingCount) || model.pendingCount < 0) {
    throw new CardChannelPayloadError(
      'a card model carried something that is not the number of outstanding blocks (NT-FR-06)',
    )
  }
  if (typeof model.urgency !== 'string') {
    throw new CardChannelPayloadError('a card model carried no urgency token')
  }
  // Throws for an urgency this product has no icon and no word for, which is the same
  // answer on both sides of the boundary: urgency carried by colour alone is not urgency
  // (APX-CON-07).
  cardUrgency(model.urgency)
  assertLoopbackDeepLink(model.deepLink)
  return Object.freeze({ ...model })
}

/**
 * Whether `keys` is exactly `expected`, in any order.
 *
 * Order is not the point - `Object.keys` order is a property of the object, not of the
 * contract - and this is the one place that decides whether a value may cross, so it
 * compares the whole set rather than a count and a prefix.
 */
function sameKeySet(keys: readonly string[], expected: readonly string[]): boolean {
  if (keys.length !== expected.length) return false
  const wanted = [...expected].sort()
  return keys.every((key, index) => key === wanted[index])
}

/** A deep link is `null` or this product's own loopback dashboard URL. Nothing else. */
function assertLoopbackDeepLink(deepLink: string | null): void {
  if (deepLink === null) return
  if (typeof deepLink !== 'string' || !deepLink.startsWith('http://127.0.0.1')) {
    throw new CardChannelPayloadError(
      'a card model carried a deep link that is not on this machine\'s loopback hub; a card whose ' +
        'link is a remote URL is an outbound call on a developer\'s screen (APX-CON-12)',
    )
  }
  let parsed: URL
  try {
    parsed = new URL(deepLink)
  } catch {
    throw new CardChannelPayloadError('a card model carried a deep link that is not a URL')
  }
  for (const key of parsed.searchParams.keys()) {
    if (key !== CARD_DEEP_LINK_QUERY_KEY) {
      throw new CardChannelPayloadError(
        `a card model carried a deep link with a \`${key}\` parameter; the loopback link carries the ` +
          'session and nothing else, because a parameter a caller appended is content this product ' +
          'did not choose to put on a screen (APX-FR-01, ADR-008)',
      )
    }
  }
}

/** One line, no line break, and present. */
function assertSingleLine(field: 'title' | 'body', value: string): void {
  if (typeof value !== 'string' || value === '' || value.includes('\n') || value.includes('\r')) {
    throw new CardChannelPayloadError(
      `a card model carried no usable \`${field}\`; a card is two lines - a repository short name and ` +
        'one sentence - and anything longer is content this product does not put on a screen (APX-FR-01)',
    )
  }
}

/**
 * Assert that a cell is the product's own cell for its class, and return it.
 *
 * The wire carries the cell rather than the class, and this is why that is safe: the
 * receiving side re-derives the cell from `CARD_LIFETIMES` and accepts the message only
 * if the cell it was handed *is* that cell. A value that arrived with a longer
 * `expiresInMs`, an extra end, or `repeat` set to something other than `never` is
 * refused rather than rendered. So the interval a card lives for, the ends that can take
 * it off the screen and the no-repeat rule are not values a message can influence; they
 * are the table (NT-FR-08, ADR-004).
 */
export function assertCanonicalCardLifetime(cell: CardLifetimeCell): CardLifetimeCell {
  if (typeof cell !== 'object' || cell === null) {
    throw new CardChannelPayloadError('the lifetime cell is not an object')
  }
  const keys = Object.keys(cell).sort()
  if (!sameKeySet(keys, CARD_LIFETIME_KEYS)) {
    throw new CardChannelPayloadError(
      `a lifetime cell carried fields other than the seven it declares (${keys.join(', ')}); a cell ` +
        'with a field this product did not write is a cell whose persistence nobody decided (NT-FR-08)',
    )
  }
  // One refusal type for the whole boundary, so a caller on the delivery path and a
  // caller in the document catch the same thing. `cardLifetimeFor` throws its own error
  // for a class the table does not carry, which is the right answer and the wrong type for
  // a value that arrived from somewhere else.
  let canonical: CardLifetimeCell
  try {
    canonical = cardLifetimeFor(cell.class)
  } catch {
    throw new CardChannelPayloadError(
      `a lifetime cell named a class this product does not have; CARD_LIFETIMES must carry every ` +
        'class the classifier can produce, so a cell for an unknown class is a class whose card ' +
        "nobody decided should exist (NT-FR-08, ADR-004)",
    )
  }
  if (!sameCardLifetimeCell(cell, canonical)) {
    throw new CardChannelPayloadError(
      `a lifetime cell was not the product's own cell for its class; every field of a cell comes ` +
        'from CARD_LIFETIMES, so a message cannot lengthen a card, shorten one, or give it a new end ' +
        '(NT-FR-08, ADR-004)',
    )
  }
  return canonical
}

/** Field-by-field equality of two lifetime cells, with the arrays compared by value. */
function sameCardLifetimeCell(one: CardLifetimeCell, other: CardLifetimeCell): boolean {
  return (
    one.class === other.class &&
    one.rendered === other.rendered &&
    one.lifetime === other.lifetime &&
    one.expiresInMs === other.expiresInMs &&
    one.repeat === other.repeat &&
    one.reason === other.reason &&
    one.ends.length === other.ends.length &&
    one.ends.every((end, index) => end === other.ends[index])
  )
}

// ---------------------------------------------------------------------------
// Building and reading, on the two sides
// ---------------------------------------------------------------------------

/**
 * Build the message the main process is about to send.
 *
 * The validating half of the same rule the document applies on arrival, so a payload
 * that could never be rendered safely never leaves this process. Throws
 * `CardChannelPayloadError` rather than sending something refused, and the delivery
 * path records that as a failure with its reason (APX-FR-02, ADR-010).
 */
export function cardChannelShow(model: CardModel, cell: CardLifetimeCell): CardChannelShow {
  return Object.freeze({
    model: assertContentFreeCardModel(model),
    cell: assertCanonicalCardLifetime(cell),
  })
}

/** Build the message that takes a card off the screen. Throws for an end nobody named. */
export function cardChannelRemove(end: CardEnd): CardChannelRemove {
  if (!CARD_ENDS.includes(end)) {
    throw new CardChannelPayloadError(
      `a card end was not one this product names (${CARD_ENDS.join(', ')}); a card removed for no ` +
        'stated reason is one nobody can explain afterwards (NT-FR-08, ADR-010)',
    )
  }
  return Object.freeze({ end })
}

/**
 * Read a `show` message that arrived, and return the payload, or refuse it.
 *
 * `unknown` on purpose. The value crossed a boundary and this function is what stands
 * on the other side of it, so its parameter is the widest type there is rather than the
 * type the sender promised.
 */
export function readCardChannelShow(payload: unknown): CardChannelShow {
  const record = asRecord(payload, 'a show message')
  const expected = CARD_CHANNEL_PAYLOAD_KEYS.show
  if (!sameKeySet(Object.keys(record).sort(), expected)) {
    throw new CardChannelPayloadError(
      `a show message carried fields other than ${expected.join(' and ')}; nothing else may cross the ` +
        'channel, so a message that carries more is refused rather than partly honoured (APX-FR-01)',
    )
  }
  return cardChannelShow(record['model'] as CardModel, record['cell'] as CardLifetimeCell)
}

/** Read a `remove` message that arrived, and return the payload, or refuse it. */
export function readCardChannelRemove(payload: unknown): CardChannelRemove {
  const record = asRecord(payload, 'a remove message')
  const expected = CARD_CHANNEL_PAYLOAD_KEYS.remove
  if (!sameKeySet(Object.keys(record).sort(), expected)) {
    throw new CardChannelPayloadError(
      `a remove message carried fields other than ${expected.join(' ')}; a removal is a closed token ` +
        'and nothing travels with it (APX-FR-01, ADR-010)',
    )
  }
  const end = record['end'] as CardEnd
  if (!CARD_ENDS.includes(end)) {
    throw new CardChannelPayloadError('a remove message named an end this product does not have')
  }
  return Object.freeze({ end })
}

/** An object, or a refusal that says what kind of message it was not. */
function asRecord(payload: unknown, what: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new CardChannelPayloadError(`${what} was not an object`)
  }
  return payload as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// The two ends
// ---------------------------------------------------------------------------

/** What a bridge's caller may be told when a message it forwarded was refused. */
export interface CardChannelDiagnostic {
  readonly onDiagnostic?: (message: string) => void
}

/**
 * Build the channel's callable end over a sink.
 *
 * The same two functions on both sides of the boundary, which is why one function makes
 * both: the preload hands this to the document, and a test hands it to a real card view
 * on a real document. Each call validates before it forwards, so a sink never sees a
 * value the guard refused, and a refusal never reaches the sink at all.
 *
 * A refused message is reported and dropped, never thrown at the caller. The caller on
 * the document side is a DOM event listener, where an exception would be an unhandled
 * error in a document nobody is watching; the caller on the main side is a delivery
 * path, where the *sender* has already validated the same values with the same rules -
 * so a refusal here can only be a message that did not come from this product, and the
 * honest answer is "nothing was rendered", said once (APX-FR-02, ADR-010).
 */
export function createCardSurfaceBridge(
  sink: CardSurfaceSink,
  options: CardChannelDiagnostic = {},
): CardSurfaceBridge {
  const diagnostic = options.onDiagnostic ?? ((): void => {})
  const bridge: CardSurfaceBridge = {
    show: (model, cell): void => {
      let payload: CardChannelShow
      try {
        payload = cardChannelShow(model, cell)
      } catch (cause) {
        reportRefusal(diagnostic, cause)
        return
      }
      sink.show(payload.model, payload.cell)
    },
    remove: (end): void => {
      let payload: CardChannelRemove
      try {
        payload = cardChannelRemove(end)
      } catch (cause) {
        reportRefusal(diagnostic, cause)
        return
      }
      sink.remove(payload.end)
    },
  }
  if (!isCardSurfaceBridge(bridge)) {
    // Unreachable, and checked anyway: this is the object a document's whole view of the
    // channel is, so "it has exactly two calls" is a fact the product checks rather than
    // a property a test would have to notice.
    throw new Error(
      `the card channel bridge is not a bridge (${Object.keys(bridge).sort().join(', ')}). It must ` +
        `carry exactly ${CARD_SURFACE_KEYS.join(' and ')} (NT-FR-12).`,
    )
  }
  return bridge
}

/**
 * Whether this value is a card channel bridge: exactly the two calls, and nothing else.
 *
 * A capability, not a name, and used twice: by `createCardSurfaceBridge` on itself, and
 * by a test that reads what the preload actually exposed. A bridge with a third key
 * fails both.
 */
export function isCardSurfaceBridge(value: unknown): value is CardSurfaceBridge {
  if (typeof value !== 'object' || value === null) return false
  const keys = Object.keys(value).sort()
  if (!sameKeySet(keys, CARD_SURFACE_KEYS)) return false
  return CARD_SURFACE_KEYS.every((key) => typeof (value as Record<string, unknown>)[key] === 'function')
}

/** The refusal line. The guard's own sentence, which quotes no value. */
function reportRefusal(diagnostic: (message: string) => void, cause: unknown): void {
  const detail = cause instanceof Error ? cause.message : String(cause)
  diagnostic(
    `notify: the notification card channel refused a message and nothing was rendered; the event is ` +
      `stored, the pending set is unchanged and nothing was retried. ${detail} (APX-FR-02, ADR-010)`,
  )
}

/** The part of an `EventTarget` the document half uses. Structural, as everything is here. */
export interface CardEventTargetLike {
  addEventListener(type: string, listener: (event: { readonly detail?: unknown }) => void): void
  removeEventListener(type: string, listener: (event: { readonly detail?: unknown }) => void): void
}

/** Where the document half listens, and how it reports a message it refused. */
export interface ListenForCardSurfaceOptions extends CardChannelDiagnostic {
  /**
   * The target to listen on. Defaults to this environment's own global object, which in
   * the card document is its `window` - the one object a preload and a page share.
   *
   * An argument rather than a `window` read, so the document entry does not have to name
   * a global and so a test can listen on a target it built.
   */
  readonly target?: CardEventTargetLike | null
}

/**
 * Install the document's end of the channel, and return how to take it down again.
 *
 * Two listeners, one per operation, and nothing else: no polling, no timer, no
 * privileged global, and no `ipcRenderer` (NT-FR-08, NT-FR-12). The sink is the card
 * document's own `CardView` - `CardView` already carries exactly `show` and `remove`,
 * which is why the channel's sink needs nothing from it.
 *
 * The returned function removes both listeners. The card document's entry holds it, so
 * a document that is torn down stops listening rather than leaving a listener on a
 * window that is going away (APX-FR-02).
 *
 * An environment with no event target - the Node-hosted main process, a test with
 * nothing supplied - is a no-op that returns a no-op, rather than a throw. This
 * function is the document's half, and the document's half running somewhere that has no
 * document must not be a failure the delivery path can see.
 */
export function listenForCardSurface(
  sink: CardSurfaceSink,
  options: ListenForCardSurfaceOptions = {},
): () => void {
  const target = options.target === undefined ? ambientTarget() : options.target
  if (target === null) return (): void => undefined
  const diagnostic = options.onDiagnostic ?? ((): void => {})
  const onShow = (event: { readonly detail?: unknown }): void => {
    let payload: CardChannelShow
    try {
      payload = readCardChannelShow(event.detail)
    } catch (cause) {
      reportRefusal(diagnostic, cause)
      return
    }
    sink.show(payload.model, payload.cell)
  }
  const onRemove = (event: { readonly detail?: unknown }): void => {
    let payload: CardChannelRemove
    try {
      payload = readCardChannelRemove(event.detail)
    } catch (cause) {
      reportRefusal(diagnostic, cause)
      return
    }
    sink.remove(payload.end)
  }
  target.addEventListener(CARD_CHANNEL_SHOW, onShow)
  target.addEventListener(CARD_CHANNEL_REMOVE, onRemove)
  return (): void => {
    target.removeEventListener(CARD_CHANNEL_SHOW, onShow)
    target.removeEventListener(CARD_CHANNEL_REMOVE, onRemove)
  }
}

/** This environment's global object, when it is one a card document could listen on. */
function ambientTarget(): CardEventTargetLike | null {
  const candidate = typeof globalThis === 'undefined' ? null : (globalThis as unknown as CardEventTargetLike)
  if (candidate === null || typeof candidate.addEventListener !== 'function') return null
  return candidate
}
