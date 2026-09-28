// The verification script's own judgement, driven with injected results (LD-4).
//
// The half of the discipline that does not need a browser. Everything here runs
// on a machine with no Chromium installed, no display and no hub, which is the
// point: a script whose pass/fail judgement can only ever be exercised on a desk
// that happens to work is a script whose judgement nobody has verified.
//
// The five cases are the five ways this run can produce a green result that proved
// nothing, and the two that make the browser itself non-optional:
//
//   - a journey list that is short (including empty) is a failure
//   - a journey that ran and did not pass is a failure
//   - a runner that exited non-zero is a failure
//   - a browser that could not be obtained is a failure naming the remedy
//   - and only the complete, passing list exits zero
//
// The `fails when zero journeys ran` case is the one that keeps the promise. Without
// it, a refactor that swallowed an exception in the collection phase produces a
// passing run that drove nothing.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// The judgement is imported from the script itself, whose declarations sit beside
// it. A restatement here would be a second answer to "did this run prove anything",
// and the two could be edited to disagree.
import {
  decideDashboardE2ERun,
  ledgerAsJourneyRecords,
  parseArgs,
  readJourneyLedger,
  DEFAULT_SPEC,
  EXPECTED_JOURNEYS,
  JOURNEY_LEDGER_PATH,
  OBSERVATION_LEDGER_PATH,
} from '../../scripts/verify-dashboard-e2e.mjs'
import { removeTree } from '../helpers/remove-tree'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const scratch = mkdtempSync(path.join(tmpdir(), 'agent-ping-dashboard-e2e-test-'))

afterAll(() => {
  removeTree(scratch)
})

const everyJourney = (outcome = 'passed') =>
  EXPECTED_JOURNEYS.map((journey) => ({
    id: journey.id,
    name: journey.name,
    outcome,
    durationMs: 1,
    at: '2026-01-01T00:00:00.000Z',
  }))

/**
 * A source file with its comments removed and its strings kept.
 *
 * Comments go because a source-level sweep is about what a module *does*, not about
 * the sentences describing it - and this repository's prose names every shape it
 * deliberately avoids ("`bypassCSP` stays off", "no `globalSetup`"), so keeping
 * comments would make the sweep below fail on the file's own documentation of what
 * it does not do. That is the trap the notification-surface suite hit and recorded
 * for the same reason.
 *
 * Strings stay, because a forbidden *name* is most often only ever a string.
 *
 * Known limitation, stated rather than hidden: a backtick template is read as one
 * string to its closing backtick, so a nested template inside a `${...}` would end
 * the scan early. Neither the config nor the spec nests a template inside a
 * template, and a missed token would still be caught by the same token in the value
 * the code then uses.
 */
function readCode(source: string): string {
  let out = ''
  let index = 0
  const blank = (length: number): void => {
    for (let offset = 0; offset < length; offset += 1) out += source[index + offset] === '\n' ? '\n' : ' '
  }
  while (index < source.length) {
    const pair = source.slice(index, index + 2)
    if (pair === '//') {
      let end = source.indexOf('\n', index)
      if (end === -1) end = source.length
      blank(end - index)
      index = end
      continue
    }
    if (pair === '/*') {
      const found = source.indexOf('*/', index + 2)
      const stop = found === -1 ? source.length : found + 2
      blank(stop - index)
      index = stop
      continue
    }
    const character = source[index] ?? ''
    if (character === "'" || character === '"' || character === '`') {
      let cursor = index + 1
      while (cursor < source.length) {
        const inner = source[cursor]
        if (inner === '\\') {
          cursor += 2
          continue
        }
        if (inner === character) {
          cursor += 1
          break
        }
        if (character !== '`' && inner === '\n') break
        cursor += 1
      }
      out += source.slice(index, cursor)
      index = cursor
      continue
    }
    out += character
    index += 1
  }
  return out
}

const readConfigCode = (): string => readCode(readFileSync(path.join(repoRoot, 'playwright.config.ts'), 'utf8'))
const readSpecCode = (): string => readCode(readFileSync(path.join(repoRoot, 'tests', 'e2e', 'dashboard.spec.ts'), 'utf8'))

