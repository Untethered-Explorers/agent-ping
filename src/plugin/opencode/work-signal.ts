// The per-turn work signal: did the turn that just ended do real work, and what
// identity does that turn's events carry (OA-FR-03, EL-FR-05, EL-FR-06, ADR-004,
// ADR-008).
//
// WHAT THIS MODULE IS, AND WHAT IT IS NOT
// It is a recorder of three booleans per turn and a mint for the identifiers the
// dedupe key is derived from. It is deliberately NOT the idle gate: the rule that a
// turn with no work produces no event at all belongs to the classifier
// (src/domain/classify.ts), and this module imports only the *type* of the work
// signal from there. A recorder that also decided would be a second copy of the
// loudness decision, which is exactly the drift the classifier's own header warns
// about - and the drift would be invisible, because both copies would look
// plausible. tests/plugin/opencode-work-signal.test.ts asserts this file's imports,
// so the separation is a property of the code and not of a paragraph.
//
// WHY AN ACCUMULATOR AT ALL
// "The session opened, greeted the developer and closed" must produce nothing, and
// "the session did two hours of work and went idle" must produce exactly one
// finished event. The harness reports neither fact on the idle event itself: it
// reports that the session is idle, and the rest is spread across the turn's tool
// calls, file edits and todo updates. Only the adapter can see a turn boundary, so
// only the adapter can answer the question, and it answers it with three booleans
// that the classifier reads (EL-FR-05, OA-FR-03).
//
// The three measures, named as the requirement names them: a tool call, a file
// edit, a todo update. Flags and never counts, because a tally across a turn is a
// transcript wearing a numeric disguise - the same reason the store's work_signal
// column is a 0 or 1.
//
// THE TURN BOUNDARY, AND WHY THE RESET IS TWICE
// A turn begins when the harness reports the session busy (any non-idle status) and
// ends when it reports it idle. The measures are cleared at both ends, and the two
// resets do different jobs:
//
//   - `beginTurn` clears them when a new turn starts, so a turn is never credited
//     with the previous turn's work. This is the reset the requirement names
//     (OA-FR-03), and it is what keeps a second "hello, goodbye" turn quiet.
//   - `reportTurn` clears them when a turn ends, immediately after the caller has
//     read them, so an idle transition is never reported twice with the same work
//     and a missed busy status cannot leak one turn's work into the next. The
//     transition identity deliberately survives, because the deprecated
//     `session.idle` event and the modern `session.status` idle transition describe
//     ONE transition and must therefore share ONE dedupe key (EL-FR-06). Clearing
//     the identity at that point is what would turn one transition into two
//     finished events.
//
// THE TRANSITION IDENTITY IS MINTED, AND THAT IS RECORDED RATHER THAN HIDDEN
// opencode reports no identifier for an idle transition: `session.status` carries
// only a session id and a status, and `session.idle` carries only a session id
// (the evidence is cited row by row in src/plugin/opencode/translate.ts). The
// classifier requires an identity for any row that produces an event, and a key
// built from a timestamp would change on every replay, so a per-session sequence
// number is the only stable thing available: `idle:1`, `idle:2`, ... one per turn of
// that session.
//
// The consequence is recorded rather than glossed: the number counts the turns this
// recorder has seen for a session, so a plugin that restarts mid-turn mints a fresh
// number and the interrupted turn's finished event can be stored twice. That is a
// duplicate row in an in-app history, not a second notification, and the
// alternative - a key with no identity in it - is worse. The block identity, by
// contrast, is the harness's own permission id, so a repeated ask for one block is
// one key however often it is delivered (EL-FR-07).
//
// The polling fallback reuses the *same* mint rather than building keys of its own,
// which is what makes a session that both pushes and is polled collapse to one
// event (OA-FR-07): `currentTransitionId` is exported for exactly that, and the
// dedupe key itself is still derived by the classifier's one shared function.
//
// BOUNDED, BECAUSE THIS RUNS INSIDE A HARNESS
// The recorder is state in a process that also runs the developer's agent, so it is
// capped at `MAX_TRACKED_SESSIONS` and the least recently touched session is
// forgotten when the cap is reached. A forgotten session starts again from an empty
// turn, which can only under-report work - the failure mode that produces silence
// rather than a wrong notification, which is the right way round (ADR-004).
//
// Nothing here opens a socket, spawns a process, reads a clock or touches the
// filesystem: no clock means two events delivered in the same order always mint the
// same identities, and no I/O means this file cannot be the reason a session is
// slow (APX-CON-03, APX-CON-10, APX-CON-12).

