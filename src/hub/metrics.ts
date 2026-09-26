// Local metrics: the four counters PRD 11 measures the product against, recorded
// from the paths that actually happen (HC-6, HC-FR-02, EL-FR-10, PRD 11,
// APX-CON-12, APX-FR-01).
//
// WHY THIS FILE EXISTS AT ALL, GIVEN THE COUNTERS ALREADY EXIST
// The durable storage for the four counters is domain-engineer's
// (src/storage/counters.ts): one write method per counter, one read accessor, a
// closed union of four names and a three-field reading. What nobody had was the
// *decision* of when each of them moves. A counter a test writes is a counter that
// measures the test. This file is the four decisions, and the only thing in the
// product that calls a `recordX` method.
//
//   dashboard_opens          a client was served the dashboard document
//   deep_link_opens          a dashboard was opened through a deep link
//   toast_deliveries         a delivery attempt reported `delivered`
//   pending_count_snapshots  the pending set's membership changed
//
// THREE OF THE FOUR PATHS ARE A REQUEST, AND ONE IS NOT
// A dashboard open and a deep-link open are observed where a client reaches the
// hub: the dashboard's own GET. A toast delivery is observed where the delivery
// policy reports an outcome (HC-FR-07), which is deliberately not a request path -
// the policy is unreachable from any client (APX-CON-08). A pending-set snapshot
// is observed where a transition is applied to the log, which is also not a request
// path of its own but the *result* of one. Nothing here polls, samples or infers:
// each increment is a call from the place where the fact happened.
//
// WHY A DASHBOARD OPEN IS THE DOCUMENT AND NOT THE STREAM
// PRD 11 measures "unprompted dashboard pull", so the question is what a pull
// looks like from the hub's side of the socket. The answer is the one request that
// serves a person the page: `GET /` or `GET /index.html`, answered 200. The
// alternatives were considered and rejected here rather than silently:
//   - Counting every served file would count the page and its hashed assets, so one
//     open would read as three.
//   - Counting the live stream's first frame would measure a dashboard attached to
//     a socket rather than one a person pulled up, and would count a reconnect.
//   - Counting any request for `/` would count a 503 from a hub serving no build.
// A reload is two opens, which is honest: two pulls happened.
//
// WHY A DEEP LINK IS A QUERY PARAMETER AND NOT A PATH
// A deep link has to be observable by the hub, and a browser never sends a URL
// fragment - so `#/session/x` is a request the hub cannot see and a counter it
// cannot keep. The contract is therefore `?session=<id>` on the dashboard URL
// (DEEP_LINK_QUERY_KEY), which the notifier builds from the live origin
// (NT-FR-07) and the dashboard reads (LD-3). It is a contract this file publishes,
// not one any document specified.
//
// The target's *value* is deliberately never read, stored, logged or served. The
// predicate below answers "did this request carry a deep-link target", which is all
// a counter needs, so a caller-supplied string never reaches a record, a
// diagnostic line or a payload - and a hostile multi-kilobyte value is not even
// copied out of the query (APX-FR-01, APX-CON-12).
//
// A DEEP LINK ALSO COUNTS AS A DASHBOARD OPEN
// NT-FR-07 says opening a toast's deep link "focuses the session in the dashboard
// and counts as a dashboard open", and NT-FR-08 wants the tray's click to increment
// the deep-link counter. So the deep-link request increments both: one open, one
// deep link. Recording only one of them would make the two numbers disagree about
// the same event, which is the kind of drift this product's counters are supposed
// to be free of.
//
// A TOAST DELIVERY IS COUNTED FROM `delivered` AND FROM NOTHING ELSE
// The delivery policy reports five outcomes (src/hub/delivery.ts) and only one of
// them means somebody was told. A failed, timed-out, not-wired or suppressed
// attempt is a gap that must stay visible (APX-FR-02, ADR-010) and it is - on the
// health route, in the policy's ledger and in the ingest pipeline's drop ledger -
// but counting it as a delivery would put a success number next to a gap, which is
// the one thing PRD 11's "notification restraint" row cannot be measured against.
//
// A PENDING SNAPSHOT IS RECORDED WHEN THE SET CHANGES, NOT WHEN A ROW IS WRITTEN
// The store is wrapped rather than polled, so the question is only ever asked after
// a transition the store *applied* - a duplicate insert, a second acknowledgement,
// a conflict and an unknown identifier store nothing and change no set, so none of
// them records (HC-FR-08, and the same rule the live stream follows). An `fyi` or
// `finished` event is written and the pending set is untouched, so it records
// nothing: the counter answers "how often did a block need me", and a change that
// was not about a block is not that.
//
// The comparison is on the count, and that is sufficient rather than convenient: an
// applied transition moves the pending set by exactly one, so a change in
// membership is a change in count, and two transitions that cancel out are seen as
// two changes rather than one. The value itself is not stored - readPending()
// derives it at any moment and it is the tray badge's single source of truth
// (NT-FR-05); the counter records that a snapshot happened, which is EL-2's
// decision and is not revisited here.
//
// A COUNTER WRITE NEVER DECIDES ANYTHING ELSE
// Every record goes through a guard that swallows a failing write, reports a
// diagnostic line and counts it. This is the one rule in the file that is not
// about what to count: the counters are diagnostics, and a diagnostic that can fail
// a stored event, fail an ingest response, or turn a delivered notification into an
// unrecorded one has been wired into the wrong place. The count of failed writes
// (`failedWrites`) exists so "the counters could not be written" is a fact a test
// and `doctor` can see rather than a line that scrolled away (APX-FR-02).
//
// NOTHING HERE LEAVES THE MACHINE
// No socket, no subprocess, no outbound call and no rendering. The only values
// written are the four closed names, their increments and SQLite's own instants
// (APX-CON-12). The dashboard is not touched here: what the counters mean is
// dashboard-engineer's, and the payload these increments end up in is assembled in
// ./routes/metrics.ts.

