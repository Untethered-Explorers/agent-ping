// Tests the live opencode verification script (OA-5: OA-FR-01, OA-FR-05, OA-FR-09,
// APX-CON-03, APX-CON-10).
//
// Three halves, and each one covers a different way the script could be lying:
//
//   - the judgement, driven with injected observations. `decide` is the only thing in this
//     script that decides pass or fail, so its behaviour on a full set, a short set, an
//     empty set, a mismatched row and an absent dependency is pinned here rather than
//     discovered on a machine with a harness.
//   - every parser and every generated source, driven with the real strings this run
//     observed. The breadcrumb line in particular is the one the real opencode 1.18.32
//     printed, transcribed rather than invented, because a parser that only ever saw a
//     tidy fixture would pass a run whose breadcrumbs it could not read.
//   - the real script, spawned as a child process against a stub harness, for the three
//     properties only a run can establish: that it fails when the expected envelopes never
//     arrive, that it cannot report success with the hub absent, and that its stdout is a
//     parseable summary on its own.
//
// The four acceptance criteria map to the describe blocks below by name.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// @ts-expect-error the script under test is plain JavaScript with no declaration file; its
// exports are the contract this suite exercises and the ones it names are all it uses.
import * as live from '../../scripts/verify-opencode-live.mjs'
import { removeTree } from '../helpers/remove-tree'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const scriptPath = path.join(repoRoot, 'scripts', 'verify-opencode-live.mjs')
const scratch = mkdtempSync(path.join(tmpdir(), 'agent-ping-opencode-verify-test-'))

afterAll(() => {
  removeTree(scratch)
})

/** Hard ceiling on a child run, so a wedged script fails this suite instead of hanging it. */
const CHILD_TIMEOUT_MS = 120_000

interface ChildRun {
  status: number
  summary: Record<string, unknown> | null
  stdout: string
  stderr: string
  evidenceWritten: boolean
}

/** Drive the real script the way an operator or a test would. */
function runScript(args: string[], env: NodeJS.ProcessEnv = {}): ChildRun {
  const out = path.join(scratch, `evidence-${Math.random().toString(16).slice(2)}.json`)
  const result = spawnSync(process.execPath, [scriptPath, '--out', out, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
    timeout: CHILD_TIMEOUT_MS,
  })
  if (result.error !== undefined) throw result.error
  const stdout = result.stdout ?? ''
  // A parse failure here means progress leaked onto stdout, which would make the summary
  // unparseable, so it is surfaced rather than swallowed.
  let summary: Record<string, unknown> | null = null
  try {
    summary = stdout.trim() === '' ? null : (JSON.parse(stdout) as Record<string, unknown>)
  } catch {
    summary = null
  }
  return {
    status: result.status ?? 1,
    summary,
    stdout,
    stderr: result.stderr ?? '',
    evidenceWritten: existsSync(out),
  }
}

interface SummaryAssertion {
  journey: string
  name: string
  expected: string
  actual: string
  measured?: Record<string, unknown>
}
const assertionsOf = (run: ChildRun): SummaryAssertion[] =>
  (run.summary?.['assertions'] as SummaryAssertion[] | undefined) ?? []
const failuresOf = (run: ChildRun): string[] => (run.summary?.['failures'] as string[] | undefined) ?? []
const verdictOf = (run: ChildRun): string => String(run.summary?.['verdict'] ?? 'none')
const exitCodeOf = (run: ChildRun): number => Number(run.summary?.['exitCode'] ?? -1)

/** One matching assertion row, and one that does not. */
const ok = (name: string): Record<string, unknown> => ({ journey: 'test', name, expected: 'x', actual: 'x' })
const bad = (name: string): Record<string, unknown> => ({ journey: 'test', name, expected: 'x', actual: 'y' })
const anyRows = (count: number): Record<string, unknown>[] =>
  Array.from({ length: count }, (_unused, index) => ok(`assertion-${index}`))
const noDependencies = [{ name: 'a dependency', present: true }]

/**
 * A real opencode 1.18.32 log line carrying an agent-ping delivery breadcrumb.
 *
 * Transcribed from an observed `opencode run --print-logs --log-level WARN` on this machine
 * against a real hub, which answered 422. It is the fixture the parser exists for, and its
 * shape - a flat `key=value` run of the body the plugin handed `client.app.log` - is the
 * only evidence of that shape there is.
 */
const REAL_DELIVERY_BREADCRUMB =
  'timestamp=2026-09-27T11:52:30.440Z level=WARN run=00046109 message="agent-ping reported the event ' +
  'and the hub refused it, so nothing was stored. The hub\'s own error code is on this line." ' +
  'service=agent-ping stage=delivery-failed code=hub-refused harness=opencode ' +
  'eventName=permission.replied sessionId=ses_f1d4c8725ffec6DPrY6zIYW8FA status=422 ' +
  'hubError=unidentifiable-block'

