// The classification suite: the mapping table, the idle gate, the dedupe keys
// and the envelope's field set (EL-FR-01, EL-FR-04, EL-FR-05, EL-FR-06,
// EL-FR-07, EL-FR-03, APX-FR-01, ADR-004).
//
//   npm test -- tests/domain/classify.test.ts
//
// Four things are proved here, and the third is the one that matters most:
//
//   1. THE TABLE. Every documented harness event maps to exactly one class, one
//      subtype and one dedupe part, and no event maps to two classes. The
//      expectation table is written out literally below and compared against
//      HARNESS_SIGNAL_TABLE, so the review surface is a list of events and their
//      worth, not a restatement of whatever the implementation happens to do. A
//      row added to the source without an entry here fails, and an entry here
//      without a row fails.
//
//   2. THE GATES. The idle gate (EL-FR-05), one finished event per idle
//      transition (EL-FR-06) and one event per unresolved block (EL-FR-07), with
//      their boundaries asserted at the threshold itself rather than near it.
//
//   3. THE ENVELOPE. Its field set is asserted exactly, three ways, because the
//      claim "agent-ping never stores conversation content" rests on the shape of
//      this type and not on anybody's good intentions:
//        - at compile time, from a `Record<keyof NormalizedEvent, true>` literal,
//          so an added field is a build failure rather than a review remark;
//        - at compile time again, from a conditional type that resolves to
//          `never` the moment a content-shaped name becomes a field;
//        - at runtime, from the key set of a real classified envelope, with a
//          name-shape guard that is itself proven to fail on a content field.
//      A denylist is not enough, and this file says so where a reviewer will
//      read it: a denylist passes the day someone invents `snippet` or `body`,
//      which are the names a well-meant change actually picks.
//
//   4. THE BOUNDARIES. The domain opens no socket, spawns no process, renders no
//      surface, opens no database and reads no clock. That is asserted from the
//      source, because "pure and synchronous" is a property of a file and not of
//      a comment. It also pins the one deliberate coupling: the class and subtype
//      unions are imported from the store as types only, so a plugin inside a
//      harness can build an envelope without loading better-sqlite3.
//
// Nothing here writes to a database, opens a port or waits on a clock. Every
// assertion runs against the pure functions in src/domain.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { EventClass, FyiSubtype, Harness, NormalizedEvent } from '@/domain/envelope'
import { ENVELOPE_FIELDS, KNOWN_HARNESSES } from '@/domain/envelope'
import type {
  Classification,
  HarnessSignal,
  SignalMapping,
  SuppressionReason,
  TurnWorkSignal,
} from '@/domain/classify'
import * as classifyModule from '@/domain/classify'
import {
  ClassificationError,
  HARNESS_SIGNAL_TABLE,
  classify,
  deriveDedupeKey,
  describeSignal,
  repoShortNameFromPath,
  turnDidWork,
} from '@/domain/classify'
import type { NewEvent } from '@/storage/eventStore'

// ---------------------------------------------------------------------------
// The approved envelope field set: the compile-time review surface
// ---------------------------------------------------------------------------

/**
 * Every field of the normalized envelope, written out (EL-FR-01).
 *
 * This literal is the primary guard and it is exact. Adding a field to
 * NormalizedEvent leaves a property missing here, which is a compile error, so a
 * new field cannot reach the schema, the hub payload or the dashboard without a
 * human adding it here and accepting in writing that it cannot hold content. The
 * response to a failing assertion is to decide whether the field is needed, not
 * to widen this list to make the build green.
 */
const ENVELOPE_FIELD_SET: Record<keyof NormalizedEvent, true> = {
  // Which harness produced the event. A name from a closed set.
  harness: true,
  // The harness's own session key.
  sessionId: true,
  // The session directory's basename: the primary label (APX-CON-09).
  repoShortName: true,
  // The session directory, carried for hover detail and never a key (ADR-008).
  repoFullPath: true,
  // The harness's own event name, verbatim.
  rawEventType: true,
  // needs-you | finished | fyi.
  class: true,
  // error | retry | long-tool-call | compaction | token-burn, and only on fyi.
  subtype: true,
  // ISO 8601 UTC: when the signal happened.
  occurredAt: true,
  // ISO 8601 UTC: when the hub received it.
  receivedAt: true,
  // Stable identity: one signal, one event however many times it is delivered.
  dedupeKey: true,
}

/**
 * Names that must never be fields. The second net, not the guard.
 *
 * These are the names that appear in a well-meant change. `rawEventType` is
 * allowed and matches none of them: `raw` needs a word boundary after it, and
 * camelCase has none, while a bare `raw` or `text` field would not be a harness
 * event name.
 */
const CONTENT_FIELD_SHAPES: readonly RegExp[] = [
  /prompt/i,
  /respons/i,
  /\brepl(y|ies)\b/i,
  /messag/i,
  /content/i,
  /\bbod(y|ies)\b/i,
  /snippet/i,
  /excerpt/i,
  /preview/i,
  /summar/i,
  /descript/i,
  /detail/i,
  /\bnote(s)?\b/i,
  /comment/i,
  /output/i,
  /transcript/i,
  /diff/i,
  /patch/i,
  /argument/i,
  /\binput\b/i,
  /\bresult/i,
  /attach/i,
  /blob/i,
  /payload/i,
  /\bdata\b/i,
  /buffer/i,
  /\braw\b/i,
  /\btext\b/i,
  /_(text|body|content|message|summary|prompt|output|excerpt|snippet|note|transcript|diff|patch|preview|reply|response|result|label|title)\b/i,
  /(state|class|subtype|harness|session|repo|dedupe)_(detail|text|note|message|label|title|value|json)/i,
]

function contentFieldViolations(name: string): readonly string[] {
  return CONTENT_FIELD_SHAPES.filter((shape) => shape.test(name)).map((shape) => shape.source)
}

