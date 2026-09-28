// Tests the Copilot ACP probe (CP-1, CP-FR-01, CP-FR-03).
//
// Every assertion here drives the real script as a child process, so what is verified is
// the shipped entry point rather than a re-export of its internals. Three shapes are driven:
//
//   - the captured transcript, a sanitised copy of a real `copilot --acp` run
//     (tests/scripts/fixtures/copilot-acp-capture.json). Its key names, enum values, array
//     lengths and frame order are exactly what the CLI emitted; only the strings under
//     non-literal keys are placeholders. This is how the parsing and recording logic is
//     proven without a Copilot binary on the machine.
//   - hand-built minimal streams, for the negative and failure paths.
//   - a stub binary that answers --version and then goes silent, for the deadline.
//
// The four acceptance criteria are covered by name in the describe blocks below: the
// handshake recording, the loud non-zero exits, permission recorded distinctly from session
// updates, and the version plus timestamps in the artefact.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeTree } from '../helpers/remove-tree'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const probePath = path.join(repoRoot, 'scripts', 'probe-copilot-acp.mjs')
const capturedTranscriptPath = path.join(repoRoot, 'tests', 'scripts', 'fixtures', 'copilot-acp-capture.json')
const trackedCapturePath = path.join(repoRoot, 'docs', 'research', 'copilot-acp-capture.json')

/**
 * Scratch space, created at module scope because the helper below resolves paths from it
 * and the describes are collected before any hook runs. Every run writes here, never into
 * the repository, and afterAll removes it.
 */
const scratch = mkdtempSync(path.join(tmpdir(), 'agent-ping-acp-probe-test-'))

interface RunResult {
  status: number
  /** stdout, parsed. The script promises the summary is the only thing on stdout. */
  summary: Record<string, unknown>
  stderr: string
  elapsedMs: number
}

/** Hard ceiling on a child run, so a wedged probe fails this suite instead of hanging it. */
const CHILD_TIMEOUT_MS = 25_000

/** Drive the real script, the way an operator or CI would. */
function runProbe(args: string[]): RunResult {
  const startedAt = Date.now()
  const result = spawnSync(process.execPath, [probePath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: CHILD_TIMEOUT_MS,
  })
  if (result.error !== undefined) throw result.error
  return {
    status: result.status ?? 1,
    // A parse failure here means the script put progress on stdout, which is one of the
    // defects these tests exist to catch, so it is allowed to throw rather than paper over.
    summary: JSON.parse(result.stdout ?? '') as Record<string, unknown>,
    stderr: result.stderr ?? '',
    elapsedMs: Date.now() - startedAt,
  }
}

const outPath = (name: string) => path.join(scratch, name)
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
const readCaptured = () => readJson(capturedTranscriptPath) as Record<string, unknown>

/** The value at a dotted path with optional [n] indexes, so an assertion reads like the document. */
function at(source: unknown, dotted: string): unknown {
  return dotted
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((part) => part !== '')
    .reduce<unknown>((node, key) => {
      if (node === null || typeof node !== 'object') return undefined
      return (node as Record<string, unknown>)[key]
    }, source)
}

/** Every string in a value, with its dotted path. Used by the verbatim and leak guards. */
function collectStrings(value: unknown, dotted = '', out: [string, string][] = []): [string, string][] {
  if (typeof value === 'string') {
    out.push([dotted, value])
    return out
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, `${dotted}[${index}]`, out))
    return out
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectStrings(child, dotted === '' ? key : `${dotted}.${key}`, out)
    }
  }
  return out
}

/** Every key name appearing anywhere in a value. */
function collectKeyNames(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeyNames(item, out))
    return out
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.add(key)
      collectKeyNames(child, out)
    }
  }
  return out
}

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * A minimal, hand-built stream shaped like the capture but carrying recognisable content, so
 * the redaction guard has something to catch. Deliberately not a transcript of a real run:
 * its purpose is the leak, not the shape.
 */
