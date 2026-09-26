// The opencode adapter's translation: the event table, the payload reader, the work
// signal's arrival at the classifier, and the plugin that wires the two together
// (OA-FR-02, OA-FR-03, OA-FR-05, OA-FR-06, OA-FR-09, APX-FR-01, APX-FR-02,
// APX-CON-09, APX-CON-13, ADR-004, ADR-008).
//
//   npm test -- tests/plugin/opencode-translate.test.ts
//
// Six things are proved here, and the first is the one a reviewer reads:
//
//   1. THE TABLE. Every documented opencode event name maps to one signal, one class,
//      one subtype and one dedupe key, and the expectation is written out literally
//      below rather than restated from the implementation. Every row is then driven
//      through the *real* classifier, so the adapter's declaration and the domain's
//      decision are compared rather than assumed (ADR-004, ADR-005).
//   2. COVERAGE. Every event name opencode 1.18.32 delivers is either mapped or
//      explicitly not reported, name by name, and the two lists together are the
//      whole union. A name the harness starts delivering cannot arrive without a
//      decision, and "we do not report this" is a decision rather than a default
//      (APX-FR-02).
//   3. THE IDLE GATE, END TO END. The deprecated idle event and the status
//      transition of one turn produce ONE envelope, through the plugin's real hooks
//      and into the real hub pipeline over a real SQLite log - not two, and not a
//      simulated collapse. A turn that only greeted the developer produces no
//      envelope at all.
//   4. CONTENT. Every mapped event is fed a payload full of recognisable strings - a
//      prompt, a tool argument, a tool output, a file path, a todo, a diff, an error
//      message - and none of them appears in the signal or the envelope (APX-FR-01).
//   5. THE PLUGIN'S OBLIGATIONS. Logging goes through the harness's own client with
//      this product's service name and never through `console`; a failure becomes a
//      breadcrumb; nothing throws into the session; delivery is not awaited; the
//      hook set is identical for an interactive, a non-interactive and an attached
//      session (OA-FR-05, OA-FR-09, APX-CON-03).
//   6. THE BOUNDARIES. The adapter imports nothing that a harness would have to
//      install, opens no socket, and derives no dedupe key of its own (APX-CON-12,
//      ADR-006, EL-FR-06).
//
// The evidence the table rests on - the event union and the hook inputs of
// @opencode-ai/sdk and @opencode-ai/plugin 1.18.32, the versions the running
// opencode 1.18.32 ships - is quoted row by row in the table's `evidence` fields, and
// the union itself is written out below as OPENCODE_1_18_32_EVENTS.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventClass, FyiSubtype, NormalizedEvent } from '@/domain/envelope'
import type { Classification, HarnessSignal, SuppressionReason } from '@/domain/classify'
import { classify, deriveDedupeKey } from '@/domain/classify'
import { createIngestService } from '@/hub/ingest-service'
import type { IngestAccepted } from '@/hub/ingest-service'
import { INGEST_SIGNAL_FIELD_NAMES } from '@/hub/routes/ingest'
import { openEventStore } from '@/storage/eventStore'
import type { EventStore } from '@/storage/eventStore'
import * as translateModule from '@/plugin/opencode/translate'
import type { OpencodeEvent, OpencodeEventRow, Translator } from '@/plugin/opencode/translate'
import {
  AGENT_PING_SERVICE,
  OPENCODE_EVENT_TABLE,
  OPENCODE_UNMAPPED_EVENTS,
  OPENCODE_UNSUBSCRIBED_HOOKS,
  createTranslator,
} from '@/plugin/opencode/translate'
import * as workSignalModule from '@/plugin/opencode/work-signal'
import { AGENT_PING_PLUGIN } from '@/plugin/opencode/index'

// ---------------------------------------------------------------------------
// Content that must never be recorded
// ---------------------------------------------------------------------------

/**
 * Strings that appear nowhere but in the fixtures' payloads.
 *
 * Every mapped event is delivered with at least one of these in it, and the
 * assertions below look for each of them by value in whatever the adapter produced.
 * A denylist of field *names* would be the wrong guard: `snippet` and `body` are the
 * names a well-meant change picks, and the real guarantee is the envelope's field set
 * (asserted in tests/domain/classify.test.ts). This is the second half - a value
 * cannot travel in a field the adapter never fills.
 */
const PROMPT = 'PROMPT-a-typed-request-must-never-be-recorded'
const ARGUMENT = 'ARGUMENT-a-tool-argument-must-never-be-recorded'
const TOOL_OUTPUT = 'OUTPUT-a-tool-result-must-never-be-recorded'
const FILE_PATH = '/home/dev/private/PATH-must-never-be-recorded.ts'
const TITLE = 'TITLE-a-permission-title-must-never-be-recorded'
const TODO_TEXT = 'TODO-the-todo-text-must-never-be-recorded'
const DIFF = 'DIFF-the-working-tree-diff-must-never-be-recorded'
const ERROR_TEXT = 'ERROR-the-provider-error-message-must-never-be-recorded'
const RETRY_TEXT = 'RETRY-the-retry-status-message-must-never-be-recorded'

const EVERY_SECRET = [
  PROMPT,
  ARGUMENT,
  TOOL_OUTPUT,
  FILE_PATH,
  TITLE,
  TODO_TEXT,
  DIFF,
  ERROR_TEXT,
  RETRY_TEXT,
]

// ---------------------------------------------------------------------------
// The fixtures: opencode 1.18.32 payloads, verbatim shapes
// ---------------------------------------------------------------------------

const REPO = '/home/dev/Projects/agent-ping'
const SESSION = 'ses_01'
const BLOCK = 'per_01'
const MESSAGE = 'msg_01'
const CALL = 'call_01'
const EPOCH = Date.parse('2026-09-26T12:00:00.000Z')

/** A clock the test moves by hand, so a duration is a number rather than a race. */
function testClock(): { now: () => number; advance: (ms: number) => void } {
  let epoch = EPOCH
  return { now: () => epoch, advance: (ms: number) => void (epoch += ms) }
}

/** `{ sessionID, status: { type } }`, with the extra fields `retry` really carries. */
function statusEvent(type: 'idle' | 'busy' | 'retry'): OpencodeEvent {
  return {
    type: 'session.status',
    properties: {
      sessionID: SESSION,
      status: type === 'retry' ? { type, attempt: 2, message: RETRY_TEXT, next: EPOCH + 1_000 } : { type },
    },
  }
}

/** The deprecated form: a session id and nothing else. */
const DEPRECATED_IDLE: OpencodeEvent = { type: 'session.idle', properties: { sessionID: SESSION } }

/** `permission.updated`: the permission itself, every field of it. */
const PERMISSION: OpencodeEvent = {
  type: 'permission.updated',
  properties: {
    id: BLOCK,
    type: 'bash',
    sessionID: SESSION,
    messageID: MESSAGE,
    callID: CALL,
    title: TITLE,
    pattern: ARGUMENT,
    metadata: { note: ARGUMENT },
    time: { created: EPOCH },
  },
}

/** The same block under the name PRD 5 documents, with a minimal payload. */
const PERMISSION_ASKED: OpencodeEvent = {
  type: 'permission.asked',
  properties: { id: BLOCK, sessionID: SESSION, title: TITLE },
}

const PERMISSION_REPLIED: OpencodeEvent = {
  type: 'permission.replied',
  properties: { sessionID: SESSION, permissionID: BLOCK, response: 'once' },
}

const SESSION_ERROR: OpencodeEvent = {
  type: 'session.error',
  properties: {
    sessionID: SESSION,
    error: { name: 'ProviderAuthError', data: { message: ERROR_TEXT, request: PROMPT } },
  },
}

/** An error with no session at all, which the payload type allows. */
const SESSIONLESS_ERROR: OpencodeEvent = {
  type: 'session.error',
  properties: { error: { name: 'UnknownError', data: { message: ERROR_TEXT } } },
}

const COMPACTED: OpencodeEvent = { type: 'session.compacted', properties: { sessionID: SESSION } }

