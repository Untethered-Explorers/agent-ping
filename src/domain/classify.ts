// Classification: one harness signal in, exactly one class, subtype and dedupe
// key out - or no event at all (EL-FR-04 through EL-FR-07, ADR-004).
//
// WHAT THIS MODULE IS
// The authority on loudness. A harness adapter translates its own events into a
// HarnessSignal and this module decides what that signal is worth; an adapter's
// own table is a second copy of the same decision, and when the two disagree the
// adapter is wrong, not this file. Widening the classifier to accommodate one
// harness re-opens the rules for every harness at once, which is why the mapping
// lives in data (HARNESS_SIGNAL_TABLE) rather than in a chain of conditionals: a
// table is the only form that can be asserted exhaustively.
//
// THREE ANSWERS, NOT TWO
//   - an event, with its class, subtype and dedupe key
//   - no event, with a recorded reason (the idle gate, a resolution, a signal
//     that is observed but never earns an interruption, a threshold not reached)
//   - a failure, by throwing, for a signal that is not in the table at all or is
//     recorded as unresolved upstream
//
// The third is the one that is easy to skip. An unmapped signal is an accident and
// a suppressed signal is a decision, and only a table with a recorded reason can
// tell them apart. Silently ignoring a signal this module has never heard of is
// how a harness change becomes a week of "why did I not get a notification" with
// no answer, and APX-FR-02 requires a failure to be visible. So an unmapped
// signal throws, and the adapter turns that into a breadcrumb in the harness's
// own interface rather than letting it escape into the session (APX-CON-10,
// OA-FR-05). Nothing here may be caught and swallowed without becoming a
// breadcrumb.
//
// THE IDLE GATE (EL-FR-05, EL-FR-06)
// A session that goes idle having performed no work in the turn - no tool call,
// no file edit, no todo update - produces no event at all. Not a quiet event, not
// an fyi: no event. This is the rule that keeps "opened, greeted, closed" out of
// the developer's life, and it is stated as a rule rather than a threshold
// precisely so the question has an answer.
//
// The work signal itself is accumulated by the adapter, because only the adapter
// can see a turn boundary (OA-FR-03, src/plugin/opencode/work-signal.ts). This
// module owns the definition of what counts as work and the gate that applies it,
// and it is stateless by design: a classifier that remembered anything could
// credit an empty turn with the previous turn's work, which is exactly the
// greeting-and-close case arriving twice. A harness that cannot report the work
// signal gets a distinct, named outcome rather than a guess: no work signal is
// read as silence, not as work, because the failure mode of guessing wrong is a
// notification per closed session, and PRD's absence-of-harm criterion puts the
// restrained reading first. The caller can still see that it happened, which is
// what makes the degradation visible instead of silent (ADR-004, ADR-005).
//
// DEDUPE KEYS (EL-FR-06, EL-FR-07)
// One derivation, from stable identity only: harness, session, and the
// transition or block identifier the harness reported. Never a receive
// timestamp, never an arrival counter - a key containing either changes on replay
// and defeats the whole mechanism, so re-posting an envelope stores nothing new
// (HC-FR-08). One block therefore yields one key however many times it is asked
// for, and two idle transitions separated by a resume yield two keys because the
// resume makes them two transitions.
//
// The key deliberately does not include the event name either, and that is what
// makes opencode's modern `session.status` idle transition and its deprecated
// `session.idle` event the same transition: both rows declare the same dedupe
// part, so both derive the same key for the same transition and the unique index
// on events.dedupe_key collapses them to one event. Two keys for one transition
// would be two finished notifications and a confusing history.
//
// The polling fallback and every adapter must call this function rather than
// building a key of their own, or a session that both pushes and is polled
// produces two of everything (OA-FR-07).
//
// PURITY
// No database, no clock, no randomness, no I/O, no network, synchronous, and no
// module-level state. Both timestamps are inputs, so classification is
// deterministic and replaying a signal yields the same envelope. The two
// measurements a threshold needs are compared here and deliberately do not
// survive: a token count is a number that grows with what was said, and only the
// class it decided belongs in the envelope (see src/domain/envelope.ts).
// tests/domain/classify.test.ts asserts the imports and the absence of a clock
// read, because "pure" is a property of the file and not of a comment.
//
// Nothing here opens a socket, spawns a process or renders a surface, and no
// value in this module is ever sent anywhere (APX-CON-12).

import type { EventClass, FyiSubtype, Harness, NormalizedEvent } from './envelope.js'
import { isKnownHarness } from './envelope.js'

// ---------------------------------------------------------------------------
// What a harness reports
// ---------------------------------------------------------------------------

