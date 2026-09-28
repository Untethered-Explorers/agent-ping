// The verification script's contract for the TypeScript side of the repository.
//
// scripts/verify-dashboard-e2e.mjs is plain JavaScript with no build step, so
// nothing about it is inferred for a .ts file that imports it. Three files here do:
// the browser spec (tests/e2e/dashboard.spec.ts), the Playwright teardown
// (tests/e2e/global-teardown.ts) and the judgement's own suite
// (tests/scripts/verify-dashboard-e2e.test.ts).
//
// They import it for one reason each, and the reason is the same in all three: the
// journey list, the ledger paths and the pass/fail judgement must have exactly one
// home. A copy in a TypeScript file could be edited to agree with whatever the last
// run printed, and a run that proved nothing would then look like a run that
// proved something. So the declaration below is the script's exports stated once,
// and the suite asserts against them rather than against a restatement.
//
// What is deliberately not here: anything internal. The shell's side effects, the
// preflight and the browser acquisition are the script's own, and a TypeScript
// caller reaching for them would be reaching past the contract the judgement is
// written behind.

/** How the served document compares with the build it was copied from. */
export interface DocumentServedAs {
  readonly builtFrom: string
  readonly servedFrom: string
  readonly builtBytes: number
  readonly servedBytes: number
  /** The exact inserted line, indentation and newline included. */
  readonly insertedLine: string
  /** The same element without its indentation. */
  readonly insertedElement: string
  readonly identicalToBuildApartFromTheInsertedLine: boolean
  readonly whySubstituted: string
}

/** One journey this run owes, and the sentence a human reads beside it. */
export interface ExpectedJourney {
  readonly id: string
  readonly name: string
}

/**
 * The closed list of journeys, in run order.
 *
 * `tests/e2e/dashboard.spec.ts` generates one test per entry, so a declared
 * journey with no runner is a collection-time failure and a runner with no
 * declaration is one too.
 */
export const EXPECTED_JOURNEYS: readonly ExpectedJourney[]

/** Where the suite records which journeys ran, and this script reads them back. */
export const JOURNEY_LEDGER_PATH: string

/** Where the suite records what it measured, and this script judges it. */
export const OBSERVATION_LEDGER_PATH: string

/** The spec this run drives when the command line names none. */
export const DEFAULT_SPEC: string

/** A dependency, and the command that makes it present. */
export interface Dependency {
  readonly name: string
  readonly present: boolean
  readonly remedy: string
  readonly detail: string
}

/** One journey as the suite's ledger recorded it. */
export interface JourneyRecord {
  readonly id: string
  readonly name: string
  /** `passed`, `failed` or `skipped`, as the runner reported the test. */
  readonly outcome: string
  readonly durationMs: number
  readonly at: string
}

/** One measured fact, and the verdict on it. */
export interface Observation {
  readonly name: string
  readonly expected: string
  readonly actual: string
  /** The measured figure itself, when there is one. */
  readonly measured?: string
  /** Present for a measurement rather than a string equality. */
  readonly ok?: boolean
}

/** Everything the judgement is given. */
export interface DashboardE2EInput {
  readonly journeys: readonly JourneyRecord[]
  readonly runnerExitCode: number
  readonly dependencies: readonly Dependency[]
  readonly observations?: readonly Observation[]
  readonly browser?: { readonly kind: string; readonly detail: string }
}

/** The answer, and the reason for it. */
export interface DashboardE2EDecision {
  readonly verdict: 'pass' | 'fail'
  readonly exitCode: number
  readonly failures: readonly string[]
  readonly journeysRun: number
  readonly journeysExpected: number
  /** Every declared journey, with the ones that produced no result marked. */
  readonly journeys: readonly {
    readonly id: string
    readonly name: string
    readonly outcome: string
    readonly missing: boolean
  }[]
}

/**
 * Did this run prove the dashboard journey?
 *
 * Pure: no process, no filesystem, no network and no clock. That is what lets
 * `tests/scripts/verify-dashboard-e2e.test.ts` drive it with an empty journey list
 * on a machine with no browser at all.
 */
export function decideDashboardE2ERun(input: DashboardE2EInput): DashboardE2EDecision

/** The ledger as it is on disk. A missing or damaged file is an empty one. */
export interface JourneyLedger {
  readonly startedAt: string | null
  /**
   * The identity of the run that wrote the file (`E2E_RUN_ID`, carried through the
   * environment from playwright.config.ts), or null when the file says nothing.
   * A caller inside a run compares it with its own rather than trusting the file to
   * be about the run that is asking.
   */
  readonly runId: string | null
  readonly journeys: readonly {
    readonly id: string
    readonly name: string
    readonly outcome?: string
    readonly durationMs?: number
    readonly at?: string
  }[]
}

/** Read the ledger. A damaged file is an empty ledger, not an exception. */
export function readJourneyLedger(file?: string): JourneyLedger

/** Narrow a ledger to the shape the judgement reads. */
export function ledgerAsJourneyRecords(ledger: JourneyLedger): JourneyRecord[]

/** The parsed command line. */
export interface ParsedArgs {
  readonly out: string
  readonly runnerArgs: string[]
  readonly help?: boolean
}

/** Everything after `--` is handed to the runner; nothing before it is. */
export function parseArgs(argv: readonly string[]): ParsedArgs
