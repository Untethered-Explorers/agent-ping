// The global opencode plugin installer: one file, one piece of metadata, one
// remove (OA-FR-01, OA-FR-08, ADR-006, ADR-001, APX-CON-03, APX-CON-12).
//
// This is a MODULE, not a command. packaging-engineer calls `installGlobalPlugin`
// and `uninstallGlobalPlugin` from the `install` and `uninstall` commands and prints
// the `message` this module returns; the exit code and the wording are theirs. The
// one thing this module refuses to hand over is a decision: it reports what is on
// disk and lets the caller choose, because "a different version was already
// installed" is a fact about the machine, not an error to swallow.
//
// WHERE THE FILE GOES, AND WHY THAT PATH IS NOT A STRING IN THIS FILE
// opencode discovers local plugins in `<config>/plugins/` and loads them at startup
// for every session, whatever started the session. `<config>` is opencode's global
// configuration directory, which opencode resolves through XDG base directories -
// `$XDG_CONFIG_HOME/opencode` when that is set, and `<home>/.config/opencode`
// otherwise, on Linux, macOS AND Windows alike. Two pieces of evidence, because a
// guessed path is a silent failure mode:
//
//   - Observed. `XDG_CONFIG_HOME=/tmp/x opencode debug paths` on opencode 1.18.32
//     printed `config /tmp/x/opencode`, and printed `config <home>/.config/opencode`
//     with the variable unset, while `OPENCODE_CONFIG_DIR` left it at the home path.
//   - Documented. opencode's config docs give the global config as
//     `~/.config/opencode/opencode.json` with no platform carve-out and its plugins
//     page gives `~/.config/opencode/plugins/`; the only macOS-specific opencode
//     path is the read-only *managed* directory `/Library/Application Support/
//     opencode`, which an unprivileged installer must never write to.
//
// `OPENCODE_CONFIG_DIR` is deliberately NOT followed. The docs make it an additional
// directory searched *in addition to* the global one, and the probe above shows it is
// not the global config path. A plugin installed there would still be loaded, but it
// would be "wherever this invocation points", which is the opposite of the one global
// install this feature promises (ADR-006). The resolver takes `env`, `platform` and
// `home` as parameters rather than reading them, so a test can drive every platform
// without mutating `process.env` - the same shape as src/storage/paths.ts, and
// deliberately the only other place in the product that resolves a platform directory.
//
// WHY A SINGLE FILE IS GENERATED RATHER THAN HAND-WRITTEN
// OA-FR-01 says one plugin file, and opencode loads exactly the files in the plugin
// directory. The adapter, on the other hand, is eleven reviewed modules with hundreds
// of tests against them, and the classifier and the hub readers it calls must stay
// the same code the hub runs - copying them into a plugin file would give the product
// two copies of the rules that decide whether a developer is interrupted (ADR-005).
// So the installed file is GENERATED from those modules at install time,
// mechanically: relative imports between inlined modules are erased, node builtins
// are hoisted and de-duplicated, `export` keywords are stripped, and every module body
// is copied byte for byte. There is no bundler dependency and no build step, and the
// one hand-written part of the emitted file - the entry point that builds OA-2's
// transport and passes it as the `deliver` option - is wiring, printed in `ENTRY_GLUE`.
//
// The generator has to know where a statement is, so it scans rather than
// substitutes: `import`, `export` and `/` inside a comment, a string, a template or a
// regular expression are not statements. That is not paranoia - `src/domain/
// envelope.ts` contains a comment explaining type-only imports whose text ends in
// `from '../storage/eventStore.js'`, and a regex that matched it would inline the
// SQLite store and its native dependency into a file loaded into every session. A
// bare (non-`node:`) import is a hard failure for the same reason: the emitted file
// must be loadable with nothing installed beside it, or a developer's session would
// depend on a resolvable `node_modules` that is not there.
//
// VERIFY BEFORE PUBLISH, BECAUSE THE BLAST RADIUS IS EVERY SESSION
// A plugin that throws degrades opencode itself (ADR-006), and this file is loaded
// into every session on the machine. So the order is: render to a temporary file in
// the plugin directory, load THAT file in a fresh Node process, drive one harness
// event through it, confirm a breadcrumb arrived on a stub logging client, and only
// then move it into place. A render that does not load never reaches the plugin
// directory, and the install reports the failure instead of leaving a broken file for
// the next session to trip over (APX-FR-02). The verification runs in a child process
// with a bounded wall clock, because a module that keeps a handle open must not keep
// the install command alive, and because evaluating adapter code in the installer's
// own process is a thing an installer should not do.
//
// THE METADATA, AND WHY IT IS A package.json
// opencode runs `bun install` at startup against a package.json in the config
// directory when a local plugin needs packages from npm. This plugin needs none, so
// the metadata is not here to make a dependency resolve - it is the install record:
// the name, the product version and the hash of the generated file, which is what
// makes a second install a no-op and a *different* installed version reportable
// instead of overwritable. It is written as a package.json in the plugin directory
// with `"type": "module"`, because the emitted file is ESM and the nearest
// package.json is the only thing that says so to a loader. A sibling package.json
// does not disturb plugin discovery: a probe that placed one beside a plugin file in
// a temporary `XDG_CONFIG_HOME` had that plugin loaded by opencode 1.18.32 from
// `opencode run` with the package.json present. Nothing in the emitted file is a
// secret - the write token is read at run time from the state directory - which is
// why the file is a normal readable source file and why removing it is a plain delete
// (APX-CON-12).
//
// THE INSTALLER OWNS NOTHING ELSE
// It writes two files into one directory and removes those two files. It does not
// touch opencode's config file, a project `.opencode/` directory, an npm cache, a
// registry or any autostart unit, and it never reads a repository: there is no
// per-repository configuration to create because there is no per-repository step
// (OA-FR-01, APX-CON-09, ADR-006). A repository that was never registered keeps
// working, because the install does not register repositories (APX-CON-03).

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { builtinModules } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// What gets installed, and where
// ---------------------------------------------------------------------------

/** opencode's directory name inside the XDG configuration root. */
export const OPENCODE_DIR_NAME = 'opencode'

/** The subdirectory opencode discovers local plugins in. Plural, per its docs. */
export const PLUGIN_DIR_NAME = 'plugins'

/**
 * The one environment variable that moves opencode's configuration root.
 *
 * Honoured because opencode honours it: `XDG_CONFIG_HOME=/tmp/x opencode debug
 * paths` on 1.18.32 printed `config /tmp/x/opencode`. It is read as a parameter and
 * never from an ambient global, so a test can pass an environment.
 */
export const XDG_CONFIG_HOME_ENV_VAR = 'XDG_CONFIG_HOME'

/** The single plugin file. One file, one export, every session (OA-FR-01). */
export const PLUGIN_FILE_NAME = 'agent-ping.ts'

/** The install record, and the `type: module` declaration beside the plugin. */
export const METADATA_FILE_NAME = 'package.json'

/** The only export opencode calls. Named, because that is the plugin convention. */
export const PLUGIN_EXPORT_NAME = 'AGENT_PING_PLUGIN'

/**
 * The first line of every generated file.
 *
 * It is also how a file is recognised as ours: `installedVersionOf` and
 * `readInstalledMetadata` match this sentinel, so a developer's own `agent-ping.ts` is
 * reported as somebody else's file instead of being overwritten (APX-CON-03 - the
 * installer must never destroy a session's configuration because it guessed).
 */
export const GENERATED_SENTINEL = '// agent-ping:global-plugin v1'

/** The metadata key holding the install record, inside the package.json. */
export const METADATA_KEY = 'agentPing'

/** Bumped if the install record's own shape changes. */
export const INSTALL_RECORD_VERSION = 1

/** The product whose version the record carries. */
export const PRODUCT_NAME = 'agent-ping'

/**
 * The inputs every path here resolves from, as parameters rather than ambient reads.
 *
 * An options record rather than three positional arguments, because two of the three
 * are almost always passed together by a caller that has a temporary home and an
 * environment for it. `platform` is carried so a test can drive every supported
 * platform, and it is deliberately never branched on - see `resolveOpencodeConfigDir`.
 */
export interface OpencodePathOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly home?: string
}

/**
 * opencode's global configuration directory, from the platform configuration path.
 *
 * `$XDG_CONFIG_HOME/opencode` when that variable is set, and
 * `<home>/.config/opencode` otherwise, on every supported platform. There is no
 * Windows `%APPDATA%` branch on purpose: opencode resolves its base directories with
 * `xdg-basedir`, which does not use `%APPDATA%` or `%LOCALAPPDATA%`, and a third
 * party that "fixes" this to the Windows convention writes plugin files into a
 * directory opencode never reads - which is how a plugin silently does nothing.
 *
 * That sameness is the assertion this function makes by not branching on `platform`.
 * The parameter exists so a test can hold all three platforms to it.
 */
export function resolveOpencodeConfigDir(options: OpencodePathOptions = {}): string {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const xdg = env[XDG_CONFIG_HOME_ENV_VAR]
  const base = xdg !== undefined && xdg.trim() !== '' ? xdg.trim() : path.join(home, '.config')
  return path.join(base, OPENCODE_DIR_NAME)
}

/** The global plugin directory: `<config>/plugins`. */
export function resolveGlobalPluginDir(options: OpencodePathOptions = {}): string {
  return path.join(resolveOpencodeConfigDir(options), PLUGIN_DIR_NAME)
}

