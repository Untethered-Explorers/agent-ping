// opencode's event vocabulary translated into the signal the hub classifies
// (OA-FR-02, OA-FR-03, OA-FR-06, APX-CON-09, APX-CON-13, ADR-004, ADR-005).
//
// WHAT THIS MODULE IS
// A table and a reader. The table says which of opencode's event names agent-ping
// observes, what each one is worth, what it does to the turn's work signal, and
// where the identity its dedupe key is derived from comes from. The reader pulls
// four kinds of value out of a payload - a session id, a block id, a message id, a
// tool call id - plus two magnitudes, and reaches nothing else.
//
// THE CLASSIFIER IS THE AUTHORITY, NOT THIS TABLE
// The class, the subtype and the dedupe key are decided by
// src/domain/classify.ts, and the rows below *declare* what that decision is so a
// reviewer can read the whole mapping in one place. When this table and the
// classifier disagree, the classifier wins and this file is wrong: a second copy of
// the loudness rule is how a session that should have been quiet becomes noisy
// (ADR-004, ADR-005). tests/plugin/opencode-translate.test.ts drives every row
// through the real classifier and compares the answer, so the two cannot drift
// without a failure rather than without a reviewer's memory.
//
// EVIDENCE, ROW BY ROW, AND THE TWO PLACES THE DOCUMENTATION AND THE BINARY DISAGREE
// PRD 5 records the `event` hook as delivering ten event names. The union this
// adapter reads - the `Event` type in @opencode-ai/sdk 1.18.32, the version the
// running opencode 1.18.32 ships - carries thirty-two names, and two of the ten are
// not among them:
//
//   - `permission.asked` is not delivered. The block signal arrives as
//     `permission.updated`, whose payload is the permission itself. The row accepts
//     BOTH names and produces the signal `permission.asked`, because that is the
//     name the classifier's table keys the block on (EL-FR-07), and translating the
//     harness's vocabulary into the signal's is what an adapter is for. The identity
//     is the harness's own permission id either way, so one permission reported
//     under both names is one dedupe key and one event.
//   - `tool.execute.before` and `tool.execute.after` are not delivered as events
//     either. They are *hooks* in the plugin API, and the plugin subscribes to those
//     two as well as to the generic event hook, because the generic hook is the only
//     path to a permission ask (OA-FR-02) and these two are the only path to a tool
//     boundary. Both paths carry the same payload shape, so both take the same row
//     and the same reader.
//
// `permission.ask` - the *dedicated* permission hook - is deliberately absent from
// every table here: PRD 5 reports it as never firing upstream, and adapting a hook
// that cannot fire is how a plugin ships a block signal that never arrives
// (OA-FR-02). The plugin's hook set is asserted, not just this comment.
//
// WHAT THE TABLE CANNOT SEE, RECORDED RATHER THAN GUESSED
// Three gaps are real and none of them is papered over:
//
//   - `file.edited` carries no session identity at all - its payload is a file path
//     and nothing else - so it cannot be attributed to a turn. Attributing it to
//     whichever session looked busiest would be a guess, and a wrong guess credits a
//     greeting turn with another session's work, which is the one false positive the
//     idle gate exists to prevent. The row records the event and feeds no measure.
//     Nothing is lost: an edit in opencode is performed by a tool call, so the turn's
//     work is already recorded as a tool call.
//   - `todo.updated` carries no attempt number, so the `retry` fyi subtype cannot
//     fire from this harness: the measurement is absent and the classifier reports
//     `measurement-unavailable` rather than the adapter inventing a number.
//   - An idle transition has no identifier upstream, so the transition identity is
//     minted per turn. That is recorded in src/plugin/opencode/work-signal.ts, which
//     owns the mint and the reset, and it is the one place in this adapter that
//     derives identity rather than reading it.
//
// NOTHING HERE READS CONTENT
// The reader has no way to reach a prompt, a response, a tool argument, a tool
// output, a file path, a diff, a todo's text or an error's message. The events whose
// payloads hold those things are named in the table, and the fields taken from them
// are the four identities and two magnitudes above, so a payload full of text
// produces a signal with no trace of it (APX-FR-01, EL-FR-01).
// tests/plugin/opencode-translate.test.ts feeds recognisable content through every
// mapped event and asserts that none of it reaches the signal or the envelope.
//
// ONE DEDUPE KEY, ONE DERIVATION
// This file never builds a key. It supplies the identity the classifier derives the
// key from, and the classifier is the only derivation in the product, which is what
// makes a pushed signal and a polled one collapse to a single event (EL-FR-06,
// EL-FR-07, OA-FR-07).
//
// NO SOCKET, NO CLOCK OF ITS OWN
// The clock is injected and defaults to `Date.now`, so a test can drive a whole
// session against a fixed clock. The only outbound call in this file is the harness's
// own logging client, through `client.app.log` with this product's service name -
// never `console`, because a breadcrumb nobody can see is the same as a swallowed
// event (OA-FR-05, APX-FR-02). Delivery is a port the caller injects and is OA-2's
// module.

import type { Classification, HarnessSignal, Measurement } from '../../domain/classify.js'
import { classify } from '../../domain/classify.js'
import type { EventClass, FyiSubtype, Harness } from '../../domain/envelope.js'
import type { WorkMeasure, WorkSignalRecorder } from './work-signal.js'
import { createWorkSignalRecorder } from './work-signal.js'

// ---------------------------------------------------------------------------
// The product's name in the harness's log
// ---------------------------------------------------------------------------

