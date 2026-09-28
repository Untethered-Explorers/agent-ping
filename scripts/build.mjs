#!/usr/bin/env node
// One build command for the three build entry points in PRD 6.2 / ADR-007, plus
// the one file none of them can emit:
//
//   1. Electron main and the CLI via tsc        (tsconfig.build.json -> dist/main)
//   2. Dashboard via Vite                        (vite build, config owned by dashboard-engineer)
//   3. Plugin: no build step                     (loaded as directly loadable TypeScript)
//   4. The durable schema, copied beside the emitted store
//
// Every step reports whether it built or was skipped, and a step that runs and
// fails fails this command. A step whose inputs do not exist yet is reported as
// skipped, never counted as a build, so a green `npm run build` on an empty
// source set says exactly that: nothing to build.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeTool } from './lib/node-tool.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** Node-hosted concerns, compiled by tsc. The dashboard and plugin are not. */
const TSC_ROOTS = ['src/main', 'src/hub', 'src/storage', 'src/domain', 'src/notify', 'src/cli']
const DASHBOARD_ROOTS = ['src/dashboard']

function walk(dir, onFile) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, onFile)
    else onFile(full)
  }
}

const relative = (file) => path.relative(repoRoot, file).split(path.sep).join('/')

/** Every TypeScript source under the given roots, excluding colocated tests. */
function tsSources(roots) {
  const found = []
  for (const root of roots) {
    walk(path.join(repoRoot, root), (file) => {
      if (/\.(ts|tsx|mts)$/.test(file) && !/\.test\.tsx?$/.test(file)) found.push(relative(file))
    })
  }
  return found
}

function htmlEntries(roots) {
  const found = []
  for (const root of roots) {
    walk(path.join(repoRoot, root), (file) => {
      if (file.endsWith('.html')) found.push(relative(file))
    })
  }
  return found
}

function run(tool, toolArgs, label) {
  process.stdout.write(`\n[build] ${label}\n`)
  const result = spawnSync(tool.command, [...tool.args, ...toolArgs], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (result.error) {
    process.stderr.write(`\n[build] ${label} could not start: ${result.error.message}\n`)
    return 1
  }
  if (result.signal) {
    process.stderr.write(`\n[build] ${label} was terminated by signal ${result.signal}\n`)
    return 1
  }
  return result.status ?? 1
}

const steps = []
let status = 0

// Resolved once, through the tool's own package manifest rather than the `.bin`
// shim directory: on Windows those shims are `.cmd` batch files, which Node refuses
// to spawn without a shell, and adding a shell to work around that is exactly what
// this repository's cross-platform rules forbid. See scripts/lib/node-tool.mjs.
const tsc = nodeTool('typescript', 'tsc')
const vite = nodeTool('vite', 'vite')

// 1. Electron main and CLI via tsc.
const mainSources = tsSources(TSC_ROOTS)
if (mainSources.length === 0) {
  steps.push({ name: 'main (tsc)', outcome: 'skipped', detail: `no TypeScript sources under ${TSC_ROOTS.join(', ')}` })
} else if (!tsc.exists) {
  status = fail('the TypeScript compiler is not installed; run `npm install` first')
  steps.push({ name: 'main (tsc)', outcome: 'failed', detail: 'tsc not installed' })
} else {
  const code = run(tsc, ['-p', 'tsconfig.build.json'], `main (tsc): ${mainSources.length} source file(s) -> dist/main`)
  status = code || status
  steps.push({ name: 'main (tsc)', outcome: code === 0 ? 'built' : 'failed', detail: code === 0 ? `${mainSources.length} source file(s) -> dist/main` : `exit ${code}` })
}

// 2. Dashboard via Vite.
const dashboardEntries = htmlEntries(DASHBOARD_ROOTS)
if (dashboardEntries.length === 0) {
  steps.push({ name: 'dashboard (vite)', outcome: 'skipped', detail: `no HTML entry under ${DASHBOARD_ROOTS.join(', ')}` })
} else if (!vite.exists) {
  status = fail('the Vite CLI is not installed; run `npm install` first')
  steps.push({ name: 'dashboard (vite)', outcome: 'failed', detail: 'vite not installed' })
} else {
  // vite.config.ts is owned by dashboard-engineer (DP-2). Without it Vite
  // defaults to the repository root and cannot find the entry, so say so
  // rather than leaving a bare rollup resolution error.
  const viteConfig = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'].find(
    (name) => existsSync(path.join(repoRoot, name)),
  )
  if (viteConfig === undefined) {
    process.stderr.write(
      `\n[build] dashboard (vite): found ${dashboardEntries.join(', ')} but no vite config in the repository root.\n` +
        '[build] vite.config.ts belongs to dashboard-engineer (DP-2); until it exists this step cannot succeed.\n',
    )
  }
  const code = run(vite, ['build'], `dashboard (vite): ${dashboardEntries.join(', ')}`)
  status = code || status
  steps.push({ name: 'dashboard (vite)', outcome: code === 0 ? 'built' : 'failed', detail: code === 0 ? dashboardEntries.join(', ') : `exit ${code}` })
}