// ---------------------------------------------------------------------------
// The generated file
// ---------------------------------------------------------------------------

/** The module every other module is reached from. */
const ENTRY_MODULE = 'plugin/opencode/index.ts'

/** The delivery port OA-2 owns, which the installed entry point has to build. */
const TRANSPORT_MODULE = 'plugin/transport/http.ts'

/** The repository root, from this file's own location: `src/plugin/install/`. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * The one hand-written part of the emitted file.
 *
 * Wiring, not policy: the classification rules, the translation table and the
 * transport all come from the inlined modules above. It builds the transport with the
 * harness's own logging client and passes it as the `deliver` option OA-1 reads, which
 * is what lets one globally installed file report to the hub with no per-repository
 * configuration and no registry (OA-FR-01, OA-FR-04, ADR-006).
 *
 * The `try` is the sidecar property in four lines: a transport that cannot even be
 * constructed leaves the adapter reporting "no delivery port is wired" once, as a
 * breadcrumb in the developer's own harness, rather than throwing into the session
 * (APX-CON-03, APX-CON-10).
 */
const ENTRY_GLUE = `
// ---------------------------------------------------------------------------
// The installed entry point
// ---------------------------------------------------------------------------

// The adapter's own plugin, called with the delivery port the transport builds.
//
// The wrapper is a separate binding and the export is indirect on purpose. The
// inlined adapter already owns a top-level \`const ${PLUGIN_EXPORT_NAME}\`, and the
// emitted file is one module scope, so declaring another \`const ${PLUGIN_EXPORT_NAME}\`
// here would be a duplicate declaration. An indirect export gives the required
// \`${PLUGIN_EXPORT_NAME}\` export name to this wrapper without renaming one
// identifier in the product's own source, which is the one thing this generator
// refuses to do.
const agentPingInstalledPlugin: OpencodePlugin = async (input, options) => {
  let deliver: DeliverPort | undefined
  try {
    deliver = createHubTransport({
      log: createHarnessLog(input.client, { directory: input.directory }),
    })
  } catch {
    deliver = undefined
  }
  return ${PLUGIN_EXPORT_NAME}(input, { ...(options ?? {}), deliver })
}

export { agentPingInstalledPlugin as ${PLUGIN_EXPORT_NAME} }
`

/** How a generated file can fail to render. Four answers, and each one is a bug. */
export type RenderFailureCode =
  /** A module in the closure is not where its import statement said it would be. */
  | 'module-unresolved'
  /** A module imports a package, so the emitted file would need a node_modules. */
  | 'external-dependency'
  /** Two inlined modules declare the same name, or one uses an export form. */
  | 'unsupported-module'
  /** The adapter source could not be read. */
  | 'source-unreadable'

export const RENDER_FAILURE_MESSAGES: Readonly<Record<RenderFailureCode, string>> = {
  'module-unresolved':
    'a module the adapter imports is not where its own import statement says it is, so the single file cannot be assembled from it.',
  'external-dependency':
    'a module in the adapter imports an npm package. The installed file is loaded into every session with nothing installed beside it, so it may not need a package to resolve.',
  'unsupported-module':
    'two inlined modules declare the same top-level name, or a module uses an export form this generator does not handle. Both are generator bugs, not machine problems.',
  'source-unreadable': 'the adapter source could not be read.',
}

export class PluginRenderError extends Error {
  readonly code: RenderFailureCode
  /** The module, and where it means anything the specifier. Never a payload. */
  readonly module: string
  readonly detail?: string

  constructor(code: RenderFailureCode, module: string, detail?: string) {
    super(
      `agent-ping could not generate its opencode plugin from ${module}${detail === undefined ? '' : ` (${detail})`}: ${RENDER_FAILURE_MESSAGES[code]}`,
    )
    this.name = 'PluginRenderError'
    this.code = code
    this.module = module
    if (detail !== undefined) this.detail = detail
  }
}

/** What one render produced. Deterministic: the same sources render the same bytes. */
export interface RenderedPlugin {
  /** The whole file, ready to write. */
  readonly text: string
  /** `sha256` of `text`, recorded in the metadata so `doctor` can compare. */
  readonly hash: string
  /** The source modules inlined, in the order they appear. */
  readonly modules: readonly string[]
  /** The node builtins the emitted file imports. */
  readonly builtins: readonly string[]
}

export interface RenderOptions {
  /**
   * The product version, written into the file's own header.
   *
   * It has to be in the file, not only in the metadata, because the file is the thing
   * a human finds: a version inside the installed source is what makes "which version
   * is installed" answerable from a text editor, and it is what `installedVersionOf`
   * reads when the next install looks at the machine.
   */
  readonly version: string
  /** Reads a module by its path relative to `src/`. Defaults to the real tree. */
  readonly read?: (modulePath: string) => string
  /** The directory module paths resolve against. Defaults to this repository's `src`. */
  readonly sourceDir?: string
}

/**
 * The single plugin file, generated from the adapter's own modules.
 *
 * The output is a pure function of the sources handed in, so a second install of an
 * unchanged product renders identical bytes and the installer can tell "already
 * installed" from "installed something different" without trusting a timestamp.
 */
export function renderPluginSource(options: RenderOptions): RenderedPlugin {
  const sourceDir = options.sourceDir ?? path.join(REPO_ROOT, 'src')
  const read =
    options.read ??
    ((modulePath: string): string => readFileSync(path.join(sourceDir, modulePath), 'utf8'))
  const modules = planModules([ENTRY_MODULE, TRANSPORT_MODULE], read)
  const sources = modules.map((modulePath) => ({ modulePath, source: readSafely(modulePath, read) }))
  // Every duplicate is known before any module is written, because a duplicate that
  // turns out not to be identical has to be refused before anything is emitted.
  const duplicates = duplicateDeclarationSpans(sources)
  const builtins = new Set<string>()
  const table = new Map<string, BuiltinImport>()
  const bodies: string[] = []
  for (const entry of sources) {
    bodies.push(transformModule(entry.modulePath, entry.source, builtins, table, duplicates))
  }
  // One import section for the whole file: the emitted file is one module scope, so a
  // builtin three inlined modules all need is declared once here rather than three
  // times in their bodies.
  const imports = [...table.values()].flatMap(renderBuiltinImports)
  const preamble = imports.length === 0 ? '' : `${imports.join('\n')}\n\n`
  const text = `${renderHeader(modules, [...builtins].sort(), options.version)}\n\n${preamble}${bodies.join('\n')}\n${ENTRY_GLUE}`
  return {
    text,
    hash: `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`,
    modules,
    builtins: [...builtins].sort(),
  }
}

/**
 * The file's header: the sentinel, the version, and the full list of what was inlined.
 *
 * The list is not decoration. A file this size in somebody else's config directory is
 * only reviewable if it says where it came from, and `doctor` needs the hash to answer
 * "is the installed plugin the one this product would install today".
 */
function renderHeader(modules: readonly string[], builtins: readonly string[], version: string): string {
  return [
    `${GENERATED_SENTINEL} - generated, do not edit`,
    '//',
    `// product-version: ${version}`,
    '//',
    '// Generated by agent-ping. `agent-ping install` writes this file and',
    '// `agent-ping uninstall` removes it. Every line below the header is copied byte for',
    "// byte from this product's own modules, so the classification rules and the hub",
    '// readers this plugin calls are the same code the hub runs.',
    '//',
    '// Inlined modules, in dependency order:',
    ...modules.map((modulePath) => `//   - src/${modulePath}`),
    '//',
    `// Node builtins this file imports: ${builtins.join(', ')}`,
    '//',
    '// It has no npm dependency, so opencode never needs to install anything beside it',
    '// and a session cannot fail to load because a package is missing.',
  ].join('\n')
}

/**
 * The value-import closure of the entry point plus the transport.
 *
 * The entry point alone would not reach the transport: OA-1 takes the delivery port as
 * an injected option precisely so the adapter can be tested without a socket, and the
 * *installed* file is what has to build one. So the transport is a second root here
 * rather than an import inside OA-1's module.
 *
 * Type-only imports are not edges. That is the difference between a 4600-line file and
 * a file that also inlines the SQLite store: `src/domain/envelope.ts` imports its
 * `EventClass` and `FyiSubtype` from `../storage/eventStore.js` as types, and that
 * store imports `better-sqlite3`.
 */
function planModules(roots: readonly string[], read: (modulePath: string) => string): string[] {
  const order: string[] = []
  const seen = new Set<string>()
  const visit = (modulePath: string): void => {
    if (seen.has(modulePath)) return
    seen.add(modulePath)
    const source = readSafely(modulePath, read)
    for (const imported of valueImports(modulePath, source, read)) {
      // A node builtin is not a module in the tree; it is hoisted to the top of the
      // emitted file by `transformModule`.
      if (imported.isBuiltin) continue
      visit(imported.modulePath)
    }
    order.push(modulePath)
  }
  for (const root of roots) visit(root)
  return order
}

/**
 * Read one module, or fail as a render failure.
 *
 * Every read goes through here, so a render either produces a file or throws
 * `PluginRenderError` - never a bare filesystem error that a caller would have to
 * recognise to turn into a sentence.
 */