/**
 * The guard, as a pure function over a field-name list, so the tests below can
 * feed it a set the real envelope does not have. That is the only way to prove it
 * fails rather than merely that it passes: a guard that has been edited until it
 * passes has stopped guarding.
 */
function assertContentFreeEnvelopeFields(fields: readonly string[]): void {
  const approved = ENVELOPE_FIELDS
  const extra = fields.filter((field) => !approved.includes(field as (typeof approved)[number]))
  if (extra.length > 0) {
    throw new Error(
      `envelope fields that are not in the approved set: ${extra.join(', ')}. ` +
        'If the field is needed, add it to ENVELOPE_FIELD_SET and to ENVELOPE_FIELDS, and record why it cannot hold content. ' +
        'If the reason is "a feature might need it later", delete it: a field with no writer is a field that can hold content later.',
    )
  }
  const missing = approved.filter((field) => !fields.includes(field))
  if (missing.length > 0) {
    throw new Error(`envelope is missing approved fields: ${missing.join(', ')}`)
  }
  for (const field of fields) {
    const violations = contentFieldViolations(field)
    if (violations.length > 0) {
      throw new Error(`envelope field name ${field} matches a stored-content name shape (${violations.join(', ')})`)
    }
  }
}

/**
 * Resolves to true when any forbidden name is a field of the envelope, so
 * `NO_CONTENT_FIELD_IN_THE_ENVELOPE` below is a compile error the day someone adds
 * one. This is the assertion that survives a synonym the shape list has not been
 * taught: a content field added to the interface cannot satisfy it.
 */
type AnyForbiddenFieldIsPresent<T> = T extends ContentFieldName ? true : false
type ContentFieldName =
  | 'prompt'
  | 'response'
  | 'text'
  | 'content'
  | 'body'
  | 'message'
  | 'output'
  | 'result'
  | 'arguments'
  | 'input'
  | 'payload'
  | 'data'
  | 'snippet'
  | 'excerpt'
  | 'preview'
  | 'summary'
  | 'description'
  | 'transcript'
  | 'diff'
  | 'patch'
  | 'note'
  | 'title'
  | 'label'
  | 'raw'

export const NO_CONTENT_FIELD_IN_THE_ENVELOPE: AnyForbiddenFieldIsPresent<keyof NormalizedEvent> extends true
  ? never
  : true = true

// ---------------------------------------------------------------------------
// The documented harness events, and what each one is worth
// ---------------------------------------------------------------------------

/**
 * Every event name PRD 5 records as delivered.
 *
 * The opencode list is the generic `event` hook's names plus the dedicated
 * permission hook PRD 5 reports as never firing. The copilot-cli list is the six
 * documented hook triggers plus the two ACP notifications the same section names.
 * An event name in the table that is not in one of these lists, or a name in a
 * list with no row, fails: the table cannot quietly grow a signal the product has
 * not been told about.
 */
const DOCUMENTED_EVENT_NAMES: Readonly<Record<Harness, readonly string[]>> = {
  opencode: [
    'message.updated',
    'permission.ask',
    'permission.asked',
    'permission.replied',
    'session.compacted',
    'session.error',
    'session.idle',
    'session.status',
    'todo.updated',
    'tool.execute.after',
    'tool.execute.before',
  ],
  'copilot-cli': [
    'errorOccurred',
    'postToolUse',
    'preToolUse',
    'session/request_permission',
    'session/update',
    'sessionEnd',
    'sessionStart',
    'userPromptSubmitted',
  ],
}

/** What one row must decide. The independent restatement of the table. */
interface ExpectedMapping {
  readonly harness: Harness
  readonly eventName: string
  /** Absent means the row covers any variant of the event name. */
  readonly variant?: string
  readonly outcome: 'event' | 'no-event' | 'unresolved'
  readonly class?: EventClass
  readonly subtype?: FyiSubtype | null
  readonly reason?: SuppressionReason
}

const EXPECTED_MAPPINGS: readonly ExpectedMapping[] = [
  // opencode: the idle transition.
  { harness: 'opencode', eventName: 'session.status', variant: 'idle', outcome: 'event', class: 'finished', subtype: null },
  { harness: 'opencode', eventName: 'session.status', outcome: 'no-event', reason: 'not-a-class-event' },
  { harness: 'opencode', eventName: 'session.idle', outcome: 'event', class: 'finished', subtype: null },
  // opencode: the block.
  { harness: 'opencode', eventName: 'permission.asked', outcome: 'event', class: 'needs-you', subtype: null },
  { harness: 'opencode', eventName: 'permission.ask', outcome: 'no-event', reason: 'not-a-class-event' },
  { harness: 'opencode', eventName: 'permission.replied', outcome: 'no-event', reason: 'block-resolved' },
  // opencode: fyi, one per documented subtype.
  { harness: 'opencode', eventName: 'session.error', outcome: 'event', class: 'fyi', subtype: 'error' },
  { harness: 'opencode', eventName: 'session.compacted', outcome: 'event', class: 'fyi', subtype: 'compaction' },
  { harness: 'opencode', eventName: 'message.updated', outcome: 'event', class: 'fyi', subtype: 'token-burn' },
  { harness: 'opencode', eventName: 'tool.execute.after', outcome: 'event', class: 'fyi', subtype: 'long-tool-call' },
  { harness: 'opencode', eventName: 'todo.updated', outcome: 'event', class: 'fyi', subtype: 'retry' },
  { harness: 'opencode', eventName: 'tool.execute.before', outcome: 'no-event', reason: 'not-a-class-event' },
  // copilot-cli: the documented hooks.
  { harness: 'copilot-cli', eventName: 'sessionStart', outcome: 'no-event', reason: 'not-a-class-event' },
  { harness: 'copilot-cli', eventName: 'sessionEnd', outcome: 'no-event', reason: 'not-a-class-event' },
  { harness: 'copilot-cli', eventName: 'userPromptSubmitted', outcome: 'no-event', reason: 'not-a-class-event' },
  { harness: 'copilot-cli', eventName: 'preToolUse', outcome: 'no-event', reason: 'not-a-class-event' },
  { harness: 'copilot-cli', eventName: 'postToolUse', outcome: 'event', class: 'fyi', subtype: 'long-tool-call' },
  { harness: 'copilot-cli', eventName: 'errorOccurred', outcome: 'event', class: 'fyi', subtype: 'error' },
  // copilot-cli: unresolved upstream, so a named gate rather than a guess.
  { harness: 'copilot-cli', eventName: 'session/request_permission', outcome: 'unresolved' },
  { harness: 'copilot-cli', eventName: 'session/update', outcome: 'unresolved' },
]