import type { EventStore } from '../storage/eventStore.js'
import type { CounterName, Counters } from '../storage/counters.js'
import type { DeliveryAttemptRecord } from './delivery.js'
import type { DashboardDocumentHandler } from './server.js'

// ---------------------------------------------------------------------------
// The paths, as named sets
// ---------------------------------------------------------------------------

/**
 * The paths that are the dashboard itself.
 *
 * Exactly two, and both are what a browser asks for when a person pulls the
 * dashboard up: the root and the document `index.html` spells. Everything else a
 * dashboard build emits is an asset - a hashed script, a stylesheet, a font, an
 * icon - and an asset is not an open. This is a named export rather than a
 * condition in a route so a test can read the rule instead of inferring it.
 */
export const DASHBOARD_DOCUMENT_PATHS = ['/', '/index.html'] as const

/**
 * The query parameter that carries a deep link's target session.
 *
 * The one name, published here because three tasks have to agree on it and no
 * document specifies it: the notifier builds the link (NT-FR-07), the dashboard
 * resolves it (LD-3), and this file counts it (HC-6). It is a query parameter
 * rather than a path or a fragment because a fragment never reaches a server and a
 * path would have to be a route - and this product's route table is closed
 * (PRD 6.3, ADR-002).
 */
export const DEEP_LINK_QUERY_KEY = 'session'

/**
 * How long a deep-link target may be before it stops counting as one.
 *
 * Five hundred and twelve characters, the same bound the classifier puts on a
 * signal's own tokens. A longer value is a templated accident rather than a session
 * identifier, and nothing about it is stored either way - the value is never read.
 * The bound exists so a counter cannot be inflated by a script appending a megabyte
 * to a URL.
 */
export const DEEP_LINK_TARGET_MAX_LENGTH = 512

