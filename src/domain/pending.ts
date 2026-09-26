// The pending lifecycle: the one state machine a block passes through, and the
// single source of truth the tray badge and the dashboard will read (EL-FR-08,
// PRD 10, ADR-003, ADR-004, APX-CON-08).
//
// WHAT THIS MODULE IS
// A block arrives, it is pending, and it stops being pending when the harness
// reports the block resolved or the developer acknowledges it. Those are the only
// two exits. There is no timeout, no dismissal, no snooze and no mute, because a
// block that could be forgotten silently is the one failure this product exists to
// prevent (NT-FR-06), and a third exit would be that failure wearing a
// requirement number.
//
// The two exits are recorded as two independent facts rather than one state, so
// history can show which one happened (src/storage/schema.sql, EL-FR-08, and the
// feature document's Open Question 2). A block the harness resolved after the
// developer acknowledged it is a block with both facts recorded, not a row that
// lost one of them; the transition table below names that case separately
// (`resolution-after-acknowledgement`) because it is a different answer from
// "the harness cleared a pending item".
//
// WHY THE STATE IS NOT IN MEMORY
// The lifecycle object holds no pending state of its own. Every read goes to the
// store and every fact is a column in the durable log, which is what makes
// EL-FR-08's "it survives hub restart unchanged" a property of this design rather
// than a thing a restart test has to be careful about: a restarted hub builds a
// new lifecycle over the same file and reports the identical set, because the set
// was never anywhere else. A module-level cache would be the natural bug here, and
// tests/domain/pending.test.ts asserts against one in two ways - a source scan
// that refuses a mutable module-level binding or a Map, and a behaviour test that
// two lifecycles over two different files disagree.
//
// WHERE A RESOLUTION IS ADDRESSED
// A resolution arrives as a harness signal, not as a row key, so the lifecycle
// resolves the block through the one identity both sides share: the dedupe key
// the classifier derives from the block identifier (src/domain/classify.ts,
// EL-FR-07). An adapter must therefore report the same block identifier on
// `permission.replied` that it reported on `permission.asked` (connector-engineer,
// OA-1/CP-4), and a signal that reports no block identifier is a loud failure
// rather than a key built from a timestamp - the same rule the classifier applies
// to an event that classifies without an identity.
//
// A signal whose block is not in the pending set reports `nothing-pending` and
// changes nothing. That covers both readings honestly, because for a resolution
// they lead to the same action: the block is already settled, or no block with
// that key was ever recorded. The store still allows a resolution to be recorded
// for a block that was already acknowledged, and `reportResolved(eventId)` reaches
// it by row key, because the hub's replay path addresses rows rather than signals.
//
// THE ONLY MUTATION A CLIENT CAN REACH (APX-CON-08)
// Exactly one mutating route exists in this product, the ack route, and it can
// only mark a pending item acknowledged. So `acknowledge` is the one method here
// that changes what a developer has dealt with, and it is the one method whose
// only effect is a column flip: the store's update is guarded to
// `class = 'needs-you'`, so acknowledging a finished or fyi row is refused with a
// distinguishable `rejected` / `not-a-pending-item` result and writes nothing.
// Nothing in this module can spawn, steer, interrupt, prompt or approve anything
// inside a harness, and there is no method that could: a resolution is a fact the
// harness has already reported, never an instruction sent to one.
//
// THE ANSWERS ARE A TABLE, NOT A CHAIN OF BRANCHES
// A transition's answer is a function of two things: which exit is being taken,
// and what the store reports about the row afterwards - the verdict it returned
// and the state the row is now in. All three are closed sets
// (PENDING_TRANSITIONS, and the store's own four answers, with PENDING_ROW_STATES),
// and every combination they can produce is written out in
// PENDING_TRANSITION_OUTCOMES, so tests/domain/pending.test.ts enumerates the table
// rather than restating the implementation. The verdict is carried as well as the
// row because the row alone cannot tell "I cleared this block" from "this block
// was already cleared", and that difference is the double count EL-FR-08 forbids.
//
// The four outcomes, and what a caller does with each:
//   - applied    the fact is newly recorded, or the block left the pending set
//   - unchanged  it was already recorded: the explicit idempotent no-op, never a
//                second count (HC-FR-08, EL-FR-08)
//   - rejected   the row is in a state this exit cannot apply to. HC-FR-05's
//                "conflict" is this outcome; the reason says which state
//   - not-found  no such row
//
// Every transition result carries the pending count before and after, so "never
// double-counts" is a number in the result a caller can publish to the badge
// rather than a promise in a comment. The count is derived from the store's
// pending read at each end; nothing is accumulated here, because a counter in
// this module is a second copy of the badge's single source of truth (NT-FR-05,
// and the same reason src/storage/counters.ts does not store it).
//
// WHAT CROSSES THIS BOUNDARY
// Harness, repository short name and full path, session identifier, event class
// and optional subtype, raw event type, dedupe key, occurrence and receipt
// timestamps, and acknowledgement or resolution state. There is no field here
// capable of holding a prompt, a response, tool output or file content, and this
// module adds no column and no envelope field to make any of its answers durable:
// it writes through the store's five typed accessors and no SQL of its own, which
// tests/domain/pending.test.ts asserts from the source. Nothing here opens a
// socket, spawns a process or renders a surface, and no value is ever sent
// anywhere (APX-CON-12).