// ---------------------------------------------------------------------------
// Signals to classify
// ---------------------------------------------------------------------------

const SESSION_ID = 'ses_01'
const REPO_PATH = '/home/dev/Projects/agent-ping'
const OCCURRED_AT = '2026-09-26T09:00:00.000Z'
const RECEIVED_AT = '2026-09-26T09:00:01.000Z'
const WORKED: TurnWorkSignal = { toolCall: true, fileEdit: false, todoUpdate: false }
const DID_NOTHING: TurnWorkSignal = { toolCall: false, fileEdit: false, todoUpdate: false }

/** A signal with the boring fields filled in, so a case states only what matters. */
function signal(overrides: Partial<HarnessSignal> & Pick<HarnessSignal, 'harness' | 'eventName'>): HarnessSignal {
  return {
    sessionId: SESSION_ID,
    repoFullPath: REPO_PATH,
    occurredAt: OCCURRED_AT,
    receivedAt: RECEIVED_AT,
    ...overrides,
  }
}

/** An idle transition, which is the signal the gate and the dedupe key turn on. */
function idleSignal(overrides: Partial<HarnessSignal> = {}): HarnessSignal {
  return signal({
    harness: 'opencode',
    eventName: 'session.status',
    variant: 'idle',
    transitionId: 'idle-1',
    turnWork: WORKED,
    ...overrides,
  })
}

/** A block, which is the signal per-block deduplication turns on. */
function blockSignal(overrides: Partial<HarnessSignal> = {}): HarnessSignal {
  return signal({ harness: 'opencode', eventName: 'permission.asked', transitionId: 'block-1', ...overrides })
}

/**
 * A signal that satisfies every condition its row imposes, so an assertion about a
 * row is about the mapping rather than about the gate.
 */
function signalSatisfying(row: SignalMapping, transitionId = 'tr-1'): HarnessSignal {
  const work = row.kind === 'classified' && row.condition.kind === 'turn-did-work' ? { turnWork: WORKED } : {}
  const measured =
    row.kind === 'classified' && row.condition.kind === 'at-least'
      ? { measurements: { [row.condition.measurement]: row.condition.atLeast } }
      : {}
  return signal({
    harness: row.harness,
    eventName: row.eventName,
    variant: row.variant,
    transitionId,
    ...work,
    ...measured,
  })
}

function eventOf(classification: Classification): NormalizedEvent {
  if (classification.outcome !== 'event') {
    throw new Error(`expected an event, got no-event (${classification.reason})`)
  }
  return classification.event
}

function suppressionOf(classification: Classification): SuppressionReason {
  if (classification.outcome !== 'no-event') {
    throw new Error(`expected no event, got ${classification.event.class}`)
  }
  return classification.reason
}

function captureError(run: () => unknown): ClassificationError {
  let caught: unknown
  let threw = false
  try {
    run()
  } catch (error) {
    caught = error
    threw = true
  }
  if (!threw) throw new Error('expected a ClassificationError, and nothing was thrown')
  if (!(caught instanceof ClassificationError)) {
    throw new Error(`expected a ClassificationError, got ${String(caught)}`)
  }
  return caught
}

const rowKey = (harness: string, eventName: string, variant?: string): string =>
  `${harness}:${eventName}${variant === undefined ? '' : `#${variant}`}`

// ---------------------------------------------------------------------------
// 1. The mapping table
// ---------------------------------------------------------------------------

