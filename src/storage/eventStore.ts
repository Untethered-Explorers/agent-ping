// The typed store API over the durable log: five accessors and a close.
//
// EL-FR-01 supplies the accessors, and the list is the point. There is no raw
// query escape hatch, no "run this SQL" method and no handle accessor, because
// a general query surface is how a content column would first be read out of
// this module. A caller that needs a new read gets a typed accessor through a
// contract change (hub-engineer in HC-3 and HC-5, dashboard-engineer in LD-1 and
// LD-3, notification-engineer in NT-3), not a hole in the API.
//
// What crosses this boundary is metadata and nothing else (APX-FR-01,
// ADR-003): harness, repository short name and full path, session identifier,
// event class and optional subtype, raw event type, dedupe key, occurrence and
// receipt timestamps, and acknowledgement or resolution state. Every read shape
// below is a plain object literal with a fixed key set, asserted exactly in
// tests/storage/eventStore.test.ts, so a new field cannot appear in a response
// without that test failing first.
//
// The class, subtype and state unions are declared here because the database
// enforces them and the store's read shapes are typed by them. They are the
// three loudness classes of ADR-004 and the session lifecycle of PRD 10.
// src/domain/classify.ts (EL-3) maps harness events onto exactly these literals
// and must not widen them; a fourth class would be a contract change, not a
// classifier decision.
//
// Nothing here opens a socket, spawns a process or renders a surface, and no
// value written by this module is ever sent anywhere (APX-CON-12).

import { randomUUID } from 'node:crypto'
import { openDatabase, type OpenDatabase, type OpenDatabaseOptions, type SqliteDatabase } from './db.js'

/** The three loudness classes (ADR-004, PRD 15). */
export type EventClass = 'needs-you' | 'finished' | 'fyi'

/** The five fyi subtypes (EL-FR-04). Only an fyi event may carry one. */
export type FyiSubtype = 'error' | 'retry' | 'long-tool-call' | 'compaction' | 'token-burn'

/** The observed session lifecycle (PRD 10). */
export type SessionState =
  | 'unknown'
  | 'running'
  | 'blocked'
  | 'finished'
  | 'idle-after-nothing'
  | 'gone'

/** Whether the developer has acknowledged a pending item. */
export type AckState = 'unacknowledged' | 'acknowledged'

/** Whether the harness has reported the block resolved. */
export type ResolutionState = 'unresolved' | 'resolved'

/**
 * One event to store, in exactly the field set of the normalized envelope
 * (EL-FR-01). There is deliberately no event identifier: the store generates
 * one, because identity and class are what a harness reports and a row key is
 * not a harness concept.
 *
 * A normalized envelope from src/domain/envelope.ts is assignable to this type
 * as it stands, so the ingest route passes one through unchanged.
 */
export interface NewEvent {
  readonly harness: string
  readonly sessionId: string
  readonly repoShortName: string
  readonly repoFullPath: string
  readonly rawEventType: string
  readonly class: EventClass
  readonly subtype?: FyiSubtype | null
  readonly occurredAt: string
  readonly receivedAt: string
  readonly dedupeKey: string
}

/** A stored event: the events table, in the same order, with its row key. */
export interface EventRecord {
  readonly eventId: string
  readonly sessionId: string
  readonly class: EventClass
  readonly subtype: FyiSubtype | null
  readonly rawEventType: string
  readonly occurredAt: string
  readonly receivedAt: string
  readonly dedupeKey: string
  readonly ackState: AckState
  readonly resolutionState: ResolutionState
}

/**
 * A pending item: the event plus the repository identity a row needs to be
 * rendered (LD-FR-08). No field here can hold conversation content.
 */
export interface PendingItem extends EventRecord {
  readonly harness: string
  readonly repoShortName: string
  readonly repoFullPath: string
}

/** One session as the dashboard and the read routes see it. */
export interface SessionSummary {
  readonly sessionId: string
  readonly harness: string
  readonly repoShortName: string
  readonly repoFullPath: string
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  readonly state: SessionState
  readonly workSignal: 0 | 1
  /** Derived, not stored: items in this session that are still pending. */
  readonly pendingCount: number
}

/**
 * One session with the events a client asked to see beside it (HC-FR-02:
 * `GET /api/sessions/:id`).
 *
 * The summary fields are exactly the ones the list route returns, and
 * `recentEvents` carries the same EventRecord shape as the bounded history, so
 * the two routes cannot disagree about what an event looks like. Newest first:
 * the question a detail panel asks is "what just happened", and the history view
 * reads top-down.
 */