/**
 * The service name every line this adapter writes carries.
 *
 * The harness's log is a shared surface with one entry per service, so a breadcrumb
 * without it is unattributable and effectively invisible (OA-FR-05). OA-2's transport
 * writes its lines under the same name; there is one exported string rather than two
 * that can drift.
 */
export const AGENT_PING_SERVICE = 'agent-ping'

/** The levels the harness's log client accepts (`AppLogData`, 1.18.32 SDK). */
export type HarnessLogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * The one method of opencode's client this adapter uses.
 *
 * `client.app.log({ body: { service, level, message, extra }, query: { directory } })`,
 * as declared by `AppLogData` in @opencode-ai/sdk 1.18.32. The shape is declared
 * structurally rather than imported from the harness's own package, because this file
 * has to load inside the harness with no dependency and no build step, and the
 * declaration below is the one that ships with the version the harness runs.
 */
export interface OpencodeLogClient {
  app: {
    log(input: {
      body?: {
        service: string
        level: HarnessLogLevel
        message: string
        extra?: Record<string, unknown>
      }
      query?: { directory?: string }
    }): unknown
  }
}

/**
 * One line: a level, a fixed sentence, and at most a few closed tokens.
 *
 * `extra` exists for the service, the session and the event type a breadcrumb must
 * name (OA-FR-05) and for nothing else. A breadcrumb travels through the harness's
 * own log, which a developer reads and a log file keeps, so a value here is a value
 * on disk (APX-FR-01, APX-CON-12).
 */
export interface HarnessLogLine {
  readonly message: string
  readonly extra?: Readonly<Record<string, unknown>>
}

export interface HarnessLog {
  debug(line: HarnessLogLine): void
  info(line: HarnessLogLine): void
  warn(line: HarnessLogLine): void
  error(line: HarnessLogLine): void
}

export interface HarnessLogOptions {
  readonly service?: string
  /** The session directory, which the harness's log endpoint scopes by. */
  readonly directory?: string
}

/**
 * A logger that writes through the harness and cannot fail.
 *
 * Two guarantees, and both are why this is a wrapper rather than a direct call: a
 * logging client that throws must not reach the developer's session (APX-CON-10),
 * and a returned request that rejects must not become an unhandled rejection. A
 * breadcrumb that cannot be written is a lost line, so the second failure is
 * swallowed here rather than escalated - the event itself still reaches the hub on
 * every other path.
 */
