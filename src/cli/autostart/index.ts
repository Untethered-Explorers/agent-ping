// The per-platform autostart units, and the engine that writes and removes them
// (IO-FR-06, IO-FR-07, APX-CON-06).
//
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
// `src/cli/autostart-control.ts` is the port: state, enable, disable, and nothing
// else. This is the implementation behind it - a systemd user unit on Linux, a
// launchd agent on macOS, a Startup-folder entry on Windows - plus the three
// guarantees that have to hold identically on all three, written once here rather
// than three times:
//
//   IDEMPOTENCE.   `enable` writes only when the bytes differ and reports
//                  `changed: false` when they do not. `disable` removes only what
//                  it finds and is a no-op the second time. Neither fails on a
//                  repeat, and neither leaves a second unit behind.
//   OWNER-ONLY.    Every file is created 0o600 and every directory this creates is
//                  0o700, with an explicit chmod after the write so a wider umask
//                  cannot widen the result (IO-FR-07).
//   A FOREIGN FILE IS NOT OURS. Every unit carries AUTOSTART_UNIT_SENTINEL on its
//                  first line. A file at our path without that sentinel was
//                  written by somebody else, so `enable` refuses to overwrite it
//                  and `disable` refuses to remove it. Enabling over it is a
//                  reported failure with a remedy; disabling past it reports that
//                  nothing of ours was removed and names the file that was left
//                  alone. Neither is a data-loss bug (APX-CON-03).
//
// WHY THE UNITS ARE WRITTEN AS FILES AND NOT AS `systemctl enable` CALLS
// Enabling a systemd *user* unit is a filesystem operation: the unit file plus a
// symlink in `default.target.wants/`. Running `systemctl --user enable` would do
// the same two things through a process that talks to the live session manager -
// which this task is explicitly not allowed to touch, which a test could not run
// without manipulating the developer's own session, and which would make `install`
// fail on a machine with no running user manager (a container, a WSL session, a
// build agent) even though the unit is perfectly writable. Writing the two
// artefacts ourselves has the properties that matter: no root, idempotent by
// construction, `systemctl --user is-enabled agent-ping` still reports the truth
// afterwards, and a developer who prefers the service manager can still run it -
// which is why the operations runbook records the manual `systemctl --user start`
// for starting it in the *current* session. The next login is what an autostart
// unit is for, and that is entirely a filesystem question (docs/IDEA.md,
// Availability Contract).
//
// WHY ONE ENGINE AND THREE DESCRIPTORS RATHER THAN THREE IMPLEMENTATIONS
// A systemd unit, a launchd plist and a Windows batch file disagree about syntax
// and agree about everything that can go wrong: permissions, repeat runs, a
// stranger's file at the path, a directory left behind. Three independent copies
// of those rules is three chances to get one of them subtly wrong on a platform
// nobody here can test. So each platform module answers "where does this go, what
// are its bytes, and what other paths does it own", and this file owns what to do
// with the answer. `tests/cli/autostart.test.ts` drives all three through the same
// assertions, so the engine's guarantees are proven once and proven again on each
// platform.
//
// THE EXECUTABLE IS THIS INSTALL'S OWN, NEVER A `PATH` LOOKUP
// A unit that said `ExecStart=electron` would start whichever Electron came first
// on the login `PATH` - a different build, or nothing at all. So a unit names the
// Electron runtime this package installed and the package root whose `main` is the
// packaged hub entry, both resolved from the installed package itself
// (`resolveElectronPath` and `findPackageRoot` in ../hub-client.ts, the product's
// one resolution point for both) and both written as absolute paths. The packaged
// `agent-ping` command path is in the unit's header too, so a developer reading
// the file can tell which install wrote it without consulting anything else.
//
// THE CHROMIUM LAUNCH POLICY TRAVELS WITH THE UNIT
// The packaged application aborts at startup on a per-user install without
// `--no-sandbox` (PRD 16 Open Question 13, CHROMIUM_LAUNCH_POLICY), and Chromium
// decides that before any JavaScript in this package runs - so whatever *launches*
// the process has to carry it. Both forms are carried, the switch and the
// environment variable, and both are read from the product's own table rather than
// restated here, so a change to the policy cannot leave these units behind it.
// The prepack guard prints the same rule on every run.
//
// NO ROOT, EVER
// Every path a unit is written to is under the user's own home, resolved from the
// platform's per-user convention. A unit that needed elevation would be the wrong
// design rather than a missing feature, so there is no `sudo`, no `User=`, no
// launchd `UserName`, and no `runas` anywhere in what is generated - asserted per
// platform in tests/cli/autostart.test.ts.
//
// NOTHING HERE LEAVES THE MACHINE (APX-CON-12)
// These modules read the installed package's own manifest, read and write a
// handful of files under the user's own home, and make no network call, spawn no
// process, and write nothing outside the platform's own per-user unit directory.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { CHROMIUM_LAUNCH_ENVIRONMENT, CHROMIUM_LAUNCH_FLAGS } from '../../notify/surface/electron-host.js'
import { findPackageRoot, resolveElectronPath } from '../hub-client.js'
import { STATE_DIR_ENV_VAR } from '../../storage/paths.js'
import type { AutostartChange, AutostartControl, AutostartState } from '../autostart-control.js'
import { resolveLinuxUnit } from './linux.js'
import { resolveMacosUnit } from './macos.js'
import { resolveWindowsUnit } from './windows.js'