function readSafely(modulePath: string, read: (modulePath: string) => string): string {
  try {
    return read(modulePath)
  } catch (cause) {
    throw new PluginRenderError('source-unreadable', modulePath, errorNameOf(cause))
  }
}

/** One value import, and where its specifier landed. */
interface ValueImport {
  readonly modulePath: string
  readonly isBuiltin: boolean
}

function valueImports(
  modulePath: string,
  source: string,
  read: (modulePath: string) => string,
): ValueImport[] {
  const found: ValueImport[] = []
  for (const statement of scanImports(source)) {
    if (statement.typeOnly) continue
    if (isBuiltinSpecifier(statement.specifier)) {
      found.push({ modulePath: statement.specifier, isBuiltin: true })
      continue
    }
    if (!statement.specifier.startsWith('.')) {
      throw new PluginRenderError('external-dependency', modulePath, statement.specifier)
    }
    const resolved = resolveModulePath(modulePath, statement.specifier, read)
    if (resolved === null) {
      throw new PluginRenderError('module-unresolved', modulePath, statement.specifier)
    }
    found.push({ modulePath: resolved, isBuiltin: false })
  }
  return found
}

/**
 * `.js` in a specifier means the compiled name of a `.ts` source, which is how this
 * repository writes its imports. A specifier that resolves to a real `.ts` with no
 * rewriting is accepted too, so the generator does not depend on that convention
 * holding forever. Resolution asks the reader rather than the filesystem, so a test
 * can render from an in-memory tree and the seam stays the only way in.
 */
function resolveModulePath(
  fromModule: string,
  specifier: string,
  read: (modulePath: string) => string,
): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromModule), specifier))
  for (const candidate of [base.replace(/\.js$/, '.ts'), base, `${base}.ts`]) {
    try {
      read(candidate)
      return candidate
    } catch {
      // Try the next shape.
    }
  }
  return null
}

const BUILTINS = new Set(builtinModules)

/** `node:fs` and `fs` are the same module, and the repository uses both spellings. */
function isBuiltinSpecifier(specifier: string): boolean {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
  return BUILTINS.has(bare)
}

// ---------------------------------------------------------------------------
// Scanning a module
// ---------------------------------------------------------------------------

/**
 * A statement scanner, because `import`, `export` and `/` are also things a comment
 * and a string can contain.
 *
 * The scanner yields spans of real statements only: a word token is a keyword when it
 * is in code, a string token is a string, and a comment is skipped whole. Everything
 * downstream - erasing imports, stripping `export`, deciding whether a `/` opens a
 * regular expression - reads that token stream rather than the raw text, which is the
 * property that keeps `src/domain/envelope.ts`'s prose about type-only imports from
 * pulling the storage layer into a plugin file.
 */
type Token =
  | { readonly kind: 'word'; readonly value: string; readonly start: number; readonly end: number }
  | { readonly kind: 'string'; readonly value: string; readonly start: number; readonly end: number }
  | { readonly kind: 'regex'; readonly start: number; readonly end: number }
  | { readonly kind: 'punct'; readonly value: string; readonly start: number; readonly end: number }

/** A quoted literal, which is the only place an import specifier can be. */
type StringToken = Extract<Token, { readonly kind: 'string' }>

function scan(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const char = source[i] as string
    if (source.startsWith('//', i)) {
      const newline = source.indexOf('\n', i)
      i = newline === -1 ? source.length : newline
      continue
    }
    if (source.startsWith('/*', i)) {
      const close = source.indexOf('*/', i + 2)
      i = close === -1 ? source.length : close + 2
      continue
    }
    if (char === '"' || char === "'") {
      const close = scanQuoted(source, i, char)
      tokens.push({ kind: 'string', value: source.slice(i + 1, close), start: i, end: close + 1 })
      i = close + 1
      continue
    }
    if (char === '`') {
      i = scanTemplate(source, i, tokens)
      continue
    }
    if (char === '/' && regexCanStartHere(tokens)) {
      const close = scanRegex(source, i)
      tokens.push({ kind: 'regex', start: i, end: close })
      i = close
      continue
    }
    if (isIdentifierStart(char)) {
      let end = i + 1
      while (end < source.length && isIdentifierPart(source[end] as string)) end += 1
      tokens.push({ kind: 'word', value: source.slice(i, end), start: i, end })
      i = end
      continue
    }
    if (isSpace(char)) {
      i += 1
      continue
    }
    tokens.push({ kind: 'punct', value: char, start: i, end: i + 1 })
    i += 1
  }
  return tokens
}

/**
 * Whether a `/` here opens a regular expression or is a division.
 *
 * The standard heuristic: a regex cannot follow a value, so a `)`, `]`, `}` or an
 * identifier means division, and everything else - an operator, an `=`, a `(`,
 * `return` - means a regex. The three keywords are the ones after which a `/` starts
 * an expression rather than continuing one.
 */
function regexCanStartHere(tokens: readonly Token[]): boolean {
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i]
    if (token === undefined) return true
    if (token.kind === 'word') {
      return !(token.value === 'return' || token.value === 'typeof' || token.value === 'case')
    }
    if (token.kind === 'punct') {
      return !(token.value === ')' || token.value === ']' || token.value === '}')
    }
    return false
  }
  return true
}

/** The index of the closing quote of a `'...'` or `"..."` literal. */
function scanQuoted(source: string, start: number, quote: string): number {
  let i = start + 1
  while (i < source.length) {
    const char = source[i] as string
    if (char === '\\') {
      i += 2
      continue
    }
    if (char === quote) return i
    i += 1
  }
  return source.length
}

/**
 * A template literal, with its interpolations scanned as code.
 *
 * The returned index is just past the closing backtick. The literal's own text is not
 * tokenized, because nothing downstream needs it: module bodies are copied verbatim,
 * and only a keyword or a quote inside `${}` can be mistaken for a statement.
 */
function scanTemplate(source: string, start: number, tokens: Token[]): number {
  let i = start + 1
  while (i < source.length) {
    const char = source[i] as string
    if (char === '\\') {
      i += 2
      continue
    }
    if (char === '`') return i + 1
    if (char === '$' && source[i + 1] === '{') {
      const end = scanInterpolation(source, i + 2)
      tokens.push(...end.tokens)
      i = end.next
      continue
    }
    i += 1
  }
  return source.length
}

/** The tokens of one `${...}`, and the index just past its closing brace. */
function scanInterpolation(source: string, start: number): { tokens: Token[]; next: number } {
  const tokens: Token[] = []
  let i = start
  let depth = 1
  while (i < source.length && depth > 0) {
    const char = source[i] as string
    if (source.startsWith('//', i)) {
      const newline = source.indexOf('\n', i)
      i = newline === -1 ? source.length : newline
      continue
    }
    if (source.startsWith('/*', i)) {
      const close = source.indexOf('*/', i + 2)
      i = close === -1 ? source.length : close + 2
      continue
    }
    if (char === '{') {
      depth += 1
      i += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      i += 1
      continue
    }
    if (char === '"' || char === "'") {
      const close = scanQuoted(source, i, char)
      tokens.push({ kind: 'string', value: source.slice(i + 1, close), start: i, end: close + 1 })
      i = close + 1
      continue
    }
    if (char === '`') {
      i = scanTemplate(source, i, tokens)
      continue
    }
    if (isIdentifierStart(char)) {
      let end = i + 1
      while (end < source.length && isIdentifierPart(source[end] as string)) end += 1
      tokens.push({ kind: 'word', value: source.slice(i, end), start: i, end })
      i = end
      continue
    }
    if (isSpace(char)) {
      i += 1
      continue
    }
    tokens.push({ kind: 'punct', value: char, start: i, end: i + 1 })
    i += 1
  }
  return { tokens, next: i }
}

/** The index just past a `/.../` literal, escapes and character classes included. */
function scanRegex(source: string, start: number): number {
  let i = start + 1
  let inClass = false
  while (i < source.length) {
    const char = source[i] as string
    if (char === '\\') {
      i += 2
      continue
    }
    if (char === '\n') return i
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    else if (char === '/' && !inClass) {
      i += 1
      while (i < source.length && isIdentifierPart(source[i] as string)) i += 1
      return i
    }
    i += 1
  }
  return source.length
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char)
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char)
}

function isSpace(char: string): boolean {
  return /\s/.test(char)
}

/** One import statement: the span to erase, plus what is needed to sort it. */
interface ImportStatement {
  readonly typeOnly: boolean
  /** `'node:path'` or `'./translate.js'`, without the quotes. */
  readonly specifier: string
  readonly start: number
  readonly end: number
  /** The text between `import` and the specifier: `{ a, b as c }`, `* as ns`, `x`. */
  readonly clause: string
}