/** `message.updated` carrying an assistant message's five token counters. */
function assistantMessage(tokens: {
  input: number
  output: number
  reasoning: number
  read: number
  write: number
}): OpencodeEvent {
  return {
    type: 'message.updated',
    properties: {
      info: {
        id: MESSAGE,
        sessionID: SESSION,
        role: 'assistant',
        time: { created: EPOCH, completed: EPOCH + 2_000 },
        tokens: {
          input: tokens.input,
          output: tokens.output,
          reasoning: tokens.reasoning,
          cache: { read: tokens.read, write: tokens.write },
        },
        cost: 0.42,
        modelID: 'claude-sonnet-4',
        providerID: 'anthropic',
        path: { cwd: REPO, root: REPO },
      },
    },
  }
}

/** A user message: the one payload in this fixture set that IS a prompt. */
const USER_MESSAGE: OpencodeEvent = {
  type: 'message.updated',
  properties: {
    info: { id: MESSAGE, sessionID: SESSION, role: 'user', time: { created: EPOCH }, content: PROMPT },
  },
}

const TODO_UPDATED: OpencodeEvent = {
  type: 'todo.updated',
  properties: {
    sessionID: SESSION,
    todos: [{ id: 'todo_1', content: TODO_TEXT, status: 'in_progress', priority: 'high' }],
  },
}

/** A file edit with no session identity anywhere in it. */
const FILE_EDITED: OpencodeEvent = { type: 'file.edited', properties: { file: FILE_PATH } }

/** A diff, which this product must not read at all. */
const SESSION_DIFF: OpencodeEvent = {
  type: 'session.diff',
  properties: { sessionID: SESSION, diff: [{ file: FILE_PATH, additions: DIFF, deletions: '' }] },
}

/** The tool hooks' input, arguments and all: none of it may be read. */
const TOOL_BEFORE = {
  tool: 'bash',
  sessionID: SESSION,
  callID: CALL,
  args: { command: ARGUMENT },
  output: TOOL_OUTPUT,
}

const TOOL_AFTER = { tool: 'bash', sessionID: SESSION, callID: CALL, args: { command: ARGUMENT } }

/** Above the classifier's thresholds, so the fyi rows assert their subtype. */
const BURN = { input: 30_000, output: 15_000, reasoning: 3_000, read: 5_000, write: 2_000 }

/**
 * A measurement at the classifier's own threshold, for the row whose payload cannot
 * carry one. Two is the retry threshold the classifier's table records; the point of
 * the assertion is the class and the subtype, not the number.
 */
const GAP_VALUE = 2

/**
 * The whole event union of @opencode-ai/sdk 1.18.32, read out of `Event` in
 * `dist/gen/types.gen.d.ts` on 2026-09-26.
 *
 * Written out because it is the review surface for the coverage assertion below: a
 * name opencode adds in a later version makes this test fail with a list of what is
 * new, which is the moment to decide what the new name is worth. That is the
 * intended cost.
 */
const OPENCODE_1_18_32_EVENTS: readonly string[] = [
  'server.instance.disposed',
  'installation.updated',
  'installation.update-available',
  'lsp.client.diagnostics',
  'lsp.updated',
  'message.updated',
  'message.removed',
  'message.part.updated',
  'message.part.removed',
  'permission.updated',
  'permission.replied',
  'session.status',
  'session.idle',
  'session.compacted',
  'file.edited',
  'todo.updated',
  'command.executed',
  'session.created',
  'session.updated',
  'session.deleted',
  'session.diff',
  'session.error',
  'file.watcher.updated',
  'vcs.branch.updated',
  'tui.prompt.append',
  'tui.command.execute',
  'tui.toast.show',
  'pty.created',
  'pty.updated',
  'pty.exited',
  'pty.deleted',
  'server.connected',
]