const LEAKY_PROMPT = 'Use the shell tool to run the command `ls` in the working directory.'
const leakyTranscript = {
  cli: { binary: 'copilot', argv: ['--acp'], version: '9.9.9', versionOutput: 'GitHub Copilot CLI 9.9.9' },
  startedAt: '2026-09-27T10:00:00.000Z',
  finishedAt: '2026-09-27T10:00:09.000Z',
  clientRequests: [
    { id: 0, method: 'initialize' },
    { id: 1, method: 'session/new' },
    { id: 2, method: 'session/prompt' },
  ],
  rawLines: [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: 'Copilot', title: 'Copilot', version: '9.9.9' },
        authMethods: [{ id: 'copilot-login', name: 'Log in with Copilot CLI' }],
      },
    }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { sessionId: 'leak-session' } }),
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'leak-session',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_leak',
          title: 'LEAK-TITLE-TEXT',
          kind: 'execute',
          status: 'pending',
          rawInput: { command: 'LEAK-COMMAND-TEXT' },
        },
      },
    }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/request_permission',
      params: {
        sessionId: 'leak-session',
        toolCall: { toolCallId: 'call_leak', title: 'LEAK-TITLE-TEXT', kind: 'execute', status: 'pending' },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
        ],
      },
    }),
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'leak-session',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_leak', rawOutput: 'LEAK-TOOL-OUTPUT' },
      },
    }),
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'leak-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LEAK-AGENT-TEXT' } },
      },
    }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } }),
  ],
}

/** Content the artefact must never hold. The last entry is the probe's own prompt text. */
const SECRETS = [
  'LEAK-TITLE-TEXT',
  'LEAK-COMMAND-TEXT',
  'LEAK-TOOL-OUTPUT',
  'LEAK-AGENT-TEXT',
  LEAKY_PROMPT,
]

const writeTranscript = (name: string, value: unknown): string => {
  const file = outPath(name)
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
  return file
}

/** Analyse a stream and return the run plus the artefact it wrote, or undefined. */
function probeTranscript(name: string, transcript: unknown): { run: RunResult; artefact?: Record<string, unknown> } {
  const target = outPath(`${name}.json`)
  const run = runProbe(['--transcript', writeTranscript(name, transcript), '--out', target])
  return existsSync(target) ? { run, artefact: readJson(target) } : { run }
}

afterAll(() => {
  removeTree(scratch)
})