/**
 * The one line that proves a unit is this product's, in all three formats.
 *
 * A comment in the systemd unit, an XML comment in the plist and a `rem` in the
 * batch file, all carrying the same string, so "did agent-ping write this file" is
 * one comparison rather than three syntax-specific ones. The units an older
 * agent-ping wrote carry the same v1 sentinel and are recognised as ours and
 * rewritten, which is the correct outcome for a file this product wrote.
 */
export const AUTOSTART_UNIT_SENTINEL = 'agent-ping:autostart-unit v1'

/** The mode of a unit file. Nothing but its owner may read what a unit starts. */
export const AUTOSTART_UNIT_FILE_MODE = 0o600

/** The mode of a directory this product creates. (IO-FR-07) */
export const AUTOSTART_UNIT_DIR_MODE = 0o700

/** What a platform's unit needs to know about the machine, resolved once. */
export interface AutostartUnitContext {
  readonly env: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly stateDir: string
  /** The packaged Electron binary. Defaults to what this package's own `electron` resolves to. */
  readonly electronPath?: string | null
  /** The installed package's root. Defaults to the root this module was loaded from. */
  readonly packageRoot?: string
}

/** This installation's packaged facts, read out of its own manifest. */
export interface PackagedInstall {
  /** The installed package's root directory. */
  readonly root: string
  /** The packaged `agent-ping` command, from the manifest's own `bin` block. */
  readonly binPath: string | null
  /** The product version, for the unit's header. Never guessed. */
  readonly version: string | null
  /** The Electron runtime this package installed, or null when it will not resolve. */
  readonly electronPath: string | null
}

/** What a platform resolver is given: the machine's context, plus the packaged facts. */
export interface PlatformUnitContext extends AutostartUnitContext {
  readonly install: PackagedInstall
}

/**
 * One extra path a platform's enablement owns: the symlink systemd reads to decide
 * a user unit starts at login.
 *
 * `target` is the absolute path the link must resolve to; the link is *written*
 * relative, the way `systemctl enable` writes it, so a copied or restored unit
 * directory does not carry an absolute link to a path that has moved. macOS and
 * Windows have no such concept - launchd loads `~/Library/LaunchAgents` at login
 * and Explorer runs the Startup folder - which is why this list is empty for two
 * of the three platforms.
 */
export interface AutostartLink {
  readonly path: string
  readonly target: string
}