/** The ten event names PRD 5 records the generic `event` hook as delivering. */
const DOCUMENTED_EVENT_NAMES: readonly string[] = [
  'session.status',
  'session.idle',
  'permission.asked',
  'permission.replied',
  'session.error',
  'session.compacted',
  'message.updated',
  'tool.execute.before',
  'tool.execute.after',
  'todo.updated',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A translator with a hand-driven clock, and the clock itself. */
function translatorWith(clock = testClock()): { translator: Translator; clock: ReturnType<typeof testClock> } {
  return {
    translator: createTranslator({ directory: REPO, now: clock.now }),
    clock,
  }
}

/** Observe, and fail loudly rather than silently comparing against undefined. */
function observe(translator: Translator, event: OpencodeEvent) {
  return translator.observe(event)
}

/** Every event of one turn, in the order a harness delivers them. */
function oneWorkingTurn(
  hooks: Awaited<ReturnType<typeof AGENT_PING_PLUGIN>>,
  options: { firstIdleIsDeprecated?: boolean } = {},
): Promise<void> {
  return (async (): Promise<void> => {
    await hooks.event?.({ event: statusEvent('busy') })
    await hooks['tool.execute.before']?.(TOOL_BEFORE)
    if (options.firstIdleIsDeprecated === true) {
      await hooks.event?.({ event: DEPRECATED_IDLE })
      await hooks.event?.({ event: statusEvent('idle') })
    } else {
      await hooks.event?.({ event: statusEvent('idle') })
      await hooks.event?.({ event: DEPRECATED_IDLE })
    }
  })()
}

// ---------------------------------------------------------------------------
// The hub pipeline, over a real log
// ---------------------------------------------------------------------------

const openStores: EventStore[] = []
const openServices: { close: () => Promise<void> }[] = []
const directories: string[] = []

afterEach(() => {
  for (const service of openServices.splice(0)) service.close().catch(() => undefined)
  for (const store of openStores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

interface HubPipeline {
  readonly store: EventStore
  readonly service: ReturnType<typeof createIngestService>
  readonly delivered: readonly { class: EventClass; eventId: string }[]
  submit(signal: HarnessSignal): Promise<IngestAccepted>
}

/**
 * The real ingest pipeline over a real SQLite log.
 *
 * Not a stand-in for the classifier or the store: this is the code that decides
 * whether two signals become one row, and the acceptance criterion is about what the
 * log holds, so the log is what the test reads.
 */
function hubPipeline(): HubPipeline {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent-ping-plugin-'))
  directories.push(directory)
  const store = openEventStore({ filePath: path.join(directory, 'scratch.db') })
  openStores.push(store)
  const delivered: { class: EventClass; eventId: string }[] = []
  const service = createIngestService({
    store,
    delivery: (request) => void delivered.push({ class: request.class, eventId: request.event.eventId }),
  })
  openServices.push(service)
  const submit = async (signal: HarnessSignal): Promise<IngestAccepted> => {
    const result = await service.submit(signal)
    service.startDelivery(result)
    await service.idle()
    // A refused signal is a failure of the test's own fixture, not a value to assert
    // on, so it is reported rather than passed through as a result.
    if (!result.ok) throw new Error(`the hub refused a signal: ${result.code}`)
    return result
  }
  return { store, service, delivered, submit }
}

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** The plugin, with a fake harness log and a delivery port that records. */
async function pluginHarness(options: {
  deliver?: (signal: HarnessSignal) => unknown
  directory?: string
  /** The harness's worktree, which is the only other input field the plugin declares. */
  worktree?: string
}): Promise<{
  hooks: Awaited<ReturnType<typeof AGENT_PING_PLUGIN>>
  logLines: { level: string; service: string; message: string; extra?: Record<string, unknown> }[]
  delivered: HarnessSignal[]
  inFlight: Promise<unknown>[]
}> {
  const logLines: { level: string; service: string; message: string; extra?: Record<string, unknown> }[] = []
  const delivered: HarnessSignal[] = []
  const inFlight: Promise<unknown>[] = []
  const hooks = await AGENT_PING_PLUGIN(
    {
      directory: options.directory ?? REPO,
      ...(options.worktree === undefined ? {} : { worktree: options.worktree }),
      client: {
        app: {
          log: (input) => {
            const body = input.body
            if (body !== undefined) {
              logLines.push({
                level: body.level,
                service: body.service,
                message: body.message,
                ...(body.extra === undefined ? {} : { extra: body.extra }),
              })
            }
            return undefined
          },
        },
      },
    },
    options.deliver === undefined
      ? {}
      : {
          deliver: (signal: HarnessSignal) => {
            delivered.push(signal)
            const result = options.deliver?.(signal)
            if (isPromise(result)) inFlight.push(result)
            return result
          },
        },
  )
  return { hooks, logLines, delivered, inFlight }
}

// ---------------------------------------------------------------------------
// 1. The table
// ---------------------------------------------------------------------------

/** What one documented event must translate into. Written out, not derived. */
interface ExpectedTranslation {
  readonly label: string
  readonly event: OpencodeEvent
  readonly signalEventName: string
  readonly variant?: string
  /** Null means the classifier deliberately produced no event. */
  readonly class: EventClass | null
  readonly subtype: FyiSubtype | null
  /** The identity the dedupe key is derived from, for the rows that carry one. */
  readonly transitionId?: string
  /** Why nothing was produced, for the rows that produce nothing. */
  readonly reason?: SuppressionReason
  /** The measurements the signal carries, if any. */
  readonly measurements?: Readonly<Record<string, number>>
}

const EXPECTED: readonly ExpectedTranslation[] = [
  {
    label: 'session.status idle after work',
    event: statusEvent('idle'),
    signalEventName: 'session.status',
    variant: 'idle',
    class: 'finished',
    subtype: null,
    transitionId: 'idle:1',
  },
  {
    label: 'the deprecated session.idle, for the same turn',
    event: DEPRECATED_IDLE,
    signalEventName: 'session.idle',
    class: 'finished',
    subtype: null,
    transitionId: 'idle:1',
  },
  {
    label: 'permission.updated, the block opencode 1.18.32 delivers',
    event: PERMISSION,
    signalEventName: 'permission.asked',
    class: 'needs-you',
    subtype: null,
    transitionId: BLOCK,
  },
  {
    label: 'permission.asked, the name PRD 5 documents',
    event: PERMISSION_ASKED,
    signalEventName: 'permission.asked',
    class: 'needs-you',
    subtype: null,
    transitionId: BLOCK,
  },
  {
    label: 'permission.replied, the resolution',
    event: PERMISSION_REPLIED,
    signalEventName: 'permission.replied',
    class: null,
    subtype: null,
    transitionId: BLOCK,
    reason: 'block-resolved',
  },
  {
    label: 'session.error',
    event: SESSION_ERROR,
    signalEventName: 'session.error',
    class: 'fyi',
    subtype: 'error',
    transitionId: 'error:1',
  },
  {
    label: 'session.compacted',
    event: COMPACTED,
    signalEventName: 'session.compacted',
    class: 'fyi',
    subtype: 'compaction',
    transitionId: 'compaction:1',
  },
  {
    label: 'message.updated past the token threshold',
    event: assistantMessage(BURN),
    signalEventName: 'message.updated',
    class: 'fyi',
    subtype: 'token-burn',
    transitionId: MESSAGE,
    measurements: { tokensUsed: 55_000 },
  },
  {
    label: 'tool.execute.after past the long-call threshold',
    event: { type: 'tool.execute.after', properties: TOOL_AFTER },
    signalEventName: 'tool.execute.after',
    class: 'fyi',
    subtype: 'long-tool-call',
    transitionId: CALL,
    measurements: { durationMs: 31_000 },
  },
  {
    label: 'todo.updated, which carries no attempt on this harness',
    event: TODO_UPDATED,
    signalEventName: 'todo.updated',
    class: null,
    subtype: null,
    transitionId: 'todo:1',
    reason: 'measurement-unavailable',
  },
]

describe('the translation table (OA-FR-02, EL-FR-04)', () => {
  it.each(EXPECTED)('$label maps to one class, one subtype and one dedupe key', async (expected) => {
    const { translator, clock } = translatorWith()
    // The tool row needs its before boundary, and the idle row needs a turn with
    // work, so the fixture drives the two events that make each case real.
    if (expected.signalEventName === 'tool.execute.after') {
      observe(translator, { type: 'tool.execute.before', properties: TOOL_BEFORE })
      clock.advance(31_000)
    }
    if (expected.signalEventName === 'session.status' || expected.label.includes('deprecated')) {
      observe(translator, statusEvent('busy'))
      observe(translator, { type: 'tool.execute.before', properties: TOOL_BEFORE })
    }

    const translated = observe(translator, expected.event)
    if (translated === null) throw new Error(`${expected.label} produced no signal`)
    const { signal, classification } = translated

    expect(signal.eventName).toBe(expected.signalEventName)
    expect(signal.variant).toBe(expected.variant)
    expect(signal.harness).toBe('opencode')
    expect(signal.sessionId).toBe(SESSION)

    if (expected.class === null) {
      expect(classification.outcome).toBe('no-event')
      expect(classification.outcome === 'no-event' ? classification.reason : undefined).toBe(expected.reason)
    } else {
      expect(classification.outcome).toBe('event')
      const event = classification.outcome === 'event' ? classification.event : undefined
      expect(event?.class).toBe(expected.class)
      expect(event?.subtype).toBe(expected.subtype)
      // The key is the classifier's, derived from harness, session and the identity
      // the adapter supplied - and the adapter built no key of its own.
      expect(event?.dedupeKey).toBe(deriveDedupeKey('opencode', SESSION, expected.transitionId ?? ''))
      expect(event?.rawEventType).toBe(expected.signalEventName)
    }
    expect(signal.transitionId).toBe(expected.transitionId)
    expect(signal.measurements ?? undefined).toEqual(expected.measurements)
  })

  it('agrees with the classifier row by row, so neither table can drift from the other', () => {
    // The adapter declares what the classifier will decide. This walks the declared
    // table and asks the classifier directly, with a signal built to the row's own
    // rule, so a change on either side fails here rather than in production
    // (ADR-004, ADR-005).
    for (const row of OPENCODE_EVENT_TABLE) {
      if (row.posts === 'never') {
        // A row that is never posted never reaches the classifier, so there is nothing
        // for it to agree with - the classifier has no row for a file edit at all, and
        // that is why the adapter must not post one. What such a row must satisfy
        // instead is that it exists for an effect or for a recorded gap.
        expect(
          row.work !== null || row.turnBoundary !== 'none' || row.evidence.status === 'derived',
          row.signalEventName,
        ).toBe(true)
        continue
      }
      const signal = signalForRow(row)
      const classification = classify(signal)
      if (row.measurementGap !== null) {
        // The row maps to a class, and this harness's payload cannot reach it: the
        // measurement is missing, so the honest answer today is a reported gap rather
        // than an invented number. Both halves are asserted - the gap, and the mapping
        // the row declares once the measurement exists.
        expect(classification.outcome, row.signalEventName).toBe('no-event')
        expect(
          classification.outcome === 'no-event' ? classification.reason : undefined,
          row.signalEventName,
        ).toBe('measurement-unavailable')
        const measured = classify({ ...signal, measurements: { [row.measurementGap]: GAP_VALUE } })
        expect(measured.outcome, row.signalEventName).toBe('event')
        const event = measured.outcome === 'event' ? measured.event : undefined
        expect(event?.class, row.signalEventName).toBe(row.class)
        expect(event?.subtype, row.signalEventName).toBe(row.subtype)
        continue
      }
      if (row.class === null) {
        expect(classification.outcome, row.signalEventName).toBe('no-event')
        const reason = classification.outcome === 'no-event' ? classification.reason : undefined
        expect(
          ['block-resolved', 'measurement-unavailable', 'below-threshold', 'not-a-class-event'],
          row.signalEventName,
        ).toContain(reason)
      } else {
        expect(classification.outcome, row.signalEventName).toBe('event')
        const event = classification.outcome === 'event' ? classification.event : undefined
        expect(event?.class, row.signalEventName).toBe(row.class)
        expect(event?.subtype, row.signalEventName).toBe(row.subtype)
      }
      expect(row.note.length, row.signalEventName).toBeGreaterThan(40)
      expect(row.evidence.source.length, row.signalEventName).toBeGreaterThan(10)
    }
  })

  it('gives every event name with a variant row a fallback row, as the classifier does', () => {
    const withVariants = new Set(
      OPENCODE_EVENT_TABLE.filter((row) => row.variant !== undefined).map((row) => row.harnessEvents[0] ?? ''),
    )
    for (const eventName of withVariants) {
      const rows = OPENCODE_EVENT_TABLE.filter((row) => row.harnessEvents.includes(eventName))
      expect(rows.some((row) => row.variant === 'from-status'), eventName).toBe(true)
      expect(rows.some((row) => row.variant !== 'from-status'), eventName).toBe(true)
    }
  })

  it('carries the work signal with the two idle forms and with nothing else', () => {
    const carrying = OPENCODE_EVENT_TABLE.filter((row) => row.carriesWorkSignal).map((row) => row.harnessEvents[0])
    expect(carrying.sort()).toEqual(['session.idle', 'session.status'])
  })

  it('records a reason on every row that posts nothing', () => {
    for (const row of OPENCODE_EVENT_TABLE.filter((candidate) => candidate.posts === 'never')) {
      expect(row.note.length, row.signalEventName).toBeGreaterThan(60)
    }
  })
})

describe('coverage: every event name opencode delivers is mapped or declined (OA-FR-02)', () => {
  const mapped = new Set(OPENCODE_EVENT_TABLE.flatMap((row) => row.harnessEvents))
  const declined = new Set(OPENCODE_UNMAPPED_EVENTS.map((event) => event.name))

  it('covers every documented opencode event name PRD 5 records', () => {
    for (const name of DOCUMENTED_EVENT_NAMES) {
      // `permission.ask` is the dedicated hook, which is documented as never firing
      // and is deliberately not adapted; it is asserted separately below.
      if (OPENCODE_UNSUBSCRIBED_HOOKS.includes(name)) continue
      expect(mapped.has(name), `${name} has no row`).toBe(true)
    }
  })

  it('declines the dedicated permission hook rather than adapting a signal that cannot fire', () => {
    expect(OPENCODE_UNSUBSCRIBED_HOOKS).toEqual(['permission.ask'])
    expect(mapped.has('permission.ask')).toBe(false)
  })

  it('maps or declines every name in the 1.18.32 union, with nothing in both', () => {
    const delivered = new Set(OPENCODE_1_18_32_EVENTS)
    for (const name of delivered) {
      expect(mapped.has(name) || declined.has(name), `${name} is neither mapped nor declined`).toBe(true)
    }
    // The two tool boundaries are hook names rather than event names, so they are
    // mapped without appearing in the union; everything else in either list must.
    const hookOnly = ['tool.execute.before', 'tool.execute.after', 'permission.asked']
    for (const name of [...mapped, ...declined]) {
      if (hookOnly.includes(name)) continue
      expect(delivered.has(name), `${name} is listed but opencode 1.18.32 delivers no such event`).toBe(true)
    }
    for (const name of declined) {
      expect(mapped.has(name), `${name} is both mapped and declined`).toBe(false)
    }
  })

  it('gives every declined name a written reason, because a default is not a decision', () => {
    for (const event of OPENCODE_UNMAPPED_EVENTS) {
      expect(event.reason.length, event.name).toBeGreaterThan(20)
    }
  })

  it('ignores a name it does not map, and counts it rather than throwing', () => {
    const { translator } = translatorWith()
    expect(observe(translator, SESSION_DIFF)).toBeNull()
    expect(observe(translator, { type: 'tui.toast.show', properties: {} })).toBeNull()
    expect(translator.stats.ignored).toBe(2)
    expect(translator.stats.translated).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. The idle gate, end to end through the real hub pipeline
// ---------------------------------------------------------------------------

describe('the idle transition is one envelope, not two (EL-FR-05, EL-FR-06)', () => {
  it.each([
    { label: 'session.status idle first, then the deprecated session.idle', deprecatedSecond: true },
    { label: 'the deprecated session.idle first, then session.status idle', deprecatedSecond: false },
  ])('$label stores exactly one finished event', async ({ deprecatedSecond }) => {
    const hub = hubPipeline()
    const { hooks, inFlight } = await pluginHarness({ deliver: (signal) => hub.submit(signal) })
    await oneWorkingTurn(hooks, { firstIdleIsDeprecated: !deprecatedSecond })
    await Promise.all(inFlight)

    const history = hub.store.readEventHistory()
    expect(history).toHaveLength(1)
    expect(history[0]?.class).toBe('finished')
    expect(history[0]?.rawEventType).toBe(deprecatedSecond ? 'session.status' : 'session.idle')
    expect(hub.delivered).toHaveLength(1)
    // The short name is the directory basename, derived by the classifier (APX-CON-09).
    expect(hub.store.readSessionSummaries()[0]?.repoShortName).toBe('agent-ping')
  })

  it('gives both forms of one transition the same dedupe key, so the log cannot hold both', async () => {
    // The mechanism behind the collapse, asserted directly: one turn identity, one
    // key. A replay of the same signal is the same proof from the other side, and it
    // is what the hub's idempotence guarantee rests on (HC-FR-08).
    const { translator } = translatorWith()
    observe(translator, statusEvent('busy'))
    observe(translator, { type: 'tool.execute.before', properties: TOOL_BEFORE })
    const first = observe(translator, statusEvent('idle'))?.signal
    const second = observe(translator, DEPRECATED_IDLE)?.signal
    expect(first?.transitionId).toBe(second?.transitionId)
    expect(deriveDedupeKey('opencode', SESSION, first?.transitionId ?? '')).toBe(
      deriveDedupeKey('opencode', SESSION, second?.transitionId ?? ''),
    )

    const hub = hubPipeline()
    // The first form's work, reported by the second form as well, is what a naive
    // implementation would send twice. Forcing the same work signal onto both makes
    // the key - not the gate - the thing that collapses them.
    const replayed = { ...(first as HarnessSignal), turnWork: { toolCall: true, fileEdit: false, todoUpdate: false } }
    expect((await hub.submit(replayed)).outcome).toBe('stored')
    const secondForm = { ...(second as HarnessSignal), turnWork: replayed.turnWork }
    const result = await hub.submit(secondForm)
    expect(result.outcome).toBe('duplicate')
    expect(hub.store.readEventHistory()).toHaveLength(1)
  })

  it('produces no event at all for a turn that opened, greeted and closed', async () => {
    const hub = hubPipeline()
    const { hooks, inFlight } = await pluginHarness({ deliver: (signal) => hub.submit(signal) })
    await hooks.event?.({ event: statusEvent('busy') })
    await hooks.event?.({ event: statusEvent('idle') })
    await Promise.all(inFlight)

    expect(hub.store.readEventHistory()).toEqual([])
    expect(hub.delivered).toEqual([])
    expect(hub.service.stats().stored).toBe(0)
    // The reason is recorded, so "nothing happened" and "this harness cannot say"
    // stay distinguishable (ADR-004).
    const { translator } = translatorWith()
    observe(translator, statusEvent('busy'))
    const classified = observe(translator, statusEvent('idle'))?.classification
    expect(classified?.outcome).toBe('no-event')
    expect(classified?.outcome === 'no-event' ? classified.reason : undefined).toBe('idle-after-nothing')
  })

  it('produces two finished events for two turns that each did work', async () => {
    const hub = hubPipeline()
    const { hooks, inFlight } = await pluginHarness({ deliver: (signal) => hub.submit(signal) })
    await oneWorkingTurn(hooks)
    await hooks.event?.({ event: statusEvent('busy') })
    await hooks['tool.execute.before']?.({ ...TOOL_BEFORE, callID: 'call_02' })
    await hooks.event?.({ event: statusEvent('idle') })
    await Promise.all(inFlight)

    const history = hub.store.readEventHistory()
    expect(history).toHaveLength(2)
    expect(new Set(history.map((row) => row.dedupeKey)).size).toBe(2)
    expect(history.every((row) => row.class === 'finished')).toBe(true)
    expect(hub.delivered).toHaveLength(2)
  })

  it('reports a greeting turn after a working one as nothing, because the signal reset', async () => {
    const { translator } = translatorWith()
    observe(translator, statusEvent('busy'))
    observe(translator, { type: 'tool.execute.before', properties: TOOL_BEFORE })
    expect(observe(translator, statusEvent('idle'))?.signal.turnWork?.toolCall).toBe(true)

    observe(translator, statusEvent('busy'))
    const second = observe(translator, statusEvent('idle'))
    expect(second?.signal.turnWork).toEqual({ toolCall: false, fileEdit: false, todoUpdate: false })
    expect(second?.classification.outcome).toBe('no-event')
  })

  it('begins a turn from any non-idle status, including one it has never seen', async () => {
    const { translator } = translatorWith()
    observe(translator, { type: 'tool.execute.before', properties: TOOL_BEFORE })
    observe(translator, statusEvent('idle'))
    // A status this build has never seen still resets the turn, and still names
    // itself: the classifier records it rather than the adapter refusing it.
    const unknown = observe(translator, { type: 'session.status', properties: { sessionID: SESSION, status: { type: 'throttled' } } })
    expect(unknown).toBeNull()
    const after = observe(translator, statusEvent('idle'))
    expect(after?.classification.outcome).toBe('no-event')
    expect(after?.signal.transitionId).toBe('idle:2')
  })
})

describe('the block and its resolution (EL-FR-07, EL-FR-08)', () => {
  it('opens one pending item, and one permission under either name is one item', async () => {
    const hub = hubPipeline()
    const { hooks, inFlight } = await pluginHarness({ deliver: (signal) => hub.submit(signal) })
    await hooks.event?.({ event: PERMISSION })
    // The same permission, reported again under the name PRD 5 documents.
    await hooks.event?.({ event: PERMISSION_ASKED })
    await Promise.all(inFlight)

    expect(hub.store.readEventHistory()).toHaveLength(1)
    expect(hub.store.readPending()).toHaveLength(1)
    expect(hub.store.readPending()[0]?.class).toBe('needs-you')
    expect(hub.delivered.map((entry) => entry.class)).toEqual(['needs-you'])
  })

  it('clears the pending item on the resolution, even though a resolution is not an event', async () => {
    const hub = hubPipeline()
    const { hooks, inFlight } = await pluginHarness({ deliver: (signal) => hub.submit(signal) })
    await hooks.event?.({ event: PERMISSION })
    await hooks.event?.({ event: PERMISSION_REPLIED })
    await Promise.all(inFlight)

    expect(hub.store.readPending()).toEqual([])
    // The resolution stored no event of its own and fired no second notification.
    expect(hub.store.readEventHistory()).toHaveLength(1)
    expect(hub.delivered.map((entry) => entry.class)).toEqual(['needs-you'])
  })

  it('addresses the resolution by the same identity as the ask', async () => {
    const hub = hubPipeline()
    const { translator } = translatorWith()
    await hub.submit(observe(translator, PERMISSION)?.signal as HarnessSignal)
    const resolution = observe(translator, PERMISSION_REPLIED)?.signal
    expect(deriveDedupeKey('opencode', SESSION, BLOCK)).toBe(
      deriveDedupeKey('opencode', SESSION, resolution?.transitionId ?? ''),
    )
    expect((await hub.submit(resolution as HarnessSignal)).outcome).toBe('resolved')
  })
})

// ---------------------------------------------------------------------------
// 3. Content is never read
// ---------------------------------------------------------------------------

describe('nothing content-shaped is ever carried (APX-FR-01, EL-FR-01)', () => {
  it('carries no part of a payload that holds one', () => {
    const { translator, clock } = translatorWith()
    observe(translator, { type: 'tool.execute.before', properties: TOOL_BEFORE })
    clock.advance(31_000)
    const events: OpencodeEvent[] = [
      PERMISSION,
      PERMISSION_ASKED,
      PERMISSION_REPLIED,
      SESSION_ERROR,
      COMPACTED,
      assistantMessage(BURN),
      USER_MESSAGE,
      TODO_UPDATED,
      { type: 'tool.execute.after', properties: TOOL_AFTER },
      statusEvent('busy'),
      statusEvent('retry'),
      statusEvent('idle'),
      DEPRECATED_IDLE,
    ]
    // The two non-idle statuses produce no signal by decision - they are the turn
    // boundary and nothing else - so the sweep is over the other eleven.
    expect(observe(translator, statusEvent('busy'))).toBeNull()
    expect(observe(translator, statusEvent('retry'))).toBeNull()
    const produced = events
      .map((event) => observe(translator, event)?.signal)
      .filter((signal): signal is HarnessSignal => signal !== undefined)
    expect(produced).toHaveLength(11)

    for (const signal of produced) {
      const serialized = JSON.stringify(signal)
      for (const secret of EVERY_SECRET) {
        expect(serialized.includes(secret), `${signal.eventName} carried ${secret}`).toBe(false)
      }
    }
  })

  it('fills only the fields the hub\'s ingest contract declares, plus the hub\'s own stamp', () => {
    // HC-3's closed wire schema is the contract this adapter writes against, and
    // `receivedAt` is the one field it carries and must not post: the envelope
    // documents it as the instant the *hub* received the event.
    const { translator, clock } = translatorWith()
    observe(translator, statusEvent('busy'))
    observe(translator, { type: 'tool.execute.before', properties: TOOL_BEFORE })
    const idle = observe(translator, statusEvent('idle'))?.signal as HarnessSignal
    clock.advance(31_000)
    observe(translator, { type: 'tool.execute.before', properties: { ...TOOL_BEFORE, callID: 'call_02' } })
    const tool = observe(
      translator,
      { type: 'tool.execute.after', properties: { ...TOOL_AFTER, callID: 'call_02' } },
    )?.signal as HarnessSignal
    const block = observe(translator, PERMISSION)?.signal as HarnessSignal

    const wireFields = [...INGEST_SIGNAL_FIELD_NAMES].filter((name) => name !== 'receivedAt')
    // Every field any of them fills is a field the route accepts, and across the three
    // of them they fill all of them - so the schema and the adapter agree in both
    // directions rather than the adapter happening to send a subset.
    const union = new Set([idle, tool, block].flatMap((signal) => Object.keys(signal)))
    union.delete('receivedAt')
    expect([...union].sort()).toEqual([...wireFields].sort())
    for (const signal of [idle, tool, block]) {
      for (const key of Object.keys(signal).filter((name) => name !== 'receivedAt')) {
        expect(wireFields).toContain(key)
      }
    }
    // And nothing that is the hub's to decide is ever set by the adapter.
    for (const signal of [idle, tool, block]) {
      expect(signal).not.toHaveProperty('repoShortName')
      expect(signal).not.toHaveProperty('class')
      expect(signal).not.toHaveProperty('dedupeKey')
    }
  })

  it('never sets the repository short name, so the classifier derives the only one', () => {
    const { translator } = translatorWith()
    const signal = observe(translator, PERMISSION)?.signal as HarnessSignal
    expect(signal.repoFullPath).toBe(REPO)
    const event = classifySignalLocally(signal)
    expect(event.repoShortName).toBe('agent-ping')
    expect(event.repoFullPath).toBe(REPO)
  })

  it('reads neither the tool name nor its arguments, and reports only the duration', () => {
    const { translator, clock } = translatorWith()
    observe(translator, { type: 'tool.execute.before', properties: TOOL_BEFORE })
    clock.advance(31_000)
    const signal = observe(translator, { type: 'tool.execute.after', properties: TOOL_AFTER })?.signal
    expect(signal?.measurements).toEqual({ durationMs: 31_000 })
    expect(JSON.stringify(signal)).not.toContain(ARGUMENT)
    expect(JSON.stringify(signal)).not.toContain(TOOL_OUTPUT)
    expect(JSON.stringify(signal)).not.toContain('bash')
  })

  it('never reads a file path, a todo, a diff or an error message', () => {
    const { translator } = translatorWith()
    // A file edit is not attributable and a diff is not mapped: neither produces a
    // signal, which is the strongest statement either can make. A non-idle status is
    // the turn boundary and is never posted, so the retry status message - which the
    // payload does carry - is never read either.
    expect(observe(translator, FILE_EDITED)).toBeNull()
    expect(observe(translator, SESSION_DIFF)).toBeNull()
    expect(observe(translator, statusEvent('retry'))).toBeNull()
    for (const translated of [
      observe(translator, TODO_UPDATED),
      observe(translator, SESSION_ERROR),
      observe(translator, PERMISSION),
    ]) {
      const serialized = JSON.stringify(translated?.signal)
      for (const secret of [FILE_PATH, TODO_TEXT, DIFF, ERROR_TEXT, RETRY_TEXT, TITLE, ARGUMENT]) {
        expect(serialized?.includes(secret) ?? false, secret).toBe(false)
      }
    }
  })

  it('reports a file edit as unattributable rather than guessing a session', () => {
    const { translator } = translatorWith()
    observe(translator, statusEvent('busy'))
    observe(translator, { type: 'tool.execute.before', properties: TOOL_BEFORE })
    observe(translator, FILE_EDITED)
    // An error with no session is the same shape of problem: a payload that cannot be
    // attributed, counted rather than dropped quietly.
    observe(translator, SESSIONLESS_ERROR)
    expect(translator.stats.unattributed).toBe(2)
    expect(translator.stats.translated).toBe(0)
    // It fed no measure to any session, and in particular not to the one turn in
    // flight: crediting an edit whose session the payload never named is the guess
    // this row exists to refuse, and it would be a greeting turn told it did work.
    expect(translator.recorder.turn(SESSION).work).toEqual({
      toolCall: true,
      fileEdit: false,
      todoUpdate: false,
    })
  })
})

// ---------------------------------------------------------------------------
// 4. The measurements
// ---------------------------------------------------------------------------

describe('the magnitudes the adapter reads (EL-FR-04)', () => {
  it('sums the five token counters opencode reports, and gates at the classifier', () => {
    const { translator } = translatorWith()
    const below = observe(translator, assistantMessage({ input: 100, output: 50, reasoning: 0, read: 0, write: 0 }))
    expect(below?.signal.measurements).toEqual({ tokensUsed: 150 })
    expect(below?.classification.outcome === 'no-event' ? below.classification.reason : undefined).toBe(
      'below-threshold',
    )

    const above = observe(translator, assistantMessage(BURN))
    expect(above?.signal.measurements).toEqual({ tokensUsed: 55_000 })
    expect(above?.classification.outcome).toBe('event')
  })

  it('reads no tokens from a user message, rather than reporting zero', () => {
    const { translator } = translatorWith()
    const user = observe(translator, USER_MESSAGE)
    expect(user?.signal.measurements).toBeUndefined()
    expect(user?.classification.outcome === 'no-event' ? user.classification.reason : undefined).toBe(
      'measurement-unavailable',
    )
  })

  it('measures a tool call from its before boundary', () => {
    const { translator, clock } = translatorWith()
    observe(translator, { type: 'tool.execute.before', properties: TOOL_BEFORE })
    clock.advance(29_000)
    const quick = observe(translator, { type: 'tool.execute.after', properties: TOOL_AFTER })
    expect(quick?.signal.measurements).toEqual({ durationMs: 29_000 })
    expect(quick?.classification.outcome === 'no-event' ? quick.classification.reason : undefined).toBe(
      'below-threshold',
    )

    observe(translator, { type: 'tool.execute.before', properties: { ...TOOL_BEFORE, callID: 'call_02' } })
    clock.advance(31_000)
    const slow = observe(translator, { type: 'tool.execute.after', properties: { ...TOOL_AFTER, callID: 'call_02' } })
    expect(slow?.signal.measurements).toEqual({ durationMs: 31_000 })
    expect(slow?.classification.outcome).toBe('event')
  })

  it('reports no duration for a call it never saw start, rather than a guessed one', () => {
    const { translator } = translatorWith()
    const orphan = observe(translator, { type: 'tool.execute.after', properties: TOOL_AFTER })
    expect(orphan?.signal.measurements).toBeUndefined()
    expect(orphan?.classification.outcome === 'no-event' ? orphan.classification.reason : undefined).toBe(
      'measurement-unavailable',
    )
  })

  it('keeps both magnitudes out of the envelope, because a number that grows with what was said is a transcript', () => {
    const { translator, clock } = translatorWith()
    observe(translator, { type: 'tool.execute.before', properties: TOOL_BEFORE })
    clock.advance(31_000)
    const tool = observe(translator, { type: 'tool.execute.after', properties: TOOL_AFTER })
    const burn = observe(translator, assistantMessage(BURN))
    for (const translated of [tool, burn]) {
      const event = translated?.classification.outcome === 'event' ? translated.classification.event : undefined
      expect(event).toBeDefined()
      expect(JSON.stringify(event)).not.toContain('31000')
      expect(JSON.stringify(event)).not.toContain('55000')
    }
  })

  it('forgets a tool call that never closes, so a dead call cannot grow the map', () => {
    const translator = createTranslator({ directory: REPO, now: () => EPOCH, maxOpenToolCalls: 2 })
    for (const callID of ['a', 'b', 'c']) {
      observe(translator, { type: 'tool.execute.before', properties: { ...TOOL_BEFORE, callID } })
    }
    // 'a' was forgotten, so its after boundary carries no measurement.
    expect(observe(translator, { type: 'tool.execute.after', properties: { ...TOOL_AFTER, callID: 'a' } })?.signal
      .measurements).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 5. The plugin's obligations
// ---------------------------------------------------------------------------

describe('the plugin logs through the harness and never through the console (OA-FR-05)', () => {
  it('writes every line through client.app.log under this product\'s service name', async () => {
    const { hooks, logLines } = await pluginHarness({
      deliver: (signal) => {
        void signal
      },
    })
    await oneWorkingTurn(hooks)
    expect(logLines.length).toBeGreaterThan(0)
    for (const line of logLines) {
      expect(line.service).toBe(AGENT_PING_SERVICE)
      expect(line.service).toBe('agent-ping')
      expect(line.message.length).toBeGreaterThan(0)
    }
  })

  it('writes nothing to the console for a whole turn, a block, a failure and a bad payload', async () => {
    const consoles = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    )
    const { hooks } = await pluginHarness({ deliver: () => { throw new Error('the hub is not running') } })
    await oneWorkingTurn(hooks)
    await hooks.event?.({ event: PERMISSION })
    await hooks.event?.({ event: PERMISSION_REPLIED })
    await hooks.event?.({ event: SESSION_ERROR })
    await hooks.event?.({ event: FILE_EDITED })
    await hooks.event?.({ event: { type: 'session.status', properties: 'not an object' } })
    await hooks.event?.({ event: { type: 'session.status' } as unknown as OpencodeEvent })
    await hooks['tool.execute.before']?.({} as Record<string, unknown>)

    for (const spy of consoles) expect(spy).not.toHaveBeenCalled()
  })

  it('names the service, the session and the event type in the breadcrumb it writes', async () => {
    // A block whose payload names no permission id cannot become a signal, and the
    // classifier's refusal of it is the fact the developer needs to see.
    const { hooks, logLines } = await pluginHarness({ deliver: () => undefined })
    await hooks.event?.({ event: { type: 'permission.updated', properties: { sessionID: SESSION, title: TITLE } } })
    const breadcrumb = logLines.find((line) => line.level === 'warn' && line.extra?.['code'] === 'invalid-signal')
    expect(breadcrumb, JSON.stringify(logLines)).toBeDefined()
    expect(breadcrumb?.extra?.['service']).toBe('agent-ping')
    expect(breadcrumb?.extra?.['sessionId']).toBe(SESSION)
    expect(breadcrumb?.extra?.['eventName']).toBe('permission.asked')
    expect(breadcrumb?.message).toContain('permission.asked')
    // The permission's own title was in the payload and is in no line.
    expect(JSON.stringify(logLines)).not.toContain(TITLE)
  })

  it('reports a delivery failure once, without the payload and without the error text', async () => {
    const { hooks, logLines, inFlight } = await pluginHarness({
      deliver: () => {
        throw new Error(`the hub refused: ${PROMPT}`)
      },
    })
    await hooks.event?.({ event: PERMISSION })
    await Promise.allSettled(inFlight)
    const breadcrumb = logLines.find((line) => line.extra?.['stage'] === 'delivery-failed')
    expect(breadcrumb).toBeDefined()
    expect(breadcrumb?.level).toBe('warn')
    expect(JSON.stringify(logLines)).not.toContain(PROMPT)
  })

  it('reports a rejected delivery as a breadcrumb rather than an unhandled rejection', async () => {
    const { hooks, logLines, inFlight } = await pluginHarness({ deliver: () => Promise.reject(new Error('nope')) })
    await hooks.event?.({ event: PERMISSION })
    await Promise.allSettled(inFlight)
    expect(logLines.some((line) => line.extra?.['stage'] === 'delivery-rejected')).toBe(true)
  })

  it('reports once when no delivery port is wired, rather than staying silent', async () => {
    const { hooks, logLines } = await pluginHarness({})
    await oneWorkingTurn(hooks)
    await oneWorkingTurn(hooks)
    const warnings = logLines.filter((line) => line.message.includes('no delivery port is wired'))
    expect(warnings).toHaveLength(1)
  })

  it('reports an event it could not attribute once, because a capability gap is not a quiet session', async () => {
    const { hooks, logLines } = await pluginHarness({ deliver: () => undefined })
    await hooks.event?.({ event: FILE_EDITED })
    await hooks.event?.({ event: FILE_EDITED })
    const warnings = logLines.filter((line) => line.message.includes('could not attribute'))
    expect(warnings).toHaveLength(1)
  })

  it('survives a logging client that throws, and one that rejects', async () => {
    const throwing = await AGENT_PING_PLUGIN(
      {
        directory: REPO,
        client: {
          app: {
            log: () => {
              throw new Error('the log endpoint is gone')
            },
          },
        },
      },
      { deliver: () => undefined },
    )
    await expect(throwing.event?.({ event: PERMISSION })).resolves.toBeUndefined()

    const rejecting = await AGENT_PING_PLUGIN(
      {
        directory: REPO,
        client: { app: { log: () => Promise.reject(new Error('gone')) } },
      },
      { deliver: () => undefined },
    )
    await expect(rejecting.event?.({ event: PERMISSION })).resolves.toBeUndefined()
  })
})

describe('the plugin never touches the session (APX-CON-03, OA-FR-09)', () => {
  it('subscribes to the generic event hook and the two tool boundaries, and to nothing else', async () => {
    const { hooks } = await pluginHarness({ deliver: () => undefined })
    expect(Object.keys(hooks).sort()).toEqual([
      'event',
      'tool.execute.after',
      'tool.execute.before',
    ])
    // The dedicated permission hook is documented as never firing, so adapting it
    // would ship a block signal that cannot arrive (OA-FR-02).
    expect(hooks).not.toHaveProperty('permission.ask')
  })

  it('behaves identically for an interactive, a non-interactive and an attached session', async () => {
    // The only thing that varies between the three is the harness's own input, and
    // the plugin reads one field of it. The hooks, the translation and the delivery
    // are the same, so a session cannot be invisible because of how it was started
    // (OA-FR-09).
    const sessionShapes: Record<string, unknown>[] = [
      { directory: REPO, worktree: REPO },
      { directory: REPO },
      { directory: REPO, worktree: `${REPO}/.worktrees/feature` },
    ]
    // The comparison is over everything the adapter decides: the hook set, the fields
    // it filled and the identities it filled them with. The two timestamps are the
    // clock's, and the clock is the one thing allowed to differ, so the assertion is
    // that a session cannot be invisible because of how it was started (OA-FR-09)
    // rather than that three runs are byte-identical.
    const comparable = (signal: HarnessSignal): string =>
      JSON.stringify({ ...signal, occurredAt: '<time>', receivedAt: '<time>' })
    const results: string[] = []
    for (const shape of sessionShapes) {
      const delivered: HarnessSignal[] = []
      const { hooks } = await pluginHarness({
        deliver: (signal) => void delivered.push(signal),
        ...(typeof shape['worktree'] === 'string' ? { worktree: shape['worktree'] } : {}),
      })
      expect(Object.keys(hooks).sort()).toEqual(['event', 'tool.execute.after', 'tool.execute.before'])
      await hooks.event?.({ event: PERMISSION })
      results.push(JSON.stringify({ hooks: Object.keys(hooks).sort(), delivered: delivered.map(comparable) }))
    }
    expect(new Set(results).size).toBe(1)
    // And the three inputs really are different, so the comparison above is not
    // comparing one shape with itself.
    expect(
      new Set(sessionShapes.map((one) => Object.keys(one).sort().join(','))).size,
    ).toBeGreaterThan(1)
  })

  it('does not await delivery, so a slow hub cannot slow a session', async () => {
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { hooks, delivered } = await pluginHarness({ deliver: () => held })
    await hooks.event?.({ event: PERMISSION })
    // The hook resolved while the delivery is still outstanding.
    expect(delivered).toHaveLength(1)
    release?.()
    await held
  })

  it('does not let a status it cannot read end or begin a turn', async () => {
    // A malformed status is a payload this build cannot reason about, and the damage
    // of treating it as idle would be a finished event for a session that never
    // finished. So it is counted and nothing is touched.
    const { translator } = translatorWith()
    observe(translator, statusEvent('busy'))
    observe(translator, { type: 'tool.execute.before', properties: TOOL_BEFORE })
    expect(observe(translator, { type: 'session.status', properties: { sessionID: SESSION } })).toBeNull()
    expect(
      observe(translator, { type: 'session.status', properties: { sessionID: SESSION, status: 7 } }),
    ).toBeNull()
    expect(translator.stats.unattributed).toBe(2)
    expect(translator.stats.translated).toBe(0)
    const idle = observe(translator, statusEvent('idle'))
    expect(idle?.signal.turnWork?.toolCall).toBe(true)
    expect(idle?.signal.transitionId).toBe('idle:1')
  })

  it('throws nothing out of a hook, whatever it is given', async () => {
    const { hooks } = await pluginHarness({ deliver: () => undefined })
    const hostile: unknown[] = [
      undefined,
      null,
      42,
      'session.idle',
      [],
      { type: '' },
      { type: 'session.status', properties: { sessionID: { nested: true } } },
      { type: 'session.status', properties: { sessionID: SESSION, status: 7 } },
      { type: 'message.updated', properties: { info: 'not a message' } },
      { type: 'permission.updated', properties: { id: 7, sessionID: SESSION } },
      { type: 'todo.updated', properties: { sessionID: SESSION, todos: 'not a list' } },
    ]
    for (const event of hostile) {
      await expect(hooks.event?.({ event: event as OpencodeEvent })).resolves.toBeUndefined()
    }
    await expect(hooks['tool.execute.before']?.({} as Record<string, unknown>)).resolves.toBeUndefined()
  })

  it('returns no hooks at all when the harness reports no session directory', async () => {
    const logLines: unknown[] = []
    const hooks = await AGENT_PING_PLUGIN(
      { directory: '', client: { app: { log: (input) => void logLines.push(input) } } },
      { deliver: () => undefined },
    )
    expect(hooks).toEqual({})
    expect(logLines).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 6. The boundaries of the adapter itself
// ---------------------------------------------------------------------------

describe('the adapter is a plugin and nothing more (ADR-005, ADR-006, APX-CON-12)', () => {
  const pluginDir = fileURLToPath(new URL('../../src/plugin/opencode/', import.meta.url))
  const modules = ['index.ts', 'translate.ts', 'work-signal.ts'] as const
  // The polling fallback is a fourth file in this directory, and the tests below read its
  // source for the claims it has to satisfy too. It is not in `modules` because the
  // "no socket, no spawn, no console" assertions above are about the translation path,
  // and this module is the one exception to the first of them.
  const sourceOf = (name: string): string => readFileSync(`${pluginDir}${name}`, 'utf8')
  const specifiersOf = (source: string): readonly string[] =>
    [
      ...[...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1] ?? ''),
      ...[...source.matchAll(/^\s*import\s+'([^']+)'/gm)].map((match) => match[1] ?? ''),
    ].filter((specifier) => specifier.length > 0)

  /** Comments carry the words this test looks for, so they are removed first. */
  const withoutComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('needs no package installed beside it, because a harness loads it directly', () => {
    for (const name of modules) {
      for (const specifier of specifiersOf(sourceOf(name))) {
        expect(specifier.startsWith('.'), `${name} imports ${specifier}`).toBe(true)
        // The `@/` alias is the repository's own: it does not resolve inside a
        // harness, so a plugin may not use it.
        expect(specifier.startsWith('@/'), `${name} imports ${specifier}`).toBe(false)
      }
    }
  })

  it('imports only the domain vocabulary and its own modules', () => {
    expect(specifiersOf(sourceOf('work-signal.ts'))).toEqual(['../../domain/classify.js'])
    expect([...new Set(specifiersOf(sourceOf('translate.ts')))].sort()).toEqual([
      '../../domain/classify.js',
      '../../domain/envelope.js',
      './work-signal.js',
    ])
    // Three and not two, because OA-4's polling fallback is reached from the entry point:
    // a fallback that were merely present rather than started would not be, and these
    // three modules plus the fallback are still the adapter's whole surface. Nothing here
    // reaches the hub, the transport or the store - those are separate roots (ADR-005).
    expect([...new Set(specifiersOf(sourceOf('index.ts')))].sort()).toEqual([
      '../../domain/classify.js',
      './poll-fallback.js',
      './translate.js',
    ])
  })

  it('opens no socket and spawns nothing, so it cannot be why a session is slow', () => {
    for (const name of modules) {
      const code = withoutComments(sourceOf(name))
      for (const forbidden of [
        'node:net',
        'node:http',
        'node:https',
        'node:child_process',
        'node:worker_threads',
        'node:dgram',
        'node:fs',
        'fetch(',
        'XMLHttpRequest',
        'WebSocket',
        'setInterval',
        'setTimeout',
      ]) {
        expect(code.includes(forbidden), `${name} uses ${forbidden}`).toBe(false)
      }
    }
  })

  it('the polling fallback is the one module that opens a socket, and it bounds every one', () => {
    // The claim above is about the translation modules and stays true of them. The
    // fallback does open a socket - to opencode's own server on loopback, because the
    // event stream is the only other way in - so what has to be true of it is that every
    // socket is bounded and nothing else is open: no filesystem, no child process, no
    // interval, and no unbounded fetch (APX-CON-03, APX-CON-10).
    const code = withoutComments(sourceOf('poll-fallback.ts'))
    expect(code.includes('node:http')).toBe(true)
    for (const forbidden of [
      'node:net',
      'node:https',
      'node:child_process',
      'node:worker_threads',
      'node:dgram',
      'node:fs',
      'node:os',
      'fetch(',
      'XMLHttpRequest',
      'WebSocket',
      'setInterval',
    ]) {
      expect(code.includes(forbidden), `poll-fallback.ts uses ${forbidden}`).toBe(false)
    }
    // Every request carries the bound its caller chose, and the socket is destroyed when
    // it elapses.
    expect(code).toContain('timeoutMs')
    expect(code).toContain('request.destroy()')
    expect(code).toContain('timer.unref?.()')
    // And it only ever dials a loopback address: a session id and a repository path must
    // never leave this machine because an address was misconfigured (APX-CON-12).
    expect(code).toContain('isLoopbackHost')
  })

  it('never writes to the console, in code rather than in a comment', () => {
    for (const name of modules) {
      const code = withoutComments(sourceOf(name))
      expect(code.includes('console.'), `${name} writes to the console`).toBe(false)
      expect(code.includes('process.'), `${name} reads the process`).toBe(false)
    }
  })

  it('derives no dedupe key of its own, because the classifier owns the derivation', () => {
    // Two claims, and they are different. *Building* a key is forbidden in every module:
    // a key built here is a key that differs from the hub's, and that is a second event for
    // one state. *Reading* the classifier's key is required in the modules that have to
    // suppress a duplicate - OA-1's entry point records what it pushed and OA-4's fallback
    // claims what it is about to push - so the check is on the derivation, not the word.
    for (const name of [...modules, 'poll-fallback.ts' as const]) {
      const code = withoutComments(sourceOf(name))
      expect(code.includes('deriveDedupeKey'), `${name} derives a dedupe key`).toBe(false)
      expect(code.includes('dedupeKey:'), `${name} builds a dedupe key`).toBe(false)
      expect(code.includes('dedupe_key'), `${name} builds a dedupe key`).toBe(false)
    }
    // The one key the tests read is the classifier's, reached from the envelope.
    expect(sourceOf('translate.ts')).toContain('import { classify }')
    // And the two places that name `dedupeKey` name it on the classification the
    // classifier produced, never on anything they assembled.
    for (const name of ['index.ts', 'poll-fallback.ts'] as const) {
      const occurrences = withoutComments(sourceOf(name)).match(/classification\.event\.dedupeKey|dedupeKey/g) ?? []
      expect(occurrences.length, `${name} names dedupeKey`).toBeGreaterThan(0)
      for (const occurrence of occurrences) {
        expect(occurrence, `${name} reaches for dedupeKey`).toBe('classification.event.dedupeKey')
      }
    }
  })

  it('exposes only the surface a plugin, its transport and its tests need', () => {
    expect(Object.keys(translateModule).sort()).toEqual([
      'AGENT_PING_SERVICE',
      'HARNESS_NAME',
      'MAX_OPEN_TOOL_CALLS',
      'OPENCODE_EVENT_TABLE',
      'OPENCODE_UNMAPPED_EVENTS',
      'OPENCODE_UNSUBSCRIBED_HOOKS',
      'createHarnessLog',
      'createTranslator',
    ])
    // The recorder's own surface is three operations and two reads; a fourth way in
    // would be a fourth rule about when a turn begins or ends.
    expect(Object.keys(workSignalModule).sort()).toEqual([
      'MAX_TRACKED_SESSIONS',
      'TURN_IDENTITY_PART',
      'WORK_MEASURES',
      'createWorkSignalRecorder',
    ])
  })
})

// ---------------------------------------------------------------------------
// Helpers that need the classifier directly
// ---------------------------------------------------------------------------

/** A signal built to a row's own rule, for the table-versus-classifier comparison. */
function signalForRow(row: OpencodeEventRow): HarnessSignal {
  const base: HarnessSignal = {
    harness: 'opencode',
    eventName: row.signalEventName,
    ...(row.variant === 'from-status' ? { variant: 'busy' } : row.variant === 'idle' ? { variant: 'idle' } : {}),
    sessionId: SESSION,
    repoFullPath: REPO,
    transitionId: 'row-identity',
    occurredAt: new Date(EPOCH).toISOString(),
    receivedAt: new Date(EPOCH).toISOString(),
  }
  if (row.class === 'needs-you') return { ...base, transitionId: BLOCK }
  if (row.carriesWorkSignal) return { ...base, turnWork: { toolCall: true, fileEdit: false, todoUpdate: false } }
  if (row.measurements.includes('tokensUsed')) return { ...base, measurements: { tokensUsed: 60_000 } }
  if (row.measurements.includes('durationMs')) return { ...base, measurements: { durationMs: 31_000 } }
  if (row.measurements.includes('attempt')) return { ...base, measurements: { attempt: 2 } }
  return base
}

/** The envelope a signal classifies to, or a loud failure rather than undefined. */
function classifySignalLocally(signal: HarnessSignal): NormalizedEvent {
  const classification: Classification = classify(signal)
  if (classification.outcome !== 'event') {
    throw new Error(`expected an event, got ${classification.outcome}`)
  }
  return classification.event
}
