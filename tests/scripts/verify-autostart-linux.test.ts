// The verification script's own judgement, driven with injected command results (IO-4).
//
// The half of the discipline that needs no systemd, no Electron and no display. Every
// test here runs on a machine that has none of them, which is the point: a script whose
// pass/fail judgement can only be exercised on a desk that happens to work is a script
// whose judgement nobody has verified.
//
// The cases are the ways this run can produce a green result that proved nothing, and the
// two that make the service manager non-optional:
//
//   - a pending item that did not survive the restart is a failure, and so is one the
//     restart *duplicated*: the claim is "once, unchanged", so both directions count
//   - a history row that vanished, and a pending count that moved, are each a failure
//   - a service manager that is unavailable is a non-zero exit naming the remedy, and
//     the property is proved by *running* the script, not by reading its code
//   - a short assertion list is a failure, and an empty one is a failure that says so
//   - and only the complete, matching list exits zero
//
// The "fails when zero assertions ran" case is the one that keeps the promise. Without it,
// a refactor that swallowed an exception in the collection phase produces a passing run
// that started nothing and restarted nothing.
//
// Nothing here claims a login was observed. A real login is IO-5's step, on a machine this
// suite never sees; what this suite proves is that the script's judgement would reject a
// run in which a login-derived claim went unobserved.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// @ts-expect-error the script under test is plain JavaScript with no declaration file; its
// exports are the contract this suite exercises, and the ones named here are all it uses.
import * as scriptModule from '../../scripts/verify-autostart-linux.mjs'

/**
 * The slice of the script this suite calls, stated once.
 *
 * Not a second contract: every value below is read out of the module at runtime and
 * asserted against below, so a shape that drifted from the script would fail a test
 * rather than pass quietly on a stale declaration.
 */
interface LiveScript {
  readonly ASSERTIONS_EXPECTED: number
  readonly ASSERTION_INVENTORY: readonly { readonly id: string; readonly name: string; readonly group: string; readonly expected: string }[]
  readonly NOT_OBSERVED: string
  // The nine names, spelled out: an index signature would make every one of them
  // `string | undefined` under this repository's `noUncheckedIndexedAccess`, which is a
  // second way of saying "that dependency might not exist" - and here they are a closed set.
  readonly DependencyStatus: Readonly<{
    PLATFORM: string
    SERVICE_MANAGER: string
    UNIT_DIRECTORY: string
    NO_LIVE_HUB: string
    BUILT_CLI: string
    BUILT_SCHEMA: string
    BUILT_MAIN: string
    PLUGIN_SOURCES: string
    ELECTRON: string
  }>
  readonly USAGE: string
  readonly DEFAULT_EVIDENCE_PATH: string
  decide(
    observations: readonly LiveRow[],
    ctx?: { assertionsExpected?: number; dependencies?: readonly LiveDependency[] },
  ): LiveDecision
  parseCommandReport(text: string): LiveReport
  reportChangeCount(report: LiveReport): number
  reportChangedNothing(report: LiveReport): boolean
  parseCheckBlock(text: string): Record<string, { verdict: string; detail: string }>
  parseRuntimeFile(text: string | null | undefined): LiveRuntimeFile | null
  pendingFingerprint(items: unknown): string
  historyFingerprint(events: unknown): string
  healthFingerprint(health: unknown): string
  historyOccurrences(events: unknown, eventId: string): number
  isInside(child: string, parent: string): boolean
  parseManagerEnvironment(text: string): Record<string, string>
  effectiveConfigRoot(xdgConfigHome: string | undefined, home: string): string
  resolveRealStateDir(env: Readonly<Record<string, string | undefined>>): string
  resolveRealPluginDir(env: Readonly<Record<string, string | undefined>>): string
  requiredProductChanges(observations: readonly LiveRow[]): string[]
  parseArgs(argv: readonly string[]): {
    out: string
    keepState: boolean
    simulateMissingServiceManager: boolean
    help: boolean
  }
}

interface LiveRow {
  readonly id: string
  readonly name: string
  readonly group: string
  readonly expected: string
  readonly actual: string
  readonly observed?: string
  readonly note?: string
}

interface LiveDecision {
  readonly verdict: 'pass' | 'fail'
  readonly exitCode: number
  readonly assertionsExpected: number
  readonly assertionsRun: number
  readonly assertions: readonly LiveRow[]
  readonly failures: readonly string[]
  readonly missingDependencies: readonly string[]
}

interface LiveDependency {
  readonly name: string
  readonly present: boolean
  readonly remedy: string
  readonly detail: string
}

interface LiveReport {
  readonly header: string
  readonly summary: string
  readonly rows: Readonly<Record<string, string>>
  readonly remedies: Readonly<Record<string, string>>
}

interface LiveRuntimeFile {
  readonly host: string
  readonly port: number
  readonly pid: number
  readonly instanceId: string
  readonly stateDir: string
  readonly startedAt: string
}

const script = scriptModule as unknown as LiveScript

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const scriptPath = path.join(repoRoot, 'scripts', 'verify-autostart-linux.mjs')

