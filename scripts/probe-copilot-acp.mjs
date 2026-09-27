#!/usr/bin/env node
// Probe the real GitHub Copilot CLI ACP surface (CP-1, CP-FR-01, CP-FR-03).
//
// The claim this script exists to settle: "does the Copilot CLI emit a permission
// request, and an idle/turn-end signal, in ACP mode?" PRD section 5 records that as
// unresolved upstream, and the whole feature hangs on it. So the script does not
// answer it from documentation, it answers it from a real binary and writes down
// what it saw.
//
//   node scripts/probe-copilot-acp.mjs
//   node scripts/probe-copilot-acp.mjs --transcript tests/scripts/fixtures/<file>.json
//
// Shape, per the live-verification-script discipline:
//
//   scripts/probe-copilot-acp.mjs        pure parsing/recording/judgement, exported,
//                                         plus a thin shell that owns every side effect
//   tests/scripts/probe-copilot-acp.test.ts  drives the script over a captured transcript,
//                                         so the logic is verified without the binary
//
// Four properties this script must never lose:
//
//   1. Absence of evidence is never reported as a negative finding. A missing binary or a
//      handshake that did not complete exits non-zero and writes NO artefact, so a later
//      reader cannot mistake an absent probe for "no permission signal exists". There is
//      no code path that writes an empty report and exits zero.
//   2. Three states, not two. A signal is `observed`, `not-triggered` (the harness fired
//      nothing for this case) or `unresolved`. A black-box probe can never establish
//      `absent` - that needs the harness's own capability list - so the script does not
//      claim it, and the gate decision does not get a fabricated negative.
//   3. Verbatim structure, no conversation content (APX-FR-01). Field names, enum values,
//      counts and array lengths are captured exactly; prompt, response and tool output
//      text is replaced by a length marker. A reviewer re-checks every name and shape;
//      nothing in the artefact can hold what a developer typed.
//   4. No retry storm and no unbounded wait. Every phase has a deadline, the child is
//      killed, and a timeout is a loud failure rather than a hang.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT_PATH = 'scripts/probe-copilot-acp.mjs'

export const PROBE_NAME = 'probe-copilot-acp'
/** Bumped when the artefact schema changes, so a later reader can tell the two apart. */
export const ARTIFACT_VERSION = 1

/** ACP surface, as observed on GitHub Copilot CLI 1.0.88. See the artefact for the capture. */
export const PERMISSION_METHOD = 'session/request_permission'
export const UPDATE_METHOD = 'session/update'

/**
 * The two turns the probe drives. The contrast is the point: one turn must reach a tool,
 * the other must not, so a permission request that arrives only on the tool turn is
 * evidence that the signal discriminates, not evidence that the turn happened to be quiet.
 */
export const PROMPT_WITH_TOOL =
  'Use the shell tool to run the command `ls` in the working directory, then reply with exactly DONE.'
export const PROMPT_WITHOUT_TOOL = 'Reply with exactly OK. Do not use any tool.'

/**
 * Keys whose string values are kept verbatim in the frame capture. Every one of them is a
 * protocol or CLI-authored identifier on the observed surface, and every one is the
 * evidence a reviewer needs: a method name, a session/update variant, a tool status, a
 * permission option id, a turn stop reason. Everything else is reduced to a length marker.
 */
export const LITERAL_KEYS = new Set([
  'jsonrpc',
  // A JSON-RPC method name is structural by definition: it is the signal's name, which is
  // the finding. The frame record also carries `method` separately, so this is belt to
  // that braces rather than the only place it survives.
  'method',
  'sessionUpdate',
  'kind',
  'status',
  'stopReason',
  'optionId',
  // On the observed surface every `name` is CLI-authored metadata (an auth method label, a
  // permission option label, a slash-command name, a mode name, agentInfo.name), never
  // model-authored text. A re-run against a changed surface re-checks this list, which is
  // why it is recorded in the artefact rather than buried here.
  'name',
  'sessionId',
  'toolCallId',
  'protocolVersion',
  'type',
  'outcome',
])

/**
 * Keys documented as content-bearing, recorded in the artefact so the redaction policy is
 * re-checkable rather than taken on trust. This list is documentation plus the test's leak
 * guard: the capture itself is a blanket rule (any key not in LITERAL_KEYS has its strings
 * reduced), so a content field nobody anticipated is still redacted.
 */
export const CONTENT_BEARING_KEYS = [
  'text',
  'thought',
  'content',
  'prompt',
  'rawInput',
  'rawOutput',
  'arguments',
  'title',
  'description',
  'diff',
  'patch',
]

/** Array elements captured before truncation; the real length is always recorded. */
const MAX_ARRAY_ITEMS = 3

const DEFAULT_ARTIFACT = 'docs/research/copilot-acp-capture.json'
const DEFAULT_BINARY = 'copilot'
const HANDSHAKE_TIMEOUT_MS = 45_000
const SESSION_TIMEOUT_MS = 60_000
const TURN_TIMEOUT_MS = 240_000