import type { HarnessSignal, SuppressionReason, SignalRef } from './classify.js'
import { classify, deriveDedupeKey, describeSignal } from './classify.js'
import type { EventRecord, EventStore, MutationResult, PendingItem } from '../storage/eventStore.js'

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * The two exits from pending, and nothing else (EL-FR-08).
 *
 * `resolution` is the harness reporting a fact; `acknowledgement` is the developer
 * recording that they have seen it. A third exit would be a third way to forget a
 * block.
 */
export const PENDING_TRANSITIONS = ['resolution', 'acknowledgement'] as const

export type PendingTransition = (typeof PENDING_TRANSITIONS)[number]

/**
 * What a row can be once a transition has been attempted, which is half of the
 * answer table's key. The other half is what the store reports it did.
 *
 * `pending` is deliberately not one of them, and that is exactly why the verdict
 * is carried alongside: after an attempt a row is never still pending - a
 * transition that changed something moved it out of pending, and one that changed
 * nothing found it already out. Reading the row alone would make "I cleared this
 * block" and "this block was already cleared" look identical, which is the double
 * count EL-FR-08 forbids (HC-FR-08). So the input is the pair: what changed, and
 * what the row now is.
 *
 * `acknowledged-and-resolved` is separate from `acknowledged` for the same
 * reason: the two facts are recorded independently (src/storage/schema.sql), and a
 * resolution arriving second is a different answer from a resolution that was
 * already recorded.
 */
export const PENDING_ROW_STATES = [
  'no-row',
  'not-a-block',
  'resolved',
  'acknowledged',
  'acknowledged-and-resolved',
] as const

export type PendingRowState = (typeof PENDING_ROW_STATES)[number]

/** What a transition did. The four answers, in the order a caller reads them. */
export type PendingTransitionOutcome = 'applied' | 'unchanged' | 'rejected' | 'not-found'

/**
 * Which answer, in words.
 *
 * Named rather than derived from the outcome alone because two rejections are not
 * the same answer: a block the harness already resolved is a conflict the ack
 * route reports as such (HC-FR-05), and an identifier that names a finished event
 * is a caller that addressed the wrong row. `resolution-after-acknowledgement` is
 * the other distinction worth keeping: the block had already left the pending set,
 * and the resolution records a fact without clearing anything a second time.
 */
export type PendingTransitionReason =
  | 'harness-reported-resolution'
  | 'developer-acknowledgement'
  | 'resolution-after-acknowledgement'
  | 'already-resolved'
  | 'already-acknowledged'
  | 'already-resolved-by-harness'
  | 'not-a-pending-item'
  | 'no-such-item'

/** One cell of the answer table. */
export interface PendingTransitionShape {
  readonly outcome: PendingTransitionOutcome
  readonly reason: PendingTransitionReason
}