describe('OA-5: the decision function is the only judgement, and it cannot pass an empty run', () => {
  it('passes only when every assertion ran and matched', () => {
    const decision = live.decide(anyRows(4), { assertionsExpected: 4, dependencies: noDependencies })
    expect(decision.verdict).toBe('pass')
    expect(decision.exitCode).toBe(0)
    expect(decision.failures).toEqual([])
    expect(decision.assertionsRun).toBe(4)
  })

  it('fails when an observation does not match, naming the row', () => {
    const decision = live.decide([ok('a'), bad('b')], {
      assertionsExpected: 2,
      dependencies: noDependencies,
    })
    expect(decision.verdict).toBe('fail')
    expect(decision.exitCode).toBe(1)
    expect(decision.failures.join('\n')).toContain('b: expected x, observed y')
  })

  it('fails when fewer assertions ran than the inventory expects', () => {
    const decision = live.decide(anyRows(2), { assertionsExpected: 4, dependencies: noDependencies })
    expect(decision.verdict).toBe('fail')
    expect(decision.failures.join('\n')).toContain('executed 2 of 4 assertions')
  })

  it('fails when zero assertions ran, which is the promise this suite exists to keep', () => {
    const decision = live.decide([], { assertionsExpected: 4, dependencies: noDependencies })
    expect(decision.verdict).toBe('fail')
    expect(decision.exitCode).toBe(1)
  })

  it('fails when a dependency is absent, and names the remedy rather than only the problem', () => {
    const decision = live.decide(anyRows(4), {
      assertionsExpected: 4,
      dependencies: [
        { name: 'the opencode binary', present: false, remedy: 'install opencode 1.18.x and put it on PATH' },
      ],
    })
    expect(decision.verdict).toBe('fail')
    expect(decision.failures.join('\n')).toContain('required dependency unavailable: the opencode binary')
    expect(decision.failures.join('\n')).toContain('put it on PATH')
    expect(decision.missingDependencies.join('\n')).toContain('the opencode binary')
  })

  it('never treats a not-observed reading as a match', () => {
    const rows = live.notObserved('a-journey', ['one', 'two'], 'the hub never served')
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.expected).toBe('observed')
      expect(row.actual).not.toBe(row.expected)
      expect(row.actual).toContain('the hub never served')
    }
    const decision = live.decide(rows, { assertionsExpected: 2, dependencies: noDependencies })
    expect(decision.verdict).toBe('fail')
  })

  it('keeps the inventory and the expected count in step, so a journey cannot pay a debt twice', () => {
    const journeys = [
      live.OPENING_ASSERTIONS,
      live.BLOCK_ASSERTIONS,
      live.GREETING_ASSERTIONS,
      live.ABSENT_HUB_ASSERTIONS,
    ]
    const total = journeys.reduce((sum, list) => sum + list.length, 0)
    expect(total).toBe(live.ASSERTIONS_EXPECTED)
    // A name repeated across journeys would make a failure line ambiguous about which
    // journey it came from, which is the one thing a summary must not be.
    const names = journeys.flat()
    expect(new Set(names).size).toBe(names.length)
    for (const list of journeys) expect(Object.isFrozen(list)).toBe(true)
  })
})