describe('records the handshake from a captured transcript', () => {
  let run: RunResult
  let artefact: Record<string, unknown>

  beforeAll(() => {
    const outcome = probeTranscript('capture', readCaptured())
    run = outcome.run
    artefact = outcome.artefact ?? {}
  })

  it('exits zero with every assertion executed', () => {
    expect(run.status).toBe(0)
    expect(run.summary['verdict']).toBe('pass')
    // Non-vacuity: a summary that ran no assertion would prove nothing about the capture.
    expect(run.summary['assertionsRun']).toBe(10)
    expect(run.summary['assertionsExpected']).toBe(10)
    expect(run.summary['failures']).toEqual([])
  })

  it('records the negotiated protocol version', () => {
    expect(at(artefact, 'handshake.completed')).toBe(true)
    expect(at(artefact, 'handshake.protocolVersion')).toBe(1)
    // On the frame itself, not only in the summary: the version is a captured field.
    expect(at(artefact, 'frames[0].shape.result.protocolVersion')).toBe(1)
  })

  it('records the advertised agent capabilities verbatim', () => {
    expect(at(artefact, 'handshake.agentCapabilities')).toEqual({
      loadSession: true,
      mcpCapabilities: { http: true, sse: true },
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      sessionCapabilities: { close: {}, list: {} },
    })
    // agentInfo is recorded verbatim because the initialize result carries harness metadata
    // only; the fixture has already replaced its strings with placeholders, so only the
    // name survives as a literal. Asserting the shape rather than the exact strings is the
    // point: the values are the fixture's, the fields are the CLI's.
    expect(at(artefact, 'handshake.agentInfo.name')).toBe('Copilot')
    expect(Object.keys(at(artefact, 'handshake.agentInfo') as object).sort()).toEqual([
      'name',
      'title',
      'version',
    ])
  })

  it('records the advertised authentication methods verbatim', () => {
    const methods = at(artefact, 'handshake.authMethods') as Record<string, unknown>[]
    expect(Array.isArray(methods)).toBe(true)
    expect(at(artefact, 'handshake.authMethodsCount')).toBe(1)
    // One method, carrying the fields a real auth method carries, with its string values
    // whatever the captured stream held. The concrete values are asserted below against a
    // transcript whose strings are real, and against the committed live capture.
    expect(Object.keys(methods[0] ?? {}).sort()).toEqual(['_meta', 'description', 'id', 'name'])
    expect(typeof methods[0]?.['id']).toBe('string')
    expect(typeof (at(artefact, 'handshake.authMethods[0]._meta.terminal-auth.label') as unknown)).toBe(
      'string',
    )
  })

  it('records the concrete capability and auth values from a stream whose strings are real', () => {
    // The captured fixture sanitises its strings, so the concrete advertised values are read
    // here from a stream that carries them. This is the same code path as the fixture run.
    const outcome = probeTranscript('handshake-values', leakyTranscript)
    const evidence = outcome.artefact ?? {}
    expect(outcome.run.status).toBe(0)
    expect(at(evidence, 'handshake.protocolVersion')).toBe(1)
    expect(at(evidence, 'handshake.authMethods[0].id')).toBe('copilot-login')
    expect(at(evidence, 'handshake.authMethods[0].name')).toBe('Log in with Copilot CLI')
    expect(at(evidence, 'handshake.agentInfo')).toEqual({
      name: 'Copilot',
      title: 'Copilot',
      version: '9.9.9',
    })
  })

  it('reads the capabilities and auth methods out of the stream, not out of a constant', () => {
    // Every literal the handshake records must appear verbatim in the captured stream.
    // Without this, a probe that hard-coded the answer would satisfy the three tests above.
    const stream = (readCaptured()['rawLines'] as string[]).join('\n')
    const handshakeStrings = collectStrings(at(artefact, 'handshake.raw'))
    expect(handshakeStrings.length).toBeGreaterThan(5)
    for (const [dotted, value] of handshakeStrings) {
      expect(stream, `${dotted} = ${value} is not in the captured stream`).toContain(value)
    }
  })
})

describe('writes the exact CLI version and timestamps into the report artifact', () => {
  let run: RunResult
  let artefact: Record<string, unknown>

  beforeAll(() => {
    const outcome = probeTranscript('capture', readCaptured())
    run = outcome.run
    artefact = outcome.artefact ?? {}
  })

  it('records the version, the command it came from and the raw output', () => {
    const capturedCli = readCaptured()['cli'] as { versionOutput: string }
    expect(at(artefact, 'cli.version')).toBe('1.0.88')
    expect(at(artefact, 'cli.versionCommand')).toBe('copilot --version')
    expect(at(artefact, 'cli.versionOutput')).toBe(capturedCli.versionOutput)
    // The binary is named too, so a reader knows what produced the capture.
    expect(at(artefact, 'cli.binary')).toBe('copilot')
    expect(at(artefact, 'cli.argv')).toEqual(['--acp'])
  })

  it('records a start, a handshake and a finish time for the run', () => {
    expect(at(artefact, 'timestamps.startedAt')).toMatch(ISO_8601)
    expect(at(artefact, 'timestamps.handshakeAt')).toMatch(ISO_8601)
    expect(at(artefact, 'timestamps.finishedAt')).toMatch(ISO_8601)
    // One timestamp per driven turn, so a later reader can see both turns ran.
    const turnEndedAt = at(artefact, 'timestamps.turnEndedAt') as string[]
    expect(turnEndedAt).toHaveLength(2)
    for (const stamp of turnEndedAt) expect(stamp).toMatch(ISO_8601)
  })

  it('reports the same version and timestamps on stdout', () => {
    expect(run.summary['cliVersion']).toBe('1.0.88')
    expect(run.summary['startedAt']).toBe(at(artefact, 'timestamps.startedAt'))
    expect(run.summary['finishedAt']).toBe(at(artefact, 'timestamps.finishedAt'))
  })
})