/**
 * Every combination a transition can produce, written out: a transition, the
 * store's own verdict, and the row's state afterwards.
 *
 * Twelve cells rather than the cross product of the three unions, because most of
 * that product cannot happen: an acknowledgement is never applied to a row that
 * was already acknowledged, and a resolution is never a conflict about a row that
 * is still pending. This union is the reachable set, so the table's type is total
 * over exactly what the store can hand back - a missing cell is a compile error,
 * and so is a cell for something that cannot occur. tests/domain/pending.test.ts
 * enumerates the real scenarios and checks the set they produce against this set,
 * which is what keeps the two from drifting.
 */
export type PendingTransitionKey =
  | 'resolution:applied:resolved'
  | 'resolution:applied:acknowledged-and-resolved'
  | 'resolution:unchanged:resolved'
  | 'resolution:unchanged:acknowledged-and-resolved'
  | 'resolution:conflict:not-a-block'
  | 'resolution:not-found:no-row'
  | 'acknowledgement:applied:acknowledged'
  | 'acknowledgement:unchanged:acknowledged'
  | 'acknowledgement:unchanged:acknowledged-and-resolved'
  | 'acknowledgement:conflict:resolved'
  | 'acknowledgement:conflict:not-a-block'
  | 'acknowledgement:not-found:no-row'

/**
 * Every transition answer, as data.
 *
 * The three lines that are not obvious:
 *
 *   - `resolution:applied:acknowledged-and-resolved` is a second fact, not a
 *     second clearing. A resolution is recorded whether or not the developer has
 *     already acknowledged the block, and reporting it as a no-op would drop that
 *     fact on the floor.
 *   - `acknowledgement:conflict:resolved` is `rejected`, not `unchanged`. The
 *     developer is acknowledging a decision the harness already took, so the
 *     answer is a conflict the ack route can report (HC-FR-05), and nothing is
 *     written.
 *   - The `unchanged` rows are the idempotent no-ops, and their pending counts are
 *     equal by construction: the count is read from the store at each end rather
 *     than accumulated here, so a repeat cannot move it.
 */
export const PENDING_TRANSITION_OUTCOMES: Readonly<Record<PendingTransitionKey, PendingTransitionShape>> = {
  'resolution:applied:resolved': { outcome: 'applied', reason: 'harness-reported-resolution' },
  'resolution:applied:acknowledged-and-resolved': {
    outcome: 'applied',
    reason: 'resolution-after-acknowledgement',
  },
  'resolution:unchanged:resolved': { outcome: 'unchanged', reason: 'already-resolved' },
  'resolution:unchanged:acknowledged-and-resolved': { outcome: 'unchanged', reason: 'already-resolved' },
  'resolution:conflict:not-a-block': { outcome: 'rejected', reason: 'not-a-pending-item' },
  'resolution:not-found:no-row': { outcome: 'not-found', reason: 'no-such-item' },
  'acknowledgement:applied:acknowledged': { outcome: 'applied', reason: 'developer-acknowledgement' },
  'acknowledgement:unchanged:acknowledged': { outcome: 'unchanged', reason: 'already-acknowledged' },
  'acknowledgement:unchanged:acknowledged-and-resolved': { outcome: 'unchanged', reason: 'already-acknowledged' },
  'acknowledgement:conflict:resolved': { outcome: 'rejected', reason: 'already-resolved-by-harness' },
  'acknowledgement:conflict:not-a-block': { outcome: 'rejected', reason: 'not-a-pending-item' },
  'acknowledgement:not-found:no-row': { outcome: 'not-found', reason: 'no-such-item' },
}

/**
 * One transition, as the hub and the tray read it.
 *
 * Every field is display-ready: the dashboard renders the reason, the ack route
 * maps the outcome to a status, and the badge takes the count. `event` is the row
 * as it stands after the attempt, or null when there is no such row, so a caller
 * never has to re-read to render the answer.
 */
export interface PendingTransitionResult {
  /** Which exit this result is about, echoed so a mixed-up log line is visible. */
  readonly transition: PendingTransition
  readonly outcome: PendingTransitionOutcome
  readonly reason: PendingTransitionReason
  readonly event: EventRecord | null
  /** The pending count immediately before the attempt: the badge's old value. */
  readonly pendingCountBefore: number
  /** The pending count immediately after: the badge's new value. */
  readonly pendingCountAfter: number
}

