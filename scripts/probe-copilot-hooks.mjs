#!/usr/bin/env node
// Probe the real GitHub Copilot CLI hook surface and write the consolidated report (CP-2, CP-FR-02, CP-FR-03).
//
// The claim this script exists to settle, the one CP-1 could not answer from the wire: "what
// does the Copilot CLI hook surface offer, and does it carry an idle or a permission signal?"
// PRD section 5 leaves that unresolved, and the adapter question in CP-4 hangs on it. So the
// script installs a hook for every documented event, runs a real session, and writes down what
// actually arrived - including the events that arrived nothing.
//
//   node scripts/probe-copilot-hooks.mjs
//   node scripts/probe-copilot-hooks.mjs --capture tests/scripts/fixtures/<file>.json
//   node scripts/probe-copilot-hooks.mjs --render-only
//
// Shape, per the live-verification-script discipline:
//
//   scripts/probe-copilot-hooks.mjs    pure parsing/recording/judgement/rendering, exported,
//                                       plus a thin shell that owns every side effect
//   tests/scripts/probe-copilot-hooks.test.ts  drives the script over a captured stream, so
//                                       the logic is verified without the binary
//
// Five properties this script must never lose:
//
//   1. Absence of evidence is never reported as a negative finding. A missing binary, an
//      unreadable help surface, or a run in which no hook fired at all exits non-zero and writes
//      NO capture, so a later reader cannot mistake an absent probe for "Copilot has no hooks".
//      There is no code path that writes an empty capture and exits zero.
//   2. Three states per trigger, not two. A trigger is `observed`, `not-triggered` (the session
//      ran and it fired nothing) or `unclear` (it was installed and the evidence about it is
//      missing or unparseable). `absent` is deliberately unreachable: it is a claim about the
//      harness's capabilities, and a black-box probe has no access to those. CP-1's capture made
//      the same argument about a permission request and the gate depends on it.
//   3. Documented is never presented as observed. The trigger list is a vendored snapshot of a
//      cited page, and it is the *hypothesis under test*, not a conclusion. The live run either
//      confirms it event by event or says which events said nothing. The report prints the two
//      side by side, with the source URL and the snapshot date, so a reader can re-check both.
//   4. No conversation content reaches a committed artefact (APX-FR-01). Hook payloads carry the
//      prompt, the tool arguments and the tool's output, so every string is reduced to a length
//      marker unless its key is on the literal allowlist. The allowlist is the protocol vocabulary
//      a reader needs - an event name, a tool name, a stop reason - and it is recorded in the
//      artefact so the policy is re-checkable rather than taken on trust.
//   5. No retry storm and no unbounded wait, and the developer's machine is not the test subject.
//      Every phase has a deadline, the CLI is killed, the Copilot configuration directory and
//      the workspace are both redirected to fresh temporary paths so nothing in the developer's
//      own Copilot installation is read for state or written to, and both are removed on the
//      failure path too.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT_PATH = 'scripts/probe-copilot-hooks.mjs'

export const PROBE_NAME = 'probe-copilot-hooks'
/** Bumped when the capture schema changes, so a later reader can tell the two apart. */
export const ARTIFACT_VERSION = 1

const DEFAULT_CAPTURE = 'docs/research/copilot-hooks-capture.json'
const DEFAULT_ACP_CAPTURE = 'docs/research/copilot-acp-capture.json'
const DEFAULT_REPORT = 'docs/research/copilot-acp-probe.md'
const DEFAULT_BINARY = 'copilot'

const HELP_TIMEOUT_MS = 30_000
const RUN_TIMEOUT_MS = 240_000

/** Where the hook file is written inside the isolated configuration directory. */
const USER_HOOK_FILENAME = 'agent-ping-probe.json'

/**
 * The prompt the driven session sends. It has to reach a tool, because `preToolUse`,
 * `permissionRequest` and `postToolUse` are all tool-scoped: a prompt the model answers from
 * its own knowledge would leave the three most interesting events untriggered and the run would
 * prove nothing about them.
 */
export const PROMPT_WITH_TOOL =
  'Use the shell tool to run the command `ls -la` in the working directory, then reply with exactly DONE.'

// ─────────────────────────────────────────────────────────────────────────────
// The documented surface. Vendored, cited, and treated as a hypothesis under test.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The page the trigger list below is quoted from, and the date the snapshot was taken. Both
 * travel into the artefact and into the report, because a trigger list with no date is a claim
 * nobody can re-check. If a future Copilot release adds or removes an event, this table goes
 * stale and the report says so rather than quietly disagreeing with the binary.
 */
export const DOCUMENTATION_SOURCE = {
  title: 'GitHub Copilot hooks reference',
  url: 'https://docs.github.com/en/copilot/reference/hooks-reference',
  cliHelpCommand: 'copilot help config',
  cliHelpQuote:
    '`hooks`: inline hook definitions, keyed by event name (same schema as .github/hooks/*.json). - ' +
    'In global config.json these act as user-level hooks; in repo settings.json they act as repo-level hooks',
  cliHelpQuoteCommand: 'copilot help config',
  vendoredAt: '2026-09-27',
  retrievedVia: 'web page fetch of the URL above, quoted into this file as the vendored snapshot',
}

/**
 * Every event the reference page lists for Copilot CLI, in the page's own order, with the input
 * keys its payload section documents for the camelCase configuration.
 *
 * This is the *declared* surface. Nothing in the live run is allowed to confirm it on its own:
 * the probe installs a hook for every entry and records whether it fired, and the report shows
 * declared against observed. `documentedInputKeys` is what the page says the payload carries;
 * a key the binary sent that is not on this list is reported as undocumented, which is the
 * direction that catches a page this probe got wrong.
 */
export const DECLARED_TRIGGERS = [
  {
    event: 'agentStop',
    firesWhen: 'The main agent finishes a turn.',
    documentedInputKeys: ['sessionId', 'timestamp', 'cwd', 'transcriptPath', 'stopReason', 'stop_hook_active'],
  },
  { event: 'errorOccurred', firesWhen: 'An error occurs during execution.', documentedInputKeys: ['sessionId', 'timestamp', 'cwd', 'error', 'errorContext', 'recoverable'] },
  {
    event: 'notification',
    firesWhen:
      'Fires asynchronously when the CLI emits a system notification (shell completion, agent completion or idle, permission prompts, elicitation dialogs). Fire-and-forget: never blocks the session.',
    documentedInputKeys: ['sessionId', 'timestamp', 'cwd', 'hook_event_name', 'message', 'title', 'notification_type'],
  },
  { event: 'permissionRequest', firesWhen: 'Fires before the permission service runs (rules engine, session approvals, auto-allow/auto-deny, and user prompting).', documentedInputKeys: ['hookName', 'sessionId', 'timestamp', 'cwd', 'toolName', 'toolInput', 'permissionSuggestions'] },
  { event: 'postToolUse', firesWhen: 'After each tool completes successfully.', documentedInputKeys: ['sessionId', 'timestamp', 'cwd', 'toolName', 'toolArgs', 'toolResult'] },
  { event: 'postToolUseFailure', firesWhen: 'After a tool completes with a failure.', documentedInputKeys: ['sessionId', 'timestamp', 'cwd', 'toolName', 'toolArgs', 'error'] },
  { event: 'preCompact', firesWhen: 'Context compaction is about to begin (manual or automatic).', documentedInputKeys: ['sessionId', 'timestamp', 'cwd', 'transcriptPath', 'trigger', 'customInstructions'] },
  { event: 'preToolUse', firesWhen: 'Before each tool executes.', documentedInputKeys: ['sessionId', 'timestamp', 'cwd', 'toolName', 'toolArgs'] },
  { event: 'sessionEnd', firesWhen: 'The session terminates.', documentedInputKeys: ['sessionId', 'timestamp', 'cwd', 'reason'] },
  { event: 'sessionStart', firesWhen: 'A new or resumed session begins.', documentedInputKeys: ['sessionId', 'timestamp', 'cwd', 'source', 'initialPrompt'] },
  { event: 'subagentStart', firesWhen: 'A subagent is spawned (before it runs).', documentedInputKeys: ['sessionId', 'timestamp', 'cwd', 'transcriptPath', 'agentName', 'agentDisplayName', 'agentDescription'] },
  { event: 'subagentStop', firesWhen: 'A subagent completes.', documentedInputKeys: ['sessionId', 'timestamp', 'cwd', 'transcriptPath', 'agentId', 'agentType', 'agentName', 'agentDisplayName', 'response', 'stopReason'] },
  { event: 'userPromptSubmitted', firesWhen: 'The user submits a prompt.', documentedInputKeys: ['sessionId', 'timestamp', 'cwd', 'prompt'] },
  {
    event: 'userPromptTransformed',
    firesWhen: 'Fires after the runtime transforms a submitted prompt into its model-facing content, just before that content is emitted and persisted to session history.',
    documentedInputKeys: ['sessionId', 'timestamp', 'cwd', 'prompt', 'transformedPrompt'],
  },
]

/**
 * The values the reference page documents for `sessionEnd.reason`, and the ones it documents for
 * the `notification` hook's `notification_type`. Recorded verbatim as two lists so the report can
 * answer "what can a session-end reason express" as *documented* and then show what the binary
 * actually sent, separately. A gate that reads only the observed value would be extrapolating
 * from one run; a gate that reads only the documented list would be trusting a page.
 */
export const DOCUMENTED_SESSION_END_REASONS = ['complete', 'error', 'abort', 'timeout', 'user_exit']
export const DOCUMENTED_NOTIFICATION_TYPES = [
  'shell_completed',
  'shell_detached_completed',
  'agent_completed',
  'agent_idle',
  'permission_prompt',
  'elicitation_dialog',
]

/**
 * The documented meaning of each `notification_type`, because "did an idle signal fire" is a
 * question about the *type*, not about the event. The page describes `agent_idle` as "a
 * background agent finishes a turn and enters idle state (waiting for `write_agent`)", which is
 * a background subagent, not the main agent finishing its turn. Recording that distinction here
 * is what stops "no notification fired" from being read as "there is no idle signal".
 */
export const DOCUMENTED_NOTIFICATION_TYPE_MEANING = {
  shell_completed: 'A background (async) shell command finishes',
  shell_detached_completed: 'A detached shell session completes',
  agent_completed: 'A background subagent finishes (completed or failed)',
  agent_idle: 'A background agent finishes a turn and enters idle state (waiting for `write_agent`)',
  permission_prompt: 'The agent requests permission to execute a tool',
  elicitation_dialog: 'The agent requests additional information from the user',
}

// ─────────────────────────────────────────────────────────────────────────────
// Redaction. The same discipline as CP-1, over payloads that carry more content.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keys whose string values are kept verbatim. Every one is protocol or CLI-authored vocabulary
 * and every one is evidence a reviewer needs: the hook's own name, the runtime tool name, the
 * enum values that say *why* an event fired, the session identifier and the timestamps. Nothing
 * on this list can hold what a developer typed or what a tool printed.
 *
 * The rule is a blanket inversion - any key not listed has its strings reduced to a length
 * marker - so a content-bearing field nobody anticipated is still redacted.
 */
export const LITERAL_KEYS = new Set([
  'hookName',
  'hook_event_name',
  'toolName',
  'sessionId',
  // Enum values. `stopReason` and `reason` are the two the gate reads, and `notification_type`
  // is the only thing that makes a `notification` invocation mean anything.
  'stopReason',
  'reason',
  'source',
  'trigger',
  'notification_type',
  'errorContext',
  'recoverable',
  'resultType',
])

/**
 * Keys documented as content-bearing, recorded in the artefact so the redaction policy is
 * re-checkable. This list is documentation plus the test's leak guard: the capture itself is a
 * blanket rule, so this list is never the only thing standing between a prompt and a commit.
 */
export const CONTENT_BEARING_KEYS = [
  'prompt',
  'initialPrompt',
  'transformedPrompt',
  'toolArgs',
  'toolInput',
  'toolResult',
  'textResultForLlm',
  'error',
  'message',
  'title',
  'response',
  'customInstructions',
  'cwd',
  'transcriptPath',
  'permissionSuggestions',
  'diff',
  'patch',
]

