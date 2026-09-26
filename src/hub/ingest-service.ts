// The ingest pipeline: one harness signal in, one stored event or one recorded
// drop out - and the caller released either way (HC-FR-04, HC-FR-08, HC-FR-09,
// ADR-002, APX-FR-02, APX-CON-10, APX-CON-11).
//
// WHAT THIS MODULE DECIDES, AND WHAT IT DOES NOT
// It decides three things and refuses to decide a fourth:
//   - what a signal is worth, by asking the classifier (never by reimplementing it)
//   - whether the event is new or a replay, by asking the store
//   - whether a block is now pending or now settled, by asking the pending
//     lifecycle
// What it does not decide is what gets delivered. That is HC-5's policy. This
// module owns the *seam*: a port the composition root injects, a bound on how
// long it may run, and a record of what it did. With no port wired - which is
// every build before HC-5 - a delivery is counted as `not-wired` rather than
// passing silently, so the seam is visible before it is used (APX-FR-02).
//
// TWO STEPS, AND THE ORDER IS THE REQUIREMENT
// `submit` does the store step and nothing else. `startDelivery` does the delivery
// step, and the route calls it *after* it has written the 202. HC-FR-04 says the
// answer comes back without waiting for delivery, and the only way that is a
// property rather than a comment is that the two steps are two calls the caller
// orders. A single `submit` that also delivered would be untestable for the
// ordering, because the assertion would be comparing a timestamp against code that
// has no second point to compare it to.
//
// DEDUPE IS THE STORE'S VERDICT, NOT A SECOND LOOKUP HERE
// Re-posting an envelope must store nothing, move no pending count and fire no
// second delivery (HC-FR-08, EL-FR-06). The store already answers that: it looks
// the dedupe key up inside the same transaction that inserts, and answers
// `duplicate` with the row it found. A hub-side pre-check would be a second thing
// to get out of step with the unique index, and the race between check and insert
// is exactly the window in which a replay becomes two events. So the pipeline calls
// the lifecycle once and reads the answer, and `already-known` is the only shape
// that may reach a delivery port - never a second time for one key.
//
// A FAILED STORE IS A RECORDED DROP, NEVER A SUCCESS (APX-FR-02)
// When the store throws, the event was not stored and the hub says so with a
// refusal; `droppedEvents()` records the fact with the stage, the reason and the
// signal's three closed tokens, and the count is kept separately from the bounded
// list so a hub that drops a thousand events in a minute still reports a thousand.
// Reporting a 202 for an event that is not in the log is the one failure this
// module is built to be unable to produce.
//
// THE BOUND, AND WHAT "TIME-BOUNDED" CAN MEAN OVER A SYNCHRONOUS DRIVER
// `better-sqlite3` is synchronous: a call into it cannot be interrupted, so a
// timeout cannot be enforced by preemption. What this module does instead is make
// the honest claim the driver allows:
//   - the *caller* is released on every path. A store that throws releases the
//     caller immediately; a store that returns releases it as soon as it has the
//     answer; a delivery is never on the caller's path at all.
//   - the elapsed time of every store step is measured against
//     `INGEST_STORE_TIMEOUT_MS`. A step that overruns is still answered with the
//     truth - the event *was* stored, so reporting a drop would be the lie this
//     module exists to avoid - and the overrun is counted and reported as a
//     diagnostic so an operator can see the hub was slower than its own budget.
//   - the *delivery* step is genuinely asynchronous, so its bound is enforced with
//     a real timer, once, with no retry (APX-CON-10).
// SQLite's own busy timeout bounds a contended file underneath all of this
// (src/storage/db.ts), and the number of rows one request can touch is bounded by
// the body cap in the route. tests/hub/ingest.test.ts asserts each of the three
// claims above against a real hub over a real socket, including a real closed
// database rather than a simulated failure.
//
// NOTHING HERE CAN HOLD CONTENT, AND NOTHING LEAVES THE PROCESS
// The only values in this module that came from a request are the signal's three
// closed tokens (harness, event name, variant) that the classifier has already
// bounded to single-line tokens, plus the class and subtype the classifier decided.
// The store step writes through the lifecycle, whose five typed accessors are the
// only way this module reaches the log. There is no raw query, no handle, no
// outbound call and no payload echo (APX-FR-01, APX-CON-12).