/**
 * What one harness signal was worth to the lifecycle.
 *
 * Six kinds, and the kind is the whole answer, so a caller branches once:
 *
 *   - `pending-created`  a needs-you event is now pending. The only kind that
 *                        grows the pending set.
 *   - `event-stored`     a finished or fyi event was recorded. Never pending, and
 *                        never able to clear anything (EL-FR-08).
 *   - `already-known`    a replay of an event already in the log: no new row, no
 *                        count change, no second delivery (HC-FR-08).
 *   - `pending-resolved` a resolution signal cleared a pending block. Carries the
 *                        transition result, whose `pendingCountAfter` is the count
 *                        here - deliberately not repeated as a second field.
 *   - `nothing-pending`  a resolution signal for a block that is not pending.
 *   - `no-event`         the classifier deliberately produced no event, with the
 *                        reason that says which gate applied (EL-FR-05).
 */
export type PendingRecordResult =
  | { readonly kind: 'pending-created'; readonly event: EventRecord; readonly pendingCount: number }
  | { readonly kind: 'event-stored'; readonly event: EventRecord; readonly pendingCount: number }
  | { readonly kind: 'already-known'; readonly event: EventRecord; readonly pendingCount: number }
  | {
      readonly kind: 'pending-resolved'
      readonly event: EventRecord
      readonly transition: PendingTransitionResult
    }
  | { readonly kind: 'nothing-pending'; readonly pendingCount: number }
  | {
      readonly kind: 'no-event'
      readonly reason: SuppressionReason
      readonly detail: string
      readonly pendingCount: number
    }

/**
 * The lifecycle a hub, a tray or a dashboard read.
 *
 * Five methods, all synchronous, and one of them is a mutation a client can reach
 * (APX-CON-08). There is no raw query, no database handle and no method that
 * names a harness action, so the surface cannot grow a way to steer, prompt or
 * approve anything inside one.
 */
export interface PendingLifecycle {
  /**
   * Classify one harness signal and route its answer into the log.
   *
   * The single path from a signal to the durable log, and the only place a
   * resolution is turned into a cleared pending item - an adapter that stored the
   * classified event itself would have to reimplement that routing, and a second
   * routing is a second thing to drift (HC-3, OA-1).
   *
   * Throws `ClassificationError` for a signal with no row in the classifier's
   * table, for a signal recorded as unresolved upstream, and for one the rules
   * reject: an unmapped signal is an accident and a suppressed one is a decision,
   * and only the table can tell them apart (APX-FR-02). Throws
   * `PendingLifecycleError` for a resolution signal that reports no block
   * identifier. Neither is caught here, because a lifecycle that swallowed them
   * would turn both into silence.
   */
  record(signal: HarnessSignal): PendingRecordResult
  /**
   * The pending set: unresolved, unacknowledged needs-you items, oldest first.
   *
   * The tray badge's and the dashboard's single source of truth (NT-FR-05,
   * LD-FR-08). It is the store's own read, not a second definition of "pending"
   * maintained here, so a rule that changes the set in the store changes it here.
   */
  readPending(): readonly PendingItem[]
  /** How many items are pending. Derived from the same read, never accumulated. */
  pendingCount(): number
  /**
   * Record that the harness reported this block resolved.
   *
   * Addressed by row key, which is how the hub's replay and recovery paths address
   * a block. Idempotent: a second call for the same block reports `unchanged` and
   * writes nothing. It never clears anything a resolution cannot clear, and never
   * clears a block twice.
   */
  reportResolved(eventId: string): PendingTransitionResult
  /**
   * Record that the developer acknowledged this pending item.
   *
   * The one mutation a client request can reach (APX-CON-08, HC-FR-05). Idempotent,
   * and a rejected request writes nothing: acknowledging a block the harness
   * already resolved reports `rejected` with a reason the ack route can turn into
   * a conflict, and acknowledging anything that is not a pending item reports
   * `rejected` / `not-a-pending-item` without touching the row.
   */
  acknowledge(eventId: string): PendingTransitionResult
}