/**
 * Whether the current turn performed real work (EL-FR-05, OA-FR-03).
 *
 * Three booleans and nothing else, named after the three things the requirement
 * names. This is a flag per measure, never a count of what the agent did: a tally
 * of tool calls, edits and todo updates across a turn is a transcript wearing a
 * numeric disguise, which is why the store's work_signal column is a 0 or 1 too.
 *
 * The adapter owns accumulating this per turn and resetting it at the turn
 * boundary; this module owns the definition and the gate.
 */
export interface TurnWorkSignal {
  readonly toolCall: boolean
  readonly fileEdit: boolean
  readonly todoUpdate: boolean
}

/** Whether a turn recorded any work at all. The idle gate's whole question. */
export function turnDidWork(turn: TurnWorkSignal): boolean {
  return turn.toolCall || turn.fileEdit || turn.todoUpdate
}

/**
 * The three measures a threshold can be read from, as a closed set.
 *
 * All three are numbers that exist only to be compared against a threshold in the
 * table below. None of them reaches the envelope, the durable log or any payload:
 * a duration and a token count are both proxies for how much happened, and a
 * number that grows with what was said does not become safe by being an integer.
 */
export type Measurement = 'durationMs' | 'tokensUsed' | 'attempt'

/**
 * One harness signal, in the vocabulary of the table below.
 *
 * This is the adapter's input, not the envelope: it carries two things the
 * envelope must not - the measurements a threshold is read from, and the turn
 * work signal - and both are consumed here. `variant` distinguishes two readings
 * of one event name (a status value, a reason) without this module knowing any
 * harness's payload shape; a variant is a short token, not a payload.
 *
 * `transitionId` is the stable identity of the transition or block the signal
 * describes, and it is what the dedupe key is derived from. It is optional on the
 * input because a signal that produces no event has no identity worth carrying,
 * and required by every table row that produces one: a missing identity is a loud
 * failure rather than a key built from a timestamp that would differ on replay.
 */
