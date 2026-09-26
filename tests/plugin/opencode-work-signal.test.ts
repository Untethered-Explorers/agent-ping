// The per-turn work-signal accumulator: three booleans, a turn boundary, and the
// identities a turn's events are keyed by (OA-FR-03, EL-FR-05, EL-FR-06, ADR-004).
//
//   npm test -- tests/plugin/opencode-work-signal.test.ts
//
// This is the module that decides whether an idle transition is a finished session
// or a session that opened, said hello and closed, so the tests are written from the
// outside in: what a turn's answer must be, and when it must change. The last
// describe block reads the module's own source, because two of its properties are
// not visible from the outside - that it decides nothing (the idle gate is the
// classifier's) and that it opens nothing.
//
// The four properties that matter, one describe each:
//
//   1. A TURN WITH WORK, AND A TURN WITHOUT. Each of the three measures on its own
//      reports work, and a turn with none of them reports none (EL-FR-05, OA-FR-03).
//   2. THE RESET. A turn never inherits the previous turn's work, and the identity of
//      one turn survives the two forms of its idle transition so both derive a single
//      dedupe key (EL-FR-06).
//   3. THE MINT. One identity namespace per kind of signal, per session, monotonic,
//      refused for the turn's own namespace - and the same numbers on a second run,
//      because nothing here reads a clock.
//   4. THE BOUND. The recorder forgets the least recently used session when it is
//      full, because it runs inside the developer's agent process (APX-CON-03).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { TurnWorkSignal } from '@/domain/classify'
import type { WorkMeasure, WorkSignalRecorder } from '@/plugin/opencode/work-signal'
import {
  MAX_TRACKED_SESSIONS,
  TURN_IDENTITY_PART,
  WORK_MEASURES,
  createWorkSignalRecorder,
} from '@/plugin/opencode/work-signal'

const SESSION = 'ses_01'
const OTHER = 'ses_02'

/** The three measures, as the work signal the classifier reads. */
const NO_WORK: TurnWorkSignal = { toolCall: false, fileEdit: false, todoUpdate: false }

/**
 * Which of the work signal's three booleans a measure sets.
 *
 * The work signal is camel-cased where opencode's event names are dotted, and this
 * map is the only place the two vocabularies are put side by side - the recorder
 * itself never translates.
 */
const MEASURE_KEY: Readonly<Record<WorkMeasure, keyof TurnWorkSignal>> = {
  'tool-call': 'toolCall',
  'file-edit': 'fileEdit',
  'todo-update': 'todoUpdate',
}

const worked = (measure: WorkMeasure): TurnWorkSignal => ({
  ...NO_WORK,
  [MEASURE_KEY[measure]]: true,
})

/**
 * A recorder with a two-session bound, for the eviction test.
 *
 * The production bound is asserted separately; a test that filled a hundred and
 * twenty-eight entries to prove a two-entry rule would be testing the wrong thing.
 */
function boundedRecorder(): WorkSignalRecorder {
  return createWorkSignalRecorder({ maxSessions: 2 })
}

describe('the three measures (OA-FR-03, EL-FR-05)', () => {
  it('names exactly the three things the requirement names, and no fourth', () => {
    expect(WORK_MEASURES).toEqual(['tool-call', 'file-edit', 'todo-update'])
  })

  it('reports no work for a turn that did none of the three', () => {
    const recorder = createWorkSignalRecorder()
    expect(recorder.turn(SESSION).work).toEqual(NO_WORK)
  })

  it.each(WORK_MEASURES)('reports work for a turn with a %s', (measure) => {
    const recorder = createWorkSignalRecorder()
    recorder.noteWork(SESSION, measure)
    expect(recorder.turn(SESSION).work).toEqual(worked(measure))
  })

  it('reports a turn that did all three as three booleans, never as a count', () => {
    // A tally across a turn is a transcript wearing a numeric disguise, which is why
    // the store's work_signal column is a 0 or 1 too (EL-FR-05).
    const recorder = createWorkSignalRecorder()
    recorder.noteWork(SESSION, 'tool-call')
    recorder.noteWork(SESSION, 'tool-call')
    recorder.noteWork(SESSION, 'file-edit')
    recorder.noteWork(SESSION, 'todo-update')
    expect(Object.values(recorder.turn(SESSION).work)).toEqual([true, true, true])
  })

  it('keeps one turn\'s work out of another session\'s', () => {
    const recorder = createWorkSignalRecorder()
    recorder.noteWork(SESSION, 'tool-call')
    expect(recorder.turn(OTHER).work).toEqual(NO_WORK)
    expect(recorder.turn(SESSION).work).toEqual(worked('tool-call'))
  })

  it('starts a session it has never seen with an empty turn rather than a guess', () => {
    // The restrained reading of an unknown turn is an empty one: a wrong positive is a
    // notification the developer cannot explain, and a missing one is silence they
    // can investigate (ADR-004).
    const recorder = createWorkSignalRecorder()
    const first = recorder.turn(SESSION)
    expect(first.work).toEqual(NO_WORK)
    expect(first.turn).toBe(1)
  })

  it('keeps the work of a session it first saw mid-turn', () => {
    // A plugin attached to a running session sees the turn's work, not its beginning.
    const recorder = createWorkSignalRecorder()
    recorder.noteWork(SESSION, 'tool-call')
    expect(recorder.turn(SESSION).work).toEqual(worked('tool-call'))
    expect(recorder.turn(SESSION).turn).toBe(1)
  })
})