/** Everything one platform's convention says about where its unit goes. */
export interface AutostartUnit {
  readonly platform: NodeJS.Platform
  /** A short noun for this kind of unit, for a sentence: "systemd user unit". */
  readonly kind: string
  /** The unit file, at the platform's own convention path. */
  readonly unitPath: string
  /** The exact bytes enable writes. Byte-compared, so idempotence is exact. */
  readonly content: string
  /** Paths beyond the unit file that enable creates and disable removes. */
  readonly links: readonly AutostartLink[]
  /**
   * The directories above the unit that this unit's presence requires, outermost first.
   *
   * Declared per platform rather than derived by walking up from `unitPath`, because
   * "how far up is ours" is a fact about the platform's convention and only the
   * platform knows where the convention's own root is. Linux needs
   * `~/.config/systemd` as well as `~/.config/systemd/user`, because both are
   * created to hold the unit and both are ours to remove; macOS and Windows hold the
   * unit in the convention directory itself, so their list has one entry. Walking up
   * to the home instead would have had to *guess* a bound, and the obvious guess
   * (`~/.config`) is a directory this product has no business deleting.
   */
  readonly ownedDirectories: readonly string[]
}

/**
 * The path rules of the platform whose unit is being handled.
 *
 * Not a convenience. A Windows unit's path is assembled with backslashes, and
 * `path.dirname` on a POSIX build splits such a string at the last forward slash
 * instead - so a `.cmd` at `C:\\Users\\me\\Startup\\agent-ping.cmd` would have its
 * "directory" resolved to `C:\\Users\\me` on a machine that is not Windows, and the
 * owner-only directory this engine creates would be created in the wrong place.
 * Every path operation in this file therefore goes through the platform's own
 * rules, which is also what makes the macOS and Windows units reviewable from a
 * Linux machine.
 */
type PathApi = Pick<typeof path, 'join' | 'dirname' | 'relative' | 'resolve'>

export function pathApiFor(platform: NodeJS.Platform): PathApi {
  return platform === 'win32' ? path.win32 : path.posix
}

/** The platform resolvers, keyed by the platform each one is for. */
const RESOLVERS: Readonly<Record<string, (context: PlatformUnitContext) => AutostartUnit>> = {
  linux: resolveLinuxUnit,
  darwin: resolveMacosUnit,
  win32: resolveWindowsUnit,
}

/** The platforms with a unit in v1 (APX-CON-06). Anything else is a stated refusal. */
export const AUTOSTART_SUPPORTED_PLATFORMS: readonly string[] = Object.keys(RESOLVERS).sort()

/**
 * This install's packaged facts, read out of its own manifest.
 *
 * Two fields are optional and both are used only for the unit's header, so a
 * manifest that cannot be read is a header with a line missing rather than a
 * failed install. It is the same manifest `findPackageRoot` already located, read
 * once per control rather than once per unit.
 */
function readPackagedInstall(context: AutostartUnitContext): PackagedInstall {
  const join = pathApiFor(context.platform).join
  const root = context.packageRoot ?? findPackageRoot()
  const electronPath = context.electronPath !== undefined ? context.electronPath : resolveElectronPath()
  let binPath: string | null = null
  let version: string | null = null
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const manifest = parsed as { bin?: unknown; version?: unknown }
      const target = typeof manifest.bin === 'string' ? manifest.bin : readNamedBin(manifest.bin, 'agent-ping')
      if (typeof target === 'string' && target !== '') binPath = join(root, target)
      if (typeof manifest.version === 'string' && manifest.version.trim() !== '') {
        version = manifest.version.trim()
      }
    }
  } catch {
    // A packaged install whose manifest cannot be read still gets a unit with real
    // paths in it; only the header loses a line. Failing the whole enable over a
    // header would be a worse tool than one that says what it could not read.
  }
  return { root, binPath, version, electronPath }
}

function readNamedBin(bin: unknown, name: string): string | null {
  if (typeof bin !== 'object' || bin === null) return null
  const target = (bin as Record<string, unknown>)[name]
  return typeof target === 'string' ? target : null
}