const allDependencies = [{ name: 'playwright chromium', present: true, remedy: 'not needed', detail: '/x' }]

describe('the journey list this run owes', () => {
  it('is a closed, non-empty, duplicate-free list', () => {
    expect(EXPECTED_JOURNEYS.length).toBeGreaterThan(0)
    const ids = EXPECTED_JOURNEYS.map((journey) => journey.id)
    expect(new Set(ids).size, 'two journeys cannot share an id').toBe(ids.length)
    for (const journey of EXPECTED_JOURNEYS) {
      expect(journey.id, 'every journey is named by a stable id').toMatch(/^[a-z0-9-]+$/)
      expect(journey.name, `journey ${journey.id} carries the sentence a human reads`).not.toBe('')
    }
  })

  it('covers the four acceptance criteria by name, so a reader can see where each is proved', () => {
    const ids = EXPECTED_JOURNEYS.map((journey) => journey.id)
    expect(ids).toContain('needs-you-blocked-row-and-pending-count')
    expect(ids).toContain('acknowledgement-clears-the-row-and-history-lists-it')
    expect(ids).toContain('interrupted-stream-shows-a-stale-state')
  })

  it('includes a negative path, which is the one that catches a product inventing state', () => {
    const ids = EXPECTED_JOURNEYS.map((journey) => journey.id)
    expect(ids).toContain('greeting-and-close-produce-nothing')
  })
})

describe('decideDashboardE2ERun', () => {
  it('passes only when every declared journey ran, passed, and the runner exited zero', () => {
    const decision = decideDashboardE2ERun({
      journeys: everyJourney(),
      runnerExitCode: 0,
      dependencies: allDependencies,
    })
    expect(decision.verdict).toBe('pass')
    expect(decision.exitCode).toBe(0)
    expect(decision.failures).toEqual([])
    expect(decision.journeysRun).toBe(EXPECTED_JOURNEYS.length)
  })

  it('fails when zero journeys ran, and says so in a way a reader can act on', () => {
    const decision = decideDashboardE2ERun({
      journeys: [],
      runnerExitCode: 0,
      dependencies: allDependencies,
    })
    expect(decision.verdict).toBe('fail')
    expect(decision.exitCode).toBe(1)
    const text = decision.failures.join('\n')
    expect(text).toMatch(/executed 0 of \d+ declared journeys/)
    // The remedy is named, not just the shortfall: the failure a person sees most
    // often is a filter, and a filter has to be removed.
    expect(text).toMatch(/--pass-with-no-tests/)
    expect(text).toMatch(/remove the filter/)
  })

  it('fails when a journey list is short, naming the one that is missing', () => {
    const all = everyJourney()
    const dropped = all[0]
    if (dropped === undefined) throw new Error('the journey list cannot be empty')
    const decision = decideDashboardE2ERun({
      journeys: all.filter((journey) => journey.id !== dropped.id),
      runnerExitCode: 0,
      dependencies: allDependencies,
    })
    expect(decision.verdict).toBe('fail')
    expect(decision.failures.join('\n')).toContain(dropped.id)
  })

  it('fails when a journey ran but did not pass', () => {
    const all = everyJourney()
    const failing = everyJourney('failed')
    const decision = decideDashboardE2ERun({
      journeys: [failing[0]!, ...all.slice(1)],
      runnerExitCode: 0,
      dependencies: allDependencies,
    })
    expect(decision.verdict).toBe('fail')
    expect(decision.failures.join('\n')).toMatch(/journey did not pass/)
  })

  it('fails when a journey was skipped rather than counting it as having run', () => {
    const all = everyJourney()
    const skipped = everyJourney('skipped')
    const decision = decideDashboardE2ERun({
      journeys: [skipped[0]!, ...all.slice(1)],
      runnerExitCode: 0,
      dependencies: allDependencies,
    })
    expect(decision.verdict).toBe('fail')
    expect(decision.failures.join('\n')).toMatch(/journey did not pass.*skipped/)
  })

  it('fails when the runner exited non-zero even though every journey reported a result', () => {
    const decision = decideDashboardE2ERun({
      journeys: everyJourney(),
      runnerExitCode: 1,
      dependencies: allDependencies,
    })
    expect(decision.verdict).toBe('fail')
    expect(decision.failures.join('\n')).toMatch(/exited 1/)
  })

  it('fails when a dependency is absent, and names the command that fixes it', () => {
    const decision = decideDashboardE2ERun({
      journeys: everyJourney(),
      runnerExitCode: 0,
      dependencies: [
        {
          name: 'playwright chromium',
          present: false,
          remedy: 'install it with `npx playwright install chromium`',
          detail: 'no Playwright-managed Chromium',
        },
      ],
    })
    expect(decision.verdict).toBe('fail')
    expect(decision.exitCode).toBe(1)
    expect(decision.failures.join('\n')).toContain('npx playwright install chromium')
  })

  it('fails a measured budget that was over, and keeps the number beside the verdict', () => {
    const decision = decideDashboardE2ERun({
      journeys: everyJourney(),
      runnerExitCode: 0,
      dependencies: allDependencies,
      observations: [
        {
          name: 'dashboard first contentful paint from a warm cache (APX-CON-11)',
          expected: '<= 1000 ms',
          actual: '1095 ms',
          measured: '1095.0',
          ok: false,
        },
      ],
    })
    expect(decision.verdict).toBe('fail')
    expect(decision.failures.join('\n')).toContain('1095')
  })

  it('passes a measurement that was inside its budget', () => {
    const decision = decideDashboardE2ERun({
      journeys: everyJourney(),
      runnerExitCode: 0,
      dependencies: allDependencies,
      observations: [
        {
          name: 'hub idle resident set (APX-CON-11)',
          expected: '<= 150 MB',
          actual: '67.8 MB',
          measured: '71092224',
          ok: true,
        },
      ],
    })
    expect(decision.verdict).toBe('pass')
  })
})