describe('the classification table (EL-FR-04)', () => {
  it('maps exactly the documented harness events, with no name invented and none missing', () => {
    for (const harness of KNOWN_HARNESSES) {
      const documented = [...(DOCUMENTED_EVENT_NAMES[harness] ?? [])].sort()
      const inTable = [
        ...new Set(HARNESS_SIGNAL_TABLE.filter((row) => row.harness === harness).map((row) => row.eventName)),
      ].sort()
      expect(inTable, harness).toEqual(documented)
    }
  })

  it('maps no harness event to two classes', () => {
    const seen = new Map<string, string>()
    for (const row of HARNESS_SIGNAL_TABLE) {
      const key = rowKey(row.harness, row.eventName, row.variant)
      expect(seen.has(key), `${key} is mapped twice`).toBe(false)
      seen.set(key, row.kind === 'classified' ? row.class : 'no-event')
    }
    // And no event name may reach two classes through two of its variants, because a
    // caller could then pick the class by choosing the variant. The three loudness
    // classes are the only answers, and an event name answers with one of them or
    // with nothing.
    const names = new Set(HARNESS_SIGNAL_TABLE.map((row) => `${row.harness}:${row.eventName}`))
    for (const name of names) {
      const classes = new Set(
        HARNESS_SIGNAL_TABLE.filter((row) => `${row.harness}:${row.eventName}` === name && row.kind === 'classified')
          .map((row) => (row.kind === 'classified' ? row.class : 'no-event')),
      )
      expect(classes.size, `${name} reaches ${[...classes].join(' and ')}`).toBeLessThanOrEqual(1)
    }
  })

  it('uses the three loudness classes, all three of them, and no fourth', () => {
    const used = new Set(
      HARNESS_SIGNAL_TABLE.filter((row) => row.kind === 'classified').map((row) => (row as { class: string }).class),
    )
    expect([...used].sort()).toEqual(['finished', 'fyi', 'needs-you'])
  })

  it('gives fyi a subtype from the five, and every other class none', () => {
    const subtypes = new Set<string>()
    for (const row of HARNESS_SIGNAL_TABLE) {
      if (row.kind !== 'classified') continue
      if (row.class === 'fyi') {
        expect(row.subtype, `${row.eventName} carries no fyi subtype`).not.toBeNull()
        subtypes.add(row.subtype ?? '')
      } else {
        expect(row.subtype, `${row.eventName} has a subtype on a class that has none`).toBeNull()
      }
    }
    expect([...subtypes].sort()).toEqual(['compaction', 'error', 'long-tool-call', 'retry', 'token-burn'])
  })

  it('records a reason for every suppressed row and a gate for every unresolved row', () => {
    for (const row of HARNESS_SIGNAL_TABLE) {
      expect(row.note.length, `${row.eventName} has no note`).toBeGreaterThan(0)
      expect(row.evidence === 'unresolved', `${row.eventName} evidence disagrees with its kind`).toBe(row.kind === 'unresolved')
      if (row.kind === 'suppressed') {
        expect(row.suppression.detail.length, `${row.eventName} has no recorded detail`).toBeGreaterThan(0)
      }
      if (row.kind === 'unresolved') {
        expect(row.blockedBy.length, `${row.eventName} has no recorded gate`).toBeGreaterThan(0)
      }
      if (row.kind === 'classified') {
        expect(row.dedupePart, `${row.eventName} has no dedupe part`).toBeDefined()
      }
    }
  })

  it('gives every event name that has a variant row an explicit any-variant row', () => {
    const names = new Set(HARNESS_SIGNAL_TABLE.map((row) => `${row.harness}:${row.eventName}`))
    for (const name of names) {
      const rows = HARNESS_SIGNAL_TABLE.filter((row) => `${row.harness}:${row.eventName}` === name)
      const hasVariants = rows.some((row) => row.variant !== undefined)
      if (!hasVariants) continue
      expect(
        rows.some((row) => row.variant === undefined),
        `${name} has a variant row but no any-variant row, so an unknown variant would be unmapped rather than a decision`,
      ).toBe(true)
    }
  })

  it('declares the same dedupe part for both opencode forms of one idle transition', () => {
    const parts = HARNESS_SIGNAL_TABLE.filter(
      (row) => row.kind === 'classified' && (row.eventName === 'session.status' || row.eventName === 'session.idle'),
    ).map((row) => (row.kind === 'classified' ? row.dedupePart : 'other'))
    expect(parts).toEqual(['idle-transition', 'idle-transition'])
  })
})

// ---------------------------------------------------------------------------
// 2. Classification, row by row
// ---------------------------------------------------------------------------

describe('every documented event classifies to its expected class and subtype', () => {
  it.each(
    EXPECTED_MAPPINGS.map((expected) => [rowKey(expected.harness, expected.eventName, expected.variant), expected] as const),
  )('%s', (_key, expected) => {
    const row = HARNESS_SIGNAL_TABLE.find(
      (candidate) =>
        candidate.harness === expected.harness &&
        candidate.eventName === expected.eventName &&
        candidate.variant === expected.variant,
    )
    expect(row, `${expected.eventName} has no row in the table`).toBeDefined()
    if (row === undefined) return

    if (expected.outcome === 'unresolved') {
      expect(row.kind, `${expected.eventName} row kind`).toBe('unresolved')
      const error = captureError(() => classify(signalSatisfying(row)))
      expect(error.code).toBe('unresolved-signal')
      expect(error.message).toContain(expected.eventName)
      return
    }

    const classification = classify(signalSatisfying(row))

    if (expected.outcome === 'no-event') {
      expect(suppressionOf(classification)).toBe(expected.reason)
      return
    }
    const envelope = eventOf(classification)
    expect(envelope.class, `${expected.eventName} class`).toBe(expected.class)
    expect(envelope.subtype, `${expected.eventName} subtype`).toBe(expected.subtype ?? null)
    expect(envelope.harness).toBe(expected.harness)
    // The raw name survives verbatim, so a row can be traced to the signal that
    // produced it and an adapter's translation is checkable.
    expect(envelope.rawEventType).toBe(expected.eventName)
    expect(envelope.dedupeKey).toBe(deriveDedupeKey(expected.harness, SESSION_ID, 'tr-1'))
  })

  it('agrees with the table on the set of rows, so neither can drift from the other', () => {
    const fromTable = HARNESS_SIGNAL_TABLE.map((row) => rowKey(row.harness, row.eventName, row.variant)).sort()
    const fromExpectations = EXPECTED_MAPPINGS.map((row) => rowKey(row.harness, row.eventName, row.variant)).sort()
    expect(fromTable).toEqual(fromExpectations)
  })

  it('throws for an event name no row covers, naming the event and the table', () => {
    const error = captureError(() => classify(signal({ harness: 'opencode', eventName: 'session.teleported' })))
    expect(error.code).toBe('unmapped-signal')
    expect(error.message).toContain('session.teleported')
    expect(error.message).toContain('HARNESS_SIGNAL_TABLE')
  })

  it('throws for an unknown harness rather than inventing a session', () => {
    const error = captureError(() =>
      classify(signal({ harness: 'some-other-agent' as unknown as Harness, eventName: 'session.idle' })),
    )
    expect(error.code).toBe('unknown-harness')
  })

  it('throws when a classifying row reported no transition identity', () => {
    const error = captureError(() => classify(signal({ harness: 'opencode', eventName: 'permission.asked' })))
    expect(error.code).toBe('invalid-signal')
    expect(error.message).toContain('transitionId')
  })
})

// ---------------------------------------------------------------------------
// 3. The idle gate
// ---------------------------------------------------------------------------