export function createHarnessLog(
  client: OpencodeLogClient,
  options: HarnessLogOptions = {},
): HarnessLog {
  const service = options.service ?? AGENT_PING_SERVICE
  const write = (line: HarnessLogLine, level: HarnessLogLevel): void => {
    try {
      const request = client.app.log({
        body: {
          service,
          level,
          message: line.message,
          ...(line.extra === undefined ? {} : { extra: { ...line.extra } }),
        },
        ...(options.directory === undefined ? {} : { query: { directory: options.directory } }),
      })
      if (isThenable(request)) request.then(undefined, () => undefined)
    } catch {
      // Nothing to do and nowhere to say so: the developer's session continues, which
      // is the one outcome that is never negotiable (APX-CON-03).
    }
  }
  return {
    debug: (line) => write(line, 'debug'),
    info: (line) => write(line, 'info'),
    warn: (line) => write(line, 'warn'),
    error: (line) => write(line, 'error'),
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

// ---------------------------------------------------------------------------
// The harness's event shape
// ---------------------------------------------------------------------------

/**
 * One event from the generic `event` hook, or from a tool hook, as this adapter
 * reads it.
 *
 * Structural, and deliberately the loosest useful shape: `properties` is `unknown`
 * because it is whatever the harness delivered, and every field is read through the
 * readers below rather than trusted. A payload of the wrong shape yields no signal
 * and a counter - never a crash, and never a wrong row.
 */
export interface OpencodeEvent {
  readonly type: string
  readonly properties?: unknown
}

/**
 * What the two tool hooks deliver: `{ tool, sessionID, callID }`.
 *
 * It doubles as the `properties` of a synthetic `tool.execute.*` event, so a tool
 * boundary takes exactly the same path through the table whether opencode delivers it
 * on the event hook (as PRD 5 says it does) or through the dedicated hooks (as the
 * 1.18.32 types declare). `tool` is part of the shape and is never read: a tool name
 * is an identity this product has no use for, and reading it is the first step
 * towards reading its arguments.
 */
export type OpencodeToolBoundary = Readonly<Record<string, unknown>>

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * How a row's variant is decided.
 *
 *   - absent: the event name has no variant, and every row for it is variantless.
 *   - `'idle'`: the row is for the idle status specifically.
 *   - `'from-status'`: the row is for every *other* status, and the status value
 *     travels into the signal as its variant - which is how a status this build has
 *     never seen reaches the classifier as a recorded decision rather than stopping
 *     at an unmapped-signal failure in an adapter (ADR-004).
 */
export type VariantSource = 'from-status'

/** Where a row's dedupe identity comes from. */
export type IdentitySource =
  /** The permission's own id: one block, one key, however often it is asked. */
  | 'permission-id'
  /** The assistant message's own id. */
  | 'message-id'
  /** The tool call's own id. */
  | 'tool-call-id'
  /** The turn identity the recorder minted for this turn. */
  | 'turn'
  /** No identity upstream, so one is minted per signal in `part:n` form. */
  | 'minted'

/** What an event does to the turn's work signal. `null` is a decision, not an omission. */
export type WorkEffect = WorkMeasure | null

/** What an event does to the tool call it names. */
export type TimingEffect = 'start' | 'stop' | 'none'

/**
 * What one opencode event is worth.
 *
 * Every field is data a test can read rather than a comment beside a conditional,
 * and `evidence` is the part that matters most: every row says what it stands on and
 * where that was read, so a claim about a harness's payload can always be traced to a
 * declaration rather than to memory.
 */
export interface OpencodeEventRow {
  /**
   * The event names this row covers, verbatim as the harness spells them. Two names
   * appear on one row where the harness's vocabulary and the signal's differ.
   */
  readonly harnessEvents: readonly string[]
  /** The signal's event name: what the classifier's table keys on. */
  readonly signalEventName: string
  /** The signal's variant, or how it is derived. */
  readonly variant?: 'idle' | VariantSource
  /** What the classifier produces for this signal, or `null` when it produces none. */
  readonly class: EventClass | null
  /** Non-null exactly when the class is fyi. */
  readonly subtype: FyiSubtype | null
  /**
   * Whether the translated signal is handed to the delivery port.
   *
   * `never` is a decision with a reason in `note`, for the two kinds of row that have
   * nothing to say beyond their effect on the turn: a tool call's before boundary,
   * and a non-idle status the classifier records as producing nothing. `always` is not
   * "becomes an event", and `permission.replied` is what proves it: it becomes no
   * event and is still posted, because the hub's pending lifecycle clears the block
   * addressed by that signal and a resolution that is never sent is a badge that
   * never clears (EL-FR-08).
   */
  readonly posts: 'always' | 'never'
  /** What the event records against the turn's work signal. */
  readonly work: WorkEffect
  /** Whether the event begins a turn, ends one, or neither. */
  readonly turnBoundary: 'begins' | 'ends' | 'none'
  /** What the event does to the tool call's clock. */
  readonly timing: TimingEffect
  /** Where the dedupe identity comes from. */
  readonly identity: IdentitySource | null
  /**
   * The minted identity's namespace, when `identity` is `'minted'`: one short token
   * per kind of signal, so an error is `error:1`, a compaction `compaction:1`, and
   * neither can be mistaken for the other in a log.
   */
  readonly mintedPart?: string
  /** The magnitudes the signal carries, if its payload has them. */
  readonly measurements: readonly Measurement[]
  /**
   * The measurement the classifier's row for this signal needs and this harness's
   * payload does not carry, or null when there is no such gap.
   *
   * Named rather than left to be discovered, because "the row maps to fyi/retry" and
   * "no retry event can ever be produced on this harness" are both true at once and
   * a reader deserves to be told which one they are looking at. A gap is a capability
   * the harness does not expose, so the classifier reports it as
   * `measurement-unavailable` and the adapter invents no number (ADR-004).
   */
  readonly measurementGap: Measurement | null
  /**
   * Whether the event also carries the turn's work signal.
   *
   * True for the two forms of the idle transition and for nothing else, which is what
   * the requirement asks for: the work signal travels with the idle transition so the
   * hub can suppress a greeting-and-close turn (OA-FR-03).
   */
  readonly carriesWorkSignal: boolean
  /** What this row stands on, and where that was read. */
  readonly evidence: {
    /**
     *   - `observed`: read out of the event union or a hook input of the version
     *     named in `source`.
     *   - `documented`: recorded by PRD 5 for a name the installed types do not
     *     deliver, so the row is here for a harness that does.
     *   - `derived`: the event is observed but its payload cannot answer what this row
     *     needs, and the gap is recorded rather than filled in.
     */
    readonly status: 'observed' | 'documented' | 'derived'
    readonly source: string
  }
  /** Why this row is what it is, in one or two lines. */
  readonly note: string
}

/**
 * Everything opencode's `event` hook and the two tool hooks can mean, in one table.
 *
 * The opencode rows of the classifier's table are the contract this file answers to;
 * the additions are the names the installed 1.18.32 types deliver that PRD 5 does not
 * list (`permission.updated`, `file.edited`), because a table that ignores what the
 * harness actually sends is a table that ships a block signal that never arrives.
 *
 * tests/plugin/opencode-translate.test.ts asserts this table three ways: every row
 * against the real classifier, every documented event name against a row, and the
 * union of these names and the unmapped ones against the full 1.18.32 event union, so
 * a name the harness starts delivering cannot arrive without a decision about it.
 */
export const OPENCODE_EVENT_TABLE: readonly OpencodeEventRow[] = [
  // --- the idle transition, in both of the forms opencode delivers ---------
  {
    harnessEvents: ['session.status'],
    signalEventName: 'session.status',
    variant: 'idle',
    class: 'finished',
    subtype: null,
    posts: 'always',
    work: null,
    turnBoundary: 'ends',
    timing: 'none',
    identity: 'turn',
    measurements: [],
    measurementGap: null,
    carriesWorkSignal: true,
    evidence: {
      status: 'observed',
      source:
        'EventSessionStatus in @opencode-ai/sdk 1.18.32: { sessionID, status: { type: "idle" | "retry" | "busy" } }',
    },
    note:
      "the modern form of the idle transition. It ends the turn, reports the turn's work signal and takes the minted turn identity, so the deprecated session.idle event of the same turn derives the same key (EL-FR-06).",
  },
  {
    harnessEvents: ['session.status'],
    signalEventName: 'session.status',
    variant: 'from-status',
    class: null,
    subtype: null,
    posts: 'never',
    work: null,
    turnBoundary: 'begins',
    timing: 'none',
    identity: null,
    measurements: [],
    measurementGap: null,
    carriesWorkSignal: false,
    evidence: {
      status: 'observed',
      source:
        'SessionStatus in @opencode-ai/sdk 1.18.32 carries "busy" and "retry" beside "idle"',
    },
    note:
      "a non-idle status begins a new turn, which is where the work signal is reset (OA-FR-03). It is not posted: the classifier records it as not a class event, and the idle transition that ends the same turn carries everything there is to say about it. The status value travels as the signal's variant, so a status this build has never seen is a recorded decision rather than an unmapped signal.",
  },
  {
    harnessEvents: ['session.idle'],
    signalEventName: 'session.idle',
    class: 'finished',
    subtype: null,
    posts: 'always',
    work: null,
    turnBoundary: 'ends',
    timing: 'none',
    identity: 'turn',
    measurements: [],
    measurementGap: null,
    carriesWorkSignal: true,
    evidence: {
      status: 'observed',
      source: 'EventSessionIdle in @opencode-ai/sdk 1.18.32: { sessionID }',
    },
    note:
      'deprecated in favour of session.status and still delivered (PRD 5). It ends the same turn, reports the same work signal and takes the same turn identity, so both forms of one transition derive one key and the log stores one event. Its work measures have already been reported by whichever form arrived first, which is why the second form of one transition reports no work rather than the same work twice.',
  },

  // --- the block, and its resolution --------------------------------------
  {
    harnessEvents: ['permission.updated', 'permission.asked'],
    signalEventName: 'permission.asked',
    class: 'needs-you',
    subtype: null,
    posts: 'always',
    work: null,
    turnBoundary: 'none',
    timing: 'none',
    identity: 'permission-id',
    measurements: [],
    measurementGap: null,
    carriesWorkSignal: false,
    evidence: {
      status: 'observed',
      source:
        'EventPermissionUpdated in @opencode-ai/sdk 1.18.32 carries the Permission itself: { id, type, sessionID, messageID, callID?, title, metadata, time }',
    },
    note:
      'the only observable block signal, and the one class that leaves the app (EL-FR-07). PRD 5 names permission.asked on the event hook; the 1.18.32 union delivers permission.updated, so the row accepts both and produces the signal name the classifier keys the block on. The identity is the permission id, so the same permission delivered under both names is one key and one event. The permission title, its pattern and its metadata are never read. The dedicated permission.ask hook is documented as never firing and is not subscribed at all.',
  },
  {
    harnessEvents: ['permission.replied'],
    signalEventName: 'permission.replied',
    class: null,
    subtype: null,
    posts: 'always',
    work: null,
    turnBoundary: 'none',
    timing: 'none',
    identity: 'permission-id',
    measurements: [],
    measurementGap: null,
    carriesWorkSignal: false,
    evidence: {
      status: 'observed',
      source:
        'EventPermissionReplied in @opencode-ai/sdk 1.18.32: { sessionID, permissionID, response }',
    },
    note:
      'a resolution, and therefore posted even though it is not a class event: the hub clears the pending item addressed by this block identifier, and a resolution that is never sent is a badge that never clears (EL-FR-08). The response value is never read; the identifier is all the lifecycle needs.',
  },

  // --- the in-app signals, one row per documented subtype -----------------
  {
    harnessEvents: ['session.error'],
    signalEventName: 'session.error',
    class: 'fyi',
    subtype: 'error',
    posts: 'always',
    work: null,
    turnBoundary: 'none',
    timing: 'none',
    identity: 'minted',
    mintedPart: 'error',
    measurements: [],
    measurementGap: null,
    carriesWorkSignal: false,
    evidence: {
      status: 'observed',
      source:
        'EventSessionError in @opencode-ai/sdk 1.18.32: { sessionID?, error? }, with no error identifier',
    },
    note:
      'the error object is never read - not its name, not its data, not its message - because an error message is where a provider echoes the request that failed, and this product never holds a request (APX-FR-01). The session is optional upstream, so a sessionless error produces no signal and is counted instead, and the identity is minted because the payload carries none.',
  },
  {
    harnessEvents: ['session.compacted'],
    signalEventName: 'session.compacted',
    class: 'fyi',
    subtype: 'compaction',
    posts: 'always',
    work: null,
    turnBoundary: 'none',
    timing: 'none',
    identity: 'minted',
    mintedPart: 'compaction',
    measurements: [],
    measurementGap: null,
    carriesWorkSignal: false,
    evidence: {
      status: 'observed',
      source: 'EventSessionCompacted in @opencode-ai/sdk 1.18.32: { sessionID }',
    },
    note:
      'worth seeing before the next turn starts without the earlier context. The payload is a session id and nothing else, so the identity is minted per session.',
  },
  {
    harnessEvents: ['message.updated'],
    signalEventName: 'message.updated',
    class: 'fyi',
    subtype: 'token-burn',
    posts: 'always',
    work: null,
    turnBoundary: 'none',
    timing: 'none',
    identity: 'message-id',
    measurements: ['tokensUsed'],
    measurementGap: null,
    carriesWorkSignal: false,
    evidence: {
      status: 'observed',
      source:
        'EventMessageUpdated in @opencode-ai/sdk 1.18.32: { info: Message }, and AssistantMessage.tokens is { input, output, reasoning, cache: { read, write } }',
    },
    note:
      "the burn signal the message carries, summed across the five counters and compared against the classifier's threshold; the sum is a measurement and dies at the classifier, because a number that grows with what was said is a transcript in disguise (APX-FR-01). The message id is the identity, and nothing else about the message is read - not its parts, not its text, not its cost.",
  },
  {
    harnessEvents: ['tool.execute.after'],
    signalEventName: 'tool.execute.after',
    class: 'fyi',
    subtype: 'long-tool-call',
    posts: 'always',
    work: null,
    turnBoundary: 'none',
    timing: 'stop',
    identity: 'tool-call-id',
    measurements: ['durationMs'],
    measurementGap: null,
    carriesWorkSignal: false,
    evidence: {
      status: 'observed',
      source:
        'the "tool.execute.after" hook input in @opencode-ai/plugin 1.18.32: { tool, sessionID, callID }, with the tool\'s title, output and metadata in the hook\'s output argument',
    },
    note:
      "a tool call that has not returned quickly. The duration is measured here, from the before boundary to this one, because the payload carries no timestamps; a call whose before boundary was never observed carries no measurement at all and the classifier reports measurement-unavailable rather than a guessed duration. The tool name, its arguments and its output are never read.",
  },
  {
    harnessEvents: ['todo.updated'],
    signalEventName: 'todo.updated',
    class: 'fyi',
    subtype: 'retry',
    posts: 'always',
    work: 'todo-update',
    turnBoundary: 'none',
    timing: 'none',
    identity: 'minted',
    mintedPart: 'todo',
    measurements: [],
    measurementGap: 'attempt',
    carriesWorkSignal: false,
    evidence: {
      status: 'observed',
      source:
        'EventTodoUpdated in @opencode-ai/sdk 1.18.32: { sessionID, todos: [{ id, content, status, priority }] }',
    },
    note:
      "a todo update is a turn's work, so the row records the work measure. The payload carries no attempt number, so the retry subtype cannot fire from this harness: the measurement is absent, the classifier reports measurement-unavailable, and the adapter does not invent one. A todo's text is never read, and its id is not the identity either - that names a todo rather than an update - so the identity is minted.",
  },

  // --- boundaries that exist only to say the turn did work -----------------
  {
    harnessEvents: ['tool.execute.before'],
    signalEventName: 'tool.execute.before',
    class: null,
    subtype: null,
    posts: 'never',
    work: 'tool-call',
    turnBoundary: 'none',
    timing: 'start',
    identity: null,
    measurements: [],
    measurementGap: null,
    carriesWorkSignal: false,
    evidence: {
      status: 'observed',
      source:
        'the "tool.execute.before" hook input in @opencode-ai/plugin 1.18.32: { tool, sessionID, callID }',
    },
    note:
      "the work signal, and nothing else: it records that the turn called a tool and starts the call's clock, which is what makes the after boundary's duration real rather than a guess. It is not posted, because the classifier records it as not a class event and the hub has nothing to do with it.",
  },
  {
    harnessEvents: ['file.edited'],
    signalEventName: 'file.edited',
    class: null,
    subtype: null,
    posts: 'never',
    work: null,
    turnBoundary: 'none',
    timing: 'none',
    identity: null,
    measurements: [],
    measurementGap: null,
    carriesWorkSignal: false,
    evidence: {
      status: 'derived',
      source:
        'EventFileEdited in @opencode-ai/sdk 1.18.32: { file } - a file path and no session identifier',
    },
    note:
      "observed, and deliberately not attributed. The payload names no session, so any assignment to a turn would be a guess, and a wrong guess credits a greeting turn with another session's work - the one false positive the idle gate exists to prevent. The row exists so that decision is on the record: an edit in opencode is performed by a tool call, so the turn's work is already recorded as a tool call and nothing is lost. The file path is never read.",
  },
]

/** An event name this adapter does not map, and why. */
export interface UnmappedEvent {
  readonly name: string
  readonly reason: string
}

/**
 * The event names this adapter observes and deliberately does not report.
 *
 * The stream carries far more than this product reports, and the difference has to
 * be a list rather than a default: "we do not report this" is a decision, and a
 * decision nobody wrote down is indistinguishable from an oversight (APX-FR-02).
 * Every name the installed 1.18.32 union delivers appears in exactly one of this
 * list and `OPENCODE_EVENT_TABLE`, which the test asserts name by name.
 */
export const OPENCODE_UNMAPPED_EVENTS: readonly UnmappedEvent[] = [
  { name: 'server.instance.disposed', reason: "the harness's own server lifecycle" },
  { name: 'server.connected', reason: "the harness's own server lifecycle" },
  { name: 'installation.updated', reason: "opencode's own installation, not a session" },
  {
    name: 'installation.update-available',
    reason: "opencode's own installation, not a session",
  },
  {
    name: 'lsp.client.diagnostics',
    reason: "a language server's diagnostics, not an agent signal",
  },
  { name: 'lsp.updated', reason: "a language server's lifecycle, not an agent signal" },
  {
    name: 'message.removed',
    reason: 'a message leaving the log; this product never stored one, so there is nothing to retract',
  },
  {
    name: 'message.part.updated',
    reason: 'a streaming part; the message-level event carries the same signal once per message',
  },
  {
    name: 'message.part.removed',
    reason: 'a streaming part leaving, for the same reason as message.removed',
  },
  {
    name: 'command.executed',
    reason: "a user-initiated command; the turn it belongs to is already reported by its tool calls and its idle transition",
  },
  {
    name: 'session.created',
    reason: 'a session starting is where the work signal begins empty, which is the state it is already in',
  },
  {
    name: 'session.updated',
    reason: 'a title or metadata change, which is not a signal this product reports',
  },
  { name: 'session.deleted', reason: 'a session leaving; this product retracts nothing' },
  {
    name: 'session.diff',
    reason: 'a diff of the working tree: file content, and the one thing this product must never read (APX-FR-01)',
  },
  {
    name: 'file.watcher.updated',
    reason: "an external filesystem change, which is not this session's work",
  },
  { name: 'vcs.branch.updated', reason: 'a branch change, which is not a signal this product reports' },
  {
    name: 'tui.prompt.append',
    reason: "the harness's own prompt surface, which is conversation content (APX-FR-01)",
  },
  {
    name: 'tui.command.execute',
    reason: "the harness's own UI, for the same reason as tui.prompt.append",
  },
  { name: 'tui.toast.show', reason: "the harness's own toast, which is not an agent signal" },
  { name: 'pty.created', reason: 'a terminal the developer opened, not a turn' },
  { name: 'pty.updated', reason: 'a terminal the developer is typing into, not a turn' },
  { name: 'pty.exited', reason: 'a terminal closing, not a turn' },
  { name: 'pty.deleted', reason: 'a terminal closing, not a turn' },
]

/**
 * A documented event name this adapter refuses to subscribe to.
 *
 * The dedicated permission hook PRD 5 reports as never firing upstream. Adapting it
 * would ship a block signal that cannot arrive and a table test that passes anyway,
 * so the plugin's hook set has no such key and the test asserts its absence.
 */
export const OPENCODE_UNSUBSCRIBED_HOOKS: readonly string[] = ['permission.ask']

// ---------------------------------------------------------------------------
// The translator
// ---------------------------------------------------------------------------

/**
 * The signal one opencode event produced, and the adapter's local read of it.
 *
 * The classification is this adapter's own opinion of its own signal, used to decide
 * what to report and what to breadcrumb. The hub classifies again on arrival: it is
 * the authority, and this is a preview of that answer rather than a substitute for
 * it, which is why a signal is delivered whether or not the local answer says it
 * becomes an event.
 */
export interface TranslatedSignal {
  readonly signal: HarnessSignal
  readonly classification: Classification
}

export interface TranslatorOptions {
  /** The session directory this plugin is attached to, and the repository path. */
  readonly directory: string
  /** Milliseconds since the epoch. Injected so a test can pin a session's clock. */
  readonly now?: () => number
  /** The work-signal recorder. One per plugin instance; a test may pass its own. */
  readonly recorder?: WorkSignalRecorder
  /** How many open tool calls are timed at once. */
  readonly maxOpenToolCalls?: number
}

/**
 * What the translator has seen.
 *
 * Three counters and no event data, because this is the surface an operator asks
 * "why did nothing arrive?" with, and a count answers that where a log line would
 * carry content (APX-FR-01, APX-FR-02).
 *
 * `unattributed` is the one that matters: a mapped event whose payload named no
 * session is counted rather than dropped, so a harness that stops naming sessions
 * becomes visible instead of quiet.
 */
export interface TranslatorStats {
  /** Signals produced and handed to the delivery port. */
  readonly translated: number
  /** Event names that arrived with no row, every one of them a recorded decision. */
  readonly ignored: number
  /** Mapped events whose payload named no session, so nothing could be reported. */
  readonly unattributed: number
}

export interface Translator {
  /**
   * Translate one event.
   *
   * Returns the signal and the adapter's local read of it, or null when the event
   * produces no signal: an unmapped name, a payload that names no session, or a row
   * whose work-signal and turn-boundary effects have been applied and which is not
   * posted. A null return is never a swallowed event - the counters above say which
   * of the three it was.
   *
   * Throws `ClassificationError` when a row the table maps cannot be built into a
   * valid signal, which is a fact about the harness's payload rather than about the
   * event's name; the plugin turns that into a breadcrumb (OA-FR-05, APX-FR-02).
   */
  observe(event: OpencodeEvent): TranslatedSignal | null
  /**
   * The identity the session's current turn would be keyed by.
   *
   * For the polling fallback, which must not mint a key of its own or a session that
   * both pushes and is polled produces two of everything (OA-FR-07).
   */
  currentTransitionId(sessionId: string): string
  /**
   * The session an event belongs to, or undefined when its payload names none.
   *
   * Exposed so a breadcrumb can name the session even when the signal could not be
   * built and the classification failed (OA-FR-05). It is the same reader the
   * translation uses, so the breadcrumb and the signal can never disagree about which
   * session an event belonged to.
   */
  sessionIdOf(event: OpencodeEvent): string | undefined
  /** The work-signal recorder, so a caller can read a turn without an event. */
  readonly recorder: WorkSignalRecorder
  readonly stats: TranslatorStats
}

/** The harness name every row belongs to, from the closed set. */
const HARNESS: Harness = 'opencode'

/**
 * How many tool calls are timed at once.
 *
 * A call that is never closed - the harness died mid-call, the plugin attached
 * mid-turn - would otherwise sit in the map for the life of the process. Forgetting
 * one costs only its duration, which means no long-tool-call report.
 */
export const MAX_OPEN_TOOL_CALLS = 256

export function createTranslator(options: TranslatorOptions): Translator {
  const now = options.now ?? ((): number => Date.now())
  const recorder = options.recorder ?? createWorkSignalRecorder()
  const maxOpenToolCalls = Math.max(1, options.maxOpenToolCalls ?? MAX_OPEN_TOOL_CALLS)
  const openCalls = new Map<string, number>()
  const counters = { translated: 0, ignored: 0, unattributed: 0 }

  /**
   * One event, end to end.
   *
   * The order is the requirement: read the event's identity, apply what the event
   * *does* to the turn, and only then decide whether there is anything to report.
   * Applying the effects first is what makes `tool.execute.before` - which produces no
   * signal at all - still the reason the turn's work is known.
   */
  const observe = (event: OpencodeEvent): TranslatedSignal | null => {
    if (typeof event?.type !== 'string') {
      counters.ignored += 1
      return null
    }
    const payload = recordOf(event.properties)
    // The status value is the signal's variant, and a status event with no status is
    // a payload this build cannot reason about rather than a turn boundary: it is
    // counted and nothing is touched, because resetting a turn on a malformed event
    // is how a working turn loses its work signal.
    const statusType = event.type === 'session.status' ? statusTypeOf(payload) : undefined
    if (event.type === 'session.status' && statusType === undefined) {
      counters.unattributed += 1
      return null
    }
    const row = findRow(event.type, statusType)
    if (row === undefined) {
      counters.ignored += 1
      return null
    }
    const sessionId = sessionIdOf(payload)
    if (sessionId === undefined) {
      counters.unattributed += 1
      return null
    }

    if (row.turnBoundary === 'begins') recorder.beginTurn(sessionId)
    if (row.work !== null) recorder.noteWork(sessionId, row.work)
    const turn = row.turnBoundary === 'ends' ? recorder.reportTurn(sessionId) : null
    if (row.timing === 'start') startCall(payload, sessionId)
    if (row.posts === 'never') return null

    // The call's clock is stopped whatever the row does with the duration, so a
    // boundary that is only a boundary cannot leave an entry open for the life of the
    // process. The map is bounded as well; this is the tidier of the two guards.
    const durationMs = row.timing === 'stop' ? stopCall(payload, sessionId) : undefined
    const measurements =
      row.measurements.length === 0 ? undefined : readMeasurements(row, payload, durationMs)
    const variant = variantFor(row, statusType)
    const signal: HarnessSignal = {
      harness: HARNESS,
      eventName: row.signalEventName,
      ...(variant === undefined ? {} : { variant }),
      sessionId,
      // The session directory, verbatim, as the repository's full path. The short name
      // is derived from it by the classifier and is never set here, so an adapter
      // cannot label a row with a path (APX-CON-09, ADR-008).
      repoFullPath: options.directory,
      ...identityFor(row, payload, sessionId, turn, recorder),
      occurredAt: occurredAtOf(payload, now),
      receivedAt: new Date(now()).toISOString(),
      ...(row.carriesWorkSignal && turn !== null ? { turnWork: turn.work } : {}),
      ...(measurements === undefined ? {} : { measurements }),
    }
    // Counted only once the classifier has answered, so the counter means "signals
    // handed to the delivery port" rather than "signals built and then refused".
    const classification = classify(signal)
    counters.translated += 1
    return { signal, classification }
  }

  /** Start a call's clock, forgetting the oldest when the map is full. */
  const startCall = (payload: Readonly<Record<string, unknown>>, sessionId: string): void => {
    const callId = stringAt(payload, 'callID')
    if (callId === undefined) return
    const key = `${sessionId}:${callId}`
    openCalls.delete(key)
    openCalls.set(key, now())
    while (openCalls.size > maxOpenToolCalls) {
      const oldest = openCalls.keys().next()
      if (oldest.done === true) return
      openCalls.delete(oldest.value)
    }
  }

  /** A call's duration, or undefined when its before boundary was never observed. */
  const stopCall = (payload: Readonly<Record<string, unknown>>, sessionId: string): number | undefined => {
    const callId = stringAt(payload, 'callID')
    if (callId === undefined) return undefined
    const key = `${sessionId}:${callId}`
    const startedAt = openCalls.get(key)
    if (startedAt === undefined) return undefined
    openCalls.delete(key)
    const elapsed = now() - startedAt
    return elapsed >= 0 ? elapsed : undefined
  }

  return {
    observe,
    currentTransitionId: (sessionId: string): string => recorder.currentTransitionId(sessionId),
    sessionIdOf: (event: OpencodeEvent): string | undefined =>
      typeof event?.type === 'string' ? sessionIdOf(recordOf(event.properties)) : undefined,
    recorder,
    get stats(): TranslatorStats {
      return { ...counters }
    },
  }
}

/** The signal's variant, from the row's own rule. */
function variantFor(row: OpencodeEventRow, statusType: string | undefined): string | undefined {
  if (row.variant === 'idle') return 'idle'
  if (row.variant === 'from-status') return statusType
  return undefined
}

/**
 * The identity fields of a signal, spread into it.
 *
 * Spread rather than assigned so an absent identity is an absent field instead of an
 * `undefined` one, which is what the ingest route's closed key set requires
 * (HC-FR-04).
 */
function identityFor(
  row: OpencodeEventRow,
  payload: Readonly<Record<string, unknown>>,
  sessionId: string,
  turn: ReturnType<WorkSignalRecorder['turn']> | null,
  recorder: WorkSignalRecorder,
): { readonly transitionId?: string } {
  if (row.identity === null) return {}
  if (row.identity === 'turn') return turn === null ? {} : { transitionId: turn.transitionId }
  if (row.identity === 'permission-id') {
    const blockId = blockIdOf(payload)
    return blockId === undefined ? {} : { transitionId: blockId }
  }
  if (row.identity === 'message-id') {
    const messageId = stringAt(recordOf(payload['info']), 'id')
    return messageId === undefined ? {} : { transitionId: messageId }
  }
  if (row.identity === 'tool-call-id') {
    const callId = stringAt(payload, 'callID')
    return callId === undefined ? {} : { transitionId: callId }
  }
  // Minted: the payload named no identity of its own, so one is minted per signal in
  // this row's namespace. Never derived from a clock: a key with a timestamp in it
  // changes on replay and defeats the dedupe (EL-FR-06).
  return { transitionId: recorder.mintIdentity(sessionId, row.mintedPart ?? 'signal') }
}

// ---------------------------------------------------------------------------
// Payload readers
// ---------------------------------------------------------------------------

/**
 * An object, or an empty record for anything else.
 *
 * Arrays count as "not an object" here on purpose: a payload that is a list of
 * things is not a payload this product can read an identity out of, and treating it
 * as a record would let `length` look like a field.
 */
function recordOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}

function stringAt(source: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberAt(source: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * The session an event belongs to.
 *
 * Two spellings, both observed: most events carry `sessionID` at the top of the
 * payload, and `message.updated` carries a `Message` under `info`. Nothing else is
 * consulted, and in particular no part of a message is walked to find one.
 */
function sessionIdOf(payload: Readonly<Record<string, unknown>>): string | undefined {
  return stringAt(payload, 'sessionID') ?? stringAt(recordOf(payload['info']), 'sessionID')
}

/**
 * The permission a block or a resolution is about.
 *
 * `permissionID` on a reply, `id` on the permission itself: two observed spellings of
 * one identity, and the reason a block and its resolution address the same dedupe key
 * (EL-FR-07, EL-FR-08). The reply's `response` value is never read.
 */
function blockIdOf(payload: Readonly<Record<string, unknown>>): string | undefined {
  return stringAt(payload, 'permissionID') ?? stringAt(payload, 'id')
}

/**
 * The status value, which is the signal's variant.
 *
 * Only for `session.status`, and only the `type` of the status: `retry` also carries
 * an attempt and a message, and a message is something this product never reads.
 */
function statusTypeOf(payload: Readonly<Record<string, unknown>>): string | undefined {
  return stringAt(recordOf(payload['status']), 'type')
}

/**
 * The row for an event name and its variant.
 *
 * An event name with variant rows always has a `from-status` row beside them, so the
 * lookup is total for any name the table covers; a name it does not cover is undefined
 * and is counted, not guessed at.
 */
function findRow(eventType: string, variant: string | undefined): OpencodeEventRow | undefined {
  const rows = OPENCODE_EVENT_TABLE.filter((row) => row.harnessEvents.includes(eventType))
  if (rows.length === 0) return undefined
  if (rows.length === 1) return rows[0]
  if (variant !== undefined) {
    return rows.find((row) => row.variant === variant) ?? rows.find((row) => row.variant === 'from-status')
  }
  return rows.find((row) => row.variant === undefined)
}

// ---------------------------------------------------------------------------
// Timestamps and measurements
// ---------------------------------------------------------------------------

/**
 * When the event happened, ISO 8601 UTC to the millisecond.
 *
 * The harness's own timestamp where the payload has one - `message.updated` carries
 * its message's creation and completion times - and the adapter's clock otherwise.
 * Either way the format is the one the durable log orders lexicographically
 * (EL-FR-02), which is why the conversion lives here rather than in each row.
 */
function occurredAtOf(payload: Readonly<Record<string, unknown>>, now: () => number): string {
  const time = recordOf(recordOf(payload['info'])['time'])
  const harness = numberAt(time, 'completed') ?? numberAt(time, 'created')
  return new Date(harness ?? now()).toISOString()
}

/**
 * The magnitudes a row's payload carries, or undefined when it carries none.
 *
 * A token count is summed across the five counters opencode reports, and a tool
 * call's duration comes from the before boundary the translator timed. Both are
 * measurements and both die at the classifier: the envelope keeps the class they
 * decided and not the numbers (APX-FR-01, EL-FR-04).
 */
function readMeasurements(
  row: OpencodeEventRow,
  payload: Readonly<Record<string, unknown>>,
  durationMs: number | undefined,
): Readonly<Partial<Record<Measurement, number>>> | undefined {
  const measured: Partial<Record<Measurement, number>> = {}
  for (const measurement of row.measurements) {
    if (measurement === 'tokensUsed') {
      const tokens = tokensUsedOf(payload)
      if (tokens !== undefined) measured.tokensUsed = tokens
      continue
    }
    if (measurement === 'durationMs') {
      if (durationMs !== undefined) measured.durationMs = durationMs
      continue
    }
    // `attempt` is the only measurement opencode reports outside a payload's token
    // counters, and only on a status event - which no row carries today. The branch
    // is here so a future row that does is one line rather than a new reader.
    const attempt = numberAt(payload, 'attempt')
    if (attempt !== undefined) measured.attempt = attempt
  }
  return Object.keys(measured).length === 0 ? undefined : measured
}

/**
 * The tokens a message consumed, summed over the five counters.
 *
 * Undefined when the message is a user's rather than an assistant's, because a user
 * message has no token count and zero is not the same answer as none: the classifier
 * reads a missing measurement as a capability gap and a zero as a measurement saying
 * the turn was free.
 */
function tokensUsedOf(payload: Readonly<Record<string, unknown>>): number | undefined {
  const tokens = recordOf(recordOf(payload['info'])['tokens'])
  const cache = recordOf(tokens['cache'])
  const parts = [
    numberAt(tokens, 'input'),
    numberAt(tokens, 'output'),
    numberAt(tokens, 'reasoning'),
    numberAt(cache, 'read'),
    numberAt(cache, 'write'),
  ].filter((value): value is number => value !== undefined)
  return parts.length === 0 ? undefined : parts.reduce((total, value) => total + value, 0)
}
