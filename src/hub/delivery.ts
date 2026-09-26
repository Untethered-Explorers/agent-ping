// The delivery policy: the hub's half of "what actually reaches the developer"
// (HC-FR-07, HC-FR-08, APX-FR-02, APX-CON-10, ADR-004, ADR-010, PRD 10).
//
// WHAT THIS MODULE DECIDES, AND WHAT IT DELIBERATELY DOES NOT
// It decides three things, from the classified event and the run's own record of what
// it has already delivered:
//   - whether a delivery is attempted at all
//   - that it is attempted at most once per event, per run
//   - what the outcome of an attempt was, kept per event for diagnostics
// It does *not* decide how loud a delivery is. That is the notifier's class policy
// (notification-engineer, NT-1, ADR-004): a needs-you toast is resident and
// non-auto-dismissing, a finished one expires, and an fyi request is refused because
// it never leaves the app. There is exactly one class policy in this product, and it
// is the one the notifier can be tested against. If this file also branched on class
// then NT-1's "an fyi request never reaches a platform notifier" assertion would be
// testing a path this policy had made unreachable, and a second class table would be
// the second thing to drift (see the gotcha at the end of this header).
//
// The two halves meet at one place: `NotificationRequest`, the closed shape below,
// which the composition root's notifier receives. The hub adds exactly two fields to
// what ingest already decided - the repository short name and the live origin - and
// both are there because a deep link (NT-FR-07) cannot be built without them. The
// origin is a thunk because the socket is bound after this object is built, and the
// repository name is read at attempt time because the store's `EventRecord` does not
// carry it: the identity of a repository belongs to the session row (ADR-008), and
// that read is one bounded row read on a path that is never a client's.
//
// EXACTLY ONCE, AND WHAT "PER RUN" MEANS
// The guard is a set of event identifiers this run has already delivered, and it is
// checked before the notifier is called, so a second attempt for the same event is
// recorded as a suppression rather than producing a second toast (NT-FR-08: one
// needs-you toast per block, no repeat timer). The set is per run and deliberately
// not durable: a hub that was killed while a block was pending must deliver that
// block again after the restart, because the developer may have missed the first one
// and the tray badge is the durable signal rather than a re-fired toast (ADR-010,
// PRD 10). A durable "already delivered" record would be a schema column and a
// contract change to src/storage/schema.sql, which is domain-engineer's; it would
// also be the wrong default, because a block nobody answered is a block that must
// keep asking. The guard is therefore about duplicates *within* a run - the replayed
// ingest envelope and a double replay - and not about history.
//
// THE RESTART REPLAY, AND WHY IT IS EXACTLY ONCE
// `replayPending` reads the unacknowledged pending set - the store's own
// `readPending`, which is the tray badge's single source of truth (NT-FR-05,
// EL-FR-08) - and delivers each item once, through the same `deliver` the live path
// uses, so both paths share the guard, the bound and the ledger. Every item is
// replayed, none is replayed twice, and the batch is issued oldest-first in bounded
// concurrency: a machine with two hundred pending blocks must not fire two hundred
// platform notifications in the same millisecond, and the batch size is a named
// export rather than a comment. A replayed delivery is *not* a second one: the run
// that was killed had already delivered it, and this run is a different run.
//
// A DELIVERY FAILURE IS NEVER SILENT (APX-FR-02, ADR-010)
// Three things happen when the notifier throws or overruns, and the third is the one
// that matters: the outcome is recorded against the event, counted, and reported on
// the health route that `doctor` reads (HC-FR-07, NT-FR-09). The attempt is never
// retried - one attempt, one bound, one record - because a hub whose notifier is
// failing must not become a hub that retries forever against it (APX-CON-10). The
// event stays stored and the pending item stays pending either way: a failed toast is
// a missing notification, never a lost block, and the badge is what carries the
// block (ADR-010). `deliver` resolves with the outcome and never throws, so the
// composition root's port adapter is what turns a failure back into a rejection the
// ingest pipeline records as a drop (HC-FR-09).
//
// WHERE THE COUNTERS LIVE, AND WHY NOT HERE
// The counts in this module are the policy's own, in memory, and they are not the local
// counters of PRD 10: nothing here opens the counters table, because the counters are
// domain-engineer's file and the recording is HC-6's, and a delivery policy that wrote
// its own durable statistics would be a second place to forget to count. What HC-6 needs
// is here and is enough: the `onOutcome` seam is called with every recorded attempt, so
// a `delivered` outcome is the increment for `toast_deliveries` and the other four
// outcomes are handed over rather than left to be polled out of `outcomes()`. The seam
// is one call inside `record` and nothing else; `DeliveryAttemptRecord` is content-free
// by construction, so a counter taken from it cannot carry anything the log does not
// already hold (APX-FR-01). A listener that throws is reported and ignored, because a
// counter must never decide the outcome of the notification it is counting.
//
// NOTHING HERE CAN STEER A HARNESS, AND NOTHING LEAVES THE PROCESS
// The policy's only effects are a read from the store and a call to the notifier port
// the composition root injected. There is no statement of its own, no mutation, no
// socket, no subprocess and no retry, and every value it records is a row key, a
// class, a source, a count, a timestamp or a closed token - the notifier's own
// rendering is the only place a title and a body exist, and it is the notifier's
// field to make (APX-CON-08, APX-FR-01, APX-CON-12).

