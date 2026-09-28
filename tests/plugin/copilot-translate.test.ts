// The Copilot signal-mapping test, and — because the gate recorded DEFERRAL — the
// executable half of a runbook rather than of an adapter (CP-FR-05, CP-FR-06, CP-4).
//
//   npm test -- tests/plugin/copilot-translate.test.ts
//
// WHY THIS FILE IS NAMED FOR A TABLE THAT DOES NOT EXIST. A Copilot adapter would be
// the pair `src/plugin/copilot/translate.ts` and `src/plugin/copilot/index.ts`, and
// the table-driven test that enumerates it is named for the translation. The human
// gate in docs/reviews/CP-3-console-review.md recorded **deferral**: no adapter and no
// heuristic are authorised. So there is no translate module, and this file asserts
// that the mapping is EMPTY and stays empty until a new recorded gate decision fills
// it. CP-FR-04 requires the mapping to be stated either way; §3 of
// docs/runbooks/copilot-support.md states the withheld one, and the test below pins
// that no row of it is live.
//
// Writing the adapter anyway would be the one failure this task exists to prevent: an
// unauthorised adapter is worse than a missing one, because it makes a deferred
// harness look supported. So the two `src/plugin/copilot/*.ts` files are deliberately
// absent, and a test asserts they stay absent.
//
// A runbook is a promise, so this suite is what makes it checkable. It asserts seven
// things, each of which fails loudly if a later change quietly crosses the line the
// gate drew:
//
//   1. THE DECISION, AND ITS EVIDENCE. The gate still records deferral, and the two
//      files it bound itself to by SHA-256 still hash to those digests. A regenerated
//      probe report cannot pass quietly against a stale decision.
//   2. NO ADAPTER CODE. There is no src/plugin/copilot, because an unauthorised
//      adapter is worse than a missing one: it would make a deferred harness look
//      supported.
//   3. NO MAPPING. Not one copilot-cli row reaches needs-you or finished. The rows
//      that classify are the two fyi rows, and the two ACP signals stay unresolved.
//   4. THE MISSING-SIGNAL PATH FAILS LOUDLY. A copilot-cli permission request thrown
//      at the real classifier raises a named ClassificationError rather than being
//      classified or dropped, which is the degradation the gate recorded: a signal the
//      product cannot interpret says so instead of going quiet (APX-FR-02).
//   5. ONE HUB PATH. The copilot-cli rows that do classify travel the same classify()
//      and are stored by the same lifecycle, carry the same envelope as opencode,
//      identity is the repository short name for both, and only two domain modules
//      even name the harness, so no Copilot path can bypass classification, pending
//      or delivery (CP-FR-06).
//   6. THE STATES ARE NOT COLLAPSED. Every signal the decision rests on is named in
//      §3 of the record together with the state the probe recorded for it, all three
//      states of the probe's ladder appear there, and `absent` - the one label a
//      black-box probe can never earn - appears as no cell of that table (CP-FR-07).
//   7. THE RUNBOOK SAYS IT. The product's only statement of the gap states the
//      supported surface, the missing signals, the load-bearing reason rather than
//      the incidental one, what would change the decision, and a digest for each of
//      the two evidence files.
//
// Nothing here reads a Copilot session, and nothing here could: there is no adapter to
// produce one. That is the point of the suite.

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HarnessSignal } from '@/domain/classify'
import {
  ClassificationError,
  HARNESS_SIGNAL_TABLE,
  classify,
  deriveDedupeKey,
  repoShortNameFromPath,
} from '@/domain/classify'
import type { NormalizedEvent } from '@/domain/envelope'
import { createPendingLifecycle } from '@/domain/pending'
import { openEventStore, type EventRecord, type EventStore } from '@/storage/eventStore'
import { readModuleImports, repositoryPath, sourceFilesUnderSrc } from '../helpers/read-module'
import { removeTree } from '../helpers/remove-tree'

const RUNBOOK = 'docs/runbooks/copilot-support.md'
const GATE = 'docs/reviews/copilot-gate.json'
const REVIEW = 'docs/reviews/CP-3-console-review.md'
const PROBE_REPORT = 'docs/research/copilot-acp-probe.md'