export interface SessionDetail extends SessionSummary {
  readonly recentEvents: readonly EventRecord[]
}

/**
 * The bounds on a paged read, in one place, because "bounded" is the property
 * and not the number.
 *
 * `HISTORY_MAX_LIMIT` is the most a caller may ever receive. PRD 16 Open
 * Questions 8 keeps at least the most recent 500 events per session, and this
 * is that number expressed as a ceiling rather than a floor: a bound the caller
 * can raise is not a bound. The default is what a client gets when it asks for
 * nothing, chosen to cover a full dashboard history panel in one response.
 */
export const HISTORY_DEFAULT_LIMIT = 100
export const HISTORY_MAX_LIMIT = 500

/**
 * A bounded history query. Both fields are optional and neither can widen the
 * bound: a limit above the maximum is clamped, not honoured, and an absent
 * session identifier means every session.
 */
export interface EventHistoryQuery {
  readonly limit?: number
  readonly sessionId?: string
}

export type InsertOutcome = 'inserted' | 'duplicate'

export interface InsertResult {
  /**
   * `duplicate` when an event with this dedupe key is already stored. The
   * dedupe key is derived from identity alone, so this is how a repeated
   * permission ask, and a polled copy of a pushed event, resolve to one row
   * (EL-FR-07).
   */
  readonly outcome: InsertOutcome
  readonly event: EventRecord
}

export type MutationOutcome =
  /** The row changed. */
  | 'applied'
  /** The row was already in this state. An explicit no-op, never a second count. */
  | 'unchanged'
  /**
   * The row is in a state this transition cannot apply to: already resolved, or
   * not a needs-you row at all, because only a pending item may be resolved or
   * acknowledged (APX-CON-08). Nothing is written.
   */
  | 'conflict'
  /** No such event identifier. */
  | 'not-found'

export interface MutationResult {
  readonly outcome: MutationOutcome
  /** The row as it stands after the attempt, or null when there is no such row. */
  readonly event: EventRecord | null
}

export interface EventStore {
  /** The database file this store opened, for the doctor command (IO-2). */
  readonly filePath: string
  readonly schemaVersion: number
  /** True when the previous file was unreadable and the log was recreated. */
  readonly rebuiltFromMigrations: boolean
  insertEvent(event: NewEvent): InsertResult
  /** The unresolved, unacknowledged needs-you items: the tray badge's source of truth. */
  readPending(): PendingItem[]
  markResolved(eventId: string): MutationResult
  markAcknowledged(eventId: string): MutationResult
  readSessionSummaries(): SessionSummary[]
  /**
   * One session with its most recent events, or null when there is no such
   * session. Bounded by RECENT_EVENTS_MAX; the accessor cannot return the whole
   * history of a session no matter what a caller passes (HC-FR-02).
   */
  readSession(sessionId: string): SessionDetail | null
  /**
   * Bounded event history, newest first, optionally narrowed to one session
   * (HC-FR-02). A limit is clamped into [1, HISTORY_MAX_LIMIT], so "unbounded" is
   * not a value this method can be given.
   */
  readEventHistory(query?: EventHistoryQuery): readonly EventRecord[]
  close(): void
}

/**
 * The ceiling on one session's recent events. Lower than the history ceiling
 * because a detail panel renders a handful of rows beside a summary, and a
 * session with tens of thousands of events must not turn one request into a
 * full-table read.
 */
export const RECENT_EVENTS_MAX = 200

/**
 * The session state and turn work signal implied by an event's class, as data
 * rather than as a chain of conditionals. Its keys are exactly the three
 * loudness classes, so it doubles as the store's class check.
 *
 * A needs-you event leaves the turn suspended on the developer, so its work
 * signal is 0; a finished event exists only because the turn recorded work
 * (EL-FR-05), and every fyi subtype describes something the agent did. The state
 * stays observed, not owned: a resolution or an acknowledgement does not guess
 * what the session is doing next, so it leaves the recorded state alone and the
 * next classified event sets it.
 */
const SESSION_STATE_FROM_CLASS: Readonly<Record<string, SessionDerivation | undefined>> = {
  'needs-you': { state: 'blocked', workSignal: 0 },
  finished: { state: 'finished', workSignal: 1 },
  fyi: { state: 'running', workSignal: 1 },
}

interface SessionDerivation {
  readonly state: SessionState
  readonly workSignal: 0 | 1
}

/**
 * The class is checked here rather than left to the database because the class
 * is read before it is written: the session row is derived from it. A subtype
 * needs no such check, since it is only a column value and the schema's CHECK
 * constraint is the enforcement point for it.
 */
