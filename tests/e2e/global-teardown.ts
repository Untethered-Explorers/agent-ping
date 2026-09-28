// The half of "a green result cannot mean nothing was exercised" that lives inside
// the Playwright run itself (LD-4).
//
// WHY THIS EXISTS
// `playwright test` exits 0 for a run that collected tests and executed none of
// them, and it exits 0 for a run whose every test was skipped. Both are the
// failure this feature's acceptance criterion names: a green result with an empty
// journey list. This teardown reads the ledger the suite writes, prints every
// journey that ran, and fails the run when the list is short of the journeys the
// product owes.
//
// scripts/verify-dashboard-e2e.mjs makes the same judgement around the runner, so
// `npm run test:e2e` and `node scripts/verify-dashboard-e2e.mjs` cannot disagree
// about whether a run proved anything. Two judges, one list.
//
// WHAT IT DELIBERATELY DOES NOT DO
// It does not re-judge the assertions. Playwright already did that, and its exit
// code is the authority on whether a journey passed; this teardown answers a
// different question - whether the journeys that owed an answer gave one.

import { existsSync } from 'node:fs'

interface JourneyRecord {
  readonly id: string
  readonly name: string
  readonly outcome: string
  readonly durationMs: number
  readonly at: string
}

// The journey list and the judgement are imported from the verification script
// rather than restated here, and its declarations live beside it. They must have
// exactly one home: a copy in this file could be edited to agree with whatever the
// last run printed, and the runner and the script would then be able to disagree
// about whether a run proved anything (LD-4).
import {
  decideDashboardE2ERun,
  readJourneyLedger,
  ledgerAsJourneyRecords,
  JOURNEY_LEDGER_PATH,
} from '../../scripts/verify-dashboard-e2e.mjs'
import { E2E_RUN_ID } from '../../playwright.config'

/**
 * The ledger as *this* run's evidence, or an empty one.
 *
 * A ledger that names a different run is not a shortfall in the middle of a run that
 * proved something; it is the previous run's file, left on disk because this run
 * collected no test to overwrite it. Reading it as evidence is how
 * `playwright test --pass-with-no-tests` with a filter matching nothing would report
 * seven passed journeys for a run that executed none - so the comparison is made
 * here and a foreign ledger is discarded rather than counted.
 */
function thisRunsLedger(): { journeys: JourneyRecord[]; foreign: string | null } {
  const ledger = readJourneyLedger(JOURNEY_LEDGER_PATH)
  if (ledger.runId === E2E_RUN_ID) {
    return { journeys: ledgerAsJourneyRecords(ledger), foreign: null }
  }
  return {
    journeys: [],
    foreign: ledger.runId ?? '(no run id)',
  }
}

export default async function globalTeardown(): Promise<void> {
  const { journeys, foreign } = thisRunsLedger()
  if (foreign !== null) {
    process.stderr.write(
      `[dashboard-e2e] the journey ledger on disk belongs to another run (${foreign}), not to this run ` +
        `(${E2E_RUN_ID}). A run that collects no test writes no ledger, so this is what is left over; ` +
        "it is not evidence about this run and is not read as any.\n",
    )
  }
  const decision = decideDashboardE2ERun({
    journeys,
    // The runner's own exit code is not visible from here, and this teardown does
    // not need it: it asks only whether every declared journey produced a result.
    // A journey that ran and failed is reported by the runner, and this teardown
    // prints it as `failed` rather than counting it as having run and passed.
    runnerExitCode: 0,
    dependencies: [],
    observations: [],
  })

  const report = [
    '',
    '[dashboard-e2e] journeys that ran',
    ...decision.journeys.map(
      (journey) =>
        `  ${journey.outcome === 'passed' ? 'passed  ' : journey.outcome.padEnd(8)} ${journey.id}: ${journey.name}`,
    ),
    `[dashboard-e2e] ${String(decision.journeysRun)} of ${String(decision.journeysExpected)} declared journeys produced a result`,
    '',
  ].join('\n')
  process.stderr.write(`${report}\n`)

  const shortfalls = decision.failures.filter(
    (failure) => !failure.startsWith('journey did not pass'),
  )
  if (shortfalls.length === 0) return

  // Recorded before the throw, because the throw is what a person sees first and
  // it should not be the only place the reason is written down.
  const evidence = `${JOURNEY_LEDGER_PATH} (${existsSync(JOURNEY_LEDGER_PATH) ? 'present' : 'absent'})`
  process.stderr.write(
    `[dashboard-e2e] FAILED: ${shortfalls.length} declared journey(s) produced no result.\n` +
      `[dashboard-e2e] ${shortfalls.map((failure) => `  - ${failure}`).join('\n')}\n` +
      `[dashboard-e2e] the journey ledger is ${evidence}.\n` +
      '[dashboard-e2e] A run in which no journey executed proves nothing and is not a pass. If a filter ' +
      'or a rename emptied the list, remove the filter; do not pass --pass-with-no-tests.\n',
  )
  throw new Error(
    `the browser suite executed ${String(decision.journeysRun)} of ` +
      `${String(decision.journeysExpected)} declared journeys`,
  )
}
