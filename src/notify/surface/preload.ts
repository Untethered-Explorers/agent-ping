// The card surface's preload: the file the surface window's `webPreferences` names, where
// that file is, and the one measured requirement that decides its name (NT-FR-02, NT-FR-12,
// ADR-012).
//
// WHAT THIS FILE IS
// The preload's *address*, and nothing else: the source file tsc compiles, the file that
// compile emits, and the path the window is given. It imports no Electron module, opens
// nothing and sends nothing, so it can be imported by a test, by the surface host and by
// anything that has to answer "which preload is this window running" without starting a
// window.
//
// THE BODY IS `./preload.cts`, AND THIS IS WHY THAT IS NOT A CONVENTION
// The card document runs with `contextIsolation: true`, `nodeIntegration: false` and
// `sandbox: true`, so it has no `require` of its own and no `ipcRenderer`. The one way a
// card model reaches it is a preload, and a preload in a *sandboxed* renderer is parsed by
// Chromium as a plain script: it has no ESM context, and its `require` is a polyfill that
// resolves `electron` and nothing else. Both were measured against the real Electron
// 44.4.5 binary on the authoring machine (Ubuntu 24.04, X11 :1), driving a real
// `BrowserWindow` with this product's own `SURFACE_WINDOW_OPTIONS`:
//
//   - a `.mjs` preload, and a `.js` preload whose source used `import`, both fail with
//     `SyntaxError: Cannot use import statement outside a module`, with no `preload-error`
//     and no other trace;
//   - `require('./a-sibling')` in a sandboxed preload fails with `module not found`, so
//     the body cannot be split and cannot import `channel.ts` at run time.
//
// A `preload.ts` cannot be that body, and the reason is this repository's own build. The
// package is `"type": "module"` and `tsconfig.build.json` compiles with `module:
// "NodeNext"`, so a `.ts` source there is an ES module and tsc emits a module marker into
// it - verified here: a `.ts` file with no `import` and no `export` still emits a trailing
// `export {};` - which is exactly the syntax a plain-script parse rejects. A `.cts` source
// is always compiled to CommonJS, and `./preload.cts` therefore builds to
// `./preload.cjs`, which the renderer can load.
//
// So this module exists as the one that *names* that file, and `./preload.cts` is the one
// that *is* it. `tests/notify/surface-channel.test.ts` asserts the two agree, asserts the
// emitted name, and reads the body from `CARD_PRELOAD_SOURCE_FILE` rather than repeating
// the path, so neither half can drift from the other (NT-FR-12).
//
// WHY NOT A SEPARATE BUILD FOR ONE PRELOAD
// The alternative - a second tsconfig with `module: "commonjs"` so a `preload.ts` could be
// emitted as a plain script - costs a second build entry point, a second output path to
// reason about in packaging, and a divergence between what typechecks and what runs. The
// `.cts` extension costs one line in `tsconfig.json`, one in `tsconfig.build.json` and one
// scoped lint override, and it is the mechanism TypeScript provides for exactly this.
//
// VERIFICATION STATE, STATED THE SAME WAY IN EVERY FILE HERE
// Implemented and unit-tested: the address, the resolution and the one key it adds to the
// window's `webPreferences`, all in this repository's suite, plus a source-level assertion
// that the emitted name is the one a sandboxed preload can load. Live-verified against the
// real Electron 44.4.5 binary on the authoring machine, where the exposed surface arrived
// in the document with a key set of exactly `remove` and `show`, a model crossed and
// rendered, and the page had neither `process` nor `require`. What that run cannot say is
// anything about how the three desktops composite the window (NT-FR-03, APX-CON-06).
//
// NO TELEMETRY, NO SOUND, NO PLATFORM NOTIFICATION
// This module opens no socket, plays no sound, spawns nothing and names no notification
// mechanism. The only thing it contributes to the surface is a path (APX-CON-12, APX-CON-04,
// NT-FR-02, NT-FR-11).

import { fileURLToPath } from 'node:url'

/**
 * The preload's source file, as a repository-relative path.
 *
 * A constant rather than a repetition so the tests that read the body, and the build
 * config that compiles it, and this comment can all be checked against one name. The
 * extension is the point: see the header.
 */
export const CARD_PRELOAD_SOURCE_FILE = 'src/notify/surface/preload.cts'

/**
 * The file tsc emits for `CARD_PRELOAD_SOURCE_FILE`, and the name the window is given.
 *
 * `.cts` is compiled to `.cjs` whatever the module setting says, which is the whole reason
 * the source is a `.cts` at all. A `preload.js` would be an ES module here and would not
 * load.
 */
export const CARD_PRELOAD_FILE_NAME = 'preload.cjs'

/**
 * The format the preload body has to be in, named because it is a decision.
 *
 * One value, and it is not a preference: it is what a sandboxed renderer can parse.
 */
export const CARD_PRELOAD_FORMAT = 'commonjs'

/**
 * Why the preload body is CommonJS, in one sentence, for `doctor` and for a reader.
 *
 * The reason lives here rather than only in the header comment because a comment is not
 * something an operator can be told, and this is the sentence an operator would need if a
 * card never arrived.
 */
export const CARD_PRELOAD_SANDBOX_REQUIREMENT: string =
  'a preload in a renderer with sandbox: true is parsed as a plain script, so it has no ESM ' +
  'context: a .mjs preload and a .js preload containing import both fail with SyntaxError: ' +
  "Cannot use import statement outside a module (measured against Electron 44.4.5), and a " +
  "sandboxed preload's require resolves electron and nothing else, so the body is one file. " +
  'This package is an ES module, so tsc emits a module marker into any .ts it compiles; the ' +
  'body is therefore a .cts source, which is always compiled to CommonJS, and the window is ' +
  'given the .cjs file beside this module (NT-FR-12).'

/**
 * The preload's path beside a given module, or the bare file name when the environment
 * cannot say.
 *
 * The packaged application runs the compiled `dist/main/notify/surface/electron-host.js`,
 * so its `import.meta.url` is a `file:` URL and the answer is the absolute path beside it. A
 * module loader that serves files some other way - Vite's test runner, which hands modules
 * to the test process over its own dev server - has no such path, and computing one from
 * that URL would produce a path into a test server. So the bare file name is recorded
 * instead: still a string, still the name the build emits, and never a silent wrong answer.
 *
 * The parameter is there so both branches are testable without a test-only override, and
 * it is the module's own URL by default rather than a constant so a caller cannot point the
 * surface at somebody else's preload.
 */
export function resolveCardPreloadPath(moduleUrl: string = import.meta.url): string {
  try {
    return fileURLToPath(new URL(`./${CARD_PRELOAD_FILE_NAME}`, moduleUrl))
  } catch {
    return `./${CARD_PRELOAD_FILE_NAME}`
  }
}

/**
 * The preload path the card window's `webPreferences` carries.
 *
 * Resolved beside *this* module, which is compiled to
 * `dist/main/notify/surface/preload.js` and sits beside the emitted
 * `dist/main/notify/surface/preload.cjs`. A relative name would break the moment either
 * moved and an absolute path written here would break on every machine but this one.
 *
 * A hub started from the TypeScript sources in a checkout has no `.cjs` beside
 * `preload.ts` - the same class of gap NT-9's preflight already reports for `schema.sql` -
 * and the preload is then refused by Electron, which surfaces as a card that never arrives
 * rather than as a silent success.
 */
export const CARD_PRELOAD_PATH: string = resolveCardPreloadPath()