/** Every import statement in a module, in source order. */
function scanImports(source: string): ImportStatement[] {
  const tokens = scan(source)
  const statements: ImportStatement[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined || token.kind !== 'word' || token.value !== 'import') continue
    // `import.meta` and `import(...)` are expressions, and neither has a specifier.
    const next = tokens[i + 1]
    if (next !== undefined && next.kind === 'punct' && (next.value === '.' || next.value === '(')) {
      continue
    }
    let typeOnly = false
    let cursor = i + 1
    const first = tokens[cursor]
    if (first !== undefined && first.kind === 'word' && first.value === 'type') {
      // `import type {` and `import type X from` are type-only; `import type from
      // 'x'` imports a binding that happens to be called `type`.
      const after = tokens[cursor + 1]
      if (after !== undefined && !(after.kind === 'word' && after.value === 'from')) {
        typeOnly = true
        cursor += 1
      }
    }
    const found = findSpecifier(tokens, cursor)
    if (found === undefined) continue
    statements.push({
      typeOnly,
      specifier: found.specifier.value,
      start: token.start,
      end: findStatementEnd(source, found.specifier.end),
      // Everything between `import` and the specifier, minus the `from` that joins
      // them: `{ a, b as c }`, `* as ns` or `path`. Reading it as "up to the quote"
      // instead leaves a trailing `from` in the clause, which then matches no binding
      // form at all and silently hoists nothing.
      clause: source.slice(token.end, found.clauseEnd).trim(),
    })
  }
  return statements
}

/** A quoted specifier, and where the binding clause before it ends. */
interface FoundSpecifier {
  readonly specifier: StringToken
  /** The start of the `from` keyword, or of the specifier for a bare `import 'x'`. */
  readonly clauseEnd: number
}

/** The quoted specifier of the import statement running from `from` onwards. */
function findSpecifier(tokens: readonly Token[], from: number): FoundSpecifier | undefined {
  for (let i = from; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined) continue
    if (token.kind === 'word' && token.value === 'from') {
      const specifier = tokens[i + 1]
      if (specifier === undefined || specifier.kind !== 'string') return undefined
      return { specifier, clauseEnd: token.start }
    }
    // A statement that never says `from` is a bare `import 'x'`.
    if (token.kind === 'string') return { specifier: token, clauseEnd: token.start }
    if (token.kind === 'punct' && token.value === ';') return undefined
  }
  return undefined
}

/** Just past the statement: the specifier's closing quote and an optional `;`. */
function findStatementEnd(source: string, afterSpecifier: number): number {
  let i = afterSpecifier
  while (i < source.length && isSpace(source[i] as string)) i += 1
  return source[i] === ';' ? i + 1 : afterSpecifier
}

// ---------------------------------------------------------------------------
// Turning one module into a body
// ---------------------------------------------------------------------------

/** One node builtin's bindings, gathered so a repeated import collapses. */
interface BuiltinImport {
  readonly specifier: string
  readonly named: string[]
  readonly defaults: string[]
  readonly namespaces: string[]
}

/** One top-level declaration, and the span to erase if it turns out to be a duplicate. */
interface TopLevelDeclaration {
  readonly name: string
  readonly modulePath: string
  readonly start: number
  /** One past the declaration, or `start` when its extent could not be bounded. */
  readonly end: number
  readonly text: string
  /** `true` when the declaration's own braces were matched, so the span is exact. */
  readonly bounded: boolean
}

/**
 * Every top-level declaration in a module, with an exact span where one exists.
 *
 * Depth is counted over punctuation tokens, which is sound here because the scanner
 * has already turned comments, strings, regular expressions and template text into
 * something other than punctuation - so a `}` in a comment or a `{` in a message
 * cannot move the count. If a declaration's extent cannot be bounded (a `const` with no
 * braces and no semicolon, say) it comes back unbounded, and an unbounded declaration
 * is never erased: the consequence is a refused duplicate rather than a mangled file.
 */
function topLevelDeclarations(modulePath: string, source: string): TopLevelDeclaration[] {
  const tokens = scan(source)
  // The end of an import statement is a statement boundary even though the token
  // before the next declaration is a quoted specifier. Without this, every
  // declaration that happens to follow an import is invisible to the duplicate check,
  // and the check that is supposed to catch a collision quietly does not.
  const importSpans = scanImports(source).map((statement) => [statement.start, statement.end] as const)
  const found: TopLevelDeclaration[] = []
  let depth = 0
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined) continue
    if (token.kind === 'punct') {
      if (token.value === '{') depth += 1
      else if (token.value === '}') depth -= 1
      continue
    }
    if (token.kind !== 'word' || depth !== 0 || !DECLARATION_KEYWORDS.has(token.value)) continue
    if (!startsStatement(source, tokens, i, importSpans)) continue
    const name = tokens[i + 1]
    if (name === undefined || name.kind !== 'word') continue
    const start = declarationStart(tokens, i)
    const extent = declarationExtent(tokens, i)
    found.push({
      name: name.value,
      modulePath,
      start,
      end: extent.end,
      text: extent.bounded ? source.slice(start, extent.end) : '',
      bounded: extent.bounded,
    })
  }
  return found
}

/** The earliest of the run of `export`/`declare`/`abstract`/`async` before a keyword. */
function declarationStart(tokens: readonly Token[], keywordAt: number): number {
  let start = tokens[keywordAt]?.start ?? 0
  for (let i = keywordAt - 1; i >= 0; i -= 1) {
    const token = tokens[i]
    if (token === undefined || token.kind !== 'word') break
    if (!DECLARATION_MODIFIERS.has(token.value)) break
    start = token.start
  }
  return start
}

/**
 * Whether a keyword at this position opens a declaration or is an operator.
 *
 * Two things have to be told apart, and each cost a bug to find:
 *
 *   - `as const`, where the `const` is a type operator ending the statement in front of
 *     it. Treating it as a declaration named whatever token came next is how
 *     `export const KNOWN_HARNESSES = [...] as const` came to look like a declaration
 *     called `export`. It is never the first token on its line, so the line test
 *     catches it and the token tests catch the rest.
 *   - A real declaration that happens to follow a statement with no semicolon, so the
 *     previous token is a literal - `export const b = 2` then `function helper()`.
 *     There the previous token is a number, which no boundary rule can recognise. It is
 *     the first token on its line, so the line test catches that too.
 *
 * The line test is the primary one because a formatted declaration keyword is at the
 * start of its line, and a continuation operator never is. The token tests are what
 * stop a keyword that shares a line with the start of its own declaration - `export
 * const` - from being missed.
 */
function startsStatement(
  source: string,
  tokens: readonly Token[],
  at: number,
  importSpans: ReadonlyArray<readonly [number, number]>,
): boolean {
  const token = tokens[at]
  if (token === undefined) return false
  const lineStart = source.lastIndexOf('\n', Math.max(token.start - 1, 0)) + 1
  if (source.slice(lineStart, token.start).trim() === '') return true
  const previous = tokens[at - 1]
  if (previous === undefined) return true
  if (previous.kind === 'word') return DECLARATION_MODIFIERS.has(previous.value)
  if (previous.kind === 'punct') {
    return previous.value === '{' || previous.value === '}' || previous.value === ';'
  }
  // A quoted specifier can only be the tail of an import statement, because a bare
  // literal is an expression and cannot end a declaration.
  return importSpans.some(([start, end]) => previous.start >= start && previous.end <= end)
}

/** The end of a declaration, and whether it was actually bounded. */
function declarationExtent(tokens: readonly Token[], keywordAt: number): { end: number; bounded: boolean } {
  let depth = 0
  let opened = false
  for (let i = keywordAt; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined) return { end: tokens[keywordAt]?.start ?? 0, bounded: false }
    if (token.kind !== 'punct') continue
    if (token.value === '{') {
      depth += 1
      opened = true
      continue
    }
    if (token.value === '}') {
      depth -= 1
      if (opened && depth === 0) return { end: token.end, bounded: true }
      continue
    }
    if (token.value === ';' && depth === 0) return { end: token.end, bounded: true }
  }
  return { end: tokens[keywordAt]?.start ?? 0, bounded: false }
}

const DECLARATION_KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'class',
  'interface',
  'type',
  'enum',
  'namespace',
])

const DECLARATION_MODIFIERS = new Set(['export', 'declare', 'abstract', 'async'])

/**
 * The spans of the duplicate declarations that have to be erased.
 *
 * Two inlined modules share one module scope, so a name declared by both is a
 * duplicate declaration - a SyntaxError, and therefore a plugin opencode cannot load.
 * There are exactly two such names in the adapter today, and in both cases the two
 * copies are byte-identical private helpers (`isThenable`, and the hub's
 * `isAlreadyExists`), so the honest fix is to emit the first and erase the rest: the
 * emitted file then holds one copy of a helper that was one copy to begin with, and
 * not one identifier is rewritten anywhere in the product.
 *
 * Identical-but-differently-indented text is accepted, because two copies of the same
 * helper differing only in leading whitespace are still the same helper. Anything
 * else - two declarations of one name whose bodies differ, or a duplicate whose extent
 * could not be bounded - is refused with `unsupported-module` naming the name. That is
 * a deliberate choice over a mechanical renamer: a renamer that guessed wrong would
 * put a file into every session on the machine that loads and behaves differently from
 * the source, and nothing would say so.
 */
function duplicateDeclarationSpans(
  modules: readonly { readonly modulePath: string; readonly source: string }[],
): Map<string, Array<readonly [number, number]>> {
  const owners = new Map<string, TopLevelDeclaration[]>()
  for (const entry of modules) {
    for (const declaration of topLevelDeclarations(entry.modulePath, entry.source)) {
      const list = owners.get(declaration.name)
      if (list === undefined) owners.set(declaration.name, [declaration])
      else list.push(declaration)
    }
  }

  const spans = new Map<string, Array<readonly [number, number]>>()
  for (const [name, declarations] of owners) {
    if (declarations.length < 2) continue
    const first = declarations[0] as TopLevelDeclaration
    const same = declarations.every(
      (declaration) => declaration.bounded && normalise(first.text) === normalise(declaration.text),
    )
    if (!same) {
      throw new PluginRenderError(
        'unsupported-module',
        declarations[1]?.modulePath ?? first.modulePath,
        `duplicate top-level name: ${name} (also in ${first.modulePath})`,
      )
    }
    const erases = declarations.slice(1).map((declaration) => [declaration.start, declaration.end] as const)
    spans.set(name, erases)
  }
  return spans
}