import type { EventClass, EventRecord, EventStore } from '../storage/eventStore.js'
import type { DeliveryRequest } from './ingest-service.js'

// ---------------------------------------------------------------------------
// The bounds
// ---------------------------------------------------------------------------

/**
 * How long one notifier call may take.
 *
 * Two seconds, matching the ingest pipeline's own delivery bound
 * (INGEST_DELIVERY_TIMEOUT_MS) because this is the same operation measured by the
 * two layers that can see it: the ingest seam bounds the live path, and this bounds
 * the replay path, which has no ingest seam above it. A test lowers it so it can
 * watch a wedged notifier be abandoned in real time rather than by faking a clock the
 * hub does not have.
 *
 * One attempt, no retry (APX-CON-10).
 */
export const DELIVERY_ATTEMPT_TIMEOUT_MS = 2_000

/**
 * How many per-event outcome records are kept in memory.
 *
 * Two hundred, because this is a diagnostic tail rather than a log: what an operator
 * needs is the recent per-event history, and the *counts* beside it are kept
 * separately and without a bound, so a hub that failed a thousand deliveries still
 * reports a thousand. The count is unbounded and the list is not, which is the same
 * arrangement the ingest pipeline's drop ledger uses.
 */
export const DELIVERY_MAX_OUTCOME_RECORDS = 200

/**
 * How many replayed deliveries may be in flight at once.
 *
 * Eight. A restart with two hundred pending blocks must not hand two hundred
 * platform notifications to the same desktop in one millisecond - on Linux that is
 * two hundred `notify-send` processes, which is the retry-storm shape APX-CON-10
 * exists to avoid even though nothing here is retrying. Oldest first, so a developer
 * who has been away sees the block that has been waiting longest.
 */
export const DELIVERY_REPLAY_CONCURRENCY = 8

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * Why a delivery was attempted, or why it was not.
 *
 * Two of these say an attempt happened (`new-event`, `restart-replay`), two say the
 * hub itself declined to try (`already-delivered-this-run`, `not-wired`), and two
 * report what the notifier did (`notifier-failed`, `notifier-timeout`). The last one,
 * `refused-while-closing`, is the answer for an attempt that arrived after the hub
 * began stopping: refusing it is HC-FR-10's "stops accepting events" reaching the
 * delivery path, and it is recorded rather than dropped silently.
 *
 * Every value is a closed token. A reason that could carry a notifier's error message
 * would put an arbitrary string into a record this product keeps and serves
 * (APX-FR-01).
 */
export type DeliveryReason =
  | 'new-event'
  | 'restart-replay'
  | 'already-delivered-this-run'
  | 'not-wired'
  | 'notifier-failed'
  | 'notifier-timeout'
  | 'refused-while-closing'

/**
 * What became of one attempt.
 *
 * `delivered` is the only one that means somebody was told. The other four are all
 * visible facts about the same kind of gap, and none of them may be reported as a
 * success (APX-FR-02).
 */
export type DeliveryOutcome =
  | 'delivered'
  | 'failed'
  | 'timed-out'
  | 'not-wired'
  | 'suppressed'

/**
 * Every reason each outcome can carry, as data.
 *
 * Total over the two unions, so a record is always explainable and a new outcome or
 * reason is a compile error in the table rather than an unexplained value in a
 * ledger. `delivered` has two because it has two legitimate sources and they are
 * different facts for `doctor`; `suppressed` has two because declining to try and
 * declining to try again are different problems.
 */