function deriveSessionState(className: string): SessionDerivation {
  const derived = SESSION_STATE_FROM_CLASS[className]
  if (derived === undefined) {
    throw new Error(
      `unknown event class "${className}": the store derives a session row from the class, and ` +
        `only ${Object.keys(SESSION_STATE_FROM_CLASS).join(', ')} are classes (ADR-004). ` +
        'A fourth class is a contract change, not a caller decision.',
    )
  }
  return derived
}

const EVENT_COLUMNS =
  'event_id, session_id, class, subtype, raw_event_type, occurred_at, received_at, dedupe_key, ack_state, resolution_state'

interface EventRow {
  readonly event_id: string
  readonly session_id: string
  readonly class: string
  readonly subtype: string | null
  readonly raw_event_type: string
  readonly occurred_at: string
  readonly received_at: string
  readonly dedupe_key: string
  readonly ack_state: string
  readonly resolution_state: string
}

interface PendingRow extends EventRow {
  readonly harness: string
  readonly repo_short_name: string
  readonly repo_full_path: string
}

interface SessionRow {
  readonly session_id: string
  readonly harness: string
  readonly repo_short_name: string
  readonly repo_full_path: string
  readonly first_seen_at: string
  readonly last_seen_at: string
  readonly state: string
  readonly work_signal: number
  readonly pending_count: number
}

/**
 * The unacknowledged, unresolved needs-you condition, in one place and
 * alias-qualified, so the meaning of "pending" cannot drift between the pending
 * read and the count a session summary carries.
 */
const pendingCondition = (alias: string): string =>
  `${alias}.class = 'needs-you' AND ${alias}.ack_state = 'unacknowledged' AND ${alias}.resolution_state = 'unresolved'`

/**
 * Open the durable log and apply the migrations.
 *
 * The options are the ones in OpenDatabaseOptions: a `filePath` to redirect the
 * store at a temporary directory, and a `now` to make migration records
 * deterministic. Neither is a general purpose dependency injection point.
 */