/** Whitespace runs collapsed, so indentation cannot make two helpers look different. */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * One module's contribution to the emitted file.
 *
 * Four edits and nothing else: the span of every import is erased, the span of every
 * duplicate declaration is erased, the `export` keyword in front of a top-level
 * declaration is dropped, and the rest of the file is copied byte for byte. A change in
 * the adapter's logic therefore cannot be changed on the way through this function,
 * which is the whole reason the emitted file is generated rather than written (ADR-005).
 *
 * The node builtins it imported are recorded in one table shared by every module and
 * emitted once for the whole file, because the emitted file is one module scope: three
 * copies of `import path from 'node:path'` would be three declarations of `path`.
 */
function transformModule(
  modulePath: string,
  source: string,
  builtins: Set<string>,
  table: Map<string, BuiltinImport>,
  duplicates: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>,
): string {
  const erases: Array<readonly [number, number]> = []

  for (const statement of scanImports(source)) {
    erases.push([statement.start, statement.end])
    if (statement.typeOnly) continue
    if (isBuiltinSpecifier(statement.specifier)) {
      builtins.add(statement.specifier)
      mergeBuiltinImport(table, statement)
    }
  }
  for (const declaration of topLevelDeclarations(modulePath, source)) {
    const span = duplicates.get(declaration.name)
    if (span === undefined) continue
    for (const [start, end] of span) {
      if (source.slice(start, end) === source.slice(declaration.start, declaration.end)) {
        erases.push([start, end])
      }
    }
  }

  return stripExportKeywords(modulePath, eraseSpans(source, erases))
}

/** Record one builtin import's bindings, ignoring a repeat of a binding already held. */
function mergeBuiltinImport(table: Map<string, BuiltinImport>, statement: ImportStatement): void {
  const existing = table.get(statement.specifier) ?? {
    specifier: statement.specifier,
    named: [],
    defaults: [],
    namespaces: [],
  }
  const clause = statement.clause
  const braced = /^\{([\s\S]*)\}$/.exec(clause)
  if (braced !== null) {
    for (const part of splitList(braced[1] as string)) {
      if (!existing.named.includes(part)) existing.named.push(part)
    }
    table.set(statement.specifier, existing)
    return
  }
  const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause)
  const single = /^([A-Za-z_$][\w$]*)(?:\s*,\s*(\*\s+as\s+[A-Za-z_$][\w$]*|\{[\s\S]*\}))?$/.exec(clause)
  if (namespace !== null) {
    if (!existing.namespaces.includes(namespace[1] as string)) existing.namespaces.push(namespace[1] as string)
  } else if (single !== null) {
    if (!existing.defaults.includes(single[1] as string)) existing.defaults.push(single[1] as string)
    // `import x, { y } from 'p'` keeps both bindings; both are legal statements.
    if (single[2] !== undefined) {
      const trailing = /^\{([\s\S]*)\}$/.exec(single[2].trim())
      const trailingNamespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(single[2].trim())
      if (trailing !== null) {
        for (const part of splitList(trailing[1] as string)) {
          if (!existing.named.includes(part)) existing.named.push(part)
        }
      } else if (trailingNamespace !== null) {
        const local = trailingNamespace[1] as string
        if (!existing.namespaces.includes(local)) existing.namespaces.push(local)
      }
    }
  }
  table.set(statement.specifier, existing)
}

/** One import statement per binding form, which is the fewest statements Node accepts. */
function renderBuiltinImports(entry: BuiltinImport): string[] {
  const lines: string[] = []
  if (entry.named.length > 0) lines.push(`import { ${entry.named.join(', ')} } from '${entry.specifier}'`)
  for (const local of entry.defaults) lines.push(`import ${local} from '${entry.specifier}'`)
  for (const local of entry.namespaces) lines.push(`import * as ${local} from '${entry.specifier}'`)
  return lines
}

function splitList(body: string): string[] {
  return body
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/** Remove the erased spans, keeping every other byte. */
function eraseSpans(source: string, spans: ReadonlyArray<readonly [number, number]>): string {
  const ordered = [...spans].sort((a, b) => a[0] - b[0])
  let out = ''
  let cursor = 0
  for (const [start, end] of ordered) {
    if (start < cursor) continue
    out += source.slice(cursor, start)
    cursor = end
  }
  return out + source.slice(cursor)
}

/**
 * Drop the `export` keyword from a top-level declaration, and refuse anything else.
 *
 * `export` is only legal at the top level of a module, so every `export` the scanner
 * found is a top-level one. Two shapes need handling and they are handled differently,
 * because the difference is the whole job:
 *
 *   - `export const X = ...` declares something. Erasing the keyword leaves the
 *     declaration, which is what the emitted file needs.
 *   - `export type { A, B }` re-exports names this module already declares, so erasing
 *     the keyword would leave `type { A, B }` - a type alias with no name and no body.
 *     The whole statement is erased instead. `src/domain/envelope.ts` has one.
 *
 * `export { A }`, `export { A } from './b'`, `export * from './b'` and `export default`
 * are refused rather than guessed at. The `from` forms in particular cannot be
 * inlined mechanically: they create a local binding for a name the module never
 * declares, so erasing the statement would leave that name undefined in the emitted
 * file. Failing here means the failure is an install error with a named module, not a
 * developer's session that cannot start.
 */
function stripExportKeywords(modulePath: string, body: string): string {
  const tokens = scan(body)
  const erases: Array<readonly [number, number]> = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined || token.kind !== 'word' || token.value !== 'export') continue
    const next = tokens[i + 1]
    if (next === undefined) {
      throw new PluginRenderError('unsupported-module', modulePath, 'export')
    }
    // `export type { A, B }`: a re-export list, erased whole.
    if (next.kind === 'word' && next.value === 'type' && isBrace(tokens[i + 2])) {
      erases.push([token.start, endOfExportList(modulePath, tokens, i + 2)])
      continue
    }
    if (next.kind === 'punct' || (next.kind === 'word' && next.value === '*')) {
      throw new PluginRenderError('unsupported-module', modulePath, `export ${describeNext(tokens, i + 1)}`)
    }
    const offset = next.kind === 'word' && (next.value === 'async' || next.value === 'declare') ? 2 : 1
    const declared = tokens[i + offset]
    if (declared === undefined || declared.kind !== 'word' || !EXPORTABLE.has(declared.value)) {
      throw new PluginRenderError('unsupported-module', modulePath, 'export')
    }
    // `export const { a } = ...` is not used here; refusing it is better than erasing
    // four characters and leaving a destructuring behind.
    if (isBrace(tokens[i + offset + 1])) {
      throw new PluginRenderError('unsupported-module', modulePath, 'export destructuring')
    }
    erases.push([token.start, next.start])
  }
  return eraseSpans(body, erases)
}

function isBrace(token: Token | undefined): boolean {
  return token !== undefined && token.kind === 'punct' && token.value === '{'
}

/** The end of an `export type { ... }` statement, and a refusal to guess past it. */
function endOfExportList(modulePath: string, tokens: readonly Token[], braceAt: number): number {
  let depth = 0
  for (let i = braceAt; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined) break
    if (token.kind !== 'punct') continue
    if (token.value === '{') depth += 1
    else if (token.value === '}') {
      depth -= 1
      if (depth === 0) {
        const after = tokens[i + 1]
        if (after !== undefined && after.kind === 'word' && after.value === 'from') {
          throw new PluginRenderError('unsupported-module', modulePath, 'export ... from')
        }
        return token.end
      }
    }
  }
  throw new PluginRenderError('unsupported-module', modulePath, 'unterminated export list')
}

/** Enough of the offending form to name it in a failure message. */
function describeNext(tokens: readonly Token[], at: number): string {
  const parts: string[] = []
  for (let i = at; i < at + 2; i += 1) {
    const token = tokens[i]
    if (token === undefined) break
    parts.push(token.kind === 'punct' ? token.value : token.kind === 'word' ? token.value : '...')
  }
  return parts.join(' ') || '(nothing)'
}

const EXPORTABLE = new Set([
  'const',
  'let',
  'var',
  'function',
  'async',
  'class',
  'abstract',
  'declare',
  'interface',
  'type',
  'enum',
  'namespace',
])