/**
 * Resolve this platform's unit, or say that there is none.
 *
 * A platform outside the three in v1 is a stated refusal rather than a throw: the
 * caller is `install` and `doctor`, and a command that crashed instead of printing
 * a remedy would be a worse command. The one thing that can still fail here is a
 * resolver that throws, which is a bug in this product rather than a fact about
 * the machine, so it is reported with its reason instead of being swallowed.
 */
export function resolveAutostartUnit(
  options: AutostartUnitContext,
): { readonly unit: AutostartUnit } | { readonly reason: string } {
  const build = RESOLVERS[options.platform]
  if (build === undefined) {
    return {
      reason:
        `agent-ping has no autostart unit for ${options.platform}; v1 supports linux, macos ` +
        'and windows (APX-CON-06)',
    }
  }
  try {
    return { unit: build({ ...options, install: readPackagedInstall(options) }) }
  } catch (cause) {
    return { reason: `the ${options.platform} autostart unit could not be prepared (${nameOf(cause)})` }
  }
}

/**
 * The control `install` and `doctor` use, over the real units.
 *
 * Synchronous construction, asynchronous methods, matching the port: the platform
 * modules are pure path-and-string work and there is nothing to await before the
 * control exists. The four fields the resolver passes are all it needs; the
 * context's optional overrides exist for a test and default to the real install.
 */