describe('the idle gate (EL-FR-05, EL-FR-06)', () => {
  it('produces no event at all for a turn with no tool call, no file edit and no todo update', () => {
    const classification = classify(idleSignal({ turnWork: DID_NOTHING }))
    expect(classification.outcome).toBe('no-event')
    expect(suppressionOf(classification)).toBe('idle-after-nothing')
    // No event, not a quiet event: there is no envelope to store, which is what
    // keeps a greeting-and-close out of the history and off the screen.
    expect('event' in classification).toBe(false)
  })

  it.each([
    ['a tool call', { toolCall: true, fileEdit: false, todoUpdate: false }],
    ['a file edit', { toolCall: false, fileEdit: true, todoUpdate: false }],
    ['a todo update', { toolCall: false, fileEdit: false, todoUpdate: true }],
  ])('produces exactly one finished event for a turn with %s', (_measure, turnWork) => {
    const classification = classify(idleSignal({ turnWork }))
    const envelope = eventOf(classification)
    expect(envelope.class).toBe('finished')
    expect(envelope.subtype).toBeNull()
  })

  it('names the missing capability rather than guessing the gate', () => {
    const classification = classify(idleSignal({ turnWork: undefined }))
    expect(suppressionOf(classification)).toBe('work-signal-unavailable')
    // Silence is the safe reading, and the absence is still reportable: a caller
    // can tell "nothing happened" from "this harness cannot say".
    expect(classification.outcome).not.toBe('event')
  })

  it('carries no work across signals, so a later empty turn is not credited with earlier work', () => {
    // The adapter resets its accumulator at the turn boundary; the classifier holds
    // no state, so the only way the second turn could inherit the first turn's work
    // is if this module remembered something. It must not.
    const worked = eventOf(classify(idleSignal({ transitionId: 'idle-1', turnWork: WORKED })))
    const empty = classify(idleSignal({ transitionId: 'idle-2', turnWork: DID_NOTHING }))
    expect(worked.class).toBe('finished')
    expect(suppressionOf(empty)).toBe('idle-after-nothing')
    expect(suppressionOf(classify(idleSignal({ transitionId: 'idle-3', turnWork: undefined })))).toBe(
      'work-signal-unavailable',
    )
  })

  it('produces one finished event per idle transition and stays silent until the session resumes', () => {
    const first = eventOf(classify(idleSignal({ transitionId: 'idle-1' })))
    // The same transition delivered twice is one transition: the modern status and
    // the deprecated event collapse to one key, and a repeat collapses to it too.
    const repeated = eventOf(
      classify(signal({ harness: 'opencode', eventName: 'session.idle', transitionId: 'idle-1', turnWork: WORKED })),
    )
    // The session resuming is not an event, and the next idle transition is.
    const resumed = classify(
      signal({ harness: 'opencode', eventName: 'session.status', variant: 'busy', transitionId: 'busy-1', turnWork: WORKED }),
    )
    const second = eventOf(classify(idleSignal({ transitionId: 'idle-2' })))

    expect(repeated.dedupeKey).toBe(first.dedupeKey)
    expect(suppressionOf(resumed)).toBe('not-a-class-event')
    expect(second.dedupeKey).not.toBe(first.dedupeKey)
    expect(new Set([first.dedupeKey, second.dedupeKey]).size).toBe(2)
  })

  it('produces no finished event for a turn with no work, whatever the elapsed time', () => {
    // The gate is a rule and not a threshold: a greeting-and-close that took an
    // hour is still a greeting-and-close.
    const classification = classify(
      idleSignal({ turnWork: DID_NOTHING, measurements: { durationMs: 3_600_000 }, occurredAt: '2026-09-26T10:00:00.000Z' }),
    )
    expect(suppressionOf(classification)).toBe('idle-after-nothing')
  })
})

// ---------------------------------------------------------------------------
// 4. Dedupe
// ---------------------------------------------------------------------------

describe('dedupe keys (EL-FR-06, EL-FR-07)', () => {
  it('gives a repeated permission ask for one block one key', () => {
    const first = eventOf(classify(blockSignal({ transitionId: 'block-1' })))
    const second = eventOf(classify(blockSignal({ transitionId: 'block-1' })))
    expect(second.dedupeKey).toBe(first.dedupeKey)
    expect(second.class).toBe('needs-you')
    expect(second.subtype).toBeNull()
  })

  it('gives two blocks in one session two keys, and one block in two sessions two keys', () => {
    const blockA = eventOf(classify(blockSignal({ transitionId: 'block-1' })))
    const blockB = eventOf(classify(blockSignal({ transitionId: 'block-2' })))
    const otherSession = eventOf(classify(blockSignal({ transitionId: 'block-1', sessionId: 'ses_02' })))
    expect(new Set([blockA.dedupeKey, blockB.dedupeKey, otherSession.dedupeKey]).size).toBe(3)
  })

  it('derives the key from identity only, so a replay stores nothing new', () => {
    // A key containing a receive timestamp or an occurrence timestamp changes on
    // every replay and defeats the mechanism entirely (HC-FR-08).
    const first = eventOf(classify(blockSignal({ occurredAt: OCCURRED_AT, receivedAt: RECEIVED_AT })))
    const replayed = eventOf(
      classify(blockSignal({ occurredAt: '2026-09-26T09:00:00.000Z', receivedAt: '2026-09-26T23:59:59.000Z' })),
    )
    const later = eventOf(
      classify(blockSignal({ occurredAt: '2026-09-27T09:00:00.000Z', receivedAt: '2026-09-27T09:00:00.000Z' })),
    )
    expect(replayed.dedupeKey).toBe(first.dedupeKey)
    expect(later.dedupeKey).toBe(first.dedupeKey)
    expect(first.dedupeKey).toBe(`opencode:${SESSION_ID}:block-1`)
    for (const stamp of [OCCURRED_AT, RECEIVED_AT]) expect(first.dedupeKey).not.toContain(stamp)
  })

  it('is the shared derivation, so a pushed and a polled signal collapse', () => {
    // The polling fallback calls the same function (OA-FR-07). A second derivation
    // is a duplicate-event bug waiting for a session that both pushes and is polled.
    expect(deriveDedupeKey('opencode', 'ses_07', 'idle-9')).toBe('opencode:ses_07:idle-9')
    const pushed = eventOf(classify(idleSignal({ sessionId: 'ses_07', transitionId: 'idle-9' })))
    const polled = eventOf(
      classify(signal({ harness: 'opencode', eventName: 'session.idle', sessionId: 'ses_07', transitionId: 'idle-9', turnWork: WORKED })),
    )
    expect(polled.dedupeKey).toBe(pushed.dedupeKey)
  })

  it('gives every classified event a key of harness, session and transition identity', () => {
    for (const row of HARNESS_SIGNAL_TABLE) {
      if (row.kind !== 'classified') continue
      const envelope = eventOf(classify(signalSatisfying(row, `tr-${row.eventName}`)))
      expect(envelope.dedupeKey, `${row.eventName}`).toBe(`${row.harness}:${SESSION_ID}:tr-${row.eventName}`)
    }
  })
})

