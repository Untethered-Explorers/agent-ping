// The per-platform autostart units, driven against a temporary home
// (IO-FR-06, IO-FR-07, APX-CON-06, APX-CON-12, IO-3).
//
//   npm test -- tests/cli/autostart.test.ts
//
// THE FOUR ACCEPTANCE CRITERIA, AND WHERE EACH IS PROVEN
//
//   1. "A test asserts enabling twice produces one unit and disabling twice is a
//       safe no-op for each platform implementation"
//      `enabling twice leaves one unit and changes nothing, and disabling twice is
//      a safe no-op, on every platform`. Driven over linux, darwin and win32
//      through `createAutostartControl`: the second enable reports `changed:
//      false`, the unit's bytes and mtime are unmoved, and the directory holds
//      exactly one file that is ours; the second disable reports `changed: false`
//      with no failure. The mtime is the load-bearing half - a control that
//      rewrote identical bytes would still be "idempotent" by its own report.
//
//   2. "A test asserts disabling removes the unit and leaves no agent-ping entry
//       behind"
//      `disabling leaves no agent-ping entry anywhere under the temporary home`.
//      Not "the file we expected is gone": the whole temporary home is walked
//      after the disable, so a symlink left in `default.target.wants`, or a
//      directory this product created and did not remove, fails the test.
//
//   3. "A test asserts each generated unit names the packaged binary, runs as the
//       current user and requests no elevated privilege"
//      `every generated unit names this install's packaged binary and asks for no
//       elevation`, over all three. Positive half: the packaged `agent-ping`
//       command, the packaged Electron runtime and the package root, all as
//       absolute paths, plus the Chromium launch policy in both its forms.
//      Negative half: no `sudo`, `pkexec`, `doas`, `User=`, `UserName`, `runas`,
//       `-Verb RunAs` or `HKLM` in any of them, and the unit lives inside the
//       installing user's own profile rather than a system directory.
//
//   4. "A test asserts a pre-existing unrelated unit in the same location is left
//       untouched"
//      Three faults, because they are different code. `a foreign unit in the same
//      directory is left alone`, `a foreign file at our own path is neither
//      overwritten nor removed`, and `a directory this product emptied is removed
//      but a directory still holding a stranger's unit is not`. The second is the
//      data-loss case: enabling over it has to be a reported failure with a
//      remedy, and disabling has to leave it exactly as it was, bytes and mtime.
//
// AROUND THOSE, the properties that make them worth anything:
//
//   - The unit lives where the *platform's* convention says, resolved from
//     `XDG_CONFIG_HOME`, `%APPDATA%` and the home - never from a literal.
//   - Everything written is owner-only (IO-FR-07): the unit at 0o600 and any
//     directory this product created at 0o700, asserted with `stat`.
//   - A unit of an older agent-ping - one that carries the sentinel with stale
//     bytes - is recognised as ours and rewritten, because it *is* ours. That is
//     the other side of the foreign-file rule and it is easy to get backwards.
//   - An overridden state directory travels in the unit and the platform default
//     does not: a login-started hub that resolved the default would put its
//     runtime file somewhere the plugin never looks.
//   - Paths are escaped for the format that has to read them: systemd quotes and
//     doubles `%`, `cmd.exe` doubles `%`, and a plist escapes the three XML
//     metacharacters a Unix path may legally contain.
//   - No live service manager is touched. Asserted from the *source* of the four
//     modules, because "the tests did not run `systemctl`" is a claim about the
//     test and not about the code, and a `systemctl` in a unit module would be
//     invisible to every behavioural assertion in this file.
//
// WHY EVERY CASE RUNS INSIDE A TEMPORARY WORKING DIRECTORY
// The Windows unit's path is assembled with `path.win32`, because on Windows
// `path` *is* `path.win32` and a path is written once, in the rules of the
// platform that has to read it. On a POSIX machine that produces a drive-rooted
// string - `C:\Users\...` - which this kernel resolves against the working
// directory. So each case builds its machine under a temporary directory, moves
// there, and moves back: the Windows unit is then written inside the machine the
// case owns and cleaned up with it, rather than beside the repository. That is
// also why the four criteria can be asserted for Windows at all - the lifecycle is
// the same code for all three, and proving it on a path this machine can hold is
// what makes "for each platform implementation" an observation.
//
// THE SEAM, AND THE COMMAND ENTRY POINT
// `resolveAutostartControl` is what `install` and `doctor` actually load, so one
// test resolves it and asserts it now finds the real units - which is the state
// IO-2 could only report as "not in this build" - and one test drives `install`,
// `install` again, `doctor` and `uninstall` through `runCli`, the dispatcher the
// package's `bin` names, with the *real* control and a temporary home, asserting
// the change list, the exit codes and the unit's life on disk. That is the only
// assertion here that a broken seam could not survive.
//
// WHAT IS NOT CLAIMED
// Linux is the only platform this repository was built on. Nothing here starts
// systemd, loads a launchd agent, or logs in to Windows: these are assertions
// about the *bytes*, and about the idempotence, ownership and permissions of the
// files, which is the half that can be checked from here. The half that cannot -
// a login that starts the hub, a real service manager accepting the unit - is
// IO-4's live script on Linux and a human gate on macOS and Windows, and the same
// wording is used in the units' own comments, in the operations runbook and in
// README.md.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AUTOSTART_SUPPORTED_PLATFORMS,
  AUTOSTART_UNIT_DIR_MODE,
  AUTOSTART_UNIT_FILE_MODE,
  AUTOSTART_UNIT_SENTINEL,
  createAutostartControl,
  resolveAutostartUnit,
  type AutostartUnit,
} from '@/cli/autostart'
import {
  LINUX_UNIT_NAME,
  LINUX_WANTS_TARGET,
  resolveLinuxUnitDirectory,
  resolveLinuxUnitPath,
} from '@/cli/autostart/linux'
import { MACOS_AGENT_LABEL, resolveLaunchAgentsDirectory, resolveMacosUnitPath } from '@/cli/autostart/macos'
import {
  WINDOWS_ENTRY_NAME,
  resolveWindowsStartupDirectory,
  resolveWindowsUnitPath,
} from '@/cli/autostart/windows'
import {
  AUTOSTART_MODULE_SPECIFIER,
  resolveAutostartControl,
  type AutostartControl,
} from '@/cli/autostart-control'
import { STATE_DIR_ENV_VAR } from '@/storage/paths'
import { cliHarness, type CliHarness } from './fixtures/command-line'
import { readModuleImports, readModuleWithoutProse } from '../helpers/read-module'

