#!/usr/bin/env node
// The single test entry point for this repository: `npm test -- <path...>`.
//
// Contract, owned by tooling-engineer and asserted by
// tests/tooling/runner-convention.test.ts (DP-FR-07):
//
//   1. A named path runs exactly the paths it is given, and nothing else.
//   2. A named path that selects zero test files exits non-zero. An empty
//      selection can never be reported as a pass.
//   3. Paths under tests/e2e are Playwright specs and are handed to the browser
//      runner. That project belongs to qa-engineer (LD-4); this script only
//      dispatches to it, and fails loudly when it is not installed yet.
//
// With no path, this runs the whole Vitest suite (every project). The browser
// journey is not part of that run: use `npm run test:e2e`.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** Where Playwright specs live. qa-engineer's playwright.config.ts owns the rest. */
const E2E_ROOT = 'tests/e2e'
/** Accepted spellings of a Playwright config, in the order Playwright looks for them. */
const PLAYWRIGHT_CONFIGS = [
  'playwright.config.ts',
  'playwright.config.mts',
  'playwright.config.js',
  'playwright.config.mjs',
]

const bin = (name) =>
  path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)

const toPosix = (value) => value.split(path.sep).join('/').replace(/^\.\//, '')

const isE2EPath = (value) => {
  const normalized = toPosix(value)
  return normalized === E2E_ROOT || normalized.startsWith(`${E2E_ROOT}/`)
}

function run(command, args, label) {
  process.stdout.write(`\n[test] ${label}: ${path.basename(command)} ${args.join(' ')}\n`)
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' })
  if (result.error) {
    process.stderr.write(`\n[test] ${label} could not start: ${result.error.message}\n`)
    return 1
  }
  if (result.signal) {
    process.stderr.write(`\n[test] ${label} was terminated by signal ${result.signal}\n`)
    return 1
  }
  return result.status ?? 1
}

const argv = process.argv.slice(2)
const paths = argv.filter((arg) => !arg.startsWith('-'))
const flags = argv.filter((arg) => arg.startsWith('-'))
const watch = flags.some((flag) => flag === '--watch' || flag === '-w' || flag === '--watch=true')
const vitestFlags = flags.filter((flag) => !(flag === '--watch' || flag === '-w' || flag === '--watch=true'))

const e2ePaths = paths.filter(isE2EPath)
const vitestPaths = paths.filter((value) => !isE2EPath(value))

if (e2ePaths.length > 0) {
  const config = PLAYWRIGHT_CONFIGS.find((name) => existsSync(path.join(repoRoot, name)))
  if (config === undefined) {
    process.stderr.write(
      `\n[test] ${E2E_ROOT} is a Playwright project, but no playwright config exists yet.\n` +
        `[test] Expected one of: ${PLAYWRIGHT_CONFIGS.join(', ')}\n`,
    )
    process.exit(1)
  }
  if (!existsSync(bin('playwright'))) {
    process.stderr.write(
      `\n[test] ${E2E_ROOT} is a Playwright project, but the Playwright CLI is not installed.\n` +
        `[test] Run \`npm install\` with @playwright/test as a devDependency (LD-4), then retry.\n`,
    )
    process.exit(1)
  }
}

let status = 0

if (e2ePaths.length > 0) {
  status =
    run(bin('playwright'), ['test', ...e2ePaths, ...flags], `browser suite (${e2ePaths.join(', ')})`) ||
    status
}

if (paths.length === 0 || vitestPaths.length > 0) {
  if (!existsSync(bin('vitest'))) {
    process.stderr.write('\n[test] the Vitest CLI is not installed; run `npm install` first\n')
    process.exit(1)
  }
  const vitestArgs = watch
    ? [...vitestFlags, ...vitestPaths]
    : ['run', ...vitestFlags, ...vitestPaths]
  const label = watch
    ? `watch mode${vitestPaths.length > 0 ? ` (${vitestPaths.join(', ')})` : ''}`
    : `vitest${vitestPaths.length > 0 ? ` (${vitestPaths.join(', ')})` : ' (whole suite)'}`
  status = run(bin('vitest'), vitestArgs, label) || status
}

if (status !== 0) {
  process.stderr.write(
    `\n[test] failed${paths.length > 0 ? ` for ${paths.join(', ')}` : ''} (exit ${status})\n`,
  )
}

process.exit(status)