/** Hard ceiling on the one child run this suite starts, so a wedged script fails it. */
const CHILD_TIMEOUT_MS = 120_000

// ---------------------------------------------------------------------------
// The readings a real run produces, injected
// ---------------------------------------------------------------------------

/** A hub's runtime file, as `src/hub/runtime-file.ts` publishes one. */
const runtimeFile = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  instanceId: '11111111-2222-3333-4444-555555555555',
  pid: 41001,
  host: '127.0.0.1',
  port: 43_517,
  stateDir: '/tmp/apx/state',
  startedAt: '2026-09-28T02:36:00.000Z',
  schemaVersion: 1,
  ...overrides,
})

/** A health payload, narrowed to the three fields the script reads. */
const health = (overrides: Record<string, unknown> = {}) => ({
  status: 'ok',
  pid: 41_001,
  database: { readable: true, pendingCount: 1 },
  server: { listening: true },
  ...overrides,
})

/** One needs-you pending item, as `/api/pending` returns it. */
const pendingItem = (overrides: Record<string, unknown> = {}) => ({
  eventId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  sessionId: 'ses_io4_test',
  class: 'needs-you',
  subtype: null,
  rawEventType: 'permission.asked',
  occurredAt: '2026-09-28T02:36:40.880Z',
  receivedAt: '2026-09-28T02:36:40.883Z',
  dedupeKey: 'opencode:ses_io4_test:blk_io4_test',
  ackState: 'unacknowledged',
  resolutionState: 'unresolved',
  harness: 'opencode',
  repoShortName: 'repo',
  repoFullPath: '/tmp/apx/repo',
  ...overrides,
})

/**
 * The bounded history for the same session: an event record, which carries no repository
 * columns, so the three fields a pending item adds are dropped rather than left to make a
 * history row look like a pending one.
 */
const historyRow = (overrides: Record<string, unknown> = {}) => {
  const record: Record<string, unknown> = { ...pendingItem() }
  for (const field of ['harness', 'repoShortName', 'repoFullPath']) delete record[field]
  return { ...record, ...overrides }
}

const satisfied = (name: string) => ({ name, present: true, remedy: 'not needed', detail: 'present' })

// ---------------------------------------------------------------------------
// The judgement, driven with injected command results
// ---------------------------------------------------------------------------

/**
 * Build the run's observations from injected readings, using the script's own parsers.
 *
 * This is the part of the shell a test can honestly reproduce: the fingerprints and the
 * comparison are the script's, so a test that injects a different `pending` payload is
 * injecting a different *product observation* rather than a different expectation.
 */
function observationsFrom(readings: {
  pendingBefore?: readonly unknown[] | null
  pendingAfter?: readonly unknown[] | null
  historyBefore?: readonly unknown[] | null
  historyAfter?: readonly unknown[] | null
  healthBefore?: unknown
  healthAfter?: unknown
  opened?: LiveRuntimeFile | null
  restarted?: LiveRuntimeFile | null
}): LiveRow[] {
  const inventory = new Map<string, (typeof script.ASSERTION_INVENTORY)[number]>(
    script.ASSERTION_INVENTORY.map((entry) => [entry.id, entry]),
  )
  const row = (id: string, ok: boolean, observed: string): LiveRow => {
    const known = inventory.get(id)
    if (known === undefined) throw new Error(`no assertion called ${id}`)
    return {
      id,
      name: known.name,
      group: known.group,
      expected: known.expected,
      actual: ok ? known.expected : observed,
      observed,
    }
  }

  const pendingBefore: readonly unknown[] | null = readings.pendingBefore ?? null
  const pendingAfter: readonly unknown[] | null = readings.pendingAfter ?? null
  const historyBefore: readonly unknown[] | null = readings.historyBefore ?? null
  const historyAfter: readonly unknown[] | null = readings.historyAfter ?? null
  const beforePending = script.pendingFingerprint(pendingBefore)
  const afterPending = script.pendingFingerprint(pendingAfter)
  const beforeHistory = script.historyFingerprint(historyBefore)
  const afterHistory = script.historyFingerprint(historyAfter)
  const eventId = (pendingBefore?.[0] as { eventId?: string } | undefined)?.eventId ?? null
  const occurrences =
    eventId === null ? 0 : script.historyOccurrences(historyAfter, eventId)

  return [
    row(
      'the-pending-item-survived-the-restart',
      beforePending !== '' && beforePending === afterPending,
      `before ${beforePending === '' ? 'nothing pending' : beforePending.replaceAll('\n', '; ')}; after ${
        afterPending === '' ? 'nothing pending' : afterPending.replaceAll('\n', '; ')
      }`,
    ),
    row(
      'its-history-row-survived-the-restart',
      beforeHistory !== '' && beforeHistory === afterHistory && occurrences === 1,
      `before ${String(historyBefore?.length ?? 0)} row(s); after ${String(historyAfter?.length ?? 0)} row(s); ${String(occurrences)} occurrence(s) of ${String(eventId)}`,
    ),
    row(
      'the-pending-count-is-unchanged',
      (pendingBefore?.length ?? null) !== null && pendingBefore?.length === pendingAfter?.length,
      `${String(pendingBefore?.length ?? 'unknown')} before, ${String(pendingAfter?.length ?? 'unknown')} after`,
    ),
    row(
      'the-restarted-hub-is-a-different-process-and-instance',
      readings.opened !== null &&
        readings.opened !== undefined &&
        readings.restarted !== null &&
        readings.restarted !== undefined &&
        readings.opened.pid !== readings.restarted.pid &&
        readings.opened.instanceId !== readings.restarted.instanceId,
      `pid ${String(readings.opened?.pid)} -> ${String(readings.restarted?.pid)}`,
    ),
    row(
      'health-payload-is-ok-and-readable',
      (readings.healthAfter as { status?: string } | null)?.status === 'ok' &&
        (readings.healthAfter as { database?: { readable?: boolean } } | null)?.database?.readable === true,
      script.healthFingerprint(readings.healthAfter),
    ),
  ]
}