export const DELIVERY_OUTCOME_REASONS: Readonly<Record<DeliveryOutcome, readonly DeliveryReason[]>> = {
  delivered: ['new-event', 'restart-replay'],
  failed: ['notifier-failed'],
  'timed-out': ['notifier-timeout'],
  'not-wired': ['not-wired'],
  suppressed: ['already-delivered-this-run', 'refused-while-closing'],
}

/** Where a delivery came from. The notifier is told, and must not decide on it. */
export type DeliverySource = 'event' | 'restart-replay'

/**
 * What the notifier is handed: the stored event, the class the classifier decided,
 * how many blocks are pending, the repository's short name, the hub's live origin and
 * where this request came from.
 *
 * Six fields, closed, and asserted field by field in tests/hub/delivery.test.ts.
 * There is no prompt, no tool name, no diff, no transcript and no absolute path:
 * the event is the store's own content-free row and the repository is its short name
 * (ADR-003, ADR-008, APX-FR-01). `origin` is the loopback origin the runtime file
 * publishes, so a deep link is a string concatenation rather than a guess at a port
 * (NT-FR-07, PRD 16 Open Question 10).
 *
 * `source` is here for the notifier's own diagnostics, not for its policy: a replayed
 * block is a block the developer may already have been told about, and knowing that is
 * useful, but suppressing on it is the hub's decision and has already been made.
 */
export interface NotificationRequest {
  readonly event: EventRecord
  readonly class: EventClass
  readonly pendingCount: number
  /** The repository's short name, or null when the session row could not be read. */
  readonly repoShortName: string | null
  /** The hub's live loopback origin, or '' before the socket is bound. */
  readonly origin: string
  readonly source: DeliverySource
}

/**
 * The notifier boundary, owned by notification-engineer (NT-1).
 *
 * A function rather than an interface, for the reason the ingest seam is one too:
 * there is one caller and one operation, and a policy object here would invite a
 * second method nobody has a use for. It may return a promise, which this module
 * bounds; it must not throw into the request, because a throw is caught here and
 * recorded rather than propagated into a harness.
 */
export type Notifier = (request: NotificationRequest) => Promise<void> | void

// ---------------------------------------------------------------------------
// The decision table
// ---------------------------------------------------------------------------

/** Whether a notifier is wired behind the port. Part of the decision key. */
export type DeliveryWiring = 'wired' | 'unwired'

/** Whether this run has already delivered the event. Part of the decision key. */
export type DeliveryAttemptOrder = 'first' | 'repeat'

/** The three inputs, as one key. Every combination is written out below. */
export type DeliveryDecisionKey =
  | 'event:wired:first'
  | 'event:wired:repeat'
  | 'event:unwired:first'
  | 'event:unwired:repeat'
  | 'restart-replay:wired:first'
  | 'restart-replay:wired:repeat'
  | 'restart-replay:unwired:first'
  | 'restart-replay:unwired:repeat'

/** What the policy decided for one candidate. */
export interface DeliveryDecision {
  /** `attempt` calls the notifier; `skip` records the refusal and does not. */
  readonly kind: 'attempt' | 'skip'
  readonly reason: DeliveryReason
}

/**
 * The whole policy, as data.
 *
 * Eight cells, because the three inputs are three closed sets and every combination
 * they can produce is reachable. Two of the rules are visible in the shape of the
 * table rather than in a branch:
 *
 *   - A `repeat` is always a skip, whatever the wiring. That is the exactly-once
 *     property (NT-FR-08, HC-FR-08): one event, one attempt, one run, however many
 *     times the envelope or the replay reaches the policy.
 *   - `unwired` is a skip, never a success. A hub with no notifier behind the port
 *     must report that it told nobody, which is the whole of APX-FR-02.
 */
export const DELIVERY_DECISIONS: Readonly<Record<DeliveryDecisionKey, DeliveryDecision>> = {
  'event:wired:first': { kind: 'attempt', reason: 'new-event' },
  'event:wired:repeat': { kind: 'skip', reason: 'already-delivered-this-run' },
  'event:unwired:first': { kind: 'skip', reason: 'not-wired' },
  'event:unwired:repeat': { kind: 'skip', reason: 'already-delivered-this-run' },
  'restart-replay:wired:first': { kind: 'attempt', reason: 'restart-replay' },
  'restart-replay:wired:repeat': { kind: 'skip', reason: 'already-delivered-this-run' },
  'restart-replay:unwired:first': { kind: 'skip', reason: 'not-wired' },
  'restart-replay:unwired:repeat': { kind: 'skip', reason: 'already-delivered-this-run' },
}

