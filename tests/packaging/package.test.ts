// The packaging guard: the npm package a developer installs globally, and the
// build artefacts it cannot be installed without (IO-FR-01, IO-1, ADR-007, ADR-006).
//
//   npm test -- tests/packaging/package.test.ts
//
// WHAT IS PROVEN HERE, AND WHERE EACH ACCEPTANCE CRITERION IS
//
//   1. "A test asserts the prepack check fails when a required build artefact is
//       absent and passes when all are present."
//      A deliberately complete tree is written into a temporary directory and the
//      real script is spawned against it; then each required artefact in turn is
//      removed and the same script is spawned again. Every removal is a non-zero
//      exit whose output names the artefact, and the complete tree is exit 0 with
//      nine ok lines. The two directions, not one.
//
//   2. "A test asserts the prepack check requires exactly the three built documents
//       - index.html, prototype/index.html and card.html - and fails when any one
//       is absent."
//      Each of the three is removed on its own, and an unexpected fourth document
//      is added, because "exactly" is the claim being tested: a set that grows by
//      accident is the same defect as a set with a hole in it.
//
//   3. "A test asserts the files allowlist and the declared bin cover the built main
//       bundle, all three documents and the durable schema, and that the schema is
//       present in the build output."
//      The real package.json is the subject, and the durable schema is proven by
//      deleting dist/main/storage/schema.sql and running the real build, because a
//      file that happened to be in the tree is not a build that produces it.
//
//   4. "A test asserts the packaged entry point applies the chosen Chromium
//       process-sandbox launch policy rather than relying on a platform default."
//      The built entry in this repository is read for both calls, and a complete
//      tree whose entry does not make them fails the guard.
//
//   5. "A test asserts serving the notification card document over the loopback
//       static route does not increment the dashboard-open counter."
//      A real hub from the real entry point serves the real built dashboard over a
//      real loopback socket: the card document is a 200 and moves nothing, and the
//      dashboard itself moves the counter in the same run, so the zero is a rule
//      and not a broken counter.
//
//   6. "A test asserts the files allowlist excludes source maps, tests and
//       development-only configuration."
//      Two ways, because one is not enough. Named probes assert the categories, and
//      a sweep of the whole built output asserts that no source map or declaration
//      is matched whatever it is called. Every probe path exists in this repository,
//      so no assertion here can pass because the file is absent.
//
//   7. "A test asserts the declared binary name matches the command the installer
//       documentation uses."
//      The operations runbook, the ADR and the README are read for the command a
//      developer types, and it has to be the one `bin` declares.
//
// AND THE PROOF THAT THE ALLOWLIST MEANS WHAT THE CHECK SAYS
//
// The guard answers "would this file be published?" with its own matcher. A matcher
// that disagreed with npm would report a package as shipped when npm dropped the
// file, which is worse than no guard at all, so `npm pack --dry-run` is run here and
// every path in this checkout is compared: the guard's answer has to equal npm's,
// everywhere, with package.json - which npm always includes - as the one documented
// exception. That is the check that keeps the allowlist honest as it is edited.
//
// LIMITS, STATED RATHER THAN HIDDEN
//   - The comment stripper the guard uses is this repository's hand-written kind: a
//     backtick template is read as one string to its closing backtick, so a nested
//     template inside a `${...}` would end the scan early. No module or artefact
//     these are pointed at contains one.
//   - Nothing here starts Electron, so "the packaged entry applies the launch policy"
//     is a claim about the shipped bytes and not about a Chromium run. The live half
//     is scripts/verify-notification-surface.mjs (NT-9, NS-4) and the autostart
//     units' own `--no-sandbox` line, which is IO-3's, and neither is in this task.
//   - No global install is performed. The package is inspected the way npm inspects
//     it, and IO-4 and IO-5 are where a real `npm install -g` is driven.

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startHub, type RunningHub } from '@/main/index'
import type { MetricsPayload } from '@/hub/routes/metrics'
import { renderPluginSource } from '@/plugin/install/global-plugin'
import { COUNTER_NAMES } from '@/storage/counters'

// @ts-expect-error the guard under test is plain JavaScript with no declaration file; the
// exports this suite exercises are its contract, and the ones it names are all it uses.
import * as guard from '../../scripts/prepack-check.mjs'
// npm itself, resolved through the running npm's own JavaScript entry rather than a
// bare `npm`, which is `npm.cmd` on Windows and cannot be spawned without a shell.
import { npmTool } from '../../scripts/lib/node-tool.mjs'
import { removeTree } from '../helpers/remove-tree'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const scriptPath = path.join(repoRoot, 'scripts', 'prepack-check.mjs')
const realManifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  name: string
  files: string[]
  bin: Record<string, string>
  main: string
}

const temporaryDirectories: string[] = []
const openHubs: RunningHub[] = []

afterEach(async () => {
  for (const hub of openHubs.splice(0)) {
    await hub.close().catch(() => undefined)
  }
})

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    removeTree(directory)
  }
})

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