describe('the assertion inventory this run owes', () => {
  it('is a closed, non-empty, duplicate-free list whose length is the declared count', () => {
    expect(script.ASSERTION_INVENTORY.length).toBeGreaterThan(0)
    expect(script.ASSERTION_INVENTORY.length, 'the count a shortfall is measured against').toBe(
      script.ASSERTIONS_EXPECTED,
    )
    const ids = script.ASSERTION_INVENTORY.map((entry) => entry.id)
    expect(new Set(ids).size, 'two assertions cannot share an id').toBe(ids.length)
    for (const entry of script.ASSERTION_INVENTORY) {
      expect(entry.id, `every assertion is named by a stable id`).toMatch(/^[a-z0-9-]+$/)
      expect(entry.name, `assertion ${entry.id} carries the sentence a human reads`).not.toBe('')
      expect(entry.expected, `assertion ${entry.id} declares what must hold`).not.toBe('')
      expect(entry.group, `assertion ${entry.id} belongs to a group`).not.toBe('')
    }
  })

  it('covers the acceptance criteria by name, so a reader can see where each is proved', () => {
    const ids = script.ASSERTION_INVENTORY.map((entry) => entry.id)
    // Criterion 1: the pending item, its history row and the count, all after a real restart.
    expect(ids).toContain('the-pending-item-survived-the-restart')
    expect(ids).toContain('its-history-row-survived-the-restart')
    expect(ids).toContain('the-pending-count-is-unchanged')
    // Criterion 3: disable removes the unit; uninstall removes the plugin and keeps the database.
    expect(ids).toContain('uninstall-removed-the-unit-and-its-wants-link')
    expect(ids).toContain('uninstall-removed-the-plugin-file')
    expect(ids).toContain('uninstall-kept-the-database')
    // The two requirements: IO-FR-06 (a user-level unit the live manager reads) and
    // IO-FR-08 (a repeat install is safe, and a version mismatch is reported).
    expect(ids).toContain('install-enabled-a-unit-the-live-manager-reads')
    expect(ids).toContain('a-second-install-changes-nothing')
    expect(ids).toContain('a-differing-plugin-version-is-reported-not-replaced')
  })

  it('includes the negative and the failure paths, which are the ones that catch a real bug', () => {
    const ids = script.ASSERTION_INVENTORY.map((entry) => entry.id)
    // A restart that silently lost the item, and one that duplicated it, are the two ways
    // this product breaks the badge; a happy-path-only script passes both.
    expect(ids).toContain('its-history-row-survived-the-restart')
    expect(ids).toContain('a-differing-plugin-version-is-reported-not-replaced')
    // And the negative one: nothing that must change, changed.
    expect(ids).toContain('a-second-install-changes-nothing')
  })
})

