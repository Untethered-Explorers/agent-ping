// Proves the test-runner convention this repository is built on (DP-FR-07):
//
//   `npm test -- <path>` runs exactly that path, and a path that selects zero
//   test files exits non-zero instead of reporting success.
//
// Every assertion here drives the real command through a real child process, so
// the convention is proven against the runner rather than against a copy of its
// configuration. Reading vitest.config.ts would not catch a runner whose
// zero-selection default changed, which is exactly the defect this test exists
// to catch.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

/** Scratch space for the nested runs. Git-ignored, and removed in afterAll. */
const probeDir = path.join(repoRoot, 'tests', 'tooling', 'runner-convention-probe')
/** A directory that exists but holds no test file: the empty selection. */
const emptySelection = path.join(probeDir, 'empty-selection')
const selectedFile = path.join(probeDir, 'selected.test.ts')
const siblingFile = path.join(probeDir, 'sibling.test.ts')
const selectedMarker = path.join(probeDir, 'selected.ran')
const siblingMarker = path.join(probeDir, 'sibling.ran')

/** Script names the feature contracts depend on. Adding one here is a change to the shared contract. */
const REQUIRED_SCRIPTS = ['build', 'typecheck', 'lint', 'test'] as const

const repoRelative = (absolute: string) => path.relative(repoRoot, absolute).split(path.sep).join('/')

/** A probe test that records the fact it executed, so a run can be shown to have run it. */
const probeSource = (markerName: string) => `import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

test('probe ${markerName} executes', () => {
  writeFileSync(path.join(import.meta.dirname, '${markerName}'), 'executed')
  expect(true).toBe(true)
})
`

interface RunResult {
  status: number
  /** stdout and stderr combined, with terminal colour escapes removed. */
  output: string
}

// A CSI sequence (ESC [ ... final byte) or an OSC one (ESC ] ... BEL or ST).
// Vitest colours its summary whenever the output is a TTY or FORCE_COLOR is set, which
// puts escape codes between the label and the value: "Test Files \e[22m \e[1m\e[32m1
// passed". Every assertion below matches the runner's own words, so they must match
// them in plain text: matching raw output would fail under colour and, worse, make the
// not.toMatch guards pass whether or not a summary was actually printed.
// The g flag matters: String.replace without it removes only the first escape, and
// a coloured summary carries one between every label and every value.
const ANSI_PATTERN =
  /\u001B\[[0-9;:?]*[ -\/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g

const stripAnsi = (value: string) => value.replace(ANSI_PATTERN, '')

/**
 * Runs the real command: npm test -- <paths...>, in the repository root.
 *
 * Colour is switched off in the child so the nested output is byte-identical on a TTY
 * and in a pipe; stripAnsi is the belt to that pair of braces, because an inherited
 * NO_COLOR or FORCE_COLOR must not be able to change what this test asserts.
 */
function npmTest(paths: string[]): RunResult {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')),
  )
  const result = spawnSync('npm', ['test', '--', ...paths], {
    cwd: repoRoot,
    encoding: 'utf8',
    // A nested run must not inherit the outer run's worker state.
    env: { ...inherited, FORCE_COLOR: '0', NO_COLOR: '1' },
  })
  if (result.error !== undefined) throw result.error
  const output = stripAnsi(`${result.stdout ?? ''}${result.stderr ?? ''}`)
  return { status: result.status ?? 1, output }
}

beforeAll(() => {
  rmSync(probeDir, { force: true, recursive: true })
  mkdirSync(emptySelection, { recursive: true })
  writeFileSync(selectedFile, probeSource('selected.ran'))
  writeFileSync(siblingFile, probeSource('sibling.ran'))
})

afterAll(() => {
  rmSync(probeDir, { force: true, recursive: true })
})

describe('test runner convention', () => {
  it('exits non-zero for a named path that selects zero test files', () => {
    const { status, output } = npmTest([repoRelative(emptySelection)])

    expect(existsSync(selectedMarker) || existsSync(siblingMarker)).toBe(false)
    expect(status).not.toBe(0)
    // A green vitest summary would mean the empty selection was reported as a pass.
    expect(output).not.toMatch(/Test Files\s+\d+ passed/)
    expect(output).toMatch(/No test files found/)
  })

  it('exits non-zero for a named path that does not exist at all', () => {
    const { status, output } = npmTest([`${repoRelative(probeDir)}/no-such-file.test.ts`])

    expect(status).not.toBe(0)
    expect(output).not.toMatch(/Test Files\s+\d+ passed/)
  })

  it('runs exactly the named path and nothing else', () => {
    const { status, output } = npmTest([repoRelative(selectedFile)])

    expect(status).toBe(0)
    expect(existsSync(selectedMarker)).toBe(true)
    // The sibling sits beside the selected file and shares its prefix, so a
    // runner that widened the selection to the directory would run it too.
    expect(existsSync(siblingMarker)).toBe(false)
    expect(output).toMatch(/Test Files\s+1 passed/)
  })

  it('runs every named path when more than one is given', () => {
    const { status } = npmTest([repoRelative(selectedFile), repoRelative(siblingFile)])

    expect(status).toBe(0)
    expect(existsSync(selectedMarker)).toBe(true)
    expect(existsSync(siblingMarker)).toBe(true)
  })
})

describe('script contract', () => {
  it('declares every script name the feature contracts depend on', () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }

    for (const name of REQUIRED_SCRIPTS) {
      expect(manifest.scripts?.[name], `package.json is missing the "${name}" script`).toBeTypeOf(
        'string',
      )
    }
  })

  it('never passes a flag that would let an empty selection report success', () => {
    const source = readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8')

    expect(source).toMatch(/passWithNoTests:\s*false/)
    expect(source).not.toMatch(/passWithNoTests:\s*true/)
  })
})
