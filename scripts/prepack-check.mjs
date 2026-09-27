#!/usr/bin/env node
// The packaging guard (IO-FR-01, IO-1, ADR-007, ADR-006).
//
// WHAT THIS IS FOR
// `npm publish` and `npm install -g` hand a developer a directory. Everything in
// this file exists to make one promise that can be checked mechanically:
//
//   a package that passes this check can be started, and a package that cannot
//   cannot be published.
//
// So the check is a list of named questions about a tree, each with exactly one
// remedy, a non-zero exit when any answer is no, and aligned output so the failure
// list reads like a check list rather than a stack trace. It never repairs
// anything: a guard that quietly created a missing artefact would be reporting on
// itself instead of on the package.
//
// WHAT IT CHECKS, AND WHY EACH ONE IS HERE
//
//   manifest            the manifest parses and names the product and a version.
//   binary              the declared `bin` names one command, and the file it names
//                       is in the tree. A package whose binary is missing installs
//                       a command that cannot run.
//   electron-main       the `main` entry the installed Electron loads exists.
//   launch-policy       the built entry applies and reports the Chromium
//                       process-sandbox launch policy (CHROMIUM_LAUNCH_POLICY in
//                       src/notify/surface/electron-host.ts). A package that would
//                       abort at startup on a per-user install must not ship.
//   durable-schema      src/storage/schema.sql reached the build output. The store
//                       reads it with `new URL('./schema.sql', import.meta.url)`, so
//                       tsc's JavaScript-only output cannot open its log without it.
//   dashboard           the three built documents, and every asset they reference.
//   plugin-source       the generator the installer calls, and the exact set of
//                       modules it inlines, all present and all shipped.
//   files-allowlist     every artefact above is covered by `files`.
//   files-exclusions    nothing that must not ship is: no source map, no
//                       declaration, no test, no development-only configuration.
//
// THE PLUGIN FILE IS GENERATED, NOT BUILT, AND THAT IS THE POINT
// OA-FR-01 installs one file into opencode's global plugin directory, and
// src/plugin/install/global-plugin.ts generates it at install time from the
// adapter's own modules so the rules that decide whether a developer is
// interrupted stay one copy (ADR-005). So there is no build artefact to check -
// there is a *closure*, and this check derives it the way the generator does and
// fails if a module the generator would need is not in the tree or not shipped. A
// rename in the generator is caught too: the two roots are cross-checked against
// the constants the generator itself declares.
//
// LIMITS, STATED RATHER THAN HIDDEN
// The comment strippers here are the repository's hand-written single-pass kind: a
// backtick template is read as one string to its closing backtick, so a nested
// template inside a `${...}` would end the scan early. No module or artefact these
// are pointed at contains one. The `files` matcher implements the subset of npm's
// rules this manifest uses - a literal entry includes everything beneath it, `*` and
// `**` are supported, and a `!` entry removes - and the allowlist is deliberately
// written inside that subset so the two cannot disagree.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The one command this package installs. The operations runbook's `agent-ping install`. */
export const BIN_NAME = 'agent-ping'

/** Where that command's implementation is emitted to. `src/cli/index.ts` under tsc. */
export const BIN_TARGET = 'dist/main/cli/index.js'

/** The Electron main entry the installed Electron loads. `src/main/index.ts` under tsc. */
export const MAIN_ENTRY = 'dist/main/main/index.js'

/** The durable schema, which the store loads relative to its own emitted module. */
export const DURABLE_SCHEMA = 'dist/main/storage/schema.sql'

/** The built dashboard, which the hub's static route serves. */
export const DASHBOARD_ROOT = 'dist/dashboard'

/**
 * The three built documents, and exactly three (NS-1, LD-FR-10, NT-FR-12).
 *
 * A closed list on purpose. "One of the files happens to exist" is the check that
 * let a card window load a 404 for a release; a fourth document appearing in the
 * build is a decision somebody has to make deliberately, so an unexpected one is
 * reported rather than tolerated.
 */
export const REQUIRED_DASHBOARD_DOCUMENTS = ['index.html', 'prototype/index.html', 'card.html']