const read = (relative: string): string => readFileSync(repositoryPath(relative), 'utf8')
const exists = (relative: string): boolean => existsSync(repositoryPath(relative))
const digest = (relative: string): string =>
  createHash('sha256').update(readFileSync(repositoryPath(relative))).digest('hex')

/**
 * Whitespace-collapsed, and stripped of blockquote and list markers, so an assertion
 * is about a sentence rather than about where the author happened to wrap it. The
 * markers are a rendering artefact of the Markdown, not wording: `**No card.**` keeps
 * its asterisks because the line does not start with a bullet, and a phrase that
 * spans two quoted lines reads as the one sentence it is.
 */
const flat = (text: string): string =>
  text
    .replace(/^[ \t]*(?:>|\*|-|\d+\.)[ \t]+/gm, '')
    .replace(/\s+/g, ' ')

const gate = JSON.parse(read(GATE)) as {
  decision: string
  reviewer: string
  evidence: ReadonlyArray<{ path: string; sha256: string }>
}
const review = flat(read(REVIEW))
const runbookRaw = read(RUNBOOK)
const runbook = flat(runbookRaw)

/**
 * §3 of the record on its own, in the raw Markdown rather than the flattened text,
 * because what is asserted there is a pairing: a signal name and the state recorded
 * on the same table row. Flattening would keep the pairing but lose the row, and the
 * row is what makes the assertion about a table rather than about a document.
 */
const missingSignals =
  /## 3\. Which signals were missing[\s\S]*?\n## 4\./.exec(runbookRaw)?.[0] ?? ''

const REPO = '/home/dev/projects/agent-ping'
const SESSION = 'copilot-session-01'
const TRANSITION = 'tr-1'
const TIMESTAMP = '2026-09-27T09:30:00.000Z'

/** A signal with every required field, so a case only states what it varies. */
function signal(over: Pick<HarnessSignal, 'harness' | 'eventName'> & Partial<HarnessSignal>): HarnessSignal {
  return {
    sessionId: SESSION,
    repoFullPath: REPO,
    transitionId: TRANSITION,
    occurredAt: TIMESTAMP,
    receivedAt: TIMESTAMP,
    ...over,
  }
}

describe('the recorded gate decision is deferral, and is still bound to its evidence', () => {
  it('the machine-readable gate records the approved review and names its two evidence files', () => {
    expect(gate.decision).toBe('approved')
    expect(gate.reviewer).not.toBe('')
    expect([...gate.evidence].map((item) => item.path).sort()).toEqual([PROBE_REPORT, REVIEW].sort())
  })

  it('the review it names records deferral, and refuses an adapter and a heuristic alike', () => {
    // The decision in its own heading, then the sentence that carries its scope: an
    // edit that kept the word "deferral" somewhere and reversed the outcome would
    // still pass on `toContain('deferral')` alone, and the whole task hinges on the
    // outcome rather than on the word.
    expect(review).toContain('Decision: **deferral**')
    expect(review).toContain('No Copilot adapter is authorised, and no heuristic is authorised')
  })

  it('both evidence files still hash to the digests the decision bound itself to', () => {
    for (const item of gate.evidence) {
      expect(
        digest(item.path),
        `${item.path} no longer matches the digest in ${GATE}. Re-bind the decision to the new evidence, or record a new decision; a stale decision must not pass as a current one.`,
      ).toBe(item.sha256)
    }
  })
})

describe('no Copilot adapter code ships', () => {
  it('there is no src/plugin/copilot directory, so there is no translate module to load', () => {
    expect(exists('src/plugin/copilot')).toBe(false)
  })

  it('no file under the plugin tree is a Copilot translation, entry point or map', () => {
    // Named by the adapter's own module names, so a partial adapter - a translate
    // table without an entry point, or an entry point without a table - is caught as
    // well as a complete one.
    for (const module of ['plugin/copilot/translate', 'plugin/copilot/index', 'plugin/copilot/']) {
      expect(exists(`src/${module}`), `an unauthorised adapter module shipped at src/${module}`).toBe(false)
    }
  })

  it('no file under the plugin tree mentions Copilot at all', () => {
    const pluginFiles = sourceFilesUnderSrc().filter((file) => file.startsWith('src/plugin/'))
    // Non-empty, so the filter below is not passing because it matched nothing.
    expect(pluginFiles.length).toBeGreaterThan(0)
    const naming = pluginFiles.filter((file) => /copilot/i.test(readModuleImports(file)))
    expect(naming, 'the opencode adapter and transport must carry no Copilot branch').toEqual([])
  })
})