/**
 * Environment variables that would change what the probe observes. `COPILOT_ALLOW_ALL`
 * auto-approves tools, which suppresses the very signal under investigation; a probe that
 * ran with it set and recorded "no permission request" would be reporting an artefact of
 * the environment as a property of the harness. They are stripped from the child and the
 * fact is recorded in the artefact.
 */
const STRIPPED_ENV = ['COPILOT_ALLOW_ALL', 'COPILOT_OFFLINE']

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

// ─────────────────────────────────────────────────────────────────────────────
// Pure: stream parsing. No process, no clock, no filesystem.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a captured stdout stream into JSON-RPC frames plus the lines that were not frames.
 *
 * A line that does not parse is a *recorded* finding, not a skipped row: a banner, a log
 * line or a partial write on the agent's stdout is a contract change this probe must
 * report rather than quietly filter out.
 */
export function parseRawLines(rawLines) {
  const frames = []
  const unparsed = []
  for (const [index, raw] of rawLines.entries()) {
    const line = typeof raw === 'string' ? raw.trim() : ''
    if (line === '') continue
    let message
    try {
      message = JSON.parse(line)
    } catch (error) {
      unparsed.push({ index, length: line.length, reason: `invalid JSON: ${error.message}` })
      continue
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      unparsed.push({ index, length: line.length, reason: 'not a JSON-RPC object' })
      continue
    }
    frames.push({ index, message })
  }
  return { frames, unparsed }
}

/** Classify a parsed frame by its JSON-RPC envelope alone, with no method allowlist. */
export function classifyFrame(frame) {
  const message = frame.message
  const hasMethod = typeof message.method === 'string'
  const hasId = message.id !== undefined && message.id !== null
  if (hasMethod && hasId) {
    return { kind: 'agent-request', direction: 'agent-to-client', method: message.method }
  }
  if (hasMethod) return { kind: 'notification', direction: 'agent-to-client', method: message.method }
  if (hasId) return { kind: 'response', direction: 'agent-to-client' }
  return { kind: 'unrecognised', direction: 'agent-to-client' }
}

/**
 * Reduce a value to its structure: every key name and array length is kept, numbers,
 * booleans and nulls are kept, and a string is kept only when the key naming it is in
 * LITERAL_KEYS. Everything else becomes a length marker, which is what makes the artefact
 * safe to commit (APX-FR-01) without making it unreadable.
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
  for (const [key, child] of Object.entries(value)) {
    out[key] = captureShape(child, LITERAL_KEYS.has(key))
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: reading the observed surface out of a parsed stream.
// ─────────────────────────────────────────────────────────────────────────────

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The initialize result, identified structurally rather than by request id: a response
 * whose result carries a protocolVersion. That keeps the reader working over a captured
 * transcript with no request log, and keeps it honest if the ids were renumbered.
 */
export function readHandshake(frames) {
  const responses = frames.filter((frame) => classifyFrame(frame).kind === 'response')
  const initialised = responses.find(
    (frame) => isObject(frame.message.result) && frame.message.result.protocolVersion !== undefined,
  )
  if (initialised === undefined) {
    const errored = responses.find((frame) => frame.message.error !== undefined)
    return {
      completed: false,
      reason:
        errored === undefined
          ? 'no initialize response carrying a protocolVersion appeared in the captured stream'
          : `the initialize request failed: ${JSON.stringify(errored.message.error)}`,
      responseCount: responses.length,
      protocolVersion: null,
      agentCapabilities: null,
      authMethods: null,
      authMethodsCount: null,
      agentInfo: null,
      raw: null,
    }
  }
  const result = initialised.message.result
  return {
    completed: true,
    reason: null,
    responseCount: responses.length,
    protocolVersion: result.protocolVersion,
    // Verbatim: the capability object and the auth method list are pure harness metadata,
    // and they are the finding. `_meta.terminal-auth.command` is scrubbed of the home
    // directory on write so the artefact does not carry the operator's username.
    agentCapabilities: result.agentCapabilities ?? null,
    authMethods: Array.isArray(result.authMethods) ? result.authMethods : null,
    authMethodsCount: Array.isArray(result.authMethods) ? result.authMethods.length : null,
    agentInfo: result.agentInfo ?? null,
    raw: result,
  }
}

/**
 * The session/new result. Structurally: a response whose result carries a sessionId and no
 * protocolVersion, so it cannot be confused with the handshake.
 */
export function readSession(frames) {
  const created = frames.find((frame) => {
    const { message } = frame
    return (
      classifyFrame(frame).kind === 'response' &&
      isObject(message.result) &&
      typeof message.result.sessionId === 'string' &&
      message.result.sessionId !== '' &&
      message.result.protocolVersion === undefined
    )
  })
  if (created === undefined) {
    return { created: false, sessionId: null, modes: null, configOptions: null, models: null }
  }
  const result = created.message.result
  return {
    created: true,
    sessionId: result.sessionId,
    modes: Array.isArray(result.modes) ? captureShape(result.modes) : null,
    configOptions: Array.isArray(result.configOptions) ? captureShape(result.configOptions) : null,
    models: Array.isArray(result.models) ? captureShape(result.models) : null,
  }
}

