// The card document, as a built artefact and as a mount of the product's own view
// (NT-FR-02, NT-FR-10, NT-FR-12, ADR-012).
//
//   npm test -- tests/dashboard/card-document.test.ts
//
// WHY THIS FILE BUILDS THE DASHBOARD ITSELF
//
// The acceptance criterion is about the *built* `dist/dashboard/card.html`, so a test
// that read whatever happened to be in `dist/` would be asserting against the last thing
// somebody built - including a build from before this document existed. So the real
// build runs here, through the same Vite CLI `npm run build:dashboard` runs, into the
// same output directory, and every claim below is about that artefact. Two builds take
// about three seconds, which is cheaper than a green result that means nothing.
//
// WHAT IS PROVEN HERE, AND WHERE THE REST LIVES
//
//   - The artefact set is three pages, and the card document is the one the surface
//     asks for: `dist/dashboard/card.html`, compared against SURFACE_DOCUMENT_PATH read
//     out of src/notify/surface/electron-host.ts rather than typed out here.
//   - The document links a stylesheet and a module script, and inlines neither a style
//     attribute nor a script. The hub's DASHBOARD_CSP is `style-src 'self'` and
//     `script-src 'self'` with no `unsafe-inline` (src/hub/security.ts), so an inline
//     style is refused by the browser rather than ignored - and it is refused quietly
//     enough to look like a rendering fault.
//   - The two existing pages are byte-for-byte what they were before this page joined
//     the build. Proven by building the same sources *without* the card entry and
//     comparing every byte both pages load, not by pinning a digest that a later,
//     legitimate edit to the live page would trip.
//   - The entry's import closure resolves through the Vite `@` alias, reaches no `node:`
//     module, no subprocess and no filesystem, and is compiled from TypeScript source
//     rather than copied out of `dist/main`. The sourcemap of the emitted chunk is the
//     decisive evidence: it names the `.ts` files the chunk was built from.
//   - The document mounts the product's own `createCardView`: the real built markup is
//     loaded into jsdom, the real entry module is imported against it, and the card
//     that appears carries the attributes and the words card-view.ts writes.
//
// The two things that are NOT proven here, and are not claimed: that a card reaches this
// document from the Electron main process (that is the renderer channel, NS-2, and this
// task excludes it), and that the hub serves the document with the right headers (that
// is a real socket over the real route, in tests/hub/server.test.ts). Both are recorded
// as gaps rather than asserted as facts.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SURFACE_DOCUMENT_PATH } from '@/notify/surface/electron-host'
import {
  CARD_BODY_ATTRIBUTE,
  CARD_DEEP_LINK_ATTRIBUTE,
  CARD_EXPIRES_ATTRIBUTE,
  CARD_LIFETIME_ATTRIBUTE,
  CARD_MOTION_ATTRIBUTE,
  CARD_ROOT_ATTRIBUTE,
  CARD_TITLE_ATTRIBUTE,
  CARD_URGENCY_ATTRIBUTE,
  CARD_URGENCY_ICON_ATTRIBUTE,
  CARD_URGENCY_WORD_ATTRIBUTE,
} from '@/notify/surface/card-view'
import type { CardModel } from '@/notify/surface/card'
import { cardLifetimeFor } from '@/notify/surface/lifetime'

// ---------------------------------------------------------------------------
// Where things are
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const VITE_BIN = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const BUILD = path.join(REPO_ROOT, 'dist', 'dashboard')

/** The two pages that existed before this one, as paths inside the built artefact. */
const EXISTING_PAGES = ['index.html', 'prototype/index.html'] as const

/**
 * A Vite config that is this product's own, with one key removed.
 *
 * It has to live in the repository root: vite.config.ts derives its root, its outDir and
 * its `@` alias from `import.meta.url`, and a bundled config evaluated from anywhere else
 * resolves those against the wrong directory. So it is written next to the real config,
 * used once, and deleted in `afterAll` - and it *imports* the real config rather than
 * repeating it, so "the same sources, without the card entry" is literally true.
 */
const COMPARISON_CONFIG = path.join(REPO_ROOT, 'vite.card-document-comparison.config.ts')
/** Where that config puts its output. Also inside the repository, for the same reason. */
const COMPARISON_OUT = path.join(REPO_ROOT, 'dist', 'card-document-comparison')

function repositoryPath(relative: string): string {
  return path.join(REPO_ROOT, relative)
}