describe('no copilot-cli row reaches a block or a finished event', () => {
  const copilotRows = HARNESS_SIGNAL_TABLE.filter((row) => row.harness === 'copilot-cli')

  it('the table has copilot-cli rows at all, so the assertions below are not vacuous', () => {
    expect(copilotRows.length).toBeGreaterThan(0)
  })

  it('not one of them classifies to needs-you or to finished', () => {
    const offending = copilotRows.flatMap((row) =>
      row.kind === 'classified' && (row.class === 'needs-you' || row.class === 'finished')
        ? [row.eventName]
        : [],
    )
    expect(offending).toEqual([])
  })

  it('the rows that do classify are the two fyi rows, and no other mapping exists', () => {
    const classified = copilotRows.flatMap((row) =>
      row.kind === 'classified' ? [[row.eventName, row.class, row.subtype] as const] : [],
    )
    expect(classified).toEqual([
      ['postToolUse', 'fyi', 'long-tool-call'],
      ['errorOccurred', 'fyi', 'error'],
    ])
  })

  it('the two ACP signals stay unresolved, so each one names the gate that is missing', () => {
    const unresolved = copilotRows.flatMap((row) =>
      row.kind === 'unresolved' ? [[row.eventName, row.blockedBy.length > 0] as const] : [],
    )
    expect(unresolved).toEqual([
      ['session/request_permission', true],
      ['session/update', true],
    ])
  })
})

describe('the missing-signal path fails loudly rather than going quiet', () => {
  const cases = [
    { eventName: 'session/request_permission', label: 'the ACP permission request' },
    { eventName: 'session/update', label: 'the ACP idle-equivalent update' },
  ] as const

  for (const { eventName, label } of cases) {
    it(`${label} raises a named unresolved-signal error instead of producing or dropping an event`, () => {
      // It throws at all, and the thrown thing is this product's own error type.
      expect(() => classify(signal({ harness: 'copilot-cli', eventName }))).toThrow(ClassificationError)

      // Then read what it threw, without a catch that could swallow an assertion's
      // own failure and report it as a classification failure.
      let failure: ClassificationError | undefined
      try {
        classify(signal({ harness: 'copilot-cli', eventName }))
      } catch (thrown) {
        if (thrown instanceof ClassificationError) failure = thrown
        else throw thrown
      }
      expect(failure, `classify() returned for ${eventName}, which the gate left unresolved`).toBeInstanceOf(
        ClassificationError,
      )
      const error = failure as ClassificationError

      // The code says which rule refused, so this is a report rather than a drop.
      expect(error.code).toBe('unresolved-signal')
      // The message names the deferral, so the reason reaches the operator.
      expect(error.message).toMatch(/deferral/i)
      expect(error.message).toMatch(/gate decision/i)

      // It carries the signal's three tokens and nothing else: no session
      // identifier, no path, no payload (APX-FR-01, and the log-path half of it).
      expect(error.signal).toEqual({ harness: 'copilot-cli', eventName, variant: null })
      expect(Object.keys(error.signal)).toHaveLength(3)
      expect(error.message).not.toContain(SESSION)
      expect(error.message).not.toContain(REPO)
    })
  }

  it('an unrecognised Copilot signal is a contract change, not a quiet drop', () => {
    // The neighbouring failure: a name the table has never seen throws too, so a
    // future Copilot release cannot introduce silence by adding a notification.
    expect(() => classify(signal({ harness: 'copilot-cli', eventName: 'session/something_new' }))).toThrow(
      ClassificationError,
    )
    expect(() => classify(signal({ harness: 'copilot-cli', eventName: 'session/something_new' }))).toThrow(
      /no classification for copilot-cli/,
    )
  })
})

