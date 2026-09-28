#!/usr/bin/env node
// Prove the dashboard's primary journey in a real browser against the real hub
// (LD-4: LD-FR-03, LD-FR-05, LD-FR-09, LD-FR-10, APX-CON-11).
//
//   node scripts/verify-dashboard-e2e.mjs
//   node scripts/verify-dashboard-e2e.mjs --out test-results/dashboard-e2e-evidence.json
//   node scripts/verify-dashboard-e2e.mjs -- tests/e2e/dashboard.spec.ts --reporter=list
//
// THE CLAIM, IN THREE SENTENCES, BEFORE ANY CODE
//
//   positive   Against a real hub serving the real built dashboard over its own
//              loopback origin, a needs-you event driven through the product's
//              own ingest route becomes a blocked row, the pending count goes up,
//              a keyboard-only path reaches and activates that row, acknowledging
//              it clears it, and the history panel then lists it. A stream that
//              is interrupted makes the page say so. A deep link built the way the
//              card and the tray build it opens focused on the right session.
//   negative   A session that opens, greets and closes produces no event, no row
//              and no pending change at any point in the run. This is the
//              anti-noise proof: a page that invents a row is the failure the
//              whole feature exists to avoid (ADR-004, LD-FR-02).
//   failure    A Playwright browser that cannot be obtained, a build that is not
//              present, or a run in which zero journeys executed is a non-zero
//              exit naming what was absent and how to obtain it. It is never a
//              skip, and it is never a pass with an empty journey list.
//
// WHY A SCRIPT AROUND THE PLAYWRIGHT RUNNER
// Two reasons, and both are about the honesty of a green result:
//
//   1. `playwright test` exits 0 for a run that collected tests and ran none of
//      them. This script reads the journey ledger the suite writes, and a run
//      whose journey list is short is a failure with the shortfall named - so
//      `--grep`, a renamed test and a spec that stopped collecting all fail
//      loudly instead of producing a green that proves nothing.
//   2. The browser is a dependency this script acquires. It installs the
//      Playwright-managed Chromium when it is missing, falls back to a system
//      Chrome when the download is blocked (a different recorded path, not a
//      skip), and exits non-zero when neither is obtainable.
//
// WHAT IS THE PRODUCT'S AND WHAT IS THIS SCRIPT'S
// Everything the journeys observe is the product's: the real composition root in
// a real operating-system process, the real runtime-file lock, the real durable
// store, the real route registry, the real ingest classifier, the real change
// feed, the real ack boundary, the real static route and the real
// content-security policy, and the real `dist/dashboard` build. This script
// writes one evidence file, starts one child process and runs one test runner.
// The single seam the journeys need - the write token the page reads from a
// `<meta>` element the product deliberately does not serve (HC-FR-06) - is
// supplied by tests/e2e/hub-fixture.ts, and the comparison between the served
// document and the build is part of the evidence rather than a promise in a
// comment.
//
// SHAPE, PER THE LIVE-VERIFICATION DISCIPLINE
//
//   scripts/verify-dashboard-e2e.mjs           the journey list, the pure
//                                              judgement and the ledger reader,
//                                              exported, plus a thin shell that
//                                              owns every side effect
//   tests/scripts/verify-dashboard-e2e.test.ts drives `decideDashboardE2ERun`
//                                              with injected values, so the
//                                              judgement is verified with no
//                                              browser installed at all
//   tests/e2e/global-teardown.ts               the same judgement inside the
//                                              Playwright run, which is what
//                                              makes `npm test -- tests/e2e/...`
//                                              fail on an empty journey list too
//
// WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
// It changes no product code and no product configuration. A product defect it
// finds is recorded as a required change, not patched here. It makes no claim
// about how the page looks to a person: no human reads the page in this run, and
// the design verdicts are docs/reviews/live-dashboard.json's work (LD-5).

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT_NAME = 'verify-dashboard-e2e'

