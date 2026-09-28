// The shared tool resolver's contract for the TypeScript side of the repository.
//
// scripts/lib/node-tool.mjs is plain JavaScript with no build step, so nothing about it
// is inferred for a .ts file that imports it. Three files here do: the resolver's own
// suite (tests/scripts/node-tool.test.ts), the packaging suite that spawns npm
// (tests/packaging/package.test.ts) and the runner-convention suite that spawns nested
// npm test runs (tests/tooling/runner-convention.test.ts).
//
// A declaration rather than a `@ts-expect-error` on each import, deliberately. The
// other scripts in this repository are suppressed that way, and suppression is the
// right answer for a module whose whole export surface is internal. This one is
// different: it is the contract between three build and test entry points and the
// platform, and an import that cannot see that contract is how `node_modules/.bin`
// came back in the first place. `tsc` must be able to say that `args` is a string
// array, because a caller that put a command *string* there would reintroduce the shell
// this module exists to avoid - and only a declared type can catch that.
//
// What is deliberately not here: anything internal. How a tool's entry file is located
// is the module's own business; a caller reaches for the resolved invocation and nothing
// else.

/** How a tool is run, on whichever platform this is. */
export interface NodeToolInvocation {
  /**
   * The executable to spawn. `process.execPath` for anything in `node_modules`.
   *
   * A caller passes this as `spawnSync`'s first argument and never concatenates it
   * with anything: a string with a space in it here is a quoting bug waiting to
   * happen.
   */
  readonly command: string
  /**
   * The arguments that follow the executable, starting with the tool's own entry file.
   *
   * A caller appends its arguments and spreads the result, so a tool's real arguments
   * stay separate words even when they contain spaces.
   */
  readonly args: readonly string[]
  /**
   * False when the tool is not installed.
   *
   * So a caller can print "run `npm install`" instead of dying on an ENOENT several
   * frames into a build. Empty `command` when false.
   */
  readonly exists: boolean
}

/** The repository root, with a trailing separator, as the sibling scripts compute it. */
export const repoRoot: string

/**
 * Resolve an installed tool to an executable plus an argument array.
 *
 * `packageName` is the npm package and `toolName` the command inside it; they differ
 * for `tsc`, which lives in `typescript`. Reads the package's own `bin` field rather
 * than the `node_modules/.bin` directory, because that directory holds a generated
 * `.cmd` shim on Windows which Node will not spawn without a shell.
 */
export function nodeTool(packageName: string, toolName: string): NodeToolInvocation

/**
 * Resolve npm itself to an executable plus an argument array.
 *
 * Under an npm script - which is how every caller runs - this is the running npm's own
 * JavaScript entry, so the answer has the same shape as {@link nodeTool}. Outside one
 * there is no such file to name and the answer is a bare command name, which differs
 * by platform and cannot be made to look alike.
 */
export function npmTool(): NodeToolInvocation