// 3. Plugin: no build step by design.
steps.push({ name: 'plugin', outcome: 'no build step', detail: 'loaded directly as TypeScript' })

// 4. The durable schema beside the emitted store.
//
// `tsc` emits JavaScript only, and src/storage/db.ts loads the schema with
// `new URL('./schema.sql', import.meta.url)` - the file beside the module, not
// one it names by path. So a hub started from this build could not open its own
// log, and the reader was told to copy the file by hand (EL-1, recorded for
// tooling-engineer under DP-1 and packaging-engineer under IO-1). It is here
// because it is a build step: nothing about it is packaging metadata, and the
// package `files` allowlist only has to let the result through.
//
// A copy rather than an emit, deliberately: the schema is a hand-written SQL file
// and tsc has no way to carry it, so this is the only place its content can be
// decided. It is copied byte for byte, and the step reports a failure rather than
// letting a package be built with a store that cannot start.
const schemaSource = path.join(repoRoot, 'src', 'storage', 'schema.sql')
const schemaTarget = path.join(repoRoot, 'dist', 'main', 'storage', 'schema.sql')
const stagedSchema = `${schemaTarget}.partial`
if (!existsSync(schemaSource)) {
  steps.push({
    name: 'schema (copy)',
    outcome: 'skipped',
    detail: 'no src/storage/schema.sql in this checkout',
  })
} else {
  let copied = false
  let detail = 'src/storage/schema.sql -> dist/main/storage/schema.sql'
  try {
    mkdirSync(path.dirname(schemaTarget), { recursive: true })
    // Staged and renamed rather than copied in place, so a reader in another process -
    // a hub starting while this build runs, say - reads either the previous file or the
    // whole new one and never a half-written schema. The same discipline the global
    // plugin installer uses to publish its generated file.
    copyFileSync(schemaSource, stagedSchema)
    renameSync(stagedSchema, schemaTarget)
    copied = true
  } catch (cause) {
    rmSync(stagedSchema, { force: true })
    detail = `${detail} - ${cause.message}`
    status = fail('the durable schema could not be copied into the build output')
  }
  steps.push({ name: 'schema (copy)', outcome: copied ? 'copied' : 'failed', detail })
}

function fail(message) {
  process.stderr.write(`\n[build] ${message}\n`)
  return 1
}

process.stdout.write('\n[build] summary\n')
for (const step of steps) {
  process.stdout.write(`[build]   ${step.name}: ${step.outcome} (${step.detail})\n`)
}
const built = steps.filter((step) => step.outcome === 'built' || step.outcome === 'copied').length
process.stdout.write(`[build] ${built} built, ${steps.filter((s) => s.outcome === 'skipped').length} skipped, exit ${status}\n`)

if (status === 0 && built === 0) {
  process.stdout.write('[build] nothing to build: no compiled entry points exist in this checkout yet\n')
}

process.exit(status)