describe('the turn boundary (OA-FR-03, EL-FR-06)', () => {
  it('clears the work when a new turn begins, so an empty later turn is quiet', () => {
    const recorder = createWorkSignalRecorder()
    recorder.noteWork(SESSION, 'tool-call')
    expect(recorder.reportTurn(SESSION).work).toEqual(worked('tool-call'))

    recorder.beginTurn(SESSION)
    expect(recorder.turn(SESSION).work).toEqual(NO_WORK)
    // And the report of that empty turn is the answer the idle gate will read.
    expect(recorder.reportTurn(SESSION).work).toEqual(NO_WORK)
  })

  it('clears the work when a turn ends, so a missed busy status cannot leak it', () => {
    // The second reset. Without it a session whose busy status never arrived would
    // carry its first turn's work into its second, and a "hello, goodbye" turn would
    // be reported as finished.
    const recorder = createWorkSignalRecorder()
    recorder.noteWork(SESSION, 'tool-call')
    expect(recorder.reportTurn(SESSION).work).toEqual(worked('tool-call'))
    expect(recorder.reportTurn(SESSION).work).toEqual(NO_WORK)
  })

  it('keeps one turn\'s identity across both forms of its idle transition', () => {
    // This is what makes the deprecated session.idle event and the modern
    // session.status idle transition one event rather than two (EL-FR-06).
    const recorder = createWorkSignalRecorder()
    recorder.noteWork(SESSION, 'tool-call')
    const first = recorder.reportTurn(SESSION)
    const second = recorder.reportTurn(SESSION)
    expect(second.transitionId).toBe(first.transitionId)
    // The second form reports the same transition with the work already reported,
    // which the classifier reads as "this turn did nothing new".
    expect(second.work).toEqual(NO_WORK)
  })

  it('mints a new identity for the next turn of the same session', () => {
    const recorder = createWorkSignalRecorder()
    const first = recorder.beginTurn(SESSION)
    const second = recorder.beginTurn(SESSION)
    expect(second.turn).toBe(first.turn + 1)
    expect(second.transitionId).not.toBe(first.transitionId)
    expect(second.transitionId).toBe(`${TURN_IDENTITY_PART}:2`)
  })

  it('keeps two sessions\' turn numbers independent', () => {
    const recorder = createWorkSignalRecorder()
    recorder.beginTurn(SESSION)
    recorder.beginTurn(SESSION)
    expect(recorder.turn(SESSION).turn).toBe(2)
    expect(recorder.turn(OTHER).turn).toBe(1)
  })

  it('reports a snapshot, so later work cannot change an answer already given', () => {
    const recorder = createWorkSignalRecorder()
    recorder.noteWork(SESSION, 'tool-call')
    const reported = recorder.reportTurn(SESSION)
    recorder.noteWork(SESSION, 'todo-update')
    expect(reported.work).toEqual(worked('tool-call'))
  })

  it('reads the same identity the turn will report, without reporting it', () => {
    const recorder = createWorkSignalRecorder()
    recorder.beginTurn(SESSION)
    const read = recorder.turn(SESSION)
    expect(read.transitionId).toBe(recorder.currentTransitionId(SESSION))
    // Reading is not reporting: the measures are still there.
    recorder.noteWork(SESSION, 'tool-call')
    expect(recorder.currentTransitionId(SESSION)).toBe(read.transitionId)
    expect(recorder.reportTurn(SESSION).transitionId).toBe(read.transitionId)
  })
})