/**
 * Every journey this run must execute, by id and by name.
 *
 * One list, read by the suite (which asserts its own title against it), by the
 * Playwright teardown (which fails a short run) and by this script (which prints
 * it). Three readers of one list is the point: a list that only the script read
 * could be edited without changing what ran.
 */
export const EXPECTED_JOURNEYS = Object.freeze([
  {
    id: 'served-build-on-the-loopback-origin',
    name: 'the hub serves the built dashboard on the loopback origin and the page mounts live',
  },
  {
    id: 'needs-you-blocked-row-and-pending-count',
    name: 'a real ingested needs-you event produces a blocked row and an incremented pending count',
  },
  {
    id: 'keyboard-only-reach-and-activate',
    name: 'a keyboard-only path reaches and activates the blocked row',
  },
  {
    id: 'acknowledgement-clears-the-row-and-history-lists-it',
    name: 'acknowledging clears the row and the history panel then lists it',
  },
  {
    id: 'interrupted-stream-shows-a-stale-state',
    name: 'an interrupted stream shows a stale state rather than stale data presented as current',
  },
  {
    id: 'deep-link-focuses-its-session-and-survives-a-live-update',
    name: 'a deep link built the way the card and the tray build it opens focused on the expected session',
  },
  {
    id: 'greeting-and-close-produce-nothing',
    name: 'a session that opens, greets and closes produces no event and no row',
  },
])

/** Where the suite records what ran, and this script reads it back. */
export const JOURNEY_LEDGER_PATH = path.join(repoRoot, 'test-results', 'dashboard-e2e-journeys.json')

/**
 * Where the suite records what it *observed* outside a pass/fail.
 *
 * Separate from the journey ledger because the two answer different questions.
 * The ledger says which journeys executed; the observations say what a browser run
 * measured about the page and the hub that the journeys assert nothing about - the
 * APX-CON-11 budgets, and the served-document comparison. They are judged here so
 * that a measurement cannot be recorded and then quietly ignored.
 */
export const OBSERVATION_LEDGER_PATH = path.join(
  repoRoot,
  'test-results',
  'dashboard-e2e-observations.json',
)

/** The spec this run drives when it is not told otherwise. */
export const DEFAULT_SPEC = 'tests/e2e/dashboard.spec.ts'

/** The browser the journeys drive, and what to do when it is not there. */
export const MANAGED_BROWSER = 'chromium'
/** The system browser used when the Playwright download is blocked. */
export const SYSTEM_BROWSER_CHANNEL = 'chrome'
/** How the runner names the channel for the config to read. */
export const BROWSER_CHANNEL_ENV = 'AGENT_PING_E2E_BROWSER_CHANNEL'
/** The run identity this script chooses and the workers inherit (E2E_RUN_ID_ENV). */
export const RUN_ID_ENV = 'AGENT_PING_E2E_RUN_ID'

/** System Chrome candidates, in the order they are tried. */
const SYSTEM_CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

// ---------------------------------------------------------------------------
// The judgement. Pure: no process, no filesystem, no network, no clock.
// ---------------------------------------------------------------------------

// The shapes below are JSDoc typedefs rather than TypeScript `interface`
// declarations, because this file is plain JavaScript: it is run by `node` with no
// build step and no type stripping. The types the three TypeScript callers see are
// declared once, beside this file, in scripts/verify-dashboard-e2e.d.mts - so the
// contract is stated in both places and neither is a second answer to "did this run
// prove anything".

/**
 * One dependency, and what to do when it is absent.
 *
 * @typedef {object} Dependency
 * @property {string} name
 * @property {boolean} present
 * @property {string} remedy
 * @property {string} detail What was actually found, for the record.
 */

/**
 * One journey as the suite recorded it.
 *
 * @typedef {object} JourneyRecord
 * @property {string} id
 * @property {string} name
 * @property {string} outcome `passed`, `failed` or `skipped`, as the runner reported the test.
 * @property {number} durationMs
 * @property {string} at
 */