// ---------------------------------------------------------------------------
// 5. Thresholds
// ---------------------------------------------------------------------------

describe('threshold rows (EL-FR-04)', () => {
  const thresholdRows = HARNESS_SIGNAL_TABLE.filter(
    (row) => row.kind === 'classified' && row.condition.kind === 'at-least',
  )

  it('gates every fyi subtype that describes a magnitude, and only those', () => {
    // An error is an error however long it took, and a compaction is a compaction
    // whatever its size: neither has a magnitude, so neither needs a threshold. The
    // other three subtypes describe a magnitude, so each is a threshold row, because
    // an ungated one would fire on every signal and become exactly the per-subtask
    // noise ADR-004 rules out.
    const gated = new Set(thresholdRows.map((row) => (row.kind === 'classified' ? row.subtype : null)))
    expect([...gated].sort()).toEqual(['long-tool-call', 'retry', 'token-burn'])
    const ungated = [
      ...new Set(
        HARNESS_SIGNAL_TABLE.filter((row) => row.kind === 'classified' && row.class === 'fyi' && row.condition.kind === 'always')
          .map((row) => (row.kind === 'classified' ? row.subtype : null)),
      ),
    ]
    expect(ungated.sort()).toEqual(['compaction', 'error'])
  })

  it.each(
    thresholdRows.map((row) => [row.harness, row.eventName, row] as const),
  )('%s %s reports nothing one step below the threshold and the event at it', (harness, eventName, row) => {
    if (row.kind !== 'classified' || row.condition.kind !== 'at-least') {
      throw new Error('expected a threshold row')
    }
    const condition = row.condition
    const below = classify(
      signal({
        harness,
        eventName,
        transitionId: 'tr-1',
        measurements: { [condition.measurement]: condition.atLeast - 1 },
      }),
    )
    expect(suppressionOf(below)).toBe('below-threshold')

    const at = eventOf(
      classify(
        signal({
          harness,
          eventName,
          transitionId: 'tr-1',
          measurements: { [condition.measurement]: condition.atLeast },
        }),
      ),
    )
    expect(at.class).toBe('fyi')
    expect(at.subtype).not.toBeNull()
  })

  it.each(thresholdRows.map((row) => [row.harness, row.eventName] as const))(
    '%s %s never invents a subtype when the harness reports no measurement',
    (harness, eventName) => {
      const classification = classify(
        signal({ harness, eventName, transitionId: 'tr-1', measurements: {} }),
      )
      expect(suppressionOf(classification)).toBe('measurement-unavailable')
    },
  )

  it('never lets a measurement reach the envelope, because a count that grows with what was said is a transcript', () => {
    const envelope = eventOf(
      classify(
        signal({
          harness: 'opencode',
          eventName: 'tool.execute.after',
          transitionId: 'tr-1',
          measurements: { durationMs: 987_654 },
        }),
      ),
    )
    expect(JSON.stringify(envelope)).not.toContain('987654')
    expect(Object.keys(envelope)).not.toContain('measurements')
    expect(Object.keys(envelope)).not.toContain('tokensUsed')
  })
})

// ---------------------------------------------------------------------------
// 6. The envelope
// ---------------------------------------------------------------------------