/**
 * Is this pathname the dashboard document?
 *
 * Runs of slashes are collapsed and nothing else is: `//index.html` is the same
 * request to a human and to the hub's own file resolution, and a *trailing* slash
 * is not normalised away because it names a directory rather than the document -
 * the hub answers 404 for it, and a predicate that called it a document would
 * disagree with the route that has to agree with. A string with a query in it is
 * not a pathname at all.
 */
export function isDashboardDocumentPath(pathname: string): boolean {
  return DASHBOARD_DOCUMENT_PATHS.some((known) => known === pathname.replace(/\/{2,}/g, '/'))
}

/**
 * Did this request carry a deep-link target?
 *
 * A predicate over the query and nothing else. The value is not extracted, so the
 * hub never holds a caller-supplied string it did not already receive as part of a
 * URL, and no deep-link target can reach a counter, a diagnostic line or a payload
 * (APX-FR-01).
 *
 * `?session=` empty is not a deep link: it is a template with no value, the same
 * answer the stream gives `?cursor=` (src/hub/sse.ts), because "the client sent no
 * target" and "the client sent an unusable one" should not both be counted as the
 * developer following a link.
 */
export function isDeepLinkRequest(query: URLSearchParams): boolean {
  const raw = query.get(DEEP_LINK_QUERY_KEY)
  if (raw === null) return false
  const trimmed = raw.trim()
  return trimmed !== '' && trimmed.length <= DEEP_LINK_TARGET_MAX_LENGTH
}

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

export interface CreateMetricsRecorderOptions {
  /**
   * The local counters. Domain-engineer's accessor, over the same database file as
   * the log; the recorder holds no handle of its own and writes no statement.
   */
  readonly counters: Counters
  /**
   * The pending count to start from, read once when the recorder is built.
   *
   * The baseline matters: a hub that starts with three pending blocks and then
   * stores an `fyi` event has not had a block change, and without a baseline that
   * transition would look like one. Read once, at construction, because the store is
   * open by then and no request can arrive before the hub is serving.
   *
   * A read that fails leaves the baseline unknown, and the first transition after
   * that is recorded - a snapshot that may be one too many is better than a change
   * that was never counted.
   */
  readonly initialPendingCount?: () => number
  /** Reports a diagnostic line. Never called with content, a path or a token. */
  readonly onDiagnostic?: (message: string) => void
}

/**
 * The four recording decisions, and nothing else.
 *
 * Five members, and the surface is closed on purpose: this object can only count.
 * It has no method that names a session, an event or a harness, no method that
 * reads a row, and no method that returns a payload - the read route serves the
 * counters through the store's own accessor, so a route cannot be handed this
 * object and find a write in it (APX-CON-08, HC-FR-02).
 */
export interface MetricsRecorder {
  /**
   * Record one dashboard open: a client was served the dashboard document.
   *
   * Public because NT-2's tray resolves a deep link into the dashboard from the
   * Electron main process, where no HTTP request happens, and NT-FR-08's
   * acceptance criterion is that the click increments the counter.
   */
  recordDashboardOpen(): void
  /** Record one deep-link open. See `recordDashboardOpen` for why this is public. */
  recordDeepLinkOpen(): void
  /**
   * Record a delivery outcome. Increments `toast_deliveries` for `delivered` and
   * nothing else, and never throws - it is called from inside the delivery policy's
   * own record, where a thrown error would become a failed notification.
   */
  recordDeliveryOutcome(attempt: DeliveryAttemptRecord): void
  /**
   * Report the pending count after a transition the store applied.
   *
   * Returns true when it recorded, which is what makes "the set changed" an
   * observable return value rather than a comparison a caller has to repeat. An
   * unknown baseline records the first observation; see `initialPendingCount`.
   */
  notePendingSet(pendingCount: number): boolean
  /** Counter writes that have failed in this run. Never thrown; always counted. */
  failedWrites(): number
}