/** The generator the install command calls, read from the packaged `src/`. */
export const PLUGIN_GENERATOR = 'src/plugin/install/global-plugin.ts'

/**
 * The two modules the generator inlines from, relative to `src/`.
 *
 * The same two roots `renderPluginSource` passes to `planModules`, which this check
 * cross-checks against the constants the generator declares rather than trusting a
 * copy in another file.
 */
export const PLUGIN_ROOTS = ['plugin/opencode/index.ts', 'plugin/transport/http.ts']

/**
 * The calls the built entry point must make about the sandbox.
 *
 * Both, for different reasons: `applyChromiumLaunchPolicy` is what this package can
 * still do for a child process, and `launchPolicyApplied` is what turns a missing
 * `--no-sandbox` into a sentence an operator can act on instead of a bare SIGTRAP
 * (CHROMIUM_LAUNCH_POLICY, NT-FR-04).
 */
export const LAUNCH_POLICY_CALLS = ['applyChromiumLaunchPolicy', 'launchPolicyApplied']

/**
 * Paths the allowlist must not match, in the categories that matter.
 *
 * Named rather than globbed so a failure says which kind of leak shipped. Each one
 * exists in this repository, so the assertion is not vacuous.
 */
export const FORBIDDEN_SHIPPED = [
  { path: 'dist/main/main/index.js.map', kind: 'source map' },
  { path: 'dist/main/main/index.d.ts', kind: 'TypeScript declaration' },
  { path: 'dist/main/main/index.d.ts.map', kind: 'declaration source map' },
  { path: 'tests/packaging/package.test.ts', kind: 'test' },
  { path: 'vite.config.ts', kind: 'development-only configuration' },
  { path: 'vitest.config.ts', kind: 'development-only configuration' },
  { path: 'tsconfig.json', kind: 'development-only configuration' },
  { path: 'eslint.config.js', kind: 'development-only configuration' },
  { path: 'docs/PRD.md', kind: 'documentation' },
  { path: 'src/dashboard/main.ts', kind: 'source the build does not need' },
  { path: 'src/notify/surface/electron-host.ts', kind: 'source the build does not need' },
]

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Repository-relative, forward-slashed, with no `./` prefix and no trailing `/`. */
function normalise(value) {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

function readIfPresent(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function isFile(root, relative) {
  const full = path.join(root, relative)
  try {
    return statSync(full).isFile()
  } catch {
    return false
  }
}

/** Every file under a directory, repository-relative, in a stable order. */
function walkFiles(root, relative, into = []) {
  const directory = path.join(root, relative)
  if (!existsSync(directory)) return into
  for (const entry of readdirSync(directory).sort()) {
    const child = `${relative}/${entry}`
    if (statSync(path.join(root, child)).isDirectory()) walkFiles(root, child, into)
    else into.push(child)
  }
  return into
}

// ---------------------------------------------------------------------------
// The `files` allowlist
// ---------------------------------------------------------------------------

/**
 * One glob, as a regular expression. A double star spans directories, a single star
 * and a question mark do not.
 *
 * Only the three shapes this manifest uses are supported, and the manifest is held
 * to using only those: a check whose matcher and whose allowlist disagree is worse
 * than no check, because it reports a package as shipped when npm dropped the file.
 */
function globToRegExp(pattern) {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*') {
      if (pattern[index + 1] !== '*') {
        source += '[^/]*'
        continue
      }
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?'
        index += 2
        continue
      }
      source += '.*'
      index += 1
      continue
    }
    if (character === '?') {
      source += '[^/]'
      continue
    }
    source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${source}$`)
}

/**
 * Whether an npm `files` allowlist includes one repository-relative path.
 *
 * A literal entry is npm's directory rule - it includes the path and everything
 * beneath it - and a `!` entry removes whatever an earlier entry included. Order is
 * respected, so a later positive entry can re-include, which is the same rule
 * npm-packlist applies.
 */
export function matchesFilesAllowlist(relativePath, entries) {
  const target = normalise(relativePath)
  let included = false
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = normalise(String(raw).trim())
    if (entry === '') continue
    const negated = entry.startsWith('!')
    const pattern = normalise(negated ? entry.slice(1) : entry)
    if (pattern === '') continue
    const matches = /[*?]/.test(pattern)
      ? globToRegExp(pattern).test(target)
      : target === pattern || target.startsWith(`${pattern}/`)
    if (matches) included = !negated
  }
  return included
}

// ---------------------------------------------------------------------------
// Reading a source file without its prose
// ---------------------------------------------------------------------------

/**
 * One pass over a file, recording where its string literals are and blanking its
 * comments and their contents.
 *
 * A line of regular expressions cannot do this on TypeScript: `http://127.0.0.1`
 * inside a string looks like a line comment, and an apostrophe inside a comment
 * looks like a string delimiter, and either mistake unbalances the rest of the file
 * and turns a source assertion into an assertion about nothing.
 *
 * Newlines are preserved, so a failure's line numbers still point at the author's
 * line. String spans are kept because the import specifier is the one string this
 * needs to read.
 */
function scanSource(source) {
  const spans = []
  let skeleton = ''
  let index = 0
  let previous = ''
  const blank = (length) => {
    for (let offset = 0; offset < length; offset += 1) {
      skeleton += source[index + offset] === '\n' ? '\n' : ' '
    }
  }
  while (index < source.length) {
    const pair = source.slice(index, index + 2)
    if (pair === '//') {
      let end = source.indexOf('\n', index)
      if (end === -1) end = source.length
      blank(end - index)
      index = end
      continue
    }
    if (pair === '/*') {
      const close = source.indexOf('*/', index + 2)
      const stop = close === -1 ? source.length : close + 2
      blank(stop - index)
      index = stop
      continue
    }
    const character = source[index]
    if (character === "'" || character === '"' || character === '`') {
      let cursor = index + 1
      while (cursor < source.length) {
        const inner = source[cursor]
        if (inner === '\\') {
          cursor += 2
          continue
        }
        if (inner === character || inner === '\n') break
        cursor += 1
      }
      const stop = Math.min(cursor + 1, source.length)
      spans.push({ start: index, end: stop, value: source.slice(index + 1, cursor) })
      blank(stop - index)
      index = stop
      previous = 'x'
      continue
    }
    if (character === '/' && !/[A-Za-z0-9_$)\]]/.test(previous)) {
      let cursor = index + 1
      let inClass = false
      while (cursor < source.length) {
        const inner = source[cursor]
        if (inner === '\\') {
          cursor += 2
          continue
        }
        if (inner === '[') inClass = true
        else if (inner === ']') inClass = false
        else if (inner === '/' && !inClass) break
        else if (inner === '\n') break
        cursor += 1
      }
      if (cursor < source.length && source[cursor] === '/') {
        cursor += 1
        while (cursor < source.length && /[a-z]/.test(source[cursor] ?? '')) cursor += 1
        blank(cursor - index)
        index = cursor
        previous = 'x'
        continue
      }
    }
    skeleton += character
    if (!/\s/.test(character)) previous = character
    index += 1
  }
  return { skeleton, spans }
}