import type { TurnWorkSignal } from '../../domain/classify.js'

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * The three things that count as work in a turn (EL-FR-05, OA-FR-03).
 *
 * A closed set of three, named after what the harness reported rather than after
 * anything agent-ping decided, so a fourth measure cannot appear without the
 * requirement changing with it.
 */
export type WorkMeasure = 'tool-call' | 'file-edit' | 'todo-update'

/** Every measure, for the tests that assert the set exhaustively. */
export const WORK_MEASURES: readonly WorkMeasure[] = ['tool-call', 'file-edit', 'todo-update']

/**
 * The name half of a minted identity, and the marker that tells a turn identity
 * from a per-signal one.
 *
 * Both use the same `part:n` shape on purpose: one derivation, one shape to read in
 * a log, and no way to mistake a transition for an error by looking at it. The
 * namespace is reserved - `mintIdentity` refuses it - so a per-signal mint can never
 * renumber the turns of a live session.
 */
export const TURN_IDENTITY_PART = 'idle'

/**
 * How many sessions one recorder tracks.
 *
 * A hundred and twenty-eight is far more concurrent sessions than one developer has
 * open, and it exists so a long-lived opencode server cannot grow this map without
 * bound. It bounds memory; it is not a policy about which sessions matter.
 */
export const MAX_TRACKED_SESSIONS = 128

/**
 * One session's open turn: its identity, and the work recorded so far.
 *
 * A snapshot, not a live view: `reportTurn` returns the state as it was at the
 * moment the turn ended and then clears the measures, so a caller holding this value
 * cannot be surprised by a later event changing the answer underneath it.
 */
export interface TurnState {
  readonly sessionId: string
  /**
   * The identity the dedupe key is derived from for this turn's idle transition.
   * Minted, stable for the whole turn, and unchanged by `reportTurn`.
   */
  readonly transitionId: string
  /** Which turn of this session this is, counting from one. */
  readonly turn: number
  /** The three measures, as the classifier reads them. */
  readonly work: TurnWorkSignal
}

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

/**
 * Per-turn work signals and per-session identities.
 *
 * Four operations and nothing else: begin a turn, note work, read the turn, report
 * it. There is no method that classifies anything, decides a class, opens a socket
 * or hands an envelope anywhere, because this object is loaded inside a developer's
 * agent process and every one of those would be a way for this product to be
 * responsible for the session (APX-CON-03).
 */
export interface WorkSignalRecorder {
  /**
   * Start a turn for a session: empty work and a newly minted transition identity.
   *
   * A session with no open turn is the normal case. A session already mid-turn gets
   * a second turn, which is what a second busy status means.
   */
  beginTurn(sessionId: string): TurnState
  /**
   * Record one measure against the session's open turn, starting the turn if this is
   * the first thing seen for it.
   *
   * A measure is a flag, so recording the same one twice changes nothing. A session
   * whose first event this recorder ever sees is a tool call is a session that has
   * been working since before the adapter existed, and starting its turn here is how
   * that first turn's work is not lost.
   */
  noteWork(sessionId: string, measure: WorkMeasure): void
  /**
   * The open turn, started if the session has none.
   *
   * Reading never clears: the caller is looking, not reporting.
   */
  turn(sessionId: string): TurnState
  /**
   * The turn as it ends: the work to report, and the measures cleared for whatever
   * comes next.
   *
   * The identity is deliberately kept, so the deprecated idle event and the status
   * transition of the same turn agree on one key (EL-FR-06).
   */
  reportTurn(sessionId: string): TurnState
  /**
   * Mint an identity for a signal that carries none of its own - an error, a
   * compaction, a todo update - in the same `part:n` shape a transition uses.
   *
   * Per session, so two sessions mint independently, and monotonic, so the same
   * signal delivered twice inside one plugin process is one identity.
   */
  mintIdentity(sessionId: string, part: string): string
  /**
   * The identity the session's current transition would be keyed by, without
   * touching the turn.
   *
   * This is the seam the polling fallback uses: a poller that reports a session as
   * idle asks here rather than minting a key of its own, so a session that both
   * pushes and is polled produces one event rather than two (OA-FR-07).
   */
  currentTransitionId(sessionId: string): string
  /** Stop tracking a session. Safe for one that is not tracked. */
  forget(sessionId: string): void
  /** How many sessions are tracked, for the bound a test asserts. */
  readonly trackedSessions: number
}

/** The state one session carries, including the mint counters. */
interface SessionTurn {
  readonly sessionId: string
  transitionId: string
  turn: number
  toolCall: boolean
  fileEdit: boolean
  todoUpdate: boolean
  /** One counter per namespace, minted on demand. */
  readonly minted: Map<string, number>
}