/**
 * One observation the shell or the suite made, and the verdict on it.
 *
 * Two ways to say the same thing, and the second exists for a measurement: a
 * measured budget is not a string equality. `ok` is the judgement and `actual` and
 * `measured` are the evidence beside it, so a reader can re-check the number rather
 * than trust the verdict.
 *
 * @typedef {object} Observation
 * @property {string} name
 * @property {string} expected
 * @property {string} actual
 * @property {string} [measured] The measured figure itself, when there is one.
 * @property {boolean} [ok] Present for a measurement rather than a string equality.
 */

/**
 * Everything the judgement is given.
 *
 * @typedef {object} DashboardE2EInput
 * @property {readonly JourneyRecord[]} journeys The journeys the suite's ledger recorded.
 * @property {number} runnerExitCode The exit code the browser run produced.
 * @property {readonly Dependency[]} dependencies
 * @property {readonly Observation[]} [observations] Extra facts judged outside the runner.
 * @property {{ kind: string, detail: string }} [browser] The browser that drove the run.
 */

/**
 * The answer, and the reason for it.
 *
 * @typedef {object} DashboardE2EDecision
 * @property {'pass' | 'fail'} verdict
 * @property {number} exitCode
 * @property {readonly string[]} failures
 * @property {number} journeysRun
 * @property {number} journeysExpected
 * @property {readonly { id: string, name: string, outcome: string, missing: boolean }[]} journeys
 *   Every journey that ran, and every journey that did not, by name.
 */

/**
 * @typedef {object} JourneyLedger
 * @property {string | null} startedAt
 * @property {readonly { id: string, name: string, outcome?: string, durationMs?: number, at?: string }[]} journeys
 */

/**
 * @typedef {object} ParsedArgs
 * @property {string} out
 * @property {string[]} runnerArgs
 * @property {boolean} [help]
 */

/**
 * Did this run prove the dashboard journey?
 *
 * Three independent ways to answer no, and each one is checked before any
 * journey's own outcome is looked at, because a run that proved nothing must not
 * be rescued by a subset that happened to pass:
 *
 *   - a dependency that is not present, named with the command that fixes it
 *   - a journey list shorter than the closed list of journeys this run owes
 *   - a runner exit code that is not zero
 *
 * And one more, for the case the shorter list does not cover: a journey that
 * ran but did not pass.
 */