/** A file with its comments and string contents blanked, and the spans it recorded. */
function scanFile(file) {
  const source = readIfPresent(file)
  return source === null ? null : scanSource(source)
}

/**
 * Every value import specifier in a scanned file.
 *
 * `import type`, `import.meta` and a dynamic `import(...)` are excluded, because
 * the first is erased before the plugin file is emitted and the other two have no
 * module to inline. That exclusion is the whole difference between a 290 KB plugin
 * file and a file that also inlines the SQLite store.
 *
 * An `export ... from` is deliberately not scanned. The generator refuses that form
 * outright (`unsupported-module`, because the emitted file has one module scope and a
 * re-export would create a binding it never declares), so no module in a real closure
 * can contain one, and matching `export` here would pair every `export const x = 'y'`
 * with that string and invent a module that is not imported at all.
 */
function valueImports(scan) {
  const found = []
  for (const match of scan.skeleton.matchAll(/\bimport\b/g)) {
    const at = match.index
    if (at > 0 && /[A-Za-z0-9_$'"]/.test(scan.skeleton[at - 1])) continue
    const next = scan.spans.find((span) => span.start > at)
    if (next === undefined) continue
    const clause = scan.skeleton.slice(at + 6, next.start)
    if (/^\s*type\b/.test(clause)) continue
    if (/^\s*[.(]/.test(clause)) continue
    found.push(next.value)
  }
  return found
}

// ---------------------------------------------------------------------------
// The plugin's generated-file closure
// ---------------------------------------------------------------------------

const BUILTINS = new Set(builtinModules)

function isBuiltinSpecifier(specifier) {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
  return BUILTINS.has(bare)
}

/**
 * The modules the generated plugin file is copied from, in the generator's order.
 *
 * Deliberately the same resolution the generator performs: a `.js` specifier means
 * the compiled name of a `.ts` source, a `.ts` is accepted as written, and a bare
 * specifier is either a node builtin (hoisted, not inlined) or a package - which is
 * a failure, because a file loaded into every session with nothing installed beside
 * it may not need a package to resolve.
 */
export function pluginClosure(root) {
  const modules = []
  const seen = new Set()
  const unresolved = []
  const external = []
  const visit = (relative) => {
    if (seen.has(relative)) return
    seen.add(relative)
    const scan = scanFile(path.join(root, 'src', relative))
    if (scan === null) {
      unresolved.push(`src/${relative}`)
      return
    }
    for (const specifier of valueImports(scan)) {
      if (isBuiltinSpecifier(specifier)) continue
      if (!specifier.startsWith('.')) {
        external.push(`src/${relative} -> ${specifier}`)
        continue
      }
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier))
      const resolved = [base.replace(/\.js$/, '.ts'), base, `${base}.ts`].find((candidate) =>
        isFile(root, `src/${candidate}`),
      )
      if (resolved === undefined) unresolved.push(`src/${relative} -> ${specifier}`)
      else visit(resolved)
    }
    modules.push(relative)
  }
  for (const root_ of PLUGIN_ROOTS) visit(root_)
  return { modules, unresolved, external }
}

/**
 * One constant the generator declares, read out of the generator's own source.
 *
 * The skeleton carries no string contents, so a comment cannot fake a constant and
 * a match on `NAME =` is followed by the string literal the scan recorded rather
 * than by whatever text happened to be next.
 */
function declaredConstant(scan, name) {
  const assignment = new RegExp(`\\b${name}\\s*=[^=]`).exec(scan.skeleton)
  if (assignment === null) return null
  // The match deliberately stops at the `=`, because everything after it is blanked
  // string content: a pattern that consumed the blanked literal would look for the
  // *next* string in the file and read this constant as some other module's specifier.
  const literal = scan.spans.find((span) => span.start > assignment.index)
  return literal === undefined ? null : literal.value
}

/** The two roots the generator declares, read out of the generator's own source. */
function declaredPluginRoots(generatorSource) {
  const scan = scanSource(generatorSource)
  return { entry: declaredConstant(scan, 'ENTRY_MODULE'), transport: declaredConstant(scan, 'TRANSPORT_MODULE') }
}

// ---------------------------------------------------------------------------
// The dashboard documents
// ---------------------------------------------------------------------------

/** Every `.html` file the dashboard build emitted, repository-relative. */
function builtDashboardDocuments(root) {
  return walkFiles(root, DASHBOARD_ROOT)
    .filter((file) => file.endsWith('.html'))
    .map((file) => file.slice(DASHBOARD_ROOT.length + 1))
    .sort()
}

/** The relative assets one built document references, resolved against the document. */
function documentReferences(root, relativeDocument) {
  const source = readIfPresent(path.join(root, DASHBOARD_ROOT, relativeDocument)) ?? ''
  const found = new Set()
  for (const match of source.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/g)) {
    const value = match[1]
    if (value === '' || value.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
      continue
    }
    found.add(path.posix.normalize(path.posix.join(path.posix.dirname(relativeDocument), value)))
  }
  return [...found].sort()
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** One check's answer. `remedy` is present only when the answer is no. */
function finding(name, ok, detail, remedy) {
  return { name, ok, detail, ...(remedy === undefined ? {} : { remedy }) }
}

function checkManifest(root) {
  const source = readIfPresent(path.join(root, 'package.json'))
  if (source === null) {
    return finding('manifest', false, 'package.json is not in this tree', 'run this script from the package root')
  }
  let manifest
  try {
    manifest = JSON.parse(source)
  } catch (cause) {
    return finding('manifest', false, `package.json does not parse: ${cause.message}`, 'fix the JSON syntax in package.json')
  }
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    return finding('manifest', false, 'package.json declares no name', 'add a "name" to package.json')
  }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    return finding('manifest', false, `${manifest.name} declares no version`, 'add a "version" to package.json')
  }
  return finding('manifest', true, `${manifest.name} ${manifest.version}`)
}