describe('decide, driven with injected command results', () => {
  it('passes when the pending item, its history row and the count all survived unchanged', () => {
    const decision = script.decide(
      observationsFrom({
        pendingBefore: [pendingItem()],
        pendingAfter: [pendingItem()],
        historyBefore: [historyRow()],
        historyAfter: [historyRow()],
        healthBefore: health(),
        healthAfter: health(),
        opened: script.parseRuntimeFile(JSON.stringify(runtimeFile())),
        restarted: script.parseRuntimeFile(
          JSON.stringify(runtimeFile({ pid: 41_002, instanceId: '99999999-8888-7777-6666-555555555555' })),
        ),
      }),
      { assertionsExpected: 5, dependencies: [satisfied('the service manager')] },
    )
    expect(decision.verdict).toBe('pass')
    expect(decision.exitCode).toBe(0)
    expect(decision.failures).toEqual([])
    expect(decision.assertionsRun).toBe(5)
  })

  it('fails when the pending item does not survive a restart', () => {
    const decision = script.decide(
      observationsFrom({
        pendingBefore: [pendingItem()],
        pendingAfter: [],
        historyBefore: [historyRow()],
        historyAfter: [historyRow()],
        healthBefore: health(),
        healthAfter: health({ database: { readable: true, pendingCount: 0 } }),
        opened: script.parseRuntimeFile(JSON.stringify(runtimeFile())),
        restarted: script.parseRuntimeFile(
          JSON.stringify(runtimeFile({ pid: 41_002, instanceId: '99999999-8888-7777-6666-555555555555' })),
        ),
      }),
      { assertionsExpected: 5, dependencies: [satisfied('the service manager')] },
    )
    expect(decision.verdict).toBe('fail')
    expect(decision.exitCode).toBe(1)
    const text = decision.failures.join('\n')
    expect(text).toContain('the-pending-item-survived-the-restart')
    expect(text).toMatch(/expected identical pending fingerprint, observed before .*after nothing pending/)
    expect(text).toContain('the-pending-count-is-unchanged')
  })

  it('fails when the restart duplicated the pending item, because the claim is "once"', () => {
    const decision = script.decide(
      observationsFrom({
        pendingBefore: [pendingItem()],
        pendingAfter: [pendingItem(), pendingItem({ eventId: 'ffffffff-0000-0000-0000-000000000000' })],
        historyBefore: [historyRow()],
        historyAfter: [historyRow()],
        healthBefore: health(),
        healthAfter: health(),
        opened: script.parseRuntimeFile(JSON.stringify(runtimeFile())),
        restarted: script.parseRuntimeFile(
          JSON.stringify(runtimeFile({ pid: 41_002, instanceId: '99999999-8888-7777-6666-555555555555' })),
        ),
      }),
      { assertionsExpected: 5, dependencies: [satisfied('the service manager')] },
    )
    expect(decision.verdict).toBe('fail')
    const text = decision.failures.join('\n')
    expect(text).toContain('the-pending-item-survived-the-restart')
    expect(text).toContain('the-pending-count-is-unchanged')
  })

  it('fails when the pending item survived but its history row did not', () => {
    const decision = script.decide(
      observationsFrom({
        pendingBefore: [pendingItem()],
        pendingAfter: [pendingItem()],
        historyBefore: [historyRow()],
        historyAfter: [],
        healthBefore: health(),
        healthAfter: health(),
        opened: script.parseRuntimeFile(JSON.stringify(runtimeFile())),
        restarted: script.parseRuntimeFile(
          JSON.stringify(runtimeFile({ pid: 41_002, instanceId: '99999999-8888-7777-6666-555555555555' })),
        ),
      }),
      { assertionsExpected: 5, dependencies: [satisfied('the service manager')] },
    )
    expect(decision.verdict).toBe('fail')
    expect(decision.failures.join('\n')).toContain('its-history-row-survived-the-restart')
  })

  it('fails when the "restarted" hub is the same process, so nothing was restarted at all', () => {
    const decision = script.decide(
      observationsFrom({
        pendingBefore: [pendingItem()],
        pendingAfter: [pendingItem()],
        historyBefore: [historyRow()],
        historyAfter: [historyRow()],
        healthBefore: health(),
        healthAfter: health(),
        opened: script.parseRuntimeFile(JSON.stringify(runtimeFile())),
        restarted: script.parseRuntimeFile(JSON.stringify(runtimeFile())),
      }),
      { assertionsExpected: 5, dependencies: [satisfied('the service manager')] },
    )
    expect(decision.verdict).toBe('fail')
    expect(decision.failures.join('\n')).toContain('the-restarted-hub-is-a-different-process-and-instance')
  })

  it('fails when the restarted hub is not readable, and says so rather than passing', () => {
    const decision = script.decide(
      observationsFrom({
        pendingBefore: [pendingItem()],
        pendingAfter: null,
        historyBefore: [historyRow()],
        historyAfter: null,
        healthBefore: health(),
        healthAfter: health({ status: 'degraded' }),
        opened: script.parseRuntimeFile(JSON.stringify(runtimeFile())),
        restarted: null,
      }),
      { assertionsExpected: 5, dependencies: [satisfied('the service manager')] },
    )
    expect(decision.verdict).toBe('fail')
    const text = decision.failures.join('\n')
    expect(text).toContain('the-pending-item-survived-the-restart')
    expect(text).toContain('health-payload-is-ok-and-readable')
  })

  it('fails when zero assertions ran, and says the green result would prove nothing', () => {
    const decision = script.decide([], {
      assertionsExpected: script.ASSERTIONS_EXPECTED,
      dependencies: [satisfied('the service manager')],
    })
    expect(decision.verdict).toBe('fail')
    expect(decision.exitCode).toBe(1)
    expect(decision.assertionsRun).toBe(0)
    const text = decision.failures.join('\n')
    expect(text).toContain(
      `executed 0 of ${String(script.ASSERTIONS_EXPECTED)} assertions`,
    )
    expect(text).toMatch(/exercised nothing is not a pass/)
    expect(text).toMatch(/produced no row at all/)
  })

  it('fails when the row list is short, naming a step that produced no row at all', () => {
    const rows = observationsFrom({
      pendingBefore: [pendingItem()],
      pendingAfter: [pendingItem()],
      historyBefore: [historyRow()],
      historyAfter: [historyRow()],
      healthAfter: health(),
      opened: script.parseRuntimeFile(JSON.stringify(runtimeFile())),
      restarted: script.parseRuntimeFile(
        JSON.stringify(runtimeFile({ pid: 41_002, instanceId: '99999999-8888-7777-6666-555555555555' })),
      ),
    })
    const decision = script.decide(rows.slice(0, 3), {
      assertionsExpected: script.ASSERTIONS_EXPECTED,
      dependencies: [satisfied('the service manager')],
    })
    expect(decision.verdict).toBe('fail')
    const text = decision.failures.join('\n')
    expect(text).toContain(`executed 3 of ${String(script.ASSERTIONS_EXPECTED)}`)
    expect(text).toMatch(/produced no row at all/)
  })

  it('treats a not-observed row as a failure, not as a step that found nothing wrong', () => {
    const rows = observationsFrom({
      pendingBefore: [pendingItem()],
      pendingAfter: [pendingItem()],
      historyBefore: [historyRow()],
      historyAfter: [historyRow()],
      healthAfter: health(),
      opened: script.parseRuntimeFile(JSON.stringify(runtimeFile())),
      restarted: script.parseRuntimeFile(
        JSON.stringify(runtimeFile({ pid: 41_002, instanceId: '99999999-8888-7777-6666-555555555555' })),
      ),
    })
    const first = rows[0]
    if (first === undefined) throw new Error('the injected readings produced no rows')
    const decision = script.decide(
      [{ ...first, actual: script.NOT_OBSERVED, note: 'the pending route did not answer' }, ...rows.slice(1)],
      { assertionsExpected: rows.length, dependencies: [satisfied('the service manager')] },
    )
    expect(decision.verdict).toBe('fail')
    expect(decision.assertionsRun).toBe(rows.length - 1)
    expect(decision.failures.join('\n')).toMatch(/observed not-observed/)
  })

  it('fails when a dependency is absent, and names the remedy that fixes it', () => {
    const decision = script.decide([], {
      assertionsExpected: script.ASSERTIONS_EXPECTED,
      dependencies: [
        {
          name: script.DependencyStatus.SERVICE_MANAGER,
          present: false,
          remedy: 'log in on a desktop session and run this again',
          detail: 'systemctl --user show-environment exited 1',
        },
      ],
    })
    expect(decision.verdict).toBe('fail')
    expect(decision.exitCode).toBe(1)
    const text = decision.failures.join('\n')
    expect(text).toContain('required dependency unavailable')
    expect(text).toContain(script.DependencyStatus.SERVICE_MANAGER)
    expect(text).toContain('log in on a desktop session')
    expect(decision.missingDependencies.join('\n')).toContain('log in on a desktop session')
  })
})