describe('a copilot-cli event takes the same hub path as an opencode one', () => {
  // The documented error hook and opencode's session error are the same report
  // arriving from two harnesses, so they are the pair that can show there is one
  // path rather than two.
  const copilotSignal = signal({ harness: 'copilot-cli', eventName: 'errorOccurred' })
  const opencodeSignal = signal({ harness: 'opencode', eventName: 'session.error' })

  // A narrowing helper rather than a shared `Classification` const: a narrowing made
  // inside one `it` does not carry into the next, so the field reads below would not
  // typecheck against a value classified at describe scope.
  const eventOf = (input: HarnessSignal): NormalizedEvent => {
    const result = classify(input)
    if (result.outcome !== 'event') {
      throw new Error(
        `expected ${input.harness} ${input.eventName} to classify to an event, but it was suppressed: ${result.detail}`,
      )
    }
    return result.event
  }

  it('both signals reach an event through the same classify()', () => {
    expect(classify(copilotSignal).outcome).toBe('event')
    expect(classify(opencodeSignal).outcome).toBe('event')
  })

  it('both carry the same class and the same subtype', () => {
    const copilot = eventOf(copilotSignal)
    const opencode = eventOf(opencodeSignal)
    expect(copilot.class).toBe('fyi')
    expect(copilot.class).toBe(opencode.class)
    expect(copilot.subtype).toBe('error')
    expect(copilot.subtype).toBe(opencode.subtype)
  })

  it('the envelope shape is identical, and the dedupe key comes from the one shared derivation', () => {
    const copilot = eventOf(copilotSignal) as unknown as Record<string, unknown>
    const opencode = eventOf(opencodeSignal) as unknown as Record<string, unknown>
    expect(Object.keys(copilot).sort()).toEqual(Object.keys(opencode).sort())
    for (const field of Object.keys(copilot).sort()) {
      // The harness name and the raw event name are the only two things a
      // harness is allowed to differ by, plus the key that namespaces them.
      if (field === 'harness' || field === 'rawEventType' || field === 'dedupeKey') continue
      expect(copilot[field], `field ${field} must not differ between harnesses`).toEqual(opencode[field])
    }
    expect(copilot.harness).toBe('copilot-cli')
    expect(opencode.harness).toBe('opencode')
    expect(copilot.rawEventType).toBe('errorOccurred')
    expect(opencode.rawEventType).toBe('session.error')
    // Both keys are the one exported function's output, with the harness as the
    // namespace, so a Copilot event collapses against a polled one exactly as an
    // opencode event does (OA-FR-07).
    expect(copilot.dedupeKey).toBe(deriveDedupeKey('copilot-cli', SESSION, TRANSITION))
    expect(opencode.dedupeKey).toBe(deriveDedupeKey('opencode', SESSION, TRANSITION))
  })

  it('identity is the repository short name on both, and the full path travels alongside it', () => {
    const copilot = eventOf(copilotSignal)
    const opencode = eventOf(opencodeSignal)
    expect(copilot.repoShortName).toBe('agent-ping')
    expect(copilot.repoShortName).toBe(opencode.repoShortName)
    expect(copilot.repoShortName).toBe(repoShortNameFromPath(REPO))
    expect(copilot.repoFullPath).toBe(REPO)
    // The short name is the label and the path is detail; neither is a key.
    expect(copilot.dedupeKey).not.toContain(REPO)
  })

  it('only the two domain modules name the harness, so no hub, notification or dashboard path can branch on it', () => {
    const scanned = sourceFilesUnderSrc()
    // Non-empty, so the equality below cannot pass because the scan found nothing.
    expect(scanned.length).toBeGreaterThan(0)
    const naming = scanned.filter((file) => readModuleImports(file).includes('copilot-cli'))
    expect(naming).toEqual(['src/domain/classify.ts', 'src/domain/envelope.ts'])
  })
})

