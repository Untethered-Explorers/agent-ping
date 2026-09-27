// Tests the Copilot hook probe and the consolidated report (CP-2, CP-FR-02, CP-FR-03).
//
// Every assertion drives the real script as a child process, so what is verified is the shipped
// entry point rather than a re-export of its internals. Four shapes are driven:
//
//   - a sanitised replay of a real `copilot` hook run
//     (tests/scripts/fixtures/copilot-hooks-capture.json): the four-cell location-by-mode matrix
//     the live probe produced, with the CLI's key names, enum values and array shapes exactly as
//     it sent them and placeholder strings under every content-bearing key.
//   - hand-built variants of it, for the states the real run did not reach.
//   - the committed live capture (docs/research/copilot-hooks-capture.json), as evidence rather
//     than as a fixture.
//   - a stub binary that answers --version and then goes silent, for the deadline.
//
// The three acceptance criteria are covered by name in the describe blocks below: the report
// states the documented triggers, the captured payloads, and the idle/permission answer; it
// distinguishes absent from not-triggered from unclear; and it records the exact CLI version and
// the timestamps of both probe runs. A fourth block covers the property the whole report exists
// to hold: a missing capture is reported as not observed rather than dropped.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const probePath = path.join(repoRoot, 'scripts', 'probe-copilot-hooks.mjs')
const fixturePath = path.join(repoRoot, 'tests', 'scripts', 'fixtures', 'copilot-hooks-capture.json')
const trackedCapturePath = path.join(repoRoot, 'docs', 'research', 'copilot-hooks-capture.json')
const trackedAcpCapturePath = path.join(repoRoot, 'docs', 'research', 'copilot-acp-capture.json')
const trackedReportPath = path.join(repoRoot, 'docs', 'research', 'copilot-acp-probe.md')

/**
 * Scratch space, created at module scope because the helpers below resolve paths from it and the
 * describes are collected before any hook runs. Every run writes here, never into the repository,
 * and afterAll removes it.
 */
const scratch = mkdtempSync(path.join(tmpdir(), 'agent-ping-hooks-probe-test-'))

interface RunResult {
  status: number
  /** stdout, parsed. The script promises the summary is the only thing on stdout. */
  summary: Record<string, unknown>
  stderr: string
  elapsedMs: number
}

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
    // A parse failure here means the script put progress on stdout, which is one of the defects
    // these tests exist to catch, so it is allowed to throw rather than paper over.
    summary: JSON.parse(result.stdout ?? '') as Record<string, unknown>,
    stderr: result.stderr ?? '',
    elapsedMs: Date.now() - startedAt,
  }
}

const outPath = (name: string) => path.join(scratch, name)
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
const readFixture = () => readJson(fixturePath) as { runs: Record<string, unknown>[] }

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

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** The report section headings, in order. Every one is asserted present by the completeness test. */
const REQUIRED_SECTIONS = [
  '## 1. What was probed, and with what',
  '## 2. The documented hook trigger surface',
  '## 3. The captured payloads',
  '## 4. Is there an idle signal?',
  '## 5. Is there a permission signal?',
  '## 6. What can a session-end reason express?',
  '## 7. The four hook runs, side by side',
  '## 8. Where hooks load, and in which mode',
  '## 9. Absent, not triggered, and unclear',
  '## 10. What was not observed',
  '## 11. Scope',
]

/** The marker the report puts in a cell whose capture is missing. */
const NOT_OBSERVED = '_not observed: no capture for this probe was available when the report was rendered_'

/** Content the capture must never hold. Each stands in for a live prompt, tool input or result. */
const SECRETS = [
  'PROBE-PROMPT-PLACEHOLDER',
  'PROBE-TRANSFORMED-PROMPT-PLACEHOLDER',
  'TOOL-COMMAND-PLACEHOLDER',
  'TOOL-DESCRIPTION-PLACEHOLDER',
  'TOOL-RESULT-PLACEHOLDER',
]

/** The fixture's placeholder strings, so a leak assertion cannot be satisfied by an empty capture. */
const LEAKY_FIXTURE = readFixture()

const writeFixture = (name: string, value: unknown): string => {
  const file = outPath(`${name}.json`)
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
  return file
}

/** Clone the fixture with one run replaced, so a variant exercises the same code path as the real run. */
function withRun(label: string, patch: Record<string, unknown>) {
  const fixture = readFixture()
  return {
    ...fixture,
    runs: fixture.runs.map((run) => (run['label'] === label ? { ...run, ...patch } : run)),
  }
}