type Platform = 'linux' | 'darwin' | 'win32'

/** The three platforms of v1, in the order the matrix runs them (APX-CON-06). */
const PLATFORMS: readonly Platform[] = ['linux', 'darwin', 'win32']

/**
 * Whether the *host* filesystem has POSIX permission bits.
 *
 * About the machine running the suite, not about the platform being simulated. These
 * tests emulate all three platforms on whichever one they run on, and the mode
 * assertions below ask the real filesystem what mode a real file ended up with - so
 * on a Windows host the answer is 0o666 or 0o444 derived from the read-only attribute,
 * and asserting 0o700 there would fail on correct behaviour. The unit *bytes* and
 * *paths* are asserted on every host; only the octal mode is a POSIX fact.
 */
const HAS_POSIX_MODES = process.platform !== 'win32'

/**
 * Tokens that would mean a unit asks for privilege this product never asks for.
 *
 * Checked against the *content* of each unit, not against this file, so a comment
 * here cannot satisfy the check and a comment inside a unit cannot break it.
 * `User=` and `UserName` are in the list because their absence is the "runs as the
 * current user" claim: a systemd user unit and a launchd agent both run as their
 * owner, and naming another user is how either of them would stop doing that.
 */
const ELEVATION_TOKENS: readonly string[] = [
  'sudo',
  'pkexec',
  'doas',
  'User=',
  'UserName',
  'runas',
  '-Verb RunAs',
  'HKLM',
  'RL:HIGHEST',
  'Start-Process',
]

/** Directories that would mean a system-level unit, which needs root to write. */
const SYSTEM_DIRECTORIES: readonly string[] = [
  '/etc/systemd',
  '/usr/lib/systemd',
  '/lib/systemd',
  '/Library/LaunchDaemons',
  'C:\\Windows',
  'C:\\Program Files',
]

const temporaryRoots: string[] = []
const harnesses: CliHarness[] = []
const workingDirectory = process.cwd()

afterEach(async () => {
  for (const created of harnesses.splice(0)) await created.close()
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  // A case that moved the working directory and did not move back would make every
  // later case's temporary path land somewhere else entirely.
  process.chdir(workingDirectory)
})

// ---------------------------------------------------------------------------
// A temporary machine, per platform
// ---------------------------------------------------------------------------

interface Machine {
  readonly platform: Platform
  readonly root: string
  readonly home: string
  readonly stateDir: string
  readonly env: NodeJS.ProcessEnv
  /** A real little package tree, so the unit's header is read out of a real manifest. */
  readonly packageRoot: string
  readonly electronPath: string
  /**
   * The packaged `agent-ping` command, spelled in the *platform's* path rules.
   *
   * The unit's header will spell it exactly this way, so the same string is what
   * an assertion compares against - and on a Linux machine reviewing the Windows
   * unit that string is the one Windows would read, backslashes and all.
   */
  readonly binPath: string
  readonly unitPath: string
  /** The unit's directory, in the platform's own path rules. */
  readonly unitDirectory: string
  /**
   * The directory this machine can list to see what the enable wrote.
   *
   * The unit's own directory for linux and macOS. For the Windows one it is the
   * *working* directory, because a drive-rooted path assembled on a POSIX machine
   * lands as a single file name there - and that is precisely the shape under
   * test, so the listing has to be taken where the file actually is rather than
   * where a POSIX reader would expect it.
   */
  readonly listingDirectory: string
  readonly control: AutostartControl
  readonly paths: path.PlatformPath
}

interface MachineOptions {
  /** Omit `AGENT_PING_STATE_DIR`, so the unit has to resolve the platform default. */
  readonly withoutStateDirOverride?: boolean
  /** Inject a packaged install somewhere else, for a path-shape test. */
  readonly packageRoot?: string
  readonly electronPath?: string
  /** The version the fake manifest declares. */
  readonly version?: string
}

function unitPathFor(platform: Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'linux') return resolveLinuxUnitPath({ env, home })
  if (platform === 'darwin') return resolveMacosUnitPath(home)
  return resolveWindowsUnitPath(env, home)
}

function buildMachine(platform: Platform, root: string, options: MachineOptions): Machine {
  const paths = platform === 'win32' ? path.win32 : path.posix
  // A real user profile in the shape that platform has, so the unit's own path is
  // the shape a developer on that platform would recognise.
  const home = platform === 'win32' ? 'C:\\Users\\agent-ping test' : path.join(root, 'home')
  const stateDir = path.join(root, 'state')
  const packageRoot = options.packageRoot ?? path.join(root, 'package root')
  const binPath = paths.join(packageRoot, 'dist', 'main', 'cli', 'index.js')
  const electronPath =
    options.electronPath ?? paths.join(packageRoot, 'node_modules', 'electron', 'dist', 'electron')

  if (options.packageRoot === undefined) {
    // A real manifest, a real packaged command and a real runtime path, so the
    // unit's header is read out of files rather than out of an expectation. On a
    // POSIX machine the Windows machine's three are single names whose own names
    // carry the backslashes, because that is what the platform's joiner produced -
    // and they are inside this machine's root either way.
    mkdirSync(paths.dirname(binPath), { recursive: true })
    mkdirSync(paths.dirname(electronPath), { recursive: true })
    writeFileSync(binPath, '// the packaged agent-ping command\n')
    writeFileSync(electronPath, '#!/bin/sh\n')
    writeFileSync(
      paths.join(packageRoot, 'package.json'),
      `${JSON.stringify(
        {
          name: 'agent-ping',
          version: options.version ?? '9.9.9',
          bin: { 'agent-ping': 'dist/main/cli/index.js' },
        },
        null,
        2,
      )}\n`,
    )
  }

  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    HOME: home,
    XDG_CONFIG_HOME: paths.join(home, '.config'),
    APPDATA: paths.join(home, 'AppData', 'Roaming'),
    ...(options.withoutStateDirOverride === true ? {} : { [STATE_DIR_ENV_VAR]: stateDir }),
  }
  const unitPath = unitPathFor(platform, env, home)
  return {
    platform,
    root,
    home,
    stateDir,
    env,
    packageRoot,
    electronPath,
    binPath,
    unitPath,
    unitDirectory: paths.dirname(unitPath),
    listingDirectory: path.posix.dirname(path.resolve(unitPath)),
    control: createAutostartControl({ env, platform, home, stateDir, electronPath, packageRoot }),
    paths,
  }
}