describe('the command reports this script reads', () => {
  it('reads install output as a header, one row per subject, and a remedy per failure', () => {
    const report = script.parseCommandReport(
      [
        'agent-ping install: 3 changes.',
        '  autostart  enabled /home/dev/.config/systemd/user/agent-ping.service',
        '  hub        started and serving at http://127.0.0.1:43117',
        '  plugin     wrote /home/dev/.config/opencode/plugins/agent-ping.ts (agent-ping 0.1.0)',
      ].join('\n'),
    )
    expect(report.header).toBe('agent-ping install: 3 changes.')
    expect(report.rows['autostart']).toBe('enabled /home/dev/.config/systemd/user/agent-ping.service')
    expect(report.rows['plugin']).toBe(
      'wrote /home/dev/.config/opencode/plugins/agent-ping.ts (agent-ping 0.1.0)',
    )
    expect(script.reportChangeCount(report)).toBe(3)
    expect(script.reportChangedNothing(report)).toBe(false)
  })

  it('reads "nothing was changed" as zero changes, which is what IO-FR-08 asks for', () => {
    const report = script.parseCommandReport(
      [
        'agent-ping install: nothing was changed.',
        '  autostart  already enabled (/home/dev/.config/systemd/user/agent-ping.service)',
        '  hub        already running at http://127.0.0.1:43117',
        '  plugin     agent-ping 0.1.0 is already installed at /home/dev/.config/opencode/plugins/agent-ping.ts; not one byte was touched',
      ].join('\n'),
    )
    expect(script.reportChangedNothing(report)).toBe(true)
    expect(script.reportChangeCount(report)).toBe(0)
  })

  it('reads a version mismatch as a remedy naming both ways forward', () => {
    const report = script.parseCommandReport(
      [
        'agent-ping install: 1 change.',
        '  autostart  enabled /home/dev/.config/systemd/user/agent-ping.service',
        '  remedy (plugin): agent-ping 0.1.0 was not installed: the file already holds agent-ping 0.0.9. ' +
          'Run `agent-ping uninstall` first, or run `agent-ping install --force` once you have decided to replace agent-ping 0.0.9',
      ].join('\n'),
    )
    const remedy = report.remedies['plugin'] ?? ''
    expect(remedy).toContain('uninstall')
    expect(remedy).toContain('--force')
    expect(report.rows['plugin']).toBeUndefined()
  })

  it('reads a state row that says the database was kept, which is what the teardown needs', () => {
    const report = script.parseCommandReport(
      [
        'agent-ping uninstall: 3 changes.',
        '  autostart  disabled /home/dev/.config/systemd/user/agent-ping.service',
        '  plugin     removed 1 file from /home/dev/.config/opencode/plugins',
        '  state      removed agent-ping.log from /home/dev/.local/state/agent-ping; ' +
          'database: kept /home/dev/.local/state/agent-ping/agent-ping.db; pass --purge to remove it',
      ].join('\n'),
    )
    expect(report.rows['state']).toContain('database: kept')
    expect(report.rows['state']).toContain('agent-ping.db')
  })

  it('reads the doctor check block as name -> verdict, and only the three closed verdicts', () => {
    const checks = script.parseCheckBlock(
      [
        'agent-ping doctor 0.1.0 on linux',
        '  autostart        ok       enabled (/home/dev/.config/systemd/user/agent-ping.service)',
        '  database         ok       /home/dev/.local/state/agent-ping/agent-ping.db, writable',
        '  tray             fail     this run asked for a tray and the desktop did not give it one',
        '                    remedy: check that the session has a status area',
        '  1 of 7 checks failed.',
      ].join('\n'),
    )
    expect(checks['autostart']?.verdict).toBe('ok')
    expect(checks['database']?.verdict).toBe('ok')
    expect(checks['tray']?.verdict).toBe('fail')
    // A remedy line and a closing summary are not check rows: their second column is
    // never a closed verdict, and reading one as a check would invent a seventh fault.
    expect(Object.keys(checks)).toEqual(['autostart', 'database', 'tray'])
  })

  it('reads a runtime file, and reads an absent or damaged one as no hub rather than throwing', () => {
    expect(script.parseRuntimeFile(JSON.stringify(runtimeFile()))?.port).toBe(43_517)
    expect(script.parseRuntimeFile('')).toBeNull()
    expect(script.parseRuntimeFile('{ not json')).toBeNull()
    expect(script.parseRuntimeFile('[]')).toBeNull()
    // A file with no port in it is a hub that is still starting, not a hub on no port.
    expect(script.parseRuntimeFile(JSON.stringify({ ...runtimeFile(), port: null }))).toBeNull()
  })
})