/** Replay the fixture, returning the run plus whatever it wrote. */
function replay(
  name: string,
  fixture: unknown = readFixture(),
  extraArgs: string[] = [],
): { run: RunResult; capture?: Record<string, unknown>; report?: string; reportPath: string } {
  const capturePath = outPath(`${name}.capture.json`)
  const reportPath = outPath(`${name}.report.md`)
  const run = runProbe([
    '--capture',
    writeFixture(name, fixture),
    '--out',
    capturePath,
    '--report',
    reportPath,
    ...extraArgs,
  ])
  return {
    run,
    capture: existsSync(capturePath) ? readJson(capturePath) : undefined,
    report: existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : undefined,
    reportPath,
  }
}

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('the report states the documented triggers, the payloads, and the idle and permission answers', () => {
  let run: RunResult
  let capture: Record<string, unknown>
  let report: string

  beforeAll(() => {
    const outcome = replay('baseline')
    run = outcome.run
    capture = outcome.capture ?? {}
    report = outcome.report ?? ''
  })

  it('exits zero with every assertion executed', () => {
    expect(run.status).toBe(0)
    expect(run.summary['verdict']).toBe('pass')
    // Non-vacuity: a report rendered from a run that exercised nothing would prove nothing.
    expect(run.summary['assertionsRun']).toBe(10)
    expect(run.summary['assertionsExpected']).toBe(10)
    expect(run.summary['failures']).toEqual([])
    // The same count travels in the capture, so a reader can tell a graded capture from an
    // ungraded one without re-running the probe against a CLI that has since moved on.
    expect(at(capture, 'decision.verdict')).toBe('pass')
    expect(at(capture, 'decision.assertionsRun')).toBe(10)
    expect(at(capture, 'decision.assertionsExpected')).toBe(10)
    expect(at(capture, 'decision.failures')).toEqual([])
  })

  it('contains every required section, in order', () => {
    const positions = REQUIRED_SECTIONS.map((heading) => report.indexOf(heading))
    for (const [index, position] of positions.entries()) {
      expect(position, `${REQUIRED_SECTIONS[index]} is missing`).toBeGreaterThanOrEqual(0)
    }
    // Order as well as presence: a reader following "see section 8" needs section 8 to be the
    // thing that section 8 says it is.
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('states every documented trigger with its observed state and invocation count', () => {
    const declared = at(capture, 'declaredTriggers') as { event: string }[]
    expect(declared).toHaveLength(14)
    for (const { event } of declared) {
      expect(report, `${event} has no row in the trigger table`).toContain(`| \`${event}\` |`)
      const state = at(capture, `runs.0.triggerStates.${event}.state`)
      expect(['observed', 'not-triggered', 'unclear']).toContain(state)
      // The state reaches the report as a word, so a reader does not have to open the capture to
      // learn whether a trigger said anything.
      expect(report).toContain(`\`${state}\``)
    }
  })

  it('records the binary\'s own account of its hook configuration surface, verbatim', () => {
    // The documented column does not rest on the vendor page alone: the binary's help is captured
    // live, and both the command and its lines appear in the report.
    const hookLines = at(capture, 'documentation.onMachine.hookLines') as string[]
    expect(at(capture, 'documentation.onMachine.hookConfigDocumented')).toBe(true)
    expect(at(capture, 'documentation.onMachine.command')).toBe('copilot help config')
    for (const line of hookLines) expect(report).toContain(line)
  })

  it('records the captured payload structure, with the permission payload shown in full', () => {
    expect(at(capture, 'runs.0.permissionPath.observedInputKeys')).toEqual([
      'hookName',
      'sessionId',
      'timestamp',
      'cwd',
      'toolName',
      'toolInput',
      'permissionSuggestions',
    ])
    expect(at(capture, 'runs.0.permissionPath.toolNames')).toEqual(['bash'])
    // The report embeds the redacted payload verbatim, so a reviewer checks the shape without
    // opening the capture.
    const shape = JSON.stringify(at(capture, 'runs.0.invocations.permissionRequest[0].shape'))
    for (const field of Object.keys(JSON.parse(shape) as object)) {
      expect(report).toContain(`"${field}"`)
    }
  })

  it('answers the idle question explicitly, and names the per-turn alternative', () => {
    expect(report).toContain('## 4. Is there an idle signal?')
    // The answer has to be one of the three states and never `absent`, and the finished-turn hook
    // must be offered as a separate signal rather than silently substituted for an idle one.
    const idle = at(capture, 'runs.0.idleSignal') as Record<string, unknown>
    expect(['observed', 'not-triggered', 'unclear']).toContain(idle['state'])
    expect(idle['state']).not.toBe('absent')
    expect(at(capture, 'runs.0.idleSignal.perTurnAlternative.event')).toBe('agentStop')
    expect(report).toContain('agent_idle')
    expect(report).toContain('background')
  })

  it('answers the permission question explicitly, on both surfaces', () => {
    expect(report).toContain('## 5. Is there a permission signal?')
    expect(at(capture, 'signals.permission.hook.state')).toBe('observed')
    expect(at(capture, 'signals.permission.hook.event')).toBe('permissionRequest')
    // The two signals are not interchangeable, and the report says which is which.
    expect(report).toContain('not interchangeable')
  })

  it('records what a session-end reason can express, documented and observed separately', () => {
    expect(report).toContain('## 6. What can a session-end reason express?')
    expect(at(capture, 'runs.0.sessionEndSignal.documentedReasons')).toEqual([
      'complete',
      'error',
      'abort',
      'timeout',
      'user_exit',
    ])
    expect(at(capture, 'runs.0.sessionEndSignal.observedReasons')).toEqual(['complete'])
    for (const reason of ['error', 'abort', 'timeout', 'user_exit']) {
      expect(report).toContain(`\`${reason}\``)
    }
  })

  it('records the location-by-mode matrix, and reports both cells of the differential', () => {
    const matrix = at(capture, 'observed.matrix') as Record<string, unknown>[]
    expect(matrix).toHaveLength(2)
    const user = matrix.find((row) => String(row['hookLocation']).startsWith('user')) ?? {}
    const repo = matrix.find((row) => String(row['hookLocation']).startsWith('repository')) ?? {}
    expect(user['pipeInvocations']).toBe(8)
    expect(user['acpInvocations']).toBe(8)
    expect(repo['pipeInvocations']).toBe(8)
    expect(repo['acpInvocations']).toBe(0)
    // The disagreement is stated as an observation, and the report says plainly that it does not
    // resolve the mechanism. Claiming a cause here is exactly the fabrication this report exists
    // to avoid.
    expect(report).toContain('the modes **disagreed**')
    expect(report).toContain('does not choose between them')
  })

  it('says on the report where the probe has no environment caveat, rather than rendering a stub', () => {
    // The fixture carries no environment caveat because that metadata comes from a live run. The
    // report must degrade to an explicit "not observed" instead of printing a sentence with its
    // subject missing, which a reader would take for a claim.
    expect(report).toContain('the capture records no environment caveat')
    expect(report).toContain('could be misread as evidence about the ACP permission signal')
  })
})

describe('the report distinguishes absent, not-triggered and unclear', () => {
  it('never records the state `absent` for any trigger, and says why it cannot', () => {
    const capture = replay('states').capture ?? {}
    const states = (at(capture, 'declaredTriggers') as { event: string }[]).map(
      ({ event }) => at(capture, `runs.0.triggerStates.${event}.state`),
    )
    expect(states).toHaveLength(14)
    expect(states.every((state) => state !== 'absent')).toBe(true)
    const report = replay('states-report').report ?? ''
    for (const state of ['observed', 'not-triggered', 'unclear', 'absent']) {
      expect(report, `${state} has no row in the state table`).toContain(`\`${state}\``)
    }
    // `absent` is offered as a row precisely so the report can say it is unreachable, rather than
    // leaving a reader to guess whether its absence from the vocabulary was deliberate.
    expect(report).toContain('NEVER recorded by this probe')
    expect(report).toContain('never what does not exist')
    expect(report).toContain('nothing, because nothing can reach this state')
  })

  it('records a trigger that fired nothing as not-triggered, naming the reason it stayed quiet', () => {
    // Only `agentStop` is removed, so the run still exercises the surface and the capture is
    // still written. Emptying every event would trip the non-vacuity guard instead, which is a
    // different failure and is asserted on its own below.
    const events = { ...(readFixture().runs[0]?.['rawByEvent'] as Record<string, string[]>) }
    delete events['agentStop']
    const outcome = replay('not-triggered', withRun('pipe-user', { rawByEvent: events }))
    expect(outcome.run.status).toBe(1)
    const capture = outcome.capture ?? {}
    expect(at(capture, 'runs.0.triggerStates.agentStop.state')).toBe('not-triggered')
    expect(at(capture, 'runs.0.triggerStates.agentStop.reason')).toContain('fired nothing')
    // The report keeps the row and says why, rather than dropping an event that said nothing.
    expect(outcome.report).toContain('| `agentStop` |')
    expect(outcome.report).toContain('never fired during the driven session')
    // And the idle question is not promoted because a per-turn hook is missing.
    expect(at(capture, 'runs.0.idleSignal.state')).toBe('unclear')
  })

  it('records a trigger whose payload could not be read as unclear, not as silent', () => {
    // A hook that ran and produced something unreadable is a fact. Reporting it as not-triggered
    // would turn a broken capture into a clean one.
    const events = { ...(readFixture().runs[0]?.['rawByEvent'] as Record<string, string[]>) }
    events['agentStop'] = ['not json at all']
    const outcome = replay('unclear', withRun('pipe-user', { rawByEvent: events }))
    expect(outcome.run.status).toBe(1)
    const capture = outcome.capture ?? {}
    expect(at(capture, 'runs.0.triggerStates.agentStop.state')).toBe('unclear')
    const unparsed = at(capture, 'runs.0.unparsedInvocations') as { event: string; reason: string }[]
    expect(unparsed).toHaveLength(1)
    expect(unparsed[0]?.event).toBe('agentStop')
    expect(unparsed[0]?.reason).toContain('invalid JSON')
  })

  it('records the idle question as unclear when the notification event never fired', () => {
    // The distinction the feature turns on: an event that fired nothing was never exercised, so
    // claiming it "said nothing" would be a discrimination this run cannot make.
    const outcome = replay('idle-unclear')
    const capture = outcome.capture ?? {}
    expect(at(capture, 'runs.0.idleSignal.state')).toBe('unclear')
    expect(at(capture, 'runs.0.idleSignal.notificationInvocationCount')).toBe(0)
    // And the report says the type was not exercised, rather than claiming the event omitted it.
    expect(outcome.report).toContain('was not exercised: the `notification` hook fired 0 time(s)')
  })

  it('records the idle question as not-triggered when the event fired without an idle type', () => {
    const events = { ...(readFixture().runs[0]?.['rawByEvent'] as Record<string, string[]>) }
    events['notification'] = [
      JSON.stringify({
        sessionId: 'ab00170b-b5d8-4f85-a041-216c39dfc33a',
        timestamp: 1790508570000,
        cwd: '/tmp/workspace',
        hook_event_name: 'Notification',
        message: 'PLACEHOLDER',
        title: 'PLACEHOLDER',
        notification_type: 'shell_completed',
      }),
    ]
    const outcome = replay('idle-not-triggered', withRun('pipe-user', { rawByEvent: events }))
    const capture = outcome.capture ?? {}
    expect(at(capture, 'runs.0.idleSignal.state')).toBe('not-triggered')
    expect(at(capture, 'runs.0.idleSignal.observedNotificationTypes')).toEqual(['shell_completed'])
    // With the event exercised, the report can honestly call the un-emitted types a real
    // observation rather than a gap in the search.
    expect(outcome.report).toContain('a real observation about that type rather than a gap in the search')
  })

  it('records the idle question as observed when the documented idle type arrives', () => {
    const events = { ...(readFixture().runs[0]?.['rawByEvent'] as Record<string, string[]>) }
    events['notification'] = [
      JSON.stringify({
        sessionId: 'ab00170b-b5d8-4f85-a041-216c39dfc33a',
        timestamp: 1790508570000,
        cwd: '/tmp/workspace',
        hook_event_name: 'Notification',
        message: 'PLACEHOLDER',
        notification_type: 'agent_idle',
      }),
    ]
    const outcome = replay('idle-observed', withRun('pipe-user', { rawByEvent: events }))
    expect(at(outcome.capture ?? {}, 'runs.0.idleSignal.state')).toBe('observed')
  })

  it('does not promote the finished-turn hook into an idle answer', () => {
    // `agentStop` firing must never make the dedicated-idle question `observed`: the two are
    // different signals, and collapsing them is the failure this state vocabulary prevents.
    const capture = replay('no-promotion').capture ?? {}
    expect(at(capture, 'runs.0.turnEndSignal.state')).toBe('observed')
    expect(at(capture, 'runs.0.idleSignal.state')).toBe('unclear')
    expect(at(capture, 'runs.0.idleSignal.perTurnAlternative.state')).toBe('observed')
  })
})

describe('a missing capture is reported as not observed, never omitted', () => {
  it('keeps every section and marks the ACP-derived cells when the ACP capture is absent', () => {
    const outcome = replay('no-acp', readFixture(), ['--acp-capture', outPath('no-such-capture.json')])
    const report = outcome.report ?? ''
    expect(outcome.run.status).toBe(0)
    expect(outcome.run.summary['acpCaptureAvailable']).toBe(false)

    // Every section survives. A report that dropped a section would be indistinguishable from a
    // report that found nothing there.
    for (const heading of REQUIRED_SECTIONS) expect(report).toContain(heading)

    // The ACP-derived cells read as not observed rather than as an empty or invented answer.
    expect(report).toContain(NOT_OBSERVED)
    const missing = report.split('\n').filter((line) => line.includes(NOT_OBSERVED))
    expect(missing.length).toBeGreaterThan(0)
    // The permission and idle tables keep their rows with the ACP cells marked, rather than
    // silently reporting only the hook half.
    expect(report).toMatch(/\| ACP \(the mode an adapter would drive\) \| a dedicated idle notification \|/)
    const permissionSection = report.slice(report.indexOf('## 5. Is there a permission signal?'))
    const acpPermissionRow = permissionSection
      .slice(0, permissionSection.indexOf('## 6.'))
      .split('\n')
      .find((line) => line.startsWith('| ACP |'))
    expect(acpPermissionRow, 'the ACP permission row is gone from the report').toBeDefined()
    // Both of its capture-derived cells are marked, so no cell reads as an empty answer.
    expect(acpPermissionRow?.match(new RegExp(NOT_OBSERVED, 'g'))?.length).toBe(2)
    // The reason is recorded, so a reader can tell a missing capture from a probe that ran and
    // found nothing.
    expect(at(outcome.capture ?? {}, 'signals.permission.acp.state')).toBe('unavailable')
    expect(String(at(outcome.capture ?? {}, 'signals.permission.acp.reason'))).toContain('absent probe')
  })

  it('says so on stdout and in the capture, not only in the report body', () => {
    const outcome = replay('no-acp-stdout', readFixture(), [
      '--acp-capture',
      outPath('still-no-such-capture.json'),
    ])
    expect(outcome.run.summary['acpCaptureAvailable']).toBe(false)
    expect(at(outcome.capture ?? {}, 'signals.finished.acp.state')).toBe('unavailable')
    expect(at(outcome.capture ?? {}, 'signals.idle.acp.state')).toBe('unavailable')
  })

  it('refuses to render a report at all when the hook capture itself is missing', () => {
    // The mirror image: a report rendered from nothing would be a report about nothing, so the
    // probe exits non-zero and writes no report rather than writing a page of not-observed.
    const reportPath = outPath('must-not-be-written.md')
    const run = runProbe([
      '--render-only',
      '--out',
      outPath('no-such-hook-capture.json'),
      '--report',
      reportPath,
    ])
    expect(run.status).not.toBe(0)
    expect(run.status).toBe(4)
    expect(run.summary['verdict']).toBe('fail')
    expect(run.summary['reportWritten']).toBe(false)
    expect(String(run.summary['failure'])).toContain('could not be read')
    expect(existsSync(reportPath)).toBe(false)
  })

  it('re-renders from a committed capture without launching a binary or rewriting it', () => {
    const before = readFileSync(trackedCapturePath, 'utf8')
    const reportPath = outPath('render-only.md')
    const run = runProbe(['--render-only', '--report', reportPath])
    expect(run.status).toBe(0)
    expect(run.summary['captureWritten']).toBe(false)
    expect(run.summary['reportWritten']).toBe(true)
    expect(existsSync(reportPath)).toBe(true)
    // Isolation: a re-render must not touch the artefact a human reads.
    expect(readFileSync(trackedCapturePath, 'utf8')).toBe(before)
    expect(String(run.summary['note'])).toContain('no binary was launched')
  })
})

describe('fails loudly instead of writing a capture that says nothing', () => {
  it('exits non-zero and writes nothing when the binary is missing', () => {
    const capturePath = outPath('must-not-be-written.json')
    const reportPath = outPath('must-not-be-written.md')
    const run = runProbe([
      '--binary',
      outPath('no-such-copilot'),
      '--out',
      capturePath,
      '--report',
      reportPath,
    ])

    expect(run.status).not.toBe(0)
    expect(run.status).toBe(3)
    expect(run.summary['verdict']).toBe('fail')
    expect(run.summary['captureWritten']).toBe(false)
    expect(run.summary['reportWritten']).toBe(false)
    expect(run.summary['capture']).toBeNull()
    // A non-zero exit with no next action trains people to ignore the exit code.
    expect(String(run.summary['remedy'])).toContain('copilot --version')
    expect(String(run.summary['failure'])).toContain('an absent probe, not a negative finding')
    expect(existsSync(capturePath)).toBe(false)
    expect(existsSync(reportPath)).toBe(false)
  })

  it('exits non-zero and writes nothing when the run produced no hook invocation at all', () => {
    // The non-vacuity guard. A capture whose subject is nothing cannot be told apart from a
    // capture that found nothing, so it is withheld rather than written.
    const outcome = replay('no-invocations', withRun('pipe-user', { rawByEvent: emptyEvents() }))
    expect(outcome.run.status).toBe(4)
    expect(outcome.run.summary['captureWritten']).toBe(false)
    expect(String(outcome.run.summary['failure'])).toContain('no hook invocation at all')
    expect(outcome.capture).toBeUndefined()
    expect(outcome.report).toBeUndefined()
  })

  it('exits non-zero on a usage error and writes nothing', () => {
    const capturePath = outPath('usage.json')
    const result = spawnSync(process.execPath, [probePath, '--not-a-flag', '--out', capturePath], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('unknown argument --not-a-flag')
    expect(existsSync(capturePath)).toBe(false)
  })

  it('honours the deadline against a binary that never answers, and writes nothing', () => {
    // The stub answers --version and then goes silent, so the only thing that can end the wait is
    // the deadline. A poll tick that ends it early is a timeout that looks implemented and is not.
    const stub = outPath('silent-copilot')
    writeFileSync(
      stub,
      [
        '#!/usr/bin/env node',
        "if (process.argv.includes('--version')) {",
        "  process.stdout.write('GitHub Copilot CLI 9.9.9\\n')",
        '  process.exit(0)',
        '}',
        "if (process.argv.includes('help')) {",
        "  process.stdout.write('`hooks`: inline hook definitions, keyed by event name\\n')",
        '  process.exit(0)',
        '}',
        'process.stdin.resume()',
        'setInterval(() => {}, 1000)',
        '',
      ].join('\n'),
    )
    chmodSync(stub, 0o755)
    const capturePath = outPath('silent.json')
    const startedAt = Date.now()
    const run = runProbe([
      '--binary',
      stub,
      '--run-timeout-ms',
      '3000',
      '--out',
      capturePath,
      '--report',
      outPath('silent.md'),
    ])
    const elapsedMs = Date.now() - startedAt

    expect(run.status).not.toBe(0)
    expect(run.status).toBe(5)
    expect(String(run.summary['failure'])).toContain('timed out after 3000ms')
    expect(elapsedMs).toBeGreaterThanOrEqual(3000)
    expect(existsSync(capturePath)).toBe(false)
  })

  it('refuses to write a capture when the binary will not document its own hook surface', () => {
    // The documented column would then rest on the vendor page alone, which is a weaker artefact
    // than one with two independent witnesses, so the probe says so rather than quietly proceeding.
    const stub = outPath('unhelpful-copilot')
    writeFileSync(
      stub,
      [
        '#!/usr/bin/env node',
        "if (process.argv.includes('--version')) {",
        "  process.stdout.write('GitHub Copilot CLI 9.9.9\\n')",
        '  process.exit(0)',
        '}',
        "if (process.argv.includes('help')) { process.stdout.write('nothing about hooks\\n'); process.exit(3) }",
        'process.stdin.resume()',
        'setInterval(() => {}, 1000)',
        '',
      ].join('\n'),
    )
    chmodSync(stub, 0o755)
    const capturePath = outPath('unhelpful.json')
    const run = runProbe(['--binary', stub, '--run-timeout-ms', '3000', '--out', capturePath])
    expect(run.status).toBe(4)
    expect(String(run.summary['failure'])).toContain('would not document its own hook surface')
    expect(existsSync(capturePath)).toBe(false)
  })

  it('reports a payload that is not a JSON object as a contract change rather than skipping it', () => {
    const events = { ...(readFixture().runs[0]?.['rawByEvent'] as Record<string, string[]>) }
    events['sessionEnd'] = ['["an array is not a payload object"]']
    const outcome = replay('not-an-object', withRun('pipe-user', { rawByEvent: events }))
    expect(outcome.run.status).toBe(1)
    expect(at(outcome.capture ?? {}, 'runs.0.unparsedInvocations[0].reason')).toBe(
      'payload was not a JSON object',
    )
  })
})

describe('never records conversation content in the capture', () => {
  let run: RunResult
  let capture: Record<string, unknown>
  let captureText: string

  beforeAll(() => {
    const outcome = replay('leak-check')
    run = outcome.run
    capture = outcome.capture ?? {}
    captureText = readFileSync(outPath('leak-check.capture.json'), 'utf8')
  })

  it('keeps the prompt, tool input, tool description and tool result out of the capture', () => {
    expect(run.status).toBe(0)
    expect(captureText.length).toBeGreaterThan(500)
    for (const secret of SECRETS) {
      expect(captureText, `${secret} reached the capture`).not.toContain(secret)
    }
  })

  it('replaces those strings with a length marker rather than dropping the field', () => {
    // Redaction must not become truncation: the field still appears, so a reader can see the
    // field exists even though its text is withheld.
    const shapes = JSON.stringify(at(capture, 'runs.0.invocations'))
    expect(shapes).toContain('$string')
    for (const field of ['initialPrompt', 'transformedPrompt', 'prompt', 'toolArgs', 'toolInput', 'textResultForLlm', 'transcriptPath']) {
      expect(shapes, `${field} was dropped rather than redacted`).toContain(field)
    }
  })

  it('keeps the structural values that are the evidence', () => {
    expect(at(capture, 'runs.0.turnEndSignal.stopReasons')).toEqual(['end_turn'])
    expect(at(capture, 'runs.0.sessionEndSignal.observedReasons')).toEqual(['complete'])
    expect(at(capture, 'runs.0.permissionPath.toolNames')).toEqual(['bash'])
    expect(at(capture, 'runs.0.invocations.postToolUse[0].shape.toolResult.resultType')).toBe('success')
  })

  it('records the redaction policy in the capture, so it is re-checkable', () => {
    const literalKeys = at(capture, 'redaction.literalKeys') as string[]
    const contentKeys = at(capture, 'redaction.contentBearingKeys') as string[]
    expect(literalKeys).toContain('toolName')
    expect(literalKeys).toContain('stopReason')
    expect(literalKeys).toContain('reason')
    expect(literalKeys).toContain('notification_type')
    // No content-bearing key is on the literal list, which is the assertion that matters: the
    // allowlist is a protocol vocabulary, not a convenient hole.
    for (const key of contentKeys) expect(literalKeys).not.toContain(key)
    expect(String(at(capture, 'redaction.policy'))).toContain('APX-FR-01')
  })

  it('reads the payloads out of the stream rather than out of a constant', () => {
    // Every literal the capture keeps must appear verbatim in the fixture's captured stream.
    // Without this, a probe that hard-coded the answer would satisfy the tests above.
    const stream = JSON.stringify(LEAKY_FIXTURE).replace(/\\\//g, '/')
    const invocations = Object.values(at(capture, 'runs.0.invocations') as Record<string, { shape: unknown }[]>).flat()
    const literals = collectStrings(
      invocations.map((invocation) => invocation.shape),
    ).filter(([, value]) => !value.startsWith('$'))
    expect(literals.length).toBeGreaterThan(10)
    for (const [dotted, value] of literals) {
      expect(stream, `${dotted} = ${value} is not in the captured stream`).toContain(value)
    }
  })
})

describe('the committed live capture is evidence, not a placeholder', () => {
  const capture = existsSync(trackedCapturePath) ? readJson(trackedCapturePath) : {}

  it('records a real run against a real binary version', () => {
    expect(at(capture, 'timestamps')).toBeUndefined()
    expect(at(capture, 'cli.version')).toMatch(/^\d+\.\d+\.\d+/)
    expect(String(at(capture, 'cli.versionOutput'))).toContain(String(at(capture, 'cli.version')))
    expect(at(capture, 'cli.versionCommand')).toBe('copilot --version')
    expect(at(capture, 'documentation.onMachine.hookConfigDocumented')).toBe(true)
  })

  it('records the timestamps of all four runs', () => {
    const runs = at(capture, 'runs') as Record<string, unknown>[]
    expect(runs).toHaveLength(4)
    for (const run of runs) {
      expect(run['startedAt']).toMatch(ISO_8601)
      expect(run['finishedAt']).toMatch(ISO_8601)
      expect(run['runCompleted']).toBe(true)
    }
  })

  it('records the two findings the gate decision rests on', () => {
    // A permission signal and a finished-turn signal, both observed with their payload.
    expect(at(capture, 'signals.permission.hook.state')).toBe('observed')
    expect(at(capture, 'signals.finished.hook.state')).toBe('observed')
    expect(at(capture, 'signals.finished.hook.stopReasons')).toEqual(['end_turn'])
    // And the negative finding, stated as a search over the names the CLI really used.
    expect(at(capture, 'signals.idle.acp.dedicatedIdleNotificationObserved')).toBe(false)
    expect(at(capture, 'signals.idle.acp.idleMarkersMatched')).toEqual([])
  })

  it('records the environment caveat that changes what its own ACP rows mean', () => {
    // The live run auto-approved tools, so its ACP rows cannot say anything about the ACP
    // permission signal. A capture that hid this would invite a gate to read an empty
    // agent-request list as evidence.
    const caveat = at(capture, 'documentation.environmentCaveat') as Record<string, unknown>
    expect(caveat['trustOptIn']).toBe('COPILOT_ALLOW_ALL=true')
    expect(caveat['toolsAutoApproved']).toBe(true)
    expect(String(caveat['effectOnPermissionEvidence'])).toContain('says nothing about the ACP permission signal')
  })

  it('records the location-by-mode differential as a measured matrix', () => {
    const matrix = at(capture, 'observed.matrix') as Record<string, unknown>[]
    expect(matrix).toHaveLength(2)
    for (const row of matrix) expect((row['runs'] as string[]).length).toBe(2)
    const user = matrix.find((row) => String(row['hookLocation']).startsWith('user')) ?? {}
    const repo = matrix.find((row) => String(row['hookLocation']).startsWith('repository')) ?? {}
    expect(user['acpInvocations']).toBeGreaterThan(0)
    expect(repo['pipeInvocations']).toBeGreaterThan(0)
  })

  it('holds no conversation content and no path from the operator machine', () => {
    const text = readFileSync(trackedCapturePath, 'utf8')
    expect(text).not.toMatch(/\/home\//)
    expect(text).not.toMatch(/\/Users\//)
    // The probe's own temporary root is replaced by a placeholder, so the artefact carries neither
    // a machine path nor a session store location.
    expect(text).not.toMatch(/agent-ping-copilot-hooks-[A-Za-z0-9]/)
    expect(text).toContain('<workspace>')
    // Every string under a non-literal key is a length marker, so no field can hold a prompt.
    const invocations = Object.values(at(capture, 'runs.0.invocations') as Record<string, { shape: unknown }[]>).flat()
    const literals = collectStrings(invocations.map((invocation) => invocation.shape)).filter(
      ([, value]) => !value.startsWith('$'),
    )
    for (const [dotted, value] of literals) {
      expect(text, `${dotted} = ${value}`).toContain(value)
    }
  })
})

describe('the committed report records the exact version and both probe timestamps', () => {
  const report = existsSync(trackedReportPath) ? readFileSync(trackedReportPath, 'utf8') : ''
  const acpCapture = existsSync(trackedAcpCapturePath) ? readJson(trackedAcpCapturePath) : {}
  const hooksCapture = existsSync(trackedCapturePath) ? readJson(trackedCapturePath) : {}

  it('contains every required section', () => {
    for (const heading of REQUIRED_SECTIONS) expect(report, `${heading} is missing`).toContain(heading)
  })

  it('names the exact CLI version, and the version the ACP capture recorded', () => {
    expect(report).toContain(String(at(hooksCapture, 'cli.version')))
    expect(report).toContain(String(at(acpCapture, 'cli.version')))
    // The version appears in the header table for both probes, not only in prose.
    expect(report).toContain('Exact version')
  })

  it('records the ACP probe run timestamps and the hook probe run timestamps', () => {
    expect(report).toContain(String(at(acpCapture, 'timestamps.startedAt')))
    expect(report).toContain(String(at(acpCapture, 'timestamps.finishedAt')))
    const runs = at(hooksCapture, 'runs') as Record<string, unknown>[]
    for (const run of runs) {
      expect(report, `the ${String(run['label'])} timestamp is missing`).toContain(String(run['startedAt']))
      expect(report).toContain(String(run['finishedAt']))
    }
  })

  it('states plainly that it contains no decision', () => {
    // CP-2's scope: evidence, not a verdict. A report that read as a decision would be CP-3's
    // work done by a probe.
    expect(report).toContain('It contains **no decision** and **no adapter code**')
    expect(report).not.toContain('docs/reviews/copilot-gate.json')
  })

  it('has no doubled bullet markers, which is the signature of a mangled list', () => {
    expect(report).not.toMatch(/^- - /m)
  })
})

describe('keeps stdout parseable and the run inside its own paths', () => {
  it('puts the summary on stdout and the progress on stderr', () => {
    const run = runProbe([
      '--capture',
      fixturePath,
      '--out',
      outPath('streams.json'),
      '--report',
      outPath('streams.md'),
    ])
    // runProbe parses stdout as JSON, so reaching this line already proves stdout is a single
    // parseable object; the stderr side is the half that is easy to get wrong.
    expect(run.summary['script']).toBe('probe-copilot-hooks')
    expect(run.stderr).toContain('[probe-copilot-hooks]')
  })

  it('prints usage without launching anything', () => {
    const result = spawnSync(process.execPath, [probePath, '--help'], { cwd: repoRoot, encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--run-timeout-ms')
    expect(result.stdout.replace(/\s+/g, ' ')).toContain('absence of evidence is never a negative finding')
    expect(result.stderr).toBe('')
  })

  it('leaves the tracked evidence untouched when it writes to scratch', () => {
    // Isolation: a probe run from this suite must not disturb the artefacts a human reads.
    const beforeCapture = readFileSync(trackedCapturePath, 'utf8')
    const beforeReport = readFileSync(trackedReportPath, 'utf8')
    replay('isolated')
    expect(readFileSync(trackedCapturePath, 'utf8')).toBe(beforeCapture)
    expect(readFileSync(trackedReportPath, 'utf8')).toBe(beforeReport)
  })
})

/** A run in which no event fired, built from the fixture's own event list. */
function emptyEvents(): Record<string, string[]> {
  const declared = [
    'sessionStart',
    'userPromptSubmitted',
    'userPromptTransformed',
    'preToolUse',
    'permissionRequest',
    'postToolUse',
    'postToolUseFailure',
    'agentStop',
    'notification',
    'errorOccurred',
    'preCompact',
    'sessionEnd',
    'subagentStart',
    'subagentStop',
  ]
  return Object.fromEntries(declared.map((event) => [event, []]))
}