describe('records permission notifications distinctly from ordinary session updates', () => {
  let artefact: Record<string, unknown>

  beforeAll(() => {
    artefact = probeTranscript('capture', readCaptured()).artefact ?? {}
  })

  it('keeps the permission path in its own section, never in the notification inventory', () => {
    expect(at(artefact, 'permissionPath.method')).toBe('session/request_permission')
    // The distinction is structural, not cosmetic: a permission request arrives as an
    // agent-to-client *request* carrying a decision, not as a progress notification.
    expect(at(artefact, 'permissionPath.frameKind')).toBe('agent-request')
    expect(at(artefact, 'observed.notificationMethods')).toEqual(['session/update'])
    expect(at(artefact, 'observed.agentRequestMethods')).toEqual(['session/request_permission'])
  })

  it('records the permission request and its options verbatim', () => {
    expect(at(artefact, 'permissionPath.state')).toBe('observed')
    expect(at(artefact, 'permissionPath.requestCount')).toBe(1)
    const request = at(artefact, 'permissionPath.requests[0]') as Record<string, unknown>
    expect(request['toolCallId']).toMatch(/^call_/)
    expect(request['toolKind']).toBe('execute')
    expect(request['toolStatus']).toBe('pending')
    expect(request['options']).toEqual([
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
    ])
  })

  it('records that the signal discriminated between the two driven turns', () => {
    // Turn 1 had to reach a tool; turn 2 had not to. A request on the first and none on the
    // second is what separates a signal that discriminates from a run that was merely quiet.
    expect(at(artefact, 'permissionPath.turnsObserved')).toBe(2)
    expect(at(artefact, 'permissionPath.turnsWithRequest')).toBe(1)
    expect(at(artefact, 'permissionPath.turnsWithoutRequest')).toBe(1)
  })

  it('records the permission frame as a request and the tool call as a notification', () => {
    const frames = at(artefact, 'frames') as { kind: string; method: string | null }[]
    expect(frames.find((frame) => frame.method === 'session/request_permission')?.kind).toBe(
      'agent-request',
    )
    const toolUpdate = frames.find(
      (frame) => at(frame, 'shape.params.update.sessionUpdate') === 'tool_call',
    )
    expect(toolUpdate?.kind).toBe('notification')
  })

  it('records what the probe answered, so an emitted request is not confused with a granted one', () => {
    const answered = at(artefact, 'permissionPath.answered') as { method: string; answered: string }[]
    expect(answered).toHaveLength(1)
    expect(answered[0]?.method).toBe('session/request_permission')
    expect(answered[0]?.answered).toBe('selected')
  })

  it('never records the permission signal as a finished-turn observation', () => {
    // A permission request is a block, not a turn boundary. Counting one as a turn end would
    // make a Copilot block and a Copilot finish indistinguishable downstream.
    expect(at(artefact, 'turnEndSignal.stopReasons')).toEqual(['end_turn', 'end_turn'])
    expect(at(artefact, 'permissionPath.method')).not.toBe('session/prompt')
  })
})

describe('records every notification type and field actually observed', () => {
  let artefact: Record<string, unknown>

  beforeAll(() => {
    artefact = probeTranscript('capture', readCaptured()).artefact ?? {}
  })

  it('lists the session/update variants the run actually produced', () => {
    expect(at(artefact, 'observed.sessionUpdateVariants')).toEqual([
      'agent_message_chunk',
      'available_commands_update',
      'config_option_update',
      'session_info_update',
      'tool_call',
      'tool_call_update',
      'usage_update',
    ])
  })

  it('records one frame per captured line, in order', () => {
    const captured = readCaptured()['rawLines'] as string[]
    const frames = at(artefact, 'frames') as { index: number }[]
    expect(frames).toHaveLength(captured.length)
    expect(frames.map((frame) => frame.index)).toEqual(captured.map((_, index) => index))
    expect(at(artefact, 'observed.frameCount')).toBe(captured.length)
  })

  it('records the turn-end signal and the absence of a dedicated idle notification', () => {
    // The negative finding, stated as a search over the names the CLI really used rather
    // than an assumption: the variants it did emit are recorded beside the result.
    expect(at(artefact, 'turnEndSignal.idleNotificationObserved')).toBe(false)
    expect(at(artefact, 'turnEndSignal.idleMarkersMatched')).toEqual([])
    expect(at(artefact, 'turnEndSignal.state')).toBe('not-triggered')
    expect(at(artefact, 'turnEndSignal.turnBoundaryAttribution')).toBe('known')
    expect(at(artefact, 'turnEndSignal.turnBoundaryRequestMethods')).toEqual(['session/prompt'])
  })
})

