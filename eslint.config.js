// ESLint flat config. Two halves, so no core rule is ever applied to TypeScript
// and no typescript-eslint rule is ever applied to plain JavaScript:
//   - scripts/*.mjs and any future config .js file: core recommended + Node globals
//   - src/ and tests/: typescript-eslint recommended, which turns off the core
//     rules TypeScript already enforces (including no-undef)
//
// It passes on an empty source set, so DP-1 stays re-runnable in isolation.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// Declared explicitly instead of pulling in a globals package: the only globals
// the plain-JavaScript half needs are the Node ones the scripts use.
const nodeGlobals = {
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  process: 'readonly',
  queueMicrotask: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly',
}

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'docs/**',
      // Vendored agent and skill assets, including minified third-party bundles.
      // They are tooling for this repository, not source in it.
      '.opencode/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals,
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
)