/** One recorded attempt: what was tried, what became of it, and for which row. */
export interface DeliveryAttemptRecord {
  readonly at: string
  /** The store's own row key. The one identifier here, and it is a UUID. */
  readonly eventId: string
  readonly class: EventClass
  readonly source: DeliverySource
  readonly outcome: DeliveryOutcome
  readonly reason: DeliveryReason
  readonly elapsedMs: number
  /** The pending count as the request carried it: the badge's value at the time. */
  readonly pendingCount: number
}

/** The last failure, for the health route. A row key, a token and a timestamp. */
export interface DeliveryFailureSummary {
  readonly at: string
  readonly eventId: string
  readonly reason: DeliveryReason
}

/**
 * The delivery section of the health payload, verbatim.
 *
 * Counts, timestamps, one row key and closed tokens - no event, no class breakdown
 * beyond the counts, no message, no title and no body (APX-FR-01, APX-CON-12).
 * `status` reflects the *most recent* attempt rather than the run's history, so a
 * notifier that failed once and then worked does not leave the hub permanently
 * degraded; `failed`, `timedOut` and `lastFailure` keep the history visible. This is
 * the section `doctor` reads (HC-FR-07, IO-2, NT-FR-09).
 */
export interface DeliveryStatus {
  readonly status: 'ok' | 'degraded' | 'not-wired'
  /** Whether a notifier is wired behind the port at all. */
  readonly wired: boolean
  readonly attempted: number
  readonly delivered: number
  readonly failed: number
  readonly timedOut: number
  /** Attempts the policy declined: already delivered this run, or closing. */
  readonly suppressed: number
  /** Attempts that found no notifier. Never reported as a success. */
  readonly notWired: number
  /** Items the restart replay delivered, whatever the outcome. */
  readonly replayed: number
  readonly inFlight: number
  readonly lastAttemptAt: string | null
  readonly lastFailure: DeliveryFailureSummary | null
}

/** What one restart replay did. Counts only, for a diagnostic line and a test. */
export interface DeliveryReplayReport {
  /** The unacknowledged pending items found at start. */
  readonly candidates: number
  readonly attempted: number
  readonly delivered: number
  readonly failed: number
  readonly suppressed: number
  readonly notWired: number
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

export interface DeliveryPolicyOptions {
  /**
   * The log this hub reads. The store the ingest pipeline and the read routes share,
   * already wrapped for the live stream: a delivery reads the pending set and the
   * session row, and writes nothing at all.
   */
  readonly store: EventStore
  /**
   * The notifier. Absent means a hub with nothing to deliver to, which is counted and
   * reported rather than treated as a success (APX-FR-02) - and which is the state of
   * every build until notification-engineer constructs the platform notifier in the
   * main entry point (NT-1).
   */
  readonly notifier?: Notifier
  /**
   * The hub's live origin, read when a request is built.
   *
   * A thunk because the socket is bound after this object exists, and an empty string
   * before it does. Passing a string instead would freeze whichever origin was
   * published first, and this hub's port is chosen by a bind that can move it
   * (HC-FR-01).
   */
  readonly origin?: () => string
  /** Milliseconds since the epoch. Injectable so a test can measure a bound. */
  readonly now?: () => number
  /**
   * Reports a diagnostic line. Never called with content, a path or a token.
   */
  readonly onDiagnostic?: (message: string) => void
  /**
   * Called with every recorded attempt, including the ones that declined to try.
   *
   * This is the seam HC-6 asked for and the only thing in this module that leaves
   * it: a `delivered` outcome is the increment for `toast_deliveries`, and a caller
   * that wants to know about the other four gets them too rather than having to poll
   * `outcomes()` and notice what it missed.
   *
   * A throw from the hook is swallowed and reported, never propagated. A counter
   * write that turned a delivered notification into a failed one would be a
   * diagnostic deciding the outcome of the thing it describes (APX-FR-02), and a
   * policy that trusted a listener would have a second reason to fail.
   */
  readonly onOutcome?: (attempt: DeliveryAttemptRecord) => void
  /** Overrides for the bounds. A test lowers one; production passes none. */
  readonly attemptTimeoutMs?: number
  readonly maxOutcomeRecords?: number
  readonly replayConcurrency?: number
}

/**
 * A delivery that did not happen, as a rejection.
 *
 * Thrown only by the composition root's port adapter, never by `deliver`: the ingest
 * pipeline is built to record a throwing port as a dropped delivery with a reason
 * (HC-FR-09, APX-FR-02), and this is how a failure the policy already recorded
 * reaches that record. The message names the outcome and the reason and quotes
 * nothing from the event.
 */
export class DeliveryFailedError extends Error {
  readonly attempt: DeliveryAttemptRecord