/** Array elements captured before truncation; the real length is always recorded. */
const MAX_ARRAY_ITEMS = 3

/**
 * Reduce a value to its structure: key names and array lengths verbatim, numbers, booleans and
 * nulls verbatim, and a string verbatim only when the key naming it is on the literal allowlist.
 * This is what makes a capture that carries a live tool result safe to commit (APX-FR-01) while
 * still letting a reviewer check every field name the harness sent.
 */
export function captureShape(value, literal = false) {
  if (value === undefined) return { $undefined: true }
  if (value === null) return null
  if (typeof value === 'string') return literal ? value : { $string: value.length }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return {
      $array: value.length,
      items: value.slice(0, MAX_ARRAY_ITEMS).map((item) => captureShape(item)),
    }
  }
  const out = {}
  for (const [key, child] of Object.entries(value)) out[key] = captureShape(child, LITERAL_KEYS.has(key))
  return out
}

/** Every key name appearing anywhere in a value, depth first. */
export function keyNames(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) keyNames(item, out)
    return out
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(key)
      keyNames(child, out)
    }
  }
  return out
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// ─────────────────────────────────────────────────────────────────────────────
// Pure: reading the observed surface out of a captured run.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse the per-event capture files a hook run leaves behind.
 *
 * Each installed hook appends its own stdin to its own file, one JSON document per invocation,
 * so a file that does not exist is an event that did not fire and a file with several lines is
 * an event that fired several times. A line that does not parse is recorded as an *unclear*
 * invocation rather than dropped: a hook that ran and produced something unreadable is a fact,
 * and dropping it would turn a broken capture into a clean one.
 */
export function readInvocations(rawByEvent) {
  const invocations = {}
  const unparsed = []
  for (const [event, raw] of Object.entries(rawByEvent)) {
    const lines = Array.isArray(raw) ? raw : []
    const parsed = []
    for (const [index, line] of lines.entries()) {
      const text = typeof line === 'string' ? line.trim() : ''
      if (text === '') continue
      let payload
      try {
        payload = JSON.parse(text)
      } catch (error) {
        unparsed.push({ event, index, length: text.length, reason: `invalid JSON: ${error.message}` })
        continue
      }
      if (!isObject(payload)) {
        unparsed.push({ event, index, length: text.length, reason: 'payload was not a JSON object' })
        continue
      }
      parsed.push({ index, shape: captureShape(payload) })
    }
    invocations[event] = parsed
  }
  return { invocations, unparsed }
}

/**
 * The three states, applied to one documented trigger. Same vocabulary and same reasoning as
 * CP-1: a black-box probe can establish `observed` and `not-triggered` and nothing stronger, so
 * `absent` is not on the menu. `unclear` is the state that keeps a broken capture from reading
 * as a negative finding.
 */
export function classifyTriggerState({ invocations = [], unparsedForEvent = 0, runCompleted = true }) {
  const count = invocations.length
  if (count > 0) return 'observed'
  if (!runCompleted) return 'unclear'
  if (unparsedForEvent > 0) return 'unclear'
  return 'not-triggered'
}

/**
 * Read every documented trigger's state out of one run. Every declared trigger gets a row,
 * whichever way it fell, and a trigger the run has no evidence for is `unclear` rather than
 * missing - an omitted trigger is indistinguishable from a trigger that does not exist.
 */
export function readTriggerStates({ invocations, unparsed, declared = DECLARED_TRIGGERS, runCompleted = true }) {
  const states = {}
  for (const { event } of declared) {
    const seen = invocations[event] ?? []
    const unparsedForEvent = unparsed.filter((entry) => entry.event === event).length
    const state = classifyTriggerState({ event, invocations: seen, unparsedForEvent, runCompleted })
    states[event] = {
      state,
      invocationCount: seen.length,
      unparsedCount: unparsedForEvent,
      reason:
        state === 'observed'
          ? `${seen.length} invocation(s) captured for this event`
          : state === 'unclear'
            ? 'the event produced no readable payload, so nothing can be said about it'
            : 'the session ran to completion and this event fired nothing during it',
    }
  }
  return states
}

/**
 * The permission path, kept in its own section. A permission signal is the one thing the
 * adapter cannot approximate, so it is never mixed into the ordinary trigger inventory: the
 * event name, the frame kind on the ACP side and the payload keys are recorded side by side.
 */
export function readPermissionPath({ invocations, declared = DECLARED_TRIGGERS }) {
  const event = 'permissionRequest'
  const requests = invocations[event] ?? []
  const declaredKeys = declared.find((entry) => entry.event === event)?.documentedInputKeys ?? []
  return {
    event,
    documented: declared.length > 0,
    documentedInputKeys: declaredKeys,
    invocationCount: requests.length,
    observedInputKeys: requests.length > 0 ? Object.keys(requests[0].shape) : [],
    undocumentedInputKeys:
      requests.length > 0 ? keyNames(requests[0].shape).filter((key) => !declaredKeys.includes(key)) : [],
    payloadKey: 'toolName',
    // Recorded as a value, not a boolean: the gate needs to know which tool the block was for,
    // and the tool name is CLI vocabulary rather than anything a developer wrote.
    toolNames: [...new Set(requests.map((request) => request.shape.toolName).filter((name) => typeof name === 'string'))],
    requests,
  }
}

/**
 * The turn-finished signal, searched for rather than assumed. `agentStop` is the documented
 * per-turn hook; its absence is recorded as not-triggered with the events that *did* fire
 * listed beside it, so a reader can re-check the search rather than trust it.
 */
export function readTurnEndSignal({ invocations, triggerStates }) {
  const stops = invocations.agentStop ?? []
  const stopReasons = [
    ...new Set(stops.map((stop) => stop.shape.stopReason).filter((value) => typeof value === 'string')),
  ]
  const state = triggerStates.agentStop?.state ?? 'unclear'
  return {
    event: 'agentStop',
    state,
    invocationCount: stops.length,
    stopReasons,
    observedInputKeys: stops.length > 0 ? Object.keys(stops[0].shape) : [],
    // The other per-turn candidates, so "agentStop is the turn boundary" is a comparison
    // against what else could have carried it rather than an assertion.
    otherObservedInputKeys: {
      ...Object.fromEntries(
        Object.entries(triggerStates)
          .filter(([event, entry]) => event !== 'agentStop' && entry.invocationCount > 0)
          .map(([event, entry]) => [event, entry.invocationCount]),
      ),
    },
    means:
      state === 'observed'
        ? 'the main agent finishing a turn is directly observable as a hook, in the modes this probe ran'
        : 'no per-turn hook fired, so a turn boundary would have to come from somewhere else',
  }
}

/** The session-end signal and every reason value the run actually produced. */
export function readSessionEndSignal({ invocations, triggerStates }) {
  const ends = invocations.sessionEnd ?? []
  const observedReasons = [
    ...new Set(ends.map((end) => end.shape.reason).filter((value) => typeof value === 'string')),
  ]
  return {
    event: 'sessionEnd',
    state: triggerStates.sessionEnd?.state ?? 'unclear',
    invocationCount: ends.length,
    documentedReasons: DOCUMENTED_SESSION_END_REASONS,
    observedReasons,
    observedInputKeys: ends.length > 0 ? Object.keys(ends[0].shape) : [],
    // The distinction the report has to make: a session-end reason describes the *session*,
    // and the probe drove one prompt into one session, so one reason is what this run can show
    // however many values the enum allows.
    scope:
      'one prompt, one session, one reason: a reason value is a property of how the session ended, not a per-turn classification',
  }
}

/**
 * The idle question, answered as a question about a type rather than about an event.
 *
 * The page documents a `notification` hook whose `agent_idle` type fires when "a background
 * agent finishes a turn and enters idle state". That is a background subagent, so a run with no
 * subagent cannot exercise it, and its silence is therefore `unclear`, not `not-triggered` and
 * emphatically not `absent`. The per-turn alternative, `agentStop`, is read separately and this
 * section points at it rather than silently substituting one for the other.
 */
export function readIdleSignal({ invocations, triggerStates, turnEnd }) {
  const notices = invocations.notification ?? []
  const types = [
    ...new Set(
      notices.map((notice) => notice.shape.notification_type).filter((value) => typeof value === 'string'),
    ),
  ]
  const notificationState = triggerStates.notification?.state ?? 'unclear'
  const idleTypes = types.filter((type) => type === 'agent_idle')
  // Deliberately NOT promoted to `observed` because `agentStop` fired. The question is whether
  // there is a dedicated idle signal *separate from* a finished turn, so a finished-turn signal
  // cannot answer it - doing that is exactly the collapse this report exists to prevent. The
  // per-turn alternative is recorded beside the answer instead.
  //
  // `not-triggered` is reserved for the case where the event actually fired and carried no idle
  // type. An event that fired zero times was never exercised, which is `unclear`: saying the
  // signal was "exercised and said nothing" about a run that produced no invocation at all would
  // be the probe claiming a discrimination it did not make.
  const state = idleTypes.length > 0 ? 'observed' : notices.length > 0 ? 'not-triggered' : 'unclear'
  return {
    question: 'is there a dedicated idle signal for the main agent?',
    documentedEvent: 'notification',
    documentedInputKeys:
      DECLARED_TRIGGERS.find((entry) => entry.event === 'notification')?.documentedInputKeys ?? [],
    documentedTypes: DOCUMENTED_NOTIFICATION_TYPES,
    documentedTypeMeaning: DOCUMENTED_NOTIFICATION_TYPE_MEANING,
    notificationState,
    notificationInvocationCount: notices.length,
    observedNotificationTypes: types,
    // Named separately from `state` so the report can say precisely what is undetermined: the
    // event did not fire, the type that would express idle is documented for a *background*
    // agent, and the driven session spawned no subagent to make it fire.
    state,
    perTurnAlternative: {
      event: 'agentStop',
      state: turnEnd.state,
      note: 'the per-turn signal for the main agent, and the one this probe observed',
    },
    stateMeaning: {
      observed: 'a dedicated idle notification carrying `notification_type: "agent_idle"` was captured in this run',
      'not-triggered': 'the notification event fired and carried no idle type, so the signal was exercised and said nothing',
      unclear:
        'the notification event did not fire, and the documented idle type is scoped to a background agent this run did not start, so nothing can be concluded either way',
    },
  }
}

/**
 * Assemble one run's evidence. Pure, so the test can drive it over a captured run and the live
 * path can drive it over a real one with the same code.
 */
export function buildRunEvidence({
  label,
  mode,
  hookLocation,
  argv,
  hookConfigLocation,
  startedAt,
  finishedAt,
  exitCode,
  runCompleted,
  rawByEvent,
  logLines = [],
  acp = null,
  declared = DECLARED_TRIGGERS,
}) {
  const { invocations, unparsed } = readInvocations(rawByEvent)
  const triggerStates = readTriggerStates({ invocations, unparsed, declared, runCompleted })
  const permission = readPermissionPath({ invocations, declared })
  const turnEnd = readTurnEndSignal({ invocations, triggerStates })
  const sessionEnd = readSessionEndSignal({ invocations, triggerStates })
  const idle = readIdleSignal({ invocations, triggerStates, turnEnd })
  const installedEvents = Object.keys(rawByEvent).sort()
  return {
    label,
    mode,
    hookLocation,
    argv,
    hookConfigLocation,
    startedAt,
    finishedAt,
    exitCode,
    runCompleted,
    invocationTotal: Object.values(invocations).reduce((total, list) => total + list.length, 0),
    installedEvents,
    declaredTriggerCount: declared.length,
    triggerStates,
    invocations,
    unparsedInvocations: unparsed,
    permissionPath: permission,
    turnEndSignal: turnEnd,
    sessionEndSignal: sessionEnd,
    idleSignal: idle,
    acp,
    logEvidence: {
      // The CLI's own account of loading hooks, captured verbatim from its log with paths
      // scrubbed. It is a second, independent witness: a run where the CLI never mentions hooks
      // is evidence about the mode, not just about the probe's capture directory.
      lines: logLines,
      hookLineCount: logLines.length,
    },
  }
}