describe('the same report from two harnesses is stored by the same hub path', () => {
  // The classify()-only block above proves the envelope. This block closes the
  // "stored" half of the same claim, and it does so by driving the one function the
  // hub's own ingest route drives - `lifecycle.record()` at src/hub/ingest-service.ts
  // - rather than by calling classify() and insertEvent() in a test's own order. If
  // the real path ever grew a harness branch, this stops passing; a test that
  // reproduced the path would keep passing alongside it.
  const openStores: EventStore[] = []
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const store of openStores.splice(0)) store.close()
    for (const directory of temporaryDirectories.splice(0)) removeTree(directory)
  })

  /** The real store and the real lifecycle, over a scratch file, tracked for cleanup. */
  function fixture(name = 'scratch.db'): {
    readonly store: EventStore
    readonly lifecycle: ReturnType<typeof createPendingLifecycle>
  } {
    const directory = mkdtempSync(join(tmpdir(), 'agent-ping-copilot-'))
    temporaryDirectories.push(directory)
    const store = openEventStore({ filePath: join(directory, name) })
    openStores.push(store)
    return { store, lifecycle: createPendingLifecycle(store) }
  }

  /** One signal through the shared ingest path, which is what the hub calls. */
  function record(signal: HarnessSignal): ReturnType<ReturnType<typeof createPendingLifecycle>['record']> {
    return fixture().lifecycle.record(signal)
  }

  /**
   * The stored row, from a result that is a union: four of its six members carry an
   * event and two do not. A helper rather than a non-null assertion, so a result
   * with no row fails the test with the reason it carried instead of reading
   * `undefined` out of a field that was never there.
   */
  function storedRow(
    result: ReturnType<ReturnType<typeof createPendingLifecycle>['record']>,
  ): EventRecord {
    if (!('event' in result)) {
      throw new Error(`expected a stored row, but the path reported "${result.kind}" with none`)
    }
    return result.event
  }

  /** The same two reports as above: one hook from each harness, one shared signal. */
  const pair = {
    copilot: signal({ harness: 'copilot-cli', eventName: 'errorOccurred' }),
    opencode: signal({ harness: 'opencode', eventName: 'session.error' }),
  } as const

  it('both are stored as the same report, and neither is a pending item', () => {
    const { lifecycle } = fixture()
    const copilot = lifecycle.record(pair.copilot)
    const opencode = lifecycle.record(pair.opencode)
    expect(copilot.kind).toBe('event-stored')
    expect(copilot.kind).toBe(opencode.kind)
    // The count is read from the lifecycle rather than off the result, because the
    // result is a union whose members do not all carry one. An fyi report is not a
    // pending item for either harness, so a Copilot fyi can never inflate the tray
    // badge by a route the opencode path does not have.
    expect(lifecycle.pendingCount()).toBe(0)
    expect(lifecycle.readPending()).toEqual([])
  })

  it('the stored rows are identical apart from the harness, its raw name and the key it namespaces', () => {
    const copilot = record(pair.copilot)
    const opencode = record(pair.opencode)
    expect(copilot.kind).toBe('event-stored')
    expect(opencode.kind).toBe('event-stored')
    const stored = { ...storedRow(copilot) } as Record<string, unknown>
    const reference = { ...storedRow(opencode) } as Record<string, unknown>
    expect(Object.keys(stored).sort()).toEqual(Object.keys(reference).sort())
    for (const field of Object.keys(stored).sort()) {
      // The row key and the dedupe key are per-signal identities, and the raw event
      // name is the harness's own. Every other field must be equal, because the
      // events table carries no harness column at all: a stored row cannot be a
      // Copilot row as opposed to an opencode one, so there is nothing for a
      // harness-specific rule to have keyed off.
      if (field === 'rawEventType' || field === 'dedupeKey' || field === 'eventId') continue
      expect(stored[field], `stored field ${field} must not differ between harnesses`).toEqual(reference[field])
    }
    expect(Object.keys(stored)).not.toContain('harness')
    expect(Object.keys(stored)).not.toContain('repoFullPath')
    expect(stored.class).toBe('fyi')
    expect(stored.subtype).toBe('error')
    expect(stored.dedupeKey).toBe(deriveDedupeKey('copilot-cli', SESSION, TRANSITION))
    // Both rows start unacknowledged and unresolved, so the ack and delivery rules
    // see the same initial state whichever harness reported it.
    expect(stored.ackState).toBe(reference.ackState)
    expect(stored.resolutionState).toBe(reference.resolutionState)
  })

  it('a repeated Copilot signal collapses to already-known on the same path, as an opencode one does', () => {
    // The dedupe half of CP-FR-05, demonstrated where it runs: the shared lifecycle,
    // on a real store. A second delivery of one signal must not grow anything.
    const { lifecycle } = fixture('dedupe.db')

    const first = lifecycle.record(pair.copilot)
    const repeat = lifecycle.record(pair.copilot)
    const opencodeFirst = lifecycle.record(pair.opencode)
    const opencodeRepeat = lifecycle.record(pair.opencode)

    expect(first.kind).toBe('event-stored')
    expect(repeat.kind).toBe('already-known')
    expect(opencodeFirst.kind).toBe('event-stored')
    expect(opencodeRepeat.kind).toBe('already-known')
    // The repeat resolved to the row the first delivery stored, not to a new one.
    expect(storedRow(repeat).eventId).toBe(storedRow(first).eventId)
    expect(lifecycle.pendingCount()).toBe(0)
  })

  it('identity reaches the store as the repository short name for both harnesses', () => {
    const { store, lifecycle } = fixture('identity.db')
    lifecycle.record(pair.copilot)
    // A second session, so the read has two rows to compare rather than one.
    lifecycle.record({ ...pair.opencode, sessionId: `${SESSION}-opencode` })

    const summaries = store.readSessionSummaries()
    expect(summaries.length).toBe(2)
    for (const summary of summaries) {
      // The dashboard groups and labels by the short name for a Copilot row exactly
      // as for an opencode one, and the full path rides along as detail (APX-CON-09).
      expect(summary.repoShortName).toBe('agent-ping')
      expect(summary.repoFullPath).toBe(REPO)
      expect(['copilot-cli', 'opencode']).toContain(summary.harness)
    }
    // The same work-signal and session-state derivation, on both rows.
    const states = summaries.map((summary) => [summary.state, summary.workSignal, summary.pendingCount] as const)
    expect(states[0]).toEqual(states[1])
  })
})

