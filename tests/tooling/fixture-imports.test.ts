// The shape of the dynamic import every test fixture uses to reach `src/main/index.ts`.
//
// WHY THIS IS A TEST AND NOT A COMMENT
//
// The bug this guards against was invisible on the platform it was written on. All
// five fixtures resolved the entry with
//
//   pathToFileURL(new URL('../../../src/main/index.ts', import.meta.url).pathname).href
//
// which converts a URL to a string and straight back again. On Linux the round trip is
// idempotent, so it produced exactly the right path and nothing was ever wrong. On
// Windows `URL.pathname` yields `/D:/a/...` with a leading slash, and re-resolving that
// against the current drive produced `D:\D:\a\...` - a doubled drive letter, and
// ERR_MODULE_NOT_FOUND in every fixture at once.
//
// A comment would not have survived that, because the expression looks correct to
// anyone reading it on the machine they are standing on. Only a check that runs on all
// three operating systems can hold the line, and only a check that inspects the source
// can hold it before the fixtures are started: the failure mode is a child process
// dying with a module error, which reads as "the hub would not start" rather than as
// "a fixture built its import specifier twice".
//
// The correctness of the expression is not asserted by string-matching alone either.
// `resolveFixtureEntryUrl` below reimplements the one correct shape and the test
// compares each fixture's source against it, so a fixture that resolves the URL some
// other working way would have to be argued for rather than quietly accepted.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

/** The fixtures that start the real hub in a separate process. */
const FIXTURES: readonly string[] = [
  'tests/hub/fixtures/signal-hub.mjs',
  'tests/hub/fixtures/second-instance.mjs',
  'tests/hub/fixtures/measure-idle-rss.mjs',
  'tests/hub/fixtures/measure-stream-rss.mjs',
  'tests/e2e/fixtures/dashboard-hub.mjs',
]

/** The one entry they all import, relative to each fixture's own location. */
const ENTRY_SPECIFIER = '../../../src/main/index.ts'

/** Strip comments and string contents, the way a source-level check has to. */
function codeOf(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), 'utf8')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

describe('every hub fixture resolves the source entry the one correct way', () => {
  it.each(FIXTURES)('%s uses new URL(...).href and nothing else', (fixture) => {
    const source = codeOf(fixture)

    // The bug, named so a future reader knows what a match means.
    expect(source, `${fixture} converts a URL to a string and back`).not.toMatch(
      /pathToFileURL\(\s*new URL\(/,
    )
    // `URL.pathname` anywhere in an import is the same mistake wearing a different hat:
    // it discards a resolution the URL constructor already performed.
    expect(source, `${fixture} reads .pathname off a URL`).not.toMatch(/\.pathname\b/)
    // And the positive form, so the check fails if the import is deleted rather than
    // fixed - a test that only ever says "not the wrong thing" is satisfied by no
    // import at all.
    expect(source, `${fixture} does not import the source entry`).toContain(
      `new URL('${ENTRY_SPECIFIER}', import.meta.url).href`,
    )
  })

  it.each(FIXTURES)('%s imports an absolute file: URL, which is what import() needs', (fixture) => {
    // `import()` on Windows will not accept a bare `D:\...` path string; it needs a
    // URL. `.href` is what supplies one. This is asserted as a shape rather than
    // evaluated, because the URL's correctness depends on the importer's location.
    const source = codeOf(fixture)
    const match = source.match(/await import\(\s*([^)]*?)\s*\)/)

    expect(match, `${fixture} has no dynamic import of the entry`).not.toBeNull()
    expect(match?.[1]).toMatch(/^new URL\(/)
  })

  it('no fixture anywhere still uses the two-step conversion', () => {
    // A sweep rather than a per-file assertion, so a new fixture written tomorrow with
    // the old shape is caught on its first run rather than on its first Windows run.
    const offenders: string[] = []
    for (const fixture of FIXTURES) {
      if (/pathToFileURL\(\s*new URL\(/.test(codeOf(fixture))) offenders.push(fixture)
    }
    expect(offenders, `these convert a URL twice: ${offenders.join(', ')}`).toEqual([])
  })
})