  constructor(attempt: DeliveryAttemptRecord) {
    super(
      `the delivery was not made (${attempt.outcome}/${attempt.reason}). The event is stored and ` +
        'the pending item is unchanged, so nobody was told: this is recorded rather than reported as ' +
        'delivered (APX-FR-02).',
    )
    this.name = 'DeliveryFailedError'
    this.attempt = attempt
  }
}

/**
 * The delivery policy a hub, `doctor` and a test read.
 *
 * Six members. None of them names a harness action, none of them writes to the log,
 * and none of them can reach a session: the one mutating surface in this product is
 * the ack route (APX-CON-08), and the policy is not a route.
 */
export interface DeliveryPolicy {
  /** True when a notifier is wired. Read by health and by the ingest port adapter. */
  readonly wired: boolean
  /**
   * One attempt for one event, resolved with its outcome.
   *
   * Never throws and never rejects: every outcome, including a notifier that throws
   * and a notifier that never settles, is a resolved value with a record behind it.
   */
  deliver(request: DeliveryRequest, source?: DeliverySource): Promise<DeliveryAttemptRecord>
  /**
   * HC-FR-07's restart replay: deliver every unacknowledged pending item exactly
   * once, oldest first, in bounded concurrency.
   *
   * Resolves when the batch has settled. A notifier that is wedged cannot hold this
   * open for ever, because every attempt inside it is itself bounded.
   */
  replayPending(): Promise<DeliveryReplayReport>
  /** The per-event ledger, oldest first, bounded by `maxOutcomeRecords`. */
  outcomes(): readonly DeliveryAttemptRecord[]
  /** Counts and timestamps for the health route. Never an event. */
  status(): DeliveryStatus
  /** Drain in-flight attempts and refuse further ones. Idempotent. */
  close(): Promise<void>
}

export function createDeliveryPolicy(options: DeliveryPolicyOptions): DeliveryPolicy {
  const now = options.now ?? ((): number => Date.now())
  const diagnostic = options.onDiagnostic ?? ((): void => {})
  const origin = options.origin ?? ((): string => '')
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DELIVERY_ATTEMPT_TIMEOUT_MS
  const maxRecords = Math.max(0, options.maxOutcomeRecords ?? DELIVERY_MAX_OUTCOME_RECORDS)
  const replayConcurrency = Math.max(1, options.replayConcurrency ?? DELIVERY_REPLAY_CONCURRENCY)
  const notifier = options.notifier
  const store = options.store

  // The exactly-once guard. Event identifiers, in insertion order, for this run only.
  // A set rather than a durable record on purpose: see the header on restart replay.
  const deliveredThisRun = new Set<string>()
  const records: DeliveryAttemptRecord[] = []
  const inFlight = new Set<Promise<DeliveryAttemptRecord>>()
  const counts = {
    attempted: 0,
    delivered: 0,
    failed: 0,
    timedOut: 0,
    suppressed: 0,
    notWired: 0,
    replayed: 0,
  }
  let lastAttemptAt: string | null = null
  let lastOutcome: DeliveryOutcome | null = null
  let lastFailure: DeliveryFailureSummary | null = null
  let closed = false

  // The outcome seam. Absent means HC-6 was not wired, which is not a fault: the
  // policy's own ledger, its counts and health carry every attempt either way, and
  // the counters are a durable summary of them rather than the record itself.
  const reportOutcome = (entry: DeliveryAttemptRecord): void => {
    const hook = options.onOutcome
    if (hook === undefined) return
    try {
      hook(entry)
    } catch {
      // Reported, never propagated, and never retried: an attempt is not made
      // twice because somebody counting it was not ready (APX-CON-10).
      diagnostic(
        'delivery: an outcome listener threw while a delivery was being recorded. The attempt is ' +
          'recorded and its outcome is unchanged; a listener that fails cannot cost a notification ' +
          '(APX-FR-02).',
      )
    }
  }

  const record = (input: {
    readonly event: DeliveryRequest['event']
    readonly class: EventClass
    readonly source: DeliverySource
    readonly outcome: DeliveryOutcome
    readonly reason: DeliveryReason
    readonly elapsedMs: number
    readonly pendingCount: number
  }): DeliveryAttemptRecord => {
    const entry: DeliveryAttemptRecord = {
      at: new Date(now()).toISOString(),
      eventId: input.event.eventId,
      class: input.class,
      source: input.source,
      outcome: input.outcome,
      reason: input.reason,
      elapsedMs: input.elapsedMs,
      pendingCount: input.pendingCount,
    }
    if (records.length >= maxRecords) records.shift()
    records.push(entry)
    lastAttemptAt = entry.at
    lastOutcome = entry.outcome
    if (input.outcome === 'delivered') {
      counts.delivered += 1
      deliveredThisRun.add(entry.eventId)
    } else if (input.outcome === 'failed') {
      counts.failed += 1
    } else if (input.outcome === 'timed-out') {
      counts.timedOut += 1
    } else if (input.outcome === 'not-wired') {
      counts.notWired += 1
    } else {
      counts.suppressed += 1
    }
    if (input.source === 'restart-replay') counts.replayed += 1
    if (input.outcome !== 'delivered' && input.outcome !== 'suppressed') {
      lastFailure = { at: entry.at, eventId: entry.eventId, reason: entry.reason }
    }
    // Last, so a listener sees an attempt the policy has already fully recorded:
    // if it throws, the ledger, the counts and the health verdict are already the
    // truth and the exception cannot cost any of them.
    reportOutcome(entry)
    return entry
  }

  const runAttempt = async (request: DeliveryRequest, source: DeliverySource): Promise<DeliveryAttemptRecord> => {
    const event = request.event
    const eventClass = request.class
    const startedAt = now()

    // The closing guard is checked before the table, because "the hub has started
    // stopping" is not a function of the event, the wiring or the order: it is a
    // fourth input, and it is checked first so a delivery can never start after the
    // drain has been waited for (HC-FR-10).
    if (closed) {
      return record({
        event,
        class: eventClass,
        source,
        outcome: 'suppressed',
        reason: 'refused-while-closing',
        elapsedMs: 0,
        pendingCount: request.pendingCount,
      })
    }

    const decision = decideDelivery({
      source,
      wired: notifier !== undefined,
      deliveredBefore: deliveredThisRun.has(event.eventId),
    })
    if (decision.kind === 'skip') {
      return record({
        event,
        class: eventClass,
        source,
        outcome: decision.reason === 'not-wired' ? 'not-wired' : 'suppressed',
        reason: decision.reason,
        elapsedMs: 0,
        pendingCount: request.pendingCount,
      })
    }

    counts.attempted += 1
    const notification: NotificationRequest = {
      event,
      class: eventClass,
      pendingCount: request.pendingCount,
      repoShortName: readRepoShortName(store, event.sessionId),
      origin: origin(),
      source,
    }
    const outcome = await callNotifier(notifier, notification, attemptTimeoutMs)
    if (outcome === 'delivered') {
      return record({
        event,
        class: eventClass,
        source,
        outcome: 'delivered',
        reason: decision.reason,
        elapsedMs: now() - startedAt,
        pendingCount: request.pendingCount,
      })
    }
    if (outcome === 'failed') {
      // Reported, not swallowed, and not retried (APX-FR-02, APX-CON-10). The message
      // is deliberately absent: a notifier's error text belongs in its own log, and a
      // record this product keeps should not carry an arbitrary string.
      diagnostic(
        `delivery: the notifier failed for one event; it is stored and still pending, and the ` +
          'notification was not made (APX-FR-02)',
      )
    } else {
      diagnostic(
        `delivery: a notifier call exceeded ${attemptTimeoutMs} ms and was abandoned without a retry ` +
          '(APX-CON-10)',
      )
    }
    return record({
      event,
      class: eventClass,
      source,
      outcome,
      reason: outcome === 'failed' ? 'notifier-failed' : 'notifier-timeout',
      elapsedMs: now() - startedAt,
      pendingCount: request.pendingCount,
    })
  }

  const track = (work: Promise<DeliveryAttemptRecord>): Promise<DeliveryAttemptRecord> => {
    inFlight.add(work)
    // Removed when it settles, so `close` terminates; a wedged notifier is bounded by
    // the attempt timer rather than by this set.
    void work.then(
      (): void => {
        inFlight.delete(work)
      },
      (): void => {
        inFlight.delete(work)
      },
    )
    return work
  }

  // Declared as a `const` and referenced from its own methods' bodies rather than
  // through `this`: an object literal's methods have no guarantee about their receiver
  // once a caller destructures them, and a policy whose `replayPending` quietly stopped
  // working because somebody wrote `const { replayPending } = policy` would be a silent
  // trap. The reference is inside a function body, so it is read after initialisation.
  const policy: DeliveryPolicy = {
    wired: notifier !== undefined,

    deliver: (request: DeliveryRequest, source: DeliverySource = 'event'): Promise<DeliveryAttemptRecord> =>
      track(runAttempt(request, source)),

    replayPending: async (): Promise<DeliveryReplayReport> => {
      // The store's own pending read: the same accessor, on the same file, that the
      // tray badge uses, so a replay can never disagree with the badge about what is
      // outstanding (NT-FR-05, EL-FR-08). A read that fails is an empty report rather
      // than a thrown start: a hub that cannot read its log is already reporting
      // `degraded` on health, and refusing to start would turn a degraded daemon into
      // no daemon at all.
      let items: readonly DeliveryRequest['event'][]
      try {
        items = store.readPending()
      } catch {
        diagnostic(
          'delivery: the pending set could not be read at start, so nothing was replayed; the hub is ' +
            'serving and reports the fault on health rather than refusing to start (HC-FR-07)',
        )
        return { candidates: 0, attempted: 0, delivered: 0, failed: 0, suppressed: 0, notWired: 0 }
      }
      // No short-circuit for an empty set: an empty batch produces an empty worker pool
      // and the same all-zero report, so a guard here would be a second answer to a
      // question the code below already answers. (It was one, once, and removing it
      // changed no test - which is what a redundant branch is.)

      // One pending count for the whole batch, read once: it is the length of the set
      // being replayed, and it is what a notifier renders beside a block. Reading it
      // per item would be a second source of the badge's number for no new fact.
      const pendingCount = items.length
      const requests: DeliveryRequest[] = items.map((item) => ({
        event: item,
        class: item.class,
        pendingCount,
      }))

      const tally = { delivered: 0, failed: 0, suppressed: 0, notWired: 0 }
      // Oldest first, in bounded concurrency: the batch is ordered, and the batch size
      // keeps a restart from handing a desktop one notification per pending block in
      // the same millisecond (APX-CON-10). Every item is attempted exactly once; the
      // guard above is what makes a second attempt for the same event a record rather
      // than a second toast.
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < requests.length) {
          const request = requests[cursor]
          cursor += 1
          if (request === undefined) return
          const attempt = await policy.deliver(request, 'restart-replay')
          if (attempt.outcome === 'delivered') tally.delivered += 1
          else if (attempt.outcome === 'suppressed') tally.suppressed += 1
          else if (attempt.outcome === 'not-wired') tally.notWired += 1
          // `failed` and `timed-out` are the same fact for a report: the notification
          // was not made, and the per-event records beside it say which.
          else tally.failed += 1
        }
      }
      const workers = Array.from({ length: Math.min(replayConcurrency, requests.length) }, () => worker())
      await Promise.all(workers)
      // Every item was attempted exactly once, so `attempted` is the batch's size
      // rather than a counter that could drift from it.
      return { candidates: requests.length, attempted: requests.length, ...tally }
    },