function runViteBuild(args: readonly string[]): void {
  const result = spawnSync(process.execPath, [VITE_BIN, 'build', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // Vite is chatty about a third page joining the build; the build log is not the
    // subject of this file, and a failure throws with the real reason attached.
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(
      `the dashboard build failed (exit ${String(result.status)}):\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Reading the built artefact
// ---------------------------------------------------------------------------

const CARD_DOCUMENT = path.join(BUILD, SURFACE_DOCUMENT_PATH.replace(/^\//, ''))
const cardDocumentText = (): string => readFileSync(CARD_DOCUMENT, 'utf8')

/**
 * The card document with its HTML comments removed.
 *
 * The built document carries the comment that explains it - the same convention the live
 * page follows - and that comment names `<style>`, `style` attributes and
 * `data-card-surface` in prose. A browser reads none of that as markup, so a check for an
 * inline style or a second surface has to look at the markup rather than at the file, or
 * it fails on this product's own documentation. Every shape assertion below reads this.
 */
function cardDocumentMarkup(): string {
  return cardDocumentText().replace(/<!--[\s\S]*?-->/g, '')
}

/** Every `<link>` tag in a built document, in order. */
function linkTags(html: string): string[] {
  return html.match(/<link\b[^>]*>/g) ?? []
}

/** Every opening `<script>` tag in a built document, in order. */
function scriptTags(html: string): string[] {
  return html.match(/<script\b[^>]*>/g) ?? []
}

/** The value of one attribute in a tag, or null when the tag does not carry it. */
function attributeOf(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
  return match?.[1] ?? null
}

/** The path a built document's reference resolves to, or null when it is not a file. */
function referencedPath(reference: string): string | null {
  if (!reference.startsWith('./') && !reference.startsWith('../')) return null
  return path.resolve(path.dirname(CARD_DOCUMENT), reference)
}

// ---------------------------------------------------------------------------
// Reading a module's imports
// ---------------------------------------------------------------------------

/**
 * One source file with its comments removed and its strings kept.
 *
 * The same reader tests/notify/policy.test.ts uses and for the same reasons: a
 * source-level check is about the calls a module makes rather than the sentences
 * describing them, and this repository's prose names every forbidden thing it avoids, so
 * keeping comments would make the check fail on its own documentation. Strings stay,
 * because a forbidden *specifier* is most often only ever a string.
 *
 * Known limitation, stated rather than hidden: a backtick template is read as one string
 * to its closing backtick, so a nested template inside a `${...}` would end the scan
 * early. No module in the card document's closure contains one.
 */
function readModuleWithoutProse(relative: string): string {
  const source = readFileSync(repositoryPath(relative), 'utf8')
  let out = ''
  let index = 0
  const blank = (length: number): void => {
    for (let offset = 0; offset < length; offset += 1) {
      out += source[index + offset] === '\n' ? '\n' : ' '
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
      const found = source.indexOf('*/', index + 2)
      const stop = found === -1 ? source.length : found + 2
      blank(stop - index)
      index = stop
      continue
    }
    const character = source[index] ?? ''
    if (character === "'" || character === '"' || character === '`') {
      let cursor = index + 1
      while (cursor < source.length) {
        const inner = source[cursor]
        if (inner === '\\') {
          cursor += 2
          continue
        }
        if (inner === character) {
          cursor += 1
          break
        }
        if (character !== '`' && inner === '\n') break
        cursor += 1
      }
      out += `${character}${source.slice(index + 1, cursor - 1)}${character}`
      index = cursor
      continue
    }
    out += character
    index += 1
  }
  return out
}

/** One `import`/`export ... from` statement found in a module's source. */
interface ModuleSpecifier {
  readonly statement: string
  readonly specifier: string
  /**
   * Whether the statement survives in the emitted module.
   *
   * `import type` and `export type` do not: they are erased, so the module they name is
   * not part of what a renderer loads. A mixed clause - `import { a, type B }` - does,
   * because `a` is a value, and that is why this is a property of the whole statement
   * rather than of each specifier in it.
   */
  readonly erased: boolean
}

function moduleSpecifiers(relative: string): ModuleSpecifier[] {
  const source = readModuleWithoutProse(relative)
  const found: ModuleSpecifier[] = []
  const pattern = /(?:^|\n)\s*(import|export)\s+([^\n]*?)\bfrom\s*(['"])([^'"]+)\3/g
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const keyword = match[1] ?? ''
    const clause = (match[2] ?? '').trim()
    const specifier = match[4] ?? ''
    const erased = clause === 'type' || clause.startsWith('type ')
    found.push({ statement: `${keyword} ${clause} from '${specifier}'`.trim(), specifier, erased })
  }
  return found
}

/**
 * Every module the browser would load, starting at one entry.
 *
 * Value specifiers only, and the alias resolved the way Vite resolves it: `@/x` is
 * `src/x` with a TypeScript extension. The result is a set of repository-relative paths,
 * sorted, so a test can compare it to a named list.
 */
function importClosure(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || seen.has(current)) continue
    seen.add(current)
    for (const found of moduleSpecifiers(current)) {
      if (found.erased) continue
      const resolved = resolveModuleSpecifier(current, found.specifier)
      if (resolved !== null) queue.push(resolved)
    }
  }
  return [...seen].sort()
}