export function openEventStore(options: OpenDatabaseOptions = {}): EventStore {
  const opened: OpenDatabase = openDatabase(options)
  const db: SqliteDatabase = opened.db

  const findByDedupeKey = db.prepare<[string], EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE dedupe_key = ?`,
  )
  const findById = db.prepare<[string], EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE event_id = ?`,
  )
  const insertRow = db.prepare<
    [string, string, string, string | null, string, string, string, string]
  >(
    `INSERT INTO events (event_id, session_id, class, subtype, raw_event_type, occurred_at, received_at, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  // The session row is derived from the event that is being stored, so an event
  // and the summary it implies are written together or not at all. `MIN` and
  // `MAX` keep the first and last sighting stable when events arrive out of
  // order, which the polling fallback makes routine, and the CASE clauses mean
  // the recorded state follows the newest event rather than the newest arrival.
  const upsertSession = db.prepare<
    [string, string, string, string, string, string, string, number]
  >(
    `INSERT INTO sessions (session_id, harness, repo_short_name, repo_full_path, first_seen_at, last_seen_at, state, work_signal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET
       harness = excluded.harness,
       repo_short_name = excluded.repo_short_name,
       repo_full_path = excluded.repo_full_path,
       first_seen_at = MIN(sessions.first_seen_at, excluded.first_seen_at),
       last_seen_at = MAX(sessions.last_seen_at, excluded.last_seen_at),
       state = CASE WHEN excluded.last_seen_at >= sessions.last_seen_at THEN excluded.state ELSE sessions.state END,
       work_signal = CASE WHEN excluded.last_seen_at >= sessions.last_seen_at THEN excluded.work_signal ELSE sessions.work_signal END`,
  )
  const readPendingRows = db.prepare<[], PendingRow>(
    `SELECT e.event_id, e.session_id, e.class, e.subtype, e.raw_event_type, e.occurred_at,
            e.received_at, e.dedupe_key, e.ack_state, e.resolution_state,
            s.harness, s.repo_short_name, s.repo_full_path
     FROM events e
     JOIN sessions s ON s.session_id = e.session_id
     WHERE ${pendingCondition('e')}
     ORDER BY e.occurred_at ASC, e.event_id ASC`,
  )
  const readSessionRows = db.prepare<[], SessionRow>(
    `SELECT s.session_id, s.harness, s.repo_short_name, s.repo_full_path, s.first_seen_at,
            s.last_seen_at, s.state, s.work_signal,
            (SELECT COUNT(*) FROM events e
              WHERE e.session_id = s.session_id AND ${pendingCondition('e')}) AS pending_count
     FROM sessions s
     ORDER BY s.repo_short_name ASC, s.last_seen_at DESC, s.session_id ASC`,
  )
  // The single-session read is the same projection with a key, prepared separately
  // rather than built by string concatenation: a session identifier is a value
  // from a URL, and the only way it can reach a statement is as a bound parameter.
  const readOneSessionRow = db.prepare<[string], SessionRow>(
    `SELECT s.session_id, s.harness, s.repo_short_name, s.repo_full_path, s.first_seen_at,
            s.last_seen_at, s.state, s.work_signal,
            (SELECT COUNT(*) FROM events e
              WHERE e.session_id = s.session_id AND ${pendingCondition('e')}) AS pending_count
     FROM sessions s
     WHERE s.session_id = ?`,
  )
  // Newest first, with the row key as the tiebreak so events that share an
  // occurrence timestamp - which the out-of-order polling fallback makes routine -
  // still have one total order and a page boundary that never repeats or skips a
  // row. The limit is bound, never interpolated, which is what keeps "bounded" a
  // property of the statement rather than a promise about the caller.
  const readRecentEventRows = db.prepare<[string, number], EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events
     WHERE session_id = ?
     ORDER BY occurred_at DESC, event_id DESC
     LIMIT ?`,
  )
  const readHistoryRows = db.prepare<[number], EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events
     ORDER BY occurred_at DESC, event_id DESC
     LIMIT ?`,
  )
  const readHistoryRowsForSession = db.prepare<[string, number], EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events
     WHERE session_id = ?
     ORDER BY occurred_at DESC, event_id DESC
     LIMIT ?`,
  )
  // A resolution is recorded independently of an acknowledgement, so it is
  // written whenever the block is unresolved, whoever cleared it.
  //
  // `class = 'needs-you'` is the pending guard, and it is in the statement rather
  // than in the caller because this is the only place that can refuse the write:
  // a resolution is a fact about a *block*, and a finished or fyi row has no block
  // to resolve. APX-CON-08 allows exactly one mutating route and lets it mark a
  // pending item acknowledged, so a non-block row must not be settable at all -
  // otherwise a caller holding any event identifier could flip it, and
  // src/domain/pending.ts (EL-4) could not report the attempt as a conflict that
  // changed nothing.
  const applyResolved = db.prepare<[string]>(
    `UPDATE events SET resolution_state = 'resolved'
      WHERE event_id = ? AND class = 'needs-you' AND resolution_state = 'unresolved'`,
  )
  // An acknowledgement is refused for an already resolved block: the developer
  // is acknowledging a decision the harness already took (HC-FR-05, EL-FR-08).
  // The same class guard applies, for the same reason: only a pending item can be
  // marked acknowledged, and "pending item" is precisely a needs-you row.
  const applyAcknowledged = db.prepare<[string]>(
    `UPDATE events SET ack_state = 'acknowledged'
      WHERE event_id = ? AND class = 'needs-you' AND ack_state = 'unacknowledged' AND resolution_state = 'unresolved'`,
  )

  const insertEvent = db.transaction((event: NewEvent): InsertResult => {
    const existing = findByDedupeKey.get(event.dedupeKey)
    if (existing !== undefined) {
      return { outcome: 'duplicate', event: toEventRecord(existing) }
    }

    const { state, workSignal } = deriveSessionState(event.class)
    // Insert the session first: the events table references it.
    upsertSession.run(
      event.sessionId,
      event.harness,
      event.repoShortName,
      event.repoFullPath,
      event.occurredAt,
      event.occurredAt,
      state,
      workSignal,
    )
    const eventId = randomUUID()
    insertRow.run(
      eventId,
      event.sessionId,
      event.class,
      event.subtype ?? null,
      event.rawEventType,
      event.occurredAt,
      event.receivedAt,
      event.dedupeKey,
    )
    return {
      outcome: 'inserted',
      event: {
        eventId,
        sessionId: event.sessionId,
        class: event.class,
        subtype: event.subtype ?? null,
        rawEventType: event.rawEventType,
        occurredAt: event.occurredAt,
        receivedAt: event.receivedAt,
        dedupeKey: event.dedupeKey,
        ackState: 'unacknowledged',
        resolutionState: 'unresolved',
      },
    }
  })

  const markResolvedTransaction = db.transaction((eventId: string): MutationResult => {
    const changes = applyResolved.run(eventId).changes
    const row = findById.get(eventId)
    if (row === undefined) return { outcome: 'not-found', event: null }
    const record = toEventRecord(row)
    // A row that is not a block cannot be resolved, and `unchanged` would be a lie
    // about it: the fact was never recorded, so this is the same conflict the
    // acknowledgement reports for the same reason (APX-CON-08).
    if (record.class !== 'needs-you') return { outcome: 'conflict', event: record }
    return { outcome: changes > 0 ? 'applied' : 'unchanged', event: record }
  })

  const markAcknowledgedTransaction = db.transaction((eventId: string): MutationResult => {
    const changes = applyAcknowledged.run(eventId).changes
    const row = findById.get(eventId)
    if (row === undefined) return { outcome: 'not-found', event: null }
    const record = toEventRecord(row)
    // Already acknowledged is the idempotent no-op, even when the harness has
    // resolved the block since: the acknowledgement already happened once, and
    // counting it twice is the double count EL-FR-08 forbids. Checked before the
    // conflict cases, and deliberately.
    if (record.ackState === 'acknowledged') {
      return { outcome: changes > 0 ? 'applied' : 'unchanged', event: record }
    }
    if (record.resolutionState === 'resolved') {
      return { outcome: 'conflict', event: record }
    }
    // Only a pending item may be marked acknowledged (APX-CON-08), and this is the
    // distinguishable answer for a caller that addressed a finished or fyi row: a
    // conflict the ack route can report, with nothing written.
    if (record.class !== 'needs-you') {
      return { outcome: 'conflict', event: record }
    }
    return { outcome: 'unchanged', event: record }
  })

  return {
    filePath: opened.filePath,
    schemaVersion: opened.schemaVersion,
    rebuiltFromMigrations: opened.rebuiltFromMigrations,
    insertEvent: (event: NewEvent): InsertResult => insertEvent(event),
    readPending: (): PendingItem[] => readPendingRows.all().map(toPendingItem),
    readSession: (sessionId: string): SessionDetail | null => {
      const row = readOneSessionRow.get(sessionId)
      if (row === undefined) return null
      return {
        ...toSessionSummary(row),
        recentEvents: readRecentEventRows
          .all(sessionId, RECENT_EVENTS_MAX)
          .map(toEventRecord),
      }
    },
    readEventHistory: (query: EventHistoryQuery = {}): readonly EventRecord[] => {
      const limit = clampHistoryLimit(query.limit)
      const rows =
        query.sessionId === undefined
          ? readHistoryRows.all(limit)
          : readHistoryRowsForSession.all(query.sessionId, limit)
      return rows.map(toEventRecord)
    },
    markResolved: (eventId: string): MutationResult => markResolvedTransaction(eventId),
    markAcknowledged: (eventId: string): MutationResult => markAcknowledgedTransaction(eventId),
    readSessionSummaries: (): SessionSummary[] => readSessionRows.all().map(toSessionSummary),
    close: (): void => {
      opened.close()
    },
  }
}