/** Assemble the whole capture. Pure. */
export function buildCapture({
  cli,
  documentation,
  runs,
  declared = DECLARED_TRIGGERS,
  acpCapture = null,
  acpCapturePath = null,
  acpCaptureReason = null,
}) {
  const pipe = runs.find((run) => run.label === PRIMARY_RUN_LABEL) ?? null
  const runsByLabel = (prefix) => runs.filter((run) => run.label.startsWith(prefix))
  const acpRuns = runsByLabel('acp-')
  const userRuns = runsByLabel('pipe-user').concat(runsByLabel('acp-user'))
  const repoRuns = runsByLabel('pipe-repo').concat(runsByLabel('acp-repo'))
  const invocationsIn = (group) => group.reduce((total, run) => total + run.invocationTotal, 0)
  return {
    probe: PROBE_NAME,
    artifactVersion: ARTIFACT_VERSION,
    recordedBy: { script: SCRIPT_PATH, node: process.version },
    cli,
    documentation: { ...documentation, declaredTriggers: declared },
    declaredTriggers: declared,
    runs,
    /**
     * The three signals the gate actually asks about, each with what the ACP probe found and
     * what the hook probe found, and the mode each finding belongs to. A signal that exists in
     * one mode and not the other is the whole finding: an adapter runs in one mode, so a signal
     * that only exists in the other is not available to it.
     */
    signals: buildSignals({ pipe, acpRuns, userRuns, repoRuns, acpCapture, acpCapturePath, acpCaptureReason }),
    observed: {
      runs: runs.length,
      invocationTotal: runs.reduce((total, run) => total + run.invocationTotal, 0),
      declaredTriggers: declared.length,
      declaredTriggersObserved: pipe === null ? 0 : Object.values(pipe.triggerStates).filter((entry) => entry.state === 'observed').length,
      declaredTriggersNotTriggered: pipe === null ? 0 : Object.values(pipe.triggerStates).filter((entry) => entry.state === 'not-triggered').length,
      declaredTriggersUnclear: pipe === null ? 0 : Object.values(pipe.triggerStates).filter((entry) => entry.state === 'unclear').length,
      /**
       * The location-by-mode matrix, in one place. Which hook locations load in which mode is a
       * different question from which events exist, and the answer decides whether one global
       * install can serve both modes or only one, so it is recorded as a matrix rather than left
       * implicit in four run blocks.
       */
      matrix: [
        { hookLocation: 'user level ($COPILOT_HOME/hooks)', acpMode: invocationsIn(runsByLabel('acp-user')) > 0, pipeMode: invocationsIn(runsByLabel('pipe-user')) > 0, acpInvocations: invocationsIn(runsByLabel('acp-user')), pipeInvocations: invocationsIn(runsByLabel('pipe-user')), runs: runsByLabel('pipe-user').concat(runsByLabel('acp-user')).map((run) => run.label) },
        { hookLocation: 'repository level (.github/hooks)', acpMode: invocationsIn(runsByLabel('acp-repo')) > 0, pipeMode: invocationsIn(runsByLabel('pipe-repo')) > 0, acpInvocations: invocationsIn(runsByLabel('acp-repo')), pipeInvocations: invocationsIn(runsByLabel('pipe-repo')), runs: runsByLabel('pipe-repo').concat(runsByLabel('acp-repo')).map((run) => run.label) },
      ],
      userLevelTotal: invocationsIn(userRuns),
      repositoryLevelTotal: invocationsIn(repoRuns),
      eventsFiredInEveryRun: Object.keys(
        runs
          .flatMap((run) => run.installedEvents)
          .reduce((counts, event) => ({ ...counts, [event]: (counts[event] ?? 0) + 1 }), {}),
      ).filter((event) => runs.length > 0 && runs.every((run) => (run.triggerStates[event]?.invocationCount ?? 0) > 0)),
    },
    redaction: {
      policy:
        'A hook payload is captured structurally. Key names, numbers, booleans, nulls and array lengths are verbatim; ' +
        'a string is kept verbatim only when its key is in redaction.literalKeys and is otherwise replaced by a ' +
        '{"$string": <length>} marker. A hook payload carries the prompt, the tool arguments and the tool output, ' +
        'so this is what keeps conversation content out of a committed artefact (APX-FR-01). The home directory is ' +
        'rewritten to ~ and the probe\'s temporary workspace to <workspace>.',
      literalKeys: [...LITERAL_KEYS].sort(),
      contentBearingKeys: CONTENT_BEARING_KEYS,
      caveat:
        'The hook file the probe installs is deliberately outside any repository: it is written into an isolated ' +
        'COPILOT_HOME so the run cannot depend on, or leave anything in, a developer\'s own Copilot configuration.',
    },
  }
}

