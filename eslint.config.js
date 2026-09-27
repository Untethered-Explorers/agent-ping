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
  {
    // The card surface's preload, and the only file in the repository that uses
    // `require`. A preload in a renderer with `sandbox: true` is parsed by Chromium
    // as a plain script: it has no ESM context, and its `require` is a polyfill that
    // resolves `electron` and nothing else. Both were measured against the real
    // Electron 44.4.5 binary - a `.mjs` preload and a `.js` preload using `import`
    // fail with `SyntaxError: Cannot use import statement outside a module`, and
    // `require('./sibling')` fails with `module not found`. The file is `.cts` for
    // that reason, so this rule is off for it and for nothing else; the other half of
    // the rule, that nothing under `src` may reach a Node built-in from a renderer,
    // is a test in tests/notify/surface-channel.test.ts rather than a lint rule.
    files: ['src/notify/surface/preload.cts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
)
