// The executable and arguments for a tool that lives in `node_modules`, on every
// supported platform.
//
// WHY NOT `node_modules/.bin/<name>`
//
// On Linux and macOS `node_modules/.bin/vitest` is a symlink to a `.mjs` file with a
// `#!/usr/bin/env node` shebang, so spawning the path runs Node. On Windows the same
// directory holds a generated `vitest.cmd` batch shim, and Node refuses to spawn a
// `.cmd` or `.bat` without a shell: since the fix for CVE-2024-27980 (Node 18.20.2,
// 20.12.2, 21.7.3, and every later release including the 22.x this project requires)
// that call fails with `EINVAL`. Adding `shell: true` would fix it by reintroducing
// the shell, which is the thing this repository's rules exist to avoid: it brings back
// argument quoting, PATH-dependent command resolution, and a class of injection this
// code does not otherwise have.
//
// So the shim is not used at all. The tool's own `bin` entry in its `package.json`
// names a real JavaScript file, and that file is run by the interpreter already
// running this script - `process.execPath`. An executable plus an argument array of
// plain paths, identical on all three platforms, with no shell anywhere.
//
// WHY `npm_execpath` FOR npm ITSELF
//
// npm is not in `node_modules`; it is the package manager that invoked this script,
// and it told us how it was reached. `npm_execpath` is the JavaScript entry point of
// the *running* npm, so the same interpreter-plus-path shape applies. The fallback is
// a bare `npm` for the case where this module is loaded outside an npm script, and on
// Windows that fallback needs the `.cmd` suffix and a shell, because there is no
// `npm.js` to point at - which is why the two paths are kept visibly different rather
// than made to look alike.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root, from this file's own location: `<root>/scripts/lib/`. */
export const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

/**
 * One tool's invocation: the interpreter to run, and the arguments that follow it.
 *
 * `args` begins with the tool's own entry file, so a caller appends its real
 * arguments and never has to know how the tool was found. `exists: false` means the
 * tool is not installed, and a caller reports that rather than failing obscurely.
 *
 * @typedef {{ command: string, args: readonly string[], exists: boolean }} NodeToolInvocation
 */

const UNRESOLVED = Object.freeze({
  command: '',
  args: Object.freeze([]),
  exists: false,
})

/**
 * The `bin` entry of an installed package, as a real JavaScript file path.
 *
 * Reads the package's own manifest rather than guessing at the `.bin` directory, so
 * the answer does not depend on how npm happened to lay out this particular install.
 * A package may declare `bin` as a string (one tool, named after the package) or as
 * an object (several tools); both spellings are handled.
 *
 * @param {string} packageName
 * @param {string} toolName
 * @returns {string | null}
 */
function binEntryOf(packageName, toolName) {
  const manifest = path.join(repoRoot, 'node_modules', packageName, 'package.json')
  if (!existsSync(manifest)) return null
  let parsed
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch {
    // An unreadable manifest is an install that cannot be used, and reporting "not
    // installed" is the honest answer; propagating a parse error here would name a
    // JSON problem rather than the missing tool a caller is about to explain.
    return null
  }
  const bin = parsed?.bin
  if (typeof bin === 'string') {
    return path.join(repoRoot, 'node_modules', packageName, bin)
  }
  if (bin !== null && typeof bin === 'object') {
    const relative = bin[toolName]
    if (typeof relative === 'string') return path.join(repoRoot, 'node_modules', packageName, relative)
  }
  return null
}

/**
 * Run an installed tool with this Node process, on any platform.
 *
 * `packageName` is the npm package and `toolName` the command name inside it; they
 * differ for `tsc` (in `typescript`) and match for most others.
 *
 * @returns {NodeToolInvocation}
 */
export function nodeTool(packageName, toolName) {
  const entry = binEntryOf(packageName, toolName)
  if (entry === null || !existsSync(entry)) return UNRESOLVED
  return { command: process.execPath, args: [entry], exists: true }
}

/**
 * Run npm itself, on any platform.
 *
 * Under an npm script - which is how every caller here is invoked - `npm_execpath`
 * names the running npm's JavaScript entry, so this is the same
 * interpreter-plus-path shape as {@link nodeTool}. Outside one there is no such file
 * to name, and the fallback is a bare command name: `npm` on POSIX, and on Windows
 * `npm.cmd` under a shell, because the Windows npm is a batch shim and there is no
 * JavaScript entry to spawn directly.
 *
 * @returns {NodeToolInvocation}
 */
export function npmTool() {
  const entry = process.env['npm_execpath']
  if (typeof entry === 'string' && entry.trim() !== '' && existsSync(entry)) {
    return { command: process.execPath, args: [entry], exists: true }
  }
  if (process.platform === 'win32') {
    return { command: 'npm.cmd', args: [], exists: true }
  }
  return { command: 'npm', args: [], exists: true }
}