function readManifest(root) {
  const source = readIfPresent(path.join(root, 'package.json'))
  if (source === null) return null
  try {
    return JSON.parse(source)
  } catch {
    return null
  }
}

function checkBinary(root, manifest) {
  const bin = manifest?.bin
  if (bin === undefined) {
    return finding(
      'binary',
      false,
      'no `bin` is declared, so `npm install -g` installs no command',
      `add a "bin" block naming the ${BIN_NAME} command (IO-FR-01)`,
    )
  }
  const entries = typeof bin === 'string' ? { [BIN_NAME]: bin } : bin
  const names = Object.keys(entries)
  if (names.length !== 1 || names[0] !== BIN_NAME) {
    return finding(
      'binary',
      false,
      `\`bin\` declares ${names.map((name) => `"${name}"`).join(', ') || 'nothing'}, expected exactly "${BIN_NAME}"`,
      `the operations runbook installs one command, \`${BIN_NAME}\`, so declare exactly that one`,
    )
  }
  const target = String(entries[BIN_NAME])
  if (target !== BIN_TARGET) {
    return finding(
      'binary',
      false,
      `"${BIN_NAME}" points at ${target}, expected ${BIN_TARGET}`,
      `point "bin" at ${BIN_TARGET}, which is where tsc emits src/cli/index.ts`,
    )
  }
  if (!isFile(root, target)) {
    return finding(
      'binary',
      false,
      `${target} is not in this tree, so the installed command cannot run`,
      'run `npm run build`; src/cli/index.ts is IO-2 and does not exist yet, so a publish is blocked until it does',
    )
  }
  return finding('binary', true, `"${BIN_NAME}" -> ${target}`)
}

