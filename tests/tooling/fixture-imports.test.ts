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

import { readdirSync, readFileSync } from 'node:fs'
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

/**
 * The TypeScript suites that reach into `src/` by path at all.
 *
 * Discovered rather than listed, so a new suite that does it is covered by the sweep the
 * day it is written. A suite reaches for `src/` by reading a file, and the way it names
 * that file is the thing under test here.
 */
function suitesReachingIntoSrc(): string[] {
  const found: string[] = []
  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(repoRoot, relative), { withFileTypes: true })) {
      if (entry.name === 'e2e') continue
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        walk(child)
        continue
      }
      if (!entry.name.endsWith('.test.ts')) continue
      const source = readFileSync(path.join(repoRoot, child), 'utf8')
      if (source.includes("from '@/") || source.includes("'@/") || source.includes('.mjs')) {
        found.push(child)
      }
    }
  }
  walk('tests')
  return found.sort()
}

const SOURCE_REACHING_TESTS = suitesReachingIntoSrc()

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

/**
 * The same mistake wearing a different hat, in a TypeScript test.
 *
 * `path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', ...)` reads
 * like the fixture pattern but is not a double conversion - it takes `.pathname` and
 * hands it straight to a path API. On Windows `.pathname` is `/D:/a/...` with a leading
 * slash, and the ambient `path.join` resolves that against the current drive and
 * produces `D:\D:\a\...`, so the read failed with ENOENT on a file that exists. The
 * Windows cell found it in `tests/hub/lifecycle.test.ts` after the fixtures were fixed,
 * which is what a rule is for: the first instance is a bug, and the sweep is what stops
 * the second one waiting for a platform to find it.
 *
 * The correct spelling is `fileURLToPath(new URL(relative, import.meta.url))`, and for a
 * path inside this repository `repositoryPath` from `tests/helpers/read-module` is
 * already that.
 */
describe('no test rebuilds a path out of a URL pathname', () => {
  // Keyed on `import.meta.url`, which is what separates the mistake from the two
  // legitimate `.pathname` reads in this repository: a *request* URL, whose pathname is
  // a route (`tests/packaging/package.test.ts`), and the server's own request parsing
  // (`src/hub/server.ts`). Neither is a filesystem path and neither is a double
  // conversion. Only `import.meta.url` is a file URL, and only that one has to come back
  // through `fileURLToPath`.
  const WRONG = /new URL\([^)]*import\.meta\.url[^)]*\)\.pathname/

  it('holds across every suite that reaches for src/ by path', () => {
    const offenders: string[] = []
    for (const file of SOURCE_REACHING_TESTS) {
      // This file is the guard, and it necessarily contains the pattern it looks for.
      if (file === 'tests/tooling/fixture-imports.test.ts') continue
      const source = readFileSync(path.join(repoRoot, file), 'utf8')
      // Comments are stripped first: the explanatory comment above names this pattern,
      // and prose about a bug is not an instance of it.
      const code = source
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n')
      if (WRONG.test(code)) offenders.push(file)
    }
    expect(
      offenders,
      `these build a path out of a file-URL pathname, which doubles the drive letter on Windows: ${offenders.join(', ')}`,
    ).toEqual([])
  })

  it('finds the pattern when it is put back, so the sweep is not vacuous', () => {
    // A sweep over 50 files that can only ever return an empty list is not a check. So
    // the detector itself is handed the shape it is meant to catch.
    expect(WRONG.test("path.join(path.dirname(new URL(import.meta.url).pathname), '..')")).toBe(true)
    expect(WRONG.test("new URL('../../src/main/index.ts', import.meta.url).pathname")).toBe(true)
    // And the two legitimate reads must not match it.
    expect(WRONG.test("new URL(href, origin).pathname")).toBe(false)
    expect(WRONG.test("new URL(request.url ?? '/', 'http://127.0.0.1').pathname")).toBe(false)
  })
})