/**
 * Why a lifecycle call could not be made at all.
 *
 * The message names the signal by its three tokens and the rule it broke, and
 * quotes no value: a failure message is written to a log or shown in a breadcrumb
 * (OA-FR-05, IO-FR-09), and a rejected block identifier could be a pasted prompt.
 */
export type PendingLifecycleErrorCode =
  /** A resolution signal that reported no block identifier, so names no block. */
  | 'unidentifiable-block'

export class PendingLifecycleError extends Error {
  readonly code: PendingLifecycleErrorCode
  readonly signal: SignalRef

  constructor(code: PendingLifecycleErrorCode, signal: SignalRef, message: string) {
    super(message)
    this.name = 'PendingLifecycleError'
    this.code = code
    this.signal = signal
  }
}

/**
 * Build a lifecycle over a store the caller already owns.
 *
 * The store is passed in rather than opened here, for two reasons. The hub is
 * already holding the log open for its read routes and its ingest pipeline, and a
 * second connection to the same file would be a second writer nobody asked for.
 * And the lifecycle needs nothing from the store beyond its five typed accessors,
 * so it depends on the store as a type only: this module is built into the same
 * bundle as the classifier, and a plugin inside a harness that imports
 * classify.js and envelope.js still loads no database driver
 * (tests/domain/classify.test.ts asserts that relation).
 *
 * The returned object is stateless. Two lifecycles over the same file are
 * interchangeable, and one over an empty file reports an empty set however full
 * the log it no longer holds was.
 */
export function createPendingLifecycle(store: EventStore): PendingLifecycle {
  const readPending = (): readonly PendingItem[] => store.readPending()
  const pendingCount = (): number => readPending().length

  /**
   * The one place a transition is performed, so the two exits cannot drift in
   * their before-and-after accounting.
   *
   * The count is read at each end rather than carried through, which is what makes
   * a duplicated call provably a no-op: the second call's `pendingCountBefore` is
   * already the count the first call produced, so `pendingCountBefore` equals
   * `pendingCountAfter` on the repeat and there is nothing to accumulate.
   */
  const transition = (kind: PendingTransition, eventId: string): PendingTransitionResult => {
    const before = pendingCount()
    const mutation = kind === 'resolution' ? store.markResolved(eventId) : store.markAcknowledged(eventId)
    const shape = lookupTransition(transitionKey(kind, mutation))
    return {
      transition: kind,
      outcome: shape.outcome,
      reason: shape.reason,
      event: mutation.event,
      pendingCountBefore: before,
      pendingCountAfter: pendingCount(),
    }
  }

  return {
    record: (signal: HarnessSignal): PendingRecordResult => {
      const classified = classify(signal)
      if (classified.outcome === 'no-event') {
        // A resolution is not a class event (the classifier says so in as many
        // words), so this is where it does its actual work: it clears the pending
        // item the block identifier names.
        if (classified.reason === 'block-resolved') return resolveBlockSignal(signal)
        return {
          kind: 'no-event',
          reason: classified.reason,
          detail: classified.detail,
          pendingCount: pendingCount(),
        }
      }

      const stored = store.insertEvent(classified.event)
      const pendingCountAfter = pendingCount()
      if (stored.outcome === 'duplicate') {
        // A replayed signal: the row is already there and the count has not moved,
        // so reporting it as anything that grew the set would double-count the
        // block and re-fire its delivery (HC-FR-08).
        return { kind: 'already-known', event: stored.event, pendingCount: pendingCountAfter }
      }
      return classified.event.class === 'needs-you'
        ? { kind: 'pending-created', event: stored.event, pendingCount: pendingCountAfter }
        : { kind: 'event-stored', event: stored.event, pendingCount: pendingCountAfter }
    },

    readPending,
    pendingCount,

    reportResolved: (eventId: string): PendingTransitionResult => transition('resolution', eventId),

    acknowledge: (eventId: string): PendingTransitionResult => transition('acknowledgement', eventId),
  }

  /**
   * A resolution signal, addressed through the block identity it shares with the
   * event that created the pending item.
   *
   * The pending set is the address book: it is the only read the store offers that
   * carries the dedupe key, and it carries it for exactly the blocks that are
   * still pending, which is precisely the set a resolution can clear.
   */
  function resolveBlockSignal(signal: HarnessSignal): PendingRecordResult {
    const transitionId = signal.transitionId
    if (transitionId === undefined) {
      throw new PendingLifecycleError(
        'unidentifiable-block',
        describeSignal(signal),
        `${signal.harness} event "${signal.eventName}" reports a resolved block but named no block identifier: ` +
          'a resolution is addressed by the same block identifier the permission ask reported, and ' +
          'nothing else (EL-FR-07, EL-FR-08). An identifier built from a timestamp would name a different ' +
          'block on every replay, so the signal is refused rather than guessed at.',
      )
    }
    const dedupeKey = deriveDedupeKey(signal.harness, signal.sessionId, transitionId)
    const pending = readPending().find((item) => item.dedupeKey === dedupeKey)
    if (pending === undefined) {
      // Already settled, or never recorded. Both are the same answer here: there
      // is no pending item for this block to clear, and inventing one would create
      // the very pending item the signal says is finished.
      return { kind: 'nothing-pending', pendingCount: pendingCount() }
    }
    const applied = transition('resolution', pending.eventId)
    // The row came out of the pending read a moment ago, so it exists; the only
    // way it would not is a concurrent rebuild of the file, and the honest answer
    // then is the same one: there is no pending item for this block to clear.
    if (applied.event === null) return { kind: 'nothing-pending', pendingCount: applied.pendingCountAfter }
    return { kind: 'pending-resolved', event: applied.event, transition: applied }
  }
}