export function createMetricsRecorder(options: CreateMetricsRecorderOptions): MetricsRecorder {
  const diagnostic = options.onDiagnostic ?? ((): void => {})
  let failed = 0
  let pendingBaseline: number | null = null

  // One guard for all four. A counter write that throws must not escape into an
  // ingest response, a store transition or a delivery record, and it must not be
  // invisible either: the failure is counted here and reported as a line. The
  // message names the counter and no value.
  //
  // The name is a `CounterName` rather than a string for the same reason the union
  // exists at all: a diagnostic line built from an arbitrary string would be a place
  // a caller's text could appear, and the four callers below are the only four that
  // can pick one.
  const record = (counter: CounterName, write: () => number): void => {
    try {
      write()
    } catch {
      failed += 1
      diagnostic(
        `metrics: the ${counter} counter could not be written, so this run under-reports it. Nothing ` +
          'else is affected: the event, the pending set and the notification it describes are all ' +
          'unchanged (APX-FR-02).',
      )
    }
  }

  // The baseline is read here rather than on the first transition, and a failure to
  // read it is not a failure of the recorder: the hub serves, and the first
  // transition after that records as a change.
  if (options.initialPendingCount !== undefined) {
    try {
      pendingBaseline = options.initialPendingCount()
    } catch {
      pendingBaseline = null
    }
  }

  return {
    recordDashboardOpen: (): void => record('dashboard_opens', () => options.counters.recordDashboardOpen()),

    recordDeepLinkOpen: (): void => record('deep_link_opens', () => options.counters.recordDeepLinkOpen()),

    recordDeliveryOutcome: (attempt: DeliveryAttemptRecord): void => {
      // The one branch in this file, and it is the whole of APX-FR-02 for this
      // counter: only an outcome that means somebody was told is a delivery. The
      // policy reports four other outcomes and each of them is a gap somebody else
      // has to know about, which is what the health route's delivery section and
      // the ingest pipeline's drop ledger are for.
      if (attempt.outcome !== 'delivered') return
      record('toast_deliveries', () => options.counters.recordToastDelivery())
    },

    notePendingSet: (pendingCount: number): boolean => {
      const previous = pendingBaseline
      pendingBaseline = pendingCount
      // Equal means unchanged: a transition that stored an event nobody is waiting
      // on. The counter answers how often a block needed the developer, so a
      // non-block is not an answer to that question.
      if (previous === pendingCount) return false
      record('pending_count_snapshots', () => options.counters.recordPendingCountSnapshot())
      return true
    },

    failedWrites: (): number => failed,
  }
}

// ---------------------------------------------------------------------------
// An open a surface recorded rather than a request
// ---------------------------------------------------------------------------

/** What a resolved link was for: a session to focus, or the dashboard itself. */
export type DeepLinkTarget = 'deep-link' | 'dashboard'

/**
 * Record a dashboard open that no request reported.
 *
 * NT-FR-07 says opening a toast's link "focuses the session in the dashboard and
 * counts as a dashboard open", and NT-3's tray resolves that link in the Electron main
 * process - where no HTTP request necessarily happens. A desktop that pointed a window
 * at the URL produces a document request, and the route's own handler above counts the
 * open; a desktop that resolved the target some other way produces no request at all,
 * and then nobody else will count it. This is that second case, and it is the reason
 * `recordDashboardOpen` and `recordDeepLinkOpen` are public.
 *
 * It lives here rather than in the tray for the reason every other decision in this
 * file lives here: `src/hub/metrics.ts` is the only module allowed to call a counter
 * write (tests/hub/metrics.test.ts walks the product's own source and asserts it), so
 * a tray that counted its own open would either break that guarantee or need this
 * function. The decision - which of the two counters a resolved deep link moves - is a
 * counting rule, and the counting rules are this file's.
 *
 * A deep link counts as both, because NT-FR-07 says so in one sentence; the plain
 * dashboard counts as the open alone, because an empty target is explicitly not a deep
 * link (see `isDeepLinkRequest` above). Both writes are guarded inside the recorder, so
 * a failing counter cannot turn a click into an error.
 */