export function decideDashboardE2ERun(input) {
  const failures = []
  const observations = input.observations ?? []

  for (const dependency of input.dependencies) {
    if (dependency.present) continue
    failures.push(
      `required dependency unavailable: ${dependency.name}. ${dependency.remedy} ` +
        `(found: ${dependency.detail})`,
    )
  }

  const byId = new Map(input.journeys.map((journey) => [journey.id, journey]))
  const journeys = EXPECTED_JOURNEYS.map((expected) => {
    const found = byId.get(expected.id)
    return {
      id: expected.id,
      name: expected.name,
      outcome: found === undefined ? 'did-not-run' : found.outcome,
      missing: found === undefined,
    }
  })

  // The shortfall is one failure naming every journey that produced no result, and
  // not one failure per missing journey: seven copies of the same sentence is noise,
  // and the first of them is the one a reader would act on.
  const missing = journeys.filter((journey) => journey.missing)
  if (missing.length > 0) {
    failures.push(
      `executed ${String(input.journeys.length)} of ${String(EXPECTED_JOURNEYS.length)} declared journeys; ` +
        `these produced no result: ${missing.map((journey) => journey.id).join(', ')}. A green result that ` +
        'exercised nothing is not a pass - a filter, a rename or a spec that stopped collecting all land ' +
        'here, and the remedy is to remove the filter rather than to pass --pass-with-no-tests (LD-4)',
    )
  }

  for (const journey of journeys) {
    if (journey.missing) continue
    if (journey.outcome !== 'passed') {
      failures.push(
        `journey did not pass: ${journey.id} (${journey.name}) - ${journey.outcome}. Its own output above ` +
          'names the assertion',
      )
    }
  }

  if (input.runnerExitCode !== 0) {
    failures.push(
      `the browser suite exited ${String(input.runnerExitCode)}. Its own output above names the ` +
        'journey and the assertion; this script does not restate or soften it',
    )
  }

  for (const observation of observations) {
    const passed = observation.ok === undefined ? observation.expected === observation.actual : observation.ok
    if (passed) continue
    const measured =
      observation.measured === undefined
        ? ''
        : ` (measured ${observation.measured}, expected ${observation.expected}, actual ${observation.actual})`
    failures.push(
      observation.measured === undefined
        ? `${observation.name}: expected ${observation.expected}, observed ${observation.actual}`
        : `${observation.name}: over budget${measured}`,
    )
  }

  return {
    verdict: failures.length === 0 ? 'pass' : 'fail',
    exitCode: failures.length === 0 ? 0 : 1,
    failures,
    journeysRun: input.journeys.length,
    journeysExpected: EXPECTED_JOURNEYS.length,
    journeys,
  }
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/** An empty ledger. Also what a missing or unreadable file is read as. */
export const EMPTY_LEDGER = Object.freeze({ startedAt: null, runId: null, journeys: [] })

/**
 * What the suite recorded, read as a whole.
 *
 * `runId` is the identity of the run that wrote the file (E2E_RUN_ID, carried
 * through the environment from playwright.config.ts). A caller that is inside a run
 * compares it with its own, and a ledger from a previous run is not evidence about
 * this one: a run that collected no tests writes no ledger at all, and reading the
 * leftover file would report a green run that exercised nothing.
 *
 * A missing or damaged file is an empty ledger rather than an error: the caller's
 * job is to notice that zero journeys ran, and an exception thrown here would let
 * a run report a crash where the real finding is a shortfall.
 */
export function readJourneyLedger(file = JOURNEY_LEDGER_PATH) {
  if (!existsSync(file)) return { ...EMPTY_LEDGER, journeys: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const journeys = Array.isArray(parsed?.journeys) ? parsed.journeys : []
    return {
      startedAt: typeof parsed?.startedAt === 'string' ? parsed.startedAt : null,
      runId: typeof parsed?.runId === 'string' ? parsed.runId : null,
      journeys: journeys.filter((entry) => typeof entry?.id === 'string' && typeof entry?.name === 'string'),
    }
  } catch {
    return { ...EMPTY_LEDGER, journeys: [] }
  }
}

/** The ledger as this script saw it, narrowed to what the judgement reads. */
export function ledgerAsJourneyRecords(ledger) {
  return ledger.journeys.map((journey) => ({
    id: journey.id,
    name: journey.name,
    outcome: typeof journey.outcome === 'string' ? journey.outcome : 'unknown',
    durationMs: typeof journey.durationMs === 'number' ? journey.durationMs : 0,
    at: typeof journey.at === 'string' ? journey.at : '',
  }))
}

// ---------------------------------------------------------------------------
// The shell's impure half
// ---------------------------------------------------------------------------

const log = (message) => process.stderr.write(`${message}\n`)
const emit = (summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)

function run(command, args, label) {
  log(`\n[dashboard-e2e] ${label}: ${path.basename(command)} ${args.join(' ')}`)
  // Both of the child's streams go to fd 2, so stdout carries the JSON summary
  // and nothing else. Mixing a runner's progress into the summary is what makes
  // an evidence file unparseable.
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: ['ignore', 2, 2] })
  if (result.error) {
    log(`[dashboard-e2e] ${label} could not start: ${result.error.message}`)
    return 1
  }
  if (result.signal) {
    log(`[dashboard-e2e] ${label} was terminated by signal ${result.signal}`)
    return 1
  }
  return result.status ?? 1
}

