// The history panel: past events, as a second panel on this page (LD-FR-08,
// LD-FR-11, APX-FR-01, ADR-003).
//
// WHAT THIS IS
// A panel, not a page and not a route: the developer never loses their place in the
// list of rows, which is the settled answer in docs/features/live-dashboard.md §8
// Open Question 2. It reads `GET /api/events`, the bounded history route HC-1 added
// for exactly this view, and renders five things per event and nothing else:
//
//   class        needs-you | finished | fyi, in this product's own words
//   repository   the short name, joined by session identity (APX-CON-09)
//   session      the session identifier
//   timestamp    the event's own, as an age plus the exact value for a machine
//   state        acknowledgement state and resolution state, each a closed word
//
// WHY THERE IS NO CONTENT FIELD, AND WHY IT IS A PARSER AND NOT A PROMISE
// The store holds no conversation content and the route serves the store's own field
// set, so the panel could not render a prompt even if it wanted to. This file does
// not rely on that: `parseHistoryEntry` names each field it keeps, and
// `HistoryEntry` has exactly the members listed above. A payload that grew a
// `body`, a `message`, a `text` or a `transcript` would be read by the same parser
// and the new key would not reach the model, the DOM or the accessibility tree -
// which is a property a test can assert against a hostile payload, where "the store
// has no such column" is a claim about a different file.
//
// The repository is the one field the event record does not carry, and it is joined
// from the session rows the page already holds rather than stored on the event. A
// session this page has never heard of is rendered as "unknown repository" rather
// than guessed at: a panel that invented a repository would be a panel showing a
// fact nobody recorded.
//
// WHERE AN INFORMATION-ONLY EVENT IS READ (LD-FR-11)
// `fyi` is in this table, with the same word the fourth row condition uses, because
// an information-only event has to appear *somewhere* the developer can read. This
// panel and the information-only row are the two places it appears, and neither is a
// card, a toast or a badge: an `fyi` that changed the pending count would be
// claiming something is waiting on the developer when nothing is. Nothing in this
// file writes, and the count on the page is never computed from what this panel
// shows.

// ---------------------------------------------------------------------------
// The route and its bound
// ---------------------------------------------------------------------------

/** The bounded history route. A read; no token, no query the caller can widen. */
export const HISTORY_ROUTE = '/api/events'

/**
 * The page size this panel asks for.
 *
 * The same number the hub serves by default (`HISTORY_DEFAULT_LIMIT` in
 * src/storage/eventStore.ts), restated rather than imported for the reason
 * `WRITE_TOKEN_HEADER` is: that module reaches `node:fs` and `node:path`. The
 * difference does not matter for correctness - the hub clamps whatever it is given -
 * so this is a hint rather than a bound, and the bound stays the route's.
// tests/dashboard/live-interactions.test.ts asserts the two constants agree, so a
 * hub-side change cannot leave this page asking for a different default in silence.
 */
export const HISTORY_PAGE_SIZE = 100

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/**
 * One history row, in the field set this panel reads and renders.
 *
 * `rawEventType` and `dedupeKey` exist on the store's row and are deliberately not
 * here: a harness's internal event name and this product's dedupe key are not among
 * the five things LD-FR-08 says the history view shows, and every field the panel
 * does not need is a field a payload could grow something dangerous into.
 */
export interface HistoryEntry {
  readonly eventId: string
  readonly sessionId: string
  readonly class: 'needs-you' | 'finished' | 'fyi'
  readonly occurredAt: string
  readonly ackState: 'unacknowledged' | 'acknowledged'
  readonly resolutionState: 'unresolved' | 'resolved'
}

