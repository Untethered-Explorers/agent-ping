#!/usr/bin/env node
// One build command for the three build entry points in PRD 6.2 / ADR-007:
//
//   1. Electron main and the CLI via tsc        (tsconfig.build.json -> dist/main)
//   2. Dashboard via Vite                        (vite build, config owned by dashboard-engineer)
//   3. Plugin: no build step                     (loaded as directly loadable TypeScript)
//
// Every step reports whether it built or was skipped, and a step that runs and
// fails fails this command. A step whose inputs do not exist yet is reported as
// skipped, never counted as a build, so a green `npm run build` on an empty
// source set says exactly that: nothing to build.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** Node-hosted concerns, compiled by tsc. The dashboard and plugin are not. */
const TSC_ROOTS = ['src/main', 'src/hub', 'src/storage', 'src/domain', 'src/notify', 'src/cli']
const DASHBOARD_ROOTS = ['src/dashboard']

const bin = (name) =>
  path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)

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

function run(command, args, label) {
  process.stdout.write(`\n[build] ${label}\n`)
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' })
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

// 1. Electron main and CLI via tsc.
const mainSources = tsSources(TSC_ROOTS)
if (mainSources.length === 0) {
  steps.push({ name: 'main (tsc)', outcome: 'skipped', detail: `no TypeScript sources under ${TSC_ROOTS.join(', ')}` })
} else if (!existsSync(bin('tsc'))) {
  status = fail('the TypeScript compiler is not installed; run `npm install` first')
  steps.push({ name: 'main (tsc)', outcome: 'failed', detail: 'tsc not installed' })
} else {
  const code = run(bin('tsc'), ['-p', 'tsconfig.build.json'], `main (tsc): ${mainSources.length} source file(s) -> dist/main`)
  status = code || status
  steps.push({ name: 'main (tsc)', outcome: code === 0 ? 'built' : 'failed', detail: code === 0 ? `${mainSources.length} source file(s) -> dist/main` : `exit ${code}` })
}

// 2. Dashboard via Vite.
const dashboardEntries = htmlEntries(DASHBOARD_ROOTS)
if (dashboardEntries.length === 0) {
  steps.push({ name: 'dashboard (vite)', outcome: 'skipped', detail: `no HTML entry under ${DASHBOARD_ROOTS.join(', ')}` })
} else if (!existsSync(bin('vite'))) {
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
  const code = run(bin('vite'), ['build'], `dashboard (vite): ${dashboardEntries.join(', ')}`)
  status = code || status
  steps.push({ name: 'dashboard (vite)', outcome: code === 0 ? 'built' : 'failed', detail: code === 0 ? dashboardEntries.join(', ') : `exit ${code}` })
}

// 3. Plugin: no build step by design.
steps.push({ name: 'plugin', outcome: 'no build step', detail: 'loaded directly as TypeScript' })

function fail(message) {
  process.stderr.write(`\n[build] ${message}\n`)
  return 1
}

process.stdout.write('\n[build] summary\n')
for (const step of steps) {
  process.stdout.write(`[build]   ${step.name}: ${step.outcome} (${step.detail})\n`)
}
const built = steps.filter((step) => step.outcome === 'built').length
process.stdout.write(`[build] ${built} built, ${steps.filter((s) => s.outcome === 'skipped').length} skipped, exit ${status}\n`)

if (status === 0 && built === 0) {
  process.stdout.write('[build] nothing to build: no compiled entry points exist in this checkout yet\n')
}

process.exit(status)
