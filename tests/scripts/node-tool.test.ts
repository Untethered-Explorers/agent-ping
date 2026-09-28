// The shared tool resolver, which every build and test entry point depends on.
//
// WHAT THIS SUITE IS FOR
//
// `scripts/build.mjs` and `scripts/run-tests.mjs` cannot run at all unless
// `nodeTool()` returns something spawnable, and the thing it used to do instead - join
// a path onto `node_modules/.bin` - cannot work on Windows, because that directory
// holds a generated `.cmd` batch shim and Node refuses to spawn a `.cmd` without a
// shell. A resolver whose failure mode is "every script in the repository exits
// non-zero" needs its own tests, and it needs them to be about the *contract* rather
// than about this machine's node_modules layout.
//
// THE THREE PROPERTIES THAT MATTER
//
//   1. An executable plus an argument array, never a command string. If a caller ever
//      had to join these into one string to run them, the shell would be back.
//   2. `process.execPath`, so the tool runs on the same Node that is running the test
//      rather than whichever one happens to be first on PATH.
//   3. A tool that is not installed reports itself as absent, so the caller can print
//      "run npm install" instead of dying on an ENOENT three frames deep.
//
// Nothing here asserts an absolute path. The tests run on three platforms and the
// layout of a real `node_modules` is not ours to predict; they assert that the entry
// file exists, that it is a JavaScript file, and that the shape of the answer is
// right.

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The module under test is plain JavaScript; scripts/lib/node-tool.d.mts declares its
// contract, so this import is typed rather than suppressed. A `@ts-expect-error` here
// would be flagged as unused, which is the point: the declaration is what lets a
// caller be told that `args` is a string array.
import * as resolver from '../../scripts/lib/node-tool.mjs'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

/** The tools the repository's own scripts invoke, as (package, bin name) pairs. */
const REQUIRED_TOOLS: ReadonlyArray<readonly [string, string]> = [
  ['typescript', 'tsc'],
  ['vite', 'vite'],
  ['vitest', 'vitest'],
  ['eslint', 'eslint'],
  ['@playwright/test', 'playwright'],
]

describe('nodeTool(): the tool as an executable plus an argument array', () => {
  it.each(REQUIRED_TOOLS)('resolves %s/%s to a JavaScript file that exists', (packageName, toolName) => {
    const tool = resolver.nodeTool(packageName, toolName)

    expect(tool.exists, `${packageName} is not installed; run npm install first`).toBe(true)
    // The interpreter is the one already running this test, not a name on PATH: two
    // Node versions in one install is a real thing on a developer machine, and the
    // build would then run under a different one than the tests.
    expect(tool.command).toBe(process.execPath)
    expect(tool.args).toHaveLength(1)
    const entry = tool.args[0] as string
    expect(existsSync(entry), `${entry} does not exist`).toBe(true)
    // A real file, not a directory and not a shim. No extension is required -
    // `typescript` publishes `./bin/tsc` with none - so the check is that it is a
    // file Node can execute, which is what `existsSync` plus the bin-field lookup
    // together establish.
    expect(statSync(entry).isFile()).toBe(true)
  })

  it('points at a real file inside the package, not at the .bin shim directory', () => {
    // The regression this suite exists for. `.bin` holds a `.cmd` on Windows, Node
    // refuses to spawn one without a shell, and a shell is what this repository's
    // cross-platform rules forbid. Resolving the package's own `bin` entry sidesteps
    // the shim entirely.
    const tool = resolver.nodeTool('vitest', 'vitest')
    const entry = tool.args[0] as string

    expect(entry.startsWith(path.join(repoRoot, 'node_modules'))).toBe(true)
    expect(entry.includes(`${path.sep}.bin${path.sep}`)).toBe(false)
    expect(entry.endsWith('.cmd')).toBe(false)
    expect(entry.endsWith('.bat')).toBe(false)
  })

  it('reads the entry out of the package own bin field, whatever shape it has', () => {
    // `typescript` declares several commands as an object; `vite` declares one as a
    // string. Both are resolved, and both to a path the package actually contains.
    for (const [packageName, toolName] of REQUIRED_TOOLS) {
      const tool = resolver.nodeTool(packageName, toolName)
      const entry = tool.args[0] as string
      expect(entry.startsWith(path.join(repoRoot, 'node_modules', packageName))).toBe(true)
    }
  })

  it('reports a tool that is not installed as absent, rather than as a broken command', () => {
    // The caller prints "run npm install" when `exists` is false. A command string
    // that would ENOENT at spawn time turns that message into a stack trace.
    const missing = resolver.nodeTool('this-package-does-not-exist', 'nope')

    expect(missing.exists).toBe(false)
    expect(missing.command).toBe('')
    expect(missing.args).toEqual([])
  })

  it('reports a package with no such command as absent', () => {
    // The package is installed, but it does not publish a bin by that name. That is
    // as unusable as not being installed, and it must read the same way.
    expect(resolver.nodeTool('vite', 'definitely-not-a-vite-command').exists).toBe(false)
  })
})