function errorNameOf(cause: unknown): string {
  return cause instanceof Error ? cause.name : 'unknown'
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** How a generated file can fail to load. */
export type VerifyFailureCode =
  /** It loaded, but exported no plugin function. */
  | 'not-a-plugin'
  /** It loaded and reported nothing at all, which for an adapter is the failure. */
  | 'silent'
  /** The module, its syntax or a dependency could not be loaded. */
  | 'unloadable'
  /** The verification did not answer inside the bound. */
  | 'timeout'

export interface VerifyResult {
  readonly ok: boolean
  readonly code?: VerifyFailureCode
  /** The fault's class name. */
  readonly errorName?: string
  /**
   * The loader's own message.
   *
   * Safe to show here, unlike a breadcrumb: it is produced by loading a file this
   * installer just wrote from this product's own sources, so it can contain a
   * generated line and a path and nothing else - no harness payload and no
   * conversation content (APX-FR-01).
   */
  readonly message?: string
  /** What the loaded module proved, when it did. */
  readonly observed?: VerifyObservation
}

/** What the verification actually saw, so a caller can assert on it. */
export interface VerifyObservation {
  readonly exportNames: readonly string[]
  readonly hookNames: readonly string[]
  /** Service names the loaded plugin wrote to the harness's own logging client. */
  readonly logServices: readonly string[]
  readonly logLines: number
  /**
   * The breadcrumb codes the loaded plugin reported.
   *
   * Closed tokens the transport chose, and the reason they are recorded: a line in the
   * harness log proves the file did not throw, which is not the same as proving the
   * file works. A file whose inlined imports were dropped reports `request-failed`
   * rather than the code for "no hub is running", so the code is what tells those two
   * apart.
   */
  readonly breadcrumbCodes: readonly string[]
}

export interface VerifyOptions {
  /** How long the verification may take before it is abandoned. */
  readonly timeoutMs?: number
  /** A state directory the verification may read. Defaults to an empty temp dir. */
  readonly stateDir?: string
  /** Skips the child process, for a caller that only wants the render. */
  readonly run?: (filePath: string, bounds: { timeoutMs: number; stateDir: string }) => VerifyResult
}

/** The bound on a verification: long enough to load a 4600-line file, short enough. */
export const VERIFY_TIMEOUT_MS = 20_000

/**
 * Load the file, drive one event through it, and report what happened.
 *
 * "Loads" is not proven by parsing, so the file is imported in a fresh Node process,
 * its export is called with a stub harness client, one `session.status` event is fed
 * through the real `event` hook, and the lines that reached the stub's logging client
 * are counted. With no hub running the transport's own breadcrumb is what should
 * arrive, so a file that loads but does not report is a failure too - which is the
 * property that actually matters for an adapter nobody is watching.
 */
export function verifyPluginFile(filePath: string, options: VerifyOptions = {}): VerifyResult {
  const run = options.run ?? runVerificationProcess
  // A scratch state directory the CALLER supplied belongs to the caller, which is why
  // `installGlobalPlugin` removes its own. One made here belongs to here: the function
  // that creates a directory removes it, so calling this without a `stateDir` - which
  // is what a direct caller and `doctor` do - cannot leave a directory behind in the
  // system temporary directory on every call (OA-FR-08, no orphan).
  const scratch = options.stateDir === undefined ? makeScratchDir('agent-ping-verify-') : undefined
  try {
    return run(filePath, {
      timeoutMs: options.timeoutMs ?? VERIFY_TIMEOUT_MS,
      stateDir: scratch ?? (options.stateDir as string),
    })
  } finally {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * The child process's program.
 *
 * `process.argv[1]` onwards are the arguments after `-e`, so the file, the export name
 * and the session directory arrive positionally and need no quoting. Everything it
 * reports is a closed token or a count; the error branch sends a message because a
 * load failure is a bug report about a file this installer wrote, and that file is
 * this product's own source.
 */
const VERIFY_SCRIPT = `const url = process.argv[1]
const services = []
const codes = []
let lines = 0
const client = {
  app: {
    log: (request) => {
      lines += 1
      const body = request?.body ?? {}
      if (typeof body.service === 'string') services.push(body.service)
      const code = body.extra?.code
      if (typeof code === 'string') codes.push(code)
      return Promise.resolve()
    },
  },
}
try {
  const mod = await import(url)
  const plugin = mod[process.argv[2]]
  if (typeof plugin !== 'function') {
    process.stdout.write(JSON.stringify({ ok: false, code: 'not-a-plugin', exports: Object.keys(mod) }))
  } else {
    const hooks = (await plugin({ client, directory: process.argv[3] })) ?? {}
    const names = Object.keys(hooks)
    if (typeof hooks.event === 'function') {
      // The 1.18.32 shape for EventSessionStatus: { sessionID, status: { type } }.
      // Sending a plausible-looking but wrong payload would produce a counted,
      // unattributable event and no delivery, which is a check that passes for the
      // wrong reason.
      await hooks.event({
        event: { type: 'session.status', properties: { sessionID: 'verify', status: { type: 'idle' } } },
      })
      // Delivery is fire and forget, so give the breadcrumb a turn of the loop.
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    const verdict =
      lines === 0
        ? { ok: false, code: 'silent', exports: Object.keys(mod), hooks: names, services, codes, lines }
        : { ok: true, exports: Object.keys(mod), hooks: names, services, codes, lines }
    process.stdout.write(JSON.stringify(verdict))
  }
} catch (cause) {
  process.stdout.write(
    JSON.stringify({ ok: false, code: 'unloadable', errorName: cause?.name ?? 'unknown', message: String(cause?.message ?? cause) }),
  )
}
`

function runVerificationProcess(
  filePath: string,
  bounds: { timeoutMs: number; stateDir: string },
): VerifyResult {
  const result = spawnSync(
    process.execPath,
    [
      // A no-op on the Node lines that strip types by default, and what lets
      // 22.12-22.17 load the file at all, so the bound in `engines` holds.
      '--experimental-strip-types',
      '--no-warnings',
      '--input-type=module',
      '-e',
      VERIFY_SCRIPT,
      pathToFileURL(path.resolve(filePath)).href,
      PLUGIN_EXPORT_NAME,
      path.join(tmpdir(), 'agent-ping-verify-session'),
    ],
    {
      encoding: 'utf8',
      timeout: bounds.timeoutMs,
      env: { ...process.env, AGENT_PING_STATE_DIR: bounds.stateDir },
    },
  )
  if (result.error !== undefined) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
    return { ok: false, code: timedOut ? 'timeout' : 'unloadable', errorName: result.error.name }
  }
  const stdout = (result.stdout ?? '').trim()
  if (stdout === '') {
    return {
      ok: false,
      code: result.status === 0 ? 'not-a-plugin' : 'unloadable',
      errorName: 'VerificationNoOutput',
      message: `the verification process exited with status ${String(result.status)} and wrote nothing`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (cause) {
    return { ok: false, code: 'unloadable', errorName: errorNameOf(cause), message: stdout }
  }
  return readVerdict(parsed)
}

function readVerdict(parsed: unknown): VerifyResult {
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, code: 'unloadable', errorName: 'VerificationNoOutput', message: 'no verdict' }
  }
  const fields = parsed as Readonly<Record<string, unknown>>
  if (fields['ok'] !== true) {
    const code = fields['code']
    return {
      ok: false,
      code:
        code === 'not-a-plugin' || code === 'silent' || code === 'timeout'
          ? code
          : 'unloadable',
      ...(typeof fields['errorName'] === 'string' ? { errorName: fields['errorName'] } : {}),
      ...(typeof fields['message'] === 'string' ? { message: fields['message'] } : {}),
    }
  }
  return {
    ok: true,
    observed: {
      exportNames: readStrings(fields['exports']),
      hookNames: readStrings(fields['hooks']),
      logServices: readStrings(fields['services']),
      logLines: typeof fields['lines'] === 'number' ? fields['lines'] : 0,
      breadcrumbCodes: readStrings(fields['codes']),
    },
  }
}

function readStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function makeScratchDir(prefix: string, parent: string = tmpdir()): string {
  // `mkdtemp` needs its parent to exist, and a caller-supplied staging directory is
  // not required to. Creating it here means pointing staging at a fresh directory
  // works, rather than failing the install with a bare ENOENT.
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(path.join(parent, prefix))
}

// ---------------------------------------------------------------------------
// The install record
// ---------------------------------------------------------------------------

/** What the package.json beside the plugin says about the installed plugin. */
export interface InstallRecord {
  readonly schemaVersion: number
  readonly product: string
  readonly version: string
  readonly pluginFile: string
  readonly sourceHash: string
  readonly installedAt: string
}

/** The package.json as read from disk, with the parts we do not own left alone. */
export interface InstalledMetadata {
  readonly record: InstallRecord | null
  /** `true` when this file carries our record and we may rewrite or remove it. */
  readonly ours: boolean
  readonly exists: boolean
}

/**
 * Read the install record, and say whether the file is ours.
 *
 * `ours` is what stops this installer from rewriting a developer's own `package.json`
 * in their plugin directory: a file without our record is somebody else's, and it is
 * reported rather than replaced (APX-CON-03).
 */
export function readInstalledMetadata(metadataFile: string): InstalledMetadata {
  if (!existsSync(metadataFile)) return { record: null, ours: false, exists: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(metadataFile, 'utf8'))
  } catch {
    return { record: null, ours: false, exists: true }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { record: null, ours: false, exists: true }
  }
  const section = (parsed as Readonly<Record<string, unknown>>)[METADATA_KEY]
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    return { record: null, ours: false, exists: true }
  }
  const fields = section as Readonly<Record<string, unknown>>
  const version = fields['version']
  const pluginFile = fields['pluginFile']
  const sourceHash = fields['sourceHash']
  if (typeof version !== 'string' || typeof pluginFile !== 'string' || typeof sourceHash !== 'string') {
    return { record: null, ours: false, exists: true }
  }
  return {
    ours: true,
    exists: true,
    record: {
      schemaVersion: typeof fields['schemaVersion'] === 'number' ? fields['schemaVersion'] : 0,
      product: typeof fields['product'] === 'string' ? fields['product'] : PRODUCT_NAME,
      version,
      pluginFile,
      sourceHash,
      installedAt: typeof fields['installedAt'] === 'string' ? fields['installedAt'] : '',
    },
  }
}

