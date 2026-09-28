// The browser runner's configuration (LD-4: LD-FR-03, LD-FR-05, LD-FR-09, LD-FR-10).
//
// WHY THIS FILE EXISTS ALONGSIDE vitest.config.ts
// Two runners, two disjoint file sets, and a checked boundary between them:
// vitest.config.ts collects `tests/**/*.test.ts` and explicitly excludes
// `tests/e2e/**`, and this config collects `tests/e2e/**/*.spec.ts`. Neither can
// select the other's files, so `npm test` (Vitest) and `npm run test:e2e`
// (Playwright) cannot both claim the same test, and tools/tooling's
// runner-convention test asserts the dispatch in scripts/run-tests.mjs hands an
// `tests/e2e` path to this runner rather than to Vitest.
//
// WHAT THE CONFIG DECIDES, AND WHY
//
//   workers: 1, fullyParallel: false
//     One hub serves every journey, on one port band, in one temporary state
//     directory, and a journey asserts a pending count it established itself. Two
//     workers would each start their own hub and race for the port, and the
//     journeys would interleave their pending sets into assertions that can no
//     longer name what they expected. This suite is about one hub and one page.
//
//   forbidOnly
//     A `.only` left in a spec silently reduces the suite to one journey, and a
//     green run of one journey is exactly the failure the journey ledger exists
//     to catch. `forbidOnly` is always on here rather than only in CI, because the
//     ledger catches the reduction anyway and this catches it earlier.
//
//   no `globalSetup`, no `webServer`
//     The hub is not started by the runner. It is started by the suite's own
//     fixture against a temporary state directory, because the product's own
//     runtime file is how a hub is discovered and a runner-owned server would not
//     publish one.
//
//   globalTeardown
//     The half of "a green result cannot mean nothing was exercised" that lives
//     inside the runner: it reads the journey ledger, prints every journey that
//     ran, and fails the run when the list is short. scripts/verify-dashboard-e2e.mjs
//     makes the same judgement around the runner, so `npm test -- tests/e2e/...`
//     and the script cannot disagree about whether a run proved anything.
//
// THE BROWSER
// Chromium, headless, from Playwright's own download. `scripts/verify-dashboard-e2e.mjs`
// installs it and fails loudly when it cannot; nothing here degrades to a
// different engine. The GPU flags exist because this page renders with PixiJS into
// a WebGL canvas, and headless Chromium on a machine with no GPU needs software
// rasterisation to get one - the same measured setup the jsdom suites' browser
// counterpart used. The content-security policy is NOT bypassed: the hub's strict
// `script-src 'self'` / `style-src 'self'` is part of what is being proved (LD-3
// found that an injected `<style>` element is refused by it), and a run that
// switched the policy off would be proving a page no one can load.

import { defineConfig, devices } from '@playwright/test'

/** The system-browser fallback, set by scripts/verify-dashboard-e2e.mjs and nothing else. */
const BROWSER_CHANNEL_ENV = 'AGENT_PING_E2E_BROWSER_CHANNEL'

/**
 * The environment variable carrying this run's identity to every worker.
 *
 * Written here at module scope rather than in a `globalSetup`, because the thing
 * that has to know a run's identity is the main process (it judges) and the workers
 * (they record), and the main process loads this file before it spawns any worker.
 * A worker therefore inherits the value through the environment, finds it already
 * set, and keeps it: every record in a journey ledger can be attributed to the run
 * that made it.
 */
export const E2E_RUN_ID_ENV = 'AGENT_PING_E2E_RUN_ID'

/**
 * This run's identity, as every process in the run sees it.
 *
 * `scripts/verify-dashboard-e2e.mjs` chooses one before it starts the runner, so the
 * script can tell this run's ledger from the one the previous run left on disk. Run
 * directly - `npm run test:e2e`, or `npm test -- tests/e2e/...` - there is no such
 * chooser, so this file makes one from the process id and the clock.
 *
 * It exists because of a hole it closes. `playwright test --pass-with-no-tests` with
 * a filter that matches nothing collects nothing, runs no `beforeAll`, and so writes
 * no ledger - and a teardown that reads the ledger would then read the *previous*
 * run's seven passed journeys and report a green run that executed nothing. A ledger
 * carrying the run that wrote it cannot be read as another run's evidence.
 */
export const E2E_RUN_ID = process.env[E2E_RUN_ID_ENV] ?? `${String(process.pid)}-${Date.now().toString(36)}`
process.env[E2E_RUN_ID_ENV] = E2E_RUN_ID

/** A short journey budget. The waits inside the spec are the product's own. */
const TEST_TIMEOUT_MS = 120_000
/** An assertion's own budget, kept well inside the test's. */
const EXPECT_TIMEOUT_MS = 20_000

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  // The suite's own artefacts live under test-results/, which .gitignore already
  // covers, and the per-test output is kept apart from the two ledgers the
  // teardown and the script read: Playwright clears its output directory at the
  // start of a run, and a ledger that lives inside it would be deleted by the run
  // that is writing it.
  outputDir: 'test-results/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: TEST_TIMEOUT_MS,
  expect: { timeout: EXPECT_TIMEOUT_MS },
  // A short, readable report for a person, and a machine-readable one next to the
  // ledgers. `list` is what makes "which journeys ran" legible without opening a
  // file; the JSON is what a later tool would read.
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/dashboard-e2e-report.json' }],
  ],
  globalTeardown: './tests/e2e/global-teardown.ts',
  use: {
    ...devices['Desktop Chrome'],
    // A viewport small enough that the canvas overflows the page and the
    // scrolling surface is real rather than decorative, which is what LD-2's
    // prototype review asked to be able to see.
    viewport: { width: 1000, height: 640 },
    // `bypassCSP` stays off, and `ignoreHTTPSErrors` is irrelevant on loopback.
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: [
        // Software WebGL for the PixiJS canvas, on a machine with no GPU. Without
        // one of these the page mounts and then paints nothing, which would look
        // like a product fault rather than a rendering-environment one.
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-gpu',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Set only when the Playwright download was blocked and the script found
        // a system Chrome. That is a different recorded path with its own
        // provenance in the evidence file, not a quieter version of this one.
        ...(process.env[BROWSER_CHANNEL_ENV] === 'chrome' ? { channel: 'chrome' } : {}),
      },
    },
  ],
})