/** The three signals, each with both probes' answers and the mode each answer belongs to. */
function buildSignals({ pipe, acpRuns, userRuns, repoRuns, acpCapture, acpCapturePath, acpCaptureReason }) {
  const acpPermission =
    acpCapture === null
      ? { state: 'unavailable', source: acpCapturePath, reason: acpCaptureReason }
      : {
          state: acpCapture.permissionPath?.state ?? 'unclear',
          source: acpCapturePath,
          method: acpCapture.permissionPath?.method ?? null,
          frameKind: acpCapture.permissionPath?.frameKind ?? null,
          note: 'captured by probe-copilot-acp over the ACP wire',
        }
  const acpFinished =
    acpCapture === null
      ? { state: 'unavailable', source: acpCapturePath, reason: acpCaptureReason }
      : {
          state: acpCapture.turnEndSignal?.turnBoundariesObserved === true ? 'observed' : 'unclear',
          mechanism: acpCapture.turnBoundaryMechanism ?? null,
          dedicatedIdleNotificationObserved: acpCapture.dedicatedIdleNotificationObserved ?? null,
          source: acpCapturePath,
        }
  const hookPermission = pipe === null ? { state: 'unavailable' } : { state: pipe.permissionPath.invocationCount > 0 ? 'observed' : 'not-triggered', event: pipe.permissionPath.event, mode: pipe.mode, observedInputKeys: pipe.permissionPath.observedInputKeys }
  const hookFinished = pipe === null ? { state: 'unavailable' } : { state: pipe.turnEndSignal.state, event: pipe.turnEndSignal.event, mode: pipe.mode, stopReasons: pipe.turnEndSignal.stopReasons }
  const total = (runs) => runs.reduce((sum, run) => sum + run.invocationTotal, 0)
  const hookByMode = {
    userLevel: { acpInvocations: total(acpRuns.filter((run) => run.hookLocation === 'user level')), pipeInvocations: total(userRuns.filter((run) => run.hookLocation === 'user level')) },
    repositoryLevel: { acpInvocations: total(acpRuns.filter((run) => run.hookLocation === 'repository level')), pipeInvocations: total(repoRuns.filter((run) => run.hookLocation === 'repository level')) },
  }
  const idleAcp = acpCapture === null ? { state: 'unavailable', reason: acpCaptureReason } : { dedicatedIdleNotificationObserved: acpCapture.dedicatedIdleNotificationObserved ?? null, idleMarkersMatched: acpCapture.turnEndSignal?.idleMarkersMatched ?? null, state: acpCapture.dedicatedIdleNotificationObserved === true ? 'observed' : 'not-triggered' }
  const idleHook = pipe === null ? { state: 'unavailable' } : { state: pipe.idleSignal.state, mode: pipe.mode, observedNotificationTypes: pipe.idleSignal.observedNotificationTypes }
  return {
    permission: {
      question: 'can a permission block be reported?',
      acp: acpPermission,
      hook: hookPermission,
      hookByMode,
    },
    finished: {
      question: 'can a finished turn be reported?',
      acp: acpFinished,
      hook: hookFinished,
      hookByMode,
    },
    idle: {
      question: 'is there a dedicated idle signal, separate from a finished turn?',
      acp: idleAcp,
      hook: idleHook,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the judgement.
// ─────────────────────────────────────────────────────────────────────────────

export const ASSERTIONS_EXPECTED = 10

/**
 * The run the report's per-event table is built from: the documented configuration (a hook file
 * in the user-level hooks directory) in the mode the reference page documents it in. The other
 * three runs exist for the location-by-mode matrix, and their numbers are reported beside it
 * rather than folded into this one.
 */
export const PRIMARY_RUN_LABEL = 'pipe-user'

/**
 * Decide whether this capture is usable evidence. The list is mechanical on purpose: it checks
 * that the probe *observed* what it set out to observe and that it recorded an explicit answer
 * for every question it was asked, and it does not grade the harness. A run in which eight
 * events fired and six did not passes these assertions, because both halves are real evidence;
 * what differs between them is the recorded state, which the gate reads.
 */
export function decide(capture) {
  const assertions = []
  const check = (name, passed, detail) => assertions.push({ name, outcome: passed ? 'pass' : 'fail', detail })
  const pipe = capture.runs.find((run) => run.label === PRIMARY_RUN_LABEL)

  check(
    'cli version captured',
    typeof capture.cli.version === 'string' && /^\d+\.\d+\.\d+/.test(capture.cli.version),
    `version=${capture.cli.version ?? 'none'} output=${JSON.stringify(capture.cli.versionOutput ?? null)}`,
  )
  check(
    'the CLI documents a hook configuration surface of its own',
    capture.documentation.onMachine?.hookConfigDocumented === true,
    `command=${JSON.stringify(capture.documentation.onMachine?.command ?? null)} matched=${JSON.stringify(capture.documentation.onMachine?.hookLines ?? [])}`,
  )
  check(
    'every declared trigger has a hook installed for it',
    pipe !== undefined &&
      pipe.declaredTriggerCount === capture.declaredTriggers.length &&
      capture.declaredTriggers.every((entry) => pipe.installedEvents.includes(entry.event)),
    // The length guard keeps this from passing on an empty declaration list, which is what a
    // probe that quietly installed nothing would look like.
    `declared=${capture.declaredTriggers.length} installed=${JSON.stringify(pipe?.installedEvents ?? [])}`,
  )
  check(
    'at least one hook invocation was captured in the driven session',
    pipe !== undefined && pipe.invocationTotal > 0,
    `invocationTotal=${pipe?.invocationTotal ?? 0} runCompleted=${pipe?.runCompleted ?? false}`,
  )
  check(
    'every captured invocation parsed as a JSON object',
    (pipe?.unparsedInvocations.length ?? 1) === 0,
    `unparsed=${JSON.stringify(pipe?.unparsedInvocations.map((entry) => `${entry.event}:${entry.reason}`) ?? ['no run captured'])}`,
  )
  check(
    'the permission path is recorded distinctly, with its own section',
    pipe !== undefined &&
      pipe.permissionPath.invocationCount > 0 &&
      pipe.permissionPath.observedInputKeys.length > 0 &&
      pipe.permissionPath.toolNames.length > 0,
    `event=${pipe?.permissionPath.event ?? 'none'} count=${pipe?.permissionPath.invocationCount ?? 0} keys=${JSON.stringify(pipe?.permissionPath.observedInputKeys ?? [])} tools=${JSON.stringify(pipe?.permissionPath.toolNames ?? [])}`,
  )
  check(
    'a turn-finished signal was captured with a stop reason',
    pipe !== undefined && pipe.turnEndSignal.state === 'observed' && pipe.turnEndSignal.stopReasons.length > 0,
    `event=${pipe?.turnEndSignal.event ?? 'none'} state=${pipe?.turnEndSignal.state ?? 'none'} stopReasons=${JSON.stringify(pipe?.turnEndSignal.stopReasons ?? [])}`,
  )
  check(
    'a session-end signal was captured with a reason',
    pipe !== undefined && pipe.sessionEndSignal.state === 'observed' && pipe.sessionEndSignal.observedReasons.length > 0,
    `state=${pipe?.sessionEndSignal.state ?? 'none'} observed=${JSON.stringify(pipe?.sessionEndSignal.observedReasons ?? [])} documented=${JSON.stringify(DOCUMENTED_SESSION_END_REASONS)}`,
  )
  check(
    'the idle question has an explicit state and names the per-turn alternative',
    pipe !== undefined &&
      ['observed', 'not-triggered', 'unclear'].includes(pipe.idleSignal.state) &&
      pipe.idleSignal.perTurnAlternative.event === 'agentStop',
    `state=${pipe?.idleSignal.state ?? 'none'} notification=${pipe?.idleSignal.notificationState ?? 'none'} types=${JSON.stringify(pipe?.idleSignal.observedNotificationTypes ?? [])} perTurn=${pipe?.idleSignal.perTurnAlternative.state ?? 'none'}`,
  )
  check(
    'every declared trigger carries an explicit state and the location-by-mode matrix is complete',
    pipe !== undefined &&
      capture.declaredTriggers.every((entry) => pipe.triggerStates[entry.event] !== undefined) &&
      Object.values(pipe.triggerStates).every((entry) => ['observed', 'not-triggered', 'unclear'].includes(entry.state)) &&
      !Object.values(pipe.triggerStates).some((entry) => entry.state === 'absent') &&
      capture.observed.matrix.length === 2 &&
      capture.observed.matrix.every((row) => row.runs.length === 2),
    // The `absent` check is the load-bearing half: it fails if a future change ever lets the
    // state vocabulary grow the one state a black-box probe has no business recording.
    `stated=${Object.keys(pipe?.triggerStates ?? {}).length}/${capture.declaredTriggers.length} matrix=${JSON.stringify(capture.observed.matrix.map((row) => `${row.hookLocation}: acp=${row.acpInvocations} pipe=${row.pipeInvocations}`))} hasAbsentState=${Object.values(pipe?.triggerStates ?? {}).some((entry) => entry.state === 'absent')}`,
  )

  const failures = assertions
    .filter((assertion) => assertion.outcome === 'fail')
    .map((assertion) => `${assertion.name}: ${assertion.detail}`)
  if (assertions.length < ASSERTIONS_EXPECTED) {
    failures.push(
      `executed ${assertions.length} of ${ASSERTIONS_EXPECTED} assertions; a green result that exercised nothing is not a pass`,
    )
  }
  return {
    verdict: failures.length === 0 ? 'pass' : 'fail',
    exitCode: failures.length === 0 ? 0 : 1,
    assertionsExpected: ASSERTIONS_EXPECTED,
    assertionsRun: assertions.length,
    assertions,
    failures,
  }
}

/** The findings a reader comes for, at the top of the capture and on stdout. */
export function findings(capture) {
  const pipe = capture.runs.find((run) => run.label === PRIMARY_RUN_LABEL)
  const matrix = capture.observed.matrix
  return {
    permissionHookObserved: (pipe?.permissionPath.invocationCount ?? 0) > 0,
    permissionAcpObserved: capture.signals.permission.acp.state === 'observed',
    turnFinishedHookObserved: pipe?.turnEndSignal.state === 'observed',
    dedicatedIdleHookState: pipe?.idleSignal.state ?? 'unavailable',
    userLevelHooksFireInAcpMode: matrix.find((row) => row.hookLocation.startsWith('user'))?.acpMode === true,
    repositoryLevelHooksFireInAcpMode: matrix.find((row) => row.hookLocation.startsWith('repository'))?.acpMode === true,
    declaredTriggersObserved: capture.observed.declaredTriggersObserved,
    declaredTriggersTotal: capture.observed.declaredTriggers,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the consolidated report. One artefact, both probes, re-checkable.
// ─────────────────────────────────────────────────────────────────────────────

const NOT_OBSERVED = '_not observed: no capture for this probe was available when the report was rendered_'

/** A markdown table cell that cannot hold a raw multi-line string. */
function cell(value) {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.length === 0 ? '_(none)_' : value.map((item) => `\`${item}\``).join('<br>')
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/** A row for something that was not observed, kept in the table rather than dropped from it. */
function rowOrNotObserved(cells, available) {
  return available ? `| ${cells.map(cell).join(' | ')} |` : `| ${cells.map(() => NOT_OBSERVED).join(' | ')} |`
}

const STATE_MEANING = {
  observed: 'the probe captured at least one real invocation or notification of this signal',
  'not-triggered': 'the surface ran and this signal fired nothing, so the signal exists in the harness but was silent in this run',
  unclear: 'the probe has no usable evidence either way, so no conclusion is recorded',
  absent:
    'NEVER recorded by this probe. Absence is a claim about the harness\'s capabilities, which a black-box probe cannot make: the probe can show what fired and what stayed quiet, never what does not exist',
}

/**
 * Render the consolidated report from both captures.
 *
 * Every section is written from the capture, never from memory: a section whose capture is
 * missing says so in place and keeps its row in its table. That is the property the test pins -
 * a missing capture has to read as "not observed", because a report that quietly drops a
 * section is a report whose silence a gate cannot distinguish from a negative finding.
 */
export function renderReport({ hooksCapture, acpCapture, hooksCapturePath, acpCapturePath, generatedAt }) {
  const hooksAvailable = hooksCapture !== null && hooksCapture !== undefined
  const acpAvailable = acpCapture !== null && acpCapture !== undefined
  const pipe = hooksAvailable ? hooksCapture.runs.find((run) => run.label === PRIMARY_RUN_LABEL) : null
  const declared = hooksAvailable ? hooksCapture.declaredTriggers : DECLARED_TRIGGERS
  const matrix = hooksAvailable ? hooksCapture.observed.matrix : []
  const lines = []
  const push = (...parts) => lines.push(...parts)

  push(
    '# Copilot CLI probe report: ACP surface and hook surface',
    '',
    '> Generated by `scripts/probe-copilot-hooks.mjs` from two machine-written captures. Every claim below is',
    '> either quoted from a capture file named in the same row or explicitly marked as not observed. Nothing here',
    '> is a decision, and no adapter code depends on it: this report exists so that whoever decides can re-check',
    '> the conclusion rather than trust it.',
    '',
    `- Report generated: \`${generatedAt}\``,
    `- Hook-surface capture: \`${hooksCapturePath}\`${hooksAvailable ? '' : ' _(not available when this report was rendered)_'}`,
    `- ACP-surface capture: \`${acpCapturePath}\`${acpAvailable ? '' : ' _(not available when this report was rendered)_'}`,
    '',
    '## 1. What was probed, and with what',
    '',
    '| Probe | Binary | Exact version | Started | Finished | Runs |',
    '| --- | --- | --- | --- | --- | --- |',
  )
  push(
    `| \`probe-copilot-acp\` (CP-1) | \`${cell(acpAvailable ? acpCapture.cli?.binary : null)}\` | \`${cell(acpAvailable ? acpCapture.cli?.version : null)}\` | \`${cell(acpAvailable ? acpCapture.timestamps?.startedAt : null)}\` | \`${cell(acpAvailable ? acpCapture.timestamps?.finishedAt : null)}\` | 1 (ACP mode over stdio) |`,
  )
  push(
    `| \`probe-copilot-hooks\` (CP-2) | \`${cell(hooksAvailable ? hooksCapture.cli?.binary : null)}\` | \`${cell(hooksAvailable ? hooksCapture.cli?.version : null)}\` | \`${cell(hooksAvailable ? hooksCapture.runs?.[0]?.startedAt : null)}\` | \`${cell(hooksAvailable ? hooksCapture.runs?.[hooksCapture.runs.length - 1]?.finishedAt : null)}\` | ${cell(hooksAvailable ? hooksCapture.runs?.map((run) => `${run.label} — ${run.mode}, ${run.hookLocation}`).join('<br>') : null)} |`,
  )
  push(
    '',
    'The two probes are the same binary and the same machine on the same day, which is what makes the',
    'comparison in section 8 meaningful. Within the hook probe, each of the four runs is the same binary in the',
    'same workspace, and the only things that change are the mode it was launched in and where the hook file was',
    'installed.',
    '',
    '### What each probe did, in one line',
    '',
    hooksAvailable
      ? '- `probe-copilot-hooks` installed a command hook for every documented event, into an isolated `COPILOT_HOME` and into a throwaway repository in turn, and ran a real session in each of the four resulting combinations, capturing the real stdin payload of every invocation.'
      : '- `probe-copilot-hooks`: ' + NOT_OBSERVED,
    acpAvailable
      ? '- `probe-copilot-acp` performed the ACP `initialize` handshake, created a session, and drove one turn that had to reach a tool and one that had not, recording every JSON-RPC frame.'
      : '- `probe-copilot-acp`: ' + NOT_OBSERVED,
    '',
    '### The environment the hook probe ran in, and what it changes',
    '',
    hooksAvailable && hooksCapture.documentation?.environmentCaveat?.trustOptIn
      ? `- \`${cell(hooksCapture.documentation.environmentCaveat.trustOptIn)}\` was set. ${cell(hooksCapture.documentation.environmentCaveat.why)}.`
      : `- ${NOT_OBSERVED}: the capture records no environment caveat, so nothing can be said about what the run's own environment changed.`,
    '',
    hooksAvailable && hooksCapture.documentation?.environmentCaveat?.effectOnPermissionEvidence
      ? `> **Read this before reading section 5.** ${cell(hooksCapture.documentation.environmentCaveat.effectOnPermissionEvidence)}`
      : `> **Read this before reading section 5.** ${NOT_OBSERVED}: without the environment caveat, an empty agent-request list in this report's own ACP rows could be misread as evidence about the ACP permission signal.`,
    '',
    '## 2. The documented hook trigger surface',
    '',
    'The trigger list below is **documented**, not observed: it is vendored from',
    `[${DOCUMENTATION_SOURCE.title}](${DOCUMENTATION_SOURCE.url}), snapshot taken ${DOCUMENTATION_SOURCE.vendoredAt},`,
    'and quoted into the probe so it can be tested rather than believed. The `state` column is the **observed**',
    'result of installing a hook for that event and running a real session.',
    '',
    'The binary corroborates the configuration surface from its own help, captured live during the probe run:',
    '',
    '```',
    cell(hooksAvailable ? hooksCapture.documentation?.onMachine?.command : null),
    '```',
    '',
    hooksAvailable && hooksCapture.documentation?.onMachine?.hookLines?.length > 0
      ? hooksCapture.documentation.onMachine.hookLines.map((line) => `> ${line}`).join('\n')
      : `> ${NOT_OBSERVED}`,
    '',
    '| Documented event | Fires when (documented) | Documented camelCase input keys | Observed state (primary run `pipe-user`) | Invocations |',
    '| --- | --- | --- | --- | --- |',
  )
  for (const entry of declared) {
    const state = pipe?.triggerStates?.[entry.event]
    push(
      `| \`${entry.event}\` | ${cell(entry.firesWhen)} | ${cell(entry.documentedInputKeys)} | ${state ? `\`${state.state}\`` : NOT_OBSERVED} | ${state ? cell(state.invocationCount) : NOT_OBSERVED} |`,
    )
  }
  push(
    '',
    `${hooksAvailable ? `**${hooksCapture.observed.declaredTriggersObserved} of ${hooksCapture.observed.declaredTriggers}**` : NOT_OBSERVED} documented triggers fired in the driven session. Every one of the ${declared.length} has a state; none was omitted.`,
    '',
    '### 2.1 Events the reference page documents but the driven session did not exercise',
    '',
  )
  const notTriggered = declared.filter((entry) => pipe?.triggerStates?.[entry.event]?.state === 'not-triggered')
  if (notTriggered.length === 0) {
    push(`- ${NOT_OBSERVED}: either no declared trigger was left untriggered, or the capture is unavailable.`)
  } else {
    for (const entry of notTriggered) {
      push(
        `- \`${entry.event}\` — ${cell(pipe.triggerStates[entry.event].reason)}. The driven session was one prompt with one tool call; an event scoped to a subagent, a compaction or an error was never going to fire, so its silence says nothing about whether the harness can produce it.`,
      )
    }
  }
  push(
    '',
    '## 3. The captured payloads',
    '',
    'Each invocation is captured structurally: field names, numbers, booleans and array lengths verbatim, and',
    'every other string replaced by a length marker, so a live prompt and a live tool result cannot reach a',
    'committed artefact (APX-FR-01). The policy and its literal-key allowlist are recorded in both captures under',
    '`redaction`.',
    '',
    '| Event | Invocations | Keys the binary sent | Keys the page documents | Top-level key sent but undocumented | Tool names seen |',
    '| --- | --- | --- | --- | --- | --- |',
  )
  for (const entry of declared) {
    const state = pipe?.triggerStates?.[entry.event]
    const invocations = pipe?.invocations?.[entry.event] ?? []
    const first = invocations[0]
    const permission = entry.event === 'permissionRequest' ? pipe?.permissionPath : null
    const observedKeys = first ? Object.keys(first.shape) : permission?.observedInputKeys ?? []
    // Top-level keys only, and never a redaction marker. A nested key such as `command` inside
    // `toolArgs` is part of a value the page documents as `unknown`, so reporting it as
    // "undocumented" would be the probe grading the page on a field the page never claimed.
    // `$string`/`$array`/`items` are this probe's own vocabulary, not the harness's.
    const markers = new Set(['$string', '$array', '$undefined', 'items'])
    const undocumented = observedKeys.filter((key) => !entry.documentedInputKeys.includes(key) && !markers.has(key))
    const tools = entry.event === 'permissionRequest' ? (permission?.toolNames ?? []) : first && typeof first.shape.toolName === 'string' ? [first.shape.toolName] : []
    push(
      rowOrNotObserved(
        [
          `\`${entry.event}\``,
          state?.invocationCount,
          observedKeys,
          entry.documentedInputKeys,
          undocumented,
          tools,
        ],
        hooksAvailable,
      ),
    )
  }
  push(
    '',
    '### 3.1 The permission payload, verbatim in structure',
    '',
    pipe === null
      ? NOT_OBSERVED
      : '```json',
    pipe === null
      ? ''
      : JSON.stringify(pipe.invocations.permissionRequest?.[0]?.shape ?? null, null, 2),
    pipe === null ? '' : '```',
    '',
    '`toolName` and `sessionId` survive verbatim because they are the vocabulary a reviewer needs; `toolInput`',
    'survives as a shape with every string reduced, because it is the command the model wanted to run.',
    '',
    '## 4. Is there an idle signal?',
    '',
    'This is the question the whole feature turns on, so it is answered twice: once for the ACP wire and once for',
    'the hook surface, and the two answers are not the same shape.',
    '',
    '| Surface | Idle-equivalent signal | State | Evidence |',
    '| --- | --- | --- | --- |',
    `| ACP (the mode an adapter would drive) | a dedicated idle notification | ${acpAvailable ? `\`${cell(acpCapture.signalsIdleState ?? (acpCapture.dedicatedIdleNotificationObserved === true ? 'observed' : 'not-triggered'))}\`` : NOT_OBSERVED} | ${acpAvailable ? `every notification method and every \`sessionUpdate\` variant the CLI emitted was searched; the idle markers that matched were ${JSON.stringify(acpCapture.turnEndSignal?.idleMarkersMatched ?? [])}` : NOT_OBSERVED} |`,
    `| Hooks, \`copilot -p\` | \`agentStop\` — the main agent finishing a turn | ${pipe ? `\`${cell(pipe.turnEndSignal.state)}\`` : NOT_OBSERVED} | ${pipe ? `${cell(pipe.turnEndSignal.invocationCount)} invocation(s), \`stopReason\` ${JSON.stringify(pipe.turnEndSignal.stopReasons)}` : NOT_OBSERVED} |`,
    `| Hooks, \`copilot -p\` | \`notification\` with \`notification_type: "agent_idle"\` | ${pipe ? `\`${cell(pipe.idleSignal.state)}\`` : NOT_OBSERVED} | ${pipe ? (pipe.idleSignal.notificationInvocationCount > 0 ? `the \`notification\` event fired ${cell(pipe.idleSignal.notificationInvocationCount)} time(s); the types it emitted were ${JSON.stringify(pipe.idleSignal.observedNotificationTypes)}` : `the \`notification\` event fired 0 time(s), so none of its ${DOCUMENTED_NOTIFICATION_TYPES.length} documented types were exercised — see section 10`) : NOT_OBSERVED} |`,
    '',
    '**The answer, stated plainly:**',
    '',
    pipe === null
      ? NOT_OBSERVED
      : `- There is **no dedicated idle notification** on the ACP wire at Copilot CLI ${cell(hooksCapture.cli?.version)}: ${acpAvailable ? `no notification method or \`sessionUpdate\` variant the CLI emitted matched an idle marker, and the turn boundary is instead ${cell(acpCapture.turnBoundaryMechanism)}` : 'the ACP capture was unavailable when this report was rendered'}.`,
    pipe === null
      ? ''
      : `- The \`notification\` hook is the only documented idle-*shaped* event, and its \`agent_idle\` type is documented as "${cell(DOCUMENTED_NOTIFICATION_TYPE_MEANING.agent_idle)}" — a **background** agent waiting on \`write_agent\`, not the main agent finishing a turn. The driven session started no subagent, so this probe cannot exercise that type: the state recorded is \`${pipe.idleSignal.state}\`, not \`absent\`.`,
    pipe === null
      ? ''
      : `- The per-turn signal that *was* observed is the \`agentStop\` hook, carrying \`stopReason: ${JSON.stringify(pipe.turnEndSignal.stopReasons)}\` and \`stop_hook_active\`. It is a per-turn boundary, which is the shape agent-ping's finished class needs.`,
    '',
    'The documented notification types, for the record:',
    '',
    '| `notification_type` | Documented meaning |',
    '| --- | --- |',
    ...DOCUMENTED_NOTIFICATION_TYPES.map((type) => `| \`${type}\` | ${cell(DOCUMENTED_NOTIFICATION_TYPE_MEANING[type])} |`),
    '',
    '## 5. Is there a permission signal?',
    '',
    '| Surface | Signal | State | Mode it belongs to | Evidence |',
    '| --- | --- | --- | --- | --- |',
    `| ACP | ${acpAvailable ? `\`${cell(acpCapture.permissionPath?.method)}\`` : NOT_OBSERVED} (an agent-to-client **request** carrying a decision) | ${hooksAvailable ? cell(hooksCapture.signals.permission.acp.state) : NOT_OBSERVED} | ACP over stdio | ${acpAvailable ? `\`${acpCapture.permissionPath.state}\`, ${cell(acpCapture.permissionPath.requestCount)} request(s), options ${JSON.stringify((acpCapture.permissionPath.requests ?? []).map((request) => request.options.map((option) => option.optionId)))}` : NOT_OBSERVED} |`,
    `| Hooks | \`permissionRequest\` (a command hook) | ${pipe ? cell(pipe.permissionPath.invocationCount > 0 ? 'observed' : 'not-triggered') : NOT_OBSERVED} | ${pipe ? cell(pipe.mode) : NOT_OBSERVED} | ${pipe ? `${cell(pipe.permissionPath.invocationCount)} invocation(s) for tool ${JSON.stringify(pipe.permissionPath.toolNames)}` : NOT_OBSERVED} |`,
    '',
    'The two signals are not interchangeable and the report does not treat them as such:',
    '',
    '- The ACP one is a **request** the agent makes of the client, carrying an `outcome` with a chosen `optionId`. It is the stronger signal, because the client must answer it or the tool does not run.',
    '- The hook one is a **command** the CLI runs before its permission service, and it can be answered with `{"behavior":"allow"}` or `{"behavior":"deny"}`. It fires whether or not a human is ever asked.',
    pipe === null || acpAvailable === false
      ? ''
      : `- Both were observed in their own mode. The decisive question for an adapter is which mode it can run in, which is section 8.`,
    '',
    '## 6. What can a session-end reason express?',
    '',
    '| | Values |',
    '| --- | --- |',
    `| Documented \`sessionEnd.reason\` | ${cell(DOCUMENTED_SESSION_END_REASONS)} |`,
    `| Observed in this run | ${pipe ? cell(pipe.sessionEndSignal.observedReasons) : NOT_OBSERVED} |`,
    `| Observed \`stopReason\` on \`agentStop\` (per turn, not per session) | ${pipe ? cell(pipe.turnEndSignal.stopReasons) : NOT_OBSERVED} |`,
    '',
    'The scope matters more than the enum. A `sessionEnd` reason describes **how a session ended**, and this probe',
    `drove one prompt into one session, so ${pipe ? cell(pipe.sessionEndSignal.observedReasons) : NOT_OBSERVED} is the only value it can show. A session-end reason is therefore **not** a substitute for a per-turn idle or finished signal: it arrives once, at the end, and says nothing about the turn that just completed. The per-turn equivalent is \`agentStop\` with \`stopReason\`, in section 4.`,
    '',
    '## 7. The four hook runs, side by side',
    '',
    '| | ' + (hooksAvailable ? hooksCapture.runs.map((run) => `${run.label} — ${run.mode}`).join(' | ') : 'hook runs') + ' |',
    '| --- | ' + (hooksAvailable ? hooksCapture.runs.map(() => '---').join(' | ') : '---') + ' |',
  )
  const comparison = [
    ['started at', (run) => run.startedAt],
    ['finished at', (run) => run.finishedAt],
    ['argv', (run) => run.argv],
    ['hook file installed at', (run) => run.hookConfigLocation],
    ['run completed', (run) => run.runCompleted],
    ['exit code', (run) => run.exitCode],
    ['hook invocations captured', (run) => run.invocationTotal],
    ['lines the CLI log mentions hooks', (run) => run.logEvidence.hookLineCount],
    ['permission invocations', (run) => run.permissionPath.invocationCount],
    ['turn-finished invocations', (run) => run.turnEndSignal.invocationCount],
  ]
  if (hooksAvailable) {
    for (const [label, read] of comparison) {
      push(`| ${cell(label)} | ${hooksCapture.runs.map((run) => cell(read(run))).join(' | ')} |`)
    }
  } else {
    push(`| ${NOT_OBSERVED} | ${NOT_OBSERVED} |`)
  }
  push(
    '',
    '### What the CLI log said, verbatim',
    '',
    'The CLI writes its own account of loading hooks into its log, under the isolated configuration',
    'directory. It is a second, independent witness: a run in which the CLI never mentions hooks is a',
    'different fact from a run in which the probe found no capture file, and only having both lets a reader',
    'tell a silent signal from a signal that was never wired up.',
    '',
  )
  for (const run of hooksAvailable ? hooksCapture.runs : []) {
    push(`**${run.label}** (${run.mode}, ${run.hookLocation}) — ${run.logEvidence.hookLineCount} line(s) mentioning hooks:`)
    push('')
    if (run.logEvidence.lines.length === 0) {
      push(
        run.invocationTotal > 0
          ? `- The log said nothing about hooks, yet ${cell(run.invocationTotal)} invocation(s) were captured. The CLI loads this location silently in this mode; its log is therefore not a reliable witness for whether hooks were active.`
          : `- The log contained no line mentioning hooks and no payload was captured. One silent witness is not enough to call a signal absent — see section 9.`,
      )
    } else {
      for (const logLine of run.logEvidence.lines) push(`- \`${logLine}\``)
    }
    push('')
  }
  push(
    '## 8. Where hooks load, and in which mode — the finding an adapter has to live with',
    '',
    'The reference page documents two hook locations. Whether the CLI loads each of them in each mode is not',
    'stated as being the same, and it decides whether one global install can serve both modes or only one. The',
    'probe installed each location in turn and ran each mode, so the answer is a measured matrix rather than an',
    'assumption:',
    '',
    '| Hook file installed at | Non-interactive prompt mode (`copilot -p`) | ACP mode (`copilot --acp`) |',
    '| --- | --- | --- |',
  )
  for (const row of matrix) {
    push(
      `| ${cell(row.hookLocation)} | ${cell(row.pipeInvocations)} invocation(s) — ${row.pipeMode ? 'fires' : '**nothing captured**'} | ${cell(row.acpInvocations)} invocation(s) — ${row.acpMode ? 'fires' : '**nothing captured**'} |`,
    )
  }
  push(
    '',
    hooksAvailable
      ? `Read that table with section 1's environment caveat. The strongest statement the capture supports is: **a user-level hook file was observed firing in ACP mode as well as in non-interactive prompt mode, at Copilot CLI ${cell(hooksCapture.cli?.version)}.**`
      : NOT_OBSERVED,
    '',
    matrix.length === 0 || matrix[1].acpInvocations > 0
      ? 'For the repository-level location the two modes agreed in this run, so there is no mode differential to report for it.'
      : `For the repository-level location the modes **disagreed**: ${cell(matrix[1].pipeInvocations)} invocation(s) in non-interactive prompt mode against ${cell(matrix[1].acpInvocations)} in ACP mode, in the same workspace with the same hook file. Two readings are consistent with that, and this probe does not choose between them: (a) ACP mode does not load repository-level hooks, or (b) ACP mode loads them and something specific to this workspace, version or run prevented it. What the capture does establish is narrower and sufficient: **no repository-level hook payload was observed in ACP mode in this run**, so a repository-level install cannot be relied on to serve ACP mode.`,
    '',
    'Two further observations that bear on the same question, both from the capture rather than from the page:',
    '',
    `- The hook mechanism is **one command process per invocation, with the payload on its stdin**. Every captured payload arrived that way. Nothing in this capture shows a long-lived process being handed events, and a reader should not infer one.`,
    `- Tools were auto-approved in every run (section 1), and \`permissionRequest\` fired anyway — ${cell(pipe?.permissionPath.invocationCount ?? 0)} time(s). The page says the hook runs *before* the permission service, and this is the run that shows it, which is the reason a hook permission signal cannot be dismissed as "just the prompt".`,
    '',
    hooksAvailable
      ? `The ACP runs in this probe emitted ${cell((hooksCapture.runs.filter((run) => run.label.startsWith('acp-'))[0]?.acp?.agentRequestMethods ?? []).length)} agent-to-client request method(s), because auto-approval removed the need to ask. That is an artefact of the probe environment, recorded in section 1, and it is **not** a finding about the ACP permission signal: CP-1 ran the same binary without that flag and captured \`${cell(acpAvailable ? acpCapture.permissionPath?.method : null)}\`.`
      : '',
    '',
    '## 9. Absent, not triggered, and unclear — and why `absent` never appears here',
    '',
    '| State | What it means | What it licenses a gate to do |',
    '| --- | --- | --- |',
    `| \`observed\` | ${cell(STATE_MEANING.observed)} | rely on the signal, and say so with the version it was observed on |`,
    `| \`not-triggered\` | ${cell(STATE_MEANING['not-triggered'])} | treat the signal as existing but unproven in practice; an adapter built on it needs a stated degradation |`,
    `| \`unclear\` | ${cell(STATE_MEANING.unclear)} | refuse any mapping built on it — this report says nothing either way |`,
    `| \`absent\` | ${cell(STATE_MEANING.absent)} | nothing, because nothing can reach this state |`,
    '',
    'Collapsing these three is how a class gets authorised on a signal that merely happened to be quiet during one',
    'probe. The states degrade differently downstream: `observed` can be relied on, `not-triggered` means the signal',
    'exists but said nothing, and `unclear` means nothing can be said at all. A gate reading this report should',
    'refuse any mapping built on an `unclear` state.',
    '',
    '## 10. What was not observed',
    '',
    'Stated explicitly, because a reader who trusts a report\'s silence learns the wrong thing from it:',
    '',
  )
  const notObserved = []
  if (notTriggered.length > 0) {
    for (const entry of notTriggered) notObserved.push(`\`${entry.event}\` never fired during the driven session, which started no subagent, caused no error and compacted nothing.`)
  }
  if (acpAvailable && acpCapture.dedicatedIdleNotificationObserved === false) {
    notObserved.push('No dedicated idle notification was observed on the ACP wire. The search covered every notification method and every `sessionUpdate` variant the CLI emitted; the set it emitted is in the ACP capture, so the search is re-checkable rather than asserted.')
  }
  for (const row of matrix) {
    if (row.acpInvocations === 0 && row.pipeInvocations > 0) {
      notObserved.push(
        `No ${cell(row.hookLocation)} hook payload was observed in ACP mode: ${cell(row.acpInvocations)} invocations there against ${cell(row.pipeInvocations)} in the same workspace in non-interactive prompt mode. Whether ACP mode does not load that location at all, or loaded it and something specific to this run prevented it, is not resolved by this capture — see section 8.`,
      )
    }
    if (row.acpInvocations === 0 && row.pipeInvocations === 0) {
      notObserved.push(`No ${cell(row.hookLocation)} hook payload was observed in either mode. The reference page documents the location, and this run produced no evidence that the CLI loads it, which is a weaker statement than "the location does not work".`)
    }
  }
  if (hooksAvailable) {
    notObserved.push(
      `The \`notification\` hook's documented idle type \`agent_idle\` is scoped to a background agent waiting on \`write_agent\`, and the driven session started no subagent. Its state is \`${cell(pipe?.idleSignal.state ?? 'unavailable')}\`, not \`absent\`.`,
    )
  }
  if (pipe !== null) {
    const markers = new Set(['$string', '$array', '$undefined', 'items'])
    for (const entry of declared) {
      const first = pipe.invocations?.[entry.event]?.[0]
      if (first === undefined) continue
      const undocumented = Object.keys(first.shape).filter(
        (key) => !entry.documentedInputKeys.includes(key) && !markers.has(key),
      )
      if (undocumented.length > 0) {
        notObserved.push(
          `\`${entry.event}\` sent a top-level field the reference page does not document for it: ${undocumented.map((key) => `\`${key}\``).join(', ')}. Either the page is behind this CLI version or the payload carries something new; the capture does not say which.`,
        )
      }
    }
    if (pipe.sessionEndSignal.observedReasons.length < DOCUMENTED_SESSION_END_REASONS.length) {
      notObserved.push(`\`sessionEnd.reason\` was observed only as ${JSON.stringify(pipe.sessionEndSignal.observedReasons)}; the other documented reasons (${DOCUMENTED_SESSION_END_REASONS.filter((reason) => !pipe.sessionEndSignal.observedReasons.includes(reason)).join(', ')}) were not exercised, because producing them needs a session that is aborted, times out or errors.`)
    }
    for (const type of DOCUMENTED_NOTIFICATION_TYPES) {
      if (pipe.idleSignal.observedNotificationTypes.includes(type)) continue
      // The wording has to follow the evidence. If the event fired at all, a type it did not
      // emit is a real observation about that type. If the event never fired, the type was
      // never exercised, and saying the event "never emitted" it would be claiming a
      // discrimination this run cannot make.
      notObserved.push(
        pipe.idleSignal.notificationInvocationCount > 0
          ? `\`notification_type: "${type}"\` was not observed. The \`notification\` hook fired ${cell(pipe.idleSignal.notificationInvocationCount)} time(s) in this run and emitted other types, so this is a real observation about that type rather than a gap in the search.`
          : `\`notification_type: "${type}"\` was not exercised: the \`notification\` hook fired 0 time(s), so this run says nothing about the type either way.`,
      )
    }
  }
  notObserved.push('The `subagentStart`/`subagentStop` pair was not exercised, so nothing is known about subagent lifecycle signals from this probe.')
  notObserved.push('The policy hook directory, the plugin-contributed hooks, the PascalCase VS Code-compatible payload format and the HTTP hook type were not probed. They are documented in the reference page and out of scope for this report.')
  if (notObserved.length === 0) notObserved.push(`${NOT_OBSERVED}: no capture was available, so nothing can be listed.`)
  push(...notObserved.map((entry) => `- ${entry}`))
  push(
    '',
    '## 11. Scope',
    '',
    'This report records what two probes saw. It contains **no decision** and **no adapter code**: which signals may',
    'map to which class, what a missed signal does, and whether a Copilot adapter ships at all are a human gate',
    'recorded separately against this evidence.',
    '',
    'Re-check any row by re-running the two probes against the binary version named in section 1 and comparing',
    'the captures; the assertions and the exit code of each probe are in the capture\'s `decision` block, so a run',
    'that exercised nothing fails rather than passing quietly.',
    '',
  )
  return `${lines.join('\n')}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Impure: the shell. Everything below owns a side effect.
// ─────────────────────────────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString()
const progress = (message) => process.stderr.write(`[${PROBE_NAME}] ${message}\n`)
const emitSummary = (summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)

class ProbeFailure extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ProbeFailure'
    this.code = code
  }
}

class ProbeTimeout extends Error {
  constructor(label, timeoutMs) {
    super(`timed out after ${timeoutMs}ms waiting for ${label}`)
    this.name = 'ProbeTimeout'
  }
}

/** Rewrite the operator's home directory and the probe's own temporary paths, recursively. */
function scrubPaths(value) {
  const home = homedir()
  // The probe's own temporary root carries a random suffix, so it is matched by shape. A path
  // from the machine that ran the probe is not part of a harness finding, and the repository
  // has a remote.
  const ownRoot = /agent-ping-copilot-hooks-[A-Za-z0-9_-]+/g
  const scrub = (text) => text.split(home).join('~').replace(ownRoot, '<workspace>')
  if (typeof value === 'string') return scrub(value)
  if (Array.isArray(value)) return value.map(scrubPaths)
  if (isObject(value)) {
    const out = {}
    for (const [key, child] of Object.entries(value)) out[key] = scrubPaths(child)
    return out
  }
  return value
}

/**
 * One word for a POSIX shell, single-quoted.
 *
 * The hook command is a shell command by the harness's own contract, so the capture
 * directory reaches a shell. A bare path is a bug the moment the temporary directory
 * contains a space, a parenthesis or an apostrophe - a Windows account name routinely
 * does, and the failure looks like a hook that never fired rather than a quoting bug.
 * Single quotes are literal in POSIX shells; the only escape needed is the embedded
 * quote itself.
 */
function posixQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The hook file, installed for every declared trigger. Each entry appends its own stdin to its
 * own file, so an event that fires several times leaves several lines and an event that never
 * fires leaves no file. `cat` is used deliberately: it exits non-zero if the target directory is
 * missing, so a probe mistake surfaces in the CLI log as a hook failure instead of looking like
 * a signal that did not fire. The path is quoted, and the redirect is not a substitute for that
 * quoting: `>>` protects the last word only, so an unquoted directory with a space still splits.
 */
function buildHookConfig(captureDir) {
  const hooks = {}
  for (const { event } of DECLARED_TRIGGERS) {
    hooks[event] = [
      {
        type: 'command',
        bash: `cat >> ${posixQuote(path.join(captureDir, `${event}.jsonl`))}`,
        timeoutSec: 10,
      },
    ]
  }
  return { version: 1, hooks }
}

/** Empty the capture directory, so each run's totals are its own and not an accumulation. */
function clearCaptureDir(captureDir) {
  for (const { event } of DECLARED_TRIGGERS) {
    rmSync(path.join(captureDir, `${event}.jsonl`), { force: true })
  }
}

/** Resolve the binary and capture its version. A missing binary is a loud failure, never a skip. */
function resolveBinary(binary) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' })
  const versionOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.error !== undefined || result.status !== 0) {
    throw new ProbeFailure(
      3,
      `the Copilot CLI binary could not be run: ${binary} ` +
        `(${result.error?.message ?? `exit ${result.status ?? 'unknown'}`}). Install GitHub Copilot CLI so that ` +
        '`copilot --version` prints a version, put it on PATH, or pass --binary <path>. This probe has no stub ' +
        'fallback: a missing binary is an absent probe, not a negative finding, so no capture is written and the ' +
        'exit code is non-zero.',
    )
  }
  const match = versionOutput.match(/\d+\.\d+\.\d+/)
  if (match === null) {
    throw new ProbeFailure(
      3,
      `${binary} --version produced no parseable version: ${JSON.stringify(versionOutput)}. A version that cannot be ` +
        'read invalidates the capture, so no capture is written.',
    )
  }
  return {
    executable: binary,
    record: {
      binary: path.basename(binary),
      version: match[0],
      versionCommand: `${binary} --version`,
      versionOutput,
    },
  }
}

/**
 * The binary's own documentation of its hook configuration surface, captured live. This is the
 * on-machine half of the "documented" column: the reference page says what the events are, and
 * the binary's own help is what proves the surface exists on this installation.
 */
function captureOnMachineHelp(binary) {
  const result = spawnSync(binary, ['help', 'config'], { encoding: 'utf8', timeout: HELP_TIMEOUT_MS })
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const hookLines = text
    .split('\n')
    .filter((line) => /hook/i.test(line))
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return {
    command: `${path.basename(binary)} help config`,
    exitCode: result.status ?? null,
    hookConfigDocumented: hookLines.some((line) => line.includes('`hooks`')),
    hookLines: hookLines.slice(0, 12),
    exitWithinTimeout: result.error === undefined,
  }
}

/** Run one child to completion with a deadline, and never let it outlive the probe. */
function runToCompletion(binary, argv, { cwd, env, timeoutMs, label }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let child
    try {
      child = spawn(binary, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new ProbeFailure(3, `could not start ${binary}: ${error.message}`))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new ProbeTimeout(label, timeoutMs))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new ProbeFailure(3, `could not start ${binary}: ${error.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - startedAt })
    })
    // A hook-heavy session can leave stdin unread; resuming it keeps the child from blocking on
    // a write and makes the timeout the only thing that can end the wait.
    child.stdin.on('error', () => {})
    child.stdin.resume()
  })
}