export interface HarnessSignal {
  readonly harness: Harness
  /** The harness's own event name, verbatim (PRD 5). */
  readonly eventName: string
  /** The value that distinguishes two readings of one event name, when it has one. */
  readonly variant?: string
  readonly sessionId: string
  /** The session's directory. The short name is derived from it (ADR-008). */
  readonly repoFullPath: string
  /** The block identifier, or the idle-transition identifier. */
  readonly transitionId?: string
  /** ISO 8601 UTC: when the signal happened. */
  readonly occurredAt: string
  /** ISO 8601 UTC: when the hub received it. */
  readonly receivedAt: string
  /** Absent when the harness cannot report the turn's work signal. */
  readonly turnWork?: TurnWorkSignal
  readonly measurements?: Readonly<Partial<Record<Measurement, number>>>
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * What a signal's identity means, which is documentation rather than a second
 * derivation. Every classified row declares the part, the key derivation is one
 * function, and the two rows that describe one transition declare the same part so
 * they collapse to one event.
 */
export type DedupePart =
  /** The block identifier: one needs-you event per unresolved block (EL-FR-07). */
  | 'block'
  /** The idle-transition identifier: one finished event per transition (EL-FR-06). */
  | 'idle-transition'
  /** The identifier the harness reported for the signal itself. */
  | 'signal-identity'

/** When a classified row produces its event, and when it produces nothing. */
export type ClassifiedCondition =
  /** The event is the class event. */
  | { readonly kind: 'always' }
  /** Only when the turn did work, or the gate cannot be evaluated (EL-FR-05). */
  | { readonly kind: 'turn-did-work' }
  /** Only at or past a threshold the harness's measurement reaches. */
  | { readonly kind: 'at-least'; readonly measurement: Measurement; readonly atLeast: number }

/**
 * Why a signal that is observed produces no event.
 *
 * `idle-after-nothing`, `below-threshold` and `not-a-class-event` are a
 * deliberate suppression. `work-signal-unavailable` and `measurement-unavailable`
 * are a capability the harness does not expose, which degrade differently: they
 * must be visible to the operator rather than read as a quiet session. They are
 * separate reasons precisely so a caller can tell "nothing happened" from "this
 * harness cannot tell us".
 */
export type SuppressionReason =
  /** The turn recorded no tool call, no file edit and no todo update (EL-FR-05). */
  | 'idle-after-nothing'
  /** The harness exposes no work signal, so the gate cannot be evaluated. */
  | 'work-signal-unavailable'
  /** The block was resolved; resolution travels through the pending lifecycle. */
  | 'block-resolved'
  /** An observed signal that never earns an interruption. */
  | 'not-a-class-event'
  /** The signal is a class event only past a threshold that was not reached. */
  | 'below-threshold'
  /** The harness exposes no measurement the class needs. */
  | 'measurement-unavailable'

/**
 * The detail sentence each gate reason carries.
 *
 * Data, not a message assembled at the call site, so the same reason always
 * reports the same words and a test can assert every reason in the union has one.
 */
const SUPPRESSION_DETAIL: Readonly<Record<SuppressionReason, string>> = {
  'idle-after-nothing':
    'the session went idle having recorded no tool call, no file edit and no todo update in the turn, which produces no event at all (EL-FR-05)',
  'work-signal-unavailable':
    'this harness does not report a turn work signal, so the idle gate cannot be evaluated; silence is the safe reading and the absence is reported rather than assumed (ADR-004, ADR-005)',
  'block-resolved': 'the block was resolved by the harness, which clears the pending item through the pending lifecycle and is not itself a class event (EL-FR-08)',
  'not-a-class-event':
    'this signal exists to be observed, not to interrupt: it is a boundary, a lifecycle marker or a per-item update that ADR-004 records as not an interruption',
  'below-threshold': 'the signal did not reach the threshold this class needs, so it is not reported at all',
  'measurement-unavailable':
    'this harness exposes no measurement the class needs, so the subtype is never invented from a signal that did not carry it',
}

/** The row kinds. A row is classified, deliberately suppressed, or unresolved. */
export type SignalMapping =
  | ClassifiedSignalMapping
  | SuppressedSignalMapping
  | UnresolvedSignalMapping

interface SignalMappingBase {
  readonly harness: Harness
  readonly eventName: string
  /**
   * The variant this row is for. Absent means the fallback row: this event name
   * with any other variant, which is why an event name with a variant row always
   * has one too. An event name with no row at all is unmapped, and unmapped throws.
   */
  readonly variant?: string
  /**
   * Whether the signal has been observed, recorded on the row rather than in a
   * comment beside it so the exhaustive test can assert that every unresolved
   * signal carries a gate.
   */
  readonly evidence: 'observed' | 'unresolved'
  /** Why this mapping is what it is, in one line. Required on every row. */
  readonly note: string
}

/** A signal that becomes an event. */
export interface ClassifiedSignalMapping extends SignalMappingBase {
  readonly kind: 'classified'
  readonly evidence: 'observed'
  readonly class: EventClass
  /** Non-null exactly when the class is fyi (EL-FR-04). */
  readonly subtype: FyiSubtype | null
  readonly condition: ClassifiedCondition
  readonly dedupePart: DedupePart
}

/** A signal that is observed and deliberately produces no event. */
export interface SuppressedSignalMapping extends SignalMappingBase {
  readonly kind: 'suppressed'
  readonly evidence: 'observed'
  readonly suppression: { readonly reason: SuppressionReason; readonly detail: string }
}

/**
 * A signal whose existence or meaning is not established upstream.
 *
 * It throws rather than mapping, because a heuristic shipped as a proven mapping
 * is the failure mode ADR-005 warns about: the default recorded position is
 * deferral until the Copilot spike records a gate decision (PRD 16 Open Question
 * 12). The row is here so the failure says what is missing, not so a guess can
 * ship quietly.
 */
export interface UnresolvedSignalMapping extends SignalMappingBase {
  readonly kind: 'unresolved'
  readonly evidence: 'unresolved'
  /** The gate that has to be recorded before this row may classify. */
  readonly blockedBy: string
}

/**
 * A tool call still running after thirty seconds.
 *
 * Fixed, not configurable: ADR-004 rejected user-tunable class thresholds in v1
 * because tuning before the defaults are trusted invites tuning toward silence.
 * A read or a grep finishes in well under a second; a build or a test run is
 * exactly what is worth showing. The fyi class never leaves the app, so this
 * number buys a history row rather than an interruption.
 */
const LONG_TOOL_CALL_MS = 30_000

/**
 * Tokens consumed by the work a signal reports.
 *
 * No document specifies this number, so it is a default recorded here and called
 * out as a product number rather than a measured one: an ordinary turn is a few
 * thousand tokens, and fifty thousand is where a developer would want to know
 * before compaction is forced on them. A harness that reports no token figure
 * never produces this subtype, which is a visible capability gap rather than an
 * invented number.
 */
const TOKEN_BURN_TOKENS = 50_000

/**
 * The second attempt at the same work is a retry; the first one is not.
 *
 * A retry is only worth reporting when something already failed, so a first
 * attempt is not a retry-shaped update even though it is a todo update.
 */
const RETRY_ATTEMPT = 2

/**
 * Every documented harness signal and what it is worth.
 *
 * The opencode rows are the event names PRD 5 records as delivered by the generic
 * event hook, plus the dedicated permission hook that PRD 5 reports as never
 * firing - mapped to nothing on purpose, because mapping a hook that cannot fire
 * ships a block signal that never arrives and a table test that passes anyway.
 *
 * The copilot-cli rows are the hook triggers PRD 5 records as documented, mapped
 * conservatively for a harness whose idle and block signals are not established,
 * plus the two ACP notifications recorded as unresolved upstream.
 *
 * tests/domain/classify.test.ts asserts this table against the documented event
 * lists, row by row, so a new signal cannot be added here without the documented
 * set changing with it, and no documented signal can be missing.
 */
export const HARNESS_SIGNAL_TABLE: readonly SignalMapping[] = [
  // --- opencode: the idle transition (EL-FR-05, EL-FR-06) -------------------
  {
    kind: 'classified',
    harness: 'opencode',
    eventName: 'session.status',
    variant: 'idle',
    evidence: 'observed',
    class: 'finished',
    subtype: null,
    condition: { kind: 'turn-did-work' },
    dedupePart: 'idle-transition',
    note: 'the modern form of the idle transition; one finished event per transition, then silent until the session resumes',
  },
  {
    kind: 'suppressed',
    harness: 'opencode',
    eventName: 'session.status',
    evidence: 'observed',
    suppression: {
      reason: 'not-a-class-event',
      detail: SUPPRESSION_DETAIL['not-a-class-event'] +
        ': a non-idle status is the session resuming, and the session is silent until it goes idle again (EL-FR-06)',
    },
    note: 'the fallback row for every other session.status value, so a status this table has never seen is a recorded decision rather than an unmapped signal',
  },
  {
    kind: 'classified',
    harness: 'opencode',
    eventName: 'session.idle',
    evidence: 'observed',
    class: 'finished',
    subtype: null,
    condition: { kind: 'turn-did-work' },
    dedupePart: 'idle-transition',
    note: 'deprecated in favour of session.status but still emitted (PRD 5); it declares the same dedupe part, so the same transition produces the same key and collapses to one event',
  },

  // --- opencode: the block (EL-FR-07) ---------------------------------------
  {
    kind: 'classified',
    harness: 'opencode',
    eventName: 'permission.asked',
    evidence: 'observed',
    class: 'needs-you',
    subtype: null,
    condition: { kind: 'always' },
    dedupePart: 'block',
    note: 'the only observable block signal: a permission ask is visible through the generic event hook, never through the dedicated one',
  },
  {
    kind: 'suppressed',
    harness: 'opencode',
    eventName: 'permission.ask',
    evidence: 'observed',
    suppression: {
      reason: 'not-a-class-event',
      detail: SUPPRESSION_DETAIL['not-a-class-event'] +
        ': the dedicated permission hook is reported as never firing upstream (PRD 5), so mapping it would ship a block signal that can never arrive',
    },
    note: 'documented in PRD 5 as a hook that does not fire; present as an explicit row so its absence from the mapping is a recorded decision',
  },
  {
    kind: 'suppressed',
    harness: 'opencode',
    eventName: 'permission.replied',
    evidence: 'observed',
    suppression: {
      reason: 'block-resolved',
      detail: SUPPRESSION_DETAIL['block-resolved'],
    },
    note: 'a resolution, not a class event: it clears the pending item and must never become a second needs-you or a finished event',
  },

  // --- opencode: fyi, with the matching subtype (EL-FR-04) ------------------
  {
    kind: 'classified',
    harness: 'opencode',
    eventName: 'session.error',
    evidence: 'observed',
    class: 'fyi',
    subtype: 'error',
    condition: { kind: 'always' },
    dedupePart: 'signal-identity',
    note: 'an error the agent reported; in-app only, never an interruption',
  },
  {
    kind: 'classified',
    harness: 'opencode',
    eventName: 'session.compacted',
    evidence: 'observed',
    class: 'fyi',
    subtype: 'compaction',
    condition: { kind: 'always' },
    dedupePart: 'signal-identity',
    note: 'the session compacted its own context, which is worth seeing before the next turn starts without it',
  },
  {
    kind: 'classified',
    harness: 'opencode',
    eventName: 'message.updated',
    evidence: 'observed',
    class: 'fyi',
    subtype: 'token-burn',
    condition: { kind: 'at-least', measurement: 'tokensUsed', atLeast: TOKEN_BURN_TOKENS },
    dedupePart: 'signal-identity',
    note: 'the burn signal the update carries, compared against a threshold and never carried onward; the message itself is never read (PRD 5, APX-FR-01)',
  },
  {
    kind: 'classified',
    harness: 'opencode',
    eventName: 'tool.execute.after',
    evidence: 'observed',
    class: 'fyi',
    subtype: 'long-tool-call',
    condition: { kind: 'at-least', measurement: 'durationMs', atLeast: LONG_TOOL_CALL_MS },
    dedupePart: 'signal-identity',
    note: 'a tool call that has not returned after the long threshold; the tool name and its arguments are never read, only how long it took',
  },
  {
    kind: 'classified',
    harness: 'opencode',
    eventName: 'todo.updated',
    evidence: 'observed',
    class: 'fyi',
    subtype: 'retry',
    condition: { kind: 'at-least', measurement: 'attempt', atLeast: RETRY_ATTEMPT },
    dedupePart: 'signal-identity',
    note: 'only a retry-shaped update, meaning a second or later attempt at the same work; the todo text is never read',
  },

  // --- opencode: observed boundaries that are not events --------------------
  {
    kind: 'suppressed',
    harness: 'opencode',
    eventName: 'tool.execute.before',
    evidence: 'observed',
    suppression: {
      reason: 'not-a-class-event',
      detail: SUPPRESSION_DETAIL['not-a-class-event'] +
        ': the before boundary is the turn work signal, and the long-call row is decided at the after boundary where the duration exists',
    },
    note: 'consumed by the adapter as work-signal input, which is why it must not also become a row',
  },

  // --- copilot-cli: the documented hooks (PRD 5, ADR-005) ------------------
  {
    kind: 'suppressed',
    harness: 'copilot-cli',
    eventName: 'sessionStart',
    evidence: 'observed',
    suppression: {
      reason: 'not-a-class-event',
      detail: SUPPRESSION_DETAIL['not-a-class-event'] +
        ': a session starting is the beginning of the turn work signal accumulator, not something to report',
    },
    note: 'where an adapter resets its work signal for a new session',
  },
  {
    kind: 'suppressed',
    harness: 'copilot-cli',
    eventName: 'sessionEnd',
    evidence: 'observed',
    suppression: {
      reason: 'not-a-class-event',
      detail: SUPPRESSION_DETAIL['not-a-class-event'] +
        ': Copilot documents no idle hook, and a session end is not idle-after-work - mapping it to finished would fire for every closed session, including one that was opened, greeted and closed, which ADR-004 rules out',
    },
    note: 'revisit only with a recorded gate decision; PRD 16 Open Question 12 defers this harness by default',
  },
  {
    kind: 'suppressed',
    harness: 'copilot-cli',
    eventName: 'userPromptSubmitted',
    evidence: 'observed',
    suppression: {
      reason: 'not-a-class-event',
      detail: SUPPRESSION_DETAIL['not-a-class-event'] +
        ': a prompt submission is conversation content, and the one path in this product that must never observe content is the path that records events',
    },
    note: 'the adapter counts it as the start of a turn; it reads no part of the prompt',
  },
  {
    kind: 'suppressed',
    harness: 'copilot-cli',
    eventName: 'preToolUse',
    evidence: 'observed',
    suppression: {
      reason: 'not-a-class-event',
      detail: SUPPRESSION_DETAIL['not-a-class-event'] +
        ': the pre-tool boundary is the turn work signal, and the long-call row needs a duration that exists only after the call',
    },
    note: 'consumed as work-signal input; the tool name and arguments are not read',
  },
  {
    kind: 'classified',
    harness: 'copilot-cli',
    eventName: 'postToolUse',
    evidence: 'observed',
    class: 'fyi',
    subtype: 'long-tool-call',
    condition: { kind: 'at-least', measurement: 'durationMs', atLeast: LONG_TOOL_CALL_MS },
    dedupePart: 'signal-identity',
    note: 'the same long-call rule as opencode, from the documented hook rather than a plugin event',
  },
  {
    kind: 'classified',
    harness: 'copilot-cli',
    eventName: 'errorOccurred',
    evidence: 'observed',
    class: 'fyi',
    subtype: 'error',
    condition: { kind: 'always' },
    dedupePart: 'signal-identity',
    note: 'the documented error hook; in-app only',
  },

  // --- copilot-cli: unresolved upstream (ADR-005, PRD 16 #12) --------------
  {
    kind: 'unresolved',
    harness: 'copilot-cli',
    eventName: 'session/request_permission',
    evidence: 'unresolved',
    blockedBy:
      'whether ACP mode emits session/request_permission is unresolved upstream, and the recorded default is deferral until the Copilot spike records a gate decision (PRD 5, PRD 16 Open Question 12, ADR-005). Mapping it to needs-you today would ship a heuristic as a proven block signal, and needs-you is the one signal this product exists to deliver.',
    note: 'present so that an adapter reporting it fails with a named gate instead of a silent drop, and so the row becomes a decision rather than a guess',
  },
  {
    kind: 'unresolved',
    harness: 'copilot-cli',
    eventName: 'session/update',
    evidence: 'unresolved',
    blockedBy:
      'the ACP idle marker is not established upstream, so a finished event on this harness would be inferred rather than observed (ADR-005). The default is deferral; only a recorded gate decision authorises a heuristic here.',
    note: 'present so the absence of an idle signal is a reported gap rather than a session that merely looks idle',
  },
]

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/**
 * What a signal turned out to be worth.
 *
 * `no-event` is a first-class answer with a reason, not a null: the reason is
 * what lets the hub distinguish a deliberate suppression from a capability the
 * harness does not have, and what the operator sees when a class is missing.
 */
export type Classification =
  | { readonly outcome: 'event'; readonly event: NormalizedEvent }
  | {
      readonly outcome: 'no-event'
      readonly reason: SuppressionReason
      readonly detail: string
    }

/** Why a classification failed, when it did. */
export type ClassificationErrorCode =
  /** A harness this product does not know. The ingest route rejects one (HC-FR-04). */
  | 'unknown-harness'
  /** A harness event name with no row in the table. A contract change, not a decision. */
  | 'unmapped-signal'
  /** A signal recorded as unresolved upstream. Needs a recorded gate decision. */
  | 'unresolved-signal'
  /** The signal is missing an identity, or carries a value the rules reject. */
  | 'invalid-signal'

/**
 * The part of a signal an error may name.
 *
 * Three closed tokens, and nothing else - no session identifier, no path, no
 * measurement, no payload. This is the log-path half of the privacy boundary: a
 * breadcrumb travels through the harness's own logging client, so anything a
 * failure message carries is on screen (OA-FR-05, APX-CON-12). The whole signal
 * is deliberately not attached to the error, because a future field would then
 * ride along automatically into whatever writes it down.
 */
export interface SignalRef {
  readonly harness: string
  readonly eventName: string
  readonly variant: string | null
}

/** The only description of a signal a failure may carry. */
export function describeSignal(signal: HarnessSignal): SignalRef {
  return { harness: signal.harness, eventName: signal.eventName, variant: signal.variant ?? null }
}

/**
 * A classification that could not be made, and why.
 *
 * The message names the signal by its three tokens and the rule it broke. It never
 * quotes a value: a rejected session identifier might be a pasted prompt, and a
 * failure message is the easiest way to put one on disk or on screen.
 */
export class ClassificationError extends Error {
  readonly code: ClassificationErrorCode
  readonly signal: SignalRef