describe('the journey ledger', () => {
  it('reads a missing file as an empty ledger rather than throwing', () => {
    const ledger = readJourneyLedger(path.join(scratch, 'does-not-exist.json'))
    expect(ledger.journeys).toEqual([])
    expect(ledger.startedAt).toBeNull()
  })

  it('reads a damaged file as an empty ledger, because the finding is the shortfall', () => {
    const file = path.join(scratch, 'damaged.json')
    writeFileSync(file, '{ this is not json')
    expect(readJourneyLedger(file).journeys).toEqual([])
  })

  it('drops a record that carries no id, so a half-written line cannot look like a journey', () => {
    const file = path.join(scratch, 'partial.json')
    writeFileSync(
      file,
      JSON.stringify({ startedAt: 'now', journeys: [{ name: 'no id here' }, { id: 'a', name: 'b' }] }),
    )
    const records = ledgerAsJourneyRecords(readJourneyLedger(file))
    expect(records.map((record) => record.id)).toEqual(['a'])
  })

  it('defaults an absent outcome to unknown rather than to passed', () => {
    const file = path.join(scratch, 'outcome.json')
    writeFileSync(file, JSON.stringify({ startedAt: 'now', journeys: [{ id: 'a', name: 'b' }] }))
    expect(ledgerAsJourneyRecords(readJourneyLedger(file))[0]?.outcome).toBe('unknown')
  })

  it('carries the identity of the run that wrote it, so a caller can refuse a foreign ledger', () => {
    const file = path.join(scratch, 'run-id.json')
    writeFileSync(
      file,
      JSON.stringify({ startedAt: 'now', runId: 'run-42', journeys: [{ id: 'a', name: 'b' }] }),
    )
    expect(readJourneyLedger(file).runId).toBe('run-42')
  })

  it('reads a ledger that names no run as naming none, rather than as naming this one', () => {
    // The hole this closes: a run that collects no test writes no ledger, so the file
    // left on disk is the previous run's. Reading its journeys as this run's evidence
    // is how `--pass-with-no-tests` reported seven passed journeys for a run that
    // executed none, so a ledger without an identity has to be recognisable as one.
    const file = path.join(scratch, 'no-run-id.json')
    writeFileSync(file, JSON.stringify({ startedAt: 'now', journeys: [{ id: 'a', name: 'b' }] }))
    expect(readJourneyLedger(file).runId).toBeNull()
    expect(readJourneyLedger(path.join(scratch, 'does-not-exist.json')).runId).toBeNull()
  })
})