export function recordOpenWithoutRequest(
  metrics: Pick<MetricsRecorder, 'recordDashboardOpen' | 'recordDeepLinkOpen'>,
  target: DeepLinkTarget,
): void {
  metrics.recordDashboardOpen()
  if (target === 'deep-link') metrics.recordDeepLinkOpen()
}

// ---------------------------------------------------------------------------
// The store wrapper: a snapshot on every change to the pending set
// ---------------------------------------------------------------------------

/**
 * Wrap a store so an applied transition records a pending-set snapshot.
 *
 * The store's own outcomes decide what is a change, rather than a parallel notion
 * of "something was written": a duplicate insert, an acknowledgement of something
 * already acknowledged, a conflict on a resolved row and an unknown identifier are
 * all no-ops, and none of them changes the pending set, so none of them records
 * (HC-FR-08). This is the same rule the live stream applies in
 * `withChangeFeed` (src/hub/sse.ts), for the same reason and with the same
 * consequence: one source of truth about what moved, and a no-op that stays
 * invisible to everything watching.
 *
 * The read is the badge's own accessor, `readPending`, so the snapshot can never
 * disagree with the number the tray shows (NT-FR-05). It is one bounded read on a
 * path that already reads the pending set twice - once for the change frame and
 * once for the delivery request - so this is not a new cost on the ingest path.
 *
 * A read that fails records nothing and reports nothing: the transition itself
 * succeeded, and a counter is not the place to fail a stored event over
 * (APX-FR-02).
 */
export function withPendingSnapshot(store: EventStore, metrics: MetricsRecorder): EventStore {
  const note = (): void => {
    try {
      metrics.notePendingSet(store.readPending().length)
    } catch {
      // Deliberately silent, and deliberately the only silent thing in this file.
      // The log has just been written correctly; the snapshot is a marker, and a
      // marker that cannot be taken must not become a failed write. The
      // change-feed wrapper this one is composed inside reads the same set, so a
      // genuinely unreadable log is surfaced through the stream and health rather
      // than swallowed here. (APX-FR-02)
    }
  }
  return {
    filePath: store.filePath,
    schemaVersion: store.schemaVersion,
    rebuiltFromMigrations: store.rebuiltFromMigrations,
    insertEvent: (event): ReturnType<EventStore['insertEvent']> => {
      const result = store.insertEvent(event)
      if (result.outcome === 'inserted') note()
      return result
    },
    markResolved: (eventId): ReturnType<EventStore['markResolved']> => {
      const result = store.markResolved(eventId)
      if (result.outcome === 'applied') note()
      return result
    },
    markAcknowledged: (eventId): ReturnType<EventStore['markAcknowledged']> => {
      const result = store.markAcknowledged(eventId)
      if (result.outcome === 'applied') note()
      return result
    },
    readPending: (): ReturnType<EventStore['readPending']> => store.readPending(),
    readSessionSummaries: (): ReturnType<EventStore['readSessionSummaries']> =>
      store.readSessionSummaries(),
    readSession: (sessionId): ReturnType<EventStore['readSession']> => store.readSession(sessionId),
    readEventHistory: (query) => store.readEventHistory(query),
    close: (): void => store.close(),
  }
}

// ---------------------------------------------------------------------------
// The dashboard route's hook
// ---------------------------------------------------------------------------

/**
 * The recorder as the dashboard route's document handler.
 *
 * The route calls this only when it actually served a file, so a 404, a 415 and a
 * hub with no built dashboard record nothing - which is the honest answer, because
 * no dashboard was opened in any of those cases. Two rules, and the second one is
 * why both counters move together: a document request is an open, and a document
 * request that carried a deep-link target is an open *and* a deep link
 * (NT-FR-07).
 */
export function onDashboardDocumentServed(metrics: MetricsRecorder): DashboardDocumentHandler {
  return ({ pathname, query }): void => {
    if (!isDashboardDocumentPath(pathname)) return
    metrics.recordDashboardOpen()
    if (isDeepLinkRequest(query)) metrics.recordDeepLinkOpen()
  }
}