export interface WorkSignalRecorderOptions {
  /** The cap. A test lowers it; production takes the default. */
  readonly maxSessions?: number
}

/**
 * Build a recorder.
 *
 * A closure over one map rather than a class, so there is no `this` to lose when the
 * recorder is handed to a harness callback.
 */
export function createWorkSignalRecorder(
  options: WorkSignalRecorderOptions = {},
): WorkSignalRecorder {
  const maxSessions = Math.max(1, options.maxSessions ?? MAX_TRACKED_SESSIONS)
  const sessions = new Map<string, SessionTurn>()

  /**
   * Read a session's turn, refreshing its position in the eviction order.
   *
   * Re-inserting is what makes the cap least-recently-used rather than
   * first-seen-first-out: the session a developer is working in right now is the one
   * that must not be the one forgotten.
   */
  const take = (sessionId: string): SessionTurn | undefined => {
    const existing = sessions.get(sessionId)
    if (existing === undefined) return undefined
    sessions.delete(sessionId)
    sessions.set(sessionId, existing)
    return existing
  }

  /** Forget the least recently touched sessions until the cap is met. */
  const evictDownTo = (cap: number): void => {
    while (sessions.size > cap) {
      const oldest = sessions.keys().next()
      if (oldest.done === true) return
      sessions.delete(oldest.value)
    }
  }

  /**
   * The session's turn, created on first sight.
   *
   * Creating one is the same thing as beginning a turn - empty work, a freshly
   * minted identity - because a session this recorder has never seen is mid-turn as
   * far as anyone can tell, and the restrained reading of an unknown turn is an
   * empty one (ADR-004).
   */
  const sessionTurn = (sessionId: string): SessionTurn => {
    const existing = take(sessionId)
    if (existing !== undefined) return existing
    const created: SessionTurn = {
      sessionId,
      transitionId: `${TURN_IDENTITY_PART}:1`,
      turn: 1,
      toolCall: false,
      fileEdit: false,
      todoUpdate: false,
      minted: new Map<string, number>([[TURN_IDENTITY_PART, 1]]),
    }
    sessions.set(sessionId, created)
    evictDownTo(maxSessions)
    return created
  }

  const snapshot = (state: SessionTurn): TurnState => ({
    sessionId: state.sessionId,
    transitionId: state.transitionId,
    turn: state.turn,
    work: {
      toolCall: state.toolCall,
      fileEdit: state.fileEdit,
      todoUpdate: state.todoUpdate,
    },
  })

  return {
    beginTurn(sessionId: string): TurnState {
      // A session the recorder has never seen is *in* its first turn, so the first
      // boundary is that turn and not the one after it. Incrementing unconditionally
      // would make every session's first turn the second one, and hand out an
      // identity (`idle:1`) that no turn ever reported.
      const first = sessions.has(sessionId) === false
      const state = sessionTurn(sessionId)
      if (!first) {
        state.turn += 1
        state.transitionId = `${TURN_IDENTITY_PART}:${state.turn}`
      }
      state.toolCall = false
      state.fileEdit = false
      state.todoUpdate = false
      return snapshot(state)
    },

    noteWork(sessionId: string, measure: WorkMeasure): void {
      const state = sessionTurn(sessionId)
      if (measure === 'tool-call') state.toolCall = true
      else if (measure === 'file-edit') state.fileEdit = true
      else state.todoUpdate = true
    },

    turn(sessionId: string): TurnState {
      return snapshot(sessionTurn(sessionId))
    },

    reportTurn(sessionId: string): TurnState {
      const state = sessionTurn(sessionId)
      const reported = snapshot(state)
      // The measures only. The identity stays, so the deprecated idle event and the
      // status transition of one turn agree on a single dedupe key (EL-FR-06).
      state.toolCall = false
      state.fileEdit = false
      state.todoUpdate = false
      return reported
    },

    mintIdentity(sessionId: string, part: string): string {
      // The turn counter owns the `idle` namespace. A caller minting into it would
      // renumber the turns of a live session, so it is refused rather than allowed
      // to corrupt the turn identity quietly.
      if (part === TURN_IDENTITY_PART) {
        throw new Error(
          'the turn identity namespace is reserved: mint a signal identity under its own part name',
        )
      }
      const state = sessionTurn(sessionId)
      const next = (state.minted.get(part) ?? 0) + 1
      state.minted.set(part, next)
      return `${part}:${next}`
    },

    currentTransitionId(sessionId: string): string {
      return sessionTurn(sessionId).transitionId
    },

    forget(sessionId: string): void {
      sessions.delete(sessionId)
    },

    get trackedSessions(): number {
      return sessions.size
    },
  }
}