function checkElectronMain(root, manifest) {
  const declared = manifest?.main
  if (typeof declared !== 'string' || declared === '') {
    return finding(
      'electron-main',
      false,
      'no `main` is declared, so the installed Electron has no entry to load',
      `add "main": "${MAIN_ENTRY}" to package.json; \`electron <package>\` resolves its main process entry through it`,
    )
  }
  if (normalise(declared) !== MAIN_ENTRY) {
    return finding(
      'electron-main',
      false,
      `\`main\` is ${declared}, expected ${MAIN_ENTRY}`,
      `the Electron main entry is ${MAIN_ENTRY}, the tsc output of src/main/index.ts`,
    )
  }
  if (!isFile(root, MAIN_ENTRY)) {
    return finding(
      'electron-main',
      false,
      `${MAIN_ENTRY} is not in this tree, so the installed Electron has nothing to start`,
      'run `npm run build` before publishing',
    )
  }
  return finding('electron-main', true, `main -> ${MAIN_ENTRY}`)
}

function checkLaunchPolicy(root) {
  const scan = scanFile(path.join(root, MAIN_ENTRY))
  if (scan === null) {
    return finding('launch-policy', false, `${MAIN_ENTRY} could not be read`, 'run `npm run build` before publishing')
  }
  const missing = LAUNCH_POLICY_CALLS.filter((name) => !new RegExp(`\\b${name}\\s*\\(`).test(scan.skeleton))
  if (missing.length > 0) {
    return finding(
      'launch-policy',
      false,
      `the built entry never calls ${missing.join(' and ')}, so a per-user install aborts on the Chromium sandbox`,
      'src/main/index.ts must call applyChromiumLaunchPolicy and launchPolicyApplied (CHROMIUM_LAUNCH_POLICY); see docs/runbooks/notification-surface.md section 2',
    )
  }
  return finding(
    'launch-policy',
    true,
    `the built entry calls ${LAUNCH_POLICY_CALLS.join(' and ')}`,
  )
}