/** Attribute every frame to a turn. A turn ends at a response carrying a stopReason. */
export function readTurns(frames, requestMethodsById = new Map()) {
  const turns = []
  let current = { index: 0, startFrame: 0, stopReason: null, updateVariants: [], agentRequests: [] }
  for (const frame of frames) {
    const kind = classifyFrame(frame)
    if (kind.kind === 'notification' && kind.method === UPDATE_METHOD) {
      const variant = frame.message.params?.update?.sessionUpdate
      current.updateVariants.push(typeof variant === 'string' ? variant : '<no sessionUpdate>')
    }
    if (kind.kind === 'agent-request') {
      current.agentRequests.push(kind.method)
    }
    if (kind.kind === 'response') {
      const stopReason = frame.message.result?.stopReason
      if (typeof stopReason === 'string') {
        current.endFrame = frame.index
        current.stopReason = stopReason
        current.requestMethod = requestMethodsById.get(frame.message.id) ?? null
        turns.push(current)
        current = {
          index: turns.length,
          startFrame: frame.index + 1,
          stopReason: null,
          updateVariants: [],
          agentRequests: [],
        }
      }
    }
  }
  if (current.updateVariants.length > 0 || current.agentRequests.length > 0) {
    current.endFrame = frames.length > 0 ? frames[frames.length - 1].index : 0
    current.requestMethod = null
    turns.push(current)
  }
  return turns
}

/**
 * Everything the probe saw on the permission path, kept in its own section and never mixed
 * into the ordinary session/update inventory. That separation is the point: a permission
 * request is an agent-to-client *request* carrying a decision, not a progress notification,
 * and a reader must be able to see which one they are looking at.
 */
export function readPermissionPath(frames) {
  const requests = []
  for (const frame of frames) {
    const kind = classifyFrame(frame)
    if (kind.kind !== 'agent-request' || kind.method !== PERMISSION_METHOD) continue
    const params = isObject(frame.message.params) ? frame.message.params : {}
    const toolCall = isObject(params.toolCall) ? params.toolCall : {}
    const options = Array.isArray(params.options)
      ? params.options.map((option) => ({
          optionId: isObject(option) ? (option.optionId ?? null) : null,
          kind: isObject(option) ? (option.kind ?? null) : null,
          name: isObject(option) ? (option.name ?? null) : null,
        }))
      : []
    requests.push({
      frameIndex: frame.index,
      sessionId: params.sessionId ?? null,
      toolCallId: toolCall.toolCallId ?? null,
      toolKind: toolCall.kind ?? null,
      toolStatus: toolCall.status ?? null,
      options,
    })
  }
  return { observed: requests.length > 0, requestCount: requests.length, requests }
}

/**
 * The turn-end signal, searched for rather than assumed. `idleNotificationObserved` is the
 * result of looking for an idle marker in the names the CLI actually used; the variants and
 * methods it did emit are recorded next to it, so a reader can re-check the search.
 */
export function readTurnEndSignal(frames, turns) {
  const notificationMethods = new Set()
  const updateVariants = new Set()
  for (const frame of frames) {
    const kind = classifyFrame(frame)
    if (kind.kind === 'notification') {
      notificationMethods.add(kind.method)
      const variant = frame.message.params?.update?.sessionUpdate
      if (typeof variant === 'string') updateVariants.add(variant)
    }
  }
  const idleMatches = [...notificationMethods, ...updateVariants].filter((name) =>
    /idle|turn_end|turnend/i.test(name),
  )
  const stopReasons = turns.map((turn) => turn.stopReason).filter((value) => typeof value === 'string')
  const requestMethods = [
    ...new Set(turns.map((turn) => turn.requestMethod).filter((value) => typeof value === 'string')),
  ]
  return {
    state: idleMatches.length > 0 ? 'observed' : stopReasons.length > 0 ? 'not-triggered' : 'unresolved',
    idleNotificationObserved: idleMatches.length > 0,
    idleMarkersMatched: idleMatches,
    turnBoundariesObserved: stopReasons.length > 0,
    stopReasons,
    turnBoundaryRequestMethods: requestMethods,
    // Recorded so the claim is checkable: with a request log the turn boundary is provably
    // the response to session/prompt; without one it is a structural inference and says so.
    turnBoundaryAttribution: requestMethods.length > 0 ? 'known' : 'structural',
    notificationMethodsObserved: [...notificationMethods].sort(),
    sessionUpdateVariantsObserved: [...updateVariants].sort(),
  }
}

/**
 * The three states, applied to the permission path. A black-box probe can establish
 * `observed` and `not-triggered`; it can never establish `absent`, because absence is a
 * claim about the harness's capabilities rather than about one run, so that state is
 * deliberately unreachable here and the distinction is left to the gate.
 */
export function classifyPermissionState(permission, toolCallCount) {
  if (permission.observed) return 'observed'
  if (toolCallCount > 0) return 'not-triggered'
  return 'unresolved'
}