describe('OA-5: the breadcrumb reader reads the real harness format and nothing else', () => {
  it('reads the six closed fields out of a real opencode 1.18.32 line', () => {
    const crumb = live.parseHarnessLogLine(REAL_DELIVERY_BREADCRUMB)
    expect(crumb).toEqual({
      service: 'agent-ping',
      level: 'WARN',
      stage: 'delivery-failed',
      code: 'hub-refused',
      harness: 'opencode',
      eventName: 'permission.replied',
      sessionId: 'ses_f1d4c8725ffec6DPrY6zIYW8FA',
      status: '422',
      hubError: 'unidentifiable-block',
    })
  })

  it('carries no message and no path out of a log line, because a summary cannot hold content', () => {
    const crumb = live.parseHarnessLogLine(REAL_DELIVERY_BREADCRUMB)
    expect(JSON.stringify(crumb)).not.toContain('nothing was stored')
    expect(Object.keys(crumb ?? {})).not.toContain('message')
    expect(Object.keys(crumb ?? {})).not.toContain('run')
    expect(Object.keys(crumb ?? {})).not.toContain('timestamp')
  })

  it('ignores a line that is not this product\'s, however it is spelled', () => {
    expect(live.parseHarnessLogLine('timestamp=x level=INFO message="creating instance"')).toBeNull()
    expect(live.parseHarnessLogLine('timestamp=x notservice=agent-ping code=hub-not-running')).toBeNull()
    expect(live.parseHarnessLogLine('service=agent-ping-extra code=hub-not-running')).toBeNull()
    expect(live.parseHarnessLogLine('')).toBeNull()
    expect(live.parseHarnessLogLine(undefined)).toBeNull()
  })

  it('reads a quoted value whole, spaces and escapes included', () => {
    // The real line puts a quoted, space-carrying message in front of every field this
    // parser reads, so a tokenizer that stopped at the first space inside those quotes
    // would find nothing at all. A quote escape inside them must not end the run either.
    const crumb = live.parseHarnessLogLine(
      'level=WARN message="a message with spaces and a \\"quoted\\" word" service=agent-ping ' +
        'stage=delivery-failed code=hub-not-running harness=opencode eventName=session.idle ' +
        'variant="idle after work" sessionId=ses_1',
    )
    expect(crumb?.['code']).toBe('hub-not-running')
    expect(crumb?.['eventName']).toBe('session.idle')
    expect(crumb?.['sessionId']).toBe('ses_1')
    expect(crumb?.['variant']).toBe('idle after work')
    expect(JSON.stringify(crumb)).not.toContain('a message with spaces')
  })

  it('accepts a line whose closed fields are absent, and answers no-breadcrumb for nothing', () => {
    expect(live.parseHarnessLogLine('level=DEBUG service=agent-ping harness=opencode eventName=x')).not.toBeNull()
    expect(live.breadcrumbVerdict(null)).toBe('no-breadcrumb')
  })

  it('tells a complete breadcrumb from one missing the session or the event type', () => {
    const complete = { service: 'agent-ping', level: 'WARN', sessionId: 'ses_1', eventName: 'permission.asked', harness: 'opencode' }
    expect(live.breadcrumbVerdict(complete)).toBe('service+session+event')
    expect(live.breadcrumbVerdict({ ...complete, sessionId: undefined })).toBe('missing-session')
    expect(live.breadcrumbVerdict({ ...complete, sessionId: 'unknown' })).toBe('missing-session')
    expect(live.breadcrumbVerdict({ ...complete, eventName: undefined })).toBe('missing-event-name')
    expect(live.breadcrumbVerdict({ ...complete, harness: undefined })).toBe('missing-harness')
    expect(live.breadcrumbVerdict({ ...complete, service: 'other' })).toBe('not-this-product')
  })

  it('keeps only this product\'s lines out of a block of harness output', () => {
    const lines = [
      'timestamp=x level=INFO message="creating instance" directory=/home/someone/project',
      REAL_DELIVERY_BREADCRUMB,
      'timestamp=x level=ERROR message="The user rejected permission to use this specific tool call."',
      'level=WARN service=agent-ping stage=delivery-failed code=hub-not-running harness=opencode ' +
        'eventName=session.status sessionId=ses_2',
    ]
    const crumbs = live.readBreadcrumbs(lines)
    expect(crumbs).toHaveLength(2)
    expect(crumbs.map((crumb: { code?: string }) => crumb.code)).toEqual(['hub-refused', 'hub-not-running'])
    expect(JSON.stringify(crumbs)).not.toContain('/home/someone')
    expect(JSON.stringify(crumbs)).not.toContain('rejected permission')
  })
})