import type { EventClass, EventRecord, EventStore } from '../storage/eventStore.js'
import type { HarnessSignal, SignalRef, SuppressionReason } from '../domain/classify.js'
import { ClassificationError, describeSignal } from '../domain/classify.js'
import type { PendingLifecycle, PendingRecordResult } from '../domain/pending.js'
import { PendingLifecycleError, createPendingLifecycle } from '../domain/pending.js'

// ---------------------------------------------------------------------------
// The bounds
// ---------------------------------------------------------------------------

/**
 * How long the store step may take before it is reported as an overrun.
 *
 * A thousand milliseconds against a fifty millisecond p95 budget: the budget is
 * what a normal request costs, and this is the number at which something has gone
 * wrong rather than been slow. A synchronous driver cannot be interrupted, so this
 * is a watchdog rather than a cancellation, and the difference matters: a step that
 * overruns is still answered truthfully and *also* reported, which is the only
 * behaviour that is true in both directions (see the module header).
 */
export const INGEST_STORE_TIMEOUT_MS = 1_000

/**
 * How long a delivery may run.
 *
 * Two seconds, and it is never on the caller's path, so this can afford to be more
 * generous than the store bound. It is a single attempt with no retry, because a
 * hub that is failing to deliver must not turn into a hub that retries forever
 * (APX-CON-10). A delivery that exceeds it is recorded as a timeout, not retried.
 */
export const INGEST_DELIVERY_TIMEOUT_MS = 2_000

/**
 * The p95 the local ingest path is measured against (APX-CON-11).
 *
 * Declared here rather than in the test because it is a product number the code and
 * the test have to agree on, and a budget that lives only in a test is a budget that
 * stops being checked the moment the test is rewritten. Local loopback, a bounded
 * body, one classification and one SQLite write.
 */
export const INGEST_P95_BUDGET_MS = 50

/**
 * How many dropped-event records are kept in memory.
 *
 * A hundred, because this is a diagnostic tail rather than a log: what an operator
 * needs is the recent reason, and the *count* of drops is kept separately and
 * without a bound, so nothing about how many were dropped is lost. A hub that
 * cannot store events is already failing loudly; it must not also grow an array
 * while it does.
 */
export const INGEST_MAX_DROPPED_RECORDS = 100

// ---------------------------------------------------------------------------
// The delivery seam
// ---------------------------------------------------------------------------

/**
 * What the delivery policy is handed, for one newly stored event.
 *
 * The event record as the log holds it, the class the classifier decided, and the
 * pending count as the store reports it afterwards. There is no prompt, no tool
 * name, no file content and no request detail: the notifier that receives this
 * renders a title and a repository name, and it is handed nothing else to render
 * (APX-FR-01, ADR-003).
 */
export interface DeliveryRequest {
  readonly event: EventRecord
  readonly class: EventClass
  readonly pendingCount: number
}

/**
 * The notifier boundary, owned by HC-5.
 *
 * A function rather than an interface because there is one caller and one method,
 * and because a policy object here would invite a second method nobody has a use
 * for. It may return a promise; the pipeline bounds it and never awaits it on the
 * caller's path. It must not throw into the request: a throw is caught, recorded,
 * and reported.
 */
export type DeliveryPort = (request: DeliveryRequest) => Promise<void> | void

/**
 * The port used when nothing is wired (every build before HC-5).
 *
 * A named no-op rather than a default parameter of `undefined`, so a caller that
 * forgot to pass a port gets a real function and a count of `not-wired` rather than
 * a crash or a silent success.
 */
export const NOT_WIRED_DELIVERY: DeliveryPort = (): void => undefined

// ---------------------------------------------------------------------------
// What the pipeline answers
// ---------------------------------------------------------------------------

/**
 * What one accepted signal turned out to be.
 *
 * All five shapes answer 202, because all five are the same thing to a harness: the
 * hub took the signal and there is nothing for the adapter to do (HC-FR-04). They
 * are distinguished so the adapter, a test and `doctor` can tell "stored something
 * new" from "this was a replay" from "the classifier deliberately produced
 * nothing" - which are three very different facts, and reporting all three as an
 * opaque 202 is how a missing notification goes unexplained.
 *
 *   - `stored`            a new event is in the log
 *   - `pending-created`   a new needs-you event; the pending set grew by one
 *   - `resolved`          a harness resolution cleared a pending item
 *   - `nothing-pending`   a resolution for a block that is not pending; nothing changed
 *   - `no-event`          the classifier deliberately suppressed it, with the reason
 *   - `duplicate`         the log already held this dedupe key; nothing changed
 */