const bin = (name) =>
  path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)

/** Parse the command line. Everything after `--` is handed to the runner. */
export function parseArgs(argv) {
  const args = { out: path.join(repoRoot, 'test-results', 'dashboard-e2e-evidence.json'), runnerArgs: [] }
  let index = 0
  while (index < argv.length) {
    const argument = argv[index]
    if (argument === '--') {
      args.runnerArgs = argv.slice(index + 1)
      break
    }
    if (argument === '--out') {
      args.out = path.resolve(repoRoot, argv[index + 1] ?? args.out)
      index += 2
      continue
    }
    if (argument === '--help' || argument === '-h') {
      args.help = true
      index += 1
      continue
    }
    args.runnerArgs.push(argument)
    index += 1
  }
  return args
}

const USAGE = `node scripts/verify-dashboard-e2e.mjs [--out <file>] [-- <playwright args>]

  --out <file>   where the JSON evidence is written (default test-results/dashboard-e2e-evidence.json)
  -- <args>      arguments handed straight to the Playwright runner; with none, ${DEFAULT_SPEC} is driven
`

/**
 * The Playwright-managed Chromium's own path, or null when it is not installed.
 *
 * Resolved through the module Playwright itself uses, so the answer is the
 * browser version this checkout would launch rather than a directory in a cache
 * this file guessed at.
 */
function managedBrowserPath() {
  try {
    const require = createRequire(import.meta.url)
    const { chromium } = require('playwright-core')
    const executable = chromium.executablePath()
    return existsSync(executable) ? executable : null
  } catch {
    return null
  }
}