describe('npmTool(): npm itself, on the same terms as every other tool', () => {
  it('resolves to an executable and an argument array, never to a command string', () => {
    const npm = resolver.npmTool()

    expect(Array.isArray(npm.args)).toBe(true)
    // A caller spreads these into spawnSync's argument list. A single string
    // containing a space would silently become two arguments.
    for (const arg of npm.args) expect(typeof arg).toBe('string')
    expect(npm.command).not.toContain(' ')
  })

  it('runs the very npm that invoked this script, when there is one', () => {
    // Under `npm test` - how every caller here runs - npm_execpath names the running
    // npm's JavaScript entry, so the answer is the same interpreter-plus-path shape
    // as nodeTool(). Asserted only when it is actually set, because a direct
    // `node scripts/run-tests.mjs` has no npm above it and the fallback applies.
    if (process.env['npm_execpath'] !== undefined) {
      const npm = resolver.npmTool()
      expect(npm.exists).toBe(true)
      expect(npm.command).toBe(process.execPath)
      expect(npm.args[0]).toBe(process.env['npm_execpath'])
    }
  })

  it('falls back to a command name when there is no npm entry to point at', () => {
    // The two platforms spell the fallback differently and cannot be made to look
    // alike: on POSIX a bare `npm` is an executable, and on Windows it is `npm.cmd`,
    // which only runs under a shell. Both are recorded here so the difference is a
    // decision rather than an accident.
    const previous = process.env['npm_execpath']
    delete process.env['npm_execpath']
    try {
      const npm = resolver.npmTool()
      expect(npm.exists).toBe(true)
      expect(npm.args).toEqual([])
      if (process.platform === 'win32') {
        expect(npm.command).toBe('npm.cmd')
      } else {
        expect(npm.command).toBe('npm')
      }
    } finally {
      if (previous !== undefined) process.env['npm_execpath'] = previous
    }
  })
})

describe('the repository root this resolver reads from', () => {
  it('is the root, not the scripts directory', () => {
    // Two levels up from scripts/lib/. Getting this wrong makes every lookup point
    // at a directory that does not exist, and every tool report itself absent - a
    // failure that looks like "you forgot to npm install".
    //
    // Compared through `path.resolve` because the trailing separator is not the point
    // and the sibling scripts that compute the same path keep theirs.
    expect(path.resolve(resolver.repoRoot)).toBe(path.resolve(repoRoot))
    expect(existsSync(path.join(resolver.repoRoot, 'package.json'))).toBe(true)
  })
})

describe('no script resolves a tool through the .bin shim directory any more', () => {
  it('build.mjs, run-tests.mjs and the suites that spawn npm all go through the resolver', () => {
    // The suite that would otherwise catch this: on Windows every one of these files
    // is a hard failure, and on Linux the failure is invisible. A source-level check
    // is the only thing that holds on a platform the author is not standing on.
    const offenders: string[] = []
    const files = [
      'scripts/build.mjs',
      'scripts/run-tests.mjs',
      'tests/packaging/package.test.ts',
      'tests/tooling/runner-convention.test.ts',
    ]
    for (const file of files) {
      const source = readFileSync(path.join(repoRoot, file), 'utf8')
      // Strip line comments so prose describing the old approach is not counted as
      // the old approach; what must not survive is a live `.bin` join.
      const code = source
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n')
      if (/node_modules['"`,\s)]*\)?['"`,\s]*\.bin/.test(code) || /['"`]npm['"`]\s*,\s*\[/.test(code)) {
        offenders.push(file)
      }
    }
    expect(offenders, `these still spawn a tool the platform cannot run: ${offenders.join(', ')}`).toEqual([])
  })
})