// ---------------------------------------------------------------------------
// The real build, run once into a scratch tree
// ---------------------------------------------------------------------------

/**
 * A scratch tree holding this repository's build inputs, built by the real build.
 *
 * Deliberately NOT `npm run build` in the repository. `dist/` is shared: card-document
 * and the live verification scripts read it, so a suite that deletes or rewrites it
 * while another suite is reading it is a flake in somebody else's test - which is not
 * a hypothetical, it is what happened here. Every artefact assertion in this file is
 * made against this tree instead, and the suite therefore also works in a checkout
 * that has never been built.
 *
 * `node_modules` is a symlink rather than a copy, so the compiler and Vite that build
 * this tree are the repository's own installed ones. The tree is otherwise a faithful
 * copy: the sources, the manifest, the tsconfigs, the Vite config, and placeholders
 * for the development-only paths the allowlist is required to exclude, because npm
 * decides what to publish by name and a name is all a packlist comparison needs.
 */
function buildScratchTree(): string {
  const root = temporaryDirectory('agent-ping-build-')
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'junction')
  copyTree('src', path.join(root, 'src'))
  for (const file of [
    'package.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'vite.config.ts',
    'vitest.config.ts',
    'eslint.config.js',
    'LICENSE',
    'README.md',
  ]) {
    copyFileSync(path.join(repoRoot, file), path.join(root, file))
  }
  mkdirSync(path.join(root, 'scripts'), { recursive: true })
  copyFileSync(path.join(repoRoot, 'scripts', 'build.mjs'), path.join(root, 'scripts', 'build.mjs'))
  // build.mjs imports the shared tool resolver, and the scratch tree runs the real
  // build: copying only build.mjs would leave that import unresolved and the run
  // would fail on a missing module rather than on anything about the package.
  mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true })
  copyFileSync(
    path.join(repoRoot, 'scripts', 'lib', 'node-tool.mjs'),
    path.join(root, 'scripts', 'lib', 'node-tool.mjs'),
  )
  // The two paths the allowlist has to keep out that no build would ever produce.
  write(root, 'tests/packaging/package.test.ts', '// a placeholder: the name is what the allowlist is judged on\n')
  write(root, 'docs/PRD.md', '# a placeholder: the name is what the allowlist is judged on\n')

  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], {
    cwd: root,
    encoding: 'utf8',
  })
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `the real build failed in a scratch tree:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    )
  }
  return root
}

function copyTree(relative: string, into: string): void {
  mkdirSync(into, { recursive: true })
  for (const entry of readdirSync(path.join(repoRoot, relative))) {
    const from = path.join(repoRoot, relative, entry)
    if (statSync(from).isDirectory()) copyTree(`${relative}/${entry}`, path.join(into, entry))
    else copyFileSync(from, path.join(into, entry))
  }
}

/** The tree every artefact assertion below is made against. Built once. */
let buildTree = ''

beforeAll(() => {
  buildTree = buildScratchTree()
}, 300_000)

// ---------------------------------------------------------------------------
// Fixture trees
// ---------------------------------------------------------------------------

/** Write one file into a tree, creating its directory. */
function write(root: string, relative: string, contents: string): void {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

/**
 * A tree that passes the guard, written file by file.
 *
 * The manifest is the real one, so the fixture is judged against this product's
 * actual `bin`, `main` and `files` rather than a convenient copy of them. The
 * generator declares the same two roots the real generator declares, because the
 * guard cross-checks them: a fixture whose generator disagreed would be testing a
 * different product.
 */
function completeTree(): string {
  const root = temporaryDirectory('agent-ping-prepack-complete-')
  write(root, 'package.json', `${JSON.stringify(realManifest, null, 2)}\n`)

  // The built Electron main entry. Both calls matter, for different reasons, and the
  // guard reads both: one is what this package can still do for a child process, the
  // other is what turns a missing switch into a sentence an operator can act on.
  write(
    root,
    guard.MAIN_ENTRY,
    [
      "import { applyChromiumLaunchPolicy, launchPolicyApplied } from '../notify/surface/electron-host.js'",
      'export async function startElectronMain(app) {',
      '  const gap = launchPolicyApplied(process.argv, process.env)',
      '  if (gap !== null) process.stderr.write(`agent-ping: ${gap}`)',
      '  applyChromiumLaunchPolicy(app.commandLine)',
      '}',
      '',
    ].join('\n'),
  )
  write(root, guard.BIN_TARGET, '#!/usr/bin/env node\n')
  write(
    root,
    guard.DURABLE_SCHEMA,
    readFileSync(path.join(repoRoot, 'src', 'storage', 'schema.sql'), 'utf8'),
  )

  // The three documents, each naming an asset the build emitted, because a
  // half-emitted dashboard is the failure the reference sweep exists to catch.
  write(
    root,
    'dist/dashboard/index.html',
    [
      '<!doctype html><html lang="en"><head><title>agent-ping</title>',
      '<link rel="stylesheet" href="./assets/index-abc123.css" />',
      '<script type="module" src="./assets/index-abc123.js"></script>',
      '</head><body><div id="app"></div></body></html>',
      '',
    ].join('\n'),
  )
  write(
    root,
    'dist/dashboard/prototype/index.html',
    [
      '<!doctype html><html lang="en"><head><title>agent-ping prototype</title>',
      '<script type="module" src="../assets/prototype-abc123.js"></script>',
      '</head><body></body></html>',
      '',
    ].join('\n'),
  )
  write(
    root,
    'dist/dashboard/card.html',
    [
      '<!doctype html><html lang="en"><head><title>agent-ping card</title>',
      '<link rel="stylesheet" href="./assets/card-abc123.css" />',
      '<script type="module" src="./assets/card-abc123.js"></script>',
      '</head><body><div data-card-surface></div></body></html>',
      '',
    ].join('\n'),
  )
  write(root, 'dist/dashboard/assets/index-abc123.js', 'export const dashboard = true\n')
  write(root, 'dist/dashboard/assets/index-abc123.css', '#app { color: #fff }\n')
  write(root, 'dist/dashboard/assets/prototype-abc123.js', 'export const prototype = true\n')
  write(root, 'dist/dashboard/assets/card-abc123.js', 'export const card = true\n')
  write(root, 'dist/dashboard/assets/card-abc123.css', '[data-card-surface] { color: #fff }\n')

  // The generator the install command calls, and the modules it inlines. Two roots,
  // the same two the real generator declares, and each module with one relative
  // import so the closure is a real graph rather than two files.
  write(
    root,
    guard.PLUGIN_GENERATOR,
    [
      "const ENTRY_MODULE = 'plugin/opencode/index.ts'",
      "const TRANSPORT_MODULE = 'plugin/transport/http.ts'",
      'export function renderPluginSource(options) {',
      '  return { text: options.version, modules: [ENTRY_MODULE, TRANSPORT_MODULE] }',
      '}',
      '',
    ].join('\n'),
  )
  write(
    root,
    'src/plugin/opencode/index.ts',
    "import { classify } from '../../domain/classify.js'\nexport const plugin = classify\n",
  )
  write(
    root,
    'src/plugin/transport/http.ts',
    "import { envelope } from '../../domain/envelope.js'\nexport const transport = envelope\n",
  )
  write(root, 'src/domain/classify.ts', 'export const classify = () => "needs-you"\n')
  write(root, 'src/domain/envelope.ts', 'export const envelope = () => ({})\n')
  return root
}

interface CheckRun {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

/** Spawn the real guard, the way `prepack` does, and read what it said. */
function runCheck(root: string): CheckRun {
  const result = spawnSync(process.execPath, [scriptPath, '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** The guard's own answer for a tree, without a child process. */
function checkNames(root: string): { name: string; ok: boolean; detail: string; remedy?: string }[] {
  return guard.runPrepackCheck(root).checks
}

function checkOf(root: string, name: string) {
  const found = checkNames(root).find((check) => check.name === name)
  if (found === undefined) throw new Error(`no check named ${name}`)
  return found
}

// ---------------------------------------------------------------------------
// 1. The guard fails on an incomplete tree and passes on a complete one
// ---------------------------------------------------------------------------

describe('the prepack guard refuses a tree that cannot be started', () => {
  it('passes a deliberately complete tree, and names every check it ran', () => {
    const run = runCheck(completeTree())

    expect(run.status, run.stdout + run.stderr).toBe(0)
    // One ok line per check, aligned, and the summary that a script can read.
    for (const name of [
      'manifest',
      'binary',
      'electron-main',
      'launch-policy',
      'durable-schema',
      'dashboard',
      'plugin-source',
      'files-allowlist',
      'files-exclusions',
    ]) {
      expect(run.stdout).toMatch(new RegExp(`\\[prepack\\] ${name}\\s+ok\\s+\\S`))
    }
    expect(run.stdout).toContain('[prepack] 9 of 9 checks passed')
  })

  it('fails, and names the artefact, for every required one that is removed', () => {
    // One artefact from each check, so a green run cannot come from a guard that only
    // looks at one corner of the package. The third element is what the report has to
    // name: a guard that exits non-zero without saying which artefact is gone is a
    // guard that sends the reader to diff the tree themselves.
    const removals: ReadonlyArray<readonly [string, string, string]> = [
      ['the built Electron main entry', guard.MAIN_ENTRY, guard.MAIN_ENTRY],
      ['the binary the package declares', guard.BIN_TARGET, guard.BIN_TARGET],
      ['the durable schema in the build output', guard.DURABLE_SCHEMA, guard.DURABLE_SCHEMA],
      ['the live dashboard document', 'dist/dashboard/index.html', 'dist/dashboard/index.html'],
      [
        'a module the generated plugin file inlines',
        'src/domain/classify.ts',
        '../../domain/classify.js',
      ],
      ['the generator the install command calls', guard.PLUGIN_GENERATOR, guard.PLUGIN_GENERATOR],
    ]

    for (const [what, relative, named] of removals) {
      const root = completeTree()
      rmSync(path.join(root, relative))
      const run = runCheck(root)

      expect(run.status, `${what}: ${relative}\n${run.stdout}`).toBe(1)
      expect(run.stdout, `${what}: ${relative}`).toContain(named)
      expect(run.stdout, relative).toMatch(/\[prepack\] \d+ of \d+ checks passed; \d+ failed:/)
    }
  })

  it('prints exactly one remedy line per failed check, and none for a check that passed', () => {
    const root = completeTree()
    rmSync(path.join(root, guard.DURABLE_SCHEMA))
    rmSync(path.join(root, guard.BIN_TARGET))
    const run = runCheck(root)

    expect(run.status).toBe(1)
    const failures = checkNames(root).filter((check) => !check.ok).map((check) => check.name)
    expect(failures.length).toBeGreaterThan(1)
    // The remedy is the whole point of the output: one line, naming the fix, with a
    // command or a path in it rather than a restatement of the failure.
    const remedies = run.stdout.split('\n').filter((line) => line.includes('remedy:'))
    expect(remedies).toHaveLength(failures.length)
    for (const remedy of remedies) {
      // A remedy a developer can act on: a command to run or a file to change, not a
      // restatement of the failure in other words.
      expect(remedy, remedy).toMatch(/remedy: .*(npm run|src\/|dist\/|docs\/|package\.json|vite\.config)/)
    }
    for (const passed of checkNames(root).filter((check) => check.ok)) {
      expect(run.stdout).not.toContain(`${passed.name}  FAILED`)
    }
  })

  it('refuses a manifest that declares no bin, or a binary of another name', () => {
    const missing = completeTree()
    write(missing, 'package.json', JSON.stringify({ ...realManifest, bin: undefined }, null, 2))
    expect(checkOf(missing, 'binary').ok).toBe(false)
    expect(checkOf(missing, 'binary').detail).toMatch(/no `bin` is declared/)

    const renamed = completeTree()
    write(
      renamed,
      'package.json',
      JSON.stringify({ ...realManifest, bin: { 'agent-ping-cli': realManifest.bin['agent-ping'] } }, null, 2),
    )
    const found = checkOf(renamed, 'binary')
    expect(found.ok).toBe(false)
    expect(found.detail).toContain('"agent-ping-cli"')
  })

  it('refuses a manifest with no `files` allowlist, because npm would publish the checkout', () => {
    const root = completeTree()
    write(root, 'package.json', JSON.stringify({ ...realManifest, files: undefined }, null, 2))

    for (const name of ['files-allowlist', 'files-exclusions', 'plugin-source']) {
      const found = checkOf(root, name)
      expect(found.ok, name).toBe(false)
      expect(found.detail, name).toMatch(/no `files` allowlist/)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Exactly three built documents
// ---------------------------------------------------------------------------

describe('the dashboard document set is exactly the three the product serves', () => {
  it('requires index.html, prototype/index.html and card.html, and each one alone is load-bearing', () => {
    expect(guard.REQUIRED_DASHBOARD_DOCUMENTS).toEqual([
      'index.html',
      'prototype/index.html',
      'card.html',
    ])

    const required: string[] = guard.REQUIRED_DASHBOARD_DOCUMENTS
    for (const document of required) {
      const root = completeTree()
      rmSync(path.join(root, 'dist', 'dashboard', document))
      const run = runCheck(root)

      expect(run.status, document).toBe(1)
      expect(run.stdout, document).toContain(`dist/dashboard/${document}`)
      expect(checkOf(root, 'dashboard').detail).toMatch(/missing built document/)
    }
  })

  it('reports a document the build emitted that this product does not declare', () => {
    const root = completeTree()
    write(root, 'dist/dashboard/settings.html', '<!doctype html><title>agent-ping</title>\n')

    const found = checkOf(root, 'dashboard')
    expect(found.ok).toBe(false)
    expect(found.detail).toContain('settings.html')
    expect(found.remedy).toMatch(/REQUIRED_DASHBOARD_DOCUMENTS/)
  })

  it('reports a document that names an asset the build did not emit', () => {
    const root = completeTree()
    rmSync(path.join(root, 'dist', 'dashboard', 'assets', 'card-abc123.js'))

    const found = checkOf(root, 'dashboard')
    expect(found.ok).toBe(false)
    // The reference sweep is what makes the guard more than "one file exists": a card
    // document that loads a script the build never wrote is a card window with a
    // broken surface, and it would pass a presence check.
    expect(found.detail).toContain('dist/dashboard/card.html -> dist/dashboard/assets/card-abc123.js')
  })
})

// ---------------------------------------------------------------------------
// 3. The allowlist, the declared bin, and the schema in the build output
// ---------------------------------------------------------------------------

describe('the allowlist and the declared bin cover everything that must ship', () => {
  it('the real build put the durable schema beside the emitted store', () => {
    // The tree was built from nothing into an empty directory, so the schema is there
    // because the build put it there - not because a previous run left it. That is the
    // whole claim: `tsc` emits JavaScript only, and the store loads this file relative
    // to its own emitted module, so without the copy a hub started from the build
    // cannot open its own log (EL-1, recorded for DP-1 and IO-1).
    const built = path.join(buildTree, guard.DURABLE_SCHEMA)
    expect(existsSync(built), 'the build did not copy the durable schema').toBe(true)
    // It is the schema, not a file with the right name: the build copies byte for byte.
    expect(readFileSync(built, 'utf8')).toBe(
      readFileSync(path.join(repoRoot, 'src', 'storage', 'schema.sql'), 'utf8'),
    )
    // The build reports the step rather than doing it silently, and leaves no staging
    // file behind for the next reader to find.
    const staged = readdirSync(path.dirname(built)).filter((entry) => entry.endsWith('.partial'))
    expect(staged).toEqual([])
  })

  it('covers the built main bundle, all three documents, the durable schema and the binary', () => {
    const requiredDocuments: string[] = guard.REQUIRED_DASHBOARD_DOCUMENTS
    expect(realManifest.bin).toEqual({ [guard.BIN_NAME]: guard.BIN_TARGET })
    expect(realManifest.main).toBe(guard.MAIN_ENTRY)

    const required = [
      guard.MAIN_ENTRY,
      guard.BIN_TARGET,
      guard.DURABLE_SCHEMA,
      ...requiredDocuments.map((document) => `${guard.DASHBOARD_ROOT}/${document}`),
      guard.PLUGIN_GENERATOR,
    ]
    for (const file of required) {
      expect(guard.matchesFilesAllowlist(file, realManifest.files), file).toBe(true)
    }
  })

  it('every artefact the guard itself requires is one the allowlist covers', () => {
    const required = guard.requiredShippedPaths(buildTree)
    expect(required).toContain(guard.MAIN_ENTRY)
    expect(required).toContain(guard.BIN_TARGET)
    expect(required).toContain(guard.DURABLE_SCHEMA)
    expect(required).toContain('dist/dashboard/card.html')
    expect(required).toContain(guard.PLUGIN_GENERATOR)
    for (const file of required) {
      expect(guard.matchesFilesAllowlist(file, realManifest.files), file).toBe(true)
    }
    // And the guard says so about a real build of this repository, for every check.
    // It used to stop at `binary`, because `src/cli/index.ts` was IO-2's and did not
    // exist; a package whose declared command could not run had to be unpublishable, and
    // now that the command is here the whole guard is green.
    const checks = checkNames(buildTree)
    for (const check of checks) {
      expect(check.ok, `${check.name}: ${check.detail}`).toBe(true)
    }
    expect(checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([])
    // The binary check is still proven, on a tree the command is missing from rather than
    // on this repository - so the assertion outlives the fix that made it pass.
    const withoutCommand = completeTree()
    rmSync(path.join(withoutCommand, guard.BIN_TARGET), { force: true })
    const missing = checkOf(withoutCommand, 'binary')
    expect(missing.ok).toBe(false)
    expect(missing.detail).toContain(guard.BIN_TARGET)
    expect(missing.remedy).toContain('npm run build')
    expect(missing.remedy).toContain('src/cli/index.ts')
  })

  it('reports a plugin module the allowlist would leave behind', () => {
    // The closure the guard derives follows relative value imports, so a module reached
    // from outside the four source directories the allowlist names is exactly the drift
    // this catches: the installer would render a plugin from a file nobody published.
    const root = completeTree()
    write(root, 'src/notify/surface/card.ts', 'export const card = () => null\n')
    write(
      root,
      'src/plugin/opencode/index.ts',
      "import { card } from '../../notify/surface/card.js'\nexport const plugin = card\n",
    )

    const found = checkOf(root, 'plugin-source')
    expect(found.ok).toBe(false)
    expect(found.detail).toContain('src/notify/surface/card.ts')
    expect(found.remedy).toMatch(/allowlist/)
  })

  it('derives the same module closure the real generator inlines', () => {
    // The guard re-implements the generator's closure walk so it can run against a
    // fixture tree. A second implementation is only safe if the two agree, so this
    // compares them directly against the product's own renderer: a change to the
    // generator's roots or its type-only rule that the guard has not followed shows up
    // here as a different list rather than as a package that installs a plugin it
    // cannot generate.
    const rendered = renderPluginSource({ version: '0.1.0' })
    const derived = guard.pluginClosure(repoRoot)

    expect(derived.unresolved).toEqual([])
    expect(derived.external).toEqual([])
    expect([...derived.modules].sort()).toEqual([...rendered.modules].sort())
    // Both name the same files on disk, and every one of them is in the allowlist.
    for (const module of rendered.modules) {
      expect(existsSync(path.join(repoRoot, 'src', module)), module).toBe(true)
      expect(guard.matchesFilesAllowlist(`src/${module}`, realManifest.files), module).toBe(true)
    }
    // The generated file has no npm dependency, which is the property that lets it be
    // loaded into a session with nothing installed beside it.
    expect(rendered.builtins.every((builtin) => builtin.startsWith('node:'))).toBe(true)
  })

  it('renders the plugin file from the source tree that would be installed', () => {
    // The guard proves the tree contains every module the generator inlines. This
    // proves the stronger half: the tree the allowlist ships can actually generate the
    // one file `install` writes into opencode's global plugin directory, using the
    // product's own renderer against the packaged sources rather than a stand-in.
    const rendered = renderPluginSource({
      version: '0.1.0',
      sourceDir: path.join(buildTree, 'src'),
    })

    expect(rendered.modules.length).toBeGreaterThan(0)
    expect(rendered.text).toContain('// agent-ping:global-plugin v1')
    expect(rendered.text).toContain('// product-version: 0.1.0')
    // Every module it copied is one the guard requires and the allowlist covers, so the
    // two views of "what the installer needs" cannot drift apart quietly.
    for (const module of rendered.modules) {
      expect(guard.requiredShippedPaths(buildTree), module).toContain(`src/${module}`)
      expect(guard.matchesFilesAllowlist(`src/${module}`, realManifest.files), module).toBe(true)
    }
    // The rendered file needs no npm package, because it is loaded into every session
    // on the machine with nothing installed beside it.
    expect(rendered.builtins.every((builtin) => builtin.startsWith('node:'))).toBe(true)
    expect(rendered.text).not.toMatch(/from '(?:better-sqlite3|electron|pixi\.js)'/)
  })

  it('reports a plugin closure that could not be resolved in this tree', () => {
    const root = completeTree()
    write(root, 'src/domain/classify.ts', "import { missing } from './missing.js'\nexport const classify = missing\n")

    const found = checkOf(root, 'plugin-source')
    expect(found.ok).toBe(false)
    expect(found.detail).toMatch(/needs module/)
    expect(found.detail).toContain('src/domain/classify.ts -> ./missing.js')
  })
})

// ---------------------------------------------------------------------------
// 6. What the allowlist excludes - and that it means what it says
// ---------------------------------------------------------------------------

describe('the allowlist publishes only what must ship', () => {
  it('excludes source maps, tests and development-only configuration', () => {
    for (const entry of guard.FORBIDDEN_SHIPPED) {
      expect(guard.matchesFilesAllowlist(entry.path, realManifest.files), entry.path).toBe(false)
    }
    // Non-vacuous: every probe path exists in the tree this file built, so "not
    // published" is a decision about the allowlist rather than about a typo.
    for (const entry of guard.FORBIDDEN_SHIPPED) {
      expect(existsSync(path.join(buildTree, entry.path)), entry.path).toBe(true)
    }
  })

  it('excludes every source map and declaration the build emitted, whatever it is called', () => {
    // The build emits maps and declarations; a guard that only knew the two hashed
    // names would pass the day a third was added.
    const built = walkTree(buildTree).filter((file) => file.startsWith('dist/'))
    const maps = built.filter((file) => file.endsWith('.map'))
    const declarations = built.filter((file) => file.endsWith('.d.ts'))
    expect(maps.length).toBeGreaterThan(0)
    expect(declarations.length).toBeGreaterThan(0)
    for (const file of [...maps, ...declarations]) {
      expect(guard.matchesFilesAllowlist(file, realManifest.files), file).toBe(false)
    }
    expect(checkOf(buildTree, 'files-exclusions').ok).toBe(true)
  })

  it('agrees with npm about every path in the tree, so the guard cannot lie about shipping', () => {
    // The guard answers "would npm publish this?" with its own matcher. If the two ever
    // disagree the guard is worse than useless, so npm is asked directly here and every
    // path is compared. `package.json` is npm's one always-included file and the
    // allowlist is not expected to name it.
    const packed = npmPackList(buildTree)
    expect(packed.length).toBeGreaterThan(20)

    const paths = [...walkTree(buildTree), 'package.json']
    const disagreements = paths.filter(
      (file) =>
        file !== 'package.json' &&
        guard.matchesFilesAllowlist(file, realManifest.files) !== packed.includes(file),
    )
    expect(disagreements, `the guard and npm disagree about: ${disagreements.join(', ')}`).toEqual([])

    // The three documents and the schema are in the real pack list, so the equivalence
    // is not being reached on a tree that ships nothing.
    for (const required of [
      'dist/dashboard/index.html',
      'dist/dashboard/prototype/index.html',
      'dist/dashboard/card.html',
      'dist/main/storage/schema.sql',
      'dist/main/main/index.js',
    ]) {
      expect(packed, required).toContain(required)
    }
    expect(packed.filter((file) => file.endsWith('.map'))).toEqual([])
    expect(packed.filter((file) => file.startsWith('tests/'))).toEqual([])
    expect(packed.filter((file) => file.startsWith('docs/'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. The packaged entry point and the Chromium launch policy
// ---------------------------------------------------------------------------

describe('the packaged entry point applies the launch policy rather than a platform default', () => {
  it('the entry point the real build emits applies it and reports the gap', () => {
    const built = readFileSync(path.join(buildTree, guard.MAIN_ENTRY), 'utf8')
    for (const call of guard.LAUNCH_POLICY_CALLS) {
      expect(built, call).toContain(call)
    }
    // The source the built file came from says the same thing, and says why: the
    // sandbox is decided before any JavaScript in this package runs, so the units own
    // the switch and this package owns the diagnosis.
    const source = readFileSync(path.join(repoRoot, 'src', 'main', 'index.ts'), 'utf8')
    expect(source).toContain('launchPolicyApplied(process.argv, process.env)')
    expect(source).toContain('applyChromiumLaunchPolicy(app.commandLine)')
  })

  it('the guard fails a tree whose entry point does not apply it', () => {
    const root = completeTree()
    write(
      root,
      guard.MAIN_ENTRY,
      ['export async function startElectronMain(app) {', '  return app', '}', ''].join('\n'),
    )

    const run = runCheck(root)
    expect(run.status).toBe(1)
    const found = checkOf(root, 'launch-policy')
    expect(found.ok).toBe(false)
    expect(found.detail).toContain('applyChromiumLaunchPolicy')
    expect(found.detail).toContain('launchPolicyApplied')
    expect(found.remedy).toMatch(/CHROMIUM_LAUNCH_POLICY/)
  })

  it('the guard states the platform rule and what it cannot do, on every run', () => {
    // The launch switch is a process-launch property. The guard proves the packaged
    // entry reports the gap; it cannot set the switch, and it says so rather than
    // letting a reader believe a per-user install is covered.
    const run = runCheck(buildTree)
    expect(run.stdout).toContain('CHROMIUM_LAUNCH_POLICY')
    expect(run.stdout).toContain('--no-sandbox')
    expect(run.stdout).toContain('ELECTRON_DISABLE_SANDBOX=1')
    expect(run.stdout).toMatch(/IO-2, IO-3/)
  })
})

// ---------------------------------------------------------------------------
// 7. The binary name is the documented command
// ---------------------------------------------------------------------------

describe('the declared binary is the command the installer documentation uses', () => {
  it('the operations runbook, the ADR and the README all type the same command', () => {
    const documents = [
      'docs/runbooks/io-5-operations-review.md',
      'docs/adr/ADR-006-global-install-no-per-repo-registry.md',
      'README.md',
    ].map((relative) => ({ relative, text: readFileSync(path.join(repoRoot, relative), 'utf8') }))

    // Every command a developer is told to type, read out of the fenced blocks a
    // runbook writes commands in. Prose is not read: "the install journey" and
    // "per-repository install is a step" are sentences, and treating them as commands
    // would make this assertion about English rather than about the manifest.
    const typed = new Set<string>()
    const lines: string[] = []
    for (const document of documents) {
      for (const line of fencedCommandLines(document.text)) {
        lines.push(line)
        const first = line.split(/[\s;|&]+/)[0]
        if (first !== undefined && first !== '') typed.add(first)
      }
    }
    expect(typed.size).toBeGreaterThan(0)

    // The four subcommands IO-FR-02..IO-FR-05 name are the ones the operations runbook
    // documents, written as a command a developer runs or quoted as the command the
    // requirement means.
    const runbook = documents[0]?.text ?? ''
    for (const subcommand of ['install', 'uninstall', 'status', 'doctor']) {
      const asCommand = lines.some((line) =>
        new RegExp(`^${guard.BIN_NAME}\\s+${subcommand}\\b`).test(line.trim()),
      )
      const asRequirement = runbook.includes(`\`${guard.BIN_NAME} ${subcommand}\``)
      expect(asCommand || asRequirement, `${guard.BIN_NAME} ${subcommand} is not documented`).toBe(true)
    }

    // And nothing types this product under any other name. A misspelling in a runbook
    // is the failure this catches: `agent-ping install` is a command that does not
    // exist, and a developer copies it verbatim. Paths are not spellings of a command,
    // so `XDG_STATE_HOME/agent-ping/` and `agent-ping.db` in the README's directory
    // tree are left alone.
    const variants = [...typed].filter(
      (token) =>
        /^agent[-_.]?ping/i.test(token) &&
        token !== guard.BIN_NAME &&
        !/[\\/]/.test(token) &&
        !/\.[a-z0-9]{1,4}$/i.test(token),
    )
    expect(variants, `documented as: ${variants.join(', ')}`).toEqual([])
  })

  it('the package name and the command name are the same string, as ADR-006 requires', () => {
    expect(realManifest.name).toBe(guard.BIN_NAME)
    expect(Object.keys(realManifest.bin)).toEqual([guard.BIN_NAME])
  })
})