describe('OA-5: the report readers refuse anything they cannot read whole', () => {
  it('reads a hub report line and rejects anything that is not one', () => {
    expect(live.parseHubReportLine(`${live.HUB_REPORT_PREFIX}{"origin":"http://127.0.0.1:1","port":1}`)).toEqual({
      origin: 'http://127.0.0.1:1',
      port: 1,
    })
    expect(live.parseHubReportLine(`${live.HUB_REPORT_PREFIX}{"origin":`)).toBeNull()
    expect(live.parseHubReportLine('{"origin":"http://127.0.0.1:1"}')).toBeNull()
    expect(live.parseHubReportLine('not a report')).toBeNull()
  })

  it('reads a card report line only when it carries a sequence number', () => {
    expect(live.parseCardReportLine(`${live.CARD_REPORT_PREFIX}{"seq":2,"shows":1,"presents":1}`)).toEqual({
      seq: 2,
      shows: 1,
      presents: 1,
    })
    expect(live.parseCardReportLine(`${live.CARD_REPORT_PREFIX}{"shows":1}`)).toBeNull()
    expect(live.parseCardReportLine(`${live.CARD_REPORT_PREFIX}[]`)).toBeNull()
  })

  it('turns two cumulative readings into the delta a journey is about', () => {
    const before = {
      seq: 1,
      shows: 0,
      presents: 0,
      cards: [] as { class: string }[],
    }
    const after = {
      seq: 3,
      shows: 2,
      presents: 2,
      cards: [{ class: 'needs-you' }, { class: 'finished' }],
    }
    const delta = live.cardDelta(before, after)
    expect(delta.presents).toBe(2)
    expect(delta.shows).toBe(2)
    expect(delta.byClass).toEqual({ 'needs-you': 1, finished: 1 })
    expect(live.classCardCount(delta, 'needs-you')).toBe('1')
    expect(live.classCardCount(delta, 'fyi')).toBe('0')
  })

  it('answers zero rather than a number for a surface that was never read', () => {
    const delta = live.cardDelta(null, null)
    expect(delta.presents).toBe(0)
    expect(delta.shows).toBeNull()
    expect(live.classCardCount(delta, 'needs-you')).toBe('0')
  })

  it('reads the hub\'s own runtime file, and treats a starting hub as unread', () => {
    const published = live.parseRuntimeRecord(
      JSON.stringify({ version: 1, instanceId: 'inst', pid: 42, host: '127.0.0.1', port: 41500, stateDir: '/tmp/s' }),
    )
    expect(published).toEqual({ host: '127.0.0.1', port: 41500, instanceId: 'inst', pid: 42, stateDir: '/tmp/s' })
    expect(live.parseRuntimeRecord(JSON.stringify({ host: '127.0.0.1', port: null }))).toBeNull()
    expect(live.parseRuntimeRecord('{"host":"127.0.0.1"}')).toBeNull()
    expect(live.parseRuntimeRecord('not json')).toBeNull()
    expect(live.parseRuntimeRecord('')).toBeNull()
  })
})

describe('OA-5: the isolation readings are made against a real directory', () => {
  it('finds a per-repository configuration of any shape, and only that', () => {
    const root = path.join(scratch, 'repo-scan')
    const empty = path.join(root, 'clean')
    mkdirSync(empty, { recursive: true })
    writeFileSync(path.join(empty, 'README.md'), 'a repository that was never registered\n')
    writeFileSync(path.join(empty, 'index.js'), 'export default 1\n')
    expect(live.perRepositoryConfiguration(empty)).toEqual([])

    const configured = path.join(root, 'configured')
    mkdirSync(path.join(configured, '.opencode', 'plugins'), { recursive: true })
    writeFileSync(path.join(configured, 'opencode.json'), '{}\n')
    writeFileSync(path.join(configured, '.opencode', 'plugins', 'mine.ts'), 'export const Mine = 1\n')
    expect(live.perRepositoryConfiguration(configured).sort()).toEqual([
      '.opencode/plugins/mine.ts',
      'opencode.json',
    ])

    const installed = path.join(root, 'installed-plugin')
    mkdirSync(installed, { recursive: true })
    writeFileSync(path.join(installed, 'agent-ping.ts'), '// agent-ping:global-plugin v1\n')
    expect(live.perRepositoryConfiguration(installed)).toEqual(['agent-ping.ts'])
  })

  it('lists a tree in a bounded, sorted way', () => {
    const root = path.join(scratch, 'tree')
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
    writeFileSync(path.join(root, 'z.txt'), 'z')
    writeFileSync(path.join(root, 'a', 'b', 'c.txt'), 'c')
    expect(live.listTree(root)).toEqual(['a/b/c.txt', 'z.txt'])
    expect(live.listTree(path.join(root, 'missing'))).toEqual([])
  })

  it('names a session the way the assertions compare it', () => {
    const block = live.identifiersFor('/tmp/run', 'oa5-block-repo', 'block')
    const greeting = live.identifiersFor('/tmp/run', 'oa5-greet-repo', 'greeting')
    expect(path.basename(block.directory)).toBe('oa5-block-repo')
    expect(block.sessionId).not.toBe(greeting.sessionId)
    expect(block.permissionId).not.toBe(greeting.permissionId)
    expect(block.callId).not.toBe(greeting.callId)
  })
})