/** The product version recorded in a generated file, or null for somebody else's. */
export function installedVersionOf(pluginFile: string): string | null {
  const head = readIfPresent(pluginFile)
  if (head === null) return null
  const opening = head.slice(0, GENERATED_SENTINEL.length + 400)
  if (!opening.startsWith(GENERATED_SENTINEL)) return null
  return /^\/\/ product-version: (.+)$/m.exec(opening)?.[1]?.trim() ?? null
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * The things an install can be.
 *
 * Each is a different thing to tell a human, which is why they are separate rather
 * than a boolean: "nothing was here", "it was already this", "it was an older copy of
 * this", "somebody else's version is installed" and "somebody else's file is in the
 * way" all call for a different sentence and a different next step.
 */
export type InstallOutcome =
  /** Nothing of ours was there; the file and its metadata are new. */
  | 'installed'
  /** Our file, same version, different bytes: replaced in place. */
  | 'reinstalled'
  /** Our file, same version, same bytes: nothing was written. */
  | 'unchanged'
  /** A different version is installed, and was not touched. */
  | 'conflict'
  /** A file that is not ours is in the way, and was not touched. */
  | 'blocked'
  /** The files could not be written. */
  | 'failed'
  /** The generated file did not load, so it was not published. */
  | 'unverified'

export type InstallFailureCode =
  | RenderFailureCode
  | VerifyFailureCode
  /** No product version was given, so the file could not be recognised later. */
  | 'no-version'
  /** A file that is not ours is in the way. */
  | 'metadata-not-ours'
  /** The files could not be written. */
  | 'not-writable'

export interface InstallResult {
  readonly outcome: InstallOutcome
  /** What the CLI prints. Written here so the wording cannot drift from the case. */
  readonly message: string
  readonly configDir: string
  readonly pluginDir: string
  readonly pluginFile: string
  readonly metadataFile: string
  /** The version this call asked to install. */
  readonly version: string
  /** The version found on disk, when there was one. */
  readonly previousVersion?: string
  /** `sha256` of the generated file, which is also written into the metadata. */
  readonly sourceHash: string
  readonly modules: readonly string[]
  /** What the verification saw, when it ran and passed. */
  readonly observed?: VerifyObservation
  /** The closed code behind a `failed`, `blocked` or `unverified` outcome. */
  readonly code?: InstallFailureCode
}

export interface InstallOptions {
  /** The product version to install. The caller knows it; this module never guesses. */
  readonly version: string
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly home?: string
  /** An explicit plugin directory, for a test or an operator with a custom root. */
  readonly pluginDir?: string
  /**
   * Where the pre-publication copy is written.
   *
   * Defaults to the system temporary directory, which is what keeps a `.ts` file out
   * of the directory opencode loads plugins from. An operator whose temporary directory
   * is on a different filesystem than their configuration can point this at the
   * configuration's own filesystem so the publish is a rename rather than a copy.
   */
  readonly stageDir?: string
  /** The clock, so a record's timestamp is a parameter rather than an ambient read. */
  readonly now?: () => Date
  /** Renders the file. Defaults to the real adapter sources. */
  readonly render?: () => RenderedPlugin
  /** Verifies the written file. Defaults to loading it in a child process. */
  readonly verify?: (filePath: string, options: VerifyOptions) => VerifyResult
  /** Replace a different installed version. The caller's decision to make explicit. */
  readonly force?: boolean
}

/**
 * Install the one file, or say why not.
 *
 * The order is the point. Nothing is published until the generated file has been shown
 * to load, so a failed render cannot leave a broken plugin in a directory opencode
 * reads at every startup (APX-FR-02). Then what is already on disk decides: same
 * version and same bytes is a no-op, same version and different bytes is a replacement,
 * a different version is a report, and a file that is not ours is a report.
 */
export function installGlobalPlugin(options: InstallOptions): InstallResult {
  const version = options.version
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const pluginDir = options.pluginDir ?? resolveGlobalPluginDir({ env, platform, home })
  const configDir = path.dirname(pluginDir)
  const pluginFile = path.join(pluginDir, PLUGIN_FILE_NAME)
  const metadataFile = path.join(pluginDir, METADATA_FILE_NAME)
  const render = options.render ?? ((): RenderedPlugin => renderPluginSource({ version }))
  const verify = options.verify ?? verifyPluginFile
  const now = options.now ?? ((): Date => new Date())
  const base = { configDir, pluginDir, pluginFile, metadataFile, version }

  // A blank version would render a file whose own header names no version, and the next
  // install would then read that file as somebody else's and refuse to touch it. Caught
  // here, where the message can be useful, rather than on the next run.
  if (version.trim() === '') {
    return {
      ...base,
      outcome: 'failed',
      code: 'no-version',
      sourceHash: '',
      modules: [],
      message: 'agent-ping did not install: no product version was given, and a plugin file with no version in it cannot be recognised by the next install.',
    }
  }

  let rendered: RenderedPlugin
  try {
    rendered = render()
  } catch (cause) {
    if (cause instanceof PluginRenderError) {
      return {
        ...base,
        outcome: 'failed',
        code: cause.code,
        sourceHash: '',
        modules: [],
        message: `agent-ping did not install: ${cause.message}`,
      }
    }
    throw cause
  }
  const base2 = { ...base, sourceHash: rendered.hash, modules: rendered.modules }

  const existingMetadata = readInstalledMetadata(metadataFile)
  const existingVersion = installedVersionOf(pluginFile)

  // Somebody else's file, in either of the two places this installer writes. Reported,
  // never replaced: overwriting a developer's own plugin or package.json is a sidecar
  // destroying a session's configuration (APX-CON-03).
  if (existsSync(pluginFile) && existingVersion === null) {
    return {
      ...base2,
      outcome: 'blocked',
      code: 'metadata-not-ours',
      message: `agent-ping did not install: ${pluginFile} exists and was not written by agent-ping, so it was left alone. Move it aside and install again.`,
    }
  }
  if (existingMetadata.exists && !existingMetadata.ours) {
    return {
      ...base2,
      outcome: 'blocked',
      code: 'metadata-not-ours',
      message: `agent-ping did not install: ${metadataFile} exists and carries no agent-ping install record, so it was left alone. Move it aside and install again.`,
    }
  }

  // A different installed version is reported, not overwritten. `force` is how a
  // caller says the operator has decided; there is no silent path.
  if (existingVersion !== null && existingVersion !== version && options.force !== true) {
    return {
      ...base2,
      outcome: 'conflict',
      previousVersion: existingVersion,
      message: `agent-ping ${version} was not installed: ${pluginFile} already holds agent-ping ${existingVersion}, and replacing another version is a decision rather than a default. Uninstall first, or install again with force.`,
    }
  }

  const unchanged =
    existingVersion === version &&
    existingMetadata.record?.sourceHash === rendered.hash &&
    readIfPresent(pluginFile) === rendered.text

  // A repeat install of an unchanged product writes nothing at all. It still loads the
  // file that is already published - the one opencode will read - and reports if that
  // file does not load, because "already installed" must not mean "believed to be
  // fine". Not one byte and not one timestamp changes on this path (OA-FR-08).
  if (unchanged) {
    // The scratch state directory is made here, so it is removed here - including when
    // `verify` throws, which is the one path a `finally` is for. A repeat install is
    // the most common thing an operator does, so a leak on this path is a directory
    // in the system temporary directory per repeat (OA-FR-08).
    const reverifyStateDir = makeScratchDir('agent-ping-verify-', options.stageDir ?? tmpdir())
    let reverified: VerifyResult
    try {
      reverified = verify(pluginFile, { stateDir: reverifyStateDir })
    } finally {
      rmSync(reverifyStateDir, { recursive: true, force: true })
    }
    if (!reverified.ok) {
      return {
        ...base2,
        outcome: 'unverified',
        code: reverified.code,
        message: `agent-ping did not change anything, and the installed file no longer passes its own check. ${describeVerification(reverified)}`,
      }
    }
    return {
      ...base2,
      outcome: 'unchanged',
      previousVersion: existingVersion,
      observed: reverified.observed,
      message: `agent-ping ${version} is already installed at ${pluginFile}; nothing was changed.`,
    }
  }

  let staging: StagedFile
  try {
    mkdirSync(pluginDir, { recursive: true })
    staging = stageFile(rendered.text, options.stageDir ?? tmpdir())
  } catch (cause) {
    return {
      ...base2,
      outcome: 'failed',
      code: 'not-writable',
      message: `agent-ping did not install: ${pluginDir} could not be written (${errorNameOf(cause)}).`,
    }
  }

  const verified = verify(staging.filePath, { stateDir: staging.stateDir })
  rmSync(staging.stateDir, { recursive: true, force: true })
  if (!verified.ok) {
    rmSync(staging.dir, { recursive: true, force: true })
    return {
      ...base2,
      outcome: 'unverified',
      code: verified.code,
      message: `agent-ping did not install: the generated plugin did not load, so it was not written. ${describeVerification(verified)}`,
    }
  }

  if (!publishStagedFile(staging, pluginFile, rendered.text)) {
    rmSync(staging.dir, { recursive: true, force: true })
    return {
      ...base2,
      outcome: 'failed',
      code: 'not-writable',
      message: `agent-ping did not install: ${pluginFile} could not be written.`,
    }
  }
  rmSync(staging.dir, { recursive: true, force: true })
  try {
    writeMetadata(metadataFile, version, rendered, now())
  } catch (cause) {
    return {
      ...base2,
      outcome: 'failed',
      code: 'not-writable',
      message: `agent-ping installed ${pluginFile} but could not write ${metadataFile} (${errorNameOf(cause)}). Run install again to record it.`,
    }
  }

  if (existingVersion === null) {
    return {
      ...base2,
      outcome: 'installed',
      observed: verified.observed,
      message: `agent-ping ${version} installed at ${pluginFile}. opencode loads it for every session on this machine, with no per-repository setup.`,
    }
  }
  return {
    ...base2,
    outcome: 'reinstalled',
    previousVersion: existingVersion,
    observed: verified.observed,
    message: `agent-ping ${version} replaced the copy at ${pluginFile} in place. There is still exactly one plugin file.`,
  }
}

/** A rendered file on disk, not yet published, plus the scratch state directory. */
interface StagedFile {
  readonly filePath: string
  /** The temporary directory holding the staged file, removed whatever happens next. */
  readonly dir: string
  /** A scratch state directory, so the verification reads nothing real. */
  readonly stateDir: string
}

/**
 * Stage the rendered file outside the plugin directory.
 *
 * The file has to end in `.ts` to be loadable at all - the verification caught that,
 * which is what it is for - and a `.ts` file inside the plugin directory is a file
 * opencode will try to load as a second plugin. So the staged copy lives in a
 * temporary directory, is verified there, and is moved into place afterwards. A
 * rename is atomic within a filesystem; across one it is not possible, so that case
 * copies verified bytes instead and says nothing about it, because the content was
 * already proven before either path ran.
 */
function stageFile(text: string, parent: string): StagedFile {
  const dir = makeScratchDir('agent-ping-stage-', parent)
  const filePath = path.join(dir, PLUGIN_FILE_NAME)
  // Owner-only in the temporary directory; the published copy is a readable source
  // file, which it can be because it holds no credential (the write token is read at
  // run time from the state directory).
  writeFileSync(filePath, text, { encoding: 'utf8', mode: 0o600 })
  return { filePath, dir, stateDir: makeScratchDir('agent-ping-verify-', parent) }
}

/** Move the verified file into place, copying when a rename cannot cross devices. */
function publishStagedFile(staging: StagedFile, pluginFile: string, text: string): boolean {
  try {
    renameSync(staging.filePath, pluginFile)
    return true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EXDEV') return false
    try {
      writeFileSync(pluginFile, text, { encoding: 'utf8', mode: 0o644 })
      return true
    } catch {
      return false
    }
  }
}

function writeMetadata(
  metadataFile: string,
  version: string,
  rendered: RenderedPlugin,
  now: Date,
): void {
  const record: InstallRecord = {
    schemaVersion: INSTALL_RECORD_VERSION,
    product: PRODUCT_NAME,
    version,
    pluginFile: PLUGIN_FILE_NAME,
    sourceHash: rendered.hash,
    installedAt: now.toISOString(),
  }
  const document: Record<string, unknown> = {
    // `type: module` is the only field here that changes how a loader reads the plugin
    // file beside it, and it is there because the emitted file is ESM.
    name: 'agent-ping-opencode-plugin',
    version,
    private: true,
    type: 'module',
    description:
      'agent-ping: local notifications for coding agents. Generated by `agent-ping install`; see the plugin file header.',
    // Empty on purpose, and asserted to stay empty: the plugin needs no package, so
    // opencode never has to install anything for it to load.
    dependencies: {},
    [METADATA_KEY]: record,
  }
  writeFileSync(metadataFile, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  try {
    chmodSync(metadataFile, 0o644)
  } catch {
    // A filesystem without POSIX modes: the file exists, which is all that needs it.
  }
}

function readIfPresent(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/**
 * Remove the plugin directory if our files emptied it.
 *
 * `rmdir` is the whole safety mechanism: it fails on a directory that still holds
 * anything, so this cannot remove a directory with another plugin in it whatever the
 * caller believed. `rmSync` is not used because it refuses a directory outright, which
 * would make the prune a silent no-op on every platform.
 */
function pruneEmptyDir(dir: string): boolean {
  try {
    if (readdirSync(dir).length > 0) return false
    rmdirSync(dir)
    return true
  } catch {
    return false
  }
}

function describeVerification(result: VerifyResult): string {
  if (result.code === 'timeout') return 'Loading it took longer than the bound allows.'
  if (result.code === 'not-a-plugin') return 'Loading it produced no plugin function to call.'
  if (result.code === 'silent') {
    return 'It loaded, but one harness event through it reported nothing at all, which is the failure this check exists for.'
  }
  return `Loading it failed${result.errorName === undefined ? '' : ` with ${result.errorName}`}${result.message === undefined ? '.' : `: ${result.message}`}`
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

/** The three things an uninstall can be. */
export type UninstallOutcome =
  /** Our file and its metadata are gone. */
  | 'removed'
  /** Nothing of ours was installed, and nothing was touched. */
  | 'absent'
  /** Files are there but are not ours, and were left alone. */
  | 'blocked'
  /** The files could not be removed. */
  | 'failed'

export interface UninstallResult {
  readonly outcome: UninstallOutcome
  readonly message: string
  readonly configDir: string
  readonly pluginDir: string
  readonly pluginFile: string
  readonly metadataFile: string
  /** What was removed, in full paths. Empty on `absent`. */
  readonly removed: readonly string[]
  /** What was deliberately left, in full paths. Non-empty only when something is not ours. */
  readonly kept: readonly string[]
  /** Whether an emptied plugin directory was removed with the files. */
  readonly prunedDir: boolean
  readonly code?: InstallFailureCode
}

export interface UninstallOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly home?: string
  readonly pluginDir?: string
}

/**
 * Remove the file and its metadata, and nothing else.
 *
 * Safe when nothing is installed, which is the state a machine is in after a
 * half-finished install or a manual clean-up, and safe to run twice: the second call
 * removes nothing and says so. opencode's own configuration, a project `.opencode/`
 * directory and every other plugin in the directory are untouched, and the plugin
 * directory itself is removed only when removing our files emptied it (APX-CON-03: a
 * sidecar that cleans up after itself and nothing else).
 */
export function uninstallGlobalPlugin(options: UninstallOptions = {}): UninstallResult {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const pluginDir = options.pluginDir ?? resolveGlobalPluginDir({ env, platform, home })
  const configDir = path.dirname(pluginDir)
  const pluginFile = path.join(pluginDir, PLUGIN_FILE_NAME)
  const metadataFile = path.join(pluginDir, METADATA_FILE_NAME)
  const base = { configDir, pluginDir, pluginFile, metadataFile }

  if (!existsSync(pluginDir)) {
    return {
      ...base,
      outcome: 'absent',
      removed: [],
      kept: [],
      prunedDir: false,
      message: `agent-ping is not installed: there is no plugin directory at ${pluginDir}. Nothing was changed.`,
    }
  }

  const metadata = readInstalledMetadata(metadataFile)
  const kept: string[] = []
  if (existsSync(pluginFile) && installedVersionOf(pluginFile) === null) kept.push(pluginFile)
  if (metadata.exists && !metadata.ours) kept.push(metadataFile)

  if (kept.length > 0) {
    return {
      ...base,
      outcome: 'blocked',
      code: 'metadata-not-ours',
      removed: [],
      kept,
      prunedDir: false,
      message: `agent-ping did not remove ${kept.join(' and ')}: ${kept.length === 1 ? 'that file was not written by agent-ping' : 'those files were not written by agent-ping'}. Nothing was changed.`,
    }
  }

  const removed: string[] = []
  for (const target of [pluginFile, metadataFile]) {
    if (!existsSync(target)) continue
    try {
      unlinkSync(target)
      removed.push(target)
    } catch (cause) {
      return {
        ...base,
        outcome: 'failed',
        code: 'not-writable',
        removed,
        kept: [],
        prunedDir: false,
        message: `agent-ping removed ${removed.length} of 2 files and could not remove ${target} (${errorNameOf(cause)}). Run uninstall again.`,
      }
    }
  }

  if (removed.length === 0) {
    return {
      ...base,
      outcome: 'absent',
      removed,
      kept,
      prunedDir: false,
      message: `agent-ping is not installed: there is no plugin file at ${pluginFile}. Nothing was changed.`,
    }
  }

  const prunedDir = pruneEmptyDir(pluginDir)
  return {
    ...base,
    outcome: 'removed',
    removed,
    kept: [],
    prunedDir,
    message: `agent-ping removed ${removed.length} file${removed.length === 1 ? '' : 's'} from ${pluginDir}${prunedDir ? ', and the now-empty plugin directory with them' : ''}. No opencode session is instrumented.`,
  }
}