describe('the minted identities (EL-FR-06, OA-FR-07)', () => {
  it('mints per session and in order, in one part:n shape', () => {
    const recorder = createWorkSignalRecorder()
    expect(recorder.mintIdentity(SESSION, 'error')).toBe('error:1')
    expect(recorder.mintIdentity(SESSION, 'error')).toBe('error:2')
    expect(recorder.mintIdentity(OTHER, 'error')).toBe('error:1')
    expect(recorder.mintIdentity(SESSION, 'compaction')).toBe('compaction:1')
  })

  it('refuses to mint into the turn namespace, so a signal cannot renumber a live turn', () => {
    const recorder = createWorkSignalRecorder()
    recorder.beginTurn(SESSION)
    const before = recorder.currentTransitionId(SESSION)
    expect(() => recorder.mintIdentity(SESSION, TURN_IDENTITY_PART)).toThrow(/reserved/)
    expect(recorder.currentTransitionId(SESSION)).toBe(before)
  })

  it('mints the same numbers on a second run, because nothing here reads a clock', () => {
    // A key built from when it was observed changes on replay and defeats the dedupe,
    // so a replay of one event has to mint the same identity it minted the first time
    // (EL-FR-06).
    const first = createWorkSignalRecorder()
    const second = createWorkSignalRecorder()
    const sequence = (recorder: WorkSignalRecorder): readonly string[] => [
      recorder.beginTurn(SESSION).transitionId,
      recorder.mintIdentity(SESSION, 'error'),
      recorder.mintIdentity(SESSION, 'error'),
      recorder.beginTurn(SESSION).transitionId,
    ]
    expect(sequence(first)).toEqual(sequence(second))
  })

  it('hands the polling fallback the same identity the push path would use', () => {
    // OA-FR-07: a session that both pushes and is polled must collapse to one event,
    // which it only does if the poller asks this recorder rather than minting its own.
    const recorder = createWorkSignalRecorder()
    recorder.beginTurn(SESSION)
    recorder.noteWork(SESSION, 'tool-call')
    const pushed = recorder.reportTurn(SESSION)
    const polled = recorder.currentTransitionId(SESSION)
    expect(polled).toBe(pushed.transitionId)
  })
})

describe('the bound (APX-CON-03)', () => {
  it('caps the sessions it tracks, at a number a developer cannot reach in practice', () => {
    expect(MAX_TRACKED_SESSIONS).toBeGreaterThanOrEqual(64)
    const recorder = createWorkSignalRecorder({ maxSessions: 2 })
    recorder.turn('a')
    recorder.turn('b')
    recorder.turn('c')
    expect(recorder.trackedSessions).toBe(2)
  })

  it('forgets the least recently used session first, so the live one survives', () => {
    const recorder = boundedRecorder()
    recorder.noteWork('a', 'tool-call')
    recorder.noteWork('b', 'tool-call')
    // Touching 'a' makes 'b' the least recently used.
    recorder.turn('a')
    recorder.turn('c')
    expect(recorder.turn('a').work).toEqual(worked('tool-call'))
    // 'b' starts again from an empty turn, which under-reports rather than invents.
    expect(recorder.turn('b').work).toEqual(NO_WORK)
  })

  it('forgets a session on request, and is safe for one it never tracked', () => {
    const recorder = createWorkSignalRecorder()
    recorder.noteWork(SESSION, 'tool-call')
    recorder.forget(SESSION)
    expect(recorder.trackedSessions).toBe(0)
    expect(recorder.turn(SESSION).work).toEqual(NO_WORK)
    expect(() => recorder.forget('never-seen')).not.toThrow()
  })
})

describe('what this module is not (EL-FR-05, APX-CON-12)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/plugin/opencode/work-signal.ts', import.meta.url)),
    'utf8',
  )
  const importLines = source.split('\n').filter((line) => /^\s*import\s/.test(line))

  it('reaches the classifier through a type-only import, so it decides nothing', () => {
    // The idle gate belongs to src/domain/classify.ts. A recorder that also decided
    // would be a second copy of the loudness rule, and the two would drift without
    // either failing.
    expect(source).toContain("import type { TurnWorkSignal } from '../../domain/classify.js'")
    expect(importLines.filter((line) => line.includes('classify'))).toEqual([
      "import type { TurnWorkSignal } from '../../domain/classify.js'",
    ])
  })

  it('imports nothing else at all: no driver, no server, no process, no clock', () => {
    expect(importLines).toEqual(["import type { TurnWorkSignal } from '../../domain/classify.js'"])
    for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:child_process', 'better-sqlite3', 'Date']) {
      expect(source.includes(forbidden), `work-signal.ts mentions ${forbidden}`).toBe(false)
    }
  })
})