describe('the normalized envelope is content-free (EL-FR-01, EL-FR-03)', () => {
  it('has exactly the approved fields, in the documented order', () => {
    expect(ENVELOPE_FIELDS).toEqual([
      'harness',
      'sessionId',
      'repoShortName',
      'repoFullPath',
      'rawEventType',
      'class',
      'subtype',
      'occurredAt',
      'receivedAt',
      'dedupeKey',
    ])
  })

  it('has no field name that suggests stored content', () => {
    expect(() => assertContentFreeEnvelopeFields(ENVELOPE_FIELDS)).not.toThrow()
    for (const field of ENVELOPE_FIELDS) {
      expect(contentFieldViolations(field), field).toEqual([])
    }
  })

  it('carries exactly the approved keys on a real classified event', () => {
    const envelope = eventOf(classify(blockSignal()))
    expect(Object.keys(envelope).sort()).toEqual([...ENVELOPE_FIELDS].sort())
    expect(() => assertContentFreeEnvelopeFields(Object.keys(envelope))).not.toThrow()
    // One event of every class, because a field could be conditional per class.
    const classes = HARNESS_SIGNAL_TABLE.filter((row) => row.kind === 'classified')
    const byClass = new Map<string, NormalizedEvent>()
    for (const row of classes) {
      const envelope = eventOf(classify(signalSatisfying(row)))
      expect(Object.keys(envelope).sort(), `${row.eventName}`).toEqual([...ENVELOPE_FIELDS].sort())
      byClass.set(envelope.class, envelope)
    }
    expect([...byClass.keys()].sort()).toEqual(['finished', 'fyi', 'needs-you'])
  })

  it('rejects a content-bearing field name, and the guard is proven to fail rather than assumed to', () => {
    const invented = ['prompt', 'response', 'toolOutput', 'fileContent', 'excerpt', 'body', 'payload', 'lastMessage']
    for (const name of invented) {
      expect(contentFieldViolations(name), name).not.toEqual([])
      expect(() => assertContentFreeEnvelopeFields([...ENVELOPE_FIELDS, name]), name).toThrow(new RegExp(name))
    }
    // And the exact set rejects a field whose name is perfectly clean, which is
    // what a denylist on its own would not do.
    expect(() => assertContentFreeEnvelopeFields([...ENVELOPE_FIELDS, 'tokenTotal'])).toThrow(/tokenTotal/)
    expect(() => assertContentFreeEnvelopeFields(ENVELOPE_FIELDS.filter((field) => field !== 'dedupeKey'))).toThrow(
      /dedupeKey/,
    )
  })

  it('rejects a content-bearing field at the type level too, which is the guard that cannot be edited away quietly', () => {
    // The approved set is a compile-time guard in both directions, and these two
    // directives are how it is proven rather than assumed. If either error ever
    // stops happening, the directive becomes unused and this file fails to compile
    // - the same "the guard is proven to fail" discipline the schema test uses for
    // a real ALTER TABLE.
    //
    // @ts-expect-error a field added to the envelope leaves the approved set incomplete
    const incomplete: Record<keyof NormalizedEvent, true> = { harness: true }
    expect(Object.keys(incomplete)).toEqual(['harness'])

    // @ts-expect-error a content field is not on the envelope type at all
    expect(({} as Record<keyof NormalizedEvent, true>).prompt).toBeUndefined()

    // And for a name the shape list has not been taught, at the type level.
    const narrowed: AnyForbiddenFieldIsPresent<keyof NormalizedEvent> = false
    expect(narrowed).toBe(false)
  })

  it('has the same fields in the approved set and the runtime list, so neither can drift', () => {
    expect([...ENVELOPE_FIELDS].sort()).toEqual(Object.keys(ENVELOPE_FIELD_SET).sort())
    expect(() => assertContentFreeEnvelopeFields(Object.keys(ENVELOPE_FIELD_SET))).not.toThrow()
  })

  it('is the store insert shape as it stands, so ingest passes a classified envelope through unchanged', () => {
    const envelope = eventOf(classify(blockSignal()))
    const insertShape: NewEvent = envelope
    expect(Object.keys(insertShape).sort()).toEqual([...ENVELOPE_FIELDS].sort())
  })

  it('derives the repository short name from the session directory, and fails on a path with none', () => {
    expect(repoShortNameFromPath('/home/dev/Projects/agent-ping')).toBe('agent-ping')
    expect(repoShortNameFromPath('/home/dev/Projects/agent-ping/')).toBe('agent-ping')
    expect(repoShortNameFromPath('C:\\Users\\dev\\Projects\\agent-ping')).toBe('agent-ping')
    expect(repoShortNameFromPath('agent-ping')).toBe('agent-ping')
    const error = captureError(() => repoShortNameFromPath('/'))
    expect(error.code).toBe('invalid-signal')
  })

  it('derives the short name once, so an adapter cannot label a row with the full path', () => {
    const envelope = eventOf(classify(blockSignal({ repoFullPath: '/home/dev/Projects/other-repo' })))
    expect(envelope.repoShortName).toBe('other-repo')
    expect(envelope.repoFullPath).toBe('/home/dev/Projects/other-repo')
  })
})

// ---------------------------------------------------------------------------
// 7. Identity, determinism and the failure path
// ---------------------------------------------------------------------------