/**
 * The ACP-mode differential run.
 *
 * A compact driver rather than a shared one: `probe-copilot-acp.mjs` owns a protocol capture and
 * keeps its client private on purpose, and this run needs a different thing from the same
 * protocol — one tool-using turn, then out. Duplicating forty lines here is cheaper than
 * loosening that script's exports for a second caller.
 */
async function runAcpSession({ executable, cwd, env, timeoutMs }) {
  const child = spawn(executable, ['--acp'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const frames = []
  let buffer = ''
  let nextId = 0
  let timer = null

  const fail = (code, message) => {
    if (timer !== null) clearTimeout(timer)
    child.kill('SIGKILL')
    return new ProbeFailure(code, message)
  }

  const settled = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new ProbeTimeout('ACP session', timeoutMs))
    }, timeoutMs)
    child.on('error', (error) => reject(fail(3, `could not start ${executable}: ${error.message}`)))
    child.on('close', () => resolve())
  })

  child.stderr.resume()
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() !== '') {
        try {
          const message = JSON.parse(line)
          if (isObject(message)) {
            frames.push(message)
            if (message.method === 'session/request_permission' && message.id !== undefined) {
              const options = Array.isArray(message.params?.options) ? message.params.options : []
              const chosen = options.find((option) => option?.kind === 'allow_once') ?? options[0]
              child.stdin.write(
                `${JSON.stringify({
                  jsonrpc: '2.0',
                  id: message.id,
                  result: { outcome: { outcome: 'selected', optionId: chosen?.optionId ?? 'allow_once' } },
                })}\n`,
              )
            }
          }
        } catch {
          // A line that is not a frame is not this run's evidence; the ACP probe owns the
          // verbatim wire capture, and this run only needs to know whether hooks fired.
        }
      }
      newline = buffer.indexOf('\n')
    }
  })

  const call = (method, params, label) =>
    new Promise((resolve, reject) => {
      const id = nextId
      nextId += 1
      const deadline = setInterval(() => {
        const response = frames.find((frame) => frame.id === id && frame.method === undefined)
        if (response === undefined) return
        clearInterval(deadline)
        if (response.error !== undefined) {
          reject(new ProbeFailure(4, `${label} failed: ${JSON.stringify(response.error)}`))
          return
        }
        resolve(response.result)
      }, 100)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  try {
    await call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, 'initialize')
    const created = await call('session/new', { cwd, mcpServers: [] }, 'session/new')
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new ProbeFailure(4, `session/new returned no sessionId: ${JSON.stringify(created)}`)
    }
    const stopped = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: PROMPT_WITH_TOOL }] }, 'session/prompt')
    return {
      completed: true,
      sessionIdPresent: true,
      stopReason: stopped?.stopReason ?? null,
      notificationMethods: [...new Set(frames.filter((frame) => frame.method !== undefined && frame.id === undefined).map((frame) => frame.method))].sort(),
      agentRequestMethods: [...new Set(frames.filter((frame) => frame.method !== undefined && frame.id !== undefined).map((frame) => frame.method))].sort(),
    }
  } catch (error) {
    if (error instanceof ProbeFailure || error instanceof ProbeTimeout) throw error
    throw new ProbeFailure(4, `the ACP differential run failed: ${error.message}`)
  } finally {
    child.kill('SIGKILL')
    await settled
    if (timer !== null) clearTimeout(timer)
  }
}