function checkDurableSchema(root) {
  if (!isFile(root, DURABLE_SCHEMA)) {
    return finding(
      'durable-schema',
      false,
      `${DURABLE_SCHEMA} is not in this tree, so a hub started from the build cannot open its log`,
      'run `npm run build`; the build copies src/storage/schema.sql beside the emitted store',
    )
  }
  return finding('durable-schema', true, DURABLE_SCHEMA)
}

function checkDashboard(root) {
  const built = builtDashboardDocuments(root)
  const missing = REQUIRED_DASHBOARD_DOCUMENTS.map((document) => `${DASHBOARD_ROOT}/${document}`).filter(
    (document) => !built.includes(document.slice(DASHBOARD_ROOT.length + 1)),
  )
  if (missing.length > 0) {
    return finding(
      'dashboard',
      false,
      `missing built document${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
      'run `npm run build:dashboard`; the build emits index.html, prototype/index.html and card.html (NS-1), and a card window loading /card.html is a 404 without the third',
    )
  }
  const unexpected = built.filter((document) => !REQUIRED_DASHBOARD_DOCUMENTS.includes(document))
  if (unexpected.length > 0) {
    return finding(
      'dashboard',
      false,
      `built document${unexpected.length === 1 ? '' : 's'} this product does not declare: ${unexpected.map((document) => `${DASHBOARD_ROOT}/${document}`).join(', ')}`,
      'add the page to REQUIRED_DASHBOARD_DOCUMENTS in scripts/prepack-check.mjs deliberately, or take it out of the Vite build (vite.config.ts)',
    )
  }
  const broken = []
  for (const document of REQUIRED_DASHBOARD_DOCUMENTS) {
    for (const reference of documentReferences(root, document)) {
      if (!isFile(root, `${DASHBOARD_ROOT}/${reference}`)) {
        broken.push(`${DASHBOARD_ROOT}/${document} -> ${DASHBOARD_ROOT}/${reference}`)
      }
    }
  }
  if (broken.length > 0) {
    return finding(
      'dashboard',
      false,
      `built document${broken.length === 1 ? '' : 's'} reference assets the build did not emit: ${broken.join(', ')}`,
      'run `npm run build:dashboard` again; a document that names a hashed asset the build never wrote serves a broken page',
    )
  }
  return finding('dashboard', true, `${REQUIRED_DASHBOARD_DOCUMENTS.join(', ')} and every asset they name`)
}

function checkPluginSource(root, manifest) {
  if (!isFile(root, PLUGIN_GENERATOR)) {
    return finding(
      'plugin-source',
      false,
      `${PLUGIN_GENERATOR} is not in this tree, so \`install\` has no generator to call`,
      'add "src/plugin/" to the package `files` allowlist so the installer ships with the package',
    )
  }
  const generator = readIfPresent(path.join(root, PLUGIN_GENERATOR)) ?? ''
  const declared = declaredPluginRoots(generator)
  const roots = [declared.entry, declared.transport]
  if (roots[0] === null || roots[1] === null) {
    return finding(
      'plugin-source',
      false,
      `${PLUGIN_GENERATOR} declares no ENTRY_MODULE and TRANSPORT_MODULE for this check to read`,
      'this check derives the plugin closure from the generator\'s own roots; keep those two constants in global-plugin.ts',
    )
  }
  if (roots.join(',') !== PLUGIN_ROOTS.join(',')) {
    return finding(
      'plugin-source',
      false,
      `the generator inlines ${roots.join(' and ')}; this check follows ${PLUGIN_ROOTS.join(' and ')}`,
      'update PLUGIN_ROOTS in scripts/prepack-check.mjs to the generator\'s own ENTRY_MODULE and TRANSPORT_MODULE',
    )
  }
  const closure = pluginClosure(root)
  if (closure.unresolved.length > 0) {
    return finding(
      'plugin-source',
      false,
      `the generated plugin file needs module${closure.unresolved.length === 1 ? '' : 's'} this tree does not have: ${closure.unresolved.join(', ')}`,
      'ship the whole module the generator inlines, or fix the import; `install` fails loudly rather than writing a plugin that cannot load (OA-FR-01)',
    )
  }
  if (closure.external.length > 0) {
    return finding(
      'plugin-source',
      false,
      `the generated plugin file would need an npm package: ${closure.external.join(', ')}`,
      'a plugin loaded into every session with nothing installed beside it may not need a package to resolve; inline the module instead',
    )
  }
  const files = Array.isArray(manifest?.files) ? manifest.files : []
  if (!Array.isArray(manifest?.files)) {
    return finding(
      'plugin-source',
      false,
      'no `files` allowlist, so the generator and its modules would not be published',
      'add a "files" array to package.json covering the built output and the plugin generator\'s source (IO-FR-01)',
    )
  }
  const unshipped = closure.modules
    .map((module) => `src/${module}`)
    .filter((file) => !matchesFilesAllowlist(file, files))
  if (unshipped.length > 0) {
    return finding(
      'plugin-source',
      false,
      `the generator's modules would not be published: ${unshipped.join(', ')}`,
      'add the directory holding them to the package `files` allowlist, or take the import out',
    )
  }
  if (!matchesFilesAllowlist(PLUGIN_GENERATOR, files)) {
    return finding(
      'plugin-source',
      false,
      `${PLUGIN_GENERATOR} would not be published, so \`install\` cannot generate the plugin file`,
      'add "src/plugin/" to the package `files` allowlist',
    )
  }
  return finding(
    'plugin-source',
    true,
    `generator and ${closure.modules.length} inlined module${closure.modules.length === 1 ? '' : 's'}`,
  )
}