/**
 * Build a machine and run a case inside it, with the working directory moved.
 *
 * The working directory is the containment: a Windows unit path is drive-rooted
 * on a POSIX machine and this kernel resolves that against the working directory,
 * so a case that did not move would write the Windows unit beside the repository.
 * Every assertion about "nothing was left behind" is therefore also an assertion
 * that nothing escaped the machine.
 */
async function withMachine(
  platform: Platform,
  body: (m: Machine) => Promise<void>,
  options: MachineOptions = {},
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-ping-autostart-'))
  temporaryRoots.push(root)
  const previous = process.cwd()
  process.chdir(root)
  try {
    await body(buildMachine(platform, root, options))
  } finally {
    process.chdir(previous)
  }
}

/** The unit this machine would get, resolved rather than written. */
function unitFor(m: Machine): AutostartUnit {
  const resolved = resolveAutostartUnit({
    env: m.env,
    platform: m.platform,
    home: m.home,
    stateDir: m.stateDir,
    electronPath: m.electronPath,
    packageRoot: m.packageRoot,
  })
  if (!('unit' in resolved)) throw new Error(resolved.reason)
  return resolved.unit
}

/** The unit's bytes, as the last enable left them. */
const unitText = (m: Machine): string => readFileSync(m.unitPath, 'utf8')

/** Every path under a directory, relative and sorted, for an emptiness assertion. */
function walk(root: string): readonly string[] {
  const found: string[] = []
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) visit(path.join(directory, entry.name), relative)
      else found.push(relative)
    }
  }
  if (!existsSync(root)) return found
  visit(root, '')
  return found
}

/**
 * The four permission bits of a path, or null when the filesystem has none.
 *
 * Null on a host without POSIX permission bits rather than a number that would fail a
 * mode assertion: a Windows host reports 0o666 or 0o444 derived from the read-only
 * attribute, and answering with that would make a correct product look broken.
 */
function modeOf(target: string): number | null {
  if (!HAS_POSIX_MODES) return null
  try {
    return statSync(target).mode & 0o777
  } catch {
    return null
  }
}

/** A mode assertion that passes on a filesystem with no POSIX bits, by asserting nothing. */
function expectMode(target: string, expected: number): void {
  if (!HAS_POSIX_MODES) return
  expect(modeOf(target), `${target} is not ${expected.toString(8).padStart(4, '0')}`).toBe(expected)
}

/** A file with fixed bytes and a deliberately old timestamp, for "was it touched". */
function writeStaleFile(target: string, content: string): void {
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
  const old = new Date(1_000_000)
  utimesSync(target, old, old)
}

const snapshot = (target: string): { readonly bytes: string; readonly mtimeMs: number } => ({
  bytes: readFileSync(target, 'utf8'),
  mtimeMs: statSync(target).mtimeMs,
})

function readFileSafe(target: string): string {
  try {
    return readFileSync(target, 'utf8')
  } catch {
    return ''
  }
}

/**
 * The entries beside the unit that are this product's own units.
 *
 * By name *or* by content, because the two halves are different faults: a file
 * named like ours that we did not write is a stranger squatting on our path, and a
 * file of ours under another name is a unit a previous version of this product
 * wrote and this one should clean up. Directories are excluded because
 * `default.target.wants` holds the login link rather than being one.
 */
function entriesCarrying(m: Machine, needle: string): readonly string[] {
  if (!existsSync(m.listingDirectory)) return []
  return readdirSync(m.listingDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        name.includes(needle) ||
        readFileSafe(path.posix.join(m.listingDirectory, name)).includes(needle),
    )
    .sort()
}

/** Every name this machine can see in the directory the enable wrote into. */
function listingOf(m: Machine): readonly string[] {
  if (!existsSync(m.listingDirectory)) return []
  return readdirSync(m.listingDirectory).sort()
}

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---------------------------------------------------------------------------
// Criterion 1: enable twice is one unit, disable twice is a no-op
// ---------------------------------------------------------------------------