describe('determinism and the failure path (APX-FR-02, APX-CON-10)', () => {
  it('is deterministic: the same signal classifies to the same answer, synchronously', () => {
    const first = classify(blockSignal())
    const second = classify(blockSignal())
    expect(first).toEqual(second)
    expect(first).not.toBeInstanceOf(Promise)
  })

  it('reads no clock, so a replay cannot change what it decides', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/domain/classify.ts', import.meta.url)), 'utf8')
    for (const forbidden of ['new Date', 'Date.now', 'Math.random', 'process.hrtime']) {
      expect(source.includes(forbidden), `src/domain/classify.ts reads ${forbidden}`).toBe(false)
    }
  })

  it('refuses a multi-line or unbounded identifier, without echoing it anywhere', () => {
    // A failure message is written to a log or shown as a breadcrumb in the
    // harness's own interface (OA-FR-05, APX-CON-12), so a rejected identifier may
    // be a pasted prompt and the message must quote none of it.
    //
    // What this guard is and is not: it refuses a multi-line value and an
    // unbounded one, because a path, a session key and an event name are all
    // single-line short tokens and a pasted prompt is the obvious accident. A
    // single-line prompt still passes it, which is why the envelope's exact field
    // set - not this - is the privacy guard.
    const pastedPrompt = 'please look at the failing diff in my prompt\n\nand then continue from there'
    const unbounded = 'x'.repeat(600)
    for (const rejected of [pastedPrompt, unbounded]) {
      for (const overrides of [{ sessionId: rejected }, { repoFullPath: rejected }, { transitionId: rejected }]) {
        const error = captureError(() =>
          classify(signal({ harness: 'opencode', eventName: 'permission.asked', ...overrides })),
        )
        expect(error.code, 'a rejected identifier is an invalid signal').toBe('invalid-signal')
        expect(error.message).not.toContain(rejected)
        expect(error.stack ?? '').not.toContain(rejected)
        expect(JSON.stringify(error.signal)).not.toContain(rejected)
      }
    }
    // The harness is bounded on the same path, because an unknown harness is the
    // one case whose value the failure message quotes.
    for (const rejected of [pastedPrompt, unbounded]) {
      const error = captureError(() =>
        classify(signal({ harness: rejected as unknown as Harness, eventName: 'session.idle' })),
      )
      expect(error.code).toBe('invalid-signal')
      expect(error.message).not.toContain(rejected)
    }
    // A timestamp is held to the same rule, and a malformed one may be any text.
    const error = captureError(() => classify(blockSignal({ occurredAt: pastedPrompt })))
    expect(error.code).toBe('invalid-signal')
    expect(error.message).not.toContain(pastedPrompt)
  })

  it('describes a signal by three tokens, so a breadcrumb can carry service, session and event type only', () => {
    const ref = describeSignal(signal({ harness: 'opencode', eventName: 'session.idle', variant: 'busy' }))
    expect(Object.keys(ref).sort()).toEqual(['eventName', 'harness', 'variant'])
    expect(ref).toEqual({ harness: 'opencode', eventName: 'session.idle', variant: 'busy' })
    const withoutVariant = describeSignal(blockSignal({ sessionId: SESSION_ID, repoFullPath: REPO_PATH }))
    expect(withoutVariant.variant).toBeNull()
    // The error carries the reference and nothing else from the signal.
    const error = captureError(() => classify(signal({ harness: 'opencode', eventName: 'session.teleported' })))
    expect(Object.keys(error).sort()).toEqual(['code', 'name', 'signal'])
    expect(error.signal).toEqual({ harness: 'opencode', eventName: 'session.teleported', variant: null })
    expect(JSON.stringify(error.signal)).not.toContain(SESSION_ID)
    expect(JSON.stringify(error.signal)).not.toContain(REPO_PATH)
  })

  it('rejects a measurement that is not a finite number, rather than comparing with it', () => {
    const error = captureError(() =>
      classify(
        signal({
          harness: 'opencode',
          eventName: 'tool.execute.after',
          transitionId: 'tr-1',
          measurements: { durationMs: Number.NaN },
        }),
      ),
    )
    expect(error.code).toBe('invalid-signal')
  })

  it('requires an ISO 8601 UTC timestamp, because the log orders timestamps as text', () => {
    for (const stamp of ['2026-09-26T09:00:00Z', '2026-09-26 09:00:00.000Z', '2026-13-26T09:00:00.000Z', '']) {
      const error = captureError(() => classify(blockSignal({ occurredAt: stamp })))
      expect(error.code, stamp).toBe('invalid-signal')
    }
    expect(() => classify(blockSignal({ occurredAt: OCCURRED_AT, receivedAt: RECEIVED_AT }))).not.toThrow()
  })

  it('reads the work signal as three booleans and nothing else', () => {
    expect(turnDidWork(DID_NOTHING)).toBe(false)
    expect(turnDidWork(WORKED)).toBe(true)
    expect(turnDidWork({ toolCall: false, fileEdit: true, todoUpdate: false })).toBe(true)
    expect(turnDidWork({ toolCall: false, fileEdit: false, todoUpdate: true })).toBe(true)
    const error = captureError(() =>
      classify(
        idleSignal({ turnWork: { toolCall: 3, fileEdit: 0, todoUpdate: 0 } as unknown as HarnessSignal['turnWork'] }),
      ),
    )
    expect(error.code).toBe('invalid-signal')
  })
})

// ---------------------------------------------------------------------------
// 8. The module's own boundaries
// ---------------------------------------------------------------------------

describe('the domain module opens nothing (EL-3 boundaries, APX-CON-12)', () => {
  const domainDir = fileURLToPath(new URL('../../src/domain/', import.meta.url))
  const sourceOf = (name: string): string => readFileSync(`${domainDir}${name}`, 'utf8')
  const modules = readdirSync(domainDir).filter((name) => name.endsWith('.ts')).sort()

  const specifiersOf = (source: string): readonly string[] =>
    [
      ...[...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1] ?? ''),
      ...[...source.matchAll(/^\s*import\s+'([^']+)'/gm)].map((match) => match[1] ?? ''),
    ].filter((specifier) => specifier.length > 0)

  it('is only the two modules this task owns', () => {
    expect(modules).toEqual(['classify.ts', 'envelope.ts'])
  })

  it.each(modules)('%s imports nothing that could open a socket, a process, a surface or a database', (name) => {
    const source = sourceOf(name)
    for (const specifier of specifiersOf(source)) {
      for (const forbidden of [
        'node:fs',
        'node:net',
        'node:http',
        'node:https',
        'node:child_process',
        'node:worker_threads',
        'node:dgram',
        'node:os',
        'better-sqlite3',
        'electron',
        'pixi',
        'zod',
      ]) {
        expect(specifier.includes(forbidden), `${name} imports ${specifier}`).toBe(false)
      }
    }
  })

  it('reaches the store through a type-only import, so nothing here loads a database driver', () => {
    const envelopeSource = sourceOf('envelope.ts')
    const storeStatements = [
      ...envelopeSource.matchAll(/^\s*(?:import|export)[^\n]*storage\/eventStore[^\n]*$/gm),
    ].map((match) => match[0])
    expect(storeStatements.length).toBeGreaterThan(0)
    for (const statement of storeStatements) {
      expect(statement.trim().startsWith('import type') || statement.trim().startsWith('export type')).toBe(true)
    }
    // No value import at all, so the erasure is total.
    const valueImports = envelopeSource.split('\n').filter((line) => /^\s*import\s+(?!type\b)/.test(line))
    expect(valueImports).toEqual([])
    // classify.ts never mentions the store: the domain vocabulary flows one way.
    const classifySpecifiers = specifiersOf(sourceOf('classify.ts'))
    expect(classifySpecifiers.length).toBeGreaterThan(0)
    for (const specifier of classifySpecifiers) expect(specifier).toBe('./envelope.js')
    expect(sourceOf('classify.ts')).not.toContain('storage/')
  })

  it('exposes exactly the classification surface, so the API cannot be widened by a new export', () => {
    expect(Object.keys(classifyModule).sort()).toEqual([
      'ClassificationError',
      'HARNESS_SIGNAL_TABLE',
      'classify',
      'deriveDedupeKey',
      'describeSignal',
      'repoShortNameFromPath',
      'turnDidWork',
    ])
  })
})
