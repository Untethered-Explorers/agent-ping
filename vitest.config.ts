// Vitest is the single test runner for every non-browser suite (ADR-007: one
// toolchain). The browser suite is Playwright's, configured by qa-engineer under
// LD-4 in playwright.config.ts; see scripts/run-tests.mjs for the dispatch.
//
// Runner convention (DP-FR-07), verified by tests/tooling/runner-convention.test.ts:
//   - `npm test -- <path>` runs exactly the paths it is given
//   - a path that selects zero test files exits non-zero
//   passWithNoTests is therefore false and must never be flipped to true: a green
//   result has to mean real assertions ran.
import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

const alias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
}

// Vitest collects only *.test.ts. The browser suite lives in tests/e2e as
// *.spec.ts (qa-engineer, LD-4), so the two runners can never select the same
// file and Vitest never tries to collect a Playwright spec.
const testFiles = 'tests/**/*.test.ts'
// Anything under tests/dashboard/ runs in jsdom without a per-file docblock.
const dashboardTestFiles = 'tests/dashboard/**/*.test.ts'

export default defineConfig({
  resolve: { alias },
  test: {
    // No root-level include: `extends: true` merges include arrays, so a root
    // include would make every file match both projects and run twice.
    passWithNoTests: false,
    // The runner-convention test spawns real nested `npm test` runs, so the
    // default 5s budget is not enough for it.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          include: [testFiles],
          exclude: [...configDefaults.exclude, 'tests/dashboard/**', 'tests/e2e/**'],
        },
      },
      {
        extends: true,
        resolve: { alias },
        test: {
          name: 'dashboard',
          environment: 'jsdom',
          include: [dashboardTestFiles],
        },
      },
    ],
  },
})