export function createAutostartControl(options: {
  readonly env: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly stateDir: string
  readonly electronPath?: string | null
  readonly packageRoot?: string
}): AutostartControl {
  const context: AutostartUnitContext = {
    env: options.env,
    platform: options.platform,
    home: options.home,
    stateDir: options.stateDir,
    ...(options.electronPath === undefined ? {} : { electronPath: options.electronPath }),
    ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
  }
  const resolved = resolveAutostartUnit(context)

  if ('reason' in resolved) {
    // `missing-implementation` would be a lie here: this module *is* the
    // implementation, so the only honest answer is that this platform has no unit.
    return unavailable(options.platform, () => resolved.reason)
  }
  const unit = resolved.unit

  return {
    implementation: 'autostart-units',
    platform: options.platform,
    state: (): Promise<AutostartState> => Promise.resolve(readState(unit)),
    enable: (): Promise<AutostartChange> => Promise.resolve(enableUnit(unit)),
    disable: (): Promise<AutostartChange> => Promise.resolve(disableUnit(unit)),
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The file's bytes, or null when there is no readable file there. */
function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Did this product write that file? One comparison, in all three formats. */
function isAgentPingUnit(content: string | null): boolean {
  return content !== null && content.includes(AUTOSTART_UNIT_SENTINEL)
}

/** Does this symlink already resolve to the unit it is supposed to point at? */
function linkIsCorrect(platform: NodeJS.Platform, link: AutostartLink): boolean {
  const paths = pathApiFor(platform)
  let target: string
  try {
    target = readlinkSync(link.path)
  } catch {
    return false
  }
  return paths.resolve(paths.dirname(link.path), target) === paths.resolve(link.target)
}

/**
 * The state of the unit, as the three answers there are.
 *
 * A unit file alone is not the whole of "enabled" on Linux: without the
 * `default.target.wants` symlink the file sits there and a login never starts it.
 * So a half-written enablement reads as `disabled` with a detail naming what is
 * missing, which is what makes a failed enable visible in `doctor` rather than a
 * green check over a unit that would not have run.
 */
function readState(unit: AutostartUnit): AutostartState {
  const present = readIfPresent(unit.unitPath)
  if (present === null) {
    return {
      availability: 'disabled',
      unitPath: unit.unitPath,
      detail: `there is no ${unit.kind} at ${unit.unitPath}, so agent-ping will not start at login`,
    }
  }
  if (!isAgentPingUnit(present)) {
    return {
      availability: 'disabled',
      unitPath: unit.unitPath,
      detail:
        `${unit.unitPath} is not a file agent-ping wrote, so it was left alone and agent-ping ` +
        'will not start at login from it',
    }
  }
  const missing = unit.links.filter((link) => !linkIsCorrect(unit.platform, link))
  if (missing.length > 0) {
    return {
      availability: 'disabled',
      unitPath: unit.unitPath,
      detail:
        `${unit.unitPath} is present but ${missing.map((link) => link.path).join(' and ')} ` +
        'is not, so a login would not start agent-ping from it',
    }
  }
  return {
    availability: 'enabled',
    unitPath: unit.unitPath,
    detail: `the ${unit.kind} at ${unit.unitPath} starts agent-ping for this user at login`,
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Create the directory, owner-only, and report the reason when it cannot.
 *
 * Only a directory this call *creates* is chmod-ed. A `systemd/user` or a
 * `LaunchAgents` directory that already exists belongs to the platform and to
 * whatever else the user has put there, and its mode is not ours to change; the
 * unit file's own 0o600 is what keeps the contents private.
 */
function ensureDirectory(directory: string): string | null {
  const created = !existsSync(directory)
  try {
    mkdirSync(directory, { recursive: true, mode: AUTOSTART_UNIT_DIR_MODE })
    if (created) chmodSync(directory, AUTOSTART_UNIT_DIR_MODE)
    return null
  } catch (cause) {
    return `${directory} could not be created (${codeOf(cause)})`
  }
}

/**
 * Write the unit, then hold it at 0o600 whatever the umask did.
 *
 * The chmod is not redundant. `writeFileSync`'s `mode` is filtered through the
 * process umask, so a `umask 000` install would otherwise leave a world-readable
 * file that names a user's home directory and starts a process (IO-FR-07).
 */
function writeUnitFile(file: string, content: string): string | null {
  try {
    writeFileSync(file, content, { encoding: 'utf8', mode: AUTOSTART_UNIT_FILE_MODE })
    chmodSync(file, AUTOSTART_UNIT_FILE_MODE)
    return null
  } catch (cause) {
    return `${file} could not be written (${codeOf(cause)})`
  }
}

/** Remove a path, ignoring the case where it is already gone. */
function removePath(target: string): void {
  try {
    unlinkSync(target)
  } catch {
    // Already gone. A disable that races another disable is a no-op, not a fault.
  }
}

/**
 * Take a directory away when - and only when - this product emptied it.
 *
 * `rmdirSync` is the whole safety argument: it fails on a non-empty directory, so
 * a `systemd/user` holding somebody else's unit, or a Startup folder holding
 * another program's shortcut, cannot be removed by a mistake here. The point is
 * that a disabled install leaves nothing of its own behind, including the
 * directories it had to create in order to hold the unit.
 */
function removeDirectoryIfEmpty(directory: string): void {
  try {
    rmdirSync(directory)
  } catch {
    // Not empty, not a directory, or not ours to remove. All three are fine.
  }
}

/**
 * Would enable destroy something this product did not write?
 *
 * Checked for every owned path *before* anything is written, so a blocked enable
 * has not already replaced the unit file by the time it gives up. This is the
 * check that makes "agent-ping never overwrites a stranger's file" a property of
 * the code rather than a promise in a comment.
 */
function findForeignFile(unit: AutostartUnit): string | null {
  const present = readIfPresent(unit.unitPath)
  if (present !== null && !isAgentPingUnit(present)) return unit.unitPath
  for (const link of unit.links) {
    if (existsSync(link.path) && !linkIsCorrect(unit.platform, link)) return link.path
  }
  return null
}

function enableUnit(unit: AutostartUnit): AutostartChange {
  const foreignPath = findForeignFile(unit)
  if (foreignPath !== null) {
    return {
      changed: false,
      unitPath: unit.unitPath,
      detail:
        `${foreignPath} is already there and agent-ping did not write it, so it was not ` +
        `replaced and no ${unit.kind} was installed`,
      failure:
        `move ${foreignPath} aside, then run \`agent-ping install\` again; it belongs to ` +
        'something else and agent-ping will not overwrite it (APX-CON-03)',
    }
  }

  const directoryFailure = ensureDirectory(pathApiFor(unit.platform).dirname(unit.unitPath))
  if (directoryFailure !== null) {
    return {
      changed: false,
      unitPath: unit.unitPath,
      detail: `the ${unit.kind} was not installed: ${directoryFailure}`,
      failure:
        'run `agent-ping doctor`; it reports the state directory and whether this machine can be ' +
        `written to, and ${unit.unitPath} is not under it`,
    }
  }

  let changed = false
  if (readIfPresent(unit.unitPath) !== unit.content) {
    const failure = writeUnitFile(unit.unitPath, unit.content)
    if (failure !== null) {
      return {
        changed: false,
        unitPath: unit.unitPath,
        detail: `the ${unit.kind} was not installed: ${failure}`,
        failure:
          'fix the permissions on the directory above it and run `agent-ping install` again; the ' +
          'unit is a plain file and needs nothing else',
      }
    }
    changed = true
  }

  for (const link of unit.links) {
    if (linkIsCorrect(unit.platform, link)) continue
    const linkDirectoryFailure = ensureDirectory(pathApiFor(unit.platform).dirname(link.path))
    if (linkDirectoryFailure !== null) {
      return {
        changed,
        unitPath: unit.unitPath,
        detail: `the ${unit.kind} was written but the login entry was not: ${linkDirectoryFailure}`,
        failure:
          'fix the permissions on the directory above the login entry and run `agent-ping install` ' +
          'again; without it the unit exists and a login would not start agent-ping',
      }
    }
    if (makeLink(unit.platform, link)) changed = true
  }

  return {
    changed,
    unitPath: unit.unitPath,
    detail: changed
      ? `wrote the ${unit.kind} at ${unit.unitPath}, so this user's next login starts agent-ping`
      : `the ${unit.kind} at ${unit.unitPath} is already exactly what this install would write; nothing was changed`,
    failure: null,
  }
}

/**
 * Create the login link, replacing a wrong one rather than failing on it.
 *
 * The two-step replace exists because `symlinkSync` refuses an existing path, and
 * a link that points at the wrong unit is exactly the thing that has to be
 * repaired. The path was already checked for a foreign file, so the file being
 * replaced here is one this product wrote.
 */
function makeLink(platform: NodeJS.Platform, link: AutostartLink): boolean {
  const paths = pathApiFor(platform)
  const target = paths.relative(paths.dirname(link.path), link.target)
  try {
    symlinkSync(target, link.path)
    return true
  } catch (cause) {
    if (codeOf(cause) !== 'EEXIST') return false
  }
  removePath(link.path)
  try {
    symlinkSync(target, link.path)
    return true
  } catch {
    return false
  }
}

function disableUnit(unit: AutostartUnit): AutostartChange {
  const present = readIfPresent(unit.unitPath)
  const ours = isAgentPingUnit(present)

  if (present !== null && !ours) {
    return {
      changed: false,
      unitPath: unit.unitPath,
      detail:
        `${unit.unitPath} is not a file agent-ping wrote, so it was left in place and nothing of ` +
        'this product was removed',
      // Not a failure: there is nothing of ours to remove here, and refusing to
      // remove somebody else's unit is the correct outcome rather than a fault.
      failure: null,
    }
  }

  const removed: string[] = []
  for (const link of unit.links) {
    if (existsSync(link.path)) {
      removePath(link.path)
      removed.push(link.path)
    }
  }
  if (ours) {
    removePath(unit.unitPath)
    removed.push(unit.unitPath)
  }

  for (const directory of directoriesToPrune(unit)) {
    removeDirectoryIfEmpty(directory)
  }

  if (removed.length === 0) {
    return {
      changed: false,
      unitPath: unit.unitPath,
      detail: `there was no ${unit.kind} at ${unit.unitPath}; nothing was removed`,
      failure: null,
    }
  }
  return {
    changed: true,
    unitPath: unit.unitPath,
    detail: `removed ${removed.join(' and ')}, so no login of this user will start agent-ping`,
    failure: null,
  }
}

/**
 * The directories a disable may empty, innermost first, deduplicated.
 *
 * The platform's own `ownedDirectories`, plus the directory each login link lives
 * in, which is implied by the link and so is not listed there. A directory is only
 * ever *attempted* - `rmdirSync` refuses a non-empty one - so the order matters only
 * for tidiness, and a platform that declares a directory it did not create simply
 * fails the attempt and keeps it.
 */
function directoriesToPrune(unit: AutostartUnit): readonly string[] {
  const dirname = pathApiFor(unit.platform).dirname
  const candidates = [
    ...unit.links.map((link) => dirname(link.path)),
    dirname(unit.unitPath),
    ...unit.ownedDirectories,
  ]
  return [...new Set(candidates)].sort((left, right) => right.length - left.length)
}

// ---------------------------------------------------------------------------
// The refusal
// ---------------------------------------------------------------------------

/**
 * A control that reports the truth and changes nothing.
 *
 * `changed: false` on both operations is the load-bearing value: `install` prints
 * what it changed, and a control that claimed to have enabled a unit it never
 * wrote would put a lie in that list.
 */
function unavailable(platform: NodeJS.Platform, reason: () => string): AutostartControl {
  return {
    implementation: 'unsupported-platform',
    platform,
    state: (): Promise<AutostartState> =>
      Promise.resolve({ availability: 'unavailable', unitPath: null, detail: reason() }),
    enable: (): Promise<AutostartChange> =>
      Promise.resolve({ changed: false, unitPath: null, detail: reason(), failure: reason() }),
    disable: (): Promise<AutostartChange> =>
      Promise.resolve({ changed: false, unitPath: null, detail: reason(), failure: null }),
  }
}

// ---------------------------------------------------------------------------
// What the platform modules are given, in one place
// ---------------------------------------------------------------------------

/**
 * The state directory a unit must start the hub in, and whether it has to say so.
 *
 * When the operator overrode the state directory, a login-started hub that
 * resolved the *default* would put its runtime file and its database somewhere the
 * plugin and `doctor` never look, and the product would behave like two installs of
 * itself. So the override travels in the unit - and only the override: with no
 * override the platform default is the right answer, and baking an absolute path
 * into the unit would be a second thing to keep correct.
 *
 * The value written is the state directory the *command already resolved*, not a
 * second resolution of the same question. The command resolved it through
 * `resolveStateDir` in src/storage/paths.ts and handed it down; re-deriving it here
 * would be the second resolution point this repository exists to avoid, and a
 * disagreement between the two would be a hub on one directory and commands on
 * another.
 */
export function stateDirEnvironment(
  env: NodeJS.ProcessEnv,
  stateDir: string,
): Readonly<Record<string, string>> {
  const override = env[STATE_DIR_ENV_VAR]
  if (override === undefined || override.trim() === '') return {}
  return { [STATE_DIR_ENV_VAR]: stateDir }
}

/** The environment a unit sets for the process it starts, from the product's own table. */
export function launchEnvironment(): Readonly<Record<string, string>> {
  return { ...CHROMIUM_LAUNCH_ENVIRONMENT }
}

/**
 * The switches a unit's command line must carry, from the product's own table.
 *
 * `CHROMIUM_LAUNCH_FLAGS` holds bare switch names because Electron's
 * `appendSwitch` adds the `--` itself; a unit composes a command *line*, where
 * Chromium reads the dashes, so the prefix is added here rather than restated in
 * three platform modules. One place decides the spelling, and a change to the
 * policy table reaches all three units.
 */
export function launchArguments(): readonly string[] {
  return CHROMIUM_LAUNCH_FLAGS.map((flag) => `--${flag}`)
}

function codeOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    return String((cause as { code?: unknown }).code ?? 'unknown')
  }
  return 'unknown'
}

function nameOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'name' in cause) {
    return String((cause as { name?: unknown }).name)
  }
  return 'unknown'
}
