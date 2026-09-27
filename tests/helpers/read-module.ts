// One product source file, read for what a *source-level* assertion needs: the calls it
// makes, the modules it names, or both.
//
// WHY THIS IS A HAND-WRITTEN SCANNER AND NOT A LINE OF REGEXES
// A line of regexes cannot do this safely on TypeScript source. `http://127.0.0.1` inside
// a string looks like a line comment; an apostrophe inside a comment looks like a string
// delimiter; and either one unbalances the rest of the file, which turns a source-level
// assertion into a source-level assertion about nothing at all. So this walks the
// characters once and tracks which of the four states it is in - line comment, block
// comment, single/double/backtick string, or a regex literal - and replaces the contents
// of a comment with spaces. Newlines are preserved, so a failure's line numbers still
// point at the line the author is looking at.
//
// WHY IT LIVES HERE, AND WHY TWO SUITES STILL CARRY THEIR OWN COPY
// tests/notify/surface-host.test.ts and tests/dashboard/card-document.test.ts each grew
// one, and consolidating them is a change to suites that are not this task's business.
// This is the third copy written down as a module so that the *next* suite does not write
// a fourth, and so the two older copies are a consolidation somebody can do with one
// file's diff rather than three (the two implementations are deliberately identical, so
// that diff is a deletion and an import).
//
// WHAT THE TWO MODES ARE FOR
// `keepStrings: false` is for "what does this code call" - a forbidden identifier, a
// forbidden call. A comment that names a forbidden tool can then neither satisfy nor
// break such a check, and a URL that a module builds cannot hide inside a string.
// `keepStrings: true` is for the one check that genuinely needs the values - which
// module or which name this one uses.
//
// THE LIMITS, STATED RATHER THAN HIDDEN
// A backtick template is read as one string to its closing backtick, so a nested
// template inside a `${...}` would end the scan early. No module these checks are pointed
// at contains one, and a missed token would in most cases still be caught by the same
// token appearing in the value that code then uses.

import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The repository root, from this file's own location: `<root>/tests/helpers/`. */
export function repositoryPath(relative: string): string {
  return fileURLToPath(new URL(`../../${relative}`, import.meta.url))
}

/** One product source file, comments removed and - optionally - strings removed. */
export function readModule(relative: string, options: { readonly keepStrings?: boolean } = {}): string {
  const keepStrings = options.keepStrings ?? false
  const source = readFileSync(repositoryPath(relative), 'utf8')
  let out = ''
  let index = 0
  let previous = ''
  const blank = (length: number): void => {
    for (let offset = 0; offset < length; offset += 1) out += source[index + offset] === '\n' ? '\n' : ' '
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
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
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
        if (inner === character || inner === '\n') break
        cursor += 1
      }
      const stop = Math.min(cursor + 1, source.length)
      // A template literal can span lines and can hold an expression; both are replaced
      // wholesale rather than scanned, so `${...}` inside one is treated as text.
      if (keepStrings) out += source.slice(index, stop)
      else blank(stop - index)
      index = stop
      previous = 'x'
      continue
    }
    if (character === '/' && !/[A-Za-z0-9_$)\]]/.test(previous)) {
      // A regex literal rather than a division, by the standard heuristic. None of the
      // modules this helper is pointed at currently has one; the branch is here so a
      // later one cannot silently corrupt every check that reads the file.
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
    out += character
    if (!/\s/.test(character)) previous = character
    index += 1
  }
  return out
}

/** Comments and string literals gone: about the calls a module makes. */
export function readModuleWithoutProse(relative: string): string {
  return readModule(relative)
}

/** Comments gone, string literals kept: about the modules and names a file uses. */
export function readModuleImports(relative: string): string {
  return readModule(relative, { keepStrings: true })
}

/** Every TypeScript source under `src/`, repository-relative, in a stable order. */
export function sourceFilesUnderSrc(): string[] {
  const found: string[] = []
  const walk = (relative: string): void => {
    for (const entry of readdirSync(repositoryPath(relative))) {
      const child = `${relative}/${entry}`
      if (statSync(repositoryPath(child)).isDirectory()) {
        walk(child)
        continue
      }
      if (/\.(?:ts|tsx|mts|cts)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(child)
    }
  }
  walk('src')
  return found.sort()
}