describe('every signal the decision rests on is named with the state the probe recorded for it', () => {
  // CP-FR-07 asks for the state the probe recorded, not a paraphrase of it. The gate
  // review words two rows in the probe report's own §10 idiom - "never fired" and
  // "never exercised" - so the record carries both that phrase and the state label
  // from the probe's ladder, and this asserts both are on the row. Asserting the
  // label alone would let a row be summarised into the gate's prose; asserting the
  // prose alone would let a signal be recorded with no state at all.
  const rows = (missingSignals.match(/^\|.*$/gm) ?? []).map((line) =>
    line
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell !== ''),
  )
  // The header and the `---` separator are structure, not claims about a signal.
  const dataRows = rows.filter((cells) => !cells.includes('---') && !cells.includes('Class'))

  /** The one row naming a signal, so a signal recorded twice is a failure, not a pass. */
  const rowNaming = (needle: string): string[] | undefined => {
    const found = dataRows.filter((cells) => cells.some((cell) => cell.includes(needle)))
    expect(found.length, `${needle} is named by ${found.length} rows of §3; a signal is recorded once`).toBe(1)
    return found[0]
  }

  const withheld = [
    {
      label: 'the ACP permission request, the one signal proven real',
      signal: 'session/request_permission',
      states: ['`observed`'],
    },
    { label: 'the prompt-response turn boundary', signal: 'session/prompt', states: ['observed'] },
    { label: 'the agentStop hook boundary', signal: 'agentStop', states: ['`observed`'] },
    { label: 'the documented idle hook type', signal: 'agent_idle', states: ['`unclear`'] },
    {
      label: 'the error, retry and compaction hooks',
      signal: 'errorOccurred',
      states: ['**never fired**', '`not-triggered`'],
    },
    {
      label: 'the quietness gate itself',
      signal: 'idle-after-nothing suppression',
      states: ['**never exercised**', '`not-triggered`'],
    },
  ] as const

  for (const { label, signal, states } of withheld) {
    it(`${label} carries the state the probe recorded for it`, () => {
      const row = rowNaming(signal)
      expect(row, `§3 has no row naming ${signal}`).toBeDefined()
      for (const state of states) {
        expect(
          (row as string[]).join(' | '),
          `the row for ${signal} does not record the state ${state}`,
        ).toContain(state)
      }
    })
  }

  it('all three states of the probe ladder appear, so the ladder is not collapsed into one', () => {
    // The gate rests on signals in three different states, and a record that named
    // them all "missing" would read as one finding rather than three. Absent is the
    // fourth label the ladder defines and the one a black-box probe can never record,
    // so it is asserted as a state cell that does not exist rather than as a word the
    // file may use to explain why.
    for (const state of ['`observed`', '`not-triggered`', '`unclear`']) {
      expect(missingSignals, `§3 never records the state ${state}`).toContain(state)
    }
    const cells = dataRows.flat()
    for (const cell of cells) {
      expect(cell, '§3 records a signal as absent, which no black-box probe can establish').not.toBe('`absent`')
      expect(cell, '§3 records a signal as absent, which no black-box probe can establish').not.toBe('absent')
    }
  })
})

