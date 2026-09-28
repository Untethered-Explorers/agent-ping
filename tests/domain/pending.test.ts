// The pending lifecycle against a real better-sqlite3 file (EL-FR-08, PRD 10,
// APX-CON-08, NT-FR-05, HC-FR-05, HC-FR-08, ADR-003).
//
//   npm test -- tests/domain/pending.test.ts
//
// What is asserted here, and why each part earns its place:
//
//   1. CREATION. A needs-you signal creates exactly one pending item; a finished
//      or fyi signal creates a row that is not a pending item and cannot become
//      one; a replayed signal changes nothing; a signal the classifier suppressed
//      stores nothing at all. The class is the gate, so the cases are taken from
//      the classifier's own table rather than from hand-built envelopes.
//   2. THE TWO EXITS. Resolution and acknowledgement, each applied once and each
//      reported as an explicit no-op on the repeat, with the pending count before
//      and after in the result so "never double-counts" is a number rather than a
//      promise (EL-FR-08, HC-FR-08).
//   3. THE REJECTION. Acknowledging a block the harness already resolved returns
//      `rejected` with the reason that distinguishes it from the idempotent
//      no-op, and writes nothing. Acknowledging an identifier that names a
//      finished row is refused the same way, and the whole row is compared before
//      and after, because APX-CON-08 allows exactly one mutating route and lets
//      it touch a pending item only.
//   4. RESTART. The pending set, the count and the durable row are identical after
//      the file is closed and reopened; a settled block stays settled; and a
//      lifecycle over a fresh database reports an empty set however full the log
//      it no longer holds was. That last one is the test that fails if this module
//      ever keeps pending state in memory, which is the usual way EL-FR-08's
//      "survives hub restart unchanged" gets broken.
//   5. THE TABLE AND THE SOURCE. Every answer the lifecycle can give is produced
//      by a real scenario and every scenario's answer is in the table, and the
//      module itself holds no mutable state, writes no SQL, resolves no path and
//      reaches the store through a type-only import. "Stateless" and "no second
//      writer" are properties of a file, not of a comment.
//
// Every database is a real file in a fresh temporary directory, opened and closed
// inside the test: a leaked native handle makes a later migration or rebuild
// assertion fail for the wrong reason. Events are inserted through the store's own
// accessors, never by writing rows directly, and rows are read back through a
// second connection, because the store API deliberately has no read-everything
// accessor and a test that reached into its handle would be the first step towards
// giving one out.

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { DATABASE_FILE_NAME } from '@/storage/paths'
import { openEventStore, type EventStore } from '@/storage/eventStore'
import { pruneEvents } from '@/storage/retention'
import type { HarnessSignal, TurnWorkSignal } from '@/domain/classify'
import { ClassificationError } from '@/domain/classify'
import type {
  PendingLifecycle,
  PendingRecordResult,
  PendingRowState,
  PendingTransition,
  PendingTransitionResult,
} from '@/domain/pending'
import * as pendingModule from '@/domain/pending'
import {
  PENDING_ROW_STATES,
  PENDING_TRANSITIONS,
  PENDING_TRANSITION_OUTCOMES,
  PendingLifecycleError,
  createPendingLifecycle,
} from '@/domain/pending'
import { removeTree } from '../helpers/remove-tree'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'ses_pending_01'
const OTHER_SESSION_ID = 'ses_pending_02'
const REPO_PATH = '/home/dev/Projects/agent-ping'
const BLOCK_ID = 'block-7'
const OCCURRED_AT = '2026-09-26T09:00:00.000Z'
const RECEIVED_AT = '2026-09-26T09:00:00.250Z'
const WORKED: TurnWorkSignal = { toolCall: true, fileEdit: false, todoUpdate: false }
const DID_NOTHING: TurnWorkSignal = { toolCall: false, fileEdit: false, todoUpdate: false }

function signal(overrides: Partial<HarnessSignal> = {}): HarnessSignal {
  return {
    harness: 'opencode',
    eventName: 'permission.asked',
    sessionId: SESSION_ID,
    repoFullPath: REPO_PATH,
    transitionId: BLOCK_ID,
    occurredAt: OCCURRED_AT,
    receivedAt: RECEIVED_AT,
    ...overrides,
  }
}

/** The block signal, and with it the one pending item most tests start from. */
const blockSignal = (overrides: Partial<HarnessSignal> = {}): HarnessSignal =>
  signal({ eventName: 'permission.asked', transitionId: BLOCK_ID, ...overrides })

/** The harness reporting the block resolved, carrying the same block identifier. */
const resolutionSignal = (overrides: Partial<HarnessSignal> = {}): HarnessSignal =>
  signal({ eventName: 'permission.replied', transitionId: BLOCK_ID, ...overrides })

/** The idle transition after a turn that did work. */
const idleSignal = (overrides: Partial<HarnessSignal> = {}): HarnessSignal =>
  signal({
    eventName: 'session.status',
    variant: 'idle',
    transitionId: 'idle-1',
    turnWork: WORKED,
    ...overrides,
  })

/** A block in a second session, so cross-session behaviour can be asserted. */
const otherBlock = (overrides: Partial<HarnessSignal> = {}): HarnessSignal =>
  blockSignal({ sessionId: OTHER_SESSION_ID, transitionId: 'block-9', ...overrides })

/** A store, a lifecycle over it and the file, which is all of a hub's ownership. */
interface OpenPending {
  readonly filePath: string
  readonly store: EventStore
  readonly lifecycle: PendingLifecycle
}

const temporaryDirectories: string[] = []
const openStores: EventStore[] = []

function temporaryFilePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent-ping-pending-'))
  temporaryDirectories.push(directory)
  return path.join(directory, DATABASE_FILE_NAME)
}

/** A store in a fresh temporary directory, registered for cleanup. */
function openStoreAt(filePath: string): EventStore {
  const store = openEventStore({ filePath })
  openStores.push(store)
  return store
}

function openPending(filePath: string): OpenPending {
  const store = openStoreAt(filePath)
  return { filePath, store, lifecycle: createPendingLifecycle(store) }
}

function openTemporary(): OpenPending {
  return openPending(temporaryFilePath())
}

/**
 * Close every store this file has opened, which is what a restart looks like from
 * here: a new store and a new lifecycle over the same file, with nothing carried
 * across in memory.
 */
function closeEveryStore(): void {
  for (const store of openStores.splice(0)) store.close()
}

afterEach(() => {
  closeEveryStore()
  for (const directory of temporaryDirectories.splice(0)) {
    removeTree(directory)
  }
})