describe('the fingerprints the restart comparison is made from', () => {
  it('is order-independent, so a reordered route response is not read as a change', () => {
    const first = pendingItem()
    const second = pendingItem({ eventId: 'ffffffff-0000-0000-0000-000000000000', dedupeKey: 'opencode:ses_io4_test:blk_two' })
    expect(script.pendingFingerprint([first, second])).toBe(script.pendingFingerprint([second, first]))
  })

  it('changes when a field a row needs to be recognisable changes', () => {
    const before = script.pendingFingerprint([pendingItem()])
    expect(script.pendingFingerprint([pendingItem({ ackState: 'acknowledged' })])).not.toBe(before)
    expect(script.pendingFingerprint([pendingItem({ resolutionState: 'resolved' })])).not.toBe(before)
    expect(script.pendingFingerprint([pendingItem({ eventId: 'other' })])).not.toBe(before)
  })

  it('reads a missing array as an empty fingerprint rather than as a failure', () => {
    expect(script.pendingFingerprint(null)).toBe('')
    expect(script.historyFingerprint(undefined)).toBe('')
    expect(script.healthFingerprint(null)).toContain('status=?')
  })

  it('counts occurrences of one row key, which is how a duplicated history row is caught', () => {
    const once = [historyRow()]
    const twice = [historyRow(), historyRow()]
    expect(script.historyOccurrences(once, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(1)
    expect(script.historyOccurrences(twice, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(2)
    expect(script.historyOccurrences(once, 'not-in-the-list')).toBe(0)
  })

  it('narrows a health payload to counts and closed tokens, never to anything else', () => {
    const fingerprint = script.healthFingerprint(
      health({ desktop: { bridge: 'present', tray: 'mounted', surface: 'available' } }),
    )
    expect(fingerprint).toBe('status=ok readable=true pendingCount=1')
  })
})

describe('the paths and the environment the run resolves', () => {
  it('resolves the per-user unit directory the way the product does, from XDG_CONFIG_HOME', () => {
    expect(script.effectiveConfigRoot('', '/home/dev')).toBe('/home/dev/.config')
    expect(script.effectiveConfigRoot('   ', '/home/dev')).toBe('/home/dev/.config')
    expect(script.effectiveConfigRoot('/tmp/cfg', '/home/dev')).toBe('/tmp/cfg')
  })

  it('resolves the account own state directory and the opencode plugin directory', () => {
    expect(script.resolveRealStateDir({ HOME: '/home/dev' })).toBe(
      '/home/dev/.local/state/agent-ping',
    )
    expect(script.resolveRealStateDir({ HOME: '/home/dev', XDG_STATE_HOME: '/tmp/state' })).toBe(
      '/tmp/state/agent-ping',
    )
    expect(script.resolveRealPluginDir({ HOME: '/home/dev' })).toBe('/home/dev/.config/opencode/plugins')
    expect(script.resolveRealPluginDir({ HOME: '/home/dev', XDG_CONFIG_HOME: '/tmp/cfg' })).toBe(
      '/tmp/cfg/opencode/plugins',
    )
  })

  it('reads the manager environment as KEY=VALUE lines and nothing else', () => {
    const variables = script.parseManagerEnvironment(
      ['HOME=/home/dev', 'XDG_SESSION_TYPE=x11', 'DISPLAY=:1', 'a line with no equals', '=novalue'].join(
        '\n',
      ),
    )
    expect(variables['HOME']).toBe('/home/dev')
    expect(variables['XDG_SESSION_TYPE']).toBe('x11')
    expect(variables['']).toBeUndefined()
    expect(Object.keys(variables)).toHaveLength(3)
  })

  it('answers "is this path inside that directory" the way the isolation assertion needs', () => {
    expect(script.isInside('/tmp/apx/state/agent-ping.db', '/tmp/apx/state')).toBe(true)
    expect(script.isInside('/tmp/apx/state/nested/deeper', '/tmp/apx/state')).toBe(true)
    expect(script.isInside('/home/dev/.local/state/agent-ping', '/tmp/apx/state')).toBe(false)
    expect(script.isInside('/tmp/apx/state', '/tmp/apx/state')).toBe(false)
    expect(script.isInside('/tmp/apx/state-other/db', '/tmp/apx/state')).toBe(false)
  })
})

describe('requiredProductChanges', () => {
  it('names the observation and the group for a failure, and nothing for a pass', () => {
    const changes = script.requiredProductChanges([
      {
        id: 'the-pending-item-survived-the-restart',
        name: 'the pending item survived the restart unchanged and exactly once',
        group: 'restart',
        expected: 'identical pending fingerprint',
        actual: 'before nothing pending; after nothing pending',
        observed: 'before nothing pending; after nothing pending',
      },
      {
        id: 'uninstall-kept-the-database',
        name: 'uninstall kept the database, and said so',
        group: 'teardown',
        expected: 'database present + output said kept',
        actual: 'database present + output said kept',
        observed: 'the database is there',
      },
    ])
    expect(changes).toHaveLength(1)
    expect(changes[0]).toContain('the-pending-item-survived-the-restart')
    expect(changes[0]).toContain('restart')
  })

  it('records a not-observed step with the reason it was not observed', () => {
    const changes = script.requiredProductChanges([
      {
        id: 'start-through-the-manager-activated-the-unit',
        name: 'starting the unit through the service manager activated it',
        group: 'restart',
        expected: 'is-active active + a port published',
        actual: script.NOT_OBSERVED,
        note: 'a hub published nothing',
        observed: 'a hub published nothing',
      },
    ])
    expect(changes[0]).toContain('not observed: a hub published nothing')
  })
})

describe('the command line', () => {
  it('takes an evidence path and resolves it against the repository root', () => {
    expect(script.parseArgs(['--out', 'test-results/apx.json']).out).toBe(
      path.join(repoRoot, 'test-results', 'apx.json'),
    )
    expect(script.parseArgs([]).out).toBe(
      path.join(repoRoot, script.DEFAULT_EVIDENCE_PATH),
    )
  })

  it('refuses an option it does not know rather than ignoring it', () => {
    expect(() => script.parseArgs(['--not-a-flag'])).toThrow(/unknown option/)
    expect(() => script.parseArgs(['--out'])).toThrow(/needs a file/)
  })

  it('has a flag that makes an absent service manager a claim a test can make', () => {
    expect(script.parseArgs(['--simulate-missing-service-manager']).simulateMissingServiceManager).toBe(true)
    expect(script.parseArgs(['--simulate-missing-service-manager']).keepState).toBe(false)
    expect(script.parseArgs(['--keep-state']).keepState).toBe(true)
  })

  it('states in its own usage text that macOS and Windows have to be re-earned', () => {
    expect(script.USAGE).toMatch(/macOS and Windows/)
    expect(script.USAGE).toMatch(/APX-CON-06/)
  })
})

describe('the run itself, with the service manager reported as unavailable', () => {
  // The one property that can only be established by running the script: that a machine
  // without a usable service manager produces a non-zero exit, a zero assertion count and
  // a named remedy, rather than a green result that started nothing.
  it('exits non-zero, runs no assertion, and names the service manager and its remedy', () => {
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--simulate-missing-service-manager', '--out', path.join(repoRoot, 'test-results', 'apx-should-not-exist.json')],
      { cwd: repoRoot, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS },
    )
    expect(result.error, 'the script could not be started at all').toBeUndefined()
    expect(result.status, 'a machine that cannot answer the question must not exit zero').not.toBe(0)

    const summary = JSON.parse(result.stdout) as {
      verdict: string
      exitCode: number
      assertionsRun: number
      assertionsExpected: number
      failures: string[]
      evidenceWritten: boolean
      missingDependencies: string[]
    }
    expect(summary.verdict).toBe('fail')
    expect(summary.exitCode).not.toBe(0)
    expect(summary.assertionsRun, 'nothing ran, and the summary says so').toBe(0)
    expect(summary.assertionsExpected).toBe(script.ASSERTIONS_EXPECTED)
    expect(summary.evidenceWritten, 'a run that never looked for anything writes no evidence file').toBe(
      false,
    )
    expect(
      existsSync(path.join(repoRoot, 'test-results', 'apx-should-not-exist.json')),
      'and nothing was written to the path it was given',
    ).toBe(false)
    const text = summary.failures.join('\n')
    expect(text).toContain(script.DependencyStatus.SERVICE_MANAGER)
    expect(text).toMatch(/log in on a desktop session/)
    expect(summary.missingDependencies.join('\n')).toContain(script.DependencyStatus.SERVICE_MANAGER)
    // The no-zero-work guard fires on this path too, so a reader is told that zero
    // assertions is a failed run rather than an empty one.
    expect(text).toMatch(/exercised nothing is not a pass/)
  }, CHILD_TIMEOUT_MS)

  it('prints its progress on stderr and only the JSON summary on stdout', () => {
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--simulate-missing-service-manager'],
      { cwd: repoRoot, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS },
    )
    expect(() => JSON.parse(result.stdout)).not.toThrow()
    expect(result.stderr).toContain('required dependency unavailable')
    // A progress line on stdout is what makes an evidence file unparseable later.
    expect(result.stdout.startsWith('{')).toBe(true)
  }, CHILD_TIMEOUT_MS)
})

describe('the platform scope, in the places a reader looks for it', () => {
  // Acceptance criterion 4: the runbook has to say the same script must be run on macOS
  // and Windows for those platforms to be claimed. Asserted from the file rather than
  // promised in a comment, because a promise in a comment is what this repository exists
  // to stop believing.
  it('the operations runbook names the script and says macOS and Windows need their own run', () => {
    const runbook = readFileSync(
      path.join(repoRoot, 'docs', 'runbooks', 'io-5-operations-review.md'),
      'utf8',
    )
    expect(runbook).toContain('scripts/verify-autostart-linux.mjs')
    expect(runbook).toMatch(/macOS and Windows/)
    expect(runbook).toMatch(/must be run on those machines|re-?run this script on/i)
  })

  it('the README says the same thing, because a reader starts there', () => {
    const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8')
    expect(readme).toContain('scripts/verify-autostart-linux.mjs')
    expect(readme).toMatch(/macOS and Windows/)
  })

  it('the script itself makes no claim about a platform it did not run on', () => {
    const source = readFileSync(scriptPath, 'utf8')
    // The only platform this script asserts on is the one it drives.
    expect(source).toContain('systemctl')
    expect(source).toContain('a Linux machine')
    // And it says so in the platform dependency's own remedy, where a person blocked by
    // the absence will read it.
    const decision = script.decide([], {
      assertionsExpected: 1,
      dependencies: [
        {
          name: script.DependencyStatus.PLATFORM,
          present: false,
          remedy: 'this script drives systemctl --user, so it runs on Linux; macOS and Windows have to re-earn it',
          detail: 'this process reports platform darwin',
        },
      ],
    })
    expect(decision.failures.join('\n')).toContain('macOS and Windows')
  })
})

describe('the script the suite is testing', () => {
  it('exists where the runbook, the README and this suite all name it', () => {
    expect(existsSync(scriptPath)).toBe(true)
  })

  it('exports the pure judgement and the pure parsers, and nothing that needs a machine', () => {
    // The judgement must be reachable with no process, no filesystem and no socket. If a
    // future refactor moves it behind a class that reads a runtime file, this fails.
    for (const name of [
      'decide',
      'parseCommandReport',
      'reportChangeCount',
      'reportChangedNothing',
      'parseCheckBlock',
      'parseRuntimeFile',
      'pendingFingerprint',
      'historyFingerprint',
      'healthFingerprint',
      'historyOccurrences',
      'isInside',
      'parseManagerEnvironment',
      'effectiveConfigRoot',
      'resolveRealStateDir',
      'resolveRealPluginDir',
      'requiredProductChanges',
      'parseArgs',
    ]) {
      expect(typeof (script as unknown as Record<string, unknown>)[name], `exports ${name}`).toBe('function')
    }
    expect(Array.isArray(script.ASSERTION_INVENTORY)).toBe(true)
    expect(typeof script.ASSERTIONS_EXPECTED).toBe('number')
    expect(typeof script.NOT_OBSERVED).toBe('string')
  })
})