/**
 * The table's key for one attempt: the exit, what the store reports it did, and
 * the row's state afterwards.
 *
 * The single cast in this module. The store's verdict and the row's state can only
 * produce the twelve keys PendingTransitionKey lists, and this is the one place
 * that says so; `lookupTransition` throws rather than defaults if it is ever
 * wrong, and tests/domain/pending.test.ts enumerates the real scenarios and checks
 * the set they produce against the table's keys, so a store that grew a seventh
 * answer would fail there rather than here.
 */
function transitionKey(kind: PendingTransition, mutation: MutationResult): PendingTransitionKey {
  return `${kind}:${mutation.outcome}:${rowState(mutation.event)}` as PendingTransitionKey
}

/**
 * One cell of the answer table, or a loud failure when the table has no cell for
 * the combination.
 *
 * The local view of the table is deliberately partial. The exported table's type
 * is total over the reachable set, which is what makes a missing combination a
 * compile error while the table is being written; widening it to a partial here is
 * what makes the runtime guard honest rather than a branch the type system has
 * already proved unreachable.
 */
function lookupTransition(key: PendingTransitionKey): PendingTransitionShape {
  const table: Readonly<Partial<Record<PendingTransitionKey, PendingTransitionShape>>> =
    PENDING_TRANSITION_OUTCOMES
  const shape = table[key]
  if (shape === undefined) return unhandledTransition(key)
  return shape
}

/**
 * What a row is once a transition has been attempted, for the answer table's key.
 *
 * Read from the row the store returned *after* the attempt, which is the durable
 * truth. The two states are read in the order they are independent: a row that is
 * both acknowledged and resolved is one state, not two, because a block the
 * developer has already dealt with is answered the same way whichever fact
 * arrived first - and the store's verdict is what says whether the fact was
 * recorded just now or was already there.
 */
function rowState(event: EventRecord | null): PendingRowState {
  if (event === null) return 'no-row'
  if (event.class !== 'needs-you') return 'not-a-block'
  if (event.ackState === 'acknowledged' && event.resolutionState === 'resolved') {
    return 'acknowledged-and-resolved'
  }
  if (event.ackState === 'acknowledged') return 'acknowledged'
  return 'resolved'
}

/**
 * The guard the type system cannot provide: a combination the table does not
 * carry, reached only if the store grew an answer or a row state this file has
 * never seen. It throws rather than defaulting to an outcome, because a default
 * here would be a silent third exit from pending.
 */
function unhandledTransition(key: string): never {
  throw new Error(
    `unhandled pending transition: "${key}". PENDING_TRANSITION_OUTCOMES must carry every combination ` +
      'a store answer and a row state can produce, and a default would be a third way a pending item ' +
      'could stop being pending without being recorded (EL-FR-08).',
  )
}