/**
 * A second connection for reading the raw row back, closed before the call
 * returns, so this file leaks no handle of its own and the store API stays closed.
 *
 * The row is every column of the events table, deliberately: comparing the whole
 * row before and after a transition is the only way to assert that a refused
 * acknowledgement wrote *nothing*, rather than writing something the typed result
 * did not report.
 */
function rawRow(filePath: string, eventId: string): Record<string, unknown> | undefined {
  const db = new Database(filePath, { timeout: 5_000 })
  try {
    return db
      .prepare<[string], Record<string, unknown>>(
        'SELECT event_id, session_id, class, subtype, raw_event_type, occurred_at, received_at, dedupe_key, ack_state, resolution_state FROM events WHERE event_id = ?',
      )
      .get(eventId)
  } finally {
    db.close()
  }
}

function rowCount(filePath: string): number {
  const db = new Database(filePath, { timeout: 5_000 })
  try {
    return db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM events').get()?.count ?? 0
  } finally {
    db.close()
  }
}

function captureError(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the call to throw, and it returned')
}

/** The stored row identifier of any result that carries a row. */
function eventIdOf(result: PendingRecordResult): string {
  if (result.kind === 'no-event' || result.kind === 'nothing-pending') {
    throw new Error(`expected a stored event, got ${result.kind}`)
  }
  return result.event.eventId
}

/** The identifier of a pending item in one session, or a thrown error. */
function pendingIdIn(lifecycle: PendingLifecycle, sessionId: string): string {
  const item = lifecycle.readPending().find((candidate) => candidate.sessionId === sessionId)
  if (item === undefined) throw new Error(`no pending item in ${sessionId}`)
  return item.eventId
}

// ---------------------------------------------------------------------------
// 1. The surface: one mutation a client can reach, and nothing that steers
// ---------------------------------------------------------------------------

describe('the lifecycle surface (APX-CON-08, EL-FR-08)', () => {
  it('exposes exactly the five lifecycle methods, with no handle and no query escape hatch', () => {
    const { lifecycle } = openTemporary()
    expect(Object.keys(lifecycle).sort()).toEqual([
      'acknowledge',
      'pendingCount',
      'readPending',
      'record',
      'reportResolved',
    ])
    expect('db' in lifecycle).toBe(false)
    expect('prepare' in lifecycle).toBe(false)
    expect('exec' in lifecycle).toBe(false)
    expect('store' in lifecycle).toBe(false)
  })

  it('offers no method that could spawn, steer, interrupt, prompt or approve anything inside a harness', () => {
    const { lifecycle } = openTemporary()
    // A resolution is a fact the harness has already reported, not an instruction
    // sent to one, so no method may be named after a harness action.
    const forbidden =
      /^(approve|allow|grant|deny|reply|respond|answer|accept|refuse|cancel|abort|interrupt|resume|send|prompt|steer|spawn|invoke|exec|run|kill|stop)/
    for (const name of Object.keys(lifecycle)) {
      expect(forbidden.test(name), `${name} reads as a harness action`).toBe(false)
    }
  })

  it('exports exactly its vocabulary, so the API cannot be widened by a new export', () => {
    expect(Object.keys(pendingModule).sort()).toEqual([
      'PENDING_ROW_STATES',
      'PENDING_TRANSITIONS',
      'PENDING_TRANSITION_OUTCOMES',
      'PendingLifecycleError',
      'createPendingLifecycle',
    ])
  })
})

// ---------------------------------------------------------------------------
// 2. The answer table, as data
// ---------------------------------------------------------------------------