  constructor(code: ClassificationErrorCode, signal: SignalRef, message: string) {
    super(message)
    this.name = 'ClassificationError'
    this.code = code
    this.signal = signal
  }
}

/**
 * Classify one harness signal.
 *
 * Synchronous, deterministic and side-effect free: the same signal produces the
 * same answer every time, and answering writes nothing.
 */
export function classify(signal: HarnessSignal): Classification {
  const ref = describeSignal(signal)
  // The identifiers are bounded before anything is echoed, so an error message can
  // carry the signal's three tokens without carrying an unbounded value into a log
  // or a breadcrumb.
  assertSignalIsUsable(signal, ref)
  if (!isKnownHarness(signal.harness)) {
    throw new ClassificationError(
      'unknown-harness',
      ref,
      `unknown harness "${signal.harness}": the ingest route rejects one rather than inventing a session, and a harness name is added to KNOWN_HARNESSES deliberately (HC-FR-04).`,
    )
  }

  const row = findMapping(signal)
  if (row === undefined) {
    throw new ClassificationError(
      'unmapped-signal',
      ref,
      `no classification for ${signal.harness} event "${signal.eventName}"` +
        `${signal.variant === undefined ? '' : ` variant "${signal.variant}"`}: every event name a harness delivers needs a row in ` +
        'HARNESS_SIGNAL_TABLE, mapped to a class or explicitly to nothing with a recorded reason. An unmapped signal is an accident, not a decision, and dropping it silently is how a notification goes missing with no answer (APX-FR-02).',
    )
  }
  if (row.kind === 'unresolved') {
    throw new ClassificationError(
      'unresolved-signal',
      ref,
      `${signal.harness} event "${signal.eventName}" is not established upstream: ${row.blockedBy}`,
    )
  }
  if (row.kind === 'suppressed') {
    return {
      outcome: 'no-event',
      reason: row.suppression.reason,
      detail: row.suppression.detail,
    }
  }

  const gated = gateFor(row, signal)
  if (gated !== null) {
    return { outcome: 'no-event', reason: gated, detail: SUPPRESSION_DETAIL[gated] }
  }

  // Every classified row needs the identity the key is derived from. A missing one
  // is a failure rather than a key built from something else: a key containing a
  // timestamp changes on replay and produces a second event for one signal.
  const transitionId = signal.transitionId
  if (transitionId === undefined) {
    throw new ClassificationError(
      'invalid-signal',
      ref,
      `${signal.harness} event "${signal.eventName}" classifies to ${row.class} but reported no transitionId: the dedupe key is derived from the block or transition identifier the harness reported, and nothing else (EL-FR-06, EL-FR-07).`,
    )
  }

  return {
    outcome: 'event',
    event: {
      harness: signal.harness,
      sessionId: signal.sessionId,
      repoShortName: repoShortNameFromPath(signal.repoFullPath),
      repoFullPath: signal.repoFullPath,
      rawEventType: signal.eventName,
      class: row.class,
      subtype: row.subtype,
      occurredAt: signal.occurredAt,
      receivedAt: signal.receivedAt,
      dedupeKey: deriveDedupeKey(signal.harness, signal.sessionId, transitionId),
    },
  }
}

/**
 * The dedupe key, from stable identity only.
 *
 * Exported because every path needs the same one: an adapter pushing a signal, the
 * polling fallback reading the same session's state, and the hub storing the
 * result. A second derivation is a duplicate-event bug waiting for a session that
 * both pushes and is polled (OA-FR-07).
 *
 * The two identifiers come from the harness, so the colon separator is a
 * convention rather than an escaping scheme. It is the derivation connector
 * adapters are expected to call, so it is kept as documented; a harness whose
 * identifiers contain colons would need an escaping decision recorded here rather
 * than invented in three adapters.
 */
export function deriveDedupeKey(harness: Harness, sessionId: string, transitionId: string): string {
  return `${harness}:${sessionId}:${transitionId}`
}

/**
 * The repository short name: the session directory's basename (APX-CON-09,
 * ADR-008).
 *
 * Derived here so there is one rule rather than one per adapter, and so identity
 * is never registered or configured. Both separators are handled because a Windows
 * path is a directory a developer is standing in, not a string to normalise first.
 * A path with no basename is a failure rather than an empty label: a row the
 * developer cannot identify is worse than a loud one.
 */
export function repoShortNameFromPath(repoFullPath: string): string {
  const withoutTrailingSeparators = repoFullPath.replace(/[/\\]+$/, '')
  const lastSeparator = Math.max(
    withoutTrailingSeparators.lastIndexOf('/'),
    withoutTrailingSeparators.lastIndexOf('\\'),
  )
  const shortName = lastSeparator === -1
    ? withoutTrailingSeparators
    : withoutTrailingSeparators.slice(lastSeparator + 1)
  if (shortName === '') {
    throw new ClassificationError(
      'invalid-signal',
      { harness: 'unknown', eventName: 'repo-short-name', variant: null },
      'the session directory has no basename, so it has no identity: the repository short name is the directory basename and a path that does not name a directory cannot label a row (APX-CON-09).',
    )
  }
  return shortName
}

// ---------------------------------------------------------------------------
// Lookup, gating and input checks
// ---------------------------------------------------------------------------

/**
 * The row for a signal: the exact variant first, then the event name's fallback
 * row. A signal with no row at all is unmapped, which throws rather than
 * defaulting to a class.
 */
function findMapping(signal: HarnessSignal): SignalMapping | undefined {
  const rows = HARNESS_SIGNAL_TABLE.filter(
    (row) => row.harness === signal.harness && row.eventName === signal.eventName,
  )
  return rows.find((row) => row.variant === signal.variant) ?? rows.find((row) => row.variant === undefined)
}

/**
 * The suppression a classified row's condition produces, or null when the signal
 * earns its event.
 */
function gateFor(row: ClassifiedSignalMapping, signal: HarnessSignal): SuppressionReason | null {
  const condition = row.condition
  if (condition.kind === 'always') return null
  if (condition.kind === 'turn-did-work') {
    // Absent is not the same as false, and neither is silently "worked". A harness
    // that cannot report the work signal is a capability gap the caller has to be
    // able to see, so it gets its own reason rather than a quiet finished event or
    // a quiet nothing.
    if (signal.turnWork === undefined) return 'work-signal-unavailable'
    return turnDidWork(signal.turnWork) ? null : 'idle-after-nothing'
  }
  if (condition.kind === 'at-least') {
    const measured = signal.measurements?.[condition.measurement]
    if (measured === undefined) return 'measurement-unavailable'
    return measured >= condition.atLeast ? null : 'below-threshold'
  }
  // A fourth condition kind is a compile error here rather than a rule that
  // silently passes everything.
  return unhandledCondition(condition)
}

function unhandledCondition(condition: never): null {
  throw new Error(`unhandled classification condition: ${JSON.stringify(condition)}`)
}

/**
 * ISO 8601 UTC, to the millisecond.
 *
 * The durable log stores these as text so lexicographic order is chronological
 * order, which is only true if they are all in this one format; a local-time or
 * second-precision timestamp would quietly sort wrong. The schema stores the same
 * format and asserts it on its own records.
 */
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Identifier bounds. Not a content filter and not claimed to be one: they exist
 * because a path, a session key and an event name are all short, single-line
 * tokens, so a pasted multi-line prompt is the obvious accident and is refused at
 * the boundary instead of being carried onward. A single-line prompt still gets
 * through, which is why the envelope's exact field set - not this - is the guard.
 */
const MAX_IDENTIFIER_LENGTH = 512
const MAX_PATH_LENGTH = 1024

/**
 * Reject a signal this module cannot reason about.
 *
 * Every message names the field and the rule and quotes no value, because a
 * failure message is written to a log or shown in a breadcrumb (OA-FR-05), and a
 * rejected identifier may be content pasted into the wrong place.
 */
function assertSignalIsUsable(signal: HarnessSignal, ref: SignalRef): void {
  assertIdentifier('harness', signal.harness, MAX_IDENTIFIER_LENGTH, ref)
  assertIdentifier('sessionId', signal.sessionId, MAX_IDENTIFIER_LENGTH, ref)
  assertIdentifier('eventName', signal.eventName, MAX_IDENTIFIER_LENGTH, ref)
  if (signal.variant !== undefined) {
    assertIdentifier('variant', signal.variant, MAX_IDENTIFIER_LENGTH, ref)
  }
  if (signal.transitionId !== undefined) {
    assertIdentifier('transitionId', signal.transitionId, MAX_IDENTIFIER_LENGTH, ref)
  }
  if (signal.repoFullPath === '' || isUnbounded(signal.repoFullPath) || signal.repoFullPath.length > MAX_PATH_LENGTH) {
    throw new ClassificationError(
      'invalid-signal',
      ref,
      'repoFullPath must be a single-line path within ' +
        `${MAX_PATH_LENGTH} characters: it is a directory a session is working in, not a place for text (ADR-008).`,
    )
  }
  assertTimestamp('occurredAt', signal.occurredAt, ref)
  assertTimestamp('receivedAt', signal.receivedAt, ref)
  if (signal.turnWork !== undefined) {
    const { toolCall, fileEdit, todoUpdate } = signal.turnWork
    if (typeof toolCall !== 'boolean' || typeof fileEdit !== 'boolean' || typeof todoUpdate !== 'boolean') {
      throw new ClassificationError(
        'invalid-signal',
        ref,
        'turnWork must be three booleans, one per measure the idle gate reads (EL-FR-05). A count here would be a transcript in disguise.',
      )
    }
  }
  for (const [measurement, value] of Object.entries(signal.measurements ?? {})) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new ClassificationError(
        'invalid-signal',
        ref,
        `measurement ${measurement} must be a finite number of zero or more: it is compared against a threshold and never carried onward.`,
      )
    }
  }
}

function isUnbounded(value: string): boolean {
  return /[\r\n]/.test(value)
}

function assertIdentifier(field: string, value: string, maxLength: number, ref: SignalRef): void {
  if (value === '' || isUnbounded(value) || value.length > maxLength) {
    throw new ClassificationError(
      'invalid-signal',
      ref,
      `${field} must be a single-line token of at most ${maxLength} characters: it is an identity this product records, ` +
        'and an identity that can hold a paragraph is a leak the field set cannot catch (APX-FR-01).',
    )
  }
}

function assertTimestamp(field: string, value: string, ref: SignalRef): void {
  if (!ISO_8601_UTC.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ClassificationError(
      'invalid-signal',
      ref,
      `${field} must be an ISO 8601 UTC timestamp to the millisecond, as YYYY-MM-DDTHH:MM:SS.sssZ: the durable log stores timestamps as text and orders them lexicographically (EL-FR-02).`,
    )
  }
}