describe('enabling twice leaves one unit and changes nothing, and disabling twice is a safe no-op, on every platform', () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: one unit, byte- and timestamp-identical, and a second disable that removes nothing`, async () => {
      await withMachine(platform, async (m) => {
        expect(m.control.implementation).toBe('autostart-units')

        const first = await m.control.enable()
        expect(first.changed, first.detail).toBe(true)
        expect(first.failure).toBeNull()
        expect(first.unitPath).toBe(m.unitPath)
        expect((await m.control.state()).availability).toBe('enabled')

        const before = snapshot(m.unitPath)
        const second = await m.control.enable()
        expect(second.changed, second.detail).toBe(false)
        expect(second.failure).toBeNull()
        // Not one byte, and not one timestamp: the whole claim of a repeat enable.
        expect(snapshot(m.unitPath)).toEqual(before)
        expect((await m.control.state()).availability).toBe('enabled')

        // Exactly one artefact that is ours, anywhere in the unit directory - which
        // for Linux means the unit *and* its login link, and for the other two means
        // the single file their convention is.
        expect(
          entriesCarrying(m, AUTOSTART_UNIT_SENTINEL),
          `${m.unitPath} is not the only unit`,
        ).toEqual([path.posix.basename(m.unitPath)])

        const disabled = await m.control.disable()
        expect(disabled.changed, disabled.detail).toBe(true)
        expect(disabled.failure).toBeNull()
        expect((await m.control.state()).availability).toBe('disabled')

        const again = await m.control.disable()
        expect(again.changed, again.detail).toBe(false)
        expect(again.failure, 'disabling what is already disabled is not a failure').toBeNull()
        expect(existsSync(m.unitPath)).toBe(false)
        expect((await m.control.state()).availability).toBe('disabled')
      })
    })
  }

  it('a unit this product wrote earlier, with stale bytes, is rewritten rather than refused', async () => {
    // The other side of the foreign-file rule, and the one that is easy to get
    // backwards: a file carrying the sentinel *is* ours, so a version bump has to
    // replace it instead of refusing to install over its own older unit.
    await withMachine('linux', async (m) => {
      writeStaleFile(m.unitPath, `# ${AUTOSTART_UNIT_SENTINEL}\n[Service]\nExecStart=/bin/true\n`)
      const wants = m.paths.join(m.unitDirectory, `${LINUX_WANTS_TARGET}.wants`, LINUX_UNIT_NAME)
      mkdirSync(path.dirname(wants), { recursive: true })
      // A link, as an older install would have left it. A *regular file* at the
      // wants path is somebody else's, and refusing it is the correct answer.
      symlinkSync(`..${path.sep}${LINUX_UNIT_NAME}`, wants)

      const change = await m.control.enable()

      expect(change.changed, change.detail).toBe(true)
      expect(change.failure).toBeNull()
      expect(unitText(m)).toContain('9.9.9')
      expect(unitText(m)).not.toContain('/bin/true')
    })
  })

  it('a unit file with no login link reads as disabled, and names what is missing', async () => {
    // A half-written enablement is the fault `state()` exists to name: a green
    // "autostart ok" over a unit no login would ever start is the failure mode.
    await withMachine('linux', async (m) => {
      await m.control.enable()
      rmSync(m.paths.join(m.unitDirectory, `${LINUX_WANTS_TARGET}.wants`, LINUX_UNIT_NAME))

      const state = await m.control.state()

      expect(state.availability).toBe('disabled')
      expect(state.unitPath).toBe(m.unitPath)
      expect(state.detail).toContain(`${LINUX_WANTS_TARGET}.wants`)
      expect(state.detail).toContain('would not start agent-ping')
    })
  })
})

// ---------------------------------------------------------------------------
// Criterion 2: disable leaves no agent-ping entry behind
// ---------------------------------------------------------------------------