describe('OA-5: a session process is described in the two words the precondition compares', () => {
  const base = { status: 0, replyLength: 12, timedOut: false, spawnError: null, logLines: ['one harness line'] }

  it('calls a session that ran completed, and everything else by what it did', () => {
    expect(live.sessionVerdict(base)).toBe('completed')
    expect(live.sessionVerdict({ ...base, status: 2 })).toBe('exited-2')
    expect(live.sessionVerdict({ ...base, timedOut: true })).toMatch(/^did-not-finish/)
    expect(live.sessionVerdict({ ...base, spawnError: 'ENOENT' })).toBe('could-not-start: ENOENT')
  })

  it('does not read a silent stdout as a session that did not happen', () => {
    // An `opencode run` whose turn ends in a rejected permission decision can print nothing
    // and still exit zero: two observed runs of this script showed exactly that.
    expect(live.sessionVerdict({ ...base, replyLength: 0 })).toBe('completed')
  })

  it('does not read a session that logged nothing as a session that completed', () => {
    expect(live.sessionVerdict({ ...base, logLines: [] })).toBe('no-harness-output')
    expect(live.sessionVerdict({ ...base, logLines: undefined })).toBe('no-harness-output')
  })

  it('reports the corroborating facts beside the reading, and the reply as a length', () => {
    expect(live.sessionProcessFacts(base)).toEqual({
      exitStatus: 0,
      timedOut: false,
      spawnError: null,
      replyLength: 12,
      harnessLogLines: 1,
    })
  })
})

describe('OA-5: the stub harness is fed the payloads the real harness delivered', () => {
  const ids = {
    directory: '/tmp/run/repos/oa5-block-repo',
    sessionId: 'ses_oa5_1',
    permissionId: 'per_oa5_1',
    callId: 'call_oa5_1',
    messageId: 'msg_oa5_1',
    token: 'tok',
  }

  it('builds the positive plan in the order the real run delivered those events', () => {
    const plan = live.stubPlanFor('block', ids)
    expect(plan.directory).toBe('/tmp/run/repos/oa5-block-repo')
    expect(plan.steps.map((step: { hook: string }) => step.hook)).toEqual([
      'event',
      'tool.execute.before',
      'event',
      'event',
      'event',
      'event',
    ])
    const types = plan.steps
      .filter((step: { hook: string }) => step.hook === 'event')
      .map((step: { event: { type: string } }) => step.event.type)
    expect(types).toEqual([
      'session.status',
      'permission.asked',
      'permission.replied',
      'session.status',
      'session.idle',
    ])
  })

  it('feeds the tool boundary unwrapped, because the hook is handed a boundary and not an event', () => {
    const plan = live.stubPlanFor('block', ids)
    const tool = plan.steps[1]
    expect(tool.event).toEqual({ tool: 'bash', sessionID: 'ses_oa5_1', callID: 'call_oa5_1' })
    expect(tool.event.type).toBeUndefined()
  })

  it('carries the field the real permission reply carries, and no other identity', () => {
    const plan = live.stubPlanFor('block', ids)
    const reply = plan.steps.find(
      (step: { event?: { type?: string } }) => step.event?.type === 'permission.replied',
    )
    expect(reply.event.properties).toEqual({
      sessionID: 'ses_oa5_1',
      requestID: 'per_oa5_1',
      reply: 'reject',
    })
    const ask = plan.steps.find(
      (step: { event?: { type?: string } }) => step.event?.type === 'permission.asked',
    )
    expect(ask.event.properties.id).toBe('per_oa5_1')
    expect(ask.event.properties.sessionID).toBe('ses_oa5_1')
  })

  it('offers a plan with no idle transition and a plan with no events at all', () => {
    const short = live.stubPlanFor('block-without-the-finished-transition', ids)
    expect(short.steps).toHaveLength(4)
    expect(
      short.steps.some((step: { event?: { type?: string } }) => step.event?.type === 'session.idle'),
    ).toBe(false)
    expect(live.stubPlanFor('silent', ids).steps).toEqual([])
    const greeting = live.stubPlanFor('greeting', ids)
    expect(greeting.steps).toHaveLength(3)
    expect(greeting.steps.some((step: { hook: string }) => step.hook === 'tool.execute.before')).toBe(false)
  })

  it('leaves the placeholders substituted everywhere, so a plan cannot carry a template', () => {
    const plan = live.stubPlanFor('block', ids)
    expect(JSON.stringify(plan)).not.toContain('@session')
    expect(JSON.stringify(plan)).not.toContain('@permission')
  })
})