/** Every artefact this product must publish, as allowlist paths. */
export function requiredShippedPaths(root) {
  const closure = pluginClosure(root)
  return [
    MAIN_ENTRY,
    BIN_TARGET,
    DURABLE_SCHEMA,
    ...REQUIRED_DASHBOARD_DOCUMENTS.map((document) => `${DASHBOARD_ROOT}/${document}`),
    PLUGIN_GENERATOR,
    ...closure.modules.map((module) => `src/${module}`),
  ]
}

function checkFilesAllowlist(root, manifest) {
  const files = manifest?.files
  if (!Array.isArray(files)) {
    return finding(
      'files-allowlist',
      false,
      'no `files` allowlist, so npm would publish the whole checkout',
      'add a "files" array to package.json (IO-FR-01); without one, tests, source maps and development configuration ship to every global install',
    )
  }
  if (files.length === 0) {
    return finding('files-allowlist', false, 'the `files` allowlist is empty', 'list the directories that must ship')
  }
  const required = requiredShippedPaths(root)
  const unshipped = required.filter((file) => !matchesFilesAllowlist(file, files))
  if (unshipped.length > 0) {
    return finding(
      'files-allowlist',
      false,
      `${unshipped.length} required file${unshipped.length === 1 ? '' : 's'} the allowlist would not publish: ${unshipped.join(', ')}`,
      'add the directory or file holding each one to the package `files` allowlist',
    )
  }
  return finding('files-allowlist', true, `${required.length} required file${required.length === 1 ? '' : 's'} covered`)
}

function checkFilesExclusions(root, manifest) {
  const files = manifest?.files
  if (!Array.isArray(files)) {
    return finding('files-exclusions', false, 'no `files` allowlist to hold the exclusions', 'add a "files" array to package.json')
  }
  const shipped = FORBIDDEN_SHIPPED.filter((entry) => matchesFilesAllowlist(entry.path, files)).map((entry) => `${entry.path} (${entry.kind})`)
  if (shipped.length > 0) {
    return finding(
      'files-exclusions',
      false,
      `the allowlist would publish ${shipped.join(', ')}`,
      'exclude them with a "!" entry, for example "!dist/**/*.map" and "!dist/main/**/*.d.ts"',
    )
  }
  // The named probes above cannot see a map whose hashed name is not one of them, so
  // the whole built output is swept as well: no shipped file under dist/ may be a
  // source map or a TypeScript declaration.
  const leaking = walkFiles(root, 'dist')
    .filter((file) => /\.(map|d\.ts)$/.test(file))
    .filter((file) => matchesFilesAllowlist(file, files))
  if (leaking.length > 0) {
    return finding(
      'files-exclusions',
      false,
      `${leaking.length} built file${leaking.length === 1 ? '' : 's'} under dist/ would be published: ${leaking.slice(0, 6).join(', ')}${leaking.length > 6 ? ', ...' : ''}`,
      'exclude them with a "!" entry, for example "!dist/**/*.map" and "!dist/main/**/*.d.ts"',
    )
  }
  return finding('files-exclusions', true, 'no source map, declaration, test or development configuration')
}