function findSystemChrome() {
  for (const candidate of SYSTEM_CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** How the install step is named in this script's own progress lines. */
const MANAGED_BROWSER_LABEL = 'the Playwright browser'

/**
 * Obtain a browser, or say what is missing and how to get it.
 *
 * Three answers, in order, and never a skip:
 *
 *   1. the Playwright-managed Chromium is already there - use it
 *   2. it is not, so install it; a successful install is the normal path on a
 *      fresh checkout, and a failed one is a real failure with a real remedy
 *   3. the download is blocked, so a system Chrome is used instead. That is a
 *      different recorded path with its own provenance in the evidence, not a
 *      quieter version of the same claim.
 *
 * If none of the three produces a browser the answer is a non-zero exit. There is
 * no fourth option, and in particular no "run without a browser".
 */
function acquireBrowser() {
  const already = managedBrowserPath()
  if (already !== null) {
    return { dependency: satisfied('playwright chromium', already), browser: { kind: 'playwright', detail: already } }
  }

  log('[dashboard-e2e] the Playwright browser is not installed; installing chromium now')
  const installed = run(
    bin('playwright'),
    ['install', MANAGED_BROWSER],
    `install ${MANAGED_BROWSER_LABEL}`,
  )
  const afterInstall = managedBrowserPath()
  if (afterInstall !== null) {
    return { dependency: satisfied('playwright chromium', afterInstall), browser: { kind: 'playwright', detail: afterInstall } }
  }

  const system = findSystemChrome()
  if (system !== null) {
    log(
      '[dashboard-e2e] the Playwright download did not produce a browser; falling back to the system ' +
        `Chrome at ${system}. This is a different recorded path: the run drives that binary, not the ` +
        'Playwright build.',
    )
    process.env[BROWSER_CHANNEL_ENV] = SYSTEM_BROWSER_CHANNEL
    return {
      dependency: satisfied('playwright chromium', `not installed; using the system Chrome at ${system}`),
      browser: { kind: 'system-chrome', detail: system },
    }
  }

  return {
    dependency: {
      name: 'playwright chromium',
      present: false,
      remedy:
        'install it with `npx playwright install chromium` (which is what this script already tried, ' +
        'exit ' +
        String(installed) +
        '), or install Google Chrome so the recorded system-browser path becomes available. ' +
        'This run does not skip: no browser means no journey can be driven',
      detail: `no Playwright-managed Chromium and no system Chrome in ${SYSTEM_CHROME_CANDIDATES.join(', ')}`,
    },
    browser: undefined,
  }
}

function satisfied(name, detail) {
  return { name, present: true, remedy: 'not needed', detail }
}

function preflight() {
  const dependencies = [
    {
      name: '@playwright/test',
      present: existsSync(path.join(repoRoot, 'node_modules', '@playwright', 'test', 'package.json')),
      remedy: 'run `npm install` in the repository root; @playwright/test is a devDependency (DP-1)',
      detail: path.join(repoRoot, 'node_modules', '@playwright', 'test'),
    },
    {
      name: 'the Playwright config',
      present: existsSync(path.join(repoRoot, 'playwright.config.ts')),
      remedy: 'playwright.config.ts is this suite’s configuration; without it nothing is collected',
      detail: path.join(repoRoot, 'playwright.config.ts'),
    },
    {
      name: 'the built dashboard',
      present: existsSync(path.join(repoRoot, 'dist', 'dashboard', 'index.html')),
      remedy:
        'run `npm run build` in the repository root. This run serves the build and the real static ' +
        'route; it does not build the page itself, because a run that built the artefact it then ' +
        'proved would be proving a second build',
      detail: path.join(repoRoot, 'dist', 'dashboard', 'index.html'),
    },
  ]
  return dependencies
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) process.exit(await main(process.argv.slice(2)))

/**
 * Acquire, run, judge, report.
 *
 * The dependency failure emits its own summary and exits before the runner is
 * ever started, so it can never reach the pass path.
 */
export async function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    log(USAGE)
    return 0
  }
  const startedAt = new Date().toISOString()

  let dependencies = preflight()
  const blocked = dependencies.filter((dependency) => !dependency.present)
  if (blocked.length > 0) {
    const decision = decideDashboardE2ERun({
      journeys: [],
      runnerExitCode: 0,
      dependencies,
      observations: [],
    })
    emit({
      script: SCRIPT_NAME,
      verdict: decision.verdict,
      exitCode: decision.exitCode,
      startedAt,
      finishedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      playwrightVersion: readPackageVersion('@playwright/test'),
      browser: null,
      dependencies,
      assertionsRun: decision.journeysRun,
      assertionsExpected: decision.journeysExpected,
      journeys: decision.journeys,
      failures: decision.failures,
      evidence: args.out,
      evidenceWritten: false,
    })
    for (const failure of decision.failures) log(`FAIL ${failure}`)
    log('[dashboard-e2e] no journey ran. This is a failed run, not a skipped one.')
    return decision.exitCode
  }

  const acquired = acquireBrowser()
  dependencies = [...dependencies, acquired.dependency]
  if (acquired.dependency.present !== true) {
    const decision = decideDashboardE2ERun({
      journeys: [],
      runnerExitCode: 0,
      dependencies,
      observations: [],
    })
    emit({
      script: SCRIPT_NAME,
      verdict: decision.verdict,
      exitCode: decision.exitCode,
      startedAt,
      finishedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      playwrightVersion: readPackageVersion('@playwright/test'),
      browser: null,
      dependencies,
      assertionsRun: decision.journeysRun,
      assertionsExpected: decision.journeysExpected,
      journeys: decision.journeys,
      failures: decision.failures,
      evidence: args.out,
      evidenceWritten: false,
    })
    for (const failure of decision.failures) log(`FAIL ${failure}`)
    log(
      '[dashboard-e2e] the browser could not be obtained, so no journey was driven. ' +
        'A green result that exercised nothing is not a pass, and this run does not report one.',
    )
    return decision.exitCode
  }

  const target = args.runnerArgs.length > 0 ? args.runnerArgs : [DEFAULT_SPEC]
  // This script chooses the run's identity before the runner starts, so that the
  // ledger the run writes can be told from the one the previous run left on disk. A
  // run that collects nothing writes no ledger at all, and without this the leftover
  // file would be read as that run's seven passed journeys.
  const runId = `verify-${String(process.pid)}-${Date.now().toString(36)}`
  process.env[RUN_ID_ENV] = runId
  log(`[dashboard-e2e] driving ${EXPECTED_JOURNEYS.length} declared journeys through: ${target.join(' ')}`)
  const runnerExitCode = run(bin('playwright'), ['test', ...target], 'browser suite')

  const ledger = readJourneyLedger()
  const foreignLedger = ledger.runId !== null && ledger.runId !== runId ? ledger.runId : null
  if (foreignLedger !== null) {
    log(
      `[dashboard-e2e] the journey ledger on disk belongs to another run (${foreignLedger}), not to this ` +
        `one (${runId}). A run that collects no test writes no ledger, so this is what is left over; it is ` +
        'not evidence about this run and is not read as any.',
    )
  }
  const journeys = foreignLedger === null ? ledgerAsJourneyRecords(ledger) : []
  const observations = foreignLedger === null ? readObservations() : []
  const decision = decideDashboardE2ERun({
    journeys,
    runnerExitCode,
    dependencies,
    observations,
    browser: acquired.browser,
  })

  const summary = {
    script: SCRIPT_NAME,
    verdict: decision.verdict,
    exitCode: decision.exitCode,
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    playwrightVersion: readPackageVersion('@playwright/test'),
    browser: acquired.browser ?? null,
    runnerExitCode,
    dependencies,
    assertionsRun: decision.journeysRun,
    assertionsExpected: decision.journeysExpected,
    journeys: decision.journeys,
    journeyLedger: {
      file: JOURNEY_LEDGER_PATH,
      startedAt: ledger.startedAt,
      runId: ledger.runId,
      runIdExpected: runId,
      runIdMatched: foreignLedger === null,
      journeys,
    },
    observations,
    failures: decision.failures,
    evidence: args.out,
    evidenceWritten: true,
  }
  const artefact = writeEvidence(args.out, summary)
  emit(summary)
  log(`[dashboard-e2e] evidence written to ${artefact}`)
  for (const journey of decision.journeys) {
    log(`[dashboard-e2e]   ${journey.outcome === 'passed' ? 'ran  ' : 'MISS '} ${journey.id}: ${journey.name}`)
  }
  for (const failure of decision.failures) log(`[dashboard-e2e] FAIL ${failure}`)
  if (decision.verdict === 'fail') {
    log(
      `[dashboard-e2e] ${String(decision.journeysRun)} of ${String(decision.journeysExpected)} declared ` +
        'journeys passed. See the failures above.',
    )
  } else {
    log(`[dashboard-e2e] all ${String(decision.journeysExpected)} declared journeys passed.`)
  }
  return decision.exitCode === 0 ? runnerExitCode : decision.exitCode
}

/**
 * The shell's own observations, read from the file the suite wrote beside the
 * ledger. They are the facts a browser run can make about the *page* without a
 * test failing on them, and they are judged here rather than nowhere.
 */
function readObservations() {
  if (!existsSync(OBSERVATION_LEDGER_PATH)) return []
  try {
    const parsed = JSON.parse(readFileSync(OBSERVATION_LEDGER_PATH, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeEvidence(file, summary) {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`)
    return file
  } catch (cause) {
    log(`[dashboard-e2e] the evidence file could not be written: ${cause?.message ?? String(cause)}`)
    return file
  }
}

/** A dependency's installed version, or null. The summary cannot be re-checked without it. */
function readPackageVersion(name) {
  try {
    const file = path.join(repoRoot, 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8')).version ?? null
  } catch {
    return null
  }
}