describe('the runbook is the deferral record rather than a note about one', () => {
  it('exists where CP-4 is required to put it', () => {
    expect(exists(RUNBOOK)).toBe(true)
  })

  const claims = [
    { label: 'states the supported surface: opencode only', needle: 'v1 ships opencode only' },
    { label: 'states that Copilot is not supported', needle: 'Copilot CLI is not supported' },
    { label: 'states that no adapter and no heuristic ship', needle: 'there is no adapter, there is no heuristic' },
    { label: 'states what a Copilot developer gets: nothing, and not even a history row', needle: 'un-recorded' },
    { label: 'names the missing signals and the state each one carries', needle: 'Which signals were missing' },
    { label: 'names the never-exercised quietness gate as the load-bearing reason', needle: 'never exercised' },
    {
      label: 'says which row is load-bearing, rather than leaving the reader to rank them',
      needle: 'The load-bearing reason is the last row',
    },
    {
      label: 'rules out the incidental reason by saying the load-bearing one holds anyway',
      needle: 'even if the permission signal were perfect',
    },
    { label: 'records the unclear state rather than calling the idle signal absent', needle: 'unclear' },
    { label: 'states what would have to change to revisit the decision', needle: 'What would have to change to revisit this' },
    {
      label: 'makes revisiting hinge on a per-turn boundary an attaching client receives',
      needle: 'a per-turn boundary an attaching client actually receives',
    },
    {
      label: 'makes revisiting hinge on the work-detection signals actually being exercised',
      needle: 'exercises the work-detection signals',
    },
    { label: 'requires a new recorded gate decision, not a code change', needle: 'recorded gate decision' },
    { label: 'states the missing-signal path is reported rather than silent', needle: 'the degradation is this file' },
    { label: 'does not claim doctor reports the gap, because doctor does not report it', needle: '`doctor` exists and still does not report this gap' },
    { label: 'binds every finding to the probed version', needle: '1.0.88' },
    { label: 'binds itself to its evidence by digest', needle: 'binds its decision to two files by SHA-256' },
    { label: 'names the gate decision it comes from', needle: 'docs/reviews/CP-3-console-review.md' },
    { label: 'says the adapter directory does not exist', needle: '`src/plugin/copilot/` does not exist' },
    {
      label: 'states the stored row carries no harness column, so no stored rule can branch on one',
      needle: 'The `events` table has',
    },
    {
      label: 'names the one ingest call the hub makes, rather than describing the path loosely',
      needle: 'createPendingLifecycle(store).record(signal)',
    },
    {
      label: 'explains why a test named for the translation guards a translation that is absent',
      needle: 'guards a translate module that does not exist',
    },
    {
      label: 'states the withheld mapping is what a future gate would authorise',
      needle: 'the deliverable is **withheld**',
    },
    { label: 'says no source file was changed by this task', needle: 'changed **no** file under `src/`' },
    { label: 'names this suite as what notices a later reversal', needle: 'tests/plugin/copilot-translate.test.ts' },
  ]

  for (const { label, needle } of claims) {
    it(label, () => {
      // Compared with `includes` rather than `toContain`: a failure must not print
      // the whole runbook into the log to say one sentence is missing from it.
      expect(runbook.includes(needle), `${RUNBOOK} does not say: ${needle}`).toBe(true)
    })
  }

  it('says plainly what the runbook does not claim, so silence is not read as a finding', () => {
    expect(runbook).toContain('What this runbook does not claim')
    expect(runbook).toContain('It does not claim Copilot CLI **cannot** support agent-ping')
  })

  it('names a digest for BOTH evidence files the gate bound itself to, not one of them', () => {
    // Driven from the gate rather than from a literal, so a re-bound decision needs
    // no edit here: the record has to carry whatever digests the decision names, and
    // a record citing only the probe report would leave the decision it rests on
    // unbound on its own page.
    for (const item of gate.evidence) {
      expect(runbook, `${RUNBOOK} names no digest for ${item.path}`).toContain(item.sha256.slice(0, 8))
    }
  })
})