/** Assemble the whole evidence record from a captured stream. Pure. */
export function buildEvidence({
  cli,
  timestamps,
  rawLines,
  requestMethodsById = new Map(),
  answeredAgentRequests = null,
}) {
  const { frames, unparsed } = parseRawLines(rawLines)
  const turns = readTurns(frames, requestMethodsById)
  const permission = readPermissionPath(frames)
  const turnEnd = readTurnEndSignal(frames, turns)
  const toolCallCount = frames.filter(
    (frame) =>
      classifyFrame(frame).method === UPDATE_METHOD &&
      frame.message.params?.update?.sessionUpdate === 'tool_call',
  ).length
  const agentRequestMethods = [
    ...new Set(
      frames
        .filter((frame) => classifyFrame(frame).kind === 'agent-request')
        .map((frame) => classifyFrame(frame).method),
    ),
  ].sort()
  const notificationMethods = [
    ...new Set(
      frames
        .filter((frame) => classifyFrame(frame).kind === 'notification')
        .map((frame) => classifyFrame(frame).method),
    ),
  ].sort()

  const handshake = readHandshake(frames)
  const session = readSession(frames)
  const permissionState = classifyPermissionState(permission, toolCallCount)
  const turnsWithRequest = turns.filter((turn) => turn.agentRequests.includes(PERMISSION_METHOD)).length

  return {
    probe: PROBE_NAME,
    artifactVersion: ARTIFACT_VERSION,
    recordedBy: { script: SCRIPT_PATH, node: process.version },
    cli,
    timestamps,
    handshake,
    session,
    permissionPath: {
      state: permissionState,
      method: PERMISSION_METHOD,
      frameKind: 'agent-request',
      // The discrimination evidence: a request on the tool turn and none on the quiet turn
      // is what distinguishes a signal that discriminates from a run that happened to be
      // silent. Both counts are recorded whichever way they fall.
      requestCount: permission.requestCount,
      turnsObserved: turns.length,
      turnsWithRequest,
      turnsWithoutRequest: turns.length - turnsWithRequest,
      requests: permission.requests,
      // What the probe answered, so a reader can tell an emitted-and-granted request from one
      // the probe cancelled. Null over a transcript: the answers were sent on the wire and
      // are not in the captured stdout, and guessing them would be fabricating evidence.
      answered: answeredAgentRequests,
      answeredNote:
        answeredAgentRequests === null
          ? 'unavailable in transcript mode: the answers this probe sent are not part of the captured stdout'
          : null,
      stateMeaning: {
        observed: 'the agent asked the client for permission at least once during this run',
        'not-triggered': 'a tool call happened and no permission request was emitted for it',
        unresolved: 'the path was never exercised, so the signal is undetermined, not absent',
      },
    },
    turnEndSignal: turnEnd,
    observed: {
      frameCount: frames.length,
      agentRequestMethods,
      notificationMethods,
      sessionUpdateVariants: turnEnd.sessionUpdateVariantsObserved,
      toolCallCount,
      responseCount: frames.filter((frame) => classifyFrame(frame).kind === 'response').length,
    },
    unparsedLines: unparsed,
    frames: frames.map((frame) => {
      const kind = classifyFrame(frame)
      return {
        index: frame.index,
        kind: kind.kind,
        method: kind.method ?? null,
        id: frame.message.id ?? null,
        receivedAt: frame.receivedAt ?? null,
        shape: captureShape(frame.message),
      }
    }),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the judgement. No process, no clock, no filesystem, no network.
// ─────────────────────────────────────────────────────────────────────────────

export const ASSERTIONS_EXPECTED = 10

/**
 * Decide whether this capture is usable evidence. The list is deliberately mechanical: it
 * checks that the probe *observed* what it set out to observe, and it does not grade the
 * harness. A run that captured a permission request and a run that captured none both pass
 * these assertions, because both are real evidence; what differs between them is the
 * recorded `permissionPath.state`, which the gate reads rather than this function.
 */
export function decide(evidence) {
  const assertions = []
  const check = (name, passed, detail) =>
    assertions.push({ name, outcome: passed ? 'pass' : 'fail', detail })

  check(
    'cli version captured',
    typeof evidence.cli.version === 'string' && /^\d+\.\d+\.\d+/.test(evidence.cli.version),
    `version=${evidence.cli.version ?? 'none'} output=${JSON.stringify(evidence.cli.versionOutput ?? null)}`,
  )
  check(
    'initialize handshake completed',
    evidence.handshake.completed === true,
    evidence.handshake.completed ? 'initialize response received' : String(evidence.handshake.reason),
  )
  check(
    'negotiated protocol version recorded',
    Number.isInteger(evidence.handshake.protocolVersion),
    `protocolVersion=${JSON.stringify(evidence.handshake.protocolVersion)}`,
  )
  check(
    'agent capabilities recorded',
    isObject(evidence.handshake.agentCapabilities) &&
      Object.keys(evidence.handshake.agentCapabilities).length > 0,
    `agentCapabilities=${JSON.stringify(evidence.handshake.agentCapabilities)}`,
  )
  check(
    'authentication methods recorded',
    Array.isArray(evidence.handshake.authMethods),
    // An empty array is a real answer: the agent advertises no auth methods. A missing
    // field is a contract change, so only the latter fails.
    `authMethodsPresent=${Array.isArray(evidence.handshake.authMethods)} count=${evidence.handshake.authMethodsCount ?? 'unknown'} ids=${JSON.stringify(
      (evidence.handshake.authMethods ?? []).map((method) => method?.id ?? null),
    )}`,
  )
  check(
    'session created',
    typeof evidence.session.sessionId === 'string' && evidence.session.sessionId !== '',
    `sessionId=${JSON.stringify(evidence.session.sessionId)}`,
  )
  check(
    'session/update notifications observed',
    evidence.observed.notificationMethods.includes(UPDATE_METHOD) && evidence.observed.frameCount > 0,
    `notificationMethods=${JSON.stringify(evidence.observed.notificationMethods)} frameCount=${evidence.observed.frameCount}`,
  )
  check(
    'a tool call was observed in the driven turn',
    evidence.observed.toolCallCount > 0,
    `toolCallCount=${evidence.observed.toolCallCount}`,
  )
  check(
    'a turn boundary was observed',
    evidence.turnEndSignal.turnBoundariesObserved === true,
    `stopReasons=${JSON.stringify(evidence.turnEndSignal.stopReasons)}`,
  )
  check(
    'at least one line was captured and every captured line parsed as a JSON-RPC frame',
    // The length guard is what keeps this from passing vacuously. "No line failed to
    // parse" is trivially true of a capture with no lines, and a green row there would let
    // an empty run look like a clean one.
    evidence.observed.frameCount > 0 && evidence.unparsedLines.length === 0,
    `frameCount=${evidence.observed.frameCount} unparsedLineCount=${evidence.unparsedLines.length} reasons=${JSON.stringify(
      evidence.unparsedLines.map((line) => line.reason),
    )}`,
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

/** The three findings a reader comes for, at the top of both the artefact and the summary. */
export function findings(evidence) {
  return {
    permissionRequestEmitted: evidence.permissionPath.state === 'observed',
    permissionPathState: evidence.permissionPath.state,
    turnBoundaryMechanism:
      evidence.turnEndSignal.turnBoundaryAttribution === 'known'
        ? `the response to ${evidence.turnEndSignal.turnBoundaryRequestMethods.join(', ')} carrying stopReason`
        : 'a response carrying a stopReason (request attribution unavailable in this capture)',
    dedicatedIdleNotificationObserved: evidence.turnEndSignal.idleNotificationObserved,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Impure: the shell. Everything below owns a side effect.
// ─────────────────────────────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString()

/** Rewrite the operator's home directory to `~`, recursively. */
function scrubHomePaths(value) {
  const home = homedir()
  if (typeof value === 'string') return value.split(home).join('~')
  if (Array.isArray(value)) return value.map(scrubHomePaths)
  if (isObject(value)) {
    const out = {}
    for (const [key, child] of Object.entries(value)) out[key] = scrubHomePaths(child)
    return out
  }
  return value
}

/**
 * The one place the artefact is written, so there is exactly one place to audit the
 * redaction. The home directory is scrubbed because the repository has a remote: the
 * operator's username is not part of a harness-protocol finding.
 *
 * The decision travels with the evidence rather than only on stdout, so a later reader can
 * see whether the capture passed without re-running the probe against a CLI that has since
 * moved on.
 */
function writeArtifact(outPath, evidence, decision) {
  const absolute = path.isAbsolute(outPath) ? outPath : path.join(repoRoot, outPath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  const artefact = scrubHomePaths({
    ...evidence,
    ...findings(evidence),
    decision,
    redaction: {
      policy:
        'Frame capture is structural. Key names, enum values, numbers, booleans and array lengths are verbatim; ' +
        'a string is kept verbatim only when its key is in redaction.literalKeys, and is otherwise replaced by ' +
        'a {"$string": <length>} marker. Prompt, response and tool-output text therefore cannot appear here ' +
        '(APX-FR-01). The home directory is rewritten to ~ so the artefact does not carry the operator username.',
      literalKeys: [...LITERAL_KEYS].sort(),
      contentBearingKeys: CONTENT_BEARING_KEYS,
      caveat:
        'The hand-rolled session, mcp servers, hooks and skills are listed as captured names only. Whatever the ' +
        'developer has configured in their own Copilot installation is outside this capture.',
    },
  })
  writeFileSync(absolute, `${JSON.stringify(artefact, null, 2)}\n`)
  return absolute
}function emitSummary(summary) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}

/** Resolve the binary and capture its version. A missing binary is a loud failure, never a skip. */
function resolveBinary(binary) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' })
  const versionOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.error !== undefined || result.status !== 0) {
    throw new ProbeFailure(
      3,
      `the Copilot CLI binary could not be run: ${binary} ` +
        `(${result.error?.message ?? `exit ${result.status ?? 'unknown'}`}). ` +
        'Install GitHub Copilot CLI so that `copilot version` prints a version, put it on PATH, ' +
        'or pass --binary <path>. This probe has no stub fallback: a missing binary is an absent probe, ' +
        'not a negative finding, so no report is written and the exit code is non-zero.',
    )
  }
  const match = versionOutput.match(/\d+\.\d+\.\d+/)
  if (match === null) {
    throw new ProbeFailure(
      3,
      `${binary} --version produced no parseable version: ${JSON.stringify(versionOutput)}. ` +
        'A version that cannot be read invalidates the capture, so no report is written.',
    )
  }
  return {
    // Spawned by the argument as given, so `--binary /some/path/copilot` cannot resolve to a
    // different binary on PATH. Recorded by basename, because the full path is the
    // operator's filesystem layout rather than a property of the protocol.
    executable: binary,
    record: {
      binary: path.basename(binary),
      argv: ['--acp'],
      version: match[0],
      versionCommand: `${binary} --version`,
      versionOutput,
    },
  }
}

/**
 * The ACP client. Owns the child process, answers agent-initiated requests, and records
 * the stdout stream verbatim in memory. The raw lines never reach the artefact; they are
 * the input to the parser above, and keeping them in memory only is what lets the same
 * logic be replayed from a transcript.
 */
function startAcpSession({ child }) {
  const rawLines = []
  const frames = []
  const stderrChunks = []
  const listeners = new Set()
  const clientRequests = []
  const agentRequests = []
  let buffer = ''
  let nextId = 0

  const wake = () => {
    for (const listener of [...listeners]) listener()
  }
  /**
   * Wait for a predicate, with a deadline that is honoured whether or not frames arrive. The
   * 250ms timer is a *re-check* tick, not a deadline: a harness that goes quiet would
   * otherwise fail the wait after one tick instead of at the timeout, which is how a
   * deadline that looks implemented stops being one. Only the deadline below throws.
   */
  const waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (predicate()) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new ProbeTimeout(label, timeoutMs)
      await new Promise((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          listeners.delete(listener)
          resolve()
        }
        const listener = () => finish()
        const timer = setTimeout(finish, Math.min(remaining, 250))
        listeners.add(listener)
      })
    }
  }
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)

  /** Answer an agent-to-client request. Permission is granted once, never remembered. */
  const answerAgentRequest = (frame) => {
    const { message } = frame
    if (message.method !== PERMISSION_METHOD) {
      agentRequests.push({ frameIndex: frame.index, method: message.method, answered: 'error -32601' })
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `probe: unhandled agent request ${message.method}` },
      })
      return
    }
    const options = Array.isArray(message.params?.options) ? message.params.options : []
    // `allow_once` is preferred over `allow_always` on purpose: allowing always would
    // persist a new permission into the developer's own Copilot configuration, and a probe
    // has no business changing it. Preferring the once-variant also keeps the run
    // reproducible, since nothing carries over to the next run.
    const chosen =
      options.find((option) => option?.kind === 'allow_once') ??
      options.find((option) => typeof option?.kind === 'string' && option.kind.startsWith('allow')) ??
      options[0]
    const granted = isObject(chosen) && typeof chosen.optionId === 'string'
    agentRequests.push({
      frameIndex: frame.index,
      method: message.method,
      answered: granted ? 'selected' : 'cancelled',
      optionId: granted ? chosen.optionId : null,
    })
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        outcome: granted ? { outcome: 'selected', optionId: chosen.optionId } : { outcome: 'cancelled' },
      },
    })
  }

  const respondToAgentRequests = () => {
    for (const frame of frames) {
      if (frame.answered === true) continue
      const hasMethod = typeof frame.message.method === 'string'
      const hasId = frame.message.id !== undefined && frame.message.id !== null
      if (!hasMethod || !hasId) continue
      frame.answered = true
      answerAgentRequest(frame)
    }
  }

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() !== '') {
        rawLines.push(line)
        try {
          const message = JSON.parse(line)
          if (isObject(message)) frames.push({ index: frames.length, message, receivedAt: nowIso() })
        } catch {
          // Left in rawLines; parseRawLines reports it as an unparsed line.
        }
      }
      newline = buffer.indexOf('\n')
    }
    // Answered here rather than from a second stdout listener, so the ordering against the
    // frame push above is explicit instead of relying on listener registration order.
    respondToAgentRequests()
    wake()
  })

  // Drained, not just piped: an undrained stderr fills its pipe buffer and blocks the child
  // mid-session, which would look like a hung harness rather than a full pipe.
  child.stderr.on('data', (chunk) => {
    if (stderrChunks.length < 200) stderrChunks.push(chunk.toString('utf8'))
  })

  const call = async (method, params, timeoutMs) => {
    const id = nextId
    nextId += 1
    clientRequests.push({ id, method })
    send({ jsonrpc: '2.0', id, method, params })
    let response
    await waitFor(
      () => {
        response = frames.find((frame) => frame.message.id === id && frame.message.method === undefined)
        return response !== undefined
      },
      timeoutMs,
      method,
    )
    if (response.message.error !== undefined) {
      throw new ProbeFailure(4, `${method} failed: ${JSON.stringify(response.message.error)}`)
    }
    return response.message.result
  }

  return {
    rawLines,
    frames,
    clientRequests,
    agentRequests,
    call,
  }
}