/** Read the per-event capture files a run left behind. A missing file means the event did not fire. */
function readCaptureDir(captureDir) {
  const raw = {}
  for (const { event } of DECLARED_TRIGGERS) {
    const file = path.join(captureDir, `${event}.jsonl`)
    raw[event] = existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '')
      : []
  }
  return raw
}

/** The CLI's own account of loading hooks, from the isolated configuration directory. */
function readHookLogLines(copilotHome) {
  const logDir = path.join(copilotHome, 'logs')
  if (!existsSync(logDir)) return []
  const lines = []
  for (const name of readdirSync(logDir).filter((entry) => entry.endsWith('.log')).sort()) {
    for (const line of readFileSync(path.join(logDir, name), 'utf8').split('\n')) {
      if (/hook/i.test(line)) lines.push(line.trim())
    }
  }
  return lines.slice(0, 50)
}

function parseArgs(argv) {
  const args = {
    binary: DEFAULT_BINARY,
    out: DEFAULT_CAPTURE,
    acpCapture: DEFAULT_ACP_CAPTURE,
    report: DEFAULT_REPORT,
    capture: null,
    renderOnly: false,
    runTimeoutMs: RUN_TIMEOUT_MS,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined) throw new ProbeFailure(2, `${arg} needs a value`)
      index += 1
      return value
    }
    switch (arg) {
      case '--binary':
        args.binary = next()
        break
      case '--out':
        args.out = next()
        break
      case '--acp-capture':
        args.acpCapture = next()
        break
      case '--report':
        args.report = next()
        break
      case '--capture':
        args.capture = next()
        break
      case '--render-only':
        args.renderOnly = true
        break
      case '--run-timeout-ms':
        args.runTimeoutMs = Number(next())
        break
      case '--help':
      case '-h':
        args.help = true
        break
      default:
        throw new ProbeFailure(2, `unknown argument ${arg}. Try --help.`)
    }
  }
  return args
}