/**
 * Every check, in the order a reader wants them: what the package calls itself,
 * then what it installs, then what it starts, then what it publishes.
 */
export function runPrepackCheck(root) {
  const manifest = readManifest(root)
  return {
    root,
    checks: [
      checkManifest(root),
      checkBinary(root, manifest),
      checkElectronMain(root, manifest),
      checkLaunchPolicy(root),
      checkDurableSchema(root),
      checkDashboard(root),
      checkPluginSource(root, manifest),
      checkFilesAllowlist(root, manifest),
      checkFilesExclusions(root, manifest),
    ],
  }
}

/** The width the check names are aligned to, so the list reads as a list. */
const NAME_WIDTH = 16
const STATUS_WIDTH = 6

/**
 * Render a result the way this product's other terminal output reads: aligned
 * check names, one remedy line per failure, and a plain statement of the count.
 */
export function formatResult(result) {
  const lines = [`[prepack] tree: ${result.root}`, '']
  for (const check of result.checks) {
    const status = check.ok ? 'ok' : 'FAILED'
    lines.push(
      `[prepack] ${check.name.padEnd(NAME_WIDTH)} ${status.padEnd(STATUS_WIDTH)} ${check.detail}`,
    )
    if (!check.ok && check.remedy !== undefined) {
      lines.push(`[prepack] ${' '.repeat(NAME_WIDTH)} ${' '.repeat(STATUS_WIDTH)} remedy: ${check.remedy}`)
    }
  }
  const failed = result.checks.filter((check) => !check.ok)
  lines.push('')
  lines.push(
    `[prepack] ${result.checks.length - failed.length} of ${result.checks.length} checks passed` +
      (failed.length === 0 ? '' : `; ${failed.length} failed: ${failed.map((check) => check.name).join(', ')}`),
  )
  lines.push(
    '[prepack] launch policy: CHROMIUM_LAUNCH_POLICY is a process-launch property, so the per-user',
  )
  lines.push(
    '[prepack]   autostart units must carry --no-sandbox or ELECTRON_DISABLE_SANDBOX=1 (IO-2, IO-3).',
  )
  lines.push(
    '[prepack]   This check proves the packaged entry reports the gap; it cannot set the switch itself.',
  )
  return lines.join('\n')
}

/** The tree this script guards by default: the package root above `scripts/`. */
export const defaultRoot = fileURLToPath(new URL('..', import.meta.url))

/** `--root=<dir>` or `--root <dir>`: the tree to check. Defaults to this package. */
function rootFromArgv(argv) {
  const flag = argv.findIndex((argument) => argument === '--root' || argument.startsWith('--root='))
  if (flag === -1) return defaultRoot
  const inline = argv[flag].startsWith('--root=')
  const value = inline ? argv[flag].slice('--root='.length) : argv[flag + 1]
  if (value === undefined || value === '') {
    process.stderr.write('[prepack] --root needs a directory\n')
    process.exit(2)
  }
  return path.resolve(value)
}

function isMainModule() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return pathToFileURL(entry).href === import.meta.url
  } catch {
    return false
  }
}

if (isMainModule()) {
  const result = runPrepackCheck(rootFromArgv(process.argv.slice(2)))
  process.stdout.write(`${formatResult(result)}\n`)
  // A guard that cannot fail is a comment. Exit 1 on any failed check, so `prepack`
  // refuses the publish and a script can trust the code.
  process.exit(result.checks.every((check) => check.ok) ? 0 : 1)
}