/**
 * Fold a caller's requested page size into the bound.
 *
 * A value that is not a positive integer becomes the default, and a value above
 * the maximum becomes the maximum. Clamping rather than refusing is deliberate:
 * this is a read, a client asking for too much history deserves the largest page
 * this product serves rather than an error, and a client asking for a nonsense
 * size deserves the ordinary default. What a caller cannot do is widen the bound,
 * which is the property the read route's `limit` parameter also depends on.
 */
function clampHistoryLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return HISTORY_DEFAULT_LIMIT
  const whole = Math.floor(requested)
  if (whole < 1) return HISTORY_DEFAULT_LIMIT
  return Math.min(whole, HISTORY_MAX_LIMIT)
}

function toEventRecord(row: EventRow): EventRecord {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    class: row.class as EventClass,
    subtype: row.subtype as FyiSubtype | null,
    rawEventType: row.raw_event_type,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    dedupeKey: row.dedupe_key,
    ackState: row.ack_state as AckState,
    resolutionState: row.resolution_state as ResolutionState,
  }
}

function toPendingItem(row: PendingRow): PendingItem {
  return {
    ...toEventRecord(row),
    harness: row.harness,
    repoShortName: row.repo_short_name,
    repoFullPath: row.repo_full_path,
  }
}

function toSessionSummary(row: SessionRow): SessionSummary {
  return {
    sessionId: row.session_id,
    harness: row.harness,
    repoShortName: row.repo_short_name,
    repoFullPath: row.repo_full_path,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    state: row.state as SessionState,
    workSignal: row.work_signal === 1 ? 1 : 0,
    pendingCount: row.pending_count,
  }
}