/** What the repository of a history row is when the page has never seen its session. */
export const UNKNOWN_REPOSITORY = 'unknown repository'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asToken(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

const HISTORY_CLASSES: readonly string[] = ['needs-you', 'finished', 'fyi']
const ACK_STATES: readonly string[] = ['unacknowledged', 'acknowledged']
const RESOLUTION_STATES: readonly string[] = ['unresolved', 'resolved']

/**
 * One event out of an untrusted payload, or null when it is not readable.
 *
 * Field by field, never spread. See this file's header for why the parser rather
 * than a type is what makes the panel content-free.
 */
export function parseHistoryEntry(value: unknown): HistoryEntry | null {
  if (!isRecord(value)) return null
  const eventId = asToken(value['eventId'])
  const sessionId = asToken(value['sessionId'])
  const eventClass = asToken(value['class'])
  const occurredAt = asToken(value['occurredAt'])
  const ackState = asToken(value['ackState'])
  const resolutionState = asToken(value['resolutionState'])
  if (
    eventId === null ||
    sessionId === null ||
    eventClass === null ||
    !HISTORY_CLASSES.includes(eventClass) ||
    occurredAt === null ||
    ackState === null ||
    !ACK_STATES.includes(ackState) ||
    resolutionState === null ||
    !RESOLUTION_STATES.includes(resolutionState)
  ) {
    return null
  }
  return {
    eventId,
    sessionId,
    class: eventClass as HistoryEntry['class'],
    occurredAt,
    ackState: ackState as HistoryEntry['ackState'],
    resolutionState: resolutionState as HistoryEntry['resolutionState'],
  }
}

/** The history a read route returned, dropping any row that is not readable. */
export function parseHistoryPayload(payload: unknown): readonly HistoryEntry[] {
  if (!isRecord(payload)) return []
  const events = payload['events']
  if (!Array.isArray(events)) return []
  return events
    .map((entry) => parseHistoryEntry(entry))
    .filter((entry): entry is HistoryEntry => entry !== null)
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

/**
 * The class, in the product's own words.
 *
 * `fyi` reads as "Information only" rather than as the storage token, because that is
 * the word LD-FR-02's fourth condition uses on a row and a panel that said "fyi" to
 * a developer would be speaking a harness's vocabulary on the one surface that is
 * meant to translate it.
 */
export const HISTORY_CLASS_LABEL: Readonly<Record<HistoryEntry['class'], string>> = Object.freeze({
  'needs-you': 'Needs you',
  finished: 'Finished',
  fyi: 'Information only',
})

/** The two state words, as words rather than as the store's literals. */
export const HISTORY_ACK_LABEL: Readonly<Record<HistoryEntry['ackState'], string>> = Object.freeze({
  unacknowledged: 'Unacknowledged',
  acknowledged: 'Acknowledged',
})

export const HISTORY_RESOLUTION_LABEL: Readonly<Record<HistoryEntry['resolutionState'], string>> =
  Object.freeze({
    unresolved: 'Unresolved',
    resolved: 'Resolved',
  })

// ---------------------------------------------------------------------------
// The DOM contract
// ---------------------------------------------------------------------------

export const HISTORY_PANEL_ATTRIBUTE = 'data-dashboard-history'
export const HISTORY_ENTRIES_ATTRIBUTE = 'data-history-entries'
export const HISTORY_ENTRY_ATTRIBUTE = 'data-history-entry'
export const HISTORY_CLASS_ATTRIBUTE = 'data-history-class'
export const HISTORY_REPOSITORY_ATTRIBUTE = 'data-history-repository'
export const HISTORY_SESSION_ATTRIBUTE = 'data-history-session'
export const HISTORY_TIMESTAMP_ATTRIBUTE = 'data-history-timestamp'
export const HISTORY_ACK_ATTRIBUTE = 'data-history-ack'
export const HISTORY_RESOLUTION_ATTRIBUTE = 'data-history-resolution'
/** Set while a read is in flight, and when the last one failed. */
export const HISTORY_STATUS_ATTRIBUTE = 'data-history-status'
export const HISTORY_STATUSES = ['idle', 'reading', 'unreadable'] as const
export type HistoryStatus = (typeof HISTORY_STATUSES)[number]

/** The name the panel is announced under. */
export const HISTORY_LABEL = 'History'
/** What the panel says when it holds nothing, and when it could not read. */
export const HISTORY_EMPTY_SENTENCE = 'No events have been recorded yet.'
export const HISTORY_UNREADABLE_SENTENCE =
  "The hub's history could not be read, so this panel is empty rather than showing events it " +
  'does not have.'

/**
 * A compact age, in the same units the rows use.
 *
 * Declared rather than imported from ../prototype/scene, so this module does not pull
 * the renderer into a panel that has no need of it. The same arithmetic and the same
 * three units, because two ages on one page that disagree about how long two minutes
 * is would be a page that cannot be trusted about either. The rendered timestamp is
 * asserted against a fixed clock in the suite, which is what pins the two copies.
 */
export function historyAge(occurredAt: string, now: string): string {
  const elapsedMs = Date.parse(now) - Date.parse(occurredAt)
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 'now'
  const seconds = Math.floor(elapsedMs / 1000)
  if (seconds < 60) return '<1m'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** The repository short name a session belongs to, from the rows the page holds. */
export function repositoryForSession(
  sessionId: string,
  sessions: readonly { readonly sessionId: string; readonly repoShortName: string }[],
): string {
  return sessions.find((session) => session.sessionId === sessionId)?.repoShortName ??
    UNKNOWN_REPOSITORY
}

/**
 * The five fields of a history row, in reading order, with the attribute each is
 * tagged with in the DOM.
 *
 * One function builds both the elements and what a test reads, so the panel cannot
 * describe an event differently from the way it is tagged - the same argument
 * `mirrorRowFields` makes in ../a11y/dom-mirror.ts, and for the same reason.
 */
export function historyEntryFields(
  entry: HistoryEntry,
  context: { readonly repository: string; readonly now: string },
): readonly { readonly attribute: string; readonly text: string }[] {
  return [
    { attribute: HISTORY_CLASS_ATTRIBUTE, text: HISTORY_CLASS_LABEL[entry.class] },
    { attribute: HISTORY_REPOSITORY_ATTRIBUTE, text: context.repository },
    { attribute: HISTORY_SESSION_ATTRIBUTE, text: entry.sessionId },
    { attribute: HISTORY_TIMESTAMP_ATTRIBUTE, text: `${historyAge(entry.occurredAt, context.now)} ago` },
    { attribute: HISTORY_ACK_ATTRIBUTE, text: HISTORY_ACK_LABEL[entry.ackState] },
    {
      attribute: HISTORY_RESOLUTION_ATTRIBUTE,
      text: HISTORY_RESOLUTION_LABEL[entry.resolutionState],
    },
  ]
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** Just enough of a session row to answer "which repository is this event in". */
export interface HistorySession {
  readonly sessionId: string
  readonly repoShortName: string
}

export interface CreateHistoryPanelOptions {
  /** Where the panel is mounted. Below the rows, in the same container. */
  readonly parent: HTMLElement
  /** Defaults to the document the parent belongs to. */
  readonly document?: Document
  /** The panel's id, so a header control can point at it with `aria-controls`. */
  readonly id?: string
  /** The instant ages are measured against. Defaults to the wall clock. */
  readonly now?: () => string
}

export interface HistoryPanel {
  readonly root: HTMLElement
  /** The rendered rows, newest first as the route returned them. */
  readonly entries: readonly HTMLElement[]
  readonly status: HistoryStatus
  /** Render a read's result. The sessions are the rows the page already holds. */
  render(entries: readonly HistoryEntry[], sessions: readonly HistorySession[]): void
  /** Note that a read is in flight, so the panel is not briefly "no events yet". */
  setStatus(status: HistoryStatus): void
  /** Show or hide the panel without discarding what it holds. */
  setOpen(open: boolean): void
  readonly isOpen: boolean
  readonly isDestroyed: boolean
  destroy(): void
}

export function createHistoryPanel(options: CreateHistoryPanelOptions): HistoryPanel {
  const doc = options.document ?? options.parent.ownerDocument
  const now = options.now ?? ((): string => new Date().toISOString())

  const root = doc.createElement('section')
  root.setAttribute(HISTORY_PANEL_ATTRIBUTE, '')
  root.setAttribute('aria-label', HISTORY_LABEL)
  if (options.id !== undefined) root.id = options.id

  const heading = doc.createElement('h2')
  heading.textContent = HISTORY_LABEL
  root.append(heading)

  const statusLine = doc.createElement('p')
  statusLine.setAttribute(HISTORY_STATUS_ATTRIBUTE, 'idle')
  statusLine.textContent = HISTORY_EMPTY_SENTENCE
  root.append(statusLine)

  const list = doc.createElement('ul')
  list.setAttribute(HISTORY_ENTRIES_ATTRIBUTE, '')
  root.append(list)

  options.parent.append(root)

  let entries: readonly HTMLElement[] = []
  let status: HistoryStatus = 'idle'
  let destroyed = false

  const applyStatus = (): void => {
    statusLine.setAttribute(HISTORY_STATUS_ATTRIBUTE, status)
    statusLine.textContent =
      status === 'unreadable'
        ? HISTORY_UNREADABLE_SENTENCE
        : status === 'reading'
          ? 'Reading the hub…'
          : entries.length === 0
            ? HISTORY_EMPTY_SENTENCE
            : `${String(entries.length)} events, newest first.`
  }

  return {
    root,
    get entries(): readonly HTMLElement[] {
      return entries
    },
    get status(): HistoryStatus {
      return status
    },
    render(next, sessions): void {
      if (destroyed) return
      status = 'idle'
      list.replaceChildren()
      for (const entry of next) {
        const item = doc.createElement('li')
        item.setAttribute(HISTORY_ENTRY_ATTRIBUTE, entry.eventId)
        // The exact instant, for a machine and for a person who wants it. The age is
        // what the panel reads; this is what it can be checked against.
        item.setAttribute('datetime', entry.occurredAt)
        const context = { repository: repositoryForSession(entry.sessionId, sessions), now: now() }
        for (const field of historyEntryFields(entry, context)) {
          const span = doc.createElement('span')
          span.setAttribute(field.attribute, '')
          span.textContent = field.text
          item.append(span)
        }
        list.append(item)
      }
      entries = [...list.querySelectorAll<HTMLElement>(`[${HISTORY_ENTRY_ATTRIBUTE}]`)]
      applyStatus()
    },
    setStatus(next): void {
      if (destroyed) return
      status = next
      applyStatus()
    },
    setOpen(open): void {
      if (destroyed) return
      // `hidden` rather than a class: a panel that is closed should be out of the
      // accessibility tree and out of the tab order entirely, and the rows it holds
      // are not focusable anyway, so nothing is lost by hiding it.
      root.hidden = !open
    },
    get isOpen(): boolean {
      return !root.hidden
    },
    get isDestroyed(): boolean {
      return destroyed
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      entries = []
      root.remove()
    },
  }
}

// ---------------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------------

/** A full read of the bounded history. */
export type HistoryReader = () => Promise<readonly HistoryEntry[]>

/** The slice of `fetch` the reader uses, so a test drives the request and not a mock of it. */
export type HistoryFetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * The history, over `fetch`, from the page's own origin.
 *
 * Same origin as everything else on this page and nothing else, and a `GET` with no
 * body and no token: the bounded history route is a read (HC-FR-01), and a panel that
 * could not read it is a panel that says so.
 */
export function createFetchHistoryReader(options: {
  readonly origin: string
  readonly limit?: number
  readonly fetchImpl?: HistoryFetchLike
}): HistoryReader {
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const limit = options.limit ?? HISTORY_PAGE_SIZE
  return async (): Promise<readonly HistoryEntry[]> => {
    const response = await doFetch(
      `${options.origin}${HISTORY_ROUTE}?limit=${String(limit)}`,
      { method: 'GET', credentials: 'omit', cache: 'no-store' },
    )
    if (!response.ok) {
      throw new Error(`the hub answered ${String(response.status)} for ${HISTORY_ROUTE}`)
    }
    return parseHistoryPayload((await response.json()) as unknown)
  }
}