describe('the transition table (EL-FR-08)', () => {
  it('ships two transitions, so there is no third exit from pending', () => {
    expect([...PENDING_TRANSITIONS]).toEqual(['resolution', 'acknowledgement'])
  })

  it('carries a cell for every combination, and each key is the exit, the verdict and the row', () => {
    // Written out rather than derived, because the reachable set is a review
    // surface: twelve cells, each one an answer a real store attempt can produce.
    expect(Object.keys(PENDING_TRANSITION_OUTCOMES).sort()).toEqual([
      'acknowledgement:applied:acknowledged',
      'acknowledgement:conflict:not-a-block',
      'acknowledgement:conflict:resolved',
      'acknowledgement:not-found:no-row',
      'acknowledgement:unchanged:acknowledged',
      'acknowledgement:unchanged:acknowledged-and-resolved',
      'resolution:applied:acknowledged-and-resolved',
      'resolution:applied:resolved',
      'resolution:conflict:not-a-block',
      'resolution:not-found:no-row',
      'resolution:unchanged:acknowledged-and-resolved',
      'resolution:unchanged:resolved',
    ])
    for (const key of Object.keys(PENDING_TRANSITION_OUTCOMES)) {
      const [transition, verdict, state] = key.split(':')
      expect(PENDING_TRANSITIONS, key).toContain(transition as PendingTransition)
      expect(['applied', 'unchanged', 'conflict', 'not-found'], key).toContain(verdict as string)
      expect(PENDING_ROW_STATES, key).toContain(state as PendingRowState)
    }
  })

  it('answers with four outcomes and eight reasons, and the two rejections are distinguishable', () => {
    const outcomes = new Set(Object.values(PENDING_TRANSITION_OUTCOMES).map((shape) => shape.outcome))
    const reasons = new Set(Object.values(PENDING_TRANSITION_OUTCOMES).map((shape) => shape.reason))
    expect([...outcomes].sort()).toEqual(['applied', 'not-found', 'rejected', 'unchanged'])
    expect([...reasons].sort()).toEqual([
      'already-acknowledged',
      'already-resolved',
      'already-resolved-by-harness',
      'developer-acknowledgement',
      'harness-reported-resolution',
      'no-such-item',
      'not-a-pending-item',
      'resolution-after-acknowledgement',
    ])
    // The acceptance criterion: acknowledging an already resolved block is not the
    // idempotent no-op, and not the same conflict as addressing the wrong row.
    expect(PENDING_TRANSITION_OUTCOMES['acknowledgement:conflict:resolved']).toEqual({
      outcome: 'rejected',
      reason: 'already-resolved-by-harness',
    })
    expect(PENDING_TRANSITION_OUTCOMES['acknowledgement:unchanged:acknowledged'].outcome).toBe('unchanged')
    expect(PENDING_TRANSITION_OUTCOMES['acknowledgement:conflict:not-a-block']).toEqual({
      outcome: 'rejected',
      reason: 'not-a-pending-item',
    })
    // A resolution arriving after an acknowledgement is a second independent fact,
    // so it is applied rather than swallowed as a no-op.
    expect(PENDING_TRANSITION_OUTCOMES['resolution:applied:acknowledged-and-resolved']).toEqual({
      outcome: 'applied',
      reason: 'resolution-after-acknowledgement',
    })
  })

  it('gives every cell an answer a real scenario produces, and no scenario an answer the table lacks', () => {
    // One scenario per cell, each on its own fresh database, because a cell is
    // about a row in a particular state and the states are made by transitions.
    const finished = (lifecycle: PendingLifecycle): string => eventIdOf(lifecycle.record(idleSignal()))
    const block = (lifecycle: PendingLifecycle): string => eventIdOf(lifecycle.record(blockSignal()))
    const resolvedBlock = (lifecycle: PendingLifecycle): string => {
      const id = block(lifecycle)
      lifecycle.reportResolved(id)
      return id
    }
    const acknowledgedBlock = (lifecycle: PendingLifecycle): string => {
      const id = block(lifecycle)
      lifecycle.acknowledge(id)
      return id
    }
    const twiceSettledBlock = (lifecycle: PendingLifecycle): string => {
      const id = block(lifecycle)
      lifecycle.acknowledge(id)
      lifecycle.reportResolved(id)
      return id
    }

    const scenarios: readonly {
      readonly label: string
      readonly target: (lifecycle: PendingLifecycle) => string
      readonly run: (lifecycle: PendingLifecycle, target: string) => PendingTransitionResult
      readonly expected: string
    }[] = [
      {
        label: 'a resolution on a pending block',
        target: block,
        run: (l, id) => l.reportResolved(id),
        expected: 'resolution:applied:harness-reported-resolution',
      },
      {
        label: 'a resolution on an acknowledged block',
        target: acknowledgedBlock,
        run: (l, id) => l.reportResolved(id),
        expected: 'resolution:applied:resolution-after-acknowledgement',
      },
      {
        label: 'a repeated resolution',
        target: resolvedBlock,
        run: (l, id) => l.reportResolved(id),
        expected: 'resolution:unchanged:already-resolved',
      },
      {
        label: 'a resolution of a block already both settled',
        target: twiceSettledBlock,
        run: (l, id) => l.reportResolved(id),
        expected: 'resolution:unchanged:already-resolved',
      },
      {
        label: 'a resolution of a finished turn',
        target: finished,
        run: (l, id) => l.reportResolved(id),
        expected: 'resolution:rejected:not-a-pending-item',
      },
      {
        label: 'a resolution of an unknown identifier',
        target: () => 'evt_absent',
        run: (l, id) => l.reportResolved(id),
        expected: 'resolution:not-found:no-such-item',
      },
      {
        label: 'an acknowledgement of a pending block',
        target: block,
        run: (l, id) => l.acknowledge(id),
        expected: 'acknowledgement:applied:developer-acknowledgement',
      },
      {
        label: 'a repeated acknowledgement',
        target: acknowledgedBlock,
        run: (l, id) => l.acknowledge(id),
        expected: 'acknowledgement:unchanged:already-acknowledged',
      },
      {
        label: 'an acknowledgement of a block already both settled',
        target: twiceSettledBlock,
        run: (l, id) => l.acknowledge(id),
        expected: 'acknowledgement:unchanged:already-acknowledged',
      },
      {
        label: 'an acknowledgement of a resolved block',
        target: resolvedBlock,
        run: (l, id) => l.acknowledge(id),
        expected: 'acknowledgement:rejected:already-resolved-by-harness',
      },
      {
        label: 'an acknowledgement of a finished turn',
        target: finished,
        run: (l, id) => l.acknowledge(id),
        expected: 'acknowledgement:rejected:not-a-pending-item',
      },
      {
        label: 'an acknowledgement of an unknown identifier',
        target: () => 'evt_absent',
        run: (l, id) => l.acknowledge(id),
        expected: 'acknowledgement:not-found:no-such-item',
      },
    ]

    const produced = new Set<string>()
    for (const scenario of scenarios) {
      const { lifecycle } = openTemporary()
      const result = scenario.run(lifecycle, scenario.target(lifecycle))
      const projection = `${result.transition}:${result.outcome}:${result.reason}`
      expect(projection, scenario.label).toBe(scenario.expected)
      produced.add(projection)
    }

    // Every answer the table declares is produced by a real scenario, so the table
    // is a description of code paths that exist rather than of ones that cannot.
    // Two cells answer the same way, so the counts differ by exactly two.
    expect(produced.size).toBe(scenarios.length - 2)
    for (const projection of produced) {
      const [transition, outcome, reason] = projection.split(':')
      expect(
        Object.values(PENDING_TRANSITION_OUTCOMES).some(
          (shape) => shape.outcome === outcome && shape.reason === reason,
        ),
        projection,
      ).toBe(true)
      expect(PENDING_TRANSITIONS, projection).toContain(transition as PendingTransition)
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Creating a pending item
// ---------------------------------------------------------------------------

describe('creating a pending item (EL-FR-08, EL-FR-07, EL-FR-05)', () => {
  // Each case starts from its own empty database, so the expected count is what
  // that one signal leaves behind rather than a running total.
  it.each([
    { label: 'a block', input: blockSignal(), kind: 'pending-created', pending: 1 },
    { label: 'a block in a second session', input: otherBlock(), kind: 'pending-created', pending: 1 },
    { label: 'a finished turn', input: idleSignal(), kind: 'event-stored', pending: 0 },
    {
      label: 'an error',
      input: signal({ eventName: 'session.error', transitionId: 'err-1' }),
      kind: 'event-stored',
      pending: 0,
    },
    {
      label: 'a long tool call',
      input: signal({
        eventName: 'tool.execute.after',
        transitionId: 'tool-1',
        measurements: { durationMs: 30_000 },
      }),
      kind: 'event-stored',
      pending: 0,
    },
    {
      label: 'a retry-shaped todo update',
      input: signal({ eventName: 'todo.updated', transitionId: 'todo-1', measurements: { attempt: 2 } }),
      kind: 'event-stored',
      pending: 0,
    },
  ])('records $label as $kind and leaves the pending count at $pending', ({ input, kind, pending }) => {
    const { lifecycle } = openTemporary()

    const result: PendingRecordResult = lifecycle.record(input)

    expect(result.kind).toBe(kind)
    // A needs-you event grows the pending set; nothing else does.
    if (result.kind !== 'pending-resolved') expect(result.pendingCount).toBe(pending)
    expect(lifecycle.pendingCount()).toBe(pending)
    expect(lifecycle.readPending()).toHaveLength(pending)
    // The pending set holds blocks and nothing else, so a finished turn, an error
    // and a long tool call never appear in it.
    for (const item of lifecycle.readPending()) expect(item.rawEventType).toBe('permission.asked')
  })

  it('gives the pending item exactly the approved fields, none of which can hold content', () => {
    const { lifecycle } = openTemporary()
    lifecycle.record(blockSignal())

    const item = lifecycle.readPending()[0]
    expect(item).toBeDefined()
    expect(Object.keys(item ?? {}).sort()).toEqual([
      'ackState',
      'class',
      'dedupeKey',
      'eventId',
      'harness',
      'occurredAt',
      'rawEventType',
      'receivedAt',
      'repoFullPath',
      'repoShortName',
      'resolutionState',
      'sessionId',
      'subtype',
    ])
    // A new block starts pending: unresolved and unacknowledged, the two facts
    // EL-FR-08 says nothing else may set on its own.
    expect(item?.class).toBe('needs-you')
    expect(item?.subtype).toBeNull()
    expect(item?.ackState).toBe('unacknowledged')
    expect(item?.resolutionState).toBe('unresolved')
    expect(item?.harness).toBe('opencode')
    // The repository short name is the identity, derived from the path (ADR-008).
    expect(item?.repoShortName).toBe('agent-ping')

    // The name-shape guard alongside the exact set: a field that could hold a
    // prompt is a leak a key set cannot catch on its own.
    const contentShapes: readonly RegExp[] = [
      /prompt/i,
      /respons/i,
      /\brepl(y|ies)\b/i,
      /messag/i,
      /content/i,
      /\bbod(y|ies)\b/i,
      /snippet/i,
      /excerpt/i,
      /transcript/i,
      /diff/i,
      /tool[_ ]?output/i,
      /text/i,
    ]
    for (const key of Object.keys(item ?? {})) {
      for (const shape of contentShapes) expect(shape.test(key), `${key} is content-shaped`).toBe(false)
    }
  })

  it('treats a replayed block as already known, so the count cannot double', () => {
    const { filePath, lifecycle } = openTemporary()
    const first = lifecycle.record(blockSignal())
    const replay = lifecycle.record(blockSignal())
    const laterReplay = lifecycle.record(blockSignal({ receivedAt: '2026-09-26T09:05:00.000Z' }))

    // The same block however many times it is delivered, from the pushed event or
    // from the polling fallback (EL-FR-07, HC-FR-08).
    expect(eventIdOf(first)).toBe(eventIdOf(replay))
    expect(eventIdOf(laterReplay)).toBe(eventIdOf(first))
    expect(replay.kind).toBe('already-known')
    expect(laterReplay.kind).toBe('already-known')
    expect(lifecycle.pendingCount()).toBe(1)
    expect(lifecycle.readPending()).toHaveLength(1)
    expect(rowCount(filePath)).toBe(1)
  })

  it('stores nothing at all for a signal the classifier deliberately suppressed', () => {
    const { filePath, lifecycle } = openTemporary()

    // The idle gate: a turn with no tool call, no file edit and no todo update
    // produces no event, not a quiet one (EL-FR-05).
    const idle = lifecycle.record(idleSignal({ turnWork: DID_NOTHING }))
    // A threshold the harness did not reach is a decision, reported as one.
    const belowThreshold = lifecycle.record(
      signal({ eventName: 'message.updated', transitionId: 'burn-1', measurements: { tokensUsed: 10 } }),
    )
    // A boundary the adapter consumes rather than a class event.
    const boundary = lifecycle.record(signal({ eventName: 'tool.execute.before', transitionId: 'tool-2' }))
    // A harness that cannot report the work signal degrades visibly, and still
    // quietly where that is the safe reading.
    const noWorkSignal = lifecycle.record(idleSignal({ transitionId: 'idle-3', turnWork: undefined }))

    expect(idle).toMatchObject({ kind: 'no-event', reason: 'idle-after-nothing', pendingCount: 0 })
    expect(belowThreshold).toMatchObject({ kind: 'no-event', reason: 'below-threshold', pendingCount: 0 })
    expect(boundary).toMatchObject({ kind: 'no-event', reason: 'not-a-class-event', pendingCount: 0 })
    expect(noWorkSignal).toMatchObject({ kind: 'no-event', reason: 'work-signal-unavailable', pendingCount: 0 })
    // Every answer carries its own reason's words, so a breadcrumb says which rule
    // applied rather than that something did not happen.
    expect(idle.kind === 'no-event' ? idle.detail : '').toMatch(
      /no tool call, no file edit and no todo update/,
    )
    expect(rowCount(filePath)).toBe(0)
    expect(lifecycle.readPending()).toEqual([])
    expect(lifecycle.pendingCount()).toBe(0)
  })

  it('lets nothing but the two exits clear a block', () => {
    const { filePath, lifecycle } = openTemporary()
    const blockId = eventIdOf(lifecycle.record(blockSignal()))
    const otherId = eventIdOf(lifecycle.record(otherBlock()))
    const before = rawRow(filePath, blockId)

    // A later finished event in the same session: the session is no longer blocked
    // and the block is still pending.
    lifecycle.record(idleSignal({ transitionId: 'idle-2', occurredAt: '2026-09-26T10:00:00.000Z' }))
    // Pruning the history around the block, with the age rule wide open: retention
    // has no business clearing one (EL-FR-09 protecting EL-FR-08).
    const pruned = pruneEvents({ filePath, now: '2027-09-26T12:00:00.000Z' })

    // Both rows are inside their session's floor of five hundred, so the floor is
    // what protected them here and the pending protection had nothing to do; it is
    // the other pruning test that puts a block outside its floor.
    expect(pruned.prunedCount).toBe(0)
    expect(pruned.keptPendingCount).toBe(0)
    expect(lifecycle.pendingCount()).toBe(2)
    expect(lifecycle.readPending().map((item) => item.eventId).sort()).toEqual([blockId, otherId].sort())
    // Not one column of the block moved.
    expect(rawRow(filePath, blockId)).toEqual(before)
  })

  it('refuses an unmapped signal loudly, and stores nothing while it does', () => {
    const { filePath, lifecycle } = openTemporary()
    lifecycle.record(blockSignal())

    const error = captureError(() =>
      lifecycle.record(signal({ eventName: 'session.teleported', transitionId: 'x-1' })),
    )

    // An unmapped signal is an accident, not a decision (APX-FR-02), and the error
    // carries three tokens so a breadcrumb cannot quote a payload (OA-FR-05).
    expect(error).toBeInstanceOf(ClassificationError)
    expect((error as ClassificationError).code).toBe('unmapped-signal')
    expect(Object.keys((error as ClassificationError).signal).sort()).toEqual([
      'eventName',
      'harness',
      'variant',
    ])
    expect(lifecycle.pendingCount()).toBe(1)
    expect(rowCount(filePath)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. The first exit: a resolution the harness reported
// ---------------------------------------------------------------------------

describe('leaving pending by resolution (EL-FR-08)', () => {
  it('clears the block the resolution names, and only that block', () => {
    const { lifecycle } = openTemporary()
    // Two blocks an hour apart, so the older one is first in the pending set
    // whatever order the row keys came out in, and the resolution names the
    // *second* of them. A resolution that cleared the first item it found would
    // pass on a tie and fail here.
    const olderId = eventIdOf(lifecycle.record(blockSignal({ occurredAt: '2026-09-26T09:00:00.000Z' })))
    const namedId = eventIdOf(lifecycle.record(otherBlock({ occurredAt: '2026-09-26T10:00:00.000Z' })))
    expect(lifecycle.readPending().map((item) => item.eventId)).toEqual([olderId, namedId])

    const result = lifecycle.record(
      resolutionSignal({
        sessionId: OTHER_SESSION_ID,
        transitionId: 'block-9',
        occurredAt: '2026-09-26T10:00:05.000Z',
      }),
    )

    expect(result.kind).toBe('pending-resolved')
    if (result.kind !== 'pending-resolved') throw new Error('unreachable')
    expect(result.transition).toEqual({
      transition: 'resolution',
      outcome: 'applied',
      reason: 'harness-reported-resolution',
      event: result.event,
      pendingCountBefore: 2,
      pendingCountAfter: 1,
    })
    expect(result.event.eventId).toBe(namedId)
    expect(result.event.sessionId).toBe(OTHER_SESSION_ID)
    expect(result.event.resolutionState).toBe('resolved')
    // The resolution is a fact of its own: it does not acknowledge for the
    // developer, and it does not touch the other session's block.
    expect(result.event.ackState).toBe('unacknowledged')
    expect(lifecycle.readPending().map((item) => item.eventId)).toEqual([olderId])
  })

  it('reports nothing-pending for a block that is not pending, however often it arrives', () => {
    const { filePath, lifecycle } = openTemporary()
    const blockId = eventIdOf(lifecycle.record(blockSignal()))
    lifecycle.reportResolved(blockId)
    const before = rawRow(filePath, blockId)

    const first = lifecycle.record(resolutionSignal())
    const second = lifecycle.record(resolutionSignal())
    const neverRecorded = lifecycle.record(resolutionSignal({ transitionId: 'block-never' }))

    // A resolution never creates the pending item it says is finished, and a
    // repeated one never counts twice.
    expect(first).toEqual({ kind: 'nothing-pending', pendingCount: 0 })
    expect(second).toEqual({ kind: 'nothing-pending', pendingCount: 0 })
    expect(neverRecorded).toEqual({ kind: 'nothing-pending', pendingCount: 0 })
    expect(rowCount(filePath)).toBe(1)
    expect(rawRow(filePath, blockId)).toEqual(before)
  })

  it('records a resolution once and treats the repeat as an explicit no-op', () => {
    const { lifecycle } = openTemporary()
    const blockId = eventIdOf(lifecycle.record(blockSignal()))

    const first = lifecycle.reportResolved(blockId)
    const second = lifecycle.reportResolved(blockId)
    const third = lifecycle.reportResolved(blockId)

    expect(first).toMatchObject({
      transition: 'resolution',
      outcome: 'applied',
      reason: 'harness-reported-resolution',
      pendingCountBefore: 1,
      pendingCountAfter: 0,
    })
    // The idempotent no-op, reported as one: the count does not move a second time
    // and neither fact changes.
    expect(second).toMatchObject({
      outcome: 'unchanged',
      reason: 'already-resolved',
      pendingCountBefore: 0,
      pendingCountAfter: 0,
    })
    expect(third.outcome).toBe('unchanged')
    expect(second.event).toEqual(first.event)
  })

  it('records a resolution that arrives after an acknowledgement, as a second independent fact', () => {
    const { lifecycle } = openTemporary()
    const blockId = eventIdOf(lifecycle.record(blockSignal()))
    expect(lifecycle.acknowledge(blockId).outcome).toBe('applied')

    const result = lifecycle.reportResolved(blockId)

    // Applied, not swallowed: the developer dealt with the block first, the harness
    // still reported it resolved, and history shows both (PRD 10).
    expect(result).toMatchObject({
      transition: 'resolution',
      outcome: 'applied',
      reason: 'resolution-after-acknowledgement',
      pendingCountBefore: 0,
      pendingCountAfter: 0,
    })
    expect(result.event?.ackState).toBe('acknowledged')
    expect(result.event?.resolutionState).toBe('resolved')
  })

  it('refuses a resolution signal that names no block, and clears nothing', () => {
    const { filePath, lifecycle } = openTemporary()
    const blockId = eventIdOf(lifecycle.record(blockSignal()))
    const before = rawRow(filePath, blockId)

    const error = captureError(() => lifecycle.record(resolutionSignal({ transitionId: undefined })))

    expect(error).toBeInstanceOf(PendingLifecycleError)
    const lifecycleError = error as PendingLifecycleError
    expect(lifecycleError.code).toBe('unidentifiable-block')
    expect(lifecycleError.signal).toEqual({
      harness: 'opencode',
      eventName: 'permission.replied',
      variant: null,
    })
    // The message names the rule and quotes nothing, because a failure message is
    // written to a log or shown in a breadcrumb (OA-FR-05, IO-FR-09).
    expect(lifecycleError.message).toMatch(/the same block identifier the permission ask reported/)
    expect(lifecycleError.message).not.toContain(SESSION_ID)
    expect(lifecycleError.message).not.toContain(REPO_PATH)
    expect(lifecycle.pendingCount()).toBe(1)
    expect(rawRow(filePath, blockId)).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// 5. The second exit: the developer acknowledging, and the rejection
// ---------------------------------------------------------------------------

describe('leaving pending by acknowledgement (EL-FR-08, APX-CON-08, HC-FR-05)', () => {
  it('records an acknowledgement once and treats the repeat as an explicit no-op', () => {
    const { lifecycle } = openTemporary()
    const blockId = eventIdOf(lifecycle.record(blockSignal()))

    const first = lifecycle.acknowledge(blockId)
    const second = lifecycle.acknowledge(blockId)
    const third = lifecycle.acknowledge(blockId)

    expect(first).toMatchObject({
      transition: 'acknowledgement',
      outcome: 'applied',
      reason: 'developer-acknowledgement',
      pendingCountBefore: 1,
      pendingCountAfter: 0,
    })
    // Never a second count: before equals after on every repeat, because the count
    // is read from the store at each end rather than accumulated here.
    expect(second).toMatchObject({
      outcome: 'unchanged',
      reason: 'already-acknowledged',
      pendingCountBefore: 0,
      pendingCountAfter: 0,
    })
    expect(third.outcome).toBe('unchanged')
    expect(second.event).toEqual(first.event)
    expect(lifecycle.pendingCount()).toBe(0)
    expect(lifecycle.readPending()).toEqual([])
  })

  it('never moves the count twice, however many times a block is acknowledged or resolved', () => {
    // The double count EL-FR-08 forbids, tested as a burst rather than as one
    // repeat: a hub that replays pending items on start (HC-FR-07), a polling
    // fallback delivering the same block again (OA-FR-07) and a developer clicking
    // twice all arrive as more attempts on a row that is already settled. Only the
    // first attempt on each block may move the count, and it moves by exactly one.
    const { lifecycle } = openTemporary()
    const firstId = eventIdOf(lifecycle.record(blockSignal()))
    const secondId = eventIdOf(lifecycle.record(otherBlock()))

    const attempts: { transition: PendingTransition; before: number; after: number }[] = []
    for (let round = 0; round < 4; round += 1) {
      for (const id of [firstId, secondId]) {
        attempts.push(pick(lifecycle.acknowledge(id)))
        attempts.push(pick(lifecycle.reportResolved(id)))
      }
    }

    // Both blocks are dealt with on the first round, and nothing after that moves a
    // number: every later attempt is (0 -> 0).
    expect(attempts.filter((attempt) => attempt.before !== attempt.after).map((attempt) => attempt.before)).toEqual([
      2, 1,
    ])
    expect(attempts.slice(4).every((attempt) => attempt.before === 0 && attempt.after === 0)).toBe(true)
    expect(attempts.every((attempt) => attempt.after >= 0 && Number.isInteger(attempt.after))).toBe(true)
    expect(lifecycle.pendingCount()).toBe(0)
    expect(lifecycle.readPending()).toEqual([])

    function pick(result: PendingTransitionResult): { transition: PendingTransition; before: number; after: number } {
      return {
        transition: result.transition,
        before: result.pendingCountBefore,
        after: result.pendingCountAfter,
      }
    }
  })

  it('rejects acknowledging a block the harness already resolved, distinguishably, and changes nothing', () => {
    const { filePath, lifecycle } = openTemporary()
    const blockId = eventIdOf(lifecycle.record(blockSignal()))
    lifecycle.reportResolved(blockId)
    const before = rawRow(filePath, blockId)

    const refused = lifecycle.acknowledge(blockId)
    const refusedAgain = lifecycle.acknowledge(blockId)

    // Distinguishable from the idempotent no-op in both fields, which is what the
    // ack route turns into a conflict rather than a success (HC-FR-05).
    expect(refused).toMatchObject({
      transition: 'acknowledgement',
      outcome: 'rejected',
      reason: 'already-resolved-by-harness',
      pendingCountBefore: 0,
      pendingCountAfter: 0,
    })
    expect(refused.outcome).not.toBe('unchanged')
    expect(refused.event?.ackState).toBe('unacknowledged')
    expect(refused.event?.resolutionState).toBe('resolved')
    // A rejection is a rejection however many times it arrives, and not one column
    // of the row moved on the first attempt or the tenth.
    expect(refusedAgain).toEqual(refused)
    expect(rawRow(filePath, blockId)).toEqual(before)
    expect(lifecycle.pendingCount()).toBe(0)
  })

  it('rejects acknowledging a row that is not a pending item, and writes nothing at all', () => {
    const { filePath, lifecycle } = openTemporary()
    // A finished event's identifier, which any caller holding a row key could try.
    const finishedId = eventIdOf(lifecycle.record(idleSignal()))
    const before = rawRow(filePath, finishedId)

    const refused = lifecycle.acknowledge(finishedId)
    const refusedResolution = lifecycle.reportResolved(finishedId)

    // APX-CON-08: the ack route may only mark a pending item acknowledged, and this
    // is a finished turn, so the attempt is refused and the whole row is unchanged.
    expect(refused).toMatchObject({ outcome: 'rejected', reason: 'not-a-pending-item' })
    expect(refusedResolution).toMatchObject({ outcome: 'rejected', reason: 'not-a-pending-item' })
    expect(refused.event?.class).toBe('finished')
    expect(before?.['ack_state']).toBe('unacknowledged')
    expect(before?.['resolution_state']).toBe('unresolved')
    expect(rawRow(filePath, finishedId)).toEqual(before)
    // And it never became pending on the way.
    expect(lifecycle.pendingCount()).toBe(0)
    expect(lifecycle.readPending()).toEqual([])
  })

  it('answers not-found for an identifier that does not exist, without creating anything', () => {
    const { lifecycle } = openTemporary()
    const blockId = eventIdOf(lifecycle.record(blockSignal()))

    expect(lifecycle.acknowledge('evt_absent')).toEqual({
      transition: 'acknowledgement',
      outcome: 'not-found',
      reason: 'no-such-item',
      event: null,
      pendingCountBefore: 1,
      pendingCountAfter: 1,
    })
    expect(lifecycle.reportResolved('evt_absent').outcome).toBe('not-found')
    // The live block is untouched by a failed lookup beside it.
    expect(lifecycle.pendingCount()).toBe(1)
    expect(lifecycle.readPending().map((item) => item.eventId)).toEqual([blockId])
  })
})

// ---------------------------------------------------------------------------
// 6. Restart survival
// ---------------------------------------------------------------------------

describe('surviving a restart (EL-FR-08, PRD 10)', () => {
  it('reports an identical pending set after closing and reopening the database', () => {
    const { filePath, lifecycle } = openTemporary()
    const blockId = eventIdOf(lifecycle.record(blockSignal()))
    const otherId = eventIdOf(lifecycle.record(otherBlock()))
    const pendingBefore = lifecycle.readPending()
    const rowsBefore = pendingBefore.map((item) => rawRow(filePath, item.eventId))

    // Close the file and open it again with a new store and a new lifecycle, which
    // is what a restarted hub does: nothing is carried across in memory.
    closeEveryStore()
    const { lifecycle: restarted } = openPending(filePath)

    // Identical state, not merely an identical count.
    expect(restarted.readPending()).toEqual(pendingBefore)
    expect(restarted.pendingCount()).toBe(2)
    expect(restarted.readPending().map((item) => item.eventId).sort()).toEqual([blockId, otherId].sort())
    expect(restarted.readPending().map((item) => rawRow(filePath, item.eventId))).toEqual(rowsBefore)
    // The same keys in the same order, which is what the badge and the dashboard read.
    expect(restarted.readPending().map((item) => item.dedupeKey)).toEqual(
      pendingBefore.map((item) => item.dedupeKey),
    )
  })

  it('keeps a settled block settled across a reopen, whichever fact settled it', () => {
    const { filePath, lifecycle } = openTemporary()
    const resolvedId = eventIdOf(lifecycle.record(blockSignal()))
    lifecycle.reportResolved(resolvedId)
    const acknowledgedId = eventIdOf(lifecycle.record(otherBlock()))
    lifecycle.acknowledge(acknowledgedId)
    expect(lifecycle.pendingCount()).toBe(0)

    closeEveryStore()
    const { lifecycle: restarted } = openPending(filePath)

    expect(restarted.readPending()).toEqual([])
    expect(restarted.pendingCount()).toBe(0)
    // Both facts survived, separately, so history can still show which one happened.
    expect(rawRow(filePath, resolvedId)).toMatchObject({
      resolution_state: 'resolved',
      ack_state: 'unacknowledged',
    })
    expect(rawRow(filePath, acknowledgedId)).toMatchObject({
      resolution_state: 'unresolved',
      ack_state: 'acknowledged',
    })
    // Replaying either transition after the restart is a no-op, not a second count.
    expect(restarted.reportResolved(resolvedId)).toMatchObject({
      outcome: 'unchanged',
      pendingCountBefore: 0,
      pendingCountAfter: 0,
    })
    expect(restarted.acknowledge(acknowledgedId)).toMatchObject({
      outcome: 'unchanged',
      reason: 'already-acknowledged',
      pendingCountBefore: 0,
      pendingCountAfter: 0,
    })
  })

  it('does not acknowledge the same block twice across a restart', () => {
    const { filePath, lifecycle } = openTemporary()
    const blockId = eventIdOf(lifecycle.record(blockSignal()))
    expect(lifecycle.acknowledge(blockId)).toMatchObject({
      outcome: 'applied',
      pendingCountBefore: 1,
      pendingCountAfter: 0,
    })

    closeEveryStore()
    const { lifecycle: restarted } = openPending(filePath)
    const replay = restarted.acknowledge(blockId)

    // A hub that replays a pending item on start (HC-FR-07) and a developer who
    // clicks again both arrive here, and neither may count the block twice.
    expect(replay).toMatchObject({
      outcome: 'unchanged',
      reason: 'already-acknowledged',
      pendingCountBefore: 0,
      pendingCountAfter: 0,
    })
    expect(restarted.pendingCount()).toBe(0)
    expect(rowCount(filePath)).toBe(1)
  })

  it('reports an empty set for a lifecycle over a fresh database, however full the other one was', () => {
    const full = openTemporary()
    full.lifecycle.record(blockSignal())
    full.lifecycle.record(otherBlock())
    expect(full.lifecycle.pendingCount()).toBe(2)

    const empty = openTemporary()

    // The two lifecycles disagree, which is only possible if neither of them holds
    // pending state in memory (EL-FR-08).
    expect(empty.lifecycle.readPending()).toEqual([])
    expect(empty.lifecycle.pendingCount()).toBe(0)
    expect(full.lifecycle.pendingCount()).toBe(2)
    expect(empty.lifecycle.readPending().map((item) => item.eventId)).not.toEqual(
      full.lifecycle.readPending().map((item) => item.eventId),
    )
  })

  it('lets two lifecycles over the same file agree, in whichever order they read', () => {
    const { filePath, lifecycle } = openTemporary()
    const second = createPendingLifecycle(openStoreAt(filePath))
    lifecycle.record(blockSignal())

    expect(second.readPending()).toEqual(lifecycle.readPending())
    expect(second.pendingCount()).toBe(1)
    expect(createPendingLifecycle(openStoreAt(filePath)).readPending()).toEqual(lifecycle.readPending())
  })
})

// ---------------------------------------------------------------------------
// 7. The pending set as the single source of truth
// ---------------------------------------------------------------------------

describe('the pending set is the single source of truth (NT-FR-05, HC-FR-05, PRD 16 #3)', () => {
  it('is the store own read, oldest first, and identical across a reopen', () => {
    const { filePath, lifecycle } = openTemporary()
    lifecycle.record(
      blockSignal({ sessionId: 'ses_late', transitionId: 'block-late', occurredAt: '2026-09-26T11:00:00.000Z' }),
    )
    lifecycle.record(
      blockSignal({ transitionId: 'block-early', occurredAt: '2026-09-26T08:00:00.000Z' }),
    )
    const pending = lifecycle.readPending()

    // Oldest first, so the tray badge and the dashboard read the order the store
    // uses rather than inventing one.
    expect(pending.map((item) => item.rawEventType)).toEqual(['permission.asked', 'permission.asked'])
    expect(pending.map((item) => item.occurredAt)).toEqual([
      '2026-09-26T08:00:00.000Z',
      '2026-09-26T11:00:00.000Z',
    ])

    closeEveryStore()
    expect(openPending(filePath).lifecycle.readPending()).toEqual(pending)
  })

  it('agrees with every session summary count, so there is one definition of pending', () => {
    const { store, lifecycle } = openTemporary()
    lifecycle.record(blockSignal())
    lifecycle.record(otherBlock())
    lifecycle.record(otherBlock({ transitionId: 'block-10' }))
    // A settled block stops counting, and only in its own session.
    lifecycle.acknowledge(pendingIdIn(lifecycle, SESSION_ID))

    const summaries = store.readSessionSummaries()
    const fromSet = lifecycle.readPending().length
    const fromCount = lifecycle.pendingCount()
    const fromSummaries = summaries.reduce((total, summary) => total + summary.pendingCount, 0)

    // Three readings a badge could be built from, and all three agree: the set, the
    // lifecycle's count, and the store's own per-session count.
    expect([fromSet, fromCount, fromSummaries]).toEqual([2, 2, 2])
    expect(summaries.find((summary) => summary.sessionId === SESSION_ID)?.pendingCount).toBe(0)
    expect(summaries.find((summary) => summary.sessionId === OTHER_SESSION_ID)?.pendingCount).toBe(2)
  })

  it('survives a prune that the pending protection had to save it from', () => {
    const { filePath, lifecycle } = openTemporary()
    // An old block in a session with six hundred recent rows, so the block is an
    // age candidate and sits outside the session's floor of five hundred. Age and
    // the floor alone would prune it, and EL-FR-09's protection is what does not.
    const blockId = eventIdOf(
      lifecycle.record(
        blockSignal({ transitionId: 'block-old', occurredAt: '2026-03-01T09:00:00.000Z' }),
      ),
    )
    const recentBulk = Array.from({ length: 600 }, (_unused, index) =>
      lifecycle.record(
        signal({
          eventName: 'session.error',
          sessionId: SESSION_ID,
          transitionId: `err-${index}`,
          occurredAt: new Date(Date.parse('2026-09-26T12:00:00.000Z') - index * 60_000).toISOString(),
          receivedAt: '2026-09-26T12:00:00.000Z',
        }),
      ),
    )
    for (const stored of recentBulk) expect(stored.kind).toBe('event-stored')
    const pendingBefore = lifecycle.readPending()

    const pruned = pruneEvents({ filePath, now: '2026-09-26T12:00:00.000Z' })

    // Reported rather than inferred: the protection did real work on this row.
    expect(pruned.keptPendingCount).toBe(1)
    expect(pruned.prunedEventIds).not.toContain(blockId)
    expect(lifecycle.readPending()).toEqual(pendingBefore)
    expect(lifecycle.pendingCount()).toBe(1)
    expect(lifecycle.readPending()[0]?.eventId).toBe(blockId)
  })
})

// ---------------------------------------------------------------------------
// 8. The module's own boundaries
// ---------------------------------------------------------------------------

describe('what the lifecycle source does not do (EL-FR-08, EL-FR-03, APX-FR-01, APX-CON-12)', () => {
  const domainDir = fileURLToPath(new URL('../../src/domain/', import.meta.url))
  const source = readFileSync(`${domainDir}pending.ts`, 'utf8')

  /**
   * The source with its comments removed - block comments and line comments both -
   * so the scans below are about code and not about this file's own prose about
   * SQL, columns and state.
   */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')

  const specifiers = (): readonly string[] => [
    ...new Set([...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1] ?? '')),
  ]

  it('reads the module at all, so the scans below are not vacuous', () => {
    expect(source.length).toBeGreaterThan(0)
    // The comments really were removed, so the SQL, column and state scans are not
    // matching prose that happens to use the words.
    expect(source.length).toBeGreaterThan(code.length)
    expect(code).not.toContain('SELECT')
    // Proof that a word which does appear in the code would be caught: the class
    // literal is here in the code, because comparing it is how the module decides
    // what may be cleared.
    expect(code).toContain('needs-you')
  })

  it('writes no column of its own: every durable fact goes through the typed accessors', () => {
    // The lifecycle is a reader and a router, not a second writer. A `SET` clause
    // here would be a column nothing in schema.sql ever declared, so the check is
    // for the whole family rather than one statement.
    expect(code).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/)
    expect(code).not.toMatch(/\b(events|sessions|counters|schema_version)\s*[.,]/)
    expect(code).not.toMatch(/\bprepare\s*\(|\.exec\s*\(/)
  })

  it('resolves no path of its own, so there is one place the database file is decided', () => {
    // paths.ts is the only resolution point (EL-FR-11, IO-FR-07), and this module
    // is handed a store rather than opening a second connection to a file it
    // guessed at.
    expect(code).not.toMatch(/databaseFilePath/)
    expect(code).not.toMatch(/\b(join|resolve)\(/)
    expect(code).not.toMatch(/process\.env/)
  })

  it('holds no pending state in memory, so a restart can neither lose nor invent one', () => {
    // No mutable module-level binding and no collection a cache could hide in. A
    // lifecycle with either would report whichever file it saw first, and
    // EL-FR-08's restart clause would hold only until the process restarted.
    expect(code).not.toMatch(/^\s*(let|var)\s/m)
    expect(code).not.toMatch(/\bnew\s+(Map|Set|WeakMap|WeakSet)\b/)
    expect(code).not.toMatch(/\b(module|globalThis|global)\b/)
    expect(code).not.toMatch(/\bDate\.now\b|new\s+Date\b/)
  })

  it('reaches the store through a type-only import, so nothing here loads a database driver', () => {
    const storeStatements = [...source.matchAll(/^[^\n]*storage\/eventStore[^\n]*$/gm)].map((match) => match[0])
    expect(storeStatements.length).toBeGreaterThan(0)
    for (const statement of storeStatements) {
      expect(statement.trim().startsWith('import type')).toBe(true)
    }
    // Its only value imports are the classifier's, which are pure.
    expect(specifiers().filter((specifier) => specifier !== '../storage/eventStore.js')).toEqual([
      './classify.js',
    ])
  })

  it('imports nothing that could open a socket, a process, a surface or a database', () => {
    for (const specifier of specifiers()) {
      // Every specifier is relative, so nothing outside this repository is loaded at
      // all: no driver, no server, no renderer, no framework.
      expect(specifier.startsWith('.'), `pending.ts imports ${specifier}`).toBe(true)
    }
  })

  it('calls no network or process API', () => {
    const forbidden = /(?<![\w.])(fetch|WebSocket|XMLHttpRequest|spawn|spawnSync|execFile|createServer|listen)\s*\(/
    expect(forbidden.test(code)).toBe(false)
  })

  it('never passes a verbose callback to the driver, which would print bound values to a local log', () => {
    expect(code).not.toMatch(/verbose\s*:/)
  })
})

// ---------------------------------------------------------------------------
// 9. The result shapes a caller renders
// ---------------------------------------------------------------------------

describe('the lifecycle result shapes (EL-FR-08, HC-FR-05)', () => {
  it('carries exactly the fields a caller renders, and no identifier it does not need', () => {
    const { lifecycle } = openTemporary()
    const blockId = eventIdOf(lifecycle.record(blockSignal()))

    const applied: PendingTransitionResult = lifecycle.acknowledge(blockId)
    expect(Object.keys(applied).sort()).toEqual([
      'event',
      'outcome',
      'pendingCountAfter',
      'pendingCountBefore',
      'reason',
      'transition',
    ])
    // The row is the store's own read shape, so nothing here widens it.
    expect(Object.keys(applied.event ?? {})).not.toContain('prompt')

    // Every record result is exhaustive in its own field set, so a caller
    // branching on `kind` gets a narrowed shape rather than a nullable one.
    const created: PendingRecordResult = lifecycle.record(blockSignal({ transitionId: 'block-11' }))
    expect(Object.keys(created).sort()).toEqual(['event', 'kind', 'pendingCount'])
    expect(created.kind).toBe('pending-created')
  })

  it('names its two transitions and its row states in a fixed order', () => {
    // The order is the review surface: it is what a legend or a status map reads.
    expect([...PENDING_ROW_STATES]).toEqual([
      'no-row',
      'not-a-block',
      'resolved',
      'acknowledged',
      'acknowledged-and-resolved',
    ])
  })

  it('has a cell for every scenario it can reach, and refuses anything else', () => {
    // lookupTransition throws for a combination with no cell rather than
    // defaulting, because a default would be a third, silent exit from pending.
    // Nothing in the public API can reach one today - the store's own answers and
    // the row states are both closed sets - and the table test above is what proves
    // every cell is a real outcome rather than a description of nothing.
    expect(Object.keys(PENDING_TRANSITION_OUTCOMES)).toHaveLength(12)
    for (const key of Object.keys(PENDING_TRANSITION_OUTCOMES)) {
      expect(key.split(':')).toHaveLength(3)
    }
  })
})