export type IngestOutcome =
  | 'stored'
  | 'pending-created'
  | 'resolved'
  | 'nothing-pending'
  | 'no-event'
  | 'duplicate'

/** Every outcome that stored or changed something, which is what may be delivered. */
const OUTCOMES_THAT_STORED: ReadonlySet<IngestOutcome> = new Set<IngestOutcome>([
  'stored',
  'pending-created',
])

/**
 * A signal the hub accepted.
 *
 * `ref` is the classifier's own `SignalRef` - harness, event name, variant, and
 * nothing else. It is here so a delivery that fails afterwards can record *which*
 * signal it failed for without the route having to hand the signal back a second
 * time, and it is the reason `startDelivery` needs only its argument: a caller
 * cannot record a drop against a different signal than the one it stored.
 */
export interface IngestAccepted {
  readonly ok: true
  readonly outcome: IngestOutcome
  /** The stored row, or null when nothing was stored. */
  readonly event: EventRecord | null
  /** The store's pending count after the step: the badge's single source of truth. */
  readonly pendingCount: number
  /** The class the classifier decided, or null when it produced no event. */
  readonly class: EventClass | null
  /** Why nothing was stored, for the outcomes that store nothing. */
  readonly reason: SuppressionReason | null
  /** True only for a replay: the dedupe key was already in the log (HC-FR-08). */
  readonly duplicate: boolean
  /** How long the store step took, for the overrun watchdog. */
  readonly storeElapsedMs: number
  readonly ref: SignalRef
}

/**
 * Why a signal was refused.
 *
 * Every code here is a fault of the *caller's* signal except `store-failed` and
 * `store-too-slow`, which are the hub's own. The route maps the first group to a
 * client error and the second to a 503, because the difference is the whole of
 * APX-FR-02: telling a harness "your signal was wrong" and telling it "the hub could
 * not store it" lead to different breadcrumbs in different places.
 */
export type IngestRefusalCode =
  /** A harness this product does not know. The classifier's own code. */
  | 'unknown-harness'
  /** A harness event name with no row in the classifier's table. */
  | 'unmapped-signal'
  /** A signal the classifier records as unresolved upstream. */
  | 'unresolved-signal'
  /** A value the classifier's rules reject, or a missing identity. */
  | 'invalid-signal'
  /** A resolution signal that named no block, so names no block to clear. */
  | 'unidentifiable-block'
  /** The log could not be written. The event is dropped and recorded as such. */
  | 'store-failed'
  /** A fault that is not one of the above. Reported as a 500, never swallowed. */
  | 'internal-error'

/** A refused signal. */
export interface IngestRefused {
  readonly ok: false
  readonly code: IngestRefusalCode
  /**
   * The explanation, for an operator - a diagnostic line, a log, the ledger.
   *
   * Explicitly *not* for a response body, and named so that sending it is a visible
   * mistake rather than an easy accident: the classifier's messages quote the three
   * tokens of the signal, and one of those is a string the caller chose. Sending them
   * back over the socket would put a caller-controlled value into a payload this
   * product serves (APX-FR-01). The route answers with its own fixed sentence per
   * code instead; `INGEST_REFUSAL_DETAIL` in ./ingest.ts is that table.
   */
  readonly operatorDetail: string
  readonly storeElapsedMs: number
}

export type IngestResult = IngestAccepted | IngestRefused

/** Whether a refusal is the caller's fault, which is what the status table keys on. */
export function isCallerFault(code: IngestRefusalCode): boolean {
  return code !== 'store-failed' && code !== 'internal-error'
}

// ---------------------------------------------------------------------------
// The drop record
// ---------------------------------------------------------------------------

/** Where a failure happened. */
export type DroppedEventStage = 'store' | 'delivery'

/** Why an event was dropped. Every value names a fault, never a payload. */
export type DroppedEventReason =
  /** The log could not be written. The event does not exist. */
  | 'store-failed'
  /** The delivery port threw. The event is stored; the notification was not made. */
  | 'delivery-failed'
  /** The delivery port exceeded its bound and was abandoned. */
  | 'delivery-timeout'

