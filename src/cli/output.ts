// The terminal format. Every line every command prints goes through this module
// (IO-FR-02..05, and §4 of the install/operations feature: "the product's whole user
// interface here is terminal output, and it is treated as one").
//
// WHAT "TREATED AS ONE" MEANS IN CODE
// Three properties, each of which is a function here rather than a habit in four files:
//
//   1. ALIGNED NAMES. A column of `key  value` rows with the keys padded to the longest
//      one in the set. A reader's eye lands on the values; a script can cut a column.
//   2. THREE VERDICTS AND NO MORE. `ok`, `fail` and `unknown` - and `unknown` exists so
//      that a check which could not be evaluated can say so without being reported as a
//      pass or dressed up as a failure (see `doctor`).
//   3. ONE REMEDY PER FAILURE, ON ITS OWN LINE, INDENTED. A remedy that shares a line
//      with the detail it fixes is a remedy nobody reads.
//
// EXIT CODES ARE PART OF THIS INTERFACE
// `EXIT_OK`, `EXIT_FAILED` and `EXIT_USAGE` are here rather than spelled as literals in
// four commands. `EXIT_USAGE` is 2 and not 1 because "you asked for something that does
// not exist" and "the thing you asked for failed" are different answers, and a script
// that mistook one for the other would retry a command that cannot succeed. It matches
// the convention the repository's verification scripts already use (docs/runbooks, and
// scripts/verify-*.mjs).
//
// This module formats strings. It opens no file, no socket and no process (APX-CON-12).

/** The command did what it was asked. */
export const EXIT_OK = 0

/** The command ran and something it checked is wrong. */
export const EXIT_FAILED = 1

/** The command line named a command or a flag that does not exist. */
export const EXIT_USAGE = 2

/** What a command decided, and the lines it wants printed. */
export interface CommandResult {
  readonly exitCode: number
  /** The lines to print, in order, already aligned and already worded. */
  readonly lines: readonly string[]
  /**
   * One event name for the local log, or null when the run had nothing worth recording.
   * The fields are the log's own closed set; see src/cli/log.ts.
   */
  readonly logEvent: string | null
  readonly logFields: Readonly<Record<string, string | number | boolean | null>>
}

/** A command that printed something and has nothing to log. */
export function printed(
  lines: readonly string[],
  exitCode: number = EXIT_OK,
  logEvent: string | null = null,
  logFields: Readonly<Record<string, string | number | boolean | null>> = {},
): CommandResult {
  return { exitCode, lines, logEvent, logFields }
}

/** One `key  value` row, before padding. */
export type Row = readonly [string, string]

/**
 * Render rows as an aligned `key  value` block, two spaces of indent.
 *
 * The key column is padded to the longest key in *this* set rather than to a constant,
 * so a short block does not have a ragged left edge and a long one does not run out of
 * room. The two-space indent is what makes a block visibly subordinate to the sentence
 * above it.
 */
export function kv(rows: readonly Row[], verdict?: string): readonly string[] {
  const width = rows.reduce((longest, [key]) => Math.max(longest, key.length), 0)
  const lines = rows.map(([key, value]) => `  ${key.padEnd(width)}  ${value}`)
  if (verdict === undefined) return lines
  return [`  ${'verdict'.padEnd(width)}  ${verdict}`, ...lines]
}

/** The three verdicts, as the fixed-width column a reader scans down. */
export type Verdict = 'ok' | 'fail' | 'unknown'

/**
 * The width of the verdict column, so every check row lines up.
 *
 * A width of 7 plus the one separating space, because `unknown` is exactly seven
 * characters long: a column exactly as wide as its longest value is a column with no
 * separator, and `unknownnot evaluated` is not output any diagnostic should produce.
 */
export const VERDICT_WIDTH = 7

/** The verdict word a severity prints. Three words, and `checkBlock` owns the mapping. */
export function verdictFor(severity: CheckSeverity): Verdict {
  switch (severity) {
    case 'passed':
      return 'ok'
    case 'failed':
      return 'fail'
    case 'unknown':
    default:
      return 'unknown'
  }
}

/**
 * A severity that decides the exit code.
 *
 * `failed` is the only one that does, and `unknown` is deliberately not a failure: a
 * check that could not be evaluated has not found a fault, and reporting it as one would
 * train a developer to ignore a non-zero exit.
 */
export type CheckSeverity = 'passed' | 'failed' | 'unknown'

/** One check row: a name, a verdict, a detail sentence, and for a failure a remedy. */
export interface CheckLine {
  readonly name: string
  readonly severity: CheckSeverity
  readonly detail: string
  /** Exactly one per failed check. Absent otherwise, and never on a passing check. */
  readonly remedy?: string
}

/**
 * Render the check block: aligned names, a fixed-width verdict column, and a remedy line
 * under each failure.
 *
 * The remedy is indented further than the row it belongs to and prefixed `remedy:`, so
 * it is visually part of the check above it and unambiguous in a grep.
 */
export function checkBlock(checks: readonly CheckLine[]): readonly string[] {
  const nameWidth = checks.reduce((longest, check) => Math.max(longest, check.name.length), 0)
  const lines: string[] = []
  for (const check of checks) {
    const verdict = verdictFor(check.severity)
    lines.push(`  ${check.name.padEnd(nameWidth)}  ${verdict.padEnd(VERDICT_WIDTH + 1)}${check.detail}`)
    if (check.severity === 'failed' && check.remedy !== undefined) {
      lines.push(`  ${' '.repeat(nameWidth)}  ${' '.repeat(VERDICT_WIDTH + 1)}remedy: ${check.remedy}`)
    }
  }
  return lines
}

/** How many checks failed, in the sentence a reader needs at the end. */
export function checkSummary(checks: readonly CheckLine[]): string {
  const failed = checks.filter((check) => check.severity === 'failed').length
  const unknown = checks.filter((check) => check.severity === 'unknown').length
  if (failed === 0) {
    return unknown === 0
      ? `all ${String(checks.length)} checks passed.`
      : `all ${String(checks.length)} checks passed; ${String(unknown)} could not be evaluated.`
  }
  const noun = failed === 1 ? 'check failed' : 'checks failed'
  const tail = unknown === 0 ? '' : `; ${String(unknown)} could not be evaluated`
  return `${String(failed)} of ${String(checks.length)} ${noun}${tail}.`
}

/**
 * A duration in seconds, in the largest unit that reads exactly.
 *
 * Two units and no more, because a developer's question is "is it up, and since when" and
 * a duration that loses sub-second precision is a diagnostic, not a measurement.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown'
  const whole = Math.floor(seconds)
  if (whole < 60) return `${String(whole)}s`
  const minutes = Math.floor(whole / 60)
  if (minutes < 60) return `${String(minutes)}m ${String(whole % 60)}s`
  const hours = Math.floor(minutes / 60)
  return `${String(hours)}h ${String(minutes % 60)}m`
}

/**
 * An ISO 8601 UTC timestamp, plus how long ago it was, in one line.
 *
 * Both halves, because a timestamp alone makes a reader do arithmetic and "3m ago" alone
 * is not a record. The raw value is printed verbatim rather than re-formatted: it is what
 * the log holds, and re-formatting it locally would make two lines for one event look
 * like two events.
 */
export function formatTimestamp(iso: string, now: Date = new Date()): string {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return iso
  const seconds = Math.max(0, Math.round((now.getTime() - parsed) / 1000))
  return `${iso} (${formatDuration(seconds)} ago)`
}