const USAGE = `Usage: node ${SCRIPT_PATH} [options]

Installs a command hook for every documented Copilot CLI hook event into an isolated
COPILOT_HOME, runs a real session in each of two modes, captures the real payload of every
invocation, and writes the capture plus the consolidated report.

Options:
  --binary <path>           Copilot CLI binary to probe (default: ${DEFAULT_BINARY})
  --out <path>              Where to write the hook capture
                            (default: ${DEFAULT_CAPTURE})
  --acp-capture <path>      CP-1 capture to consolidate into the report
                            (default: ${DEFAULT_ACP_CAPTURE})
  --report <path>           Where to write the consolidated report
                            (default: ${DEFAULT_REPORT})
  --capture <path>          Analyse a captured run instead of launching the binary
  --render-only             Re-render the report from existing captures, no binary needed
  --run-timeout-ms <n>      Deadline for each driven run (default: ${RUN_TIMEOUT_MS})
  -h, --help                This text

Exit codes: 0 capture recorded, 1 an assertion failed, 2 usage error, 3 the binary is
missing or unreadable, 4 nothing was captured or the driven run never completed, 5 a phase
passed its deadline. Codes 2, 3, 4 and 5 write no capture: absence of evidence is never a
negative finding.
`

const resolveFromRoot = (target) => (path.isAbsolute(target) ? target : path.join(repoRoot, target))

/** Read a JSON file if it is there, and say plainly why not when it is not. */
function readOptionalJson(target) {
  if (!existsSync(target)) {
    return { value: null, reason: `no capture at ${path.basename(target)}; the probe that writes it has not been run, which is an absent probe and not a negative finding` }
  }
  try {
    return { value: JSON.parse(readFileSync(target, 'utf8')), reason: null }
  } catch (error) {
    return { value: null, reason: `the capture at ${path.basename(target)} could not be parsed: ${error.message}` }
  }
}

/** Analyse a captured run. Shares every line of logic with the live path. */
function runCapture(args) {
  const absolute = resolveFromRoot(args.capture)
  const captured = JSON.parse(readFileSync(absolute, 'utf8'))
  const runs = captured.runs.map((run) =>
    buildRunEvidence({
      label: run.label,
      mode: run.mode,
      hookLocation: run.hookLocation ?? 'user level',
      argv: run.argv ?? [],
      hookConfigLocation: run.hookConfigLocation ?? null,
      startedAt: run.startedAt ?? null,
      finishedAt: run.finishedAt ?? null,
      exitCode: run.exitCode ?? null,
      runCompleted: run.runCompleted !== false,
      rawByEvent: run.rawByEvent ?? {},
      logLines: run.logLines ?? [],
      acp: run.acp ?? null,
    }),
  )
  return {
    cli: {
      binary: captured.cli?.binary ?? 'unknown',
      version: captured.cli?.version ?? null,
      versionCommand: captured.cli?.versionCommand ?? null,
      versionOutput: captured.cli?.versionOutput ?? null,
    },
    documentation: {
      ...DOCUMENTATION_SOURCE,
      onMachine: captured.documentation?.onMachine ?? { command: null, hookConfigDocumented: false, hookLines: [] },
      // Carried through when the captured run has it, and null when it does not, so a report
      // rendered from a capture with no environment caveat says so rather than rendering a
      // sentence with its subject missing.
      environmentCaveat: captured.documentation?.environmentCaveat ?? null,
      strippedEnvironment: captured.documentation?.strippedEnvironment ?? [],
      runMatrix: captured.documentation?.runMatrix ?? null,
    },
    runs,
  }
}

/**
 * Launch the real binary and drive both runs. Everything the run touches is a fresh temporary
 * directory: the workspace, the capture directory, and the whole Copilot configuration
 * directory. Redirecting the configuration directory is what keeps a probe from reading the
 * developer's own session store as state or leaving a hook file in their real installation.
 */
/**
 * The four runs, as a location-by-mode matrix.
 *
 * The reference page documents two hook locations that behave differently for this question:
 * a user-level directory (`$COPILOT_HOME/hooks/`) and a repository-level directory
 * (`.github/hooks/`). Which of them the CLI loads in which mode is not documented as being the
 * same, and an adapter runs in one mode, so a hook that only loads in the other mode is not
 * available to it. Rather than assert a difference, the probe installs each location in turn
 * and runs each mode, and reports the four resulting counts.
 */