/**
 * One recorded drop.
 *
 * `harness` and `eventName` are the classifier's own `SignalRef` fields, which it
 * has already bounded to single-line tokens of at most 512 characters by the time a
 * store call can fail - so a pasted multi-line prompt is refused before it can reach
 * a record here, and what is recorded is an identity rather than a payload
 * (APX-FR-01, OA-FR-05). The record is in-process and is never serialised into a
 * response; HC-5 is where a count of it belongs on health.
 */
export interface DroppedEventRecord {
  readonly at: string
  readonly stage: DroppedEventStage
  readonly reason: DroppedEventReason
  readonly harness: string
  readonly eventName: string
  /** The ref's variant, or null when the signal named none. */
  readonly variant: string | null
  readonly elapsedMs: number
}

/** How many deliveries were attempted and what became of them. */
export interface DeliveryStats {
  readonly attempted: number
  /** The port returned normally. */
  readonly delivered: number
  /** The port threw. Recorded as a drop with stage `delivery`. */
  readonly failed: number
  /** The port exceeded `INGEST_DELIVERY_TIMEOUT_MS` and was abandoned. */
  readonly timedOut: number
  /** No port is wired yet (every build before HC-5). Never a silent success. */
  readonly notWired: number
}

/** Everything the service counts, for tests, `doctor` and HC-5. */
export interface IngestStats {
  readonly submitted: number
  readonly stored: number
  readonly duplicates: number
  readonly suppressed: number
  /** Pending items this run created and cleared, for a sanity check against the log. */
  readonly resolved: number
  /** Every event that was not stored, and every delivery that did not happen. */
  readonly dropped: number
  /** Store steps that took longer than `INGEST_STORE_TIMEOUT_MS`. */
  readonly storeOverruns: number
  readonly slowestStoreMs: number
  readonly deliveries: DeliveryStats
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface IngestServiceOptions {
  /**
   * The log this hub writes. The composition root passes the store already wrapped
   * for the live stream, so an ingested event becomes a change frame without this
   * module knowing the stream exists.
   */
  readonly store: EventStore
  /**
   * The delivery policy's port. Absent means "not wired yet", which is counted
   * rather than treated as a success.
   */
  readonly delivery?: DeliveryPort
  /** True when `delivery` is the real port. Recorded, so the stats cannot mislead. */
  readonly deliveryWired?: boolean
  /** Milliseconds since the epoch. Injectable so a test can measure an overrun. */
  readonly now?: () => number
  /** Reports a diagnostic line. Never called with content, a path or a token. */
  readonly onDiagnostic?: (message: string) => void
  /** Overrides for the bounds. A test lowers one; production passes none. */
  readonly storeTimeoutMs?: number
  readonly deliveryTimeoutMs?: number
  readonly maxDroppedRecords?: number
}

/**
 * The pipeline a route drives.
 *
 * Two methods that must be called in order, plus the reads a test and `doctor`
 * need. There is no method that names a harness action, no method that reads an
 * event by identifier and no method that returns the store: nothing here can steer,
 * prompt, interrupt or approve anything inside a harness (APX-CON-08), and the only
 * durable effect is an appended event, which is what ADR-002 permits ingest to do.
 */
export interface IngestService {
  /**
   * The store step: classify, dedupe, record, and time it. Never starts delivery.
   *
   * Every outcome is a resolved promise, including every fault. A caller that awaits
   * this is released on the first turn of the event loop after the store answered,
   * whether the answer was a new event, a replay, a suppression, a client fault or a
   * store failure (HC-FR-09).
   */
  submit(signal: HarnessSignal): Promise<IngestResult>
  /**
   * The delivery step, for a result `submit` produced.
   *
   * The route calls this after it has answered, and never awaits it. A result that
   * stored nothing is a no-op, which is what makes "a replay fires no second
   * delivery" a property of this method rather than a rule a caller has to
   * remember (HC-FR-08).
   */
  startDelivery(result: IngestResult): void
  /** Resolves when no delivery is in flight. Bounded by the delivery timeout. */
  idle(): Promise<void>
  /** The recorded drops, oldest first, bounded by `maxDroppedRecords`. */
  droppedEvents(): readonly DroppedEventRecord[]
  /** Counts only. No event, no content, nothing to echo. */
  stats(): IngestStats
  /** Drain in-flight deliveries and refuse further ones. Idempotent. */
  close(): Promise<void>
}

export function createIngestService(options: IngestServiceOptions): IngestService {
  const now = options.now ?? ((): number => Date.now())
  const diagnostic = options.onDiagnostic ?? ((): void => {})
  const storeTimeoutMs = options.storeTimeoutMs ?? INGEST_STORE_TIMEOUT_MS
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? INGEST_DELIVERY_TIMEOUT_MS
  const maxDropped = Math.max(0, options.maxDroppedRecords ?? INGEST_MAX_DROPPED_RECORDS)
  const delivery: DeliveryPort = options.delivery ?? NOT_WIRED_DELIVERY
  const deliveryWired = options.deliveryWired ?? options.delivery !== undefined

  const lifecycle: PendingLifecycle = createPendingLifecycle(options.store)

  const dropped: DroppedEventRecord[] = []
  const inFlight = new Set<Promise<void>>()
  const stats = {
    submitted: 0,
    stored: 0,
    duplicates: 0,
    suppressed: 0,
    resolved: 0,
    dropped: 0,
    storeOverruns: 0,
    slowestStoreMs: 0,
    attempted: 0,
    delivered: 0,
    failed: 0,
    timedOut: 0,
    notWired: 0,
  }
  let closed = false

  const recordDrop = (
    stage: DroppedEventStage,
    reason: DroppedEventReason,
    ref: SignalRef,
    elapsedMs: number,
  ): void => {
    stats.dropped += 1
    if (dropped.length >= maxDropped) dropped.shift()
    dropped.push({
      at: new Date(now()).toISOString(),
      stage,
      reason,
      // Already bounded: the classifier checks these before the store is ever called.
      harness: ref.harness,
      eventName: ref.eventName,
      variant: ref.variant,
      elapsedMs,
    })
  }

  /**
   * The store step, and nothing else.
   *
   * Returns the answer rather than throwing: every outcome the caller has to answer
   * differently is a value here, so a route that awaits this cannot accidentally treat
   * a fault as a success (HC-FR-09).
   */
  const runStoreStep = (signal: HarnessSignal): IngestResult => {
    const startedAt = now()
    let recorded: PendingRecordResult
    try {
      // The single path from a signal to the durable log (EL-4). It classifies,
      // deduplicates through the store's own verdict, and opens or resolves the
      // pending item - none of which this file reimplements.
      recorded = lifecycle.record(signal)
    } catch (cause) {
      const elapsed = now() - startedAt
      const refused = refusalFrom(cause, elapsed)
      if (isCallerFault(refused.code)) {
        // A refused signal is a fact the harness needs to see and the operator needs
        // to have: an unmapped event name is an accident upstream, and the
        // requirement is that it is never silently dropped (APX-FR-02). The line
        // carries the classifier's own explanation, which quotes the signal's three
        // closed tokens and no value (src/domain/classify.ts).
        diagnostic(`ingest refused a signal: ${refused.operatorDetail}`)
      } else {
        // A store failure is the one fault this pipeline records as a drop, because
        // it is the one that means an event the harness believes was delivered is
        // not in the log (APX-FR-02). A classification fault is the caller's, and
        // nothing was ever going to be stored, so it is not a drop.
        recordDrop('store', 'store-failed', describeSignal(signal), elapsed)
      }
      return refused
    }

    const elapsed = now() - startedAt
    stats.slowestStoreMs = Math.max(stats.slowestStoreMs, elapsed)
    if (elapsed > storeTimeoutMs) {
      // Reported, not refused: the event *is* stored, and answering a stored event
      // with a failure would tell a harness its block was lost when it was not. The
      // overrun is the operator's signal that this hub is slower than its budget.
      stats.storeOverruns += 1
      diagnostic(
        `ingest: the store step took ${elapsed} ms, past the ${storeTimeoutMs} ms bound; ` +
          'the event was stored and the caller was released',
      )
    }

    const accepted = acceptedFrom(recorded, elapsed, describeSignal(signal))
    if (accepted.outcome === 'duplicate') stats.duplicates += 1
    else if (accepted.outcome === 'no-event' || accepted.outcome === 'nothing-pending') {
      stats.suppressed += 1
    } else if (accepted.outcome === 'resolved') stats.resolved += 1
    else stats.stored += 1
    return accepted
  }

  /**
   * The delivery step: one attempt, bounded once, never retried.
   *
   * Not awaited by anyone on the request path. The timer is the real bound, which is
   * why it can be enforced here at all where the store's cannot (see the header).
   */
  const runDelivery = (request: DeliveryRequest, ref: SignalRef): void => {
    if (closed) return
    stats.attempted += 1
    if (!deliveryWired) {
      // Visible rather than silent: until HC-5 wires the notifier, "we did not
      // deliver" is a fact an operator can see instead of a bug they infer later.
      stats.notWired += 1
      return
    }
    const startedAt = now()
    let timer: NodeJS.Timeout | undefined
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        // Abandoned, once, with no retry. A delivery still running after its bound
        // must not become a retry storm against a failing notifier (APX-CON-10).
        stats.timedOut += 1
        recordDrop('delivery', 'delivery-timeout', ref, now() - startedAt)
        diagnostic('ingest: a delivery exceeded its bound and was abandoned without a retry')
        resolve()
      }, deliveryTimeoutMs)
      timer.unref?.()
    })
    const attempt = (async (): Promise<void> => {
      try {
        await delivery(request)
        stats.delivered += 1
      } catch {
        // A notifier that throws is a delivery failure and it is never silent: the
        // event is stored and the pending set is correct, but nobody was told
        // (APX-FR-02). The record says so; HC-5 puts the count on health.
        stats.failed += 1
        recordDrop('delivery', 'delivery-failed', ref, now() - startedAt)
        diagnostic(
          'ingest: the delivery port failed; the event is stored and the delivery was not made',
        )
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    })()
    // `race`, not `all`: the two things that end a delivery are the attempt finishing
    // and the bound expiring, and a port that never settles must not hold `idle` - and
    // therefore a shutdown - open for ever. `attempt` catches everything it can throw,
    // so losing the race leaves a promise that is still harmless when it settles.
    const tracked = Promise.race([attempt, bound]).then((): void => undefined)
    inFlight.add(tracked)
    void tracked.then((): void => {
      inFlight.delete(tracked)
    })
  }

  /**
   * Resolve once nothing is in flight.
   *
   * Each tracked promise is bounded by the delivery timeout and removed from the set
   * when it settles, so this terminates; the loop is there because a delivery started
   * while the first was draining must be waited for too.
   */
  const idle = async (): Promise<void> => {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight])
  }

  return {
    submit: (signal: HarnessSignal): Promise<IngestResult> => {
      stats.submitted += 1
      if (closed) {
        // A hub that is shutting down refuses new events rather than half-storing
        // one (HC-FR-10). The refusal is a store fault because that is the truth from
        // the caller's side: the event was not stored, and the harness should report
        // it as dropped rather than assume it arrived (APX-FR-02).
        recordDrop('store', 'store-failed', describeSignal(signal), 0)
        return Promise.resolve({
          ok: false,
          code: 'store-failed',
          operatorDetail:
            'the hub is shutting down and is not accepting events: this one was not stored, so the ' +
            'harness should report it as dropped rather than assume it arrived (HC-FR-10, APX-FR-02).',
          storeElapsedMs: 0,
        } satisfies IngestRefused)
      }
      // A synchronous pipeline behind a promise, so the route has one awaitable shape
      // for every outcome and the caller's release is the same in all of them.
      return Promise.resolve(runStoreStep(signal))
    },

    startDelivery: (result: IngestResult): void => {
      if (!result.ok) return
      if (result.event === null) return
      if (!OUTCOMES_THAT_STORED.has(result.outcome)) return
      if (result.duplicate) return
      runDelivery(
        {
          event: result.event,
          class: result.class ?? result.event.class,
          pendingCount: result.pendingCount,
        },
        result.ref,
      )
    },

    idle,

    droppedEvents: (): readonly DroppedEventRecord[] => [...dropped],

    stats: (): IngestStats => ({
      submitted: stats.submitted,
      stored: stats.stored,
      duplicates: stats.duplicates,
      suppressed: stats.suppressed,
      resolved: stats.resolved,
      dropped: stats.dropped,
      storeOverruns: stats.storeOverruns,
      slowestStoreMs: stats.slowestStoreMs,
      deliveries: {
        attempted: stats.attempted,
        delivered: stats.delivered,
        failed: stats.failed,
        timedOut: stats.timedOut,
        notWired: stats.notWired,
      },
    }),

    close: async (): Promise<void> => {
      closed = true
      await idle()
    },
  }
}