// ---------------------------------------------------------------------------
// 5. The card document is not a dashboard open
// ---------------------------------------------------------------------------

describe('serving the packaged card document is not a dashboard open', () => {
  it('a 200 for /card.html moves no counter, and the dashboard itself moves it in the same run', async () => {
    // PRD 11 measures the unprompted dashboard pull. The card document is served by
    // the same route, over the same origin, under the same policy - by the surface
    // window, not by a person - so counting it would report a developer looking at
    // their dashboard every time a tool asked a question. This runs against the real
    // built artefact rather than a stand-in, so the document served is the one the
    // package ships.
    const builtCard = path.join(buildTree, 'dist', 'dashboard', 'card.html')
    expect(existsSync(builtCard), 'the build must have emitted the card document').toBe(true)

    const hub = await startHub({
      stateDir: temporaryDirectory('agent-ping-state-'),
      dashboardRoot: path.join(buildTree, 'dist', 'dashboard'),
      lifecycle: { installSignals: false },
    })
    openHubs.push(hub)

    expect(counterOf(await metricsOf(hub), 'dashboard_opens')).toBe(0)

    const card = await get(hub, '/card.html')
    expect(card.status).toBe(200)
    expect(card.text).toContain('data-card-surface')
    // The card's own two assets are the same two requests the live page makes.
    for (const asset of await assetHrefsOf(hub, '/card.html')) {
      expect((await get(hub, asset)).status, asset).toBe(200)
    }
    expect(counterOf(await metricsOf(hub), 'dashboard_opens')).toBe(0)

    // The dashboard itself, in the same run against the same hub, is what moves it -
    // so the zero above is a rule and not a counter that never fires.
    expect((await get(hub, '/')).status).toBe(200)
    expect(counterOf(await metricsOf(hub), 'dashboard_opens')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Helpers for the two repository-wide sweeps
// ---------------------------------------------------------------------------

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.codegraph', '.opencode'])

/** Every file in a tree, relative to its root, in a stable order. */
function walkTree(root: string): string[] {
  const found: string[] = []
  const walk = (prefix: string): void => {
    for (const entry of readdirSync(path.join(root, prefix)).sort()) {
      if (prefix === '' && SKIPPED_DIRECTORIES.has(entry)) continue
      const child = `${prefix}${entry}`
      if (statSync(path.join(root, child)).isDirectory()) walk(`${child}/`)
      else found.push(child)
    }
  }
  walk('')
  return found
}

/**
 * The command lines a document shows inside a fenced code block.
 *
 * A runbook's instructions are its fenced lines; everything else in it is prose, and
 * prose about a command ("the uninstall check", "per-repository install") is not a
 * spelling of the command.
 */
function fencedCommandLines(text: string): string[] {
  const lines: string[] = []
  let inside = false
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inside = !inside
      continue
    }
    if (!inside) continue
    const command = line.replace(/^\s*\$\s*/, '').trim()
    if (command === '' || command.startsWith('#')) continue
    lines.push(command)
  }
  return lines
}

/**
 * The file list npm itself would publish, from a dry run.
 *
 * `--ignore-scripts` because this suite is the thing that decides whether `prepack`
 * passes; letting the dry run invoke the guard would make a pack observation depend on
 * the answer it is being compared against.
 */
function npmPackList(root: string): string[] {
  const npm = npmTool()
  const result = spawnSync(
    npm.command,
    [...npm.args, 'pack', '--dry-run', '--ignore-scripts', '--json'],
    { cwd: root, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run failed: ${result.stderr || result.stdout}`)
  }
  const parsed = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>
  return (parsed[0]?.files ?? []).map((file) => file.path)
}

interface Fetched {
  readonly status: number
  readonly text: string
  headers: Record<string, string | string[] | undefined>
}

/** One request over a real loopback socket, one connection. */
function get(hub: RunningHub, pathname: string): Promise<Fetched> {
  const { hostname, port } = new URL(hub.origin)
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: hostname, port, path: pathname, method: 'GET', agent: false }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          text: Buffer.concat(chunks).toString('utf8'),
          headers: response.headers,
        }),
      )
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

/** The assets one served document names, as paths the hub would serve them at. */
async function assetHrefsOf(hub: RunningHub, pathname: string): Promise<string[]> {
  const document = await get(hub, pathname)
  const hrefs = [...document.text.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/g)].map((match) => match[1] as string)
  return hrefs
    .filter((href) => !href.startsWith('http') && !href.startsWith('#'))
    .map((href) => new URL(href, `${hub.origin}${pathname}`).pathname)
}

/** The metrics payload of a hub in this process. */
async function metricsOf(hub: RunningHub): Promise<MetricsPayload> {
  const response = await get(hub, '/api/metrics')
  expect(response.status).toBe(200)
  return JSON.parse(response.text) as MetricsPayload
}

function counterOf(payload: MetricsPayload, name: string): number {
  const reading = payload.counters.find((candidate) => candidate.counter === name)
  if (reading === undefined) {
    // The counter list is closed, so a missing one is a defect rather than a zero.
    throw new Error(`no ${name} reading in the payload; the counters are ${COUNTER_NAMES.join(', ')}`)
  }
  return reading.value
}