describe('disabling leaves no agent-ping entry anywhere under the temporary home', () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: the unit, its login link and any directory this product created are all gone`, async () => {
      await withMachine(platform, async (m) => {
        // The machine as the case found it, because on a POSIX machine the Windows
        // unit and the fake package this suite built are both single file names in
        // the working directory - and what has to be proved is that the enable left
        // nothing *new* behind, not that the case started with an empty directory.
        const baseline = listingOf(m)
        await m.control.enable()
        expect(listingOf(m), 'the enable wrote nothing to look for').not.toEqual(baseline)

        const change = await m.control.disable()
        expect(change.changed, change.detail).toBe(true)

        // The directory the enable wrote into is as it was: the unit, the login
        // link and every file this product put there are gone. Not "the file we
        // expected is gone" - a symlink left in `default.target.wants` fails here.
        const left = listingOf(m)
        expect(left, `${left.join(', ')} survived a disable`).toEqual(baseline)
        // The directories the enable had to create are gone too, not just the
        // files: an empty `systemd/user` or an empty LaunchAgents is residue, and
        // the criterion is about the install, not about one path.
        expect(existsSync(m.unitDirectory), `${m.unitDirectory} survived a disable`).toBe(false)
        // Including the *convention root above* it, which is the half that is easy
        // to leave: on Linux the enable has to create `~/.config/systemd` as well as
        // `~/.config/systemd/user`, and an empty `systemd` directory after an
        // uninstall is exactly the residue this criterion is about.
        for (const owned of unitFor(m).ownedDirectories) {
          expect(existsSync(owned), `${owned} survived a disable`).toBe(false)
        }
        // And on the two platforms whose path rules this machine shares, nothing
        // anywhere under the home is still called after this product. The Windows
        // unit is a single file name in the working directory by construction, so
        // the emptiness claim above is the whole of what can be observed there.
        if (platform !== 'win32') {
          const named = walk(m.home).filter((entry) => path.posix.basename(entry).includes('agent-ping'))
          expect(named, `${named.join(', ')} survived a disable`).toEqual([])
        }
      })
    })
  }

  it('a directory still holding an unrelated unit is kept, because the unit is not the only one', async () => {
    // The same `rmdir` that removes an emptied directory has to fail on a
    // directory that still holds somebody else's unit - otherwise "remove every
    // trace" becomes "remove the user's systemd units".
    await withMachine('linux', async (m) => {
      const foreign = m.paths.join(m.unitDirectory, 'somebody-elses.service')
      writeStaleFile(foreign, '[Service]\nExecStart=/bin/true\n')
      await m.control.enable()

      const change = await m.control.disable()

      expect(change.changed, change.detail).toBe(true)
      expect(readFileSync(foreign, 'utf8')).toBe('[Service]\nExecStart=/bin/true\n')
      expect(existsSync(m.unitDirectory)).toBe(true)
    })
  })

  it('the prune stops at the platform convention root and never reaches the home', async () => {
    // The other side of the residue fix. Removing our own directories must not walk
    // up into directories this product did not create: `~/.config` is shared with
    // every other tool on the account, and a disable that emptied it would be a
    // data-loss bug wearing a cleanup's clothes. So the platform *declares* the
    // directories it owns rather than the engine walking up until rmdir fails.
    await withMachine('linux', async (m) => {
      const unit = unitFor(m)
      const conventionRoot = m.paths.join(m.home, '.config', 'systemd')
      expect(unit.ownedDirectories).toEqual([conventionRoot, m.unitDirectory])
      // Nothing above the convention root is claimed, so nothing above it is removed.
      for (const owned of unit.ownedDirectories) {
        expect(owned.startsWith(conventionRoot)).toBe(true)
      }

      await m.control.enable()
      await m.control.disable()

      expect(existsSync(conventionRoot), `${conventionRoot} survived a disable`).toBe(false)
      expect(existsSync(m.paths.join(m.home, '.config')), 'the disable removed ~/.config').toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// Criterion 3: names the packaged binary, runs as the user, asks for no privilege
// ---------------------------------------------------------------------------

describe("every generated unit names this install's packaged binary and asks for no elevation", () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: the packaged command, the packaged runtime and no root, on disk`, async () => {
      await withMachine(platform, async (m) => {
        await m.control.enable()
        const text = unitText(m)

        // POSITIVE: it names what this install shipped, as absolute paths. A unit
        // naming a bare `electron` would start whichever build came first on the
        // login PATH, which is the failure this product cannot detect afterwards.
        expect(text, 'the packaged agent-ping command').toContain(m.binPath)
        expect(text, 'the packaged Electron runtime').toContain(m.electronPath)
        expect(text, 'the package root the runtime loads').toContain(m.packageRoot)
        expect(text, 'the version from the packaged manifest').toContain('9.9.9')
        // The launch policy travels with the unit, in both forms Chromium honours,
        // because it decides about the sandbox before any JavaScript here runs. The
        // switch is one form in all three; the environment variable is written as a
        // `NAME=value` pair by the two line-oriented formats and as a plist key and
        // value by the third, which is the same decision in the only syntax launchd
        // reads.
        expect(text, 'the launch policy switch').toContain('--no-sandbox')
        expect(text, 'the launch policy environment').toContain('ELECTRON_DISABLE_SANDBOX')
        if (platform === 'darwin') {
          expect(text).toMatch(/<key>ELECTRON_DISABLE_SANDBOX<\/key>\s*<string>1<\/string>/)
        } else {
          expect(text).toContain('ELECTRON_DISABLE_SANDBOX=1')
        }

        // NEGATIVE: nothing here asks to be more than the user who installed it.
        for (const token of ELEVATION_TOKENS) {
          expect(text.includes(token), `${platform} unit contains ${token}`).toBe(false)
        }
        for (const directory of SYSTEM_DIRECTORIES) {
          expect(text.includes(directory), `${platform} unit names ${directory}`).toBe(false)
        }
        // And the unit is per-user by location, which is the positive form of the
        // same claim: it is inside this user's own profile, not a system directory.
        expect(m.unitPath.startsWith(m.home), `${m.unitPath} is not inside ${m.home}`).toBe(true)
      })
    })
  }

  it('the unit is a *user* unit in the user manager\'s own directory on linux', async () => {
    // The structural form of "runs as the current user" on systemd: a unit under
    // `systemd/user` is loaded by the user's own manager, and a system unit
    // directory would be a different product with a different lifecycle.
    await withMachine('linux', async (m) => {
      const unit = unitFor(m)
      expect(unit.unitPath).toContain(path.join('systemd', 'user'))
      expect(unit.links.map((link) => link.path)).toEqual([
        path.join(m.unitDirectory, `${LINUX_WANTS_TARGET}.wants`, LINUX_UNIT_NAME),
      ])

      await m.control.enable()
      // The login link is what makes the unit enabled, and it is written relative
      // the way `systemctl enable` writes it, so a restored home directory works.
      expect(readlinkSync(unit.links[0]?.path ?? '')).toBe(`..${path.sep}${LINUX_UNIT_NAME}`)
      // And it is a symlink, not a second copy of the unit: two files with the
      // same content is exactly the duplicate IO-FR-06 forbids.
      expect(isSymlink(unit.links[0]?.path ?? ''), 'the login link is a symlink, not a second copy').toBe(true)
    })
  })

  it('the launchd agent is a user agent with no UserName and no unbounded log', async () => {
    await withMachine('darwin', async (m) => {
      const unit = unitFor(m)
      expect(unit.unitPath).toBe(
        path.join(resolveLaunchAgentsDirectory(m.home), `${MACOS_AGENT_LABEL}.plist`),
      )
      expect(unit.links, 'launchd loads the directory, so there is no second artefact').toEqual([])
      // A plist that could not parse is a job launchd silently never loads, so the
      // comment that carries the sentinel is a constant and every path is a value -
      // and `--` is not legal inside an XML comment at all.
      const comment = /<!--([\s\S]*?)-->/.exec(unit.content)?.[1] ?? ''
      expect(comment, 'the sentinel is in a comment').toContain(AUTOSTART_UNIT_SENTINEL)
      expect(comment, '`--` is not legal inside an XML comment').not.toContain('--')
      expect(unit.content).toContain('<key>RunAtLoad</key>')
      expect(unit.content).toContain('<key>LimitLoadToSessionType</key>')
      expect(unit.content).toContain('<key>KeepAlive</key>')
      // `StandardOutPath` would be a second, unbounded log beside the bounded one.
      expect(unit.content).not.toContain('StandardOutPath')
      expect(unit.content).not.toContain('StandardErrorPath')
    })
  })

  it('the Windows entry is a per-user Startup-folder file with no elevation and no registry', async () => {
    await withMachine('win32', async (m) => {
      const unit = unitFor(m)
      expect(unit.unitPath).toBe(resolveWindowsUnitPath(m.env, m.home))
      expect(unit.unitPath).toContain('Microsoft\\Windows\\Start Menu\\Programs\\Startup')
      expect(unit.unitPath.endsWith(`\\${WINDOWS_ENTRY_NAME}`)).toBe(true)
      expect(unit.links, 'Explorer runs the folder, so there is no second artefact').toEqual([])
      expect(unit.content).toContain('@echo off')
      // `start ""` - the first quoted argument is the window title, so the empty
      // one is required once the executable is quoted.
      expect(unit.content).toContain('start "" /b ')
      for (const token of ['reg ', 'reg.exe', 'schtasks', 'HKCU', 'HKLM']) {
        expect(unit.content.includes(token), `the entry contains ${token}`).toBe(false)
      }
    })
  })
})