describe('the ledger paths the suite and the script share', () => {
  it('are the same files, and they are not the runner output directory', () => {
    expect(JOURNEY_LEDGER_PATH).toBe(path.join(repoRoot, 'test-results', 'dashboard-e2e-journeys.json'))
    expect(OBSERVATION_LEDGER_PATH).toBe(path.join(repoRoot, 'test-results', 'dashboard-e2e-observations.json'))
    // Playwright clears its output directory at the start of a run, so a ledger
    // inside it would be deleted by the run writing it.
    expect(JOURNEY_LEDGER_PATH.startsWith(path.join(repoRoot, 'test-results', 'e2e'))).toBe(false)
  })
})

describe('the command line', () => {
  it('drives the dashboard spec when it is not told otherwise', () => {
    expect(parseArgs([]).runnerArgs).toEqual([])
    expect(DEFAULT_SPEC).toBe('tests/e2e/dashboard.spec.ts')
  })

  it('hands everything after -- to the runner, and nothing before it', () => {
    const args = parseArgs(['--', 'tests/e2e/dashboard.spec.ts', '--reporter=list'])
    expect(args.runnerArgs).toEqual(['tests/e2e/dashboard.spec.ts', '--reporter=list'])
  })

  it('takes an evidence path and resolves it against the repository root', () => {
    const args = parseArgs(['--out', 'test-results/custom.json'])
    expect(args.out).toBe(path.join(repoRoot, 'test-results', 'custom.json'))
  })

  it('passes a bare spec path straight through', () => {
    expect(parseArgs(['tests/e2e/dashboard.spec.ts']).runnerArgs).toEqual(['tests/e2e/dashboard.spec.ts'])
  })
})

describe('the config this script depends on', () => {
  it('exists, collects only *.spec.ts from tests/e2e, and always forbids .only', () => {
    const config = readConfigCode()
    expect(config).toContain("testDir: './tests/e2e'")
    expect(config).toContain("testMatch: '**/*.spec.ts'")
    expect(config).toContain('forbidOnly: true')
    // A global setup or a runner-owned web server would mean the hub was not
    // started by the suite's own fixture against a temporary state directory.
    expect(config).not.toContain('globalSetup')
    expect(config).not.toContain('webServer')
  })

  it('hands the zero-journey judgement to a teardown, so `npm test -- tests/e2e/...` fails too', () => {
    expect(readConfigCode()).toContain('globalTeardown: ')
  })

  it('does not bypass the content-security policy the run is proving', () => {
    expect(readConfigCode()).not.toContain('bypassCSP')
  })

  it('exists on disk where the preflight looks for it', () => {
    expect(existsSync(path.join(repoRoot, 'playwright.config.ts'))).toBe(true)
  })
})

describe('the spec this script drives', () => {
  it('declares a runner for every journey, so the two files cannot drift apart silently', () => {
    const spec = readSpecCode()
    for (const journey of EXPECTED_JOURNEYS) {
      expect(spec, `the spec has a runner for ${journey.id}`).toContain(`'${journey.id}': async (page) =>`)
    }
  })

  it('never stands up a server of its own, so no journey can be proved against a mock', () => {
    const spec = readSpecCode()
    expect(spec).not.toMatch(/\bsetContent\(|route\(|createServer\(|page\.route/)
  })

  it('intercepts no request, so every answer it reads came from the product', () => {
    const spec = readSpecCode()
    expect(spec).not.toContain('page.route')
    expect(spec).not.toContain('fulfill(')
  })
})