const RUN_MATRIX = [
  {
    label: 'pipe-user',
    hookLocation: 'user level',
    mode: 'non-interactive prompt mode (copilot -p)',
    location: 'user',
    argv: ['-p', '<the probe prompt>'],
    acp: false,
  },
  {
    label: 'acp-user',
    hookLocation: 'user level',
    mode: 'ACP mode over stdio (copilot --acp)',
    location: 'user',
    argv: ['--acp'],
    acp: true,
  },
  {
    label: 'pipe-repo',
    hookLocation: 'repository level',
    mode: 'non-interactive prompt mode (copilot -p)',
    location: 'repository',
    argv: ['-p', '<the probe prompt>'],
    acp: false,
  },
  {
    label: 'acp-repo',
    hookLocation: 'repository level',
    mode: 'ACP mode over stdio (copilot --acp)',
    location: 'repository',
    argv: ['--acp'],
    acp: true,
  },
]

async function runLive(args) {
  const { executable, record: cli } = resolveBinary(args.binary)
  progress(`copilot ${cli.version} at ${cli.binary}`)

  const documentation = { ...DOCUMENTATION_SOURCE, onMachine: captureOnMachineHelp(args.binary) }
  if (documentation.onMachine.exitCode !== 0) {
    throw new ProbeFailure(
      4,
      `\`${documentation.onMachine.command}\` exited ${documentation.onMachine.exitCode}, so the binary would not document its own hook surface. ` +
        'The documented column would then rest on the reference page alone, which is not enough for a capture to be written.',
    )
  }
  progress(`help documents the hook surface: ${documentation.onMachine.hookConfigDocumented}`)

  const root = mkdtempSync(path.join(tmpdir(), 'agent-ping-copilot-hooks-'))
  const workspace = path.join(root, 'workspace')
  const copilotHome = path.join(root, 'copilot-home')
  const captureDir = path.join(root, 'capture')
  const repoHooksDir = path.join(workspace, '.github', 'hooks')
  for (const dir of [workspace, path.join(copilotHome, 'hooks'), repoHooksDir, captureDir]) {
    mkdirSync(dir, { recursive: true })
  }
  // A file for the driven tool to act on, so the tool call has something real to do.
  writeFileSync(path.join(workspace, 'README.md'), '# agent-ping Copilot hook probe workspace\n')

  const hookConfig = `${JSON.stringify(buildHookConfig(captureDir), null, 2)}\n`
  const hookFiles = {
    user: path.join(copilotHome, 'hooks', USER_HOOK_FILENAME),
    repository: path.join(repoHooksDir, USER_HOOK_FILENAME),
  }

  const env = { ...process.env, NO_COLOR: '1', COPILOT_HOME: copilotHome, COPILOT_ALLOW_ALL: 'true' }
  const stripped = ['COPILOT_ALLOW_ALL'].filter((name) => process.env[name] !== undefined)
  /**
   * Recorded, because it changes what the probe can see in both directions. Exactly `true` is
   * the only spelling that also trusts the working directory, and trusting the directory is what
   * makes repository-level hooks load. The same flag auto-approves every tool, which has two
   * consequences the report states rather than glosses over:
   *
   *   - `permissionRequest` being observed is evidence the hook fires *before* the permission
   *     service, not evidence that a human was asked. That is what the reference page claims,
   *     and this is the run that demonstrates it.
   *   - the ACP runs therefore emit no `session/request_permission`, so their empty agent-request
   *     list is an artefact of the probe's own environment and NOT a finding about the ACP
   *     permission signal. CP-1's capture, run without this flag, is the authority there.
   */
  const environmentCaveat = {
    trustOptIn: 'COPILOT_ALLOW_ALL=true',
    why: 'documented: exactly "true" also trusts the working directory, and trusting the directory is what loads repository-level hooks',
    toolsAutoApproved: true,
    effectOnPermissionEvidence:
      'permissionRequest fired while every tool was auto-approved, which is evidence the hook runs before the permission service. The ACP runs in this probe emitted no session/request_permission for the same reason, so their empty agent-request list says nothing about the ACP permission signal; CP-1 ran without this flag and is the authority on that.',
  }
  const runs = []

  try {
    for (const plan of RUN_MATRIX) {
      // Only the location under test is installed, so a run's count is that location's and the
      // matrix is a comparison rather than a sum.
      for (const file of Object.values(hookFiles)) rmSync(file, { force: true })
      writeFileSync(hookFiles[plan.location], hookConfig)
      clearCaptureDir(captureDir)
      const logMark = readHookLogLines(copilotHome).length

      progress(`${plan.label} (${plan.hookLocation}, ${plan.mode})`)
      const startedAt = nowIso()
      let acp = null
      let failure = null
      let exitCode = null
      if (plan.acp) {
        try {
          acp = await runAcpSession({ executable, cwd: workspace, env, timeoutMs: args.runTimeoutMs })
          exitCode = 0
        } catch (error) {
          // A matrix cell failing is not a reason to discard the rest: each cell answers its own
          // question, and a failure is recorded as a failure so it cannot read as a negative.
          failure = `${error.name}: ${error.message}`
          acp = { completed: false, failure }
          progress(`${plan.label} failed: ${failure}`)
        }
      } else {
        const pipe = await runToCompletion(executable, ['-p', PROMPT_WITH_TOOL], {
          cwd: workspace,
          env,
          timeoutMs: args.runTimeoutMs,
          label: `the ${plan.label} run`,
        })
        exitCode = pipe.code
      }
      const evidence = buildRunEvidence({
        label: plan.label,
        mode: plan.mode,
        hookLocation: plan.hookLocation,
        argv: plan.argv,
        hookConfigLocation: `${plan.location === 'user' ? '$COPILOT_HOME' : '<workspace>/.github'}/hooks/${USER_HOOK_FILENAME} (${plan.hookLocation}, isolated)`,
        startedAt: startedAt,
        finishedAt: nowIso(),
        exitCode,
        runCompleted: exitCode === 0,
        rawByEvent: readCaptureDir(captureDir),
        logLines: readHookLogLines(copilotHome).slice(logMark),
        acp,
      })
      runs.push(evidence)
      progress(`${plan.label}: ${evidence.invocationTotal} invocations`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  return {
    cli,
    documentation: { ...documentation, environmentCaveat, strippedEnvironment: stripped, runMatrix: RUN_MATRIX.map((plan) => plan.label) },
    runs,
  }
}



function writeCapture(outPath, capture, decision) {
  const absolute = resolveFromRoot(outPath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  const artefact = scrubPaths({ ...capture, ...findings(capture), decision })
  writeFileSync(absolute, `${JSON.stringify(artefact, null, 2)}\n`)
  return absolute
}

function writeReport(reportPath, report) {
  const absolute = resolveFromRoot(reportPath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, report.endsWith('\n') ? report : `${report}\n`)
  return absolute
}

async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`)
    return error.code ?? 2
  }
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }

  const acpRead = readOptionalJson(resolveFromRoot(args.acpCapture))

  // `--render-only` re-renders the report from the committed capture without touching a binary
  // or rewriting the capture. It is a separate path rather than a flag on the live path, because
  // "the report is out of date" and "the capture is out of date" are different problems and a
  // flag that quietly did both would hide one of them.
  if (args.renderOnly) {
    const existing = readOptionalJson(resolveFromRoot(args.out))
    if (existing.value === null) {
      emitSummary({
        script: PROBE_NAME,
        verdict: 'fail',
        exitCode: 4,
        failure: `--render-only needs the hook capture at ${args.out} and it could not be read: ${existing.reason}`,
        remedy: 'run the probe against a real binary first; a report rendered from a missing capture would be a report about nothing',
        capture: null,
        captureWritten: false,
        reportWritten: false,
        assertionsRun: 0,
        assertionsExpected: ASSERTIONS_EXPECTED,
      })
      return 4
    }
    const reportPath = writeReport(
      args.report,
      renderReport({
        hooksCapture: existing.value,
        acpCapture: acpRead.value,
        hooksCapturePath: args.out,
        acpCapturePath: args.acpCapture,
        generatedAt: nowIso(),
      }),
    )
    emitSummary({
      script: PROBE_NAME,
      verdict: 'pass',
      exitCode: 0,
      renderedFrom: args.out,
      acpCaptureAvailable: acpRead.value !== null,
      capture: args.out,
      captureWritten: false,
      report: args.report,
      reportWritten: true,
      assertionsRun: existing.value.decision?.assertionsRun ?? 0,
      assertionsExpected: ASSERTIONS_EXPECTED,
      note: 'the report was re-rendered from the committed capture; no binary was launched and the capture was not rewritten',
    })
    progress(`report written to ${reportPath}`)
    return 0
  }

  let outcome
  try {
    outcome = args.capture === null ? await runLive(args) : runCapture(args)
  } catch (error) {
    const code = error instanceof ProbeFailure ? error.code : error instanceof ProbeTimeout ? 5 : 1
    emitSummary(
      scrubPaths({
        script: PROBE_NAME,
        verdict: 'fail',
        exitCode: code,
        failure: `${error.name}: ${error.message}`,
        remedy:
          code === 3
            ? 'install GitHub Copilot CLI so that `copilot --version` prints a version, then re-run'
            : 're-run the probe; if the driven session keeps failing, the hook surface has changed and the report must say so',
        capture: null,
        captureWritten: false,
        reportWritten: false,
        assertionsRun: 0,
        assertionsExpected: ASSERTIONS_EXPECTED,
      }),
    )
    process.stderr.write(`[${PROBE_NAME}] ${error.name}: ${error.message}\n`)
    return code
  }

  const capture = buildCapture({
    cli: outcome.cli,
    documentation: outcome.documentation,
    runs: outcome.runs,
    acpCapture: acpRead.value,
    acpCapturePath: args.acpCapture,
    acpCaptureReason: acpRead.reason,
  })
  const decision = decide(capture)

  // The non-vacuity guard, below the decision function: a run that captured no hook invocation
  // at all cannot be written out as a capture, whatever the assertions say. A capture that exists
  // is a capture that has something in it.
  const pipeRun = capture.runs.find((run) => run.label === PRIMARY_RUN_LABEL)
  if (pipeRun === undefined || pipeRun.invocationTotal === 0) {
    emitSummary(
      scrubPaths({
        script: PROBE_NAME,
        verdict: 'fail',
        exitCode: 4,
        failure:
          pipeRun === undefined
            ? 'the capture contains no pipe-mode run, so there is no evidence to report'
            : 'the driven session produced no hook invocation at all, so the capture would be indistinguishable from a run in which nothing was installed',
        capture: null,
        captureWritten: false,
        reportWritten: false,
        assertionsRun: decision.assertionsRun,
        assertionsExpected: decision.assertionsExpected,
        assertions: decision.assertions,
        failures: decision.failures,
      }),
    )
    process.stderr.write(`[${PROBE_NAME}] no hook invocation captured; no capture written\n`)
    return 4
  }

  const capturePath = writeCapture(args.out, capture, decision)
  const report = renderReport({
    hooksCapture: capture,
    acpCapture: acpRead.value,
    hooksCapturePath: args.out,
    acpCapturePath: args.acpCapture,
    generatedAt: nowIso(),
  })
  const reportPath = writeReport(args.report, report)

  emitSummary(
    scrubPaths({
      script: PROBE_NAME,
      verdict: decision.verdict,
      exitCode: decision.exitCode,
      cliVersion: capture.cli.version,
      pipeStartedAt: capture.runs[0]?.startedAt ?? null,
      pipeFinishedAt: capture.runs[0]?.finishedAt ?? null,
      lastRunStartedAt: capture.runs[capture.runs.length - 1]?.startedAt ?? null,
      lastRunFinishedAt: capture.runs[capture.runs.length - 1]?.finishedAt ?? null,
      acpCaptureAvailable: acpRead.value !== null,
      ...findings(capture),
      assertionsRun: decision.assertionsRun,
      assertionsExpected: decision.assertionsExpected,
      assertions: decision.assertions,
      failures: decision.failures,
      capture: args.out,
      captureWritten: true,
      report: args.report,
      reportWritten: true,
    }),
  )
  progress(`capture written to ${capturePath}`)
  progress(`report written to ${reportPath}`)
  for (const failure of decision.failures) process.stderr.write(`[${PROBE_NAME}] FAIL ${failure}\n`)
  return decision.exitCode
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) process.exit(await main(process.argv.slice(2)))