function isSymlink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Criterion 4: a foreign unit is left alone
// ---------------------------------------------------------------------------

describe('a pre-existing unrelated unit in the same location is left untouched', () => {
  const foreignNames: Readonly<Record<Platform, string>> = {
    linux: 'somebody-elses.service',
    darwin: 'com.example.other.plist',
    win32: 'other-program.cmd',
  }

  for (const platform of PLATFORMS) {
    it(`${platform}: a foreign unit beside ours is neither read, rewritten nor removed`, async () => {
      await withMachine(platform, async (m) => {
        const foreign = m.paths.join(m.unitDirectory, foreignNames[platform])
        writeStaleFile(foreign, '# not agent-ping\n[Service]\nExecStart=/bin/true\n')
        const before = snapshot(foreign)

        await m.control.enable()
        const during = snapshot(foreign)
        await m.control.disable()

        expect(during, 'enable touched a file it did not write').toEqual(before)
        expect(snapshot(foreign), 'disable removed a file it did not write').toEqual(before)
      })
    })
  }

  for (const platform of PLATFORMS) {
    it(`${platform}: a foreign file at our own path is refused, not overwritten, and not removed`, async () => {
      // The data-loss case. Enabling over somebody else's file would destroy it;
      // refusing must therefore be a *reported* failure with a remedy, because a
      // silent refusal leaves a developer with an install that reports success and
      // does not start at login.
      await withMachine(platform, async (m) => {
        writeStaleFile(m.unitPath, '# somebody else wrote this\n')
        const before = snapshot(m.unitPath)

        const enable = await m.control.enable()
        expect(enable.changed, enable.detail).toBe(false)
        expect(enable.failure, 'a blocked enable has to say what to do').toContain(
          `move ${m.unitPath} aside`,
        )
        expect(enable.failure).toContain('agent-ping install')
        expect(snapshot(m.unitPath), 'a blocked enable wrote the file anyway').toEqual(before)

        const disable = await m.control.disable()
        expect(disable.changed, disable.detail).toBe(false)
        expect(snapshot(m.unitPath), 'disable removed a file it did not write').toEqual(before)
        // And the port's own answer to the same question: not enabled, and it says
        // why, so `doctor` cannot report this as an ordinary "run install".
        expect((await m.control.state()).detail).toContain('not a file agent-ping wrote')
      })
    })
  }

  it('a foreign file at the login link is refused too, before anything is written', async () => {
    // Checked *before* the unit file is written, so a blocked enable has not
    // already replaced half of what it owns by the time it gives up.
    await withMachine('linux', async (m) => {
      const wants = m.paths.join(m.unitDirectory, `${LINUX_WANTS_TARGET}.wants`, LINUX_UNIT_NAME)
      writeStaleFile(wants, 'not a link at all\n')

      const enable = await m.control.enable()

      expect(enable.changed, enable.detail).toBe(false)
      expect(enable.failure).toContain(`move ${wants} aside`)
      expect(existsSync(m.unitPath), 'the unit file was written before the refusal').toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// IO-FR-07: where the unit goes, and owner-only
// ---------------------------------------------------------------------------

describe('the unit location is the platform convention, and everything written is owner-only', () => {
  it("linux follows systemd's documented user search path, XDG_CONFIG_HOME included", () => {
    const home = '/home/tester'
    expect(resolveLinuxUnitDirectory({}, home)).toBe(path.join(home, '.config', 'systemd', 'user'))

    // A machine with a non-default XDG_CONFIG_HOME gets its unit where systemd
    // looks, which is the whole reason the path is resolved rather than written.
    expect(resolveLinuxUnitDirectory({ XDG_CONFIG_HOME: '/var/tmp/somewhere-else' }, home)).toBe(
      path.join('/var/tmp/somewhere-else', 'systemd', 'user'),
    )

    // And a shell-quoted `~/...` is expanded against this home, not left literal.
    expect(resolveLinuxUnitDirectory({ XDG_CONFIG_HOME: '~/cfg' }, home)).toBe(
      path.join('/home/tester', 'cfg', 'systemd', 'user'),
    )
  })

  it('macOS has no environment override and always uses ~/Library/LaunchAgents', () => {
    expect(resolveLaunchAgentsDirectory('/Users/tester')).toBe(
      path.join('/Users/tester', 'Library', 'LaunchAgents'),
    )
    expect(resolveMacosUnitPath('/Users/tester')).toBe(
      path.join('/Users/tester', 'Library', 'LaunchAgents', `${MACOS_AGENT_LABEL}.plist`),
    )
  })

  it('windows follows %APPDATA% and falls back to the roaming profile', async () => {
    await withMachine('win32', async (m) => {
      expect(resolveWindowsStartupDirectory(m.env, m.home)).toBe(
        m.paths.join(m.home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
      )
      // A machine whose roaming profile is not where %APPDATA% says, which is what
      // a service account and a portable install both look like.
      expect(resolveWindowsStartupDirectory({}, 'C:\\Users\\tester')).toContain(
        'C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
      )
    })
  })

  for (const platform of PLATFORMS) {
    it(`${platform}: the unit is 0o600 and every directory this product created is 0o700`, async () => {
      await withMachine(platform, async (m) => {
        await m.control.enable()

        // The literal, not the constant the module exports: a test that compares the
        // file's mode against the same constant the writer used is satisfied by any
        // mode at all, which is how "owner-only" becomes an unasserted adjective.
        expectMode(m.unitPath, 0o600)
        for (const directory of createdDirectories(m)) {
          expectMode(directory, 0o700)
        }
      })
    })
  }

  it('a directory that already existed keeps its mode, because it is not ours', async () => {
    // `~/.config/systemd/user` is a directory the platform and other tools share.
    // Tightening it would be this product changing something it did not create.
    // POSIX-only: on a host without permission bits nothing is ever widened, so there
    // is no "kept its mode" to observe. The unit file is still asserted.
    await withMachine('linux', async (m) => {
      mkdirSync(m.unitDirectory, { recursive: true, mode: 0o755 })
      await m.control.enable()

      if (HAS_POSIX_MODES) expect(modeOf(m.unitDirectory)).toBe(0o755)
      expectMode(m.unitPath, 0o600)
    })
  })

  it('the modes this product promises are the ones it declares', () => {
    // IO-FR-07 says owner-only, which is 0600 for a file and 0700 for a directory.
    // Asserted here as literals so that a future "let us make the unit readable so
    // the service manager can find it" edit has to change this line to pass.
    expect(AUTOSTART_UNIT_FILE_MODE).toBe(0o600)
    expect(AUTOSTART_UNIT_DIR_MODE).toBe(0o700)
  })

  it('a wider umask cannot widen the unit, because the mode is set after the write', async () => {
    // `writeFileSync`'s mode is filtered through the umask, so the chmod is what
    // makes "every path the product writes is owner-only" true rather than "unless
    // the operator's umask is unusual".
    //
    // POSIX-only in its premise: a umask is a POSIX concept, and on a Windows host
    // `process.umask` has no effect and there is no mode to widen. That the enable
    // succeeds is asserted on every host by the tests above.
    await withMachine('linux', async (m) => {
      const previous = process.umask(0o000)
      try {
        await m.control.enable()
      } finally {
        process.umask(previous)
      }
      expectMode(m.unitPath, 0o600)
    })
  })
})

/** The directories this product created on the way to the unit, innermost first. */
function createdDirectories(m: Machine): readonly string[] {
  const found: string[] = []
  let current = m.unitDirectory
  for (let depth = 0; depth < 8; depth += 1) {
    if (!existsSync(current)) break
    found.push(current)
    const parent = m.paths.dirname(current)
    if (parent === current) break
    current = parent
  }
  return found.filter((directory) => directory.includes(m.root))
}

// ---------------------------------------------------------------------------
// The state directory override, and the escaping a path has to survive
// ---------------------------------------------------------------------------

describe('an overridden state directory travels in the unit, and the default does not', () => {
  it('the override is written into the unit, because a login hub must find the same state', async () => {
    await withMachine('linux', async (m) => {
      await m.control.enable()
      expect(unitText(m)).toContain(`AGENT_PING_STATE_DIR=${m.stateDir}`)
    })
  })

  it('with no override the unit says nothing, and the platform default still resolves', async () => {
    // Baking a default absolute path into the unit would be a second thing to keep
    // correct, and would be wrong the moment the user moved their XDG state home.
    await withMachine(
      'linux',
      async (m) => {
        await m.control.enable()
        expect(unitText(m)).not.toContain('AGENT_PING_STATE_DIR')
      },
      { withoutStateDirOverride: true },
    )
  })
})

describe('a path with a space and a percent sign still produces a usable unit', () => {
  it('systemd quotes the command and doubles a percent sign, which it expands', async () => {
    await withMachine(
      'linux',
      async (m) => {
        const unit = unitFor(m)
        // Unquoted, systemd would split `/opt/agent` and `ping/pkg%20here` into
        // three arguments and the unit would fail for a reason with nothing to do
        // with agent-ping. `%` opens a systemd specifier, so a literal one is `%%`.
        expect(unit.content).toContain('ExecStart="')
        expect(unit.content).toContain('"/opt/agent ping/pkg%%20here"')
        expect(unit.content).toContain('"electron"')
      },
      { packageRoot: '/opt/agent ping/pkg%20here', electronPath: 'electron' },
    )
  })

  it('the Windows entry quotes its arguments and doubles a percent sign, which cmd expands', async () => {
    await withMachine(
      'win32',
      async (m) => {
        const unit = unitFor(m)
        expect(unit.content).toContain(
          'start "" /b "C:\\Users\\test\\agent ping%%20pkg\\node_modules\\electron\\dist\\electron.exe" ' +
            '"C:\\Users\\test\\agent ping%%20pkg" --no-sandbox',
        )
      },
      {
        packageRoot: 'C:\\Users\\test\\agent ping%20pkg',
        electronPath: 'C:\\Users\\test\\agent ping%20pkg\\node_modules\\electron\\dist\\electron.exe',
      },
    )
  })

  it('the launchd plist escapes the XML metacharacters a Unix path may legally contain', async () => {
    await withMachine(
      'darwin',
      async (m) => {
        const unit = unitFor(m)
        expect(unit.content).toContain('/Users/a&amp;b/agent&lt;ping&gt;')
        // Every `&` in a plist is an escape, so the counts have to agree: a raw one
        // ends the value early, and a plist that does not parse is a job launchd
        // silently never loads.
        const ampersands = (unit.content.match(/&/g) ?? []).length
        expect(ampersands).toBeGreaterThan(0)
        expect(ampersands).toBe((unit.content.match(/&amp;|&lt;|&gt;/g) ?? []).length)
      },
      { packageRoot: '/Users/a&b/agent<ping>', electronPath: '/Users/a&b/agent<ping>/electron' },
    )
  })
})

// ---------------------------------------------------------------------------
// No live service manager, and the platform refusal
// ---------------------------------------------------------------------------

describe('no live system service is manipulated, and a platform with no unit is refused', () => {
  const MODULES = [
    'src/cli/autostart/index.ts',
    'src/cli/autostart/linux.ts',
    'src/cli/autostart/macos.ts',
    'src/cli/autostart/windows.ts',
  ]

  it('the units are written as files: no process is spawned and no service manager is named', () => {
    // A structural assertion rather than a promise, because a `systemctl` in one of
    // these modules would be invisible to every behavioural test in this file - and
    // this task is explicitly not allowed to touch a live service manager. Read
    // with comments and strings kept: a *string* naming a service manager is the
    // thing being banned, and a comment mentioning one is documentation.
    for (const module of MODULES) {
      const code = readModuleWithoutProse(module)
      for (const call of ['spawn(', 'spawnSync(', 'execSync(', 'exec(', 'execFile(']) {
        expect(code.includes(call), `${module} calls ${call}`).toBe(false)
      }
      const literals = readModuleImports(module)
      for (const tool of ['systemctl', 'launchctl', 'schtasks', 'osascript', 'child_process']) {
        expect(literals.includes(tool), `${module} names ${tool} in code`).toBe(false)
      }
    }
  })

  it('a platform with no unit in v1 is a stated refusal, not a throw', async () => {
    const control = createAutostartControl({
      env: {},
      platform: 'freebsd',
      home: '/tmp',
      stateDir: '/tmp/state',
    })
    expect(control.implementation).toBe('unsupported-platform')

    const state = await control.state()
    expect(state.availability).toBe('unavailable')
    expect(state.unitPath).toBeNull()
    expect(state.detail).toContain('no autostart unit for freebsd')

    const enable = await control.enable()
    expect(enable.changed).toBe(false)
    expect(enable.failure).toContain('no autostart unit for freebsd')
    const disable = await control.disable()
    expect(disable.changed).toBe(false)
    expect(disable.failure).toBeNull()
  })

  it('the three platforms of v1 are the three with a unit', () => {
    expect(AUTOSTART_SUPPORTED_PLATFORMS).toEqual([...PLATFORMS].sort())
  })

  it('the packaging guard requires the emitted units, at the path this resolver asks for', async () => {
    // The resolver loads `./autostart/index.js` through a `string`-typed import,
    // precisely so that the module's absence is a runtime fact rather than a compile
    // error - which also means no type checker follows it and no `files` review
    // reads it. The guard is what closes that gap, so the path it requires has to be
    // derived from the specifier rather than restated: a module that moved would
    // otherwise leave the guard protecting a path nothing loads any more.
    // @ts-expect-error the guard under test is plain JavaScript with no declaration
    // file; the exports this suite exercises are its contract.
    const guard = await import('../../scripts/prepack-check.mjs')
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      files: string[]
    }

    expect(guard.AUTOSTART_ENTRY).toBe(path.posix.join('dist/main/cli', AUTOSTART_MODULE_SPECIFIER))
    expect(guard.requiredShippedPaths(repoRoot)).toContain(guard.AUTOSTART_ENTRY)
    expect(guard.matchesFilesAllowlist(guard.AUTOSTART_ENTRY, manifest.files)).toBe(true)
    // And the module this suite is testing really is that one, on disk.
    expect(existsSync(path.join(repoRoot, 'src', 'cli', 'autostart', 'index.ts'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The seam, and the command entry point
// ---------------------------------------------------------------------------

describe("the resolver `install` and `doctor` load now finds the real units", () => {
  it('resolveAutostartControl answers autostart-units, which is what IO-2 could not', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-ping-resolve-'))
    temporaryRoots.push(root)
    const home = path.join(root, 'home')
    const stateDir = path.join(root, 'state')

    const control = await resolveAutostartControl({
      env: { XDG_CONFIG_HOME: path.join(home, '.config') },
      platform: 'linux',
      home,
      stateDir,
    })

    // This is the whole of IO-2's recorded gap: the module it looks for exists now,
    // and it must be *this* module, in the same package, not a stand-in.
    expect(control.implementation).toBe('autostart-units')
    expect(AUTOSTART_MODULE_SPECIFIER).toBe('./autostart/index.js')
    const state = await control.state()
    expect(state.availability).toBe('disabled')
    expect(state.unitPath).toBe(path.join(home, '.config', 'systemd', 'user', LINUX_UNIT_NAME))
  })
})

describe('install and uninstall, through the command entry point, with the real units', () => {
  it('writes the unit, reports no changes the second time, passes the doctor check and removes the unit', async () => {
    const cli = await cliHarness()
    harnesses.push(cli)
    const unitPath = path.join(cli.home, '.config', 'systemd', 'user', LINUX_UNIT_NAME)
    // No `autostart` override, so the dispatcher resolves the real control itself -
    // which is the seam, exercised rather than assumed.
    const realAutostart = { autostart: undefined }

    const installed = await cli.run(['install'], realAutostart)
    const installText = cli.lastText()

    expect(installed, installText).toBe(0)
    expect(installText).toMatch(new RegExp(`^\\s+autostart\\s+enabled ${escapeForRegExp(unitPath)}$`, 'm'))
    expect(existsSync(unitPath), 'install did not write the unit').toBe(true)
    expect(readFileSync(unitPath, 'utf8')).toContain(AUTOSTART_UNIT_SENTINEL)
    // The real install resolves this machine's real packaged paths, so the unit a
    // developer would actually get is the one that was written.
    expect(readFileSync(unitPath, 'utf8')).toContain('node_modules/electron')

    const again = await cli.run(['install'], realAutostart)
    expect(again, cli.lastText()).toBe(0)
    expect(cli.lastText()).toContain('agent-ping install: nothing was changed.')

    const diagnosed = await cli.run(['doctor'], realAutostart)
    const doctorText = cli.lastText()
    // Exit 1, and deliberately so: the harness runs the hub as a plain Node process
    // with no desktop bridge, so the two desktop checks are the failures and the
    // autostart check is not among them. Asserting 0 here would be asserting
    // something about the test machine rather than about this unit.
    expect(diagnosed, doctorText).toBe(1)
    expect(doctorText).toMatch(/^\s+autostart\s+ok\s+enabled \(.*agent-ping\.service\)$/m)
    expect(doctorText).toMatch(/^\s+2 of 7 checks failed\.$/m)

    const removed = await cli.run(['uninstall'], realAutostart)
    expect(removed, cli.lastText()).toBe(0)
    expect(cli.lastText()).toMatch(
      new RegExp(`^\\s+autostart\\s+removed ${escapeForRegExp(unitPath)}$`, 'm'),
    )
    expect(existsSync(unitPath), 'uninstall left the unit behind').toBe(false)
  }, 180_000)
})