// ---------------------------------------------------------------------------
// The two mappings
// ---------------------------------------------------------------------------

/**
 * The lifecycle's answer, in the pipeline's vocabulary.
 *
 * Every cell is written out rather than derived, so a sixth `PendingRecordResult`
 * kind is a compile error here instead of an outcome that quietly arrives with no
 * delivery and no count. `event-stored` and `pending-created` are the two that grow
 * the log; `already-known` is the replay; `no-event` and `nothing-pending` stored
 * nothing at all.
 */
function acceptedFrom(
  recorded: PendingRecordResult,
  storeElapsedMs: number,
  ref: SignalRef,
): IngestAccepted {
  switch (recorded.kind) {
    case 'pending-created':
      return {
        ok: true,
        outcome: 'pending-created',
        event: recorded.event,
        pendingCount: recorded.pendingCount,
        class: 'needs-you',
        reason: null,
        duplicate: false,
        storeElapsedMs,
        ref,
      }
    case 'event-stored':
      return {
        ok: true,
        outcome: 'stored',
        event: recorded.event,
        pendingCount: recorded.pendingCount,
        class: recorded.event.class,
        reason: null,
        duplicate: false,
        storeElapsedMs,
        ref,
      }
    case 'already-known':
      return {
        ok: true,
        outcome: 'duplicate',
        event: recorded.event,
        pendingCount: recorded.pendingCount,
        class: recorded.event.class,
        reason: null,
        duplicate: true,
        storeElapsedMs,
        ref,
      }
    case 'pending-resolved':
      return {
        ok: true,
        outcome: 'resolved',
        event: recorded.event,
        pendingCount: recorded.transition.pendingCountAfter,
        class: 'needs-you',
        reason: null,
        duplicate: false,
        storeElapsedMs,
        ref,
      }
    case 'nothing-pending':
      return {
        ok: true,
        outcome: 'nothing-pending',
        event: null,
        pendingCount: recorded.pendingCount,
        class: null,
        reason: null,
        duplicate: false,
        storeElapsedMs,
        ref,
      }
    case 'no-event':
      return {
        ok: true,
        outcome: 'no-event',
        event: null,
        pendingCount: recorded.pendingCount,
        class: null,
        reason: recorded.reason,
        duplicate: false,
        storeElapsedMs,
        ref,
      }
    default:
      return unhandledRecordResult(recorded)
  }
}

