// Resolve the `.js` specifiers the tsc build requires onto the `.ts` sources they
// name, so an unbuilt checkout can be imported by a real Node process.
//
//   src/storage/db.ts  imports  './paths.js'
//   src/storage/paths.ts does not exist as .js in the source tree, and Node's type
//   stripping does not rewrite the specifier: it removes types, it does not
//   resolve. This hook does the one rewrite that is safe here, and only for a
//   relative `.js` specifier whose importer is itself a `.ts` file, so nothing else
//   in the process - a real dependency, a JSON import, a node: builtin - is
//   touched.
//
// It exists so the second-instance and footprint fixtures can start the real
// `src/main/index.ts` in a separate OS process without a build step, which is the
// only way to prove the single-instance guarantee across processes and to measure
// a hub's resident set without the test runner inside the number.

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ?? ''
  if (specifier.startsWith('.') && specifier.endsWith('.js') && parent.startsWith('file:') && parent.endsWith('.ts')) {
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, parent)
    if (existsSync(fileURLToPath(candidate))) {
      // No `format` here: claiming a format would tell Node this is already
      // JavaScript, which switches off the type stripping the whole point of the
      // hook is to reach.
      return { url: candidate.href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