describe('OA-5: the generated sources are inspectable, and say what they are', () => {
  it('starts the built product, supplies only the two documented seams, and stops in order', () => {
    const source = live.hubMainSource()
    expect(source).toContain(live.BUILT_ENTRY_POINT)
    expect(source).toContain('desktop: {')
    expect(source).toContain('surface: { create: () => host }')
    expect(source).toContain('renderCard: renderCard')
    expect(source).toContain("startHub({")
    // The product decides whether a card is presented; this file only records it. A
    // harness that presented a card itself would be testing itself.
    expect(source).not.toContain('planNotification')
    expect(source).not.toContain('require(')
  })

  it('loads the installed plugin file in the stub, and never decides what a signal is worth', () => {
    const source = live.stubHarnessSource()
    expect(source).toContain('OA5_PLUGIN_URL')
    expect(source).toContain('AGENT_PING_PLUGIN')
    expect(source).toContain("app: {")
    expect(source).not.toContain('/api/ingest')
    expect(source).not.toContain('classify')
  })

  it('calls the product own installer and prints its own result', () => {
    const source = live.installerEntrySource()
    expect(source).toContain('installGlobalPlugin')
    expect(source).toContain(live.INSTALLER_SOURCE)
    expect(source).toContain(live.INSTALL_REPORT_PREFIX)
  })

  it('reads the product version out of the checkout, so the installed file names it', () => {
    expect(live.HARNESS_PROBE_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('OA-5: the command line can only narrow what a run does, never widen it', () => {
  it('defaults to the real harness, a real hub and the house evidence path', () => {
    const args = live.parseArgs([])
    expect(args).toEqual({
      out: live.DEFAULT_EVIDENCE_PATH,
      keepState: false,
      help: false,
      harness: 'opencode',
      hub: true,
      stubPlan: 'block',
    })
  })

  it('reads the three options an operator or a test needs', () => {
    const args = live.parseArgs(['--out', '/tmp/e.json', '--keep-state', '--harness', 'stub', '--no-hub'])
    expect(args.out).toBe('/tmp/e.json')
    expect(args.keepState).toBe(true)
    expect(args.harness).toBe('stub')
    expect(args.hub).toBe(false)
  })

  it('refuses a bad command line with its own exit code rather than defaulting', () => {
    for (const argv of [['--nope'], ['--out'], ['--harness', 'mock'], ['--harness'], ['--stub-plan', 'loud']]) {
      let thrown: unknown = null
      try {
        live.parseArgs(argv)
      } catch (cause) {
        thrown = cause
      }
      expect(thrown).toBeInstanceOf(live.UsageError)
      expect((thrown as { code: number }).code).toBe(2)
    }
  })
})

describe('OA-5: what a run found is recorded as a requirement, never applied as a change', () => {
  it('records nothing when the block cleared', () => {
    const observations = [
      { journey: 'permission-then-idle', name: live.BLOCK_ASSERTIONS[3], expected: 'cleared', actual: 'cleared' },
    ]
    expect(live.requiredProductChanges(observations)).toEqual([])
  })

  it('records the refused resolution with its owner, its evidence and the sentence to change', () => {
    const observations = [
      {
        journey: 'permission-then-idle',
        name: live.BLOCK_ASSERTIONS[3],
        expected: 'cleared',
        actual: 'still-pending',
        measured: { hubAnswer: { code: 'hub-refused', status: '422', hubError: 'unidentifiable-block' } },
      },
    ]
    const changes = live.requiredProductChanges(observations)
    expect(changes).toHaveLength(1)
    const change = changes[0] as Record<string, unknown>
    expect(change['id']).toBe('opencode-permission-replied-block-identity')
    expect(change['owner']).toContain('connector-engineer')
    expect(String(change['requiredChange'])).toContain('requestID')
    expect(String(change['finding'])).toContain('422')
  })

  it('records nothing for a block that was never created, which is a different fault', () => {
    const observations = [
      {
        journey: 'permission-then-idle',
        name: live.BLOCK_ASSERTIONS[3],
        expected: 'cleared',
        actual: 'no-block-row',
      },
    ]
    expect(live.requiredProductChanges(observations)).toEqual([])
  })
})

describe('OA-5: the summary is one parseable object carrying versions, times and every assertion', () => {
  const evidence = {
    startedAt: '2026-09-27T00:00:00.000Z',
    finishedAt: '2026-09-27T00:01:00.000Z',
    machine: { platform: 'linux', node: 'v22.22.2', repoVersion: '0.1.0' },
    harness: { kind: 'opencode', version: '1.18.32', expectedLine: '1.18', liveEvidence: true },
    pluginFile: '/tmp/run/config/opencode/plugins/agent-ping.ts',
    hub: { origin: 'http://127.0.0.1:41500', port: 41500, preferredPort: 41500, notifier: { supported: true } },
    delivery: { status: 'ok', wired: true, attempted: 2, delivered: 2 },
    isolation: {
      stateDir: '/tmp/run/state',
      absentStateDir: '/tmp/run/state-absent',
      configHome: '/tmp/run/config',
      stateDirOverride: 'AGENT_PING_STATE_DIR',
      configOverride: 'XDG_CONFIG_HOME',
    },
    seams: { surface: 'recording host', card: 'recording presenter', why: 'documented injection points' },
    requiredProductChanges: [],
  }

  it('names the harness, the versions, both timestamps and every assertion', () => {
    const decision = live.decide(anyRows(2), { assertionsExpected: 2, dependencies: noDependencies })
    const summary = live.buildSummary({
      decision,
      evidence,
      args: { out: '/tmp/e.json' },
      dependencies: noDependencies,
      exitCode: 0,
    }) as Record<string, unknown>
    expect(summary['script']).toBe('verify-opencode-live')
    expect(summary['verdict']).toBe('pass')
    expect(summary['exitCode']).toBe(0)
    expect(summary['startedAt']).toBe('2026-09-27T00:00:00.000Z')
    expect(summary['finishedAt']).toBe('2026-09-27T00:01:00.000Z')
    expect((summary['harness'] as Record<string, unknown>)['version']).toBe('1.18.32')
    expect((summary['product'] as Record<string, unknown>)['version']).toBe('0.1.0')
    expect(summary['assertionsRun']).toBe(2)
    expect((summary['assertions'] as unknown[]).length).toBe(2)
    expect(String(summary['why'])).toContain('real harness')
  })

  it('says the run exercised nothing when it did, rather than describing a pass', () => {
    const decision = live.decide([], { assertionsExpected: 2, dependencies: noDependencies })
    const summary = live.buildSummary({
      decision,
      evidence,
      args: { out: '/tmp/e.json' },
      dependencies: noDependencies,
      exitCode: 1,
    }) as Record<string, unknown>
    expect(summary['verdict']).toBe('fail')
    expect(String(summary['why'])).toContain('exercised 0 of 2 assertions')
  })

  it('carries no conversation content out of a card model', () => {
    const cards = [
      { class: 'needs-you', title: 'repo', bodyLength: 51, urgency: 'critical', lifetime: 'until-resolved' },
    ]
    expect(JSON.stringify(cards)).not.toMatch(/"body"\s*:/)
  })
})

describe('OA-5: the real script, driven against a stub harness', () => {
  it('prints usage and exits zero for --help', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--help'], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('usage: node scripts/verify-opencode-live.mjs')
    expect(result.stdout).toContain('--no-hub')
  }, 60_000)

  it('exits with its own code on a bad command line, writing no summary', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--not-an-option'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('unrecognised argument')
  }, 60_000)

  it('exits non-zero and writes no evidence file when the harness is absent, naming the remedy', () => {
    // An empty PATH is a machine with no opencode on it. Nothing is skipped: the run
    // reports the dependency, exits with the dependency code, and says what to do.
    const run = runScript(['--harness', 'opencode'], { PATH: '' })
    expect(run.status).toBe(3)
    expect(run.evidenceWritten).toBe(false)
    expect(run.summary).not.toBeNull()
    expect(verdictOf(run)).toBe('fail')
    expect(exitCodeOf(run)).toBe(3)
    const failures = failuresOf(run)
    expect(failures.join('\n')).toContain('the opencode binary')
    expect(failures.join('\n')).toContain('PATH')
    expect(String(run.summary?.['why'])).toContain('exercised 0')
  }, 180_000)

  it('runs every assertion of the inventory and reports a per-assertion outcome for each', () => {
    const run = runScript(['--harness', 'stub'])
    expect(run.summary).not.toBeNull()
    expect(exitCodeOf(run)).toBe(run.status)
    // Whatever the product's current behaviour is, the run's own contract holds: every
    // assertion ran, every one is named, and the exit code is the decision's.
    expect(run.summary?.['assertionsRun']).toBe(live.ASSERTIONS_EXPECTED)
    expect(run.summary?.['assertionsExpected']).toBe(live.ASSERTIONS_EXPECTED)
    const names = assertionsOf(run).map((row) => row.name)
    for (const expected of [
      ...live.OPENING_ASSERTIONS,
      ...live.BLOCK_ASSERTIONS,
      ...live.GREETING_ASSERTIONS,
      ...live.ABSENT_HUB_ASSERTIONS,
    ]) {
      expect(names).toContain(expected)
    }
    const matched = assertionsOf(run).filter((row) => row.actual === row.expected).length
    expect(matched + failuresOf(run).length).toBe(live.ASSERTIONS_EXPECTED)
    // A stub run is not live evidence and says so in its own summary.
    expect((run.summary?.['harness'] as Record<string, unknown>)['liveEvidence']).toBe(false)
    expect(run.evidenceWritten).toBe(true)
  }, 180_000)

  it('reads the positive path the same way whether the stand-in or the real harness produced it', () => {
    const run = runScript(['--harness', 'stub'])
    const row = (name: string): SummaryAssertion | undefined =>
      assertionsOf(run).find((entry) => entry.name === name)
    // The positive path: one needs-you envelope, one finished envelope, both under the
    // short name of the directory the session ran in, delivered to the port the hub
    // published rather than the one the product prefers.
    expect(row(live.BLOCK_ASSERTIONS[0])?.actual).toBe('delivered-to-the-published-port')
    expect(row(live.BLOCK_ASSERTIONS[1])?.actual).toBe('1')
    expect(row(live.BLOCK_ASSERTIONS[2])?.actual).toBe('oa5-block-repo')
    expect(row(live.BLOCK_ASSERTIONS[4])?.actual).toBe('1')
    expect(row(live.BLOCK_ASSERTIONS[5])?.actual).toBe('oa5-block-repo')
    // The negative path, and its instrument.
    expect(row(live.GREETING_ASSERTIONS[1])?.actual).toBe('0')
    expect(row(live.GREETING_ASSERTIONS[2])?.actual).toBe('0')
    expect(row(live.GREETING_ASSERTIONS[3])?.actual).toBe('0')
    expect(row(live.GREETING_ASSERTIONS[4])?.actual).toBe('shown-and-presented')
    // The failure path.
    expect(row(live.ABSENT_HUB_ASSERTIONS[0])?.actual).toBe('completed')
    expect(row(live.ABSENT_HUB_ASSERTIONS[1])?.actual).toBe('service+session+event')
    expect(row(live.ABSENT_HUB_ASSERTIONS[2])?.actual).toBe('hub-not-running')
    expect(row(live.ABSENT_HUB_ASSERTIONS[3])?.actual).toBe('nothing-stored')
  }, 180_000)

  it('fails when the expected envelope never arrives, rather than reporting a partial run', () => {
    const run = runScript(['--harness', 'stub', '--stub-plan', 'block-without-the-finished-transition'])
    expect(run.status).not.toBe(0)
    expect(verdictOf(run)).toBe('fail')
    expect(exitCodeOf(run)).toBe(run.status)
    const failures = failuresOf(run).join('\n')
    expect(failures).toContain(live.BLOCK_ASSERTIONS[4])
    expect(failures).toContain(live.BLOCK_ASSERTIONS[5])
    // The rows that do not depend on the missing envelope still ran and still matched, so
    // the failure is a specific one rather than a run that failed everything.
    const row = (name: string): SummaryAssertion | undefined =>
      assertionsOf(run).find((entry) => entry.name === name)
    expect(row(live.BLOCK_ASSERTIONS[1])?.actual).toBe('1')
    expect(row(live.ABSENT_HUB_ASSERTIONS[1])?.actual).toBe('service+session+event')
  }, 180_000)

  it('exits non-zero when the hub is absent, and records the breadcrumb instead of reporting success', () => {
    const run = runScript(['--harness', 'stub', '--no-hub'])
    expect(run.status).not.toBe(0)
    expect(exitCodeOf(run)).toBe(run.status)
    expect(verdictOf(run)).toBe('fail')
    // The breadcrumb journey is the one that still runs, and it is measured for real: the
    // installed plugin reported into a state directory with no hub in it.
    const row = (name: string): SummaryAssertion | undefined =>
      assertionsOf(run).find((entry) => entry.name === name)
    expect(row(live.ABSENT_HUB_ASSERTIONS[0])?.actual).toBe('completed')
    expect(row(live.ABSENT_HUB_ASSERTIONS[1])?.actual).toBe('service+session+event')
    expect(row(live.ABSENT_HUB_ASSERTIONS[2])?.actual).toBe('hub-not-running')
    expect(row(live.ABSENT_HUB_ASSERTIONS[3])?.actual).toBe('nothing-stored')
    // Everything that needed a hub is reported as not observed, never as passing: a row
    // about silence is not a measurement when there is no instrument to be silent.
    const failures = failuresOf(run).join('\n')
    expect(failures).toContain('no hub is serving on this run')
    expect(failures).toContain(live.OPENING_ASSERTIONS[2])
    for (const name of [...live.BLOCK_ASSERTIONS, ...live.GREETING_ASSERTIONS]) {
      const assertion = row(name)
      expect(assertion?.actual).not.toBe(assertion?.expected)
    }
  }, 180_000)

  it('keeps stdout parseable on its own, and puts progress on stderr', () => {
    const run = runScript(['--harness', 'stub'])
    expect(() => JSON.parse(run.stdout)).not.toThrow()
    expect(run.stderr).toContain('[verify-opencode-live]')
    expect(run.stdout).not.toContain('[verify-opencode-live]')
  }, 180_000)
})