/** The repository-relative module a specifier names, or null when it is not ours. */
function resolveModuleSpecifier(importer: string, specifier: string): string | null {
  const from = specifier.startsWith('@/') ? path.join('src', specifier.slice(2)) : path.join(path.dirname(importer), specifier)
  const withoutExtension = from.replace(/\.(js|ts)$/, '')
  for (const candidate of [`${withoutExtension}.ts`, `${withoutExtension}.tsx`, withoutExtension]) {
    if (existsSync(repositoryPath(candidate))) return candidate.split(path.sep).join('/')
  }
  return null
}

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

/** WCAG 2.1 relative luminance, from a `#rrggbb` string. */
function relativeLuminance(hex: string): number {
  const channel = (value: number): number => {
    const scaled = value / 255
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  const r = channel(parseInt(hex.slice(1, 3), 16))
  const g = channel(parseInt(hex.slice(3, 5), 16))
  const b = channel(parseInt(hex.slice(5, 7), 16))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.1 contrast ratio between two `#rrggbb` strings. */
function contrastRatio(foreground: string, background: string): number {
  const one = relativeLuminance(foreground)
  const two = relativeLuminance(background)
  const lighter = Math.max(one, two)
  const darker = Math.min(one, two)
  return (lighter + 0.05) / (darker + 0.05)
}

/** Every `--card-*` custom property the stylesheet declares, by name. */
function cardTokens(): Map<string, string> {
  const source = readModuleWithoutProse('src/dashboard/card.css')
  const tokens = new Map<string, string>()
  for (const match of source.matchAll(/(--card-[a-z-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens.set(match[1] ?? '', (match[2] ?? '').toLowerCase())
  }
  return tokens
}

// ---------------------------------------------------------------------------
// The builds
// ---------------------------------------------------------------------------

beforeAll(() => {
  // The real build, into the real output directory: this is `npm run build:dashboard`.
  runViteBuild([])
  // The same sources without this task's page, for the comparison below. The config
  // imports the real one and removes exactly one key, so the two builds differ by the
  // card entry and by nothing else in the configuration.
  writeFileSync(
    COMPARISON_CONFIG,
    [
      '// GENERATED by tests/dashboard/card-document.test.ts. Do not edit.',
      "import base from './vite.config'",
      "import { fileURLToPath } from 'node:url'",
      '',
      "const outDir = fileURLToPath(new URL('./dist/card-document-comparison', import.meta.url))",
      'const input = { ...(base.build?.rollupOptions?.input as Record<string, string>) }',
      "delete input.card",
      '',
      'export default {',
      '  ...base,',
      '  build: {',
      '    ...base.build,',
      '    outDir,',
      '    emptyOutDir: true,',
      '    rollupOptions: { ...base.build?.rollupOptions, input },',
      '  },',
      '}',
      '',
    ].join('\n'),
  )
  runViteBuild(['--config', COMPARISON_CONFIG])
}, 180_000)

afterAll(() => {
  rmSync(COMPARISON_CONFIG, { force: true })
  rmSync(COMPARISON_OUT, { force: true, recursive: true })
})

// ---------------------------------------------------------------------------
// The artefact set
// ---------------------------------------------------------------------------

describe('the built dashboard is three pages, and the third is the card document', () => {
  it('emits exactly the three documents, and the card one at the path the surface asks for', () => {
    const documents = readdirSync(BUILD, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
      .map((entry) => path.relative(BUILD, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .sort()

    expect(documents).toEqual(['card.html', 'index.html', 'prototype/index.html'])
    // The comparison build put the same three minus the card page there, which is the
    // shape the "first two unchanged" test below compares against.
    expect(existsSync(CARD_DOCUMENT)).toBe(true)
    expect(path.relative(BUILD, CARD_DOCUMENT).split(path.sep).join('/')).toBe(SURFACE_DOCUMENT_PATH.replace(/^\//, ''))
  })

  it('leaves the two existing pages byte-for-byte as they were without this page', () => {
    for (const page of EXISTING_PAGES) {
      const withCard = readFileSync(path.join(BUILD, page))
      const withoutCard = readFileSync(path.join(COMPARISON_OUT, page))
      // A digest would prove the same thing about today and break on the next legitimate
      // edit to the live page, so the comparison is a second build of the same sources
      // with the card entry removed, and the bytes are compared one for one.
      expect(withCard.equals(withoutCard), `${page} differs between the two-entry and three-entry builds`).toBe(true)

      // And every asset those two pages load, because a page whose own HTML is
      // unchanged while its script is a different build is not an unchanged page.
      for (const reference of pageReferences(readFileSync(path.join(BUILD, page), 'utf8'))) {
        const relative = path.relative(BUILD, path.resolve(path.dirname(path.join(BUILD, page)), reference))
        const built = readFileSync(path.join(BUILD, relative))
        const compared = readFileSync(path.join(COMPARISON_OUT, relative))
        expect(built.equals(compared), `${page}'s ${relative} differs between the two builds`).toBe(true)
      }
    }
  })
})

/** Every `./`-relative reference a built page makes, scripts and stylesheets alike. */
function pageReferences(html: string): string[] {
  const references: string[] = []
  for (const tag of [...linkTags(html), ...scriptTags(html)]) {
    const value = attributeOf(tag, 'href') ?? attributeOf(tag, 'src')
    if (value !== null && (value.startsWith('./') || value.startsWith('../'))) references.push(value)
  }
  return references
}

// ---------------------------------------------------------------------------
// The card document's own shape
// ---------------------------------------------------------------------------

describe('the card document is what the policy permits, in the built bytes', () => {
  it('links one stylesheet and one module script, and inlines neither', () => {
    const html = cardDocumentMarkup()

    const stylesheets = linkTags(html).filter((tag) => attributeOf(tag, 'rel') === 'stylesheet')
    const modules = scriptTags(html).filter((tag) => attributeOf(tag, 'type') === 'module')

    expect(stylesheets).toHaveLength(1)
    expect(modules).toHaveLength(1)

    // A stylesheet with no href, or a module with no src, is an inline style or an
    // inline script wearing a different hat. DASHBOARD_CSP refuses both, so the shape
    // is checked rather than trusted.
    const stylesheetHref = attributeOf(stylesheets[0] ?? '', 'href')
    const moduleSrc = attributeOf(modules[0] ?? '', 'src')
    expect(stylesheetHref).not.toBeNull()
    expect(moduleSrc).not.toBeNull()

    // Both resolve to a real file inside the built artefact, of the right kind, and
    // neither is absolute: a page that has to be served from one origin should not
    // carry a second one in its own markup.
    for (const [reference, extension] of [
      [stylesheetHref, '.css'],
      [moduleSrc, '.js'],
    ] as const) {
      const resolved = referencedPath(reference ?? '')
      expect(resolved, reference ?? '').not.toBeNull()
      expect(existsSync(resolved as string), reference ?? '').toBe(true)
      expect(path.extname(resolved as string)).toBe(extension)
    }
  })

  it('contains no style attribute, no inline script, and nothing a strict policy refuses', () => {
    const html = cardDocumentMarkup()

    // No `style="..."` anywhere, in the head or the body.
    expect(html).not.toMatch(/\sstyle\s*=/i)
    // No `<style>` element.
    expect(html).not.toMatch(/<style\b/i)
    // No script without a `src`: strip the one external module script and what is left
    // must be nothing at all, which is the whole of "no inline script".
    const withoutExternalScripts = html.replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*>\s*<\/script>/g, '')
    expect(withoutExternalScripts).not.toMatch(/<script\b/i)
    // No event-handler attribute, and no policy of its own: the hub already sends
    // DASHBOARD_CSP with this document, and a second policy in the markup is either a
    // dead declaration or an attempt to widen the one that governs it.
    expect(html).not.toMatch(/\son[a-z]+\s*=/i)
    expect(html).not.toMatch(/http-equiv\s*=\s*["']?content-security-policy/i)
    expect(html).not.toMatch(/unsafe-inline|unsafe-eval/)
    // No second origin: every reference is relative, and nothing is a data:, blob: or
    // remote URL (APX-CON-12, NT-FR-11).
    for (const reference of pageReferences(html)) {
      expect(reference.startsWith('http'), reference).toBe(false)
      expect(reference.startsWith('//'), reference).toBe(false)
      expect(reference.startsWith('data:'), reference).toBe(false)
    }
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//)
    expect(html).not.toMatch(/(src|href)="(data|blob|file|javascript):/)
  })

  it('carries the surface element a card is put inside, and nothing else on the page', () => {
    const html = cardDocumentMarkup()
    // The same element name the verification script's own report reads, and the same one
    // the entry module looks for, so "where does a card go" has one answer.
    expect(html).toMatch(/<div\s+data-card-surface\s*><\/div>/)
    // No dashboard, and no second surface: a card document that grew the live page's
    // header or a canvas would be a second page inside a 320x96 window.
    expect(html).not.toMatch(/data-dashboard-header|data-dashboard-root|<canvas/i)
    expect(html.match(/data-card-surface/g) ?? []).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The import closure
// ---------------------------------------------------------------------------

describe("the card entry is the product's own view, compiled from source", () => {
  it('resolves its imports through the vite @ alias and reaches four product modules', () => {
    const entry = 'src/dashboard/card-main.ts'

    // The alias, not a relative path into a sibling directory and not a path into a
    // build's output.
    const fromTheEntry = moduleSpecifiers(entry).filter((found) => !found.erased)
    expect(fromTheEntry.map((found) => found.specifier).sort()).toEqual([
      '@/notify/surface/card-view',
      '@/notify/surface/channel',
    ])
    for (const found of fromTheEntry) expect(found.erased).toBe(false)

    // The closure, followed through value imports only: an `import type` is erased, so
    // a module named only by one is not something a renderer loads.
    //
    // AMENDED BY NS-2, DELIBERATELY. NS-1 asserted four modules because the card entry
    // mounted the view and nothing else: how a model travelled from the Electron main
    // process into this document was undecided, and NS-1 said so and excluded it. NS-2
    // decided it - a preload with a context bridge - and the entry now installs the
    // document's end of that channel with `listenForCardSurface`, so the closure is five
    // modules. The one that was added is this product's own channel, from the same `src`
    // tree and built by the same Vite pass; nothing crossed a build boundary and no
    // privileged module was added.
    expect(importClosure(entry)).toEqual([
      'src/dashboard/card-main.ts',
      'src/notify/surface/card-view.ts',
      'src/notify/surface/card.ts',
      'src/notify/surface/channel.ts',
      'src/notify/surface/lifetime.ts',
    ])
  })

  it('reaches no node module, no subprocess and no filesystem from that closure', () => {
    const entry = 'src/dashboard/card-main.ts'
    for (const module of importClosure(entry)) {
      const source = readModuleWithoutProse(module)
      // A renderer with `sandbox: true` and no `require` does not fail on a node import
      // at build time; it fails on a developer's screen, which is the worst place to
      // find out. Nothing in the card document's closure may reach for one.
      expect(source, module).not.toMatch(/\bfrom\s*['"]node:/)
      expect(source, module).not.toMatch(/\brequire\s*\(/)
      expect(source, module).not.toMatch(/\bimport\s*\(\s*['"]/)
      expect(source, module).not.toMatch(/child_process|node:fs|readFileSync|writeFileSync|existsSync/)
    }
  })

  it('compiles the view from TypeScript source rather than copying dist/main', () => {
    const markup = cardDocumentMarkup()
    const moduleSrc = attributeOf(
      scriptTags(markup).find((tag) => attributeOf(tag, 'type') === 'module') ?? '',
      'src',
    )
    const emitted = referencedPath(moduleSrc ?? '')
    expect(emitted).not.toBeNull()

    // The sourcemap is the decisive evidence and it is not a matter of opinion: it names
    // the files the chunk was compiled from, and every one of them is a `.ts` under
    // `src/`. A copied `dist/main/notify/surface/card-view.js` would name a `.js` under
    // `dist/`, and there is no copy step in the build to have produced one.
    const map = JSON.parse(readFileSync(`${emitted as string}.map`, 'utf8')) as {
      readonly sources: readonly string[]
    }
    expect(map.sources.length).toBeGreaterThan(0)
    for (const source of map.sources) {
      // Relative to the emitted chunk, which lives in `dist/dashboard/assets/`, so the
      // prefix is however many `../` it took to get back to the repository root.
      expect(source, 'a card chunk compiled from something other than src/').toMatch(/^(?:\.\.\/)+src\/.+\.ts$/)
    }
    expect(map.sources.some((source) => source.includes('notify/surface/card-view.ts'))).toBe(true)
    expect(map.sources.some((source) => source.includes('dist/'))).toBe(false)

    // The build script's only copy is the durable schema, which IO-1 added because the
    // store loads `schema.sql` relative to its own emitted module: a hand-written SQL
    // file bound for `dist/main/storage/`, and nothing near the dashboard. So the claim
    // this assertion makes is unchanged - no compiled module is copied into a renderer
    // bundle - and it is now stated about what the build does rather than about a
    // spelling. It used to be a blanket ban on the words `copyFile` and `cpSync`, which
    // is a ban on a word: the first thing it caught was a copy of a `.sql` file, and it
    // would have caught a copy of `dist/main` just the same. Every copy the build
    // performs is enumerated here instead.
    const buildScript = readFileSync(repositoryPath('scripts/build.mjs'), 'utf8')
    const copies = [...buildScript.matchAll(/\b(?:copyFileSync|cpSync|copyFile)\s*\(([^)]*)\)/g)].map(
      (match) => match[1] ?? '',
    )
    expect(copies.length).toBeGreaterThan(0)
    for (const call of copies) {
      expect(call, `a build step copies something other than the durable schema: ${call}`).toMatch(
        /schema/i,
      )
      expect(call, `a build step copies into the dashboard: ${call}`).not.toMatch(/dashboard/i)
    }
    const built = readFileSync(emitted as string, 'utf8')
    expect(built).not.toContain('node:')
    expect(built).not.toMatch(/\bprocess\.env\b/)
    expect(built).not.toMatch(/\brequire\s*\(/)
    // The product's own words are in the chunk, which is what "the product's own view"
    // looks like in a minified file: its attribute names, its urgency word and its
    // lifetime tokens. The verification script's generated marker is not.
    expect(built).toContain('data-card-urgency-word')
    expect(built).toContain('Needs you')
    expect(built).toContain('until-resolved')
    expect(built).not.toContain('GENERATED by')
  })

  it('opens the product own channel and no other, because that channel is now built', () => {
    // AMENDED BY NS-2, DELIBERATELY. NS-1 asserted this entry "opens no channel of its
    // own", and it did not: the channel was undecided, so the document mounted a view
    // and listened to nothing, which is why a real delivery stayed `not-wired` and no
    // window was ever put on a screen empty. NS-2 decided the channel - a preload with a
    // context bridge - and the entry now installs the document's end of it. The assertion
    // is strengthened rather than removed: where NS-1 forbade any listener, this one
    // names the *only* listener the entry can install, and every privileged route stays
    // forbidden. The channel module reaches its own target, so this entry still names no
    // global and no event target of its own (NT-FR-12, APX-FR-01).
    const entry = readModuleWithoutProse('src/dashboard/card-main.ts')
    expect(entry).toMatch(/listenForCardSurface/)
    expect(entry).not.toMatch(/\bwindow\b/)
    expect(entry).not.toMatch(/globalThis/)
    expect(entry).not.toMatch(/addEventListener/)
    expect(entry).not.toMatch(/ipcRenderer|executeJavaScript|require\(|contextBridge|process\./)
    // And the channel the entry does open is the product's own, with its two-call surface
    // and its content-free guard - not a listener of its own invention.
    expect(entry).toMatch(/listenForCardSurface\(cardDocumentView\)/)
    const channel = readModuleWithoutProse('src/notify/surface/channel.ts')
    expect(channel).toMatch(/CARD_CHANNEL_SHOW/)
    expect(channel).toMatch(/CARD_CHANNEL_REMOVE/)
    // And the built document still does not carry the global the verification harness used
    // to substitute its own channel.
    expect(cardDocumentMarkup()).not.toContain('__agentPingCardSurface')
  })
})

// ---------------------------------------------------------------------------
// What the document actually mounts
// ---------------------------------------------------------------------------

describe('the built document mounts the product view and shows a product card', () => {
  it('renders the card the view writes, into the surface the document declares', async () => {
    // The real built markup, with its external references removed: jsdom is not asked
    // to fetch anything, and what is left is exactly what a browser would have parsed
    // before it started loading the module.
    const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(cardDocumentMarkup())?.[1] ?? ''
    const markup = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '')
    document.body.innerHTML = markup
    expect(document.querySelector('[data-card-surface]')).not.toBeNull()

    // The real entry module, imported against that document: it mounts on load because
    // the surface it looks for is there, exactly as the live page's entry point does.
    const entry = await import('@/dashboard/card-main')
    expect(entry.CARD_SURFACE_ATTRIBUTE).toBe('data-card-surface')
    const view = entry.cardDocumentView
    expect(view).not.toBeNull()
    if (view === null) return

    // An empty document draws nothing (NT-FR-10): the window exists for the life of the
    // hub, and a card document with a card in it before anything is delivered would put
    // a rectangle on a developer's screen for as long as the hub runs.
    expect(view.showing).toBe(false)
    expect(document.querySelector(`[${CARD_ROOT_ATTRIBUTE}]`)).toBeNull()
    expect(document.querySelectorAll('[data-card-surface] > *')).toHaveLength(0)

    const model: CardModel = {
      title: 'agent-ping',
      body: 'A tool permission is waiting on a decision.',
      urgency: 'critical',
      pendingCount: 1,
      deepLink: 'http://127.0.0.1:43117/?session=ses_card_document_01',
    }
    view.show(model, cardLifetimeFor('needs-you'))

    const card = document.querySelector(`[${CARD_ROOT_ATTRIBUTE}]`)
    expect(card).not.toBeNull()
    if (card === null) return
    // The card is inside the surface the document declares, so the view - not the
    // document - decides where a card goes.
    expect(card.parentElement?.getAttribute('data-card-surface')).toBe('')

    // Every attribute card-view.ts promises a stylesheet or a test can read, and the
    // two lines as the product's own text. No content is read out of a card anywhere
    // else in this product, and nothing about the words reaches a counter or a log
    // (APX-FR-01).
    for (const name of [
      CARD_URGENCY_ATTRIBUTE,
      CARD_LIFETIME_ATTRIBUTE,
      CARD_MOTION_ATTRIBUTE,
    ]) {
      expect(card.getAttribute(name), name).not.toBeNull()
    }
    expect(card.getAttribute(CARD_URGENCY_ATTRIBUTE)).toBe('critical')
    expect(card.getAttribute(CARD_LIFETIME_ATTRIBUTE)).toBe('until-resolved')
    expect(card.getAttribute('role')).toBe('status')
    expect(card.getAttribute('aria-live')).toBe('assertive')
    expect(card.getAttribute('tabindex')).toBe('0')
    expect(card.getAttribute(CARD_DEEP_LINK_ATTRIBUTE)).toBe(model.deepLink)
    // A needs-you card is not one that times out, so the attribute that would say so is
    // absent rather than set to something (NT-FR-08).
    expect(card.getAttribute(CARD_EXPIRES_ATTRIBUTE)).toBeNull()
    expect(card.querySelector(`[${CARD_URGENCY_ICON_ATTRIBUTE}]`)?.textContent).toBe('!')
    expect(card.querySelector(`[${CARD_URGENCY_WORD_ATTRIBUTE}]`)?.textContent).toBe('Needs you')
    expect(card.querySelector(`[${CARD_TITLE_ATTRIBUTE}]`)?.textContent).toBe(model.title)
    expect(card.querySelector(`[${CARD_BODY_ATTRIBUTE}]`)?.textContent).toBe(model.body)
    // The harness's own verdict reads this, and so does this test: under
    // `style-src 'self'` with no `unsafe-inline`, a card carrying a `style` attribute is
    // a card drawn wrong (NT-FR-02).
    expect(card.getAttribute('style')).toBeNull()

    // And it leaves, naming the end, leaving the surface as it was found.
    view.remove('resolved')
    expect(view.showing).toBe(false)
    expect(document.querySelector(`[${CARD_ROOT_ATTRIBUTE}]`)).toBeNull()
    expect(document.querySelectorAll('[data-card-surface] > *')).toHaveLength(0)
  })

  // NS-2. The document's end of the channel, against the real document and the real
  // event the preload dispatches. This is the page half of what the previous test proves
  // for the view: where the view's `show` is called by hand, here it is called by the
  // channel, so a card arriving at this document with no seam supplied is the thing being
  // asserted (NT-FR-12).
  it('shows and removes a card when the channel delivers one to this window', async () => {
    const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(cardDocumentMarkup())?.[1] ?? ''
    document.body.innerHTML = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '')
    // A fresh module instance, because the entry mounts on import and the previous test
    // already mounted one against the document it was given.
    vi.resetModules()
    const entry = await import('@/dashboard/card-main')
    const { CARD_CHANNEL_REMOVE, CARD_CHANNEL_SHOW, cardChannelShow, cardChannelRemove } = await import(
      '@/notify/surface/channel'
    )
    expect(entry.stopCardDocumentChannel).toBeTypeOf('function')

    const model: CardModel = {
      title: 'agent-ping',
      body: 'A tool permission is waiting on a decision.',
      urgency: 'critical',
      pendingCount: 1,
      deepLink: 'http://127.0.0.1:43117/?session=ses_card_document_01',
    }
    // What `preload.cts` does on receiving a message: dispatch the event this document
    // listens for, carrying the model and the cell and nothing else.
    window.dispatchEvent(
      new CustomEvent(CARD_CHANNEL_SHOW, {
        detail: cardChannelShow(model, cardLifetimeFor('needs-you')),
      }),
    )
    const card = document.querySelector(`[${CARD_ROOT_ATTRIBUTE}]`)
    expect(card).not.toBeNull()
    expect(card?.getAttribute('role')).toBe('status')
    expect(card?.getAttribute(CARD_URGENCY_ATTRIBUTE)).toBe('critical')
    expect(card?.getAttribute(CARD_LIFETIME_ATTRIBUTE)).toBe('until-resolved')
    expect(card?.getAttribute('style')).toBeNull()

    // A removal arrives the same way and leaves the surface as it was found.
    window.dispatchEvent(new CustomEvent(CARD_CHANNEL_REMOVE, { detail: cardChannelRemove('acknowledged') }))
    expect(document.querySelector(`[${CARD_ROOT_ATTRIBUTE}]`)).toBeNull()
    entry.stopCardDocumentChannel?.()
  })
})

// ---------------------------------------------------------------------------
// The stylesheet
// ---------------------------------------------------------------------------

describe('the card stylesheet draws the attributes the view writes, and nothing else', () => {
  const writtenByTheView = [
    CARD_ROOT_ATTRIBUTE,
    CARD_URGENCY_ATTRIBUTE,
    CARD_LIFETIME_ATTRIBUTE,
    CARD_EXPIRES_ATTRIBUTE,
    CARD_DEEP_LINK_ATTRIBUTE,
    CARD_TITLE_ATTRIBUTE,
    CARD_BODY_ATTRIBUTE,
    CARD_URGENCY_ICON_ATTRIBUTE,
    CARD_URGENCY_WORD_ATTRIBUTE,
    CARD_MOTION_ATTRIBUTE,
  ] as const

  /**
   * The three attributes deliberately given no rule.
   *
   * They are the view's facts about a card rather than its appearance, and painting any
   * of them would put meaning into the page that the card's own text does not carry:
   *
   *   - `data-lifetime` says whether the card expires or waits for a resolution. The
   *     class already drives how a card looks, and the word beside the icon already says
   *     which class it is; a second visual channel for the same fact would be a channel
   *     that a person reads with colour alone (APX-CON-07).
   *   - `data-expires-in` is a duration, and a card must never print a number that is not
   *     the number of outstanding blocks (NT-FR-06).
   *   - `data-deep-link` is a URL. It is an attribute and deliberately not a control, so
   *     nothing in the document may draw it as one.
   *
   * Naming them is what keeps the list from quietly growing: a fourth entry here would
   * be a decision to put a fact on the screen that the card's text does not support.
   */
  const deliberatelyUndrawn = [
    CARD_LIFETIME_ATTRIBUTE,
    CARD_EXPIRES_ATTRIBUTE,
    CARD_DEEP_LINK_ATTRIBUTE,
  ] as const

  it('has a rule for every attribute the view writes, and no rule for anything else', async () => {
    const css = readModuleWithoutProse('src/dashboard/card.css')
    const selectors = new Set(
      [...css.matchAll(/\[(data-[a-z-]+)/g)].map((match) => match[1] ?? '').filter((name) => name !== ''),
    )
    // The document's own attribute is the one exception, and it is not the view's: the
    // surface is the element card.html declares, and a stylesheet that could not size it
    // would leave a card floating in a window with no geometry. Read from the entry
    // module rather than typed here, so the two cannot drift.
    const { CARD_SURFACE_ATTRIBUTE } = await import('@/dashboard/card-main')

    // Nothing the view cannot write: a stylesheet inventing a state is how a card ends
    // up dressed for a condition this product does not have.
    for (const name of selectors) {
      expect([...writtenByTheView, CARD_SURFACE_ATTRIBUTE], name).toContain(name)
    }
    // And every attribute that needs painting is painted, with the two exceptions named
    // above and no others.
    const undrawn = writtenByTheView.filter((name) => !selectors.has(name))
    expect([...undrawn].sort()).toEqual([...deliberatelyUndrawn].sort())
  })

  it('honours the reduced-motion attribute the view writes, and the preference behind it', () => {
    const css = readModuleWithoutProse('src/dashboard/card.css')
    // Keyed on the attribute, so the card's motion state is a fact in the document, and
    // the media query as well, so a card rendered by a path that skipped the view is
    // still still.
    expect(css).toMatch(/\[data-motion-state-arrival='instant'\]/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
    expect(css).toMatch(/animation: none/)
    // The page paints nothing itself: the host window is `transparent: true` and
    // exists for the whole life of the hub, so an opaque page background would be the
    // always-on rectangle ADR-009 declined.
    expect(css).toMatch(/(html,\s*body|body)\s*\{[^}]*background:\s*transparent/)
  })

  it('meets WCAG AA for every text pair it paints, and 3:1 for every border', () => {
    const tokens = cardTokens()
    // The tokens the stylesheet's own rules use, named here so a palette change is a
    // diff in this list rather than a silent repaint.
    const textPairs: readonly (readonly [string, string, string])[] = [
      ['--card-text', '--card-fill', 'the two lines on the card'],
      ['--card-text-muted', '--card-fill', 'the urgency word on the card'],
      ['--card-text', '--card-block-fill', 'the two lines on a needs-you card'],
      ['--card-text-muted', '--card-block-fill', 'the urgency word on a needs-you card'],
      ['--card-text', '--card-finished-fill', 'the two lines on a finished card'],
      ['--card-text-muted', '--card-finished-fill', 'the urgency word on a finished card'],
    ]
    for (const [foreground, background, what] of textPairs) {
      const ratio = contrastRatio(tokens.get(foreground) ?? '', tokens.get(background) ?? '')
      // WCAG 2.1 AA for normal text is 4.5:1. Asserted as a value rather than left to
      // an eye, because a card is the one place this product puts words on a
      // developer's screen and nobody is looking at a contrast ratio (APX-CON-07).
      expect(Number.isFinite(ratio), `${foreground} on ${background}`).toBe(true)
      expect(ratio, `${what}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
    }

    // A border is not text, so 3:1 is the threshold - and a border a person cannot see
    // is a card edge that does not exist.
    const borderPairs: readonly (readonly [string, string, string])[] = [
      ['--card-border', '--card-fill', 'the card edge'],
      ['--card-block-border', '--card-block-fill', 'a needs-you card edge'],
      ['--card-finished-border', '--card-finished-fill', 'a finished card edge'],
    ]
    for (const [border, fill, what] of borderPairs) {
      const ratio = contrastRatio(tokens.get(border) ?? '', tokens.get(fill) ?? '')
      expect(ratio, `${what}: ${border} on ${fill} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3)
    }
  })
})