    outcomes: (): readonly DeliveryAttemptRecord[] => [...records],

    status: (): DeliveryStatus => ({
      status: deliveryStatus(lastOutcome, notifier !== undefined),
      wired: notifier !== undefined,
      attempted: counts.attempted,
      delivered: counts.delivered,
      failed: counts.failed,
      timedOut: counts.timedOut,
      suppressed: counts.suppressed,
      notWired: counts.notWired,
      replayed: counts.replayed,
      inFlight: inFlight.size,
      lastAttemptAt,
      lastFailure,
    }),

    close: async (): Promise<void> => {
      closed = true
      while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    },
  }
  return policy
}

// ---------------------------------------------------------------------------
// The helpers
// ---------------------------------------------------------------------------

/**
 * The decision for one candidate, as a pure function of its three inputs.
 *
 * Exported and pure so the table can be enumerated by a test rather than restated,
 * and so a caller can ask the same question the policy asked without a notifier.
 * Throws rather than defaulting for a key the table does not carry: a default here
 * would be a fourth way an event could reach a notifier, which is the failure
 * NT-FR-08 and HC-FR-08 are about.
 */
export function decideDelivery(input: {
  readonly source: DeliverySource
  readonly wired: boolean
  readonly deliveredBefore: boolean
}): DeliveryDecision {
  const key: DeliveryDecisionKey = `${input.source}:${input.wired ? 'wired' : 'unwired'}:${
    input.deliveredBefore ? 'repeat' : 'first'
  }`
  const decision = DELIVERY_DECISIONS[key]
  if (decision === undefined) return unhandledDecision(key)
  return decision
}