/**
 * A thrown fault, in the pipeline's vocabulary.
 *
 * Both typed errors carry a code and a message that quotes no value, so both can be
 * reported as-is. `store-failed` is for everything else that came out of the store,
 * and `internal-error` is the honest answer for a fault nobody anticipated: it is
 * reported as a 500 and recorded, never swallowed into a 202.
 */
function refusalFrom(cause: unknown, storeElapsedMs: number): IngestRefused {
  if (cause instanceof ClassificationError) {
    return { ok: false, code: cause.code, operatorDetail: cause.message, storeElapsedMs }
  }
  if (cause instanceof PendingLifecycleError) {
    return { ok: false, code: cause.code, operatorDetail: cause.message, storeElapsedMs }
  }
  // A store fault carries no message forward. A SQLite error text contains the
  // statement and the file path, and a response body built from one would leak both
  // the machine's directory layout and the log's shape (APX-FR-01).
  return {
    ok: false,
    code: 'store-failed',
    operatorDetail:
      'the durable log could not be written, so this event was not stored: it is recorded as dropped ' +
      'rather than reported as delivered, and the harness should show a breadcrumb (APX-FR-02, HC-FR-09).',
    storeElapsedMs,
  }
}

/**
 * A `PendingRecordResult` this file has never seen.
 *
 * Thrown rather than defaulted. A default here would be an outcome that reaches a
 * delivery port with no event in it, or one that stores something and reports
 * nothing, and both are the failure APX-FR-02 names.
 */
function unhandledRecordResult(recorded: PendingRecordResult): never {
  throw new Error(
    `unhandled pending record result: ${JSON.stringify(recorded.kind)}. Every kind the lifecycle ` +
      'reports must be mapped here; an unmapped kind would be an event that was stored and never ' +
      'reported, or a delivery with no event to deliver (APX-FR-02).',
  )
}