const progress = (message) => process.stderr.write(`[${PROBE_NAME}] ${message}\n`)

function parseArgs(argv) {
  const args = {
    binary: DEFAULT_BINARY,
    out: DEFAULT_ARTIFACT,
    transcript: null,
    handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
    sessionTimeoutMs: SESSION_TIMEOUT_MS,
    turnTimeoutMs: TURN_TIMEOUT_MS,
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
      case '--transcript':
        args.transcript = next()
        break
      case '--handshake-timeout-ms':
        args.handshakeTimeoutMs = Number(next())
        break
      case '--turn-timeout-ms':
        args.turnTimeoutMs = Number(next())
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

Probes the real GitHub Copilot CLI in ACP mode over stdio, performs the initialize
handshake, drives one turn that must reach a tool and one that must not, and records
every JSON-RPC frame it saw.

Options:
  --binary <path>              Copilot CLI binary to probe (default: ${DEFAULT_BINARY})
  --out <path>                 Where to write the evidence artefact
                               (default: ${DEFAULT_ARTIFACT})
  --transcript <path>          Analyse a captured stream instead of launching the binary
  --handshake-timeout-ms <n>   Deadline for initialize and session/new (default: ${HANDSHAKE_TIMEOUT_MS})
  --turn-timeout-ms <n>        Deadline for each session/prompt (default: ${TURN_TIMEOUT_MS})
  -h, --help                   This text

Exit codes: 0 capture recorded, 1 an assertion failed, 2 usage error,
3 the binary is missing or unreadable, 4 the handshake did not complete or nothing was
captured, 5 a phase passed its deadline. Codes 2, 3, 4 and 5 write no artefact: absence
of evidence is never a negative finding.
`

/** Analyse a captured stream. Shares every line of logic with the live path. */
function runTranscript(args) {
  const absolute = path.isAbsolute(args.transcript)
    ? args.transcript
    : path.join(repoRoot, args.transcript)
  const captured = JSON.parse(readFileSync(absolute, 'utf8'))
  const requestMethodsById = new Map(
    (captured.clientRequests ?? []).map((request) => [request.id, request.method]),
  )
  const startedAt = captured.startedAt ?? nowIso()
  const evidence = buildEvidence({
    cli: {
      binary: captured.cli?.binary ?? 'unknown',
      argv: captured.cli?.argv ?? ['--acp'],
      version: captured.cli?.version ?? null,
      versionCommand: captured.cli?.versionCommand ?? null,
      versionOutput: captured.cli?.versionOutput ?? null,
    },
    timestamps: {
      startedAt,
      finishedAt: captured.finishedAt ?? nowIso(),
      handshakeAt: captured.timestamps?.handshakeAt ?? null,
      turnEndedAt: (captured.timestamps?.turnEndedAt ?? []).slice(),
      source: 'transcript',
      transcript: path.basename(absolute),
    },
    rawLines: captured.rawLines ?? [],
    requestMethodsById,
    answeredAgentRequests: Array.isArray(captured.answeredAgentRequests)
      ? captured.answeredAgentRequests
      : null,
  })
  return { evidence, transcript: path.basename(absolute) }
}

/** Launch the real binary and drive the two turns. */
async function runLive(args) {
  const { executable, record: cli } = resolveBinary(args.binary)
  progress(`copilot ${cli.version} at ${cli.binary}`)

  const cwd = mkdtempSync(path.join(tmpdir(), 'agent-ping-copilot-acp-'))
  // A file in the working directory, so the driven tool has something real to act on
  // rather than an empty directory the model has to reason about.
  writeFileSync(path.join(cwd, 'README.md'), '# agent-ping ACP probe workspace\n')

  const env = { ...process.env, NO_COLOR: '1' }
  const stripped = []
  for (const name of STRIPPED_ENV) {
    if (env[name] !== undefined) stripped.push(name)
    delete env[name]
  }

  const startedAt = nowIso()
  const child = spawn(executable, cli.argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const session = startAcpSession({ child })
  const timestamps = {
    startedAt,
    handshakeAt: null,
    turnEndedAt: [],
    finishedAt: null,
    source: 'live',
    strippedEnvironment: stripped,
  }
  const spawnFailure = new Promise((resolve) => {
    child.on('error', resolve)
    child.on('exit', () => resolve(null))
  })

  try {
    progress('initialize')
    const initialised = await Promise.race([
      session.call(
        'initialize',
        {
          protocolVersion: 1,
          // Both client capabilities are declared false on purpose. Declaring fs access
          // would make the agent route file reads back through this probe, and the probe is
          // a recorder, not a filesystem shim.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        },
        args.handshakeTimeoutMs,
      ),
      spawnFailure.then((error) => {
        if (error === null) {
          throw new ProbeFailure(4, 'the Copilot CLI exited before answering initialize')
        }
        throw new ProbeFailure(3, `could not start ${executable}: ${error.message}`)
      }),
    ])
    timestamps.handshakeAt = nowIso()
    progress(`protocolVersion=${JSON.stringify(initialised.protocolVersion)}`)

    progress('session/new')
    const created = await session.call('session/new', { cwd, mcpServers: [] }, args.sessionTimeoutMs)
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new ProbeFailure(4, `session/new returned no sessionId: ${JSON.stringify(created)}`)
    }
    progress(`session ${sessionId}`)

    for (const [label, text] of [
      ['turn 1 (must reach a tool)', PROMPT_WITH_TOOL],
      ['turn 2 (must not reach a tool)', PROMPT_WITHOUT_TOOL],
    ]) {
      progress(label)
      const stopped = await session.call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, args.turnTimeoutMs)
      timestamps.turnEndedAt.push(nowIso())
      progress(`${label} stopReason=${JSON.stringify(stopped?.stopReason)}`)
    }
  } finally {
    timestamps.finishedAt = nowIso()
    // SIGKILL rather than SIGTERM: the CLI owns a session store and a child shell, and a
    // probe that leaves either behind is a probe that made the machine worse.
    child.kill('SIGKILL')
    rmSync(cwd, { recursive: true, force: true })
  }

  const requestMethodsById = new Map(
    session.clientRequests.map((request) => [request.id, request.method]),
  )
  const evidence = buildEvidence({
    cli,
    timestamps,
    rawLines: session.rawLines,
    requestMethodsById,
    answeredAgentRequests: session.agentRequests,
  })
  return { evidence }
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

  let outcome
  try {
    outcome = args.transcript === null ? await runLive(args) : runTranscript(args)
  } catch (error) {
    // A dependency failure or a handshake that never completed. No artefact is written:
    // an empty report is indistinguishable from "there was nothing to find".
    const code = error instanceof ProbeFailure ? error.code : error instanceof ProbeTimeout ? 5 : 1
    emitSummary(
      scrubHomePaths({
        script: PROBE_NAME,
        verdict: 'fail',
        exitCode: code,
        failure: `${error.name}: ${error.message}`,
        remedy:
          code === 3
            ? 'install GitHub Copilot CLI so that `copilot version` prints a version, then re-run'
            : 're-run the probe; if the handshake keeps failing, the ACP surface has changed and the report must say so',
        artifact: null,
        artifactWritten: false,
        assertionsRun: 0,
        assertionsExpected: ASSERTIONS_EXPECTED,
      }),
    )
    process.stderr.write(`[${PROBE_NAME}] ${error.name}: ${error.message}\n`)
    return code
  }

  const { evidence } = outcome
  const decision = decide(evidence)
  // The non-vacuity guard, below the decision function: a capture with no completed
  // handshake or no frames at all cannot be written out as a report, whatever the
  // assertions say. A report that exists is a report that has something in it.
  if (evidence.handshake.completed !== true || evidence.observed.frameCount === 0) {
    const reasons = []
    if (evidence.observed.frameCount === 0) {
      reasons.push('the capture contains no JSON-RPC frames, so there is no evidence to report')
    }
    if (evidence.handshake.reason !== null) reasons.push(evidence.handshake.reason)
    emitSummary(
      scrubHomePaths({
        script: PROBE_NAME,
        verdict: 'fail',
        exitCode: 4,
        failure: reasons.join('; '),
        artifact: null,
        artifactWritten: false,
        // The failing assertions travel with the exit, because there is no report to read:
        // a non-zero exit that does not say what failed trains people to ignore it.
        assertionsRun: decision.assertionsRun,
        assertionsExpected: decision.assertionsExpected,
        assertions: decision.assertions,
        failures: decision.failures,
      }),
    )
    process.stderr.write(`[${PROBE_NAME}] no evidence captured; no report written\n`)
    return 4
  }

  const artifact = writeArtifact(args.out, evidence, decision)
  emitSummary(
    scrubHomePaths({
      script: PROBE_NAME,
      verdict: decision.verdict,
      exitCode: decision.exitCode,
      cliVersion: evidence.cli.version,
      startedAt: evidence.timestamps.startedAt,
      finishedAt: evidence.timestamps.finishedAt,
      source: evidence.timestamps.source,
      ...findings(evidence),
      assertionsRun: decision.assertionsRun,
      assertionsExpected: decision.assertionsExpected,
      assertions: decision.assertions,
      failures: decision.failures,
      artifact: args.out,
      artifactWritten: true,
    }),
  )
  progress(`artefact written to ${artifact}`)
  for (const failure of decision.failures) process.stderr.write(`[${PROBE_NAME}] FAIL ${failure}\n`)
  return decision.exitCode
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) process.exit(await main(process.argv.slice(2)))