/**
 * Call the notifier once, with a real bound, and report which of the three things
 * happened.
 *
 * `race`, not `all`: the two things that end an attempt are the notifier returning and
 * the bound expiring, and a notifier that never settles must not hold a shutdown open
 * for ever. An attempt that lost the race is abandoned, not retried, and its eventual
 * settlement is ignored - recording it would turn one attempt into two records
 * (APX-CON-10). A throw is caught and reported as a failure, because a notifier that
 * throws has not delivered anything and the requirement is that this is never silent
 * (APX-FR-02).
 */
async function callNotifier(
  notifier: Notifier | undefined,
  request: NotificationRequest,
  timeoutMs: number,
): Promise<'delivered' | 'failed' | 'timed-out'> {
  if (notifier === undefined) return 'failed'
  let timer: NodeJS.Timeout | undefined
  const bound = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timed-out')
    }, timeoutMs)
    // Not `unref`ed: an attempt is real work the hub is doing, and a shutdown that is
    // waiting for it must stay alive to finish it. The bound, not the loop, is what
    // ends it.
  })
  const attempt = (async (): Promise<'delivered' | 'failed'> => {
    try {
      await notifier(request)
      return 'delivered'
    } catch {
      return 'failed'
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  })()
  return Promise.race([attempt, bound])
}