describe('fails loudly instead of writing an empty report', () => {
  it('exits non-zero and writes nothing when the binary is missing', () => {
    const target = outPath('must-not-be-written.json')
    const run = runProbe(['--binary', outPath('no-such-copilot'), '--out', target])

    expect(run.status).not.toBe(0)
    expect(run.status).toBe(3)
    expect(run.summary['verdict']).toBe('fail')
    expect(run.summary['artifactWritten']).toBe(false)
    expect(run.summary['artifact']).toBeNull()
    // A non-zero exit with no next action trains people to ignore the exit code.
    expect(String(run.summary['remedy'])).toContain('copilot version')
    expect(existsSync(target)).toBe(false)
  })

  it('exits non-zero and writes nothing when the handshake never completed', () => {
    const captured = readCaptured()['rawLines'] as string[]
    // The initialize response removed: the stream is real traffic, just not a handshake.
    const withoutHandshake = captured.filter((line) => !line.includes('"protocolVersion"'))
    const { run, artefact } = probeTranscript('no-handshake', {
      ...readCaptured(),
      rawLines: withoutHandshake,
    })

    expect(run.status).not.toBe(0)
    expect(run.status).toBe(4)
    expect(run.summary['verdict']).toBe('fail')
    expect(run.summary['artifactWritten']).toBe(false)
    expect(String(run.summary['failure'])).toContain('no initialize response')
    expect(artefact).toBeUndefined()
  })

  it('exits non-zero and writes nothing when initialize comes back as an error', () => {
    const { run, artefact } = probeTranscript('handshake-error', {
      ...leakyTranscript,
      rawLines: [
        JSON.stringify({ jsonrpc: '2.0', id: 0, error: { code: -32601, message: 'no such method' } }),
        ...leakyTranscript.rawLines.slice(1),
      ],
    })

    expect(run.status).toBe(4)
    expect(run.summary['artifactWritten']).toBe(false)
    expect(String(run.summary['failure'])).toContain('no such method')
    expect(artefact).toBeUndefined()
  })

  it('exits non-zero and writes nothing when the capture is empty', () => {
    const { run, artefact } = probeTranscript('empty', { ...leakyTranscript, rawLines: [] })

    // The report is withheld, because a report whose subject is nothing cannot be told apart
    // from a report that found nothing. Only one row may pass, and it is the one that reads
    // the transcript file rather than the stream: an assertion that goes vacuously green on
    // an empty capture is how a probe that ran nothing reports a clean run.
    expect(run.status).toBe(4)
    expect(run.summary['verdict']).toBe('fail')
    expect(String(run.summary['failure'])).toContain('no JSON-RPC frames')
    const assertions = run.summary['assertions'] as { name: string; outcome: string }[]
    expect(assertions).toHaveLength(10)
    expect(assertions.filter((assertion) => assertion.outcome === 'pass').map((a) => a.name)).toEqual([
      'cli version captured',
    ])
    expect(artefact).toBeUndefined()
  })

  it('exits non-zero on a usage error and writes nothing', () => {
    const target = outPath('usage.json')
    const result = spawnSync(process.execPath, [probePath, '--not-a-flag', '--out', target], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('unknown argument --not-a-flag')
    expect(existsSync(target)).toBe(false)
  })

  it('reports an unreadable line as a contract change rather than skipping it', () => {
    // A banner, a log line or a partial write on the agent's stdout is a change to the
    // surface. It is recorded and it fails, and the report is still written because the
    // handshake did complete and the traffic is real evidence.
    const { run, artefact } = probeTranscript('garbled', {
      ...leakyTranscript,
      rawLines: ['Copilot ACP ready', ...leakyTranscript.rawLines],
    })
    const evidence = artefact ?? {}

    expect(run.status).toBe(1)
    expect(run.summary['verdict']).toBe('fail')
    expect(run.summary['artifactWritten']).toBe(true)
    const unparsed = at(evidence, 'unparsedLines') as { reason: string }[]
    expect(unparsed).toHaveLength(1)
    expect(unparsed[0]?.reason).toContain('invalid JSON')
    const failed = run.summary['assertions'] as { name: string; outcome: string }[]
    expect(
      failed.find(
        (assertion) => assertion.name === 'at least one line was captured and every captured line parsed as a JSON-RPC frame',
      )?.outcome,
    ).toBe('fail')
  })

  it('fails when a driven turn reached no tool, and reports the permission path as undetermined', () => {
    // Both the tool call and the permission request removed, so the path was never
    // exercised. The signal is then undetermined rather than absent: recording "absent"
    // here is the fabricated negative finding this feature exists to prevent, and this is
    // the assertion that stops it happening.
    const { run, artefact } = probeTranscript('no-tool', {
      ...leakyTranscript,
      rawLines: leakyTranscript.rawLines.filter(
        (line) => !line.includes('tool_call') && !line.includes('session/request_permission'),
      ),
    })
    const evidence = artefact ?? {}

    expect(run.status).toBe(1)
    expect(at(evidence, 'permissionPath.state')).toBe('unresolved')
    expect((run.summary['failures'] as string[]).join('\n')).toContain('a tool call was observed')
  })

  it('reports a permission request that never arrived as not-triggered, not as absent', () => {
    // A tool call happened and no request came for it: the signal exists and was silent.
    // That is a different fact from the harness having no such signal, and the two states
    // degrade differently, so the capture must not collapse them.
    const { run, artefact } = probeTranscript('silent-permission', {
      ...leakyTranscript,
      rawLines: leakyTranscript.rawLines.filter(
        (line) => !line.includes('session/request_permission'),
      ),
    })
    const evidence = artefact ?? {}

    expect(run.status).toBe(0)
    expect(at(evidence, 'permissionPath.state')).toBe('not-triggered')
    expect(at(evidence, 'permissionPath.requestCount')).toBe(0)
    expect(at(evidence, 'permissionPath.turnsWithRequest')).toBe(0)
    expect(at(evidence, 'permissionPath.turnsWithoutRequest')).toBe(1)
  })
})

describe('honours the handshake deadline against a binary that never answers', () => {
  it('waits for the deadline, then fails non-zero without writing a report', () => {
    // The stub answers --version and then goes silent, so the only thing that can end the
    // wait is the deadline. A poll tick that ends it early is a timeout that looks
    // implemented and is not.
    const stub = outPath('silent-copilot')
    writeFileSync(
      stub,
      [
        '#!/usr/bin/env node',
        "if (process.argv.includes('--version')) {",
        "  process.stdout.write('GitHub Copilot CLI 9.9.9\\n')",
        '  process.exit(0)',
        '}',
        'process.stdin.resume()',
        'setInterval(() => {}, 1000)',
        '',
      ].join('\n'),
    )
    chmodSync(stub, 0o755)
    const target = outPath('silent.json')
    const run = runProbe(['--binary', stub, '--handshake-timeout-ms', '2000', '--out', target])

    expect(run.status).not.toBe(0)
    expect(run.status).toBe(5)
    expect(String(run.summary['failure'])).toContain('timed out after 2000ms')
    expect(run.elapsedMs).toBeGreaterThanOrEqual(2000)
    expect(existsSync(target)).toBe(false)
  })
})

describe('never records conversation content in the report', () => {
  let run: RunResult
  let artefactText: string
  let artefact: Record<string, unknown>

  beforeAll(() => {
    const outcome = probeTranscript('leak-check', leakyTranscript)
    run = outcome.run
    artefact = outcome.artefact ?? {}
    artefactText = outcome.artefact === undefined ? '' : readFileSync(outPath('leak-check.json'), 'utf8')
  })

  it('keeps prompt, tool-input, tool-output and agent text out of the artefact', () => {
    expect(run.status).toBe(0)
    for (const secret of SECRETS) {
      expect(artefactText, `${secret} reached the artefact`).not.toContain(secret)
    }
  })

  it('replaces those strings with a length marker rather than dropping the field', () => {
    // Redaction must not become truncation: the field still appears, so a reader can see
    // that the field exists even though its text is withheld.
    const shapeText = JSON.stringify(at(artefact, 'frames'))
    expect(shapeText).toContain('$string')
    expect(shapeText).toContain('rawOutput')
    expect(shapeText).toContain('rawInput')
  })

  it('keeps the structural values that are the evidence', () => {
    expect(at(artefact, 'observed.sessionUpdateVariants')).toEqual([
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
    ])
    expect(at(artefact, 'permissionPath.requests[0].options[0].optionId')).toBe('allow_once')
    expect(at(artefact, 'frames[2].shape.params.update.toolCallId')).toBe('call_leak')
  })

  it('records the redaction policy in the artefact, so it is re-checkable', () => {
    const literalKeys = at(artefact, 'redaction.literalKeys') as string[]
    const contentKeys = at(artefact, 'redaction.contentBearingKeys') as string[]
    expect(literalKeys).toContain('sessionUpdate')
    expect(literalKeys).toContain('stopReason')
    expect(contentKeys).toContain('rawOutput')
    expect(contentKeys).toContain('text')
    expect(String(at(artefact, 'redaction.policy'))).toContain('APX-FR-01')
  })
})

describe('records the capture verbatim rather than paraphrasing it', () => {
  let artefact: Record<string, unknown>

  beforeAll(() => {
    artefact = probeTranscript('verbatim', leakyTranscript).artefact ?? {}
  })

  it('keeps every literal value exactly as the agent sent it', () => {
    const stream = leakyTranscript.rawLines.join('\n')
    const frames = at(artefact, 'frames') as { shape: unknown; method: string | null }[]
    // Only the shape and the method are the agent's words. The frame's own `kind` is the
    // probe's classification of the envelope and has no counterpart on the wire.
    const literals: [string, string][] = frames.flatMap((frame) =>
      collectStrings(frame.shape, frame.method === null ? '' : 'method'),
    )
    expect(literals.length).toBeGreaterThan(10)
    for (const [dotted, value] of literals) {
      expect(stream, `${dotted} = ${value} is not in the captured stream`).toContain(value)
    }
  })

  it('keeps every field name the agent used, and adds only the documented markers', () => {
    const frames = at(artefact, 'frames') as { shape: unknown }[]
    const capturedKeys = collectKeyNames(leakyTranscript.rawLines.map((line) => JSON.parse(line)))
    // The three markers are the only key names the probe adds, and they are the documented
    // redaction vocabulary: a string becomes a length, an array becomes a length plus its
    // first elements under `items`, and an absent value says so. Anything else absent from
    // the stream would be invented.
    const markers = new Set(['$string', '$array', '$undefined', 'items'])
    for (const key of collectKeyNames(frames.map((frame) => frame.shape))) {
      if (markers.has(key)) continue
      expect(capturedKeys.has(key), `${key} was invented by the probe`).toBe(true)
    }
  })

  it('records the decision alongside the evidence, so a reader need not re-run the probe', () => {
    expect(at(artefact, 'decision.verdict')).toBe('pass')
    expect(at(artefact, 'decision.assertionsRun')).toBe(10)
    expect(at(artefact, 'decision.assertionsExpected')).toBe(10)
    expect(at(artefact, 'decision.failures')).toEqual([])
    // The headline findings are promoted onto the artefact so the gate reads one object.
    expect(at(artefact, 'permissionRequestEmitted')).toBe(true)
    expect(at(artefact, 'permissionPathState')).toBe('observed')
    expect(at(artefact, 'dedicatedIdleNotificationObserved')).toBe(false)
  })
})

describe('the committed live capture is evidence, not a placeholder', () => {
  const artefact = existsSync(trackedCapturePath) ? readJson(trackedCapturePath) : {}

  it('records a real handshake from a real run', () => {
    expect(at(artefact, 'timestamps.source')).toBe('live')
    expect(at(artefact, 'cli.version')).toMatch(/^\d+\.\d+\.\d+/)
    expect(String(at(artefact, 'cli.versionOutput'))).toContain(String(at(artefact, 'cli.version')))
    expect(at(artefact, 'handshake.completed')).toBe(true)
    expect(at(artefact, 'handshake.protocolVersion')).toBe(1)
    // The real advertised auth method, recorded by a real run rather than a fixture.
    expect(at(artefact, 'handshake.authMethods[0].id')).toBe('copilot-login')
    expect(at(artefact, 'handshake.authMethodsCount')).toBe(1)
  })

  it('records the version, the timestamps and the two driven turns', () => {
    expect(at(artefact, 'timestamps.startedAt')).toMatch(ISO_8601)
    expect(at(artefact, 'timestamps.handshakeAt')).toMatch(ISO_8601)
    expect(at(artefact, 'timestamps.finishedAt')).toMatch(ISO_8601)
    expect(at(artefact, 'timestamps.turnEndedAt')).toHaveLength(2)
  })

  it('records the two findings the gate decision rests on', () => {
    expect(at(artefact, 'permissionPath.state')).toBe('observed')
    expect(at(artefact, 'permissionPath.turnsWithRequest')).toBe(1)
    expect(at(artefact, 'permissionPath.turnsWithoutRequest')).toBe(1)
    // No dedicated idle notification was seen; the turn boundary is the prompt response.
    expect(at(artefact, 'turnEndSignal.idleNotificationObserved')).toBe(false)
    expect(at(artefact, 'turnEndSignal.turnBoundaryRequestMethods')).toEqual(['session/prompt'])
    expect(at(artefact, 'decision.verdict')).toBe('pass')
  })

  it('holds no conversation content and no absolute path from the operator machine', () => {
    const text = readFileSync(trackedCapturePath, 'utf8')
    expect(text).not.toMatch(/\/home\//)
    expect(text).not.toMatch(/\/Users\//)
    expect(text).not.toContain('agent-ping-copilot-acp-')
    // Every string under a non-literal key is a length marker, so no field can hold the
    // prompt, the reply or a tool's output.
    const frames = at(artefact, 'frames') as { shape: unknown }[]
    const literals = collectStrings(frames.map((frame) => frame.shape)).filter(
      ([, value]) => !value.startsWith('$'),
    )
    for (const [dotted, value] of literals) {
      expect(text, `${dotted} = ${value}`).toContain(value)
    }
  })
})

describe('keeps stdout parseable and the run inside its own paths', () => {
  it('puts the summary on stdout and the progress on stderr', () => {
    const run = runProbe(['--transcript', capturedTranscriptPath, '--out', outPath('streams.json')])
    // runProbe parses stdout as JSON, so reaching this line already proves stdout is a single
    // parseable object; the stderr side is the half that is easy to get wrong.
    expect(run.summary['script']).toBe('probe-copilot-acp')
    expect(run.stderr).toContain('[probe-copilot-acp]')
  })

  it('names the artefact it wrote', () => {
    const target = outPath('named.json')
    const run = runProbe(['--transcript', capturedTranscriptPath, '--out', target])
    expect(run.summary['artifactWritten']).toBe(true)
    expect(existsSync(target)).toBe(true)
  })

  it('leaves the tracked evidence capture untouched when it writes to scratch', () => {
    // Isolation: a probe run from this suite must not disturb the artefact a human reads.
    const before = readFileSync(trackedCapturePath, 'utf8')
    runProbe(['--transcript', capturedTranscriptPath, '--out', outPath('isolated.json')])
    expect(readFileSync(trackedCapturePath, 'utf8')).toBe(before)
  })

  it('records the three states a permission signal can be in, and never claims absent', () => {
    // A black-box probe can establish observed and not-triggered. `absent` is a claim about
    // the harness's capabilities, which this probe has no access to, so the state is not
    // even offered: a later reader cannot read a negative finding that was never captured.
    const outcome = probeTranscript('states', readCaptured())
    const states = at(outcome.artefact ?? {}, 'permissionPath.stateMeaning') as Record<string, string>
    expect(Object.keys(states).sort()).toEqual(['not-triggered', 'observed', 'unresolved'])
    expect(Object.keys(states)).not.toContain('absent')
  })
})