/**
 * The repository's short name, or null.
 *
 * Read at attempt time from the session row, because the store's `EventRecord` does
 * not carry it: repository identity belongs to the session (ADR-008) and a delivery
 * that has no repository to name is still worth making, so a read that fails is null
 * rather than a failed delivery. One bounded row read, on a path no client is
 * waiting for.
 */
function readRepoShortName(store: EventStore, sessionId: string): string | null {
  try {
    return store.readSession(sessionId)?.repoShortName ?? null
  } catch {
    return null
  }
}

/**
 * The three-value status, from the most recent attempt.
 *
 * `not-wired` wins over everything, because a hub with no notifier behind the port
 * cannot deliver anything and saying `ok` would be a lie about the whole run. Then the
 * last attempt decides: a run whose most recent delivery was made is `ok` even if an
 * earlier one failed, and the failure stays visible in `failed`, `timedOut` and
 * `lastFailure`. A run with no attempt at all is `ok`, because nothing has gone wrong
 * yet, and a suppressed attempt is not a failure - declining to deliver an event this
 * run already delivered is the policy working.
 */
function deliveryStatus(
  lastOutcome: DeliveryOutcome | null,
  wired: boolean,
): 'ok' | 'degraded' | 'not-wired' {
  if (!wired) return 'not-wired'
  if (lastOutcome === 'failed' || lastOutcome === 'timed-out' || lastOutcome === 'not-wired') {
    return 'degraded'
  }
  return 'ok'
}

/**
 * A combination the table does not carry.
 *
 * Thrown rather than defaulted, for the reason `decideDelivery` says: a default would
 * be a policy nobody wrote down.
 */
function unhandledDecision(key: string): never {
  throw new Error(
    `unhandled delivery decision: "${key}". DELIVERY_DECISIONS must carry every combination of ` +
      'source, wiring and attempt order, and a default would be a fourth way an event could reach a ' +
      'notifier (NT-FR-08, HC-FR-08).',
  )
}
